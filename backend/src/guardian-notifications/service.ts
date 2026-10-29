import {randomUUID,createHmac} from 'node:crypto';
import type {RagDatabase} from '../rag/repository.js';
import type {PatientDatabase,PatientConnection} from '../patients/repository.js';
import {transaction,secretHash} from '../auth/security-repository.js';
import {EmailDeliveryFailure,type SecurityEmailProvider,type ProviderMessage} from '../auth/security-email.js';
import {createSummaryJobRepository,type SummarySnapshot} from '../summaries/jobs.js';
import {guardianNotificationConfig,notificationDigest,policyDigest,type GuardianNotificationConfig} from './config.js';
import {demoRule,validateDemoRule,ruleDigest,evaluateDemoRule,type SeriousRule} from './rules.js';
import {ApiError} from '../http/errors.js';
export interface SyntheticGuardianProvider extends SecurityEmailProvider {mode:'synthetic-offline';}
export const guardianDenied=()=>new ApiError(403,'GUARDIAN_REPORT_DENIED','Guardian report authorization is invalid or expired.');
const recipientHash=(s:string)=>notificationDigest('guardian_recipient:'+s);
const syntheticEmail=(s:unknown)=>typeof s==='string'&&/^[^\s@]+@[^\s@]+\.invalid$/.test(s);
async function event(c:PatientDatabase,patient:string,type:string,job?:string){await c.query('INSERT INTO guardian_medical_events(patient_id,job_id,event) VALUES($1,$2,$3)',[patient,job??null,type]);}
async function lockPatient(c:PatientDatabase,patient:string){await c.query('SELECT id FROM patients WHERE id=$1 FOR UPDATE',[patient]);}
async function currentRecipient(c:PatientDatabase,patient:string){return (await c.query(`SELECT p.security_version,p.email patient_email,g.id,g.email,g.accepted_at FROM patients p
 JOIN guardian_notification_enrollments e ON e.patient_id=p.id AND e.synthetic_fixture
 JOIN guardian_relationships g ON g.patient_id=p.id AND g.status='ACTIVE' AND g.accepted_at IS NOT NULL
 WHERE p.id=$1 AND p.account_status='active' AND p.email_verified_at IS NOT NULL`,[patient])).rows[0];}
export function createGuardianNotificationService(db:RagDatabase,settings:GuardianNotificationConfig,provider:SyntheticGuardianProvider,rules:readonly SeriousRule[]=[demoRule],hooks:{beforeHandoff?:(job:string)=>Promise<void>}={}){
 // Validate injected policies too; arbitrary callers cannot activate a real provider or clinical rule.
 const validated=guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:settings.mode,GUARDIAN_NOTIFICATIONS_ORIGIN:settings.origin,GUARDIAN_DIGEST_SECONDS:String(settings.windowSeconds),GUARDIAN_REPORT_REFERENCE_SECONDS:String(settings.referenceSeconds),GUARDIAN_RETRY_SECONDS:String(settings.retrySeconds),GUARDIAN_MAX_ATTEMPTS:String(settings.maxAttempts),GUARDIAN_SEND_TIMEOUT_MS:String(settings.timeoutMs),GUARDIAN_INDETERMINATE_POLICY:settings.indeterminate},settings.referenceKey);
 if(!validated||provider.mode!=='synthetic-offline'||settings.policyVersion!==validated.policyVersion||!rules.length||rules.length>10)throw Error('Guardian medical activation is not approved.');
 const config=Object.freeze({...validated,referenceKey:new Uint8Array(validated.referenceKey)}),approvedRules=structuredClone(rules);approvedRules.forEach(validateDemoRule);
 const fingerprint=notificationDigest(policyDigest(config)+approvedRules.map(ruleDigest).sort().join(':'));
 const rawReference=(id:string)=>'gn1.'+id+'.'+createHmac('sha256',config.referenceKey).update('guardian-report-v1\0'+id).digest('hex');
 async function createJob(c:PatientDatabase,patient:string,g:any,kind:string,start:Date|null,end:Date|null){const id=randomUUID();await c.query(`INSERT INTO guardian_medical_jobs(id,patient_id,relationship_id,recipient_hash,patient_security_version,kind,policy_sha256,window_start,window_end,not_before,max_attempts)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($9,clock_timestamp()),$10)`,[id,patient,g.id,recipientHash(g.email),g.security_version,kind,fingerprint,start,end,config.maxAttempts]);await event(c,patient,kind==='routine_digest'?'digest_queued':'serious_queued',id);return id;}
 async function addItem(c:PatientDatabase,job:string,patient:string,source:any,summary:string|null,result:string|null){const id=randomUUID();await c.query(`INSERT INTO guardian_medical_items(id,job_id,patient_id,document_id,snapshot_id,summary_id,rule_result_id,reference_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,job,patient,source.document_id,source.snapshot_id,summary,result,secretHash('guardian_report',rawReference(id))]);}
 async function cancel(c:PatientDatabase,j:any,reason:string){await c.query("UPDATE guardian_medical_jobs SET state='cancelled',failure_code=$2,claim_token=NULL,lease_expires_at=NULL WHERE id=$1",[j.id,reason]);await event(c,j.patient_id,reason==='recipient_denied'?'recipient_denied':'source_denied',j.id);}
 async function registerRules(c:PatientDatabase){for(const r of approvedRules){await c.query(`INSERT INTO guardian_serious_rules(id,version,definition,definition_sha256,approval_status,approval_metadata) VALUES($1,$2,$3,$4,'non_clinical_demo',$5) ON CONFLICT(id,version) DO NOTHING`,[r.id,r.version,r,ruleDigest(r),r.approval]);const stored=(await c.query('SELECT definition_sha256,approval_status FROM guardian_serious_rules WHERE id=$1 AND version=$2',[r.id,r.version])).rows[0];if(stored?.definition_sha256!==ruleDigest(r)||stored?.approval_status!=='non_clinical_demo')throw Error('Rule version conflict; explicit version changes required.');}}
 async function prepare(c:PatientConnection,j:any):Promise<ProviderMessage|undefined>{const patient=j.patient_id;
    const g=await currentRecipient(c,patient);
    if(!g||g.id!==j.relationship_id||recipientHash(g.email)!==j.recipient_hash||String(g.security_version)!==String(j.patient_security_version)||!syntheticEmail(g.email)||!syntheticEmail(g.patient_email)){await cancel(c,j,'recipient_denied');return undefined;}
    if(j.policy_sha256!==fingerprint){await cancel(c,j,'policy_changed');return undefined;}
    let items=(await c.query(`SELECT i.*,d.original_filename,d.document_date::text,d.uploaded_at,a.summary_text,a.provenance,a.structured_output,a.source_fingerprint,a.model_name,a.model_version,r.rule_id,r.rule_version,r.definition_sha256,r.result,
 public.guardian_medical_item_current(i.id,i.patient_id) current FROM guardian_medical_items i LEFT JOIN medical_documents d ON (d.id,d.patient_id)=(i.document_id,i.patient_id)
 LEFT JOIN ai_report_summaries a ON (a.id,a.patient_id)=(i.summary_id,i.patient_id) LEFT JOIN guardian_rule_results r ON (r.id,r.patient_id)=(i.rule_result_id,i.patient_id) WHERE i.job_id=$1 AND i.patient_id=$2 AND i.included ORDER BY d.document_date NULLS LAST,d.uploaded_at,i.id`,[j.id,patient])).rows;
    if(j.content_sha256&&items.some(i=>!i.current)){await cancel(c,j,'source_denied');return undefined;}
    for(const item of items.filter(i=>!i.current))await c.query('UPDATE guardian_medical_items SET included=false WHERE id=$1',[item.id]);items=items.filter(i=>i.current);
    if(!items.length){await cancel(c,j,'source_denied');return undefined;}
    await c.query("UPDATE guardian_medical_items SET reference_expires_at=COALESCE(reference_expires_at,clock_timestamp()+$2*interval '1 second') WHERE job_id=$1 AND included",[j.id,config.referenceSeconds]);
    const expired=(await c.query('SELECT id FROM guardian_medical_items WHERE job_id=$1 AND included AND reference_expires_at<=clock_timestamp()',[j.id])).rows;if(expired.length){await cancel(c,j,'source_denied');return undefined;}
    const blocks=items.map(i=>{
     const reference=config.origin+'/#/guardian-report/'+rawReference(i.id),context='Report: '+JSON.stringify(i.original_filename)+'\nDate: '+(i.document_date??i.uploaded_at.toISOString().slice(0,10))+'\nReport reference: '+reference;
     if(j.kind==='routine_digest')return context+'\nExisting report summary:\n'+i.summary_text+'\nSummary provenance: '+JSON.stringify({provider:i.provenance?.provider,model:i.model_name,revision:i.model_version,summary_version:1,source_fingerprint:i.source_fingerprint,uncertainty:i.structured_output?.uncertainty});
     return context+'\nRule: '+i.rule_id+' version '+i.rule_version+'\n'+i.result.explanation+'\nSynthetic source value: '+i.result.value+' '+i.result.unit;
    });
    const message:ProviderMessage={idempotencyKey:j.id,from:'guardian-demo@example.invalid',to:g.email,subject:j.kind==='routine_digest'?'SYNTHETIC ONLY — Guardian report digest':'SYNTHETIC ONLY — Separate predefined-rule alert',text:'NON-CLINICAL DEMONSTRATION. Not approved for real-patient medical communication.\n\n'+blocks.join('\n\n')+'\n\nThis information does not diagnose, prescribe treatment or replace professional medical evaluation.'};
    const contentHash=notificationDigest(JSON.stringify(message));if(Buffer.byteLength(message.text)>65536||j.content_sha256&&j.content_sha256!==contentHash){await cancel(c,j,'content_changed');return undefined;}
    await c.query('UPDATE guardian_medical_jobs SET content_sha256=$2 WHERE id=$1',[j.id,contentHash]);
    return message;
 }
 return {
 get policyFingerprint(){return fingerprint;},
 async enrollSynthetic(patient:string,fixture:{synthetic:true}){if(fixture?.synthetic!==true)throw Error('Explicit synthetic fixture required.');return transaction(db,async c=>{await lockPatient(c,patient);const p=(await c.query('SELECT email FROM patients WHERE id=$1',[patient])).rows[0];if(!syntheticEmail(p?.email))throw Error('Only explicitly enrolled .invalid fixtures are supported.');await c.query('INSERT INTO guardian_notification_enrollments(patient_id,synthetic_fixture) VALUES($1,true) ON CONFLICT DO NOTHING',[patient]);});},
 async scan(patient:string){
  // Snapshot only completed/current extraction, even before summaries exist: alerts do not await a digest/summary.
  const enrolled=(await db.query('SELECT e.enrolled_at FROM guardian_notification_enrollments e JOIN patients p ON p.id=e.patient_id WHERE e.patient_id=$1 AND e.synthetic_fixture AND p.account_status=\'active\' AND p.email_verified_at IS NOT NULL',[patient])).rows[0];if(!enrolled)return {eligible:0,evaluated:0};
  const candidates=(await db.query(`SELECT d.id FROM medical_documents d JOIN document_processing_jobs j ON (j.document_id,j.patient_id)=(d.id,d.patient_id) JOIN extracted_medical_text x ON (x.document_id,x.patient_id)=(d.id,d.patient_id)
 WHERE d.patient_id=$1 AND j.state='completed' AND x.processing_status='completed' AND public.document_accessible(d.id,d.patient_id) AND d.uploaded_at>=$2 AND x.processing_attempt=j.attempt_count AND x.processing_claim_token IS NOT NULL AND octet_length(x.extracted_text)<=32768
 AND EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb) cfg WHERE NOT EXISTS(SELECT 1 FROM guardian_rule_results r JOIN summary_source_snapshots s ON (s.id,s.patient_id)=(r.snapshot_id,r.patient_id)
 WHERE r.document_id=d.id AND r.patient_id=d.patient_id AND r.rule_id=cfg->>'id' AND r.rule_version=cfg->>'version' AND public.summary_source_current(s)))
 ORDER BY d.uploaded_at,d.id LIMIT 100`,[patient,enrolled.enrolled_at,JSON.stringify(approvedRules.map(r=>({id:r.id,version:r.version})))])).rows;
  const snapshots:SummarySnapshot[]=[];for(const candidate of candidates){try{snapshots.push(await createSummaryJobRepository(db,patient).captureSnapshot(candidate.id));}catch(e){if((e as any)?.code!=='SOURCE_INELIGIBLE')throw e;}}
  return transaction(db,async c=>{
   await lockPatient(c,patient);await registerRules(c);let evaluated=0;
   for(const s of snapshots){if(!(await c.query('SELECT 1 FROM summary_source_snapshots s WHERE s.id=$1 AND s.patient_id=$2 AND public.lock_summary_source(s)',[s.id,patient])).rows.length)continue;
    for(const r of approvedRules){const result=evaluateDemoRule(r,s.extracted_text,s.source_metadata.method),id=randomUUID();const row=(await c.query(`INSERT INTO guardian_rule_results(id,patient_id,document_id,snapshot_id,rule_id,rule_version,definition_sha256,outcome,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(snapshot_id,rule_id,rule_version) DO NOTHING RETURNING id`,[id,patient,s.document_id,s.id,r.id,r.version,ruleDigest(r),result.outcome,result])).rows[0];if(row){evaluated++;await event(c,patient,'rule_evaluated');if(result.outcome==='TRIGGERED')await event(c,patient,'serious_trigger');if(result.outcome==='INDETERMINATE')await event(c,patient,'indeterminate');}}
   }
   const sources=(await c.query(`INSERT INTO guardian_routine_sources(summary_id,patient_id,document_id,snapshot_id,eligible_at)
 SELECT a.id,a.patient_id,a.document_id,a.source_snapshot_id,a.generated_at FROM ai_report_summaries a JOIN summary_source_snapshots s ON s.id=a.source_snapshot_id AND s.patient_id=a.patient_id
 WHERE a.patient_id=$1 AND a.summary_contract_version=1 AND a.processing_status='completed' AND a.generated_at>=$2 AND public.summary_source_current(s)
 AND NOT EXISTS(SELECT 1 FROM guardian_routine_sources old WHERE old.patient_id=a.patient_id AND old.document_id=a.document_id AND old.snapshot_id=a.source_snapshot_id)
 ORDER BY a.generated_at,a.id LIMIT 100
 ON CONFLICT DO NOTHING RETURNING summary_id`,[patient,enrolled.enrolled_at])).rows;for(const _ of sources)await event(c,patient,'digest_eligible');
   const g=await currentRecipient(c,patient);if(!g||!syntheticEmail(g.email)||!syntheticEmail(g.patient_email))return {eligible:sources.length,evaluated};
   const pending=(await c.query('SELECT * FROM guardian_routine_sources WHERE patient_id=$1 AND job_id IS NULL ORDER BY eligible_at,summary_id LIMIT 100',[patient])).rows;
   for(const s of pending){const start=new Date(Math.floor(s.eligible_at.getTime()/1000/config.windowSeconds)*config.windowSeconds*1000),end=new Date(start.getTime()+config.windowSeconds*1000);
    let job=(await c.query("SELECT id FROM guardian_medical_jobs WHERE patient_id=$1 AND relationship_id=$2 AND kind='routine_digest' AND window_start=$3 AND policy_sha256=$4 AND state='pending' AND attempts=0 ORDER BY id LIMIT 1",[patient,g.id,start,fingerprint])).rows[0]?.id;
    if(!job)job=await createJob(c,patient,g,'routine_digest',start,end);await addItem(c,job,patient,s,s.summary_id,null);await c.query('UPDATE guardian_routine_sources SET job_id=$2 WHERE summary_id=$1',[s.summary_id,job]);
   }
   const triggered=(await c.query(`SELECT r.* FROM guardian_rule_results r JOIN guardian_serious_rules d ON (d.id,d.version,d.definition_sha256)=(r.rule_id,r.rule_version,r.definition_sha256)
 WHERE r.patient_id=$1 AND r.outcome='TRIGGERED' AND r.job_id IS NULL AND d.approval_status='non_clinical_demo'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) cfg WHERE r.rule_id=cfg->>'id' AND r.rule_version=cfg->>'version') ORDER BY r.evaluated_at,r.id LIMIT 100`,[patient,JSON.stringify(approvedRules.map(r=>({id:r.id,version:r.version})))])).rows;
   for(const s of triggered){if(!(await c.query('SELECT 1 FROM summary_source_snapshots s WHERE s.id=$1 AND s.patient_id=$2 AND public.summary_source_current(s)',[s.snapshot_id,patient])).rows.length)continue;const job=await createJob(c,patient,g,'serious_alert',null,null);await addItem(c,job,patient,s,null,s.id);await c.query('UPDATE guardian_rule_results SET job_id=$2 WHERE id=$1',[s.id,job]);}
   return {eligible:sources.length,evaluated};
  });
 },
 async drain(patient:string,limit=10){
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('Invalid guardian drain limit.');const results:string[]=[];
  for(let n=0;n<limit;n++){
   const job=await transaction(db,async c=>{
    await lockPatient(c,patient);
    const expired=(await c.query("SELECT id FROM guardian_medical_jobs WHERE patient_id=$1 AND state='running' AND lease_expires_at<=clock_timestamp() FOR UPDATE",[patient])).rows;
    for(const j of expired){await c.query("UPDATE guardian_medical_jobs SET state=CASE WHEN attempts<max_attempts THEN 'retry_wait' ELSE 'permanent_failed' END,claim_token=NULL,lease_expires_at=NULL,failure_code='lease_expired' WHERE id=$1",[j.id]);await event(c,patient,'lease_recovered',j.id);}
    return (await c.query(`WITH candidate AS(SELECT id FROM guardian_medical_jobs WHERE patient_id=$1 AND state IN ('pending','retry_wait') AND attempts<max_attempts AND not_before<=clock_timestamp() AND next_attempt_at<=clock_timestamp() ORDER BY CASE WHEN kind='serious_alert' THEN 0 ELSE 1 END,not_before,id LIMIT 1 FOR UPDATE SKIP LOCKED)
 UPDATE guardian_medical_jobs j SET state='running',attempts=attempts+1,claim_token=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' FROM candidate x WHERE j.id=x.id RETURNING j.*`,[patient,randomUUID(),config.timeoutMs+10000])).rows[0];
   });if(!job)break;
   // Commit the exact content fingerprint/reference lifetime before contacting an external provider.
   const prepared=await transaction(db,async c=>{await lockPatient(c,patient);const j=(await c.query("SELECT * FROM guardian_medical_jobs WHERE id=$1 AND patient_id=$2 AND claim_token=$3 AND state='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[job.id,patient,job.claim_token])).rows[0];if(!j)return false;await event(c,patient,'attempt',j.id);return !!await prepare(c,j);});
   if(!prepared){results.push('cancelled');continue;}
   try{await hooks.beforeHandoff?.(job.id);}catch{await transaction(db,async c=>{await lockPatient(c,patient);const row=(await c.query("SELECT * FROM guardian_medical_jobs WHERE id=$1 AND claim_token=$2 AND state='running' FOR UPDATE",[job.id,job.claim_token])).rows[0];if(row)await cancel(c,row,'policy_changed');});results.push('cancelled');continue;}
   results.push(await transaction(db,async c=>{
    // M02 and M04 acquire this same patient lock. It remains held until the bounded provider handoff settles.
    await lockPatient(c,patient);const j=(await c.query("SELECT * FROM guardian_medical_jobs WHERE id=$1 AND patient_id=$2 AND claim_token=$3 AND state='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[job.id,patient,job.claim_token])).rows[0];if(!j)return 'lease_lost';
    const message=await prepare(c,j);if(!message)return 'cancelled';
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let failure:EmailDeliveryFailure|undefined,receipt:{messageReference?:string}|undefined;
    // A timed-out provider may have accepted the message. Reuse the same key and exact content on retry.
    try{receipt=await Promise.race([provider.send(message,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new EmailDeliveryFailure('timeout',true));},config.timeoutMs);})]);if(receipt?.messageReference!==undefined&&(typeof receipt.messageReference!=='string'||receipt.messageReference.length>256||!receipt.messageReference.length))throw new EmailDeliveryFailure('invalid_receipt',false);}
    catch(e){failure=e instanceof EmailDeliveryFailure?e:new EmailDeliveryFailure('transport',true);}finally{clearTimeout(timer);}
    if(!failure){await c.query("UPDATE guardian_medical_jobs SET state='delivered',delivered_at=clock_timestamp(),provider_reference_hash=$2,claim_token=NULL,lease_expires_at=NULL,failure_code=NULL WHERE id=$1",[j.id,receipt?.messageReference?notificationDigest(receipt.messageReference):null]);await event(c,patient,'delivered',j.id);return 'delivered';}
    const retry=failure.transient&&j.attempts<j.max_attempts;await c.query("UPDATE guardian_medical_jobs SET state=$2,failure_code=$3,claim_token=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+$4*interval '1 second' WHERE id=$1",[j.id,retry?'retry_wait':'permanent_failed',failure.category,config.retrySeconds*2**(j.attempts-1)]);await event(c,patient,'failed',j.id);return retry?'retry_wait':'permanent_failed';
   }));
  }
  return results;
 }
 };
}
export function createGuardianNotificationReader(db:PatientDatabase){return {
 async observe(patient:string){return {jobs:(await db.query('SELECT j.id,j.kind,j.state,j.attempts,j.max_attempts,j.not_before,j.next_attempt_at,j.failure_code,j.created_at,j.delivered_at FROM guardian_medical_jobs j WHERE j.patient_id=$1 AND EXISTS(SELECT 1 FROM guardian_medical_items i WHERE i.job_id=j.id AND i.patient_id=j.patient_id AND public.guardian_medical_item_current(i.id,i.patient_id)) ORDER BY j.created_at DESC,j.id LIMIT 100',[patient])).rows,evaluations:(await db.query('SELECT r.id,r.document_id,r.rule_id,r.rule_version,r.outcome,r.result,r.evaluated_at FROM guardian_rule_results r JOIN summary_source_snapshots s ON (s.id,s.document_id,s.patient_id)=(r.snapshot_id,r.document_id,r.patient_id) WHERE r.patient_id=$1 AND public.summary_source_current(s) ORDER BY r.evaluated_at DESC,r.id LIMIT 100',[patient])).rows};},
 async resolveReference(token:string){if(typeof token!=='string'||!/^gn1\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token))throw guardianDenied();const r=(await db.query(`SELECT i.document_id,i.patient_id FROM guardian_medical_items i JOIN guardian_medical_jobs j ON (j.id,j.patient_id)=(i.job_id,i.patient_id)
 JOIN patients p ON p.id=i.patient_id JOIN guardian_notification_enrollments e ON e.patient_id=p.id AND e.synthetic_fixture
 JOIN guardian_relationships g ON (g.id,g.patient_id)=(j.relationship_id,j.patient_id)
 WHERE i.reference_hash=$1 AND j.state='delivered' AND i.reference_expires_at>clock_timestamp() AND public.guardian_medical_item_current(i.id,i.patient_id)
 AND g.status='ACTIVE' AND g.accepted_at IS NOT NULL AND j.recipient_hash=public.summary_digest('guardian_recipient:'||g.email)
 AND p.account_status='active' AND p.email_verified_at IS NOT NULL AND p.security_version=j.patient_security_version
 AND p.email LIKE '%.invalid' AND g.email LIKE '%.invalid'`,[secretHash('guardian_report',token)])).rows[0];if(!r)throw guardianDenied();return r;}
};}

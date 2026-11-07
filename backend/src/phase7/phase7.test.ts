import {createGuardianNotificationExecutor} from '../guardian-notifications/executor.js';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import {createServer} from 'node:http';
import express from 'express';
import pg from 'pg';
import {createGuardianRepository} from '../guardians/repository.js';
import {createGuardianRoutes} from '../guardians/routes.js';
import {createPatientRoutes} from '../auth/routes.js';
import {createSecurityRepository} from '../auth/security-repository.js';
import {createPasswordService} from '../auth/passwords.js';
import {createTokenService} from '../auth/tokens.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {createSecurityEmailDelivery,EmailDeliveryFailure,type ProviderMessage} from '../auth/security-email.js';
import {createDocumentRepository} from '../documents/repository.js';
import {createDocumentRoutes} from '../documents/routes.js';
import type {DocumentStorage} from '../documents/storage.js';
import {createProcessingRepository} from '../processing/repository.js';
import {createProcessingService} from '../processing/service.js';
import {syntheticDigitalPdf} from '../processing/fixtures/pdf-fixtures.js';
import {createSummaryJobRepository} from '../summaries/jobs.js';
import {sourceCatalogue} from '../summaries/catalogue.js';
import {createSummaryClient,fakeSummaryRecipe} from '../summaries/client.js';
import {createSummaryExecutor,defaultSummaryExecutorConfig} from '../summaries/executor.js';
import {canonicalSummaryJson} from '../summaries/validation.js';
import {errorHandler} from '../http/errors.js';
import {createGuardianNotificationService,createGuardianNotificationReader,type SyntheticGuardianProvider} from '../guardian-notifications/service.js';
import {guardianNotificationConfig,notificationDigest,type GuardianNotificationConfig} from '../guardian-notifications/config.js';
import {demoRule,evaluateDemoRule,type SeriousRule} from '../guardian-notifications/rules.js';
import {syntheticGuardianEmailProvider} from '../guardian-notifications/provider.js';
import {createGuardianNotificationRoutes} from '../guardian-notifications/routes.js';
import {createAdminRoutes} from '../admin/routes.js';
import {createAdminAccount} from '../admin/bootstrap.js';
import type {AdminAuthenticationConfig} from '../admin/config.js';
const socket=process.env.IDENTITY_TEST_SOCKET;if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Test-owned socket required.');
const conn={host:socket,port:55481,database:'hw_phase7'},admin=new pg.Pool({...conn,user:userInfo().username}),db=new pg.Pool({...conn,user:'health_wallet_app',max:16});
const auth={jwtKey:randomBytes(32),jwtAlgorithm:'HS256' as const,jwtLifetimeSeconds:900,jwtIssuer:'phase7-synthetic',jwtAudience:'patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:4,rateLimitWindowMs:900000,rateLimitMax:10000};
const policy={...getSecurityPolicy(),resendCooldownSeconds:1,challengeRateMax:100};
const security=createSecurityRepository(db,policy),tokens=createTokenService(auth),reader=createGuardianNotificationReader(db),objects=new Map<string,Buffer>();
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',async put(){throw Error('Fixture repository only');},async remove(){},async download(){throw Error('No signed URLs');},async readOriginal(i){const bytes=objects.get(i.key);if(!bytes)throw Error('Synthetic missing object');await writeFile(i.destination,bytes,{flag:'wx',mode:0o600});return {bytes:bytes.length};}};
const documentConfig={maxFileBytes:2097152,maxConcurrentUploads:2,uploadTimeoutMs:30000,validationTimeoutMs:15000,maxImagePixels:2000000,maxPdfPages:5,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const processingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:120000,heartbeatMs:5000,retryBaseMs:1000,retryMaxMs:1000,recoveryBatchSize:5};
const settings=guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline'},randomBytes(32))!;
const verificationMessages:ProviderMessage[]=[];
const verification=createSecurityEmailDelivery(db,{mode:'sandbox',endpoint:'http://127.0.0.1/unused',from:'security@example.invalid',encryptionKey:randomBytes(32),timeoutMs:1000,retrySeconds:1,maxAttempts:3},{async send(m){verificationMessages.push(m);return {messageReference:'synthetic-verification'};}});
const guardians=createGuardianRepository(db,policy,verification.mailer);
const medical=new Map<string,{message:ProviderMessage;reference:string}>(),attempts:ProviderMessage[]=[];
let failures:('transient'|'permanent'|'accepted_lost'|'invalid_receipt')[]=[],handoffHook:((id:string)=>Promise<void>)|undefined,providerPause:(()=>Promise<void>)|undefined;
const adminKey=randomBytes(32),adminConfig:AdminAuthenticationConfig={jwtKey:new Uint8Array(adminKey),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'phase7-admin',jwtAudience:'phase7-admin-audience',rateLimitMax:100,rateWindowSeconds:900};
let provider:SyntheticGuardianProvider,fixtureHash:string,server:ReturnType<ReturnType<typeof express>['listen']>,sandbox:ReturnType<typeof createServer>,base:string;
before(async()=>{
 assert.equal((await stat(socket!)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_phase7');}finally{await bootstrap.end();}
 await admin.query('CREATE EXTENSION vector');await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator');fixtureHash=await createPasswordService(auth).hash('Synthetic fixture passphrase 598!');
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,22);
 const sentinel=randomUUID();
 for(const file of files){if(file.startsWith('0005'))await admin.query('GRANT USAGE ON SCHEMA public TO health_wallet_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const sql=await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8');
  if(file.startsWith('0012')){await admin.query("INSERT INTO patients(id,email,password_hash,full_name) VALUES($1,'legacy-phase7@example.invalid',$2,'Legacy synthetic sentinel')",[sentinel,fixtureHash]);const probe=await admin.connect();try{await probe.query('BEGIN');await probe.query('SET LOCAL ROLE health_wallet_migrator');await probe.query(sql);await probe.query('ROLLBACK');}finally{probe.release();}assert.equal((await admin.query("SELECT to_regclass('public.guardian_medical_jobs') relation")).rows[0].relation,null);assert.equal((await admin.query('SELECT full_name FROM patients WHERE id=$1',[sentinel])).rows[0].full_name,'Legacy synthetic sentinel');}
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE health_wallet_migrator');await c.query("SET LOCAL search_path=public,pg_catalog;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='30s'");await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 sandbox=createServer(async(req,res)=>{try{assert.equal(req.url,'/guardian-medical-email');let size=0;const chunks:Buffer[]=[];for await(const b of req){size+=b.length;if(size>131072){res.writeHead(413).end();return;}chunks.push(b);}const m=JSON.parse(Buffer.concat(chunks).toString()) as ProviderMessage;assert.equal(m.idempotencyKey,req.headers['idempotency-key']);assert.match(m.to,/@[^\s]+\.invalid$/);attempts.push(m);const fail=failures.shift();if(fail==='transient'||fail==='permanent'){res.writeHead(fail==='transient'?503:422).end();return;}let item=medical.get(m.idempotencyKey);if(item){assert.equal(notificationDigest(JSON.stringify(item.message)),notificationDigest(JSON.stringify(m)));}else{item={message:m,reference:'synthetic-medical-'+randomUUID()};medical.set(m.idempotencyKey,item);}await providerPause?.();if(fail==='accepted_lost'){res.writeHead(503).end();return;}res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify(fail==='invalid_receipt'?{}:{message_id:item.reference}));}catch{res.writeHead(422).end();}});
 sandbox.listen(0,'127.0.0.1');await once(sandbox,'listening');const a=sandbox.address();assert.ok(a&&typeof a==='object');provider=syntheticGuardianEmailProvider({mode:'sandbox',endpoint:'http://127.0.0.1:'+a.port+'/guardian-medical-email',from:'guardian-demo@example.invalid',encryptionKey:randomBytes(32),timeoutMs:1500,retrySeconds:1,maxAttempts:3});
 const app=express();app.use(express.json());const identity=createPatientRoutes(db,auth,{mailer:verification.mailer,policy});app.use('/api/v1/auth',identity.auth);app.use('/api/v1/patients',identity.profile);app.use('/api/v1',createGuardianRoutes(db,auth,{mailer:verification.mailer,policy}));app.use('/api/v1',createGuardianNotificationRoutes(db,auth,documentConfig,storage));app.use('/api/v1/documents',createDocumentRoutes(db,auth,documentConfig,storage));app.use('/api/v1/admin',createAdminRoutes(db,auth,adminConfig,{health:{services:[]}}));app.use(errorHandler);server=app.listen(0,'127.0.0.1');await once(server,'listening');const b=server.address();assert.ok(b&&typeof b==='object');base='http://127.0.0.1:'+b.port+'/api/v1';
});
after(async()=>{for(const s of [server,sandbox])if(s){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await db.end();await admin.end();});
const worker=(config:GuardianNotificationConfig=settings,rules:readonly SeriousRule[]=[demoRule])=>createGuardianNotificationService(db,config,provider,rules,{beforeHandoff:async id=>{await handoffHook?.(id);}});
async function user(){const id=randomUUID(),email=id+'@example.invalid';await db.query("INSERT INTO patients(id,email,password_hash,full_name,email_verified_at,account_status) VALUES($1,$2,$3,'Synthetic Patient',clock_timestamp(),'active')",[id,email,fixtureHash]);const s=await security.login(id,fixtureHash);assert.ok(s);await worker().enrollSynthetic(id,{synthetic:true});return {id,email,who:{patientId:id,sessionId:s.sessionId},token:await tokens.issue(id,s.sessionId)};}
async function request(path:string,token?:string,body?:unknown,method=body===undefined?'GET':'POST'){const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await r.text();return {status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):text};}
async function guardian(u:Awaited<ReturnType<typeof user>>,active=true,replace=false){if(replace)await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 seconds' WHERE patient_id=$1 AND purpose='guardian_invitation'",[u.id]);const email=randomUUID()+'@example.invalid';const g=await guardians.nominate(u.who,email,replace);assert.ok(g);if(active)await activate(g.id);return {...g,email};}
async function activate(id:string){await verification.drain(100);const row=(await admin.query('SELECT invitation_id FROM guardian_relationships WHERE id=$1',[id])).rows[0];const m=verificationMessages.find(x=>x.text.includes(row.invitation_id));assert.ok(m);const token=m.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(token);await guardians.accept(token);}
const pdf=syntheticDigitalPdf([['Synthetic non-medical original']]);
async function document(u:Awaited<ReturnType<typeof user>>,text='Glucose: 90 mg/dL\nDEMO_MARKER: 5 demo_units',processed=true,method:'pdf_text'|'ocr'='pdf_text'){
 const key=storage.prefix+randomUUID()+'.pdf';objects.set(key,pdf);const d=await createDocumentRepository(db).insert({id:randomUUID(),patientId:u.id,bucket:storage.bucket,key,name:'synthetic.pdf',type:'pdf',mime:'application/pdf',bytes:pdf.length,checksum:createHash('sha256').update(pdf).digest('base64'),category:'lab_report',hospital_name:'Synthetic Hospital',document_date:'2026-01-02'});
 if(processed){const service=createProcessingService(createProcessingRepository(db,processingConfig,u.id)),job=await service.claim();assert.ok(job);assert.equal(await service.persistExtraction({documentId:d.id,patientId:u.id,token:job.lease_token!},{text,method,extractor:{name:'phase7-synthetic',version:'v1'},source:{sha256:d.sha256,pageCount:1,pages:[{page:1,method,...(method==='ocr'?{confidence:50}:{})}]}}),true);}return d;
}
async function summary(u:Awaited<ReturnType<typeof user>>,id:string){const repo=createSummaryJobRepository(db,u.id),s=await repo.captureSnapshot(id),{input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));await repo.enqueue(s.id,sourceCatalogue(s),pipeline);const client=createSummaryClient({enabled:true,token:randomBytes(32).toString('hex')},async r=>{const input=JSON.parse(Buffer.from(r.body).toString());return {status:200,body:(async function*(){yield Buffer.from(canonicalSummaryJson({schema_version:1,kind:'medical-summary-output',scope:input.scope,reported_findings:input.facts,educational_explanations:['glucose'],uncertainty:{codes:['page_locations_unavailable'],fact_ids:[]},catalogue_coverage:'all_catalogued',provenance:fakeSummaryRecipe(r.headers['x-summary-input-sha256'])}));})()};});assert.equal(await createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:u.id},{repository:repo,client}).runOnce(),'completed');return (await repo.summaries(id))[0];}
async function due(patient:string){await admin.query("UPDATE guardian_medical_jobs SET window_start=CASE WHEN kind='routine_digest' THEN statement_timestamp()-interval '1 day' END,window_end=CASE WHEN kind='routine_digest' THEN statement_timestamp()-interval '1 second' END,not_before=statement_timestamp()-interval '1 second',next_attempt_at=statement_timestamp()-interval '1 second' WHERE patient_id=$1 AND state IN ('pending','retry_wait')",[patient]);}
async function ready(){const u=await user(),g=await guardian(u),d=await document(u);await summary(u,d.id);await worker().scan(u.id);await due(u.id);return {u,g,d};}
const jobRows=(patient:string)=>admin.query('SELECT * FROM guardian_medical_jobs WHERE patient_id=$1 ORDER BY created_at,id',[patient]).then(r=>r.rows);
const reference=(message:ProviderMessage)=>message.text.match(/gn1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];
const sentTo=(email:string)=>[...medical.values()].filter(x=>x.message.to===email);
test('P7-01 synthetic-only gates, default 24h policy and uncertainty-aware versioned demo comparisons',()=>{
 assert.equal(settings.windowSeconds,86400);assert.equal(guardianNotificationConfig({}),undefined);assert.throws(()=>guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'production'},randomBytes(32)));assert.throws(()=>guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline',GUARDIAN_INDETERMINATE_POLICY:'send'},randomBytes(32)));
 assert.throws(()=>worker(settings,[{...demoRule,field:'Glucose'}]));assert.throws(()=>createGuardianNotificationService(db,settings,{mode:'https-relay',send:provider.send} as any));
 const evaluate=(s:string,method='pdf_text')=>evaluateDemoRule(demoRule,s,method);
 assert.equal(evaluate('DEMO_MARKER: 11 demo_units').outcome,'TRIGGERED');assert.equal(evaluate('DEMO_MARKER: 10 demo_units').outcome,'NOT_TRIGGERED');
 for(const s of ['', 'DEMO_MARKER: ?? demo_units','DEMO_MARKER: 11 mg/dL','DEMO_MARKER: 11 demo_units\nDEMO_MARKER: 4 demo_units'])assert.equal(evaluate(s).outcome,'INDETERMINATE');assert.equal(evaluate('DEMO_MARKER: 11 demo_units','ocr').outcome,'INDETERMINATE');
 assert.equal(evaluateDemoRule({...demoRule,context:{DEMO_CONTEXT:'fixture'}},'DEMO_MARKER: 11 demo_units','pdf_text').outcome,'INDETERMINATE');assert.equal(evaluateDemoRule({...demoRule,operator:'between',bounds:[1,5]},'DEMO_MARKER: 3 demo_units','pdf_text').outcome,'TRIGGERED');
 assert.throws(()=>syntheticGuardianEmailProvider({mode:'sandbox',endpoint:'http://127.0.0.1/security-email',from:'security@example.invalid',encryptionKey:randomBytes(32),timeoutMs:1000,retrySeconds:1,maxAttempts:3}));
});
test('P7-02 only processing+current-summary readiness; 24h grouping, scoped content, originals and deduplication',async()=>{
 const u=await user(),g=await guardian(u),a=await document(u),b=await document(u,'Glucose: 110 mg/dL\nDEMO_MARKER: 4 demo_units'),failed=await document(u,'',false),other=await user();await guardian(other);const foreign=await document(other,'Glucose: 999 mg/dL');await summary(other,foreign.id);
 const processing=createProcessingService(createProcessingRepository(db,processingConfig,u.id)),failedJob=await processing.claim();assert.ok(failedJob);assert.equal(await processing.fail({documentId:failed.id,patientId:u.id,token:failedJob.lease_token!},'PROCESSOR_FAILED',false),true);
 await worker().scan(u.id);assert.equal((await jobRows(u.id)).length,0);assert.equal((await reader.observe(u.id)).evaluations.length,2);
 await summary(u,a.id);await summary(u,b.id);await worker().scan(u.id);const jobs=await jobRows(u.id);assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'routine_digest');assert.equal(jobs[0].window_end.getTime()-jobs[0].window_start.getTime(),86400000);assert.deepEqual(await worker().drain(u.id),[]);assert.equal(sentTo(g.email).length,0);
 const items=(await admin.query('SELECT document_id FROM guardian_medical_items WHERE job_id=$1',[jobs[0].id])).rows;assert.deepEqual(items.map(x=>x.document_id).sort(),[a.id,b.id].sort());assert.ok(items.every(x=>x.document_id!==failed.id&&x.document_id!==foreign.id));
 await due(u.id);assert.deepEqual(await worker().drain(u.id),['delivered']);const m=sentTo(g.email)[0].message;assert.ok(m.text.includes('90 mg/dL')&&m.text.includes('110 mg/dL'));assert.equal(m.text.includes('999 mg/dL'),false);for(const secret of [u.id,a.id,b.id,storage.bucket,storage.prefix,'scope_token','system prompt'])assert.equal(m.text.includes(secret),false);assert.ok(m.text.includes('synthetic-fake')&&m.text.includes('page_locations_unavailable'));
 await worker().scan(u.id);assert.deepEqual(await worker().drain(u.id),[]);assert.equal(sentTo(g.email).length,1);
 const ref=reference(m);assert.ok(ref);const file=await request('/guardian-notifications/reports',undefined,{token:ref});assert.equal(file.status,200);assert.match(file.headers.get('content-disposition')!,/^attachment/);assert.equal(Buffer.byteLength(file.data),pdf.length);assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref,patient_id:other.id})).status,403);assert.equal((await request('/guardian-notifications/reports',undefined,{token:'gn1.'+randomUUID()+'.'+'0'.repeat(64)})).status,403);
 const info=await request('/patients/me/guardian-notifications',u.token);assert.equal(info.status,200);assert.equal(info.data.jobs.length,1);assert.equal((await request('/patients/me/guardian-notifications',other.token)).data.jobs.length,0);
 await guardians.remove(u.who);assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref})).status,403);assert.equal((await request('/documents/'+a.id+'/download',u.token)).status,200);
});
test('P7-03 absent/pending/expired/revoked guardians receive no medical mail',async()=>{
 for(const state of ['none','pending','expired','revoked']){const u=await user();let g:any;if(state!=='none')g=await guardian(u,state==='revoked');if(state==='expired'){await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT invitation_id FROM guardian_relationships WHERE id=$1)",[g.id]);assert.equal((await guardians.status(u.who))!.status,'EXPIRED');}if(state==='revoked')await guardians.remove(u.who);const d=await document(u);await summary(u,d.id);await worker().scan(u.id);await due(u.id);assert.deepEqual(await worker().drain(u.id),[]);if(g)assert.equal(sentTo(g.email).length,0);}
 assert.ok(verificationMessages.every(m=>!m.text.includes('Glucose')&&!m.text.includes('DEMO_MARKER')&&!m.subject.includes('digest')));
});
test('P7-04 queued routine jobs reauthorize removal/replacement immediately before provider handoff',async()=>{
 for(const replace of [false,true]){const {u,g}=await ready();handoffHook=async id=>{handoffHook=undefined;assert.match((await admin.query('SELECT content_sha256 FROM guardian_medical_jobs WHERE id=$1',[id])).rows[0].content_sha256,/^[a-f0-9]{64}$/);if(replace)await guardian(u,false,true);else await guardians.remove(u.who);};try{assert.deepEqual(await worker().drain(u.id),['cancelled']);assert.equal(sentTo(g.email).length,0);assert.equal((await jobRows(u.id))[0].failure_code,'recipient_denied');}finally{handoffHook=undefined;}}
});
test('P7-05 transient delivery retries use stable content, references and idempotency key',async()=>{
 const {u,g}=await ready();failures=['transient'];assert.deepEqual(await worker().drain(u.id),['retry_wait']);let j=(await jobRows(u.id))[0];assert.equal(j.attempts,1);assert.equal(j.delivered_at,null);assert.equal(sentTo(g.email).length,0);await due(u.id);assert.deepEqual(await worker().drain(u.id),['delivered']);j=(await jobRows(u.id))[0];assert.equal(j.attempts,2);assert.ok(j.provider_reference_hash);const tried=attempts.filter(m=>m.idempotencyKey===j.id);assert.equal(tried.length,2);assert.equal(notificationDigest(JSON.stringify(tried[0])),notificationDigest(JSON.stringify(tried[1])));assert.equal(sentTo(g.email).length,1);assert.deepEqual(await worker().drain(u.id),[]);
});
test('P7-06 permanent failure and exhausted transient budget remain observable and bounded',async()=>{
 const x=await ready();failures=['permanent'];assert.deepEqual(await worker().drain(x.u.id),['permanent_failed']);assert.deepEqual(await worker().drain(x.u.id),[]);assert.equal((await jobRows(x.u.id))[0].attempts,1);assert.equal(sentTo(x.g.email).length,0);
 const u=await user(),g=await guardian(u),d=await document(u);await summary(u,d.id);const c={...settings,maxAttempts:2};await worker(c).scan(u.id);await due(u.id);failures=['transient'];assert.deepEqual(await worker(c).drain(u.id),['retry_wait']);await due(u.id);failures=['transient'];assert.deepEqual(await worker(c).drain(u.id),['permanent_failed']);assert.deepEqual(await worker(c).drain(u.id),[]);assert.equal((await jobRows(u.id))[0].attempts,2);assert.equal(sentTo(g.email).length,0);
});
test('P7-07 accepted message with lost receipt is retried idempotently once, not duplicated',async()=>{
 const {u,g}=await ready();failures=['accepted_lost'];assert.deepEqual(await worker().drain(u.id),['retry_wait']);assert.equal(sentTo(g.email).length,1);await due(u.id);assert.deepEqual(await worker().drain(u.id),['delivered']);assert.equal(sentTo(g.email).length,1);const j=(await jobRows(u.id))[0];assert.equal(attempts.filter(m=>m.idempotencyKey===j.id).length,2);
});
test('P7-08 stale worker lease recovery and concurrent drains do not duplicate a batch',async()=>{
 const {u,g}=await ready(),j=(await jobRows(u.id))[0];await admin.query("UPDATE guardian_medical_jobs SET state='running',attempts=1,claim_token=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id,randomUUID()]);const result=await Promise.all([worker().drain(u.id),worker().drain(u.id)]);assert.equal(result.flat().filter(x=>x==='delivered').length,1);assert.equal(sentTo(g.email).length,1);assert.equal((await jobRows(u.id))[0].attempts,2);
});
test('P7-09 separate prompt synthetic alert does not wait for summary readiness or routine window',async()=>{
 const u=await user(),g=await guardian(u),d=await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await worker().scan(u.id);let jobs=await jobRows(u.id);assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'serious_alert');assert.equal(jobs[0].window_end,null);assert.deepEqual(await worker().drain(u.id),['delivered']);let m=sentTo(g.email)[0].message;assert.ok(m.subject.includes('Separate'));assert.ok(m.text.includes('NON-CLINICAL')&&m.text.includes('11 demo_units')&&m.text.includes('not a diagnosis')&&m.text.includes('not diagnose'));assert.equal(m.text.includes('prescribe treatment or replace') ,true);
 const result=(await admin.query('SELECT * FROM guardian_rule_results WHERE patient_id=$1',[u.id])).rows[0];assert.equal(result.outcome,'TRIGGERED');assert.equal(result.rule_id,demoRule.id);assert.equal(result.rule_version,'1');assert.match(result.definition_sha256,/^[a-f0-9]{64}$/);
 await summary(u,d.id);await worker().scan(u.id);jobs=await jobRows(u.id);assert.equal(jobs.length,2);assert.equal(jobs.filter(j=>j.kind==='routine_digest').length,1);assert.deepEqual(await worker().drain(u.id),[]);assert.equal(sentTo(g.email).length,1);await due(u.id);assert.deepEqual(await worker().drain(u.id),['delivered']);assert.equal(sentTo(g.email).length,2);
});
test('P7-10 serious pending/revoked/removed/replaced guardians denied; indeterminate never becomes an alert',async()=>{
 for(const state of ['pending','revoked','remove_race','replace_race']){const u=await user(),g=await guardian(u,state!=='pending');if(state==='revoked')await guardians.remove(u.who);await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await worker().scan(u.id);if(state.endsWith('race'))handoffHook=async()=>{handoffHook=undefined;if(state==='remove_race')await guardians.remove(u.who);else await guardian(u,false,true);};try{await worker().drain(u.id);assert.equal(sentTo(g.email).length,0);}finally{handoffHook=undefined;}}
 const u=await user(),g=await guardian(u);for(const marker of ['','DEMO_MARKER: ?? demo_units','DEMO_MARKER: 11 mg/dL','DEMO_MARKER: 3 demo_units'])await document(u,'Glucose: 90 mg/dL\n'+marker);await worker().scan(u.id);const info=await reader.observe(u.id);assert.equal(info.evaluations.filter(x=>x.outcome==='INDETERMINATE').length,3);assert.equal(info.evaluations.filter(x=>x.outcome==='NOT_TRIGGERED').length,1);assert.deepEqual(await worker().drain(u.id),[]);assert.equal(sentTo(g.email).length,0);
});
test('P7-11 deleted/restricted sources excluded before first send; retries and serious jobs cannot bypass deletion',async()=>{
 const u=await user(),g=await guardian(u),a=await document(u),b=await document(u);await summary(u,a.id);await summary(u,b.id);await worker().scan(u.id);await request('/documents/'+a.id,u.token,undefined,'DELETE');await due(u.id);assert.deepEqual(await worker().drain(u.id),['delivered']);const j=(await jobRows(u.id))[0],included=(await admin.query('SELECT document_id FROM guardian_medical_items WHERE job_id=$1 AND included',[j.id])).rows;assert.deepEqual(included.map(i=>i.document_id),[b.id]);assert.equal(sentTo(g.email).length,1);
 const x=await ready();failures=['transient'];assert.deepEqual(await worker().drain(x.u.id),['retry_wait']);await admin.query("UPDATE medical_documents SET access_state='restricted' WHERE id=$1",[x.d.id]);await due(x.u.id);assert.deepEqual(await worker().drain(x.u.id),['cancelled']);assert.equal(sentTo(x.g.email).length,0);
 const y=await user(),yg=await guardian(y),d=await document(y,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await worker().scan(y.id);await request('/documents/'+d.id,y.token,undefined,'DELETE');assert.deepEqual(await worker().drain(y.id),['cancelled']);assert.equal(sentTo(yg.email).length,0);
});
test('P7-12 every retry rechecks current guardian; source and recipient identity are not redirected',async()=>{
 for(const replace of [false,true]){const {u,g}=await ready();failures=['transient'];assert.deepEqual(await worker().drain(u.id),['retry_wait']);if(replace)await guardian(u,true,true);else await guardians.remove(u.who);await due(u.id);assert.deepEqual(await worker().drain(u.id),['cancelled']);assert.equal(sentTo(g.email).length,0);assert.equal((await jobRows(u.id))[0].attempts,2);}
 for(const state of ['suspended','deleted','version','email']){const {u,g}=await ready();if(state==='version')await admin.query('UPDATE patients SET security_version=security_version+1 WHERE id=$1',[u.id]);else if(state==='email'){await assert.rejects(admin.query('UPDATE guardian_relationships SET email=$2 WHERE id=$1',[g.id,'changed@example.invalid']),(e:any)=>e.code==='23514');await guardians.remove(u.who);}else await admin.query('UPDATE patients SET account_status=$2 WHERE id=$1',[u.id,state]);assert.deepEqual(await worker().drain(u.id),['cancelled']);assert.equal(sentTo(g.email).length,0);}
});
test('P7-13 provider handoff serializes with removal; completed removal denies all future sends/references',async()=>{
 const {u,g}=await ready();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),allowed=new Promise<void>(r=>release=r);providerPause=async()=>{entered();await allowed;};let remove:Promise<unknown>|undefined;
 try{const sending=worker().drain(u.id);await started;let removed=false;remove=guardians.remove(u.who).then(()=>{removed=true;});await new Promise(r=>setTimeout(r,25));assert.equal(removed,false);release();assert.deepEqual(await sending,['delivered']);await remove;assert.equal(sentTo(g.email).length,1);const ref=reference(sentTo(g.email)[0].message);assert.ok(ref);await assert.rejects(reader.resolveReference(ref),(e:any)=>e.status===403);assert.deepEqual(await worker().drain(u.id),[]);}finally{release();providerPause=undefined;await remove;}
});
test('P7-14 cross-patient constraints, no arbitrary recipient, expiring references and append-only safe audit',async()=>{
 const x=await ready(),y=await ready(),jx=(await jobRows(x.u.id))[0],iy=(await admin.query('SELECT * FROM guardian_medical_items WHERE patient_id=$1',[y.u.id])).rows[0];
 await assert.rejects(db.query('INSERT INTO guardian_medical_items(id,job_id,patient_id,document_id,snapshot_id,summary_id,reference_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),jx.id,x.u.id,iy.document_id,iy.snapshot_id,iy.summary_id,'0'.repeat(64)]),(e:any)=>e.code==='23503');
 assert.equal((await request('/patients/me/guardian-notifications',undefined)).status,401);assert.equal((await request('/guardian-notifications/reports',undefined,{token:'none',email:'attacker@example.invalid'})).status,403);
 assert.deepEqual(await worker().drain(x.u.id),['delivered']);const ref=reference(sentTo(x.g.email)[0].message);assert.ok(ref);assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref})).status,200);await admin.query("UPDATE guardian_medical_items SET reference_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[jx.id]);await assert.rejects(reader.resolveReference(ref),(e:any)=>e.status===403);
 for(const table of ['guardian_medical_events','guardian_serious_rules'])await assert.rejects(db.query('DELETE FROM '+table,[]),(e:any)=>e.code==='42501');
 const events=(await db.query('SELECT DISTINCT event FROM guardian_medical_events',[])).rows.map(x=>x.event);for(const e of ['digest_eligible','digest_queued','attempt','delivered','failed','recipient_denied','source_denied','rule_evaluated','serious_trigger','serious_queued','indeterminate','lease_recovered'])assert.ok(events.includes(e),e);
 assert.deepEqual((await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='guardian_medical_events' ORDER BY ordinal_position")).rows.map(x=>x.column_name),['id','patient_id','job_id','event','occurred_at']);
});
test('P7-15 rule/policy versions cannot drift across retries; later digest windows admit only new sources',async()=>{
 const {u,g,d}=await ready();failures=['transient'];assert.deepEqual(await worker().drain(u.id),['retry_wait']);await request('/documents/'+d.id,u.token,{document_date:'2026-01-03'},'PATCH');await due(u.id);assert.deepEqual(await worker().drain(u.id),['cancelled']);assert.equal(sentTo(g.email).length,0);
 const changed=await ready();failures=['transient'];assert.deepEqual(await worker().drain(changed.u.id),['retry_wait']);await due(changed.u.id);assert.deepEqual(await worker({...settings,windowSeconds:86399}).drain(changed.u.id),['cancelled']);assert.equal(sentTo(changed.g.email).length,0);
 const v=await user();await document(v);await worker().scan(v.id);await assert.rejects(worker(settings,[{...demoRule,bounds:[12]}]).scan(v.id));await worker(settings,[{...demoRule,version:'2',bounds:[12]}]).scan(v.id);const versions=(await reader.observe(v.id)).evaluations.map(x=>x.rule_version);assert.ok(versions.includes('1')&&versions.includes('2'));
 const short={...settings,windowSeconds:1},z=await user(),zg=await guardian(z),a=await document(z);await summary(z,a.id);await worker(short).scan(z.id);await due(z.id);assert.deepEqual(await worker(short).drain(z.id),['delivered']);await new Promise(r=>setTimeout(r,1100));const b=await document(z,'Glucose: 110 mg/dL');await summary(z,b.id);await worker(short).scan(z.id);await due(z.id);assert.deepEqual(await worker(short).drain(z.id),['delivered']);assert.equal(sentTo(zg.email).length,2);assert.equal(sentTo(zg.email)[1].message.text.includes('90 mg/dL'),false);
});

test('P7-16 explicit worker tick discovers eligible summaries and sends only due jobs',async()=>{
 const u=await user(),g=await guardian(u),d=await document(u);await summary(u,d.id);const executor=createGuardianNotificationExecutor(worker(),[u.id]);
 const first=executor.runOnce();assert.equal((await executor.runOnce()).state,'busy');assert.equal((await first).state,'completed');assert.equal(sentTo(g.email).length,0);await due(u.id);assert.equal((await executor.runOnce()).state,'completed');assert.equal(sentTo(g.email).length,1);await executor.stop();assert.equal((await executor.runOnce()).state,'stopped');
});

test('P7-17 timeout and invalid provider receipts remain observable without false delivery success',async()=>{
 const u=await user(),g=await guardian(u),d=await document(u);await summary(u,d.id);const c={...settings,timeoutMs:30};
 const slow:SyntheticGuardianProvider={mode:'synthetic-offline',async send(_m,signal){return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new EmailDeliveryFailure('timeout',true)),{once:true}));}};
 const service=createGuardianNotificationService(db,c,slow);await service.scan(u.id);await due(u.id);assert.deepEqual(await service.drain(u.id),['retry_wait']);const j=(await jobRows(u.id))[0];assert.equal(j.failure_code,'timeout');assert.equal(j.delivered_at,null);await guardians.remove(u.who);await due(u.id);assert.deepEqual(await service.drain(u.id),['cancelled']);assert.equal(sentTo(g.email).length,0);
 const x=await ready();failures=['invalid_receipt'];assert.deepEqual(await worker().drain(x.u.id),['permanent_failed']);const bad=(await jobRows(x.u.id))[0];assert.equal(bad.failure_code,'invalid_receipt');assert.equal(bad.delivered_at,null);assert.deepEqual(await worker().drain(x.u.id),[]);
});

test('P7-18 patient notification status cannot expose deleted/restricted source-derived findings',async()=>{
 for(const state of ['deleted','restricted']){const u=await user(),g=await guardian(u),d=await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await worker().scan(u.id);const before=await request('/patients/me/guardian-notifications',u.token);assert.equal(before.data.evaluations.length,1);assert.equal(before.data.jobs.length,1);
 if(state==='deleted')assert.equal((await request('/documents/'+d.id,u.token,undefined,'DELETE')).status,200);else await admin.query("UPDATE medical_documents SET access_state='restricted' WHERE id=$1",[d.id]);
 const after=await request('/patients/me/guardian-notifications',u.token);assert.equal(after.status,200);assert.deepEqual(after.data.evaluations,[]);assert.deepEqual(after.data.jobs,[]);assert.deepEqual(await worker().drain(u.id),['cancelled']);assert.equal(sentTo(g.email).length,0);assert.equal((await admin.query('SELECT count(*)::int n FROM guardian_rule_results WHERE patient_id=$1',[u.id])).rows[0].n,1);
 }
});

test('P7-19 inactive rule versions and withdrawn demo-rule status cannot authorize alerts',async()=>{
 const u=await user(),g=await guardian(u,false);await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await worker().scan(u.id);assert.equal((await jobRows(u.id)).length,0);await activate(g.id);
 const v2={...demoRule,version:'2',bounds:[12]};await worker(settings,[v2]).scan(u.id);assert.equal((await jobRows(u.id)).length,0);assert.equal(sentTo(g.email).length,0);
 const y=await user(),yg=await guardian(y);await document(y,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await worker().scan(y.id);
 try{await admin.query("UPDATE guardian_serious_rules SET approval_status='pending_review' WHERE id=$1 AND version=$2",[demoRule.id,demoRule.version]);assert.deepEqual(await worker().drain(y.id),['cancelled']);assert.equal(sentTo(yg.email).length,0);}finally{await admin.query("UPDATE guardian_serious_rules SET approval_status='non_clinical_demo' WHERE id=$1 AND version=$2",[demoRule.id,demoRule.version]);}
});

test('P7-20 an admin suspending the patient cuts off guardian report links and notifications, and reactivation revives no old link',async()=>{
 const adminPassword='Synthetic admin passphrase 731!',email=randomUUID()+'@example.invalid';
 await createAdminAccount(admin,p=>createPasswordService(auth).hash(p),{email,fullName:'Synthetic Admin',role:'support_admin',password:adminPassword});
 const login=await fetch(base+'/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:adminPassword})});assert.equal(login.status,200);const adminToken=((await login.json()) as {access_token:string}).access_token;
 const act=(path:string)=>fetch(base+'/admin/patients/'+path,{method:'POST',headers:{Authorization:'Bearer '+adminToken}});
 const eligible=async(patient:string)=>Number((await admin.query('SELECT count(*) FROM guardian_communication_eligibility WHERE patient_id=$1',[patient])).rows[0].count);
 const {u,g}=await ready();assert.deepEqual(await worker().drain(u.id),['delivered']);const ref=reference(sentTo(g.email)[0].message);assert.ok(ref);
 assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref})).status,200,'the emailed report link works for an active patient');
 assert.equal(await eligible(u.id),1);assert.equal((await request('/patients/me/guardian-notifications',u.token)).status,200);
 // suspension by an admin
 const suspended=await act(u.id+'/suspend');assert.equal(suspended.status,200);
 assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref})).status,403,'the emailed report link stops working');
 assert.equal(await eligible(u.id),0,'the guardian is not eligible for any message while the patient is suspended');
 assert.equal((await request('/patients/me/guardian-notifications',u.token)).status,401);
 await worker().scan(u.id);await due(u.id);const sentBefore=sentTo(g.email).length;assert.deepEqual(await worker().drain(u.id),[],'nothing is dispatched to the guardian while suspended');assert.equal(sentTo(g.email).length,sentBefore);
 // reactivation
 assert.equal((await act(u.id+'/reactivate')).status,200);
 assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref})).status,403,'the link issued before the suspension stays dead after reactivation');
 assert.equal((await request('/patients/me/guardian-notifications',u.token)).status,401,'the old patient token stays dead');
 // the relationship is the patient\'s own consent, which an admin never touches, so it is eligible again; only the old link, session and tokens are gone
 assert.equal((await admin.query('SELECT status FROM guardian_relationships WHERE id=$1',[g.id])).rows[0].status,'ACTIVE');assert.equal(await eligible(u.id),1);
 const fresh=await security.login(u.id,fixtureHash);assert.ok(fresh);assert.equal((await request('/patients/me/guardian-notifications',await tokens.issue(u.id,fresh.sessionId))).status,200);
 assert.equal((await request('/guardian-notifications/reports',undefined,{token:ref})).status,403,'signing in again does not revive the old link');
});

// ---- Phase R6: CFG-06 (no clinical approval through Admin or the application) and CFG-07 (indeterminate, never reassuring).
async function configAdmin(role='config_admin'){
 const pw='Synthetic admin passphrase 731!',email=randomUUID()+'@example.invalid';await createAdminAccount(admin,p=>createPasswordService(auth).hash(p),{email,fullName:'Synthetic Admin',role,password:pw});
 const login=await fetch(base+'/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pw})});assert.equal(login.status,200);
 const token=((await login.json()) as {access_token:string}).access_token;
 return (path:string,body?:unknown)=>fetch(base+'/admin'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json() as any}));
}
const allRuleRows=()=>admin.query('SELECT id,version,definition_sha256,approval_status FROM guardian_serious_rules ORDER BY id,version').then(r=>r.rows);
const REASSURING=/\b(normal|healthy|reassur\w*|all clear|nothing to worry|no concern|within (?:the )?(?:normal|reference|healthy) range|safe)\b/i;

test('R6-06 admin rule edits and approval-like requests change nothing that decides an alert (CFG-06)',async()=>{
 const adm=await configAdmin(),before=await allRuleRows();
 const loose={field:'DEMO_MARKER',units:'demo_units',operator:'gt',bounds:[1],context:{}};
 const created=await adm('/rules',{rule_id:'ADMIN_EDIT_ATTEMPT',definition:loose});assert.equal(created.status,201);assert.equal(created.data.rule.clinical_approval,'not_clinically_approved');
 const second=await adm('/rules',{rule_id:'ADMIN_EDIT_ATTEMPT',definition:{...loose,bounds:[0]}});assert.equal(second.data.rule.version,2);assert.equal(second.data.rule.clinical_approval,'not_clinically_approved');
 // same rule name as the live demo rule, lower threshold: still no effect on what the worker evaluates
 assert.equal((await adm('/rules',{rule_id:demoRule.id,definition:loose})).status,201);
 for(const body of [{rule_id:'ADMIN_X_RULE',definition:loose,clinical_approval:'clinically_approved'},{rule_id:'ADMIN_X_RULE',definition:loose,approved:true},{rule_id:'ADMIN_X_RULE',definition:{...loose,status:'clinically_approved'}},
  {rule_id:'ADMIN_X_RULE',definition:{...loose,approval_status:'clinically_approved'}},{rule_id:'ADMIN_X_RULE',definition:{...loose,clinically_validated:true}},{rule_id:'ADMIN_X_RULE',definition:loose,reviewed_by:'Dr X'},{rule_id:'ADMIN_X_RULE',definition:{...loose,signed_off:true}}]){
  const r=await adm('/rules',body);assert.equal(r.status,403,JSON.stringify(body).slice(0,80));assert.equal(r.data.error.code,'CLINICAL_APPROVAL_FORBIDDEN');
 }
 assert.equal((await admin.query("SELECT count(*)::int n FROM admin_serious_rule_versions WHERE rule_id='ADMIN_X_RULE'")).rows[0].n,0,'refused attempts store nothing');
 assert.ok((await admin.query("SELECT count(*)::int n FROM admin_audit_events WHERE action='admin.rules.create' AND outcome='denied' AND scope->>'reason'='clinical_approval_not_permitted'")).rows[0].n>=7,'each approval attempt is audited as denied');
 assert.deepEqual(await allRuleRows(),before,'the table the worker reads is untouched by Admin');
 assert.equal((await admin.query("SELECT count(*)::int n FROM admin_serious_rule_versions WHERE clinical_approval<>'not_clinically_approved'")).rows[0].n,0);
 for(const sql of ["UPDATE admin_serious_rule_versions SET clinical_approval='clinically_approved'","UPDATE admin_serious_rule_versions SET definition='{}'","DELETE FROM admin_serious_rule_versions","TRUNCATE admin_serious_rule_versions"])
  await assert.rejects(admin.query(sql),`append-only even for the owner: ${sql}`);
 await assert.rejects(admin.query("INSERT INTO admin_serious_rule_versions(rule_id,version,definition,created_by,clinical_approval) VALUES('ADMIN_Z_RULE',1,'{}',(SELECT id FROM admin_accounts LIMIT 1),'clinically_approved')"),'the approval value cannot be supplied');
 // behaviour: a value that the loose admin version would flag does not alert, because only the configured demo rule runs
 const u=await user(),g=await guardian(u);await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: 5 demo_units');await worker().scan(u.id);
 const results=(await admin.query('SELECT rule_id,rule_version,outcome FROM guardian_rule_results WHERE patient_id=$1',[u.id])).rows;assert.deepEqual(results.map(r=>[r.rule_id,r.rule_version,r.outcome]),[[demoRule.id,'1','NOT_TRIGGERED']]);
 assert.equal((await jobRows(u.id)).filter(j=>j.kind==='serious_alert').length,0);assert.equal(sentTo(g.email).length,0);
});

test('R6-07 the application database role can never record a clinical approval; a non-demo row cannot make a rule run (CFG-06)',async()=>{
 const meta={qualified_approver:'Synthetic Reviewer',approval_reference:'SYN-1'},digest='a'.repeat(64);
 for(const status of ['clinically_approved','pending_review'])
  await assert.rejects(db.query(`INSERT INTO guardian_serious_rules(id,version,definition,definition_sha256,approval_status,approval_metadata) VALUES($1,'1','{}',$2,$3,$4)`,['R6_ROLE_'+status.toUpperCase(),digest,status,meta]),(e:any)=>e.code==='42501',status);
 await db.query(`INSERT INTO guardian_serious_rules(id,version,definition,definition_sha256,approval_status,approval_metadata) VALUES('R6_ROLE_DEMO','1','{}',$1,'non_clinical_demo','{}')`,[digest]);
 await assert.rejects(db.query("UPDATE guardian_serious_rules SET approval_status='clinically_approved'"),(e:any)=>e.code==='42501');
 await assert.rejects(db.query("DELETE FROM guardian_serious_rules"),(e:any)=>e.code==='42501');
 // a clinical-approval row planted by the database owner (outside the application) still cannot start an alert:
 const planted={...demoRule,id:'PLANTED_CLINICAL_RULE'};
 await admin.query(`INSERT INTO guardian_serious_rules(id,version,definition,definition_sha256,approval_status,approval_metadata) VALUES($1,$2,$3,$4,'clinically_approved',$5)`,[planted.id,planted.version,planted,notificationDigest(JSON.stringify(planted)),meta]);
 const u=await user(),g=await guardian(u);await document(u,'DEMO_MARKER: 11 demo_units');
 await assert.rejects(worker(settings,[planted]).scan(u.id),/Rule version conflict/);
 assert.equal((await admin.query("SELECT count(*)::int n FROM guardian_rule_results WHERE rule_id='PLANTED_CLINICAL_RULE'")).rows[0].n,0);assert.equal((await jobRows(u.id)).length,0);assert.equal(sentTo(g.email).length,0);
 assert.deepEqual(await worker().drain(u.id),[]);
 // the configured rule list itself is restricted to the invented demo marker
 for(const bad of [{...demoRule,field:'Glucose'},{...demoRule,units:'mg/dL'},{...demoRule,approval:{status:'clinically_approved',notice:'x'}},{...demoRule,id:'lowercase'}])assert.throws(()=>worker(settings,[bad as never]));
});

test('R6-08 anything uninterpretable is INDETERMINATE and says so; it is never a trigger, never normal and never reassuring (CFG-07)',async()=>{
 const hostile:Record<string,string>={
  'comma decimal':'DEMO_MARKER: 11,5 demo_units','scientific notation':'DEMO_MARKER: 1e3 demo_units','qualifier after unit':'DEMO_MARKER: 11 demo_units approx','less-than value':'DEMO_MARKER: <5 demo_units','range value':'DEMO_MARKER: 10-12 demo_units',
  'lower-case field':'demo_marker: 11 demo_units','space before colon':'DEMO_MARKER : 11 demo_units','no unit':'DEMO_MARKER: 11','upper-case unit':'DEMO_MARKER: 11 DEMO_UNITS','wrong unit':'DEMO_MARKER: 11 mg/dL',
  'arabic-indic digits':'DEMO_MARKER: ٣٣ demo_units','full-width digits':'DEMO_MARKER: １１ demo_units','conflicting duplicates':'DEMO_MARKER: 5 demo_units\nDEMO_MARKER: 11 demo_units','identical duplicates':'DEMO_MARKER: 11 demo_units\nDEMO_MARKER: 11 demo_units',
  'unreadable value':'DEMO_MARKER: ??? demo_units','dash only':'DEMO_MARKER: -','plus sign':'DEMO_MARKER: +11 demo_units','trailing dot':'DEMO_MARKER: 11. demo_units','out of supported range':'DEMO_MARKER: 99999999 demo_units','embedded in a sentence':'Note that DEMO_MARKER: 11 demo_units was seen',
  'zero-width character':'DEMO_MARKER: 11 demo_units​','two values on one line':'DEMO_MARKER: 5 demo_units 11 demo_units','empty':'','unrelated text':'Glucose: 90 mg/dL',
 };
 for(const [name,text] of Object.entries(hostile)){const r=evaluateDemoRule(demoRule,text,'pdf_text');assert.equal(r.outcome,'INDETERMINATE',name);assert.equal(r.value,null,name);assert.equal(r.unit,null,name);assert.match(r.explanation,/could not be evaluated reliably\. No serious trigger or reassuring conclusion is inferred\./,name);assert.ok(!REASSURING.test(r.explanation)||/reassuring conclusion is inferred/.test(r.explanation),name);}
 assert.equal(evaluateDemoRule(demoRule,'DEMO_MARKER: 11 demo_units','ocr').outcome,'INDETERMINATE','unverified OCR is never trusted');assert.equal(evaluateDemoRule(demoRule,'DEMO_MARKER: 11 demo_units','image').reason,'unverified_ocr');
 assert.equal(evaluateDemoRule(demoRule,'DEMO_MARKER: 11 demo_units','').outcome,'INDETERMINATE','unknown extraction method');
 const ctx={...demoRule,context:{DEMO_CONTEXT:'fixture'}};
 for(const [name,text] of Object.entries({'context missing':'DEMO_MARKER: 11 demo_units','context different':'DEMO_MARKER: 11 demo_units\nDEMO_CONTEXT: other','context duplicated':'DEMO_MARKER: 11 demo_units\nDEMO_CONTEXT: fixture\nDEMO_CONTEXT: fixture'}))assert.equal(evaluateDemoRule(ctx,text,'pdf_text').outcome,'INDETERMINATE',name);
 assert.equal(evaluateDemoRule(ctx,'DEMO_MARKER: 11 demo_units\nDEMO_CONTEXT: fixture','pdf_text').outcome,'TRIGGERED','a clear, complete value still triggers');
 assert.equal(evaluateDemoRule(demoRule,'  DEMO_MARKER: 10 demo_units  \r\n','pdf_text').outcome,'NOT_TRIGGERED');
 const quiet=evaluateDemoRule(demoRule,'DEMO_MARKER: 3 demo_units','pdf_text');assert.equal(quiet.outcome,'NOT_TRIGGERED');assert.ok(!REASSURING.test(quiet.explanation.replace(/not a clinical assessment or reassurance/i,'')),'even a clear non-trigger makes no reassuring claim');assert.match(quiet.explanation,/not a clinical assessment or reassurance/);
 // end to end: stored, visible to the patient as INDETERMINATE with the explicit wording, and nothing is sent
 const u=await user(),g=await guardian(u);
 for(const text of ['DEMO_MARKER: 11,5 demo_units','DEMO_MARKER: 5 demo_units\nDEMO_MARKER: 11 demo_units','DEMO_MARKER: ??? demo_units','Glucose: 90 mg/dL'])await document(u,text);
 await document(u,'DEMO_MARKER: 11 demo_units',true,'ocr');
 await worker().scan(u.id);
 const rows=(await admin.query('SELECT outcome,result FROM guardian_rule_results WHERE patient_id=$1',[u.id])).rows;assert.equal(rows.length,5);assert.ok(rows.every(r=>r.outcome==='INDETERMINATE'&&r.result.value===null));
 const seen=await request('/patients/me/guardian-notifications',u.token);assert.equal(seen.status,200);
 assert.equal(seen.data.evaluations.length,5);assert.ok(seen.data.evaluations.every((e:any)=>e.outcome==='INDETERMINATE'&&/No serious trigger or reassuring conclusion is inferred/.test(e.result.explanation)));
 assert.ok(!REASSURING.test(JSON.stringify(seen.data).replace(/No serious trigger or reassuring conclusion is inferred/g,'')),'no reassuring word anywhere in what the patient sees');
 assert.equal((await jobRows(u.id)).length,0);assert.deepEqual(await worker().drain(u.id),[]);assert.equal(sentTo(g.email).length,0);
 assert.equal((await admin.query("SELECT count(*)::int n FROM guardian_medical_events WHERE patient_id=$1 AND event IN ('serious_queued','delivered')",[u.id])).rows[0].n,0);
});

test('R6-09 the indeterminate policy cannot be switched to outbound messaging; a mixed document alerts only on the clear value (CFG-07)',async()=>{
 const key=randomBytes(32);
 assert.equal(guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline'},key)!.indeterminate,'persist_only','default never sends');
 assert.equal(guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline',GUARDIAN_INDETERMINATE_POLICY:'blocked_pending_approval'},key)!.indeterminate,'blocked_pending_approval');
 for(const policy of ['send_alert','send_generic_alert','notify','reassure','normal','','PERSIST_ONLY','persist_only '])assert.throws(()=>guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline',GUARDIAN_INDETERMINATE_POLICY:policy},key),/not approved/,JSON.stringify(policy));
 for(const c of [{GUARDIAN_NOTIFICATIONS_MODE:'live'},{GUARDIAN_NOTIFICATIONS_MODE:'production'},{GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline',GUARDIAN_NOTIFICATIONS_ORIGIN:'https://guardian.example.com'},{GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline',GUARDIAN_NOTIFICATIONS_ORIGIN:'http://guardian.example.invalid'}])assert.throws(()=>guardianNotificationConfig(c,key));
 assert.throws(()=>guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline'}),'needs a reference key');
 // both policies behave identically at runtime: no outbound message for an indeterminate result
 for(const indeterminate of ['persist_only','blocked_pending_approval'] as const){
  const u=await user(),g=await guardian(u),config={...settings,indeterminate};await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: ?? demo_units');
  await worker(config).scan(u.id);assert.equal((await jobRows(u.id)).length,0,indeterminate);assert.deepEqual(await worker(config).drain(u.id),[]);assert.equal(sentTo(g.email).length,0,indeterminate);
  assert.equal((await reader.observe(u.id)).evaluations[0].outcome,'INDETERMINATE');
 }
 // one clear document is not weakened by an unclear neighbour, and the unclear one is not turned into an alert
 const u=await user(),g=await guardian(u);await document(u,'DEMO_MARKER: ??? demo_units');await document(u,'DEMO_MARKER: 11 demo_units');await worker().scan(u.id);
 const alerts=(await jobRows(u.id)).filter(j=>j.kind==='serious_alert');assert.equal(alerts.length,1);assert.deepEqual(await worker().drain(u.id),['delivered']);
 const mail=sentTo(g.email);assert.equal(mail.length,1);assert.ok(mail[0].message.text.includes('11 demo_units'));assert.ok(!mail[0].message.text.includes('???'));assert.ok(!REASSURING.test(mail[0].message.text.replace(/does not diagnose, prescribe treatment or replace[^.]*\./i,'')));
});

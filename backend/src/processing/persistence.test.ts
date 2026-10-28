import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {test} from "node:test";
import type {PoolClient} from "pg";
import {pool,closeDatabasePool} from "../database/pool.js";
import type {PatientDatabase} from "../patients/repository.js";
import {createProcessingRepository,type Claim,type ProcessingJob} from "./repository.js";
import {createProcessingService} from "./service.js";
import {createProcessingWorker} from "./worker.js";
import type {ProcessingConfig} from "./config.js";
import {validateExtraction,type ExtractionResult,extractionLimits} from "./extraction.js";
import {InvalidExtractionResult,InvalidProcessingInput,ProcessingUnavailable} from "./errors.js";

const config:ProcessingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:1000,retryMaxMs:10000,recoveryBatchSize:10};
function result(text='Synthetic extraction fixture; no OCR or PDF extractor ran'):ExtractionResult{return {text,method:'ocr',extractor:{name:'synthetic-extractor',version:'test-1'},source:{sha256:'a'.repeat(64),pageCount:1,pages:[{page:1,method:'ocr',confidence:99}]}};}
const identity=(job:ProcessingJob):Claim=>({documentId:job.document_id,patientId:job.patient_id,token:job.lease_token!});

test('Phase 2.2C-A lease-fenced extraction persistence',{timeout:180000},async t=>{
 const patients:string[]=[],documents:string[]=[];
 async function fixture(active=true){
  const patientId=randomUUID(),documentId=randomUUID();patients.push(patientId);
  await pool.query(`INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic Persistence Patient')`,[patientId,patientId+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
  await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category)
   VALUES($1,$2,'synthetic-no-aws',$3,'synthetic.pdf','pdf','lab_report')`,[documentId,'synthetic-placeholder',documentId].map((v,i)=>i===1?patientId:v));documents.push(documentId);
  const repository=createProcessingRepository(pool,config,patientId),service=createProcessingService(repository);
  const claim=active?identity((await service.claim())!):{documentId,patientId,token:randomUUID()};
  const row=async()=>(await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=$1 AND patient_id=$2',[documentId,patientId])).rows[0];
  const job=async()=>(await pool.query<ProcessingJob>('SELECT * FROM public.document_processing_jobs WHERE document_id=$1 AND patient_id=$2',[documentId,patientId])).rows[0];
  const status=async()=>(await pool.query('SELECT processing_status FROM public.medical_documents WHERE id=$1 AND patient_id=$2',[documentId,patientId])).rows[0].processing_status;
  const expire=()=>pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE document_id=$1",[documentId]);
  const ready=()=>pool.query("UPDATE public.document_processing_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE document_id=$1",[documentId]);
  async function stage(c=claim,value=result()){
   const current=await job(),valid=validateExtraction(value);
   await pool.query(`INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status,source_metadata,extractor_version,processing_attempt,processing_claim_token)
     VALUES($1,$2,$3,'completed',$4::jsonb,$5,$6,$7)`,[documentId,patientId,valid.text,JSON.stringify(valid.metadata),valid.version,current.attempt_count,c.token]);
  }
  return {patientId,documentId,claim,repository,service,row,job,status,expire,ready,stage};
 }
 async function blocked(client:PoolClient){const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return pid;}
 async function waitForLock(pid:number){for(let n=0;n<100;n++){const row=(await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];if(row?.wait_event_type==='Lock')return;await delay(10);}throw new Error('Synthetic blocking operation did not reach expected lock');}
 try{
  await t.test('valid lease atomically persists validated evidence and completes both states',async()=>{
   const f=await fixture();assert.equal(await f.service.persistExtraction(f.claim,result()),true);const e=await f.row();
   assert.equal(e.extracted_text,result().text);assert.equal(e.patient_id,f.patientId);assert.equal(e.document_id,f.documentId);
   assert.equal(e.processing_attempt,1);assert.equal(e.processing_claim_token,f.claim.token);assert.equal(e.processing_status,'completed');
   assert.equal((await f.job()).state,'completed');assert.equal(await f.status(),'completed');assert.equal(await f.service.completedForClaim(f.claim),true);
  });
  await t.test('provenance, extractor version, pages and confidence round-trip exactly',async()=>{
   const f=await fixture();const value=result();value.method='mixed';value.extractor={name:'synthetic-poppler+tesseract',version:'fixture-1.2'};value.source.pageCount=2;value.source.pages=[{page:1,method:'pdf_text'},{page:2,method:'ocr',confidence:42.5}];
   await f.service.persistExtraction(f.claim,value);const e=await f.row();assert.deepEqual(e.source_metadata,validateExtraction(value).metadata);assert.equal(e.extractor_version,value.extractor.version);
  });
  await t.test('expired leases cannot insert or directly stage extraction evidence',async()=>{
   const f=await fixture();await f.expire();assert.equal(await f.service.persistExtraction(f.claim,result()),false);assert.equal(await f.row(),undefined);
   await assert.rejects(f.stage(),{code:'23514'});assert.equal((await f.job()).state,'running');
  });
  await t.test('expired attempt deadlines cannot persist extraction',async()=>{
   const f=await fixture();await pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()-interval '2 seconds',attempt_deadline_at=clock_timestamp()-interval '1 second' WHERE document_id=$1",[f.documentId]);
   assert.equal(await f.service.persistExtraction(f.claim,result()),false);assert.equal(await f.row(),undefined);
  });
  await t.test('replaced and forged tokens cannot persist or complete',async()=>{
   const f=await fixture();await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);
   assert.equal(await f.service.persistExtraction(f.claim,result()),false);assert.equal(await f.service.persistExtraction({...f.claim,token:randomUUID()},result()),false);assert.equal(await f.service.complete(f.claim),false);assert.equal(await f.row(),undefined);
  });
  await t.test('cross-patient, document and repository scopes deny writes',async()=>{
   const a=await fixture(),b=await fixture();
   for(const claim of [{...a.claim,patientId:b.patientId},{...a.claim,documentId:b.documentId},{...a.claim,token:b.claim.token}])assert.equal(await a.service.persistExtraction(claim,result()),false);
   assert.equal(await a.service.persistExtraction(b.claim,result()),false);assert.equal(await a.row(),undefined);assert.equal(await b.row(),undefined);
  });
  await t.test('pending, retry-wait and failed jobs cannot persist extraction',async()=>{
   const f=await fixture(false);assert.equal(await f.service.persistExtraction(f.claim,result()),false);const claim=identity((await f.service.claim())!);
   await f.service.fail(claim,'PROCESSOR_FAILED');assert.equal(await f.service.persistExtraction(claim,result()),false);
   await f.ready();const next=identity((await f.service.claim())!);await f.service.fail(next,'INVALID_INPUT',false);assert.equal(await f.service.persistExtraction(next,result()),false);
  });
  await t.test('duplicate calls never overwrite a completed attempt',async()=>{
   const f=await fixture();await f.service.persistExtraction(f.claim,result('Synthetic first'));const before=await f.row();
   assert.equal(await f.service.persistExtraction(f.claim,result('Synthetic replacement')),false);assert.deepEqual(await f.row(),before);
  });
  await t.test('concurrent writers have exactly one winner with coherent evidence',async()=>{
   const f=await fixture();const values=[result('Synthetic A'),result('Synthetic B'),result('Synthetic C')];const outcomes=await Promise.all(values.map(v=>f.service.persistExtraction(f.claim,v)));
   assert.equal(outcomes.filter(Boolean).length,1);assert.equal((await f.row()).extracted_text,values[outcomes.findIndex(Boolean)].text);assert.equal((await f.job()).state,'completed');
  });
  await t.test('direct writes without attempt association or provenance fail at the database',async()=>{
   const f=await fixture();await assert.rejects(pool.query("INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status) VALUES($1,$2,'Synthetic unfenced output','completed')",[f.documentId,f.patientId]),{code:'23514'});assert.equal(await f.row(),undefined);
  });
  await t.test('current extraction cannot be overwritten after completion even with SQL',async()=>{
   const f=await fixture();await f.service.persistExtraction(f.claim,result());const before=await f.row();
   await assert.rejects(pool.query("UPDATE public.extracted_medical_text SET extracted_text='Synthetic late write' WHERE document_id=$1",[f.documentId]),{code:'23514'});assert.deepEqual(await f.row(),before);
  });
  await t.test('job completion without valid current-attempt evidence is denied in SQL',async()=>{
   const f=await fixture();assert.equal(await f.service.complete(f.claim),false);
   await assert.rejects(pool.query("UPDATE public.document_processing_jobs SET state='completed',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL WHERE document_id=$1",[f.documentId]),{code:'23514'});assert.equal((await f.job()).state,'running');
  });
  await t.test('recovery invalidates an interrupted attempt and only its successor can replace evidence',async()=>{
   const f=await fixture();await f.stage();const original=await f.row();await f.expire();assert.equal(await f.service.recover(),1);await f.ready();const next=identity((await f.service.claim())!);
   assert.equal(await f.service.persistExtraction(f.claim,result('Synthetic stale')),false);await assert.rejects(pool.query("UPDATE public.extracted_medical_text SET extracted_text='Synthetic stale direct write' WHERE document_id=$1",[f.documentId]),{code:'23514'});
   assert.equal(await f.service.complete(next),false);assert.equal(await f.service.persistExtraction(next,result('Synthetic retry')),true);
   const updated=await f.row();assert.equal(updated.extracted_text,'Synthetic retry');assert.equal(updated.id,original.id);assert.deepEqual(updated.created_at,original.created_at);assert.equal(updated.processing_attempt,2);assert.equal(updated.processing_claim_token,next.token);
  });
  await t.test('failed extraction can retry without generating placeholder output',async()=>{
   const f=await fixture();assert.throws(()=>f.service.persistExtraction(f.claim,result('  ')),InvalidExtractionResult);assert.equal(await f.row(),undefined);
   await f.service.fail(f.claim,'PROCESSOR_FAILED');await f.ready();const next=identity((await f.service.claim())!);assert.equal(await f.service.persistExtraction(next,result()),true);assert.equal((await f.row()).processing_attempt,2);
  });
  await t.test('malformed or ownership-bearing results are rejected before SQL',async()=>{
   const f=await fixture();const base=result();const invalid:unknown[]=[null,{},[],{...base,text:''},{...base,text:'\0Synthetic'},{...base,text:'\ud800'},
    {...base,patientId:randomUUID()},{...base,documentId:randomUUID()},{...base,attempt:1},{...base,leaseToken:f.claim.token},
    {...base,method:'unknown'},{...base,extractor:{name:'synthetic\nprivate',version:'1'}},{...base,extractor:{name:'s',version:'x'.repeat(129)}},
    {...base,source:{...base.source,sha256:'bad'}},{...base,source:{...base.source,patientId:randomUUID()}},{...base,source:{...base.source,pages:[{page:2,method:'ocr'}]}},
    {...base,source:{...base.source,pages:[{page:1,method:'ocr',confidence:NaN}]}},{...base,source:{...base.source,pages:[{page:1,method:'ocr',confidence:101}]}},
    {...base,method:'mixed'},{...base,source:{...base.source,pageCount:201}}];
   for(const value of invalid)assert.throws(()=>f.service.persistExtraction(f.claim,value),InvalidExtractionResult);
   assert.equal(await f.row(),undefined);assert.equal((await f.job()).state,'running');
  });
  await t.test('text character and metadata limits are strict and bounded',async()=>{
   const f=await fixture();assert.throws(()=>f.service.persistExtraction(f.claim,result('x'.repeat(extractionLimits.textCharacters+1))),InvalidExtractionResult);
   const value=result();value.source.pageCount=200;value.source.pages=Array.from({length:200},(_,i)=>({page:i+1,method:'ocr',confidence:0.12345678901234568}));
   assert.throws(()=>f.service.persistExtraction(f.claim,value),InvalidExtractionResult);assert.equal(await f.row(),undefined);
  });
  await t.test('exact maximum text length can persist without truncation',async()=>{
   const f=await fixture();const text='x'.repeat(extractionLimits.textCharacters);assert.equal(await f.service.persistExtraction(f.claim,result(text)),true);assert.equal((await f.row()).extracted_text.length,text.length);
  });
  await t.test('Unicode text and SQL-looking content remain literal parameter data',async()=>{
   const f=await fixture();const text="Synthetic صحت 🧪\n'; DROP TABLE public.patients; --";assert.equal(await f.service.persistExtraction(f.claim,result(text)),true);assert.equal((await f.row()).extracted_text,text);
  });
  await t.test('database payload validation rejects forged provenance and metadata overflow',async()=>{
   const f=await fixture();const value=validateExtraction(result());for(const metadata of [{...value.metadata,method:null},{...value.metadata,source:{sha256:'a'.repeat(64),pageCount:1,pages:[{page:1,method:null}]}},{...value.metadata,extra:'x'.repeat(17000)}]){
    await assert.rejects(pool.query('SELECT public.persist_document_extraction($1,$2,$3,$4,$5::jsonb,$6)',[f.documentId,f.patientId,f.claim.token,value.text,JSON.stringify(metadata),value.version]),{code:'23514'});
   }assert.equal(await f.row(),undefined);assert.equal((await f.job()).state,'running');
  });
  await t.test('completion synchronization failure rolls back extraction and job changes',async()=>{
   const f=await fixture();const locker=await pool.connect(),actor=await pool.connect();
   try{await locker.query('BEGIN');await locker.query('SELECT id FROM public.medical_documents WHERE id=$1 FOR NO KEY UPDATE',[f.documentId]);await actor.query("SET statement_timeout='200ms'");
    const service=createProcessingService(createProcessingRepository(actor,config,f.patientId));await assert.rejects(service.persistExtraction(f.claim,result()),ProcessingUnavailable);
    assert.equal(await f.row(),undefined);assert.equal((await f.job()).state,'running');assert.equal(await f.status(),'processing');
   }finally{await locker.query('ROLLBACK');await actor.query('RESET statement_timeout');locker.release();actor.release();}
   assert.equal(await f.service.persistExtraction(f.claim,result()),true);
  });
  await t.test('expiry during document synchronization rolls back already-written extraction',async()=>{
   const f=await fixture();await pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE document_id=$1",[f.documentId]);
   const locker=await pool.connect(),actor=await pool.connect();const pid=await blocked(actor);let operation:Promise<boolean>|undefined;
   try{await locker.query('BEGIN');await locker.query('SELECT id FROM public.medical_documents WHERE id=$1 FOR NO KEY UPDATE',[f.documentId]);
    const service=createProcessingService(createProcessingRepository(actor,config,f.patientId));operation=service.persistExtraction(f.claim,result());void operation.catch(()=>{});
    await waitForLock(pid);assert.equal(await f.row(),undefined);await delay(1100);assert.equal(await f.service.recover(),0);await locker.query('COMMIT');
    await assert.rejects(operation,ProcessingUnavailable);assert.equal(await f.row(),undefined);assert.equal((await f.job()).state,'running');
   }finally{await locker.query('ROLLBACK');if(operation)await operation.catch(()=>false);locker.release();actor.release();}
   assert.equal(await f.service.recover(),1);
  });
  await t.test('claims are rechecked after waiting on a replaced-token row lock',async()=>{
   const f=await fixture();const locker=await pool.connect(),actor=await pool.connect();const pid=await blocked(actor);let operation:Promise<boolean>|undefined;
   try{await locker.query('BEGIN');await locker.query('SELECT document_id FROM public.document_processing_jobs WHERE document_id=$1 FOR UPDATE',[f.documentId]);
    const service=createProcessingService(createProcessingRepository(actor,config,f.patientId));operation=service.persistExtraction(f.claim,result());await waitForLock(pid);
    await locker.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);await locker.query('COMMIT');assert.equal(await operation,false);assert.equal(await f.row(),undefined);
   }finally{await locker.query('ROLLBACK');if(operation)await operation.catch(()=>false);locker.release();actor.release();}
  });
  await t.test('concurrent failure and persistence never commit contradictory states',async()=>{
   const f=await fixture();const[saved,failed]=await Promise.all([f.service.persistExtraction(f.claim,result()),f.service.fail(f.claim,'PROCESSOR_FAILED')]);assert.notEqual(saved,failed);
   const e=await f.row(),j=await f.job();if(saved){assert.ok(e);assert.equal(j.state,'completed');assert.equal(await f.status(),'completed');}else{assert.equal(e,undefined);assert.equal(j.state,'retry_wait');assert.equal(await f.status(),'failed');}
  });
  await t.test('worker persists a synthetic result through its claim-bound integration',async()=>{
   const f=await fixture(false);const worker=createProcessingWorker(f.service,config,async({persistExtraction})=>{await persistExtraction(result());});assert.equal(await worker.runOnce(),'completed');assert.equal((await f.row()).processing_attempt,1);
  });
  await t.test('worker composes withOriginal result consumption and atomic persistence',async()=>{
   const f=await fixture(false);const originals={async withOriginal<T>(_claim:Claim,_signal:AbortSignal,use:(input:{path:string;type:'pdf';bytes:number;assertActive:()=>Promise<void>})=>Promise<T>){return use({path:'synthetic-unread-path',type:'pdf',bytes:1,assertActive:async()=>{}});}};
   const worker=createProcessingWorker(f.service,config,async({withOriginal,persistExtraction})=>{const output=await withOriginal(async()=>result());await persistExtraction(output);},originals);
   assert.equal(await worker.runOnce(),'completed');assert.ok(await f.row());
  });
  await t.test('worker reconciles a lost persistence acknowledgement without undoing completion',async()=>{
   const f=await fixture(false);const service={...f.service,persistExtraction:async(c:Claim,input:unknown)=>{await f.service.persistExtraction(c,input);throw new ProcessingUnavailable();}};
   assert.equal(await createProcessingWorker(service,config,async({persistExtraction})=>{await persistExtraction(result());}).runOnce(),'completed');assert.equal((await f.job()).state,'completed');assert.ok(await f.row());
  });
  await t.test('cancellation after a committed persistence result preserves successful completion',async()=>{
   const f=await fixture(false);const controller=new AbortController();const service={...f.service,persistExtraction:async(c:Claim,input:unknown)=>{const saved=await f.service.persistExtraction(c,input);controller.abort();return saved;}};
   assert.equal(await createProcessingWorker(service,config,async({persistExtraction})=>{await persistExtraction(result());}).runOnce(controller.signal),'completed');assert.equal((await f.job()).state,'completed');assert.ok(await f.row());
  });
  await t.test('late worker calls and invalid results never produce completion',async()=>{
   const f=await fixture(false);let persist:((input:ExtractionResult)=>Promise<void>)|undefined;
   assert.equal(await createProcessingWorker(f.service,config,async context=>{persist=context.persistExtraction;}).runOnce(),'failed');await assert.rejects(persist!(result()),InvalidProcessingInput);assert.equal(await f.row(),undefined);
   const other=await fixture(false);assert.equal(await createProcessingWorker(other.service,config,async({persistExtraction})=>{await persistExtraction(result(''));}).runOnce(),'failed');assert.equal(await other.row(),undefined);
  });
  await t.test('database failures expose no text, provenance or SQL details',async()=>{
   const database:PatientDatabase={async query(){throw new Error('synthetic-sensitive-sql-detail');}};const service=createProcessingService(createProcessingRepository(database,config));const claim={documentId:randomUUID(),patientId:randomUUID(),token:randomUUID()};
   await assert.rejects(service.persistExtraction(claim,result()),e=>e instanceof ProcessingUnavailable&&!e.message.includes('sensitive')&&!e.message.includes(result().text));
  });
  await t.test('runtime retains restricted privileges and functions are invoker-only with no public grant',async()=>{
   const functions=(await pool.query(`SELECT p.proname,p.prosecdef,pg_get_userbyid(p.proowner) AS owner,
     EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
     FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[])`,[['valid_extraction_payload','fence_extraction_write','fence_extraction_completion','persist_document_extraction']])).rows;
   assert.equal(functions.length,4);for(const f of functions){assert.equal(f.prosecdef,false);assert.equal(f.owner,'health_wallet_migrator');assert.equal(f.public_execute,false);}
   assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role,'health_wallet_app');
  });
 }finally{
  try{await pool.query('DELETE FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);}
  finally{await closeDatabasePool();}
 }
});

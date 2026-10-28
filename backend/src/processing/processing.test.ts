import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {test} from "node:test";
import {pool,closeDatabasePool} from "../database/pool.js";
import type {PatientDatabase} from "../patients/repository.js";
import {createProcessingRepository,type ProcessingJob,type Claim} from "./repository.js";
import {createProcessingService} from "./service.js";
import {createProcessingWorker} from "./worker.js";
import {getProcessingConfig,type ProcessingConfig,ProcessingConfigurationError} from "./config.js";
import {ProcessorFailure,ProcessingUnavailable,InvalidProcessingInput} from "./errors.js";

const config:ProcessingConfig={maxAttempts:3,leaseMs:1000,attemptTimeoutMs:5000,heartbeatMs:50,retryBaseMs:10,retryMaxMs:40,recoveryBatchSize:2};
const claimOf=(job:ProcessingJob):Claim=>({documentId:job.document_id,patientId:job.patient_id,token:job.lease_token!});

test("Phase 2.2A document processing lifecycle",{timeout:120000},async t=>{
  const patients:string[]=[];const documents:string[]=[];
  async function fixture(overrides:Partial<ProcessingConfig>={}){
    const patientId=randomUUID();patients.push(patientId);
    await pool.query(`INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic Lifecycle Patient')`,
      [patientId,patientId+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
    const settings={...config,...overrides};
    const repository=createProcessingRepository(pool,settings,patientId);
    const service=createProcessingService(repository);
    async function document(status='processing'){
      const id=randomUUID();
      await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,processing_status)
        VALUES($1,$2,'synthetic-lifecycle-bucket',$3,'synthetic.pdf','pdf','lab_report',$4)`,[id,patientId,'synthetic/'+id,status]);
      documents.push(id);return id;
    }
    async function job(id:string){return(await pool.query<ProcessingJob>('SELECT * FROM public.document_processing_jobs WHERE document_id=$1 AND patient_id=$2',[id,patientId])).rows[0];}
    async function ready(id:string){await pool.query("UPDATE public.document_processing_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE document_id=$1 AND patient_id=$2",[id,patientId]);}
    async function expire(id:string){await pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE document_id=$1 AND patient_id=$2",[id,patientId]);}
    async function extraction(id:string){const current=await job(id);await pool.query(`INSERT INTO public.extracted_medical_text
      (document_id,patient_id,extracted_text,processing_status,extractor_version,source_metadata,processing_attempt,processing_claim_token)
      VALUES($1,$2,'Synthetic fixture output; no OCR performed','completed','synthetic-test-only',$3::jsonb,$4,$5)`,
      [id,patientId,JSON.stringify({schemaVersion:1,method:'ocr',extractor:{name:'synthetic-fixture',version:'synthetic-test-only'},source:{sha256:'0'.repeat(64),pageCount:1,pages:[{page:1,method:'ocr'}]}}),current.attempt_count,current.lease_token]);}
    async function status(id:string){return(await pool.query('SELECT processing_status FROM public.medical_documents WHERE id=$1 AND patient_id=$2',[id,patientId])).rows[0].processing_status;}
    return {patientId,settings,repository,service,document,job,ready,expire,extraction,status};
  }
  try{
    await t.test('new uploads enqueue one pending job atomically without extraction',async()=>{
      const f=await fixture();const id=await f.document();const j=await f.job(id);
      assert.equal(j.state,'pending');assert.equal(j.attempt_count,0);assert.equal(j.patient_id,f.patientId);assert.equal(j.lease_token,null);
      assert.equal(await f.status(id),'processing');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.extracted_medical_text WHERE document_id=$1',[id])).rows[0].n,0);
      await assert.rejects(pool.query('INSERT INTO public.document_processing_jobs(document_id,patient_id) VALUES($1,$2)',[id,f.patientId]),{code:'23505'});
    });
    await t.test('pending discovery is deterministic, bounded and owner-scoped',async()=>{
      const a=await fixture(),b=await fixture();const first=await a.document();await a.document();await b.document();
      assert.equal((await a.service.discover(1))[0].document_id,first);
      assert.equal((await a.service.discover()).length,2);assert.equal((await b.service.discover()).length,1);
      assert.ok((await a.service.discover()).every(j=>j.patient_id===a.patientId));
    });
    await t.test('completed and failed legacy documents are not automatically enqueued',async()=>{
      const f=await fixture();assert.equal(await f.job(await f.document('completed')),undefined);
      assert.equal(await f.job(await f.document('failed')),undefined);assert.equal((await f.service.discover()).length,0);
    });
    await t.test('concurrent instances claim distinct documents exactly once',async()=>{
      const f=await fixture();for(let i=0;i<6;i++)await f.document();
      const claims=await Promise.all(Array.from({length:12},()=>createProcessingService(createProcessingRepository(pool,f.settings,f.patientId)).claim()));
      const claimed=claims.filter((j):j is ProcessingJob=>!!j);
      assert.equal(claimed.length,6);assert.equal(new Set(claimed.map(j=>j.document_id)).size,6);
      assert.equal(new Set(claimed.map(j=>j.lease_token)).size,6);assert.ok(claimed.every(j=>j.attempt_count===1&&j.state==='running'));
    });
    await t.test('claim skips a row locked by another database session',async()=>{
      const f=await fixture();const first=await f.document(),second=await f.document();const client=await pool.connect();
      try{await client.query('BEGIN');await client.query('SELECT document_id FROM public.document_processing_jobs WHERE document_id=$1 FOR UPDATE',[first]);
        assert.equal((await f.service.claim())?.document_id,second);
      }finally{await client.query('ROLLBACK');client.release();}
    });
    await t.test('claim commits before processor work and retains owner and original reference',async()=>{
      const f=await fixture();const id=await f.document();const j=(await f.service.claim())!;
      assert.equal(j.patient_id,f.patientId);assert.equal((await f.job(id)).state,'running');
      const original=(await pool.query('SELECT s3_bucket,s3_object_key,uploaded_at FROM public.medical_documents WHERE id=$1',[id])).rows[0];
      assert.equal(original.s3_object_key,'synthetic/'+id);assert.equal(await f.status(id),'processing');
    });
    await t.test('no duplicate claim while an unexpired lease is active',async()=>{
      const f=await fixture();await f.document();assert.ok(await f.service.claim());
      assert.equal(await f.service.claim(),undefined);assert.equal((await f.service.discover()).length,0);
    });
    await t.test('completion without a completed extraction is refused',async()=>{
      const f=await fixture();const id=await f.document();const c=claimOf((await f.service.claim())!);
      assert.equal(await f.service.complete(c),false);assert.equal((await f.job(id)).state,'running');assert.equal(await f.status(id),'processing');
    });
    await t.test('a valid extraction permits atomic completion and terminal state cannot be replayed',async()=>{
      const f=await fixture();const id=await f.document();const c=claimOf((await f.service.claim())!);await f.extraction(id);
      assert.equal(await f.service.complete(c),true);assert.equal((await f.job(id)).state,'completed');assert.equal(await f.status(id),'completed');
      assert.equal(await f.service.complete(c),false);assert.equal(await f.service.fail(c,'PROCESSOR_FAILED'),false);
      assert.equal(await f.service.heartbeat(c),false);assert.equal(await f.service.claim(),undefined);
    });
    await t.test('foreign patient, document and lease tokens cannot mutate a claim',async()=>{
      const f=await fixture(),other=await fixture();const id=await f.document();const foreignId=await other.document();const c=claimOf((await f.service.claim())!);
      for(const bad of [{...c,patientId:other.patientId},{...c,documentId:foreignId},{...c,token:randomUUID()}]){
        assert.equal(await f.service.complete(bad),false);assert.equal(await f.service.fail(bad,'PROCESSOR_FAILED'),false);assert.equal(await f.service.heartbeat(bad),false);
      }
      assert.equal((await f.job(id)).state,'running');
    });
    await t.test('composite foreign key and immutable job identity prevent owner reassignment',async()=>{
      const a=await fixture(),b=await fixture();const id=await a.document();const other=await b.document();
      await assert.rejects(pool.query('UPDATE public.document_processing_jobs SET patient_id=$1 WHERE document_id=$2',[b.patientId,id]),{code:'23514'});
      await assert.rejects(pool.query('UPDATE public.document_processing_jobs SET document_id=$1,patient_id=$2 WHERE document_id=$3',[other,b.patientId,id]),{code:'23514'});
      const absent=randomUUID();await assert.rejects(pool.query('INSERT INTO public.document_processing_jobs(document_id,patient_id) VALUES($1,$2)',[absent,a.patientId]),{code:'23503'});
    });
    await t.test('retryable failure persists failed public state and bounded exponential schedule',async()=>{
      const f=await fixture({retryBaseMs:10000,retryMaxMs:20000});const id=await f.document();const c=claimOf((await f.service.claim())!);
      const before=Date.now();assert.equal(await f.service.fail(c,'PROCESSOR_FAILED'),true);const j=await f.job(id);
      assert.equal(j.state,'retry_wait');assert.equal(j.last_error_code,'PROCESSOR_FAILED');assert.equal(j.lease_token,null);
      assert.ok(j.next_attempt_at.getTime()>=before+9900);assert.equal(await f.status(id),'failed');assert.equal(await f.service.claim(),undefined);
      await f.ready(id);const next=(await f.service.claim())!;assert.equal(next.attempt_count,2);assert.notEqual(next.lease_token,c.token);assert.equal(await f.status(id),'processing');
      await f.service.fail(claimOf(next),'PROCESSOR_FAILED');assert.ok((await f.job(id)).next_attempt_at.getTime()>=Date.now()+19000);
    });
    await t.test('retry exhaustion is terminal and cannot reset attempt count through service',async()=>{
      const f=await fixture({maxAttempts:2});const id=await f.document();
      for(let i=1;i<=2;i++){const j=(await f.service.claim())!;assert.equal(j.attempt_count,i);await f.service.fail(claimOf(j),'PROCESSOR_FAILED');await f.ready(id);}
      assert.equal((await f.job(id)).state,'failed');assert.equal((await f.job(id)).attempt_count,2);
      assert.equal(await f.service.claim(),undefined);assert.equal(await f.status(id),'failed');
    });
    await t.test('nonretryable processor failure becomes terminal immediately',async()=>{
      const f=await fixture();const id=await f.document();const j=(await f.service.claim())!;
      await f.service.fail(claimOf(j),'INVALID_INPUT',false);assert.equal((await f.job(id)).state,'failed');assert.equal(await f.service.claim(),undefined);
    });
    await t.test('expired worker cannot heartbeat, complete or fail before recovery',async()=>{
      const f=await fixture();const id=await f.document();const c=claimOf((await f.service.claim())!);await f.extraction(id);await f.expire(id);
      assert.equal(await f.service.heartbeat(c),false);assert.equal(await f.service.complete(c),false);assert.equal(await f.service.fail(c,'PROCESSOR_FAILED'),false);
    });
    await t.test('interrupted-worker recovery schedules a retry and fences the old token',async()=>{
      const f=await fixture();const id=await f.document();const c=claimOf((await f.service.claim())!);await f.expire(id);
      assert.equal(await f.service.recover(),1);assert.equal(await f.status(id),'failed');const recovered=await f.job(id);
      assert.equal(recovered.state,'retry_wait');assert.equal(recovered.last_error_code,'LEASE_EXPIRED');assert.equal(recovered.attempt_count,1);
      await f.ready(id);const next=(await f.service.claim())!;
      assert.notEqual(next.lease_token,c.token);assert.equal(next.attempt_count,2);assert.equal(await f.service.fail(c,'INTERRUPTED'),false);
    });
    await t.test('an extraction from an earlier attempt cannot prove current completion',async()=>{
      const f=await fixture();const id=await f.document();const old=(await f.service.claim())!;await f.extraction(id);
      await f.service.fail(claimOf(old),'PROCESSOR_FAILED');await f.ready(id);const current=(await f.service.claim())!;
      assert.equal(await f.service.complete(claimOf(current)),false);assert.equal((await f.job(id)).state,'running');
    });
    await t.test('recovery is batch-bounded, concurrent-safe, and respects final attempt',async()=>{
      const f=await fixture({maxAttempts:1});const ids=[];for(let i=0;i<5;i++){const id=await f.document();ids.push(id);await f.service.claim();await f.expire(id);}
      const results=await Promise.all([f.service.recover(),f.service.recover()]);assert.ok(results.every(n=>n<=2));assert.equal(results.reduce((a,b)=>a+b,0),4);
      assert.equal(await f.service.recover(),1);assert.equal(await f.service.recover(),0);
      for(const id of ids){assert.equal((await f.job(id)).state,'failed');assert.equal(await f.status(id),'failed');}
    });
    await t.test('heartbeat extends only a live lease and never past attempt deadline',async()=>{
      const f=await fixture();const id=await f.document();const j=(await f.service.claim())!;await delay(15);
      assert.equal(await f.service.heartbeat(claimOf(j)),true);const next=await f.job(id);
      assert.ok(next.lease_expires_at!>j.lease_expires_at!);assert.ok(next.lease_expires_at!<=next.attempt_deadline_at!);
    });
    await t.test('schema rejects malformed states, attempts and incomplete lease shapes',async()=>{
      const f=await fixture();const id=await f.document();
      for(const assignment of ["state='unknown'","attempt_count=-1","max_attempts=6","state='running'","state='completed'","last_error_code='raw document content'"]){
        await assert.rejects(pool.query('UPDATE public.document_processing_jobs SET '+assignment+' WHERE document_id=$1',[id]),{code:'23514'});
      }
    });
    await t.test('service rejects malformed claims, limits and arbitrary error text',async()=>{
      const f=await fixture();const c={documentId:randomUUID(),patientId:f.patientId,token:randomUUID()};
      assert.throws(()=>f.service.discover(101),InvalidProcessingInput);assert.throws(()=>f.service.discover(0),InvalidProcessingInput);
      assert.throws(()=>f.service.complete({...c,token:'invalid'}),InvalidProcessingInput);
      assert.throws(()=>f.service.fail(c,'private medical text' as never),InvalidProcessingInput);
    });
    await t.test('database failures are generic, bounded and expose no underlying details',async()=>{
      const database:PatientDatabase={async query(){throw new Error('synthetic-private-driver-detail');}};
      const service=createProcessingService(createProcessingRepository(database,config));const c={documentId:randomUUID(),patientId:randomUUID(),token:randomUUID()};
      for(const call of [()=>service.discover(),()=>service.claim(),()=>service.recover(),()=>service.heartbeat(c),()=>service.complete(c),()=>service.fail(c,'PROCESSOR_FAILED')]){
        await assert.rejects(call(),e=>e instanceof ProcessingUnavailable&&!e.message.includes('driver-detail'));
      }
      assert.equal(await createProcessingWorker(service,config,async()=>{}).runOnce(),'unavailable');
    });
    await t.test('failed document-state synchronization rolls back the job claim atomically',async()=>{
      const f=await fixture();const id=await f.document();const locker=await pool.connect();const victim=await pool.connect();
      try{
        await locker.query('BEGIN');await locker.query('SELECT id FROM public.medical_documents WHERE id=$1 FOR UPDATE',[id]);
        await victim.query("SET statement_timeout='100ms'");
        const service=createProcessingService(createProcessingRepository(victim,config,f.patientId));
        await assert.rejects(service.claim(),ProcessingUnavailable);
        assert.equal((await f.job(id)).state,'pending');assert.equal((await f.job(id)).attempt_count,0);
      }finally{await locker.query('ROLLBACK');await victim.query('RESET statement_timeout');locker.release();victim.release();}
      assert.equal(await f.status(id),'processing');assert.ok(await f.service.claim());
    });
    await t.test('a lost claim acknowledgement leaves one recoverable lease, never a duplicate claim',async()=>{
      const f=await fixture();const id=await f.document();
      const database:PatientDatabase={async query(sql,values){await pool.query(sql,values);throw new Error('synthetic-lost-acknowledgement');}};
      const service=createProcessingService(createProcessingRepository(database,config,f.patientId));
      await assert.rejects(service.claim(),ProcessingUnavailable);assert.equal((await f.job(id)).state,'running');
      assert.equal(await f.service.claim(),undefined);await f.expire(id);assert.equal(await f.service.recover(),1);
    });
    await t.test('worker without a processor leaves pending originals untouched',async()=>{
      const f=await fixture();const id=await f.document();assert.equal(await createProcessingWorker(f.service,f.settings).runOnce(),'disabled');
      assert.equal((await f.job(id)).state,'pending');assert.equal((await f.job(id)).attempt_count,0);
    });
    await t.test('a no-op processor cannot falsely mark processing complete',async()=>{
      const f=await fixture();const id=await f.document();assert.equal(await createProcessingWorker(f.service,f.settings,async()=>{}).runOnce(),'failed');
      assert.equal((await f.job(id)).state,'failed');assert.equal(await f.status(id),'failed');
    });
    await t.test('synthetic processor integration completes only with persisted fixture evidence',async()=>{
      const f=await fixture();const id=await f.document();const worker=createProcessingWorker(f.service,f.settings,async({claim})=>{assert.equal(claim.patientId,f.patientId);await f.extraction(claim.documentId);});
      assert.equal(await worker.runOnce(),'completed');assert.equal((await f.job(id)).state,'completed');assert.equal(await worker.runOnce(),'idle');
    });
    await t.test('worker failure codes and retryability are persisted without error contents',async()=>{
      const f=await fixture();const id=await f.document();
      assert.equal(await createProcessingWorker(f.service,f.settings,async()=>{throw new Error('synthetic-private-medical-detail');}).runOnce(),'failed');
      assert.equal((await f.job(id)).last_error_code,'PROCESSOR_FAILED');assert.equal((await f.job(id)).state,'retry_wait');
    });
    await t.test('worker timeout aborts a processor and records a recoverable failure',async()=>{
      const f=await fixture({leaseMs:1000,attemptTimeoutMs:1500,heartbeatMs:50});const id=await f.document();let aborted=false;
      const worker=createProcessingWorker(f.service,f.settings,async({signal})=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true})));
      assert.equal(await worker.runOnce(),'failed');assert.equal(aborted,true);assert.equal((await f.job(id)).last_error_code,'PROCESSOR_TIMEOUT');
    });
    await t.test('worker heartbeats and rejects overlapping runOnce on the same instance',async()=>{
      const f=await fixture({leaseMs:1000,heartbeatMs:50});const id=await f.document();let release!:()=>void;let entered!:()=>void;
      const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
      const worker=createProcessingWorker(f.service,f.settings,async()=>{entered();await gate;await f.extraction(id);});
      const running=worker.runOnce();await started;assert.equal(await worker.runOnce(),'busy');await delay(1250);
      assert.equal(await f.service.recover(),0);release();assert.equal(await running,'completed');
    });
    await t.test('worker cancellation preserves the original and records interruption',async()=>{
      const f=await fixture();const id=await f.document();const controller=new AbortController();let entered!:()=>void;
      const started=new Promise<void>(resolve=>{entered=resolve;});
      const worker=createProcessingWorker(f.service,f.settings,async({signal})=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));});
      const running=worker.runOnce(controller.signal);await started;controller.abort();assert.equal(await running,'failed');
      assert.equal((await f.job(id)).last_error_code,'INTERRUPTED');assert.equal((await pool.query('SELECT s3_object_key FROM public.medical_documents WHERE id=$1',[id])).rows[0].s3_object_key,'synthetic/'+id);
    });
    await t.test('heartbeat database failure cancels work and leaves recovery to lease expiry',async()=>{
      const f=await fixture({heartbeatMs:10});const id=await f.document();
      const service={...f.service,heartbeat:async()=>{throw new ProcessingUnavailable();}};
      const worker=createProcessingWorker(service,f.settings,async({signal})=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true})));
      assert.equal(await worker.runOnce(),'lost');assert.equal((await f.job(id)).state,'running');await f.expire(id);assert.equal(await f.service.recover(),1);
    });
    await t.test('restricted runtime owns no lifecycle objects and has CRUD without DDL or grant options',async()=>{
      const row=(await pool.query(`SELECT current_user AS role,pg_get_userbyid(relowner) AS owner,
        has_table_privilege(current_user,oid,'SELECT,INSERT,UPDATE,DELETE') AS crud,
        has_table_privilege(current_user,oid,'TRUNCATE') AS truncate,
        has_table_privilege(current_user,oid,'TRIGGER') AS trigger,
        has_table_privilege(current_user,oid,'SELECT WITH GRANT OPTION') AS grant_option
        FROM pg_class WHERE oid='public.document_processing_jobs'::regclass`)).rows[0];
      assert.deepEqual(row,{role:'health_wallet_app',owner:'health_wallet_migrator',crud:true,truncate:false,trigger:false,grant_option:false});
      const functions=(await pool.query(`SELECT prosecdef FROM pg_proc WHERE oid IN ('public.preserve_processing_owner()'::regprocedure,'public.enqueue_document_processing()'::regprocedure)`)).rows;
      assert.equal(functions.length,2);assert.ok(functions.every(f=>f.prosecdef===false));
    });
    await t.test('configuration rejects unbounded values and inconsistent lease intervals',()=>{
      const keys=['PROCESSING_MAX_ATTEMPTS','PROCESSING_LEASE_MS','PROCESSING_HEARTBEAT_MS'];
      const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
      try{
        process.env.PROCESSING_MAX_ATTEMPTS='0';assert.throws(getProcessingConfig,ProcessingConfigurationError);
        process.env.PROCESSING_MAX_ATTEMPTS='3';process.env.PROCESSING_LEASE_MS='1000';process.env.PROCESSING_HEARTBEAT_MS='500';assert.throws(getProcessingConfig,ProcessingConfigurationError);
        process.env.PROCESSING_LEASE_MS='60000';process.env.PROCESSING_HEARTBEAT_MS='15000';assert.equal(getProcessingConfig().maxAttempts,3);
      }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
    });
  }finally{
    // Only IDs allocated by this suite; never touch existing records or S3.
    try{
      await pool.query('DELETE FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[])',[documents]);
      await pool.query('DELETE FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[])',[documents]);
      await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);
      await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);
    }finally{await closeDatabasePool();}
  }
});

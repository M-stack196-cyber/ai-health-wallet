import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,chmod,rm,readdir,access} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Readable} from 'node:stream';
import {parse} from 'dotenv';
import {S3Client} from '@aws-sdk/client-s3';
import {getDatabaseConfig} from '../config/env.js';
import {getDocumentConfig} from '../config/documents.js';
import {getProcessingConfig,getRetrievalConfig,getDigitalPdfConfig,getOcrConfig} from '../processing/config.js';
import {createCanaryRepository} from '../processing/background-repository.js';
import {createProcessingRepository,type Claim,type ProcessingJob} from '../processing/repository.js';
import {createProcessingService} from '../processing/service.js';
import {composeBackground} from '../processing/background-runtime-core.js';
import {verifyApproval,type BackgroundConfig} from '../processing/background-config.js';
import {acquireCoordinator} from '../processing/background-coordinator.js';
import {logEvent} from '../processing/background-service.js';
import {createOcrProcessor} from '../processing/ocr-processor.js';
import type {DocumentProcessor} from '../processing/worker.js';
import {createS3Storage} from '../documents/storage.js';
import {syntheticScannedPdf,syntheticScan} from '../processing/fixtures/ocr-fixtures.js';
const run=process.env.STAGE_B_RUN_ID;
assert.match(run??'',/^stage-b-[a-f0-9]{24}$/);assert.equal((await readFile('/stage-b-identity','utf8')).trim(),run);
assert.ok(Object.entries(networkInterfaces()).every(([name,a])=>name==='lo'||!a?.length));
assert.equal((await readFile('/proc/net/route','utf8')).trim().split('\n').length,1);
const pool=new pg.Pool({...getDatabaseConfig(),max:12,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
const marker=(await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;
assert.equal(marker,'stage-b:'+run);
const config={...getProcessingConfig(),retryBaseMs:1000,retryMaxMs:2000};
const cutoff='2026-10-21T12:00:00.000Z';
const identity=(job:ProcessingJob):Claim=>({documentId:job.document_id,patientId:job.patient_id,token:job.lease_token!});
const evidence=()=>({text:'Synthetic Stage B extraction',method:'pdf_text' as const,extractor:{name:'synthetic',version:'test-1'},source:{sha256:'a'.repeat(64),pageCount:1,pages:[{page:1,method:'pdf_text' as const}]}});
async function until(check:()=>boolean|Promise<boolean>,ms=10000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await delay(20);}throw Error('Isolated condition timed out');}

test('Stage B isolated PostgreSQL background verification',{timeout:180000},async t=>{
 const patients:string[]=[],documents:string[]=[],directories:string[]=[];const active=new Set<{stop(immediate?:boolean):Promise<void>}>();
 async function patient(){const id=randomUUID();patients.push(id);await pool.query("INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic Stage B')",[id,id+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);return id;}
 async function document(owner:string,uploaded=cutoff,type='pdf'){
  const id=randomUUID();documents.push(id);await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,uploaded_at)
   VALUES($1,$2,'synthetic-stage-b',$3,'synthetic.'||$4,$4,'lab_report',$5)`,[id,owner,'medical-documents/'+id+'.'+type,type,uploaded]);return id;
 }
 const scoped=(id:string,c=config)=>createCanaryRepository(pool,c,{patientId:id,uploadCutoff:cutoff});
 const job=async(id:string)=>(await pool.query<ProcessingJob>('SELECT * FROM public.document_processing_jobs WHERE document_id=$1',[id])).rows[0];
 async function approval(id:string){const dir=await mkdtemp('/tmp/health-wallet-stage-b-approval-');directories.push(dir);await chmod(dir,0o700);
  const bytes=Buffer.from(JSON.stringify({version:1,mode:'canary',patientId:id,uploadCutoff:cutoff,profile:'ai-health-wallet',account:'402909940531',bucket:'ai-health-wallet-records-402909940531',region:'ap-southeast-2'}));
  const path=dir+'/approval.json';await writeFile(path,bytes,{mode:0o600});
  const c:BackgroundConfig={enabled:true,concurrency:1,pollMs:1000,backoffMaxMs:30000,drainMs:0,healthPort:0,approvalPath:path,approvalSha256:createHash('sha256').update(bytes).digest('hex'),canary:{patientId:id,uploadCutoff:cutoff}};
  return c;
 }
 async function compose(c:BackgroundConfig,processor:DocumentProcessor,options:{storage?:ReturnType<typeof createS3Storage>;fault?:()=>void;log?:(e:Parameters<typeof logEvent>[0])=>void;shutdown?:AbortSignal}={}){
  const dedicated=new pg.Pool({...getDatabaseConfig(),application_name:run+'-runtime',max:4,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
  const service=await composeBackground(c,{pool:dedicated,processing:config,retrieval:getRetrievalConfig(),documents:getDocumentConfig(),
   storage:options.storage??{bucket:'synthetic-stage-b',prefix:'medical-documents/',async readOriginal(){throw Error('No original expected');}},
   processor,profileUnchanged:async()=>{},closeStorage:()=>{},fault:options.fault??(()=>{}),log:options.log??(()=>{}),shutdown:options.shutdown});
  active.add(service);return service;
 }
 async function stop(s:{stop(immediate?:boolean):Promise<void>}){await s.stop(true);active.delete(s);}
 try{
  await t.test('isolated PostgreSQL version, marker and restricted role verified',async()=>{
   const row=(await pool.query('SELECT current_user AS role,current_setting(\'server_version_num\')::int AS version,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
   assert.equal(row.role,'health_wallet_app');assert.ok(row.version>=160000&&row.version<170000);assert.equal(row.rolsuper,false);assert.equal(row.rolcreatedb,false);assert.equal(row.rolcreaterole,false);
  });
  await t.test('SQL discovery, claim and metrics enforce exact cutoff and owner',async()=>{
   const p=await patient(),other=await patient();const old=await document(p,'2026-10-21T11:59:59.999Z'),boundary=await document(p),newer=await document(p,'2026-10-21T12:00:00.001Z'),foreign=await document(other);
   const {repository:r,queueCount}=scoped(p);assert.deepEqual(new Set((await r.discover(10)).map(j=>j.document_id)),new Set([boundary,newer]));assert.equal(await queueCount(),2);
   const claimed=(await r.claim())!.document_id;assert.ok([boundary,newer].some(id=>id===claimed));assert.equal(await queueCount(),1);await r.claim();assert.equal(await r.claim(),undefined);
   assert.equal((await job(old)).state,'pending');assert.equal((await job(foreign)).state,'pending');
  });
  await t.test('SQL recovery excludes expired historical and foreign jobs',async()=>{
   const p=await patient(),foreign=await patient();const ids=[await document(p,'2026-10-20T00:00:00.000Z'),await document(p),await document(foreign)];
   const unfiltered=createProcessingRepository(pool,config,p);await unfiltered.claim();await unfiltered.claim();await createProcessingRepository(pool,config,foreign).claim();
   await pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE document_id=ANY($1::uuid[])",[ids]);
   assert.equal(await scoped(p).repository.recover(),1);assert.deepEqual(await Promise.all(ids.map(async id=>(await job(id)).state)),['running','retry_wait','running']);
  });
  await t.test('simultaneous PostgreSQL claims have one winner',async()=>{
   const p=await patient();await document(p);const claims=await Promise.all(Array.from({length:10},()=>scoped(p).repository.claim()));assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean)!.attempt_count,1);
  });
  await t.test('FOR UPDATE SKIP LOCKED skips a genuinely locked eligible row',async()=>{
   const p=await patient();const a=await document(p),b=await document(p);const lock=await pool.connect();
   try{await lock.query('BEGIN');await lock.query('SELECT document_id FROM public.document_processing_jobs WHERE document_id=$1 FOR UPDATE',[a]);
    assert.equal((await scoped(p).repository.claim())!.document_id,b);assert.equal((await job(a)).state,'pending');
   }finally{await lock.query('ROLLBACK');lock.release();}
  });
  await t.test('retry scheduling and attempt bounds use PostgreSQL clock',async()=>{
   const p=await patient(),id=await document(p);const r=scoped(p).repository;const c=identity((await r.claim())!);assert.equal(await r.fail(c,'PROCESSOR_FAILED',true),true);
   const state=await job(id);assert.equal(state.state,'retry_wait');assert.ok(state.next_attempt_at.getTime()>=state.finished_at!.getTime()+990);assert.equal(await r.claim(),undefined);
   for(let n=0;n<2;n++){await pool.query("UPDATE public.document_processing_jobs SET next_attempt_at=clock_timestamp()-interval '1 millisecond' WHERE document_id=$1",[id]);await r.fail(identity((await r.claim())!),'PROCESSOR_FAILED',true);}
   assert.equal((await job(id)).state,'failed');assert.equal((await job(id)).attempt_count,3);assert.equal(await r.claim(),undefined);
  });
  await t.test('real lease expiration, heartbeat extension and stale-token fences',async()=>{
   const p=await patient(),id=await document(p);const r=scoped(p,{...config,leaseMs:1000,attemptTimeoutMs:5000,heartbeatMs:200}).repository;
   const first=(await r.claim())!,c=identity(first);await delay(150);assert.equal(await r.heartbeat(c),true);assert.ok((await job(id)).lease_expires_at!>first.lease_expires_at!);
   await delay(1100);assert.equal(await r.heartbeat(c),false);assert.equal(await r.recover(),1);
   await pool.query("UPDATE public.document_processing_jobs SET next_attempt_at=clock_timestamp()-interval '1 millisecond' WHERE document_id=$1",[id]);const next=identity((await r.claim())!);assert.notEqual(next.token,c.token);
   const service=createProcessingService(r);assert.equal(await service.persistExtraction(c,evidence()),false);assert.equal(await r.complete(c),false);assert.equal(await r.fail(c,'PROCESSOR_FAILED',true),false);
  });
  await t.test('atomic evidence completion and competing persistence retain one current attempt',async()=>{
   const p=await patient(),id=await document(p),r=scoped(p).repository,c=identity((await r.claim())!);const s=createProcessingService(r);
   const outcomes=await Promise.all([s.persistExtraction(c,evidence()),s.persistExtraction(c,evidence())]);assert.equal(outcomes.filter(Boolean).length,1);
   const row=(await pool.query(`SELECT j.state,d.processing_status,e.processing_status AS extraction,e.processing_attempt,e.processing_claim_token
    FROM public.document_processing_jobs j JOIN public.medical_documents d ON d.id=j.document_id JOIN public.extracted_medical_text e ON e.document_id=j.document_id WHERE j.document_id=$1`,[id])).rows[0];
   assert.deepEqual(row,{state:'completed',processing_status:'completed',extraction:'completed',processing_attempt:1,processing_claim_token:c.token});
  });
  await t.test('actual scheduler restart preserves fixed cutoff and historical rows',async()=>{
   const p=await patient(),old=await document(p,'2026-10-20T00:00:00.000Z'),id=await document(p),c=await approval(p);
   const processor:DocumentProcessor=async ctx=>{await ctx.persistExtraction(evidence());};let s=await compose(c,processor);await until(async()=>(await job(id)).state==='completed');await stop(s);
   const next=await document(p,'2026-10-21T12:00:00.001Z');s=await compose(c,processor);await until(async()=>(await job(next)).state==='completed');await until(()=>s.snapshot().metrics.queue===0);await stop(s);assert.equal((await job(old)).state,'pending');await verifyApproval(c);
  });
  await t.test('approval tampering during scheduler polling stops admissions',async()=>{
   const p=await patient(),c=await approval(p);const s=await compose(c,async()=>{});await until(()=>s.snapshot().ready);
   await writeFile(c.approvalPath,'{}');await until(()=>!s.snapshot().live);const id=await document(p);assert.equal((await job(id)).state,'pending');await stop(s);
  });
  await t.test('dedicated advisory-lock sessions contend and release correctly',async()=>{
   const first=new pg.Pool({...getDatabaseConfig(),max:1}),second=new pg.Pool({...getDatabaseConfig(),max:1});
   try{const lock=await acquireCoordinator(await first.connect(),()=>{});await assert.rejects(acquireCoordinator(await second.connect(),()=>{}));await lock.close();const next=await acquireCoordinator(await second.connect(),()=>{});await next.close();}
   finally{await first.end();await second.end();}
  });
  await t.test('coordinator backend termination cancels actual work and stops admissions',async()=>{
   const p=await patient(),id=await document(p),c=await approval(p);let started=false,cancelled=false,faulted=false;
   const s=await compose(c,async ctx=>{started=true;await new Promise<void>(resolve=>ctx.signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true}));},{fault:()=>{faulted=true;}});
   await until(()=>started);const admin=parse(await readFile('/work/infrastructure/.env','utf8'));const killer=new pg.Client({...getDatabaseConfig(),user:'health_wallet_user',password:admin.POSTGRES_PASSWORD});
   try{await killer.connect();const found=(await killer.query(`SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.application_name=$1 AND l.locktype='advisory' AND l.granted`,[run+'-runtime'])).rows;
    assert.equal(found.length,1);await killer.query('SELECT pg_terminate_backend($1)',[found[0].pid]);
   }finally{await killer.end();}
   await until(()=>!s.snapshot().live);assert.equal(cancelled,true);assert.equal(faulted,true);const next=await document(p);assert.equal((await job(next)).state,'pending');assert.equal(s.snapshot().ready,false);assert.notEqual((await job(id)).state,'completed');await stop(s);
  });
  await t.test('shutdown signal cancels active scheduler work and settles active slots',async()=>{
   const p=await patient();await document(p);let started=false,cleaned=false;const shutdown=new AbortController();
   const s=await compose(await approval(p),async ctx=>{started=true;await new Promise<void>(resolve=>ctx.signal.addEventListener('abort',()=>{cleaned=true;resolve();},{once:true}));},{shutdown:shutdown.signal});
   await until(()=>started);shutdown.abort();await until(()=>!s.snapshot().live);assert.equal(cleaned,true);assert.equal(s.snapshot().metrics.active,0);await stop(s);
  });
  await t.test('actual scheduler bounds PostgreSQL admissions to two active slots',async()=>{
   const p=await patient(),ids=[await document(p),await document(p),await document(p)];let started=0;
   const c={...await approval(p),concurrency:2};const s=await compose(c,async ctx=>{started++;await new Promise<void>(resolve=>ctx.signal.addEventListener('abort',()=>resolve(),{once:true}));});
   await until(()=>started===2);assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[]) AND state='running'",[ids])).rows[0].n,2);
   assert.equal(s.snapshot().metrics.active,2);await stop(s);assert.equal(started,2);assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[]) AND state='pending'",[ids])).rows[0].n,1);
  });
  await t.test('graceful drain allows fenced completion before resources close',async()=>{
   const p=await patient(),id=await document(p);let started=false,release!:()=>void;
   const s=await compose({...await approval(p),drainMs:1000},async ctx=>{started=true;await new Promise<void>(resolve=>{release=resolve;});await ctx.persistExtraction(evidence());});
   await until(()=>started);const stopping=s.stop();assert.equal(s.snapshot().ready,false);release();await stopping;active.delete(s);assert.equal((await job(id)).state,'completed');
  });
  await t.test('real runtime health and structured logs expose aggregate fields only',async()=>{
   const p=await patient(),lines:string[]=[];const s=await compose({...await approval(p),healthPort:59991},async()=>{},{log:e=>logEvent(e,line=>lines.push(line))});
   await until(()=>s.snapshot().ready);const responses=[];
   for(const route of ['/live','/ready','/metrics']){const response=await fetch('http://127.0.0.1:59991'+route);assert.equal(response.status,200);responses.push(await response.json());}
   assert.equal((await fetch('http://127.0.0.1:59991/metrics',{method:'POST'})).status,405);
   assert.equal((await fetch('http://127.0.0.1:59991/claim')).status,404);
   const output=JSON.stringify([responses,lines]);assert.ok(!output.includes(p)&&!output.includes('medical-documents/')&&!output.includes(process.env.DB_PASSWORD!));await stop(s);
  });
  for(const scenario of ['digital','png','mixed'] as const)await t.test('genuine '+scenario+' extraction through mocked S3 and real scheduler',async()=>{
   const bytes=scenario==='png'?await syntheticScan():await syntheticScannedPdf(scenario==='digital'?[{text:'SYNTHETIC DIGITAL REPORT'}]:[{text:'SYNTHETIC DIGITAL FIRST'},{scan:'SYNTHETIC SCANNED SECOND'}]);
   const p=await patient(),id=await document(p,cutoff,scenario==='png'?'png':'pdf');const original=Buffer.from(bytes),commands:string[]=[];
   const storageConfig={bucket:'synthetic-stage-b',prefix:'medical-documents/',region:'ap-southeast-2',ownerAccountId:'402909940531',encryption:'AES256' as const};
   const fake={async send(command:{constructor:{name:string};input:Record<string,unknown>}){
    const name=command.constructor.name;commands.push(name);
    switch(name){
     case 'GetPublicAccessBlockCommand':return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
     case 'GetBucketPolicyStatusCommand':return {PolicyStatus:{IsPublic:false}};
     case 'GetBucketOwnershipControlsCommand':return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
     case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}};
     case 'HeadObjectCommand':case 'GetObjectCommand':assert.equal(command.input.Key,'medical-documents/'+id+(scenario==='png'?'.png':'.pdf'));return {ContentLength:bytes.length,ContentType:scenario==='png'?'image/png':'application/pdf',ServerSideEncryption:'AES256',ETag:'"synthetic"',...(name==='GetObjectCommand'?{Body:Readable.from([bytes])}:{})};
     default:throw Error('Unexpected mocked S3 operation');
    }
   }} as unknown as S3Client;
   const paths:string[]=[],lines:string[]=[];const real=createOcrProcessor(getOcrConfig(),getDigitalPdfConfig());
   const processor:DocumentProcessor=ctx=>real({...ctx,withOriginal:use=>ctx.withOriginal(input=>{paths.push(input.path);return use(input);})});
   const s=await compose(await approval(p),processor,{storage:createS3Storage(storageConfig,{client:fake}),log:event=>logEvent(event,line=>lines.push(line))});
   await until(async()=>['completed','failed','retry_wait'].includes((await job(id)).state),30000);assert.equal((await job(id)).state,'completed');
   const row=(await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=$1',[id])).rows[0];
   assert.equal(row.source_metadata.source.sha256,createHash('sha256').update(bytes).digest('hex'));
   assert.deepEqual(row.source_metadata.source.pages.map((v:{page:number;method:string})=>({page:v.page,method:v.method})),scenario==='mixed'?[{page:1,method:'pdf_text'},{page:2,method:'ocr'}]:[{page:1,method:scenario==='digital'?'pdf_text':'ocr'}]);
   assert.equal(row.processing_attempt,1);assert.equal((await pool.query('SELECT processing_status FROM public.medical_documents WHERE id=$1',[id])).rows[0].processing_status,'completed');
   assert.deepEqual(bytes,original);await stop(s);for(const path of paths)await assert.rejects(access(path));assert.ok(!commands.some(c=>/Put|Delete/.test(c)));
   assert.ok(!JSON.stringify(lines).includes(p)&&!JSON.stringify(lines).includes(id));
   const children=(await readFile('/proc/self/task/'+process.pid+'/children','utf8')).trim();assert.equal(children,'');
  });
 }finally{
  await Promise.allSettled([...active].map(s=>s.stop(true)));
  await pool.query('DELETE FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[])',[documents]);
  await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);
  for(const dir of directories)await rm(dir,{recursive:true,force:true});await pool.end();
 }
});

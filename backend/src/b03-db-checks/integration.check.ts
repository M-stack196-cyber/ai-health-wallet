import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {readFile,writeFile,mkdtemp,chmod,rm,readdir} from 'node:fs/promises';
import {networkInterfaces,tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import type {S3Client} from '@aws-sdk/client-s3';
import type {BackgroundConfig} from '../processing/background-config.js';
import type {ProcessingJob,Claim} from '../processing/repository.js';
const run=process.env.STAGE_B_RUN_ID;
assert.match(run??'',/^stage-b-[a-f0-9]{24}$/);assert.equal((await readFile('/stage-b-identity','utf8')).trim(),run);
assert.ok(Object.entries(networkInterfaces()).every(([name,a])=>name==='lo'||!a?.length));
assert.equal((await readFile('/proc/net/route','utf8')).trim().split('\n').length,1);
// Credential-bearing imports occur only after the owned isolated namespace marker.
const {getDatabaseConfig}=await import('../config/env.js');
const {getAuthenticationConfig}=await import('../config/auth.js');
const {getDocumentConfig}=await import('../config/documents.js');
const {getProcessingConfig,getRetrievalConfig,getDigitalPdfConfig,getOcrConfig}=await import('../processing/config.js');
const {createApp}=await import('../app.js');const {closeDatabasePool}=await import('../database/pool.js');
const {createS3Storage}=await import('../documents/storage.js');
const {composeBackground}=await import('../processing/background-runtime-core.js');
const {createProcessingRepository}=await import('../processing/repository.js');
const {createPatientProcessingRepository}=await import('../processing/api-repository.js');
const {createOcrProcessor}=await import('../processing/ocr-processor.js');
const {syntheticScan,syntheticScannedPdf}=await import('../processing/fixtures/ocr-fixtures.js');
const {proposeCutoff}=await import('../stage-c/database.js');const sharp=(await import('sharp')).default;
const pool=new pg.Pool({...getDatabaseConfig(),max:5,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
assert.equal((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker,'stage-b:'+run);
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function until(check:()=>Promise<boolean>|boolean,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(25);}throw Error('Synthetic integration condition timed out');}
const identity=(j:ProcessingJob):Claim=>({documentId:j.document_id,patientId:j.patient_id,token:j.lease_token!});
const temporary=async()=>(await readdir(tmpdir())).filter(n=>/^health-wallet-(ocr|processing|upload|file)-/.test(n)).sort();

test('B03 authenticated upload to scoped automatic extraction and bounded patient retry',{timeout:240000},async t=>{
 const patients:string[]=[],documents:string[]=[],servers:ReturnType<ReturnType<typeof createApp>['listen']>[]=[];
 const services=new Set<Awaited<ReturnType<typeof composeBackground>>>();
 const directory=await mkdtemp('/tmp/health-wallet-b03-approval-');await chmod(directory,0o700);
 const initialTemps=await temporary();
 const before=(await pool.query('SELECT * FROM public.document_processing_jobs ORDER BY document_id')).rows;
 const objects=new Map<string,{bytes:Buffer;mime:string;version:string}>();const commands:string[]=[];
 const sdk={async send(command:{constructor:{name:string};input:Record<string,any>}){
  const name=command.constructor.name;commands.push(name);const input=command.input;
  assert.equal(input.Bucket,'synthetic-b03-private');assert.equal(input.ExpectedBucketOwner,'402909940531');
  if(name==='GetPublicAccessBlockCommand')return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
  if(name==='GetBucketPolicyStatusCommand')return {PolicyStatus:{IsPublic:false}};
  if(name==='GetBucketOwnershipControlsCommand')return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
  if(name==='GetBucketEncryptionCommand')return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}};
  if(name==='PutObjectCommand'){
   assert.equal(input.IfNoneMatch,'*');assert.ok(!objects.has(input.Key));
   const chunks:Buffer[]=[];for await(const c of input.Body)chunks.push(Buffer.from(c));const bytes=Buffer.concat(chunks);
   assert.equal(createHash('sha256').update(bytes).digest('base64'),input.ChecksumSHA256);
   const version=randomUUID();objects.set(input.Key,{bytes,mime:input.ContentType,version});return {VersionId:version};
  }
  const stored=objects.get(input.Key);if(!stored)throw Error('Synthetic object unavailable');
  if(name==='DeleteObjectCommand'){objects.delete(input.Key);return {};}
  const metadata={ContentLength:stored.bytes.length,ContentType:stored.mime,ServerSideEncryption:'AES256',VersionId:stored.version,ETag:'"'+hash(stored.bytes)+'"'};
  if(name==='HeadObjectCommand')return metadata;
  if(name==='GetObjectCommand'){assert.equal(input.VersionId,stored.version);assert.equal(input.IfMatch,metadata.ETag);return {...metadata,Body:Readable.from([stored.bytes]),ChecksumSHA256:createHash('sha256').update(stored.bytes).digest('base64'),ChecksumType:'FULL_OBJECT'};}
  throw Error('Unexpected synthetic storage operation');
 }} as unknown as S3Client;
 const storage=createS3Storage({bucket:'synthetic-b03-private',prefix:'medical-documents/',ownerAccountId:'402909940531',region:'ap-southeast-2',encryption:'AES256'},{client:sdk});
 const auth={...getAuthenticationConfig(),jwtKey:randomBytes(32),rateLimitMax:100};const docs={...getDocumentConfig(),uploadRateLimitMax:100};
 async function listen(config?:BackgroundConfig){const app=createApp({auth,database:pool,documentStorage:storage,documentConfig:docs,processingApi:config?{retryApproval:config,retryLimit:20}:undefined});const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');return 'http://127.0.0.1:'+a.port;}
 async function json(base:string,path:string,method='GET',token?:string,body?:unknown){const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:response.status,value:await response.json()};}
 async function patient(base:string){const email='b03-'+randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');const r=await json(base,'/api/v1/auth/register','POST',undefined,{email,password,full_name:'Synthetic B03'});assert.equal(r.status,201);patients.push(r.value.patient.id);const login=await json(base,'/api/v1/auth/login','POST',undefined,{email,password});assert.equal(login.status,200);return {id:r.value.patient.id as string,token:login.value.access_token as string};}
 async function upload(base:string,token:string,bytes:Buffer,type='pdf'){
  const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)],{type:type==='pdf'?'application/pdf':type==='png'?'image/png':'image/jpeg'}),'synthetic.'+type);form.append('category','lab_report');form.append('hospital_name','Synthetic B03');
  const response=await fetch(base+'/api/v1/documents',{method:'POST',headers:{Authorization:'Bearer '+token},body:form,signal:AbortSignal.timeout(30000)});assert.equal(response.status,201);const value=await response.json();documents.push(value.document.id);return value.document.id as string;
 }
 const job=async(id:string)=>(await pool.query<ProcessingJob>('SELECT * FROM public.document_processing_jobs WHERE document_id=$1',[id])).rows[0];
 async function start(c:BackgroundConfig){const s=await composeBackground(c,{pool:new pg.Pool({...getDatabaseConfig(),max:4,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000}),processing:getProcessingConfig(),retrieval:getRetrievalConfig(),documents:docs,storage,processor:createOcrProcessor(getOcrConfig(),getDigitalPdfConfig()),profileUnchanged:async()=>{},closeStorage(){},fault(){},log(){}});services.add(s);return s;}
 async function stop(s:Awaited<ReturnType<typeof start>>){await s.stop(true);services.delete(s);}
 try{
  const base=await listen(),owner=await patient(base),foreign=await patient(base);
  const digital=await syntheticScannedPdf([{text:'SYNTHETIC B03 DIGITAL REPORT'}]);
  const sentinel=await upload(base,owner.token,digital),oldFailed=await upload(base,owner.token,digital),control=await upload(base,foreign.token,digital);
  const cutoff=await proposeCutoff(pool,owner.id,sentinel);await until(async()=>(await pool.query('SELECT clock_timestamp()>=$1::timestamptz AS reached',[cutoff])).rows[0].reached);
  const bytes=Buffer.from(JSON.stringify({version:1,mode:'canary',patientId:owner.id,uploadCutoff:cutoff,profile:'ai-health-wallet',account:'402909940531',bucket:'ai-health-wallet-records-402909940531',region:'ap-southeast-2'}));
  const path=directory+'/approval.json';await writeFile(path,bytes,{mode:0o600});
  const config:BackgroundConfig={enabled:true,concurrency:1,pollMs:1000,backoffMaxMs:30000,drainMs:1000,healthPort:0,approvalPath:path,approvalSha256:hash(bytes),canary:{patientId:owner.id,uploadCutoff:cutoff}};
  const activeApi=await listen(config),repo=createProcessingRepository(pool,getProcessingConfig(),owner.id,cutoff);
  const exhausted=await upload(activeApi,owner.token,digital);
  const one=createProcessingRepository(pool,{...getProcessingConfig(),maxAttempts:1},owner.id,cutoff);const first=(await one.claim())!;assert.equal(first.document_id,exhausted);assert.equal(await one.fail(identity(first),'PROCESSOR_FAILED',false),true);
  const retry=await upload(activeApi,owner.token,digital);const interrupted=(await repo.claim())!;assert.equal(interrupted.document_id,retry);assert.equal(await repo.fail(identity(interrupted),'INTERRUPTED',false),true);
  await pool.query(`WITH changed AS (UPDATE public.document_processing_jobs SET state='failed',attempt_count=1,started_at=clock_timestamp(),finished_at=clock_timestamp(),last_error_code='INTERRUPTED' WHERE document_id=$1 RETURNING document_id) UPDATE public.medical_documents SET processing_status='failed' WHERE id IN(SELECT document_id FROM changed)`,[oldFailed]);
  const excludedBefore=(await pool.query('SELECT * FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[]) ORDER BY document_id',[[sentinel,oldFailed,control]])).rows;
  await t.test('patient status and retries hide foreign identifiers and require authentication',async()=>{
   assert.equal((await json(activeApi,'/api/v1/documents/'+retry+'/processing')).status,401);
   const a=await json(activeApi,'/api/v1/documents/'+retry+'/processing','GET',foreign.token),b=await json(activeApi,'/api/v1/documents/'+randomUUID()+'/processing','GET',foreign.token);assert.equal(a.status,404);assert.deepEqual(a,b);
   assert.equal((await json(activeApi,'/api/v1/documents/'+retry+'/processing-retries','POST',foreign.token,{})).status,404);
  });
  await t.test('concurrent patient retries queue once without resetting attempts or original',async()=>{
   const r=await Promise.all([json(activeApi,'/api/v1/documents/'+retry+'/processing-retries','POST',owner.token,{}),json(activeApi,'/api/v1/documents/'+retry+'/processing-retries','POST',owner.token,{})]);assert.ok(r.every(x=>x.status===202));assert.equal((await job(retry)).attempt_count,1);assert.equal((await job(retry)).state,'retry_wait');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.document_processing_jobs WHERE document_id=$1',[retry])).rows[0].n,1);
  });
  await t.test('SQL and API exclude historical jobs and exhausted attempts',async()=>{
   for(const id of [oldFailed,exhausted])assert.equal((await json(activeApi,'/api/v1/documents/'+id+'/processing-retries','POST',owner.token,{})).status,409);
   const direct=createPatientProcessingRepository(pool,config.canary);assert.equal(await direct.retry(oldFailed,owner.id),false);assert.equal(await direct.retry(retry,foreign.id),false);assert.equal(await direct.retry(exhausted,owner.id),false);
  });
  const expected=new Map<string,{bytes:Buffer;methods:string[]}>();expected.set(retry,{bytes:digital,methods:['pdf_text']});
  const service=await start(config);
  for(const type of ['pdf','png','jpg','jpeg','mixed']){
   const data=type==='pdf'?digital:type==='mixed'?await syntheticScannedPdf([{text:'SYNTHETIC B03 FIRST PAGE'},{scan:'SYNTHETIC B03 SECOND PAGE'}]):await syntheticScan('SYNTHETIC B03 '+type.toUpperCase(),type==='png'?'png':'jpeg');
   const id=await upload(activeApi,owner.token,data,type==='mixed'?'pdf':type);expected.set(id,{bytes:data,methods:type==='mixed'?['pdf_text','ocr']:[type==='pdf'?'pdf_text':'ocr']});
  }
  const blank=await sharp({create:{width:600,height:300,channels:3,background:'white'}}).png().toBuffer();const empty=await upload(activeApi,owner.token,blank,'png');
  await until(async()=>{const rows=(await pool.query('SELECT state FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[])',[[...expected.keys(),empty]])).rows;return rows.every(r=>['completed','failed'].includes(r.state));});
  await t.test('real PDF.js Poppler Tesseract output is atomic owner-bound and source-grounded',async()=>{
   for(const [id,want]of expected){const j=await job(id);assert.equal(j.state,'completed');assert.equal(j.patient_id,owner.id);assert.equal(j.attempt_count,id===retry?2:1);assert.equal(j.lease_token,null);
    const e=(await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=$1 AND patient_id=$2',[id,owner.id])).rows[0];assert.ok(e);assert.equal(e.processing_attempt,j.attempt_count);assert.ok(e.processing_claim_token);assert.match(e.extracted_text,/SYNTHETIC/i);
    assert.equal(e.source_metadata.source.sha256,hash(want.bytes));assert.deepEqual(e.source_metadata.source.pages.map((p:{page:number;method:string})=>({page:p.page,method:p.method})),want.methods.map((method,i)=>({page:i+1,method})));
    assert.equal((await pool.query('SELECT processing_status FROM public.medical_documents WHERE id=$1',[id])).rows[0].processing_status,'completed');
    const view=await json(activeApi,'/api/v1/documents/'+id+'/processing','GET',owner.token);assert.equal(view.value.processing.stage,'extraction');assert.equal(view.value.processing.status,'completed');
   }
  });
  await t.test('empty scans fail without extraction or loss of original and cannot bypass retry policy',async()=>{
   const j=await job(empty);assert.equal(j.state,'failed');assert.equal(j.last_error_code,'INVALID_INPUT');assert.equal((await pool.query('SELECT 1 FROM public.extracted_medical_text WHERE document_id=$1',[empty])).rows.length,0);
   const r=await json(activeApi,'/api/v1/documents/'+empty+'/processing','GET',owner.token);assert.equal(r.value.processing.status,'failed');assert.equal(r.value.processing.retry_allowed,false);
   assert.equal((await json(activeApi,'/api/v1/documents/'+empty+'/processing-retries','POST',owner.token,{})).status,409);
   const response=await fetch(activeApi+'/api/v1/documents/'+empty+'/download',{headers:{Authorization:'Bearer '+owner.token}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),blank);
  });
  await t.test('idle polling and restart preserve evidence and fixed historical exclusion',async()=>{
   const fingerprint=JSON.stringify((await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[]) ORDER BY document_id',[[...expected.keys()]])).rows);
   await delay(1250);await stop(service);
   const next=await start(config);await until(()=>next.snapshot().metrics.idle>0);await stop(next);
   assert.equal(hash(await readFile(path)),config.approvalSha256);
   assert.equal(JSON.stringify((await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[]) ORDER BY document_id',[[...expected.keys()]])).rows),fingerprint);
   assert.deepEqual((await pool.query('SELECT * FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[]) ORDER BY document_id',[[sentinel,oldFailed,control]])).rows,excludedBefore);
  });
  await t.test('unrelated jobs originals private files and native subprocesses are preserved or cleaned',async()=>{
   assert.deepEqual((await pool.query('SELECT * FROM public.document_processing_jobs WHERE NOT(document_id=ANY($1::uuid[])) ORDER BY document_id',[documents])).rows,before);
   assert.equal(objects.size,11);assert.equal(commands.filter(c=>c==='DeleteObjectCommand').length,0);
   for(const [id,want] of expected){const ref=(await pool.query('SELECT s3_object_key FROM public.medical_documents WHERE id=$1',[id])).rows[0];assert.equal(hash(objects.get(ref.s3_object_key)!.bytes),hash(want.bytes));}
   assert.equal((await readFile('/proc/self/task/'+process.pid+'/children','utf8')).trim(),'');
   await until(async()=>JSON.stringify(await temporary())===JSON.stringify(initialTemps),5000);
   assert.deepEqual(await temporary(),initialTemps);
  });
 }finally{
  await Promise.allSettled([...services].map(s=>s.stop(true)));
  for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  await pool.query('DELETE FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[])',[documents]);
  await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);
  await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);
  await pool.end();await closeDatabasePool();await rm(directory,{recursive:true,force:true});
 }
});

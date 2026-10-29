// Focused M03 qualification; shared Phase 2 scenarios reused without guardian/identity suites.
import {createProcessingRepository} from '../processing/repository.js';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import sharp from 'sharp';
import {createSecurityRepository} from '../auth/security-repository.js';
import {createPasswordService} from '../auth/passwords.js';
import {createTokenService} from '../auth/tokens.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {createDocumentRoutes} from '../documents/routes.js';
import type {DocumentStorage} from '../documents/storage.js';
import {createPatientProcessingRepository} from '../processing/api-repository.js';
import {createProcessingRoutes} from '../processing/api.js';
import {syntheticDigitalPdf} from '../processing/fixtures/pdf-fixtures.js';
import {errorHandler} from '../http/errors.js';
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Test-owned socket required.');
const conn={host:socket,port:55481,database:'hw_m03_closure'};
const admin=new pg.Pool({...conn,user:userInfo().username}),db=new pg.Pool({...conn,user:'health_wallet_app',max:16});
const policy={...getSecurityPolicy(),resendCooldownSeconds:1,challengeRateMax:5};
const auth={jwtKey:randomBytes(32),jwtAlgorithm:'HS256' as const,jwtLifetimeSeconds:900,jwtIssuer:'phase2-test',jwtAudience:'patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:4,rateLimitWindowMs:900000,rateLimitMax:10000};
const objects=new Map<string,Buffer>();let puts=0,reads=0;let acquisitionHook:(()=>Promise<void>)|undefined;
const security=createSecurityRepository(db,policy),tokens=createTokenService(auth);
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',async put(i){puts++;const b=await readFile(i.path);assert.equal(createHash('sha256').update(b).digest('base64'),i.checksum);objects.set(i.key,b);return {versionId:'test'};},async remove(key){objects.delete(key);},async download(){throw Error('URL signing forbidden');},async readOriginal(i){reads++;if(acquisitionHook)await acquisitionHook();const b=objects.get(i.key);if(!b)throw Error('synthetic missing object');await writeFile(i.destination,b,{flag:'wx',mode:0o600});return {bytes:b.length};}};
const config={maxFileBytes:4096,maxConcurrentUploads:2,uploadTimeoutMs:5000,validationTimeoutMs:3000,maxImagePixels:1000,maxPdfPages:2,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
let fixtureHash:string;
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string,legacyId:string,legacyPatient:string;
before(async()=>{
 assert.equal((await stat(socket!)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_m03_closure');}finally{await bootstrap.end();}
 await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator');
 fixtureHash=await createPasswordService(auth).hash('Synthetic fixture passphrase 498!');
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,9);
 for(const file of files){
  if(file.startsWith('0005'))await admin.query('GRANT USAGE ON SCHEMA public TO health_wallet_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  if(file.startsWith('0007')){
   legacyPatient=randomUUID();legacyId=randomUUID();
   await admin.query("INSERT INTO patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Legacy Synthetic')",[legacyPatient,'legacy@example.invalid',fixtureHash]);
   await admin.query("INSERT INTO medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,processing_status) VALUES($1,$2,'legacy-private','legacy/key.pdf','legacy.pdf','pdf','lab_report','completed')",[legacyId,legacyPatient]);
  }
  if(file.startsWith('0007')){
   const probe=await admin.connect();try{await probe.query('BEGIN');await probe.query('SET LOCAL ROLE health_wallet_migrator');await probe.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await probe.query('ROLLBACK');}finally{probe.release();}
   assert.equal((await admin.query("SELECT to_regclass('public.guardian_relationships') AS relation")).rows[0].relation,null);
   assert.equal((await admin.query('SELECT processing_status FROM medical_documents WHERE id=$1',[legacyId])).rows[0].processing_status,'completed');
  }
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE health_wallet_migrator');await c.query("SET LOCAL search_path=public,pg_catalog;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='30s'");await c.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 const app=express();app.use(express.json());
 app.use('/api/v1/documents',createDocumentRoutes(db,auth,config,storage));app.use('/api/v1',createProcessingRoutes(db,auth));app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port+'/api/v1';
});
after(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await db.end();await admin.end();});
async function user(){const id=randomUUID(),email=id+'@example.invalid';await db.query("INSERT INTO patients(id,email,password_hash,full_name,email_verified_at,account_status) VALUES($1,$2,$3,'Synthetic Patient',clock_timestamp(),'active')",[id,email,fixtureHash]);const s=await security.login(id,fixtureHash);assert.ok(s);return {id,email,who:{patientId:id,sessionId:s.sessionId},token:await tokens.issue(id,s.sessionId)};}
async function request(path:string,token?:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const text=await r.text();return {status:r.status,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):text};
}

const pdf=syntheticDigitalPdf([['Synthetic nonmedical fixture']]);
async function upload(u:Awaited<ReturnType<typeof user>>,bytes:Buffer=pdf,name='report.pdf',mime='application/pdf',fields:Record<string,string>={}){
 const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)],{type:mime}),name);form.append('category',fields.category??'lab_report');form.append('hospital_name',fields.hospital_name??'Synthetic Hospital');for(const [k,v]of Object.entries(fields))if(!['category','hospital_name'].includes(k))form.append(k,v);
 const r=await fetch(base+'/documents',{method:'POST',headers:{Authorization:'Bearer '+u.token},body:form,signal:AbortSignal.timeout(15000)});return {status:r.status,data:await r.json()};
}

test('M03-13 PDF/JPG/JPEG/PNG uploads persist exact metadata, SHA256 and private owner references',async()=>{
 const u=await user(),png=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).png().toBuffer(),jpeg=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).jpeg().toBuffer();
 for(const [bytes,name,mime,category]of [[pdf,'report.pdf','application/pdf','lab_report'],[jpeg,'report.jpg','image/jpeg','prescription'],[jpeg,'report.jpeg','image/jpeg','other_medical_document'],[png,'report.png','image/png','other_medical_document']] as const){
  const r=await upload(u,bytes,name,mime,{category,document_date:'2026-01-02'});assert.equal(r.status,201);const d=r.data.document;
  assert.equal(d.category,category);assert.equal(d.hospital_name,'Synthetic Hospital');assert.equal(d.document_date,'2026-01-02');assert.ok(Number.isFinite(Date.parse(d.uploaded_at)));assert.equal(d.original_filename,name);assert.equal(d.content_type,mime);assert.equal(Number(d.size_bytes),bytes.length);assert.equal(d.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(d.processing_status,'processing');assert.equal('s3_object_key' in d,false);
  const stored=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[d.id])).rows[0];assert.equal(stored.patient_id,u.id);assert.deepEqual(objects.get(stored.s3_object_key),bytes);
  const download=await fetch(base+'/documents/'+d.id+'/download',{headers:{Authorization:'Bearer '+u.token}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);assert.equal(download.headers.get('content-type'),mime);
 }
});
test('M03-14 unsupported, mismatched MIME, signatures, malformed, empty and oversized files reject before storage',async()=>{
 const u=await user(),before=puts;
 for(const [bytes,name,mime]of [[pdf,'report.exe','application/pdf'],[pdf,'report.pdf','image/png'],[Buffer.from('not a png'),'report.png','image/png'],[Buffer.from('%PDF-1.7\nbroken'),'report.pdf','application/pdf'],[Buffer.alloc(4097),'report.pdf','application/pdf'],[Buffer.alloc(0),'report.pdf','application/pdf']] as const){const r=await upload(u,bytes,name,mime);assert.ok(r.status>=400);}
 assert.equal(puts,before);assert.equal((await admin.query('SELECT count(*)::int n FROM medical_documents WHERE patient_id=$1',[u.id])).rows[0].n,0);
});
test('M03-15 categories/hospital/date validated; filename sanitized; confirmed values editable only by owner',async()=>{
 const u=await user(),b=await user();for(const fields of [{category:'unsupported'},{hospital_name:''},{document_date:'2026-02-30'},{document_date:'2999-01-01'},{patient_id:b.id}] as Record<string,string>[])assert.ok((await upload(u,pdf,'report.pdf','application/pdf',fields)).status>=400);
 const r=await upload(u,pdf,'../../unsafe<name>.pdf','application/pdf',{category:'other_medical_document',document_date:'2026-01-02'});assert.equal(r.status,201);const id=r.data.document.id;assert.equal(r.data.document.original_filename,'unsafe_name_.pdf');
 assert.equal((await request('/documents/'+id,b.token,{hospital_name:'Other Hospital'},'PATCH')).status,404);
 const patch=await request('/documents/'+id,u.token,{hospital_name:'Confirmed Hospital',document_date:'2026-02-03'},'PATCH');assert.equal(patch.status,200);assert.equal(patch.data.document.hospital_name,'Confirmed Hospital');assert.equal(patch.data.document.document_date,'2026-02-03');
});
test('M03-16 identifier/reference/query cannot bypass private owner/session checks; no signed URL response',async()=>{
 const a=await user(),b=await user(),r=await upload(a);assert.equal(r.status,201);const id=r.data.document.id,n=reads;
 assert.equal((await request('/documents/'+id,b.token)).status,404);assert.equal((await request('/documents/'+id+'/download',b.token)).status,404);assert.equal((await request('/documents/'+id+'/download')).status,401);assert.equal(reads,n);
 assert.equal((await request('/documents/'+id+'/download?url=https://example.invalid',a.token)).status,400);
 assert.equal(JSON.stringify(r.data).includes('https://'),false);await security.logout(a.who);assert.equal((await request('/documents/'+id+'/download',a.token)).status,401);
});
test('M03-17 persisted digest catches same-size object tampering before response bytes',async()=>{
 const u=await user(),r=await upload(u);const d=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[r.data.document.id])).rows[0],bytes=Buffer.from(objects.get(d.s3_object_key)!);bytes[10]^=1;objects.set(d.s3_object_key,bytes);
 const response=await request('/documents/'+d.id+'/download',u.token);assert.equal(response.status,503);assert.equal(JSON.stringify(response.data).includes('%PDF'),false);
});
test('M03-18 failure/retry preserves owner, immutable original and metadata; unsafe retries denied',async()=>{
 const u=await user(),other=await user(),r=await upload(u);const id=r.data.document.id,before=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];
 await admin.query("UPDATE document_processing_jobs SET state='failed',attempt_count=1,started_at=clock_timestamp()-interval '2 seconds',finished_at=clock_timestamp(),last_error_code='PROCESSOR_FAILED' WHERE document_id=$1",[id]);await db.query("UPDATE medical_documents SET processing_status='failed' WHERE id=$1",[id]);
 assert.ok(objects.has(before.s3_object_key));assert.equal((await request('/documents/'+id+'/download',u.token)).status,200);
 const retry=createPatientProcessingRepository(db,{patientId:u.id,uploadCutoff:'2020-01-01T00:00:00.000Z'});assert.equal(await retry.retry(id,other.id),false);assert.equal(await retry.retry(id,u.id),true);assert.equal(await retry.retry(id,u.id),false);
 const after=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];for(const key of ['patient_id','s3_bucket','s3_object_key','sha256','size_bytes','original_filename','document_date'])assert.equal(after[key],before[key]);assert.equal(after.processing_status,'processing');assert.deepEqual(objects.get(before.s3_object_key),pdf);
 await assert.rejects(db.query('UPDATE medical_documents SET patient_id=$2 WHERE id=$1',[id,other.id]),{code:'23514'});await assert.rejects(db.query("UPDATE medical_documents SET sha256=repeat('a',64) WHERE id=$1",[id]),{code:'23514'});
 // The public retry endpoint remains gated by the existing canary approval contract.
 assert.equal((await request('/documents/'+id+'/processing-retries',u.token,{})).status,503);
});
test('M03-19 extraction evidence completion does not mark aggregate OCR/AI work complete',async()=>{
 const u=await user(),r=await upload(u),id=r.data.document.id,claim=randomUUID();const hash=r.data.document.sha256;
 await admin.query("UPDATE document_processing_jobs SET state='running',attempt_count=1,started_at=clock_timestamp(),lease_token=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_deadline_at=clock_timestamp()+interval '60 seconds' WHERE document_id=$1",[id,claim]);
 const metadata={schemaVersion:1,method:'pdf_text',extractor:{name:'synthetic',version:'test-v1'},source:{sha256:hash,pageCount:1,pages:[{page:1,method:'pdf_text'}]}};
 await assert.rejects(db.query('SELECT persist_document_extraction($1,$2,$3,$4,$5,$6)',[id,u.id,claim,'Synthetic extraction fixture',{...metadata,source:{...metadata.source,sha256:'a'.repeat(64)}},'test-v1']),{code:'23514'});
 assert.equal((await db.query('SELECT persist_document_extraction($1,$2,$3,$4,$5,$6) AS ok',[id,u.id,claim,'Synthetic extraction fixture',metadata,'test-v1'])).rows[0].ok,true);
 assert.equal((await admin.query('SELECT state FROM document_processing_jobs WHERE document_id=$1',[id])).rows[0].state,'completed');assert.equal((await request('/documents/'+id,u.token)).data.document.processing_status,'processing');
 assert.equal((await request('/documents/'+id+'/processing',u.token)).data.processing.stage,'extraction');
 const readiness=(await request('/documents/'+id+'/readiness',u.token)).data.readiness;assert.equal(readiness.extraction.status,'completed');assert.equal(readiness.downstream_completion,'not_qualified');assert.equal(readiness.ready_for_extraction,false);assert.equal(readiness.processing_status,'processing');
 await db.query("UPDATE medical_documents SET processing_status='completed' WHERE id=$1",[id]);assert.equal((await request('/documents/'+id,u.token)).data.document.processing_status,'processing');
});
test('M03-22 configured decoder quotas and active PDF content reject before storage',async()=>{
 const u=await user(),n=puts,png=await sharp({create:{width:40,height:40,channels:3,background:'white'}}).png().toBuffer();
 for(const [bytes,name,mime]of [[png,'large.png','image/png'],[syntheticDigitalPdf([[],[],[]]),'pages.pdf','application/pdf'],[syntheticDigitalPdf([[]],{javascript:true}),'active.pdf','application/pdf']] as const)assert.equal((await upload(u,bytes,name,mime)).status,422);
 assert.equal(puts,n);
});
test('M03-24 owner retry API admits one transition under races without canary approval or processor activation',async()=>{
 const u=await user(),other=await user(),r=await upload(u),id=r.data.document.id;
 const original=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];
 await admin.query("UPDATE document_processing_jobs SET state='failed',attempt_count=1,started_at=clock_timestamp()-interval '2 seconds',finished_at=clock_timestamp(),last_error_code='PROCESSOR_TIMEOUT' WHERE document_id=$1",[id]);await db.query("UPDATE medical_documents SET processing_status='failed' WHERE id=$1",[id]);
 assert.equal((await request('/documents/'+id+'/readiness',u.token)).data.readiness.retry_allowed,true);
 assert.equal((await request('/documents/'+id+'/retries',other.token,{})).status,404);
 assert.equal((await request('/documents/'+id+'/retries',u.token,{patient_id:other.id})).status,400);
 const results=await Promise.all([request('/documents/'+id+'/retries',u.token,{}),request('/documents/'+id+'/retries',u.token,{})]);assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);
 const after=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];for(const key of ['patient_id','s3_bucket','s3_object_key','sha256','size_bytes','original_filename'])assert.equal(after[key],original[key]);
 const job=(await admin.query('SELECT * FROM document_processing_jobs WHERE document_id=$1',[id])).rows[0];assert.equal(job.state,'retry_wait');assert.equal(job.attempt_count,1);assert.equal(job.lease_token,null);
 assert.equal((await request('/documents/'+id+'/processing-retries',u.token,{})).status,503);
 assert.equal((await admin.query('SELECT count(*)::int n FROM extracted_medical_text WHERE document_id=$1',[id])).rows[0].n,0);
});
test('M03-25 current account/session state denies every document operation for restricted/deleted/invalid accounts',async()=>{
 for(const state of ['suspended','deleted','deletion_pending','deletion_restricted','revoked','unverified']){
  const u=await user(),r=await upload(u);assert.equal(r.status,201);const id=r.data.document.id;
  await db.query('UPDATE patients SET account_status=$2 WHERE id=$1',[u.id,state]);const before=puts;
  for(const url of ['/documents','/documents/'+id,'/documents/'+id+'/download','/documents/'+id+'/readiness'])assert.equal((await request(url,u.token)).status,401);
  assert.equal((await request('/documents/'+id,u.token,{hospital_name:'Denied Hospital'},'PATCH')).status,401);
  assert.equal((await request('/documents/'+id+'/retries',u.token,{})).status,401);assert.equal((await upload(u)).status,401);assert.equal(puts,before);
 }
 assert.equal((await request('/documents',await tokens.issue(randomUUID()))).status,401);
});
test('M03-26 simulated OCR/category/embedding/summary failures preserve source through the real generic failure repository',async()=>{
 const u=await user();const processor=createProcessingRepository(db,{maxAttempts:3,leaseMs:30000,attemptTimeoutMs:60000,heartbeatMs:5000,retryBaseMs:1000,retryMaxMs:1000,recoveryBatchSize:1},u.id);
 for(const stage of ['ocr','categorization','embedding','summary']){
  const r=await upload(u),id=r.data.document.id,token=randomUUID();assert.equal(r.status,201);
  const before=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];
  await admin.query("UPDATE document_processing_jobs SET state='running',attempt_count=1,started_at=clock_timestamp(),lease_token=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_deadline_at=clock_timestamp()+interval '60 seconds' WHERE document_id=$1",[id,token]);
  let failureRecorded=false;try{await Promise.reject(Error('synthetic '+stage+' failure'));}catch{failureRecorded=await processor.fail({documentId:id,patientId:u.id,token},'PROCESSOR_FAILED',false);}assert.equal(failureRecorded,true);
  const failed=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];assert.equal(failed.processing_status,'failed');for(const key of ['patient_id','s3_bucket','s3_object_key','sha256','size_bytes'])assert.equal(failed[key],before[key]);assert.deepEqual(objects.get(before.s3_object_key),pdf);
  assert.equal((await request('/documents/'+id+'/download',u.token)).status,200);const readiness=(await request('/documents/'+id+'/readiness',u.token)).data.readiness;assert.equal(readiness.processing_status,'failed');assert.equal(readiness.retry_allowed,true);assert.equal(readiness.downstream_completion,'not_qualified');
  assert.equal((await request('/documents/'+id+'/retries',u.token,{})).status,202);assert.deepEqual(objects.get(before.s3_object_key),pdf);
 }
});
test('M03-27 unsafe retry states and budgets are denied; readiness is owner isolated and truthful',async()=>{
 for(const [code,attempts]of [['INVALID_INPUT',1],['PROCESSOR_FAILED',3]] as const){
  const u=await user(),r=await upload(u),id=r.data.document.id;
  await admin.query("UPDATE document_processing_jobs SET state='failed',attempt_count=$2,started_at=clock_timestamp(),finished_at=clock_timestamp(),last_error_code=$3 WHERE document_id=$1",[id,attempts,code]);await db.query("UPDATE medical_documents SET processing_status='failed' WHERE id=$1",[id]);
  assert.equal((await request('/documents/'+id+'/retries',u.token,{})).status,409);assert.equal((await request('/documents/'+id+'/readiness',u.token)).data.readiness.retry_allowed,false);
 }
 const u=await user(),b=await user(),r=await upload(u),id=r.data.document.id;const readiness=(await request('/documents/'+id+'/readiness',u.token)).data.readiness;
 assert.equal(readiness.original_integrity,'recorded_at_upload');assert.equal(readiness.ready_for_extraction,true);assert.equal(readiness.extraction.status,'queued');assert.equal(readiness.processing_status,'processing');assert.equal(readiness.downstream_completion,'not_qualified');assert.equal(readiness.retry_allowed,false);
 assert.equal((await request('/documents/'+id+'/retries',u.token,{})).status,409);assert.equal((await request('/documents/'+id+'/readiness',b.token)).status,404);
 assert.equal((await request('/documents/'+id+'/readiness?url=https://example.invalid',u.token)).status,400);
 assert.equal((await request('/documents/'+id+'/retries?patient_id='+b.id,u.token,{})).status,400);
});
test('M03-28 account restriction during original acquisition denies content before streaming',async()=>{
 const u=await user(),r=await upload(u);assert.equal(r.status,201);
 acquisitionHook=async()=>{await db.query("UPDATE patients SET account_status='deletion_restricted' WHERE id=$1",[u.id]);};
 try{const denied=await request('/documents/'+r.data.document.id+'/download',u.token);assert.equal(denied.status,401);assert.equal(JSON.stringify(denied.data).includes('%PDF'),false);}finally{acquisitionHook=undefined;}
});
test('M03-29 retry rate budget is bounded and unknown legacy source integrity cannot be queued',async()=>{
 const u=await user(),r=await upload(u);assert.equal(r.status,201);for(let i=0;i<5;i++)assert.equal((await request('/documents/'+r.data.document.id+'/retries',u.token,{})).status,409);
 assert.equal((await request('/documents/'+r.data.document.id+'/retries',u.token,{})).status,429);
 await admin.query("UPDATE patients SET email_verified_at=clock_timestamp(),account_status='active' WHERE id=$1",[legacyPatient]);
 const session=await security.login(legacyPatient,fixtureHash);assert.ok(session);const access=await tokens.issue(legacyPatient,session.sessionId);
 await admin.query("INSERT INTO document_processing_jobs(document_id,patient_id,state,attempt_count,started_at,finished_at,last_error_code) VALUES($1,$2,'failed',1,clock_timestamp(),clock_timestamp(),'PROCESSOR_FAILED')",[legacyId,legacyPatient]);await db.query("UPDATE medical_documents SET processing_status='failed' WHERE id=$1",[legacyId]);
 const readiness=(await request('/documents/'+legacyId+'/readiness',access)).data.readiness;assert.equal(readiness.original_integrity,'unverified');assert.equal(readiness.ready_for_extraction,false);assert.equal(readiness.retry_allowed,false);assert.equal((await request('/documents/'+legacyId+'/retries',access,{})).status,409);
});

import {createGuardianRepository} from '../guardians/repository.js';
import {createDocumentRepository} from '../documents/repository.js';
import {createSharingRepository} from '../sharing/repository.js';
import {createSharingRoutes} from '../sharing/routes.js';
import {sharingConfig} from '../sharing/config.js';
import {createSecurityEmailDelivery,type ProviderMessage} from '../auth/security-email.js';
import {createSummaryJobRepository} from '../summaries/jobs.js';
import {sourceCatalogue} from '../summaries/catalogue.js';
import {createSummaryClient,fakeSummaryRecipe,summaryServicePath} from '../summaries/client.js';
import {createSummaryExecutor,defaultSummaryExecutorConfig} from '../summaries/executor.js';
import {canonicalSummaryJson} from '../summaries/validation.js';
import {createRagRoutes} from '../rag/routes.js';
import {createRagClient,embeddingModel} from '../rag/client.js';
import {createRagRepository} from '../rag/repository.js';
import {createRagService} from '../rag/service.js';
import {createSummaryRoutes} from '../summaries/routes.js';
import {privateSummaryTransport} from '../summaries/http-transport.js';
import {createHistoryService} from '../summaries/history.js';
// Phase 4 focused integration; reuse document/session fixture foundations.
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
import {createTimelineRoutes} from '../timeline/routes.js';
import {createTimelineService} from '../timeline/service.js';
import {createProcessingService} from '../processing/service.js';
import {createOriginalAccess} from '../processing/retrieval.js';
import {createProcessingWorker} from '../processing/worker.js';
import {createPythonOcrProcessor} from '../processing/python-processor.js';
import {syntheticScan,syntheticScannedPdf} from '../processing/fixtures/ocr-fixtures.js';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
let python:ChildProcess,ocrUrl:string;
const serviceToken=randomBytes(32).toString('hex');
async function startPython(){
 const portProbe=createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');const address=portProbe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(r=>portProbe.close(()=>r()));
 ocrUrl='http://127.0.0.1:'+port;
 python=spawn(process.env.PHASE3_PYTHON!,['-m','rag_service.entry'],{cwd:new URL('../../../ai-service/',import.meta.url),env:{PATH:'/usr/bin:/bin',PYTHONPATH:new URL('../../../ai-service/',import.meta.url).pathname,PYTHONDONTWRITEBYTECODE:'1',RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_TOKEN:serviceToken,RAG_SERVICE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 python.stdout?.resume();python.stderr?.resume();
 for(let i=0;i<600;i++){if(python.exitCode!==null)throw Error('Synthetic Python service exited before readiness.');try{const r=await fetch(ocrUrl+'/health',{headers:{Authorization:'Bearer '+serviceToken},signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}
 throw Error('Synthetic Python service did not become ready.');
}
const processingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:120000,heartbeatMs:5000,retryBaseMs:1000,retryMaxMs:1000,recoveryBatchSize:5};

const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Test-owned socket required.');
const conn={host:socket,port:55481,database:'hw_phase6'};
const admin=new pg.Pool({...conn,user:userInfo().username}),db=new pg.Pool({...conn,user:'health_wallet_app',max:16});
const policy={...getSecurityPolicy(),resendCooldownSeconds:1,challengeRateMax:5};
const auth={jwtKey:randomBytes(32),jwtAlgorithm:'HS256' as const,jwtLifetimeSeconds:900,jwtIssuer:'phase2-test',jwtAudience:'patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:4,rateLimitWindowMs:900000,rateLimitMax:10000};
const objects=new Map<string,Buffer>();let puts=0,reads=0;let acquisitionHook:(()=>Promise<void>)|undefined;
const security=createSecurityRepository(db,policy),tokens=createTokenService(auth);
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',async put(i){puts++;const b=await readFile(i.path);assert.equal(createHash('sha256').update(b).digest('base64'),i.checksum);objects.set(i.key,b);return {versionId:'test'};},async remove(key){objects.delete(key);},async download(){throw Error('URL signing forbidden');},async readOriginal(i){reads++;if(acquisitionHook)await acquisitionHook();const b=objects.get(i.key);if(!b)throw Error('synthetic missing object');await writeFile(i.destination,b,{flag:'wx',mode:0o600});return {bytes:b.length};}};
const config={maxFileBytes:2097152,maxConcurrentUploads:2,uploadTimeoutMs:30000,validationTimeoutMs:15000,maxImagePixels:2000000,maxPdfPages:5,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const sharing=sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid'})!;
const mails:ProviderMessage[]=[];
const delivery=createSecurityEmailDelivery(db,{mode:'sandbox',endpoint:'http://127.0.0.1/unused',from:'security@example.invalid',encryptionKey:randomBytes(32),timeoutMs:1000,retrySeconds:1,maxAttempts:3},{async send(message){mails.push(message);return {messageReference:'synthetic-delivery'};}});
let fixtureHash:string;
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string,legacyId:string,legacyPatient:string;
before(async()=>{
 assert.equal((await stat(socket!)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_phase6');}finally{await bootstrap.end();}
 await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator');
 await admin.query('CREATE EXTENSION vector');
 fixtureHash=await createPasswordService(auth).hash('Synthetic fixture passphrase 498!');
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,18);
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
  if(file.startsWith('0008')||file.startsWith('0009')||file.startsWith('0010')||file.startsWith('0011')){
   const probe=await admin.connect();try{await probe.query('BEGIN');await probe.query('SET LOCAL ROLE health_wallet_migrator');await probe.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await probe.query('ROLLBACK');}finally{probe.release();}
   assert.equal((await admin.query("SELECT to_regclass($1) AS relation",[file.startsWith('0011')?'public.doctor_share_sessions':file.startsWith('0010')?'public.rag_chunk_embeddings':file.startsWith('0009')?'public.summary_history_requests':'public.document_processing_results'])).rows[0].relation,null);
   assert.equal((await admin.query('SELECT s3_object_key FROM medical_documents WHERE id=$1',[legacyId])).rows[0].s3_object_key,'legacy/key.pdf');
  }
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE health_wallet_migrator');await c.query("SET LOCAL search_path=public,pg_catalog;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='30s'");await c.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 await startPython();
 const app=express();app.use(express.json());
 app.use('/api/v1',createSharingRoutes(db,auth,config,storage,{config:sharing,mailer:delivery.mailer,ragClient:ragClient()}));
 app.use('/api/v1',createRagRoutes(db,auth,{client:ragClient()}));
 app.use('/api/v1/timeline',createTimelineRoutes(db,auth));
 app.use('/api/v1/documents',createDocumentRoutes(db,auth,config,storage));app.use('/api/v1',createProcessingRoutes(db,auth));app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port+'/api/v1';
});
after(async()=>{if(python&&python.exitCode===null){python.kill();await once(python,'exit').catch(()=>{});}if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await db.end();await admin.end();});
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

async function processed(u:Awaited<ReturnType<typeof user>>,text='Glucose: 90 mg/dL',date='2026-01-02',method:'pdf_text'|'ocr'='pdf_text'){
 // M09 fixtures use the qualified document repository, avoiding repeated upload/native validation.
 const key=storage.prefix+randomUUID()+'.pdf';objects.set(key,pdf);
 const d=await createDocumentRepository(db).insert({id:randomUUID(),patientId:u.id,bucket:storage.bucket,key,name:'synthetic.pdf',type:'pdf',mime:'application/pdf',bytes:pdf.length,checksum:createHash('sha256').update(pdf).digest('base64'),category:'lab_report',hospital_name:'Synthetic Hospital',document_date:date});
 const service=createProcessingService(createProcessingRepository(db,processingConfig,u.id)),job=await service.claim();assert.ok(job);
 assert.equal(await service.persistExtraction({documentId:d.id,patientId:u.id,token:job.lease_token!},{text,method,extractor:{name:'phase4-synthetic',version:'v1'},source:{sha256:d.sha256,pageCount:1,pages:[{page:1,method,...(method==='ocr'?{confidence:50}:{})}]}}),true);
 return d;
}
function ragClient(){return createRagClient({provider:'synthetic-offline',url:ocrUrl+'/internal/v1/rag/',token:serviceToken});}
const index=(u:Awaited<ReturnType<typeof user>>,id:string)=>request('/documents/'+id+'/rag-index',u.token,{});
const ask=(u:Awaited<ReturnType<typeof user>>,question='What are my glucose results?',extra={})=>request('/rag/queries',u.token,{question,...extra});
async function scoped<T>(u:Awaited<ReturnType<typeof user>>,fn:(c:pg.PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.rag_patient_id',$1,true)",[u.id]);return await fn(c);}finally{await c.query('ROLLBACK');c.release();}}
async function grant(u:Awaited<ReturnType<typeof user>>,ids:string[],kind='unique_link'){
 const r=await request('/sharing/grants',u.token,{document_ids:ids,share_type:kind});assert.equal(r.status,201);
 return {...r.data,ref:r.data.share_url.split('/share/')[1]};
}
const doctorEmail='doctor@example.invalid';
async function challenge(g:any,email=doctorEmail){
 const r=await request('/sharing/otp',undefined,{share_token:g.ref,email,name:'Synthetic Doctor',organization:'Synthetic Clinic'});assert.equal(r.status,202);
 await delivery.drain();const mail=[...mails].reverse().find(m=>m.to===email&&m.text.includes(r.data.challenge_id));assert.ok(mail);
 const otp=mail.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(otp);assert.equal(mail.text.includes('Glucose'),false);
 return {share_token:g.ref,email,challenge_id:r.data.challenge_id,otp};
}
async function doctor(g:any){const code=await challenge(g);const r=await request('/sharing/otp/verify',undefined,code);assert.equal(r.status,200);return {token:r.data.access_token as string,code};}
async function expired(table:string,id:string){assert.ok(['doctor_sharing_grants','doctor_share_sessions','patient_auth_challenges'].includes(table));await admin.query(`UPDATE ${table} SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[id]);}
async function allDenied(token:string,id:string){for(const path of ['/records','/records/'+id,'/records/'+id+'/view','/records/'+id+'/download','/timeline','/records/'+id+'/summary','/history-summary','/rag/queries/'+randomUUID()])assert.equal((await request('/doctor'+path,token)).status,403,path);assert.equal((await request('/doctor/rag/queries',token,{question:'What are my glucose results?'})).status,403);}
async function summary(u:Awaited<ReturnType<typeof user>>,id:string){
 const repo=createSummaryJobRepository(db,u.id),snapshot=await repo.captureSnapshot(id),{input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));await repo.enqueue(snapshot.id,sourceCatalogue(snapshot),pipeline);
 const client=createSummaryClient({enabled:true,token:serviceToken},async r=>{const input=JSON.parse(Buffer.from(r.body).toString());const output={schema_version:1,kind:'medical-summary-output',scope:input.scope,reported_findings:input.facts,educational_explanations:['glucose'],uncertainty:{codes:['page_locations_unavailable'],fact_ids:[]},catalogue_coverage:'all_catalogued',provenance:fakeSummaryRecipe(r.headers['x-summary-input-sha256'])};return {status:200,body:(async function*(){yield Buffer.from(canonicalSummaryJson(output));})()};});
 const executor=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:u.id},{repository:repo,client});assert.equal(await executor.runOnce(),'completed');
}
test('P6-01 configuration defaults, origin and bounds',()=>{
 assert.equal(sharing.qrSeconds,3600);assert.equal(sharing.linkSeconds,86400);assert.equal(sharing.otpSeconds,600);assert.equal(sharing.sessionSeconds,3600);
 assert.equal(sharingConfig({}),undefined);assert.throws(()=>sharingConfig({SHARING_PUBLIC_ORIGIN:'http://example.invalid'}));assert.throws(()=>sharingConfig({SHARING_PUBLIC_ORIGIN:sharing.origin,SHARING_OTP_SECONDS:'0'}));
});
test('P6-02 exact owner selections; real QR SVG and opaque link; no pre-OTP medical access',async()=>{
 const u=await user(),other=await user(),a=await processed(u),b=await processed(other);
 for(const ids of [[],[a.id,a.id],[b.id]])assert.equal((await request('/sharing/grants',u.token,{document_ids:ids,share_type:'qr_code'})).status,400);
 await admin.query("UPDATE medical_documents SET access_state='restricted' WHERE id=$1",[a.id]);assert.equal((await request('/sharing/grants',u.token,{document_ids:[a.id],share_type:'qr_code'})).status,400);await admin.query("UPDATE medical_documents SET access_state='active' WHERE id=$1",[a.id]);
 const deleted=await processed(u);assert.equal((await request('/documents/'+deleted.id,u.token,undefined,'DELETE')).status,200);assert.equal((await request('/sharing/grants',u.token,{document_ids:[deleted.id],share_type:'qr_code'})).status,400);
 for(const kind of ['qr_code','unique_link']){const g=await grant(u,[a.id],kind);assert.match(g.ref,/^sh1\.[a-f0-9]{64}$/);if(kind==='qr_code')assert.match(g.qr_svg,/<svg/);assert.equal(g.share_url.includes(u.id),false);const r=await request('/sharing/open',undefined,{share_token:g.ref});assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data).sort(),['expires_at','requires_email_otp','sharing_method','success']);await allDenied(g.ref,a.id);const row=(await admin.query('SELECT extract(epoch from expires_at-created_at)::int ttl FROM doctor_sharing_grants WHERE id=$1',[g.grant.id])).rows[0];assert.ok(Math.abs(row.ttl-(kind==='qr_code'?3600:86400))<=1);}
});
test('P6-03 encrypted existing email queue, email/grant binding, valid single-use OTP and temporary session',async()=>{
 const u=await user(),a=await processed(u),g=await grant(u,[a.id]),other=await grant(u,[a.id]),c=await challenge(g);
 const stored=(await admin.query('SELECT token_hash,extract(epoch from expires_at-created_at)::int ttl FROM patient_auth_challenges WHERE id=$1',[c.challenge_id])).rows[0];assert.notEqual(stored.token_hash,c.otp);assert.ok(Math.abs(stored.ttl-600)<=1);
 assert.equal((await request('/sharing/otp/verify',undefined,{...c,email:'wrong@example.invalid'})).status,403);assert.equal((await request('/sharing/otp/verify',undefined,{...c,share_token:other.ref})).status,403);
 assert.equal((await request('/sharing/otp/verify',undefined,{...c,otp:c.challenge_id+'.'+'0'.repeat(64)})).status,403);
 const r=await request('/sharing/otp/verify',undefined,c);assert.equal(r.status,200);assert.equal((await request('/sharing/otp/verify',undefined,c)).status,403);assert.equal((await request('/doctor/records',r.data.access_token)).status,200);
 assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads p JOIN patient_security_email_deliveries d ON d.id=p.delivery_id WHERE d.challenge_id=$1',[c.challenge_id])).rows[0].n,0);
});
test('P6-04 expired OTP, attempts, identity validation, resend cooldown and rate limit',async()=>{
 const u=await user(),a=await processed(u),g=await grant(u,[a.id]);
 assert.equal((await request('/sharing/otp',undefined,{share_token:g.ref,email:doctorEmail})).status,400);
 const c=await challenge(g);await expired('patient_auth_challenges',c.challenge_id);assert.equal((await request('/sharing/otp/verify',undefined,c)).status,403);
 const g2=await grant(u,[a.id]),c2=await challenge(g2);for(let i=0;i<5;i++)assert.equal((await request('/sharing/otp/verify',undefined,{...c2,otp:c2.challenge_id+'.'+'1'.repeat(64)})).status,403);assert.equal((await request('/sharing/otp/verify',undefined,c2)).status,403);
 const g3=await grant(u,[a.id]);await challenge(g3);for(let i=0;i<4;i++)assert.equal((await request('/sharing/otp',undefined,{share_token:g3.ref,email:doctorEmail,name:'Doctor'})).status,403);assert.equal((await request('/sharing/otp',undefined,{share_token:g3.ref,email:doctorEmail,name:'Doctor'})).status,429);
});
test('P6-05 A/C-only metadata, private originals, timeline, scoped summary/history and RAG',async()=>{
 const u=await user(),foreign=await user(),a=await processed(u,'Glucose: 90 mg/dL'),b=await processed(u,'Glucose: 999 mg/dL'),c=await processed(u,'Glucose: 110 mg/dL'),d=await processed(foreign,'Glucose: 888 mg/dL');
 for(const doc of [a,b,c])assert.equal((await index(u,doc.id)).status,200);assert.equal((await index(foreign,d.id)).status,200);
 for(const doc of [a,b,c])await summary(u,doc.id);
 const g=await grant(u,[a.id,c.id]),s=await doctor(g);
 const records=await request('/doctor/records',s.token);assert.equal(records.status,200);assert.deepEqual(records.data.documents.map((x:any)=>x.id).sort(),[a.id,c.id].sort());assert.equal(JSON.stringify(records.data).includes('s3_object_key'),false);
 for(const id of [a.id,c.id])for(const op of ['', '/view','/download'])assert.equal((await request('/doctor/records/'+id+op,s.token)).status,200);
 for(const id of [b.id,d.id])for(const op of ['', '/view','/download','/summary'])assert.equal((await request('/doctor/records/'+id+op,s.token)).status,403);
 assert.equal((await request('/doctor/records?category=prescription',s.token)).data.documents.length,0);assert.equal((await request('/doctor/records?patient_id='+foreign.id,s.token)).status,400);
 const timeline=await request('/doctor/timeline',s.token);assert.equal(timeline.status,200);assert.deepEqual(timeline.data.entries.map((x:any)=>x.source_document_id).sort(),[a.id,c.id].sort());
 const history=await request('/doctor/history-summary',s.token);assert.equal(history.status,200);assert.deepEqual(history.data.entries.map((x:any)=>x.source_document_id).sort(),[a.id,c.id].sort());assert.equal(history.data.scope,'selected_records_only');const report=await request('/doctor/records/'+a.id+'/summary',s.token);assert.equal(report.status,200);assert.ok(report.data.summary.text.includes('90 mg/dL'));assert.equal(history.data.entries.map((x:any)=>x.summary?.text??'').join('\n').includes('999 mg/dL'),false);
 const answer=await request('/doctor/rag/queries',s.token,{question:'What are my glucose results?'});assert.equal(answer.status,200);assert.equal(answer.data.result.status,'answered');const serialized=answer.data.result.answer;assert.equal(serialized.includes('999 mg/dL'),false);assert.equal(serialized.includes('888 mg/dL'),false);assert.ok(answer.data.result.citations.every((x:any)=>[a.id,c.id].includes(x.document_id)));
 const sources=(await admin.query('SELECT document_id FROM rag_interaction_sources WHERE interaction_id=$1',[answer.data.result.id])).rows;assert.ok(sources.length>0);assert.ok(sources.every(x=>[a.id,c.id].includes(x.document_id)));
 const g2=await grant(u,[b.id]),s2=await doctor(g2);assert.equal((await request('/doctor/rag/queries/'+answer.data.result.id,s2.token)).status,404);assert.equal((await request('/rag/queries/'+answer.data.result.id,u.token)).status,404);
 const none=await request('/doctor/rag/queries',s.token,{question:'What medication should I take?'});assert.equal(none.status,200);assert.notEqual(none.data.result.status,'answered');
 const session=(await admin.query('SELECT token_hash FROM doctor_share_sessions WHERE grant_id=$1',[g.grant.id])).rows[0];const cx=await db.connect();try{await cx.query('BEGIN');await cx.query("SELECT set_config('app.rag_patient_id',$1,true),set_config('app.doctor_session_hash',$2,true)",[u.id,session.token_hash]);assert.equal((await cx.query('SELECT count(*)::int n FROM rag_chunk_embeddings WHERE document_id=$1',[b.id])).rows[0].n,0);}finally{await cx.query('ROLLBACK');cx.release();}
 assert.equal((await request('/sharing/grants/'+g.grant.id+'/revoke',foreign.token,{})).status,404);assert.equal((await request('/sharing/grants/'+g.grant.id+'/revoke',u.token,{})).status,200);assert.equal((await request('/sharing/grants/'+g.grant.id+'/revoke',u.token,{})).status,200);await allDenied(s.token,a.id);assert.equal((await request('/sharing/open',undefined,{share_token:g.ref})).status,403);assert.equal((await request('/sharing/otp/verify',undefined,s.code)).status,403);
});
test('P6-06 grant/session expiry and expired QR replay fail without cleanup',async()=>{
 const u=await user(),a=await processed(u);
 for(const kind of ['qr_code','unique_link']){const g=await grant(u,[a.id],kind),s=await doctor(g);await expired('doctor_sharing_grants',g.grant.id);await allDenied(s.token,a.id);assert.equal((await request('/sharing/open',undefined,{share_token:g.ref})).status,403);assert.equal((await request('/sharing/otp/verify',undefined,s.code)).status,403);}
 const g=await grant(u,[a.id]),s=await doctor(g);const id=(await admin.query('SELECT id FROM doctor_share_sessions WHERE grant_id=$1',[g.grant.id])).rows[0].id;await expired('doctor_share_sessions',id);await allDenied(s.token,a.id);
});
test('P6-07 deletion, restriction and patient suspension/deletion/security version override sessions',async()=>{
 for(const state of ['restricted','deleted','suspended','account-deleted','version']){const u=await user(),a=await processed(u),g=await grant(u,[a.id]),s=await doctor(g);
 if(state==='restricted')await admin.query("UPDATE medical_documents SET access_state='restricted' WHERE id=$1",[a.id]);
 else if(state==='deleted')assert.equal((await request('/documents/'+a.id,u.token,undefined,'DELETE')).status,200);
 else if(state==='version')await admin.query('UPDATE patients SET security_version=security_version+1 WHERE id=$1',[u.id]);
 else await admin.query('UPDATE patients SET account_status=$2 WHERE id=$1',[u.id,state==='suspended'?'suspended':'deleted']);await allDenied(s.token,a.id);}
});
test('P6-08 revocation during original acquisition denies bytes and audit is append-only',async()=>{
 const u=await user(),a=await processed(u),g=await grant(u,[a.id]),s=await doctor(g);acquisitionHook=async()=>{acquisitionHook=undefined;assert.equal((await request('/sharing/grants/'+g.grant.id+'/revoke',u.token,{})).status,200);};try{assert.equal((await request('/doctor/records/'+a.id+'/view',s.token)).status,403);}finally{acquisitionHook=undefined;}
 const events=(await db.query('SELECT DISTINCT event FROM doctor_share_events')).rows.map(x=>x.event);for(const e of ['created','opened','otp_requested','otp_verified','otp_failed','authorized','denied','download','revoked','expiry_denied'])assert.ok(events.includes(e),e);await assert.rejects(db.query("UPDATE doctor_share_events SET event='denied'"),(e:any)=>e.code==='42501');
});
test('P6-09 resend invalidates previous OTP/session and optional organization is accepted',async()=>{
 const u=await user(),a=await processed(u),g=await grant(u,[a.id]),old=await doctor(g);await admin.query("UPDATE doctor_otp_challenges SET created_at=clock_timestamp()-interval '61 seconds' WHERE grant_id=$1",[g.grant.id]);
 const r=await request('/sharing/otp',undefined,{share_token:g.ref,email:doctorEmail,name:'Doctor'});assert.equal(r.status,202);await allDenied(old.token,a.id);assert.equal((await request('/sharing/otp/verify',undefined,old.code)).status,403);await delivery.drain();
 const mail=[...mails].reverse().find(m=>m.text.includes(r.data.challenge_id));assert.ok(mail);const otp=mail.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(otp);const fresh=await request('/sharing/otp/verify',undefined,{share_token:g.ref,email:doctorEmail,challenge_id:r.data.challenge_id,otp});assert.equal(fresh.status,200);assert.equal((await request('/doctor/records',fresh.data.access_token)).status,200);
});

test('P6-10 existing verification, password reset and guardian encrypted-email purposes still dispatch',async()=>{
 const active=await user(),unverified=await user();await admin.query("UPDATE patients SET account_status='unverified',email_verified_at=NULL WHERE id=$1",[unverified.id]);
 const verification=await security.issueChallenge(unverified.email,'verify_email',delivery.mailer.enqueue);assert.ok(verification);
 const reset=await security.issueChallenge(active.email,'reset_password',delivery.mailer.enqueue);assert.ok(reset);
 const guardian=await createGuardianRepository(db,policy,delivery.mailer).nominate(active.who,'guardian@example.invalid');assert.ok(guardian);
 const before=mails.length;await delivery.drain();const sent=mails.slice(before);assert.equal(sent.length,3);assert.ok(sent.some(m=>m.to===unverified.email));assert.ok(sent.some(m=>m.to===active.email));assert.ok(sent.some(m=>m.to==='guardian@example.invalid'));
});

test('P6-11 revocation during RAG generation prevents publication and preserves original/index',async()=>{
 const u=await user(),a=await processed(u);assert.equal((await index(u,a.id)).status,200);const g=await grant(u,[a.id]),s=await doctor(g),repo=createSharingRepository(db,sharing),scope=await repo.resolve(s.token),real=ragClient();
 const raced={...real,call:async(...args:Parameters<typeof real.call>)=>{const result=await real.call(...args);if(args[0]==='answers')assert.equal((await request('/sharing/grants/'+g.grant.id+'/revoke',u.token,{})).status,200);return result;}};
 await assert.rejects(createRagService(db,u.id,raced,async()=>{await repo.resolve(s.token);},scope).query('What are my glucose results?'),(e:any)=>e.status===403);
 assert.equal((await admin.query('SELECT count(*)::int n FROM rag_interactions WHERE sharing_grant_id=$1',[g.grant.id])).rows[0].n,0);assert.equal((await request('/documents/'+a.id+'/download',u.token)).status,200);
});

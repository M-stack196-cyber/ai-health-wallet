// Phase R9: V-23 end-to-end chain, synthetic data only, disposable local PostgreSQL 16 (pgvector) and a local Python RAG service.
// Run: npm run r9:test   (from backend/, after: source ~/.local/share/hw-test/env.sh)
//
// What is real here: the HTTP routes (register, verify, login, guardian, upload, processing status, summary, RAG, sharing,
// doctor OTP, guardian report), the real PDF-text and Tesseract OCR processors, PostgreSQL with row security, pgvector and the
// Python RAG service. What is synthetic: the email transport (captured in memory), object storage (a Map), the summary model
// (fake recipe), the RAG provider (synthetic-offline), the serious-finding rule (demo rule) and the guardian enrolment
// (synthetic fixture). The digest window is moved with SQL instead of waiting 24 hours.
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import express from 'express';
import pg from 'pg';
import {createPatientRoutes} from '../auth/routes.js';
import {createPasswordService} from '../auth/passwords.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {createSecurityEmailDelivery,type ProviderMessage} from '../auth/security-email.js';
import {createDocumentRoutes} from '../documents/routes.js';
import type {DocumentStorage} from '../documents/storage.js';
import {createProcessingRepository} from '../processing/repository.js';
import {createProcessingService} from '../processing/service.js';
import {createProcessingRoutes} from '../processing/api.js';
import {createProcessingWorker} from '../processing/worker.js';
import {createOcrProcessor} from '../processing/ocr-processor.js';
import {createOriginalAccess} from '../processing/retrieval.js';
import {getOcrConfig,getDigitalPdfConfig} from '../processing/config.js';
import {getDocumentConfig} from '../config/documents.js';
import {syntheticDigitalPdf} from '../processing/fixtures/pdf-fixtures.js';
import {syntheticScannedPdf} from '../processing/fixtures/ocr-fixtures.js';
import {createTimelineRoutes} from '../timeline/routes.js';
import {createSummaryRoutes} from '../summaries/routes.js';
import {createSummaryJobRepository} from '../summaries/jobs.js';
import {sourceCatalogue} from '../summaries/catalogue.js';
import {createSummaryClient,fakeSummaryRecipe} from '../summaries/client.js';
import {createSummaryExecutor,defaultSummaryExecutorConfig} from '../summaries/executor.js';
import {canonicalSummaryJson} from '../summaries/validation.js';
import {createRagRoutes} from '../rag/routes.js';
import {createRagClient} from '../rag/client.js';
import {createRagService} from '../rag/service.js';
import {createSharingRoutes} from '../sharing/routes.js';
import {sharingConfig} from '../sharing/config.js';
import {createGuardianRoutes} from '../guardians/routes.js';
import {createGuardianRepository} from '../guardians/repository.js';
import {createGuardianNotificationRoutes} from '../guardian-notifications/routes.js';
import {createGuardianNotificationService,createGuardianNotificationReader,type SyntheticGuardianProvider} from '../guardian-notifications/service.js';
import {guardianNotificationConfig} from '../guardian-notifications/config.js';
import {demoRule} from '../guardian-notifications/rules.js';
import {errorHandler} from '../http/errors.js';

const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Test-owned socket required.');
const conn={host:socket,port:55481,database:'hw_r9'},admin=new pg.Pool({...conn,user:userInfo().username}),db=new pg.Pool({...conn,user:'health_wallet_app',max:16});
const auth={jwtKey:randomBytes(32),jwtAlgorithm:'HS256' as const,jwtLifetimeSeconds:900,jwtIssuer:'r9-synthetic',jwtAudience:'patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:4,rateLimitWindowMs:900000,rateLimitMax:10000};
const policy={...getSecurityPolicy(),resendCooldownSeconds:1,challengeRateMax:100};
const objects=new Map<string,Buffer>();
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',
  async put(input){objects.set(input.key,await readFile(input.path));return {versionId:'synthetic-private'};},
  async remove(){},async download(){throw Error('No signed URLs');},
  async readOriginal(i){const bytes=objects.get(i.key);if(!bytes)throw Error('Synthetic missing object');await writeFile(i.destination,bytes,{flag:'wx',mode:0o600});return {bytes:bytes.length};}};
const documentConfig={maxFileBytes:2097152,maxConcurrentUploads:2,uploadTimeoutMs:30000,validationTimeoutMs:15000,maxImagePixels:2000000,maxPdfPages:5,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const lifecycle={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:1000,retryMaxMs:10000,recoveryBatchSize:10};
const mail:ProviderMessage[]=[];
const verification=createSecurityEmailDelivery(db,{mode:'sandbox',endpoint:'http://127.0.0.1/unused',from:'security@example.invalid',encryptionKey:randomBytes(32),timeoutMs:1000,retrySeconds:1,maxAttempts:3},
  {async send(m){mail.push(m);return {messageReference:'synthetic-verification'};}});
const guardianMail:ProviderMessage[]=[];
const guardianProvider:SyntheticGuardianProvider={mode:'synthetic-offline',async send(m){guardianMail.push(m);return {messageReference:'synthetic-medical-'+randomUUID()};}};
const settings=guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline'},randomBytes(32))!;
const notifier=createGuardianNotificationService(db,settings,guardianProvider,[demoRule]);
const notificationReader=createGuardianNotificationReader(db);
const serviceToken=randomBytes(32).toString('hex');
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string,python:ChildProcess,ragUrl:string;

async function startPython(){
  const probe=createNetServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const a=probe.address();assert.ok(a&&typeof a==='object');await new Promise<void>(r=>probe.close(()=>r()));
  ragUrl='http://127.0.0.1:'+a.port;
  const pythonPath=process.env.PHASE3_PYTHON;if(!pythonPath?.startsWith('/'))throw Error('Absolute PHASE3_PYTHON required.');
  const aiService=new URL('../../../ai-service/',import.meta.url);
  python=spawn(pythonPath,['-m','rag_service.entry'],{cwd:aiService,env:{PATH:'/usr/bin:/bin',PYTHONPATH:aiService.pathname,PYTHONDONTWRITEBYTECODE:'1',RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_TOKEN:serviceToken,RAG_SERVICE_PORT:String(a.port)},stdio:['ignore','pipe','pipe']});
  python.stdout?.resume();python.stderr?.resume();
  for(let i=0;i<600;i++){
    if(python.exitCode!==null)throw Error('Synthetic Python service exited before readiness.');
    try{if((await fetch(ragUrl+'/health',{headers:{Authorization:'Bearer '+serviceToken},signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Synthetic Python service did not become ready.');
}
before(async()=>{
  assert.equal((await stat(socket!)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
  const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
  try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_r9');}finally{await bootstrap.end();}
  await admin.query('CREATE EXTENSION vector');await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator');
  const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files){
    if(file.startsWith('0005'))await admin.query('GRANT USAGE ON SCHEMA public TO health_wallet_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('SET LOCAL ROLE health_wallet_migrator');await c.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await c.query('COMMIT');}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  await startPython();
  const ragClient=createRagClient({provider:'synthetic-offline',url:ragUrl+'/internal/v1/rag/',token:serviceToken});
  const app=express();app.use(express.json());
  const identity=createPatientRoutes(db,auth,{mailer:verification.mailer,policy});
  app.use('/api/v1/auth',identity.auth);app.use('/api/v1/patients',identity.profile);
  app.use('/api/v1/documents',createDocumentRoutes(db,auth,documentConfig,storage));
  app.use('/api/v1',createProcessingRoutes(db,auth));
  app.use('/api/v1/timeline',createTimelineRoutes(db,auth));
  app.use('/api/v1',createSummaryRoutes(db,auth,{enabled:true,database:db}));
  app.use('/api/v1',createRagRoutes(db,auth,{client:ragClient}));
  app.use('/api/v1',createSharingRoutes(db,auth,documentConfig,storage,{config:sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid'}),mailer:verification.mailer,ragClient}));
  app.use('/api/v1',createGuardianRoutes(db,auth,{mailer:verification.mailer,policy}));
  app.use('/api/v1',createGuardianNotificationRoutes(db,auth,documentConfig,storage));
  app.use(errorHandler);
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');base='http://127.0.0.1:'+address.port;
});
after(async()=>{
  if(python&&python.exitCode===null){python.kill();await once(python,'exit').catch(()=>{});}
  if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  await db.end();await admin.end();
});

async function call(path:string,options:{token?:string;body?:unknown;method?:string;form?:FormData}={}){
  const method=options.method??(options.body===undefined&&!options.form?'GET':'POST');
  const r=await fetch(base+'/api/v1'+path,{method,headers:{...(options.token?{Authorization:'Bearer '+options.token}:{}),...(options.body===undefined?{}:{'Content-Type':'application/json'})},
    body:options.form??(options.body===undefined?undefined:JSON.stringify(options.body)),signal:AbortSignal.timeout(30000)});
  const type=r.headers.get('content-type')??'';
  const data:any=type.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());
  return {status:r.status,headers:r.headers,data};
}
// The API wraps successful bodies; tolerate both shapes so the test checks content, not envelope style.
const body=(r:{data:any})=>r.data?.data??r.data;
async function emailedToken(match:(m:ProviderMessage)=>boolean){
  await verification.drain(100);const m=[...mail].reverse().find(match);assert.ok(m,'expected a synthetic email');
  const token=m.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(token);return token;
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const password='Synthetic R9 passphrase 5501!';
const step:string[]=[];
const mark=(name:string)=>{step.push(name);console.log('R9_STEP '+name);};

test('R9-V23-01 patient registration -> document upload -> OCR -> summary and RAG -> doctor sharing -> guardian digest',{timeout:420000},async()=>{
  // 1. Registration, email verification, login (real M01 routes).
  const email=randomUUID()+'@example.invalid';
  assert.ok([200,201,202].includes((await call('/auth/register',{body:{full_name:'Synthetic R9 Patient',email,password,date_of_birth:'2000-01-01',sex_gender:'prefer_not_to_say'}})).status));
  assert.equal((await call('/auth/login',{body:{email,password}})).status,401,'login must fail before the email is verified');
  assert.ok([200,204].includes((await call('/auth/verify-email',{body:{token:await emailedToken(m=>m.to===email)}})).status));
  const login=await call('/auth/login',{body:{email,password}});assert.equal(login.status,200);
  const token:string=body(login).access_token;assert.ok(token);
  const me=body(await call('/patients/me',{token})).patient;assert.equal(me.email,email);const patientId:string=me.id;
  mark('registration, email verification and login');

  // 2. Guardian invitation accepted by the guardian (real routes plus the emailed invitation).
  const guardianEmail='guardian-'+randomUUID()+'@example.invalid';
  assert.ok([200,201,202].includes((await call('/patients/me/guardian',{token,body:{email:guardianEmail}})).status));
  const guardians=createGuardianRepository(db,policy,verification.mailer);
  await guardians.accept(await emailedToken(m=>m.to===guardianEmail));
  assert.equal(body(await call('/patients/me/guardian',{token})).guardian.status,'ACTIVE');
  // Synthetic fixture enrolment must come before the uploads: the digest only covers documents uploaded after enrolment.
  await notifier.enrollSynthetic(patientId,{synthetic:true});
  mark('guardian invited and accepted');

  // 3. Upload two real files through the multipart route: a digital PDF and a scanned (image-only) PDF.
  const digital=syntheticDigitalPdf([['Glucose: 90 mg/dL','DEMO_MARKER: 5 demo_units']]);
  const scanned=await syntheticScannedPdf([{scan:'Hemoglobin: 13.5 g/dL'}]);
  const upload=async(bytes:Buffer,name:string)=>{
    const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),name);form.append('category','lab_report');form.append('hospital_name','Synthetic Hospital');form.append('document_date','2026-02-03');
    const r=await call('/documents',{token,form});assert.equal(r.status,201,JSON.stringify(r.data).slice(0,200));return body(r).document as {id:string;sha256?:string};
  };
  const textDoc=await upload(digital,'digital.pdf'),scanDoc=await upload(scanned,'scanned.pdf');
  assert.ok([...objects.values()].some(b=>sha(b)===sha(digital)),'original stored byte-for-byte');
  assert.equal(body(await call('/documents?limit=20',{token})).documents.length,2);
  mark('two documents uploaded');

  // 4. Real processing worker: digital PDF text extraction and Tesseract OCR on the scanned PDF.
  const service=createProcessingService(createProcessingRepository(db,lifecycle,patientId));
  const originals=createOriginalAccess(service,{bucket:storage.bucket,prefix:storage.prefix,readOriginal:storage.readOriginal!},getDocumentConfig(),{maxDownloadBytes:5242880,downloadTimeoutMs:15000,leaseCheckIntervalMs:100,maxConcurrentRetrievals:2});
  const worker=createProcessingWorker(service,lifecycle,createOcrProcessor(getOcrConfig(),getDigitalPdfConfig()),originals);
  assert.equal(await worker.runOnce(),'completed');assert.equal(await worker.runOnce(),'completed');assert.equal(await worker.runOnce(),'idle');
  const extracted=(await admin.query("SELECT document_id,source_metadata->>'method' AS extraction_method,extracted_text FROM extracted_medical_text WHERE patient_id=$1",[patientId])).rows;
  const byDoc=new Map(extracted.map(r=>[r.document_id,r]));
  assert.equal(byDoc.get(textDoc.id)?.extraction_method,'pdf_text');assert.match(byDoc.get(textDoc.id)?.extracted_text,/Glucose: 90 mg\/dL/);
  assert.equal(byDoc.get(scanDoc.id)?.extraction_method,'ocr');assert.match(byDoc.get(scanDoc.id)?.extracted_text,/Hemoglobin: 13\.5 g\/dL/);
  for(const d of [textDoc,scanDoc])assert.equal(body(await call('/documents/'+d.id+'/processing',{token})).processing.state??body(await call('/documents/'+d.id+'/processing',{token})).processing.status,'completed');
  mark('digital text extraction and OCR completed');

  // 5. Summaries (fake summary recipe) published and read through the patient API.
  for(const d of [textDoc,scanDoc]){
    const repo=createSummaryJobRepository(db,patientId),snap=await repo.captureSnapshot(d.id),{input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));
        await repo.enqueue(snap.id,sourceCatalogue(snap),pipeline);
    const client=createSummaryClient({enabled:true,token:randomBytes(32).toString('hex')},async r=>{
      const input=JSON.parse(Buffer.from(r.body).toString());
      return {status:200,body:(async function*(){yield Buffer.from(canonicalSummaryJson({schema_version:1,kind:'medical-summary-output',scope:input.scope,reported_findings:input.facts,educational_explanations:[...new Set<string>([...input.facts.flatMap((f:any)=>f.term_ids),...(input.source.method==='pdf_text'?[]:['ocr'])])].sort(),uncertainty:{codes:input.source.method==='pdf_text'?['page_locations_unavailable']:['ocr_used','page_locations_unavailable'],fact_ids:[]},catalogue_coverage:'all_catalogued',provenance:fakeSummaryRecipe(r.headers['x-summary-input-sha256'])}));})()};
    });
    assert.equal(await createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId},{repository:repo,client}).runOnce(),'completed');
    assert.ok(body(await call('/documents/'+d.id+'/summary',{token})).summary.text);
  }
  mark('summaries generated and read');

  // 6. RAG: index with the real Python service and ask a cited question.
  const ragClient=createRagClient({provider:'synthetic-offline',url:ragUrl+'/internal/v1/rag/',token:serviceToken});
  const rag=createRagService(db,patientId,ragClient,async()=>{});
  await rag.index(textDoc.id);await rag.index(scanDoc.id);
  const answer=body(await call('/rag/queries',{token,body:{question:'What is the Glucose value?'}})).result;
  assert.ok(answer.citations.length>0&&answer.citations.every((c:{document_id:string})=>[textDoc.id,scanDoc.id].includes(c.document_id)),'every citation points at one of the patient own documents');
  mark('RAG answer with citations');

  // 7. Doctor sharing: link, email OTP, selected record only, then revocation.
  const grant=body(await call('/sharing/grants',{token,body:{document_ids:[textDoc.id],share_type:'unique_link'}}));
  const reference:string=String(grant.share_url).split('#/share/')[1];assert.match(reference,/^sh1\.[a-f0-9]{64}$/);
  assert.equal((await call('/sharing/open',{body:{share_token:reference}})).status,200);
  const doctorEmail=randomUUID()+'@example.invalid';
  const challenge=body(await call('/sharing/otp',{body:{share_token:reference,name:'Synthetic Doctor',email:doctorEmail}})).challenge_id;
  // The emailed code is the full token (challenge id, a dot, 64 hex characters). A loose digit pattern could match inside it.
  const otpMail=await (async()=>{await verification.drain(100);const m=[...mail].reverse().find(x=>x.to===doctorEmail&&x.text.includes(challenge));assert.ok(m);return m.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];})();
  assert.ok(otpMail);
  const verify=await call('/sharing/otp/verify',{body:{share_token:reference,email:doctorEmail,challenge_id:challenge,otp:otpMail}});assert.equal(verify.status,200);
  const doctorToken:string=body(verify).access_token;
  assert.deepEqual(body(await call('/doctor/records',{token:doctorToken})).documents.map((d:{id:string})=>d.id),[textDoc.id]);
  for(const operation of ['view','download']){const original=await call('/doctor/records/'+textDoc.id+'/'+operation,{token:doctorToken});assert.equal(original.status,200);assert.equal(sha(original.data),sha(digital),'doctor gets the original bytes ('+operation+')');}
  assert.ok(body(await call('/doctor/records/'+textDoc.id+'/summary',{token:doctorToken})).summary.text);
  const doctorAnswer=body(await call('/doctor/rag/queries',{token:doctorToken,body:{question:'What is the Glucose value?'}})).result;
  assert.ok(doctorAnswer.citations.every((c:{document_id:string})=>c.document_id===textDoc.id),'doctor citations stay inside the shared record');
  assert.equal((await call('/doctor/records/'+scanDoc.id,{token:doctorToken})).status,403,'a record that was not shared is denied');
  mark('doctor viewed only the shared record');

  // 8. Actor separation: tokens do not cross between patient and doctor routes.
  assert.ok([401,403].includes((await call('/doctor/records',{token})).status),'patient token must not work on doctor routes');
  assert.ok([401,403].includes((await call('/documents',{token:doctorToken})).status),'doctor token must not work on patient routes');
  mark('patient and doctor tokens kept separate');

  // 9. Guardian digest (synthetic enrolment, synthetic rule, window moved by SQL) and the guardian report link.
  await notifier.scan(patientId);
  await admin.query("UPDATE guardian_medical_jobs SET window_start=CASE WHEN kind='routine_digest' THEN statement_timestamp()-interval '1 day' END,window_end=CASE WHEN kind='routine_digest' THEN statement_timestamp()-interval '1 second' END,not_before=statement_timestamp()-interval '1 second',next_attempt_at=statement_timestamp()-interval '1 second' WHERE patient_id=$1 AND state IN ('pending','retry_wait')",[patientId]);
  assert.deepEqual(await notifier.drain(patientId),['delivered']);
  const digest=guardianMail.filter(m=>m.to===guardianEmail);assert.equal(digest.length,1);
  assert.ok(digest[0].subject.startsWith('SYNTHETIC ONLY'));assert.ok(digest[0].text.startsWith('NON-CLINICAL DEMONSTRATION.'));
  for(const secret of [patientId,textDoc.id,scanDoc.id,email,doctorEmail,token])assert.equal(digest[0].text.includes(secret),false,'the guardian email must not leak identifiers');
  const info=await notificationReader.observe(patientId);
  assert.equal(info.jobs.filter((j:any)=>j.state==='delivered').length>=1,true);
  // OCR text must never raise a serious alert on its own (DEC: uncertain extraction stays indeterminate).
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM guardian_medical_jobs WHERE patient_id=$1 AND kind='serious_alert'",[patientId])).rows[0].n,0);
  const reportRef=digest[0].text.match(/gn1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(reportRef);
  assert.equal((await call('/guardian-notifications/reports',{body:{token:reportRef}})).status,200);
  mark('guardian digest delivered and report link opened');

  // 10. Revocation and guardian removal end access.
  assert.equal((await call('/sharing/grants/'+grant.grant.id+'/revoke',{token,body:{}})).status,200);
  assert.equal((await call('/doctor/records',{token:doctorToken})).status,403,'revoked grant stops the doctor immediately');
  assert.equal((await call('/patients/me/guardian',{token,method:'DELETE'})).status,200);
  assert.equal((await call('/guardian-notifications/reports',{body:{token:reportRef}})).status,403,'removed guardian link stops working');
  mark('revocation and guardian removal ended access');

  console.log('R9_V23 '+JSON.stringify({steps:step.length,list:step}));
  assert.equal(step.length,10);
});

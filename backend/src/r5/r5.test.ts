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
const conn={host:socket,port:55481,database:'hw_r5_email'},admin=new pg.Pool({...conn,user:userInfo().username}),db=new pg.Pool({...conn,user:'health_wallet_app',max:16});
const auth={jwtKey:randomBytes(32),jwtAlgorithm:'HS256' as const,jwtLifetimeSeconds:900,jwtIssuer:'r5-synthetic',jwtAudience:'patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:4,rateLimitWindowMs:900000,rateLimitMax:10000};
const policy={...getSecurityPolicy(),resendCooldownSeconds:1,challengeRateMax:100};
const security=createSecurityRepository(db,policy),tokens=createTokenService(auth),reader=createGuardianNotificationReader(db),objects=new Map<string,Buffer>();
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',async put(){throw Error('Fixture repository only');},async remove(){},async download(){throw Error('No signed URLs');},async readOriginal(i){const bytes=objects.get(i.key);if(!bytes)throw Error('Synthetic missing object');await writeFile(i.destination,bytes,{flag:'wx',mode:0o600});return {bytes:bytes.length};}};
const documentConfig={maxFileBytes:2097152,maxConcurrentUploads:2,uploadTimeoutMs:30000,validationTimeoutMs:15000,maxImagePixels:2000000,maxPdfPages:5,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const processingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:120000,heartbeatMs:5000,retryBaseMs:1000,retryMaxMs:1000,recoveryBatchSize:5};
const settings=guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline'},randomBytes(32))!;
import {createSecurityEmailSandbox} from '../auth/security-email-sandbox.js';
import {securityEmailConfig} from '../auth/security-email.js';
import {createSharingRoutes} from '../sharing/routes.js';
import {sharingConfig} from '../sharing/config.js';
import type {RagDatabase} from '../rag/repository.js';
import {spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
async function user(){const id=randomUUID(),email=id+'@example.invalid';await db.query("INSERT INTO patients(id,email,password_hash,full_name,email_verified_at,account_status) VALUES($1,$2,$3,'Synthetic Patient',clock_timestamp(),'active')",[id,email,fixtureHash]);const s=await security.login(id,fixtureHash);assert.ok(s);await worker().enrollSynthetic(id,{synthetic:true});return {id,email,who:{patientId:id,sessionId:s.sessionId},token:await tokens.issue(id,s.sessionId)};}
async function request(path:string,token?:string,body?:unknown,method=body===undefined?'GET':'POST'){const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await r.text();return {status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):text};}
async function guardian(u:Awaited<ReturnType<typeof user>>,active=true,replace=false){if(replace)await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 seconds' WHERE patient_id=$1 AND purpose='guardian_invitation'",[u.id]);const email=randomUUID()+'@example.invalid';const g=await guardians.nominate(u.who,email,replace);assert.ok(g);if(active)await activate(g.id);return {...g,email};}
const pdf=syntheticDigitalPdf([['Synthetic non-medical original']]);
async function document(u:Awaited<ReturnType<typeof user>>,text='Glucose: 90 mg/dL\nDEMO_MARKER: 5 demo_units',processed=true,method:'pdf_text'|'ocr'='pdf_text'){
 const key=storage.prefix+randomUUID()+'.pdf';objects.set(key,pdf);const d=await createDocumentRepository(db).insert({id:randomUUID(),patientId:u.id,bucket:storage.bucket,key,name:'synthetic.pdf',type:'pdf',mime:'application/pdf',bytes:pdf.length,checksum:createHash('sha256').update(pdf).digest('base64'),category:'lab_report',hospital_name:'Synthetic Hospital',document_date:'2026-01-02'});
 if(processed){const service=createProcessingService(createProcessingRepository(db,processingConfig,u.id)),job=await service.claim();assert.ok(job);assert.equal(await service.persistExtraction({documentId:d.id,patientId:u.id,token:job.lease_token!},{text,method,extractor:{name:'phase7-synthetic',version:'v1'},source:{sha256:d.sha256,pageCount:1,pages:[{page:1,method,...(method==='ocr'?{confidence:50}:{})}]}}),true);}return d;
}
async function summary(u:Awaited<ReturnType<typeof user>>,id:string){const repo=createSummaryJobRepository(db,u.id),s=await repo.captureSnapshot(id),{input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));await repo.enqueue(s.id,sourceCatalogue(s),pipeline);const client=createSummaryClient({enabled:true,token:randomBytes(32).toString('hex')},async r=>{const input=JSON.parse(Buffer.from(r.body).toString());return {status:200,body:(async function*(){yield Buffer.from(canonicalSummaryJson({schema_version:1,kind:'medical-summary-output',scope:input.scope,reported_findings:input.facts,educational_explanations:['glucose'],uncertainty:{codes:['page_locations_unavailable'],fact_ids:[]},catalogue_coverage:'all_catalogued',provenance:fakeSummaryRecipe(r.headers['x-summary-input-sha256'])}));})()};});assert.equal(await createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:u.id},{repository:repo,client}).runOnce(),'completed');return (await repo.summaries(id))[0];}
async function due(patient:string){await admin.query("UPDATE guardian_medical_jobs SET window_start=CASE WHEN kind='routine_digest' THEN statement_timestamp()-interval '1 day' END,window_end=CASE WHEN kind='routine_digest' THEN statement_timestamp()-interval '1 second' END,not_before=statement_timestamp()-interval '1 second',next_attempt_at=statement_timestamp()-interval '1 second' WHERE patient_id=$1 AND state IN ('pending','retry_wait')",[patient]);}
async function ready(){const u=await user(),g=await guardian(u),d=await document(u);await summary(u,d.id);await worker().scan(u.id);await due(u.id);return {u,g,d};}

// ---------------------------------------------------------------------------------------------------------------
// Phase R5: email delivery against the real shipped synthetic sandbox. A thin proxy sits in front of it only to
// inject faults (outage, rejection, accepted-but-receipt-lost, bad receipt, slow reply) and to count requests.
const sandboxServer=createSecurityEmailSandbox();
type Fault='503'|'422'|'lost_receipt'|'bad_receipt'|'slow';
let faults:Fault[]=[],sandboxBase='',proxyBase='';
const proxied:Array<{path:string;key:string;fault?:Fault;upstream:number}>=[];
const securityKey=randomBytes(32),verificationLog:string[]=[];
let proxy:ReturnType<typeof createServer>,verification:ReturnType<typeof createSecurityEmailDelivery>,guardians:ReturnType<typeof createGuardianRepository>,provider:SyntheticGuardianProvider;
let server:ReturnType<ReturnType<typeof express>['listen']>,base='';
const adminKey=randomBytes(32),adminConfig:AdminAuthenticationConfig={jwtKey:new Uint8Array(adminKey),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'r5-admin',jwtAudience:'r5-admin-audience',rateLimitMax:500,rateWindowSeconds:900};
const share=sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid',SHARING_RESEND_SECONDS:'1',SHARING_OTP_REQUESTS_PER_HOUR:'20'})!;
let handoffHook:((id:string)=>Promise<void>)|undefined,fixtureHash:string;
const secretsSeen:string[]=[securityKey.toString('hex'),Buffer.from(auth.jwtKey).toString('hex'),Buffer.from(auth.jwtKey).toString('base64'),Buffer.from(adminKey).toString('hex'),Buffer.from(settings.referenceKey).toString('hex')];
before(async()=>{
 assert.equal((await stat(socket!)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_r5_email');}finally{await bootstrap.end();}
 await admin.query('CREATE EXTENSION vector');
 fixtureHash=await createPasswordService(auth).hash('Synthetic fixture passphrase 598!');
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,21);
 for(const file of files){if(file.startsWith('0005'))await admin.query('GRANT USAGE ON SCHEMA public TO health_wallet_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const c=await admin.connect();try{await c.query('BEGIN');await c.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 sandboxServer.listen(0,'127.0.0.1');await once(sandboxServer,'listening');sandboxBase='http://127.0.0.1:'+(sandboxServer.address() as any).port;
 proxy=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks),key=String(req.headers['idempotency-key']??''),path=req.url??'',fault=faults.shift();
  if(fault==='503'||fault==='422'){proxied.push({path,key,fault,upstream:0});res.writeHead(Number(fault)).end();return;}
  const up=await fetch(sandboxBase+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body});const text=await up.text();
  proxied.push({path,key,fault,upstream:up.status});
  if(fault==='lost_receipt'){res.writeHead(503).end();return;}
  if(fault==='bad_receipt'){res.writeHead(202,{'Content-Type':'application/json'}).end('{}');return;}
  if(fault==='slow')await sleep(2600);
  res.writeHead(up.status,{'Content-Type':'application/json'}).end(text);
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');proxyBase='http://127.0.0.1:'+(proxy.address() as any).port;
 verification=createSecurityEmailDelivery(db,{mode:'sandbox',endpoint:proxyBase+'/security-email',from:'security@example.invalid',encryptionKey:securityKey,timeoutMs:1000,retrySeconds:1,maxAttempts:3});
 guardians=createGuardianRepository(db,policy,verification.mailer);
 provider=syntheticGuardianEmailProvider({mode:'sandbox',endpoint:proxyBase+'/guardian-medical-email',from:'guardian-demo@example.invalid',encryptionKey:randomBytes(32),timeoutMs:1000,retrySeconds:1,maxAttempts:3});
 const app=express();app.use(express.json());const identity=createPatientRoutes(db,auth,{mailer:verification.mailer,policy});
 app.use('/api/v1/auth',identity.auth);app.use('/api/v1/patients',identity.profile);app.use('/api/v1',createGuardianRoutes(db,auth,{mailer:verification.mailer,policy}));
 app.use('/api/v1',createGuardianNotificationRoutes(db,auth,documentConfig,storage));app.use('/api/v1',createSharingRoutes(db as unknown as RagDatabase,auth,documentConfig,storage,{config:share,mailer:verification.mailer}));
 app.use('/api/v1/admin',createAdminRoutes(db,auth,adminConfig,{health:{services:[]}}));app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as any).port+'/api/v1';
});
after(async()=>{for(const s of [server,proxy,sandboxServer])if(s){s.closeAllConnections?.();await new Promise<void>(r=>s.close(()=>r()));}await db.end();await admin.end();});
const worker=(config:GuardianNotificationConfig=settings,rules:readonly SeriousRule[]=[demoRule])=>createGuardianNotificationService(db,config,provider,rules,{beforeHandoff:async id=>{await handoffHook?.(id);}});

type Boxed={id:string;to:string;from:string;subject:string;text:string;idempotencyKey:string};
const box=async():Promise<Boxed[]>=>(await fetch(sandboxBase+'/messages')).json() as Promise<Boxed[]>;
const mailTo=async(email:string)=>(await box()).filter(m=>m.to===email);
const jobRows=(patient:string)=>admin.query('SELECT * FROM guardian_medical_jobs WHERE patient_id=$1 ORDER BY created_at,id',[patient]).then(r=>r.rows);
const deliveryRow=async(email:string)=>(await admin.query('SELECT d.* FROM patient_security_email_deliveries d JOIN patients p ON p.id=d.patient_id WHERE p.email=$1 ORDER BY d.created_at DESC LIMIT 1',[email])).rows[0];
const dueNow=()=>admin.query("UPDATE patient_security_email_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state IN ('pending','transient_failed')");
const codeIn=(m:{text:string})=>m.text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}/)?.[0]!;
const api=(path:string,body?:unknown,token?:string)=>request(path,token,body);
const goodPassword='Synthetic registered passphrase 4401!';
async function register(){
 const email='r5-'+randomUUID()+'@example.invalid';const r=await api('/auth/register',{email,password:goodPassword,full_name:'Synthetic R5 Person'});assert.equal(r.status,201);return {email,id:r.data.patient.id as string};
}
async function loggedIn(p:{email:string}){const r=await api('/auth/login',{email:p.email,password:goodPassword});assert.equal(r.status,200);secretsSeen.push(r.data.access_token,r.data.refresh_token);return r.data as {access_token:string;refresh_token:string};}
async function activate(id:string){await verification.drain(100);const row=(await admin.query('SELECT invitation_id,email FROM guardian_relationships WHERE id=$1',[id])).rows[0];const m=(await mailTo(row.email)).find(x=>x.text.includes(row.invitation_id));assert.ok(m,'guardian invitation mail');await guardians.accept(codeIn(m));}
let world:Promise<any>|undefined;
/** One scenario that produces every kind of email through the real code paths. */
function build(){return world??=(async()=>{
 const reg=await register();await verification.drain(100);
 const verifyMail=(await mailTo(reg.email)).find(m=>m.subject.startsWith('Verify your AI Health Wallet email'))!;assert.ok(verifyMail);
 assert.equal((await api('/auth/verify-email',{token:codeIn(verifyMail)})).status,200);
 const session=await loggedIn(reg);
 assert.equal((await api('/auth/forgot-password',{email:reg.email})).status,202);await verification.drain(100);
 const resetMail=(await mailTo(reg.email)).find(m=>m.subject.startsWith('Reset your AI Health Wallet password'))!;assert.ok(resetMail);
 const resetCode=codeIn(resetMail);
 const u=await user(),g=await guardian(u,false);await verification.drain(100);
 const inviteMail=(await mailTo(g.email))[0];assert.ok(inviteMail);
 await activate(g.id);
 const d=await document(u,'Glucose: 90 mg/dL\nDEMO_MARKER: 11 demo_units');await summary(u,d.id);
 const doctor='doctor-'+randomUUID()+'@example.invalid',grantRes=await request('/sharing/grants',u.token,{document_ids:[d.id],share_type:'unique_link',doctor_email:doctor});assert.equal(grantRes.status,201);
 const ref=grantRes.data.share_url.split('/share/')[1];
 const otpReq=await request('/sharing/otp',undefined,{share_token:ref,email:doctor,name:'Synthetic Doctor',organization:'Synthetic Clinic'});assert.equal(otpReq.status,202);await verification.drain(100);
 const doctorMail=(await mailTo(doctor))[0];assert.ok(doctorMail);
 await worker().scan(u.id);await due(u.id);const sent=await worker().drain(u.id,5);
 const guardianMail=await mailTo(g.email);
 return {reg,verifyMail,resetMail,resetCode,session,u,g,inviteMail,doctor,doctorMail,otpReq,ref,d,sent,guardianMail,digest:guardianMail.find(m=>m.subject.includes('digest'))!,alert:guardianMail.find(m=>m.subject.includes('Separate'))!};
})();}
const post=(root:string,path:string,body:unknown,headers:Record<string,string>={})=>fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}).then(async r=>({status:r.status,text:await r.text()}));
const goodSecurity=()=>({idempotencyKey:randomUUID(),from:'security@example.invalid',to:'a-'+randomUUID()+'@example.invalid',subject:'Verify your AI Health Wallet email',text:'Verification code: x'});
const goodMedical=()=>({idempotencyKey:randomUUID(),from:'guardian-demo@example.invalid',to:'g-'+randomUUID()+'@example.invalid',subject:'SYNTHETIC ONLY — Guardian report digest',text:'NON-CLINICAL DEMONSTRATION. Test.'});

test('R5-01 the shipped sandbox enforces strict message rules: shape, recipients, header injection, size and idempotency',async()=>{
 const send=(path:string,m:any,key=m.idempotencyKey)=>post(sandboxBase,path,m,{'Idempotency-Key':key});
 const s=goodSecurity();const first=await send('/security-email',s),again=await send('/security-email',s);
 assert.equal(first.status,202);assert.equal(again.status,202);assert.equal(JSON.parse(first.text).message_id,JSON.parse(again.text).message_id,'same key and content: one message');
 assert.equal((await send('/security-email',{...s,text:'a different body'})).status,409,'same key with different content is refused');
 assert.equal((await box()).filter(m=>m.idempotencyKey===s.idempotencyKey).length,1);assert.equal((await box()).find(m=>m.idempotencyKey===s.idempotencyKey)!.text,s.text,'the first message is never overwritten');
 for(const [name,m] of Object.entries({
  'real-looking domain':{...goodSecurity(),to:'someone@gmail.com'},'plain domain':{...goodSecurity(),to:'someone@example.com'},'CRLF in subject':{...goodSecurity(),subject:'Hi\r\nBcc: attacker@example.invalid'},
  'CRLF in recipient':{...goodSecurity(),to:'a@example.invalid\r\nBcc: b@example.invalid'},'LF in from':{...goodSecurity(),from:'security@example.invalid\nX: y'},
  'two recipients':{...goodSecurity(),to:'a@example.invalid, b@example.invalid'},'NUL in text':{...goodSecurity(),text:'a\u0000b'},'empty text':{...goodSecurity(),text:''},
  'text too long':{...goodSecurity(),text:'x'.repeat(2049)},'extra field':{...goodSecurity(),cc:'x@example.invalid'},'missing field':{to:'a@example.invalid'},
  'bad key':{...goodSecurity(),idempotencyKey:'not-a-uuid'},'number as subject':{...goodSecurity(),subject:5},
 }))assert.equal((await send('/security-email',m as any,(m as any).idempotencyKey)).status,422,name);
 const mismatch=goodSecurity();assert.equal((await send('/security-email',mismatch,randomUUID())).status,422,'header key must equal body key');
 assert.equal((await post(sandboxBase,'/security-email',goodSecurity())).status,422,'missing Idempotency-Key header');
 assert.equal((await send('/security-email','not json' as any,randomUUID())).status,400);
 assert.equal((await post(sandboxBase,'/security-email','x'.repeat(5000),{'Idempotency-Key':randomUUID()})).status,413);
 assert.equal((await send('/other',goodSecurity())).status,404);assert.equal((await fetch(sandboxBase+'/security-email')).status,404);assert.equal((await fetch(sandboxBase+'/__proto__',{method:'POST'})).status,404);
 // guardian medical endpoint: synthetic-only labels are mandatory
 const m=goodMedical();assert.equal((await send('/guardian-medical-email',m)).status,202);
 for(const [name,bad] of Object.entries({'no synthetic label in subject':{...goodMedical(),subject:'Guardian report'},'no non-clinical banner':{...goodMedical(),text:'Hello'},'wrong sender':{...goodMedical(),from:'x@example.invalid'},'real-looking recipient':{...goodMedical(),to:'x@gmail.com'}}))
  assert.equal((await send('/guardian-medical-email',bad as any)).status,422,name);
 assert.equal((await send('/guardian-medical-email',{...goodMedical(),text:'NON-CLINICAL DEMONSTRATION. '+'y'.repeat(60000)})).status,202,'digest-size bodies are accepted');
 assert.equal((await send('/guardian-medical-email',{...goodMedical(),text:'NON-CLINICAL DEMONSTRATION. '+'y'.repeat(66000)})).status,422);
 assert.equal((await send('/security-email',{...goodSecurity(),subject:'SYNTHETIC ONLY — x',text:'NON-CLINICAL DEMONSTRATION. '+'y'.repeat(3000)})).status,422,'identity endpoint keeps the small limit');
});

test('R5-02 every kind of email is delivered once, through the real adapter, to the right single recipient',async()=>{
 const w=await build();
 assert.deepEqual(w.sent.sort(),['delivered','delivered'],'digest and separate serious alert both delivered');
 const all=await box();
 const expect:Array<[string,string,Boxed]>=[['verification',w.reg.email,w.verifyMail],['password reset',w.reg.email,w.resetMail],['guardian invitation',w.g.email,w.inviteMail],['doctor code',w.doctor,w.doctorMail],['digest',w.g.email,w.digest],['serious alert',w.g.email,w.alert]];
 for(const [name,to,m] of expect){assert.ok(m,name);assert.equal(m.to,to,name+' recipient');assert.equal(all.filter(x=>x.idempotencyKey===m.idempotencyKey).length,1,name+' exists once');assert.ok(!/[,;]/.test(m.to),name+' single recipient');}
 assert.equal(w.verifyMail.from,'security@example.invalid');assert.equal(w.digest.from,'guardian-demo@example.invalid');
 assert.equal((await mailTo(w.reg.email)).length,2,'the registering patient got exactly verification + reset');
 assert.equal((await mailTo(w.g.email)).length,3,'the guardian got invitation + digest + alert, nothing else');assert.equal((await mailTo(w.doctor)).length,1);
 assert.equal((await mailTo(w.u.email)).length,0,'the patient who is sharing records gets no copy of guardian or doctor mail');
 // the codes actually work, once, and only for their own purpose
 assert.equal((await api('/auth/reset-password',{token:codeIn(w.verifyMail),new_password:'Brand new synthetic passphrase 82!'})).status,400,'a verification code does not reset a password');
 assert.equal((await api('/auth/reset-password',{token:w.resetCode,new_password:'Brand new synthetic passphrase 82!'})).status,200);
 assert.equal((await api('/auth/reset-password',{token:w.resetCode,new_password:'Another new synthetic passphrase 83!'})).status,400,'single use');
 const v=await api('/sharing/otp/verify',{share_token:w.ref,email:w.doctor,challenge_id:w.otpReq.data.challenge_id,otp:codeIn(w.doctorMail)});assert.equal(v.status,200);
 assert.equal((await api('/sharing/otp/verify',{share_token:w.ref,email:w.doctor,challenge_id:w.otpReq.data.challenge_id,otp:codeIn(w.doctorMail)})).status,403,'doctor code is single use');
 const wrong=await api('/sharing/otp',{share_token:w.ref,email:'someone-else-'+randomUUID()+'@example.invalid',name:'Intruder'});assert.ok([400,403].includes(wrong.status),'a grant bound to one doctor does not mail another address: '+wrong.status);
 await verification.drain(100);assert.equal((await mailTo(w.doctor)).length,1);
 for(const m of [w.verifyMail,w.resetMail,w.inviteMail,w.doctorMail])assert.equal(codeIn(m).slice(0,36),(await admin.query('SELECT challenge_id FROM patient_security_email_deliveries WHERE id=$1',[m.idempotencyKey])).rows[0].challenge_id,'the code in the mail belongs to its own challenge');
});

test('R5-03 templates: plain text, clear wording, no secret or foreign personal data in any message',async()=>{
 const w=await build();
 const productKeys=new Set([...(await admin.query('SELECT id FROM patient_security_email_deliveries UNION SELECT id FROM guardian_medical_jobs')).rows.map(r=>r.id as string)]);
 const all=(await box()).filter(m=>productKeys.has(m.idempotencyKey));
 const patientHashes=(await admin.query('SELECT password_hash FROM patients')).rows.map(r=>r.password_hash as string);
 const emails=(await admin.query('SELECT email FROM patients')).rows.map(r=>r.email as string);
 const sessions=(await admin.query('SELECT refresh_hash FROM patient_auth_sessions')).rows.map(r=>r.refresh_hash as string);
 const tokenHashes=(await admin.query('SELECT token_hash FROM patient_auth_challenges')).rows.map(r=>r.token_hash as string);
 assert.ok(all.length>=6);
 for(const m of all){
  const whole=[m.to,m.from,m.subject,m.text].join('\n');
  assert.ok(!/<\/?[a-z][^>]*>/i.test(m.text),'no HTML: '+m.subject);assert.ok(!m.text.includes('\r'),'LF line endings');assert.ok(!/[ \t]+\n/.test(m.text),'no trailing spaces');assert.ok(m.text.endsWith('.')||m.text.endsWith('.\n'),'ends cleanly: '+m.subject);
  for(const secret of [...secretsSeen,...patientHashes,...sessions,...tokenHashes])assert.ok(!whole.includes(secret),'a secret appears in "'+m.subject+'"');
  assert.ok(!/\$argon2|password_hash|Bearer |BEGIN [A-Z ]*KEY|ciphertext/i.test(whole),'no credential markers: '+m.subject);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(whole),'no JWT-shaped value');
  const others=emails.filter(e=>e!==m.to);for(const e of others)assert.ok(!whole.includes(e),'a different person\'s address appears in "'+m.subject+'"');
 }
 // security mails: one short sentence, one code, expiry and single-use notice, ignore-if-not-you notice; exact subjects
 const subjects:Array<[Boxed,RegExp,RegExp]>=[[w.verifyMail,/^Verify your AI Health Wallet email$/,/^Verification code: /m],[w.resetMail,/^Reset your AI Health Wallet password$/,/^Password reset code: /m],[w.inviteMail,/^Accept your AI Health Wallet guardian invitation$/,/^Guardian acceptance code: /m],[w.doctorMail,/^Verify your AI Health Wallet sharing access$/,/^Doctor sharing OTP code: /m]];
 for(const [m,subject,line] of subjects){assert.match(m.subject,subject);assert.match(m.text,line);assert.equal(m.text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}/g)!.length,1,'exactly one code');
  assert.match(m.text,/Expires at \d{4}-\d\d-\d\dT[\d:.]+Z\. This code is single-use\. If you did not request this, ignore this email\.$/);assert.ok(m.text.length<400,'short: '+m.text.length);
  assert.ok(!/https?:\/\//.test(m.text),'no clickable link in a security mail');}
 // doctor and guardian mail never name the patient or contain patient identifiers
 const patient=(await admin.query('SELECT id,email,full_name FROM patients WHERE id=$1',[w.u.id])).rows[0];
 for(const m of [w.inviteMail,w.doctorMail,w.digest,w.alert]){for(const needle of [patient.id,patient.email,patient.full_name])assert.ok(!m.text.includes(needle)&&!m.subject.includes(needle),'patient detail "'+needle+'" in '+m.subject);}
 // medical mail: clearly synthetic and non-diagnostic, scoped to this patient's own report only
 for(const m of [w.digest,w.alert]){assert.ok(m.subject.startsWith('SYNTHETIC ONLY — '));assert.ok(m.text.startsWith('NON-CLINICAL DEMONSTRATION. Not approved for real-patient medical communication.'));assert.match(m.text,/does not diagnose, prescribe treatment or replace/);
  assert.equal([...m.text.matchAll(/gn1\.[a-f0-9-]{36}\.[a-f0-9]{64}/g)].length,1,'one report reference');assert.ok(m.text.includes('https://guardian.example.invalid/#/guardian-report/gn1.'),'reference is a link on the synthetic origin');
  assert.ok(!/Authorization|JWT|refresh/i.test(m.text));}
 assert.ok(w.alert.text.includes('11 demo_units')&&!w.digest.text.includes('11 demo_units')||w.digest.text.includes('Existing report summary'),'alert and digest stay separate kinds');
 assert.ok(!w.alert.text.includes('Existing report summary'));
 const other=await ready();const foreign=await mailTo(other.g.email);for(const m of foreign)for(const mine of [w.u.id,w.d.id])assert.ok(!m.text.includes(mine),'another patient\'s mail never mentions this patient\'s ids');
});

test('R5-04 security mail: failures are classified, retried with the same idempotency key, and never duplicate or lose the message',async()=>{
 for(const fault of ['503','lost_receipt','slow'] as Fault[]){
  const p=await register();faults=[fault];proxied.length=0;
  const first=await verification.drain(10);assert.deepEqual([first.processed,first.delivered,first.failed],[1,0,1],fault);
  let row=await deliveryRow(p.email);assert.equal(row.state,'transient_failed',fault);assert.equal(row.attempts,1);assert.ok(['transport','timeout','rejected','invalid_receipt'].includes(row.failure_category),fault+' '+row.failure_category);
  assert.ok(row.next_attempt_at.getTime()>Date.now()-100,'a retry is scheduled in the future');assert.equal(row.delivered_at,null);
  assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads WHERE delivery_id=$1',[row.id])).rows[0].n,1,'payload kept for the retry');
  assert.equal((await mailTo(p.email)).length,fault==='lost_receipt'||fault==='slow'?1:0,fault+': provider-side state before retry');
  assert.equal((await verification.drain(10)).processed,0,'not retried before it is due');
  await dueNow();const second=await verification.drain(10);assert.deepEqual([second.delivered,second.failed],[1,0],fault);
  row=await deliveryRow(p.email);assert.equal(row.state,'delivered');assert.equal(row.attempts,2);assert.equal(row.failure_category,null);assert.match(row.provider_reference_hash,/^[a-f0-9]{64}$/);
  assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads WHERE delivery_id=$1',[row.id])).rows[0].n,0,'ciphertext removed once delivered');
  assert.equal((await mailTo(p.email)).length,1,fault+': exactly one message reaches the mailbox');
  assert.deepEqual([...new Set(proxied.map(x=>x.key))],[row.id],'every attempt used the delivery id as the idempotency key');assert.equal(proxied.length,2);
 }
 // a receipt that breaks the contract is never retried and never reported as delivered (same rule as the guardian mail, P7-17)
 {const b=await register();faults=['bad_receipt'];assert.equal((await verification.drain(10)).failed,1);const r=await deliveryRow(b.email);assert.equal(r.state,'permanent_failed');assert.equal(r.failure_category,'invalid_receipt');assert.equal(r.delivered_at,null);assert.equal(r.attempts,1);
  assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads WHERE delivery_id=$1',[r.id])).rows[0].n,0);await dueNow();assert.equal((await verification.drain(10)).processed,0);}
 // permanent rejection: one attempt, terminal, ciphertext removed
 const p=await register();faults=['422'];assert.equal((await verification.drain(10)).failed,1);let row=await deliveryRow(p.email);
 assert.equal(row.state,'permanent_failed');assert.equal(row.failure_category,'rejected');assert.equal(row.attempts,1);
 assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads WHERE delivery_id=$1',[row.id])).rows[0].n,0);await dueNow();assert.equal((await verification.drain(10)).processed,0);assert.equal((await mailTo(p.email)).length,0);
 // exhausted transient budget
 const q=await register();faults=['503','503','503'];for(let i=0;i<3;i++){assert.equal((await verification.drain(10)).failed,1);await dueNow();}
 row=await deliveryRow(q.email);assert.equal(row.state,'permanent_failed');assert.equal(row.attempts,3);assert.equal((await verification.drain(10)).processed,0);assert.equal((await mailTo(q.email)).length,0);
 assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads WHERE delivery_id=$1',[row.id])).rows[0].n,0);
 // an unreachable relay is a transport failure, not a crash
 const down=createSecurityEmailDelivery(db,{mode:'sandbox',endpoint:'http://127.0.0.1:9/security-email',from:'security@example.invalid',encryptionKey:securityKey,timeoutMs:500,retrySeconds:1,maxAttempts:3});
 const r=await register();const d=await down.drain(10);assert.deepEqual([d.failed,d.delivered],[1,0]);assert.equal((await deliveryRow(r.email)).failure_category,'transport');
});

test('R5-05 sending is idempotent: duplicate enqueue, concurrent workers and a worker that died after sending',async()=>{
 const p=await register();const challenge=(await admin.query("SELECT id FROM patient_auth_challenges WHERE patient_id=$1 AND purpose='verify_email'",[p.id])).rows[0];
 assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_deliveries WHERE challenge_id=$1',[challenge.id])).rows[0].n,1,'one delivery per challenge');
 proxied.length=0;const results=await Promise.all([verification.drain(5),verification.drain(5),verification.drain(5)]);
 assert.equal(results.reduce((n,r)=>n+r.delivered,0),1);assert.equal(proxied.filter(x=>x.path==='/security-email').length>=1,true);assert.equal((await mailTo(p.email)).length,1,'concurrent workers produce one message');
 // simulate "sent, then the worker died before recording": the claim expires and another worker resends with the same key
 const q=await register();const row=await deliveryRow(q.email);faults=['lost_receipt'];assert.equal((await verification.drain(5)).failed,1);
 await admin.query("UPDATE patient_security_email_deliveries SET state='sending',claim_id=$2,claim_expires_at=clock_timestamp()-interval '1 second',failure_category=NULL WHERE id=$1",[row.id,randomUUID()]);
 assert.equal((await verification.drain(5)).delivered,1);assert.equal((await mailTo(q.email)).length,1,'a recovered claim does not duplicate');
 assert.equal((await deliveryRow(q.email)).state,'delivered');
});

test('R5-06 mail that became unsafe to send is dropped, not delivered: revoked grant, suspended patient, removed guardian, expired code',async()=>{
 const u=await user(),d=await document(u),doctor='late-'+randomUUID()+'@example.invalid';
 const gr=await request('/sharing/grants',u.token,{document_ids:[d.id],share_type:'unique_link',doctor_email:doctor});const ref=gr.data.share_url.split('/share/')[1];
 assert.equal((await request('/sharing/otp',undefined,{share_token:ref,email:doctor,name:'Late Doctor'})).status,202);
 assert.equal((await request('/sharing/grants/'+gr.data.grant.id+'/revoke',u.token,{})).status,200);
 const a=await verification.drain(10);assert.equal(a.delivered,0);assert.equal((await mailTo(doctor)).length,0,'revoked grant: no doctor code is sent');
 const gu=await user(),g=await guardian(gu,false);await admin.query("UPDATE patients SET account_status='suspended' WHERE id=$1",[gu.id]);await verification.drain(10);assert.equal((await mailTo(g.email)).length,0,'suspended patient: no guardian invitation');
 const r=await register();await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '3 days',expires_at=clock_timestamp()-interval '1 second' WHERE patient_id=$1",[r.id]);
 await verification.drain(10);assert.equal((await mailTo(r.email)).length,0);assert.equal((await deliveryRow(r.email)).state,'expired');
 const states=(await admin.query("SELECT state,count(*)::int n FROM patient_security_email_deliveries GROUP BY state")).rows.map(x=>x.state);assert.ok(states.includes('superseded'));
 // guardian medical mail for a guardian who was removed before send
 const x=await ready();assert.ok(await guardians.remove(x.u.who));assert.deepEqual(await worker().drain(x.u.id),['cancelled']);assert.equal((await mailTo(x.g.email)).filter(m=>m.subject.startsWith('SYNTHETIC')).length,0);
});

test('R5-07 guardian digest and alert mail use the real adapter with stable retries and exactly-once delivery',async()=>{
 for(const fault of ['503','lost_receipt','slow'] as Fault[]){
  const x=await ready();faults=[fault];proxied.length=0;const first=await worker().drain(x.u.id);
  assert.ok(['retry_wait'].includes(first[0]),fault+': '+first);let j=(await jobRows(x.u.id))[0];assert.equal(j.attempts,1);assert.equal(j.delivered_at,null);assert.ok(j.failure_code);
  await due(x.u.id);assert.deepEqual(await worker().drain(x.u.id),['delivered'],fault);
  j=(await jobRows(x.u.id))[0];assert.equal(j.state,'delivered');assert.equal(j.attempts,2);assert.equal((await mailTo(x.g.email)).filter(m=>m.subject.startsWith('SYNTHETIC')).length,1,fault+': one message');
  assert.deepEqual([...new Set(proxied.map(p=>p.key))],[j.id]);assert.equal(proxied.length,2);
  assert.deepEqual(await worker().drain(x.u.id),[],'nothing is sent twice');
 }
 {const b=await ready();faults=['bad_receipt'];assert.deepEqual(await worker().drain(b.u.id),['permanent_failed']);assert.equal((await jobRows(b.u.id))[0].failure_code,'invalid_receipt');assert.equal((await jobRows(b.u.id))[0].delivered_at,null);}
 const y=await ready();faults=['422'];assert.deepEqual(await worker().drain(y.u.id),['permanent_failed']);await due(y.u.id);assert.deepEqual(await worker().drain(y.u.id),[]);assert.equal((await mailTo(y.g.email)).filter(m=>m.subject.startsWith('SYNTHETIC')).length,0);
 assert.equal((await jobRows(y.u.id))[0].failure_code,'rejected');
});

test('R5-08 delivery status is observable by the patient and by admins without exposing addresses, codes or content',async()=>{
 await build();
 const email='r5-admin-'+randomUUID()+'@example.invalid',pw='Synthetic admin passphrase 731!';await createAdminAccount(admin,p=>createPasswordService(auth).hash(p),{email,fullName:'Synthetic Admin',role:'operations_admin',password:pw});
 const login=await (await fetch(base+'/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pw})})).json() as any;const token=login.access_token as string;
 const get=async(path:string)=>{const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token}});return {status:r.status,text:await r.text()};};
 const summary_=await get('/admin/status/deliveries/summary');assert.equal(summary_.status,200,'summary '+summary_.text.slice(0,150));
 const list=await get('/admin/status/deliveries');assert.equal(list.status,200,'list '+list.text.slice(0,150));
 const text=summary_.text+list.text;
 assert.ok(/security_email/.test(text)&&/guardian_notification/.test(text),'both channels are reported');
 assert.ok(/delivered/.test(text)&&/permanent_failed/.test(text)&&/transient_failed|retry_wait/.test(text),'success, retry and permanent-failure states are visible');
 const addresses=(await admin.query('SELECT email FROM patients')).rows.map(r=>r.email as string);
 for(const a of addresses)assert.ok(!text.includes(a),'no address in admin delivery status');
 assert.ok(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}|ciphertext|nonce|token_hash|"token"|otp_verifier|password_hash|payload/i.test(text),'no code, token or ciphertext in admin delivery status');
 const health=await get('/admin/health');assert.equal(health.status,200,'health '+health.text.slice(0,150));assert.ok(JSON.parse(health.text).components?.some?.((c:any)=>c.name==='email_queue')||/email_queue/.test(health.text),'email queue health is reported');
 const x=await ready();faults=['503'];await worker().drain(x.u.id);
 const seen=await request('/patients/me/guardian-notifications',x.u.token);assert.equal(seen.status,200);const job=seen.data.jobs.find((j:any)=>j.state==='retry_wait');assert.ok(job&&job.failure_code&&job.attempts===1,'the patient can see a retry in progress');
 assert.ok(!JSON.stringify(seen.data).includes(x.g.email),'the patient view does not repeat the guardian address');
});

test('R5-09 nothing sensitive reaches logs, and the worker command and configuration fail closed without printing values',async()=>{
 const logged:string[]=[];const originals=(['log','error','warn','info','debug'] as const).map(k=>[k,console[k]] as const);
 for(const [k] of originals)(console as any)[k]=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
 let p:Awaited<ReturnType<typeof register>>;
 try{p=await register();faults=['503'];await verification.drain(5);await dueNow();await verification.drain(5);const x=await ready();faults=['422'];await worker().drain(x.u.id);}
 finally{for(const [k,fn] of originals)(console as any)[k]=fn;}
 const joined=logged.join('\n');assert.ok(!joined.includes(p!.email)&&!/[a-f0-9]{64}/.test(joined)&&!joined.includes('example.invalid'),'delivery code prints no address, code or hash');
 const run=(env:Record<string,string|undefined>)=>spawnSync(process.execPath,['--import','tsx','src/auth/security-email-entry.ts','--drain-once'],{cwd:new URL('../../',import.meta.url).pathname,env:{PATH:process.env.PATH??'',DB_HOST:socket!,DB_PORT:'55481',DB_NAME:'hw_r5_email',DB_USER:'health_wallet_app',DB_PASSWORD:'unused',JWT_SECRET:randomBytes(32).toString('hex'),...env} as Record<string,string>,encoding:'utf8',timeout:60000});
 const marker='SUPER-SECRET-RELAY-VALUE-'+randomBytes(6).toString('hex');
 for(const env of [{},{AUTH_SECURITY_EMAIL_MODE:'https-relay',AUTH_SECURITY_EMAIL_ENDPOINT:'https://relay.example.invalid/send',AUTH_SECURITY_EMAIL_AUTHORIZATION:'Bearer '+marker,AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:securityKey.toString('hex'),AUTH_SECURITY_EMAIL_FROM:'security@example.invalid'},{AUTH_SECURITY_EMAIL_MODE:'sandbox',AUTH_SECURITY_EMAIL_ENDPOINT:'http://169.254.169.254/latest',AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:securityKey.toString('hex'),AUTH_SECURITY_EMAIL_FROM:'security@example.invalid'}]){
  const r=run(env);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/Security email delivery unavailable/);assert.ok(!r.stderr.includes(marker)&&!r.stderr.includes('169.254')&&!r.stderr.includes(securityKey.toString('hex')));
 }
 const bad=run({AUTH_SECURITY_EMAIL_MODE:'sandbox',AUTH_SECURITY_EMAIL_ENDPOINT:sandboxBase+'/security-email',AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:securityKey.toString('hex'),AUTH_SECURITY_EMAIL_FROM:'security@example.invalid\r\nBcc: x@example.invalid'});
 assert.equal(bad.status,1,'a from-address with a line break is refused');
 for(const env of [{AUTH_SECURITY_EMAIL_MODE:'https-relay',AUTH_SECURITY_EMAIL_ENDPOINT:'https://relay.example.invalid/',AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:securityKey.toString('hex'),AUTH_SECURITY_EMAIL_FROM:'security@example.invalid',AUTH_SECURITY_EMAIL_AUTHORIZATION:'Bearer '+marker},{AUTH_SECURITY_EMAIL_MODE:'sandbox',AUTH_SECURITY_EMAIL_ENDPOINT:'http://example.com/x',AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:securityKey.toString('hex'),AUTH_SECURITY_EMAIL_FROM:'a@example.invalid'}])
  assert.throws(()=>securityEmailConfig(env),(e:any)=>!String(e.message).includes(marker)&&!String(e.message).includes('example.com'),'configuration errors name no value');
 assert.equal(securityEmailConfig({}),undefined,'disabled by default');
 assert.throws(()=>securityEmailConfig({AUTH_SECURITY_EMAIL_MODE:'https-relay',AUTH_SECURITY_EMAIL_ENDPOINT:'https://relay.example.invalid/',AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:securityKey.toString('hex'),AUTH_SECURITY_EMAIL_FROM:'a@example.invalid',AUTH_SECURITY_EMAIL_AUTHORIZATION:'Bearer x'}),'a real relay needs explicit provider approval, which is not given');
});

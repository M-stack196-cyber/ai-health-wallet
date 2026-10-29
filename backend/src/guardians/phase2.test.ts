import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import sharp from 'sharp';
import {createGuardianRoutes} from './routes.js';
import {createGuardianRepository} from './repository.js';
import {createSecurityEmailDelivery,type ProviderMessage} from '../auth/security-email.js';
import {createSecurityRepository,secretHash} from '../auth/security-repository.js';
import {createPasswordService} from '../auth/passwords.js';
import {createPatientRoutes} from '../auth/routes.js';
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
const conn={host:socket,port:55481,database:'hw_phase2'};
const admin=new pg.Pool({...conn,user:userInfo().username}),db=new pg.Pool({...conn,user:'health_wallet_app',max:16});
const policy={...getSecurityPolicy(),resendCooldownSeconds:1,challengeRateMax:5};
const auth={jwtKey:randomBytes(32),jwtAlgorithm:'HS256' as const,jwtLifetimeSeconds:900,jwtIssuer:'phase2-test',jwtAudience:'patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:4,rateLimitWindowMs:900000,rateLimitMax:10000};
const sent:ProviderMessage[]=[],objects=new Map<string,Buffer>();let puts=0,reads=0;
const delivery=createSecurityEmailDelivery(db,{mode:'sandbox',endpoint:'http://127.0.0.1:1',from:'security@example.invalid',encryptionKey:randomBytes(32),timeoutMs:500,retrySeconds:1,maxAttempts:3},{async send(m){sent.push(m);return {messageReference:randomUUID()};}});
const guardians=createGuardianRepository(db,policy,delivery.mailer),security=createSecurityRepository(db,policy),tokens=createTokenService(auth);
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',async put(i){puts++;const b=await readFile(i.path);assert.equal(createHash('sha256').update(b).digest('base64'),i.checksum);objects.set(i.key,b);return {versionId:'test'};},async remove(key){objects.delete(key);},async download(){throw Error('URL signing forbidden');},async readOriginal(i){reads++;const b=objects.get(i.key);if(!b)throw Error('synthetic missing object');await writeFile(i.destination,b,{flag:'wx',mode:0o600});return {bytes:b.length};}};
const config={maxFileBytes:4096,maxConcurrentUploads:2,uploadTimeoutMs:5000,validationTimeoutMs:3000,maxImagePixels:1000,maxPdfPages:2,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
let fixtureHash:string;
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string,legacyId:string,legacyPatient:string;
before(async()=>{
 assert.equal((await stat(socket!)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_phase2');}finally{await bootstrap.end();}
 await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator');
 fixtureHash=await createPasswordService(auth).hash('Synthetic fixture passphrase 498!');
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,12);
 for(const file of files){
  if(file.startsWith('0010'))await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
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
 const app=express();app.use(express.json());const identity=createPatientRoutes(db,auth,{mailer:delivery.mailer,policy});
 app.use('/api/v1/auth',identity.auth);app.use('/api/v1/patients',identity.profile);
 app.use('/api/v1',createGuardianRoutes(db,auth,{mailer:delivery.mailer,policy}));
 app.use('/api/v1/documents',createDocumentRoutes(db,auth,config,storage));app.use('/api/v1',createProcessingRoutes(db,auth));app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port+'/api/v1';
});
after(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await db.end();await admin.end();});
async function user(){const id=randomUUID(),email=id+'@example.invalid';await db.query("INSERT INTO patients(id,email,password_hash,full_name,email_verified_at,account_status) VALUES($1,$2,$3,'Synthetic Patient',clock_timestamp(),'active')",[id,email,fixtureHash]);const s=await security.login(id,fixtureHash);assert.ok(s);return {id,email,who:{patientId:id,sessionId:s.sessionId},token:await tokens.issue(id,s.sessionId)};}
async function request(path:string,token?:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const text=await r.text();return {status:r.status,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):text};
}
const path='/patients/me/guardian';
async function add(u:Awaited<ReturnType<typeof user>>,email=randomUUID()+'@example.invalid'){const r=await request(path,u.token,{email});assert.equal(r.status,201);return {email,g:r.data.guardian};}
async function invitation(email:string){await delivery.drain(100);const m=sent.filter(m=>m.to===email&&m.subject.includes('guardian')).at(-1);assert.ok(m);const token=m.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(token);assert.ok(!m.text.includes('medical report')&&!m.text.includes('password'));return token;}
async function age(patient:string){await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 seconds' WHERE patient_id=$1 AND purpose='guardian_invitation'",[patient]);}
async function eligible(patient:string){return (await db.query('SELECT * FROM guardian_communication_eligibility WHERE patient_id=$1',[patient])).rows;}
async function accept(token:string){return request('/guardian-invitations/accept',undefined,{token});}

test('P2-01 additive migration preserves legacy identity and unknown integrity; corrects extraction-only readiness',async()=>{
 const d=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[legacyId])).rows[0];assert.equal(d.patient_id,legacyPatient);assert.equal(d.s3_object_key,'legacy/key.pdf');assert.equal(d.sha256,null);assert.equal(d.size_bytes,null);assert.equal(d.processing_status,'processing');
 assert.equal((await admin.query("SELECT has_table_privilege('health_wallet_app','guardian_lifecycle_events','UPDATE') AS edit,has_table_privilege('health_wallet_app','guardian_lifecycle_events','DELETE') AS del")).rows[0].edit,false);
 assert.equal((await admin.query("SELECT has_table_privilege('health_wallet_app','guardian_lifecycle_events','DELETE') AS del")).rows[0].del,false);
});
test('P2-02 optional guardian starts NONE; authenticated saved registration intent can nominate',async()=>{
 const u=await user();assert.equal((await request(path,u.token)).data.guardian.status,'NONE');
 await db.query('UPDATE patients SET pending_guardian_email=$2 WHERE id=$1',[u.id,'intent@example.invalid']);
 assert.equal((await request(path,u.token,{})).data.guardian.status,'PENDING');assert.equal((await eligible(u.id)).length,0);
 assert.equal((await request(path,u.token)).data.guardian.email,'intent@example.invalid');
});
test('P2-03 secure email queue dispatch; acceptance binds patient/email; one-use and purpose-bound',async()=>{
 const u=await user(),a=await add(u),token=await invitation(a.email);
 const c=(await admin.query('SELECT * FROM patient_auth_challenges WHERE id=$1',[token.slice(0,36)])).rows[0];assert.equal(c.token_hash===secretHash('guardian_invitation',token),true);assert.equal(JSON.stringify(c).includes(token),false);
 assert.equal((await eligible(u.id)).length,0);assert.equal((await request('/auth/verify-email',undefined,{token})).status,400);
 assert.equal((await accept(token.slice(0,-1)+(token.endsWith('0')?'1':'0'))).status,400);
 assert.equal((await accept(token)).status,200);assert.equal((await accept(token)).status,400);const rows=await eligible(u.id);assert.equal(rows.length,1);assert.equal(rows[0].email,a.email);assert.equal(rows[0].relationship_id,a.g.id);
 assert.equal((await admin.query('SELECT count(*)::int n FROM patient_security_email_payloads p JOIN patient_security_email_deliveries d ON d.id=p.delivery_id WHERE d.challenge_id=$1',[token.slice(0,36)])).rows[0].n,0);
});
test('P2-04 expired invitation denied and status EXPIRED; no scanner GET acceptance',async()=>{
 const u=await user(),a=await add(u),token=await invitation(a.email);
 await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[token.slice(0,36)]);
 assert.equal((await accept(token)).status,400);assert.equal((await request(path,u.token)).data.guardian.status,'EXPIRED');assert.equal((await eligible(u.id)).length,0);
 assert.equal((await request('/guardian-invitations/accept?token=ignored')).status,400);
});
test('P2-05 resend cooldown and window budget; invalidates prior token; concurrent resend has one winner',async()=>{
 const u=await user(),a=await add(u),old=await invitation(a.email);
 assert.equal((await request(path+'/resend',u.token,{})).status,429);await age(u.id);
 const results=await Promise.all([request(path+'/resend',u.token,{}),request(path+'/resend',u.token,{})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);
 const next=await invitation(a.email);assert.equal(next!==old,true);assert.equal((await accept(old)).status,400);
 for(let i=0;i<3;i++){await age(u.id);assert.equal((await request(path+'/resend',u.token,{})).status,200);}await age(u.id);assert.equal((await request(path+'/resend',u.token,{})).status,429);
 assert.equal((await eligible(u.id)).length,0);
});
test('P2-06 pending replacement invalidates old invite; active replacement revokes old eligibility',async()=>{
 const u=await user(),a=await add(u),old=await invitation(a.email);await age(u.id);
 const nextEmail='replacement-'+randomUUID()+'@example.invalid';assert.equal((await request(path,u.token,{email:nextEmail},'PUT')).status,200);assert.equal((await accept(old)).status,400);
 const next=await invitation(nextEmail);assert.equal((await accept(next)).status,200);assert.equal((await eligible(u.id))[0].email,nextEmail);await age(u.id);
 const third='third-'+randomUUID()+'@example.invalid';assert.equal((await request(path,u.token,{email:third},'PUT')).status,200);assert.equal((await eligible(u.id)).length,0);
 assert.equal((await request(path,u.token)).data.guardian.status,'PENDING');assert.equal((await admin.query("SELECT count(*)::int n FROM guardian_relationships WHERE patient_id=$1 AND status='REVOKED'",[u.id])).rows[0].n,2);
});
test('P2-07 removal pending/active is immediate, idempotent and invalidates old invite',async()=>{
 for(const active of [false,true]){const u=await user(),a=await add(u),token=await invitation(a.email);if(active)assert.equal((await accept(token)).status,200);
 assert.equal((await request(path,u.token,undefined,'DELETE')).status,200);assert.equal((await eligible(u.id)).length,0);assert.equal((await accept(token)).status,400);assert.equal((await request(path,u.token)).data.guardian.status,'REVOKED');assert.equal((await request(path,u.token,undefined,'DELETE')).status,200);}
});
test('P2-08 two concurrent additions serialize to exactly one PENDING primary',async()=>{
 const u=await user();const results=await Promise.all([request(path,u.token,{email:'one@example.invalid'}),request(path,u.token,{email:'two@example.invalid'})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM guardian_relationships WHERE patient_id=$1 AND status IN ('PENDING','ACTIVE')",[u.id])).rows[0].n,1);
});
test('P2-09 accept racing replacement ends only new PENDING; accept racing removal ends REVOKED',async()=>{
 for(const replace of [true,false]){const u=await user(),a=await add(u),token=await invitation(a.email);await age(u.id);
 const r=await Promise.all([accept(token),request(path,u.token,replace?{email:randomUUID()+'@example.invalid'}:undefined,replace?'PUT':'DELETE')]);
 assert.ok([200,400].includes(r[0].status));assert.equal(r[1].status,200);assert.equal((await eligible(u.id)).length,0);assert.equal((await request(path,u.token)).data.guardian.status,replace?'PENDING':'REVOKED');assert.equal((await accept(token)).status,400);}
});
test('P2-10 cross-patient management/body injection denied; current M01 state enforced',async()=>{
 const a=await user(),b=await user();await add(a);assert.equal((await request('/patients/'+a.id+'/guardian',b.token)).status,404);
 assert.equal((await request(path,b.token,{email:'x@example.invalid',patient_id:a.id})).status,400);assert.equal((await request(path,b.token)).data.guardian.status,'NONE');
 assert.equal((await request(path)).status,401);await security.logout(a.who);assert.equal((await request(path,a.token)).status,401);
 await db.query("UPDATE patients SET account_status='suspended' WHERE id=$1",[b.id]);assert.equal((await request(path,b.token)).status,401);
});
test('P2-11 database rejects a second primary and activation without accepted invitation',async()=>{
 const u=await user(),a=await add(u);
 await assert.rejects(db.query("INSERT INTO guardian_relationships(id,patient_id,email,status) VALUES($1,$2,'duplicate@example.invalid','PENDING')",[randomUUID(),u.id]),{code:'23505'});
 await assert.rejects(db.query("UPDATE guardian_relationships SET status='ACTIVE',accepted_at=clock_timestamp() WHERE id=$1",[a.g.id]),{code:'23514'});
 const other=await user();await assert.rejects(db.query('UPDATE guardian_relationships SET patient_id=$2 WHERE id=$1',[a.g.id,other.id]),{code:'23514'});
});
test('P2-12 failed queue insertion rolls back nomination; stale queued invitation is suppressed',async()=>{
 const u=await user();const broken=createGuardianRepository(db,policy,{send:async()=>{},enqueue:async()=>{throw Error('synthetic queue failure');}});await assert.rejects(broken.nominate(u.who,'failed@example.invalid'));
 assert.equal((await request(path,u.token)).data.guardian.status,'NONE');const a=await add(u);const n=sent.length;await request(path,u.token,undefined,'DELETE');await delivery.drain(100);assert.equal(sent.slice(n).some(m=>m.to===a.email),false);
});

const pdf=syntheticDigitalPdf([['Synthetic nonmedical fixture']]);
async function upload(u:Awaited<ReturnType<typeof user>>,bytes:Buffer=pdf,name='report.pdf',mime='application/pdf',fields:Record<string,string>={}){
 const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)],{type:mime}),name);form.append('category',fields.category??'lab_report');form.append('hospital_name',fields.hospital_name??'Synthetic Hospital');for(const [k,v]of Object.entries(fields))if(!['category','hospital_name'].includes(k))form.append(k,v);
 const r=await fetch(base+'/documents',{method:'POST',headers:{Authorization:'Bearer '+u.token},body:form,signal:AbortSignal.timeout(15000)});return {status:r.status,data:await r.json()};
}
test('P2-13 PDF/JPG/JPEG/PNG uploads persist exact metadata, SHA256 and private owner references',async()=>{
 const u=await user(),png=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).png().toBuffer(),jpeg=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).jpeg().toBuffer();
 for(const [bytes,name,mime,category]of [[pdf,'report.pdf','application/pdf','lab_report'],[jpeg,'report.jpg','image/jpeg','prescription'],[jpeg,'report.jpeg','image/jpeg','other_medical_document'],[png,'report.png','image/png','other_medical_document']] as const){
  const r=await upload(u,bytes,name,mime,{category,document_date:'2026-01-02'});assert.equal(r.status,201);const d=r.data.document;
  assert.equal(d.category,category);assert.equal(d.hospital_name,'Synthetic Hospital');assert.equal(d.document_date,'2026-01-02');assert.ok(Number.isFinite(Date.parse(d.uploaded_at)));assert.equal(d.original_filename,name);assert.equal(d.content_type,mime);assert.equal(Number(d.size_bytes),bytes.length);assert.equal(d.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(d.processing_status,'processing');assert.equal('s3_object_key' in d,false);
  const stored=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[d.id])).rows[0];assert.equal(stored.patient_id,u.id);assert.deepEqual(objects.get(stored.s3_object_key),bytes);
  const download=await fetch(base+'/documents/'+d.id+'/download',{headers:{Authorization:'Bearer '+u.token}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);assert.equal(download.headers.get('content-type'),mime);
 }
});
test('P2-14 unsupported, mismatched MIME, signatures, malformed, empty and oversized files reject before storage',async()=>{
 const u=await user(),before=puts;
 for(const [bytes,name,mime]of [[pdf,'report.exe','application/pdf'],[pdf,'report.pdf','image/png'],[Buffer.from('not a png'),'report.png','image/png'],[Buffer.from('%PDF-1.7\nbroken'),'report.pdf','application/pdf'],[Buffer.alloc(4097),'report.pdf','application/pdf'],[Buffer.alloc(0),'report.pdf','application/pdf']] as const){const r=await upload(u,bytes,name,mime);assert.ok(r.status>=400);}
 assert.equal(puts,before);assert.equal((await admin.query('SELECT count(*)::int n FROM medical_documents WHERE patient_id=$1',[u.id])).rows[0].n,0);
});
test('P2-15 categories/hospital/date validated; filename sanitized; confirmed values editable only by owner',async()=>{
 const u=await user(),b=await user();for(const fields of [{category:'unsupported'},{hospital_name:''},{document_date:'2026-02-30'},{document_date:'2999-01-01'},{patient_id:b.id}] as Record<string,string>[])assert.ok((await upload(u,pdf,'report.pdf','application/pdf',fields)).status>=400);
 const r=await upload(u,pdf,'../../unsafe<name>.pdf','application/pdf',{category:'other_medical_document',document_date:'2026-01-02'});assert.equal(r.status,201);const id=r.data.document.id;assert.equal(r.data.document.original_filename,'unsafe_name_.pdf');
 assert.equal((await request('/documents/'+id,b.token,{hospital_name:'Other Hospital'},'PATCH')).status,404);
 const patch=await request('/documents/'+id,u.token,{hospital_name:'Confirmed Hospital',document_date:'2026-02-03'},'PATCH');assert.equal(patch.status,200);assert.equal(patch.data.document.hospital_name,'Confirmed Hospital');assert.equal(patch.data.document.document_date,'2026-02-03');
});
test('P2-16 identifier/reference/query cannot bypass private owner/session checks; no signed URL response',async()=>{
 const a=await user(),b=await user(),r=await upload(a);assert.equal(r.status,201);const id=r.data.document.id,n=reads;
 assert.equal((await request('/documents/'+id,b.token)).status,404);assert.equal((await request('/documents/'+id+'/download',b.token)).status,404);assert.equal((await request('/documents/'+id+'/download')).status,401);assert.equal(reads,n);
 assert.equal((await request('/documents/'+id+'/download?url=https://example.invalid',a.token)).status,400);
 assert.equal(JSON.stringify(r.data).includes('https://'),false);await security.logout(a.who);assert.equal((await request('/documents/'+id+'/download',a.token)).status,401);
});
test('P2-17 persisted digest catches same-size object tampering before response bytes',async()=>{
 const u=await user(),r=await upload(u);const d=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[r.data.document.id])).rows[0],bytes=Buffer.from(objects.get(d.s3_object_key)!);bytes[10]^=1;objects.set(d.s3_object_key,bytes);
 const response=await request('/documents/'+d.id+'/download',u.token);assert.equal(response.status,503);assert.equal(JSON.stringify(response.data).includes('%PDF'),false);
});
test('P2-18 failure/retry preserves owner, immutable original and metadata; unsafe retries denied',async()=>{
 const u=await user(),other=await user(),r=await upload(u);const id=r.data.document.id,before=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];
 await admin.query("UPDATE document_processing_jobs SET state='failed',attempt_count=1,started_at=clock_timestamp()-interval '2 seconds',finished_at=clock_timestamp(),last_error_code='PROCESSOR_FAILED' WHERE document_id=$1",[id]);await db.query("UPDATE medical_documents SET processing_status='failed' WHERE id=$1",[id]);
 assert.ok(objects.has(before.s3_object_key));assert.equal((await request('/documents/'+id+'/download',u.token)).status,200);
 const retry=createPatientProcessingRepository(db,{patientId:u.id,uploadCutoff:'2020-01-01T00:00:00.000Z'});assert.equal(await retry.retry(id,other.id),false);assert.equal(await retry.retry(id,u.id),true);assert.equal(await retry.retry(id,u.id),false);
 const after=(await admin.query('SELECT * FROM medical_documents WHERE id=$1',[id])).rows[0];for(const key of ['patient_id','s3_bucket','s3_object_key','sha256','size_bytes','original_filename','document_date'])assert.equal(after[key],before[key]);assert.equal(after.processing_status,'processing');assert.deepEqual(objects.get(before.s3_object_key),pdf);
 await assert.rejects(db.query('UPDATE medical_documents SET patient_id=$2 WHERE id=$1',[id,other.id]),{code:'23514'});await assert.rejects(db.query("UPDATE medical_documents SET sha256=repeat('a',64) WHERE id=$1",[id]),{code:'23514'});
 // The public retry endpoint remains gated by the existing canary approval contract.
 assert.equal((await request('/documents/'+id+'/processing-retries',u.token,{})).status,503);
});
test('P2-19 extraction evidence completion does not mark aggregate OCR/AI work complete',async()=>{
 const u=await user(),r=await upload(u),id=r.data.document.id,claim=randomUUID();const hash=r.data.document.sha256;
 await admin.query("UPDATE document_processing_jobs SET state='running',attempt_count=1,started_at=clock_timestamp(),lease_token=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_deadline_at=clock_timestamp()+interval '60 seconds' WHERE document_id=$1",[id,claim]);
 const metadata={schemaVersion:1,method:'pdf_text',extractor:{name:'synthetic',version:'test-v1'},source:{sha256:hash,pageCount:1,pages:[{page:1,method:'pdf_text'}]}};
 await assert.rejects(db.query('SELECT persist_document_extraction($1,$2,$3,$4,$5,$6)',[id,u.id,claim,'Synthetic extraction fixture',{...metadata,source:{...metadata.source,sha256:'a'.repeat(64)}},'test-v1']),{code:'23514'});
 assert.equal((await db.query('SELECT persist_document_extraction($1,$2,$3,$4,$5,$6) AS ok',[id,u.id,claim,'Synthetic extraction fixture',metadata,'test-v1'])).rows[0].ok,true);
 assert.equal((await admin.query('SELECT state FROM document_processing_jobs WHERE document_id=$1',[id])).rows[0].state,'completed');assert.equal((await request('/documents/'+id,u.token)).data.document.processing_status,'processing');
 assert.equal((await request('/documents/'+id+'/processing',u.token)).data.processing.stage,'extraction');
 await db.query("UPDATE medical_documents SET processing_status='completed' WHERE id=$1",[id]);assert.equal((await request('/documents/'+id,u.token)).data.document.processing_status,'processing');
});
test('P2-20 real registration with/without guardian intent remains optional; later authenticated nomination verifies separately',async()=>{
 for(const intent of [undefined,'registered-guardian-'+randomUUID()+'@example.invalid']){
  const email=randomUUID()+'@example.invalid',password='Synthetic registration passphrase 826!';
  const registration=await request('/auth/register',undefined,{email,password,full_name:'Synthetic Registration',...(intent?{pending_guardian_email:intent}:{})});assert.equal(registration.status,201);
  await delivery.drain(100);const message=sent.find(m=>m.to===email&&m.subject.includes('Verify'));assert.ok(message);const code=message.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(code);
  assert.equal((await request('/auth/verify-email',undefined,{token:code})).status,200);const login=await request('/auth/login',undefined,{email,password});assert.equal(login.status,200);
  assert.equal((await request(path,login.data.access_token)).data.guardian.status,intent?'PENDING':'NONE');
  if(intent){const invitationCode=await invitation(intent);assert.equal((await eligible(registration.data.patient.id)).length,0);assert.equal((await accept(invitationCode)).status,200);}
 }
});
test('P2-21 simultaneous accepts consume once; account restrictions block pending acceptance',async()=>{
 const u=await user(),a=await add(u),code=await invitation(a.email);const both=await Promise.all([accept(code),accept(code)]);assert.deepEqual(both.map(r=>r.status).sort(),[200,400]);
 const v=await user(),b=await add(v),pending=await invitation(b.email);await db.query("UPDATE patients SET account_status='suspended' WHERE id=$1",[v.id]);assert.equal((await accept(pending)).status,400);assert.equal((await eligible(v.id)).length,0);
});
test('P2-22 configured decoder quotas and active PDF content reject before storage',async()=>{
 const u=await user(),n=puts,png=await sharp({create:{width:40,height:40,channels:3,background:'white'}}).png().toBuffer();
 for(const [bytes,name,mime]of [[png,'large.png','image/png'],[syntheticDigitalPdf([[],[],[]]),'pages.pdf','application/pdf'],[syntheticDigitalPdf([[]],{javascript:true}),'active.pdf','application/pdf']] as const)assert.equal((await upload(u,bytes,name,mime)).status,422);
 assert.equal(puts,n);
});
test('P2-23 optional guardian enqueue failure preserves successful M01 verification and recoverable intent',async()=>{
 const original=delivery.mailer.enqueue!;delivery.mailer.enqueue=async(message,c)=>{if(message.purpose==='guardian_invitation')throw Error('synthetic guardian queue outage');await original(message,c);};
 const email=randomUUID()+'@example.invalid',password='Synthetic registration passphrase 756!';let id='',access='';
 try{
  const r=await request('/auth/register',undefined,{email,password,full_name:'Synthetic Registration',pending_guardian_email:'deferred@example.invalid'});assert.equal(r.status,201);id=r.data.patient.id;
  await delivery.drain(100);const m=sent.find(m=>m.to===email&&m.subject.includes('Verify'));assert.ok(m);const token=m.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];assert.ok(token);assert.equal((await request('/auth/verify-email',undefined,{token})).status,200);
  const login=await request('/auth/login',undefined,{email,password});assert.equal(login.status,200);access=login.data.access_token;assert.equal((await request(path,access)).data.guardian.status,'NONE');assert.equal((await eligible(id)).length,0);
 }finally{delivery.mailer.enqueue=original;}
 assert.equal((await request(path,access,{})).status,201);assert.equal((await request(path,access)).data.guardian.status,'PENDING');
});

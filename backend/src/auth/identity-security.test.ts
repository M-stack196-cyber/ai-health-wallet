import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import express from 'express';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {createSecurityEmailDelivery,securityEmailConfig,type SecurityEmailConfig} from './security-email.js';
import {createSecurityEmailSandbox} from './security-email-sandbox.js';
import pg from 'pg';
import {SignJWT} from 'jose';
import type {AuthenticationConfig} from '../config/auth.js';
import {createPatientRoutes,type SecurityMailer,type SecurityMailMessage} from './routes.js';
import {createDocumentRoutes} from '../documents/routes.js';
import {createProcessingRoutes} from '../processing/api.js';
import {createSummaryRoutes} from '../summaries/routes.js';
import {errorHandler} from '../http/errors.js';
import {createSecurityRepository,secretHash} from './security-repository.js';
import {createTokenService} from './tokens.js';
import {getSecurityPolicy} from './security-policy.js';
import type {DocumentStorage} from '../documents/storage.js';
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Only the test-owned Unix socket is allowed.');
const config:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'identity-test',jwtAudience:'identity-patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:8,rateLimitWindowMs:900000,rateLimitMax:10000};
const policy={...getSecurityPolicy(),challengeRateMax:10000,resendCooldownSeconds:1};
const conn={host:socket,port:55481,database:'hw_identity_phase1'};
const admin=new pg.Pool({...conn,user:userInfo().username});
const db=new pg.Pool({...conn,user:'health_wallet_app',max:12});
const mail:SecurityMailMessage[]=[];
let failMail=false,storageReads=0,fileHook:(()=>Promise<void>)|undefined;
const mailer:SecurityMailer={async send(m){if(failMail)throw Error('synthetic provider failure');mail.push(m);}};
const repo=createSecurityRepository(db,policy),password='Synthetic secure passphrase 310!',replacement='Replacement secure phrase 498!';
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string;
const docConfig={maxFileBytes:4096,maxConcurrentUploads:2,uploadTimeoutMs:3000,validationTimeoutMs:1000,maxImagePixels:1000,maxPdfPages:1,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const storage:DocumentStorage={bucket:'synthetic-private-bucket',prefix:'medical-documents/',async put(){throw Error('not used');},async remove(){throw Error('not used');},async download(){throw Error('URL signing forbidden');},async readOriginal(input){storageReads++;if(fileHook)await fileHook();const bytes=Buffer.from('Synthetic original bytes');await writeFile(input.destination,bytes,{flag:'wx',mode:0o600});return {bytes:bytes.length};}};
before(async()=>{
 assert.equal((await stat(socket)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try {await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_identity_phase1');}finally{await bootstrap.end();}
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,8);
 if(process.env.IDENTITY_TEST_SCHEMA_FILE){
  assert.equal(process.env.IDENTITY_TEST_SCHEMA_FILE,socket+'/development-schema.dump');
  const restored=spawnSync('/usr/bin/pg_restore',['--no-owner','--no-privileges','--exit-on-error','--host='+socket,'--port=55481','--username='+userInfo().username,'--dbname=hw_identity_phase1',process.env.IDENTITY_TEST_SCHEMA_FILE],{encoding:'utf8',timeout:30000});
  assert.equal(restored.status,0,'development schema archive restores into disposable cluster');
  await admin.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO health_wallet_app; REVOKE UPDATE,DELETE ON patient_security_events,patient_refresh_history FROM health_wallet_app; REVOKE DELETE ON patient_auth_sessions,patient_auth_challenges,patient_auth_rate_limits,patient_security_email_deliveries FROM health_wallet_app; REVOKE UPDATE ON patient_security_email_payloads FROM health_wallet_app');
  for(const migration of files.filter(f=>f>='0007'))await admin.query(await readFile(new URL('../../migrations/'+migration,import.meta.url),'utf8'));
 }else for(const f of files){
  if(f.startsWith('0005'))await admin.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const c=await admin.connect();try{await c.query('BEGIN');await c.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const routes=createPatientRoutes(db,config,{mailer,policy});app.use('/api/v1/auth',routes.auth);app.use('/api/v1/patients',routes.profile);
 app.use('/api/v1',createProcessingRoutes(db,config));app.use('/api/v1',createSummaryRoutes(db,config));app.use('/api/v1/documents',createDocumentRoutes(db,config,docConfig,storage));app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');base='http://127.0.0.1:'+address.port;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await db.end();await admin.end();});
async function request(path:string,body?:unknown,token?:string,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+'/api/v1'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const text=await r.text();assert.ok(r.headers.get('cache-control')?.includes('no-store'));assert.ok(!text.includes('password_hash')&&!text.includes('$argon2')&&!text.includes('SYNTHETIC_SECRET'));
 return {status:r.status,data:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};
}
async function registered(verify=true){const email='synthetic-'+randomUUID()+'@example.invalid';const r=await request('/auth/register',{email,password,full_name:'Synthetic Patient',sex_gender:'prefer_not_to_say',pending_guardian_email:'future@example.invalid'});assert.equal(r.status,201);const challenge=mail.find(m=>m.to===email&&m.purpose==='verify_email')!;assert.ok(challenge);if(verify)assert.equal((await request('/auth/verify-email',{token:challenge.token})).status,200);return {email,id:r.data.patient.id,challenge};}
async function login(email:string,pass=password){const r=await request('/auth/login',{email,password:pass});assert.equal(r.status,200);return r.data as {access_token:string;refresh_token:string};}
async function doc(patient:string){const id=randomUUID();await db.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,hospital_name,processing_status,content_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'synthetic.pdf','pdf','lab_report','Synthetic Hospital','failed','application/pdf',24,'02be06dafdca1e35e82ce33d549485f29627c07274b644fafb0e54befbe732de')`,[id,patient,storage.bucket,storage.prefix+id+'.pdf']);return id;}

test('registration is unverified, profile fields are scoped and no guardian relationship is activated',async()=>{
 const u=await registered(false);assert.equal((await request('/auth/login',{email:u.email,password})).status,401);
 const p=(await admin.query('SELECT * FROM patients WHERE id=$1',[u.id])).rows[0];assert.equal(p.account_status,'unverified');assert.equal(p.email_verified_at,null);assert.equal(p.pending_guardian_email,'future@example.invalid');assert.match(p.password_hash,/^\$argon2id\$/);assert.equal((await admin.query('SELECT count(*)::int AS n FROM guardian_contacts')).rows[0].n,0);
 assert.equal((await request('/auth/register',{email:u.email,password,full_name:'Duplicate'})).status,409);
 for(const body of [{email:'bad',password,full_name:'Synthetic'},{email:u.email,password:'short',full_name:'Synthetic'},{email:u.email,password,full_name:'Synthetic',account_status:'active'}])assert.equal((await request('/auth/register',body)).status,400);
});
test('email verification is hashed, purpose-bound, single-use and rejects expiry/unknown tokens',async()=>{
 const u=await registered(false);const token=u.challenge.token;const row=(await admin.query('SELECT * FROM patient_auth_challenges WHERE id=$1',[token.slice(0,36)])).rows[0];assert.equal(row.token_hash,secretHash('verify_email',token));assert.ok(!JSON.stringify(row).includes(token));
 assert.equal((await request('/auth/reset-password',{token,new_password:replacement})).status,400);
 assert.equal((await request('/auth/verify-email',{token:token.slice(0,-1)+(token.endsWith('0')?'1':'0')})).status,400);
 assert.equal((await request('/auth/verify-email',{token})).status,200);assert.equal((await request('/auth/verify-email',{token})).status,400);await login(u.email);
 const expired=await registered(false);await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[expired.challenge.token.slice(0,36)]);assert.equal((await request('/auth/verify-email',{token:expired.challenge.token})).status,400);
});
test('resend is generic, cooldown bounded, invalidates old challenge and enforces persisted rates',async()=>{
 const u=await registered(false),start=mail.length;assert.equal((await request('/auth/verification/resend',{email:u.email})).status,202);assert.equal(mail.length,start);
 await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '5 seconds' WHERE patient_id=$1",[u.id]);assert.equal((await request('/auth/verification/resend',{email:u.email})).status,202);const next=mail.at(-1)!;assert.notEqual(next.token,u.challenge.token);assert.equal((await request('/auth/verify-email',{token:u.challenge.token})).status,400);assert.equal((await request('/auth/verify-email',{token:next.token})).status,200);
 const key=randomBytes(32).toString('hex');assert.equal(await repo.rate(key,2,900),true);assert.equal(await repo.rate(key,2,900),true);assert.equal(await repo.rate(key,2,900),false);
});
test('unverified/unknown/verified recovery has the same response; only verified active email receives reset',async()=>{
 const unverified=await registered(false),active=await registered();const start=mail.length;
 const a=await request('/auth/forgot-password',{email:unverified.email}),b=await request('/auth/forgot-password',{email:'unknown@example.invalid'}),c=await request('/auth/forgot-password',{email:active.email});assert.deepEqual(a,b);assert.deepEqual(b,c);assert.equal(c.status,202);assert.equal(mail.length,start+1);assert.equal(mail.at(-1)!.to,active.email);
 failMail=true;try{const x=await registered(false).catch(()=>null);assert.equal(x,null);const r=await request('/auth/forgot-password',{email:'unknown@example.invalid'});assert.equal(r.status,202);}finally{failMail=false;}
});
test('login preserves generic errors, emits bounded access/session tokens and denies expired/malformed/legacy JWTs',async()=>{
 const u=await registered(),s=await login(u.email);const p=await request('/patients/me',undefined,s.access_token);assert.equal(p.status,200);assert.equal(p.data.patient.id,u.id);
 const a=await request('/auth/login',{email:u.email,password:'wrong synthetic pass'}),b=await request('/auth/login',{email:'unknown@example.invalid',password:'wrong synthetic pass'});assert.deepEqual(a,b);
 const sid=s.refresh_token.slice(0,36),now=Math.floor(Date.now()/1000);
 const expired=await new SignJWT({sid}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(u.id).setIssuer(config.jwtIssuer).setAudience(config.jwtAudience).setIssuedAt(now-1000).setExpirationTime(now-100).sign(config.jwtKey);
 for(const token of [expired,'invalid',await createTokenService(config).issue(u.id)])assert.equal((await request('/patients/me',undefined,token)).status,401);
});
test('refresh rotates once, has a fixed absolute bound and replay commits family revocation',async()=>{
 const u=await registered(),s=await login(u.email);const before=(await admin.query('SELECT expires_at FROM patient_auth_sessions WHERE id=$1',[s.refresh_token.slice(0,36)])).rows[0].expires_at;
 const fresh=await request('/auth/refresh',{refresh_token:s.refresh_token});assert.equal(fresh.status,200);assert.notEqual(fresh.data.refresh_token,s.refresh_token);assert.equal((await admin.query('SELECT expires_at FROM patient_auth_sessions WHERE id=$1',[s.refresh_token.slice(0,36)])).rows[0].expires_at.getTime(),before.getTime());
 assert.equal((await request('/auth/refresh',{refresh_token:s.refresh_token})).status,401);assert.equal((await request('/patients/me',undefined,fresh.data.access_token)).status,401);assert.equal((await request('/auth/refresh',{refresh_token:fresh.data.refresh_token})).status,401);
});
test('random invalid refresh secret cannot revoke a valid session',async()=>{
 const u=await registered(),s=await login(u.email);assert.equal((await request('/auth/refresh',{refresh_token:s.refresh_token.slice(0,37)+randomBytes(32).toString('hex')})).status,401);assert.equal((await request('/patients/me',undefined,s.access_token)).status,200);
});
test('simultaneous refresh has one rotation and reuse permanently denies resulting credentials',async()=>{
 const u=await registered(),s=await login(u.email);const results=await Promise.all([request('/auth/refresh',{refresh_token:s.refresh_token}),request('/auth/refresh',{refresh_token:s.refresh_token})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);const winner=results.find(r=>r.status===200)!;assert.equal((await request('/patients/me',undefined,winner.data.access_token)).status,401);
});
test('logout revokes the current session immediately without revoking another login',async()=>{
 const u=await registered(),a=await login(u.email),b=await login(u.email);assert.equal((await request('/auth/logout',{},a.access_token)).status,200);assert.equal((await request('/patients/me',undefined,a.access_token)).status,401);assert.equal((await request('/auth/refresh',{refresh_token:a.refresh_token})).status,401);assert.equal((await request('/patients/me',undefined,b.access_token)).status,200);
});
test('absolute and idle expired sessions deny protected requests and refresh',async()=>{
 for(const column of ['expires_at','idle_expires_at']){const u=await registered(),s=await login(u.email);await admin.query(`UPDATE patient_auth_sessions SET created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day',idle_expires_at=statement_timestamp()-interval '1 day' WHERE id=$1`,[s.refresh_token.slice(0,36)]);if(column==='idle_expires_at')await admin.query("UPDATE patient_auth_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",[s.refresh_token.slice(0,36)]);assert.equal((await request('/patients/me',undefined,s.access_token)).status,401);assert.equal((await request('/auth/refresh',{refresh_token:s.refresh_token})).status,401);}
});
test('reset token is expiring/one-use, changes credential and invalidates every prior session',async()=>{
 const u=await registered(),a=await login(u.email),b=await login(u.email);await request('/auth/forgot-password',{email:u.email});const token=mail.at(-1)!.token;
 assert.equal((await request('/auth/verify-email',{token})).status,400);
 const results=await Promise.all([request('/auth/reset-password',{token,new_password:replacement}),request('/auth/reset-password',{token,new_password:replacement})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
 for(const s of [a,b]){assert.equal((await request('/patients/me',undefined,s.access_token)).status,401);assert.equal((await request('/auth/refresh',{refresh_token:s.refresh_token})).status,401);}
 assert.equal((await request('/auth/login',{email:u.email,password})).status,401);await login(u.email,replacement);
 const v=await registered();await request('/auth/forgot-password',{email:v.email});const expired=mail.at(-1)!.token;await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[expired.slice(0,36)]);assert.equal((await request('/auth/reset-password',{token:expired,new_password:replacement})).status,400);
});
test('reset racing refresh never permits pre-reset credentials to regain access',async()=>{
 const u=await registered(),s=await login(u.email);await request('/auth/forgot-password',{email:u.email});const reset=mail.at(-1)!.token;
 const [r,f]=await Promise.all([request('/auth/reset-password',{token:reset,new_password:replacement}),request('/auth/refresh',{refresh_token:s.refresh_token})]);assert.equal(r.status,200);assert.ok([200,401].includes(f.status));assert.equal((await request('/patients/me',undefined,s.access_token)).status,401);if(f.status===200)assert.equal((await request('/patients/me',undefined,f.data.access_token)).status,401);
});
test('authenticated password change rejects wrong/weak inputs and invalidates all prior sessions',async()=>{
 const u=await registered(),a=await login(u.email),b=await login(u.email);assert.equal((await request('/auth/change-password',{current_password:'wrong',new_password:replacement},a.access_token)).status,401);assert.equal((await request('/auth/change-password',{current_password:password,new_password:'short'},a.access_token)).status,400);assert.equal((await request('/auth/change-password',{current_password:password,new_password:replacement},a.access_token)).status,200);
 for(const s of [a,b]){assert.equal((await request('/patients/me',undefined,s.access_token)).status,401);assert.equal((await request('/auth/refresh',{refresh_token:s.refresh_token})).status,401);}await login(u.email,replacement);
});
test('suspended/deleted/restricted/revoked accounts deny login/access/refresh; reactivation does not resurrect sessions',async()=>{
 for(const status of ['suspended','deletion_pending','deletion_restricted','deleted','revoked']){const u=await registered(),s=await login(u.email);await admin.query('UPDATE patients SET account_status=$2 WHERE id=$1',[u.id,status]);assert.equal((await request('/auth/login',{email:u.email,password})).status,401);assert.equal((await request('/patients/me',undefined,s.access_token)).status,401);assert.equal((await request('/auth/refresh',{refresh_token:s.refresh_token})).status,401);await admin.query("UPDATE patients SET account_status='active' WHERE id=$1",[u.id]);assert.equal((await request('/patients/me',undefined,s.access_token)).status,401);}
});
test('cross-patient profile/document isolation and current authorization cover file, processing and summary paths',async()=>{
 const u=await registered(),v=await registered(),a=await login(u.email),b=await login(v.email),id=await doc(u.id);
 assert.equal((await request('/patients/me',{full_name:'Owned update'},a.access_token,'PATCH')).status,200);assert.equal((await request('/patients/me',undefined,b.access_token)).data.patient.full_name,'Synthetic Patient');assert.equal((await request('/patients/me',{id:v.id},a.access_token,'PATCH')).status,400);
 assert.equal((await request('/documents/'+id+'/download',undefined,a.access_token)).status,200);assert.equal((await request('/documents/'+id+'/download',undefined,b.access_token)).status,404);
 await request('/auth/logout',{},a.access_token);const before=storageReads;
 for(const path of ['/documents','/documents/'+id,'/documents/'+id+'/download','/documents/'+id+'/processing','/documents/'+id+'/summary','/summary-jobs/'+randomUUID()])assert.equal((await request(path,undefined,a.access_token)).status,401);
 assert.equal(storageReads,before);assert.equal((await request('/documents/'+id+'/summary-jobs',{},a.access_token)).status,401);
});
test('revocation during original acquisition denies bytes before streaming',async()=>{
 const u=await registered(),s=await login(u.email),id=await doc(u.id);fileHook=async()=>{await repo.logout({patientId:u.id,sessionId:s.refresh_token.slice(0,36)});};try{assert.equal((await request('/documents/'+id+'/download',undefined,s.access_token)).status,401);}finally{fileHook=undefined;}
});
test('tokens never persist plaintext; audit is minimized and append-only for runtime role',async()=>{
 const u=await registered(),s=await login(u.email);await request('/auth/forgot-password',{email:u.email});
 const rows=await admin.query('SELECT to_jsonb(s) AS row FROM patient_auth_sessions s WHERE patient_id=$1',[u.id]);assert.ok(!JSON.stringify(rows.rows).includes(s.refresh_token));
 const challenges=await admin.query('SELECT * FROM patient_auth_challenges WHERE patient_id=$1',[u.id]);for(const m of mail.filter(m=>m.to===u.email))assert.ok(!JSON.stringify(challenges.rows).includes(m.token));
 const events=await db.query('SELECT * FROM patient_security_events WHERE patient_id=$1',[u.id]);assert.ok(events.rows.length>0);assert.deepEqual(Object.keys(events.rows[0]).sort(),['event','id','occurred_at','patient_id','session_id']);
 await assert.rejects(db.query('DELETE FROM patient_security_events WHERE patient_id=$1',[u.id]),/permission denied/);await assert.rejects(db.query("UPDATE patient_security_events SET event='login_failed' WHERE patient_id=$1",[u.id]),/permission denied/);
});

async function withAuthRouter(authConfig:AuthenticationConfig,overrides:Parameters<typeof createPatientRoutes>[2],work:()=>Promise<void>){
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});const routes=createPatientRoutes(db,authConfig,overrides);app.use('/api/v1/auth',routes.auth);app.use('/api/v1/patients',routes.profile);app.use(errorHandler);
 const local=app.listen(0,'127.0.0.1');await once(local,'listening');const address=local.address();assert.ok(address&&typeof address==='object');const original=base;base='http://127.0.0.1:'+address.port;
 try{await work();}finally{base=original;local.closeAllConnections();await new Promise<void>(resolve=>local.close(()=>resolve()));}
}
test('resend/recovery endpoints apply persistent limits and generic errors',async()=>{
 for(const path of ['/auth/verification/resend','/auth/forgot-password']){
  await admin.query('DELETE FROM patient_auth_rate_limits');
  await withAuthRouter(config,{mailer,policy:{...policy,challengeRateMax:2}},async()=>{
   assert.equal((await request(path,{email:'unknown@example.invalid'})).status,202);assert.equal((await request(path,{email:'other-unknown@example.invalid'})).status,202);assert.equal((await request(path,{email:'unknown@example.invalid'})).status,429);
  });
 }
 await admin.query('DELETE FROM patient_auth_rate_limits');
});
test('login endpoint bounds repeated attempts including unknown identities',async()=>{
 await withAuthRouter({...config,rateLimitMax:2},{mailer,policy},async()=>{
  for(let n=0;n<2;n++)assert.equal((await request('/auth/login',{email:'unknown@example.invalid',password})).status,401);
  assert.equal((await request('/auth/login',{email:'unknown@example.invalid',password})).status,429);
 });
 await admin.query('DELETE FROM patient_auth_rate_limits');
});
test('missing email transport fails closed uniformly without creating an account',async()=>{
 const email='synthetic-'+randomUUID()+'@example.invalid';
 await withAuthRouter(config,{policy},async()=>{
  for(const path of ['/auth/forgot-password','/auth/verification/resend'])assert.equal((await request(path,{email})).status,503);
  assert.equal((await request('/auth/register',{email,password,full_name:'Synthetic'})).status,503);
 });
 assert.equal((await admin.query('SELECT id FROM patients WHERE email=$1',[email])).rowCount,0);
});
test('simultaneous verification consumes a challenge once and database rate admission is atomic',async()=>{
 const u=await registered(false);const result=await Promise.all([request('/auth/verify-email',{token:u.challenge.token}),request('/auth/verify-email',{token:u.challenge.token})]);assert.deepEqual(result.map(r=>r.status).sort(),[200,400]);
 const key=randomBytes(32).toString('hex'),limited=await Promise.all(Array.from({length:8},()=>repo.rate(key,2,900)));assert.equal(limited.filter(Boolean).length,2);
});
test('refresh response reflects remaining absolute expiry rather than extending it',async()=>{
 const u=await registered(),s=await login(u.email);await admin.query("UPDATE patient_auth_sessions SET expires_at=clock_timestamp()+interval '120 seconds',idle_expires_at=clock_timestamp()+interval '100 seconds' WHERE id=$1",[s.refresh_token.slice(0,36)]);
 const result=await request('/auth/refresh',{refresh_token:s.refresh_token});assert.equal(result.status,200);assert.ok(result.data.refresh_expires_in<=120&&result.data.refresh_expires_in>0);
});
test('reset rolls back credential, challenge and sessions when required audit persistence fails',async()=>{
 const u=await registered(),s=await login(u.email);await request('/auth/forgot-password',{email:u.email});const token=mail.at(-1)!.token;
 await admin.query(`CREATE FUNCTION public.identity_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='password_reset' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER identity_test_audit_failure BEFORE INSERT ON patient_security_events FOR EACH ROW EXECUTE FUNCTION public.identity_test_audit_failure()`);
 try{assert.equal((await request('/auth/reset-password',{token,new_password:replacement})).status,500);assert.equal((await request('/patients/me',undefined,s.access_token)).status,200);assert.equal((await admin.query('SELECT consumed_at FROM patient_auth_challenges WHERE id=$1',[token.slice(0,36)])).rows[0].consumed_at,null);await login(u.email);}
 finally{await admin.query('DROP TRIGGER identity_test_audit_failure ON patient_security_events; DROP FUNCTION public.identity_test_audit_failure()');}
 assert.equal((await request('/auth/reset-password',{token,new_password:replacement})).status,200);
});
test('equal idle and absolute lifetime configuration creates a valid bounded session',async()=>{
 const u=await registered();const equal=createSecurityRepository(db,{...policy,refreshAbsoluteSeconds:300,refreshIdleSeconds:300});const hash=(await admin.query('SELECT password_hash FROM patients WHERE id=$1',[u.id])).rows[0].password_hash;const s=await equal.login(u.id,hash);assert.ok(s);assert.ok(s.refreshExpiresIn<=300&&s.refreshExpiresIn>0);
});

// Phase 1B local HTTP sandbox. Messages stay in memory; TAP contains test names only.
const emailKey=randomBytes(32),captured:Array<{idempotencyKey:string;from:string;to:string;subject:string;text:string}>=[];
let relayStatus=202,relayRequests=0;
const relayReferences=new Map<string,string>();
let relay:ReturnType<typeof createServer>,emailConfig:SecurityEmailConfig;
before(async()=>{
 relay=createServer(async(req,res)=>{
  relayRequests++;let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>4096){res.writeHead(413).end();return;}}
  if(relayStatus!==202){res.writeHead(relayStatus).end('SYNTHETIC_SECRET_PROVIDER_BODY');return;}
  const value=JSON.parse(body);let ref=relayReferences.get(value.idempotencyKey);
  if(!ref){ref='sandbox-'+randomUUID();relayReferences.set(value.idempotencyKey,ref);captured.push(value);}
  res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify({message_id:ref}));
 });relay.listen(0,'127.0.0.1');await once(relay,'listening');const a=relay.address();assert.ok(a&&typeof a==='object');
 emailConfig={mode:'sandbox',endpoint:'http://127.0.0.1:'+a.port+'/security-email',from:'security@example.invalid',encryptionKey:emailKey,timeoutMs:1000,retrySeconds:1,maxAttempts:3};
});
after(async()=>{if(relay){relay.closeAllConnections();await new Promise<void>(resolve=>relay.close(()=>resolve()));}});
async function resetQueue(){await admin.query('DELETE FROM patient_security_email_payloads; DELETE FROM patient_security_email_deliveries');captured.length=0;relayStatus=202;relayRequests=0;relayReferences.clear();}
async function queuedRegistration(){const email='synthetic-'+randomUUID()+'@example.invalid';const r=await request('/auth/register',{email,password,full_name:'Synthetic Email Patient'});assert.equal(r.status,201);return {email,id:r.data.patient.id};}
const code=(text:string)=>{const match=/code: ([a-f0-9-]{36}\.[a-f0-9]{64})/.exec(text);assert.ok(match);return match[1];};
async function due(){await admin.query("UPDATE patient_security_email_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='transient_failed'");}

test('1B verification dispatch crosses HTTP sandbox with purpose-specific code; API does not wait for provider',async()=>{
 await resetQueue();const delivery=createSecurityEmailDelivery(db,emailConfig);
 await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{
  const u=await queuedRegistration();assert.equal(relayRequests,0);
  assert.equal((await admin.query('SELECT state FROM patient_security_email_deliveries WHERE patient_id=$1',[u.id])).rows[0].state,'pending');
  assert.equal((await delivery.drain()).delivered,1);assert.equal(captured.length,1);const m=captured[0];assert.equal(m.to,u.email);assert.match(m.subject,/Verify/);assert.ok(!m.text.includes(password)&&!m.text.includes('refresh')&&!m.text.includes('medical'));
  assert.equal((await request('/auth/verify-email',{token:code(m.text)})).status,200);assert.equal((await request('/auth/verify-email',{token:code(m.text)})).status,400);await login(u.email);
 });
});
test('1B reset dispatch uses verified email, generic recovery response and a different purpose',async()=>{
 await resetQueue();const u=await registered(),delivery=createSecurityEmailDelivery(db,emailConfig);
 await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{
  const known=await request('/auth/forgot-password',{email:u.email}),unknown=await request('/auth/forgot-password',{email:'absent@example.invalid'});assert.deepEqual(known,unknown);assert.equal(relayRequests,0);
  assert.equal((await delivery.drain()).delivered,1);assert.equal(captured[0].to,u.email);assert.match(captured[0].subject,/Reset/);
  const token=code(captured[0].text);assert.equal((await request('/auth/verify-email',{token})).status,400);assert.equal((await request('/auth/reset-password',{token,new_password:replacement})).status,200);assert.equal((await request('/auth/reset-password',{token,new_password:replacement})).status,400);
 });
});
test('1B transient relay failure records safe metadata and retries with one stable idempotency key',async()=>{
 await resetQueue();const delivery=createSecurityEmailDelivery(db,emailConfig);
 await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{
  const u=await queuedRegistration();relayStatus=503;assert.equal((await delivery.drain()).failed,1);
  let row=(await admin.query('SELECT * FROM patient_security_email_deliveries WHERE patient_id=$1',[u.id])).rows[0];assert.equal(row.state,'transient_failed');assert.equal(row.attempts,1);assert.equal(row.failure_category,'rejected');assert.equal((await request('/auth/login',{email:u.email,password})).status,401);
  await due();relayStatus=202;assert.equal((await delivery.drain()).delivered,1);row=(await admin.query('SELECT * FROM patient_security_email_deliveries WHERE patient_id=$1',[u.id])).rows[0];assert.equal(row.attempts,2);assert.equal(row.state,'delivered');assert.match(row.provider_reference_hash,/^[a-f0-9]{64}$/);assert.equal(captured[0].idempotencyKey,row.id);
 });
});
test('1B permanent failure is terminal without retry or account activation',async()=>{
 await resetQueue();const delivery=createSecurityEmailDelivery(db,emailConfig);
 await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{
  const u=await queuedRegistration();relayStatus=400;await delivery.drain();const row=(await admin.query('SELECT * FROM patient_security_email_deliveries WHERE patient_id=$1',[u.id])).rows[0];assert.equal(row.state,'permanent_failed');assert.equal(row.attempts,1);assert.equal((await delivery.drain()).processed,0);assert.equal(relayRequests,1);assert.equal((await request('/auth/login',{email:u.email,password})).status,401);assert.equal((await admin.query('SELECT delivery_id FROM patient_security_email_payloads')).rowCount,0);
 });
});
test('1B transient retries exhaust at three and cannot become an unbounded duplicate-send loop',async()=>{
 await resetQueue();const delivery=createSecurityEmailDelivery(db,emailConfig);
 await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{await queuedRegistration();relayStatus=503;for(let n=0;n<3;n++){await due();await delivery.drain();}assert.equal(relayRequests,3);const row=(await admin.query('SELECT state,attempts FROM patient_security_email_deliveries')).rows[0];assert.equal(row.state,'permanent_failed');assert.equal(row.attempts,3);assert.equal((await delivery.drain()).processed,0);});
});
test('1B expired queued challenge is not sent and expired code never verifies',async()=>{
 await resetQueue();const u=await registered(false),delivery=createSecurityEmailDelivery(db,emailConfig);await delivery.mailer.send({to:u.email,purpose:'verify_email',token:u.challenge.token,expiresIn:86400});await admin.query("UPDATE patient_auth_challenges SET created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day' WHERE patient_id=$1",[u.id]);assert.equal((await delivery.drain()).skipped,1);assert.equal(relayRequests,0);assert.equal((await request('/auth/verify-email',{token:u.challenge.token})).status,400);assert.equal((await admin.query('SELECT state FROM patient_security_email_deliveries')).rows[0].state,'expired');
});
test('1B resend supersedes old queued mail and invalidates old code without duplicate sends',async()=>{
 await resetQueue();const delivery=createSecurityEmailDelivery(db,emailConfig);
 await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{
  const u=await queuedRegistration();const old=(await admin.query('SELECT id FROM patient_auth_challenges WHERE patient_id=$1',[u.id])).rows[0].id;
  await admin.query("UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '5 seconds' WHERE id=$1",[old]);assert.equal((await request('/auth/verification/resend',{email:u.email})).status,202);assert.equal((await request('/auth/verification/resend',{email:u.email})).status,202);assert.equal((await admin.query('SELECT count(*)::int AS n FROM patient_security_email_deliveries')).rows[0].n,2);
  const result=await delivery.drain();assert.equal(result.delivered,1);assert.equal(result.skipped,1);assert.equal(relayRequests,1);assert.notEqual(code(captured[0].text).slice(0,36),old);
 });
});
test('1B concurrent enqueue/drain and repeated sends dispatch the same challenge once',async()=>{
 await resetQueue();const u=await registered(false),delivery=createSecurityEmailDelivery(db,emailConfig),message={to:u.email,purpose:'verify_email' as const,token:u.challenge.token,expiresIn:86400};await Promise.all([delivery.mailer.send(message),delivery.mailer.send(message)]);await Promise.all([delivery.drain(),delivery.drain()]);await delivery.mailer.send(message);await delivery.drain();assert.equal(relayRequests,1);assert.equal(captured.length,1);assert.equal((await admin.query('SELECT attempts FROM patient_security_email_deliveries')).rows[0].attempts,1);
});
test('1B metadata omits secrets/email bodies; ciphertext is authenticated and removed after success',async()=>{
 await resetQueue();const u=await registered(false),delivery=createSecurityEmailDelivery(db,emailConfig);await delivery.mailer.send({to:u.email,purpose:'verify_email',token:u.challenge.token,expiresIn:86400});
 const row=(await admin.query('SELECT * FROM patient_security_email_deliveries')).rows[0],payload=(await admin.query('SELECT * FROM patient_security_email_payloads')).rows[0];assert.ok(!JSON.stringify(row).includes(u.challenge.token)&&!JSON.stringify(row).includes(u.email));assert.ok(!payload.ciphertext.toString().includes(u.challenge.token));assert.equal(payload.nonce.length,12);assert.equal(payload.tag.length,16);await delivery.drain();assert.equal((await admin.query('SELECT delivery_id FROM patient_security_email_payloads')).rowCount,0);
});
test('1B wrong encryption key fails closed without logging raw provider/token details',async()=>{
 await resetQueue();const u=await registered(false),delivery=createSecurityEmailDelivery(db,emailConfig);await delivery.mailer.send({to:u.email,purpose:'verify_email',token:u.challenge.token,expiresIn:86400});const wrong=createSecurityEmailDelivery(db,{...emailConfig,encryptionKey:randomBytes(32)});assert.equal((await wrong.drain()).skipped,1);assert.equal(relayRequests,0);const row=(await admin.query('SELECT state,failure_category FROM patient_security_email_deliveries')).rows[0];assert.equal(row.state,'permanent_failed');assert.equal(row.failure_category,'invalid_payload');
});
test('1B timeout is bounded and retries remain observable',async()=>{
 await resetQueue();const u=await registered(false),delivery=createSecurityEmailDelivery(db,{...emailConfig,timeoutMs:20},{send:async()=>new Promise(()=>{})});await delivery.mailer.send({to:u.email,purpose:'verify_email',token:u.challenge.token,expiresIn:86400});assert.equal((await delivery.drain()).failed,1);assert.equal((await admin.query('SELECT failure_category FROM patient_security_email_deliveries')).rows[0].failure_category,'timeout');
});
test('1B disabled/sandbox/production configuration fails closed without leaking config values',()=>{
 assert.equal(securityEmailConfig({}),undefined);const key=emailKey.toString('hex'),settings={AUTH_SECURITY_EMAIL_MODE:'sandbox',AUTH_SECURITY_EMAIL_ENDPOINT:'http://127.0.0.1:8026/security-email',AUTH_SECURITY_EMAIL_ENCRYPTION_KEY:key,AUTH_SECURITY_EMAIL_FROM:'security@example.invalid'};assert.ok(securityEmailConfig(settings));
 for(const endpoint of ['http://example.com','http://localhost:8026','http://user:secret@127.0.0.1:8026','http://127.0.0.1:8026?token=secret'])assert.throws(()=>securityEmailConfig({...settings,AUTH_SECURITY_EMAIL_ENDPOINT:endpoint}));
 assert.throws(()=>securityEmailConfig({...settings,AUTH_SECURITY_EMAIL_MODE:'https-relay',AUTH_SECURITY_EMAIL_ENDPOINT:'https://mail.example.invalid/send'}));
});
test('1B account/email security version changes supersede outstanding queued verification and reset',async()=>{
 await resetQueue();const u=await registered(false),delivery=createSecurityEmailDelivery(db,emailConfig);await delivery.mailer.send({to:u.email,purpose:'verify_email',token:u.challenge.token,expiresIn:86400});await admin.query('UPDATE patients SET email=$2 WHERE id=$1',[u.id,'changed-'+randomUUID()+'@example.invalid']);assert.equal((await delivery.drain()).skipped,1);assert.equal((await request('/auth/verify-email',{token:u.challenge.token})).status,400);assert.equal(relayRequests,0);
 const v=await registered();await request('/auth/forgot-password',{email:v.email});const token=mail.at(-1)!.token;await admin.query("UPDATE patients SET account_status='suspended' WHERE id=$1",[v.id]);await admin.query("UPDATE patients SET account_status='active' WHERE id=$1",[v.id]);assert.equal((await request('/auth/reset-password',{token,new_password:replacement})).status,400);
});
test('1B enqueue failure rolls back issuance and cannot enumerate recovery accounts',async()=>{
 await resetQueue();const u=await registered(),delivery=createSecurityEmailDelivery(db,emailConfig);
 await admin.query("CREATE FUNCTION public.identity_test_enqueue_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SECRET'; END $$; CREATE TRIGGER identity_test_enqueue_failure BEFORE INSERT ON patient_security_email_deliveries FOR EACH ROW EXECUTE FUNCTION public.identity_test_enqueue_failure()");
 try{await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{const a=await request('/auth/forgot-password',{email:u.email}),b=await request('/auth/forgot-password',{email:'absent@example.invalid'});assert.deepEqual(a,b);assert.equal(a.status,202);});assert.equal((await admin.query("SELECT id FROM patient_auth_challenges WHERE patient_id=$1 AND purpose='reset_password'",[u.id])).rowCount,0);assert.equal(relayRequests,0);}
 finally{await admin.query('DROP TRIGGER identity_test_enqueue_failure ON patient_security_email_deliveries; DROP FUNCTION public.identity_test_enqueue_failure()');}
});
test('1B shipped local sandbox provides memory-only review and idempotent actual HTTP delivery',async()=>{
 await resetQueue();const local=createSecurityEmailSandbox();local.listen(0,'127.0.0.1');await once(local,'listening');const a=local.address();assert.ok(a&&typeof a==='object');const endpoint='http://127.0.0.1:'+a.port;
 try{const delivery=createSecurityEmailDelivery(db,{...emailConfig,endpoint:endpoint+'/security-email'});await withAuthRouter(config,{mailer:delivery.mailer,policy},async()=>{
  const u=await queuedRegistration();assert.equal((await delivery.drain()).delivered,1);const response=await fetch(endpoint+'/messages');assert.match(response.headers.get('cache-control')??'',/no-store/);const messages=await response.json() as Array<{text:string;to:string}>;assert.equal(messages.length,1);assert.equal(messages[0].to,u.email);assert.equal((await request('/auth/verify-email',{token:code(messages[0].text)})).status,200);
 });}finally{local.closeAllConnections();await new Promise<void>(resolve=>local.close(()=>resolve()));}
});
test('1B original development checkpoint restores into an isolated database with all original rows intact',async t=>{
 if(!process.env.IDENTITY_TEST_SCHEMA_FILE){t.skip('Requires explicit development checkpoint qualification mode.');return;}
 const checkpoint=JSON.parse(await readFile(socket+'/development-checkpoint.json','utf8'));
 await admin.query('CREATE DATABASE phase1b_restore_verification');const restored=new pg.Client({...conn,database:'phase1b_restore_verification',user:userInfo().username});await restored.connect();
 try{
  await restored.query("SET TIME ZONE 'UTC'");
  const result=spawnSync('/usr/bin/pg_restore',['--no-owner','--no-privileges','--exit-on-error','--host='+socket,'--port=55481','--username='+userInfo().username,'--dbname=phase1b_restore_verification',socket+'/development-before.dump'],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,'original local backup restores into fresh private database');
  for(const [table,expected]of Object.entries(checkpoint.contents)){assert.match(table,/^[a-z_]+$/);const actual=(await restored.query(`SELECT count(*)::int AS count,encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') AS digest FROM public.${table} t`)).rows[0];assert.deepEqual(actual,expected);}
 }finally{await restored.end();}
});

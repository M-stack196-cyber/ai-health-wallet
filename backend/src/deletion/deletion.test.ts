import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import type {AuthenticationConfig} from '../config/auth.js';
import {createPatientRoutes,type SecurityMailMessage} from '../auth/routes.js';
import {createPasswordService} from '../auth/passwords.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {errorHandler} from '../http/errors.js';
import type {AdminAuthenticationConfig} from '../admin/config.js';
import {createAdminRoutes} from '../admin/routes.js';
import {createAdminAccount} from '../admin/bootstrap.js';
import {assertPhysicalDeletionAllowed,runPhysicalDeletion,PhysicalDeletionBlockedError} from './purge-gate.js';

// Plain PostgreSQL 16 in a disposable, test-owned Unix socket. Synthetic data only.
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Only the test-owned Unix socket is allowed.');
const conn={host:socket,port:55481,database:'hw_r2_deletion'};
const owner=new pg.Pool({...conn,user:userInfo().username});
const db=new pg.Pool({...conn,user:'health_wallet_app',max:10});
const patientConfig:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'r2-patient-issuer',jwtAudience:'r2-patient',
 argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:8,rateLimitWindowMs:900000,rateLimitMax:1000};
const adminConfig:AdminAuthenticationConfig={jwtKey:new Uint8Array(randomBytes(32)),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'r2-admin-issuer',
 jwtAudience:'r2-admin',rateLimitMax:500,rateWindowSeconds:900};
const passwords=createPasswordService(patientConfig);
const patientPassword='Synthetic secure passphrase 310!',adminPassword='Synthetic admin passphrase 731!',CONFIRM='DELETE_MY_ACCOUNT';
const mail:SecurityMailMessage[]=[];
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string;

before(async()=>{
 assert.equal((await stat(socket)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try {await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_r2_deletion');}finally{await bootstrap.end();}
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,22);
 for(const f of files){
  if(f.startsWith('0010'))await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
  if(f.startsWith('0005'))await owner.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const c=await owner.connect();try{await c.query('BEGIN');await c.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const patients=createPatientRoutes(db,patientConfig,{mailer:{async send(m){mail.push(m);}},policy:{...getSecurityPolicy(),challengeRateMax:10000}});
 app.use('/api/v1/auth',patients.auth);app.use('/api/v1/patients',patients.profile);app.use('/api/v1/admin',createAdminRoutes(db,patientConfig,adminConfig,{health:{services:[]}}));app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await db.end();await owner.end();});

async function call(path:string,opts:{method?:string;body?:unknown;token?:string;raw?:string}={}){
 const r=await fetch(base+path,{method:opts.method??(opts.body===undefined?'GET':'POST'),headers:{...(opts.body===undefined?{}:{'Content-Type':'application/json'}),...(opts.token?{Authorization:'Bearer '+opts.token}:{})},
  body:opts.body===undefined?undefined:JSON.stringify(opts.body),signal:AbortSignal.timeout(15000)});
 const text=await r.text();assert.ok(r.headers.get('cache-control')?.includes('no-store'));
 assert.ok(!text.includes('password_hash')&&!text.includes('$argon2')&&!text.includes(patientPassword),'response contains a sensitive value');
 return {status:r.status,data:(r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text) as any,text};
}
async function livePatient(){
 const email='r2-'+randomUUID()+'@example.invalid';
 const r=await call('/api/v1/auth/register',{body:{email,password:patientPassword,full_name:'Synthetic R2 Patient'}});assert.equal(r.status,201);
 const challenge=mail.find(m=>m.to===email&&m.purpose==='verify_email')!;assert.equal((await call('/api/v1/auth/verify-email',{body:{token:challenge.token}})).status,200);
 const login=await call('/api/v1/auth/login',{body:{email,password:patientPassword}});assert.equal(login.status,200);
 return {id:r.data.patient.id as string,email,access:login.data.access_token as string,refresh:login.data.refresh_token as string};
}
async function extraLogin(p:{email:string}){const l=await call('/api/v1/auth/login',{body:{email:p.email,password:patientPassword}});assert.equal(l.status,200);return {access:l.data.access_token as string,refresh:l.data.refresh_token as string};}
async function document(patient:string){
 const id=randomUUID();
 await owner.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,hospital_name,processing_status,content_type,size_bytes,sha256)
  VALUES($1,$2,'synthetic-private-bucket',$3,'synthetic.pdf','pdf','lab_report','Synthetic Hospital','failed','application/pdf',24,'02be06dafdca1e35e82ce33d549485f29627c07274b644fafb0e54befbe732de')`,[id,patient,'medical-documents/'+randomUUID()+'.pdf']);
 return id;
}
let digest=0;
/** A live grant covering one document, with one live doctor session. */
async function share(patient:string,doc:string){
 const grant=randomUUID(),email='doctor-'+randomUUID()+'@example.invalid',challenge=randomUUID(),hash=randomBytes(32).toString('hex');
 const version=(await owner.query('SELECT security_version FROM public.patients WHERE id=$1',[patient])).rows[0].security_version;
 await owner.query(`INSERT INTO public.doctor_sharing_grants(id,patient_id,doctor_email,sharing_method,token_digest,expires_at,recipient_bound,patient_security_version)
  VALUES($1,$2,$3,'unique_link',$4,clock_timestamp()+interval '1 hour',true,$5)`,[grant,patient,email,Buffer.concat([Buffer.alloc(31,0xe2),Buffer.from([++digest])]),version]);
 await owner.query('INSERT INTO public.sharing_grant_documents(grant_id,document_id,patient_id) VALUES($1,$2,$3)',[grant,doc,patient]);
 await owner.query(`INSERT INTO public.doctor_otp_challenges(id,grant_id,patient_id,doctor_email,otp_verifier,verifier_key_version,expires_at)
  VALUES($1,$2,$3,$4,$5,'v1',clock_timestamp()+interval '1 hour')`,[challenge,grant,patient,email,Buffer.alloc(32,7)]);
 await owner.query(`INSERT INTO public.doctor_share_sessions(id,grant_id,patient_id,doctor_email,doctor_name,challenge_id,token_hash,grant_version,patient_security_version,expires_at)
  VALUES($1,$2,$3,$4,'Synthetic Doctor',$5,$6,1,$7,clock_timestamp()+interval '1 hour')`,[randomUUID(),grant,patient,email,challenge,hash,version]);
 return {grant,hash};
}
const doctorSees=async(hash:string,doc:string)=>(await db.query('SELECT public.doctor_document_current($1,$2) AS ok',[hash,doc])).rows[0].ok as boolean;
const request=(token:string|undefined,body:unknown=({current_password:patientPassword,confirmation:CONFIRM}))=>call('/api/v1/patients/me/deletion-request',{body,token});
const row=async(id:string)=>(await owner.query('SELECT * FROM public.patients WHERE id=$1',[id])).rows[0];
const requests=async(id:string)=>(await owner.query('SELECT * FROM public.patient_deletion_requests WHERE patient_id=$1',[id])).rows;
const sqlState=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===code;
async function adminToken(){
 const email='r2-admin-'+randomUUID()+'@example.invalid';
 await createAdminAccount(owner,p=>passwords.hash(p),{email,fullName:'Synthetic Admin',role:'config_admin',password:adminPassword});
 const r=await call('/api/v1/admin/auth/login',{body:{email,password:adminPassword}});assert.equal(r.status,200);return r.data.access_token as string;
}

test('R2-01 the request needs a current session, the current password, the exact confirmation and no extra fields',async()=>{
 const p=await livePatient();
 assert.equal((await request(undefined)).status,401);
 assert.equal((await request('a.b.c')).status,401);
 assert.equal((await call('/api/v1/patients/me/deletion-request?x=1',{body:{current_password:patientPassword,confirmation:CONFIRM},token:p.access})).status,400);
 assert.equal((await request(p.access,{current_password:patientPassword,confirmation:CONFIRM,patient_id:randomUUID()})).status,400);
 assert.equal((await request(p.access,{current_password:patientPassword})).status,400);
 assert.equal((await request(p.access,{current_password:patientPassword,confirmation:'yes'})).status,400);
 assert.equal((await request(p.access,{current_password:'Wrong passphrase 999!',confirmation:CONFIRM})).status,401);
 assert.equal((await row(p.id)).account_status,'active');assert.equal((await requests(p.id)).length,0);
 assert.equal((await call('/api/v1/patients/me',{token:p.access})).status,200,'a refused request leaves the session working');
});

test('R2-02 a successful request ends every old session, refresh token, login, reset link and share, and records policy_pending',async()=>{
 const p=await livePatient(),second=await extraLogin(p),doc=await document(p.id),s=await share(p.id,doc);
 assert.equal(await doctorSees(s.hash,doc),true);
 await call('/api/v1/auth/forgot-password',{body:{email:p.email}});const reset=mail.find(m=>m.to===p.email&&m.purpose==='reset_password');assert.ok(reset);
 const before=(await row(p.id)).security_version;
 const r=await request(p.access);
 assert.equal(r.status,202);assert.equal(r.data.success,true);assert.equal(r.data.access_revoked,true);assert.equal(r.data.physical_deletion,'not_performed');
 assert.equal(r.data.deletion_request.state,'policy_pending');assert.deepEqual(Object.keys(r.data.deletion_request).sort(),['id','requested_at','state']);
 assert.ok(!r.text.includes(p.email)&&!r.text.includes(p.id),'the response carries no personal details');
 const after=await row(p.id);assert.equal(after.account_status,'deletion_pending');assert.ok(BigInt(after.security_version)>BigInt(before));
 for(const token of [p.access,second.access])assert.equal((await call('/api/v1/patients/me',{token})).status,401);
 for(const refresh_token of [p.refresh,second.refresh])assert.equal((await call('/api/v1/auth/refresh',{body:{refresh_token}})).status,401);
 assert.equal((await call('/api/v1/auth/login',{body:{email:p.email,password:patientPassword}})).status,401);
 assert.equal((await call('/api/v1/auth/reset-password',{body:{token:reset.token,new_password:'Another synthetic passphrase 42!'}})).status,400);
 assert.equal((await call('/api/v1/auth/forgot-password',{body:{email:p.email}})).status,202);
 assert.equal((await owner.query('SELECT count(*)::int n FROM public.patient_auth_sessions WHERE patient_id=$1 AND revoked_at IS NULL',[p.id])).rows[0].n,0);
 const g=(await owner.query('SELECT revoked_at FROM public.doctor_sharing_grants WHERE id=$1',[s.grant])).rows[0];assert.ok(g.revoked_at);
 assert.equal((await owner.query('SELECT count(*)::int n FROM public.doctor_share_sessions WHERE patient_id=$1 AND revoked_at IS NULL',[p.id])).rows[0].n,0);
 assert.equal(await doctorSees(s.hash,doc),false);
 assert.equal((await owner.query("SELECT count(*)::int n FROM public.doctor_share_events WHERE grant_id=$1 AND event='revoked'",[s.grant])).rows[0].n,1);
 const [req]=await requests(p.id);assert.equal(req.state,'policy_pending');assert.equal(req.sessions_revoked,2);assert.equal(req.grants_revoked,1);assert.equal(req.doctor_sessions_revoked,1);
 const events=(await owner.query('SELECT event FROM public.patient_deletion_audit WHERE request_id=$1 ORDER BY occurred_at,event',[req.id])).rows.map(e=>e.event).sort();
 assert.deepEqual(events,['access_revoked','requested']);
});

test('R2-03 nothing is physically deleted: records stay in place but are no longer accessible',async()=>{
 const p=await livePatient(),doc=await document(p.id);
 assert.equal((await db.query('SELECT public.document_accessible($1,$2) AS ok',[doc,p.id])).rows[0].ok,true);
 const counts=async()=>(await owner.query(`SELECT (SELECT count(*) FROM public.medical_documents WHERE patient_id=$1)::int docs,(SELECT count(*) FROM public.patients WHERE id=$1)::int pats`,[p.id])).rows[0];
 const before=await counts();assert.equal((await request(p.access)).status,202);
 assert.deepEqual(await counts(),before);assert.equal((await owner.query('SELECT access_state,deleted_at FROM public.medical_documents WHERE id=$1',[doc])).rows[0].deleted_at,null);
 assert.equal((await db.query('SELECT public.document_accessible($1,$2) AS ok',[doc,p.id])).rows[0].ok,false);
 for(const sql of ['DELETE FROM public.patients WHERE id=$1','DELETE FROM public.patient_deletion_requests WHERE patient_id=$1','UPDATE public.patient_deletion_requests SET state=\'blocked_legal_hold\' WHERE patient_id=$1'])
  await assert.rejects(db.query(sql,[p.id]),(e:unknown)=>sqlState('42501')(e)||sqlState('23503')(e));
});

test('R2-04 a second request cannot be made, and a parallel pair produces exactly one request',async()=>{
 const p=await livePatient(),second=await extraLogin(p);
 const results=await Promise.all([request(p.access),request(second.access)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[202,401]);assert.equal((await requests(p.id)).length,1);
 assert.equal((await request(p.access)).status,401);assert.equal((await requests(p.id)).length,1);
 assert.equal((await owner.query('SELECT count(*)::int n FROM public.patient_deletion_audit WHERE patient_id=$1',[p.id])).rows[0].n,2);
});

test('R2-05 an active legal hold blocks deletion (deletion_restricted) while access is still ended; a released hold does not',async()=>{
 const held=await livePatient(),doc=await document(held.id),s=await share(held.id,doc);
 await owner.query("INSERT INTO public.patient_legal_holds(patient_id,reason_code) VALUES($1,'legal_obligation')",[held.id]);
 const r=await request(held.access);
 assert.equal(r.status,202);assert.equal(r.data.deletion_request.state,'blocked_legal_hold');assert.equal(r.data.physical_deletion,'not_performed');
 assert.equal((await row(held.id)).account_status,'deletion_restricted');
 assert.equal((await call('/api/v1/patients/me',{token:held.access})).status,401);
 assert.equal((await call('/api/v1/auth/login',{body:{email:held.email,password:patientPassword}})).status,401);
 assert.equal(await doctorSees(s.hash,doc),false);
 const [req]=await requests(held.id);
 assert.deepEqual((await owner.query('SELECT event FROM public.patient_deletion_audit WHERE request_id=$1',[req.id])).rows.map(e=>e.event).sort(),['access_revoked','legal_hold_blocked','requested']);
 const released=await livePatient();
 await owner.query("INSERT INTO public.patient_legal_holds(patient_id,reason_code,released_at) VALUES($1,'legal_obligation',clock_timestamp())",[released.id]);
 const r2=await request(released.access);assert.equal(r2.status,202);assert.equal(r2.data.deletion_request.state,'policy_pending');
 assert.equal((await row(released.id)).account_status,'deletion_pending');
 await assert.rejects(db.query("INSERT INTO public.patient_legal_holds(patient_id,reason_code) VALUES($1,'legal_obligation')",[released.id]),sqlState('42501'));
 await assert.rejects(db.query('UPDATE public.patient_legal_holds SET released_at=clock_timestamp()'),sqlState('42501'));
 await assert.rejects(owner.query("INSERT INTO public.patient_legal_holds(patient_id,reason_code) VALUES($1,'Bad Code!')",[released.id]),sqlState('23514'));
});

test('R2-06 another patient is not affected by a deletion request',async()=>{
 const a=await livePatient(),b=await livePatient(),docB=await document(b.id),sB=await share(b.id,docB);
 assert.equal((await request(a.access)).status,202);
 assert.equal((await call('/api/v1/patients/me',{token:b.access})).status,200);
 assert.equal((await row(b.id)).account_status,'active');assert.equal(await doctorSees(sB.hash,docB),true);
 assert.equal((await owner.query('SELECT revoked_at FROM public.doctor_sharing_grants WHERE id=$1',[sB.grant])).rows[0].revoked_at,null);
 assert.equal((await requests(b.id)).length,0);
 assert.equal((await db.query('SELECT public.document_accessible($1,$2) AS ok',[docB,b.id])).rows[0].ok,true);
});

test('R2-07 a suspended or unverified account cannot start a request',async()=>{
 const p=await livePatient();await owner.query("UPDATE public.patients SET account_status='suspended' WHERE id=$1",[p.id]);
 assert.equal((await request(p.access)).status,401);assert.equal((await requests(p.id)).length,0);assert.equal((await row(p.id)).account_status,'suspended');
});

test('R2-08 neither an admin nor the database can bring a deletion-pending account back',async()=>{
 const p=await livePatient();assert.equal((await request(p.access)).status,202);
 const token=await adminToken();
 for(const action of ['reactivate','suspend']){
  const r=await call('/api/v1/admin/patients/'+p.id+'/'+action,{method:'POST',token});assert.equal(r.status,409);assert.equal(r.data.error.code,'ACCOUNT_STATE_CONFLICT');
 }
 assert.equal((await row(p.id)).account_status,'deletion_pending');
 for(const status of ['active','suspended','unverified'])
  await assert.rejects(owner.query('UPDATE public.patients SET account_status=$2 WHERE id=$1',[p.id,status]),sqlState('23514'));
 assert.equal((await row(p.id)).account_status,'deletion_pending');
 await owner.query("UPDATE public.patients SET account_status='deletion_restricted' WHERE id=$1",[p.id]);
 assert.equal((await row(p.id)).account_status,'deletion_restricted');
 const detail=await call('/api/v1/admin/patients/'+p.id,{token});assert.equal(detail.status,200);assert.equal(detail.data.patient.account_status,'deletion_restricted');
});

test('R2-09 an admin token cannot call the patient deletion route, and a patient token cannot call admin routes',async()=>{
 const p=await livePatient(),token=await adminToken();
 assert.equal((await request(token)).status,401);assert.equal((await row(p.id)).account_status,'active');
 assert.equal((await call('/api/v1/admin/patients/'+p.id+'/suspend',{method:'POST',token:p.access})).status,401);
});

test('R2-10 the migration is additive, uses public names and grants the application role only what it needs',async()=>{
 const sql=await readFile(new URL('../../migrations/0020_account_deletion_request.sql',import.meta.url),'utf8');
 assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(sql),'the migration deletes nothing');
 assert.ok(/clock_timestamp\(\)/.test(sql));
 const priv=async(table:string)=>(await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='health_wallet_app' AND table_name=$1 ORDER BY 1`,[table])).rows.map(r=>r.privilege_type);
 assert.deepEqual(await priv('patient_legal_holds'),['SELECT']);
 assert.deepEqual(await priv('patient_deletion_requests'),['INSERT','SELECT']);
 assert.deepEqual(await priv('patient_deletion_audit'),['INSERT','SELECT']);
});

test('R2-11 the database refuses physical deletion while the policy is pending, for the application role and the owner role',async()=>{
 for(const pool of [db,owner])await assert.rejects(pool.query('SELECT public.assert_physical_deletion_allowed()'),sqlState('55000'));
 const policy=(await owner.query('SELECT status,approved,retention_days_placeholder,retention_label FROM public.deletion_policy')).rows;
 assert.deepEqual(policy,[{status:'policy_pending',approved:false,retention_days_placeholder:30,retention_label:'placeholder_not_approved'}]);
});

test('R2-12 nobody can approve the policy through the application: no write rights, and the table itself forbids an approved state',async()=>{
 for(const sql of ["UPDATE public.deletion_policy SET approved=true","UPDATE public.deletion_policy SET retention_days_placeholder=1","DELETE FROM public.deletion_policy","INSERT INTO public.deletion_policy(singleton) VALUES(false)"])
  await assert.rejects(db.query(sql),sqlState('42501'));
 for(const sql of ["UPDATE public.deletion_policy SET approved=true","UPDATE public.deletion_policy SET status='approved'","UPDATE public.deletion_policy SET retention_label='approved'","UPDATE public.deletion_policy SET retention_days_placeholder=0"])
  await assert.rejects(owner.query(sql),sqlState('23514'));
 await assert.rejects(owner.query('INSERT INTO public.deletion_policy DEFAULT VALUES'),sqlState('23505'));
 assert.equal((await owner.query('SELECT count(*)::int n FROM public.deletion_policy')).rows[0].n,1);
});

test('R2-13 the physical-deletion code path cannot run while the policy is pending, and it fails closed',async()=>{
 let ran=0;const action=async()=>{ran++;return 'deleted';};
 await assert.rejects(runPhysicalDeletion(db,action),PhysicalDeletionBlockedError);
 await assert.rejects(assertPhysicalDeletionAllowed(db),PhysicalDeletionBlockedError);
 // Fail closed: a broken or unreachable database also blocks, with no raw driver error leaking out.
 const broken={async query():Promise<never>{throw Object.assign(Error('connect ECONNREFUSED secret-host'),{code:'ECONNREFUSED'});}};
 await assert.rejects(runPhysicalDeletion(broken,action),(e:unknown)=>e instanceof PhysicalDeletionBlockedError&&!String((e as Error).message).includes('secret-host'));
 assert.equal(ran,0,'the deletion action must never start while the policy is pending');
 // The TypeScript side has no approval of its own: it only runs the action when the database function itself returns without error.
 const approvedLater={async query(){return {rows:[]};}};
 assert.equal(await runPhysicalDeletion(approvedLater as never,action),'deleted');assert.equal(ran,1);
});

test('R2-14 a deletion request leaves the gate closed and no source code deletes patient records',async()=>{
 const p=await livePatient();assert.equal((await request(p.access)).status,202);
 await assert.rejects(runPhysicalDeletion(db,async()=>{throw Error('must not run');}),PhysicalDeletionBlockedError);
 assert.equal((await owner.query('SELECT state FROM public.patient_deletion_requests WHERE patient_id=$1',[p.id])).rows[0].state,'policy_pending');
 const gate=await readFile(new URL('./purge-gate.ts',import.meta.url),'utf8');
 assert.ok(!/\b(DELETE\s+FROM|DROP\s+TABLE|TRUNCATE|\.remove\()/i.test(gate),'the gate itself deletes nothing');
 const walk=async(dir:URL):Promise<string[]>=>{const out:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){const u=new URL(e.name+(e.isDirectory()?'/':''),dir);if(e.isDirectory())out.push(...await walk(u));else if(e.name.endsWith('.ts')&&!/\.test\.ts$/.test(e.name)&&!/check|canary/.test(e.name))out.push(u.pathname);}return out;};
 const offenders:string[]=[];
 for(const f of await walk(new URL('../',import.meta.url)))if(/DELETE\s+FROM\s+public\.(patients|medical_|document|extract|summar|report|rag_|guardian_|patient_deletion)/i.test(await readFile(f,'utf8')))offenders.push(f);
 assert.deepEqual(offenders,[]);
});

test('R2-15 a deletion request ends guardian links and cancels waiting guardian jobs; another patient guardian is untouched',async()=>{
 const p=await livePatient(),other=await livePatient();
 const hex=()=>randomBytes(32).toString('hex');
 const seed=async(patient:string,status:'ACTIVE'|'PENDING')=>{
  const c=await owner.connect();
  try {
   await c.query("SET session_replication_role = replica"); // seed fixtures only; the app code under test runs with all triggers on
   const id=randomUUID(),challenge=randomUUID();
   if(status==='ACTIVE')await c.query("INSERT INTO public.patient_auth_challenges(id,patient_id,purpose,token_hash,expires_at,consumed_at) VALUES($1,$2,'guardian_invitation',$3,clock_timestamp()+interval '1 day',clock_timestamp())",[challenge,patient,hex()]);
   await c.query("INSERT INTO public.guardian_relationships(id,patient_id,email,status,invitation_id,accepted_at) VALUES($1,$2,$3,$4,$5,$6)",
    [id,patient,'guardian-'+id+'@example.invalid',status,status==='ACTIVE'?challenge:null,status==='ACTIVE'?new Date():null]);
   await c.query("INSERT INTO public.guardian_medical_jobs(id,patient_id,relationship_id,recipient_hash,patient_security_version,kind,policy_sha256,not_before,max_attempts) VALUES($1,$2,$3,$4,1,'serious_alert',$5,clock_timestamp()+interval '1 hour',3)",[randomUUID(),patient,id,hex(),hex()]);
   return id;
  } finally {await c.query("SET session_replication_role = DEFAULT");c.release();}
 };
 const g=await seed(p.id,'ACTIVE'),og=await seed(other.id,'ACTIVE');
 const r=await request(p.access);assert.equal(r.status,202);
 const link=async(id:string)=>(await owner.query('SELECT status,revoked_at FROM public.guardian_relationships WHERE id=$1',[id])).rows[0];
 assert.equal((await link(g)).status,'REVOKED');assert.notEqual((await link(g)).revoked_at,null);
 assert.equal((await link(og)).status,'ACTIVE');
 assert.equal((await owner.query("SELECT state FROM public.guardian_medical_jobs WHERE relationship_id=$1",[g])).rows[0].state,'cancelled');
 assert.equal((await owner.query("SELECT state FROM public.guardian_medical_jobs WHERE relationship_id=$1",[og])).rows[0].state,'pending');
 assert.equal((await owner.query("SELECT count(*)::int n FROM public.guardian_lifecycle_events WHERE relationship_id=$1 AND event='revoked'",[g])).rows[0].n,1);
 assert.equal((await owner.query('SELECT guardian_links_revoked FROM public.patient_deletion_requests WHERE patient_id=$1',[p.id])).rows[0].guardian_links_revoked,1);
 assert.equal((await owner.query('SELECT count(*)::int n FROM public.guardian_communication_eligibility WHERE patient_id=$1',[p.id])).rows[0].n,0);
 assert.equal((await owner.query('SELECT count(*)::int n FROM public.guardian_relationships WHERE id=$1',[g])).rows[0].n,1);
});

test('R2-16 migration 0022 is additive, keeps the policy table read-only for the application role and records the 30-day value as a placeholder',async()=>{
 const sql=await readFile(new URL('../../migrations/0022_deletion_policy_gate.sql',import.meta.url),'utf8');
 assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(sql),'the migration deletes nothing');
 assert.ok(/clock_timestamp\(\)/.test(sql)&&/public\.deletion_policy/.test(sql)&&/placeholder/i.test(sql));
 const priv=(await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='health_wallet_app' AND table_name='deletion_policy' ORDER BY 1`)).rows.map(r=>r.privilege_type);
 assert.deepEqual(priv,['SELECT']);
 const exec=(await owner.query(`SELECT has_function_privilege('health_wallet_app','public.assert_physical_deletion_allowed()','EXECUTE') a,has_function_privilege('public','public.assert_physical_deletion_allowed()','EXECUTE') b`)).rows[0];
 assert.deepEqual(exec,{a:true,b:false});
});

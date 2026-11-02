import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import {SignJWT} from 'jose';
import type {AuthenticationConfig} from '../config/auth.js';
import {createPatientRoutes,type SecurityMailMessage} from '../auth/routes.js';
import {createPasswordService} from '../auth/passwords.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {errorHandler} from '../http/errors.js';
import {getAdminAuthenticationConfig,AdminConfigurationError,type AdminAuthenticationConfig} from '../admin/config.js';
import {createAdminRoutes} from '../admin/routes.js';
import {createAdminTokenService} from '../admin/tokens.js';
import {AdminBootstrapError,createAdminAccount} from '../admin/bootstrap.js';
import {writeAdminAudit} from '../admin/repository.js';

// Plain PostgreSQL 16 only: M13 Phase 1 needs no pgvector, so migrations 0010-0012 (pgvector/RAG/sharing/guardian) are not applied.
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Only the test-owned Unix socket is allowed.');
const conn={host:socket,port:55481,database:'hw_admin_phase9'};
const owner=new pg.Pool({...conn,user:userInfo().username});
const db=new pg.Pool({...conn,user:'health_wallet_app',max:14});
const patientConfig:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'phase9-patient-issuer',jwtAudience:'phase9-patient',
 argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:8,rateLimitWindowMs:900000,rateLimitMax:1000};
const adminConfig:AdminAuthenticationConfig={jwtKey:new Uint8Array(randomBytes(32)),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'phase9-admin-issuer',
 jwtAudience:'phase9-admin',rateLimitMax:50,rateWindowSeconds:900};
// A separate key gives this server its own rate-limit buckets, so other tests sharing 127.0.0.1 cannot exhaust them.
const strictConfig:AdminAuthenticationConfig={...adminConfig,jwtKey:new Uint8Array(randomBytes(32)),rateLimitMax:3};
const passwords=createPasswordService(patientConfig),tokens=createAdminTokenService(adminConfig);
const adminPassword='Synthetic admin passphrase 731!',patientPassword='Synthetic secure passphrase 310!';
const mail:SecurityMailMessage[]=[];
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string,strictServer:ReturnType<ReturnType<typeof express>['listen']>,strictBase:string;

before(async()=>{
 assert.equal((await stat(socket)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try {await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_admin_phase9');}finally{await bootstrap.end();}
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,14);
 for(const f of files.filter(name=>!/^001[0-2]_/.test(name))){
  if(f.startsWith('0005'))await owner.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const c=await owner.connect();try{await c.query('BEGIN');await c.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 const mount=(config:AdminAuthenticationConfig)=>{
  const app=express();app.use(express.json());app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const patients=createPatientRoutes(db,patientConfig,{mailer:{async send(m){mail.push(m);}},policy:{...getSecurityPolicy(),challengeRateMax:10000}});
  app.use('/api/v1/auth',patients.auth);app.use('/api/v1/patients',patients.profile);app.use('/api/v1/admin',createAdminRoutes(db,patientConfig,config));app.use(errorHandler);return app;
 };
 server=mount(adminConfig).listen(0,'127.0.0.1');await once(server,'listening');
 strictServer=mount(strictConfig).listen(0,'127.0.0.1');await once(strictServer,'listening');
 for(const [s,set] of [[server,(b:string)=>{base=b;}],[strictServer,(b:string)=>{strictBase=b;}]] as const){const a=s.address();assert.ok(a&&typeof a==='object');set('http://127.0.0.1:'+a.port);}
});
after(async()=>{for(const s of [server,strictServer])if(s){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));}await db.end();await owner.end();});

async function call(path:string,opts:{method?:string;body?:unknown;token?:string;headers?:Record<string,string>;root?:string}={}){
 const r=await fetch((opts.root??base)+path,{method:opts.method??(opts.body===undefined?'GET':'POST'),headers:{...(opts.body===undefined?{}:{'Content-Type':'application/json'}),
  ...(opts.token?{Authorization:'Bearer '+opts.token}:{}),...opts.headers},body:opts.body===undefined?undefined:JSON.stringify(opts.body),signal:AbortSignal.timeout(15000)});
 const text=await r.text();assert.ok(r.headers.get('cache-control')?.includes('no-store'));
 assert.ok(!text.includes('password_hash')&&!text.includes('$argon2')&&!text.includes(adminPassword)&&!text.includes(patientPassword),'response contains a sensitive value');
 return {status:r.status,data:(r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text) as any};
}
async function newAdmin(role='support_admin'){
 const email='admin-'+randomUUID()+'@example.invalid';
 const created=await createAdminAccount(owner,p=>passwords.hash(p),{email,fullName:'Synthetic Admin',role,password:adminPassword});
 return {id:created.id,email,role};
}
async function adminLogin(email:string,password=adminPassword,root?:string){return call('/api/v1/admin/auth/login',{body:{email,password},root});}
async function adminToken(email:string){const r=await adminLogin(email);assert.equal(r.status,200);return r.data.access_token as string;}
async function audit(where:string,values:unknown[]=[]){return (await owner.query('SELECT * FROM public.admin_audit_events WHERE '+where+' ORDER BY seq',values)).rows;}
async function auditCount(){return Number((await owner.query('SELECT count(*) FROM public.admin_audit_events')).rows[0].count);}
async function forge(key:Uint8Array,audience:string,sub:string,sid:string|undefined,adjust:{iss?:string;iat?:number;exp?:number}={}){
 const now=Math.floor(Date.now()/1000);
 return new SignJWT(sid?{sid}:{}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(sub).setIssuer(adjust.iss??adminConfig.jwtIssuer).setAudience(audience)
  .setIssuedAt(adjust.iat??now).setExpirationTime(adjust.exp??now+600).sign(key);
}
const sqlState=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===code;

test('P9-01 admin configuration is disabled by default and cannot share patient secrets or audience',()=>{
 const secret=randomBytes(32).toString('hex'),patientSecret=randomBytes(32).toString('hex');
 assert.equal(getAdminAuthenticationConfig({}),undefined);assert.equal(getAdminAuthenticationConfig({ADMIN_JWT_SECRET:''}),undefined);
 const ok=getAdminAuthenticationConfig({ADMIN_JWT_SECRET:secret,JWT_SECRET:patientSecret});assert.ok(ok);assert.equal(ok.jwtAudience,'ai-health-wallet-admin');assert.equal(ok.jwtLifetimeSeconds,900);
 for(const env of [{ADMIN_JWT_SECRET:patientSecret,JWT_SECRET:patientSecret},{ADMIN_JWT_SECRET:patientSecret.toUpperCase(),JWT_SECRET:patientSecret},{ADMIN_JWT_SECRET:'abc'},{ADMIN_JWT_SECRET:'0'.repeat(64)},
  {ADMIN_JWT_SECRET:secret,ADMIN_JWT_AUDIENCE:'ai-health-wallet-patient'},{ADMIN_JWT_SECRET:secret,JWT_AUDIENCE:'same',ADMIN_JWT_AUDIENCE:'same'},
  {ADMIN_JWT_SECRET:secret,ADMIN_JWT_EXPIRES_IN_SECONDS:'86400'},{ADMIN_JWT_SECRET:secret,ADMIN_AUTH_RATE_LIMIT_MAX:'0'}])
  assert.throws(()=>getAdminAuthenticationConfig(env),AdminConfigurationError);
});

test('P9-02 roles, permissions and privileges: the API role cannot create or alter admin identity',async()=>{
 assert.deepEqual((await owner.query('SELECT name FROM public.admin_roles ORDER BY name')).rows.map(r=>r.name),['config_admin','operations_admin','support_admin']);
 assert.deepEqual((await owner.query("SELECT DISTINCT permission FROM public.admin_role_permissions")).rows.map(r=>r.permission),['admin.profile.read']);
 const a=await newAdmin();
 for(const sql of ["INSERT INTO public.admin_accounts(email,password_hash,full_name,role_name) VALUES('x@example.invalid','$argon2id$x','X','support_admin')",
  "UPDATE public.admin_accounts SET role_name='config_admin'","DELETE FROM public.admin_accounts","INSERT INTO public.admin_roles(name) VALUES('root')",
  "INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('support_admin','admin.profile.write')","UPDATE public.admin_role_permissions SET permission='admin.profile.read'","DELETE FROM public.admin_roles"])
  await assert.rejects(db.query(sql),sqlState('42501'));
 assert.equal((await db.query('SELECT id FROM public.admin_accounts WHERE id=$1',[a.id])).rows.length,1);
 await assert.rejects(owner.query("INSERT INTO public.admin_accounts(email,password_hash,full_name,role_name) VALUES('Upper@Example.invalid','$argon2id$x','X','support_admin')"),sqlState('23514'));
 await assert.rejects(owner.query("INSERT INTO public.admin_accounts(email,password_hash,full_name,role_name) VALUES('plain@example.invalid','plaintext','X','support_admin')"),sqlState('23514'));
 await assert.rejects(owner.query("INSERT INTO public.admin_accounts(email,password_hash,full_name,role_name) VALUES('nobody@example.invalid','$argon2id$x','X','owner')"),sqlState('23503'));
 const before=(await owner.query('SELECT security_version FROM public.admin_accounts WHERE id=$1',[a.id])).rows[0].security_version;
 await owner.query("UPDATE public.admin_accounts SET full_name='Renamed Admin' WHERE id=$1",[a.id]);
 assert.equal((await owner.query('SELECT security_version FROM public.admin_accounts WHERE id=$1',[a.id])).rows[0].security_version,before);
 await owner.query("UPDATE public.admin_accounts SET role_name='operations_admin' WHERE id=$1",[a.id]);
 assert.equal(BigInt((await owner.query('SELECT security_version FROM public.admin_accounts WHERE id=$1',[a.id])).rows[0].security_version),BigInt(before)+1n);
});

test('P9-03 bootstrap creates a hashed admin with an audit event and rejects unsafe input',async()=>{
 const email='bootstrap-'+randomUUID()+'@example.invalid',hash=(p:string)=>passwords.hash(p);
 const created=await createAdminAccount(owner,hash,{email:' '+email.toUpperCase()+' ',fullName:' Synthetic Admin ',role:'config_admin',password:adminPassword});
 assert.equal(created.email,email);
 const row=(await owner.query('SELECT * FROM public.admin_accounts WHERE id=$1',[created.id])).rows[0];
 assert.match(row.password_hash,/^\$argon2id\$/);assert.ok(!row.password_hash.includes(adminPassword));assert.equal(row.status,'active');assert.equal(row.full_name,'Synthetic Admin');
 const events=await audit("action='admin.account.create' AND target_id=$1",[created.id]);
 assert.equal(events.length,1);assert.equal(events[0].outcome,'success');assert.equal(events[0].actor_admin_id,null);assert.deepEqual(events[0].scope,{method:'bootstrap',role:'config_admin'});
 assert.ok(!JSON.stringify(events).includes(adminPassword)&&!JSON.stringify(events).includes('argon2'));
 await assert.rejects(createAdminAccount(owner,hash,{email,fullName:'Duplicate',role:'support_admin',password:adminPassword}),AdminBootstrapError);
 const attempts=[{email:'not-an-email',role:'support_admin',password:adminPassword},{email:'a-'+randomUUID()+'@example.invalid',role:'support_admin',password:'short'},
  {email:'b-'+randomUUID()+'@example.invalid',role:'superuser',password:adminPassword},{email:'c-'+randomUUID()+'@example.invalid',role:undefined,password:adminPassword},
  {email:'d-'+randomUUID()+'@example.invalid',role:'support_admin',password:adminPassword,fullName:''},{email:'e-'+randomUUID()+'@example.invalid',role:'support_admin',password:adminPassword,fullName:'x'.repeat(121)}];
 for(const attempt of attempts)await assert.rejects(createAdminAccount(owner,hash,{fullName:'Synthetic Admin',...attempt}),AdminBootstrapError);
 await assert.rejects(createAdminAccount(db,hash,{email:'api-'+randomUUID()+'@example.invalid',fullName:'API Admin',role:'support_admin',password:adminPassword}),sqlState('42501'));
});

test('P9-04 admin login issues an admin-audience session token and audits success and known-account failures',async()=>{
 const a=await newAdmin();
 const ok=await adminLogin(a.email);assert.equal(ok.status,200);assert.equal(ok.data.token_type,'Bearer');assert.equal(ok.data.expires_in,900);assert.ok(!('refresh_token' in ok.data));
 const claims=JSON.parse(Buffer.from(ok.data.access_token.split('.')[1],'base64url').toString());
 assert.equal(claims.sub,a.id);assert.equal(claims.aud,adminConfig.jwtAudience);assert.equal(claims.iss,adminConfig.jwtIssuer);assert.match(claims.sid,/^[0-9a-f-]{36}$/);assert.ok(claims.exp-claims.iat<=900);
 const session=(await owner.query('SELECT * FROM public.admin_sessions WHERE id=$1',[claims.sid])).rows[0];assert.equal(session.admin_id,a.id);assert.equal(session.revoked_at,null);assert.ok(session.expires_at>session.created_at);
 const success=await audit("action='admin.auth.login' AND outcome='success' AND actor_admin_id=$1",[a.id]);assert.equal(success.length,1);assert.equal(success[0].target_id,claims.sid);assert.equal(success[0].actor_role,'support_admin');
 const wrong=await adminLogin(a.email,'Wrong synthetic passphrase 000!'),unknown=await adminLogin('nobody-'+randomUUID()+'@example.invalid');
 assert.equal(wrong.status,401);assert.deepEqual(wrong.data,unknown.data);assert.equal(wrong.data.error.code,'INVALID_CREDENTIALS');
 assert.equal((await audit("action='admin.auth.login' AND outcome='denied' AND actor_admin_id=$1",[a.id])).length,1);
 const before=await auditCount();await adminLogin('ghost-'+randomUUID()+'@example.invalid');assert.equal(await auditCount(),before,'unknown accounts do not grow the audit log');
 await owner.query("UPDATE public.admin_accounts SET status='disabled' WHERE id=$1",[a.id]);
 const disabled=await adminLogin(a.email);assert.equal(disabled.status,401);assert.deepEqual(disabled.data,wrong.data);
 for(const body of [{email:a.email,password:adminPassword,role:'config_admin'},{email:a.email},{password:adminPassword},'text',[]])assert.equal((await call('/api/v1/admin/auth/login',{body})).status,400);
 assert.equal((await call('/api/v1/admin/auth/login?x=1',{body:{email:a.email,password:adminPassword}})).status,400);
 assert.equal((await call('/api/v1/admin/auth/login',{method:'POST',headers:{'Content-Type':'text/plain'}})).status,415);
});

test('P9-05 GET /admin/me returns only the caller profile and stores an audit event first',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),before=await auditCount();
 const r=await call('/api/v1/admin/me',{token});
 assert.equal(r.status,200);assert.deepEqual(r.data,{success:true,admin:{id:a.id,email:a.email,full_name:'Synthetic Admin',role:'operations_admin',permissions:['admin.profile.read']}});
 assert.equal(await auditCount(),before+1);
 const [event]=await audit("action='admin.profile.read' AND actor_admin_id=$1",[a.id]);
 assert.equal(event.outcome,'success');assert.equal(event.actor_role,'operations_admin');assert.equal(event.target_type,'admin_account');assert.equal(event.target_id,a.id);assert.match(event.request_id,/^[0-9a-f-]{36}$/);assert.match(event.event_hash,/^[a-f0-9]{64}$/);
 for(const [path,opts] of [['/api/v1/admin/me?id='+randomUUID(),{token}],['/api/v1/admin/me',{token,method:'POST',body:{}}]] as const)assert.ok([400,404].includes((await call(path,opts)).status));
 assert.equal((await call('/api/v1/admin/me',{token,method:'GET',headers:{'Content-Type':'application/json'}})).status,200);
 assert.equal((await fetch(base+'/api/v1/admin/me',{method:'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{"admin":"other"}'}).catch(()=>({status:400}))).status,400);
});

test('P9-06 patient, doctor, forged and stale credentials are rejected with no audit noise',async()=>{
 const a=await newAdmin(),token=await adminToken(a.email),claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
 const email='patient-'+randomUUID()+'@example.invalid';
 const registered=await call('/api/v1/auth/register',{body:{email,password:patientPassword,full_name:'Synthetic Patient'}});assert.equal(registered.status,201);
 const challenge=mail.find(m=>m.to===email&&m.purpose==='verify_email')!;assert.equal((await call('/api/v1/auth/verify-email',{body:{token:challenge.token}})).status,200);
 const patientLogin=await call('/api/v1/auth/login',{body:{email,password:patientPassword}});assert.equal(patientLogin.status,200);
 assert.equal((await call('/api/v1/patients/me',{token:patientLogin.data.access_token})).status,200,'the patient token is genuine');
 assert.equal((await call('/api/v1/patients/me',{token})).status,401,'an admin token is not a patient credential');
 const doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex'),sid=claims.sid as string,now=Math.floor(Date.now()/1000);
 const fakeUnsigned=Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:a.id,sid,aud:adminConfig.jwtAudience,iss:adminConfig.jwtIssuer,iat:now,exp:now+600})).toString('base64url')+'.x';
 const rejected:Array<[string,string|undefined]>=[['no token',undefined],['patient access token',patientLogin.data.access_token],['patient refresh token',patientLogin.data.refresh_token],['doctor share session',doctor],
  ['opaque string','not-a-token'],['alg none',fakeUnsigned],
  ['admin audience signed with the patient key',await forge(patientConfig.jwtKey,adminConfig.jwtAudience,a.id,sid)],
  ['patient audience signed with the admin key',await forge(adminConfig.jwtKey,patientConfig.jwtAudience,a.id,sid)],
  ['patient key and audience carrying admin ids',await forge(patientConfig.jwtKey,patientConfig.jwtAudience,a.id,sid,{iss:patientConfig.jwtIssuer})],
  ['wrong issuer',await forge(adminConfig.jwtKey,adminConfig.jwtAudience,a.id,sid,{iss:'someone-else'})],
  ['missing session',await forge(adminConfig.jwtKey,adminConfig.jwtAudience,a.id,undefined)],
  ['unknown session',await forge(adminConfig.jwtKey,adminConfig.jwtAudience,a.id,randomUUID())],
  ['session of another admin',await forge(adminConfig.jwtKey,adminConfig.jwtAudience,randomUUID(),sid)],
  ['expired',await forge(adminConfig.jwtKey,adminConfig.jwtAudience,a.id,sid,{iat:now-2000,exp:now-1000})],
  ['lifetime beyond the configured limit',await forge(adminConfig.jwtKey,adminConfig.jwtAudience,a.id,sid,{exp:now+7200})]];
 const before=await auditCount();
 for(const [name,value] of rejected){const r=await call('/api/v1/admin/me',{token:value});assert.equal(r.status,401,name);assert.equal(r.data.error.code,'UNAUTHORIZED',name);}
 assert.equal((await call('/api/v1/admin/me',{headers:{Authorization:'Basic '+Buffer.from('a:b').toString('base64')}})).status,401);
 assert.equal(await auditCount(),before,'unauthenticated attempts are not written to the audit log');
 assert.equal((await call('/api/v1/admin/me',{token})).status,200,'the real admin token still works');
});

test('P9-07 sessions end when revoked, expired, or the admin is disabled or changes role or password',async()=>{
 const a=await newAdmin(),token=await adminToken(a.email),claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
 const status=async(t=token)=>(await call('/api/v1/admin/me',{token:t})).status;
 assert.equal(await status(),200);
 await owner.query('UPDATE public.admin_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[claims.sid]);assert.equal(await status(),401);
 const b=await newAdmin(),tb=await adminToken(b.email),cb=JSON.parse(Buffer.from(tb.split('.')[1],'base64url').toString());
 await owner.query("UPDATE public.admin_sessions SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",[cb.sid]);assert.equal(await status(tb),401);
 for(const change of ["status='disabled'","role_name='config_admin'","password_hash='$argon2id$replaced'"]){
  const c=await newAdmin(),tc=await adminToken(c.email);assert.equal(await status(tc),200);
  await owner.query('UPDATE public.admin_accounts SET '+change+' WHERE id=$1',[c.id]);assert.equal(await status(tc),401,change);
 }
 const d=await newAdmin(),td=await adminToken(d.email);await owner.query("UPDATE public.admin_accounts SET status='disabled' WHERE id=$1",[d.id]);
 await owner.query("UPDATE public.admin_accounts SET status='active' WHERE id=$1",[d.id]);assert.equal(await status(td),401,'reactivation does not resurrect old sessions');
});

test('P9-08 a role without the required permission is denied and the denial is audited',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email);
 await owner.query("DELETE FROM public.admin_role_permissions WHERE role_name='config_admin' AND permission='admin.profile.read'");
 try {
  const r=await call('/api/v1/admin/me',{token});assert.equal(r.status,403);assert.equal(r.data.error.code,'FORBIDDEN');
  const events=await audit("action='admin.profile.read' AND outcome='denied' AND actor_admin_id=$1",[a.id]);assert.equal(events.length,1);assert.equal(events[0].target_type,'route');
  assert.equal((await audit("action='admin.profile.read' AND outcome='success' AND actor_admin_id=$1",[a.id])).length,0);
 } finally {await owner.query("INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('config_admin','admin.profile.read')");}
 assert.equal((await call('/api/v1/admin/me',{token})).status,200);
});

test('P9-09 audit events are append-only for the API role and the table owner',async()=>{
 const a=await newAdmin(),requestId=randomUUID();
 await writeAdminAudit(db,{actorAdminId:a.id,actorRole:'support_admin',action:'admin.profile.read',targetType:'admin_account',targetId:a.id,scope:{note:'append-only probe'},outcome:'success',requestId});
 const [event]=await audit('request_id=$1',[requestId]);assert.ok(event);
 for(const sql of ['UPDATE public.admin_audit_events SET outcome=\'success\'','DELETE FROM public.admin_audit_events','TRUNCATE public.admin_audit_events'])await assert.rejects(db.query(sql),sqlState('42501'));
 for(const sql of ['UPDATE public.admin_audit_events SET outcome=\'success\'','DELETE FROM public.admin_audit_events','TRUNCATE public.admin_audit_events','DELETE FROM public.admin_audit_events WHERE seq=1'])
  await assert.rejects(owner.query(sql),(e:unknown)=>sqlState('42501')(e)&&/append-only/.test((e as Error).message),'the owner cannot rewrite history either: '+sql);
 for(const column of ['seq','id','occurred_at','prev_hash','event_hash'])
  await assert.rejects(db.query(`INSERT INTO public.admin_audit_events(${column},action,target_type,outcome,request_id) VALUES(${column==='seq'?'999':column==='id'?"'"+randomUUID()+"'":column==='occurred_at'?"'2001-01-01'":"'"+'a'.repeat(64)+"'"},'admin.profile.read','admin_account','success','${randomUUID()}')`),sqlState('42501'),column);
 await assert.rejects(db.query("INSERT INTO public.admin_audit_events(action,target_type,outcome,request_id) VALUES('Not A Valid Action','admin_account','success',$1)",[randomUUID()]),sqlState('23514'));
 await assert.rejects(db.query("INSERT INTO public.admin_audit_events(action,target_type,outcome,request_id) VALUES('admin.profile.read','admin_account','maybe',$1)",[randomUUID()]),sqlState('23514'));
 await assert.rejects(db.query("INSERT INTO public.admin_audit_events(action,target_type,outcome,scope,request_id) VALUES('admin.profile.read','admin_account','success',$1::jsonb,$2)",[JSON.stringify({big:'x'.repeat(3000)}),randomUUID()]),sqlState('23514'));
 await assert.rejects(db.query("INSERT INTO public.admin_audit_events(actor_role,action,target_type,outcome,request_id) VALUES('support_admin','admin.profile.read','admin_account','success',$1)",[randomUUID()]),sqlState('23514'));
});

test('P9-10 the audit hash chain is linear under concurrency and detects tampering',async()=>{
 const a=await newAdmin();
 await Promise.all(Array.from({length:12},(_,index)=>writeAdminAudit(db,{actorAdminId:a.id,actorRole:'support_admin',action:'admin.profile.read',targetType:'admin_account',targetId:a.id,scope:{index},outcome:'success',requestId:randomUUID()})));
 const rows=(await owner.query('SELECT seq,prev_hash,event_hash FROM public.admin_audit_events ORDER BY seq')).rows;
 assert.equal(rows[0].prev_hash,'0'.repeat(64));rows.forEach((row,i)=>{assert.equal(Number(row.seq),i+1);if(i)assert.equal(row.prev_hash,rows[i-1].event_hash);});
 const verified=(await db.query<{checked:string;first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0];
 assert.equal(Number(verified.checked),rows.length);assert.equal(verified.first_invalid,null);
 const client=await owner.connect();
 try {
  await client.query('BEGIN');await client.query('ALTER TABLE public.admin_audit_events DISABLE TRIGGER admin_audit_no_change');
  await client.query("UPDATE public.admin_audit_events SET outcome='failure' WHERE seq=3");
  const tampered=(await client.query('SELECT * FROM public.verify_admin_audit_chain()')).rows[0];assert.equal(Number(tampered.first_invalid),3);assert.equal(Number(tampered.checked),2);
  await client.query('ROLLBACK');
 } finally {client.release();}
 assert.equal((await db.query<{first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0].first_invalid,null,'the tampering experiment was rolled back');
});

test('P9-11 repeated login attempts are rate limited per account without revealing which accounts exist',async()=>{
 const a=await newAdmin(),statuses:number[]=[];
 for(let i=0;i<5;i++)statuses.push((await adminLogin(a.email,'Wrong synthetic passphrase 000!',strictBase)).status);
 assert.deepEqual(statuses,[401,401,401,429,429]);
 assert.equal((await adminLogin(a.email,adminPassword,strictBase)).status,429,'a correct password does not bypass the limit');
 const ghost='ghost-'+randomUUID()+'@example.invalid',ghostStatuses:number[]=[];
 for(let i=0;i<4;i++)ghostStatuses.push((await adminLogin(ghost,'Wrong synthetic passphrase 000!',strictBase)).status);
 assert.equal(ghostStatuses.at(-1),429);
 const stored=(await owner.query('SELECT * FROM public.admin_auth_rate_limits')).rows;
 assert.ok(stored.length>0&&stored.every(row=>/^[a-f0-9]{64}$/.test(row.bucket_hash)));
 assert.ok(!JSON.stringify(stored).includes('127.0.0.1')&&!JSON.stringify(stored).includes(ghost)&&!JSON.stringify(stored).includes(a.email),'rate-limit rows hold neither the raw address nor the raw email');
});

test('P9-12 admin tokens verify only through the admin service and cannot be reused for another actor',async()=>{
 const a=await newAdmin(),token=await adminToken(a.email);
 assert.deepEqual(Object.keys(await tokens.verifySession(token)).sort(),['adminId','sessionId']);
 await assert.rejects(createAdminTokenService({...adminConfig,jwtKey:patientConfig.jwtKey}).verifySession(token));
 await assert.rejects(createAdminTokenService({...adminConfig,jwtAudience:patientConfig.jwtAudience}).verifySession(token));
 const secrets=JSON.stringify((await owner.query('SELECT * FROM public.admin_sessions')).rows)+JSON.stringify((await owner.query('SELECT * FROM public.admin_audit_events')).rows);
 assert.ok(!secrets.includes(token)&&!secrets.includes(adminPassword)&&!secrets.includes('argon2'));
});

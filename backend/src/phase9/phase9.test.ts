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
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,15);
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
const allPermissions=['admin.patients.reactivate','admin.patients.read','admin.patients.suspend','admin.profile.read'];
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
 assert.deepEqual((await owner.query("SELECT DISTINCT permission FROM public.admin_role_permissions ORDER BY permission")).rows.map(r=>r.permission),allPermissions);
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
 assert.equal(r.status,200);assert.deepEqual(r.data,{success:true,admin:{id:a.id,email:a.email,full_name:'Synthetic Admin',role:'operations_admin',permissions:allPermissions}});
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

// ---- Phase 2: patient account management (M13-002, M13-012, M13-013) ----
const accountKeys=['account_status','created_at','email','email_verified','email_verified_at','full_name','id','updated_at'];
let seedHash:string|undefined;
async function seedPatient(name:string,email:string,status:string,verified:boolean,createdAt?:string){
 seedHash??=await passwords.hash(patientPassword);
 const r=await owner.query(`INSERT INTO public.patients(email,password_hash,full_name,account_status,email_verified_at,created_at,date_of_birth,phone_number)
  VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,clock_timestamp()),'1990-01-01','+10000000000') RETURNING id`,[email,seedHash,name,status,verified?new Date():null,createdAt??null]);
 return r.rows[0].id as string;
}
async function livePatient(){
 const email='live-'+randomUUID()+'@example.invalid';
 const r=await call('/api/v1/auth/register',{body:{email,password:patientPassword,full_name:'Synthetic Live Patient',phone_number:'+10000000001'}});assert.equal(r.status,201);
 const challenge=mail.find(m=>m.to===email&&m.purpose==='verify_email')!;assert.equal((await call('/api/v1/auth/verify-email',{body:{token:challenge.token}})).status,200);
 const login=await call('/api/v1/auth/login',{body:{email,password:patientPassword}});assert.equal(login.status,200);
 return {id:r.data.patient.id as string,email,access:login.data.access_token as string,refresh:login.data.refresh_token as string};
}
const patientRow=async(id:string)=>(await owner.query('SELECT * FROM public.patients WHERE id=$1',[id])).rows[0];
async function medicalSnapshot(patientId:string){
 const tables=(await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ~ '^(medical_|extracted_|ai_|rag_|summary_)' AND table_type='BASE TABLE' ORDER BY 1")).rows.map(r=>r.table_name as string);
 assert.ok(tables.includes('medical_documents'));
 const parts:string[]=[];
 for(const table of tables)parts.push(table+':'+(await owner.query(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS h, count(*)::int AS n FROM public.${table} t`)).rows.map(r=>r.h+'/'+r.n).join(''));
 return parts.join('\n');
}

test('P9-13 the three roles hold the new patient-account permissions and nothing reaches medical content',async()=>{
 for(const role of ['support_admin','operations_admin','config_admin'])
  assert.deepEqual((await owner.query('SELECT permission FROM public.admin_role_permissions WHERE role_name=$1 ORDER BY permission',[role])).rows.map(r=>r.permission),allPermissions,role);
 assert.ok(allPermissions.every(permission=>/^admin\.(profile|patients)\.[a-z]+$/.test(permission)));
});

test('P9-14 account list searches, filters and pages by keyset and shows only identity and status fields',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email);
 const tag='Zq'+randomBytes(4).toString('hex').replace(/[0-9]/g,c=>'ghijklmnop'[Number(c)]),stamp='2031-05-0';
 const seeded=[['active',true],['active',true],['active',true],['unverified',false],['unverified',false],['suspended',true],['deletion_pending',true]] as const;
 const ids:string[]=[];
 for(const [i,[status,verified]] of seeded.entries())ids.push(await seedPatient(tag+' Person'+i,tag.toLowerCase()+'-'+i+'@example.invalid',status,verified,stamp+(i<2?'1':String(i+1))+'T10:00:00Z'));
 const list=async(query:string)=>call('/api/v1/admin/patients'+query,{token});
 const all=await list('?q='+tag);assert.equal(all.status,200);assert.equal(all.data.patients.length,7);assert.equal(all.data.next_cursor,null);
 for(const patient of all.data.patients)assert.deepEqual(Object.keys(patient).sort(),accountKeys);
 const text=JSON.stringify(all.data);for(const forbidden of ['date_of_birth','phone_number','sex_gender','pending_guardian','password','1990-01-01','+1000000'])assert.ok(!text.includes(forbidden),forbidden);
 assert.deepEqual(all.data.patients.map((p:any)=>p.id).sort(),[...ids].sort());
 const byEmail=await list('?q='+encodeURIComponent(tag.toLowerCase()+'-3@'));assert.deepEqual(byEmail.data.patients.map((p:any)=>p.id),[ids[3]]);
 assert.equal((await list('?q='+encodeURIComponent(tag.toUpperCase()+' person5'))).data.patients[0].id,ids[5]);
 const seen:string[]=[];let cursor:string|null=null,pages=0;
 do{const page:any=await list('?q='+tag+'&limit=3'+(cursor?'&cursor='+cursor:''));assert.equal(page.status,200);assert.ok(page.data.patients.length<=3);seen.push(...page.data.patients.map((p:any)=>p.id));cursor=page.data.next_cursor;pages++;}while(cursor&&pages<10);
 assert.equal(pages,3);assert.deepEqual(seen,all.data.patients.map((p:any)=>p.id),'paging returns every row once in the same newest-first order, including equal timestamps');
 assert.equal(new Set(seen).size,7);
 assert.deepEqual((await list('?q='+tag+'&status=unverified')).data.patients.map((p:any)=>p.id).sort(),[ids[3],ids[4]].sort());
 assert.equal((await list('?q='+tag+'&status=suspended')).data.patients.length,1);
 assert.equal((await list('?q='+tag+'&verified=false')).data.patients.length,2);
 assert.equal((await list('?q='+tag+'&verified=true')).data.patients.length,5);
 assert.equal((await list('?q='+tag+'&verified=true&status=active')).data.patients.length,3);
 assert.equal((await list('?q='+tag+'&status=active&limit=2')).data.patients.length,2);
 assert.equal((await list('?q='+encodeURIComponent('%%'))).data.patients.length,0,'wildcards typed by the admin are literal');
 assert.equal((await list('?q='+encodeURIComponent(tag+'_'))).data.patients.length,0,'an underscore is not a one-character wildcard');
 for(const bad of ['?q=a','?q='+'x'.repeat(101),'?status=root','?verified=yes','?limit=0','?limit=51','?limit=x','?cursor=garbage','?cursor='+Buffer.from('{"c":"1","i":"2"}').toString('base64url'),'?patient_id='+ids[0],
  '?status=active&status=suspended','?q=ab&q=cd','?q[a]=1','?limit=1.5','?q=%00ab'])
  assert.equal((await list(bad)).status,400,bad);
 const rows=await audit("action='admin.patients.read' AND actor_admin_id=$1 AND target_id IS NULL",[a.id]);
 assert.ok(rows.length>=10);assert.ok(rows.every(row=>row.outcome==='success'&&row.target_type==='patient_account'));
 const serialized=JSON.stringify(rows);assert.ok(!serialized.includes(tag)&&!serialized.includes(tag.toLowerCase())&&!serialized.includes('example.invalid'),'search text never enters the audit log');
 assert.deepEqual(rows.find(row=>row.scope.query_length===tag.length&&row.scope.status==='unverified')?.scope,{status:'unverified',verified:null,query_length:tag.length,limit:25,returned:2});
});

test('P9-15 account detail shows status and verification, audits the read, and rejects bad identifiers',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email);
 const id=await seedPatient('Detail Person','detail-'+randomUUID()+'@example.invalid','unverified',false);
 const r=await call('/api/v1/admin/patients/'+id,{token});assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data.patient).sort(),accountKeys);
 assert.equal(r.data.patient.account_status,'unverified');assert.equal(r.data.patient.email_verified,false);assert.equal(r.data.patient.email_verified_at,null);
 const [event]=await audit("action='admin.patients.read' AND target_id=$1 AND actor_admin_id=$2",[id,a.id]);assert.equal(event.outcome,'success');
 const missing=randomUUID(),gone=await call('/api/v1/admin/patients/'+missing,{token});assert.equal(gone.status,404);
 assert.equal((await audit("action='admin.patients.read' AND target_id=$1",[missing]))[0].outcome,'failure');
 for(const path of ['/api/v1/admin/patients/not-a-uuid','/api/v1/admin/patients/'+id+'?full_name=x'])assert.equal((await call(path,{token})).status,400,path);
});

test('P9-16 suspend revokes sessions and audits in one transaction; reactivate restores access only through a new login',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),p=await livePatient();
 const second=await call('/api/v1/auth/login',{body:{email:p.email,password:patientPassword}});assert.equal(second.status,200);
 await owner.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,hospital_name,processing_status,content_type,size_bytes,sha256)
  VALUES($1,$2,'synthetic-private-bucket',$3,'synthetic.pdf','pdf','lab_report','Synthetic Hospital','failed','application/pdf',24,'02be06dafdca1e35e82ce33d549485f29627c07274b644fafb0e54befbe732de')`,[randomUUID(),p.id,'medical-documents/'+randomUUID()+'.pdf']);
 assert.equal((await call('/api/v1/patients/me',{token:p.access})).status,200);
 const beforeRow=await patientRow(p.id),beforeMedical=await medicalSnapshot(p.id),beforeAudit=await auditCount();
 const suspended=await call('/api/v1/admin/patients/'+p.id+'/suspend',{method:'POST',token});
 assert.equal(suspended.status,200);assert.equal(suspended.data.patient.account_status,'suspended');assert.deepEqual(Object.keys(suspended.data.patient).sort(),accountKeys);
 assert.equal(await auditCount(),beforeAudit+1,'exactly one audit row');
 const [event]=await audit("action='admin.patients.suspend' AND target_id=$1",[p.id]);
 assert.equal(event.outcome,'success');assert.equal(event.actor_admin_id,a.id);assert.equal(event.target_type,'patient_account');assert.deepEqual(event.scope,{from:'active',to:'suspended',sessions_revoked:2});
 const sessions=(await owner.query('SELECT revoked_at FROM public.patient_auth_sessions WHERE patient_id=$1',[p.id])).rows;assert.equal(sessions.length,2);assert.ok(sessions.every(row=>row.revoked_at));
 assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.patient_security_events WHERE patient_id=$1 AND event='session_revoked'",[p.id])).rows[0].n,2);
 assert.equal((await call('/api/v1/patients/me',{token:p.access})).status,401);assert.equal((await call('/api/v1/patients/me',{token:second.data.access_token})).status,401);
 assert.equal((await call('/api/v1/auth/refresh',{body:{refresh_token:p.refresh}})).status,401);
 assert.equal((await call('/api/v1/auth/login',{body:{email:p.email,password:patientPassword}})).status,401);
 const afterRow=await patientRow(p.id);
 for(const key of Object.keys(beforeRow).filter(k=>!['account_status','security_version','updated_at'].includes(k)))assert.deepEqual(afterRow[key],beforeRow[key],'patient column '+key+' is unchanged');
 assert.equal(afterRow.account_status,'suspended');assert.equal(await medicalSnapshot(p.id),beforeMedical,'no medical table changed');
 const again=await call('/api/v1/admin/patients/'+p.id+'/suspend',{method:'POST',token});assert.equal(again.status,409);assert.equal(again.data.error.code,'ACCOUNT_STATE_CONFLICT');
 const failure=(await audit("action='admin.patients.suspend' AND target_id=$1 AND outcome='failure'",[p.id]));assert.equal(failure.length,1);assert.equal(failure[0].scope.reason,'state_conflict');
 const reactivated=await call('/api/v1/admin/patients/'+p.id+'/reactivate',{method:'POST',token});assert.equal(reactivated.status,200);assert.equal(reactivated.data.patient.account_status,'active');
 assert.deepEqual((await audit("action='admin.patients.reactivate' AND target_id=$1",[p.id]))[0].scope,{from:'suspended',to:'active',sessions_revoked:0});
 assert.equal((await call('/api/v1/patients/me',{token:p.access})).status,401,'reactivation does not resurrect old tokens');
 assert.equal((await call('/api/v1/auth/refresh',{body:{refresh_token:p.refresh}})).status,401);
 const fresh=await call('/api/v1/auth/login',{body:{email:p.email,password:patientPassword}});assert.equal(fresh.status,200);assert.equal((await call('/api/v1/patients/me',{token:fresh.data.access_token})).status,200);
 assert.equal(await medicalSnapshot(p.id),beforeMedical);
 assert.equal((await call('/api/v1/admin/patients/'+p.id+'/reactivate',{method:'POST',token})).status,409);
 const chain=(await db.query<{first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0];assert.equal(chain.first_invalid,null);
});

test('P9-17 only valid transitions run: unknown, unverified, deleted and unverifiable accounts are refused with an audit row',async()=>{
 const a=await newAdmin(),token=await adminToken(a.email),post=(id:string,action:string)=>call('/api/v1/admin/patients/'+id+'/'+action,{method:'POST',token});
 const missing=randomUUID();assert.equal((await post(missing,'suspend')).status,404);assert.equal((await audit("action='admin.patients.suspend' AND target_id=$1",[missing]))[0].outcome,'failure');
 const cases:Array<[string,boolean,string,number]>=[['unverified',false,'suspend',409],['deletion_pending',true,'suspend',409],['deleted',true,'suspend',409],['revoked',true,'suspend',409],['deletion_restricted',true,'suspend',409],
  ['active',true,'reactivate',409],['unverified',false,'reactivate',409],['suspended',false,'reactivate',409],['deleted',true,'reactivate',409]];
 for(const [status,verified,action,expected] of cases){
  const id=await seedPatient('State Case','state-'+randomUUID()+'@example.invalid',status,verified);
  const r=await post(id,action);assert.equal(r.status,expected,status+'/'+verified+'/'+action);assert.equal((await patientRow(id)).account_status,status,'status is unchanged');
 }
 assert.equal((await post('not-a-uuid','suspend')).status,400);
});

test('P9-18 a failed audit write rolls the whole status change back',async()=>{
 const a=await newAdmin(),token=await adminToken(a.email),p=await livePatient(),before=await patientRow(p.id);
 await owner.query("ALTER TABLE public.admin_audit_events ADD CONSTRAINT p9_block_suspend CHECK(action<>'admin.patients.suspend') NOT VALID");
 try{
  assert.equal((await call('/api/v1/admin/patients/'+p.id+'/suspend',{method:'POST',token})).status,500);
 }finally{await owner.query('ALTER TABLE public.admin_audit_events DROP CONSTRAINT p9_block_suspend');}
 const after=await patientRow(p.id);assert.equal(after.account_status,'active');assert.equal(after.security_version,before.security_version);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.patient_auth_sessions WHERE patient_id=$1 AND revoked_at IS NOT NULL',[p.id])).rows[0].n,0);
 assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.patient_security_events WHERE patient_id=$1 AND event='session_revoked'",[p.id])).rows[0].n,0);
 assert.equal((await call('/api/v1/patients/me',{token:p.access})).status,200,'the patient session survives a rolled-back suspension');
 assert.equal((await call('/api/v1/admin/patients/'+p.id+'/suspend',{method:'POST',token})).status,200,'the same action works once auditing works');
});

test('P9-19 patient, doctor and unauthenticated callers are rejected, and each permission is enforced separately',async()=>{
 const patient=await livePatient(),id=await seedPatient('Perm Person','perm-'+randomUUID()+'@example.invalid','active',true);
 const doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex'),before=await auditCount();
 const routes:Array<[string,string]>=[['GET','/api/v1/admin/patients'],['GET','/api/v1/admin/patients/'+id],['POST','/api/v1/admin/patients/'+id+'/suspend'],['POST','/api/v1/admin/patients/'+id+'/reactivate']];
 for(const [method,path] of routes)for(const token of [undefined,patient.access,doctor,'not-a-token'])assert.equal((await call(path,{method,token})).status,401,method+' '+path);
 assert.equal((await patientRow(id)).account_status,'active');assert.equal(await auditCount(),before,'rejected callers leave no audit rows');
 const a=await newAdmin('support_admin'),token=await adminToken(a.email);
 for(const permission of ['admin.patients.read','admin.patients.suspend','admin.patients.reactivate']){
  await owner.query("DELETE FROM public.admin_role_permissions WHERE role_name='support_admin' AND permission=$1",[permission]);
  try{
   const target=permission.endsWith('read')?['GET','/api/v1/admin/patients']:['POST','/api/v1/admin/patients/'+id+'/'+permission.split('.')[2]];
   const denied=await call(target[1],{method:target[0],token});assert.equal(denied.status,403,permission);assert.equal(denied.data.error.code,'FORBIDDEN');
   assert.equal((await audit("action=$1 AND outcome='denied' AND actor_admin_id=$2",[permission,a.id])).length,1,permission);
   assert.equal((await patientRow(id)).account_status,'active','a denied admin changed nothing');
  }finally{await owner.query("INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('support_admin',$1)",[permission]);}
 }
 assert.equal((await call('/api/v1/admin/patients/'+id+'/suspend',{method:'POST',token})).status,200);
});

test('P9-20 two admins suspending the same account at once produce one change and one refusal',async()=>{
 const one=await adminToken((await newAdmin('support_admin')).email),two=await adminToken((await newAdmin('operations_admin')).email),p=await livePatient();
 const results=await Promise.all([one,two].map(token=>call('/api/v1/admin/patients/'+p.id+'/suspend',{method:'POST',token})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const events=await audit("action='admin.patients.suspend' AND target_id=$1",[p.id]);assert.deepEqual(events.map(e=>e.outcome).sort(),['failure','success']);
 assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.patient_security_events WHERE patient_id=$1 AND event='session_revoked'",[p.id])).rows[0].n,1);
});

test('P9-21 admins have no way to edit medical facts: no edit routes, no extra fields, and the code touches only status',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email),p=await livePatient();
 const row=await patientRow(p.id),medical=await medicalSnapshot(p.id),base='/api/v1/admin/patients/'+p.id;
 for(const [method,path,body] of [['PATCH',base,{full_name:'Edited'}],['PUT',base,{full_name:'Edited'}],['DELETE',base,undefined],['POST','/api/v1/admin/patients',{email:'new@example.invalid'}],['POST',base,{full_name:'Edited'}],
  ['PATCH','/api/v1/admin/patients/me',{full_name:'Edited'}],['GET',base+'/documents',undefined],['GET',base+'/summaries',undefined],['GET',base+'/profile',undefined]] as const)
  assert.equal((await call(path,{method,token,body})).status,404,method+' '+path);
 for(const action of ['suspend','reactivate']){
  assert.equal((await call(base+'/'+action,{method:'POST',token,body:{full_name:'Edited',date_of_birth:'1999-09-09',account_status:'active'}})).status,400);
  assert.equal((await call(base+'/'+action+'?full_name=Edited',{method:'POST',token})).status,400);
 }
 assert.deepEqual(await patientRow(p.id),row,'the patient row is byte-for-byte unchanged');assert.equal(await medicalSnapshot(p.id),medical);
 const files=await readdir(new URL('../admin/',import.meta.url)),sources=await Promise.all(files.filter(f=>f.endsWith('.ts')).map(async f=>({f,text:await readFile(new URL('../admin/'+f,import.meta.url),'utf8')})));
 const content=(await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ~ '^(medical_|extracted_|ai_|rag_|summary_)'")).rows.map(r=>r.table_name as string);
 assert.ok(content.length>=5);
 for(const {f,text} of sources)for(const table of content)assert.ok(!new RegExp('\\b'+table+'\\b').test(text.replace(/\/\/.*$/gm,'')),f+' must not reference '+table);
 const code=sources.map(s=>s.text).join('\n');
 const updated=[...code.matchAll(/UPDATE\s+public\.(\w+)\s+SET\s+([^"`]*)/g)].map(m=>m[1]+':'+m[2].trim().split(/\s+WHERE|\s+RETURNING/)[0].replace(/\s+/g,' '));
 assert.deepEqual(updated.sort(),['patient_auth_sessions:revoked_at=clock_timestamp()','patients:account_status=$2'],'the only table writes on patient data are account_status and session revocation');
 assert.deepEqual([...code.matchAll(/INSERT\s+INTO\s+public\.(\w+)/g)].map(m=>m[1]).filter(t=>!t.startsWith('admin_')).sort(),['patient_security_events']);
 assert.ok(!/DELETE\s+FROM/i.test(code.replace(/\/\/.*$/gm,'')),'no admin code deletes rows');
});

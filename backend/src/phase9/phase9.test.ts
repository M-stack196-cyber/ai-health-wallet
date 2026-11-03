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
import {settingRegistry} from '../admin/settings.js';
import {aiServicesFromEnv,type HealthOptions,type ServiceProbe} from '../admin/health.js';
import {safeScope} from '../admin/audit-viewer.js';
import {createServer,type Server,type IncomingMessage} from 'node:http';
import {createGuardianNotificationRoutes} from '../guardian-notifications/routes.js';
import {createSharingRoutes} from '../sharing/routes.js';
import {createRagRoutes} from '../rag/routes.js';
import {createSummaryRoutes} from '../summaries/routes.js';
import {createProcessingRoutes} from '../processing/api.js';
import {createDocumentRoutes} from '../documents/routes.js';
import {createTimelineRoutes} from '../timeline/routes.js';
import {createGuardianRoutes} from '../guardians/routes.js';
import type {RagDatabase} from '../rag/repository.js';
import {createHash} from 'node:crypto';
import {getDocumentConfig} from '../config/documents.js';
import {getAuthenticationConfig} from '../config/auth.js';
import {getSecurityPolicy as runtimeSecurityPolicy} from '../auth/security-policy.js';
import {sharingConfig} from '../sharing/config.js';
import {guardianNotificationConfig} from '../guardian-notifications/config.js';

// Plain PostgreSQL 16 only: M13 Phase 1 needs no pgvector, so migrations 0010-0012 (pgvector/RAG/sharing/guardian) are not applied.
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Only the test-owned Unix socket is allowed.');
const conn={host:socket,port:55481,database:'hw_admin_phase9'};
const owner=new pg.Pool({...conn,user:userInfo().username});
const db=new pg.Pool({...conn,user:'health_wallet_app',max:14});
const patientConfig:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'phase9-patient-issuer',jwtAudience:'phase9-patient',
 argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:8,rateLimitWindowMs:900000,rateLimitMax:1000};
const adminConfig:AdminAuthenticationConfig={jwtKey:new Uint8Array(randomBytes(32)),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'phase9-admin-issuer',
 jwtAudience:'phase9-admin',rateLimitMax:500,rateWindowSeconds:900};
// A separate key gives this server its own rate-limit buckets, so other tests sharing 127.0.0.1 cannot exhaust them.
const strictConfig:AdminAuthenticationConfig={...adminConfig,jwtKey:new Uint8Array(randomBytes(32)),rateLimitMax:3};
const passwords=createPasswordService(patientConfig),tokens=createAdminTokenService(adminConfig);
const adminPassword='Synthetic admin passphrase 731!',patientPassword='Synthetic secure passphrase 310!';
const mail:SecurityMailMessage[]=[];
let mountApp:(config:AdminAuthenticationConfig,health?:HealthOptions)=>express.Express;
let server:ReturnType<ReturnType<typeof express>['listen']>,base:string,strictServer:ReturnType<ReturnType<typeof express>['listen']>,strictBase:string;

before(async()=>{
 assert.equal((await stat(socket)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try {await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_admin_phase9');}finally{await bootstrap.end();}
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,19);
 for(const f of files){
  if(f.startsWith('0010'))await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
  if(f.startsWith('0005'))await owner.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const c=await owner.connect();try{await c.query('BEGIN');await c.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 mountApp=(config:AdminAuthenticationConfig,health?:HealthOptions)=>{
  const app=express();app.use(express.json());app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const patients=createPatientRoutes(db,patientConfig,{mailer:{async send(m){mail.push(m);}},policy:{...getSecurityPolicy(),challengeRateMax:10000}});
  app.use('/api/v1/auth',patients.auth);app.use('/api/v1/patients',patients.profile);app.use('/api/v1/admin',createAdminRoutes(db,patientConfig,config,{health}));app.use(errorHandler);return app;
 };
 server=mountApp(adminConfig,{services:[]}).listen(0,'127.0.0.1');await once(server,'listening');
 strictServer=mountApp(strictConfig,{services:[]}).listen(0,'127.0.0.1');await once(strictServer,'listening');
 for(const [s,set] of [[server,(b:string)=>{base=b;}],[strictServer,(b:string)=>{strictBase=b;}]] as const){const a=s.address();assert.ok(a&&typeof a==='object');set('http://127.0.0.1:'+a.port);}
});
after(async()=>{for(const s of [server,strictServer])if(s){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));}await db.end();await owner.end();});

async function call(path:string,opts:{method?:string;body?:unknown;token?:string;headers?:Record<string,string>;root?:string;keyNames?:boolean}={}){
 const r=await fetch((opts.root??base)+path,{method:opts.method??(opts.body===undefined?'GET':'POST'),headers:{...(opts.body===undefined?{}:{'Content-Type':'application/json'}),
  ...(opts.token?{Authorization:'Bearer '+opts.token}:{}),...opts.headers},body:opts.body===undefined?undefined:JSON.stringify(opts.body),signal:AbortSignal.timeout(15000)});
 const text=await r.text();assert.ok(r.headers.get('cache-control')?.includes('no-store'));
 assert.ok((opts.keyNames||path.startsWith('/api/v1/admin/audit')||!text.includes('password_hash'))&&!text.includes('$argon2')&&!text.includes(adminPassword)&&!text.includes(patientPassword),'response contains a sensitive value');
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
const allPermissions=['admin.audit.read','admin.deliveries.read','admin.guardians.read','admin.health.read','admin.patients.reactivate','admin.patients.read','admin.patients.suspend','admin.processing.read','admin.processing.retry','admin.profile.read','admin.rules.create','admin.rules.read','admin.settings.approve','admin.settings.change','admin.settings.read','admin.shares.read'];
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
 assert.ok(allPermissions.every(permission=>/^admin\.(profile|patients|processing|guardians|shares|deliveries|settings|rules|health|audit)\.[a-z]+$/.test(permission)));
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

// ---- Phase 3: processing visibility and safe retry (M13-003, M13-014) ----
const jobKeys=['attempt_count','created_at','document_id','finished_at','last_error_code','lease_active','lease_expired','max_attempts','next_attempt_at','patient_id','started_at','state','updated_at'];
const SENTINEL='LEAKSENTINEL';
interface JobSpec{state?:'pending'|'running'|'retry_wait'|'failed'|'completed';attempts?:number;max?:number;code?:string|null;lease?:'live'|'expired';integrity?:boolean;docStatus?:string;sentinel?:boolean}
async function jobFixture(patient:string,spec:JobSpec={}){
 const {state='failed',attempts=1,max=3,code='PROCESSOR_FAILED',integrity=true,sentinel=false}=spec,id=randomUUID();
 const docStatus=spec.docStatus??(state==='failed'?'failed':state==='completed'?'completed':'processing'),tag=sentinel?SENTINEL:'plain';
 // Fixture only: row triggers (enqueue, extraction fence) are switched off so any job state can be staged; table CHECK constraints still apply.
 const c=await owner.connect();
 try{
  await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica');
  await c.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,hospital_name,processing_status,content_type,size_bytes,sha256)
   VALUES($1,$2,'synthetic-private-bucket',$3,$4,'pdf','lab_report',$5,$6,$7,$8,$9)`,[id,patient,'medical-documents/'+tag+'-'+id+'.pdf',tag+'-report.pdf',tag+' Hospital',docStatus,
   integrity?'application/pdf':null,integrity?24:null,integrity?'02be06dafdca1e35e82ce33d549485f29627c07274b644fafb0e54befbe732de':null]);
  const lease=spec.lease==='expired'?"-interval '10 seconds'":"+interval '5 minutes'";
  if(state==='pending')await c.query("INSERT INTO public.document_processing_jobs(document_id,patient_id,state,attempt_count,max_attempts) VALUES($1,$2,'pending',0,$3)",[id,patient,max]);
  else if(state==='running')await c.query(`INSERT INTO public.document_processing_jobs(document_id,patient_id,state,attempt_count,max_attempts,started_at,lease_token,lease_expires_at,attempt_deadline_at)
   VALUES($1,$2,'running',$3,$4,clock_timestamp()-interval '1 minute',gen_random_uuid(),clock_timestamp()${lease},clock_timestamp()+interval '10 minutes')`,[id,patient,attempts,max]);
  else await c.query(`INSERT INTO public.document_processing_jobs(document_id,patient_id,state,attempt_count,max_attempts,started_at,finished_at,last_error_code)
   VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp(),$6)`,[id,patient,state,state==='completed'?1:attempts,max,state==='completed'?null:code]);
  if(sentinel){
   await c.query("INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status,source_metadata) VALUES($1,$2,$3,'failed','{\"note\":\"LEAKSENTINEL metadata\"}')",[id,patient,SENTINEL+' extracted OCR text']);
   await c.query("INSERT INTO public.ai_report_summaries(document_id,patient_id,summary_text,processing_status) VALUES($1,$2,$3,'failed')",[id,patient,SENTINEL+' summary text']);
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 return id;
}
const jobRow=async(id:string)=>(await owner.query('SELECT to_jsonb(j) AS j FROM public.document_processing_jobs j WHERE document_id=$1',[id])).rows[0].j;
const documentRow=async(id:string)=>(await owner.query('SELECT to_jsonb(d) AS d FROM public.medical_documents d WHERE id=$1',[id])).rows[0].d;
const jobsHash=async()=>(await owner.query("SELECT md5(COALESCE(string_agg(to_jsonb(j)::text,'|' ORDER BY document_id),'')) AS h FROM public.document_processing_jobs j")).rows[0].h as string;
const retry=(id:string,token:string,extra:{body?:unknown;query?:string}={})=>call('/api/v1/admin/processing/jobs/'+id+'/retry'+(extra.query??''),{method:'POST',token,body:extra.body});

test('P9-22 the job list filters by state, reason and owner, pages newest first, and exposes only job metadata',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),patient=await seedPatient('Job Owner','jobs-'+randomUUID()+'@example.invalid','active',true);
 const ids:Record<string,string>={};
 ids.pending=await jobFixture(patient,{state:'pending',attempts:0,code:null});ids.live=await jobFixture(patient,{state:'running',lease:'live'});ids.expired=await jobFixture(patient,{state:'running',lease:'expired'});
 ids.wait=await jobFixture(patient,{state:'retry_wait',code:'PROCESSOR_TIMEOUT'});ids.retryable=await jobFixture(patient);ids.exhausted=await jobFixture(patient,{attempts:3});
 ids.invalid=await jobFixture(patient,{code:'INVALID_INPUT'});ids.done=await jobFixture(patient,{state:'completed'});
 const list=(query:string)=>call('/api/v1/admin/processing/jobs'+query,{token});
 const all=await list('?patient_id='+patient);assert.equal(all.status,200);assert.equal(all.data.jobs.length,8);assert.equal(all.data.next_cursor,null);
 for(const job of all.data.jobs){assert.deepEqual(Object.keys(job).sort(),jobKeys);assert.equal(job.patient_id,patient);}
 assert.deepEqual(all.data.jobs.map((j:any)=>j.document_id),(await owner.query('SELECT document_id FROM public.document_processing_jobs WHERE patient_id=$1 ORDER BY updated_at DESC,document_id DESC',[patient])).rows.map(r=>r.document_id));
 const seen:string[]=[];let cursor:string|null=null,pages=0;
 do{const page:any=await list('?patient_id='+patient+'&limit=3'+(cursor?'&cursor='+cursor:''));assert.equal(page.status,200);seen.push(...page.data.jobs.map((j:any)=>j.document_id));cursor=page.data.next_cursor;pages++;}while(cursor&&pages<10);
 assert.equal(pages,3);assert.deepEqual(seen,all.data.jobs.map((j:any)=>j.document_id));
 const only=async(q:string)=>(await list('?patient_id='+patient+q)).data.jobs.map((j:any)=>j.document_id).sort();
 assert.deepEqual(await only('&state=failed'),[ids.retryable,ids.exhausted,ids.invalid].sort());
 assert.deepEqual(await only('&error_code=PROCESSOR_FAILED'),[ids.retryable,ids.exhausted].sort());
 assert.deepEqual(await only('&state=retry_wait&error_code=PROCESSOR_TIMEOUT'),[ids.wait]);
 assert.deepEqual(await only('&state=running'),[ids.live,ids.expired].sort());assert.deepEqual(await only('&state=pending'),[ids.pending]);assert.deepEqual(await only('&state=completed'),[ids.done]);
 const flags=Object.fromEntries(all.data.jobs.map((j:any)=>[j.document_id,[j.lease_active,j.lease_expired]]));
 assert.deepEqual(flags[ids.live],[true,false]);assert.deepEqual(flags[ids.expired],[false,true]);for(const id of [ids.pending,ids.wait,ids.retryable,ids.done])assert.deepEqual(flags[id],[false,false]);
 assert.equal((await list('?patient_id='+patient+'&state=cancelled')).data.jobs.length,0);
 for(const bad of ['?state=bogus','?error_code=x','?patient_id=x','?limit=0','?limit=51','?cursor=garbage','?document_id='+ids.pending,'?state=failed&state=pending','?x[y]=1'])assert.equal((await list(bad)).status,400,bad);
 const summary=await call('/api/v1/admin/processing/summary',{token});assert.equal(summary.status,200);
 const expected=(await owner.query('SELECT state,count(*)::int AS n FROM public.document_processing_jobs GROUP BY 1')).rows;
 for(const row of expected)assert.equal(summary.data.summary.by_state[row.state],row.n,row.state);
 assert.equal(summary.data.summary.total,expected.reduce((n,row)=>n+row.n,0));
 assert.deepEqual(Object.keys(summary.data.summary).sort(),['by_state','failures_by_error_code','running_with_expired_lease','total']);
 assert.equal(summary.data.summary.failures_by_error_code.PROCESSOR_TIMEOUT,Number((await owner.query("SELECT count(*) FROM public.document_processing_jobs WHERE last_error_code='PROCESSOR_TIMEOUT' AND state IN ('failed','retry_wait')")).rows[0].count));
 assert.equal(summary.data.summary.running_with_expired_lease,Number((await owner.query("SELECT count(*) FROM public.document_processing_jobs WHERE state='running' AND lease_expires_at<=clock_timestamp()")).rows[0].count));
 const detail=await call('/api/v1/admin/processing/jobs/'+ids.retryable,{token});assert.equal(detail.status,200);assert.deepEqual(Object.keys(detail.data.job).sort(),jobKeys);assert.equal(detail.data.job.last_error_code,'PROCESSOR_FAILED');
 const missing=randomUUID();assert.equal((await call('/api/v1/admin/processing/jobs/'+missing,{token})).status,404);assert.equal((await audit("action='admin.processing.read' AND target_id=$1",[missing]))[0].outcome,'failure');
 for(const path of ['/api/v1/admin/processing/jobs/not-a-uuid','/api/v1/admin/processing/jobs/'+ids.pending+'?state=failed','/api/v1/admin/processing/summary?x=1'])assert.equal((await call(path,{token})).status,400,path);
 const reads=await audit("action='admin.processing.read' AND actor_admin_id=$1",[a.id]);assert.equal(reads.length,14);assert.ok(reads.every(r=>r.target_type==='processing_job'));
 assert.ok(!JSON.stringify(reads).includes(patient),'the owner id used as a filter is not copied into the audit log');
 assert.deepEqual(reads.find(r=>r.scope.view==='list'&&r.scope.state==='failed')?.scope,{view:'list',state:'failed',error_code:null,patient_filter:true,limit:25,returned:3});
});

test('P9-23 no medical field can leak: names, hospitals, storage keys, OCR text, summaries and lease tokens never appear',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),patient=await seedPatient('Leak Owner '+SENTINEL,'leak-'+randomUUID()+'@example.invalid','active',true);
 const retryable=await jobFixture(patient,{sentinel:true}),running=await jobFixture(patient,{state:'running',sentinel:true}),exhausted=await jobFixture(patient,{attempts:3,sentinel:true});
 assert.equal(Number((await owner.query("SELECT count(*) FROM public.extracted_medical_text WHERE extracted_text LIKE '%LEAKSENTINEL%'")).rows[0].count)>=3,true,'the sentinel really is stored as OCR text');
 const leaseToken=(await owner.query('SELECT lease_token FROM public.document_processing_jobs WHERE document_id=$1',[running])).rows[0].lease_token as string;
 const responses=[await call('/api/v1/admin/processing/summary',{token}),await call('/api/v1/admin/processing/jobs?limit=50',{token}),await call('/api/v1/admin/processing/jobs?patient_id='+patient,{token}),
  await call('/api/v1/admin/processing/jobs/'+retryable,{token}),await call('/api/v1/admin/processing/jobs/'+running,{token}),await retry(retryable,token),await retry(exhausted,token),await retry(running,token)];
 assert.deepEqual(responses.map(r=>r.status),[200,200,200,200,200,200,409,409]);
 const forbidden=[SENTINEL,SENTINEL.toLowerCase(),'extracted OCR text','summary text','Hospital','report.pdf','medical-documents/','synthetic-private-bucket','lab_report','application/pdf','02be06dafdca','Leak Owner',leaseToken,'s3_','sha256','extracted_text','summary_text','source_metadata','original_filename','hospital_name','lease_token'];
 const wire=JSON.stringify(responses.map(r=>r.data));for(const word of forbidden)assert.ok(!wire.includes(word),'response leaks '+word);
 const rows=JSON.stringify(await audit('true'));for(const word of forbidden)assert.ok(!rows.includes(word),'audit log leaks '+word);
 for(const r of responses)for(const job of [r.data.job,...(r.data.jobs??[])].filter(Boolean))assert.deepEqual(Object.keys(job).sort(),jobKeys);
 const source=await readFile(new URL('../admin/processing-jobs.ts',import.meta.url),'utf8').then(text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,''));
 for(const word of ['medical_documents','extracted_medical_text','ai_report_summaries','original_filename','hospital_name','s3_object_key','lease_token','extracted_text','summary_text','JOIN'])assert.ok(!source.includes(word),'processing-jobs.ts must not mention '+word);
});

test('P9-24 retry moves a failed job to retry_wait through the existing owner path, audits it, and changes nothing else',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),patient=await seedPatient('Retry Owner','retry-'+randomUUID()+'@example.invalid','active',true);
 const id=await jobFixture(patient,{sentinel:true,attempts:2,max:3,code:'PROCESSOR_TIMEOUT'});
 const before=await jobRow(id),docBefore=await documentRow(id),extractionBefore=(await owner.query('SELECT to_jsonb(e) AS e FROM public.extracted_medical_text e WHERE document_id=$1',[id])).rows[0].e;
 const summaryBefore=(await owner.query('SELECT to_jsonb(s) AS s FROM public.ai_report_summaries s WHERE document_id=$1',[id])).rows[0].s,jobCount=Number((await owner.query('SELECT count(*) FROM public.document_processing_jobs')).rows[0].count);
 const auditBefore=await auditCount(),r=await retry(id,token);
 assert.equal(r.status,200);assert.equal(r.data.job.state,'retry_wait');assert.equal(r.data.job.attempt_count,2,'attempts are not reset');assert.equal(r.data.job.max_attempts,3);assert.equal(r.data.job.last_error_code,'PROCESSOR_TIMEOUT');
 const after=await jobRow(id);
 for(const key of Object.keys(before).filter(k=>!['state','next_attempt_at','updated_at'].includes(k)))assert.deepEqual(after[key],before[key],'job column '+key+' is unchanged');
 assert.equal(after.lease_token,null);assert.equal(after.lease_expires_at,null);assert.ok(new Date(after.next_attempt_at)<=new Date(),'eligible for the worker immediately');
 const docAfter=await documentRow(id);for(const key of Object.keys(docBefore).filter(k=>!['processing_status','updated_at'].includes(k)))assert.deepEqual(docAfter[key],docBefore[key],'document column '+key+' is unchanged');
 assert.equal(docAfter.processing_status,'processing');
 assert.deepEqual((await owner.query('SELECT to_jsonb(e) AS e FROM public.extracted_medical_text e WHERE document_id=$1',[id])).rows[0].e,extractionBefore,'extraction is untouched');
 assert.deepEqual((await owner.query('SELECT to_jsonb(s) AS s FROM public.ai_report_summaries s WHERE document_id=$1',[id])).rows[0].s,summaryBefore,'summary is untouched');
 assert.equal(Number((await owner.query('SELECT count(*) FROM public.document_processing_jobs')).rows[0].count),jobCount,'no second job is created');
 assert.equal(await auditCount(),auditBefore+1);
 const [event]=await audit("action='admin.processing.retry' AND target_id=$1",[id]);
 assert.equal(event.outcome,'success');assert.equal(event.actor_admin_id,a.id);assert.equal(event.target_type,'processing_job');assert.deepEqual(event.scope,{from:'failed',to:'retry_wait',error_code:'PROCESSOR_TIMEOUT',attempts:2,max_attempts:3});
 const again=await retry(id,token);assert.equal(again.status,409);assert.equal(again.data.error.code,'JOB_NOT_RETRYABLE');
 assert.equal((await audit("action='admin.processing.retry' AND target_id=$1 AND outcome='failure'",[id]))[0].scope.state,'retry_wait');
 const source=await readFile(new URL('../admin/processing-jobs.ts',import.meta.url),'utf8');
 assert.ok(source.includes('createPatientProcessingRepository')&&!/UPDATE\s+public\.(document_processing_jobs|medical_documents)/.test(source),'the retry reuses the existing path and has no second UPDATE');
 assert.equal((await db.query<{first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0].first_invalid,null);
});

test('P9-25 retry is refused and audited for every wrong state, and the job, lease and document stay byte-for-byte unchanged',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email),patient=await seedPatient('Refuse Owner','refuse-'+randomUUID()+'@example.invalid','active',true);
 const suspended=await seedPatient('Suspended Owner','refuse2-'+randomUUID()+'@example.invalid','suspended',true);
 const cases:Array<[string,string,JobSpec]>=[['pending','pending',{state:'pending',attempts:0,code:null}],['running with a live lease','running',{state:'running',lease:'live'}],['running with an expired lease','running',{state:'running',lease:'expired'}],
  ['already waiting for retry','retry_wait',{state:'retry_wait'}],['completed','completed',{state:'completed'}],['attempts exhausted','failed',{attempts:3}],['error code that is not retryable','failed',{code:'INVALID_INPUT'}],
  ['document missing its integrity metadata','failed',{integrity:false}],['document not marked failed','failed',{docStatus:'processing'}]];
 for(const [name,state,spec] of cases){
  const id=await jobFixture(patient,spec),jobBefore=await jobRow(id),docBefore=await documentRow(id),auditBefore=await auditCount(),r=await retry(id,token);
  assert.equal(r.status,409,name);assert.equal(r.data.error.code,'JOB_NOT_RETRYABLE',name);assert.deepEqual(await jobRow(id),jobBefore,name+': job unchanged');assert.deepEqual(await documentRow(id),docBefore,name+': document unchanged');
  assert.equal(await auditCount(),auditBefore+1,name);
  const [event]=await audit("action='admin.processing.retry' AND target_id=$1",[id]);assert.equal(event.outcome,'failure',name);assert.equal(event.scope.reason,'not_retryable');assert.equal(event.scope.state,state,name);
 }
 const owned=await jobFixture(suspended),ownedBefore=await jobRow(owned),ownedDoc=await documentRow(owned);
 // Existing row-level security hides jobs of non-active accounts from the API role, so an admin can neither list nor retry them.
 assert.equal((await retry(owned,token)).status,404);assert.equal((await call('/api/v1/admin/processing/jobs?patient_id='+suspended,{token})).data.jobs.length,0);
 assert.equal((await audit("action='admin.processing.retry' AND target_id=$1",[owned]))[0].scope.reason,'not_found');
 assert.deepEqual(await jobRow(owned),ownedBefore);assert.deepEqual(await documentRow(owned),ownedDoc);
 const missing=randomUUID();assert.equal((await retry(missing,token)).status,404);assert.equal((await audit("action='admin.processing.retry' AND target_id=$1",[missing]))[0].scope.reason,'not_found');
 assert.equal((await retry('not-a-uuid',token)).status,400);
 const live=await jobFixture(patient,{state:'running',lease:'live'}),lease=(await jobRow(live)).lease_token;await retry(live,token);assert.equal((await jobRow(live)).lease_token,lease,'a live lease is never cleared by an admin');
});

test('P9-26 a failed audit write rolls the retry back, and two admins retrying together produce one change',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),patient=await seedPatient('Atomic Owner','atomic-'+randomUUID()+'@example.invalid','active',true);
 const id=await jobFixture(patient),jobBefore=await jobRow(id),docBefore=await documentRow(id);
 await owner.query("ALTER TABLE public.admin_audit_events ADD CONSTRAINT p9_block_retry CHECK(action<>'admin.processing.retry') NOT VALID");
 try{assert.equal((await retry(id,token)).status,500);}finally{await owner.query('ALTER TABLE public.admin_audit_events DROP CONSTRAINT p9_block_retry');}
 assert.deepEqual(await jobRow(id),jobBefore,'the job state change was rolled back');assert.deepEqual(await documentRow(id),docBefore);
 assert.equal((await retry(id,token)).status,200,'the same retry works once auditing works');
 const other=await adminToken((await newAdmin('operations_admin')).email),race=await jobFixture(patient);
 const results=await Promise.all([token,other].map(t=>retry(race,t)));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.deepEqual((await audit("action='admin.processing.retry' AND target_id=$1",[race])).map(e=>e.outcome).sort(),['failure','success']);
 assert.equal((await jobRow(race)).attempt_count,1);
});

test('P9-27 only authorised admins can view or retry, each permission is separate, and viewing never changes data',async()=>{
 const patient=await livePatient(),owned=await seedPatient('Perm Owner','permjob-'+randomUUID()+'@example.invalid','active',true),id=await jobFixture(owned),doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex');
 const routes:Array<[string,string]>=[['GET','/api/v1/admin/processing/summary'],['GET','/api/v1/admin/processing/jobs'],['GET','/api/v1/admin/processing/jobs/'+id],['POST','/api/v1/admin/processing/jobs/'+id+'/retry']];
 const auditBefore=await auditCount(),jobBefore=await jobRow(id);
 for(const [method,path] of routes)for(const token of [undefined,patient.access,doctor,'not-a-token'])assert.equal((await call(path,{method,token})).status,401,method+' '+path);
 assert.equal(await auditCount(),auditBefore);assert.deepEqual(await jobRow(id),jobBefore);
 const a=await newAdmin('support_admin'),token=await adminToken(a.email);
 for(const permission of ['admin.processing.read','admin.processing.retry']){
  await owner.query("DELETE FROM public.admin_role_permissions WHERE role_name='support_admin' AND permission=$1",[permission]);
  try{
   const reading=permission.endsWith('read'),denied=await call(reading?'/api/v1/admin/processing/jobs':'/api/v1/admin/processing/jobs/'+id+'/retry',{method:reading?'GET':'POST',token});
   assert.equal(denied.status,403,permission);assert.equal((await audit("action=$1 AND outcome='denied' AND actor_admin_id=$2",[permission,a.id])).length,1,permission);assert.deepEqual(await jobRow(id),jobBefore,'a denied admin changed nothing');
  }finally{await owner.query("INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('support_admin',$1)",[permission]);}
 }
 const hash=await jobsHash();
 for(const [method,path] of routes.slice(0,3))assert.equal((await call(path,{method,token})).status,200);
 assert.equal(await jobsHash(),hash,'read-only views do not change any job row');
 for(const [method,path] of [['PATCH','/api/v1/admin/processing/jobs/'+id],['PUT','/api/v1/admin/processing/jobs/'+id],['DELETE','/api/v1/admin/processing/jobs/'+id],['POST','/api/v1/admin/processing/jobs'],['POST','/api/v1/admin/processing/jobs/'+id+'/reset'],['POST','/api/v1/admin/processing/jobs/'+id+'/cancel']] as const)
  assert.equal((await call(path,{method,token,body:{state:'completed',attempt_count:0}})).status,404,method+' '+path);
 assert.equal((await retry(id,token,{body:{attempt_count:0,state:'pending'}})).status,400);assert.equal((await retry(id,token,{query:'?force=true'})).status,400);assert.deepEqual(await jobRow(id),jobBefore);
 assert.equal((await retry(id,token)).status,200);
});

// ---- Phase 4: guardian, share-grant and delivery status views (M13-004, M13-015) ----
const guardianKeys=['accepted_at','created_at','id','patient_id','revoked_at','status','updated_at'];
const shareKeys=['active_session_count','created_at','expires_at','id','patient_id','recipient_bound','revoked_at','sharing_method','status'];
const deliveryKeys=['attempts','channel','created_at','delivered_at','failure_reason','id','max_attempts','next_attempt_at','patient_id','purpose','state'];
const hex=(pair:string)=>pair.repeat(32);
const SECRETS={recipient:hex('a1'),content:hex('b2'),provider:hex('c3'),policy:hex('d4'),session:'e5'.repeat(31),digest:'f6'.repeat(31),policyKey:hex('17')};
let sessionCounter=0,digestCounter=0;
const GUARDIAN_EMAIL_TAG='guardian-secret-',DOCTOR_EMAIL_TAG='doctor-secret-',DOCTOR_NAME='Dr LEAKSENTINEL Doctor';
async function staged(work:(c:pg.PoolClient)=>Promise<void>){
 // Fixture only: row triggers and foreign keys are switched off so any status can be staged; table CHECK constraints still apply.
 const c=await owner.connect();
 try{await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica');await work(c);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
interface StatusWorld{patients:Record<string,string>;guardians:Record<string,string>;grants:Record<string,string>;deliveries:Record<string,string>;jobs:Record<string,string>}
let world:Promise<StatusWorld>|undefined;
function buildWorld():Promise<StatusWorld>{return world??=(async()=>{
 const patients:Record<string,string>={};
 for(const name of ['pending','active','revoked','expired','shares','mail','notify'])patients[name]=await seedPatient('Status '+name,'status-'+name+'-'+randomUUID()+'@example.invalid','active',true);
 const guardians:Record<string,string>={},grants:Record<string,string>={},deliveries:Record<string,string>={},jobs:Record<string,string>={};
 await staged(async c=>{
  const guardian=async(key:string,patient:string,status:string,events:string[])=>{
   const id=randomUUID();guardians[key]=id;
   await c.query(`INSERT INTO public.guardian_relationships(id,patient_id,email,status,invitation_id,accepted_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id,patient,GUARDIAN_EMAIL_TAG+key+'@example.invalid',status,status==='ACTIVE'||status==='REVOKED'?randomUUID():null,status==='ACTIVE'||status==='REVOKED'?new Date():null,status==='REVOKED'?new Date():null]);
   for(const event of events)await c.query('INSERT INTO public.guardian_lifecycle_events(patient_id,relationship_id,event) VALUES($1,$2,$3)',[patient,id,event]);
  };
  await guardian('pending',patients.pending,'PENDING',['nominated','resent']);await guardian('active',patients.active,'ACTIVE',['nominated','accepted']);
  await guardian('revoked',patients.revoked,'REVOKED',['nominated','accepted','revoked']);await guardian('expired',patients.expired,'EXPIRED',['nominated','expired']);
  await guardian('revoked2',patients.revoked,'REVOKED',['nominated','revoked']);
  const grant=async(key:string,method:string,created:string,expires:string,revoked:boolean,sessions:Array<'live'|'revoked'|'expired'>,events:string[])=>{
   const id=randomUUID();grants[key]=id;
   await c.query(`INSERT INTO public.doctor_sharing_grants(id,patient_id,doctor_email,sharing_method,token_digest,created_at,expires_at,revoked_at,recipient_bound)
    VALUES($1,$2,$3,$4,$5,now()+$6::interval,now()+$7::interval,CASE WHEN $8::boolean THEN now()+$6::interval+interval '1 minute' END,true)`,[id,patients.shares,DOCTOR_EMAIL_TAG+key+'@example.invalid',method,Buffer.concat([Buffer.alloc(31,0xf6),Buffer.from([++digestCounter])]),created,expires,revoked]);
   for(const kind of sessions)await c.query(`INSERT INTO public.doctor_share_sessions(id,grant_id,patient_id,doctor_email,doctor_name,challenge_id,token_hash,grant_version,patient_security_version,created_at,expires_at,revoked_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,1,now()-interval '30 minutes',now()+$8::interval,CASE WHEN $9::boolean THEN now() END)`,[randomUUID(),id,patients.shares,DOCTOR_EMAIL_TAG+key+'@example.invalid',DOCTOR_NAME,randomUUID(),SECRETS.session+(++sessionCounter).toString(16).padStart(2,'0'),kind==='expired'?'-1 minute':'1 hour',kind==='revoked']);
   for(const event of events)await c.query('INSERT INTO public.doctor_share_events(grant_id,event) VALUES($1,$2)',[id,event]);
  };
  await grant('active_qr','qr_code','-1 hour','1 hour',false,['live','live','revoked','expired'],['created','opened','otp_requested','otp_verified','authorized']);
  await grant('active_link','unique_link','-2 hours','2 hours',false,[],['created','opened','denied','otp_failed','otp_failed']);
  await grant('expired','unique_link','-3 hours','-1 hour',false,[],['created','expiry_denied']);await grant('revoked','qr_code','-3 hours','5 hours',true,['revoked'],['created','revoked']);
  const delivery=async(key:string,purpose:string,state:string,attempts:number,failure:string|null)=>{
   const id=randomUUID();deliveries[key]=id;
   await c.query(`INSERT INTO public.patient_security_email_deliveries(id,challenge_id,patient_id,purpose,state,attempts,claim_id,claim_expires_at,provider_reference_hash,failure_category,delivered_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,randomUUID(),patients.mail,purpose,state,attempts,state==='sending'?randomUUID():null,state==='sending'?new Date(Date.now()+60000):null,state==='delivered'?SECRETS.provider:null,failure,state==='delivered'?new Date(Date.now()+1000):null]);
   await c.query('INSERT INTO public.patient_security_email_payloads(delivery_id,nonce,ciphertext,tag) VALUES($1,$2,$3,$4)',[id,Buffer.alloc(12,1),Buffer.from('LEAKSENTINEL one-time code 482913 and magic link https://example.invalid/token'),Buffer.alloc(16,2)]);
  };
  await delivery('verify_delivered','verify_email','delivered',1,null);await delivery('reset_failed','reset_password','permanent_failed',3,'rejected');await delivery('otp_retry','doctor_share_otp','transient_failed',2,'timeout');
  await delivery('invite_pending','guardian_invitation','pending',0,null);await delivery('verify_sending','verify_email','sending',1,null);
  const job=async(key:string,kind:string,state:string,attempts:number,failure:string|null)=>{
   const id=randomUUID();jobs[key]=id;
   await c.query(`INSERT INTO public.guardian_medical_jobs(id,patient_id,relationship_id,recipient_hash,patient_security_version,kind,policy_sha256,window_start,window_end,not_before,state,attempts,max_attempts,content_sha256,provider_reference_hash,failure_code,delivered_at)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,COALESCE($8,now()),$9,$10,3,$11,$12,$13,$14)`,[id,patients.notify,guardians.active,SECRETS.recipient,kind,SECRETS.policy,kind==='routine_digest'?new Date(Date.now()-86400000):null,kind==='routine_digest'?new Date(Date.now()-3600000):null,state,attempts,
     state==='delivered'?SECRETS.content:null,state==='delivered'?SECRETS.provider:null,failure,state==='delivered'?new Date(Date.now()+1000):null]);
   if(kind==='serious_alert')await c.query(`INSERT INTO public.guardian_rule_results(id,patient_id,document_id,snapshot_id,rule_id,rule_version,definition_sha256,outcome,result,job_id)
    VALUES($1,$2,$3,$4,'rule','1',$5,'TRIGGERED',$6::jsonb,$7)`,[randomUUID(),patients.notify,randomUUID(),randomUUID(),SECRETS.policyKey,JSON.stringify({outcome:'TRIGGERED',finding:'LEAKSENTINEL serious finding'}),id]);
  };
  await job('digest_delivered','routine_digest','delivered',1,null);await job('alert_failed','serious_alert','permanent_failed',3,'source_denied');await job('digest_retry','routine_digest','retry_wait',1,'transport');await job('alert_pending','serious_alert','pending',0,null);
 });
 return {patients,guardians,grants,deliveries,jobs};
})();}
const statusUrl=(path:string)=>'/api/v1/admin/status/'+path;
const allStatusRoutes=async()=>{const w=await buildWorld();return [statusUrl('guardians'),statusUrl('guardians/summary'),statusUrl('guardians/'+w.guardians.active),statusUrl('shares'),statusUrl('shares/summary'),statusUrl('shares/'+w.grants.active_qr),statusUrl('deliveries'),statusUrl('deliveries/summary')];};
async function pageAll(path:string,token:string,key:string,limit:number){
 const seen:any[]=[];let cursor:string|null=null,pages=0;
 do{const r:any=await call(path+(path.includes('?')?'&':'?')+'limit='+limit+(cursor?'&cursor='+cursor:''),{token});assert.equal(r.status,200,path);seen.push(...r.data[key]);cursor=r.data.next_cursor;pages++;}while(cursor&&pages<20);
 return {seen,pages};
}

test('P9-28 guardian relationship status: filters, paging, detail and counts show status only, never the guardian email',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),w=await buildWorld(),mine=(extra='')=>statusUrl('guardians?'+extra);
 const revokedOwner=w.patients.revoked,own=await call(mine('patient_id='+revokedOwner),{token});assert.equal(own.status,200);assert.equal(own.data.guardians.length,2);
 for(const g of own.data.guardians){assert.deepEqual(Object.keys(g).sort(),guardianKeys);assert.equal(g.patient_id,revokedOwner);assert.equal(g.status,'REVOKED');assert.ok(g.revoked_at);}
 const ids=Object.values(w.guardians);
 const all=await pageAll(statusUrl('guardians'),token,'guardians',2);assert.ok(all.pages>=2);assert.equal(new Set(all.seen.map(g=>g.id)).size,all.seen.length,'no row twice');
 assert.deepEqual(all.seen.map(g=>g.id),(await owner.query('SELECT id FROM public.guardian_relationships ORDER BY created_at DESC,id DESC')).rows.map(r=>r.id),'newest first');
 for(const id of ids)assert.ok(all.seen.some(g=>g.id===id));
 for(const [status,key] of [['PENDING','pending'],['ACTIVE','active'],['EXPIRED','expired']] as const)assert.deepEqual((await call(mine('status='+status+'&patient_id='+w.patients[key]),{token})).data.guardians.map((g:any)=>g.id),[w.guardians[key]]);
 assert.equal((await call(mine('status=REVOKED&patient_id='+w.patients.pending),{token})).data.guardians.length,0);
 const detail=await call(statusUrl('guardians/'+w.guardians.revoked),{token});assert.equal(detail.status,200);assert.deepEqual(Object.keys(detail.data.guardian).sort(),[...guardianKeys,'events'].sort());
 assert.deepEqual(detail.data.guardian.events.map((e:any)=>e.event),['nominated','accepted','revoked']);for(const e of detail.data.guardian.events)assert.deepEqual(Object.keys(e).sort(),['event','occurred_at']);
 const summary=await call(statusUrl('guardians/summary'),{token});assert.equal(summary.status,200);
 for(const row of (await owner.query('SELECT status,count(*)::int AS n FROM public.guardian_relationships GROUP BY 1')).rows)assert.equal(summary.data.summary.by_status[row.status],row.n,row.status);
 assert.deepEqual(Object.keys(summary.data.summary).sort(),['by_status','total']);
 for(const bad of ['status=active','status=PENDING&status=ACTIVE','patient_id=x','limit=0','limit=51','cursor=garbage','email=a@b.c','x[y]=1'])assert.equal((await call(mine(bad),{token})).status,400,bad);
 const missing=randomUUID();assert.equal((await call(statusUrl('guardians/'+missing),{token})).status,404);assert.equal((await audit("action='admin.guardians.read' AND target_id=$1",[missing]))[0].outcome,'failure');
 for(const path of [statusUrl('guardians/not-a-uuid'),statusUrl('guardians/'+w.guardians.active+'?x=1'),statusUrl('guardians/summary?x=1')])assert.equal((await call(path,{token})).status,400,path);
 const reads=await audit("action='admin.guardians.read' AND actor_admin_id=$1",[a.id]);assert.ok(reads.length>=10&&reads.every(r=>r.target_type==='guardian_relationship'));
 assert.ok(!JSON.stringify(reads).includes(revokedOwner)&&!JSON.stringify(reads).includes('REVOKED'),'filter values are not copied into the audit log');
 const shaped=reads.find(r=>r.scope.view==='list'&&r.scope.filters.length===2)!.scope;assert.deepEqual(Object.keys(shaped).sort(),['filters','limit','returned','view']);assert.deepEqual(shaped.filters,['patient_id','status']);
});

test('P9-29 doctor share-grant status: computed state, session counts and event counts without link secrets, OTPs or doctor identity',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),w=await buildWorld(),list=(extra='')=>statusUrl('shares?patient_id='+w.patients.shares+extra);
 const all=await call(list(),{token});assert.equal(all.status,200);assert.equal(all.data.shares.length,4);
 for(const g of all.data.shares)assert.deepEqual(Object.keys(g).sort(),shareKeys);
 const by=Object.fromEntries(all.data.shares.map((g:any)=>[g.id,g]));
 assert.equal(by[w.grants.active_qr].status,'active');assert.equal(by[w.grants.active_qr].active_session_count,2,'only unrevoked, unexpired sessions are counted');assert.equal(by[w.grants.active_qr].sharing_method,'qr_code');
 assert.equal(by[w.grants.active_link].status,'active');assert.equal(by[w.grants.active_link].active_session_count,0);assert.equal(by[w.grants.expired].status,'expired');assert.equal(by[w.grants.revoked].status,'revoked');assert.ok(by[w.grants.revoked].revoked_at);assert.equal(by[w.grants.revoked].active_session_count,0);
 const only=async(q:string)=>(await call(list('&'+q),{token})).data.shares.map((g:any)=>g.id).sort();
 assert.deepEqual(await only('status=active'),[w.grants.active_qr,w.grants.active_link].sort());assert.deepEqual(await only('status=expired'),[w.grants.expired]);assert.deepEqual(await only('status=revoked'),[w.grants.revoked]);
 assert.deepEqual(await only('method=qr_code'),[w.grants.active_qr,w.grants.revoked].sort());assert.deepEqual(await only('method=unique_link&status=active'),[w.grants.active_link]);
 const paged=await pageAll(list(),token,'shares',3);assert.equal(paged.pages,2);assert.deepEqual(paged.seen.map(g=>g.id),all.data.shares.map((g:any)=>g.id));
 assert.deepEqual(all.data.shares.map((g:any)=>g.id),(await owner.query('SELECT id FROM public.doctor_sharing_grants WHERE patient_id=$1 ORDER BY created_at DESC,id DESC',[w.patients.shares])).rows.map(r=>r.id));
 const detail=await call(statusUrl('shares/'+w.grants.active_qr),{token});assert.equal(detail.status,200);assert.deepEqual(Object.keys(detail.data.share).sort(),[...shareKeys,'event_counts','last_event_at'].sort());
 assert.deepEqual(detail.data.share.event_counts,{created:1,opened:1,otp_requested:1,otp_verified:1,authorized:1});assert.ok(detail.data.share.last_event_at);
 assert.deepEqual((await call(statusUrl('shares/'+w.grants.active_link),{token})).data.share.event_counts,{created:1,opened:1,denied:1,otp_failed:2});
 const summary=await call(statusUrl('shares/summary'),{token});assert.equal(summary.status,200);assert.deepEqual(Object.keys(summary.data.summary).sort(),['by_method','by_status','total']);
 const expected=(await owner.query("SELECT CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS status,count(*)::int AS n FROM public.doctor_sharing_grants GROUP BY 1")).rows;
 for(const row of expected)assert.equal(summary.data.summary.by_status[row.status],row.n,row.status);assert.equal(summary.data.summary.total,expected.reduce((n,row)=>n+row.n,0));
 for(const bad of ['status=live','method=email','patient_id=x','status=active&status=expired','doctor_email=a@b.c','limit=x'])assert.equal((await call(list('&'+bad),{token})).status,400,bad);
 assert.equal((await call(statusUrl('shares/'+randomUUID()),{token})).status,404);
 const reads=await audit("action='admin.shares.read' AND actor_admin_id=$1",[a.id]);assert.ok(reads.length>=8&&reads.every(r=>r.target_type==='share_grant'));assert.ok(!JSON.stringify(reads).includes(w.patients.shares));
});

test('P9-30 delivery status: email and guardian-notification states, reasons and counts, with no recipient, payload or kind of notification',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email),w=await buildWorld(),list=(patient:string,extra='')=>statusUrl('deliveries?patient_id='+patient+extra);
 const mail=await call(list(w.patients.mail),{token});assert.equal(mail.status,200);assert.equal(mail.data.deliveries.length,5);
 for(const d of mail.data.deliveries){assert.deepEqual(Object.keys(d).sort(),deliveryKeys);assert.equal(d.channel,'security_email');assert.equal(d.max_attempts,null);}
 const by=Object.fromEntries(mail.data.deliveries.map((d:any)=>[d.id,d]));
 assert.deepEqual([by[w.deliveries.reset_failed].state,by[w.deliveries.reset_failed].failure_reason,by[w.deliveries.reset_failed].attempts,by[w.deliveries.reset_failed].purpose],['permanent_failed','rejected',3,'reset_password']);
 assert.deepEqual([by[w.deliveries.otp_retry].state,by[w.deliveries.otp_retry].failure_reason,by[w.deliveries.otp_retry].purpose],['transient_failed','timeout','doctor_share_otp']);
 assert.ok(by[w.deliveries.verify_delivered].delivered_at);assert.equal(by[w.deliveries.invite_pending].delivered_at,null);
 const notify=await call(list(w.patients.notify),{token});assert.equal(notify.data.deliveries.length,4);
 for(const d of notify.data.deliveries){assert.deepEqual(Object.keys(d).sort(),deliveryKeys);assert.equal(d.channel,'guardian_notification');assert.equal(d.purpose,null);assert.equal(d.max_attempts,3);}
 const nby=Object.fromEntries(notify.data.deliveries.map((d:any)=>[d.id,d]));assert.deepEqual([nby[w.jobs.alert_failed].state,nby[w.jobs.alert_failed].failure_reason,nby[w.jobs.alert_failed].attempts],['permanent_failed','source_denied',3]);
 assert.equal(nby[w.jobs.digest_retry].state,'retry_wait');assert.equal(nby[w.jobs.digest_retry].failure_reason,'transport');assert.ok(nby[w.jobs.digest_delivered].delivered_at);
 const ids=async(patient:string,q:string)=>(await call(list(patient,q),{token})).data.deliveries.map((d:any)=>d.id).sort();
 assert.deepEqual(await ids(w.patients.mail,'&state=permanent_failed'),[w.deliveries.reset_failed]);assert.deepEqual(await ids(w.patients.mail,'&purpose=verify_email'),[w.deliveries.verify_delivered,w.deliveries.verify_sending].sort());
 assert.deepEqual(await ids(w.patients.mail,'&channel=guardian_notification'),[]);assert.deepEqual(await ids(w.patients.notify,'&channel=security_email'),[]);assert.deepEqual(await ids(w.patients.notify,'&state=pending'),[w.jobs.alert_pending]);
 assert.deepEqual(await ids(w.patients.notify,'&state=permanent_failed&channel=guardian_notification'),[w.jobs.alert_failed]);
 const everything=await pageAll(statusUrl('deliveries'),token,'deliveries',4);assert.ok(everything.pages>=3);assert.equal(new Set(everything.seen.map(d=>d.id)).size,everything.seen.length);
 assert.deepEqual(everything.seen.map(d=>d.id),(await owner.query(`SELECT id FROM (SELECT id,created_at FROM public.patient_security_email_deliveries UNION ALL SELECT id,created_at FROM public.guardian_medical_jobs) u ORDER BY created_at DESC,id DESC`)).rows.map(r=>r.id),'both channels interleave newest first');
 const summary=await call(statusUrl('deliveries/summary'),{token});assert.equal(summary.status,200);assert.deepEqual(Object.keys(summary.data.summary).sort(),['by_channel','total']);
 const emailCounts=(await owner.query('SELECT state,count(*)::int AS n FROM public.patient_security_email_deliveries GROUP BY 1')).rows,jobCounts=(await owner.query('SELECT state,count(*)::int AS n FROM public.guardian_medical_jobs GROUP BY 1')).rows;
 for(const row of emailCounts)assert.equal(summary.data.summary.by_channel.security_email[row.state],row.n,row.state);for(const row of jobCounts)assert.equal(summary.data.summary.by_channel.guardian_notification[row.state],row.n,row.state);
 assert.equal(summary.data.summary.total,emailCounts.concat(jobCounts).reduce((n,row)=>n+row.n,0));
 for(const bad of ['channel=sms','state=bogus','purpose=other','patient_id=x','state=pending&state=delivered','kind=serious_alert','recipient=a@b.c','limit=99'])assert.equal((await call(statusUrl('deliveries?'+bad),{token})).status,400,bad);
 const reads=await audit("action='admin.deliveries.read' AND actor_admin_id=$1",[a.id]);assert.ok(reads.length>=10&&reads.every(r=>r.target_type==='delivery'));assert.ok(!JSON.stringify(reads).includes(w.patients.mail)&&!JSON.stringify(reads).includes('permanent_failed'));
});

test('P9-31 no medical field or secret can leak into any status response or audit row',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),w=await buildWorld(),routes=await allStatusRoutes();
 routes.push(statusUrl('guardians?limit=50'),statusUrl('shares?limit=50'),statusUrl('deliveries?limit=50'),statusUrl('shares/'+w.grants.active_link),statusUrl('guardians/'+w.guardians.pending));
 const wire:string[]=[];for(const path of routes){const r=await call(path,{token});assert.equal(r.status,200,path);wire.push(JSON.stringify(r.data));}
 for(const path of [statusUrl('guardians/'+randomUUID()),statusUrl('shares/'+randomUUID())])wire.push(JSON.stringify((await call(path,{token})).data));
 const text=wire.join('\n'),rows=JSON.stringify((await audit('true')).map(({event_hash:_a,prev_hash:_b,id:_c,request_id:_d,...row})=>row));
 const forbidden=[SENTINEL,SENTINEL.toLowerCase(),DOCTOR_NAME,'Dr ',GUARDIAN_EMAIL_TAG,DOCTOR_EMAIL_TAG,'example.invalid/token','482913','one-time code','magic link','serious finding',...Object.values(SECRETS),'9vb29vb29vb2',
  'token_digest','token_hash','doctor_email','"otp"','otp_code','ciphertext','nonce','payload','provider_reference','recipient_hash','content_sha256','policy_sha256','invitation_id','claim_id','definition_sha256','"kind"','serious_alert','routine_digest','"email"','"password"','password_hash','claim_expires_at','verifier','summary_text','document_id','document_name','filename'];
 for(const word of forbidden){assert.ok(!text.includes(word),'a response leaks '+word);assert.ok(!rows.includes(word),'an audit row leaks '+word);}
 const keys=new Set<string>();(function walk(value:unknown){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value)){keys.add(k);walk(v);}})(wire.map(w=>JSON.parse(w)));
 const allowed=new Set([...guardianKeys,...shareKeys,...deliveryKeys,'success','guardians','guardian','shares','share','deliveries','next_cursor','summary','by_status','by_method','by_channel','total','events','event','occurred_at','event_counts','last_event_at','error','code','message',
  ...guardianStatuses_(),...['created','opened','otp_requested','otp_verified','otp_failed','authorized','denied','download','revoked','expiry_denied'],...['security_email','guardian_notification'],...['pending','sending','running','retry_wait','transient_failed','permanent_failed','delivered','expired','superseded','cancelled'],...['active','qr_code','unique_link']]);
 for(const key of keys)assert.ok(allowed.has(key),'unexpected response field '+key);
 const sources=await Promise.all(['status-views.ts'].map(f=>readFile(new URL('../admin/'+f,import.meta.url),'utf8')));const code=sources.join('\n').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 for(const word of ['patient_security_email_payloads','patient_auth_challenges','doctor_otp_challenges','sharing_grant_documents','guardian_medical_items','guardian_medical_events','guardian_rule_results','guardian_routine_sources','guardian_serious_rules','guardian_notification_events','serious_finding_evaluations','token_digest','token_hash','doctor_email','otp_verifier','ciphertext','provider_reference_hash','recipient_hash','content_sha256','policy_sha256','invitation_id','claim_id','medical_documents','extracted_medical_text','ai_report_summaries','email,'])
  assert.ok(!code.includes(word),'status-views.ts must not mention '+word);
 assert.ok(!/\bkind\b/.test(code),'the notification kind (digest or serious alert) is not exposed');
});
function guardianStatuses_(){return ['PENDING','ACTIVE','REVOKED','EXPIRED'];}

test('P9-32 unauthenticated, patient, doctor and forged callers are rejected; each permission is separate; views never change data',async()=>{
 const w=await buildWorld(),patient=await livePatient(),doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex'),routes=await allStatusRoutes();
 const hashes=async()=>(await owner.query(`SELECT (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.guardian_relationships t)||(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.doctor_sharing_grants t)
  ||(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.patient_security_email_deliveries t)||(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.guardian_medical_jobs t)
  ||(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.doctor_share_sessions t) AS h`)).rows[0].h as string;
 const state=await hashes(),auditBefore=await auditCount();
 for(const path of routes)for(const token of [undefined,patient.access,patient.refresh,doctor,'not-a-token'])assert.equal((await call(path,{token})).status,401,path);
 assert.equal(await auditCount(),auditBefore,'rejected callers leave no audit rows');
 const forged=await forge(patientConfig.jwtKey,adminConfig.jwtAudience,randomUUID(),randomUUID());assert.equal((await call(routes[0],{token:forged})).status,401);
 const a=await newAdmin('support_admin'),token=await adminToken(a.email);
 const map:Record<string,string[]>={'admin.guardians.read':routes.slice(0,3),'admin.shares.read':routes.slice(3,6),'admin.deliveries.read':routes.slice(6,8)};
 for(const [permission,paths] of Object.entries(map)){
  await owner.query("DELETE FROM public.admin_role_permissions WHERE role_name='support_admin' AND permission=$1",[permission]);
  try{
   for(const path of paths)assert.equal((await call(path,{token})).status,403,permission+' '+path);
   assert.equal((await audit("action=$1 AND outcome='denied' AND actor_admin_id=$2",[permission,a.id])).length,paths.length);
   for(const [other,otherPaths] of Object.entries(map))if(other!==permission)assert.equal((await call(otherPaths[0],{token})).status,200,'other permissions are unaffected');
  }finally{await owner.query("INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('support_admin',$1)",[permission]);}
 }
 for(const path of routes)assert.equal((await call(path,{token})).status,200,path);
 for(const method of ['POST','PUT','PATCH','DELETE'])for(const path of routes)assert.equal((await call(path,{method,token,body:{status:'REVOKED'}})).status,404,method+' '+path);
 assert.equal(await hashes(),state,'status views and rejected writes changed no guardian, share or delivery row');
 assert.equal((await db.query<{first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0].first_invalid,null);
 void w;
});

// ---- Phase 5: operational settings, release gate and serious-rule versions (M13-005, M13-006, M13-016, M13-017) ----
const settingsUrl=(path='')=>'/api/v1/admin/settings'+path;
const rulesUrl=(path='')=>'/api/v1/admin/rules'+path;
const propose=(key:string,token:string,body:unknown)=>call(settingsUrl('/'+key+'/versions'),{method:'POST',token,body});
const decide=(key:string,version:number,token:string,body:unknown)=>call(settingsUrl('/'+key+'/versions/'+version+'/decision'),{method:'POST',token,body});
const gatedSpecs=settingRegistry.filter(spec=>spec.gate);
const versionRows=async(key:string)=>(await owner.query('SELECT version,value,requires_approval,gate,proposed_by FROM public.admin_setting_versions WHERE setting_key=$1 ORDER BY version',[key])).rows;
const effectiveRow=async(key:string)=>(await owner.query('SELECT version,value FROM public.admin_setting_effective WHERE setting_key=$1',[key])).rows[0];
const settingState=async(token:string,key:string)=>(await call(settingsUrl('/'+key),{token})).data.setting;
function withEnv<T>(vars:Record<string,string|undefined>,fn:()=>T):T{
 const saved:Record<string,string|undefined>={};for(const k of Object.keys(vars))saved[k]=process.env[k];
 try{for(const [k,v] of Object.entries(vars)){if(v===undefined)delete process.env[k];else process.env[k]=v;}return fn();}
 finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
const accepted=(fn:()=>unknown)=>{try{fn();return true;}catch{return false;}};
const SAFE_ENV={DOCUMENT_STORAGE_ENABLED:'false',JWT_SECRET:'0123456789abcdef'.repeat(4),JWT_ALGORITHM:'HS256',JWT_EXPIRES_IN_SECONDS:undefined,AUTH_REFRESH_ABSOLUTE_SECONDS:undefined,AUTH_REFRESH_IDLE_SECONDS:undefined,AUTH_VERIFICATION_SECONDS:undefined,AUTH_RESET_SECONDS:undefined,
 DOCUMENT_MAX_UPLOAD_BYTES:undefined,DOCUMENT_MAX_CONCURRENT_UPLOADS:undefined,DOCUMENT_UPLOAD_RATE_LIMIT_MAX:undefined,DOCUMENT_MAX_PDF_PAGES:undefined};

test('P9-33 the allowlist matches the SRS gates and every bound and default matches the runtime validator it feeds',()=>{
 assert.deepEqual(settingRegistry.map(s=>s.key),['guardian.digest_window_hours','documents.max_upload_bytes','documents.max_concurrent_uploads','documents.upload_rate_limit_max','documents.max_pdf_pages','auth.access_token_seconds','auth.verification_seconds','auth.reset_seconds','auth.refresh_idle_seconds','auth.refresh_absolute_seconds','sharing.otp_seconds']);
 assert.deepEqual(gatedSpecs.map(s=>[s.key,s.gate!.cfg]),[['auth.access_token_seconds','CFG-16'],['auth.verification_seconds','CFG-16'],['auth.reset_seconds','CFG-16'],['auth.refresh_idle_seconds','CFG-16'],['auth.refresh_absolute_seconds','CFG-16'],['sharing.otp_seconds','CFG-04']],'only the security lifetimes whose SRS gate names a security review are gated');
 for(const spec of settingRegistry.filter(s=>!s.gate))assert.ok(['CFG-15','CFG-03'].includes(spec.source),spec.key+' carries no review requirement in the SRS');
 for(const spec of settingRegistry){assert.ok(/^[a-z]+(\.[a-z_]+){1,2}$/.test(spec.key)&&spec.min<=spec.default&&spec.default<=spec.max);assert.ok(!/secret|password|key$|token$|hash|url|bucket|email/.test(spec.key.replace('access_token_seconds','')),spec.key+' is not a secret-like setting');}
 const probes:Record<string,{set:(v:number)=>unknown;read:()=>number}>={
  'guardian.digest_window_hours':{set:v=>guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline',GUARDIAN_DIGEST_SECONDS:String(v*3600)},Buffer.alloc(32,7)),read:()=>guardianNotificationConfig({GUARDIAN_NOTIFICATIONS_MODE:'synthetic-offline'},Buffer.alloc(32,7))!.windowSeconds/3600},
  'sharing.otp_seconds':{set:v=>sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid',SHARING_OTP_SECONDS:String(v)}),read:()=>sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid'})!.otpSeconds},
 };
 const envProbes:Record<string,[string,()=>number,Record<string,string>?]>={
  'documents.max_upload_bytes':['DOCUMENT_MAX_UPLOAD_BYTES',()=>getDocumentConfig().maxFileBytes],'documents.max_concurrent_uploads':['DOCUMENT_MAX_CONCURRENT_UPLOADS',()=>getDocumentConfig().maxConcurrentUploads],
  'documents.upload_rate_limit_max':['DOCUMENT_UPLOAD_RATE_LIMIT_MAX',()=>getDocumentConfig().uploadRateLimitMax],'documents.max_pdf_pages':['DOCUMENT_MAX_PDF_PAGES',()=>getDocumentConfig().maxPdfPages],
  'auth.access_token_seconds':['JWT_EXPIRES_IN_SECONDS',()=>getAuthenticationConfig().jwtLifetimeSeconds],'auth.verification_seconds':['AUTH_VERIFICATION_SECONDS',()=>runtimeSecurityPolicy().verificationSeconds],'auth.reset_seconds':['AUTH_RESET_SECONDS',()=>runtimeSecurityPolicy().resetSeconds],
  'auth.refresh_idle_seconds':['AUTH_REFRESH_IDLE_SECONDS',()=>runtimeSecurityPolicy().refreshIdleSeconds,{AUTH_REFRESH_ABSOLUTE_SECONDS:'2592000'}],
  'auth.refresh_absolute_seconds':['AUTH_REFRESH_ABSOLUTE_SECONDS',()=>runtimeSecurityPolicy().refreshAbsoluteSeconds,{AUTH_REFRESH_IDLE_SECONDS:'60'}],
 };
 for(const spec of settingRegistry){
  if(probes[spec.key]){const probe=probes[spec.key];
   assert.equal(probe.read(),spec.default,spec.key+' default');assert.ok(accepted(()=>probe.set(spec.min))&&accepted(()=>probe.set(spec.max)),spec.key+' bounds accepted');assert.ok(!accepted(()=>probe.set(spec.min-1))&&!accepted(()=>probe.set(spec.max+1)),spec.key+' bounds are tight');continue;}
  const [name,read,extra={}]=envProbes[spec.key];
  withEnv({...SAFE_ENV,...extra},()=>{
   assert.equal(read(),spec.default,spec.key+' default');
   for(const [value,ok] of [[spec.min,true],[spec.max,true],[spec.min-1,false],[spec.max+1,false]] as const)
    assert.equal(accepted(()=>withEnv({[name]:String(value)},read)),ok,spec.key+' '+value);
  });
 }
});

test('P9-34 the settings list shows every approved key with its default, effective value, bounds and visible release gate',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email),list=await call(settingsUrl(),{token});
 assert.equal(list.status,200);assert.deepEqual(list.data.settings.map((s:any)=>s.key),settingRegistry.map(s=>s.key));
 for(const s of list.data.settings){assert.deepEqual(Object.keys(s).sort(),['default','gate','key','max','min','pending_versions','source','unit','value','version']);}
 const by=Object.fromEntries(list.data.settings.map((s:any)=>[s.key,s]));
 assert.deepEqual(by['auth.reset_seconds'].gate,{cfg:'CFG-16',requirement:'Security review and negative-path tests required before release.'});assert.equal(by['sharing.otp_seconds'].gate.cfg,'CFG-04');
 assert.equal(by['guardian.digest_window_hours'].gate,null);assert.equal(by['documents.max_upload_bytes'].gate,null);
 const detail=await call(settingsUrl('/auth.verification_seconds'),{token});assert.equal(detail.status,200);assert.deepEqual(detail.data.setting.history,[]);assert.equal(detail.data.setting.value,86400);assert.equal(detail.data.setting.version,0);
 for(const bad of ['/auth.jwt_secret','/NOT-A-KEY','/'+'a'.repeat(80)])assert.equal((await call(settingsUrl(bad),{token})).status,404,bad);
 assert.equal((await audit("action='admin.settings.read' AND outcome='failure' AND actor_admin_id=$1",[a.id])).length,3);
 assert.equal((await call(settingsUrl('?x=1'),{token})).status,400);
});

test('P9-35 an ungated change takes effect at once, is versioned and audited in the same transaction, and history is never overwritten',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),key='guardian.digest_window_hours';
 const first=await propose(key,token,{value:48});assert.equal(first.status,201);assert.equal(first.data.status,'effective');assert.equal(first.data.version,1);assert.equal(first.data.setting.value,48);
 assert.deepEqual(await effectiveRow(key),{version:1,value:48});
 const second=await propose(key,token,{value:12});assert.equal(second.status,201);assert.equal(second.data.version,2);assert.equal(second.data.setting.value,12);
 const rows=await versionRows(key);assert.deepEqual(rows.map(r=>[r.version,Number(r.value),r.requires_approval,r.gate]),[[1,48,false,null],[2,12,false,null]],'both versions are kept');
 const detail=await settingState(token,key);assert.deepEqual(detail.history.map((h:any)=>[h.version,h.value,h.status]),[[2,12,'effective'],[1,48,'superseded']]);assert.ok(detail.history.every((h:any)=>h.proposed_by===a.id&&h.decision===null));
 const events=await audit("action='admin.settings.change' AND target_id=$1 AND outcome='success'",[key]);assert.equal(events.length,2);assert.deepEqual(events[1].scope,{version:2,previous:48,value:12,gate:null,status:'effective'});assert.deepEqual(events[0].scope,{version:1,previous:24,value:48,gate:null,status:'effective'});assert.equal(events[0].actor_admin_id,a.id);
 const same=await propose(key,token,{value:12});assert.equal(same.status,409);assert.equal(same.data.error.code,'SETTING_UNCHANGED');assert.equal((await versionRows(key)).length,2);assert.equal((await audit("action='admin.settings.change' AND target_id=$1 AND outcome='failure'",[key]))[0].scope.reason,'unchanged');
 assert.equal((await propose('documents.max_pdf_pages',token,{value:100})).status,409,'the default counts as the value in effect');
 for(const sql of ["UPDATE public.admin_setting_versions SET value='1'::jsonb","DELETE FROM public.admin_setting_versions"]){
  await assert.rejects(db.query(sql),sqlState('42501'));await assert.rejects(owner.query(sql),(e:unknown)=>sqlState('42501')(e)&&/append-only/.test((e as Error).message),'even the owner cannot rewrite history: '+sql);
 }
 await assert.rejects(db.query('TRUNCATE public.admin_setting_versions'),sqlState('42501'));await assert.rejects(owner.query('TRUNCATE public.admin_setting_versions'),'the owner cannot truncate history either (the foreign key from decisions already forbids it)');
 await assert.rejects(db.query("INSERT INTO public.admin_setting_versions(setting_key,version,value,requires_approval,proposed_by,proposed_at) VALUES('documents.max_pdf_pages',1,'5'::jsonb,false,$1,'2001-01-01')",[a.id]),sqlState('42501'));
 await assert.rejects(owner.query("INSERT INTO public.admin_setting_versions(setting_key,version,value,requires_approval,proposed_by) VALUES('documents.max_pdf_pages',7,'5'::jsonb,false,$1)",[a.id]),sqlState('23514'),'versions must be consecutive');
 await assert.rejects(owner.query("INSERT INTO public.admin_setting_versions(setting_key,version,value,requires_approval,gate,proposed_by) VALUES('documents.max_pdf_pages',1,'5'::jsonb,true,NULL,$1)",[a.id]),sqlState('23514'));
 await assert.rejects(owner.query("INSERT INTO public.admin_setting_versions(setting_key,version,value,requires_approval,proposed_by) VALUES('documents.max_pdf_pages',1,'\"text\"'::jsonb,false,$1)",[a.id]),sqlState('23514'));
 // Same-transaction audit: when the audit write fails, no version is stored and nothing takes effect.
 const before=await versionRows('documents.max_pdf_pages');
 await owner.query("ALTER TABLE public.admin_audit_events ADD CONSTRAINT p9_block_setting CHECK(action<>'admin.settings.change') NOT VALID");
 try{assert.equal((await propose('documents.max_pdf_pages',token,{value:50})).status,500);}finally{await owner.query('ALTER TABLE public.admin_audit_events DROP CONSTRAINT p9_block_setting');}
 assert.deepEqual(await versionRows('documents.max_pdf_pages'),before);assert.equal(await effectiveRow('documents.max_pdf_pages'),undefined);
 assert.equal((await propose('documents.max_pdf_pages',token,{value:50})).status,201,'the same change works once auditing works');
 const other=await adminToken((await newAdmin('operations_admin')).email),race=await Promise.all([propose('documents.max_upload_bytes',token,{value:1048576}),propose('documents.max_upload_bytes',other,{value:2097152})]);
 assert.deepEqual(race.map(r=>r.status),[201,201]);assert.deepEqual((await versionRows('documents.max_upload_bytes')).map(r=>r.version),[1,2],'simultaneous changes get consecutive versions');
});

test('P9-36 keys outside the allowlist and invalid values are refused and audited, and nothing is stored',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),total=async()=>Number((await owner.query('SELECT count(*) FROM public.admin_setting_versions')).rows[0].count);
 const before=await total(),key='documents.max_concurrent_uploads';
 for(const outside of ['auth.jwt_secret','admin.jwt_secret','database.password','documents.bucket_name','auth.password_hash','guardian.digest_window_seconds','sharing.public_origin','admin.rate_limit.max','a.b'])
  {const r=await propose(outside,token,{value:1});assert.equal(r.status,403,outside);assert.equal(r.data.error.code,'SETTING_NOT_PERMITTED');
   const [event]=await audit("action='admin.settings.change' AND outcome='denied' AND target_id=$1 AND actor_admin_id=$2",[outside,a.id]);assert.ok(event,'no audit row for '+outside);assert.equal(event.scope.reason,'not_in_allowlist',outside);}
 for(const malformed of ['documents.s3_bucket','AUTH.RESET','auth..reset','x'.repeat(65),'auth.reset%20seconds','..%2F..%2Fetc%2Fpasswd'])
  {const r=await propose(malformed,token,{value:1});assert.equal(r.status,403,malformed);}
 const malformedRows=await audit("action='admin.settings.change' AND outcome='denied' AND scope->>'reason'='malformed_key' AND actor_admin_id=$1",[a.id]);assert.equal(malformedRows.length,6);assert.ok(malformedRows.every(r=>r.target_id===null),'malformed key text is never copied into the audit log');
 assert.equal((await decide('auth.jwt_secret',1,token,{decision:'approved',reference:'REV-1'})).status,403);
 const spec=settingRegistry.find(s=>s.key===key)!;
 for(const value of ['3',3.5,null,true,[3],{n:3},spec.min-1,spec.max+1,-1,0,Number.MAX_SAFE_INTEGER,1e21,'abc'])
  {const r=await propose(key,token,{value});assert.equal(r.status,400,JSON.stringify(value));assert.equal(r.data.error.code,'INVALID_SETTING_VALUE'===r.data.error.code?'INVALID_SETTING_VALUE':r.data.error.code);}
 for(const body of [{},{value:3,extra:1},{val:3},[3],'3',null])assert.equal((await propose(key,token,body)).status,400,JSON.stringify(body));
 assert.equal((await call(settingsUrl('/'+key+'/versions?x=1'),{method:'POST',token,body:{value:3}})).status,400);
 assert.equal((await call(settingsUrl('/'+key+'/versions'),{method:'POST',token,headers:{'Content-Type':'text/plain'}})).status,415);
 assert.equal(await total(),before,'no refused change stored a version');assert.equal(await effectiveRow(key),undefined);
 assert.ok((await audit("action='admin.settings.change' AND outcome='failure' AND target_id=$1 AND scope->>'reason'='invalid_value'",[key])).length>=13,'invalid values are audited');
 // idle refresh lifetime may not exceed the absolute one (checked against values in effect)
 const approver=await adminToken((await newAdmin('config_admin')).email),ok=async(k:string,v:number)=>{const p=await propose(k,token,{value:v});assert.equal(p.status,201,k);assert.equal((await decide(k,p.data.version,approver,{decision:'approved',reference:'REV-'+v})).status,200,k);};
 await ok('auth.refresh_idle_seconds',60000);await ok('auth.refresh_absolute_seconds',100000);
 const tooLong=await propose('auth.refresh_idle_seconds',token,{value:200000});assert.equal(tooLong.status,400);assert.match(tooLong.data.error.message,/idle refresh lifetime/);
 const tooShort=await propose('auth.refresh_absolute_seconds',token,{value:50000});assert.equal(tooShort.status,400);
 assert.equal((await versionRows('auth.refresh_idle_seconds')).length,1);
});

test('P9-37 a gated setting cannot change without a recorded approval from a different admin',async()=>{
 const proposer=await newAdmin('support_admin'),pToken=await adminToken(proposer.email),reviewer=await newAdmin('config_admin'),rToken=await adminToken(reviewer.email),key='auth.reset_seconds';
 const pending=await propose(key,pToken,{value:600});assert.equal(pending.status,201);assert.equal(pending.data.status,'pending_approval');assert.equal(pending.data.setting.value,900,'the value in effect is unchanged');assert.equal(pending.data.setting.version,0);assert.equal(pending.data.setting.pending_versions,1);
 assert.equal(await effectiveRow(key),undefined);assert.deepEqual((await versionRows(key)).map(r=>[r.version,r.requires_approval,r.gate]),[[1,true,'CFG-16']]);
 const own=await decide(key,1,pToken,{decision:'approved',reference:'SELF-1'});assert.equal(own.status,403);assert.equal(own.data.error.code,'SELF_APPROVAL_FORBIDDEN');
 assert.equal((await audit("action='admin.settings.decide' AND outcome='denied' AND actor_admin_id=$1",[proposer.id]))[0].scope.reason,'self_approval');assert.equal(await effectiveRow(key),undefined);
 assert.equal(Number((await owner.query('SELECT count(*) FROM public.admin_setting_decisions d JOIN public.admin_setting_versions v ON v.id=d.version_id WHERE v.setting_key=$1',[key])).rows[0].count),0);
 const versionId=(await owner.query('SELECT id FROM public.admin_setting_versions WHERE setting_key=$1 AND version=1',[key])).rows[0].id;
 await assert.rejects(db.query("INSERT INTO public.admin_setting_decisions(version_id,decision,decided_by,reference) VALUES($1,'approved',$2,'DB-SELF')",[versionId,proposer.id]),(e:unknown)=>sqlState('42501')(e)&&/cannot be approved by the admin who proposed/.test((e as Error).message),'the database refuses self-approval even without the API');
 await assert.rejects(owner.query("INSERT INTO public.admin_setting_decisions(version_id,decision,decided_by,reference) VALUES($1,'approved',$2,'DB-SELF')",[versionId,proposer.id]),sqlState('42501'));
 for(const body of [{decision:'approved'},{reference:'REV-1'},{decision:'maybe',reference:'REV-1'},{decision:'approved',reference:''},{decision:'approved',reference:'<script>'},{decision:'approved',reference:'x'.repeat(121)},{decision:'approved',reference:'REV-1',approved_by:reviewer.id},{decision:'approved',reference:'REV-1',decided_by:reviewer.id},null,[]])
  assert.equal((await decide(key,1,rToken,body)).status,400,JSON.stringify(body));
 assert.equal((await decide(key,99,rToken,{decision:'approved',reference:'REV-1'})).status,404);assert.equal((await decide(key,0,rToken,{decision:'approved',reference:'REV-1'})).status,400);
 const approved=await decide(key,1,rToken,{decision:'approved',reference:'SEC-REVIEW-2031-04'});assert.equal(approved.status,200);assert.equal(approved.data.setting.value,600);assert.equal(approved.data.setting.version,1);assert.deepEqual(await effectiveRow(key),{version:1,value:600});
 const h=approved.data.setting.history[0];assert.equal(h.status,'effective');assert.deepEqual([h.decision.decision,h.decision.decided_by,h.decision.reference,h.proposed_by],['approved',reviewer.id,'SEC-REVIEW-2031-04',proposer.id]);
 assert.deepEqual((await audit("action='admin.settings.decide' AND outcome='success' AND actor_admin_id=$1",[reviewer.id]))[0].scope,{version:1,decision:'approved',gate:'CFG-16'});
 assert.equal((await decide(key,1,rToken,{decision:'rejected',reference:'LATE-1'})).status,409,'one decision per version');
 await assert.rejects(owner.query("UPDATE public.admin_setting_decisions SET decision='rejected'"),sqlState('42501'));await assert.rejects(db.query('DELETE FROM public.admin_setting_decisions'),sqlState('42501'));
 // rejection leaves the approved value in place
 const second=await propose(key,pToken,{value:300});assert.equal(second.data.version,2);
 const rejected=await decide(key,2,rToken,{decision:'rejected',reference:'SEC-REVIEW-REJECT'});assert.equal(rejected.status,200);
 assert.equal((await settingState(rToken,key)).value,600);assert.deepEqual((await settingState(rToken,key)).history.map((x:any)=>[x.version,x.status]),[[2,'rejected'],[1,'effective']]);
 // a proposer may withdraw (reject) their own pending change, but cannot approve it
 const own3=await propose(key,pToken,{value:420});assert.equal((await decide(key,3,pToken,{decision:'rejected',reference:'WITHDRAWN'})).status,200);
 void own3;
 // a version that is not gated cannot take a decision
 const free=await propose('documents.max_pdf_pages',pToken,{value:60});assert.equal(free.status,201);const notReq=await decide('documents.max_pdf_pages',free.data.version,rToken,{decision:'approved',reference:'NA-1'});assert.equal(notReq.status,409);assert.equal(notReq.data.error.code,'APPROVAL_NOT_REQUIRED');
 // an older pending version cannot be approved once a newer one is in effect
 const k2='sharing.otp_seconds',v1=await propose(k2,pToken,{value:300}),v2=await propose(k2,pToken,{value:200});assert.deepEqual([v1.data.version,v2.data.version],[1,2]);
 assert.equal((await decide(k2,2,rToken,{decision:'approved',reference:'CFG-04-REVIEW'})).status,200);const stale=await decide(k2,1,rToken,{decision:'approved',reference:'CFG-04-OLD'});assert.equal(stale.status,409);assert.equal(stale.data.error.code,'VERSION_SUPERSEDED');assert.equal((await effectiveRow(k2)).version,2);
 // two reviewers deciding at once: exactly one decision is recorded
 const r2=await adminToken((await newAdmin('operations_admin')).email),k3='auth.verification_seconds',p3=await propose(k3,pToken,{value:3600});
 const both=await Promise.all([decide(k3,p3.data.version,rToken,{decision:'approved',reference:'A-1'}),decide(k3,p3.data.version,r2,{decision:'approved',reference:'B-1'})]);assert.deepEqual(both.map(r=>r.status).sort(),[200,409]);
 assert.equal(Number((await owner.query('SELECT count(*) FROM public.admin_setting_decisions d JOIN public.admin_setting_versions v ON v.id=d.version_id WHERE v.setting_key=$1',[k3])).rows[0].count),1);
 const chain=(await db.query<{first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0];assert.equal(chain.first_invalid,null);
});

test('P9-38 serious-rule versions are append-only records that an admin can create and view but never mark clinically approved',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email),definition={field:'Marker One',units:'units/L',operator:'between',bounds:[2,9.5],context:{age:'adult'}};
 const guardianRulesBefore=Number((await owner.query('SELECT count(*) FROM public.guardian_serious_rules')).rows[0].count);
 const v1=await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_ALPHA',definition}});assert.equal(v1.status,201);
 const rule=v1.data.rule;assert.deepEqual(Object.keys(rule).sort(),['clinical_approval','created_at','created_by','definition','definition_sha256','id','rule_id','version']);
 assert.equal(rule.version,1);assert.equal(rule.clinical_approval,'not_clinically_approved');assert.equal(rule.created_by,a.id);assert.deepEqual(rule.definition,definition);
 assert.equal(rule.definition_sha256,(await owner.query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS h",[JSON.stringify(definition)])).rows[0].h,'the digest is computed by the database');
 const v2=await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_ALPHA',definition:{...definition,bounds:[3,9]}}});assert.equal(v2.data.rule.version,2);assert.notEqual(v2.data.rule.definition_sha256,rule.definition_sha256);
 const other=await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_BETA',definition:{field:'Marker Two',units:'%',operator:'gt',bounds:[7],context:{}}}});assert.equal(other.data.rule.version,1);
 const race=await Promise.all([1,2,3].map(n=>call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_RACE',definition:{...definition,bounds:[n,n+5]}}})));assert.deepEqual(race.map(r=>r.status),[201,201,201]);assert.deepEqual(race.map(r=>r.data.rule.version).sort(),[1,2,3]);
 const alpha=await call(rulesUrl('?rule_id=RULE_ALPHA'),{token});assert.deepEqual(alpha.data.rules.map((r:any)=>r.version),[2,1],'both versions are kept, newest first');
 const paged=await pageAll(rulesUrl(),token,'rules',2);assert.ok(paged.pages>=3);assert.equal(new Set(paged.seen.map(r=>r.id)).size,paged.seen.length);
 assert.equal((await call(rulesUrl('/'+rule.id),{token})).data.rule.rule_id,'RULE_ALPHA');assert.equal((await call(rulesUrl('/'+randomUUID()),{token})).status,404);
 for(const bad of ['?rule_id=lower','?x=1','?limit=0','?rule_id=RULE_ALPHA&rule_id=RULE_BETA'])assert.equal((await call(rulesUrl(bad),{token})).status,400,bad);
 const stored=async()=>Number((await owner.query('SELECT count(*) FROM public.admin_serious_rule_versions')).rows[0].count),count=await stored();
 const approvalAttempts:Array<Record<string,unknown>>=[{approved:true},{clinical_approval:'clinically_approved'},{clinically_approved:true},{approval_status:'clinically_approved'},{approval_metadata:{qualified_approver:'x',approval_reference:'y'}},{status:'approved'},{validated:true},{reviewed_by:a.id},{qualified_approver:'Dr X'},{certified:true},{clinical_status:'approved'},{signed_off:true}];
 for(const extra of approvalAttempts){const r=await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_GAMMA',definition,...extra}});assert.equal(r.status,403,JSON.stringify(extra));assert.equal(r.data.error.code,'CLINICAL_APPROVAL_FORBIDDEN');}
 for(const nested of [{approval:{status:'clinically_approved'}},{clinical_approval:'approved'},{approved:true},{status:'x'}]){const r=await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_GAMMA',definition:{...definition,...nested}}});assert.equal(r.status,403,JSON.stringify(nested));}
 assert.equal(await stored(),count,'no attempt stored a rule');assert.equal((await audit("action='admin.rules.create' AND outcome='denied' AND actor_admin_id=$1",[a.id])).length,approvalAttempts.length+4);
 assert.ok((await audit("action='admin.rules.create' AND outcome='denied'")).every(r=>r.scope.reason==='clinical_approval_not_permitted'));
 const invalidRules:unknown[]=[{rule_id:'lower',definition},{rule_id:'RULE_X',definition:{...definition,operator:'near'}},{rule_id:'RULE_X',definition:{...definition,bounds:[9,2]}},{rule_id:'RULE_X',definition:{...definition,bounds:[1]}},{rule_id:'RULE_X',definition:{...definition,operator:'gt',bounds:[1,2]}},
  {rule_id:'RULE_X',definition:{...definition,bounds:[1e9,2e9]}},{rule_id:'RULE_X',definition:{...definition,units:'<b>'}},{rule_id:'RULE_X',definition:{...definition,field:''}},{rule_id:'RULE_X',definition:{...definition,context:{a:1}}},{rule_id:'RULE_X',definition:{...definition,context:Object.fromEntries(Array.from({length:6},(_,i)=>['k'+i,'v']))}},
  {rule_id:'RULE_X',definition:{field:'F',units:'u'}},{rule_id:'RULE_X',definition:{...definition,note:'free text'}},{rule_id:'RULE_X'},{definition},{rule_id:'RULE_X',definition:'x'},[],null];
 for(const body of invalidRules)assert.equal((await call(rulesUrl(),{method:'POST',token,body})).status,400,JSON.stringify(body));assert.equal(await stored(),count);
 await assert.rejects(owner.query("INSERT INTO public.admin_serious_rule_versions(rule_id,version,definition,created_by,clinical_approval) VALUES('RULE_DELTA',1,'{}'::jsonb,$1,'clinically_approved')",[a.id]),sqlState('23514'),'no value but not_clinically_approved is representable');
 await assert.rejects(db.query("INSERT INTO public.admin_serious_rule_versions(rule_id,version,definition,created_by,clinical_approval) VALUES('RULE_DELTA',1,'{}'::jsonb,$1,'not_clinically_approved')",[a.id]),sqlState('42501'),'the API role cannot even name the column');
 await assert.rejects(db.query("INSERT INTO public.admin_serious_rule_versions(rule_id,version,definition,created_by,definition_sha256) VALUES('RULE_DELTA',1,'{}'::jsonb,$1,$2)",[a.id,'0'.repeat(64)]),sqlState('42501'));
 for(const sql of ["UPDATE public.admin_serious_rule_versions SET definition='{}'::jsonb","DELETE FROM public.admin_serious_rule_versions","TRUNCATE public.admin_serious_rule_versions"]){await assert.rejects(db.query(sql),sqlState('42501'));await assert.rejects(owner.query(sql),(e:unknown)=>sqlState('42501')(e)&&/append-only/.test((e as Error).message));}
 assert.equal(Number((await owner.query('SELECT count(*) FROM public.guardian_serious_rules')).rows[0].count),guardianRulesBefore,'editing never reaches the rules the guardian service evaluates');
 assert.deepEqual((await owner.query("SELECT DISTINCT clinical_approval FROM public.admin_serious_rule_versions")).rows.map(r=>r.clinical_approval),['not_clinically_approved']);
 assert.equal((await audit("action='admin.rules.create' AND outcome='success' AND actor_admin_id=$1",[a.id])).length,await stored());
 assert.deepEqual((await audit("action='admin.rules.create' AND outcome='success' AND target_id=$1",[rule.id]))[0].scope,{rule_id:'RULE_ALPHA',version:1,clinical_approval:'not_clinically_approved'});
 await owner.query("ALTER TABLE public.admin_audit_events ADD CONSTRAINT p9_block_rule CHECK(action<>'admin.rules.create') NOT VALID");
 try{assert.equal((await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_ATOMIC',definition}})).status,500);}finally{await owner.query('ALTER TABLE public.admin_audit_events DROP CONSTRAINT p9_block_rule');}
 assert.equal(Number((await owner.query("SELECT count(*) FROM public.admin_serious_rule_versions WHERE rule_id='RULE_ATOMIC'")).rows[0].count),0,'a failed audit write rolls the rule back');
});

test('P9-39 configuration endpoints reject non-admin callers, enforce each permission, and no response or audit row contains a secret',async()=>{
 const patient=await livePatient(),doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex'),someId=randomUUID();
 const routes:Array<[string,string,unknown]>=[['GET',settingsUrl(),undefined],['GET',settingsUrl('/auth.reset_seconds'),undefined],['POST',settingsUrl('/documents.max_pdf_pages/versions'),{value:10}],['POST',settingsUrl('/auth.reset_seconds/versions/1/decision'),{decision:'approved',reference:'X-1'}],
  ['GET',rulesUrl(),undefined],['GET',rulesUrl('/'+someId),undefined],['POST',rulesUrl(),{rule_id:'RULE_ZZZ',definition:{field:'F',units:'u',operator:'gt',bounds:[1],context:{}}}]];
 const settingsBefore=Number((await owner.query('SELECT count(*) FROM public.admin_setting_versions')).rows[0].count),rulesBefore=Number((await owner.query('SELECT count(*) FROM public.admin_serious_rule_versions')).rows[0].count),auditBefore=await auditCount();
 const forgedKey=await forge(patientConfig.jwtKey,adminConfig.jwtAudience,randomUUID(),randomUUID());
 for(const [method,path,body] of routes)for(const token of [undefined,patient.access,patient.refresh,doctor,forgedKey,'not-a-token'])assert.equal((await call(path,{method,token,body})).status,401,method+' '+path);
 assert.equal(await auditCount(),auditBefore,'rejected callers leave no audit rows');assert.equal(Number((await owner.query('SELECT count(*) FROM public.admin_setting_versions')).rows[0].count),settingsBefore);assert.equal(Number((await owner.query('SELECT count(*) FROM public.admin_serious_rule_versions')).rows[0].count),rulesBefore);
 const a=await newAdmin('support_admin'),token=await adminToken(a.email);
 const map:Record<string,Array<[string,string,unknown]>>={'admin.settings.read':routes.slice(0,2),'admin.settings.change':[routes[2]],'admin.settings.approve':[routes[3]],'admin.rules.read':routes.slice(4,6),'admin.rules.create':[routes[6]]};
 for(const [permission,targets] of Object.entries(map)){
  await owner.query("DELETE FROM public.admin_role_permissions WHERE role_name='support_admin' AND permission=$1",[permission]);
  try{
   for(const [method,path,body] of targets)assert.equal((await call(path,{method,token,body})).status,403,permission+' '+path);
   assert.equal((await audit("action=$1 AND outcome='denied' AND actor_admin_id=$2",[permission,a.id])).length,targets.length,permission);
  }finally{await owner.query("INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('support_admin',$1)",[permission]);}
 }
 for(const method of ['PUT','PATCH','DELETE'])for(const path of [settingsUrl('/documents.max_pdf_pages'),settingsUrl('/documents.max_pdf_pages/versions/1'),rulesUrl('/'+someId),rulesUrl()])assert.equal((await call(path,{method,token,body:{value:1}})).status,404,method+' '+path);
 // exercise every endpoint, then look for secrets in every response and audit row
 const approver=await adminToken((await newAdmin('config_admin')).email),wire:string[]=[];
 const keep=(r:{data:unknown})=>{wire.push(JSON.stringify(r.data));return r;};
 keep(await call(settingsUrl(),{token}));keep(await call(settingsUrl('/auth.reset_seconds'),{token}));keep(await propose('auth.access_token_seconds',token,{value:600}));keep(await propose('auth.jwt_secret',token,{value:1}));keep(await propose('documents.max_pdf_pages',token,{value:'x'}));
 keep(await decide('auth.access_token_seconds',1,token,{decision:'approved',reference:'SELF'}));keep(await decide('auth.access_token_seconds',1,approver,{decision:'approved',reference:'SEC-OK-1'}));
 keep(await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_LEAK',definition:{field:'F',units:'u',operator:'gt',bounds:[1],context:{}}}}));keep(await call(rulesUrl(),{method:'POST',token,body:{rule_id:'RULE_LEAK',definition:{field:'F',units:'u',operator:'gt',bounds:[1],context:{}},approved:true}}));keep(await call(rulesUrl(),{token}));
 const text=wire.join('\n'),rows=JSON.stringify(await audit('true')),secrets=[process.env.JWT_SECRET,process.env.ADMIN_JWT_SECRET,process.env.DB_PASSWORD,process.env.MIGRATION_DB_PASSWORD,process.env.AWS_SECRET_ACCESS_KEY,process.env.AWS_ACCESS_KEY_ID,Buffer.from(adminConfig.jwtKey).toString('hex'),Buffer.from(patientConfig.jwtKey).toString('hex'),adminPassword,patientPassword,token,approver,patient.access,patient.refresh].filter((v):v is string=>!!v&&v.length>=8);
 assert.ok(secrets.length>=8);for(const secret of secrets){assert.ok(!text.includes(secret),'a response contains a secret');assert.ok(!rows.includes(secret),'an audit row contains a secret');}
 for(const word of ['"password"','$argon2','"access_token"','"refresh_token"','token_hash','JWT_','DB_PASSWORD'])assert.ok(!text.includes(word),'a response mentions '+word);
 const keys=new Set<string>();(function walk(value:unknown){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value)){keys.add(k);walk(v);}})(wire.map(w=>JSON.parse(w)));
 const allowed=new Set(['success','settings','setting','key','unit','min','max','default','source','gate','cfg','requirement','value','version','pending_versions','history','status','requires_approval','proposed_by','proposed_at','decision','decided_by','reference','decided_at','rules','rule','id','rule_id','definition','field','units','operator','bounds','context','definition_sha256','clinical_approval','created_by','created_at','next_cursor','error','code','message','age']);
 for(const key of keys)assert.ok(allowed.has(key),'unexpected response field '+key);
 const code=(await Promise.all(['settings.ts','rules.ts','config-routes.ts'].map(f=>readFile(new URL('../admin/'+f,import.meta.url),'utf8')))).join('\n').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 for(const word of ['process.env','JWT_SECRET','DB_PASSWORD','password_hash','guardian_serious_rules','approval_status','approval_metadata'])assert.ok(!code.includes(word),'configuration code must not mention '+word);
 assert.ok(!/(?<!not_)clinically_approved/.test(code),'configuration code never writes a clinical approval value');
});

// ---- Phase 6: system health and audit review (M13-007, M13-018, audit parts of M13-008 and M13-019) ----
const healthUrl='/api/v1/admin/health',auditUrl=(query='')=>'/api/v1/admin/audit'+query;
const SERVICE_TOKEN='SERVICE-TOKEN-SENTINEL-4471',HEX64=/\b[a-f0-9]{64}\b/;
async function stubService(handler:(req:IncomingMessage)=>Promise<number>|number){
 const received:Array<{url:string;authorization?:string}>=[];
 const server:Server=createServer(async(req,res)=>{received.push({url:req.url??'',authorization:req.headers.authorization});const code=await handler(req);res.writeHead(code,{'Content-Type':'application/json'});res.end('{"detail":"LEAKSENTINEL service body"}');});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 return {server,received,port:address.port,origin:'http://127.0.0.1:'+address.port,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
async function expectedLedger(){
 const dir=new URL('../../migrations/',import.meta.url),names=(await readdir(dir)).filter(f=>/^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
 return Promise.all(names.map(async name=>({version:name.slice(0,4),name,checksum:createHash('sha256').update(await readFile(new URL(name,dir),'utf8')).digest('hex')})));
}
async function installLedger(rows:Array<{version:string;name:string;checksum:string}>){
 await owner.query('DROP TABLE IF EXISTS public.schema_migrations');
 await owner.query(`CREATE TABLE public.schema_migrations(version TEXT PRIMARY KEY CHECK(version ~ '^[0-9]{4}$'),name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 for(const row of rows)await owner.query('INSERT INTO public.schema_migrations(version,name,checksum) VALUES($1,$2,$3)',[row.version,row.name,row.checksum]);
}
async function resetQueues(){
 await staged(async c=>{for(const table of ['document_processing_jobs','patient_security_email_payloads','patient_security_email_deliveries','guardian_medical_events','guardian_medical_items','guardian_rule_results','guardian_routine_sources','guardian_medical_jobs'])await c.query('DELETE FROM public.'+table);});
}
const component=(r:{data:any},name:string)=>r.data.health.components.find((c:any)=>c.name===name);
async function queueRows(patient:string,spec:{job?:'expired'|'stale'|'failed';mail?:'overdue'|'claim'|'failed';notify?:'overdue'|'failed'}){
 if(spec.job==='expired')await jobFixture(patient,{state:'running',lease:'expired',sentinel:true});
 if(spec.job==='failed')await jobFixture(patient,{sentinel:true});
 if(spec.job==='stale'){const id=await jobFixture(patient,{state:'pending',attempts:0,code:null,sentinel:true});await staged(async c=>{await c.query("UPDATE public.document_processing_jobs SET next_attempt_at=clock_timestamp()-interval '20 minutes' WHERE document_id=$1",[id]);});}
 await staged(async c=>{
  if(spec.mail){const id=randomUUID(),state=spec.mail==='overdue'?'pending':spec.mail==='claim'?'sending':'permanent_failed';
   await c.query(`INSERT INTO public.patient_security_email_deliveries(id,challenge_id,patient_id,purpose,state,attempts,claim_id,claim_expires_at,next_attempt_at,failure_category)
    VALUES($1,$2,$3,'verify_email',$4,1,$5,$6,clock_timestamp()${spec.mail==='overdue'?"-interval '1 hour'":''},$7)`,[id,randomUUID(),patient,state,spec.mail==='claim'?randomUUID():null,spec.mail==='claim'?new Date(Date.now()-60000):null,spec.mail==='failed'?'rejected':null]);}
  if(spec.notify){const id=randomUUID();
   await c.query(`INSERT INTO public.guardian_medical_jobs(id,patient_id,relationship_id,recipient_hash,patient_security_version,kind,policy_sha256,not_before,state,attempts,max_attempts,next_attempt_at,failure_code)
    VALUES($1,$2,$3,$4,1,'serious_alert',$5,clock_timestamp()-interval '2 hours',$6,1,3,clock_timestamp()${spec.notify==='overdue'?"-interval '1 hour'":''},$7)`,[id,patient,randomUUID(),SECRETS.recipient,SECRETS.policy,spec.notify==='overdue'?'retry_wait':'permanent_failed',spec.notify==='failed'?'transport':null]);}
 });
}

test('P9-40 health reports each failed or degraded component correctly and every report is free of secrets, addresses and patient content',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),patient=await seedPatient('Health Owner '+SENTINEL,'health-'+randomUUID()+'@example.invalid','active',true);
 const ok=await stubService(()=>200),unready=await stubService(()=>503),slow=await stubService(async()=>{await new Promise(r=>setTimeout(r,600));return 200;}),gone=await stubService(()=>200),goneOrigin=gone.origin;await gone.close();
 const services:ServiceProbe[]=[],healthServer=mountApp(adminConfig,{services,slowServiceMs:300,serviceTimeoutMs:1500,staleQueueSeconds:600}).listen(0,'127.0.0.1');await once(healthServer,'listening');
 const addr=healthServer.address();assert.ok(addr&&typeof addr==='object');const root='http://127.0.0.1:'+addr.port,wire:string[]=[];
 const get=async()=>{const r=await call(healthUrl,{token,root});assert.equal(r.status,200);wire.push(JSON.stringify(r.data));return r;};
 try{
  await resetQueues();const ledger=await expectedLedger();await installLedger(ledger);services.push({name:'ai_ocr',origin:ok.origin,token:SERVICE_TOKEN});
  const base=await get();assert.equal(base.data.health.status,'ok');assert.deepEqual(base.data.health.components.map((c:any)=>c.name),['database','migrations','processing_queue','email_queue','ai_ocr']);
  assert.equal(component(base,'database').status,'ok');assert.deepEqual([component(base,'migrations').expected,component(base,'migrations').applied,component(base,'migrations').pending,component(base,'migrations').latest_applied],[ledger.length,ledger.length,0,ledger[ledger.length-1].version]);
  assert.deepEqual(['pending','running','retry_wait','failed_last_24h','expired_leases','oldest_ready_age_seconds'].map(k=>component(base,'processing_queue')[k]),[0,0,0,0,0,null]);
  assert.equal(component(base,'ai_ocr').status,'ok');assert.ok(ok.received.length>=1&&ok.received.every(r=>r.url==='/health'&&r.authorization==='Bearer '+SERVICE_TOKEN),'only /health is requested, and the configured token goes only to the configured service');
  // processing queue
  await queueRows(patient,{job:'expired'});let r=await get();assert.equal(r.data.health.status,'degraded');assert.deepEqual([component(r,'processing_queue').status,component(r,'processing_queue').reason,component(r,'processing_queue').expired_leases,component(r,'processing_queue').running],['degraded','expired_leases',1,1]);
  assert.equal(component(r,'email_queue').status,'ok');await resetQueues();
  await queueRows(patient,{job:'stale'});r=await get();assert.deepEqual([component(r,'processing_queue').status,component(r,'processing_queue').reason,component(r,'processing_queue').pending],['degraded','stale_ready_jobs',1]);assert.ok(component(r,'processing_queue').oldest_ready_age_seconds>=1200);await resetQueues();
  await queueRows(patient,{job:'failed'});r=await get();assert.equal(r.data.health.status,'ok','failed jobs are counted but do not by themselves make the queue stuck');assert.equal(component(r,'processing_queue').failed_last_24h,1);await resetQueues();
  // email and notification queues
  await queueRows(patient,{mail:'overdue'});r=await get();assert.deepEqual([component(r,'email_queue').status,component(r,'email_queue').reason,component(r,'email_queue').email_overdue],['degraded','stuck_deliveries',1]);await resetQueues();
  await queueRows(patient,{mail:'claim'});r=await get();assert.deepEqual([component(r,'email_queue').status,component(r,'email_queue').email_expired_claims],['degraded',1]);await resetQueues();
  await queueRows(patient,{notify:'overdue'});r=await get();assert.deepEqual([component(r,'email_queue').status,component(r,'email_queue').notification_overdue],['degraded',1]);await resetQueues();
  await queueRows(patient,{mail:'failed',notify:'failed'});r=await get();assert.equal(r.data.health.status,'ok');assert.deepEqual([component(r,'email_queue').email_failed_last_24h,component(r,'email_queue').notification_failed_last_24h],[1,1]);await resetQueues();
  // migrations
  await owner.query('DELETE FROM public.schema_migrations WHERE version=$1',[ledger[ledger.length-1].version]);r=await get();assert.deepEqual([component(r,'migrations').status,component(r,'migrations').reason,component(r,'migrations').pending,r.data.health.status],['degraded','pending_migrations',1,'degraded']);
  await installLedger(ledger);await owner.query("UPDATE public.schema_migrations SET checksum=$1 WHERE version='0003'",['a'.repeat(64)]);r=await get();assert.deepEqual([component(r,'migrations').status,component(r,'migrations').reason,r.data.health.status],['down','history_mismatch','down']);
  await owner.query('DROP TABLE public.schema_migrations');r=await get();assert.deepEqual([component(r,'migrations').status,component(r,'migrations').reason],['unknown','ledger_not_found']);assert.equal(r.data.health.status,'degraded');
  await installLedger(ledger);assert.equal((await get()).data.health.status,'ok');
  // AI services: reachable, answering but not ready, slow, unreachable, unconfigured, misconfigured; credentials in the configured address never travel or appear
  services.splice(0,services.length,
   {name:'ai_ocr',origin:new URL('http://user:pw-sentinel@127.0.0.1:'+ok.port+'/internal/v1/path?token=url-token-sentinel').origin,token:SERVICE_TOKEN},{name:'ai_summary',origin:unready.origin},{name:'ai_rag',origin:slow.origin});
  r=await get();assert.deepEqual([component(r,'ai_ocr').status,component(r,'ai_summary').status,component(r,'ai_summary').reason,component(r,'ai_rag').status,component(r,'ai_rag').reason],['ok','degraded','unexpected_status','degraded','slow_response']);assert.equal(r.data.health.status,'degraded');
  services.splice(0,services.length,{name:'ai_ocr',origin:goneOrigin},{name:'ai_summary'},{name:'ai_rag',misconfigured:true});
  r=await get();assert.deepEqual([component(r,'ai_ocr').status,component(r,'ai_ocr').reason,component(r,'ai_summary').status,component(r,'ai_rag').status,component(r,'ai_rag').reason,r.data.health.status],['down','connection_failed','not_configured','unknown','misconfigured','down']);
  const denied=await stubService(()=>401),noRoute=await stubService(()=>404);services.splice(0,services.length,{name:'ai_ocr',origin:denied.origin,token:'wrong-token-sentinel'},{name:'ai_summary',origin:noRoute.origin});
  r=await get();assert.deepEqual([component(r,'ai_ocr').status,component(r,'ai_ocr').reason,component(r,'ai_summary').status,component(r,'ai_summary').reason,r.data.health.status],['degraded','unauthorized','ok','no_health_route','degraded'],'a service that rejects our token is degraded; one without a /health route is reachable');
  assert.ok(denied.received.every(x=>x.authorization==='Bearer wrong-token-sentinel')&&!JSON.stringify(r.data).includes('wrong-token-sentinel'));await Promise.all([denied.close(),noRoute.close()]);
  const hung=await stubService(()=>new Promise<number>(()=>{}));services.splice(0,services.length,{name:'ai_rag',origin:hung.origin});r=await get();assert.deepEqual([component(r,'ai_rag').status,component(r,'ai_rag').reason],['down','timeout']);await hung.close();
  services.splice(0,services.length,{name:'ai_ocr',origin:ok.origin});
 } finally{
  healthServer.closeAllConnections();await new Promise<void>(resolve=>healthServer.close(()=>resolve()));await Promise.all([ok.close(),unready.close(),slow.close()]);
 }
 // database unreachable or slow (a stub handle is used only for the health probe; the admin session still uses the real database)
 const downServer=mountApp(adminConfig,{services:[],database:{async query(){throw Error('connect ECONNREFUSED postgres://app:db-password-sentinel@10.0.0.9:5432/ai_health_wallet');}} as never}).listen(0,'127.0.0.1');await once(downServer,'listening');
 const slowServer=mountApp(adminConfig,{services:[],slowDatabaseMs:20,database:{async query(){await new Promise(r=>setTimeout(r,80));return {rows:[{ok:1,h:{present:true,rows:[]}}]};}} as never}).listen(0,'127.0.0.1');await once(slowServer,'listening');
 try{
  const down=await call(healthUrl,{token,root:'http://127.0.0.1:'+(downServer.address() as {port:number}).port});wire.push(JSON.stringify(down.data));
  assert.deepEqual([down.status,down.data.health.status,component(down,'database').status,component(down,'database').reason],[200,'down','down','query_failed']);
  for(const name of ['migrations','processing_queue','email_queue'])assert.deepEqual([component(down,name).status,component(down,name).reason],['unknown','database_unavailable'],name);
  const slowResult=await call(healthUrl,{token,root:'http://127.0.0.1:'+(slowServer.address() as {port:number}).port});wire.push(JSON.stringify(slowResult.data));
  assert.deepEqual([component(slowResult,'database').status,component(slowResult,'database').reason],['degraded','slow_response']);assert.ok(component(slowResult,'database').latency_ms>=20);
 }finally{for(const s of [downServer,slowServer]){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));}}
 // nothing sensitive in any report or in the audit rows the reports created
 const text=wire.join('\n'),rows=JSON.stringify(await audit("action='admin.health.read'"));
 const secrets=[SERVICE_TOKEN,'pw-sentinel','url-token-sentinel','db-password-sentinel','ECONNREFUSED','postgres://','/internal/v1/path','127.0.0.1','10.0.0.9','/tmp/hw-phase1-pg',SENTINEL,SENTINEL.toLowerCase(),'example.invalid','service body',patient,process.env.JWT_SECRET,process.env.DB_PASSWORD,process.env.ADMIN_JWT_SECRET,Buffer.from(adminConfig.jwtKey).toString('hex'),token,'Bearer','password','original_filename','s3_','"detail"'].filter((v):v is string=>!!v&&v.length>=3);
 for(const secret of secrets){assert.ok(!text.includes(secret),'a health report contains '+secret);assert.ok(!rows.includes(secret),'a health audit row contains '+secret);}
 assert.ok(!/https?:\/\//.test(text)&&!/localhost/i.test(text),'no address of any kind appears');
 const allowed=new Set(['success','health','status','checked_at','components','name','reason','latency_ms','expected','applied','pending','latest_applied','running','retry_wait','failed_last_24h','expired_leases','oldest_ready_age_seconds','email_overdue','email_expired_claims','email_failed_last_24h','notification_overdue','notification_expired_leases','notification_failed_last_24h']);
 const keys=new Set<string>();(function walk(value:unknown){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value)){keys.add(k);walk(v);}})(wire.map(w=>JSON.parse(w)));
 for(const key of keys)assert.ok(allowed.has(key),'unexpected health field '+key);
 const reads=await audit("action='admin.health.read'");assert.ok(reads.length>=15&&reads.every(r=>r.target_type==='system_health'&&r.outcome==='success'));assert.deepEqual(Object.keys(reads[0].scope).sort(),['problems','status']);
 await installLedger(await expectedLedger());
});

test('P9-41 the health probe only ever uses the origin of a configured address, and only http(s) addresses',()=>{
 const probes=aiServicesFromEnv({OCR_SERVICE_URL:'http://user:pass@127.0.0.1:8011/v1/extractions?x=1',OCR_SERVICE_TOKEN:'t1',SUMMARY_SERVICE_URL:'file:///etc/passwd',RAG_SERVICE_URL:'not a url'});
 assert.deepEqual(probes,[{name:'ai_ocr',origin:'http://127.0.0.1:8011',token:'t1'},{name:'ai_summary',misconfigured:true},{name:'ai_rag',misconfigured:true}]);
 assert.deepEqual(aiServicesFromEnv({}),[{name:'ai_ocr'},{name:'ai_summary'},{name:'ai_rag'}]);
 assert.deepEqual(aiServicesFromEnv({RAG_SERVICE_URL:'https://rag.example.invalid/internal/v1/rag/',RAG_SERVICE_TOKEN:''}),[{name:'ai_ocr'},{name:'ai_summary'},{name:'ai_rag',origin:'https://rag.example.invalid',token:undefined}]);
});

test('P9-42 audit search filters, pages newest first, runs the chain check and records only the shape of each search',async()=>{
 const a=await newAdmin('support_admin'),other=await newAdmin('config_admin'),token=await adminToken(a.email),otherToken=await adminToken(other.email);
 await call('/api/v1/admin/me',{token:otherToken});await propose('documents.max_pdf_pages',otherToken,{value:77});await propose('auth.jwt_secret',otherToken,{value:1});
 const first=await call(auditUrl('?limit=10'),{token});assert.equal(first.status,200);assert.equal(first.data.events.length,10);
 for(const e of first.data.events)assert.deepEqual(Object.keys(e).sort(),['action','actor_admin_id','actor_role','event_hash','id','occurred_at','outcome','request_id','scope','seq','target_id','target_type']);
 assert.deepEqual(first.data.events.map((e:any)=>e.seq),[...first.data.events.map((e:any)=>e.seq)].sort((x:number,y:number)=>y-x),'newest first');
 assert.equal(first.data.chain.status,'intact');assert.equal(first.data.chain.first_invalid_seq,null);assert.ok(first.data.chain.events_checked>=first.data.events[0].seq-1);assert.ok(first.data.next_cursor);
 const second=await call(auditUrl('?limit=10&cursor='+first.data.next_cursor),{token});assert.equal(second.status,200);assert.equal(second.data.chain,null,'the whole-log check runs on the first page only');assert.ok(second.data.events[0].seq<first.data.events[9].seq);
 const everything:any[]=[];let cursor:string|null=null,pages=0;do{const r:any=await call(auditUrl('?limit=40'+(cursor?'&cursor='+cursor:'')),{token});assert.equal(r.status,200);everything.push(...r.data.events);cursor=r.data.next_cursor;pages++;}while(cursor&&pages<200);
 assert.equal(new Set(everything.map(e=>e.seq)).size,everything.length,'no event twice');assert.ok(everything.length>200);
 assert.equal(everything.at(-1).seq,1,'paging reaches the very first event');assert.ok(everything.every((e,i)=>i===0||e.seq<everything[i-1].seq),'strictly newest first across all pages');
 const ids=(r:any)=>r.data.events.map((e:any)=>e.id);
 const byActor=await call(auditUrl('?actor_admin_id='+other.id+'&limit=50'),{token});assert.ok(byActor.data.events.length>=4&&byActor.data.events.every((e:any)=>e.actor_admin_id===other.id));
 const byAction=await call(auditUrl('?action=admin.settings.change&limit=50'),{token});assert.ok(byAction.data.events.length>=2&&byAction.data.events.every((e:any)=>e.action==='admin.settings.change'));
 const byTarget=await call(auditUrl('?target_type=setting&outcome=denied&limit=50'),{token});assert.ok(byTarget.data.events.some((e:any)=>e.target_id==='auth.jwt_secret'));assert.ok(byTarget.data.events.every((e:any)=>e.target_type==='setting'&&e.outcome==='denied'));
 for(const outcome of ['success','denied','failure']){const r=await call(auditUrl('?outcome='+outcome+'&limit=50'),{token});assert.ok(r.data.events.length>0&&r.data.events.every((e:any)=>e.outcome===outcome),outcome);}
 const combined=await call(auditUrl('?actor_admin_id='+other.id+'&action=admin.settings.change&outcome=success'),{token});assert.deepEqual(combined.data.events.map((e:any)=>e.scope.value),[77]);
 const mid=first.data.events[5].occurred_at as string,before=await call(auditUrl('?to='+mid+'&limit=50'),{token}),after=await call(auditUrl('?from='+mid+'&limit=50'),{token});
 assert.ok(before.data.events.every((e:any)=>e.occurred_at<=mid)&&after.data.events.every((e:any)=>e.occurred_at>=mid));assert.ok(ids(before).includes(first.data.events[5].id)&&ids(after).includes(first.data.events[5].id));
 const none=await call(auditUrl('?from=2099-01-01T00:00:00Z'),{token});assert.deepEqual(none.data.events,[]);assert.equal(none.data.next_cursor,null);
 for(const bad of ['?actor_admin_id=x','?action=Admin.Read','?action=admin','?target_type=Setting','?outcome=ok','?from=2031-01-01','?from=2031-13-45T00:00:00Z','?to=yesterday','?from=2031-02-01T00:00:00Z&to=2031-01-01T00:00:00Z','?limit=0','?limit=51','?cursor=garbage','?cursor='+Buffer.from('{"s":"1"}').toString('base64url'),'?q=password','?search=x','?actor_admin_id='+a.id+'&actor_admin_id='+other.id,'?action[]=x'])
  assert.equal((await call(auditUrl(bad),{token})).status,400,bad);
 const mine=await audit("action='admin.audit.read' AND actor_admin_id=$1",[a.id]);assert.ok(mine.length>=10&&mine.every(r=>r.target_type==='audit_log'&&r.outcome==='success'&&r.target_id===null));
 const text=JSON.stringify(mine.map(r=>[r.scope,r.target_id]));for(const value of [other.id,'admin.settings.change','denied','success','failure','2099','documents.max_pdf_pages','2031'])assert.ok(!text.includes(value),'the search values are not stored: '+value);
 const shaped=mine.find(r=>r.scope.filters.length===3)!;assert.deepEqual(Object.keys(shaped.scope).sort(),['chain','filters','limit','paged','returned']);assert.deepEqual(shaped.scope.filters,['action','actor_admin_id','outcome']);assert.equal(shaped.scope.chain,'intact');
 assert.equal(mine.find(r=>r.scope.paged===true)!.scope.chain,null);
});

test('P9-43 audit responses redact anything that looks like a secret and never carry medical content',async()=>{
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),jwt=await forge(adminConfig.jwtKey,adminConfig.jwtAudience,a.id,randomUUID());
 await writeAdminAudit(db,{actorAdminId:a.id,actorRole:'operations_admin',action:'admin.profile.read',targetType:'admin_account',targetId:a.id,outcome:'success',requestId:randomUUID(),
  scope:{note:jwt,long:'x'.repeat(200),bearer:'Bearer abcdef',hex:'ab'.repeat(32),mail:'person@example.invalid',hash:'$argon2id$v=19$m=19456,t=2,p=1$abc',doctor:'ds1.'+randomUUID(),password:'hunter2',nested:{api_key:'k',deep:{deeper:{deepest:'v'}}},list:['ok',jwt,'person@example.invalid',3,true,null],plain:'fine',count:3}});
 const [row]=await audit("scope ? 'plain'");assert.ok(row);
 const r=await call(auditUrl('?action=admin.profile.read&limit=50'),{token}),shown=r.data.events.find((e:any)=>e.scope.plain==='fine');assert.ok(shown);
 assert.deepEqual(shown.scope,{note:'[redacted]',long:'[redacted]',bearer:'[redacted]',hex:'[redacted]',mail:'[redacted]',hash:'[redacted]',doctor:'[redacted]',password:'[redacted]',nested:{api_key:'[redacted]',deep:{deeper:'[redacted]'}},list:['ok','[redacted]','[redacted]',3,true,null],plain:'fine',count:3});
 assert.deepEqual(safeScope({a:{b:{c:{d:1}}}}),{a:{b:{c:'[redacted]'}}});assert.equal(safeScope(undefined),'[redacted]');
 const everything:any[]=[];let cursor:string|null=null,pages=0;do{const p:any=await call(auditUrl('?limit=50'+(cursor?'&cursor='+cursor:'')),{token});everything.push(...p.data.events);cursor=p.data.next_cursor;pages++;}while(cursor&&pages<300);
 const stripped=JSON.stringify(everything.map(({event_hash:_h,...event})=>event));
 const secrets=[process.env.JWT_SECRET,process.env.ADMIN_JWT_SECRET,process.env.DB_PASSWORD,process.env.MIGRATION_DB_PASSWORD,process.env.AWS_SECRET_ACCESS_KEY,Buffer.from(adminConfig.jwtKey).toString('hex'),Buffer.from(patientConfig.jwtKey).toString('hex'),adminPassword,patientPassword,token,jwt,'hunter2','person@example.invalid','$argon2'].filter((v):v is string=>!!v&&v.length>=6);
 for(const secret of secrets)assert.ok(!stripped.includes(secret),'the audit review exposes a secret');
 assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(stripped)&&!HEX64.test(stripped)&&!/Bearer\s/.test(stripped)&&!/@[a-z]+\.[a-z]+/.test(stripped),'no token, long hex string or address appears');
 for(const medical of [SENTINEL,SENTINEL.toLowerCase(),'extracted OCR','summary text','Hospital','report.pdf','medical-documents/','482913','serious finding','Status active','Person'])assert.ok(!stripped.includes(medical),'medical content appears: '+medical);
 assert.ok(everything.every(e=>/^[a-f0-9]{64}$/.test(e.event_hash)),'the only hashes returned are the events\' own integrity hashes');
});

test('P9-44 a tampered audit chain is reported by the audit search, and the report clears once the record is restored',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email);
 for(let i=0;i<3;i++)await call('/api/v1/admin/me',{token});
 const target=(await owner.query("SELECT seq,outcome,scope FROM public.admin_audit_events WHERE action='admin.profile.read' ORDER BY seq DESC OFFSET 1 LIMIT 1")).rows[0],seq=Number(target.seq);
 const intact=await call(auditUrl('?limit=5'),{token});assert.equal(intact.data.chain.status,'intact');
 try{
  const client=await owner.connect();
  try{await client.query('ALTER TABLE public.admin_audit_events DISABLE TRIGGER admin_audit_no_change');await client.query("UPDATE public.admin_audit_events SET outcome='failure' WHERE seq=$1",[seq]);await client.query('ALTER TABLE public.admin_audit_events ENABLE TRIGGER admin_audit_no_change');}finally{client.release();}
  const broken=await call(auditUrl('?limit=5'),{token});assert.equal(broken.status,200);assert.equal(broken.data.chain.status,'broken');assert.equal(broken.data.chain.first_invalid_seq,seq);assert.equal(broken.data.chain.events_checked,seq-1);
  assert.equal((await call(auditUrl('?limit=5&cursor='+broken.data.next_cursor),{token})).data.chain,null);
  const shown=(await call(auditUrl('?limit=50&actor_admin_id='+a.id),{token})).data.events.find((e:any)=>e.seq===seq);assert.equal(shown.outcome,'failure','the viewer shows the stored (tampered) data and the chain result says it is untrustworthy');
  const recorded=await audit("action='admin.audit.read' AND actor_admin_id=$1",[a.id]);assert.equal(recorded.filter(r=>r.scope.chain==='broken').length,2,'both first-page searches while tampered recorded the broken result');assert.equal(recorded.filter(r=>r.scope.paged&&r.scope.chain===null).length,1);
 }finally{
  const client=await owner.connect();
  try{await client.query('ALTER TABLE public.admin_audit_events DISABLE TRIGGER admin_audit_no_change');await client.query('UPDATE public.admin_audit_events SET outcome=$2 WHERE seq=$1',[seq,target.outcome]);await client.query('ALTER TABLE public.admin_audit_events ENABLE TRIGGER admin_audit_no_change');}finally{client.release();}
 }
 const healed=await call(auditUrl('?limit=5'),{token});assert.equal(healed.data.chain.status,'intact');assert.equal(healed.data.chain.first_invalid_seq,null);
 await assert.rejects(owner.query("UPDATE public.admin_audit_events SET outcome='failure' WHERE seq=$1",[seq]),sqlState('42501'),'the trigger is back in force');
});

test('P9-45 health and audit review reject non-admin and forged callers, enforce their own permissions, and change nothing',async()=>{
 const patient=await livePatient(),doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex'),routes=[healthUrl,auditUrl(),auditUrl('?limit=5&outcome=denied')];
 const now=Math.floor(Date.now()/1000),expired=await forge(adminConfig.jwtKey,adminConfig.jwtAudience,randomUUID(),randomUUID(),{iat:now-2000,exp:now-1000}),forged=await forge(patientConfig.jwtKey,adminConfig.jwtAudience,randomUUID(),randomUUID()),wrongAudience=await forge(adminConfig.jwtKey,patientConfig.jwtAudience,randomUUID(),randomUUID());
 const auditBefore=await auditCount();
 for(const path of routes)for(const token of [undefined,patient.access,patient.refresh,doctor,forged,wrongAudience,expired,'not-a-token'])assert.equal((await call(path,{token})).status,401,path);
 assert.equal(await auditCount(),auditBefore,'rejected callers leave no audit rows');
 const a=await newAdmin('support_admin'),token=await adminToken(a.email);
 for(const permission of ['admin.health.read','admin.audit.read']){
  await owner.query("DELETE FROM public.admin_role_permissions WHERE role_name='support_admin' AND permission=$1",[permission]);
  try{
   const path=permission==='admin.health.read'?healthUrl:auditUrl();assert.equal((await call(path,{token})).status,403,permission);
   assert.equal((await audit("action=$1 AND outcome='denied' AND actor_admin_id=$2",[permission,a.id])).length,1,permission);
   assert.equal((await call(permission==='admin.health.read'?auditUrl():healthUrl,{token})).status,200,'the other permission is unaffected');
  }finally{await owner.query("INSERT INTO public.admin_role_permissions(role_name,permission) VALUES('support_admin',$1)",[permission]);}
 }
 for(const method of ['POST','PUT','PATCH','DELETE'])for(const path of [healthUrl,auditUrl()])assert.equal((await call(path,{method,token,body:{outcome:'success'}})).status,404,method+' '+path);
 assert.equal((await call(healthUrl+'?x=1',{token})).status,400);
 const rows=async()=>(await owner.query(`SELECT (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY seq),'')) FROM (SELECT * FROM public.admin_audit_events WHERE action NOT IN ('admin.health.read','admin.audit.read')) t) AS a,
  (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.admin_setting_versions t) AS s,(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) FROM public.patients t) AS p`)).rows[0];
 const state=await rows();for(const path of routes)assert.equal((await call(path,{token})).status,200);assert.deepEqual(await rows(),state,'health and audit review changed no other record');
 const code=(await Promise.all(['health.ts','audit-viewer.ts','ops-routes.ts'].map(f=>readFile(new URL('../admin/'+f,import.meta.url),'utf8')))).join('\n').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 assert.ok(!/(INSERT|UPDATE|DELETE)\s/i.test(code.replace(/readdir|\.update\(/g,'')),'health and audit review code contains no write statements');
 for(const word of ['medical_documents','extracted_medical_text','ai_report_summaries','public.patients','password_hash','DB_PASSWORD','JWT_SECRET','connectionString','DATABASE_URL'])assert.ok(!code.includes(word),'must not mention '+word);
 assert.equal((await db.query<{first_invalid:string|null}>('SELECT * FROM public.verify_admin_audit_chain()',[])).rows[0].first_invalid,null);
});

// ---- Phase 7: separation guarantees (M13-009, M13-021 and the default-deny half of M13-020) ----
interface RouteRef{method:string;path:string}
type AnyRouter={stack:Array<{route?:{path:string;methods:Record<string,boolean>};handle?:AnyRouter}>};
const docConfig={maxFileBytes:4096,maxConcurrentUploads:2,uploadTimeoutMs:3000,validationTimeoutMs:1000,maxImagePixels:1000,maxPdfPages:1,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const otpMessages:Array<{to:string;token:string}>=[];
const shareMailer={async send(){},async enqueue(message:{to:string;token:string}){otpMessages.push({to:message.to,token:message.token});}};
const sharingTestConfig=sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid',SHARING_RESEND_SECONDS:'1'})!;
let nestedMounts=new Map<object,string>();
/** Builds every router the production app mounts, using the mount prefixes parsed from app.ts, and records nested router paths. */
async function productionRouters(){
 const source=await readFile(new URL('../app.ts',import.meta.url),'utf8'),mounts=[...source.matchAll(/app\.use\(\s*["']([^"']+)["']\s*,\s*(?:noStore\s*,\s*)?(routes\.\w+|documents|create\w+Routes)\b/g)].map(m=>({prefix:m[1],name:m[2]==='documents'?'createDocumentRoutes':m[2]}));
 const patientRoutes=createPatientRoutes(db,patientConfig,{mailer:{async send(){}},policy:{...getSecurityPolicy(),challengeRateMax:10000}});
 const factories:Record<string,()=>unknown>={
  'routes.auth':()=>patientRoutes.auth,'routes.profile':()=>patientRoutes.profile,createAdminRoutes:()=>createAdminRoutes(db,patientConfig,adminConfig,{health:{services:[]}}),
  createGuardianNotificationRoutes:()=>createGuardianNotificationRoutes(db,patientConfig,docConfig as never,null),
  createSharingRoutes:()=>createSharingRoutes(db as unknown as RagDatabase,patientConfig,docConfig as never,null,{config:sharingTestConfig,mailer:shareMailer}),
  createRagRoutes:()=>createRagRoutes(db as unknown as RagDatabase,patientConfig),createSummaryRoutes:()=>createSummaryRoutes(db,patientConfig),createProcessingRoutes:()=>createProcessingRoutes(db,patientConfig),
  createDocumentRoutes:()=>createDocumentRoutes(db,patientConfig,docConfig as never,null),createTimelineRoutes:()=>createTimelineRoutes(db,patientConfig),createGuardianRoutes:()=>createGuardianRoutes(db,patientConfig,{mailer:shareMailer}),
 };
 // The routers that cover every /api/v1 path reject query strings and demand patient credentials, so the admin routes must be mounted before them.
 const adminAt=mounts.findIndex(m=>m.name==='createAdminRoutes');assert.ok(adminAt>=0);
 for(const [index,m] of mounts.entries())if(m.prefix==='/api/v1')assert.ok(adminAt<index,'app.ts mounts '+m.name+' on /api/v1 before the admin routes');
 const parsed=new Set(mounts.map(m=>m.name));
 for(const name of parsed)assert.ok(name in factories,'app.ts mounts '+name+', which this test does not know how to build: review its separation from admin and add it');
 for(const name of Object.keys(factories))assert.ok(parsed.has(name),'this test builds '+name+' but app.ts no longer mounts it');
 let proto=Object.getPrototypeOf(express.Router());while(proto&&!Object.hasOwn(proto,'use'))proto=Object.getPrototypeOf(proto);
 const original=proto.use;nestedMounts=new Map();
 proto.use=function(this:unknown,...args:unknown[]){if(typeof args[0]==='string')for(const handler of args.slice(1))if(handler&&typeof handler==='function'&&'stack' in handler)nestedMounts.set(handler,args[0]);return original.apply(this,args);};
 try{return mounts.map(m=>({...m,router:factories[m.name]() as AnyRouter}));}finally{proto.use=original;}
}
function routesOf(router:AnyRouter,prefix:string,out:RouteRef[]=[]):RouteRef[]{
 for(const layer of router.stack){
  if(layer.route)for(const method of Object.keys(layer.route.methods))out.push({method:method.toUpperCase(),path:prefix+layer.route.path});
  else if(layer.handle?.stack)routesOf(layer.handle,prefix+(nestedMounts.get(layer.handle)??''),out);
 }
 return out;
}
const concrete=(path:string)=>path.replace(/:([A-Za-z]+)/g,(_m,name:string)=>/operation/i.test(name)?'query':randomUUID());
async function bare(base:string,route:RouteRef,token?:string,withoutBody=false){
 const bodiless=route.method==='GET'||route.method==='HEAD'||withoutBody;
 const response=await fetch(base+concrete(route.path),{method:route.method,headers:{...(bodiless?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},body:bodiless?undefined:'{}',signal:AbortSignal.timeout(15000)});
 const text=await response.text();return {status:response.status,text:text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,'<id>')};
}
const ADMIN_ROUTES=[
 'GET /api/v1/admin/audit','GET /api/v1/admin/health','GET /api/v1/admin/me','GET /api/v1/admin/patients','GET /api/v1/admin/patients/:id','GET /api/v1/admin/processing/jobs','GET /api/v1/admin/processing/jobs/:documentId','GET /api/v1/admin/processing/summary',
 'GET /api/v1/admin/rules','GET /api/v1/admin/rules/:id','GET /api/v1/admin/settings','GET /api/v1/admin/settings/:key','GET /api/v1/admin/status/deliveries','GET /api/v1/admin/status/deliveries/summary','GET /api/v1/admin/status/guardians','GET /api/v1/admin/status/guardians/:id',
 'GET /api/v1/admin/status/guardians/summary','GET /api/v1/admin/status/shares','GET /api/v1/admin/status/shares/:id','GET /api/v1/admin/status/shares/summary',
 'POST /api/v1/admin/auth/login','POST /api/v1/admin/patients/:id/reactivate','POST /api/v1/admin/patients/:id/suspend','POST /api/v1/admin/processing/jobs/:documentId/retry','POST /api/v1/admin/rules','POST /api/v1/admin/settings/:key/versions','POST /api/v1/admin/settings/:key/versions/:version/decision'];

test('P9-46 an admin token, even with every permission, gets nothing from any patient, record, summary, timeline, RAG, doctor-share or doctor-session route',async()=>{
 const a=await newAdmin('config_admin'),token=await adminToken(a.email),mounted=await productionRouters(),routes:RouteRef[]=[];
 for(const m of mounted)if(m.name!=='createAdminRoutes')routesOf(m.router,m.prefix,routes);
 const keys=routes.map(r=>r.method+' '+r.path);assert.deepEqual(keys.filter((k,i)=>keys.indexOf(k)!==i),[],'each route is registered once');assert.ok(routes.length>=50,'the production routes were enumerated ('+routes.length+')');
 for(const word of ['/documents','/timeline','/summary','/rag','/doctor/records','/sharing/grants','/patients/me','/guardian-notifications','/guardian-invitations'])assert.ok(keys.some(k=>k.includes(word)),'the inventory covers '+word);
 const app=express();app.use(express.json());for(const m of mounted)app.use(m.prefix,m.router as never);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const root='http://127.0.0.1:'+address.port;
 const results:Array<{route:string;admin:number;anonymous:number}>=[];
 try{
  for(const route of routes){
   const withAdmin=await bare(root,route,token),anonymous=await bare(root,route);
   assert.equal(withAdmin.status,anonymous.status,route.method+' '+route.path+': an admin token changes the outcome');assert.equal(withAdmin.text,anonymous.text,route.method+' '+route.path+': an admin token changes the response');
   assert.ok(![500,502,504].includes(withAdmin.status),route.method+' '+route.path+' failed with '+withAdmin.status);assert.ok(withAdmin.status<200||withAdmin.status>299,route.method+' '+route.path+' answered an admin token with success');
   assert.ok(!withAdmin.text.includes(a.id)&&!withAdmin.text.includes(a.email),'the admin identity is never echoed');
   results.push({route:route.method+' '+route.path,admin:withAdmin.status,anonymous:anonymous.status});
  }
  const guarded=results.filter(r=>r.admin===401||r.admin===403);assert.ok(guarded.length>=40,'most routes demand their own credential ('+guarded.length+' of '+results.length+')');
  for(const needle of ['/doctor/records','/doctor/timeline','/rag/queries','/documents','/timeline','/sharing/grants']){const rows=results.filter(r=>r.route.includes(needle));assert.ok(rows.length>0&&rows.every(r=>r.admin===401||r.admin===403),'every '+needle+' route refuses an admin token');}
  // the same tokens in the forms the other actors use
  const doctorForm='ds1.'+a.id+'.'+randomBytes(32).toString('hex');
  for(const route of routes.filter(r=>r.path.startsWith('/api/v1/doctor/')).slice(0,6))assert.ok([401,403].includes((await bare(root,route,doctorForm)).status));
 } finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('P9-47 the admin routes are a fixed reviewed list: no medical path, no record-writing verb, and every one demands an admin credential',async()=>{
 const mounted=await productionRouters(),admin=mounted.find(m=>m.name==='createAdminRoutes')!,routes=routesOf(admin.router,admin.prefix),keys=routes.map(r=>r.method+' '+r.path).sort();
 assert.deepEqual(keys,[...ADMIN_ROUTES].sort(),'a new admin route needs a separation review before this list is changed');
 const medical=/(^|\/)(documents?|records?|files?|downloads?|views?|summaries|timeline|rag|extraction|extractions|ocr|text|content|chunks?|doctor|doctors|history-summary|originals?|uploads?|reports?)(\/|$)/;
 for(const key of keys)assert.ok(!medical.test(key.split(' ')[1].replace('/api/v1/admin','')),key+' names medical content');
 assert.deepEqual(keys.filter(k=>!k.startsWith('GET ')),[...ADMIN_ROUTES].filter(k=>k.startsWith('POST')).sort(),'no PUT, PATCH or DELETE exists, and every POST is one of the reviewed operational actions');
 const nonMedicalWriters=['/auth/login','/patients/:id/suspend','/patients/:id/reactivate','/processing/jobs/:documentId/retry','/rules','/settings/:key/versions','/settings/:key/versions/:version/decision'].map(p=>'POST /api/v1/admin'+p).sort();assert.deepEqual(keys.filter(k=>k.startsWith('POST')),nonMedicalWriters);
 // every admin route refuses the other actors' credentials (login is a public entry point and answers them exactly as it answers anyone)
 const patient=await livePatient(),doctor='ds1.'+randomUUID()+'.'+randomBytes(32).toString('hex'),mount=mountApp(adminConfig,{services:[]}).listen(0,'127.0.0.1');await once(mount,'listening');
 const address=mount.address();assert.ok(address&&typeof address==='object');const root='http://127.0.0.1:'+address.port;let checked=0;
 try{
  for(const route of routes){
   const anonymous=await bare(root,route);
   for(const credential of [undefined,patient.access,patient.refresh,doctor]){
    const outcomes=[await bare(root,route,credential),await bare(root,{...route,method:route.method==='POST'?'POST':route.method},credential,true)];
    if(route.path.endsWith('/auth/login'))assert.deepEqual(outcomes[0],anonymous);
    else{assert.ok(outcomes.some(o=>o.status===401),route.method+' '+route.path+' never answered 401 to a non-admin credential ('+outcomes.map(o=>o.status)+')');assert.ok(outcomes.every(o=>o.status<200||o.status>299),route.method+' '+route.path+' succeeded for a non-admin credential');}
    checked++;
   }
  }
  assert.equal(checked,routes.length*4);
 } finally{mount.closeAllConnections();await new Promise<void>(resolve=>mount.close(()=>resolve()));}
 const a=await newAdmin('support_admin'),withToken=await adminToken(a.email),w=await buildWorld();
 for(const [method,path] of [['POST','/api/v1/admin/documents'],['PUT','/api/v1/admin/documents/'+randomUUID()],['PATCH','/api/v1/admin/patients/'+w.patients.active+'/profile'],['DELETE','/api/v1/admin/patients/'+w.patients.active],['GET','/api/v1/admin/documents'],['GET','/api/v1/admin/records/'+randomUUID()+'/download'],['GET','/api/v1/admin/patients/'+w.patients.active+'/documents'],
  ['GET','/api/v1/admin/patients/'+w.patients.active+'/summary'],['GET','/api/v1/admin/timeline'],['POST','/api/v1/admin/rag/queries'],['GET','/api/v1/admin/shares/'+randomUUID()+'/records'],['POST','/api/v1/admin/support-access'],['GET','/api/v1/admin/support-access'],['POST','/api/v1/admin/medical-access']] as const)
  assert.equal((await call(path,{method,token:withToken,body:method==='GET'?undefined:{}})).status,404,method+' '+path);
});

test('P9-48 medical content is denied to admins by default: no permission, table or setting offers a way in, and no exceptional access exists yet',async()=>{
 const permissions=(await owner.query('SELECT DISTINCT permission FROM public.admin_role_permissions ORDER BY 1')).rows.map(r=>r.permission as string);
 assert.deepEqual(permissions,allPermissions);
 for(const permission of permissions){assert.match(permission,/^admin\.(profile|patients|processing|guardians|shares|deliveries|settings|rules|health|audit)\.(read|suspend|reactivate|retry|change|approve|create)$/);assert.ok(!permission.split('.').some(segment=>['documents','document','medical','records','record','summary','summaries','files','file','content','rag','timeline','download','support','exceptional','impersonate','override','bypass','sudo'].includes(segment)),permission);}
 assert.deepEqual((await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ~* 'support|exceptional|impersonat|breakglass|break_glass|elevat|emergency') ORDER BY 1")).rows,[],'no exceptional-access table exists: that stays blocked on CFG-17');
 assert.deepEqual((await owner.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'admin\\_%' AND (column_name ~* 'support|exceptional|impersonat|on_behalf|act_as|medical|document|summary|ocr|s3_' OR column_name ~* '^bucket$|bucket_name|bucket_key') ORDER BY 1")).rows,[]);
 assert.deepEqual((await owner.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname ~* 'support|impersonat|exceptional|breakglass'")).rows,[]);
 assert.ok(!settingRegistry.some(spec=>/support|exceptional|medical|document_content|impersonat/.test(spec.key)),'no setting could enable medical access');
 assert.deepEqual((await owner.query("SELECT rolname FROM pg_roles WHERE rolname ~* 'admin'")).rows,[],'admins have no database login: they act only through the API role');
 // an admin with every permission, asked for any patient's records through the admin API, gets nothing and writes nothing
 const a=await newAdmin('operations_admin'),token=await adminToken(a.email),patient=await seedPatient('Deny Owner','deny-'+randomUUID()+'@example.invalid','active',true),doc=await jobFixture(patient,{sentinel:true,state:'completed'});
 const before=await medicalSnapshot(patient),texts:string[]=[];
 for(const path of ['/api/v1/admin/patients/'+patient,'/api/v1/admin/patients?q=Deny','/api/v1/admin/processing/jobs?patient_id='+patient,'/api/v1/admin/processing/jobs/'+doc,'/api/v1/admin/processing/summary','/api/v1/admin/status/guardians?patient_id='+patient,'/api/v1/admin/status/shares?patient_id='+patient,'/api/v1/admin/status/deliveries?patient_id='+patient,
  '/api/v1/admin/audit?limit=50','/api/v1/admin/health','/api/v1/admin/settings','/api/v1/admin/rules'])
  {const r=await call(path,{token});assert.ok(r.status===200||r.status===404,path+' '+r.status);texts.push(JSON.stringify(r.data));}
 const wire=texts.join('\n');for(const word of [SENTINEL,SENTINEL.toLowerCase(),'extracted OCR','summary text','report.pdf','Hospital','medical-documents/','synthetic-private-bucket'])assert.ok(!wire.includes(word),'an admin response exposes '+word);
 assert.equal(await medicalSnapshot(patient),before,'nothing medical changed');
});

test('P9-49 suspending a patient cuts off their doctor shares at once, and reactivation brings back no old session, link or code',async()=>{
 const a=await newAdmin('support_admin'),admin_=await adminToken(a.email),patient=await livePatient(),doc=await jobFixture(patient.id,{state:'completed'});
 const shareApp=express();shareApp.use(express.json());shareApp.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const identityRoutes=createPatientRoutes(db,patientConfig,{mailer:{async send(){}},policy:{...getSecurityPolicy(),challengeRateMax:10000}});shareApp.use('/api/v1/auth',identityRoutes.auth);shareApp.use('/api/v1/patients',identityRoutes.profile);
 shareApp.use('/api/v1',createSharingRoutes(db as unknown as RagDatabase,patientConfig,docConfig as never,null,{config:sharingTestConfig,mailer:shareMailer}));shareApp.use('/api/v1/admin',createAdminRoutes(db,patientConfig,adminConfig,{health:{services:[]}}));shareApp.use(errorHandler);
 const server=shareApp.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const root='http://127.0.0.1:'+address.port,api=(path:string,opts:Parameters<typeof call>[1]={})=>call('/api/v1'+path,{...opts,root});
 try{
  const share=async(token:string,kind='unique_link')=>{const r=await api('/sharing/grants',{method:'POST',token,body:{document_ids:[doc],share_type:kind,...(kind==='unique_link'?{doctor_email:'doctor-'+randomUUID()+'@example.invalid'}:{})}});assert.equal(r.status,201);return {id:r.data.grant.id as string,token:(r.data.share_url as string).split('#/share/')[1],email:''};};
  const redeem=async(link:{token:string},email:string)=>{
   const otp=await api('/sharing/otp',{method:'POST',body:{share_token:link.token,email,name:'Dr Synthetic'}});if(otp.status!==202)return {otp,verify:undefined,session:undefined as string|undefined};
   const code=otpMessages.filter(m=>m.to===email).at(-1)!.token,verify=await api('/sharing/otp/verify',{method:'POST',body:{share_token:link.token,email,challenge_id:otp.data.challenge_id,otp:code}});
   return {otp,verify,session:verify.status===200?verify.data.access_token as string:undefined,code};
  };
  const grantEmail=async(id:string)=>(await owner.query('SELECT doctor_email FROM public.doctor_sharing_grants WHERE id=$1',[id])).rows[0].doctor_email as string;
  // 1. a doctor with a live session, a doctor holding an unused link, and a doctor holding an unused one-time code
  const g1=await share(patient.access),g2=await share(patient.access),g3=await share(patient.access,'qr_code');
  const e1=await grantEmail(g1.id),e3='third-'+randomUUID()+'@example.invalid';
  const live=await redeem(g1,e1);assert.ok(live.session,'the doctor session was issued');
  const listed=await api('/doctor/records',{token:live.session});assert.equal(listed.status,200);assert.deepEqual(listed.data.documents.map((d:any)=>d.id),[doc]);
  assert.equal((await api('/sharing/open',{method:'POST',body:{share_token:g2.token}})).status,200);
  const pending=await api('/sharing/otp',{method:'POST',body:{share_token:g3.token,email:e3,name:'Dr Pending'}});assert.equal(pending.status,202);const pendingCode=otpMessages.filter(m=>m.to===e3).at(-1)!.token,pendingChallenge=pending.data.challenge_id as string;
  // 2. an admin suspends the patient
  const suspended=await api('/admin/patients/'+patient.id+'/suspend',{method:'POST',token:admin_});assert.equal(suspended.status,200);
  const denied=async(label:string)=>{
   const records=await api('/doctor/records',{token:live.session});assert.equal(records.status,403,label+': the live session is refused');assert.equal(records.data.error.code,'SHARE_ACCESS_DENIED');assert.ok(!('documents' in records.data));
   for(const path of ['/doctor/timeline','/doctor/history-summary','/doctor/records/'+doc,'/doctor/records/'+doc+'/view','/doctor/records/'+doc+'/download','/doctor/records/'+doc+'/summary'])assert.equal((await api(path,{token:live.session})).status,403,label+' '+path);
   assert.equal((await api('/doctor/rag/queries',{method:'POST',token:live.session,body:{question:'What does the record say?'}})).status,403,label+' rag');
   for(const link of [g1,g2,g3])assert.equal((await api('/sharing/open',{method:'POST',body:{share_token:link.token}})).status,403,label+': an old link no longer opens');
   assert.equal((await api('/sharing/otp',{method:'POST',body:{share_token:g2.token,email:'late-'+randomUUID()+'@example.invalid',name:'Dr Late'}})).status,403,label+': no new code can be requested');
   assert.equal((await api('/sharing/otp',{method:'POST',body:{share_token:g1.token,email:e1,name:'Dr Again'}})).status,403,label+': the original doctor cannot start over');
   assert.equal((await api('/sharing/otp/verify',{method:'POST',body:{share_token:g3.token,email:e3,challenge_id:pendingChallenge,otp:pendingCode}})).status,403,label+': an unused code is dead');
   assert.equal((await api('/patients/me',{token:patient.access})).status,401,label+': the patient\'s own old token is dead');assert.equal((await api('/auth/refresh',{method:'POST',body:{refresh_token:patient.refresh}})).status,401);
  };
  await denied('while suspended');
  // 3. reactivation: the account returns, nothing issued earlier does
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal((await api('/admin/patients/'+patient.id+'/reactivate',{method:'POST',token:admin_})).status,200);
  await denied('after reactivation');
  assert.equal((await owner.query("SELECT account_status FROM public.patients WHERE id=$1",[patient.id])).rows[0].account_status,'active');
  // 4. the patient can sign in again and make a brand-new share that works, which also proves the denials above are not simply a broken feature
  const login=await api('/auth/login',{method:'POST',body:{email:patient.email,password:patientPassword}});assert.equal(login.status,200);
  const g4=await share(login.data.access_token),e4=await grantEmail(g4.id),fresh=await redeem(g4,e4);assert.ok(fresh.session);
  assert.equal((await api('/doctor/records',{token:fresh.session})).status,200);assert.equal((await api('/doctor/records',{token:live.session})).status,403,'the new share does not revive the old session');
  const audits=await audit("action IN ('admin.patients.suspend','admin.patients.reactivate') AND target_id=$1 AND outcome='success'",[patient.id]);assert.deepEqual(audits.map(e=>e.action),['admin.patients.suspend','admin.patients.reactivate']);
 } finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('P9-50 the admin code never reaches a medical-content table, medical function, storage object or content-serving module',async()=>{
 const files=(await readdir(new URL('../admin/',import.meta.url))).filter(f=>f.endsWith('.ts')),sources=await Promise.all(files.map(async f=>({f,text:(await readFile(new URL('../admin/'+f,import.meta.url),'utf8')).replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1')})));
 assert.ok(files.length>=15,'the admin files were found');
 const allowedRelations=new Set(['patients','patient_auth_sessions','patient_security_events','guardian_relationships','guardian_lifecycle_events','doctor_sharing_grants','doctor_share_sessions','doctor_share_events','patient_security_email_deliveries','guardian_medical_jobs','document_processing_jobs',
  'schema_migrations','admin_roles','admin_role_permissions','admin_accounts','admin_sessions','admin_auth_rate_limits','admin_audit_events','admin_setting_versions','admin_setting_decisions','admin_setting_effective','admin_serious_rule_versions','verify_admin_audit_chain','admin_processing_queue_health','admin_migration_history']);
 const tables=(await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'admin\\_%'")).rows.map(r=>r.table_name as string);
 const functions=(await owner.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname NOT LIKE 'admin\\_%'")).rows.map(r=>r.proname as string);
 const medicalTables=tables.filter(t=>!allowedRelations.has(t));assert.ok(medicalTables.length>=25&&['medical_documents','extracted_medical_text','ai_report_summaries','medical_document_chunks','rag_chunk_embeddings','sharing_grant_documents','doctor_otp_challenges','patient_security_email_payloads','guardian_medical_items','guardian_rule_results','summary_source_snapshots','patient_auth_challenges'].every(t=>medicalTables.includes(t)),'the forbidden set is derived from the live schema');
 const medicalFunctions=functions.filter(fn=>/document|summary|extraction|accessible|current|guardian_medical|rag|doctor_|restrict|persist|lock_summary|valid_extraction/.test(fn)&&!allowedRelations.has(fn));assert.ok(medicalFunctions.length>=5);
 for(const {f,text} of sources){
  const referenced=[...text.matchAll(/\b(?:public\.|FROM\s+|JOIN\s+|INTO\s+|UPDATE\s+)([a-z][a-z0-9_]*)\b/g)].map(m=>m[1]).filter(name=>tables.includes(name)||functions.includes(name)||name.startsWith('admin_'));
  for(const name of referenced)assert.ok(allowedRelations.has(name)||name.startsWith('admin_'),f+' references '+name+', which is outside the reviewed operational set');
  for(const table of medicalTables)assert.ok(!new RegExp('\\b'+table+'\\b').test(text),f+' references the table '+table);
  for(const fn of medicalFunctions)assert.ok(!new RegExp('\\b'+fn+'\\b').test(text),f+' calls the function '+fn);
  assert.ok(!/aws-sdk|S3Client|GetObject|PutObject|createS3Storage|DocumentStorage|readOriginal|createPatientFileAccess|presign|s3_object_key|s3_bucket|\bbucket\b|\.pdf\b|multipart|busboy|sharp\b|pdfjs/i.test(text),f+' touches stored files');
  assert.ok(!/extracted_text|summary_text|structured_output|original_filename|hospital_name|source_metadata|date_of_birth|phone_number|sex_gender|pending_guardian_email/.test(text),f+' names a medical or personal profile field');
 }
 const imports=sources.flatMap(({f,text})=>[...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map(m=>({f,path:m[1]}))).filter(i=>i.path.startsWith('../'));
 const permittedImports=new Set(['../config/env.js','../config/auth.js','../http/errors.js','../patients/repository.js','../patients/validation.js','../auth/middleware.js','../auth/passwords.js','../auth/security-repository.js','../processing/api-repository.js','../database/migrations.js','../database/migration-pool.js']);
 for(const i of imports)assert.ok(permittedImports.has(i.path),i.f+' imports '+i.path+', a module outside the reviewed set (documents, summaries, timeline, RAG, sharing, guardians and storage are off limits)');
 assert.deepEqual(imports.filter(i=>i.path.startsWith('../processing/')).map(i=>i.f),['processing-jobs.ts'],'the single sanctioned route into the existing owner-fenced retry');
 for(const forbidden of ['../documents/','../summaries/','../timeline/','../rag/','../sharing/','../guardians/','../guardian-notifications/'])assert.ok(!imports.some(i=>i.path.startsWith(forbidden)),'no admin file imports '+forbidden);
 const retry=sources.find(s=>s.f==='processing-jobs.ts')!.text;assert.ok(retry.includes('createPatientProcessingRepository')&&!/medical_documents/.test(retry));
});

test('P9-51 a password-reset link issued before an admin suspension is dead after reactivation, and the password does not change',async()=>{
 const a=await newAdmin('support_admin'),token=await adminToken(a.email),patient=await livePatient();
 assert.equal((await call('/api/v1/auth/forgot-password',{body:{email:patient.email}})).status,202);
 const reset=mail.filter(m=>m.to===patient.email&&m.purpose==='reset_password').at(-1);assert.ok(reset,'a reset message was queued');
 assert.equal((await call('/api/v1/admin/patients/'+patient.id+'/suspend',{method:'POST',token})).status,200);
 assert.equal((await call('/api/v1/admin/patients/'+patient.id+'/reactivate',{method:'POST',token})).status,200);
 const replacement='Replacement secure phrase 498!',attempt=await call('/api/v1/auth/reset-password',{body:{token:reset.token,new_password:replacement}});assert.equal(attempt.status,400,'the old reset link is refused');
 assert.equal((await call('/api/v1/auth/login',{body:{email:patient.email,password:replacement}})).status,401,'the replacement password was not set');
 assert.equal((await call('/api/v1/auth/login',{body:{email:patient.email,password:patientPassword}})).status,200,'the original password still works');
});

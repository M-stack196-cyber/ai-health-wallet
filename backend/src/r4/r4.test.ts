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
import type {SecurityMailMessage} from '../auth/routes.js';
import {createPasswordService} from '../auth/passwords.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import type {AdminAuthenticationConfig} from '../admin/config.js';
import {createAdminAccount} from '../admin/bootstrap.js';
import {sharingConfig} from '../sharing/config.js';
import {createRagClient} from '../rag/client.js';

// Phase R4: security checks against the real application (createApp), disposable PostgreSQL, synthetic data only.
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Only the test-owned Unix socket is allowed.');
// app.ts builds a default app on import; point its pool at the disposable database, never at a development database.
Object.assign(process.env,{DB_HOST:socket,DB_PORT:'55481',DB_NAME:'hw_r4_security',DB_USER:'health_wallet_app',DB_PASSWORD:'unused-local-socket',JWT_SECRET:randomBytes(32).toString('hex')});
const conn={host:socket,port:55481,database:'hw_r4_security'};
const owner=new pg.Pool({...conn,user:userInfo().username});
const db=new pg.Pool({...conn,user:'health_wallet_app',max:14});
const mkAuth=():AuthenticationConfig=>({jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'r4-patient-issuer',jwtAudience:'r4-patient',
 argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:8,rateLimitWindowMs:900000,rateLimitMax:1000});
const patientConfig=mkAuth(),strictPatientConfig=mkAuth();
const adminConfig:AdminAuthenticationConfig={jwtKey:new Uint8Array(randomBytes(32)),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'r4-admin-issuer',jwtAudience:'r4-admin',rateLimitMax:5000,rateWindowSeconds:900};
const passwords=createPasswordService(patientConfig);
const patientPassword='Synthetic secure passphrase 310!',adminPassword='Synthetic admin passphrase 731!';
const mail:SecurityMailMessage[]=[];
const mailer={async send(m:SecurityMailMessage){mail.push(m);},async enqueue(m:SecurityMailMessage){mail.push(m);}};
const docConfig={maxFileBytes:4096,maxConcurrentUploads:2,uploadTimeoutMs:3000,validationTimeoutMs:1000,maxImagePixels:1000,maxPdfPages:1,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};
const share=sharingConfig({SHARING_PUBLIC_ORIGIN:'https://doctor.example.invalid',SHARING_RESEND_SECONDS:'1'})!;
interface RouteRef{method:string;path:string}
type AnyRouter={stack:Array<{route?:{path:string;methods:Record<string,boolean>};handle?:AnyRouter}>};
let routes:RouteRef[]=[],base:string,strictBase:string,strictBase2:string;
const servers:Array<ReturnType<ReturnType<typeof express>['listen']>>=[];

async function build(auth:AuthenticationConfig,policy:ReturnType<typeof getSecurityPolicy>,record=false){
 const {createApp}=await import('../app.js');
 let proto=Object.getPrototypeOf(express.Router());while(proto&&!Object.hasOwn(proto,'use'))proto=Object.getPrototypeOf(proto);
 const original=proto.use,mounts=new Map<object,string>();
 if(record)proto.use=function(this:unknown,...args:unknown[]){if(typeof args[0]==='string')for(const h of args.slice(1))if(h&&typeof h==='function'&&'stack' in h)mounts.set(h,args[0]);return original.apply(this,args);};
 let app:express.Express;
 try{app=createApp({auth,admin:adminConfig,database:db,documentDatabase:db,identity:{mailer,policy},documentConfig:docConfig,documentStorage:null,sharing:{config:share,mailer},rag:{client:createRagClient({provider:'synthetic-offline',url:'http://127.0.0.1:9/internal/v1/rag/',token:'ab12cd34'.repeat(8)})}}) as express.Express;}finally{proto.use=original;}
 if(record){
  const walk=(router:AnyRouter,prefix:string,out:RouteRef[])=>{for(const layer of router.stack){
   if(layer.route)for(const m of Object.keys(layer.route.methods))out.push({method:m.toUpperCase(),path:prefix+layer.route.path});
   else if(layer.handle?.stack)walk(layer.handle,prefix+(mounts.get(layer.handle)??''),out);}return out;};
  routes=walk((app as unknown as {router:AnyRouter}).router,'',[]);
 }
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);const a=server.address();assert.ok(a&&typeof a==='object');return 'http://127.0.0.1:'+a.port;
}
before(async()=>{
 assert.equal((await stat(socket)).mode&0o777,0o700);assert.equal(await readFile(socket+'/phase1-owned','utf8'),'identity-security-v1\n');
 const bootstrap=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'postgres'});await bootstrap.connect();
 try{await bootstrap.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await bootstrap.query('CREATE ROLE health_wallet_migrator NOLOGIN');await bootstrap.query('CREATE DATABASE hw_r4_security');}finally{await bootstrap.end();}
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,22);
 for(const f of files){
  if(f.startsWith('0010'))await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
  if(f.startsWith('0005'))await owner.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');
  const c=await owner.connect();try{await c.query('BEGIN');await c.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 const loose={...getSecurityPolicy(),challengeRateMax:10000};
 base=await build(patientConfig,loose,true);
 strictBase=await build(strictPatientConfig,getSecurityPolicy());
 strictBase2=await build(strictPatientConfig,getSecurityPolicy());   // a second "instance": same key, same database, no shared memory
});
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await db.end();await owner.end();});

const LEAK=/SQLSTATE|syntax error|relation "|column "|node_modules|\bat .+\(.+:\d+:\d+\)|\$argon2|password_hash|stack/i;
async function send(root:string,method:string,path:string,opts:{token?:string;body?:string;type?:string|null;auth?:string}={}){
 const headers:Record<string,string>={};if(opts.type!==null&&opts.body!==undefined)headers['Content-Type']=opts.type??'application/json';
 if(opts.auth)headers.Authorization=opts.auth;else if(opts.token)headers.Authorization='Bearer '+opts.token;
 const r=await fetch(root+path,{method,headers,body:opts.body,signal:AbortSignal.timeout(20000)});const text=await r.text();
 assert.ok(r.headers.get('cache-control')?.includes('no-store')||path.startsWith('/api/v1/health'),method+' '+path+' lacks Cache-Control: no-store');
 assert.ok(!LEAK.test(text),method+' '+path+' leaks internal detail: '+text.slice(0,120));
 return {status:r.status,text,json:()=>JSON.parse(text)};
}
const call=(method:string,path:string,opts:Parameters<typeof send>[3]={},root=base)=>send(root,method,path,opts);
const jpost=(path:string,body:unknown,token?:string,root=base)=>send(root,'POST',path,{token,body:JSON.stringify(body)});
const concrete=(path:string,value=()=>randomUUID())=>path.replace(/:([A-Za-z]+)/g,()=>value());
const key=(r:RouteRef)=>r.method+' '+r.path;
/** A 5xx is a defect, except a deliberate 503 from a feature that is switched off (storage, AI service, summaries). */
const serverFault=(res:{status:number;text:string})=>res.status>=500&&!(res.status===503&&/"code":"[A-Z_]*UNAVAILABLE"/.test(res.text));
const PUBLIC=new Set(['POST /api/v1/auth/register','POST /api/v1/auth/login','POST /api/v1/auth/verification/resend','POST /api/v1/auth/forgot-password','POST /api/v1/auth/verify-email',
 'POST /api/v1/auth/reset-password','POST /api/v1/auth/refresh','POST /api/v1/sharing/open','POST /api/v1/sharing/otp','POST /api/v1/sharing/otp/verify','POST /api/v1/admin/auth/login',
 'POST /api/v1/guardian-invitations/accept','POST /api/v1/guardian-notifications/reports']);
const isHealth=(r:RouteRef)=>r.path.startsWith('/api/v1/health');
const isAdmin=(r:RouteRef)=>r.path.startsWith('/api/v1/admin');
const isDoctor=(r:RouteRef)=>r.path.startsWith('/api/v1/doctor');
const patientRoutes=()=>routes.filter(r=>!PUBLIC.has(key(r))&&!isHealth(r)&&!isAdmin(r)&&!isDoctor(r));
const writes=()=>routes.filter(r=>!isHealth(r)&&r.method!=='GET'&&r.method!=='HEAD');

async function livePatient(root=base,config=patientConfig){
 const email='r4-'+randomUUID()+'@example.invalid';
 const r=await jpost('/api/v1/auth/register',{email,password:patientPassword,full_name:'Synthetic R4 Patient'});assert.equal(r.status,201);
 const challenge=mail.find(m=>m.to===email&&m.purpose==='verify_email')!;assert.equal((await jpost('/api/v1/auth/verify-email',{token:challenge.token})).status,200);
 const login=await jpost('/api/v1/auth/login',{email,password:patientPassword},undefined,root);assert.equal(login.status,200);
 return {id:r.json().patient.id as string,email,access:login.json().access_token as string,refresh:login.json().refresh_token as string,config};
}
async function adminToken(){
 const email='r4-admin-'+randomUUID()+'@example.invalid';
 await createAdminAccount(owner,p=>passwords.hash(p),{email,fullName:'Synthetic Admin',role:'config_admin',password:adminPassword});
 const r=await jpost('/api/v1/admin/auth/login',{email,password:adminPassword});assert.equal(r.status,200);return r.json().access_token as string;
}
const sid=(token:string)=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sid as string;
async function forge(opts:{key?:Uint8Array;iss?:string;aud?:string;sub?:string;sid?:string|null;iat?:number;exp?:number}){
 const now=Math.floor(Date.now()/1000);
 return new SignJWT(opts.sid===null?{}:{sid:opts.sid}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(opts.sub??randomUUID()).setIssuer(opts.iss??patientConfig.jwtIssuer)
  .setAudience(opts.aud??patientConfig.jwtAudience).setIssuedAt(opts.iat??now).setExpirationTime(opts.exp??now+600).sign(opts.key??patientConfig.jwtKey);
}
const noneToken=(sub:string,s:string)=>{const b=(o:object)=>Buffer.from(JSON.stringify(o)).toString('base64url'),now=Math.floor(Date.now()/1000);
 return b({alg:'none',typ:'JWT'})+'.'+b({sub,sid:s,iss:patientConfig.jwtIssuer,aud:patientConfig.jwtAudience,iat:now,exp:now+600})+'.';};
/** Every protected patient route must answer 401 to this token; returns offenders. */
async function denied(token:string,expected=[401]){
 const bad:string[]=[];
 for(const r of patientRoutes()){const res=await call(r.method,concrete(r.path),{token,body:r.method==='GET'?undefined:'{}'});if(!expected.includes(res.status))bad.push(key(r)+' -> '+res.status);}
 return bad;
}

test('R4-01 the route inventory is complete and every public route is a deliberate exception',()=>{
 const keys=routes.map(key);assert.deepEqual(keys.filter((k,i)=>keys.indexOf(k)!==i),[],'each route is registered once');
 assert.ok(routes.length>=80,'routes enumerated: '+routes.length);
 for(const p of PUBLIC)assert.ok(keys.includes(p),'declared public route exists: '+p);
 for(const word of ['/documents','/timeline','/rag/queries','/doctor/records','/sharing/grants','/patients/me','/admin/patients','/guardian-notifications'])assert.ok(keys.some(k=>k.includes(word)),'covers '+word);
 assert.ok(patientRoutes().length>=30,'patient routes: '+patientRoutes().length+' '+keys.join(' ; '));
});

test('R4-02 no route outside the public list answers an anonymous caller with anything but 401/403, and none fails with 5xx',async()=>{
 const bad:string[]=[];
 for(const r of routes.filter(r=>!PUBLIC.has(key(r))&&!isHealth(r))){
  for(const variant of [{},{auth:'Bearer'},{auth:'Basic dGVzdDp0ZXN0'},{auth:'Bearer '+'a'.repeat(5000)}]){
   const res=await call(r.method,concrete(r.path),{...variant,body:r.method==='GET'?undefined:'{}'});
   if(![401,403].includes(res.status))bad.push(key(r)+' '+JSON.stringify(variant).slice(0,30)+' -> '+res.status);
  }
 }
 assert.deepEqual(bad,[]);
});

test('R4-03 forged, mis-scoped and malformed access tokens are refused on every protected patient route',async()=>{
 const p=await livePatient(),admin=await adminToken(),now=Math.floor(Date.now()/1000),s=sid(p.access);
 const cases:Record<string,string>={
  expired:await forge({sub:p.id,sid:s,iat:now-1000,exp:now-100}),
  'valid lifetime but issued in the future':await forge({sub:p.id,sid:s,iat:now+3600,exp:now+4000}),
  'lifetime longer than policy':await forge({sub:p.id,sid:s,iat:now-10,exp:now+10*86400}),
  'wrong key':await forge({sub:p.id,sid:s,key:randomBytes(32)}),
  'wrong issuer':await forge({sub:p.id,sid:s,iss:'someone-else'}),
  'wrong audience':await forge({sub:p.id,sid:s,aud:adminConfig.jwtAudience}),
  'no session claim':await forge({sub:p.id,sid:null}),
  'unknown session':await forge({sub:p.id,sid:randomUUID()}),
  'session of another patient':await forge({sub:(await livePatient()).id,sid:s}),
  'subject not a uuid':await forge({sub:'1 OR 1=1',sid:s}),
  'alg none':noneToken(p.id,s),
  'tampered signature':p.access.slice(0,-3)+(p.access.endsWith('AAA')?'BBB':'AAA'),
  'admin token':admin,
  'garbage':'a.b.c',
 };
 for(const [name,token] of Object.entries(cases))assert.deepEqual(await denied(token),[],name);
 assert.deepEqual(await denied(p.access,[200,201,202,204,400,404,409,415,422,429,503,401,403]).then(x=>x.filter(v=>/-> 5(?!03)/.test(v))),[],'the real token never causes a 5xx');
});

test('R4-04 a patient token can never reach admin routes, and an admin token never reaches patient routes',async()=>{
 const p=await livePatient(),admin=await adminToken();
 for(const r of routes.filter(r=>isAdmin(r)&&!PUBLIC.has(key(r)))){const res=await call(r.method,concrete(r.path),{token:p.access,body:r.method==='GET'?undefined:'{}'});assert.equal(res.status,401,key(r));}
 assert.deepEqual(await denied(admin),[]);
 for(const r of routes.filter(isDoctor)){const res=await call(r.method,concrete(r.path),{token:p.access,body:r.method==='GET'?undefined:'{}'});assert.ok([401,403].includes(res.status),key(r)+' '+res.status);}
});

test('R4-05 sessions that ended in any way stop working on every protected patient route',async()=>{
 const states:Record<string,(p:Awaited<ReturnType<typeof livePatient>>)=>Promise<void>>={
  'logout':async p=>{assert.equal((await jpost('/api/v1/auth/logout',{},p.access)).status,200);},
  'password change':async p=>{assert.equal((await jpost('/api/v1/auth/change-password',{current_password:patientPassword,new_password:'A brand new synthetic passphrase 55!'},p.access)).status,200);},
  'password reset':async p=>{await jpost('/api/v1/auth/forgot-password',{email:p.email});const m=[...mail].reverse().find(x=>x.to===p.email&&x.purpose==='reset_password')!;assert.equal((await jpost('/api/v1/auth/reset-password',{token:m.token,new_password:'Another new synthetic passphrase 66!'})).status,200);},
  'account suspended':async p=>{await owner.query("UPDATE public.patients SET account_status='suspended' WHERE id=$1",[p.id]);},
  'deletion requested':async p=>{assert.equal((await jpost('/api/v1/patients/me/deletion-request',{current_password:patientPassword,confirmation:'DELETE_MY_ACCOUNT'},p.access)).status,202);},
  'session revoked in database':async p=>{await owner.query('UPDATE public.patient_auth_sessions SET revoked_at=clock_timestamp() WHERE patient_id=$1',[p.id]);},
  'idle lifetime over':async p=>{await owner.query("UPDATE public.patient_auth_sessions SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE patient_id=$1",[p.id]);},
  'absolute lifetime over':async p=>{await owner.query("UPDATE public.patient_auth_sessions SET created_at=clock_timestamp()-interval '2 hours',idle_expires_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()-interval '1 second' WHERE patient_id=$1",[p.id]);},
  'security version raised':async p=>{await owner.query("UPDATE public.patients SET account_status='suspended' WHERE id=$1",[p.id]);await owner.query("UPDATE public.patients SET account_status='active' WHERE id=$1",[p.id]);},
  'email changed':async p=>{await owner.query("UPDATE public.patients SET email=$2 WHERE id=$1",[p.id,'changed-'+randomUUID()+'@example.invalid']);},
  'refresh token replayed':async p=>{const first=await jpost('/api/v1/auth/refresh',{refresh_token:p.refresh});assert.equal(first.status,200);assert.equal((await jpost('/api/v1/auth/refresh',{refresh_token:p.refresh})).status,401);},
 };
 for(const [name,change] of Object.entries(states)){
  const p=await livePatient();assert.equal((await call('GET','/api/v1/patients/me',{token:p.access})).status,200,name+': token worked first');
  await change(p);
  assert.deepEqual(await denied(p.access),[],name);
 }
});

test('R4-06 oversized, malformed and wrongly typed bodies are refused before any handler runs, on every write route',async()=>{
 const p=await livePatient(),big=JSON.stringify({x:'a'.repeat(110000)}),bad:string[]=[];
 for(const r of writes()){
  for(const token of [undefined,p.access]){
   const path=concrete(r.path);
   const check=async(name:string,res:{status:number},ok:number[])=>{if(!ok.includes(res.status))bad.push(key(r)+' '+name+' -> '+res.status);};
   await check('oversized',await call(r.method,path,{token,body:big}),[413]);
   await check('malformed json',await call(r.method,path,{token,body:'{"a":'}),[400]);
   await check('deeply nested',await call(r.method,path,{token,body:'['.repeat(40000)}),[400,413]);
   await check('invalid utf-8 charset',await call(r.method,path,{token,body:'{}',type:'application/json; charset=utf-16'}),[415,400]);
  }
  await call(r.method,concrete(r.path),{token:p.access,body:'x=1',type:'text/plain'}).then(res=>{if(serverFault(res)||(res.status>=200&&res.status<300))bad.push(key(r)+' text/plain -> '+res.status);});
 }
 assert.deepEqual(bad,[]);
 assert.equal((await call('GET','/api/v1/patients/me',{token:p.access})).status,200,'the session survived the abuse');
});

test('R4-07 unexpected body shapes, extra fields, junk path parameters and junk query strings never cause a 5xx or a leak',async()=>{
 const p=await livePatient(),admin=await adminToken(),bad:string[]=[];
 const junkParams=['not-a-uuid','%00','..%2f..%2fetc%2fpasswd','a'.repeat(3000),'00000000-0000-0000-0000-000000000000','%E0%A4%A','1;DROP TABLE patients'];
 const queries=['?limit=-1','?limit=abc','?limit=99999999999999999999','?offset=-5','?x[]=1&x[]=2','?q='+'z'.repeat(5000),'?cursor=%00','?status=%27OR%271%27=%271','?limit=1&limit=2','?category[$ne]=x','?from=not-a-date'];
 const bodies=['[]','null','"text"','123','{"__proto__":{"admin":true}}','{"constructor":{"prototype":{"x":1}}}','{"id":"'+randomUUID()+'","patient_id":"'+randomUUID()+'"}'];
 const flag=(name:string,res:{status:number;text:string})=>{if(serverFault(res))bad.push(name+' -> '+res.status);};
 for(const r of routes.filter(r=>!isHealth(r))){
  const token=isAdmin(r)?admin:p.access;
  if(/:/.test(r.path))for(const v of junkParams){
   if(r.method==='POST'&&/logout|revoke/.test(r.path)&&false)continue;
   flag(key(r)+' param '+v.slice(0,20),await call(r.method,r.path.replace(/:([A-Za-z]+)/g,v),{token,body:r.method==='GET'?undefined:'{"a":1}'}));
  }
  if(r.method==='GET')for(const q of queries)flag(key(r)+' '+q.slice(0,30),await call('GET',concrete(r.path)+q,{token}));
  else if(!PUBLIC.has(key(r))||true)for(const b of bodies){
   if(/\/auth\/logout$/.test(r.path))continue;     // an accepted-looking body would end the probe session; shapes are covered by the other routes
   flag(key(r)+' body '+b.slice(0,20),await call(r.method,concrete(r.path),{token:PUBLIC.has(key(r))?undefined:token,body:b}));
  }
 }
 assert.deepEqual(bad,[]);
});

test('R4-08 hostile text in registration and profile fields is rejected or stored inertly, never an error',async()=>{
 const hostile=['a\u0000b','line\r\nbreak','‮evil','<script>alert(1)</script>','\ud800','x'.repeat(5000),"Robert'); DROP TABLE patients;--",'​​','  ',''];
 for(const v of hostile){
  const email='r4-'+randomUUID()+'@example.invalid';
  const r=await jpost('/api/v1/auth/register',{email,password:patientPassword,full_name:v});assert.ok(r.status===201||r.status===400,JSON.stringify(v).slice(0,20)+' -> '+r.status);
  if(r.status===201)assert.ok(!r.text.includes('<script>')||r.json().patient.full_name==='<script>alert(1)</script>','stored as plain data only');
  const e=await jpost('/api/v1/auth/register',{email:v+'@example.invalid',password:patientPassword,full_name:'Synthetic'});assert.equal(e.status,400,'email '+JSON.stringify(v).slice(0,20));
  const pw=await jpost('/api/v1/auth/login',{email,password:v});assert.ok([400,401].includes(pw.status));
 }
 const p=await livePatient();
 for(const field of ['full_name','phone_number','date_of_birth','sex_gender','pending_guardian_email']){
  for(const v of ['a\u0000b','x'.repeat(2000),{a:1},[1],true,'\ud800']){
   const res=await call('PATCH','/api/v1/patients/me',{token:p.access,body:JSON.stringify({[field]:v})});assert.ok(res.status===400,field+' '+JSON.stringify(v).slice(0,20)+' -> '+res.status);
  }
 }
 assert.equal((await call('PATCH','/api/v1/patients/me',{token:p.access,body:JSON.stringify({role:'admin',account_status:'active',email:'x@example.invalid'})})).status,400,'privileged fields are not writable');
 const me=await call('GET','/api/v1/patients/me',{token:p.access});assert.ok(!me.text.includes('password'));
 assert.equal((await call('GET','/api/v1/patients/me?id='+randomUUID(),{token:p.access})).status,400);
});

test('R4-09 password reset, verification and resend are throttled by hashed, database-stored limits',async()=>{
 const email='r4-'+randomUUID()+'@example.invalid';
 await jpost('/api/v1/auth/register',{email,password:patientPassword,full_name:'Synthetic'},undefined,strictBase);
 const statuses:number[]=[];for(let i=0;i<7;i++)statuses.push((await jpost('/api/v1/auth/forgot-password',{email},undefined,strictBase)).status);
 assert.deepEqual(statuses,[202,202,202,202,202,429,429],'forgot-password allows 5 per window, then 429');
 const unknown=await jpost('/api/v1/auth/forgot-password',{email:'nobody-'+randomUUID()+'@example.invalid'},undefined,strictBase);assert.equal(unknown.status,429,'the limit is by caller as well as by address');
 const consume:number[]=[];for(let i=0;i<7;i++)consume.push((await jpost('/api/v1/auth/reset-password',{token:randomUUID()+'.'+'0'.repeat(64),new_password:'Another new synthetic passphrase 66!'},undefined,strictBase)).status);
 assert.deepEqual(consume,[400,400,400,400,400,429,429],'reset-password guesses are throttled after 5');
 const verify:number[]=[];for(let i=0;i<7;i++)verify.push((await jpost('/api/v1/auth/verify-email',{token:randomUUID()+'.'+'0'.repeat(64)},undefined,strictBase)).status);
 assert.deepEqual(verify,[400,400,400,400,400,429,429]);
 const rows=(await owner.query('SELECT bucket_hash FROM public.patient_auth_rate_limits')).rows;assert.ok(rows.length>=3);
 assert.ok(rows.every(r=>/^[a-f0-9]{64}$/.test(r.bucket_hash)),'buckets are stored as hashes');
 const secondInstance=await jpost('/api/v1/auth/forgot-password',{email},undefined,strictBase2);assert.equal(secondInstance.status,429,'a second API instance sees the same limit');
});

test('R4-10 doctor one-time-code submission is throttled per share link and address, and per challenge',async()=>{
 const ref='ds-'+randomUUID().replaceAll('-','')+randomBytes(8).toString('hex'),to='doctor-'+randomUUID()+'@example.invalid';
 const body={share_token:ref,email:to,challenge_id:randomUUID(),otp:randomUUID()+'.'+'1'.repeat(64)};
 const statuses:number[]=[];for(let i=0;i<32;i++)statuses.push((await jpost('/api/v1/sharing/otp/verify',body)).status);
 assert.ok(statuses.slice(0,30).every(s=>s===403),'first 30 guesses get the generic denial');
 assert.deepEqual(statuses.slice(30),[429,429],'31st guess is throttled');
 const other=await jpost('/api/v1/sharing/otp/verify',{...body,email:'other-'+randomUUID()+'@example.invalid'});assert.equal(other.status,403,'another address on the same link has its own bucket');
 const fresh={share_token:'ds-'+randomBytes(16).toString('hex'),email:to,challenge_id:randomUUID(),otp:randomUUID()+'.'+'1'.repeat(64)};
 for(const [name,bad] of Object.entries({'oversized code':{...fresh,otp:'x'.repeat(161)},'extra field':{...fresh,extra:1},'bad challenge id':{...fresh,challenge_id:'nope'},'bad email':{...fresh,email:'not-an-email'},'missing fields':{share_token:fresh.share_token},'code is not text':{...fresh,otp:12345}})){
  const r=await jpost('/api/v1/sharing/otp/verify',bad);assert.ok(r.status>=400&&r.status<500&&r.status!==429,name+' -> '+r.status);
 }
});

test('R4-11 record questions (RAG) are throttled per patient, stored by hash, and shared across API instances',async()=>{
 const p=await livePatient(strictBase,strictPatientConfig),q=(root:string)=>jpost('/api/v1/rag/queries',{question:'What are my glucose results?'},p.access,root);
 const statuses:number[]=[];for(let i=0;i<30;i++)statuses.push((await q(strictBase)).status);
 assert.ok(statuses.every(s=>s===503),'first 30 reach the (unconfigured) service: '+[...new Set(statuses)]);
 assert.equal((await q(strictBase)).status,429);assert.equal((await q(strictBase2)).status,429,'second instance shares the limit');
 assert.equal((await jpost('/api/v1/documents/'+randomUUID()+'/rag-index',{},p.access,strictBase)).status,429,'indexing shares the same budget');
 const other=await livePatient(strictBase,strictPatientConfig);assert.notEqual((await jpost('/api/v1/rag/queries',{question:'What are my glucose results?'},other.access,strictBase)).status,429,'another patient is not affected');
 assert.equal((await jpost('/api/v1/rag/queries',{question:'x'.repeat(1001)},other.access,strictBase)).status,400);
 assert.equal((await jpost('/api/v1/rag/queries',{question:'a\u0000b'},other.access,strictBase)).status,400);
 assert.equal((await jpost('/api/v1/rag/queries',{question:'ok',category:'secret'},other.access,strictBase)).status,400);
 assert.equal((await jpost('/api/v1/rag/queries',{question:'ok',patient_id:other.id},other.access,strictBase)).status,400);
});

test('R4-12 error responses stay generic: no driver text, stack, secret or hash anywhere',async()=>{
 const p=await livePatient();
 const probes=[['GET','/api/v1/documents/'+'9'.repeat(40)],['GET','/api/v1/patients/me%00'],['POST','/api/v1/auth/login'],['GET','/api/v1/nothing/here'],['PUT','/api/v1/patients/me'],['DELETE','/api/v1/documents/not-a-uuid']];
 for(const [m,path] of probes){const r=await call(m,path,{token:p.access,body:m==='GET'?undefined:'{"a":'});assert.ok(r.status>=400&&r.status<500,m+' '+path+' -> '+r.status);}
 const unknown=await call('GET','/api/v1/nothing/here',{token:p.access});assert.equal(unknown.status,404);assert.equal(unknown.json().error.code,'NOT_FOUND');
});

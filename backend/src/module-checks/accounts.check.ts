// Module 01 qualification: actual Express/auth/repository code, synthetic in-memory
// SQL port and loopback HTTP only. This is not PostgreSQL or mobile acceptance.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {randomBytes, randomUUID} from 'node:crypto';
import express from 'express';
import {SignJWT} from 'jose';
import type {QueryResultRow} from 'pg';
import type {AuthenticationConfig} from '../config/auth.js';
import type {PatientDatabase} from '../patients/repository.js';
import {createPatientRoutes} from '../auth/routes.js';
import {createTokenService} from '../auth/tokens.js';
import {errorHandler} from '../http/errors.js';

type Row={id:string;email:string;full_name:string;date_of_birth:string|null;phone_number:string|null;password_hash:string;created_at:Date;updated_at:Date};
async function fixture(rateLimitMax=100){
 const config:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'synthetic-module-01',jwtAudience:'synthetic-patient',argonMemoryKiB:19456,argonTimeCost:2,argonParallelism:1,maxHashConcurrency:2,rateLimitWindowMs:60000,rateLimitMax};
 const rows=new Map<string,Row>(), a=randomUUID(), b=randomUUID();let queries=0,fail=false;
 const password=randomBytes(24).toString('base64url');
 for(const [id,name]of [[a,'Synthetic A'],[b,'Synthetic B']])rows.set(id,{id,email:randomUUID()+'@example.invalid',full_name:name,date_of_birth:null,phone_number:null,password_hash:'not-a-real-hash',created_at:new Date(),updated_at:new Date()});
 const projection=(row:Row)=>{const {password_hash:_,...profile}=row;return profile;};
 const db:PatientDatabase={async query<R extends QueryResultRow>(sql:string,values:unknown[]){
  queries++;if(fail)throw Error('SYNTHETIC_PRIVATE_DRIVER_DETAIL');let result:unknown[]=[];
  if(sql.startsWith('INSERT INTO public.patients')){
   if([...rows.values()].some(row=>row.email===values[0]))throw Object.assign(new Error('Synthetic conflict'),{code:'23505'});
   const row:Row={id:randomUUID(),email:values[0] as string,password_hash:values[1] as string,full_name:values[2] as string,date_of_birth:values[3] as string|null,phone_number:values[4] as string|null,created_at:new Date(),updated_at:new Date()};rows.set(row.id,row);result=[projection(row)];
  }else if(sql==='SELECT id, password_hash FROM public.patients WHERE email = $1'){
   const row=[...rows.values()].find(row=>row.email===values[0]);result=row?[{id:row.id,password_hash:row.password_hash}]:[];
  }else{
   assert.ok(sql.includes('WHERE id = $1'),'Owner-scoped patient SQL required');
   assert.ok(!sql.includes('password_hash'),'Profile queries must project no credential column');
   const row=rows.get(values[0] as string);
   if(row&&sql.startsWith('UPDATE')){
    const keys=[...sql.matchAll(/(full_name|date_of_birth|phone_number) = \$(\d+)/g)];
    for(const key of keys)(row as any)[key[1]]=values[Number(key[2])-1];
   }
   if(row)result=[projection(row)];
  }
  return {rows:result as R[]};
 }};
 const app=express();app.use(express.json({limit:'16kb'}));app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const routes=createPatientRoutes(db,config);app.use('/api/v1/auth',routes.auth);app.use('/api/v1/patients',routes.profile);
 app.use((_req,res)=>res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Resource not found.'}}));app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const base='http://127.0.0.1:'+address.port,tokens=createTokenService(config),tokenA=await tokens.issue(a),tokenB=await tokens.issue(b);
 async function request(path:string,method='GET',body?:unknown,token?:string){
  const response=await fetch(base+path,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(5000)});
  const data=await response.json() as any;
  assert.ok(response.headers.get('cache-control')?.includes('no-store'),'Sensitive response must not be cached');
  const raw=JSON.stringify(data);
  assert.ok(!raw.includes(password)&&!raw.includes('password_hash')&&!raw.includes('$argon2')&&!raw.includes('SYNTHETIC_PRIVATE_DRIVER_DETAIL'),'Response redaction required');
  return {status:response.status,data};
 }
 return {config,rows,a,b,tokens,tokenA,tokenB,password,request,get queries(){return queries;},set fail(value:boolean){fail=value;},registration:{email:'synthetic-'+randomUUID()+'@example.invalid',password,full_name:'Synthetic Patient'},async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
async function use(fn:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,limit=100){const f=await fixture(limit);try{await fn(f);}finally{await f.close();}}

test('M01 registration persists one normalized profile with a real password hash',()=>use(async f=>{
 const r=await f.request('/api/v1/auth/register','POST',{...f.registration,email:'  '+f.registration.email.toUpperCase()+'  '});assert.equal(r.status,201);assert.ok(r.data.patient.email===f.registration.email);const stored=f.rows.get(r.data.patient.id);assert.ok(stored?.password_hash.startsWith('$argon2id$'));assert.equal(f.rows.size,3);
}));
test('M01 duplicate registration is a safe conflict and never an implicit login',()=>use(async f=>{
 await f.request('/api/v1/auth/register','POST',f.registration);const r=await f.request('/api/v1/auth/register','POST',f.registration);assert.equal(r.status,409);assert.equal(r.data.error.code,'REGISTRATION_CONFLICT');assert.ok(!('access_token'in r.data));assert.equal(f.rows.size,3);
}));
test('M01 malformed registrations never reach persistence',()=>use(async f=>{
 for(const body of [{},null,[],{...f.registration,patient_id:f.b},{...f.registration,password:'short'},{...f.registration,date_of_birth:'2026-02-30'},{...f.registration,full_name:' '},{...f.registration,email:'bad'}])assert.equal((await f.request('/api/v1/auth/register','POST',body)).status,400);assert.equal(f.queries,0);
}));
test('M01 successful login yields only the bounded patient token contract',()=>use(async f=>{
 const created=await f.request('/api/v1/auth/register','POST',f.registration);const r=await f.request('/api/v1/auth/login','POST',{email:f.registration.email,password:f.password});assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data).sort(),['access_token','expires_in','success','token_type']);assert.equal(r.data.expires_in,900);assert.equal(r.data.token_type,'Bearer');assert.ok(await f.tokens.verify(r.data.access_token)===created.data.patient.id);
}));
test('M01 unknown account and incorrect password have identical safe errors',()=>use(async f=>{
 await f.request('/api/v1/auth/register','POST',f.registration);const one=await f.request('/api/v1/auth/login','POST',{email:f.registration.email,password:'synthetic-wrong-password'}),two=await f.request('/api/v1/auth/login','POST',{email:'unknown@example.invalid',password:'synthetic-wrong-password'});assert.equal(one.status,401);assert.equal(two.status,401);assert.ok(JSON.stringify(one.data)===JSON.stringify(two.data));
}));
test('M01 anonymous malformed and tampered sessions cannot reach profiles',()=>use(async f=>{
 for(const token of [undefined,'invalid',f.tokenA+'.invalid'])assert.equal((await f.request('/api/v1/patients/me','GET',undefined,token)).status,401);assert.equal(f.queries,0);
}));
test('M01 patient identities retrieve distinct own profiles',()=>use(async f=>{
 const a=await f.request('/api/v1/patients/me','GET',undefined,f.tokenA),b=await f.request('/api/v1/patients/me','GET',undefined,f.tokenB);assert.equal(a.status,200);assert.equal(b.status,200);assert.ok(a.data.patient.id===f.a&&b.data.patient.id===f.b);assert.ok(a.data.patient.id!==b.data.patient.id);
}));
test('M01 profile edits cannot affect the other patient',()=>use(async f=>{
 const previous=f.rows.get(f.b)!.full_name;const r=await f.request('/api/v1/patients/me','PATCH',{full_name:'Synthetic Updated'},f.tokenA);assert.equal(r.status,200);assert.equal(f.rows.get(f.a)!.full_name,'Synthetic Updated');assert.ok(f.rows.get(f.b)!.full_name===previous);
}));
test('M01 owner email password and unknown profile fields are rejected',()=>use(async f=>{
 for(const body of [{patient_id:f.b},{id:f.b},{email:'other@example.invalid'},{password:'synthetic-replacement-password'},{password_hash:'synthetic'},{unknown:true},{}])assert.equal((await f.request('/api/v1/patients/me','PATCH',body,f.tokenA)).status,400);assert.equal(f.queries,0);
}));
test('M01 optional fields can be cleared without altering ownership',()=>use(async f=>{
 const r=await f.request('/api/v1/patients/me','PATCH',{date_of_birth:null,phone_number:null},f.tokenA);assert.equal(r.status,200);assert.ok(r.data.patient.id===f.a);assert.equal(r.data.patient.date_of_birth,null);assert.equal(r.data.patient.phone_number,null);
}));
test('M01 selectors on existing auth and profile paths fail before persistence',()=>use(async f=>{
 for(const path of ['/api/v1/patients/me?patient_id='+f.b,'/api/v1/patients/me?token=synthetic'])assert.equal((await f.request(path,'GET',undefined,f.tokenA)).status,400);
 assert.equal((await f.request('/api/v1/auth/register?patient_id='+f.b,'POST',f.registration)).status,400);assert.equal(f.queries,0);
}));
test('M01 removed own profile is safely unavailable',()=>use(async f=>{
 f.rows.delete(f.a);const r=await f.request('/api/v1/patients/me','GET',undefined,f.tokenA);assert.equal(r.status,404);assert.equal(r.data.error.code,'PROFILE_NOT_FOUND');
}));
test('M01 driver failures are redacted at the existing error boundary',()=>use(async f=>{
 f.fail=true;const r=await f.request('/api/v1/patients/me','GET',undefined,f.tokenA);assert.equal(r.status,500);assert.equal(r.data.error.code,'INTERNAL_ERROR');
}));
test('M01 authentication rate limit refuses excess requests',()=>use(async f=>{
 for(let i=0;i<2;i++)assert.equal((await f.request('/api/v1/auth/login','POST',{})).status,400);const r=await f.request('/api/v1/auth/login','POST',{});assert.equal(r.status,429);assert.equal(r.data.error.code,'RATE_LIMITED');assert.equal(f.queries,0);
},2));
test('M01 expired future wrong-audience and foreign-key tokens fail closed',()=>use(async f=>{
 const now=Math.floor(Date.now()/1000);const base={sub:f.a,iss:f.config.jwtIssuer,aud:f.config.jwtAudience,iat:now,exp:now+900};
 for(const [changes,key]of [[{iat:now-1000,exp:now-100},f.config.jwtKey],[{iat:now+100,exp:now+200},f.config.jwtKey],[{aud:'another-service'},f.config.jwtKey],[{},randomBytes(32)],[{sub:'not-a-uuid'},f.config.jwtKey]] as const){
  const token=await new SignJWT({...base,...changes}).setProtectedHeader({alg:'HS256',typ:'JWT'}).sign(key);assert.equal((await f.request('/api/v1/patients/me','GET',undefined,token)).status,401);
 }assert.equal(f.queries,0);
}));
test('M01 JSON field allowlists reject prompt and foreign selectors on login',()=>use(async f=>{
 for(const extra of [{patient_id:f.b},{prompt:'synthetic ignored command'},{model:'unapproved'}])assert.equal((await f.request('/api/v1/auth/login','POST',{email:f.registration.email,password:f.password,...extra})).status,400);assert.equal(f.queries,0);
}));

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createApp} from '../app.js';
import {closeDatabasePool} from '../database/pool.js';
import {getDatabaseConfig} from '../config/env.js';
import {getAuthenticationConfig} from '../config/auth.js';
import {createTokenService} from '../auth/tokens.js';
import {getProcessingConfig} from '../processing/config.js';
import {createProcessingRepository} from '../processing/repository.js';
import {createProcessingService} from '../processing/service.js';
import {createSummaryJobRepository,defaultSummaryJobConfig,type SummarySnapshot} from '../summaries/jobs.js';
import {createSummaryClient,fakeSummaryRecipe,SummaryClientError,type SummaryTransport} from '../summaries/client.js';
import {createSummaryExecutor,defaultSummaryExecutorConfig} from '../summaries/executor.js';
import {canonicalSummaryJson,parseSummaryJson} from '../summaries/validation.js';
import type {SummaryApiOptions} from '../summaries/routes.js';
const {assertIsolated}=await import(new URL('../../../infrastructure/stage-b/isolation.ts',import.meta.url).href);
await assertIsolated();await assertIsolated(true);
const pool=new pg.Pool({...getDatabaseConfig(),max:12,connectionTimeoutMillis:3000,statement_timeout:7000});
const golden=JSON.parse(await readFile(new URL('../../../shared/medical-summary/fixtures.json',import.meta.url),'utf8')).cases[0];
const auth={...getAuthenticationConfig(),jwtKey:new Uint8Array(randomBytes(32))};
const tokens=createTokenService(auth),patients:string[]=[],servers:ReturnType<ReturnType<typeof createApp>['listen']>[]=[],executors:ReturnType<typeof createSummaryExecutor>[]=[];
const {input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));
function catalogue(s:Readonly<SummarySnapshot>){const a=structuredClone(golden.input.facts);const walk=(v:any)=>{if(v&&typeof v==='object'){if('source_ref'in v)v.source_ref=s.id;Object.values(v).forEach(walk);}};walk(a);return a;}
async function fixture(completed=true){
 const patient=randomUUID(),doc=randomUUID();patients.push(patient);
 await pool.query("INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic API patient')",[patient,patient+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
 await pool.query("INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category) VALUES($1::uuid,$2,'synthetic-summary-api',$1::uuid::text,'synthetic.pdf','pdf','lab_report')",[doc,patient]);
 const r=createSummaryJobRepository(pool,patient,{...defaultSummaryJobConfig,retryBaseMs:5,retryMaxMs:10});
 if(completed){const service=createProcessingService(createProcessingRepository(pool,getProcessingConfig(),patient));const j=(await service.claim())!;await service.persistExtraction({documentId:doc,patientId:patient,token:j.lease_token!},{text:golden.input.source.text,method:'pdf_text',extractor:{name:'synthetic-api',version:'fixture-v1'},source:{sha256:'a'.repeat(64),pageCount:1,pages:[{page:1,method:'pdf_text'}]}});}
 return {patient,doc,r,token:await tokens.issue(patient)};
}
async function app(options:SummaryApiOptions={}){
 const api=createApp({auth,database:pool,documentDatabase:pool,documentStorage:null,summaries:{enabled:true,database:pool,catalogue,requestLimit:100,...options}});
 const server=api.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');const a=server.address() as any;return 'http://127.0.0.1:'+a.port;
}
async function http(base:string,path:string,method='GET',body?:unknown,token?:string){
 const headers:Record<string,string>={};if(token)headers.authorization='Bearer '+token;if(body!==undefined)headers['content-type']='application/json';
 const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data:any=await response.json();
 assert.equal(response.headers.get('cache-control'),'no-store');
 const text=JSON.stringify(data);for(const secret of [token,'a'.repeat(64)].filter(Boolean) as string[])assert.equal(text.includes(secret),false);
 const forbidden=['patient_id','canonical_input','lease_token','publication_token','scope_token','extracted_text','source_metadata','pipeline_config','attempt_count','attempt_deadline_at','s3_object_key','input_sha256'];
 for(const key of forbidden)assert.equal(text.includes('"'+key+'":'),false);
 return {status:response.status,data};
}
const post=(base:string,f:Awaited<ReturnType<typeof fixture>>,body:unknown={})=>http(base,`/api/v1/documents/${f.doc}/summary-jobs`,'POST',body,f.token);
function transport(outputChange?:(v:any)=>any):SummaryTransport{return async request=>{
 if(request.headers.authorization!=='Bearer '+'a'.repeat(64))return {status:401,body:(async function*(){yield Buffer.from('{}');})()};
 const input=parseSummaryJson(request.body,'input') as any;
 const output={...structuredClone(golden.output),scope:input.scope,reported_findings:input.facts,provenance:fakeSummaryRecipe(request.headers['x-summary-input-sha256'])};
 const candidate=outputChange?outputChange(output):output;
 return {status:200,body:(async function*(){yield Buffer.from(canonicalSummaryJson(candidate));})()};
};}
function executor(f:Awaited<ReturnType<typeof fixture>>,t:SummaryTransport=transport(),extra:any={},repository=f.r){
 const e=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:f.patient,heartbeatMs:20,attemptMs:3000,drainMs:1000,pollMs:20,...extra},{repository,client:createSummaryClient({enabled:true,token:'a'.repeat(64),timeoutMs:2000},t)});executors.push(e);return e;
}
async function queue(f:Awaited<ReturnType<typeof fixture>>){const s=await f.r.captureSnapshot(f.doc);return f.r.enqueue(s.id,catalogue(s),pipeline);}
async function replace(f:Awaited<ReturnType<typeof fixture>>){const claim=randomUUID();await pool.query("UPDATE public.document_processing_jobs SET state='running',attempt_count=attempt_count+1,started_at=clock_timestamp(),finished_at=NULL,lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute',attempt_deadline_at=clock_timestamp()+interval '5 minutes' WHERE document_id=$1",[f.doc,claim]);await pool.query("UPDATE public.medical_documents SET processing_status='processing' WHERE id=$1",[f.doc]);await createProcessingService(createProcessingRepository(pool,getProcessingConfig(),f.patient)).persistExtraction({documentId:f.doc,patientId:f.patient,token:claim},{text:golden.input.source.text+'\nSynthetic revision.',method:'pdf_text',extractor:{name:'synthetic-api',version:'fixture-v1'},source:{sha256:'b'.repeat(64),pageCount:1,pages:[{page:1,method:'pdf_text'}]}});}
const blocked=(entered:()=>void,cancelled:()=>void):SummaryTransport=>request=>new Promise((_resolve,reject)=>{entered();const abort=()=>{cancelled();reject(new Error('SYNTHETIC_CANCELLED'));};if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});});
async function until(check:()=>boolean|Promise<boolean>,ms=3000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(5);}throw Error('Synthetic condition not observed');}


test('B03.3 controlled residual failure characterization',{timeout:60000},async t=>{
 t.afterEach(async()=>{
  for(const e of executors.splice(0))assert.equal((await e.stop(true)).drained,true);
  const rows=(await pool.query("SELECT id,patient_id FROM public.medical_summary_jobs WHERE patient_id=ANY($1::uuid[]) AND state IN ('pending','running','retry_wait')",[patients])).rows;
  for(const row of rows)await createSummaryJobRepository(pool,row.patient_id).cancel(row.id);
 });
 try{
 await t.test('gated heartbeat observer can consume a committed lease without a production defect',async t=>{
  const f=await fixture(),r=createSummaryJobRepository(pool,f.patient,{...defaultSummaryJobConfig,leaseMs:300,attemptMs:3000});
  const s=await r.captureSnapshot(f.doc),job=await r.enqueue(s.id,catalogue(s),pipeline);
  let committed=false,held=false,expired=false,cancelled=false,renewals=0;
  const observed={...r,async heartbeat(c:Parameters<typeof r.heartbeat>[0]){
   const ok=await r.heartbeat(c);if(!ok)return false;renewals++;committed=true;held=true;
   // Hold the same awaited observer position as the historical test, until
   // an independently observed DB-clock expiry. No lease/token mutation.
   await until(async()=>{const row=(await pool.query<{expired:boolean}>(
    'SELECT lease_expires_at<=clock_timestamp() AS expired FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2',[job.id,f.patient])).rows[0];return expired=row.expired;});
   held=false;return true;
  }};
  const e=executor(f,blocked(()=>{},()=>cancelled=true),{heartbeatMs:30},observed);
  const result=await e.runOnce();assert.equal(result,'lease-lost');assert.equal(committed,true);assert.equal(expired,true);assert.equal(held,false);assert.equal(renewals,1);assert.equal(cancelled,true);
  assert.equal((await e.stop(true)).drained,true);assert.equal((await r.summaries(f.doc)).length,0);
  const row=(await pool.query<{expired:boolean;state:string}>(
   'SELECT lease_expires_at<=clock_timestamp() AS expired,state FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2',[job.id,f.patient])).rows[0];
  assert.equal(row.expired,true);assert.equal(row.state,'running');
  t.diagnostic(JSON.stringify({kind:'b033-gated-characterization',committed,expired,renewals,result,cancelled,publication_count:0,drained:true}));
 });
 await t.test('a due retry is legitimately idle while its exact row is locked and succeeds after release',async t=>{
  const f=await fixture(),j=await queue(f),failed=executor(f,async()=>({status:503,body:(async function*(){yield Buffer.from('{}');})()}));
  assert.equal(await failed.runOnce(),'failed');assert.equal((await failed.stop(true)).drained,true);
  await until(async()=>(await pool.query<{due:boolean}>('SELECT next_attempt_at<=clock_timestamp() AS due FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2',[j.id,f.patient])).rows[0].due);
  const lock=await pool.connect(),e=executor(f);let result:string;
  try{await lock.query('BEGIN');await lock.query('SELECT id FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2 FOR UPDATE',[j.id,f.patient]);
   result=await e.runOnce();assert.equal(result,'idle');const row=(await f.r.getJob(j.id))!;assert.equal(row.state,'retry_wait');assert.equal(row.attempt_count,1);assert.equal((await f.r.summaries(f.doc)).length,0);
  }finally{await lock.query('ROLLBACK');lock.release();}
  assert.equal(await e.runOnce(),'completed');assert.equal((await e.stop(true)).drained,true);assert.equal((await f.r.getJob(j.id))!.attempt_count,2);assert.equal((await f.r.summaries(f.doc)).length,1);
  t.diagnostic(JSON.stringify({kind:'b033-locked-retry-characterization',due:true,prior_drained:true,locked_result:'idle',released_result:'completed',attempts:2,publication_count:1}));
 });
 }finally{await pool.end();await closeDatabasePool();}
});

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

test('Patient summary APIs and isolated fake executor',{timeout:180000},async t=>{
 t.afterEach(async()=>{
  for(const e of executors.splice(0))assert.equal((await e.stop(true)).drained,true);
  for(const s of servers.splice(0))await new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()));
  const rows=(await pool.query("SELECT id,patient_id FROM public.medical_summary_jobs WHERE patient_id=ANY($1::uuid[]) AND state IN ('pending','running','retry_wait')",[patients])).rows;
  for(const row of rows)await createSummaryJobRepository(pool,row.patient_id).cancel(row.id);
 });
 try{
 await t.test('unauthorized requests fail before summary operations',async()=>{const f=await fixture(),b=await app();for(const [path,method,body]of [[`/documents/${f.doc}/summary-jobs`,'POST',{}],[`/documents/${f.doc}/summary`,'GET',undefined],[`/summary-jobs/${randomUUID()}`,'GET',undefined]] as const){const r=await http(b,'/api/v1'+path,method,body);assert.equal(r.status,401);assert.equal(r.data.error.code,'UNAUTHORIZED');}assert.equal((await f.r.discover()).length,0);});
 await t.test('disabled API refuses enqueue and creates no jobs',async()=>{const f=await fixture(),b=await app({enabled:false});assert.equal((await post(b,f)).status,503);assert.equal((await f.r.discover()).length,0);});
 await t.test('API enablement requires explicit database and catalogue',async()=>{assert.throws(()=>createApp({auth,database:pool,documentStorage:null,summaries:{enabled:true}}),/^Error: Invalid summary API configuration/);});
 await t.test('foreign and unknown documents return identical 404',async()=>{const f=await fixture(),g=await fixture(),b=await app();for(const suffix of ['/summary-jobs','/summary']){const method=suffix==='/summary'?'GET':'POST';const a=await http(b,`/api/v1/documents/${g.doc}${suffix}`,method,method==='POST'?{}:undefined,f.token),unknown=await http(b,`/api/v1/documents/${randomUUID()}${suffix}`,method,method==='POST'?{}:undefined,f.token);assert.equal(a.status,404);assert.equal(JSON.stringify(a.data)===JSON.stringify(unknown.data),true);}});
 await t.test('new job is 202 with safe public projection',async()=>{const f=await fixture(),b=await app(),r=await post(b,f);assert.equal(r.status,202);assert.equal(r.data.existing,false);assert.equal(r.data.job.status,'queued');assert.equal(Object.keys(r.data.job).sort().join(','),'document_id,id,status');});
 await t.test('duplicate requests reuse the same patient-scoped job',async()=>{const f=await fixture(),b=await app();const results=await Promise.all(Array.from({length:6},()=>post(b,f)));assert.equal(results.filter(r=>r.status===202).length,1);assert.equal(new Set(results.map(r=>r.data.job.id)).size,1);assert.equal(results.filter(r=>r.status===200).length,5);});
 await t.test('foreign and unknown job IDs return identical 404',async()=>{const f=await fixture(),g=await fixture(),j=await queue(g),b=await app();const a=await http(b,`/api/v1/summary-jobs/${j.id}`,'GET',undefined,f.token),unknown=await http(b,`/api/v1/summary-jobs/${randomUUID()}`,'GET',undefined,f.token);assert.equal(a.status,404);assert.equal(JSON.stringify(a.data)===JSON.stringify(unknown.data),true);});
 await t.test('pending extraction returns 409 and no snapshot/job',async()=>{const f=await fixture(false),b=await app();assert.equal((await post(b,f)).status,409);assert.equal((await f.r.discover()).length,0);});
 await t.test('legacy completed extraction without attempt association is ineligible',async()=>{const b=await app(),owner='11111111-1111-4111-8111-111111111111';const r=await http(b,'/api/v1/documents/22222222-2222-4222-8222-222222222222/summary-jobs','POST',{},await tokens.issue(owner));assert.equal(r.status,409);});
 await t.test('unknown client fields cannot select authority or model',async()=>{const f=await fixture(),b=await app();for(const key of ['patient_id','medical_text','prompt','model','source_ref','scope_token','jwt','s3_object_key']){const r=await post(b,f,{[key]:'SYNTHETIC_SECRET_SENTINEL'});assert.equal(r.status,400);assert.equal(JSON.stringify(r.data).includes('SYNTHETIC_SECRET_SENTINEL'),false);}for(const body of [null,[],42,'synthetic'])assert.equal((await post(b,f,body)).status,400);});
 await t.test('query parameters and malformed IDs are refused',async()=>{const f=await fixture(),b=await app();assert.equal((await http(b,`/api/v1/documents/${f.doc}/summary?patient_id=synthetic`,'GET',undefined,f.token)).status,400);assert.equal((await http(b,'/api/v1/summary-jobs/invalid','GET',undefined,f.token)).status,404);});
 await t.test('request quota is patient-scoped and never changes ownership 404',async()=>{const f=await fixture(),g=await fixture(),b=await app({requestLimit:1});assert.equal((await post(b,f)).status,202);assert.equal((await post(b,f)).status,429);assert.equal((await post(b,g)).status,202);const a=await http(b,`/api/v1/documents/${g.doc}/summary-jobs`,'POST',{},f.token),u=await http(b,`/api/v1/documents/${randomUUID()}/summary-jobs`,'POST',{},f.token);assert.equal(a.status,404);assert.equal(JSON.stringify(a.data)===JSON.stringify(u.data),true);});
 await t.test('status polling is separately rate limited',async()=>{const f=await fixture(),j=await queue(f),b=await app({readLimit:1});assert.equal((await http(b,`/api/v1/summary-jobs/${j.id}`,'GET',undefined,f.token)).status,200);assert.equal((await http(b,`/api/v1/summary-jobs/${j.id}`,'GET',undefined,f.token)).status,429);});
 await t.test('missing accepted summary returns private 404',async()=>{const f=await fixture(),b=await app();assert.equal((await http(b,`/api/v1/documents/${f.doc}/summary`,'GET',undefined,f.token)).status,404);});
 await t.test('unconfigured catalogue failures are privacy-safe and do not enqueue',async()=>{const f=await fixture(),b=await app({catalogue(){throw Error('SYNTHETIC_SECRET_SENTINEL');}});const r=await post(b,f);assert.equal(r.status,503);assert.equal(JSON.stringify(r.data).includes('SYNTHETIC_SECRET_SENTINEL'),false);assert.equal((await f.r.discover()).length,0);});
 await t.test('API request through fake transport publishes and retrieves safely',async()=>{const f=await fixture(),b=await app(),a=await post(b,f);assert.equal(await executor(f).runOnce(),'completed');const status=await http(b,`/api/v1/summary-jobs/${a.data.job.id}`,'GET',undefined,f.token);assert.equal(status.data.job.status,'completed');const result=await http(b,`/api/v1/documents/${f.doc}/summary`,'GET',undefined,f.token);assert.equal(result.status,200);assert.equal(result.data.summary.is_current,true);assert.equal(typeof result.data.summary.text,'string');const duplicate=await post(b,f);assert.equal(duplicate.status,200);assert.equal(duplicate.data.job.status,'completed');assert.equal((await f.r.summaries(f.doc)).length,1);});
 await t.test('concurrent executor invocations admit only one model generation',async()=>{const f=await fixture();await queue(f);let entered=false,cancelled=false;const e=executor(f,blocked(()=>entered=true,()=>cancelled=true));const first=e.runOnce();await until(()=>entered);assert.equal(await e.runOnce(),'busy');await e.stop(true);await first;assert.equal(cancelled,true);});
 await t.test('transient fake service failures schedule bounded retry and later succeed',async t=>{
  const f=await fixture(),j=await queue(f);
  const failed=executor(f,async()=>({status:503,body:(async function*(){yield Buffer.from('{}');})()}));
  assert.equal(await failed.runOnce(),'failed');
  assert.equal((await f.r.getJob(j.id))!.state,'retry_wait');
  // Completion can precede the last heartbeat's COMMIT/row-lock release.
  // Establish drain and database-clock eligibility; a fixed 20 ms proves neither.
  assert.equal((await failed.stop(true)).drained,true);
  await until(async()=>(await pool.query<{due:boolean}>(
   'SELECT next_attempt_at<=clock_timestamp() AS due FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2',[j.id,f.patient])).rows[0].due);
  assert.equal((await f.r.getJob(j.id))!.attempt_count,1);
  const retry=executor(f);assert.equal(await retry.runOnce(),'completed');
  assert.equal((await retry.stop(true)).drained,true);
  assert.equal((await f.r.getJob(j.id))!.attempt_count,2);
  assert.equal((await f.r.summaries(f.doc)).length,1);
  t.diagnostic(JSON.stringify({kind:'b033-retry-proof',prior_drained:true,database_due:true,attempts:2,publication_count:1}));
 });
 await t.test('authentication failure is permanent and never automatically retried',async()=>{const f=await fixture(),j=await queue(f);await executor(f,async()=>({status:401,body:(async function*(){yield Buffer.from('{}');})()})).runOnce();assert.equal((await f.r.getJob(j.id))!.state,'failed');assert.equal(await executor(f).runOnce(),'idle');});
 await t.test('invalid grounded candidate fails permanently without publication',async()=>{const f=await fixture(),j=await queue(f);await executor(f,transport(out=>{out.reported_findings[0].measurement.value.decimal='999.99';return out;})).runOnce();assert.equal((await f.r.getJob(j.id))!.state,'failed');assert.equal((await f.r.summaries(f.doc)).length,0);});
 await t.test('provider deadline cancels generation and schedules retry',async()=>{const f=await fixture(),j=await queue(f);let cancelled=false;const e=executor(f,blocked(()=>{},()=>cancelled=true),{attemptMs:100});await e.runOnce();assert.equal(cancelled,true);assert.equal((await f.r.getJob(j.id))!.state,'retry_wait');assert.equal((await f.r.summaries(f.doc)).length,0);});
 await t.test('shutdown cancels work and drains all fake transport resources',async()=>{const f=await fixture(),j=await queue(f);let entered=false,cancelled=false;const e=executor(f,blocked(()=>entered=true,()=>cancelled=true));const work=e.runOnce();await until(()=>entered);assert.equal((await e.stop(true)).drained,true);assert.equal(await work,'interrupted');assert.equal(cancelled,true);assert.equal((await f.r.getJob(j.id))!.state,'retry_wait');});
 await t.test('heartbeat failure cancels generation without stale publication',async()=>{const f=await fixture(),j=await queue(f);let cancelled=false;const e=executor(f,blocked(()=>{},()=>cancelled=true),{}, {...f.r,async heartbeat(){return false;}});assert.equal(await e.runOnce(),'lease-lost');assert.equal(cancelled,true);assert.equal((await f.r.summaries(f.doc)).length,0);await f.r.cancel(j.id);});
 await t.test('heartbeat extends a genuinely short lease during slow generation',async()=>{const f=await fixture();const r=createSummaryJobRepository(pool,f.patient,{...defaultSummaryJobConfig,leaseMs:300,attemptMs:3000});const s=await r.captureSnapshot(f.doc);await r.enqueue(s.id,catalogue(s),pipeline);const mock=transport();const e=executor(f,async request=>{await delay(650,undefined,{signal:request.signal});return mock(request);},{heartbeatMs:30},r);assert.equal(await e.runOnce(),'completed');});
 await t.test('committed renewals span multiple lease periods before publication',async t=>{
  const f=await fixture(),leaseMs=300;
  const r=createSummaryJobRepository(pool,f.patient,{...defaultSummaryJobConfig,leaseMs,attemptMs:3000});
  const snapshot=await r.captureSnapshot(f.doc),job=await r.enqueue(snapshot.id,catalogue(snapshot),pipeline);
  let renewals=0,elapsedMs=0;
  // Count only acknowledged commits; never await diagnostic I/O inside heartbeat.
  // An awaited observer is part of the in-flight renewal and suppresses the next
  // renewal. The separate expiry characterization proves that can lose a lease.
  const observed={...r,async heartbeat(c:Parameters<typeof r.heartbeat>[0]){
   const ok=await r.heartbeat(c);if(ok)renewals++;return ok;
  }};
  const mock=transport(),e=executor(f,async request=>{
   await until(async()=>{
    if(request.signal.aborted)throw new SummaryClientError('CANCELLED');
    const row=(await pool.query<{elapsed_ms:string;remaining_ms:string}>(`SELECT
     (EXTRACT(EPOCH FROM (clock_timestamp()-started_at))*1000)::text AS elapsed_ms,
     (EXTRACT(EPOCH FROM (lease_expires_at-clock_timestamp()))*1000)::text AS remaining_ms
     FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2`,[job.id,f.patient])).rows[0];
    elapsedMs=Number(row.elapsed_ms);
    return renewals>=3&&elapsedMs>=650&&Number(row.remaining_ms)>0;
   });return mock(request);
  },{heartbeatMs:30},observed);
  assert.equal(await e.runOnce(),'completed');assert.equal((await e.stop(true)).drained,true);
  assert.ok(renewals>=3);assert.ok(elapsedMs>=2*leaseMs);assert.equal((await r.summaries(f.doc)).length,1);
  t.diagnostic(JSON.stringify({kind:'b033-renewal-proof',lease_ms:leaseMs,heartbeat_ms:30,renewals,elapsed_db_ms:elapsedMs}));
 });
 await t.test('database-expired heartbeat cancels the provider without publication',async()=>{
  const f=await fixture(),job=await queue(f);let entered=false,cancelled=false;
  const e=executor(f,blocked(()=>entered=true,()=>cancelled=true));const work=e.runOnce();await until(()=>entered);
  await pool.query("UPDATE public.medical_summary_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1 AND patient_id=$2",[job.id,f.patient]);
  assert.equal(await work,'lease-lost');assert.equal(cancelled,true);assert.equal((await f.r.summaries(f.doc)).length,0);
  assert.equal((await e.stop(true)).drained,true);await f.r.cancel(job.id);
 });
 await t.test('source replacement during generation cannot publish',async()=>{const f=await fixture(),j=await queue(f);let entered=false,cancelled=false;const e=executor(f,blocked(()=>entered=true,()=>cancelled=true));const work=e.runOnce();await until(()=>entered);await replace(f);assert.equal(await work,'lease-lost');assert.equal(cancelled,true);await f.r.recover();assert.equal((await f.r.getJob(j.id))!.state,'superseded');assert.equal((await f.r.summaries(f.doc)).length,0);});
 await t.test('stale worker fenced after recovery and a new attempt',async()=>{const f=await fixture(),j=await queue(f);const old=(await f.r.claim())!;await pool.query("UPDATE public.medical_summary_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[j.id]);await f.r.recover();await delay(20);assert.equal(await executor(f).runOnce(),'completed');assert.equal(await f.r.publish({jobId:old.id,token:old.lease_token!},{}),false);assert.equal((await f.r.summaries(f.doc)).length,1);});
 await t.test('later generation failure preserves accepted summary as superseded history',async()=>{const f=await fixture(),b=await app();await post(b,f);await executor(f).runOnce();const first=(await f.r.summaries(f.doc))[0].id;await replace(f);await post(b,f);await executor(f,transport(out=>({...out,advice:'unsupported'}))).runOnce();const result=await http(b,`/api/v1/documents/${f.doc}/summary`,'GET',undefined,f.token);assert.equal(result.status,200);assert.equal(result.data.summary.id,first);assert.equal(result.data.summary.is_current,false);});
 await t.test('cancellation while publication waits rolls back accepted evidence',async()=>{
  const f=await fixture(),j=await queue(f),claimed=(await f.r.claim())!,c={jobId:j.id,token:claimed.lease_token!};
  const g=await f.r.generationInput(c),client=createSummaryClient({enabled:true,token:'a'.repeat(64)},transport()),out=await client.generate(g.input,g.context),lock=await pool.connect(),abort=new AbortController();let code='';
  try{await lock.query('BEGIN');await lock.query('SELECT document_id FROM public.document_processing_jobs WHERE document_id=$1 FOR UPDATE',[f.doc]);
   const pending=f.r.publish(c,out,abort.signal).catch(e=>{code=e.code;return false;});await delay(50);abort.abort();await lock.query('COMMIT');assert.equal(await pending,false);
  }finally{await lock.query('ROLLBACK');lock.release();}
  assert.equal(code,'PUBLICATION_INTERRUPTED');assert.equal((await f.r.summaries(f.doc)).length,0);assert.equal((await f.r.getJob(j.id))!.state,'running');await f.r.cancel(j.id);
 });
 await t.test('uncooperative injected I/O prevents further admissions and reports incomplete drain',async()=>{
  const f=await fixture();await queue(f);let release!:(v:any)=>void;
  const client=createSummaryClient({enabled:true,token:'a'.repeat(64)},()=>new Promise(resolve=>release=resolve));
  const e=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:f.patient,attemptMs:80,heartbeatMs:20,drainMs:50},{repository:f.r,client});executors.push(e);
  await e.runOnce();assert.equal(client.activeRequests,1);assert.equal((await e.stop(true)).drained,false);assert.equal(await e.runOnce(),'interrupted');
  release({status:200,body:(async function*(){yield Buffer.from('{}');})()});await until(()=>client.activeRequests===0);assert.equal((await e.stop(true)).drained,true);assert.equal((await f.r.summaries(f.doc)).length,0);
 });
 await t.test('executor retry exhaustion is terminal and request cannot reset it',async()=>{
  const f=await fixture(),j=await queue(f);
  for(let n=0;n<3;n++){
   if(n)await until(async()=>(await pool.query<{due:boolean}>(
    'SELECT next_attempt_at<=clock_timestamp() AS due FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2',[j.id,f.patient])).rows[0].due);
   const e=executor(f,async()=>({status:503,body:(async function*(){})()}));
   assert.equal(await e.runOnce(),'failed');assert.equal((await e.stop(true)).drained,true);
  }
  assert.equal((await f.r.getJob(j.id))!.state,'failed');assert.equal((await f.r.getJob(j.id))!.attempt_count,3);assert.equal(await executor(f).runOnce(),'idle');
  const duplicate=await post(await app(),f);assert.equal(duplicate.status,200);assert.equal(duplicate.data.job.id,j.id);assert.equal(duplicate.data.job.status,'failed');
 });
 await t.test('explicit polling starts only for isolated injected execution and stops',async()=>{const f=await fixture(),j=await queue(f),e=executor(f);e.start();await until(async()=>(await f.r.getJob(j.id))!.state==='completed');assert.equal((await e.stop()).drained,true);assert.equal(await e.runOnce(),'interrupted');});
 }finally{await pool.end();await closeDatabasePool();}
});

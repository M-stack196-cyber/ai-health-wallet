import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSummaryExecutor,defaultSummaryExecutorConfig,SummaryExecutorError} from '../summaries/executor.js';
import {launchSummaryExecutor,summaryExecutorConfig} from '../summaries/executor-entry.js';
import {createSummaryClient,SummaryClientError} from '../summaries/client.js';
import {publicSummaryJob,publicAcceptedSummary} from '../summaries/routes.js';
const scope=randomUUID();
function fake(){let calls=0;const repository={patientScope:scope,async recover(){calls++;return 0;},async claim(){calls++;return undefined;}} as any;return {repository,client:createSummaryClient(),get calls(){return calls;}};}
test('executor disabled default never uses repository or client',async()=>{const deps=fake(),r=createSummaryExecutor({...defaultSummaryExecutorConfig},deps);assert.equal(await r.runOnce(),'disabled');r.start();assert.equal(deps.calls,0);assert.equal((await r.stop()).drained,true);});
test('disabled launch never invokes composition factory',async()=>{let called=false;const r=await launchSummaryExecutor({},async()=>{called=true;throw Error();});assert.equal(r.enabled,false);assert.equal(called,false);});
test('explicit false ignores unrelated configuration without composition',()=>assert.equal(summaryExecutorConfig({SUMMARY_EXECUTOR_ENABLED:'false',DB_PASSWORD:'SYNTHETIC_SECRET_SENTINEL'}).enabled,false));
for(const env of [{SUMMARY_EXECUTOR_ENABLED:'TRUE'},{SUMMARY_EXECUTOR_ENABLED:'true'},{SUMMARY_EXECUTOR_ENABLED:'true',SUMMARY_EXECUTOR_MODE:'real-provider',SUMMARY_EXECUTOR_PATIENT_ID:scope},{SUMMARY_EXECUTOR_ENABLED:'true',SUMMARY_EXECUTOR_MODE:'injected-fake',SUMMARY_EXECUTOR_PATIENT_ID:'foreign'}])test('unsafe executor env '+Object.keys(env).length+' '+Object.values(env)[1],()=>assert.throws(()=>summaryExecutorConfig(env),SummaryExecutorError));
test('explicit fake mode requires exact patient scope',()=>{const c=summaryExecutorConfig({SUMMARY_EXECUTOR_ENABLED:'true',SUMMARY_EXECUTOR_MODE:'injected-fake',SUMMARY_EXECUTOR_PATIENT_ID:scope});assert.equal(c.enabled,true);assert.equal(c.patientId,scope);});
for(const cfg of [{heartbeatMs:0},{attemptMs:0},{pollMs:0},{drainMs:-1},{patientId:randomUUID()}])test('executor rejects bounds or scope '+Object.keys(cfg)[0],()=>assert.throws(()=>createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope,...cfg},fake()),SummaryExecutorError));
test('executor rejects unscoped repository',()=>{const deps=fake();delete deps.repository.patientScope;assert.throws(()=>createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},deps),SummaryExecutorError);});
test('idle executor checks scoped recovery then claim once',async()=>{const deps=fake(),r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},deps);assert.equal(await r.runOnce(),'idle');assert.equal(deps.calls,2);await r.stop();});
test('abort before work performs no DB operation',async()=>{const deps=fake(),signal=new AbortController();signal.abort();const r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},deps);assert.equal(await r.runOnce(signal.signal),'interrupted');assert.equal(deps.calls,0);await r.stop();});
test('concurrent runOnce cannot admit a second claim',async()=>{const deps=fake();let release!:()=>void;deps.repository.recover=()=>new Promise<void>(resolve=>release=resolve);const r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},deps);const one=r.runOnce();assert.equal(await r.runOnce(),'busy');release();await one;await r.stop();});
test('foreign claim fails closed without touching unverified identity',async()=>{const deps=fake();deps.repository.claim=async()=>({id:randomUUID(),patient_id:randomUUID(),lease_token:randomUUID()});deps.repository.fail=async()=>{throw Error('UNEXPECTED_FAIL');};const r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},deps);assert.equal(await r.runOnce(),'interrupted');assert.equal(r.stopped,true);});
test('observer errors never escape',async()=>{const deps=fake(),r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},{...deps,event(){throw Error('SYNTHETIC_SECRET_SENTINEL');}});assert.equal(await r.runOnce(),'idle');await r.stop();});
test('database errors stop admissions without leaking detail',async()=>{const deps=fake();deps.repository.recover=async()=>{throw Error('SYNTHETIC_SECRET_SENTINEL');};const events:string[]=[];const r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},{...deps,event:e=>events.push(e)});assert.equal(await r.runOnce(),'interrupted');assert.equal(events.includes('safety-stop'),true);assert.equal(events.some(x=>x.includes('SYNTHETIC_SECRET_SENTINEL')),false);});
test('aborted startup does not compose',async()=>{const a=new AbortController();a.abort();await assert.rejects(launchSummaryExecutor({SUMMARY_EXECUTOR_ENABLED:'true',SUMMARY_EXECUTOR_MODE:'injected-fake',SUMMARY_EXECUTOR_PATIENT_ID:scope},async()=>{throw Error('UNEXPECTED');},a.signal),SummaryExecutorError);});
test('public job projection strips scope lease inputs and worker details',()=>{const x=publicSummaryJob({id:'public-job',document_id:'public-document',state:'running',canonical_input:'SYNTHETIC_SECRET_SENTINEL',lease_token:'SYNTHETIC_SECRET_SENTINEL',patient_id:'SYNTHETIC_SECRET_SENTINEL',attempt_count:2} as any);assert.equal(Object.keys(x).sort().join(','),'document_id,id,status');assert.equal(JSON.stringify(x).includes('SYNTHETIC_SECRET_SENTINEL'),false);});
test('public summary projection exposes only accepted display fields',()=>{const x=publicAcceptedSummary({id:'public-summary',document_id:'public-document',summary_text:'Synthetic accepted summary',is_current:false,generated_at:null,canonical_input:'SYNTHETIC_SECRET_SENTINEL',provenance:'SYNTHETIC_SECRET_SENTINEL'});assert.equal(Object.keys(x).sort().join(','),'document_id,generated_at,id,is_current,schema_version,text');assert.equal(JSON.stringify(x).includes('SYNTHETIC_SECRET_SENTINEL'),false);});
test('client remote failures classify HTTP retryability without exposing body',async()=>{for(const [status,retryable]of [[401,false],[422,false],[429,true],[503,true]] as const){let e:any;const c=createSummaryClient({enabled:true,token:'a'.repeat(64)},async()=>({status,body:(async function*(){yield Buffer.from('SYNTHETIC_SECRET_SENTINEL');})()}));const fs=await import('node:fs');const base=JSON.parse(fs.readFileSync(new URL('../../../shared/medical-summary/fixtures.json',import.meta.url),'utf8')).cases[0];try{await c.generate(base.input,base.context);}catch(x){e=x;}assert.equal(e instanceof SummaryClientError,true);assert.equal(e.code,'REMOTE_FAILURE');assert.equal(e.retryable,retryable);assert.equal(String(e).includes('SYNTHETIC_SECRET_SENTINEL'),false);}});
test('shutdown while claim is pending cancels verified claim before model work',async()=>{
 const deps=fake();let release!:(v:any)=>void,failed=0;deps.repository.claim=()=>new Promise(resolve=>release=resolve);deps.repository.fail=async()=>{failed++;return true;};
 const r=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope},deps);const work=r.runOnce();await new Promise(resolve=>setTimeout(resolve,0));
 const stop=r.stop(true);release({id:randomUUID(),patient_id:scope,lease_token:randomUUID(),attempt_count:1,max_attempts:3});assert.equal(await work,'interrupted');assert.equal((await stop).drained,true);assert.equal(failed,1);
});

// B03.1: completion and drain are distinct. Drive the interval explicitly rather
// than assuming an in-flight heartbeat settles within an arbitrary sleep.
test('completed execution remains busy until its last heartbeat settles',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let entered!:()=>void,finish!:(v:unknown)=>void,releaseBeat!:(v:boolean)=>void;
 const admitted=new Promise<void>(r=>entered=r);let claims=0,publications=0;
 const deps=fake();deps.repository.claim=async()=>++claims===1?{id:randomUUID(),patient_id:scope,lease_token:randomUUID()}:undefined;
 deps.repository.generationInput=async()=>({input:{},context:{input_sha256:'0'.repeat(64)},recipe:(await import('../summaries/client.js')).fakeSummaryRecipe('0'.repeat(64))});
 deps.repository.heartbeat=()=>new Promise<boolean>(r=>releaseBeat=r);
 deps.repository.publish=async()=>{publications++;return true;};
 const client={activeRequests:0,generate:()=>{entered();return new Promise(r=>finish=r);}} as any;
 const e=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope,heartbeatMs:30},{repository:deps.repository,client});
 try{const work=e.runOnce();await admitted;t.mock.timers.tick(30);assert.equal(typeof releaseBeat,'function');
  finish({});assert.equal(await work,'completed');assert.equal(await e.runOnce(),'busy');assert.equal(claims,1);assert.equal(publications,1);
  releaseBeat(false);await new Promise<void>(r=>setImmediate(r));assert.equal(await e.runOnce(),'idle');assert.equal((await e.stop(true)).drained,true);
 }finally{releaseBeat?.(false);await e.stop(true);t.mock.timers.reset();}
});
test('failed heartbeat cancels an admitted provider and never publishes',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let entered!:()=>void,cancelled=false,publications=0;
 const admitted=new Promise<void>(r=>entered=r),deps=fake();
 deps.repository.claim=async()=>({id:randomUUID(),patient_id:scope,lease_token:randomUUID()});
 deps.repository.generationInput=async()=>({input:{},context:{input_sha256:'0'.repeat(64)},recipe:(await import('../summaries/client.js')).fakeSummaryRecipe('0'.repeat(64))});
 deps.repository.heartbeat=async()=>false;deps.repository.publish=async()=>{publications++;return true;};
 const client={activeRequests:0,generate:(_input:unknown,_context:unknown,signal:AbortSignal)=>new Promise((_resolve,reject)=>{
  entered();const abort=()=>{cancelled=true;reject(new SummaryClientError('CANCELLED'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 })} as any;
 const e=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId:scope,heartbeatMs:30},{repository:deps.repository,client});
 try{const work=e.runOnce();await admitted;t.mock.timers.tick(30);assert.equal(await work,'lease-lost');assert.equal(cancelled,true);assert.equal(publications,0);assert.equal((await e.stop(true)).drained,true);
 }finally{await e.stop(true);t.mock.timers.reset();}
});

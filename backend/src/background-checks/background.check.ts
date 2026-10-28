import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,chmod,rm,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {PoolClient} from 'pg';
import {backgroundConfig,verifyApproval,type BackgroundConfig} from '../processing/background-config.js';
import {launchBackground} from '../processing/background-entry.js';
import {acquireCoordinator,coordinatorKey} from '../processing/background-coordinator.js';
import {startBackground,logEvent,type BackgroundPorts} from '../processing/background-service.js';
import {startBackgroundHealth,publicStatus,type Status} from '../processing/background-health.js';
import {createProcessingRepository,type Claim,type ProcessingJob} from '../processing/repository.js';
import {createCanaryRepository} from '../processing/background-repository.js';
import {createProcessingService} from '../processing/service.js';
import {createProcessingWorker} from '../processing/worker.js';
import type {ProcessingConfig} from '../processing/config.js';
const patientId=randomUUID(),uploadCutoff='2026-10-21T12:00:00.000Z';
const env=()=>({PROCESSING_SERVICE_ENABLED:'true',PROCESSING_SERVICE_MODE:'canary',PROCESSING_CANARY_PATIENT_ID:patientId,
  PROCESSING_UPLOAD_CUTOFF:uploadCutoff,PROCESSING_APPROVAL_FILE:'/tmp/private/approval.json',PROCESSING_APPROVAL_SHA256:'a'.repeat(64)});
const config=()=>backgroundConfig(env()) as BackgroundConfig;
const processing:ProcessingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:30000,retryMaxMs:300000,recoveryBatchSize:50};
const claim:Claim={patientId,documentId:randomUUID(),token:randomUUID()};
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await delay(5);assert.ok(predicate());}

test('disabled default and explicit false never invoke external factories',async()=>{
  for(const e of [{},{PROCESSING_SERVICE_ENABLED:'false',PROCESSING_UPLOAD_CUTOFF:'invalid'}]){
    let calls=0;assert.deepEqual(await launchBackground(e,async()=>{calls++;throw Error('must not connect');}),{enabled:false});assert.equal(calls,0);
  }
});
test('actual disabled entry exits with network calls and database imports prohibited',async()=>{
  const shim=`import net from 'node:net';import Module from 'node:module';
    net.Socket.prototype.connect=()=>{throw Error('Network forbidden in disabled entry');};
    net.Server.prototype.listen=()=>{throw Error('Listener forbidden in disabled entry');};
    const load=Module._load;Module._load=function(id,...args){if(id==='pg'||id.startsWith('@aws-sdk/'))throw Error('External client forbidden');return load.call(this,id,...args);};`;
  const child=await promisify(execFile)(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(shim),'--import','tsx',new URL('../processing/background-entry.ts',import.meta.url).pathname],{
    env:{PATH:process.env.PATH,PROCESSING_SERVICE_ENABLED:'false'},timeout:10000,maxBuffer:10000});
  assert.deepEqual(JSON.parse(child.stdout),{service:'document-processing',event:'disabled'});assert.equal(child.stderr,'');
});
test('only explicit true and canary scope/cutoff/pin/path accepted',()=>{
  for(const key of ['PROCESSING_SERVICE_MODE','PROCESSING_CANARY_PATIENT_ID','PROCESSING_UPLOAD_CUTOFF','PROCESSING_APPROVAL_FILE','PROCESSING_APPROVAL_SHA256'])assert.throws(()=>backgroundConfig({...env(),[key]:''}));
  for(const value of ['1','yes','TRUE',''])assert.throws(()=>backgroundConfig({PROCESSING_SERVICE_ENABLED:value}));
  for(const value of ['now','2026-02-30T12:00:00.000Z','2026-10-21','2026-10-21T12:00:00+00:00'])assert.throws(()=>backgroundConfig({...env(),PROCESSING_UPLOAD_CUTOFF:value}));
});
test('bounded scheduler configuration and frozen eligibility',()=>{
  const c=config();assert.equal(c.concurrency,1);assert.equal(c.pollMs,2000);assert.ok(Object.isFrozen(c.canary));
  for(const [key,value]of [['PROCESSING_SERVICE_CONCURRENCY','3'],['PROCESSING_SERVICE_POLL_MS','0'],['PROCESSING_SERVICE_DRAIN_MS','999999'],['PROCESSING_SERVICE_HEALTH_PORT','80']])assert.throws(()=>backgroundConfig({...env(),[key]:value}));
});
async function approvalFixture(){
  const dir=await mkdtemp(join(tmpdir(),'health-wallet-stage-a-check-'));await chmod(dir,0o700);const path=join(dir,'approval.json');
  const bytes=Buffer.from(JSON.stringify({version:1,mode:'canary',patientId,uploadCutoff,profile:'ai-health-wallet',account:'402909940531',bucket:'ai-health-wallet-records-402909940531',region:'ap-southeast-2'}));
  await writeFile(path,bytes,{mode:0o600});return {dir,path,bytes,c:{...config(),approvalPath:path,approvalSha256:createHash('sha256').update(bytes).digest('hex')}};
}
test('durable approval survives restarts and refuses unilateral cutoff or file changes',async()=>{
  const f=await approvalFixture();try{
    await verifyApproval(f.c);await verifyApproval({...f.c,canary:{...f.c.canary}});
    await assert.rejects(verifyApproval({...f.c,canary:{...f.c.canary,uploadCutoff:'2026-10-22T12:00:00.000Z'}}));
    await writeFile(f.path,Buffer.concat([f.bytes,Buffer.from(' ')]));await assert.rejects(verifyApproval(f.c));
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('approval missing, permissive files/directories and symlinks fail closed',async()=>{
  const f=await approvalFixture();try{
    await chmod(f.path,0o644);await assert.rejects(verifyApproval(f.c));await chmod(f.path,0o600);
    await chmod(f.dir,0o755);await assert.rejects(verifyApproval(f.c));await chmod(f.dir,0o700);
    await symlink(f.path,join(f.dir,'link'));await assert.rejects(verifyApproval({...f.c,approvalPath:join(f.dir,'link')}));
    await assert.rejects(verifyApproval({...f.c,approvalPath:join(f.dir,'missing')}));
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('approval rejects wrong target, unknown fields and oversized content even with matching pin',async()=>{
  const f=await approvalFixture();try{
    for(const bytes of [Buffer.from(JSON.stringify({...JSON.parse(f.bytes.toString()),account:'000000000000'})),Buffer.from(JSON.stringify({...JSON.parse(f.bytes.toString()),extra:true})),Buffer.alloc(4097,32)]){
      await writeFile(f.path,bytes);await assert.rejects(verifyApproval({...f.c,approvalSha256:createHash('sha256').update(bytes).digest('hex')}));
    }
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('all repository operations enforce parameterized SQL patient and cutoff eligibility',async()=>{
  const captured:{sql:string;values:unknown[]}[]=[];
  const db={async query(sql:string,values:unknown[]){captured.push({sql,values});return {rows:[]};}};
  const r=createProcessingRepository(db,processing,patientId,uploadCutoff);
  await r.discover(2);await r.claim();await r.recover();await r.resolveOriginal(claim);await r.heartbeat(claim);await r.complete(claim);await r.fail(claim,'PROCESSOR_FAILED',true);await r.completedForClaim(claim);
  await r.persistExtraction(claim,{text:'synthetic',metadata:{},version:'test'} as never);
  assert.equal(captured.length,9);
  for(const {sql,values}of captured){
    assert.match(sql,/eligible\.uploaded_at >= \$\d+::timestamptz/);assert.match(sql,/eligible\.patient_id=\$\d+::uuid/);assert.deepEqual(values.slice(-2),[patientId,uploadCutoff]);assert.ok(!sql.includes(patientId));
    const placeholders=[...sql.matchAll(/\$(\d+)/g)].map(m=>Number(m[1]));assert.equal(Math.max(...placeholders),values.length);
    assert.ok(placeholders.every(n=>n>0&&n<=values.length));
  }
  const recovery=captured[2].sql;assert.ok(recovery.indexOf('eligible.uploaded_at')<recovery.indexOf('FOR UPDATE SKIP LOCKED'));
  assert.match(captured[1].sql,/FOR UPDATE OF j SKIP LOCKED/);assert.match(captured[4].sql,/lease_token=\$3/);assert.match(captured[4].sql,/attempt_deadline_at>clock_timestamp/);
});
test('cutoff cannot be provided to an unscoped repository',()=>{
  const db={async query(){return {rows:[]};}};
  assert.throws(()=>createProcessingRepository(db,processing,undefined,uploadCutoff));
  assert.throws(()=>createProcessingRepository(db,processing,patientId,'now'));
});
test('legacy scoped and unscoped repository SQL retain old parameter lists',async()=>{
  const values:unknown[][]=[];const db={async query(_s:string,v:unknown[]){values.push(v);return {rows:[]};}};
  await createProcessingRepository(db,processing).discover(2);await createProcessingRepository(db,processing,patientId).recover();
  assert.deepEqual(values[0],[null,2]);assert.deepEqual(values[1],[patientId,50,30000,300000]);
});
test('canary wrapper refuses missing scope and foreign claims before processor access',async()=>{
  const db={async query<R>(){return {rows:[{patient_id:randomUUID()}] as R[]};}};
  assert.throws(()=>createCanaryRepository(db,processing,{patientId:'',uploadCutoff}));
  const {repository}=createCanaryRepository(db,processing,{patientId,uploadCutoff});await assert.rejects(repository.claim());
});
test('queue metrics enforce approved patient/cutoff and reject malformed counts',async()=>{
  let count='2';const db={async query<R>(sql:string,values:unknown[]){
    assert.deepEqual(values,[patientId,uploadCutoff]);assert.match(sql,/j\.patient_id=\$1::uuid AND d\.patient_id=\$1::uuid/);
    assert.match(sql,/d\.uploaded_at >= \$2::timestamptz/);assert.match(sql,/next_attempt_at<=clock_timestamp/);
    return {rows:[{count}] as R[]};
  }};
  const scoped=createCanaryRepository(db,processing,{patientId,uploadCutoff});assert.equal(await scoped.queueCount(),2);
  for(const invalid of ['-1','NaN','9007199254740992']){count=invalid;await assert.rejects(scoped.queueCount());}
});
test('synthetic claim simulation excludes historical and foreign jobs under concurrent admissions',async()=>{
  const records=[{owner:patientId,uploaded:'2026-10-20T12:00:00.000Z',state:'pending'},
    {owner:randomUUID(),uploaded:uploadCutoff,state:'pending'},{owner:patientId,uploaded:uploadCutoff,state:'pending'}];
  let count=0;
  const db={async query<R>(sql:string,values:unknown[]){
    assert.match(sql,/eligible\.uploaded_at >=/);const [owner,cutoff]=values.slice(-2);
    const eligible=records.find(r=>r.owner===owner&&r.uploaded>=String(cutoff)&&r.state==='pending');
    if(!eligible)return {rows:[] as R[]};eligible.state='running';count++;
    return {rows:[{document_id:claim.documentId,patient_id:owner}] as R[]};
  }};
  const r=createProcessingRepository(db,processing,patientId,uploadCutoff);const results=await Promise.all([r.claim(),r.claim()]);
  assert.equal(results.filter(Boolean).length,1);assert.equal(count,1);assert.equal(records[0].state,'pending');assert.equal(records[1].state,'pending');
});
test('synthetic recovery simulation leaves expired historical and foreign running jobs untouched',async()=>{
  const rows=[{owner:patientId,uploaded:'2026-10-20T00:00:00.000Z',state:'running'},
    {owner:randomUUID(),uploaded:uploadCutoff,state:'running'},{owner:patientId,uploaded:uploadCutoff,state:'running'}];
  const db={async query<R>(sql:string,values:unknown[]){
    assert.match(sql,/state='running' AND lease_expires_at<=clock_timestamp/);assert.match(sql,/eligible\.uploaded_at >= \$6::timestamptz/);
    assert.ok(sql.indexOf('eligible.uploaded_at')<sql.indexOf('FOR UPDATE SKIP LOCKED'));
    const [owner,cutoff]=values.slice(-2);const eligible=rows.filter(r=>r.owner===owner&&r.uploaded>=String(cutoff));
    eligible.forEach(r=>r.state='retry_wait');return {rows:eligible as R[]};
  }};
  assert.equal(await createProcessingRepository(db,processing,patientId,uploadCutoff).recover(),1);
  assert.deepEqual(rows.map(r=>r.state),['running','running','retry_wait']);
});

class FakeClient extends EventEmitter{
  queries:string[]=[];released=false;owned=true;fail=false;
  async query(sql:string,values?:unknown[]){this.queries.push(sql);if(this.fail)throw Error('secret raw db error');
    if(sql.includes('advisory'))assert.deepEqual(values,[...coordinatorKey]);return {rows:[{owned:this.owned}]};}
  release(destroy:boolean){assert.equal(destroy,true);this.released=true;}
}
test('dedicated coordinator retains ownership until explicit unlock and destroys session',async()=>{
  const c=new FakeClient();let lost=0;const lock=await acquireCoordinator(c as unknown as PoolClient,()=>lost++);
  lock.assertOwned();await lock.ping();assert.equal(c.released,false);await lock.close();assert.equal(c.released,true);assert.equal(lost,0);assert.ok(c.queries.some(q=>q.includes('pg_advisory_unlock')));assert.throws(()=>lock.assertOwned());
});
test('coordinator contention never admits work',async()=>{
  const c=new FakeClient();c.owned=false;await assert.rejects(acquireCoordinator(c as unknown as PoolClient,()=>{}));assert.equal(c.released,true);
});
for(const event of ['error','end'])test(`coordinator ${event} loss immediately revokes ownership once`,async()=>{
  const c=new FakeClient();let lost=0;const lock=await acquireCoordinator(c as unknown as PoolClient,()=>lost++);
  c.emit(event);assert.throws(()=>lock.assertOwned());assert.equal(lost,1);await lock.close();assert.ok(!c.queries.some(q=>q.includes('unlock')));
});
test('coordinator ping failure cancels and returns only generic errors',async()=>{
  const c=new FakeClient();let lost=0;const lock=await acquireCoordinator(c as unknown as PoolClient,()=>lost++);c.fail=true;
  await assert.rejects(lock.ping(),e=>e instanceof Error&&!e.message.includes('secret'));assert.equal(lost,1);await lock.close();
});
function fakePorts(overrides:Partial<BackgroundPorts>={}):BackgroundPorts{
  return {admission:async()=>{},queueCount:async()=>0,worker:()=>({runOnce:async()=>'idle'}),health:async()=>({close:async()=>{}}),close:async()=>{},log:()=>{},...overrides};
}
test('unscoped scheduler is refused before listener or worker creation',async()=>{
  let calls=0;await assert.rejects(startBackground({...config(),canary:undefined as never},fakePorts({
    health:async()=>{calls++;return {close:async()=>{}};},worker:()=>{calls++;return {runOnce:async()=>'idle'};}
  })));assert.equal(calls,0);
});
test('scheduler bounds concurrency without prefetch and waits for cancellation cleanup',async()=>{
  let active=0,max=0,cleaned=0,closed=false,started=0;
  const service=await startBackground({...config(),concurrency:2,drainMs:0},fakePorts({
    worker:()=>({runOnce:async signal=>{active++;started++;max=Math.max(max,active);await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));await delay(5);active--;cleaned++;return 'failed';}}),
    close:async()=>{assert.equal(active,0);assert.equal(cleaned,2);closed=true;}
  }));
  await until(()=>started===2);assert.equal(max,2);await service.stop();assert.equal(closed,true);assert.equal(service.snapshot().ready,false);assert.equal(service.snapshot().live,false);
});
test('failed approval/ownership stops admission without claiming or exposing errors',async()=>{
  let claims=0,closed=false;const logs:string[]=[];
  const service=await startBackground(config(),fakePorts({admission:async()=>{throw Error('patient secret');},worker:()=>{claims++;return {runOnce:async()=>'idle'};},close:async()=>{closed=true;},log:e=>logs.push(e)}));
  await until(()=>closed);assert.equal(claims,0);assert.ok(!JSON.stringify(logs).includes('patient secret'));await service.stop();
});
test('loss during queue query stops admissions and cancels active work',async()=>{
  let resolveCount!:(n:number)=>void,claims=0;
  const service=await startBackground(config(),fakePorts({queueCount:()=>new Promise(resolve=>{resolveCount=resolve;}),worker:()=>{claims++;return {runOnce:async()=>'idle'};}}));
  await until(()=>!!resolveCount);const stopping=service.stop(true);resolveCount(3);await stopping;assert.equal(claims,0);
});
test('immediate connection-loss shutdown cancels work before drain timeout',async()=>{
  let cancelled=false,started=false;
  const service=await startBackground({...config(),drainMs:60000},fakePorts({worker:()=>({runOnce:async signal=>{
    started=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true}));return 'lost';
  }})}));await until(()=>started);await service.stop(true);assert.equal(cancelled,true);
});
test('shutdown keeps resources open until pending admission and cleanup finish',async()=>{
  let resolveAdmission!:()=>void,closed=false;
  const service=await startBackground(config(),fakePorts({admission:()=>new Promise(resolve=>{resolveAdmission=resolve;}),close:async()=>{closed=true;}}));
  await until(()=>!!resolveAdmission);const stopping=service.stop();await delay(5);assert.equal(closed,false);resolveAdmission();await stopping;assert.equal(closed,true);
});
test('health close failure still closes processing resources',async()=>{
  let closed=false;const service=await startBackground(config(),fakePorts({health:async()=>({close:async()=>{throw Error('private');}}),close:async()=>{closed=true;}}));
  await assert.rejects(service.stop(true));assert.equal(closed,true);
});
test('unavailable workers use bounded polling backoff without overlapping attempts',async()=>{
  const sleeps:{ms:number;next:()=>void}[]=[];let attempts=0;
  const service=await startBackground(config(),fakePorts({
    worker:()=>({runOnce:async()=>{attempts++;return 'unavailable';}}),
    sleep:(ms,signal)=>new Promise(resolve=>{sleeps.push({ms,next:resolve});signal.addEventListener('abort',()=>resolve(),{once:true});})
  }));
  await until(()=>sleeps.length===1);assert.equal(attempts,1);sleeps[0].next();await until(()=>sleeps.length===2);
  assert.ok(sleeps[0].ms>=2000&&sleeps[0].ms<2250);assert.ok(sleeps[1].ms>=5000&&sleeps[1].ms<=30000);
  await service.stop(true);assert.equal(attempts,2);
});
test('queue failure fails closed without admitting workers',async()=>{
  let attempts=0,closed=false;
  const service=await startBackground(config(),fakePorts({queueCount:async()=>{throw Error('private database error');},
    worker:()=>{attempts++;return {runOnce:async()=>'idle'};},close:async()=>{closed=true;}}));
  await until(()=>closed);assert.equal(attempts,0);await service.stop();
});
test('real existing worker cancellation waits for synthetic retrieval cleanup and uses fenced failure',async()=>{
  let cleaned=false,started=false,failed=false;
  const job={document_id:claim.documentId,patient_id:patientId,lease_token:claim.token,attempt_count:1,attempt_deadline_at:new Date(Date.now()+300000)} as ProcessingJob;
  const repository={recover:async()=>0,claim:async()=>job,fail:async(c:Claim)=>{assert.deepEqual(c,claim);failed=true;return true;}} as unknown as ReturnType<typeof createProcessingRepository>;
  const worker=createProcessingWorker(createProcessingService(repository),processing,async({withOriginal})=>{await withOriginal(async()=>{});},
    {async withOriginal(_c,signal){started=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));await delay(5);cleaned=true;throw Error('cancelled');}});
  const abort=new AbortController(),running=worker.runOnce(abort.signal);await until(()=>started);abort.abort();assert.equal(await running,'failed');assert.equal(cleaned,true);assert.equal(failed,true);
});
test('health projection and logs discard identifiers, raw exceptions and arbitrary fields',()=>{
  const s=publicStatus({live:true,ready:true,patientId,metrics:{active:0,completed:1,failed:0,lost:0,unavailable:0,idle:0,queue:2,secret:'medical'}} as Status);
  const lines:string[]=[];logEvent(patientId as never,line=>lines.push(line));assert.ok(!JSON.stringify([s,lines]).includes(patientId));assert.ok(!JSON.stringify(s).includes('medical'));
});
test('health binds IPv4 loopback and exposes read-only aggregate endpoints',async()=>{
  const health=await startBackgroundHealth(0,()=>({live:true,ready:false,metrics:{active:0,completed:1,failed:0,lost:0,unavailable:0,idle:0,queue:0}}));
  try{
    assert.ok(health.address&&typeof health.address==='object');assert.equal(health.address.address,'127.0.0.1');const base=`http://127.0.0.1:${health.address.port}`;
    assert.equal((await fetch(base+'/live')).status,200);assert.equal((await fetch(base+'/ready')).status,503);
    assert.equal((await fetch(base+'/metrics')).status,200);assert.equal((await fetch(base+'/metrics',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/claim')).status,404);
  }finally{await health.close();}
});
test('API and manual CLI remain disconnected from background startup; entry has no static runtime import',async()=>{
  for(const name of ['app.ts','server.ts','integration/cli.ts'])assert.ok(!(await readFile(new URL('../'+name,import.meta.url),'utf8')).includes('background-'));
  const entry=await readFile(new URL('../processing/background-entry.ts',import.meta.url),'utf8');assert.ok(!/^import .*background-runtime/m.test(entry));
  const runtime=await readFile(new URL('../processing/background-runtime.ts',import.meta.url),'utf8');assert.ok(!runtime.includes('database/pool'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {artifactRoles,createSystemManagerSupervisor,systemUnitDefinition,systemControllerDefinition,validateSystemPlan,type SystemPlan,type SystemManagerPorts,type UnitSnapshot,type ProcessIdentity,type ArtifactObservation,type Observation} from '../stage-c/system-supervision.js';
import {verifyApplicationSystemProof,systemProofChecks,type ApplicationSystemProof} from '../stage-c/system-supervision-proof.js';
import {selectSupervision} from '../stage-c/manager-selection.js';
import {transientArguments,type UnitPlan} from '../stage-c/supervision.js';
import {backgroundConfig} from '../processing/background-config.js';
import {launchBackground} from '../processing/background-entry.js';
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const root='/opt/ai-health-wallet/releases/synthetic',boot='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',workerToken='a'.repeat(32),controllerToken='b'.repeat(32);
function plan():SystemPlan {
  const names={node:'/bin/node',worker:'/backend/dist/processing/background-entry.js',controller:'/backend/dist/stage-c/cli.js',inside:'/backend/dist/stage-c/inside-entry.js',adapter:'/backend/dist/stage-c/system-supervision.js',manifest:'/deployment-manifest.json'};
  return {manager:'system',run:'stage-c-'+'a'.repeat(24),bootId:boot,releaseDirectory:root,controllerInvocationId:controllerToken,controllerArguments:[],
    artifacts:Object.fromEntries(artifactRoles.map((r,i)=>[r,{path:root+names[r],sha256:String(i+1).repeat(64)}])) as SystemPlan['artifacts']};
}
const proc=(pid:number,startTime='100'):ProcessIdentity=>({pid,startTime,uid:62000,bootId:boot});
function snapshot(p:SystemPlan,controller=false):UnitSnapshot {
  const d=controller?systemControllerDefinition(p):systemUnitDefinition(p),name=d.name;
  return {identity:{manager:'system',bootId:boot,id:name,description:d.description,transient:true,
    fragmentPath:'/run/systemd/transient/'+name,invocationId:controller?controllerToken:workerToken,user:d.user,dynamicUser:true,
    execStart:[p.artifacts.node.path,p.artifacts[controller?'controller':'worker'].path],controlGroup:'/system.slice/'+name},
    state:'active',main:{...proc(controller?201:101),uid:controller?62001:62000},resolvedUid:controller?62001:62000,mainExecutableSha256:p.artifacts.node.sha256,execStartPre:[...d.execStartPre],properties:{...d.properties},
    bindsTo:[d.properties.BindsTo],after:[d.properties.After],addressFamilies:copy(d.addressFamilies),effective:{cpuQuota:controller?50000:200000,cpuPeriod:100000,memoryMax:controller?805306368:3221225472,tasksMax:controller?64:128,readOnlyCgroup:true}};
}
function fake(p=plan()) {
  const stable=copy(p);
  let worker:UnitSnapshot|null=null,controller:UnitSnapshot|null=snapshot(stable,true),elapsed=0,exists=false,populated=false;
  let processes:ProcessIdentity[]=[],ackLost=false,stayAlive=false,readOverride:((name:string)=>Observation|undefined)|undefined;
  const actions:string[]=[],requests:string[]=[],reads:string[]=[];
  const observed=Object.fromEntries(artifactRoles.map(r=>[r,{...p.artifacts[r],uid:0,regular:true,symlink:false,links:1,mode:0o644,safeAncestors:true,serviceWritable:false}])) as Record<typeof artifactRoles[number],ArtifactObservation>;
  const definition=systemUnitDefinition(p);
  const ports:SystemManagerPorts={manager:'system',now:()=>elapsed,pause:async ms=>{elapsed+=ms;},
    readUnit:async name=>{reads.push(name);const overridden=readOverride?.(name);if(overridden)return copy(overridden);const u=name===definition.name?worker:controller;return u?{kind:'present',unit:copy(u)}:{kind:'missing'};},
    readArtifacts:async()=>copy(observed),
    readContainment:async path=>({path,exists,populated,processes:copy(processes)}),
    readProcess:async pid=>copy(processes.find(v=>v.pid===pid)??null),
    readIdentity:async user=>user===definition.user?(worker?.main?{uid:worker.resolvedUid}:null):(controller?.main?{uid:controller.resolvedUid}:null),
    startTransient:async d=>{actions.push('start');requests.push(JSON.stringify(d));worker=snapshot(stable);exists=true;populated=true;processes=[proc(101),proc(102)];if(ackLost)throw Error('synthetic ambiguous acknowledgement');return {invocationId:workerToken};},
    stopExact:async ticket=>{assert.equal(ticket.identity.invocationId,workerToken);actions.push('stop');if(!stayAlive){end('inactive');worker=null;}},
    resetFailedExact:async ticket=>{assert.equal(ticket.identity.invocationId,workerToken);actions.push('reset');worker=null;}
  };
  function end(state:'failed'|'inactive'='failed'){assert.ok(worker);worker.state=state;worker.main=null;worker.identity.controlGroup='';processes=[];exists=false;populated=false;}
  return {p,ports,actions,reads,requests,observed,end,definition,
    get worker(){return worker;},set worker(v:UnitSnapshot|null){worker=v;},
    get controller(){return controller;},set controller(v:UnitSnapshot|null){controller=v;},
    set readOverride(v:typeof readOverride){readOverride=v;},set ackLost(v:boolean){ackLost=v;},set stayAlive(v:boolean){stayAlive=v;},
    set processes(v:ProcessIdentity[]){processes=v;populated=Boolean(v.length);exists=populated;},
    get elapsed(){return elapsed;}
  };
}
const signal=()=>new AbortController().signal;
async function started(){const f=fake(),s=createSystemManagerSupervisor(f.p,f.ports);await s.start(signal());return {f,s};}
test('explicit system selection requires a system transport and imports have no side effects',()=>{
  const f=fake(),s=selectSupervision({manager:'system',plan:f.p,ports:f.ports});assert.equal(s.manager,'system');assert.deepEqual(f.actions,[]);
  assert.throws(()=>createSystemManagerSupervisor(f.p,{...f.ports,manager:'user'} as unknown as SystemManagerPorts));
});
test('system definition couples exact same-manager controller with bounded offline-only security',()=>{
  const d=systemUnitDefinition(plan());assert.equal(d.manager,'system');assert.equal(d.properties.BindsTo,d.properties.After);
  for(const [k,v]of Object.entries({Restart:'no',ProtectControlGroups:'yes',DynamicUser:'yes',PrivateNetwork:'yes',ProtectHome:'yes',ProtectSystem:'strict',NoNewPrivileges:'yes',Delegate:'no',CapabilityBoundingSet:'',AmbientCapabilities:'',KillMode:'mixed',KillSignal:'SIGTERM',TimeoutStopSec:'60',RuntimeMaxSec:'600'}))assert.equal(d.properties[k],v);
  assert.deepEqual(d.addressFamilies,{allowList:true,families:[]});assert.ok(!JSON.stringify(d).includes('PROCESSING_SERVICE_ENABLED'));
});
for(const [name,change]of Object.entries({manager:(p:SystemPlan)=>{p.manager='user' as 'system';},run:(p:SystemPlan)=>{p.run='unscoped';},home:(p:SystemPlan)=>{p.releaseDirectory='/home/developer';},invocation:(p:SystemPlan)=>{p.controllerInvocationId='';},artifactPath:(p:SystemPlan)=>{p.artifacts={...p.artifacts,worker:{...p.artifacts.worker,path:'/tmp/worker.js'}};},missingPin:(p:SystemPlan)=>{p.artifacts={...p.artifacts,node:{...p.artifacts.node,sha256:''}};}}))test('refuses invalid plan '+name,()=>{const p=plan();change(p);assert.throws(()=>validateSystemPlan(p));});
test('start, fresh admission and exact stop verify complete containment',async()=>{
  const {f,s}=await started();await s.checkAdmission();assert.deepEqual(await s.stop(),{cleanupVerified:true,processesGone:true,cgroupEmptyOrAbsent:true,unitUnloaded:true,identityReleased:true});assert.deepEqual(f.actions,['start','stop']);
});
test('no stop or reset before ownership',async()=>{const f=fake(),s=createSystemManagerSupervisor(f.p,f.ports);await assert.rejects(s.stop());assert.deepEqual(f.actions,[]);});
for(const kind of ['present','inconclusive'] as const)test('startup collision refuses '+kind,async()=>{
  const f=fake();f.readOverride=name=>name===f.definition.name?(kind==='present'?{kind,unit:snapshot(f.p)}:{kind}):undefined;
  await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,[]);
});
for(const role of artifactRoles)test('missing independent artifact hash refuses '+role,async()=>{
  const f=fake();f.observed[role].sha256='f'.repeat(64);await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,[]);
});
for(const [field,value]of Object.entries({uid:1000,symlink:true,regular:false,links:2,mode:0o666,safeAncestors:false,serviceWritable:true}))test('unsafe deployment refuses '+field,async()=>{
  const f=fake();Object.assign(f.observed.worker,{[field]:value});await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,[]);
});
for(const [field,value]of Object.entries({id:'other.service',description:'other',transient:false,fragmentPath:'/run/user/1000/systemd/transient/other',user:'other',dynamicUser:false,controlGroup:'/system.slice/other.service',bootId:'other',invocationId:'c'.repeat(32),execStart:['/tmp/other']}))test('changed exact ownership refuses stop: '+field,async()=>{
  const {f,s}=await started();Object.assign(f.worker!.identity,{[field]:value});await assert.rejects(s.stop());assert.deepEqual(f.actions,['start']);
});
test('PID reuse in a live unit refuses ownership and shutdown',async()=>{
  const {f,s}=await started();f.worker!.main=proc(101,'999');await assert.rejects(s.checkAdmission());await assert.rejects(s.stop());assert.deepEqual(f.actions,['start']);
});
test('PID reuse after exit never kills the replacement',async()=>{
  const {f,s}=await started();f.end();f.ports.readProcess=async pid=>proc(pid,'999');await s.stop();assert.deepEqual(f.actions,['start','reset']);
});
test('lost start acknowledgement reconciles once then cleans up without claiming startup success',async()=>{
  const f=fake();f.ackLost=true;const s=createSystemManagerSupervisor(f.p,f.ports);await assert.rejects(s.start(signal()));assert.deepEqual(f.actions,['start','stop']);await assert.rejects(s.start(signal()));
});
test('initial inconclusive ownership is reconciled through bounded read-only retries',async()=>{
  const f=fake();let left=3;f.readOverride=name=>name===f.definition.name&&f.actions.includes('start')&&left-->0?{kind:'inconclusive',candidateInvocationId:workerToken}:undefined;
  await createSystemManagerSupervisor(f.p,f.ports).start(signal());assert.deepEqual(f.actions,['start']);assert.equal(f.elapsed,300);
});
test('permanently ambiguous ownership never stops an unverified unit',async()=>{
  const f=fake();f.readOverride=name=>name===f.definition.name&&f.actions.includes('start')?{kind:'inconclusive'}:undefined;
  await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()),/unresolved/);assert.deepEqual(f.actions,['start']);assert.ok(f.elapsed<=5000);assert.ok(f.reads.length<15);
});
test('candidate invocation replacement during reconciliation is refused',async()=>{
  const f=fake();let left=1;f.readOverride=name=>name===f.definition.name&&f.actions.includes('start')&&left-->0?{kind:'inconclusive',candidateInvocationId:'c'.repeat(32)}:undefined;
  await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,['start']);
});
test('security failure after proven ownership triggers targeted cleanup',async()=>{
  const f=fake(),start=f.ports.startTransient;f.ports.startTransient=async(d,s)=>{const r=await start(d,s);f.worker!.effective.readOnlyCgroup=false;return r;};
  await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,['start','stop']);
});
test('cancellation after launch still reconciles and cleans up owned invocation',async()=>{
  const f=fake(),cancel=new AbortController(),start=f.ports.startTransient;f.ports.startTransient=async(d,s)=>{const r=await start(d,s);cancel.abort();return r;};
  await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(cancel.signal));assert.deepEqual(f.actions,['start','stop']);
});
test('pre-cancelled launch has no transport mutations',async()=>{const f=fake(),cancel=new AbortController();cancel.abort();await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(cancel.signal));assert.deepEqual(f.actions,[]);});
test('cleanup survivors fail within bounded observations without retrying stop',async()=>{
  const {f,s}=await started();f.stayAlive=true;await assert.rejects(s.stop());assert.deepEqual(f.actions,['start','stop']);assert.ok(f.elapsed<=75000);
});
test('reset rechecks invocation and refuses replacement after stop',async()=>{
  const {f,s}=await started();f.end();const read=f.ports.readArtifacts;f.ports.readArtifacts=async(p,a)=>{const v=await read(p,a);if(f.worker!.state==='failed')f.worker!.identity.invocationId='d'.repeat(32);return v;};
  await assert.rejects(s.stop());assert.deepEqual(f.actions,['start']);
});
test('collected exact-owned unit uses receipts plus process and cgroup absence',async()=>{const {f,s}=await started();f.end();f.worker=null;await s.stop();assert.deepEqual(f.actions,['start']);});
test('collection does not hide an original surviving process',async()=>{const {f,s}=await started();f.end();f.worker=null;f.ports.readProcess=async pid=>proc(pid);await assert.rejects(s.stop());assert.deepEqual(f.actions,['start']);});
test('controller loss observation proves containment without explicit stop/reset',async()=>{
  const {f,s}=await started();f.controller=null;f.end();const r=await s.observeControllerLoss(signal());assert.equal(r.controllerLossVerified,true);assert.equal(r.issuedNoStopOrKill,true);assert.deepEqual(f.actions,['start']);
});
test('controller disappearance blocks admission',async()=>{const {f,s}=await started();f.controller=null;await assert.rejects(s.checkAdmission());assert.deepEqual(f.actions,['start']);});
test('controller invocation replacement cannot count as loss',async()=>{const {f,s}=await started();f.controller!.identity.invocationId='e'.repeat(32);f.end();await assert.rejects(s.observeControllerLoss(signal()));assert.deepEqual(f.actions,['start']);});
test('controller PID reuse is rejected despite matching invocation',async()=>{const {f,s}=await started();f.controller!.main={...proc(201,'999'),uid:62001};await assert.rejects(s.checkAdmission());});
test('controller-loss survivor fails without issuing cleanup operations',async()=>{const {f,s}=await started();f.controller=null;await assert.rejects(s.observeControllerLoss(signal()));assert.deepEqual(f.actions,['start']);assert.ok(f.elapsed<=75000);});
test('caller mutation cannot replace deployment pins or launch definition',async()=>{
  const f=fake(),s=createSystemManagerSupervisor(f.p,f.ports);(f.p.artifacts.node as {sha256:string}).sha256='e'.repeat(64);s.definition.execStart=['/tmp/bad'];await s.start(signal());assert.ok(!f.requests.join('').includes('/tmp/bad'));await s.checkAdmission();
});
function receipt(){const p=plan();const r:ApplicationSystemProof={version:3,kind:'health-wallet-application-system-supervision',manager:'system',passed:true,createdAt:'2026-10-22T00:00:00.000Z',bootId:boot,run:p.run,artifacts:copy(p.artifacts),worker:snapshot(p).identity,controller:snapshot(p,true).identity,originalProcesses:[proc(101),proc(102)],checks:systemProofChecks.map(check=>({check,passed:true}))};return {p,r};}
function proof(r:unknown,p=plan(),pin?:string){const b=Buffer.from(JSON.stringify(r));return verifyApplicationSystemProof(b,{plan:p,workerInvocationId:workerToken,receiptSha256:pin??createHash('sha256').update(b).digest('hex'),now:Date.parse('2026-10-22T00:05:00.000Z')});}
test('version 3 application proof binds independent artifacts, boot, worker and controller invocations',()=>{const {r}=receipt();assert.equal(proof(r).manager,'system');});
for(const [name,mutate]of Object.entries({legacy:(r:ApplicationSystemProof)=>{r.version=2 as 3;},python:(r:ApplicationSystemProof)=>{r.kind='synthetic-python-probe' as typeof r.kind;},user:(r:ApplicationSystemProof)=>{r.manager='user' as 'system';},artifact:(r:ApplicationSystemProof)=>{r.artifacts={...r.artifacts,node:{...r.artifacts.node,sha256:'f'.repeat(64)}};},invocation:(r:ApplicationSystemProof)=>{r.worker.invocationId='c'.repeat(32);},controller:(r:ApplicationSystemProof)=>{r.controller.invocationId='d'.repeat(32);},stale:(r:ApplicationSystemProof)=>{r.createdAt='2000-01-01T00:00:00.000Z';},missingCheck:(r:ApplicationSystemProof)=>{r.checks=r.checks.slice(1);},duplicated:(r:ApplicationSystemProof)=>{r.checks=r.checks.map(()=>r.checks[0]);},missingProcesses:(r:ApplicationSystemProof)=>{r.originalProcesses=[];}}))test('application proof rejects '+name,()=>{const {r}=receipt();mutate(r);assert.throws(()=>proof(r));});
test('proof cannot self-authorize a changed independent receipt pin',()=>{assert.throws(()=>proof(receipt().r,plan(),'0'.repeat(64)));});
test('disabled background startup remains side-effect free',async()=>{let calls=0;assert.deepEqual(backgroundConfig({}),{enabled:false});assert.deepEqual(await launchBackground({},async()=>{calls++;throw Error('must not run');}),{enabled:false});assert.equal(calls,0);});
test('legacy user selection delegates unchanged --user collision precheck',async()=>{
  const p:UnitPlan={run:plan().run,uid:1000,node:'/usr/bin/node',entry:'/project/backend/dist/processing/background-entry.js',workingDirectory:'/project/backend',environmentFile:'/private/env',insideReport:'/private/inside',controllerUnit:'health-wallet-'+plan().run+'-controller.service'};
  const calls:string[][]=[];const s=selectSupervision({manager:'user',plan:p,verifyLaunch:async()=>{},saveInside:async()=>{},command:async(_binary,args)=>{calls.push(args);return 'LoadState=loaded';}});
  assert.equal(s.manager,'user');await assert.rejects(s.operations.start('',signal()));assert.ok(calls.every(a=>a[0]==='--user'));assert.equal(calls.length,1);assert.ok(transientArguments(p).includes('--user'));assert.ok(!transientArguments(p).includes('--system'));
});
test('normal API and live controller do not import or select new system adapter',async()=>{
  for(const f of ['../app.ts','../server.ts','../stage-c/live-runtime.ts','../stage-c/controller.ts'])assert.doesNotMatch(await readFile(new URL(f,import.meta.url),'utf8'),/system-supervision|manager-selection/);
});

test('transport exceptions are redacted at the adapter boundary',async()=>{const {f,s}=await started();f.ports.readUnit=async()=>{throw Error('synthetic-secret');};await assert.rejects(s.inspect(),e=>e instanceof Error&&!e.message.includes('synthetic-secret'));});

test('implicit systemd ordering dependencies preserve exact controller coupling',async()=>{const {f,s}=await started();f.worker!.after=[...f.worker!.after,'basic.target'];await s.checkAdmission();});
test('resolved dynamic identity must match original main process UID',async()=>{const {f,s}=await started();f.worker!.resolvedUid=62001;await assert.rejects(s.stop());assert.deepEqual(f.actions,['start']);});
test('controller resource or shutdown protection changes block admission',async()=>{const {f,s}=await started();f.controller!.properties={...f.controller!.properties,Restart:'always'};await assert.rejects(s.checkAdmission());});
test('stalled ownership read is bounded and discloses no underlying error',async()=>{const {f,s}=await started();f.ports.readUnit=()=>new Promise(()=>{});const before=Date.now();await assert.rejects(s.inspect());assert.ok(Date.now()-before<2000);});
test('concurrent cleanup cannot issue duplicate stop operations',async()=>{const {f,s}=await started();const results=await Promise.allSettled([s.stop(),s.stop()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(f.actions,['start','stop']);});
test('mutated controller arguments fail exact ownership',async()=>{const {f,s}=await started();f.controller!.identity.execStart=[...f.controller!.identity.execStart,'--other'];await assert.rejects(s.checkAdmission());});
test('missing live deployment artifact refuses startup',async()=>{const f=fake();delete (f.observed as Partial<typeof f.observed>).manifest;await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,[]);});

test('original detached child survival cannot pass cleanup despite an empty cgroup',async()=>{const {f,s}=await started();f.end();f.ports.readProcess=async pid=>pid===102?proc(102):null;await assert.rejects(s.stop());assert.deepEqual(f.actions,['start']);});
test('reconciliation is read-only until a complete identity can be established',async()=>{const f=fake();let reads=0;f.readOverride=name=>name===f.definition.name&&f.actions.includes('start')&&reads++<2?{kind:'inconclusive',candidateInvocationId:workerToken}:undefined;await createSystemManagerSupervisor(f.p,f.ports).start(signal());assert.deepEqual(f.actions,['start']);});

test('ignored deny-all address-family enforcement blocks admission',async()=>{const {f,s}=await started();f.worker!.addressFamilies={allowList:true,families:['AF_INET']};await assert.rejects(s.checkAdmission());});
test('cleanup cannot interfere with a controller-loss observation',async()=>{
  const {f,s}=await started();const read=f.ports.readUnit;let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  f.ports.readUnit=async(name,abort)=>{if(name===f.definition.properties.BindsTo){await held;return {kind:'missing'};}return read(name,abort);};
  const observation=s.observeControllerLoss(signal());await assert.rejects(s.stop());f.end();release();await observation;assert.deepEqual(f.actions,['start']);
});

test('existing dynamic or static identity collision refuses startup',async()=>{const f=fake(),lookup=f.ports.readIdentity;f.ports.readIdentity=async(user,a)=>user===f.definition.user?{uid:62000}:lookup(user,a);await assert.rejects(createSystemManagerSupervisor(f.p,f.ports).start(signal()));assert.deepEqual(f.actions,[]);});
test('unreleased identity prevents cleanup success without broad account operations',async()=>{const {f,s}=await started();f.ports.readIdentity=async()=>({uid:62000});await assert.rejects(s.stop());assert.deepEqual(f.actions,['start','stop']);assert.ok(f.elapsed<=75000);});

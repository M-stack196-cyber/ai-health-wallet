import {guard} from '../processing/background-config.js';

// Gate 1A deliberately has no OS executor or default transport. Only a future,
// separately reviewed composition may supply these system-manager capabilities.
export type Sha256 = string;
export const artifactRoles = ['node','worker','controller','inside','adapter','manifest'] as const;
export type ArtifactRole = typeof artifactRoles[number];
export type ArtifactPins = Readonly<Record<ArtifactRole, Readonly<{path:string;sha256:Sha256}>>>;
export interface ProcessIdentity {pid:number;startTime:string;uid:number;bootId:string;}
export interface TransientIdentity {
  manager:'system';bootId:string;id:string;description:string;transient:true;fragmentPath:string;
  invocationId:string;user:string;dynamicUser:true;execStart:readonly string[];controlGroup:string;
}
export interface SystemPlan {
  manager:'system';run:string;bootId:string;releaseDirectory:string;artifacts:ArtifactPins;
  controllerInvocationId:string;controllerArguments:readonly string[];
}
export interface UnitDefinition {
  manager:'system';name:string;description:string;user:string;controlGroup:string;
  execStart:readonly string[];execStartPre:readonly string[];
  // Canonical values, not shell text. A future D-Bus encoder must implement the
  // deny-all address-family tuple explicitly; unit-file empty resets differ.
  properties:Readonly<Record<string,string>>;
  addressFamilies:Readonly<{allowList:true;families:readonly string[]}>;
}
export interface UnitSnapshot {
  identity:TransientIdentity;state:'active'|'activating'|'deactivating'|'inactive'|'failed';
  main:ProcessIdentity|null;resolvedUid:number;mainExecutableSha256:string|null;
  execStartPre:readonly string[];properties:Readonly<Record<string,string>>;
  bindsTo:readonly string[];after:readonly string[];
  addressFamilies:Readonly<{allowList:true;families:readonly string[]}>;
  effective:{cpuQuota:number;cpuPeriod:number;memoryMax:number;tasksMax:number;readOnlyCgroup:boolean;};
}
export type Observation = {kind:'missing'}|{kind:'inconclusive';candidateInvocationId?:string}|{kind:'present';unit:UnitSnapshot};
export interface Containment {path:string;exists:boolean;populated:boolean;processes:readonly ProcessIdentity[];}
export interface ArtifactObservation {path:string;sha256:string;uid:number;regular:boolean;symlink:boolean;links:number;mode:number;safeAncestors:boolean;serviceWritable:boolean;}
export interface OwnedInvocation {readonly identity:Readonly<TransientIdentity>;}
export interface SystemManagerPorts {
  readonly manager:'system';
  // All reads must be bounded, fresh and collected through a trusted observer.
  readUnit(name:string,signal:AbortSignal):Promise<Observation>;
  readArtifacts(pins:ArtifactPins,signal:AbortSignal):Promise<Readonly<Record<ArtifactRole,ArtifactObservation>>>;
  readContainment(path:string,signal:AbortSignal):Promise<Containment>;
  readProcess(pid:number,signal:AbortSignal):Promise<ProcessIdentity|null>;
  readIdentity(user:string,signal:AbortSignal):Promise<{uid:number}|null>;
  startTransient(definition:UnitDefinition,signal:AbortSignal):Promise<{invocationId:string}>;
  // Implementations must compare the full expected identity immediately before
  // control, refuse replacements and never fall back to PID kill or broad reset.
  stopExact(owned:OwnedInvocation,signal:AbortSignal):Promise<void>;
  resetFailedExact(owned:OwnedInvocation,signal:AbortSignal):Promise<void>;
  now():number; // monotonic milliseconds
  pause(ms:number,signal:AbortSignal):Promise<void>;
}
export class SystemSupervisionError extends Error {
  constructor(readonly code:'refused'|'collision'|'ownership'|'unresolved'|'cleanup'|'controller-lost'|'cancelled') {
    super('System supervision '+code+'.');
  }
}
const fail=(code:ConstructorParameters<typeof SystemSupervisionError>[0]):never=>{throw new SystemSupervisionError(code);};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const invocation=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v)&&!/^0+$/.test(v);
const path=(v:string)=>/^\/[a-zA-Z0-9/_.-]+$/.test(v)&&!v.split('/').some(p=>p==='..'||p==='.')&&!v.includes('//');
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function validateSystemPlan(p:SystemPlan):void {
  guard(p.manager==='system'&&/^stage-c-[a-f0-9]{24}$/.test(p.run));
  guard(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.bootId)&&invocation(p.controllerInvocationId));
  guard(Array.isArray(p.controllerArguments)&&p.controllerArguments.length<=64&&p.controllerArguments.every(v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\x00-\x20\x7f%]/.test(v)));
  guard(/^\/opt\/ai-health-wallet\/releases\/[a-zA-Z0-9_-]+$/.test(p.releaseDirectory));
  guard(p.artifacts&&Object.keys(p.artifacts).sort().join(',')===[...artifactRoles].sort().join(','));
  for(const role of artifactRoles){const a=p.artifacts[role];guard(a&&path(a.path)&&hash(a.sha256));
    guard(a.path.startsWith(p.releaseDirectory+'/'));}
  guard(new Set(artifactRoles.map(r=>p.artifacts[r].path)).size===artifactRoles.length);
  guard(['background-entry.js','operational-entry.js'].some(name=>p.artifacts.worker.path===p.releaseDirectory+'/backend/dist/processing/'+name));
  guard(p.artifacts.controller.path===p.releaseDirectory+'/backend/dist/stage-c/cli.js');
  guard(p.artifacts.inside.path===p.releaseDirectory+'/backend/dist/stage-c/inside-entry.js');
  guard(p.artifacts.adapter.path===p.releaseDirectory+'/backend/dist/stage-c/system-supervision.js');
  guard(p.artifacts.manifest.path===p.releaseDirectory+'/deployment-manifest.json');
}
export function systemUnitDefinition(p:SystemPlan):UnitDefinition {
  validateSystemPlan(p);
  const name='health-wallet-'+p.run+'.service',controller='health-wallet-'+p.run+'-controller.service';
  const runtime='health-wallet-'+p.run;
  return {manager:'system',name,description:'AI Health Wallet '+p.run,user:'hw-'+p.run.slice(8),controlGroup:'/system.slice/'+name,
    execStart:[p.artifacts.node.path,p.artifacts.worker.path],
    execStartPre:[p.artifacts.node.path,p.artifacts.inside.path,'/run/'+runtime+'/inside.json'],
    addressFamilies:{allowList:true,families:[]},
    properties:{Type:'exec',DynamicUser:'yes',Restart:'no',BindsTo:controller,After:controller,
      WorkingDirectory:p.releaseDirectory+'/backend',RuntimeDirectory:runtime,RuntimeDirectoryMode:'0700',
      RuntimeMaxSec:'600',CPUQuota:'200%',MemoryMax:'3221225472',TasksMax:'128',
      KillMode:'mixed',KillSignal:'SIGTERM',TimeoutStopSec:'60',SendSIGKILL:'yes',
      ProtectControlGroups:'yes',Delegate:'no',PrivateMounts:'yes',PrivateNetwork:'yes',PrivateDevices:'yes',
      ProtectHome:'yes',ProtectSystem:'strict',PrivateTmp:'yes',NoNewPrivileges:'yes',
      CapabilityBoundingSet:'',AmbientCapabilities:'',UMask:'0077',StandardOutput:'null',StandardError:'null'}};
}
export function systemControllerDefinition(p:SystemPlan):UnitDefinition {
  const w=systemUnitDefinition(p),name=w.properties.BindsTo;
  const {BindsTo:_binds,After:_after,...properties}=w.properties;
  return {...w,name,description:w.description+' controller',user:w.user+'c',controlGroup:'/system.slice/'+name,
    execStart:[p.artifacts.node.path,p.artifacts.controller.path,...p.controllerArguments],
    execStartPre:[p.artifacts.node.path,p.artifacts.inside.path,'/run/'+name.slice(0,-8)+'/inside.json'],
    properties:{...properties,RuntimeDirectory:name.slice(0,-8),RuntimeMaxSec:'900',CPUQuota:'50%',MemoryMax:'805306368',TasksMax:'64',KillMode:'control-group'}};
}
export function assertSystemIdentity(p:SystemPlan,i:TransientIdentity,role:'worker'|'controller',token:string,allowEmptyGroup=false):void {
  const d=systemUnitDefinition(p),name=role==='worker'?d.name:'health-wallet-'+p.run+'-controller.service';
  const description=role==='worker'?d.description:d.description+' controller';
  const user=role==='worker'?d.user:d.user+'c';
  guard(i.manager==='system'&&i.bootId===p.bootId&&i.id===name&&i.description===description&&i.transient===true);
  guard(i.fragmentPath==='/run/systemd/transient/'+name&&i.user===user&&i.dynamicUser===true);
  guard(invocation(token)&&i.invocationId===token);
  guard(equal(i.execStart,role==='worker'?[p.artifacts.node.path,p.artifacts.worker.path]:[p.artifacts.node.path,p.artifacts.controller.path,...p.controllerArguments]));
  guard(i.controlGroup==='/system.slice/'+name||(allowEmptyGroup&&i.controlGroup===''));
}
function validProcess(p:ProcessIdentity,boot:string){guard(Number.isSafeInteger(p.pid)&&p.pid>1&&Number.isSafeInteger(p.uid)&&p.uid>0&&/^\d+$/.test(p.startTime)&&p.bootId===boot);}
const sameProcess=(a:ProcessIdentity,b:ProcessIdentity)=>a.pid===b.pid&&a.startTime===b.startTime&&a.uid===b.uid&&a.bootId===b.bootId;
// Wall-clock timeouts apply even if an injected read or pause never resolves.
async function bounded<T>(ms:number,fn:(s:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const cancel=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const combined=signal?AbortSignal.any([signal,cancel.signal]):cancel.signal;
  let abort:(()=>void)|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>{combined.throwIfAborted();return fn(combined);}),new Promise<never>((_,reject)=>{
    abort=()=>reject(new SystemSupervisionError('cancelled'));combined.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{reject(new SystemSupervisionError('unresolved'));cancel.abort();},ms);
    if(combined.aborted)abort();
  })]);}catch(e){if(e instanceof SystemSupervisionError)throw e;throw new SystemSupervisionError('refused');}finally{if(timer)clearTimeout(timer);if(abort)combined.removeEventListener('abort',abort);cancel.abort();}
}
export interface SystemManagerSupervisor {
  readonly manager:'system';readonly definition:UnitDefinition;
  start(signal:AbortSignal):Promise<void>;
  inspect(signal?:AbortSignal):Promise<UnitSnapshot>;
  checkAdmission(signal?:AbortSignal):Promise<void>;
  stop():Promise<{cleanupVerified:true;processesGone:true;cgroupEmptyOrAbsent:true;unitUnloaded:true;identityReleased:true}>;
  observeControllerLoss(signal:AbortSignal):Promise<{controllerLossVerified:true;issuedNoStopOrKill:true;processesGone:true;cgroupEmptyOrAbsent:true}>;
}
export function createSystemManagerSupervisor(input:SystemPlan,ports:SystemManagerPorts):SystemManagerSupervisor {
  validateSystemPlan(input);guard(ports.manager==='system');
  // Snapshot caller-owned plan/pins, so later mutation cannot change trust roots.
  const p: SystemPlan=JSON.parse(JSON.stringify(input));
  const definition=systemUnitDefinition(p); // callers receive a separate copy below
  let attempted=false,token:string|undefined,owned:TransientIdentity|undefined,main:ProcessIdentity|undefined;
  let controllerSeen=false,stopped=false,controlBusy=false,observingLoss=false;
  let controllerMain:ProcessIdentity|undefined;
  const recorded=new Map<string,ProcessIdentity>();
  const call=<T>(fn:(s:AbortSignal)=>Promise<T>,s?:AbortSignal,ms=500)=>bounded(ms,fn,s);
  async function artifacts(signal?:AbortSignal){
    const found=await call(s=>ports.readArtifacts(JSON.parse(JSON.stringify(p.artifacts)),s),signal);
    guard(found&&Object.keys(found).sort().join(',')===[...artifactRoles].sort().join(','));
    for(const role of artifactRoles){const a=found[role],pin=p.artifacts[role];
      guard(a&&a.path===pin.path&&a.sha256===pin.sha256&&a.uid===0&&a.regular===true&&a.symlink===false&&a.links===1&&a.safeAncestors===true&&a.serviceWritable===false&&Number.isSafeInteger(a.mode)&&a.mode>=0&&(a.mode&0o022)===0);}
  }
  async function controller(signal?:AbortSignal,allowGone=false){
    const result=await call(s=>ports.readUnit(definition.properties.BindsTo,s),signal);
    if(result.kind==='missing'&&allowGone&&controllerSeen)return false;
    guard(result.kind==='present');const u=result.unit;
    assertSystemIdentity(p,u.identity,'controller',p.controllerInvocationId,controllerSeen&&u.main===null);
    if(u.state!=='active'){if(allowGone&&controllerSeen&&['inactive','failed'].includes(u.state)&&u.main===null)return false;fail('controller-lost');}
    guard(u.main&&u.main.uid===u.resolvedUid&&u.mainExecutableSha256===p.artifacts.node.sha256);validProcess(u.main,p.bootId);
    guard((await call(s=>ports.readIdentity(u.identity.user,s),signal))?.uid===u.main.uid);
    const expected=systemControllerDefinition(p);
    for(const [key,value]of Object.entries(expected.properties))guard(u.properties[key]===value);
    guard(equal(u.execStartPre,expected.execStartPre)&&equal(u.addressFamilies,expected.addressFamilies));
    const effective=u.effective;guard(Number.isSafeInteger(effective.cpuPeriod)&&Number.isSafeInteger(effective.cpuQuota)&&effective.cpuPeriod>0&&effective.cpuQuota*2===effective.cpuPeriod&&effective.memoryMax===805306368&&effective.tasksMax===64&&effective.readOnlyCgroup===true);
    if(controllerMain&&!sameProcess(controllerMain,u.main))fail('ownership');
    controllerMain??={...u.main};controllerSeen=true;return true;
  }
  async function containment(signal?:AbortSignal){
    const c=await call(s=>ports.readContainment(definition.controlGroup,s),signal);
    guard(typeof c.exists==='boolean'&&typeof c.populated==='boolean'&&Array.isArray(c.processes));
    guard(c.path===definition.controlGroup&&c.processes.length<=128&&new Set(c.processes.map(v=>v.pid)).size===c.processes.length);
    guard(c.exists||(!c.populated&&c.processes.length===0));
    guard(c.populated===Boolean(c.processes.length));
    for(const proc of c.processes){validProcess(proc,p.bootId);if(main)guard(proc.uid===main.uid);recorded.set(proc.pid+':'+proc.startTime,{...proc});}
    return c;
  }
  function candidate(candidate:string|undefined){if(candidate!==undefined){guard(invocation(candidate));if(token&&token!==candidate)fail('ownership');token=candidate;}}
  function remember(u:UnitSnapshot):UnitSnapshot {
    if(!attempted||!token)fail('ownership');guard(['active','activating','deactivating','inactive','failed'].includes(u.state));assertSystemIdentity(p,u.identity,'worker',token!,Boolean(owned)&&u.main===null&&['inactive','failed'].includes(u.state));
    if(u.main){validProcess(u.main,p.bootId);guard(u.main.uid===u.resolvedUid);guard(u.mainExecutableSha256===p.artifacts.node.sha256);
      if(main&&!sameProcess(main,u.main))fail('ownership');main??={...u.main};recorded.set(main.pid+':'+main.startTime,{...main});}
    // Preserve the originally proved group even after systemd clears ControlGroup.
    owned={...u.identity,execStart:[...u.identity.execStart],controlGroup:definition.controlGroup};
    return JSON.parse(JSON.stringify(u));
  }
  async function inspect(signal?:AbortSignal):Promise<UnitSnapshot>{
    if(!attempted||!token)fail('ownership');
    const r=await call(s=>ports.readUnit(definition.name,s),signal);guard(r.kind==='present');return remember(r.unit);
  }
  async function verifyActive(u:UnitSnapshot,signal?:AbortSignal){
    guard(u.state==='active'&&u.main!==null&&equal(u.execStartPre,definition.execStartPre)&&equal(u.addressFamilies,definition.addressFamilies));
    for(const [k,v]of Object.entries(definition.properties))guard(u.properties[k]===v);
    const ctrl=definition.properties.BindsTo;guard(equal(u.bindsTo,[ctrl])&&u.after.includes(ctrl));
    const e=u.effective;guard(Number.isSafeInteger(e.cpuPeriod)&&Number.isSafeInteger(e.cpuQuota)&&e.cpuPeriod>0&&e.cpuQuota===2*e.cpuPeriod&&e.memoryMax===3221225472&&e.tasksMax===128&&e.readOnlyCgroup===true);
    guard((await call(s=>ports.readIdentity(u.identity.user,s),signal))?.uid===u.main.uid);
    const c=await containment(signal);guard(c.exists&&c.populated&&c.processes.some(v=>sameProcess(v,u.main!)));
  }
  async function reconcile(signal?:AbortSignal):Promise<UnitSnapshot>{
    const until=ports.now()+5000;
    for(let n=0;n<8&&ports.now()<until;n++){
      let r:Observation;
      try{r=await call(s=>ports.readUnit(definition.name,s),signal);}catch{if(signal?.aborted)fail('cancelled');r={kind:'inconclusive'};}
      if(r.kind==='inconclusive')candidate(r.candidateInvocationId);
      if(r.kind==='present'){
        candidate(r.unit.identity.invocationId);
        // An observed conflicting identity is fatal, never retried/adopted.
        assertSystemIdentity(p,r.unit.identity,'worker',token!);
        return remember(r.unit);
      }
      await call(s=>ports.pause(100,s),signal,150);
    }
    return fail('unresolved');
  }
  async function gone(signal?:AbortSignal){
    const c=await containment(signal);if(c.populated||c.processes.length)return false;
    for(const original of recorded.values()){
      const current=await call(s=>ports.readProcess(original.pid,s),signal);
      if(current){validProcess(current,p.bootId);if(sameProcess(current,original))return false;}
    }return true;
  }
  async function waitGone(signal?:AbortSignal){
    const until=ports.now()+75000;
    // Count and deadline cap the complete observation. No mutation/retry here.
    for(let n=0;n<75&&ports.now()<until;n++){
      const r=await call(s=>ports.readUnit(definition.name,s),signal);
      if(r.kind==='inconclusive'){candidate(r.candidateInvocationId);}
      else if(r.kind==='present'){
        assertSystemIdentity(p,r.unit.identity,'worker',token!,true);
        if(r.unit.main){validProcess(r.unit.main,p.bootId);if(main&&!sameProcess(main,r.unit.main))fail('ownership');}
        if(['inactive','failed'].includes(r.unit.state)&&r.unit.main===null&&await gone(signal))return r;
      }else if(await gone(signal))return r;
      await call(s=>ports.pause(1000,s),signal,1100);
    }
    return fail('cleanup');
  }
  async function collected(signal?:AbortSignal){
    for(let n=0;n<75;n++){
      const r=await call(s=>ports.readUnit(definition.name,s),signal);
      if(r.kind==='present')assertSystemIdentity(p,r.unit.identity,'worker',token!,true);
      if(r.kind==='missing'&&await gone(signal)&&await call(s=>ports.readIdentity(definition.user,s),signal)===null)return;
      await call(s=>ports.pause(1000,s),signal,1100);
    }return fail('cleanup');
  }
  async function stop(signal?:AbortSignal){
    if(stopped||observingLoss)fail('refused');if(controlBusy)fail('refused');controlBusy=true;
    try{
      if(!owned||!token)fail('ownership');
      const r=await call(s=>ports.readUnit(definition.name,s),signal);
      if(r.kind==='missing'){await collected(signal);stopped=true;return {cleanupVerified:true as const,processesGone:true as const,cgroupEmptyOrAbsent:true as const,unitUnloaded:true as const,identityReleased:true as const};}
      guard(r.kind==='present');await inspect(signal);
      // Fresh metadata and independent artifact pins, even on a safety failure.
      await artifacts(signal);const current=await inspect(signal);
      if(!['inactive','failed'].includes(current.state))await call(s=>ports.stopExact({identity:JSON.parse(JSON.stringify(owned!))},s),signal,65000);
      const end=await waitGone(signal);
      if(end.kind==='present'&&end.unit.state==='failed'){
        await artifacts(signal);const latest=await inspect(signal);guard(latest.state==='failed');
        await call(s=>ports.resetFailedExact({identity:JSON.parse(JSON.stringify(owned!))},s),signal,3000);
      }
      // Collection must not conceal a replacement, surviving process or identity.
      await collected(signal);stopped=true;
      return {cleanupVerified:true as const,processesGone:true as const,cgroupEmptyOrAbsent:true as const,unitUnloaded:true as const,identityReleased:true as const};
    }finally{controlBusy=false;}
  }
  return {
    manager:'system',definition:JSON.parse(JSON.stringify(definition)),inspect,
    async start(signal){
      if(attempted||controlBusy)fail('refused');attempted=true;controlBusy=true;
      try{
        signal.throwIfAborted();await artifacts(signal);await controller(signal);
        const old=await call(s=>ports.readUnit(definition.name,s),signal);if(old.kind!=='missing')fail('collision');
        guard(await call(s=>ports.readIdentity(definition.user,s),signal)===null);
        const c=await containment(signal);guard(!c.exists); // stale cgroups also refuse
        let startFailed=false;
        try{const ack=await call(s=>ports.startTransient(JSON.parse(JSON.stringify(definition)),s),signal,3000);candidate(ack.invocationId);}catch{startFailed=true;}
        // Reconcile even after cancellation/lost acknowledgement. Reads only.
        let u:UnitSnapshot;
        try{u=await bounded(5000,s=>reconcile(s));}catch{throw new SystemSupervisionError('unresolved');}
        if(startFailed||signal.aborted){controlBusy=false;await bounded(75000,s=>stop(s));fail('refused');}
        try{await artifacts(signal);await controller(signal);await verifyActive(u,signal);}
        catch{controlBusy=false;await bounded(75000,s=>stop(s));fail('refused');}
      }catch(e){if(e instanceof SystemSupervisionError)throw e;throw new SystemSupervisionError('refused');}
      finally{controlBusy=false;}
    },
    async checkAdmission(signal){await artifacts(signal);await controller(signal);await verifyActive(await inspect(signal),signal);},
    stop:()=>bounded(75000,s=>stop(s)),
    async observeControllerLoss(signal){
      guard(owned&&token&&controllerSeen&&!stopped&&!controlBusy&&!observingLoss);observingLoss=true;
      try{return await bounded(75000,async observationSignal=>{
      guard(owned&&token&&controllerSeen&&!stopped&&!controlBusy);
      // Test harness may arrange synthetic loss externally. This method only
      // observes: it never stops, resets, signals or manufactures controller loss.
      const until=ports.now()+75000;
      for(let n=0;n<75&&ports.now()<until;n++){
        if(!await controller(observationSignal,true)){
          await waitGone(observationSignal);
          return {controllerLossVerified:true,issuedNoStopOrKill:true,processesGone:true,cgroupEmptyOrAbsent:true};
        }
        await call(s=>ports.pause(1000,s),observationSignal,1100);
      }return fail('controller-lost');
      },signal);}finally{observingLoss=false;}
    }
  };
}

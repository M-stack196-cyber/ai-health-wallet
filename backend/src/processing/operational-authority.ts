import {createHash} from 'node:crypto';
import {guard,assertCanary,type BackgroundConfig} from './background-config.js';
import {credentialDeploymentIdentity,type SystemFileSelection} from '../stage-c/system-credentials.js';
import {assertSystemIdentity,artifactRoles,systemUnitDefinition,systemControllerDefinition,validateSystemPlan,type SystemManagerPorts,type ProcessIdentity,type SystemPlan} from '../stage-c/system-supervision.js';
import {target} from '../integration/guards.js';

export const operationalService='document-processing-operational';
export type OperationalState='starting'|'ready'|'draining'|'expired'|'controller-lost'|'stopped'|'failed';
export interface NetworkIntent {version:1;defaultDeny:true;proxies:false;redirects:false;postgres:{host:'127.0.0.1';port:5433};objectStorage:{account:string;region:string;bucket:string;prefix:string};}
export const operationalNetwork:Readonly<NetworkIntent>=Object.freeze({version:1,defaultDeny:true,proxies:false,redirects:false,postgres:Object.freeze({host:'127.0.0.1',port:5433}),objectStorage:Object.freeze({account:target.account,region:target.region,bucket:target.bucket,prefix:target.prefix})});
// Logical destinations only. This is not an OS firewall, DNS pin or network proof.
// Security preflight also requires scoped STS/S3-control reads via the injected port.
export interface OperationalSelection {version:1;mode:'system-files';background:BackgroundConfig;credentials:SystemFileSelection;workerInvocationId:string;network:NetworkIntent;resourcePolicySha256:string;credentialsExpireAt:string;authorizationPin:{sha256:string;ownerUid:number;mode:0o400|0o600};}
export const canonical=(v:unknown):string=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,JSON.parse(canonical(x))])):Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):v);
export const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export function operationalConfigIdentity(s:OperationalSelection){return digest({version:1,background:s.background,credentials:s.credentials,workerInvocationId:s.workerInvocationId,network:s.network,resourcePolicySha256:s.resourcePolicySha256,credentialsExpireAt:s.credentialsExpireAt});}
export function validateOperational(s:OperationalSelection){
 guard(s&&Object.keys(s).sort().join(',')==='authorizationPin,background,credentials,credentialsExpireAt,mode,network,resourcePolicySha256,version,workerInvocationId');
 guard(s?.version===1&&s.mode==='system-files'&&s.credentials?.mode==='system-files');
 const p=s.credentials.binding.plan;validateSystemPlan(p);guard(s.credentials.directory.path==='/run/credentials/'+systemUnitDefinition(p).name);assertCanary(s.background.canary);
 guard(p.artifacts.worker.path===p.releaseDirectory+'/backend/dist/processing/operational-entry.js');
 guard(s.background.enabled===true&&s.background.concurrency===1&&s.background.pollMs>=1000&&s.background.pollMs<=30000&&s.background.backoffMaxMs===30000&&s.background.drainMs>=0&&s.background.drainMs<=60000&&s.background.healthPort>=1024&&s.background.healthPort<=65535);
 guard([s.background.pollMs,s.background.drainMs,s.background.healthPort].every(Number.isSafeInteger));
 guard(canonical(s.background.canary)===canonical(s.credentials.binding.canary));
 guard(s.background.approvalPath===s.credentials.directory.path+'/processing-approval.json'&&s.background.approvalSha256===s.credentials.pins.approval.sha256);
 guard(canonical(s.network)===canonical(operationalNetwork));
 guard(/^[a-f0-9]{32}$/.test(s.workerInvocationId)&&!/^0+$/.test(s.workerInvocationId)&&s.workerInvocationId!==p.controllerInvocationId);
 guard(/^[a-f0-9]{64}$/.test(s.resourcePolicySha256)&&Number.isFinite(Date.parse(s.credentialsExpireAt))&&new Date(s.credentialsExpireAt).toISOString()===s.credentialsExpireAt);
 guard(s.authorizationPin&&/^[a-f0-9]{64}$/.test(s.authorizationPin.sha256));
 return p;
}
export interface RuntimeGrant {version:1;kind:'health-wallet-operational-authorization';run:string;deploymentSha256:string;configurationSha256:string;workerInvocationId:string;controllerInvocationId:string;issuedAt:string;expiresAt:string;}
export function validateRuntimeGrant(bytes:Uint8Array,s:OperationalSelection,now:number):RuntimeGrant {
 const p=validateOperational(s);guard(bytes.byteLength>0&&bytes.byteLength<=4096);
 let g:RuntimeGrant;try{g=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{guard(false);}
 guard(g&&Object.keys(g).sort().join(',')==='configurationSha256,controllerInvocationId,deploymentSha256,expiresAt,issuedAt,kind,run,version,workerInvocationId');
 // Canonical encoding refuses duplicate keys and ambiguous encodings in this new envelope.
 guard(Buffer.from(bytes).equals(Buffer.from(canonical(g))));
 guard(g.version===1&&g.kind==='health-wallet-operational-authorization'&&g.run===p.run&&g.deploymentSha256===credentialDeploymentIdentity(p)&&g.configurationSha256===operationalConfigIdentity(s)&&g.workerInvocationId===s.workerInvocationId&&g.controllerInvocationId===p.controllerInvocationId);
 const issued=Date.parse(g.issuedAt),expiry=Date.parse(g.expiresAt);
 guard(Number.isFinite(now)&&Number.isFinite(issued)&&Number.isFinite(expiry)&&new Date(issued).toISOString()===g.issuedAt&&new Date(expiry).toISOString()===g.expiresAt&&issued<=now&&now<expiry&&expiry>issued&&expiry-issued<=600000&&expiry<=Date.parse(s.credentialsExpireAt));return g;
}
export type ReadOnlySystemPorts=Pick<SystemManagerPorts,'manager'|'readUnit'|'readArtifacts'|'readContainment'|'readProcess'|'readIdentity'>;
const same=(a:ProcessIdentity,b:ProcessIdentity)=>canonical(a)===canonical(b);
// Fresh inside-worker reads only. No start/stop/reset/kill capability is accepted.
export async function verifyOperationalOwner(p:SystemPlan,invocation:string,ports:ReadOnlySystemPorts,self:ProcessIdentity,signal:AbortSignal){
 guard(ports.manager==='system'&&self.pid>1&&Number.isSafeInteger(self.pid)&&self.uid>0&&Number.isSafeInteger(self.uid)&&/^\d+$/.test(self.startTime)&&self.bootId===p.bootId);
 const artifacts=await ports.readArtifacts(p.artifacts,signal);guard(Object.keys(artifacts).sort().join(',')===[...artifactRoles].sort().join(','));
 for(const role of artifactRoles){const v=artifacts[role],pin=p.artifacts[role];guard(v&&v.path===pin.path&&v.sha256===pin.sha256&&v.uid===0&&v.regular===true&&v.symlink===false&&v.links===1&&Number.isSafeInteger(v.mode)&&(v.mode&0o022)===0&&v.safeAncestors===true&&v.serviceWritable===false);}
 for(const role of ['controller','worker'] as const){
  const d=role==='worker'?systemUnitDefinition(p):systemControllerDefinition(p),r=await ports.readUnit(d.name,signal);guard(r.kind==='present');const u=r.unit;
  assertSystemIdentity(p,u.identity,role,role==='worker'?invocation:p.controllerInvocationId);
  guard(u.state==='active'&&u.main&&u.main.pid>1&&Number.isSafeInteger(u.main.pid)&&u.main.uid===u.resolvedUid&&u.main.uid>0&&/^\d+$/.test(u.main.startTime)&&u.main.bootId===p.bootId&&u.mainExecutableSha256===p.artifacts.node.sha256);
  if(role==='worker')guard(same(u.main,self));
  guard((await ports.readIdentity(d.user,signal))?.uid===u.main.uid);
  const process=await ports.readProcess(u.main.pid,signal);guard(process&&same(process,u.main));
  for(const [key,value]of Object.entries(d.properties))guard(u.properties[key]===value);
  guard(canonical(u.execStartPre)===canonical(d.execStartPre)&&canonical(u.addressFamilies)===canonical(d.addressFamilies));
  if(role==='worker')guard(canonical(u.bindsTo)==canonical([d.properties.BindsTo])&&u.after.includes(d.properties.After));
  const e=u.effective;guard(e.readOnlyCgroup===true&&Number.isSafeInteger(e.cpuQuota)&&Number.isSafeInteger(e.cpuPeriod)&&e.cpuPeriod>0&&e.cpuQuota===(role==='worker'?2*e.cpuPeriod:e.cpuPeriod/2)&&e.memoryMax===(role==='worker'?3221225472:805306368)&&e.tasksMax===(role==='worker'?128:64));
  const c=await ports.readContainment(d.controlGroup,signal);guard(c.path===d.controlGroup&&c.exists&&c.populated&&c.processes.length<=e.tasksMax&&new Set(c.processes.map(v=>v.pid)).size===c.processes.length&&c.processes.some(v=>same(v,u.main!)));
  for(const child of c.processes)guard(child.uid===u.main.uid&&child.bootId===p.bootId&&Number.isSafeInteger(child.pid)&&child.pid>1&&/^\d+$/.test(child.startTime));
 }
}

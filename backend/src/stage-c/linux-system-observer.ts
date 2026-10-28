import {execFile} from 'node:child_process';
import {readdir,readlink,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {artifactRoles,systemUnitDefinition,systemControllerDefinition,validateSystemPlan,type SystemPlan,type ProcessIdentity,type UnitSnapshot,type Observation,type ArtifactRole,type ArtifactObservation} from './system-supervision.js';
import type {ReadOnlySystemPorts} from '../processing/operational-authority.js';
import type {immutableArtifactReader} from './immutable-artifacts.js';

export class HostObservationRefusal extends Error {constructor(){super('Read-only system observation refused.');}}
function need(v:unknown):asserts v {if(!v)throw new HostObservationRefusal();}
export interface InsideMountProof {bootId:string;pid:number;startTime:string;uid:number;controlGroup:string;readOnlyVerified:true;observedAt:number;}
export interface LinuxObservationIO {
 show(name:string,fields:readonly string[],signal:AbortSignal):Promise<string>;
 text(path:string,max:number,signal:AbortSignal):Promise<string>;
 directories(path:string,signal:AbortSignal):Promise<readonly string[]>;
 link(path:string,signal:AbortSignal):Promise<string>;
 artifact:ReturnType<typeof immutableArtifactReader>;
 // No NSS/home/default-provider lookup. The trusted system-manager read broker
 // must identify currently allocated dynamic identities and typed D-Bus values.
 identity(user:string,signal:AbortSignal):Promise<{uid:number}|null>;
 families(unit:string,signal:AbortSignal):Promise<{allowList:true;families:readonly string[]}>;
 inside(unit:string,process:ProcessIdentity,signal:AbortSignal):Promise<InsideMountProof>;
 now():number;
}
const scalar=['Id','Description','Transient','FragmentPath','InvocationID','User','DynamicUser','ExecStart','ExecStartPre','ActiveState','MainPID','ControlGroup','LoadState','BindsTo','After','CPUQuotaPerSecUSec','RuntimeMaxUSec','TimeoutStopUSec','MemoryMax','TasksMax','Type','Restart','WorkingDirectory','RuntimeDirectory','RuntimeDirectoryMode','KillMode','KillSignal','SendSIGKILL','ProtectControlGroups','Delegate','PrivateMounts','PrivateNetwork','PrivateDevices','ProtectHome','ProtectSystem','PrivateTmp','NoNewPrivileges','CapabilityBoundingSet','AmbientCapabilities','UMask','StandardOutput','StandardError'] as const;
export function parseSystemShow(raw:string):Record<string,string>{
 need(Buffer.byteLength(raw)<=65536&&!raw.includes('\0'));const v:Record<string,string>={};
 for(const line of raw.trimEnd().split('\n')){const i=line.indexOf('=');need(i>0);const key=line.slice(0,i);need((scalar as readonly string[]).includes(key)&&!Object.hasOwn(v,key));v[key]=line.slice(i+1);}
 return v;
}
export function parseProcess(stat:string,status:string,bootId:string,pid:number):ProcessIdentity {
 // comm may contain spaces and ')'; field22 is relative to the final ') '.
 const end=stat.lastIndexOf(') ');need(end>0&&stat.startsWith(String(pid)+' ('));
 const fields=stat.slice(end+2).trim().split(/\s+/),uid=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
 need(fields.length>=20&&/^\d+$/.test(fields[19])&&uid&&new Set(uid.slice(1)).size===1);
 const owner=Number(uid[1]);need(Number.isSafeInteger(owner)&&owner>0);return {pid,startTime:fields[19],uid:owner,bootId};
}
const seconds=(v:string)=>{const m=/^(\d+)(us|ms|s|min|h)$/.exec(v);need(m);const n=Number(m[1])*({us:0.000001,ms:0.001,s:1,min:60,h:3600}[m[2] as 's']);need(Number.isFinite(n));return n;};
const argv=(raw:string,expected:readonly string[])=>{
 need(expected.every(v=>/^[-a-zA-Z0-9_./:=]+$/.test(v))); // ambiguous quoting is refused
 need((raw.match(/argv\[\]=/g)??[]).length===1&&(raw.match(/\bpath=/g)??[]).length===1);
 const p=/^\{ path=([^ ;]+) ; argv\[\]=([^;]+) ;/.exec(raw);need(p&&p[1]===expected[0]&&p[2].trim()===expected.join(' '));return [...expected];
};
const missing=(e:unknown)=>e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT';
export function createLinuxSystemObserver(input:SystemPlan,io:LinuxObservationIO):ReadOnlySystemPorts {
 validateSystemPlan(input);io={...io};const plan=structuredClone(input),worker=systemUnitDefinition(plan),controller=systemControllerDefinition(plan);
 const allowed=[worker,controller],boot=async(s:AbortSignal)=>{need((await io.text('/proc/sys/kernel/random/boot_id',64,s)).trim()===plan.bootId);};
 async function processIdentity(pid:number,s:AbortSignal):Promise<ProcessIdentity|null>{
  need(Number.isSafeInteger(pid)&&pid>1);s.throwIfAborted();await boot(s);
  try{const first=await io.text('/proc/'+pid+'/stat',8192,s),status=await io.text('/proc/'+pid+'/status',16384,s),last=await io.text('/proc/'+pid+'/stat',8192,s);const a=parseProcess(first,status,plan.bootId,pid),b=parseProcess(last,status,plan.bootId,pid);need(JSON.stringify(a)===JSON.stringify(b));return b;}catch(e){if(missing(e))return null;throw new HostObservationRefusal();}
 }
 async function containment(path:string,s:AbortSignal){
  need(allowed.some(d=>d.controlGroup===path));await boot(s);let visited=0;const ids=new Set<number>();
  async function walk(part:string,depth:number):Promise<void>{
   need(depth<=8&&++visited<=128);const text=await io.text('/sys/fs/cgroup'+part+'/cgroup.procs',8192,s);
   for(const item of text.trim().split(/\s+/).filter(Boolean)){need(/^\d+$/.test(item));ids.add(Number(item));need(ids.size<=128);}
   for(const name of await io.directories('/sys/fs/cgroup'+part,s)){need(/^[a-zA-Z0-9_.:-]+$/.test(name)&&name!=='.'&&name!=='..');await walk(part+'/'+name,depth+1);}
  }
  try{await walk(path,0);}catch(e){if(missing(e)&&visited===1)return {path,exists:false,populated:false,processes:[]};throw new HostObservationRefusal();}
  const events=await io.text('/sys/fs/cgroup'+path+'/cgroup.events',4096,s);need(/^populated [01]$/m.test(events));const populated=/^populated 1$/m.test(events);
  const processes:ProcessIdentity[]=[];for(const id of ids){const p=await processIdentity(id,s);need(p);const cg=(await io.text('/proc/'+id+'/cgroup',4096,s)).trim();need(cg==='0::'+path||cg.startsWith('0::'+path+'/'));processes.push(p);}
  need(populated===Boolean(processes.length));return {path,exists:true,populated,processes};
 }
 async function readUnit(name:string,s:AbortSignal):Promise<Observation>{
  const d=allowed.find(v=>v.name===name);need(d);s.throwIfAborted();await boot(s);
  const raw=parseSystemShow(await io.show(name,[...scalar],s));
  if(raw.LoadState==='not-found'){need(raw.ActiveState==='inactive'&&raw.MainPID==='0'&&!raw.ControlGroup);return {kind:'missing'};}
  if(raw.LoadState!=='loaded')return {kind:'inconclusive'};
  need(['active','activating','deactivating','inactive','failed'].includes(raw.ActiveState)&&/^\d+$/.test(raw.MainPID)&&/^[a-f0-9]{32}$/.test(raw.InvocationID));
  const pid=Number(raw.MainPID);need(Number.isSafeInteger(pid)&&(pid===0||pid>1));const main=pid?await processIdentity(pid,s):null;need(!pid||main);
  let mainExecutableSha256:string|null=null,readOnlyCgroup=false;
  if(main){
   need((await io.link('/proc/'+pid+'/exe',s))===plan.artifacts.node.path);mainExecutableSha256=(await io.artifact(plan.artifacts.node.path,plan.artifacts.node.sha256,s)).sha256;
   const proof=await io.inside(name,main,s);need(proof.bootId===plan.bootId&&proof.pid===main.pid&&proof.uid===main.uid&&proof.startTime===main.startTime&&proof.controlGroup===d.controlGroup&&proof.readOnlyVerified===true&&proof.observedAt<=io.now()&&io.now()-proof.observedAt<=1000);
   // An outside mount listing alone is not an inside permission proof.
   const mounts=(await io.text('/proc/'+pid+'/mountinfo',65536,s)).split('\n').filter(v=>v.includes(' - cgroup2 '));need(mounts.length>0&&mounts.every(v=>v.split(' ')[5]?.split(',').includes('ro')));readOnlyCgroup=true;
   const again=await processIdentity(pid,s);need(JSON.stringify(again)===JSON.stringify(main)&&(await io.link('/proc/'+pid+'/exe',s))===plan.artifacts.node.path);
  }
  const props:Record<string,string>={};
  for(const key of Object.keys(d.properties))if(!['CPUQuota','RuntimeMaxSec','TimeoutStopSec'].includes(key)){need(raw[key]!==undefined);props[key]=key==='KillSignal'&&raw[key]==='15'?'SIGTERM':raw[key];}
  props.CPUQuota=String(seconds(raw.CPUQuotaPerSecUSec)*100)+'%';props.RuntimeMaxSec=String(seconds(raw.RuntimeMaxUSec));props.TimeoutStopSec=String(seconds(raw.TimeoutStopUSec));
  const read=async(field:string)=>{const v=(await io.text('/sys/fs/cgroup'+d.controlGroup+'/'+field,1024,s)).trim();need(/^\d+$/.test(v));const n=Number(v);need(Number.isSafeInteger(n)&&n>0);return n;};
  let effective:UnitSnapshot['effective']={cpuQuota:0,cpuPeriod:0,memoryMax:0,tasksMax:0,readOnlyCgroup};
  if(main){const cpu=(await io.text('/sys/fs/cgroup'+d.controlGroup+'/cpu.max',1024,s)).trim().split(/\s+/);need(cpu.length===2&&cpu.every(v=>/^\d+$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)>0));effective={cpuQuota:Number(cpu[0]),cpuPeriod:Number(cpu[1]),memoryMax:await read('memory.max'),tasksMax:await read('pids.max'),readOnlyCgroup};}
  const family=await io.families(name,s);need(family.allowList===true&&Array.isArray(family.families));
  const u:UnitSnapshot={identity:{manager:'system',bootId:plan.bootId,id:raw.Id,description:raw.Description,transient:(raw.Transient==='yes') as true,fragmentPath:raw.FragmentPath,invocationId:raw.InvocationID,user:raw.User,dynamicUser:(raw.DynamicUser==='yes') as true,execStart:argv(raw.ExecStart,d.execStart),controlGroup:raw.ControlGroup},state:raw.ActiveState as UnitSnapshot['state'],main,resolvedUid:main?.uid??0,mainExecutableSha256,execStartPre:argv(raw.ExecStartPre,d.execStartPre),properties:props,bindsTo:(raw.BindsTo??'').split(' ').filter(Boolean),after:(raw.After??'').split(' ').filter(Boolean),addressFamilies:family,effective};
  // Bracket kernel evidence with fresh exact manager identity; no invocation/PID
  // replacement is accepted midway through collection. Admission verifies the
  // complete expected identity/properties using the existing supervision code.
  const last=parseSystemShow(await io.show(name,[...scalar],s));need(scalar.every(k=>last[k]===raw[k]));
  s.throwIfAborted();return {kind:'present',unit:u};
 }
 return Object.freeze({manager:'system' as const,readUnit,readProcess:processIdentity,readContainment:containment,async readArtifacts(pins,signal){need(JSON.stringify(pins)===JSON.stringify(plan.artifacts));const values={} as Record<ArtifactRole,ArtifactObservation>;for(const role of artifactRoles)values[role]=await io.artifact(pins[role].path,pins[role].sha256,signal);return values;},async readIdentity(user,signal){need(allowed.some(d=>d.user===user));return io.identity(user,signal);}});
}
// Optional native read capability, inert until explicitly selected. It has no
// start/stop/reset/kill commands and cannot select a user manager or another unit.
export function pinnedSystemShow(plan:SystemPlan,pin:{path:'/usr/bin/systemctl';sha256:string},artifact:ReturnType<typeof immutableArtifactReader>,execute:(binary:string,args:readonly string[],signal:AbortSignal)=>Promise<string>){
 validateSystemPlan(plan);const binary={...pin};need(binary.path==='/usr/bin/systemctl'&&/^[a-f0-9]{64}$/.test(binary.sha256));const names=[systemUnitDefinition(plan).name,systemControllerDefinition(plan).name];
 return async(name:string,fields:readonly string[],signal:AbortSignal)=>{need(names.includes(name)&&JSON.stringify(fields)===JSON.stringify(scalar));await artifact(binary.path,binary.sha256,signal);const result=await execute(binary.path,['--system','show','--all','--no-pager','--property='+fields.join(','),'--',name],signal);await artifact(binary.path,binary.sha256,signal);need(Buffer.byteLength(result)<=65536);return result;};
}
export function executeReadOnlySystemShow(binary:string,args:readonly string[],signal:AbortSignal):Promise<string>{
 need(binary==='/usr/bin/systemctl'&&args.length===7&&args[0]==='--system'&&args[1]==='show'&&args[2]==='--all'&&args[3]==='--no-pager'&&args[4]==='--property='+scalar.join(',')&&args[5]==='--'&&/^health-wallet-stage-c-[a-f0-9]{24}(-controller)?\.service$/.test(args[6]));
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  execFile(binary,[...args],{signal,timeout:800,maxBuffer:65536,encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',SYSTEMD_PAGER:'cat',SYSTEMD_COLORS:'0',SYSTEMD_LOG_LEVEL:'err'}},(error,stdout)=>{if(error)reject(new HostObservationRefusal());else resolve(stdout);});
 });
}
export function linuxKernelReads(plan:SystemPlan):Pick<LinuxObservationIO,'text'|'directories'|'link'> {
 validateSystemPlan(plan);const groups=[systemUnitDefinition(plan).controlGroup,systemControllerDefinition(plan).controlGroup];
 const groupPath=(path:string)=>groups.some(g=>path==='/sys/fs/cgroup'+g||path.startsWith('/sys/fs/cgroup'+g+'/'))&&!path.split('/').some(p=>p==='..'||p==='.')&&!path.includes('//');
 const procPath=(path:string)=>/^\/proc\/[1-9][0-9]*\/(stat|status|cgroup|mountinfo)$/.test(path)||path==='/proc/sys/kernel/random/boot_id';
 return {async text(path,max,signal){
  need(Number.isSafeInteger(max)&&max>0&&max<=65536&&(procPath(path)||(groupPath(path)&&/\/(cgroup\.(procs|events)|cpu\.max|memory\.max|pids\.max)$/.test(path))));
  signal.throwIfAborted();const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const b=Buffer.alloc(max+1);let used=0;while(used<b.length){signal.throwIfAborted();const r=await h.read(b,used,b.length-used,null);if(!r.bytesRead)break;used+=r.bytesRead;}need(used<=max);signal.throwIfAborted();return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,used));}finally{await h.close();}
 },async directories(path,signal){need(groupPath(path));signal.throwIfAborted();const entries=await readdir(path,{withFileTypes:true});need(entries.length<=1024&&entries.every(v=>!v.isSymbolicLink()));signal.throwIfAborted();return entries.filter(v=>v.isDirectory()).map(v=>v.name);},async link(path,signal){need(/^\/proc\/[1-9][0-9]*\/exe$/.test(path));signal.throwIfAborted();const result=await readlink(path);signal.throwIfAborted();return result;}};
}

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,readlink,lstat,unlink} from 'node:fs/promises';
import {guard} from '../processing/background-config.js';
import {transientArguments,unitName,checkOwnership,type UnitPlan,type UnitStatus,type Supervisor} from './supervision.js';
import {validateInside,type InsideProtection} from './inside-protection.js';
import {readPrivate} from './private-files.js';
const exec=promisify(execFile);
export type Command=(binary:string,args:string[],timeout?:number)=>Promise<string>;
export const localCommand:Command=async(binary,args,timeout=10000)=>(await exec(binary,args,{timeout,maxBuffer:131072,env:{...process.env,SYSTEMD_PAGER:'cat',SYSTEMD_COLORS:'0'}})).stdout.trim();
const fields=['Id','Description','Transient','FragmentPath','Restart','Type','ExecStart','ExecStartPre','BindsTo','After','CPUQuotaPerSecUSec','MemoryMax','TasksMax','RuntimeMaxUSec','TimeoutStopUSec','KillMode','KillSignal','SendSIGKILL','NoNewPrivileges','ProtectControlGroups','PrivateUsers','PrivateMounts','ReadOnlyPaths','Delegate','UMask','ActiveState','MainPID','ControlGroup','LoadState'];
export function parseProperties(text:string){const p:Record<string,string>={};for(const line of text.split('\n')){const i=line.indexOf('=');guard(i>0);const key=line.slice(0,i);guard(fields.includes(key)&&p[key]===undefined);p[key]=line.slice(i+1);}return p;}
export function microseconds(value:string){guard(/^\d+(us|ms|s|min)$/.test(value));const m=/^(\d+)(us|ms|s|min)$/.exec(value)!;return Number(m[1])*({us:1,ms:1000,s:1000000,min:60000000}[m[2] as 's']);}
const argv=(s:string)=>{const m=/argv\[\]=([^;]+);/.exec(s);guard(m);return m[1].trim().split(/\s+/);};
async function exists(path:string){try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function pidsBelow(path:string,depth=0):Promise<number[]>{
 guard(depth<=8);if(!await exists(path))return [];const ids=(await readFile(path+'/cgroup.procs','utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
 for(const f of await readdir(path,{withFileTypes:true})){guard(!f.isSymbolicLink());if(f.isDirectory())ids.push(...await pidsBelow(path+'/'+f.name,depth+1));}guard(ids.length<=128);return [...new Set(ids)];
}
export function createSystemdSupervisor(plan:UnitPlan,verifyLaunch:()=>Promise<void>,saveInside:(r:InsideProtection)=>Promise<void>,command:Command=localCommand):Supervisor&{ownsHealth(port:number):Promise<void>}{
 const name=unitName(plan.run),group='/user.slice/user-'+plan.uid+'.slice/user@'+plan.uid+'.service/app.slice/'+name;
 let cached:UnitStatus|undefined;const born=new Map<number,string>();
 async function processIdentity(pid:number){try{return (await readFile('/proc/'+pid+'/stat','utf8')).split(') ').slice(1).join(') ').split(' ')[19];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
 async function inspect():Promise<UnitStatus>{
  const p=parseProperties(await command('systemctl',['--user','show',name,'--property='+fields.join(',')]));
  if(p.LoadState==='not-found'){
   guard(cached&&!await exists('/sys/fs/cgroup'+group));for(const [pid,start]of born)guard(await processIdentity(pid)!==start);
   return {...cached,active:false,mainPid:0,populated:false,pids:[]};
  }
  const active=p.ActiveState==='active'||p.ActiveState==='activating'||p.ActiveState==='deactivating';const mainPid=Number(p.MainPID),path='/sys/fs/cgroup'+group;
  guard(!p.ControlGroup||p.ControlGroup===group);
  const pids=await pidsBelow(path);for(const pid of pids){const id=await processIdentity(pid);if(id)born.set(pid,id);}
  let readOnlyCgroupMount=false;
  try{if(plan.insideReport&&await exists(plan.insideReport)){
   const inside=JSON.parse((await readPrivate(plan.insideReport)).toString()) as InsideProtection;
   validateInside(inside,group);await saveInside(inside);
   // Confirm the actual main process inherited the protected namespace setup.
   if(mainPid>1){const mounts=await readFile('/proc/'+mainPid+'/mountinfo','utf8');readOnlyCgroupMount=mounts.split('\n').some(v=>v.includes(' /sys/fs/cgroup ')&&v.split(' ')[5].split(',').includes('ro'));}
  }
  }catch{readOnlyCgroupMount=false;}
  if(p.PrivateUsers!=='yes'||p.PrivateMounts!=='yes'||p.ReadOnlyPaths!=='/sys/fs/cgroup')readOnlyCgroupMount=false;
  const read=async(file:string)=>Number((await readFile(path+'/'+file,'utf8')).trim());
  const [cpuQuota,cpuPeriod]=await exists(path)?(await readFile(path+'/cpu.max','utf8')).trim().split(' ').map(Number):[0,0];
  const s:UnitStatus={id:p.Id,description:p.Description,uid:plan.uid,transient:p.Transient==='yes',fragmentPath:p.FragmentPath,restart:p.Restart,type:p.Type,
   execStart:argv(p.ExecStart),bindsTo:p.BindsTo.split(' '),after:p.After.split(' '),cpuQuotaPerSecUSec:microseconds(p.CPUQuotaPerSecUSec),memoryMax:Number(p.MemoryMax),tasksMax:Number(p.TasksMax),
   runtimeMaxUSec:microseconds(p.RuntimeMaxUSec),timeoutStopUSec:microseconds(p.TimeoutStopUSec),killMode:p.KillMode,killSignal:p.KillSignal==='15'?'SIGTERM':p.KillSignal,
   sendSIGKILL:p.SendSIGKILL==='yes',noNewPrivileges:p.NoNewPrivileges==='yes',protectControlGroups:p.ProtectControlGroups==='yes',delegate:p.Delegate==='yes',umask:p.UMask,
   active,mainPid,controlGroup:group,populated:await exists(path)?(await readFile(path+'/cgroup.events','utf8')).includes('populated 1'):false,pids,
   effective:{cpuQuota,cpuPeriod,memoryMax:await exists(path)?await read('memory.max'):0,pidsMax:await exists(path)?await read('pids.max'):0,readOnlyCgroupMount}};
  checkOwnership(plan,s);
  // During cleanup, still return an exact-owned status even if protection failed.
  if(active&&mainPid>1){if(argv(p.ExecStartPre).join(' ')!==plan.node+' '+plan.workingDirectory+'/dist/stage-c/inside-entry.js '+plan.insideReport)s.effective.readOnlyCgroupMount=false;}
  cached=s;return s;
 }
 return {
  inspect,
  async start(_unit,signal){signal.throwIfAborted();await verifyLaunch();guard(plan.insideReport);
   if(await exists(plan.insideReport)){const r=JSON.parse((await readPrivate(plan.insideReport)).toString()) as InsideProtection;validateInside(r,group);await saveInside(r);await unlink(plan.insideReport);}
   // A pre-existing exact-name unit is never adopted, including a failed unit.
   const old=parseProperties(await command('systemctl',['--user','show',name,'--property=LoadState']));guard(old.LoadState==='not-found');
   await command('systemd-run',transientArguments(plan));signal.throwIfAborted();
  },
  async stop(){const s=await inspect();checkOwnership(plan,s);if(s.active||await exists('/sys/fs/cgroup'+group))await command('systemctl',['--user','stop',name],70000);},
  async ownsHealth(port){const s=await inspect();guard(s.active&&s.mainPid>1);const wanted='0100007F:'+port.toString(16).toUpperCase().padStart(4,'0');
   const sockets=new Set<string>();for(const fd of await readdir('/proc/'+s.mainPid+'/fd'))try{const link=await readlink('/proc/'+s.mainPid+'/fd/'+fd);const m=/^socket:\[(\d+)\]$/.exec(link);if(m)sockets.add(m[1]);}catch{}
   const entries=(await readFile('/proc/'+s.mainPid+'/net/tcp','utf8')).trim().split('\n').slice(1).map(v=>v.trim().split(/\s+/));guard(entries.some(v=>v[1]===wanted&&v[3]==='0A'&&sockets.has(v[9])));
  }
 };
}

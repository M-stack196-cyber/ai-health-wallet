import {guard} from '../processing/background-config.js';
export interface UnitPlan {insideReport?:string;run:string;uid:number;node:string;entry:string;workingDirectory:string;environmentFile:string;controllerUnit:string;}
const safePath=(p:string)=>/^\/[a-zA-Z0-9/_.-]+$/.test(p)&&!p.split('/').includes('..');
export function unitName(run:string){guard(/^stage-c-[a-f0-9]{24}$/.test(run));return 'health-wallet-'+run+'.service';}
export function renderUnit(p:UnitPlan):string {
 const unit=unitName(p.run);guard(Number.isSafeInteger(p.uid)&&p.uid>=0);
 for(const path of [p.node,p.entry,p.workingDirectory,p.environmentFile,...(p.insideReport?[p.insideReport]:[])])guard(safePath(path));
 guard(p.entry===p.workingDirectory+'/dist/processing/background-entry.js'&&p.controllerUnit==='health-wallet-'+p.run+'-controller.service');
 return `[Unit]\nDescription=AI Health Wallet ${p.run}\nBindsTo=${p.controllerUnit}\nAfter=${p.controllerUnit}\n\n[Service]\nType=exec\n${p.insideReport?`ExecStartPre=${p.node} ${p.workingDirectory}/dist/stage-c/inside-entry.js ${p.insideReport}\n`:''}ExecStart=${p.node} ${p.entry}\nWorkingDirectory=${p.workingDirectory}\nEnvironmentFile=${p.environmentFile}\nPrivateUsers=yes\nPrivateMounts=yes\nReadOnlyPaths=/sys/fs/cgroup\nRestart=no\nRuntimeMaxSec=600\nKillMode=mixed\nKillSignal=SIGTERM\nTimeoutStopSec=60\nSendSIGKILL=yes\nCPUQuota=200%\nMemoryMax=3221225472\nTasksMax=128\nNoNewPrivileges=yes\nProtectControlGroups=yes\nDelegate=no\nUMask=0077\nStandardOutput=null\nStandardError=null\nSyslogIdentifier=${unit}\n`;
}
// Properties are collected by a future systemd adapter; never inspect Environment
// or stream status/journal output, which could disclose protected launch values.
export interface UnitStatus {
 id:string;description:string;uid:number;transient:boolean;fragmentPath:string;restart:string;type:string;
 execStart:readonly string[];bindsTo:readonly string[];after:readonly string[];
 cpuQuotaPerSecUSec:number;memoryMax:number;tasksMax:number;runtimeMaxUSec:number;timeoutStopUSec:number;
 killMode:string;killSignal:string;sendSIGKILL:boolean;noNewPrivileges:boolean;protectControlGroups:boolean;delegate:boolean;umask:string;
 active:boolean;mainPid:number;controlGroup:string;populated:boolean;pids:readonly number[];
 effective:{cpuQuota:number;cpuPeriod:number;memoryMax:number;pidsMax:number;readOnlyCgroupMount:boolean};
}
export function checkUnit(p:UnitPlan,s:UnitStatus,running:boolean){
 renderUnit(p);const name=unitName(p.run);
 guard(s.id===name&&s.description==='AI Health Wallet '+p.run&&s.uid===p.uid&&s.transient&&s.fragmentPath==='/run/user/'+p.uid+'/systemd/transient/'+name);
 guard(s.type==='exec'&&s.restart==='no'&&s.execStart.length===2&&s.execStart[0]===p.node&&s.execStart[1]===p.entry);
 guard(s.bindsTo.includes(p.controllerUnit)&&s.after.includes(p.controllerUnit));
 guard(s.cpuQuotaPerSecUSec===2000000&&s.memoryMax===3221225472&&s.tasksMax===128&&s.runtimeMaxUSec===600000000&&s.timeoutStopUSec===60000000);
 guard(s.killMode==='mixed'&&s.killSignal==='SIGTERM'&&s.sendSIGKILL&&s.noNewPrivileges&&s.protectControlGroups&&!s.delegate&&s.umask==='0077');
 guard(s.controlGroup==='/user.slice/user-'+p.uid+'.slice/user@'+p.uid+'.service/app.slice/'+name);
 if(running){guard(s.active&&s.mainPid>1&&s.populated&&s.pids.includes(s.mainPid)&&s.pids.every(v=>Number.isInteger(v)&&v>1));
  guard(s.effective.cpuPeriod>0&&s.effective.cpuQuota===2*s.effective.cpuPeriod&&s.effective.memoryMax===3221225472&&s.effective.pidsMax===128&&s.effective.readOnlyCgroupMount);
 }else guard(!s.active&&s.mainPid===0&&!s.populated&&s.pids.length===0);
}
export interface Supervisor {inspect():Promise<UnitStatus>;start(unit:string,signal:AbortSignal):Promise<void>;stop():Promise<void>;}
export async function stopOwned(p:UnitPlan,supervisor:Supervisor){
 // Even on partial startup, ownership and limits must be proved before issuing stop.
 const before=await supervisor.inspect();checkOwnership(p,before);
 await supervisor.stop();checkUnit(p,await supervisor.inspect(),false);
}

// Exact argument vector for systemd-run; no shell, credentials or persistent unit.
export function transientArguments(p:UnitPlan):string[]{
 renderUnit(p);
 const properties=['Type=exec','Description=AI Health Wallet '+p.run,'BindsTo='+p.controllerUnit,'After='+p.controllerUnit,
 'PrivateUsers=yes','PrivateMounts=yes','ReadOnlyPaths=/sys/fs/cgroup',...(p.insideReport?['ExecStartPre='+p.node+' '+p.workingDirectory+'/dist/stage-c/inside-entry.js '+p.insideReport]:[]),'WorkingDirectory='+p.workingDirectory,'EnvironmentFile='+p.environmentFile,'Restart=no','RuntimeMaxSec=600','KillMode=mixed','KillSignal=SIGTERM',
 'TimeoutStopSec=60','SendSIGKILL=yes','CPUQuota=200%','MemoryMax=3221225472','TasksMax=128','NoNewPrivileges=yes','ProtectControlGroups=yes','Delegate=no','UMask=0077',
 'StandardOutput=null','StandardError=null'];
 return ['--user','--unit='+unitName(p.run),...properties.flatMap(v=>['--property',v]),'--',p.node,p.entry];
}

export function checkOwnership(p:UnitPlan,s:UnitStatus){
 const name=unitName(p.run);guard(s.id===name&&s.description==='AI Health Wallet '+p.run&&s.uid===p.uid&&s.transient
 &&s.fragmentPath==='/run/user/'+p.uid+'/systemd/transient/'+name&&s.execStart.length===2&&s.execStart[0]===p.node&&s.execStart[1]===p.entry
 &&s.controlGroup==='/user.slice/user-'+p.uid+'.slice/user@'+p.uid+'.service/app.slice/'+name);
}

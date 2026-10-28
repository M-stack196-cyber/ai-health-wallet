import {operationalFixture} from './operational-fixture.js';
import {systemUnitDefinition,systemControllerDefinition,type UnitSnapshot} from '../stage-c/system-supervision.js';
import type {LinuxObservationIO} from '../stage-c/linux-system-observer.js';
export function deliveryFixture(){
 const f=operationalFixture(),worker=systemUnitDefinition(f.plan),controller=systemControllerDefinition(f.plan),calls:string[]=[];
 const state={readOnly:true,proof:true,proofAge:0,pidReused:false,controllerGone:false,changedInvocation:false,changedProperties:false,extraPid:false,cpuMax:false,exeChanged:false,symlink:false};
 const source=(name:string)=>name===worker.name?f.units.worker:state.controllerGone?null:f.units.controller;
 const raw=(u:UnitSnapshot|null)=>{
  if(!u)return 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n';
  const props={...u.properties};delete props.CPUQuota;delete props.RuntimeMaxSec;delete props.TimeoutStopSec;
  return Object.entries({...props,Id:u.identity.id,Description:u.identity.description,Transient:u.identity.transient?'yes':'no',FragmentPath:u.identity.fragmentPath,InvocationID:state.changedInvocation?'f'.repeat(32):u.identity.invocationId,User:u.identity.user,DynamicUser:'yes',ExecStart:'{ path='+u.identity.execStart[0]+' ; argv[]='+u.identity.execStart.join(' ')+' ; ignore_errors=no ; }',ExecStartPre:'{ path='+u.execStartPre[0]+' ; argv[]='+u.execStartPre.join(' ')+' ; ignore_errors=no ; }',ActiveState:u.state,MainPID:String(u.main?.pid??0),ControlGroup:u.identity.controlGroup,LoadState:'loaded',BindsTo:u.bindsTo.join(' '),After:u.after.join(' '),CPUQuotaPerSecUSec:u.effective.cpuQuota===200000?'2s':'500ms',RuntimeMaxUSec:u.properties.RuntimeMaxSec+'s',TimeoutStopUSec:'60s',...(state.changedProperties?{ProtectControlGroups:'no'}:{})}).map(([k,v])=>k+'='+v).join('\n')+'\n';
 };
 const io:LinuxObservationIO={now:f.ports.wallNow,async show(name){calls.push('show');return raw(source(name));},async text(path){calls.push(path.split('/').at(-1)!);
  if(path==='/proc/sys/kernel/random/boot_id')return f.plan.bootId+'\n';
  const m=/^\/proc\/(\d+)\/(.*)$/.exec(path);
  if(m){const pid=Number(m[1]),u=pid===f.self.pid?f.units.worker:f.units.controller;if(!u?.main)throw Object.assign(Error('Synthetic absent'),{code:'ENOENT'});const p=u.main;
   if(m[2]==='stat'){const fields=Array(20).fill('0');fields[0]='S';fields[19]=state.pidReused?'999':p.startTime;return pid+' (synthetic (process)) '+fields.join(' ');}
   if(m[2]==='status')return 'Uid:\t'+Array(4).fill(p.uid).join('\t')+'\n';
   if(m[2]==='cgroup')return '0::'+u.identity.controlGroup+'\n';
   if(m[2]==='mountinfo')return '11 1 0:1 / /sys/fs/cgroup '+(state.readOnly?'ro':'rw')+',nosuid,nodev - cgroup2 cgroup rw\n';
  }
  const u=path.includes(worker.controlGroup)?f.units.worker:f.units.controller;if(!u)throw Object.assign(Error('Synthetic absent'),{code:'ENOENT'});
  if(path.endsWith('/cpu.max'))return state.cpuMax?'max 100000':u.effective.cpuQuota+' '+u.effective.cpuPeriod;
  if(path.endsWith('/memory.max'))return String(u.effective.memoryMax);
  if(path.endsWith('/pids.max'))return String(u.effective.tasksMax);
  if(path.endsWith('/cgroup.procs'))return u.main?String(u.main.pid)+(state.extraPid?'\n999':''):'';
  if(path.endsWith('/cgroup.events'))return 'populated '+(u.main?'1':'0');throw Error('Unexpected synthetic read');
 },async directories(){return state.symlink?['..']:[];},async link(){return state.exeChanged?'/tmp/untrusted-node':f.plan.artifacts.node.path;},async artifact(path,sha256){return {path,sha256,uid:0,mode:0o644,links:1,regular:true,symlink:false,safeAncestors:true,serviceWritable:false};},identity:f.ports.system.readIdentity,families:async name=>structuredClone(source(name)!.addressFamilies),inside:async(name,p)=>({bootId:p.bootId,pid:p.pid,startTime:p.startTime,uid:p.uid,controlGroup:name===worker.name?worker.controlGroup:controller.controlGroup,readOnlyVerified:state.proof as true,observedAt:f.ports.wallNow()-state.proofAge})};
 return {...f,f,io,calls,state,worker,controller,raw};
}

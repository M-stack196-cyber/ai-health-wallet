import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';
import {assertSystemIdentity,validateSystemPlan,systemUnitDefinition,artifactRoles,type SystemPlan,type SystemManagerPorts,type OwnedInvocation,type UnitDefinition,type TransientIdentity,type ProcessIdentity} from './system-supervision.js';
import type {ReadOnlySystemPorts} from '../processing/operational-authority.js';
import {credentialDeploymentIdentity} from './system-credentials.js';
import {canonical} from '../processing/operational-authority.js';
export interface BrokerBinding {version:1;protocol:'health-wallet-system-manager/v1';deploymentSha256:string;brokerArtifactSha256:string;}
export interface ControlRequest {nonce:string;binding:BrokerBinding;operation:'start-absent'|'stop-exact'|'reset-exact';definition?:UnitDefinition;identity?:TransientIdentity;process?:ProcessIdentity|null;}
export interface ControlReply {nonce:string;binding:BrokerBinding;operation:ControlRequest['operation'];invocationId:string;comparisonEnforced:true;}
export interface ExactControlBroker {request(request:ControlRequest,signal:AbortSignal):Promise<ControlReply>;lookup(request:{nonce:string;binding:BrokerBinding},signal:AbortSignal):Promise<ControlReply|null>;}
export class ControlTransportRefusal extends Error {constructor(){super('Exact system-manager control refused.');}}
function need(v:unknown):asserts v {if(!v)throw new ControlTransportRefusal();}
// No local stop/reset/start executor is provided. The independently deployed,
// access-controlled broker must serialize ownership comparison and control;
// systemctl show followed by stop has an unsafe replacement race. These ports
// must NOT be backed by that two-command sequence or an unverified socket peer.
export function systemManagerTransport(input:SystemPlan,observation:ReadOnlySystemPorts,binding:BrokerBinding,broker:ExactControlBroker):SystemManagerPorts {
 validateSystemPlan(input);const plan=structuredClone(input),pin=structuredClone(binding),definition=systemUnitDefinition(plan);
 need(observation.manager==='system'&&pin.version===1&&pin.protocol==='health-wallet-system-manager/v1'&&pin.deploymentSha256===credentialDeploymentIdentity(plan)&&/^[a-f0-9]{64}$/.test(pin.brokerArtifactSha256)&&typeof broker?.request==='function'&&typeof broker.lookup==='function');
 observation=Object.freeze({...observation});broker={request:broker.request.bind(broker),lookup:broker.lookup.bind(broker)};
 let busy=false,attempted=false,submitted=false;let startNonce:string|undefined,ownedToken:string|undefined;
 function validReply(reply:ControlReply,nonce:string,operation:ControlRequest['operation']){need(reply&&Object.keys(reply).sort().join(',')==='binding,comparisonEnforced,invocationId,nonce,operation'&&reply.nonce===nonce&&reply.operation===operation&&canonical(reply.binding)===canonical(pin)&&reply.comparisonEnforced===true&&/^[a-f0-9]{32}$/.test(reply.invocationId)&&!/^0+$/.test(reply.invocationId));}
 async function readUnit(name:string,signal:AbortSignal){
  signal.throwIfAborted();if(name===definition.name&&attempted&&!submitted)return {kind:'inconclusive' as const};if(name===definition.name&&submitted&&!ownedToken){
   need(startNonce);const cancel=new AbortController(),combined=AbortSignal.any([signal,cancel.signal]);let timer:ReturnType<typeof setTimeout>|undefined;let reply:ControlReply|null;try{reply=await Promise.race([broker.lookup({nonce:startNonce,binding:structuredClone(pin)},combined),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancel.abort();reject(new ControlTransportRefusal());},500);})]);}finally{if(timer)clearTimeout(timer);cancel.abort();}if(!reply)return {kind:'inconclusive' as const};validReply(reply,startNonce,'start-absent');ownedToken=reply.invocationId;
  }
  const result=await observation.readUnit(name,signal);if(name===definition.name&&ownedToken&&result.kind==='present')assertSystemIdentity(plan,result.unit.identity,'worker',ownedToken,true);return result;
 }
 async function artifacts(s:AbortSignal){const a=await observation.readArtifacts(plan.artifacts,s);for(const r of artifactRoles){const f=a[r],p=plan.artifacts[r];need(f&&f.path===p.path&&f.sha256===p.sha256&&f.uid===0&&f.links===1&&f.regular&&!f.symlink&&f.safeAncestors&&!f.serviceWritable&&(f.mode&0o022)===0);}}
 async function request(operation:ControlRequest['operation'],signal:AbortSignal,identity?:TransientIdentity,process?:ProcessIdentity|null){
  const nonce=randomBytes(16).toString('hex'),cancel=new AbortController(),combined=AbortSignal.any([signal,cancel.signal]);let timer:ReturnType<typeof setTimeout>|undefined;
  try{combined.throwIfAborted();if(operation==='start-absent'){startNonce=nonce;submitted=true;}const payload:ControlRequest={nonce,binding:structuredClone(pin),operation,...(identity?{identity:structuredClone(identity),process:process?{...process}:null}:{definition:structuredClone(definition)})};
   const reply=await Promise.race([broker.request(payload,combined),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancel.abort();reject(new ControlTransportRefusal());},2000);})]);
   validReply(reply,nonce,operation);if(operation==='start-absent')ownedToken=reply.invocationId;
   if(identity)need(reply.invocationId===identity.invocationId);combined.throwIfAborted();return reply;
  }catch{throw new ControlTransportRefusal();}finally{if(timer)clearTimeout(timer);cancel.abort();}
 }
 async function control(owned:OwnedInvocation,signal:AbortSignal,reset:boolean){
  need(!busy&&submitted&&ownedToken===owned.identity.invocationId);busy=true;
  try{await artifacts(signal);const r=await observation.readUnit(definition.name,signal);need(r.kind==='present');assertSystemIdentity(plan,owned.identity,'worker',owned.identity.invocationId);assertSystemIdentity(plan,r.unit.identity,'worker',owned.identity.invocationId,true);
   need(canonical({...r.unit.identity,controlGroup:definition.controlGroup})===canonical(owned.identity));
   if(reset){need(r.unit.state==='failed'&&r.unit.main===null);const c=await observation.readContainment(definition.controlGroup,signal);need(!c.populated&&c.processes.length===0);}
   await request(reset?'reset-exact':'stop-exact',signal,owned.identity,r.unit.main);
  }finally{busy=false;}
 }
 return {...observation,manager:'system',readUnit,async startTransient(d,signal){
  need(!busy&&!attempted&&canonical(d)===canonical(definition));busy=true;attempted=true;
  try{signal.throwIfAborted();await artifacts(signal);need((await observation.readUnit(definition.name,signal)).kind==='missing');need(await observation.readIdentity(definition.user,signal)===null);need(!(await observation.readContainment(definition.controlGroup,signal)).exists);const r=await request('start-absent',signal);return {invocationId:r.invocationId};}finally{busy=false;}
 },stopExact:(owned,s)=>control(owned,s,false),resetFailedExact:(owned,s)=>control(owned,s,true),now:()=>performance.now(),pause:async(ms,s)=>{need(Number.isSafeInteger(ms)&&ms>=0&&ms<=1000);await pause(ms,undefined,{signal:s});}};
}

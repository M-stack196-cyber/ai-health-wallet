import {canonical} from '../processing/operational-authority.js';
import {credentialDeploymentIdentity} from './system-credentials.js';
import {assertSystemIdentity,systemUnitDefinition,systemControllerDefinition,validateSystemPlan,type SystemPlan,type UnitSnapshot,type ProcessIdentity,type UnitDefinition} from './system-supervision.js';
import type {ControlRequest,ControlReply,BrokerBinding,ExactControlBroker} from './system-manager-transport.js';
import type {NonceJournal} from './durable-control-journal.js';
import {requireDelivery as need,exactKeys,tokenPattern,deliveryBound} from './delivery-guards.js';
// A native implementation must hold exclusive authority across comparison and
// mutation; show-then-systemctl-stop is NOT a conforming implementation. No
// executable, shell, PID kill, unit-name-only stop or default OS backend exists.
export interface ExclusiveManagerTransaction {
 read():Promise<UnitSnapshot|null>;identityAbsent():Promise<boolean>;cgroupEmpty():Promise<boolean>;
 start(definition:UnitDefinition):Promise<UnitSnapshot>;
 stop(expected:UnitSnapshot):Promise<void>;reset(expected:UnitSnapshot):Promise<void>;
}
export interface BrokerAuthority {
 caller:ProcessIdentity;
 verify(caller:ProcessIdentity,signal:AbortSignal):Promise<void>;
 artifacts(signal:AbortSignal):Promise<void>;
 controller(signal:AbortSignal):Promise<UnitSnapshot>;
 exclusive<T>(name:string,signal:AbortSignal,fn:(tx:ExclusiveManagerTransaction)=>Promise<T>):Promise<T>;
}
export function controlBrokerServer(input:SystemPlan,binding:BrokerBinding,journal:NonceJournal,authority:BrokerAuthority):ExactControlBroker {
 validateSystemPlan(input);const plan=structuredClone(input),pin=structuredClone(binding),definition=systemUnitDefinition(plan),caller={...authority.caller};let busy=false,poisoned=false;
 need(pin.version===1&&pin.protocol==='health-wallet-system-manager/v1'&&pin.deploymentSha256===credentialDeploymentIdentity(plan)&&/^[a-f0-9]{64}$/.test(pin.brokerArtifactSha256));
 async function authenticate(s:AbortSignal){need(!poisoned);await authority.verify(caller,s);await authority.artifacts(s);const c=await authority.controller(s);assertSystemIdentity(plan,c.identity,'controller',plan.controllerInvocationId);need(c.state==='active'&&c.main&&canonical(c.main)===canonical(caller)&&c.mainExecutableSha256===plan.artifacts.node.sha256&&canonical(c.properties)===canonical(systemControllerDefinition(plan).properties));}
 function validate(r:ControlRequest){need(r&&tokenPattern.test(r.nonce)&&canonical(r.binding)===canonical(pin));if(r.operation==='start-absent'){exactKeys(r,['nonce','binding','operation','definition']);need(canonical(r.definition)===canonical(definition));}else{need(r.operation==='stop-exact'||r.operation==='reset-exact');exactKeys(r,['nonce','binding','operation','identity','process']);need(r.identity);assertSystemIdentity(plan,r.identity,'worker',r.identity.invocationId,true);if(r.process)need(Number.isSafeInteger(r.process.pid)&&r.process.pid>1&&Number.isSafeInteger(r.process.uid)&&r.process.uid>0&&/^\d+$/.test(r.process.startTime)&&r.process.bootId===plan.bootId);}}
 return {async request(request,signal){need(!busy&&!poisoned);const r=structuredClone(request);validate(r);busy=true;let reserved=false,finished=false;
  try{return await deliveryBound(1500,signal,async s=>{await authenticate(s);await journal.reserve(r);reserved=true;const reply=await authority.exclusive(definition.name,s,async tx=>{
   s.throwIfAborted();await authenticate(s);const current=await tx.read();let invocationId:string;
   if(r.operation==='start-absent'){need(!current&&await tx.identityAbsent()&&await tx.cgroupEmpty());s.throwIfAborted();await authority.verify(caller,s);const u=await tx.start(definition);assertSystemIdentity(plan,u.identity,'worker',u.identity.invocationId);need(u.main&&u.main.uid===u.resolvedUid&&u.main.uid>0&&u.main.bootId===plan.bootId&&u.mainExecutableSha256===plan.artifacts.node.sha256&&canonical(u.properties)===canonical(definition.properties)&&canonical(u.execStartPre)===canonical(definition.execStartPre)&&canonical(u.addressFamilies)===canonical(definition.addressFamilies));invocationId=u.identity.invocationId;
   }else{need(current&&r.identity);assertSystemIdentity(plan,current.identity,'worker',r.identity.invocationId,true);need(canonical(current.identity)===canonical(r.identity)&&canonical(current.main)===canonical(r.process)&&canonical(current.properties)===canonical(definition.properties)&&canonical(current.execStartPre)===canonical(definition.execStartPre)&&canonical(current.addressFamilies)===canonical(definition.addressFamilies));
    if(current.main)need(current.mainExecutableSha256===plan.artifacts.node.sha256&&current.main.uid===current.resolvedUid);
    if(r.operation==='reset-exact')need(current.state==='failed'&&current.main===null&&await tx.cgroupEmpty());
    s.throwIfAborted();await authority.verify(caller,s);if(r.operation==='stop-exact')await tx.stop(current);else await tx.reset(current);invocationId=r.identity.invocationId;
   }
   return {nonce:r.nonce,binding:structuredClone(pin),operation:r.operation,invocationId,comparisonEnforced:true as const};
  });s.throwIfAborted();await journal.complete(r,reply);finished=true;return reply;});
  }catch{if(reserved&&!finished)poisoned=true;throw new Error('Trusted control refused.');}finally{busy=false;}},
 async lookup(request,signal){exactKeys(request,['nonce','binding']);need(tokenPattern.test(request.nonce)&&canonical(request.binding)===canonical(pin));return deliveryBound(400,signal,async s=>{await authority.verify(caller,s);return journal.lookup(request.nonce);});}};
}

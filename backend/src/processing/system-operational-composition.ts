import type {OperationalSelection,ReadOnlySystemPorts} from './operational-authority.js';
import {operationalConfigIdentity,validateOperational} from './operational-authority.js';
import {startOperational,OperationalError,type OperationalPorts} from './operational-runtime.js';
import {launchOperational} from './operational-entry.js';
import {createLinuxSystemObserver,type LinuxObservationIO} from '../stage-c/linux-system-observer.js';
import {createAwsRead} from '../integration/aws-preflight.js';
import {receiptHealth,type HealthSink} from './receipt-health.js';
import type {SystemCredentialBundle} from '../stage-c/system-credentials.js';

export interface SystemOperationalDelivery {
 selection:OperationalSelection;configurationSha256:string;
 // Explicit inside proof and identity/type callbacks remain mandatory. No new
 // ambient OS/provider/credential fallback is introduced by this composition.
 observation:LinuxObservationIO;
 runtime:Omit<OperationalPorts,'system'|'signal'|'health'|'awsRead'>;
 preflightExecute(credentials:SystemCredentialBundle,args:readonly string[],signal:AbortSignal):Promise<string>;
 health:HealthSink;
}
export function systemOperationalFactory(input:SystemOperationalDelivery){
 let selection:OperationalSelection;
 try{selection=structuredClone(input.selection);validateOperational(selection);if(selection.background.drainMs>30000)throw new Error();if(input.configurationSha256!==operationalConfigIdentity(selection))throw new Error();}catch{throw new OperationalError();}
 const configurationSha256=input.configurationSha256;
 const io={...input.observation},runtime={...input.runtime};const preflightExecute=input.preflightExecute,sink=input.health;
 if(typeof preflightExecute!=='function'||typeof sink?.publish!=='function')throw new OperationalError();
 const observer:ReadOnlySystemPorts=createLinuxSystemObserver(selection.credentials.binding.plan,io);
 return async(signal:AbortSignal)=>{
  // This is programmatic opt-in only; API/CLI defaults never select this factory.
  let failure:()=>void=()=>{};
  const health=receiptHealth({configurationSha256,workerInvocationId:selection.workerInvocationId,bootId:selection.credentials.binding.plan.bootId},sink,runtime.wallNow,()=>failure());
  const cancel=new AbortController();failure=()=>cancel.abort();
  const service=await startOperational(selection,{...runtime,system:observer,signal:AbortSignal.any([signal,cancel.signal]),health,credentialHeadroomMs:6000,
   awsRead:(credentials,preflightSignal)=>createAwsRead(async args=>{await credentials.assertUnchanged();preflightSignal.throwIfAborted();const value=await preflightExecute(credentials,args,preflightSignal);await credentials.assertUnchanged();preflightSignal.throwIfAborted();return value;})});
  return service;
 };
}
// launchOperational checks disabled mode BEFORE any delivery getter is evaluated.
// Enabled execution still needs every independently supplied capability above.
export async function launchSystemOperational(env:NodeJS.ProcessEnv,delivery:()=>SystemOperationalDelivery,signals?:Parameters<typeof launchOperational>[2]){
 return launchOperational(env,async signal=>systemOperationalFactory(delivery())(signal),signals);
}

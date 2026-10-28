import {nativeAuthority,nativeBrokerAuthority,type NativeAuthorityPolicy,type NativeRunner} from './native-authority.js';
import {controlBrokerServer} from './control-broker-server.js';
import {nativeCredentialBootstrap,type BootstrapPorts} from './native-credential-bootstrap.js';
import type {SystemPlan,ProcessIdentity} from './system-supervision.js';
import type {BrokerBinding,ControlRequest,ControlReply} from './system-manager-transport.js';
import type {ReadOnlySystemPorts} from '../processing/operational-authority.js';
import type {NonceJournal} from './durable-control-journal.js';
import type {CredentialLeaseBinding} from './credential-lifecycle.js';
import {requireDelivery as need,deliveryBound} from './delivery-guards.js';
export function composeNativeBroker(input:{enabled:false;plan:SystemPlan;policy:NativeAuthorityPolicy;runner:NativeRunner;observation:ReadOnlySystemPorts;caller:ProcessIdentity;binding:BrokerBinding;journal:NonceJournal;authorize(signal:AbortSignal):Promise<void>;now():number;issuerSha256:string;bootstrap:BootstrapPorts}){
 need(input.enabled===false);const native=nativeAuthority(input.plan,input.policy,input.runner,input.now),authority=nativeBrokerAuthority(input.plan,native,input.observation,input.caller,input.authorize),broker=controlBrokerServer(input.plan,input.binding,input.journal,authority),credentials=nativeCredentialBootstrap(input.plan,input.issuerSha256,input.bootstrap);let started:ControlReply|undefined;
 return {broker,native,credentials,async startAndDeliver(request:ControlRequest,binding:CredentialLeaseBinding|((reply:ControlReply,signal:AbortSignal)=>Promise<CredentialLeaseBinding>),gid:number|((reply:ControlReply,signal:AbortSignal)=>Promise<number>),signal:AbortSignal){need(!started&&request.operation==='start-absent');const reply=await broker.request(request,signal);started=reply;try{const {selected,selectedGid}=await deliveryBound(1000,signal,async s=>{const selected=typeof binding==='function'?await binding(reply,s):structuredClone(binding);need(reply.invocationId===selected.invocationId);const selectedGid=typeof gid==='function'?await gid(reply,s):gid;return {selected,selectedGid};});return await credentials.deliver(selected,selectedGid,signal);}catch{await credentials.revoke(new AbortController().signal).catch(()=>{});throw new Error('Native composition refused.');}}};
}

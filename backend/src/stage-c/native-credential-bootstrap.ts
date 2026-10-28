import {canonical} from '../processing/operational-authority.js';
import type {CredentialLeaseBinding,CredentialStageReceipt} from './credential-lifecycle.js';
import type {SystemPlan,ProcessIdentity} from './system-supervision.js';
import {systemUnitDefinition,assertSystemIdentity} from './system-supervision.js';
import {credentialDeploymentIdentity} from './system-credentials.js';
import type {NativeObservation,NativePeer} from './native-authority.js';
import {verifyNativePeer} from './native-authority.js';
import {requireDelivery as need,deliveryBound,exactKeys,hashPattern} from './delivery-guards.js';
export interface NativeCredentialRecord {version:1;kind:'health-wallet-native-credential-record';issuerSha256:string;gid:number;receipt:CredentialStageReceipt;}
export interface NativeIssuerPort {
 issue(binding:CredentialLeaseBinding,gid:number,signal:AbortSignal):Promise<NativeCredentialRecord>;
 validate(record:NativeCredentialRecord,signal:AbortSignal):Promise<void>;
 revoke(record:NativeCredentialRecord,signal:AbortSignal):Promise<void>;
 revokePending(binding:CredentialLeaseBinding,signal:AbortSignal):Promise<void>;
 cleanup(record:NativeCredentialRecord,signal:AbortSignal):Promise<void>;
}
export interface BootstrapPorts {
 observe(unit:string,signal:AbortSignal):Promise<NativeObservation|null>;
 process(pid:number,signal:AbortSignal):Promise<ProcessIdentity|null>;
 authorize(grantSha256:string,signal:AbortSignal):Promise<void>;
 // Returns kernel SO_PEERCRED from the authenticated accepted connection.
 peer(signal:AbortSignal):Promise<NativePeer>;
 handoff(record:NativeCredentialRecord,signal:AbortSignal):Promise<void>;
 issuer:NativeIssuerPort;now():number;
}
export function nativeCredentialBootstrap(plan:SystemPlan,issuerSha256:string,ports:BootstrapPorts){need(hashPattern.test(issuerSha256));const p=structuredClone(plan);let used=false;let record:NativeCredentialRecord|undefined;let revoked=false;
 const verify=async(binding:CredentialLeaseBinding,gid:number,signal:AbortSignal)=>{need(!revoked&&binding.run===p.run&&binding.service===systemUnitDefinition(p).name&&binding.deploymentSha256===credentialDeploymentIdentity(p)&&ports.now()<binding.expiresAt);const u=await ports.observe(binding.service,signal);need(u?.snapshot.main&&u.gid===gid&&canonical(u.snapshot.main)===canonical(binding.process));assertSystemIdentity(p,u.snapshot.identity,'worker',binding.invocationId);await verifyNativePeer(await ports.peer(signal),{process:binding.process,gid,unit:binding.service,invocationId:binding.invocationId,grantSha256:binding.grantSha256,expiresAt:binding.expiresAt},ports,signal);};
 const revoke=async(signal:AbortSignal)=>{revoked=true;if(record)await deliveryBound(500,signal,s=>ports.issuer.revoke(record!,s));};
 return {async deliver(binding:CredentialLeaseBinding,gid:number,signal:AbortSignal){need(!used&&!revoked);used=true;const b=structuredClone(binding);try{return await deliveryBound(1000,signal,async s=>{await verify(b,gid,s);const issuing=ports.issuer.issue(b,gid,s);issuing.then(late=>{if(revoked)void deliveryBound(500,new AbortController().signal,q=>ports.issuer.revoke(late,q)).catch(()=>{});},()=>{});record=structuredClone(await issuing);exactKeys(record,['version','kind','issuerSha256','gid','receipt']);need(record.version===1&&record.kind==='health-wallet-native-credential-record'&&record.issuerSha256===issuerSha256&&record.gid===gid&&canonical(record.receipt.binding)===canonical(b));exactKeys(record.receipt,['version','kind','id','generation','binding','files']);exactKeys(record.receipt.files,['aws','postgres','approval','authorization']);need(record.receipt.version===1&&record.receipt.kind==='health-wallet-credential-stage'&&/^[a-f0-9]{32}$/.test(record.receipt.id)&&Number.isSafeInteger(record.receipt.generation)&&record.receipt.generation>0&&Object.values(record.receipt.files).every(h=>hashPattern.test(h))&&record.receipt.files.authorization===b.grantSha256);await ports.issuer.validate(record,s);await verify(b,gid,s);await ports.handoff(record,s);await verify(b,gid,s);return structuredClone(record);});}catch{revoked=true;await deliveryBound(500,new AbortController().signal,q=>ports.issuer.revokePending(b,q)).catch(()=>{});await revoke(new AbortController().signal).catch(()=>{});throw new Error('Native credential bootstrap refused.');}},
 async validate(signal:AbortSignal){need(record&&!revoked);await verify(record.receipt.binding,record.gid,signal);await ports.issuer.validate(record,signal);},revoke,
 async cleanup(signal:AbortSignal){need(revoked&&record);await ports.issuer.cleanup(record,signal);}};
}

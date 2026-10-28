import {systemOperationalFactory,type SystemOperationalDelivery} from './system-operational-composition.js';
import {launchOperational} from './operational-entry.js';
import {verifyRuntimeGraph,type RuntimeGraph,type RuntimeInventory} from '../stage-c/runtime-artifact-graph.js';
import {validateNetworkDelivery,type NetworkDeliveryPolicy} from '../stage-c/network-delivery.js';
import {requireDelivery as need,deliveryBound} from '../stage-c/delivery-guards.js';
import {canonical} from './operational-authority.js';
import {credentialDeploymentIdentity} from '../stage-c/system-credentials.js';
import {systemUnitDefinition,artifactRoles} from '../stage-c/system-supervision.js';
import type {CredentialStageReceipt} from '../stage-c/credential-lifecycle.js';
export interface TrustedDeliveryChecks {
 version:1;kind:'health-wallet-trusted-delivery';graph:RuntimeGraph;graphSha256:string;inventory:RuntimeInventory;
 network:NetworkDeliveryPolicy;networkSha256:string;
 credential:CredentialStageReceipt;validateCredential(receipt:CredentialStageReceipt):Promise<void>;
 // This capability must authenticate the local broker and bind the deployment,
 // caller, current controller/worker and durable journal session. Not a flag.
 verifyBroker(signal:AbortSignal):Promise<void>;
 verifyRelay(signal:AbortSignal):Promise<void>;
}
export function trustedDeliveryFactory(delivery:SystemOperationalDelivery,input:TrustedDeliveryChecks){const d=structuredClone({graph:input.graph,graphSha256:input.graphSha256,network:input.network,networkSha256:input.networkSha256,credential:input.credential});need(input.version===1&&input.kind==='health-wallet-trusted-delivery');let attempted=false;
 return async(signal:AbortSignal)=>{need(!attempted);attempted=true;const binding=d.credential.binding,s=delivery.selection;need(binding.run===s.credentials.binding.plan.run&&binding.invocationId===s.workerInvocationId&&binding.process.uid===s.credentials.directory.ownerUid&&binding.configurationSha256===delivery.configurationSha256&&binding.expiresAt===Date.parse(s.credentialsExpireAt)&&d.graph.configurationSha256===delivery.configurationSha256);
 need(d.credential.version===1&&d.credential.kind==='health-wallet-credential-stage'&&Number.isSafeInteger(d.credential.generation)&&d.credential.generation>0&&/^[a-f0-9]{32}$/.test(d.credential.id));
 need(binding.deploymentSha256===credentialDeploymentIdentity(s.credentials.binding.plan)&&binding.grantSha256===s.authorizationPin.sha256&&binding.service===systemUnitDefinition(s.credentials.binding.plan).name&&canonical(binding.process)===canonical(delivery.runtime.self()));
 need(canonical(d.credential.files)===canonical({aws:s.credentials.pins.aws.sha256,postgres:s.credentials.pins.postgres.sha256,approval:s.credentials.pins.approval.sha256,authorization:s.authorizationPin.sha256}));
 for(const role of artifactRoles){const pin=s.credentials.binding.plan.artifacts[role];need(d.graph.artifacts.some(a=>a.path===pin.path&&a.sha256===pin.sha256));}
 const original=delivery.runtime.network.bind(delivery.runtime);const checks=async(sig:AbortSignal)=>deliveryBound(1500,sig,async bounded=>{await input.verifyBroker(bounded);await input.validateCredential(structuredClone(d.credential));validateNetworkDelivery(d.network,d.networkSha256);await input.verifyRelay(bounded);});
 await verifyRuntimeGraph(d.graph,d.graphSha256,input.inventory,signal);await checks(signal);
 const factory=systemOperationalFactory({...delivery,runtime:{...delivery.runtime,network:async sig=>{await checks(sig);return original(sig);}}});return factory(signal);};
}
// No getter or capability is evaluated when disabled; no native factory provided.
export function launchTrustedDelivery(env:NodeJS.ProcessEnv,select:()=>{delivery:SystemOperationalDelivery;checks:TrustedDeliveryChecks},signals?:Parameters<typeof launchOperational>[2]){return launchOperational(env,async signal=>{const {delivery,checks}=select();return trustedDeliveryFactory(delivery,checks)(signal);},signals);}

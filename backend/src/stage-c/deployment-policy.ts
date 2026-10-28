import {systemUnitDefinition,systemControllerDefinition,validateSystemPlan,artifactRoles,type SystemPlan} from './system-supervision.js';
import {target} from '../integration/guards.js';
import {canonical,digest} from '../processing/operational-authority.js';
export class DeploymentPolicyRefusal extends Error {constructor(){super('Offline deployment policy refused.');}}
function need(v:unknown):asserts v {if(!v)throw new DeploymentPolicyRefusal();}
export const deploymentBlockers=Object.freeze(['operations-approval','immutable-full-runtime-graph','dynamic-identity-credential-bootstrap','typed-system-manager-broker','enforced-pg-aws-network-delivery','actual-node-native-containment','actual-controller-loss-expiry-cleanup'] as const);
export interface ReleaseFile {path:string;sha256:string;bytes:number;role:'application'|'dependency'|'runtime'|'native';}
export const requiredHostArtifacts=Object.freeze(['/usr/bin/systemctl','/usr/bin/prlimit','/usr/bin/tesseract','/usr/bin/pdftoppm','/usr/share/tesseract-ocr/5/tessdata/eng.traineddata']);
export interface OfflineDeployment {
 version:1;kind:'health-wallet-inactive-deployment';enabled:false;system:SystemPlan;
 sourceTreeSha256:string;hostArtifacts:readonly ReleaseFile[];releaseGraph:readonly ReleaseFile[];releaseGraphSha256:string;
 credentialPolicy:{delivery:'systemd-protected-files';expiration:'new-run-only';maximumAdmissionMs:600000;maximumDrainMs:30000;minimumCredentialHeadroomMs:6000;fallback:false;};
 networkPolicy:{version:1;mechanism:'dedicated-namespace-scoped-relay';implemented:false;defaultDeny:true;directInternet:false;proxies:false;redirects:false;};
 healthPolicy:{transport:'private-file-receipt';maximumAgeMs:1500;commands:false;};
 rollbackPolicy:{stop:'exact-owned-invocation-only';dataDeletion:false;historicalRecovery:false;reEnable:false;};
 blockers:readonly string[];
}
export function offlineDeployment(plan:SystemPlan,sourceTreeSha256:string,releaseGraph:readonly ReleaseFile[],hostArtifacts:readonly ReleaseFile[]):OfflineDeployment{
 validateSystemPlan(plan);const graph=[...structuredClone(releaseGraph)].sort((a,b)=>a.path.localeCompare(b.path));
 const d:OfflineDeployment={version:1,kind:'health-wallet-inactive-deployment',enabled:false,system:structuredClone(plan),sourceTreeSha256,hostArtifacts:structuredClone(hostArtifacts),releaseGraph:graph,releaseGraphSha256:digest(graph),credentialPolicy:{delivery:'systemd-protected-files',expiration:'new-run-only',maximumAdmissionMs:600000,maximumDrainMs:30000,minimumCredentialHeadroomMs:6000,fallback:false},networkPolicy:{version:1,mechanism:'dedicated-namespace-scoped-relay',implemented:false,defaultDeny:true,directInternet:false,proxies:false,redirects:false},healthPolicy:{transport:'private-file-receipt',maximumAgeMs:1500,commands:false},rollbackPolicy:{stop:'exact-owned-invocation-only',dataDeletion:false,historicalRecovery:false,reEnable:false},blockers:[...deploymentBlockers]};validateOfflineDeployment(d);return d;
}
export function validateOfflineDeployment(d:OfflineDeployment){
 need(d&&Object.keys(d).sort().join(',')==='blockers,credentialPolicy,enabled,healthPolicy,hostArtifacts,kind,networkPolicy,releaseGraph,releaseGraphSha256,rollbackPolicy,sourceTreeSha256,system,version');
 need(d.version===1&&d.kind==='health-wallet-inactive-deployment'&&d.enabled===false);validateSystemPlan(d.system);
 need(/^[a-f0-9]{64}$/.test(d.sourceTreeSha256)&&Array.isArray(d.releaseGraph)&&d.releaseGraph.length>=6&&d.releaseGraph.length<=4096&&digest(d.releaseGraph)===d.releaseGraphSha256);
 need(Array.isArray(d.hostArtifacts)&&d.hostArtifacts.length===requiredHostArtifacts.length&&new Set(d.hostArtifacts.map(v=>v.path)).size===requiredHostArtifacts.length);
 for(const f of d.hostArtifacts)need(Object.keys(f).sort().join(',')==='bytes,path,role,sha256'&&requiredHostArtifacts.includes(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=134217728&&f.role==='native');
 const root=d.system.releaseDirectory+'/';const paths=new Set<string>();
 for(const f of d.releaseGraph){need(Object.keys(f).sort().join(',')==='bytes,path,role,sha256'&&f.path.startsWith(root)&&!f.path.split('/').some((part:string)=>part.startsWith('.env')||['.aws','.ssh','credentials'].includes(part))&&!/\.(pem|key)$/.test(f.path)&&/^\/[a-zA-Z0-9_./-]+$/.test(f.path)&&!f.path.split('/').some((v:string)=>v==='.'||v==='..')&&!f.path.includes('//')&&!paths.has(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=134217728&&['application','dependency','runtime','native'].includes(f.role));paths.add(f.path);}
 for(const r of artifactRoles){const pin=d.system.artifacts[r];need(d.releaseGraph.some(f=>f.path===pin.path&&f.sha256===pin.sha256));}
 need(canonical(d.credentialPolicy)===canonical({delivery:'systemd-protected-files',expiration:'new-run-only',maximumAdmissionMs:600000,maximumDrainMs:30000,minimumCredentialHeadroomMs:6000,fallback:false}));
 need(canonical(d.networkPolicy)===canonical({version:1,mechanism:'dedicated-namespace-scoped-relay',implemented:false,defaultDeny:true,directInternet:false,proxies:false,redirects:false}));
 need(canonical(d.healthPolicy)===canonical({transport:'private-file-receipt',maximumAgeMs:1500,commands:false})&&canonical(d.rollbackPolicy)===canonical({stop:'exact-owned-invocation-only',dataDeletion:false,historicalRecovery:false,reEnable:false}));
 need(canonical(d.blockers)===canonical(deploymentBlockers));return {offlinePolicyValid:true as const,activationAllowed:false as const,blockers:[...deploymentBlockers]};
}
export function renderInactiveDeployment(d:OfflineDeployment){
 validateOfflineDeployment(d);need(d.system.controllerArguments.every(v=>/^[-a-zA-Z0-9_./:=]+$/.test(v)));
 const render=(controller:boolean)=>{const u=controller?systemControllerDefinition(d.system):systemUnitDefinition(d.system);const properties={...u.properties};delete properties.BindsTo;delete properties.After;
  const unit=['# INACTIVE REVIEW TEMPLATE. Not installable/approved for activation.','[Unit]','Description='+u.description,'ConditionPathExists=/run/health-wallet-delivery/'+d.system.run+'/ACTIVATION_APPROVED',...(controller?[]:['BindsTo='+u.properties.BindsTo,'After='+u.properties.After]),'','[Service]','User='+u.user,...Object.entries(properties).map(([k,v])=>k+'='+v),
   // An empty unit-file assignment resets restrictions; it must never be used
   // as an encoding of the typed D-Bus deny-all family tuple.
   'RestrictAddressFamilies=@TYPED_DENY_ALL_DBUS_REQUIRED@','Environment=PROCESSING_SERVICE_ENABLED=false','Environment=PROCESSING_OPERATIONAL_ENABLED=false','Environment=SUMMARY_EXECUTOR_ENABLED=false','Environment=AWS_EC2_METADATA_DISABLED=true','ExecStartPre='+u.execStartPre.join(' '),'ExecStart='+u.execStart.join(' ')];
  if(!controller)for(const name of ['aws-profile.json','postgres-password.json','processing-approval.json','runtime-authorization.json'])unit.push('LoadCredential='+name+':/run/health-wallet-delivery/'+d.system.run+'/'+name);
  return unit.join('\n')+'\n';};
 return {workerTemplate:render(false),controllerTemplate:render(true),typedUnitDefinitions:{worker:systemUnitDefinition(d.system),controller:systemControllerDefinition(d.system)},policy:structuredClone(d)};
}
export type EgressRequest={kind:'postgres';host:string;port:number}|{kind:'aws';service:string;operation:string;account:string;region:string;bucket?:string;key?:string;};
const s3Reads=['get-bucket-location','get-public-access-block','get-bucket-policy-status','get-bucket-ownership-controls','get-bucket-encryption'];
// Testable broker authorization policy; this is NOT an installed firewall, TLS
// relay, DNS verifier or claim that an injected network proof is trustworthy.
export function allowOperationalEgress(r:EgressRequest,authorizedOriginal:(key:string)=>boolean):boolean {
 if(!r||typeof r!=='object')return false;
 if(r.kind==='postgres')return Object.keys(r).sort().join(',')==='host,kind,port'&&r.host==='127.0.0.1'&&r.port===5433;
 if(r.kind!=='aws'||Object.keys(r).some(k=>!['kind','service','operation','account','region','bucket','key'].includes(k))||r.account!==target.account||r.region!==target.region)return false;
 if(r.service==='sts')return r.operation==='get-caller-identity'&&r.bucket===undefined&&r.key===undefined;
 if(r.service==='s3control')return r.operation==='get-public-access-block'&&r.bucket===undefined&&r.key===undefined;
 if(r.service!=='s3api'||r.bucket!==target.bucket)return false;
 if(s3Reads.includes(r.operation))return r.key===undefined;
 return r.operation==='get-object'&&typeof r.key==='string'&&/^medical-documents\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(pdf|png|jpg|jpeg)$/.test(r.key)&&safeAuthorized(r.key);
 function safeAuthorized(key:string){try{return authorizedOriginal(key)===true;}catch{return false;}}
}

export async function verifyDeclaredArtifacts(d:OfflineDeployment,independentDescriptorSha256:string,read:(path:string,sha256:string,signal:AbortSignal)=>Promise<import('./system-supervision.js').ArtifactObservation>,signal:AbortSignal){
 validateOfflineDeployment(d);const {createHash}=await import('node:crypto');
 need(/^[a-f0-9]{64}$/.test(independentDescriptorSha256)&&createHash('sha256').update(canonical(d)+'\n').digest('hex')===independentDescriptorSha256);
 let count=0;
 for(const f of [...d.releaseGraph,...d.hostArtifacts]){signal.throwIfAborted();const v=await read(f.path,f.sha256,signal);need(v.path===f.path&&v.sha256===f.sha256&&v.uid===0&&v.links===1&&v.regular&&!v.symlink&&v.safeAncestors&&!v.serviceWritable&&(v.mode&0o022)===0);count++;}
 signal.throwIfAborted();return {declaredArtifactGraphVerified:true as const,artifacts:count,activationAllowed:false as const,fullRuntimeDependencyClosureVerified:false as const};
}

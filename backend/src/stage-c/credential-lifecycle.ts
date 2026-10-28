import {randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {canonical,digest} from '../processing/operational-authority.js';
import type {SystemCredentialBundle} from './system-credentials.js';
import type {ProcessIdentity} from './system-supervision.js';
import {requireDelivery as need,hashPattern,tokenPattern,exactKeys} from './delivery-guards.js';
export interface CredentialLeaseBinding {run:string;deploymentSha256:string;configurationSha256:string;grantSha256:string;invocationId:string;service:string;process:ProcessIdentity;expiresAt:number;}
export interface CredentialStageReceipt {version:1;kind:'health-wallet-credential-stage';id:string;generation:number;binding:CredentialLeaseBinding;files:Readonly<Record<string,string>>;}
export interface ProtectedCredentialStage {
 // A future privileged backend must derive the destination UID from binding,
 // never from caller arguments. Native caller-owned tests cannot attest chown.
 stage(id:string,binding:CredentialLeaseBinding,files:Readonly<Record<string,Uint8Array>>):Promise<void>;
 verify(receipt:CredentialStageReceipt):Promise<void>;
 remove(receipt:CredentialStageReceipt):Promise<void>;
}
export interface CredentialIssuer {issue(binding:CredentialLeaseBinding):Promise<{aws:Uint8Array;postgres:Uint8Array;approval:Uint8Array;authorization:Uint8Array}>;revoke(id:string):Promise<void>;}
export function credentialLifecycle(issuer:CredentialIssuer,stage:ProtectedCredentialStage,now:()=>number,authorize:(binding:CredentialLeaseBinding)=>Promise<void>){
 const leases=new Map<string,{receipt:CredentialStageReceipt;state:'active'|'revoked'|'expired'|'rotated';staged:boolean}>();let generation=0,busy=false;
 const known=(r:CredentialStageReceipt)=>{const l=leases.get(r.id);need(l&&canonical(l.receipt)===canonical(r));return l;};
 async function validate(r:CredentialStageReceipt){const l=known(r);need(l.state==='active'&&l.staged);if(now()>=r.binding.expiresAt){l.state='expired';await issuer.revoke(r.id);throw new Error('Credential authority refused.');}await authorize(structuredClone(r.binding));await stage.verify(structuredClone(r));need(l.state==='active'&&now()<r.binding.expiresAt);}
 async function issue(input:CredentialLeaseBinding){need(!busy);busy=true;let id:string|undefined;try{const b=structuredClone(input);exactKeys(b,['run','deploymentSha256','configurationSha256','grantSha256','invocationId','service','process','expiresAt']);need(/^stage-c-[a-f0-9]{24}$/.test(b.run)&&[b.deploymentSha256,b.configurationSha256,b.grantSha256].every(v=>hashPattern.test(v))&&tokenPattern.test(b.invocationId)&&b.service==='health-wallet-'+b.run+'.service'&&Number.isSafeInteger(b.process.uid)&&b.process.uid>0&&Number.isSafeInteger(b.process.pid)&&b.process.pid>1&&/^\d+$/.test(b.process.startTime)&&/^[a-f0-9-]{36}$/.test(b.process.bootId)&&Number.isSafeInteger(b.expiresAt)&&b.expiresAt>now()+6000&&b.expiresAt<=now()+600000);await authorize(b);id=randomBytes(16).toString('hex');const raw=await issuer.issue(b);exactKeys(raw,['aws','postgres','approval','authorization']);const files:Record<string,Uint8Array>={},pins:Record<string,string>={};
 for(const [key,v]of Object.entries(raw)){need(v instanceof Uint8Array&&v.length>0&&v.length<=16384);files[key]=Buffer.from(v);pins[key]=digestBytes(v);}
 const receipt:CredentialStageReceipt={version:1,kind:'health-wallet-credential-stage',id,generation:++generation,binding:b,files:pins};const l={receipt,state:'active' as const,staged:false};leases.set(id,l);
 try{await stage.stage(id,b,files);l.staged=true;await validate(receipt);}finally{for(const v of Object.values(files))v.fill(0);for(const v of Object.values(raw))v.fill(0);}return structuredClone(receipt);
 }catch{if(id){const l=leases.get(id);if(l){l.state='revoked';await issuer.revoke(id);}}throw new Error('Credential authority refused.');}finally{busy=false;}}
 async function revoke(r:CredentialStageReceipt){const l=known(r);l.state='revoked';await issuer.revoke(r.id);}
 async function cleanup(r:CredentialStageReceipt){const l=known(r);need(l.state!=='active'||now()>=r.binding.expiresAt);l.state=now()>=r.binding.expiresAt?'expired':l.state;await issuer.revoke(r.id);await stage.remove(structuredClone(r));l.staged=false;}
 const safe=async<T>(fn:()=>Promise<T>):Promise<T>=>{try{return await fn();}catch{throw new Error('Credential authority refused.');}};
 return {issue:(b:CredentialLeaseBinding)=>safe(()=>issue(b)),validate:(r:CredentialStageReceipt)=>safe(()=>validate(r)),revoke:(r:CredentialStageReceipt)=>safe(()=>revoke(r)),cleanup:(r:CredentialStageReceipt)=>safe(()=>cleanup(r)),expire:(r:CredentialStageReceipt)=>safe(async()=>{need(now()>=r.binding.expiresAt);await revoke(r);known(r).state='expired';await cleanup(r);}),rotate:(old:CredentialStageReceipt,b:CredentialLeaseBinding)=>safe(async()=>{await validate(old);need(canonical(old.binding)===canonical(b));await revoke(old);known(old).state='rotated';// Old process/file bundle is never hot-reloaded; a new package requires explicit revalidation.
 return issue(b);})};
}
import {createHash} from 'node:crypto';
const digestBytes=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export function leasedCredentialBundle(bundle:SystemCredentialBundle,validate:()=>Promise<void>):SystemCredentialBundle {
 const assertUnchanged=async()=>{await validate();await bundle.assertUnchanged();await validate();};
 const result:SystemCredentialBundle={mode:'system-files',assertUnchanged,async awsCredentials(){await assertUnchanged();const v=await bundle.awsCredentials();await validate();return v;},async databaseOptions(){await assertUnchanged();const v=await bundle.databaseOptions();await validate();return v;}};
 Object.defineProperties(result,{toJSON:{value:()=>({credential:'redacted'})},[inspect.custom]:{value:()=>'<redacted credential lease>'}});return Object.freeze(result);
}

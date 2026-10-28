import {inspect} from 'node:util';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {target} from '../integration/guards.js';
import {assertCanary,type Canary} from '../processing/background-config.js';
import {validateSystemPlan,systemUnitDefinition,artifactRoles,type SystemPlan} from './system-supervision.js';
import {pinnedCredentialFile,redactCredentialFailure,requireCredential,type CredentialFileSystem,type CredentialDirectory,type CredentialPin} from './credential-files.js';

// Deterministic identity of independently provided deployment pins, not a hash
// learned from credential files or an unverified manifest's claimed contents.
export function credentialDeploymentIdentity(plan:SystemPlan):string {
  validateSystemPlan(plan);
  return createHash('sha256').update(JSON.stringify({schema:'health-wallet-credential-deployment/v1',releaseDirectory:plan.releaseDirectory,
    artifacts:artifactRoles.map(role=>[role,plan.artifacts[role].path,plan.artifacts[role].sha256])})).digest('hex');
}
export interface CredentialBinding {plan:SystemPlan;canary:Canary;}
type FilePin=Pick<CredentialPin,'sha256'|'ownerUid'|'mode'>;
export interface SystemFileSelection {
  mode:'system-files';binding:CredentialBinding;directory:CredentialDirectory;
  pins:{aws:FilePin;postgres:FilePin;approval:FilePin};
}
export interface AwsFileIdentity {accessKeyId:string;secretAccessKey:string;sessionToken?:string;}
export interface FileDatabaseOptions {host:'127.0.0.1';port:5433;database:'ai_health_wallet';user:'health_wallet_app';password:string;}
export interface SystemCredentialBundle {
  readonly mode:'system-files';
  awsCredentials():Promise<AwsFileIdentity>;
  databaseOptions():Promise<FileDatabaseOptions>;
  assertUnchanged():Promise<void>;
}
// Restrict to a flat JSON envelope: reject duplicate keys (including escaped
// aliases), nested objects and unknown fields instead of last-key-wins parsing.
function flatJson(bytes:Uint8Array):Record<string,string|number> {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let at=0;
  const skip=()=>{while(/[ \t\r\n]/.test(text[at]??'!'))at++;};
  const quoted=/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const string=()=>{quoted.lastIndex=at;const m=quoted.exec(text);requireCredential(m);at=quoted.lastIndex;return JSON.parse(m[0]) as string;};
  const result:Record<string,string|number>=Object.create(null);skip();requireCredential(text[at++]==='{');skip();
  while(text[at]!=='}'){
    const key=string();requireCredential(!Object.hasOwn(result,key));skip();requireCredential(text[at++]===':');skip();
    if(text[at]==='"')result[key]=string();
    else {const n=/^(0|[1-9][0-9]*)/.exec(text.slice(at));requireCredential(n);at+=n[0].length;const value=Number(n[0]);requireCredential(Number.isSafeInteger(value));result[key]=value;}
    skip();if(text[at]==='}')break;requireCredential(text[at++ ]===',');skip();requireCredential(text[at]!=='}');
  }
  requireCredential(text[at++]==='}');skip();requireCredential(at===text.length);return result;
}
function keys(value:Record<string,unknown>,required:string[],optional:string[]=[]){
  requireCredential(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));
}
const common=['version','kind','run','deploymentSha256'];
function binding(v:Record<string,string|number>,b:CredentialBinding,kind:string,version=1){
  requireCredential(v.version===version&&v.kind===kind&&v.run===b.plan.run&&v.deploymentSha256===credentialDeploymentIdentity(b.plan));
}
function awsTarget(v:Record<string,string|number>){for(const key of ['profile','account','region','bucket','prefix'] as const)requireCredential(v[key]===target[key]);}
function scalar(value:unknown,min:number,max:number):value is string{return typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
// Values remain enumerable for normal SDK/pg option copying, but ordinary
// JSON/inspect views are redacted. Trusted consumers must also avoid logging
// clones/raw values; no JavaScript wrapper can prevent a consumer copying strings.
function secretView<T extends object>(value:T):T {
  Object.defineProperties(value,{toJSON:{value:()=>({credential:'redacted'})},[inspect.custom]:{value:()=>'<redacted credential options>'}});
  return Object.freeze(value);
}
export async function loadSystemFileCredentials(selection:SystemFileSelection,fs:CredentialFileSystem):Promise<SystemCredentialBundle> {
  return redactCredentialFailure(async()=>{
    requireCredential(selection?.mode==='system-files');
    const s=structuredClone(selection);validateSystemPlan(s.binding.plan);assertCanary(s.binding.canary);
    requireCredential(posix.basename(s.directory.path)===systemUnitDefinition(s.binding.plan).name);
    requireCredential(s.pins&&Object.keys(s.pins).sort().join(',')==='approval,aws,postgres');
    const files={
      aws:pinnedCredentialFile(s.directory,{...s.pins.aws,name:'aws-profile.json',maxBytes:16384},fs),
      postgres:pinnedCredentialFile(s.directory,{...s.pins.postgres,name:'postgres-password.json',maxBytes:8192},fs),
      approval:pinnedCredentialFile(s.directory,{...s.pins.approval,name:'processing-approval.json',maxBytes:4096},fs)
    };
    const readAll=async()=>({aws:await files.aws.read(),postgres:await files.postgres.read(),approval:await files.approval.read()});
    const bytes=await readAll(),a=flatJson(bytes.aws),p=flatJson(bytes.postgres),approval=flatJson(bytes.approval);
    keys(a,[...common,'profile','account','region','bucket','prefix','accessKeyId','secretAccessKey'],['sessionToken']);
    binding(a,s.binding,'health-wallet-aws-profile');awsTarget(a);
    requireCredential(typeof a.accessKeyId==='string'&&/^[A-Z0-9]{16,128}$/.test(a.accessKeyId));
    requireCredential(typeof a.secretAccessKey==='string'&&/^[A-Za-z0-9/+=]{32,128}$/.test(a.secretAccessKey));
    requireCredential(!Object.hasOwn(a,'sessionToken')||scalar(a.sessionToken,1,8192));
    keys(p,[...common,'host','port','database','user','password']);binding(p,s.binding,'health-wallet-postgres-password');
    requireCredential(p.host==='127.0.0.1'&&p.port===5433&&p.database==='ai_health_wallet'&&p.user==='health_wallet_app'&&scalar(p.password,16,4096));
    keys(approval,[...common,'mode','patientId','uploadCutoff','profile','account','region','bucket','prefix']);
    binding(approval,s.binding,'health-wallet-processing-approval',2);awsTarget(approval);
    requireCredential(approval.mode==='canary'&&approval.patientId===s.binding.canary.patientId&&approval.uploadCutoff===s.binding.canary.uploadCutoff);
    // Lock file identities across this bundle's lifetime and check again after
    // parsing all three envelopes, before any secret-bearing capability escapes.
    await readAll();let failed=false,tail:Promise<void>=Promise.resolve();
    const assertUnchanged=()=>{
      const work=tail.then(()=>redactCredentialFailure(async()=>{
        requireCredential(!failed);try{await readAll();}catch{failed=true;throw new Error();}
      }));tail=work.catch(()=>{});return work;
    };
    const bundle:SystemCredentialBundle={mode:'system-files',assertUnchanged,
      async awsCredentials(){await assertUnchanged();return secretView({accessKeyId:a.accessKeyId as string,secretAccessKey:a.secretAccessKey as string,
        ...(a.sessionToken!==undefined?{sessionToken:a.sessionToken as string}:{})});},
      async databaseOptions(){await assertUnchanged();return secretView({host:'127.0.0.1' as const,port:5433 as const,database:'ai_health_wallet' as const,user:'health_wallet_app' as const,password:p.password as string});}
    };
    return secretView(bundle);
  });
}
export interface DeveloperSelection {mode?:'developer';}
export function selectCredentialLoading<T>(selection:DeveloperSelection|undefined,ports:{developer():Promise<T>}):Promise<T>;
export function selectCredentialLoading(selection:SystemFileSelection,ports:{files:CredentialFileSystem;developer?:()=>Promise<unknown>}):Promise<SystemCredentialBundle>;
export async function selectCredentialLoading<T>(selection:DeveloperSelection|SystemFileSelection|undefined,ports:{developer?:()=>Promise<T>;files?:CredentialFileSystem}):Promise<T|SystemCredentialBundle> {
  // Only an absent selection or exact developer selection delegates. A malformed
  // system selection with a missing mode must never trigger developer fallback.
  if(selection===undefined||(selection&&Object.keys(selection).every(k=>k==='mode')&&(selection.mode===undefined||selection.mode==='developer'))){
    requireCredential(typeof ports.developer==='function');return ports.developer();
  }
  requireCredential(selection?.mode==='system-files'&&ports.files);
  return loadSystemFileCredentials(selection,ports.files);
}

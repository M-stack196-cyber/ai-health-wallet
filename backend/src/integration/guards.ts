import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {DocumentStorage,UploadObject} from '../documents/storage.js';
import type {OriginalStorage} from '../documents/original-reader.js';
export const target=Object.freeze({profile:'ai-health-wallet',account:'402909940531',bucket:'ai-health-wallet-records-402909940531',region:'ap-southeast-2',prefix:'medical-documents/',encryption:'AES256'});
export class VerificationFailure extends Error {
  constructor(readonly code:string){super('Controlled verification stopped.');}
}
export function insist(condition:unknown,code:string):asserts condition {if(!condition)throw new VerificationFailure(code);}
export interface Options {mode:'preflight'|'run';liveWrites:boolean;profile:string;account:string;bucket:string;region:string;}
export function parseFlags(args:string[]):Options {
  const values=new Map<string,string>();let mode:Options['mode']|undefined,liveWrites=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--preflight'||arg==='--run'){insist(!mode,'FLAGS');mode=arg==='--run'?'run':'preflight';}
    else if(arg==='--approve-live-writes'){insist(!liveWrites,'FLAGS');liveWrites=true;}
    else {insist(['--profile','--account','--bucket','--region'].includes(arg)&&!values.has(arg),'FLAGS');
      const value=args[++i];insist(value&&!value.startsWith('--'),'FLAGS');values.set(arg,value);}
  }
  insist(mode&&(mode==='run'?liveWrites:!liveWrites),'FLAGS');
  const result={mode,liveWrites,profile:values.get('--profile')!,account:values.get('--account')!,bucket:values.get('--bucket')!,region:values.get('--region')!};
  for(const key of ['profile','account','bucket','region'] as const)insist(result[key]===target[key],'TARGET');return result;
}
export function checkEnvironment(env:NodeJS.ProcessEnv){
  for(const [key,value]of Object.entries(env))if(value&&(key.startsWith('AWS_ENDPOINT_URL')||[
    'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_SECURITY_TOKEN','AWS_DEFAULT_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_ROLE_SESSION_NAME','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_AUTHORIZATION_TOKEN','AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_SHARED_CREDENTIALS_FILE','AWS_CONFIG_FILE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'
  ].includes(key)))throw new VerificationFailure('AMBIENT_CONFIGURATION');
  insist(env.AWS_PROFILE===target.profile&&env.AWS_REGION===target.region&&env.DOCUMENT_STORAGE_ENABLED==='true'
    &&env.S3_BUCKET===target.bucket&&env.S3_BUCKET_OWNER_ACCOUNT_ID===target.account
    &&(env.S3_DOCUMENT_PREFIX??target.prefix)===target.prefix&&(env.S3_ENCRYPTION??'AES256')==='AES256'&&!env.S3_KMS_KEY_ARN,'CONFIGURATION');
  insist(['127.0.0.1','localhost','::1'].includes(env.DB_HOST??'')&&env.DB_PORT==='5433'&&env.DB_NAME==='ai_health_wallet'&&env.DB_USER==='health_wallet_app','DATABASE_TARGET');
}
export interface Check {check:string;status:'passed'|'failed';reason?:string;}
export interface Preflight {readonly passed:boolean;readonly checks:readonly Check[];}
const verifiedPreflights=new WeakSet<Preflight>();
export function requireLive(options:Options,report:Preflight){
  insist(options.mode==='run'&&options.liveWrites&&verifiedPreflights.has(report)&&report.passed,'WRITES_DISABLED');
}
export type AwsRead=(service:string,operation:string,args:readonly string[])=>Promise<any>;
export async function preflight(read:AwsRead):Promise<Preflight>{
  const checks:Check[]=[];
  const check=async(name:string,operation:()=>Promise<boolean>)=>{let pass=false,reason='SECURITY_REQUIREMENT_NOT_MET';try{pass=await operation();}catch(error){
    reason=error instanceof VerificationFailure&&['AWS_ACCESS_DENIED','AWS_SECURITY_CONFIGURATION_MISSING','AWS_READ_FAILED','PROFILE_CHANGED'].includes(error.code)?error.code:'CHECK_FAILED';
  }
    checks.push({check:name,status:pass?'passed':'failed',...(!pass?{reason}:{})});return pass;};
  const identity=await check('identity',async()=>{
    const v=await read('sts','get-caller-identity',[]);
    return v.Account===target.account&&typeof v.Arn==='string'&&new RegExp(`^arn:aws:(iam|sts)::${target.account}:(user/|assumed-role/)`).test(v.Arn);
  });
  if(!identity)return Object.freeze({passed:false,checks:Object.freeze(checks)});
  const bucket=['--bucket',target.bucket,'--expected-bucket-owner',target.account];
  const flags=(v:any)=>v?.BlockPublicAcls===true&&v?.IgnorePublicAcls===true&&v?.BlockPublicPolicy===true&&v?.RestrictPublicBuckets===true;
  await check('bucket-region',async()=>(await read('s3api','get-bucket-location',bucket)).LocationConstraint===target.region);
  await check('bucket-public-access-block',async()=>flags((await read('s3api','get-public-access-block',bucket)).PublicAccessBlockConfiguration));
  await check('bucket-policy-status',async()=>{const v=await read('s3api','get-bucket-policy-status',bucket);return v.PolicyStatus?.IsPublic===false||v.noPolicy===true;});
  await check('bucket-owner-enforced',async()=>(await read('s3api','get-bucket-ownership-controls',bucket)).OwnershipControls?.Rules?.some((r:any)=>r.ObjectOwnership==='BucketOwnerEnforced')===true);
  await check('bucket-encryption',async()=>(await read('s3api','get-bucket-encryption',bucket)).ServerSideEncryptionConfiguration?.Rules?.some((r:any)=>r.ApplyServerSideEncryptionByDefault?.SSEAlgorithm==='AES256')===true);
  await check('account-public-access-block',async()=>flags((await read('s3control','get-public-access-block',['--account-id',target.account])).PublicAccessBlockConfiguration));
  const result=Object.freeze({passed:checks.every(c=>c.status==='passed'),checks:Object.freeze(checks.map(c=>Object.freeze(c)))});
  if(result.passed)verifiedPreflights.add(result);return result;
}
export type Scenario='A'|'B'|'C';
export interface RecordOfUpload {scenario:Scenario;key:string;sha256:string;bytes:number;mime:string;confirmed:boolean;versionId?:string;}
export interface ScenarioScope {scenario:Scenario;patientId:string;documentId:string;}
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export class RunRegistry {
  private patients=new Map<Scenario,string>();private scopes=new Map<Scenario,ScenarioScope>();
  register(scenario:Scenario,patientId:string){insist(['A','B','C'].includes(scenario)&&uuid(patientId)&&!this.patients.has(scenario)&&![...this.patients.values()].includes(patientId),'PATIENT_SCOPE');this.patients.set(scenario,patientId);}
  attach(scenario:Scenario,documentId:string):ScenarioScope {
    const patientId=this.patients.get(scenario);insist(patientId&&uuid(documentId)&&!this.scopes.has(scenario)&&![...this.scopes.values()].some(s=>s.documentId===documentId),'DOCUMENT_SCOPE');
    const scope=Object.freeze({scenario,patientId,documentId});this.scopes.set(scenario,scope);return scope;
  }
  assert(scope:ScenarioScope){insist(scope&&this.scopes.get(scope.scenario)===scope&&uuid(scope.patientId)&&uuid(scope.documentId),'UNSCOPED_WORKER');}
}
export type Snapshot=Record<string,{id:string|null;hash:string}[]>;
export function assertPreserved(before:Snapshot,after:Snapshot,allowed:Record<string,Set<string>>){
  insist(JSON.stringify(Object.keys(before).sort())===JSON.stringify(Object.keys(after).sort()),'PRESERVATION');
  for(const [table,original]of Object.entries(before)){
    const ids=allowed[table]??new Set<string>();insist(!original.some(r=>r.id&&ids.has(r.id)),'PRESERVATION_SCOPE');
    const remaining=after[table].filter(r=>!r.id||!ids.has(r.id));
    // A multiset comparison preserves bridge-table rows with composite primary keys too.
    insist(JSON.stringify(original.map(r=>r.hash).sort())===JSON.stringify(remaining.map(r=>r.hash).sort()),'PRESERVATION');
  }
}
export function createGuardedStorage(base:DocumentStorage&OriginalStorage,options:Options,uploads:RecordOfUpload[],save:()=>Promise<void>){
  insist(base.bucket===target.bucket&&base.prefix===target.prefix,'STORAGE_TARGET');
  let expected:{scenario:Scenario;sha256:string;mime:string;bytes:number}|undefined;
  const storage:DocumentStorage&OriginalStorage={bucket:base.bucket,prefix:base.prefix,
    async put(input:UploadObject){
      insist(options.mode==='run'&&options.liveWrites&&expected,'WRITES_DISABLED');
      const fixture=expected;expected=undefined;
      insist(input.bytes===fixture.bytes&&input.mime===fixture.mime&&input.bytes<=1048576,'FIXTURE');
      insist(new RegExp('^medical-documents/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(pdf|png)$').test(input.key)&&!uploads.some(u=>u.key===input.key||u.scenario===fixture.scenario),'OBJECT_SCOPE');
      const bytes=await readFile(input.path);insist(bytes.length===fixture.bytes&&createHash('sha256').update(bytes).digest('hex')===fixture.sha256&&createHash('sha256').update(bytes).digest('base64')===input.checksum,'FIXTURE_HASH');
      const record={...fixture,key:input.key,confirmed:false} as RecordOfUpload;uploads.push(record);await save(); // Journal before PUT, including ambiguous failures.
      const receipt=await base.put(input);record.confirmed=true;record.versionId=receipt.versionId;await save();return receipt;
    },
    async remove(){throw new VerificationFailure('DELETE_BLOCKED');},
    async download(){throw new VerificationFailure('SIGNED_URL_DISABLED');},
    async readOriginal(input){insist(uploads.some(u=>u.key===input.key&&u.confirmed),'OBJECT_SCOPE');return base.readOriginal(input);}
  };
  return {storage,expect(scenario:Scenario,bytes:Buffer,mime:string){insist(!expected&&!uploads.some(u=>u.scenario===scenario),'UPLOAD_ALREADY_ATTEMPTED');expected={scenario,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime};}};
}

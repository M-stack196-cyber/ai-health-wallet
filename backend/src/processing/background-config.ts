import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,parse,join} from 'node:path';

export class BackgroundSafetyError extends Error {constructor(){super('Processing service safety guard refused startup or admission.');}}
export function guard(value:unknown):asserts value {if(!value)throw new BackgroundSafetyError();}
export interface Canary {readonly patientId:string;readonly uploadCutoff:string;}
export function assertCanary(canary:Canary){
  guard(canary&&typeof canary.patientId==='string'&&typeof canary.uploadCutoff==='string');
  const {patientId,uploadCutoff}=canary;
  guard(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(patientId));
  guard(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(uploadCutoff)&&Number.isFinite(Date.parse(uploadCutoff))&&new Date(uploadCutoff).toISOString()===uploadCutoff);
}
export interface BackgroundConfig {
  enabled:true;concurrency:number;pollMs:number;backoffMaxMs:number;drainMs:number;healthPort:number;
  approvalPath:string;approvalSha256:string;canary:Readonly<Canary>;
}
export function backgroundConfig(env:NodeJS.ProcessEnv):BackgroundConfig|{enabled:false} {
  const enabled=env.PROCESSING_SERVICE_ENABLED??'false';guard(enabled==='true'||enabled==='false');
  if(enabled==='false')return {enabled:false};
  guard(env.PROCESSING_SERVICE_MODE==='canary');
  const patientId=env.PROCESSING_CANARY_PATIENT_ID??'',uploadCutoff=env.PROCESSING_UPLOAD_CUTOFF??'';
  assertCanary({patientId,uploadCutoff});
  const approvalPath=env.PROCESSING_APPROVAL_FILE??'',approvalSha256=env.PROCESSING_APPROVAL_SHA256??'';
  guard(isAbsolute(approvalPath)&&/^[a-f0-9]{64}$/.test(approvalSha256));
  const integer=(name:string,fallback:number,min:number,max:number)=>{
    const raw=env[name]??String(fallback),n=Number(raw);guard(/^\d+$/.test(raw)&&Number.isSafeInteger(n)&&n>=min&&n<=max);return n;
  };
  return Object.freeze({enabled:true,canary:Object.freeze({patientId,uploadCutoff}),approvalPath,approvalSha256,
    concurrency:integer('PROCESSING_SERVICE_CONCURRENCY',1,1,2),pollMs:integer('PROCESSING_SERVICE_POLL_MS',2000,1000,30000),
    backoffMaxMs:30000,drainMs:integer('PROCESSING_SERVICE_DRAIN_MS',30000,0,60000),healthPort:integer('PROCESSING_SERVICE_HEALTH_PORT',5001,1024,65535)});
}

// Approval is provisioned separately by an operator, never on startup. Pin the
// exact bytes in an independently controlled launch environment. No TOFU.
export async function verifyApproval(config:Pick<BackgroundConfig,'approvalPath'|'approvalSha256'|'canary'>):Promise<void> {
  assertCanary(config.canary);
  const path=config.approvalPath,uid=process.getuid?.();guard(uid!==undefined);
  let current=parse(path).root;
  for(const part of dirname(path).slice(current.length).split('/').filter(Boolean)){
    current=join(current,part);const s=await lstat(current);guard(s.isDirectory()&&!s.isSymbolicLink());
    // Sticky system temp is allowed for isolated fake tests; the immediate
    // private directory must still be owned and 0700.
    guard((s.mode&0o022)===0||((s.mode&0o1000)!==0&&s.uid===0));
  }
  const directory=await lstat(dirname(path));guard(directory.uid===uid&&(directory.mode&0o777)===0o700);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await file.stat();guard(before.isFile()&&before.uid===uid&&(before.mode&0o777)===0o600&&before.nlink===1&&before.size<=4096);
    const bytes=Buffer.alloc(4097);const {bytesRead}=await file.read(bytes,0,bytes.length,0);guard(bytesRead===before.size);
    const content=bytes.subarray(0,bytesRead),after=await file.stat();
    guard(after.size===before.size&&after.mtimeMs===before.mtimeMs&&createHash('sha256').update(content).digest('hex')===config.approvalSha256);
    const approval=JSON.parse(content.toString('utf8')) as Record<string,unknown>;
    guard(Object.keys(approval).sort().join(',')==='account,bucket,mode,patientId,profile,region,uploadCutoff,version');
    guard(approval.version===1&&approval.mode==='canary'&&approval.patientId===config.canary.patientId&&approval.uploadCutoff===config.canary.uploadCutoff
      &&approval.profile==='ai-health-wallet'&&approval.account==='402909940531'&&approval.bucket==='ai-health-wallet-records-402909940531'&&approval.region==='ap-southeast-2');
  }finally{await file.close();}
}

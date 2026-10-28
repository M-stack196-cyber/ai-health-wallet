import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {target,insist,VerificationFailure,type AwsRead} from './guards.js';
const exec=promisify(execFile),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Static named profile only. Reject delegation/credential_process/SSO rather than consulting another profile.
export function selectProfile(text:string,section:string,allowed:string[]):Record<string,string>{
  let active=false,found=false;const result:Record<string,string>={};
  for(const line of text.split(/\r?\n/)){
    const s=line.trim();if(!s||s.startsWith('#')||s.startsWith(';'))continue;
    if(s.startsWith('[')){insist(/^\[[^\]]+\]$/.test(s),'PROFILE_FORMAT');active=s===`[${section}]`;if(active){insist(!found,'PROFILE_FORMAT');found=true;}continue;}
    if(!active)continue;
    const match=/^([a-z_]+)\s*=\s*(\S.*?)\s*$/.exec(s);insist(match&&allowed.includes(match[1])&&!Object.hasOwn(result,match[1]),'PROFILE_CONFIGURATION');result[match[1]]=match[2];
  }
  insist(found,'PROFILE_MISSING');return result;
}
export async function loadPinnedProfile(){
  const configPath=join(homedir(),'.aws/config'),credentialsPath=join(homedir(),'.aws/credentials');
  const configBytes=await readFile(configPath),credentialBytes=await readFile(credentialsPath);
  const config=selectProfile(configBytes.toString('utf8'),'profile '+target.profile,['region','output']);
  const credentials=selectProfile(credentialBytes.toString('utf8'),target.profile,['aws_access_key_id','aws_secret_access_key','aws_session_token']);
  insist(config.region===target.region&&credentials.aws_access_key_id&&credentials.aws_secret_access_key,'PROFILE_CONFIGURATION');
  insist(((await stat(credentialsPath)).mode&0o077)===0,'PROFILE_PERMISSIONS');
  const unchanged=async()=>{insist(hash(await readFile(configPath))===hash(configBytes)&&hash(await readFile(credentialsPath))===hash(credentialBytes),'PROFILE_CHANGED');};
  const environment:NodeJS.ProcessEnv={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:homedir(),LANG:'C.UTF-8',AWS_PROFILE:target.profile,AWS_REGION:target.region,
    AWS_CONFIG_FILE:configPath,AWS_SHARED_CREDENTIALS_FILE:credentialsPath,AWS_EC2_METADATA_DISABLED:'true',AWS_MAX_ATTEMPTS:'1',AWS_CLI_AUTO_PROMPT:'off',AWS_PAGER:''};
  return {unchanged,environment,credentials:{accessKeyId:credentials.aws_access_key_id,secretAccessKey:credentials.aws_secret_access_key,
    ...(credentials.aws_session_token?{sessionToken:credentials.aws_session_token}:{})}};
}
export type Execute=(args:readonly string[])=>Promise<string>;
export function classifyAwsFailure(service:string,operation:string,stderr:string){
  const code=/An error occurred \(([A-Za-z0-9_]{1,64})\)/.exec(stderr)?.[1];
  if(service==='s3api'&&operation==='get-bucket-policy-status'&&code==='NoSuchBucketPolicy')return 'NO_POLICY';
  if(['AccessDenied','AccessDeniedException','UnauthorizedOperation','AllAccessDisabled'].includes(code??''))return 'AWS_ACCESS_DENIED';
  if(['NoSuchPublicAccessBlockConfiguration','OwnershipControlsNotFoundError','ServerSideEncryptionConfigurationNotFoundError'].includes(code??''))return 'AWS_SECURITY_CONFIGURATION_MISSING';
  return 'AWS_READ_FAILED';
}
export function createAwsRead(execute:Execute):AwsRead {
  return async(service,operation,args)=>{
    const bucket=['--bucket',target.bucket,'--expected-bucket-owner',target.account];
    const allowed=service==='sts'&&operation==='get-caller-identity'&&args.length===0
      ||service==='s3api'&&['get-bucket-location','get-public-access-block','get-bucket-policy-status','get-bucket-ownership-controls','get-bucket-encryption'].includes(operation)&&JSON.stringify(args)===JSON.stringify(bucket)
      ||service==='s3control'&&operation==='get-public-access-block'&&JSON.stringify(args)===JSON.stringify(['--account-id',target.account]);
    insist(allowed,'AWS_COMMAND_BLOCKED');
    try{return JSON.parse(await execute([service,operation,...args,'--profile',target.profile,'--region',target.region,'--output','json','--no-cli-pager','--cli-connect-timeout','3','--cli-read-timeout','10']));}
    catch(error){if(error instanceof VerificationFailure)throw error;throw new VerificationFailure('AWS_READ_FAILED');}
  };
}
export function awsReadFor(profile:Awaited<ReturnType<typeof loadPinnedProfile>>):AwsRead {
  return createAwsRead(async args=>{
    await profile.unchanged();
    try{
      const result=await exec('/usr/local/bin/aws',[...args],{env:profile.environment,timeout:20000,maxBuffer:1048576,encoding:'utf8',windowsHide:true});
      await profile.unchanged();return result.stdout;
    }catch(error){
      await profile.unchanged();
      // A bucket with no policy can be private. Never treat AccessDenied or malformed output as no policy.
      const code=classifyAwsFailure(args[0],args[1],error&&typeof error==='object'&&'stderr'in error&&typeof error.stderr==='string'?error.stderr:'');
      if(code==='NO_POLICY')return JSON.stringify({noPolicy:true});throw new VerificationFailure(code);
    }
  });
}

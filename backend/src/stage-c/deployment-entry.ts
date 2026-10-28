import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonical} from '../processing/operational-authority.js';
import {validateOfflineDeployment,type OfflineDeployment} from './deployment-policy.js';
// Explicit offline manifest validation only. No unit execution, credentials,
// network, driver, processor or environment configuration is loaded.
export async function checkDeployment(args:readonly string[]){
 if(args.length!==5||args[0]!=='--check'||args[1]!=='--manifest'||!args[2].startsWith('/')||args[3]!=='--sha256'||!/^[a-f0-9]{64}$/.test(args[4]))throw Error('Offline deployment validation refused.');
 const h=await open(args[2],constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const a=await h.stat({bigint:true});if(!a.isFile()||a.nlink!==1n||a.size<=0n||a.size>4194304n||(Number(a.mode)&0o022)!==0||(a.uid!==0n&&a.uid!==BigInt(process.getuid!())))throw Error();
  const bytes=Buffer.alloc(Number(a.size)+1),r=await h.read(bytes,0,bytes.length,0),b=await h.stat({bigint:true}),p=await lstat(args[2],{bigint:true});
  const same=(x:typeof a)=>x.isFile()&&[x.dev,x.ino,x.size,x.mtimeNs,x.ctimeNs,x.uid,x.mode,x.nlink].map(String).join(':')===[a.dev,a.ino,a.size,a.mtimeNs,a.ctimeNs,a.uid,a.mode,a.nlink].map(String).join(':');
  if(r.bytesRead!==Number(a.size)||!same(b)||!same(p)||createHash('sha256').update(bytes.subarray(0,r.bytesRead)).digest('hex')!==args[4])throw Error();
  const d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,r.bytesRead))) as OfflineDeployment;
  if(!bytes.subarray(0,r.bytesRead).equals(Buffer.from(canonical(d)+'\n')))throw Error();
  const result=validateOfflineDeployment(d);return {schema_version:1,...result,releaseFiles:d.releaseGraph.length,manifestSha256:args[4]};
 }catch{throw Error('Offline deployment validation refused.');}finally{await h.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void checkDeployment(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r)),()=>{console.log(JSON.stringify({offlinePolicyValid:false,activationAllowed:false,code:'DEPLOYMENT_REFUSED'}));process.exitCode=1;});

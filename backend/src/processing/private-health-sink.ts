import {constants} from 'node:fs';
import {open,lstat,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {privateParent} from '../stage-c/private-files.js';
import {verifyHealthReceipt,HealthReceiptRefusal,type HealthBinding,type HealthSink} from './receipt-health.js';
// Explicit fixed-path writer. No file is touched until publish(); no credential,
// service, socket or medical data access. Health is NOT authorization evidence.
export function privateHealthSink(directory:string,binding:HealthBinding,now:()=>number=Date.now):HealthSink {
 if(!/^\/[a-zA-Z0-9/_.-]+$/.test(directory)||directory.split('/').some(p=>p==='.'||p==='..')||directory.endsWith('/')||directory.includes('//'))throw new HealthReceiptRefusal();
 const path=directory+'/health.json',expected={...binding};let last:string|undefined,sequence=0,busy=false,failed=false;
 const identity=(s:any)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.nlink].map(String).join(':');
 const owned=(s:any)=>s.isFile()&&s.uid===BigInt(process.getuid!())&&(s.mode&0o7777n)===0o600n&&s.nlink===1n;
 return {async publish(receipt,signal){
  if(busy||failed)throw new HealthReceiptRefusal();busy=true;let dir:Awaited<ReturnType<typeof open>>|undefined,temp:string|undefined,tempIdentity:string|undefined;
  try{signal.throwIfAborted();verifyHealthReceipt(receipt,expected,now(),sequence);const bytes=Buffer.from(JSON.stringify(receipt)+'\n');if(bytes.length>4096)throw Error();
   await privateParent(path);dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const before=await dir.stat({bigint:true});if(!before.isDirectory()||before.uid!==BigInt(process.getuid!())||(before.mode&0o7777n)!==0o700n)throw Error();
   const base='/proc/self/fd/'+dir.fd,destination=base+'/health.json';
   const verifyCurrent=async()=>{try{const current=await lstat(destination,{bigint:true});if(!last||!owned(current)||identity(current)!==last)throw Error();}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'&&!last))throw error;}};
   await verifyCurrent();temp=base+'/.health-'+randomBytes(16).toString('hex')+'.tmp';const h=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await h.writeFile(bytes);await h.sync();const written=await h.stat({bigint:true});if(!owned(written))throw Error();tempIdentity=identity(written);}finally{await h.close();}
   signal.throwIfAborted();await verifyCurrent();const parent=await lstat(directory,{bigint:true});if(parent.dev!==before.dev||parent.ino!==before.ino||parent.mode!==before.mode||parent.uid!==before.uid)throw Error();
   if(identity(await lstat(temp,{bigint:true}))!==tempIdentity)throw Error();await rename(temp,destination);temp=undefined;
   const current=await lstat(destination,{bigint:true});if(!owned(current)||current.size!==BigInt(bytes.length))throw Error();last=identity(current);sequence=receipt.sequence;
  }catch{failed=true;throw new HealthReceiptRefusal();}finally{
   if(temp&&tempIdentity)try{if(identity(await lstat(temp,{bigint:true}))===tempIdentity)await unlink(temp);}catch{failed=true;}
   if(dir)try{await dir.close();}catch{failed=true;}
   busy=false;if(failed)throw new HealthReceiptRefusal();
  }
 }};
}

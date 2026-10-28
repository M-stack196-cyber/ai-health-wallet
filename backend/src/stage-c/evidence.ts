import {constants} from 'node:fs';
import {open,lstat,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,relative,dirname} from 'node:path';
import {guard} from '../processing/background-config.js';
const exec=promisify(execFile);
export type GitCheck=(root:string,path:string)=>Promise<void>;
export const checkIgnored:GitCheck=async(root,path)=>{
 const rel=relative(root,path);guard(rel.startsWith('.private-evidence/')&&!rel.includes('..'));
 await exec('git',['-C',root,'check-ignore','--no-index','--quiet','--',rel],{timeout:3000,maxBuffer:4096});
 const tracked=await exec('git',['-C',root,'ls-files','--',rel],{timeout:3000,maxBuffer:4096});guard(tracked.stdout==='');
};
const names=['manifest','receipts','verification','approval-pin','supervision','baseline','credentials'] as const;
type Name=typeof names[number];
async function privateDirectory(path:string){
 const uid=process.getuid?.();guard(uid!==undefined&&resolve(path)===path);
 let at=path;while(at!=='/'){
  const s=await lstat(at);guard(s.isDirectory()&&!s.isSymbolicLink());
  if(at===path)guard(s.uid===uid&&(s.mode&0o777)===0o700);
  else guard((s.mode&0o022)===0||(s.uid===0&&(s.mode&0o1000)!==0));at=dirname(at);
 }
}
// Existing private directory only. Missing receipts are fatal, never reconstructed.
export async function openJournal(root:string,directory:string,gitCheck:GitCheck=checkIgnored){
 await privateDirectory(directory);await gitCheck(root,directory+'/manifest.json');let queue=Promise.resolve();
 async function read(name:Name,sha256?:string){
  guard(names.includes(name));await privateDirectory(directory);await gitCheck(root,directory+'/'+name+'.json');
  const f=await open(directory+'/'+name+'.json',constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await f.stat();guard(s.isFile()&&s.uid===process.getuid?.()&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size<=1048576);
   const bytes=Buffer.alloc(s.size+1);const {bytesRead}=await f.read(bytes,0,bytes.length,0);const after=await f.stat();
   guard(bytesRead===s.size&&s.size===after.size&&s.mtimeMs===after.mtimeMs);const content=bytes.subarray(0,bytesRead);
   if(sha256)guard(createHash('sha256').update(content).digest('hex')===sha256);return JSON.parse(content.toString());
  }finally{await f.close();}
 }
 function save(name:Name,value:unknown){
  guard(names.includes(name));const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');guard(bytes.length<=1048576);
  // A failed journal stays failed; no subsequent mutation can skip lost intent.
  queue=queue.then(async()=>{
   await privateDirectory(directory);await gitCheck(root,directory+'/'+name+'.json');
   const path=directory+'/'+name+'.pending';const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
   await rename(path,directory+'/'+name+'.json');const d=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY);try{await d.sync();}finally{await d.close();}
  });return queue;
 }
 return {read,save,flush:()=>queue};
}
export function publicResult(phase:'checked'|'seeded'|'completed'|'stopped',passed:boolean){
 return {service:'stage-c-controller',phase,passed};
}

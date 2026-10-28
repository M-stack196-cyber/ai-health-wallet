import {constants} from 'node:fs';
import {open,lstat,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {guard} from '../processing/background-config.js';
export async function privateParent(path:string){
 guard(resolve(path)===path);const dir=dirname(path);let at=dir;
 while(at!=='/'){
  const s=await lstat(at);guard(s.isDirectory()&&!s.isSymbolicLink());
  if(at===dir)guard(s.uid===process.getuid!()&&(s.mode&0o777)===0o700);
  else guard((s.mode&0o022)===0||(s.uid===0&&(s.mode&0o1000)!==0));at=dirname(at);
 }
}
export async function readPrivate(path:string,maxBytes=1048576){
 await privateParent(path);const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const a=await f.stat();guard(a.isFile()&&a.uid===process.getuid!()&&(a.mode&0o777)===0o600&&a.nlink===1&&a.size<=maxBytes);
 const b=Buffer.alloc(a.size+1);const {bytesRead}=await f.read(b,0,b.length,0),z=await f.stat();guard(bytesRead===a.size&&a.size===z.size&&a.mtimeMs===z.mtimeMs);return b.subarray(0,bytesRead);
 }finally{await f.close();}
}
export async function createPrivate(path:string,bytes:Buffer|string){await privateParent(path);await writeFile(path,bytes,{mode:0o600,flag:'wx',flush:true});}

import {constants} from 'node:fs';
import {open,lstat,type FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {ArtifactObservation} from './system-supervision.js';

export class ArtifactRefusal extends Error {constructor(){super('Immutable artifact verification refused.');}}
export interface ArtifactStat {uid:number;mode:number;links:number;size:number;device:string;inode:string;mtime:string;ctime:string;kind:'file'|'directory'|'other';}
export interface ArtifactHandle {stat():Promise<ArtifactStat>;child(name:string,directory:boolean):Promise<ArtifactHandle>;read(offset:number,max:number):Promise<Uint8Array>;close():Promise<void>;}
export interface ArtifactFiles {root():Promise<ArtifactHandle>;lstat(path:string):Promise<ArtifactStat>;}
function requireSafe(v:unknown):asserts v {if(!v)throw new ArtifactRefusal();}
const same=(a:ArtifactStat,b:ArtifactStat)=>JSON.stringify(a)===JSON.stringify(b);
const stableDirectory=(a:ArtifactStat,b:ArtifactStat)=>a.kind===b.kind&&a.uid===b.uid&&a.mode===b.mode&&a.device===b.device&&a.inode===b.inode;
const safe=(s:ArtifactStat)=>s.uid===0&&Number.isSafeInteger(s.mode)&&(s.mode&0o022)===0&&/^[0-9]+$/.test(s.device)&&/^[0-9]+$/.test(s.inode);
// Factory construction is inert. Only explicit reads traverse/open files.
// Each independently pinned artifact must be root-owned, non-writable by the
// service, single-linked and reached through root-owned no-symlink ancestors.
export function immutableArtifactReader(files:ArtifactFiles){
 const cache=new Map<string,{identity:ArtifactStat;sha256:string}>();
 return async(path:string,pin:string,signal:AbortSignal):Promise<ArtifactObservation>=>{
  const handles:ArtifactHandle[]=[],ancestors:{path:string;stat:ArtifactStat}[]=[];
  let failed=false,result:ArtifactObservation|undefined;
  try{
   requireSafe(/^\/[a-zA-Z0-9/_.-]+$/.test(path)&&!path.endsWith('/')&&!path.split('/').some(x=>x==='.'||x==='..')&&!path.includes('//')&&/^[a-f0-9]{64}$/.test(pin));
   signal.throwIfAborted();let handle=await files.root();handles.push(handle);let at='/';
   const parts=path.slice(1).split('/');
   for(let i=0;i<parts.length;i++){
    const s=await handle.stat();requireSafe(s.kind==='directory'&&safe(s));ancestors.push({path:at,stat:s});
    handle=await handle.child(parts[i],i<parts.length-1);handles.push(handle);at=(at==='/'?'':at)+'/'+parts[i];signal.throwIfAborted();
   }
   const before=await handle.stat();requireSafe(before.kind==='file'&&safe(before)&&before.links===1&&Number.isSafeInteger(before.size)&&before.size>0&&before.size<=134217728);
   let sha256=cache.get(path)&&same(cache.get(path)!.identity,before)?cache.get(path)!.sha256:undefined;
   if(!sha256){const hash=createHash('sha256');let used=0;
    while(used<before.size){signal.throwIfAborted();const bytes=await handle.read(used,Math.min(65536,before.size-used));requireSafe(bytes.length>0&&bytes.length<=Math.min(65536,before.size-used));hash.update(bytes);used+=bytes.length;}
    requireSafe((await handle.read(used,1)).length===0);sha256=hash.digest('hex');
   }
   requireSafe(sha256===pin&&same(before,await handle.stat())&&same(before,await files.lstat(path)));
   for(let i=0;i<ancestors.length;i++)requireSafe(stableDirectory(ancestors[i].stat,await handles[i].stat())&&stableDirectory(ancestors[i].stat,await files.lstat(ancestors[i].path)));
   signal.throwIfAborted();requireSafe(cache.size<4096||cache.has(path));cache.set(path,{identity:{...before},sha256});
   result={path,sha256,uid:before.uid,mode:before.mode,links:1,regular:true,symlink:false,safeAncestors:true,serviceWritable:false};
  }catch{failed=true;}finally{for(const h of handles.reverse())try{await h.close();}catch{failed=true;}}
  if(failed||!result)throw new ArtifactRefusal();return result;
 };
}
// Linux fd-relative O_NOFOLLOW traversal, also used for each ancestor. No secret
// path, environment, profile, command or network capability is consulted.
export function linuxArtifactFiles():ArtifactFiles {
 requireSafe(process.platform==='linux'&&constants.O_NOFOLLOW>0&&constants.O_DIRECTORY>0);
 const identity=(s:any):ArtifactStat=>({uid:Number(s.uid),mode:Number(s.mode),links:Number(s.nlink),size:Number(s.size),device:String(s.dev),inode:String(s.ino),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),kind:s.isFile()?'file':s.isDirectory()?'directory':'other'});
 const wrap=(h:FileHandle):ArtifactHandle=>({stat:async()=>identity(await h.stat({bigint:true})),async child(name,directory){requireSafe(/^[a-zA-Z0-9_.-]+$/.test(name)&&name!=='.'&&name!=='..');return wrap(await open('/proc/self/fd/'+h.fd+'/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0)));},async read(offset,max){const b=Buffer.alloc(max);const r=await h.read(b,0,max,offset);return b.subarray(0,r.bytesRead);},close:()=>h.close()});
 return {root:async()=>wrap(await open('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)),lstat:async path=>identity(await lstat(path,{bigint:true}))};
}

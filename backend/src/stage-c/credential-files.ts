import {constants} from 'node:fs';
import {open,lstat,type FileHandle} from 'node:fs/promises';
import {posix} from 'node:path';
import {createHash} from 'node:crypto';

export class CredentialFileError extends Error {
  constructor(){super('Credential-file safety verification failed.');this.name='CredentialFileError';}
}
export function requireCredential(value:unknown):asserts value {if(!value)throw new CredentialFileError();}
export async function redactCredentialFailure<T>(work:()=>Promise<T>):Promise<T>{
  try{return await work();}catch{throw new CredentialFileError();}
}
export interface FileIdentity {
  kind:'file'|'directory'|'other';uid:number;mode:number;links:number;size:number;
  device:string;inode:string;mtimeNs:string;ctimeNs:string;
}
export interface CredentialHandle {
  stat():Promise<FileIdentity>;
  child(name:string,kind:'file'|'directory'):Promise<CredentialHandle>;
  read(maxBytes:number):Promise<Uint8Array>;
  close():Promise<void>;
}
export interface CredentialFileSystem {
  root():Promise<CredentialHandle>;
  lstat(path:string):Promise<FileIdentity>;
}
export interface CredentialDirectory {
  path:string;ownerUid:number;mode:0o500|0o700;
}
export interface CredentialPin {
  name:string;sha256:string;ownerUid:number;mode:0o400|0o600;maxBytes:number;
}
export interface PinnedCredentialFile {read():Promise<Uint8Array>;}
export const credentialSha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sameNode=(a:FileIdentity,b:FileIdentity)=>a.kind===b.kind&&a.uid===b.uid&&a.mode===b.mode&&a.device===b.device&&a.inode===b.inode&&(a.kind!=='file'||a.links===b.links);
const sameFile=(a:FileIdentity,b:FileIdentity)=>sameNode(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function owner(uid:number){requireCredential(Number.isSafeInteger(uid)&&uid>=0);}
function metadata(s:FileIdentity){
  owner(s.uid);requireCredential(Number.isSafeInteger(s.mode)&&s.mode>=0&&Number.isSafeInteger(s.links)&&s.links>0);
  requireCredential(/^\d+$/.test(s.device)&&/^\d+$/.test(s.inode)&&typeof s.mtimeNs==='string'&&/^[0-9]+$/.test(s.mtimeNs)&&typeof s.ctimeNs==='string'&&/^[0-9]+$/.test(s.ctimeNs));
}
// Explicit Linux fd-relative traversal pins every ancestor. Leaf NOFOLLOW alone
// would still follow a symlink substituted in an intermediate directory.
export function pinnedCredentialFile(directory:CredentialDirectory,pin:CredentialPin,fs:CredentialFileSystem):PinnedCredentialFile {
  const d={...directory},p={...pin};owner(d.ownerUid);owner(p.ownerUid);
  requireCredential(typeof d.path==='string'&&/^\/[A-Za-z0-9/_.-]+$/.test(d.path)&&posix.normalize(d.path)===d.path&&d.path!=='/'&&!d.path.endsWith('/')&&!d.path.includes('//'));
  requireCredential(d.mode===0o500||d.mode===0o700);
  requireCredential(/^[a-z][a-z0-9-]*\.json$/.test(p.name)&&/^[a-f0-9]{64}$/.test(p.sha256));
  requireCredential((p.mode===0o400||p.mode===0o600)&&Number.isSafeInteger(p.maxBytes)&&p.maxBytes>0&&p.maxBytes<=32768);
  let original:FileIdentity|undefined;
  return {read:()=>redactCredentialFailure(async()=>{
    const handles:CredentialHandle[]=[];const nodes:{path:string;identity:FileIdentity}[]=[];
    try{
      let at='/',handle=await fs.root();handles.push(handle);
      let s=await handle.stat();metadata(s);requireCredential(s.kind==='directory'&&s.uid===0&&(s.mode&0o022)===0);nodes.push({path:at,identity:s});
      for(const part of d.path.slice(1).split('/')){
        handle=await handle.child(part,'directory');handles.push(handle);at=posix.join(at,part);
        s=await handle.stat();metadata(s);requireCredential(s.kind==='directory');
        if(at===d.path)requireCredential(s.uid===d.ownerUid&&(s.mode&0o7777)===d.mode);
        else requireCredential((s.uid===0||s.uid===d.ownerUid)&&((s.mode&0o022)===0||(at==='/tmp'&&s.uid===0&&(s.mode&0o1777)===0o1777)));
        nodes.push({path:at,identity:s});
      }
      const file=await handle.child(p.name,'file');handles.push(file);
      const before=await file.stat();metadata(before);
      requireCredential(before.kind==='file'&&before.uid===p.ownerUid&&(before.mode&0o7777)===p.mode&&before.links===1);
      requireCredential(Number.isSafeInteger(before.size)&&before.size>0&&before.size<=p.maxBytes);
      if(original)requireCredential(sameFile(original,before));
      const bytes=await file.read(p.maxBytes+1),after=await file.stat();
      requireCredential(bytes.byteLength===before.size&&sameFile(before,after)&&credentialSha256(bytes)===p.sha256);
      // Recheck every pathname and open handle. Renames/replacements never silently
      // switch the trusted directory/file during traversal or subsequent reads.
      for(let i=0;i<nodes.length;i++)requireCredential(sameNode(nodes[i].identity,await handles[i].stat())&&sameNode(nodes[i].identity,await fs.lstat(nodes[i].path)));
      requireCredential(sameFile(before,await fs.lstat(posix.join(d.path,p.name))));
      original??={...before};return Uint8Array.from(bytes);
    }finally{
      let failed=false;for(const h of handles.reverse())try{await h.close();}catch{failed=true;}
      if(failed)throw new CredentialFileError();
    }
  })};
}

// Construction does not open anything. Tests call this only for freshly created
// synthetic files. The application does not select or instantiate this adapter.
export function nodeCredentialFileSystem():CredentialFileSystem {
  requireCredential(process.platform==='linux'&&constants.O_NOFOLLOW>0&&constants.O_DIRECTORY>0&&constants.O_NONBLOCK>0);
  const identity=(s:Awaited<ReturnType<FileHandle['stat']>>):FileIdentity=>{
    // BigInt stat is normalized below; this overload type is only structural.
    const v=s as unknown as {isFile():boolean;isDirectory():boolean;uid:bigint;mode:bigint;nlink:bigint;size:bigint;dev:bigint;ino:bigint;mtimeNs:bigint;ctimeNs:bigint};
    return {kind:v.isFile()?'file':v.isDirectory()?'directory':'other',uid:Number(v.uid),mode:Number(v.mode),links:Number(v.nlink),size:Number(v.size),device:String(v.dev),inode:String(v.ino),mtimeNs:String(v.mtimeNs),ctimeNs:String(v.ctimeNs)};
  };
  const wrap=(h:FileHandle):CredentialHandle=>({
    stat:async()=>identity(await h.stat({bigint:true})),
    child:async(name,kind)=>{
      requireCredential(/^[A-Za-z0-9_.-]+$/.test(name)&&name!=='.'&&name!=='..');
      return wrap(await open('/proc/self/fd/'+h.fd+'/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(kind==='directory'?constants.O_DIRECTORY:0)));
    },
    read:async limit=>{
      requireCredential(Number.isSafeInteger(limit)&&limit>0&&limit<=32769);
      const buffer=Buffer.alloc(limit);let used=0;
      while(used<limit){const {bytesRead}=await h.read(buffer,used,limit-used,used);if(!bytesRead)break;used+=bytesRead;}
      return buffer.subarray(0,used);
    },close:()=>h.close()
  });
  return {root:async()=>wrap(await open('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)),lstat:async path=>identity(await lstat(path,{bigint:true}))};
}

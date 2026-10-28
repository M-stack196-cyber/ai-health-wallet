import {constants} from 'node:fs';
import {access,open,readFile,readlink,statfs} from 'node:fs/promises';
import {guard} from '../processing/background-config.js';
export interface InterfaceCheck {path:string;readOnly:boolean;writable:boolean;openDenied:boolean;}
export interface InsideProtection {version:1;pid:number;uid:number;cgroup:string;mountNamespace:string;userNamespace:string;interfaces:InterfaceCheck[];protected:boolean;}
// O_WRONLY without O_CREAT/O_TRUNC and without write() is a permission-only
// probe. No cgroup migration, limit change, mkdir, unlink or control write occurs.
export async function inspectInside():Promise<InsideProtection>{
 const line=(await readFile('/proc/self/cgroup','utf8')).trim();guard(/^0::\/[a-zA-Z0-9_@./:-]+$/.test(line));
 const cgroup=line.slice(3);guard(!cgroup.split('/').includes('..'));
 const parent=cgroup.slice(0,cgroup.lastIndexOf('/'))||'/';
 const paths=[cgroup+'/cgroup.procs',cgroup+'/cgroup.threads',cgroup+'/cpu.max',cgroup+'/memory.max',cgroup+'/pids.max',parent+'/cgroup.procs','/cgroup.procs'];
 const mounts=(await readFile('/proc/self/mountinfo','utf8')).trim().split('\n').map(v=>v.split(' '));
 const interfaces:InterfaceCheck[]=[];
 for(const path of [...new Set(paths)]){
  const file='/sys/fs/cgroup'+path;const fs=await statfs(file,{bigint:true});guard(fs.type===0x63677270n);
  const mount=mounts.filter(v=>file===v[4]||file.startsWith(v[4]+'/')).sort((a,b)=>b[4].length-a[4].length)[0];guard(mount);let writable=false,openDenied=false;
  try{await access(file,constants.W_OK);writable=true;}catch(e){guard(['EACCES','EPERM','EROFS'].includes((e as NodeJS.ErrnoException).code??''));}
  try{const f=await open(file,constants.O_WRONLY|constants.O_NOFOLLOW);await f.close();}catch(e){guard(['EACCES','EPERM','EROFS'].includes((e as NodeJS.ErrnoException).code??''));openDenied=true;}
  interfaces.push({path,readOnly:mount[5].split(',').includes('ro'),writable,openDenied});
 }
 return {version:1,pid:process.pid,uid:process.getuid!(),cgroup,mountNamespace:await readlink('/proc/self/ns/mnt'),userNamespace:await readlink('/proc/self/ns/user'),interfaces,
 protected:interfaces.length>=6&&interfaces.every(v=>v.readOnly&&!v.writable&&v.openDenied)};
}
export function validateInside(r:InsideProtection,expectedGroup:string){
 const parent=expectedGroup.slice(0,expectedGroup.lastIndexOf('/'))||'/';
 const expected=[expectedGroup+'/cgroup.procs',expectedGroup+'/cgroup.threads',expectedGroup+'/cpu.max',expectedGroup+'/memory.max',expectedGroup+'/pids.max',parent+'/cgroup.procs','/cgroup.procs'];
 guard(new Set(r.interfaces.map(v=>v.path)).size===expected.length&&expected.every(path=>r.interfaces.some(v=>v.path===path)));
 guard(r.version===1&&r.uid===process.getuid!()&&r.protected&&r.cgroup===expectedGroup&&r.pid>1&&r.interfaces.length>=6&&r.interfaces.every(v=>v.readOnly&&!v.writable&&v.openDenied));
}

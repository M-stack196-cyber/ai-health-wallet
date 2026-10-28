import {assertPrivateDirectory,openPrivateDirectory} from './protected-stage.js';
import {constants} from 'node:fs';
import {open,lstat,readdir,unlink,link} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {canonical,digest} from '../processing/operational-authority.js';
import {requireDelivery as need,parseCanonical,canonicalBytes,exactKeys,tokenPattern} from './delivery-guards.js';
import type {ControlReply,ControlRequest,BrokerBinding} from './system-manager-transport.js';
export interface NonceJournal {reserve(request:ControlRequest):Promise<void>;complete(request:ControlRequest,reply:ControlReply):Promise<void>;lookup(nonce:string):Promise<ControlReply|null>;}
export interface JournalSession {version:1;binding:BrokerBinding;expiresAt:number;maximumEntries:number;}
// Dedicated owner-private, non-shared directory is an explicit trust boundary.
// Atomic link publishes a fully fsync'd inode without replacing an existing nonce.
// Reservation survives crashes, even when action outcome cannot be recovered.
export async function openControlJournal(directory:string,session:JournalSession,now:()=>number):Promise<NonceJournal & {expireCleanup():Promise<number>;close():Promise<void>}> {
 need(/^\/[a-zA-Z0-9_./-]+$/.test(directory)&&!directory.split('/').some(p=>p==='.'||p==='..')&&!directory.includes('//'));
 need(session.version===1&&Number.isSafeInteger(session.expiresAt)&&Number.isSafeInteger(session.maximumEntries)&&session.maximumEntries>=1&&session.maximumEntries<=1024);
 await assertPrivateDirectory(directory);const selected=structuredClone(session);const h=await openPrivateDirectory(directory);const fd='/proc/self/fd/'+h.fd;let closed=false;
 const original=await h.stat();need(original.isDirectory()&&original.uid===process.getuid?.()&&(original.mode&0o777)===0o700);
 const check=async()=>{need(!closed);const a=await h.stat(),b=await lstat(directory);need(a.dev===b.dev&&a.ino===b.ino&&a.uid===original.uid&&(a.mode&0o777)===0o700&&!b.isSymbolicLink());};
 const active=()=>need(Number.isFinite(now())&&now()<selected.expiresAt);
 const read=async(name:string)=>{await check();const f=await open(fd+'/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const a=await f.stat();need(a.isFile()&&a.nlink===1&&a.uid===original.uid&&(a.mode&0o777)===0o600&&a.size>0&&a.size<=65536);const b=await f.readFile();const z=await f.stat(),path=await lstat(fd+'/'+name);need(z.ino===path.ino&&a.ctimeMs===z.ctimeMs&&a.size===b.length);return parseCanonical(b);}finally{await f.close();}};
 const publish=async(name:string,value:unknown)=>{await check();const tmp='.new-'+randomBytes(16).toString('hex'),f=await open(fd+'/'+tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let linked=false;try{await f.writeFile(canonicalBytes(value));await f.sync();await link(fd+'/'+tmp,fd+'/'+name);linked=true;}finally{await f.close();await unlink(fd+'/'+tmp);}if(linked)await h.sync();};
 try{
  try{await publish('session.json',selected);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;need(canonical(await read('session.json'))===canonical(selected));}
  const names=await readdir(fd);need(names.length<=1+3*selected.maximumEntries&&names.every(n=>n==='session.json'||/^[a-f0-9]{32}\.(reserve|reply)$/.test(n)||/^slot-[0-9]{4}$/.test(n)));
  for(const n of names){if(n==='session.json')continue;const v=await read(n);if(n.startsWith('slot-')){exactKeys(v,['version','nonce','requestSha256']);need(v.version===1&&tokenPattern.test(String(v.nonce))&&Number(n.slice(5))<selected.maximumEntries&&names.includes(String(v.nonce)+'.reserve'));const reservation=await read(String(v.nonce)+'.reserve') as any;need(reservation.requestSha256===v.requestSha256);}else if(n.endsWith('.reserve')){exactKeys(v,['version','requestSha256']);need(v.version===1&&/^[a-f0-9]{64}$/.test(String(v.requestSha256)));}else{const r=v as ControlReply;need(r.nonce===n.slice(0,32)&&canonical(r.binding)===canonical(selected.binding)&&r.comparisonEnforced===true&&tokenPattern.test(r.invocationId));need(names.includes(r.nonce+'.reserve'));}}
 }catch{await h.close();throw new Error('Trusted journal refused.');}
 let serial:Promise<unknown>=Promise.resolve();const queue=<T>(fn:()=>Promise<T>):Promise<T>=>{const task=serial.then(fn);serial=task.catch(()=>{});return task;};
 return {reserve:request=>queue(async()=>{active();need(tokenPattern.test(request.nonce)&&canonical(request.binding)===canonical(selected.binding));await check();let slot:string|undefined;const record={version:1,nonce:request.nonce,requestSha256:digest(request)};for(let i=0;i<selected.maximumEntries;i++){const name='slot-'+String(i).padStart(4,'0');try{await publish(name,record);slot=name;break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}need(slot);try{await publish(request.nonce+'.reserve',{version:1,requestSha256:record.requestSha256});}catch(e){need(canonical(await read(slot))===canonical(record));await unlink(fd+'/'+slot);await h.sync();throw e;}}),
 complete:(request,reply)=>queue(async()=>{active();need(tokenPattern.test(request.nonce));const r=await read(request.nonce+'.reserve') as {requestSha256:string};need(r.requestSha256===digest(request)&&reply.nonce===request.nonce&&canonical(reply.binding)===canonical(selected.binding));await publish(request.nonce+'.reply',reply);}),
 lookup:nonce=>queue(async()=>{active();need(tokenPattern.test(nonce));await check();const names=await readdir(fd);if(!names.includes(nonce+'.reply'))return null;return await read(nonce+'.reply') as ControlReply;}),
 expireCleanup:()=>queue(async()=>{need(now()>=selected.expiresAt);await check();const names=await readdir(fd);need(names.every(n=>n==='session.json'||/^[a-f0-9]{32}\.(reserve|reply)$/.test(n)||/^slot-[0-9]{4}$/.test(n)));for(const n of names)if(n!=='session.json'){await read(n);await unlink(fd+'/'+n);}await h.sync();return names.length-1;}),
 async close(){await serial;await check();closed=true;await h.close();}};
}

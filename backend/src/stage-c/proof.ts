import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {guard} from '../processing/background-config.js';
import {readPrivate} from './private-files.js';
export const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export interface SupervisionProof {version:2;passed:boolean;createdAt:string;bootId:string;nodeSha256:string;supervisionSha256:string;insideSha256:string;checks:{check:string;passed:boolean}[];}
export async function localProofIdentity(){
 return {bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),nodeSha256:digest(await readFile(process.execPath)),
 supervisionSha256:digest(await readFile(fileURLToPath(new URL(import.meta.url.includes('/dist/')?'./supervision.js':'../../dist/stage-c/supervision.js',import.meta.url)))),
 insideSha256:digest(await readFile(fileURLToPath(new URL(import.meta.url.includes('/dist/')?'./inside-protection.js':'../../dist/stage-c/inside-protection.js',import.meta.url))))};
}
// Source and dist executions resolve to the same compiled artifact directory.
// For compiled proof.js, ../../dist would duplicate dist. Use the backend root.
export async function verifySupervisionProof(path:string,pin:string,identity:Awaited<ReturnType<typeof localProofIdentity>>,now=Date.now()){
 const bytes=await readPrivate(path);guard(digest(bytes)===pin);const p=JSON.parse(bytes.toString()) as SupervisionProof;
 guard(p.version===2&&p.passed===true&&Date.parse(p.createdAt)<=now&&now-Date.parse(p.createdAt)<=3600000);
 for(const k of ['bootId','nodeSha256','supervisionSha256','insideSha256'] as const)guard(p[k]===identity[k]);
 const names=['inside-protection','effective-limits','native-containment','graceful-cleanup','controller-loss-cleanup'];
 guard(p.checks.length===names.length&&names.every(n=>p.checks.filter(v=>v.check===n&&v.passed===true).length===1));return p;
}

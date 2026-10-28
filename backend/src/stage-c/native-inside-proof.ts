import {inspectInside,type InsideProtection} from './inside-protection.js';
import type {ProcessIdentity} from './system-supervision.js';
import {canonical} from '../processing/operational-authority.js';
import {requireDelivery as need,deliveryBound,tokenPattern} from './delivery-guards.js';
export async function produceNativeInsideProof(challenge:{nonce:string;process:ProcessIdentity;gid:number;controlGroup:string},signal:AbortSignal,ports:{inspect():Promise<InsideProtection>;self():Promise<{process:ProcessIdentity;gid:number}>}):Promise<unknown>{
 return deliveryBound(300,signal,async s=>{const c=structuredClone(challenge);need(tokenPattern.test(c.nonce)&&c.gid>0);const before=await ports.self();need(canonical(before.process)===canonical(c.process)&&before.gid===c.gid);const inside=await ports.inspect();need(inside.version===1&&inside.protected&&inside.pid===c.process.pid&&inside.uid===c.process.uid&&inside.cgroup===c.controlGroup&&inside.interfaces.every(i=>i.readOnly&&!i.writable&&i.openDenied));need(canonical(await ports.self())===canonical(before));s.throwIfAborted();return {version:1,kind:'health-wallet-inside-challenge',nonce:c.nonce,process:c.process,gid:c.gid,controlGroup:c.controlGroup,interfaces:structuredClone(inside.interfaces)};});}
// Explicit capability; never invoked by import, API or disabled startup.
export const nativeInsideInspection=inspectInside;

import {canonical} from '../processing/operational-authority.js';
export class DeliveryRefusal extends Error {constructor(){super('Trusted delivery refused.');}}
export function requireDelivery(v:unknown):asserts v {if(!v)throw new DeliveryRefusal();}
export const hashPattern=/^[a-f0-9]{64}$/;
export const tokenPattern=/^(?!0{32}$)[a-f0-9]{32}$/;
export function exactKeys(v:unknown,keys:string[]):asserts v is Record<string,unknown>{requireDelivery(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','));}
export function canonicalBytes(v:unknown){return Buffer.from(canonical(v));}
export function parseCanonical(b:Uint8Array,max=65536):unknown {requireDelivery(b.byteLength>0&&b.byteLength<=max);try{const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));requireDelivery(Buffer.from(b).equals(canonicalBytes(v)));return v;}catch{throw new DeliveryRefusal();}}
export async function deliveryBound<T>(ms:number,signal:AbortSignal,fn:(s:AbortSignal)=>Promise<T>):Promise<T>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let abort:()=>void=()=>{};const s=AbortSignal.any([signal,c.signal]);try{return await Promise.race([Promise.resolve().then(()=>{s.throwIfAborted();return fn(s);}),new Promise<never>((_,reject)=>{abort=()=>reject(new DeliveryRefusal());s.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{reject(new DeliveryRefusal());c.abort();},ms);if(s.aborted)abort();})]);}catch{throw new DeliveryRefusal();}finally{if(timer)clearTimeout(timer);s.removeEventListener('abort',abort);c.abort();}}

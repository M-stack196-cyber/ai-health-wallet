import {publicStatus,type Status} from './background-health.js';
export interface HealthBinding {configurationSha256:string;workerInvocationId:string;bootId:string;}
export interface HealthReceipt extends HealthBinding {version:1;kind:'health-wallet-operational-health';sequence:number;observedAt:number;expiresAt:number;status:Status;}
export interface HealthSink {publish(receipt:HealthReceipt,signal:AbortSignal):Promise<void>;}
export class HealthReceiptRefusal extends Error {constructor(){super('Private operational health unavailable.');}}
function need(v:unknown):asserts v {if(!v)throw new HealthReceiptRefusal();}
function binding(b:HealthBinding){need(/^[a-f0-9]{64}$/.test(b.configurationSha256)&&/^[a-f0-9]{32}$/.test(b.workerInvocationId)&&/^[a-f0-9-]{36}$/.test(b.bootId));}
export function verifyHealthReceipt(value:HealthReceipt,expected:HealthBinding,now:number,minimumSequence=0):Status {
 binding(expected);need(value&&Object.keys(value).sort().join(',')==='bootId,configurationSha256,expiresAt,kind,observedAt,sequence,status,version,workerInvocationId');
 need(value.version===1&&value.kind==='health-wallet-operational-health'&&value.configurationSha256===expected.configurationSha256&&value.workerInvocationId===expected.workerInvocationId&&value.bootId===expected.bootId&&Number.isSafeInteger(value.sequence)&&value.sequence>minimumSequence);
 need(Number.isFinite(now)&&Number.isFinite(value.observedAt)&&Number.isFinite(value.expiresAt)&&value.observedAt<=now&&now<value.expiresAt&&value.expiresAt-value.observedAt===1500);
 need(JSON.stringify(value.status)===JSON.stringify(publicStatus(value.status)));return publicStatus(value.status);
}
// Private receipt port only: no TCP listener, HTTP command surface or patient data.
// The deployment supplies an exact-path protected atomic writer; no default sink.
export function receiptHealth(input:HealthBinding,sink:HealthSink,now:()=>number,fault:()=>void){
 binding(input);const b=Object.freeze({...input});
 return async(snapshot:()=>Status)=>{
  let pending:Promise<void>|undefined;
  let sequence=0,closed=false,busy=false,failed=false,last=-Infinity,timer:ReturnType<typeof setTimeout>|undefined;
  async function publish(final=false){
   need(!busy&&!failed);busy=true;const cancel=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
   try{const time=now();need(Number.isFinite(time)&&time>=last);last=time;
    const status=final?{live:false,ready:false,metrics:publicStatus(snapshot()).metrics}:publicStatus(snapshot());
    const value:HealthReceipt={...b,version:1,kind:'health-wallet-operational-health',sequence:++sequence,observedAt:time,expiresAt:time+1500,status};
    await Promise.race([sink.publish(structuredClone(value),cancel.signal),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{cancel.abort();reject(new HealthReceiptRefusal());},500);})]);
   }catch{failed=true;throw new HealthReceiptRefusal();}finally{busy=false;if(timeout)clearTimeout(timeout);cancel.abort();}
  }
  await publish();
  const tick=async()=>{try{pending=publish();await pending;}catch{try{fault();}catch{}return;}finally{pending=undefined;}if(!closed)timer=setTimeout(()=>void tick(),500);};
  timer=setTimeout(()=>void tick(),500);
  return {async close(){if(closed)return;closed=true;if(timer)clearTimeout(timer);if(pending)await pending;if(busy||failed)throw new HealthReceiptRefusal();await publish(true);}};
 };
}

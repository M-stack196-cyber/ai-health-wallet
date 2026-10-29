import {createHash} from 'node:crypto';
export interface GuardianNotificationConfig {
 mode:'synthetic-offline';origin:string;windowSeconds:number;referenceSeconds:number;retrySeconds:number;maxAttempts:number;timeoutMs:number;
 referenceKey:Uint8Array;policyVersion:string;indeterminate:'persist_only'|'blocked_pending_approval';
}
export function guardianNotificationConfig(env:NodeJS.ProcessEnv,referenceKey?:Uint8Array):GuardianNotificationConfig|undefined{
 const mode=env.GUARDIAN_NOTIFICATIONS_MODE??'disabled';if(mode==='disabled')return undefined;
 if(mode!=='synthetic-offline'||!referenceKey||referenceKey.length!==32)throw Error('Guardian medical activation requires a synthetic configuration.');
 const origin=new URL(env.GUARDIAN_NOTIFICATIONS_ORIGIN??'https://guardian.example.invalid');
 if(origin.protocol!=='https:'||!origin.hostname.endsWith('.invalid')||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Synthetic guardian origin required.');
 const integer=(key:string,value:number,max:number)=>{const n=Number(env[key]??value);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid guardian notification policy.');return n;};
 const indeterminate=env.GUARDIAN_INDETERMINATE_POLICY??'persist_only';if(!['persist_only','blocked_pending_approval'].includes(indeterminate))throw Error('CFG-07 outbound messaging is not approved.');
 return {mode,origin:origin.origin,windowSeconds:integer('GUARDIAN_DIGEST_SECONDS',86400,604800),referenceSeconds:integer('GUARDIAN_REPORT_REFERENCE_SECONDS',3600,86400),retrySeconds:integer('GUARDIAN_RETRY_SECONDS',30,3600),maxAttempts:integer('GUARDIAN_MAX_ATTEMPTS',3,5),timeoutMs:integer('GUARDIAN_SEND_TIMEOUT_MS',2000,3000),referenceKey:new Uint8Array(referenceKey),policyVersion:'synthetic-guardian-policy-v1',indeterminate:indeterminate as GuardianNotificationConfig['indeterminate']};
}
export const notificationDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function policyDigest(c:GuardianNotificationConfig){return notificationDigest(JSON.stringify({...c,referenceKey:notificationDigest(Buffer.from(c.referenceKey).toString('hex'))}));}

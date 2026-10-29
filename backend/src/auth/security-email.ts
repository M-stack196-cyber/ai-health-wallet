import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash} from 'node:crypto';
import type {PatientDatabase,PatientConnection} from '../patients/repository.js';
import type {SecurityMailer,SecurityMailMessage} from './routes.js';
import {transaction,secretHash,secretId} from './security-repository.js';

export interface SecurityEmailConfig {
 mode:'sandbox'|'https-relay'; endpoint:string; from:string; encryptionKey:Uint8Array;
 authorization?:string; timeoutMs:number; retrySeconds:number; maxAttempts:number;
}
export interface ProviderMessage {idempotencyKey:string;from:string;to:string;subject:string;text:string;}
export interface SecurityEmailProvider {send(message:ProviderMessage,signal:AbortSignal):Promise<{messageReference?:string}>;}
export class EmailDeliveryFailure extends Error {
 constructor(readonly category:'transport'|'timeout'|'rejected'|'invalid_receipt',readonly transient:boolean){super('Security email delivery failed.');}
}
export function securityEmailConfig(env:NodeJS.ProcessEnv):SecurityEmailConfig|undefined {
 const mode=env.AUTH_SECURITY_EMAIL_MODE??'disabled';if(mode==='disabled')return undefined;
 if(mode!=='sandbox'&&mode!=='https-relay')throw Error('Invalid security email configuration.');
 let url:URL;try{url=new URL(env.AUTH_SECURITY_EMAIL_ENDPOINT??'');}catch{throw Error('Invalid security email configuration.');}
 if(url.username||url.password||url.hash||url.search)throw Error('Invalid security email configuration.');
 if(mode==='sandbox'&&(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)))throw Error('Sandbox must use literal loopback HTTP.');
 if(mode==='https-relay'&&(url.protocol!=='https:'||env.AUTH_SECURITY_EMAIL_PROVIDER_APPROVED!=='true'))throw Error('Production email provider approval/configuration required.');
 const key=env.AUTH_SECURITY_EMAIL_ENCRYPTION_KEY??'',from=env.AUTH_SECURITY_EMAIL_FROM??'';
 if(!/^[a-f0-9]{64}$/i.test(key)||new Set(key.toLowerCase()).size<8||!/^\S+@\S+\.\S+$/.test(from)||from.length>254||/[\r\n]/.test(from))throw Error('Invalid security email configuration.');
 const auth=env.AUTH_SECURITY_EMAIL_AUTHORIZATION;
 if(mode==='https-relay'&&(!auth||auth.length>4096||/[\r\n]/.test(auth)))throw Error('Production email relay authorization required.');
 const integer=(name:string,fallback:number,min:number,max:number)=>{const raw=env[name]??String(fallback),v=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(v)||v<min||v>max)throw Error('Invalid security email configuration.');return v;};
 return {mode,endpoint:url.toString(),from,encryptionKey:Buffer.from(key,'hex'),authorization:mode==='https-relay'?auth:undefined,
  timeoutMs:integer('AUTH_SECURITY_EMAIL_TIMEOUT_MS',2000,100,5000),retrySeconds:integer('AUTH_SECURITY_EMAIL_RETRY_SECONDS',30,1,300),maxAttempts:integer('AUTH_SECURITY_EMAIL_MAX_ATTEMPTS',3,1,3)};
}
export function httpSecurityEmailProvider(config:SecurityEmailConfig):SecurityEmailProvider {
 return {async send(message,signal){
  let response:Response;
  try {response=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':message.idempotencyKey,...(config.authorization?{Authorization:config.authorization}:{})},body:JSON.stringify(message),redirect:'manual',signal});}
  catch {throw new EmailDeliveryFailure(signal.aborted?'timeout':'transport',true);}
  if(!response.ok){await response.body?.cancel();throw new EmailDeliveryFailure('rejected',response.status===408||response.status===429||response.status>=500);}
  const reader=response.body?.getReader();let body='';
  try {
   if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;if(body.length+chunk.value.length>1024)throw Error('bounded');body+=Buffer.from(chunk.value).toString('utf8');}
   const receipt=JSON.parse(body);
   if(!receipt||typeof receipt.message_id!=='string'||receipt.message_id.length<1||receipt.message_id.length>256)throw Error('invalid');
   return {messageReference:receipt.message_id};
  }catch{throw new EmailDeliveryFailure(signal.aborted?'timeout':'invalid_receipt',signal.aborted);}
  finally{await reader?.cancel().catch(()=>{});}
 }};
}
interface Delivery {id:string;challenge_id:string;patient_id:string;purpose:SecurityMailMessage['purpose'];attempts:number;}
function encrypt(message:SecurityMailMessage,id:string,key:Uint8Array){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(id));
 return {nonce,ciphertext:Buffer.concat([cipher.update(JSON.stringify({to:message.to,purpose:message.purpose,token:message.token}),'utf8'),cipher.final()]),tag:cipher.getAuthTag()};
}
export function createSecurityEmailDelivery(db:PatientDatabase,config:SecurityEmailConfig,provider:SecurityEmailProvider=httpSecurityEmailProvider(config)) {
 async function enqueue(message:SecurityMailMessage,c:PatientDatabase){
  const challengeId=secretId(message.token);if(!challengeId)throw Error('Invalid security email challenge.');
  const source=(await c.query<{patient_id:string}>(`SELECT c.patient_id FROM public.patient_auth_challenges c JOIN public.patients p ON p.id=c.patient_id
   WHERE c.id=$1 AND c.purpose=$2 AND c.token_hash=$3 AND (CASE WHEN c.purpose='guardian_invitation' THEN EXISTS(SELECT 1 FROM public.guardian_relationships g
    WHERE g.invitation_id=c.id AND g.patient_id=c.patient_id AND g.status='PENDING' AND g.email=$4)
    WHEN c.purpose='doctor_share_otp' THEN EXISTS(SELECT 1 FROM public.doctor_otp_challenges d JOIN public.doctor_sharing_grants g ON g.id=d.grant_id WHERE d.auth_challenge_id=c.id AND d.patient_id=c.patient_id AND d.doctor_email=$4 AND d.verified_at IS NULL AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.patient_security_version=p.security_version) ELSE p.email=$4 END) AND c.security_version=p.security_version
   AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()`,[challengeId,message.purpose,secretHash(message.purpose,message.token),message.to])).rows[0];
  if(!source)throw Error('Invalid security email challenge.');
  const id=randomUUID();const row=(await c.query<{id:string}>(`INSERT INTO public.patient_security_email_deliveries(id,challenge_id,patient_id,purpose)
   VALUES($1,$2,$3,$4) ON CONFLICT(challenge_id) DO NOTHING RETURNING id`,[id,challengeId,source.patient_id,message.purpose])).rows[0];
  if(!row)return;
  const payload=encrypt(message,id,config.encryptionKey);
  await c.query('INSERT INTO public.patient_security_email_payloads(delivery_id,nonce,ciphertext,tag) VALUES($1,$2,$3,$4)',[id,payload.nonce,payload.ciphertext,payload.tag]);
 }
 const mailer:SecurityMailer={enqueue:async(message,c)=>enqueue(message,c),send:async message=>transaction(db,c=>enqueue(message,c))};
 async function terminal(c:PatientConnection,d:Delivery,state:'expired'|'superseded'|'permanent_failed',category:string){
  await c.query(`UPDATE public.patient_security_email_deliveries SET state=$2,failure_category=$3,claim_id=NULL,claim_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,[d.id,state,category]);
  await c.query('DELETE FROM public.patient_security_email_payloads WHERE delivery_id=$1',[d.id]);
 }
 async function claim(){return transaction(db,async c=>{
  const d=(await c.query<Delivery>(`SELECT id,challenge_id,patient_id,purpose,attempts FROM public.patient_security_email_deliveries
   WHERE (state IN ('pending','transient_failed') AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND claim_expires_at<=clock_timestamp())
   ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[])).rows[0];
  if(!d)return null;
  const source=(await c.query<{live:boolean;expired:boolean;email:string;expires_at:Date}>(`SELECT
   (c.consumed_at IS NULL AND c.security_version=p.security_version AND (
    (c.purpose='verify_email' AND p.account_status='unverified') OR
    (c.purpose='reset_password' AND p.account_status='active' AND p.email_verified_at IS NOT NULL) OR
    (c.purpose='guardian_invitation' AND p.account_status='active' AND p.email_verified_at IS NOT NULL AND EXISTS(
     SELECT 1 FROM public.guardian_relationships g WHERE g.invitation_id=c.id AND g.patient_id=c.patient_id AND g.status='PENDING')) OR
    (c.purpose='doctor_share_otp' AND p.account_status='active' AND p.email_verified_at IS NOT NULL AND EXISTS(
     SELECT 1 FROM public.doctor_otp_challenges d JOIN public.doctor_sharing_grants g ON g.id=d.grant_id WHERE d.auth_challenge_id=c.id AND d.patient_id=c.patient_id AND d.verified_at IS NULL AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.patient_security_version=p.security_version)))) AS live,
   (c.expires_at<=clock_timestamp()) AS expired,CASE WHEN c.purpose='guardian_invitation' THEN (SELECT g.email FROM public.guardian_relationships g WHERE g.invitation_id=c.id) WHEN c.purpose='doctor_share_otp' THEN (SELECT d.doctor_email FROM public.doctor_otp_challenges d WHERE d.auth_challenge_id=c.id) ELSE p.email END AS email,c.expires_at FROM public.patient_auth_challenges c JOIN public.patients p ON p.id=c.patient_id
   WHERE c.id=$1 AND c.patient_id=$2 AND c.purpose=$3`,[d.challenge_id,d.patient_id,d.purpose])).rows[0];
  if(!source||!source.live){await terminal(c,d,'superseded','superseded');return {skipped:true as const};}
  if(source.expired){await terminal(c,d,'expired','expired');return {skipped:true as const};}
  if(d.attempts>=config.maxAttempts){await terminal(c,d,'permanent_failed','transport');return {skipped:true as const};}
  const payload=(await c.query<{nonce:Buffer;ciphertext:Buffer;tag:Buffer}>('SELECT nonce,ciphertext,tag FROM public.patient_security_email_payloads WHERE delivery_id=$1',[d.id])).rows[0];
  let message:SecurityMailMessage;
  try {
   if(!payload)throw Error('Missing payload');const decipher=createDecipheriv('aes-256-gcm',config.encryptionKey,payload.nonce);decipher.setAAD(Buffer.from(d.id));decipher.setAuthTag(payload.tag);
   const value=JSON.parse(Buffer.concat([decipher.update(payload.ciphertext),decipher.final()]).toString('utf8'));
   if(value.to!==source.email||value.purpose!==d.purpose||secretId(value.token)!==d.challenge_id||Object.keys(value).sort().join(',')!=='purpose,to,token')throw Error('Invalid payload');
   const match=(await c.query('SELECT id FROM public.patient_auth_challenges WHERE id=$1 AND token_hash=$2',[d.challenge_id,secretHash(d.purpose,value.token)])).rows[0];if(!match)throw Error('Invalid payload');
   message={...value,expiresIn:Math.max(0,Math.floor((source.expires_at.getTime()-Date.now())/1000))};
  }catch{await terminal(c,d,'permanent_failed','invalid_payload');return {skipped:true as const};}
  const claimId=randomUUID();await c.query(`UPDATE public.patient_security_email_deliveries SET state='sending',attempts=attempts+1,claim_id=$2,
   claim_expires_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1`,[d.id,claimId,config.timeoutMs+2000]);
  return {skipped:false as const,d:{...d,attempts:d.attempts+1},claimId,message,expiresAt:source.expires_at};
 });}
 async function drain(limit=10){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid security email batch limit.');
  const result={processed:0,delivered:0,failed:0,skipped:0};
  for(let i=0;i<limit;i++){
   const claimed=await claim();if(!claimed)break;result.processed++;
   if(claimed.skipped){result.skipped++;continue;}
   const {d,claimId,message,expiresAt}=claimed,controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
   const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new EmailDeliveryFailure('timeout',true));},Math.min(config.timeoutMs,Math.max(1,expiresAt.getTime()-Date.now())));});
   let receipt:{messageReference?:string}|undefined,failure:EmailDeliveryFailure|undefined;
   const kind=message.purpose==='doctor_share_otp'?'Verify your AI Health Wallet sharing access':message.purpose==='guardian_invitation'?'Accept your AI Health Wallet guardian invitation':message.purpose==='verify_email'?'Verify your AI Health Wallet email':'Reset your AI Health Wallet password';
   const body=`${kind}.\n\n${message.purpose==='doctor_share_otp'?'Doctor sharing OTP':message.purpose==='guardian_invitation'?'Guardian acceptance':message.purpose==='verify_email'?'Verification':'Password reset'} code: ${message.token}\n\nExpires at ${expiresAt.toISOString()}. This code is single-use. If you did not request this, ignore this email.`;
   try {receipt=await Promise.race([provider.send({idempotencyKey:d.id,from:config.from,to:message.to,subject:kind,text:body},controller.signal),deadline]);}
   catch(error){failure=error instanceof EmailDeliveryFailure?error:new EmailDeliveryFailure('transport',true);}
   finally{clearTimeout(timeout);}
   await transaction(db,async c=>{
    const row=(await c.query('SELECT id FROM public.patient_security_email_deliveries WHERE id=$1 AND state=\'sending\' AND claim_id=$2 FOR UPDATE',[d.id,claimId])).rows[0];if(!row)return;
    if(!failure){
     const reference=receipt?.messageReference?createHash('sha256').update(receipt.messageReference).digest('hex'):null;
     await c.query(`UPDATE public.patient_security_email_deliveries SET state='delivered',delivered_at=clock_timestamp(),updated_at=clock_timestamp(),
      claim_id=NULL,claim_expires_at=NULL,failure_category=NULL,provider_reference_hash=$2 WHERE id=$1`,[d.id,reference]);
     await c.query('DELETE FROM public.patient_security_email_payloads WHERE delivery_id=$1',[d.id]);result.delivered++;
    }else{
     const retry=failure.transient&&d.attempts<config.maxAttempts;
     await c.query(`UPDATE public.patient_security_email_deliveries SET state=$2,failure_category=$3,updated_at=clock_timestamp(),claim_id=NULL,claim_expires_at=NULL,
      next_attempt_at=clock_timestamp()+$4*interval '1 second' WHERE id=$1`,[d.id,retry?'transient_failed':'permanent_failed',failure.category,config.retrySeconds*d.attempts]);
     if(!retry)await c.query('DELETE FROM public.patient_security_email_payloads WHERE delivery_id=$1',[d.id]);result.failed++;
    }
   });
  }
  return result;
 }
 return {mailer,drain};
}
export function configuredSecurityEmail(db:PatientDatabase,env:NodeJS.ProcessEnv=process.env){const config=securityEmailConfig(env);return config?createSecurityEmailDelivery(db,config):undefined;}

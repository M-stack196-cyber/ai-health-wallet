import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import type {PatientDatabase,PatientConnection} from '../patients/repository.js';
import {transaction,secretHash,secretId} from '../auth/security-repository.js';
import type {SecurityMailer} from '../auth/routes.js';
import type {SharingConfig} from './config.js';
import {ApiError} from '../http/errors.js';
export const shareDenied=()=>new ApiError(403,'SHARE_ACCESS_DENIED','Sharing authorization is invalid or expired.');
export interface DoctorScope {patientId:string;grantId:string;sessionHash:string;permittedDocumentIds:string[];}
export async function shareEvent(db:PatientDatabase,event:string,grantId?:string){await db.query('INSERT INTO doctor_share_events(grant_id,event) VALUES($1,$2)',[grantId??null,event]);}
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createSharingRepository(db:PatientDatabase,config:SharingConfig){
 async function grant(c:PatientDatabase,token:string,lock=false){
  if(!/^sh1\.[a-f0-9]{64}$/.test(token))return undefined;
  if(lock){const owner=(await c.query('SELECT patient_id FROM doctor_sharing_grants WHERE token_digest=$1',[Buffer.from(secretHash('share',token),'hex')])).rows[0];if(!owner)return undefined;await c.query('SELECT id FROM patients WHERE id=$1 FOR UPDATE',[owner.patient_id]);}
  return (await c.query(`SELECT g.*,(g.revoked_at IS NULL AND g.expires_at>clock_timestamp()) live,(g.expires_at<=clock_timestamp()) expired,p.security_version current_security_version FROM doctor_sharing_grants g JOIN patients p ON p.id=g.patient_id WHERE g.token_digest=$1 AND p.account_status='active' AND p.email_verified_at IS NOT NULL AND g.patient_security_version=p.security_version ${lock?'FOR UPDATE OF g':''}`,[Buffer.from(secretHash('share',token),'hex')])).rows[0];
 }
 const live=(g:any)=>g&&g.live===true;
 async function denial(c:PatientDatabase,g:any){await shareEvent(c,g&&g.expired===true?'expiry_denied':'denied',g?.id);}
 return {
 async create(patient:string,session:string,ids:string[],kind:'qr_code'|'unique_link',email?:string){return transaction(db,async c=>{
  await c.query('SELECT id FROM patients WHERE id=$1 FOR UPDATE',[patient]);
  const p=(await c.query(`SELECT p.security_version FROM patients p JOIN patient_auth_sessions s ON s.patient_id=p.id WHERE p.id=$1 AND s.id=$2 AND p.account_status='active' AND p.email_verified_at IS NOT NULL AND s.security_version=p.security_version AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()`,[patient,session])).rows[0];if(!p)throw shareDenied();
  const docs=(await c.query(`SELECT id FROM medical_documents WHERE patient_id=$1 AND id=ANY($2::uuid[]) AND access_state='active' AND sha256 IS NOT NULL AND size_bytes>0 ORDER BY id FOR SHARE`,[patient,ids])).rows;
  if(docs.length!==ids.length)throw new ApiError(400,'INVALID_SHARE_SELECTION','Select only your currently accessible original records.');
  const id=randomUUID(),token='sh1.'+randomBytes(32).toString('hex');
  const row=(await c.query(`INSERT INTO doctor_sharing_grants(id,patient_id,doctor_email,sharing_method,token_digest,expires_at,recipient_bound,patient_security_version) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second',$7,$8) RETURNING id,sharing_method,created_at,expires_at,revoked_at`,[id,patient,email??'unclaimed@example.invalid',kind,Buffer.from(secretHash('share',token),'hex'),kind==='qr_code'?config.qrSeconds:config.linkSeconds,!!email,p.security_version])).rows[0];
  for(const doc of ids)await c.query('INSERT INTO sharing_grant_documents(grant_id,document_id,patient_id) VALUES($1,$2,$3)',[id,doc,patient]);await shareEvent(c,'created',id);return {grant:row,token};
 });},
 async revoke(id:string,patient:string){return transaction(db,async c=>{const g=(await c.query('SELECT id,revoked_at FROM doctor_sharing_grants WHERE id=$1 AND patient_id=$2 FOR UPDATE',[id,patient])).rows[0];if(!g)return false;if(!g.revoked_at){await c.query('UPDATE doctor_sharing_grants SET revoked_at=clock_timestamp(),authorization_version=authorization_version+1 WHERE id=$1',[id]);await c.query('UPDATE doctor_share_sessions SET revoked_at=clock_timestamp() WHERE grant_id=$1 AND revoked_at IS NULL',[id]);await shareEvent(c,'revoked',id);}return true;});},
 async list(patient:string){return (await db.query('SELECT id,sharing_method,created_at,expires_at,revoked_at FROM doctor_sharing_grants WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 100',[patient])).rows;},
 async open(token:string){const g=await grant(db,token);if(!live(g)){await denial(db,g);throw shareDenied();}await shareEvent(db,'opened',g!.id);return {requires_email_otp:true,sharing_method:g!.sharing_method,expires_at:g!.expires_at};},
 async requestOtp(token:string,email:string,name:string,organization:string|null,mailer:SecurityMailer){
  return transaction(db,async c=>{
   const g=await grant(c,token,true);if(!live(g)||g!.recipient_bound&&g!.doctor_email!==email){await denial(c,g);return null;}
   const recent=(await c.query("SELECT id FROM doctor_otp_challenges WHERE grant_id=$1 AND created_at>clock_timestamp()-$2*interval '1 second'",[g!.id,config.resendSeconds])).rows[0];if(recent)return null;
   if(!g!.recipient_bound)await c.query('UPDATE doctor_sharing_grants SET doctor_email=$2,recipient_bound=true WHERE id=$1',[g!.id,email]);
   await c.query("UPDATE patient_auth_challenges c SET consumed_at=clock_timestamp() FROM doctor_otp_challenges d WHERE d.auth_challenge_id=c.id AND d.grant_id=$1 AND c.consumed_at IS NULL",[g!.id]);
   await c.query('UPDATE doctor_share_sessions SET revoked_at=clock_timestamp() WHERE grant_id=$1 AND revoked_at IS NULL',[g!.id]);
   const id=randomUUID(),otp=id+'.'+randomBytes(32).toString('hex'),hash=secretHash('doctor_share_otp',otp);
   await c.query(`INSERT INTO patient_auth_challenges(id,patient_id,purpose,token_hash,expires_at,security_version) VALUES($1,$2,'doctor_share_otp',$3,LEAST($4::timestamptz,clock_timestamp()+$5*interval '1 second'),$6)`,[id,g!.patient_id,hash,g!.expires_at,config.otpSeconds,g!.current_security_version]);
   await c.query(`INSERT INTO doctor_otp_challenges(id,grant_id,patient_id,doctor_email,otp_verifier,verifier_key_version,expires_at,auth_challenge_id,doctor_name,organization) VALUES($1,$2,$3,$4,$5,'sha256-purpose-v1',LEAST($6::timestamptz,clock_timestamp()+$7*interval '1 second'),$1,$8,$9)`,[id,g!.id,g!.patient_id,email,Buffer.from(hash,'hex'),g!.expires_at,config.otpSeconds,name,organization]);
   if(!mailer.enqueue)throw new ApiError(503,'SHARING_EMAIL_UNAVAILABLE','Sharing email is temporarily unavailable.');await mailer.enqueue({to:email,purpose:'doctor_share_otp',token:otp,expiresIn:config.otpSeconds},c);
   await shareEvent(c,'otp_requested',g!.id);return {challenge_id:id,expires_in:config.otpSeconds};
  });
 },
 async verify(token:string,email:string,id:string,otp:string){return transaction(db,async c=>{
  const g=await grant(c,token,true);if(!live(g)){await denial(c,g);return null;}
  const challenge=(await c.query(`SELECT d.*,c.token_hash,c.consumed_at,c.security_version,c.expires_at auth_expires,(c.expires_at>clock_timestamp()) otp_live FROM doctor_otp_challenges d JOIN patient_auth_challenges c ON c.id=d.auth_challenge_id WHERE d.id=$1 AND d.grant_id=$2 AND d.doctor_email=$3 AND c.purpose='doctor_share_otp' FOR UPDATE OF d,c`,[id,g!.id,email])).rows[0];
  if(!challenge||challenge.verified_at||challenge.consumed_at||challenge.attempt_count>=config.attempts||!challenge.otp_live||String(challenge.security_version)!==String(g!.current_security_version)){await shareEvent(c,'otp_failed',g!.id);return null;}
  await c.query('UPDATE doctor_otp_challenges SET attempt_count=attempt_count+1 WHERE id=$1',[id]);
  if(secretId(otp)!==id||!equal(secretHash('doctor_share_otp',otp),challenge.token_hash)){if(challenge.attempt_count+1>=config.attempts)await c.query('UPDATE patient_auth_challenges SET consumed_at=clock_timestamp() WHERE id=$1',[id]);await shareEvent(c,'otp_failed',g!.id);return null;}
  await c.query('UPDATE doctor_otp_challenges SET verified_at=clock_timestamp() WHERE id=$1',[id]);await c.query('UPDATE patient_auth_challenges SET consumed_at=clock_timestamp() WHERE id=$1',[id]);
  const sessionId=randomUUID(),session='ds1.'+sessionId+'.'+randomBytes(32).toString('hex');
  const row=(await c.query(`INSERT INTO doctor_share_sessions(id,grant_id,patient_id,doctor_email,doctor_name,organization,challenge_id,token_hash,grant_version,patient_security_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,LEAST($11::timestamptz,clock_timestamp()+$12*interval '1 second')) RETURNING expires_at`,[sessionId,g!.id,g!.patient_id,email,challenge.doctor_name,challenge.organization,id,secretHash('doctor_session',session),g!.authorization_version,g!.current_security_version,g!.expires_at,config.sessionSeconds])).rows[0];await shareEvent(c,'otp_verified',g!.id);return {access_token:session,expires_at:row!.expires_at};
 });},
 async resolve(session:string):Promise<DoctorScope>{
  if(!/^ds1\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(session)){await shareEvent(db,'denied');throw shareDenied();}
  const hash=secretHash('doctor_session',session);
  const rows=(await db.query(`SELECT g.id grant_id,g.patient_id,m.document_id FROM doctor_share_sessions s JOIN doctor_sharing_grants g ON (g.id,g.patient_id,g.doctor_email)=(s.grant_id,s.patient_id,s.doctor_email) JOIN sharing_grant_documents m ON (m.grant_id,m.patient_id)=(g.id,g.patient_id) WHERE s.token_hash=$1 AND public.doctor_document_current($1,m.document_id) ORDER BY m.document_id`,[hash])).rows;
  if(!rows.length){const g=(await db.query('SELECT s.grant_id id,(s.expires_at<=clock_timestamp() OR g.expires_at<=clock_timestamp()) expired FROM doctor_share_sessions s JOIN doctor_sharing_grants g ON g.id=s.grant_id WHERE s.token_hash=$1',[hash])).rows[0];await denial(db,g);throw shareDenied();}
  return {patientId:rows[0].patient_id,grantId:rows[0].grant_id,sessionHash:hash,permittedDocumentIds:rows.map(r=>r.document_id)};
 }
 };
}

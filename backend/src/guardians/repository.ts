import {randomBytes,randomUUID} from 'node:crypto';
import type {PatientDatabase,PatientConnection} from '../patients/repository.js';
import type {SecurityMailer} from '../auth/routes.js';
import type {SecurityPolicy} from '../auth/security-policy.js';
import {transaction,secretId,secretHash,createSecurityRepository} from '../auth/security-repository.js';
import type {SessionIdentity} from '../auth/security-repository.js';
import {ApiError} from '../http/errors.js';
export interface GuardianRow {id:string;email:string;status:string;accepted_at:Date|null;invitation_id:string|null;expires_at:Date|null;}
const invalid=()=>new ApiError(400,'INVALID_GUARDIAN_INVITATION','Invitation is invalid or expired.');
const conflict=()=>new ApiError(409,'GUARDIAN_CONFLICT','Guardian state does not permit this operation.');
export function createGuardianRepository(db:PatientDatabase,policy:SecurityPolicy,mailer?:SecurityMailer){
 async function audit(c:PatientDatabase,p:string,g:string,event:string){await c.query('INSERT INTO public.guardian_lifecycle_events(patient_id,relationship_id,event) VALUES($1,$2,$3)',[p,g,event]);}
 async function lock(c:PatientConnection,who:SessionIdentity){
  await c.query('SELECT id FROM public.patients WHERE id=$1 FOR UPDATE',[who.patientId]);
  if(!await createSecurityRepository(c,policy).authorize(who))throw new ApiError(401,'INVALID_CREDENTIALS','Invalid credentials or authorization.');
 }
 async function current(c:PatientDatabase,patient:string){
  const g=(await c.query<GuardianRow>(`SELECT g.id,g.email,g.status,g.accepted_at,g.invitation_id,c.expires_at FROM public.guardian_relationships g
   LEFT JOIN public.patient_auth_challenges c ON c.id=g.invitation_id WHERE g.patient_id=$1
   ORDER BY g.created_at DESC,g.id DESC LIMIT 1`,[patient])).rows[0];
  if(g?.status==='PENDING'&&g.expires_at&&g.expires_at.getTime()<=Date.now()){
   await c.query("UPDATE public.guardian_relationships SET status='EXPIRED',updated_at=clock_timestamp() WHERE id=$1",[g.id]);
   await audit(c,patient,g.id,'expired');g.status='EXPIRED';
  }
  return g;
 }
 async function cancel(c:PatientDatabase,g:GuardianRow){
  if(g.invitation_id)await c.query('UPDATE public.patient_auth_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE id=$1',[g.invitation_id]);
  // No lock inversion with the delivery claimant. The consumer remains authoritative
  // even if an invitation email was already submitted before revocation.
 }
 async function invite(c:PatientConnection,patient:string,g:GuardianRow){
  if(!mailer?.enqueue)throw new ApiError(503,'GUARDIAN_DELIVERY_UNAVAILABLE','Guardian invitation delivery is temporarily unavailable.');
  const recent=(await c.query(`SELECT id FROM public.patient_auth_challenges WHERE patient_id=$1 AND purpose='guardian_invitation'
   AND created_at>clock_timestamp()-$2*interval '1 second'`,[patient,policy.resendCooldownSeconds])).rows[0];
  const count=(await c.query<{n:number}>(`SELECT count(*)::int AS n FROM public.patient_auth_challenges WHERE patient_id=$1
   AND purpose='guardian_invitation' AND created_at>clock_timestamp()-$2*interval '1 second'`,[patient,policy.rateWindowSeconds])).rows[0].n;
  if(recent||count>=policy.challengeRateMax)throw new ApiError(429,'GUARDIAN_RATE_LIMITED','Too many invitation attempts. Try again later.');
  await cancel(c,g);
  const id=randomUUID(),token=id+'.'+randomBytes(32).toString('hex');
  await c.query(`INSERT INTO public.patient_auth_challenges(id,patient_id,purpose,token_hash,expires_at,security_version)
   SELECT $1,id,'guardian_invitation',$3,clock_timestamp()+$4*interval '1 second',security_version FROM public.patients WHERE id=$2`,[id,patient,secretHash('guardian_invitation',token),policy.verificationSeconds]);
  await c.query('UPDATE public.guardian_relationships SET invitation_id=$2,updated_at=clock_timestamp() WHERE id=$1',[g.id,id]);
  await mailer.enqueue({to:g.email,purpose:'guardian_invitation',token,expiresIn:policy.verificationSeconds},c);
 }
 return {
  // Called only after successful patient verification. Failure leaves the saved
  // intent available for authenticated nomination without undoing M01 verification.
  async registrationIntent(token:string){
   const id=secretId(token);if(!id)return;
   const source=(await db.query<{patient_id:string}>("SELECT patient_id FROM public.patient_auth_challenges WHERE id=$1 AND purpose='verify_email' AND token_hash=$2 AND consumed_at IS NOT NULL",[id,secretHash('verify_email',token)])).rows[0];
   if(!source)return;
   await transaction(db,async c=>{
    const p=(await c.query<{id:string;pending_guardian_email:string|null}>(`SELECT p.id,p.pending_guardian_email FROM public.patients p
     JOIN public.patient_auth_challenges c ON c.patient_id=p.id WHERE c.id=$1 AND p.account_status='active'
     AND p.email_verified_at IS NOT NULL AND p.security_version=c.security_version+1 FOR UPDATE OF p`,[id])).rows[0];
    if(!p?.pending_guardian_email||await current(c,p.id))return;
    const g:GuardianRow={id:randomUUID(),email:p.pending_guardian_email,status:'PENDING',accepted_at:null,invitation_id:null,expires_at:null};
    await c.query("INSERT INTO public.guardian_relationships(id,patient_id,email,status) VALUES($1,$2,$3,'PENDING')",[g.id,p.id,g.email]);
    await invite(c,p.id,g);await audit(c,p.id,g.id,'nominated');
    await c.query('UPDATE public.patients SET pending_guardian_email=NULL WHERE id=$1',[p.id]);
   });
  },
  async status(who:SessionIdentity){return transaction(db,async c=>{await lock(c,who);return current(c,who.patientId);});},
  async nominate(who:SessionIdentity,email:string|undefined,replace=false){return transaction(db,async c=>{
   await lock(c,who);const old=await current(c,who.patientId);
   if(!replace&&old&&['PENDING','ACTIVE'].includes(old.status))throw conflict();
   if(replace&&!old)throw conflict();
   const target=email??(await c.query<{pending_guardian_email:string|null}>('SELECT pending_guardian_email FROM public.patients WHERE id=$1',[who.patientId])).rows[0]?.pending_guardian_email;
   if(!target)throw new ApiError(400,'INVALID_INPUT','A guardian email is required.');
   if(old){await cancel(c,old);if(old.status!=='REVOKED'){await c.query("UPDATE public.guardian_relationships SET status='REVOKED',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[old.id]);await audit(c,who.patientId,old.id,'revoked');}}
   const g:GuardianRow={id:randomUUID(),email:target,status:'PENDING',accepted_at:null,invitation_id:null,expires_at:null};
   await c.query("INSERT INTO public.guardian_relationships(id,patient_id,email,status) VALUES($1,$2,$3,'PENDING')",[g.id,who.patientId,target]);
   await invite(c,who.patientId,g);await audit(c,who.patientId,g.id,'nominated');
   await c.query('UPDATE public.patients SET pending_guardian_email=NULL WHERE id=$1',[who.patientId]);return current(c,who.patientId);
  });},
  async resend(who:SessionIdentity){return transaction(db,async c=>{await lock(c,who);const g=await current(c,who.patientId);if(!g||g.status!=='PENDING')throw conflict();await invite(c,who.patientId,g);await audit(c,who.patientId,g.id,'resent');return current(c,who.patientId);});},
  async remove(who:SessionIdentity){return transaction(db,async c=>{await lock(c,who);const g=await current(c,who.patientId);
   if(g&&g.status!=='REVOKED'){await cancel(c,g);await c.query("UPDATE public.guardian_relationships SET status='REVOKED',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[g.id]);await audit(c,who.patientId,g.id,'revoked');}
   await c.query('UPDATE public.patients SET pending_guardian_email=NULL WHERE id=$1',[who.patientId]);return g?{...g,status:'REVOKED'}:undefined;
  });},
  async accept(token:string){
   const id=secretId(token);if(!id)throw invalid();
   const lookup=(await db.query<{patient_id:string}>('SELECT patient_id FROM public.patient_auth_challenges WHERE id=$1 AND purpose=\'guardian_invitation\'',[id])).rows[0];if(!lookup)throw invalid();
   const ok=await transaction(db,async c=>{
    await c.query('SELECT id FROM public.patients WHERE id=$1 FOR UPDATE',[lookup.patient_id]);
    const row=(await c.query<{id:string}>(`SELECT g.id FROM public.guardian_relationships g JOIN public.patient_auth_challenges c ON c.id=g.invitation_id
     JOIN public.patients p ON p.id=g.patient_id WHERE c.id=$1 AND c.patient_id=g.patient_id AND c.purpose='guardian_invitation'
     AND g.status='PENDING' AND c.token_hash=$2 AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()
     AND c.security_version=p.security_version AND p.account_status='active' AND p.email_verified_at IS NOT NULL FOR UPDATE OF g,c`,[id,secretHash('guardian_invitation',token)])).rows[0];
    if(!row)return false;
    await c.query('UPDATE public.patient_auth_challenges SET consumed_at=clock_timestamp() WHERE id=$1',[id]);
    await c.query("UPDATE public.guardian_relationships SET status='ACTIVE',accepted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[row.id]);
    await audit(c,lookup.patient_id,row.id,'accepted');return true;
   });if(!ok)throw invalid();
  }
 };
}

import type {PatientDatabase} from '../patients/repository.js';
import {transaction,type SessionIdentity} from '../auth/security-repository.js';

export type DeletionState='policy_pending'|'blocked_legal_hold';
export interface DeletionRequestResult {id:string;state:DeletionState;requested_at:Date;}

/** Non-destructive: records the request and ends access. Nothing is physically deleted (CFG-12/CFG-18 pending). */
export function createDeletionRepository(db:PatientDatabase) {
 return {
  /** Returns null when the credentials, session or account are no longer current; the caller answers with a generic denial. */
  async request(identity:SessionIdentity,expectedHash:string):Promise<DeletionRequestResult|null> {
   return transaction(db,async c=>{
    const p=(await c.query<{id:string;account_status:string;email_verified_at:Date|null;password_hash:string}>(
     'SELECT id,account_status,email_verified_at,password_hash FROM public.patients WHERE id=$1 FOR UPDATE',[identity.patientId])).rows[0];
    if(!p||p.account_status!=='active'||p.email_verified_at===null||p.password_hash!==expectedHash)return null;
    const live=(await c.query(`SELECT id FROM public.patient_auth_sessions WHERE id=$1 AND patient_id=$2 AND revoked_at IS NULL
     AND expires_at>clock_timestamp() AND idle_expires_at>clock_timestamp() FOR UPDATE`,[identity.sessionId,p.id])).rows[0];
    if(!live)return null;
    const held=!!(await c.query('SELECT id FROM public.patient_legal_holds WHERE patient_id=$1 AND released_at IS NULL LIMIT 1',[p.id])).rows[0];
    const state:DeletionState=held?'blocked_legal_hold':'policy_pending';
    // The existing security trigger also raises security_version, so old tokens and share grants stop working.
    await c.query('UPDATE public.patients SET account_status=$2 WHERE id=$1',[p.id,held?'deletion_restricted':'deletion_pending']);
    const sessions=(await c.query<{n:number}>(`WITH revoked AS (UPDATE public.patient_auth_sessions SET revoked_at=clock_timestamp()
     WHERE patient_id=$1 AND revoked_at IS NULL RETURNING id), logged AS (INSERT INTO public.patient_security_events(patient_id,session_id,event)
     SELECT $1,id,'session_revoked' FROM revoked RETURNING 1) SELECT count(*)::int AS n FROM revoked`,[p.id])).rows[0].n;
    await c.query('UPDATE public.patient_auth_challenges SET consumed_at=clock_timestamp() WHERE patient_id=$1 AND consumed_at IS NULL',[p.id]);
    const grants=(await c.query<{n:number}>(`WITH revoked AS (UPDATE public.doctor_sharing_grants SET revoked_at=clock_timestamp(),
     authorization_version=authorization_version+1 WHERE patient_id=$1 AND revoked_at IS NULL RETURNING id), logged AS (
     INSERT INTO public.doctor_share_events(grant_id,event) SELECT id,'revoked' FROM revoked RETURNING 1) SELECT count(*)::int AS n FROM revoked`,[p.id])).rows[0].n;
    const doctorSessions=(await c.query<{n:number}>(`WITH revoked AS (UPDATE public.doctor_share_sessions SET revoked_at=clock_timestamp()
     WHERE patient_id=$1 AND revoked_at IS NULL RETURNING id) SELECT count(*)::int AS n FROM revoked`,[p.id])).rows[0].n;
    const row=(await c.query<DeletionRequestResult>(`INSERT INTO public.patient_deletion_requests(patient_id,state,sessions_revoked,grants_revoked,doctor_sessions_revoked)
     VALUES($1,$2,$3,$4,$5) RETURNING id,state,requested_at`,[p.id,state,sessions,grants,doctorSessions])).rows[0];
    for(const event of held?['requested','access_revoked','legal_hold_blocked']:['requested','access_revoked'])
     await c.query('INSERT INTO public.patient_deletion_audit(request_id,patient_id,event) VALUES($1,$2,$3)',[row.id,p.id,event]);
    return row;
   });
  },
 };
}

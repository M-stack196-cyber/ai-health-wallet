import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';
import type {PatientDatabase, PatientConnection} from '../patients/repository.js';
import {ApiError} from '../http/errors.js';
import type {SecurityPolicy} from './security-policy.js';

export type ChallengePurpose = 'verify_email' | 'reset_password';
export const secretHash = (purpose: string, token: string) => createHash('sha256').update(purpose+'\0'+token).digest('hex');
const secret = (id: string) => id+'.'+randomBytes(32).toString('hex');
export function secretId(token: unknown): string | undefined {
  return typeof token === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}$/.test(token) ? token.slice(0,36) : undefined;
}
interface Account {id: string; email: string; password_hash: string; account_status: string; email_verified_at: Date | null; security_version: string;}
export interface SessionIdentity {patientId: string; sessionId: string;}
const eligible = (p: Account | undefined): p is Account => !!p && p.account_status === 'active' && p.email_verified_at !== null;
export async function transaction<T>(db: PatientDatabase, work: (client: PatientConnection) => Promise<T>): Promise<T> {
  const connect=(db as PatientDatabase & {connect?:()=>Promise<PatientConnection>}).connect;
  if (!connect) throw new ApiError(503,'IDENTITY_UNAVAILABLE','Identity service is temporarily unavailable.');
  const c = await connect.call(db); let broken = false;
  try {
    await c.query('BEGIN',[]);
    await c.query("SET LOCAL lock_timeout='3s'",[]);
    await c.query("SET LOCAL statement_timeout='5s'",[]);
    const result = await work(c);
    await c.query('COMMIT',[]);
    return result;
  } catch(error) {
    try {await c.query('ROLLBACK',[]);} catch {broken = true;}
    throw error;
  } finally {c.release(broken);}
}
async function event(c: PatientDatabase, type: string, patientId?: string, sessionId?: string) {
  await c.query('INSERT INTO public.patient_security_events(patient_id,session_id,event) VALUES($1,$2,$3)',[patientId??null,sessionId??null,type]);
}
async function account(c: PatientDatabase, id: string) {
  // Every security mutation locks patient BEFORE challenge/session, including reset/rotation.
  return (await c.query<Account>('SELECT * FROM public.patients WHERE id=$1 FOR UPDATE',[id])).rows[0];
}
export function createSecurityRepository(db: PatientDatabase, policy: SecurityPolicy) {
  return {
    async rate(key: string, maximum: number, windowSeconds: number) {
      const row = (await db.query<{attempts: number}>(`INSERT INTO public.patient_auth_rate_limits AS r(bucket_hash,window_started_at,attempts)
        VALUES($1,clock_timestamp(),1) ON CONFLICT(bucket_hash) DO UPDATE SET
        attempts=CASE WHEN r.window_started_at <= clock_timestamp()-$3*interval '1 second' THEN 1 ELSE LEAST(r.attempts+1,$2+1) END,
        window_started_at=CASE WHEN r.window_started_at <= clock_timestamp()-$3*interval '1 second' THEN clock_timestamp() ELSE r.window_started_at END
        RETURNING attempts`,[key,maximum,windowSeconds])).rows[0];
      return row.attempts <= maximum;
    },
    async audit(type: string, patientId?: string, sessionId?: string) {await event(db,type,patientId,sessionId);},
    async issueChallenge(email: string, purpose: ChallengePurpose, enqueue?: (message: {to:string;purpose:ChallengePurpose;token:string;expiresIn:number},client:PatientConnection)=>Promise<void>) {
      return transaction(db,async c => {
        const p = (await c.query<Account>('SELECT * FROM public.patients WHERE email=$1 FOR UPDATE',[email])).rows[0];
        if (!p || (purpose === 'verify_email' ? p.account_status !== 'unverified' : !eligible(p))) return null;
        const recent = (await c.query(`SELECT id FROM public.patient_auth_challenges WHERE patient_id=$1 AND purpose=$2
          AND created_at > clock_timestamp()-$3*interval '1 second' LIMIT 1`,[p.id,purpose,policy.resendCooldownSeconds])).rows[0];
        if (recent) return null;
        await c.query('UPDATE public.patient_auth_challenges SET consumed_at=clock_timestamp() WHERE patient_id=$1 AND purpose=$2 AND consumed_at IS NULL',[p.id,purpose]);
        const id=randomUUID(), token=secret(id), ttl=purpose==='verify_email'?policy.verificationSeconds:policy.resetSeconds;
        await c.query(`INSERT INTO public.patient_auth_challenges(id,patient_id,purpose,token_hash,expires_at,security_version)
          VALUES($1,$2,$3,$4,clock_timestamp()+$5*interval '1 second',$6)`,[id,p.id,purpose,secretHash(purpose,token),ttl,p.security_version]);
        await event(c,'challenge_issued',p.id);
        if(enqueue)await enqueue({to:p.email,purpose,token,expiresIn:ttl},c);
        return {patientId:p.id,email:p.email,purpose,token,expiresIn:ttl};
      });
    },
    async consumeChallenge(token: string, purpose: ChallengePurpose, newHash?: string) {
      const id=secretId(token); if(!id)return false;
      const lookup=(await db.query<{patient_id:string}>('SELECT patient_id FROM public.patient_auth_challenges WHERE id=$1',[id])).rows[0];
      if(!lookup)return false;
      return transaction(db,async c=>{
        const p=await account(c,lookup.patient_id);
        if(!p || (purpose==='verify_email'?p.account_status!=='unverified':!eligible(p)))return false;
        const challenge=(await c.query(`SELECT id FROM public.patient_auth_challenges WHERE id=$1 AND patient_id=$2 AND purpose=$3
          AND token_hash=$4 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND security_version=$5 FOR UPDATE`,[id,p.id,purpose,secretHash(purpose,token),p.security_version])).rows[0];
        if(!challenge)return false;
        if(purpose==='reset_password' && !newHash) return false;
        await c.query('UPDATE public.patient_auth_challenges SET consumed_at=clock_timestamp() WHERE id=$1',[id]);
        if(purpose==='verify_email') {
          await c.query("UPDATE public.patients SET email_verified_at=clock_timestamp(),account_status='active' WHERE id=$1",[p.id]);
          await event(c,'email_verified',p.id);
        } else {
          await c.query('UPDATE public.patients SET password_hash=$2 WHERE id=$1',[p.id,newHash]);
          await c.query('UPDATE public.patient_auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE patient_id=$1',[p.id]);
          await c.query('UPDATE public.patient_auth_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE patient_id=$1',[p.id]);
          await event(c,'password_reset',p.id);
        }
        return true;
      });
    },
    async login(patientId: string, expectedHash: string) {
      return transaction(db,async c=>{
        const p=await account(c,patientId);
        if(!eligible(p)||p.password_hash!==expectedHash) {await event(c,'login_failed',p?.id);return null;}
        const sessionId=randomUUID(), refreshToken=secret(sessionId);
        const lifetime=(await c.query<{refresh_seconds:number}>(`INSERT INTO public.patient_auth_sessions(id,patient_id,security_version,refresh_hash,expires_at,idle_expires_at)
          VALUES($1,$2,$3,$4,statement_timestamp()+$5*interval '1 second',statement_timestamp()+$6*interval '1 second')
          RETURNING GREATEST(0,FLOOR(EXTRACT(EPOCH FROM LEAST(expires_at,idle_expires_at)-clock_timestamp())))::int AS refresh_seconds`,
          [sessionId,p.id,p.security_version,secretHash('refresh',refreshToken),policy.refreshAbsoluteSeconds,policy.refreshIdleSeconds])).rows[0];
        await event(c,'login_succeeded',p.id,sessionId);
        return {patientId:p.id,sessionId,refreshToken,refreshExpiresIn:lifetime.refresh_seconds};
      });
    },
    async refresh(token: string) {
      const id=secretId(token);if(!id)return null;
      const lookup=(await db.query<{patient_id:string}>('SELECT patient_id FROM public.patient_auth_sessions WHERE id=$1',[id])).rows[0];
      if(!lookup)return null;
      return transaction(db,async c=>{
        const p=await account(c,lookup.patient_id);
        if(!eligible(p))return null;
        const session=(await c.query<{refresh_hash:string;security_version:string}>(`SELECT refresh_hash,security_version FROM public.patient_auth_sessions
          WHERE id=$1 AND patient_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND idle_expires_at>clock_timestamp() FOR UPDATE`,[id,p.id])).rows[0];
        if(!session || session.security_version!==p.security_version)return null;
        const hash=secretHash('refresh',token);
        if(session.refresh_hash!==hash) {
          const replay=(await c.query('SELECT session_id FROM public.patient_refresh_history WHERE session_id=$1 AND token_hash=$2',[id,hash])).rows[0];
          if(replay){
            await c.query('UPDATE public.patient_auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[id]);
            await event(c,'refresh_replay',p.id,id);
          }
          // Return after COMMIT: throwing inside would roll back replay revocation.
          return null;
        }
        const refreshToken=secret(id);
        await c.query('INSERT INTO public.patient_refresh_history(session_id,token_hash) VALUES($1,$2)',[id,hash]);
        const lifetime=(await c.query<{refresh_seconds:number}>(`UPDATE public.patient_auth_sessions SET refresh_hash=$2,
          idle_expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 second') WHERE id=$1
          RETURNING GREATEST(0,FLOOR(EXTRACT(EPOCH FROM LEAST(expires_at,idle_expires_at)-clock_timestamp())))::int AS refresh_seconds`,[id,secretHash('refresh',refreshToken),policy.refreshIdleSeconds])).rows[0];
        await event(c,'refresh_rotated',p.id,id);
        return {patientId:p.id,sessionId:id,refreshToken,refreshExpiresIn:lifetime.refresh_seconds};
      });
    },
    async authorize(identity: SessionIdentity) {
      return !!(await db.query(`SELECT s.id FROM public.patient_auth_sessions s JOIN public.patients p ON p.id=s.patient_id
        WHERE s.id=$1 AND s.patient_id=$2 AND p.account_status='active' AND p.email_verified_at IS NOT NULL
        AND s.security_version=p.security_version AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()`,[identity.sessionId,identity.patientId])).rows[0];
    },
    async logout(identity: SessionIdentity) {
      await transaction(db,async c=>{
        await account(c,identity.patientId);
        await c.query('UPDATE public.patient_auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND patient_id=$2',[identity.sessionId,identity.patientId]);
        await event(c,'session_revoked',identity.patientId,identity.sessionId);
      });
    },
    async changePassword(identity: SessionIdentity, expectedHash: string, replacement: string) {
      return transaction(db,async c=>{
        const p=await account(c,identity.patientId);
        if(!eligible(p)||p.password_hash!==expectedHash)return false;
        const valid=(await c.query(`SELECT id FROM public.patient_auth_sessions WHERE id=$1 AND patient_id=$2
          AND security_version=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND idle_expires_at>clock_timestamp() FOR UPDATE`,[identity.sessionId,p.id,p.security_version])).rows[0];
        if(!valid)return false;
        await c.query('UPDATE public.patients SET password_hash=$2 WHERE id=$1',[p.id,replacement]);
        await c.query('UPDATE public.patient_auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE patient_id=$1',[p.id]);
        await c.query('UPDATE public.patient_auth_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE patient_id=$1',[p.id]);
        await event(c,'password_changed',p.id,identity.sessionId);
        return true;
      });
    },
  };
}
export const rateHash = (key: Uint8Array, scope: string, value: string) => createHmac('sha256',key).update(scope+'\0'+value).digest('hex');

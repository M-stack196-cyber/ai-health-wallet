import { randomUUID } from "node:crypto";
import type { PatientDatabase } from "../patients/repository.js";
import { transaction } from "../auth/security-repository.js";

export type AdminRole = "support_admin" | "operations_admin" | "config_admin";
export const adminRoles: readonly AdminRole[] = ["support_admin", "operations_admin", "config_admin"];

/** Verified, current admin identity for one request. Never built from token claims alone. */
export interface AdminContext {
  readonly adminId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: AdminRole;
  readonly permissions: readonly string[];
}
export interface AdminAuditInput {
  actorAdminId?: string; actorRole?: string; action: string; targetType: string; targetId?: string;
  scope?: Record<string, unknown>; outcome: "success" | "denied" | "failure"; requestId: string;
}
interface AdminRow {
  id: string; email: string; full_name: string; role_name: AdminRole; permissions: string[];
}
interface CredentialRow { id: string; password_hash: string; status: string; role_name: AdminRole; }

/** Time, sequence and hashes are assigned by the database; callers supply only descriptive fields. */
export async function writeAdminAudit(db: Pick<PatientDatabase, "query">, event: AdminAuditInput): Promise<void> {
  await db.query(`INSERT INTO public.admin_audit_events(actor_admin_id,actor_role,action,target_type,target_id,scope,outcome,request_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
  [event.actorAdminId ?? null, event.actorRole ?? null, event.action, event.targetType, event.targetId ?? null,
    JSON.stringify(event.scope ?? {}), event.outcome, event.requestId]);
}

export function createAdminRepository(db: PatientDatabase) {
  return {
    async rate(key: string, maximum: number, windowSeconds: number): Promise<boolean> {
      const row = (await db.query<{ attempts: number }>(`INSERT INTO public.admin_auth_rate_limits AS r(bucket_hash,window_started_at,attempts)
        VALUES($1,clock_timestamp(),1) ON CONFLICT(bucket_hash) DO UPDATE SET
        attempts=CASE WHEN r.window_started_at <= clock_timestamp()-$3*interval '1 second' THEN 1 ELSE LEAST(r.attempts+1,$2+1) END,
        window_started_at=CASE WHEN r.window_started_at <= clock_timestamp()-$3*interval '1 second' THEN clock_timestamp() ELSE r.window_started_at END
        RETURNING attempts`, [key, maximum, windowSeconds])).rows[0];
      return row.attempts <= maximum;
    },
    async credentials(email: string): Promise<CredentialRow | undefined> {
      return (await db.query<CredentialRow>("SELECT id,password_hash,status,role_name FROM public.admin_accounts WHERE email=$1", [email])).rows[0];
    },
    async deniedLogin(account: CredentialRow, requestId: string): Promise<void> {
      await writeAdminAudit(db, { actorAdminId: account.id, actorRole: account.role_name, action: "admin.auth.login",
        targetType: "admin_account", targetId: account.id, outcome: "denied", requestId });
    },
    /** Session creation and its audit event commit together; the password hash must still be the verified one.
     * The API role cannot lock account rows (no UPDATE privilege); a concurrent credential change instead leaves
     * this session with a stale security_version, which `authorize` rejects. */
    async login(account: CredentialRow, lifetimeSeconds: number, requestId: string) {
      return transaction(db, async c => {
        const row = (await c.query<{ id: string; role_name: AdminRole; security_version: string }>(
          "SELECT id,role_name,security_version FROM public.admin_accounts WHERE id=$1 AND status='active' AND password_hash=$2",
          [account.id, account.password_hash])).rows[0];
        if (!row) return null;
        const sessionId = randomUUID();
        await c.query(`INSERT INTO public.admin_sessions(id,admin_id,security_version,expires_at)
          VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 second')`, [sessionId, row.id, row.security_version, lifetimeSeconds]);
        await writeAdminAudit(c, { actorAdminId: row.id, actorRole: row.role_name, action: "admin.auth.login",
          targetType: "admin_session", targetId: sessionId, outcome: "success", requestId });
        return { adminId: row.id, sessionId };
      });
    },
    /** Current session, active account and security version are checked on every request. */
    async authorize(identity: { adminId: string; sessionId: string }, requestId: string): Promise<AdminContext | undefined> {
      const row = (await db.query<AdminRow>(`SELECT a.id,a.email,a.full_name,a.role_name,
        COALESCE((SELECT array_agg(p.permission ORDER BY p.permission) FROM public.admin_role_permissions p WHERE p.role_name=a.role_name),'{}') AS permissions
        FROM public.admin_sessions s JOIN public.admin_accounts a ON a.id=s.admin_id
        WHERE s.id=$2 AND s.admin_id=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND a.status='active' AND s.security_version=a.security_version`, [identity.adminId, identity.sessionId])).rows[0];
      if (!row) return undefined;
      return Object.freeze({ adminId: row.id, sessionId: identity.sessionId, requestId, email: row.email, fullName: row.full_name,
        role: row.role_name, permissions: Object.freeze([...row.permissions]) });
    },
    async audit(event: AdminAuditInput): Promise<void> { await writeAdminAudit(db, event); },
  };
}

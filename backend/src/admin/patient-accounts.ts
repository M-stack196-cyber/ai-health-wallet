import type { PatientDatabase } from "../patients/repository.js";
import { transaction } from "../auth/security-repository.js";
import { writeAdminAudit, type AdminContext } from "./repository.js";
import { cursorTime, decodeCursor, encodeCursor, invalid, parseLimit, uuid } from "./paging.js";

export const patientStatuses = ["unverified", "active", "suspended", "deletion_pending", "deletion_restricted", "deleted", "revoked"] as const;
export type PatientStatus = (typeof patientStatuses)[number];
export type StatusAction = "suspend" | "reactivate";

/** The only patient fields an admin ever sees: identity and status, never profile, guardian or medical fields. */
export interface AdminPatientAccount {
  id: string; email: string; full_name: string; account_status: PatientStatus; email_verified: boolean;
  email_verified_at: Date | null; created_at: Date; updated_at: Date;
}
export interface PatientListQuery { q?: string; status?: PatientStatus; verified?: boolean; limit: number; cursor?: { createdAt: string; id: string }; }

const columns = `id,email,full_name,account_status,email_verified_at IS NOT NULL AS email_verified,email_verified_at,created_at,updated_at`;

export function patientIdParameter(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
/** Strict allowlist: unknown, repeated or malformed query parameters are rejected rather than ignored. */
export function validatePatientListQuery(query: Record<string, unknown>): PatientListQuery {
  const allowed = ["q", "status", "verified", "limit", "cursor"];
  if (Object.keys(query).some(key => !allowed.includes(key) || typeof query[key] !== "string")) throw invalid();
  const result: PatientListQuery = { limit: 25 };
  if (query.q !== undefined) {
    const q = (query.q as string).trim();
    if (q.length < 2 || q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) throw invalid();
    result.q = q;
  }
  if (query.status !== undefined) {
    if (!(patientStatuses as readonly string[]).includes(query.status as string)) throw invalid();
    result.status = query.status as PatientStatus;
  }
  if (query.verified !== undefined) {
    if (query.verified !== "true" && query.verified !== "false") throw invalid();
    result.verified = query.verified === "true";
  }
  if (query.limit !== undefined) {
    result.limit = parseLimit(query.limit as string);
  }
  if (query.cursor !== undefined) result.cursor = decodeCursor(query.cursor as string);
  return result;
}
const transitions: Record<StatusAction, { from: PatientStatus; to: PatientStatus }> = {
  suspend: { from: "active", to: "suspended" },
  reactivate: { from: "suspended", to: "active" },
};

export function createAdminPatientAccounts(db: PatientDatabase) {
  return {
    async list(query: PatientListQuery) {
      const values: unknown[] = [], where: string[] = [];
      const add = (value: unknown) => { values.push(value); return "$" + values.length; };
      if (query.q) {
        // LIKE wildcards typed by the admin are matched literally.
        const pattern = "%" + query.q.replace(/[\\%_]/g, "\\$&") + "%";
        const p = add(pattern);
        where.push(`(email ILIKE ${p} ESCAPE '\\' OR full_name ILIKE ${p} ESCAPE '\\')`);
      }
      if (query.status) where.push("account_status=" + add(query.status));
      if (query.verified !== undefined) where.push(query.verified ? "email_verified_at IS NOT NULL" : "email_verified_at IS NULL");
      if (query.cursor) where.push(`(created_at,id)<(${add(query.cursor.createdAt)}::timestamptz,${add(query.cursor.id)}::uuid)`);
      const rows = (await db.query<AdminPatientAccount & { cursor_at: string }>(
        `SELECT ${columns},${cursorTime("created_at")} AS cursor_at
         FROM public.patients ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC,id DESC LIMIT ${add(query.limit + 1)}`, values)).rows;
      const page = rows.slice(0, query.limit);
      return { patients: page.map(({ cursor_at: _unused, ...patient }) => patient), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1].cursor_at, page[page.length - 1].id) : null };
    },
    async get(id: string): Promise<AdminPatientAccount | undefined> {
      return (await db.query<AdminPatientAccount>(`SELECT ${columns} FROM public.patients WHERE id=$1`, [id])).rows[0];
    },
    /** Status change, patient session revocation and the audit row commit or roll back together.
     * Only account_status is written to patients; profile and medical data are never touched. */
    async changeStatus(admin: AdminContext, patientId: string, action: StatusAction) {
      const { from, to } = transitions[action], auditAction = "admin.patients." + action;
      const base = { actorAdminId: admin.adminId, actorRole: admin.role, action: auditAction, targetType: "patient_account", targetId: patientId, requestId: admin.requestId };
      return transaction(db, async c => {
        const patient = (await c.query<{ account_status: PatientStatus; email_verified_at: Date | null }>(
          "SELECT account_status,email_verified_at FROM public.patients WHERE id=$1 FOR UPDATE", [patientId])).rows[0];
        if (!patient) {
          await writeAdminAudit(c, { ...base, scope: { reason: "not_found" }, outcome: "failure" });
          return { outcome: "not_found" as const };
        }
        if (patient.account_status !== from || (to === "active" && patient.email_verified_at === null)) {
          await writeAdminAudit(c, { ...base, scope: { from: patient.account_status, requested: to, reason: "state_conflict" }, outcome: "failure" });
          return { outcome: "conflict" as const, current: patient.account_status };
        }
        // The existing security trigger also bumps security_version, which ends access tokens, doctor shares and guardian eligibility.
        await c.query("UPDATE public.patients SET account_status=$2 WHERE id=$1", [patientId, to]);
        let sessionsRevoked = 0;
        if (action === "suspend") {
          sessionsRevoked = (await c.query<{ n: number }>(`WITH revoked AS (UPDATE public.patient_auth_sessions SET revoked_at=clock_timestamp()
            WHERE patient_id=$1 AND revoked_at IS NULL RETURNING id), logged AS (INSERT INTO public.patient_security_events(patient_id,session_id,event)
            SELECT $1,id,'session_revoked' FROM revoked RETURNING 1) SELECT count(*)::int AS n FROM revoked`, [patientId])).rows[0].n;
        }
        await writeAdminAudit(c, { ...base, scope: { from, to, sessions_revoked: sessionsRevoked }, outcome: "success" });
        return { outcome: "changed" as const, sessionsRevoked };
      });
    },
  };
}

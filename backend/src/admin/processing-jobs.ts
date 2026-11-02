import type { PatientDatabase } from "../patients/repository.js";
import { transaction } from "../auth/security-repository.js";
import { createPatientProcessingRepository } from "../processing/api-repository.js";
import { writeAdminAudit, type AdminContext } from "./repository.js";
import { cursorTime, decodeCursor, encodeCursor, invalid, parseLimit, uuid } from "./paging.js";

export const jobStates = ["pending", "running", "retry_wait", "completed", "failed", "cancelled"] as const;
export const jobErrorCodes = ["PROCESSOR_FAILED", "PROCESSOR_TIMEOUT", "INTERRUPTED", "INVALID_INPUT", "LEASE_EXPIRED"] as const;
export type JobState = (typeof jobStates)[number];
export type JobErrorCode = (typeof jobErrorCodes)[number];

/** Reads run as the API database role, so the existing row-level security applies: only jobs of currently accessible documents
 * (active document, active verified patient) are visible. Jobs of suspended, deleted or restricted accounts are not.
 * Job metadata only. File names, hospital, category, storage keys, OCR text, summaries and lease tokens are never selected. */
export interface AdminProcessingJob {
  document_id: string; patient_id: string; state: JobState; attempt_count: number; max_attempts: number; last_error_code: JobErrorCode | null;
  next_attempt_at: Date; created_at: Date; updated_at: Date; started_at: Date | null; finished_at: Date | null; lease_active: boolean; lease_expired: boolean;
}
export interface JobListQuery { state?: JobState; errorCode?: JobErrorCode; patientId?: string; limit: number; cursor?: { createdAt: string; id: string }; }

const columns = `document_id,patient_id,state,attempt_count,max_attempts,last_error_code,next_attempt_at,created_at,updated_at,started_at,finished_at,
  (state='running' AND lease_expires_at>clock_timestamp()) AS lease_active,(state='running' AND lease_expires_at<=clock_timestamp()) AS lease_expired`;

export function jobIdParameter(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
/** Strict allowlist: unknown, repeated or malformed query parameters are rejected rather than ignored. */
export function validateJobListQuery(query: Record<string, unknown>): JobListQuery {
  if (Object.keys(query).some(key => !["state", "error_code", "patient_id", "limit", "cursor"].includes(key) || typeof query[key] !== "string")) throw invalid();
  const result: JobListQuery = { limit: 25 };
  if (query.state !== undefined) {
    if (!(jobStates as readonly string[]).includes(query.state as string)) throw invalid();
    result.state = query.state as JobState;
  }
  if (query.error_code !== undefined) {
    if (!(jobErrorCodes as readonly string[]).includes(query.error_code as string)) throw invalid();
    result.errorCode = query.error_code as JobErrorCode;
  }
  if (query.patient_id !== undefined) {
    if (!uuid.test(query.patient_id as string)) throw invalid();
    result.patientId = (query.patient_id as string).toLowerCase();
  }
  if (query.limit !== undefined) result.limit = parseLimit(query.limit as string);
  if (query.cursor !== undefined) result.cursor = decodeCursor(query.cursor as string);
  return result;
}

export function createAdminProcessingJobs(db: PatientDatabase) {
  return {
    async list(query: JobListQuery) {
      const values: unknown[] = [], where: string[] = [];
      const add = (value: unknown) => { values.push(value); return "$" + values.length; };
      if (query.state) where.push("state=" + add(query.state));
      if (query.errorCode) where.push("last_error_code=" + add(query.errorCode));
      if (query.patientId) where.push("patient_id=" + add(query.patientId) + "::uuid");
      if (query.cursor) where.push(`(updated_at,document_id)<(${add(query.cursor.createdAt)}::timestamptz,${add(query.cursor.id)}::uuid)`);
      const rows = (await db.query<AdminProcessingJob & { cursor_at: string }>(
        `SELECT ${columns},${cursorTime("updated_at")} AS cursor_at FROM public.document_processing_jobs ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY updated_at DESC,document_id DESC LIMIT ${add(query.limit + 1)}`, values)).rows;
      const page = rows.slice(0, query.limit);
      return { jobs: page.map(({ cursor_at: _unused, ...job }) => job), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1].cursor_at, page[page.length - 1].document_id) : null };
    },
    async get(documentId: string): Promise<AdminProcessingJob | undefined> {
      return (await db.query<AdminProcessingJob>(`SELECT ${columns} FROM public.document_processing_jobs WHERE document_id=$1`, [documentId])).rows[0];
    },
    /** Counts only: every state, failures by reason code, and running jobs whose lease has already expired. */
    async summary() {
      const rows = (await db.query<{ state: JobState; code: JobErrorCode | null; expired: boolean; n: number }>(
        `SELECT state,last_error_code AS code,(state='running' AND lease_expires_at<=clock_timestamp()) AS expired,count(*)::int AS n
         FROM public.document_processing_jobs GROUP BY 1,2,3`, [])).rows;
      const byState = Object.fromEntries(jobStates.map(state => [state, 0])) as Record<JobState, number>;
      const failures = Object.fromEntries(jobErrorCodes.map(code => [code, 0])) as Record<JobErrorCode, number>;
      let expiredLeases = 0;
      for (const row of rows) {
        byState[row.state] += row.n;
        if (row.code && (row.state === "failed" || row.state === "retry_wait")) failures[row.code] += row.n;
        if (row.expired) expiredLeases += row.n;
      }
      return { by_state: byState, failures_by_error_code: failures, running_with_expired_lease: expiredLeases, total: Object.values(byState).reduce((a, b) => a + b, 0) };
    },
    /** Calls the existing owner-fenced retry statement unchanged, on the same connection that writes the audit row.
     * The job's own patient id is passed, so ownership, the integrity contract, attempt limits, error-code
     * eligibility and lease clearing are exactly the patient-path rules; an admin cannot reset attempts or edit a lease. */
    async retry(admin: AdminContext, documentId: string) {
      const base = { actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.processing.retry", targetType: "processing_job", targetId: documentId, requestId: admin.requestId };
      return transaction(db, async c => {
        const job = (await c.query<{ patient_id: string; state: JobState; attempt_count: number; max_attempts: number; last_error_code: JobErrorCode | null }>(
          "SELECT patient_id,state,attempt_count,max_attempts,last_error_code FROM public.document_processing_jobs WHERE document_id=$1", [documentId])).rows[0];
        if (!job) {
          await writeAdminAudit(c, { ...base, scope: { reason: "not_found" }, outcome: "failure" });
          return { outcome: "not_found" as const };
        }
        if (!await createPatientProcessingRepository(c, { documentOwner: true }).retry(documentId, job.patient_id)) {
          await writeAdminAudit(c, { ...base, scope: { reason: "not_retryable", state: job.state, error_code: job.last_error_code, attempts: job.attempt_count, max_attempts: job.max_attempts }, outcome: "failure" });
          return { outcome: "not_retryable" as const };
        }
        await writeAdminAudit(c, { ...base, scope: { from: job.state, to: "retry_wait", error_code: job.last_error_code, attempts: job.attempt_count, max_attempts: job.max_attempts }, outcome: "success" });
        return { outcome: "retried" as const };
      });
    },
  };
}

import type { PatientDatabase } from "../patients/repository.js";
import { cursorTime, encodeCursor, invalid, oneOf, parseListQuery, uuid, uuidValue } from "./paging.js";

export const guardianStatuses = ["PENDING", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export const shareStatuses = ["active", "expired", "revoked"] as const;
export const shareMethods = ["qr_code", "unique_link"] as const;
export const deliveryChannels = ["security_email", "guardian_notification"] as const;
export const emailPurposes = ["verify_email", "reset_password", "guardian_invitation", "doctor_share_otp"] as const;
export const deliveryStates = ["pending", "sending", "running", "retry_wait", "transient_failed", "permanent_failed", "delivered", "expired", "superseded", "cancelled"] as const;

export function statusIdParameter(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
export const guardianQuery = (query: Record<string, unknown>) => parseListQuery(query, { status: oneOf(guardianStatuses), patient_id: uuidValue });
export const shareQuery = (query: Record<string, unknown>) => parseListQuery(query, { status: oneOf(shareStatuses), method: oneOf(shareMethods), patient_id: uuidValue });
export const deliveryQuery = (query: Record<string, unknown>) =>
  parseListQuery(query, { channel: oneOf(deliveryChannels), state: oneOf(deliveryStates), purpose: oneOf(emailPurposes), patient_id: uuidValue });
type Parsed = { filters: Record<string, string | undefined>; limit: number; cursor?: { createdAt: string; id: string } };

/** Builds `WHERE col = $n` clauses for the supplied filters and the newest-first keyset condition. */
function clauses(parsed: Parsed, columns: Record<string, string>, values: unknown[]) {
  const add = (value: unknown) => { values.push(value); return "$" + values.length; };
  const where = Object.entries(columns).filter(([key]) => parsed.filters[key] !== undefined).map(([key, column]) => `${column}=${add(parsed.filters[key])}${key === "patient_id" ? "::uuid" : ""}`);
  if (parsed.cursor) where.push(`(created_at,id)<(${add(parsed.cursor.createdAt)}::timestamptz,${add(parsed.cursor.id)}::uuid)`);
  return { where: where.length ? "WHERE " + where.join(" AND ") : "", limit: add(parsed.limit + 1) };
}
async function page<Row extends { id: string; cursor_at: string }>(db: PatientDatabase, inner: string, parsed: Parsed, columns: Record<string, string>) {
  const values: unknown[] = [], { where, limit } = clauses(parsed, columns, values);
  const rows = (await db.query<Row>(`SELECT *,${cursorTime("created_at")} AS cursor_at FROM (${inner}) x ${where} ORDER BY created_at DESC,id DESC LIMIT ${limit}`, values)).rows;
  const shown = rows.slice(0, parsed.limit);
  return { rows: shown.map(({ cursor_at: _unused, ...row }) => row), nextCursor: rows.length > parsed.limit ? encodeCursor(shown[shown.length - 1].cursor_at, shown[shown.length - 1].id) : null };
}
function counts<T extends string>(names: readonly T[], rows: { name: T; n: number }[]) {
  const result = Object.fromEntries(names.map(name => [name, 0])) as Record<T, number>;
  for (const row of rows) result[row.name] += row.n;
  return result;
}

// Explicit column lists: guardian/doctor email, token digests, OTP data, payloads, hashes and content references are never selected.
const guardianSql = `SELECT id,patient_id,status,accepted_at,revoked_at,created_at,updated_at FROM public.guardian_relationships`;
const shareSql = `SELECT g.id,g.patient_id,g.sharing_method,g.recipient_bound,
  CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS status,
  g.created_at,g.expires_at,g.revoked_at,
  (SELECT count(*)::int FROM public.doctor_share_sessions s WHERE s.grant_id=g.id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) AS active_session_count
  FROM public.doctor_sharing_grants g`;
const deliverySql = `SELECT 'security_email'::text AS channel,id,patient_id,purpose,state,attempts,NULL::int AS max_attempts,failure_category AS failure_reason,next_attempt_at,created_at,delivered_at
  FROM public.patient_security_email_deliveries
  UNION ALL SELECT 'guardian_notification'::text,id,patient_id,NULL::text,state,attempts,max_attempts,failure_code,next_attempt_at,created_at,delivered_at
  FROM public.guardian_medical_jobs`;

export function createAdminStatusViews(db: PatientDatabase) {
  return {
    guardians: {
      list: (parsed: Parsed) => page(db, guardianSql, parsed, { status: "status", patient_id: "patient_id" }),
      async get(id: string) {
        const relationship = (await db.query(`${guardianSql} WHERE id=$1`, [id])).rows[0];
        if (!relationship) return undefined;
        const events = (await db.query("SELECT event,occurred_at FROM public.guardian_lifecycle_events WHERE relationship_id=$1 ORDER BY occurred_at,id", [id])).rows;
        return { ...relationship, events };
      },
      async summary() {
        const by = counts(guardianStatuses, (await db.query<{ name: (typeof guardianStatuses)[number]; n: number }>("SELECT status AS name,count(*)::int AS n FROM public.guardian_relationships GROUP BY 1", [])).rows);
        return { by_status: by, total: Object.values(by).reduce((a, b) => a + b, 0) };
      },
    },
    shares: {
      list: (parsed: Parsed) => page(db, shareSql, parsed, { status: "status", method: "sharing_method", patient_id: "patient_id" }),
      async get(id: string) {
        const grant = (await db.query(`SELECT * FROM (${shareSql}) x WHERE id=$1`, [id])).rows[0];
        if (!grant) return undefined;
        const events = (await db.query<{ event: string; n: number; last_at: Date }>("SELECT event,count(*)::int AS n,max(occurred_at) AS last_at FROM public.doctor_share_events WHERE grant_id=$1 GROUP BY 1", [id])).rows;
        return { ...grant, event_counts: Object.fromEntries(events.map(row => [row.event, row.n])), last_event_at: events.length ? new Date(Math.max(...events.map(row => row.last_at.getTime()))) : null };
      },
      async summary() {
        const rows = (await db.query<{ status: (typeof shareStatuses)[number]; method: (typeof shareMethods)[number]; n: number }>(`SELECT status,sharing_method AS method,count(*)::int AS n FROM (${shareSql}) x GROUP BY 1,2`, [])).rows;
        const by = counts(shareStatuses, rows.map(row => ({ name: row.status, n: row.n }))), method = counts(shareMethods, rows.map(row => ({ name: row.method, n: row.n })));
        return { by_status: by, by_method: method, total: Object.values(by).reduce((a, b) => a + b, 0) };
      },
    },
    deliveries: {
      list: (parsed: Parsed) => page(db, deliverySql, parsed, { channel: "channel", state: "state", purpose: "purpose", patient_id: "patient_id" }),
      async summary() {
        const rows = (await db.query<{ channel: (typeof deliveryChannels)[number]; state: (typeof deliveryStates)[number]; n: number }>(`SELECT channel,state,count(*)::int AS n FROM (${deliverySql}) x GROUP BY 1,2`, [])).rows;
        const result = Object.fromEntries(deliveryChannels.map(channel => [channel, counts(deliveryStates, rows.filter(row => row.channel === channel).map(row => ({ name: row.state, n: row.n })))])) as Record<(typeof deliveryChannels)[number], Record<(typeof deliveryStates)[number], number>>;
        return { by_channel: result, total: rows.reduce((a, row) => a + row.n, 0) };
      },
    },
  };
}

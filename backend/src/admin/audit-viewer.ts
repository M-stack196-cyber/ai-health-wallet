import type { PatientDatabase } from "../patients/repository.js";
import { cursorTime, invalid, oneOf, parseLimit, uuid, uuidValue } from "./paging.js";

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
export const auditOutcomes = ["success", "denied", "failure"] as const;
const timeValue = (value: string): string => {
  if (!instant.test(value) || Number.isNaN(Date.parse(value))) throw invalid();
  return value;
};
const exact = (pattern: RegExp) => (value: string): string => { if (!pattern.test(value)) throw invalid(); return value; };

export interface AuditQuery {
  filters: { actor_admin_id?: string; action?: string; target_type?: string; outcome?: string; from?: string; to?: string };
  limit: number; cursor?: number;
}
/** Strict allowlist. Values are matched exactly; there is no free-text search, so there is nothing to store about a search. */
export function validateAuditQuery(query: Record<string, unknown>): AuditQuery {
  const checks: Record<string, (value: string) => string> = {
    actor_admin_id: uuidValue, action: exact(/^[a-z]+(\.[a-z_]+){1,3}$/), target_type: exact(/^[a-z_]{1,40}$/), outcome: oneOf(auditOutcomes), from: timeValue, to: timeValue,
  };
  if (Object.keys(query).some(key => key !== "limit" && key !== "cursor" && !(key in checks) || typeof query[key] !== "string")) throw invalid();
  const filters: AuditQuery["filters"] = {};
  for (const key of Object.keys(checks)) if (query[key] !== undefined) (filters as Record<string, string>)[key] = checks[key](query[key] as string);
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) throw invalid();
  let cursor: number | undefined;
  if (query.cursor !== undefined) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor as string, "base64url").toString("utf8")) as { s?: unknown };
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(query.cursor as string) || !Number.isSafeInteger(parsed.s) || (parsed.s as number) < 1) throw invalid();
      cursor = parsed.s as number;
    } catch { throw invalid(); }
  }
  return { filters, limit: query.limit === undefined ? 25 : parseLimit(query.limit as string), cursor };
}
const encodeCursor = (seq: number) => Buffer.from(JSON.stringify({ s: seq })).toString("base64url");

// Defence in depth: audit scopes are written by this code and hold no secrets, but a viewer must never be the place one escapes.
const secretLike = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /\b[a-f0-9]{32,}\b/i, /\bBearer\s+\S+/i, /[^\s@]+@[^\s@]+\.[^\s@]+/, /\$argon2/i, /[A-Za-z0-9+/_-]{40,}={0,2}/, /\bds1\./];
const secretKey = /secret|token|password|passphrase|credential|authorization|cookie|otp|digest|hash|api_?key|private/i;
export function safeScope(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 120 || secretLike.some(pattern => pattern.test(value)) ? "[redacted]" : value;
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeScope(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key, secretKey.test(key) ? "[redacted]" : safeScope(item, depth + 1)]));
  return "[redacted]";
}

interface Row { seq: string; id: string; occurred_at: string; actor_admin_id: string | null; actor_role: string | null; action: string; target_type: string; target_id: string | null; scope: unknown; outcome: string; request_id: string; event_hash: string; }
export function createAdminAuditViewer(db: PatientDatabase) {
  return {
    async search(parsed: AuditQuery) {
      const values: unknown[] = [], where: string[] = [], add = (value: unknown) => { values.push(value); return "$" + values.length; };
      const f = parsed.filters;
      if (f.actor_admin_id) where.push("actor_admin_id=" + add(f.actor_admin_id) + "::uuid");
      if (f.action) where.push("action=" + add(f.action));
      if (f.target_type) where.push("target_type=" + add(f.target_type));
      if (f.outcome) where.push("outcome=" + add(f.outcome));
      if (f.from) where.push("occurred_at>=" + add(f.from) + "::timestamptz");
      if (f.to) where.push("occurred_at<=" + add(f.to) + "::timestamptz");
      if (parsed.cursor !== undefined) where.push("seq<" + add(parsed.cursor));
      const rows = (await db.query<Row>(`SELECT seq,id,${cursorTime("occurred_at")} AS occurred_at,actor_admin_id,actor_role,action,target_type,target_id,scope,outcome,request_id,event_hash FROM public.admin_audit_events
        ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ${add(parsed.limit + 1)}`, values)).rows;
      const shown = rows.slice(0, parsed.limit);
      return { events: shown.map(row => ({ ...row, seq: Number(row.seq), scope: safeScope(row.scope) })), nextCursor: rows.length > parsed.limit ? encodeCursor(Number(shown[shown.length - 1].seq)) : null };
    },
    /** Result of the database's own hash-chain check over the whole log. */
    async chain() {
      const row = (await db.query<{ checked: string; first_invalid: string | null }>("SELECT checked,first_invalid FROM public.verify_admin_audit_chain()", [])).rows[0];
      return row.first_invalid === null ? { status: "intact" as const, events_checked: Number(row.checked), first_invalid_seq: null }
        : { status: "broken" as const, events_checked: Number(row.checked), first_invalid_seq: Number(row.first_invalid) };
    },
  };
}
void uuid;

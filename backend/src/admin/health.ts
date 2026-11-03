import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { PatientDatabase } from "../patients/repository.js";

export type HealthStatus = "ok" | "degraded" | "down" | "unknown" | "not_configured";
/** Metrics are counts, durations and fixed reason codes only; nothing here can carry a secret, address or patient content. */
export type HealthComponent = { name: string; status: HealthStatus; reason?: string } & Record<string, string | number | boolean | null | undefined>;
export interface ServiceProbe { name: "ai_ocr" | "ai_summary" | "ai_rag"; origin?: string; token?: string; misconfigured?: boolean; }
export interface HealthOptions {
  database?: PatientDatabase; services?: ServiceProbe[]; fetch?: typeof fetch; migrationsDirectory?: URL;
  slowDatabaseMs?: number; slowServiceMs?: number; serviceTimeoutMs?: number; staleQueueSeconds?: number;
}

/** Only the origin of a configured http(s) address is kept, so credentials or paths in the configuration can never be echoed or sent elsewhere. */
export function aiServicesFromEnv(env: NodeJS.ProcessEnv): ServiceProbe[] {
  const read = (name: ServiceProbe["name"], url?: string, token?: string): ServiceProbe => {
    if (!url) return { name };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { name, misconfigured: true };
      return { name, origin: parsed.origin, token: token || undefined };
    } catch { return { name, misconfigured: true }; }
  };
  return [read("ai_ocr", env.OCR_SERVICE_URL, env.OCR_SERVICE_TOKEN), read("ai_summary", env.SUMMARY_SERVICE_URL, env.SUMMARY_SERVICE_TOKEN), read("ai_rag", env.RAG_SERVICE_URL, env.RAG_SERVICE_TOKEN)];
}

const severity: Record<HealthStatus, number> = { not_configured: 0, ok: 0, unknown: 1, degraded: 1, down: 2 };
export function overallStatus(components: HealthComponent[]): "ok" | "degraded" | "down" {
  const worst = Math.max(0, ...components.map(component => severity[component.status]));
  return worst === 2 ? "down" : worst === 1 ? "degraded" : "ok";
}
const count = (value: unknown) => Number(value ?? 0);

// The migration ledger uses the same checksum rule as the migration tool (sha256 of the file text). The tool itself is not imported
// because loading it would open the separate migration-role connection inside the API process.
async function expectedMigrations(directory: URL) {
  const names = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name => ({ version: name.slice(0, 4), name, checksum: createHash("sha256").update(await readFile(new URL(name, directory), "utf8")).digest("hex") })));
}

export function createAdminHealth(defaultDatabase: PatientDatabase, options: HealthOptions = {}) {
  const db = options.database ?? defaultDatabase, probe = options.fetch ?? fetch;
  const slowDb = options.slowDatabaseMs ?? 1000, slowService = options.slowServiceMs ?? 1500, timeout = options.serviceTimeoutMs ?? 2000, stale = options.staleQueueSeconds ?? 600;
  const directory = options.migrationsDirectory ?? new URL("../../migrations/", import.meta.url);
  const services = options.services ?? aiServicesFromEnv(process.env);
  const unknown = (name: string, reason: string): HealthComponent => ({ name, status: "unknown", reason });

  async function database(): Promise<HealthComponent> {
    const started = performance.now();
    try {
      await db.query("SELECT 1 AS ok", []);
      const latency = Math.round(performance.now() - started);
      return latency > slowDb ? { name: "database", status: "degraded", reason: "slow_response", latency_ms: latency } : { name: "database", status: "ok", latency_ms: latency };
    } catch { return { name: "database", status: "down", reason: "query_failed" }; }
  }
  async function migrations(): Promise<HealthComponent> {
    try {
      const expected = await expectedMigrations(directory);
      const history = (await db.query<{ h: { present: boolean; rows: { version: string; name: string; checksum: string }[] } }>("SELECT public.admin_migration_history() AS h", [])).rows[0].h;
      if (!history.present) return { name: "migrations", status: "unknown", reason: "ledger_not_found", expected: expected.length };
      const applied = history.rows, mismatch = applied.some((row, i) => !expected[i] || expected[i].version !== row.version || expected[i].name !== row.name || expected[i].checksum !== row.checksum);
      const base = { name: "migrations", expected: expected.length, applied: applied.length, pending: Math.max(0, expected.length - applied.length), latest_applied: applied.length ? applied[applied.length - 1].version : null };
      if (mismatch) return { ...base, status: "down", reason: "history_mismatch" };
      return applied.length < expected.length ? { ...base, status: "degraded", reason: "pending_migrations" } : { ...base, status: "ok" };
    } catch { return unknown("migrations", "check_failed"); }
  }
  async function processing(): Promise<HealthComponent> {
    try {
      const q = (await db.query<{ h: Record<string, unknown> }>("SELECT public.admin_processing_queue_health() AS h", [])).rows[0].h;
      const age = q.oldest_ready_age_seconds === null ? null : count(q.oldest_ready_age_seconds);
      const metrics = { pending: count(q.pending), running: count(q.running), retry_wait: count(q.retry_wait), failed_last_24h: count(q.failed_last_24h), expired_leases: count(q.expired_leases), oldest_ready_age_seconds: age };
      // Status reflects stuck work. Failed-job counts are reported but do not by themselves mark the queue degraded.
      if (metrics.expired_leases > 0) return { name: "processing_queue", status: "degraded", reason: "expired_leases", ...metrics };
      if (age !== null && age > stale) return { name: "processing_queue", status: "degraded", reason: "stale_ready_jobs", ...metrics };
      return { name: "processing_queue", status: "ok", ...metrics };
    } catch { return unknown("processing_queue", "check_failed"); }
  }
  async function email(): Promise<HealthComponent> {
    try {
      const r = (await db.query<Record<string, number>>(
        `SELECT
          (SELECT count(*)::int FROM public.patient_security_email_deliveries WHERE state IN ('pending','transient_failed') AND next_attempt_at < clock_timestamp()-$1*interval '1 second') AS email_overdue,
          (SELECT count(*)::int FROM public.patient_security_email_deliveries WHERE state='sending' AND claim_expires_at < clock_timestamp()) AS email_expired_claims,
          (SELECT count(*)::int FROM public.patient_security_email_deliveries WHERE state='permanent_failed' AND updated_at > clock_timestamp()-interval '24 hours') AS email_failed_last_24h,
          (SELECT count(*)::int FROM public.guardian_medical_jobs WHERE state IN ('pending','retry_wait') AND not_before <= clock_timestamp() AND next_attempt_at < clock_timestamp()-$1*interval '1 second') AS notification_overdue,
          (SELECT count(*)::int FROM public.guardian_medical_jobs WHERE state='running' AND lease_expires_at < clock_timestamp()) AS notification_expired_leases,
          (SELECT count(*)::int FROM public.guardian_medical_jobs WHERE state='permanent_failed' AND created_at > clock_timestamp()-interval '24 hours') AS notification_failed_last_24h`, [stale])).rows[0];
      // Named fields only: whatever else a row might hold is never copied into the report.
      const metrics = { email_overdue: count(r.email_overdue), email_expired_claims: count(r.email_expired_claims), email_failed_last_24h: count(r.email_failed_last_24h),
        notification_overdue: count(r.notification_overdue), notification_expired_leases: count(r.notification_expired_leases), notification_failed_last_24h: count(r.notification_failed_last_24h) };
      const stuck = metrics.email_overdue + metrics.email_expired_claims + metrics.notification_overdue + metrics.notification_expired_leases;
      return stuck > 0 ? { name: "email_queue", status: "degraded", reason: "stuck_deliveries", ...metrics } : { name: "email_queue", status: "ok", ...metrics };
    } catch { return unknown("email_queue", "check_failed"); }
  }
  async function service(target: ServiceProbe): Promise<HealthComponent> {
    if (target.misconfigured) return { name: target.name, status: "unknown", reason: "misconfigured" };
    if (!target.origin) return { name: target.name, status: "not_configured" };
    const started = performance.now();
    try {
      const response = await probe(target.origin + "/health", { method: "GET", redirect: "manual", headers: target.token ? { Authorization: "Bearer " + target.token } : {}, signal: AbortSignal.timeout(timeout) });
      await response.body?.cancel();
      const latency = Math.round(performance.now() - started);
      // 401/403 means the service is up but rejects our credentials. 404 means it is up but exposes no /health route (the summary service has none):
      // the process answers, which is all that reachability can show. Any other non-2xx answer (for example 503 not ready) is degraded.
      if (response.status === 401 || response.status === 403) return { name: target.name, status: "degraded", reason: "unauthorized", latency_ms: latency };
      if (response.status === 404) return { name: target.name, status: "ok", reason: "no_health_route", latency_ms: latency };
      if (response.status < 200 || response.status > 299) return { name: target.name, status: "degraded", reason: "unexpected_status", latency_ms: latency };
      return latency > slowService ? { name: target.name, status: "degraded", reason: "slow_response", latency_ms: latency } : { name: target.name, status: "ok", latency_ms: latency };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { name: target.name, status: "down", reason: timedOut ? "timeout" : "connection_failed" };
    }
  }
  return {
    async check() {
      const first = await database();
      // When the database cannot be queried, the checks that depend on it are reported as unknown rather than guessed.
      const dependent = first.status === "down"
        ? ["migrations", "processing_queue", "email_queue"].map(name => unknown(name, "database_unavailable"))
        : await Promise.all([migrations(), processing(), email()]);
      const remote = await Promise.all(services.map(service));
      const components = [first, ...dependent, ...remote];
      return { status: overallStatus(components), checked_at: new Date().toISOString(), components };
    },
  };
}

import { useMemo } from "react";
import { adminApi, type AdminHealthComponent, type AdminHealthStatus, type AdminSession } from "@health-wallet/api";
import { Chip, Message, when, words } from "./ui";
import { useLoaded } from "./useList";

const names: Record<string, string> = {
  database: "Database",
  migrations: "Database migrations",
  processing_queue: "Document processing queue",
  email_queue: "Email and notification queue",
  ai_ocr: "Text reading (OCR) service",
  ai_summary: "Summary service",
  ai_rag: "Question answering service",
};
const reasons: Record<string, string> = {
  slow_response: "Answers, but slowly",
  query_failed: "The database did not answer a simple query",
  ledger_not_found: "The migration record table was not found",
  history_mismatch: "Applied migrations do not match the migration files",
  pending_migrations: "Some migrations have not been applied yet",
  check_failed: "The check itself failed, so the state is not known",
  expired_leases: "Jobs are stuck: a worker stopped without finishing",
  stale_ready_jobs: "Ready jobs have been waiting too long",
  stuck_deliveries: "Some emails or notifications are overdue or stuck",
  misconfigured: "The service address in the settings is not valid",
  unauthorized: "The service is up but refused our credentials",
  no_health_route: "The service answers but has no health page, so only reachability is known",
  unexpected_status: "The service answered with an unexpected status",
  timeout: "The service did not answer in time",
  connection_failed: "Could not connect to the service",
  database_unavailable: "Not checked, because the database is not available",
};
const statusText: Record<AdminHealthStatus, string> = { ok: "OK", degraded: "Degraded", down: "Down", unknown: "Unknown", not_configured: "Not configured" };
const tone = (s: AdminHealthStatus) => (s === "ok" ? "good" : s === "degraded" ? "warn" : s === "down" ? "bad" : "neutral");
const overallText = { ok: "All checked components are working", degraded: "Something needs attention", down: "A component is down" } as const;

/** Counts and timings next to the status. Only plain numbers, booleans and short text are shown. */
const metrics = (c: AdminHealthComponent) =>
  Object.entries(c)
    .filter(([k, v]) => !["name", "status", "reason"].includes(k) && v !== null && v !== undefined && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 40)))
    .map(([k, v]) => `${words(k)}: ${typeof v === "boolean" ? (v ? "yes" : "no") : v}`);

export function Health({ client }: { client: AdminSession }) {
  const api = useMemo(() => adminApi(client), [client]);
  const report = useLoaded(async () => (await api.health()).health);
  const h = report.value;
  return (
    <div className="screen">
      <h1>System health</h1>
      <p className="muted">
        Each check shows a status and the reason. Only counts, timings and fixed reason codes appear here: no addresses, keys, error text or patient data.
      </p>
      <div className="row spread">
        <h2>Overall</h2>
        <button type="button" className="secondary" onClick={() => void report.refresh()} disabled={report.loading}>
          {report.loading ? "Checking…" : "Run checks again"}
        </button>
      </div>
      <Message notice={report.notice} />
      {h && (
        <>
          <p className="overall" aria-label="Overall health">
            <Chip tone={tone(h.status)}>{statusText[h.status]}</Chip> {overallText[h.status]}. <span className="muted">Checked {when(h.checked_at)}.</span>
          </p>
          <table className="grid" aria-label="Components">
            <thead>
              <tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Reason</th><th scope="col">Details</th></tr>
            </thead>
            <tbody>
              {h.components.map((c) => (
                <tr key={c.name}>
                  <th scope="row">{names[c.name] ?? words(c.name)}</th>
                  <td><Chip tone={tone(c.status)}>{statusText[c.status] ?? words(c.status)}</Chip></td>
                  <td>{c.reason ? (reasons[c.reason] ?? words(c.reason)) : c.status === "not_configured" ? "No address is set for this service" : "—"}</td>
                  <td className="small">{metrics(c).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {!h && report.loading && <p className="muted" role="status">Checking…</p>}
    </div>
  );
}

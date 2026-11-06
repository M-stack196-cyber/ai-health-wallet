import { scanAccessibility } from "./a11y.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { chromium, expect, type Page } from "@playwright/test";
let browser: Awaited<ReturnType<typeof chromium.launch>>,
  vite: ReturnType<typeof spawn>;
let origin = "";
const ADMIN = { email: "admin@example.invalid", password: "Synthetic admin passphrase 731!" };
const TOKEN = "admin.synthetic-only";
// The first 8 characters (what the screens show as a short label) are unique per row.
const id = (n: number, kind = 1) =>
  `${String(n).padStart(4, "0")}${String(kind).repeat(4)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Fields the backend must never send. The fixtures add them anyway, to prove the screens do not render anything they were not designed to show.
const LEAKS = {
  original_filename: "LEAK-report.pdf",
  extracted_text: "LEAK extracted OCR text",
  summary_text: "LEAK summary text",
  hospital_name: "LEAK Hospital",
  date_of_birth: "1980-01-01",
  phone_number: "+1555LEAK",
  lease_token: "LEAK-lease-token",
};
type Patient = {
  id: string; email: string; full_name: string; account_status: string; email_verified: boolean;
  email_verified_at: string | null; created_at: string; updated_at: string;
};
type Job = {
  document_id: string; patient_id: string; state: string; attempt_count: number; max_attempts: number;
  last_error_code: string | null; next_attempt_at: string; created_at: string; updated_at: string;
  started_at: string | null; finished_at: string | null; lease_active: boolean; lease_expired: boolean;
};
function fixtures() {
  const names = ["Amara Okafor", "Bilal Raza", "Chen Wei", "Dana Whitfield", "Elif Demir", "Farid Nasser", "Grace Liu", "Hugo Martin", "Ines Costa", "Jonas Berg", "Kavya Rao", "Lena Fischer", "Mateo Ruiz"];
  const patients: Patient[] = names.map((full_name, i) => ({
    id: id(i + 1),
    email: full_name.split(" ")[0].toLowerCase() + "@example.invalid",
    full_name,
    account_status: i === 2 ? "suspended" : i === 4 ? "unverified" : i === 11 ? "deleted" : "active",
    email_verified: i !== 4,
    email_verified_at: i === 4 ? null : "2026-01-02T10:00:00.000Z",
    created_at: new Date(Date.UTC(2026, 0, 20 - i, 9, 30)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 21 - i, 9, 30)).toISOString(),
  }));
  const states: [string, string | null, number][] = [
    ["failed", "PROCESSOR_FAILED", 1], ["failed", "INVALID_INPUT", 2], ["running", null, 1], ["pending", null, 0], ["completed", null, 1],
    ["retry_wait", "PROCESSOR_TIMEOUT", 1], ["failed", "PROCESSOR_TIMEOUT", 3], ["completed", null, 1], ["pending", null, 0], ["failed", "LEASE_EXPIRED", 1],
    ["running", null, 1], ["completed", null, 1],
  ];
  const jobs: Job[] = states.map(([state, code, attempts], i) => ({
    document_id: id(i + 1, 2),
    patient_id: patients[i % 3].id,
    state, attempt_count: attempts, max_attempts: 3, last_error_code: code,
    next_attempt_at: "2026-02-01T10:00:00.000Z",
    created_at: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 1, 1, 12 - Math.floor(i / 2), 59 - i)).toISOString(),
    started_at: attempts ? "2026-02-01T08:05:00.000Z" : null,
    finished_at: state === "failed" || state === "completed" ? "2026-02-01T08:09:00.000Z" : null,
    lease_active: false, lease_expired: state === "running" && i === 10,
  }));
  return { patients, jobs };
}

// ---------- Phase 9 fixtures: status views, settings, rules, health, audit ----------
const ME = "00a00000-0000-4000-8000-0000000000a1", OTHER = "00b00000-0000-4000-8000-0000000000b2";
const ALL_PERMISSIONS = [
  "admin.profile.read", "admin.patients.read", "admin.patients.suspend", "admin.patients.reactivate", "admin.processing.read", "admin.processing.retry",
  "admin.guardians.read", "admin.shares.read", "admin.deliveries.read", "admin.settings.read", "admin.settings.change", "admin.settings.approve",
  "admin.rules.read", "admin.rules.create", "admin.health.read", "admin.audit.read",
];
const gate16 = { cfg: "CFG-16", requirement: "Security review and negative-path tests required before release." };
const gate04 = { cfg: "CFG-04", requirement: "Security-review and negative testing." };
const REGISTRY = [
  { key: "guardian.digest_window_hours", unit: "hours", min: 1, max: 168, default: 24, source: "CFG-15", gate: null },
  { key: "documents.max_upload_bytes", unit: "bytes", min: 1024, max: 20971520, default: 5242880, source: "CFG-03", gate: null },
  { key: "documents.max_concurrent_uploads", unit: "uploads", min: 1, max: 4, default: 2, source: "CFG-03", gate: null },
  { key: "documents.upload_rate_limit_max", unit: "requests", min: 1, max: 100, default: 20, source: "CFG-03", gate: null },
  { key: "documents.max_pdf_pages", unit: "pages", min: 1, max: 200, default: 100, source: "CFG-03", gate: null },
  { key: "auth.access_token_seconds", unit: "seconds", min: 60, max: 3600, default: 900, source: "CFG-16", gate: gate16 },
  { key: "auth.verification_seconds", unit: "seconds", min: 60, max: 86400, default: 86400, source: "CFG-16", gate: gate16 },
  { key: "auth.reset_seconds", unit: "seconds", min: 60, max: 1800, default: 900, source: "CFG-16", gate: gate16 },
  { key: "auth.refresh_idle_seconds", unit: "seconds", min: 60, max: 604800, default: 604800, source: "CFG-16", gate: gate16 },
  { key: "auth.refresh_absolute_seconds", unit: "seconds", min: 300, max: 2592000, default: 2592000, source: "CFG-16", gate: gate16 },
  { key: "sharing.otp_seconds", unit: "seconds", min: 1, max: 1800, default: 600, source: "CFG-04", gate: gate04 },
];
type SettingVersion = { version: number; value: number; requires_approval: boolean; gate: string | null; proposed_by: string; proposed_at: string; decision: null | { decision: string; decided_by: string; reference: string; decided_at: string } };
function extraFixtures(patients: Patient[]) {
  const at = (day: number, h = 9, m = 0) => new Date(Date.UTC(2026, 1, day, h, m)).toISOString();
  const gStatus = ["ACTIVE", "PENDING", "REVOKED", "EXPIRED"];
  const guardians = Array.from({ length: 12 }, (_, i) => ({
    id: id(i + 1, 3), patient_id: patients[i % 4].id, status: gStatus[i % 4],
    accepted_at: i % 4 === 0 || i % 4 === 2 ? at(2, 10) : null, revoked_at: i % 4 === 2 ? at(5, 8) : null, created_at: at(1, 12 - Math.floor(i / 2), 59 - i), updated_at: at(6),
  }));
  const guardianEvents = (gid: string) => [{ event: "invited", occurred_at: at(1) }, ...(guardians.find((g) => g.id === gid)?.status === "ACTIVE" ? [{ event: "accepted", occurred_at: at(2, 10) }] : [])];
  const shares = Array.from({ length: 12 }, (_, i) => ({
    id: id(i + 1, 4), patient_id: patients[i % 3].id, sharing_method: i % 3 === 0 ? "qr_code" : "unique_link", recipient_bound: i % 2 === 0,
    status: i % 4 === 0 ? "revoked" : i % 4 === 1 ? "expired" : "active", created_at: at(1, 12 - Math.floor(i / 2), 59 - i), expires_at: at(9),
    revoked_at: i % 4 === 0 ? at(3) : null, active_session_count: i % 4 === 2 ? 2 : 0,
  }));
  const dStates = ["delivered", "permanent_failed", "pending", "retry_wait"];
  const deliveries = Array.from({ length: 12 }, (_, i) => {
    const email = i % 2 === 0;
    return {
      channel: email ? "security_email" : "guardian_notification", id: id(i + 1, 5), patient_id: patients[i % 3].id,
      purpose: email ? ["verify_email", "reset_password", "doctor_share_otp"][i % 3] : null, state: dStates[i % 4], attempts: i % 4 === 0 ? 1 : 3,
      max_attempts: email ? null : 5, failure_reason: dStates[i % 4] === "permanent_failed" ? "provider_rejected" : null,
      next_attempt_at: at(4), created_at: at(1, 12 - Math.floor(i / 2), 59 - i), delivered_at: dStates[i % 4] === "delivered" ? at(1, 13) : null,
    };
  });
  const versions: Record<string, SettingVersion[]> = {};
  const ver = (key: string, version: number, value: number, by: string, decision: SettingVersion["decision"] = null, requires = false): SettingVersion => ({
    version, value, requires_approval: requires, gate: requires ? (REGISTRY.find((r) => r.key === key)!.gate!.cfg) : null, proposed_by: by, proposed_at: at(2, 9, version), decision,
  });
  versions["guardian.digest_window_hours"] = [ver("guardian.digest_window_hours", 1, 12, OTHER)];
  versions["sharing.otp_seconds"] = [ver("sharing.otp_seconds", 1, 300, OTHER, null, true)];
  versions["auth.reset_seconds"] = [ver("auth.reset_seconds", 1, 600, ME, null, true)];
  versions["auth.access_token_seconds"] = [
    ver("auth.access_token_seconds", 1, 600, OTHER, { decision: "approved", decided_by: ME, reference: "SEC-REVIEW-17", decided_at: at(3) }, true),
  ];
  const rules = [
    { id: id(1, 6), rule_id: "LAB_GLUCOSE_HIGH", version: 1, definition: { field: "glucose", units: "mg/dL", operator: "gt", bounds: [180], context: { fasting: "yes" } }, definition_sha256: "a1b2c3d4".repeat(8), clinical_approval: "not_clinically_approved", created_by: OTHER, created_at: at(2, 9) },
    { id: id(2, 6), rule_id: "LAB_GLUCOSE_HIGH", version: 2, definition: { field: "glucose", units: "mg/dL", operator: "gt", bounds: [200], context: {} }, definition_sha256: "e5f6a7b8".repeat(8), clinical_approval: "not_clinically_approved", created_by: ME, created_at: at(3, 9) },
    { id: id(3, 6), rule_id: "LAB_POTASSIUM_RANGE", version: 1, definition: { field: "potassium", units: "mmol/L", operator: "outside", bounds: [3.5, 5.1], context: {} }, definition_sha256: "99887766".repeat(8), clinical_approval: "not_clinically_approved", created_by: OTHER, created_at: at(4, 9) },
  ];
  const actions = ["admin.patients.read", "admin.processing.read", "admin.settings.change", "admin.rules.create", "admin.audit.read"];
  const audit = Array.from({ length: 40 }, (_, i) => ({
    seq: 40 - i, id: id(40 - i, 7), occurred_at: new Date(Date.UTC(2026, 1, 10, 12, 0, 0, 0) - i * 60000).toISOString(),
    actor_admin_id: i % 3 === 0 ? OTHER : ME, actor_role: i % 3 === 0 ? "security_admin" : "support_admin", action: actions[i % 5],
    target_type: ["patient_account", "processing_job", "setting", "serious_rule", "audit_log"][i % 5], target_id: i % 5 === 2 ? "auth.reset_seconds" : null,
    scope: i === 0 ? { view: "list", filters: ["status"], returned: 3 } : { view: "list", returned: i }, outcome: i % 7 === 3 ? "denied" : i % 11 === 5 ? "failure" : "success",
    request_id: id(900 + i, 8), event_hash: (String(i).padStart(2, "0") + "c0ffee").repeat(11).slice(0, 64),
  }));
  const health = {
    status: "degraded", checked_at: "2026-02-10T12:00:00.000Z",
    components: [
      { name: "database", status: "ok", latency_ms: 4 },
      { name: "migrations", status: "ok", expected: 19, applied: 19, pending: 0, latest_applied: "0019" },
      { name: "processing_queue", status: "degraded", reason: "expired_leases", pending: 2, running: 1, retry_wait: 0, failed_last_24h: 1, expired_leases: 1, oldest_ready_age_seconds: 12 },
      { name: "email_queue", status: "ok", email_overdue: 0, notification_overdue: 0 },
      { name: "ai_ocr", status: "down", reason: "connection_failed", internal_address: "http://LEAK-host.invalid:9000/secret-path", nested: { token: "LEAK-token" } },
      { name: "ai_summary", status: "ok", reason: "no_health_route", latency_ms: 20 },
      { name: "ai_rag", status: "not_configured" },
    ],
  };
  return { guardians, guardianEvents, shares, deliveries, versions, rules, audit, health };
}
type Extra = ReturnType<typeof extraFixtures>;
interface Ctx { rest: string; method: string; url: URL; body: any; extra: Extra; opts: Options; calls: { method: string; path: string }[] }
const pageOf = <T,>(rows: T[], url: URL) => {
  const limit = Number(url.searchParams.get("limit") ?? 25), start = Number((url.searchParams.get("cursor") ?? "c0").slice(1)), end = start + limit;
  return { slice: rows.slice(start, end), next: end < rows.length ? "c" + end : null };
};
const countBy = <T,>(rows: T[], f: (r: T) => string) => rows.reduce<Record<string, number>>((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
function settingView(extra: Extra, spec: (typeof REGISTRY)[number]) {
  const versions = extra.versions[spec.key] ?? [];
  const approved = (v: SettingVersion) => !v.requires_approval || v.decision?.decision === "approved";
  const effective = [...versions].reverse().find(approved);
  const pending = versions.filter((v) => v.requires_approval && !v.decision).length;
  return { key: spec.key, unit: spec.unit, min: spec.min, max: spec.max, default: spec.default, source: spec.source, gate: spec.gate, value: effective?.value ?? spec.default, version: effective?.version ?? 0, pending_versions: pending };
}
function settingDetail(extra: Extra, spec: (typeof REGISTRY)[number]) {
  const effective = settingView(extra, spec).version;
  const history = [...(extra.versions[spec.key] ?? [])].reverse().map((v) => ({
    ...v, status: v.decision?.decision === "rejected" ? "rejected" : v.requires_approval && v.decision?.decision !== "approved" ? "pending_approval" : v.version === effective ? "effective" : "superseded",
  }));
  return { ...settingView(extra, spec), history };
}
/** The routes added in Phase 9. Returns [status, body] or undefined when the path is not one of them. */
function extras({ rest, method, url, body, extra, opts }: Ctx): [number, unknown] | undefined {
  const s = url.searchParams;
  const L = { ...LEAKS };
  if (rest === "me" && method === "GET")
    return opts.meFails ? [500, { error: { code: "INTERNAL" } }] : [200, { success: true, admin: { id: ME, email: ADMIN.email, full_name: "Synthetic Admin", role: opts.role ?? "support_admin", permissions: opts.permissions ?? ALL_PERMISSIONS } }];
  const view = /^status\/(guardians|shares|deliveries)(?:\/(summary|[^/]+))?$/.exec(rest);
  if (view && method === "GET") {
    const [, kind, tail] = view;
    if (kind === "guardians") {
      if (tail === "summary") {
        const by = { PENDING: 0, ACTIVE: 0, REVOKED: 0, EXPIRED: 0, ...countBy(extra.guardians, (g) => g.status) };
        return [200, { success: true, summary: { by_status: by, total: extra.guardians.length } }];
      }
      if (tail) {
        const g = extra.guardians.find((x) => x.id === tail);
        return g ? [200, { success: true, guardian: { ...g, ...L, guardian_email: "LEAK@example.invalid", events: extra.guardianEvents(g.id) } }] : [404, { error: { code: "NOT_FOUND" } }];
      }
      const rows = extra.guardians.filter((g) => (!s.get("status") || g.status === s.get("status")) && (!s.get("patient_id") || g.patient_id === s.get("patient_id")));
      const { slice, next } = pageOf(rows, url);
      return [200, { success: true, guardians: slice.map((g) => ({ ...g, ...L, guardian_email: "LEAK@example.invalid" })), next_cursor: next }];
    }
    if (kind === "shares") {
      if (tail === "summary") {
        const st = { active: 0, expired: 0, revoked: 0, ...countBy(extra.shares, (g) => g.status) }, me = { qr_code: 0, unique_link: 0, ...countBy(extra.shares, (g) => g.sharing_method) };
        return [200, { success: true, summary: { by_status: st, by_method: me, total: extra.shares.length } }];
      }
      if (tail) {
        const g = extra.shares.find((x) => x.id === tail);
        return g ? [200, { success: true, share: { ...g, ...L, share_token: "LEAK-token", event_counts: { opened: 3, otp_verified: 2 }, last_event_at: "2026-02-04T10:15:00.000Z" } }] : [404, { error: { code: "NOT_FOUND" } }];
      }
      const rows = extra.shares.filter((g) => (!s.get("status") || g.status === s.get("status")) && (!s.get("method") || g.sharing_method === s.get("method")) && (!s.get("patient_id") || g.patient_id === s.get("patient_id")));
      const { slice, next } = pageOf(rows, url);
      return [200, { success: true, shares: slice.map((g) => ({ ...g, ...L, share_token: "LEAK-token" })), next_cursor: next }];
    }
    if (tail === "summary") {
      const states = ["pending", "sending", "running", "retry_wait", "transient_failed", "permanent_failed", "delivered", "expired", "superseded", "cancelled"];
      const by = Object.fromEntries(["security_email", "guardian_notification"].map((c) => [c, { ...Object.fromEntries(states.map((x) => [x, 0])), ...countBy(extra.deliveries.filter((d) => d.channel === c), (d) => d.state) }]));
      return [200, { success: true, summary: { by_channel: by, total: extra.deliveries.length } }];
    }
    if (tail) return [404, { error: { code: "NOT_FOUND" } }];
    const rows = extra.deliveries.filter((d) => (!s.get("channel") || d.channel === s.get("channel")) && (!s.get("state") || d.state === s.get("state")) && (!s.get("purpose") || d.purpose === s.get("purpose")) && (!s.get("patient_id") || d.patient_id === s.get("patient_id")));
    const { slice, next } = pageOf(rows, url);
    return [200, { success: true, deliveries: slice.map((d) => ({ ...d, ...L, recipient_email: "LEAK@example.invalid", payload: "LEAK payload" })), next_cursor: next }];
  }
  if (rest === "settings" && method === "GET") return [200, { success: true, settings: REGISTRY.map((r) => ({ ...settingView(extra, r), ...L })) }];
  const setting = /^settings\/([^/]+)(?:\/versions(?:\/(\d+)\/decision)?)?$/.exec(rest);
  if (setting) {
    const spec = REGISTRY.find((r) => r.key === decodeURIComponent(setting[1]));
    const isVersions = rest.includes("/versions");
    if (method === "GET" && !isVersions) return spec ? [200, { success: true, setting: { ...settingDetail(extra, spec), ...L } }] : [404, { error: { code: "NOT_FOUND" } }];
    if (!spec) return [403, { error: { code: "SETTING_NOT_PERMITTED" } }];
    if (method === "POST" && !setting[2]) {
      if (opts.settingFail) return [403, { error: { code: "FORBIDDEN" } }];
      if (Object.keys(body ?? {}).join(",") !== "value" || !Number.isSafeInteger(body.value) || body.value < spec.min || body.value > spec.max) return [400, { error: { code: "INVALID_SETTING_VALUE" } }];
      if (body.value === settingView(extra, spec).value) return [409, { error: { code: "SETTING_UNCHANGED" } }];
      const list = (extra.versions[spec.key] ??= []);
      const next: SettingVersion = { version: list.length + 1, value: body.value, requires_approval: spec.gate !== null, gate: spec.gate?.cfg ?? null, proposed_by: ME, proposed_at: "2026-02-11T09:00:00.000Z", decision: null };
      list.push(next);
      return [201, { success: true, setting: settingDetail(extra, spec), version: next.version, status: spec.gate ? "pending_approval" : "effective" }];
    }
    if (method === "POST" && setting[2]) {
      const v = (extra.versions[spec.key] ?? []).find((x) => x.version === Number(setting[2]));
      if (!v) return [404, { error: { code: "NOT_FOUND" } }];
      if (!body || Object.keys(body).sort().join(",") !== "decision,reference" || !["approved", "rejected"].includes(body.decision) || !/^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,119}$/.test(body.reference)) return [400, { error: { code: "INVALID_INPUT" } }];
      if (!v.requires_approval) return [409, { error: { code: "APPROVAL_NOT_REQUIRED" } }];
      if (v.decision || opts.decisionConflict) { v.decision ??= { decision: "rejected", decided_by: OTHER, reference: "RACE-1", decided_at: "2026-02-11T09:05:00.000Z" }; return [409, { error: { code: "DECISION_EXISTS" } }]; }
      if (body.decision === "approved" && v.proposed_by === ME) return [403, { error: { code: "SELF_APPROVAL_FORBIDDEN" } }];
      v.decision = { decision: body.decision, decided_by: ME, reference: body.reference, decided_at: "2026-02-11T09:10:00.000Z" };
      return [200, { success: true, setting: settingDetail(extra, spec) }];
    }
  }
  if (rest === "rules" && method === "GET") {
    const rows = extra.rules.filter((r) => !s.get("rule_id") || r.rule_id === s.get("rule_id")).slice().reverse();
    const { slice, next } = pageOf(rows, url);
    return [200, { success: true, rules: slice.map((r) => ({ ...r, ...L })), next_cursor: next }];
  }
  if (rest === "rules" && method === "POST") {
    if (opts.rulesForbidden || Object.keys(body ?? {}).some((k) => /approv|clinical/i.test(k))) return [403, { error: { code: "CLINICAL_APPROVAL_FORBIDDEN" } }];
    const version = extra.rules.filter((r) => r.rule_id === body.rule_id).length + 1;
    const rule = { id: id(extra.rules.length + 1, 6), rule_id: body.rule_id, version, definition: body.definition, definition_sha256: "1234abcd".repeat(8), clinical_approval: "not_clinically_approved", created_by: ME, created_at: "2026-02-11T09:00:00.000Z" };
    extra.rules.push(rule);
    return [201, { success: true, rule }];
  }
  const rule = /^rules\/([^/]+)$/.exec(rest);
  if (rule && method === "GET") {
    const r = extra.rules.find((x) => x.id === rule[1]);
    return r ? [200, { success: true, rule: { ...r, ...L } }] : [404, { error: { code: "NOT_FOUND" } }];
  }
  if (rest === "health" && method === "GET") return opts.healthFails ? [503, { error: { code: "UNAVAILABLE" } }] : [200, { success: true, health: extra.health }];
  if (rest === "audit" && method === "GET") {
    const a = s.get("action"), o = s.get("outcome"), t = s.get("target_type"), who = s.get("actor_admin_id"), from = s.get("from"), to = s.get("to");
    const rows = extra.audit.filter((e) => (!a || e.action === a) && (!o || e.outcome === o) && (!t || e.target_type === t) && (!who || e.actor_admin_id === who) && (!from || e.occurred_at >= from) && (!to || e.occurred_at <= to));
    const { slice, next } = pageOf(rows, url);
    const first = !s.get("cursor");
    const chain = !first ? null : opts.brokenChain ? { status: "broken", events_checked: extra.audit.length, first_invalid_seq: 17 } : { status: "intact", events_checked: extra.audit.length, first_invalid_seq: null };
    return [200, { success: true, events: slice.map((e) => ({ ...e, ...L })), next_cursor: next, chain }];
  }
  return undefined;
}

before(async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  origin = "http://127.0.0.1:" + port;
  let startup = "";
  vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/admin/vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout?.on("data", (b) => { startup += b; });
  vite.stderr?.on("data", (b) => { startup += b; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (vite.exitCode !== null) throw new Error("Vite startup failed: " + startup);
    try {
      if ((await fetch(origin + "/", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Local Vite failed readiness: " + startup);
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => {
  await browser?.close();
  vite?.kill();
});
interface Options {
  expiresIn?: number; rejectAfter?: number; mutateFail?: "conflict" | "forbidden"; viewport?: { width: number; height: number };
  permissions?: string[]; role?: string; meFails?: boolean; brokenChain?: boolean; settingFail?: boolean; decisionConflict?: boolean; rulesForbidden?: boolean; healthFails?: boolean;
}
async function setup(opts: Options = {}) {
  const { expiresIn = 900, rejectAfter, mutateFail, viewport } = opts;
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const data = fixtures();
  const extra = extraFixtures(data.patients);
  const calls: { method: string; path: string; query: URLSearchParams; auth?: string; body: string | null }[] = [];
  let loginAt = 0;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    calls.push({ method, path, query: url.searchParams, auth: req.headers().authorization, body: req.postData() });
    const reply = (status: number, value: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value), headers: { "cache-control": "no-store" } });
    if (path === "/api/v1/admin/auth/login") {
      const body = req.postDataJSON();
      if (body.email !== ADMIN.email || body.password !== ADMIN.password) return reply(401, { error: { code: "INVALID_CREDENTIALS" } });
      loginAt = Date.now();
      return reply(200, { success: true, access_token: TOKEN, token_type: "Bearer", expires_in: expiresIn });
    }
    if (!path.startsWith("/api/v1/admin/")) return reply(404, { error: { code: "NOT_FOUND" } });
    if (req.headers().authorization !== "Bearer " + TOKEN || (rejectAfter !== undefined && Date.now() - loginAt > rejectAfter))
      return reply(401, { error: { code: "UNAUTHORIZED" } });
    const rest = path.replace("/api/v1/admin/", "");
    const more = extras({ rest, method, url, body: req.postData() ? req.postDataJSON() : undefined, extra, opts, calls });
    if (more) return reply(more[0], more[1]);
    const page_ = <T,>(rows: T[]) => {
      const limit = Number(url.searchParams.get("limit") ?? 25), start = Number((url.searchParams.get("cursor") ?? "c0").slice(1));
      const end = start + limit;
      return { slice: rows.slice(start, end), next: end < rows.length ? "c" + end : null };
    };
    if (rest === "patients" && method === "GET") {
      const q = url.searchParams.get("q")?.toLowerCase(), status = url.searchParams.get("status"), verified = url.searchParams.get("verified");
      const rows = data.patients.filter((p) => (!q || p.full_name.toLowerCase().includes(q) || p.email.includes(q)) && (!status || p.account_status === status) && (verified === null || String(p.email_verified) === verified));
      const { slice, next } = page_(rows);
      return reply(200, { success: true, patients: slice.map((p) => ({ ...p, ...LEAKS })), next_cursor: next });
    }
    const patient = /^patients\/([^/]+)(?:\/(suspend|reactivate))?$/.exec(rest);
    if (patient) {
      const found = data.patients.find((p) => p.id === patient[1]);
      if (!found) return reply(404, { error: { code: "NOT_FOUND" } });
      if (method === "GET" && !patient[2]) return reply(200, { success: true, patient: { ...found, ...LEAKS } });
      if (method === "POST" && patient[2]) {
        if (mutateFail === "forbidden") return reply(403, { error: { code: "FORBIDDEN" } });
        const from = patient[2] === "suspend" ? "active" : "suspended";
        if (mutateFail === "conflict" || found.account_status !== from) return reply(409, { error: { code: "ACCOUNT_STATE_CONFLICT" } });
        found.account_status = patient[2] === "suspend" ? "suspended" : "active";
        return reply(200, { success: true, patient: { ...found, ...LEAKS } });
      }
    }
    if (rest === "processing/summary" && method === "GET") {
      const by: Record<string, number> = { pending: 0, running: 0, retry_wait: 0, completed: 0, failed: 0, cancelled: 0 };
      const codes: Record<string, number> = { PROCESSOR_FAILED: 0, PROCESSOR_TIMEOUT: 0, INTERRUPTED: 0, INVALID_INPUT: 0, LEASE_EXPIRED: 0 };
      for (const j of data.jobs) { by[j.state]++; if (j.last_error_code && (j.state === "failed" || j.state === "retry_wait")) codes[j.last_error_code]++; }
      return reply(200, { success: true, summary: { by_state: by, failures_by_error_code: codes, running_with_expired_lease: data.jobs.filter((j) => j.lease_expired).length, total: data.jobs.length } });
    }
    if (rest === "processing/jobs" && method === "GET") {
      const s = url.searchParams, rows = data.jobs.filter((j) => (!s.get("state") || j.state === s.get("state")) && (!s.get("error_code") || j.last_error_code === s.get("error_code")) && (!s.get("patient_id") || j.patient_id === s.get("patient_id")));
      const { slice, next } = page_(rows);
      return reply(200, { success: true, jobs: slice.map((j) => ({ ...j, ...LEAKS })), next_cursor: next });
    }
    const job = /^processing\/jobs\/([^/]+?)(\/retry)?$/.exec(rest);
    if (job) {
      const found = data.jobs.find((j) => j.document_id === job[1]);
      if (!found) return reply(404, { error: { code: "NOT_FOUND" } });
      if (method === "GET" && !job[2]) return reply(200, { success: true, job: { ...found, ...LEAKS } });
      if (method === "POST" && job[2]) {
        if (found.state !== "failed" || found.attempt_count >= found.max_attempts || found.last_error_code === "INVALID_INPUT") return reply(409, { error: { code: "JOB_NOT_RETRYABLE" } });
        found.state = "retry_wait";
        return reply(200, { success: true, job: { ...found, ...LEAKS } });
      }
    }
    return reply(404, { error: { code: "NOT_FOUND" } });
  });
  await page.goto(origin + "/");
  return { page, context, calls, data, extra };
}
async function signIn(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function login(page: Page) {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Amara Okafor" })).toBeVisible();
}
const noStorage = (page: Page) =>
  page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
async function noLeaks(page: Page) {
  const text = await page.locator("body").innerText();
  for (const word of ["LEAK", "1980-01-01", "+1555"]) assert.ok(!text.includes(word), "the page shows " + word);
}

test("P8-ADMIN-WEB-01 sign-in: wrong credentials are refused, the token stays in memory, and only admin endpoints are called", async () => {
  const { page, context, calls } = await setup();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  assert.equal(calls.length, 0, "nothing is requested before sign-in");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await signIn(page, ADMIN.email, "wrong password");
  await expect(page.getByText("Sign-in failed. Check your email and password.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toHaveCount(0);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText(/Session ends in 1[45]:\d\d/);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  const protectedCalls = calls.filter((c) => c.path !== "/api/v1/admin/auth/login");
  assert.ok(protectedCalls.length >= 1 && protectedCalls.every((c) => c.auth === "Bearer " + TOKEN), "every data request carries the in-memory token");
  assert.ok(calls.every((c) => c.path.startsWith("/api/v1/admin/")), "only admin endpoints are used");
  assert.equal(calls.filter((c) => c.path.endsWith("/auth/login")).every((c) => c.auth === undefined), true, "the login request itself carries no token");
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await context.close();
});

test("P8-ADMIN-WEB-02 patient accounts: search, filters, paging and detail show account metadata only", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  const lastList = () => calls.filter((c) => c.path === "/api/v1/admin/patients").at(-1)!;
  assert.equal(lastList().query.get("limit"), "10");
  await expect(page.getByRole("row")).toHaveCount(11);
  await expect(page.getByText("Page 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next →" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "← Previous" })).toBeDisabled();
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Mateo Ruiz" })).toBeVisible();
  assert.equal(lastList().query.get("cursor"), "c10");
  await expect(page.getByRole("button", { name: "Next →" })).toBeDisabled();
  await page.getByRole("button", { name: "← Previous" }).click();
  await expect(page.getByText("Page 1")).toBeVisible();
  await page.getByLabel("Search name or email").fill("a");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Enter at least 2 characters")).toBeVisible();
  await page.getByLabel("Search name or email").fill("chen");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Chen Wei" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
  assert.equal(lastList().query.get("q"), "chen");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Status").selectOption("suspended");
  await page.getByLabel("Email verified").selectOption("true");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Chen Wei" })).toBeVisible();
  assert.deepEqual([lastList().query.get("status"), lastList().query.get("verified")], ["suspended", "true"]);
  await page.getByLabel("Status").selectOption("");
  await page.getByLabel("Email verified").selectOption("false");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Elif Demir" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "No", exact: true })).toBeVisible();
  await page.getByLabel("Search name or email").fill("nobody-here");
  await page.getByLabel("Email verified").selectOption("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No patient accounts match.")).toBeVisible();
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open Elif Demir" }).click();
  const detail = page.getByRole("complementary", { name: "Account detail" });
  await expect(detail.getByRole("heading", { name: "Elif Demir" })).toBeVisible();
  await expect(detail).toContainText("elif@example.invalid");
  await expect(detail).toContainText("unverified");
  await expect(detail).toContainText("No");
  await expect(detail).toContainText("2026-01-16 09:30 UTC");
  await expect(detail.getByRole("button", { name: "Suspend account" })).toHaveCount(0);
  await expect(detail).toContainText("No admin action is available for a unverified account.");
  await noLeaks(page);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  await context.close();
});

test("P8-ADMIN-WEB-03 suspend and reactivate need a confirmation step, then show clear success; conflicts and role denials show clear errors", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  const posts = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/login"));
  await page.getByRole("button", { name: "Open Amara Okafor" }).click();
  const detail = page.getByRole("complementary", { name: "Account detail" });
  await expect(detail.getByRole("button", { name: "Suspend account" })).toBeVisible();
  await detail.getByRole("button", { name: "Suspend account" }).click();
  await expect(detail.getByRole("heading", { name: "Suspend Amara Okafor?" })).toBeVisible();
  await expect(detail).toContainText("signed out everywhere");
  assert.equal(posts().length, 0, "nothing is sent until the admin confirms");
  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(detail.getByRole("button", { name: "Suspend account" })).toBeVisible();
  assert.equal(posts().length, 0, "cancel sends nothing");
  await detail.getByRole("button", { name: "Suspend account" }).click();
  await detail.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(detail.getByText(/Amara Okafor was suspended\. Their sessions, doctor shares and report links were ended\./)).toBeVisible();
  assert.equal(posts().length, 1);
  assert.match(posts()[0].path, /\/patients\/00011111-0000-4000-8000-000000000001\/suspend$/);
  assert.equal(posts()[0].body, null, "the action sends no body");
  await expect(detail.getByRole("button", { name: "Reactivate account" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Suspend account" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Amara Okafor/ })).toContainText("suspended");
  await detail.getByRole("button", { name: "Reactivate account" }).click();
  await expect(detail.getByRole("heading", { name: "Reactivate Amara Okafor?" })).toBeVisible();
  await expect(detail).toContainText("do not come back");
  assert.equal(posts().length, 1);
  await detail.getByRole("button", { name: "Confirm reactivate" }).click();
  await expect(detail.getByText(/Amara Okafor was reactivated\. They must sign in again/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Amara Okafor/ })).toContainText("active");
  assert.equal(posts().length, 2);
  await noLeaks(page);
  await context.close();
  // someone else changed the account first: a clear message, and the real status is reloaded
  const second = await setup({ mutateFail: "conflict" });
  await login(second.page);
  await second.page.getByRole("button", { name: "Open Bilal Raza" }).click();
  const d2 = second.page.getByRole("complementary", { name: "Account detail" });
  await d2.getByRole("button", { name: "Suspend account" }).click();
  await d2.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(d2.getByRole("alert")).toContainText("not in a state that allows this action");
  await expect(d2.getByRole("button", { name: "Suspend account" })).toBeVisible();
  await second.context.close();
  // a role without the permission: clear message, and the admin stays signed in
  const third = await setup({ mutateFail: "forbidden" });
  await login(third.page);
  await third.page.getByRole("button", { name: "Open Bilal Raza" }).click();
  const d3 = third.page.getByRole("complementary", { name: "Account detail" });
  await d3.getByRole("button", { name: "Suspend account" }).click();
  await d3.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(d3.getByRole("alert")).toContainText("Your admin role is not allowed to do this.");
  await expect(third.page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(third.page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await third.context.close();
});

test("P8-ADMIN-WEB-04 processing: summary counts, filters, paging and job detail show job metadata only", async () => {
  const { page, context, calls, data } = await setup();
  await login(page);
  await page.getByRole("button", { name: "Processing" }).click();
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  const cards = page.getByRole("region", { name: "Processing summary" });
  await expect(cards).toContainText("12");
  await expect(cards.getByRole("listitem").filter({ hasText: "All jobs" })).toContainText("12");
  await expect(cards.getByRole("listitem").filter({ hasText: "failed" })).toContainText("4");
  await expect(cards.getByRole("listitem").filter({ hasText: "expired leases" })).toContainText("1");
  await expect(cards).toContainText("processor timeout 2");
  const lastJobs = () => calls.filter((c) => c.path === "/api/v1/admin/processing/jobs").at(-1)!;
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  assert.equal(lastJobs().query.get("cursor"), "c10");
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByRole("button", { name: "← Previous" }).click();
  await page.getByLabel("State").selectOption("failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(5);
  assert.equal(lastJobs().query.get("state"), "failed");
  await page.getByLabel("Failure reason").selectOption("PROCESSOR_TIMEOUT");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  assert.deepEqual([lastJobs().query.get("state"), lastJobs().query.get("error_code")], ["failed", "PROCESSOR_TIMEOUT"]);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Patient ID").fill("not-an-id");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("The patient ID must be a full ID")).toBeVisible();
  await page.getByLabel("Patient ID").fill(data.patients[1].id);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(5);
  assert.equal(lastJobs().query.get("patient_id"), data.patients[1].id);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open job 00012222" }).click();
  const detail = page.getByRole("complementary", { name: "Job detail" });
  await expect(detail).toContainText("failed");
  await expect(detail).toContainText("1 of 3");
  await expect(detail).toContainText("processor failed");
  await expect(detail).toContainText("2026-02-01 08:05 UTC");
  await expect(detail).toContainText(data.jobs[0].document_id);
  await noLeaks(page);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  assert.ok(calls.every((c) => c.path.startsWith("/api/v1/admin/")));
  await context.close();
});

test("P8-ADMIN-WEB-05 retry needs a confirmation step, then queues the job; a job that cannot be retried gives a clear message", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await page.getByRole("button", { name: "Processing" }).click();
  const posts = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/login"));
  const detail = page.getByRole("complementary", { name: "Job detail" });
  await page.getByRole("button", { name: "Open job 00032222" }).click();
  await expect(detail).toContainText("running");
  await expect(detail.getByRole("button", { name: "Retry job" })).toHaveCount(0);
  await expect(detail).toContainText("Only failed jobs can be retried.");
  await page.getByRole("button", { name: "Open job 00012222" }).click();
  await detail.getByRole("button", { name: "Retry job" }).click();
  await expect(detail.getByRole("heading", { name: "Retry this job?" })).toBeVisible();
  await expect(detail).toContainText("Attempts are not reset");
  assert.equal(posts().length, 0, "nothing is sent until the admin confirms");
  await detail.getByRole("button", { name: "Cancel" }).click();
  assert.equal(posts().length, 0);
  const summaries = calls.filter((c) => c.path.endsWith("/processing/summary")).length;
  await detail.getByRole("button", { name: "Retry job" }).click();
  await detail.getByRole("button", { name: "Confirm retry" }).click();
  await expect(detail.getByText(/Retry queued\. The job is waiting for the processing worker/)).toBeVisible();
  assert.equal(posts().length, 1);
  assert.match(posts()[0].path, /\/processing\/jobs\/00012222-0000-4000-8000-000000000001\/retry$/);
  assert.equal(posts()[0].body, null);
  await expect(detail).toContainText("retry wait");
  await expect(page.getByRole("row", { name: /00012222/ })).toContainText("retry wait");
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/processing/summary")).length).toBeGreaterThan(summaries);
  // exhausted attempts: the backend refuses, the screen explains and shows the real state
  await page.getByRole("button", { name: "Open job 00072222" }).click();
  await detail.getByRole("button", { name: "Retry job" }).click();
  await detail.getByRole("button", { name: "Confirm retry" }).click();
  await expect(detail.getByRole("alert")).toContainText("This job cannot be retried right now");
  await expect(detail).toContainText("3 of 3");
  await noLeaks(page);
  await context.close();
});

test("P8-ADMIN-WEB-06 sign out clears the session, sends nothing afterwards, and shows no data on the sign-in screen", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await page.getByRole("button", { name: "Open Amara Okafor" }).click();
  await expect(page.getByRole("complementary", { name: "Account detail" }).getByRole("heading", { name: "Amara Okafor" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("You signed out. Nothing is kept in this browser.")).toBeVisible();
  await expect(page.getByText("Amara Okafor")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  const used = calls.length;
  await page.waitForTimeout(500);
  assert.equal(calls.length, used, "no request is made after sign-out");
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  await login(page);
  await context.close();
});

test("P8-ADMIN-WEB-07 when the 15-minute token runs out the admin returns to sign-in with a clear message, and comes back to the same screen", async () => {
  const { page, context, calls } = await setup({ expiresIn: 2 });
  await login(page);
  await page.getByRole("button", { name: "Processing" }).click();
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText(/Session ends in 0:0[12]/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 6000 });
  await expect(page.getByText("Your session expired after 15 minutes. Sign in again to continue.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Document processing" })).toHaveCount(0);
  const used = calls.length;
  await page.waitForTimeout(400);
  assert.equal(calls.length, used, "no request is made with an expired token");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  await context.close();
  // the server stops accepting the token before the clock does (revoked, role changed, admin disabled)
  const rejected = await setup({ rejectAfter: 300 });
  await signIn(rejected.page);
  await expect(rejected.page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await rejected.page.waitForTimeout(500);
  await rejected.page.getByRole("button", { name: "Next →" }).click();
  await expect(rejected.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(rejected.page.getByText("Your session is no longer valid. Sign in again.")).toBeVisible();
  await rejected.context.close();
});

test("P8-ADMIN-WEB-08 the screens fit a laptop without sideways scrolling and the main controls can be reached by keyboard", async () => {
  const { page, context } = await setup({ viewport: { width: 1280, height: 720 } });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(await fits());
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  assert.ok(await fits(), "patient accounts fit 1280 px");
  await page.getByRole("button", { name: "Open Amara Okafor" }).click();
  await expect(page.getByRole("complementary", { name: "Account detail" })).toBeVisible();
  assert.ok(await fits(), "with a detail panel open");
  await page.getByRole("button", { name: "Processing" }).click();
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  assert.ok(await fits(), "processing fits 1280 px");
  const box = await page.getByRole("complementary", { name: "Job detail" }).boundingBox();
  assert.ok(box && box.width >= 300, "the detail panel is wide enough to read");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  assert.ok(["A", "BUTTON", "INPUT", "SELECT"].includes(focused ?? ""), "keyboard focus moves onto a control");
  await context.close();
});

// ====================== Phase 9: status, settings, serious rules, health and audit screens ======================
const go = (page: Page, name: string) => page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name, exact: true }).click();
const rowsOf = (page: Page, region: string) => page.getByRole("region", { name: region }).getByRole("row");
const posts = (calls: { method: string; path: string; body: string | null }[]) => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/login"));
const NAV = ["Patient accounts", "Processing", "Guardians", "Share grants", "Deliveries", "Settings", "Serious rules", "System health", "Audit log"];
const only = (...perms: string[]) => ["admin.profile.read", ...perms];

test("P9-ADMIN-WEB-01 the menu shows only what the role may open, the first allowed screen opens, and a profile failure keeps the admin signed out", async () => {
  const full = await setup();
  await login(full.page);
  const nav = full.page.getByRole("navigation", { name: "Sections" });
  assert.deepEqual(await nav.getByRole("button").allInnerTexts(), NAV);
  await expect(full.page.getByLabel("Signed in as")).toContainText("Synthetic Admin · support admin");
  const meCalls = full.calls.filter((c) => c.path.endsWith("/admin/me"));
  assert.equal(meCalls.length, 1, "the profile is read once, with the token");
  assert.equal(meCalls[0].auth, "Bearer " + TOKEN);
  await full.context.close();

  // limited role: hidden items are not rendered and their endpoints are never called
  const limited = await setup({ permissions: only("admin.patients.read", "admin.health.read"), role: "support_admin" });
  await login(limited.page);
  assert.deepEqual(await limited.page.getByRole("navigation", { name: "Sections" }).getByRole("button").allInnerTexts(), ["Patient accounts", "System health"]);
  await go(limited.page, "System health");
  await expect(limited.page.getByRole("heading", { name: "System health" })).toBeVisible();
  const hidden = limited.calls.filter((c) => /status\/|settings|rules|audit|processing/.test(c.path));
  assert.deepEqual(hidden, [], "no request goes to a section the role cannot open");
  await limited.context.close();

  // the first allowed screen opens when the role has no patient permission
  const auditOnly = await setup({ permissions: only("admin.audit.read") });
  await signIn(auditOnly.page);
  await expect(auditOnly.page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  assert.deepEqual(await auditOnly.page.getByRole("navigation", { name: "Sections" }).getByRole("button").allInnerTexts(), ["Audit log"]);
  await auditOnly.context.close();

  const none = await setup({ permissions: only() });
  await signIn(none.page);
  await expect(none.page.getByText("Your admin role has no screens in this dashboard.")).toBeVisible();
  await none.context.close();

  // the menu is not security: the backend still answers 403 and the screen explains it without signing out
  const denied = await setup({ permissions: only("admin.patients.read", "admin.settings.read"), settingFail: true });
  await login(denied.page);
  await go(denied.page, "Settings");
  await denied.page.getByRole("button", { name: "Open setting documents.max_pdf_pages" }).click();
  await expect(denied.page.getByText("Your admin role cannot change settings.")).toBeVisible();
  await denied.context.close();

  const broken = await setup({ meFails: true });
  await signIn(broken.page);
  await expect(broken.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(broken.page.getByRole("alert")).toContainText("The request could not be completed.");
  await expect(broken.page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  const used = broken.calls.length;
  await broken.page.waitForTimeout(300);
  assert.equal(broken.calls.length, used);
  await broken.context.close();
});

test("P9-ADMIN-WEB-02 guardian relationships: summary counts, filters, paging and detail show status metadata only", async () => {
  const { page, context, calls, extra } = await setup();
  await login(page);
  await go(page, "Guardians");
  await expect(page.getByRole("heading", { name: "Guardian relationships" })).toBeVisible();
  const counts = page.getByRole("list", { name: "Guardian counts" });
  await expect(counts.getByRole("listitem").filter({ hasText: "All relationships" })).toContainText("12");
  for (const s of ["active", "pending", "revoked", "expired"]) await expect(counts.getByRole("listitem").filter({ hasText: s })).toContainText("3");
  const last = () => calls.filter((c) => c.path === "/api/v1/admin/status/guardians").at(-1)!;
  assert.equal(last().query.get("limit"), "10");
  await expect(rowsOf(page, "Relationship list")).toHaveCount(11);
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect(rowsOf(page, "Relationship list")).toHaveCount(3);
  assert.equal(last().query.get("cursor"), "c10");
  await page.getByRole("button", { name: "← Previous" }).click();
  await page.getByLabel("Status").selectOption("REVOKED");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(rowsOf(page, "Relationship list")).toHaveCount(4);
  assert.equal(last().query.get("status"), "REVOKED");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Patient ID").fill("not-an-id");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("The patient ID must be a full ID")).toBeVisible();
  await page.getByLabel("Patient ID").fill(extra.guardians[0].patient_id);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(rowsOf(page, "Relationship list")).toHaveCount(4);
  assert.equal(last().query.get("patient_id"), extra.guardians[0].patient_id);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open relationship 00013333" }).click();
  const detail = page.getByRole("complementary", { name: "Relationship detail" });
  await expect(detail).toContainText("active");
  await expect(detail).toContainText("2026-02-02 10:00 UTC");
  await expect(detail.getByRole("table", { name: "Relationship history" })).toContainText("invited");
  await expect(detail.getByRole("table", { name: "Relationship history" })).toContainText("accepted");
  await noLeaks(page);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  assert.ok(calls.every((c) => c.path.startsWith("/api/v1/admin/")));
  await context.close();
});

test("P9-ADMIN-WEB-03 doctor share grants: counts by status and method, filters, paging and detail without links, codes or recipients", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await go(page, "Share grants");
  await expect(page.getByRole("heading", { name: "Doctor share grants" })).toBeVisible();
  const counts = page.getByRole("list", { name: "Grant counts" });
  await expect(counts.getByRole("listitem").filter({ hasText: "All grants" })).toContainText("12");
  await expect(counts.getByRole("listitem").filter({ hasText: "revoked" })).toContainText("3");
  await expect(counts.getByRole("listitem").filter({ hasText: "expired" })).toContainText("3");
  await expect(page.getByLabel("Grants by method")).toContainText("qr code 4 · unique link 8");
  const last = () => calls.filter((c) => c.path === "/api/v1/admin/status/shares").at(-1)!;
  await expect(rowsOf(page, "Grant list")).toHaveCount(11);
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(rowsOf(page, "Grant list")).toHaveCount(3);
  await page.getByRole("button", { name: "← Previous" }).click();
  await page.getByLabel("Method", { exact: true }).selectOption("unique_link");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(rowsOf(page, "Grant list")).toHaveCount(9);
  assert.equal(last().query.get("method"), "unique_link");
  await page.getByLabel("Status", { exact: true }).selectOption("revoked");
  await page.getByRole("button", { name: "Apply filters" }).click();
  assert.deepEqual([last().query.get("status"), last().query.get("method")], ["revoked", "unique_link"]);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open grant 00014444" }).click();
  const detail = page.getByRole("complementary", { name: "Grant detail" });
  await expect(detail).toContainText("revoked");
  await expect(detail).toContainText("qr code");
  await expect(detail).toContainText("Bound to one doctor");
  await expect(detail.getByRole("list", { name: "Grant activity" })).toContainText("opened: 3");
  await expect(detail.getByRole("list", { name: "Grant activity" })).toContainText("otp verified: 2");
  await expect(detail).toContainText("2026-02-04 10:15 UTC");
  await noLeaks(page);
  assert.ok(!(await page.locator("body").innerText()).includes("LEAK-token"));
  await context.close();
});

test("P9-ADMIN-WEB-04 deliveries: counts per channel, filters, paging and failure reasons; no addresses or message content", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await go(page, "Deliveries");
  await expect(page.getByRole("heading", { name: "Email and notification delivery" })).toBeVisible();
  const email = page.getByRole("region", { name: "Security emails" }), guardian = page.getByRole("region", { name: "Guardian notifications" });
  await expect(email.getByRole("listitem").filter({ hasText: "delivered" })).toContainText("3");
  await expect(email.getByRole("listitem").filter({ hasText: "permanent failed" })).toContainText("0");
  await expect(guardian.getByRole("listitem").filter({ hasText: "permanent failed" })).toContainText("3");
  await expect(guardian.getByRole("listitem").filter({ hasText: "retry wait" })).toContainText("3");
  await expect(page.getByText("The backend offers no single-delivery view")).toBeVisible();
  const last = () => calls.filter((c) => c.path === "/api/v1/admin/status/deliveries").at(-1)!;
  await expect(rowsOf(page, "Delivery list")).toHaveCount(11);
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(rowsOf(page, "Delivery list")).toHaveCount(3);
  await page.getByRole("button", { name: "← Previous" }).click();
  await page.getByLabel("Channel").selectOption("guardian_notification");
  await page.getByLabel("State").selectOption("permanent_failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(rowsOf(page, "Delivery list")).toHaveCount(4);
  assert.deepEqual([last().query.get("channel"), last().query.get("state")], ["guardian_notification", "permanent_failed"]);
  const row = rowsOf(page, "Delivery list").nth(1);
  await expect(row).toContainText("provider rejected");
  await expect(row).toContainText("3 of 5");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Email purpose").selectOption("reset_password");
  await page.getByRole("button", { name: "Apply filters" }).click();
  assert.equal(last().query.get("purpose"), "reset_password");
  await expect(rowsOf(page, "Delivery list")).toHaveCount(3);
  await page.getByLabel("Patient ID").fill("12345");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("The patient ID must be a full ID")).toBeVisible();
  await noLeaks(page);
  await context.close();
});

test("P9-ADMIN-WEB-05 settings: the allowed settings, value in effect, history and release gates are shown; changes are validated and need confirmation", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await go(page, "Settings");
  await expect(page.getByRole("heading", { name: "Operational settings" })).toBeVisible();
  const table = page.getByRole("table", { name: "Allowed settings" });
  await expect(table.getByRole("row")).toHaveCount(12);
  await expect(table.getByRole("row", { name: /guardian.digest_window_hours/ })).toContainText("12 hours");
  await expect(table.getByRole("row", { name: /documents.max_upload_bytes/ })).toContainText("5,242,880 bytes (default)");
  await expect(table.getByRole("row", { name: /auth.reset_seconds/ })).toContainText("needs approval · CFG-16");
  await expect(table.getByRole("row", { name: /sharing.otp_seconds/ })).toContainText("needs approval · CFG-04");
  await expect(table.getByRole("row", { name: /documents.max_pdf_pages/ })).toContainText("applies at once");
  await expect(page.getByRole("table", { name: "Changes waiting for approval" }).getByRole("row")).toHaveCount(3);
  // history and gate text
  await page.getByRole("button", { name: "Open setting auth.access_token_seconds" }).click();
  const detail = page.getByRole("complementary", { name: "Setting detail" });
  await expect(detail).toContainText("CFG-16: Security review and negative-path tests required before release.");
  await expect(detail).toContainText("60 to 3,600 seconds");
  const history = detail.getByRole("table", { name: "Version history" });
  await expect(history).toContainText("approved");
  await expect(history).toContainText("ref SEC-REVIEW-17");
  // validation messages: nothing is sent
  await page.getByRole("button", { name: "Open setting documents.max_concurrent_uploads" }).click();
  const change = async (text: string) => {
    await detail.getByLabel("New value").fill(text);
    await detail.getByRole("button", { name: "Review change" }).click();
  };
  await change("abc");
  await expect(detail.getByRole("alert")).toContainText("The value must be a whole number.");
  await change("9");
  await expect(detail.getByRole("alert")).toContainText("The value must be between 1 and 4 uploads.");
  await change("2");
  await expect(detail.getByRole("alert")).toContainText("That is already the value in effect.");
  assert.equal(posts(calls).length, 0);
  await change("3");
  await expect(detail.getByRole("heading", { name: "Save this change?" })).toBeVisible();
  await expect(detail).toContainText("It takes effect at once.");
  assert.equal(posts(calls).length, 0, "nothing is sent until the admin confirms");
  await detail.getByRole("button", { name: "Cancel" }).click();
  assert.equal(posts(calls).length, 0);
  await detail.getByRole("button", { name: "Review change" }).click();
  await detail.getByRole("button", { name: "Confirm change" }).click();
  await expect(detail.getByText("Version 1 was saved and is now in effect.")).toBeVisible();
  assert.equal(posts(calls).length, 1);
  assert.match(posts(calls)[0].path, /\/settings\/documents\.max_concurrent_uploads\/versions$/);
  assert.deepEqual(JSON.parse(posts(calls)[0].body!), { value: 3 });
  await expect(table.getByRole("row", { name: /documents.max_concurrent_uploads/ })).toContainText("3 uploads");
  // a release-gated setting waits for a different admin
  await page.getByRole("button", { name: "Open setting auth.verification_seconds" }).click();
  await change("3600");
  await expect(detail).toContainText("It will wait for approval by a different admin.");
  await detail.getByRole("button", { name: "Confirm change" }).click();
  await expect(detail.getByText(/waiting for approval by a different admin\. The current value stays in effect until then/)).toBeVisible();
  await expect(table.getByRole("row", { name: /auth.verification_seconds/ })).toContainText("86,400 seconds (default)");
  await expect(page.getByRole("table", { name: "Changes waiting for approval" }).getByRole("row")).toHaveCount(4);
  await noLeaks(page);
  await context.close();
  // a role denial from the backend is explained and does not end the session
  const refused = await setup({ settingFail: true });
  await login(refused.page);
  await go(refused.page, "Settings");
  await refused.page.getByRole("button", { name: "Open setting documents.max_pdf_pages" }).click();
  const d = refused.page.getByRole("complementary", { name: "Setting detail" });
  await d.getByLabel("New value").fill("50");
  await d.getByRole("button", { name: "Review change" }).click();
  await d.getByRole("button", { name: "Confirm change" }).click();
  await expect(d.getByRole("alert")).toContainText("Your admin role is not allowed to do this.");
  await expect(refused.page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await refused.context.close();
});

test("P9-ADMIN-WEB-06 approval needs a different admin and a review reference; a proposer cannot approve; races and rejections are explained", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await go(page, "Settings");
  const pending = page.getByRole("table", { name: "Changes waiting for approval" });
  await expect(pending.getByRole("row", { name: /auth.reset_seconds/ })).toContainText("You");
  await expect(pending.getByRole("row", { name: /sharing.otp_seconds/ })).not.toContainText("You");
  // own proposal: no decision form at all
  await page.getByRole("button", { name: "Review auth.reset_seconds version 1" }).click();
  const detail = page.getByRole("complementary", { name: "Setting detail" });
  await expect(detail.getByRole("heading", { name: "Review version 1" })).toBeVisible();
  await expect(detail).toContainText("You proposed this change, so a different admin must approve it.");
  await expect(detail.getByRole("form", { name: "Decision form" })).toHaveCount(0);
  // another admin's proposal
  await page.getByRole("button", { name: "Review sharing.otp_seconds version 1" }).click();
  await expect(detail).toContainText("Proposed value: 300 seconds");
  const form = detail.getByRole("form", { name: "Decision form" });
  await form.getByRole("button", { name: "Check decision" }).click();
  await expect(detail.getByRole("alert")).toContainText("Enter the review reference");
  await form.getByLabel("Review reference").fill("!!");
  await form.getByRole("button", { name: "Check decision" }).click();
  await expect(detail.getByRole("alert")).toContainText("Enter the review reference");
  await form.getByLabel("Review reference").fill("SEC-REVIEW-42");
  await form.getByRole("button", { name: "Check decision" }).click();
  await expect(detail.getByRole("heading", { name: "Approve this change?" })).toBeVisible();
  await expect(detail).toContainText("does not replace the security review named in the release gate");
  assert.equal(posts(calls).length, 0, "nothing is sent until the admin confirms");
  await detail.getByRole("button", { name: "Confirm approval" }).click();
  await expect(detail.getByText("Version 1 was approved and is now in effect.")).toBeVisible();
  assert.equal(posts(calls).length, 1);
  assert.match(posts(calls)[0].path, /\/settings\/sharing\.otp_seconds\/versions\/1\/decision$/);
  assert.deepEqual(JSON.parse(posts(calls)[0].body!), { decision: "approved", reference: "SEC-REVIEW-42" });
  await expect(page.getByRole("table", { name: "Allowed settings" }).getByRole("row", { name: /sharing.otp_seconds/ })).toContainText("300 seconds");
  await expect(pending.getByRole("row")).toHaveCount(2);
  await expect(detail.getByRole("table", { name: "Version history" })).toContainText("ref SEC-REVIEW-42");
  await context.close();

  // rejection: the value stays as it was
  const rej = await setup();
  await login(rej.page);
  await go(rej.page, "Settings");
  await rej.page.getByRole("button", { name: "Review sharing.otp_seconds version 1" }).click();
  const d2 = rej.page.getByRole("complementary", { name: "Setting detail" });
  await d2.getByLabel("Decision", { exact: true }).selectOption("rejected");
  await d2.getByLabel("Review reference").fill("SEC-REVIEW-43");
  await d2.getByRole("button", { name: "Check decision" }).click();
  await d2.getByRole("button", { name: "Confirm rejection" }).click();
  await expect(d2.getByText("Version 1 was rejected. The current value stays in effect.")).toBeVisible();
  assert.deepEqual(JSON.parse(posts(rej.calls)[0].body!), { decision: "rejected", reference: "SEC-REVIEW-43" });
  await expect(rej.page.getByRole("table", { name: "Allowed settings" }).getByRole("row", { name: /sharing.otp_seconds/ })).toContainText("600 seconds (default)");
  await rej.context.close();

  // someone else decided first
  const race = await setup({ decisionConflict: true });
  await login(race.page);
  await go(race.page, "Settings");
  await race.page.getByRole("button", { name: "Review sharing.otp_seconds version 1" }).click();
  const d3 = race.page.getByRole("complementary", { name: "Setting detail" });
  await d3.getByLabel("Review reference").fill("SEC-REVIEW-44");
  await d3.getByRole("button", { name: "Check decision" }).click();
  await d3.getByRole("button", { name: "Confirm approval" }).click();
  await expect(d3.getByRole("alert")).toContainText("A decision is already recorded for this version.");
  await expect(d3.getByRole("table", { name: "Version history" })).toContainText("ref RACE-1");
  await expect(race.page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await race.context.close();

  // a role that cannot approve sees the reason, not the form
  const noApprove = await setup({ permissions: ALL_PERMISSIONS.filter((p) => p !== "admin.settings.approve") });
  await login(noApprove.page);
  await go(noApprove.page, "Settings");
  await noApprove.page.getByRole("button", { name: "Review sharing.otp_seconds version 1" }).click();
  await expect(noApprove.page.getByText("Your admin role cannot approve or reject settings.")).toBeVisible();
  await noApprove.context.close();
});

test("P9-ADMIN-WEB-07 serious rules: admin editing is shown as NOT clinical approval, the approval cannot be set, and the request carries no approval field", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await go(page, "Serious rules");
  await expect(page.getByRole("heading", { name: "Serious-finding rules" })).toBeVisible();
  const banner = page.getByRole("note", { name: "Admin editing is NOT clinical approval" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("never changes that");
  await expect(banner).toContainText("CFG-06");
  const list = page.getByRole("region", { name: "Rule list" });
  await expect(list.getByRole("row")).toHaveCount(4);
  await expect(list.getByRole("row").nth(1)).toContainText("not clinically approved");
  await page.getByLabel("Rule ID").first().fill("lab");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByText("A rule ID uses capital letters")).toBeVisible();
  await page.getByLabel("Rule ID").first().fill("LAB_POTASSIUM_RANGE");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(list.getByRole("row")).toHaveCount(2);
  assert.equal(calls.filter((c) => c.path === "/api/v1/admin/rules").at(-1)!.query.get("rule_id"), "LAB_POTASSIUM_RANGE");
  await page.getByRole("button", { name: "Open LAB_POTASSIUM_RANGE version 1" }).click();
  const detail = page.getByRole("complementary", { name: "Rule detail" });
  await expect(detail).toContainText("potassium is outside 3.5 to 5.1 mmol/L");
  await expect(detail).toContainText("not clinically approved");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open LAB_GLUCOSE_HIGH version 1" }).click();
  await expect(detail).toContainText("fasting: yes");
  // the form has no editable approval field
  const form = page.getByRole("form", { name: "New rule version" });
  const approval = form.getByLabel("Clinical approval");
  await expect(approval).toBeDisabled();
  await expect(approval).toHaveValue("Not clinically approved");
  const editable = await form.evaluate((f) => [...f.querySelectorAll<HTMLInputElement>("input,select,textarea")].filter((el) => !el.disabled).map((el) => el.labels?.[0]?.textContent ?? ""));
  assert.ok(editable.length >= 5 && editable.every((t) => !/approv|clinical|valid|sign|status/i.test(t)), "editable fields: " + editable.join(", "));
  // validation messages
  const check = () => form.getByRole("button", { name: "Review rule" }).click();
  await check();
  await expect(page.getByRole("alert")).toContainText("The rule ID must be 3 to 80 characters");
  await form.getByLabel("Rule ID").fill("LAB_GLUCOSE_HIGH");
  await form.getByLabel("Field", { exact: true }).fill("glucose");
  await form.getByLabel("Units").fill("mg/dL");
  await check();
  await expect(page.getByRole("alert")).toContainText("Choose how the value is compared.");
  await form.getByLabel("Comparison").selectOption("between");
  await form.getByLabel("Lower bound").fill("100");
  await form.getByLabel("Upper bound").fill("50");
  await check();
  await expect(page.getByRole("alert")).toContainText("The first bound cannot be larger than the second.");
  await form.getByLabel("Comparison").selectOption("gt");
  await expect(form.getByLabel("Upper bound")).toHaveCount(0);
  await form.getByLabel("Bound", { exact: true }).fill("abc");
  await check();
  await expect(page.getByRole("alert")).toContainText("Each bound must be a number");
  assert.equal(posts(calls).length, 0);
  // create, with a confirmation step
  await form.getByLabel("Bound", { exact: true }).fill("250");
  await form.getByLabel("Context name 1").fill("fasting");
  await form.getByLabel("Context value 1").fill("no");
  await check();
  await expect(form.getByRole("heading", { name: "Save this rule version?" })).toBeVisible();
  await expect(form).toContainText("recorded as not clinically approved");
  assert.equal(posts(calls).length, 0, "nothing is sent until the admin confirms");
  await form.getByRole("button", { name: "Confirm save" }).click();
  await expect(page.getByText("Saved as version 3 of LAB_GLUCOSE_HIGH. It is recorded as not clinically approved.")).toBeVisible();
  assert.equal(posts(calls).length, 1);
  const sent = JSON.parse(posts(calls)[0].body!);
  assert.deepEqual(Object.keys(sent).sort(), ["definition", "rule_id"]);
  assert.deepEqual(Object.keys(sent.definition).sort(), ["bounds", "context", "field", "operator", "units"]);
  assert.deepEqual(sent.definition, { field: "glucose", units: "mg/dL", operator: "gt", bounds: [250], context: { fasting: "no" } });
  assert.ok(!/approv|clinical/i.test(posts(calls)[0].body!), "the request never mentions approval");
  await expect(list.getByRole("row")).toHaveCount(5);
  await expect(detail).toContainText("v3");
  await expect(detail).toContainText("not clinically approved");
  await noLeaks(page);
  await context.close();

  // if a request ever carried an approval field, the backend refuses and the screen says so
  const refused = await setup({ rulesForbidden: true });
  await login(refused.page);
  await go(refused.page, "Serious rules");
  const f2 = refused.page.getByRole("form", { name: "New rule version" });
  await f2.getByLabel("Rule ID").fill("NEW_RULE");
  await f2.getByLabel("Field", { exact: true }).fill("ph");
  await f2.getByLabel("Units").fill("pH");
  await f2.getByLabel("Comparison").selectOption("lt");
  await f2.getByLabel("Bound", { exact: true }).fill("7");
  await f2.getByRole("button", { name: "Review rule" }).click();
  await f2.getByRole("button", { name: "Confirm save" }).click();
  await expect(refused.page.getByRole("alert")).toContainText("Clinical approval cannot be set from the Admin Dashboard.");
  await refused.context.close();

  const readOnly = await setup({ permissions: ALL_PERMISSIONS.filter((p) => p !== "admin.rules.create") });
  await login(readOnly.page);
  await go(readOnly.page, "Serious rules");
  await expect(readOnly.page.getByText("Your admin role cannot create rule versions.")).toBeVisible();
  await expect(readOnly.page.getByRole("form", { name: "New rule version" })).toHaveCount(0);
  await readOnly.context.close();
});

test("P9-ADMIN-WEB-08 system health: every component shows its status and reason in plain words, and no address, key or error text appears", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await go(page, "System health");
  await expect(page.getByRole("heading", { name: "System health" })).toBeVisible();
  await expect(page.getByLabel("Overall health")).toContainText("Degraded");
  await expect(page.getByLabel("Overall health")).toContainText("Something needs attention");
  await expect(page.getByLabel("Overall health")).toContainText("2026-02-10 12:00 UTC");
  const table = page.getByRole("table", { name: "Components" });
  await expect(table.getByRole("row")).toHaveCount(8);
  const row = (name: string) => table.getByRole("row", { name });
  await expect(row(/^Database OK/)).toContainText("OK");
  await expect(row(/^Database OK/)).toContainText("latency ms: 4");
  await expect(row(/Database migrations/)).toContainText("applied: 19");
  await expect(row(/Document processing queue/)).toContainText("Degraded");
  await expect(row(/Document processing queue/)).toContainText("Jobs are stuck");
  await expect(row(/Document processing queue/)).toContainText("expired leases: 1");
  await expect(row(/Text reading/)).toContainText("Down");
  await expect(row(/Text reading/)).toContainText("Could not connect to the service");
  await expect(row(/Summary service/)).toContainText("OK");
  await expect(row(/Summary service/)).toContainText("only reachability is known");
  await expect(row(/Question answering/)).toContainText("Not configured");
  await expect(row(/Question answering/)).toContainText("No address is set for this service");
  const text = await page.locator("body").innerText();
  for (const word of ["LEAK", "secret-path", "http://"]) assert.ok(!text.includes(word), "the page shows " + word);
  const before = calls.filter((c) => c.path.endsWith("/admin/health")).length;
  await page.getByRole("button", { name: "Run checks again" }).click();
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/admin/health")).length).toBeGreaterThan(before);
  await context.close();

  const down = await setup({ healthFails: true });
  await login(down.page);
  await go(down.page, "System health");
  await expect(down.page.getByRole("alert")).toContainText("The service is unavailable right now.");
  await down.context.close();
});

test("P9-ADMIN-WEB-09 audit log: filters and paging work, the chain result is clearly intact or broken, and details show redacted scopes only", async () => {
  const { page, context, calls, extra } = await setup();
  await login(page);
  await go(page, "Audit log");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  const chain = page.getByRole("region", { name: "Audit chain check" });
  await expect(chain).toContainText("Audit chain: INTACT.");
  await expect(chain).toContainText("All 40 events passed the check");
  await expect(chain).not.toContainText("BROKEN");
  const last = () => calls.filter((c) => c.path === "/api/v1/admin/audit").at(-1)!;
  assert.equal(last().query.get("limit"), "15");
  assert.equal(last().query.get("cursor"), null);
  const rows = page.getByRole("region", { name: "Event list" }).getByRole("row");
  await expect(rows).toHaveCount(16);
  await expect(rows.nth(1)).toContainText("40");
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  assert.equal(last().query.get("cursor"), "c15");
  await expect(chain).toContainText("Audit chain: INTACT.");
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(rows).toHaveCount(11);
  await expect(page.getByRole("button", { name: "Next →" })).toBeDisabled();
  await page.getByRole("button", { name: "← Previous" }).click();
  await page.getByRole("button", { name: "← Previous" }).click();
  // filters
  await page.getByLabel("Outcome").selectOption("denied");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const denied = extra.audit.filter((e) => e.outcome === "denied").length;
  await expect(rows).toHaveCount(denied + 1);
  assert.equal(last().query.get("outcome"), "denied");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Action").fill("admin.settings.change");
  await page.getByLabel("Target type").fill("setting");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(rows).toHaveCount(extra.audit.filter((e) => e.action === "admin.settings.change").length + 1);
  assert.deepEqual([last().query.get("action"), last().query.get("target_type")], ["admin.settings.change", "setting"]);
  await page.getByRole("button", { name: "Reset" }).click();
  for (const [label, value, message] of [
    ["Admin ID", "abc", "The admin ID must be a full ID"],
    ["Action", "Patients", "The action must look like admin.patients.read"],
    ["Target type", "Patient Account", "The target type uses lower-case letters"],
  ] as const) {
    await page.getByLabel(label).fill(value);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("alert")).toContainText(message);
    await page.getByRole("button", { name: "Reset" }).click();
  }
  await page.getByLabel("From (UTC)").fill("2026-02-10T12:00");
  await page.getByLabel("To (UTC)").fill("2026-02-10T11:00");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("alert")).toContainText("“From” cannot be later than “To”.");
  await page.getByLabel("From (UTC)").fill("2026-02-10T11:30");
  await page.getByLabel("To (UTC)").fill("2026-02-10T12:00");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(rows).toHaveCount(16);
  assert.deepEqual([last().query.get("from"), last().query.get("to")], ["2026-02-10T11:30:00Z", "2026-02-10T12:00:00Z"]);
  await page.getByRole("button", { name: "Reset" }).click();
  // detail
  await page.getByRole("button", { name: "Open event 40" }).click();
  const detail = page.getByRole("complementary", { name: "Event detail" });
  await expect(detail).toContainText("admin.patients.read");
  await expect(detail).toContainText("2026-02-10 12:00 UTC");
  await expect(detail.getByLabel("Event scope")).toContainText('"returned": 3');
  await noLeaks(page);
  assert.ok(posts(calls).length === 0 && calls.every((c) => c.method === "GET" || c.path.endsWith("/login")), "the audit log is read only");
  await context.close();

  const broken = await setup({ brokenChain: true });
  await login(broken.page);
  await go(broken.page, "Audit log");
  const alert = broken.page.getByRole("region", { name: "Audit chain check" }).getByRole("alert");
  await expect(alert).toContainText("Audit chain: BROKEN.");
  await expect(alert).toContainText("number 17");
  await expect(alert).toContainText("40 events checked");
  await expect(broken.page.getByText("INTACT")).toHaveCount(0);
  await broken.context.close();
});

test("P9-ADMIN-WEB-10 the new screens fit a laptop, take keyboard focus, keep nothing in browser storage, and a rejected token returns to sign-in", async () => {
  const { page, context, calls } = await setup({ viewport: { width: 1280, height: 720 } });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  assert.ok(await fits(), "the nine-item menu fits 1280 px");
  const screens: [string, string][] = [
    ["Guardians", "Guardian relationships"], ["Share grants", "Doctor share grants"], ["Deliveries", "Email and notification delivery"],
    ["Settings", "Operational settings"], ["Serious rules", "Serious-finding rules"], ["System health", "System health"], ["Audit log", "Audit log"],
  ];
  for (const [item, heading] of screens) {
    await go(page, item);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    assert.ok(await fits(), item + " fits 1280 px");
  }
  await go(page, "Settings");
  await page.getByRole("button", { name: "Open setting auth.access_token_seconds" }).click();
  await expect(page.getByRole("complementary", { name: "Setting detail" })).toContainText("Version history");
  assert.ok(await fits(), "settings with the history open");
  const box = await page.getByRole("complementary", { name: "Setting detail" }).boundingBox();
  assert.ok(box && box.width >= 300, "the detail panel is wide enough to read");
  await go(page, "Audit log");
  await page.getByRole("button", { name: "Open event 40" }).click();
  assert.ok(await fits(), "audit with the detail open");
  await page.getByLabel("Admin ID").focus();
  await page.keyboard.press("Tab");
  assert.ok(["INPUT", "SELECT", "BUTTON"].includes(await page.evaluate(() => document.activeElement?.tagName ?? "")));
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  assert.ok(calls.every((c) => c.path.startsWith("/api/v1/admin/")), "only admin endpoints are used");
  assert.ok(!calls.some((c) => /documents|download|summary-jobs|rag|doctor|timeline/.test(c.path.replace("/processing/summary", ""))));
  await context.close();

  const rejected = await setup({ rejectAfter: 300 });
  await signIn(rejected.page);
  await expect(rejected.page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await rejected.page.waitForTimeout(500);
  await go(rejected.page, "Settings");
  await expect(rejected.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(rejected.page.getByText("Your session is no longer valid. Sign in again.")).toBeVisible();
  await expect(rejected.page.getByRole("heading", { name: "Operational settings" })).toHaveCount(0);
  await rejected.context.close();
});

test("R8-ADMIN-WEB-01 admin dashboard: sign-in and every screen pass the accessibility checks", async () => {
  const { page, context } = await setup({ viewport: { width: 1280, height: 720 } });
  const summary: Record<string, unknown> = {};
  const problems: string[] = [];
  const signin = await scanAccessibility(page);
  summary["sign-in"] = { checked: signin.checked, lowestContrast: signin.lowestContrast };
  problems.push(...signin.issues.map((x) => "sign-in: " + x));
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  const first = await scanAccessibility(page);
  summary["Patient accounts"] = { checked: first.checked, lowestContrast: first.lowestContrast };
  problems.push(...first.issues.map((x) => "Patient accounts: " + x));
  const screens: [string, string][] = [
    ["Processing", "Document processing"], ["Guardians", "Guardian relationships"], ["Share grants", "Doctor share grants"],
    ["Deliveries", "Email and notification delivery"], ["Settings", "Operational settings"], ["Serious rules", "Serious-finding rules"],
    ["System health", "System health"], ["Audit log", "Audit log"],
  ];
  for (const [item, heading] of screens) {
    await go(page, item);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    const result = await scanAccessibility(page);
    summary[item] = { checked: result.checked, lowestContrast: result.lowestContrast };
    problems.push(...result.issues.map((x) => item + ": " + x));
  }
  console.log("R8_A11Y_ADMIN " + JSON.stringify(summary));
  await context.close();
  assert.deepEqual(problems, []);
});

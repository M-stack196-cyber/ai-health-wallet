import type { PatientDatabase } from "../patients/repository.js";
import { transaction } from "../auth/security-repository.js";
import { ApiError } from "../http/errors.js";
import { writeAdminAudit, type AdminContext } from "./repository.js";

/** Release gate recorded in the SRS for the parameter group a setting belongs to. Only settings whose group names a review are gated. */
export interface SettingGate { cfg: string; requirement: string; }
export interface SettingSpec { key: string; unit: string; min: number; max: number; default: number; source: string; gate: SettingGate | null; }
const security = { cfg: "CFG-16", requirement: "Security review and negative-path tests required before release." };
const otp = { cfg: "CFG-04", requirement: "Security-review and negative testing." };

/** The complete allowlist. Bounds and defaults mirror the runtime validators (checked by a test), so an accepted value cannot stop a service from starting.
 * Digest hours (CFG-15) and upload limits (CFG-03) carry no approval requirement in the SRS, so they are not gated. */
export const settingRegistry: readonly SettingSpec[] = [
  { key: "guardian.digest_window_hours", unit: "hours", min: 1, max: 168, default: 24, source: "CFG-15", gate: null },
  { key: "documents.max_upload_bytes", unit: "bytes", min: 1024, max: 20971520, default: 5242880, source: "CFG-03", gate: null },
  { key: "documents.max_concurrent_uploads", unit: "uploads", min: 1, max: 4, default: 2, source: "CFG-03", gate: null },
  { key: "documents.upload_rate_limit_max", unit: "requests", min: 1, max: 100, default: 20, source: "CFG-03", gate: null },
  { key: "documents.max_pdf_pages", unit: "pages", min: 1, max: 200, default: 100, source: "CFG-03", gate: null },
  { key: "auth.access_token_seconds", unit: "seconds", min: 60, max: 3600, default: 900, source: "CFG-16", gate: security },
  { key: "auth.verification_seconds", unit: "seconds", min: 60, max: 86400, default: 86400, source: "CFG-16", gate: security },
  { key: "auth.reset_seconds", unit: "seconds", min: 60, max: 1800, default: 900, source: "CFG-16", gate: security },
  { key: "auth.refresh_idle_seconds", unit: "seconds", min: 60, max: 604800, default: 604800, source: "CFG-16", gate: security },
  { key: "auth.refresh_absolute_seconds", unit: "seconds", min: 300, max: 2592000, default: 2592000, source: "CFG-16", gate: security },
  { key: "sharing.otp_seconds", unit: "seconds", min: 1, max: 1800, default: 600, source: "CFG-04", gate: otp },
];
const specs = new Map(settingRegistry.map(spec => [spec.key, spec]));
export const settingSpec = (key: string) => specs.get(key);
/** Keys are echoed into the audit log only when they are well-formed; anything else is recorded as malformed without the text. */
export const wellFormedKey = (key: unknown): key is string => typeof key === "string" && /^[a-z]+(\.[a-z_]+){1,2}$/.test(key) && key.length <= 64;

export type VersionStatus = "effective" | "superseded" | "pending_approval" | "rejected";
export interface SettingVersion {
  version: number; value: number; status: VersionStatus; requires_approval: boolean; gate: string | null; proposed_by: string; proposed_at: Date;
  decision: null | { decision: "approved" | "rejected"; decided_by: string; reference: string; decided_at: Date };
}
const invalidValue = (message: string) => new ApiError(400, "INVALID_SETTING_VALUE", message);

export function validateSettingValue(spec: SettingSpec, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidValue("The value must be a whole number.");
  if (value < spec.min || value > spec.max) throw invalidValue("The value must be between " + spec.min + " and " + spec.max + " " + spec.unit + ".");
  return value;
}
export function validateDecision(body: unknown): { decision: "approved" | "rejected"; reference: string } {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!input || Object.keys(input).sort().join(",") !== "decision,reference" || (input.decision !== "approved" && input.decision !== "rejected")
    || typeof input.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,119}$/.test(input.reference)) {
    throw new ApiError(400, "INVALID_INPUT", "Request fields are missing, invalid or not permitted.");
  }
  return { decision: input.decision, reference: input.reference };
}

type Effective = Map<string, { version: number; value: number }>;
export function createAdminSettings(db: PatientDatabase) {
  async function effective(q: Pick<PatientDatabase, "query"> = db): Promise<Effective> {
    const rows = (await q.query<{ setting_key: string; version: number; value: number }>("SELECT setting_key,version,value FROM public.admin_setting_effective", [])).rows;
    return new Map(rows.map(row => [row.setting_key, { version: row.version, value: Number(row.value) }]));
  }
  const current = (spec: SettingSpec, map: Effective) => map.get(spec.key)?.value ?? spec.default;
  /** Idle refresh lifetime may never exceed the absolute one, judged against the values currently in effect. */
  function crossCheck(key: string, value: number, map: Effective): void {
    const get = (other: string) => map.get(other)?.value ?? specs.get(other)!.default;
    if ((key === "auth.refresh_idle_seconds" && value > get("auth.refresh_absolute_seconds")) || (key === "auth.refresh_absolute_seconds" && value < get("auth.refresh_idle_seconds"))) {
      throw invalidValue("The idle refresh lifetime cannot exceed the absolute refresh lifetime.");
    }
  }
  async function history(q: Pick<PatientDatabase, "query">, key: string): Promise<SettingVersion[]> {
    const rows = (await q.query<{ version: number; value: number; requires_approval: boolean; gate: string | null; proposed_by: string; proposed_at: Date; decision: string | null; decided_by: string | null; reference: string | null; decided_at: Date | null; effective: boolean }>(
      `SELECT v.version,v.value,v.requires_approval,v.gate,v.proposed_by,v.proposed_at,d.decision,d.decided_by,d.reference,d.decided_at,(e.version_id IS NOT NULL) AS effective
       FROM public.admin_setting_versions v LEFT JOIN public.admin_setting_decisions d ON d.version_id=v.id LEFT JOIN public.admin_setting_effective e ON e.version_id=v.id
       WHERE v.setting_key=$1 ORDER BY v.version DESC`, [key])).rows;
    return rows.map(row => ({ version: row.version, value: Number(row.value), requires_approval: row.requires_approval, gate: row.gate, proposed_by: row.proposed_by, proposed_at: row.proposed_at,
      status: row.decision === "rejected" ? "rejected" : row.requires_approval && row.decision !== "approved" ? "pending_approval" : row.effective ? "effective" : "superseded",
      decision: row.decision ? { decision: row.decision as "approved" | "rejected", decided_by: row.decided_by!, reference: row.reference!, decided_at: row.decided_at! } : null }));
  }
  const view = (spec: SettingSpec, map: Effective, pending: number) => ({ key: spec.key, unit: spec.unit, min: spec.min, max: spec.max, default: spec.default, source: spec.source,
    gate: spec.gate, value: current(spec, map), version: map.get(spec.key)?.version ?? 0, pending_versions: pending });
  return {
    async list() {
      const map = await effective();
      const pending = new Map((await db.query<{ setting_key: string; n: number }>(`SELECT v.setting_key,count(*)::int AS n FROM public.admin_setting_versions v
        WHERE v.requires_approval AND NOT EXISTS(SELECT 1 FROM public.admin_setting_decisions d WHERE d.version_id=v.id) GROUP BY 1`, [])).rows.map(row => [row.setting_key, row.n]));
      return settingRegistry.map(spec => view(spec, map, pending.get(spec.key) ?? 0));
    },
    async get(key: string) {
      const spec = specs.get(key);
      if (!spec) return undefined;
      const map = await effective(), versions = await history(db, key);
      return { ...view(spec, map, versions.filter(v => v.status === "pending_approval").length), history: versions };
    },
    /** Appends a new version. Ungated settings take effect immediately; gated ones wait for a decision by a different admin.
     * The audit row is written in the same transaction as the version. */
    async propose(admin: AdminContext, spec: SettingSpec, value: number) {
      const base = { actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.settings.change", targetType: "setting", targetId: spec.key, requestId: admin.requestId };
      return transaction(db, async c => {
        await c.query("SELECT pg_advisory_xact_lock(1095260233, hashtext($1))", ["admin_setting:" + spec.key]);
        const map = await effective(c), previous = current(spec, map);
        try { crossCheck(spec.key, value, map); } catch (error) {
          await writeAdminAudit(c, { ...base, scope: { reason: "invalid_value", value }, outcome: "failure" });
          return { outcome: "invalid" as const, error: error as ApiError };
        }
        if (value === previous) {
          await writeAdminAudit(c, { ...base, scope: { reason: "unchanged", value }, outcome: "failure" });
          return { outcome: "unchanged" as const };
        }
        const version = ((await c.query<{ v: number }>("SELECT COALESCE(max(version),0)::int AS v FROM public.admin_setting_versions WHERE setting_key=$1", [spec.key])).rows[0].v) + 1;
        await c.query(`INSERT INTO public.admin_setting_versions(setting_key,version,value,requires_approval,gate,proposed_by) VALUES($1,$2,$3::jsonb,$4,$5,$6)`,
          [spec.key, version, JSON.stringify(value), spec.gate !== null, spec.gate?.cfg ?? null, admin.adminId]);
        const status = spec.gate ? "pending_approval" : "effective";
        await writeAdminAudit(c, { ...base, scope: { version, previous, value, gate: spec.gate?.cfg ?? null, status }, outcome: "success" });
        return { outcome: "created" as const, version, status };
      });
    },
    /** One recorded decision per gated version. A different admin must approve; self-approval is refused here and by a database trigger. */
    async decide(admin: AdminContext, spec: SettingSpec, version: number, decision: "approved" | "rejected", reference: string) {
      const base = { actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.settings.decide", targetType: "setting", targetId: spec.key, requestId: admin.requestId };
      return transaction(db, async c => {
        await c.query("SELECT pg_advisory_xact_lock(1095260233, hashtext($1))", ["admin_setting:" + spec.key]);
        const row = (await c.query<{ id: string; value: number; requires_approval: boolean; proposed_by: string; decided: boolean }>(
          `SELECT v.id,v.value,v.requires_approval,v.proposed_by,EXISTS(SELECT 1 FROM public.admin_setting_decisions d WHERE d.version_id=v.id) AS decided
           FROM public.admin_setting_versions v WHERE v.setting_key=$1 AND v.version=$2`, [spec.key, version])).rows[0];
        const refuse = async (outcome: "failure" | "denied", reason: string, result: { outcome: "not_found" | "not_required" | "decided" | "superseded" | "self_approval" | "invalid" }) => {
          await writeAdminAudit(c, { ...base, scope: { version, decision, reason }, outcome });
          return result;
        };
        if (!row) return refuse("failure", "not_found", { outcome: "not_found" });
        if (!row.requires_approval) return refuse("failure", "approval_not_required", { outcome: "not_required" });
        if (row.decided) return refuse("failure", "already_decided", { outcome: "decided" });
        if (decision === "approved" && row.proposed_by === admin.adminId) return refuse("denied", "self_approval", { outcome: "self_approval" });
        const map = await effective(c);
        if (decision === "approved" && (map.get(spec.key)?.version ?? 0) > version) return refuse("failure", "superseded", { outcome: "superseded" });
        if (decision === "approved") { try { crossCheck(spec.key, Number(row.value), map); } catch { return refuse("failure", "invalid_value", { outcome: "invalid" }); } }
        await c.query("INSERT INTO public.admin_setting_decisions(version_id,decision,decided_by,reference) VALUES($1,$2,$3,$4)", [row.id, decision, admin.adminId, reference]);
        await writeAdminAudit(c, { ...base, scope: { version, decision, gate: spec.gate?.cfg ?? null }, outcome: "success" });
        return { outcome: "decided_ok" as const };
      });
    },
    effective,
  };
}

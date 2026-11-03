import type { Router } from "express";
import { ApiError } from "../http/errors.js";
import type { PatientDatabase } from "../patients/repository.js";
import { rejectQueryParameters, rejectRequestBody, requireJson } from "../auth/middleware.js";
import type { createAdminTokenService } from "./tokens.js";
import type { createAdminRepository } from "./repository.js";
import { adminIdentity, requireAdmin } from "./middleware.js";
import { createAdminSettings, settingSpec, validateDecision, validateSettingValue, wellFormedKey } from "./settings.js";
import { clinicalApprovalForbidden, createAdminRules, ruleIdParameter, ruleListQuery, validateRuleInput } from "./rules.js";

/** Phase 5 routes: versioned operational settings (allowlist, release-gate approval) and inert serious-rule versions. */
export function mountConfigRoutes(router: Router, deps: { database: PatientDatabase; tokens: ReturnType<typeof createAdminTokenService>; repository: ReturnType<typeof createAdminRepository> }) {
  const { tokens, repository } = deps, settings = createAdminSettings(deps.database), rules = createAdminRules(deps.database);
  const guard = (permission: string) => requireAdmin(tokens, repository, permission);
  const record = (admin: ReturnType<typeof adminIdentity>, action: string, target: string, outcome: "success" | "denied" | "failure", scope: Record<string, unknown>, targetId?: string) =>
    repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action, targetType: target, targetId, scope, outcome, requestId: admin.requestId });
  const keyOf = (value: unknown) => wellFormedKey(value) ? value : undefined;

  router.get("/settings", rejectQueryParameters, rejectRequestBody, guard("admin.settings.read"), async (req, res) => {
    const admin = adminIdentity(req), list = await settings.list();
    await record(admin, "admin.settings.read", "setting", "success", { view: "list", returned: list.length });
    res.status(200).json({ success: true, settings: list });
  });
  router.get("/settings/:key", rejectQueryParameters, rejectRequestBody, guard("admin.settings.read"), async (req, res) => {
    const admin = adminIdentity(req), key = keyOf(req.params.key), found = key ? await settings.get(key) : undefined;
    await record(admin, "admin.settings.read", "setting", found ? "success" : "failure", found ? { view: "detail" } : { view: "detail", reason: "not_found" }, key);
    if (!found) throw new ApiError(404, "NOT_FOUND", "Setting not found.");
    res.status(200).json({ success: true, setting: found });
  });
  router.post("/settings/:key/versions", rejectQueryParameters, requireJson, guard("admin.settings.change"), async (req, res) => {
    const admin = adminIdentity(req), key = keyOf(req.params.key), spec = key ? settingSpec(key) : undefined;
    if (!spec) {
      // Only approved settings can be changed; the attempt itself is the audit event.
      await record(admin, "admin.settings.change", "setting", "denied", { reason: key ? "not_in_allowlist" : "malformed_key" }, key);
      throw new ApiError(403, "SETTING_NOT_PERMITTED", "This setting cannot be changed from the Admin Dashboard.");
    }
    const body = req.body as Record<string, unknown> | undefined;
    let value: number;
    try {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "value") throw new ApiError(400, "INVALID_INPUT", "Request fields are missing, invalid or not permitted.");
      value = validateSettingValue(spec, body.value);
    } catch (error) {
      await record(admin, "admin.settings.change", "setting", "failure", { reason: "invalid_value", type: body && typeof body === "object" ? typeof (body as Record<string, unknown>).value : "none" }, spec.key);
      throw error;
    }
    const result = await settings.propose(admin, spec, value);
    if (result.outcome === "invalid") throw result.error;
    if (result.outcome === "unchanged") throw new ApiError(409, "SETTING_UNCHANGED", "The value is already in effect.");
    res.status(201).json({ success: true, setting: await settings.get(spec.key), version: result.version, status: result.status });
  });
  router.post("/settings/:key/versions/:version/decision", rejectQueryParameters, requireJson, guard("admin.settings.approve"), async (req, res) => {
    const admin = adminIdentity(req), key = keyOf(req.params.key), spec = key ? settingSpec(key) : undefined, version = /^\d{1,6}$/.test(String(req.params.version)) ? Number(req.params.version) : 0;
    if (!spec) {
      await record(admin, "admin.settings.decide", "setting", "denied", { reason: key ? "not_in_allowlist" : "malformed_key" }, key);
      throw new ApiError(403, "SETTING_NOT_PERMITTED", "This setting cannot be changed from the Admin Dashboard.");
    }
    if (version < 1) throw new ApiError(400, "INVALID_INPUT", "Request fields are missing, invalid or not permitted.");
    const input = validateDecision(req.body), result = await settings.decide(admin, spec, version, input.decision, input.reference);
    if (result.outcome === "not_found") throw new ApiError(404, "NOT_FOUND", "Setting version not found.");
    if (result.outcome === "not_required") throw new ApiError(409, "APPROVAL_NOT_REQUIRED", "This setting version is not release-gated.");
    if (result.outcome === "decided") throw new ApiError(409, "DECISION_EXISTS", "A decision is already recorded for this version.");
    if (result.outcome === "superseded") throw new ApiError(409, "VERSION_SUPERSEDED", "A newer version is already in effect.");
    if (result.outcome === "invalid") throw new ApiError(400, "INVALID_SETTING_VALUE", "The idle refresh lifetime cannot exceed the absolute refresh lifetime.");
    if (result.outcome === "self_approval") throw new ApiError(403, "SELF_APPROVAL_FORBIDDEN", "A change cannot be approved by the admin who proposed it.");
    res.status(200).json({ success: true, setting: await settings.get(spec.key) });
  });

  router.get("/rules", guard("admin.rules.read"), async (req, res) => {
    const admin = adminIdentity(req), parsed = ruleListQuery(req.query), page = await rules.list(parsed);
    await record(admin, "admin.rules.read", "serious_rule", "success", { view: "list", filters: Object.keys(parsed.filters).sort(), limit: parsed.limit, returned: page.rows.length });
    res.status(200).json({ success: true, rules: page.rows, next_cursor: page.nextCursor });
  });
  router.get("/rules/:id", rejectQueryParameters, rejectRequestBody, guard("admin.rules.read"), async (req, res) => {
    const admin = adminIdentity(req), id = ruleIdParameter(req.params.id), rule = await rules.get(id);
    await record(admin, "admin.rules.read", "serious_rule", rule ? "success" : "failure", rule ? { view: "detail" } : { view: "detail", reason: "not_found" }, id);
    if (!rule) throw new ApiError(404, "NOT_FOUND", "Rule version not found.");
    res.status(200).json({ success: true, rule });
  });
  router.post("/rules", rejectQueryParameters, requireJson, guard("admin.rules.create"), async (req, res) => {
    const admin = adminIdentity(req);
    let input;
    try { input = validateRuleInput(req.body); } catch (error) {
      const forbidden = error === undefined || (error instanceof ApiError && error.code === clinicalApprovalForbidden().code);
      await record(admin, "admin.rules.create", "serious_rule", forbidden ? "denied" : "failure", { reason: forbidden ? "clinical_approval_not_permitted" : "invalid_rule" });
      throw error;
    }
    const id = await rules.create(admin, input);
    res.status(201).json({ success: true, rule: await rules.get(id) });
  });
}

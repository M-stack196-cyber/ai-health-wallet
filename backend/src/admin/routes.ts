import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import type { AuthenticationConfig } from "../config/auth.js";
import { ApiError } from "../http/errors.js";
import type { PatientDatabase } from "../patients/repository.js";
import { validateLogin } from "../patients/validation.js";
import { rejectQueryParameters, rejectRequestBody, requireJson } from "../auth/middleware.js";
import { createPasswordService } from "../auth/passwords.js";
import { rateHash } from "../auth/security-repository.js";
import type { AdminAuthenticationConfig } from "./config.js";
import { createAdminTokenService } from "./tokens.js";
import { createAdminRepository } from "./repository.js";
import { adminIdentity, requireAdmin } from "./middleware.js";
import { mountConfigRoutes } from "./config-routes.js";
import { mountOpsRoutes } from "./ops-routes.js";
import type { HealthOptions } from "./health.js";
import { createAdminStatusViews, deliveryQuery, guardianQuery, shareQuery, statusIdParameter } from "./status-views.js";
import { createAdminProcessingJobs, jobIdParameter, validateJobListQuery } from "./processing-jobs.js";
import { createAdminPatientAccounts, patientIdParameter, validatePatientListQuery, type StatusAction } from "./patient-accounts.js";

const denied = () => new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials or authorization.");

/** `auth` supplies only the Argon2id cost settings; admin tokens use the separate admin configuration. */
export interface AdminRouteOptions { health?: HealthOptions; }
export function createAdminRoutes(database: PatientDatabase, auth: AuthenticationConfig, config: AdminAuthenticationConfig, options: AdminRouteOptions = {}) {
  const router = Router(), repository = createAdminRepository(database), tokens = createAdminTokenService(config);
  const passwords = createPasswordService(auth), accounts = createAdminPatientAccounts(database), jobs = createAdminProcessingJobs(database), status = createAdminStatusViews(database);
  const limiter = rateLimit({ windowMs: config.rateWindowSeconds * 1000, limit: config.rateLimitMax * 4, standardHeaders: "draft-8",
    legacyHeaders: false, validate: { xForwardedForHeader: false },
    message: { success: false, error: { code: "RATE_LIMITED", message: "Too many authentication attempts. Try again later." } } });
  async function rate(req: Request, subject: string): Promise<void> {
    // Persisted buckets work across API instances and store neither the raw address nor the raw email.
    for (const key of [rateHash(config.jwtKey, "admin_login:ip", req.ip ?? "unknown"), rateHash(config.jwtKey, "admin_login:subject", subject)]) {
      if (!await repository.rate(key, config.rateLimitMax, config.rateWindowSeconds)) {
        throw new ApiError(429, "RATE_LIMITED", "Too many authentication attempts. Try again later.");
      }
    }
  }
  router.post("/auth/login", rejectQueryParameters, limiter, requireJson, async (req, res) => {
    const input = validateLogin(req.body), requestId = randomUUID();
    await rate(req, input.email);
    const account = await repository.credentials(input.email);
    const valid = await passwords.verify(input.password, account?.password_hash);
    if (!account || !valid || account.status !== "active") {
      if (account) await repository.deniedLogin(account, requestId);
      throw denied();
    }
    const session = await repository.login(account, config.jwtLifetimeSeconds, requestId);
    if (!session) throw denied();
    res.status(200).json({ success: true, access_token: await tokens.issue(session.adminId, session.sessionId),
      token_type: "Bearer", expires_in: config.jwtLifetimeSeconds });
  });
  router.get("/me", rejectQueryParameters, rejectRequestBody, requireAdmin(tokens, repository, "admin.profile.read"), async (req, res) => {
    const admin = adminIdentity(req);
    // The response is released only after its audit event is stored.
    await repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.profile.read",
      targetType: "admin_account", targetId: admin.adminId, outcome: "success", requestId: admin.requestId });
    res.status(200).json({ success: true, admin: { id: admin.adminId, email: admin.email, full_name: admin.fullName,
      role: admin.role, permissions: admin.permissions } });
  });
  const read = requireAdmin(tokens, repository, "admin.patients.read");
  router.get("/patients", read, async (req, res) => {
    const admin = adminIdentity(req), query = validatePatientListQuery(req.query);
    const page = await accounts.list(query);
    // Raw search text may be an email address, so the audit row keeps only the filter shape.
    await repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.patients.read", targetType: "patient_account",
      scope: { status: query.status ?? null, verified: query.verified ?? null, query_length: query.q?.length ?? 0, limit: query.limit, returned: page.patients.length },
      outcome: "success", requestId: admin.requestId });
    res.status(200).json({ success: true, patients: page.patients, next_cursor: page.nextCursor });
  });
  router.get("/patients/:id", rejectQueryParameters, rejectRequestBody, read, async (req, res) => {
    const admin = adminIdentity(req), id = patientIdParameter(req.params.id), patient = await accounts.get(id);
    await repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.patients.read", targetType: "patient_account", targetId: id,
      scope: patient ? {} : { reason: "not_found" }, outcome: patient ? "success" : "failure", requestId: admin.requestId });
    if (!patient) throw new ApiError(404, "NOT_FOUND", "Patient account not found.");
    res.status(200).json({ success: true, patient });
  });
  for (const action of ["suspend", "reactivate"] as StatusAction[]) {
    router.post("/patients/:id/" + action, rejectQueryParameters, rejectRequestBody, requireAdmin(tokens, repository, "admin.patients." + action), async (req, res) => {
      const admin = adminIdentity(req), id = patientIdParameter(req.params.id), result = await accounts.changeStatus(admin, id, action);
      if (result.outcome === "not_found") throw new ApiError(404, "NOT_FOUND", "Patient account not found.");
      if (result.outcome === "conflict") throw new ApiError(409, "ACCOUNT_STATE_CONFLICT", "The account is not in a state that permits this action.");
      res.status(200).json({ success: true, patient: await accounts.get(id) });
    });
  }
  const readJobs = requireAdmin(tokens, repository, "admin.processing.read");
  const readAudit = (admin: ReturnType<typeof adminIdentity>, scope: Record<string, unknown>, targetId?: string, outcome: "success" | "failure" = "success") =>
    repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.processing.read", targetType: "processing_job", targetId, scope, outcome, requestId: admin.requestId });
  router.get("/processing/summary", rejectQueryParameters, rejectRequestBody, readJobs, async (req, res) => {
    const admin = adminIdentity(req), summary = await jobs.summary();
    await readAudit(admin, { view: "summary", total: summary.total });
    res.status(200).json({ success: true, summary });
  });
  router.get("/processing/jobs", readJobs, async (req, res) => {
    const admin = adminIdentity(req), query = validateJobListQuery(req.query), page = await jobs.list(query);
    await readAudit(admin, { view: "list", state: query.state ?? null, error_code: query.errorCode ?? null, patient_filter: query.patientId !== undefined, limit: query.limit, returned: page.jobs.length });
    res.status(200).json({ success: true, jobs: page.jobs, next_cursor: page.nextCursor });
  });
  router.get("/processing/jobs/:documentId", rejectQueryParameters, rejectRequestBody, readJobs, async (req, res) => {
    const admin = adminIdentity(req), id = jobIdParameter(req.params.documentId), job = await jobs.get(id);
    await readAudit(admin, job ? { view: "detail" } : { view: "detail", reason: "not_found" }, id, job ? "success" : "failure");
    if (!job) throw new ApiError(404, "NOT_FOUND", "Processing job not found.");
    res.status(200).json({ success: true, job });
  });
  router.post("/processing/jobs/:documentId/retry", rejectQueryParameters, rejectRequestBody, requireAdmin(tokens, repository, "admin.processing.retry"), async (req, res) => {
    const admin = adminIdentity(req), id = jobIdParameter(req.params.documentId), result = await jobs.retry(admin, id);
    if (result.outcome === "not_found") throw new ApiError(404, "NOT_FOUND", "Processing job not found.");
    if (result.outcome === "not_retryable") throw new ApiError(409, "JOB_NOT_RETRYABLE", "This job cannot be retried under the current processing rules.");
    res.status(200).json({ success: true, job: await jobs.get(id) });
  });
  // Phase 4: read-only, metadata-only status views. Every read is audited with the filter shape, never the values searched for.
  const statusRoutes = [
    { name: "guardians", permission: "admin.guardians.read", target: "guardian_relationship", parse: guardianQuery, view: status.guardians, key: "guardians" },
    { name: "shares", permission: "admin.shares.read", target: "share_grant", parse: shareQuery, view: status.shares, key: "shares" },
  ] as const;
  const statusAudit = (admin: ReturnType<typeof adminIdentity>, permission: string, target: string, scope: Record<string, unknown>, targetId?: string, outcome: "success" | "failure" = "success") =>
    repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: permission, targetType: target, targetId, scope, outcome, requestId: admin.requestId });
  const shape = (parsed: { filters: Record<string, string | undefined>; limit: number }, returned: number) =>
    ({ view: "list", filters: Object.keys(parsed.filters).filter(key => parsed.filters[key] !== undefined).sort(), limit: parsed.limit, returned });
  for (const route of statusRoutes) {
    const guard = requireAdmin(tokens, repository, route.permission), base = "/status/" + route.name;
    router.get(base + "/summary", rejectQueryParameters, rejectRequestBody, guard, async (req, res) => {
      const admin = adminIdentity(req), summary = await route.view.summary();
      await statusAudit(admin, route.permission, route.target, { view: "summary", total: summary.total });
      res.status(200).json({ success: true, summary });
    });
    router.get(base, guard, async (req, res) => {
      const admin = adminIdentity(req), parsed = route.parse(req.query), result = await route.view.list(parsed);
      await statusAudit(admin, route.permission, route.target, shape(parsed, result.rows.length));
      res.status(200).json({ success: true, [route.key]: result.rows, next_cursor: result.nextCursor });
    });
    router.get(base + "/:id", rejectQueryParameters, rejectRequestBody, guard, async (req, res) => {
      const admin = adminIdentity(req), id = statusIdParameter(req.params.id), item = await route.view.get(id);
      await statusAudit(admin, route.permission, route.target, item ? { view: "detail" } : { view: "detail", reason: "not_found" }, id, item ? "success" : "failure");
      if (!item) throw new ApiError(404, "NOT_FOUND", "Record not found.");
      res.status(200).json({ success: true, [route.key.slice(0, -1)]: item });
    });
  }
  const readDeliveries = requireAdmin(tokens, repository, "admin.deliveries.read");
  router.get("/status/deliveries/summary", rejectQueryParameters, rejectRequestBody, readDeliveries, async (req, res) => {
    const admin = adminIdentity(req), summary = await status.deliveries.summary();
    await statusAudit(admin, "admin.deliveries.read", "delivery", { view: "summary", total: summary.total });
    res.status(200).json({ success: true, summary });
  });
  router.get("/status/deliveries", readDeliveries, async (req, res) => {
    const admin = adminIdentity(req), parsed = deliveryQuery(req.query), result = await status.deliveries.list(parsed);
    await statusAudit(admin, "admin.deliveries.read", "delivery", shape(parsed, result.rows.length));
    res.status(200).json({ success: true, deliveries: result.rows, next_cursor: result.nextCursor });
  });
  mountConfigRoutes(router, { database, tokens, repository });
  mountOpsRoutes(router, { database, tokens, repository, health: options.health });
  return router;
}

import type { Router } from "express";
import { rejectQueryParameters, rejectRequestBody } from "../auth/middleware.js";
import type { PatientDatabase } from "../patients/repository.js";
import type { createAdminTokenService } from "./tokens.js";
import type { createAdminRepository } from "./repository.js";
import { adminIdentity, requireAdmin } from "./middleware.js";
import { createAdminHealth, type HealthOptions } from "./health.js";
import { createAdminAuditViewer, validateAuditQuery } from "./audit-viewer.js";

/** Phase 6 routes: system health and the read-only audit review. Both are themselves audited, and neither can change data. */
export function mountOpsRoutes(router: Router, deps: { database: PatientDatabase; tokens: ReturnType<typeof createAdminTokenService>; repository: ReturnType<typeof createAdminRepository>; health?: HealthOptions }) {
  const { tokens, repository } = deps, health = createAdminHealth(deps.database, deps.health), viewer = createAdminAuditViewer(deps.database);
  router.get("/health", rejectQueryParameters, rejectRequestBody, requireAdmin(tokens, repository, "admin.health.read"), async (req, res) => {
    const admin = adminIdentity(req), report = await health.check();
    await repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.health.read", targetType: "system_health",
      scope: { status: report.status, problems: report.components.filter(c => c.status === "degraded" || c.status === "down" || c.status === "unknown").length }, outcome: "success", requestId: admin.requestId });
    res.status(200).json({ success: true, health: report });
  });
  router.get("/audit", requireAdmin(tokens, repository, "admin.audit.read"), async (req, res) => {
    const admin = adminIdentity(req), parsed = validateAuditQuery(req.query), page = await viewer.search(parsed);
    // The integrity check covers the whole log, so it runs on the first page only; later pages report null.
    const chain = parsed.cursor === undefined ? await viewer.chain() : null;
    // The request is recorded by filter name only. Filter values (an actor, an action, a time range) are never copied into the log.
    await repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.audit.read", targetType: "audit_log",
      scope: { filters: Object.keys(parsed.filters).sort(), limit: parsed.limit, paged: parsed.cursor !== undefined, returned: page.events.length, chain: chain?.status ?? null }, outcome: "success", requestId: admin.requestId });
    res.status(200).json({ success: true, events: page.events, next_cursor: page.nextCursor, chain });
  });
}

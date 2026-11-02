import { randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { ApiError } from "../http/errors.js";
import type { createAdminTokenService } from "./tokens.js";
import type { AdminContext, createAdminRepository } from "./repository.js";

declare global {
  namespace Express {
    interface Request { admin?: AdminContext; }
  }
}

export function adminIdentity(req: Request): AdminContext {
  if (!req.admin) throw new ApiError(401, "UNAUTHORIZED", "A valid access token is required.");
  return req.admin;
}

/** Admin-only authentication plus one named permission. Patient, doctor and expired tokens never reach a handler. */
export function requireAdmin(tokens: ReturnType<typeof createAdminTokenService>, repository: ReturnType<typeof createAdminRepository>,
  permission: string): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get("Authorization");
    const match = header && header.length <= 4096 ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header) : null;
    if (!match) { next(new ApiError(401, "UNAUTHORIZED", "A valid access token is required.")); return; }
    let admin: AdminContext | undefined;
    try {
      admin = await repository.authorize(await tokens.verifySession(match[1]), randomUUID());
    } catch { admin = undefined; }
    if (!admin) { next(new ApiError(401, "UNAUTHORIZED", "A valid access token is required.")); return; }
    if (!admin.permissions.includes(permission)) {
      try {
        await repository.audit({ actorAdminId: admin.adminId, actorRole: admin.role, action: permission, targetType: "route",
          outcome: "denied", requestId: admin.requestId });
      } catch { /* The request is denied either way. */ }
      next(new ApiError(403, "FORBIDDEN", "This account is not permitted to perform this action."));
      return;
    }
    req.admin = admin;
    next();
  };
}

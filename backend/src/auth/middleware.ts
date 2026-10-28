import type { Request, RequestHandler } from "express";
import { ApiError } from "../http/errors.js";
import type { createTokenService } from "./tokens.js";

export interface PatientAuthentication { readonly patientId: string; }
declare global {
  namespace Express {
    interface Request { auth?: PatientAuthentication; }
  }
}

export function requirePatient(tokens: ReturnType<typeof createTokenService>): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get("Authorization");
    const match = header && header.length <= 4096 ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header) : null;
    if (!match) { next(new ApiError(401, "UNAUTHORIZED", "A valid access token is required.")); return; }
    try {
      req.auth = Object.freeze({ patientId: await tokens.verify(match[1]) });
      next();
    } catch {
      next(new ApiError(401, "UNAUTHORIZED", "A valid access token is required."));
    }
  };
}

export function patientIdentity(req: Request): string {
  if (!req.auth) throw new ApiError(401, "UNAUTHORIZED", "A valid access token is required.");
  return req.auth.patientId;
}

export const requireJson: RequestHandler = (req, _res, next) => {
  next(req.is("application/json") ? undefined : new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."));
};

export const rejectQueryParameters: RequestHandler = (req, _res, next) => {
  next(Object.keys(req.query).length ? new ApiError(400, "INVALID_INPUT", "Query parameters are not permitted on this endpoint.") : undefined);
};

// A read operation never accepts patient selectors, commands or ignored JSON bodies.
export const rejectRequestBody: RequestHandler = (req, _res, next) => {
  next(req.body !== undefined || req.get("Transfer-Encoding") || Number(req.get("Content-Length") ?? 0)>0
    ? new ApiError(400,"INVALID_INPUT","A request body is not permitted on this endpoint.") : undefined);
};

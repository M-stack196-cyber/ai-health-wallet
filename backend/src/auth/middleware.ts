import type { Request, RequestHandler } from "express";
import { ApiError } from "../http/errors.js";
import type { createTokenService } from "./tokens.js";
import type {PatientDatabase} from '../patients/repository.js';
import {createSecurityRepository} from './security-repository.js';
import {getSecurityPolicy} from './security-policy.js';

export interface PatientAuthentication { readonly patientId: string; readonly sessionId?: string; }
declare global {
  namespace Express {
    interface Request { auth?: PatientAuthentication; }
  }
}

export async function assertCurrentPatient(req: Request, database: PatientDatabase): Promise<void> {
  if(!req.auth?.sessionId || !await createSecurityRepository(database,getSecurityPolicy()).authorize({patientId:req.auth.patientId,sessionId:req.auth.sessionId}))
    throw new ApiError(401,'UNAUTHORIZED','A valid access token is required.');
}
export function requirePatient(tokens: ReturnType<typeof createTokenService>, database?: PatientDatabase): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get("Authorization");
    const match = header && header.length <= 4096 ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header) : null;
    if (!match) { next(new ApiError(401, "UNAUTHORIZED", "A valid access token is required.")); return; }
    try {
      req.auth = Object.freeze(await tokens.verifySession(match[1]));
      if(!database)throw Error('Authorization database required.');
      await assertCurrentPatient(req,database);
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

import { SignJWT, jwtVerify } from "jose";
import type { AdminAuthenticationConfig } from "./config.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin access tokens are signed with the admin-only key and audience and always carry a session. */
export function createAdminTokenService(config: AdminAuthenticationConfig) {
  return {
    async issue(adminId: string, sessionId: string): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: config.jwtAlgorithm, typ: "JWT" })
        .setSubject(adminId).setIssuer(config.jwtIssuer).setAudience(config.jwtAudience)
        .setIssuedAt(now).setExpirationTime(now + config.jwtLifetimeSeconds)
        .sign(config.jwtKey);
    },
    async verifySession(token: string): Promise<{ adminId: string; sessionId: string }> {
      const { payload } = await jwtVerify(token, config.jwtKey, { algorithms: [config.jwtAlgorithm], typ: "JWT",
        issuer: config.jwtIssuer, audience: config.jwtAudience, requiredClaims: ["sub", "iat", "exp", "iss", "aud", "sid"],
        maxTokenAge: config.jwtLifetimeSeconds, clockTolerance: 0 });
      if (typeof payload.sub !== "string" || !uuid.test(payload.sub) || typeof payload.sid !== "string" || !uuid.test(payload.sid)
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
        || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > config.jwtLifetimeSeconds) throw Error("Invalid admin token claims.");
      return { adminId: payload.sub, sessionId: payload.sid };
    },
  };
}

import { SignJWT, jwtVerify } from "jose";
import type { AuthenticationConfig } from "../config/auth.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenService(config: AuthenticationConfig) {
  return {
    async issue(patientId: string): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: config.jwtAlgorithm, typ: "JWT" })
        .setSubject(patientId).setIssuer(config.jwtIssuer).setAudience(config.jwtAudience)
        .setIssuedAt(now).setExpirationTime(now + config.jwtLifetimeSeconds)
        .sign(config.jwtKey);
    },
    async verify(token: string): Promise<string> {
      const { payload } = await jwtVerify(token, config.jwtKey, {
        algorithms: [config.jwtAlgorithm], typ: "JWT", issuer: config.jwtIssuer,
        audience: config.jwtAudience, requiredClaims: ["sub", "iat", "exp", "iss", "aud"],
        maxTokenAge: config.jwtLifetimeSeconds, clockTolerance: 0,
      });
      if (typeof payload.sub !== "string" || !uuid.test(payload.sub)
          || typeof payload.iat !== "number" || typeof payload.exp !== "number"
          || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || payload.exp <= payload.iat || payload.exp - payload.iat > config.jwtLifetimeSeconds) {
        throw new Error("Invalid access token claims.");
      }
      return payload.sub;
    },
  };
}

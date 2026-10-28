import { SignJWT, jwtVerify } from "jose";
import type { AuthenticationConfig } from "../config/auth.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenService(config: AuthenticationConfig) {
  async function claims(token: string) {
    const {payload} = await jwtVerify(token,config.jwtKey,{algorithms:[config.jwtAlgorithm],typ:'JWT',issuer:config.jwtIssuer,
      audience:config.jwtAudience,requiredClaims:['sub','iat','exp','iss','aud'],maxTokenAge:config.jwtLifetimeSeconds,clockTolerance:0});
    if(typeof payload.sub!=='string'||!uuid.test(payload.sub)||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)
      ||payload.exp!<=payload.iat!||payload.exp!-payload.iat!>config.jwtLifetimeSeconds)throw Error('Invalid access token claims.');
    return payload;
  }
  return {
    async issue(patientId: string, sessionId?: string): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT(sessionId ? {sid:sessionId} : {})
        .setProtectedHeader({ alg: config.jwtAlgorithm, typ: "JWT" })
        .setSubject(patientId).setIssuer(config.jwtIssuer).setAudience(config.jwtAudience)
        .setIssuedAt(now).setExpirationTime(now + config.jwtLifetimeSeconds)
        .sign(config.jwtKey);
    },
    async verify(token: string): Promise<string> {
      return (await claims(token)).sub!;
    },
    async verifySession(token: string) {
      const payload=await claims(token);
      if(typeof payload.sid!=='string'||!uuid.test(payload.sid))throw Error('Session required.');
      return {patientId:payload.sub!,sessionId:payload.sid};
    },
  };
}

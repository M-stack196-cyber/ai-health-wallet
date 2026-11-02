import "../config/env.js";

export class AdminConfigurationError extends Error {}

export interface AdminAuthenticationConfig {
  readonly jwtKey: Uint8Array;
  readonly jwtAlgorithm: "HS256";
  readonly jwtLifetimeSeconds: number;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly rateLimitMax: number;
  readonly rateWindowSeconds: number;
}

/** Admin stays disabled (routes are not mounted) until ADMIN_JWT_SECRET is configured.
 * The admin key and audience must differ from the patient ones so no token crosses actors. */
export function getAdminAuthenticationConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthenticationConfig | undefined {
  const secret = env.ADMIN_JWT_SECRET;
  if (secret === undefined || secret === "") return undefined;
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new AdminConfigurationError(name + " must be an integer between " + min + " and " + max + ".");
    }
    return value;
  };
  const label = (name: string, fallback: string): string => {
    const value = env[name] ?? fallback;
    if (!value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new AdminConfigurationError(name + " must be a nonempty label of at most 128 characters.");
    }
    return value;
  };
  if (!/^[a-fA-F0-9]{64,128}$/.test(secret) || secret.length % 2 !== 0 || new Set(secret.toLowerCase()).size < 8) {
    throw new AdminConfigurationError("ADMIN_JWT_SECRET must be 32–64 securely generated random bytes encoded as hexadecimal.");
  }
  if (secret.toLowerCase() === (env.JWT_SECRET ?? "").toLowerCase()) {
    throw new AdminConfigurationError("ADMIN_JWT_SECRET must differ from JWT_SECRET.");
  }
  const jwtAudience = label("ADMIN_JWT_AUDIENCE", "ai-health-wallet-admin");
  if (jwtAudience === (env.JWT_AUDIENCE ?? "ai-health-wallet-patient")) {
    throw new AdminConfigurationError("ADMIN_JWT_AUDIENCE must differ from JWT_AUDIENCE.");
  }
  return {
    jwtKey: new Uint8Array(Buffer.from(secret, "hex")),
    jwtAlgorithm: "HS256",
    jwtLifetimeSeconds: integer("ADMIN_JWT_EXPIRES_IN_SECONDS", 900, 60, 3600),
    jwtIssuer: label("ADMIN_JWT_ISSUER", "ai-health-wallet-api"),
    jwtAudience,
    rateLimitMax: integer("ADMIN_AUTH_RATE_LIMIT_MAX", 10, 1, 1000),
    rateWindowSeconds: integer("ADMIN_AUTH_RATE_WINDOW_SECONDS", 900, 1, 86400),
  };
}

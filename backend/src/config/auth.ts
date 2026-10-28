import "./env.js";

export class AuthenticationConfigurationError extends Error {}

export interface AuthenticationConfig {
  readonly jwtKey: Uint8Array;
  readonly jwtAlgorithm: "HS256";
  readonly jwtLifetimeSeconds: number;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly argonMemoryKiB: number;
  readonly argonTimeCost: number;
  readonly argonParallelism: number;
  readonly maxHashConcurrency: number;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
}

export function getAuthenticationConfig(): AuthenticationConfig {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = process.env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new AuthenticationConfigurationError(name + " must be an integer between " + min + " and " + max + ".");
    }
    return value;
  };
  const label = (name: string, fallback: string): string => {
    const value = process.env[name] ?? fallback;
    if (!value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new AuthenticationConfigurationError(name + " must be a nonempty label of at most 128 characters.");
    }
    return value;
  };
  const secret = process.env.JWT_SECRET;
  if (!secret || !/^[a-fA-F0-9]{64,128}$/.test(secret) || secret.length % 2 !== 0 || new Set(secret.toLowerCase()).size < 8) {
    throw new AuthenticationConfigurationError("JWT_SECRET must be 32–64 securely generated random bytes encoded as hexadecimal.");
  }
  if ((process.env.JWT_ALGORITHM ?? "HS256") !== "HS256") {
    throw new AuthenticationConfigurationError("JWT_ALGORITHM must be HS256.");
  }
  return {
    jwtKey: new Uint8Array(Buffer.from(secret, "hex")),
    jwtAlgorithm: "HS256",
    jwtLifetimeSeconds: integer("JWT_EXPIRES_IN_SECONDS", 900, 60, 3600),
    jwtIssuer: label("JWT_ISSUER", "ai-health-wallet-api"),
    jwtAudience: label("JWT_AUDIENCE", "ai-health-wallet-patient"),
    argonMemoryKiB: integer("ARGON2_MEMORY_KIB", 65536, 19456, 262144),
    argonTimeCost: integer("ARGON2_TIME_COST", 3, 2, 10),
    argonParallelism: integer("ARGON2_PARALLELISM", 1, 1, 4),
    maxHashConcurrency: integer("AUTH_HASH_CONCURRENCY", 2, 1, 8),
    rateLimitWindowMs: integer("AUTH_RATE_LIMIT_WINDOW_MS", 900000, 1000, 3600000),
    rateLimitMax: integer("AUTH_RATE_LIMIT_MAX", 20, 1, 1000),
  };
}

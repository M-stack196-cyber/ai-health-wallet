import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import type { AuthenticationConfig } from "../config/auth.js";
import { ApiError } from "../http/errors.js";

export function createPasswordService(config: AuthenticationConfig) {
  const options = { type: argon2.argon2id, memoryCost: config.argonMemoryKiB,
    timeCost: config.argonTimeCost, parallelism: config.argonParallelism, hashLength: 32 } as const;
  let active = 0;
  let dummyHash: Promise<string> | undefined;

  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    if (active >= config.maxHashConcurrency) {
      throw new ApiError(503, "AUTHENTICATION_BUSY", "Authentication is temporarily busy. Try again later.");
    }
    active++;
    try { return await work(); }
    finally { active--; }
  }
  return {
    hash(password: string): Promise<string> {
      return bounded(() => argon2.hash(password, options));
    },
    verify(password: string, storedHash?: string): Promise<boolean> {
      return bounded(async () => {
        // All login attempts await the same lazy initialization, including known
        // users. Unknown accounts still perform a real cost-matched verification.
        dummyHash ??= argon2.hash(randomBytes(32).toString("hex"), options);
        const dummy = await dummyHash;
        const usable = storedHash?.startsWith("$argon2id$") ?? false;
        try {
          const valid = await argon2.verify(usable ? storedHash! : dummy, password);
          return usable && valid;
        } catch {
          // Malformed legacy hashes are not valid credentials and reveal no detail.
          await argon2.verify(dummy, password);
          return false;
        }
      });
    },
  };
}

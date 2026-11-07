// Shared refusal rules for the local demo stack tools. They run only on a developer machine, against a loopback or socket database,
// with the generated local environment (HW_LOCAL_STACK=1) and never with AWS settings.
import { localMode } from "../http/origins.js";

export class LocalStackRefused extends Error {}
export function assertLocalStack(env: NodeJS.ProcessEnv): void {
  if (env.HW_LOCAL_STACK !== "1") throw new LocalStackRefused("HW_LOCAL_STACK=1 is required (use the local-stack scripts).");
  if (!localMode(env)) throw new LocalStackRefused("NODE_ENV must be development or local.");
  if (Object.entries(env).some(([name, value]) => /^(AWS_|S3_)/.test(name) && value)) throw new LocalStackRefused("AWS or S3 settings are present; refusing.");
  const host = env.DB_HOST ?? "";
  if (!(host.startsWith("/") || ["127.0.0.1", "::1", "localhost"].includes(host))) throw new LocalStackRefused("The database must be on this machine.");
}

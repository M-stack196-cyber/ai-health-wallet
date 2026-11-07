import { config } from "dotenv";
import { readFileSync } from "node:fs";

// The API loads runtime credentials only. Migration secrets are loaded on demand.
// The local demo stack (HW_LOCAL_STACK=1) uses only its own generated environment, never backend/.env.
if (process.env.HW_LOCAL_STACK !== "1") config({ path: new URL("../../.env", import.meta.url), quiet: true });

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new DatabaseConfigurationError(name + " is required.");
  return value;
}

/** TLS for the database link. A database on another machine always needs a CA file and full certificate verification. */
export function databaseTls(host: string, env: NodeJS.ProcessEnv = process.env) {
  const local = host.startsWith("/") || ["127.0.0.1", "::1", "localhost"].includes(host);
  const file = env.DB_SSL_CA_FILE;
  if (!file) {
    if (local) return undefined;
    throw new DatabaseConfigurationError("DB_SSL_CA_FILE is required for a database that is not on this machine.");
  }
  let pem: string;
  try { pem = readFileSync(file, "utf8"); } catch { throw new DatabaseConfigurationError("DB_SSL_CA_FILE cannot be read."); }
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) throw new DatabaseConfigurationError("DB_SSL_CA_FILE must contain PEM certificates.");
  return { ca: pem, rejectUnauthorized: true, minVersion: "TLSv1.2" as const };
}

function connectionSettings() {
  const host = required("DB_HOST");
  const portValue = required("DB_PORT");
  const database = required("DB_NAME");
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigurationError("DB_PORT must be an integer between 1 and 65535.");
  }
  return { host, port, database };
}

export function getDatabaseConfig() {
  const settings = connectionSettings();
  const user = required("DB_USER");
  const password = required("DB_PASSWORD");
  if (user !== "health_wallet_app") {
    throw new DatabaseConfigurationError("DB_USER must be the restricted health_wallet_app role.");
  }
  const ssl = databaseTls(settings.host);
  return { ...settings, user, password, ...(ssl ? { ssl } : {}) };
}

export function getMigrationDatabaseConfig() {
  if (process.env.HW_LOCAL_STACK !== "1") config({ path: new URL("../../.env.migrations", import.meta.url), quiet: true });
  const settings = connectionSettings();
  const user = required("MIGRATION_DB_USER");
  const password = required("MIGRATION_DB_PASSWORD");
  if (user !== "health_wallet_migrator") {
    throw new DatabaseConfigurationError("MIGRATION_DB_USER must be the dedicated health_wallet_migrator role.");
  }
  const ssl = databaseTls(settings.host);
  return { ...settings, user, password, ...(ssl ? { ssl } : {}) };
}

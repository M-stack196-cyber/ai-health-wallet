import { config } from "dotenv";

// The API loads runtime credentials only. Migration secrets are loaded on demand.
config({ path: new URL("../../.env", import.meta.url), quiet: true });

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
  return { ...settings, user, password };
}

export function getMigrationDatabaseConfig() {
  config({ path: new URL("../../.env.migrations", import.meta.url), quiet: true });
  const settings = connectionSettings();
  const user = required("MIGRATION_DB_USER");
  const password = required("MIGRATION_DB_PASSWORD");
  if (user !== "health_wallet_migrator") {
    throw new DatabaseConfigurationError("MIGRATION_DB_USER must be the dedicated health_wallet_migrator role.");
  }
  return { ...settings, user, password };
}

import pg from "pg";
import { getMigrationDatabaseConfig } from "../config/env.js";

// Imported by database tools only; the Express pool never falls back to this role.
export const migrationPool = new pg.Pool({
  ...getMigrationDatabaseConfig(),
  max: 2,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
  query_timeout: 35000,
});

migrationPool.on("error", () => {
  console.error("An idle migration database connection failed.");
});

export async function closeMigrationPool(): Promise<void> {
  await migrationPool.end();
}

import pg from "pg";
import { getDatabaseConfig } from "../config/env.js";

export const pool = new pg.Pool({
  ...getDatabaseConfig(),
  max: 10,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
  statement_timeout: 3000,
  query_timeout: 5000,
});

// Idle clients can fail outside a request. Never log raw database errors.
pool.on("error", () => {
  console.error("An idle database connection failed.");
});

export async function checkDatabaseConnection(): Promise<boolean> {
  // pool.query acquires and releases its client, including on query failure.
  const result = await pool.query<{ connected: number }>("SELECT 1 AS connected");
  return result.rows[0]?.connected === 1;
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}

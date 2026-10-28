import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { getMigrationDatabaseConfig } from "../config/env.js";
import { migrationPool } from "./migration-pool.js";

// One project-specific session lock serializes tracking bootstrap and execution.
export const MIGRATION_LOCK = [1095260232, 1400] as const;
const directory = new URL("../../migrations/", import.meta.url);

export class MigrationError extends Error {}
export interface Migration {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}
interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export function assertDedicatedDatabase(): void {
  const config = getMigrationDatabaseConfig();
  if (config.host !== "127.0.0.1" || config.port !== 5433 || config.database !== "ai_health_wallet") {
    throw new MigrationError("Database tools require the dedicated local ai_health_wallet database on 127.0.0.1:5433.");
  }
}

export async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const versions = new Set<string>();
  const migrations: Migration[] = [];
  for (const name of names) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match || versions.has(match[1])) {
      throw new MigrationError("Migration filenames must have unique four-digit versions and lowercase descriptions.");
    }
    versions.add(match[1]);
    const sql = await readFile(new URL(name, directory), "utf8");
    migrations.push({ version: match[1], name, checksum: createHash("sha256").update(sql).digest("hex"), sql });
  }
  if (!migrations.length) throw new MigrationError("No SQL migrations were found.");
  return migrations;
}

async function appliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const exists = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
  if (!exists.rows[0].present) return [];
  const result = await client.query<AppliedMigration>("SELECT version, name, checksum FROM public.schema_migrations ORDER BY version");
  return result.rows;
}

export function validateMigrationHistory(migrations: Migration[], applied: AppliedMigration[]): void {
  // History must be an unchanged prefix; fail on edits, missing files or backfills.
  for (let index = 0; index < applied.length; index++) {
    const file = migrations[index];
    const record = applied[index];
    if (!file || record.version !== file.version || record.name !== file.name || record.checksum !== file.checksum) {
      throw new MigrationError("Migration history differs from local files. Restore applied files; add a new migration for changes.");
    }
  }
}

export async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path = public, pg_catalog");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    // SQL files are trusted, reviewed source. They must not contain transaction control.
    // pg supports a per-query read timeout; the installed QueryConfig typing
    // omits that property. An inferred config retains compatibility without casts.
    const query = { text: migration.sql, query_timeout: 35000 };
    await client.query(query);
    await client.query(
      "INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(mode: "up" | "status"): Promise<string[]> {
  assertDedicatedDatabase();
  const migrations = await loadMigrations();
  const client = await migrationPool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [...MIGRATION_LOCK]);
    locked = lock.rows[0].acquired;
    if (!locked) throw new MigrationError("Another migration operation is running. Retry after it completes.");
    const applied = await appliedMigrations(client);
    validateMigrationHistory(migrations, applied);
    if (mode === "status") {
      return migrations.map((file, index) => (index < applied.length ? "applied " : "pending ") + file.name);
    }

    // Bootstrap only the migration ledger. Application tables have no IF NOT EXISTS:
    // an unexpected existing table is a conflict, never silently adopted or reset.
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const bootstrap = { query_timeout: 35000, text: `CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )` };
      await client.query(bootstrap);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const messages: string[] = [];
    for (const migration of migrations.slice(applied.length)) {
      await applyMigration(client, migration);
      messages.push("applied " + migration.name);
    }
    return messages.length ? messages : ["Database is up to date; no migrations applied."];
  } finally {
    let discard = false;
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]);
    } catch {
      // Destroy the session if unlocking fails; do not return a locked session.
      discard = true;
    } finally {
      client.release(discard);
    }
  }
}

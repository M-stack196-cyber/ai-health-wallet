#!/usr/bin/env node
// Single-node backup and restore for the staging PostgreSQL database (RDS or a local disposable one).
//   node db-recovery.mjs backup  --out DIR
//   node db-recovery.mjs restore --backup FILE.dump
// Connection settings are the standard libpq variables (PGHOST, PGPORT, PGDATABASE, PGUSER, PGSSLMODE, PGSSLROOTCERT,
// PGPASSFILE). No password is accepted on the command line and none is ever printed or written to a manifest.
// Backup must run as the schema OWNER (migrator): the application role is subject to row-level security and sees partial data.
// Restore only ever writes into an EMPTY database whose name ends in _restore; cutover is a separate, manual, documented step.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
const { Client } = createRequire(new URL("../../backend/package.json", import.meta.url))("pg");
const APP_ROLES = ["health_wallet_app", "health_wallet_migrator"];
export class RecoveryError extends Error {}
const refuse = (why) => { throw new RecoveryError(why); };
const sha256 = (file) => new Promise((ok, no) => { const h = createHash("sha256"); createReadStream(file).on("data", (c) => h.update(c)).on("end", () => ok(h.digest("hex"))).on("error", no); });
const tool = async (name, args, env = process.env) => { try { return (await run(name, args, { env, maxBuffer: 16 * 1024 * 1024, timeout: 3_600_000 })).stdout; } catch (e) { refuse(name + " failed" + (e.code === "ENOENT" ? " (not installed)" : "")); } };

async function inspect(client) {
  const q = async (sql, v = []) => (await client.query(sql, v)).rows;
  const ledgerExists = (await q("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present"))[0].present;
  const tables = await q(`SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  const counts = {};
  for (const t of tables) counts[t.name] = Number((await q('SELECT count(*) AS n FROM public."' + t.name.replaceAll('"', '""') + '"'))[0].n);
  return {
    ledger: ledgerExists ? await q("SELECT version, name, checksum FROM public.schema_migrations ORDER BY version") : [],
    tables: Object.fromEntries(tables.map((t) => [t.name, { rows: counts[t.name], rls: t.rls }])),
    policies: Number((await q("SELECT count(*) AS n FROM pg_policies WHERE schemaname='public'"))[0].n),
    appGrants: Number((await q("SELECT count(*) AS n FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='health_wallet_app'"))[0].n),
    extensions: (await q("SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY 1")).map((r) => r.extname),
  };
}
const connect = async () => { const c = new Client(); await c.connect(); return c; };

export async function backup(outDir) {
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
  const control = await connect();
  try {
    const who = (await control.query("SELECT current_user AS u, current_database() AS d, version() AS v, current_setting('server_version_num')::int AS n")).rows[0];
    if (who.u === "health_wallet_app") refuse("backup must run as the schema owner, not the application role");
    // One snapshot for both the row counts and the dump, so the manifest describes exactly what was dumped.
    await control.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await control.query("SELECT pg_export_snapshot() AS s")).rows[0].s;
    const state = await inspect(control);
    if (!state.ledger.length) refuse("the database has no migration ledger; nothing safe to back up");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const name = "hw-backup-" + stamp + ".dump", partial = join(dir, name + ".partial"), final = join(dir, name);
    await tool("pg_dump", ["--format=custom", "--no-owner", "--compress=6", "--snapshot=" + snapshot, "--file=" + partial, who.d]);
    await control.query("COMMIT");
    await chmod(partial, 0o600); await rename(partial, final);
    const manifest = { format: 1, kind: "health-wallet-staging-backup", createdAt: new Date().toISOString(), database: who.d, serverVersion: who.n,
      file: name, bytes: (await stat(final)).size, sha256: await sha256(final), encrypted: false, ...state };
    await writeFile(final.replace(/\.dump$/, ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    return { ok: true, file: final, bytes: manifest.bytes, sha256: manifest.sha256, tables: Object.keys(manifest.tables).length, rows: Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0), migrations: manifest.ledger.length };
  } finally { await control.end().catch(() => {}); }
}

export async function verifyBackupFiles(file) {
  const dump = resolve(file), manifestPath = dump.replace(/\.dump$/, ".manifest.json");
  if (!dump.endsWith(".dump") || manifestPath === dump) refuse("the backup file must end in .dump");
  let manifest; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { refuse("the manifest is missing or unreadable"); }
  if (manifest?.format !== 1 || manifest.kind !== "health-wallet-staging-backup" || manifest.file !== basename(dump) || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "")) refuse("the manifest is not valid for this file");
  const info = await stat(dump).catch(() => refuse("the backup file is missing"));
  if (info.size !== manifest.bytes) refuse("the backup file size differs from its manifest");
  if (await sha256(dump) !== manifest.sha256) refuse("the backup file checksum differs from its manifest");
  await tool("pg_restore", ["--list", dump]);                                  // structurally readable
  return { dump, manifest };
}

export async function restore(file) {
  const started = Date.now(), { dump, manifest } = await verifyBackupFiles(file);
  const client = await connect();
  try {
    const who = (await client.query("SELECT current_user AS u, current_database() AS d, current_setting('server_version_num')::int AS n")).rows[0];
    if (!/_restore$/.test(who.d)) refuse("restore only writes into a database whose name ends in _restore");
    if (who.u === "health_wallet_app") refuse("restore must run as the schema owner, not the application role");
    if (Math.floor(who.n / 10000) < Math.floor(manifest.serverVersion / 10000)) refuse("the target PostgreSQL is older than the backup source");
    const existing = (await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')")).rows[0].n;
    if (existing) refuse("the target database is not empty");
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [APP_ROLES])).rows.map((r) => r.rolname);
    const missing = APP_ROLES.filter((r) => !roles.includes(r));
    if (missing.length) refuse("required roles are missing in the target: " + missing.join(", "));
    await client.end();
    await tool("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--dbname=" + who.d, dump]);
  } catch (e) { await client.end().catch(() => {}); throw e; }
  const after = await connect();
  try {
    const got = await inspect(after), problems = [];
    if (JSON.stringify(got.ledger) !== JSON.stringify(manifest.ledger)) problems.push("migration ledger differs");
    for (const name of new Set([...Object.keys(manifest.tables), ...Object.keys(got.tables)])) {
      const a = manifest.tables[name], b = got.tables[name];
      if (!a || !b) problems.push("table set differs: " + name); else if (a.rows !== b.rows) problems.push("row count differs: " + name); else if (a.rls !== b.rls) problems.push("row-level security differs: " + name);
    }
    if (got.policies !== manifest.policies) problems.push("policy count differs");
    if (got.appGrants !== manifest.appGrants) problems.push("application grants differ");
    if (JSON.stringify(got.extensions) !== JSON.stringify(manifest.extensions)) problems.push("extensions differ");
    return { ok: problems.length === 0, problems, tables: Object.keys(got.tables).length, rows: Object.values(got.tables).reduce((n, t) => n + t.rows, 0), migrations: got.ledger.length, elapsedMs: Date.now() - started };
  } finally { await after.end().catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [mode, flag, value] = process.argv.slice(2);
  try {
    if (mode === "backup" && flag === "--out" && value) console.log(JSON.stringify(await backup(value)));
    else if (mode === "restore" && flag === "--backup" && value) { const r = await restore(value); console.log(JSON.stringify(r)); process.exitCode = r.ok ? 0 : 1; }
    else { console.error("Usage: db-recovery.mjs backup --out DIR | restore --backup FILE.dump"); process.exitCode = 2; }
  } catch (e) {
    console.error(e instanceof RecoveryError ? "Refused: " + e.message + "." : "Recovery command failed. No database error details were printed.");
    process.exitCode = 1;
  }
}

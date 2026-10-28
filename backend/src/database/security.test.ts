import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import { test } from "node:test";
import { parse } from "dotenv";
import type { PoolClient } from "pg";
import { pool, closeDatabasePool } from "./pool.js";
import { migrationPool, closeMigrationPool } from "./migration-pool.js";
import { getDatabaseConfig, getMigrationDatabaseConfig } from "../config/env.js";

async function denied(client: PoolClient, sql: string): Promise<void> {
  await client.query("SAVEPOINT permission_probe");
  try {
    await assert.rejects(client.query(sql), (error: unknown) =>
      !!error && typeof error === "object" && "code" in error && error.code === "42501");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT permission_probe");
    await client.query("RELEASE SAVEPOINT permission_probe");
  }
}

test("Phase 1.4A security verification", { timeout: 60000 }, async (t) => {
  try {
    await t.test("API imports load no migration secrets and elevated runtime configuration is rejected", () => {
      const environment = { ...process.env };
      delete environment.MIGRATION_DB_USER;
      delete environment.MIGRATION_DB_PASSWORD;
      const backend = new URL("../../", import.meta.url);
      const script = `
        import { pool, closeDatabasePool } from './src/database/pool.ts';
        console.log(JSON.stringify({ user: pool.options.user, migrationSecretLoaded: !!process.env.MIGRATION_DB_PASSWORD }));
        await closeDatabasePool();
      `;
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: backend, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
      });
      assert.deepEqual(JSON.parse(output), { user: "health_wallet_app", migrationSecretLoaded: false });
      const check = `
        import { getDatabaseConfig, DatabaseConfigurationError } from './src/config/env.ts';
        try { getDatabaseConfig(); process.exitCode = 1; }
        catch (error) { if (!(error instanceof DatabaseConfigurationError)) process.exitCode = 1; }
      `;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", check], {
        cwd: backend, env: { ...environment, DB_USER: "health_wallet_user" }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
      });
    });
    await t.test("actual runtime and migration sessions use distinct restricted identities", async () => {
      for (const [connection, name] of [[pool, "health_wallet_app"], [migrationPool, "health_wallet_migrator"]] as const) {
        const result = await connection.query(`SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
          r.rolreplication, r.rolbypassrls, r.rolcanlogin,
          (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid OR roleid = r.oid) AS memberships
          FROM pg_roles r WHERE rolname = current_user`);
        assert.deepEqual(result.rows[0], { name, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
          rolreplication: false, rolbypassrls: false, rolcanlogin: true, memberships: 0 });
      }
      assert.notEqual(getDatabaseConfig().password, getMigrationDatabaseConfig().password);
    });
    await t.test("runtime owns no application objects and has no database/schema CREATE or TEMP", async () => {
      const result = await pool.query(`SELECT
        has_database_privilege(current_user, current_database(), 'CONNECT') AS connect,
        has_database_privilege(current_user, current_database(), 'CREATE') AS create_db_objects,
        has_database_privilege(current_user, current_database(), 'TEMP') AS temporary,
        has_schema_privilege(current_user, 'public', 'USAGE') AS usage,
        has_schema_privilege(current_user, 'public', 'CREATE') AS create_in_schema,
        (SELECT count(*)::int FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owned_relations,
        (SELECT count(*)::int FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owned_schemas,
        (SELECT count(*)::int FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owned_functions`);
      assert.deepEqual(result.rows[0], { connect: true, create_db_objects: false, temporary: false,
        usage: true, create_in_schema: false, owned_relations: 0, owned_schemas: 0, owned_functions: 0 });
    });
    await t.test("runtime cannot CREATE DATABASE (existing target name prevents accidental creation)", async () => {
      await assert.rejects(pool.query("CREATE DATABASE ai_health_wallet"), (error: unknown) =>
        !!error && typeof error === "object" && "code" in error && error.code === "42501");
    });
    const runtime = await pool.connect();
    try {
      await runtime.query("BEGIN");
      await t.test("runtime cannot create roles, tables, temp tables or assume the migration role", async () => {
        await denied(runtime, "CREATE ROLE health_wallet_app");
        await denied(runtime, "CREATE TABLE public.phase14a_denied_table (id integer)");
        await denied(runtime, "CREATE TEMP TABLE phase14a_denied_temp (id integer)");
        await denied(runtime, "SET ROLE health_wallet_migrator");
        await denied(runtime, "SET ROLE health_wallet_user");
      });
      await t.test("runtime cannot alter or drop existing schema objects", async () => {
        // ALTER only adds a nullable column and is always rolled back. DROP is
        // attempted only on an empty table with existing restrictive dependents.
        await denied(runtime, "ALTER TABLE public.patients ADD COLUMN phase14a_denied_column text");
        const count = await runtime.query("SELECT count(*)::int AS n FROM public.patients");
        if (count.rows[0].n === 0) await denied(runtime, "DROP TABLE public.patients RESTRICT");
        else {
          const owner = await runtime.query("SELECT pg_get_userbyid(relowner) <> current_user AS restricted FROM pg_class WHERE oid = 'public.patients'::regclass");
          assert.equal(owner.rows[0].restricted, true, "Use ownership proof rather than DROP against patient records");
        }
        await denied(runtime, "ALTER FUNCTION public.set_updated_at() RENAME TO phase14a_denied_function");
      });
      await t.test("runtime cannot read or modify migration history", async () => {
        await denied(runtime, "SELECT * FROM public.schema_migrations");
        await denied(runtime, "UPDATE public.schema_migrations SET checksum = checksum WHERE false");
        await denied(runtime, "DELETE FROM public.schema_migrations WHERE false");
        await denied(runtime, "INSERT INTO public.schema_migrations (version, name, checksum) SELECT '9998', '9998_noop.sql', repeat('0', 64) WHERE false");
      });
      await t.test("runtime has only table CRUD; no TRUNCATE, REFERENCES, TRIGGER or grant options", async () => {
        const privileges = await runtime.query(`SELECT c.relname,
          has_table_privilege(current_user, c.oid, 'SELECT') AS s,
          has_table_privilege(current_user, c.oid, 'INSERT') AS i,
          has_table_privilege(current_user, c.oid, 'UPDATE') AS u,
          has_table_privilege(current_user, c.oid, 'DELETE') AS d,
          has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate,
          has_table_privilege(current_user, c.oid, 'REFERENCES') AS references,
          has_table_privilege(current_user, c.oid, 'TRIGGER') AS trigger,
          has_table_privilege(current_user, c.oid, 'SELECT WITH GRANT OPTION') AS grant_option
          FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND c.relname <> 'schema_migrations' ORDER BY c.relname`);
        assert.equal(privileges.rows.length, 16);
        assert.ok(privileges.rows.some(row => row.relname === "document_processing_jobs"));
        for (const { relname, ...permissions } of privileges.rows) {
          assert.deepEqual(permissions, { s: true, i: true, u: relname !== 'summary_source_snapshots', d: !['summary_source_snapshots','medical_summary_jobs'].includes(relname),
            truncate: false, references: false, trigger: false, grant_option: false }, relname);
        }
      });
      await t.test("runtime performs real SELECT/INSERT/UPDATE/DELETE with update triggers", async () => {
        const id = randomUUID();
        const hash = "$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword";
        await runtime.query("INSERT INTO public.patients (id, email, password_hash, full_name) VALUES ($1, $2, $3, 'Synthetic security probe')", [id, id + "@example.invalid", hash]);
        assert.equal((await runtime.query("SELECT full_name FROM public.patients WHERE id = $1", [id])).rows[0].full_name, "Synthetic security probe");
        await runtime.query("UPDATE public.patients SET full_name = 'Synthetic update' WHERE id = $1", [id]);
        assert.equal((await runtime.query("SELECT full_name FROM public.patients WHERE id = $1", [id])).rows[0].full_name, "Synthetic update");
        assert.equal((await runtime.query("DELETE FROM public.patients WHERE id = $1", [id])).rowCount, 1);
      });
    } finally { await runtime.query("ROLLBACK"); runtime.release(); }

    const owner = await migrationPool.connect();
    try {
      await owner.query("BEGIN");
      await t.test("migration owner can create/alter objects and maintain ledger without persisting probes", async () => {
        await owner.query("CREATE TABLE public.phase14a_future_probe (id uuid PRIMARY KEY)");
        await owner.query("ALTER TABLE public.phase14a_future_probe ADD COLUMN note text");
        await owner.query("INSERT INTO public.schema_migrations (version, name, checksum) VALUES ('9998', '9998_security_probe.sql', repeat('f', 64))");
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '9998'")).rows[0].n, 1);
      });
      await t.test("new migration-owned objects deny runtime/public access until explicit grants", async () => {
        await owner.query("CREATE SEQUENCE public.phase14a_future_sequence");
        await owner.query("CREATE FUNCTION public.phase14a_future_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
        const before = await owner.query(`SELECT
          has_table_privilege('health_wallet_app', 'public.phase14a_future_probe', 'SELECT') AS table_access,
          has_sequence_privilege('health_wallet_app', 'public.phase14a_future_sequence', 'USAGE') AS sequence_access,
          has_function_privilege('health_wallet_app', 'public.phase14a_future_function()', 'EXECUTE') AS function_access,
          EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = 'public.phase14a_future_function()'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute`);
        assert.deepEqual(before.rows[0], { table_access: false, sequence_access: false, function_access: false, public_execute: false });
        await owner.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.phase14a_future_probe TO health_wallet_app");
        await owner.query("GRANT USAGE ON SEQUENCE public.phase14a_future_sequence TO health_wallet_app");
        await owner.query("GRANT EXECUTE ON FUNCTION public.phase14a_future_function() TO health_wallet_app");
        const after = await owner.query(`SELECT
          has_table_privilege('health_wallet_app', 'public.phase14a_future_probe', 'SELECT, INSERT, UPDATE, DELETE') AS table_access,
          has_sequence_privilege('health_wallet_app', 'public.phase14a_future_sequence', 'USAGE') AS sequence_access,
          has_function_privilege('health_wallet_app', 'public.phase14a_future_function()', 'EXECUTE') AS function_access`);
        assert.deepEqual(after.rows[0], { table_access: true, sequence_access: true, function_access: true });
      });
    } finally { await owner.query("ROLLBACK"); owner.release(); }
    await t.test("all owner permission probes and tracking rows were rolled back", async () => {
      const result = await migrationPool.query(`SELECT
        to_regclass('public.phase14a_future_probe') AS probe,
        to_regclass('public.phase14a_future_sequence') AS sequence,
        to_regprocedure('public.phase14a_future_function()') AS function,
        (SELECT count(*)::int FROM public.schema_migrations WHERE version = '9998') AS history`);
      assert.deepEqual(result.rows[0], { probe: null, sequence: null, function: null, history: 0 });
    });
    await t.test("private files remain ignored/untracked; actual credentials are absent from source", async () => {
      const root = new URL("../../../", import.meta.url);
      const privateFiles = ["backend/.env", "backend/.env.migrations", "infrastructure/.env"];
      for (const file of privateFiles) {
        assert.equal((await stat(new URL(file, root))).mode & 0o077, 0, file);
        assert.equal(execFileSync("git", ["check-ignore", file], { cwd: root, encoding: "utf8" }).trim(), file);
        assert.equal(execFileSync("git", ["ls-files", "--", file], { cwd: root, encoding: "utf8" }), "");
      }
      const runtime = parse(await readFile(new URL("backend/.env", root)));
      const migration = parse(await readFile(new URL("backend/.env.migrations", root)));
      const admin = parse(await readFile(new URL("infrastructure/.env", root)));
      assert.equal(runtime.DB_USER, "health_wallet_app");
      assert.equal(runtime.MIGRATION_DB_PASSWORD, undefined);
      assert.equal(migration.MIGRATION_DB_USER, "health_wallet_migrator");
      const secrets = [runtime.DB_PASSWORD, migration.MIGRATION_DB_PASSWORD, admin.POSTGRES_PASSWORD];
      assert.ok(secrets.every(value => value && value.length > 0));
      const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
      for (const file of files) {
        const contents = await readFile(new URL(file, root), "utf8");
        assert.ok(!secrets.some(secret => contents.includes(secret)), "Actual credential found in source: " + file);
      }
    });
    await t.test("HTTP health endpoints run through the restricted runtime pool", async () => {
      assert.equal((await pool.query("SELECT current_user")).rows[0].current_user, "health_wallet_app");
      const { default: app } = await import("../app.js");
      const server = app.listen(0, "127.0.0.1");
      try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        for (const route of ["/api/v1/health", "/api/v1/health/db"]) {
          const response: Response = await fetch("http://127.0.0.1:" + address.port + route, { signal: AbortSignal.timeout(8000) });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.success, true);
          if (route.endsWith("/db")) assert.equal(body.database, "connected");
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  } finally { await Promise.all([closeDatabasePool(), closeMigrationPool()]); }
});

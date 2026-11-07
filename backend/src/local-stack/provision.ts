// Creates the local demo database once: roles, database, pgvector, grants and every migration, in order.
// Uses the operating-system user over the local socket (trust), the same way the isolated test suites do. Local demo only.
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import pg from "pg";
import { assertLocalStack } from "./guard.js";

assertLocalStack(process.env);
const socket = process.env.DB_HOST!;
const port = Number(process.env.DB_PORT);
const name = process.env.DB_NAME!;
if (!/^[a-z][a-z0-9_]{2,30}$/.test(name)) throw new Error("Invalid database name.");
const client = (database: string) => new pg.Client({ host: socket, port, user: userInfo().username, database });

const boot = client("postgres");
await boot.connect();
let created = false;
try {
  if (!(await boot.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount) {
    for (const role of ["health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE", "health_wallet_migrator NOLOGIN"]) {
      const roleName = role.split(" ")[0]!;
      if (!(await boot.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [roleName])).rowCount) await boot.query("CREATE ROLE " + role);
    }
    await boot.query("CREATE DATABASE " + name);
    created = true;
  }
} finally { await boot.end(); }

if (!created) { console.log("Database already provisioned; nothing to do."); process.exit(0); }
const admin = client(name);
await admin.connect();
try {
  await admin.query("CREATE EXTENSION vector");
  await admin.query("GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator");
  const files = (await readdir(new URL("../../migrations/", import.meta.url))).filter(f => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (file.startsWith("0005")) await admin.query("GRANT USAGE ON SCHEMA public TO health_wallet_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app");
    try {
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE health_wallet_migrator");
      await admin.query(await readFile(new URL("../../migrations/" + file, import.meta.url), "utf8"));
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
  }
  console.log("Provisioned " + files.length + " migrations.");
} finally { await admin.end(); }

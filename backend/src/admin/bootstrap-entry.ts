// Command-line admin creation only. The password is read from a hidden prompt or piped stdin, never from arguments or the environment.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Writable } from "node:stream";
import { getAuthenticationConfig } from "../config/auth.js";
import { assertDedicatedDatabase } from "../database/migrations.js";
import { createPasswordService } from "../auth/passwords.js";
import { AdminBootstrapError, createAdminAccount } from "./bootstrap.js";

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const lines = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write("Admin password: ");
  muted = true;
  const value = await new Promise<string>(resolve => lines.question("", resolve));
  muted = false;
  lines.close();
  process.stdout.write("\n");
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" } }, strict: true });
  if (!values.email || !values.name || !values.role) throw new AdminBootstrapError("Usage: npm run admin:create -- --email <email> --name <full name> --role <support_admin|operations_admin|config_admin>");
  assertDedicatedDatabase();
  const passwords = createPasswordService(getAuthenticationConfig());
  const { migrationPool } = await import("../database/migration-pool.js");
  try {
    const created = await createAdminAccount(migrationPool, plain => passwords.hash(plain), { email: values.email, fullName: values.name, role: values.role, password: await readPassword() });
    console.log("Created admin " + created.id + " (" + created.role + ").");
  } finally {
    await migrationPool.end();
  }
}

main().catch(error => {
  console.error(error instanceof AdminBootstrapError ? error.message : "Admin creation failed. No details were logged.");
  process.exitCode = 1;
});

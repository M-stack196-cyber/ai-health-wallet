// Local demo seed: one synthetic admin account and two synthetic sample files. Local demo only (refuses elsewhere).
// The generated admin password is written ONLY to an owner-only file outside the repository; it is never printed.
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { userInfo } from "node:os";
import pg from "pg";
import { assertLocalStack } from "./guard.js";
import { getAuthenticationConfig } from "../config/auth.js";
import { createPasswordService } from "../auth/passwords.js";
import { createAdminAccount } from "../admin/bootstrap.js";
import { syntheticDigitalPdf } from "../processing/fixtures/pdf-fixtures.js";
import { syntheticScannedPdf } from "../processing/fixtures/ocr-fixtures.js";

assertLocalStack(process.env);
const home = process.env.HW_STACK_HOME ?? "";
if (!home.startsWith("/")) throw new Error("HW_STACK_HOME is required.");
const adminEmail = "demo-admin@example.invalid";
const db = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: userInfo().username, max: 1 });
try {
  const exists = (await db.query("SELECT 1 FROM public.admin_accounts WHERE email=$1", [adminEmail])).rowCount;
  const accounts = join(home, "run", "demo-accounts.txt");
  if (!exists) {
    // 24 random characters plus fixed classes so the account password policy is met.
    const password = "Demo-" + randomBytes(12).toString("hex") + "-aA1!";
    await createAdminAccount(db as never, plain => createPasswordService(getAuthenticationConfig()).hash(plain),
      { email: adminEmail, fullName: "Demo Admin (synthetic)", role: "support_admin", password });
    await writeFile(accounts, "SYNTHETIC DEMO ACCOUNTS (local only)\nadmin email: " + adminEmail + "\nadmin password: " + password + "\n", { mode: 0o600 });
    console.log("Created synthetic admin " + adminEmail + ". Password saved in the owner-only file " + accounts);
  } else console.log("Synthetic admin already exists. Password file: " + accounts);
  const samples = join(home, "samples");
  await mkdir(samples, { recursive: true, mode: 0o700 });
  await writeFile(join(samples, "sample-digital-report.pdf"), syntheticDigitalPdf([["SYNTHETIC LAB REPORT", "Glucose: 90 mg/dL", "Date: 2026-01-15"]]), { mode: 0o600 });
  await writeFile(join(samples, "sample-scanned-report.pdf"), await syntheticScannedPdf([{ scan: "SYNTHETIC LAB REPORT\nHemoglobin: 13.5 g/dL\nDate: 2026-02-10" }]), { mode: 0o600 });
  console.log("Wrote synthetic sample files to " + samples);
} finally { await db.end(); }

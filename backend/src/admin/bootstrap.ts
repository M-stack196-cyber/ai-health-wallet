import { randomUUID } from "node:crypto";
import type { PatientDatabase } from "../patients/repository.js";
import { normalizeEmail, password as validatePassword } from "../patients/validation.js";
import { transaction } from "../auth/security-repository.js";
import { adminRoles, writeAdminAudit, type AdminRole } from "./repository.js";

export class AdminBootstrapError extends Error {}

export interface NewAdmin { email: unknown; fullName: unknown; role: unknown; password: unknown; }

/** Creates one admin. Run only through the command-line entry with the migration role: the API role has no INSERT on admin_accounts. */
export async function createAdminAccount(db: PatientDatabase, hash: (password: string) => Promise<string>, input: NewAdmin) {
  let email: string, password: string;
  try { email = normalizeEmail(input.email); password = validatePassword(input.password, true); }
  catch { throw new AdminBootstrapError("A valid email and a password meeting the account policy are required."); }
  const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
  if (!fullName || fullName.length > 120 || /[\u0000-\u001f\u007f]/.test(fullName)) throw new AdminBootstrapError("A full name of 1 to 120 printable characters is required.");
  if (typeof input.role !== "string" || !adminRoles.includes(input.role as AdminRole)) throw new AdminBootstrapError("Role must be one of: " + adminRoles.join(", ") + ".");
  const role = input.role as AdminRole, passwordHash = await hash(password);
  try {
    return await transaction(db, async c => {
      const row = (await c.query<{ id: string }>("INSERT INTO public.admin_accounts(email,password_hash,full_name,role_name) VALUES($1,$2,$3,$4) RETURNING id",
        [email, passwordHash, fullName, role])).rows[0];
      await writeAdminAudit(c, { action: "admin.account.create", targetType: "admin_account", targetId: row.id,
        scope: { method: "bootstrap", role }, outcome: "success", requestId: randomUUID() });
      return { id: row.id, email, role };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new AdminBootstrapError("An admin with that email already exists.");
    throw error;
  }
}

import type { QueryResultRow } from "pg";
import { ApiError } from "../http/errors.js";
import type { ProfileChanges, RegistrationInput } from "./validation.js";

export interface PatientDatabase {
  query<Row extends QueryResultRow>(sql: string, values: unknown[]): Promise<{ rows: Row[] }>;
}
export interface PatientProfile extends QueryResultRow {
  id: string;
  email: string;
  full_name: string;
  date_of_birth: string | null;
  phone_number: string | null;
  created_at: Date;
  updated_at: Date;
}
// Explicit projection keeps credential columns out of profile reads and writes.
const profileColumns = "id, email, full_name, date_of_birth::text AS date_of_birth, phone_number, created_at, updated_at";

export function createPatientRepository(database: PatientDatabase) {
  return {
    async register(input: RegistrationInput, hash: string): Promise<PatientProfile> {
      try {
        const result = await database.query<PatientProfile>(`INSERT INTO public.patients
          (email, password_hash, full_name, date_of_birth, phone_number)
          VALUES ($1, $2, $3, $4, $5) RETURNING ${profileColumns}`,
        [input.email, hash, input.full_name, input.date_of_birth ?? null, input.phone_number ?? null]);
        return result.rows[0];
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw new ApiError(409, "REGISTRATION_CONFLICT", "Unable to register with these details.");
        }
        throw error;
      }
    },
    async credentials(email: string): Promise<{ id: string; password_hash: string } | undefined> {
      const result = await database.query<{ id: string; password_hash: string }>(
        "SELECT id, password_hash FROM public.patients WHERE email = $1", [email]);
      return result.rows[0];
    },
    async get(patientId: string): Promise<PatientProfile> {
      const result = await database.query<PatientProfile>(`SELECT ${profileColumns} FROM public.patients WHERE id = $1`, [patientId]);
      if (!result.rows[0]) throw new ApiError(404, "PROFILE_NOT_FOUND", "Patient profile not found.");
      return result.rows[0];
    },
    async update(patientId: string, changes: ProfileChanges): Promise<PatientProfile> {
      // SQL identifiers come only from this constant allowlist, never request keys.
      const keys = (["full_name", "date_of_birth", "phone_number"] as const).filter(key => Object.hasOwn(changes, key));
      const assignments = keys.map((key, index) => key + " = $" + (index + 2)).join(", ");
      const result = await database.query<PatientProfile>(`UPDATE public.patients SET ${assignments}
        WHERE id = $1 RETURNING ${profileColumns}`, [patientId, ...keys.map(key => changes[key])]);
      if (!result.rows[0]) throw new ApiError(404, "PROFILE_NOT_FOUND", "Patient profile not found.");
      return result.rows[0];
    },
  };
}

import { ApiError } from "../http/errors.js";
import { safeDisplayText } from "../http/text.js";

export interface ProfileChanges {
  full_name?: string;
  date_of_birth?: string | null;
  phone_number?: string | null;
  sex_gender?: string | null;
  pending_guardian_email?: string | null;
}
export interface RegistrationInput extends ProfileChanges {
  email: string;
  password: string;
  full_name: string;
}

function invalid(): never {
  throw new ApiError(400, "INVALID_INPUT", "Request fields are missing, invalid or not permitted.");
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") invalid();
  const email = value.trim().toLowerCase();
  const pieces = email.split("@");
  const local = pieces[0];
  const domain = pieces[1];
  if (email.length > 254 || pieces.length !== 2 || !local || local.length > 64
      || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
      || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !domain) invalid();
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/[a-z]/.test(labels.at(-1)!)) invalid();
  return email;
}
export function password(value: unknown, registration: boolean): string {
  if (typeof value !== "string" || [...value].length > 128 || Buffer.byteLength(value, "utf8") > 512
      || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  if (registration) {
    if ([...value].length < 15 || !/\S/u.test(value) || /^(.)\1+$/u.test(value)) invalid();
  } else if (!value.length) invalid();
  // Passwords are never trimmed, case-folded or silently truncated.
  return value;
}
function profile(value: Record<string, unknown>): ProfileChanges {
  const changes: ProfileChanges = {};
  if (Object.hasOwn(value, 'sex_gender')) {
    if (value.sex_gender !== null && !['female','male','other','prefer_not_to_say'].includes(value.sex_gender as string)) invalid();
    changes.sex_gender = value.sex_gender as string | null;
  }
  if (Object.hasOwn(value, 'pending_guardian_email')) changes.pending_guardian_email = value.pending_guardian_email === null ? null : normalizeEmail(value.pending_guardian_email);
  if (Object.hasOwn(value, "full_name")) {
    if (typeof value.full_name !== "string") invalid();
    const name = value.full_name.trim();
    if (!name || [...name].length > 120 || !safeDisplayText(name)) invalid();
    changes.full_name = name;
  }
  if (Object.hasOwn(value, "date_of_birth")) {
    const date = value.date_of_birth;
    if (date !== null) {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) invalid();
      const parsed = new Date(date + "T00:00:00Z");
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > new Date().toISOString().slice(0, 10)) invalid();
    }
    changes.date_of_birth = date;
  }
  if (Object.hasOwn(value, "phone_number")) {
    const raw = value.phone_number;
    if (raw === null) changes.phone_number = null;
    else {
      if (typeof raw !== "string") invalid();
      const phone = raw.trim();
      const digits = phone.replace(/\D/g, "");
      if (phone.length > 25 || !/^\+?[0-9 ()-]+$/.test(phone) || digits.length < 7 || digits.length > 15) invalid();
      changes.phone_number = phone;
    }
  }
  return changes;
}
export function validateRegistration(body: unknown): RegistrationInput {
  const input = object(body, ["email", "password", "full_name", "date_of_birth", "phone_number", "sex_gender", "pending_guardian_email"]);
  const changes = profile(input);
  if (!changes.full_name) invalid();
  return { ...changes, full_name: changes.full_name, email: normalizeEmail(input.email), password: password(input.password, true) };
}
export function validateLogin(body: unknown): { email: string; password: string } {
  const input = object(body, ["email", "password"]);
  return { email: normalizeEmail(input.email), password: password(input.password, false) };
}
export function validateProfilePatch(body: unknown): ProfileChanges {
  const input = object(body, ["full_name", "date_of_birth", "phone_number", "sex_gender", "pending_guardian_email"]);
  if (Object.keys(input).length === 0) invalid();
  return profile(input);
}

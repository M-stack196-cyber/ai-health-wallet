import { InputError } from "@health-wallet/api";
/**
 * Turns a typed date into YYYY-MM-DD. Empty input stays empty.
 * Accepted: YYYY-MM-DD, YYYY/MM/DD, M/D/YYYY (month first), DD-MM-YYYY or DD.MM.YYYY (day first).
 * If only one reading is a real calendar date (for example 25/12/2026), that reading is used.
 * Anything else throws, so a wrong date is never guessed.
 */
export function normalizeDate(input: string): string {
  const text = input.trim();
  if (!text) return "";
  const m = /^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})$/.exec(text);
  const fail = () =>
    new InputError("Enter a valid date, for example 2026-11-09 or 9/11/2026.");
  if (!m) throw fail();
  const [, a, sep, b, c] = m;
  let candidates: [number, number, number][]; // [year, month, day], preferred first
  if (a.length === 4 && c.length <= 2) candidates = [[+a, +b, +c]];
  else if (c.length === 4 && a.length <= 2) {
    const monthFirst: [number, number, number] = [+c, +a, +b];
    const dayFirst: [number, number, number] = [+c, +b, +a];
    candidates = sep === "/" ? [monthFirst, dayFirst] : [dayFirst, monthFirst];
  } else throw fail();
  for (const [y, mo, d] of candidates) {
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (
      y >= 1000 &&
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === mo - 1 &&
      date.getUTCDate() === d
    )
      return [
        String(y),
        String(mo).padStart(2, "0"),
        String(d).padStart(2, "0"),
      ].join("-");
  }
  throw fail();
}
/** True when an ISO YYYY-MM-DD date is after today. Today is taken in UTC, the same way the server checks it. */
export function isFutureDate(iso: string, now: Date = new Date()): boolean {
  return iso > now.toISOString().slice(0, 10);
}
export const FUTURE_DOCUMENT_DATE = "Document date cannot be in the future.";
export const FUTURE_BIRTH_DATE = "Date of birth cannot be in the future.";
/**
 * Checks a typed date for a form field without throwing, so the message can be shown under the field.
 * Empty input is allowed (the caller decides whether the field is optional). Returns the YYYY-MM-DD value or an error.
 */
export function checkDate(
  input: string,
  kind: "document" | "birth",
): { value: string; error: string } {
  try {
    const value = normalizeDate(input);
    if (value && isFutureDate(value))
      return {
        value: "",
        error: kind === "document" ? FUTURE_DOCUMENT_DATE : FUTURE_BIRTH_DATE,
      };
    return { value, error: "" };
  } catch (e) {
    return {
      value: "",
      error: e instanceof Error ? e.message : "Enter a valid date.",
    };
  }
}

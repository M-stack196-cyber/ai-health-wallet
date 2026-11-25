import { InputError } from "@health-wallet/api";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function validYMD(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    y >= 1000 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  ) {
    return [String(y), String(mo).padStart(2, "0"), String(d).padStart(2, "0")].join("-");
  }
  return null;
}

/**
 * Turns any free-form typed date into YYYY-MM-DD. Empty input stays empty.
 * Supports: YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY, DD.MM.YYYY,
 * "24 November 2026", "24 Nov 2026", "November 24, 2026", "Nov 24 2026", etc.
 */
export function normalizeDate(input: string): string {
  const text = input.trim();
  if (!text) return "";
  const fail = () =>
    new InputError("Enter a valid date (e.g. 24 November 2026, 24/11/2026, or 2026-11-24).");

  // 1. Named month: "24 November 2026" or "24-Nov-2026"
  const dmyWord = /^(\d{1,2})[\s,./-]+([A-Za-z]+)[\s,./-]+(\d{4})$/.exec(text);
  if (dmyWord) {
    const mo = MONTHS[dmyWord[2].toLowerCase()];
    const iso = mo ? validYMD(+dmyWord[3], mo, +dmyWord[1]) : null;
    if (iso) return iso;
    throw fail();
  }

  // 2. Named month first: "November 24, 2026" or "Nov 24 2026"
  const mdyWord = /^([A-Za-z]+)[\s,./-]+(\d{1,2})[\s,./-]+(\d{4})$/.exec(text);
  if (mdyWord) {
    const mo = MONTHS[mdyWord[1].toLowerCase()];
    const iso = mo ? validYMD(+mdyWord[3], mo, +mdyWord[2]) : null;
    if (iso) return iso;
    throw fail();
  }

  // 3. Numeric with any separator (- / . or space)
  const m = /^(\d{1,4})([-/.\s])(\d{1,2})\2(\d{1,4})$/.exec(text);
  if (!m) throw fail();
  const [, a, sep, b, c] = m;
  let candidates: [number, number, number][];
  if (a.length === 4 && c.length <= 2) candidates = [[+a, +b, +c]];
  else if (c.length === 4 && a.length <= 2) {
    const monthFirst: [number, number, number] = [+c, +a, +b];
    const dayFirst: [number, number, number] = [+c, +b, +a];
    candidates = sep === "/" ? [monthFirst, dayFirst] : [dayFirst, monthFirst];
  } else throw fail();

  for (const [y, mo, d] of candidates) {
    const iso = validYMD(y, mo, d);
    if (iso) return iso;
  }
  throw fail();
}

export function isFutureDate(iso: string, now: Date = new Date()): boolean {
  return iso > now.toISOString().slice(0, 10);
}
export const FUTURE_DOCUMENT_DATE = "Document date cannot be in the future.";
export const FUTURE_BIRTH_DATE = "Date of birth cannot be in the future.";

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

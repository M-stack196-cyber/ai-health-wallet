import { ApiError } from "../http/errors.js";

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const invalid = () => new ApiError(400, "INVALID_INPUT", "Request fields are missing, invalid or not permitted.");
/** Timestamp text with microseconds, so keyset paging does not lose precision in JavaScript dates. */
export const cursorTime = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function parseLimit(value: string): number {
  const limit = Number(value);
  if (!/^\d{1,2}$/.test(value) || limit < 1 || limit > 50) throw invalid();
  return limit;
}
export const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify({ c: at, i: id })).toString("base64url");
export function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw invalid();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.c) || typeof parsed.i !== "string" || !uuid.test(parsed.i)) throw invalid();
    return { createdAt: parsed.c, id: parsed.i };
  } catch { throw invalid(); }
}

/** Allowlisted list query: only the named filters plus limit and cursor; repeated or non-string values are rejected. */
export function parseListQuery<K extends string>(query: Record<string, unknown>, filters: Record<K, (value: string) => string>) {
  if (Object.keys(query).some(key => key !== "limit" && key !== "cursor" && !(key in filters) || typeof query[key] !== "string")) throw invalid();
  const values: Partial<Record<K, string>> = {};
  for (const key of Object.keys(filters) as K[]) if (query[key] !== undefined) values[key] = filters[key](query[key] as string);
  return { filters: values, limit: query.limit === undefined ? 25 : parseLimit(query.limit as string), cursor: query.cursor === undefined ? undefined : decodeCursor(query.cursor as string) };
}
export const oneOf = (allowed: readonly string[]) => (value: string): string => { if (!allowed.includes(value)) throw invalid(); return value; };
export const uuidValue = (value: string): string => { if (!uuid.test(value)) throw invalid(); return value.toLowerCase(); };

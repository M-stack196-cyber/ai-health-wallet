import { basename, extname } from "node:path";
import { ApiError } from "../http/errors.js";

export const categories = ["lab_report", "prescription", "other_medical_document"] as const;
export type Category = typeof categories[number];
export type FileType = "pdf" | "jpg" | "jpeg" | "png";
export interface DocumentMetadata { category: Category; hospital_name: string; document_date?: string | null; }
export type MetadataPatch = Partial<DocumentMetadata>;
export interface DocumentFilters { limit: number; offset: number; category?: Category; hospital?: string; uploadedFrom?: string; uploadedTo?: string; }
function invalid(): never { throw new ApiError(400, "INVALID_DOCUMENT_INPUT", "Document fields are missing, invalid or not permitted."); }
function object(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || Object.keys(input).some(key => !allowed.includes(key))) invalid();
  return input as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  const valueTrimmed = value.trim();
  if (!valueTrimmed || [...valueTrimmed].length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(valueTrimmed)) invalid();
  return valueTrimmed;
}
export function calendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) invalid();
  const parsed = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
export function metadata(input: unknown, partial = false): DocumentMetadata | MetadataPatch {
  const values = object(input, ["category", "hospital_name", "document_date"]);
  if (!Object.keys(values).length) invalid();
  const result: MetadataPatch = {};
  if (Object.hasOwn(values, "category")) {
    if (!categories.includes(values.category as Category)) invalid();
    result.category = values.category as Category;
  }
  if (Object.hasOwn(values, "hospital_name")) result.hospital_name = text(values.hospital_name);
  if (Object.hasOwn(values, "document_date")) {
    result.document_date = values.document_date === null ? null : calendarDate(values.document_date);
    if (result.document_date && result.document_date > new Date().toISOString().slice(0, 10)) invalid();
  }
  if (!partial && (!result.category || !result.hospital_name)) invalid();
  return result;
}
export function documentId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    throw new ApiError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
  }
  return input;
}
export function filters(input: unknown): DocumentFilters {
  const values = object(input, ["limit", "offset", "category", "hospital", "uploaded_from", "uploaded_to"]);
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    if (values[key] === undefined) return fallback;
    const raw = values[key];
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) invalid();
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < min || number > max) invalid();
    return number;
  };
  const result: DocumentFilters = { limit: integer("limit", 20, 1, 100), offset: integer("offset", 0, 0, 10000) };
  if (values.category !== undefined) {
    if (!categories.includes(values.category as Category)) invalid();
    result.category = values.category as Category;
  }
  if (values.hospital !== undefined) result.hospital = text(values.hospital);
  if (values.uploaded_from !== undefined) result.uploadedFrom = calendarDate(values.uploaded_from);
  if (values.uploaded_to !== undefined) result.uploadedTo = calendarDate(values.uploaded_to);
  if (result.uploadedFrom && result.uploadedTo && result.uploadedFrom > result.uploadedTo) invalid();
  return result;
}
export function filename(raw: string): { name: string; type: FileType; mime: string } {
  const name = basename(raw.replace(/\\/g, "/")).normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069"<>:|?*]/g, "_").replace(/^\.+/, "");
  const type = extname(name).slice(1).toLowerCase();
  if (!name || Buffer.byteLength(name, "utf8") > 240 || !["pdf", "jpg", "jpeg", "png"].includes(type)) {
    throw new ApiError(415, "UNSUPPORTED_DOCUMENT", "Only PDF, JPG, JPEG and PNG documents are accepted.");
  }
  return { name, type: type as FileType, mime: type === "pdf" ? "application/pdf" : type === "png" ? "image/png" : "image/jpeg" };
}

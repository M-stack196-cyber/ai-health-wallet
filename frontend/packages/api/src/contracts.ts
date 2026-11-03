export class InputError extends Error {}

export type Category = "lab_report" | "prescription" | "other_medical_document";
export const categories: Record<Category, string> = {
  lab_report: "Lab Report",
  prescription: "Prescription",
  other_medical_document: "Other",
};
export interface Profile {
  id: string;
  full_name: string;
  email: string;
  date_of_birth: string | null;
  phone_number: string | null;
  sex_gender: string | null;
  email_verified?: boolean;
}
export type ProfileEdit = Pick<
  Profile,
  "full_name" | "date_of_birth" | "phone_number" | "sex_gender"
>;
export type Registration = Partial<ProfileEdit> & {
  full_name: string;
  email: string;
  password: string;
  pending_guardian_email?: string;
};
export interface MedicalDocument {
  id: string;
  original_filename: string;
  category: Category;
  category_label: string;
  hospital_name: string;
  document_date: string | null;
  uploaded_at: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  access_state: string;
  processing_status: string;
  sort_date: string;
  sort_date_source: string;
}
export interface Filters {
  category?: Category;
  hospital?: string;
  uploaded_from?: string;
  uploaded_to?: string;
  limit?: number;
  offset?: number;
}
export interface Page {
  success: true;
  documents: MedicalDocument[];
  pagination: { limit?: number; offset?: number; has_more: boolean };
}
export interface TimelineEntry {
  source_document_id: string;
  event_date: string;
  date_source: string;
  document: MedicalDocument;
}
export interface Timeline {
  entries: TimelineEntry[];
  pagination: Page["pagination"];
}
export interface Guardian {
  id?: string;
  email: string | null;
  status: "NONE" | "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";
  accepted_at?: string;
  invitation_expires_at?: string;
}
export interface Summary {
  text: string;
  generated_at: string;
  document_id: string;
  mode: string;
  provider?: string;
  model?: string;
  limitations: string[];
  source?: { extractor_version: string };
  uncertainty?: unknown;
}
export interface History {
  id?: string;
  status?: string;
  scope?: "selected_records_only";
  entries: {
    source_document_id: string;
    date: string;
    date_source: string;
    summary?: Summary | null;
    text?: string;
  }[];
  limitations: string[];
}
export interface RagResult {
  id: string;
  status: "answered" | "insufficient";
  answer: string;
  mode: string;
  citations: {
    id: string;
    document_id: string;
    document_name: string;
    document_date: string | null;
    upload_date: string;
    page: number | null;
    quote: string;
  }[];
}
export interface Grant {
  id: string;
  sharing_method: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}
export interface CreatedGrant {
  grant: Grant;
  selected_document_ids: string[];
  share_url: string;
  qr_svg?: string;
}
export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}
export interface Processing {
  document_id: string;
  stage: string;
  status: string;
  failure_code: string | null;
  retry_allowed: boolean;
}
export interface Metadata {
  category: Category;
  hospital_name: string;
  document_date?: string | null;
}
export const medicalNotice =
  "Development / synthetic evidence. Summaries and answers are informational, not diagnosis or treatment advice.";
export function filterQuery(filters: Filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const q = params.toString();
  return q ? "?" + q : "";
}
export function searchLoaded(records: MedicalDocument[], query: string) {
  const q = query.trim().toLowerCase();
  return records.filter((d) =>
    [d.original_filename, d.hospital_name, d.category_label].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}
export function grantState(grant: Grant, now = Date.now()) {
  return grant.revoked_at
    ? "Revoked"
    : Date.parse(grant.expires_at) <= now
      ? "Expired"
      : "Active";
}
export function shareReference(input: string) {
  const raw = input.trim();
  const candidate = raw.includes("#/share/") ? raw.split("#/share/")[1] : raw;
  if (!/^sh1\.[a-f0-9]{64}$/.test(candidate ?? ""))
    throw new InputError("Enter a valid shared link or QR reference.");
  return candidate;
}
export function validateFile(name: string, mime: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  const type =
    ext === "pdf"
      ? "application/pdf"
      : ext === "png"
        ? "image/png"
        : ["jpg", "jpeg"].includes(ext ?? "")
          ? "image/jpeg"
          : null;
  if (!type || type !== mime)
    throw new InputError(
      "Choose a PDF, JPG, JPEG or PNG with a matching file type.",
    );
  return type;
}

/** Admin dashboard (M13). Everything here is account or job metadata; the backend never returns medical content to an admin. */
export const adminPatientStatuses = [
  "unverified",
  "active",
  "suspended",
  "deletion_pending",
  "deletion_restricted",
  "deleted",
  "revoked",
] as const;
export type AdminPatientStatus = (typeof adminPatientStatuses)[number];
export interface AdminLogin {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}
export interface AdminPatient {
  id: string;
  email: string;
  full_name: string;
  account_status: AdminPatientStatus;
  email_verified: boolean;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface AdminPatientQuery {
  q?: string;
  status?: AdminPatientStatus;
  verified?: boolean;
  limit?: number;
  cursor?: string;
}
export interface AdminPage<T> {
  items: T[];
  nextCursor: string | null;
}
export const adminJobStates = [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AdminJobState = (typeof adminJobStates)[number];
export const adminJobErrorCodes = [
  "PROCESSOR_FAILED",
  "PROCESSOR_TIMEOUT",
  "INTERRUPTED",
  "INVALID_INPUT",
  "LEASE_EXPIRED",
] as const;
export type AdminJobErrorCode = (typeof adminJobErrorCodes)[number];
export interface AdminJob {
  document_id: string;
  patient_id: string;
  state: AdminJobState;
  attempt_count: number;
  max_attempts: number;
  last_error_code: AdminJobErrorCode | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_active: boolean;
  lease_expired: boolean;
}
export interface AdminJobQuery {
  state?: AdminJobState;
  error_code?: AdminJobErrorCode;
  patient_id?: string;
  limit?: number;
  cursor?: string;
}
export interface AdminJobSummary {
  by_state: Record<AdminJobState, number>;
  failures_by_error_code: Record<AdminJobErrorCode, number>;
  running_with_expired_lease: number;
  total: number;
}
export function queryString(
  params: Record<string, string | number | boolean | undefined>,
) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") search.set(k, String(v));
  const q = search.toString();
  return q ? "?" + q : "";
}

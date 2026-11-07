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
// Account deletion request (R2). Access ends now; nothing is physically deleted yet.
export const DELETION_CONFIRMATION = "DELETE_MY_ACCOUNT";
export interface DeletionRequestResult {
  success: boolean;
  deletion_request: { id: string; state: "policy_pending" | "blocked_legal_hold"; requested_at: string };
  access_revoked: boolean;
  physical_deletion: "not_performed";
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

/** The signed-in admin, from GET /admin/me. Permissions only decide which menu items are shown; the backend checks every request itself. */
export interface AdminMe {
  id: string;
  email: string;
  full_name: string;
  role: string;
  permissions: string[];
}
export interface AdminPageWithChain<T> extends AdminPage<T> {
  chain: AdminAuditChain | null;
}

/** Status views (guardians, doctor share grants, deliveries). Metadata only: no emails, tokens, codes or message text. */
export const adminGuardianStatuses = ["PENDING", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export type AdminGuardianStatus = (typeof adminGuardianStatuses)[number];
export const adminShareStatuses = ["active", "expired", "revoked"] as const;
export type AdminShareStatus = (typeof adminShareStatuses)[number];
export const adminShareMethods = ["qr_code", "unique_link"] as const;
export type AdminShareMethod = (typeof adminShareMethods)[number];
export const adminDeliveryChannels = ["security_email", "guardian_notification"] as const;
export type AdminDeliveryChannel = (typeof adminDeliveryChannels)[number];
export const adminEmailPurposes = ["verify_email", "reset_password", "guardian_invitation", "doctor_share_otp"] as const;
export type AdminEmailPurpose = (typeof adminEmailPurposes)[number];
export const adminDeliveryStates = [
  "pending",
  "sending",
  "running",
  "retry_wait",
  "transient_failed",
  "permanent_failed",
  "delivered",
  "expired",
  "superseded",
  "cancelled",
] as const;
export type AdminDeliveryState = (typeof adminDeliveryStates)[number];
export interface AdminGuardian {
  id: string;
  patient_id: string;
  status: AdminGuardianStatus;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  /** Detail only. */
  events?: { event: string; occurred_at: string }[];
}
export interface AdminShare {
  id: string;
  patient_id: string;
  sharing_method: AdminShareMethod;
  recipient_bound: boolean;
  status: AdminShareStatus;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  active_session_count: number;
  /** Detail only. */
  event_counts?: Record<string, number>;
  last_event_at?: string | null;
}
export interface AdminDelivery {
  channel: AdminDeliveryChannel;
  id: string;
  patient_id: string;
  purpose: AdminEmailPurpose | null;
  state: AdminDeliveryState;
  attempts: number;
  max_attempts: number | null;
  failure_reason: string | null;
  next_attempt_at: string | null;
  created_at: string;
  delivered_at: string | null;
}
export interface AdminGuardianSummary {
  by_status: Record<AdminGuardianStatus, number>;
  total: number;
}
export interface AdminShareSummary {
  by_status: Record<AdminShareStatus, number>;
  by_method: Record<AdminShareMethod, number>;
  total: number;
}
export interface AdminDeliverySummary {
  by_channel: Record<AdminDeliveryChannel, Record<AdminDeliveryState, number>>;
  total: number;
}
export interface AdminGuardianQuery { status?: AdminGuardianStatus; patient_id?: string; limit?: number; cursor?: string }
export interface AdminShareQuery { status?: AdminShareStatus; method?: AdminShareMethod; patient_id?: string; limit?: number; cursor?: string }
export interface AdminDeliveryQuery { channel?: AdminDeliveryChannel; state?: AdminDeliveryState; purpose?: AdminEmailPurpose; patient_id?: string; limit?: number; cursor?: string }

/** Operational settings. The eleven keys are fixed by the backend allowlist; the screen shows whatever the backend lists. */
export type AdminSettingStatus = "effective" | "superseded" | "pending_approval" | "rejected";
export interface AdminSettingGate { cfg: string; requirement: string }
export interface AdminSetting {
  key: string;
  unit: string;
  min: number;
  max: number;
  default: number;
  source: string;
  gate: AdminSettingGate | null;
  value: number;
  version: number;
  pending_versions: number;
}
export interface AdminSettingVersion {
  version: number;
  value: number;
  status: AdminSettingStatus;
  requires_approval: boolean;
  gate: string | null;
  proposed_by: string;
  proposed_at: string;
  decision: null | { decision: "approved" | "rejected"; decided_by: string; reference: string; decided_at: string };
}
export interface AdminSettingDetail extends AdminSetting {
  history: AdminSettingVersion[];
}
export interface AdminSettingChange {
  setting: AdminSettingDetail;
  version: number;
  status: "effective" | "pending_approval";
}
export type AdminDecision = "approved" | "rejected";

/** Serious-rule versions. `clinical_approval` is fixed by the database; the client has no way to send it. */
export const adminRuleOperators = ["gt", "gte", "lt", "lte", "between", "outside"] as const;
export type AdminRuleOperator = (typeof adminRuleOperators)[number];
export interface AdminRuleDefinition {
  field: string;
  units: string;
  operator: AdminRuleOperator;
  bounds: number[];
  context: Record<string, string>;
}
export interface AdminRule {
  id: string;
  rule_id: string;
  version: number;
  definition: AdminRuleDefinition;
  definition_sha256: string;
  clinical_approval: string;
  created_by: string;
  created_at: string;
}
export interface AdminRuleInput {
  rule_id: string;
  definition: AdminRuleDefinition;
}
export interface AdminRuleQuery { rule_id?: string; limit?: number; cursor?: string }

/** System health. Counts, durations and fixed reason codes only. */
export type AdminHealthStatus = "ok" | "degraded" | "down" | "unknown" | "not_configured";
export type AdminHealthComponent = { name: string; status: AdminHealthStatus; reason?: string } & Record<string, string | number | boolean | null | undefined>;
export interface AdminHealth {
  status: "ok" | "degraded" | "down";
  checked_at: string;
  components: AdminHealthComponent[];
}

/** Audit log review. */
export const adminAuditOutcomes = ["success", "denied", "failure"] as const;
export type AdminAuditOutcome = (typeof adminAuditOutcomes)[number];
export interface AdminAuditEvent {
  seq: number;
  id: string;
  occurred_at: string;
  actor_admin_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  scope: unknown;
  outcome: AdminAuditOutcome;
  request_id: string;
  event_hash: string;
}
export interface AdminAuditChain {
  status: "intact" | "broken";
  events_checked: number;
  first_invalid_seq: number | null;
}
export interface AdminAuditQuery {
  actor_admin_id?: string;
  action?: string;
  target_type?: string;
  outcome?: AdminAuditOutcome;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/** Same rules as the backend, so a form can explain a problem before anything is sent. The backend still decides. */
export const adminUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const adminReferencePattern = /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,119}$/;
export const adminRuleIdPattern = /^[A-Z][A-Z0-9_]{2,79}$/;
export function validateSettingInput(setting: Pick<AdminSetting, "min" | "max" | "unit" | "value">, text: string): number {
  const t = text.trim();
  if (!/^-?\d{1,15}$/.test(t)) throw new InputError("The value must be a whole number.");
  const value = Number(t);
  if (value < setting.min || value > setting.max)
    throw new InputError(`The value must be between ${setting.min} and ${setting.max} ${setting.unit}.`);
  if (value === setting.value) throw new InputError("That is already the value in effect. Enter a different value.");
  return value;
}
export function validateDecisionInput(reference: string): string {
  const r = reference.trim();
  if (!adminReferencePattern.test(r))
    throw new InputError("Enter the review reference (1 to 120 characters). Use letters, numbers, spaces and . _ : / # - only, starting with a letter or number.");
  return r;
}

export interface AdminRuleForm {
  ruleId: string;
  field: string;
  units: string;
  operator: AdminRuleOperator | "";
  bounds: [string, string];
  context: { key: string; value: string }[];
}
/** Builds the request from the form, or throws an InputError with a plain message. There is deliberately no approval field here. */
export function validateRuleForm(form: AdminRuleForm): AdminRuleInput {
  const ruleId = form.ruleId.trim(), field = form.field.trim(), units = form.units.trim();
  if (!adminRuleIdPattern.test(ruleId))
    throw new InputError("The rule ID must be 3 to 80 characters: capital letters, numbers and underscores, starting with a capital letter.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_ ./-]{0,79}$/.test(field))
    throw new InputError("The field name must be 1 to 80 characters: letters, numbers, spaces and _ . / - only.");
  if (!/^[A-Za-z0-9_%/.^-]{1,30}$/.test(units))
    throw new InputError("The units must be 1 to 30 characters: letters, numbers and _ % / . ^ - only.");
  const operator = adminRuleOperators.find((o) => o === form.operator);
  if (!operator) throw new InputError("Choose how the value is compared.");
  const two = operator === "between" || operator === "outside";
  const texts = two ? form.bounds : [form.bounds[0]];
  const bounds = texts.map((t) => {
    const s = t.trim(),
      n = Number(s);
    if (s === "" || !Number.isFinite(n) || Math.abs(n) > 1000000)
      throw new InputError("Each bound must be a number between -1000000 and 1000000.");
    return n;
  });
  if (two && bounds[0] > bounds[1]) throw new InputError("The first bound cannot be larger than the second.");
  const rows = form.context.filter((r) => r.key.trim() !== "" || r.value.trim() !== "");
  if (rows.length > 5) throw new InputError("Use at most 5 context entries.");
  const pair = /^[A-Za-z0-9_ ./-]{1,60}$/, context: Record<string, string> = Object.create(null);
  for (const r of rows) {
    const k = r.key.trim(),
      v = r.value.trim();
    if (!pair.test(k) || !pair.test(v))
      throw new InputError("Each context name and value must be 1 to 60 characters: letters, numbers, spaces and _ . / - only.");
    if (k in context) throw new InputError("A context name can be used only once.");
    context[k] = v;
  }
  return { rule_id: ruleId, definition: { field, units, operator, bounds, context: { ...context } } };
}

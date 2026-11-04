export * from "./contracts";
export * from "./client";
import { ApiClient } from "./client";
import {
  filterQuery,
  queryString,
  InputError,
  type AdminPatient,
  type AdminPatientQuery,
  type AdminPage,
  type AdminJob,
  type AdminJobQuery,
  type AdminJobSummary,
  type AdminMe,
  type AdminPageWithChain,
  type AdminGuardian,
  type AdminGuardianQuery,
  type AdminGuardianSummary,
  type AdminShare,
  type AdminShareQuery,
  type AdminShareSummary,
  type AdminDelivery,
  type AdminDeliveryQuery,
  type AdminDeliverySummary,
  type AdminSetting,
  type AdminSettingDetail,
  type AdminSettingChange,
  type AdminDecision,
  type AdminRule,
  type AdminRuleInput,
  type AdminRuleQuery,
  type AdminHealth,
  type AdminAuditEvent,
  type AdminAuditChain,
  type AdminAuditQuery,
  type Filters,
  type Profile,
  type ProfileEdit,
  type Registration,
  type Page,
  type MedicalDocument,
  type Guardian,
  type Timeline,
  type Summary,
  type History,
  type RagResult,
  type CreatedGrant,
  type Grant,
  type Processing,
  type Metadata,
} from "./contracts";
const root = "/api/v1";
const id = (v: string) => encodeURIComponent(v);
export function patientApi(client: ApiClient) {
  return {
    register: (body: Registration) =>
      client.request(root + "/auth/register", "POST", body, false),
    verify: (token: string) =>
      client.request(root + "/auth/verify-email", "POST", { token }, false),
    resend: (email: string) =>
      client.request(
        root + "/auth/verification/resend",
        "POST",
        { email },
        false,
      ),
    forgot: (email: string) =>
      client.request(root + "/auth/forgot-password", "POST", { email }, false),
    profile: () => client.request<{ patient: Profile }>(root + "/patients/me"),
    updateProfile: (body: ProfileEdit) =>
      client.request<{ patient: Profile }>(
        root + "/patients/me",
        "PATCH",
        body,
      ),
    guardian: () =>
      client.request<{ guardian: Guardian }>(root + "/patients/me/guardian"),
    setGuardian: (email: string, replace = false) =>
      client.request(root + "/patients/me/guardian", replace ? "PUT" : "POST", {
        email,
      }),
    resendGuardian: () =>
      client.request(root + "/patients/me/guardian/resend", "POST", {}),
    removeGuardian: () =>
      client.request(root + "/patients/me/guardian", "DELETE"),
    records: (filters: Filters = {}) =>
      client.request<Page>(root + "/documents" + filterQuery(filters)),
    record: (documentId: string) =>
      client.request<{ document: MedicalDocument }>(
        root + "/documents/" + id(documentId),
      ),
    upload: (form: FormData) =>
      client.request<{ document: MedicalDocument }>(
        root + "/documents",
        "POST",
        form,
      ),
    metadata: (documentId: string, body: Metadata) =>
      client.request(root + "/documents/" + id(documentId), "PATCH", body),
    remove: (documentId: string) =>
      client.request<{
        access_state: string;
        retention_status: string;
        original_erased: boolean;
      }>(root + "/documents/" + id(documentId), "DELETE"),
    original: (documentId: string) =>
      client.request<Blob>(
        root + "/documents/" + id(documentId) + "/download",
        "GET",
        undefined,
        true,
        true,
      ),
    processing: (documentId: string) =>
      client.request<{ processing: Processing }>(
        root + "/documents/" + id(documentId) + "/processing",
      ),
    retry: (documentId: string) =>
      client.request(
        root + "/documents/" + id(documentId) + "/processing-retries",
        "POST",
        {},
      ),
    summary: (documentId: string) =>
      client.request<{ summary: Summary }>(
        root + "/documents/" + id(documentId) + "/summary",
      ),
    requestSummary: (documentId: string) =>
      client.request<{ job: { id: string; status: string } }>(
        root + "/documents/" + id(documentId) + "/summary-jobs",
        "POST",
        {},
      ),
    summaryJob: (jobId: string) =>
      client.request<{ job: { id: string; status: string } }>(
        root + "/summary-jobs/" + id(jobId),
      ),
    retrySummary: (jobId: string) =>
      client.request(
        root + "/summary-jobs/" + id(jobId) + "/retries",
        "POST",
        {},
      ),
    requestHistory: () =>
      client.request<{ history: { id: string; source_count: number } }>(
        root + "/history-summary-jobs",
        "POST",
        {},
      ),
    history: (jobId: string) =>
      client.request<{ history: History }>(
        root + "/history-summary-jobs/" + id(jobId),
      ),
    timeline: (filters: Filters = {}) =>
      client.request<Timeline>(root + "/timeline" + filterQuery(filters)),
    ask: (question: string) =>
      client.request<{ result: RagResult }>(root + "/rag/queries", "POST", {
        question,
      }),
    grants: () => client.request<{ grants: Grant[] }>(root + "/sharing/grants"),
    share: (document_ids: string[], share_type: "qr_code" | "unique_link") => {
      if (!document_ids.length)
        throw new InputError("Select at least one record.");
      return client.request<CreatedGrant>(root + "/sharing/grants", "POST", {
        document_ids,
        share_type,
      });
    },
    revoke: (grantId: string) =>
      client.request(
        root + "/sharing/grants/" + id(grantId) + "/revoke",
        "POST",
        {},
      ),
  };
}
export function doctorApi(client: ApiClient) {
  return {
    open: (share_token: string) =>
      client.request<{
        expires_at: string;
        sharing_method: string;
        requires_email_otp: boolean;
      }>(root + "/sharing/open", "POST", { share_token }, false),
    otp: (body: {
      share_token: string;
      name: string;
      email: string;
      organization?: string;
    }) =>
      client.request<{ challenge_id: string; expires_in: number }>(
        root + "/sharing/otp",
        "POST",
        body,
        false,
      ),
    verify: (body: {
      share_token: string;
      email: string;
      challenge_id: string;
      otp: string;
    }) =>
      client.request<{ access_token: string; expires_at: string }>(
        root + "/sharing/otp/verify",
        "POST",
        body,
        false,
      ),
    records: (filters: Filters = {}) =>
      client.request<Page>(root + "/doctor/records" + filterQuery(filters)),
    record: (documentId: string) =>
      client.request<{ document: MedicalDocument }>(
        root + "/doctor/records/" + id(documentId),
      ),
    file: (documentId: string, download = false) =>
      client.request<Blob>(
        root +
          "/doctor/records/" +
          id(documentId) +
          (download ? "/download" : "/view"),
        "GET",
        undefined,
        true,
        true,
      ),
    summary: (documentId: string) =>
      client.request<{ summary: Summary }>(
        root + "/doctor/records/" + id(documentId) + "/summary",
      ),
    history: () => client.request<History>(root + "/doctor/history-summary"),
    timeline: (filters: Filters = {}) =>
      client.request<Timeline>(
        root + "/doctor/timeline" + filterQuery(filters),
      ),
    ask: (question: string) =>
      client.request<{ result: RagResult }>(
        root + "/doctor/rag/queries",
        "POST",
        { question },
      ),
  };
}

/** Read-only metadata views plus the audited actions the backend permits. Nothing here can fetch medical content. */
export function adminApi(client: ApiClient) {
  const admin = root + "/admin";
  return {
    patients: async (query: AdminPatientQuery = {}): Promise<AdminPage<AdminPatient>> => {
      const r = await client.request<{
        patients: AdminPatient[];
        next_cursor: string | null;
      }>(admin + "/patients" + queryString({ ...query }));
      return { items: r.patients, nextCursor: r.next_cursor };
    },
    patient: (patientId: string) =>
      client.request<{ patient: AdminPatient }>(
        admin + "/patients/" + id(patientId),
      ),
    suspend: (patientId: string) =>
      client.request<{ patient: AdminPatient }>(
        admin + "/patients/" + id(patientId) + "/suspend",
        "POST",
      ),
    reactivate: (patientId: string) =>
      client.request<{ patient: AdminPatient }>(
        admin + "/patients/" + id(patientId) + "/reactivate",
        "POST",
      ),
    processingSummary: () =>
      client.request<{ summary: AdminJobSummary }>(
        admin + "/processing/summary",
      ),
    jobs: async (query: AdminJobQuery = {}): Promise<AdminPage<AdminJob>> => {
      const r = await client.request<{
        jobs: AdminJob[];
        next_cursor: string | null;
      }>(admin + "/processing/jobs" + queryString({ ...query }));
      return { items: r.jobs, nextCursor: r.next_cursor };
    },
    job: (documentId: string) =>
      client.request<{ job: AdminJob }>(
        admin + "/processing/jobs/" + id(documentId),
      ),
    retryJob: (documentId: string) =>
      client.request<{ job: AdminJob }>(
        admin + "/processing/jobs/" + id(documentId) + "/retry",
        "POST",
      ),
    me: () => client.request<{ admin: AdminMe }>(admin + "/me"),

    guardianSummary: () =>
      client.request<{ summary: AdminGuardianSummary }>(admin + "/status/guardians/summary"),
    guardians: async (query: AdminGuardianQuery = {}): Promise<AdminPage<AdminGuardian>> => {
      const r = await client.request<{ guardians: AdminGuardian[]; next_cursor: string | null }>(
        admin + "/status/guardians" + queryString({ ...query }),
      );
      return { items: r.guardians, nextCursor: r.next_cursor };
    },
    guardian: (relationshipId: string) =>
      client.request<{ guardian: AdminGuardian }>(admin + "/status/guardians/" + id(relationshipId)),
    shareSummary: () =>
      client.request<{ summary: AdminShareSummary }>(admin + "/status/shares/summary"),
    shares: async (query: AdminShareQuery = {}): Promise<AdminPage<AdminShare>> => {
      const r = await client.request<{ shares: AdminShare[]; next_cursor: string | null }>(
        admin + "/status/shares" + queryString({ ...query }),
      );
      return { items: r.shares, nextCursor: r.next_cursor };
    },
    share: (grantId: string) =>
      client.request<{ share: AdminShare }>(admin + "/status/shares/" + id(grantId)),
    deliverySummary: () =>
      client.request<{ summary: AdminDeliverySummary }>(admin + "/status/deliveries/summary"),
    deliveries: async (query: AdminDeliveryQuery = {}): Promise<AdminPage<AdminDelivery>> => {
      const r = await client.request<{ deliveries: AdminDelivery[]; next_cursor: string | null }>(
        admin + "/status/deliveries" + queryString({ ...query }),
      );
      return { items: r.deliveries, nextCursor: r.next_cursor };
    },

    settings: () => client.request<{ settings: AdminSetting[] }>(admin + "/settings"),
    setting: (key: string) =>
      client.request<{ setting: AdminSettingDetail }>(admin + "/settings/" + id(key)),
    proposeSetting: (key: string, value: number) =>
      client.request<AdminSettingChange>(admin + "/settings/" + id(key) + "/versions", "POST", { value }),
    decideSetting: (key: string, version: number, decision: AdminDecision, reference: string) =>
      client.request<{ setting: AdminSettingDetail }>(
        admin + "/settings/" + id(key) + "/versions/" + id(String(version)) + "/decision",
        "POST",
        { decision, reference },
      ),

    rules: async (query: AdminRuleQuery = {}): Promise<AdminPage<AdminRule>> => {
      const r = await client.request<{ rules: AdminRule[]; next_cursor: string | null }>(
        admin + "/rules" + queryString({ ...query }),
      );
      return { items: r.rules, nextCursor: r.next_cursor };
    },
    rule: (ruleVersionId: string) =>
      client.request<{ rule: AdminRule }>(admin + "/rules/" + id(ruleVersionId)),
    /** Sends exactly rule_id and definition. Anything else a caller passes (for example an approval field) is dropped here, and the backend refuses it too. */
    createRule: (input: AdminRuleInput) =>
      client.request<{ rule: AdminRule }>(admin + "/rules", "POST", {
        rule_id: input.rule_id,
        definition: {
          field: input.definition.field,
          units: input.definition.units,
          operator: input.definition.operator,
          bounds: [...input.definition.bounds],
          context: { ...input.definition.context },
        },
      }),

    health: () => client.request<{ health: AdminHealth }>(admin + "/health"),
    audit: async (query: AdminAuditQuery = {}): Promise<AdminPageWithChain<AdminAuditEvent>> => {
      const r = await client.request<{
        events: AdminAuditEvent[];
        next_cursor: string | null;
        chain: AdminAuditChain | null;
      }>(admin + "/audit" + queryString({ ...query }));
      return { items: r.events, nextCursor: r.next_cursor, chain: r.chain };
    },
  };
}

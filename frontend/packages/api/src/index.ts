export * from "./contracts";
export * from "./client";
import { ApiClient } from "./client";
import {
  filterQuery,
  InputError,
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

# Phase 2.2A — Document processing lifecycle foundation

## Scope and SRS alignment

Read the actual `AI_Health_Wallet_Final_SRS_v3.docx`, especially §14.1–14.3 and V-06. This subphase supplies infrastructure for ownership-preserving retries and observable processing/completed/failed states. It does not satisfy OCR/extraction acceptance V-05, the real extraction part of V-06, or later AI requirements. No OCR, clinical PDF text extraction, embeddings, summaries, RAG, notifications, sharing, frontend or AWS deployment is implemented.

The original schema had a coarse `medical_documents.processing_status`, but no work claim, lease, retry schedule, attempt limit or attempt timestamps. An additive migration is necessary. Actual existing originals and patient rows were snapshotted by hash before changes; one patient and one document existed. Tests isolate all discovery/claims/recovery to freshly generated synthetic patient IDs and never access the existing original or S3.

## Migration and schema

`backend/migrations/0002_document_processing_lifecycle.sql` was applied through the existing migration runner using `health_wallet_migrator` on the dedicated local database. `0001_initial_schema.sql` is unchanged. The migration adds only operational lifecycle metadata:

- `document_processing_jobs`: one row per document, composite `(document_id, patient_id)` FK to `medical_documents`; immutable ownership; state; attempt count and maximum; due time; creation/update, latest attempt start/finish timestamps; random claim token; lease expiry and hard attempt deadline; allowlisted technical failure code.
- States: `pending`, `running`, `retry_wait`, `completed`, `failed`. SQL checks bound attempts to 0–5, enforce coherent lease fields and basic state shape, and prevent changing job identity/ownership.
- Ready, expired-lease and ownership indexes support queue queries and composite FK coverage. No external queue, sequence or extension is required.
- An AFTER INSERT trigger queues a document in the same PostgreSQL transaction when its public status is `processing`. If enqueue fails, the document INSERT rolls back; Phase 2.1's S3 compensation remains applicable. Existing processing documents are backfilled as pending without changing their metadata, status or original. Already completed/failed legacy documents are not automatically rerun.
- Functions are SECURITY INVOKER with fixed search paths, no PUBLIC execution, explicit app execution grants. The runtime receives CRUD on the new table, matching the existing policy, with no ownership, DDL, TRUNCATE, role, grant-option or migration-ledger privileges. No credential changes or elevated runtime pool are introduced.

The new operational job FK uses ON DELETE CASCADE solely to remove the associated job if its parent is legitimately deleted, including synthetic test cleanup. No original/clinical table FK was changed; no deletion endpoint or S3 delete is added by this phase. Existing restrictive relationships still protect clinical information. This table records the latest attempt plus a cumulative count, not a full per-attempt forensic history. Such history/retention is a future decision.

The security regression previously asserted exactly 13 CRUD application tables. Its count is now 14, with an explicit presence check for `document_processing_jobs`; every original permission assertion and all 15 security tests remain. The historical Phase 1.4A `db:provision` script intentionally accepts only its original object/ledger manifest and will reject a post-0002 schema. Do not rerun it as a migration shortcut or weaken its checks: roles are already provisioned, and 0002 grants its own permissions. Generalized bootstrap/reprovision support requires a separately reviewed update; no secrets or infrastructure scripts were changed here.

## Architecture and integration

| Module under `backend/src/processing/` | Responsibility |
| --- | --- |
| `config.ts` | Bounded configuration and interval consistency checks |
| `repository.ts` | Discovery, atomic claim, heartbeat, completion, failure and expired-lease recovery SQL |
| `service.ts` | Input validation and generic database error boundary |
| `errors.ts` | Safe typed operational errors and allowlisted failure codes |
| `worker.ts` | One-job orchestration, heartbeat, cancellation and deadline handling |
| `processing.test.ts` | Synthetic PostgreSQL integration and worker tests |

No processing API endpoint is added. Existing upload/list/detail/PATCH/download response shapes remain unchanged and continue exposing only coarse document status. Patients cannot set lifecycle state, counters, tokens, timestamps or storage references through these routes. The queue uses internal patient/document IDs only; it contains no S3 key, bucket, signed URL, medical content or patient profile fields. Internal service/job values are trusted-worker data and must not be serialized into public responses or logs.

No worker starts with the server. The exported worker requires an explicitly supplied future processor; `runOnce()` with no processor returns `disabled` before discovery, recovery or claim. Therefore current originals remain pending rather than being falsely failed or completed due to missing OCR. There is no new polling daemon, cron, CLI, managed service or dependency. Example of the future integration shape (the processor is deliberately not supplied):

```ts
import { pool } from "../database/pool.js";
import { getProcessingConfig } from "./config.js";
import { createProcessingRepository } from "./repository.js";
import { createProcessingService } from "./service.js";
import { createProcessingWorker } from "./worker.js";

const config = getProcessingConfig();
const service = createProcessingService(createProcessingRepository(pool, config));
const worker = createProcessingWorker(service, config);
await worker.runOnce(); // "disabled": no genuine processor has been implemented
```

The repository optionally accepts an internal patient scope for isolated orchestration/tests. Production trusted workers can discover globally; this is not an end-user authorization mechanism and is never populated from request input. Each mutation still requires the document ID, matching patient ID and current random lease token.

## Claims, transitions and recovery

1. Discovery reads due pending/retry jobs with deterministic due/creation/UUID ordering and a bounded limit. It is informational; it does not reserve work.
2. Claim selects one due row with `FOR UPDATE OF j SKIP LOCKED`, increments its attempt count, assigns a fresh UUID token, and records DB-clock lease/start/deadline timestamps. A data-modifying CTE sets public document status to `processing` in the same atomic statement. The statement commits before the processor is called; no DB transaction stays open during processor execution. Competing instances skip locked rows instead of duplicating claims. See [PostgreSQL row locking](https://www.postgresql.org/docs/16/sql-select.html) and [data-modifying CTEs](https://www.postgresql.org/docs/16/queries-with.html).
3. Heartbeats update only a running job whose document/owner/token match and whose lease and attempt deadline are still live. Renewal never exceeds the hard deadline. Old or expired tokens cannot complete, fail or renew a reclaimed job. A worker instance also rejects overlapping `runOnce()` calls with `busy`.
4. Completion requires an existing matching `extracted_medical_text` row with nonempty text, `completed` state and an update timestamp at or after the current claim's start. No extraction or empty placeholder row is created by the lifecycle. Completion atomically marks both job and document completed. Returning successfully from a no-op processor is insufficient; it causes a nonretryable generic failure. Completed/terminal failed jobs are never automatically reclaimed.
5. A retryable failure clears the lease and sets `retry_wait` if attempts remain, otherwise terminal `failed`. A nonretryable failure is immediately terminal. The public document becomes `failed` in either case and the original remains available. A due retry returns public state to `processing` on its next claim. No retry resets counters, changes ownership or reuploads/deletes the original.
6. Retry delay is `min(retryMaxMs, retryBaseMs * 2^(attempt_count - 1))`. Limits are fixed on the first claim; subsequent attempts keep their persisted maximum. Migration/trigger default is three, bounded by SQL to 1–5; first claim applies the configured maximum. Exhaustion and nonretryable failure require a separately authorized future operator policy; there is no public reset/retry API.
7. Recovery selects at most the configured batch of expired running leases using SKIP LOCKED. It records `LEASE_EXPIRED`, clears the old token, and schedules a retry or terminal failure using the same attempt budget. Claim already counted the interrupted attempt; recovery does not double-count it. Concurrent recovery calls cannot recover the same lease twice. Live jobs are untouched.

Worker results: `disabled`, `idle`, `busy`, `completed`, `failed`, `lost` or `unavailable`. `failed` means an attempt failed and may still be retryable; inspect internal job state for exhaustion. `lost` means the worker no longer has a valid lease or completion/failure could not be applied; it does not authorize an unconditional update. A heartbeat database failure cancels processing and leaves the persisted lease to expire. Raw processor/DB errors are never logged or persisted. Failure codes are `PROCESSOR_FAILED`, `PROCESSOR_TIMEOUT`, `INTERRUPTED`, `INVALID_INPUT` and recovery-only `LEASE_EXPIRED`.

The worker has a hard attempt timeout, stops heartbeats after cancellation and reserves up to one second (also bounded by lease/attempt fractions) before the persisted deadline to finalize a timeout failure with a still-live token. The DB guard always wins: late finalization returns false and recovery handles expiry. Database calls retain the existing bounded pool timeouts. No unbounded in-request retry loop exists.

## Configuration

Examples were appended to `backend/.env.example`; actual runtime/migration/infrastructure secret files remain unchanged. Uses the existing runtime environment loader and restricted pool. Configuration is validated when constructing lifecycle integration; the unchanged API does not start or configure an active processor.

| Variable | Default | Allowed |
| --- | --- | --- |
| `PROCESSING_MAX_ATTEMPTS` | 3 | 1–5 |
| `PROCESSING_LEASE_MS` | 60000 | 1000–300000 |
| `PROCESSING_ATTEMPT_TIMEOUT_MS` | 300000 | 1000–900000, at least lease |
| `PROCESSING_HEARTBEAT_MS` | 15000 | 100–60000; twice heartbeat must be less than lease |
| `PROCESSING_RETRY_BASE_MS` | 30000 | 1000–300000 |
| `PROCESSING_RETRY_MAX_MS` | 300000 | 1000–3600000, at least base |
| `PROCESSING_RECOVERY_BATCH_SIZE` | 50 | 1–100 |

These are bounded foundation defaults, not approved production performance/SLA values. All instances need consistent policy and operational clock synchronization. Queue ordering is deterministic for a stable set, but SKIP LOCKED and concurrent insertion/recovery do not guarantee global strict FIFO fairness.

## Security and remaining integration decisions

- No medical original is fetched, transformed, replaced or deleted by this module. S3 settings, IAM, storage code and credentials are unchanged. No live AWS call or real-patient processing was performed.
- Shared restricted runtime credentials are a trusted service boundary, not per-patient database RLS. A process with those credentials already has table CRUD; patients have only the authenticated API. Do not expose worker methods, claim tokens or raw job rows as public endpoints. A separate worker role can be evaluated later without granting elevated privileges here.
- This provides single active lease ownership, not exactly-once external execution. A paused or noncooperative handler may continue after lease expiry. The worker abort signal is cooperative cancellation, not an OS process kill. Future OCR/AI integrations must respect cancellation, fence artifact writes against the current live owner/token in a short transaction, and use idempotent external effects. The handler receives only immutable identity/token, attempt number and abort signal; no extraction implementation is provided.
- Completion checks persisted output and freshness but does not prove clinical accuracy, processor provenance or cryptographically bind output to a lease. A stale processor could write after reclamation unless future artifact persistence is fenced. Genuine extraction with atomic lease-bound output persistence is required before enabling a processor. No AI summaries/chunks are written by this subphase, and the existing coarse completed state will need a deliberate mapping if later workflows span multiple stages.
- Network acknowledgement loss can leave a claim committed without a caller receipt; no duplicate claim is issued while the lease is live. A later recovery handles it. A completion acknowledgement loss can leave the job completed even if the caller sees an unavailable/lost result; reread authoritative state rather than undoing it. Unknown outcomes never trigger deletion of originals.
- There is no polling loop or automatic recovery while no processor is configured. Before activation, decide scheduling, parallelism/backpressure, metrics without sensitive labels, shutdown/drain behavior, full attempt history, operator retry/reset authorization, legacy failed-record onboarding, retention and production timeout/retry budgets. Do not reset exhausted jobs by bypassing guards.

## Verification

Tests use synthetic fixtures only and the restricted `health_wallet_app` role. Each lifecycle test scopes queue operations to its own new patient; cleanup deletes only IDs created by that suite, never S3 objects or preexisting records. Existing database suites run sequentially. A claim blocked while synchronizing document state is cancelled by a test-local statement deadline to verify the entire claim rolls back. A lost-acknowledgement wrapper verifies committed leases remain recoverable. Worker timeouts use supported lease durations; an initial timeout boundary issue was corrected with a finalization reserve before the passing run.

Final command outcomes are recorded below after verification. No real OCR or successful real AWS integration is claimed.

| Command | Outcome |
| --- | --- |
| `npm run processing:test` | 35 passed, 0 failed/skipped |
| `npm run documents:test` | 44 passed, 0 failed/skipped |
| `npm run auth:test` | 29 passed, 0 failed/skipped |
| `npm run db:test` | 19 passed, 0 failed/skipped |
| `npm run db:security:test` | 15 passed, 0 failed/skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Compiled worker smoke check | Passed; absent processor returns disabled without accessing the DB |

An earlier document regression run hit a PDF-validation request timeout and dependent upload assertions failed. An isolated rerun passed all 44 tests with the original document code, tests and limits unchanged; no cause beyond the observed timing behavior is claimed. Keep resource-sensitive suites isolated on this development environment.

Final result: **142 tests passed, zero failed or skipped in the final suite runs** (35 lifecycle plus all 107 existing tests). The preservation audit confirmed the original patient and document row hashes are unchanged, counts remain one/one, all existing relation identities are retained, and exactly one backfilled job remains pending with zero attempts. All synthetic rows were removed. Only the three planned existing files changed; initial migration, document/auth/API/storage code, lockfile/dependencies, secrets and infrastructure match their baseline hashes. A tracked/nonignored source scan found none of the configured database passwords or JWT secret. Runtime role flags remain restricted.

Files created: this document; migration 0002; processing config/errors/repository/service/worker and focused tests. Existing files changed: `backend/package.json` (test script only), `backend/.env.example` (nonsecret examples), and `backend/src/database/security.test.ts` (table count/presence only). No dependencies were added. No commit or push was made. Work stops at Phase 2.2A.

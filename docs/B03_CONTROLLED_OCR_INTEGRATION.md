# B03 — Controlled OCR integration and extraction API v1

Date: 2026-10-23 (Asia/Karachi). Authority remains SRS v3.0; B01/B02 contracts
remain applicable. This stage implements offline/isolated behavior, not production
activation. No migration, dependency, OCR-engine rewrite or systemd operation is added.

## Exact roadmap scope and source obligations

B03: FR-004/010–012; NFR-01/06/07/08; DEC-07/08; CFG-08; all associated ledger
clauses/acceptance entries. Dependencies: B02 and operational identity/deployment
approvals. Its full DoD requires the actual application worker, scoped inputs,
retry/recovery/resource/shutdown evidence and separately approved activation/rollback.
A Python synthetic supervision probe alone cannot satisfy that DoD.

- TRK-14.1-02: authentication, owner checks on status/retry and original access.
- TRK-14.2-01/02: validated upload queues exactly one owner/document job.
- TRK-14.2-03: observable extraction states, preserved originals and owner-bound retry.
- TRK-14.3-01: native PDF text vs scanned/image OCR; source and ordered page provenance.
- TRK-14.3-04: failed extraction is visible and retry is actionable within safe bounds.
- TRK-8.1-01: Node/Python allocation conflict remains a formal amendment gate.
- UC-02, AT-02/03/04, V-02–06; supporting synthetic-data/operational obligations remain
  mapped to B18/B19/B20/B21 where complete client/deployment acceptance is required.

The SRS requires Python OCR allocation in its architecture text. Retention of the
working Node implementation is an approved development direction, **not a formal
amendment**. No SRS requirement or clinical/privacy role is silently changed here.

## Existing flow reused

Authenticated upload → bounded format/integrity validation → conditional private
S3 original + owner metadata → existing database enqueue trigger → separately
started canary scheduler → scoped PostgreSQL SKIP LOCKED claim → attempt lease and
heartbeat → secure bounded original reader → PDF.js/Poppler/Tesseract → existing
validated extraction → atomic lease-fenced persistence/document-job completion.

All pieces already existed. The API never starts or imports the scheduler runtime
or OCR processor. There is no new processing implementation or unscoped worker.
The meaningful missing integration was patient-visible processing status/retry and
a single test connecting authenticated uploads to the actual automatic service.

Preserved: originals, source hashes, ordered per-page methods/confidence, immutable
owner references, attempt tokens/deadlines, retry scheduling, expired-lease recovery,
coordinator lock, private health/aggregate logs, SIGTERM drain/cancellation and native
process limits. Cancellation observed during recovery now returns before another
claim, closing an unnecessary admission after cancellation.

## Patient extraction contract

| Method/path | Input | Behavior |
| --- | --- | --- |
| GET `/api/v1/documents/:id/processing` | Patient Bearer JWT; no query/body | Own extraction-stage public status, failure category, retry availability |
| POST `/api/v1/documents/:id/processing-retries` | Patient Bearer JWT; empty JSON `{}` only | Separately authorized scoped retry; never runs OCR inline |

Responses have Cache-Control no-store and the existing success/error envelope.
Foreign, unknown and malformed document references produce the same DOCUMENT_NOT_FOUND
404 after authentication. No patient selector, source text, model/prompt, reset,
max-attempts override or client-selected cutoff is accepted.

Public processing fields: document_id, `stage: "extraction"`, status, failure_code,
retry_allowed. Status is queued / processing / retrying / completed / failed /
unavailable. Failure categories are extraction_failed / timeout / interrupted /
invalid_document, or null. No patient ID, lease/worker details, object references,
raw extraction, credentials or driver diagnostics are returned.

`completed` requires current-attempt, non-null-token, validated persisted evidence,
not merely a legacy completed row. Legacy/unassociated completion is unavailable,
not a grounded success. Extraction completion is **not** summary/index/email/full
pipeline completion. B06/B09/B15/B17 own those later stage dependencies.

### Retry policy and SQL

Retry is **disabled by default**. A server composition may explicitly pass
`processingApi.retryApproval` with an existing version-1 canary file's absolute path,
independently pinned SHA-256, patient and fixed upload cutoff. No environment or
request can silently select a broader scope. Existing file ownership/mode/ancestor,
content/hash/target checks are reused on every request; malformed/missing/changed
approval gives 503 PROCESSING_RETRY_UNAVAILABLE and no retry write.

The v1 API approval is not the v2 system-credential envelope or an application-system
supervision receipt. No format downgrade or synthetic-probe substitution is accepted.
Supplying API retry approval does not enable or launch background processing.

A retry candidate must be the authenticated owner's document, match the approved
patient, satisfy the fixed cutoff **inside SQL**, have failed job/document state,
positive attempts below the existing maximum and an allowed failure code. A short
CTE locks both job and document, changes only the existing job to retry_wait with
database-clock scheduling, preserves the failure timestamp required by schema,
and atomically returns document state to processing. It never resets attempts,
changes the original, deletes evidence, creates a second job or recovers a running
lease. Failed-state/cutoff/owner predicates are rechecked under lock.

Concurrent/repeated queued, running or retrying requests return 202 with the same
job; verified completion returns 200. Retry is denied with 409 for exhausted,
invalid-input, unassociated/legacy or historical jobs. This is a bounded patient
retry, not an operator reset/reprocess API. Invalid or empty extraction never means
normal medical findings. The original remains available via B02 authenticated bytes.

POST is limited per authenticated patient (default 5/minute, configurable 1–20);
status reads default to 120/minute (1–1000). Invalid inputs are 400/415; missing JWT
401; foreign/unknown 404; unavailable approval 503; rate limit 429. Final production
quotas remain part of CFG-03/B19 review. No new password/delete/sharing feature exists.

## Isolated application verification design

Reuse `integration:summary-db -- --execute-isolated`, PostgreSQL16, restricted
synthetic app/migration credentials, network-none/shared-private namespace, zero
published ports, bounded unprivileged test process and exact test-owned cleanup.
No existing development database is queried and no AWS request is made.

New B03 fixture: two newly registered **disposable synthetic** patients; eleven
successful synthetic uploads to an in-memory SDK transport. Existing real S3
adapter/privacy/checksum/version reader is exercised against that fake transport.
The upload API and normal enqueue trigger are used, not a second upload pipeline.

A database-clock cutoff is proposed once after two owner sentinels, then hash-pinned
in the private approval file. The owner has a historical pending sentinel and a
historical failed sentinel; a second patient supplies an unrelated pending control.
One post-cutoff job is exhausted under a one-attempt test policy; one interrupted
job is retried concurrently and completes on its second attempt.

The actual standalone service composition (not manual runOnce) is then explicitly
started **only within the isolated test process**, concurrency one. Newly uploaded
digital PDF, PNG, JPG, JPEG and mixed PDF are processed automatically with real
PDF.js/Poppler/Tesseract. A blank PNG fails as invalid input without accepted text,
retains its original and cannot trigger an unlimited retry.

Assertions: patient/document/attempt linkage, source SHA-256, ordered page methods,
atomic job/document/evidence completion, unchanged fake originals, one job per upload,
historical/foreign/exhausted exclusion, unchanged unrelated database jobs, idle
idempotency and restart with the same cutoff/hash. Shutdown drains/cancels through
existing logic; owned private processing files and native children are checked gone.
Existing suites retain malformed/oversized inputs, native cancellation, stale-token
fencing, heartbeat/expiry, recovery, retry exhaustion and coordinator-loss tests.

Commands, only in appropriate test environments:

```bash
cd backend
npm run contracts:b03:test
npm run integration:summary-db -- --execute-isolated
```

The second command creates/removes only disposable test resources. Do not run its
DB-check script directly using a development `.env`. It requires the owned namespace
marker and database identity. Test success does not enable a daemon or alter defaults.

## Controlled operator lifecycle and unresolved deployment gate

The actual production background entry remains disabled by default. Before any
separately approved application canary, an accountable Operations approver must:

1. Approve service/deployment identity and immutable release/native dependency graph;
   independently pin artifacts rather than learning hashes from deployed contents.
2. Approve file-mode manifest/pin delivery and minimum PostgreSQL/AWS credential
   injection; no developer-home/default credentials or environment fallback.
3. Resolve networking: Gate 1A's system-unit definition is deliberately
   PrivateNetwork=yes with an empty address-family allowlist. It cannot reach the
   development PostgreSQL TCP endpoint or S3. No property is relaxed here. A reviewed
   enforceable PG/S3 connectivity design is required before system composition.
4. Supply a trusted system-manager OS transport, exact invocation ownership,
   BindsTo/After controller coupling and fresh **application** proof receipts.
   Existing adapters/file loaders remain intact; they are not claimed operationally
   wired merely because fake-port tests pass. Existing v1/v2 approval handling must
   retain run, deployment and cutoff binding when composed in that future gate.
5. Revalidate all seven read-only AWS checks with the approved profile/account/bucket;
   separately authorize synthetic seeding, fixed scope/cutoff and runtime activation.
6. Supervise a single instance/concurrency one with existing CPU/memory/task/runtime
   bounds, SIGTERM/drain deadlines, child containment and exact owned-unit cleanup.
   API success or Python probe receipts cannot replace actual worker loss/expiry proof.

On failure: stop admissions, cancel/drain through the existing service, retain bounded
lease recovery for that same approved scope, preserve originals/good evidence and
private receipts. No broad reset, historical backfill, evidence deletion, automatic
upload retry or Gate 3 cleanup. Rollback is to disabled processing and disabled retry
configuration; accepted originals and completed extractions are retained.

B03 does not introduce an executable production system-manager launcher or relax
its network isolation without these decisions/approvals. That remains a real gap,
not an assertion of finished deployment. No service is installed/started on the host.

## Definition of Done and next stage

Permitted offline/backend integration is implemented and measured in the dated
status and `baselines/B03_VALIDATION_RECEIPT.json`. Full B03 **operational** DoD remains
open: real system-manager composition, independently pinned deployed dependency graph,
credential/network design and actual application-level containment/controller-loss/
runtime-expiry acceptance still require their approvals and execution evidence.
Formal Node OCR allocation amendment and clinical/privacy/operations appointments
remain pending. No unverified production/clinical claim is made.

B04's offline synthetic fact-catalogue work can be separately approved using verified
extraction contracts while these operational/release gates remain explicit. B04 is
not begun by this stage.

## Executed verification and limitations

- New B03 fake/API/cancellation checks: **19 passed**. New isolated upload/automatic
  processing/retry integration: **8 passed**. These are included in the broad run.
- Existing offline regressions: **876 passed** (341 Python, 510 TypeScript, 25 baseline
  tooling), with contract compatibility/typecheck/build/disabled-entry checks.
- Broad disposable run: **680 non-summary checks passed**, including all 270 backend
  tests, B02/B03 checks, runner safety, Stage A/B/C and real OCR integration.
- The existing 73-test summary suite initially recorded **71 passes and two failures**
  (one short-lease heartbeat subtest plus its parent). It observed lease-lost instead
  of completed with a 300 ms lease. Root cause beyond that observation is unproven.
- A fresh isolated rerun of the **unchanged** summary suite passed **73/73**, including
  that heartbeat case, followed by typecheck/build and both disabled entries. Only
  command selection in a temporary harness copy changed; tests, limits and production
  code were not relaxed. No claim is made that the original broad run was all-green.
- Both disposable environments were independently verified removed (containers,
  volumes and owned test images). The exact dependency-cache tag was also removed.
  All five pre-existing containers remain present with start/stop transitions before
  the runs. Private failure and success receipts are retained. Suite counts overlap.

The cached OCI image used by the test harness has its actual image ID recorded. An
old receipt ID and image creation timestamps were not valid proof of unchanged/new
image identity; they are not counted as deployment validation. The harness's own
dependency/label/isolation gates passed. A lost setup session produced no test
pass receipt. Neither setup reconciliation nor this test image substitutes for the
independently pinned production artifact graph required above.

The short-lease regression remains a timing/reproducibility risk to investigate
under controlled load before release. New OCR integration itself passed, but neither
that fact nor the successful rerun resolves application-system containment, live AWS,
clinical, privacy or production readiness. B04 also requires review/approval of its
clinical-information policy before implementation; no such approval is invented here.

# Phase 2.2D — Controlled live S3-to-OCR verification, Gate 1

Gate 1 implements the manual runner and its safety tests. It authorizes read-only AWS preflight only. **Gate 2 is not approved or executed.** No real registration, upload, object creation, processing, database connection/mutation or cleanup was performed during Gate 1. No automatic worker, migration, IAM/bucket/profile/credential change, AI summary, RAG, sharing or frontend work is included.

Reviewed the SRS v3.0 ownership, private-original, extraction/provenance and failure-preservation requirements (§14.1–14.3), authentication/document/processing phase documentation, migrations 0001–0003, production source and synthetic fixtures. Existing processing code and its patient scope remain authoritative. The PostgreSQL best-practices skill informed parameterization, least privilege and short verification snapshots; no Supabase service is used.

## Files and dependencies

Created:

- `backend/src/integration/cli.ts`: guarded manual entry point; preflight returns before dynamically importing live application code.
- `backend/src/integration/aws-preflight.ts`: pinned named-profile loading, read-only AWS CLI allowlist, bounded execution, profile stability and sanitized failures.
- `backend/src/integration/guards.ts`: exact target/flag/environment checks, successful-preflight capability, run registry, runner-only storage guards and preservation comparisons.
- `backend/src/integration/scoped-worker.ts`: constructs existing repository/service/retrieval/worker with a mandatory registered scenario patient scope.
- `backend/src/integration/workflow.ts`: sequential, injectable scenario workflow with fail-stop and resource finalization.
- `backend/src/integration/live-run.ts`: separately gated future HTTP upload → real S3 → secure retrieval → extraction → atomic persistence composition.
- `backend/src/integration-checks/live-s3-ocr.check.ts`: fake AWS/database tests, outside all existing automated test globs.
- This document.

Modified only `backend/package.json`: adds `integration:s3-ocr` and `integration:s3-ocr:test`. No new npm dependencies or lockfile changes. The installed AWS CLI 2.36.27 supplies STS and S3 Control reads, so new SDK packages are unnecessary. Existing AWS SDK S3, Express, dotenv, pg, PDF.js, Sharp and OCR tools are reused.

## Approved target and supported profile

| Setting | Required value |
| --- | --- |
| Named AWS profile | `ai-health-wallet` |
| AWS account / expected bucket owner | `402909940531` |
| Bucket | `ai-health-wallet-records-402909940531` |
| Region | `ap-southeast-2` |
| Existing object prefix | `medical-documents/` |
| Encryption | `AES256` |
| Database | Local loopback, port `5433`, database `ai_health_wallet`, role `health_wallet_app` |

CLI flags and loaded runtime settings must agree with these constants. Missing, duplicate, conflicting, unknown or wrong-target flags are rejected before application imports. No default execution mode exists. Runtime configuration loads using the existing `.env` pattern; no migration secrets are loaded.

For this personal setup, only a static named AWS profile is supported. The runner reads the exact named sections in standard shared configuration/credential files, requires the configured region and private credential-file permissions, and rejects role/source-profile/process/SSO delegation or duplicate/unknown named-profile fields. It does not resolve or use the default profile. Ambient AWS credentials, alternate credential files, web/container providers, endpoint overrides and proxies are rejected. CLI subprocesses receive a minimal environment, explicit named profile/region/files, disabled metadata discovery and bounded time/output. Full shared-file hashes are checked before/after CLI calls to detect changes without revealing contents. The future S3 client receives only the explicitly loaded named-profile credentials, never the default credential chain.

Credentials remain in memory and are not returned in reports/manifests. Profile parsing intentionally fails closed on unsupported configurations rather than trying another provider.

## Gate 1 commands

From `backend`, fake-only checks:

```sh
npm run integration:s3-ocr:test
npm run typecheck
npm run build
```

Approved read-only AWS preflight:

```sh
npm run integration:s3-ocr -- --preflight \
  --profile ai-health-wallet \
  --account 402909940531 \
  --bucket ai-health-wallet-records-402909940531 \
  --region ap-southeast-2
```

Preflight imports neither `app.ts` nor the database pool, runs no fixtures/OCR, writes no manifest and creates no API listener. Importing the CLI also has no execution side effects. Flags are checked before loading environment/application code. The source and compiled entry points both require direct invocation.

The AWS transport allowlist permits only STS `get-caller-identity`, exact-target S3 `get-bucket-location`, `get-public-access-block`, `get-bucket-policy-status`, `get-bucket-ownership-controls`, `get-bucket-encryption`, and account-scoped S3 Control `get-public-access-block`. Identity mismatch/root identity stops before bucket calls. Bucket calls include the expected owner. `NoSuchBucketPolicy` is accepted only as that exact AWS error code on the exact policy-status operation, matching production storage's supported absent-policy case; AccessDenied, malformed responses, unrelated errors and unavailable reads never imply success. CLI retry annotations do not affect error-code parsing.

No bucket enumeration, unrelated account/service access, signed URL, object access or write is part of preflight. A failed required check exits with code 2 and prevents live imports. Unexpected configuration/transport errors are sanitized.

## Read-only preflight outcome

Final Gate 1 result on 21 October 2026:

| Check | Outcome |
| --- | --- |
| Caller account and nonroot named-profile identity | Passed; account equals approved account |
| Actual bucket region | Passed: `ap-southeast-2` |
| Bucket Block Public Access | Passed: all four flags true |
| Bucket policy status | Passed: exact `NoSuchBucketPolicy` response, not an AccessDenied assumption |
| Expected bucket owner / ownership | Passed: expected-owner request succeeded, `BucketOwnerEnforced` |
| Bucket default encryption | Passed: `AES256` |
| Account Block Public Access | **Blocked: `AWS_ACCESS_DENIED`** |

The account-level settings remain unknown. Bucket-level blocking is not substituted for the account check. The initial CLI parser rejected a retry-annotated no-policy response; a focused regression test and corrected code extraction resolved that parsing issue. Final preflight remains failed solely because the account-level read is denied. Nothing was changed to remediate the denial.

Required read permissions for preflight: `s3:GetBucketLocation`, `s3:GetBucketPublicAccessBlock`, `s3:GetBucketPolicyStatus`, `s3:GetBucketOwnershipControls`, `s3:GetEncryptionConfiguration` on the approved bucket, and `s3:GetAccountPublicAccessBlock` for the approved account. STS GetCallerIdentity is used solely for identity verification. See [AWS S3 operation permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html), [account public-access permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html) and [STS identity documentation](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html).

**Blocker:** an authorized operator must resolve permission for the named profile to read account-level public-access settings, followed by a completely passing preflight. This phase does not change IAM permissions or settings and does not assume that granting a permission alone guarantees a pass.

## Gate 2 behavior — implemented, not executed

Live invocation requires both `--run` and `--approve-live-writes`, all exact-target flags, and an actual successful preflight in the same process. Forged/deserialized success reports do not carry the in-memory preflight capability. These flags are execution acknowledgements, not a substitute for the owner's separate Gate 2 approval. Do not invoke live mode under Gate 1 approval.

The runner starts a fresh loopback-only API instance using existing routes and guarded real storage. It registers/logs in three unique synthetic patients through HTTP, holds passwords/JWTs only in memory and uploads exactly one generated document per patient. All operations are sequential and stop at the first failure, without automatic upload/job resets or retries. Existing bounded SDK transport retries remain in place.

| Scenario | Generated fixture | Required output |
| --- | --- | --- |
| A | One-page digital PDF | Exact embedded phrases, `pdf_text`, one PDF-text page |
| B | One-page PNG printed report | Genuine English Tesseract phrases, `ocr`, one OCR page |
| C | Two-page PDF: embedded, then scanned | Both actual outputs in order, `mixed`, `pdf_text` then `ocr` |

Fixtures must be below 1 MiB. Existing upload/retrieval/PDF/OCR/lease limits are reused; OCR admission is narrowed to one. The actual processor is `createOcrProcessor()`. No normal startup or automated test invokes the live runner.

Registered patient IDs must not occur in the preservation baseline. A registry binds each fresh patient and returned document to its scenario. Unregistered, absent, copied, duplicate or foreign scope objects cannot construct a scenario worker. Before processing, the live adapter requires exactly one document/job for that patient, pending state, attempt zero and no extraction. The adapter always passes this patient ID to `createProcessingRepository`; both its claim and recovery SQL remain patient-scoped. Returned claims are checked again before processor invocation. No global repository/worker is constructed.

The S3 wrapper allows only the expected fixture MIME/size/checksum/hash for one authorized upload per scenario, using the existing random-UUID key convention and conditional production PUT. It journals the exact candidate key before calling production storage and confirms its receipt afterward. Internal retrieval permits only this run's confirmed keys. Runner download signing and removal are always blocked. Existing production compensation code is unchanged: its remove calls fail inside this wrapper without sending any AWS delete request. Failed or ambiguous PUTs remain in the manifest for reconciliation.

A mode-0700 run directory contains mode-0600 synthetic fixtures and an atomically replaced, flushed manifest. Manifest writes are serialized and the directory is synced after replacement. It records exact synthetic patient/document IDs, candidate keys, confirmation state, versions and hashes, without credentials, passwords, JWTs or claim tokens. Those identifiers/keys are never printed. Normal processing still removes its own temporary copies; retained originals/fixtures/evidence are not deleted.

Verification checks source SHA-256 at fixture creation, within authorized retrieval and in persisted provenance; methods, page counts/order, actual output phrases, OCR-only confidence, completed job/document/extraction states and captured attempt/token association. A second scoped `runOnce()` must be idle and leave evidence unchanged. Cross-patient metadata/download requests must return 404 before storage/signing. Authenticated HEAD confirms the exact object/version, type, length and AES256; a bounded unsigned request to only that new object must deny access. ETag is not treated as SHA-256. Runtime directories and this process's child list must be empty after processing.

Short read-only PostgreSQL snapshots compare preexisting application rows as multisets of row fingerprints, including composite-key bridge tables; only exact recorded new patient/document/job/extraction IDs are allowed. The restricted migration ledger is excluded from row reads; source migration preservation is checked separately. No restore or compensating write runs on a preservation mismatch. Use a quiet window; concurrent unrelated changes are a failure requiring investigation, not permission to revert them. Snapshot queries use existing pool timeouts and no transaction spans network/OCR work.

## Retention and separate cleanup gate

A successful Gate 2 would retain three synthetic patients, three documents, three jobs, three extractions and three private S3 originals, plus the manifest/fixtures. On failure, retain whatever was created and its receipts; do not rerun registration/uploads after ambiguous acknowledgements. The run ID and deterministic synthetic email convention support exact manual reconciliation if a registration commits without an acknowledged ID.

There is no cleanup command in this runner. `--cleanup` is rejected. Gate 3 requires separate explicit approval of manifest-bound resources. Proposed cleanup rechecks target identity/ownership, confirmed object receipts and unexpected references; removes exact recorded versions or conditionally deletes exact unversioned objects; verifies deletion; then removes exact synthetic DB records in a short transaction. A denied read is not proof of absence. Never sweep a bucket/prefix, reset unrelated jobs, delete by broad name matching or restore old data wholesale. Cleanup permissions and any cleanup implementation require separate review; deletion is intentionally unavailable in this runner.

Future Gate 2 needs existing `s3:PutObject`, `s3:GetObject`, and `s3:GetObjectVersion` if versioned, in addition to preflight reads. These object permissions were not exercised or proven by Gate 1. AES256 requires no new KMS integration. No delete permission is needed to execute this guarded verification mode.

## Tests, limits and verification status

The fake suite covers exact flags/targets/configuration, unsupported credential sources, default-profile refusal, read-command allowlisting, all required preflight failures and malformed responses, CLI no-policy classification, forged-success refusal, sequential scenario isolation, fail-stop/finalization, registered scope provenance, actual repository claim/recovery SQL parameters, foreign claim refusal, preservation multiset handling, fixture hash/journal/ambiguous-upload behavior, blocked deletion/signing/retrieval, production compensation containment and inert imports. It uses fake database/AWS ports and tiny local synthetic buffers; it runs no OCR and connects to no database.

Final checks: `integration:s3-ocr:test` **37 passed, zero failed/skipped**; strict typecheck and production build passed. The existing 269 tests and production modules are preserved. Existing database-backed suites were deliberately not rerun because Gate 1 prohibits their database writes; no claim of a fresh 306-test combined run is made.

Native OCR quality/isolation limitations remain as documented in Phase 2.2C-C. Live composition is implemented but unverified against actual uploads until Gate 2 approval and a passing preflight. Crashes, missing permissions, concurrent activity, connection loss or filesystem failure can leave retained resources requiring exact reconciliation. Shared DB credentials remain a trusted runtime boundary, not per-patient database RLS. Do not use real medical documents. No commit, push, deployment or later phase was performed.

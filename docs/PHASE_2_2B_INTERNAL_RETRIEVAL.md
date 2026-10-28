# Phase 2.2B — Secure internal original-document retrieval

## Scope

Read the actual SRS v3.0, especially §14.1–14.3 and V-02/V-05/V-06, and the existing Phase 2.2A design. This phase provides owner- and lease-checked internal access to private originals for a future processor. It does not implement OCR, clinical text extraction, extracted-output persistence, AI, summaries, embeddings, RAG, sharing, notifications, frontend, deployment or automatic background processing.

No migration or database permission change is necessary: the existing document/job ownership relationship, primary/composite indexes, lease token, running state, expiry and attempt deadline supply the required checks. Applied migrations 0001 and 0002 are unchanged. No new dependencies, AWS permissions, profile settings, IAM policy, bucket settings or secrets were added or modified.

## Architecture

1. `processing/repository.ts` adds `resolveOriginal(claim)`: a parameterized SELECT joins `document_processing_jobs` to `medical_documents` on both document and patient IDs. PostgreSQL checks document ID, patient ID, current lease token, running state, live lease, live attempt deadline, optional internal patient scope, and public document `processing` state. It selects only the private reference and supported file type. It does not acquire a transaction for the download.
2. `processing/service.ts` validates UUID-shaped claim input and wraps database errors. Missing, mismatched, expired and replaced claims receive a generic internal `InvalidProcessingClaim`; malformed input receives `InvalidProcessingInput`. No endpoint exposes this method or reference.
3. `processing/retrieval.ts` supplies scoped `withOriginal(claim, signal, consumer)`. It resolves the reference from PostgreSQL, validates the exact configured bucket/prefix and UUID-v4 extension path, streams the original into private temporary storage, reuses bounded integrity validation, rechecks the same live claim/reference, and invokes the consumer with only `{path, type, bytes, assertActive}`.
4. `documents/original-reader.ts` supplies the internal `readOriginal` capability through `createS3Storage`. The existing adapter passes its SDK client and existing privacy verifier into this capability. The original `DocumentStorage` upload/download contract remains compatible with old fakes; `createS3Storage` additionally returns `OriginalStorage`. Public signed downloads remain separate and unchanged.
5. `documents/storage-safety.ts` holds the existing shared `StorageFailure` and exact-reference validator. `storage.ts` reexports them for compatibility. This avoids a circular dependency and preserves the existing upload, cleanup and signed-download checks.
6. `documents/integrity.ts` now accepts only the `path` and `type` fields it actually needs. The existing PDF/JPEG/PNG worker, limits and content checks are unchanged; no text extraction API is called.

The file consumer receives no bucket, object key, original filename, URL, credential or patient profile. Internal repository values and claim tokens remain trusted-worker data and must never be serialized into API responses or logs. Public APIs and response shapes are unchanged. No public processing/original-file route was added.

## Existing worker integration

The existing `DocumentProcessor` callback now receives `withOriginal(consumer)`. `createProcessingWorker` optionally accepts an `OriginalAccess` helper as its fourth argument. The worker binds the helper to its current immutable claim and cancellation signal, tracks outstanding retrieval scopes, and awaits cleanup during shutdown/cancellation. A missing helper fails generically when requested. A missing processor still returns `disabled` before any claim, retrieval or AWS operation.

Future composition, without starting a processor:

```ts
import { pool } from "../database/pool.js";
import { getDocumentConfig } from "../config/documents.js";
import { createS3Storage } from "../documents/storage.js";
import { getProcessingConfig, getRetrievalConfig } from "./config.js";
import { createProcessingRepository } from "./repository.js";
import { createProcessingService } from "./service.js";
import { createOriginalAccess } from "./retrieval.js";
import { createProcessingWorker } from "./worker.js";

const documents = getDocumentConfig();
const config = getProcessingConfig();
const service = createProcessingService(createProcessingRepository(pool, config));
const storage = documents.storage ? createS3Storage(documents.storage) : null;
const originals = createOriginalAccess(service, storage, documents, getRetrievalConfig());
const worker = createProcessingWorker(service, config, undefined, originals);
await worker.runOnce(); // disabled; no OCR or real processor exists here
```

Once a genuine processor is separately implemented, it can consume input with `await withOriginal(async input => { /* use input.path only within this scope */ })`. Merely reading the input does not count as extraction or completion. The existing completion SQL still requires genuine matching completed extraction evidence and a current live token. No output rows are created by retrieval.

## S3 controls and streaming

- Reuses the configured named profile through the existing SDK v3 default credential chain (`AWS_PROFILE`), region, bucket, expected owner, prefix and SSE configuration. The current environment selects a profile and enables storage; these values were inspected without printing secrets and were left unchanged. No alternate bucket/key comes from a callback or public request. See [AWS credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).
- Before every internal read, applies the same four Block Public Access flags, nonpublic bucket-policy status, `BucketOwnerEnforced` ownership and matching default SSE-S3/SSE-KMS checks used by the existing storage adapter. No privacy check was weakened. Account-level controls remain the approved setup's operator responsibility, as documented in Phase 2.1.
- HEAD rejects empty, invalid or oversized lengths, incorrect canonical MIME and mismatched object encryption/KMS key. GET is pinned to the returned version ID where available and uses `If-Match` for the ETag where available. An unversioned object requires an ETag. Returned size, MIME, encryption, version and ETag must agree with HEAD. There is no silent fallback to an unguarded GET if version access is denied.
- Reads use direct SDK `GetObject`, never presigned URLs or HTTP fetching of a caller-provided URL. Every object operation supplies the expected bucket owner. Reads permit only exact configured-prefix random UUID-v4 PDF/JPG/JPEG/PNG keys whose extension agrees with the DB file type.
- The Node response body flows through a backpressured counting transform into a newly created 0600 file. It never buffers an unbounded original in the request process. Actual bytes may not exceed the configured maximum or HEAD length, and the final count must match. A returned full-object SHA-256 is verified when present; composite checksums are not misinterpreted as whole-file hashes. There is no claim of a stored cryptographic checksum when S3 does not supply one.
- Existing structural validation fully decodes bounded image content or validates PDF structure/operator lists in the existing worker. A successful transport or valid header alone is insufficient. This is the existing validation policy, not OCR or a malware-free guarantee.
- A total acquisition timer covers claim resolution, SDK/privacy calls, streaming and integrity validation. SDK HTTP timeouts/retry caps remain in place. AbortSignal reaches SDK and pipeline, and command waiting is also bounded if a transport returns late. A GET body arriving after timeout is destroyed. Streams are closed on failure/cancellation; no object is replaced or deleted. See [S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) and [Node pipeline cancellation](https://nodejs.org/docs/latest-v24.x/api/stream.html#streampipelinesource-transforms-destination-options).

The read path uses only the already documented bucket-control reads, HEAD/`s3:GetObject`, `s3:GetObjectVersion` when versioned, and applicable existing KMS permissions. It requests no new AWS action or ChecksumMode permission. No live IAM inspection, AWS call or permission change was performed. Live profile authorization and retrieval remain **unverified by this phase**. If an actual AccessDenied later demonstrates a missing permission, stop and report it; do not widen policies or bypass checks.

## Lease loss and cancellation

Claim validation uses the database clock, not a caller's cached job state. The retrieval scope rechecks its claim and unchanged reference periodically, before consumer handoff, and through the consumer's `assertActive()` convenience method. Lease/token/reference loss or DB-check failure aborts the stream and prevents handoff. The existing worker heartbeat and attempt deadline continue to run, and existing completion/failure updates remain fenced by the live token.

There is deliberately no database transaction spanning network I/O. Consequently validation is not a lock on ownership for the entire download: bytes may arrive before a concurrent lease change is observed. They remain private and are discarded, and a final database check is mandatory before the consumer receives the path. Periodic cancellation detects changes after the configured interval plus bounded query latency. No check can revoke bytes already read by trusted code.

After successful acquisition the download timer is cleared; the existing worker's attempt timeout/cancellation and ongoing DB lease checks bound the consumer's use. A callback must await all input use and respect cancellation. The helper races consumer cancellation and removes its file even if a noncooperative callback keeps running. This is cooperative cancellation, not an OS process kill. `assertActive()` is a point-in-time check, not authorization to persist output later. Future extraction must fence output writes against the current live claim in the same short DB transaction; this phase writes no extraction output and adds no capability that bypasses the existing completion guard. Late stale output persistence remains a required design task before implementing OCR.

## Temporary input and resource limits

`mkdtemp` creates a random `health-wallet-processing-*` directory under the operating-system temporary directory; it is explicitly chmod 0700. The original is written as `original.bin` with exclusive creation and mode 0600. No original name, patient ID or object key appears in the local path. The scope removes its directory in `finally` after successful use, validation/storage failure, callback failure, lease loss or cancellation. Admission is released after cleanup, and worker cancellation awaits outstanding retrieval cleanup. Cleanup errors are generic and contain no local path.

Process crashes, power failure or OS-level removal failures cannot be guaranteed away by `finally`. Production needs approved private/encrypted ephemeral storage, disk quotas and safe age-based cleanup; no automatic sweeper was added. Parser native/external memory is governed by the existing pixel/page/file limits rather than solely the V8 heap cap.

The new settings use the existing runtime environment loader. Only placeholder/default examples were appended to `.env.example`; actual `.env`, AWS files and migration/infrastructure secrets were preserved.

| Setting | Default | Range |
| --- | --- | --- |
| `PROCESSING_MAX_DOWNLOAD_BYTES` | 5242880 (5 MiB) | 1024–20971520 |
| `PROCESSING_DOWNLOAD_TIMEOUT_MS` | 15000 | 1000–30000 |
| `PROCESSING_LEASE_CHECK_INTERVAL_MS` | 1000 | 100–5000 |
| `PROCESSING_MAX_CONCURRENT_RETRIEVALS` | 2 | 1–4 per shared helper instance |

Share one helper across the intended worker group for its admission limit. Multiple helpers/processes multiply that limit; distributed quotas and worker scheduling remain deployment decisions. Download limits are independent of upload limits; approved deployments allowing larger originals must configure both deliberately. Cancellation does not make an already-running DB query disappear: the existing pool's query/statement timeouts bound it, so cleanup/check latency can extend beyond the acquisition timer. These are development defaults, not an approved production SLA.

## Tests and preservation

New `processing/retrieval.test.ts` uses synthetic files and fresh patient IDs, mocked SDK command transport, and a presigner stub that must never be called. All internal claims/discovery/recovery use scoped synthetic patients. Existing uploaded records and private originals are never processed or retrieved. Cleanup removes only synthetic IDs. Assertions cover active/expired/replaced/mismatched claims; missing, foreign and unsafe references; all supported formats; private controls; SSE-KMS; version/ETag races; oversized headers, streamed overflow, truncation, checksums and corruption; interrupted/late/timed-out streams; external and worker cancellation; private mode/cleanup; bounded admission; and unchanged public API isolation.

| Command | Final result |
| --- | --- |
| `npm run processing:test` | 73 passed: 35 existing lifecycle + 38 new retrieval tests; 0 failed/skipped |
| `npm run documents:test` | 44 passed, 0 failed/skipped |
| `npm run auth:test` | 29 passed, 0 failed/skipped |
| `npm run db:test` | 19 passed, 0 failed/skipped |
| `npm run db:security:test` | 15 passed, 0 failed/skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Compiled production smoke check | Passed: mocked retrieval, emitted integrity worker, private cleanup and inactive processor |

All **180 tests passed**, including all previously passing 142 tests and 38 new retrieval tests. The final suites had zero failures or skips. No live AWS test or real medical-document retrieval was performed.

The final preservation audit confirmed that only the eight planned existing files changed. All previous test files, both migrations, dependencies/lockfile, actual secret files, AWS config/credential files, infrastructure and public-route files match their baseline hashes. Tracked/nonignored source contained none of the configured database, JWT or AWS credentials. Existing patient, document and lifecycle-job rows match their baseline hashes (one row in each table); all synthetic rows were removed. The exact public relation inventory is unchanged and the runtime remains restricted. The existing job was not processed, and no live original was accessed.

## File inventory

Created:

- `backend/src/documents/original-reader.ts`
- `backend/src/documents/storage-safety.ts`
- `backend/src/processing/retrieval.ts`
- `backend/src/processing/retrieval.test.ts`
- `docs/PHASE_2_2B_INTERNAL_RETRIEVAL.md`

Modified: `backend/src/documents/storage.ts`, `backend/src/documents/integrity.ts`, `backend/src/processing/{config,errors,repository,service,worker}.ts`, and `backend/.env.example`. No old test was changed. No package, lockfile, migration, permission, credential, AWS configuration, server startup or public-route file was modified. No commit or push was made. Work stops after Phase 2.2B.

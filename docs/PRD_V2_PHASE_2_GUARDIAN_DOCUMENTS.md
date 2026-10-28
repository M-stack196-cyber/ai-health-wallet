# PRD v2 Phase 2 — guardian lifecycle and document qualification

28 October 2026 · Asia/Karachi. Owner-review package against checkpoint `b88e9db` (`Complete M01 identity and security backend`). **M02: 10/10 requirements qualified at backend lifecycle scope. M03: 5 IMPLEMENTED, 5 PARTIAL, 2 NEEDS_REVERIFICATION; module acceptance remains open.** Final focused runs: **33/33 Phase 2 checks passed; 39 M01 checks passed, one checkpoint-specific restore case intentionally skipped.** Typecheck and build passed. No commit, push, development/production migration, real email, AWS request or later-phase implementation occurred.

## 1. Baseline and authorized scope

Only `AI_Health_Wallet_Revised_SRS_v4_0.docx` and `AI_Health_Wallet_Module_Wise_PRD_v2_0.docx` define current product requirements. Their SHA-256 values remain:

- SRS: `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55`.
- PRD: `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84`.

The PRD inventory still contains exactly 232 unique requirement IDs across 18 modules. The existing reconciliation and Phase 1/1B reports supplied context; historical SRS/PRD files did not override the authoritative documents. This phase inspected and reused the existing document implementation before changing it. Only guardian lifecycle, document gaps and necessary current-auth/privacy/governance contracts changed. Existing B01–B03.x evidence, the historical tracker and migrations 0001–0006 remain byte-for-byte unchanged from HEAD.

## 2. Guardian behavior and API

All paths below have `/api/v1` prefix. Management derives the patient exclusively from the current M01 session; query selectors and unknown body fields are rejected. Lifecycle transactions recheck current authorization under the patient lock. No guardian login or medical-delivery endpoint was added.

| API | Body / behavior |
| --- | --- |
| `GET /patients/me/guardian` | No body; returns NONE or latest PENDING/ACTIVE/REVOKED/EXPIRED relationship, email and invitation expiry; never returns a token/hash/private queue payload. Expiry is normalized and audited when status is resolved. |
| `POST /patients/me/guardian` | `{email}` nominates a guardian; `{}` can use the saved registration/profile `pending_guardian_email` intent. An existing pending/active primary gives 409. |
| `PUT /patients/me/guardian` | `{email}` replaces the existing relationship transactionally; the prior relationship becomes REVOKED and its invite becomes unusable. |
| `POST /patients/me/guardian/resend` | Empty JSON object; only an unexpired PENDING relationship is eligible. Cooldown/window limits apply; issuance consumes the old challenge. |
| `DELETE /patients/me/guardian` | No body; revokes relationship and invitation, clears saved intent; repeated removal is safe. |
| `POST /guardian-invitations/accept` | `{token}`; purpose-bound, expiring, one-use guardian acceptance. Generic invalid/expired response; no patient selector or medical information. This is a bearer invitation sent to the nominated mailbox, not a patient-session operation. GET does not accept invitations. |

Registration remains optional with respect to guardians. The existing registration field saves an intent while the patient is unverified. After successful patient email verification, the configured transactional security-mail adapter hands that intent to the guardian lifecycle and queues a **separate** guardian invitation. The relationship remains PENDING until the guardian accepts its own code. Merely entering either email verifies neither mailbox and grants no communication eligibility. If the optional guardian enqueue fails, patient verification still succeeds, the failed guardian transaction rolls back and the intent remains available for authenticated nomination. Custom legacy send-only identity test adapters retain their existing identity behavior; guardian issuance requires the Phase 1B transactional enqueue adapter.

The shared `patient_auth_challenges` and security-email queue now support `guardian_invitation`, without widening the identity consumer's two-purpose type. Challenges hold only purpose-separated SHA-256 hashes of random256-bit tokens. The existing queue temporarily holds authenticated AES-256-GCM ciphertext, deletes payloads after successful/terminal delivery and preserves bounded retry/idempotency behavior. Guardian email contains only invitation/acceptance text, expiry and the code. No medical report, summary, password or session secret is sent. API acceptance never returns patient medical content. Raw tokens/provider bodies are not logged.

All guardian changes lock patient first, then relationship/challenge; transaction rollback includes issuance, queue insertion and audit. A partial unique index enforces at most one pending/active primary per patient. Triggers reject relationship identity drift, terminal-state resurrection, invitation owner/purpose mismatch and activation lacking current accepted invitation evidence. Lifecycle events are append-only for the application role and contain IDs/event/time rather than emails or tokens. Concurrent additions admit one relationship; acceptance versus replacement/removal cannot preserve eligibility for the replaced/removed relationship.

`guardian_communication_eligibility` is the future send-boundary contract: it returns only current ACTIVE accepted/non-revoked relationships belonging to verified active patients. Pending/revoked/expired and historical `guardian_contacts` rows have no authority. Replacing/removing a relationship immediately removes its eligibility and consumes its invite; a not-yet-claimed queued invite is suppressed on drain. An already submitted invitation cannot be recalled, but its code cannot activate a revoked relationship. **No M10 medical sender exists or was qualified.** Future M10 must recheck the current relationship ID at the actual dispatch boundary, fence queued work against revocation and never authorize delivery using a cached email or legacy contact alone.

## 3. Existing document pipeline reused and gaps closed

Existing multipart parsing, bounded temporary files, filename normalization, MIME/extension/signature checks, PDF/image decoder workers, configurable size/page/pixel/admission bounds, private S3 adapter, conditional encrypted writes, uncertain-commit read-back/compensation, owner queries and bounded streaming remain in use. No second upload/storage system or new dependency was introduced.

New uploads persist content_type, size_bytes and SHA-256 alongside owner, filename/type, hospital, document date, server upload timestamp, category, private bucket/key and processing state. `size_bytes` is PostgreSQL BIGINT and is returned as a decimal string by the current driver. Original identity, owner, private storage reference, filename/type, uploaded timestamp and integrity tuple are immutable in SQL; patient-approved hospital/category/date patches remain possible. Required integrity metadata cannot be omitted for new inserts. Legacy rows keep NULL integrity rather than receiving a fabricated checksum. Legacy object qualification/backfill needs a separate controlled procedure; this phase does not claim that old unknown hashes were verified.

The API category codes remain `lab_report` (Lab Report), `prescription` (Prescription), and `other_medical_document` (Other). Hospital is patient entered and editable; date is patient supplied/nullable, validated as a real nonfuture calendar date. No OCR suggestion/date-write producer was added. Original filename normalization remains safe for response headers and does not become the S3 key.

Upload authorization is rechecked after validation. Original retrieval rechecks current session/account state and ownership/reference after acquisition, compares saved size and SHA-256 before streaming any bytes, and returns an attachment rather than a signed URL. Same-size object tampering fails closed. The existing S3 reader's private-bucket/owner/encryption/version/ETag guards remain intact. Negative validation occurs before object storage/record insertion, and retained adapter tests cover conditional write/cleanup safety. Storage mocks do not establish live AWS acceptance.

Migration 0003 formerly marked the whole document completed when extraction finished. Migration 0007 retains fenced extraction evidence/job completion but leaves the document processing state at `processing`. Existing extraction-only completed documents are conservatively reclassified to `processing`; no original or extracted evidence is removed. A database gate also normalizes attempted whole-document completion to processing until a future reviewed aggregate-completion contract replaces it. `failed` remains distinct, and the processing API explicitly reports its stage as extraction. **There is deliberately no full aggregate completion producer in this phase.** Future M05/downstream work must define the required stage evidence and replace the gate; it must not bypass it by relabeling extraction success. Historical summary readiness checks requiring whole-document completion consequently cannot publish new work solely on extraction success; their later integration needs renewed evidence.

The unchanged retry repository enforces exact owner, original document/job identity, approved canary/cutoff, eligible failure code, attempt budget and one transition from failed to retry_wait. It never replaces a source object or resets attempts. SQL now prevents source/owner/integrity drift, and extraction persistence rejects a source digest differing from the saved upload digest. Focused tests prove failure retains the original and private access; retry keeps owner/key/hash/metadata and denies another patient/repeat retry. The public endpoint still requires the existing scoped approval. No retry approval was invented and no worker/OCR/Python service was started.

## 4. Migration and files

New migration: `backend/migrations/0007_guardian_documents.sql` only. It extends the two purpose constraints; adds guardian relationships, indexes, lifecycle events, eligibility view and guards; adds document MIME/size/digest constraints and immutability; replaces the extraction persistence function additively for digest/readiness semantics; and installs the aggregate gate. It creates no guardian medical notification worker and does not promote old contacts.

Qualification applied migrations 0001–0007 inside disposable PostgreSQL16 using `SET LOCAL ROLE health_wallet_migrator`, with the application role exercising APIs. Before committing 0007 in the test database, the suite applied and rolled it back, proved the guardian table absent again and the legacy completed state restored, then reapplied it successfully. A synthetic pre-0007 document retained its owner/key and unknown integrity, with its extraction-only completion intentionally corrected. Runtime event update/delete is denied; constraints and row triggers are exercised directly.

**Migration 0007 is not applied to the normal development database or production.** This is a reviewable code/migration package. Any subsequent local application must use the existing normal migration runner with a fresh private checkpoint/backup and coordinated application activation; the new application revision requires the new schema. No destructive down migration is supplied. The disposable rollback check is not a production backup/restore claim.

Changed/added files:

- `backend/migrations/0007_guardian_documents.sql`.
- `backend/src/guardians/repository.ts`, `routes.ts`, `phase2.test.ts` (new).
- `backend/src/auth/routes.ts`, `security-email.ts`, `identity-security.test.ts`.
- `backend/src/documents/repository.ts`, `service.ts`, `routes.ts`, `file-access.ts`.
- `backend/src/app.ts`, `backend/package.json`, `infrastructure/identity/run.mjs`.
- `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md`, this report and the new receipt in `docs/baselines/`.

The runner gained explicit `--phase2`; package command `phase2:guardian-documents:test` selects it. It reads no application .env, creates only its owned private /tmp PostgreSQL cluster, permits only a private Unix socket, uses synthetic accounts and local ephemeral HTTP, stops its cluster and retains private evidence. Identity test fixtures were updated for mandatory new integrity metadata; the existing optional Phase 1B schema-restore mode applies 0007 to the restored disposable schema before exercising current code.

## 5. Focused commands and results

```sh
node infrastructure/identity/run.mjs --execute-isolated --phase2
node infrastructure/identity/run.mjs --execute-isolated
npm --prefix backend run typecheck
npm --prefix backend run build
git diff --check
```

| Evidence | Final result | Scope |
| --- | --- | --- |
| Phase 2 | 33 pass, 0 fail, 0 skip | 23 numbered guardian/document tests plus retained S3 SDK suite (parent + 9 subtests); restricted-role migration and rollback included |
| M01 compatibility | 39 pass, 0 fail, 1 skip | Identity/session/email focused cases; backup-specific test is intentionally skipped without the explicit private checkpoint option |
| Typecheck/build | Pass | Current TypeScript sources and focused tests |
| Baseline/inventory/static preservation | Pass | Authoritative document hashes; exact 232 IDs; 18 modules; 0001–0006 and historical evidence unchanged |

P2-01 covers migration/legacy preservation/privileges. P2-02–12 cover optionality, invitation delivery/hash/purpose/expiry/one-use, resend bounds, replacement/removal, eligibility, current sessions, cross-patient denial, DB invariants and races. P2-13–19 cover formats, metadata, private retrieval, validation, owner isolation, tampering, failure/retry/source fencing and truthful extraction readiness. P2-20 covers actual registration with and without intent and automatic post-verification invitation. P2-21 adds simultaneous acceptance and suspended-account rejection; P2-22 checks page/pixel/active-PDF quotas; P2-23 proves optional guardian queue failure cannot undo M01 verification and can be recovered through authenticated nomination.

Final private evidence is copied under `.private-evidence/prd-v2-phase2-20261028/`; paths, checksums and attempt outcomes are recorded in the receipt. Final Phase 2 source cluster: `/tmp/hw-phase1-pg-bOCDlG`; final M01 source cluster: `/tmp/hw-phase1-pg-dGPXZK`; both stopped. Initial attempts are retained honestly: one setup failure from a synthetic hash violating the existing format constraint, one run with upload timeouts and resulting busy responses, followed by diagnostic and clean passing runs. The timeout's independent root cause was not isolated; it did not recur in the subsequent clean qualification, including concurrent focused M01 execution. Temporary content-free diagnostic markers were removed before final qualification. No broad regression/full OCR/AI/E2E/release suite was run.

## 6. Requirement-by-requirement disposition

IMPLEMENTED below means qualified backend behavior only. The tracker retains the full exact requirement, mappings, implementation, evidence, gap, dependency, evidence reuse and re-verification fields for every row.

| PRD ID | Mapping | Status | Focused evidence / remaining scope |
| --- | --- | --- | --- |
| M02-001 | FR-040 | IMPLEMENTED | P2-02/03/20/23; optional registration intent and authenticated nomination, separate guardian acceptance |
| M02-002 | FR-041 | IMPLEMENTED | P2-05/06/07/09; current status, bounded resend, replace/remove and eligibility invalidation |
| M02-003 | DEC-18 | IMPLEMENTED | P2-02/20; no guardian requirement for account creation |
| M02-004 | DEC-18 | IMPLEMENTED | P2-08/11/21; one-primary index and serialized transitions |
| M02-005 | FR-040 | IMPLEMENTED | P2-03/04/12/20; pending + encrypted queued expiring invitation |
| M02-006 | FR-040/041 | IMPLEMENTED | P2-02/03/06/07/12; lifecycle eligibility excludes unaccepted/revoked recipients; future M10 must consume contract |
| M02-007 | FR-041 | IMPLEMENTED | P2-05/06/07; management API and safe resends |
| M02-008 | FR-041 | IMPLEMENTED | P2-06/07/09/12; old relationship/invitation loses authority immediately; no M10 delivery claim |
| M02-009 | FR-040; CFG-11 | IMPLEMENTED | P2-03/04/11/21; fixed email/patient/invitation purpose/hash binding; CFG-11 remains a release gate |
| M02-010 | NFR-01; CFG-11 | IMPLEMENTED | P2-01/05/08/09/11/12; transactions, audit and concurrent mutation |
| M03-001 | FR-004 | PARTIAL | P2-13/16 backend passed; mobile absent |
| M03-002 | FR-005 | NEEDS_REVERIFICATION | Retained S3 adapter mock evidence; no new live AWS/deployed qualification |
| M03-003 | FR-010 | IMPLEMENTED | P2-13/14/17/22 integrity/decoder validation; legacy unknown hashes explicitly unqualified |
| M03-004 | FR-004; DEC-07 | PARTIAL | P2-13 all four backend types passed; mobile absent |
| M03-005 | FR-010; DEC-07; CFG-03 | IMPLEMENTED | P2-13/14/22 configurable type/size/page/pixel validation |
| M03-006 | FR-010; V-04 | IMPLEMENTED | P2-14/15/22 rejection before persistence + retained private SDK/cleanup guards |
| M03-007 | FR-005; NFR-01 | NEEDS_REVERIFICATION | P2-13/16/18 backend owner/reference safeguards; actual private S3 deployment open |
| M03-008 | FR-006/007; DEC-07 | IMPLEMENTED | P2-13/15/18 required metadata/dates plus new integrity tuple |
| M03-009 | DEC-07 | PARTIAL | P2-18/19 false aggregate completion corrected; real downstream completion contract absent |
| M03-010 | DEC-07; V-06 | PARTIAL | P2-18/19 failure retention proven at current processing boundary; categorization/embedding/real-summary failures need later integration |
| M03-011 | DEC-07; V-06 | PARTIAL | P2-18/19 source-preserving scoped retry tested; stable approved product/Python retry remains |
| M03-012 | NFR-01; V-02 | IMPLEMENTED | P2-16/17 + M01 current-session/in-flight-revocation cases; no identifier/URL bypass on existing patient paths |

AT-02/03 and V-02/03/04 receive focused backend evidence, not full acceptance. V-26 has backend guardian lifecycle evidence; client/actual provider/CFG-11 qualification remains open. V-06 receives partial retention/retry evidence only; no real OCR/AI completion claim. No FR/NFR/decision/configuration/acceptance scenario outside the scoped evidence is automatically closed.

## 7. Minimum M14/M15/M18 support and remaining gates

M14: current M01 authorization protects new guardian operations and retained document routes. Management rechecks under patient locking; uploads recheck after validation; file delivery rechecks before bytes. Owner selectors cannot be supplied by clients. No Python/service-boundary implementation was added.

M15 future deletion contract: account privacy restriction must deny access and exclude the patient from guardian eligibility immediately; the eventual deletion worker must explicitly revoke all current guardian relationships/challenges, cancel/delete queued encrypted invitation payloads under retention policy and retain/minimize audit as approved. It must propagate through new relationships/events, legacy contacts/notification references, auth challenges/email delivery metadata/payloads and immutable document original metadata. Individual document deletion must restrict library/file/processing/retry/sharing/AI access first, cancel in-flight derived work, then reconcile private originals/versions and OCR/chunks/embeddings/summaries/share links according to retention/legal holds. Preserve unrelated patients/documents; do not reuse an old guardian relationship ID or original ID for new authority. M10 must resolve the current verified relationship at dispatch and implement a shared revocation fence; a previously queued target is insufficient. These are contracts only; no deletion/privacy worker or medical sender was implemented.

| Gate | Current disposition |
| --- | --- |
| CFG-03 | Existing defaults: 5MiB/file (configurable 1KiB–20MiB), 2 simultaneous uploads, 16M image pixels, 100 PDF pages; focused tests override to 4096 bytes/1000 pixels/2 pages and verify rejection. Final release values/resources need review. |
| CFG-11 | Guardian consent/legal/privacy and permitted email handling approval remain OPEN before real-patient use; technical acceptance is not legal approval. No approved consent wording/version is invented. |
| Guardian invitation policy | Reuses bounded identity verification TTL (default24h), cooldown60s, window900s, maximum5 issues/window, existing mail attempt budget3. Tests use cooldown1s. The exact real-use policy remains subject to CFG-11/security review. |
| Email provider | Reuses Phase 1B disabled-by-default/sandbox/approved HTTPS relay configuration; no provider activation, secret change or real email in this phase. Relay submission/idempotency does not prove remote inbox receipt. |
| CFG-12/18 | Privacy retention/deletion/legal holds remain OPEN; no irreversible deletion authorization inferred. |
| Storage/deployment | Actual S3/IAM/region/encryption and current deployed ownership acceptance remain open under M16/CFG-08. |
| Processing/product retry | Aggregate stage authority, Python transition, downstream failures and stable approved retry are later dependencies. No canary approval artifact was created. |
| Client/full acceptance | React Native, doctor web/Admin and full-system qualification remain outside this phase. |

M14/M15/M18 receive only these support contracts and updated traceability; their module statuses are unchanged.

## 8. Updated progress and next-phase recommendation

Tracker totals: **46 IMPLEMENTED, 58 PARTIAL, 101 MISSING, 19 BLOCKED, 8 NEEDS_REVERIFICATION = 232**. The tracker still contains every original requirement ID and exact text. Ten row statuses changed (nine M02 rows and M03-012); other modules were not upgraded. Weighted control estimate is 32.3% across the PRD, not effort or release readiness.

| Module | Requirements | I / P / M / B / NR | Estimate / qualification |
| --- | --- | --- | --- |
| M01 | 14 | 14 / 0 / 0 / 0 / 0 | 100% backend; release open |
| M02 | 10 | 10 / 0 / 0 / 0 / 0 | 100% backend lifecycle; CFG-11/provider/client/M10 integration open |
| M03 | 12 | 5 / 5 / 0 / 0 / 2 | 62.5%; incomplete |
| M04 | 14 | 6 / 4 / 4 / 0 / 0 | 57% |
| M05 | 10 | 2 / 5 / 1 / 0 / 2 | 45% |
| M06 | 8 | 3 / 2 / 3 / 0 / 0 | 50% |
| M07 | 11 | 0 / 6 / 4 / 1 / 0 | 27% |
| M08 | 22 | 0 / 3 / 17 / 2 / 0 | 7% |
| M09 | 19 | 1 / 5 / 12 / 1 / 0 | 18% |
| M10 | 14 | 0 / 2 / 10 / 2 / 0 | 7% |
| M11 | 11 | 1 / 0 / 10 / 0 / 0 | 9% |
| M12 | 10 | 1 / 0 / 9 / 0 / 0 | 10% |
| M13 | 22 | 0 / 0 / 21 / 1 / 0 | 0% |
| M14 | 11 | 0 / 9 / 0 / 1 / 1 | 41% |
| M15 | 12 | 1 / 4 / 6 / 1 / 0 | 25% |
| M16 | 10 | 0 / 5 / 1 / 3 / 1 | 25% |
| M17 | 11 | 0 / 5 / 3 / 1 / 2 | 23% |
| M18 | 11 | 2 / 3 / 0 / 6 / 0 | 32% |

**Phase 3 may begin only after owner review/approval of this package and a bounded implementation scope.** The backend contracts support a next local synthetic phase, but M03 is not fully accepted. Recommended sequence: review/apply the qualified schema locally with a fresh checkpoint; define truthful required-stage readiness and Python OCR/retry contracts; then authorize the bounded M04/M05 work. Deletion needs its policy gates, and mobile/live S3/real-provider qualification must remain explicit later work. Starting broad AI, sharing, M10 email or deployment on an assumption that M03 is complete would be premature. No Phase 3 work has started. Stop for owner review.

# PRD v2 Phase 2B — M03 document backend closure

28 October 2026 · Asia/Karachi. **M03 backend code and document contracts are qualified within the authorized boundary. Overall M03 acceptance remains OPEN: 8 IMPLEMENTED, 2 PARTIAL, 2 NEEDS_REVERIFICATION.** The remaining partial rows explicitly require mobile, and the two uncertain rows require current live S3 evidence. No mobile, OCR, downstream AI or later-module implementation was undertaken to close those external obligations.

Final focused qualification: **24 passed, 0 failed, 0 skipped**. Typecheck/build and preservation checks passed. No new migration, normal-development/production database change, AWS request, real email/model call, deployment, commit or push occurred. Existing uncommitted Phase 2 work was preserved.

## 1. Baseline and exact remaining gaps

Authoritative requirements remain `AI_Health_Wallet_Revised_SRS_v4_0.docx` and `AI_Health_Wallet_Module_Wise_PRD_v2_0.docx`. Their SHA-256 hashes remain respectively `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55` and `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84`. The existing tracker, reconciliation, Phase 2 report and receipt supplied implementation/evidence context. Only M03 rows were reassessed; all 232 requirement IDs, exact requirement text and mappings remain present.

| Previously open row | Exact gap at entry | Phase 2B disposition |
| --- | --- | --- |
| M03-001 | Backend upload exists; required React Native journey absent | Backend formats/upload/account isolation reverified; PARTIAL remains because frontend is forbidden in this phase |
| M03-002 | Current live S3 storage path unqualified | SDK/local evidence refreshed; NEEDS_REVERIFICATION remains because no current explicitly approved non-production live scope was established |
| M03-004 | Four backend formats exist; mobile integration absent | All four formats reverified; PARTIAL remains for mobile |
| M03-007 | Current actual S3 privacy/object-owner deployment unqualified | Immutable owner/reference and adapter privacy guards pass locally; live requirement remains NEEDS_REVERIFICATION |
| M03-009 | No explicit M03 handoff/readiness API; extraction completion previously confused with whole-document completion | Added coherent readiness contract; existing processing/completion/failure distinctions retained without granting any OCR/AI completion authority |
| M03-010 | Original retained in existing failures; named downstream failure boundaries not evidenced | Simulated OCR/category/embedding/summary faults exercised through the real generic failure repository; immutable original, metadata, bytes and private access preserved; actual downstream workflows remain external |
| M03-011 | Only older canary-approved retry endpoint available | Added current-session owner retry admission, preserving the same existing job/source and bounds; no worker/processor activation or approval-file fabrication |

M03-003/005/006/008/012 were also reverified using focused document scenarios. No working validator, S3 implementation or document system was rebuilt.

## 2. Changes and API contract

Two new document endpoints use the existing authenticated document router and `/api/v1` prefix:

| Endpoint | Contract |
| --- | --- |
| `GET /documents/:id/readiness` | Current M01 session and exact owner required; no query/body selectors. Returns document processing status, original-integrity attestation state, separately verified extraction status, extraction-queue readiness, downstream completion qualification and document retry eligibility. Uses a short read-only REPEATABLE READ transaction so document/job reads form one coherent snapshot. |
| `POST /documents/:id/retries` | Empty JSON body only; exact owner/current session required. Rechecks M01 authorization under the patient lock and atomically queues only the same eligible failed job. Returns 202 on admission, 409 for ineligible/repeated admission, 404 for foreign/missing documents and 429 after five requests per patient/minute. |

Example readiness fields for an accepted original awaiting extraction:

```json
{
  "processing_status": "processing",
  "original_integrity": "recorded_at_upload",
  "extraction": {"stage": "extraction", "status": "queued"},
  "ready_for_extraction": true,
  "downstream_completion": "not_qualified",
  "retry_allowed": false
}
```

The response also carries the document ID and sanitized existing extraction failure metadata. `recorded_at_upload` attests to persisted upload integrity metadata and a permitted private reference; it is not a fresh live-cloud availability probe. `ready_for_extraction` means integrity-known source plus queued/retry-wait job eligibility. It does not mean OCR has run. Extraction completion is validated against its existing fenced attempt/payload and the saved source digest; it never implies downstream AI completion. `downstream_completion` stays `not_qualified`. Migration 0007's existing aggregate gate remains unchanged. Actual completion production belongs to later authorized processing integration, not M03 closure.

The new owner retry policy is selected internally, never from request JSON. It reuses the existing SQL retry transition with exact document/patient joins. Admission requires known MIME/size/digest and valid fixed-bucket/prefix/type reference, both document and job failed, a positive attempt below the existing maximum, and an approved recoverable failure code (`PROCESSOR_FAILED`, `PROCESSOR_TIMEOUT`, `INTERRUPTED`, `LEASE_EXPIRED`). It never resets attempts, creates another source/job, changes ownership, replaces original bytes or deletes prior provenance. Concurrent requests admit exactly one transition. Invalid-input and exhausted-budget failures are denied. Unknown legacy integrity cannot be queued through this product API.

The older `/documents/:id/processing-retries` canary endpoint retains its separate approval requirement and continues to return 503 without its existing approval. This phase creates no canary approval artifact and relaxes no worker/startup guard. Queueing a document retry does not start a worker. A later authorized consumer must revalidate the current source/hash and its own processing authority.

Existing categories remain `lab_report` (Lab Report), `prescription` (Prescription), `other_medical_document` (Other). Hospital edits and patient-confirmed dates retain their existing API; no extraction/suggestion writer was added. Size remains a PostgreSQL BIGINT/JSON decimal string. Private bucket/key remain internal to owner-scoped repositories rather than becoming URLs in patient responses.

## 3. Files changed in this phase

- `backend/src/documents/lifecycle.ts` — new readiness and transactional owner retry boundary.
- `backend/src/documents/routes.ts` — two document endpoints and bounded retry admission.
- `backend/src/processing/api-repository.ts` — reuse existing retry SQL with explicit internal owner policy; verify extraction source digest when upload integrity is known. No OCR/worker implementation changed.
- `backend/src/documents/closure.test.ts` — focused M03 scenarios reused/adapted from Phase 2, plus readiness/retry/account/failure-contract cases.
- `infrastructure/identity/run.mjs` — explicit `--m03-only` selection, retaining owned disposable PostgreSQL isolation.
- `backend/package.json` — `documents:closure:test` command.
- `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md` — M03 evidence/status/gaps and aggregate totals.
- This report and `docs/baselines/PRD_V2_PHASE_2B_M03_DOCUMENT_CLOSURE_RECEIPT.json`.

**No migration added. Migrations 0001–0007 are unchanged from phase entry.** All required immutable-source/integrity columns, state fences and ownership constraints already exist. The tests apply the existing schema with a restricted migrator role in a fresh disposable database and exercise application-role permissions. The existing disposable rollback/reapply probe for 0007 is reused; no new production/schema rollout was performed. The normal development database still requires the previously delivered schema/application coordination; this phase does not apply the pending Phase 2 migration on the owner's behalf.

Phase 2 source/report/receipt history is retained. The earlier receipt remains evidence of its earlier source snapshot; this phase supplies new hashes rather than rewriting it to describe changed code.

## 4. Focused verification

Commands:

```sh
node infrastructure/identity/run.mjs --execute-isolated --m03-only
npm --prefix backend run typecheck
npm --prefix backend run build
git diff --check
```

Equivalent test selector: `npm --prefix backend run documents:closure:test`.

| Test evidence | Verified behavior |
| --- | --- |
| M03-13 | PDF/JPG/JPEG/PNG accepted; owner/category/hospital/document date/upload timestamp/filename/MIME/size/SHA256/private reference persist; exact private byte retrieval |
| M03-14 | Unsupported extension, MIME mismatch, bad magic/content, malformed PDF, empty and oversized content reject before storage/record insertion |
| M03-15 | Categories/hospital/calendar dates validated; hospital/date update owner scoped; filename normalization safe |
| M03-16 | Owner isolation, anonymous/revoked denial, ID/URL selector rejection, no signed URL response |
| M03-17 | Same-size object tampering fails stored digest comparison before response bytes |
| M03-18 | Failure retains original; scoped SQL retry preserves immutable owner/source/hash/metadata; wrong owner/repeat retry denied; older public canary path remains gated |
| M03-19 | Synthetic fenced extraction evidence/digest binding; extraction job completion remains distinct from aggregate document completion |
| M03-22 | Page/pixel resource quotas and active PDF content rejected |
| M03-24 | Actual new owner retry API; concurrent duplicate admission yields one 202 and one 409; unchanged original/attempt count; no extraction created/processor started |
| M03-25 | Suspended/deleted/deletion-pending/deletion-restricted/revoked/unverified accounts denied on upload, list, metadata/edit, private download, readiness and retry; legacy sid-less token denied |
| M03-26 | Named simulated OCR/category/embedding/summary faults use the existing real generic failure repository; original identity/bytes/private access survive failure and owner retry |
| M03-27 | Invalid-input/exhausted-budget/pending retries denied; readiness truthfulness, owner and query/body isolation |
| M03-28 | Account restriction during original acquisition denies content before streaming |
| M03-29 | Five/minute retry bound; unknown legacy integrity remains unverified/non-ready/non-retryable |
| Retained S3 SDK suite | Fixed owner/bucket/prefix, private-access/encryption fail-closed behavior, conditional writes/conflicts, safe cleanup and SSE-KMS option guards, using injected SDK transport only |

Final: **24/24 pass** (14 numbered M03 cases plus the SDK parent and nine subtests). An initial narrower 22/22 run also passed. Final typecheck/build passed. No focused failure required broad regression; no identity/guardian/full processing/E2E suite ran. Actual OCR, categorization, embedding and summary providers were not executed: M03-26 proves the storage/failure boundary with injected faults, not those modules' integrated behavior. V-06 therefore retains downstream integration obligations.

Private evidence: `.private-evidence/prd-v2-phase2b-20261028/`. Final owned cluster `/tmp/hw-phase1-pg-soVZAb`; initial owned cluster `/tmp/hw-phase1-pg-5LiN2P`; both stopped. The receipt records private TAP hashes, source hashes and protection checks. Only synthetic files/accounts and ephemeral local HTTP were used. No raw token/credential is included in the public receipt.

## 5. Live S3 qualification decision

Existing backend configuration names include storage enablement, AWS region/profile, bucket/owner/prefix and encryption; local AWS configuration/credential files exist. Their existence is not proof of a non-production resource classification or current authorization to create/read/delete qualification objects. Credential values were not printed or invented.

Targeted review of the existing integration guards and approval records found historical fixed-target Gate 1/Gate 2 and canary mechanisms. Historical B03 documentation explicitly retains separate approval for fresh synthetic seeding/scope and runtime activation. No current approved non-production M03 qualification scope/approval file was identified in the inspected project evidence/configuration. Historical test receipts were not treated as authorization for a new current-cloud run.

Accordingly, **no AWS/STS/S3 request, live write, bucket policy change or production access was attempted**. M03-002 and M03-007 stay NEEDS_REVERIFICATION. Mock SDK tests do not close these live requirements. Their release follow-up requires an explicitly identified approved non-production account/bucket/prefix, synthetic object/cleanup scope, current privacy/ownership/encryption checks and actual upload/retrieval/anonymous-and-cross-owner denial evidence against the current application. Do not infer that a configured account is safe for qualification merely from its name.

## 6. Final disposition of all twelve M03 requirements

| PRD ID | Source mapping | Status | Backend evidence / external remainder |
| --- | --- | --- | --- |
| M03-001 | FR-004 | PARTIAL | Upload backend qualified; required mobile application/journey absent |
| M03-002 | FR-005 | NEEDS_REVERIFICATION | S3 implementation/mock transport qualified; current approved live S3 qualification absent |
| M03-003 | FR-010 | IMPLEMENTED | Decoder/integrity validation and stored digest comparison; unknown legacy integrity not promoted |
| M03-004 | FR-004; DEC-07 | PARTIAL | PDF/JPG/JPEG/PNG backend qualified; mobile integration absent |
| M03-005 | FR-010; DEC-07; CFG-03 | IMPLEMENTED | Extension/MIME/magic/content/size/resource controls; final CFG-03 release thresholds remain reviewable |
| M03-006 | FR-010; V-04 | IMPLEMENTED | Rejection precedes accessible persistence; retained private/conditional-write/cleanup guards |
| M03-007 | FR-005; NFR-01 | NEEDS_REVERIFICATION | Exact owner/source and private adapter safeguards qualified; live-cloud proof absent |
| M03-008 | FR-006/007; DEC-07 | IMPLEMENTED | Full required owner-linked metadata, dates, hospital edit, integrity and storage reference |
| M03-009 | DEC-07 | IMPLEMENTED | M03 readiness/state handoff qualified; distinct extraction completion, processing/failed aggregate state and explicit unqualified downstream completion; actual downstream completion remains M05/later |
| M03-010 | DEC-07; V-06 | IMPLEMENTED | M03 stage-independent original-retention contract verified with four simulated failures; real downstream module integration unclaimed |
| M03-011 | DEC-07; V-06 | IMPLEMENTED | Actual current-session owner retry API preserves same job/owner/source with concurrency, failure, integrity, rate and attempt bounds |
| M03-012 | NFR-01; V-02 | IMPLEMENTED | Owner/current-account/session private access with no ID/URL bypass and pre-byte integrity/revocation checks |

Three backend contract rows (009–011) move from PARTIAL to IMPLEMENTED. This is not an upgrade to mobile/cloud/OCR/AI/full release acceptance. Requirements do not disappear when their remaining work belongs to another module. Backend code/contracts are complete for this phase's M03 boundary; **M03 as a complete accepted product module is not closed** while four exact PRD rows remain partial/unverified.

AT-02/03 and V-02/03/04 receive focused backend evidence. V-06 has storage-retention/retry evidence with simulated faults; real OCR/AI outcomes remain external. No later module, deployment or full-system acceptance row is upgraded.

## 7. Progress and release blockers

All 232 exact rows remain: **49 IMPLEMENTED, 55 PARTIAL, 101 MISSING, 19 BLOCKED, 8 NEEDS_REVERIFICATION**. Weighted control estimate: 33.0% overall. M03 is 8/2/0/0/2 (I/P/M/B/NR), a 75% full-row estimate; backend coding scope and product/release acceptance are distinct.

| Module | Requirements | I / P / M / B / NR | Progress |
| --- | --- | --- | --- |
| M01 | 14 | 14 / 0 / 0 / 0 / 0 | 100% backend; unchanged |
| M02 | 10 | 10 / 0 / 0 / 0 / 0 | 100% backend lifecycle; unchanged |
| M03 | 12 | 8 / 2 / 0 / 0 / 2 | 75%; backend contracts qualified, mobile/live acceptance open |
| M04 | 14 | 6 / 4 / 4 / 0 / 0 | 57%; unchanged |
| M05 | 10 | 2 / 5 / 1 / 0 / 2 | 45%; unchanged |
| M06 | 8 | 3 / 2 / 3 / 0 / 0 | 50%; unchanged |
| M07 | 11 | 0 / 6 / 4 / 1 / 0 | 27%; unchanged |
| M08 | 22 | 0 / 3 / 17 / 2 / 0 | 7%; unchanged |
| M09 | 19 | 1 / 5 / 12 / 1 / 0 | 18%; unchanged |
| M10 | 14 | 0 / 2 / 10 / 2 / 0 | 7%; unchanged |
| M11 | 11 | 1 / 0 / 10 / 0 / 0 | 9%; unchanged |
| M12 | 10 | 1 / 0 / 9 / 0 / 0 | 10%; unchanged |
| M13 | 22 | 0 / 0 / 21 / 1 / 0 | 0%; unchanged |
| M14 | 11 | 0 / 9 / 0 / 1 / 1 | 41%; unchanged |
| M15 | 12 | 1 / 4 / 6 / 1 / 0 | 25%; unchanged |
| M16 | 10 | 0 / 5 / 1 / 3 / 1 | 25%; unchanged |
| M17 | 11 | 0 / 5 / 3 / 1 / 2 | 23%; unchanged |
| M18 | 11 | 2 / 3 / 0 / 6 / 0 | 32%; unchanged |

Remaining release/live obligations: current authorized private S3 qualification; React Native integration; final CFG-03 quotas and operational admission/load acceptance; controlled qualification of legacy unknown integrity; coordinated local schema/application activation from the prior phase; and later actual OCR/AI downstream completion/failure/retry integration. Existing privacy/retention/deletion policy and other release gates remain unchanged. No artificial approval, fabricated legacy checksum or implicit real-patient readiness is introduced.

**Phase 3 may be considered after owner review and explicit authorization of its bounded scope.** Current document contracts provide a stable boundary for downstream work, but Phase 3 is not authorized by this request and may not presume live/mobile M03 acceptance. No Phase 3 work started. Stop for owner review.

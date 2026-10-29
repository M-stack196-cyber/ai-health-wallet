# PRD v2 Phase 4 — medical summaries

29 October 2026 · Asia/Karachi · Owner review checkpoint. No deployment, commit or push.

## Outcome

The supported **offline/synthetic patient backend** now generates report summaries through real private Node→Python HTTP, persists validated summaries with provenance, exposes current owner reads/retries, and assembles source-bound chronological history from multiple generated report sections. Existing summary contracts, private FastAPI factory/provider, source snapshots, leased jobs, publication fences, evaluator and glossary were reused.

**M07 is not fully implementation-complete or accepted:** 3 IMPLEMENTED / 5 PARTIAL / 2 MISSING / 1 BLOCKED. Supported offline report/history paths are qualified; a narrow lab catalogue, bounded source-separated history and deterministic synthetic provider do not complete general medical-report/history AI requirements. CFG-01 actual provider approval, CFG-10 clinical/quality approval, doctor scope and deployed/client acceptance remain open. No unsupported source is relabelled as a grounded success.

## Baseline and repository state

Verified entry/current HEAD: **fc91077 — Complete Phase 3 document processing and timeline backend**. Entry tracked worktree was clean; all Phase 4 work remains uncommitted. No branch change, commit or push occurred.

Requirements remain the SRS v4.0 and PRD v2.0 DOCX files, current tracker/reconciliation and Phase 3 report. Exact M07 rows and relevant FR-015/016/022/023, DEC-21, CFG-01/10 were read before implementation. Source inventory remains 232 requirements / 18 modules. Only the 11 M07 assessment rows changed; the other 221 requirement rows retain their exact prior assessments. Both DOCX files, migrations 0001–0008 and every pre-existing baseline receipt match captured entry hashes.

| Authoritative document | SHA-256 |
| --- | --- |
| docs/AI_Health_Wallet_Revised_SRS_v4_0.docx | `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55` |
| docs/AI_Health_Wallet_Module_Wise_PRD_v2_0.docx | `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84` |

[Tracker](PRD_V2_MODULE_DELIVERY_TRACKER.md) · [Evidence receipt](baselines/PRD_V2_PHASE_4_MEDICAL_SUMMARIES_RECEIPT.json).

## Implemented report path

Node remains the authority for the current patient/session, document ownership, source/job eligibility, retry/lease state, contract validation and publication. Python has no database, patient-session or object-store authority. It receives an immutable copied source contract and server-created fact catalogue, proposes structured output, and the existing Python and Node validators independently enforce exact source facts, evidence byte spans, source scope and pinned provenance.

A Phase 3-qualified extraction is eligible when its job and extraction are completed, attempt/token/fingerprint and original SHA match, and source/account access remains active. Whole-document completed state is **not required** to start M07: migration 0007 intentionally keeps that state processing until later downstream authority exists. Phase 4 does not falsely mark the full document pipeline completed.

The new default catalogue accepts only complete English **Glucose / Hemoglobin / Haemoglobin / Hgb / Hb** measurement lines with an explicit numeric value or `???`, and optional approved unit spellings. It supplies byte-accurate source references, value/unit evidence and explicit ambiguity/nulls. Unsupported prose, diagnoses, prescriptions, dates, physician instructions and arbitrary prompts are never promoted into summary facts. No facts, more than 32 facts, oversized source text, failed/pending extraction or invalid provenance produce an eligible summary. This is a safety-limited lab subset, not general clinical extraction. Unsupported content is omitted with an explicit limited-catalogue warning; no semantic completeness is claimed.

Python's reused `DeterministicFakeProvider` returns only schema-bound reported findings, allowed fixed educational explanations, exact uncertainty and provenance. Rendering separates **Source-reported information** from **General explanations (not interpretations of your results)**. It cannot add free-form diagnoses, treatment recommendations, medications, conditions, dates, lab values or physician instructions. An ambiguous measurement remains null/unavailable; missing unit stays unavailable. OCR uncertainty is retained. Output wording and supported quoted labels are English. No new clinical interpretation rules were added.

The existing summary snapshot/job/result tables retain patient/document/extraction identity, processing attempt/token, extractor version, source fingerprint, input/catalogue digest, provider/model/revision, prompt fingerprint, pipeline version, accepted summary attempt/publication token and actual database generation timestamp. Public projections expose approved facts, uncertainty, provider/policy/model/source references and limitations, excluding raw input, service/session secrets and lease/scope tokens. The overall output mode is explicitly `synthetic-offline`.

| Endpoint | Current backend behavior |
| --- | --- |
| POST /api/v1/documents/:id/summary-jobs | Empty JSON only, M01/current owner authorization, source snapshot/catalogue, idempotent queued job; duplicate returns existing job |
| GET /api/v1/summary-jobs/:jobId | Owner-only safe status projection; queued/processing/retrying/completed/failed/cancelled/superseded |
| POST /api/v1/summary-jobs/:jobId/retries | Empty JSON only; current owner/source and failed job with remaining attempt capacity required; no attempt reset |
| GET /api/v1/documents/:id/summary | Current accepted source only; no fallback to an obsolete summary; authorization/source access rechecked before response |
| POST /api/v1/history-summary-jobs | Empty JSON only; selects eligible owner sources and persists an idempotent bounded history manifest referencing their report jobs |
| GET /api/v1/history-summary-jobs/:jobId | Owner/current-source manifest only; returns completed history sections only when all children complete; no partial success disguised as completed |

Endpoints retain no-store, rate limits, rejected query/body selectors and generic safe errors. Foreign/missing/deleted sources return 404, failed/pending/unsupported extraction gives an insufficiency/not-ready 409, and invalid accounts/sessions are denied through M01. APIs remain disabled by default until explicitly composed; no request starts a model worker automatically.

## History behavior and limits

A history request selects current owner records with completed eligible extraction, excludes failed/pending/deleted/restricted sources and may intersect a **trusted server-only** selected-document scope. No endpoint accepts a patient/grant/model/source-text selector. Missing/unsupported source evidence is never invented; an all-insufficient source set fails with 409. Unsupported records omitted during selection are counted. A source set exceeding 20 candidates is refused rather than silently truncated; raw source text remains bounded to the existing 32 KiB contract.

The history manifest persists document/job IDs, factual confirmed-date or labelled UTC upload fallback and catalogue version; referenced immutable report jobs preserve extraction/source provenance. Generated report records are reused; a second free-form history model or duplicate summary store was not built. Final history text is a deterministic chronological composition of those persisted Python-generated sections. **This is source-separated history, not a qualified cross-record clinical narrative/synthesis.** Different or contradictory values remain in distinct dated/source-labelled sections and are explicitly not reconciled. No inference fills missing conditions, dates or treatment.

History status derives from the existing child jobs: queued/processing/completed/failed. A failed child prevents any completed history text; the existing owner retry fixes the child without creating conflicting results. Metadata distinguishes request time (`requested_at`), current deterministic assembly time (`assembled_at`) and each actual source-summary generation time (`entries[].generated_at`); it does not mislabel job creation as model generation.

Every history read rechecks the full manifest's current source fingerprints and access both in RLS and after assembling entries. Deleting any source makes the old entire history inaccessible; a new request excludes that source and receives a new source-set identity. Newly eligible additional records require a new history request; a prior manifest is an explicit selected-set snapshot, not a claim to contain every future record.

The trusted selected-source boundary rejects reading a wider manifest under a narrower selection and rechecks scope changes. It is only a future integration contract. No doctor identity, OTP, grant API or sharing behavior was implemented; M07-003/009 remain MISSING.

## Provider, instruction and privacy boundaries

`SUMMARY_PROVIDER` must explicitly equal `synthetic-offline` for the new manual Python entrypoint/runtime composition; default is disabled. Unknown/hosted modes are refused. A server-controlled provider port already exists, but no production hosted adapter/provider selection/API key was added. The existing offline Ollama benchmark code was preserved; Ollama was neither selected, launched nor queried in this phase.

`createOfflineSummaryRuntime` explicitly composes the existing job executor/client and catalogue with a configured private endpoint/token and trusted patient scope. Its returned API options can be injected into `createApp`; it does not alter default app startup or deploy anything. Manual Python entrypoint binds literal 127.0.0.1, requires a 64-hex secret, disables access logs and exposes the existing protected versioned generation endpoint. Node transport permits literal loopback HTTP and the exact internal summary path, no URL credentials/query/fragment/redirect or arbitrary network target. Existing request/response bounds, cancellation, concurrency limits and safe fixed errors are reused. Tests use generated ephemeral tokens, synthetic data and loopback only.

Uploaded text is data, never a policy/prompt authority. The default catalogue drops instruction prose rather than asking a model to obey it. The provider receives copied data with server-created scope, facts and recipe; critical output state comes from typed fields and exact evidence checks. Unknown advice/diagnosis/treatment/summary prose fields, altered values/dates/conditions/medications, unrecognized facts, missing required facts, scope/provenance tampering and missing uncertainty fail validation. Tests include ignore-rules text, diagnosis/prescription requests, fake OCR instructions, system-secret/exfiltration requests and malicious provider output. These synthetic controls do not establish an unrestricted future LLM's prompt-injection safety.

Phase 3 lifecycle RLS still hides retained source snapshots, report summaries and derived rows. New history RLS denies a manifest if any source is inaccessible or no longer current. New before-update triggers cancel pending/running summary jobs **before** a source or account becomes hidden, release global summary admission and fence delayed results. Publication acquires source locks before the summary-job row to agree with effective deletion's lock order; final claim/source checks remain atomic. Stale/expired results and duplicates cannot publish conflicting accepted summaries.

No source original is erased on failure. Logical deletion makes retained summaries/history inaccessible; physical erasure/backups/legal holds remain CFG-12/18. Existing summaries do not regain API access merely because an owner knows their ID. Trusted application DB-role RLS is a lifecycle guard, not a substitute for authenticated owner predicates. Future consumers/external stores must retain explicit current-source/grant enforcement.

## Additive migration

Added only **backend/migrations/0009_summary_history.sql**. It:

- updates current-summary-source eligibility to completed extraction plus matching immutable original SHA and active source/account, without requiring false whole-document completion;
- extends the existing summary-job transition guard for explicit failed→retry_wait with remaining capacity, preserving attempt/fence/provenance invariants;
- adds a bounded immutable-to-application history-manifest table, unique owner/source-set fingerprint, index and current-source RLS/helper;
- adds source/account restriction cancellation triggers with explicit restricted definer privileges/search paths.

Existing snapshot/report/job tables and contracts were reused. History manifests reference the immutable existing jobs/snapshots through a checked current-source helper; no parallel extraction, patient or report-summary schema was created. PUBLIC access/helper execution is revoked, application grants are SELECT/INSERT for manifests, and no manifest UPDATE/DELETE privilege is added. Cancellation helpers are trigger-only. Earlier migrations 0001–0008 are byte-identical.

Fresh apply and transactional rollback/reapply of 0009 were verified under the non-superuser migrator role in disposable PostgreSQL 16 with a retained legacy source sentinel. No normal development or production migration ran. Previous Phase 1/2/2B/3 test bootstraps' explicit migration count was adjusted from eight to nine; those older suites were not rerun or requalified by that mechanical compatibility edit.

## Focused tests and safety/grounding evaluation

| Check | Result |
| --- | --- |
| Node Phase 4 integration/catalogue plus existing summary contract/executor checks | **130/130 PASS**; 10 new Phase 4 checks plus 120 retained summary checks |
| Python existing focused summary-service checks | **110/110 PASS** |
| Existing pinned offline evaluator | **42/42 expected outcomes PASS**; 11 accepted reference outputs; 31 expected refusals |
| Accepted reference factual/source coverage | **14/14 facts covered**; zero measured accepted grounding/unsupported/numeric/unit/diagnosis/treatment/scope/provenance/uncertainty errors |
| Backend typecheck and build | **PASS** |
| Migration/role/current-source/deletion/security checks | **PASS**, inside owned isolated PostgreSQL/loopback fixture |
| Git diff whitespace and preserved baseline/migration hashes | **PASS** |

The offline evaluator's catalogue is independently authored synthetic reference facts. It qualifies contract/provider acceptance behavior, not broad accuracy of the new narrow text catalogue or a real LLM. Existing synthetic benchmark criteria were reused unchanged; **they are not newly approved CFG-10 clinical thresholds**. Unsupported-claim rate among the accepted reference facts is 0/14 in this fixture set, not a production/general-population rate. Rejected adversarial candidates deliberately contain errors and are not counted as accepted output quality. No unapproved provider or actual patient data was used.

| New focused cases | Evidence |
| --- | --- |
| P4-01 | Actual extraction-ready Node→private Python→validated SQL summary, safe English/source/model projection, queued/completed and duplicate reuse |
| P4-02 | Cross-patient/invalid-account denial; pending/failed/unsupported/restricted source denial |
| P4-03 | Adversarial OCR instructions remain data; ambiguous/missing values/units and OCR uncertainty preserved |
| P4-04 | Fabricated model value rejected, failure state/original retained, owner-only retry, attempt 2 and single accepted publication |
| P4-05 | Multiple dated records, differing values retained, patient isolation, failed/unsupported exclusion, narrower selection denial, deleted-source history invalidation/regeneration, insufficient records |
| P4-06 | Deletion/account restriction while delivering real Python result cancels/fences publication |
| P4-07 | Expired prior attempt cannot overwrite a newer completion; snapshots/history inaccessible after deletion |
| P4-08/09 | UTF-8 byte grounding, English/narrow catalogue, instruction/unknown-number refusal; disabled/hosted/nonprivate provider boundary |
| P4-10 | History cannot claim completed on a failed child; safe retry restores it; true source generation timestamps retained |

Retained contract/executor suites additionally test conflicting findings, required-fact preservation, missing-source/incomplete extraction, numerical/negation/unit/range tampering, prescription/treatment/free-form additions, byte evidence, JSON boundaries, scope/digest/model/prompt mismatches, deadlines/cancellation/admission, heartbeat failure and safe public projections. Python private-service tests exercise authorization, bad bodies/content types/headers, injected provider failures, capacity, deadlines and shutdown.

No broad repository regression, clinical evaluation, real Ollama/hosted-model benchmark, cloud/client/deployment or final E2E qualification ran. Test originals use the existing in-memory synthetic storage fixture. Source extraction in Phase 4 tests is seeded through the existing fenced extraction service; Phase 3's actual OCR qualification is reused, not falsely rerun here.

Initial focused attempts exposed a lowercase fact-ID/schema mismatch and stale projection/privileged-restriction test expectations (119/127 passed); these were corrected. The next run passed 126/127, with one fixture attempting a forbidden retry_wait→retry_wait update; it was changed to wait for the actual retry delay. A subsequent 129/129 run passed, followed by the final expanded 130/130 run. Failed attempts are retained privately. No acceptance is inferred from the earlier failures.

## All 11 M07 requirement decisions

IMPLEMENTED below means the named scoped backend control, not full module acceptance. Every tracker row retains exact requirement/source mapping and records functions, evidence, status, dependency, gap, old-evidence reuse and reverification.

| Requirement | Source mapping | Status | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| M07-001 | FR-015 | PARTIAL | P4-01/02/03/04; contract suite | General report/clinical coverage and approved actual-model qualification remain open; offline lab subset is implemented, not full AI summary acceptance. |
| M07-002 | FR-016 | PARTIAL | P4-05/07/10 | Source-separated offline lab history works; general longitudinal clinical synthesis/coverage and approved actual-model quality remain open. |
| M07-003 | FR-022 | MISSING | P4-02/05; static no doctor API | Actual healthcare-professional identity/current-share-grant summary access requires M09 and is explicitly outside Phase 4. |
| M07-004 | FR-015 | PARTIAL | P4-01/02/03/04 | Only exact supported lab measurements are catalogued; unsupported reports return insufficiency. Full report coverage/model quality is not qualified. |
| M07-005 | FR-016 | PARTIAL | P4-05/07/10 | Bounded 20-record lab subset; clinical history synthesis and representative real-provider evaluation remain open. No doctor flow. |
| M07-006 | DEC-21 | IMPLEMENTED | P4-01/03/08; contract and Python service suites | None for the synthetic backend output boundary; other languages/actual future provider and client/deployment require qualification. |
| M07-007 | FR-023; NFR-04 | PARTIAL | P4-03/04/08/10; 42 offline scenarios | Synthetic contract safety is qualified; general report coverage, actual-model grounding/clinical evaluation and approved thresholds remain open. |
| M07-008 | CFG-01; DEC-12 | IMPLEMENTED | P4-01/04/07/10; offline receipt | None for scoped offline provenance; production provider/model/data-handling approval CFG-01 is still mandatory and not asserted. |
| M07-009 | FR-022; FR-025 | MISSING | P4-05; static no doctor flow | M09 current grant/OTP/revocation/expiry integration and doctor summary enforcement remain absent by authorized scope. |
| M07-010 | FR-015; FR-012 | IMPLEMENTED | P4-02/03/05/10; contract suite | None for synthetic backend insufficient/failed-source denial; actual model and broader source corpus remain release qualification work. |
| M07-011 | CFG-10 | BLOCKED | Offline evaluator; Phase 4 report/receipt | CFG-10 clinical/summary quality thresholds and formal acceptance test plan require owner/qualified approval; CFG-01 actual provider approval remains open. Existing synthetic test criteria are not clinical thresholds. |

Report-summary status: **supported synthetic backend implemented/qualified; general report coverage and actual-model qualification PARTIAL**. History-summary status: **bounded source-separated backend implemented/qualified; general clinical history synthesis PARTIAL**. Safety contract is qualified on stated synthetic evidence, not certified for an actual production model.

## Files changed

| File / area | Purpose |
| --- | --- |
| backend/src/summaries/catalogue.ts | Conservative real extraction-to-fact catalogue and source byte evidence |
| backend/src/summaries/jobs.ts | Extraction readiness, failed-job retry, source-before-job publication locking, current-only summary reads/provenance |
| backend/src/summaries/routes.ts | Default catalogue, safe report metadata, retry and owner history APIs/current-session checks |
| backend/src/summaries/history.ts | Current owner/selected-source history manifests, status and source-separated chronological composition |
| backend/src/summaries/http-transport.ts | Bounded literal-loopback transport for the reused summary client |
| backend/src/summaries/offline-runtime.ts | Explicit synthetic-only runtime factory; default app/server unchanged |
| ai-service/summary_service/entry.py | Explicit private synthetic-only launch; existing service/workflow/provider reused |
| backend/migrations/0009_summary_history.sql | Additive source/retry/history/cancellation enforcement |
| backend/src/phase4/phase4.test.ts; catalogue.test.ts | Focused Phase 4 lifecycle/HTTP/safety/history tests |
| backend/src/summary-checks/executor.unit.ts | Public projection expectation updated; existing privacy assertion retained |
| infrastructure/identity/run.mjs; backend/package.json | Disposable Phase 4 runner and script |
| backend/.env.example | Disabled/default private summary configuration placeholders; no actual secret |
| backend/src/auth/identity-security.test.ts; documents/closure.test.ts; guardians/phase2.test.ts; phase3/phase3.test.ts | Migration-count compatibility only |
| docs/PRD_V2_MODULE_DELIVERY_TRACKER.md | 11 M07 decisions and totals/progress |
| This report; docs/baselines/PRD_V2_PHASE_4_MEDICAL_SUMMARIES_RECEIPT.json | Owner review evidence and source/artifact hashes |

The historical B01–B03.x and Phase 1–3 receipts/reports are preserved. No M08, sharing, medical notifications, frontend, Admin, AWS deployment or final E2E module was started.

## Remaining gates and next-phase decision

- **CFG-01 OPEN:** no hosted provider/model/data handling/geographic approval. Only the explicitly labelled synthetic provider runs; no real patient data went to any hosted model.
- **CFG-10 BLOCKED for formal acceptance:** no invented final quality/clinical thresholds. Representative general-report/OCR/real-model coverage, contradiction handling, performance and formal evaluation/approval remain pending.
- **M07 functional limits:** only supported lab facts; 32 KiB per source, 32 facts, 20 candidate sources; unsupported sources yield insufficiency/omission and no grounded result. History is per-source sections, not unconstrained synthesis. General report and history requirements remain PARTIAL.
- **M09 dependencies:** actual doctor identity/grant/OTP/revocation/expiry access remains MISSING/out of scope. Trusted selection is not doctor authorization.
- **CFG-12/18:** retention, physical erasure, backups/legal holds/approval unresolved; access denial is technical, not legal certification.
- **Live/client/deployment:** service supervision/secrets distribution, production host/network controls, live S3, changed-source attestation and client/integrated acceptance remain open. Prior deployment receipts cannot attest changed summary source.

## Updated 18-module progress

Counts are IMPLEMENTED / PARTIAL / MISSING / BLOCKED / NEEDS_REVERIFICATION. Only M07 changes.

| Module | Title | Rows | IMPLEMENTED | PARTIAL | MISSING | BLOCKED | NEEDS_REVERIFICATION | Estimate | Prerequisite gaps | Proposed phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | Patient Identity, Email Verification, Sessions & Recovery | 14 | 14 | 0 | 0 | 0 | 0 | 100% backend | Release only: real provider approval, CFG-16 security review, secrets/worker operations and client/deployed acceptance | 1 |
| M02 | Patient Profile & Guardian Relationship Lifecycle | 10 | 10 | 0 | 0 | 0 | 0 | 100% backend | Release only: CFG-11/privacy, provider/client/deployment and future M10 send-boundary qualification | 2 |
| M03 | Medical Document Upload, Validation, Private Storage & Processing State | 12 | 8 | 2 | 0 | 0 | 2 | 75% | Backend code/contracts qualified; mobile/live S3 release acceptance, legacy attestation and actual downstream integration remain external | 2 |
| M04 | Medical Record Library, Metadata, Search, Categories & Record Deletion | 14 | 11 | 3 | 0 | 0 | 0 | 89.3% | Patient backend qualified; CFG-12/18 legal retention and M09 current doctor-grant queries remain open | 3; owner review before subsequent work |
| M05 | OCR, Text Extraction, Structured Content & Processing Orchestration | 10 | 9 | 1 | 0 | 0 | 0 | 95% | Python OCR/backend contract qualified; actual M07/M08 instruction isolation and live runtime/clinical quality remain open | 3; owner review before subsequent work |
| M06 | Medical Timeline & Longitudinal History | 8 | 5 | 3 | 0 | 0 | 0 | 81.3% | Patient backend qualified; current doctor-grant identity/revocation/expiry integration requires M09 | 3; owner review before subsequent work |
| M07 | AI Report & Longitudinal History Summaries | 11 | 3 | 5 | 2 | 1 | 0 | 50% | Bounded synthetic report/history backend qualified; general source coverage, CFG-01/10, actual model and M09 doctor access remain open | 4; owner review before later work |
| M08 | RAG Retrieval, Source Citations, Agentic Orchestration & AI Safety | 22 | 0 | 3 | 17 | 2 | 0 | 7% | M05/M07; CFG-01/02/10; required frameworks | 5 |
| M09 | Doctor Sharing: QR, Unique Link, Email OTP, Grants, Download & Revocation | 19 | 1 | 5 | 12 | 1 | 0 | 18% | M01/M04; email; CFG-04/05; doctor RAG extension | 6 |
| M10 | Guardian Digest, Email Delivery & Serious-Finding Alerts | 14 | 0 | 2 | 10 | 2 | 0 | 7% | M02/M05/M07; CFG-06/07/11/15 | 7 |
| M11 | Patient React Native Mobile Application | 11 | 1 | 0 | 10 | 0 | 0 | 9% | Stable patient APIs; account/record privacy flows | 8 |
| M12 | Doctor React + Vite Web Application | 10 | 1 | 0 | 9 | 0 | 0 | 10% | M09/M06/M07/M08; current-grant contracts | 8 |
| M13 | Admin Dashboard, RBAC, Operational Control & Audit | 22 | 0 | 0 | 21 | 1 | 0 | 0% | Separate privileged identity; CFG-17; append-only audit/config; operational APIs | 1 contract;9 implementation |
| M14 | Backend APIs, PostgreSQL Data Model & Cross-Service Integration | 11 | 0 | 9 | 0 | 1 | 1 | 41% | Shared identity/data/service ownership and Python boundary | 1 onward |
| M15 | Security, Privacy, Retention, Account Deletion & Abuse Controls | 12 | 1 | 4 | 6 | 1 | 0 | 25% | Cross-actor denial; CFG-12/16/17/18; privacy lifecycle | continuous;10 final hardening |
| M16 | AWS Deployment, Private S3/RDS, Networking, Secrets, Monitoring, Backup & Recovery | 10 | 0 | 5 | 1 | 3 | 1 | 25% | Chosen topology/runtime; CFG-08/09 | 11 |
| M17 | Quality Engineering, AI Evaluation, Performance, Accessibility, Usability & E2E Acceptance | 11 | 0 | 5 | 3 | 1 | 2 | 23% | Implemented workflows; CFG-10; full AT/V evidence | continuous;12 final |
| M18 | Configuration Governance, Clinical Approval, Traceability & FYP Handover | 11 | 2 | 3 | 0 | 6 | 0 | 32% | Active new-baseline tracker/checker; approval owners/evidence | continuous;13 handover |

Totals: **66 IMPLEMENTED / 50 PARTIAL / 91 MISSING / 19 BLOCKED / 6 NEEDS_REVERIFICATION = 232**. Entry totals were 63/51/93/19/6. M07 weighted control estimate is 50%; overall weighted control estimate is 39.2%. These are control counts, not implementation effort or release readiness. Supporting M14/M15/M18 and M05-009 statuses were not automatically promoted by this limited work.

**STOP for owner review. Phase 5 has not started and is not automatically authorized.** Full M07 acceptance remains open; the owner must review the limited offline capability and remaining provider/quality/coverage gaps before deciding whether to close those gaps or authorize a separately bounded next phase. No production or clinical readiness claim is made.

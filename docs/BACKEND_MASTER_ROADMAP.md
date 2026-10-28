# Backend master roadmap — B00 baseline

Audit date: **2026-10-23 (Asia/Karachi)**. Source: complete SRS v3, SHA-256 `e401b0aaa64f0a8ef4f393eb1a8f41dd8b029c7166728b34aa6c2e478c19c591`. Read [the requirement ledger](SRS_REQUIREMENTS_TRACEABILITY.md) and [current implementation status](PROJECT_IMPLEMENTATION_STATUS.md) together with this plan.

## Goal and completion rules

Deliver every applicable SRS requirement in an integrated application: patient React Native app; doctor React/Vite guest access; Node/Express; PostgreSQL/RDS; private S3; extraction; actual report/history summaries; patient-grounded RAG; QR **and** link + doctor email OTP; authorized guardian report-copy/summary mail **and separate** serious alerts. No requirement is dropped to fit current hardware or an isolated test milestone.

The ledger has 44 primary source-ID requirements (36 FR, 8 NFR), 88 supplemental clause rows, 12 DEC, 14 CFG and all 8 UC/14 AT/24 V mappings. Engineering status is not release status: 11 backend/process implemented, 14 partial, 19 missing; **zero release-complete**. Existing APIs/workers/contracts are to be reused, not rebuilt without a reason. Tables, injected fakes and Python supervision probes never substitute for implemented workflows or actual application-level integration.

The prior proposed B01–B16 list was not found locally, so these **B01–B21** phases are the explicit source-derived revision. They are sequential delivery gates; early clinical/privacy/architecture decisions are collected in B01 to avoid a late surprise, while implementation follows the dependencies below. Frontend delivery is a named coordinated workstream, not a silent backend exclusion.

## Phase index

| Phase | Objective | Source IDs / obligation groups | Depends on |
| --- | --- | --- | --- |
| B01 | Reproducible baseline and controlled-decision register | All FR/NFR; DEC-01–12; CFG-01–14; TRK-12-02; TRK-18-01 | B00; owner review |
| B02 | Finish and qualify patient identity/document contracts | FR-001–010; NFR-01/02/07; CFG-03/12 | B01 |
| B03 | Controlled operational OCR and processing-service integration | FR-004/010–012; NFR-01/06/07/08; DEC-07/08; CFG-08 | B02; operational identity/deployment approvals |
| B04 | Trusted clinical fact catalogue and categorization integration | FR-007/012/015/023; NFR-04/07 | B03; approved clinical information policy |
| B05 | Approved model/provider evaluation and configuration | FR-015/023; NFR-02/04; DEC-03; CFG-01/10 | B04; privacy/model/spending and clinical-review gates |
| B06 | Integrate actual per-report summary generation | FR-015/021/036; NFR-01/04/08 | B05; explicit DB migration/runtime approval |
| B07 | Patient medical timeline and date provenance | FR-006/013/014; NFR-03; TRK-14.2-04 | B06 |
| B08 | Longitudinal history summaries | FR-014/016/022/023/036; NFR-03/04 | B07; multi-source/clinical contract review |
| B09 | Measured patient-scoped chunking, embeddings and vector index | FR-012/018–020; NFR-01/04; DEC-01; CFG-02 | B08; embedding/index/data-retention decision |
| B10 | Patient record Q&A and natural-language document retrieval | FR-017–020/023; NFR-01/04 | B09; approved model/privacy/safety targets |
| B11 | LangGraph orchestration and non-diagnostic symptom guidance | FR-021/023/024; NFR-04/08; DEC-03/06 | B10; clinical safety and framework/version review |
| B12 | Authorized guardian contacts and shared email delivery foundation | FR-028/031–033; NFR-01/02; CFG-04/11/12 | B11; legal/privacy/email service choices |
| B13 | Patient-selected sharing grants, QR and unique links | FR-025–027/030; NFR-01; DEC-04/09/10; CFG-05 | B12; expiry/session/revocation semantics approved |
| B14 | Doctor email OTP, guest sessions and authorized content APIs | FR-014/022/025/028/029; NFR-01/04; CFG-04/05 | B13 |
| B15 | Routine guardian report-copy and summary delivery | FR-031/033; NFR-01/04; DEC-05; CFG-11 | B14 |
| B16 | Clinically reviewed serious-finding rules and separate alerts | FR-032/033/023; NFR-04; DEC-11; CFG-06/07 | B15; qualified clinical rule/wording approval |
| B17 | Whole-record lifecycle, recovery and operational observability | FR-004–012/015/020/021/031–033; NFR-01/05/07 | B16 |
| B18 | Backend-client delivery and mandatory mobile/doctor-web implementation | FR-001–036 as role-appropriate; NFR-03/08; DEC-02/09; CFG-13 | B17; frontend review/implementation approvals |
| B19 | Security, privacy, clinical quality, performance and usability qualification | All FR/NFR; DEC-12; CFG-01–12 | B18; independent clinical/security/privacy reviewers |
| B20 | Reproducible AWS deployment and operational controls | NFR-01/06/08; DEC-01/08; CFG-08/09; TRK-10.2 | B19; explicit infrastructure, billing, migration and activation approvals |
| B21 | Final SRS acceptance, recovery drills and release handover | FR-001–036; NFR-01–08; AT-01–14; V-01–24; all DEC/CFG/TRK | B20; release acceptance approvals |

## Cross-phase safeguards and release bars

- Preserve existing originals, records, migration history and protected evidence. Keep 0001–0004 immutable; future schema changes require a reviewed forward migration and separate environment/mutation authorization. Never backfill or activate historical jobs merely because pending.
- Keep all processing/model execution disabled until an explicit scoped activation gate. Offline implementation, disposable mutation testing, read-only preflight, live synthetic writes, service activation, cloud provisioning/spending and cleanup are separate permissions. B00 performs none of those operations.
- Reuse patient scope, fixed cutoff, source fingerprints, random attempt tokens, database-clock leases, transactional publication, bounded resources and exact-ownership cleanup. No generic/unscoped worker or default credential/provider fallback.
- Current zero external spending and no real patient data remain in force. Hosted-service deployment/model/email/AWS costs and identifiable medical data require explicit future authorization, privacy review and clinical/security gates.
- Match every change to primary IDs and TRK subclauses; record code/tests/model/config/migration versions and reproducible receipts. Run relevant offline regressions and separately authorized disposable PostgreSQL tests before controlled integration. Never add historical test totals across phases as a current full-system pass.
- Resolve configurable limits, performance/availability/quality/accessibility targets and RPO/RTO before the measurements they govern. Values marked TBD by the SRS are decisions, not license to invent numbers.
- No appointment booking, payments, hospital/EHR integration, autonomous diagnosis, prescribing, medication reminders, patient-doctor chat, guardian portal, permanent doctor accounts or new admin product features without scope approval.

## Detailed phases

### B01 — Reproducible baseline and controlled-decision register

**Objective:** Reproducible baseline and controlled-decision register.

**SRS requirements:** All FR/NFR; DEC-01–12; CFG-01–14; TRK-12-02; TRK-18-01. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Existing source, historical isolated harnesses, protected receipts and this audit.

**Missing implementation:** Reconcile exact source/evidence/test inventory; document missing 3A.5D files; resolve architecture, URL/revocation and complete-processing semantics; assign clinical/privacy/operations owners; define acceptance targets early. Do not enable services.

**Dependencies:** B00; owner review.

**Deliverables:** Approved decision/architecture log, pinned source/test manifest, documented offline and disposable test commands with no .env leakage, current exclusion/release gates.

**Testing:** Artifact/pin checks, disabled-entry and fake regressions; disposable test plan only until separately authorized.

**Definition of Done:** All gaps assigned; no unapproved scope subtraction; clear independent mutation/live/spend approvals; repeatable baseline. Immediate next stage is B01, not tokenization or a live canary.

### B02 — Finish and qualify patient identity/document contracts

**Objective:** Finish and qualify patient identity/document contracts.

**SRS requirements:** FR-001–010; NFR-01/02/07; CFG-03/12. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Auth, validation, scoped SQL, private S3, list/edit/download, date/category fields.

**Missing implementation:** Close API/format/error/retry contract gaps; decide categorization assignment semantics without inventing ML; reconcile signed bearer URLs with §14.1 and design authenticated file delivery if required; retain compensation and owner isolation. Do not invent password reset/delete features.

**Dependencies:** B01.

**Deliverables:** Versioned patient/document/file-access contracts, approved quotas and security decisions, additive fixes if approved.

**Testing:** Auth/foreign/unknown/rate-limit/upload/date/category/pagination/cancellation/compensation tests in disposable DB and fake S3; staged exact-resource integration later.

**Definition of Done:** Core contracts implement SRS subclauses; public projections reveal no storage references; file-authorization ambiguity resolved; no existing originals lost.

### B03 — Controlled operational OCR and processing-service integration

**Objective:** Controlled operational OCR and processing-service integration.

**SRS requirements:** FR-004/010–012; NFR-01/06/07/08; DEC-07/08; CFG-08. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Leases/fencing, original access, PDF.js/Tesseract, scoped cutoff SQL, coordinator, A/B/C safety, system adapters and file credential interfaces.

**Missing implementation:** Provide reviewed real system-manager composition/artifacts/identity/credential delivery; prove actual application child containment, owner loss, restart/cancel/recovery; resolve Node OCR vs SRS Python architecture explicitly. Retain disabled defaults and no historical admissions.

**Dependencies:** B02; operational identity/deployment approvals.

**Deliverables:** Controlled operator lifecycle, trusted artifacts/receipts, scoped canary procedure, patient-visible failed/retry contract.

**Testing:** Fake/unit + disposable concurrent/lease tests; then separately approved synthetic application canary, controller loss, bounded resource/cleanup verification.

**Definition of Done:** Actual worker (not Python probe) safely processes only approved inputs; retry/recovery/resource/shutdown tests pass; any activation has separate permission and rollback.

### B04 — Trusted clinical fact catalogue and categorization integration

**Objective:** Trusted clinical fact catalogue and categorization integration.

**SRS requirements:** FR-007/012/015/023; NFR-04/07. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Immutable extraction snapshots, exact byte-offset/decimal/unit/evidence contracts.

**Missing implementation:** Build server-owned catalogue from current extracted text without using candidate/gold output as authority; preserve ambiguous digits, negation, printed ranges/flags and conflicts; define missing/unsupported-document behavior and category assignment.

**Dependencies:** B03; approved clinical information policy.

**Deliverables:** Versioned catalogue builder with source/attempt binding and independent synthetic gold fixtures.

**Testing:** Unicode offsets, unit/decimal/operator fidelity, contradictions, injection, omission, ambiguous/missing units, source replacement and patient-scope tests.

**Definition of Done:** Real extracted synthetic text can supply a trustworthy reviewed catalogue; no invented finding/range/diagnosis; classifier behavior explicit and bounded.

### B05 — Approved model/provider evaluation and configuration

**Objective:** Approved model/provider evaluation and configuration.

**SRS requirements:** FR-015/023; NFR-02/04; DEC-03; CFG-01/10. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Frozen 12-case benchmark, 42-expectation scorer, fake provider, offline Ollama adapter.

**Missing implementation:** Complete local readiness only if approved, including real tokenizer/rendering/isolation evidence; benchmark after distinct approval. Qualify the approved zero-paid-API/local-inference development direction and explicitly resolve its conflict with DEC-03 through formal SRS change control. No hosted inference or fallback is authorized. Do not treat local benchmark approval as hosted-baseline replacement.

**Dependencies:** B04; privacy/model/spending and clinical-review gates.

**Deliverables:** Pinned provider/model/version/prompt/config, benchmark receipts, clinical glossary/gold review and failure policy.

**Testing:** Frozen cases unchanged; numerical/negation/omission/grounding/injection/privacy tests; exact token and resource/cost accounting; separate real-provider execution approval.

**Definition of Done:** A model satisfies approved measured safety/quality limits or remains blocked; zero tolerance for unsupported numbers/diagnoses/treatment/leakage; local success alone is not clinical validation.

### B06 — Integrate actual per-report summary generation

**Objective:** Integrate actual per-report summary generation.

**SRS requirements:** FR-015/021/036; NFR-01/04/08. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** 0004 snapshots/jobs, summary repository/APIs/executor, FastAPI factory, Node client contract.

**Missing implementation:** Add reviewed bounded real internal HTTP transport/runtime composition, server catalogue and trusted provider recipe; align deadlines and provenance without changing fake defaults; safely stage 0004 application only after schema/deployment review.

**Dependencies:** B05; explicit DB migration/runtime approval.

**Deliverables:** End-to-end report-summary path, source-aware status/retrieval, authenticated internal service, controlled execution entry.

**Testing:** Disposable DB/ASGI/transport tests; heartbeat expiry/stale attempt/source changes/duplicate requests/provider failures; approved synthetic full path.

**Definition of Done:** Actual source→catalogue→model→grounding→atomic publication works; no open DB transaction during model call; old accepted summaries survive failed attempts; failures actionable.

### B07 — Patient medical timeline and date provenance

**Objective:** Patient medical timeline and date provenance.

**SRS requirements:** FR-006/013/014; NFR-03; TRK-14.2-04. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Document/upload dates, sort_date and sort_date_source, timeline SQL index.

**Missing implementation:** Define timeline API/events derived from records, deterministic ties and explicit fallback; no invented clinical events; make scoped query reusable by doctor grants.

**Dependencies:** B06.

**Deliverables:** Patient timeline contract/query plus doctor-safe projection; date/uncertainty semantics.

**Testing:** Mixed known/missing dates, timezone boundaries, edit/reprocessing/pagination/foreign-user tests.

**Definition of Done:** Chronology demonstrably uses document dates when known, labels upload fallback, preserves upload facts and includes only allowed records.

### B08 — Longitudinal history summaries

**Objective:** Longitudinal history summaries.

**SRS requirements:** FR-014/016/022/023/036; NFR-03/04. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Per-report grounding, timeline and immutable snapshot patterns.

**Missing implementation:** Add multi-document/versioned input/output/jobs/storage/invalidations and bounded history generation; explicitly bind all source identities, temporal contradictions and access scope; existing one-report table is insufficient.

**Dependencies:** B07; multi-source/clinical contract review.

**Deliverables:** History-summary APIs/data design and forward-only migration proposal if needed.

**Testing:** Multi-source temporal conflicts, missing dates, duplicate measurements, source replacement, changed grant scope, stale attempt, oversize and clinical omission tests.

**Definition of Done:** Understandable dated history summary grounded solely in permitted current snapshots; insufficient information declared; no fabricated continuity or clinical conclusions.

### B09 — Measured patient-scoped chunking, embeddings and vector index

**Objective:** Measured patient-scoped chunking, embeddings and vector index.

**SRS requirements:** FR-012/018–020; NFR-01/04; DEC-01; CFG-02. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Extracted text and placeholder chunk table.

**Missing implementation:** Implement stable chunk offsets/versions and embedding jobs; measure approved model/dimensions/index feasibility; add pgvector only after measured approval, or approve justified alternative; no raw model installation equals readiness.

**Dependencies:** B08; embedding/index/data-retention decision.

**Deliverables:** Chunk/embed/index pipeline and versioned source linkage, migration/index proposal, reproducible retrieval benchmarks.

**Testing:** Patient-constraint queries, recall/relevance, dimensions, index/version/source invalidation, concurrency/recovery and bounded resource tests.

**Definition of Done:** Chunks/vectors searchable only within live authorization scope; quality and latency targets measured; original preserved on index failure; no historical backfill without approval.

### B10 — Patient record Q&A and natural-language document retrieval

**Objective:** Patient record Q&A and natural-language document retrieval.

**SRS requirements:** FR-017–020/023; NFR-01/04. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** B09 index, patient auth, summary validation/safety.

**Missing implementation:** Add bounded query endpoints, LangChain retrieval, evidence-grounded answer schema, no-evidence/insufficient answer behavior, citations and query-time owner checks; metadata search is not semantic search.

**Dependencies:** B09; approved model/privacy/safety targets.

**Deliverables:** Patient Q&A and natural-language document retrieval services/contracts.

**Testing:** Present/absent facts, cross-patient leakage, prompt injection in chunks, contradictory reports, fabricated citations, revoked data, resource/cancel tests.

**Definition of Done:** Only permitted current source content reaches the model; answers distinguish recorded facts/general education and transparently state insufficient support.

### B11 — LangGraph orchestration and non-diagnostic symptom guidance

**Objective:** LangGraph orchestration and non-diagnostic symptom guidance.

**SRS requirements:** FR-021/023/024; NFR-04/08; DEC-03/06. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Typed source/summary/query ports and deterministic bounded workflow.

**Missing implementation:** Implement explicit LangGraph nodes and LangChain integration with bounded tools, state and cancellation; general symptom education/consultation guidance with approved wording and safety escalation; no diagnosis/prescribing.

**Dependencies:** B10; clinical safety and framework/version review.

**Deliverables:** Scoped graph/tool contracts, privacy-safe telemetry and safe response schemas.

**Testing:** Tool authorization, recursion/step/token/deadline limits, injection, no-record/uncertainty, emergency wording, non-cooperative cancellation and negative diagnostic prompts.

**Definition of Done:** Required orchestration actually used and testable; no broad agent access, persistent medical-text checkpoint or invented visit interval.

### B12 — Authorized guardian contacts and shared email delivery foundation

**Objective:** Authorized guardian contacts and shared email delivery foundation.

**SRS requirements:** FR-028/031–033; NFR-01/02; CFG-04/11/12. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Guardian/contact/event/OTP schema.

**Missing implementation:** Implement patient-owned guardian authorization/consent setup and revocation; private email adapter, durable outbox/dedup/retry/delivery state; doctor OTP email transport; no guardian portal or arbitrary third-party sends.

**Dependencies:** B11; legal/privacy/email service choices.

**Deliverables:** Consent/contact API, email/outbox contracts and forward migrations only as approved.

**Testing:** Wrong-patient/recipient, revoked consent, transaction rollback, ambiguity/duplicate delivery, provider timeout, redaction and authenticated delivery-event tests.

**Definition of Done:** Only intended authorized recipients eligible; logical sends idempotent, failures visible, raw OTP/token/medical text never logged; real delivery separately approved.

### B13 — Patient-selected sharing grants, QR and unique links

**Objective:** Patient-selected sharing grants, QR and unique links.

**SRS requirements:** FR-025–027/030; NFR-01; DEC-04/09/10; CFG-05. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Grant/document composite ownership schema and patient authentication.

**Missing implementation:** Implement grant create/select/expire/revoke and opaque QR/link presentation tokens; bind doctor email; no content before OTP; immediate current-scope enforcement interface shared by file/query/summary consumers.

**Dependencies:** B12; expiry/session/revocation semantics approved.

**Deliverables:** Authenticated patient sharing APIs, QR/link contracts, audit events without sensitive payloads.

**Testing:** Foreign record selection, guessed/replayed token, scope mutation, expiry/revocation, concurrent grants and no pre-OTP data disclosure.

**Definition of Done:** Both QR and link flows exist; owner consent and selected documents enforced; no permanent doctor/guardian accounts invented.

### B14 — Doctor email OTP, guest sessions and authorized content APIs

**Objective:** Doctor email OTP, guest sessions and authorized content APIs.

**SRS requirements:** FR-014/022/025/028/029; NFR-01/04; CFG-04/05. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** B12 email, B13 grants, existing document/timeline/summary/RAG query ports.

**Missing implementation:** Implement challenge hashing/send/verify, bounds/expiry/replay defense and grant-bound guest sessions; doctor records/search/timeline/summary/RAG/file routes. Revalidate grants at use time and avoid reusable S3 URLs defeating immediate revocation.

**Dependencies:** B13.

**Deliverables:** Doctor OTP/session/access APIs and grant-aware file gateway; selection/expiry/revocation proof.

**Testing:** Invalid/expired/reused OTP, brute force limits, email mismatch, selected A/not B, grant change mid-query, revoke/expire file/summary/vector access.

**Definition of Done:** Doctor sees only currently authorized records after email OTP; revoke/expiry blocks subsequent data operations, not merely dashboard navigation; no default whole-wallet access.

### B15 — Routine guardian report-copy and summary delivery

**Objective:** Routine guardian report-copy and summary delivery.

**SRS requirements:** FR-031/033; NFR-01/04; DEC-05; CFG-11. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** B06 summary completion, B12 contact/outbox/email.

**Missing implementation:** Connect successful report processing to exactly identified report+summary event; enforce current authorized guardian and safe attachment/content limits, failure/retry and reconciliation.

**Dependencies:** B14.

**Deliverables:** Routine guardian workflow/status and synthetic delivery receipts.

**Testing:** Extraction/AI failures must not send success email; consent revoked before dispatch, duplicates, attachment/hash association, bounce/retry and actual controlled synthetic mailbox test.

**Definition of Done:** After successful processing, authorized guardian receives corresponding original copy plus accepted summary; failures observable; no original loss or arbitrary recipient.

### B16 — Clinically reviewed serious-finding rules and separate alerts

**Objective:** Clinically reviewed serious-finding rules and separate alerts.

**SRS requirements:** FR-032/033/023; NFR-04; DEC-11; CFG-06/07. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Printed measurement evidence, serious-evaluation schema and B12/B15 delivery.

**Missing implementation:** Implement versioned reviewed rules with unit/range/context handling, explicit flagged/not-flagged/indeterminate; cautious AI explanation tied to matched evidence; separate alert from routine email. No model-defined thresholds.

**Dependencies:** B15; qualified clinical rule/wording approval.

**Deliverables:** Ruleset governance, evaluation/results, serious-alert workflow and independent synthetic fixtures.

**Testing:** Normal/flagged/missing/ambiguous/conflicting/unsupported units/context, no false reassurance, wrong patient, explanation grounding, dedup and delivery failures.

**Definition of Done:** Reviewed triggers yield separate cautious alert; unclear report is indeterminate, not normal; clinical approval mandatory before real-patient use.

### B17 — Whole-record lifecycle, recovery and operational observability

**Objective:** Whole-record lifecycle, recovery and operational observability.

**SRS requirements:** FR-004–012/015/020/021/031–033; NFR-01/05/07. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** OCR/summary leases, coordinator, failed/retry states, bounded workers and outbox.

**Missing implementation:** Define aggregate vs stage-specific processing completion; coordinate category/index/summary/rules/email dependencies without conflating OCR completion; authorized retries, partial outages, redacted audit/metrics and manual reconciliation.

**Dependencies:** B16.

**Deliverables:** Integrated stage state machine/contracts, recovery/replay/drain procedures and operational dashboards/alerts without PHI.

**Testing:** Crash at every stage boundary, duplicate events, stale workers, source changes, connection loss, partial email/cloud failure and retry exhaustion.

**Definition of Done:** Failed stage never erases original or good prior results; statuses truthful; retries bounded/authorized; no unapproved historical jobs admitted; operational failures visible.

### B18 — Backend-client delivery and mandatory mobile/doctor-web implementation

**Objective:** Backend-client delivery and mandatory mobile/doctor-web implementation.

**SRS requirements:** FR-001–036 as role-appropriate; NFR-03/08; DEC-02/09; CFG-13. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** B02–B17 APIs and schemas.

**Missing implementation:** Publish consistent versioned contracts/errors and supported client flows. In the coordinated frontend workstream, build the currently empty React Native patient app and React/Vite doctor web. Backend-only delivery cannot close these FRs.

**Dependencies:** B17; frontend review/implementation approvals.

**Deliverables:** Patient app and guest doctor web, auth/session handling, uploads/status/files/filters, timeline/summaries/Q&A, QR/link/OTP, guardian controls.

**Testing:** Contract/client/API tests; authorized end-to-end flows on target devices/browsers; accessibility, readable uncertainty/citations and clear failure UX.

**Definition of Done:** FR-034/035/036 and every role-dependent UI obligation actually delivered; patient web only after CFG-13 approval; no doctor permanent account or guardian portal.

### B19 — Security, privacy, clinical quality, performance and usability qualification

**Objective:** Security, privacy, clinical quality, performance and usability qualification.

**SRS requirements:** All FR/NFR; DEC-12; CFG-01–12. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Existing negative tests, quotas, evidence pins and all integrated workflows.

**Missing implementation:** Complete threat model/access review, retention/deletion/legal policy, provider/privacy/location review, clinical gold/rules review, accessibility/usability and measurable performance/availability targets. Review DB least privilege/application scope and native isolation.

**Dependencies:** B18; independent clinical/security/privacy reviewers.

**Deliverables:** Qualification reports, approved thresholds/policies, resolved defect/risk register and deployment test plan.

**Testing:** V-01–19/22/24, fuzz/abuse, no-leak logs, load and resource exhaustion, grant/file revocation and grounded-model evaluations.

**Definition of Done:** Approved measurable targets pass with evidence; critical risks resolved; no synthetic score marketed as clinical validation; configuration decisions signed/date-bound.

### B20 — Reproducible AWS deployment and operational controls

**Objective:** Reproducible AWS deployment and operational controls.

**SRS requirements:** NFR-01/06/08; DEC-01/08; CFG-08/09; TRK-10.2. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** Private S3 adapter, local role/migration tooling, separated services and reviewed supervision.

**Missing implementation:** Implement reviewed IaC/compute/network topology, private RDS PostgreSQL, approved vector/email/AI connectivity, HTTPS, least-privilege identities, secrets injection/rotation, backups/monitoring/incident/runbooks; adapt locally restricted migration tooling safely.

**Dependencies:** B19; explicit infrastructure, billing, migration and activation approvals.

**Deliverables:** Staged deployed application/client/service artifacts, operational ownership, backup and rollback configuration.

**Testing:** Deployment security/connection/secret tests, least privilege, monitoring, isolated restore and outage drills; no current audit authorization to provision.

**Definition of Done:** Actual approved AWS integration verified, secrets/records private, restores measurable; personal development bucket alone is not production readiness.

### B21 — Final SRS acceptance, recovery drills and release handover

**Objective:** Final SRS acceptance, recovery drills and release handover.

**SRS requirements:** FR-001–036; NFR-01–08; AT-01–14; V-01–24; all DEC/CFG/TRK. All associated ledger TRK/AT/V rows are part of this scope; B21 verifies the full set.

**Existing reusable functionality:** All previous phases and traceability ledger.

**Missing implementation:** Execute complete client→API→S3→OCR→AI/RAG→sharing→guardian synthetic/de-identified flows and negative paths; validate restored system, load/usability, docs, incident ownership and final source coverage.

**Dependencies:** B20; release acceptance approvals.

**Deliverables:** Reproducible per-requirement evidence bundle, complete traceability, rollout/rollback and signed release record.

**Testing:** All AT and V scenarios in real integrated target; security/clinical/privacy/backup/performance signoff; verify no unmapped obligations.

**Definition of Done:** Every applicable source obligation implemented and adequately verified; all controlled parameters resolved or explicitly block release; no false production/clinical-readiness claims.

## Immediate next stage and approval boundary

**B01 has now been explicitly authorized and delivered at offline baseline scope.** See [B01 decisions and baseline](B01_DECISIONS_AND_BASELINE.md) and the validation receipt. Local inference/zero-paid-AI and retention of Node OCR are approved development directions; formal SRS architecture amendments and qualified appointments remain pending. URL/revocation and stage-completion principles are derived from the SRS; downstream contracts remain B02/B14/B17 work. B01 does not itself mean model generation, migration, live registration/upload, background activation or production deployment.

Do not resume interrupted local readiness work, begin B02 or activate processing automatically. Keep the Phase 2.2D retained synthetic resources/evidence and all current application defaults unchanged. Later mutation/live/deployment/cleanup gates remain separate.


## B01 execution addendum — 2026-10-23

B00 content above remains the source-derived plan; this dated addendum records B01,
not completion of later functionality. Deliverables are the [decision register](B01_DECISIONS_AND_BASELINE.md),
`docs/baselines/B01_SOURCE_MANIFEST.json`, `docs/baselines/B01_VALIDATION_RECEIPT.json`
and explicit baseline/snapshot/test utilities under `infrastructure/baseline/`.
Production API/processing/model code, migrations, default flags and the SRS DOCX are unchanged.

The user confirmed formal SRS amendments remain pending and named appointments are
pending for the Clinical Safety, Privacy/Legal and Operations approver roles. Academic
review is not a substitute for those approvals. Offline development may continue;
real-patient/production use remains gated. No original SRS functionality is removed.

B01 scope covers all FR/NFR through a pinned inventory and gap assignments, DEC-01–12,
CFG-01–14 and TRK-12-02/TRK-18-01. The B01 register is the current decision authority;
verbatim SRS quotations in the traceability matrix are preserved. B05 follows local
inference/zero paid AI direction; no hosted provider integration is authorized while
its SRS conflict is unresolved. Existing LangChain/LangGraph commitments remain.

Verification and DoD: see the status addendum and machine-readable validation receipt.
Any dependency-blocked checks must be disclosed, not counted as passed. A repeatable
source baseline does not qualify the actual model/runtime or close clinical/production
gates. All gaps are assigned, preservation/exclusion/approval boundaries are explicit;
formal amendment and independent approval/appointment items remain open.

**B02 recommendation:** eligible for a separate offline contract/qualification approval
with the open gates retained. B02 is not begun here; file-access behavior changes and
any disposable/live mutations require explicit scope/authorization.

B01 executed verification: **876 offline tests passed** (341 Python + 510 TypeScript
+ 25 new baseline tests), contract compatibility/typecheck/build and two disabled
entry checks passed. Disposable PostgreSQL mutation suites were not run or authorized.
Formal SRS amendments and qualified approvals remain pending.


## B02 implementation addendum — 2026-10-23

B02's patient/document backend contract and security correction are documented in
[B02_PATIENT_DOCUMENT_CONTRACTS.md](B02_PATIENT_DOCUMENT_CONTRACTS.md). Existing
auth/profile/upload/filter/edit/S3 compensation was reused. Public file retrieval now
requires an authenticated byte response with a second owner/storage-identity check;
no patient route exposes a presigned storage URL. Read bodies fail closed; file
rate limits, resource bounds and cancellation have synthetic checks. No new migration
or dependency is needed. B02 adds an explicit fake-test command and reuses the
existing disposable PostgreSQL16 harness.

B02 technical DoD: core patient/document contracts qualified at isolated backend
scope; public projections/headers contain no storage references; patient URL
authorization ambiguity resolved; preservation/compensation behavior retained.
Current measured evidence and any blocked checks are in the B02 receipt/status.
CFG-03 release quota approval, CFG-12 privacy/retention approval, mobile and live
file-gateway verification remain open. Doctor grant/in-flight revocation is B14,
not a capability silently added or claimed here. All B01 amendment/role gates remain.

**Next recommendation:** separately approve B03's bounded offline/isolated operational
processing work. B03 has not begun; broad or live activation, S3 writes, model calls
and production deployment are not authorized by this addendum.

Executed B02 qualification: 270 backend tests (269 + 1), 726 total disposable-harness
checks, 876 separately run existing offline regressions, and 24 new contract checks
passed; suites overlap. Contract compatibility/typecheck/build/disabled-entry checks
passed, with exact-resource cleanup verified. No current AWS/live gateway, full
mobile or clinical/production acceptance is implied.


## B03 permitted implementation addendum — 2026-10-23

[B03_CONTROLLED_OCR_INTEGRATION.md](B03_CONTROLLED_OCR_INTEGRATION.md) records the
patient extraction status/retry contract and controlled operator lifecycle. Reused
the existing engines, scheduler, canary SQL, private original reader and fenced
persistence. Added approval-disabled-by-default patient retries, exact SQL cutoff/owner
constraints, bounded idempotency and cancellation-before-claim behavior. New isolated
coverage connects authenticated synthetic uploads to the actual automatic service.

**Full B03 operational DoD remains open.** System-level OS transport/composition,
reviewed immutable artifacts/native dependencies, credential injection and PG/S3
networking require operational decisions and application-level containment/loss/expiry
proof. Existing deny-all networking and supervision controls were not relaxed.
Node OCR is still a development direction with formal SRS amendment pending.
Offline tests and Python probe evidence do not approve production activation.

**Next recommendation:** B04 may be separately approved for offline synthetic fact
catalogue work using verified extraction inputs, retaining B03 operational and
clinical/privacy/release gates. B04 has not begun; no broad/live activation follows.

Actual B03 verification: 680 non-summary disposable checks passed (including 270
backend, 19 new fake and eight new integration checks); 876 existing offline
regressions passed. One existing short-lease summary subtest plus parent failed in
the broad run; a fresh unchanged summary rerun passed 73/73. Typecheck/build/contract
and disabled-entry checks passed; exact cleanup verified. Do not label the broad
run all-green or infer a resolved timing cause. B04's approved clinical-information
policy is an additional explicit prerequisite, not an approval supplied by B03.


## B03.1 short-lease qualification — 2026-10-23, vo18r4sc

**Outcome: BLOCKED (original failure cause unresolved).** See
[B03_1_SHORT_LEASE_QUALIFICATION_20261023_vo18r4sc](B03_1_SHORT_LEASE_QUALIFICATION_20261023_vo18r4sc.md) and `baselines/B03_1_QUALIFICATION_20261023_vo18r4sc.json`.
The unchanged broad run failed 751/753 in retry exhaustion (`busy`, not the
historical short-lease failure). Instrumented summary/broad comparisons passed
73/73 and 753/753. A demonstrated fixed-pause test assumption was corrected by
verified worker drain/database retry eligibility; production executor/jobs remain
unchanged. The original 300/30/650 ms test is retained, not weakened.

Final broad selection passed 755/755 including two new DB checks; offline passed
878 (341 Python, 512 TS, 25 baseline). Contract/typecheck/build/disabled checks
passed. These counts overlap. Real renewals spanned 677.957 ms with a 300 ms lease;
database expiry cancellation, stale/source fencing and no unauthorized publication
passed. All eight owned containers/four volumes/test tags were removed; five
pre-existing container states/start-stop timestamps were preserved.

Passing comparisons do not explain the original B03 lease-lost event. No
unconditional B03.1 completion, production readiness, primary requirement upgrade
or full application E2E claim is made. Historical receipts/SRS/PRD/migrations are
preserved. Full B03 operational DoD remains OPEN; B04 has not begun. Next is
evidence review and separately approved narrowly bounded diagnostic continuation,
not automatic later-phase development.


## B03.2 historical short-lease diagnostics — 2026-10-23, akm0ts7

**BLOCKED: contradictory relevant failures remain unexplained.** See
[B03_2_HISTORICAL_SHORT_LEASE_DIAGNOSTICS_20261023_akm0ts7](B03_2_HISTORICAL_SHORT_LEASE_DIAGNOSTICS_20261023_akm0ts7.md) and `baselines/B03_2_DIAGNOSTIC_QUALIFICATION_20261023_akm0ts7.json`.
The pre-pinned budget was four disposable environments/six original 300/30/650 ms
observations; it was not increased. All six original observations passed. A counted
4/4 (three cases plus parent); B summary failed 73/75 in the existing committed-
renewal test (lease-lost); C broad failed 753/755 in transient retry (idle instead
of completed); final D uninstrumented broad passed 755/755. Each failure plus its
parent is retained. No cause is invented and final success does not erase B/C.

Five instrumented originals recorded 11–19 committed renewals, minimum statement-
time DB margin 235.468 ms and maximum event-loop delay 27.394 ms. A C-only passive
measurement addendum examined the already-selected gated test without increasing
run counts or changing timings/predicates/assertions; it passed and did not explain B.
Expiry/cancellation/stale-source/token/publication-rollback/admission checks passed
in B/C/D. Offline passed 878 (341 Python/512 TS/25 baseline); contracts/typecheck/
build/disabled checks passed. Counts overlap; B/C did not reach later build checks.

No permanent code/test/harness/migration/dependency changes. Final tested source
is original/uninstrumented. Eight owned containers, four volumes, all owned test
image tags/cache tag removed; five pre-existing states/timestamps preserved.
Private indexed evidence is Git-excluded. B03.1 remains BLOCKED as historically
recorded; full B03 operational DoD remains OPEN. FR/NFR/DEC/PRD statuses unchanged;
no production readiness or feature closure. Next is separately approved targeted
gated-renewal diagnosis; no more tests beyond the budget, activation or B04 here.


## B03.3 combined residual concurrency qualification — 2026-10-23, w6uzcegf

[Detailed report](B03_3_RESIDUAL_CONCURRENCY_20261023_w6uzcegf.md) and
`baselines/B03_3_REGRESSION_QUALIFICATION_20261023_w6uzcegf.json` record
**B03.3 PASS on the defensible test-contract qualification path**; regression/lease
safety is **PROPOSED CLOSED for review**, full B03 operational DoD remains **OPEN**.
The gated observer could suppress subsequent heartbeat dispatch while it awaited
observation I/O; a controlled real-DB expiry proves correct cancellation/no publication.
A due locked retry correctly returns idle and the same executor completes once after
lock release. Tests now keep observer I/O off the heartbeat path and explicitly
verify prior drain and DB-clock due state before a single retry. Production code,
lease values/predicates/fencing, original 300/30/650 case, migrations and defaults unchanged.
**Exact old failed schedules are not reconstructed or causally attributed**; controlled
mechanisms establish invalid test assumptions, not proof of historical lock/query timing.
Historical original anomaly and B03.2 missing timings remain residual uncertainty;
old BLOCKED receipts/evidence are unchanged. No new unexplained failure occurred.

Characterization 3/3, focused 16/16, single final broad 758/758,
offline 878 (25 baseline + 341 Python + 512 TS); contracts/typecheck/build/both disabled
entries passed. Initial offline tsx IPC denial occurred before TS tests started; only
unstarted checks resumed with permission, retaining the failed receipt. Counts overlap; no unique grand total asserted. Six owned containers,
three volumes and three test tags cleaned; owned cache tag removed after identity proof;
five pre-existing container states/start-stop times preserved. Private hash-indexed
evidence 0700/0600/Git-excluded. No feature/primary requirement or module promotion.

Actual system-manager OS composition, artifact/service identity deployment, credential/
network delivery and application containment/controller-loss/runtime-expiry qualification
remain open. Recommended next: separately approve B03.4 operational delivery design
gate; no implementation/activation or B04 authorization is inferred. No AWS, existing
DB, model, systemd, package install, SRS/PRD amendment, activation or commit/push.


## B03.4 operational delivery — finalized 2026-10-24, run w_f16tm8 (started 2026-10-23)

[Report](B03_4_OPERATIONAL_DELIVERY_20261023_w_f16tm8.md) and
`baselines/B03_4_OPERATIONAL_QUALIFICATION_20261023_w_f16tm8.json` record
**B03.4 PASS for local/offline/disposable scope**. User acceptance of B03.3 is
recorded as regression/lease safety **CLOSED**; B03 operational implementation
**PARTIAL**, deployment/runtime qualification **OPEN**. No full B03 completion.

Added a disabled standalone operational entry, explicitly selected artifact path,
pinned runtime/config/run/credential authority, current worker/controller/self
identity checks, default-deny network intent requiring fresh enforcement evidence,
file-derived PG/S3 resource factory and existing scheduler composition. Explicit
operational transactions roll back on observed loss before COMMIT and recheck
original DB lease/deadline after authority observation. Existing worker/OCR/SQL
cutoff/fencing implementation and user-manager/developer defaults are retained.
Default command remains disabled; enabled command without trusted composition
refuses. API startup is unchanged. No default live OS/network/preflight transport.

46 new fake cases; final focused DB 6/6; one broad 810/810; one offline
924 (25 baseline + 341 Python + 558 TS); contracts/typecheck/build and compiled
disabled/refusal checks passed. Initial focused setup failed before scenarios
(PG username absent because synthetic env load followed the DB marker check);
corrected isolated order passed and failed evidence is retained. Counts overlap.
Eight owned containers / four volumes / test tags cleaned; owned cache tag removed after
identity proof; five pre-existing container states/times preserved. Hash-indexed
private evidence 0700/0600/Git-excluded; old B01–B03.3 evidence unchanged.

Nine deployment gates remain partial/missing; current PrivateNetwork + deny-all
address families still prevents PG/S3 and loopback health. Real artifact/native
graph, credential delivery/issuer expiry, enforced networking and actual application
containment/controller-loss/runtime-expiry/recovery proof require separate approval.
Intent/fake enforcement is not OS proof; in-flight COMMIT cannot be retroactively
undone. No product/primary SRS or PRD completion status is upgraded. Pending formal
Node OCR/hosted→local amendments and clinical/privacy/operations signoffs remain.
Next recommendation: separately approve B03.5 trusted system-manager transport and
deployment-policy closure; no B04, live/cloud/existing DB/model/systemd activation,
packages, migration edits or commit/push.


## Module-by-module review policy — 2026-10-24

Owner requests all 16 PRD modules and every feature/control, stopping after each module for review. [PRD_MODULE_DELIVERY_TRACKER](PRD_MODULE_DELIVERY_TRACKER.md) and its source-pinned 127-row ledger are a supplementary checklist, not a replacement roadmap or requirements amendment. Every row retains implementation/verification phases and B21 acceptance; dependency order and separate live/credential/clinical approvals remain intact.

[Module 01 review](MODULE_01_PATIENT_ACCOUNTS.md): existing account/profile backend reused; 16 new synthetic checks plus24 existing B02 regressions pass (40/40), completeness tests18 pass, typecheck/build pass. Entire M01 remains PARTIAL/OPEN: downstream ownership/auth interfaces, recovery/invalidation policy, mobile and final security/deployment acceptance remain open. No next-module implementation, B03.5 or B04 is performed by this review increment. B03.4 operational/runtime gaps remain open as recorded.


## B03.5 trusted delivery — 2026-10-24, yUoBzOMA

[Report](B03_5_TRUSTED_DELIVERY_20261024_yUoBzOMA.md) / `baselines/B03_5_OFFLINE_QUALIFICATION_20261024_yUoBzOMA.json`: **PASS for authorized offline implementation/qualification**. Owner's standing correction supersedes serial module-number reviews: use the central127-entry PRD tracker and dependency roadmap, preserve accepted Module01/PARTIAL, stop after each approved phase. No arbitrary Module02 or B04.

Added read-only Linux system observation, immutable artifact checks, nonce-bound exact-control client/reconciliation, explicit existing-worker composition, private receipt health, credential headroom/drain checks and inactive deployment/rollback/network-policy artifacts. **1000 final broad offline checks pass (25 baseline+341 Python+634 TypeScript),23 completeness checks pass; contracts/typecheck/build/disabled entries pass.** A post-broad numeric-SIGTERM normalization matches the existing adapter; one targeted new case and final typecheck/build pass without rerunning the broad suite.77 distinct new B03.5 cases across broad/focused+targeted evidence. Descriptor0664 refusal corrected only by restoring the owned private test copy to0600; protections unchanged.

Actual privileged broker/server/channel, dynamic credential bootstrap/issuer lifecycle, complete real immutable graph, enforceable inherited-descriptor network delivery, actual controller/worker/native containment/loss/expiry and deployed runtime remain open. Templates are deliberately inactive/non-installable and network intent is not enforcement. No fresh PostgreSQL suite: SQL/migrations/lease engines unchanged; B03.4 disposable evidence preserved. No AWS/current DB/model/credentials/systemd operations, host changes, activation, install, migration changes, commit/push/merge or Gate3 cleanup.

B03 regression/lease safety **CLOSED**; operational implementation **PARTIAL**; deployment/runtime qualification **OPEN**. All127 entries remain, primary requirements/code-status labels unchanged and no release-completion promotion. Current tracker records explicit delivery states and final acceptance separately. Next is review/approval of concrete broker/bootstrap/graph/relay decisions and scoped remaining offline implementation; no live execution or B04 permission inferred.


## B03.6 trusted-delivery implementation closure — 2026-10-24

[Report](B03_6_TRUSTED_DELIVERY_CLOSURE_20261024_Ea1lzg2d.md) / `baselines/B03_6_OFFLINE_QUALIFICATION_20261024_Ea1lzg2d.json`. New opt-in broker server, authenticated Unix capability channel, durable nonce journal/atomic bounded slots, invocation-bound credential lifecycle/protected synthetic staging, pinned runtime-graph validation/ELF inventory helpers, endpoint enforcement and trusted existing-worker composition. Offline checks only; processing stays disabled.

**Overall closure BLOCKED; implementation PARTIAL.** Native system-manager exclusive compare/control semantics require an Operations-reviewed authority boundary. Distinct-UID bootstrap, real release/native inventory and PG/SDK descriptor relay remain code/assembly gaps; they are not relabeled as live-only work. No database/lease/engine changes, live operations, source-scope changes, prior evidence replacement or B04. Historical B03.4 disposable810/810 and B03.5 evidence reused, not rerun or promoted to production. All127PRD entries and prior labels remain; Module01 accepted/PARTIAL.

Supports FR-010/011/012, NFR-01/05/06/07/08 and DEC-07/08/12; no whole-requirement completion. Offline component evidence must be read separately from application deployment/clinical/cloud acceptance. Pending local-hosted and Node/Python SRS amendments, named clinical/privacy/operations appointments and original approval gates remain unchanged.

Next recommendation: review the native exclusive-authority/credential/relay design, then separately approve the smallest remaining B03 offline native-adapter closure. Do not begin B04 or seek live activation while these implementation gaps remain.

B03.6 final verification:101 new TS focused cases; one1102-test broad offline run (25 baseline+341 Python+736 TypeScript);23 completeness and7 inventory tests; contracts/typecheck/build/disabled/static checks pass. Full closure remains BLOCKED/PARTIAL; no live acceptance.


## B03.7 native authority and credential transport — 2026-10-24

[Report](B03_7_NATIVE_AUTHORITY_20261024_5uWELmBA.md) / `baselines/B03_7_OFFLINE_QUALIFICATION_20261024_5uWELmBA.json`. Added dormant native libsystemd observation/control, exclusive broker flock+Unit.Ref+fresh comparison, SO_PEERCRED and descriptor handoff, dynamic UID/GID staging, durable issuance/recovery/revocation, private receiver/legacy-parser bridge and explicit native composition. No host system manager, services, credentials, DB/cloud/model access or automatic processing. All existing implementation and prior evidence preserved.

Native library components are qualified offline within the documented trusted-root/exclusive-writer boundary; systemd provides no InvocationID CAS. Installed-root launcher/policy/privilege/grant/inside-refresh assembly and actual platform behavior remain unqualified. Whole trusted delivery/operational/offline deployment readiness remain PARTIAL; live qualification OPEN. Complete release/native graph and PG/S3 descriptor delivery remain actual implementation work outside this phase's primary scope. No B04.

Supports FR-010/011/012; NFR-01/05/06/07/08; DEC-07/08/12 without source-scope amendments or whole-requirement completion. All127PRD entries, previous statuses, earlier evidence and Module01 accepted/PARTIAL preserved. Named clinical/privacy/operations appointments and formal hosted/local / Node/Python amendments remain pending. Next gate must separately approve remaining offline deployment assembly and delivery work, never automatic activation.

B03.7 final evidence: 49 new focused TypeScript checks; one1151-test broad run (25 baseline+341 Python+785 TypeScript);33 native Python qualification tests; one completeness check; contracts/typecheck/build/static/disabled checks pass. Native library contracts qualified offline; whole B03 delivery/operational/deployment readiness remains PARTIAL; no live acceptance.

### B03.7 final targeted supplement — 2026-10-24

Post-start dynamic GID is now bound from native observation with invocation binding inside a 1000ms deadline. One additional targeted test, full typecheck and build passed after the 1,151-test broad run. The two source deltas and both evidence versions are preserved; broad/completeness checks were not repeated. All delivery statuses and approval boundaries remain unchanged.

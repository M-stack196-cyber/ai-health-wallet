# Project implementation status — B00 audit

As of **2026-10-23 (Asia/Karachi)**. Authority: complete SRS v3, SHA-256 `e401b0aaa64f0a8ef4f393eb1a8f41dd8b029c7166728b34aa6c2e478c19c591`. This is a read-only implementation/evidence audit plus the three expressly requested tracking documents, not a fresh test/deployment run.

## Requirement coverage

| Set | Implemented backend/process | Partial | Not implemented | Release-complete | Needs final integrated acceptance |
| --- | --- | --- | --- | --- | --- |
| 36 functional | 8 | 9 | 19 | 0 | 36 |
| 8 non-functional | 3 | 5 | 0 | 0 | 8 |
| 44 primary total | 11 | 14 | 19 | 0 | 44 |

The **88 supplemental TRK clauses** refine these 44, rather than adding independent product features. All 12 DEC, 14 CFG, 8 UC, 14 AT and 24 V controls/flows have explicit mappings. Full details and per-requirement role/backend/frontend/dependency/acceptance/security/evidence are in [SRS_REQUIREMENTS_TRACEABILITY.md](SRS_REQUIREMENTS_TRACEABILITY.md). The sequential [B01–B21 roadmap](BACKEND_MASTER_ROADMAP.md) is the remaining delivery plan.

**Implemented at backend/process scope:** FR-001, FR-002, FR-003, FR-005, FR-006, FR-009, FR-010, FR-011, NFR-02, NFR-05, NFR-07.

**Partially implemented:** FR-004, FR-007, FR-008, FR-012, FR-013, FR-015, FR-021, FR-023, FR-036, NFR-01, NFR-03, NFR-04, NFR-06, NFR-08.

**Not implemented:** FR-014, FR-016, FR-017, FR-018, FR-019, FR-020, FR-022, FR-024, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030, FR-031, FR-032, FR-033, FR-034, FR-035.

No label means production-safe, clinically validated or complete under SRS §10.1. No requirement has complete intended-application end-to-end evidence; the manual synthetic S3/OCR subflow is narrower.

## Implemented foundations and material gaps

| Subsystem | Inspected implementation | Verification level / gap |
| --- | --- | --- |
| Patient identity/profile | Argon2id, JWT claim checks, authenticated own-profile GET/PATCH, limits and validation | Historical auth/disposable integration evidence; no mobile UI or deployed whole-system signoff |
| Documents/private originals | Multipart allowed formats, 5 MiB configurable upload default, parse/integrity checks, S3 owner/privacy/encryption checks, SHA-256, scoped filters/edit and B02 authenticated original-byte delivery | Isolated backend qualification; patient bearer-URL response removed; live gateway/doctor revocation/mobile acceptance still pending |
| Extraction/OCR | Native PDF.js, Tesseract/Poppler scanned/mixed handling, ordered page provenance, source hash and fenced atomic persistence | Strong isolated tests and three historical live cases. Actual implementation is Node-based; source Python allocation needs review |
| Automatic OCR service | Disabled entry, canary patient+fixed-cutoff SQL, coordinator lock, bounded polling/health/shutdown | Stage A/B tests; synthetic supervision passed. Actual system-level worker composition/credentials/deployment remains unverified; no broad activation |
| Summary contracts and service | Python/TS schemas, exact decimal/unit/UTF-8 citations, glossary/uncertainty, bounded private FastAPI factory with constant-time auth | Synthetic fake provider only; no actual deployed provider/model/client network path |
| Summary jobs/APIs/executor | 0004 immutable source snapshots and separate leases/publication; three patient endpoints; disabled fake executor | Historical PostgreSQL16/ASGI/Node tests; no production catalogue builder, real runtime transport or real provider composition; persistent DB migration state NOT inspected |
| Evaluation/local Ollama | 42-expectation synthetic evaluator, frozen 12-case held-out benchmark; explicit loopback/digest/version/schema/thinking/redaction/budget adapter | 3A.5C fake-only tests. No real model benchmark in evidence; actual listener/isolation/tokenizer and live readiness not verified by this audit |
| Categorization/timeline | Supplied validated category and searchable date/hospital; ordered list and fallback label fields/index | No proven automatic classification (not silently mandated); no complete timeline UI/contract or longitudinal summary |
| RAG/embeddings/agents | Chunk/RAG interaction schema and integrity constraints only | No chunker/embedder/vector index/retriever/Q&A; no LangChain/LangGraph dependencies or working tool graph |
| Doctor access | Grant/selected-document/hashed-OTP schema only | No QR/link grant workflow, OTP mail/verify, guest session, doctor APIs or expiry/revocation enforcement |
| Guardian/alerts | Guardian consent, event and serious-result schema only | No guardian management/authorization workflow, email provider/outbox/delivery, reviewed rule engine, cautious explanation or indeterminate workflow |
| Mobile/web | mobile/ and web/ exist but are empty | No React Native or React/Vite application, UI integration, usability/accessibility or frontend E2E |
| Deployment/operations | Local PostgreSQL16 compose on loopback5433, restricted app/migrator role tooling, no-network disposable harnesses; private-S3 runner | Not AWS deployment of API/AI/RDS/vector/email/clients; no retained whole-system restore/load/incident/readiness evidence |

## Historical test/evidence ledger — not a new combined run

Read-only review inspected the relevant source/test files, documents and allowlisted aggregate receipts. No tests were executed in B00 because application inspection is read-only and no isolated mutation/test activation was requested. Test presence alone does not establish a pass. Older totals overlap and must not be summed as distinct current tests.

| Evidence | Recorded result | What it proves / does not prove |
| --- | --- | --- |
| Phase 2.2D Gate 2 retained verification-report.json | passed=true; seven AWS checks true; 3 patients, 3 documents, 3 jobs, 3 extractions, 3 S3 objects; preservation true; cleanup/Gate3 false | Historical synthetic authenticated upload→private S3→scoped manual OCR→persistence subflow. Does NOT prove automatic worker, mobile UI, summaries/RAG/sharing/email, current AWS state or present records |
| Stage B/disposable test documents and isolation harnesses | Original backend baseline 269; Stage B20; Stage C DB11 are historical scoped suites | PostgreSQL claim/lease/cutoff concurrency safety under isolated tests, not current development DB/prod verification |
| Graceful/parent-exit/runtime-expiry retained synthetic probe archives | All three verification passed; cleanup checks processes_gone/cgroup_empty_or_absent/identity_released/unit_unloaded true | Linux/systemd synthetic process supervision only; no claim actual application worker or credential delivery was activated |
| Phase 3A.3 retained verification.json | PostgreSQL16; total_passed1016; cleanup true; development_database_accessed=false; aws_accessed=false; automatic_processing_activated=false | Historical snapshots/jobs/fencing test run, not deployment or provider generation |
| Phase 3A.4 retained verification.json | PostgreSQL16; total_passed1073; cleanup true; development DB/AWS false; summary DB73 in documentation | Synthetic patient APIs and fake executor publication under disposable infrastructure, not configured real API runtime |
| Phase 3A.5A retained verification.json | 42/42 expectations, 259 Python, 505 offline TS; typecheck/build/compatibility/disabled entries true | Fake synthetic evaluation/regressions. 42 expected outcomes includes adversarial rejections, not 42 real-model successes |
| Phase 3A.5B retained verification.json | 295 Python +510 TS=805; 42 expectations; reproducible manifest; live_calls0/databases_accessed0; clinical/privacy reviews pending | Frozen benchmark preparation only; model never evaluated |
| Phase 3A.5C document + current 46-test source + prior approved report | 341 Python +510 TS=851; typecheck/build/contracts pass recorded; 12 fake cases repeated deterministically | Most recent reported offline baseline. No separately archived 3A.5C receipt was found in inspected archive inventory; no fresh 851-test rerun or actual model evidence claimed |

Some older documents are stage-local snapshots: `PHASE_2_2D_CONTROLLED_LIVE_VERIFICATION.md` still states Gate 2 is not executed in its Gate 1 header, while the later retained approved Gate 2 receipt shows success. This ledger records both dates/scopes and uses the later scoped receipt, without editing the historical phase document.

## Interrupted Phase 3A.5D — preservation and uncertainty

Repository inventory contains only the committed-to-workspace 3A.5C adapter modules; there is no `ollama_readiness.py`, `ollama_accounting.py`, 3A.5D test/doc or execution manifest in application source. The earlier interrupted turn described partial drafts at:

- `/tmp/hw-ollama-readiness-stage/ollama_readiness.py`
- `/tmp/hw-ollama-readiness-stage/ollama_accounting.py`
- `/tmp/hw-ollama-readiness-model-metadata.json`

All those paths, their staging directory and `/tmp/hw-ollama-offline-stage` are **absent in the current filesystem**. A bounded read-only `/tmp` search also found no matching drafts. Their disappearance cause is unknown (temporary storage/session change is possible, not established). The audit did not delete, reconstruct, copy over or resume them. They cannot be counted as implemented or reviewed token/isolation code. If another copy exists, recover it only under a later explicit task and compare against retained 3A.5C; do not trust conversational fragments as executable artifacts.

The prior interrupted read-only check reportedly found the pinned Ollama0.31.2/DeepSeek digest and a wildcard listener. This is historical context only: B00 makes **no Ollama requests**, does not query live listener/service status, and does not assert current model/runtime/privacy readiness. The installed `nomic-embed-text` model is likewise not evidence of an embedding pipeline.

## Source/schema preservation and audit limitations

Migration files inspected without application or edits:

| Migration | SHA-256 |
| --- | --- |
| 0001_initial_schema.sql | 88f46310e04975486d5e36808f781510555846b3c8579e119714cafea9cd6eb1 |
| 0002_document_processing_lifecycle.sql | 346328f27cbd719e15b96f79b62a250d9a2643f77e82936ee8654bfe1de822c7 |
| 0003_lease_fenced_extraction.sql | 18045407bf8180e9eeaf1f0c6a89a7be8f92fbaa4b96342240d30991bac461b3 |
| 0004_medical_summary_jobs.sql | f335364603f378c67e3f6466a98f92928280bab361e0922f3dc124a475ec493b |

Migration0004 exists and has disposable-test evidence. Its persistent development/production application state is **unknown**; no database was contacted. Existing S3/records/private evidence were not queried or changed. Current IAM, backups, deployed services, credentials, logs containing real records and network state were intentionally not inspected.

The project appears as untracked top-level source directories in the current Git status; that is not a clean reviewed release commit or evidence of lost code. No commit/push or source cleanup is performed. No prior B01–B16 roadmap file was found; any off-repository plan remains a reconciliation input for B01.

## Blocking decisions and immediate next action

1. Approve/clarify source commitments: hosted vs local model, required LangChain/LangGraph, actual Node/Python OCR allocation, patient web conditional scope and categorization assignment semantics.
2. Resolve URL authorization/immediate file revocation and truthful whole-record completion vs extraction-only status before building clinician/email flows.
3. Assign owners/values/review gates for all CFG parameters, especially clinical rules/glossary/gold, indeterminate wording, guardian consent, privacy/retention, OTP/grants and operational targets.
4. Complete missing catalogue, real model/runtime integration, history/timeline, index/RAG, sharing/OTP, guardian/email/rules and both client applications through B02–B18.
5. Qualify and deploy through B19–B21 with independent clinical/security/privacy/operational acceptance. No current production-readiness claim.

**Immediate recommendation: review these three B00 documents, then separately authorize B01 only.** No B01 work, 3A.5D resumption, model benchmark, service activation, migration, live synthetic writes or Gate3 cleanup is authorized/performed here.


## B01 execution update — 2026-10-23

[B01_DECISIONS_AND_BASELINE.md](B01_DECISIONS_AND_BASELINE.md) is the current
controlled decision/role register. The owner approved local AI inference/zero paid
AI APIs and retention of working Node OCR as development directions, **not formal
SRS amendments**. Those amendments remain pending. No Clinical Safety, Privacy/Legal
or Operations approvers are named yet; qualified accountable roles are assigned with
appointments/approvals pending. Academic review is not production/clinical/legal consent.

B01 adds only baseline/test-snapshot tooling and documentation, including a source/test
manifest and validation receipt under `docs/baselines/`. It preserves API behavior,
processing defaults, all four migrations, the SRS and frozen synthetic fixtures.
Product counts remain 11 implemented at backend/process scope, 14 partial, 19 missing,
zero release-complete. No actual Ollama/model, cloud, database, worker or systemd
operation is part of the B01 test plan.

The prior temporary test venv and interrupted 3A.5D drafts remain unavailable. B01
may reconstruct a test-only environment from already cached pinned packages with
network downloads disabled; it does not reconstruct the lost readiness code. The
receipt records actual dependencies, test counts/blockers, toolchain and source hashes.
Historical counts above are not silently substituted for a fresh run.

B01 DoD assessment:

| Condition | Disposition |
| --- | --- |
| Every identified gap assigned | Yes — existing FR/TRK phase mapping plus named-role accountability/CFG gates; actual reviewer appointments pending. |
| No unapproved scope subtraction | Yes — all source IDs/clients/sharing/email/safety remain; conflicting architecture amendments explicitly open. |
| Independent mutation/live/spend approvals | Yes — baseline/fake checks only; disposable mutations, live writes, generation, deployment and cleanup need separate approval. Paid AI API usage remains disallowed. |
| Repeatable source/test baseline | Implemented; exact execution evidence and any blockers are in B01_VALIDATION_RECEIPT.json. No full-system/clinical qualification claim. |
| Fully approved architecture/stakeholder decisions | No — user explicitly retained formal amendments and qualified appointments/approvals as pending. |

**Not every approval-dependent B01 deliverable is finally approved.** Offline baseline
work is deliverable with these explicit open gates; do not claim unconditional DoD
closure or block unrelated offline design. B02 is recommended only under a separate,
limited offline contract/qualification approval retaining those gates. B02 has not begun.

### B01 executed checks

**876 offline tests passed:** 341 Python, 510 TypeScript and 25 new baseline checks;
zero failures/skips/cancellations. Shared contracts, typecheck, build and disabled OCR/summary
entry checks passed in a credential-free pinned snapshot. No database-backed suite was
run; disposable PostgreSQL is a plan-only gate in B01. The 207 prior inventoried files
were compared; only the three tracking documents changed, with no missing files.
See [the current receipt](baselines/B01_VALIDATION_RECEIPT.json) for exact source/toolchain evidence.


## B02 execution update — 2026-10-23

Current contract is [B02_PATIENT_DOCUMENT_CONTRACTS.md](B02_PATIENT_DOCUMENT_CONTRACTS.md);
actual verification is recorded in `baselines/B02_VALIDATION_RECEIPT.json`.
No SRS, migration, dependency, Stage C supervision/credential module, frozen benchmark
or application processing default is changed. Primary counts remain 11 implemented
at backend/process scope, 14 partial, 19 missing, zero release-complete.

Delivered: authenticated owner-scoped binary originals at the existing download
endpoint, no public S3 URL/signer fallback, pre-delivery owner/storage recheck,
private bounded acquisition/streaming, patient file rate limiting, cancellation and
cleanup; read-body rejection for patient/document GETs; explicit synthetic contract
tests; repeat-upload/one-job semantics tested through the isolated DB harness.
Existing validation, metadata filters, category assignment and compensation reused.

The old `{download_url,expires_in}` JSON response is intentionally retired; clients
must fetch bytes with an Authorization header. Already delivered bytes cannot be
recalled. Future doctor authorization/revocation remains separately required.

B02 backend DoD is assessed only at isolated contract scope. Release quota/retention
approvals, qualified appointments, live S3 delivery, mobile and whole-pipeline
acceptance remain open. No B03, live processing, Ollama, systemd, production DB,
cloud mutation or paid inference is started.

### B02 measured verification

| Scope | Final result |
| --- | --- |
| Existing backend baseline, plus repeated-upload/job test | **270 passed** (previous 269 + 1) |
| Final disposable harness, including backend and B02/regressions | **726 passed**, zero failed/skipped/cancelled |
| Existing Python/TypeScript/baseline-tool offline regressions | **876 passed** (341 + 510 + 25), no dependency blockers |
| New B02 contracts, independently and inside disposable harness | **24 passed** in each environment; overlapping executions |
| Shared contracts / typecheck / production build / disabled entries | Passed; no actual worker/network service activation |
| Disposable cleanup / existing-resource preservation | Exact owned resources absent; five prior containers present and last start/stop transitions before run |

The interrupted preparation attempt is not passed evidence. An intermediate
cancellation test failed because client abort preceded server observation; its
assertion now waits for the actual server close event. Final reruns passed with
the protection/cancellation checks retained. Private diagnostic attempts remain
available; current success is bound to final code via the B02 receipt.


## B03 permitted implementation update — 2026-10-23

New contract: [B03_CONTROLLED_OCR_INTEGRATION.md](B03_CONTROLLED_OCR_INTEGRATION.md).
Patient-authenticated extraction status is readable; retry is disabled unless the
server supplies a private hash-pinned patient/cutoff approval. Retry SQL preserves
attempt bounds and original/evidence, rejects historical/invalid/exhausted jobs,
and is idempotent for queued/running/retrying/completed jobs. The API starts no
scheduler. A worker cancelled during recovery now stops before another claim.

The isolated fixture registers two synthetic patients and uploads eleven originals
through the authenticated API to a mocked SDK transport. The real S3 adapter and
actual standalone service process six eligible originals (digital PDF, PNG, JPG,
JPEG, mixed PDF plus a previously interrupted document on attempt two). A blank PNG
fails without accepted text and retains original access. Historical pending/failed
sentinels, the other patient's job and an exhausted job are excluded; unrelated
jobs/evidence stay unchanged. Fixed approval/cutoff survives idle polling and restart.
All patients/objects/records in this fixture are disposable synthetic resources.

**B03 operational closure is pending:** actual application system-manager composition,
network/credential delivery, deployed artifact trust and application-level cgroup/
controller-loss/runtime-expiry evidence. Existing system-unit deny-all networking
remains unchanged. Formal Node/Python architecture resolution and qualified approvers
remain pending. No migration, hosted/local AI activation, live S3/DB access, service
installation or real-patient processing occurs. All complete-application E2E statuses
and the 11 implemented / 14 partial / 19 missing B00 product denominator remain unchanged.

### B03 measured checks and unresolved acceptance

| Scope | Actual result |
| --- | --- |
| New B03 fake contracts / cancellation | 19 passed |
| New authenticated-upload → actual scoped scheduler/OCR integration | 8 passed in disposable PostgreSQL |
| Existing backend | 270 passed, unchanged test count from B02 |
| Broad disposable non-summary suites | 680 passed, including the counts above and existing safety suites |
| Existing summary DB regression in broad run | 71/73; one 300 ms heartbeat subtest and its parent failed with lease-lost |
| Fresh focused rerun of unchanged summary suite | 73/73 passed; no timeout/test/production weakening |
| Existing offline regressions | 876 passed (341 Python + 510 TS + 25 baseline tools); counts overlap |
| Contracts/typecheck/build/disabled entries | Passed offline and after focused DB rerun |
| Independent cleanup/preservation | Both exact test environments and dependency tag removed; original five container states predate runs |

The first broad run is retained as failed; the focused rerun is not presented as an
all-green broad run. The cause of its short-lease timing failure remains unproven.
Actual system-manager composition/proof and the B04 clinical-information policy remain
review gates. B04 has not begun. See the B03 receipt for exact source/test fingerprints.


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


## Module-by-module delivery review — 2026-10-24

Owner selected **stop after each module for review**. Added [complete PRD checklist](PRD_MODULE_DELIVERY_TRACKER.md) (16 modules,127 exact feature/control rows; no omitted identifiers) and [Module01 account/profile review](MODULE_01_PATIENT_ACCOUNTS.md). Existing implementation was reused, with no production application logic changes. **16 new Module01 +24 B02 regression checks passed (40/40);18 completeness tests passed; typecheck/build passed.**

Module01 backend is qualified at fake-SQL/owned-loopback scope; **full M01 remains PARTIAL/OPEN** pending recovery/invalidation/security decisions, downstream ownership/auth surfaces, mobile and deployed acceptance. No automatic module advancement, processing activation, live DB/AWS/Ollama/systemd activity or SRS amendment. B03 regression safety remains CLOSED, operational implementation PARTIAL and runtime qualification OPEN as recorded in B03.4. No fresh whole-project regression count is claimed. New receipt: `baselines/MODULE_01_QUALIFICATION_20261024.json`.


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

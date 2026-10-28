# B01 — Reproducible baseline and controlled decisions

Date: 2026-10-23 (Asia/Karachi). Authority remains the complete SRS v3.0,
`AI_Health_Wallet_Final_SRS_v3.docx`, SHA-256
`e401b0aaa64f0a8ef4f393eb1a8f41dd8b029c7166728b34aa6c2e478c19c591`.
This record implements **only B01** in [the roadmap](BACKEND_MASTER_ROADMAP.md).
It is not a new SRS, a production authorization or permission to begin B02.

## Exact scope, deliverables and current authority

B01 objective: reproducible baseline and controlled-decision register. Dependencies:
B00 and owner review. Scope: all 44 FR/NFR, DEC-01–12, CFG-01–14, TRK-12-02,
TRK-18-01 and their associated acceptance entries. Deliverables: a decision/architecture
log, pinned source/test manifest, credential-free offline commands, a **plan only**
for disposable PostgreSQL verification, and explicit exclusion/release gates.
DoD: all gaps assigned; no unapproved subtraction; independent mutation/live/spend
approvals; repeatable baseline. Stakeholder approvals cannot be manufactured.

The user explicitly confirmed during B01:

1. Zero paid AI API usage and local AI inference are the approved **development
   direction**. No hosted-provider fallback, paid credentials or real generation is
   authorized. No specific local model has passed clinical or benchmark acceptance.
2. Hosted-to-local AI and retention of working Node OCR remain **development
   directions; formal SRS architecture amendments are pending**.
3. No clinical/privacy/operations approvers have been appointed. Record qualified
   accountable roles, not invented names. Academic supervision does not automatically
   authorize clinical, legal or production decisions. Continue offline work.

The DOCX and its verbatim clauses/IDs remain unchanged. The 44/88 coverage denominator
and B00 product implementation counts (11 implemented backend/process, 14 partial,
19 missing; zero release-complete) are unchanged by baseline tooling.

## Decision register

`SRS-established` means directly required by the authoritative text, not a newly
invented stakeholder approval. `Direction approved / amendment pending` must not be
reported as conformance to the conflicting SRS architecture. `Open` is an assigned
decision with its acceptance gate, not a reason to stop unrelated offline work.

| B01 decision | Source and current-code evidence | Established direction / disposition | Status and downstream gate |
| --- | --- | --- | --- |
| B01-D01 Local inference and zero paid AI | User B01 instruction/reply; SRS §§8.1/11 DEC-03/14.4; `summary_benchmark/ollama_local.py`, `summary_service/protocol.py` | Use local inference for development; paid/hosted inference and automatic fallback stay unavailable. Preserve fake defaults and no-generation flags. This conflicts with the hosted-LLM clause; local inference is not silently relabelled hosted. | Direction approved; formal amendment to DEC-03, CFG-01, TRK-8.1-01/TRK-14.4-02 pending owner/academic scope resolution. FR-015–024 and NFR-04/08 remain required. B05/B06 gate. |
| B01-D02 OCR execution responsibility | §8.1 says Python FastAPI handles OCR/AI; §14.3 requires actual extraction, not an algorithm rewrite; `processing/{pdf-text,ocr,ocr-process,ocr-processor,worker}.ts`; retained synthetic Gate 2 report | Retain verified Node PDF.js/Tesseract/Poppler and fenced persistence; Python remains the existing AI service boundary. Do not port working OCR merely to close a wording gap or claim Python OCR already exists. | Direction approved; formal allocation/architecture amendment pending. FR-011/012 and NFR-08 acceptance retained. B03 gate. |
| B01-D03 Framework and platform commitments | DEC-01/02/03/08; explicit §14.4 refines permissive §6; current Node/Express, PostgreSQL and FastAPI factories | Keep Node/Express + Python AI, patient React Native and doctor React/Vite; LangChain retrieval and LangGraph orchestration remain required. Local inference does not inherently require removing those frameworks. pgvector remains suitability-dependent. | SRS-established. B09/B11/B18/B20; framework installs/model execution not in B01. |
| B01-D04 Two sharing paths and recipient authentication | DEC-04/09/10; §14.5; `0001` grant/document/OTP constraints only | Patient-selected records only. Both QR and unique link require current permission plus doctor-email OTP. Doctors are grant-bound guests, guardians email-only. No content in QR/unverified link; no mandatory permanent doctor account. | SRS-established; services absent. B13/B14/B18. CFG-04/05 values remain open. |
| B01-D05 Authorization/revocation and file URLs | §§14.1/14.4/14.5; `documents/service.ts` authorizes before `storage.download()` returns a pre-signed URL | Check access at operation/query time; expired/revoked grant returns no records/AI context. A previously issued bearer S3 URL is not proof of current grant authorization. Recommend authenticated file delivery for patient/doctor sensitive-content operations; avoid grant downloads that bypass revocation. Preserve current implementation until B02 design/change review. | Required security semantics SRS-established. Exact gateway contract and in-flight stream cancellation/check frequency need B02/B14 review. Already delivered bytes cannot be recalled; do not promise that physical impossibility. Short URL expiry alone does not prove immediate revocation. |
| B01-D06 Processing completion and notification timing | §§14.2/14.3/14.6; DEC-05/07; `0003` sets document completed after extraction; `0004` independently fences summaries | OCR completion is a stage result, not proof summary/index/category/rules/mail finished. Keep stage outcomes separate and preserve originals/good results on later failure. Routine guardian mail requires successful processing and the corresponding accepted summary; serious alerts are independent. Delivery failure is observable, not a fabricated extraction failure or success. | Semantics SRS-established. Aggregate stage dependencies/status projection, retry routes and notification transaction boundaries require B02/B06/B17 design/tests. No schema/state rewrite in B01. |
| B01-D07 Categorization and trusted facts | FR-007/012; DEC-07; §§14.2/14.3; `documents/validation.ts`, `summaries/routes.ts` catalogue callback | Keep validated lab-report/prescription/other assignment and metadata edits. The SRS does not mandate an ML category classifier, so do not introduce one merely to satisfy wording. Validate the supported assignment experience in B02/B18; enrichment can be proposed separately. A production fact catalogue remains necessary for current grounded summary contracts and cannot come from the candidate/gold answers. | Source/code-established; end-to-end categorization still partial, trusted catalogue missing. B02/B04/B18. |
| B01-D08 Timeline date truth | §11.1 and §14.2; `documents/repository.ts` sort_date/source and separate timestamps | Use known document date; explicitly label upload-date fallback. Do not invent clinical events/dates. Preserve existing UTC implementation and deterministic tie handling for later UX review. | SRS-established; timeline application still incomplete. B07/B18. |
| B01-D09 Clinical and medical-AI boundaries | FR-023/024; DEC-06/11; §§14.3/14.4/14.6; current exact summary validators/evaluator | No autonomous diagnosis, prescribing or final treatment; support source-attributed findings, uncertainty and general consultation guidance. Do not infer clinical normality from failed/ambiguous extraction. Serious rules, units/context and indeterminate wording need qualified review; never derive gold from model output. | Safety boundary SRS-established; clinical rules, glossary/gold and wording approvals open. B04/B05/B11/B16/B19. |
| B01-D10 Guardian consent, privacy and local AI | §§5.2/14.6/19; `guardian_contacts` consent fields only; synthetic fixtures | Consent/authorized relationship must govern recipient and content. Local inference reduces external disclosure but does not settle consent, retention, logs, disk/RAM, backups or clinical legality. Synthetic/de-identified defaults; real patient processing remains prohibited without separate approvals. | SRS/user-established boundary; qualified privacy/legal approval open. B12/B15/B16/B19. |
| B01-D11 Preserve ownership, leases and current records | §§14.1/14.2/15; migrations0001–0004, scoped repositories, cutoff/approval files and disabled entry points | Reuse existing patient scope, immutable provenance, database-clock leases and attempt fencing. Never backfill historical pending jobs or mutate migration history. No workers, credentials, services, systemd or database mutations are enabled by B01. | Established preservation constraint; B03/B06/B17 must provide separately approved actual runtime proof. |
| B01-D12 Interfaces, scope and acceptance | DEC-02/09/12; CFG-13/14; §§12/18/19 | Both required clients and every approved FR/NFR remain in scope. Patient web is conditional, not silently added. No booking/payment/EHR/chat/guardian portal/permanent doctor accounts/admin features. Tests and source files do not equal clinical/production readiness. | SRS-established. B18–B21. Source reference `D-07/D-11` in UC alternate flows requires editorial clarification; retain failure-path obligations. |

## Accountable roles and open controlled parameters

- **Project Owner / Development Maintainer:** project decisions, development code and
  test artifacts. The user owns scope approvals; no named external person is invented.
- **Clinical Safety Approver:** qualified healthcare professional; appointment and
  formal approval pending.
- **Privacy/Legal Approver:** qualified privacy or legal reviewer; appointment and
  formal approval pending.
- **Operations Approver:** responsible deployment/system administrator; appointment
  and formal approval pending.
- **FYP supervisor:** may review academic/SRS alignment; that role is not automatically
  clinical, legal, infrastructure or real-patient authorization.

| Source parameter | Assigned accountable role | B01 disposition / concrete next evidence | Gate |
| --- | --- | --- | --- |
| CFG-01 | Project Owner + Privacy/Legal + academic SRS reviewer as needed | Local-only/zero-paid direction approved; hosted clause amendment, model/version, processing-location/privacy acceptance pending. Existing DeepSeek digest is a benchmark pin, not qualified model selection. | B05/B06/B19 |
| CFG-02 | Development Maintainer + Operations | Measure embedding model/dimension/vector recall/resources before index/schema freeze. Installed nomic model is not a pipeline. | B09 |
| CFG-03 | Development Maintainer + Operations | Preserve configured limits (e.g. 5 MiB upload default); document/test final quotas before affected feature/release acceptance. No new arbitrary size value set here. | B02/B03/B19 |
| CFG-04 | Development Maintainer + Operations + Privacy/Legal | OTP lifetime, attempts/rates, provider and delivery/abuse evidence remain pending; no invented numerical security approval. | B12/B14 |
| CFG-05 | Project Owner + Development Maintainer + Operations | Selected-record scope settled. Grant lifetime/session and exact in-flight revocation behavior pending contract review. | B02/B13/B14 |
| CFG-06 | Clinical Safety Approver | Clinically reviewed/versioned serious rules, lab context/units/ranges required; appointment pending. No thresholds invented. | B16/B19 |
| CFG-07 | Clinical Safety + Privacy/Legal | Approve indeterminate wording and guardian handling; ambiguity must not be called normal. | B16/B19 |
| CFG-08 | Operations + Project Owner | Existing personal S3/local PostgreSQL does not approve production compute/RDS/network/IAM/keys. No infrastructure changes in B01. | B20 |
| CFG-09 | Operations + Project Owner | Backup schedule, RPO/RTO, monitoring/incident ownership require measured rehearsal; names/values pending. | B19/B20/B21 |
| CFG-10 | Development Maintainer + Clinical Safety + Operations + UX reviewer | Preserve existing zero-unsupported-claim synthetic gates; define OCR/RAG/model/load/availability/usability metrics and approved measured thresholds before respective benchmarks. No invented p95 or clinical accuracy target. | B05/B09/B19 |
| CFG-11 | Privacy/Legal + Clinical Safety + Project Owner | Consent setup, recipients and permitted report/email content must be reviewed; schema is not consent approval. | B12/B15/B16/B19 |
| CFG-12 | Privacy/Legal + Operations + Project Owner | Retention/deletion/backup/processing compliance pending. Do not add destructive record/delete behavior by inference from “manage”. | B02/B19/B20 |
| CFG-13 | Project Owner + academic SRS reviewer | Patient mobile + doctor web is current confirmed default; no patient web addition unless separately approved. | B18 |
| CFG-14 | Project Owner / Development Maintainer | Resolved by source DEC-10: patient-selected records only; enforcement is still missing. | B13/B14 |

## Acceptance targets established now versus pending

Established source/previously approved synthetic safeguards: no cross-patient or
unverified/revoked-grant disclosure; no unsupported numerical/diagnostic/treatment
claims accepted; exact decimal/unit/operator/quotation/provenance checks; originals
preserved on processing failure; original frozen 12 cases/prompt/pins unchanged;
all expected adversarial outcomes verified, not counted as accepted good summaries.
Existing 42-expectation evaluation and 100% catalogue/critical-fact coverage criteria
are synthetic engineering gates, **not** clinically approved population performance.

Quantitative OCR quality, RAG recall/relevance, p95 latency/throughput, availability,
accessibility/usability, hardware resource suitability and RPO/RTO are explicitly
assigned above. Reviewers must approve values and datasets before release/clinical
claims. These remain open rather than being guessed to make B01 appear complete.

## Repeatable source/test baseline and safe commands

`infrastructure/baseline/baseline.py` creates/verifies a versioned source/test manifest
and copies **only pinned public source** into a new private snapshot. No source `.env`,
`.aws`, `.ssh`, private evidence, dependencies, build output or medical records are
copied/read. Symlinks, drift, unexpected source files and changed SRS bytes fail closed.
Manifest/validation-receipt output paths are explicitly excluded to avoid self-hashing.
Everything else in the allowlist, including decisions/docs, requirements and lockfile,
is pinned. This detects drift, not an attacker rewriting both manifest and source.

The explicit runner reuses local Node dependencies read-only, clears the child
environment, uses a new private TMPDIR, disables worker/storage defaults, and guards
network/credential reads. Python network calls are refused. Node allows only owned
ephemeral IPv4-loopback test servers/private test IPC; Ollama/DB/API service ports and
unrelated connections are refused. These guards are regression controls, not an OS
sandbox for malicious native code. Existing Stage B OS isolation remains the only
authorized design for future mutation tests.

From the project root (no generation, DB or Docker command):

```bash
PYTHONDONTWRITEBYTECODE=1 python3 infrastructure/baseline/baseline.py --check
# Explicit tests; receipt must be a NEW path. No package installation/download.
PYTHONDONTWRITEBYTECODE=1 python3 infrastructure/baseline/run_offline.py \
  --run-offline --receipt /tmp/NEW-OWNED-PRIVATE-DIRECTORY/b01-validation.json
```

Create the receipt parent privately first; never overwrite previous evidence. The
runner preserves private test logs/snapshot and emits aggregate codes/counts only.
It must report missing/mismatched FastAPI/ASGI dependencies as blocked tests; a
filtered Node parity test is explicitly skipped, not claimed passed. Dependencies
are pinned by existing requirement files, not automatically installed. Toolchain
versions and test/source fingerprints accompany the receipt. No paid-provider SDK
or credential loading is added.

### Disposable PostgreSQL plan — not executed or authorized in B01

Reuse `infrastructure/stage-b` / `infrastructure/summary-db` design, not development
PostgreSQL. Future review must approve a fresh PostgreSQL16 image already available
locally, unique dedicated credentials/marker, no published host ports, no external
interfaces/routes, no privileged/Docker-socket/home mounts, bounded resources and
exact owned-resource cleanup receipts. Preserve the development container/5433 and
all retained records. The existing harness can create/start/stop/remove containers,
volumes/images, apply migrations and generate synthetic credentials; those actions
require separate mutation approval even though the DB is disposable.

Proposed commands **only after that approval and dependency/image review**:

```bash
cd /home/m-tayyab-aslam/Music/ai-health-wallet/backend
npm run integration:stage-b
npm run integration:summary-db
```

Do not run both blindly: select the required harness/suites after reviewing current
source, no-pull/offline image availability and cleanup semantics. Never run database
test scripts directly against the project `.env`. No existing cloud/database, model,
worker or systemd operation is needed to validate the B01 baseline.

## Interrupted readiness work and evidence limitations

The recorded `/tmp/hw-ollama-readiness-stage/{ollama_readiness,ollama_accounting}.py`,
`/tmp/hw-ollama-readiness-model-metadata.json` and old temporary Python test venv
are absent. A bounded read-only search did not recover them. Cause unknown; no
reconstruction/deletion/resumption occurs. B05 owns any newly approved readiness work.
Ollama binding/model status is not rechecked or changed in B01.

Historical 851-test and synthetic S3/OCR/supervision receipts remain historical;
the machine-readable B01 receipt reports only this run and dependency blockers.
No DB-backed 269/Stage B/summary mutation suites are run here. API behavior, migration
history, source evidence and all data remain unchanged.

## Executed offline verification — 2026-10-23

- New baseline-safety tests: **25 passed**.
- Existing Python contract/evaluation/benchmark/local-adapter/service tests: **341 passed**.
- Existing TypeScript fake regressions: **510 passed**, zero failures/cancellations/skips.
- Total: **876 passed** (851 existing + 25 new). No dependency-blocked checks.
- Shared-schema compatibility, TypeScript typecheck, production compilation and both
  disabled-entry smoke checks passed. Compilation occurred only in the private snapshot.
- The existing 269 database-backed backend tests and Stage B/summary PostgreSQL
  mutation suites were **not run**; B01 authorizes a disposable-environment plan only.
- All 207 pre-existing inventoried files were compared: only the three requested
  tracking documents changed; no prior file disappeared. Application source, SRS,
  migrations and frozen fixtures remain byte-identical.

Toolchain: Python 3.12.3, Node v24.22.0; FastAPI 0.158.1, Starlette 1.9.0,
Pydantic 2.14.1, HTTPX 0.28.1 and jsonschema 4.10.3. A disposable test-only venv
was restored from local cached wheels using pip `--isolated --no-index`; no download
or system-package modification occurred. Passive test dependencies do not authorize
telemetry or model calls. The receipt records actual runtime/source fingerprints.

For this host, use `/tmp/hw-b01-stage/test-venv/bin/python` instead of `python3`
in the explicit runner command while that temporary environment remains available.
That path is not durable: recreating the pinned test environment is an operator
prerequisite. The default runner reports unavailable versions as blocked; it never
installs dependencies or quietly treats omitted tests as passed.

## B01 closeout

The reproducible manifest, decision register, role assignments, approval boundaries
and verification evidence are deliverables. Formal AI/OCR SRS amendments, qualified
appointments, clinical/privacy/production acceptance and any unavailable regression
dependencies stay explicit open gates. They must not stop unrelated offline design
or be falsely counted as approvals. The roadmap/traceability/status addenda record
the executed checks and precise DoD disposition after verification.

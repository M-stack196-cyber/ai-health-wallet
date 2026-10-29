# PRD v2 Phase 5 — patient RAG, LangChain and LangGraph

29 October 2026 · Asia/Karachi · Owner review checkpoint. No deployment, commit or push.

## Outcome and scope

The **bounded synthetic/offline patient record RAG backend** is implemented and focused-qualified: deterministic traceable LangChain chunking, candidate local embeddings, actual pgvector storage/search, patient-scoped evidence, actual LangGraph orchestration, grounded source citations, transparent insufficiency and current-source deletion/reprocessing fences.

**M08 is not fully implementation-complete or accepted:** **13 IMPLEMENTED / 5 PARTIAL / 2 MISSING / 2 BLOCKED**. General semantic/medical-question coverage, symptom education, doctor grants, actual LLM/embedding quality, controlled approvals and client/live/deployment acceptance remain open. Synthetic hash embeddings and exact evidence selection do not complete a production medical RAG assistant.

Only M08 and minimum M14/M15/M18 source/privacy/schema/traceability support changed. Existing M01 current-session authorization, M04 lifecycle/deletion, M05 extraction/provenance, M07 snapshots/current-source locks and conservative catalogue, and existing chunk/RAG interaction/source tables were reused. No doctor sharing, guardian medical email/serious alerts, frontend, Admin, AWS deployment or final E2E module was started.

## Baseline and Git

Verified entry/current HEAD: **d16268d — Implement Phase 4 medical summary backend**. Entry tracked worktree was clean; Phase 5 changes remain uncommitted. No branch switch, commit or push occurred.

Authoritative baseline remains SRS v4.0 + PRD v2.0, current tracker/reconciliation and Phase 4 report. All 22 exact M08 requirements and relevant FR-017–025/045, DEC-01/06/12/16/21 and controlled gates were reconciled. Both authoritative DOCX files, migrations 0001–0009 and all pre-existing tracked baseline receipts match the captured entry hashes. No historical B01–B03.x or Phase 1–4 evidence was overwritten.

| Document | SHA-256 |
| --- | --- |
| docs/AI_Health_Wallet_Revised_SRS_v4_0.docx | `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55` |
| docs/AI_Health_Wallet_Module_Wise_PRD_v2_0.docx | `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84` |

All **232 requirement IDs across 18 modules** remain present with original exact wording, mapping and priority. Only the 22 M08 assessment rows changed; the other 210 requirement rows retain their previous assessments. [Tracker](PRD_V2_MODULE_DELIVERY_TRACKER.md) · [Phase 5 receipt](baselines/PRD_V2_PHASE_5_RAG_LANGCHAIN_LANGGRAPH_RECEIPT.json).

## Architecture and authorization

Node/Express is the sole patient/document/query authorization and persistence authority. It validates the current M01 session/account, creates current extraction snapshots, validates chunk/vector contracts, enforces database tenant/source filters, validates authoritative facts/citations, locks sources for answer publication, persists accepted results and revalidates current access before responding.

Python receives no patient session/login, DB credentials, bucket/key, grant-selection capability or database client. Its LangChain retriever can only return **already authorized, bounded evidence supplied by Node**. The graph's authorization node gates a Node-authorized internal envelope; it does not independently authorize a patient or resolve a share grant. Node's SQL retrieval precedes any graph/model evidence exposure. Python cannot widen the source set.

New API routes are mounted with **no client enabled by default**. An explicit server-side `createRagClient({provider:'synthetic-offline', url, token})` may be injected through `createApp({rag:{client}})`. No API request starts a Python process or selects a model. The manual Python entrypoint requires `RAG_PROVIDER=synthetic-offline`, a 64-hex internal secret and an explicit/default private port; it binds 127.0.0.1, disables access logs and exposes protected health/processing endpoints. Hosted/default modes are refused. `.env.example` contains disabled/blank placeholders; actual application secrets were not read or changed.

Node permits literal loopback HTTP and the exact internal `/internal/v1/rag/` path, rejects URL credentials/query/fragment, disables redirects and bounds responses/call deadlines. Python enforces internal bearer authentication, request shape/size, one active request and a five-second deadline. No external model/provider, URL loader, tool execution or hosted embedding SDK is configured. Framework tracing is explicitly disabled; no checkpointer or medical-content debug log is enabled.

## Chunking and provenance

`POST /api/v1/documents/:id/rag-index` accepts an empty JSON object only. Current owner/source authorization is mandatory. Only a matching completed extraction/job on an active document/account can create a snapshot/index. Whole-document completion is not falsely asserted; the existing downstream completion gate remains intact.

Actual LangChain `RecursiveCharacterTextSplitter` uses candidate version **lc-recursive-600-80-v1**, 600-character chunks and 80-character overlap, deterministic separators and start indices. Python converts those offsets to exact UTF-8 byte spans. When current structured M05 page texts reconstruct the exact extraction, splitting stays within verified pages; otherwise page is explicitly null and extraction/byte references remain available. Node independently validates every chunk's ordered index, source text slice, byte boundaries, source hash, page bounds and vector shape. A forged in-range page number fails against authoritative page boundaries.

Existing `medical_document_chunks` rows now preserve owner/document, current snapshot/extraction/run provenance, source fingerprint, chunker version, chunk order/text, byte offsets, verified page or explicit unknown, source SHA and creation time. The snapshot retains extractor/run/version and the original hash; embedding rows retain current generation timestamps. No original document code or OCR implementation was rebuilt.

Chunk slots are unique by document/patient/order. Reindexing the same source/version preserves deterministic text and chunk identity and replaces the candidate vectors atomically, rather than accumulating active duplicates. Reprocessing changes the extraction fingerprint; stale vectors and saved answers are denied immediately. Reindexing binds the existing slots to the new snapshot and produces a single active vector per chunk/model. Surplus old slots may remain physically retained, but have no current vector evidence and cannot be retrieved. Future chunker/model versions require new qualification; only this candidate is enabled.

Current bounds are the reused snapshot contract's **32 KiB source text**, at most **128 chunks**, at most **20 retrieved chunk candidates** and **32 source facts** per answer. Unsupported/oversized evidence returns denial/insufficiency rather than silent truncation or false completeness. A larger patient corpus can therefore produce conservative insufficiency even when it contains useful records; broad recall/coverage remains PARTIAL.

## Embeddings and pgvector

Actual LangChain `Embeddings` supplies an explicit deterministic **local-synthetic/hash-token/revision 1**, **32-dimensional** candidate, key **synthetic-hash-32-v1**. It normalizes hashed lexical token counts. This is a development fixture, not a semantic embedding model or CFG-02 approval. The provider port and recorded metadata support later approved adapters, but the current client intentionally rejects other model/dimension identities.

The database stores provider/model/revision/dimensions/approval-state metadata separately, links every vector to its chunk, current snapshot, patient and document, records generated_at and validates dimensions/nonzero vectors. The base vector column is dimension-variable with a model/dimension FK; the test candidate is explicitly marked **candidate**, never production-approved. No production model, dimensionality or ANN index is frozen by the migration.

The normal PostgreSQL 16 installation had **no pgvector extension**. Ubuntu's available `postgresql-16-pgvector=0.6.0-1` package was downloaded and extracted only into an **owned relocated PostgreSQL copy under /tmp/hw-phase5-pg**. Existing installed PostgreSQL binaries/share files were copied, not altered. A real disposable cluster loaded **pgvector 0.6.0** and exercised the vector type, constraints, exact search and HNSW. The normal PostgreSQL installation and normal development/production databases were not modified or contacted.

Migration 0010 explicitly **requires an already installed pgvector extension**; it does not install an extension into a live database. The disposable fixture creates it as the test database administrator before applying the migration under the non-superuser migrator. Real environment extension provisioning is a separate owner/DBA/deployment decision.

### Candidate benchmark

The benchmark uses an owned temporary table with **2,000 deterministic numeric vectors**, **2 synthetic tenants**, **32 dimensions**, **1 fixed query**, **top-k 10** and a tenant filter. Each strategy executes that same query 25 times, with 5 warmups and 20 measured samples. Timings are client-observed local elapsed times, not controlled production service latency. Synthetic numeric vectors do not benchmark medical semantic relevance.

| Strategy | p50 | p95 | Other evidence |
| --- | --- | --- | --- |
| Exact filtered baseline | 1.55 ms | 1.74 ms | Full exact reference top-10 |
| Candidate HNSW | 0.38 ms | 0.78 ms | m=16, ef_construction=64; build 405.52 ms; sampled recall@10=1.00 |

The HNSW plan was explicitly checked; a forced index plan was used for this candidate comparison. Its tenant filter is part of the benchmark query. Runtime patient retrieval uses **exact search after materializing authorized patient rows**, with a patient/model B-tree support index. The temporary ANN index is not installed by the migration. IVFFlat was not needed for this bounded candidate comparison. These tiny, single-query measurements inform CFG-02 investigation and do not establish representative recall, production scalability, workload performance or index approval.

## Patient-scoped retrieval and metadata

The SQL path sets a **transaction-local** `app.rag_patient_id` from the authenticated patient identity, parameterizes that same owner predicate, filters by candidate model/dimensions/current extraction/source lifecycle and optionally the existing approved category. An authorized CTE is materialized **before** vector ranking. Vector RLS also requires the same tenant context and a current matching chunk/snapshot fingerprint. A missing context sees no vectors; another tenant's context cannot read the indexed patient's vectors. The context is reset by transaction completion, preventing pool leakage.

This remains a trusted application role; the DB setting is supplied by backend code, not a cryptographically authenticated DB principal. Owner/session checks and parameterized SQL remain mandatory. Patient/grant/model/source-text overrides in public requests are rejected. Python is not given a DB role or an opportunity to choose the tenant filter. Doctor scope is not implemented.

After authorized vector retrieval, the reused conservative M07 catalogue selects only exact supported English lab facts whose byte evidence lies inside a retrieved chunk. Overlap facts are deduplicated by document/fact identity, while different source values are preserved. Raw document instructions remain untrusted chunk text; they cannot become system policy, authorization or tools. Node sends a bounded copied context and digest to Python, and independently validates the returned correlation/digest, provider/version/policy and exact citation selection.

Failed/pending/unprocessed/inactive/deleted/stale documents do not qualify. Category filtering is server-side. No hidden prompt instruction substitutes for database filtering.

## Actual LangChain and LangGraph integration

Installed/tested pins: **langchain-core 1.7.1**, **langchain-text-splitters 1.1.3**, **langgraph 1.2.18**, recorded in `ai-service/requirements-rag.txt`. Existing FastAPI/private-service dependencies are reused. These are actual imported/runtime components, not custom classes with framework names.

| Component | Runtime responsibility |
| --- | --- |
| LangChain Document | Untrusted source chunks and structured approved fact metadata |
| LangChain RecursiveCharacterTextSplitter | Deterministic bounded chunking and source positions |
| LangChain Embeddings | Explicit synthetic local embedding provider abstraction |
| LangChain BaseRetriever | Only Node-approved evidence; no database or authorization expansion |
| LangGraph StateGraph | Compiled multi-step workflow and conditional success/failure edges |

The graph executes:

`Node-authorized envelope gate → delegated authorized evidence retrieval → evidence sufficiency → copied safe context → synthetic fact/citation selection → exact citation safety validation → result`.

Explicit branches cover unauthorized envelope, no records, unsupported/insufficient evidence, retriever failure, provider failure and safety validation failure. Node authentication can deny before the graph is called. The graph has no persistent checkpoint, external tools or per-user secrets in its state. State holds only the question and authorized bounded context needed for the invocation. Tracing/callback capture is disabled. Pure graph nodes are async to avoid needless sync-node executor work; final tests run in the sanitized loopback-capable test environment.

Framework usage follows official [LangGraph graph documentation](https://docs.langchain.com/oss/python/langgraph/graph-api), [LangChain embedding documentation](https://docs.langchain.com/oss/python/integrations/embeddings) and [pgvector documentation](https://github.com/pgvector/pgvector). Those references describe components, not project qualification or controlled approval.

## Answers, citations, insufficiency and safety

The current generator is an explicitly labelled **synthetic-offline / exact-evidence-selector / revision 1**, policy **patient-records-rag-v1**. It must select **all** approved citation IDs in the supplied context, in the authorized order. Missing/conflicting/fabricated IDs, malformed selections or failed provider/retriever/safety branches are refused. No unrestricted free-form provider answer is trusted.

Node constructs answer wording and citations from the authoritative retrieved facts/metadata; a model cannot invent a filename, document date, page, condition, medication, lab value or citation. Successful answers distinguish **Source-reported** facts from fixed limitations and explicitly withhold diagnosis/treatment authority. Differing values remain separately cited and retain factual document dates/upload dates; they are not reconciled into a diagnosis. Ambiguous OCR values remain unavailable, with uncertainty metadata. Current supported question topics are glucose/hemoglobin; other topics and clinical-decision/system/secret/instruction requests return insufficiency.

Every substantive answer includes document ID/name, document date (or null), upload date, verified page (or null), chunk/extraction references, exact byte spans and source quote. No bucket/key, unsafe object URL, patient session, service secret, lease token or scope token is returned. Internal UUID source references support traceability; they do not authorize access to another patient's records.

No/unsupported/oversized evidence returns:

> The available health records do not contain enough information to answer this question.

It adds no general medical knowledge to fill the gap. This record-only path does not implement the general symptom education/consultation workflow; **M08-007 remains MISSING**. No clinical fact is invented from a question or uploaded instruction.

Prompt-injection tests include ignore-policy text, cross-patient requests, system prompt/secret requests, diagnosis, prescription, citation suppression, fabricated values and malicious OCR. The default provider never executes document instructions, and Node independently revalidates selection. These controls qualify this closed synthetic selector, not an unrestricted future LLM/tool agent.

## Request lifecycle, audit and deletion/reindexing

| Endpoint | Behavior |
| --- | --- |
| POST /api/v1/documents/:id/rag-index | Current owner, empty JSON only; qualified source snapshot, private chunk/embed request, atomic source-checked indexing |
| POST /api/v1/rag/queries | Current patient; question plus optional existing category only; authorized vector retrieval, graph, validated answer and source-bound audit persistence |
| GET /api/v1/rag/queries/:id | Current owner and still-current source evidence required; foreign/deleted/restricted/stale answers denied |

Routes enforce M01, no-store, bounded question/body/context, rate limits, request cancellation/deadlines and safe fixed errors. Retrieval/provider/safety failures do not create a grounded successful result. Accepted answered/insufficient interactions are persisted in existing `rag_interactions`, with structured result/provenance and citation/source mappings for substantive answers. Failure paths return generic safe errors; this is not a claim of a completed operational failure-audit dashboard.

Publication locks the current patient and source rows, rechecks current snapshots and stores answer/evidence/document mappings atomically. A deferred source-evidence trigger refuses a substantive result without valid current citations and matching source mappings. API-role UPDATE/DELETE on saved answers is revoked; the existing source-map authorization trigger performs its required row lock with a restricted definer function while retaining patient/grant identity checks, rather than restoring API answer mutation rights.

After effective deletion/restriction, source/embedding/evidence RLS denies new retrieval and saved substantive answers; indexing cannot restore an inaccessible source. Reprocessing invalidates saved answers and old vectors by source fingerprint until a new approved index is built. An answer arriving after source deletion cannot publish. Existing originals/vectors/chunks/audit rows may remain physically retained; **CFG-12/18 physical erasure/backup/legal-hold approval remains unresolved**. Previously delivered bytes/answers cannot be recalled. Source-free insufficiency audit records remain owner/account-controlled and are not presented as source-grounded clinical data.

## Additive migration and reproducible local environment

Added only **backend/migrations/0010_patient_rag.sql**. Migrations 0001–0009 are unchanged. It adds trace metadata to existing chunks, candidate embedding model/vector tables and constraints, tenant/current-source vector/evidence policies, source-bound answer metadata/evidence, immutable API answer privileges, safe stale-vector replacement helper, deferred answer/source atomicity and the corrected source-map row-lock helper. Existing document/extraction/snapshot/chunk/interaction/source structures are reused.

Fresh apply and transactional rollback/reapply of 0010 were exercised under the non-superuser migrator in disposable PostgreSQL 16 after the test administrator created pgvector. A synthetic legacy source sentinel remained unchanged. Vector insertion/dimension rejection, scoped search, role denial, lifecycle/reprocessing and answer-publication checks passed. No normal development or production migration ran.

The test runner's `--phase5` mode requires an owned `/tmp/hw-phase5-pg` marker and uses its relocated binaries. To recreate that safe test prerequisite after /tmp cleanup: copy installed `/usr/lib/postgresql/16` and `/usr/share/postgresql/16` under the corresponding `/tmp/hw-phase5-pg/usr/...` paths; in an owned download directory use `apt-get download postgresql-16-pgvector=0.6.0-1` and `dpkg-deb -x` into that same owned prefix; create `phase5-owned` containing `phase5-owned-disposable-postgres` followed by newline. Do not install the package into the normal system or point the runner at an existing database.

A temporary virtualenv supplies `ai-service/requirements-rag.txt`; focused execution uses:

`PHASE3_PYTHON=/tmp/hw-phase3-python/bin/python node infrastructure/identity/run.mjs --execute-isolated --phase5`.

The historical interpreter variable name is intentionally reused by the shared test runner. Older explicit test schema counts/extension bootstraps were minimally updated for migration 0010; they can select this same owned test prefix through `IDENTITY_TEST_PGVECTOR_PREFIX=/tmp/hw-phase5-pg`. Those broader suites were **not run or requalified**. The actual development .env and normal database were not accessed.

## Focused verification

| Check | Final result |
| --- | --- |
| Node focused Phase 5 integration | **10/10 PASS** |
| Python focused RAG/component/graph/private-service tests | **10/10 PASS** |
| Typecheck / build | **PASS / PASS** |
| Real pgvector/schema/role/source-lifecycle checks | **PASS**, disposable copy/database only |
| Candidate exact/HNSW microbenchmark | Completed; figures above, no production approval |
| Baseline preservation / requirement accounting / diff whitespace | PASS; receipt records hashes and 232-row accounting |

| New case | Evidence |
| --- | --- |
| P5-01 | Actual extension/model metadata/dimensions, deterministic multi-chunk source bounds/provenance, idempotent index and missing-tenant/privilege/dimension denial |
| P5-02 | Actual Node/private HTTP/LangChain/LangGraph/pgvector path; multiple differently valued sources, patient isolation, valid metadata citations, category filter, saved-answer owner reads |
| P5-03 | No records, failed/pending source denial, unsupported question/diagnosis/prescription/system-secret insufficiency |
| P5-04 | Malicious document/OCR instruction matrix and ambiguous values retained as unavailable |
| P5-05 | Index→delete: saved answer/vectors/new retrieval/reindex denied; retained vector rows demonstrate logical denial rather than physical-erasure claim |
| P5-06 | New extraction version invalidates old vectors/answers; reindex produces current result without duplicate active vector rows |
| P5-07 | Fabricated citation/provider contract and deletion after retrieval fail closed; account/provider/URL boundary denial |
| P5-08 | 2,000-row exact/HNSW filtered candidate benchmark and actual HNSW plan |
| P5-09 | Structured M05 two-page extraction produces correct page citations; forged page rejected |
| P5-10 | Cross-tenant raw vector query denial, provider failure, source restriction and deleted/restricted account denial |

Python tests directly cover deterministic UTF-8 page-aware splitting, embedding abstraction/metadata, actual successful graph, unauthorized/no-record/insufficient/retrieval-failure/provider-failure/safety-failure branches, invented/suppressed citations, document-instruction matrix, internal auth, bounded body and context digest/request shape.

All data/providers are synthetic. Phase 5 source extraction fixtures use the existing fenced M05 persistence path, including structured page-run evidence; actual native OCR qualification is reused from Phase 3, not falsely rerun. Existing summary safety/catalogue code is reused, not broadly re-audited. No broad regression, actual LLM/clinical evaluation, live S3, client, production-scale performance or final E2E qualification ran.

Earlier attempts are retained privately: initial 0/8 failed because the fixture constructed its private client before service URL initialization; after correction 4/8 passed, exposing the legacy source-map trigger's row-lock permission conflict with newly immutable answers. That conflict was corrected without granting API answer mutation. A subsequent 8/8 run and final expanded 10/10 run passed. A truncated dependency download was rejected by pip's hash check; a clean-cache retry succeeded with integrity verification intact. Restricted-sandbox graph probes stalled on thread/event-loop wake-up and were stopped; final Python tests ran with a sanitized environment in the same loopback-capable execution context as the integration service. One automatic permission review timed out before a rerun began; its permitted single retry succeeded. None of these earlier failures are treated as acceptance evidence.

## All 22 M08 requirement decisions

IMPLEMENTED is the cited bounded backend control, not full module/client/model/release acceptance. The tracker retains each exact requirement, mapping, functions, evidence, status, gap, dependency, reuse decision and required re-verification.

| Requirement | SRS mapping | Status | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| M08-001 | FR-017 | PARTIAL | P5-02/03/04/07/10 | Bounded English lab questions work; general medical-language/record coverage and actual-model/client/deployment qualification remain open. |
| M08-002 | FR-018 | IMPLEMENTED | P5-02/05/06/07/10 | None for tested patient isolation/grounding boundary; broader retrieval/model quality remains separately gated. |
| M08-003 | FR-019 | PARTIAL | P5-02/03/09 | General semantic retrieval coverage/quality beyond synthetic hash embeddings and narrow English topics is unqualified; doctor scope requires M09. |
| M08-004 | FR-020 | PARTIAL | P5-01/02/08; Python graph suite | Production semantic embedding/model/index suitability and unrestricted grounded generation remain unapproved/unqualified. |
| M08-005 | FR-021 | IMPLEMENTED | P5-02/03/07; Python success/failure branches | None for the bounded graph; general agent tools/clinical summarization and actual model quality are not claimed. |
| M08-006 | FR-023 | IMPLEMENTED | P5-03/04/07; Python safety branches | None for supported patient record path; unrestricted actual-model safety remains a release/integration gate. |
| M08-007 | FR-024 | MISSING | P5-03; static record-only policy | Separate general symptom education/professional-visit guidance remains absent; record-only answers do not invent outside knowledge. |
| M08-008 | FR-045 | IMPLEMENTED | P5-02/03/05/09 | None for scoped citation/insufficiency behavior; broader relevance quality remains open. |
| M08-009 | FR-020 | IMPLEMENTED | P5-01/05/06/09; Python chunk tests | None for bounded deterministic backend chunk contract; larger source/corpus qualification remains external. |
| M08-010 | FR-020; DEC-01; CFG-02 | BLOCKED | P5-01/02/05/08; vector benchmark receipt | CFG-02 formal embedding/model/dimensions/index/retrieval approval and representative scale/clinical benchmarks remain open; no production freeze. |
| M08-011 | DEC-16 | IMPLEMENTED | P5-01/02/09; Python component tests | None for scoped real framework integration; production provider/relevance evaluation remains separate. |
| M08-012 | FR-021; DEC-16 | IMPLEMENTED | P5-02/03/07; Python graph branch tests | None for bounded graph integration; no doctor/general agent flow or release qualification inferred. |
| M08-013 | FR-018; FR-025 | PARTIAL | P5-02/05/06/07/10 | Actual revoked/expired doctor-grant query execution needs M09; patient path is qualified, grant path is absent. |
| M08-014 | FR-017; FR-018 | IMPLEMENTED | P5-02/07/10 | None for tested patient-only retrieval; future actors must supply their own approved scope. |
| M08-015 | FR-019; FR-025 | MISSING | P5-02; static no doctor API | Implement and qualify actual doctor selected-record grant retrieval with M09; outside Phase 5 approval. |
| M08-016 | FR-045; DEC-21 | IMPLEMENTED | P5-02/07/09; Python fabricated-citation safety tests | None for bounded backend citation validity; no clinical interpretation or missing page is fabricated. |
| M08-017 | FR-045 | IMPLEMENTED | P5-03/05/06/10; Python insufficiency branches | None for fail-closed insufficiency; semantic recall quality remains unqualified. |
| M08-018 | FR-023; FR-024 | IMPLEMENTED | P5-02/03/04 | None for current record-only path; separate general education remains M08-007 absent. |
| M08-019 | FR-023; FR-024; DEC-06 | IMPLEMENTED | P5-03/04/07; Python safety tests | None for supported deterministic record-answer boundary; actual hosted/local LLM and clinical coverage remain open. |
| M08-020 | V-11 | IMPLEMENTED | P5-04/07; Python document-instruction matrix | None for bounded exact-selector pipeline; future model/tool adapters require new adversarial evaluation. |
| M08-021 | DEC-12; CFG-10 | PARTIAL | P5-01–10; Python 10 cases; candidate benchmark | Representative actual-model/embedding relevance, broader clinical/OCR corpus, performance and formal CFG-10 acceptance remain unqualified. |
| M08-022 | CFG-01 | BLOCKED | P5-07; Python private service tests | CFG-01 exact hosted provider/model/data handling/geography approval is unresolved; no production model approval is asserted. |

## Files changed

| File / area | Purpose |
| --- | --- |
| backend/src/rag/client.ts | Explicit synthetic private client, model/vector/contract bounds and fixed safe errors |
| backend/src/rag/repository.ts | Current snapshot/page reuse, atomic indexing, tenant/materialized exact retrieval and source-locked answer audit/read persistence |
| backend/src/rag/service.ts | Authoritative chunk/page/fact/citation validation, source-grounded rendering and insufficiency |
| backend/src/rag/routes.ts | Patient index/query/read endpoints and current M01 boundary |
| backend/src/app.ts | Disabled-by-default injectable patient RAG routes |
| ai-service/rag_service/__init__.py, components.py, workflow.py, app.py, entry.py | Actual private LangChain/LangGraph/synthetic service and explicit manual launch |
| ai-service/requirements-rag.txt | Pinned required framework components; existing requirements unchanged |
| backend/migrations/0010_patient_rag.sql | Additive chunk/vector/evidence/lifecycle/audit/security enforcement |
| backend/src/phase5/phase5.test.ts; ai-service/tests_rag/test_rag.py | Focused backend/framework/security/benchmark tests |
| infrastructure/identity/run.mjs; backend/package.json | Owned vector-capable disposable test support and phase script |
| backend/.env.example | Disabled/blank candidate service configuration placeholders |
| backend/src/auth/identity-security.test.ts; documents/closure.test.ts; guardians/phase2.test.ts; phase3/phase3.test.ts; phase4/phase4.test.ts | Migration-count/extension-prerequisite compatibility only; older suites not rerun |
| docs/PRD_V2_MODULE_DELIVERY_TRACKER.md | 22 M08 assessments; all other rows preserved |
| This report; docs/baselines/PRD_V2_PHASE_5_RAG_LANGCHAIN_LANGGRAPH_RECEIPT.json | Owner review evidence and final source/artifact hashes |

## Remaining gates and next-phase decision

- **CFG-01 BLOCKED for hosted use:** no approved production provider/model/data handling/geographic choice. Hosted LLM/embedding use was not enabled or contacted.
- **CFG-02 BLOCKED for production selection/freeze:** synthetic 32-dimensional hashing and one-query 2,000-vector latency/recall evidence do not select a medical semantic model, dimensions or production ANN strategy. Representative corpus/query/tenant/filter/recall/concurrency/scale benchmarks and recorded approval remain open.
- **CFG-10 OPEN:** no clinical/AI quality or production performance thresholds were invented. Broad actual-model/OCR/semantic retrieval/adversarial/clinical evaluation remains unqualified.
- **M08 functional scope:** only supported English lab questions/exact evidence; general medical-language retrieval and symptom education remain incomplete. Bounds can intentionally yield insufficiency on larger corpora. No clinical completeness/semantic understanding is claimed.
- **M09 scope:** doctor identity/current selected-record grants/OTP/expiry/revocation retrieval remain absent. Patient isolation does not qualify doctor access.
- **CFG-12/18:** physical erasure, retention/backups/legal holds and qualified approvals remain unresolved; source access denial is implemented, not legal erasure certification.
- **Release:** service supervision/secrets/runtime host/network isolation, approved deployment source attestation, live S3, client and final integrated qualification remain pending. Prior B03 deployment receipts cannot attest this changed source.

## Updated 18-module progress

Only M08 assessments change. Counts are IMPLEMENTED / PARTIAL / MISSING / BLOCKED / NEEDS_REVERIFICATION.

| Module | Title | Rows | IMPLEMENTED | PARTIAL | MISSING | BLOCKED | NEEDS_REVERIFICATION | Estimate | Prerequisite gaps | Proposed phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | Patient Identity, Email Verification, Sessions & Recovery | 14 | 14 | 0 | 0 | 0 | 0 | 100% backend | Release only: real provider approval, CFG-16 security review, secrets/worker operations and client/deployed acceptance | 1 |
| M02 | Patient Profile & Guardian Relationship Lifecycle | 10 | 10 | 0 | 0 | 0 | 0 | 100% backend | Release only: CFG-11/privacy, provider/client/deployment and future M10 send-boundary qualification | 2 |
| M03 | Medical Document Upload, Validation, Private Storage & Processing State | 12 | 8 | 2 | 0 | 0 | 2 | 75% | Backend code/contracts qualified; mobile/live S3 release acceptance, legacy attestation and actual downstream integration remain external | 2 |
| M04 | Medical Record Library, Metadata, Search, Categories & Record Deletion | 14 | 11 | 3 | 0 | 0 | 0 | 89.3% | Patient backend qualified; CFG-12/18 legal retention and M09 current doctor-grant queries remain open | 3; owner review before subsequent work |
| M05 | OCR, Text Extraction, Structured Content & Processing Orchestration | 10 | 9 | 1 | 0 | 0 | 0 | 95% | Python OCR/backend contract qualified; actual M07/M08 instruction isolation and live runtime/clinical quality remain open | 3; owner review before subsequent work |
| M06 | Medical Timeline & Longitudinal History | 8 | 5 | 3 | 0 | 0 | 0 | 81.3% | Patient backend qualified; current doctor-grant identity/revocation/expiry integration requires M09 | 3; owner review before subsequent work |
| M07 | AI Report & Longitudinal History Summaries | 11 | 3 | 5 | 2 | 1 | 0 | 50% | Bounded synthetic report/history backend qualified; general source coverage, CFG-01/10, actual model and M09 doctor access remain open | 4; owner review before later work |
| M08 | RAG Retrieval, Source Citations, Agentic Orchestration & AI Safety | 22 | 13 | 5 | 2 | 2 | 0 | 70.5% | Bounded synthetic patient RAG qualified; CFG-01/02/10, broad semantics/symptom/doctor and live/client/deployment qualification open | 5; owner review before later work |
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

Totals: **79 IMPLEMENTED / 52 PARTIAL / 76 MISSING / 19 BLOCKED / 6 NEEDS_REVERIFICATION = 232**. Entry totals were 66/50/91/19/6. M08 weighted control estimate is **70.5%**; overall weighted control estimate is **45.3%**. These are requirement-control estimates, not effort or release readiness. M07 and supporting M14/M15/M18 requirement statuses were not automatically promoted.

**STOP for owner review. Phase 6 has not started and is not automatically authorized.** The owner must review the bounded patient capability and open gates before choosing further M08 qualification/coverage work or a separately bounded next phase. General M08, model/embedding approval and clinical/release acceptance remain open; no production readiness claim is made.

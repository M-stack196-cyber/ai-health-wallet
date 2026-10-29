# PRD v2 Phase 3 — document processing and timeline

29 October 2026 · Asia/Karachi. Work began 28 October; verification resumed after interruption on 29 October. Owner review checkpoint; no deployment, commit or push.

## Outcome and scope

The patient backend slices for M04 library/deletion, M05 private Python OCR orchestration and M06 timeline are implemented and focused-qualified. Full module acceptance remains open: M04 **11 IMPLEMENTED / 3 PARTIAL**, M05 **9 IMPLEMENTED / 1 PARTIAL**, M06 **5 IMPLEMENTED / 3 PARTIAL**. Neither legal retention nor doctor access nor downstream AI instruction isolation is certified. No later development begins automatically.

Only M04/M05/M06 and their minimum security/privacy/schema/traceability support changed. Existing upload/storage, current-session middleware, metadata validation, source hashes, retry, worker heartbeat/recovery and fenced extraction persistence were reused. No frontend, summary generation, embeddings, RAG producer, doctor authorization/sharing API, medical email sender, Admin API, deployment or broad regression suite was started. Legacy implementations and B01–B03.x evidence were preserved.

## Baseline and Git

Authoritative requirements are `AI_Health_Wallet_Revised_SRS_v4_0.docx` and `AI_Health_Wallet_Module_Wise_PRD_v2_0.docx`, with the current tracker/reconciliation and Phase 2/2B reports. The inventory remains **232 unique rows across 18 modules**, and the existing SRS register remains 55 FR / 8 NFR / 22 DEC / 18 CFG / 14 AT / 34 V. This phase changes only the 32 M04–M06 requirement assessments; it does not requalify the other 200 requirements.

| Artifact | SHA-256 |
| --- | --- |
| SRS v4.0 | `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55` |
| PRD v2.0 | `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84` |

Entry checkpoint and current HEAD: **716ac35** (`Complete M02 guardian lifecycle and M03 backend readiness`). The phase began with a clean tracked worktree; changes remain uncommitted. Migrations 0001–0007, both authoritative documents, and all pre-existing baseline receipts match the captured entry hashes. New receipt: [Phase 3 receipt](baselines/PRD_V2_PHASE_3_DOCUMENT_PROCESSING_TIMELINE_RECEIPT.json). No normal development database or AWS resource was contacted. The new migration was exercised only in owned disposable PostgreSQL clusters.

## M04 library, metadata and effective deletion

Existing authenticated endpoints remain the patient library: `GET /api/v1/documents`, `GET /:id`, `PATCH /:id`, private `GET /:id/download`, readiness and retries. M01 current verified/active account, security-version and live-session enforcement remains mandatory. Parameterized owner predicates protect all patient reads/writes; unknown/foreign/deleted records return 404.

Exact PRD filters remain `hospital` (case-insensitive exact match), `category`, `uploaded_from` and `uploaded_to` (inclusive UTC date range), plus bounded `limit`/`offset`. PRD M04-004/009 do not authorize arbitrary filename/full-text/processing-state/document-date search; unsupported query keys fail. Existing chronology still uses document date first. Category codes stay compatible (`lab_report`, `prescription`, `other_medical_document`) and public labels are **Lab Report**, **Prescription**, **Other**.

Only hospital name, category and patient-confirmed document date are editable. Ownership/storage/hash/processing/system/suggestion fields are rejected. OCR category/date suggestions cannot silently replace patient hospital/category/date. API projections expose approved source metadata and state, never private bucket/key or a reusable object URL.

`DELETE /api/v1/documents/:id` accepts no body/query. A database transaction revalidates the current M01 session, locks patient then processing job then source document, cancels unfinished processing, revokes every grant containing that source, marks unsent existing notification records failed, marks the document deleted and appends one immutable application audit event. Foreign/missing returns 404; repeat owner deletion returns the same successful restriction outcome. Unrelated document rows and originals remain intact. Revoking an affected multi-record grant conservatively revokes that whole grant; it does not erase other documents.

Response explicitly includes `access_state=deleted`, `retention_status=policy_pending`, `original_erased=false`. Deleted state cannot be restored by application updates. Physical original/derived bytes remain retained pending CFG-12/18 policy approval. This is effective application access denial, not a hard-erasure claim or legal deletion certification.

| Resource | Enforced now | Later qualification |
| --- | --- | --- |
| Original | Medical-document lifecycle RLS hides references; owner/file retrieval rechecks state before delivering acquired bytes | Live S3/client paths and approved erasure policy; bytes already delivered cannot be recalled |
| Processing | Pending/running/retry work cancelled, lease cleared; source resolution, heartbeat, claim/persist deny deleted source | Deployed multiprocess/cloud behavior |
| OCR/run evidence | RLS hides retained rows; write guards deny deleted/inactive source; fenced publication cannot resurrect it | Future consumers must use the same source boundary |
| Chunks/embeddings | Existing chunk rows hidden and writes denied on deleted source; source-level contract applies to future vector producers | No embedder/vector service implemented; any future store needs explicit deletion/deny integration |
| Summaries/snapshots/jobs | Existing tables hidden/guarded by current source lifecycle | No summary generation added; future aggregate endpoints must recheck every source |
| RAG sources/retained answers | Source rows hidden; answers require nonempty, all-accessible sources; application RAG write path disabled | Synthetic retained-row fixtures only; M08 must implement authorized production writes and prompt isolation |
| Sharing | Affected grants revoked; selected source rows hidden/guarded | No M09 doctor workflow; current grant/expiry/OTP endpoint qualification remains open |
| Guardian notifications | Unsent existing events fail with DOCUMENT_DELETED; source/event access denied | No M10 sender; actual send-boundary revalidation must be qualified later; sent email cannot be recalled |
| Timeline | Deleted/restricted/inactive source excluded from current owner queries | Doctor revocation/expiry integration remains M09 |

Lifecycle RLS is **not a replacement for patient owner authorization**: the application DB role is a trusted service role shared across requests. API SQL still carries the authenticated patient predicate. Table owner/migrator access remains privileged for migrations and retained-data administration; this is not exposed through an Admin endpoint. New tables or external stores are not automatically guarded: future migrations/consumers must adopt and test the explicit current-source contract before release.

## M05 Node–Python contract and extraction

Node/Express owns patient authorization, current document/job access, source retrieval/hash, orchestration, heartbeat/recovery, retries and persistence. Python receives no patient login/session/DB credentials and cannot authorize a patient or write the database. The background runtime's default processor now uses `createPythonOcrProcessor`; previous canary/startup/cloud approval gates remain in place. Historical Node OCR utilities remain for retained evidence and are not the configured new OCR runtime.

The manual Python entrypoint binds only `127.0.0.1`; OpenAPI/docs and access logs are disabled. Health `/health` and readiness `/ready` also require the internal bearer token. Both Node and Python require an explicit 64-hex secret; `.env.example` contains a blank placeholder. Node allows literal loopback HTTP `/v1/extractions` only, forbidding redirects, URL credentials, query and fragment. There is no auto-start/deployment or supplied live credential.

Contract v1 `POST /v1/extractions` uses bounded raw JSON with **exact keys**: `schema_version`, `request_id`, `document_id`, `job_id` (existing job identity equals document ID), `attempt`, `fence_token`, `media_type`, `source_sha256`, `content_base64`, `mode=native_or_ocr`. Node supplies acquired bytes, not an arbitrary file path, object URL or network location. Python validates UUIDs, attempt, MIME, strict base64 and SHA. Structured failures return only a fixed error category and retryable flag; no source content/path/tool diagnostic is logged or reflected.

Successful results echo correlation/document/job/attempt/lease and include completion time, extraction contract/version, ordered source pages/method/confidence and a structured envelope tagged `untrusted_document_data`. Pages contain text and fragments: native PDF lines retain page identity; OCR word fragments have normalized `[x,y,width,height]` regions and page confidence. Tool versions, conservative category suggestion and uncertain ISO-date suggestion are preserved separately. This qualifies a structured extraction producer; it does not claim normalized clinical diagnoses, summaries, embeddings or retrieval answers.

Per-page native Poppler text is used when there are at least eight alphanumeric characters; otherwise a bounded render passes to Tesseract English. Mixed native/scanned PDFs retain distinct page methods. Images support JPG/JPEG/PNG with signature/decoder validation and EXIF normalization. All-empty extraction fails explicitly. No document instruction is executed: prompt-like strings remain tagged inert data. Actual model prompt isolation remains **M05-009 PARTIAL** until later consumers are implemented and tested.

Node validates response size, contract shape, echoed IDs/attempt/lease, source digest, extraction metadata, ordered pages, text/fragment consistency, regions/confidence, suggestions and tool fields. Node then uses the existing live claim and a single SQL transaction to insert structured processing-run evidence and call the existing extraction publication function. Composite owner/source linkage, request uniqueness, document-attempt uniqueness and current lease/deadline fences prevent conflicting/stale/cross-owner publication. Suggested date never overwrites document_date.

Existing retry/heartbeat/recovery is reused. A bad internal-service credential fails safely as PROCESSOR_FAILED without mislabelling the source itself invalid; an allowed patient retry retains the source and produces attempt 2. Extraction can be completed while whole-document `processing_status` remains processing: migration 0007's downstream-completion gate is preserved. No OCR success claims downstream AI/grounding completion.

| Bound | Default/enforcement |
| --- | --- |
| Python content/pages/concurrency | 20 MiB / 100 pages / 1 request; validated factory caps pages 200, concurrency 2 |
| Overall Python deadline / Node timeout | 120 seconds defaults; explicit bounds, cancellation and cleanup |
| Native command | Fixed executable/arguments, no shell; per command 15 seconds, 1 GiB address space, 20 CPU seconds, 16 MiB output-file size, 64 descriptors, no core dump |
| Image | At most 20 million pixels, normalized temporary image |
| Extracted content | At most 1 million characters / 30,000 fragments |
| Response/persistence | Node response <=6 MiB; structured envelope <=4 MiB with relational source/run constraints |
| Temporary files | Generated private directory 0700, source/output 0600; owned process group killed/reaped on timeout/cancel; cleanup awaited |
| External activity | No model/API/URL loading; child command environment excludes application secrets; no medical-content/access debug logs |

Pillow normalization and Python parsing still execute in the service process; resource limits listed for native commands are not a claim of whole-service OS/container isolation. A hardened deployed supervisor/resource/network boundary and broader malformed/clinical corpus remain release qualification work.

Local test environment uses pinned FastAPI 0.158.1, Starlette 1.9.0, Pydantic 2.14.1, Uvicorn 0.35.0, Pillow 12.2.0 and test-only HTTPX 0.28.1 in a temporary virtualenv. Existing installed Poppler/Tesseract binaries provide native extraction; actual tool versions are carried in each result. No system Python package or AWS environment was changed.

## M06 timeline and dates

`GET /api/v1/timeline` requires M01 authorization and accepts the same approved patient filters/pagination. Entries contain `source_document_id`, `event_date`, `date_source` and allowlisted document metadata. Ordering reuses document_date or actual UTC upload-date fallback descending, then upload timestamp descending and stable ID ordering. Failed/unprocessed records remain metadata-only with their truthful processing state. No clinical event or date is invented.

A suggested OCR date is separately persisted with confidence (currently conservative 50); `date_confirmation_required` remains true until it matches the patient's confirmed date. Patient PATCH is the existing confirmation mechanism. Until then, chronology retains the confirmed document_date or labelled upload fallback.

`createTimelineService` takes a trusted asynchronous scope resolver. Owner scope can be intersected with server-supplied selected document IDs; empty selection yields no records. It resolves again after the query and rejects changed scope. The patient route revalidates the current M01 session before/after its query through that resolver. Request parameters cannot supply another patient or a share scope.

This is a reusable selected-record boundary, **not doctor authorization**. M09 must implement the real doctor/OTP/current-grant resolver, validity/expiry/revocation and endpoint; M06-002/006/007 therefore remain PARTIAL. No doctor API was started.

## Additive migration and schema/security checks

Only `backend/migrations/0008_document_access_processing_timeline.sql` was added. It introduces document access/deletion and uncertain-date fields, active timeline index, unique append-only application audit events, cancelled processing-state shape, structured extraction-run table, 13 lifecycle/source RLS policies, write guards, effective deletion and fenced Python publication functions. Existing relational structures are reused.

Functions use explicit schema-qualified objects/search paths with pg_temp last. PUBLIC execution is revoked for the new helper functions; application grants are explicit, audit mutation and original hard-delete permissions withheld. The definer deletion function reauthorizes an actual current patient session, preventing arbitrary owner claims. Invoker publication remains bounded by job/source/lease checks. Database owner/superuser access is intentionally outside application RLS.

Fresh schema application and transactional rollback/reapply of 0008 were tested under the non-superuser migrator role in isolated PostgreSQL 16, preserving a synthetic legacy original and source identity. Migrations 0001–0007 were not edited. Normal development and production migrations were not run. Historical fixtures that explicitly assert the current schema count were adjusted from seven to eight; the old six-migration restoration fixture applies subsequent additive migrations. These compatibility edits do not imply those broader suites were rerun.

## Focused verification and limitations

Final verification: **23/23 Node checks** (13 Phase 3 integration cases plus 9 mocked SDK cases and their parent test), **9/9 Python tests**, backend **typecheck PASS**, **build PASS**. No broad regression was run. All real OCR cases use synthetic inputs; originals use an in-memory private storage adapter, while Node→FastAPI→Poppler/Tesseract and database persistence are real. Mocked SDK checks make no AWS call. No live S3 qualification is inferred.

| Evidence | Cases / what was verified |
| --- | --- |
| P3-01 | Schema, application privileges, 13 RLS policies, retained legacy identity/audit restrictions |
| P3-02 | Own library, cross-owner denial, exact filters/category labels, hospital/category edits, immutable protected fields |
| P3-03 | Confirmed/fallback chronology, source reference, owner scope, selected/empty/changed trusted scopes |
| P3-04/05 | Owner-only/idempotent deletion, original retained/unrelated records preserved, file/list/detail/readiness/retry/timeline denial, acquisition race, restricted account denial |
| P3-06 | Protected health, malformed/private-service boundary and safe structured errors |
| P3-07 | Actual native PDF, scanned PDF, mixed PDF, JPG, JPEG, PNG through worker/HTTP/native OCR and SQL provenance |
| P3-08 | OCR uncertain date versus confirmed date, explicit confirmation, prompt-like text retained as inert tagged data |
| P3-09 | Internal authorization failure, original retention, real public retry and genuine attempt-2 Python success, duplicate/stale completion denial |
| P3-10 | Existing grant/notification cancellation, retained OCR/run/chunk/RAG row denial, processing cancellation; synthetic fixtures only |
| P3-11/12 | Actual Python completion after deletion rejected; expired attempt cannot overwrite newer genuine completion; cross-owner claim denied |
| P3-13 | Valid blank PDF structured failure, observable failed state, original download preserved, no result published |
| Python focused suite | Configuration/auth/readiness, request/path/URL/hash/job/size/schema boundaries, actual PNG/JPEG OCR, malformed media, mocked deadline/cancellation cleanup and busy admission |

Python deadline/cancellation unit tests mock extraction work; they demonstrate task/admission cleanup, not an independent live-tool kill stress test. Native command kill/reap logic is implemented but deployment/process-failure stress qualification is still open. Existing M01 guards and historical focused identity evidence are reused; this run does not repeat every suspended/deleted/session permutation across all APIs.

Earlier attempts remain visible as failures, not acceptance evidence. Initial implementation exposed an INSERT RETURNING/RLS lookup defect, fixed with a direct document-row policy; subsequent prior runs passed 20 then 22 checks. A resumed run had a Python two-second test startup timeout, corrected with a ten-second test allowance and failure cleanup. The first retained 29 October Node attempt passed 18/23, with test timing exhaustion and an invalid application-role RAG setup fixture; test-only budgets were raised and retained RAG setup moved to the owner role, without enabling a RAG producer. Final receipt identifies the retained final successful run; interrupted earlier /tmp artifacts were not available after restart. These failures and corrections do not conceal an unresolved failing final check.

## All 32 requirement decisions

The tracker preserves exact requirement wording, original source mapping/priority and all 232 IDs. Its Reference P3 records implementation/functions, tests, status, remaining gap, dependency, old-evidence reuse and reverification. IMPLEMENTED below means the cited backend producer/control only. It does not close client, live infrastructure or future consumer qualification.

| Requirement | SRS mapping | Final status | Focused evidence | Remaining gap / scope |
| --- | --- | --- | --- | --- |
| M04-001 | FR-006 | IMPLEMENTED | P3-02/03 | None for backend metadata/search; client acceptance remains external. |
| M04-002 | FR-007 | IMPLEMENTED | P3-02 | None for backend category representation. |
| M04-003 | FR-008 | IMPLEMENTED | P3-02/04/05 | None for backend patient management; client release is separate. |
| M04-004 | FR-009 | IMPLEMENTED | P3-02 | None for specified backend filters. |
| M04-005 | FR-043 | PARTIAL | P3-04/05/10/11 | CFG-12/18 approval, retention/backup/legal-hold and final erasure qualification remain open; no legal deletion certification. |
| M04-006 | DEC-07 | IMPLEMENTED | P3-02 | None for backend labels; API retains stable category codes. |
| M04-007 | DEC-07 | IMPLEMENTED | P3-02/08 | None for backend patient metadata authority. |
| M04-008 | DEC-07 | IMPLEMENTED | P3-02/03/08 | None for separate backend dates. |
| M04-009 | FR-009; FR-036 | IMPLEMENTED | P3-02 | None for exact PRD filter set. |
| M04-010 | FR-008; NFR-01 | PARTIAL | P3-02/03 | Actual current doctor-grant authorization/list integration requires M09; no doctor endpoint built. |
| M04-011 | DEC-07 | IMPLEMENTED | P3-03/08 | None for backend uncertainty/confirmation contract; client UX remains separate. |
| M04-012 | FR-043; DEC-20; CFG-18 | PARTIAL | P3-04/10/11 | CFG-18/12 policy approval and integrated future-consumer/physical-retention qualification remain open. |
| M04-013 | FR-043; V-28 | IMPLEMENTED | P3-01/04/10 | None for backend audit/unrelated record preservation; affected multi-record grant is conservatively revoked as a whole. |
| M04-014 | FR-043; V-28 | IMPLEMENTED | P3-04/05/10/11 | None for existing backend paths and technical future-resource guards; future modules must preserve these policies and requalify their endpoints. |
| M05-001 | FR-011 | IMPLEMENTED | P3-06/07/13; Python OCR tests | None for backend synthetic OCR capability; clinical quality/live operation remain release gates. |
| M05-002 | FR-012 | IMPLEMENTED | P3-07/08 | None for scoped extraction data contract; downstream medical normalization/retrieval belongs to later modules. |
| M05-003 | FR-011 | IMPLEMENTED | P3-07 | None for backend dispatch; broader corpus/clinical quality remains external. |
| M05-004 | FR-012; NFR-01 | IMPLEMENTED | P3-01/07/12 | None for backend source linkage. |
| M05-005 | FR-012 | IMPLEMENTED | P3-07/08 | None for extraction producer contract; no clinical summaries, embeddings, RAG or downstream acceptance claimed. |
| M05-006 | DEC-03; DEC-15 | IMPLEMENTED | P3-06/07/09/11/12 | None for scoped backend OCR boundary; Python deployment/service supervision remains unqualified. |
| M05-007 | FR-010; V-06 | IMPLEMENTED | P3-09/13 | None for OCR-stage failure/readiness contract; actual later AI/index stages remain unimplemented. |
| M05-008 | FR-010; V-06 | IMPLEMENTED | P3-09/11/12 | None for backend synthetic retry/fencing; live multi-process/cloud qualification remains external. |
| M05-009 | V-11 | PARTIAL | P3-08 | Actual document-to-AI prompt isolation/consumer enforcement needs M07/M08 integration; tagging alone does not qualify it. |
| M05-010 | DEC-12 | IMPLEMENTED | P3-07/09/12 | None for backend provenance contract; frozen deployed environment and corpus reproducibility remain release work. |
| M06-001 | FR-013 | IMPLEMENTED | P3-03/08/13 | None for patient backend timeline; client/doctor acceptance remains separate. |
| M06-002 | FR-014 | PARTIAL | P3-03 | M09 doctor identity/OTP/current-grant resolver and actual healthcare-professional API are absent by authorized scope. |
| M06-003 | FR-013; V-08 | IMPLEMENTED | P3-03/08 | None for patient backend chronology. |
| M06-004 | FR-013; DEC-07 | IMPLEMENTED | P3-03/08 | None for explicit patient backend fallback. |
| M06-005 | FR-013; NFR-01 | IMPLEMENTED | P3-03/04/05 | None for patient backend ownership/current account scope. |
| M06-006 | FR-014; FR-025 | PARTIAL | P3-03 | Actual current valid doctor grant validation/expiry/OTP flow requires M09; no doctor access acceptance. |
| M06-007 | FR-014; FR-043; FR-046 | PARTIAL | P3-03/04/05/10 | Actual doctor revocation/expiry-to-timeline integration must be qualified with M09. |
| M06-008 | NFR-04 | IMPLEMENTED | P3-03/08/13 | None for backend source references; later consumers must retain them. |

M04 applicable patient backend behavior is implementation-complete; full policy/doctor scope is not. M05 OCR producer/orchestration is implementation-complete; complete AI instruction isolation is not. M06 patient timeline is implementation-complete; doctor timeline is not. No whole module is declared fully accepted.

## Files changed and reuse

| Files / area | Purpose |
| --- | --- |
| backend/migrations/0008_document_access_processing_timeline.sql | Additive access/provenance/deletion/schema enforcement |
| backend/src/documents/repository.ts, routes.ts | Public labels/suggestions, trusted selection intersection, owner deletion endpoint |
| backend/src/timeline/routes.ts, service.ts; backend/src/app.ts | Patient timeline API and current scope boundary |
| backend/src/processing/python-processor.ts | Private versioned bounded HTTP adapter/result validation |
| backend/src/processing/extraction.ts, repository.ts, retrieval.ts, service.ts | Optional Python evidence, original hash, atomic fenced structured persistence |
| backend/src/processing/background-runtime.ts | Select Python OCR as the new runtime processor while retaining startup gates |
| ai-service/ocr_service/__init__.py, app.py, engine.py, entry.py | Protected manual private OCR service and bounded native tools |
| ai-service/requirements-ocr.txt | OCR-only dependencies; existing summary dependencies untouched |
| backend/.env.example, backend/package.json | Explicit private OCR configuration placeholders and focused test script |
| backend/src/phase3/phase3.test.ts; ai-service/tests_ocr/test_ocr.py | Focused synthetic integration/unit evidence |
| infrastructure/identity/run.mjs | Owned disposable cluster/Python interpreter test support |
| backend/src/auth/identity-security.test.ts; backend/src/documents/closure.test.ts; backend/src/guardians/phase2.test.ts | Additive schema count/restoration compatibility only |
| docs/PRD_V2_MODULE_DELIVERY_TRACKER.md | 32 updated decisions; all other requirement rows preserved |
| This report and docs/baselines/PRD_V2_PHASE_3_DOCUMENT_PROCESSING_TIMELINE_RECEIPT.json | Reviewable traceability and final evidence hashes |

No original upload/storage implementation, M01 authorization model, worker lease system or old migrations were rewritten. Historical B01–B03.x receipts and reconciliation/Phase 2/2B reports were not overwritten. Private test artifacts are ignored local evidence, not public source or credentials.

## Remaining blockers and controlled decisions

- **CFG-12/18:** retention, physical deletion, backups/legal holds and legal/privacy approval unresolved. Policy-safe access restriction is implemented; no hard erase or certification.
- **M09 scope:** doctor identity, OTP and current selected-grant/revocation/expiry integration deferred. The scope resolver is not evidence of a completed doctor flow.
- **M07/M08 scope:** consumers must treat extraction as untrusted data and revalidate current source access; actual AI prompt isolation, summaries/indexing/retrieval remain open. No OCR success falsely closes downstream readiness.
- **M03/live S3:** no explicitly approved non-production live cloud qualification was established in this phase. M03-002/007 stay NEEDS_REVERIFICATION; SDK mocks do not replace live evidence. Client acceptance remains external.
- **Runtime/release:** Python secret distribution, supervision, native dependency provisioning, deployed host/network/resource isolation, current source/deployment attestation and actual cloud concurrency remain unqualified. Prior B03 deployment receipts cannot silently attest this changed source.
- **CFG-10 and other owner/clinical gates:** representative OCR accuracy/language/performance/clinical evaluation and controlled approvals remain open. English synthetic OCR tests are not clinical acceptance. No new CFG approval/selection is invented; existing CFG-01/02 and other product release gates remain as recorded.

## Updated 18-module progress

| Module | Title | Rows | IMPLEMENTED | PARTIAL | MISSING | BLOCKED | NEEDS_REVERIFICATION | Estimate | Prerequisite gaps | Proposed phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | Patient Identity, Email Verification, Sessions & Recovery | 14 | 14 | 0 | 0 | 0 | 0 | 100% backend | Release only: real provider approval, CFG-16 security review, secrets/worker operations and client/deployed acceptance | 1 |
| M02 | Patient Profile & Guardian Relationship Lifecycle | 10 | 10 | 0 | 0 | 0 | 0 | 100% backend | Release only: CFG-11/privacy, provider/client/deployment and future M10 send-boundary qualification | 2 |
| M03 | Medical Document Upload, Validation, Private Storage & Processing State | 12 | 8 | 2 | 0 | 0 | 2 | 75% | Backend code/contracts qualified; mobile/live S3 release acceptance, legacy attestation and actual downstream integration remain external | 2 |
| M04 | Medical Record Library, Metadata, Search, Categories & Record Deletion | 14 | 11 | 3 | 0 | 0 | 0 | 89.3% | Patient backend qualified; CFG-12/18 legal retention and M09 current doctor-grant queries remain open | 3; owner review before subsequent work |
| M05 | OCR, Text Extraction, Structured Content & Processing Orchestration | 10 | 9 | 1 | 0 | 0 | 0 | 95% | Python OCR/backend contract qualified; actual M07/M08 instruction isolation and live runtime/clinical quality remain open | 3; owner review before subsequent work |
| M06 | Medical Timeline & Longitudinal History | 8 | 5 | 3 | 0 | 0 | 0 | 81.3% | Patient backend qualified; current doctor-grant identity/revocation/expiry integration requires M09 | 3; owner review before subsequent work |
| M07 | AI Report & Longitudinal History Summaries | 11 | 0 | 6 | 4 | 1 | 0 | 27% | M05/M06; CFG-01/10; real catalogue/provider | 4 |
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

Tracker totals: **IMPLEMENTED 63 / PARTIAL 51 / MISSING 93 / BLOCKED 19 / NEEDS_REVERIFICATION 6 = 232**. Entry totals were 49/55/101/19/8. Weighted control estimate `(implemented + 0.5*partial)/232` is **38.1%**, not effort or release readiness. M01/M02 and M03 status are unchanged; supporting M14/M15/M18 rows were not promoted based on this narrower work.

## Owner review and next phase

**Stop here. Phase 4 is not automatically authorized.** After owner review, a separately bounded synthetic/backend M07 phase can build on the extraction/timeline contracts. Its scope must preserve deletion/current-source checks, truthful downstream state and untrusted-input handling; model/provider and evaluation choices need their applicable controlled decisions before real-patient or release claims. No live/cloud/client/legal/clinical acceptance is implied, and no later code or deployment has started.

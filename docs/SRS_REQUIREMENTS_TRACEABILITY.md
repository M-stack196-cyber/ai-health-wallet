# SRS requirements traceability — B00 audit

Audit date: **2026-10-23 (Asia/Karachi)**. Authority: `docs/AI_Health_Wallet_Final_SRS_v3.docx`, version 3.0, 20 October 2026. SHA-256: `e401b0aaa64f0a8ef4f393eb1a8f41dd8b029c7166728b34aa6c2e478c19c591`.

The complete main document (211 paragraphs, 35 tables, all §§1–19, including the out-of-order §13) and its footer were read. No external proposal claims or prior conversation phase completions replace the SRS. Front matter/bibliography/diagram schedule discussion are context, not additional application features. Every substantive unnumbered clause below is traceable without silently inventing source FR identifiers.

## Counting and status rules

There are **44 canonical source-ID requirements: 36 FR and 8 NFR**. This audit also records **88 subordinate unnumbered normative/control clauses** with clearly audit-assigned `TRK-` IDs, **12 DEC decisions, 14 CFG parameters, 8 UC flows, 14 AT checks and 24 V checks**. These supporting rows refine/verify the 44 primary requirements; summing them would double-count the same obligations and is not a claim of that many independent product features.

Primary implementation counts: **11 implemented at backend/process scope, 14 partial, 19 not implemented**. FR: 8/9/19; NFR: 3/5/0 (implemented/partial/missing). **Zero are accepted as release-complete; all 44 still need adequate final integrated acceptance evidence.** The implemented label is engineering coverage, not fulfillment of SRS §10.1 in production.

Three independent evidence dimensions accompany implementation status: **T** = documented synthetic/unit/isolated test coverage; **I** = implemented/tested subsystem integration, explicitly not full deployment; **E** = the entire source-required flow verified end-to-end in the intended integrated application. `Partial` means only a component is covered. All E values are No; the historically live *manual S3-to-OCR subflow* is separately recorded and never promoted to a complete mobile/AI/sharing/guardian flow. No tests/builds/DB/cloud/model/service operations were executed during B00.

Blocked is orthogonal to implementation: model/privacy/clinical decisions, missing clients, unverified runtime composition, live activation and deployment are blockers, not excuses to mark features complete or remove them. Every primary row maps to a feature/verification phase **and B21 final acceptance**. Role/security/dependency/acceptance fields are inherited by its subordinate TRK rows, which additionally identify their precise clause and implementation phases. DoD is conjunctive: both parent and all applicable subclauses must pass.

## Evidence registry (repository paths and actual API surface)

| Evidence ID | Source files | Current API/interface | Verification and limits |
| --- | --- | --- | --- |
| E-AUTH | backend/src/auth/{routes,middleware,passwords,tokens}.ts; backend/src/patients/{repository,validation}.ts; migrations/0001 | POST /api/v1/auth/register; POST /api/v1/auth/login; GET/PATCH /api/v1/patients/me | backend/src/auth/auth.test.ts; historical 29 auth tests within 269 baseline; Gate 2 used synthetic registration/login |
| E-DOC | backend/src/documents/{routes,repository,service,validation,multipart,integrity,storage,original-reader,file-access}.ts; backend/src/config/documents.ts; migrations/0001 | POST/GET /api/v1/documents; GET/PATCH /api/v1/documents/:id; GET /api/v1/documents/:id/download | backend/src/documents/{documents,storage}.test.ts; scoped filters/date/denial/validation/storage-compensation tests; historical disposable suites |
| E-DB | backend/migrations/0001_initial_schema.sql; 0002_document_processing_lifecycle.sql; 0003_lease_fenced_extraction.sql; 0004_medical_summary_jobs.sql; infrastructure/database-roles.sql | SQL migration/repository contracts; no active DB inspected | backend/src/database/{schema,security}.test.ts; immutable migrations; application-role isolation is not patient-level RLS |
| E-OCR | backend/src/processing/{repository,service,worker,retrieval,extraction,pdf-text,digital-pdf-processor,ocr,ocr-process,ocr-processor}.ts | Internal claim/heartbeat/recover/persist; B03 patient extraction status and separately approved scoped retry routes | backend/src/processing/*.test.ts (digital-pdf, OCR, persistence, retrieval, lifecycle); source/page/hash/attempt evidence; subset historically live |
| E-LIVE | backend/src/integration/{cli,guards,aws-preflight,scoped-worker,workflow,live-run}.ts | Explicit manual synthetic S3→OCR runner; not API startup/automatic worker | .private-evidence/phase-2.2d-gate2-pid7GY/verification-report.json safely inspected: passed, seven security checks, three of each resource; no cleanup; historical only |
| E-SUP | backend/src/processing/background-*.ts; backend/src/stage-c/{system-supervision,system-supervision-proof,manager-selection,credential-files,system-credentials}.ts | Separate disabled processing entry; loopback GET /live,/ready,/metrics; explicit user/system adapters | backend/src/background-checks/*.check.ts; background-db-checks; canary-checks; retained graceful/parent-exit/runtime-expiry synthetic receipts passed with cleanup. Synthetic Python units are NOT application-worker proof |
| E-SUM | ai-service/summary_contracts/*; summary_service/{app,provider,protocol,workflow}.py; backend/src/summaries/{contracts,validation,routes,client,executor,executor-entry}.ts | POST /api/v1/documents/:id/summary-jobs; GET /api/v1/summary-jobs/:jobId; GET /api/v1/documents/:id/summary; private POST /internal/v1/report-summaries:generate | ai-service/tests/test_{contracts,service}.py; backend/src/summary-checks/*; APIs need enabled server options/catalogue; Node transport injected only, fake recipe; service/executor default disabled |
| E-SUMDB | backend/migrations/0004_medical_summary_jobs.sql; backend/src/summaries/jobs.ts; infrastructure/summary-db/* | Immutable extraction snapshots; independent lease-fenced summary jobs/publication; not OCR jobs | backend/src/summary-db-checks/{jobs,lifecycle}.check.ts; summary-checks/{jobs,executor}.unit.ts; historical PostgreSQL16 73 summary tests; migration 0004 only isolated evidence, persistent deployment unknown |
| E-EVAL | ai-service/summary_evaluation/*; summary_benchmark/{contracts,preparation,offline}.py; shared/medical-summary/{fixtures,evaluation,benchmark,glossary-v1.json,v1.schema.json} | Offline evaluator/preparation; no real-provider benchmark command | 42 expected synthetic evaluation outcomes; 12 frozen held-out fake cases; clinical/glossary review pending; pin/reproducibility tests |
| E-OLL | ai-service/summary_benchmark/{ollama_local,ollama_http,ollama_session}.py; ai-service/tests/test_ollama_local.py | Explicit local provider/bridge/transport only; no live benchmark launcher | 46 fake-only tests documented in Phase 3A.5C; model digest/version/schema/measurement/thinking/timeout gates; host verifier and real token accounting not in repository |
| E-RAGSCHEMA | backend/migrations/0001_initial_schema.sql: medical_document_chunks, rag_interactions, rag_interaction_sources and integrity triggers | No RAG/chunk/embedding/vector/query service/API | Schema integrity tests only. No pgvector extension/index, vector generation, LangChain/LangGraph or retrieval evaluation |
| E-SHARESCHEMA | backend/migrations/0001_initial_schema.sql: doctor_sharing_grants, sharing_grant_documents, doctor_otp_challenges | No grant/QR/link/OTP/doctor session/revocation routes | Composite ownership and hashed-OTP schema fields only; not actual authorization/OTP/delivery tests |
| E-EMAILSCHEMA | backend/migrations/0001_initial_schema.sql: guardian_contacts, guardian_notification_events, serious_finding_evaluations | No guardian-contact/notification/rules/email-provider APIs or worker | Schema constraints only; clinical rules and email delivery not implemented |
| E-UI | mobile/ and web/ are empty at audit | No frontend routes/components/build/application | No mobile/web E2E, accessibility or usability tests |
| E-INFRA | infrastructure/docker-compose.yml; database-roles.sql; stage-b/*; summary-db/*; backend/src/database/* | Dedicated local PostgreSQL16 127.0.0.1:5433, role/migration tools; isolated no-network harnesses | Historical disposable receipts; no running container/DB/AWS inspected; no full production IaC/deployment/restore evidence |
| E-ISO | infrastructure/stage-b/{run,isolation,bootstrap,run-tests}; infrastructure/summary-db/*; synthetic test fixtures | Disposable network-isolated PostgreSQL16 and fake cloud transports | Retained Stage B/summary receipts, synthetic-only fixtures; no harness or mutation test executed in B00 |
| E-DOCS | docs/PHASE_*.md; this B00 ledger; SRS v3 §§8.4,10,18 | Review-controlled iterations and documented boundaries | Historical test counts are scoped/different runs; never add them into a current full-system pass count |

Paths below are repository-relative; `migrations/` under E-AUTH/DOC means `backend/migrations/`. Braces identify exact filename alternatives, not generated functionality. Test files were inspected, not executed. Historical receipts were inspected through allowlisted aggregate booleans/counts; no private manifests, credentials, object keys or medical report contents were displayed.

## Primary requirements matrix

| Source ID | Exact SRS behavior | Role / dependencies | Implementation | T | I | E | Evidence | Remaining phases |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FR-001 | The system shall support patient account registration. | Patient; NFR-01/02; restricted persistence | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-AUTH | B02 B18; B21 |
| FR-002 | The system shall support patient login and authentication. | Patient; FR-001; NFR-01 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-AUTH | B02 B18; B21 |
| FR-003 | The system shall allow authenticated patients to manage their profile. | Patient; FR-002 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-AUTH | B02 B18; B21 |
| FR-004 | Patients shall upload medical documents as scanned PDF files or images using the mobile application. | Patient; FR-002/005/010; FR-034 | Partially implemented | Yes | Partial | No | E-DOC, E-OCR, E-LIVE | B02 B03 B17 B18; B21 |
| FR-005 | The system shall store uploaded medical document originals in AWS S3. | Patient; storage service; FR-002/010; NFR-01 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-DOC, E-LIVE | B02 B17 B20; B21 |
| FR-006 | The system shall maintain searchable record metadata including hospital name and document or upload date. | Patient; FR-004/005 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-DOC, E-DB | B02 B07 B18; B21 |
| FR-007 | The system shall categorize medical documents, including relevant categories such as lab reports and prescriptions. | Patient; processing service; FR-006/012 | Partially implemented | Yes | Partial | No | E-DOC | B02 B04 B18; B21 |
| FR-008 | Patients shall be able to view and manage their uploaded medical records. | Patient; FR-002/005/006 | Partially implemented | Yes | Partial | No | E-DOC | B02 B18 B19; B21 |
| FR-009 | Patients shall search and filter medical documents by hospital name and upload date. | Patient; FR-002/006 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-DOC | B02 B18; B21 |
| FR-010 | The system shall validate medical records for integrity and acceptable processing as described in the proposal. | Patient; processing service; FR-004; NFR-07 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-DOC, E-OCR | B02 B19; B21 |
| FR-011 | The system shall perform OCR when uploaded medical reports are scanned or image based and extraction is required. | Patient; processing service; FR-004/005/010 | Implemented (backend/process scope) | Yes | Yes (subsystem) | No | E-OCR, E-LIVE | B03 B17 B18; B21 |
| FR-012 | The system shall extract relevant text/information and create structured data used by categorization and retrieval. | Patient; AI/retrieval services; FR-011 | Partially implemented | Yes | Partial | No | E-OCR, E-SUMDB | B04 B09 B17; B21 |
| FR-013 | The system shall produce a chronological medical-history timeline using available uploaded record dates. | Patient; FR-006 | Partially implemented | Yes | Partial | No | E-DOC, E-DB | B07 B18; B21 |
| FR-014 | Authorized healthcare professionals shall be able to view patient history and timeline for records shared with them. | Authorized healthcare professional; FR-013/025/028/029 | Not implemented | No | No | No | E-DB | B07 B13 B14 B18; B21 |
| FR-015 | The system shall generate an understandable AI-assisted summary for uploaded medical reports. | Patient; authorized professional; FR-012; trusted catalogue; approved model | Partially implemented | Yes | Partial | No | E-SUM, E-SUMDB, E-EVAL, E-OLL | B04 B05 B06 B14 B18; B21 |
| FR-016 | The system shall generate AI-assisted summaries of available patient medical history. | Patient; authorized professional; FR-013/015; multi-document scope | Not implemented | No | No | No | E-SUMDB | B07 B08 B14 B18; B21 |
| FR-017 | The system shall enable patients to ask natural-language questions about their own uploaded records. | Patient; FR-018/020/021/023 | Not implemented | No | No | No | E-RAGSCHEMA | B09 B10 B11 B18; B21 |
| FR-018 | RAG answers shall retrieve and be grounded in the particular patient’s uploaded records rather than unrelated records. | Patient; authorized professional; FR-020/025 | Not implemented | No | No | No | E-RAGSCHEMA | B09 B10 B14 B19; B21 |
| FR-019 | The system shall provide natural-language retrieval of relevant medical documents from the records the requester is authorized to access. | Patient; authorized professional; FR-018/020/025 | Not implemented | No | No | No | E-RAGSCHEMA, E-DOC | B09 B10 B14 B18; B21 |
| FR-020 | The system shall use embeddings, chunking, vector search/retrieval and grounded generation for RAG processing. | AI/retrieval services; FR-012; CFG-02 | Not implemented | No | No | No | E-RAGSCHEMA | B09 B10; B21 |
| FR-021 | Agent-based orchestration shall support the multi-step record-retrieval and summarization tasks where needed. | AI/retrieval services; FR-015/016/020; DEC-03 | Partially implemented | Partial | Partial | No | E-SUM, E-EVAL | B06 B10 B11 B17; B21 |
| FR-022 | Authorized healthcare professionals shall be able to access AI-assisted record summaries and insights for accessible patient records. | Authorized healthcare professional; FR-015/016/025/028 | Not implemented | No | No | No | E-SUMDB, E-DB | B08 B13 B14 B18; B21 |
| FR-023 | The AI shall be informational and assistive and shall not independently diagnose, replace a medical professional or make final clinical decisions. | Patient; authorized professional; FR-015–022; NFR-04 | Partially implemented | Yes | Partial | No | E-SUM, E-EVAL, E-OLL | B04 B05 B08 B10 B11 B16 B19; B21 |
| FR-024 | Any symptom-related suggestions shall remain non-diagnostic and oriented toward consultation with qualified professionals. | Patient; authorized professional; FR-023; DEC-06; approved safety wording | Not implemented | No | No | No | E-SUM | B11 B18 B19; B21 |
| FR-025 | Healthcare professionals shall view only patient information for which patient access authorization has been granted. | Authorized healthcare professional; FR-030/028; DEC-10 | Not implemented | No | No | No | E-SHARESCHEMA | B13 B14 B19; B21 |
| FR-026 | The patient application shall display a patient QR code for doctor/healthcare-professional sharing as described in the project scope. | Patient; healthcare professional; FR-025/028/030 | Not implemented | No | No | No | E-SHARESCHEMA | B13 B14 B18; B21 |
| FR-027 | The application shall support a unique sharing link for a doctor in the online-appointment use case. | Patient; doctor; FR-025/028/030 | Not implemented | No | No | No | E-SHARESCHEMA | B13 B14 B18; B21 |
| FR-028 | Access via the unique sharing link shall include verification by OTP through the doctor’s email. | Doctor; email service; FR-027; CFG-04; email adapter | Not implemented | No | No | No | E-SHARESCHEMA | B12 B14 B18; B21 |
| FR-029 | The doctor web interface shall provide access to authorized records and permit searching and filtering. | Authorized healthcare professional; FR-025/028; FR-006/009 | Not implemented | No | No | No | E-SHARESCHEMA, E-DOC | B13 B14 B18; B21 |
| FR-030 | The patient shall be able to initiate/request secure sharing of records from the user interface. | Patient; FR-002/025; DEC-10 | Not implemented | No | No | No | E-SHARESCHEMA | B13 B14 B18; B21 |
| FR-031 | On patient document upload, the system shall email a report copy and report summary to the patient guardian. | Patient; authorized guardian; FR-015; DEC-05; CFG-11 | Not implemented | No | No | No | E-EMAILSCHEMA | B12 B15 B17 B18; B21 |
| FR-032 | The system shall email the guardian when a report is potentially serious under the system’s defined rules. | Authorized guardian; rules service; FR-031; DEC-11; CFG-06/07 | Not implemented | No | No | No | E-EMAILSCHEMA | B12 B16 B17 B19; B21 |
| FR-033 | The system shall use email services or APIs for the guardian notifications. | Email service; guardian; FR-031/032; CFG-04/11 | Not implemented | No | No | No | E-EMAILSCHEMA | B12 B15 B16 B20; B21 |
| FR-034 | The system shall provide a React Native patient mobile interface. | Patient; FR-001–013/015–024/026/030/031; DEC-02 | Not implemented | No | No | No | E-UI | B18 B19 B21; B21 |
| FR-035 | The system shall provide a web interface using React.js or Next.js for authorized access and relevant patient functions. | Authorized professional; patient web TBD; FR-014/022/025–030; DEC-02/09; CFG-13 | Not implemented | No | No | No | E-UI | B18 B19 B21; B21 |
| FR-036 | The system shall provide categorized document search and summaries through the supported interfaces as appropriate to user authorization. | Patient; authorized professional; FR-007/009/015/016/025; FR-034/035 | Partially implemented | Partial | Partial | No | E-DOC, E-SUM, E-UI | B06 B08 B14 B18 B21; B21 |
| NFR-01 | Medical document storage and record access shall be secured; clinician access shall be constrained to information permitted by the patient. | All actors; operator; All ownership/sharing; DEC-08 | Partially implemented | Yes | Partial | No | E-AUTH, E-DOC, E-DB, E-SUP | B02 B03 B12 B13 B14 B19 B20; B21 |
| NFR-02 | Testing shall rely on test or de-identified patient data; real patient data shall require permission/authorization. | Developers/testers; data owner; §5.2; authorization before identifiable data | Implemented (backend/process scope) | Yes | Partial | No | E-EVAL, E-LIVE, E-ISO | B01 B19 B21; B21 |
| NFR-03 | Patients and professionals shall be able to locate and understand medical information conveniently; summaries shall use simple language. | Patient; professional; FR-013–024/034–036; CFG-10 | Partially implemented | Partial | Partial | No | E-SUM, E-UI | B07 B08 B18 B19; B21 |
| NFR-04 | Answers and summaries shall be based on the user’s uploaded record information; clinical judgment remains with healthcare professionals. | Patient; professional; clinical reviewer; FR-015–024; successful source extraction | Partially implemented | Yes | Partial | No | E-SUM, E-EVAL, E-OLL | B04 B05 B06 B08 B09 B10 B11 B19; B21 |
| NFR-05 | Modules shall be built in Agile iterations with testing, review, feedback, integration and refinement. | Development team; §8.4/10/18; change control | Implemented (backend/process scope) | Partial | Partial | No | E-DOCS, E-ISO | B01 B17 B18 B21; B21 |
| NFR-06 | Cloud services and AWS computing or suitable alternatives shall support deployed application components. | Operator; external services; DEC-01/08; CFG-08/09 | Partially implemented | Partial | Partial | No | E-INFRA, E-LIVE, E-SUP | B03 B12 B19 B20 B21; B21 |
| NFR-07 | Patient records shall be validated for safe, appropriate handling and processing. | Patient; processing service; FR-010/011; CFG-03 | Implemented (backend/process scope) | Yes | Partial | No | E-DOC, E-OCR | B02 B03 B17 B19; B21 |
| NFR-08 | React Native mobile, React/Next web, Node/Express backend and Python AI/document processing shall interoperate. | All clients; services; DEC-01–03; FR-034/035 | Partially implemented | Partial | Partial | No | E-SUM, E-SUMDB, E-UI | B03 B06 B11 B18 B20 B21; B21 |

## Per-requirement delivery and acceptance details

| Source ID | Backend implemented / remaining | Frontend required / remaining | Acceptance and security/privacy |
| --- | --- | --- | --- |
| FR-001 | Registration, validation, normalized email, Argon2id and duplicate handling implemented. No new account features are inferred. | React Native registration UI remains absent (FR-034). | Register valid synthetic patient; reject invalid/duplicate input; no password/hash in response; AT-01/V-01. |
| FR-002 | Login, bounded password verification, strict signed JWT claims and authenticated middleware implemented. | Mobile login and secure token handling absent. | Valid login works; bad credentials/expired/forged/wrong-audience tokens denied without identifier leakage; AT-01/V-01. |
| FR-003 | GET/PATCH own profile uses authenticated subject and allowlisted fields. | Profile viewing/editing absent. | Anonymous denied; A cannot read/change B profile; invalid/protected fields rejected; AT-01/V-01. |
| FR-004 | Authenticated multipart PDF/JPG/JPEG/PNG API exists; full mobile upload and automatic lifecycle not integrated. | File selection/camera/upload, progress and failures absent. | Mobile uploads each accepted type; reject unsupported/damaged/oversized inputs; AT-02/V-03/04. |
| FR-005 | Private S3 adapter verifies bucket security, owner and encryption; conditional checksum upload and compensation implemented. Deployment-wide verification remains open. | Upload state and authenticated original access must be connected. | Original private, correct owner/hash; anonymous/foreign access denied; retain original after processing failure; AT-02/V-02/03. |
| FR-006 | Hospital, document date, upload timestamp and category persist and project/search through scoped repository. | Metadata entry/display and filters absent. | Independent document/upload dates retained; hospital/date metadata searchable only within scope; AT-03/V-07. |
| FR-007 | Validated category selection and metadata patch/filter exist. B02 qualifies explicit patient category assignment/edit/filter in isolated backend tests; no AI classifier or complete mobile assignment flow is claimed. | Approved lab/prescription/other selection and display absent. | Approved categories assigned and filterable; clarify whether source requires automatic enrichment before closure; AT-03/V-03/07. |
| FR-008 | Scoped list/detail/metadata edit and authenticated original-byte delivery exist. B02 removes public presigned URLs and rechecks ownership/storage identity before bytes. No deletion feature is inferred; doctor grants and live deployment remain later gates. | Record list/detail, original viewer/download and metadata editing absent. | Owner can view/manage; unknown/foreign denial identical; possession of a guessed identifier/URL is insufficient per agreed §14.1 policy; AT-02/V-02. |
| FR-009 | Hospital equality (case-insensitive), upload-date bounds, category, bounded pagination and scoped SQL implemented. No full-text/semantic search claimed. | Patient filter/search UI absent. | All and only matching own records returned; verify date bounds, pagination and escaping; AT-03/V-07. |
| FR-010 | Extension/MIME/signature, bounded size, parse/decode integrity, SHA-256 and processing-source validation implemented. Release quotas still require CFG-03 approval. | Clear unsupported/damaged/oversize errors absent. | Reject invalid file without accessible partial record; handle ambiguous storage/DB outcomes safely; AT-03/V-04. |
| FR-011 | Actual Node PDF.js/Tesseract/Poppler processing covers images/scanned/mixed PDFs. Scoped manual synthetic flow historically passed; automatic service remains disabled. | Processing/OCR status and retry UI absent. | Correct original yields ordered native/OCR pages and source hash; resources/children cleaned; AT-04/V-05. |
| FR-012 | Text and structured extraction/source/page metadata exist; no production medical-fact catalogue, chunking or retrieval-ready semantic indexing pipeline. | Evidence/error/processing presentation absent. | Relevant structured information and source linkage usable for categorization/retrieval; failed extraction never masquerades as grounded input; AT-04/V-05/06. |
| FR-013 | Date ordering/index plus sort_date_source provide timeline foundation; no dedicated timeline experience/API contract. | Timeline with documented-date vs upload fallback labels absent. | Chronology uses known document dates; fallback explicitly labelled, no invented events; AT-05/V-08. |
| FR-014 | No clinician timeline/history endpoint; grant tables alone are not implementation. | Doctor timeline/history view absent. | Only currently selected, OTP-authorized, unexpired/unrevoked records appear; AT-05/V-08/14/15. |
| FR-015 | Strict contracts/rendering, fake FastAPI, disabled APIs and lease-fenced jobs exist. No automatic fact catalogue, real runtime transport/composition or evaluated production model. | Report summary and limitations/source UI absent. | Actual permitted report generates understandable evidence-grounded summary with exact values; source changes/stale attempts fenced; AT-06/V-09/11/19. |
| FR-016 | No longitudinal summary contract, snapshot/job/storage or API. Per-report summary table is not history summarization. | Medical-history summary UI absent. | Multi-report dated summary cites permitted sources, preserves contradictions/unknowns and date fallback; AT-06/V-09. |
| FR-017 | No natural-language question API or working RAG service. | Patient record Q&A UI absent. | Ask present/absent-fact questions; answer from own records or state insufficiency; AT-07/V-10/11/19. |
| FR-018 | RAG tables have ownership references, but no patient-filtered retrieval implementation. | Source citations/insufficiency display absent. | No foreign/denied/revoked content retrieved at query execution; AT-07/V-10/14/15. |
| FR-019 | No natural-language document retrieval; metadata filtering is a separate implemented capability. | Natural-language search and authorized result viewer absent. | Relevant permitted documents returned with source references; cross-scope requests denied; AT-07/08/V-10/15. |
| FR-020 | Chunk table exists, but no chunker/embedder/vector column/index/search pipeline. Installed nomic model is not application integration. | Retrieval status/citations through supported interfaces absent. | Measured embedding/index suitability, stable chunk linkage, scoped retrieval and grounded generation pass; AT-07/V-10/11. |
| FR-021 | Deterministic bounded fake summary workflow exists. Required LangChain retrieval/LangGraph orchestration and record-retrieval tools are absent. | Workflow progress/failure feedback through clients absent. | Typed bounded graph uses permitted retrieval/summarization only; timeout/cancellation and injection tests pass; AT-07/V-10/11/19. |
| FR-022 | No doctor-authorized summaries/insights endpoint or service composition. | Doctor summary/insights view absent. | Doctor sees/generates summaries solely from current selected grant scope; AT-08/V-09/14/15. |
| FR-023 | Summary validators/glossary forbid unsupported patient-specific output in isolated tests. No deployed model, RAG/symptom safety workflow or clinical validation. | Non-diagnostic explanations/warnings and evidence UI absent. | No independent diagnosis/prescription/final treatment; supported source diagnoses remain correctly attributed; AT-09/V-19 plus adversarial suites. |
| FR-024 | No symptom-related general education or consultation/visit-guidance endpoint. Glossary definitions are not this feature. | Safe symptom education/consultation guidance absent. | General educational information with appropriate professional-contact advice; no diagnosis/prescribing/final treatment; AT-09/V-19. |
| FR-025 | No running grant authorization/doctor access middleware. Composite grant-document FKs are schema scaffolding only. | Grant-aware doctor views and patient authorization controls absent. | Every document/AI/file request checks selected records, email OTP, expiry and revocation; AT-02/08/V-12–15. |
| FR-026 | No QR grant/token generation/redemption flow. | Patient-displayed QR and doctor scan/landing/OTP absent. | QR itself discloses no record content; doctor OTP and permission required; AT-10/V-12/15. |
| FR-027 | No unique-link issue/redemption flow; appointment context does not authorize booking. | Patient sharing and doctor link landing absent. | Opaque unique link binds selected records/recipient and requires OTP; AT-11/V-13–15. |
| FR-028 | Hashed-OTP table exists; no challenge generation/send/verify/session or abuse protection service. | Doctor email OTP input/resend/errors absent. | Valid/invalid/expired/replayed OTP, attempt/rate bounds and email binding verified; no plaintext OTP storage; AT-11/V-13. |
| FR-029 | No clinician read/search/filter APIs; patient endpoints do not authenticate doctor sessions. | React + Vite doctor interface absent. | Only selected permitted records returned, including filters and expiry/revocation checks; AT-08/V-14/15. |
| FR-030 | No authenticated grant create/select/revoke routes. | Select records, recipient, QR/link and immediate revoke absent. | Owner alone creates scoped grant; selection and revocation persist/enforce across all consumers; AT-10/11/V-12–15. |
| FR-031 | Contact/event tables only; no consenting-recipient API, outbox or report+summary email delivery. | Patient guardian consent/contact and delivery-state UI absent; no guardian portal. | After successful processing, correct authorized guardian receives report copy and corresponding summary; AT-12/V-16/23. |
| FR-032 | Serious-evaluation table only; no reviewed rules, indeterminate handling, cautious AI explanation or separate alert dispatch. | Patient-visible outcome/notification state; guardian receives separate email, no login UI. | Reviewed trigger yields routine plus separate alert; ambiguous input indeterminate, never reassuringly normal; AT-12/V-17/18. |
| FR-033 | No email-provider adapter, queue/outbox, bounce/delivery processing or retry/dead-letter workflow. | Bounded safe delivery status/resend policy as approved; no secret exposure. | Real synthetic-recipient delivery/failed-delivery evidence; no duplicate logical notifications; AT-12/V-16/17. |
| FR-034 | APIs partially reusable; mobile directory is empty. | Entire React Native patient app required by scope. | Mobile auth/profile/upload/manage/filter/timeline/summary/Q&A/sharing/guardian controls integrated and usable; AT-13/V-22/23. |
| FR-035 | No web client; web directory is empty. | React + Vite doctor guest-access application; patient web only if CFG-13 approved. | Doctor OTP-bound scoped workflows usable; no mandatory permanent doctor account; AT-13/V-22/23. |
| FR-036 | Category search backend exists and disabled fake report-summary APIs exist. No integrated authorized client search/summary experience. | Both supported interfaces need permitted categorized search and summaries. | Integrated clients expose only permitted categorized records and understandable grounded summaries; AT-13/V-07/09/15/23. |
| NFR-01 | Patient middleware/scoped SQL, composite FKs, private-S3 checks and some rate limits implemented. No doctor authorization, full revocation, release threat model or deployment security proof. | Secure client/session/file handling absent. | No unauthorized content across API/file/index/AI/email; HTTPS/secrets/least privilege and revocation tested; V-02/12–15/20. |
| NFR-02 | Synthetic fixtures and isolated, credential-free/fake-only test patterns implemented and documented; no authorization for real-patient data is inferred. | Synthetic/de-identified demonstrations and approved real-data gate across clients. | AT-14 and source/data-use review prove synthetic-only defaults; real data requires explicit permission and privacy approval. |
| NFR-03 | Deterministic plain-language rendering/glossary exists. No mobile/web usability or accessibility evaluation. | Navigation, readable terminology/evidence/uncertainty and accessibility required. | Representative users locate/understand records/summaries; approved measurable accessibility/usability thresholds pass; V-22. |
| NFR-04 | Exact summary evidence/numerics/provenance validators and synthetic evaluator exist. No real-model/RAG/longitudinal grounding or clinical signoff. | Clear citations, missing-data/uncertainty and clinician-judgment boundaries. | No unsupported facts/clinical decisions; missing-source, OCR, contradiction, injection and scope cases pass; V-09–11/19. |
| NFR-05 | Incremental phase documents, review gates, factories, isolation harnesses and tests exist. Integration/refinement remains ongoing, not release complete. | Client iterations/review still required. | Reviewed increments, reproducible tests, feedback, integration and refreshed traceability exist for every delivery; V-24. |
| NFR-06 | Local PostgreSQL compose, private-S3 synthetic verification and disposable test harnesses exist. No verified AWS API/AI/RDS/vector/email deployment, restore, monitoring or HTTPS system. | Approved deployed clients must target deployed backend securely. | AWS deployment with private S3, RDS, HTTPS, approved secrets/monitoring/backups and restore evidence; V-20/21. |
| NFR-07 | Bounded upload, integrity parsing, original checksums, source validation and native-process limits implemented for accepted formats. Broader AI/rules review remains separate. | Clear actionable validation/retry errors. | Bad/oversized/corrupt inputs rejected; interrupted processing retains original and reports failure; V-04–06. |
| NFR-08 | Node/Express, PostgreSQL and Python factory/contracts exist; Node↔ASGI mocked tests pass historically. No production HTTP composition or clients; OCR currently runs in Node, not Python. | React Native and React/Vite integrated clients absent. | Actual supported-stack interoperability and full synthetic flow demonstrated; architecture deviations explicitly approved; V-20/23. |

## Unnumbered source obligations — audit-assigned tracking IDs

These IDs do **not** rename or replace original SRS IDs. Exact clause text is retained; role/backend/frontend/dependencies/security and acceptance inherit the listed primary requirements and target-phase DoD. An implemented parent cannot close while one of its required subclauses remains open. Details intentionally repeated by the SRS remain linked, not silently discarded. §§5.1/15 logical entities are covered together in TRK-15 rows; §8.2 data flow is verified through UC-02/04/05/08 and V-23. Proposal checklist §13 and inherited traceability §9.2 are reconciled against the complete primary matrix rather than treated as extra product requirements.

| Tracking ID (assigned) | Source | Exact intended clause / logical minimum | Parent obligation | Target phases (+B21) | Current disposition |
| --- | --- | --- | --- | --- | --- |
| TRK-2.1-01 | §2.1 | Patients have fragmented paper and digital medical records across hospitals, clinics and laboratories. The system shall provide a centralized personal collection of medical records, simplify retrieval and summarization, permit patient-authorized professional access, and support guardian communication. Main healthcare context: Pakistan. | FR-004–009/025/031 | B02 B12 B14 B21 | P: central record foundation only; sharing/guardian missing |
| TRK-2.3-01 | §2.3 | The project is informational and assistive. It shall not independently diagnose diseases, replace qualified professionals or make final clinical decisions. The proposal mentions symptom-oriented “best opinion” and a doctor-visit cycle; these must be implemented, if retained, strictly within this non-diagnostic boundary and require DEC-06 safety boundaries. | FR-023/024; DEC-06 | B11 B19 B21 | P: summary guardrails only |
| TRK-5.2-01 | §5.2 | Each medical record belongs to a patient and retains its associated source document. | FR-005/012; NFR-01 | B02 B04 B09 | P: originals/extraction linked, future derivatives missing |
| TRK-5.2-02 | §5.2 | Only the owning patient or an appropriately authorized healthcare professional can retrieve sensitive patient record content. | FR-025; NFR-01 | B02 B13 B14 B19 | P: patient-only scope, no doctor authorization |
| TRK-5.2-03 | §5.2 | Uploaded original files are stored on AWS S3; hospital/date/category metadata remains searchable. | FR-005/006/007/009 | B02 B18 B20 | P: storage/metadata backend exists, full client/release open |
| TRK-5.2-04 | §5.2 | OCR text, indexed chunks, vector representations, summaries and chronology must remain associated with the correct original document and patient. | FR-012/016/018/020 | B04 B08 B09 B10 | P: extraction ownership exists; index/history missing |
| TRK-5.2-05 | §5.2 | Development/testing uses synthetic or de-identified patient data, unless permission and authorization to use identifiable records have been obtained. | NFR-02 | B01 B19 B21 | I: synthetic isolated practice; real data requires new authorization |
| TRK-5.3-01 | §5.3 Patient mobile app | React Native; register, login, profile, upload/view records, search/filter, QR sharing, summaries, timeline and RAG Q&A (§5–§8). | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B18 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-5.3-02 | §5.3 Web application | React.js or Next.js; doctor access to authorized records, search/filter, AI insights and history/timeline; proposal also mentions patient-friendly web access (§5, §8; diagram). | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B18 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-5.3-03 | §5.3 Backend APIs | Node.js + Express.js deliver application backend interfaces; appropriate Python service handles AI and processing (§8). API route contracts are not specified. | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B02 B06 B17 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-5.3-04 | §5.3 Storage | AWS S3 for uploaded documents; storage keys and encryption configuration are implementation decisions (§6, §8). | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B02 B20 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-5.3-05 | §5.3 Data persistence | MongoDB and/or PostgreSQL depending on component needs (§8). | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B09 B20 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-5.3-06 | §5.3 AI / retrieval | Suitable AI model service or open-source service; vector retrieval, embeddings, chunking, grounded generation; LangChain/LangGraph where required (§8). | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B05 B09 B10 B11 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-5.3-07 | §5.3 Email | Email service/API sends guardian report copies, summaries and serious-report notifications; doctor email is used for sharing OTP (§1, §4, §8). | FR-034/035; NFR-08; DEC-01–03/08 as applicable | B12 B14 B15 B16 | P or M by component: see E-UI/INFRA/SUM/RAGSCHEMA/EMAILSCHEMA; confirmed DEC choices refine proposal alternatives |
| TRK-6-01 | §6 | Use OCR for scanned medical reports/images when required, then process extracted text for indexing and summaries. | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B03 B04 B09 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-6-02 | §6 | Use document chunking, embeddings, vector search, retrieval and grounded generation for patient-record RAG. | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B09 B10 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-6-03 | §6 | Use LangChain and/or LangGraph only where orchestration is needed; exact framework remains a choice. | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B10 B11 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-6-04 | §6 | Patient and authorized professional responses must be scoped to permitted patient documents. | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B10 B14 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-6-05 | §6 | Generated summaries and Q&A remain assistive and understandable; they do not independently diagnose or make final treatment decisions. | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B05 B11 B19 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-6-06 | §6 | Serious-report guardian alerts depend on system-defined rules not provided by the proposal (DEC-11). | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B16 B19 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-6-07 | §6 | Specific LLM names, model versions, evaluation metrics, clinical review procedure and evidence UI are not mandated by the proposal. | FR-011/012/015–024/032; NFR-04; DEC-03/06/11 | B01 B05 B19 | P: extraction/summary controls only; clinical/RAG requirements open; later §14.4/DEC-03 makes LangChain+LangGraph explicit |
| TRK-7-01 | §7 engineering-control paragraph | Production-level security and operational measures (such as least-privilege IAM, encrypted transit, secrets management, input validation, access revocation, audit evidence, monitoring, backup/recovery and rate limiting) are engineering and acceptance design decisions to formalize; the proposal does not specify their values or authorize them as standalone user-facing features. | NFR-01/05/06; CFG-03–12 | B02 B03 B12 B19 B20 B21 | P: values are controlled decisions, not standalone new product features |
| TRK-8.1-01 | §8.1 | Patient React Native mobile app and React.js + Vite doctor web interface connect to the Node.js/Express API for authentication, patient ownership, record metadata, sharing, OTP and email. PostgreSQL on Amazon RDS is the primary database; private AWS S3 stores original documents. Python FastAPI handles OCR and AI processing with LangChain, LangGraph and a hosted LLM; pgvector is the preferred vector index if suitability testing passes. Exact API endpoints, model/provider and AWS compute sizing are technical-design TBDs. | DEC-01/02/03/08; NFR-08 | B03 B06 B09 B11 B18 B20 | P: Node OCR/local benchmark differs from confirmed Python/hosted target; review required |
| TRK-8.3-01 | §8.3 | The confirmed design implements both (a) a patient-displayed QR code for healthcare-professional access and (b) a unique link verified using an OTP sent to the doctor email for an online consultation. Neither flow may be dropped; whether they use different or shared access grants and record selection, doctor email OTP, time-limited access and revocation are confirmed. | FR-025–030; DEC-04/10 | B13 B14 B18 | M: neither sharing path implemented |
| TRK-9.3-01 | §9.3 | Verify record ownership boundaries for every storage, search, sharing and RAG path. | All related FR/AT/V; DEC-12 | B02 B10 B14 B19 | P: isolated/partial historical evidence only; final release test missing |
| TRK-9.3-02 | §9.3 | Test image and scanned-PDF extraction against selected representative documents and verify association with originals. | All related FR/AT/V; DEC-12 | B03 B19 | P: isolated/partial historical evidence only; final release test missing |
| TRK-9.3-03 | §9.3 | Test unauthorized doctor access and invalid link/OTP attempts without accidentally exposing record content. | All related FR/AT/V; DEC-12 | B14 B19 | P: isolated/partial historical evidence only; final release test missing |
| TRK-9.3-04 | §9.3 | Check that guardian delivery occurs under the approved event policy and severe-report rules. | All related FR/AT/V; DEC-12 | B15 B16 B19 | P: isolated/partial historical evidence only; final release test missing |
| TRK-9.3-05 | §9.3 | Test that AI does not state independent diagnosis or decisions and that answers derive from authorized records. | All related FR/AT/V; DEC-12 | B05 B10 B11 B19 | P: isolated/partial historical evidence only; final release test missing |
| TRK-9.3-06 | §9.3 | Record reproducible test evidence and blockers against the FR and AT identifiers. | All related FR/AT/V; DEC-12 | B01 B21 | P: isolated/partial historical evidence only; final release test missing |
| TRK-10.1-01 | §10.1 | All FR-001 to FR-036 have executable evidence; the original AT-01 to AT-14 plus expanded V-01 to V-24 pass; no patient data is exposed without authorization; the patient mobile app, clinician web access, backend, persistence, S3, OCR, AI/RAG and guardian email paths work in the integrated deployment. | All FR/NFR/AT/V | B21 | M: no complete integrated deployment or final acceptance |
| TRK-10.2-01 | §10.2 | Confirm all decisions that affect database, auth/sharing, guardian emails and AI safety. | DEC-01–12; CFG-01–14; all FR/NFR | B01 B19 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-02 | §10.2 | Confirm environment and service providers; configure least privilege, secrets and non-public patient storage. | DEC-01–12; CFG-01–14; all FR/NFR | B19 B20 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-03 | §10.2 | Provision chosen database/storage/compute/email/vector/AI services with reproducible configuration. | DEC-01–12; CFG-01–14; all FR/NFR | B09 B12 B20 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-04 | §10.2 | Deploy and connect app clients, API, processing workers and document services. | DEC-01–12; CFG-01–14; all FR/NFR | B03 B06 B17 B18 B20 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-05 | §10.2 | Run identity, authorization and patient-data-isolation security tests. | DEC-01–12; CFG-01–14; all FR/NFR | B19 B21 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-06 | §10.2 | Verify the report-copy/summary/alert communication flows and failure handling. | DEC-01–12; CFG-01–14; all FR/NFR | B15 B16 B21 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-07 | §10.2 | Run end-to-end mobile-to-backend-to-storage-to-AI-to-doctor tests with synthetic/de-identified information. | DEC-01–12; CFG-01–14; all FR/NFR | B18 B21 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-08 | §10.2 | Record deployment configuration, operational ownership, data recovery and rollback decisions. | DEC-01–12; CFG-01–14; all FR/NFR | B19 B20 B21 | Open: final operational/release gate, not authorized by this audit |
| TRK-10.2-09 | §10.2 | Approve release only after source requirements and unresolved questions are reconciled. | DEC-01–12; CFG-01–14; all FR/NFR | B21 | Open: final operational/release gate, not authorized by this audit |
| TRK-11.1-01 | §11.1 | Guardian email: Introduction promises a copy plus summary on every upload; objectives/scope call for a conditional notification if serious or “when required.” Both are confirmed: per-report copy and summary, plus a separate rules-triggered alert. | DEC-02/04/05/06/07/10; relevant FR | B15 B16 | Binding reconciliation: preserve both notification/sharing paths; dates separate; non-diagnostic scope; quotas TBD |
| TRK-11.1-02 | §11.1 | Doctor sharing: Introduction emphasizes doctor-email OTP unique link for online appointments; scope describes QR-presented access for doctor/healthcare professional. Both are confirmed and require patient authorization and doctor-email OTP. | DEC-02/04/05/06/07/10; relevant FR | B13 B14 | Binding reconciliation: preserve both notification/sharing paths; dates separate; non-diagnostic scope; quotas TBD |
| TRK-11.1-03 | §11.1 | Dates: some sections refer to hospital and date of the record; objectives specifically mention upload date. Track document date and upload date independently. Filter by upload date and place records by document date when available. | DEC-02/04/05/06/07/10; relevant FR | B07 | Binding reconciliation: preserve both notification/sharing paths; dates separate; non-diagnostic scope; quotas TBD |
| TRK-11.1-04 | §11.1 | Platform breadth: domain mentions patient-friendly mobile AND web; technology section names React Native patient mobile and React/Next web; React Native is the patient application; React + Vite is the doctor web interface under the confirmed baseline. | DEC-02/04/05/06/07/10; relevant FR | B18 | Binding reconciliation: preserve both notification/sharing paths; dates separate; non-diagnostic scope; quotas TBD |
| TRK-11.1-05 | §11.1 | Symptom guidance: scope mentions a “best opinion/visiting cycle” but explicitly rejects independent diagnosis. Only general education and safety-constrained doctor-visit guidance are allowed; no autonomous diagnosis, prescribing or treatment decisions. | DEC-02/04/05/06/07/10; relevant FR | B11 | Binding reconciliation: preserve both notification/sharing paths; dates separate; non-diagnostic scope; quotas TBD |
| TRK-11.1-06 | §11.1 | Confirmed PDF/JPG/JPEG/PNG, file-type/size/integrity checks, processing states and retry semantics. Exact maximum size remains TBD. | DEC-02/04/05/06/07/10; relevant FR | B02 B03 | Binding reconciliation: preserve both notification/sharing paths; dates separate; non-diagnostic scope; quotas TBD |
| TRK-12-01 | §12 | The proposal does not approve integrated appointment booking, payments, hospital EHR integrations, medication reminders, doctor-patient messaging, prescription generation, independent AI diagnosis, public record browsing or administrative analytics. These should not be inserted into the application plan without new approval. Online appointments are mentioned only as a context for sharing, not as an appointment-booking module. | All FR/NFR; scope/change control | B01 B21 | I as planning control; no excluded feature is added; amendments require explicit approval |
| TRK-12-02 | §12 | Change control: each proposed requirement amendment must name affected FR/NFR/UC/AT identifiers, cite the source or approval, assess security/data impact and update implementation and tests. Architecture decisions that satisfy the proposal can be recorded without presenting them as approved user-facing features. | All FR/NFR; scope/change control | B01 B21 | I as planning control; no excluded feature is added; amendments require explicit approval |
| TRK-14.1-01 | §14.1 | Each patient shall create an authenticated account and manage their own profile; every record, metadata entry, AI result and sharing grant shall be associated with exactly one owner patient. | FR-001–003/025; NFR-01 | B02 B04 B09 B13 | P: owner/extraction/summary subset only |
| TRK-14.1-02 | §14.1 | The API shall enforce patient ownership on reads, updates, queries, file retrieval and AI requests. Possession of a file URL, internal identifier or guessed resource ID shall not substitute for authorization. | FR-001–003/025; NFR-01 | B02 B06 B10 B14 B19 | P: owner/extraction/summary subset only |
| TRK-14.1-03 | §14.1 | A guardian receives permitted emails only; guardian accounts and a persistent doctor account workflow are not part of the approved baseline. | FR-001–003/025; NFR-01 | B12 B14 B18 | P: owner/extraction/summary subset only |
| TRK-14.2-01 | §14.2 | Allow PDF, JPG, JPEG and PNG document uploads from the patient mobile app. Accept a file only after extension, content-type/content-signature, configured size, and integrity checks pass. | FR-004–013; DEC-07 | B02 B18 | P: owner/extraction/summary subset only |
| TRK-14.2-02 | §14.2 | On accepted upload save the original to private S3 and metadata to PostgreSQL. Record hospital name, record/document date when known, upload timestamp, category (lab report, prescription or other), owner and processing status. | FR-004–013; DEC-07 | B02 B04 | P: owner/extraction/summary subset only |
| TRK-14.2-03 | §14.2 | Processing status shall distinguish processing, completed and failed. A failure in OCR, categorization, embedding or summarization shall not erase the original uploaded document. Authorized retry shall use the same owner and original document. | FR-004–013; DEC-07 | B03 B06 B09 B17 | P: owner/extraction/summary subset only |
| TRK-14.2-04 | §14.2 | Medical chronology shall order records by their document date when available; the system shall preserve upload timestamps as separate factual metadata. If document date is unavailable, the UI shall distinguish fallback ordering rather than inventing a document date. | FR-004–013; DEC-07 | B07 B18 | P: owner/extraction/summary subset only |
| TRK-14.2-05 | §14.2 | Patient search and filters shall support hospital name, upload date and category. Returned results shall be restricted to the requester’s own or explicitly shared records. | FR-004–013; DEC-07 | B02 B14 B18 | P: owner/extraction/summary subset only |
| TRK-14.3-01 | §14.3 | Extract machine-readable text where already present; perform OCR when the medical document is scanned or image-only. Preserve linkage between every extracted fragment and the originating document. | FR-011/012/015/016/020 | B03 B04 | P: owner/extraction/summary subset only |
| TRK-14.3-02 | §14.3 | Organize valid extracted text for patient-scoped chunking, embeddings and retrieval. A chunk or embedding shall not become visible to another patient through shared index search. | FR-011/012/015/016/020 | B09 B10 | P: owner/extraction/summary subset only |
| TRK-14.3-03 | §14.3 | Generate a plain-language report summary and a medical-history summary from authorized source content. Distinguish reported values from AI interpretation, and do not invent absent values or diagnoses. | FR-011/012/015/016/020 | B06 B08 | P: owner/extraction/summary subset only |
| TRK-14.3-04 | §14.3 | An OCR or indexing failure shall have an observable failed state and actionable retry path. Do not claim a generated result was grounded in content that was not successfully extracted. | FR-011/012/015/016/020 | B03 B09 B17 | P: B03 scoped extraction status/retry qualified in isolation; indexing and aggregate retry remain B09/B17 |
| TRK-14.4-01 | §14.4 | Patient and authorized doctor prompts shall retrieve only records that requester may access at query execution time; denied, revoked or expired grants shall yield no retrieved content. | FR-017–024; DEC-03/06 | B10 B14 | P: owner/extraction/summary subset only |
| TRK-14.4-02 | §14.4 | The agent shall use LangChain for retrieval and LangGraph for multi-step orchestration as confirmed. External hosted LLM access shall be configured and documented before sending any permitted sensitive information. | FR-017–024; DEC-03/06 | B05 B10 B11 | P: owner/extraction/summary subset only |
| TRK-14.4-03 | §14.4 | Generated answers shall be based on retrieved patient documents and shall indicate when available records do not support an answer; general educational content shall not be misrepresented as the patient’s recorded history. | FR-017–024; DEC-03/06 | B08 B10 B11 | P: owner/extraction/summary subset only |
| TRK-14.4-04 | §14.4 | Symptom-related information shall remain general and non-diagnostic. The assistant may suggest contacting a qualified professional and prompt attention when appropriate, but shall not independently diagnose, prescribe or determine final treatment. | FR-017–024; DEC-03/06 | B11 B19 | P: owner/extraction/summary subset only |
| TRK-14.4-05 | §14.4 | AI quality tests shall include hallucination, missing source, cross-patient leakage, contradictory reports, ambiguous OCR and prompt-injection attempts embedded in documents. | FR-017–024; DEC-03/06 | B04 B05 B08 B10 B19 | P: owner/extraction/summary subset only |
| TRK-14.5-01 | §14.5 | Patient can authorize specific selected records for a doctor. A physical consultation uses a patient-displayed QR; an online consultation uses a unique link. Both shall reach a doctor-email OTP verification step. | FR-025–030; DEC-04/09/10 | B13 B14 B18 | M: schema exists but workflow/clinical approval absent |
| TRK-14.5-02 | §14.5 | Neither QR content nor an unverified unique link alone shall disclose medical record contents. The server shall verify grant validity, selected-record scope, doctor email OTP, expiration and revocation before returning data. | FR-025–030; DEC-04/09/10 | B13 B14 B19 | M: schema exists but workflow/clinical approval absent |
| TRK-14.5-03 | §14.5 | Access grants shall have a configured expiry and shall be revocable by the patient at any time. Revocation and expiry shall apply to file access and any RAG query, not only to a dashboard page. | FR-025–030; DEC-04/09/10 | B13 B14 B19 | M: schema exists but workflow/clinical approval absent |
| TRK-14.5-04 | §14.5 | The recipient web interface shall allow the doctor/healthcare professional to review only the authorized information and use permitted summaries or document retrieval, without a mandatory permanent doctor account. | FR-025–030; DEC-04/09/10 | B14 B18 | M: schema exists but workflow/clinical approval absent |
| TRK-14.6-01 | §14.6 | After a report is successfully processed, the authorized guardian shall be emailed a copy of that report and its generated summary. Email delivery success/failure shall be observable for release testing. | FR-031–033; DEC-05/11 | B12 B15 B17 | M: schema exists but workflow/clinical approval absent |
| TRK-14.6-02 | §14.6 | Independently evaluate the report using a defined set of clinically reviewed serious-finding rules. When triggered, send a separate guardian alert that presents the flagged finding and an appropriately cautious AI explanation. | FR-031–033; DEC-05/11 | B16 B19 | M: schema exists but workflow/clinical approval absent |
| TRK-14.6-03 | §14.6 | If extraction or rule evaluation is unclear, classify the detection outcome as indeterminate, not normal, and avoid asserting reassurance. Exact handling and wording for indeterminate outcomes must be approved before launch. | FR-031–033; DEC-05/11 | B16 B19 | M: schema exists but workflow/clinical approval absent |
| TRK-14.6-04 | §14.6 | Guardian email recipients and content must respect the patient’s authorized relationship and medical-data privacy requirements; no automatic delivery to an arbitrary user-supplied third-party address. | FR-031–033; DEC-05/11 | B12 B15 B16 B19 | M: schema exists but workflow/clinical approval absent |
| TRK-15-01 | §15 Patient | patient_id, authenticated identity, profile fields, created/updated timestamps; invariant: Owns documents, questions/results and sharing grants | §5.1 logical entities; relevant FR/NFR | B02 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-02 | §15 Guardian contact | guardian_id, patient_id, authorized email/contact designation; invariant: Email destination is associated with consenting/authorized patient | §5.1 logical entities; relevant FR/NFR | B12 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-03 | §15 Medical document | document_id, patient_id, S3 object reference, original name/type, category, hospital, document date, upload timestamp, processing state; invariant: S3 original private; document belongs to one patient | §5.1 logical entities; relevant FR/NFR | B02 B17 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-04 | §15 Extracted text / index | document_id, extraction state, text/chunks, vector references, source offsets if available; invariant: Index tied to originating document and patient access boundary | §5.1 logical entities; relevant FR/NFR | B04 B09 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-05 | §15 Report summary | summary_id, document_id, generation status, generated text, model version; invariant: Generated only from permitted extracted record | §5.1 logical entities; relevant FR/NFR | B06 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-06 | §15 Medical timeline | patient_id, document_id, document date or identified fallback; invariant: Derived chronological view, not fabricated clinical events | §5.1 logical entities; relevant FR/NFR | B07 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-07 | §15 Sharing grant | grant_id, owner patient, selected document IDs, recipient doctor email, method, created/expiry/revoked state; invariant: Valid only for chosen records and verified recipient | §5.1 logical entities; relevant FR/NFR | B13 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-08 | §15 OTP challenge | challenge_id, grant_id, doctor email, hashed OTP/token state, expiry, attempt count; invariant: No plaintext OTP storage; backend validates before access | §5.1 logical entities; relevant FR/NFR | B14 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-09 | §15 Guardian email event | event_id, document/patient/recipient, routine or serious type, delivery state; invariant: Routine after processing; serious only on reviewed-rule trigger | §5.1 logical entities; relevant FR/NFR | B12 B15 B16 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-10 | §15 Serious rule result | document_id, ruleset version, matched finding or indeterminate, explanation reference; invariant: Clinical rules, not autonomous AI diagnosis | §5.1 logical entities; relevant FR/NFR | B16 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-15-11 | §15 RAG interaction | actor scope, patient/grant scope, request, permitted retrieval references, response; invariant: Used for validation and observability under privacy controls | §5.1 logical entities; relevant FR/NFR | B10 B14 | I/P for patient/document/extraction/report-summary schema; all other entities are schema-only or missing derived services. E-DB is not workflow completion. |
| TRK-18-01 | §18 | Implementation teams shall maintain this control sheet throughout development, with one row per functional requirement, plus associated non-functional tests. Completion requires a real environment, reproducible evidence and passing tests. | All FR/NFR; AT/V | B01 B21 | P: B00 establishes ledger; real-environment completion evidence still required |
| TRK-19-01 | §19 | The authoritative FYP scope is the submitted proposal dated 25 September 2026, supplemented by the 12 explicit project-owner decisions recorded in Section 11. The FR numbering and historical acceptance tests originate in prior SRS versions; Sections 14–18 supply additional verifiable implementation detail. Where a technical control is necessary to protect data or operate the confirmed workflow, it is a supporting constraint—not an added product feature. | All FR/NFR; governance | B01 B19 B21 | Binding baseline/exclusion/release-claim control; no claim of clinical/production readiness |
| TRK-19-02 | §19 | Excluded from the approved baseline: built-in appointment booking, payment handling, hospital-system integration, autonomous diagnosis, medication prescribing, patient-doctor chat, guardian login portal, persistent doctor-account dashboard, and new administrative product features. They require separately approved scope changes. | All FR/NFR; governance | B01 B19 B21 | Binding baseline/exclusion/release-claim control; no claim of clinical/production readiness |
| TRK-19-03 | §19 | Release may not be described as clinically validated or production-safe for real patients until actual clinical rule review, security/privacy/legal verification, AI evaluation and AWS operational tests are completed. Synthetic or de-identified data shall be used by default, as stated in the submitted proposal. | All FR/NFR; governance | B01 B19 B21 | Binding baseline/exclusion/release-claim control; no claim of clinical/production readiness |

## Confirmed decisions — binding, not merely suggestions

| Source decision | Confirmed text | Current state | Phases |
| --- | --- | --- | --- |
| DEC-01 | PostgreSQL on Amazon RDS; pgvector preferred subject to measured suitability. | P: local PostgreSQL/S3 foundation only; no RDS/vector suitability evidence | B09 B20 |
| DEC-02 | Patient React Native mobile; doctor React.js + Vite web; Node.js + Express backend. | P: Node exists; mobile/web empty | B02 B18 |
| DEC-03 | FastAPI + LangChain + LangGraph + hosted LLM; provider/model TBD; pgvector where suitable. | P: FastAPI fake exists; hosted runtime/LangChain/LangGraph missing; local benchmark does not amend baseline | B05 B06 B10 B11 |
| DEC-04 | QR physical / unique link online; both require patient permission and doctor email OTP. | M: both sharing/OTP flows missing | B13 B14 B18 |
| DEC-05 | On successful processing, guardian receives report copy + AI summary; separate email for rule-triggered serious finding. | M: no routine/serious email workflows | B12 B15 B16 |
| DEC-06 | RAG-grounded records and summaries, general symptom education, safety-constrained visit guidance; no diagnosis/prescribing/final treatment decisions. | P: summary guardrails only; symptom/RAG missing | B10 B11 B19 |
| DEC-07 | PDF/JPG/JPEG/PNG; lab/prescription/other categories; hospital and document/upload dates; validation; OCR; processing/completed/failed; retries. | P: validation/OCR/states exist; client retry/full processing integration missing | B02 B03 B07 B17 |
| DEC-08 | AWS-based hosting, RDS PostgreSQL, private S3, HTTPS, secrets, monitoring and backups. | P: private-S3 synthetic subflow only; no AWS whole-system deployment | B19 B20 B21 |
| DEC-09 | Authenticated patients; doctors via authorized share + email OTP, without mandatory persistent doctor accounts; guardians email only. | P: patient auth exists; doctor guest/guardian email paths missing | B12 B14 B18 |
| DEC-10 | Patient selects shared records; grants expire automatically at configured duration and can be revoked immediately. | M: schema only, no grant service | B13 B14 B19 |
| DEC-11 | Clinically reviewed predefined alert rules; AI explanation of flagged findings; indeterminate when not interpretable. | M: schema only, no reviewed rules/indeterminate workflow | B16 B19 |
| DEC-12 | Comprehensive unit, integration, E2E, security, OCR, RAG, email, performance, usability, backups and AWS release verification. | P: substantial isolated tests; no full system security/clinical/load/UI/restore release evidence | B01 B19 B21 |

## Controlled parameters — no invented approval values

| Source parameter | Exact open parameter | Source release gate | Audit state | Phases |
| --- | --- | --- | --- | --- |
| CFG-01 | Hosted LLM provider, exact model/version, data handling agreement and geographic processing | Must be approved and validated before sensitive content is sent | Hosted provider/model, privacy agreement and processing geography not approved; local benchmark is synthetic-only | B01 B05 B19 |
| CFG-02 | Embedding model, dimensionality, pgvector/index feasibility and retrieval performance | Benchmark before DB/index freeze | Installed embedding model not integrated/benchmarked; dimension/index choices open | B01 B09 |
| CFG-03 | Maximum PDF/image upload size and resource quotas | Document and test thresholds | 5 MiB upload default and bounded PDF/OCR settings exist as implementation defaults, not release approval | B01 B02 B19 |
| CFG-04 | Doctor OTP lifetime, retry/rate limits and email delivery service | Security-review and negative testing | Doctor email provider/OTP TTL/attempt/rate policy missing | B01 B12 B14 |
| CFG-05 | QR/link grant lifetime, session behavior and expiration duration | Document, test and enforce on all access paths | Grant expiry/session/file/RAG revocation policy missing | B01 B13 B14 |
| CFG-06 | Clinical serious-report rule set, laboratory units/ranges, age/sex context and thresholds | Qualified clinical approval mandatory for real-patient use | Clinical serious rules/context/units/thresholds absent; qualified approval required | B01 B16 B19 |
| CFG-07 | Indeterminate detection messaging and guardian notification handling | Approved human-readable user safety wording | Indeterminate wording/notification handling unapproved | B01 B16 B19 |
| CFG-08 | AWS compute topology, IAM, network layout, encryption keys and regions | Infrastructure security review | Personal S3 target is not approved full AWS topology/RDS/deployment architecture | B01 B19 B20 |
| CFG-09 | Backup schedule, restore targets, monitoring alerts and incident response contacts | Operational readiness rehearsal | No measured backup/restore RPO/RTO/alerts/incident ownership | B01 B19 B20 B21 |
| CFG-10 | Performance, availability, OCR, RAG and summary quality acceptance thresholds | Defined measurable test plan and recorded evidence | Synthetic checks exist; clinical/OCR/RAG/load/usability/availability release thresholds not settled | B01 B05 B09 B19 |
| CFG-11 | Guardian consent/authorization setup and permitted email content handling | Legal/privacy review before real-patient use | Guardian contact schema alone is not consent/legal/email-content approval | B01 B12 B15 B16 B19 |
| CFG-12 | Privacy retention, deletion obligations and patient-data processing compliance | Applicable legal and organizational approval | Retention/deletion/legal compliance not approved; restrictive FKs are not policy | B01 B19 B20 |
| CFG-13 | Patient-facing web access: proposal mentions patient-friendly web generally while implementation selects patient mobile + doctor web | No additional patient web interface unless separately approved | Default is patient mobile + doctor web; no patient web added without explicit approval | B01 B18 |
| CFG-14 | Source-level ambiguity: whether sharing means every record by default or patient selection | Resolved by DEC-10: patient-selected documents only | Resolved by DEC-10: selected records only; implementation still missing | B13 B14 |

## Use cases and complete acceptance inventory

| Source flow | Observable workflow / role | Source FRs | Failure/acceptance coverage | Phases |
| --- | --- | --- | --- | --- |
| UC-01 | Patient; Patient registers, logs in, and manages profile | FR-001–003 | Authenticated patient accesses only their profile and records; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B02 B18 |
| UC-02 | Patient; Upload → S3 → metadata → OCR when needed → categorization/record availability | FR-004–012 | Medical record is available for viewing and authorized retrieval; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B02 B03 B04 B17 B18 |
| UC-03 | Patient / authorized professional; Filter on hospital name and upload date; retrieve matching records | FR-006–009, FR-025, FR-029 | Only accessible documents shown; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B02 B14 B18 |
| UC-04 | Patient / authorized professional; Retrieve applicable record content; summarize in simple language; present timeline | FR-013–016, FR-022–024 | Report/history information is understandable and date ordered; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B06 B07 B08 B14 B18 |
| UC-05 | Patient / authorized professional; Natural-language prompt → patient-scoped retrieval → grounded synthesis | FR-017–024 | Answer grounded in permitted uploads, not independent clinical judgment; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B09 B10 B11 B14 B18 |
| UC-06 | Patient / healthcare professional; Display QR; professional requests view; verify patient permission | FR-025–026, FR-029–030 | Only patient-authorized records displayed; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B13 B14 B18 |
| UC-07 | Patient / doctor; Issue unique link; verify access using doctor email OTP; check permission | FR-025, FR-027–030 | Authorized doctor views permitted record content; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B12 B13 B14 B18 |
| UC-08 | Patient / guardian / email service; Email original/report copy and summary on upload; trigger defined serious-report alert when applicable | FR-031–033 | Guardian receives corresponding messages; Must be specified where upload, OCR, AI, OTP, email or cloud service failure affects behavior (D-07, D-11). | B12 B15 B16 B17 |

| Source AT | Exact acceptance evidence | Source coverage | Current evidence limitation | Phases (+B21) |
| --- | --- | --- | --- | --- |
| AT-01 | Register/login/profile: patient can create an account, authenticate and update profile. | FR-001–003 | Historical backend/isolated subset only | B02 B18 |
| AT-02 | Upload PDF and image: originals are stored in S3 and accessible only to the owning patient or authorized requester. | FR-004–005, FR-025 | Historical backend/isolated subset only | B02 B14 B18 |
| AT-03 | Record metadata and categorization: hospital, upload date and type are available for filtering. | FR-006–010 | Historical backend/isolated subset only | B02 B04 B18 |
| AT-04 | OCR: sample scanned report/image yields processed text associated with its source record. | FR-011–012 | Historical backend/isolated subset only | B03 |
| AT-05 | Timeline: uploaded medical records appear in chronological order using their available dates. | FR-013–014 | Full flow not verified | B07 B14 B18 |
| AT-06 | AI summaries: uploaded report and patient history can be summarized in simple language. | FR-015–016 | Historical backend/isolated subset only | B06 B08 B14 B18 |
| AT-07 | Patient RAG question: answer uses appropriate same-patient document content; other-patient records are never included. | FR-017–021, FR-023 | Historical backend/isolated subset only | B09 B10 B11 |
| AT-08 | Clinician AI and search: authorized doctor can retrieve, filter and summarize shared material only. | FR-022, FR-025, FR-029 | Full flow not verified | B14 B18 |
| AT-09 | Non-diagnostic safety: representative prompts do not cause the assistant to issue independent diagnoses/final treatment decisions. | FR-023–024 | Historical backend/isolated subset only | B05 B11 B19 |
| AT-10 | QR access: use patient QR path; confirm access is restricted to authorized material. | FR-025–026 | Full flow not verified | B13 B14 B18 |
| AT-11 | Link/OTP: doctor accessing patient share link must verify through doctor email OTP. | FR-027–028 | Full flow not verified | B12 B13 B14 B18 |
| AT-12 | Guardian email: upload causes report copy and summary delivery; flagged sample triggers serious-report notification. | FR-031–033 | Full flow not verified | B12 B15 B16 |
| AT-13 | Interface coverage: patient mobile functions and doctor web view support the relevant workflows. | FR-034–036 | Full flow not verified | B18 B19 |
| AT-14 | Data/privacy test: synthetic or de-identified data are used during ordinary development and testing. | NFR-02 | Historical backend/isolated subset only | B01 B19 |

| Source V | Exact scenario/action | Exact required pass condition | Current disposition | Phases (+B21) |
| --- | --- | --- | --- | --- |
| V-01 | Register patient, login and open private profile | Authenticated patient sees own profile only; anonymous access denied | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B02 B18 |
| V-02 | Patient A requests Patient B document/API or S3 object | Request denied; content never exposed | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B02 B14 B19 |
| V-03 | Upload valid PDF and valid JPG/JPEG/PNG | Private original saved; correct owner, dates and category metadata; processing starts | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B02 B03 B17 B18 |
| V-04 | Upload unsupported, oversized or damaged file | Rejected with clear error; no accessible partial record | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B02 B19 |
| V-05 | OCR scanned report and read native text PDF | Extracted text traceable to correct uploaded original | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B03 |
| V-06 | Trigger OCR or AI processing error and retry | Original retained, status failed; permitted retry reaches completion or another reportable failure | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B03 B06 B09 B17 |
| V-07 | Filter by hospital, category, upload date | All and only matching authorized results returned | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B02 B14 B18 |
| V-08 | Sort timeline with distinct document vs upload dates | Chronology uses known document dates, labels any fallback | Not adequately verified | B07 B18 |
| V-09 | Generate one-report and longitudinal summaries | Understandable, grounded in authorized documents; unknowns not fabricated | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B06 B08 B14 B18 |
| V-10 | Ask RAG questions with present/absent facts | Relevant document-grounded answer or transparent insufficiency; no cross-patient retrieval | Not adequately verified | B09 B10 B14 |
| V-11 | Supply prompt injection inside an uploaded record | Document instructions not obeyed as system instructions; data isolation enforced | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B04 B05 B10 B11 B19 |
| V-12 | Use QR sharing without doctor OTP | No medical content before successful OTP and patient authorization | Not adequately verified | B13 B14 B18 |
| V-13 | Use unique link with valid/invalid/expired OTP | Only successful challenge and valid grant permit selected records | Not adequately verified | B12 B14 B18 |
| V-14 | Revoke grant and allow grant to expire | Further web, file and AI retrieval blocked | Not adequately verified | B13 B14 B19 |
| V-15 | Share selected document A but not B | Doctor receives A only; attempts to access B denied | Not adequately verified | B13 B14 B19 |
| V-16 | Process normal/routine report for guardian | Report copy and AI summary emailed after successful processing | Not adequately verified | B12 B15 |
| V-17 | Trigger reviewed serious finding | Routine email plus separate serious alert with cautious explanation | Not adequately verified | B16 |
| V-18 | Supply ambiguous lab report for rule evaluation | Result indeterminate, not falsely normal; follows approved indeterminate handling | Not adequately verified | B16 B19 |
| V-19 | Ask AI to diagnose or prescribe | No autonomous diagnosis, prescriptions or final treatment instruction | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B05 B11 B19 |
| V-20 | Deploy entire integration on AWS | HTTPS, private S3, RDS backups, secrets and monitoring verified | Not adequately verified | B20 |
| V-21 | Run backup/restore and failure recovery drill | Restored authorized data and defined recovery objectives tested | Not adequately verified | B20 B21 |
| V-22 | Run load, accessibility and mobile/web usability checks | Approved quality thresholds pass and evidence stored | Not adequately verified | B18 B19 B21 |
| V-23 | Execute end-to-end patient→document→AI→sharing→guardian sequence | Every approved workflow works with synthetic or de-identified test data | Not adequately verified | B17 B18 B21 |
| V-24 | Review comprehensive FR and NFR traceability | All requirements have tests and verified implementation or explicitly recorded blockers | Backend/isolated or manual-OCR subset historically evidenced; full V acceptance open | B01 B21 |

## Source tensions and required reviews

- **Hosted vs local AI:** §§8.1/11 DEC-03/14.4 explicitly confirm hosted LLM and LangChain + LangGraph. Local Ollama preparation is not a baseline amendment. Decide whether it is an auxiliary benchmark/fallback *by separately approved design* or request an explicit architecture amendment; never silently substitute it. No hosted request/spending is authorized by this audit.
- **Node vs Python OCR:** source §8.1 allocates AI/processing to Python; actual verified OCR is Node PDF.js/Tesseract. Preserve the working code and obtain an architecture interpretation/amendment before deciding on reuse or a port. Do not automatically rewrite it.
- **File URLs and revocation:** current patient download returns a pre-signed S3 bearer URL. §14.1 says possession of a URL is not authorization, and §14.5 demands immediate grant revocation for files/RAG. Existing ownership-before-issuance is valuable but does not prove post-issuance revocation. Define authenticated file gateway and in-flight/download semantics before clinician delivery; do not claim that shortening a URL TTL alone satisfies immediate revocation.
- **Completion semantics:** existing `medical_documents.processing_status=completed` means extraction completion. §14.2 includes downstream categorization/indexing/summary failure and DEC-05 routine mail after successful processing. Separate stage states and a truthful aggregate state; do not send routine mail on OCR completion alone.
- **Categorization:** only supplied enum assignment/validation is implemented. The SRS requires categorization but does not prescribe ML classification or accuracy values; agree whether that assignment meets intent or add approved enrichment. Do not invent automatic diagnosis/classification claims.
- **Parameters and clinical/legal controls:** all CFG rows above remain release controls except the explicitly resolved selection policy CFG-14. Technical defaults are not retrospective owner/clinical approval. Never invent lab ranges, age/sex thresholds, guardian authorization or an indeterminate reassurance policy.
- **Patient web:** preserve FR-035's broader wording alongside DEC-02/CFG-13. Patient React Native + doctor React/Vite is the confirmed default; additional patient web needs approval. Both required existing clients are currently absent.
- **Source legacy references:** UC alternate-flow rows refer to `D-07, D-11`, while §11 uses `DEC-07, DEC-11`. Treat these as a reference inconsistency requiring clarification, not extra decisions or removed failure-path requirements. §6's permissive framework wording is refined by explicit §14.4/DEC-03.
- **Prior roadmap availability:** no B01–B16 roadmap artifact was found in the inspected repository or available task text. The B01–B21 plan is a source-derived revision, not an invented reconstruction of that earlier list. An externally retained prior plan should be reconciled in B01 without losing this source coverage.

## Audit boundary and coverage assertion

All 44 primary IDs, all subordinate TRK rows, all DEC/CFG, and all UC/AT/V IDs map to explicit B01–B21 implementation or verification work. Full completion requires the SRS conjunction, not counts alone. No source requirement is removed because local hardware/provider choice makes it difficult. Approval still governs future changes and live operations; the roadmap itself does not authorize them.


## B01 decision and baseline evidence — 2026-10-23

The 44 primary / 88 TRK / 12 DEC / 14 CFG / 8 UC / 14 AT / 24 V inventory and product
status counts remain unchanged. B01 adds control evidence for NFR-02/05/08,
TRK-12-02 and TRK-18-01, not new implemented product flows or end-to-end acceptance.
See [B01_DECISIONS_AND_BASELINE.md](B01_DECISIONS_AND_BASELINE.md), the pinned
`baselines/B01_SOURCE_MANIFEST.json` and `baselines/B01_VALIDATION_RECEIPT.json`.

| Source obligation | B01 disposition/evidence | Remaining implementation/approval gate |
| --- | --- | --- |
| DEC-01/02/08/09/10/12 | Preserve existing stack, selected-record grants, guest doctors/email guardians, required clients, testing and deployment scope; baseline pins source/tests/lockfile. | B02–B21; no cloud/DB/service authorization here. |
| DEC-03; CFG-01; TRK-8.1-01; TRK-14.4-02 | User approved zero paid AI API usage/local inference as development direction, explicitly left formal amendment pending. Hosted clause remains verbatim in SRS; no hosted inference/fallback authorized. LangChain/LangGraph still required. | Formal scope resolution and B05/B06/B11 evaluation/integration. |
| FR-011/012; NFR-08; TRK-8.1-01 | Retain working Node PDF.js/Tesseract OCR as development direction; do not rewrite or falsely describe it as Python OCR. | Formal responsibility amendment/interpretation pending; B03 actual runtime verification. |
| DEC-04/10; FR-025–030; TRK-14.1-02/TRK-14.4-01/TRK-14.5-01–03 | Both QR/link need OTP, selected scope and current grant validity. Current signed URL is not proof of immediate revocation. | B02 file contract; B13/B14 grants/OTP and streaming/query revocation enforcement. |
| DEC-05/07; TRK-14.2-03/TRK-14.6-01 | Extraction-completed, full document pipeline completed and notification delivered are different claims. Preserve existing stage state and originals. Routine email waits for successful processing plus accepted summary. | B06/B15/B17 aggregate/status/dependency contracts and tests. |
| FR-007; CFG-03; TRK-14.2-01/02/05 | Current supplied enum/category validation is reusable; SRS does not mandate an ML classifier. No extra classifier is invented. Existing quotas are implementation defaults, not clinical/release signoff. | B02/B04/B18 assignment/UX and validated fact catalogue; CFG quota review. |
| DEC-06/11; CFG-06/07/10/11/12 | Safety/no-diagnosis/exact-evidence/uncertainty principles established; clinical/legal/wording/quality appointments and values pending. Local inference is not legal/clinical approval. | Qualified Clinical Safety and Privacy/Legal roles; B04/B05/B11/B16/B19. |
| CFG-01–14 | Every parameter has an accountable role, explicit state and phase gate in B01 register; no names or approval values invented. | Named appointments/approvals pending; unrelated offline development need not stop. |
| NFR-02/05; TRK-12-02/TRK-18-01; V-24 | Pinned public-source-only snapshot, credential-empty test environment, network/read guards, repeatable inventory/check commands and structured test receipt. | Receipt scopes tests actually run; no patient data, model calls, DB mutation or full-release acceptance. |

Formal approvals pending is a deliberate accurate state, not a silently resolved
SRS conflict. The FYP supervisor's academic role does not imply clinical, legal or
production authorization. B01 does not change any primary implementation/E2E status.


## B02 qualification addendum — 2026-10-23

Current contract: [B02_PATIENT_DOCUMENT_CONTRACTS.md](B02_PATIENT_DOCUMENT_CONTRACTS.md).
Evidence **E-B02**: `backend/src/b02-checks/contracts.check.ts`, updated
`documents/documents.test.ts`, `documents/file-access.ts`,
`infrastructure/summary-db/run-tests.ts` and `baselines/B02_VALIDATION_RECEIPT.json`.
The SRS text, 44 primary / 88 TRK IDs and original implementation/E2E denominators
remain unchanged. Historical descriptions above are superseded only for the changed
patient file-response contract; no unrelated requirement is declared complete.

| Requirement / clause | B02 implemented or reused evidence | Remaining acceptance |
| --- | --- | --- |
| FR-001–003; TRK-14.1-01/02; UC-01; AT-01/V-01 | Existing Argon2id/JWT/allowlisted own-profile repositories reused; new read-body rejection; duplicate/invalid/foreign/unknown/rate-limit/redaction regressions. | Patient mobile, production/real-data approvals and B21. |
| FR-004/005/010; NFR-01/02/07; TRK-5.2-01/03; TRK-14.2-01/02; UC-02; AT-02/03/14; V-02/03/04 | Existing multipart/type/size/decode/conditional-S3/compensation reused with synthetic storage; original-byte file gateway, source-reference checks, bounded private files and disconnect/deadline cleanup. | Live gateway/S3 acceptance, mobile, broader pipeline/release gates. |
| FR-006–009; TRK-14.2-02/05; UC-03; AT-03/V-07 | Existing hospital/category/calendar-date validation, metadata projections, scoped SQL filtering/pagination and factual timestamps retained and regression-tested. Category assignment explicitly patient-supplied; no classifier invented. | Mobile/timeline UI, doctor scope B14, integrated acceptance. |
| TRK-14.1-02 | `/documents/:id/download` returns authenticated bytes, never a presigned URL; repeated owner lookup before headers, no signer fallback. Foreign/unknown/malformed document denials identical. | Future current doctor grants/revocation and already-delivered/in-flight limits remain B14. |
| TRK-14.2-03/04 | Existing extraction-stage states, owner/original retention, document-date/fallback fields preserved. Repeat upload is a distinct record with one pending job, not a retry of an existing original. | Full-stage status/retry semantics B03/B06/B09/B17; chronology UI B07/B18. |
| CFG-03/12; TRK-7-01 | Existing development quotas retained; no new deletion/retention behavior. Exact limits and outstanding approval roles documented. | Final quota/load and privacy/legal/retention signoff B19/B20; appointments remain pending. |

No patient/doctor/guardian frontend, live S3 access, real AI, background activation or
production security/clinical acceptance follows from this isolated qualification.
B01 artifact hashes remain historical; expected B02 code drift does not amend the SRS.

E-B02 measured results: 270 backend tests (prior 269 + repeat-upload test); 726
checks in the disposable harness; separately 876 existing offline regressions and
24 final B02 checks passed. These overlap and are not summed as unique requirements.
Contract compatibility, typecheck, build and disabled startup passed. Exact owned
resources were cleaned up and existing-container preservation independently checked.
Final receipt records provenance and earlier interrupted/failed attempts without
counting them as passes. All complete-application E2E statuses remain No.


## B03 controlled extraction addendum — 2026-10-23

Evidence **E-B03**: `processing/{api,api-repository,worker,background-config}.ts`,
`app.ts`, `b03-checks/api.check.ts`, `b03-db-checks/integration.check.ts`, the existing
OCR/background suites and `baselines/B03_VALIDATION_RECEIPT.json`. Contract and
operational gates: [B03_CONTROLLED_OCR_INTEGRATION.md](B03_CONTROLLED_OCR_INTEGRATION.md).

| SRS obligation | New or reused B03 evidence | Remaining scope |
| --- | --- | --- |
| FR-004/010; TRK-14.2-01/02; AT-02/03; V-03/04 | Existing authenticated validation/S3/SQL enqueue reused. Actual isolated uploads automatically processed by the existing standalone service; no API-started worker. | Mobile B18, live/private-S3 deployment B20/B21. |
| FR-011/012; TRK-14.3-01; AT-04/V-05 | Genuine PDF.js/Poppler/Tesseract digital/scanned/mixed extraction, patient/document/attempt binding, SHA-256 and ordered page provenance. JPG/JPEG/PNG and blank-scan outcomes verified. | Clinical fact catalogue B04, indexing B09, formal Node/Python allocation resolution. |
| TRK-14.1-02; TRK-14.2-03; TRK-14.3-04; DEC-07; V-02/06 | Patient GET processing status and pinned-cutoff POST retry, SQL owner/cutoff/attempt bounds, concurrent idempotency and original preservation. No resets, legacy completion or historical admission. | Broader stage/index/AI retries B06/B09/B17; interface integration B18. |
| NFR-01/07/08 | Existing scoped lease/coordinator/original/OCR controls retained; cancellation during recovery now prevents the next claim. Empty/invalid/exhausted failures never imply normal findings or erase originals. | Full release security/clinical/compatibility qualification B19/B21. |
| NFR-06; DEC-08; CFG-08; TRK-8.1-01 | Existing system-manager/file-credential interfaces reviewed and preserved. Current network-denying unit cannot reach PG/S3; operational gaps explicitly remain blocked. | Reviewed system OS transport, immutable artifacts/identity, credential/network composition and separately approved actual-worker containment/controller-loss/runtime-expiry proof. |

No SRS wording, 44 primary / 88 TRK IDs, frozen fixtures, migration or product-level
E2E status changes. Primary implementation totals remain unchanged. Actual extraction
completion is not medical-summary/index/email completion. No live account/storage/DB,
production service activation or formal architecture amendment is implied.

E-B03 actual checks: 19 new fake tests and eight upload-to-scheduler integration
checks passed; all 270 backend tests passed within 680 successful non-summary
disposable checks. Existing offline regressions passed 876 checks. The broad run's
summary suite had one heartbeat subtest plus parent failure (71/73); an unchanged
fresh focused rerun passed 73/73. No first-run all-green or root-cause claim is made.
Build/typecheck/compatibility/disabled-entry checks passed. Cleanup/preservation was
independently verified. Full B03 operational acceptance and B21 E2E remain open.


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


## PRD completeness and Module 01 review — 2026-10-24

[Supplementary checklist](PRD_MODULE_DELIVERY_TRACKER.md) pins all16 modules/127 feature-control rows, exact PRD requirement/acceptance/reference text, module boundaries and DEC12/CFG14/FR36/NFR8/AT14/V24 registers. It retains per-feature phases, scope, gaps and independent verification fields; no whole requirement is promoted to release-complete. [Module01 review](MODULE_01_PATIENT_ACCOUNTS.md) adds16 fake-SQL/owned-loopback route checks for FR-001/002/003, NFR-01 and M01-01–06. All40 new-plus-existing-B02 checks pass; typecheck/build and18 completeness checks pass. PostgreSQL/mobile/live acceptance are not proved by these new tests. Existing primary SRS status labels are unchanged; M01-04/05/06 remain partial. Source mismatch: M01-06 cites infrastructure CFG-08 for session configuration; preserved pending editorial approval. Formal local/hosted and Node/Python amendments remain pending.


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

### B03.6 affected source rows — unchanged coverage labels

| Source row | Previous → current coverage | New component evidence | Remaining acceptance |
| --- | --- | --- | --- |
| FR-010 | Implemented (backend/process scope) → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| FR-011 | Implemented (backend/process scope) → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| FR-012 | Partially implemented → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| NFR-01 | Partially implemented → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| NFR-05 | Implemented (backend/process scope) → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| NFR-06 | Partially implemented → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| NFR-07 | Implemented (backend/process scope) → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| NFR-08 | Partially implemented → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| DEC-07 | P: validation/OCR/states; full integration missing → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| DEC-08 | P: private-S3 synthetic subflow only → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |
| DEC-12 | P: substantial isolated tests → unchanged | B03.6 broker/journal/credential/graph/network enforcement interfaces and101 new synthetic TS cases;7 inventory tests; single1102 broad checks;23 completeness tests. | Native control/bootstrap/release/relay implementations, actual application runtime, whole SRS/PRD/client/clinical/cloud acceptance remain open. |


## B03.7 native authority and credential transport — 2026-10-24

[Report](B03_7_NATIVE_AUTHORITY_20261024_5uWELmBA.md) / `baselines/B03_7_OFFLINE_QUALIFICATION_20261024_5uWELmBA.json`. Added dormant native libsystemd observation/control, exclusive broker flock+Unit.Ref+fresh comparison, SO_PEERCRED and descriptor handoff, dynamic UID/GID staging, durable issuance/recovery/revocation, private receiver/legacy-parser bridge and explicit native composition. No host system manager, services, credentials, DB/cloud/model access or automatic processing. All existing implementation and prior evidence preserved.

Native library components are qualified offline within the documented trusted-root/exclusive-writer boundary; systemd provides no InvocationID CAS. Installed-root launcher/policy/privilege/grant/inside-refresh assembly and actual platform behavior remain unqualified. Whole trusted delivery/operational/offline deployment readiness remain PARTIAL; live qualification OPEN. Complete release/native graph and PG/S3 descriptor delivery remain actual implementation work outside this phase's primary scope. No B04.

Supports FR-010/011/012; NFR-01/05/06/07/08; DEC-07/08/12 without source-scope amendments or whole-requirement completion. All127PRD entries, previous statuses, earlier evidence and Module01 accepted/PARTIAL preserved. Named clinical/privacy/operations appointments and formal hosted/local / Node/Python amendments remain pending. Next gate must separately approve remaining offline deployment assembly and delivery work, never automatic activation.

### B03.7 affected rows — previous coverage retained

| Source | Previous → current coverage | New evidence | Remaining acceptance |
| --- | --- | --- | --- |
| FR-010 | Implemented (backend/process scope) → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| FR-011 | Implemented (backend/process scope) → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| FR-012 | Partially implemented → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| NFR-01 | Partially implemented → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| NFR-05 | Implemented (backend/process scope) → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| NFR-06 | Partially implemented → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| NFR-07 | Implemented (backend/process scope) → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| NFR-08 | Partially implemented → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| DEC-07 | Partial workflow delivery → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| DEC-08 | Partial deployment delivery → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |
| DEC-12 | Partial full-product verification → unchanged | B03.7 native authority/peer/bootstrap/issuer libraries;49 TS+33 native Python checks;1151 broad offline checks. | Final application launch/policy assembly, full release and network bridges, actual root/systemd/UID/cloud/client/clinical acceptance remain open. |

49 new focused TypeScript checks; one1151-test broad run (25 baseline+341 Python+785 TypeScript);33 native Python qualification tests; one completeness check; contracts/typecheck/build/static/disabled checks pass.

### B03.7 final targeted supplement — 2026-10-24

Post-start dynamic GID is now bound from native observation with invocation binding inside a 1000ms deadline. One additional targeted test, full typecheck and build passed after the 1,151-test broad run. The two source deltas and both evidence versions are preserved; broad/completeness checks were not repeated. All delivery statuses and approval boundaries remain unchanged.

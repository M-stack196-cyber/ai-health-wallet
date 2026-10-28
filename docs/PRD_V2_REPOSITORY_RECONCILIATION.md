# PRD v2 repository reconciliation

28 October 2026 · Asia/Karachi · **Reconciliation accounting complete; owner review pending. Product/release acceptance OPEN.** The authoritative inventory is 18 modules and 232 detailed requirements. All are classified in the [new tracker](PRD_V2_MODULE_DELIVERY_TRACKER.md). No development phase has started.

## A. Baseline confirmation

Only these documents define current product requirements:

- `docs/AI_Health_Wallet_Revised_SRS_v4_0.docx` — SHA-256 `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55`.
- `docs/AI_Health_Wallet_Module_Wise_PRD_v2_0.docx` — SHA-256 `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84`.

SRS v4.0 governs product requirements; the named module-wise PRD v2.0 decomposes delivery. Both are read directly from DOCX XML and unchanged. The user designates this baseline for reconciliation; the PRD internal “prepared for owner approval” label does not authorize implementation. Old SRS/PRD files, the old tracker, historical B01–B03.x reports and the earlier 17-module/201-control reconciliation are historical only. In particular `docs/AI_Health_Wallet_PRD_v2_0.docx` is a different document and was not used as the current requirement inventory. Old two-digit control IDs cannot be equated with new three-digit IDs.

## B. Repository and Git state

Working directory: `/home/m-tayyab-aslam/Music/ai-health-wallet`. At initial inspection, Git had an unborn `main` with no commits; `.gitignore`, `ai-service/`, `backend/`, `docs/`, `infrastructure/` and `shared/` were pre-existing untracked entries. During this reconciliation, existing files became staged and `.gitignore` expanded from 208 to 442 bytes. These concurrent changes were not performed by the reconciliation tool calls; they are preserved untouched. At final inspection the index has 310 added entries, 2 untracked entries, and no HEAD commit. A clean release commit/source provenance cannot be asserted. No applicable AGENTS.md was found. No Git cleanup, commit or push was performed.

This reconciliation creates only the two newly requested Markdown deliverables. Application files, migrations, tests, deployment configuration, baseline documents, historical tracker and receipts remain unchanged. No suite/build/checker/test command, database, AWS, model, email or system service was executed. Selected SHA-256 and structural checks are read-only analysis. Private evidence/credential/medical-content files were not opened.

## C. New inventory verification

| Inventory | Expected | Observed | Result |
| --- | --- | --- | --- |
| PRD modules | 18 | 18 | MATCH |
| Unique detailed PRD IDs | 232 | 232 | MATCH |
| Functional requirements | 55 | 55 | MATCH |
| NFRs | 8 | 8 | MATCH |
| Confirmed decisions | 22 | 22 | MATCH |
| Configuration items | 18 | 18 | MATCH |
| Acceptance tests | 14 | 14 | MATCH |
| Expanded verification scenarios | 34 | 34 | MATCH |

Requirement IDs are exactly the PRD table IDs M01-001 onward. No duplicates, missing module row sequences or unexpected IDs are accepted. The 55/8/22/18/14/34 normative SRS table entries were compared with the PRD registers: identifiers and requirement/scenario wording agree. The 151 register items have individual accounting rows in section G. Direct requirement-source links are preferred; module-context inheritance is labeled where source rows cite only another requirement/section. No missing mapping remains.

Editorial reconciliation: NFR-08 retains “React/Next” wording, but SRS §20/DEC-13 and the PRD architecture explicitly require React+Vite for doctor/Admin. SRS §10.1 retains V-01–24 wording, while SRS §20.8 and the PRD require V-01–34; all 34 are retained. These older passages do not subtract approved amendments. PRD module dependencies are primary dependencies, not permission to defer privacy/security until module number15; those contracts must start with foundations.

## D. Existing implementation summary

| Area | Inspected current behavior | Limit |
| --- | --- | --- |
| Patient identity | Argon2id, normalized registration, JWT claim/time validation, generic sign-in errors, own-profile GET/PATCH | No verified-email/session/recovery/reset lifecycle, suspension check or immediate invalidation |
| Documents/storage | Bounded multipart validation, private S3 adapter, owner metadata/filtering, authenticated byte streaming, compensation/cancellation | No mobile client, full current-deployment qualification or patient deletion |
| OCR/lifecycle | Node PDF.js/Tesseract/Poppler extraction, source/page/confidence provenance, scoped retry, leases/fenced atomic persistence | Python allocation conflict; structured facts/full-pipeline completion and runtime qualification incomplete |
| Summary/AI | TS/Python schemas, private FastAPI factory, fake provider/recipe/jobs/source snapshots/fencing and synthetic evaluator | No actual source catalogue/approved hosted provider/real runtime/longitudinal/doctor summaries |
| RAG/sharing/guardian | Composite owner/scoped source, selected-grant/hashed-OTP, consent/event/serious-result tables | Schema foundations only; no executed RAG/doctor/guardian workflows |
| Mobile/doctor/Admin | mobile/ and web/ are empty; createApp registers patient/document/summary/processing/health only | No React Native, doctor React+Vite, Admin identity/RBAC/audit/dashboard |
| Operations | Restricted role tooling, disposable/local compose, disabled worker composition, offline native-authority/credential/trust components | Release/native graph, launch/network enforcement and actual system/cloud/runtime qualification remain open |

## E. Module status for all 18 modules

| Module | Title | Rows | IMPLEMENTED | PARTIAL | MISSING | BLOCKED | NEEDS_REVERIFICATION | Estimate | Prerequisite gaps | Proposed phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | Patient Identity, Email Verification, Sessions & Recovery | 14 | 3 | 4 | 6 | 1 | 0 | 36% | CFG-16; verified-email/session/reset schema; email port | 1 |
| M02 | Patient Profile & Guardian Relationship Lifecycle | 10 | 1 | 3 | 6 | 0 | 0 | 25% | M01; one-active/verified lifecycle; CFG-11 | 2 |
| M03 | Medical Document Upload, Validation, Private Storage & Processing State | 12 | 4 | 6 | 0 | 0 | 2 | 58% | Current identity; CFG-03; aggregate readiness | 2 |
| M04 | Medical Record Library, Metadata, Search, Categories & Record Deletion | 14 | 6 | 4 | 4 | 0 | 0 | 57% | M03; CFG-12/18; deletion/access hooks | 3; deletion contract1 |
| M05 | OCR, Text Extraction, Structured Content & Processing Orchestration | 10 | 2 | 5 | 1 | 0 | 2 | 45% | M03; Python contract; structured facts/uncertainty | 3 |
| M06 | Medical Timeline & Longitudinal History | 8 | 3 | 2 | 3 | 0 | 0 | 50% | M04/M05; doctor grants; deletion access | 3; doctor scope6 |
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

Estimate = (IMPLEMENTED +0.5×PARTIAL) / rows, rounded; it is not measured effort or acceptance percentage. No module meets all integrated exit conditions. Module statuses are not inherited from old labels.

## F. Coverage of all 232 PRD requirements

| Status | Requirements |
| --- | --- |
| IMPLEMENTED | 25 |
| PARTIAL | 66 |
| MISSING | 113 |
| BLOCKED | 20 |
| NEEDS_REVERIFICATION | 8 |
| TOTAL | 232 |

The [new tracker](PRD_V2_MODULE_DELIVERY_TRACKER.md) contains the full232-row reconciliation with exact requirement/source text, module, implementation/functions, historical tests/receipts, one permitted status, remaining gap, dependencies, evidence-reuse decision, re-verification obligation and separate conflict reference. No requirement disappears when its prerequisite is absent. Data constraints receive only partial credit where they enforce a real foundation; merely having a file is not implementation. BLOCKED is used for approval/selection-dependent scope and does not excuse missing runtime behavior. NEEDS_REVERIFICATION is separate from known missing work.

## G. SRS coverage and acceptance register

All151 SRS items are listed individually below. The FR/NFR/decision states assess implementation alignment, not whether a decision was owner-confirmed. All22 decisions remain confirmed requirements. CFG gates preserve selected/default values versus actual approval evidence. AT/V dispositions are historical-scope assessments; none is asserted to pass in a new integrated deployment. Register states are not added to 232 requirement totals.

### FR register

| SRS item | Approved requirement / scenario | PRD requirement links | Current disposition |
| --- | --- | --- | --- |
| FR-001 | The system shall support patient account registration. | Direct source: M01-001, M01-008 | IMPLEMENTED at basic registration backend scope; verified enrollment remains separate. |
| FR-002 | The system shall support patient login and authentication. | Direct source: M01-002, M01-009 | PARTIAL: login/expiry primitives; no suspended/revoked account/session enforcement. |
| FR-003 | The system shall allow authenticated patients to manage their profile. | Direct source: M01-003, M01-014 | PARTIAL: own profile APIs; full v4 profile/verified identity/guardian baseline incomplete. |
| FR-004 | Patients shall upload medical documents as scanned PDF files or images using the mobile application. | Direct source: M03-001, M03-004, M11-004 | PARTIAL: backend upload exists, mobile absent. |
| FR-005 | The system shall store uploaded medical document originals in AWS S3. | Direct source: M03-002, M03-007 | NEEDS_REVERIFICATION: private S3 code/historical synthetic scope; current integrated deployment unqualified. |
| FR-006 | The system shall maintain searchable record metadata including hospital name and document or upload date. | Direct source: M03-008, M04-001 | IMPLEMENTED at backend metadata/search scope. |
| FR-007 | The system shall categorize medical documents, including relevant categories such as lab reports and prescriptions. | Direct source: M03-008, M04-002 | PARTIAL: supplied categories; approved public label mapping incomplete. |
| FR-008 | Patients shall be able to view and manage their uploaded medical records. | Direct source: M04-003, M04-010, M11-005 | PARTIAL: existing library/edit; mobile/deletion workflow incomplete. |
| FR-009 | Patients shall search and filter medical documents by hospital name and upload date. | Direct source: M04-004, M04-009, M11-005 | IMPLEMENTED at current owner backend filter scope. |
| FR-010 | The system shall validate medical records for integrity and acceptable processing as described in the proposal. | Direct source: M03-003, M03-005, M03-006, M05-007, M05-008 | PARTIAL overall processing: strong upload validation, incomplete aggregate/AI/index lifecycle. |
| FR-011 | The system shall perform OCR when uploaded medical reports are scanned or image based and extraction is required. | Direct source: M05-001, M05-003 | NEEDS_REVERIFICATION: existing Node OCR must satisfy mandated Python contract. |
| FR-012 | The system shall extract relevant text/information and create structured data used by categorization and retrieval. | Direct source: M05-002, M05-004, M05-005, M07-010 | PARTIAL: extracted text/provenance, structured downstream facts incomplete. |
| FR-013 | The system shall produce a chronological medical-history timeline using available uploaded record dates. | Direct source: M06-001, M06-003, M06-004, M06-005, M11-006 | PARTIAL: chronological list/fallback exists; full timeline access lifecycle/UI incomplete. |
| FR-014 | Authorized healthcare professionals shall be able to view patient history and timeline for records shared with them. | Direct source: M06-002, M06-006, M06-007, M12-006 | MISSING: doctor history/timeline access. |
| FR-015 | The system shall generate an understandable AI-assisted summary for uploaded medical reports. | Direct source: M07-001, M07-004, M07-010, M11-006 | PARTIAL: fake report summary/service contracts only. |
| FR-016 | The system shall generate AI-assisted summaries of available patient medical history. | Direct source: M07-002, M07-005 | MISSING: longitudinal summary. |
| FR-017 | The system shall enable patients to ask natural-language questions about their own uploaded records. | Direct source: M08-001, M08-014, M11-007 | MISSING: patient RAG Q&A. |
| FR-018 | RAG answers shall retrieve and be grounded in the particular patient’s uploaded records rather than unrelated records. | Direct source: M08-002, M08-013, M08-014 | MISSING: actual same-patient RAG grounding. |
| FR-019 | The system shall provide natural-language retrieval of relevant medical documents from the records the requester is authorized to access. | Direct source: M08-003, M08-015, M12-008 | MISSING: natural-language retrieval. |
| FR-020 | The system shall use embeddings, chunking, vector search/retrieval and grounded generation for RAG processing. | Direct source: M08-004, M08-009, M08-010 | MISSING: chunk/embedding/vector retrieval pipeline. |
| FR-021 | Agent-based orchestration shall support the multi-step record-retrieval and summarization tasks where needed. | Direct source: M08-005, M08-012 | MISSING: LangGraph orchestration. |
| FR-022 | Authorized healthcare professionals shall be able to access AI-assisted record summaries and insights for accessible patient records. | Direct source: M07-003, M07-009, M12-006 | MISSING: authorized doctor summaries/AI. |
| FR-023 | The AI shall be informational and assistive and shall not independently diagnose, replace a medical professional or make final clinical decisions. | Direct source: M07-007, M08-006, M08-018, M08-019 | PARTIAL: summary safety validators; actual assistant/AI qualification absent. |
| FR-024 | Any symptom-related suggestions shall remain non-diagnostic and oriented toward consultation with qualified professionals. | Direct source: M08-007, M08-018, M08-019 | MISSING: constrained symptom guidance. |
| FR-025 | Healthcare professionals shall view only patient information for which patient access authorization has been granted. | Direct source: M06-006, M07-009, M08-013, M08-015, M09-001, M09-011, M09-015, M12-005 | PARTIAL: selected-grant schema; doctor authorization runtime absent. |
| FR-026 | The patient application shall display a patient QR code for doctor/healthcare-professional sharing as described in the project scope. | Direct source: M09-002, M09-009, M11-008 | MISSING: QR workflow. |
| FR-027 | The application shall support a unique sharing link for a doctor in the online-appointment use case. | Direct source: M09-003, M09-009 | MISSING: unique link workflow. |
| FR-028 | Access via the unique sharing link shall include verification by OTP through the doctor’s email. | Direct source: M09-004, M09-010, M12-004 | MISSING: doctor email OTP workflow. |
| FR-029 | The doctor web interface shall provide access to authorized records and permit searching and filtering. | Direct source: M09-005, M12-005, M12-006 | MISSING: doctor record search/web. |
| FR-030 | The patient shall be able to initiate/request secure sharing of records from the user interface. | Direct source: M09-006, M11-008 | MISSING: share creation/revocation UI/API. |
| FR-031 | After successful processing, the system shall make the report copy and AI summary eligible for guardian delivery under the configured routine digest policy. Serious-rule alerts are separate and shall not wait for the routine digest window. | Direct source: M10-001, M10-005 | MISSING: post-processing digest delivery. |
| FR-032 | The system shall email the guardian when a report is potentially serious under the system’s defined rules. | Direct source: M10-002, M10-013 | MISSING: serious notification engine/delivery. |
| FR-033 | The system shall use email services or APIs for the guardian notifications. | Direct source: M10-003, M10-009 | PARTIAL data foundation: email event schema; no sender. |
| FR-034 | The system shall provide a React Native patient mobile interface. | Direct source: M11-001, M11-002, M11-003, M11-004, M11-006 | MISSING: React Native app. |
| FR-035 | The system shall provide a React.js + Vite web interface for authorized doctor access and the approved administrative dashboard. | Direct source: M12-001, M12-004 | MISSING: React+Vite doctor/Admin apps. |
| FR-036 | The system shall provide categorized document search and summaries through the supported interfaces as appropriate to user authorization. | Direct source: M04-009, M12-002 | PARTIAL: owner backend categorized search; client/doctor scope incomplete. |
| FR-037 | The system shall verify the patient email address before email-dependent account recovery or other security-sensitive email workflows are considered trusted. | Direct source: M01-004, M01-007 | MISSING: verified-email trust. |
| FR-038 | The system shall support secure logout, bounded session/token lifetime, secure session renewal where used, revocation, and invalidation of prior sessions after credential reset/change according to configured policy. | Direct source: M01-005, M01-009, M01-010, M01-011 | PARTIAL: expiry exists; logout/revocation/renewal/reset invalidation absent. |
| FR-039 | The system shall support forgot-password and password-reset flows using the verified patient email, rate limiting, expiring reset authorization and session invalidation after successful reset. | Direct source: M01-006, M01-012 | MISSING: verified-email recovery/reset. |
| FR-040 | The patient may optionally nominate one primary guardian during registration or later from profile settings. The relationship shall remain pending until secure guardian email verification/acceptance succeeds. | Direct source: M02-001, M02-005, M02-006, M02-009, M10-008, M11-003 | MISSING: pending nomination/secure guardian acceptance. |
| FR-041 | The patient shall be able to view guardian status, resend an unexpired/rate-limited invitation, replace the guardian, or remove the guardian. Removal/replacement shall immediately prevent future medical communications to the prior guardian. | Direct source: M02-002, M02-006, M02-007, M02-008, M10-008, M10-014, M11-003 | PARTIAL data foundation: consent revocation timestamp only. |
| FR-042 | Routine guardian delivery shall group successfully processed report copies and AI summaries within the configured digest window, default 24 hours. A serious-rule alert shall be separate and shall not wait for the routine digest. | Direct source: M10-004, M10-006, M10-007 | MISSING: configured digest/separate prompt serious alerts. |
| FR-043 | The patient shall be able to delete an owned medical record. Deletion shall revoke sharing and remove or render inaccessible derived OCR text, chunks, embeddings and summaries according to the approved retention/deletion policy. | Direct source: M04-005, M04-012, M04-013, M04-014, M06-007, M11-005 | MISSING: record-deletion propagation. |
| FR-044 | The patient shall be able to request deletion of their account through a controlled privacy workflow consistent with approved retention/legal obligations. | Direct source: M11-009, M15-001, M15-002, M15-003 | MISSING: account-deletion privacy workflow. |
| FR-045 | RAG answers shall identify supporting source document(s) and shall state when the authorized record set is insufficient to support an answer rather than fabricating facts. | Direct source: M08-008, M08-016, M08-017, M11-007, M12-008 | MISSING: cited/insufficient-evidence RAG. |
| FR-046 | A doctor with a valid grant and successful OTP verification may securely view and download only the explicitly shared original documents while the grant remains valid; revocation/expiry shall block subsequent file/API/RAG requests. | Direct source: M06-007, M09-007, M09-015, M09-016, M09-017, M12-007, M12-009, M15-011 | MISSING: current-grant doctor original download with next-request revocation. |
| FR-047 | The system shall provide a separately authenticated Admin Dashboard using least-privilege role-based access control. | Direct source: M13-001, M13-010, M13-011 | MISSING: separate Admin auth/RBAC/dashboard. |
| FR-048 | Authorized admins shall search and filter patient accounts and view account/verification status, and may suspend/reactivate accounts through audited actions. Admins shall not edit medical facts. | Direct source: M01-009, M13-002, M13-012, M13-013 | MISSING: Admin account management. |
| FR-049 | Authorized admins shall view operational document-processing status and failures and may trigger only approved safe retry actions where the underlying workflow permits retry. | Direct source: M13-003, M13-014 | MISSING: Admin safe operational retry. |
| FR-050 | Authorized admins shall view guardian relationship status, sharing-grant status and notification/email delivery status without receiving unrestricted medical-content access. | Direct source: M13-004, M13-015 | MISSING: Admin guardian/sharing/delivery oversight. |
| FR-051 | Authorized admins shall manage approved operational configuration values exposed by policy, including guardian digest hours, upload limits and security lifetimes. Changes shall be validated, versioned/audited and shall not bypass release-gated configuration controls. | Direct source: M13-005, M13-016 | MISSING: Admin validated/audited versioned configuration. |
| FR-052 | Authorized admins may manage only approved, versioned serious-rule configurations. Rules intended for real-patient use require the clinical approval defined by CFG-06; administrative editing does not constitute clinical validation. | Direct source: M10-011, M13-006, M13-017 | MISSING: Admin clinically gated versioned rule management. |
| FR-053 | The Admin Dashboard shall provide system-health and processing visibility sufficient to identify failed/degraded operational components without exposing secrets or unrelated patient medical content. | Direct source: M13-007, M13-018 | PARTIAL: safe worker/API/DB health foundations; no Admin visibility. |
| FR-054 | Every privileged administrative action and any exceptional support access to sensitive patient medical content shall generate an audit record identifying actor, action, target/scope, time and outcome. Exceptional medical-content access requires explicit authorization and shall be minimized. | Direct source: M13-008, M13-019, M13-020, M13-022, M15-010 | MISSING: product privileged/exceptional audit workflow. |
| FR-055 | Administrative privileges shall never substitute for patient authorization in doctor sharing/RAG flows and shall not create a hidden general-purpose mechanism for browsing, downloading or modifying patient medical records. | Direct source: M13-009, M13-020, M13-021 | MISSING: explicit Admin medical-content default-denial/authorization controls. |

### NFR register

| SRS item | Approved requirement / scenario | PRD requirement links | Current disposition |
| --- | --- | --- | --- |
| NFR-01 | Medical document storage and record access shall be secured; clinician access shall be constrained to information permitted by the patient. | Direct source: M01-008, M01-013, M01-014, M02-010, M03-007, M03-012, M04-010, M05-004, M06-005, M09-013, M14-005, M14-006, M14-011, M15-004, M15-007, M16-003, M17-006 | PARTIAL: owner/private-file constraints; missing session/doctor/RAG/Admin/deletion paths. |
| NFR-02 | Testing shall rely on test or de-identified patient data; real patient data shall require permission/authorization. | Direct source: M15-008, M16-006 | IMPLEMENTED for existing synthetic-fixture/default-test practice; no real-data approval inferred. |
| NFR-03 | Patients and professionals shall be able to locate and understand medical information conveniently; summaries shall use simple language. | Direct source: M11-010, M17-007 | PARTIAL: record filters/plain summary contracts; clients/usability absent. |
| NFR-04 | Answers and summaries shall be based on the user’s uploaded record information; clinical judgment remains with healthcare professionals. | Direct source: M06-008, M07-007, M17-004 | PARTIAL: typed source-grounded summary contracts only; actual model/RAG absent. |
| NFR-05 | Modules shall be built in Agile iterations with testing, review, feedback, integration and refinement. | Direct source: M14-008, M17-001 | PARTIAL: historical iterations/evidence; active new-ID checker and full acceptance pending. |
| NFR-06 | Cloud services and AWS computing or suitable alternatives shall support deployed application components. | Inherited module scope: M16 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: historical synthetic S3/local/disposable infrastructure; integrated AWS absent. |
| NFR-07 | Patient records shall be validated for safe, appropriate handling and processing. | Inherited module scope: M03, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: strong input/extraction validation; full processing/AI safety qualification pending. |
| NFR-08 | React Native mobile, React/Next web, Node/Express backend and Python AI/document processing shall interoperate. | Direct source: M14-007 | PARTIAL with C01 conflict: Node OCR ownership, incomplete Python/client interoperation; DEC-13 governs web stack. |

### DEC register

| SRS item | Approved requirement / scenario | PRD requirement links | Current disposition |
| --- | --- | --- | --- |
| DEC-01 | PostgreSQL on Amazon RDS; pgvector preferred subject to measured suitability. | Direct source: M08-010, M14-002, M14-003, M16-002 | PARTIAL: PostgreSQL foundation; RDS unqualified, CFG-02 vector benchmark absent. |
| DEC-02 | Patient React Native mobile; doctor React.js + Vite web; admin React.js + Vite dashboard; Node.js + Express backend. | Inherited module scope: M11, M14 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: Node/Express only; all three clients absent. |
| DEC-03 | Node.js/Express orchestrates application/document lifecycle; Python FastAPI handles OCR/AI-specific processing; LangChain is required for RAG/retrieval and LangGraph for multi-step orchestration; hosted LLM provider/model remains controlled configuration; pgvector where suitable. | Direct source: M05-006, M14-001, M14-004 | PARTIAL with C01/C05: Python summary factory only, Node OCR and absent LangChain/LangGraph. |
| DEC-04 | QR physical / unique link online; both require patient permission and doctor email OTP. | Direct source: M09-010 | MISSING: QR/link both require doctor OTP runtime. |
| DEC-05 | After successful processing, routine guardian report copies + AI summaries are grouped under a configurable digest window (default 24 hours); a separate rule-triggered serious-finding alert is sent promptly and does not wait for the digest. | Inherited module scope: M10 (all module row IDs in tracker; not an acceptance pass) | MISSING: digest/separate serious flow. |
| DEC-06 | RAG-grounded records and summaries, general symptom education, safety-constrained visit guidance; no diagnosis/prescribing/final treatment decisions. | Direct source: M08-019 | PARTIAL: summary safety schemas; no RAG/symptom guidance. |
| DEC-07 | PDF/JPG/JPEG/PNG; lab/prescription/other categories; hospital and document/upload dates; validation; OCR; processing/completed/failed; retries. | Direct source: M03-004, M03-005, M03-008, M03-009, M03-010, M03-011, M04-006, M04-007, M04-008, M04-011, M06-004, M14-009 | PARTIAL: types/metadata/validation/OCR; aggregate lifecycle needs reconciliation. |
| DEC-08 | AWS-based hosting, RDS PostgreSQL, private S3, HTTPS, secrets, monitoring and backups. | Direct source: M15-005, M15-006, M16-001, M16-002, M16-003, M16-004, M16-005 | PARTIAL: private S3/code foundations only; integrated AWS operations absent. |
| DEC-09 | Authenticated patients; doctors via authorized share + doctor email OTP without mandatory persistent doctor accounts; guardians receive email only after verified acceptance; admins use a separate privileged RBAC-protected account. | Direct source: M09-018, M12-010 | PARTIAL: patient identity/schema only; doctor/guardian/Admin actor flows absent. |
| DEC-10 | Patient selects shared records; grants expire automatically and may be revoked immediately. Defaults: QR/share session 1 hour, online link 24 hours, OTP 10 minutes; all remain configurable and enforced across file/API/RAG access. | Direct source: M09-008, M15-011 | PARTIAL: selected-record/expiry/revocation schema; runtime missing. |
| DEC-11 | Clinically reviewed predefined alert rules; AI explanation of flagged findings; indeterminate when not interpretable. | Direct source: M10-011, M10-012, M10-013 | PARTIAL data foundation: versioned three-outcome result schema; clinical rule engine/approval absent. |
| DEC-12 | Comprehensive unit, integration, E2E, security, OCR, RAG, email, performance, usability, backups and AWS release verification. | Direct source: M05-010, M07-008, M08-021, M14-009, M14-010, M15-012, M17-001, M17-002, M17-005, M17-006 | PARTIAL: substantial historical focused/disposable tests; comprehensive acceptance absent. |
| DEC-13 | React.js + Vite is authoritative for the doctor web interface and the admin dashboard. The patient application remains React Native. | Direct source: M12-003, M13-010 | MISSING client architecture; no Vite apps implemented. |
| DEC-14 | Routine guardian report-copy + AI-summary delivery occurs only after successful processing and is grouped under a configurable digest window, default 24 hours. Serious-rule alerts are separate and sent promptly after successful processing/rule evaluation. | Direct source: M10-007 | MISSING: post-processing24h default digest/separate alert. |
| DEC-15 | Node.js + Express owns application APIs and orchestrates the document lifecycle; Python FastAPI owns OCR/AI-specific processing services. | Direct source: M05-006, M14-001, M14-004 | PARTIAL with C01: Node orchestrates and also executes OCR. |
| DEC-16 | LangChain is required for retrieval/RAG components and LangGraph is required for multi-step agentic orchestration. | Direct source: M08-011, M08-012 | MISSING: required LangChain/LangGraph integrations. |
| DEC-17 | Patient-account security includes email verification, logout, session/token expiry, secure renewal, forgot-password/reset, session invalidation after password reset/change, rate limiting, and secure token handling. | Direct source: M01-012, M01-013, M11-002 | PARTIAL: Argon2/JWT/limits; verification/recovery/revocation absent. |
| DEC-18 | Guardian is optional. A patient may have one active primary guardian at a time. The patient may nominate, resend, replace or remove the guardian. The guardian must verify/accept through a secure email flow before receiving medical communications; removal/replacement immediately revokes future delivery. | Direct source: M02-003, M02-004 | PARTIAL with C03: optional registration and consent schema; one-active/verified lifecycle absent. |
| DEC-19 | Default configurable security lifetimes are: QR/share session 1 hour, online unique-link grant 24 hours, doctor email OTP 10 minutes. Patient selects exact shared records every time. Doctor name + email are collected; organization is optional; no professional-license verification module is added. | Direct source: M09-008, M09-012, M09-014 | PARTIAL: grant/email/expiry data fields; default lifetimes, name, OTP and per-request enforcement absent. |
| DEC-20 | Patients may delete individual medical records and may request account deletion. Record deletion propagates to derived OCR text, chunks, embeddings, summaries and sharing access subject to the approved retention/legal policy. Account deletion is a controlled privacy workflow. | Direct source: M04-012 | MISSING: record/account deletion runtime. |
| DEC-21 | First-release AI summaries are English-only. RAG answers shall cite supporting uploaded source documents and explicitly state when permitted records do not contain enough information rather than guessing. Serious-report logic uses configurable versioned rules; only approved/demo rules may be used until clinical review. | Direct source: M07-006, M08-016 | PARTIAL: English summary templates and serious-result schema; cited/insufficient RAG and rule engine absent. |
| DEC-22 | An Admin Dashboard is in scope. Admin is a formal privileged actor with least-privilege RBAC and audit logging. Admin may manage patient account status and operational workflows, view guardian/sharing/notification/processing status, manage approved configuration and serious-rule versions, and monitor system health. Sensitive medical-content access is not implicit in the admin role and any exceptional support access must be explicitly authorized, minimized and audited. | Direct source: M15-004 | MISSING: separate Admin identity/RBAC/operations/audit/default medical denial. |

### CFG register

| SRS item | Approved requirement / scenario | PRD requirement links | Current disposition |
| --- | --- | --- | --- |
| CFG-01 | Hosted LLM provider, exact model/version, data handling agreement and geographic processing | Direct source: M07-008, M08-022, M18-006 | BLOCKED: approve hosted provider/model/version/geography/data handling before sensitive use. Release gate: Must be approved and validated before sensitive content is sent |
| CFG-02 | Embedding model, dimensionality, pgvector/index feasibility and retrieval performance | Direct source: M08-010, M14-003, M18-007 | BLOCKED: model/dimensions/index suitability benchmark and selection absent. Release gate: Benchmark before DB/index freeze |
| CFG-03 | Maximum PDF/image upload size and resource quotas | Direct source: M03-005 | PARTIAL: tested bounded5MiB upload default/resource config; final approved release quotas unresolved. Release gate: Document and test thresholds |
| CFG-04 | Doctor OTP lifetime, retry/rate limits and email delivery service | Direct source: M09-014, M09-019, M15-007 | BLOCKED release policy: default 10m established by decision; email/attempt/rate values and security review absent. Release gate: Security-review and negative testing |
| CFG-05 | QR/link grant lifetime, session behavior and expiration duration | Direct source: M09-014 | PARTIAL: default 1h QR/24h link confirmed; runtime session/expiry enforcement absent. Release gate: Document, test and enforce on all access paths |
| CFG-06 | Clinical serious-report rule set, laboratory units/ranges, age/sex context and thresholds | Direct source: M10-011, M13-017, M18-003 | BLOCKED: qualified clinical rule/unit/range/age/sex approval absent. Release gate: Qualified clinical approval mandatory for real-patient use |
| CFG-07 | Indeterminate detection messaging and guardian notification handling | Direct source: M10-012 | BLOCKED: approved indeterminate wording/guardian handling absent. Release gate: Approved human-readable user safety wording |
| CFG-08 | AWS compute topology, IAM, network layout, encryption keys and regions | Direct source: M16-001, M16-004, M16-005 | BLOCKED: compute/topology/IAM/network/keys/regions approval absent. Release gate: Infrastructure security review |
| CFG-09 | Backup schedule, restore targets, monitoring alerts and incident response contacts | Direct source: M16-007, M16-008 | BLOCKED: backup schedule/targets/alerts/incident ownership/rehearsal absent. Release gate: Operational readiness rehearsal |
| CFG-10 | Performance, availability, OCR, RAG and summary quality acceptance thresholds | Direct source: M07-011, M08-021, M17-003, M17-004, M17-008, M18-008 | BLOCKED: complete measurable performance/availability/AI/OCR/RAG/usability thresholds absent. Release gate: Defined measurable test plan and recorded evidence |
| CFG-11 | Guardian consent/authorization setup and permitted email content handling | Direct source: M02-009, M02-010, M10-008, M18-004 | BLOCKED: guardian consent/privacy/email-content approval absent. Release gate: Legal/privacy review before real-patient use |
| CFG-12 | Privacy retention, deletion obligations and patient-data processing compliance | Direct source: M15-009, M18-005 | BLOCKED: retention/deletion/compliance approval absent. Release gate: Applicable legal and organizational approval |
| CFG-13 | Patient-facing web access: proposal mentions patient-friendly web generally while implementation selects patient mobile + doctor web | Direct source: M11-011 | IMPLEMENTED scope constraint: no additional patient web exists. Release gate: No additional patient web interface unless separately approved |
| CFG-14 | Source-level ambiguity: whether sharing means every record by default or patient selection | Inherited module scope: M18 (all module row IDs in tracker; not an acceptance pass) | PARTIAL runtime: DEC-10 resolves selection; schema supports exact scope, API missing. Release gate: Resolved by DEC-10: patient-selected documents only |
| CFG-15 | Guardian routine digest window; default 24 hours. | Direct source: M10-006 | PARTIAL:24h default confirmed; versioned/tested digest configuration absent. Release gate: Operational configuration must be versioned/tested; serious alerts are not delayed by this value. |
| CFG-16 | Access/session lifetime, renewal, logout/revocation, password-reset token lifetime and authentication/recovery rate limits. | Direct source: M01-010, M01-011, M01-012, M15-007 | BLOCKED release policy:900s JWT default/limits are not complete approved session/reset/revocation design. Release gate: Security review and negative-path tests required before release. |
| CFG-17 | Admin RBAC roles/permissions, exceptional support-access approval process and audit retention. | Direct source: M13-020, M15-010 | BLOCKED: role/exceptional-access/audit-retention security/privacy policy unresolved. Release gate: Security/privacy approval and V-32/V-33 evidence required. |
| CFG-18 | Record/account deletion retention, legal hold and irreversible-deletion timing. | Direct source: M04-012, M15-003, M15-009, M18-005 | BLOCKED: retention/legal hold/irreversible timing and deletion/recovery tests absent. Release gate: Privacy/legal approval and deletion/recovery tests required before real-patient use. |

### AT register

| SRS item | Approved requirement / scenario | PRD requirement links | Current disposition |
| --- | --- | --- | --- |
| AT-01 | Register/login/profile: patient can create an account, authenticate and update profile. | Inherited module scope: M01, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: historical backend register/login/profile; verification/security/mobile incomplete. |
| AT-02 | Upload PDF and image: originals are stored in S3 and accessible only to the owning patient or authorized requester. | Inherited module scope: M03, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: historical private S3/patient upload; doctor/current deployment absent. |
| AT-03 | Record metadata and categorization: hospital, upload date and type are available for filtering. | Inherited module scope: M03, M04, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: backend metadata/filter validation; category/date/lifecycle/client reconciliation pending. |
| AT-04 | OCR: sample scanned report/image yields processed text associated with its source record. | Direct source: M17-003 | NEEDS_REVERIFICATION: Node OCR source association evidence; Python boundary/quality qualification pending. |
| AT-05 | Timeline: uploaded medical records appear in chronological order using their available dates. | Inherited module scope: M06, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: backend chronology/fallback; doctor/client absent. |
| AT-06 | AI summaries: uploaded report and patient history can be summarized in simple language. | Inherited module scope: M07, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: fake one-report summary only; actual/history absent. |
| AT-07 | Patient RAG question: answer uses appropriate same-patient document content; other-patient records are never included. | Inherited module scope: M08, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: RAG runtime. |
| AT-08 | Clinician AI and search: authorized doctor can retrieve, filter and summarize shared material only. | Inherited module scope: M07, M08, M12, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: doctor grant/OTP/search/summary runtime. |
| AT-09 | Non-diagnostic safety: representative prompts do not cause the assistant to issue independent diagnoses/final treatment decisions. | Inherited module scope: M08, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: fake summary safety checks, actual assistant/symptom/rules absent. |
| AT-10 | QR access: use patient QR path; confirm access is restricted to authorized material. | Inherited module scope: M09, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: QR authorized access. |
| AT-11 | Link/OTP: doctor accessing patient share link must verify through doctor email OTP. | Inherited module scope: M09, M12, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: unique-link/doctor OTP. |
| AT-12 | Guardian email: successful processing makes the report copy and summary eligible for configured digest delivery; a flagged sample triggers a separate serious-report notification. | Direct source: M10-010 | MISSING: guardian digest/separate serious delivery. |
| AT-13 | Interface coverage: patient mobile functions and doctor web view support the relevant workflows. | Inherited module scope: M11, M12, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: integrated mobile/doctor interfaces. |
| AT-14 | Data/privacy test: synthetic or de-identified data are used during ordinary development and testing. | Inherited module scope: M15, M17 (all module row IDs in tracker; not an acceptance pass) | IMPLEMENTED at existing synthetic-test data scope; not a new data privacy approval. |

### V register

| SRS item | Approved requirement / scenario | PRD requirement links | Current disposition |
| --- | --- | --- | --- |
| V-01 | Register patient, login and open private profile | Inherited module scope: M01, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: own-profile backend evidence; full identity/security incomplete. |
| V-02 | Patient A requests Patient B document/API or S3 object | Direct source: M03-012 | PARTIAL: patient file/API/storage isolation; no full integrated doctor/vector coverage. |
| V-03 | Upload valid PDF and valid JPG/JPEG/PNG | Inherited module scope: M03, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: backend synthetic valid uploads; whole current service/client path incomplete. |
| V-04 | Upload unsupported, oversized or damaged file | Direct source: M03-006 | PARTIAL: backend invalid-upload tests; integrated client/deployment incomplete. |
| V-05 | OCR scanned report and read native text PDF | Inherited module scope: M05, M17 (all module row IDs in tracker; not an acceptance pass) | NEEDS_REVERIFICATION: Node OCR/native extraction; Python boundary unqualified. |
| V-06 | Trigger OCR or AI processing error and retry | Direct source: M03-010, M03-011, M05-007, M05-008 | PARTIAL: extraction/fake AI failure/retry; complete required pipeline absent. |
| V-07 | Filter by hospital, category, upload date | Inherited module scope: M04, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: owner backend filters; doctor/client absent. |
| V-08 | Sort timeline with distinct document vs upload dates | Direct source: M06-003 | PARTIAL: backend date/fallback tests; complete timeline access/client scope absent. |
| V-09 | Generate one-report and longitudinal summaries | Inherited module scope: M07, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: fake report only; actual longitudinal summary absent. |
| V-10 | Ask RAG questions with present/absent facts | Inherited module scope: M08, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: present/absent-fact RAG. |
| V-11 | Supply prompt injection inside an uploaded record | Direct source: M05-009, M08-020 | MISSING: actual RAG uploaded-document injection isolation. |
| V-12 | Use QR sharing without doctor OTP | Direct source: M09-011 | MISSING: QR/OTP denial workflow. |
| V-13 | Use unique link with valid/invalid/expired OTP | Inherited module scope: M09, M12, M15, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: link/OTP valid/invalid/expired workflow. |
| V-14 | Revoke grant and allow grant to expire | Direct source: M09-016 | MISSING: doctor revocation/expiry. |
| V-15 | Share selected document A but not B | Inherited module scope: M09, M12, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL data foundation: selected-doc schema only. |
| V-16 | Process normal/routine report for guardian | Inherited module scope: M10, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: routine guardian sender. |
| V-17 | Trigger reviewed serious finding | Inherited module scope: M10, M17 (all module row IDs in tracker; not an acceptance pass) | BLOCKED real-patient use: clinical rules/approval; no serious sender. |
| V-18 | Supply ambiguous lab report for rule evaluation | Inherited module scope: M10, M17 (all module row IDs in tracker; not an acceptance pass) | BLOCKED: approved indeterminate handling and rule/email runtime absent. |
| V-19 | Ask AI to diagnose or prescribe | Inherited module scope: M07, M08, M17 (all module row IDs in tracker; not an acceptance pass) | PARTIAL: fake summary refusal checks only. |
| V-20 | Deploy entire integration on AWS | Direct source: M16-010 | MISSING: whole integrated AWS deployment. |
| V-21 | Run backup/restore and failure recovery drill | Direct source: M16-009, M16-010 | MISSING: whole-system restore/recovery drill. |
| V-22 | Run load, accessibility and mobile/web usability checks | Direct source: M17-007, M17-008 | BLOCKED: CFG-10 targets/clients/load/accessibility/usability qualification absent. |
| V-23 | Execute end-to-end patient→document→AI→sharing→guardian sequence | Direct source: M17-009 | MISSING: all-actor integrated E2E. |
| V-24 | Review comprehensive FR and NFR traceability | Direct source: M17-010, M18-001 | PARTIAL: accounting complete here; all-requirement executable acceptance/approval evidence absent. |
| V-25 | Verify patient email, logout, expiry/renewal, password reset and session invalidation. | Inherited module scope: M01, M11, M15, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING composite lifecycle: expiry primitive exists, verification/logout/reset invalidation absent. |
| V-26 | Nominate guardian, accept invitation, resend, replace and remove. | Inherited module scope: M02, M11, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: secure guardian lifecycle/one-active/concurrency. |
| V-27 | Process multiple routine reports within the configured digest window and trigger one serious-rule report. | Direct source: M10-010 | MISSING: digest/separate serious sender/retries. |
| V-28 | Delete an owned record after OCR, summary, vector indexing and sharing. | Direct source: M04-013, M04-014 | MISSING: record-deletion propagation. |
| V-29 | Request patient-account deletion. | Inherited module scope: M11, M15, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: account-deletion workflow. |
| V-30 | Ask RAG questions with sufficient and insufficient authorized evidence. | Inherited module scope: M08, M11, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: RAG citations and transparent insufficiency. |
| V-31 | Doctor views/downloads one selected original, then patient revokes the grant. | Direct source: M09-016 | MISSING: doctor selected-file download/next-request revocation. |
| V-32 | Admin signs in and attempts allowed/forbidden account operations. | Direct source: M13-011 | MISSING: Admin identity/RBAC/audit operations. |
| V-33 | Admin attempts direct medical-content browsing without exceptional authorization, then performs an explicitly authorized support access. | Inherited module scope: M13, M15, M17 (all module row IDs in tracker; not an acceptance pass) | BLOCKED support policy CFG-17: no Admin default-denial/exceptional workflow. |
| V-34 | Admin reviews processing failures, retries an eligible job, changes an allowed configuration value, inspects health and manages a versioned serious-rule configuration. | Inherited module scope: M13, M17 (all module row IDs in tracker; not an acceptance pass) | MISSING: audited Admin safe retry/config/health/rules operations. |

## H. Existing code that can be safely reused

Reuse is scoped to matching behavior and retained evidence, never an old module completion label. Keep current Argon2id, normalized uniqueness and sanitized profile projections; JWT claim/time validation; explicit owner-derived SQL allowlists; document type/integrity/resource guards and original-preserving compensation; metadata/date fallback/filtering; authenticated original-byte streaming/storage rechecks/cancellation; composite-owner database keys; source hashes/page provenance; worker leases/fenced extraction/summary snapshots/publication; private FastAPI/schema/synthetic evaluation foundations. Preserve useful offline native-authority/credential/supervision contracts subject to topology review. Missing workflows must build on these foundations without treating constraints/fakes as the completed feature.

### Historical evidence reuse assessment

| Evidence | Reuse assessment | Scope and qualification limit |
| --- | --- | --- |
| B01 manifest/receipt | PARTIALLY VALID | 876 historical offline checks; old source/ID completeness obsolete; no live/model/cloud evidence. |
| B02 receipt | PARTIALLY VALID | 726 disposable (270 backend,24 B02 within overlapping suites) and 876 offline checks; unchanged primitives reusable; app/worker assembly changed. |
| Original B03 receipt | NEEDS REQUALIFICATION | Broad short-lease summary failure remains failed history; focused73 rerun cannot convert broad outcome to pass. |
| B03.1/B03.2 diagnostics | VALID as diagnostic history | Retain original BLOCKED/anomaly findings; no historical root cause or reliability claim inferred. |
| B03.3 | PARTIALLY VALID | PASS at test-contract correction scope;758 disposable/878 offline overlap; original failed schedules remain unexplained. |
| B03.4 | PARTIALLY VALID | 810 broad disposable/924 offline; leases/orchestration/fakes; deployed runtime OPEN. |
| B03.5 | PARTIALLY VALID | 1000 broad offline plus targeted final correction;77 distinct new cases; final supplement outside original broad snapshot. |
| B03.6 | PARTIALLY VALID | 1102 broad offline; receipt outcome BLOCKED_IMPLEMENTATION_CLOSURE; passing tests do not close assembly/runtime. |
| B03.7 | PARTIALLY VALID | 1151 broad offline,33 native Python and post-broad1 TS correction; PASS_OFFLINE_COMPONENT_SCOPE; final launch/network/cloud qualification OPEN. |
| Module01 receipt | PARTIALLY VALID | 16 new+24 B02=40 route checks,18 old completeness checks; BACKEND_QUALIFIED_MODULE_OPEN; no verification/revocation/recovery lifecycle. |
| Phase 2.2D live synthetic S3/OCR | NEEDS REQUALIFICATION | Historical report/ledger scope only; no current AWS probe or reopening of private raw report in this phase. |
| Phase 3A summary/evaluation/Ollama | PARTIALLY VALID | Typed/fake contracts, snapshots/fencing,42 synthetic expected outcomes and frozen benchmark cases; no accepted hosted model/current real-generation quality. |
| Old completeness tracker/checker/17-module report | OBSOLETE as current requirement inventory | Preserve historical content.16/127 and 17/201 cannot establish18/232 coverage. |

Historical totals overlap and must not be summed into a current passing test count. Hash identity supports reuse assessment, not a fresh test run. Source-pin comparison results:

- `docs/baselines/B02_VALIDATION_RECEIPT.json`: 202 matching hashes, 13 changed, 1 missing. Changed: `.gitignore`, `backend/package.json`, `backend/src/app.ts`, `backend/src/processing/background-config.ts`, `backend/src/processing/background-runtime-core.ts`, `backend/src/processing/worker.ts`, `backend/src/stage-c/system-supervision.ts`, `backend/src/summary-checks/executor.unit.ts`, `backend/src/summary-db-checks/lifecycle.check.ts`, `docs/BACKEND_MASTER_ROADMAP.md`, `docs/PROJECT_IMPLEMENTATION_STATUS.md`, `docs/SRS_REQUIREMENTS_TRACEABILITY.md`, `infrastructure/summary-db/run-tests.ts`. Missing: `docs/AI_Health_Wallet_Final_SRS_v3.docx`.
- `docs/baselines/MODULE_01_QUALIFICATION_20261024.json`: 2 matching hashes, 8 changed, 0 missing. Changed: `backend/package.json`, `docs/BACKEND_MASTER_ROADMAP.md`, `docs/PROJECT_IMPLEMENTATION_STATUS.md`, `docs/PRD_MODULE_DELIVERY_TRACKER.md`, `docs/SRS_REQUIREMENTS_TRACEABILITY.md`, `infrastructure/requirements/test_check_prd.py`, `infrastructure/requirements/check_prd.py`, `docs/baselines/PRD_MODULE_DELIVERY.json`. Missing: none.

- `docs/baselines/B03_7_OFFLINE_QUALIFICATION_20261024_5uWELmBA.json`: 27 matching hashes, 0 changed, 0 missing. Changed: none. Missing: none.
- All four migration hashes in the B03.7 receipt also match. B02 source-matched document/auth primitives provide credible narrow evidence; assembly changes require requalification. Module01 focused test/report match; later package/docs/checker differences prevent treating its whole snapshot as current.

## I. Existing code that conflicts with the new baseline

| Conflict | Observed issue | Affected new requirements | Smallest safe reconciliation |
| --- | --- | --- | --- |
| C01 | OCR/native PDF processing executes in Node; Python currently exposes summary factory only. | M05-001/003/006; M14-004 | Keep Node ownership/lifecycle/leases/persistence. Move processing behind authenticated versioned Python FastAPI with preserved fixtures/provenance/cancellation/limits and equivalent qualification. |
| C02 | JWT verification is stateless; no server revocation/account suspension predicate. | M01-002/005/009/010; M15-003 | Add persistent session/token version/current account checks and atomic reset/logout/invalidation; retain existing hash/JWT checks. |
| C03 | guardian_contacts permits multiple contacts without verified one-active-primary lifecycle. | M02-001/004/008; M10-008/014 | Add pending/active/removed/replaced invitation/acceptance state and one-active constraint; preserve old contacts/events; recheck active verified recipient before send. |
| C04 | persist_document_extraction sets medical_documents completed before required embedding/summary stages. | M03-009/010; M05-007; M14-008 | Preserve stage extraction success; define aggregate required-stage readiness and eligibility separately; never let extraction completion alone qualify guardian delivery. |
| C05 | Required LangChain/LangGraph missing; hand-written summary workflow is not the required graph. | M08-005/011/012 | Add mandated retrieval/graph at Python boundary, reusing scoped schema/validation; this is missing architecture, not a conflicting deployed graph. |
| C06 | Historical local-only/zero-paid inference direction does not satisfy approved hosted-provider architecture. | M08-022; M18-006; M07 provider integration | Retain offline Ollama benchmark assets; choose/approve hosted provider under CFG-01 before sensitive use. Reconciliation authorizes neither model calls nor spending. |
| C07 | No product Admin identity/RBAC/audit/dashboard; root operational broker is not Admin. | M13-001–022; M15-010 | Add separate identity, least-privilege role/audit/metadata-only operational contracts and explicitly authorized support access. No implicit medical browsing. |
| C08 | Trusted-delivery artifacts are offline/partly assembled around existing Node processing; no approved integrated AWS topology. | M16-005/010; M14 service boundary | Reuse appropriate components after Python/topology contracts settle; finish actual chosen packaging/connector/containment and qualify before deployment. |
| C09 | Internal other_medical_document enum is not explicitly mapped to approved public Other label. | M04-002/006 | Keep stored enum, define/test public category label mapping without destructive rewrite; translation gap rather than proven clinical classification error. |
| C10 | Old active checker pins16 modules/127 controls/36 FR and missing historical DOCX names; old roadmap proposes B03.8. | M17-011; M18 governance | Preserve old artifacts; new tracker/report govern accounting. Migrate active validator/roadmap later only under implementation authorization; do not execute B03.8. |
| C11 | Restrictive foreign keys/immutable source snapshots and storage compensation do not implement patient deletion. | M04 deletion; M15 account deletion | Preserve integrity, add logical access denial/deletion-state/audited policy-driven cleanup across originals/derived data/shares/backups under CFG-12/18. |

Conflicts are findings attached to PARTIAL/MISSING/NEEDS_REVERIFICATION/BLOCKED rows, not a sixth status. Absence of clients/Admin/RAG is a gap, not evidence that an unsafe deployed implementation exists. New approved architecture overrides outstanding old amendment proposals. No code is deleted or changed here.

## J. New or expanded requirements introduced by the baseline

Relative to the historical36-FR/16-module 127-control baseline, SRS v4 adds FR-037–055: patient email verification; session/logout/renewal/recovery/reset/invalidation; verified optional one-primary-guardian lifecycle; configurable 24h routine digest separated from serious alerts; record and account deletion; RAG source citations and transparent insufficiency; current-grant doctor original view/download; and separate Admin RBAC/accounts/operations/config/rules/health/audit/no-implicit-medical-access. DEC-13–22 fix React+Vite, Node/Python responsibilities and mandatory LangChain/LangGraph; CFG-15–18 control digest/auth/Admin/deletion policy; V-25–34 expand acceptance. Current232 rows refine these requirements, including queued guardian revocation, concurrency-safe relationship changes, append-only-from-user-perspective audit and truthful cross-service outcomes. They must not be counted as232 new product features or automatically assigned old module status.

## K. Requirements needing re-verification

| Requirement | Why existing evidence is insufficient | Required future qualification |
| --- | --- | --- |
| M03-002 | Private S3 adapter and historical synthetic S3 evidence exist; current approved deployed S3/application path needs qualification. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M03-007 | Owner/S3 reference constraints and privacy checks exist; qualify actual private-object behavior in the new integrated deployment. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M05-001 | Node scanned/image OCR exists and has historical evidence; migrate/requalify execution through mandated Python FastAPI boundary. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M05-003 | Existing native-text/scanned/mixed dispatch is Node-based; preserve fixtures and requalify equivalent Python service contract. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M14-010 | Four migrations/constraints have source-matched historical disposable evidence; qualify expanded schema and reproducibility in the eventual release environment. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M16-003 | Private-S3 adapter and historical synthetic checks exist; qualify current deployed privacy and every authorized object access path. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M17-002 | Historical DB/service integration receipts exist; changed assembly and new Python/actor/deletion contracts require focused qualification. | YES: focused new-baseline positive/negative/integration evidence required before completion. |
| M17-003 | Historical native/scanned/image source-association tests exist; qualify mandated Python processing and approved CFG-10 quality targets. | YES: focused new-baseline positive/negative/integration evidence required before completion. |

Every PARTIAL/MISSING row also needs its missing behavior verified after implementation; every BLOCKED row needs approval/selection evidence plus dependent qualification. Even IMPLEMENTED narrow primitives need appropriate regressions if changed and final integrated module acceptance. This phase executes none of these tests. Selected follow-up sets: M01 current-session negative/transaction races; M03/M04 owner/private-file/deletion scope; M05 Node↔Python parity/failure/cancellation/fencing; M07/M08 actual model grounding/quality; M09 OTP/current grant/download; M02/M10 active-guardian/send races; M13 allowed/denied/audit/support; M16 actual deployment/recovery; M17 all AT/V/E2E.

## L. Missing implementation

The tracker has 113 MISSING rows, each with its own remaining gap. Complete verified identity/security/recovery, guardian acceptance/concurrency and delivery, deletion/privacy propagation, structured OCR/Python contracts, longitudinal/real-provider summaries, RAG/vector/citations/insufficiency/frameworks, doctor QR/link/OTP/grants/files/revocation, all clients/Admin product functionality, approved AWS runtime/recovery and complete quality/performance/accessibility/E2E remain absent or incomplete. Schema-only foundations and static scope restrictions do not close those workflows.

## M. Blockers

| Blocked requirement | Unresolved gate / dependency |
| --- | --- |
| M01-011 | Resolve CFG-16 technical/session policy: explicitly select renewal-free design or bounded revocable replay-resistant renewal. No refresh mechanism currently exists. |
| M07-011 | Approve CFG-10 summary quality thresholds/test plan; actual model evaluation depends on CFG-01 approval. |
| M08-010 | Resolve CFG-02 embedding model/dimensions/index benchmark before approved vector/index freeze; no current pipeline. |
| M08-022 | CFG-01 hosted provider/model/data handling/geography approval is not evidenced; no sensitive hosted use authorized. |
| M09-019 | CFG-04 delivery service/attempt/rate policy and security review unresolved; schema alone cannot enforce it. |
| M10-011 | Ruleset/result schema exists, no rule engine; qualified clinical CFG-06 approval required for real-patient rules. |
| M10-012 | Schema supports indeterminate result; approve CFG-07 wording/delivery handling and implement uncertainty-aware evaluation. |
| M13-020 | Approve CFG-17 exceptional support-access authorization/minimum scope/audit retention; Admin enforcement and support workflow are absent. |
| M14-003 | CFG-02 pgvector feasibility/model/dimensions/index benchmark unresolved. |
| M15-009 | Approve CFG-12/18 retention, original versions, derived data, audit, backups/legal holds before real-patient deletion claims. |
| M16-001 | CFG-08 compute/topology/regions/IAM/network approval unresolved; integrated AWS deployment absent. |
| M16-004 | Approve CFG-08 network/TLS topology, implement and qualify actual service traffic. |
| M16-008 | CFG-09 backup schedule/restore targets/RPO/RTO and incident ownership/rehearsal unresolved. |
| M17-008 | Approve CFG-10 performance/load/availability thresholds before final qualification; no measured integrated results. |
| M18-003 | Qualified clinical approver/rules/units/ranges/context approval not evidenced; gate real-patient activation. |
| M18-004 | CFG-11 privacy/legal guardian-consent/permitted-email-content approval absent. |
| M18-005 | CFG-12/18 retention/legal hold/deletion approval absent. |
| M18-006 | CFG-01 hosted model/provider/data-handling approval absent; local offline evaluation is not approval. |
| M18-007 | CFG-02 embedding/index suitability benchmark/selection absent. |
| M18-008 | CFG-10 measurable thresholds/test plan and acceptance approvals incomplete. |

BLOCKED rows are approval/selection-dependent claims, not a prohibition on independent safe synthetic work. Critical unresolved release gates: CFG-01 provider/data geography/handling; CFG-02 embedding/index benchmark; CFG-06/07 qualified rules/indeterminate handling; CFG-08/09 topology/operations/recovery; CFG-10 thresholds; CFG-11/12/18 consent/privacy/retention/legal hold; CFG-16/17 session/Admin policy. CFG-03/04/05/15 must have documented values/defaults, versioned enforcement, reviews and evidence. CFG-13/14 are confirmed scope decisions, not open product alternatives. No approver appointment or external approval is invented by this report.

## N. Recommended dependency roadmap

Use the new PRD phases as a dependency framework, reusing current foundations. Cross-cutting M14/M15/M17/M18 start with identity and continue throughout. Begin deletion/current-access contracts before producing vectors/shares/notifications, even though account-privacy hardening is numbered15. Split backend contracts from client acceptance: patient RAG does not wait for doctor web; basic grants need records/identity, doctor RAG extension additionally needs M08; guardian lifecycle is independent of summary generation, delivery is not. Admin authentication/audit/role contracts precede Admin implementation; operational UI follows stable domain APIs.

| Proposed phase | Scope | Dependency / exit condition |
| --- | --- | --- |
| 1 | M14 minimum foundation + M01 identity/security; M18 current-baseline/config tracking; M15 access/deletion contract; define Python and Admin boundaries | Complete safe verified-email/session/recovery backend contract with focused positive/negative/transaction tests; no downstream module/deployment activation. |
| 2 | M02 optional verified one-primary guardian + retained/finished M03 upload/storage | Identity/email contract stable; one-active/pending/acceptance/send eligibility defined; private originals retained. |
| 3 | M04 library/deletion access states; M05 Python processing; M06 patient timeline | Structured provenance/uncertainty, aggregate processing truth, same-source fenced retry, date confirmation/fallback and policy-controlled deletion. |
| 4 | M07 actual report/longitudinal summaries | M05/M06 stable; CFG-01/10 approvals as applicable; preserved source/model provenance and safety. |
| 5 | M08 chunking/embedding/vector benchmark/LangChain/LangGraph/RAG | Approved source scope/CFG-01/02; citations/insufficiency/injection/leakage/non-diagnostic tests. |
| 6 | M09 QR/link/doctor OTP/grants/files and doctor timeline/summary/RAG extension | Selected-record current authorization across every request, configured lifetimes, immediate revocation and deletion denial. |
| 7 | M10 guardian digest + separate serious alerts, approved/demo rule engine and send-time authorization | M02/M05/M07; CFG-06/07/11/15; bounded observable idempotent retry and recipient replacement/removal races. |
| 8 | M11 React Native + M12 React+Vite doctor integration | Stable patient/doctor APIs; complete approved actor workflows; truthful statuses and expiry/revocation UI. |
| 9 | M13 separate Admin API/dashboard/RBAC/append-only audit/operations/config | CFG-17 and stable domain/health APIs; default medical denial and explicit minimal exceptional support. |
| 10 | M15 privacy/security qualification and completion across all modules | Account/record deletion, retention/backup/legal hold, all-actor least privilege, abuse/revocation and negative-path closure. |
| 11 | M16 approved AWS/HTTPS/IAM/secrets/RDS/S3/network/monitoring/backup deployment | CFG-08/09; real chosen runtime/connector/credential/containment, restore and rollback evidence. |
| 12 | M17 integrated security/quality/performance/accessibility/usability/OCR/AI/AWS/E2E acceptance | AT-01–14/V-01–34 and approved thresholds; zero known blocking defects. |
| 13 | M18 final approvals/traceability/runbooks/known risks/FYP handover | All applicable CFG gates evidenced; accepted deployment and final documentation agree. |

Focused tests accompany future implementation; broad regression only at justified integration/release gates. No roadmap phase is executed by this reconciliation.

## O. Recommended first implementation phase

**Identity and backend security foundation: M01 plus only necessary M14/M15/M18 support.** Keep existing Argon2/JWT/owner/document behavior. Add verified-email challenges, current account/session authorization, logout, bounded renewal policy if used, recovery/reset and prior-session invalidation; define profile/security fields and privacy-safe events. Establish versioned Node lifecycle/Python processing and deletion/current-access contracts before downstream features. Document Admin separation and required audit policy without building the dashboard.

Proposed acceptance for owner review: (1) CFG-16 policy and email abstraction are explicit; (2) verification/reset challenges are hashed, purpose-bound, expiring, rate-limited and atomically single-use; (3) suspended/revoked/expired/reset/deletion-restricted credentials fail on every existing protected API/file path; (4) logout denies the next request and reset/change invalidates all prior sessions, including renewal races; (5) recovery avoids account enumeration and uses verified email only; (6) approved own-profile fields remain isolated and secret-free; (7) events are observable without secret/medical-content leakage; (8) additive/disposable migration and focused transaction/concurrency/auth/private-file regressions plus appropriate build/contracts have retained source-bound evidence; (9) active tracker/checker adopts18/232 and all 151 SRS IDs while preserving history; (10) backend AT-01/V-01/V-25 pass with mobile/deployed acceptance still open. Unresolved external release policies stay explicit; do not silently choose approval values.

**Stop for owner review.** No feature, development module, B03.8, service activation, test run, deployment, commit or push was started. The full completion target remains every SRS v4.0 and named PRD v2.0 requirement, with proper integrated evidence and approvals.

## Reconciliation accounting and preservation record

Inventory and output validation:232 unique detailed rows,18 modules,151 individual SRS rows, five permitted statuses only; row source text and priority/type agree with authoritative DOCX; all direct/inherited mappings nonempty; totals and module subtotals reconcile. These are structural analysis checks, not application tests. Historical evidence remains unchanged. The two new files are the only intended mutations.

Final preservation check: 307 of 308 pre-existing inventoried file SHA-256 hashes are unchanged, including application source, migrations, tests, approved baseline documents, old trackers/reports and public historical receipts. No inventoried file is missing. The sole content difference is the concurrent `.gitignore` edit noted in section B; its cause/author is not established. Git staging also changed concurrently. The reconciliation performed no Git mutation and did not revert those changes. Private evidence was neither opened nor modified.

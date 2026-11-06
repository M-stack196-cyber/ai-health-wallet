# AI Health Wallet: final handover report (Phase R9)

Date: 2026-11-06 (Asia/Karachi). Sources: SRS v4.0 and PRD v2.0 only. Written for the project owner and the people who will review or examine the project.

## 1. The short answer

The project is **a working, well-tested local prototype. It is not ready for real patients and it is not accepted for release.**

- All 232 PRD requirements are accounted for. 115 are IMPLEMENTED (local, synthetic evidence), 90 PARTIAL, 19 BLOCKED, 6 NEEDS_REVERIFICATION and 2 MISSING (M15-005 deployed HTTPS and M15-010 exceptional-access audit).
- The full chain (patient registers, uploads, text is read, summary and question answering, sharing with a doctor, guardian email) runs end to end on a local test stack with fake data (scenario V-23).
- Nothing has run on AWS, with a real email provider, with a real AI model, on a phone or with real people. Those parts are BLOCKED and are listed with what is needed in section 6.
- Nobody has signed off. The sign-off table in section 11 is empty on purpose. Claude and the developers cannot give clinical, privacy, security or operations approval.

## 2. What exists

| Part | What it is | Where |
| --- | --- | --- |
| Backend API | Node.js, TypeScript, Express 5, PostgreSQL. Patient, doctor and admin are separate actors with separate tokens. | `backend/` |
| Database | 21 additive migrations, row-level security, append-only audit tables. | `backend/migrations/` |
| AI service | Python FastAPI: OCR, summaries, record questions (LangChain and LangGraph). Runs with a synthetic offline provider only. | `ai-service/` |
| Patient app | React Native (Expo). | `frontend/apps/patient/` |
| Doctor web app | React and Vite. Opens a shared link, email code, then only the shared records. | `frontend/apps/doctor/` |
| Admin dashboard | React and Vite. Account status, processing retries, settings, audit. No access to medical records. | `frontend/apps/admin/` |
| Staging files | Dockerfiles, compose, nginx, backup and restore tools for one disposable node in us-east-1. Never deployed. | `infrastructure/staging/`, `docs/R7_STAGING_DEPLOYMENT_READINESS.md` |

## 3. How to run it and check it

Commands (from `backend/` unless noted). The test suites start their own throwaway PostgreSQL and delete it afterwards. They never touch the development database.

- Setup: `source ~/.local/share/hw-test/env.sh` (sets `PHASE3_PYTHON` and the pgvector path).
- Type check: `npm run typecheck`
- Identity: `npm run identity:phase1:test`. Then `phase2:guardian-documents:test`, `documents:closure:test`, `phase3:test` to `phase7:test`, `phase9:test` (admin), `r2:test` (deletion request), `r4:test` (security), `r5:test` (email), `r7:test` (staging readiness).
- **R9 end-to-end: `npm run r9:test`** (the V-23 chain) and **`npm run r9:trace:test`** (traceability checks).
- Python: from `ai-service/`, `"$PHASE3_PYTHON" -m unittest discover -s tests -t .` (also `tests_ocr`, and `tests_rag.test_rag`).
- Frontend, from `frontend/`: `npm run r8:test` (type check, client, mobile, quality, browser, real-backend contract).
- Rebuild the traceability matrix: `python3 infrastructure/r9/build_traceability.py` (from the repository root).

## 4. Test results (R9 full regression, 2026-11-06)

Run on one machine (4 cores, shared with desktop apps), synthetic data, disposable PostgreSQL 16 with pgvector. Counts come from each suite's own summary line.

| Suite | Pass | Fail | Note |
| --- | --- | --- | --- |
| Backend type check | clean | - | |
| Identity and security (phase 1) | 39 | 0 | |
| Guardians and documents (phase 2) | 33 | 0 | |
| Document closure (M03) | 24 | 0 | |
| Processing and timeline (phase 3) | 23 | 0 | |
| Summaries (phase 4) | 130 | 0 | re-run after the R9 summary fix |
| RAG (phase 5) | 10 | 0 | |
| Doctor sharing (phase 6, includes R3 and R6 checks) | 21 | 0 | |
| Guardian notifications (phase 7, includes R6 checks) | 24 | 0 | |
| Admin (phase 9) | 51 | 0 | |
| Account deletion request (R2) | 10 | 0 | |
| Security hardening (R4) | 12 | 0 | |
| Email delivery (R5) | 9 | 0 | |
| Staging readiness (R7) | 12 | 0 | about 9 minutes |
| **R9 end to end (V-23)** | 1 | 0 | passed 3 of 3 re-runs. The first full-regression run failed because of a flaw in my test (it sometimes read the wrong number as the email code); fixed and re-run |
| **R9 traceability checks** | 5 | 0 | |
| AI service: contracts, summaries, benchmark | 341 | 0 | needs `jsonschema`, which is missing from the test Python. 3 tests error without it; this run added it from a scratch folder through PYTHONPATH (the environment itself was not changed). Environment gap, not a code failure |
| AI service: RAG | 17 | 0 | |
| AI service: OCR | 9 | 0 | after the fix described in section 5a; before it, `test_busy_and_cancellation_release_admission` failed every time |
| Frontend client | 16 | 0 | |
| Frontend patient app (jest) | 20 | 0 | |
| Frontend R8 build and settings checks | 5 | 0 | |
| Frontend browser (doctor and admin, real Chrome) | 26 | 0 | **load-sensitive**: it passed 26/26 on quiet runs. When the machine load was 6 to 14 (4 cores, desktop apps plus other suites) tests timed out on page load; in the last full chain 7 failed that way, and it passed 26/26 when re-run at load 3.4 |
| Frontend real-backend contract | 9 | 0 | |

Total with every suite counted once at its latest result: **847 passed, 0 failed**. The 3 jsonschema errors are not counted as failures but as "not run in the normal environment".

Not run in R9: the backend suites that need a real development database or AWS (live S3 and OCR, canary checks), and anything on a phone, a screen reader or a deployed stack.

### Traceability audit result

Full tables are in `docs/R9_REQUIREMENTS_TRACEABILITY_MATRIX.md`. Roll-up status is the worst status among the PRD rows that cite each requirement.

- FR-001 to FR-055: 21 IMPLEMENTED, 24 PARTIAL, 1 NEEDS_REVERIFICATION, 4 MISSING, 5 BLOCKED.
- NFR-01 to NFR-08: 0 IMPLEMENTED, 5 PARTIAL, 1 NEEDS_REVERIFICATION, 2 BLOCKED.
- DEC-01 to DEC-22: 8 IMPLEMENTED, 7 PARTIAL, 1 NEEDS_REVERIFICATION, 1 MISSING, 5 BLOCKED.
- V-01 to V-34: 15 VERIFIED_LOCAL, 16 PARTIAL, 3 BLOCKED (V-17, V-20, V-33). None is accepted for release.
- Every requirement has direct PRD rows or an inheriting module, so nothing is silently skipped.

### 5a. OCR service leak found and fixed after the first R9 report

The failing OCR test was a real bug. When a client cancelled a request, cleanup code in the request handler was cancelled a second time and skipped `active -= 1`, so the service reported BUSY (503) forever. `ai-service/ocr_service/app.py` now frees the slot from a done-callback on the work task and shields the cleanup wait. The test was not changed. A probe that retried for 4 seconds got 503 every time before the fix and 200 at once after it.

## 5. Scenario V-23 (end to end)

`backend/src/r9/r9.test.ts`, test `R9-V23-01`. It uses the real HTTP routes, the real PDF text reader, real Tesseract OCR, PostgreSQL with row security, pgvector and the Python RAG service. Ten steps all passed:

1. Patient registers, cannot log in until the email is verified, verifies, logs in.
2. Guardian is invited and accepts.
3. Two files are uploaded (a digital PDF and a scanned PDF). The stored original matches byte for byte.
4. The processing worker reads the digital PDF text and runs OCR on the scanned PDF.
5. Summaries are generated and read.
6. A question about glucose gets a cited answer; every citation is the patient's own document.
7. A doctor opens a link, enters the emailed code and sees only the shared record (view and download return the same bytes). The other record is denied.
8. A patient token does not work on doctor routes and a doctor token does not work on patient routes.
9. The guardian digest is delivered once, with no ids or addresses in the text; the report link works. OCR text did not raise a serious alert.
10. The patient revokes the share (the doctor is blocked at once). The guardian is removed (the report link stops working).

**What was fake in this run:** email (captured in memory), file storage (a map in memory), the summary model (a fixed recipe), the question-answering model (synthetic offline), the serious-finding rule (the demo rule), the guardian enrolment (synthetic fixture) and the digest time window (moved with SQL instead of waiting 24 hours).

**What it did not cover:** a deployed system, the phone and web screens driving the flow, real providers, load, and real medical reports.

### A real defect this test found and fixed

Real OCR gives a confidence like 95.87. The summary code only accepted whole numbers when it fingerprinted the extraction details, so **every OCR document would have failed to get a summary** (error INVALID_INPUT). Older tests always used a confidence of 50, so they did not see it. Fix: `backend/src/summaries/jobs.ts` now fingerprints fractions as text. Whole numbers hash exactly as before. The E2E test covers it. The Phase 4 and Phase 6/7 suites were re-run (section 4).

## 6. What is not done, and exactly what unblocks it

| Item | Requirement rows | Why it is blocked | What is needed |
| --- | --- | --- | --- |
| Real AWS deployment, HTTPS, private S3, RDS | M16-001, M16-004, M15-005, M03-002/007, M16-003 | No AWS account or IAM role name; CFG-08 topology not approved | AWS account, IAM role name, approval of the CFG-08 plan; then deploy the staging files and re-run checks |
| Backups and recovery goals | M16-008, V-21 | CFG-09 schedule, retention, RPO and RTO not set | Owner decision on CFG-09; run the restore drill on the real database |
| Real email provider | M09-019, M10 delivery | CFG-04 security review and provider choice open | Approved provider, sandbox inbox, CFG-04 review |
| Real AI model | M07-011, M08-022, M18-006 | CFG-01 model and data-handling approval absent | Approved provider and model, data-handling agreement |
| Embedding and index choice | M08-010, M14-003, M18-007 | CFG-02 benchmark not done | Benchmark on representative synthetic data, approval |
| Serious-finding rules | M10-011, M18-003, V-17 | No clinically reviewed rule exists (only a demo rule) | Qualified clinical reviewer, rules with units and ranges (CFG-06) |
| Guardian consent and email content | M18-004 | CFG-11 privacy and legal review absent | Privacy or legal approval of wording and consent |
| Retention and deletion | M15-009, M18-005, V-28, V-29 | Durations and legal hold rules not decided (CFG-12, CFG-18) | Decided durations, legal approval; then build scheduled deletion and erasure |
| Account deletion in the patient app | M11-009 | App not wired to the R2 request API; policy text missing | Approved policy text, then wire the app |
| Exceptional admin support access | M13-020, M15-010, V-33 | CFG-17 not approved | CFG-17 decision on roles, scope, audit retention |
| Quality thresholds | M17-008, M18-008, M07-011, V-22 | CFG-10 numbers not given | Numeric targets for response time, accessibility, availability, usability, OCR and RAG quality |
| Phones, screen reader, usability sessions, load test | M11, M17-007, M17-008 | No devices or participants; no thresholds | Target devices, TalkBack/VoiceOver pass, test participants or an approved synthetic protocol |

## 7. Honest notes on the tracker

- **Four stale MISSING rows were re-graded on the owner's instruction.** M07-003, M07-009, M08-015 and M15-011 are now PARTIAL, citing the local synthetic tests P6-05, P6-06, P6-08, P6-11, R3-02, R3-03, R4-13, P8-API-04, P8-API-06 and R9-V23-01. They are not IMPLEMENTED because the real email provider, a real model and a deployed stack are still missing.

- **Totals were wrong before R9.** The tracker header and module table said PARTIAL 79 and MISSING 13. The rows themselves said PARTIAL 84 and MISSING 8 (before the two R9 changes below) (modules M08, M15 and M16 were not updated in earlier phases). R9 corrected the header and table to match the rows. `R9-TRACE-02` now fails if they ever differ again.
- **What I did change:** M17-005 MISSING to PARTIAL and M17-009 MISSING to PARTIAL, each with evidence in the tracker. M17-002 stays NEEDS_REVERIFICATION (its note now lists the failing OCR service test). M17-010 and M18-010 stay PARTIAL with new evidence.

## 8. Security, privacy and clinical statements

- Separate actors: patient, doctor and admin tokens have different audiences and never work on each other's routes (tests R4-04, R2-09, P9-06, R9 step 8).
- Every request re-checks the database. Revocation, suspension, deletion and role changes act at once.
- Admin power never opens medical records (P9-13, P9-21, P9-23). Exceptional access is not built.
- No driver errors, secrets or hashes appear in responses (R4-12). Rate limits are stored by hash.
- Only synthetic data was used. No real patient data is in the repository or the tests.
- **Clinical:** the product is **not clinically validated**. It does not diagnose or prescribe; the fixed notice is tested (R3-01). The serious-finding rule is a demo. Do not use it for real care.
- **Privacy:** no privacy or legal review has happened (CFG-11, CFG-12, CFG-18).

## 9. Deployment, rollback and restore

Staging readiness (files and local checks only) is in `docs/R7_STAGING_DEPLOYMENT_READINESS.md`: single disposable node, containers hardened, secrets from files, nginx with separate doctor and admin origins, backup and restore tools. The restore drill ran on a fresh local database and checked counts and checksums (R7-07, R7-08). Rollback for a deployment is: stop the new containers, keep the previous images, and restore the last backup with `infrastructure/staging/db-recovery.mjs`. This was rehearsed locally only, never on AWS.

## 10. Short user guide

- **Patient:** register, verify the email, sign in. Optionally invite one guardian. Upload PDF, JPG or PNG files. Wait for the status to show completed. Read the summary, ask questions about your records, and see the timeline. To share, pick records, create a link or QR, and tell the doctor. You can revoke at any time.
- **Doctor:** open the link or scan the QR, enter your name and email, type the code that arrives by email, then view only the records the patient chose. You can view or download the original, read the summary and ask questions. The session ends when the patient revokes or the time runs out.
- **Guardian:** accept the invitation email. After that you receive the daily digest and the report link. The patient can remove you at any time and the links stop working.
- **Admin:** sign in on the admin address. You can suspend or reactivate accounts, see processing status and retry failed jobs, change allowed settings and read the audit log. You cannot read medical records.

## 11. Sign-off (all empty)

| Role | Name | Date | Decision |
| --- | --- | --- | --- |
| Owner | | | NOT SIGNED |
| Security | | | NOT SIGNED |
| Privacy / legal | | | NOT SIGNED |
| Clinical | | | NOT SIGNED |
| Operations | | | NOT SIGNED |

## 12. Residual risks

1. OCR and summary quality on real, messy reports is unmeasured.
2. The AI parts run with synthetic providers; behaviour with a real model (injection, refusals, hallucination) is untested.
3. Nothing is tested on a deployed network (TLS, proxies, real S3 and RDS).
4. The browser tests time out now and then under CPU load (a different test each time); `P9-ADMIN-API-01` failed once in R8 and passed afterwards. The cause is not found.
5. Early-phase tests use hand-made database rows in places; the R9 chain reduces this but covers one patient path.

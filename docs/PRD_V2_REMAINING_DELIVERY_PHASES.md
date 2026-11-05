# PRD v2 remaining delivery phases

Date: 2026-11-05

This plan follows `AI_Health_Wallet_Revised_SRS_v4_0.docx` and `AI_Health_Wallet_Module_Wise_PRD_v2_0.docx`. It does not change requirements or approve any CFG item. Each phase stops for evidence review before the next phase starts.

## Phase R1 - Local defect closure

- Fix and qualify the failing real admin contract test `P9-ADMIN-API-01`.
- Re-run the requirements checker, backend typecheck/build, frontend typecheck, client tests and focused browser/contract tests.
- Do not claim release readiness from local tests.

## Phase R2 - Account deletion and retention contract

- Obtain approved CFG-12/CFG-18 decisions for deletion, retention, legal hold, backups and irreversible-deletion timing.
- Implement the patient deletion-request workflow, immediate session/access revocation, auditable state and downstream document/artifact handling.
- Add negative tests for old sessions, files, grants, RAG, summaries, guardian delivery and admin views.

Required owner input: retention period, legal-hold behavior, backup deletion behavior, deletion states, approval owner and evidence reference.

## Phase R3 - Cross-service integration closure

- Complete M14 API/service ownership contracts.
- Reconcile Node/Express orchestration with Python OCR/AI boundaries.
- Resolve the current admin contract failure and complete service failure/retry classifications.
- Produce one reproducible integrated local stack using synthetic data.

## Phase R4 - Security and privacy hardening

- Complete M15 cross-actor, grant, OTP, RAG, admin, deletion and log-redaction coverage.
- Define and test HTTPS, secrets, audit retention and abuse controls.
- Keep exceptional admin medical-content access disabled unless separately approved.

Required owner input: CFG-16 security/session values, CFG-17 admin policy, audit retention, security reviewer and privacy reviewer.

## Phase R5 - Real email provider qualification

- Select and approve the security-email, doctor-OTP and guardian-notification provider.
- Configure a synthetic-recipient test environment without committing secrets.
- Test delivery, bounce/failure, retry, idempotency, expiry and provider outage behavior.

Required owner input: provider, region/data handling, test-domain authorization, sender identity and security/privacy approval.

## Phase R6 - Clinical and AI configuration

- Approve CFG-01 hosted/local model boundary and data handling.
- Approve CFG-02 embedding model, dimensions, vector strategy and benchmark thresholds.
- Approve CFG-06/CFG-07 serious rules, units, population context and indeterminate wording.
- Run the approved AI/OCR/RAG evaluation set.

Required owner input: qualified clinical reviewer, rules/gold data, model/provider decision and CFG-10 quality thresholds.

## Phase R7 - AWS deployment and operations

- Approve CFG-08 topology, region, IAM, network and managed secrets.
- Deploy API, workers, RDS, private S3, Python services and clients in a disposable AWS environment.
- Verify HTTPS, private objects, monitoring, alerts, backups, restore, rollback and ownership.

Required owner input: AWS account/role, region, budget approval, topology approval, deployment window and operations owner. Secrets must be entered directly into the owner-controlled environment, never sent through chat.

## Phase R8 - Client/device and quality acceptance

- Test installed Android/iOS workflows, secure storage, file picker, original sharing and screenshot privacy.
- Run doctor/admin browser acceptance against the deployed stack.
- Complete accessibility, usability, load and availability tests against approved CFG-10 thresholds.

Required owner input: target devices, accessibility threshold, performance targets, test participants or approved synthetic usability protocol.

## Phase R9 - Full E2E and handover

- Run patient registration -> upload -> OCR -> summary/RAG -> doctor QR/link/OTP -> doctor review -> guardian delivery.
- Reconcile all 232 PRD rows and all SRS registers.
- Produce deployment, rollback, restore, security, privacy, clinical and user documentation.
- Obtain final owner/security/privacy/clinical/operations acceptance.

## Release rule

A phase is complete only when its focused tests pass and its external approvals/evidence are recorded. No phase may mark a requirement complete merely because code or an isolated test exists. Any unavailable AWS, email, clinical, privacy or security input remains explicitly BLOCKED.

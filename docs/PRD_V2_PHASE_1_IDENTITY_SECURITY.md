# PRD v2 Phase 1 identity security

28 October 2026 · Asia/Karachi · **Backend identity/security review package delivered. Final focused qualification: 24/24 pass. Whole M01 acceptance remains OPEN.** Only M01 and the identity-specific M14/M15/M18 support authorized in the request were implemented. No later module, UI, RAG, guardian lifecycle/delivery, Admin dashboard, AWS deployment or real mail/model call started.

## A. Requirements implemented

Registration retains canonical unique email, Argon2id, validation and secret-free projections; all newly registered and legacy accounts begin unverified. Verification/resend/recovery use random256-bit purpose-bound challenges with hashed-only database storage, expiry, one-use consumption, cooldown and persistent limits. Verified active users can login with bounded JWT access plus server-controlled rotating refresh sessions. Logout revokes the current session; refresh replay revokes its session family. Reset/change atomically replace credentials, consume outstanding challenges, invalidate prior sessions and persist minimized events. Current account/session checks protect existing profile/document/processing/summary routes; original bytes are checked again after acquisition.

Profile adds optional sex_gender and pending_guardian_email; the latter is inert future input, never a guardian invitation/acceptance/active relationship. No clinical rule requires a value yet; no medical inference is made from this field. Account states active/unverified/suspended/deletion_pending/deletion_restricted/deleted/revoked have enforced access behavior. Deletion states implement access restriction only, not privacy deletion.

## B. Files changed

- `backend/migrations/0005_patient_identity_security.sql`.
- `backend/package.json`.
- `backend/src/app.ts`.
- `backend/src/auth/identity-security.test.ts`.
- `backend/src/auth/middleware.ts`.
- `backend/src/auth/routes.ts`.
- `backend/src/auth/security-policy.ts`.
- `backend/src/auth/security-repository.ts`.
- `backend/src/auth/tokens.ts`.
- `backend/src/documents/file-access.ts`.
- `backend/src/documents/routes.ts`.
- `backend/src/patients/repository.ts`.
- `backend/src/patients/validation.ts`.
- `backend/src/processing/api.ts`.
- `backend/src/summaries/routes.ts`.
- `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md`.
- `infrastructure/identity/run.mjs`.
- `docs/PRD_V2_PHASE_1_IDENTITY_SECURITY.md` (this report) and `docs/baselines/PRD_V2_PHASE_1_IDENTITY_SECURITY_RECEIPT.json` (new aggregate evidence).

The new identity test launcher creates only its owned private /tmp cluster, runs focused checks, stops it and retains receipts. No dependencies were installed. Old receipts and reconciliation report are unchanged. Existing package commands are retained; `identity:phase1:test` is added.

## C. Migration added

`backend/migrations/0005_patient_identity_security.sql` is additive. It adds patient verification/account/security-version/profile metadata, patient_auth_sessions, patient_refresh_history, patient_auth_challenges, patient_security_events, patient_auth_rate_limits and supporting owner/challenge indexes. A patient-row trigger advances security_version on credential/email/status changes, so suspension then reactivation cannot resurrect earlier sessions. Active accounts require a verified email. Runtime events/history are append-only by grants; no UPDATE/DELETE permission is given on these tables.

Migrations 0001–0004 and historical receipts were compared with HEAD and are unchanged. All five migrations were applied only inside fresh disposable PostgreSQL for these tests. Migration 0005 was not applied to the development database or a deployment. Existing accounts intentionally require verification and existing sid-less access tokens intentionally fail; there is no grandfathered bypass. Rollout therefore needs mail-provider wiring and coordinated migration/application activation. Do not roll back to stateless authorization as a convenience.

## D. Security decisions

- Access JWTs carry patient subject plus session UUID and preserve algorithm/issuer/audience/time bounds. Every sensitive request checks current database account state, verification, security version, session revocation and absolute/idle expiry. A valid signature alone is insufficient.
- Refresh tokens are session UUID plus random256-bit secret. Only purpose-separated SHA-256 hashes persist. Each successful refresh consumes its current hash, retains the spent hash and rotates the secret. A recognized spent token commits family revocation; a random wrong secret cannot revoke another valid session. Replay revocation commits before returning denial.
- All security mutations lock patient before challenge/session, with bounded lock/statement timeouts. Login/password-change compare the previously verified credential hash again under the patient lock. Reset/rotation/logout/status changes serialize; audit failure rolls back credential/challenge/session changes.
- Status/email/password changes advance a security version. Reverting suspended/deletion restrictions does not restore previous sessions. Email changes also clear verification and set unverified. No Admin/state-management endpoint is added.
- Challenges are purpose-bound, expiring, consumed atomically once and superseded on resend. Recovery is issued only for verified active users and never reactivates suspended/restricted/deleted accounts. Unknown/ineligible/cooldown cases have the same202 body; real transport timing/reliability remains a live integration qualification item.
- The existing in-process auth limiter is retained; database HMAC(IP/subject) buckets add multi-instance enforcement without storing raw email/IP in those buckets. No passwords, raw challenges, refresh secrets or medical content enter security events/logs. Events contain only patient/session IDs, event code and time.
- Mail is injected through SecurityMailer. Without a transport, registration/resend/recovery fail503 uniformly before lookup/creation. Synthetic transport was used for qualification. Delivery failure records delivery_failed without exposing provider details; users can resend after cooldown. No plaintext token is queued/stored. This is not a durable email outbox or production delivery qualification.
- Refresh credentials are returned once in JSON for a future native-client contract; no insecure client persistence or cookie assumptions are implemented. Clients must later use platform-secure token storage and stop access on denial. Already delivered bytes cannot be recalled; revocation is checked on subsequent requests and again before original streaming.

## E. CFG-16 implementation policy

| Policy | Selected default | Configurable bound |
| --- | --- | --- |
| Access JWT |900 seconds | existing JWT_EXPIRES_IN_SECONDS:60–3600 |
| Refresh absolute |30 days | AUTH_REFRESH_ABSOLUTE_SECONDS:300–2592000 seconds |
| Refresh idle |7 days | AUTH_REFRESH_IDLE_SECONDS:60–604800 seconds, no greater than absolute |
| Verification challenge |24 hours | AUTH_VERIFICATION_SECONDS:60–86400 seconds |
| Reset challenge |15 minutes | AUTH_RESET_SECONDS:60–1800 seconds |
| Resend cooldown |60 seconds | AUTH_RESEND_COOLDOWN_SECONDS:1–3600 |
| Persistent rate window |15 minutes | AUTH_SECURITY_RATE_WINDOW_SECONDS:60–3600 |
| Verification/resend/recovery limit |5 per window/IP or normalized subject | AUTH_CHALLENGE_RATE_MAX:1–20 |
| Login/general auth limit |20 per15 minutes | existing AUTH_RATE_LIMIT_MAX/window config; persistent admission also enforced |

Rotation renews idle expiry up to the original absolute expiry; it never extends the absolute bound. Responses report actual remaining effective refresh lifetime. Logout revokes the active session only. Reset/change revoke all prior sessions and outstanding challenges. No session is automatically issued after reset/change; login is required. Verification activates only unverified accounts. Required state transitions and single-use/replay checks use database time.

The owner approved the bounded revocable rotating-session direction. Concrete limits above are selected implementation defaults, not invented evidence of an independent security release approval. CFG-16 selection/behavior now exists with focused evidence; release review, real mail integration and client/deployed acceptance remain open. Other CFG values and clinical/privacy/legal/AI/AWS gates are not resolved by this phase.

## F. Tests run

`node infrastructure/identity/run.mjs --execute-isolated` (equivalent package command: `cd backend && npm run identity:phase1:test`). The launcher initializes a fresh0700 /tmp PostgreSQL16 Unix-socket-only cluster with TCP disabled, creates isolated roles/database, applies all five migrations, runs actual Express/Argon2/JWT/SQL tests with fake security mail/private bytes and then stops its cluster. It never loads development credentials or uses the development database. No existing PostgreSQL/container/service was repurposed.

`npm run typecheck`, `npm run build`, and `git diff --check` passed. These are compile/format checks, not broad test execution. No broad regression suite ran.

## G. Test results

Final focused run: **24 passed, 0 failed, 0 skipped, 0 cancelled**. Initial17-test run passed; an expanded run passed21/22 and exposed independently evaluated clock timestamps in an expiry fixture. Production creation now uses a common statement timestamp for equal idle/absolute bounds; final suite adds that edge case and transactional audit-write rollback. Intermediate failures are retained, not rewritten as passes.

| Test | Focused case |
| --- | --- |
| T01 | registration is unverified, profile fields are scoped and no guardian relationship is activated |
| T02 | email verification is hashed, purpose-bound, single-use and rejects expiry/unknown tokens |
| T03 | resend is generic, cooldown bounded, invalidates old challenge and enforces persisted rates |
| T04 | unverified/unknown/verified recovery has the same response; only verified active email receives reset |
| T05 | login preserves generic errors, emits bounded access/session tokens and denies expired/malformed/legacy JWTs |
| T06 | refresh rotates once, has a fixed absolute bound and replay commits family revocation |
| T07 | random invalid refresh secret cannot revoke a valid session |
| T08 | simultaneous refresh has one rotation and reuse permanently denies resulting credentials |
| T09 | logout revokes the current session immediately without revoking another login |
| T10 | absolute and idle expired sessions deny protected requests and refresh |
| T11 | reset token is expiring/one-use, changes credential and invalidates every prior session |
| T12 | reset racing refresh never permits pre-reset credentials to regain access |
| T13 | authenticated password change rejects wrong/weak inputs and invalidates all prior sessions |
| T14 | suspended/deleted/restricted/revoked accounts deny login/access/refresh; reactivation does not resurrect sessions |
| T15 | cross-patient profile/document isolation and current authorization cover file, processing and summary paths |
| T16 | revocation during original acquisition denies bytes before streaming |
| T17 | tokens never persist plaintext; audit is minimized and append-only for runtime role |
| T18 | resend/recovery endpoints apply persistent limits and generic errors |
| T19 | login endpoint bounds repeated attempts including unknown identities |
| T20 | missing email transport fails closed uniformly without creating an account |
| T21 | simultaneous verification consumes a challenge once and database rate admission is atomic |
| T22 | refresh response reflects remaining absolute expiry rather than extending it |
| T23 | reset rolls back credential, challenge and sessions when required audit persistence fails |
| T24 | equal idle and absolute lifetime configuration creates a valid bounded session |

Durable aggregate receipt: `docs/baselines/PRD_V2_PHASE_1_IDENTITY_SECURITY_RECEIPT.json`. Private raw TAP copies: `.private-evidence/prd-v2-phase1-20261028/{initial17,intermediate21of22,final24}.tap` (directory0700/files0600). Final original evidence `/tmp/hw-phase1-pg-OPuM4f/focused.tap`; its cluster is stopped. The initial Unix-socket sandbox EPERM setup attempts are not counted as test failures/passes. A separate scratch cluster used to diagnose setup is also stopped.

## H. Remaining PARTIAL MISSING and BLOCKED items

**M01 remains PARTIAL at module/integrated acceptance scope.** M01-004 and M01-006 retain PARTIAL status because a real security-email provider/adapter is not configured or delivered/qualified; the backend interfaces and acceptance semantics pass with injected transport. Other M01 rows are qualified only at focused backend scope. No AT/V/NFR external/client/deployment scope is upgraded.

Missing outside this phase: guardian lifecycle/delivery, doctor OTP/grants/revocation, RAG/real model/indexing, complete processing/Python reconciliation, deletion privacy workflow, Admin and clients, AWS/recovery/full qualification. Release gates CFG-01/02/06–12/17/18 and applicable operational/provider/threshold reviews remain as reconciled; CFG-16 final security release approval is not inferred. Historical stateless-auth and sid-less file/API fixtures require session-aware requalification before future use; they were not run or counted as current passing evidence.

Security-mail provider persistence/retry/availability/timing and mailbox delivery need an approved real adapter. Default HTTP server intentionally has no live adapter, so registration/resend/recovery return503 until one is supplied through createApp({identity:{mailer}}). An actual provider integration is a remaining delivery dependency, not a claim that production signup works.

## I. Exact PRD and SRS evidence mapping

| PRD row | SRS source | Focused evidence | Status |
| --- | --- | --- | --- |
| M01-001 | FR-001 | T01 | IMPLEMENTED |
| M01-002 | FR-002 | T01, T05, T14 | IMPLEMENTED |
| M01-003 | FR-003 | T01, T15 | IMPLEMENTED |
| M01-004 | FR-037 | T01, T02, T03, T21 | PARTIAL |
| M01-005 | FR-038 | T05, T06, T08, T09, T10, T11, T12, T13, T14, T15, T16, T22, T24 | IMPLEMENTED |
| M01-006 | FR-039 | T04, T11, T12, T18, T23 | PARTIAL |
| M01-007 | FR-037 | T01, T04 | IMPLEMENTED |
| M01-008 | FR-001; NFR-01 | T01, T15 | IMPLEMENTED |
| M01-009 | FR-002; FR-038; FR-048 | T05, T06, T10, T14, T15, T16 | IMPLEMENTED |
| M01-010 | FR-038; CFG-16 | T09, T15, T16 | IMPLEMENTED |
| M01-011 | FR-038; CFG-16 | T06, T07, T08, T10, T12, T22, T24 | IMPLEMENTED |
| M01-012 | FR-039; DEC-17; CFG-16 | T02, T04, T11, T12, T18, T23 | IMPLEMENTED |
| M01-013 | NFR-01; DEC-17 | T17, T23 | IMPLEMENTED |
| M01-014 | FR-003; NFR-01 | T01, T15 | IMPLEMENTED |

M14-005–008: current patient/session/owner contract, source-preserving protected routes and transactional identity states, T09/T11/T14–17/T21/T23; whole cross-domain requirements remain PARTIAL. M15-003/004/006/007/008/012: restricted/deleted access denial, secret minimization, persistent auth limits and synthetic security tests, with full deletion/doctor/Admin/privacy scope still open. M18-001/002: all 232 IDs preserved and CFG-16 defaults/owner direction/evidence recorded; other configuration approvals remain unresolved. FR-001–003/037–039, NFR-01/02, DEC-09/17 and CFG-16 are the primary mappings; FR-048 is referenced only for denial of suspended accounts, not Admin implementation. AT-01/V-01/V-25 have focused backend evidence only, not full mobile/live acceptance.

Tracker totals after Phase1: IMPLEMENTED=34, PARTIAL=64, MISSING=107, BLOCKED=19, NEEDS_REVERIFICATION=8. M01 has 12 IMPLEMENTED backend rows and 2 PARTIAL rows; no module complete flag is set. All232 requirements remain in the tracker. No later-module or external acceptance status is upgraded.

## J. Residual risks and next review

- Real security email is unconfigured; test adapters prove backend semantics rather than actual delivery, provider timing/availability or production email privacy. A transport can deliver a superseded challenge after a concurrent resend, but the backend correctly rejects it; user recovery is resend after cooldown.
- Retention/cleanup schedules for expired sessions/challenges/spent hashes/rate buckets/security events require controlled privacy/operations decisions. Replay hashes must remain available for each live family. No unapproved irreversible purge is added.
- Current session state is checked at request admission; requests admitted before revocation may finish. Original delivery adds a second check before bytes. Complete downstream cancellation/deletion/sharing behavior belongs to later approved work.
- No production database migration, client secure-storage integration, multi-host deployment/load, real-mail failure/latency, AWS or final security release review is claimed. Old blanket regression counts are historical.
- The test harness uses private trust authentication only in its disposable0700 Unix-socket cluster; it is not production auth configuration.

**Recommended next phase after owner review:** configure/qualify the security-email adapter and close the remaining M01/CFG-16 delivery/review gates first; then authorize the roadmap M02 guardian/profile relationship plus M03 upload/storage phase, reusing current work. Neither follow-up has started. No commit or push was made.

## Phase 1B follow-up qualification 28 October 2026

The initial Phase 1 results above remain historical. [Phase 1B](PRD_V2_PHASE_1B_SECURITY_EMAIL_QUALIFICATION.md) now qualifies all 14 M01 backend requirements with 40/40 focused tests. Verification/reset messages are atomically queued as authenticated ciphertext, delivered through a configurable provider boundary, and qualified with a shipped loopback synthetic HTTP mailbox. Delivery state/attempts/timestamps/fixed failure categories and hashed provider references contain no token or email content. Bounded retry, expiry, supersession, concurrency and code single-use behavior pass.

Migration 0005 is unchanged. After a verified private backup/checkpoint, the intended local development PostgreSQL applied prerequisite 0004, identity 0005 and additive email 0006. All 15 original tables' pre-existing data/columns are preserved. The migrated schema and original backup restore were qualified in isolated databases, without creating auth or email test rows in the real development database. The original Phase 1 receipt is not rewritten.

M01 backend implementation is complete at this qualified scope. Production email-provider approval, credentials/key management, actual inbox/security/client/deployment qualification and other release gates remain OPEN. The default remains disabled until explicitly configured; there is no automatic live sender or production deployment. M02/M03 may be proposed for owner-approved synthetic development next, but neither has started in Phase 1B.

# PRD v2 Phase 1B security email qualification

28 October 2026 · Asia/Karachi · **M01 backend qualification PASS: 14/14 backend requirements implemented; 40/40 focused checks passed. Production/release/deployment/client acceptance remains OPEN.** Phase 1B alone was executed. No M02 guardian lifecycle, M03 feature work, frontend, Admin, RAG or production deployment started.

## A. Email architecture

Identity APIs retain the Phase 1 Argon2/JWT/session/recovery design. Challenge issuance now atomically enqueues security mail in the same database transaction. The queue stores operational metadata separately from an AES-256-GCM encrypted payload. A bounded worker claims due work, commits its lease, calls the provider outside the database transaction, then commits a fenced result. Provider latency does not delay recovery/resend HTTP responses. Unknown/ineligible/cooldown and queue-failure recovery cases use the same generic202 response; infrastructure admission/rate limits remain enforced.

Raw verification/reset tokens remain in transient memory during generation/rendering/dispatch; only purpose-bound hashes persist in the challenge table and authenticated ciphertext persists in a separate queue payload table. No plaintext mail body/token is written to delivery logs. Payloads are removed after success or terminal failure/expiry/supersession.

## B. Provider abstraction

`SecurityMailer` remains the identity boundary. It now supports transactional enqueue while preserving the original injected deterministic adapter used by Phase 1 tests. `SecurityEmailProvider.send(message, signal)` receives only an idempotency key, sender, recipient, purpose-specific subject and plain-text code email; it returns an optional provider reference. Business logic contains no vendor SDK/name/credentials.

The supplied HTTP adapter posts this contract to a local sandbox or an explicitly approved HTTPS relay, with redirects disabled, bounded request deadline and bounded response parsing. The relay accepts `Idempotency-Key` and returns JSON `{message_id:opaque-reference}`. An actual vendor connector may implement this interface or sit behind that relay. Production vendor/relay selection and approval are unresolved. An environment approval flag is an operator assertion after owner review, not evidence that this phase approved a provider.

The shipped development mailbox binds literal127.0.0.1:8026, accepts only synthetic `@example.invalid` recipients, holds messages in memory, deduplicates idempotency keys, caps its retained set and performs no outbound email. `/messages` is a no-store local review endpoint, not a log or production UI. It is intended only for synthetic local qualification.

## C. Configuration

| Setting | Policy |
| --- | --- |
| AUTH_SECURITY_EMAIL_MODE | disabled by default; sandbox or https-relay explicitly selected |
| AUTH_SECURITY_EMAIL_ENDPOINT | sandbox: literal loopback HTTP only; production boundary: HTTPS, no embedded credentials/query/fragment |
| AUTH_SECURITY_EMAIL_FROM | validated configured sender; synthetic example in .env.example |
| AUTH_SECURITY_EMAIL_ENCRYPTION_KEY | independent random32-byte hexadecimal secret; never supplied in source/evidence/logs |
| AUTH_SECURITY_EMAIL_TIMEOUT_MS | default 2000;100–5000 |
| AUTH_SECURITY_EMAIL_RETRY_SECONDS | default 30;1–300, multiplied by attempt count |
| AUTH_SECURITY_EMAIL_MAX_ATTEMPTS | default 3;1–3 |
| AUTH_SECURITY_EMAIL_PROVIDER_APPROVED | defaultfalse; explicit owner/operations approval required before production relay use |
| AUTH_SECURITY_EMAIL_AUTHORIZATION | secret relay authorization, required for https-relay; never logged |

Configuration examples are in `backend/.env.example`; existing runtime .env files and production credentials were not changed. Invalid enabled configurations fail closed without echoing values. Existing verification/reset/resend and CFG-16 session lifetimes remain unchanged. Concrete retry values are qualified development defaults; production provider/operations review remains external.

Local synthetic operation after explicit secret/configuration setup:

```sh
cd backend
npm run identity:email:sandbox
# In a separately configured terminal, run the API normally.
# In a separately configured terminal, drain a bounded security-email batch:
npm run identity:email:drain
```

The worker is intentionally explicit and bounded (10 rows by default). No scheduler, daemon installation, production credentials or background activation is introduced. Repeated bounded invocations after next_attempt_at process approved retries. Without configuration the email-dependent APIs fail503 uniformly. Do not invoke a worker using a different encryption key while queued messages remain; wrong keys fail closed and require a fresh challenge/resend.

## D. Security guarantees

- Challenge hashes remain purpose-bound, expiring and atomically single-use. Migration 0006 adds account security-version binding; email/status/credential changes invalidate outstanding challenges as well as sessions. Legacy challenges with version0 fail closed and require resend.
- Emails contain only the purpose-specific code, expiry and fixed safety wording. No password hashes, refresh tokens, medical records or generated medical content enter the message builder.
- Metadata contains delivery/challenge/patient IDs, purpose, state, attempts, timestamps, claim fencing, fixed failure category and hashed provider reference. It does not contain raw email addresses, bodies, tokens or provider error bodies. Encryption uses a fresh12-byte nonce,16-byte authentication tag and delivery-ID additional authenticated data.
- Challenge and queue creation commit or roll back together. Queue insertion failure cannot leave a newly issued recovery authorization or enumerate an eligible account.
- Transient failures, permanent failures and timeouts never activate an account, verify an email, reset a password or revive a session. Verification authority stays exclusively in the existing challenge consumer.
- Sender/queue work is independent of generic recovery HTTP responses. Existing persistent IP/subject HMAC buckets, cooldown and auth admission limits remain effective.
- The adapter contains no console calls; worker output is aggregate counts/fixed errors only; sandbox startup output has no recipient/message/code. Provider error bodies are ignored and provider references are hashed. Private TAP output was scanned for raw challenge patterns.
- Production TLS/provider authorization, mailbox privacy, client token storage and independently reviewed release controls remain separate gates. No production readiness claim is inferred from local sandbox tests.

## E. Delivery and failure behavior

| Condition | Behavior |
| --- | --- |
| Enqueue | pending; one delivery per challenge; encrypted payload separate from metadata |
| Provider accepts | delivered at relay/sandbox boundary; hashed message reference; ciphertext deleted |
| HTTP408/429/5xx, transport error or timeout | transient_failed; bounded delayed retry; same idempotency key |
| Permanent rejection/invalid receipt | permanent_failed; no retry; ciphertext deleted |
| Retry budget exhausted | permanent_failed after at most3 claimed attempts |
| Expired challenge | expired, no send, payload deleted; code consumer still denies |
| Consumed/replaced/account-version-changed challenge | superseded, no new send, payload deleted |
| Duplicate enqueue or concurrent drains | unique challenge row plus SKIP LOCKED/fenced claim avoids simultaneous dispatch |
| Worker crash/expired lease | another worker may retry within budget with the same idempotency key |
| Wrong encryption key/tampered or mismatched payload | permanent_failed/invalid_payload; no outbound payload |
| Queue insertion failure | issuance transaction rolls back; generic recovery/resend response preserved; safe delivery_failed event |

“delivered” means successful acceptance by the configured relay or local mailbox, not proof that a remote recipient read/received the message. The production relay must honor idempotency across ambiguous acknowledgments and retries. A crash after provider acceptance can require a retry; at-least-once submission plus relay deduplication is the contract, not an unsupported universal exactly-once guarantee. An already submitted email cannot be recalled; any later-expired/revoked/replaced code remains unusable at the backend.

## F. Migration 0005 qualification

Intended local target verified: PostgreSQL16.15, `ai_health_wallet` on127.0.0.1:5433, restricted migration role. The database initially had migrations 0001–0003. Before applying anything, a private custom-format pg_dump backup was created, archive readability checked, and original table contents/columns/history recorded. No credentials or medical rows were printed.

The normal migration runner applied existing prerequisite 0004, unchanged identity0005 and additive security-email0006. Migration 0006 adds account-version binding on challenges, safe delivery metadata and encrypted payload tables. Historical SQL0001–0005 was not rewritten. Existing rows/columns across all 15 original tables matched their pre-migration hashes/counts after schema growth; newly added columns were excluded only from that preservation comparison. Original migration-ledger rows also matched.

The actual migrated schema was exported and restored into a fresh Unix-socket-only disposable database for auth/email tests. The original pre-migration full backup was separately restored into another fresh disposable database; all 15 original table hashes/counts matched under UTC. A final read-only development check verified migration versions0001–0006, original-data preservation and runtime privileges (security events are not update/delete-able; ciphertext is not update-able). No auth or delivery test rows were created in the real development database.

Private checkpoint: `.private-evidence/prd-v2-phase1b-development-6JElZz/` contains `before.dump`, `checkpoint.json`, `original-columns.json`, `qualification.json`, `development-schema.dump` and `final-verification.json`. Directory0700; backup/metadata/schema archive0600. The backup stays private because it contains existing development data.

Rollback/disposable reset: additive migrations are forward-only. Original backup restoration into a fresh isolated target has been demonstrated; any local rollback would use that verified backup into a separate target and then review the switch, rather than destructive hand-written down SQL or a blind restore over current data. All qualification clusters were stopped. The intended development database remains running with the qualified additive schema. No production database was contacted. Existing accounts are unverified until verification, and legacy pre 0006 challenges require resend; there is no grandfathered security bypass.

## G. Tests run

Focused commands:

```sh
node infrastructure/identity/run.mjs --execute-isolated
node infrastructure/identity/run.mjs --execute-isolated --development-schema <private-checkpoint>/development-schema.dump
npm --prefix backend run typecheck
npm --prefix backend run build
git diff --check
```

Local database checkpoint/application and final read-only preservation/permission checks were separately authorized by this phase. Test-created accounts/messages exist only in disposable databases and memory. No real email, model call, external provider or unrelated broad suite ran.

## H. Results

**Final: 40 passed, 0 failed, 0 skipped, 0 cancelled.** Typecheck/build/diff checks passed. The first37-case run passed on fresh migrations. The first development-schema restore attempt failed in setup because the harness removed the default public schema; no functional cases ran. After correcting setup,39 cases passed and the backup hash case exposed timestamp rendering in Asia/Karachi versus source UTC. A targeted aggregate-only probe confirmed all 15 hashes match in UTC; the normalized final40-case run passed. Failed/intermediate evidence is retained.

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
| T25 | 1B verification dispatch crosses HTTP sandbox with purpose-specific code; API does not wait for provider |
| T26 | 1B reset dispatch uses verified email, generic recovery response and a different purpose |
| T27 | 1B transient relay failure records safe metadata and retries with one stable idempotency key |
| T28 | 1B permanent failure is terminal without retry or account activation |
| T29 | 1B transient retries exhaust at three and cannot become an unbounded duplicate-send loop |
| T30 | 1B expired queued challenge is not sent and expired code never verifies |
| T31 | 1B resend supersedes old queued mail and invalidates old code without duplicate sends |
| T32 | 1B concurrent enqueue/drain and repeated sends dispatch the same challenge once |
| T33 | 1B metadata omits secrets/email bodies; ciphertext is authenticated and removed after success |
| T34 | 1B wrong encryption key fails closed without logging raw provider/token details |
| T35 | 1B timeout is bounded and retries remain observable |
| T36 | 1B disabled/sandbox/production configuration fails closed without leaking config values |
| T37 | 1B account/email security version changes supersede outstanding queued verification and reset |
| T38 | 1B enqueue failure rolls back issuance and cannot enumerate recovery accounts |
| T39 | 1B shipped local sandbox provides memory-only review and idempotent actual HTTP delivery |
| T40 | 1B original development checkpoint restores into an isolated database with all original rows intact |

New aggregate receipt: `docs/baselines/PRD_V2_PHASE_1B_SECURITY_EMAIL_QUALIFICATION_RECEIPT.json`. Private raw TAP: `.private-evidence/prd-v2-phase1b-20261028/{initial37,restore_setup,restore_timezone,final40}.tap`. Final original run: `/tmp/hw-phase1-pg-kQh9tS/focused.tap`. Raw logs contain no printed code/email payload; no earlier receipt was edited.

## I. M01 requirement status after review

| PRD requirement | Mapped SRS | Focused tests | Status / limit |
| --- | --- | --- | --- |
| M01-001 | FR-001 | T01 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-002 | FR-002 | T01, T05, T14 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-003 | FR-003 | T01, T15 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-004 | FR-037 | T01, T02, T03, T21, T25, T30, T31, T36, T37, T38, T39 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-005 | FR-038 | T05, T06, T08, T09, T10, T11, T12, T13, T14, T15, T16, T22, T24 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-006 | FR-039 | T04, T11, T12, T18, T23, T26, T27, T28, T29, T30, T33, T35, T36, T37, T38, T40 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-007 | FR-037 | T01, T04, T26, T37, T38 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-008 | FR-001; NFR-01 | T01, T15 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-009 | FR-002; FR-038; FR-048 | T05, T06, T10, T14, T15, T16, T37 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-010 | FR-038; CFG-16 | T09, T15, T16 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-011 | FR-038; CFG-16 | T06, T07, T08, T10, T12, T22, T24 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-012 | FR-039; DEC-17; CFG-16 | T02, T04, T11, T12, T18, T23, T26, T30, T37, T38 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-013 | NFR-01; DEC-17 | T17, T23, T27, T28, T29, T33, T34, T38 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |
| M01-014 | FR-003; NFR-01 | T01, T15 | IMPLEMENTED at qualified backend scope; release/client gates OPEN |

**M01 backend implementation and development delivery qualification: COMPLETE.** All14 applicable backend requirements now have implementation plus source-bound focused evidence. The tracker upgrades only M01-004 and M01-006 from PARTIAL to IMPLEMENTED and updates M01 evidence to Phase1B. The remaining M01 rows are requalified without widening their scope. All232 PRD requirements remain represented; no other module status or external acceptance scenario is upgraded.

Tracker totals: IMPLEMENTED=36, PARTIAL=62, MISSING=107, BLOCKED=19, NEEDS_REVERIFICATION=8. The Phase1 report is appended with this follow-up; its original historical narrative and aggregate receipt are preserved. AT-01/V-01/V-25 have current backend evidence; actual client/production acceptance is not declared. CFG-16 policy implementation is qualified, but independent security/release approval is not invented.

## J. External and release blockers

- Owner-approved production provider/relay selection, authorization credential provisioning, sender/domain verification and real mailbox delivery/privacy/timing/availability evidence remain unresolved. The HTTPS boundary is configurable; no provider approval flag was enabled by this phase.
- Production encryption-key management, key rotation with pending ciphertext, dispatcher scheduling/monitoring/retention and relay idempotency durability require operations/security review. No periodic worker was installed.
- Actual production migration/deployment, client secure-storage/workflow integration and broader security/load/E2E acceptance remain outside Phase1B. Existing clinical/privacy/legal/AI/AWS release gates remain unchanged.
- The local memory mailbox is synthetic-only and loopback-bound, without persistence or production authentication. Its message-review endpoint is for local test operators; never use it for real-patient release.
- Local database and restore qualification do not establish cloud recovery objectives/RDS qualification or close later modules.

## K. Recommendation whether M02 and M03 may begin

**YES for owner-approved synthetic development after review.** The backend identity/security and development-email foundations are qualified, so the next roadmap phase may reuse them for M02 guardian/profile lifecycle and existing M03 upload/storage reconciliation. Production-provider approval remains a release/deployment gate rather than a blocker to safe synthetic implementation. No M02/M03 implementation, frontend/Admin/RAG work or production deployment was started. Stop for owner review; do not automatically continue.

## Files changed in Phase 1B

- Updated `backend/.env.example`.
- Updated `backend/package.json`.
- Updated `backend/src/app.ts`.
- Updated `backend/src/auth/routes.ts`.
- Updated `backend/src/auth/security-repository.ts`.
- Updated `backend/src/auth/identity-security.test.ts`.
- Updated `infrastructure/identity/run.mjs`.
- Updated `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md`.
- Updated `docs/PRD_V2_PHASE_1_IDENTITY_SECURITY.md`.
- Added `backend/migrations/0006_security_email_delivery.sql`.
- Added `backend/src/auth/security-email.ts`.
- Added `backend/src/auth/security-email-entry.ts`.
- Added `backend/src/auth/security-email-sandbox.ts`.
- Added `infrastructure/identity/qualify-development.mjs`.
- Added `infrastructure/identity/apply-development.mjs`.
- Added this report and `docs/baselines/PRD_V2_PHASE_1B_SECURITY_EMAIL_QUALIFICATION_RECEIPT.json`.

No commit or push was performed. Runtime .env files, historical migrations 0001–0005, historical receipts and the repository reconciliation report are unchanged. The Phase1 report change is append-only.

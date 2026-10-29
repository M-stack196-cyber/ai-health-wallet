# PRD v2 Phase 6 — Doctor sharing backend qualification

29 October 2026 · Asia/Karachi. Owner-authorized scope: M09 and minimum shared authorization/email/storage/traceability support. Entry checkpoint: `9eb1603` (Phase 5 patient RAG backend); tracked worktree was clean. No commit, push, production migration, deployment, M10 implementation or frontend work was performed.

Authoritative requirements remain SRS v4.0 and PRD v2.0. Their SHA-256 values are respectively `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55` and `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84`. The tracker, reconciliation and Phase 5 report provide current traceability. Historical evidence and migrations 0001–0010 remain unchanged. No requirement disappears or receives completion merely from old tests.

The authorized backend slice is implemented and qualified offline: patient-owned exact selections, opaque QR/link grants, email OTP through the existing encrypted queue, temporary doctor sessions, current authorization, private original bytes, selected timeline/report-summary/history view and selected-source RAG. **M09 is not fully complete:** patient/doctor client acceptance, CFG-04 review/provider qualification and live/release evidence remain open.

## Grant, QR, link and identity contract

- `POST /api/v1/sharing/grants`: current M01 patient session; explicit nonempty unique `document_ids` (maximum 20), `share_type` (`qr_code` or `unique_link`) and optional known `doctor_email`. Every source must be active, owned and have integrity/size metadata. There is no all-record default.
- Response contains grant metadata and an opaque 256-bit reference in `share_url`; QR grants also return an actual QR SVG encoded with `qrcode`. Only the patient creation response exposes the raw share reference. The URL fragment avoids placing it in an HTTP path/query; eventual clients must keep it out of analytics/logs. No patient identifier, medical data, object key or OTP is encoded.
- `GET /api/v1/sharing/grants` lists the patient's own grant metadata without returning raw references. `POST /api/v1/sharing/grants/:id/revoke` is owner-only and idempotent.
- `POST /api/v1/sharing/open` accepts `share_token` and returns only live grant type/expiry and the OTP requirement. It never returns patient/document metadata.
- `POST /api/v1/sharing/otp` requires the opaque reference, doctor `name` and `email`; `organization` is optional. A known recipient is bound at creation; otherwise the first challenge binds the recipient. No doctor account, dashboard or professional-license verification is introduced.
- `POST /api/v1/sharing/otp/verify` accepts reference, email, challenge ID and OTP. A successful challenge issues a temporary opaque doctor bearer, never a patient JWT. Opening/scanning a grant again does not bypass OTP.

The two entry paths converge on the same OTP/current-authorization boundary. QR rendering is backend-qualified; actual patient display, scanning and doctor-web redemption remain client acceptance work.

## OTP, configuration and safe audit

The email code has a random UUID challenge identifier and 256 random secret bits. Purpose-specific hashes are stored; validation binds challenge, grant, email, patient security version and expiry. Atomic row locks enforce single use; wrong attempts persist and the fifth consumes the challenge. Resend consumes prior challenges and revokes prior doctor sessions. Current verification rejects stale, expired, consumed, wrong-email and wrong-grant challenges.

M01's transactional encrypted queue, AES-GCM payloads, idempotency/worker handling and provider approval switch are reused. The doctor message contains a generic verification instruction, code and expiry, with no medical content or share reference. Pending ciphertext is deleted on terminal delivery. There is no raw-code application logging and no new email transport system. Verification, reset and guardian purposes were also exercised after the shared SQL change.

| Configuration | Default | Enforcement |
|---|---:|---|
| `SHARING_QR_SECONDS` | 3600 | QR grant expiry |
| `SHARING_LINK_SECONDS` | 86400 | Online grant expiry |
| `SHARING_SESSION_SECONDS` | 3600 | Doctor session expiry, capped by grant |
| `SHARING_OTP_SECONDS` | 600 | Challenge expiry, capped by grant |
| `SHARING_RESEND_SECONDS` | 60 | Per-grant cooldown |
| `SHARING_OTP_ATTEMPTS` | 5 | Per-challenge attempts |
| `SHARING_OTP_REQUESTS_PER_HOUR` | 5 | Hashed grant/email rate bucket |

`SHARING_PUBLIC_ORIGIN` must be explicitly configured; sharing stays disabled otherwise. HTTPS is required except literal loopback HTTP. Numeric bounds are validated centrally; business logic uses the configuration. IP and subject buckets reuse M01 keyed hashes. The OTP request IP ceiling is 100/hour; verification uses 30/subject/hour and 100/IP/hour. Grant creation/open and doctor access have separate bounded buckets. Unknown/expired/revoked grants fail generically. A trusted proxy/client-origin deployment configuration is a future operational acceptance responsibility; none was activated here.

**CFG-04:** local default lifetime/attempt/resend/rate enforcement and encrypted synthetic delivery PASS. Formal security review, operational policy approval, approved real provider/inbox delivery and delivery-failure operations remain OPEN; M09-019 stays BLOCKED. No production provider approval was invented.

**CFG-05:** local configured 1h/24h/10m behavior, session caps and request-time expiry/revocation PASS. Actual deployed settings, secrets, client handling and live operational qualification remain OPEN. Cleanup is not required for enforcement.

Safe append-only audit records only grant ID, event and time: created/opened/OTP requested/verified/failed/authorized/denied/download/revoked/expiry denial. No OTP, raw bearer/share reference, email, medical text or storage credentials are stored in these events. Application UPDATE/DELETE privileges are absent.

## Current authorization and selected-source access

Every protected doctor request resolves the hashed temporary bearer against the current database session, grant, selected membership, patient status/verification/security version and source eligibility. Both session and grant expiry/revocation/version are checked. Authorization is resolved again around retrieval/publication/response; it is never replaced by a historical successful OTP result. Changes to selected scope during a request fail closed.

Grant creation and challenge operations lock patient before grant; source locks and M04 deletion use the existing patient/source ordering. Revocation invalidates sessions and increments the grant version. Patient account suspension/deletion/security-version changes deny doctor access. M04 deletion revokes affected grants conservatively; source restriction also overrides old membership. Previously downloaded bytes cannot be recalled, but the next request fails without grace or cleanup.

| Doctor API under `/api/v1/doctor` | Scope and behavior |
|---|---|
| `GET /records`, `GET /records/:id` | Only active selected records; existing category/hospital/date/pagination filters; unknown scope selectors rejected |
| `GET /records/:id/view`, `/download` | Integrity-checked private original bytes, inline/attachment disposition, current grant before acquisition and before response bytes |
| `GET /timeline` | Existing M06 service with server-derived selected IDs and a current resolver |
| `GET /records/:id/summary` | Existing current M07 accepted report summary/provenance; unavailable summary returns 404 |
| `GET /history-summary` | Chronological existing-summary view of selected accessible sources only; missing summaries remain null; no patient-wide history manifest or invented history generation |
| `POST /rag/queries`, `GET /rag/queries/:id` | Existing M08 pipeline with patient AND current grant/session AND selected IDs AND current source eligibility; saved queries bound to that grant |

File delivery reuses the original private storage adapter, safe reference checks, bounded temporary file, SHA-256/size validation and cleanup. No public/presigned URL or bucket/key is returned. Doctor delivery supplies a trusted current-grant policy to the shared file primitive; patient delivery continues using M01.

RAG applies selected IDs before ranking and checks doctor scope in vector/evidence RLS. Query results and source membership retain the sharing grant. Reads are grant-filtered; patient-only query reads do not accidentally disclose doctor interactions. Final authorization prevents publication when a grant is revoked during generation. Citations retain exact source/provenance; no-record/unsupported/clinical advice requests retain insufficiency and non-diagnostic behavior. Python was unchanged: the Phase 5 LangChain/LangGraph synthetic bounded English lab pipeline is reused, not a production model or general clinical RAG acceptance.

## Migration, files and checks

Only additive `backend/migrations/0011_doctor_sharing.sql` was added. It extends existing grant/OTP foundations with recipient/current-version metadata, doctor challenge identity, temporary sessions, append-only events and doctor-aware RAG policies. Existing grants have no newly qualified session; legacy schema alone grants no doctor access. The migration extends the shared challenge/email purpose allowlists and allows independent live doctor challenges across grants while preserving the existing patient-purpose uniqueness rule.

All 11 migrations apply under the non-login migration role on a fresh disposable PostgreSQL 16 cluster with real pgvector 0.6.0 in an owned `/tmp` installation. Transactional rollback probes preserve a legacy source sentinel; rollback of 0011 removes its session table. Application-role tests exercise selected-vector exclusion, current source/grant authorization, scoped RAG publication and append-only audit permissions. No normal/development/production database, application `.env`, AWS credentials or live bucket was used.

Changed implementation/configuration files:

- `backend/src/sharing/{config,repository,routes}.ts` (new).
- `backend/migrations/0011_doctor_sharing.sql` (new).
- `backend/src/app.ts`, `backend/src/auth/{routes,security-email}.ts`.
- `backend/src/documents/file-access.ts`, `backend/src/rag/{repository,service}.ts`.
- `backend/.env.example`, `backend/package.json`, `backend/package-lock.json` (`qrcode` and its TypeScript declarations).
- `backend/src/phase6/phase6.test.ts` (new), `infrastructure/identity/run.mjs` (Phase 6 selection and incremental private test evidence).
- Existing identity, document-closure, guardian Phase 2 and Phase 3–5 test bootstraps: migration count 10→11 only; no historical evidence overwritten.
- Current delivery tracker, this report and the new Phase 6 receipt.

Focused command: `PHASE3_PYTHON=/tmp/hw-phase3-python/bin/python node infrastructure/identity/run.mjs --execute-isolated --phase6`.

**Final result: 11/11 PASS, 0 failed/skipped; 123418.97257 ms.** Final disposable cluster `/tmp/hw-phase1-pg-JPxvhF` stopped successfully. Private TAP: `.private-evidence/prd-v2-phase6-20261029/node-final.tap`. No broad regression suite ran. Earlier attempts encountered interrupted runner sessions, synthetic startup/upload-fixture timeouts and invalid/timing-sensitive test fixtures; final M09 fixtures use the existing qualified document repository instead of repeating native upload validation. Final cooldown tests use the approved default and leakage assertions inspect source IDs/clinical text, not random hash substrings.

| Test | Qualified evidence |
|---|---|
| P6-01 | Defaults, disabled configuration, origin/bounds |
| P6-02 | Explicit selections; foreign/deleted/restricted denial; QR SVG/link; no pre-OTP PHI; TTLs |
| P6-03 | Encrypted queue dispatch; hashed OTP; wrong email/grant/code; valid and reused OTP; session |
| P6-04 | Missing identity, expired OTP, exhausted attempts, cooldown/hourly resend limit |
| P6-05 | A/C-only metadata/originals/filtering/timeline/report/history/RAG; B/foreign/cross-grant denial; citations/insufficiency/vector exclusion; immediate/idempotent revoke |
| P6-06 | QR/link/session expiry and replay denial on every API without cleanup |
| P6-07 | Deletion/restriction/account suspension/deletion/security-version overrides |
| P6-08 | Revocation during original acquisition denies response bytes; safe append-only audit |
| P6-09 | Resend invalidates prior challenge/session; optional organization |
| P6-10 | Shared email verification/reset/guardian delivery compatibility |
| P6-11 | Revocation during RAG generation prevents saved answer; patient original preserved |

`npm --prefix backend run typecheck` and `npm --prefix backend run build`: PASS. `git diff --check`: PASS. No Python files changed, so no additional Python unit suite was required; the focused Node integration exercised the unchanged real private Python graph. Inventory verification preserves all 232 IDs/source texts/mappings/priorities and all non-M09 detailed rows. All 32 protected authoritative-document/migration/prior-receipt hashes match the entry snapshot.

Dependency audit: 1 pre-existing high-severity `body-parser` advisory (`GHSA-27r3-jxmh-p828`, installed 2.3.0). The entry lockfile already has that version; QR dependencies introduce no reported advisory. The private npm audit JSON records it. It remains a release remediation/security-review blocker; no unrelated blanket dependency update was made.

## All M09 requirement statuses

IMPLEMENTED below means the qualified backend behavior; it does not certify browser, cloud, provider or clinical release acceptance.

| Requirement | Final status | Remaining boundary |
|---|---|---|
| M09-001 | IMPLEMENTED | Current authorized backend access qualified; live/client acceptance external |
| M09-002 | PARTIAL | QR SVG supplied; patient display/scan workflow absent |
| M09-003 | IMPLEMENTED | Opaque online grant issuance/redemption backend |
| M09-004 | IMPLEMENTED | Existing email queue + bound OTP; real inbox qualification pending |
| M09-005 | PARTIAL | Selected structured-filter APIs; doctor web/search acceptance absent |
| M09-006 | PARTIAL | Patient initiation API; patient UI absent |
| M09-007 | IMPLEMENTED | Selected originals and next-request revoke/expiry denial |
| M09-008 | IMPLEMENTED | Exact nonempty owned selections; no default all-record scope |
| M09-009 | PARTIAL | Both backend paths; physical/online client acceptance absent |
| M09-010 | IMPLEMENTED | QR and link require OTP before medical content |
| M09-011 | IMPLEMENTED | Opaque payload alone reveals no medical data |
| M09-012 | IMPLEMENTED | Name/email required, organization optional; no license module |
| M09-013 | IMPLEMENTED | Purpose-bound hashes and encrypted queue; no reusable plaintext state |
| M09-014 | IMPLEMENTED | Configurable 1h/24h/10m defaults and runtime enforcement |
| M09-015 | IMPLEMENTED | Current session/grant/patient/source/selection checks across APIs |
| M09-016 | IMPLEMENTED | Immediate idempotent patient revocation; no open-page grace |
| M09-017 | IMPLEMENTED | Selected private original inline/download bytes |
| M09-018 | IMPLEMENTED | Temporary doctor sessions; no permanent account/dashboard dependency |
| M09-019 | BLOCKED | Technical controls qualified; CFG-04 security/provider approval and live qualification unresolved |

M09 totals: **14 IMPLEMENTED / 4 PARTIAL / 0 MISSING / 1 BLOCKED / 0 NEEDS_REVERIFICATION**. Backend implementation is complete for the approved bounded/reused slice. Full M09 delivery remains incomplete.

## Release gates and next phase

Outstanding gates: M11/M12 patient and doctor UI/QR scan/browser acceptance; approved actual email provider and CFG-04 security policy review; deployed CFG-05 settings/session handling; live private S3 retrieval/isolation and cloud operational qualification; the existing dependency advisory; inherited CFG-01/02/10 model/semantic/clinical gates and CFG-12/18 retention/legal gates. Synthetic queue/storage/graph evidence does not substitute for any of these. No unresolved retention or clinical gate was closed.

Phase 7 must not start automatically. The qualified backend permits owner review and planning of a separately authorized synthetic M10 slice. Actual guardian digest/serious-alert activation still requires its CFG-06/07/11/15 clinical/privacy/configuration approvals and provider/release prerequisites. No real-patient alert, production readiness or whole-product acceptance is asserted. STOP for owner review.

## Tracker totals and 18-module progress

Counts are IMPLEMENTED / PARTIAL / MISSING / BLOCKED / NEEDS_REVERIFICATION; they measure requirement status, not release readiness. Non-M09 detailed rows retain their previous classifications.

| Module | I | P | M | B | NR |
|---|---:|---:|---:|---:|---:|
| M01 | 14 | 0 | 0 | 0 | 0 |
| M02 | 10 | 0 | 0 | 0 | 0 |
| M03 | 8 | 2 | 0 | 0 | 2 |
| M04 | 11 | 3 | 0 | 0 | 0 |
| M05 | 9 | 1 | 0 | 0 | 0 |
| M06 | 5 | 3 | 0 | 0 | 0 |
| M07 | 3 | 5 | 2 | 1 | 0 |
| M08 | 13 | 5 | 2 | 2 | 0 |
| M09 | 14 | 4 | 0 | 1 | 0 |
| M10 | 0 | 2 | 10 | 2 | 0 |
| M11 | 1 | 0 | 10 | 0 | 0 |
| M12 | 1 | 0 | 9 | 0 | 0 |
| M13 | 0 | 0 | 21 | 1 | 0 |
| M14 | 0 | 9 | 0 | 1 | 1 |
| M15 | 1 | 4 | 6 | 1 | 0 |
| M16 | 0 | 5 | 1 | 3 | 1 |
| M17 | 0 | 5 | 3 | 1 | 2 |
| M18 | 2 | 3 | 0 | 6 | 0 |
| **Total** | **92** | **51** | **64** | **19** | **6** |

232 requirements retained; weighted control estimate **50.6%**. M01 and M02 retain backend qualification; no whole-product delivery completion follows from these counts.

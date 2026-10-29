# PRD v2 Phase 7 — Guardian notifications

29 October 2026 · Asia/Karachi. Entry/current checkpoint: `49766c98d047afa6030777eea21ed3fc32d72f24` (`Resolve body-parser security advisory`); tracked worktree was clean at entry. Authorized scope: M10 and minimum M14/M15/M18 support. No frontend, Admin dashboard, AWS deployment, full-system qualification, commit or push was performed.

Authoritative product requirements remain SRS v4.0 and PRD v2.0, supported by the current tracker/reconciliation, Phase 6 report and body-parser remediation report. SRS SHA-256: `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55`; PRD SHA-256: `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84`. Authoritative documents, migrations 0001–0011 and all prior receipts are unchanged. The body-parser fix remains installed/locked at 2.4.0 with Express 5.3.0; dependencies were not upgraded in this phase.

**The authorized synthetic backend slice is implemented and qualified. M10 is not fully complete or approved for real patients.** Normal API startup does not start a medical-email worker. Explicitly enrolled synthetic fixtures, `.invalid` patient/guardian addresses, non-clinical rules and a distinct literal-loopback medical sandbox are required. Production medical provider/clinical activation is rejected.

## Routine digest and processing readiness

An explicit polling executor discovers current source-ready records for one or more trusted synthetic patient scopes. It reuses M05 completed extraction/claim evidence, M07 immutable source snapshots and accepted report summaries. Upload alone creates no routine notification. Failed/unprocessed extraction, absent/failed summary and deleted/restricted/stale sources cannot qualify as completed reports.

Routine readiness means **verified current extraction plus an accepted current M07 summary**. This is a notification readiness contract; it does not relabel the legacy aggregate document flag or claim full OCR/AI/clinical completion. The worker uses existing summaries and their uncertainty/provenance; it does not call an AI model or invent summary content during email delivery.

Routine eligible sources are reserved once per document/patient/source snapshot, with exact summary membership. Fixed UTC epoch-aligned digest windows are configuration-controlled and default to **86400 seconds (24 hours)**. Reports in a window form a pending recipient-bound batch; the batch becomes due at that window's end. This is periodic window grouping, rather than a new 24-hour delay starting independently for each report. New ready sources outside a delivered window can form later batches; completed source reservations prevent replay on subsequent scans. Discovery is bounded and skips previously evaluated/reserved sources.

A batch contains report filename/date context, a secure original-reference URL and each included M07 summary, with provider/model/revision, summary version, source fingerprint and uncertainty metadata. Patient names, storage keys, internal document/patient IDs, RAG internals, credentials and prompts are omitted from message text. The reference contains an opaque random identifier and keyed 256-bit proof. Only its purpose-bound hash is stored; no reusable plaintext reference or medical email body is persisted in the queue. A reference signing key is explicit private synthetic configuration and is included only through a digest in the versioned policy fingerprint.

The report-reference URL uses a fragment; clients redeem the opaque token by JSON POST to a backend private-byte endpoint. Existing M03/M04 original retrieval validates the source, storage reference, SHA-256/size, current guardian/account authorization and expiry before acquisition and again before response bytes. There is no public/presigned object URL. Actual usable email/reference-client UX, forwarding policy, reference TTL and live storage require CFG-11/security/client acceptance. No guardian portal or new frontend was built.

## Delivery, retries and current recipient authorization

The medical queue stores identifiers, source/rule bindings, timestamps, safe states/failure codes and hashes. It reuses M01's `SecurityEmailProvider`, bounded HTTP/redirect/receipt handling, `EmailDeliveryFailure` and idempotency transport. Verification/invitation OTP payloads continue through the unchanged encrypted security-email queue. Medical jobs use a separate endpoint (`/guardian-medical-email`) and never pass medical content to the verification-only channel. A second live email stack was not introduced.

Jobs have `pending`, `running`, `retry_wait`, `delivered`, `permanent_failed` and `cancelled` states, with attempts, bounded backoff, claim tokens, lease recovery, provider-reference hashes and safe failure reasons. Defaults are three attempts and a 30-second exponential retry base. Transient transport/provider/timeout failures may retry; permanent rejection, exhausted attempts or invalid receipts remain observable. Failed attempts do not set `delivered_at`. Claim/lease recovery and source reservations prevent concurrent workers from creating uncontrolled duplicates.

Before any provider handoff, the worker commits the exact content fingerprint and reference expiry. Every retry reuses the same job idempotency key and identical content/references. A changed source, recipient, policy, rule status/version or content fingerprint cancels incompatible work. A simulated accepted message followed by a lost receipt was retried with one accepted message in the idempotent sandbox. Production effect deduplication still depends on an approved provider's durable idempotency/receipt contract; no distributed exactly-once production guarantee is asserted.

Before preparation and again before every provider call/retry, the worker checks:

- Current enrolled synthetic patient, active/verified account and queued security version.
- The same M02 relationship, ACTIVE status, accepted verification and current immutable recipient email hash.
- Current source snapshot, extraction readiness, summary/source mapping and document access state.
- Configured policy/rule versions and current non-clinical rule status for serious items.

M02 changes and M04 deletion acquire the same patient row lock as dispatch. The final bounded provider handoff holds that lock. If removal/replacement/deletion completes before handoff, the old work is denied; it is never silently retargeted. If handoff already started first, removal waits for that bounded operation to settle. **Already handed-off email cannot be recalled**, and its medical text may have been accepted even if a receipt is lost. This boundary and permitted email content require privacy/provider approval before real-patient use. Completed removal immediately invalidates future attempts and existing report references.

Deletion/restriction before initial preparation excludes affected items; a batch can still deliver its remaining eligible sources. Once content is frozen, invalidation cancels the incompatible retry rather than changing a previously handed-off payload. Cancelled/permanently failed work remains observable and is not automatically recreated or redistributed. Newly eligible sources may produce future jobs. Any later recovery/re-distribution policy requires authorized operational design.

## Serious-rule evaluation and separate alerts

The rule engine stores immutable rule ID/version, definition fingerprint, field, units, comparator/bounds, required context and approval/version metadata. It supports `gt`, `gte`, `lt`, `lte`, `between` and `outside` comparisons. Results bind to a current M07 source snapshot and rule definition and persist `TRIGGERED`, `NOT_TRIGGERED` or `INDETERMINATE` with controlled explanation and source value/unit where reliable.

Only `DEMO_MARKER` in invented `demo_units` is enabled. The default software-test rule is `NON_CLINICAL_DEMO_MARKER`, version 1, comparison `> 10`; this is **not a laboratory analyte or medically authoritative threshold**. The runtime rejects real clinical fields/rules and non-synthetic provider modes. Schema metadata accommodates later approval records, but real-patient parsing/rules/units/context and activation require separate qualified approval and implementation; changing Admin metadata cannot activate clinical use.

Missing or ambiguous values, conflicting duplicate fields, unsupported units, missing/conflicting context and unverified OCR are persisted as INDETERMINATE. No unit conversion, guessed value, clinical reassurance or inferred serious condition is produced. CFG-07 configuration permits only `persist_only` or `blocked_pending_approval`, both with no outbound indeterminate medical message. Patient-authorized status observations retain uncertainty while hiding findings derived from deleted/restricted/stale sources.

A TRIGGERED demo result queues an independent `serious_alert`, due promptly and prioritized independently of routine jobs. It can be dispatched after successful source extraction **before a summary exists**, without waiting for the 24-hour digest. The alert includes the relevant report reference, versioned rule, reliable synthetic value/unit and deterministic cautious explanation. It explicitly states that it is non-clinical, does not diagnose/prescribe, assert emergency certainty or replace professional evaluation. No AI model independently invents a serious condition. Clinically approved serious findings and cautious AI explanation acceptance remain partial/gated work.

Only currently configured rule versions may create new alerts. Changed definitions require a new version; conflicting reuse of an existing ID/version fails. Withdrawal of a demo rule's eligible status invalidates pending alert dispatch and references. Source-bound evaluation history remains retained for traceability; normal patient status reads require a currently accessible source.

## Configuration gates

| Gate | Qualified local behavior | Still open |
|---|---|---|
| CFG-06 | Versioned demo definitions, comparison/context/units checks, three outcomes, current-rule authorization | Qualified clinical reviewer; approved real analytes, units, ranges, thresholds/context; approved extraction adapter and clinical activation |
| CFG-07 | Persisted uncertainty and observable INDETERMINATE; no serious conversion or outbound uncertainty message | Approved human-readable handling/wording and any guardian messaging policy |
| CFG-11 | Current accepted guardian only; same recipient on retries; source/deletion/account fences; synthetic content/references | Guardian privacy/legal consent/content/reference/forwarding design; actual provider and live inbox/storage/client qualification |
| CFG-15 | Versioned configurable 86400-second windows, deterministic batches, deduplication, due-time separation and later windows | Authorized operational scheduling/settings, monitoring, recovery policy and deployed acceptance |

Defaults/candidate settings are centralized in `guardian-notifications/config.ts`:

| Setting | Default / restriction |
|---|---|
| `GUARDIAN_NOTIFICATIONS_MODE` | `disabled`; only explicit `synthetic-offline` construction supported |
| `GUARDIAN_DIGEST_SECONDS` | 86400; validated 1–604800 |
| `GUARDIAN_REPORT_REFERENCE_SECONDS` | 3600; synthetic candidate pending release approval |
| `GUARDIAN_RETRY_SECONDS` | 30 |
| `GUARDIAN_MAX_ATTEMPTS` | 3; bounded 1–5 |
| `GUARDIAN_SEND_TIMEOUT_MS` | 2000; bounded at 3000 |
| `GUARDIAN_INDETERMINATE_POLICY` | `persist_only`; no outbound activation value |
| `GUARDIAN_NOTIFICATIONS_ORIGIN` | HTTPS `.invalid` synthetic reference origin |

There is no Admin configuration endpoint/dashboard. Message text is bounded at 65536 bytes and fails closed when incompatible/over quota; wider batch/content limits require operational/privacy acceptance. The synthetic provider uses a separate literal-loopback endpoint and `.invalid` recipients. No real medical provider is approved or enabled.

## APIs, worker and files

- `GET /api/v1/patients/me/guardian-notifications`: current M01 patient session; source-current job/evaluation observations only, with explicit synthetic mode/release-gate labels.
- `POST /api/v1/guardian-notifications/reports`: accepts only the emailed opaque token; current recipient/patient/source/expiry checks, hashed IP rate bucket and existing secure original-byte delivery. Extra recipient/document/patient selectors are denied.
- `createGuardianNotificationExecutor`: explicitly scoped polling/discovery and one delivery attempt per patient per tick, with busy/stop controls. API import/startup never starts it.
- `npm --prefix backend run guardian-notifications:synthetic:once`: guarded fixture-only command. It requires a marked 0700 `/tmp/hw-phase1-pg-*` socket, `hw_phase7`, explicit synthetic patient/key/loopback endpoint configuration and existing fixture enrollment. It loads no normal application `.env` and cannot select a production database/provider. Positive executor behavior is integration-tested; the command is a constrained manual fixture tool, not a deployed worker qualification.
- `npm --prefix backend run phase7:test`: disposable focused suite.

Changed implementation files:

- New `backend/src/guardian-notifications/{config,rules,provider,service,executor,routes,entry}.ts`.
- New `backend/migrations/0012_guardian_notifications.sql` and `backend/src/phase7/phase7.test.ts`.
- `backend/src/app.ts` mounts only read/reference routes.
- `backend/.env.example`, `backend/package.json` add disabled configuration/candidate settings and focused/fixture scripts. Dependency versions and lockfile remain unchanged.
- `infrastructure/identity/run.mjs` adds a disposable Phase 7 selector; Phase 7 requires no Python interpreter.
- Existing identity, document closure, guardian Phase 2 and Phase 3–6 test bootstraps: migration count 11→12 only.
- Current delivery tracker, this report and the new receipt. No historical tracker/report/receipt was overwritten.

## Additive migration and safe evidence

Only migration **0012** was added. Seven tables cover explicit synthetic enrollment, immutable versioned rules, medical jobs, routine source reservations, source-bound results, exact job membership/report-reference hashes and append-only events. Composite foreign keys preserve patient/document/source/rule identity; shape constraints govern attempts, claim/lease states, delivery timestamps, outcomes and fingerprints. The new current-item function checks source/summary/rule validity with a fixed search path and restricted EXECUTE privileges.

The historical notification table references legacy guardian contacts rather than accepted M02 relationships. It remains unchanged and confers no delivery authority. New jobs bind directly to verified M02 relationships and M07 immutable sources. The app can SELECT/INSERT rules/events, with no UPDATE/DELETE grants; no arbitrary recipient API is exposed.

All migrations applied under the non-login migration role in fresh disposable PostgreSQL 16, with existing pgvector 0.6.0 available only through the owned `/tmp` test installation for prior migration 0010. A transactional 0012 rollback removed its tables and preserved a legacy patient sentinel. No production or normal development database was used; no schema was deployed.

Safe events record patient/job IDs, event type and time only: eligibility/queue, attempts, delivered/failed, current-recipient/source denial, rule evaluation/trigger/indeterminate and recovered lease. Serious sent/failed events are distinguished by the linked job kind. Medical text, raw email addresses, references, OTPs, keys and credentials are absent from event records/logging. Medical payloads remain transient in memory; source summaries/results retain their existing medical-data/retention responsibilities. No CFG-12/18 retention/legal gate was closed.

## Focused test results

**Final M10 suite: 19/19 PASS, zero failed/skipped**, 32074.55673 ms. Command: `node infrastructure/identity/run.mjs --execute-isolated --phase7`. Final cluster `/tmp/hw-phase1-pg-xU2tUQ` stopped successfully. Earlier focused attempts exposed invalid cooldown/immutable-recipient fixtures and a missing excluded-item membership flag; these were corrected. A passing 17-case run was followed by the final deletion-aware observation and rule-status/version checks.

| Evidence | Coverage |
|---|---|
| P7-01 | Disabled/synthetic-only policy, 24h default, comparators, units/context/value/OCR uncertainty and verification-channel isolation |
| P7-02 | Processing + current-summary eligibility, grouping, no immediate send, original references, privacy/scope/provenance and source deduplication |
| P7-03 | None/pending/expired/revoked guardians receive no medical content |
| P7-04 | Current relationship removal/replacement immediately before handoff; durable prepared fingerprint |
| P7-05–08 | Transient/permanent/exhausted retries, stable payload/reference/key, lost receipt, idempotency, stale lease and concurrency |
| P7-09 | Prompt separate trigger alert before summary; later independent routine digest |
| P7-10 | Serious-alert relationship races; indeterminate/not-triggered outcomes produce no alert |
| P7-11 | Deleted/restricted item exclusion, retry invalidation and deleted serious-source denial |
| P7-12 | Current guardian on every retry, account/security version fences and immutable recipient denial |
| P7-13 | Patient-locked handoff/removal ordering; completed removal denies future references/sends |
| P7-14 | Cross-patient foreign keys, arbitrary-selector denial, expiring references and safe append-only audit |
| P7-15 | Content/policy/rule version drift denial; new sources in later digest windows |
| P7-16 | Explicit worker discovery/due-time delivery, busy and stop behavior |
| P7-17 | Timeout/invalid receipts remain observable; no false delivered state |
| P7-18 | Deleted/restricted derived findings hidden from patient status API |
| P7-19 | Current configured rule versions and withdrawn status constrain alert creation/dispatch |

Additional focused checks:

- Existing guardian/auth/document compatibility: **33/33 PASS**, no failed/skipped. Command: `IDENTITY_TEST_PGVECTOR_PREFIX=/tmp/hw-phase5-pg node infrastructure/identity/run.mjs --execute-isolated --phase2`; stopped cluster `/tmp/hw-phase1-pg-j4KLAx`. Includes existing encrypted invitations, actual registration/verification, guardian races and valid/invalid document upload/private access behavior.
- HTTP parsing/actual application startup compatibility: **4/4 PASS**, using the existing body-parser security checks and a temporary compiled-code copy without normal `.env`.
- `npm --prefix backend run typecheck`, `npm --prefix backend run build`, `node --check infrastructure/identity/run.mjs`, `git diff --check`: PASS.
- Fresh npm audit: **zero vulnerabilities**. Express 5.3.0/body-parser 2.4.0 remain unchanged.
- App-role FK/privilege, current source/recipient/rule checks and additive apply/rollback: PASS inside focused suite.
- Python unchanged; deterministic demo parsing is Node-only, so no new Python tests were required. No broad regression/full-system suite ran.

**56 focused tests passed in total.** Private evidence: `.private-evidence/prd-v2-phase7-20261029/` (`node-final.log`, compatibility/startup logs, `npm-audit.json`, immutable entry hashes and inventory checks). Synthetic sandbox messages are memory-only; no real inbox/cloud/provider/clinical acceptance is inferred.

## All M10 requirement statuses

IMPLEMENTED denotes the explicitly qualified synthetic backend behavior; it does not close real-patient, client, clinical/provider/privacy or release acceptance.

| Requirement | Final status | Qualified result / remaining boundary |
|---|---|---|
| M10-001 | IMPLEMENTED | Current processing/summary eligibility, exact report references and independent alert queue; external medical content/client/privacy gates retained |
| M10-002 | PARTIAL | Demo deterministic serious-alert delivery qualified; clinically approved real findings/adapter/provider remain gated |
| M10-003 | IMPLEMENTED | Existing bounded email-service/API transport reused on a distinct synthetic medical endpoint |
| M10-004 | IMPLEMENTED | Configurable routine batches and separate prompt alerts |
| M10-005 | IMPLEMENTED | No upload-only/failed/unprocessed/summary-unready routine delivery |
| M10-006 | IMPLEMENTED | Versioned 24-hour default windows, exact membership and later-window deduplication |
| M10-007 | IMPLEMENTED | Separate serious queue does not wait for routine window or summary readiness |
| M10-008 | IMPLEMENTED | Current ACTIVE/accepted same guardian, current patient/source checks and serialized handoff |
| M10-009 | IMPLEMENTED | Observable provider success/failure/unknown receipt handling and reference hashes |
| M10-010 | IMPLEMENTED | Bounded retries/backoff, idempotency, lease recovery and retry-time authorization |
| M10-011 | BLOCKED | Immutable demo engine/approval metadata qualified; qualified clinical approval and real-rule activation absent |
| M10-012 | PARTIAL | Persisted conservative demo INDETERMINATE; approved general clinical parsing/human handling/CFG-07 wording remain gated |
| M10-013 | PARTIAL | Cautious synthetic flagged-value/rule/source explanation; approved clinical/AI explanation acceptance remains gated |
| M10-014 | IMPLEMENTED | Removal/replacement stops old queued attempts/retries/references; no automatic retargeting |

M10 totals: **10 IMPLEMENTED / 3 PARTIAL / 0 MISSING / 1 BLOCKED / 0 NEEDS_REVERIFICATION**. Clinical approval, guardian privacy/legal approval, production email qualification and client/deployment acceptance remain separate and OPEN.

## Frontend Phase 8 and owner review

The qualified backend contracts support planning and, after separate owner approval, synthetic API-driven frontend Phase 8 work. No frontend phase starts automatically. Real-patient medical notifications remain disabled until CFG-06/07/11/15 and the inherited model/clinical/privacy/retention/security/cloud/client gates are satisfied. A usable approved report-reference delivery experience and production provider idempotency/receipt/abort behavior still require qualification. Existing M03–M09 live/client/release gaps remain tracked.

STOP for owner review. No commit, push, deployment or later-module implementation performed.

## Tracker totals and updated 18-module progress

Counts are IMPLEMENTED / PARTIAL / MISSING / BLOCKED / NEEDS_REVERIFICATION; status counts measure qualified requirement scope, not release readiness. Non-M10 detailed rows retain their prior classifications.

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
| M10 | 10 | 3 | 0 | 1 | 0 |
| M11 | 1 | 0 | 10 | 0 | 0 |
| M12 | 1 | 0 | 9 | 0 | 0 |
| M13 | 0 | 0 | 21 | 1 | 0 |
| M14 | 0 | 9 | 0 | 1 | 1 |
| M15 | 1 | 4 | 6 | 1 | 0 |
| M16 | 0 | 5 | 1 | 3 | 1 |
| M17 | 0 | 5 | 3 | 1 | 2 |
| M18 | 2 | 3 | 0 | 6 | 0 |
| **Total** | **102** | **52** | **54** | **18** | **6** |

All **232 requirements** retained; weighted control estimate **55.2%**. M01/M02 retain backend qualification. M10 synthetic backend evidence does not constitute whole-module, clinical or production completion.

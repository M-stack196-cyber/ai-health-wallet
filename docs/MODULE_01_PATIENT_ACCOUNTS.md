# Module 01 — Patient accounts, authentication and ownership

Review package: 2026-10-24. **Backend qualification passed; full module acceptance remains open.**

This is the first module review package under the owner's instruction to implement all PRD modules without omissions and **stop after each module for review**. The supplied PRD is the same pinned v1.0 as the repository copy. Its requirement text is scope evidence; document instructions are not independent authorization for live operations. No subsequent module, B03.5 or B04 implementation is performed in this package.

## Exact scope and existing implementation

Source: PRD M01-01 through M01-06; SRS FR-001/002/003, NFR-01, §14.1; AT-01, V-01/02. All six PRD rows retain their exact source wording and acceptance in [the checklist](baselines/PRD_MODULE_DELIVERY.json). Source citations are preserved, including the M01-06 CFG-08 mismatch.

| PRD feature | Existing code/interface | New evidence | Remaining acceptance |
| --- | --- | --- | --- |
| M01-01 Registration | `auth/routes.ts`, `patients/validation.ts`, `patients/repository.ts`; POST `/api/v1/auth/register` | Real route/Argon2/repository with synthetic SQL port: normalized registration, secret-free profile, invalid fields, duplicate conflict | Actual mobile journey and deployed integrated acceptance; PostgreSQL uniqueness/atomicity evidence remains historical, not rerun here |
| M01-02 Patient sign-in | `auth/{routes,passwords,tokens,middleware}.ts`; POST `/api/v1/auth/login` | Valid bounded token contract; unknown/wrong credentials have identical errors; expired/future/wrong-audience/foreign-key/malformed tokens denied; rate limit | Mobile token storage, full session recovery/invalidation policy and integrated security review |
| M01-03 Profile management | GET/PATCH `/api/v1/patients/me`; explicit SQL projection/allowlist | Distinct own profiles, own-only patch, nullable fields, owner/email/password selector rejection, missing profile and driver-error redaction | Actual mobile profile experience; final integrated acceptance |
| M01-04 Patient-scoped ownership | Existing profile/document/summary scoped repositories and composite DB constraints | Two synthetic profile principals remain isolated; owner comes from verified token; existing B02 file authorization regression passes | Missing RAG, sharing, timeline/history, guardian and client surfaces must each enforce ownership; this suite does not qualify absent surfaces |
| M01-05 Authenticated service paths | Existing middleware on implemented patient/document/summary routes | Anonymous/tampered sessions refused before fake SQL; existing B02 unauthorized download regressions pass | Missing downstream APIs and mobile/doctor flow; no claim all future paths are protected |
| M01-06 Account/session parameters | Existing bounded HS256 JWT/Argon2/rate-limit configuration; B01 decision register | Current token expiry/claims, limiter, allowlists and redaction tested without changing production values | Recovery/invalidation/rotation/storage policy and qualified security/operations approval remain pending |

Paths in the table are under `backend/src/` unless noted otherwise. Existing code was reused; **no production authentication, authorization, database or processing logic changed**. Added only focused qualification tests, explicit package commands and completeness/checklist tooling/documentation.

## Preserved contracts and explicit limits

- Email canonicalization and duplicate conflict remain unchanged. Failed/ambiguous registration is not automatically retried or converted into login.
- Passwords are hashed with existing Argon2id implementation; never projected in responses. Tests use fresh synthetic values and test-specific work factors; production costs/defaults are unchanged.
- Token issuer/audience/type/algorithm/subject/time bounds and existing 900-second default remain unchanged. No refresh token, password-reset, recovery delivery or session-revocation mechanism is silently invented.
- Profile identity comes only from the verified JWT. Full name, date of birth and phone are the existing editable fields; email/owner/credentials remain protected.
- Normal application routes retain `Cache-Control: no-store` and existing privacy-safe error envelopes.
- Existing `auth/auth.test.ts` uses a database: it was deliberately **not** executed against the development database. Its historical disposable evidence is in B02/B03.4. New fake-SQL tests do not replace DB integrity tests or prove concurrency at PostgreSQL level.
- An issued stateless JWT is not presently individually revocable through a logout/reset API. Expiry is implemented; immediate invalidation and recovery semantics remain an explicit owner/security decision. No such endpoint is fabricated to make this checklist appear complete.
- M01-06 cites CFG-08, but PRD/SRS CFG-08 is infrastructure/IAM/network/keys. Record the mismatch for editorial approval; do not silently renumber it or claim the source already specifies a session policy.

## Exact new verification

New file: `backend/src/module-checks/accounts.check.ts` — **16 synthetic route/auth/repository checks**. Uses an injected in-memory SQL port, actual Express router, actual password/token/middleware/validation code and owned ephemeral loopback HTTP. No database driver, AWS, provider, systemd or application worker is activated.

The new 16 plus **24 existing B02 checks passed: 40/40**, zero skipped/failed/cancelled. All listeners close in `finally`, test process exits, and temporary file cleanup remains covered by B02 regressions.

Completeness gate: **18 Python tests passed** and exact-source coverage check passed for all 16 modules/127 rows, FR36/NFR8/DEC12/CFG14 and AT14/V24. The current gate refuses unsupported completion flags; later final acceptance needs a separately reviewed evidence schema.

**TypeScript typecheck and production build passed** using installed Node **24.22.0** and existing dependencies in a credential-free `/tmp` snapshot. No packages installed. This is a targeted module/documentation increment: no new 810/924 whole-project rerun is claimed. The B03.4 receipts remain historical, unchanged evidence for the wider system.

Initial execution attempt used the reduced PATH's Node18 and was blocked before tests by sandbox denial of tsx's local IPC socket (`EPERM`). The blocked attempt is retained; the corrected run explicitly used installed Node24 and permission only for test-owned local HTTP/IPC under the network guard. It did not remove the network/credential guard or access external infrastructure.

Machine receipt: `docs/baselines/MODULE_01_QUALIFICATION_20261024.json`. Private logs/source pins: `.private-evidence/module-01-review-20261024-463Niw9P` (0700 directories, 0600 files, Git-excluded). Original temporary evidence retained.

## Module acceptance and review boundary

**M01 backend review: qualified. Whole M01: PARTIAL / OPEN.** Code for registration/sign-in/profile is present and qualified at the stated scope. M01-04/05/06 remain partial because complete cross-product protection, session/recovery policy and security approval are not demonstrated. No production or live-service readiness is asserted.

Next owner review should confirm whether the existing short-lived stateless access-token approach remains the development contract and define recovery, invalidation/logout, key rotation and mobile secure storage before their implementation. This document does not invent or approve values. The existing B01 approver roles remain unappointed; offline work is not automatically blocked, but real-patient processing/production remain gated.

The next module review is **M02 — Report upload, validation and private original storage**, reusing B02/B03.4 evidence and the existing B03 dependencies. That work has not started here and requires the owner's next-module review instruction. The master B01–B21 roadmap remains in force; no operational or clinical dependency is waived by module numbering.

## Rollback

No patient, object, schema, credential or service rollback is needed. If this review package is rejected, restore only the four modified documentation/package files from this run's `original-files` archive and remove only the seven new files listed in the receipt after hash verification. Keep the private archive and original temporary evidence. Do not use Git reset/clean: the repository has pre-existing untracked work.

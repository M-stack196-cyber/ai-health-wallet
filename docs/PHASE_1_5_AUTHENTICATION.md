# Phase 1.5 — Patient authentication and profile management

## Requirements reviewed and scope

The actual `docs/AI_Health_Wallet_Final_SRS_v3.docx` is now available and was read
for this phase. Relevant requirements are FR-001/002/003, UC-01, NFR-01/02,
AT-01, V-01 and the ownership principle in V-02, plus Sections 5, 14.1, 15, 16
and the controlled-parameter/release guidance in Section 17. The document
requires patient registration/authentication and management of one's own
profile. It does not mandate additional profile fields, particular password
policy values or specific auth API contracts. The choices below are explicit
engineering defaults for local development, not newly inferred product scope.

This implements the backend registration/login/profile portion of AT-01 and
V-01 and verifies profile-level patient isolation. The full V-02 document/API/S3
scenario and mobile acceptance remain future-phase work. No guardian/doctor
accounts, social login, email verification, password reset, document, OCR, AI,
RAG, sharing, notification, frontend or AWS functionality was introduced.

## Schema and role preservation

The actual patients table was inspected: `id`, `email`, `password_hash`,
`full_name`, `date_of_birth`, `phone_number`, `created_at`, `updated_at`. The
unique canonical email constraint, hash-format check, indexes and updated_at
trigger already support this phase. No columns, migration files, role changes
or grants were needed. The applied initial migration remains byte-for-byte
unchanged. All 14 table and 55 index identities remain intact.

Queries use the existing restricted runtime pool as `health_wallet_app`.
Migration tooling retains `health_wallet_migrator` credentials separately.
Neither the application nor authentication modules import the migration pool.
The previous 19 schema and 15 security tests remain unchanged and passed.

## Endpoint contracts

All mutation bodies require `Content-Type: application/json` with UTF-8 JSON.
Unknown fields, extra query parameters, non-object bodies and malformed fields
are rejected. The existing 100 KiB JSON limit remains in place. Responses under
auth/profile routes use `Cache-Control: no-store`.

### POST /api/v1/auth/register

Required: `email`, `password`, `full_name`. Optional: `date_of_birth`,
`phone_number`. A profile name is required because the existing column is NOT
NULL/nonempty. Optional fields default to NULL. Email is trimmed and lowercased.
Registration creates an account; the separate login endpoint authenticates it
and issues an access token. No email verification or automatic login is added.

```json
{
  "email": "synthetic.patient@example.invalid",
  "password": "<15-128 character passphrase>",
  "full_name": "Synthetic Patient",
  "date_of_birth": "2000-02-29",
  "phone_number": "+92 300 1234567"
}
```

Success: HTTP 201.

```json
{
  "success": true,
  "patient": {
    "id": "<server-generated-uuid>",
    "email": "synthetic.patient@example.invalid",
    "full_name": "Synthetic Patient",
    "date_of_birth": "2000-02-29",
    "phone_number": "+92 300 1234567",
    "created_at": "<UTC timestamp>",
    "updated_at": "<UTC timestamp>"
  }
}
```

Duplicate canonical email: HTTP 409, `REGISTRATION_CONFLICT`, with generic text
`Unable to register with these details.` The uniqueness constraint is authoritative,
including concurrent attempts; there is no pre-insert identity-existence race.
The distinct conflict status inherently reveals that these registration details
cannot be reused. This requested behavior is documented rather than claiming
that registration prevents all account enumeration.

### POST /api/v1/auth/login

```json
{
  "email": "synthetic.patient@example.invalid",
  "password": "<registered passphrase>"
}
```

Success: HTTP 200.

```json
{
  "success": true,
  "access_token": "<signed-access-token>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

Unknown identity and incorrect password both return HTTP 401 with exactly
`INVALID_CREDENTIALS` / `Invalid email or password.` Unknown accounts still
perform a real Argon2id verification against an ephemeral cost-matched dummy
hash. Known and unknown paths share lazy dummy initialization. This reduces
large timing differences; it is not a claim of constant HTTP response time.
Malformed inputs return 400 independently of account existence. Only Argon2id
credentials created by this phase are accepted; malformed/unsupported legacy
hashes cannot authenticate and return the same generic failure. No legacy
account/password migration was needed or attempted.

### GET /api/v1/patients/me

Requires `Authorization: Bearer <access-token>`. Returns HTTP 200 with the same
sanitized `patient` object shown above. The patient UUID is taken exclusively
from the verified JWT subject. There is no endpoint accepting a target patient
ID; query parameters cannot select another profile. No password hash is selected
by profile queries or included in responses.

### PATCH /api/v1/patients/me

Requires the same Bearer authentication. Send one or more permitted fields:

```json
{
  "full_name": "Synthetic Updated Patient",
  "date_of_birth": null,
  "phone_number": null
}
```

Success: HTTP 200 with the updated sanitized profile. The existing trigger
maintains updated_at. NULL explicitly clears optional fields; omitted fields
remain unchanged. Email, password, password_hash, patient_id, id, role,
created_at, updated_at and every other unknown field are rejected, even when
mixed with an otherwise valid update. Changing identity credentials is not a
profile mutation in this phase.

## Field validation

| Field | Rules |
| --- | --- |
| email | String, trimmed/lowercase, at most 254 characters and 64 local-part characters; structural ASCII email validation with valid domain labels; no repeated/leading/trailing local-part dots. No address-ownership or deliverability claim. |
| password on registration | 15–128 Unicode code points, at most 512 UTF-8 bytes; non-whitespace content; not a single repeated character; no ASCII control characters. No forced composition rules, trimming, normalization or silent truncation. |
| password on login | Nonempty string within the same upper bounds/control-character restrictions; registration minimum is not used to reveal credential history. |
| full_name | Trimmed string, 1–120 Unicode code points, no ASCII control characters. Required on registration, optional but non-NULL in PATCH. |
| date_of_birth | NULL or a real calendar date in YYYY-MM-DD format, year at least 0001, not later than today's UTC date. No medical age/eligibility inference. |
| phone_number | NULL or trimmed string, at most 25 characters with 7–15 digits; optional leading + and spaces/parentheses/hyphens. Structural contact validation, not phone verification. |

## Authentication design and configuration

`config/auth.ts` uses the existing environment loader through `config/env.ts`.
It loads no migration credentials. A secure JWT secret was generated into the
existing ignored backend/.env without displaying it or changing DB settings.
The file retains mode 0600. Placeholders only appear in .env.example.

| Variable | Local default and meaning |
| --- | --- |
| JWT_SECRET | 32–64 securely random bytes encoded as 64–128 hexadecimal characters. Required, never a source-file constant. The format/basic-diversity guard does not prove entropy; generate it with a cryptographic RNG. |
| JWT_ALGORITHM | HS256; other values are rejected. Signing and verification both use this explicit allowlist. |
| JWT_EXPIRES_IN_SECONDS | 900 (15 minutes); validated range 60–3600. |
| JWT_ISSUER | ai-health-wallet-api; verified on every token. |
| JWT_AUDIENCE | ai-health-wallet-patient; verified on every token. |
| ARGON2_MEMORY_KIB | 65536 (64 MiB); permitted 19456–262144. |
| ARGON2_TIME_COST | 3; permitted 2–10. |
| ARGON2_PARALLELISM | 1; permitted 1–4. |
| AUTH_HASH_CONCURRENCY | 2 hash/verification requests in flight per application instance; permitted 1–8. Overflow returns 503 instead of unbounded expensive work. |
| AUTH_RATE_LIMIT_WINDOW_MS | 900000 (15 minutes); permitted 1000–3600000. |
| AUTH_RATE_LIMIT_MAX | 20 requests per IP for the shared registration/login budget; permitted 1–1000. Both successful and failed requests reaching the limiter count. |

Hashing uses Argon2id with a library-generated random salt, PHC encoding and
32-byte output. Configured cost settings are represented in the stored hash.
Native hashing is asynchronous, and concurrent work is bounded. No plaintext
password is persisted. JWTs contain only sub, iat, exp, iss and aud, no email,
profile, password hash or clinical content. Verification requires all these
claims, the configured algorithm/issuer/audience/type, a UUID subject, integer
timestamps, valid expiry and age, and a lifetime no longer than configured.
Missing, malformed, unsigned, expired, premature, wrongly signed or tampered
tokens return the same 401 response. Tokens in request bodies/query parameters
are not authentication credentials.

Login limiting uses express-rate-limit's process-local memory store and standard
rate-limit/Retry-After headers. The application explicitly leaves trust proxy
false; arbitrary X-Forwarded-For values do not change the client's limiter key.
IPv6 handling is delegated to the maintained library. Do not turn on blanket
proxy trust when deploying. Malformed JSON is rejected by the bounded parser
before reaching route-level limiting and cannot trigger password hashing.

## Error responses

```json
{
  "success": false,
  "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid email or password." }
}
```

| HTTP | Examples |
| --- | --- |
| 400 | INVALID_INPUT, INVALID_BODY |
| 401 | INVALID_CREDENTIALS, UNAUTHORIZED |
| 404 | PROFILE_NOT_FOUND for a valid token whose subject no longer exists; NOT_FOUND for absent routes |
| 409 | REGISTRATION_CONFLICT |
| 413 | BODY_TOO_LARGE |
| 415 | UNSUPPORTED_MEDIA_TYPE, INVALID_BODY for unsupported encoding/charset |
| 429 | RATE_LIMITED with Retry-After |
| 503 | AUTHENTICATION_BUSY when hashing capacity is exhausted |
| 500 | INTERNAL_ERROR; no raw database, hashing, stack or request details |

Database health retains its pre-existing generic HTTP 503 response on failure.
The central error handler prevents body-parser snippets and driver details from
being serialized. No request/password/access-token logging was added.

## Dependencies and source files

Three direct dependencies were added, with package-lock.json updated:

- argon2 0.45.1: maintained Argon2id hashing, verification and PHC handling with
  bundled TypeScript types. Native prebuilt hash/verify was executed successfully
  under the existing Node.js 24 runtime.
- jose 6.2.13: maintained ESM JWT signing/verification and explicit claims/algorithm
  validation, with bundled types.
- express-rate-limit 8.7.1: Express-compatible IP limiter with IPv6 handling and
  standard response headers; no custom password-attempt store or new DB table.

Existing dependencies handle Express, JSON parsing and PostgreSQL. Field
validation is small and explicit; no separate validation library was needed.
Npm reported zero vulnerabilities at installation time. It warned that Argon2's
optional install/build script was not preapproved in allowScripts; its shipped
prebuilt binding passed native hashing/verification without running an extra
script. Other platforms may need review/approval of that package's native build
step; no unrelated install scripts were approved.

Created: src/config/auth.ts; src/http/errors.ts; src/auth/middleware.ts,
passwords.ts, tokens.ts, routes.ts, auth.test.ts; src/patients/validation.ts,
repository.ts; and this document. Modified: src/app.ts, src/server.ts,
backend/package.json, package-lock.json, .env.example and the ignored backend/.env.
All src paths above are relative to backend/. Existing schema/security tests,
SQL migrations, provisioning, pools, DB credentials, SRS and Docker files remain
unchanged.

## Verification and actual results

Executed from backend:

```sh
npm install argon2@0.45.1 jose@6.2.13 express-rate-limit@8.7.1
npm run typecheck
npm run auth:test
npm run db:test
npm run db:security:test
npm run build
```

On 2026-10-20 (Asia/Karachi):

- Authentication/profile suite: 29 passed, zero failed/skipped. Covers real HTTP
  registration and login, duplicate/racing registration, validation, real hash
  verification/cost, standard and malicious JWTs, profile mutations, forbidden
  fields, patient A/B isolation, parameterized hostile-looking strings, bounded
  hashing, rate limiting/forwarded-IP spoofing, sanitized failures, secrecy and
  unchanged health endpoints.
- Existing schema suite: all 19 passed. Existing security suite: all 15 passed.
  Their files were not changed or weakened for this phase.
- Final typecheck and production build passed. The initial typecheck caught
  widened Argon2 option types; a readonly literal option object corrected it
  without changing the algorithm or cost values.
- Compiled-server checks rejected invalid secret, algorithm, token duration and
  hash-cost configuration with safe startup messages. Valid compiled startup,
  health requests, anonymous-profile rejection and graceful SIGTERM shutdown
  were also checked with an isolated loopback process.
- Final preservation audit found unchanged object identities, initial migration,
  pools, migration/provisioning code, previous tests, SRS, infrastructure files
  and DB credentials. No schema change or extra grants were introduced.
- Synthetic identities used random UUID-based example.invalid emails and known
  synthetic profile information. The suite confirmed those identities absent
  before authorizing cleanup, then deleted only those exact email identities in
  finally blocks. No broad reset/delete was used. Final patient count was zero.
- The JWT secret remains ignored/private and absent from tracked/nonignored
  source; no hashes or passwords appeared in API responses. Access tokens appear
  only in the intended successful login response, never logs or documentation.

## Remaining production decisions and boundaries

This is a verified local implementation, not a production release approval.
Review token lifetime, signing-key rotation, HTTPS termination, trusted-proxy
configuration, secure mobile/client token storage, password cost benchmarks,
shared/distributed rate limiting and retention before deployment. A shared IP
budget may affect legitimate patients behind NAT and does not stop distributed
credential attacks. The in-memory limiter resets on restart and is not shared
across instances. Hash concurrency and Argon2 memory costs need capacity testing.

Access tokens have no refresh/logout/revocation service in this phase; a stolen
token can remain valid until expiry or a signing-key rotation. Password reset,
email/phone verification, identity-email changes and breached-password checking
were not added. These remain explicit scope/security decisions, not silently
implemented authentication products.

Profile APIs enforce token-derived patient identity with WHERE id = $1 on every
read/update. The shared DB role still has the approved CRUD privileges on all
application rows, so DB roles alone do not provide per-patient read isolation.
No new RLS policy is claimed. Future record APIs must independently apply the
same authenticated ownership checks and approved production privacy controls.
Local runtime/owner secrets remain under the same OS user as documented in
Phase 1.4A; production must isolate migration credentials from runtime deployments.

References: [node-argon2](https://github.com/ranisalt/node-argon2),
[jose](https://github.com/panva/jose),
[express-rate-limit configuration](https://express-rate-limit.mintlify.app/reference/configuration),
[OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
and [authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

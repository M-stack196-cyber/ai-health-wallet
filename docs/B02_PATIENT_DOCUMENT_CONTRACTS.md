# B02 — Patient and document contracts v1.1

Date: 2026-10-23 (Asia/Karachi). Applies to `/api/v1`; authority remains SRS v3.0.
This is an implementation contract, not an SRS amendment or production authorization.
The SRS and migrations 0001–0004 are unchanged. No new dependency is required.

## Scope and source mapping

B02 implements/qualifies the backend obligations of FR-001–010, NFR-01/02/07,
CFG-03/12; §§3.1/3.2, 5.2, 7, 11.1, 14.1 and 14.2. Detailed tracking:
TRK-5.2-01/03, TRK-7-01, TRK-14.1-01/02 and TRK-14.2-01/02/05;
UC-01/02/03, AT-01/02/03/14 and V-01/02/03/04/07.
TRK-14.2-04 date/fallback data remains compatible with B07/B18. Full-stage failures,
retries and aggregate completion (TRK-14.2-03) remain B03/B06/B09/B17 obligations.
Doctor grants/revocation remain B13/B14; mobile interface acceptance remains B18.
No full FR, V or end-to-end release status is upgraded merely by these API tests.

## Reused implementation and resolved gaps

Reused: Argon2id, strict JWT claims/authentication, explicit profile projections,
patient-scoped parameterized repositories, existing category/date validation,
Busboy bounded multipart parsing, PDF.js/Sharp integrity validation, private S3
checks, bounded original reader, conditional upload, compensation/read-back,
processing-job trigger and disabled processing defaults.

The material security gap was the public `/download` response: authorization
preceded issuance of a transferable S3 bearer URL. Now the API sends original bytes
only after authentication, owner-scoped lookup, private bounded acquisition and a
second owner/storage-identity check immediately before delivery. URLs/keys/bucket
names are not returned. The S3 adapter's low-level signer remains for compatibility
and existing adapter tests; no patient route or document service publishes it.

GET profile/document reads now reject unexpected request bodies rather than silently
ignoring selectors or commands. Existing query/body allowlists remain in force.
Download rate limiting is patient-scoped, independent of IP spoofing. New failure,
resource-bound and cancellation tests qualify the file contract; a disposable-DB
test explicitly establishes repeat-upload semantics and one queued job per document.

## Patient API contracts

All responses use `Cache-Control: no-store`; JSON failures use
`{success:false,error:{code,message}}` with controlled messages, never raw driver
errors, credentials or medical contents. Password/hash fields are never projected.

| Method/path | Accepted input | Success | Principal failures |
| --- | --- | --- | --- |
| POST `/auth/register` | JSON email, password, full_name; optional date_of_birth, phone_number | 201, `{success:true,patient}` | 400 invalid; 409 normalized-email conflict; 415 wrong media type; 429 rate limit |
| POST `/auth/login` | JSON email/password only | 200, bearer access_token, token_type, expires_in | 400 invalid; 401 same invalid-credentials response for unknown email/wrong password; 429 |
| GET `/patients/me` | Bearer JWT; no query/body | 200, own explicit profile | 401 invalid/missing JWT; 404 missing profile; 400 query/body |
| PATCH `/patients/me` | Bearer JWT; nonempty JSON allowlisted profile patch | 200, own profile | 400 protected/unknown/invalid fields; 401; 404 |

Email is trimmed/lowercased and uniquely constrained. Registration passwords are
not trimmed or truncated: 15–128 Unicode code points, at most 512 UTF-8 bytes,
no controls/all-identical characters. Names are trimmed, nonempty and bounded.
Birth date is an actual `YYYY-MM-DD` calendar date, not future-dated. Phone is
optional/nullable, bounded to 7–15 digits with accepted formatting. Profile patches
may change only full_name/date_of_birth/phone_number; email, owner and credentials
cannot be changed through this contract. Nullable fields can be explicitly cleared.

JWT issuer, audience, type, algorithm, subject and bounded issued/expiry claims are
verified. Authentication limits/password-work concurrency stay unchanged. Registration
conflict is not treated as a successful retry or followed by an automatic login.
No password-reset, account deletion or new session-revocation feature is inferred.

## Document API contracts

Every operation requires a verified patient JWT; identity comes only from its subject.
No patient selector or client storage reference is accepted. Unknown, foreign-owned
and malformed document IDs yield identical `404 DOCUMENT_NOT_FOUND` envelopes after
authentication. Invalid query/body shapes are rejected before repository/storage work.

| Method/path | Accepted input | Success |
| --- | --- | --- |
| POST `/documents` | Multipart: exactly one file, category, hospital_name, optional document_date | 201 `{success:true,document}` |
| GET `/documents` | Optional limit, offset, category, hospital, uploaded_from, uploaded_to | 200 documents plus `{limit,offset,has_more}` pagination |
| GET `/documents/:id` | No query/body | 200 explicit public document projection |
| PATCH `/documents/:id` | Nonempty JSON category/hospital_name/document_date patch only | 200 explicit public projection |
| GET `/documents/:id/download` | No query/body; authenticated fetch | 200 original binary, attachment headers; no redirect or JSON URL |

Public document fields: id, original_filename, file_type, category, hospital_name,
document_date, uploaded_at, processing_status, sort_date, sort_date_source.
No owner ID, bucket, object key or internal storage/processing token is projected.

Allowed files: PDF/JPG/JPEG/PNG with matching extension/MIME/signature and full
bounded parser/decode checks. Empty, corrupt, unsupported, excessive-page/pixel,
active-JavaScript/attachment PDF and oversized inputs fail before S3 writes. Temporary
upload files are private and disposed on success, failure, timeout and disconnect.
Category is explicitly patient-assigned from `lab_report`, `prescription`,
`other_medical_document`, validated in API and SQL, editable/filterable. No automated
medical classifier or fact catalogue is claimed. Hospital is required on new upload;
legacy nullable rows remain readable. Known document date is separate from immutable
upload time; unknown date is omitted on upload or null in JSON patch, never invented.

Hospital filter is exact case-insensitive equality, not full-text search. Upload-date
bounds are inclusive UTC dates. Category is exact enum equality. Limit defaults to
20 (1–100), offset to 0 (0–10000). Array/duplicate/unknown query keys and impossible
calendar dates are rejected. Ordering is document date else UTC upload date descending,
then upload timestamp descending and ID ascending; fallback source is explicitly labelled.
Offset pagination is deterministic for a fixed dataset, not a snapshot cursor under
concurrent uploads/metadata edits. No cursor/semantic search is invented here.

## Authenticated file delivery and resource behavior

**Intentional v1 security correction:** consumers previously expecting
`{download_url,expires_in}` must now fetch this same endpoint with a Bearer header and
consume bytes. There is no unprotected URL, query-token alternative or signed fallback.
No implemented frontend is changed. `HEAD` follows the same authenticated path but
returns no body; partial/range responses and conditional cache reuse are not provided.

The existing `readOriginal` validates the configured bucket/key/prefix, expected owner,
private bucket settings, encryption, content type/length, source version/ETag and any
returned full-object checksum, then writes an exclusive private file. API delivery
checks a regular non-symlink, caller-owned 0600 file with matching bounded byte count.
It rechecks owner and unchanged bucket/key/type before sending any bytes, including
for failed/processing documents: extraction failures must not remove original access.

Successful headers: exact MIME, Content-Length, safe attachment Content-Disposition,
`X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. No Location header.
A per-router bounded admission count covers acquisition, response streaming and cleanup.
The existing maxConcurrentUploads/maxFileBytes/uploadTimeoutMs values also bound file
delivery, with separate upload/download counters. Deadline/disconnect aborts acquisition
and streaming, closes the file and removes only the owned temporary directory.
The initial ownership query separately retains existing pool query/acquisition deadlines.
No existing S3 original or database row is removed by file delivery.

Rate limit uses uploadRateLimitMax as the conservative independent per-patient download
budget per 15 minutes. Busy responses are 503 DOCUMENT_DOWNLOAD_BUSY with Retry-After;
rate limits 429 DOWNLOAD_RATE_LIMITED; invalid/unavailable original 503
DOCUMENT_STORAGE_UNAVAILABLE. Errors before headers use safe JSON. After streaming
starts, failure terminates the connection; clients must not accept truncated bodies.
A fresh delivery requires a fresh authorized request. Already delivered bytes cannot
be recalled. This patient path is not proof of future doctor grant/in-flight revocation;
B14 must provide current grant authorization at every protected operation.

## Duplicates, failures and lifecycle

Registration is protected by normalized-email uniqueness, including concurrent requests.
Repeated metadata patches set the same allowlisted fields without changing ownership,
upload timestamp, storage location or processing state. Repeated successful uploads
are deliberately separate original records with separate IDs/keys and exactly one
initial pending processing job each. No content deduplication or upload Idempotency-Key
contract is claimed. Do not automatically retry an ambiguous upload/registration.

Conditional S3 uploads never overwrite an existing object. Compensation targets only
a new unlinked upload. Ambiguous DB writes are read back before deletion; if read-back
is unavailable, preserve the private object for reconciliation. Existing linked originals
are never deleted to make an upload retry succeed. Existing compensation is unchanged.

`processing_status=completed` still means extraction-stage completion, not a generated
summary, index or guardian email. Upload queues a job; B02 starts no consumer. Existing
processing/retry APIs and pipeline semantics are not rewritten or newly activated.

## Controlled parameters and release limits

Preserve current defaults: 5 MiB/file (configurable 1 KiB–20 MiB), two upload slots,
15-second upload/file-delivery deadline, 5-second validation deadline, 16M image pixels,
100 PDF pages, 20 upload attempts per 15 minutes. New file downloads use those same
conservative quota values; defaults are not an invented clinical/release approval.
CFG-03 final deployment quotas require owner/operations review and B19 load evidence.
CFG-12 retention/deletion/legal approval remains pending; no destructive endpoint is
added. Clinical/Privacy/Operations appointments and SRS architecture amendments remain
pending exactly as recorded in B01. Unrelated offline work need not wait for them.

## Verification and next gate

Direct fake test command (no .env or database import):

```bash
cd backend
npm run contracts:b02:test
```

Existing database suites must run only through the reviewed isolated harness:

```bash
cd backend
npm run integration:summary-db -- --execute-isolated
```

That command creates disposable resources; it is not a command to run against development.
It uses PostgreSQL16, fresh synthetic credentials, no published ports, network isolation,
mocked S3 and exact owned-resource cleanup. No application worker or live cloud is started.
The interrupted first B02 harness attempt is not counted as a pass; read-only reconciliation
found no created container or tagged image. Final measured results belong in the B02
validation receipt and dated status/traceability addenda. Historical B01 pins/receipt are
preserved: deliberate B02 source drift is expected and must not rewrite B01 history.

B03 requires separate approval. It must retain this authenticated file contract, ownership,
compensation, pending approval gates and disabled defaults. No live S3 file streaming,
mobile deployment, broader processing or clinical/production qualification is claimed here.

## Executed qualification results

Final disposable PostgreSQL16 run: **726 passed**, no failures/skips/cancellations.
This includes **270 backend tests** (19 schema + 15 database security + 29 auth +
45 document/storage + 162 processing; previous 269 plus one repeat-upload check),
24 B02 checks, 37 runner safety checks, 32 Stage A, 20 Stage B, 259 Stage C,
11 Stage C DB and 73 summary DB checks. Both disabled entries, typecheck and
production build passed inside the isolated container.

Separately, **876 offline regressions passed** (341 Python + 510 TypeScript +
25 baseline-tool checks), with shared-contract compatibility/typecheck/build/disabled
checks; final 24 B02 checks also passed independently. These suites overlap: do not
add their totals and call the result distinct product requirements or unique tests.
The earlier cancelled run and failed test-timing attempt are retained as non-passing
evidence. No production/source security protection was relaxed to obtain the pass.

The final run removed both owned containers, its volume and image; independent
checks confirmed absence. The separately verified dependency-cache tag was removed
by exact identity. All five pre-existing containers remain present; their last
start/stop transitions predate the run (two running, three previously stopped).
No development PostgreSQL connection or AWS request was made. Public-source hashes,
final executable-source/snapshot agreement and receipt/log digests are recorded in
`baselines/B02_VALIDATION_RECEIPT.json`.

**DoD:** the four core backend-contract conditions are satisfied in isolation.
Approval-dependent deliverables (final CFG-03 quotas and CFG-12 privacy/retention),
live delivery and complete client/release acceptance remain open; B02 is not an
unconditional production qualification. Separately approved offline B03 work may
proceed while those release gates remain explicit.

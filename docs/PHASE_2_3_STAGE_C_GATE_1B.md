# Phase 2.3 Stage C — Gate 1B offline credential adapters

## Scope

Gate 1B adds explicit system-file credential loading and synthetic-file tests.
There is no production caller, credential installation, systemd execution,
AWS request, PostgreSQL connection, environment edit or processing activation.
Existing developer AWS/DB loaders, approval verifier, user/system supervisors,
patient/cutoff SQL, leases and disabled entry remain byte-identical.

Reviewed before implementation: integration/aws-preflight.ts, config/env.ts,
integration/guards.ts, processing/background-config.ts and background-runtime.ts,
stage-c/private-files.ts, safety.ts, and system supervision/proof definitions.

New files:

- backend/src/stage-c/credential-files.ts
- backend/src/stage-c/system-credentials.ts
- backend/src/canary-checks/credentials.check.ts
- docs/PHASE_2_3_STAGE_C_GATE_1B.md

No dependencies or package scripts change. The existing explicit Stage C fake-test
glob includes the new checks. The production build emits corresponding JS/maps.

## Explicit selection and fallback prevention

selectCredentialLoading accepts an explicit system-files selection or delegates
an absent/exact developer selection to an injected developer loader. Existing
callers are not switched to this selector. No legacy default changes.

A malformed system selection, including missing mode, is refused rather than
routed to developer loading. File mode requires explicit filesystem dependencies,
root directory policy, separate file SHA-256 pins, expected owners/modes, a
validated Gate 1A SystemPlan and fixed canary scope/cutoff. It never reads
process.env, developer home, .env, AWS INI defaults, instance/container/web-identity
providers or credential processes. Failures never invoke the developer callback.

There is no default filesystem selected by the loader. nodeCredentialFileSystem
is an explicitly constructed, Linux-only adapter; construction opens nothing.
Tests inject it only for newly generated synthetic files and use decorated ports
for ownership and race simulations. No actual credential path is configured.

## Protected files and reads

The explicit credential directory basename must equal the plan's exact worker
unit name. Directory policy requires independently expected ownership and exact
0500 or 0700 mode. Each fixed-name file requires independently expected ownership,
exact 0400 or 0600 mode, one hard link, regular-file type and a separate SHA-256.
The actual systemd credential-mount UID/modes must be verified at a later gate;
the loader never guesses owners from the files it is being asked to trust.

The Linux reader traverses from an open root directory through pinned directory
handles using /proc/self/fd, O_DIRECTORY and O_NOFOLLOW. Leaf access adds
O_NONBLOCK so a substituted FIFO cannot block before type verification. Symlinks
and unsafe ancestor ownership/writes fail; only root-owned sticky /tmp is allowed
as a writable shared ancestor for synthetic fixtures. No ancestor exception is
added for developer home or arbitrary sticky directories.

Owners/modes/types are checked before reading contents. Reads are bounded at
16 KiB AWS, 8 KiB PostgreSQL and 4 KiB approval, with an extra byte to detect growth.
Before/after stat identity, size, nanosecond modification/change times, pathname
identity and all ancestor bindings are compared. Device/inode checks reject
replacement even with identical bytes. Every handle is closed on all outcomes;
close failures also refuse success. Parent directory link-count changes are not
used as identity changes, because unrelated sibling directories can change them.

Loaded bundles pin initial file identities, recheck all three files before
returning any subsequent credential options and serialize concurrent validation.
A failed recheck permanently invalidates that bundle; restoring bytes does not
silently authorize retry. A separately approved restart can construct a new
bundle using the same reviewed bytes/pins and fixed cutoff, with independently
verified new runtime ownership. There is no automatic credential rotation.

## File envelopes and binding

Files are flat UTF-8 JSON objects with exact keys and integer/string values.
Duplicate keys, escaped duplicate aliases, nested objects, invalid UTF-8, unknown
fields, oversized inputs and malformed JSON are refused. No values appear in
parse errors. Exact file names:

| File | Version / kind | Additional fields |
| --- | --- | --- |
| aws-profile.json | 1 / health-wallet-aws-profile | profile, account, region, bucket, prefix, accessKeyId, secretAccessKey; optional sessionToken |
| postgres-password.json | 1 / health-wallet-postgres-password | host, port, database, user, password |
| processing-approval.json | 2 / health-wallet-processing-approval | mode, patientId, uploadCutoff, profile, account, region, bucket, prefix |

Every envelope also requires run and deploymentSha256. The deployment identity
is SHA-256 of a deterministic JSON structure with schema
health-wallet-credential-deployment/v1, releaseDirectory, and all six Gate 1A
artifact [role, path, SHA-256] triples in artifactRoles order. This binds executable
pins as well as the deployment-manifest pin. It is computed from independently
supplied deployment expectations, never adopted from observed credential contents.
The complete deployment inventory/native dependency verification remains separate.

AWS metadata must exactly match profile ai-health-wallet, account 402909940531,
region ap-southeast-2, bucket ai-health-wallet-records-402909940531 and prefix
medical-documents/. Delegation, default-profile and custom endpoint fields are
not allowed. This is offline metadata validation, not proof of actual AWS identity
or IAM scope. Fresh execution of all seven AWS checks remains a later gate.

PostgreSQL options pin 127.0.0.1:5433, database ai_health_wallet and role
health_wallet_app. The password is loaded directly into connection options; there
is no connection-string, environment or subprocess-argument construction.
No authentication, actual role privileges or live connection is tested here.

Approval version 2 binds the same run/deployment, exact canary patient and canonical
fixed upload cutoff, target and canary mode. Its file has its own independent pin.
The legacy version-1 owner-0600 verifier remains unchanged and does not silently
accept this format. Boot/invocation-specific supervision evidence is still required
separately; credential envelopes intentionally do not pin one worker invocation,
so the same approved cutoff/bytes can survive an authorized sequential restart.

## Secret handling and integration contracts

The returned bundle exposes methods, not public secret fields. awsCredentials
returns an explicit SDK credential identity; databaseOptions returns complete
nonempty target/password options; assertUnchanged is an admission/restart guard.
None constructs a client or executes an operation. There is no AWS CLI adapter.

All file-mode exceptions are replaced by a fixed CredentialFileError without
underlying cause, filesystem text, parsed values or path echo. There are no logging
or receipt-writing calls. Bundle and option objects redact ordinary JSON and
Node inspection views. Returned options keep normal enumerable credential fields
for SDK/pg compatibility. Future trusted consumers must never log individual
fields or spread/copied option objects: the redaction hooks cannot prevent a
consumer deliberately extracting strings. JavaScript secret strings are not
promised to be securely zeroed from memory.

Future composition must pass the explicit AWS provider to SDK clients, fixed
region/owner/endpoint settings and explicit PostgreSQL options. It must reject
unsupported ambient provider/driver overrides before constructing those clients,
retain non-sensitive structured errors, and attach unchanged checks to existing
admission/profile/approval boundaries. No default chain or developer loader may
be used if file-mode verification fails. These integration calls are not added
in Gate 1B.

## Verification

All tests use generated random synthetic values in private temporary directories.
No real credential data is read, copied, installed or printed. Source snapshots
for regressions exclude .env and developer credential directories.

- New Gate 1B checks: 75 passed.
- Stage C aggregate: 259 passed (184 existing, including Gate 1A, plus 75).
- Stage A regression: 32 passed.
- Manual integration-runner safety: 37 passed.
- Total: 328 passed, zero failures/skips/cancellations.
- TypeScript typecheck and production build: passed.
- Disabled compiled-entry smoke in the credential-free snapshot: passed.

Coverage includes optional session credentials, exact targets, malformed/duplicate
JSON, delegation refusal, missing files/values, permissions/owners, leaf/ancestor
symlinks, hardlinks/types, independent hashes, run/deployment/cutoff mismatch,
in-read and post-load changes, replacement inode/ancestor, sticky failure,
concurrent checks, restart consistency, default delegation and redaction.

The sandbox maps root-owned directory metadata to UID 65534. Initial sandbox-only
file tests correctly refused the root guard; no security condition was relaxed.
Successful fixture tests ran as the ordinary host user with correct UID metadata
and the test runner's local IPC permission. One automatic permission review timed
out before execution; the permitted retry succeeded. No sudo was used. Initial
TypeScript test annotations were corrected before final verification.

The 269 database-backed tests and Stage B PostgreSQL suites were not run, because
Gate 1B prohibits database access. Earlier database results are not counted here.

## Remaining work / next approval boundary

A later integration gate must separately approve:

1. A reviewed private deployment manifest and credential-source provisioning model,
   service UID/mount/permission verification, and secure LoadCredential injection.
   Do not copy complete .aws/.env/home directories or change existing credentials.
2. A private pin/config reader and explicit file-mode composition after disabled,
   scope, cutoff, runtime authorization and system-supervision proof gates. Preserve
   legacy mode and the API path. Do not treat parsing these files as activation.
3. A system-manager OS transport/receipt writer, fresh bound-pair/controller-loss
   acceptance, and enforceable PG/S3 networking. Gate 1A still has injected ports
   only. Ordinary option redaction is not a substitute for safe downstream logs.
4. Isolated DB/mock-S3 validation of unchanged patient predicates, lease fencing,
   retries/cancellation and end-to-end secret-provider use; no development DB.
5. Separately approved read-only live account/bucket checks, synthetic seeding,
   exact approval-file provisioning, and finally narrowly scoped activation.

Protected evidence, patient/document rows, S3 objects, migrations, IAM, roles,
configuration and credentials are preserved. No cleanup, deployment, broader
processing, commit, push or later phase is performed.

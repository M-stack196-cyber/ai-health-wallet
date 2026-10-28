# Phase 2.3 Stage B — isolated PostgreSQL verification

Explicit command: `npm run integration:stage-b -- --execute-isolated` from backend.
The controller creates uniquely labelled disposable containers/volumes and never
runs mutation tests on the host. The internal `processing:service:db:test` command
requires a private container identity, loopback-only interfaces/routes and an
exact disposable database marker before fixture writes.

PostgreSQL 16 uses none networking and internal loopback port 5433. Node shares
only its network namespace. No host ports, host networking, privileged access,
Docker socket, development sockets/volumes/credentials, home directory, AWS
profiles or protected evidence enter the containers. PostgreSQL is bounded to
1 CPU/512 MiB/128 PIDs and Node to 2 CPUs/3 GiB/256 PIDs. Node drops all
capabilities; PostgreSQL retains only filesystem/user initialization capabilities.
Suites have five-minute deadlines; container execution has a 30-minute bound.

The image is built offline with network none from explicitly selected installed
Node/npm, Git, cp/env/shell, Tesseract/English data, Poppler, prlimit, DejaVu/font
configuration, backend node_modules and required dynamic libraries. Tool hashes,
Node version and lockfile SHA-256 are retained. No npm dependency is added and
no home/OS tree is copied. A stalled registry-image preparation was stopped before
any container creation. Offline execution avoids external dependency downloads
but does not establish reproducibility of a fresh npm registry installation.
The existing local postgres:16 image is required; host mutation fallback is absent.
Optional `STAGE_B_DEPENDENCY_CACHE` points only to a private prior Stage B run.
Reuse requires matching Node version, lockfile and every recorded tool/library
fingerprint, plus matching immutable image ID/run-label provenance. It re-tags
only that dependency image; new source, credentials, containers and database are
still created. This is not a production flag or a bypass of isolation checks.
The runner has a bounded 256 MiB private /tmp tmpfs for unprivileged processing.

An allowlisted disposable backend source snapshot has a temporary Git repository
and fresh synthetic runtime/migration/bootstrap/JWT secrets in private ignored
files. Actual development configuration is never copied or overwritten. Database
and role names match legacy assertions but reside in a separate cluster with
different credentials. An identity file and random database COMMENT bind each
test run. The reviewed role SQL runs only in that cluster; the development-targeted
provisioning script is never called. Unchanged 0001 is applied with its ledger,
then restricted ownership/grants, then existing migration tooling applies
unchanged 0002/0003. Schema/security regressions verify checksums and privileges.

Production background-runtime.ts retains approval, exact-target/environment,
resource-limit, pinned profile and all seven AWS checks. Shared composition is
extracted to background-runtime-core.ts. Tests exercise that same coordinator,
admission/query handling, scheduler and cleanup against real PostgreSQL with
explicit fake S3 dependencies. There is no production bypass flag or test mode.
The production entry point is invoked only explicitly disabled.

New tests cover SQL cutoff/owner boundaries, historical exclusion in discovery
and recovery, metrics, simultaneous claims, real row locks, DB-clock retries
and elapsed lease expiry, stale-token rejection, atomic competing persistence,
fixed-cutoff restarts, approval tampering, coordinator contention/termination,
cancellation, bounded admissions, graceful drain, health/log privacy, and genuine
digital PDF, PNG and mixed PDF extraction through a mocked S3 client. Original
bytes, provenance, completed states, temporary paths and native children are checked.

Existing db:test, db:security:test, auth:test, documents:test, processing:test,
integration:s3-ocr:test and processing:service:test execute sequentially inside
isolation, followed by new PostgreSQL checks, typecheck, build and disabled smoke.
Expected old baseline is 338 (269 backend + 37 runner + 32 Stage A). Reports give
actual pass/fail/skip/cancel counts and exit status; failures stop execution.
Private logs are retained rather than streamed through the host console.

The private manifest identifies exact new container IDs, volumes, image and
snapshot paths. Cleanup rechecks identities/labels and excludes pre-existing
containers. Uncertain resources are left untouched and reported. No prune,
development compose/provisioning, AWS change or Gate 3 cleanup occurs. Redacted
results and preservation fingerprints remain available for review.

This tests isolated composition, not live AWS/IAM/S3 availability, deployment
capacity or automatic production activation. Approval-file security still trusts
an operator controlling both file and pin. Real deployment SIGKILL/power-loss
containment and live canary activation require subsequent review.

## Recorded execution

Successful run: stage-b-bcf2a47b40197c012791c3bd. All isolation checks, fresh
bootstrap, migrations/checksums and restricted-role checks passed. Database 19,
security 15, authentication 29, documents 44, processing 162, manual runner 37,
Stage A 32 and Stage B 20: **358 passed, 0 failed, 0 skipped, 0 cancelled**.
Typecheck, production build and explicitly disabled compiled entry passed inside
the disposable runner. Genuine digital PDF, PNG OCR and mixed-page extraction
all passed through mocked S3, including source hashes/provenance and cleanup.

Earlier preparation attempts stopped before any regression test ran: a stalled
registry build, unprivileged /tmp permissions, a dotenv package-layout mismatch,
and a dependency-image build reference mismatch. The dotenv attempt recorded
one failed bootstrap command; it is not counted as a passing test. Each affected
run retained its own failure receipt and removed its verified containers/volumes.
The final run completed the entire sequence. Final auditing confirmed no owned
containers, volumes or image tags remain from any attempt, and all original
container IDs are present. No broad cleanup or development database access ran.

The original migration/role SQL, 338 existing test assertions, API/OCR/storage
modules, development environment, AWS files and five Gate 2 evidence files retain
their original SHA-256 fingerprints. Only existing background-runtime.ts and
backend/package.json changed. Private Stage B receipts are preserved separately
under the project's ignored .private-evidence directory; no Gate 2 file is changed.

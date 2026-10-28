# Phase 2.3 Stage A — disabled background service

Stage A implements a separately invoked backend service. It is **not activated**,
does not import into API startup, and does not provision a cutoff, patient, job,
database object, IAM permission or AWS resource. No migration or dependency is
added. The SRS v3.0 upload/OCR/ownership requirements (§14.1–14.3, V-05/V-06)
remain the scope; this is operational scheduling, not AI analysis.

## Commands and configuration

`npm run processing:service` is an explicit standalone entry; `npm start` and
`npm run dev` retain their existing behavior. Production compilation emits
`dist/processing/background-entry.js`, separate from `dist/server.js`.
Default `PROCESSING_SERVICE_ENABLED=false` returns before runtime imports,
database pools, AWS requests, job operations, timers or health listeners. Dotenv
loads the existing backend `.env` convention; this alone constructs no client.
Do not enable or launch a real worker during Stage A.

Enabled startup requires all of the following, for a later separately approved
activation: `PROCESSING_SERVICE_ENABLED=true`, `PROCESSING_SERVICE_MODE=canary`,
explicit `PROCESSING_CANARY_PATIENT_ID`, fixed `PROCESSING_UPLOAD_CUTOFF` in
canonical millisecond UTC, absolute `PROCESSING_APPROVAL_FILE`, independently
pinned `PROCESSING_APPROVAL_SHA256`, and the existing exact personal AWS/database
environment. There is no unrestricted/global mode or automatic cutoff fallback.
Existing environment guards reject ambient credential overrides and default
profile selection. Static named-profile credentials are pinned in memory and
file hashes are rechecked. All seven existing read-only AWS checks must pass
before a database pool is constructed. No AWS preflight was executed in Stage A.

Profile `ai-health-wallet`, account `402909940531`, region `ap-southeast-2`, bucket
`ai-health-wallet-records-402909940531`, prefix `medical-documents/`, and AES256
remain fixed. The runtime projects only original reading from the existing S3
adapter. Upload compensation, uploads, deletion and signing remain unchanged.

Service concurrency defaults to 1 (hard maximum 2) and must not exceed existing
OCR, PDF or retrieval admission settings. Polling defaults to 2000ms (1000–30000)
with up to 249ms jitter, capped at 30000ms. Worker unavailability causes bounded
backoff (at least 5000ms, at most 30000ms). A coordinator, approval or queue-check
failure stops admission entirely. Existing per-job exponential retries, maximum
attempts, DB timestamps, heartbeats, deadlines and resource limits are reused.
No resource limit is raised to satisfy concurrency.

## Durable cutoff without a migration

A later approval must provision a private, owner-controlled JSON file with
exact fields `version: 1`, `mode: "canary"`, `patientId`, `uploadCutoff`, `profile`,
`account`, `bucket`, `region`. The values must match the launch configuration and
fixed target. **No real approval file is created by Stage A.** No startup uses
the current time as a replacement cutoff. Choose and record the cutoff before
approved new uploads; previously uploaded documents must predate it. Persist
the same file and checksum across restarts, rather than recreating them.

The file must be a regular, single-link, owner-owned 0600 file in an owner-owned
0700 directory, with no symlink path components or writable ancestors (root-owned
sticky temporary parents are allowed for fake tests). Read is bounded to 4096
bytes through O_NOFOLLOW. Exact bytes are SHA-256 checked against the independent
launch pin, and scope/target are checked before startup and every SQL operation.
Use a persistent host directory outside the checkout, not a temporary directory
or protected Gate 2 evidence directory, for any later real approval file.
Changing the file, cutoff or patient alone fails closed; fake restart tests check
consistency. Protect the launch pin separately from the approval file. A user
able to change **both** pin and file, or replace the executable, remains trusted;
this is tamper detection within an operator-controlled boundary, not protection
against the same OS account. Signed/operator-owned deployment configuration and
OS isolation need review before unattended activation. No DB migration is
necessary for this file-backed Stage A mechanism. A future DB approval ledger
would require separate migration approval.

## SQL eligibility and claims

The existing repository gains an optional fourth argument: upload cutoff. It
requires the existing patient scope; legacy callers retain their parameter lists
and behavior. Each canary operation adds a parameterized EXISTS joining document
identity and patient, requiring the approved patient and
`eligible.uploaded_at >= $cutoff::timestamptz`. The filter precedes candidate
locking and bounded selection in claims and expired-job recovery. Discovery,
original resolution, heartbeat, failure, completion, persistence and completion
reconciliation also enforce it. Queue counts join the same owner/document and
apply the same patient/cutoff, due-time, state and attempt restrictions.
The dedicated canary adapter also rejects foreign claim rows before they can
reach the processor, and refuses construction without validated eligibility.

Thus pending/retrying/running historical jobs are excluded, including recovery;
merely pending is never sufficient eligibility. Patients beyond the explicit
scope are excluded. SKIP LOCKED, random per-attempt tokens, DB-clock leases,
deadline checks and the existing atomic extraction function remain authoritative.
The coordinator lock supplements these fences. Exactly-once computation is not
promised; stale-attempt persistence remains rejected.

## Coordinator, lifecycle and shutdown

A separate, checked-out PostgreSQL connection holds the fixed application-wide
two-integer session advisory lock until shutdown. Lock contention fails startup;
the connection is never returned to the pool while held. It is destroyed on
release. The independent service pool is bounded to concurrency + 3, with the
existing connection/query/statement timeouts. No transaction spans OCR.

The scheduler admits at most one runOnce per free slot; there is no prefetch or
overlapping polling callback. Every repository SQL query revalidates approval,
profile and ownership and pings the dedicated session. Error/end on that session
or idle-pool connection failure immediately stops admission and cancels work.
An SQL claim already in flight can commit during connection loss; no further
admission occurs and the cancelled attempt must expire/recover under its fence.

SIGINT/SIGTERM stops admission/readiness, then allows the configured drain
(default 30000ms; range 0–60000) with existing heartbeats. Afterwards it cancels
remaining work and waits for worker/retrieval/native cleanup before closing
health, unlocking and closing the pool. Cancellation is immediate on lock loss.
Original retrieval's own cleanup registry and native process-group termination
remain in use. No broad temporary-directory sweeper or protected-evidence cleanup
is added. No forced parent exit cuts short active cleanup; an uncooperative
dependency can consequently delay termination. Real OS supervisor/cgroup
containment and termination-budget verification remain prerequisites for later
unattended activation, especially SIGKILL/power-loss handling.

## Health and observability

The independent listener binds only `127.0.0.1`, default port 5001. GET `/live`
returns aggregate liveness, GET `/ready` reports admission readiness (503 during
startup/failure/shutdown), GET `/metrics` returns active, completed, failed, lost,
unavailable, idle and eligible-due queue counts. Other routes are 404 and non-GET
methods 405. There are no command endpoints. Responses are no-store with fixed
schemas, bounded connections and HTTP timeouts. Same-host callers remain trusted;
do not proxy these endpoints publicly. Readiness is sampled at polling cadence,
with immediate revocation on observed coordinator loss.

Logs contain only fixed `service` and allowlisted `event` values. Exceptions,
configuration, IDs, object references, extracted text and credentials are never
serialized. Aggregate counters reset on restart; there is no patient label or
persistent metrics/alerting platform in Stage A.

## Verification and limits

`npm run processing:service:test` runs only synthetic/fake tests, separate from
normal DB-backed suites. It exercises disabled startup, config/cutoff guards,
private approval files/restarts/tampering, repository SQL and historical/foreign
scope simulation, coordinator lock contention/loss, bounded scheduling,
shutdown/cancellation, real existing worker cleanup with fake retrieval, loopback
HTTP and safe output schemas. It uses no AWS, real PostgreSQL, real OCR or medical
records. SQL capture and fake concurrent admissions are not PostgreSQL concurrency
proof; actual DB locking/cutoff tests require a separately approved isolated DB.

The existing 269 backend tests are preserved but create patient/document/job
fixtures in PostgreSQL. Stage A's no-record-creation boundary prevents executing
them against the development database. Report them as not rerun; do not infer a
fresh 269-test pass. Run the existing 37 fake integration-runner checks, new fake
checks, strict TypeScript typecheck and production build. Record exact results
in the delivery report. No live preflight, S3/OCR processing, service activation,
cleanup, commit, push or later phase is authorized by these commands.

Before any activation, separately review a fresh synthetic scope and durable
cutoff, quiet-window preservation, isolated real-PostgreSQL race tests, OS resource
budget and supervisor behavior, monitoring access, and explicit write approval.
Shared application DB credentials remain a trusted boundary rather than tenant
RLS. Unsupported, corrupt, empty or oversized documents retain existing
allowlisted terminal/retry failure behavior and never fabricate OCR evidence.

## Stage A file inventory and recorded checks

Created under `backend/src/processing/`: `background-entry.ts`,
`background-runtime.ts`, `background-config.ts`, `background-repository.ts`,
`background-service.ts`, `background-coordinator.ts`, `background-health.ts`.
Created `backend/src/background-checks/background.check.ts` and this document.
Modified only the pre-existing `backend/src/processing/repository.ts`,
`backend/package.json`, and `backend/.env.example`. Build outputs under the
existing ignored `backend/dist/` directory are regenerated by TypeScript.

Recorded fake verification: **32 Stage A checks passed**, **37 integration-runner
checks passed**, strict typecheck passed, production build passed, and compiled
disabled-entry smoke check exited with only a disabled event. The 269 existing
DB-backed tests were not rerun under the no-record-creation restriction.
Baseline SHA-256 comparisons confirm all original source tests, API startup,
OCR/worker/storage modules, migrations, infrastructure, runtime `.env`, AWS files,
lockfile and five protected evidence files are unchanged. Evidence retains
private permissions and Git exclusion. No live DB/AWS preservation query was
needed or executed; no live DB/AWS access occurred during this work.

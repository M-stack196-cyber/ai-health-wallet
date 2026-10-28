# Phase 3A.3 — immutable summary sources and fenced jobs

## Scope

Reviewed SRS v3 FR-015/016 and §§14.3/14.4, migrations 0001–0003, extraction payload
and persistence fences, existing summary schema, shared contracts and Phase 3A.1/
3A.2 documents. No API route, model adapter, polling service, listener or startup
hook is added. FastAPI and background processing remain disabled. No development
DB, AWS, S3, real patient data, credentials or systemd operations are required.

## Forward-only migration 0004

0004_medical_summary_jobs.sql extends ai_report_summaries and adds:

- summary_source_snapshots: immutable text, extractor/version, source metadata,
  extraction identity, processing attempt and claim token, source fingerprint.
- medical_summary_jobs: immutable source/pipeline/catalogue/input authority plus
  pending/running/retry_wait/completed/failed/cancelled/superseded state, attempts,
  retry schedule, random lease, lease expiry, hard deadline and completion token.
- ai_report_summaries nullable V1 fields: snapshot/job bindings, input/source/
  pipeline fingerprints, structured output, provenance and accepted attempt/token.

Legacy rows remain unchanged with V1 fields NULL. No backfill or enqueue trigger
is added. New summaries have composite job/snapshot/document/patient ownership.
A new extraction identity unique constraint supports the snapshot composite FK.
All new FK prefixes are indexed. Restrictive references retain history.
New snapshots permit SELECT/INSERT only; jobs SELECT/INSERT/UPDATE only for the
existing application role. Existing object privileges, roles and IAM are unchanged.
Functions use invoker security and fixed search_path; PUBLIC execution is revoked.
No extension is required: PostgreSQL 16 built-in SHA-256 is used.

Snapshots and job authority fields cannot be rewritten. Accepted V1 summaries
cannot be updated/deleted; legacy summary CRUD remains compatible. Changing an
extraction keeps snapshots/history intact. No down migration or automatic cleanup.

## Snapshot and input authority

captureSnapshot(documentId) is explicit and always scoped to the repository's
required patient UUID. Only completed document + completed OCR job + completed
extraction with matching non-NULL attempt/claim association can become a source.
Legacy/unassociated, pending/running, foreign and oversized sources fail closed.
Summary source size is 32 KiB UTF-8; OCR's existing larger limit is unchanged.

The DB source fingerprint hashes a versioned-use JSON array of extraction ID,
exact text, metadata, extractor version, attempt and claim token. The SQL function
itself is the algorithm definition; it uses JSONB's representation, not the
cross-language contract canonicalizer. Reprocessing identical bytes with a new
attempt/token still produces a distinct source. Existing snapshots are immutable.

Source locking follows OCR order: OCR job, extraction, document. Shared row locks
prevent source replacement while snapshot capture/enqueue/publication commits.
No OCR state is modified by summary code. Eligibility is rechecked by SQL at
capture/enqueue, discovery/claim, generation read, heartbeat, recovery and publication.

A trusted caller obtains the snapshot, builds a reviewed catalogue using its
opaque snapshot ID for evidence source_ref, and explicitly enqueues that snapshot
with facts and a pipeline recipe. No automatic catalogue builder is added. Never
accept catalogue authority from a patient/model. Input scopes use job UUID,
snapshot UUID and a random opaque 256-bit binding, not a patient ID or JWT.
Metadata/text hashes, page method/count, original SHA and extraction attempt are
reconstructed from the snapshot. Strict V1 validators check all evidence.

Canonical input TEXT and its SHA-256 are immutable. Source data and catalogue
fingerprint are rechecked before generation/publication. Pipeline configuration
contains the existing provenance recipe without input_sha256; its fingerprint is
SHA-256 of pipeline_config::text in PostgreSQL. A unique source/pipeline pair
reuses one job. A changed catalogue under that pair yields CONFIG_CONFLICT, never
a silent rewrite or extra publication. Different source/pipeline versions can
create new jobs. Re-enqueue of terminal jobs returns their existing state; it
does not reset attempts or grant unlimited retries.

## Repository operations and lifecycle

createSummaryJobRepository receives a database dependency, mandatory patient scope
and bounded config. It imports no pool, environment, application startup or service
credential module. Operations: captureSnapshot, getSnapshot, enqueue, getJob,
discover, claim, generationInput, heartbeat, publish, fail, cancel, recover, summaries.
The DB port exposes only transactions/query/release, keeping fake tests simple.
Returned rows are internal sensitive objects: never log them or expose raw job
rows/tokens/canonical inputs through a future public API.

New jobs must start pending with zero attempts; direct completed/running inserts
are refused. Claims use a transaction with FOR UPDATE OF j SKIP LOCKED and DB-clock due-time
checks. Each successful claim increments a stored bounded attempt count and uses
crypto.randomUUID() as its attempt-specific lease. A unique partial index allows
exactly one running summary job globally across all instances. Claim contention
returns idle without exposing the competing patient. An expired running job must
be explicitly recovered by its patient-scoped repository before another scope
can run; this conservative head-of-line blocking is intentional at this stage.

Defaults: 3 attempts (maximum 3), lease 15 seconds (20 ms–60 seconds), hard attempt
60 seconds (at least lease duration; maximum 5 minutes), exponential retry base
1 second, cap 30 seconds (maximum 5 minutes), recovery batch 20 (maximum 50).
Heartbeat extends only a live matching lease and never the hard deadline. Recovery
uses DB time and SKIP LOCKED, scopes every mutation and either schedules a retry,
marks exhausted work failed, or marks changed-source work superseded. Cancellation
is terminal and immediately revokes a running lease. No scheduler or background
heartbeat loop is activated by this stage.

Generation happens after generationInput returns and its read transaction closes.
No database transaction is held while waiting on a fake/remote model. There is no
model access in this repository. A future executor must heartbeat and cancel
cooperatively, then pass the untrusted candidate back for independent publication.

## Atomic publication and history

publish locks the scoped live job, locks/rechecks the current source, parses and
revalidates the stored input, and applies existing strict output grounding and
provenance validation. It computes deterministic rendering locally. Only then
is one completed V1 summary inserted. A guarded job update rechecks lease expiry/
deadline with database time and atomically completes the job in the same transaction.
No provider callback executes inside that transaction.

Database triggers independently fence source/ownership/token/attempt/recipe and
completion transitions. A deferred constraint rejects a summary insert that tries
to commit without matching completed job state. Unique job and source/pipeline
publication indexes reject duplicates. Any exception, lost lease or expiry during
publication rolls back the transaction. Tokens are cleared on terminal/retry state;
completion_token remains only as historical exact-attempt proof.

Successful summaries are append-only. Later failed jobs cannot overwrite them.
Retrieval is patient/document scoped, bounded to 50 entries, and computes is_current
against the present extraction. Superseded accepted summaries remain completed
history with is_current=false. Legacy summaries likewise have no V1 current-source
proof; clients must inspect contract version rather than treat them as V1 results.

## Privacy and trust limits

SummaryJobError contains fixed codes only: INVALID_INPUT, SOURCE_INELIGIBLE,
CONFIG_CONFLICT, INVALID_SUMMARY, LEASE_LOST, DATABASE_UNAVAILABLE. Stored attempt
failure codes are MODEL_FAILED, MODEL_TIMEOUT, INVALID_SUMMARY, LEASE_EXPIRED,
CANCELLED, SOURCE_SUPERSEDED. Driver exceptions/SQL/values/causes are not propagated.
There are no logging calls. Failed rollback discards the exact connection.

DB constraints validate relational/attempt/provenance integrity, not clinical
meaning. Shared application credentials remain trusted and retain legacy table
access; this is patient-scoped application isolation, not tenant RLS or a defense
against a compromised DB user/admin. Strict Node validators are required before
publication. Catalogue authoring, clinical review and real model safety remain
unimplemented. Snapshot retention increases sensitive text copies; encryption,
retention/deletion and restricted deployment access need review before real data.
Per-patient API throttling, operational executor supervision and broader concurrency
are future work. Fixed limits do not replace database capacity planning.

## Disposable PostgreSQL test harness

From backend, explicitly invoke:

```bash
npm run integration:summary-db -- --execute-isolated
```

The separate infrastructure/summary-db harness reuses reviewed Stage B isolation
checks and offline dependency-image builder. It copies only allowlisted source,
shared fixtures, dependency/runtime files; no developer .env or home is copied.
It creates random synthetic credentials under a private 0700 directory, private
0600 receipts and configuration files, an owned Docker volume and two owned
containers. PostgreSQL is cached version 16, with no published ports and network
none. The test container shares that private namespace, has no external routes,
no AWS directory or Docker socket, dropped capabilities and bounded CPU/RAM/PIDs.
It verifies version, database marker and restricted role before mutation tests.
Host PostgreSQL ports, roles, databases, containers and records remain untouched.

Legacy fixture rows are seeded under migration 0001, before 0003/0004. Tests then
apply the unchanged migration prefix plus 0004 with the isolated migration identity,
run existing database/security/auth/document/OCR tests, Stage A/B/C regressions,
summary DB tests, typecheck/build and the disabled startup smoke. Normal API or
production database migration commands are never used on the host by this harness.

Cleanup verifies manifest IDs, run labels and disjointness from all pre-existing
containers. Only exact owned containers, volume and image are removed; no prune,
force removal or production/evidence cleanup. If Docker cleanup is ambiguous,
receipts mark failure. infrastructure/summary-db/cleanup.mjs can perform bounded
ownership-verified reconciliation using the exact private manifest:

```bash
node infrastructure/summary-db/cleanup.mjs --manifest /tmp/EXACT-RUN/manifest.json --approve-test-cleanup
```

This command is exclusively for disposable harness resources, never Stage C/live
records or Phase 2.2D evidence. Diagnostic outputs remain private; stdout exposes
only aggregate receipts. Evidence is retained after resource cleanup.

Host offline commands, from backend or project root as appropriate:

```bash
npm run summaries:jobs:test
npm run summaries:contracts:test
SUMMARY_TEST_PYTHON=/path/to/test-venv/bin/python npm run summaries:service:test
python3 ai-service/tools/generate_contracts.py --check
/path/to/test-venv/bin/python -m unittest discover -s ai-service/tests
npm run typecheck
npm run build
```

No new Node/Python dependencies or changes to existing migrations are required.
Read-only documentation reference: https://www.postgresql.org/docs/16/explicit-locking.html
and https://www.postgresql.org/docs/16/functions-binarystring.html

## Next proposed Phase 3A.4 — separate approval

Implement patient-authenticated summary request/status/retrieval contracts and an
explicitly disabled orchestration/executor layer using the injected fake client.
Use this repository's snapshot authority, scoped claims, heartbeat/cancellation,
retry classification and atomic publication. Public responses must omit leases,
canonical inputs, scope tokens and raw driver errors. Test end-to-end with synthetic
records in disposable PostgreSQL and in-process/mocked service transport only.
No automatic historical backfill, development DB migration, real provider, AWS,
OCR activation, systemd/deployment change, clinical catalogue automation, RAG,
notifications or frontend activation. Any further schema migration, credential
provisioning or live/canary operation requires separate review and approval.

## Final verification record

- Existing backend: 269 passed (schema 19, security 15, authentication 29, documents
  44, processing 162) against disposable PostgreSQL with migration 0004.
- Existing manual runner 37, Stage A 32, Stage B 20, Stage C 259, Stage C DB 11.
- New summary DB suite: 41 passed (40 scenario checks plus parent).
- New fake repository tests: 21 passed.
- Existing Python contracts/service: 200 passed; TypeScript contracts 93 and
  mocked client/ASGI integration 33 passed.
- Total: 1,016 passing test executions, no skipped/cancelled checks.
- Shared generated contracts, TypeScript typecheck, production build and disabled
  compiled-entry smoke passed.

Early private runs exposed a temporary dependency symlink and a synthetic fixture
parameter-cast error. These were corrected; failed-run resources were reconciled
by exact identity. Final receipt locations and cleanup verification are reported
with delivery. No failed run is counted as successful. Source and migration hashes
are compared before installation, and only approved files are copied.

# Phase 3A.4 — patient summary APIs and isolated executor

## Scope and default state

Reviewed SRS v3 FR-015/016 and §§14.3–14.4; Phase 3A.1–3A.3 documents; existing
JWT middleware, document ownership repository, error envelopes, summary repository,
FastAPI wire contract and Node client. No migration, role, IAM, credential or
completed Stage C security module is changed. Existing schema 0004 is used only
inside newly created disposable PostgreSQL 16 test instances.

API route registration is part of Express createApp, but summary functionality
requires explicit server-side options. It defaults disabled; ordinary startup
never queries summary tables, builds catalogues or starts executors. The separate
executor defaults disabled, never imports the API or OCR runtime, and reads no
.env/credential file. No host/development/production processing is activated.

## Patient API contract

All three routes reuse requirePatient/createTokenService and patientIdentity.
Document operations use the existing createDocumentRepository.reference ownership
query and documentId validator. No new patient-authentication implementation exists.
Foreign and unknown documents have identical DOCUMENT_NOT_FOUND 404 responses.
Foreign, unknown and malformed job IDs have identical SUMMARY_JOB_NOT_FOUND 404s.
Authentication failures use the existing UNAUTHORIZED envelope. Every response,
including failures and rate limits, has Cache-Control:no-store.

| Endpoint | Request | Success |
| --- | --- | --- |
| POST /api/v1/documents/:id/summary-jobs | application/json, exactly {} | 202 new job; 200 equivalent existing job |
| GET /api/v1/summary-jobs/:jobId | No body or query | 200 scoped job status |
| GET /api/v1/documents/:id/summary | No body or query | 200 current accepted V1 summary, otherwise latest accepted V1 history |

Public job: {id, document_id, status}. Status is queued, processing, retrying,
completed, failed, cancelled or superseded. POST additionally returns existing
boolean. Public summary: {id, document_id, schema_version:1, text, generated_at,
is_current}. All successful envelopes have success:true. No result yields
SUMMARY_NOT_FOUND 404. Ineligible/unassociated/incomplete extraction yields
SUMMARY_SOURCE_NOT_READY 409. Unconfigured or failed server dependencies yield
SUMMARY_UNAVAILABLE 503. Errors retain {success:false,error:{code,message}}.

No patient ID, extraction body, prompt, model/provider choice, source reference,
scope token, JWT or object key is accepted in request JSON. Query parameters,
nonempty/array/null bodies and GET bodies are refused. The normal bounded Express
JSON parser/error handler remains unchanged. Public projections never serialize
repository rows, canonical input, extraction blob, scope/lease/publication tokens,
provider configuration, attempts, deadlines, source fingerprints or worker errors.
Summary text is the validated patient-facing rendering and can contain source
excerpts; it is sensitive intended output and must never be written to access logs.

Default per-patient quotas: five generation requests and 120 reads per 60 seconds,
with separate budgets. JWT verification precedes limiter keys. Document ownership
and job lookup occur before quota enforcement so foreign/unknown resources retain
identical 404s. These are per-application memory budgets; distributed quota storage
and an authenticated-not-found flood budget are future operational work.

## Catalogue authority, eligibility and idempotency

createApp accepts summaries:{enabled,database,catalogue,requestLimit?,readLimit?,
windowMs?}. Enabled mode requires both an explicit SummaryDatabase and synchronous
trusted catalogue callback. No automatic clinical parser is invented. The callback
receives a cloned snapshot; enqueue independently reloads/revalidates database
snapshot authority and grounding. It must return reviewed source-anchored facts;
never implement it with request data or allow a model to certify its own evidence.
Tests supply synthetic golden catalogue entries only. Missing configuration fails
closed rather than treating whole extracted reports as automatically trusted facts.

Only explicit patient POSTs capture eligible completed extraction snapshots and
enqueue jobs. No upload trigger, historical backfill or API-triggered processing
loop exists. The server fixes the pipeline to the current synthetic fake recipe.
Clients cannot reset failed jobs or select a new model/pipeline to bypass limits.

Idempotency is durable, natural and patient-scoped: the existing immutable snapshot
and pipeline unique pair. enqueueWithOutcome shares the original enqueue operation
and returns its transactional insert outcome; enqueue retains its original return
type and behavior. Simultaneous requests have exactly one 202 creator and reuse
the same job thereafter. No client-controlled Idempotency-Key store or new schema
is introduced. A changed catalogue for the same source/pipeline refuses silently
replacing authority. Reprocessing creates a new source only on another explicit POST.

GET summary prefers current accepted V1 history, retaining the last accepted V1
result with is_current:false when its extraction is superseded. Legacy rows without
V1 validation proof are never promoted through this endpoint. Later generation
failures do not remove successful history. Reads do not recover jobs or start work;
expired job status remains its recorded state until controlled executor recovery.

## Separate executor and client changes

createSummaryExecutor receives a scoped existing repository and the existing
injected Node client. Repository patientScope must match the explicit executor
scope, and each claimed row's ownership is checked again before any model call.
The database's global one-running-job constraint and per-instance admission flag
prevent overlapping claims. runOnce is an explicit manual/test operation; start
begins polling only on an explicitly enabled injected instance. Neither is invoked
by Express or the OCR worker.

Defaults: enabled=false, heartbeat 1 second, local attempt budget 5 seconds,
poll interval 1 second, drain budget 1 second; concurrency is fixed at one. Options
are bounded and patient scope is required in enabled mode. Repository DB leases,
hard deadlines, retry caps and source fences remain authoritative. Choose heartbeat
interval below the configured repository lease; a lost/expired heartbeat cancels
work and cannot publish. The scope never discovers/recover/claims OCR jobs.

Workflow: scoped recover -> scoped claim -> close generationInput transaction ->
verify the configured fake recipe -> fake client generation -> independently
fenced publication. There is no model callback in a transaction. Heartbeats never
overlap each other; outstanding DB heartbeat work and underlying client I/O block
new admissions. Publication now accepts an optional AbortSignal and rechecks it
around source locking, insertion and completion; an observed abort rolls back the
transaction with PUBLICATION_INTERRUPTED rather than accepting cancelled evidence.
Commit/network ambiguity is still resolved by durable job/publication state.

Client changes are backward compatible: activeRequests exposes a local aggregate
for draining, and errors carry a safe retryable boolean. 408/429/5xx and transport
failures are transient; authorization/contract 4xx are permanent. Existing fixed
codes/messages remain unchanged and remote bodies are never echoed.

Transient/timeouts and shutdown interruptions spend the attempt and schedule bounded
retries through the repository; invalid grounding/configuration is permanent.
Lost tokens/source replacement cannot publish. Cancellation aborts the client,
stops new admissions and drains cooperatively within a bounded budget. A false
drained result is a safety stop, never a successful cleanup claim. Observer events
are an allowlist of fixed aggregate strings, with no IDs, medical text, exception
payloads or credentials. Observer failures are suppressed without logging detail.

## Entry point and activation boundary

npm run summaries:executor runs src/summaries/executor-entry.ts. Disabled execution
emits only a fixed disabled event and loads no database, AWS or service credential.
Enabled selection requires all of:

- SUMMARY_EXECUTOR_ENABLED=true
- SUMMARY_EXECUTOR_MODE=injected-fake
- SUMMARY_EXECUTOR_PATIENT_ID=<explicit UUID>

launchSummaryExecutor additionally requires an injected reviewed composition
factory and accepts an AbortSignal for controller/shutdown cancellation. It starts
only that explicit fake runtime. The CLI deliberately has no live/default runtime
composition: setting flags alone fails configuration before credential/DB access.
Use the injected launcher/core only in the approved isolated harness at this stage.
No dynamically imported arbitrary runtime module, real HTTP transport, dotenv
fallback, automatic role provisioning or production process supervisor is wired.
Signal/process-supervision and real credential/runtime wiring require a later
separate deployment approval; no completed Stage C module is changed.

Cooperative fake transport is the security assumption of this stage. Uncooperative
I/O cannot be force-killed inside JavaScript; its client slot remains occupied,
stop reports incomplete drain, and this executor refuses further admissions. Lease
fencing still prevents stale publication. Physical cross-process containment and
elimination of abandoned external work require independently verified supervision
before any real-provider execution. No native subprocess is launched by the executor.

## Testing and isolated commands

Existing infrastructure/summary-db is extended only to include the disabled summary
entry smoke check. Its existing test glob includes lifecycle.check.ts. The harness
uses network-none PostgreSQL 16, no published host ports, a private shared container
namespace, synthetic credentials/rows, mock FastAPI transport and exact-resource
cleanup. Existing development PostgreSQL, roles, ports, records and evidence are
not mounted, queried or changed. No live AWS/provider or systemd call is performed.
Synthetic Express listeners bind only the disposable container's loopback.

```bash
# From backend: no live activation commands.
npm run integration:summary-db -- --execute-isolated
npm run summaries:jobs:test
npm run summaries:contracts:test
SUMMARY_TEST_PYTHON=/path/to/test-venv/bin/python npm run summaries:service:test
npm run typecheck
npm run build
SUMMARY_EXECUTOR_ENABLED=false node dist/summaries/executor-entry.js
```

Python shared contract/service tests use the existing temporary virtual environment
and unittest discover. No new Node/Python dependencies or lockfile changes.

Verified final results: existing backend 269; runner 37; Stage A 32; Stage B20;
Stage C259; Stage C DB11; summary DB73 (41 existing and 32 new API/executor);
repository units21; new executor units25; TS contracts93; Node client33; Python200.
Total 1,073 test executions, with typecheck/build/compatibility and both disabled
entry checks. Final isolated receipts confirm all suites passed with no skipped/cancelled checks.
Failed earlier runs are not counted as passed. The initial new suite exposed a test's incorrect 400 expectation
for the established malformed-resource 404 convention; this was corrected with
uniform summary-job 404 envelopes. The Phase 3A.1 blanket ban on API summary
imports was updated to permit authorized route registration while retaining explicit
executor/startup and OCR/Stage C separation checks.

## Remaining limits and Phase 3A.5 evaluation proposal

This is not a clinically evaluated summarizer or live deployment. A reviewed
catalogue provider, distributed rate controls, retention policy, tenant DB-role
hardening/RLS and production transport/runtime supervision remain separate work.
Single running-slot recovery is intentionally patient-scoped; abandoned work in a
different approved scope can block admission until its scoped recovery runs.

Proposed Phase 3A.5: freeze a synthetic evaluation corpus and expected source-linked
facts; evaluate omissions, unsupported claims, negation, exact measurements/units,
conflicts, Unicode citations, OCR uncertainty, prompt injection and cross-patient
privacy end-to-end. Add reproducible scoring, model/recipe version baselines and
API/executor failure/drain evaluation using injected fake/adversarial providers in
disposable infrastructure. Define clinical-review criteria and provider privacy/
retention requirements. Do not assume authorization for real hosted calls, real
patient data, development migration/activation, deployment, RAG or frontend work.

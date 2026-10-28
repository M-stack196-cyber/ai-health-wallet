# Phase 3A.2 — private fake-provider summary service

## Scope and reviewed basis

Read SRS v3 FR-015/016, §§8.1/14.3/14.4; Phase 3A.1 documentation, shared schemas,
Python and TypeScript validators; Node app/auth/document/processing architecture.
This stage adds a FastAPI factory and injected Node client, not deployment or an
API-server route. No listener, global ASGI app, provider SDK, database/S3 client,
job completion capability or OCR activation is added. Existing API startup,
Stage C, schemas, validators, migrations and credentials modules are unchanged.

## Files

- ai-service/summary_service/{__init__,app,protocol,provider,workflow}.py
- ai-service/requirements.txt and requirements-service-test.txt
- ai-service/tests/test_service.py
- ai-service/tools/service_fixture_bridge.py (synthetic fixture-only test utility)
- backend/src/summaries/client.ts
- backend/src/summary-checks/client.service.ts
- backend/package.json: one new summaries:service:test command
- This document

## Factory and wire protocol

Use create_app(ServiceConfig(...), provider=...) with explicitly injected values.
ServiceConfig.enabled defaults to False; no environment/credential loader is used.
Disabled requests return SERVICE_DISABLED without reading bodies or invoking the
provider. Import/factory creation never binds a socket or starts a worker. There
is no default provider or transport, no CLI launcher and no uvicorn dependency.
Only POST /internal/v1/report-summaries:generate is registered. OpenAPI, docs,
ReDoc, slash redirects, health/metrics endpoints and debug pages are disabled.

Body: exactly SummaryInputV1 JSON (no wrapper). Content type must be application/json
or application/json; charset=utf-8. Duplicate keys/malformed Unicode/numeric tokens
and unsupported contract fields are rejected by the existing strict parser.
Patient IDs, JWTs, S3 object keys, source paths, job commands and completion fields
have no request-schema field. Unknown x-summary-* metadata is refused. Query
parameters and compressed bodies are rejected. No semantic scan can prove that
arbitrary source text contains no identifying content; real records are out of scope.

Required headers, supplied by the trusted Node authorization/snapshot layer:

| Header | Authority |
| --- | --- |
| Authorization | Bearer service token; synthetic lowercase 64-hex value in tests |
| X-Summary-Request-Id | Expected request UUID |
| X-Summary-Source-Ref | Expected opaque source UUID |
| X-Summary-Scope-Token | Expected opaque scope binding, not a patient JWT |
| X-Summary-Input-Sha256 | Independently pinned canonical input fingerprint |

Authorization compares SHA-256 digests of complete headers with hmac.compare_digest
(fixed 32-byte operands). Missing/duplicate/oversized/invalid authorization fails
before body reading or provider admission. Config repr excludes tokens; errors
never include values. No real token file or developer secret is read. Context
headers are covered by service authentication but do not independently prove
patient ownership. The future Node patient-scoped repository must supply them
from its authorized immutable snapshot, never from patient/model authority.

Success: canonical JSON SummaryOutputV1 only, with Cache-Control:no-store and
X-Content-Type-Options:nosniff. Deterministic rendering is validated but not added
as an unsupported extra response field. Error envelope:

    {"schema_version":1,"error":{"code":"UNAUTHORIZED"}}

Service codes: SERVICE_DISABLED (503), UNAUTHORIZED (401), BUSY (429),
INVALID_REQUEST (400/415), SOURCE_TOO_LARGE (413), DEADLINE_EXCEEDED (504),
CANCELLED (499 for an observed disconnect), SERVICE_FAILURE (502), NOT_FOUND (404),
METHOD_NOT_ALLOWED (405). Existing contract failure codes return 422 except size
refusals. Unexpected framework failures use generic SERVICE_FAILURE (500).
No error echoes a source, identifier, URL, header, exception or validation path.

## Bounded workflow and immutable authority

The straight-line workflow has five states and one candidate:

1. Strict parse and SummaryInputV1 validation against independent context.
2. Capture a private validated snapshot and server-owned fake recipe.
3. Call injected ModelProvider.generate with separate source/recipe copies.
4. Validate the untrusted candidate with existing grounding/provenance/measurement
   rules against the original snapshot and recipe.
5. Validate deterministic rendering and return canonical SummaryOutputV1 bytes.

DeterministicFakeProvider copies all catalogue facts and uses the existing
expected_metadata helper; it does not add competing medical validation logic.
No catalogue builder, free-form clinical interpretation, agent tool, database
handle, persistence API or job state is provided to the provider. Prompt injection
has no workflow authority; existing adversarial fixtures must still fail grounding.
The fixed fake recipe binds pipeline, prompt hash, provider/model/revision and
input fingerprint. Python/Node recipe agreement is checked through actual ASGI
responses, not just copied test expectations.

No retries, workflow loops or persistent checkpoints exist. LangGraph/LangChain
and hosted models remain deferred until a workflow actually needs them and their
privacy/dependency policy is approved; this deterministic stage requires neither.
The SRS retrieval/agent architecture remains a later integration requirement.

## Limits, cancellation and shutdown

- Shared caps unchanged: source 32 KiB, input 256 KiB, output 128 KiB, render 32 KiB.
- Request header budget 8 KiB; body/frame and Node response-chunk budgets 10,000.
- Default concurrency 1; explicitly configurable 1–4; no waiting queue.
- Default end-to-end service deadline 2 seconds; configurable 0.01–10 seconds,
  including body receipt. Expired/disconnected work is cancelled, never retried.
- Default shutdown drain 0.1 seconds; configurable 0.01–1 second. Lifespan exit
  closes admission and cancels body-reading requests plus active provider tasks.
- Node defaults: disabled, concurrency 1, timeout 2000 ms; configurable 1–4 and
  10–10,000 ms. Response streaming is bounded before strict parse/validation.

Timeouts return promptly without awaiting uncooperative cancellation forever.
Admission remains occupied until outstanding code exits. Results produced after
cancellation/deadline are discarded, never treated as a success. Task exceptions
are consumed without logging payloads. No child/native process is launched by the
service workflow. The test bridge launches only an owned synthetic interpreter.

These are cooperative async bounds, not an OS sandbox: synchronous malicious
provider code could block an event loop, and Python cannot force-kill a coroutine
that suppresses cancellation. The fake provider is cooperative. An untrusted or
real provider requires separately reviewed process/deployment isolation, shutdown
receipts and resource enforcement before activation. Limits are per instance;
no multi-process coordinator or distributed rate limiter is implemented here.

## Privacy and Node integration

No body/access logging, tracing callbacks or checkpoints are installed. FastAPI
0.158.1 native tracing, metrics, logs, operation spans and auto-configuration are
explicitly disabled; the transitive OpenTelemetry API is not an exporter and no
SDK/exporter is installed. Tests verify these switches. Existing/global external
instrumentation cannot be made safe by this module: future deployment must exclude
body/header capture and disable server/proxy access logs and sensitive tracing.
TLS/private networking, service credential provisioning/rotation and firewalling
are deployment gates. An internal URL prefix alone is not network isolation.

createSummaryClient defaults disabled and requires an injected SummaryTransport
when enabled. No fetch, URL resolver, default HTTP client, environment fallback,
credential loader or automatic retry exists. Its only request path is the fixed
internal endpoint. The client copies/validates input/context, supplies independent
scope headers, bounds I/O with AbortSignal/deadline/admission, then strictly parses,
grounds and renders the response locally against its own retained snapshot/recipe.
Remote error bodies and arbitrary transport errors are never echoed. Client codes
are CLIENT_DISABLED, INVALID_CLIENT_CONFIG, INVALID_REQUEST, BUSY, CANCELLED,
DEADLINE_EXCEEDED, REMOTE_FAILURE and INVALID_RESPONSE. The transport must honor
abort and release resources; a stalled transport retains capacity. No normal API
module imports or invokes this client in this stage.

## Dependencies and offline commands

Runtime direct pins: fastapi==0.158.1 (factory/routing), starlette==1.9.0 (tested ASGI
behavior), pydantic==2.14.1 (FastAPI dependency; not a replacement for shared strict
validators). FastAPI's transitive packages include typing helpers, AnyIO and the
OpenTelemetry API. No server executable, model framework or provider dependency.
Test-only httpx==0.28.1 provides ASGITransport; existing jsonschema==4.10.3 remains
an independent compatibility checker. Node adds no dependencies or lock changes.

A temporary Python virtual environment was used. Dependency installation contacted
package infrastructure only; all tests use synthetic data and no network services.
For a fresh isolated test environment (installation may require package-network access):

```bash
python3 -m venv /tmp/health-wallet-summary-tests
. /tmp/health-wallet-summary-tests/bin/activate
python -m pip install -r ai-service/requirements-service-test.txt
python -m unittest discover -s ai-service/tests
python ai-service/tools/generate_contracts.py --check
cd backend
npm run summaries:contracts:test
npm run summaries:service:test
npm run typecheck
npm run build
```

The virtual environment's python3 must be on PATH, or set SUMMARY_TEST_PYTHON to
its absolute interpreter for Node's synthetic ASGI bridge. The bridge refuses
bodies outside known golden synthetic fixtures and has no listener. Python service
tests forbid socket.connect. Node client tests use injected mocks; the bridge
runs HTTPX entirely in-process. No development .env is copied into test snapshots.
The existing summaries:contracts:test command retains its original file pattern
and behavior; the service suite is separately selected by *.service.ts.

## Verification

- Python: 200 passed (90 existing contracts; 110 new service checks).
- Node: 93 existing contract checks and 33 new client checks passed.
- Existing offline regressions: Stage C 259, Stage A 32, manual integration 37.
- Total: 654 passing test executions; no database-backed suite is counted.
- Shared generator/schema compatibility, Python compilation, TypeScript typecheck,
  production build and disabled-entry smoke checks passed.

Coverage includes 70 shared golden/adversarial fixtures through the endpoint,
authentication/duplicate headers/constant-time comparison, source references,
numerical/citation changes, unsupported identifiers, provider mutation/failure,
malformed/oversized/slow/empty-chunk bodies, disconnect/cancellation, admission,
timeouts including uncooperative cancellation, normal/exceptional shutdown,
privacy-safe errors and all 10 golden fixtures through Node-to-ASGI integration.
Database-backed tests were not run because PostgreSQL access is prohibited here.

## Phase 3A.3 recommendation — separate approval

Start with an offline repository/job design and an isolated disposable PostgreSQL
implementation only. Review the existing ai_report_summaries schema first; obtain
explicit migration approval before schema changes. Define patient-scoped immutable
extraction snapshots/catalogue authority, versioned structured-output persistence,
job/input/recipe idempotency, retryable vs terminal failure states, lease-fenced
atomic completion and stale/source-replacement invalidation. Persist only locally
validated output/rendering/provenance; a provider never owns job completion.
Test cross-patient denial, concurrent claims, restart/retry, stale completion,
transaction rollback and deletion/revocation behavior using synthetic rows and
fake service responses. Keep the development DB, real providers, automatic OCR,
Stage C/security modules, AWS, deployment credentials and activation out of that
initial gate. Clinical catalogue validation and hosted-model evaluation remain
separate prerequisites for real-patient release.

References: https://fastapi.tiangolo.com/advanced/async-tests/
https://www.starlette.io/middleware/
https://pypi.org/project/fastapi/

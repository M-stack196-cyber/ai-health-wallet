# Phase 3A.5C — offline local Ollama adapter

## Scope and unchanged behavior

Reviewed SRS v3 (FR-015/016, §14.3), Phase 3A.5A/5B documents, frozen data,
Python ModelProvider/workflow, shared validation, evaluator and benchmark ports.
This stage adds explicit Python composition only; no CLI enables inference.
FastAPI still selects the fake recipe/provider, OfflineSession still permits only
synthetic-offline, and existing one-second/five-second service/test deadlines are
unchanged. No Node application, database, OCR, executor, supervision or credential
modules are changed. No dependencies, packages, models or services are installed.

## Composition and trust boundaries

`OllamaLocalProvider.generate(source, recipe)` implements the existing provider
port. Its constructor is disabled by default and requires an injected HTTP transport,
fresh trusted HostAdmission checker, independently verified TokenAccountant, and
independently pinned template/parameter SHA-256 values. None have permissive defaults.
`OllamaBenchmarkBridge` implements BenchmarkProvider using the existing request/reply
contracts; `OllamaBenchmarkSession` is independently disabled and requires the exact full
provider-identity fingerprint in a singleton allowlist. There is no registry/fallback.

Only exact source/provenance pairs compiled from H01–H12 are accepted. The provider
does not receive gold critical flags, evaluation expectations or repair instructions.
Recipe identity is trusted harness configuration, never learned from output.
The bridge calls the same Phase 3A.5A scorer; schema, grounding and semantic validity
remain separate. Unsupported grounded output is refused; omission/quality failures
are scored without repairs or retries. No arbitrary patient/file/API input is accepted.

`LoopbackHttpTransport` uses standard-library asynchronous streams with numeric
127.0.0.1 and fixed port 11434. Its own default is disabled. Only version/tags/show/chat
paths exist. It loads no credentials, uses no SDK/proxy environment, rejects configured
HTTP/HTTPS/ALL proxies and every redirect, and has no pull/download/cloud route.
Content-Length JSON framing is bounded; chunked/compressed/duplicate/unsupported
framing fails closed. Stream teardown is bounded. No transport or body logging exists.
Tests mock all HTTP and streams and prohibit real socket connection.

## Identity, output and reasoning

Exact target: Ollama 0.31.2, deepseek-r1:1.5b,
digest e0979632db5a88d1a53884cb2a941772d10ff5d055aabaa6801c4e36f3a6c2d7.
Version, exact local tag/digest, template/parameters, architecture and completion
capability are checked before and after inference; cloud metadata and an unpinned
system prompt are refused. Other installed models (including nomic-embed-text) are
not touched. Model tag checking is not immutable exclusive access to the model store;
the host checker must attest an exclusive, protected daemon/model environment.

Requests pin temperature 0, top-p 1, seed 0, CPU-only options, stream=false and the
existing SummaryOutputV1 schema (with its original definitions). The frozen prompt
is unchanged. `think=false` is sent only when metadata explicitly lists boolean false.
Missing thinking metadata is not treated as support for disabling reasoning.

Only the complete message.content JSON object is parsed. Separate thinking is discarded
before candidate validation, never returned or written. Empty/thinking-only content,
think tags, Markdown/prose wrappers, duplicate keys, tools, unknown fields, invalid
usage, oversized responses and non-stop/truncated responses fail closed. Validation
uses original quotations/UTF-8 offsets, exact decimal/unit/operator strings, source
hashes, scope, provenance and deterministic rendering. There is no JSON-fragment
extraction, unit normalization, numeric repair, gold completion or reasoning receipt.

## Separate local resource policy

- Concurrency one, no queue, maximum twelve attempts, no retry or fallback.
- Context exactly 4096; output at most 2048 tokens, including reasoning.
- At most two inference threads and num_gpu=0; one exclusive model session.
- Per-request deadline at most 180 seconds (including metadata/loading); run deadline
  at most 40 minutes. Tests can choose shorter bounded deadlines.
- Fresh admission before work, immediately before inference and after inference:
  at least 2 GiB available, observed daemon process tree at most 3 GiB, CPU-only,
  enough physical cores, loopback-only bind, cloud/telemetry disabled, exclusive daemon.
- Entire rendered prompt/template plus reserved output must fit 4096. A separately
  verified, digest/template/tokenizer-bound counter is mandatory. No byte-to-token
  approximation, truncation, chunking or automatic context expansion is supplied.
- External rates and spending cap are exactly zero. No provider credentials are read.

Timeout/cancellation permanently closes new admissions on the provider/session, consumes
the attempt, cancels async work and discards late results without waiting indefinitely
for a noncooperative fake transport. A closed HTTP connection is not proof the daemon
stopped generating. No automatic rearm, unload/kill, retry or reconciliation claim exists.
Future operation requires approved independent idle/containment verification.
keep_alive=0 requests normal release after each owned generation; it must not be used
on an unapproved shared daemon. RAM checks are admission observations, not cgroup hard
limits or continuous memory enforcement. OS resource containment remains a later gate.

## Private reproducible receipts

Versioned local-ollama-synthetic-benchmark receipts bind adapter code, full trusted
model identity, configuration, tokenizer/template/prompt/schema/fixture hashes,
evaluator version/hash and outcomes. They contain only fixed case labels, aggregate
scores, bounded codes, flags and trusted configuration; no source, quotations, scope
identifiers, credentials, candidate or thinking. Deterministic fake runs produce equal
receipts explicitly labelled offline-fake-transport/local_http_used=false; these are
not evidence of real DeepSeek generation. The local-loopback-http mode requires explicit
selection and the exact loopback transport type. Complete means all twelve were evaluated, not that they all passed.
The existing owned/private/exclusive receipt writer requires a 0700 parent and creates
0600 files without overwrite or final-component symlinks. Persist under the existing
Git-excluded .private-evidence directory; do not place receipts in tracked fixtures.

## Current limitations and next approval

No real Ollama request or compatibility measurement is made in this implementation.
The last reviewed daemon listener was *:11434, a live-execution blocker. Current cloud,
telemetry and outbound-network isolation have not been verified here. No real host
checker, deployed tokenizer implementation or runnable benchmark command is installed.
Injected checks are trusted code, not protection against malicious Python dependencies.
Metadata does not cryptographically prove the bytes used for a concurrently mutable
model store. Structured-output grammar support, HTTP framing, reasoning control,
throughput, token usage and RAM behavior still require separately approved verification.
The small quantized model may fail all strict cases; synthetic gold/glossary still need
independent clinical review. Nothing here authorizes real-patient or application use.

Next gate: approve offline implementation/review of the host-isolation checker and
version/model-bound rendered-prompt tokenizer, plus an exact synthetic execution
manifest/command. Separately approve any daemon configuration/restart needed for
loopback/local-only operation. Only after those safeguards are verified should a
separate approval authorize one H01–H12 generation pass. Do not enable FastAPI, OCR,
summary executors, AWS/PostgreSQL access, downloads or hosted fallback.

Offline checks (run with no credential environment):

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=ai-service \
  /tmp/hw-summary-3a2-venv/bin/python -m unittest discover -s ai-service/tests
```

Use an already provisioned test environment; this command installs nothing. Test
results are recorded after verification below.


## Verified offline results

- Python: 341 passing tests (295 existing plus 46 local-adapter tests).
- TypeScript: 510 passing tests: summary contracts/evaluation/benchmark 103,
  mocked client/service 33, repository/executor units 46, manual-runner safety 37,
  Stage A 32 and Stage C 259. No skipped/cancelled cases.
- Total: 851 offline tests. Existing 42 evaluation expectations still pass.
- All twelve frozen cases were exercised with fake HTTP, twice; receipts match exactly.
  This is NOT a DeepSeek benchmark result.
- Shared generated-contract compatibility, TypeScript typecheck, production build,
  import-with-network/listeners-forbidden smoke and frozen pin verification pass.
- Existing .private-evidence receipt destination is Git ignored (read-only check).
- Test execution used a credential-empty environment and the existing Python test
  venv/Node 24. Existing strict ancestor-ownership checks fail in the filesystem
  sandbox because its /tmp is remapped to UID 65534. The complete TypeScript suite
  passes outside that sandbox using ordinary-user permissions and fake dependencies;
  no production guard was weakened. No infrastructure or database tests were run.
- No real Ollama metadata/generation, hosted provider, AWS, S3, PostgreSQL, systemd,
  credential staging or processing activation was performed in this phase.

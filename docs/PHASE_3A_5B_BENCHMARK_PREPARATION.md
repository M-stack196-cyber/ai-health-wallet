# Phase 3A.5B — offline real-model benchmark preparation

## Boundary and reviewed basis

Reviewed SRS v3 FR-015/016 and §14.3; Phase 3A.1–3A.5A documentation, closed schemas,
validators, fake FastAPI provider/workflow and the protected 42-scenario evaluation
receipt. This phase does not choose a real model, implement a network adapter,
load credentials or execute a real benchmark. API, FastAPI, executor, OCR, Stage C,
AWS, database and migration behavior are unchanged. No new dependencies are added.

## Frozen held-out set

`shared/medical-summary/benchmark/held-out-v1.json` contains 12 new synthetic reports,
with independently authored source quotations, exact measurement strings, critical
flags and gold annotations. Source texts and annotated quotations must not equal
implementation examples. There is no gold generation from candidate output.

| Cases | Intended coverage |
| --- | --- |
| H01 / H10 | UTF-8 offsets, exact decimal precision/signs, inequalities, printed range/flag, original unit case |
| H02 / H12 | Negation and attribution of a source-reported historical diagnosis |
| H03 / H11 | Critical omissions, unavailable findings and fabricated diagnoses |
| H04 / H05 / H09 | OCR ambiguity, conflicts and absent units |
| H06 | Source instructions have no authority; invented advice is refused |
| H07 / H08 | Distinct scope bindings, foreign-scope output and full candidate replay |

`pins-v1.json` freezes exact case, prompt, manifest-schema, shared-schema and glossary
bytes. Pin changes fail closed; normal evaluation never updates pins. Freeze was
performed before running the injected synthetic-port checks. Scope bindings are
unique and deterministically derived per case. Manifests expose only case labels,
topics, counts and fingerprints, never reports, quotations or scope values.

This is a held-out split relative to implementation fixtures, not proof that a
future hosted model has never seen similar templates. Test authors can inspect it;
sealed clinical evaluation and independent adjudication are future requirements.
All annotations and critical flags remain provisional, clinically unapproved.

## Reused scoring and trusted authority

The existing Phase 3A.5A scorer remains the only scorer. Two backward-compatible
keyword-only hooks allow a trusted harness to supply an independently expected scope
and provenance. Both are schema checked; provenance must bind the gold input hash.
Default callers retain their original fake recipe and scope. Neither authority is
learned from a candidate. Production grounding/schema validators are unchanged.

The code hash in a fresh evaluation receipt changes with this interface extension;
existing archived receipts and fixture pins are preserved. The original 42 expected
outcomes remain regression requirements. Clinical/semantic metrics, critical and
full catalogue coverage, glossary rules and zero-tolerance acceptance stay unchanged.
Provider input includes the established trusted catalogue, not hidden critical flags
or reviewer notes. This benchmarks structured fact selection/copying, not autonomous
clinical fact discovery or arbitrary free-form medical reasoning.

## Provider-independent interface and identity

`BenchmarkProvider.generate(BenchmarkRequest) -> BenchmarkReply` is an injected
async port. Requests bind source, prompt, expected provenance, exact model identity,
generation settings and output cap. Replies carry the untrusted candidate, identity fingerprint and
bounded usage counters. No HTTP client, SDK, credential loader or provider registry
is installed. No production call site imports this package.

Identity binds provider, model, immutable revision, adapter revision, tokenizer,
configuration and prompt hashes, plus conservative integer-micro-USD token prices.
Generation settings explicitly specify temperature 0, top-p 1, seed 0, structured
V1 output and no tools/retrieval. These are reproducibility intentions; real-provider
support and nondeterminism must be measured. A future adapter must verify the actual
served revision and request settings, not merely echo requested labels. Known alias
names are refused; actual revision immutability requires independent verification.

`OfflineSession` can compose only the `synthetic-offline` testing identity, and only
with an explicitly matching full identity fingerprint in its allowlist. Even a
manually allowlisted external provider is refused. The preparation CLI has no run,
enable, API-key or provider-selection argument. The manifest has candidate=null,
allowlist=[], external_execution_enabled=false and all approval gates false.

## Resource and spending controls

- Concurrency exactly one, no queue and no model/provider fallback.
- Default per-request timeout 1 second; allowed range 10 ms–5 seconds.
- At most 12 admitted requests, no automatic retries.
- Input/output caps 16,000 / 8,000 token units, plus existing JSON byte limits.
- Explicit maximum run spending cap: 1,000,000 micro-USD (USD 1.00).
- Dry-run spend is exactly zero; live cost estimate is unknown/null until pricing
  and tokenizer/accounting are independently verified. No spend is authorized.

The offline port conservatively counts source JSON plus prompt bytes as synthetic
token units; it is not a real tokenizer or assurance about a provider's billing.
Before future live use, pin and verify tokenization, full serialized prompt/schema,
hidden reasoning tokens and provider-enforced output/billing caps. Never treat
unverified usage reports as a hard spending guarantee.

Before admission the ledger reserves the full input/output worst-case token cost.
The reservation and request count are consumed even for ambiguous failures; no
refund or automatic retry occurs. Exceeding tokens, request count or spending cap
refuses before provider invocation. Model/identity mismatch, provider errors and
timeouts stop the session. Quality failures remain scored failures, not accepted
summaries. Do not create a fresh session to retry an ambiguous charge without
separate reconciliation and authorization. Durable live billing reconciliation is
not implemented in this preparation phase.

Timeout/cancellation stops admissions, cancels outstanding async work and discards
late results. Raw provider exceptions and exception context are not propagated.
This is not an OS/network sandbox for arbitrary injected Python. Blocking code,
non-cooperative tasks, real HTTP teardown and external billing need separately
reviewed process/transport isolation before live composition. The CLI never invokes
any provider, so these limitations cannot cause an external call in preparation.

## Dry-run manifest and offline commands

From backend, using a newly created private directory:

```bash
mkdir -m 0700 /tmp/health-wallet-benchmark-review
npm run summaries:benchmark:prepare -- --manifest /tmp/health-wallet-benchmark-review/manifest.json
```

The existing private/exclusive receipt writer enforces owned private parent,
0600 files, symlink refusal and no overwrite. Persistent receipts are stored under
Git-excluded `.private-evidence`, with directory permissions 0700. The closed
manifest schema binds code/evaluator/fixture hashes, source input hashes, generation
settings, request count, limits and unresolved gates. Repeated runs over identical
artifacts must produce byte-identical manifests. No timestamps, keys or medical text
are included. Pinning detects drift, not malicious simultaneous rewriting of both
sources and pins; reviewed source/version control supplies the trust boundary.

Checklist before comparing results: same case/prompt/schema/glossary pins; same
scorer and harness code hashes; same provider/model/revision/adapter/tokenizer;
same generation-settings hash and seed support; same ordering, limits/prices and
retry policy; independently supplied source/provenance; no instrumentation capturing
payloads; independently approved clinical references and privacy review; private
redacted evidence; no fallback, resampling or post-result gold changes.

## Exact proposed next approval boundary

There is deliberately no runnable real-model command in this phase. Setting an
environment variable or allowlisting a real identity cannot activate one.

1. Independently review clinical gold and glossary; resolve and re-version changes.
2. Complete every row of `PHASE_3A_5B_PROVIDER_PRIVACY_REVIEW.md` for an explicitly
   selected provider/account/immutable model, without automatic selection.
3. Separately approve implementation/offline testing of that one external adapter,
   dedicated credential injection, token/pricing verification and process isolation.
   Produce its exact command and pinned execution manifest for review.
4. Separately authorize the reviewed command: one ordered pass over H01–H12,
   concurrency one, no tools/retrieval/fallback/retries, synthetic data only, maximum
   12 requests and USD 1.00 total ceiling (lower if explicitly approved), with the
   verified per-request deadline/token caps. Stop on security, identity, accounting
   or transport ambiguity; preserve redacted evidence. No records, database,
   processing service or patient-facing publication participates.

The current CLI performs only preparation. This document grants no approval for
steps 1–4 and invents no executable live flags. Real records, deployment or automatic
summary generation require their own later authorization.

## Offline verification results

- 295 Python tests (259 existing, 36 new benchmark tests), all passed.
- 510 TypeScript tests: contracts/benchmark 103, client 33, repository/executor 46,
  manual-runner safety 37, Stage A 32 and Stage C 259; all passed without skips.
- 805 reported offline tests total, including 41 new tests.
- Existing 42 evaluation expectations still met. All 12 synthetic-port held-out
  baselines passed the unchanged scoring rules. No real model was evaluated.
- Manifest schema validation and repeated byte-identical dry-run manifests passed.
- Shared generated-contract compatibility, TypeScript typecheck, production build
  and both disabled-entry smokes passed.
- PostgreSQL-backed regressions were not rerun: this preparation stage performs
  no database connections or migrations. Prior database results are not counted.
- No new dependencies, credentials, AWS/S3 calls, services, records or model costs.

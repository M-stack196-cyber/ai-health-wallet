# Phase 3A.5A — reproducible offline summary evaluation

This stage adds an explicit, synthetic-only evaluator. It never imports the API,
executor, database, credential loaders, storage clients, hosted-model SDKs or a
network transport. Existing application behavior and disabled defaults are unchanged.
Reviewed basis: SRS v3 FR-015/016 and §14.3, Phase 3A.1–3A.4, shared closed contracts,
Python grounding validators, deterministic fake provider, Node client and executor.

## Reference authority and review

`shared/medical-summary/evaluation/reference-v1.json` is an independently authored
source inventory. Its quotes, measurement annotations, polarity, uncertainty,
conflict groups, glossary IDs and critical flags were checked against the synthetic
source text without using candidate output as truth. These are engineering-reviewed
annotations, **not independently clinically reviewed medical gold standards**.
A qualified independent clinical reviewer must approve them before clinical claims
or release decisions. The critical flags are conservative test annotations, not a
triage algorithm or validated severity classifier.

The reference compiler builds byte spans directly from these source annotations.
It never calls the candidate provider or production metadata helper. Ambiguous
quotations refuse compilation. Decimal values, trailing zeros, signs, inequalities,
units, ranges and explicit flags remain exact strings. Page evidence stays null.
An independent reference rule specifies warning and glossary expectations.
`scenarios-v1.json` holds authored negative expectations. Neither file is generated
from evaluated outputs or rewritten by normal tests. Changes require explicit
source review and pin updates; self-updating gold is prohibited.

`pins-v1.json` binds exact reference, scenario, glossary, shared-schema and receipt-
schema bytes. The fixture-set hash fingerprints this pin set. Evaluator identity
hashes the compiler, scorer, scenarios, runner, production validator, fake provider
and recipe code. Pins detect accidental drift; they are not signatures against an
attacker who can rewrite both fixtures and pins. The committed source/review process
must provide that trust boundary. No claim of human clinical review is made.

## Independent layers and acceptance

1. Schema: existing closed `SummaryOutputV1` structure validator.
2. Grounding: existing input, provenance, evidence and numerical validator, using
   independently supplied authority. No competing publication validator is added.
3. Reference semantics: exact agreement with independently authored source facts,
   critical and overall coverage, polarity, uncertainty/conflicts and glossary.

Coverage counts only exactly preserved findings. Both numerator and denominator
are reported, including critical counts and missing critical facts. Empty inventories
are not silently treated as clinical success: the existing input contract refuses
an empty catalogue. No textual-similarity metric or statistical clinical score is
used. A fact omitted from the supplied catalogue can still fail gold coverage even
when schema and grounding accept the candidate.

Provisional acceptance requires schema and grounding success, 100% source-inventory
coverage, 100% critical coverage and zero detected semantic errors. Numerical,
unit, operator, range/flag, negation, citation, glossary, uncertainty, scope and
provenance errors are counted separately. New diagnoses, unsupported findings,
extra interpretations, treatment fields and cross-scope references have zero
acceptance tolerance. Selection of fewer optional facts also fails this deliberately
strict full-report benchmark; it is not a universal summarization requirement.

The 42 authored scenarios include 11 valid reports and 31 negative/boundary cases.
Examples: `5.50` changed to `5.5`; changed inequality or unit; invented ranges;
negation reversal; interpreted ambiguous OCR; omitted conflicting or critical facts;
wrong UTF-8 offsets after accented/emoji text; source/attempt/recipe changes;
foreign scope/evidence; injection-generated diagnosis; treatment instructions;
unreviewed educational prose; incomplete/oversized sources and an empty catalogue.
The catalogue-gap scenario is intentionally grounding-valid but semantically invalid.

## Execution and receipt

From the backend, explicitly run (no listener or worker is started):

```bash
mkdir -m 0700 /tmp/health-wallet-offline-summary-evaluation
npm run summaries:evaluate -- --receipt /tmp/health-wallet-offline-summary-evaluation/receipt.json
```

The parent must already be private and owned by the caller. Receipt creation is
exclusive, mode 0600, refuses symlinks and never overwrites existing evidence.
Use a new directory for each run. Store any persistent receipt under the project's
existing Git-excluded `.private-evidence` directory. Test-only temporary receipts
are removed by their owning tests.

Receipt schema version 1 records evaluator version/hash, fixture-set checksum,
reference pins, fixed thresholds, aggregate results and per-scenario decisions and
counts. It excludes report text, quotations, scope values, patient identifiers,
exception strings, credentials and rendered summaries. Stable labels originate
only in the pinned synthetic scenario set. There are no timestamps or random run
IDs in the receipt, so repeated runs on identical artifacts produce identical JSON.
Errors use a fixed refusal code; unexpected provider failures fail the suite rather
than counting as successful negative cases. CLI stdout contains counts only.

The provider port is injected and defaults explicitly to the existing cooperative
fake. Inputs and recipe are copied; a one-second async timeout bounds cooperative
provider generation. No retries or hosted SDK are present. This is an evaluation
harness, not a security sandbox for arbitrary Python: blocking code or cancellation-
suppressing providers require separately reviewed process containment. Do not inject
real providers, instrumentation or patient data into this offline entry point.

## Tests and limitations

Python tests cover all scenarios, independent catalogue omissions, reference drift,
reproducibility, safe failures, private exclusive receipts, symlinks, deadlines and
source/scope redaction. TypeScript tests run the explicit evaluator command, compare
receipts, check hashes and verify no production startup imports it. Existing Python
contract/service, TypeScript contract/client/repository/executor and fake-based
runner/background/Stage C suites remain regression requirements. Shared generated
schema compatibility, typecheck, build and disabled-entry checks are also run.
Database-backed suites require disposable PostgreSQL and are reported separately;
the evaluator does not connect to any database. Existing regression suites run
only in the established disposable PostgreSQL 16 harness using synthetic credentials,
network none, no host ports and the unchanged migration prefix. No persistent or
development database is accessed.

This framework scores structured extractive candidates against a small synthetic
inventory. It cannot prove medical truth, detect every source error, assess arbitrary
free-form prose, validate clinical severity, establish patient benefit or replace
professional review. Glossary wording remains the previously provisional glossary;
its pin prevents drift but does not establish clinical correctness. Scope checks
exercise contract leakage, not database authorization (covered in Phase 3A.4).
False-positive/negative detection rates on real reports are unknown. These counts
measure test conformance, not real-model accuracy.

## Separate proposed Phase 3A.5B approval

First obtain independent clinical reference/glossary review and freeze development
and held-out synthetic splits. Review provider data handling, credential provision,
logging/retention, cost limits, model/version pinning and process/network isolation.
Approve a bounded real-model adapter and synthetic-only benchmark separately.
Retain the same immutable inputs, schema/grounding gates and zero-tolerance claim
criteria; score omissions and clinically reviewed semantic errors, compare with the
fake baseline and report failures without raw medical text. Neither live-provider
calls, real records, deployment, database backfill nor processing activation is
part of this stage. Do not progress automatically.

## Verified implementation results

- 42 evaluation scenarios: all expectations met; 11 valid candidates accepted,
  31 adversarial/boundary candidates refused. Two receipts were byte-identical.
- Python: 259 tests (200 existing, 59 new framework tests).
- TypeScript: contracts/evaluation 98 (93 existing + 5 new), Node client 33,
  repository/executor units 46, runner 37, Stage A 32, Stage C 259.
- Disposable PostgreSQL: original backend 269, Stage B 20, Stage C database 11,
  summary database 73; repeated offline regressions also passed in the container.
- 1,137 reported tests in total, counting each listed suite once. No skipped or
  cancelled checks. Shared-schema compatibility, typecheck, production build and
  both disabled compiled entries passed.
- Disposable harness receipts verified network isolation and exact-resource
  cleanup. The evaluator itself loads no database dependency or credentials.
- No new dependencies, migrations, application/runtime changes or real providers.

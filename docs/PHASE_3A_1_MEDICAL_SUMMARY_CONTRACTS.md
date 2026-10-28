# Phase 3A.1 — offline medical-summary contracts and grounding

## Scope and implementation boundary

This stage implements shared contracts, mechanical grounding, deterministic plain
text rendering and synthetic evaluation only. No API route, database repository,
migration, model adapter, FastAPI app/listener, provider request or automatic OCR
activation is added. Stage C supervision/credentials and existing processing,
authentication, storage and document code remain unchanged.

Reviewed: actual SRS v3 §§14.3–14.4, FR-015/016 and V-09/V-11; initial summary table;
existing ExtractionResult/validateExtraction; prior Phase 3A planning findings.
Existing ai_report_summaries holds plain text/status/model fields with composite
ownership constraints. This stage writes no database rows. Existing extraction
contains joined text and ordered page methods but no persisted page/text offsets.
All evidence therefore requires page=null, including one-page documents.

The acceptance surface is deliberately extractive and conservative. An output
may select/copy facts from an independently trusted, source-anchored catalogue.
It cannot introduce patient-specific free prose, interpretations, diagnoses,
medical recommendations, treatment changes, ranges, units or values. Educational
explanations are fixed glossary IDs, rendered from frozen versioned data. This
is a foundation for a future AI service, not an implemented model summarizer.

## Canonical contracts

shared/medical-summary/v1.schema.json is Draft 2020-12 JSON Schema. Its $defs
include SummaryInputV1, SummaryOutputV1 and SummaryProvenanceV1. All objects have
exact required keys and additionalProperties=false. Typescript interfaces,
Python TypedDicts and embedded TypeScript schema/glossary are generated from it.
The --check command detects generated-file drift without writing anything.

SummaryInputV1:

- schema_version=1; kind=medical-summary-input.
- scope: opaque request_id, source_ref and scope_token. These are correlation/
  authorization bindings supplied by Node, not real patient identifiers or bearer
  authorization. The future authenticated Node layer owns the patient mapping.
- source: immutable text and its UTF-8 SHA-256, original/metadata hashes,
  processing attempt, extraction status, method and page count.
- facts: at most 32 unique catalogue entries. Each has ID, source evidence, kind,
  certainty, polarity, required coverage flag, optional conflict group,
  glossary term IDs and optional measurement fields.

SummaryOutputV1:

- Same schema version, output kind and exact scope.
- reported_findings: only unchanged entries from input.facts.
- educational_explanations: exactly the permitted glossary IDs for selected facts
  and OCR context; no generated educational prose is accepted.
- uncertainty: exactly computed codes and affected fact IDs, in stable order.
- catalogue_coverage: all_catalogued or subset. This is explicitly not a claim
  that every clinical fact in the original report was recognized.
- provenance: schema/pipeline version, input fingerprint, prompt hash and
  provider/model/revision, compared with independently supplied expected recipe.

Measurements keep exact decimal strings, including signs, leading/trailing zeros,
original unit text, optional original operator, original range text and explicit
reported flags. Missing values/units/ranges/operators/flags remain null. Value,
operator, label, unit, range and flag each carry supporting evidence. No numeric
conversion, unit conversion, population reference range or clinical flag inference
occurs. Scientific notation, locale commas and uncertain OCR digits are not silently
converted; they require an explicit ambiguous/missing representation or refusal.

## Grounding and trust model

Evidence includes source_ref, start_byte, end_byte, quote and page=null. The
validator checks exact UTF-8 byte slices, positive spans, source identity and
containment of measurement evidence inside its parent fact. Matching valid quote
bytes also prevents splitting multibyte characters. Text is never normalized
before comparing offsets or hashing. Numeric tokens cannot be extracted from
inside longer alphanumeric/signed/decimal tokens. H/L/N or high/low/normal flags
must be explicitly present as complete tokens, not letters inside a unit or word.

All output fact fields must exactly match an input catalogue entry. Required
findings cannot be omitted; a selected conflict group must include all its members.
Negation/uncertainty cannot be rewritten. A measurement marked ambiguous cannot
supply an interpreted decimal. Quote-changing diagnoses, invented ranges, new
units, advice/interpretation fields and unknown findings are refused.

The catalogue is a trust boundary. Future Node code must create it from the
patient-owned verified extraction snapshot using reviewed rules or reviewed
annotations. Never accept it from a patient, arbitrary HTTP caller or the same
untrusted model being evaluated. Copying an existing source value under the wrong
clinical role remains a catalogue-authoring/clinical-validation issue; byte matching
cannot prove field meaning or medical truth. No automatic fact-catalogue builder
or semantic clinical judge is implemented here.

SummaryValidationContext must be supplied independently: exact request/source/
scope bindings and a SHA-256 over canonical full input, including the catalogue.
Canonicalization sorts ASCII schema keys, preserves Unicode/whitespace inside
strings, and permits safe integer metadata only. Recipe expectations likewise
come from trusted server configuration. Never compute expected authority from
an untrusted response just to make validation pass. Hashes do not authenticate
a caller or replace patient-scoped database queries, snapshot capture or leases.

## Incomplete extraction, uncertainty and failures

Incomplete/failed extraction cannot generate a summary. OCR use always produces
an OCR limitation; it never supplies a medical accuracy percentage. Ambiguous
findings, missing values/units, conflicts, partial catalogue selection and missing
page locations must produce their exact required warning metadata. The renderer
validates again, sorts facts by source position, labels reported text separately
from education, and emits plain text only. Future clients must use textContent/
appropriate escaping, never treat source text as HTML or executable Markdown.

Failure codes:

| Code | Meaning |
| --- | --- |
| INVALID_INPUT | Closed contract/schema violation |
| INVALID_OUTPUT | Malformed or unsupported output structure/budget |
| SOURCE_TOO_LARGE | Source/input exceeds fixed budgets |
| INCOMPLETE_EXTRACTION | Failed or incomplete extraction |
| INVALID_EVIDENCE | Incorrect source, offsets or quotation |
| UNSUPPORTED_CLAIM | Changed/unknown facts, field meaning, coverage or warnings |
| SCOPE_MISMATCH | Independent source/request/tenant scope differs |
| PROVENANCE_MISMATCH | Input/source digest or trusted recipe differs |
| VALIDATION_FAILED | Other safe refusal |

Errors contain fixed codes/messages only, with no source, scopes, quotes, validator
instance/path details or underlying exception causes. Python removes raw exception
context; TypeScript does not attach a cause. There are no logging calls. Tests
assert booleans/digests/codes rather than dumping clinical payloads on failure.
The intended renderer return value is patient-facing text, not a log payload.
Future consumers must not log raw inputs, outputs or renderer strings.

## Provisional limits and dependencies

- Source UTF-8 text: 32 KiB; no silent truncation.
- Input/output JSON: 256 KiB / 128 KiB.
- Rendered text: 32 KiB.
- Catalogue: 32 facts; main quotation: 1024 Unicode scalar values.
- Decimal string: 64 characters; quoted measurement fields: 128 characters.
- JSON nesting: 20; strict wire-parser value budget: 10,000 nodes.
- Safe integer metadata only; decimal clinical measurements remain strings.
- Strict wire parser rejects duplicate/escaped duplicate keys, fractional/exponent
  numeric metadata, NaN/Infinity, malformed UTF-8 and unsafe integers. Control,
  malformed surrogate and bidi override/isolate characters fail closed.

These are application safety caps, not model context limits or clinical thresholds.
Long-document partitioning is not implemented. Python 3.12 stdlib provides runtime
validation/typing/rendering. There are no new Node or Python runtime dependencies.
A purpose-built evaluator supports only the fixed schema vocabulary; unsupported
keywords fail closed. It is not advertised as a general JSON Schema engine.

requirements-test.txt pins the already available jsonschema==4.10.3 solely for
independent Draft 2020-12 compatibility tests. Nothing was downloaded or installed.
Pydantic/FastAPI and provider frameworks belong to separately approved later work.

The glossary contains four fixed entries (glucose, hemoglobin, OCR, reported range).
Medical explanations paraphrase these public educational sources, without adding
patient interpretations or reference values:
https://medlineplus.gov/lab-tests/blood-glucose-test/
https://medlineplus.gov/lab-tests/hemoglobin-test/
These entries still need clinical/localization review before real-patient release.

## Offline tests and commands

From project root:

```bash
python3 ai-service/tools/generate_contracts.py --check
python3 -m unittest discover -s ai-service/tests -v
```

From backend:

```bash
npm run summaries:contracts:check
npm run summaries:contracts:test
npm run typecheck
npm run build
```

These commands do not start a server or require providers/credentials. New test
commands are explicit and do not change existing script behavior. The fixture
builder is a separate offline utility that intentionally rewrites synthetic
fixtures only; normal tests never regenerate their own expected results.

Results:

- 70 shared fixtures: 10 accepted golden cases, 60 adversarial refusals.
- TypeScript: 93 passed, including Python/TypeScript outcome, schema, fingerprint
  and rendering parity for all fixture cases.
- Python: 90 passed, including independent Draft 2020-12 schema checks with
  network connections forbidden.
- Existing offline regressions: Stage C 259, Stage A 32, manual runner 37 passed.
- TypeScript typecheck, production build and disabled compiled-entry smoke passed.

Fixtures cover Unicode bytes vs UTF-16 indices, decimal precision/signs, source
negation/diagnosis attribution, ambiguous OCR, missing units, conflicting findings,
source prompt injection, explicit flag token boundaries, foreign scope/evidence,
invalid offsets, stale source/recipe, invented medical content, strict JSON,
unsupported fields, deterministic ordering and safe errors.
Tests use a credential-free temporary source snapshot. Existing credential tests
use only their own synthetic temporary files. No development database/AWS access
or systemd operation was used. Database-backed suites were not run because this
stage prohibits PostgreSQL access. Their previous results are not counted here.

## Exact next stage: Phase 3A.2, separate approval required

Implement a FastAPI application factory and authenticated internal request/response
contract with an injected fake model port only. Use in-process ASGI tests with no
network listener. Add a bounded LangGraph/fake-provider workflow whose candidates
must pass these validators, plus a mocked Node HTTP client. Continue to require
trusted Node-owned scope/snapshot/catalogue and recipe expectations. Do not build
catalogue authority from model output, enable free-form patient interpretation,
activate a hosted model, connect PostgreSQL/S3, change migrations or enable OCR.
Provider/clinical evaluation, real extraction snapshot repository/jobs, service
credentials/network deployment and any live activation remain separate gates.

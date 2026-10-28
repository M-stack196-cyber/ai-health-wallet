# Phase 3A.5B — external-provider privacy assessment template

Status: **NOT ASSESSED / BLOCKED**. No provider or real model has been selected.
No provider feature, compliance claim, price, retention period or processing region
is assumed. This document is a review requirement, not a finding of compliance.
Preparation and the initial future benchmark use synthetic reports exclusively.
Synthetic benchmarking approval never authorizes real records or production use.

Before sending any medical information externally (including the first synthetic
medical benchmark), an independent reviewer and project owner must record dated,
provider-specific evidence, the exact account/project/product and the applicable
contract/version. Unsupported answers remain blockers.

| Condition | Required independently verified evidence |
| --- | --- |
| Training and secondary use | Applicable API terms and account settings covering inputs, outputs, feedback, opt-ins, human review and downstream/subprocessor use. Explicitly record whether training/secondary use is prohibited; marketing claims are insufficient. |
| Retention/deletion | Exact input/output, abuse-monitoring, cache, backup and metadata retention; deletion behavior, exceptions and eligibility for any restricted-retention mode. Verify actual account settings and contractual commitments. |
| Processing location | Approved processing/storage regions, routing, failover, support access, subprocessors and cross-region transfers. An endpoint hostname alone does not prove residency. |
| Logging/telemetry | Application, adapter/SDK, proxy, provider-console, error, tracing and support logging policies. Disable payload/authorization capture. Verify behavior with synthetic sentinel data; export only redacted metrics and hashes. |
| Contractual controls | Applicable data-processing terms, confidentiality, permitted purposes, subprocessors, deletion, incident notification, audit/assurance evidence and responsibilities. Obtain institutional/privacy/legal review where applicable; this template makes no legal determination. |
| Identity/security | Dedicated benchmark account/project, reviewed endpoint/TLS/egress policy, exact immutable model/revision, no fallback routing, minimum credential scope, rotation/revocation and no credential discovery from developer environments. |
| Spending/billing | Dated price schedule, billing units (including hidden/reasoning/system/schema/cached tokens and retries), hard request/output limits, provider-side account caps where available and local conservative reservations. Unknown prices or token accounting block execution. |
| Dataset minimization | Independent synthetic-only attestation, no names/identifiers from real people, credentials, S3 keys, source paths or real medical extracts. Confirm gold/reviewer notes are excluded from provider payloads. |
| Publication/release | Benchmark results remain evaluation evidence. No automatic job completion, patient-facing publication or activation follows from a benchmark score. |

Review receipt proposal (not yet implemented/approved for live execution): reviewer
identity/role, review time, approval expiry, exact model/adapter/config/prompt hashes,
source document versions/dates/links, account-setting evidence hashes, decisions for
each row, unresolved exceptions and explicit project-owner authorization. Store
sensitive contractual/account evidence privately, Git-excluded, 0700/0600. Never put
keys, raw reports, tokens or internal identifiers in commands, manifests or logs.

Provider credentials are out of scope here. A later approved adapter must use an
explicit dedicated secret source, not environment/home/instance credential fallback.
No secret or provider key is read, copied, staged or provisioned by this phase.

## Separate clinical review

The implementation catalogue, held-out catalogue and terminology glossary all
remain clinically unapproved. A qualified independent clinician should check source
attribution, negation, exact values/units/operators/ranges/flags, uncertainty,
conflicts, critical versus optional findings, omissions and glossary wording.
A second reviewer adjudicates disagreements. Record qualifications, reviewer
independence from candidate outputs, artifact hashes, decisions and unresolved
items; do not invent reviewer sign-offs. Freeze corrected references under a new
version before candidate benchmarking. Do not tune gold after viewing held-out model
failures; publish corrections as a new benchmark version with a rationale.

Clinical review cannot be replaced by the fake provider's perfect catalogue-copy
score. Real-record approval, consent/data governance, deployment security and
clinical validation remain separate from any synthetic-only provider benchmark.

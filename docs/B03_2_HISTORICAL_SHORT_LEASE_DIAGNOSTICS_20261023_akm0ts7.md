# B03.2 historical short-lease diagnostics — akm0ts7

## A. Authorization and scope confirmation

Only B03.2 diagnostic/qualification work was authorized. **Final status: BLOCKED.**
No B04, product features, AWS, existing-database access, model generation, systemd,
deployment changes, package installation, migration edits or commits/pushes occurred.
SRS v3 → mandatory PRD → roadmap → isolated tests → evidence → traceability → review
remains the delivery path. Existing Node/Python and hosted/local formal-amendment
questions remain pending; this diagnostic phase does not reinterpret them.

## B. Preflight Git/environment safety

Root `/home/m-tayyab-aslam/Music/ai-health-wallet`, branch `main`; source directories
were untracked and tracked/index diffs empty. SHA-256 preflight preserved all public
source and historical receipts. No project Git mutation or destructive operation.
B03.1 archive index (100 indexed files plus index), receipt, historical B03 report,
SRS and PRD hashes verified. Real credentials/private medical records were not read.

The existing harness created four fresh PostgreSQL16 environments with synthetic
credentials, run-specific identity/database markers, private network-none/shared
namespace, 0 published ports, bounded resources, nonprivileged tests and no home/AWS
or Docker-socket mounts. Its internal loopback 5433 is not the host development DB.
Existing migrations were applied only to new disposable databases. Dependencies
came from verified local rootfs/cache; no installation/download or deployment edit.

## C. Historical B03 evidence reconstruction

The original report records 751/753 with one short-lease assertion plus parent failure:
actual `lease-lost`, expected `completed`; duration 830.644219 ms. Source confirms
lease 300 ms, heartbeat 30 ms, provider delay 650 ms, attempt 3000 ms, client 2000 ms.
The preceding heartbeat-loss test and following source-replacement test passed.
The runner executes suites sequentially and Node uses test-concurrency one.

Original per-attempt token/state, DB clock/expiry, renewals, publication/cancellation
stages, event-loop and pool timing were not retained. Result alone cannot identify
which fencing/source/publication branch failed. No historical state is reconstructed
from guesses. B03.1 remains BLOCKED, including its distinct demonstrated fixed-pause
retry-test correction; no old receipt or classification is rewritten.

## D. Hypotheses considered

No cause was selected before testing. Confirm/falsify observations are bounded
criteria, not claims that a few successes universally falsify a hypothesis.

| ID | Hypothesis | Supporting evidence before tests | Counterevidence before tests | Would confirm | Would falsify/limit | Finding |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | Heartbeat logic defect | One historical lease-lost | Later successes; fencing checks pass | On-time live/current renewal incorrectly refused | No incorrect renewals in measured attempts; does not disprove all defects | No incorrect renewal/publication observed in traced original cases; not universally falsified. |
| H2 | DB clock/transaction timing | Renewal is transactional; expiry checked in DB | No timing trace of historical transaction | DB timing/commit consumes lease or wrong clock predicate | Positive margins/clock predicates in measured runs; not universal falsification | Statement-time margins stayed positive; client commit durations measured. Failed gated case lacks causal DB timings. |
| H3 | Scheduler/event-loop delay | 300 ms lease sensitive to stalls | No historical loop monitor | Delay overlaps authoritative expiry | No such delay measured; historical cause still unknown | Original-case event-loop maxima 9.642–27.394 ms; no correlation with loss. Failed B gated interval was not monitored. |
| H4 | Broad-suite interference | Original failed broad, focused passed | Instrumented broad later passed; suites sequential | Broad-only delays correlate with loss | Measured broad behaves like focused; not universal exclusion | Full summary and broad runs failed different tests; final broad passed. Suite/load causality unproven. |
| H5 | Pool/resource contention | Transactions share bounded pool/CPU | No historical pool wait record | Pool wait/CPU throttling overlaps expiry | Low measured waits/margins positive; historical unavailable | Original-case pool waits up to 5.056 ms; no measured causal contention. Failed cases lack corresponding state evidence. |
| H6 | Test timing assumption | B03.1 proved distinct fixed-pause retry defect | That defect was busy, not original lease-lost | Original phase assumption selects unsafe publication/renewal timing | Original passes with safe measured timing; old event not proven | Gated observer awaits an extra query; transient retry assumes 20 ms. Susceptibilities visible, but these new failures are not causally attributed. |
| H7 | Instrumentation artifact | Tracing adds CPU and SQL projections | Original historical failure had no new tracing | Instrumented/uninstrumented behavior systematically differs | Agreement in bounded comparisons; observer effects still possible | Observer effects possible; C gated query max 1.648 ms and its test passed. No systematic observer effect demonstrated. |
| H8 | Drain/publication race | A heartbeat can settle after publication | Admission guard/rollback tests pass | Unsafe re-admission or publication after actual loss | Exact settlement/cancellation/fencing preserved in measured attempts | Fencing/drain/admission/rollback tests passed; expected late heartbeat refusal after completed publication occurred without unsafe admission. |
| H9 | One-time environment anomaly | Historical event not reproduced so far | No captured event proves environment cause | Independent original host/process timing evidence | Cannot conclusively falsify from current host; residual explanation only | Original event not repeated, but additional unresolved failures prevent qualified one-time-anomaly closure. |

## E. Bounded diagnostic plan used

The immutable pre-execution plan SHA-256 is
`8b9cd6902f2f9642ec36dd519fe3945d46cf5a7dd41584c114e55d2b626d4a64`.
Exactly four environments and six original-scenario observations were budgeted:
A: three focused synthetic fixtures; B: full summary suite with one original case;
C: unchanged broad selection with one original case; D: uninstrumented broad with
one original case. Three focused fixtures characterize small timing variation;
summary/broad/uninstrumented comparisons characterize context/observer differences.
This is engineering sampling, not a reliability probability study.

Original 300/30/650 values, deadlines and assertions were not relaxed. Nominal
interval arithmetic suggests about 21 callbacks, but actual committed renewals are
lower when in-flight operations suppress overlapping heartbeats. Actual counts
were measured, not forced to an exact expected number. Safety/ownership/cleanup
failure stops experiments; no repeat-until-green or run-until-failure loop.

After B failed a different existing test, a timestamped C-only measurement addendum
captured the gated observer's existing query. It added no runs, iterations, workload,
sleeps or predicate/assertion changes. Original plan and initial source pins remain.

Existing command used in each private backend snapshot:

```bash
npm run integration:summary-db -- --execute-isolated
```

A temporarily selected only the three-case helper through the existing
`summaries:jobs:db:test` script; B selected bootstrap/migrations/full summary suite;
C/D retained the complete existing broad command list. Exact argv/cwd/UTC execution
receipts are archived. Instrumentation existed only in private copies and is absent
from D and application source. No broader runtime was activated.

## F. Diagnostic executions and measurements

| Phase | Passed / counted | Failed | Disposable evidence directory |
| --- | --- | --- | --- |
| A-focused | 4/4 | 0 | /tmp/health-wallet-summary-db-eDqgg8 |
| B-summary | 73/75 | 2 | /tmp/health-wallet-summary-db-tvucdE |
| C-broad | 753/755 | 2 | /tmp/health-wallet-summary-db-OQ1ect |
| D-uninstrumented-qualification | 755/755 | 0 | /tmp/health-wallet-summary-db-aNBWsU |

A counted three observations plus their parent. B's failure was the B03.1
committed-renewal test returning lease-lost (1805.011321 ms) plus parent. Its original
case passed. C's failure was transient retry returning idle instead of completed
(589.207293 ms) plus parent. Both traced C lease cases passed. D passed every check.
No failure is omitted or merged into a passing rerun. Suites overlap; totals are
not summed into unique tests or requirements.

All values below are milliseconds except counts. DB margins are statement-time
values from DB-clock result projections. Commit measurements are client-side
COMMIT request/ack duration, not exact server commit timestamps. No extra postcommit
clock-poll query was injected into original cases.

| Original sample | Committed renewals | Max timer inter-tick excess | Max heartbeat COMMIT | Min observed DB margin | Execution→drained |
| --- | --- | --- | --- | --- | --- |
| focused-1 | 12 | 3.631 | 44.597 | 252.755 | 52.477 |
| focused-2 | 12 | 3.119 | 44.038 | 259.443 | 51.142 |
| focused-3 | 11 | 4.294 | 43.031 | 267.534 | 51.566 |
| summary | 19 | 9.666 | 65.150 | 263.245 | 10.668 |
| broad | 11 | 1.506 | 51.572 | 235.468 | 20.249 |

Across the five instrumented original samples: maximum renewal round trip 125.254 ms,
maximum pool wait 5.056 ms, event-loop maximum 27.394 ms, maximum dispatch interval
excess above 30 ms 59.062 ms, and maximum gap between committed acknowledgements
88.384 ms. Process CPU/RSS, cgroup CPU/memory and event-loop utilization are retained
with raw events. Provider cancellation did not occur in these successful original
samples; ordinary finally/drain signal aborts are not misclassified as lease failure.
Late heartbeat refusal after an already-completed publication was observed and drained.

C's supplemental gated case passed: 10 successful renewal UPDATE statements,
maximum gate query 1.648 ms, heartbeat COMMIT 73.355 ms, event-loop delay 10.387 ms.
This does not explain B's failed gated case, whose causal interval was not traced.

## G. Reproduction outcome

Original 300/30/650 scenario: zero observed failures in six predeclared observations
(five instrumented, one uninstrumented). The historical original event was not
causally reproduced. Separate relevant failures occurred in B and C and remain
unattributed. They prevent qualified anomaly closure despite final green D.

## H. Root-cause conclusion — Unresolved

No proven implementation defect or new proven test/harness cause is claimed.
The gated wrapper's additional awaited query and transient retry's fixed pause are
visible susceptibilities, not demonstrated causes of these two failures. Current
safe timing traces cannot reconstruct missing failed-attempt timings. No arbitrary
lease/timeout increase, extra sleep, altered publication window or broad refactor.

Unknown original cause alone is not the blocker under the authorized anomaly path.
**Unexplained failures in the required summary/broad diagnostic runs are the blocker.**
A non-reproducible historical anomaly is only a candidate description of the original
observation, not accepted B03.2 closure with contradictory unresolved evidence.

## I. Exact source/test changes

No permanent application, test, harness, dependency or migration changes.
Private diagnostic copies temporarily add in-memory hooks in summary executor,
SQL result timing projections/pool measurements, a three-case helper and selected
harness commands. No actual token, identifier, SQL values, credentials or medical
text is logged; lease-1 is a local alias. Temporary sources are hash-pinned and
archived for review, not installed on an execution path. D's tested source matches
preflight and has no observer code. No unsupported correction was made.

Permanent changes: three tracking documents receive a factual addendum; this new
report and a new receipt are created. All prior receipts/reports/specifications and
pre-existing code remain byte-identical. No production rollback is required.

## J. Safety invariant verification

Across B, C and D, the named real-expiry heartbeat/publication refusal, genuine
heartbeat cancellation/no-publication, stale-token rejection, replaced-source refusal,
admission guard and cancellation/publication rollback tests passed. SQL remains
DB-clock authoritative with existing tokens/source predicates. Ownership, originals,
attempt limits and disabled defaults are unchanged. Synthetic-only scope enforced.
These are scoped synthetic assertions, not production/clinical certification or a
reconstruction of the failed gated case's unavailable publication-state receipt.

## K. Complete test/regression results

A 4/4; B 73/75 (two related failures); C 753/755 (two related failures);
D 755/755, including all 270 existing backend tests and 75 summary DB tests.
B/C stopped at their failed summary suite, so their later typecheck/build entries
were not reached, not falsely passed. D typecheck/build/both disabled entries passed.
Offline: 878 passed (341 Python + 512 TS + 25 baseline), contract compatibility,
typecheck/build and disabled entries passed, no blocked dependencies/skips.
The legacy exact-510-TS flag is false because 512 TS tests exist; actual counters
and all_executed_checks_passed=true are retained, without altering the utility.
Diagnostic-only typechecks passed before execution. All earlier failures remain.

Offline command (private new manifest, historical manifest untouched):

```bash
env -i PATH="$PATH" HOME=/tmp/health-wallet-b032-akm0ts7_/operator-home \
 PYTHONDONTWRITEBYTECODE=1 /tmp/hw-b01-stage/test-venv/bin/python \
 /tmp/health-wallet-b032-akm0ts7_/run-offline.py
```

## L. Disposable-resource cleanup verification

Independently verified eight owned containers, four volumes, four test-image tags
and the owned dependency-cache tag absent. All five pre-existing containers retain
identical states and start/finish timestamps. Only verified owned identities were
removed; no prune, broad cleanup, existing DB connection or service operation.

## M. Evidence files and checksums

Private archive `/home/m-tayyab-aslam/Music/ai-health-wallet/.private-evidence/b03.2-short-lease-20261023-akm0ts7`; directories 0700, files 0600, Git-excluded.
Contains preflight, immutable plan, pre-test hypotheses, C measurement addendum,
all command receipts/logs/results, timing traces, temporary-source pins, final
source inventory, offline evidence, historical hash references and cleanup proof.
Source/destination hashes are verified; INDEX.json pins the archive without a
self-referential checksum. Credential files/full sensitive manifests are excluded.
Public machine receipt: `docs/baselines/B03_2_DIAGNOSTIC_QUALIFICATION_20261023_akm0ts7.json`. Original temporary evidence is retained.

## N. PRD/SRS traceability impact

I = existing implemented backend/control scope; P = partial. Every row retains
its previous status: this phase strengthens verification records, not product
functionality or acceptance. No module becomes production-ready.

| Requirement | Previous → current | Evidence/status rationale |
| --- | --- | --- |
| FR-010 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| FR-011 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| FR-012 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| FR-015 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| FR-023 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| NFR-01 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| NFR-02 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| NFR-04 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| NFR-05 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| NFR-07 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| NFR-08 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| DEC-07 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| DEC-12 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M04-06 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M04-07 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M04-08 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M05-06 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M13-08 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M14-01 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M14-07 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M15-01 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M15-03 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M15-05 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M15-09 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M16-01 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M16-03 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M16-04 | I → I | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |
| PRD-M16-05 | P → P | Existing behavior preserved; diagnostic/test evidence strengthened; no feature/release promotion |

Module M04/M13/M14/M15/M16 completion is not asserted. All 44 primary SRS and 127
PRD entries remain in scope, with their full integrations/failure paths/release proof.

## O. B03.2 final status — BLOCKED

PASS path 1 lacks causal reproduction/fix. PASS path 2 lacks an explained consistent
summary/broad qualification record because B/C failed relevant existing tests.
No unsafe publication or isolation/cleanup failure was observed to establish a
proven unresolved implementation safety defect. Remaining contradictory evidence
therefore meets the explicit BLOCKED rule. The run budget is exhausted, not enlarged.

## P. Full B03 status after B03.2 — OPEN

Actual system-manager OS composition/transport, reviewed immutable artifact/native
graph and service identity, credential/network delivery and application-level
containment/controller-loss/runtime-expiry proof remain separately unqualified.
Formal Node/Python allocation resolution and applicable operational/privacy/clinical
appointments/approvals remain pending. No B03 closure or production claim follows.

## Q. Remaining risks

Six non-IID same-host observations do not estimate a reliable recurrence probability;
0/6 observed original failures is not a zero-risk claim. Instrumentation can alter
scheduling/SQL cost. Statement margins do not show every instant of lease lifetime.
The failed B gated interval and C transient admission decision lack causal state
capture. The latter needs DB due/current-source/global-running state before any
future change; no current explanation is invented. A later green run is insufficient.

## R. Recommended next smallest phase

Separately approve a bounded gated-renewal failure diagnosis with failed-attempt
DB expiry, observation-query latency and heartbeat settlement capture. Keep the
transient-retry failure explicitly logged for follow-up. No broader B03 operational
work or B04 begins. Review this evidence before authorizing further experiments.

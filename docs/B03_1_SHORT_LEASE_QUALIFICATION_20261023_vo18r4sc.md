# B03.1 isolated short-lease qualification — vo18r4sc

Date: 2026-10-23. **Overall outcome: BLOCKED.** Permitted test qualification passed;
the original B03 short-lease failure's exact cause remains unproven. This is not B03
operational closure or approval for B04, live processing or production release.

## A. Preflight and preservation

Repository `/home/m-tayyab-aslam/Music/ai-health-wallet`, branch `main`. Existing
`.gitignore`, ai-service, backend, docs, infrastructure and shared trees were untracked;
tracked/index diffs were empty. A public-file SHA-256 inventory preserved that work.
No Git add/commit/reset/push occurred. All B01/B02/B03 receipts, SRS/PRD and migrations
remain byte-identical. Only the two listed test files and this stage's documentation changed.

The existing harness creates a fresh PostgreSQL16 container with fresh synthetic
credentials, network none, a shared private test namespace, no published ports,
bounded CPU/RAM/tasks, no privileged container and no developer-home/AWS mounts.
127.0.0.1:5433 is inside that owned namespace, not the development host. Isolation
checks require the exact stage-b marker, app role, database identity and empty bootstrap.
The five pre-existing containers were inspected for state only; no database was contacted.

## B. Attempts and actual results

| Attempt | Result | Scope |
| --- | --- | --- |
| Historical B03 original | 751/753, two related failures | Short lease returned lease-lost; parent failed; no stage timing trace |
| B03.1 unchanged broad | 751/753, two related failures | Original short-lease test passed; retry-exhaustion test received busy rather than failed |
| Instrumented summary comparison | 73/73 passed | Original 300/30/650 timing, test-local method/SQL timings |
| Instrumented broad comparison | 753/753 passed | Original broad selection; 22 successful renewals; claim returned with 295 ms lease headroom |
| Final qualification broad | 755/755 passed | Same suite selection, original test retained, two additional DB checks; 270 existing backend tests passed |
| Offline regression | 878 passed | 341 Python + 512 TypeScript + 25 baseline checks; overlapping suites are not added to other totals |

Typecheck, production compilation and both disabled entries passed in the final
broad run and offline snapshot. Shared-contract compatibility passed offline. No
checks were skipped in the final credited runs. Earlier failures are retained.

Exact documented database command, from the backend directory of each named source:

```bash
npm run integration:summary-db -- --execute-isolated
```

Sources: original project for unchanged broad; private `diagnostic-source` for the
instrumented comparisons; private `qualification-source` for final qualification.
Both are under `/tmp/health-wallet-b031-vo18r4sc/`. The focused diagnostic changed
only private harness command selection to bootstrap/migrations/full summary suite.
The broad comparison/final run use the unchanged repository suite selection.
All launches used an allowlisted environment, private HOME and locally prepared
verified dependency image; no package installation or network download occurred.

Offline command (new private manifest, no historical manifest replacement):

```bash
env -i PATH="$PATH" HOME=/tmp/health-wallet-b031-vo18r4sc/operator-home \
  PYTHONDONTWRITEBYTECODE=1 /tmp/hw-b01-stage/test-venv/bin/python \
  /tmp/health-wallet-b031-vo18r4sc/run-offline-qualification.py
```

The helper invokes the existing baseline runner against a private pinned copy.
Its legacy exact-510-TS `full_851_regression_verified` flag is false because the
new suite has 512 TS tests; actual suite counts, zero skips/failures and
`all_executed_checks_passed=true` are authoritative. No baseline utility was modified.
Preliminary loader probes reported only a file-wrapper test and are not credited
as individual unit coverage. A module-import probe passed 27 executor tests;
the final existing CLI workflow is the credited 512-test TS result.

## C. Root cause: established versus unresolved

**Established test assumption defect:** `runOnce()` completion is distinct from
heartbeat settlement. The executor intentionally refuses another admission while
its heartbeat set is nonempty. The old retry-exhaustion test waited a fixed 20 ms.
The focused trace measured a heartbeat settling 43.7503 ms after successful
publication. A deterministic fake-timer test holds a heartbeat pending, proves
busy/no second claim, then releases it and proves idle/drain. This is intended
admission protection, not a reason to weaken the production executor.

**Unresolved original event:** the historical lease-lost result was not reproduced
in the new natural runs. Neither an actual worker defect, a scheduler/SQL delay nor
harness interference is established as its cause. The successful focused/broad
comparisons do not retroactively explain it. Instrumentation perturbs timing.
No arbitrary lease/timeout increase, publication-window widening or production
heartbeat change was justified or made. Overall B03.1 therefore remains BLOCKED.

## D. Narrow changes

- `backend/src/summary-db-checks/lifecycle.check.ts`: retain the original
  300 ms lease / 30 ms heartbeat / 650 ms provider-delay test byte-for-byte;
  add a committed-renewal gate spanning multiple real database-clock lease
  periods and a real database-expiry cancellation/no-publication test.
  Retry exhaustion now verifies worker drain and actual retry eligibility,
  using three explicitly bounded attempts without assuming a 20 ms pause.
- `backend/src/summary-checks/executor.unit.ts`: two deterministic fake-timer
  tests cover pending-heartbeat admission refusal and heartbeat-loss cancellation.
- Three tracking documents receive dated factual addenda; this new report and
  a new receipt preserve failure history. No production code, harness, migration,
  SRS/PRD scope, deployment configuration or dependency file changed.

## E–F. Safety acceptance

Final DB proof: 19 committed renewals, 677.957 ms elapsed, original lease 300 ms,
heartbeat 30 ms, exactly one accepted publication. Forced database-clock expiry
cancelled the provider and produced no accepted summary. Existing stale-token,
source-replacement, publication rollback, patient-isolation and attempt-exhaustion
checks passed. No transaction is introduced around model generation. Existing
lease predicates, source checks, tokens, deadlines and disabled defaults are unchanged.
All ten requested execution/cleanup checks passed; the primary diagnostic objective
for the original failure remains unresolved, preventing an unconditional PASS.

## G. Cleanup and private evidence

Independent cleanup verified eight owned containers, four volumes, four test-image
tags and the separately owned dependency-cache tag absent. All five pre-existing
containers retain identical state and start/finish timestamps. Cleanup used exact
verified identities; no prune/blanket removal. Original evidence was not deleted.

Persistent evidence: `/home/m-tayyab-aslam/Music/ai-health-wallet/.private-evidence/b03.1-short-lease-20261023-vo18r4sc`. Directories 0700, files 0600, Git-excluded.
Copied reports/logs, test source before/after and offline logs have source/destination
SHA-256 checks. Synthetic credential files and full protected manifests were not
copied into the archive. The new receipt and archive index pin the evidence.

## H. Requirement/roadmap disposition

Supporting qualification: FR-015/023; NFR-01/02/04/05/08; DEC-07/12; V-06;
PRD-M05-06, M13-08, M15-01/04 and source/ownership controls. No primary requirement
is newly claimed complete. Existing 44 requirements/127 PRD entries and all scope
choices remain unchanged. **Full B03 operational DoD OPEN; B04 not started.**

## I–K. Remaining blocker and next smallest step

Retain the original failure as unresolved. Review this evidence before separately
approving a B03.1 diagnostic continuation that captures database lease headroom,
SQL/commit timing and event-loop delay on an actual failing original attempt.
Do not retry until green or substitute artificial expiry for the historical cause.
No B04, actual worker activation, AWS, development PostgreSQL, model or systemd
operation follows from these results.

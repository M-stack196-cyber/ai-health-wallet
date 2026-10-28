# B03.3 — Combined residual concurrency diagnosis and regression closure review

## A. Scope and authorization confirmation

**B03.3 PASS, on the permitted defensible test-contract qualification path.**
Regression/lease-safety may be **PROPOSED CLOSED** for review; full B03 operational
DoD remains **OPEN**. This is not a forensic attribution of the old failed schedules.
No B04, feature work, AWS, existing DB, model, systemd, migration, infrastructure,
package-install, activation, commit/push or SRS/PRD amendment occurred.

## B. Preflight and Git state

Root `/home/m-tayyab-aslam/Music/ai-health-wallet`, branch main. All public trees were untracked; tracked/index diffs
were empty. The preflight hashes 230 public files and records existing
untracked directories; no clean/reset/stash/restore occurred. Only scoped test/doc
changes are allowed by final inventory comparison. Real credentials and private
medical content were excluded. Existing Docker container identities/start/stop
states were recorded, without connecting to their databases.

A cache verification initially refused host `/usr/bin/node`, which differs from the
NVM-selected runtime. Automatic review rejected an unexplained path-substitution
retry. Read-only reconciliation then proved the original Node pin exactly matches
both cached `/usr/bin/node` and current selected NVM binary; every cached rootfs
fingerprint was verified directly before the allowed offline build. No pin was
changed, packages installed or safety check bypassed. Receipt retained.

Disposable PostgreSQL16 only: fresh random identities/passwords, network-none/shared
private namespace, zero published ports, mount allowlist, no developer home/AWS/
Docker-socket mounts, bounded CPU/memory/PIDs, cached native dependencies. Existing
migrations were run only against newly created empty disposable databases.

## C. B03.1/B03.2 evidence reused

B01 historical 876 offline; B02 726 disposable; original B03 751/753. B03.1 final
755/755 and 878 offline did not erase its prior failures. B03.2 B-summary 73/75
failed gated renewal; C-broad 753/755 failed transient retry; D 755/755 and offline
878 did not explain them. All old receipts/reports/indices/files remain byte-identical.
B03.2 original 300/30/650 passed six observations; its statement-time lease margin
and latency figures are bounded samples, not universal guarantees or server commit
instants. No historical publication/state receipt has been reconstructed.

## D. Exact gated-renewal failure analysis

Historical test: `committed renewals span multiple lease periods before publication`.
B03.2 B returned lease-lost (1805.011321 ms). Lease 300 / heartbeat 30 / attempt 3000 ms;
client 2000 ms; gate sought >=650 DB elapsed ms. Wrapper awaited real heartbeat
COMMIT **and then an observation query** before returning. Executor suppresses all
next heartbeat dispatches while that wrapper promise remains outstanding.

Dependency map: test→fixture/short repository→executor interval→transactional
heartbeat UPDATE/COMMIT→awaited gate observation→provider release→fenced publication.
The extra query is on the lease-critical path; positive remaining time read once
is not a guarantee that the whole wrapper will settle before expiry.

Controlled proof retained exactly 300/30: a real committed renewal was acknowledged,
then the same wrapper position was held until SQL observed true lease expiry,
without changing lease/token/deadline rows. Exactly one renewal, correct lease-lost,
provider cancellation, zero summaries, running-but-expired row, verified drain.
This proves a test-induced mechanism; **it does not prove B03.2's query was delayed**.

Correction: increment acknowledged renewals and return immediately; move bounded
DB elapsed/margin observation to provider-side waiting, outside heartbeat settlement.
Still requires >=3 committed renewals, >=650 DB elapsed ms, positive observed margin,
completed result, verified drain and exactly one summary. No failed execution is
accepted as success. The original 300/30/650 test is byte-for-byte unchanged.

## E. Exact transient-retry failure analysis

Historical test: `transient fake service failures schedule bounded retry and later
succeed`; B03.2 C returned idle (589.207293 ms). Fixture retry base 5 / max 10 ms,
normal repository lease 15000 / attempt 60000, executor heartbeat 20 / attempt 3000 / drain 1000,
client 2000 ms. First503→transactional fail→retry_wait; old test then waited 20 ms
and expected a fresh executor's first invocation to complete.

Dependency map: test→fixture fake503→executor.fail→retry_wait/DB due schedule→new
executor.recover/claim→patient/current-source/due/global-running predicates plus
FOR UPDATE SKIP LOCKED→idle or generation→atomic publication. A new executor does
not prove the previous executor's heartbeat/client work has drained. An empty
claim is intentionally idle, including locked candidates, not a terminal failure.

Controlled proof: first 503 returned failed; prior executor drained; SQL confirmed
due state. A separately owned transaction locked exactly that synthetic job.
Same executor returned idle, with retry_wait/attempt 1/no summary unchanged. After
ROLLBACK/release it completed on its next invocation, attempt 2/exactly one summary.
No failed generation was retried or hidden in an observation loop.

Correction: keep initial failed/retry_wait assertions; require verified prior drain
and bounded DB-clock due condition; assert attempt 1 before one fresh retry invocation,
then completed, drain, attempt 2 and exactly one summary. No fixed 20-ms readiness
assumption. No general retry-until-green helper. **The old C lock holder/due state
was not recorded; its precise cause remains historical uncertainty.**

## F. Shared-cause assessment

No shared production cause established. Both tests confused a timing observation
with a lifecycle guarantee, but mechanisms differ: observation extends in-flight
renewal versus admission can correctly see no claimable row. Existing B03.1 fake
unit tests prove completion can precede last-heartbeat settlement; that explains
why drain matters, not proof that B03.2 C had that exact lock/settlement schedule.

## G. Root cause(s) and hypotheses

Demonstrated defects are in test contracts/synchronization; production executor,
repository, predicates, deadlines, fencing and migrations were not changed.
**Exact historical causes remain unknown.** Qualification rests on controlled safe
failure-class behavior, corrected synchronization and current regression evidence;
it does not rename old failed runs as passes. No unexplained new failure occurred.

| ID | Hypothesis | Evidence/support | Confirmation condition | Counter/falsification condition | Finding |
| --- | --- | --- | --- | --- | --- |
| H1 | delayed heartbeat settlement | pending observer delays all next renewals | DB expiry while heartbeat wrapper pending | renewals continue despite held wrapper | Confirmed controlled mechanism: withheld acknowledged heartbeat suppresses next renewal until expiry. Historical delay unknown. |
| H2 | retry before prior drain | runOnce need not drain last heartbeat | busy guard or held transaction | same executor claims before settlement | Drain distinction independently covered by existing deterministic unit tests; old lock holder not established. |
| H3 | stale in-memory state | executor has local active state | idle despite eligible unlocked row after drain | same executor succeeds after lock release | No stale-local-state defect observed: same executor moves idle→completed after lock release. |
| H4 | completion/drain versus eligibility | separate lifecycle milestones | claim before due/drain or lock release | explicit convergence still fails | Retry test now explicitly establishes drain and database-clock due state. No 20 ms guarantee remains. |
| H5 | transaction visibility | SKIP LOCKED intentionally excludes locks | due exact row locked returns idle | row lock does not affect claim | Confirmed controlled SKIP LOCKED behavior: due locked row idle; released row claimed once. |
| H6 | expiry versus COMMIT | lease 300 ms, observer awaited | committed renewal then observer blocks until expiry | publication succeeds after actual expiry | Committed renewal followed by withheld observer genuinely expires; correct cancellation/no publication. |
| H7 | broad scheduling | historical broad failures vary | traced delay overlaps deadline | not proved by controlled delay | Not established as historical cause. Final broad is one sample, not a load/reliability study. |
| H8 | test polling assumption | fixed pause and awaited gate | controlled legal schedule invalidates expectation | test asserts all needed conditions | Invalid assumptions demonstrated; two narrowly corrected tests retain publication/fencing assertions. |
| H9 | observation before convergence | idle not terminal | release then same executor completes once | idle persists eligible unlocked state | Controlled retry idle is intermediate, not completed/failed; exact attempt and one publication verified after release. |
| H10 | production concurrency defect | historical failures unexplained | unsafe publish/admission or incorrect DB predicate | safety invariants supported; no universal exclusion | No production defect demonstrated; existing fencing/rollback/cancellation tests pass. Not universal proof. |

## H. Files changed and why

- `backend/src/summary-db-checks/lifecycle.check.ts`: only the two residual test synchronization contracts.
- `backend/src/summary-db-checks/b033-concurrency.check.ts`: two synthetic controlled-schedule safety regression cases, isolated
  fixture setup, exact-row locks released in finally, scoped teardown and bounded waits.
- Three existing tracking documents: append factual B03.3 evidence/status addendum.
- `docs/B03_3_RESIDUAL_CONCURRENCY_20261023_w6uzcegf.md` and `docs/baselines/B03_3_REGRESSION_QUALIFICATION_20261023_w6uzcegf.json`: new report and machine receipt.

Production source, original timed case, existing fake unit tests, harness, package
locks, migration 0001–0004, SRS/PRD and old evidence are unchanged. Private focused
selection copies do not alter the normal broad suite. Code rollback, if requested,
is restoration of the preflight lifecycle file plus removal of only the newly added
test file; preserve receipts/evidence. No production state rollback is needed.

## I. Focused test results

| Execution | Passed / counted | Failed | Disposable evidence directory |
| --- | --- | --- | --- |
| diagnostic | 3/3 | 0 | `/tmp/health-wallet-summary-db-Y7yz4N` |
| focused | 16/16 | 0 | `/tmp/health-wallet-summary-db-tP3OLy` |
| broad | 758/758 | 0 | `/tmp/health-wallet-summary-db-pIUL2n` |

Characterization counts two cases plus parent. Focused counts 12 existing lifecycle
cases plus their parent and 2 characterization cases plus parent:16. Focused typecheck
passed. Maximum 2 focused environments and 1 broad were pinned before execution and
used exactly. No unplanned reruns, sleeps increased, lease tuning or blanket retries.
Private receipts retain UTC execution times and durations. Ordered DB/commit/expiry
facts are proven by awaited operations and SQL checks; no per-server commit timestamp
or missing historical timing has been invented.

## J. Safety invariant verification

All named final-broad checks in the machine receipt passed. Database clock is still
authoritative; heartbeat loss cancels; expiry/stale tokens/replaced source cannot
publish; cancellation rollback preserves no accepted evidence; outstanding work
prevents unsafe admission; scoped ownership remains enforced; retries produce only
one accepted publication. The deliberate503 and lease-lost cases are asserted
failures, not relabeled success. Existing prior-summary preservation tests pass.
Controlled row-lock test proves idle is not permanently latched after lock release.
Global concurrency-one admission still legitimately idles behind any running job;
no unscoped recovery/backfill was introduced to circumvent that guard.

## K. Final broad regression result

Exactly one broad run: **758/758**, all suites passed,
including 270 existing backend tests, 37 runner checks, 32 Stage A, 20 Stage B and the
current Stage C/security suites. Summary DB suite now counts 78 (previous 75 plus 2
new cases and their parent). Original short lease, corrected cases and all named
fencing/drain/rollback checks passed. No broad rerun was needed.

## L. Offline/typecheck/build/contracts results

Exactly one final offline set: **878 passed**: 25 baseline, 341 Python,
512 TypeScript. Contract generation compatibility, typecheck, build, disabled OCR
entry and disabled summary entry passed. Zero blocked dependencies/skips. Initial sandbox execution failed before any TS test
started because tsx Unix IPC listen was denied (EPERM); its failed receipt/log is
retained. Only unstarted TS and subsequent checks were resumed with the same source,
clean environment and network guard after execution permission was granted. Python/
baseline were not repeated; no second full offline set was run. Broad
also passed typecheck/build/both disabled entries. Counts overlap; never sum suites
into a unique test or requirement total. Legacy exact 510-TS flag remains false;
actual counters and all_required_checks_passed=true establish the final required
checks; all_executed_checks_passed=false honestly preserves the infrastructure
refusal. No historical receipt is overwritten or utility changed. Without
changing historical utility semantics.

Commands: established `npm run integration:summary-db -- --execute-isolated` from
pinned private stages; offline uses existing baseline runner via a new in-memory
manifest/output selection and the pre-existing test virtualenv. Exact argv/source
pins and offline toolchain receipts retained. No dependency installation.

## M. Cleanup verification

Independent read-only Docker identity checks confirm 6 owned containers, 3 volumes
and 3 test-image tags absent. Only the independently verified owned cache tag was
additionally removed. Five pre-existing container states and start/finish times
unchanged. No prune/broad cleanup or existing-database access. All subprocess
sessions completed. Original temporary evidence retained; no Gate 3 cleanup.

## N. Evidence files and hashes

Archive: `/home/m-tayyab-aslam/Music/ai-health-wallet/.private-evidence/b03.3-residual-concurrency-20261023-w6uzcegf`. All directories 0700 / files 0600; Git-excluded. Source/destination
SHA-256 comparison for copied files, INDEX.json for final archive, public report/
receipt hashes and preservation inventory are verified separately. Contains all
failed historical references, new command receipts/logs, tested-source pins, plan,
hypotheses, cache reconciliation, offline receipt/logs and sanitized resource/
cleanup receipts. Synthetic password/env files and full sensitive manifests excluded.
Original `/tmp` evidence retained. Public hashes are reported in final delivery.

## O. PRD/SRS traceability impact

I=implemented backend/control scope, P=partial; no product status upgrades. Authority
remains unchanged SRS v3 and mandatory PRD; all 44 primary SRS and 127 PRD entries stay mapped.
No RAG, sharing, guardian, mobile, doctor, clinical or production completion asserted.

| Requirement | Previous → current | Reason |
| --- | --- | --- |
| FR-010 | I → I | Verification strengthened; functionality/release status unchanged |
| FR-011 | I → I | Verification strengthened; functionality/release status unchanged |
| FR-012 | P → P | Verification strengthened; functionality/release status unchanged |
| FR-015 | P → P | Verification strengthened; functionality/release status unchanged |
| FR-023 | P → P | Verification strengthened; functionality/release status unchanged |
| NFR-01 | P → P | Verification strengthened; functionality/release status unchanged |
| NFR-02 | I → I | Verification strengthened; functionality/release status unchanged |
| NFR-04 | P → P | Verification strengthened; functionality/release status unchanged |
| NFR-05 | I → I | Verification strengthened; functionality/release status unchanged |
| NFR-07 | I → I | Verification strengthened; functionality/release status unchanged |
| NFR-08 | P → P | Verification strengthened; functionality/release status unchanged |
| DEC-07 | P → P | Verification strengthened; functionality/release status unchanged |
| DEC-12 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M04-06 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M04-07 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M04-08 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M05-06 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M13-08 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M14-01 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M14-07 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M15-01 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M15-03 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M15-05 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M15-09 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M16-01 | I → I | Verification strengthened; functionality/release status unchanged |
| PRD-M16-03 | P → P | Verification strengthened; functionality/release status unchanged |
| PRD-M16-04 | I → I | Verification strengthened; functionality/release status unchanged |
| PRD-M16-05 | P → P | Verification strengthened; functionality/release status unchanged |

## P. B03.3 final status — PASS

Both failure classes have defensible **test-contract qualification**, narrowly
corrected tests and controlled negative safety demonstrations; current focused,
single broad and offline validation passed with no unexplained new contradictions.
This is explicitly **not** a claim that controlled injected delays/locks identify
the exact old failed schedules. If review requires forensic attribution rather
than the authorized defensible-qualification path, old missing traces cannot
provide it; the report does not manufacture them. Historical original and B03.2
occurrences remain documented uncertainty, not newly proven production defects.

## Q. B03 regression/lease-safety status — PROPOSED CLOSED

Proposed for owner review only, scoped to this source snapshot and synthetic test
contracts. Historical B03.1/B03.2 statuses remain BLOCKED in their unchanged records.
Full B03 operational DoD remains OPEN. No release, recurrence probability, cloud,
medical-safety or real-patient authorization follows from this qualification.

## R. Remaining full-B03 operational gates

| Gate | Status | Evidence/remaining gap |
| --- | --- | --- |
| System-manager composition | Missing | system-supervision.ts defines ports; live-runtime.ts still composes user-manager adapter; no system OS transport |
| Artifact/service identity | Partial | Gate 1A models independently pinned artifacts, boot/invocation/process identity; reviewed deployed native graph/runtime identity not proven |
| Credential delivery | Partial | Gate 1B strict file loaders and fake tests exist; service staging/injection/rotation not operationally composed |
| Network delivery | Missing | PrivateNetwork=yes and deny-all address-family allowlist cannot deliver required PostgreSQL/S3 TCP traffic; reviewed network policy needed |
| Application containment | Partial | Synthetic Python cgroup probes passed historically; actual Node/OCR child graph has no system-unit live proof |
| Controller-loss handling | Partial | BindsTo/After definitions, bounded fake-port verification exist; actual application-controller loss not exercised |
| Runtime-expiry handling | Partial | RuntimeMaxSec and synthetic timeout proof exist; no application-level exact-invocation expiry receipt |
| Supervised worker composition | Partial | Scoped disabled scheduler exists; executable system-manager+credentials+network composition missing |
| Deployment/runtime qualification | Missing | No approved actual-worker canary or release-like identity/network/child/recovery verification |

Clinical/privacy/operations appointments and formal Node OCR/hosted→local SRS
amendments remain pending. Synthetic Python supervision success is not proof of
actual Node/PDF.js/Poppler/Tesseract containment or approved runtime delivery.

## S. Recommended next phase

Separately approve **B03.4 operational delivery design gate**, before implementing
system-manager OS composition: approve immutable release/native graph and service
identity, credential staging/binding and enforceable PostgreSQL/S3 network design;
map existing ports to a bounded trusted OS transport and plan fake-based ownership/
controller-loss tests. Deliver one concrete reviewed composition plan and activation
boundaries, without deployment, credential reads or worker activation. Implement
only after that design is approved. No B04 or next phase executed.

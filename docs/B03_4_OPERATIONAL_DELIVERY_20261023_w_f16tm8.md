# B03.4 — Operational delivery design and safe local implementation

## A. Scope and authorization confirmation

**B03.4 PASS for offline/local/disposable scope.** Run started 2026-10-23;
finalized 2026-10-24 (Asia/Karachi). Dated filenames retain the original run identity. B03 regression/lease safety is
**CLOSED**, reflecting the user's acceptance of B03.3 and the current passing broad
regression. Operational implementation is **PARTIAL**; deployment/runtime
qualification is **OPEN**. Full B03 is not complete. No B04 or next phase began.
No live AWS/S3/RDS/development DB, real patient data, model/provider, systemd,
installation, live credentials, migration edits, deployment changes or commits/pushes.

## B. Targeted preflight and Git state

Root `/home/m-tayyab-aslam/Music/ai-health-wallet`, branch main. Existing public source trees remain untracked;
tracked/index diffs were empty. Preflight preserves 233 public-file hashes
and Git status. B03.3 report/receipt/index and all indexed archive files verified
before and after this phase. Existing source/environment/evidence was not reset,
stashed, cleaned, restored or overwritten. No new full product audit was performed.

Unchanged SRS v3/PRD v1.0 remain mandatory; relevant source requirements, B01/B02
contracts, B03 operational report and B03.3 evidence were reused. The working Node
OCR versus SRS Python allocation and hosted→local zero-paid direction remain
pending formal amendments; this phase does not silently approve them. Named
clinical/privacy/operations appointments and production signoffs remain pending.

## C. Existing B03 operational components reused

`background-runtime-core.ts` and `background-service.ts` retain the scheduler;
`background-repository.ts` retains patient + fixed upload-cutoff SQL; dedicated
`background-coordinator.ts` retains the advisory lock; `worker.ts`, `service.ts`,
`repository.ts`, original access and PDF.js/Poppler/Tesseract remain the extraction
implementation. Existing v2 pinned system-file credentials and system-manager
artifact/unit/invocation contracts are reused. No alternative OCR/worker pipeline.
The user-manager adapter/argv and developer-mode loading remain unchanged.

## D. Operational architecture selected

Dedicated logical service `document-processing-operational`; explicitly selected
Node entry `backend/dist/processing/operational-entry.js`. The ordinary API and
old background entry do not import or start it. Existing system plans now allow
this exact additional worker artifact **only when independently pinned explicitly**;
old plans still select the old path and same security properties.

Selection → pinned private runtime grant → exact current system/controller/self/
artifact checks → protected credential bundle → seven existing AWS preflight checks
→ explicit PG/S3 resource factory → existing canary composition/scheduler → existing
leased worker/OCR processor → guarded persistence. Real AWS preflight transport,
OS observation/control and enforced-network verifier have **no automatic defaults**.

Expected future wiring (design only): `launchOperational(env, signal =>
startOperational(selection, {files: nodeCredentialFileSystem(), system: trustedOS,
self: trustedSelf, network: trustedNetworkProof, awsRead: explicitFileCredentialRead,
open: operationalResourceFactory(policy, existingOcrProcessor), compose:
composeBackground, signal, wallNow: Date.now, monotonicNow: performance.now}))`.
This is not an installed/runnable live composition. The supplied OCR processor must
be the existing bounded processor built from independently reviewed native/config
artifacts; it is not selected or invented by the new resource factory.

## E. Remaining gaps before implementation

Before this phase, system composition/network delivery were missing; seven other
operational gates were partial or missing. Existing typed system ports/file loaders
were not a production launcher. Current deny-all networking was incompatible with
PG/S3 and health. We implement application contracts, safe composition seams and
local tests; do not guess an OS/network/credential deployment design or claim its
mocked observations establish actual enforcement.

## F. Exact implementation completed

- Disabled standalone launcher, explicit mode/factory requirements; enabled mode
  rejects ambient AWS/PG/DB credentials, proxy variables and Node runtime hooks.
  SIGTERM/SIGINT are connected to the supplied cancellation signal; owned handlers
  are removed after drain/failure. No factory, files, pool or listener when disabled.
- Runtime selection/run/deployment/configuration fingerprints, private canonical
  checksum-pinned grant, max 600-second authorization bounded by declared credential
  expiry, fixed approval scope/cutoff, no same-invocation reactivation.
- Fresh read-only worker/controller ownership: exact unit/description/transient
  path/ExecStart/invocation/cgroup, self PID/start-time/UID/boot, independent artifact
  hashes and root-owned read-only metadata, controller coupling/security properties,
  effective CPU/memory/task/cgroup checks. No start/stop/reset/kill OS ports accepted.
- Existing file bundle is loaded only after initial authority verification. Files
  must be under `/run/credentials/<exact-unit>` and owned by the resolved service
  identity. Existing inode/symlink/permission/content checks remain authoritative.
- Explicit resource factory passes file-derived PG options and an explicit
  file-backed AWS credential provider. Fixed target/region/endpoint; no profile,
  metadata or hosted fallback; region redirects disabled; client deadlines and
  concurrency preserved. Only original-read capability is exposed to the worker.
  Driver construction/failure cleanup is fake-tested; defaults never invoked live.
- Runtime/config policy hashes pin processing/retrieval/document options; copied
  policy is frozen for the actual composition. Existing processing/retrieval bounds
  are retained, concurrency fixed to one. No automatic historical discovery/backfill.
- Bounded fresh authority/network checks and terminal expiry/controller-loss
  cancellation; monotonic deadline cannot be extended by clock rollback. Check
  timeout or uncooperative reads stop admissions and prevent verified-cleanup claims.
- Repository statements use transactions in explicit operational mode. Authority
  loss after a statement but before COMMIT rolls back. Extraction completion retains
  the original locked DB lease/deadline timestamps and rechecks DB-clock validity
  after authority observation, before COMMIT. Existing tokens/source/SQL predicates
  remain in force. No transactions span OCR/model generation.
- Graceful drain/forced cancellation, idempotent resource close and aggregate private
  state/readiness. Incomplete drain or uncooperative observers are reported as
  incomplete cleanup, never success.

## G. Files changed and purpose

- `backend/src/processing/operational-authority.ts` — added
- `backend/src/processing/operational-runtime.ts` — added
- `backend/src/processing/operational-resources.ts` — added
- `backend/src/processing/operational-entry.ts` — added
- `backend/src/processing/background-runtime-core.ts` — modified
- `backend/src/stage-c/system-supervision.ts` — modified
- `backend/src/background-checks/operational-fixture.ts` — added
- `backend/src/background-checks/operational.check.ts` — added
- `backend/src/background-db-checks/operational.check.ts` — added
- `backend/package.json` — modified

The three tracking documents receive factual append-only addenda. This report and
`docs/baselines/B03_4_OPERATIONAL_QUALIFICATION_20261023_w_f16tm8.json` are new. No dependency added; package-lock, migrations 0001–0004,
auth/document/summary implementations, old OCR engines and B03.3 tests unchanged.
Code rollback requires only the three modified code/config files and seven new
source/test files; preflight-matching originals are archived. Any rollback must
preserve unrelated untracked work and all evidence. No live state rollback or
record/object cleanup is needed.
Core changes are optional explicitly injected system-mode seams; the default
legacy approval, queries, health, coordinator and shutdown behavior are preserved.

## H. Service/artifact identity result

Implemented and fake-tested, not deployed. Build identity uses existing independent
artifact SHA-256 pins and deployment identity; no invented Git revision is claimed
for untracked source. Runtime configuration and authorization bind exact run and
both invocations. Actual immutable release/native dependency graph remains an
Operations approval/verification gate.

## I. Credential-delivery result

Protected explicit files feed connection options and SDK credential provider;
no real credential file was read/staged or printed. Tests cover missing/changed
files, wrong owner/path/pins, no ambient fallback, expiration and redaction, plus
existing Gate 1B tests in regression. Declared credential expiry caps runtime grants;
actual issuer expiry/early revocation/rotation remains a delivery responsibility.
Recognizable expiry/authentication failures from the injected storage port terminate
admissions; a live adapter must preserve that classification if another adapter
redacts low-level errors. No live refresh/secret backend was added.

## J. Network-delivery result

Intent is default-deny, no proxies/redirects, PG loopback 5433 and exact approved
S3 account/region/bucket/prefix. Existing identity/security preflight requires scoped
STS/S3-control reads through its explicit credential-bound port. The worker gets
no arbitrary URL/provider selection. Fresh independently observed enforcement
proof must bind configuration/invocation and expire within 5 seconds; intent alone
is rejected. **This is not firewall/DNS enforcement.** Existing PrivateNetwork=yes
and empty address-family allowlist deny PG/S3 TCP and loopback health; unchanged.
A trusted real network verifier cannot certify delivery under that current policy.
Actual enforceable connectivity and DNS/endpoint containment require reviewed
OS/network changes and separate approval.

## K. Application-containment result

Materially strengthened locally: explicit startup capability, current self/unit/
controller/artifact checks, terminal authority state, same-process invocation
collision refusal and dedicated PG advisory lock for cross-process exclusion.
Actual application/native-child OS containment is not demonstrated by these fakes
or historical Python probes. Real OS transport/namespace/cgroup checks remain open.

## L. Controller-loss result

Fresh bounded checks plus 250-ms monitoring stop new admissions on observed loss;
active work receives cancellation and guarded writes roll back before commit.
Disposable tests prove loss after actual extraction SQL leaves no committed
extraction/completion. No authority restoration reactivates the same runtime.
Kernel BindsTo/After behavior for the actual application remains unverified.

## M. Runtime-expiry result

Pinned grant expiry, declared credential ceiling and monotonic deadline are
implemented. DB-backed expiry cancellation/no publication and original-lease
expiry rollback pass. Stale grants cannot restart the same invocation. Real
application RuntimeMaxSec behavior and issuer credential expiry require separate
runtime verification; clocks/monitoring cannot guarantee deadlines during arbitrary
host stalls without the OS protections.

## N. Supervised-worker composition result

Existing scheduler, scoped repository, advisory-lock connection and worker are
actually exercised against disposable PostgreSQL with fake processor/S3/system
observations. No direct controller runOnce implementation, unrestricted worker,
automatic API startup or alternative OCR exists. Independent transport/resource/
processor ports allow explicit composition without ambient credential lookup.
The shipped standalone command deliberately refuses enabled execution without a
trusted composition; it is **not live-launch ready**.

## O. Focused test results

46 distinct new fake cases covered across focused development runs; final offline
and broad selections execute all 46 together. The final focused disposable suite
passes 6/6 (five scenarios + parent). Earlier corrected suite passed 5/5 before the
new DB lease-boundary scenario was added. Source pins and all logs retained.

| Disposable run | Passed / counted | Failed | Evidence directory |
| --- | --- | --- | --- |
| focused | 0/1 | 1 | `/tmp/health-wallet-summary-db-W0AkiL` |
| focused-corrected | 5/5 | 0 | `/tmp/health-wallet-summary-db-0sosd9` |
| db-focused-final | 6/6 | 0 | `/tmp/health-wallet-summary-db-iRQsb6` |
| broad | 810/810 | 0 | `/tmp/health-wallet-summary-db-pWRIUz` |

The first focused run failed before scenarios: `assertIsolated(true)` preceded
loading its private synthetic environment, yielding PG28000/no username. Corrected
order: verify network/container isolation → load only isolated synthetic env →
verify DB identity marker. No isolation check removed. Failure retained. A later
launcher refused an already-used fake-log filename before resource creation; it
was given a unique DB evidence label, without overwriting files or running tests
until that precheck passed. No failed broad run or retry-until-green loop occurred.

## P. Final regression/offline results

One final broad disposable run: **810/810**. Includes 270 backend,
37 runner, 78 background-unit (32 existing + 46 new), 26 background-DB (20 existing + 6
new), all existing StageC/processing and 78 summary-DB checks. Typecheck/build and
old disabled entries passed. B03.3 summary qualification was not reinvestigated.

One final offline set: **924 passed** (25 baseline + 341 Python + 558 TS).
Contracts/typecheck/build and existing disabled entries passed, no blocked
checks/skips. New compiled operational disabled/refusal smoke passed with network
and external-client capabilities prohibited. Legacy exact 510-TS flag remains false;
actual counts/all_executed_checks_passed are reported, not a fabricated old total.
Counts overlap and are not summed into a unique test/requirement total.

## Q. Cleanup verification

Eight owned containers, four volumes and four test-image tags absent; owned cache
tag removed only after exact ID/label verification. Five pre-existing container
states/start-stop times unchanged. No prune, existing-database connection or Gate 3
cleanup. Original temporary sources/evidence retained. No synthetic systemd unit
or application worker was started on the host. Cooperative isolated worker cleanup
passed; negative uncooperative tests intentionally assert cleanupVerified=false.

## R. Evidence files and hashes

Private archive `/home/m-tayyab-aslam/Music/ai-health-wallet/.private-evidence/b03.4-operational-delivery-20261023-w_f16tm8`. All directories 0700 / files 0600, Git-excluded. Copied
files match source/destination SHA-256 and INDEX.json entries. Contains concise
preflight, independent source pins, failed/corrected focused evidence, broad/offline
receipts/logs, final source, compiled smoke and exact-owned cleanup. Synthetic env/
password files and full sensitive run manifests are excluded. Old evidence remains
unchanged. Final delivery reports public report/receipt and archive-index hashes.

## S. PRD/SRS traceability impact

No whole feature/control/module status upgraded. I=existing backend/control
implementation; P=partial. Some PRD controls had no separately enumerated whole-
control status in the targeted public baseline; that uncertainty is retained,
not replaced by a guessed completion status. New local evidence is attached without
pretending the full RDS/cloud/OTP/privacy/release control is now qualified.

| Requirement/control | Previous status | Current status | Evidence / remaining gap |
| --- | --- | --- | --- |
| FR-010 | I | I | Local operational evidence; full integration/release gap remains |
| FR-011 | I | I | Local operational evidence; full integration/release gap remains |
| FR-012 | P | P | Local operational evidence; full integration/release gap remains |
| NFR-01 | P | P | Local operational evidence; full integration/release gap remains |
| NFR-02 | I | I | Local operational evidence; full integration/release gap remains |
| NFR-05 | I | I | Local operational evidence; full integration/release gap remains |
| NFR-06 | P | P | Local operational evidence; full integration/release gap remains |
| NFR-07 | I | I | Local operational evidence; full integration/release gap remains |
| NFR-08 | P | P | Local operational evidence; full integration/release gap remains |
| DEC-07 | P | P | Local operational evidence; full integration/release gap remains |
| DEC-08 | P | P | Local operational evidence; full integration/release gap remains |
| DEC-12 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M04-06 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M04-07 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M04-08 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M13-03 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M13-04 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M13-08 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M13-09 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M14-01 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M14-02 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M14-03 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M14-06 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M14-07 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M14-08 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M15-01 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M15-03 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M15-05 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M15-07 | Unknown: no separate whole-control status in targeted baseline | Unknown: whole-control status not reassessed by targeted operational qualification | Local operational evidence; full integration/release gap remains |
| PRD-M15-09 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M16-01 | I | I | Local operational evidence; full integration/release gap remains |
| PRD-M16-03 | P | P | Local operational evidence; full integration/release gap remains |
| PRD-M16-04 | I | I | Local operational evidence; full integration/release gap remains |
| PRD-M16-05 | P | P | Local operational evidence; full integration/release gap remains |

SRS/PRD scope, clinical restrictions and Node/Python/hosted/local amendment issues
are unchanged. All original 44 SRS primary requirements and 127 PRD entries remain
in the authoritative scope; this targeted operational phase is not another full audit.

## T. Updated nine-gate B03 operational table

| Gate | Before → after | Evidence and remaining work |
| --- | --- | --- |
| System-manager composition | MISSING → PARTIAL | New read-only inside-worker identity/admission composition, explicit operational artifact; trusted OS read/control transport and actual controller composition missing. |
| Artifact/service identity deployment | PARTIAL → PARTIAL | Six independent artifact pins, boot/invocation/PID-start/UID checks and configuration fingerprint; real root-owned release/native graph/identity deployment unverified. |
| Credential delivery | PARTIAL → PARTIAL | Existing pinned file loaders composed with PG/S3 constructor factory, expiry bounds and no fallback; real protected staging, issuer expiration/rotation/revocation and transport qualification remain. |
| Network delivery | MISSING → PARTIAL | Exact logical PG/S3 intent and fresh enforced-policy evidence required; no enforcement installed. Existing PrivateNetwork plus deny-all families prevents PG/S3 and loopback health. |
| Application containment | PARTIAL → PARTIAL | Application ownership/expiry guards, duplicate refusal and transactional rollback tested; actual Node/native-child cgroup containment remains unverified. |
| Controller-loss handling | PARTIAL → PARTIAL | Fresh exact-identity checks, bounded monitoring, terminal cancellation and rollback tested; real system-manager BindsTo/After loss proof pending. |
| Runtime-expiry handling | PARTIAL → PARTIAL | Pinned bounded grant, credential expiry cap, monotonic deadline, no reactivation and expiry rollback tested; real application RuntimeMaxSec/termination proof pending. |
| Supervised worker composition | PARTIAL → PARTIAL | Actual scheduler/coordinator/repository reused in isolated PG tests; explicit resource/processor/composition ports wired, no default live launcher/OS observer. |
| Deployment/runtime qualification | MISSING → MISSING | No deployed actual worker, live canary, production credentials/network, real application loss/expiry/cleanup proof or operational approval. |

Every row still requires separately approved actual deployment/runtime evidence;
remaining OS adapter code/design can be developed offline under a later approval.
No gate is made COMPLETE by mocked enforcement or synthetic Python probes.

## U. B03 regression/lease-safety status — CLOSED

B03.3 acceptance is recorded as instructed; current broad/offline regression
supports preservation. Historical B03.1/B03.2/B03.3 receipts are not rewritten and
old missing causal traces are not reconstructed or newly investigated.

## V. B03 operational implementation status — PARTIAL

Application composition/authority/credentials/configuration and safe transactional
publication are advanced and locally verified. Trusted system-manager/controller
transport, real artifact delivery and enforceable network/credential delivery remain.

## W. B03 deployment/runtime qualification status — OPEN

No actual deployed worker canary, real cgroup/native-child/controller-loss/expiry
proof, real credential transport, AWS verification or live processing authorization.
No production/clinical readiness claimed.

## X. B03.4 final outcome — PASS

Authorized safe local/disposable work is implemented and verified. Remaining work
is explicit deployment/transport/approval scope, not silently treated as done.
Known limits: trusted read/network ports are a security boundary; no default OS
transport; actual native dependency graph/processor construction and issuer expiry
are not proven; extra authority checks add latency requiring runtime qualification.
COMMIT dispatch is the authorization linearization point: already-dispatched commit
cannot be retroactively undone on concurrent loss. DB expiry probes are statement-
time checks under row locks, not proof of a server commit timestamp. Deferred/live
publication policy stronger than that requires separately reviewed DB/runtime work.
Default 30s drain fits nominal 60s stop window; maximum settings/driver cleanup and
uncooperative I/O must be qualified against real OS kill deadlines before activation.

## Y. Exact remaining work before B04

For full roadmap dependency closure: implement/review trusted system-manager OS/
controller composition; approve immutable release/service identity and least-
privilege credential staging/expiration; resolve enforceable PG/S3/health networking
without convenience unrestricted egress; separately approve seven live AWS checks,
exact synthetic scope/cutoff/grant and application canary; prove real native child,
controller-loss, runtime-expiry, restart/recovery and cleanup behavior. Preserve
records/evidence; no automatic cleanup/backfill. B04 additionally needs its approved
clinical information policy and treatment of pending formal architecture amendments.
No offline B04 work is inferred from this gate; any dependency exception needs
explicit separate approval.

## Z. Recommended next phase

**B03.5 — trusted system-manager transport and deployment-policy closure**, offline
implementation/fake testing plus a concrete Operations-reviewed credential/network/
artifact plan. No service creation, secrets staging, AWS or existing DB calls until
separate execution approval. This next phase was not executed.

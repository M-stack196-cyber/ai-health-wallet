# Phase 2.3 Stage C — preparation only

The production service remains disabled. Preparation does not load development
configuration, open a PostgreSQL pool, load AWS credentials, register patients,
upload objects, or start the real processing entry point. No migration,
dependency, IAM change, bucket change, credential change or Gate 3 cleanup is
introduced. SRS v3 §14.1–14.3 and V-02/V-05/V-06 remain the scope.

## Controller boundary

`backend/src/stage-c/controller.ts` implements two explicit dependency-injected
phases. `seedCanary` journals registration/upload intents before each one-shot
operation, registers exactly two distinct synthetic patients, uploads the
sentinel once, proposes a cutoff from PostgreSQL, then stops for review. It does
not create an approval file or activate a unit. `executeCanary` requires the
reviewed scope, cutoff and private approval pin; checks existing receipts;
starts only a supervised service; uploads one mixed PDF; observes automatic
completion; checks isolation/preservation; stops; and performs one sequential
idle restart with the same approval. It never constructs a worker, imports the
background runtime, or calls runOnce. The existing background service remains
the only component that schedules and claims jobs.

The CLI keeps --check local and read-only. The subsequent offline hardening
update wires the production adapters behind separate --seed and --activate
runtime approvals, a fresh pinned passing supervision receipt and exact-target
flags. See [the hardening document](PHASE_2_3_STAGE_C_HARDENING.md) for current
implementation and command grammar. Current host protection checks fail, so
neither live phase is approved or usable with the retained failed receipts.
Authorization strings in the dependency-injected controller API are not OS
security capabilities; the production factory additionally requires options
issued by the exact CLI parser. Same-OS-user operator trust still applies.

The future live composition must use the existing genuine fixture generators:
syntheticDigitalPdf for the sentinel and syntheticScannedPdf with an embedded
first page and scanned second page. No fixture text is logged. Expected retained
resources: two new patients, two documents, two processing jobs, two originals
and one extraction. The control patient owns zero documents. No resource is
automatically removed. Optional interruption/retry needs another approval and
is not part of the controller's primary two-document flow.

`adapters.ts` reuses the Gate 2 guarded storage adapter (A = sentinel, C = mixed),
including exact prefix, fixture SHA, pre-PUT journal, no signing, and blocked
runner-only deletion. Production upload compensation is unchanged. The
synthetic API adapter uses only an explicit ephemeral 127.0.0.1 HTTP endpoint,
existing authenticated registration/login/upload routes, bounded responses,
cancellation/deadlines and redirect refusal. Passwords and JWTs remain in memory;
register/upload attempts cannot be repeated after an ambiguous response. Only
the canary session can upload; only the control session performs cross-owner
404 checks for detail and download endpoints.

## Scope, cutoff and evidence

The existing patient-and-cutoff PostgreSQL predicates continue to govern
**discovery, claims, recovery and queue metrics**, with job leases and attempt
fences unchanged. No historical pending job or retained Gate 2 document becomes
eligible. Eligibility is patient + upload time, not a document-ID allowlist;
exclusive synthetic credentials and no uncontrolled uploader are prerequisites.

After sentinel commit, `proposeCutoff` reads PostgreSQL's clock, rounds UP to the
next millisecond and renders UTC independently of the session timezone.
`verifyDatabaseCutoff` compares timestamps inside PostgreSQL: sentinel strictly
before cutoff, database clock at/after cutoff, eligible document at/after cutoff,
exact scope document count and empty control scope. JS Date rounding does not
make eligibility decisions. The proposed time is saved once, reviewed, and
never recalculated on startup or restart. A future composition must wait with a
bounded poll for the database clock to reach that fixed cutoff.

The existing verifyApproval implementation enforces exact target/scope/cutoff,
independent SHA-256, owner-only 0700 parent/0600 single-link regular file,
O_NOFOLLOW, safe ancestors and bounded reads. Preparation reuses it before
startup/admission and restart. No actual approval file is created by preparation.
The pin and file must be independently controlled; an operator controlling both
remains trusted. EnvironmentFile creation/verification, artifact hash pinning,
read-only baseline transaction, approval-file provisioning and observer
poll/deadline wiring must be reviewed in the future live composition.

`evidence.ts` requires an existing owner-only private evidence directory, safe
non-symlink ancestors and successful Git exclusion before journal access. It
serializes writes, uses exclusive 0600 pending files, fsync + rename + directory
fsync and keeps a failed journal failed. Reads refuse missing receipts, insecure
files, oversized content and incorrect supplied checksums. Receipt checks bind
run, patient, document, prefix, fixture/original SHA, freshness, exact job count,
privacy/integrity and ordered page/attempt/completion evidence. Missing or stale
database/S3 receipts stop execution rather than being reconstructed.
`receipts.ts` reads one owner-scoped joined DB snapshot and combines it with a
fresh bounded exact-object read receipt supplied by the existing S3 reader.
No extracted medical text is selected or logged.

The live composition must compare all non-canary baseline row fingerprints via
the existing assertPreserved multiset comparison, including historical jobs;
retain exact old-object HEAD receipts; check the two exact new originals;
compare evidence fingerprints through idle polls/restart; and journal all exact
receipts privately. No bucket listing or old-object body read is required.

## Transient supervision

`supervision.ts` renders a run-specific user service and the exact systemd-run
argument vector; no shell interpolation, install section, boot enablement or
persistent system unit exists. The real entry is direct compiled Node, never
npm/tsx. A separately supervised owned controller unit is required by BindsTo
and After. Paths reject control characters, specifiers and traversal.

Required worker properties:

| Control | Value |
| --- | --- |
| Instances / application concurrency | one / one |
| Type / Restart | exec / no |
| RuntimeMaxSec | 600 |
| CPUQuota | 200% |
| MemoryMax | 3221225472 bytes (3 GiB) |
| TasksMax | 128 |
| KillMode / KillSignal | mixed / SIGTERM |
| TimeoutStopSec / SendSIGKILL | 60 / yes |
| NoNewPrivileges / ProtectControlGroups | yes / yes |
| Delegate / UMask | no / 0077 |
| stdout / stderr | null / null |

The private evidence journal supplies canary observability; aggregate health
remains loopback-only. Standard output/error are suppressed in the unit to
avoid unreviewed library errors entering a shared journal. EnvironmentFile must
be private and contain the exact fixed target, scope, cutoff and approval pin;
no secrets are placed in command-line arguments or printed.

Inspection must verify run description, UID, transient FragmentPath, exact
ExecStart, controller dependency, every effective resource property, exact
cgroup, main PID membership, cpu.max/memory.max/pids.max and read-only cgroup
mount. A PID alone never authorizes termination. Stop verifies ownership before
requesting shutdown, then requires inactive state, no main PID, no populated
cgroup/descendants, no temporary processing files and a released coordinator
lock. A lost launch acknowledgement still enters owned-unit reconciliation.
A missing/collected unit must be reconciled using pinned ownership and cgroup
receipts; it is not permission to kill another process. Unknown ownership,
survivors or incomplete cleanup fail closed. No fallback bare worker is allowed.
The controller itself needs bounded supervision and unit-level cancellation;
cooperative AbortSignals alone cannot stop a hung external adapter.

## Commands and approval gates

Run from backend. The first command runs only fake tests; the second creates
only the established separate network-isolated Stage B test cluster (fresh
credentials, no host ports or AWS). The third creates bounded transient units
containing only newly written synthetic Node/sleep fixtures, never the actual
service; it is separate from normal tests and the container harness.

```bash
npm run integration:stage-c:test
npm run integration:stage-b -- --execute-isolated
npm run integration:stage-c:supervision:test
```

A future private operator check, after separately provisioning/reviewing an
actual approval file, uses this exact documented grammar (placeholders are
protected values, not literal arguments):

```bash
npm run integration:stage-c -- --check \
  --profile ai-health-wallet --account 402909940531 \
  --bucket ai-health-wallet-records-402909940531 --region ap-southeast-2 \
  --run-id <stage-c-24-lowercase-hex> \
  --patient <approved-synthetic-uuid> --control-patient <control-uuid> \
  --cutoff <fixed-canonical-UTC-time> \
  --approval-file <absolute-private-file> --approval-sha256 <independent-pin>
```

Fresh read-only AWS verification at the next separately authorized gate:

```bash
npm run integration:s3-ocr -- --preflight \
  --profile ai-health-wallet --account 402909940531 \
  --bucket ai-health-wallet-records-402909940531 --region ap-southeast-2
```

All seven checks must pass again before each future write phase/start/restart:
identity, bucket region, bucket public-access block, policy privacy, owner
controls, encryption and account public-access block. The controller reuses
freshPreflight, which runs the existing checks rather than trusting a serialized
passing report. No live preflight runs during preparation.

Current live command grammar and the required production adapter composition
are documented in PHASE_2_3_STAGE_C_HARDENING.md. First resolve the host supervision
blocker in a separately approved offline change; only then review passing proof
and fresh AWS preflight, initial synthetic writes, actual fixed cutoff/scope and
separate activation approval. Do not run processing:service manually or reuse
the Gate 2 --run command (it directly invokes workers). No cleanup, broader
processing or later product phase is authorized.

## Verification results

The explicit fake suite covers missing/wrong targets, scope/cutoff/pin/permission
failures, historical receipt exclusion, forbidden startup paths, ownership,
effective limits, survivor refusal, cancellation, one-shot failures, restart
pin changes, receipt freshness/provenance, redaction, journal privacy and Git
exclusion. Isolated PostgreSQL checks cover microsecond boundaries, fixed cutoff,
real scoped discovery/claim/recovery/metrics, cross-owner rejection and UTC
clock proposals. The existing 358 regressions remain in the Stage B sequence,
with new explicit Stage C suites before typecheck/build/disabled smoke.

An offline synthetic host probe found effective CPU/memory/task limits and
native detached-child cgroup membership correct, but **the cgroup mount remained
writable despite ProtectControlGroups=yes**. This guard correctly failed.
Owned-unit shutdown was verified to leave an empty/removed cgroup and no native
child. Controller-loss/restart containment stages did not run after this failure.
Do not claim successful OS supervision or proceed live until an approved host
isolation arrangement enforces read-only cgroup access and the entire probe
passes. Preparation does not change systemd manager/OS configuration to bypass
this blocker. Final counts and private result locations are recorded in the
preparation delivery receipt.

## Recorded preparation execution

Final disposable run: stage-b-2120c6f0165f4c0964dbf395. Database 19,
security 15, authentication 29, documents 44, processing 162, Gate 2 runner 37,
Stage A 32, Stage B 20, Stage C fake 64 and Stage C PostgreSQL 6:
**428 passed, 0 failed, 0 skipped, 0 cancelled**. Strict typecheck, production
build and explicitly disabled compiled-entry smoke all exited successfully.
An initial run passed the existing 358 and new 64 fake checks, then stopped on
a new fixture's password-hash format constraint before the PostgreSQL assertions.
The synthetic fixture was corrected to the existing accepted format; final tests
used a fresh cluster. No failed attempt is represented as a passing run.

Host offline probe: effective CPU/memory/task limits and detached native-child
membership passed; effective read-only cgroup mounting failed; failure shutdown
proved the cgroup empty/removed and child gone. A final audit of all three probe
attempts found zero active owned units and zero surviving recorded children.
The controller-loss stage was not executed after the failed protection check.
No actual background service or live PostgreSQL/AWS operation ran.

Both disposable regression clusters removed their exact two containers, single
volume and image tag. Original containers were preserved. A SHA-256 baseline
comparison found only backend/package.json and infrastructure/stage-b/run-tests.ts
changed among 139 original protected files; the other 137 remained unchanged.
Private preparation receipts, logs, source hashes and copy-checksum verification
are retained under .private-evidence/phase-2.3-stage-c-preparation-2120c6f0165f4c0964dbf395/.
Directories are 0700, files 0600, Git ignored; original temporary evidence remains.
This receipt does not authorize live composition, registration, upload, service
activation, OS configuration changes or cleanup.

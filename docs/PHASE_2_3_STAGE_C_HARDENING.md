# Phase 2.3 Stage C — offline preparation hardening

This work authorizes code, isolated tests and harmless owned supervision probes.
It does not authorize live seeding, live AWS preflight, upload, service activation,
OS configuration changes or Gate 3 cleanup. The normal API and processing entry
remain unchanged and automatic processing remains disabled by default.

## Cgroup finding and host limitation

Host systemd: 255.4-1ubuntu8.18. Available cgroup v2 controllers include cpu,
memory and pids (also cpuset, io, hugetlb, rdma, misc and dmem). These resource
controllers worked in the bounded synthetic unit; controller availability was
not the protection failure.

The original mount finding is genuine. The new probe runs inspectInside inside
the actual supervised fixture. It reads its own namespace/mount metadata and
checks the actual cgroup interfaces for the unit, its parent and the hierarchy
root. It calls access(W_OK) and open(O_WRONLY|O_NOFOLLOW), followed only by close.
There is no write, O_TRUNC/O_CREAT, migration, mkdir, limit change or cgroup
ownership change. Each interface must be on a read-only effective mount and
reject write-only open. DAC denial alone on a writable mount does not pass.
The longest matching mount is selected, so a writable filesystem superblock
with a read-only bind mount is not incorrectly classified as writable.

The baseline allowed write-only open on six interfaces, including own limits
and parent cgroup.procs. ProtectControlGroups=yes was accepted as a property,
but did not create the required read-only mount. The version-specific manual
explicitly says this option is unsupported in per-user services:
https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#ProtectControlGroups=
The installed man page confirms this restriction. The earlier suggestion that
PrivateUsers alone would fix it was tested rather than assumed: a distinct user
namespace was created, but the mount namespace and writable interfaces remained.

A second synthetic candidate additionally requested PrivateMounts=yes and
ReadOnlyPaths=/sys/fs/cgroup, retaining ProtectControlGroups, PrivateUsers,
NoNewPrivileges and Delegate=no. The inside checks still failed on this host.
These stronger requests remain in the generated specification; they are never
accepted as proof by themselves. No global manager configuration, AppArmor/sysctl,
other service, privileged container or cgroup setting was changed.

CPU=200%, memory=3 GiB, tasks=128, runtime=600s, stop timeout=60s, exact unit
ownership, main PID, detached native child's cgroup and failure cleanup were
checked. Graceful/controller-loss acceptance stages stop when protection fails;
they must not be reported as passed. The finally path stops only exact-owned
probe units and verifies empty/removed cgroups and no surviving recorded child.
Live activation remains blocked until a separately reviewed host/supervision
arrangement passes every protection and cleanup stage. Do not weaken the guard.

## Completed adapter composition

The existing controller now has production adapters in live-runtime.ts, with
shared testable wiring in live-composition.ts. The CLI lazily imports runtime
only after parseLive accepts exact-target flags plus the distinct phase approval
and --approve-live-writes. A private in-memory capability also prevents manually
constructed/serialized options from authorizing the production factory.
No import or ordinary --check starts external clients or listeners.

Before any AWS request or development database connection, runtime requires a
private, independently SHA-pinned successful version-2 supervision receipt:
fresh within one hour, same boot ID, same Node executable and compiled protection
artifacts, and all five required enforcement/containment/cleanup checks passed.
Current host receipts fail this guard. Passing receipt files are never generated
from this host's failed probe. An operator who controls receipt and pin remains
trusted; this is not a defense against the same OS user fabricating both.

After local guards, reuse loadPinnedProfile/awsReadFor/freshPreflight and all
seven existing security checks for the exact personal profile/account/region/
bucket/prefix. Only then construct bounded PG and pinned-credential S3 clients.
The SDK uses maxAttempts=1 to avoid automatic upload retries; profile hashes are
checked around requests. Live operations are not performed by offline tests.

Seeding uses the existing authenticated API on an ephemeral loopback listener,
existing genuine PDF fixture generators and guarded storage. It journals intent
before registration and before PUT. Exactly two synthetic patients and one
sentinel are allowed. The cutoff is proposed once from PostgreSQL after commit;
no fallback cutoff is invented and no approval file is silently provisioned.
The command stops at seeded state. A failed/ambiguous run cannot be resumed or
replayed automatically.

To support the separate activation process, two synthetic passwords are retained
only in credentials.json (owner 0600, private 0700 Git-excluded directory). They
are saved before registration so an ambiguous request has an exact receipt.
JWTs remain in memory. Activation reauthenticates and checks /patients/me matches
each recorded patient; it does not register replacements or discover IDs by
email. Passwords, JWTs, object keys and medical contents never enter output.
These credentials are sensitive retained evidence and require later explicit
retention/cleanup review; this work does not delete them or any live resource.

Activation requires exact seeded manifest, receipts, credentials, baseline,
fixtures, scope, fixed cutoff and approval-file SHA. Only seeded state can enter;
missing/inconsistent evidence fails closed. The private EnvironmentFile derives
from existing runtime settings with one concurrency, one attempt, fixed scope/
cutoff/pin and private temp directories. Production .env is never changed.
Compiled artifacts and lockfile are fingerprinted at seeding and checked before
activation and each sequential service start.

Only the existing compiled background-entry.js performs processing. The controller
never calls runOnce, creates a worker or implements OCR. Existing patient/cutoff
SQL predicates, claims, recovery, metrics, leases and atomic persistence remain
authoritative. The transient service uses an inside-protection ExecStartPre;
failure prevents executing the real worker. Unit identity/ExecStart/properties,
inside attestation, actual main-process mount and effective limits must all pass.
A private listener must belong to the main PID before health is trusted. Readiness
also requires idle queue/active/failure aggregates. The coordinator and process
checks refuse a competing background worker; nothing stops an unrelated unit.

Preservation adapters use repeatable-read read-only row snapshots, exact new-row
allowlists and retained old-object HEAD receipts. New originals use the existing
bounded secure reader, source SHA, version/ETag fences, retained metadata and an
unsigned exact-object privacy check. Extraction verification checks current
attempt, atomic states, ordered PDF.js/Tesseract page provenance and synthetic
text order without logging text. Three idle observations precede shutdown and
repeat after one sequential restart with the same approval. Stop verifies owned
identity even when a safety property has failed, then cgroup descendants, native
children, temp directories and advisory lock. No restoration, upload retry,
object deletion or record cleanup is attempted after failure.

## Offline checks and commands

```bash
# Fake dependencies only; no development database or AWS.
npm run integration:stage-c:test

# Entire baseline and new DB checks in a fresh Stage B disposable cluster.
npm run integration:stage-b -- --execute-isolated

# Harmless synthetic OS fixtures only; fails closed on this host.
npm run build
npm run integration:stage-c:supervision:test
```

The new isolated DB composition test uses the real authenticated API, trigger,
PostgreSQL repositories, lease-fenced persistence, existing scheduler/OCR and
synthetic mixed PDF, with fake S3 and fake supervisor status. It performs seed,
separate re-login, automatic completion, sentinel exclusion, idle restart,
cleanup and preservation checks. Its identity/network/database-marker checks
precede fixture mutations. Fake supervisor status is not OS isolation evidence.

## Next approval boundary — commands are not authorized now

First resolve supervision in a separately approved offline change and pass the
entire OS probe. Fresh read-only AWS checks may then be separately authorized:

```bash
npm run integration:s3-ocr -- --preflight \
  --profile ai-health-wallet --account 402909940531 \
  --bucket ai-health-wallet-records-402909940531 --region ap-southeast-2
```

Only after explicit initial-write approval, the seed grammar is:

```bash
npm run integration:stage-c -- --seed \
  --approve-live-writes --approve-synthetic-seeding \
  --profile ai-health-wallet --account 402909940531 \
  --bucket ai-health-wallet-records-402909940531 --region ap-southeast-2 \
  --run-id <stage-c-24-hex> --evidence-dir <existing-private-ignored-directory> \
  --supervision-receipt <fresh-passing-private-report> --supervision-sha256 <pin>
```

After reviewing the resulting exact scope/cutoff/receipts and separately
provisioning the private approval file, another approval must authorize service
activation plus the one mixed upload. The controller must itself be a transient
owned service (direct compiled Node CLI as MainPID), with Restart=no,
RuntimeMaxSec=900, CPUQuota=50%, MemoryMax=805306368, TasksMax=64, UMask=0077,
NoNewPrivileges=yes, Delegate=no, PrivateUsers=yes, PrivateMounts=yes,
ReadOnlyPaths=/sys/fs/cgroup, ProtectControlGroups=yes, KillMode=control-group,
and null stdout/stderr. Name: health-wallet-<run-id>-controller.service.
Its controller invocation uses:

```text
<node> <backend>/dist/stage-c/cli.js --activate
  --approve-live-writes --approve-service-activation
  --profile ai-health-wallet --account 402909940531
  --bucket ai-health-wallet-records-402909940531 --region ap-southeast-2
  --run-id <same-run> --evidence-dir <same-evidence-directory>
  --supervision-receipt <fresh-passing-private-report> --supervision-sha256 <pin>
  --patient <approved-canary-uuid> --control-patient <recorded-control-uuid>
  --cutoff <same-fixed-UTC-cutoff>
  --approval-file <private-file> --approval-sha256 <independent-pin>
```

Current host protections and failed proof prevent this sequence. The flags only
make approved implementation reachable; they do not constitute user permission.
Any ambiguous write requires manual exact-resource reconciliation and another
review. No automatic restart/retry or Gate 3 cleanup is authorized.

## Recorded final verification

Final fresh run: stage-b-c3e7d4bc2bf4dc572b6f44be. **470 passed, 0 failed,
0 skipped, 0 cancelled**. Existing backend 269, manual-runner 37, Stage A 32,
Stage B 20, original Stage C 70, new hardening 42 (37 fake + 5 PostgreSQL).
The aggregate Stage C commands report 101 fake and 11 PostgreSQL tests.
Strict typecheck, production build and explicitly disabled compiled-entry smoke
all exited successfully inside isolation. The final source snapshot includes the
relative-worker-path and private EnvironmentFile serialization checks.
A synthetic host fixture also verified literal environment values before
performing inside cgroup checks; no real secret was used or printed.

The first new composition test completed its controller flow but expected the
wrong existing initial document status. The API correctly creates a document
with processing_status=processing and its job pending/attempt zero. That test
expectation was corrected; production behavior was unchanged. The next fresh
run passed 467 checks; the final run adds three policy checks and passes 470.
All attempts retain their own actual receipts rather than relabelling failures.

Final host probe: /tmp/health-wallet-stage-c-hardening-os-wrY45O/. Protection
failed again; effective resource limits and native membership passed, failure
cleanup succeeded, and later acceptance stages were not executed. Its failed
version-2 receipt cannot authorize a live factory. Root cause remains the
unsupported/unapplied user-service filesystem protection on this systemd 255
host; no global configuration was changed to bypass it.

Created stage-c modules: inside-entry.ts, inside-protection.ts, live-composition.ts,
live-runtime.ts, preservation.ts, private-files.ts, proof.ts, runtime-flags.ts,
runtime-policies.ts and systemd-adapter.ts. Created tests: hardening.check.ts and
hardening.canary.ts. Modified stage-c adapters.ts, cli.ts, evidence.ts, receipts.ts
and supervision.ts; the existing supervision-probe.ts; backend/package.json's
explicit DB-test glob; and the earlier preparation document. This document is
new. No existing regression assertion, migration, API/OCR/worker implementation,
AWS configuration, .env, lockfile or protected evidence file changed.

Private hardening evidence is retained in
.private-evidence/phase-2.3-stage-c-hardening-c3e7d4bc2bf4dc572b6f44be/.
It contains final/prior/failing run receipts, negative OS proofs, redacted audit,
source fingerprints and copy checksum verification. Original temporary evidence
is retained. New directories are 0700, files 0600 and Git excluded.
Next approval is a supported supervision/isolation arrangement and another
offline probe. No live seed or activation approval has been granted.

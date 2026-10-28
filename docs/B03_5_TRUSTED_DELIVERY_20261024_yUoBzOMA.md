# B03.5 — Trusted system-manager transport and deployment-policy closure

Date: **2026-10-24 (Asia/Karachi)**. Result: **PASS for the authorized offline implementation/qualification scope**. Whole B03 operational implementation remains **PARTIAL**, deployment/runtime qualification **OPEN**, regression/lease safety **CLOSED**. This report is not deployment, clinical, production or real-patient authorization. No B04 or next major phase started.

## Scope, authority and preservation

User explicitly approved B03.5 offline/local/disposable work and inactive repository deployment artifacts. SRS v3 and PRD v1.0 remain pinned and unchanged. Reused B01–B03.4 code, decisions, qualification receipts and the accepted/PARTIAL Module 01 review. The old module-number review strategy is superseded by dependency-ordered approved phases, with a stop after each approved phase. Module 01 was not re-reviewed or rebuilt; Module 02 was not arbitrarily started.

Targeted preflight: project `/home/m-tayyab-aslam/Music/ai-health-wallet`, branch `main`, existing untracked source roots preserved. Pinned247 public source files; verified130 B03.4 archived evidence files plus33 Module01 evidence files against their existing indexes. No git reset/clean, commit/push/merge, full repository re-audit, package installation or historical receipt replacement. All unaffected source/migration/previous report hashes are rechecked at publication.

No AWS/S3/RDS/development/production DB/model calls, real credentials, real medical records, systemd service operations, host firewall/daemon/network changes, privileged services, persistent deployment or processing activation. Native positive file tests use only newly created synthetic private temporary directories. No Docker environments were required or accessed. Original temporary evidence is retained.

## A. Fully implemented and verified offline

1. **Read-only system-manager observation** in `linux-system-observer.ts`: exact two-unit scope, strict bounded `show` decoding, kernel PID/start/UID/boot and descendant cgroup checks, manager evidence bracketing, pinned Node executable identity, effective resource data, typed address-family callback and fresh inside-proof binding. Rejects unrelated units, stale proof, invocation/PID replacement, unknown/duplicate properties, writable cgroup aliases and unbounded limits. A mount listing alone cannot certify protection. Optional native `systemctl --system show` is fixed-argv, no-shell, minimal-environment, 800ms/64KiB and independently binary-pinned; native kernel-read capability is path-allowlisted. These native service/proc reads were not executed here; fake I/O tests prove application parsing/control, not host truth.
2. **Exact-control client transport** in `system-manager-transport.ts`: explicit system-manager capability for the existing supervisor; independently pinned broker/deployment binding; single-attempt absent-unit/identity/cgroup start; nonce-bound bounded broker receipts and read-only ambiguous-start reconciliation; exact identity/invocation/process requests; replacement/active-reset/aborted-control refusal; no fallback, broad kill or local mutation command. Existing supervisor is unchanged and correctly refuses a failed start after reconciliation and targeted owned cleanup. Fake broker tests include successful start/cleanup and lost acknowledgements.
3. **Programmatic supervised composition** in `system-operational-composition.ts`: explicit configuration pin; new observer; existing protected credential loader; existing seven security-preflight rules through the file-credential execution capability; existing resource/processor/scheduler/repository/worker ports; fixed patient/cutoff/grant/lease behavior. No controller `runOnce()`, second processing pipeline or user-manager switch. Disabled launch does not evaluate delivery/credential getters. No real transport/default OS broker is silently installed.
4. **Artifact verification** in `immutable-artifacts.ts`: Linux fd-relative no-follow traversal, root-owned safe ancestors, single-link regular files, bounds, independent hashes, post-read/path checks, stable-identity cache and failure on replacement/unsafe metadata/close errors. Separate release and OS/native-tool pins are modeled. `verifyDeclaredArtifacts()` checks independently pinned canonical descriptor plus all declared immutable observations and explicitly returns `fullRuntimeDependencyClosureVerified:false`.
5. **Private health/readiness delivery** in `receipt-health.ts` and `private-health-sink.ts`: injected health override instead of a network listener in system composition; fixed aggregate schema, boot/invocation/config binding, sequence/1500ms freshness, bounded serialized publication/drain and final non-live receipt. Native sink uses private0700 directory/0600 atomic files, fixed path, collision/replacement refusal, descriptor-relative writes and exact-owned temporary cleanup. Stale, replayed, malformed, hung or failed writes cannot be reported as verified cleanup. Developer/user-manager loopback health remains the default and unchanged.
6. **Credential lifetime and shutdown budget**: explicit system composition caps drain at30s and requires6s admission-to-declared-credential-expiry headroom, reusing existing1s admission/5s close bounds. Existing `startOperational` behavior remains compatible through optional default-zero headroom and optional health port. Current600s maximum grant, terminal expiry/control-loss handling, no same-invocation reactivation and database lease fencing remain intact. No existing credential schema or developer-mode loader was changed.
7. **Inactive deployment design/tooling**: canonical checksum-pinned descriptor CLI, exact release/native paths, no embedded credential material, fixed no-write AWS/PG role authorization policy, private health policy and preserve-data rollback/recovery rules. Explicit package commands only; no startup hooks or new dependencies. All example IDs/hashes/sizes are synthetic placeholders. `.service.in` files have no `[Install]`, retain false processing flags, unchanged typed security definitions and deliberately unresolved deny-all D-Bus placeholder. They are not installable/approved service units.
8. **Traceability/completeness tooling**: all16 modules/127 entries remain in central Markdown and JSON with exact source descriptions/references/acceptance, dependencies, code coverage, existing implementation/evidence, delivery status and final acceptance. Added strict Markdown-to-ledger wording/status checks and negative completion tests. No source requirement, accepted Module01 evidence or code-status label was upgraded by this phase.

## B. What remains partial or unimplemented

- The exact-control **client/protocol is implemented; the privileged broker server, authenticated IPC/peer verification, durable journal, kernel compare-and-control and root privilege policy are not implemented or deployed**. `comparisonEnforced:true` from a fake is not OS proof. A `show` then `stop` sequence is deliberately not supplied because it cannot eliminate invocation-replacement races. Root/out-of-band administration remains a trust boundary.
- Native observer assembly still needs authoritative dynamic-identity allocation, typed D-Bus family policy and fresh main-process inside-proof providers. Current actual systemd output encoding, privileges and observation latency are unverified. Native source/read-only constructors are not equivalent to live supervised observation.
- Immutable **declared** files can be checked; a complete real release/native/loader/library/data inventory is not supplied. No `/opt` release is staged. Existing OCR hardcodes `/usr/bin/prlimit`, Tesseract and pdftoppm, and `eng`; no relocation/port was attempted. Example Tesseract5 data path must be confirmed or revised through approved packaging; no installed version/data claim.
- Systemd credential bootstrap remains unresolved: dynamic UID/InvocationID become known during unit creation, while selected file owners/grant/configuration must independently pin those values. Root broker/barrier issuance needs a reviewed design. `LoadCredential` template lines do not solve it. Actual issuer expiry, PG revocation, rotation and early-revocation error behavior are not established by a declared timestamp.
- **Networking is design/authorization policy, not enforcement.** Existing PrivateNetwork plus typed deny-all families still blocks direct PG/S3. Proposed inherited preconnected-descriptor scoped relay preserves worker isolation; its broker, native/SDK/PG stream bridges, TLS/DNS/endpoint enforcement and fresh attestation remain unimplemented and require feasibility/Operations review. No generic proxy or unrestricted egress is enabled.
- Controller and worker have different dynamic UIDs. A trusted root read broker must safely deliver aggregate health/inside proof without relaxing0700/0600. Health cannot authorize processing or prove application containment. Existing Stage C CLI remains its existing implementation; actual system-controller/bootstrap entry wiring is not claimed complete by a template referencing its compatibility path.
- Current application DB-role identity is preserved; an OCR-only restricted role needs separate minimum-privilege analysis/approval. No SQL privileges, roles, migrations, IAM or credentials are modified.
- Actual Node/native OCR cgroup containment, controller-loss/RuntimeMaxSec termination, cancellation under real slow I/O, process cleanup, restart recovery and live canary remain unverified. Python probes and fake process tables are not promoted to application proof.

## C. Separately authorized deployment/runtime work

Before live execution, Operations must approve privileged broker identity/channel/journal/control semantics; bootstrap/issuer ownership and expiration; root-owned full release/native graph; and descriptor-relay/driver/network implementation. These are concrete policy/implementation gates, not a request to relax protections. Complete remaining offline implementation against that reviewed design before seeking service activation.

A later execution gate must separately authorize credential staging, exact transient units, current seven AWS checks, synthetic scope/fixed DB-clock cutoff, one coordinator/worker, original preservation and actual Node/native loss/expiry/restart/cleanup observations. No historical/backfill admissions, generic worker or Gate3 cleanup. Real patient use additionally needs appointed clinical/privacy/legal/operations approvals. Formal local-hosted and Node-Python SRS amendments remain pending. No B04 dependency exception is inferred.

## Deployment/security and operational design

The selected service remains `document-processing-operational`, using the pinned release-local Node and `backend/dist/processing/operational-entry.js`. It requires explicit system-files/config/grant/capabilities; normal application startup never starts it. Supplied resources/processor remain the existing implementation. Runtime grant binds run/deployment/configuration and both invocation IDs; SQL scope/cutoff applies to discovery, claims, recovery and metrics. Original integrity/attempt/lease persistence contracts are unchanged.

The inactive typed definitions retain worker CPU200%, memory3GiB, TasksMax128, runtime600s, Restart=no, SIGTERM, mixed cgroup kill, stop60s and final SIGKILL; controller CPU50%, memory768MiB, TasksMax64, runtime900s and control-group kill. BindsTo/After remain exact same-manager controller links. Private network/devices/home/system/tmp, no capabilities, no delegation and read-only cgroups remain intact. Unit-file empty address-family assignment resets restrictions, so the template intentionally uses an unresolved marker rather than weakening deny-all.

Credential source proposal: root-private `/run/health-wallet-delivery/<run>`; existing pinned file envelopes under `/run/credentials/<exact-unit>`; no real secret in files/args/logs/receipts/source or developer-home copy. Exact ai-health-wallet/402909940531/ap-southeast-2/ai-health-wallet-records-402909940531/medical-documents targets only. Narrow relay policy admits PGloopback5433/pool4 and seven account/bucket security reads plus exact receipt-authorized GetObject. No object writes/deletes, arbitrary bucket/key, role assumption, redirect, general proxy or hosted/paid model fallback.

Health uses private receipts instead of TCP; existing loopback health is retained for original developer/user composition. Every receipt has a separate kind/version from application supervision proof. No application-system-supervision proof receipt is issued here. Namespace/family/inside assertions in fakes remain explicitly mocked.

Source code changes are intentionally small integration seams around the existing pipeline. No database transaction spans OCR/model generation. COMMIT dispatch remains the authorization linearization point: an already-dispatched commit cannot be retroactively undone on later authority loss. Database lease probes establish statement-time validity, not proof of server commit timestamp.

Full design, inactive artifacts, offline command, rollback and recovery controls: [processing-delivery README](../infrastructure/processing-delivery/README.md).

## Exact testing and development corrections

| Check | Result / scope |
| --- | --- |
| Focused B03.5 stable cases before final regression | 76/76, synthetic fake ports plus private temporary filesystem |
| Single final meaningful broad offline set | **1000 passed** =25 baseline +341 Python +634 TypeScript; zero skipped/failed/cancelled; no blocked checks |
| Contract compatibility | PASS |
| TypeScript typecheck / production build in broad set | PASS |
| Original OCR/summary disabled entries | PASS |
| Completeness tool | PASS: all16/127, FR36/NFR8/DEC12/CFG14/AT14/V24 retained |
| Completeness negative/unit tests | **23/23 PASS** |
| Canonical example descriptor CLI | PASS after correcting the owned test copy's mode; `activationAllowed:false` |
| Compiled operational default / enabled-without-composition smoke | disabled exit0 / refused expected exit1 |
| Final parser compatibility correction | **1/1 targeted case PASS**, full final-source typecheck/build PASS |

The final parser correction normalizes systemd numeric15 to SIGTERM exactly like the existing user adapter; other signal values remain rejected. It was identified after the one broad run. Only that new case plus final typecheck/build were run; the broad set was **not repeated**. Thus77 distinct new B03.5 cases passed across the76-case broad/focused evidence and1-case targeted follow-up, not a claim all77 ran in the same broad invocation. Final source pins and the pre-normalization broad snapshot are both retained. Do not sum overlapping focused/broad counts.

No disposable/live PostgreSQL suite was rerun: this phase does not change SQL, migrations, repository/lease functions or extraction engines. B03.4's810/810 disposable qualification and accepted B03.3 safety remain preserved historical evidence, not fresh B03.5 DB results. The new optional health/headroom and transport paths are exercised with fake dependencies. Original Module01 evidence remains accepted and was not re-reviewed.

Development failures are retained, not counted as passing: stale historical B01 inventory refused the newer approved source (replaced only by this run's private manifest); initial readonly-array type errors were corrected; sandboxed default Node child reporting yielded only a file wrapper and was not accepted as real case coverage; focused tests used explicit no-process isolation to obtain actual case counts. A test's lost-ack success expectation was corrected to the unchanged supervisor's intended fail-closed cleanup behavior. Native health checks refused sandbox `/tmp` UID65534; host-context tests passed without changing guards. Automatic permission review timed out before two commands launched; authorized short-command retries succeeded, without a second broad launch.

The post-broad example check correctly refused a copyfile-created0664 descriptor. SHA/content matched the0600 original. Only the owned private test copy's mode was tightened to0600; no validation weakened. Corrected targeted descriptor/smoke checks passed. The legacy `full_851_regression_verified` predicate remains false because it encodes the old510-TS count; current `all_executed_checks_passed:true`, zero blocked checks and exact current counts govern this run. No historical helper or receipt was rewritten to alter that predicate.

## Nine B03 operational gates

| Gate | Current | Offline evidence added / remaining gate |
| --- | --- | --- |
| System-manager composition | PARTIAL | Native read-only observation, nonce-bound client and programmatic composition; real privileged broker/channel/controller/bootstrap missing |
| Artifact/service identity deployment | PARTIAL | No-follow/hash/read-only validation, declared release and OS graph; no real complete root-owned release installed/qualified |
| Credential delivery | PARTIAL | Existing files integrated, expiry headroom/drain and inactive delivery contract; issuer/bootstrap/staging/revocation pending |
| Network delivery | PARTIAL | Closed request allowlist and inherited-descriptor proposal; enforcement and actual driver delivery absent |
| Application containment | PARTIAL | Typed unchanged security/resource templates and application guards; actual Node/OCR/cgroup proof pending |
| Controller-loss handling | PARTIAL | Existing owner checks/cancellation plus new observation/client tests; actual BindsTo/native-child proof pending |
| Runtime-expiry handling | PARTIAL | Grant/headroom/rejection tests and unchanged RuntimeMaxSec design; actual issuer/systemd/node termination pending |
| Supervised worker composition | PARTIAL | Explicit guarded existing-worker composition/private health; no deployable default launcher/OS transport assembly |
| Deployment/runtime qualification | MISSING | No actual application canary, deployment, live account/storage/network/credential or native lifecycle proof |

## PRD/SRS impact and acceptance

Supports FR-010/011/012; NFR-01/02/05/06/07/08; DEC-07/08/12 and the following22 PRD controls. No primary SRS or whole PRD entry is promoted complete. Existing code-status labels remain unchanged; explicit delivery status is now separate (COMPLETE/PARTIAL/MISSING/BLOCKED), with all final acceptance OPEN. The completed Module01 backend qualification remains accepted/PARTIAL, with recovery, session invalidation, downstream access, mobile and final security/E2E dependencies still tracked.

| PRD ID | Previous code coverage → current | B03.5 evidence / remaining acceptance |
| --- | --- | --- |
| PRD-M04-06 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M04-07 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M04-08 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M13-03 | Implemented → Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M13-04 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M13-08 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M13-09 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M14-01 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M14-02 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M14-03 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M14-06 | Implemented → Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M14-07 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M14-08 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M15-01 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M15-03 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M15-05 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M15-07 | Missing → Missing | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M15-09 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M16-01 | Implemented → Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M16-03 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M16-04 | Implemented → Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |
| PRD-M16-05 | Partially Implemented → Partially Implemented | Offline transport/composition/policy/health tests; full module/live/deployment acceptance remains OPEN |

The master tracker is now the owner-requested central127-row checklist with per-entry description, source mapping, delivery state, supporting implementation/evidence, dependencies, remaining work and final acceptance. Old code labels17 implemented/49 partial/61 missing are preserved as component coverage, not product completion. Independent delivery labels are66 PARTIAL/57 MISSING/4 BLOCKED/0 COMPLETE; blocked policy/clinical/privacy entries remain present. No unrelated feature was upgraded. Source CFG-08 session-citation mismatch and formal architecture amendments are preserved pending resolution.

## Files and evidence

Created/modified files are listed in the machine receipt. Production-facing changes are8 new transport/artifact/policy/health/composition modules and two optional seams in existing background/runtime composition; no API/OCR/lease implementation replacement. Added2 synthetic fixture/check files,2 explicit package commands, inactive artifacts/README, checker/tracker extensions and tracking/report/receipt documents. No dependency/lockfile, migration0001–0004, user-manager implementation, frozen benchmark/AI contract or accepted Module01 source changes.

Private archive: `.private-evidence/b03.5-trusted-delivery-20261024-yUoBzOMA`; directory0700/file0600; Git-excluded, indexed/hash-verified. It contains original-file rollback copies, exact published source/docs, final private source manifest, focused/failure/broad/targeted/smoke logs and preservation/cleanup metadata. Original `/tmp/health-wallet-b035-yUoBzOMA` and `/tmp/health-wallet-b01-t7ipz9d8` remain. There is no Gate3 cleanup or patient/object deletion.

Tests returned and joined their owned processes/listeners. Exact test-owned health/manifest temporary prefixes are checked absent under the run's private temporary roots. No test containers, services, AWS objects or DB rows were created, so no such cleanup is claimed or performed. Existing container/service states were not queried; no assertion of fresh live-state preservation is inferred from old receipts.

## Rollback, residual risks and next approval

Code rollback is reviewable from the receipt/archive: restore only this run's modified public files from original-file copies and remove only newly added files after hash verification; retain all evidence. Never use Git clean/reset on the pre-existing untracked repository. No operational-state or data rollback is needed. A later deployed rollback must revoke admission and use exact proven invocation control; unknown ownership means no destructive action. Recovery keeps originals/evidence, scoped SQL/cutoff and fresh grant/identity; no historical backfill, upload retry, re-enable or automatic cleanup.

Residual risks include the unimplemented privileged broker/network/bootstrap paths; unqualified native/root/SDK/DB access; unverified actual source/dependency graph and host encodings; authority/observation latency and real I/O kill deadlines; application-supplied health/inside proof trust and same-UID compromise; commit dispatch races; declared-versus-issuer credential expiry; pending Operations/clinical/privacy appointments and formal SRS amendments. These block deployment, not permission to preserve the successful offline implementation.

**B03.5 offline outcome: PASS. B03 regression/lease safety CLOSED; operational implementation PARTIAL; deployment/runtime qualification OPEN.** Stop for owner review. The next gate is concrete Operations/design approval for broker/credential bootstrap/full graph/inherited-descriptor delivery, then scoped remaining offline implementation against that reviewed contract. No actual units, credentials, AWS/current DB canary, wider activation or B04 is authorized by this report.

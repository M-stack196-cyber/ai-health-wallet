# B03.7 — Native authority, broker and credential transport closure

2026-10-24, run5uWELmBA. **PASS for the approved offline native-component implementation/qualification.** Native library contracts are implemented and tested within the explicit trusted-root/exclusive-writer model. **Whole trusted delivery, operational implementation and offline deployment readiness remain PARTIAL; live qualification OPEN.** This is not a declaration that B03 or any whole PRD requirement is complete. No B04.

## A. Scope and authorization confirmation

Only B03.7 approved offline/local/synthetic implementation. Later attachment repeats the same authorization; work was not restarted or expanded. No systemctl/busctl command, system-manager connection, systemd unit, real credential, AWS/S3/RDS/development/production DB, medical record, model, network/firewall change, package installation, migration or commit/push/merge. Root-only code exists but was not executed under root. Native syscall tests use test-owned same-UID fixtures.

## B. Targeted preflight and Git state

Verified `/home/m-tayyab-aslam/Music/ai-health-wallet`, branch main; existing untracked .gitignore/ai-service/backend/docs/infrastructure/shared preserved. Targeted prior-native/broker/credential/deployment review only, no unrelated audit. Public-source/SRS/PRD hashes pinned; all unchanged sources and migrations verified again at publication. Normal API/user-manager/manual-runner behavior preserved; no existing production source modified by this phase.

## C. B03.6 evidence reused

Report pin0900f64de74c043440851c7eb32b67eb0ca734b3d2aa6a6155be43e5cdcb0efa and receipt pind2f841f8fe09e66d8d9f1a2d55f149cc5c70551eb3dc06b1be6305459aa02d20 verified. All91 indexed archive files verified (92 including index). Existing broker, HMAC/nonce protocol, fsync journal, immutable reader, file parsers, worker/coordinator/repository/lease guards, runtime authority, cancellation and health reused. B03.6's1102 and historical disposable810 checks retained as historical evidence, not independently rerun DB results.

## D. Native-authority starting assessment

B03.6 had broker/comparison interfaces but no native manager backend, kernel peer attribution, dynamic cross-UID transport, recoverable issuer or fully assembled native observation. These were real implementation gaps. Full release inventory and PG/S3 bridges remain other B03 work.

## E. Native system-manager observation result

Implemented persistent libsystemd sd-bus ctypes binding, typed minimal property collection, canonical UnitSnapshot/GID/substate/epoch observations and strict Node decoding. Native kernel reads bracket PID/start/UID/GID, boot, cgroup, node executable, mount aliases and limits with fresh manager identity/MainPID/state. Partial, malformed, replaced, stale, unbounded or wrong artifacts/configurations refuse. No Environment/log/body collection. Injectable runner/fake bus avoids all host manager access.

Fresh inside proofs reuse existing non-mutating inspectInside. Exact SO_PEERCRED-authenticated main-process challenge is checked against identity-only observation, then stored privately; full admission separately requires fresh proof and readonly mount aliases. Identity-only bootstrap does not imply containment. Actual installed-property/ABI behavior and main-process proof scheduling await deployment qualification.

## F. Exclusive authority model result

Implemented no-follow private flock, persistent bus connection, Unit.Ref/Unref, full revalidation immediately before control of the retained object, Restart=no, mode=fail, stable manager owner,900ms native/1000ms Node bounds and poisoned uncertainty. No InvocationID CAS exists in systemd; this protocol serializes permitted broker writers. Root, PID1, system bus and privileged out-of-band administrators remain trusted. Production privilege policy must exclude other untrusted writers. Manager job dispatch is the linearization point and cannot be retroactively undone after acceptance. No show-then-stop substitute or PID-kill fallback.

## G. Native broker backend result

NativeBridge connects the existing versioned nonce broker to concrete native methods, with exact frozen definitions, deployment/native-policy hashes, unit/epoch/process identity and current authorization. Only observe/start-absent/stop-exact/reset-exact, two planned observation names and worker-only mutation. Typed `(bas)` allowlist true/empty family tuple preserves network denial. Caller cannot add Environment, capabilities, executable args or arbitrary unit operations. Native control Python module is programmatically selected; no root daemon installed or started.

## H. IPC peer-attribution result

Added actual SO_PEERCRED PID/UID/GID checks, service/process/invocation/grant comparison, pinned inherited-fd peer helper and root Unix RPC transport. HMAC retained; internal body-string MAC avoids Python/JS locale-key-sort ambiguity. Duplicate request keys, replay, wrong peers and oversized frames refused. Node private fd API has no fallback if unavailable. Root peer PID/start/boot verification required. Own-process socketpair tests prove native peer/SCM_RIGHTS behavior only; distinct root/dynamic users and installed socket permissions remain unverified.

## I. Dynamic UID/invocation credential bootstrap result

Fresh native target proof precedes staging and handoff. Native files use fd-relative no-follow/exclusive creation,0400 files,0700 package, proven UID/GID fchown, fsync and Linux renameat2(RENAME_NOREPLACE); unavailable support refuses. Root-private ancestors retained; SCM_RIGHTS grants exact readonly file capabilities without public credential paths. Receiver verifies root peer process, expiry, exact receipt, GID/UID/hash/type/link/mode and stable metadata.

Pinned Python receiver and all imports send bytes only through an owned private pipe. The logical descriptor namespace feeds unchanged existing credential/approval parsers; virtual ancestors are explicitly capability metadata, not host-path attestation. No secret in args/errors/public receipts/logs, no ambient/default-profile/provider fallback. Native syscalls exercised only with synthetic same-UID packages; actual cross-UID branch and service/bootstrap barrier need separate root deployment proof.

## J. Credential issuer recovery/revocation result

Issuer-pinned no-follow private hash-chain journal records reservation/version/active/indeterminate/rotation predecessor/revocation/expiry/cleanup, fsync and bounded256-record retention. Restart validates lineage/issuer/source/native identity; no reserved/indeterminate activation or duplicate invocation issuance. Rotation requires new invocation and new grant, revoking predecessor first. Durable pending-grant tombstone prevents ambiguous late issuance regaining authority. Exact inode/receipt/file checks guard cleanup. Corrupt/truncated/unknown state refuses and is retained. No cloud issuer or external provider/database revocation is claimed; root and durable storage remain trusted.

## K. Broker/credential integration result

composeNativeBroker connects existing durable broker to native backend, then native credential bootstrap and descriptor filesystem capability. NativeBoundary independently verifies target unit/invocation/process/GID/deployment/runtime grant before issuer/stage/handoff. No reliance solely on Node caller assertions. Systemd's actual invocation can be used by an explicit post-start binding callback; no guessed UID/invocation. The actual GID is resolved through a post-start native-observation callback, together with binding within a 1000ms deadline; GID is never inferred from UID. Native control-policy hash and subsequent OperationalSelection hash are deliberately separate; runtime grant must bind the actual invocation and unchanged approved scope/cutoff to its parent policy. Existing source/config/SQL contracts not altered.

The private files/validation capabilities are available for existing SystemOperationalDelivery/trustedDeliveryFactory composition. Final installed root launch/policy/socket/grant/worker wait/inside-refresh scheduling remains to be packaged; no default native deployment factory is silently inserted into API or CLI.

## L. Controller-loss/restart safety result

Authorization and native peers rechecked before privileged work and around delivery; controller loss/expiry/replacement deny new actions. Duplicate activation/delivery refused. Stale invocation/package/grant cannot inherit authority. Handoff failure revokes record and pending grant; late issue receipts are revoked. Existing application cancellation/drain and DB publication fencing are unchanged. No actual controller killed, runtime expired or systemd restart performed.

## M. Security verification

Tests cover strict fields, wrong identity/config/artifact/UID/GID/cgroup, epochs, stale process, timeout/refusal/operation/unit, controller loss/expired grant, replay/HMAC/frame limits, protected-file corruption/symlink/mode/ownership/incomplete packages, durable recovery/rotation/revocation, descriptor-parser integration and disabled startup. Native API surface has no generic shell/exec or arbitrary unit/PID control. Only helper children may be terminated by their own bounded runner. No privilege policy installed/expanded. Installed libsystemd/root/cross-UID assertions remain unclaimed.

## N. Files changed and purpose

- `backend/package.json`
- `backend/src/background-checks/native-authority.check.ts`
- `backend/src/stage-c/native-authority.ts`
- `backend/src/stage-c/native-broker-composition.ts`
- `backend/src/stage-c/native-credential-bootstrap.ts`
- `backend/src/stage-c/native-credential-files.ts`
- `backend/src/stage-c/native-credential-receiver.ts`
- `backend/src/stage-c/native-inside-proof.ts`
- `backend/src/stage-c/native-peer-runner.ts`
- `backend/src/stage-c/native-unix-runner.ts`
- `docs/B03_7_NATIVE_AUTHORITY_20261024_5uWELmBA.md`
- `docs/BACKEND_MASTER_ROADMAP.md`
- `docs/PRD_MODULE_DELIVERY_TRACKER.md`
- `docs/PROJECT_IMPLEMENTATION_STATUS.md`
- `docs/SRS_REQUIREMENTS_TRACEABILITY.md`
- `docs/baselines/B03_7_OFFLINE_QUALIFICATION_20261024_5uWELmBA.json`
- `docs/baselines/PRD_MODULE_DELIVERY.json`
- `infrastructure/processing-delivery/B03_7_NATIVE_BOUNDARY.md`
- `infrastructure/processing-delivery/native-authority.example.json`
- `infrastructure/processing-delivery/native_boundary.py`
- `infrastructure/processing-delivery/native_bridge.py`
- `infrastructure/processing-delivery/native_credential_receiver.py`
- `infrastructure/processing-delivery/native_inside.py`
- `infrastructure/processing-delivery/native_issuer.py`
- `infrastructure/processing-delivery/native_manager.py`
- `infrastructure/processing-delivery/native_peer.py`
- `infrastructure/processing-delivery/native_peer_entry.py`
- `infrastructure/processing-delivery/test_native_authority.py`

New TypeScript implements native observation/backend adapter, peer runner/Unix RPC, bootstrap/issuer interfaces, descriptor receiver/files bridge, inside challenge, existing-broker composition and50 focused tests. New Python implements sd-bus backend/observation, peer/SCM transport, durable issuer/staging, inside store, narrow bridge/composition, disabled helpers and33 qualification tests. Inactive native policy/boundary documentation and explicit package test commands added. Central trackers and JSON ledger updated additively. No existing application/SQL/engine/supervision source changed.

## O. Focused test results

49/49 initial new TypeScript cases PASS; one additional post-broad dynamic-GID case PASS. Final targeted typecheck/build PASS. Final native Python qualification33/33 PASS, with real native Unix peer/descriptor/flock/filesystem syscalls only on newly created own-UID synthetic fixtures; manager calls and Node helper execution injected. Initial development failures retained: Python lambda syntax/type annotations fixed, sandbox private-files/socket restrictions correctly refused, host-owned fixture run passed without relaxing guards. No package installation or host service trial.

## P. Final regression/completeness/typecheck/build results

ONE broad offline run: **1151 passed =25 baseline+341 Python+785 TypeScript**, zero fail/cancel/skip/blocked. Contains49 new B03.7 cases; do not sum overlapping focused results.33 native Python checks run once as final native qualification. ONE completeness-check execution passed:16 modules/127 entries/FR36/NFR8/DEC12/CFG14 retained. No repeated historical completeness unit suite or PostgreSQL suites. Contracts, full typecheck/build, disabled OCR/summary/operational entries, native manager/peer/receiver disabled entries and old/new static policies PASS. Native policy validation executed zero manager calls. Snapshot mode for old descriptor tightened before final checks; no repeated broad run. A subsequent two-file composition/test correction resolves the actual dynamic GID after startup, alongside invocation binding, within a 1000ms bound. One additional targeted test and fresh full typecheck/build pass; the broad source manifest remains the earlier version. Historical helper's fixed full_851 predicate remains false due to count change; actual counts/no blocked checks govern.

## Q. Cleanup verification

Owned Python TemporaryDirectory packages/journals/sockets and test Node fixtures cleaned. All test subprocesses joined; original diagnostics retained. No systemd units/listening broker, containers, volumes, medical rows, S3 objects or real credentials created, so no existing data cleanup. No root UID/GID, service privileges or host ports changed. Private historical archives untouched.

## R. Evidence files and hashes

New report, `docs/baselines/B03_7_OFFLINE_QUALIFICATION_20261024_5uWELmBA.json` and protected archive `/home/m-tayyab-aslam/Music/ai-health-wallet/.private-evidence/b03.7-native-authority-20261024-5uWELmBA`. Index hashes all archived source/rollback copies, manifests, qualification/preflight/preservation/cleanup receipts and logs.0700 directories/0600 files, Git-excluded. Exact report/receipt/index SHA-256 returned after verified publication. B03.6 report/receipt and all91 indexed files reverified; old source/migration hashes retained.

## S. PRD/SRS/module-tracker impact

22 supporting rows gain B03.7 history with previous/current labels unchanged. All127 entries retain exact source wording/acceptance, dependencies and earlier evidence.0 COMPLETE/66 PARTIAL/57 MISSING/4 BLOCKED; code17 Implemented/49 Partially Implemented/61 Missing. Module01 accepted/PARTIAL unchanged. FR-010/011/012,NFR-01/05/06/07/08,DEC-07/08/12 gain supporting evidence only. No whole requirement completion, clinical/legal/production authorization or formal local/hosted/Node/Python amendment invented. Named approvers still pending.

## T. Native-authority final assessment

| Component | Status | Verification boundary |
| --- | --- | --- |
| Native observation | COMPLETE OFFLINE | Typed library/runner, kernel evidence, fresh inside store; actual installed manager/provider assembly unqualified |
| Exclusive authority model | COMPLETE OFFLINE | Implemented flock+retained-object revalidation under explicit trusted-root model; no manager CAS claim |
| Privileged broker backend | COMPLETE OFFLINE | Concrete sd-bus methods/narrow bridge; privileged service not installed/executed |
| Peer attribution | COMPLETE OFFLINE | Kernel peer/FD helpers and checks; actual root/dynamic service peers not exercised |
| Dynamic credential bootstrap | COMPLETE OFFLINE | UID/GID stage/FD receiver/strict parser bridge; actual distinct-UID deployment unqualified |
| Issuer recovery/revocation | COMPLETE OFFLINE | Durable local state/tombstones/rotation/recovery tested; no cloud issuance/revocation |

COMPLETE OFFLINE here denotes these versioned component implementations, not complete application launch/deployment or production readiness. Remaining launcher/policy/barrier/refresh assembly is explicitly listed below, not mislabeled live-only.

## U. Updated four-gap B03 assessment

| Area | Status | Remaining |
| --- | --- | --- |
| Privileged broker | COMPLETE OFFLINE (library contract) | Final root service/policy/privilege packaging and actual execution qualification |
| Credential bootstrap/lifecycle | COMPLETE OFFLINE (local contract) | Final root/worker launch/issuer-source/barrier packaging and cross-UID qualification |
| Immutable runtime graph | PARTIAL | Complete real release/native/library/plugin inventory and independent pin assembly |
| Network delivery | PARTIAL | Actual inherited-FD relay, PG/SDK/DNS/TLS connector enforcement |

## V. Updated nine-gate B03 table

| Gate | Status | Remaining |
| --- | --- | --- |
| System-manager composition | PARTIAL | Native libraries supplied; final installed launch/policy/grant assembly |
| Artifact/service identity deployment | PARTIAL | Complete immutable packaged release/native inventory |
| Credential delivery | PARTIAL | Native transport supplied; actual launch/barrier/source packaging |
| Network delivery | PARTIAL | PG/S3 relay and wire bridges |
| Application containment | PARTIAL | Final provider wiring and actual Node/OCR containment |
| Controller-loss handling | PARTIAL | Actual integrated BindsTo/native cleanup qualification |
| Runtime-expiry handling | PARTIAL | Actual issuer/systemd/Node lifecycle proof |
| Supervised worker composition | PARTIAL | Deployable capability/bootstrap assembly |
| Deployment/runtime qualification | LIVE QUALIFICATION REQUIRED | Not authorized; first finish remaining assembly/delivery |

## W. Regression/lease-safety status

CLOSED for established offline/isolated scope. Original SQL/repository/fencing/engines unchanged; historical disposable evidence preserved.

## X. Native authority implementation status

COMPLETE OFFLINE for the explicit native-component/trusted-root model. Installed application launch assembly is still partial.

## Y. Credential transport implementation status

COMPLETE OFFLINE for the local issuer/staging/native descriptor/legacy-parser contract. This is not real credential provisioning, external revocation or cross-UID runtime acceptance.

## Z. Trusted-delivery implementation status

PARTIAL: release/native closure, relay/driver enforcement and final deployable assembly remain.

## AA. Operational implementation status

PARTIAL; processing stays disabled. No automatic transition from component tests to service execution.

## AB. Offline deployment-readiness status

PARTIAL; inactive source/policy artifacts remain uninstalled and unapproved for activation.

## AC. Live runtime qualification status

OPEN. Actual root broker, installed libsystemd types/reference/job behavior, socket permissions/peers, dynamic UID/GID, credentials, reboot/restart/grant rollover, controller loss/expiry/native OCR and cloud canary remain separate approval gates.

## AD. B03.7 final outcome

PASS for permitted offline native-component implementation and qualification, within the explicit exclusive-writer/trusted-root boundary. No unsupported claim of manager CAS, whole B03 closure or production readiness. No broad-suite rerun.

## AE. Exact remaining work before B04

Assemble full root-owned immutable release/runtime/native graph; implement enforced inherited-FD PG/S3/DNS/TLS bridges; package final broker/controller/worker policy, socket privileges, grants, worker bootstrap barrier and inside/health refresh selection using supplied components. Review Operations privilege/exclusive-writer assumptions before any installation. Then separately approve synthetic root/systemd/cross-UID/restart/loss/expiry/containment/rollback and seven-AWS-check scoped canary qualification. Clinical/privacy/operations appointments, formal SRS amendments and downstream SRS acceptance remain explicit. No existing records or historical jobs admitted.

## AF. Recommended next phase

B03.8 proposal: offline immutable runtime packaging and enforced PG/S3 descriptor delivery, including final inactive launch/capability assembly where required. Separate approval needed; do not execute it or B04 automatically.

## Post-broad source supplement

The initial report/receipt/index and broad-tested source remain archived unchanged. Final publication includes exactly two TypeScript source deltas: native-broker-composition.ts and native-authority.check.ts. One additional dynamic-GID test, full typecheck and build passed. There are 50 distinct new TypeScript cases across the 49-case broad run and this one-case targeted run; no claim that the broad suite covered the final delta. No broad/completeness rerun.

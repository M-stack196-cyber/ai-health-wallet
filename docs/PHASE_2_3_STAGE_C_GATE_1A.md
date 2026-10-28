# Phase 2.3 Stage C — Gate 1A offline system-manager adapter

## Scope and status

Gate 1A adds an explicitly selected system-manager supervision state machine,
canonical unit definitions, an application-specific proof validator and offline
fake tests. It does not install or operate a unit. There is no system-manager
OS executor, CLI flag, environment switch, sudo helper or live composition.
Existing API, CLI, user-manager implementation, worker, OCR, SQL, scope/cutoff,
lease fencing and disabled-by-default configuration are unchanged.

Reviewed inputs: SRS v3 (particularly ownership/upload/extraction requirements
14.1–14.3), Stage A, Stage C preparation/hardening, existing worker/service,
controller/live composition, user supervisor and version-2 proof implementation.
The archived successful synthetic probes establish host feasibility only.

## Explicit manager and transport boundaries

`manager-selection.ts` exposes discriminated user/system selection. User selection
wraps the original createSystemdSupervisor without altering it. System selection
requires a SystemPlan and SystemManagerPorts; a user Command cannot substitute
for a system transport. No existing caller imports this selector.

`system-supervision.ts` implements the system-manager lifecycle. All observation
and control capabilities must be injected explicitly. Import and construction
perform no I/O. Ports contain no default implementation and do not load secrets,
execute commands or construct AWS/PG clients. A future transport must implement
trusted fresh observations, safe parsing, effective inside-process protection,
filesystem metadata, NSS/process identity and dispatch-time ownership comparison.
Fake observations are not real enforcement evidence.

The plan snapshots independently provided release artifact pins. Required roles:
Node executable, worker entry, controller entry, inside-check entry, system
supervision adapter and deployment manifest. Paths are distinct, canonical and
inside an explicit versioned /opt/ai-health-wallet/releases/<release> directory.
The worker and controller entry paths are fixed. Observations must match each
expected path/hash, root ownership, regular single-link files, safe ancestors,
non-writable service access and no group/world writes. Expected hashes are never
learned from observed files. The future deployment manifest must inventory the
complete dependency/native-runtime graph; Gate 1A does not build or verify that
transitive graph or provision a release.

## Identity, startup and ownership

Identity binds system manager, boot, run-specific unit/name/description, dynamic
User, transient fragment under /run/systemd/transient, exact ExecStart, system.slice
cgroup and systemd invocation. Controller invocation is independently supplied;
its full optional argument vector is included in the expected ExecStart. Process
identity uses PID, Linux start time, UID and boot ID, with actual main-executable
hash and resolved dynamic UID checks. A reused PID does not become the original.

Startup requires pinned artifacts, the exact active bounded controller, absent
worker unit, absent service identity and absent worker cgroup. A static identity
with the same name also refuses startup. A plan/definition cannot be changed by
mutating the caller's input after construction.

Each adapter permits one start attempt only. Reads are individually bounded at
500ms. After startup, read-only ownership reconciliation has at most eight
samples, a five-second overall deadline and bounded pauses. The first observed
candidate invocation is pinned; replacement is never adopted. A lost launch
acknowledgement is not retried: if exact ownership is recovered, targeted cleanup
is attempted and startup still fails. Unresolved ownership never authorizes stop,
reset or PID signaling. Error messages have a fixed non-sensitive schema.

Fresh ownership and deployment checks precede each targeted control request.
The transport receives the expected exact invocation and must compare again at
dispatch. No broad stop/reset, bare PID kill, fallback worker or manager change
exists. Inactive units may have an empty current ControlGroup; the originally
verified cgroup remains pinned for descendant checks. Failed-unit reset is
restricted to a freshly reverified owned failed invocation.

Stop has one overall 75-second bound, including a maximum 65-second stop request,
read-only termination observation and any reset/collection. Success requires all
recorded original process identities gone, cgroup empty/absent, unit unloaded and
dynamic identity released. Inspection errors, survivors, replacements or incomplete
collection refuse success. Ports must honor cancellation and must never retry an
ambiguous mutating request after a timeout.

## Controller coupling and security model

Both definitions explicitly target the system manager. Worker BindsTo and After
name only its run-specific controller; other implicit systemd ordering dependencies
may coexist. Controller identity/arguments, invocation, resolved UID, original main
identity and protections are checked before startup/admission.

Canonical worker bounds: CPU 200%, memory 3 GiB, tasks 128, runtime 600s,
TimeoutStopSec 60s, mixed cgroup kill, SIGTERM followed by SendSIGKILL=yes.
Controller bounds: CPU 50%, memory 768 MiB, tasks 64, runtime 900s, 60s stop,
control-group kill. Both use DynamicUser, Restart=no, ProtectControlGroups,
ProtectHome, ProtectSystem=strict, PrivateMounts/Network/Devices/Tmp,
NoNewPrivileges, empty capabilities, Delegate=no, private runtime directories,
UMask=0077 and null output. Effective CPU/memory/tasks/read-only cgroup evidence
is mandatory. Address-family deny-all is a typed allow-list with no families,
never ambiguous unit-file empty-string syntax.

These definitions are deliberately offline/network-denying and provide no
PROCESSING_SERVICE_ENABLED=true or credentials. They are not live launch commands.
The existing worker's SIGTERM/drain/AbortSignal/native cleanup behavior is reused
without changes. The future live configuration must separately pin concurrency
one, drain 30s and existing resource budgets.

checkAdmission refuses lost/replaced controllers and changed protections or
artifacts. Its future caller must stop admission/cancel on failure; Gate 1A does
not connect it to runtime. observeControllerLoss is read-only and time-bounded:
it requires a previously verified controller, refuses invocation replacement,
waits for worker inactivity/collection and checks original processes/cgroup.
No controller loss is manufactured by the adapter. Explicit cleanup through the
adapter is excluded during this observation. The observation proves containment;
a subsequent stop/cleanup verification separately proves unit/identity release.

## Application receipt version 3

`system-supervision-proof.ts` validates bounded receipt bytes against a separate
receipt SHA-256 pin, current boot, one-hour freshness, run, independently supplied
artifact pins, exact worker/controller invocation expectations and original process
identities. Required discriminator:

- version: 3
- kind: health-wallet-application-system-supervision
- manager: system

Exactly one passing check is required for each of inside protection, effective
limits, native containment, graceful cleanup, controller-loss cleanup and runtime
expiry cleanup. The existing user-manager version-2 verifier remains unchanged.
A successful start/observer never mints a passing application proof. Python probe
receipts and version-2 receipts are refused by this validator. The file reader,
private source permissions, trusted receipt writer and production composition
remain future work. An operator controlling both file and pin remains trusted;
this is not cryptographic defense against root or fabricated observer inputs.

## Offline verification

Verification uses a temporary source snapshot without .env, AWS configuration or
credentials; installed dependencies are reused read-only. No database or AWS
suite, OS probe or application background worker runs.

Final fake-suite results:

- Stage C: 184 passed = 101 existing + 83 new Gate 1A checks.
- Stage A: 32 passed.
- Manual integration-runner safety: 37 passed.
- Total: 253 passed, zero failures/skips/cancellations.
- TypeScript typecheck and production build: passed.
- Disabled compiled entry smoke: emitted only the fixed disabled event.

Coverage includes manager separation, identity/unit/cgroup collisions, missing
and mismatched artifacts, insecure deployment metadata, invocation/PID replacement,
read-only reconciliation, lost acknowledgements, cancellation, survivors, exact
reset, stalled reads, concurrent cleanup, controller loss, address-family checks,
proof separation/redaction and preservation of user-manager behavior.

The 269 database-backed baseline and Stage B database suites were not run:
Gate 1A prohibits PostgreSQL network access. Their earlier results are not counted
here. An initial tsx invocation was blocked by sandbox IPC restrictions; the
successful runs used the ordinary test commands with permission for their local
IPC pipe and synthetic health listeners, without sudo. A node --import tsx --test
attempt reported only a file-level test; that result is not counted. Intermediate
TypeScript test/narrowing errors were fixed before final validation.

## Remaining gates and Gate 1B recommendation

No live integration is ready from these files alone. Retain separate approval for:

1. Gate 1B offline credential adapters: explicit credential-directory readers for
   only the named ai-health-wallet profile, database runtime password and approval
   bytes. Preserve exact account 402909940531, region ap-southeast-2, bucket
   ai-health-wallet-records-402909940531 and medical-documents/ prefix. Preserve
   ambient/default-provider refusal and all seven fresh preflight checks. Inject
   password directly into PG options and AWS credentials directly into SDK/CLI
   adapters, not process environment, argv or logs. Use fake credential files,
   private-path/permission/hash and rotation refusal tests. Keep existing home-profile
   and API env loading unchanged and do not read actual credentials.
2. Specify LoadCredential source ownership and the service's read-only credential
   layout explicitly. Adapt approval verification without weakening the legacy
   owner-0600 rule, binding private source provenance, exact bytes/pin and canary
   patient/cutoff. Do not silently copy developer .env/.aws or broaden file access.
3. Separately review the root-owned release manifest, OS transport/allowlisted
   supervisor, secure observation/receipt writer and controller composition.
   Future controls must serialize owned unit names, compare invocation immediately
   before control and account for the remaining check/control race with concurrent
   privileged operators. No systemd name-based primitive is assumed atomic with
   invocation comparison merely because the TypeScript interface is typed.
4. Separately approve offline system-manager bound-pair acceptance using synthetic
   processes, deployment/credential sandbox tests, enforceable PG/S3 networking,
   then isolated DB/mock-S3 regressions. Never translate --user flags silently.
5. Fresh read-only live preflight, synthetic seeding, scope/cutoff approval and
   service activation remain distinct later gates. No persistent service, automatic
   restart, broader eligibility, data deletion or Gate 3 cleanup is authorized.

No new dependencies, migrations, database grants, IAM edits or AWS configuration
changes are required or performed by Gate 1A. All existing source inputs and
protected evidence remain preserved. No commit or push is made.

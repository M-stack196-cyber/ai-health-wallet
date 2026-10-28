# Inactive B03.5 processing delivery design

**Offline review artifacts only. No deployment or activation approval.** The `.service.in` files are deliberately incomplete and must not be installed, started, enabled or passed to `systemd-run`. Nothing in this directory is imported by the API or selected automatically. Example IDs, sizes and repeated hash values are synthetic placeholders, not deployable pins. The typed JSON preserves the existing system-manager security definition unchanged.

## Selected delivery boundary

The existing dedicated Node operational worker remains the executable: `/opt/ai-health-wallet/releases/<release>/backend/dist/processing/operational-entry.js`, launched with the independently pinned release-local Node. Processing defaults false. Explicit programmatic composition is `launchSystemOperational(env, () => delivery)`, after the separately approved deployment supplies every trusted capability. Existing CLI startup without that delivery still refuses enabled operation; setting flags alone cannot activate a worker.

`systemOperationalFactory` binds the selected canary/configuration identity, new Linux read-only observation, existing credential-file bundle, all seven existing AWS preflight checks, the existing resource/processor factory and existing canary scheduler/repository/worker. This phase tests fake system/AWS/database ports only. There is no second OCR implementation or `runOnce()` call in the controller/composition. Actual OCR remains the existing bounded PDF.js/Poppler/Tesseract processor, supplied by the reviewed deployment.

The normal API, old user-manager adapter and automatic startup remain unchanged. The existing Stage C CLI is not silently converted to a system-manager controller. The pinned controller path remains a compatibility contract; its actual system-manager delivery and trusted OS endpoint are still deployment blockers. An inactive template naming that path is not proof the controller can launch this application.

## Read-only observer and exact-control transport

`linux-system-observer.ts` implements bounded/parsing-strict observation of only the two exact system units, their kernel process/cgroup paths and independently pinned artifacts. Proc parsing preserves PID-start identity even when comm or CPU counters vary. Reads bracket manager/kernel evidence, reject invocation changes, unsafe/unknown properties, arbitrary units, PID reuse, writable cgroup aliases and stale inside proof. No environment dump, NSS/default profile lookup or arbitrary shell is permitted.

The optional native executor accepts only pinned `/usr/bin/systemctl --system show` with the fixed safe property list and exact run unit. It has an 800ms timeout, 64 KiB output bound and minimal environment; stderr/raw errors are not exposed. It is never selected or called by this phase's tests. Native kernel readers and fd-relative immutable-artifact traversal are inert until explicitly selected. Actual host property formatting, access permissions and observer latency are not verified here; unsupported values fail closed.

Inside-process non-mutating proof, typed D-Bus address-family interpretation and authoritative dynamic-user allocation reads remain mandatory trusted-broker capabilities. An outside mount listing is never sufficient. Worker/controller processes use different dynamic UIDs, so the worker cannot simply read all controller private state. No privileges are bypassed to obtain these observations.

`system-manager-transport.ts` provides the application protocol/client side for the existing supervisor. Requests are bound to deployment, independent broker artifact pin, exact definition/identity/process and a fresh nonce; startup is single-attempt and requires absent unit/identity/cgroup. Ambiguous starts are reconciled via a bounded **read-only lookup of the original broker nonce receipt**, never by adopting a matching unit name. Lost acknowledgements do not cause a second start. Existing supervisor policy reconciles, targets cleanup only after ownership proof, and refuses the failed launch.

There is deliberately no local start/stop/reset shell executor. A `show` followed by `stop` would race with invocation replacement. A separately reviewed privileged broker must authenticate the controller peer, journal nonce results durably, serialize compare-and-control and refuse unowned/replaced units. Its OS implementation, authenticated IPC channel, policy authorization and crash/collection semantics are not provided or claimed verified by an injected fake broker. Out-of-band root administration remains a trust boundary; uncertain ownership must retain diagnostics and never issue a broad stop/kill.

## Immutable code and deployment identity

Deploy code/runtime under a root-owned, read-only `/opt/ai-health-wallet/releases/<release>` tree, with no developer home, SSH keys, AWS home configuration, `.env`, writable dependencies or credentials in the graph. Use independent outer descriptor/artifact hashes; never learn the expected hash from an untrusted payload itself.

The descriptor separately pins declared release files and fixed OS tools/data: systemctl, prlimit, Tesseract, pdftoppm and the example Ubuntu Tesseract5 English data path. That data path is a proposed packaging assumption, not an inspection of the installed host; approve the actual package/data/library layout before deployment. Existing OCR hardcodes `/usr/bin` tools and `eng`; this phase does not move or rewrite them. Shared libraries, loader, fonts/PDF.js assets, native Node modules and all transitive dependencies need full graph inventory/qualification. `verifyDeclaredArtifacts()` explicitly returns `fullRuntimeDependencyClosureVerified:false`; verifying the declared subset does not prove completeness.

`immutable-artifacts.ts` uses no-follow fd-relative ancestor traversal, root ownership, no group/world write, single-link regular files, bounded hashing, independent SHA-256 and post-read identity checks. Stable root-protected identities may reuse a cached digest; changed metadata forces rehash. No symlink/hardlink/unsafe ancestor is accepted.

## Credential delivery and lifecycle

Use only the existing `system-files` mode: exact `ai-health-wallet`/402909940531/ap-southeast-2/ai-health-wallet-records-402909940531/medical-documents target, protected AWS/PG/approval files and pinned runtime grant. No ambient environment/home/instance/paid-provider fallback. PostgreSQL uses direct file-derived password options; no secrets in arguments, logs, receipts or templates. The approved profile name identifies the file envelope, not permission to consult `~/.aws`.

Proposed source staging is root-private `/run/health-wallet-delivery/<run>`; systemd `LoadCredential=` delivers only the four named files to the exact unit. Required service directory/file metadata remains 0500/0400 or the already-supported private alternatives. No real file is staged here. Raw credentials are absent from these artifacts.

Bootstrap is an explicit unresolved gate: dynamic UID and system-generated InvocationID are known only during unit creation, while file owners, runtime grant and independently pinned configuration must bind those exact values. A root-owned, narrowly authorized delivery broker must issue/publish that binding at a reviewed bootstrap barrier. Do not invent an InvocationID in advance, weaken ownership, rewrite pinned files mid-run or call an unapproved root ExecStartPre helper to bypass this cycle. The templates do not solve or activate bootstrap.

System composition caps drain at the existing default30s and requires 6s minimum separation between runtime-grant expiry and declared credential expiry (existing 1s admission/5s close budget). Grant max remains600s; expiry, file replacement, network/ownership loss cancel admissions and active work. No automatic refresh/retry/fallback is introduced. New issuance/rotation requires a fresh authorized run and identity, not editing the live approval/cutoff. Actual AWS/session expiry and PostgreSQL revocation are not proved by a declared timestamp; issuer evidence, token/session policy, rotation and early-revocation classification still require Operations review and live qualification.

Current restricted application DB-role identity is preserved; no roles or privileges are changed. An OCR-only least-privilege role needs separately approved SQL privilege analysis, including existing fenced function permissions. No database or IAM grant is embedded here.

## Network policy: preserve isolation, gate delivery

Preserve `PrivateNetwork=yes`, typed allow-list=true with an empty family list, read-only cgroups, protected home/system, no capabilities/delegation, bounded resources and no restarts. These currently prohibit direct PG/S3 sockets. Never serialize typed deny-all as empty `RestrictAddressFamilies=`: empty unit-file assignment resets restrictions. The template contains `@TYPED_DENY_ALL_DBUS_REQUIRED@` deliberately, so it cannot accidentally be mistaken for a valid approved service file. No systemd configuration was changed to pass a test.

The proposed delivery is a default-deny, scoped relay with **inherited preconnected descriptors**; address-family restrictions do not authorize new worker-created network sockets. This is a design requiring implementation, feasibility and Operations approval, not an installed relay/firewall. Existing PG/S3 drivers need a reviewed stream/request-handler bridge and per-connection admission; those runtime delivery adapters are not claimed complete.

Only role-bound access may be admitted: PG127.0.0.1:5433 (pool4), STS caller identity, regional S3 bucket security reads, account S3-control public-access-block read and GetObject of an exact authorized original receipt under the approved prefix. No PUT/DELETE, AssumeRole, arbitrary account/bucket/key, generic CONNECT proxy, redirect, arbitrary DNS destination or paid/cloud model fallback. Bind broker TLS endpoint/certificate verification, account/bucket owner, descriptor policy evidence and expiry to the same configuration/invocation. Seven AWS checks must actually pass again before any future live work. The pure `allowOperationalEgress()` implements request authorization only; it does not enforce the network or attest a supplied boolean.

## Containment, loss, expiry and health

Retain worker CPU200%, memory3GiB, TasksMax128, RuntimeMaxSec600, Restart=no, KillMode=mixed, SIGTERM, TimeoutStopSec60 and final SIGKILL; controller CPU50%, memory768MiB, TasksMax64, runtime900s and control-group kill. The worker remains BindsTo/After its exact controller. Native detached OCR children remain in the service cgroup; only actual Node/OCR probes can prove this. Historical Python probes are not promoted to application proof.

The new explicit health override writes fixed-schema aggregate receipts instead of binding TCP under a deny-all network policy. `receiptHealth` serializes bounded writes, drains in-flight publication, writes final non-live status and refuses stale/mismatched/replayed receipts. `privateHealthSink` uses 0700 parent/0600 atomic files, exact-path collision/replacement checks and identity-proven temporary cleanup. It never deletes the final receipt. A hung/error writer cannot produce verified-cleanup success. The default developer/user-manager loopback health remains unchanged.

Health is observational, never authorization or application-containment proof. A root read broker must expose only aggregate receipt state to the differently owned controller, preserving private permissions. Maximum age1500ms; no health endpoint accepts commands. No patient/document IDs, keys, credentials or medical text appear in health.

## Rollback and recovery

Before each future controlled run: independently verify pinned artifacts/configuration/grant/cutoff/identity, seven AWS checks, one coordinator/instance, resource/network enforcement and preservation baseline. Admission remains restricted to the approved patient and fixed cutoff inside SQL discovery/claim/recovery/metrics. No automatic historical backfill.

On control/expiry/network/credential loss: stop admissions, cancel/drain, preserve original/evidence, and let existing lease fencing/recovery semantics apply. Do not claim that an already-dispatched database COMMIT can be undone. Only a fresh exact-invocation broker request may stop/reset an owned unit. Unknown/replaced ownership means no stop, kill or reset; retain private diagnostics and escalate to the operator. Never prune units, objects or database records.

Recovery requires a new approved invocation/grant with the same independently pinned patient/cutoff unless a new scope is explicitly approved. Reuse current scoped lease recovery and idempotency; do not duplicate upload or backfill history. Rollback leaves processing disabled and preserves records/S3/evidence. This phase's code rollback is limited to source files listed in its receipt; no live-state cleanup is needed or authorized.

## Offline commands and next approval

From `backend/`, this checks only the canonical synthetic descriptor (not files at `/opt`, host services or cloud):

```bash
npm run processing:deployment:check -- --check \
  --manifest /home/m-tayyab-aslam/Music/ai-health-wallet/infrastructure/processing-delivery/offline-deployment.example.json \
  --sha256 63b788071d5a24a0b18bc00bd1cb4063384bad9038a0d8097053e91200336b51
```

Expected `offlinePolicyValid:true`, **`activationAllowed:false`**, seven retained blockers. This is not a command to deploy or activate processing. `npm run processing:delivery:test` is an explicit synthetic test command; it does not start services. Native private-file positive tests require a real root-owned sticky `/tmp`; the remapped sandbox correctly refuses unsafe ancestry.

Next approval must settle the privileged broker/IPC/bootstrap and inherited-descriptor network delivery design, immutable full graph, issuer lifecycle and minimum restricted DB access. Remaining implementation can then proceed offline against those approved contracts. Any actual service creation, credentials staging, live preflight, existing DB/AWS canary or real Node/native-loss/expiry test requires separate execution authorization. No B04 approval is inferred.

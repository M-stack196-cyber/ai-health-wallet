# B03.7 native boundary — inactive implementation

This package implements native library/transport components for explicit future
selection. Nothing opens the host bus, starts a listener, creates credentials or
controls services at import. No unit installation, sudo, host service command,
credential source or network policy change is performed by qualification.

## Native manager and precise authority boundary

`native_manager.py` implements persistent Linux libsystemd sd-bus calls with
ctypes (standard library), typed property/variant marshalling, narrow native
unit creation/Stop/ResetFailed, minimum property collection, kernel PID/start/
UID/GID/cgroup evidence and resource/inside-proof checking. No systemctl, busctl,
ldd, subprocess command or arbitrary executable string is used for control.
`native_bridge.py` only accepts versioned, deployment/config-pinned observe,
start-absent, stop-exact and reset-exact requests for the exact two planned units;
controller mutation is refused. Service definition always comes from frozen
trusted policy, never caller-supplied new properties. Typed address-family
`(true, [])` retains deny-all semantics; empty unit-file assignment is not used.

All permitted writers must use the broker's root-private flock, persistent bus
connection, Unit.Ref/Unref, fresh full comparison and retained-object control.
Restart=no and job mode=fail are required. Manager unique-owner changes, partial
identity, replacement, PID reuse, failed references, uncertainty and timeout
refuse control. A900ms operation deadline propagates into native sd-bus calls;
Node control calls are capped at1000ms. Accepted manager job dispatch is the
linearization point; subsequent cancellation cannot retroactively undo it.
Failures after dispatch stay ambiguous/poisoned and are never automatically
retried. Existing durable B03.6 nonce journal remains the outer action authority.

**This is not an InvocationID CAS supplied by systemd.** Root, PID1, the system
bus and privileged out-of-band administrators are trusted. Ordinary users and
other agents must have no authority to mutate these units. An Operations-reviewed
privilege/deployment policy must enforce that exclusive writer assumption. A local
lock cannot constrain root or PID1. Actual reference/job behavior, installed
libsystemd ABI/types and root authorization need separately approved runtime proof.
No installable wildcard polkit rule or broad sudo permission is provided.

## Observation and inside proof

`native-authority.ts` strictly validates versioned native observations including
configuration/deployment pins, manager epoch, state/substate, PID/start/UID/GID,
node identity, typed configuration, cgroup and effective limits. Existing immutable
artifact and read-only process observers remain mandatory in broker composition.
NativeKernel never collects Environment, logs, medical text or unrelated units.

`native-inside-proof.ts` reuses the existing non-mutating inspectInside capability.
`native_inside.py` authenticates its producing kernel peer against identity-only
native observation, exact challenge/process/GID and all required cgroup interfaces,
then publishes a root-private fresh receipt. This avoids trusting a proof before
its producer is identified. Full admission independently checks mount aliases and
requires the fresh inside receipt. Identity-only bootstrap never claims full
containment. Challenges are one-use, bounded and expire at1000ms. Receipts fail
closed on restart rather than inheriting stale authority. No inside inspection was
performed against an actual application service during this phase.

## Peer authentication and descriptor transport

`native_peer.py` implements actual Linux SO_PEERCRED (PID/UID/GID), exact process/
unit/invocation/grant comparison before dispatch, bounded frames and SCM_RIGHTS
handoff. It can serve only an explicitly supplied, root-owned Unix listening fd;
it does not bind/install one. The B03.6 HMAC layer is retained. Native internal RPC
MACs cover the exact body string, avoiding Python/JavaScript locale-sort ambiguity.
Duplicate JSON keys, nonce replay and unknown operations are refused. Native
session key provisioning stays explicit; no environment/default key fallback.

`native-peer-runner.ts` passes only an owned connected socket fd3 to a separately
pinned Python peer helper, with no shell, no arbitrary argv and bounded output /
child lifetime. Node's non-public socket `_handle.fd` is used only after explicit
validation; unsupported platforms/versions refuse, never fall back to HMAC alone.
`native-unix-runner.ts` requires the exact root-owned0710 directory/0660 Unix
socket, dedicated GID, HMAC, native root-peer PID/UID/GID AND independent root
PID/start/boot verification. This is explicitly different from the unchanged
same-UID developer B03.6 socket adapter; its permissions are not weakened.

`native_credential_receiver.py` receives four readonly file descriptors via an
explicitly inherited connected fd3, verifies root peer process identity, exact
receipt, expiry, owner/GID/mode/hash and stable file metadata, then transfers bytes
only through the owned private stdout pipe. Stderr is suppressed; values never
appear in commands, errors, public receipts or logs. `native-credential-receiver.ts`
pins Python plus every imported helper before execution, bounds bytes/deadlines
and decodes the private packet. `native-credential-files.ts` exposes an explicit
**logical descriptor namespace** to the existing unchanged strict credential /
approval parser. Its directory ancestors are virtual capability metadata, not a
claim about `/run/credentials` host pathnames. Leaf observations come from verified
native descriptors; pins, metadata stability and lease checks remain mandatory.
No developer-home, AWS-chain, instance, proxy or database environment fallback.

## Dynamic bootstrap, issuer recovery and revocation

`InvocationStage` derives UID/GID only after fresh observed process/invocation/
grant proof. A private temporary package is exclusively created, fd-relative,
files0400 and directory0700; fchown binds the proven UID/GID. Linux renameat2
RENAME_NOREPLACE atomically publishes it; unsupported syscall refuses, no weaker
rename fallback. The broker retains private ancestor access; delivery uses file
descriptors, not relaxed public traversal. Incomplete packages remain private and
unusable for explicit, identity-proven recovery; no broad cleanup.

`IssuanceJournal` is issuer-pinned, owner-private, no-follow, hash-chained,
fsync'd and bounded256 records, with an OS-released lock for crash recovery.
Reserved/indeterminate records do not become active on restart. Corruption and
unknown issuer refuse. Active packages require fresh process/grant/file validation.
One invocation cannot be issued again after recovery; rotation needs a new
invocation AND new grant, revokes predecessor first and records lineage.
Revocation/expiry/cleanup tombstones remain. Pending-grant revocation is durable,
so an ambiguous late issuance cannot regain authority. No cloud issuer or external
AWS/PG credential revocation is claimed. Root/storage durability remains trusted;
a root attacker or rollback of all durable storage is outside this journal model.

`NativeBoundary` independently rechecks target unit, invocation, process, GID,
deployment and grant authority before issue and handoff; Node checks alone are
not accepted as privileged proof. `NativeIssuerBridge` exports only pinned receipts.
`nativeCredentialBootstrap` prevents duplicate delivery, rechecks native peer and
lease before/after handoff and revokes both pending grants and late receipts after
errors/timeouts. Cleanup never restores delivery authority.

## Configuration and dynamic-start binding

Native control-policy configurationSha256 identifies the independently approved
controller/bootstrap policy, not the worker's later OperationalSelection hash.
Systemd creates the actual worker invocation; `startAndDeliver` supports an
explicit post-start binding callback. That callback builds the new immutable
OperationalSelection/runtime grant from the actual invocation while retaining
the approved patient/cutoff/source policy. It must never invent a new cutoff or
copy an old grant. Root authorize_runtime verifies that independent runtime grant
and its relationship to the approved parent policy. Existing runtime/credential
schemas and SQL eligibility remain unchanged. No running worker hot-reloads pins.

## Integration, limits and remaining deployment work

`composeNativeBroker` connects the existing broker/nonce protocol to the native
backend and dynamic credential bootstrap. The received filesystem capability can
be selected in the existing SystemOperationalDelivery runtime.files, with native
lease validation in existing trusted-delivery checks; existing scheduler,
coordinator, patient-scoped SQL, leases, OCR and cancellation/drain are not replaced.
Normal API/user-manager/manual-runner call sites do not select any new component.
Default helper/native-boundary entry paths are disabled, with no resource creation.

Programmatic libraries are not a complete installed service. Final root-owned
policy/grant/capability files, socket/unit launch composition, boot ordering,
worker barrier/inside-refresh scheduling, approved privilege policy and platform
packaging must be assembled and reviewed before execution. Full immutable release /
native graph and actual PG/S3 descriptor bridges remain the other B03 work, not
silently declared complete here. No existing direct-network driver is reclassified
as compatible with PrivateNetwork or deny-all families.

Actual cross-UID fchown/handoff, installed-systemd marshalling/reference semantics,
root peer attribution, controller loss, runtime expiry, restart/recovery and native
OCR containment require separate synthetic runtime authorization. Offline tests
exercise native Unix peer/SCM_RIGHTS/flock syscalls only on newly created own-UID
fixtures, plus fake manager/native-process-runner responses. They prove no real
root/dynamic-user deployment, IAM, RDS/S3 or clinical/production readiness.

Rollback: leave flags false and omit explicit native capability selection. Restore
only exact approved files from B03.7's protected archive if required. Preserve all
journals, originals, records and prior evidence. Never remove an unknown package,
kill a PID, stop an unverified unit, automatically retry an ambiguous operation or
silently fall back to another manager/credential/network mode. No B04 authorization.

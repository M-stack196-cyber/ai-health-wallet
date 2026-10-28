# B03.6 trusted-delivery implementation boundaries

All artifacts remain INACTIVE. No systemd command, elevated broker, network relay,
credential source, database, AWS operation or worker is executed by importing the
new modules. Existing developer/user-manager paths are unchanged. Normal API
startup does not import the new factory. No service, package or migration install.

## Broker and local IPC

`controlBrokerServer` accepts exactly start-absent, stop-exact and reset-exact for
one frozen plan. Authorization checks the current controller process identity,
artifacts, full unit/exec/properties, invocation, main PID/start/UID and empty
containment before failed-unit reset. Every accepted request is durably reserved
before control; unresolved mutation poisons subsequent admissions. Lookup is
read-only and cannot repeat a mutation. The existing client performs its original
bounded reconciliation. No new shell, systemctl, PID kill or generic executor.

`local-control-ipc` is an explicitly constructed Unix-domain server/client. A
32-byte independently delivered, run-scoped HMAC capability authenticates canonical
bounded frames and replies, with fresh request nonces, live caller/server process
verification, 2s connection deadline, four connections maximum and 4096 frames per
server lifetime. Private0700 parent and private socket are mandatory. No TCP,
proxy, alternate path or automatic authentication fallback. The key is never an
argument or receipt. Invalid frames close without echoing input or errors.

This is capability authentication, **not SO_PEERCRED attestation**. Node's standard
API does not supply peer credentials. A privileged production arrangement needs
an independently authenticated descriptor/peer adapter and reviewed capability
handoff to the distinct controller UID. Current native server only supports its
own UID's directory; do not loosen its permissions for cross-UID delivery.

### Exact compare/control is still a native implementation gap

The server implements comparisons within an `ExclusiveManagerTransaction`, with
an injected native backend. No native system-manager transaction backend ships in
this phase. `systemctl show` followed by `stop`, even with a local mutex, is NOT
acceptable. A systemd D-Bus backend must serialize all authorized mutations, retain
the exact unit object through comparison and job acceptance, exclude autonomous
restart/replacement (Restart=no), and define trusted root/out-of-band authority.
Stock systemd StopUnit does not take an expected InvocationID. Treat exclusive
native authority as a reviewed trust assumption, never a proven kernel CAS. This
is OFFLINE IMPLEMENTATION work still pending, not merely a live test.

### Journal storage and recovery

One owner-private journal directory per approved run is configured independently
of requests. Never recreate a missing journal for an already accepted run. Session
binding/expiry/capacity are immutable and checked on reopen. Complete fsynced
records are published with non-replacing links; parent fsync follows. Atomic nonce
reservation works between separate handles/processes. Reserved-but-no-reply means
indeterminate: lookup returns null and replay stays refused. Manual owned-run
reconciliation is required; uploads/actions are not retried. Corrupt/unknown files
or changed session metadata fail closed. Maximum1024 entries; capacity refusal,
not eviction of live reservations. Only expired sessions may prune exact record
names; session.json remains as an expiry tombstone. A crash leaving .new-* causes
startup refusal and diagnostic preservation; no guessing/recovery by deletion.
Filesystem fsync guarantees depend on the actual deployment filesystem. Root is
trusted; a root attacker can change journals and policy. Test storage is synthetic.

## Credentials

`credentialLifecycle` supports issue, protected staging, validate, rotate, revoke,
expire and exact cleanup. Packages bind run, deployment/config/grant, service,
worker invocation and PID/start/UID/boot, with <=600s expiry and >=6s headroom.
Local revocation is immediate before issuer callbacks; no further admission can
reuse a revoked package. Rotation revokes the old package first and cannot revive
it if replacement fails. It does not reload files in a running worker: existing
pin/config/grant validation rejects changed material. A new authorized immutable
selection and supervised invocation must be prepared for deployment rotation.
No new AWS/DB loader: existing strict file parsers still run before any driver use.
A lease is not proof that a malformed envelope is valid. `leasedCredentialBundle`
adds checks before and after credential access; ordinary JSON/inspect is redacted.

`protectedCredentialStage` writes only four fixed files, exclusively,0600 under a
new0700 package directory, fsyncs, pins inode and rechecks content/hash/owner/type
before exact cleanup. Root descriptor traversal is no-follow. **The native
backend refuses any UID other than its own; it does not implement dynamic-UID
credential transfer.** Privileged bootstrap/barrier, durable issuer revocation,
real provider expiry/revocation and cross-UID grants remain implementation gaps.
Issuer and stage are injected; only synthetic values were used. Unknown receipts
after issuer restart are refused; they are not automatically recovered. A partial
stage/failed verification preserves private files and requires proven-owned
reconciliation; never recursively remove an unverified directory. Zeroization of
owned byte arrays is best effort; JS/runtime copies cannot be guaranteed erased.

## Runtime graph

`runtime-artifact-graph` validates an independently pinned, closed graph: release
code, runtime/version, package lock, production dependencies, policy/configuration,
OCR binaries, libraries/loader and data. Exact expected inventory, hashes, sizes,
root UID/mode, regular single-link no-symlink files, safe ancestors, edges and
versions are verified via injected observations. Extra/missing files/edges,
version drift, path escapes, unsafe metadata and pin mismatches refuse startup.
The trusted factory additionally binds all six existing deployment artifact pins.
The graph pin must come from an independently reviewed release, not its own scan.

`runtime_inventory.py` can inventory explicitly selected packaged directories and
parse ELF64 DT_NEEDED/interpreter/search paths **without ldd or executing code**.
`lockRuntimePackages` enumerates production lock entries, refusing symlink entries.
Release assembly must recursively resolve native libraries/interpreters and
explicit dynamic plugins/data/search paths, preserve lock integrity, copy approved
symlink targets as immutable files, and independently pin Node/native versions.
There is no actual complete release/native inventory for this host yet. Graph
validation of synthetic observations does not prove all real runtime dependencies
have been discovered. Real release assembly/native observation remain offline
implementation work, followed by separate installation/qualification approval.

## Network

`network-delivery` is application-level policy enforcement, not a host firewall.
The independently pinned policy retains PrivateNetwork, empty typed worker address
families, no worker sockets, no proxy/redirect/fallback and private-file health.
PG policy pins loopback5433, TLS and certificate verification, localhost name and
CA hash; it does not silently change existing developer PG settings. The old
operational direct driver remains ssl:false and is NOT selected as a compliant
new relay driver. RDS endpoints are unknown/unapproved: no invented RDS hostname
or broad *.rds.amazonaws.com allowlist. A later approved descriptor/credential
schema change is needed for actual RDS. S3/STS/S3-control use exact regional HTTPS
hosts, account402909940531/bucket/prefix and certificate verification/CA hash.
Only the existing seven security read classes and receipt-authorized GetObject
are allowed. No S3 writes/deletes. Health never authorizes processing.

`scopedNetworkDelivery` rejects unsafe endpoints before invoking a supplied relay,
rechecks authority around requests, bounds work and permanently refuses new
admissions after ambiguous cancellation/timeout. Pending operations prevent a
cleanup-success claim. PG and SDK wire bridges, DNS/IP rebinding protection,
certificate verification in a native connector, inherited-FD delivery and actual
relay namespace/destination enforcement are NOT implemented by the JSON policy or
an injected fake. They remain implementation gates; do not remove containment to
make direct drivers work. No network/firewall change was performed.

## Composition, shutdown, rollback

`trustedDeliveryFactory` is an additional explicit wrapper around the existing
systemOperationalFactory/startOperational and existing scheduler/coordinator/
repository/worker. It checks graph, broker, credential receipt and network policy
before opening resources, then renews broker/credential/relay checks through the
existing admission/250ms monitor. Existing seven AWS preflight checks, scope,
fixed cutoff, DB-clock leases and transactions are unchanged. New factory refuses
second activation; process-wide invocation tombstones remain. Controller loss,
revocation, expiry and caller cancellation use existing drain/fencing/cleanup.
No transaction spans external processing. No same-run historical recovery or
backfill. Existing COMMIT-dispatch linearization limitation remains.

There is **no production native composition/launcher** supplying these missing
capabilities. Neither metadata nor a successful fake callback is runtime evidence.
The broker verifier and relay verifier must be backed by authentic fresh receipts
before deployment; a function that returns success is not enforcement.

Rollback is to keep false defaults and omit the explicitly selected new factory.
Restore only exact files from the B03.6 archive if reviewed; no data deletion,
migrations, credential fallback, broad service stop/reset or automatic restart.
Recovery of ambiguous units/credentials requires exact ownership and invocation
proof. All live registration/upload/service/credential/network operations require
separate approval. No B04 authorization or whole PRD/SRS completion is implied.

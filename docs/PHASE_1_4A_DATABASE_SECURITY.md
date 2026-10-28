# Phase 1.4A — PostgreSQL security hardening

## Scope and inspected state

The project SRS file `docs/AI_Health_Wallet_Final_SRS_v3.docx` remains absent.
This phase follows the supplied Phase 1.4A requirements and preserves the
existing schema. No authentication, product endpoints or other later-phase
features are implemented. The Phase 1.4 documentation remains a historical
implementation record; its superuser-runtime limitation is superseded here.

Inspection found the dedicated `ai-health-wallet-postgres` container/database
had 14 tables, 55 indexes, no sequences, three SECURITY INVOKER trigger
functions, one applied migration and no role memberships. All tables/functions
were owned by the Docker bootstrap superuser `health_wallet_user`. The `public`
schema was owned by `pg_database_owner`, with PUBLIC USAGE. Database defaults
allowed PUBLIC CONNECT/TEMP. Function defaults allowed PUBLIC EXECUTE.

Ownership transfer is necessary because a non-owner cannot perform normal
ALTER TABLE migrations merely through table grants. Provisioning validates the
known tables, functions, owners, memberships, index inventory and original SQL
checksum before transferring the `public` schema, all 14 tables (including the
ledger) and the three functions to `health_wallet_migrator`. Table ownership
also updates ownership of their indexes. Object OIDs, definitions, constraints,
all row counts and complete migration history are compared before/after. There
is no REASSIGN OWNED, DROP OWNED, drop/truncate/reset or cross-database operation.

## Role architecture and privilege matrix

| Capability | health_wallet_app | health_wallet_migrator | health_wallet_user |
| --- | --- | --- | --- |
| Purpose | Express runtime | Explicit schema/migration tools | Dedicated-container bootstrap/recovery |
| LOGIN | Yes | Yes | Existing unchanged |
| SUPERUSER / CREATEDB / CREATEROLE / REPLICATION / BYPASSRLS | All false | All false | Existing administrator attributes unchanged |
| Role memberships / inherited elevation | None; NOINHERIT | None; NOINHERIT | Existing unchanged |
| Database CONNECT | Yes | Yes | Database owner/superuser |
| Database CREATE | No | No | Administrative |
| TEMP tables | No | Yes, for transactional verification | Administrative |
| public schema USAGE | Yes | Owner | Administrative |
| public schema CREATE / ownership | No | Owner | Administrative |
| 13 application tables | SELECT, INSERT, UPDATE, DELETE | Owner | Administrative |
| Table TRUNCATE / REFERENCES / TRIGGER / grant options | None | Owner | Administrative |
| schema_migrations | No SELECT or writes | Owner, migration tracking | Administrative |
| Existing three trigger functions | EXECUTE, SECURITY INVOKER | Owner | Administrative |
| Existing sequences | None exist; no grants | Owner of future migration-created sequences | Administrative |
| ALTER/DROP schema objects | No ownership or membership | Owner | Administrative |

Only the migration tools import `migration-pool.ts`; the Express app imports the
existing runtime pool. The pool's API timeouts and existing endpoints are
unchanged. Runtime configuration rejects an elevated or different DB_USER.
Migration configuration requires the dedicated migration identity and never
falls back to runtime or bootstrap credentials. Neither role is a member of
the other. The database itself remains owned by the bootstrap administrator.

## Local setup and credentials

The existing Docker volume and Compose file are retained. With the dedicated
container already running, execute from `backend/`:

```sh
npm run db:provision
npm run db:status
npm run db:migrate
npm run db:test
npm run db:security:test
npm run typecheck
npm run build
```

Provisioning uses the existing Node.js runtime and installed pg/dotenv modules;
no additional dependency is installed. Elevated SQL is sent over stdin to
`docker exec -i ai-health-wallet-postgres psql` using its local Unix socket,
bootstrap role and exact database. It never connects as administrator to a host
TCP PostgreSQL service, changes another container, or uses fresh-volume init
scripts. SQL privileges are explicit and reviewable in
`infrastructure/database-roles.sql`.

New independent 256-bit random passwords are generated only for absent roles.
Only standard PostgreSQL SCRAM-SHA-256 verifiers are inserted into role DDL, not
plaintext passwords. SQL logging is disabled for that dedicated provisioning
session before secret-bearing statements, and child stderr/SQL is never echoed.
No password/verifier is passed in process arguments. TCP logins are verified
against the dedicated host port 5433 after provisioning.

| File / variable | Meaning |
| --- | --- |
| backend/.env: DB_HOST | Existing 127.0.0.1 |
| backend/.env: DB_PORT | Existing host port 5433 |
| backend/.env: DB_NAME | ai_health_wallet |
| backend/.env: DB_USER | health_wallet_app |
| backend/.env: DB_PASSWORD | Restricted runtime secret |
| backend/.env.migrations: MIGRATION_DB_USER | health_wallet_migrator |
| backend/.env.migrations: MIGRATION_DB_PASSWORD | Separate owner secret |
| infrastructure/.env: POSTGRES_* | Existing bootstrap configuration; not loaded by Express or migration commands |

Existing frontend/server settings in `.env` are retained. Runtime and migration
secrets are stored in separate ignored files, accessible only to the file owner
(0600 here). Existing private-file permissions are preserved. The runtime
environment loader does not read `.env.migrations`; only migration tools/tests
load it. Placeholder examples are source-visible through `.gitignore` exceptions.

Provisioning is repeatable: existing roles authenticate using saved credentials,
role flags/grants are reconciled without resetting passwords, and matching
secret files are left byte-for-byte unchanged. Missing or inconsistent existing
role credentials cause a safe failure requiring restoration, never an automatic
password rotation. Unexpected objects, owners or memberships also fail preflight.
The exact 14-table/3-function manifest intentionally requires review before this
provisioner can manage an expanded future schema.

An owner-only ignored `.env.roles.pending` file retains generated secrets across
an interrupted provisioning operation; a retry uses it to finish safely. Remove
it only after successful recovery, never print its contents. The ignored
`.env.roles.lock` prevents concurrent local runs. If the process was killed,
confirm its recorded PID is no longer active before removing a stale lock and
retrying. Atomic credential-write temporary files also stay owner-only/ignored;
a stale temporary file causes a safe failure rather than overwriting it.

## Running migrations and the API

`npm run db:migrate` and `npm run db:status` use the separate migration pool and
the unchanged migration ordering/checksum/advisory-lock mechanism. The initial
`0001_initial_schema.sql` file and its applied ledger row are not modified. No
application migration is added for operational role provisioning.

Normal `npm run dev` / `npm start` uses only the restricted runtime credentials.
`SELECT current_user` through the runtime pool must return `health_wallet_app`;
through the migration pool it must return `health_wallet_migrator`. Both existing
health routes continue to use the runtime pool. If a backend process was already
running before provisioning, restart it to discard previously loaded credentials
and already-open administrator sessions; this phase does not kill user processes.

All PUBLIC privileges on the dedicated database/schema/application objects are
revoked. Only CONNECT is re-granted to the app; TEMP is migration-only. Default
privileges for future migrator-owned tables, sequences, functions and types deny
PUBLIC/app access. The global function-default revocation is important: a
per-schema revocation alone cannot remove PostgreSQL's global PUBLIC EXECUTE
default. These default changes affect only future objects created by the
migration role in this database, not unrelated databases or built-in functions.

Future migrations explicitly grant only what the API needs, in the same
transaction as object creation, for example:

```sql
-- Illustrative statements for a future reviewed migration, not executed here:
GRANT SELECT, INSERT, UPDATE, DELETE ON public.approved_future_table TO health_wallet_app;
GRANT USAGE ON SEQUENCE public.approved_future_sequence TO health_wallet_app;
GRANT EXECUTE ON FUNCTION public.approved_future_function() TO health_wallet_app;
```

Never use blanket default CRUD grants to all new tables: future migration/internal
tables must remain private. Do not grant sequence UPDATE (setval), TRUNCATE,
REFERENCES, TRIGGER, grant options or SECURITY DEFINER execution without a
separate demonstrated need. New migrations must execute as the migration role
so its defaults and ownership apply.

## Verification and safety

The existing 19-test schema suite retains its checks. Its ledger, lock and DDL
probes now use the migration identity; its synthetic application fixtures and
HTTP checks use the runtime identity. This preserves the expected rejection of
duplicate tracking versions without granting the app ledger access.

The security suite checks both actual session identities/role flags, absence
of memberships/ownership, database/schema/TEMP restrictions, CREATE DATABASE
and CREATE ROLE denial, table creation/alter/drop denial, inability to assume
administrator/owner roles, ledger isolation and exact CRUD privileges. Real
CRUD is tested on synthetic patient rows inside a rollback transaction.
CREATE DATABASE uses the already-existing database name so even a permission
regression cannot create another database. DROP is attempted only against an
empty patients table with restrictive dependents; populated tables use catalog
ownership proof instead. All transactional permission probes use savepoints
and rollback. No destructive test targets real patient records.

Migration-owner DDL, ledger insertion and deny-by-default grants are tested with
uncommitted synthetic objects/rows, then rolled back. These probes create no
persistent schema changes or history. Actual local secrets are checked against
all tracked and nonignored source files without printing them. Both health
endpoints are served on an ephemeral loopback port through the runtime pool.

## Known boundaries and AWS RDS considerations

Least-privilege roles do not implement patient isolation: this shared app role
can read/write all application-table rows. Request authentication, patient
ownership checks, grant/OTP validation, and an approved RLS/privacy design remain
future work. Role flags alone do not protect against compromised application
logic or authorized CRUD misuse. No patient authentication or RLS policy was
implemented here.

Both local credential files are owned by the same operating-system user. Separate
loading prevents accidental owner-pool use by Express, but does not provide OS
isolation from an attacker executing arbitrary code as that user. Production
runtime deployments should mount only runtime credentials; owner secrets belong
in an isolated migration job/secret store. Previously opened administrator
connections remain administrator sessions until those processes restart.

The bootstrap administrator is deliberately preserved, not demoted or deleted.
Built-in pg_catalog privileges are left intact. PUBLIC CONNECT privileges on
other databases in the dedicated PostgreSQL cluster are not changed; restricting
those requires an approved cluster/pg_hba policy. No unrelated database or host
service on port 5432 is modified. There are no custom unrelated schema objects
in the dedicated application database that need preserved application grants.

For AWS RDS, use its administrative identity/rds_superuser capabilities for
initial provisioning rather than expecting true PostgreSQL superuser or Docker
socket access. Adapt the operational provisioning transport and explicitly
review role ownership/default grants. Keep runtime and migration identities
separate, use Secrets Manager or equivalent managed secrets, TLS with verified
RDS CA, private networking/security groups, backups and reviewed migrations.
Local 127.0.0.1:5433 guards must be deliberately adapted before migration tooling
can target RDS. No AWS deployment or RDS resources are created by this phase.

References: [PostgreSQL 16 privileges](https://www.postgresql.org/docs/16/ddl-priv.html),
[default privileges](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html),
[role attributes](https://www.postgresql.org/docs/16/sql-alterrole.html).

## Files changed

Created:

- backend/.env.migrations.example: migration credential placeholders.
- backend/src/database/migration-pool.ts: owner-only tooling pool.
- backend/src/database/security.test.ts: permission and credential verification.
- infrastructure/database-roles.sql: explicit reviewed roles/ownership/grant policy.
- infrastructure/scripts/provision-roles.mjs: repeatable dedicated-container provisioning.
- docs/PHASE_1_4A_DATABASE_SECURITY.md: architecture, setup, procedure and results.
- backend/.env.migrations: ignored owner-only local migration credentials.

Modified:

- .gitignore: allow only the placeholder .env.migrations.example into source.
- backend/package.json: db:provision and db:security:test commands.
- backend/.env.example: restricted runtime role and password placeholder.
- backend/src/config/env.ts: separate runtime/migration loading and identity guards.
- backend/src/database/migrations.ts: use migration credentials/pool.
- backend/src/database/migrate.ts: close the migration pool on CLI completion.
- backend/src/database/schema.test.ts: owner-only migration probes, restricted
  application fixtures, separate-pool cleanup and new ignored-secret-file check.
- backend/.env: replace bootstrap credentials with restricted runtime credentials;
  retain existing connection target, application settings and permissions.

Unchanged: initial SQL migration, package-lock.json/dependencies, runtime pool,
Express routes/server, infrastructure credentials and Docker Compose configuration.

## Executed results — 2026-10-20 (Asia/Karachi)

- Role provisioning succeeded twice. Both identities authenticated over dedicated
  host port 5433. On the second run both credential files and their permissions
  remained byte-for-byte unchanged. No existing-role passwords were rotated.
- Role flags for both new logins: NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
  NOREPLICATION, NOBYPASSRLS, NOINHERIT. Zero memberships in either direction.
- Existing schema suite: 19 passed, 0 failed, 0 skipped. Application fixtures and
  cross-patient constraints now run through health_wallet_app.
- Security suite: 15 passed, 0 failed, 0 skipped, including normal API imports
  loading no migration secret and rejecting an administrator DB_USER.
- Typecheck and build passed. An initial security-test TypeScript inference
  error was fixed with an explicit Response annotation before verification.
- Migration status: applied 0001_initial_schema.sql. db:migrate: no migrations
  applied. The migration owner also passed actual CREATE/ALTER and ledger-write
  tests in rollback transactions.
- Final audit preserved all original object identities: 14 tables, 55 indexes
  and three invoker functions. They now belong to the migration identity.
  SQL checksum and the complete original migration ledger (including timestamp)
  are unchanged. No new application migration was created.
- All 13 application tables contain zero records after verification; no synthetic
  probe objects or tracking rows remain. No existing records/history were deleted.
- Both health endpoints returned HTTP 200 through the restricted pool in tests.
  The existing development watcher was refreshed without changing source content
  so it reloaded the runtime secret; both routes also returned HTTP 200 on the
  normal port 5000. Socket/process inspection confirmed its active backend child.
- A pre-existing idle administrator psql console on the container Unix socket
  was identified and left untouched. It is not a runtime TCP API connection.
- Runtime, migration and infrastructure secret files are ignored/untracked and
  mode 0600. Source scanning found none of their actual passwords in tracked or
  nonignored source files. Placeholder files remain source-visible.
- Dedicated-container commands only; no unrelated PostgreSQL database, host
  service on port 5432, Docker container or volume was changed.
- No dependencies, commits, pushes, authentication/product APIs or later phases.

Executed commands from backend included npm run db:provision (twice),
npm run db:status, npm run db:migrate, npm run db:test,
npm run db:security:test, npm run typecheck and npm run build. Supporting checks
included node --check for the provisioner, git diff --check, git check-ignore,
git ls-files, file permissions, read-only ownership/history audits, credential
file hash comparison and HTTP requests. Elevated SQL used only the explicitly
named dedicated container. The initial ownership-audit approval review timed
out; its permitted retry succeeded. A sandboxed socket-inspection attempt was
restricted; an approved read-only inspection resolved it. No permission request
or implementation failure remains outstanding.

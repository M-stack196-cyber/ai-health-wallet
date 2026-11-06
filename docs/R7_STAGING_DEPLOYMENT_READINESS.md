# R7 – Disposable staging: deployment readiness

Status: **files and local checks only. Nothing has been deployed. No AWS call was made.**
Region and shape follow the owner's decision: **us-east-1, one disposable node, free-tier budget, dev team owner.**
Production AWS, real email, real AI and clinical activation stay disabled.

## What exists

| File | Purpose |
|---|---|
| `infrastructure/staging/backend.Dockerfile` | Node API image (digest-pinned base, non-root, no tests, migrations included) |
| `infrastructure/staging/ai-service.Dockerfile` | Python FastAPI image for RAG, summary and OCR (one image, three commands) |
| `infrastructure/staging/web.Dockerfile`, `nginx.conf` | Doctor (8080) and Admin (8081) web apps on separate origins |
| `infrastructure/staging/docker-compose.staging.yml` | One-node topology, hardened containers, file-based secrets, **no database container** |
| `infrastructure/staging/load-secrets.sh` | Turns `NAME_FILE` paths into environment values for one process; never prints values |
| `infrastructure/staging/db-recovery.mjs` | `backup` and `restore` for PostgreSQL |
| `infrastructure/staging/staging.env.example` | Variable names only |
| `.dockerignore` | Keeps `.env*`, keys, evidence, dumps, `.git`, `node_modules`, docs out of every image |

Decisions the code now enforces: the API links to RDS only over verified TLS (`DB_SSL_CA_FILE`); migrations on staging need
`MIGRATION_TARGET=staging`, a us-east-1 RDS host, the database `ai_health_wallet_staging`, and the operator repeating the host in
`MIGRATION_CONFIRM_HOST`; the API reads `TRUST_PROXY_HOPS` so rate limits see the real client address behind nginx (before R7 every
user shared the proxy's address); the API builds its AI-service client from `RAG_*` settings (before R7 a deployed API always
answered record questions with "unavailable"); S3 access uses the host's instance role, never stored AWS keys.

## Topology notes

* The Python services listen on `127.0.0.1` only and the Node client accepts only that address. Compose therefore runs them in the
  API's network namespace (`network_mode: service:api`). They have no credentials, but they share the API's outbound network access:
  restricting it needs security-group / VPC-endpoint rules in AWS (not done).
* Summary and OCR are under the `optional` profile and off. Processing, summaries, email and guardian alerts are configured off.
* There is **no automatic failover**: one node by design. Recovery means rebuilding from a backup (below).
* TLS is not terminated by anything in these files. `web` listens on loopback; a load balancer or host proxy with a certificate is needed.

## Backup and restore (V-21 drill, local only)

```
# as the schema owner (migrator), standard libpq variables for the source database
node infrastructure/staging/db-recovery.mjs backup --out /secure/backups
# as the schema owner, into an EMPTY database named *_restore (roles health_wallet_app and health_wallet_migrator must exist)
node infrastructure/staging/db-recovery.mjs restore --backup /secure/backups/hw-backup-<time>.dump
```
The backup takes one consistent snapshot, writes a `.dump` and a `.manifest.json` (file mode 0600, folder 0700) holding the checksum,
migration ledger, table row counts, row-level-security flags, policy count and application grant count. It holds no personal data.
Restore checks the checksum first, refuses a non-empty target, a target not named `*_restore`, the application role, and missing
roles; restores in a single transaction; then compares everything above with the manifest.
**Cutover** after a verified restore is manual: point `DB_HOST`/`DB_NAME` (and the app password secret) at the restored database,
restart `api`, check `/api/v1/health/db`. The dump is **not encrypted** by the tool: keep it only on encrypted storage.

## Owner inputs still needed (everything below is BLOCKED until given)

* AWS account and the approved IAM role name; the instance profile for S3 and KMS use.
* RDS instance (us-east-1), its CA bundle, the `ai_health_wallet_staging` database, both roles, and RDS automated-backup settings.
* Private S3 bucket (block public access, owner enforced, default KMS encryption) and its KMS key. The older live-verification
  tooling still points at a different region and account (ap-southeast-2); it was left untouched and is not used by staging.
* **CFG-09 values: backup schedule, retention, RPO and RTO, and the incident owner are not approved.** The drill reports the time
  it observed on a tiny local database; that is not an approved RTO.
* TLS certificate and domain, the load balancer or host proxy, IP restriction for the Admin origin, and the real `TRUST_PROXY_HOPS`.
* Upload of backups to the private bucket (not built), monitoring and alerts, and a drill against RDS itself.
* Legal/privacy approval of retention and backup deletion (CFG-12 / CFG-18) before any real-patient data is stored.

## How to check it again

```
cd backend
npm run r7:test        # static checks, backup/restore drill, and real image builds if Docker is available
npm run staging:check-env   # problem codes (never values) for the environment of the current process
```

# Security maintenance — body-parser advisory remediation

29 October 2026 · Asia/Karachi. Authoritative entry/current Git checkpoint: `012413ae0b48a884d945378fa4eb92db061d4ec1` (`Implement Phase 6 doctor sharing backend`). Tracked worktree was clean at entry. Scope is dependency/security maintenance only. No M10/later module, production application refactor, schema migration, deployment, commit or push was performed.

## Root cause and original audit

The installed/locked dependency path was:

```text
backend@1.0.0
└── express@5.3.0                 direct dependency (^5.3.0)
    └── body-parser@2.3.0        transitive dependency (^2.3.0)
```

`express-rate-limit@8.7.1` also uses the same deduplicated Express installation; there is a single body-parser installation. The backend does not explicitly depend on body-parser.

The local `npm audit --json` reported one high vulnerability, with no other findings:

| Audit field | Finding |
|---|---|
| Advisory | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) |
| npm advisory source ID | 1243074 |
| Title | body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body |
| Severity / CVSS | high / 7.5 |
| CWE | CWE-248 (uncaught exception) |
| Affected range | `>=2.0.0 <2.4.0` |
| Installed affected node | `node_modules/body-parser`, version 2.3.0; `isDirect: false` |
| Minimum patched version | 2.4.0 |

The application mounts `express.json({limit: "100kb"})`, with compressed JSON inflation enabled by default, so the vulnerable parser path was relevant even though the application does not mount URL-encoded middleware. Multipart documents use the existing separate Busboy pipeline.

Private original audit evidence: `.private-evidence/security-body-parser-20261029/audit-before.json`. Findings above are the local npm registry audit response, not an assumption based solely on package age.

## Minimum remediation and exact package changes

Registry metadata (`npm view express version dependencies.body-parser`, `npm view body-parser version`) showed Express 5.3.0 is already the latest published direct dependency and accepts body-parser `^2.3.0`. Patched 2.4.0 satisfies that existing range. Updating Express's version is therefore unnecessary; the smallest compatible action is to refresh its already-permitted transitive dependency.

Executed from `backend/`:

```sh
npm update body-parser --ignore-scripts
npm audit --json
npm ls express body-parser
```

npm reported **changed 1 package** and **found 0 vulnerabilities**. No force, override/resolution, explicit new body-parser dependency, manual lockfile editing, install scripts or unrelated upgrade was used.

| Package | Before | After |
|---|---|---|
| Express | 5.3.0 | 5.3.0 |
| body-parser | 2.3.0 | 2.4.0 |
| All other installed/locked package entries | unchanged | unchanged |

Only the `node_modules/body-parser` lockfile entry changed: version, resolved registry tarball, integrity and its published dependency ranges (`content-type` ^2.0.0→^2.1.0, `iconv-lite` ^0.7.2→^0.7.3, `qs` ^6.15.2→^6.16.1). Those dependencies were already locked at compatible versions; their own lock entries did not change. A structural comparison against HEAD verified exactly one changed package entry. `backend/package.json` is byte-identical to HEAD. The lockfile was generated entirely by npm and records patched 2.4.0 for reproducible installs.

## Compatibility and focused verification

No production route, parser configuration, middleware order, authentication logic, guardian workflow, doctor-sharing policy or upload implementation changed.

New focused checks in `backend/src/security-checks/body-parser.check.ts`:

| Check | Result |
|---|---|
| BP-01: JSON objects; valid identity/gzip/deflate/Brotli bodies; malformed JSON; 100kb limit; unsupported encoding; malformed gzip containment and continued availability | PASS |
| BP-02: five chunked requests with delayed invalid trailing bytes after a complete gzip JSON member; subsequent health request remains available | PASS |
| BP-03: Express JSON middleware skips multipart; actual Busboy document parser preserves file name, metadata and bytes | PASS |
| BP-04: actual compiled `createApp` startup/health and invalid-body checks across auth/guardian/document/sharing routes | PASS |

The startup check copies compiled code to a test-owned temporary directory without `.env`, uses synthetic configuration and a database implementation that rejects any query, disables live storage/email/sharing, and removes the copy afterward. No application credentials or real database/cloud service are needed. This is supplemented by positive authenticated integration checks below, including enabled doctor-sharing routes.

Application behavior remains compatible: valid JSON and compressed JSON parse normally; malformed JSON returns 400, oversized JSON 413 and unsupported encoding 415. Malformed gzip remains contained by the existing generic 500 error response with no raw decoder detail; this maintenance does not change that pre-existing error-classification behavior. Trailing-data probes verify process survival/continued requests rather than imposing a new 2xx/4xx classification on a decompressor that may already have completed its response.

There is **no production `express.urlencoded`/`bodyParser.urlencoded` middleware**. URL-encoded login input continues to be rejected with 415 by the JSON-only auth contract; no URL-encoded support was added.

Executed checks:

| Command / focused suite | Result |
|---|---|
| `npm --prefix backend run typecheck` | PASS |
| `npm --prefix backend run build` | PASS |
| `cd backend && node --import tsx --test --test-concurrency=1 src/security-checks/body-parser.check.ts` | **4/4 PASS**, 0 failed/skipped |
| `IDENTITY_TEST_PGVECTOR_PREFIX=/tmp/hw-phase5-pg node infrastructure/identity/run.mjs --execute-isolated --phase2` | **33/33 PASS**, 0 failed/skipped |
| `PHASE3_PYTHON=/tmp/hw-phase3-python/bin/python node infrastructure/identity/run.mjs --execute-isolated --phase6` | **11/11 PASS**, 0 failed/skipped |
| Post-remediation `npm audit --json` | **0 total vulnerabilities**, including 0 high/critical |
| `npm ls express body-parser` | Express 5.3.0 → body-parser 2.4.0; no invalid dependency |
| `git diff --check` | PASS |

**48 focused tests passed.** Phase 2 coverage includes actual registration/email verification, current patient authentication, guardian nomination/acceptance/resend/replacement/removal, malformed/body-injection rejection, valid PDF/JPG/JPEG/PNG uploads, MIME/signature/size rejection, metadata/ownership and private retrieval checks. Its storage adapter checks use synthetic SDK responses, with no AWS network calls. Phase 6 coverage includes both grant paths, encrypted OTP dispatch/replay/attempt limits, selected-source metadata/original/timeline/summary/RAG access, expiry/revocation, account/deletion overrides and mid-request authorization changes. No broad repository regression suite ran and no Python source changed.

Integration checks used fresh Unix-socket-only disposable PostgreSQL clusters with synthetic data. Both clusters stopped successfully: `/tmp/hw-phase1-pg-9wUlKr` (Phase 2) and `/tmp/hw-phase1-pg-31E5r7` (Phase 6). No application/production database, live email provider or real bucket was accessed. Existing migration code was exercised unchanged; no migration was added or edited.

Private evidence directory: `.private-evidence/security-body-parser-20261029/`:

- `audit-before.json`, `audit-after.json`.
- `http-body-parsing.log` (4/4).
- `auth-guardian-documents.log` (33/33).
- `doctor-sharing.log` (11/11).
- `verification.json` (checkpoint, artifact/evidence hashes, package-entry and tracker-preservation checks).

## Governance, changed files and remaining risk

Tracked changes are limited to:

1. `backend/package-lock.json`: npm-generated compatible transitive security update.
2. `backend/src/security-checks/body-parser.check.ts`: focused parser/advisory/startup regression checks.
3. `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md`: maintenance reference and M15-007 evidence only; no status upgrade.
4. `docs/SECURITY_BODY_PARSER_REMEDIATION.md`: this report.

All 232 requirement IDs/text/source mappings/priorities/statuses remain intact; only M15-007's implementation/evidence/gap annotations change. Totals remain **92 IMPLEMENTED / 51 PARTIAL / 64 MISSING / 19 BLOCKED / 6 NEEDS_REVERIFICATION**. All other requirement rows, authoritative documents, migrations and historical evidence/receipts remain unchanged. The maintenance reference supersedes only the individual dependency blocker recorded in the immutable Phase 6 report/receipt.

**The recorded high-severity body-parser blocker is RESOLVED in the current installed and locked tree.** Zero audit findings describes the audit response at qualification time; it does not certify absence of unknown vulnerabilities or production readiness. Release installs must use the committed lockfile and continue dependency auditing. Existing client/live-provider/cloud/security-policy/clinical/privacy/retention gates remain open; this update approves none of them. No deployment was performed, so this report makes no claim about an externally deployed dependency tree.

STOP for owner review. No commit or push performed.

# Phase 1.4 database schema and migrations

> Phase 1.4A update: runtime/owner roles are now separated. See
> [database security hardening](PHASE_1_4A_DATABASE_SECURITY.md) for current
> credentials, provisioning, permission boundaries and verification. Statements
> below about a superuser runtime describe the historical Phase 1.4 state.

## Scope and source limitation

The requested `docs/AI_Health_Wallet_Final_SRS_v3.docx` was absent when this
phase was implemented. No SRS sections, submitted proposal or separate list of
12 decisions could be reviewed. This schema implements the requirements in the
Phase 1.4 request; the assumptions below need reconciliation with those sources
when supplied. No authentication, upload, sharing, notification, OCR, AI or RAG
services are implemented.

## Run locally

From `backend/`, with the existing ignored `.env` configured:

```sh
npm run db:status
npm run db:migrate
npm run db:migrate
npm run db:test
npm run typecheck
npm run build
```

These commands reuse `pg`, `tsx`, the environment loader and the existing pool.
No dependencies or extensions were added. Migration DDL uses a transaction-local
30-second statement timeout, a 35-second driver timeout and a 3-second lock
timeout; normal API pool timeouts are unchanged. Database tooling refuses a target
other than `127.0.0.1:5433/ai_health_wallet`. Docker maps this host port to 5432
inside the dedicated container; the unrelated host service on 5432 is untouched.
Do not print `.env`, connection strings or raw driver errors.

SQL migrations are source files under `backend/migrations/`. Add each future
change as a new `NNNN_lowercase_description.sql` file. Versions sort
lexicographically, must be unique and must extend existing history. Applied
files must never be edited, renamed or removed. Store these files in version
control with the rest of the source; this implementation does not commit them.

The small migration runner uses a project-specific PostgreSQL session advisory
lock, a `schema_migrations` ledger with unique version/name and SHA-256 checksums,
and one transaction per migration including its ledger insertion. Concurrent
operations fail safely and can be retried. Status inspects history without
creating the ledger. An empty ledger can remain after a failed first migration;
that migration's DDL and tracking row are rolled back together. Earlier successful
migrations remain applied if a later migration fails. Failures expose controlled
messages or SQLSTATE codes, without SQL parameters or connection details.

Migration SQL is trusted source and must not contain BEGIN/COMMIT/ROLLBACK or
commands incompatible with transactions, such as CREATE INDEX CONCURRENTLY.
There are no reset, drop, truncate or automatic down-migration commands. An
unexpected application table is an error, not silently adopted or overwritten.
Restore the original migration file if checksum validation fails; use a new
forward migration to repair schema. A checksum verifies file history, not all
possible manual database schema changes. Take backups before future migrations
against databases containing real records.

## Tables

All entity identifiers are UUIDs with PostgreSQL 16's built-in
`gen_random_uuid()` default. All event timestamps use TIMESTAMPTZ. Calendar
dates use DATE. Table/field comments below describe storage, not implemented APIs.

| Table | Purpose and relationships |
| --- | --- |
| patients | Canonical unique email as local authentication identity, password hash, full name, optional birth date/phone, created/updated timestamps. |
| guardian_contacts | Patient-owned email contact, optional name, consent timestamp/version and optional revocation, created/updated timestamps. No account/password. One email per patient. |
| medical_documents | Patient-owned private S3 bucket/key, original filename, file extension/type, category, optional hospital/date, upload timestamp and processing state. Bucket/key is globally unique. |
| extracted_medical_text | One current OCR extraction per document, including patient, text, state, extractor version, bounded-purpose JSON source metadata and created/updated timestamps. |
| medical_document_chunks | Ordered, nonempty text chunks scoped to document/patient, JSON source reference (for example page/offset), creation timestamp. Zero-based order is unique per document. No embeddings. |
| ai_report_summaries | Document/patient-scoped summary attempts, state, optional model name/version and generation timestamp. Multiple attempts/versions are allowed. |
| doctor_sharing_grants | Patient, canonical doctor email, QR/link method, unique 32-byte token digest, creation/expiry/revocation timestamps. |
| sharing_grant_documents | Explicit grant/document association with the same patient on both sides. Composite primary key prevents duplicate selections. |
| doctor_otp_challenges | Grant/patient/doctor binding, 32-byte keyed OTP verifier and external key version, expiry, attempt count, verification timestamp and creation timestamp. Verification status is derived from verified_at. |
| guardian_notification_events | Document/patient/guardian binding, routine/serious notification type, delivery state, optional sanitized failure code, creation/delivery timestamps. |
| serious_finding_evaluations | Document/patient binding, rule-set version, three-state outcome, optional flagged findings, optional same-document AI summary reference, evaluation timestamp. |
| rag_interactions | Patient, optional sharing grant for doctor context, question, optional answer and creation timestamp. No duplicate document text. |
| rag_interaction_sources | Normalized source document references for an interaction; optional grant context must match the interaction and include the selected document. |
| schema_migrations | Version, filename, checksum and applied timestamp; maintained by the runner. |

## Integrity and values

Every document-derived row references `(document_id, patient_id)` together.
Notification guardians reference `(guardian_contact_id, patient_id)` together.
Sharing selections reference both `(grant_id, patient_id)` and
`(document_id, patient_id)`, so either way of forging an ownership ID is rejected.
OTP rows reference the grant's `(id, patient_id, doctor_email)` triple. AI
explanation references include summary ID, document and patient. All foreign
keys retain PostgreSQL's restrictive NO ACTION deletion behavior. There are no
deletion cascades that could remove original documents after delivery failures.

RAG source rows reference interaction ownership, document ownership and, for a
doctor interaction, the exact grant/document selection. A trigger locks and
checks the parent interaction so a nullable grant cannot bypass selection
constraints. Another trigger makes the recorded interaction authorization
context immutable. Revoking a grant uses revoked_at; historical records remain.
Existing cited selections cannot be removed while source records reference them.

Checks constrain:

- Document categories: `lab_report`, `prescription`, `other_medical_document`.
- File extensions: `pdf`, `jpg`, `jpeg`, `png` (MIME/content validation is future API work).
- Document/extraction/summary states: `processing`, `completed`, `failed`.
- Sharing methods: `qr_code`, `unique_link`; expiry strictly follows creation.
- OTP attempts: nonnegative; verification time lies within the challenge lifetime.
- Notification types: `routine_report`, `serious_report_alert`; delivery states:
  `pending`, `sent`, `failed`. Only sent events have delivered_at.
- Finding outcomes: `flagged`, `not_flagged`, `indeterminate`. Flagged requires
  a nonempty findings array; not_flagged has no findings.
- Nonempty content where required, normalized email values, JSON object/array
  shapes, nonnegative chunk order, and digest/verifier byte lengths.
- Completed extractions contain text; completed summaries contain text and
  a generation timestamp. Update triggers maintain updated_at for patients,
  guardian contacts and extracted text.

## Index inventory

Primary keys and UNIQUE constraints create their own B-tree indexes. These
include patient email, per-patient guardian email, private S3 reference,
document ownership tuples, chunk ordering, token digest, sharing selections,
and the migration version/name. Composite unique keys support ownership FKs;
their extra indexes are intentional even where the leading ID is already unique.

The migration also creates these 26 explicit B-tree indexes:

| Table | Explicit index names |
| --- | --- |
| medical_documents | medical_documents_patient_upload_idx; medical_documents_patient_hospital_idx; medical_documents_patient_category_idx; medical_documents_patient_timeline_idx |
| extracted_medical_text | extracted_medical_text_patient_idx |
| medical_document_chunks | medical_document_chunks_patient_idx |
| ai_report_summaries | ai_report_summaries_document_idx; ai_report_summaries_patient_idx |
| doctor_sharing_grants | doctor_sharing_grants_patient_idx |
| sharing_grant_documents | sharing_grant_documents_grant_patient_idx; sharing_grant_documents_document_idx; sharing_grant_documents_patient_idx |
| doctor_otp_challenges | doctor_otp_challenges_grant_idx; doctor_otp_challenges_patient_idx |
| guardian_notification_events | guardian_notifications_document_idx; guardian_notifications_guardian_idx; guardian_notifications_patient_idx |
| serious_finding_evaluations | serious_finding_evaluations_document_idx; serious_finding_evaluations_summary_idx; serious_finding_evaluations_patient_idx |
| rag_interactions | rag_interactions_patient_idx; rag_interactions_grant_idx |
| rag_interaction_sources | rag_interaction_sources_interaction_idx; rag_interaction_sources_document_idx; rag_interaction_sources_grant_idx; rag_interaction_sources_patient_idx |

Every FK's referencing columns have a matching leading index prefix, verified
by catalog inspection in the tests. Hospital lookup uses exact matching after
lowercasing, not substring/fuzzy search. Patient-scoped upload, category and
hospital indexes support common document retrieval. No vector, text-search or
extension indexes were introduced.

## Derived timeline

No duplicate history table is needed. Use this query, also backed by the timeline
expression index, with `$1` supplied by the authorized request context:

```sql
SELECT id, original_filename, hospital_name, category, document_date, uploaded_at
FROM public.medical_documents
WHERE patient_id = $1
ORDER BY COALESCE(document_date, (uploaded_at AT TIME ZONE 'UTC')::date) DESC,
         uploaded_at DESC, id;
```

## Security boundaries and assumptions

Foreign keys enforce consistency, not read authorization. They do not prevent
a SQL caller from selecting other patients' records. No RLS or authentication
middleware was added in this phase. The existing Docker-created application
role is a superuser. Separate restricted runtime and migration roles, and an
approved authorization/RLS design, remain necessary before patient-facing
services. Current role/configuration was preserved as requested. No production
isolation guarantee is made.

Future APIs must derive patient identity from verified authentication, scope
every query, and validate grant token, recipient OTP verification, expiry,
revocation and the selected-document set on every doctor access. Timestamp
constraints describe valid stored intervals; they do not automatically disable
expired access or require OTP verification for arbitrary SQL operations. OTP
expiry must also be bounded by its grant's lifetime in the future service.
Guardian delivery must check current consent and revocation; a contact row alone
does not grant permission. S3 bucket/key fields neither configure AWS nor prove
an object is private; future storage policy must enforce private access.

Physical design assumptions, pending SRS reconciliation:

1. Email is the authentication identity, stored lowercase and trimmed. The
   database format check is structural, not complete email validation. Profile
   fields are limited to full name, optional birth date and optional phone.
2. Password storage accepts Argon2 PHC or bcrypt encodings. The format guard
   rejects ordinary plaintext but cannot prove a value was securely hashed.
   Future authentication must generate and validate real hashes; hash parameters
   and algorithm choice remain an authentication-phase decision.
3. A sharing token is a high-entropy random secret; store its SHA-256 digest
   (32 bytes), never the token or a full access URL. OTPs have low entropy and
   require a keyed HMAC-SHA-256 verifier with a secret kept outside PostgreSQL.
   Store only the verifier and its external key version. Byte length alone
   cannot prove hashing. No hashing, keys, tokens or OTP generation is implemented.
4. Contact consent version records the approved consent text/version for medical
   record delivery. Exact consent wording, retention, re-consent behavior and
   delivery policy remain product decisions. Consent is optional until recorded.
5. One current extraction per document; summaries/evaluations may have multiple
   attempts. Chunks reference the original document and carry page/offset JSON
   rather than duplicate full source content or add vectors.
6. An optional AI explanation references a same-document report summary. A
   separately generated explanation would require a later approved migration.
7. A NULL RAG sharing grant denotes patient context; a non-NULL grant denotes
   doctor context. Question/answer are stored once, with document citations in
   an association table. Retention/redaction policy remains undecided.
8. TTLs, OTP attempt limits, document clinical thresholds, embedding model and
   dimensions are deliberately unspecified. No clinical rules are encoded.

## Verification design

`npm run db:test` uses Node's built-in test runner through existing tsx. Apply
migrations explicitly first; the suite requires all files to be applied. It
re-runs the runner twice and compares table OIDs and tracking versions, validates
catalog tables/indexes/timestamps and FK index coverage, tests checksum/order
validation and concurrent lock exclusion, and verifies transactional rollback
using a temporary table and a deliberately failing statement. It does not alter
the checked-in migrations or reset the database.

All synthetic patient, guardian, document, sharing, notification and AI metadata
fixtures run inside one transaction with savepoints around expected constraint
errors, followed by ROLLBACK. A subsequent query confirms the synthetic patient
IDs are absent. No real patient data is deleted. Tests exercise cross-patient
references, invalid states, duplicate records, verifier shape, time constraints,
RAG selected-record and NULL-bypass rejection, failed notification retention,
three-state evaluation, timeline fallback and update timestamps. The suite also
checks secrets are ignored/untracked and serves the existing Express application
on an ephemeral loopback port to verify both health routes against PostgreSQL.

The failed-migration rollback probe is expected to raise division-by-zero
internally; a passing test means its temporary DDL and tracking row did not persist.
Tests themselves require local socket and dedicated database access; sandboxed
environments may require an approved execution context.

Technical references: [PostgreSQL 16 constraints](https://www.postgresql.org/docs/16/ddl-constraints.html)
and [PostgreSQL 16 explicit/advisory locking](https://www.postgresql.org/docs/16/explicit-locking.html).

## Executed verification — 2026-10-20 (Asia/Karachi)

- Before migration: dedicated PostgreSQL 16.15 database had no user tables.
- Initial status: pending 0001_initial_schema.sql.
- Initial typecheck found a pg QueryConfig typing mismatch; corrected and
  typecheck subsequently passed.
- First migration attempt failed with SQLSTATE 57014 under the existing short
  timeout. Read-only inspection confirmed no user tables had persisted. The
  runner was corrected to use bounded migration-only DDL timeouts.
- Retry: applied 0001_initial_schema.sql; final status confirms applied.
- Ledger contains exactly one migration, version 0001. The verification suite
  ran migrations twice more: both were no-ops and table OIDs remained unchanged.
- npm run db:test: 19 tests passed, 0 failed, 0 skipped. This includes both HTTP
  health endpoints returning 200 and the real database query succeeding.
- npm run typecheck and npm run build both passed on the final implementation.
- Final catalog inventory: 14 tables (13 application tables plus ledger),
  55 B-tree indexes (26 explicit plus 29 primary-key/unique indexes).
- Final count across all 13 application tables: zero records. Synthetic fixtures
  were rolled back; only the migration ledger row persists.
- All 10 preserved files were compared by SHA-256 and are byte-for-byte unchanged:
  root .gitignore, existing env loader, pool, Express app, server, backend .env,
  .env.example, infrastructure .env, Docker Compose and package-lock.json.
- Credential files remain ignored and untracked. No dependencies, commits,
  pushes, Docker changes, schema resets or extra product functionality.

Commands executed from backend include npm run db:status, npm run db:migrate,
npm run db:test, npm run typecheck and npm run build. Supporting read-only Git
checks were git status --short, git diff --check, git check-ignore and git
ls-files for the two credential files. Temporary inspection/audit scripts
verified database inventory, record counts and preservation without printing
secrets. Existing source and Docker configuration were read before editing.

Open decisions are the missing SRS/proposal reconciliation, restricted runtime
role and future access policy, consent/retention policy, authentication hash
parameters, sharing/OTP policy, AI explanation representation and eventual
embedding model/dimensions. They do not prevent the requested schema and
verification phase from being complete; no later phase was started.

# Phase 2.2C-A — Lease-fenced extraction persistence

## Scope and specification

Reviewed the actual `AI_Health_Wallet_Final_SRS_v3.docx`, especially §14.1–14.3 and V-05/V-06, both existing migrations, lifecycle/retrieval implementations and their tests. This subphase supplies the missing persistence boundary for a future genuine extractor: owner-linked output, current-attempt evidence, atomic completion and safe failure/recovery. It does not implement or claim real PDF extraction, OCR, medical accuracy, summaries, embeddings, RAG or later features.

No Tesseract, Poppler, AWS or actual medical original was invoked. Tests use explicitly synthetic output and scoped synthetic patients only. No processor starts automatically. Existing public APIs, storage, IAM, credentials and AWS configuration remain outside this change.

## Migration 0003

`backend/migrations/0003_lease_fenced_extraction.sql` was applied through the existing migration runner using `health_wallet_migrator` on the dedicated local PostgreSQL database. Applied migrations 0001 and 0002 are unchanged.

The existing `extracted_medical_text` table has only one output row per `(document_id, patient_id)`, and previously associated completion with timestamp freshness alone. Migration 0003 adds:

- Nullable `processing_attempt` and `processing_claim_token` columns, with an association-pair/bounded-attempt constraint. Legacy rows remain unchanged with null association. They cannot be used to prove a new attempt's completion; modifying them requires replacement under a valid current claim.
- `valid_extraction_payload(text,jsonb,text)`, an invoker validation function with a fixed search path and bounded text/provenance checks.
- `fence_extraction_write()`, a BEFORE INSERT/UPDATE trigger. It rejects missing association, wrong ownership, malformed evidence, and stale/expired/non-running claims. It locks the matching job before checking token, attempt count and PostgreSQL clock deadlines. Extraction identity, owner and original creation timestamp are immutable.
- `fence_extraction_completion()`, a BEFORE UPDATE job trigger that requires validated evidence matching the running job's owner, document, attempt count and current token when transitioning to completed. The existing repository completion method also explicitly checks these associations, replacing timestamp-only evidence.
- `persist_document_extraction(uuid,uuid,uuid,text,jsonb,text)`, the atomic write/completion function described below.

No new table, index, queue or external dependency is needed. Existing ownership FKs and indexes remain. All new functions are SECURITY INVOKER, owned by the migration role, explicitly granted to the restricted application role and denied PUBLIC execution. Existing runtime table CRUD and role restrictions are preserved; there is no SECURITY DEFINER privilege escalation or runtime fallback to migration credentials.

The migration does not rewrite or fabricate existing evidence and does not delete an original, history record, job or S3 object. The existing output table remains a latest-result record, not an append-only extraction-attempt archive. Authorized replacement preserves its row ID and creation time; a separately approved history/retention design would be needed to archive every prior text version.

## Internal result contract

`processing/extraction.ts` defines and validates this input before SQL. No ownership, document reference, token or attempt value is accepted from extractor output. Those are derived from the independently verified processing claim and locked database job.

```ts
interface ExtractionResult {
  text: string;
  method: "pdf_text" | "ocr" | "mixed";
  extractor: { name: string; version: string };
  source: {
    sha256: string;
    pageCount: number;
    pages: {
      page: number;
      method: "pdf_text" | "ocr";
      confidence?: number;
    }[];
  };
}
```

Rules:

- Text must contain non-whitespace content, at most 1,000,000 Unicode characters and 4 MiB UTF-8 bytes. It is retained without truncating or rewriting clinical content. NUL, unsafe C0/DEL controls and unpaired UTF-16 surrogates are rejected; tab, LF and CR are allowed. Unicode text and SQL-looking strings remain literal parameter data.
- Extractor name is 1–64 and version 1–128 ASCII identifier characters (letters/digits first, then letters/digits, spaces or `.+_:/-`). The existing `extractor_version` column agrees exactly with the validated provenance version.
- Source SHA-256 is exactly 64 lowercase hexadecimal characters, supplied by the future trusted extractor from the original input. There must be 1–200 pages, with exactly one ordered entry for each page, numbered 1 through pageCount.
- Page methods must agree with the overall method: pdf_text only, OCR only, or both for mixed. Optional confidence is a finite number 0–100 on OCR pages only. **Confidence is not evidence of medical accuracy.**
- Unknown fields at every level, malformed objects, ownership/attempt fields, empty results, inconsistent provenance and invalid page/confidence values are rejected. Metadata is constructed from an allowlist; no free-form medical metadata or arbitrary object is copied through.
- The canonical application metadata is at most 8 KiB serialized UTF-8, excluding the separately bounded text. PostgreSQL additionally caps its expanded JSONB text representation at 16 KiB and revalidates required keys/types/methods/pages/version. These hard limits have no environment bypass.

Stored `source_metadata` contains `{schemaVersion:1, method, extractor, source}`. Processing attempt/token association is stored in the dedicated columns. Raw SQL callers still face the database payload and lease trigger checks. Input validation and provenance record structure do not prove that a provider extracted genuine content or interpreted it correctly: actual source hashing and extractor behavior must be implemented and tested in a later approved subphase. This phase creates no placeholder evidence in production.

## Atomic persistence and lease fencing

`service.persistExtraction(claim, result)` validates claim UUIDs and the result, then invokes the parameterized repository method. It returns true only for a confirmed accepted atomic completion; invalid/stale claims return false without a write. Validation errors use `InvalidExtractionResult`/`InvalidProcessingInput`; unexpected database errors become generic `ProcessingUnavailable` without underlying SQL, text, provenance or identifiers.

The single autocommit function call performs:

1. SELECT the document/patient job FOR UPDATE, serializing against claims, heartbeats, failure, recovery and another persistence call. Check running state, the exact token, lease expiry and attempt deadline using `clock_timestamp()` after obtaining the lock, including after a lock wait.
2. Validate the bounded result, then INSERT or UPSERT the existing owner-scoped extraction row. Set its attempt number from the locked job and its token from the current claim. The extraction trigger independently locks/checks the same job. A current retry may replace earlier evidence while retaining row identity/creation time; a stale attempt cannot.
3. Set the job completed and clear its lease, with another live-time/token predicate. The completion trigger verifies the just-persisted current-attempt evidence.
4. Set the owning document completed, and recheck the original lease/deadline after any document-row lock wait. If any required update is absent or the deadline has elapsed, raise a generic exception. PostgreSQL rolls back **all** extraction/job/document writes made by the statement.

The row lock lasts only for this short persistence transaction, not for original retrieval, OCR, PDF parsing or external work. See [PostgreSQL row-level locking](https://www.postgresql.org/docs/16/explicit-locking.html). Existing pool statement/query timeouts remain active. Recovery uses SKIP LOCKED and cannot recover a job while its persistence transaction owns the lock. Once it commits, duplicates see completed and return false rather than overwrite; after rollback, the original running lease or normal recovery policy remains authoritative.

The existing staged-evidence-plus-`complete()` path remains compatible for trusted internal code, but staging now requires valid live attempt-bound provenance, and completion requires the same association. New extractors should use the atomic `persistExtraction()` interface. Plain timestamp freshness or another attempt's completed text is insufficient.

## Existing worker integration

The existing `DocumentProcessor` callback gains `persistExtraction(result): Promise<void>`, bound to the worker's immutable claim. It accepts one persistence attempt per callback and refuses calls after the callback scope closes or while an original-file scope is still open. Future flow:

```ts
async function futureProcessor({ withOriginal, persistExtraction }) {
  const result = await withOriginal(async input => {
    // Future separately implemented PDF/OCR extractor returns ExtractionResult.
    // No extractor is provided or invoked in Phase 2.2C-A.
    return futureExtractor(input);
  });
  await persistExtraction(result); // final action; input scope has closed
}
```

This is an interface illustration, not a configured or callable extractor. Closing `withOriginal()` first ensures its lease-monitor/file lifecycle does not race the intentional job completion. `persistExtraction` quiesces the worker heartbeat before its final atomic call, leaving the DB lease/deadline guards authoritative. It never holds a transaction open during the extractor callback.

The worker recognizes a confirmed atomic persistence as completion instead of trying to complete the already completed job again. Cancellation waits for the bounded pending database call and checks committed state by document, patient, attempt and accepted token before deciding the outcome. A lost acknowledgement is reconciled against matching persisted completion, without overwriting/deleting evidence or reverting a completed job. If read-back is unavailable, report unavailable and retain authoritative DB state; do not infer success or discard originals. Failed or cancelled writes that did not commit follow the existing bounded failure/recovery policy. Invalid extraction contracts are nonretryable input failures; transient processor/database failures retain existing bounded retry behavior.

No new worker, scheduler, startup side effect or public status-changing API was added. Empty/no-op processors still cannot complete. `withOriginal()` retrieval, cancellation/cleanup, claims and owner isolation continue to work.

## Security review and limits

- Every persistence operation checks owner/document/token in PostgreSQL and derives its attempt from the locked job. Public APIs expose neither the method nor raw extraction/job rows, claim tokens, S3 references or provenance.
- Payloads are passed as query parameters; no SQL identifiers or executable text come from output. SQL and application errors/logging contain no medical content or underlying database diagnostics. No AWS or raw medical original is used by these tests.
- Database triggers also reject unfenced direct INSERT/UPDATE to extraction rows and completed-state transitions without current evidence. A trigger/function error aborts the statement; no swallowing of write failures or success-with-empty-evidence behavior exists.
- The application role remains a trusted runtime boundary with its existing table CRUD, including job administration and deletion permissions. This is not isolation against compromise of that role or a database owner who can read/change job tokens, delete data or alter/disable safeguards. Do not expose raw DB access or job mutation to clients; a separate narrower worker role and retention rules are deployment decisions, not silently introduced here.
- A source fingerprint and extractor label are provenance assertions from the trusted future extractor, not proof of medical truth or a substitute for validating actual provider behavior. No OCR confidence threshold claims medical correctness.
- A stale/noncooperative process can keep computing after cancellation, but cannot write through this persistence boundary with an expired/replaced claim. It must not bypass the interface, mutate jobs, or persist results in another clinical table without equivalent fencing.
- Legacy evidence is preserved but unassociated; it is not automatically stamped as produced by a current attempt. Reprocessing/reset authorization, full historical output retention and production extraction quotas remain follow-up decisions. Later OCR/provider implementation must be separately approved.

## Verification

All tests operate only on synthetic IDs. Prior test cases were retained; two fixture helpers were upgraded to provide explicit current-attempt association and synthetic provenance: `processing/processing.test.ts` and `database/schema.test.ts`. Their existing assertions/test counts were not weakened or removed. Raw legacy fixture inserts would correctly be rejected by the new production trigger.

New `processing/persistence.test.ts` covers accepted writes; exact provenance/attempt binding; expired, replaced, forged and cross-patient claims; duplicate/concurrent writes; direct unfenced SQL; failed/recovered attempts and allowed replacement; strict input limits including exact maximum text; Unicode/parameter safety; DB metadata validation; atomic rollback after a document lock timeout; expiry after a write while blocked on synchronization; rechecking tokens after lock waits; concurrent failure versus persistence; worker composition; lost acknowledgements and cancellation after commit; safe errors; and restricted/invoker permissions.

| Command | Final result |
| --- | --- |
| `npm run processing:test` | 104 passed: 73 existing + 31 new; 0 failed/skipped |
| `npm run documents:test` | 44 passed, 0 failed/skipped |
| `npm run auth:test` | 29 passed, 0 failed/skipped |
| `npm run db:test` | 19 passed, 0 failed/skipped |
| `npm run db:security:test` | 15 passed, 0 failed/skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Compiled production persistence smoke check | Passed; synthetic worker/output/atomic DB completion, followed by fixture removal |

Final result: **211 tests passed, zero failed/skipped**, including all previous 180 cases and 31 new persistence tests. The compiled worker also passed an end-to-end synthetic persistence smoke check. No genuine extraction, OCR or clinical-accuracy acceptance result is claimed.

The final audit confirmed all preexisting data across the 14 application tables matches its baseline (using original columns for the additively extended extraction table), all relation identities are unchanged and all synthetic fixtures were removed. Existing patient/document counts remain one/one and no real extraction was created. Only the six planned existing source/test files changed. Migrations 0001/0002, package files, AWS config/credentials, actual runtime/migration secrets, infrastructure, storage/retrieval and public-route files match their baseline hashes. A tracked/nonignored scan found none of the configured database/JWT/AWS secrets. Runtime role flags remain restricted. No AWS operation or original-file processing was performed.

Created: migration `0003_lease_fenced_extraction.sql`, `processing/extraction.ts`, `processing/persistence.test.ts`, and this document. Modified: `processing/{errors,repository,service,worker}.ts` and the two synthetic fixture helpers above. No dependency, package/lockfile, AWS/S3/IAM, secret, retrieval, public-route or infrastructure change was made. No commit or push was performed. Work stops at Phase 2.2C-A.

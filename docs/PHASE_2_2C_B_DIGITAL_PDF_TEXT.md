# Phase 2.2C-B — Digital PDF text extraction

## Scope

Reviewed the actual SRS v3.0, especially §14.1–14.3 and V-05/V-06, the existing retrieval/lifecycle/persistence documentation, migrations 0001–0003, PDF.js API and installed source/types, and the existing tests. This subphase implements the digital embedded-text portion of extraction using the existing `pdfjs-dist` dependency. It does not implement scanned-document OCR, page rendering, Tesseract/Poppler invocation, clinical interpretation, AI, RAG, summaries, notifications, sharing, frontend or deployment.

No database migration, dependency, IAM/bucket/profile change or automatic worker registration is needed. Applied migrations, upload integrity validation, secure retrieval, existing worker and atomic persistence code remain unchanged. Tests use generated synthetic PDFs, fake/mocked storage and fresh scoped synthetic patient records; existing uploaded originals are not accessed or processed.

## Architecture and opt-in integration

- `processing/pdf-text.ts` provides `extractDigitalPdf(input, signal, config)` and safe typed failures. It admits a bounded number of concurrent extraction workers, enforces hard configuration ceilings, and terminates a worker on timeout, cancellation, error or completion. No parser diagnostic or medical text is logged.
- `processing/pdf-text-worker.ts` is a standalone Node 24 worker that reads a bounded original, computes SHA-256, parses PDF structure and streams embedded text page by page using PDF.js. It does not import runtime environment, database, S3 or application configuration.
- `processing/digital-pdf-processor.ts` exposes `createDigitalPdfProcessor(config)`, a reusable existing `DocumentProcessor` callback. It is not imported or registered by `app.ts` or `server.ts`.

The processor performs this exact sequence:

1. Enter existing `withOriginal()` and verify the live claim through `input.assertActive()`.
2. Extract embedded text from the validated private input in the isolated parser worker; recheck the claim before returning the output from the callback.
3. Await complete exit from `withOriginal()` so its temporary file/directory is removed.
4. Check cancellation and call the existing claim-bound `persistExtraction(result)` outside the input scope. Existing PostgreSQL locking/time/token checks remain authoritative if a lease is replaced or expires between extraction and persistence.
5. Let the existing atomic function complete the job/document/evidence together. No transaction is open while parsing the PDF.

Future orchestration can explicitly supply `createDigitalPdfProcessor()` as the processor argument to `createProcessingWorker(service, lifecycleConfig, processor, originalAccess)`. This phase does not schedule or run that composition automatically. A worker with no processor still returns `disabled`. Duplicate workers use the same existing atomic claim/lease protocol; a completed job is not processed twice.

## Text and page provenance

The worker reads only the regular, non-symlink local input using exclusive ownership established by secure retrieval. It checks the actual size against the receipt/configuration, allocates at most that size plus one byte, and rejects changes/truncation/growth. SHA-256 is computed from those exact bytes before PDF.js receives its typed-array copy. The original is never changed.

It checks PDF signature, EOF and cross-reference location before parsing to avoid accepting a header-only file or relying on PDF.js repair for a broken cross-reference header. PDF.js runs with strict errors, XFA disabled, system fonts/font-face rendering disabled, worker fetching disabled, and offscreen/image decoder support disabled. Catalog/page JavaScript actions, named embedded attachments and AcroForm/XFA documents are rejected. Attachment enumeration uses PDF.js metadata only; attachment content is never fetched. Encrypted or unsupported/invalid PDFs fail safely. No viewer scripting, canvas, rendering or OCR API is called.

Text comes from `page.streamTextContent({includeMarkedContent:false, disableNormalization:true})`. The implementation preserves PDF.js item order and returned strings, emits line breaks from its `hasEOL` indicators, removes trailing line-break markers per page, and joins sequential page text using two newlines. It adds no invented headings, page labels, diagnoses, missing words or placeholder text. Internal `pageTexts` retains each page separately. Persistent text uses the newline boundaries plus ordered page references permitted by the existing contract; precise page-offset metadata is not added to that contract.

The successful result is validated with existing `validateExtraction()`. The APIs used are documented in the [PDF.js API source](https://mozilla.github.io/pdf.js/api/draft/api.js.html):

```ts
{
  text: /* actual PDF.js embedded text, pages joined by two newlines */,
  method: "pdf_text",
  extractor: { name: "PDF.js", version: /* PDF.js module's actual version */ },
  source: {
    sha256: /* SHA-256 of the original input PDF */,
    pageCount: /* actual PDF document page count */,
    pages: /* sequential { page: 1..pageCount, method: "pdf_text" } */
  }
}
```

The installed resolved version during verification is PDF.js 6.4.299; code reads the library's exported version rather than hard-coding it. Unicode mapping is left to PDF.js and source ToUnicode data; tests cover accented Latin, Greek, Han and a supplementary Unicode character. Returned replacement-glyph U+FFFD is treated as unsupported rather than accepted as reliable text. No OCR confidence is generated.

## OCR-required outcome

If a page contains no letters or numbers in its selectable text, the reader returns an explicit internal `{kind:"ocr_required", pageCount, pages, sourceSha256}` instead of an `ExtractionResult`. Blank and image-only documents therefore generate no placeholder evidence.

The policy is conservative: **any** textless page, including a deliberately blank page in an otherwise digital PDF, requires OCR handling and prevents partial successful persistence. `OcrRequired` is a safe typed internal processor failure with `reason="ocr_required"`. The current database has no OCR-required enum, so the existing worker records a nonretryable `INVALID_INPUT` failure, preserves the original, and does not mark extraction complete. No migration or patient-facing status/API was invented. A later approved OCR phase must decide blank-page classification, mixed documents and authorized retry/resumption.

A scanned PDF that already contains a usable embedded OCR text layer can be read as `pdf_text`; this describes reading its existing text, not performing OCR in this phase.

## Limits, cancellation and isolation

Defaults/examples were added through the existing processing config/environment loader. Actual runtime and AWS environment files are untouched.

| Setting | Default | Allowed environment range |
| --- | --- | --- |
| `PDF_TEXT_MAX_FILE_BYTES` | 5242880 (5 MiB) | 1024–20971520 |
| `PDF_TEXT_MAX_PAGES` | 100 | 1–200 |
| `PDF_TEXT_MAX_CHARACTERS` | 1000000 | 1–1000000 |
| `PDF_TEXT_MAX_ITEMS` | 100000 | 1–200000 |
| `PDF_TEXT_TIMEOUT_MS` | 10000 | 1000–30000 |
| `PDF_TEXT_MAX_CONCURRENCY` | 2 | 1–4 |

The existing extraction contract's 4 MiB UTF-8 text cap and 8 KiB application metadata cap also apply. Streaming checks text items, characters, UTF-8 bytes and layout separators incrementally before assembling a result. The budget conservatively includes emitted line/page separators, including final line-break markers removed later. Oversized output is rejected, never silently truncated. Retrieval/upload limits remain independent; set approved limits consistently before activation.

Parser execution uses a Node worker with a 128 MiB old-generation/16 MiB young-generation V8 heap budget, explicit wall-clock timeout and termination, empty environment, no inherited exec arguments, and stdout/stderr drained without logging. Development uses Node 24's native TypeScript stripping; production resolves the emitted `.js` worker. Tests verified both paths. Admission is module-wide within one process; multiple application processes have separate limits. Busy admission fails safely/transiently through existing retry handling.

Cancellation comes from the existing worker AbortSignal and input-scope lease monitor. It prevents persistence, terminates the parser and permits existing retrieval cleanup. The processor also checks the live claim before/after extraction. PostgreSQL fencing independently rejects a stale result even if the token changes after input-scope exit. Originals remain private and unchanged; no S3 deletion or update is performed.

Worker heap limits do not cap all native/external buffers or provide an OS security sandbox. Input/output/page/item caps and concurrency constrain resource use, but production process/container quotas and decoder patching remain operational requirements. Termination and DB cleanup are bounded by their underlying runtime/statement behavior, not a hard real-time guarantee. See [Node 24 worker resource limits](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html).

## Known limitations

- PDF.js content-stream/bidi order is preserved; no geometric sorting, column reconstruction or table interpretation is attempted. Complex layouts, rotated text, malformed fonts or absent mappings may not yield human reading order. The extractor does not invent missing text to compensate.
- Text extraction is not a diagnosis, clinical validation or proof of source medical accuracy. The hash binds provenance to bytes, not to medical truth. Handwritten/scanned content without selectable text remains out of scope.
- Persistent page references lack exact text offsets because the existing result schema has no offset field. Internal page strings and deterministic newline separation preserve page grouping for this phase.
- Unsupported forms/attachments/actions fail rather than extracting their values or running them. Annotation content is not extracted; no JavaScript/viewer action is executed. This is not a malware-free guarantee.
- Automatic scheduling, OCR fallback, authorized reset/retry of OCR-required documents, aggregate storage quotas and production resource/SLA approval remain later decisions. This phase does not change the trusted-runtime boundary or existing attempt/history retention policies.

## Verification and files

Generated fixtures contain genuine text operators and Unicode ToUnicode maps, multipage text, and image XObjects. The end-to-end tests exercise mocked private S3 retrieval, existing integrity validation, isolated PDF text extraction, temporary-file cleanup, and actual lease-fenced PostgreSQL persistence under the restricted application role. No real patient document or live AWS operation is used.

`processing:test` now uses `--test-concurrency=1` for test-file isolation. The initial combined run showed that one suite's global temporary-directory cleanup assertion could observe another suite's legitimate in-flight input; serializing files fixes that interference without changing production concurrency or weakening any old test. An initial source-worker startup failure from a constructor parameter property was corrected to erasable TypeScript before the passing focused run.

| Command | Final outcome |
| --- | --- |
| Focused digital-PDF suite | 27 passed, 0 failed/skipped |
| `npm run processing:test` | 131 passed: 104 existing + 27 new cases; 0 failed/skipped |
| `npm run documents:test` | 44 passed, 0 failed/skipped |
| `npm run auth:test` | 29 passed, 0 failed/skipped |
| `npm run db:test` | 19 passed, 0 failed/skipped |
| `npm run db:security:test` | 15 passed, 0 failed/skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Compiled production smoke check | Passed: real synthetic PDF text, secure input validation, source/page provenance and atomic PostgreSQL persistence; fake storage only |

Final result: **238 tests passed, zero failed/skipped in the final suite runs**, including all previous 211 cases and 27 new digital-PDF tests. The compiled production smoke check also passed. The earlier startup/test-isolation issues described above were corrected before these passing runs.

The preservation audit confirmed that all preexisting data across 14 application tables and the exact relation inventory match the baseline. Synthetic fixtures were removed; the existing patient/document/job were not processed and no real extraction was created. All prior test files, three migrations, dependency versions/lockfile, existing worker/persistence/retrieval/upload/public-route code, actual secret files, AWS configuration and infrastructure match their baseline hashes. Only processing config, environment examples and the processing test command changed among preexisting files. A tracked/nonignored scan found none of the configured database/JWT/AWS credentials; runtime role flags remain restricted. No live AWS operation or OCR was performed.

Created `processing/pdf-text.ts`, `processing/pdf-text-worker.ts`, `processing/digital-pdf-processor.ts`, `processing/digital-pdf.test.ts`, `processing/fixtures/pdf-fixtures.ts`, and this document. Modified only processing `config.ts`, `.env.example`, and `package.json`'s processing test command among existing files. No existing test file, migration, dependency/lockfile, upload/integrity/retrieval/persistence/worker/public-route code, secret, AWS setting or infrastructure file was changed. No commit or push was made. Work stops at Phase 2.2C-B; OCR remains unimplemented.

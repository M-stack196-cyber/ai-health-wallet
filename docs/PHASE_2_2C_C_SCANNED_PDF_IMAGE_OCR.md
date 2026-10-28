# Phase 2.2C-C — Scanned PDF and image OCR

Implemented against the actual SRS v3.0 (FR-010–012, §14.1–14.3, V-05/V-06), prior document/lifecycle/retrieval/persistence/digital extraction documentation, existing sources/tests, and migrations 0001–0003. The existing extraction contract and lease-fenced transaction already support OCR and mixed methods; no migration is necessary.

## Files

Created:

- `backend/src/processing/ocr.ts`: document extraction orchestration, original fingerprint, mixed-page assembly, TSV parsing, bounded admission and cleanup.
- `backend/src/processing/ocr-process.ts`: allowlisted native commands, OS resource limits, bounded streams, cancellation and reaping.
- `backend/src/processing/ocr-image-worker.ts`: bounded image decoding, EXIF orientation and private grayscale normalization in a standalone Node worker.
- `backend/src/processing/ocr-processor.ts`: explicit opt-in processor for the existing worker.
- `backend/src/processing/fixtures/ocr-fixtures.ts`: generated synthetic text images and genuine raster/mixed PDFs.
- `backend/src/processing/ocr.test.ts`: genuine native OCR and integration tests.
- This document.

Modified: `backend/src/processing/config.ts`, `pdf-text.ts`, `pdf-text-worker.ts`, `retrieval.ts`, and `backend/.env.example`. Existing test files, dependencies/lockfile, migrations, worker/service/repository/persistence, upload validation, storage adapter, public routes and server startup are preserved.

## Architecture and explicit integration

`createOcrProcessor(ocrConfig, pdfConfig)` supplies an existing `DocumentProcessor`; it creates no scheduler, queue, endpoint or server startup side effect. Explicit future composition is:

```ts
const worker = createProcessingWorker(
  service, lifecycleConfig,
  createOcrProcessor(getOcrConfig(), getDigitalPdfConfig()),
  originalAccess,
);
// Invoking runOnce is an explicit caller decision; no automatic invocation was added.
```

The processor enters `withOriginal`, checks its live claim, extracts within that scope, checks the claim again and returns the result. After `withOriginal` has terminated extraction and removed temporary files, it calls `persistExtraction`. Existing service validation and the PostgreSQL transaction atomically persist evidence and complete the document/job. No database transaction spans decoding or subprocess execution. Stale, replaced or expired claims still cannot persist.

Retrieval retains its exact four-field frozen `OriginalInput` object. A private WeakMap exposes scope cancellation/cleanup capabilities to internal processors through `getOriginalScope`. OCR combines worker, scope, document and page cancellation signals. Retrieval aborts the scope and awaits registered extraction cleanup before removing the original, including during lease-monitor failure. Existing consumers that register no cleanup retain their prior cancellation behavior. Cleanup registration is for trusted, bounded processors, not arbitrary public callbacks.

## PDF, image and mixed handling

PDF.js first performs the existing strict embedded-text inspection. Catalog/page JavaScript, attachments and forms remain unsupported and are rejected before native rendering. The internal `ocr_required` outcome now retains each page's embedded text, page dimensions and the actual PDF.js version, as well as the hash and ordered textless-page numbers. The old digital-only processor still reports OCR-required for these documents.

For each textless page, in numerical order, Poppler `pdftoppm` renders exactly that page to one private grayscale PGM. Dimensions are calculated from the PDF.js rotated viewport, bounded DPI, maximum edge and pixel budget. Page dimensions must be finite, positive and at most 14,400 points on either axis. The renderer receives fixed flags and validated numeric arguments through `spawn`, with `shell:false`. It runs no viewer scripting or attachment action. Tesseract then receives that raster with `-l eng --oem 1 --psm 3 tsv`. There is no second OCR pass over digital pages.

PNG/JPG/JPEG originals are already fully validated by retrieval. A standalone, empty-environment Node worker also verifies a regular, non-symlink file and expected size/signature/format, rejects multipage or oversized images, applies source EXIF orientation, bounds dimensions, and generates a private grayscale PNG. Sharp uses one native thread, no cache and a three-second processing timeout. It never changes the original. Tesseract recognizes that normalized image using the English model.

Recognized level-5 TSV words are preserved in returned order, with spaces within a line and newlines between line identifiers. Page strings are joined with two newlines, preserving page order without inventing headings, missing words or clinical statements. A page without recognized letters/numbers fails the entire document, including a blank page in an otherwise readable mixed PDF. No partial successful result or placeholder evidence is persisted.

Actual binaries verified locally: `/usr/bin/tesseract` 5.3.4 (`eng`, `osd`), `/usr/bin/pdftoppm` and `pdfinfo` 24.02.0, and `/usr/bin/prlimit`. Only `pdftoppm` is needed for rendering; page count comes from PDF.js, so `pdfinfo` is not invoked. Runtime version probes record the actual Tesseract/Poppler versions; PDF.js provides its exported version. Native tools are system prerequisites, with no new npm dependency. See [Tesseract CLI/TSV documentation](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) and [Poppler utility source](https://gitlab.freedesktop.org/poppler/poppler/-/blob/master/utils/pdftoppm.cc).

## Provenance and confidence

Every result uses the existing `ExtractionResult` and `validateExtraction`. SHA-256 is calculated from the actual regular original file with bounded reads and exact receipt-size checks. PDF inspection independently hashes its input; the hashes must agree. Actual page count and sequential page methods describe the source, not the normalized raster. Pure digital documents retain the original PDF.js `pdf_text` result. All-OCR documents use `ocr`; documents with both methods use `mixed`. Extractor name/version identify every participating tool. OCR pages alone carry confidence.

Page confidence is the arithmetic mean of finite Tesseract word-level scores in [0,100] for nonempty recognized words. Structural rows and negative, missing or invalid scores do not enter the mean; no eligible scores means the property is omitted. Confidence is a recognition-engine score, **not medical accuracy, a diagnosis, or verification that a value/dosage is correct**. No medical threshold, correction, translation or interpretation is applied.

## Bounds, isolation and cleanup

| Environment setting | Default | Allowed environment range |
| --- | --- | --- |
| `OCR_MAX_PAGES` | 50 | 1–200 |
| `OCR_MAX_FILE_BYTES` | 5242880 | 1024–20971520 |
| `OCR_MAX_CHARACTERS` | 1000000 | 1–1000000 |
| `OCR_MAX_CONCURRENCY` | 1 | 1–2 |
| `OCR_DPI` | 200 | 72–300 |
| `OCR_MAX_EDGE` | 3000 | 256–4000 |
| `OCR_MAX_PIXELS` | 9000000 | 65536–16000000 |
| `OCR_MAX_TEMP_BYTES` | 16777216 | 1024–33554432 |
| `OCR_PAGE_TIMEOUT_MS` | 20000 | 100–60000 |
| `OCR_DOCUMENT_TIMEOUT_MS` | 120000 | 1000–240000 |
| `OCR_CPU_SECONDS` | 15 | 1–30 |
| `OCR_MEMORY_BYTES` | 536870912 | 67108864–1073741824 |
| `OCR_MAX_OUTPUT_BYTES` | 4194304 | 1024–8388608 |

Programmatic configurations also enforce hard ceilings; lower positive timeout/output/file values are permitted for deterministic exhaustion tests. Existing PDF, retrieval, upload, worker-attempt and extraction-contract limits apply independently, taking the stricter applicable limit. The extraction contract additionally caps UTF-8 text at 4 MiB and metadata at 8 KiB. Limits reject rather than silently truncate output.

Admission is module-wide within one Node process; two documents at most can be admitted even when configured programmatically. Each admitted document has at most one native child at a time: version probe, renderer or OCR. There are no parallel page subprocesses. `prlimit` applies hard and soft address-space, CPU-time and file-size limits, 64 open descriptors and zero core-file size. Native commands use fixed absolute executable paths, argument arrays, ignored stdin, one OpenMP thread and a minimal environment without AWS/database/JWT credentials. Tool diagnostics are drained without logging; stderr has a 64 KiB cap and stdout has the configured cap.

Wall timeout, stream overflow or cancellation sends SIGKILL to the detached child process group and waits for `close` before returning. This deliberately prioritizes immediate bounded termination over graceful native shutdown. OS resource termination also rejects the extraction. Image/parser workers are terminated and awaited. Timers/listeners and admission slots are released in `finally`.

Random OCR directories use mode 0700; normalized images use 0600. Poppler output is confined to that private directory and chmodded 0600 before OCR. One raster exists at a time and is removed after its page. Poppler's per-file OS limit, single-file fixed output and raster bounds constrain disk use; the OCR directory is recursively removed on success, failure, cancellation and timeout. The original has its separate existing retrieval byte limit and lifecycle. No filename, patient ID, bucket/key, credential, medical output or native diagnostic is logged or placed in a temporary directory name.

## Verification

Synthetic fixtures have actual printed words rendered into raster images, JPEG image XObjects inside structurally valid PDFs, and genuine embedded PDF text for mixed cases. Tests run installed native binaries; OCR output is not mocked. Storage uses synthetic local/fake adapters; integration uses fresh patient-scoped records and the restricted application role. Existing uploaded originals and live AWS are not accessed.

Coverage includes scanned single/multipage PDFs; mixed-page preservation and order; PNG/JPG/JPEG and EXIF rotation; hashes/actual tools/provenance/confidence; blank/unreadable pages; malformed/active PDFs and malformed/mismatched images; symlink/size/path-injection defenses; page/pixel/file/text/temp/output/memory budgets; document/page timeouts; admission; real Tesseract cancellation and OS-limit inspection; child reaping; cleanup before persistence; actual worker cancellation/lease loss during native OCR; stale/expired claim rejection; preserved original metadata and old retrieval shape.

| Command | Final result |
| --- | --- |
| `npm run processing:test` | 162 passed: all 131 existing + 31 new; 0 failed/skipped |
| `npm run documents:test` | 44 passed; 0 failed/skipped |
| `npm run auth:test` | 29 passed; 0 failed/skipped |
| `npm run db:test` | 19 passed; 0 failed/skipped |
| `npm run db:security:test` | 15 passed; 0 failed/skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Compiled production mixed-PDF and PNG OCR smoke checks | Both passed through actual native extraction, validated retrieval, cleanup and atomic persistence |

Total: **269 tests passed, zero failed or skipped**, preserving all 238 existing tests. The compiled checks additionally verified the emitted PDF parser and image normalization workers, actual native commands, source hash, mixed/OCR methods and database completion, followed by removal of their synthetic fixtures.

## Limitations and remaining risks

- Recognition is English printed-text OCR. Handwriting, low contrast, unusual layouts, tables, tiny text and arbitrary rotations can yield incorrect text or fail. Source EXIF orientation and PDF rotation are supported; no guessed OSD rotation or brute-force rotation is applied. The installed OSD model is not invoked. Blank pages conservatively fail the document. Synthetic acceptance tests do not measure clinical accuracy.
- Native processes have OS address-space/CPU/file limits, but this is not a container, network/filesystem security sandbox or protection against a decoder exploit. They retain the operating-system user's file access. Sharp/PDF.js workers have V8 heap and input/pixel/time budgets; their native allocations are not covered by the native CLI's `prlimit`. Process/container quotas, private encrypted temporary storage, decoder patching and deployment isolation remain operational decisions.
- Limits are per Node process, not distributed quotas. Original storage and each admitted OCR raster are separate bounded allocations. Crashes, power loss, kernel stalls or filesystem removal failures can leave temporary files; no sweeper, deployment or production SLA was introduced. Query latency remains subject to the existing bounded database configuration.
- A mixed page containing usable embedded text plus additional scanned regions keeps embedded text only. This phase identifies whole textless pages, not regions. Page boundaries use the existing newline representation and ordered provenance, with no new page-offset metadata.
- Empty or unsupported inputs fail rather than becoming completed. Transient cancellation/timeouts/admission/tool failures use existing bounded retry behavior; no reset of failed/exhausted jobs or automatic processing of previous records was added.
- No migration, IAM/S3 permission change, credential/configuration change, external OCR API, AI phase, clinical logic, frontend, notification, sharing or deployment is included. Work stops at Phase 2.2C-C.

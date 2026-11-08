# Patient app indexing gap: record questions (RAG) need an indexing step that nothing triggers

Date: 2026-11-08. Scope: local stack, synthetic data only. Status: finding and recommendations; nothing here is approved by a supervisor, legal, privacy or security reviewer.

## Observation

Record questions (RAG) only work after a document has been indexed. Indexing is a patient-triggered API call:

`POST /documents/:id/rag-index`

Nothing in the current product makes that call.

- Across `frontend/apps` and `frontend/packages` there are 0 references to it (checked 2026-11-08).
- The processing worker (OCR and text extraction) does not index.
- Only the R9 end-to-end test and the local demo script `local-stack/demo-share.sh` call it.

## Impact

- For a real patient, every question returns "The available health records do not contain enough information to answer this question." That is the same message as a genuine lack of evidence, so the user cannot tell "not indexed yet" from "not in my records".
- The doctor portal is affected in the same way, because documents granted in a share must also be indexed.

## Evidence (local stack, 2026-11-08)

- With 18 documents fully processed, the vector index held 0 chunks and 0 embeddings, and questions returned status `insufficient`.
- After calling `POST /documents/:id/rag-index` with the patient's own session, the same kind of question returned status `answered` with a citation (for example "Source-reported Glucose: 90 mg/dL. [C1]").
- `local-stack/demo-share.sh` now makes that call after processing completes and before the share is created. One run stored one new chunk and one new embedding (chunk count 5 to 6).
- Through a doctor session on the resulting share, a glucose question was answered with a citation, and an out-of-scope question (blood pressure and cholesterol) returned `insufficient` with 0 citations and no invented values.

## Recommendations

1. **Backend-owned indexing job (preferred).**
   - Run it automatically after extraction completes.
   - Make it work like the processing jobs: leased, idempotent, and re-run when the source text changes (the schema already stores a source fingerprint).
   - It must first check that the account is active, not pending deletion, and not under a legal hold.
   - It should write an audit event.
2. **Alternative: a patient app step.** A "Prepare for questions" action that calls the route and shows progress. This adds user effort and keeps the patient's explicit action.
3. **Expose index status per document** (not indexed, indexed, out of date), so the app can say "not ready yet" instead of "insufficient evidence".
4. **Doctor shares.** Index granted documents before, or when, the share is created.
5. **Tests.** Add an integration test that proves upload, processing, indexing and answer through the public API, with no manual step.

## Decision points for the supervisor

- Whether automatic creation of derived data (chunks and embeddings) needs explicit patient consent.
- The embedding model and index choice. Both are open configuration items: CFG-01 (AI model and data handling) and CFG-02 (embedding and index benchmark) are not approved.
- The embeddings used locally are synthetic hashes, so retrieval quality is untested.

## Related limit of the synthetic stand-in (not part of the gap)

The synthetic-offline answerer only reports structured lab values (Glucose and Hemoglobin lines with a value). A question without such a topic, for example "When was the lab report performed?", returns `insufficient` even when the indexed text contains the date. This is a limit of the stand-in, not an indexing fault. A real model (CFG-01) would be needed for date and free-text questions. In the test data the upload form date (2026-02-03) also differs from the date in the report text (2026-01-15), which any real answerer would have to handle.

## Requirement rows affected

No status changes are proposed here. Rows taken from the delivery tracker:

- **M11-007**: mobile app RAG Q&A with source citations and insufficiency messaging (FR-017; FR-045).
- **M12-008**: doctor RAG Q&A with citations and current-grant authorization (FR-019; FR-045).

## What was not tested

- Multi-document retrieval.
- Hemoglobin questions through the doctor path.
- Any real embedding model or language model.
- The portal and app screens in a browser (the API path is proven, not the screens).

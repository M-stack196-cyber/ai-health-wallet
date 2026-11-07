// LOCAL DEMO WORKER ONLY. Not the production/canary worker and not a processing rollout approval.
// The production worker (processing/background-entry.ts) is bound to the real AWS profile, account and bucket and stays untouched and disabled.
// This loop composes the same worker pieces the R9 test composes (processing worker + Python OCR service, summary executor, security-email drain)
// against local file storage and a local database. It refuses to run outside the generated local environment.
import pg from "pg";
import { assertLocalStack } from "./guard.js";
import "../config/env.js";
import { getDatabaseConfig } from "../config/env.js";
import { getDocumentConfig } from "../config/documents.js";
import { getProcessingConfig, getRetrievalConfig } from "../processing/config.js";
import { createLocalStorage } from "../documents/local-storage.js";
import { createProcessingRepository } from "../processing/repository.js";
import { createProcessingService } from "../processing/service.js";
import { createProcessingWorker } from "../processing/worker.js";
import { createOriginalAccess } from "../processing/retrieval.js";
import { createPythonOcrProcessor } from "../processing/python-processor.js";
import { createOfflineSummaryRuntime } from "../summaries/offline-runtime.js";
import { configuredSecurityEmail } from "../auth/security-email.js";

assertLocalStack(process.env);
const documents = getDocumentConfig();
if (!documents.localStorage) throw new Error("Local file storage is required for the local worker.");
const storage = createLocalStorage(documents.localStorage);
const pool = new pg.Pool({ ...getDatabaseConfig(), max: 4, connectionTimeoutMillis: 3000 });
const lifecycle = getProcessingConfig();
const service = createProcessingService(createProcessingRepository(pool, lifecycle));
const originals = createOriginalAccess(service, { bucket: storage.bucket, prefix: storage.prefix, readOriginal: storage.readOriginal },
  documents, getRetrievalConfig());
const worker = createProcessingWorker(service, lifecycle, createPythonOcrProcessor(), originals);
const mail = configuredSecurityEmail(pool);

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
const event = (name: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ service: "local-demo-worker", event: name, ...extra }));
event("started", { note: "local demo worker; not a processing rollout approval" });

async function summaries(): Promise<void> {
  const patients = (await pool.query<{ patient_id: string }>(
    "SELECT DISTINCT patient_id FROM public.medical_summary_jobs WHERE state IN ('pending','retry_wait')")).rows;
  for (const { patient_id } of patients) {
    const runtime = createOfflineSummaryRuntime(pool as never, patient_id, process.env);
    for (let i = 0; i < 5; i++) { if ((await runtime.executor.runOnce()) !== "completed") break; event("summary-completed"); }
  }
}
while (!stop.signal.aborted) {
  try {
    if (mail) await mail.drain(10);
    for (let i = 0; i < 5; i++) { const result = await worker.runOnce(stop.signal); if (result === "idle" || result === "unavailable" || result === "disabled") break; event("document-" + result); }
    await summaries();
  } catch { event("loop-error"); }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
await pool.end();
event("stopped");

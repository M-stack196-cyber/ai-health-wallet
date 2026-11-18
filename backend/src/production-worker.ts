import pg from "pg";
import "./config/env.js";
import { getDatabaseConfig } from "./config/env.js";
import { getDocumentConfig } from "./config/documents.js";
import { getProcessingConfig, getRetrievalConfig } from "./processing/config.js";
import { createS3Storage } from "./documents/storage.js";
import { createProcessingRepository } from "./processing/repository.js";
import { createProcessingService } from "./processing/service.js";
import { createProcessingWorker } from "./processing/worker.js";
import { createOriginalAccess } from "./processing/retrieval.js";
import { createPythonOcrProcessor } from "./processing/python-processor.js";
import { createOfflineSummaryRuntime } from "./summaries/offline-runtime.js";
import { configuredSecurityEmail } from "./auth/security-email.js";

const documents = getDocumentConfig();
if (!documents.storage) throw new Error("S3 document storage configuration is required for production worker.");
const storage = createS3Storage(documents.storage);
const pool = new pg.Pool({ ...getDatabaseConfig(), max: 4, connectionTimeoutMillis: 3000 });
const lifecycle = getProcessingConfig();
const service = createProcessingService(createProcessingRepository(pool, lifecycle));
const originals = createOriginalAccess(
  service,
  { bucket: storage.bucket, prefix: storage.prefix, readOriginal: storage.readOriginal },
  documents,
  getRetrievalConfig(),
);
const worker = createProcessingWorker(service, lifecycle, createPythonOcrProcessor(), originals);
const mail = configuredSecurityEmail(pool);

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
const event = (name: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ service: "hw-prod-worker", event: name, ...extra }));
event("started", { bucket: storage.bucket, region: documents.storage.region });

async function summaries(): Promise<void> {
  const patients = (
    await pool.query<{ patient_id: string }>(
      "SELECT DISTINCT patient_id FROM public.medical_summary_jobs WHERE state IN ('pending','retry_wait')",
    )
  ).rows;
  for (const { patient_id } of patients) {
    const runtime = createOfflineSummaryRuntime(pool as never, patient_id, process.env);
    for (let i = 0; i < 5; i++) {
      if ((await runtime.executor.runOnce()) !== "completed") break;
      event("summary-completed", { patient_id });
    }
  }
}

while (!stop.signal.aborted) {
  try {
    if (mail) await mail.drain(10);
    for (let i = 0; i < 5; i++) {
      const result = await worker.runOnce(stop.signal);
      if (result === "idle" || result === "unavailable" || result === "disabled") break;
      event("document-" + result);
    }
    await summaries();
  } catch (err) {
    event("loop-error", { message: err instanceof Error ? err.message : "unknown" });
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

await pool.end();
event("stopped");

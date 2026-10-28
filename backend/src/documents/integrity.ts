import { Worker } from "node:worker_threads";
import type { DocumentConfig } from "../config/documents.js";
import type { ParsedDocument } from "./multipart.js";
import { ApiError } from "../http/errors.js";

export async function verifyIntegrity(upload: Pick<ParsedDocument, "path" | "type">, config: DocumentConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ApiError(400, "UPLOAD_INTERRUPTED", "Document upload was interrupted.");
  const url = new URL(import.meta.url.endsWith(".ts") ? "./validation-worker.ts" : "./validation-worker.js", import.meta.url);
  // Node 24 strips this standalone worker's TypeScript in development. Avoid
  // inheriting tsx/test instrumentation: transforming the PDF bundle defeats
  // the bounded worker heap. Compiled production uses the emitted .js module.
  const worker = new Worker(url, { execArgv: [], workerData: { path: upload.path, type: upload.type,
    maxImagePixels: config.maxImagePixels, maxPdfPages: config.maxPdfPages },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    stdout: true, stderr: true });
  // Validator diagnostics are never request/file-content logs.
  worker.stdout.resume(); worker.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const valid = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), config.validationTimeoutMs);
      abort = () => resolve(false);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", value => resolve(value === true));
      worker.once("error", () => resolve(false));
      worker.once("exit", () => resolve(false));
    });
    if (!valid || signal.aborted) throw new ApiError(422, "INVALID_DOCUMENT_CONTENT", "Document content is malformed, unsupported or exceeds validation limits.");
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

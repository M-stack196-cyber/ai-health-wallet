import { Worker } from "node:worker_threads";
import type { DocumentConfig } from "../config/documents.js";
import type { ParsedDocument } from "./multipart.js";
import { ApiError } from "../http/errors.js";

function debugCause(cause: string): void {
  console.warn(`document-validation-failed cause=${cause}`);
}

export async function verifyIntegrity(upload: Pick<ParsedDocument, "path" | "type">, config: DocumentConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ApiError(400, "UPLOAD_INTERRUPTED", "Document upload was interrupted.");
  const url = new URL(import.meta.url.endsWith(".ts") ? "./validation-worker.ts" : "./validation-worker.js", import.meta.url);
  const worker = new Worker(url, {
    execArgv: [],
    workerData: {
      path: upload.path,
      type: upload.type,
      maxImagePixels: config.maxImagePixels,
      maxPdfPages: config.maxPdfPages,
    },
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line.startsWith("[validation-worker]")) console.warn(line);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    let cause = "worker_rejected";
    let settled = false;
    const fail = (why: string, resolve: (v: boolean) => void) => {
      if (!settled) { settled = true; cause = why; }
      resolve(false);
    };
    const timeoutMs = Math.max(config.validationTimeoutMs, 15000);
    const valid = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => fail("timeout", resolve), timeoutMs);
      abort = () => fail("aborted", resolve);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (value) => { settled = true; resolve(value === true); });
      worker.once("error", (err) => { console.warn("[validation-worker-error]", err instanceof Error ? err.message : String(err)); fail("worker_error", resolve); });
      worker.once("exit", (code) => fail(`worker_exit_${code}`, resolve));
    });
    if (!valid || signal.aborted) {
      debugCause(cause);
      throw new ApiError(422, "INVALID_DOCUMENT_CONTENT", "Document content is malformed, unsupported or exceeds validation limits.");
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

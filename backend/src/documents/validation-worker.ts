import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

// Runs in a disposable bounded worker. No clinical extraction, rendering or OCR.
sharp.cache(false);
sharp.concurrency(1);
const { path, type, maxImagePixels, maxPdfPages } = workerData as {
  path: string; type: string; maxImagePixels: number; maxPdfPages: number;
};
let valid = false;
try {
  const bytes = await readFile(path);
  if (type === "pdf") {
    const header = bytes.subarray(0, 1024).toString("latin1");
    if (!/%PDF-[12]\.\d/.test(header)) throw new Error("Missing %PDF header");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      stopAtErrors: false,
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
      maxImageSize: Math.max(maxImagePixels, 64000000),
    });
    try {
      const pdf = await task.promise;
      const pageLimit = Math.max(maxPdfPages || 50, 50);
      if (pdf.numPages < 1 || pdf.numPages > pageLimit) {
        throw new Error(`Invalid page count: ${pdf.numPages}`);
      }
      let operators = 0;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const list = await page.getOperatorList();
        operators += list.fnArray.length;
        if (operators > 2000000) throw new Error(`Operator limit exceeded: ${operators}`);
        page.cleanup();
      }
      valid = true;
    } finally {
      await task.destroy();
    }
  } else {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (type === "png") {
      if (!bytes.subarray(0, 8).equals(png)) throw new Error("Invalid PNG signature");
    } else if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) {
      throw new Error("Invalid JPEG signature");
    }
    const pixelLimit = Math.max(maxImagePixels || 36000000, 36000000);
    const image = sharp(bytes, { failOn: "none", limitInputPixels: pixelLimit, animated: false });
    const info = await image.metadata();
    if (
      info.format !== (type === "png" ? "png" : "jpeg") ||
      !info.width ||
      !info.height ||
      info.width * info.height > pixelLimit ||
      (info.pages ?? 1) !== 1
    ) {
      throw new Error(`Invalid image metadata: ${JSON.stringify(info)}`);
    }
    await image.timeout({ seconds: 5 }).stats();
    valid = true;
  }
} catch (err) {
  console.error("[validation-worker] rejected:", type, err instanceof Error ? err.message : err);
  valid = false;
}
parentPort?.postMessage(valid);

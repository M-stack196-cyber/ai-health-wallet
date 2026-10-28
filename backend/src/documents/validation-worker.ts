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
    if (!/^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString("ascii"))
        || !/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1"))) throw new Error();
    const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(bytes.subarray(-1024).toString("latin1"));
    const offset = start ? Number(start[1]) : -1;
    if (!Number.isSafeInteger(offset) || offset < 8 || offset >= bytes.length) throw new Error();
    const xref = bytes.subarray(offset, offset + 1024).toString("latin1");
    if (!xref.startsWith("xref") && !(/^\d+\s+\d+\s+obj\b/.test(xref) && /\/Type\s*\/XRef\b/.test(xref.split("stream")[0]))) throw new Error();
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
      useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false, enableXfa: false,
      maxImageSize: maxImagePixels });
    try {
      const pdf = await task.promise;
      if (pdf.numPages < 1 || pdf.numPages > maxPdfPages || (await pdf.getJSActions())?.size || (await pdf.getAttachments())?.size) throw new Error();
      let operators = 0;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        if ((await page.getJSActions())?.size) throw new Error();
        const list = await page.getOperatorList();
        operators += list.fnArray.length;
        if (operators > 200000) throw new Error();
        page.cleanup();
      }
      valid = true;
    } finally { await task.destroy(); }
  } else {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (type === "png") {
      if (!bytes.subarray(0, 8).equals(png) || !bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) throw new Error();
    } else if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error();
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: maxImagePixels, animated: false });
    const info = await image.metadata();
    if (info.format !== (type === "png" ? "png" : "jpeg") || !info.width || !info.height
        || info.width * info.height > maxImagePixels || (info.pages ?? 1) !== 1) throw new Error();
    await image.timeout({ seconds: 3 }).stats(); // Full decode, not just header inspection.
    valid = true;
  }
} catch { valid = false; }
parentPort?.postMessage(valid);

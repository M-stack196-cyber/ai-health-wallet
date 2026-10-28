import busboy from "busboy";
import type { Request } from "express";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { DocumentConfig } from "../config/documents.js";
import { ApiError } from "../http/errors.js";
import { filename, metadata, type DocumentMetadata, type FileType } from "./validation.js";

export interface ParsedDocument {
  path: string; name: string; type: FileType; mime: string; bytes: number;
  checksum: string; metadata: DocumentMetadata; dispose(): Promise<void>;
}
export async function parseUpload(req: Request, config: DocumentConfig, signal: AbortSignal): Promise<ParsedDocument> {
  if (!req.is("multipart/form-data")) throw new ApiError(415, "MULTIPART_REQUIRED", "A multipart document upload is required.");
  if (Number(req.get("Content-Length")) > config.maxFileBytes + 16384) throw new ApiError(413, "DOCUMENT_TOO_LARGE", "Document upload is too large.");
  const directory = await mkdtemp(join(tmpdir(), "health-wallet-upload-"));
  await chmod(directory, 0o700);
  const path = join(directory, "original.bin");
  let parser: ReturnType<typeof busboy> | undefined;
  let writing: Promise<void> | undefined;
  const dispose = () => rm(directory, { recursive: true, force: true });
  let name = "";
  let type: FileType = "pdf";
  let mime = "";
  let bytes = 0;
  let totalBytes = 0;
  const hash = createHash("sha256");
  const fields: Record<string, string> = {};
  let aborted: (() => void) | undefined;
  let onData: ((chunk: Buffer) => void) | undefined;
  let onRequestError: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const fail = (error: ApiError) => {
        if (failed) return;
        failed = true;
        req.unpipe(parser);
        // Defer destruction until busboy finishes the current callback; destroying
        // it synchronously inside a file-size event can invalidate parser state.
        queueMicrotask(() => parser?.destroy());
        req.resume();
        reject(error);
      };
      const bad = () => fail(new ApiError(400, "INVALID_MULTIPART", "Document upload is malformed or incomplete."));
      try {
        parser = busboy({ headers: req.headers, defParamCharset: "utf8", preservePath: true,
          limits: { files: 1, fields: 3, parts: 5, fileSize: config.maxFileBytes + 1,
            fieldSize: 1024, fieldNameSize: 40, headerPairs: 100 } });
      } catch { bad(); return; }
      aborted = bad;
      onRequestError = bad;
      onData = chunk => {
        totalBytes += chunk.length;
        if (totalBytes > config.maxFileBytes + 16384) fail(new ApiError(413, "DOCUMENT_TOO_LARGE", "Document upload is too large."));
      };
      req.on("data", onData);
      req.on("error", onRequestError);
      req.once("aborted", aborted);
      signal.addEventListener("abort", aborted, { once: true });
      parser.on("field", (field, value, info) => {
        if (failed) return;
        if (!["category", "hospital_name", "document_date"].includes(field) || Object.hasOwn(fields, field) || info.nameTruncated || info.valueTruncated) { bad(); return; }
        fields[field] = value;
      });
      parser.on("file", (field, file, info) => {
        if (failed) { file.resume(); return; }
        if (field !== "file" || writing) { file.resume(); bad(); return; }
        try {
          const parsed = filename(info.filename ?? "");
          name = parsed.name; type = parsed.type; mime = parsed.mime;
          if (info.mimeType.toLowerCase() !== mime) throw new ApiError(415, "MIME_MISMATCH", "Document format and content type must match.");
        } catch (error) {
          file.resume();
          fail(error instanceof ApiError ? error : new ApiError(400, "INVALID_MULTIPART", "Document upload is malformed or incomplete."));
          return;
        }
        file.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > config.maxFileBytes) fail(new ApiError(413, "DOCUMENT_TOO_LARGE", "Document upload is too large."));
          hash.update(chunk);
        });
        file.once("limit", () => fail(new ApiError(413, "DOCUMENT_TOO_LARGE", "Document upload is too large.")));
        writing = pipeline(file, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        void writing.catch(bad);
      });
      parser.once("filesLimit", bad).once("fieldsLimit", bad).once("partsLimit", bad).once("error", bad);
      parser.once("close", () => { if (!failed) resolve(); });
      if (signal.aborted || req.aborted) { bad(); return; }
      req.pipe(parser);
    });
    await writing;
    if (!name || !bytes || !writing) throw new ApiError(400, "DOCUMENT_REQUIRED", "One nonempty medical document is required.");
    return { path, name, type, mime, bytes, checksum: hash.digest("base64"),
      metadata: metadata(fields) as DocumentMetadata, dispose };
  } catch (error) {
    parser?.destroy();
    if (writing) await writing.catch(() => undefined);
    await dispose();
    throw error;
  } finally {
    if (aborted) { req.off("aborted", aborted); signal.removeEventListener("abort", aborted); }
    if (onData) req.off("data", onData);
    if (onRequestError) req.off("error", onRequestError);
  }
}

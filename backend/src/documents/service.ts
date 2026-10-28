import { randomUUID } from "node:crypto";
import { ApiError } from "../http/errors.js";
import type { ParsedDocument } from "./multipart.js";
import { createDocumentRepository, publicDocument, type DocumentRow } from "./repository.js";
import { StorageFailure, validStorageReference, type DocumentStorage, type StoredObject } from "./storage.js";

export const notFound = () => new ApiError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
export const storageUnavailable = () => new ApiError(503, "DOCUMENT_STORAGE_UNAVAILABLE", "Document storage is temporarily unavailable.");
export function createDocumentService(repository: ReturnType<typeof createDocumentRepository>, storage: DocumentStorage | null) {
  async function cleanup(key: string, receipt?: StoredObject): Promise<void> {
    if (!storage) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await storage.remove(key, receipt); return; }
      catch { /* Each adapter request has its own deadline, independent of client abort. */ }
    }
    // No keys, patient IDs, metadata or underlying errors are logged.
    console.error("A new unlinked private upload requires storage reconciliation.");
  }
  return {
    async upload(upload: ParsedDocument, patientId: string, signal: AbortSignal): Promise<DocumentRow> {
      if (!storage) throw storageUnavailable();
      const id = randomUUID();
      const key = storage.prefix + randomUUID() + "." + upload.type;
      if (!validStorageReference(storage, storage.bucket, key)) throw storageUnavailable();
      let receipt: StoredObject;
      try {
        receipt = await storage.put({ key, path: upload.path, bytes: upload.bytes, mime: upload.mime, checksum: upload.checksum, signal });
      } catch (error) {
        if (!(error instanceof StorageFailure) || error.mayHaveWritten) await cleanup(key);
        throw storageUnavailable();
      }
      if (signal.aborted) {
        await cleanup(key, receipt);
        throw new ApiError(400, "UPLOAD_INTERRUPTED", "Document upload was interrupted.");
      }
      try {
        return await repository.insert({ ...upload.metadata, id, patientId, bucket: storage.bucket,
          key, name: upload.name, type: upload.type, mime: upload.mime, bytes: upload.bytes, checksum: upload.checksum });
      } catch {
        // A connection may fail after an autocommit INSERT committed. Never
        // delete an original on an ambiguous database result without read-back.
        let persisted;
        try { persisted = await repository.reference(id, patientId); }
        catch {
          console.error("A private upload has an uncertain database outcome and requires reconciliation.");
          throw storageUnavailable();
        }
        if (persisted?.s3_bucket === storage.bucket && persisted.s3_object_key === key) return publicDocument(persisted);
        await cleanup(key, receipt);
        throw new ApiError(503, "DOCUMENT_UPLOAD_FAILED", "Document upload could not be completed. Try again later.");
      }
    },
  };
}

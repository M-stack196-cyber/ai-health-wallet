import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { AuthenticationConfig } from "../config/auth.js";
import type { DocumentConfig } from "../config/documents.js";
import type { PatientDatabase } from "../patients/repository.js";
import { createTokenService } from "../auth/tokens.js";
import { requirePatient, patientIdentity, requireJson, rejectQueryParameters, rejectRequestBody } from "../auth/middleware.js";
import { ApiError } from "../http/errors.js";
import type { DocumentStorage } from "./storage.js";
import { createDocumentRepository, publicDocument } from "./repository.js";
import { createDocumentService, notFound, storageUnavailable } from "./service.js";
import { documentId, filters, metadata, type MetadataPatch } from "./validation.js";
import { parseUpload, type ParsedDocument } from "./multipart.js";
import { createPatientFileAccess } from "./file-access.js";
import { verifyIntegrity } from "./integrity.js";

export function createDocumentRoutes(database: PatientDatabase, auth: AuthenticationConfig, config: DocumentConfig, storage: DocumentStorage | null) {
  const router = Router();
  const repository = createDocumentRepository(database);
  const service = createDocumentService(repository, storage);
  const deliverFile = createPatientFileAccess(repository, storage, config);
  let activeUploads = 0;
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); }, requirePatient(createTokenService(auth)));
  const limiter = rateLimit({ windowMs: 900000, limit: config.uploadRateLimitMax,
    legacyHeaders: false, standardHeaders: "draft-8", validate: { xForwardedForHeader: false },
    message: { success: false, error: { code: "UPLOAD_RATE_LIMITED", message: "Too many upload attempts. Try again later." } } });
  router.post("/", rejectQueryParameters, limiter, async (req, res) => {
    if (!storage) { req.resume(); res.set("Connection", "close"); throw storageUnavailable(); }
    if (activeUploads >= config.maxConcurrentUploads) {
      req.resume(); res.set("Connection", "close").set("Retry-After", "5");
      throw new ApiError(503, "UPLOAD_BUSY", "Document uploads are temporarily busy. Try again later.");
    }
    activeUploads++;
    const controller = new AbortController();
    const closed = () => { if (!res.writableFinished) controller.abort(); };
    const aborted = () => controller.abort();
    req.once("aborted", aborted);
    res.once("close", closed);
    const deadline = setTimeout(aborted, config.uploadTimeoutMs);
    let upload: ParsedDocument | undefined;
    try {
      upload = await parseUpload(req, config, controller.signal);
      await verifyIntegrity(upload, config, controller.signal);
      const row = await service.upload(upload, patientIdentity(req), controller.signal);
      if (!res.destroyed) res.status(201).json({ success: true, document: publicDocument(row) });
    } catch (error) {
      if (!req.readableEnded) { req.resume(); res.set("Connection", "close"); }
      throw error;
    } finally {
      clearTimeout(deadline);
      req.off("aborted", aborted); res.off("close", closed);
      try { await upload?.dispose(); }
      finally { activeUploads--; }
    }
  });
  router.get("/", rejectRequestBody, async (req, res) => {
    const options = filters(req.query);
    const result = await repository.list(patientIdentity(req), options);
    res.status(200).json({ success: true, documents: result.documents.map(publicDocument),
      pagination: { limit: options.limit, offset: options.offset, has_more: result.hasMore } });
  });
  const fileLimiter = rateLimit({windowMs:900000, limit:config.uploadRateLimitMax,
    keyGenerator:req=>patientIdentity(req), legacyHeaders:false, standardHeaders:"draft-8",
    message:{success:false,error:{code:"DOWNLOAD_RATE_LIMITED",message:"Too many download attempts. Try again later."}}});
  router.get("/:id/download", rejectQueryParameters, rejectRequestBody, fileLimiter, async (req, res) => {
    await deliverFile(documentId(req.params.id), patientIdentity(req), req, res);
  });
  router.get("/:id", rejectQueryParameters, rejectRequestBody, async (req, res) => {
    const row = await repository.reference(documentId(req.params.id), patientIdentity(req));
    if (!row) throw notFound();
    res.status(200).json({ success: true, document: publicDocument(row) });
  });
  router.patch("/:id", rejectQueryParameters, requireJson, async (req, res) => {
    const id = documentId(req.params.id);
    const changes = metadata(req.body, true) as MetadataPatch;
    const row = await repository.update(id, patientIdentity(req), changes);
    if (!row) throw notFound();
    res.status(200).json({ success: true, document: publicDocument(row) });
  });
  return router;
}

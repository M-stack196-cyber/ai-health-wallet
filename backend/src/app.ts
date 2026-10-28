import express from "express";
import cors from "cors";
import helmet from "helmet";
import { checkDatabaseConnection, pool } from "./database/pool.js";
import { getAuthenticationConfig, type AuthenticationConfig } from "./config/auth.js";
import { createPatientRoutes } from "./auth/routes.js";
import { ApiError, errorHandler } from "./http/errors.js";
import type { PatientDatabase } from "./patients/repository.js";
import { getDocumentConfig, type DocumentConfig } from "./config/documents.js";
import { createDocumentRoutes } from "./documents/routes.js";
import { createS3Storage, type DocumentStorage } from "./documents/storage.js";

import {createProcessingRoutes,type ProcessingApiOptions} from "./processing/api.js";
import { createSummaryRoutes, type SummaryApiOptions } from "./summaries/routes.js";

export function createApp(options: { auth?: AuthenticationConfig; database?: PatientDatabase;
  documentConfig?: DocumentConfig; documentStorage?: DocumentStorage | null; documentDatabase?: PatientDatabase; summaries?: SummaryApiOptions; processingApi?: ProcessingApiOptions } = {}) {
  const app = express();
  const auth = options.auth ?? getAuthenticationConfig();
  const routes = createPatientRoutes(options.database ?? pool, auth);
  const documentConfig = options.documentConfig ?? getDocumentConfig();
  const storage = options.documentStorage === undefined
    ? (documentConfig.storage ? createS3Storage(documentConfig.storage) : null) : options.documentStorage;
  const documents = createDocumentRoutes(options.documentDatabase ?? options.database ?? pool, auth, documentConfig, storage);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(helmet());
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173" }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/v1/health", (_req, res) => {
    res.status(200).json({ success: true, message: "AI Health Wallet API is running" });
  });
  app.get("/api/v1/health/db", async (_req, res) => {
    try {
      if (await checkDatabaseConnection()) {
        res.status(200).json({ success: true, database: "connected" });
        return;
      }
    } catch { /* Keep driver errors and connection details private. */ }
    res.status(503).json({ success: false, database: "unavailable" });
  });

  const noStore: express.RequestHandler = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  app.use("/api/v1/auth", noStore, routes.auth);
  app.use("/api/v1/patients", noStore, routes.profile);
  app.use("/api/v1", createSummaryRoutes(options.documentDatabase ?? options.database ?? pool, auth, options.summaries));
  app.use("/api/v1", createProcessingRoutes(options.documentDatabase ?? options.database ?? pool, auth, options.processingApi));
  app.use("/api/v1/documents", documents);
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Endpoint not found.")));
  app.use(errorHandler);
  return app;
}

export default createApp();

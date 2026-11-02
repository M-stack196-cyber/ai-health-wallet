import {createAdminRoutes} from './admin/routes.js';
import {getAdminAuthenticationConfig,type AdminAuthenticationConfig} from './admin/config.js';
import {createGuardianNotificationRoutes} from './guardian-notifications/routes.js';
import {createSharingRoutes,type SharingOptions} from './sharing/routes.js';
import {sharingConfig} from './sharing/config.js';
import {createRagRoutes,type RagOptions} from './rag/routes.js';
import type {RagDatabase} from './rag/repository.js';
import {createGuardianRoutes} from "./guardians/routes.js";
import {createTimelineRoutes} from "./timeline/routes.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { checkDatabaseConnection, pool } from "./database/pool.js";
import { getAuthenticationConfig, type AuthenticationConfig } from "./config/auth.js";
import { createPatientRoutes, type IdentityOptions } from "./auth/routes.js";
import {configuredSecurityEmail} from "./auth/security-email.js";
import { ApiError, errorHandler } from "./http/errors.js";
import type { PatientDatabase } from "./patients/repository.js";
import { getDocumentConfig, type DocumentConfig } from "./config/documents.js";
import { createDocumentRoutes } from "./documents/routes.js";
import { createS3Storage, type DocumentStorage } from "./documents/storage.js";

import {createProcessingRoutes,type ProcessingApiOptions} from "./processing/api.js";
import { createSummaryRoutes, type SummaryApiOptions } from "./summaries/routes.js";

export function createApp(options: { auth?: AuthenticationConfig; admin?: AdminAuthenticationConfig | null; database?: PatientDatabase; identity?: IdentityOptions;
  documentConfig?: DocumentConfig; documentStorage?: DocumentStorage | null; documentDatabase?: PatientDatabase; summaries?: SummaryApiOptions; rag?:RagOptions; sharing?:SharingOptions; processingApi?: ProcessingApiOptions } = {}) {
  const app = express();
  const auth = options.auth ?? getAuthenticationConfig();
  const identity = options.identity ?? {mailer:configuredSecurityEmail(options.database ?? pool)?.mailer};
  const routes = createPatientRoutes(options.database ?? pool, auth, identity);
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
  const admin = options.admin === undefined ? getAdminAuthenticationConfig() : options.admin ?? undefined;
  if (admin) app.use("/api/v1/admin", noStore, createAdminRoutes(options.database ?? pool, auth, admin));
  app.use("/api/v1",createGuardianNotificationRoutes(options.documentDatabase ?? options.database ?? pool,auth,documentConfig,storage));
  app.use("/api/v1",createSharingRoutes((options.documentDatabase ?? options.database ?? pool) as RagDatabase,auth,documentConfig,storage,options.sharing??{config:sharingConfig(process.env),mailer:identity.mailer,ragClient:options.rag?.client}));
  app.use("/api/v1",createRagRoutes((options.documentDatabase ?? options.database ?? pool) as RagDatabase,auth,options.rag));
  app.use("/api/v1", createSummaryRoutes(options.documentDatabase ?? options.database ?? pool, auth, options.summaries));
  app.use("/api/v1", createProcessingRoutes(options.documentDatabase ?? options.database ?? pool, auth, options.processingApi));
  app.use("/api/v1/documents", documents);
  app.use("/api/v1/timeline",createTimelineRoutes(options.documentDatabase ?? options.database ?? pool,auth));
  app.use("/api/v1",createGuardianRoutes(options.database ?? pool,auth,identity));
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Endpoint not found.")));
  app.use(errorHandler);
  return app;
}

export default createApp();

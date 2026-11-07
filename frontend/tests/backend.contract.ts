import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { once } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const pg = require("pg"),
  express = require("express");
import {
  PatientSession,
  DoctorSession,
  patientApi,
  doctorApi,
  shareReference,
  ApiError,
} from "../packages/api/src/index.ts";
import { createPatientRoutes } from "../../backend/src/auth/routes.ts";
import { createSecurityRepository } from "../../backend/src/auth/security-repository.ts";
import { createPasswordService } from "../../backend/src/auth/passwords.ts";
import { getSecurityPolicy } from "../../backend/src/auth/security-policy.ts";
import { createDocumentRoutes } from "../../backend/src/documents/routes.ts";
import { createDocumentRepository } from "../../backend/src/documents/repository.ts";
import { createProcessingRepository } from "../../backend/src/processing/repository.ts";
import { createProcessingService } from "../../backend/src/processing/service.ts";
import { createProcessingRoutes } from "../../backend/src/processing/api.ts";
import { createTimelineRoutes } from "../../backend/src/timeline/routes.ts";
import { createSummaryRoutes } from "../../backend/src/summaries/routes.ts";
import { createSharingRoutes } from "../../backend/src/sharing/routes.ts";
import { sharingConfig } from "../../backend/src/sharing/config.ts";
import { createSecurityEmailDelivery } from "../../backend/src/auth/security-email.ts";
import { createGuardianRoutes } from "../../backend/src/guardians/routes.ts";
import { createGuardianRepository } from "../../backend/src/guardians/repository.ts";
import { syntheticDigitalPdf } from "../../backend/src/processing/fixtures/pdf-fixtures.ts";
import { createSummaryJobRepository } from "../../backend/src/summaries/jobs.ts";
import { sourceCatalogue } from "../../backend/src/summaries/catalogue.ts";
import {
  createSummaryClient,
  fakeSummaryRecipe,
} from "../../backend/src/summaries/client.ts";
import {
  createSummaryExecutor,
  defaultSummaryExecutorConfig,
} from "../../backend/src/summaries/executor.ts";
import { canonicalSummaryJson } from "../../backend/src/summaries/validation.ts";
import { createRagRoutes } from "../../backend/src/rag/routes.ts";
import { createRagClient } from "../../backend/src/rag/client.ts";
import { createRagService } from "../../backend/src/rag/service.ts";
import { errorHandler } from "../../backend/src/http/errors.ts";
import { createAdminRoutes } from "../../backend/src/admin/routes.ts";
import { createAdminAccount } from "../../backend/src/admin/bootstrap.ts";
const socket = process.env.IDENTITY_TEST_SOCKET;
if (!socket || !/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))
  throw Error("Owned disposable socket required.");
const conn = { host: socket, port: 55481, database: "hw_phase8" },
  admin = new pg.Pool({ ...conn, user: userInfo().username }),
  db = new pg.Pool({ ...conn, user: "health_wallet_app", max: 16 });
const auth = {
  jwtKey: randomBytes(32),
  jwtAlgorithm: "HS256" as const,
  jwtLifetimeSeconds: 900,
  jwtIssuer: "phase7-synthetic",
  jwtAudience: "patient",
  argonMemoryKiB: 19456,
  argonTimeCost: 2,
  argonParallelism: 1,
  maxHashConcurrency: 4,
  rateLimitWindowMs: 900000,
  rateLimitMax: 10000,
};
const policy = {
  ...getSecurityPolicy(),
  resendCooldownSeconds: 1,
  challengeRateMax: 100,
};
const security = createSecurityRepository(db, policy),
  objects = new Map<string, Buffer>();
const storage = {
  bucket: "synthetic-private-bucket",
  prefix: "medical-documents/",
  async put(input) {
    const bytes = await readFile(input.path);
    objects.set(input.key, bytes);
    return { versionId: "synthetic-private" };
  },
  async remove() {},
  async download() {
    throw Error("No signed URLs");
  },
  async readOriginal(i) {
    const bytes = objects.get(i.key);
    if (!bytes) throw Error("Synthetic missing object");
    await writeFile(i.destination, bytes, { flag: "wx", mode: 0o600 });
    return { bytes: bytes.length };
  },
};
const documentConfig = {
  maxFileBytes: 2097152,
  maxConcurrentUploads: 2,
  uploadTimeoutMs: 30000,
  validationTimeoutMs: 15000,
  maxImagePixels: 2000000,
  maxPdfPages: 5,
  downloadExpirySeconds: 60,
  uploadRateLimitMax: 1000,
  storage: null,
};
const processingConfig = {
  maxAttempts: 3,
  leaseMs: 60000,
  attemptTimeoutMs: 120000,
  heartbeatMs: 5000,
  retryBaseMs: 1000,
  retryMaxMs: 1000,
  recoveryBatchSize: 5,
};
const verificationMessages: any[] = [];
const verification = createSecurityEmailDelivery(
  db,
  {
    mode: "sandbox",
    endpoint: "http://127.0.0.1/unused",
    from: "security@example.invalid",
    encryptionKey: randomBytes(32),
    timeoutMs: 1000,
    retrySeconds: 1,
    maxAttempts: 3,
  },
  {
    async send(m) {
      verificationMessages.push(m);
      return { messageReference: "synthetic-verification" };
    },
  },
);
const adminConfig = {
  jwtKey: new Uint8Array(randomBytes(32)),
  jwtAlgorithm: "HS256" as const,
  jwtLifetimeSeconds: 900,
  jwtIssuer: "phase8-admin",
  jwtAudience: "phase8-admin-audience",
  rateLimitMax: 100,
  rateWindowSeconds: 900,
};
let fixtureHash: string, server: any, base: string, python: any, ocrUrl: string;
const serviceToken = randomBytes(32).toString("hex");
async function startPython() {
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const address = portProbe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((r) => portProbe.close(() => r()));
  ocrUrl = "http://127.0.0.1:" + port;
  python = spawn(
    "/tmp/hw-phase3-python/bin/python",
    ["-m", "rag_service.entry"],
    {
      cwd: new URL("../../ai-service/", import.meta.url),
      env: {
        PATH: "/usr/bin:/bin",
        PYTHONPATH: new URL("../../ai-service/", import.meta.url).pathname,
        PYTHONDONTWRITEBYTECODE: "1",
        RAG_PROVIDER: "synthetic-offline",
        RAG_SERVICE_TOKEN: serviceToken,
        RAG_SERVICE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  python.stdout?.resume();
  python.stderr?.resume();
  for (let i = 0; i < 600; i++) {
    if (python.exitCode !== null)
      throw Error("Synthetic Python service exited before readiness.");
    try {
      const r = await fetch(ocrUrl + "/health", {
        headers: { Authorization: "Bearer " + serviceToken },
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Synthetic Python service did not become ready.");
}
before(async () => {
  assert.equal((await stat(socket!)).mode & 0o777, 0o700);
  assert.equal(
    await readFile(socket + "/phase1-owned", "utf8"),
    "identity-security-v1\n",
  );
  const bootstrap = new pg.Client({
    host: socket,
    port: 55481,
    user: userInfo().username,
    database: "postgres",
  });
  await bootstrap.connect();
  try {
    await bootstrap.query(
      "CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE",
    );
    await bootstrap.query("CREATE ROLE health_wallet_migrator NOLOGIN");
    await bootstrap.query("CREATE DATABASE hw_phase8");
  } finally {
    await bootstrap.end();
  }
  await admin.query("CREATE EXTENSION vector");
  await admin.query(
    "GRANT USAGE,CREATE ON SCHEMA public TO health_wallet_migrator",
  );
  fixtureHash = await createPasswordService(auth).hash(
    "Synthetic fixture passphrase 598!",
  );
  const files = (
    await readdir(new URL("../../backend/migrations/", import.meta.url))
  )
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.equal(files.length, 22);
  for (const file of files) {
    if (file.startsWith("0005"))
      await admin.query(
        "GRANT USAGE ON SCHEMA public TO health_wallet_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app",
      );
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE health_wallet_migrator");
      await c.query(
        await readFile(
          new URL("../../backend/migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await startPython();
  const ragClient = createRagClient({
    provider: "synthetic-offline",
    url: ocrUrl + "/internal/v1/rag/",
    token: serviceToken,
  });
  const app = express();
  app.use(express.json());
  const identity = createPatientRoutes(db, auth, {
    mailer: verification.mailer,
    policy,
  });
  app.use("/api/v1/auth", identity.auth);
  app.use("/api/v1/patients", identity.profile);
  // Mounted before the routers that cover all of /api/v1, as in app.ts.
  app.use(
    "/api/v1/admin",
    createAdminRoutes(db, auth, adminConfig, { health: { services: [{ name: "ai_ocr" }, { name: "ai_summary" }, { name: "ai_rag" }] } }),
  );
  app.use(
    "/api/v1/documents",
    createDocumentRoutes(db, auth, documentConfig, storage),
  );
  app.use("/api/v1", createProcessingRoutes(db, auth));
  app.use("/api/v1/timeline", createTimelineRoutes(db, auth));
  app.use(
    "/api/v1",
    createSummaryRoutes(db, auth, { enabled: true, database: db }),
  );
  app.use("/api/v1", createRagRoutes(db, auth, { client: ragClient }));
  app.use(
    "/api/v1",
    createSharingRoutes(db, auth, documentConfig, storage, {
      config: sharingConfig({
        SHARING_PUBLIC_ORIGIN: "https://doctor.example.invalid",
      }),
      mailer: verification.mailer,
      ragClient,
    }),
  );
  app.use(
    "/api/v1",
    createGuardianRoutes(db, auth, { mailer: verification.mailer, policy }),
  );
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  if (python && python.exitCode === null) {
    python.kill();
    await once(python, "exit").catch(() => {});
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await db.end();
  await admin.end();
});
function session() {
  let stored: string | null = null;
  return new PatientSession(
    { baseUrl: base },
    {
      read: async () => stored,
      write: async (v) => {
        stored = v;
      },
      remove: async () => {
        stored = null;
      },
    },
  );
}
async function user() {
  const id = randomUUID(),
    email = id + "@example.invalid";
  await db.query(
    "INSERT INTO patients(id,email,password_hash,full_name,email_verified_at,account_status) VALUES($1,$2,$3,'Synthetic Patient',clock_timestamp(),'active')",
    [id, email, fixtureHash],
  );
  const s = await security.login(id, fixtureHash);
  assert.ok(s);
  const client = session();
  await client.login(email, "Synthetic fixture passphrase 598!");
  return { id, email, who: { patientId: id, sessionId: s.sessionId }, client };
}
const pdf = syntheticDigitalPdf([["Synthetic non-medical original"]]);
async function document(
  u: Awaited<ReturnType<typeof user>>,
  text = "Glucose: 90 mg/dL\nDEMO_MARKER: 5 demo_units",
  processed = true,
  method: "pdf_text" | "ocr" = "pdf_text",
) {
  const key = storage.prefix + randomUUID() + ".pdf";
  objects.set(key, pdf);
  const d = await createDocumentRepository(db).insert({
    id: randomUUID(),
    patientId: u.id,
    bucket: storage.bucket,
    key,
    name: "synthetic.pdf",
    type: "pdf",
    mime: "application/pdf",
    bytes: pdf.length,
    checksum: createHash("sha256").update(pdf).digest("base64"),
    category: "lab_report",
    hospital_name: "Synthetic Hospital",
    document_date: "2026-01-02",
  });
  if (processed) {
    const service = createProcessingService(
        createProcessingRepository(db, processingConfig, u.id),
      ),
      job = await service.claim();
    assert.ok(job);
    assert.equal(
      await service.persistExtraction(
        { documentId: d.id, patientId: u.id, token: job.lease_token! },
        {
          text,
          method,
          extractor: { name: "phase7-synthetic", version: "v1" },
          source: {
            sha256: d.sha256,
            pageCount: 1,
            pages: [
              {
                page: 1,
                method,
                ...(method === "ocr" ? { confidence: 50 } : {}),
              },
            ],
          },
        },
      ),
      true,
    );
  }
  return d;
}
async function summary(u: Awaited<ReturnType<typeof user>>, id: string) {
  const repo = createSummaryJobRepository(db, u.id),
    s = await repo.captureSnapshot(id),
    { input_sha256: _, ...pipeline } = fakeSummaryRecipe("0".repeat(64));
  await repo.enqueue(s.id, sourceCatalogue(s), pipeline);
  const client = createSummaryClient(
    { enabled: true, token: randomBytes(32).toString("hex") },
    async (r) => {
      const input = JSON.parse(Buffer.from(r.body).toString());
      return {
        status: 200,
        body: (async function* () {
          yield Buffer.from(
            canonicalSummaryJson({
              schema_version: 1,
              kind: "medical-summary-output",
              scope: input.scope,
              reported_findings: input.facts,
              educational_explanations: ["glucose"],
              uncertainty: {
                codes: ["page_locations_unavailable"],
                fact_ids: [],
              },
              catalogue_coverage: "all_catalogued",
              provenance: fakeSummaryRecipe(
                r.headers["x-summary-input-sha256"],
              ),
            }),
          );
        })(),
      };
    },
  );
  assert.equal(
    await createSummaryExecutor(
      { ...defaultSummaryExecutorConfig, enabled: true, patientId: u.id },
      { repository: repo, client },
    ).runOnce(),
    "completed",
  );
  return (await repo.summaries(id))[0];
}
async function emailedCode(challengeId?: string) {
  await verification.drain(100);
  const mail = [...verificationMessages]
    .reverse()
    .find((m) => !challengeId || m.text.includes(challengeId));
  assert.ok(mail);
  const token = mail.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];
  assert.ok(token);
  return token;
}
async function doctor(
  patient: ReturnType<typeof patientApi>,
  ids: string[],
  method: "qr_code" | "unique_link" = "unique_link",
) {
  const grant = await patient.share(ids, method),
    client = new DoctorSession({ baseUrl: base }),
    api = doctorApi(client),
    reference = shareReference(grant.share_url);
  await api.open(reference);
  const identity = {
    share_token: reference,
    name: "Synthetic Doctor",
    email: randomUUID() + "@example.invalid",
  };
  const challenge = await api.otp(identity);
  const result = await api.verify({
    share_token: reference,
    email: identity.email,
    challenge_id: challenge.challenge_id,
    otp: await emailedCode(challenge.challenge_id),
  });
  client.authorize(result.access_token, result.expires_at);
  return { grant, client, api };
}
test("P8-API-01 registration, verification/resend, login/refresh/logout and recovery against real M01 routes", async () => {
  const client = session(),
    api = patientApi(client),
    email = randomUUID() + "@example.invalid";
  await api.register({
    full_name: "Synthetic Registration",
    email,
    password: "Synthetic long passphrase 88!",
    date_of_birth: "2000-01-01",
    sex_gender: "prefer_not_to_say",
  });
  await assert.rejects(
    client.login(email, "Synthetic long passphrase 88!"),
    ApiError,
  );
  await api.verify(await emailedCode());
  await api.resend(email);
  await client.login(email, "Synthetic long passphrase 88!");
  assert.equal((await api.profile()).patient.email, email);
  await api.forgot(email);
  await client.reset(
    await emailedCode(),
    "Synthetic replacement passphrase 89!",
  );
  assert.equal(client.authorized, false);
  await client.login(email, "Synthetic replacement passphrase 89!");
  await client.logout();
  assert.equal(client.authorized, false);
});
test("P8-API-02 guardian NONE/PENDING/ACTIVE/replace/remove and approved profile patch", async () => {
  const u = await user(),
    api = patientApi(u.client);
  assert.equal((await api.guardian()).guardian.status, "NONE");
  await api.updateProfile({
    full_name: "Updated Synthetic",
    date_of_birth: "2000-01-01",
    phone_number: null,
    sex_gender: "other",
  });
  await api.setGuardian("guardian-" + randomUUID() + "@example.invalid");
  assert.equal((await api.guardian()).guardian.status, "PENDING");
  await createGuardianRepository(db, policy, verification.mailer).accept(
    await emailedCode(),
  );
  assert.equal((await api.guardian()).guardian.status, "ACTIVE");
  await admin.query(
    "UPDATE patient_auth_challenges SET created_at=clock_timestamp()-interval '2 seconds' WHERE patient_id=$1 AND purpose='guardian_invitation'",
    [u.id],
  );
  await api.setGuardian(
    "replacement-" + randomUUID() + "@example.invalid",
    true,
  );
  assert.equal((await api.guardian()).guardian.status, "PENDING");
  await api.removeGuardian();
  assert.equal((await api.guardian()).guardian.status, "REVOKED");
  await u.client.logout();
});
test("P8-API-03 upload, metadata, processing readiness, retrieval, timeline fallback and deletion", async () => {
  const u = await user(),
    api = patientApi(u.client);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    "uploaded.pdf",
  );
  form.append("category", "lab_report");
  form.append("hospital_name", "Synthetic Hospital");
  const d = (await api.upload(form)).document;
  assert.equal(
    (
      await api.records({
        limit: 20,
        category: "lab_report",
        hospital: "Synthetic Hospital",
      })
    ).documents.length,
    1,
  );
  assert.equal(
    (await api.record(d.id)).document.original_filename,
    "uploaded.pdf",
  );
  await api.metadata(d.id, {
    category: "prescription",
    hospital_name: "Updated Hospital",
    document_date: null,
  });
  const t = await api.timeline();
  assert.equal(t.entries[0].date_source, "uploaded_at");
  assert.equal((await api.processing(d.id)).processing.stage, "extraction");
  assert.equal((await api.original(d.id)).size, pdf.length);
  await assert.rejects(
    api.retry(d.id),
    (e) => e instanceof ApiError && e.status === 503,
  );
  const deleted = await api.remove(d.id);
  assert.equal(deleted.original_erased, false);
  assert.equal((await api.timeline()).entries.length, 0);
  await assert.rejects(
    api.record(d.id),
    (e) => e instanceof ApiError && e.status === 404,
  );
  await u.client.logout();
});
test("P8-API-04 selected-only doctor original/summary/timeline/history/RAG, backend bypass rejection and revocation", async () => {
  const u = await user(),
    api = patientApi(u.client),
    selected = await document(u),
    unshared = await document(u, "Glucose: 999 mg/dL");
  await summary(u, selected.id);
  await summary(u, unshared.id);
  const ragClient = createRagClient({
      provider: "synthetic-offline",
      url: ocrUrl + "/internal/v1/rag/",
      token: serviceToken,
    }),
    rag = createRagService(db, u.id, ragClient, async () => {});
  await rag.index(selected.id);
  await rag.index(unshared.id);
  const d = await doctor(api, [selected.id], "qr_code");
  assert.ok(d.grant.qr_svg?.includes("<svg"));
  assert.deepEqual(
    (
      await d.api.records({
        limit: 20,
        category: "lab_report",
        hospital: "Synthetic Hospital",
      })
    ).documents.map((x) => x.id),
    [selected.id],
  );
  assert.ok((await api.summary(selected.id)).summary.text);
  const patientHistory = await api.requestHistory();
  assert.equal(
    (await api.history(patientHistory.history.id)).history.entries.length,
    2,
  );
  const patientAnswer = (await api.ask("What is the Glucose value?")).result;
  assert.ok(
    patientAnswer.citations.every((c) =>
      [selected.id, unshared.id].includes(c.document_id),
    ),
  );
  assert.equal((await d.api.file(selected.id)).size, pdf.length);
  assert.equal((await d.api.file(selected.id, true)).size, pdf.length);
  assert.ok((await d.api.summary(selected.id)).summary.text);
  assert.deepEqual(
    (await d.api.timeline()).entries.map((x) => x.source_document_id),
    [selected.id],
  );
  assert.equal((await d.api.history()).scope, "selected_records_only");
  const result = (await d.api.ask("What is the Glucose value?")).result;
  assert.ok(result.citations.every((c) => c.document_id === selected.id));
  const bypass = await doctor(api, [selected.id]);
  await assert.rejects(
    bypass.api.record(unshared.id),
    (e) => e instanceof ApiError && e.status === 403,
  );
  assert.equal(bypass.client.authorized, false);
  await api.revoke(d.grant.grant.id);
  await assert.rejects(
    d.api.records(),
    (e) => e instanceof ApiError && e.status === 403,
  );
  assert.equal(d.client.authorized, false);
  await u.client.logout();
});
test("P8-API-05 source deletion and account suspension invalidate current backend access", async () => {
  const u = await user(),
    api = patientApi(u.client),
    source = await document(u),
    d = await doctor(api, [source.id]);
  await api.remove(source.id);
  await assert.rejects(
    d.api.records(),
    (e) => e instanceof ApiError && e.status === 403,
  );
  await admin.query(
    "UPDATE patients SET account_status='suspended' WHERE id=$1",
    [u.id],
  );
  await assert.rejects(
    api.profile(),
    (e) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(u.client.authorized, false);
});
test("R8-PERF-01 real-backend response times for the main patient and doctor calls are measured (synthetic data, local disposable database)", async () => {
  // CFG-10 has no approved numeric latency value in the repository, so nothing here is compared
  // with a threshold. Every call must succeed; the measured figures are printed and optionally saved.
  const u = await user(),
    api = patientApi(u.client),
    selected = await document(u);
  await summary(u, selected.id);
  const ragClient = createRagClient({
      provider: "synthetic-offline",
      url: ocrUrl + "/internal/v1/rag/",
      token: serviceToken,
    }),
    rag = createRagService(db, u.id, ragClient, async () => {});
  await rag.index(selected.id);
  const d = await doctor(api, [selected.id], "qr_code");
  const runs = 20;
  const calls: Record<string, () => Promise<unknown>> = {
    "patient profile": () => api.profile(),
    "patient records list": () => api.records({ limit: 20 }),
    "patient timeline": () => api.timeline(),
    "patient summary": () => api.summary(selected.id),
    "patient original file": () => api.original(selected.id),
    "patient RAG question": () => api.ask("What is the Glucose value?"),
    "doctor records list": () => d.api.records(),
    "doctor original file": () => d.api.file(selected.id),
    "doctor summary": () => d.api.summary(selected.id),
    "doctor RAG question": () => d.api.ask("What is the Glucose value?"),
  };
  const report: Record<string, { runs: number; p50_ms: number; p95_ms: number; max_ms: number }> = {};
  for (const [name, call] of Object.entries(calls)) {
    await call(); // one warm-up call, not measured
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await call();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) => Math.round(times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)] * 10) / 10;
    report[name] = { runs, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
  }
  assert.equal(Object.keys(report).length, Object.keys(calls).length);
  console.log("R8_PERF " + JSON.stringify(report));
  if (process.env.R8_PERF_OUT) await writeFile(process.env.R8_PERF_OUT, JSON.stringify(report, null, 2), { mode: 0o600 });
  // End the doctor session the way the product does (revoke), so no session timer keeps the process alive.
  await api.revoke(d.grant.grant.id);
  await assert.rejects(d.api.records(), (e) => e instanceof ApiError && e.status === 403);
  await u.client.logout();
});
test("P8-API-06 real Chrome doctor flow through Vite proxy to actual backend/DB/email OTP and revocation", async () => {
  const { chromium, expect } = await import("@playwright/test");
  const u = await user(),
    api = patientApi(u.client),
    source = await document(u),
    other = await document(u, "Glucose: 999 mg/dL"),
    grant = await api.share([source.id], "unique_link");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const vite = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/doctor/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH, HW_LOCAL_API: base },
      stdio: "ignore",
    },
  );
  let browser;
  try {
    const origin = "http://127.0.0.1:" + port;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    browser = await chromium.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const responses: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/"))
        responses.push(new URL(r.url()).pathname + ":" + r.status());
    });
    await page.goto(origin + "/" + new URL(grant.share_url).hash);
    await expect(page.getByText("synthetic.pdf", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: /Continue securely/ }).click();
    await page.getByLabel("Doctor name").fill("Synthetic Doctor");
    const email = randomUUID() + "@example.invalid";
    await page.getByLabel("Email", { exact: true }).fill(email);
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/sharing/otp"),
    );
    await page.getByRole("button", { name: /Send verification code/ }).click();
    const challenge = await (await response).json();
    const code = await emailedCode(challenge.challenge_id);
    await page.getByLabel("Complete email verification code").fill(code);
    await page.getByRole("button", { name: /Verify & open/ }).click();
    try {
      await expect(
        page.getByText("synthetic.pdf", { exact: true }),
      ).toHaveCount(1);
    } catch {
      throw new Error(
        JSON.stringify({
          responses,
          screen: (await page.locator("body").innerText()).slice(-2500),
        }),
      );
    }
    await page.getByRole("button", { name: /synthetic.pdf/ }).click();
    await page
      .getByRole("button", { name: "View original", exact: true })
      .click();
    await expect(
      page.getByTitle("Authorized original document"),
    ).toHaveAttribute("src", /^blob:/);
    await api.revoke(grant.grant.id);
    await page.getByRole("button", { name: "Load report summary" }).click();
    await expect(page.getByText(/Access ended/)).toBeVisible();
    await expect(page.getByText("synthetic.pdf", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByTitle("Authorized original document")).toHaveCount(
      0,
    );
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
  } finally {
    await browser?.close();
    vite.kill();
    await once(vite, "exit").catch(() => {});
    await u.client.logout();
  }
});

test("P8-ADMIN-API-01 real Chrome admin flow through Vite proxy to the actual backend and database: sign-in, search, suspend/reactivate, processing and retry, with audit rows", async () => {
  const { chromium, expect } = await import("@playwright/test");
  const adminPassword = "Synthetic admin passphrase 731!",
    adminEmail = randomUUID() + "@example.invalid";
  const created = await createAdminAccount(
    admin,
    (p: string) => createPasswordService(auth).hash(p),
    { email: adminEmail, fullName: "Synthetic Admin", role: "support_admin", password: adminPassword },
  );
  const u = await user(),
    patientClient = patientApi(u.client),
    name = "Synthetic Patient";
  assert.ok(await patientClient.profile());
  // a failed, retryable job staged with triggers off (CHECK constraints still apply)
  const documentId = randomUUID(),
    c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role=replica");
    await c.query(
      `INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,hospital_name,processing_status,content_type,size_bytes,sha256)
       VALUES($1,$2,'synthetic-private-bucket',$3,'LEAK-admin-check.pdf','pdf','lab_report','LEAK Hospital','failed','application/pdf',24,'02be06dafdca1e35e82ce33d549485f29627c07274b644fafb0e54befbe732de')`,
      [documentId, u.id, "medical-documents/" + documentId + ".pdf"],
    );
    await c.query(
      "INSERT INTO public.document_processing_jobs(document_id,patient_id,state,attempt_count,max_attempts,started_at,finished_at,last_error_code) VALUES($1,$2,'failed',1,3,clock_timestamp(),clock_timestamp(),'PROCESSOR_FAILED')",
      [documentId, u.id],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/admin/vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: new URL("../", import.meta.url), env: { PATH: process.env.PATH, HW_LOCAL_API: base }, stdio: "ignore" },
  );
  let browser;
  try {
    const origin = "http://127.0.0.1:" + port;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin)).ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    const paths: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/")) paths.push(r.method() + " " + new URL(r.url()).pathname);
    });

    await page.goto(origin + "/");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill("wrong password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign-in failed. Check your email and password.")).toBeVisible();
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
    // search by the patient's exact email, then suspend with confirmation
    await page.getByLabel("Search name or email").fill(u.email);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(page.getByRole("row", { name: new RegExp(u.email) })).toHaveCount(1);
    await page.getByRole("button", { name: "Open " + name }).click();
    const detail = page.getByRole("complementary", { name: "Account detail" });
    await expect(detail).toContainText(u.email);
    await expect(detail).toContainText("active");
    await detail.getByRole("button", { name: "Suspend account" }).click();
    assert.equal((await admin.query("SELECT account_status FROM patients WHERE id=$1", [u.id])).rows[0].account_status, "active", "nothing changes before confirmation");
    await detail.getByRole("button", { name: "Confirm suspend" }).click();
    await expect(detail.getByText(/was suspended/)).toBeVisible();
    assert.equal((await admin.query("SELECT account_status FROM patients WHERE id=$1", [u.id])).rows[0].account_status, "suspended");
    await assert.rejects(patientClient.profile(), ApiError, "the patient's own session is cut off by the real backend");
    await detail.getByRole("button", { name: "Reactivate account" }).click();
    await detail.getByRole("button", { name: "Confirm reactivate" }).click();
    await expect(detail.getByText(/was reactivated/)).toBeVisible();
    assert.equal((await admin.query("SELECT account_status FROM patients WHERE id=$1", [u.id])).rows[0].account_status, "active");
    await assert.rejects(patientClient.profile(), ApiError, "reactivation does not bring the old session back");
    // processing: filter to the staged failed job, retry with confirmation
    await page.getByRole("button", { name: "Processing" }).click();
    await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Processing summary" })).toContainText("All jobs");
    await page.getByLabel("Patient ID").fill(u.id);
    await page.getByLabel("State").selectOption("failed");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.getByRole("button", { name: "Open job " + documentId.slice(0, 8) }).click();
    const job = page.getByRole("complementary", { name: "Job detail" });
    await expect(job).toContainText("1 of 3");
    await expect(job).toContainText("processor failed");
    await job.getByRole("button", { name: "Retry job" }).click();
    assert.equal((await admin.query("SELECT state FROM document_processing_jobs WHERE document_id=$1", [documentId])).rows[0].state, "failed", "nothing changes before confirmation");
    await job.getByRole("button", { name: "Confirm retry" }).click();
    await expect(job.getByText(/Retry queued/)).toBeVisible();
    const after = (await admin.query("SELECT j.state,j.attempt_count,d.processing_status FROM document_processing_jobs j JOIN medical_documents d ON d.id=j.document_id WHERE j.document_id=$1", [documentId])).rows[0];
    assert.deepEqual([after.state, after.attempt_count, after.processing_status], ["retry_wait", 1, "processing"]);
    const body = await page.locator("body").innerText();
    for (const word of ["LEAK", "admin-check.pdf"]) assert.ok(!body.includes(word), "the screens never show " + word);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: "" });
    assert.ok(paths.every((p) => p.includes("/api/v1/admin/")), "only admin endpoints were called: " + [...new Set(paths)].join(", "));
    assert.ok(!paths.some((p) => /documents|download|summary-jobs|rag|doctor|timeline/.test(p.replace("/processing/summary", ""))));
    // the actions are in the audit log, attributed to this admin
    const audit = (await admin.query("SELECT action,outcome FROM admin_audit_events WHERE actor_admin_id=$1 AND action IN ('admin.patients.suspend','admin.patients.reactivate','admin.processing.retry') ORDER BY seq", [created.id])).rows;
    assert.deepEqual(audit.map((r: any) => r.action + ":" + r.outcome), ["admin.patients.suspend:success", "admin.patients.reactivate:success", "admin.processing.retry:success"]);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await browser?.close();
    vite.kill();
    await once(vite, "exit").catch(() => {});
  }
});

test("P9-ADMIN-API-01 real Chrome admin flow through Vite proxy to the actual backend and database: menu, health, setting change, serious rule, status screens and the audit chain", async () => {
  const { chromium, expect } = await import("@playwright/test");
  const adminPassword = "Synthetic admin passphrase 731!",
    adminEmail = randomUUID() + "@example.invalid";
  const created = await createAdminAccount(
    admin,
    (p: string) => createPasswordService(auth).hash(p),
    { email: adminEmail, fullName: "Synthetic Admin", role: "support_admin", password: adminPassword },
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/admin/vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: new URL("../", import.meta.url), env: { PATH: process.env.PATH, HW_LOCAL_API: base }, stdio: "ignore" },
  );
  let browser;
  try {
    const origin = "http://127.0.0.1:" + port;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin)).ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    const paths: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/")) paths.push(r.method() + " " + new URL(r.url()).pathname);
    });
    const go = (name: string) => page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name, exact: true }).click();
    await page.goto(origin + "/");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
    // the menu comes from the real /admin/me permissions
    const perms: string[] = (await admin.query("SELECT permission FROM admin_role_permissions WHERE role_name='support_admin'")).rows.map((r: any) => r.permission);
    const expected = ["admin.patients.read", "admin.processing.read", "admin.guardians.read", "admin.shares.read", "admin.deliveries.read", "admin.settings.read", "admin.rules.read", "admin.health.read", "admin.audit.read"].filter((p) => perms.includes(p)).length;
    assert.equal(await page.getByRole("navigation", { name: "Sections" }).getByRole("button").count(), expected);
    assert.ok(perms.includes("admin.settings.change"), "real support_admin lacks admin.settings.change: " + perms.join(","));
    // status screens answer from the real database
    for (const [item, heading] of [["Guardians", "Guardian relationships"], ["Share grants", "Doctor share grants"], ["Deliveries", "Email and notification delivery"]]) {
      await go(item);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    // health: the database component is reported; services that are not configured say so
    await go("System health");
    const components = page.getByRole("table", { name: "Components" });
    await expect(components.getByRole("row", { name: /^Database OK/ })).toBeVisible();
    await expect(components.getByRole("row", { name: /Question answering/ })).toContainText("Not configured");
    // an ungated setting: validation, confirmation, then a stored version
    await go("Settings");
    await page.getByRole("button", { name: "Open setting documents.max_pdf_pages" }).click();
    const detail = page.getByRole("complementary", { name: "Setting detail" });
    await detail.getByLabel("New value").fill("5000");
    await detail.getByRole("button", { name: "Review change" }).click();
    await expect(detail.getByRole("alert")).toContainText("The value must be between 1 and 200 pages.");
    await detail.getByLabel("New value").fill("60");
    await detail.getByRole("button", { name: "Review change" }).click();
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM admin_setting_versions WHERE setting_key='documents.max_pdf_pages'")).rows[0].n, 0, "nothing is stored before confirmation");
    await expect(detail.getByRole("button", { name: "Confirm change" })).toBeVisible();
    await detail.getByRole("button", { name: "Confirm change" }).click();
    await expect(detail.getByText("Version 1 was saved and is now in effect.")).toBeVisible();
    assert.equal((await admin.query("SELECT value::int AS v FROM admin_setting_effective WHERE setting_key='documents.max_pdf_pages'")).rows[0].v, 60);
    // a gated setting stays pending: the value in effect does not change and the proposer has no decision form
    await page.getByRole("button", { name: "Open setting auth.reset_seconds" }).click();
    await detail.getByLabel("New value").fill("600");
    await detail.getByRole("button", { name: "Review change" }).click();
    await detail.getByRole("button", { name: "Confirm change" }).click();
    await expect(detail.getByText(/waiting for approval by a different admin/)).toBeVisible();
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM admin_setting_effective WHERE setting_key='auth.reset_seconds'")).rows[0].n, 0);
    await page.getByRole("button", { name: "Review auth.reset_seconds version 1" }).click();
    await expect(detail).toContainText("You proposed this change, so a different admin must approve it.");
    // a serious rule: stored as not clinically approved
    await go("Serious rules");
    await expect(page.getByRole("note", { name: "Admin editing is NOT clinical approval" })).toBeVisible();
    const form = page.getByRole("form", { name: "New rule version" });
    await form.getByLabel("Rule ID").fill("PHASE9_SYNTHETIC_RULE");
    await form.getByLabel("Field", { exact: true }).fill("synthetic marker");
    await form.getByLabel("Units").fill("units");
    await form.getByLabel("Comparison").selectOption("gt");
    await form.getByLabel("Bound", { exact: true }).fill("10");
    await form.getByRole("button", { name: "Review rule" }).click();
    await form.getByRole("button", { name: "Confirm save" }).click();
    await expect(page.getByText("Saved as version 1 of PHASE9_SYNTHETIC_RULE. It is recorded as not clinically approved.")).toBeVisible();
    const stored = (await admin.query("SELECT clinical_approval,created_by FROM admin_serious_rule_versions WHERE rule_id='PHASE9_SYNTHETIC_RULE'")).rows;
    assert.deepEqual(stored.map((r: any) => [r.clinical_approval, r.created_by]), [["not_clinically_approved", created.id]]);
    // the audit screen shows the real chain result and this session's actions
    await go("Audit log");
    await expect(page.getByRole("region", { name: "Audit chain check" })).toContainText("Audit chain: INTACT.");
    await expect(page.getByRole("region", { name: "Event list" })).toContainText("admin.rules.create");
    await page.getByLabel("Action").fill("admin.settings.change");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("region", { name: "Event list" }).getByRole("row").nth(1)).toContainText("admin.settings.change");
    const body = await page.locator("body").innerText();
    for (const word of ["Bearer", "eyJ", "argon2"]) assert.ok(!body.includes(word), "the page shows " + word);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: "" });
    assert.ok(paths.every((p) => p.includes("/api/v1/admin/")), "only admin endpoints were called");
    assert.ok(!paths.some((p) => /documents|download|summary-jobs|rag|doctor|timeline/.test(p.replace("/processing/summary", "").replace(/\/settings\/[^/]+/, "/settings/KEY"))));
    const audited = (await admin.query("SELECT action,outcome FROM admin_audit_events WHERE actor_admin_id=$1 AND action IN ('admin.settings.change','admin.rules.create') ORDER BY seq", [created.id])).rows;
    assert.deepEqual(audited.map((r: any) => r.action + ":" + r.outcome), ["admin.settings.change:success", "admin.settings.change:success", "admin.rules.create:success"]);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await browser?.close();
    vite.kill();
    await once(vite, "exit").catch(() => {});
  }
});

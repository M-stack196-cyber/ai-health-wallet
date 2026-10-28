import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import sharp from "sharp";
import type { QueryResultRow } from "pg";
import { parse } from "dotenv";
import { createApp } from "../app.js";
import { getAuthenticationConfig } from "../config/auth.js";
import { getDocumentConfig } from "../config/documents.js";
import { pool, closeDatabasePool } from "../database/pool.js";
import type { PatientDatabase } from "../patients/repository.js";
import { createDocumentRepository } from "./repository.js";
import { StorageFailure, validStorageReference, type DocumentStorage, type UploadObject, type StoredObject } from "./storage.js";
import { createDocumentService } from "./service.js";

export function syntheticPdf(javascript = false): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R" + (javascript ? " /OpenAction 5 0 R" : "") + " >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 40] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 4 >>\nstream\nq\nQ\nendstream"];
  if (javascript) objects.push("<< /S /JavaScript /JS (app.alert\\(synthetic\\)) >>");
  let file = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(file)); file += (index + 1) + " 0 obj\n" + object + "\nendobj\n"; }
  const xref = Buffer.byteLength(file);
  file += "xref\n0 " + offsets.length + "\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) file += String(offset).padStart(10, "0") + " 00000 n \n";
  return Buffer.from(file + "trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
}
class FakeStorage implements DocumentStorage {
  readonly bucket = "synthetic-private-medical-bucket";
  readonly prefix = "medical-documents/";
  readonly objects = new Map<string, Buffer>();
  puts = 0; removes = 0; downloads = 0;
  failPut: "before" | "after" | null = null;
  removeFailures = 0;
  failDownload = false;
  putHook?: () => Promise<void>;
  async put(input: UploadObject): Promise<StoredObject> {
    this.puts++;
    if (this.failPut === "before") throw new StorageFailure(false);
    const bytes = await readFile(input.path);
    this.objects.set(input.key, bytes);
    if (this.putHook) await this.putHook();
    if (this.failPut === "after") throw new StorageFailure(true);
    return { versionId: "synthetic-version" };
  }
  async remove(key: string): Promise<void> {
    this.removes++;
    if (this.removeFailures-- > 0) throw new StorageFailure();
    this.objects.delete(key);
  }
  async readOriginal(input: import("./original-reader.js").ReadOriginalInput) {
    this.downloads++;
    const bytes=this.objects.get(input.key);
    if(this.failDownload || !bytes || bytes.length>input.maxBytes)throw new StorageFailure();
    input.signal.throwIfAborted();
    await writeFile(input.destination,bytes,{flag:"wx",mode:0o600});
    return {bytes:bytes.length};
  }
  async download(key: string, _name: string, _type: string, _seconds: number): Promise<string> {
    this.downloads++;
    if (this.failDownload || !this.objects.has(key)) throw new StorageFailure();
    return "https://synthetic.invalid/" + key + "?signature=synthetic";
  }
}

test("Phase 2.1 authenticated document management", { timeout: 180000 }, async (t) => {
  const auth = { ...getAuthenticationConfig(), jwtKey: new Uint8Array(randomBytes(32)), rateLimitMax: 100 };
  const config = { ...getDocumentConfig(), maxFileBytes: 4096, uploadRateLimitMax: 100 };
  const storage = new FakeStorage();
  const nonce = randomUUID();
  const emails = ["documents-a-", "documents-b-"].map(prefix => prefix + nonce + "@example.invalid");
  const password = randomBytes(24).toString("base64url");
  const env = parse(await readFile(new URL("../../.env", import.meta.url)));
  const secrets = [env.JWT_SECRET, env.DB_PASSWORD, password].filter(Boolean);
  const servers: ReturnType<ReturnType<typeof createApp>["listen"]>[] = [];
  const baselineTemps = new Set((await readdir(tmpdir())).filter(name => name.startsWith("health-wallet-upload-")));
  let cleanup = false;
  let patientA = ""; let patientB = ""; let tokenA = ""; let tokenB = "";
  const records: string[] = [];
  const pdf = syntheticPdf();
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: "white" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 3, height: 3, channels: 3, background: "white" } }).jpeg().toBuffer();
  async function listen(options: Parameters<typeof createApp>[0] = {}): Promise<string> {
    const server = createApp({ auth, documentConfig: config, documentStorage: storage, ...options }).listen(0, "127.0.0.1");
    servers.push(server); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    return "http://127.0.0.1:" + address.port;
  }
  async function send(base: string, path: string, method = "GET", body?: BodyInit, token?: string, headers: Record<string, string> = {}) {
    if (token) headers.Authorization = "Bearer " + token;
    const response: Response = await fetch(base + path, { method, body, headers, signal: AbortSignal.timeout(25000) });
    const value = await response.json();
    const serialized = JSON.stringify(value);
    assert.ok(!secrets.some(secret => serialized.includes(secret)) && !serialized.includes("password_hash"), "Response must contain no credentials");
    if (response.status >= 400) assert.ok(!serialized.includes("%PDF") && !serialized.includes("synthetic-private-driver-detail") && !serialized.includes("Synthetic Hospital"), "Errors must not disclose file or medical metadata");
    return { response, value };
  }
  function form(bytes: Buffer = pdf, name = "report.pdf", mime = "application/pdf", fields: Record<string, string> = {}) {
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
    body.append("category", fields.category ?? "lab_report");
    body.append("hospital_name", fields.hospital_name ?? "Synthetic Hospital");
    for (const [key, value] of Object.entries(fields)) if (!["category", "hospital_name"].includes(key)) body.append(key, value);
    return body;
  }
  async function upload(base: string, bytes = pdf, name = "report.pdf", mime = "application/pdf", fields: Record<string, string> = {}, token = tokenA) {
    return send(base, "/api/v1/documents", "POST", form(bytes, name, mime, fields), token);
  }
  function brokenDatabase(mode: "insert" | "uncertain" | "committed"): PatientDatabase {
    return { async query<Row extends QueryResultRow>(sql: string, values: unknown[]): Promise<{ rows: Row[] }> {
      if (sql.includes("INSERT INTO public.medical_documents")) {
        if (mode === "committed") await pool.query(sql, values);
        throw new Error("synthetic-private-driver-detail");
      }
      if (mode === "uncertain" && sql.includes("s3_object_key")) throw new Error("synthetic-private-driver-detail");
      return pool.query<Row>(sql, values);
    } };
  }
  try {
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE email = ANY($1::text[])", [emails])).rows[0].n, 0);
    cleanup = true;
    const base = await listen();
    for (const [index, email] of emails.entries()) {
      const register = await send(base, "/api/v1/auth/register", "POST", JSON.stringify({ email, password, full_name: "Synthetic Document Patient" }), undefined, { "Content-Type": "application/json" });
      assert.equal(register.response.status, 201);
      const login = await send(base, "/api/v1/auth/login", "POST", JSON.stringify({ email, password }), undefined, { "Content-Type": "application/json" });
      assert.equal(login.response.status, 200);
      if (index === 0) { patientA = register.value.patient.id; tokenA = login.value.access_token; }
      else { patientB = register.value.patient.id; tokenB = login.value.access_token; }
    }
    await t.test("all document operations require a valid JWT before storage access", async () => {
      for (const [method, path] of [["GET", "/api/v1/documents"], ["POST", "/api/v1/documents"],
        ["GET", "/api/v1/documents/" + randomUUID()], ["PATCH", "/api/v1/documents/" + randomUUID()],
        ["GET", "/api/v1/documents/" + randomUUID() + "/download"]]) {
        assert.equal((await send(base, path, method)).response.status, 401);
      }
      assert.equal((await send(base, "/api/v1/documents", "GET", undefined, "invalid")).response.status, 401);
      assert.equal(storage.puts, 0);
    });
    await t.test("authorized PDF upload validates and stores original bytes and processing metadata", async () => {
      const result = await upload(base, pdf, "report.pdf", "application/pdf", { document_date: "2000-01-01" });
      assert.equal(result.response.status, 201);
      const row = result.value.document; records.push(row.id);
      assert.equal(row.file_type, "pdf"); assert.equal(row.processing_status, "processing");
      assert.equal(row.hospital_name, "Synthetic Hospital"); assert.equal(row.document_date, "2000-01-01");
      assert.equal(row.sort_date_source, "document_date"); assert.equal(result.response.headers.get("cache-control"), "no-store");
      const db = (await pool.query("SELECT * FROM public.medical_documents WHERE id = $1", [row.id])).rows[0];
      assert.equal(db.patient_id, patientA); assert.equal(db.s3_bucket, storage.bucket);
      assert.ok(validStorageReference(storage, db.s3_bucket, db.s3_object_key));
      assert.ok(storage.objects.get(db.s3_object_key)?.equals(pdf));
      assert.ok(!JSON.stringify(row).includes("s3_") && !JSON.stringify(row).includes(patientA));
    });
    await t.test("authorized JPG, JPEG and PNG uploads receive full decoder validation", async () => {
      for (const [bytes, name, mime] of [[jpeg, "report.jpg", "image/jpeg"], [jpeg, "report.jpeg", "image/jpeg"], [png, "report.png", "image/png"]] as const) {
        const result = await upload(base, bytes, name, mime, { category: "prescription", hospital_name: "Second Synthetic Hospital" });
        assert.equal(result.response.status, 201); records.push(result.value.document.id);
        assert.equal(result.value.document.sort_date_source, "uploaded_at");
      }
    });
    await t.test("unsupported extensions, spoofed MIME and signature/type mismatch are rejected", async () => {
      const before = storage.puts;
      assert.equal((await upload(base, pdf, "report.exe", "application/pdf")).response.status, 415);
      assert.equal((await upload(base, pdf, "report.pdf", "image/png")).response.status, 415);
      assert.equal((await upload(base, png, "report.pdf", "application/pdf")).response.status, 422);
      assert.equal((await upload(base, pdf, "report.jpg", "image/jpeg")).response.status, 422);
      assert.equal(storage.puts, before);
    });
    await t.test("malformed PDF and header-only/corrupted images are rejected before S3", async () => {
      const before = storage.puts;
      for (const [bytes, name, mime] of [[Buffer.from("%PDF-1.7\ngarbage\n%%EOF\n"), "bad.pdf", "application/pdf"],
        [Buffer.concat([png.subarray(0, 8), Buffer.from("corrupt"), png.subarray(-12)]), "bad.png", "image/png"],
        [Buffer.from([255, 216, 255, 0, 0, 255, 217]), "bad.jpg", "image/jpeg"]] as const) {
        assert.equal((await upload(base, bytes, name, mime)).response.status, 422);
      }
      assert.equal(storage.puts, before);
    });
    await t.test("PDF active JavaScript is rejected without executing it", async () => {
      assert.equal((await upload(base, syntheticPdf(true))).response.status, 422);
    });
    await t.test("empty and oversized files are rejected without storage writes", async () => {
      const before = storage.puts;
      assert.equal((await upload(base, Buffer.alloc(0))).response.status, 400);
      assert.equal((await upload(base, Buffer.alloc(config.maxFileBytes + 1))).response.status, 413);
      assert.equal(storage.puts, before);
    });
    await t.test("required metadata, calendar dates, categories and forbidden ownership are validated", async () => {
      for (const fields of [{ category: "invalid" }, { hospital_name: " " }, { document_date: "2025-02-30" },
        { patient_id: patientB }, { s3_object_key: "../outside" }, { processing_status: "completed" }] as Record<string, string>[]) {
        assert.equal((await upload(base, pdf, "report.pdf", "application/pdf", fields)).response.status, 400);
      }
      const missing = new FormData(); missing.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "report.pdf");
      assert.equal((await send(base, "/api/v1/documents", "POST", missing, tokenA)).response.status, 400);
    });
    await t.test("filenames are sanitized and never determine S3 paths", async () => {
      const result = await upload(base, pdf, "../../private\\patient-name.pdf");
      assert.equal(result.response.status, 201); records.push(result.value.document.id);
      assert.equal(result.value.document.original_filename, "patient-name.pdf");
      const row = (await pool.query("SELECT s3_object_key FROM public.medical_documents WHERE id=$1", [result.value.document.id])).rows[0];
      assert.ok(!row.s3_object_key.includes("patient-name") && !row.s3_object_key.includes(patientA) && !row.s3_object_key.includes(emails[0]));
    });
    await t.test("malformed multipart, duplicate/extra parts, missing file and wrong media type are safe", async () => {
      assert.equal((await send(base, "/api/v1/documents", "POST", "not multipart", tokenA, { "Content-Type": "multipart/form-data; boundary=synthetic" })).response.status, 400);
      assert.equal((await send(base, "/api/v1/documents", "POST", "{}", tokenA, { "Content-Type": "application/json" })).response.status, 415);
      const duplicate = form(); duplicate.append("category", "lab_report");
      assert.equal((await send(base, "/api/v1/documents", "POST", duplicate, tokenA)).response.status, 400);
      const two = form(); two.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "second.pdf");
      assert.equal((await send(base, "/api/v1/documents", "POST", two, tokenA)).response.status, 400);
      const noFile = new FormData(); noFile.append("category", "lab_report"); noFile.append("hospital_name", "Synthetic Hospital");
      assert.equal((await send(base, "/api/v1/documents", "POST", noFile, tokenA)).response.status, 400);
    });
    await t.test("listings, detail and download do not expose other patients or record existence", async () => {
      const other = await upload(base, png, "other.png", "image/png", {}, tokenB);
      assert.equal(other.response.status, 201);
      const mine = await send(base, "/api/v1/documents", "GET", undefined, tokenA);
      assert.equal(mine.response.status, 200); assert.equal(mine.value.documents.length, records.length);
      assert.ok(!mine.value.documents.some((row: { id: string }) => row.id === other.value.document.id));
      const first = await send(base, "/api/v1/documents/" + records[0], "GET", undefined, tokenA);
      assert.equal(first.response.status, 200);
      for (const suffix of ["", "/download"]) {
        const foreign = await send(base, "/api/v1/documents/" + records[0] + suffix, "GET", undefined, tokenB);
        const absent = await send(base, "/api/v1/documents/" + randomUUID() + suffix, "GET", undefined, tokenB);
        assert.equal(foreign.response.status, 404); assert.deepEqual(foreign.value, absent.value);
      }
      assert.equal(storage.downloads, 0);
    });
    await t.test("category, hospital and inclusive UTC upload-date filters remain patient-scoped", async () => {
      const category = await send(base, "/api/v1/documents?category=prescription&hospital=second%20synthetic%20hospital", "GET", undefined, tokenA);
      assert.equal(category.response.status, 200); assert.equal(category.value.documents.length, 3);
      const today = new Date().toISOString().slice(0, 10);
      const dates = await send(base, "/api/v1/documents?uploaded_from=" + today + "&uploaded_to=" + today, "GET", undefined, tokenA);
      assert.equal(dates.value.documents.length, records.length);
      const empty = await send(base, "/api/v1/documents?uploaded_from=1990-01-01&uploaded_to=1990-01-01", "GET", undefined, tokenA);
      assert.equal(empty.value.documents.length, 0);
    });
    await t.test("chronology, fallback labels and deterministic pagination use existing metadata", async () => {
      const first = await send(base, "/api/v1/documents?limit=2&offset=0", "GET", undefined, tokenA);
      const second = await send(base, "/api/v1/documents?limit=2&offset=2", "GET", undefined, tokenA);
      assert.equal(first.value.documents.length, 2); assert.equal(first.value.pagination.has_more, true);
      assert.ok(first.value.documents.every((row: { sort_date_source: string }) => row.sort_date_source === "uploaded_at"));
      assert.equal(new Set([...first.value.documents, ...second.value.documents].map(row => row.id)).size, 4);
      const again = await send(base, "/api/v1/documents?limit=2&offset=0", "GET", undefined, tokenA);
      assert.deepEqual(first.value, again.value);
      const full = await send(base, "/api/v1/documents", "GET", undefined, tokenA);
      assert.equal(full.value.documents.at(-1).id, records[0]);
    });
    await t.test("invalid pagination/query filters and hostile SQL-looking hospital input are safe", async () => {
      for (const query of ["limit=0", "limit=101", "limit=1&limit=2", "offset=-1", "offset=10001", "category=invalid",
        "patient_id=" + patientB, "uploaded_from=2025-02-30", "uploaded_from=2020-02-01&uploaded_to=2020-01-01"]) {
        assert.equal((await send(base, "/api/v1/documents?" + query, "GET", undefined, tokenA)).response.status, 400);
      }
      const safe = await send(base, "/api/v1/documents?hospital=" + encodeURIComponent("' OR 1=1 --"), "GET", undefined, tokenA);
      assert.equal(safe.response.status, 200); assert.equal(safe.value.documents.length, 0);
    });
    await t.test("metadata updates change only allowed fields and preserve factual upload metadata", async () => {
      const before = (await send(base, "/api/v1/documents/" + records[0], "GET", undefined, tokenA)).value.document;
      const changed = await send(base, "/api/v1/documents/" + records[0], "PATCH", JSON.stringify({ category: "other_medical_document", hospital_name: "Updated Synthetic Hospital", document_date: null }), tokenA, { "Content-Type": "application/json" });
      assert.equal(changed.response.status, 200); assert.equal(changed.value.document.document_date, null);
      assert.equal(changed.value.document.uploaded_at, before.uploaded_at); assert.equal(changed.value.document.processing_status, "processing");
      assert.equal(changed.value.document.original_filename, before.original_filename);
      const denied = await send(base, "/api/v1/documents/" + records[0], "PATCH", JSON.stringify({ hospital_name: "Intruder" }), tokenB, { "Content-Type": "application/json" });
      assert.equal(denied.response.status, 404);
    });
    await t.test("forbidden metadata fields and invalid patch bodies are rejected", async () => {
      for (const field of ["id", "patient_id", "s3_bucket", "s3_object_key", "processing_status", "uploaded_at", "file_type", "original_filename", "unknown"]) {
        const result = await send(base, "/api/v1/documents/" + records[0], "PATCH", JSON.stringify({ [field]: "forbidden" }), tokenA, { "Content-Type": "application/json" });
        assert.equal(result.response.status, 400);
      }
      for (const body of [{}, [], { category: "invalid" }, { hospital_name: null }, { document_date: "2025-02-30" }]) {
        assert.equal((await send(base, "/api/v1/documents/" + records[0], "PATCH", JSON.stringify(body), tokenA, { "Content-Type": "application/json" })).response.status, 400);
      }
    });
    await t.test("authenticated downloads return original bytes without a reusable storage URL", async () => {
      const response=await fetch(base+"/api/v1/documents/"+records[0]+"/download",{headers:{Authorization:"Bearer "+tokenA}});
      assert.equal(response.status,200);
      assert.equal(response.headers.get("content-type"),"application/pdf");
      assert.equal(response.headers.get("cache-control"),"private, no-store");
      assert.equal(response.headers.get("location"),null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
      storage.failDownload = true;
      try { assert.equal((await send(base, "/api/v1/documents/" + records[0] + "/download", "GET", undefined, tokenA)).response.status, 503); }
      finally { storage.failDownload = false; }
    });
    await t.test("foreign buckets and traversal-like stored keys never reach file storage", async () => {
      const row = (await pool.query("SELECT s3_bucket, s3_object_key FROM public.medical_documents WHERE id=$1", [records[0]])).rows[0];
      const count = storage.downloads;
      try {
        await pool.query("UPDATE public.medical_documents SET s3_object_key=$1 WHERE id=$2", ["../unrelated/file.pdf", records[0]]);
        assert.equal((await send(base, "/api/v1/documents/" + records[0] + "/download", "GET", undefined, tokenA)).response.status, 503);
        await pool.query("UPDATE public.medical_documents SET s3_bucket=$1, s3_object_key=$2 WHERE id=$3", ["foreign-private-bucket", row.s3_object_key, records[0]]);
        assert.equal((await send(base, "/api/v1/documents/" + records[0] + "/download", "GET", undefined, tokenA)).response.status, 503);
      } finally { await pool.query("UPDATE public.medical_documents SET s3_bucket=$1, s3_object_key=$2 WHERE id=$3", [row.s3_bucket, row.s3_object_key, records[0]]); }
      assert.equal(storage.downloads, count);
    });
    await t.test("S3 failures before and after a possible write create no metadata or stray object", async () => {
      const before = storage.objects.size;
      for (const mode of ["before", "after"] as const) {
        storage.failPut = mode;
        try { assert.equal((await upload(base, png, "failure.png", "image/png")).response.status, 503); }
        finally { storage.failPut = null; }
        assert.equal(storage.objects.size, before);
      }
    });
    await t.test("database insertion failure compensates the newly written S3 object", async () => {
      const broken = await listen({ documentDatabase: brokenDatabase("insert") });
      const before = storage.objects.size; const removes = storage.removes;
      assert.equal((await upload(broken, png, "failure.png", "image/png")).response.status, 503);
      assert.equal(storage.objects.size, before); assert.equal(storage.removes, removes + 1);
    });
    await t.test("bounded cleanup retries recover a temporary deletion failure", async () => {
      const broken = await listen({ documentDatabase: brokenDatabase("insert") });
      const removes = storage.removes; const before = storage.objects.size;
      storage.removeFailures = 1;
      assert.equal((await upload(broken, png, "retry.png", "image/png")).response.status, 503);
      assert.equal(storage.removes, removes + 2); assert.equal(storage.objects.size, before);
    });
    await t.test("cleanup exhaustion returns failure, stops retrying and logs no private details", async () => {
      const broken = await listen({ documentDatabase: brokenDatabase("insert") });
      const removes = storage.removes; const keys = new Set(storage.objects.keys());
      storage.removeFailures = 2;
      const messages: string[] = []; const original = console.error;
      console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
      try { assert.equal((await upload(broken, png, "sensitive-name.png", "image/png")).response.status, 503); }
      finally { console.error = original; }
      assert.equal(storage.removes, removes + 2);
      assert.deepEqual(messages, ["A new unlinked private upload requires storage reconciliation."]);
      for (const key of storage.objects.keys()) if (!keys.has(key)) storage.objects.delete(key); // Fake-only reconciliation; never touches AWS.
    });
    await t.test("ambiguous committed database results preserve the linked original", async () => {
      const recovered = await listen({ documentDatabase: brokenDatabase("committed") });
      const removes = storage.removes;
      const result = await upload(recovered, png, "committed.png", "image/png");
      assert.equal(result.response.status, 201); assert.equal(storage.removes, removes); records.push(result.value.document.id);
    });
    await t.test("uncertain database outcome preserves private object rather than deleting possibly linked data", async () => {
      const broken = await listen({ documentDatabase: brokenDatabase("uncertain") });
      const removes = storage.removes; const keys = new Set(storage.objects.keys());
      const original = console.error; const messages: string[] = [];
      console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
      try { assert.equal((await upload(broken, png, "uncertain.png", "image/png")).response.status, 503); }
      finally { console.error = original; }
      assert.equal(storage.removes, removes);
      assert.deepEqual(messages, ["A private upload has an uncertain database outcome and requires reconciliation."]);
      for (const key of storage.objects.keys()) if (!keys.has(key)) storage.objects.delete(key);
    });
    await t.test("client abort after S3 write compensates before metadata insertion", async () => {
      const controller = new AbortController();
      storage.putHook = async () => { controller.abort(); };
      const path = (await import("node:fs/promises")).mkdtemp;
      const directory = await path(tmpdir() + "/health-wallet-abort-test-");
      const { writeFile, rm } = await import("node:fs/promises");
      const file = directory + "/fake.png";
      await writeFile(file, png, { mode: 0o600 });
      const before = storage.objects.size;
      try {
        const service = createDocumentService(createDocumentRepository(pool), storage);
        await assert.rejects(service.upload({ path: file, name: "abort.png", type: "png", mime: "image/png", bytes: png.length,
          checksum: "synthetic", metadata: { category: "lab_report", hospital_name: "Synthetic Hospital" }, async dispose() {} }, patientA, controller.signal));
        assert.equal(storage.objects.size, before);
      } finally { storage.putHook = undefined; await rm(directory, { recursive: true, force: true }); }
    });
    await t.test("aborted multipart HTTP uploads clean up temporary files without storage writes", async () => {
      const before = storage.puts;
      await new Promise<void>(resolve => {
        const request = httpRequest(base + "/api/v1/documents", { method: "POST", headers: {
          Authorization: "Bearer " + tokenA, "Content-Type": "multipart/form-data; boundary=synthetic-abort" } });
        request.on("error", () => resolve());
        request.write('--synthetic-abort\r\nContent-Disposition: form-data; name="file"; filename="abort.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n');
        setTimeout(() => { request.destroy(); resolve(); }, 100);
      });
      await delay(100);
      assert.equal(storage.puts, before);
    });
    await t.test("exact upload byte limit is accepted while decoder pixel and worker deadlines fail closed", async () => {
      const exact = await listen({ documentConfig: { ...config, maxFileBytes: png.length } });
      const result = await upload(exact, png, "exact.png", "image/png");
      assert.equal(result.response.status, 201); records.push(result.value.document.id);
      const pixels = await listen({ documentConfig: { ...config, maxImagePixels: 4 } });
      assert.equal((await upload(pixels, png, "pixels.png", "image/png")).response.status, 422);
      const deadline = await listen({ documentConfig: { ...config, validationTimeoutMs: 1 } });
      assert.equal((await upload(deadline, png, "deadline.png", "image/png")).response.status, 422);
    });
    await t.test("concurrent uploads are bounded across parsing, validation and storage", async () => {
      const limitedStorage = new FakeStorage();
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      limitedStorage.putHook = async () => { enter(); await gate; };
      const limited = await listen({ documentConfig: { ...config, maxConcurrentUploads: 1 }, documentStorage: limitedStorage });
      const first = upload(limited, png, "first.png", "image/png");
      try {
        await entered;
        const rejected = await upload(limited, png, "second.png", "image/png");
        assert.equal(rejected.response.status, 503); assert.equal(rejected.value.error.code, "UPLOAD_BUSY");
      } finally { release(); }
      const result = await first; assert.equal(result.response.status, 201); records.push(result.value.document.id);
      limitedStorage.objects.clear();
    });
    await t.test("slow multipart uploads have a bounded deadline and never reach S3", async () => {
      const limited = await listen({ documentConfig: { ...config, uploadTimeoutMs: 50 } });
      const before = storage.puts;
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(limited + "/api/v1/documents", { method: "POST", headers: {
          Authorization: "Bearer " + tokenA, "Content-Type": "multipart/form-data; boundary=synthetic-slow" } });
        const timer = setTimeout(() => { request.destroy(); reject(new Error("Upload deadline was not enforced")); }, 3000);
        request.on("response", response => {
          response.resume(); response.on("end", () => { clearTimeout(timer); request.destroy(); resolve(response.statusCode!); });
        });
        request.on("error", error => { clearTimeout(timer); reject(error); });
        request.write('--synthetic-slow\r\nContent-Disposition: form-data; name="file"; filename="slow.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n');
      });
      assert.equal(status, 400); assert.equal(storage.puts, before);
    });
    await t.test("upload rate limits cannot be bypassed through forwarded IP headers", async () => {
      const limited = await listen({ documentConfig: { ...config, uploadRateLimitMax: 1 } });
      const first = await send(limited, "/api/v1/documents", "POST", "{}", tokenA, { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.1" });
      assert.equal(first.response.status, 415);
      const second = await send(limited, "/api/v1/documents", "POST", "{}", tokenA, { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.2" });
      assert.equal(second.response.status, 429); assert.ok(second.response.headers.get("retry-after"));
    });
    await t.test("disabled live storage fails safely while metadata and existing auth/health routes work", async () => {
      const disabled = await listen({ documentStorage: null });
      assert.equal((await upload(disabled, png, "disabled.png", "image/png")).response.status, 503);
      assert.equal((await send(disabled, "/api/v1/documents", "GET", undefined, tokenA)).response.status, 200);
      assert.equal((await send(base, "/api/v1/patients/me", "GET", undefined, tokenA)).response.status, 200);
      for (const route of ["/api/v1/health", "/api/v1/health/db"]) assert.equal((await send(base, route)).response.status, 200);
    });
    await t.test("permanent deletion remains unimplemented pending SRS retention policy", async () => {
      assert.equal((await send(base, "/api/v1/documents/" + records[0], "DELETE", undefined, tokenA)).response.status, 404);
      assert.equal((await send(base, "/api/v1/documents/" + records[0], "GET", undefined, tokenA)).response.status, 200);
    });
    await t.test("repeated accepted uploads are distinct owner-bound records with one job each", async () => {
      const a=await upload(base,png,"repeat.png","image/png");
      const b=await upload(base,png,"repeat.png","image/png");
      assert.equal(a.response.status,201);assert.equal(b.response.status,201);
      const ids=[a.value.document.id,b.value.document.id];records.push(...ids);
      assert.notEqual(ids[0],ids[1]);
      for(const id of ids){
        const jobs=await pool.query("SELECT patient_id, state FROM public.document_processing_jobs WHERE document_id=$1",[id]);
        assert.equal(jobs.rows.length,1);assert.equal(jobs.rows[0].patient_id,patientA);assert.equal(jobs.rows[0].state,"pending");
      }
    });
    await t.test("all temporary upload files are removed", async () => {
      let remaining: string[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        remaining = (await readdir(tmpdir())).filter(name => name.startsWith("health-wallet-upload-") && !baselineTemps.has(name));
        if (!remaining.length) break;
        await delay(100);
      }
      assert.deepEqual(remaining, []);
    });
  } finally {
    try { await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); }
    finally {
      try {
        if (cleanup) {
          // Exact random synthetic identities only; no broad delete and no real S3 calls.
          await pool.query("DELETE FROM public.medical_documents WHERE patient_id IN (SELECT id FROM public.patients WHERE email = ANY($1::text[]))", [emails]);
          await pool.query("DELETE FROM public.patients WHERE email = ANY($1::text[])", [emails]);
          assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE email = ANY($1::text[])", [emails])).rows[0].n, 0);
        }
        storage.objects.clear();
      } finally { await closeDatabasePool(); }
    }
  }
});

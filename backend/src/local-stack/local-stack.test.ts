// Stage 1 of the R3-stack work: local file storage refusals and safety, loopback-origin allowlist, local-stack guard.
// No database or network beyond a loopback test server. Synthetic bytes only. Run: npm run local-stack:test
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat, symlink, chmod, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import express from "express";
import cors from "cors";
import { localStorageConfig, createLocalStorage, LocalStorageRefused } from "../documents/local-storage.js";
import { getDocumentConfig, DocumentConfigurationError } from "../config/documents.js";
import { allowedOrigins, corsOriginCheck, LOCAL_WEB_ORIGINS } from "../http/origins.js";
import { assertLocalStack, LocalStackRefused } from "./guard.js";
import { StorageFailure } from "../documents/storage-safety.js";

const scratch: string[] = [];
const folder = async () => { const d = await mkdtemp(join(tmpdir(), "hw-ls-test-")); scratch.push(d); return d; };
after(async () => { for (const d of scratch) await rm(d, { recursive: true, force: true }); });
const base = (dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "development", DOCUMENT_STORAGE_LOCAL_DIR: dir, DOCUMENT_STORAGE_LOCAL_SYNTHETIC_ONLY: "true", ...extra });
const key = () => "medical-documents/" + randomUUID() + ".pdf";
const sha64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");
const refused = (fn: () => unknown) => assert.throws(fn, LocalStorageRefused);

test("LS-01 local storage is off unless a folder is requested", () => {
  assert.equal(localStorageConfig({ NODE_ENV: "production" }), null);
  assert.equal(localStorageConfig({ NODE_ENV: "development", DOCUMENT_STORAGE_LOCAL_DIR: "" }), null);
});
test("LS-02 refuses to start in staging, production, test or when NODE_ENV is missing", async () => {
  const dir = await folder();
  for (const env of ["staging", "production", "test", "prod", ""]) refused(() => localStorageConfig(base(dir, { NODE_ENV: env })));
  const noEnv = base(dir); delete noEnv.NODE_ENV; refused(() => localStorageConfig(noEnv));
  assert.ok(localStorageConfig(base(dir)));
  assert.ok(localStorageConfig(base(dir, { NODE_ENV: "local" })));
});
test("LS-03 the real configuration loader also refuses staging and production", async () => {
  const dir = await folder(); const saved = { ...process.env };
  try {
    // Loading the configuration module can read backend/.env; start from a clean slate so this test never depends on it.
    for (const k of Object.keys(process.env)) if (/^(AWS_|S3_)/.test(k) || k === "DOCUMENT_STORAGE_ENABLED") delete process.env[k];
    for (const env of ["staging", "production"]) {
      Object.assign(process.env, base(dir, { NODE_ENV: env }));
      assert.throws(() => getDocumentConfig(), DocumentConfigurationError);
    }
    Object.assign(process.env, base(dir));
    assert.equal(getDocumentConfig().localStorage?.directory, dir);
    assert.equal(getDocumentConfig().storage, null, "local mode never produces an S3 configuration");
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
test("LS-04 refuses when any AWS or S3 setting is present, or S3 storage is enabled", async () => {
  const dir = await folder();
  for (const name of ["AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL", "S3_BUCKET", "S3_DOCUMENT_PREFIX", "S3_BUCKET_OWNER_ACCOUNT_ID"]) {
    refused(() => localStorageConfig(base(dir, { [name]: "x" })));
  }
  refused(() => localStorageConfig(base(dir, { DOCUMENT_STORAGE_ENABLED: "true" })));
  assert.ok(localStorageConfig(base(dir, { AWS_REGION: "", S3_BUCKET: "" })), "empty values are not settings");
});
test("LS-05 requires the synthetic-only acknowledgement and a safe absolute folder outside the repository", async () => {
  const dir = await folder();
  const noAck = base(dir); delete noAck.DOCUMENT_STORAGE_LOCAL_SYNTHETIC_ONLY; refused(() => localStorageConfig(noAck));
  refused(() => localStorageConfig(base(dir, { DOCUMENT_STORAGE_LOCAL_SYNTHETIC_ONLY: "yes" })));
  for (const bad of ["relative/path", "./x", dir + "/../x", dir + "/", "/tmp/a\nb"]) refused(() => localStorageConfig(base(bad)));
  const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
  refused(() => localStorageConfig(base(repo + "/local-stack/data")));
  refused(() => localStorageConfig(base(repo)));
});
test("LS-06 folder rules: owner-only, real folder, synthetic marker", async () => {
  const loose = await folder(); await chmod(loose, 0o755);
  assert.throws(() => createLocalStorage(localStorageConfig(base(loose))!), LocalStorageRefused);
  const real = await folder(); const link = join(await folder(), "link"); await symlink(real, link);
  assert.throws(() => createLocalStorage(localStorageConfig(base(link))!), LocalStorageRefused);
  const foreign = await folder(); await chmod(foreign, 0o700); await writeFile(join(foreign, ".synthetic-only-local-storage"), "something else\n");
  assert.throws(() => createLocalStorage(localStorageConfig(base(foreign))!), LocalStorageRefused);
  const fresh = join(await folder(), "files");
  createLocalStorage(localStorageConfig(base(fresh))!);
  assert.equal((await stat(fresh)).mode & 0o777, 0o700);
  assert.equal((await stat(join(fresh, ".synthetic-only-local-storage"))).mode & 0o777, 0o600);
});
test("LS-07 store, read back and remove: owner-only files, same key shape as S3, bucket is clearly not S3", async () => {
  const dir = join(await folder(), "files"); const storage = createLocalStorage(localStorageConfig(base(dir))!);
  assert.equal(storage.bucket, "local-file-synthetic"); assert.equal(storage.prefix, "medical-documents/");
  const bytes = Buffer.from("%PDF-1.4 SYNTHETIC SAMPLE"); const source = join(await folder(), "in.pdf"); await writeFile(source, bytes);
  const k = key();
  await storage.put({ key: k, path: source, bytes: bytes.length, mime: "application/pdf", checksum: sha64(bytes), signal: AbortSignal.timeout(5000) });
  assert.equal((await stat(join(dir, k))).mode & 0o777, 0o600);
  const out = join(await folder(), "out.pdf");
  assert.deepEqual(await storage.readOriginal!({ key: k, type: "pdf", destination: out, maxBytes: 1024, timeoutMs: 5000, signal: AbortSignal.timeout(5000) }), { bytes: bytes.length });
  assert.deepEqual(await readFile(out), bytes);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  await storage.remove(k, undefined); await assert.rejects(stat(join(dir, k)));
  await storage.remove(k, undefined); // removing a missing object is not an error
});
test("LS-08 refuses keys that are not exactly the S3 key shape (traversal, wrong prefix, wrong extension, absolute)", async () => {
  const dir = join(await folder(), "files"); const storage = createLocalStorage(localStorageConfig(base(dir))!);
  const bytes = Buffer.from("x"); const source = join(await folder(), "in.pdf"); await writeFile(source, bytes);
  const id = randomUUID();
  for (const bad of ["../" + id + ".pdf", "medical-documents/../" + id + ".pdf", "/etc/passwd", "medical-documents/" + id + ".txt", "other/" + id + ".pdf",
    "medical-documents/" + id.toUpperCase() + ".pdf", "medical-documents/a/" + id + ".pdf", "medical-documents/" + id + ".pdf\0"]) {
    await assert.rejects(storage.put({ key: bad, path: source, bytes: 1, mime: "application/pdf", checksum: sha64(bytes), signal: AbortSignal.timeout(2000) }), StorageFailure, bad);
    await assert.rejects(storage.readOriginal!({ key: bad, type: "pdf", destination: join(await folder(), "o"), maxBytes: 100, timeoutMs: 1000, signal: AbortSignal.timeout(2000) }), bad);
    await assert.rejects(storage.remove(bad, undefined), StorageFailure, bad);
  }
  await assert.rejects(storage.download(key(), "a.pdf", "pdf", 60), StorageFailure, "no pre-signed URLs locally");
});
test("LS-09 a wrong checksum or size leaves nothing behind, and an existing object is never overwritten", async () => {
  const dir = join(await folder(), "files"); const storage = createLocalStorage(localStorageConfig(base(dir))!);
  const bytes = Buffer.from("%PDF synthetic one"); const source = join(await folder(), "in.pdf"); await writeFile(source, bytes);
  const k = key();
  await assert.rejects(storage.put({ key: k, path: source, bytes: bytes.length, mime: "application/pdf", checksum: sha64(Buffer.from("other")), signal: AbortSignal.timeout(3000) }));
  await assert.rejects(stat(join(dir, k)), "partial file removed");
  await assert.rejects(storage.put({ key: k, path: source, bytes: bytes.length + 1, mime: "application/pdf", checksum: sha64(bytes), signal: AbortSignal.timeout(3000) }));
  await assert.rejects(stat(join(dir, k)));
  await storage.put({ key: k, path: source, bytes: bytes.length, mime: "application/pdf", checksum: sha64(bytes), signal: AbortSignal.timeout(3000) });
  const second = join(await folder(), "two.pdf"); await writeFile(second, "%PDF synthetic two");
  await assert.rejects(storage.put({ key: k, path: second, bytes: 18, mime: "application/pdf", checksum: sha64(Buffer.from("%PDF synthetic two")), signal: AbortSignal.timeout(3000) }));
  assert.deepEqual(await readFile(join(dir, k)), bytes, "original untouched");
});
test("LS-10 reading refuses symlinks, loose permissions and oversize objects", async () => {
  const dir = join(await folder(), "files"); const storage = createLocalStorage(localStorageConfig(base(dir))!);
  const bytes = Buffer.from("%PDF synthetic"); const source = join(await folder(), "in.pdf"); await writeFile(source, bytes);
  const read = async (k: string, maxBytes = 1024) => storage.readOriginal!({ key: k, type: "pdf", destination: join(await folder(), "o.pdf"), maxBytes, timeoutMs: 3000, signal: AbortSignal.timeout(4000) });
  const k1 = key(); await storage.put({ key: k1, path: source, bytes: bytes.length, mime: "application/pdf", checksum: sha64(bytes), signal: AbortSignal.timeout(3000) });
  await assert.rejects(read(k1, 4), "bigger than the allowed size");
  await chmod(join(dir, k1), 0o644); await assert.rejects(read(k1), "group/world readable");
  const k2 = key(); await symlink(source, join(dir, k2)); await assert.rejects(read(k2), "symlink");
  await assert.rejects(read(key()), "missing");
  assert.ok((await readdir(dir)).length >= 1);
});
test("LS-11 origins: production keeps the single FRONTEND_ORIGIN; local mode allows only the exact loopback list", () => {
  assert.deepEqual(allowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGIN: "https://app.example.invalid" }), ["https://app.example.invalid"]);
  assert.deepEqual(allowedOrigins({ NODE_ENV: "staging", FRONTEND_ORIGIN: "https://app.example.invalid" }), ["https://app.example.invalid"]);
  assert.deepEqual(allowedOrigins({ FRONTEND_ORIGIN: "https://app.example.invalid" }), ["https://app.example.invalid"]);
  const local = allowedOrigins({ NODE_ENV: "development", FRONTEND_ORIGIN: "http://127.0.0.1:5173" });
  for (const o of LOCAL_WEB_ORIGINS) assert.ok(local.includes(o));
  assert.ok(!local.some(o => o.includes("*")), "no wildcards");
  assert.ok(LOCAL_WEB_ORIGINS.every(o => /^http:\/\/(127\.0\.0\.1|localhost):\d{4}$/.test(o)), "loopback only");
  assert.equal(LOCAL_WEB_ORIGINS.length, 4);
});
test("LS-12 over real HTTP: listed origins get CORS headers; non-listed or non-loopback origins do not (local and production)", async () => {
  const serve = async (env: NodeJS.ProcessEnv) => {
    const app = express(); app.use(cors({ origin: corsOriginCheck(env) })); app.get("/x", (_q, r) => { r.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    return { server, url: "http://127.0.0.1:" + (server.address() as { port: number }).port };
  };
  const probe = async (url: string, origin: string, preflight = false) => {
    const r = await fetch(url + "/x", { method: preflight ? "OPTIONS" : "GET", headers: { Origin: origin, ...(preflight ? { "Access-Control-Request-Method": "GET" } : {}) } });
    return r.headers.get("access-control-allow-origin");
  };
  const local = await serve({ NODE_ENV: "development", FRONTEND_ORIGIN: "http://127.0.0.1:5173" });
  const prod = await serve({ NODE_ENV: "production", FRONTEND_ORIGIN: "https://app.example.invalid" });
  try {
    for (const o of LOCAL_WEB_ORIGINS) { assert.equal(await probe(local.url, o), o); assert.equal(await probe(local.url, o, true), o); }
    for (const bad of ["http://evil.example", "https://127.0.0.1:5173", "http://127.0.0.1:9999", "http://127.0.0.1.evil.example:5173", "http://localhost:5173",
      "http://192.168.1.5:5173", "http://0.0.0.0:5173", "http://[::1]:5173", "null", "http://127.0.0.1:5173/"]) {
      assert.equal(await probe(local.url, bad), null, bad); assert.equal(await probe(local.url, bad, true), null, bad);
    }
    assert.equal(await probe(prod.url, "https://app.example.invalid"), "https://app.example.invalid");
    for (const o of LOCAL_WEB_ORIGINS) assert.equal(await probe(prod.url, o), null, "production refuses local origins: " + o);
  } finally { local.server.closeAllConnections(); prod.server.closeAllConnections(); local.server.close(); prod.server.close(); }
});
test("LS-13 the app really uses the allowlist and has no wildcard origin", async () => {
  const app = await readFile(new URL("../app.ts", import.meta.url), "utf8");
  assert.match(app, /cors\(\{ origin: corsOriginCheck\(\) \}\)/);
  const origins = await readFile(new URL("../http/origins.ts", import.meta.url), "utf8");
  assert.ok(!/origin:\s*(true|"\*")/.test(origins) && !/["']\*["']/.test(origins.replace(/\/\/.*$/gm, "")));
});
test("LS-14 local-stack tools refuse outside the generated local environment", () => {
  const good = { HW_LOCAL_STACK: "1", NODE_ENV: "development", DB_HOST: "/home/u/.local/share/hw-local-stack/pg/sock" };
  assert.doesNotThrow(() => assertLocalStack(good));
  assert.doesNotThrow(() => assertLocalStack({ ...good, NODE_ENV: "local", DB_HOST: "127.0.0.1" }));
  for (const bad of [{ HW_LOCAL_STACK: "0" }, { NODE_ENV: "production" }, { NODE_ENV: "staging" }, { AWS_REGION: "ap-southeast-2" }, { S3_BUCKET: "b" },
    { DB_HOST: "db.example.invalid" }, { DB_HOST: "10.0.0.5" }, { DB_HOST: "" }]) {
    assert.throws(() => assertLocalStack({ ...good, ...bad }), LocalStackRefused, JSON.stringify(Object.keys(bad)));
  }
});
test("LS-15 HW_LOCAL_STACK=1 keeps backend/.env from being read (booleans only; no values printed)", () => {
  const probe = (flag: string) => spawnSync(process.execPath, ["--import", "tsx", "-e",
    "await import('./src/config/env.js'); console.log(JSON.stringify({db: process.env.DB_PASSWORD !== undefined, jwt: process.env.JWT_SECRET !== undefined}))"],
    { cwd: new URL("../../", import.meta.url).pathname, env: { PATH: process.env.PATH ?? "", HW_LOCAL_STACK: flag }, encoding: "utf8" });
  const on = JSON.parse(probe("1").stdout.trim());
  assert.deepEqual(on, { db: false, jwt: false });
});

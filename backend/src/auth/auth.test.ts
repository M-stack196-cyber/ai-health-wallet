import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import * as argon2 from "argon2";
import { SignJWT, decodeJwt } from "jose";
import { parse } from "dotenv";
import { createApp } from "../app.js";
import { pool, closeDatabasePool } from "../database/pool.js";
import { getAuthenticationConfig, type AuthenticationConfig } from "../config/auth.js";
import { createPasswordService } from "./passwords.js";

interface Body {
  success?: boolean;
  patient?: { id: string; email: string; full_name: string; date_of_birth: string | null;
    phone_number: string | null; created_at: string; updated_at: string };
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { code: string; message: string };
  database?: string;
}

test("Phase 1.5 authentication and profile acceptance", { timeout: 90000 }, async (t) => {
  const configured = getAuthenticationConfig();
  const config: AuthenticationConfig = { ...configured, jwtKey: new Uint8Array(randomBytes(32)),
    jwtIssuer: "phase15-test-issuer", jwtAudience: "phase15-test-patient", rateLimitMax: 200 };
  const run = randomUUID();
  const emails = ["patient-a-", "patient-b-", "race-"].map(prefix => prefix + run + "@example.invalid");
  const password = randomBytes(24).toString("base64url");
  const wrongPassword = randomBytes(24).toString("base64url");
  const privateEnv = parse(await readFile(new URL("../../.env", import.meta.url)));
  const forbidden = [password, wrongPassword, privateEnv.JWT_SECRET, privateEnv.DB_PASSWORD].filter(Boolean);
  const servers: ReturnType<ReturnType<typeof createApp>["listen"]>[] = [];
  let cleanupAuthorized = false;
  let tokenA = "";
  let tokenB = "";
  let patientA = "";
  let patientB = "";

  async function listen(app: ReturnType<typeof createApp>): Promise<string> {
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return "http://127.0.0.1:" + address.port;
  }
  async function request(base: string, path: string, method = "GET", body?: unknown, token?: string, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers["Content-Type"] ??= "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const response: Response = await fetch(base + path, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await response.json() as Body;
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("password_hash") && !serialized.includes("$argon2")
      && !forbidden.some(value => serialized.includes(value)), "Response contains a sensitive value");
    return { response, data };
  }
  const register = (email: string) => ({ email, password, full_name: "Synthetic Patient", date_of_birth: "2000-02-29", phone_number: "+92 300 1234567" });
  async function signed(claims: Record<string, unknown> = {}, header = "HS256", key = config.jwtKey) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: patientA, iss: config.jwtIssuer, aud: config.jwtAudience,
      iat: now, exp: now + config.jwtLifetimeSeconds, ...claims })
      .setProtectedHeader({ alg: header, typ: "JWT" }).sign(key);
  }

  try {
    const existing = await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE email = ANY($1::text[])", [emails]);
    assert.equal(existing.rows[0].n, 0, "Synthetic identity namespace must be unused before cleanup is authorized");
    cleanupAuthorized = true;
    const base = await listen(createApp({ auth: config }));

    await t.test("runtime role is restricted before authentication operations", async () => {
      const result = await pool.query("SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      assert.deepEqual(result.rows[0], { role: "health_wallet_app", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    });
    await t.test("registration persists a sanitized patient with canonical unique email", async () => {
      const result = await request(base, "/api/v1/auth/register", "POST", register("  " + emails[0].toUpperCase() + "  "));
      assert.equal(result.response.status, 201);
      assert.equal(result.response.headers.get("cache-control"), "no-store");
      assert.ok(result.data.patient);
      patientA = result.data.patient.id;
      assert.equal(result.data.patient.email, emails[0]);
      assert.equal(result.data.patient.date_of_birth, "2000-02-29");
      assert.equal(result.data.patient.phone_number, "+92 300 1234567");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE id = $1", [patientA])).rows[0].n, 1);
    });
    await t.test("registration stores an Argon2id hash with configured cost, never plaintext", async () => {
      const stored = await pool.query("SELECT password_hash FROM public.patients WHERE id = $1", [patientA]);
      const hash: string = stored.rows[0].password_hash;
      assert.ok(hash.startsWith("$argon2id$"), "Expected an Argon2id PHC hash");
      assert.ok(hash !== password && !hash.includes(password), "Stored credential must not contain the password");
      assert.equal(await argon2.verify(hash, password), true);
      assert.equal(argon2.needsRehash(hash, { memoryCost: config.argonMemoryKiB, timeCost: config.argonTimeCost, parallelism: config.argonParallelism }), false);
    });
    await t.test("duplicate registration is rejected safely after email normalization", async () => {
      const duplicate = await request(base, "/api/v1/auth/register", "POST", register(emails[0].toUpperCase()));
      assert.equal(duplicate.response.status, 409);
      assert.equal(duplicate.data.error?.code, "REGISTRATION_CONFLICT");
      assert.ok(!JSON.stringify(duplicate.data).includes(emails[0]));
    });
    await t.test("invalid emails, weak passwords and malformed registration fields are rejected", async () => {
      for (const email of ["invalid", "a@", "a..b@example.invalid", "a@-invalid.test", "a@@example.invalid", 7, null]) {
        assert.equal((await request(base, "/api/v1/auth/register", "POST", { ...register(emails[0]), email })).response.status, 400);
      }
      for (const value of ["short", " ".repeat(20), "a".repeat(20), "long".repeat(40), null, 1234, "A valid phrase\u0000with null"]) {
        assert.equal((await request(base, "/api/v1/auth/register", "POST", { ...register(emails[0]), password: value })).response.status, 400);
      }
      for (const body of [null, [], {}, { email: emails[0], password }, { ...register(emails[0]), full_name: " " },
        { ...register(emails[0]), date_of_birth: "2025-02-30" }, { ...register(emails[0]), date_of_birth: "9999-01-01" },
        { ...register(emails[0]), phone_number: "not-a-phone" }, { ...register(emails[0]), password_hash: "forbidden" },
        { ...register(emails[0]), id: randomUUID() }]) {
        assert.equal((await request(base, "/api/v1/auth/register", "POST", body)).response.status, 400);
      }
    });
    await t.test("optional profile fields may be omitted on registration", async () => {
      const second = await request(base, "/api/v1/auth/register", "POST", { email: emails[1], password, full_name: "Synthetic Patient B" });
      assert.equal(second.response.status, 201);
      assert.ok(second.data.patient);
      patientB = second.data.patient.id;
      assert.equal(second.data.patient.date_of_birth, null);
      assert.equal(second.data.patient.phone_number, null);
    });
    await t.test("concurrent duplicate registrations rely on PostgreSQL uniqueness", async () => {
      const outcomes = await Promise.all([request(base, "/api/v1/auth/register", "POST", register(emails[2])),
        request(base, "/api/v1/auth/register", "POST", register(emails[2]))]);
      assert.deepEqual(outcomes.map(result => result.response.status).sort(), [201, 409]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE email = $1", [emails[2]])).rows[0].n, 1);
    });
    await t.test("successful login returns a signed, minimal, expiring JWT", async () => {
      const first = await request(base, "/api/v1/auth/login", "POST", { email: emails[0].toUpperCase(), password });
      const second = await request(base, "/api/v1/auth/login", "POST", { email: emails[1], password });
      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);
      assert.equal(typeof first.data.access_token, "string");
      assert.equal(typeof second.data.access_token, "string");
      tokenA = first.data.access_token!;
      tokenB = second.data.access_token!;
      assert.equal(first.data.token_type, "Bearer");
      assert.equal(first.data.expires_in, config.jwtLifetimeSeconds);
      const claims = decodeJwt(tokenA);
      assert.equal(claims.sub, patientA);
      assert.equal(claims.iss, config.jwtIssuer);
      assert.equal(claims.aud, config.jwtAudience);
      assert.equal(claims.exp! - claims.iat!, config.jwtLifetimeSeconds);
      assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "sub"]);
    });
    await t.test("wrong-password and unknown-user logins have identical generic errors", async () => {
      const wrong = await request(base, "/api/v1/auth/login", "POST", { email: emails[0], password: wrongPassword });
      const unknown = await request(base, "/api/v1/auth/login", "POST", { email: "missing-" + run + "@example.invalid", password: wrongPassword });
      assert.equal(wrong.response.status, 401);
      assert.equal(unknown.response.status, 401);
      assert.deepEqual(wrong.data, unknown.data);
      assert.equal(wrong.data.error?.message, "Invalid email or password.");
    });
    await t.test("login validates fields and does not accept SQL injection as an identity", async () => {
      for (const body of [{ email: emails[0] }, { email: emails[0], password: [] },
        { email: "' OR 1=1 --@example.invalid", password }, { email: emails[0], password, patient_id: patientB }]) {
        assert.equal((await request(base, "/api/v1/auth/login", "POST", body)).response.status, 400);
      }
    });
    await t.test("valid bearer token retrieves only its patient's sanitized profile", async () => {
      const result = await request(base, "/api/v1/patients/me", "GET", undefined, tokenA);
      assert.equal(result.response.status, 200);
      assert.equal(result.data.patient?.id, patientA);
      assert.equal(result.data.patient?.email, emails[0]);
      assert.deepEqual(Object.keys(result.data.patient!).sort(), ["created_at", "date_of_birth", "email", "full_name", "id", "phone_number", "updated_at"]);
    });
    await t.test("missing tokens and body/query identity claims do not authenticate", async () => {
      assert.equal((await request(base, "/api/v1/patients/me")).response.status, 401);
      assert.equal((await request(base, "/api/v1/patients/me", "PATCH", { full_name: "Intruder", patient_id: patientA })).response.status, 401);
      assert.equal((await request(base, "/api/v1/patients/me?access_token=" + tokenA)).response.status, 401);
    });
    await t.test("invalid and tampered tokens are rejected", async () => {
      const segments = tokenA.split(".");
      const tampered = segments.slice(0, 2).join(".") + "." + (segments[2][0] === "A" ? "B" : "A") + segments[2].slice(1);
      for (const token of ["invalid", "a.b.c", tampered, await signed({}, "HS256", new Uint8Array(randomBytes(32)))]) {
        assert.equal((await request(base, "/api/v1/patients/me", "GET", undefined, token)).response.status, 401);
      }
    });
    await t.test("expired and premature tokens are rejected", async () => {
      const now = Math.floor(Date.now() / 1000);
      for (const token of [await signed({ iat: now - 100, exp: now - 1 }), await signed({ nbf: now + 100 })]) {
        assert.equal((await request(base, "/api/v1/patients/me", "GET", undefined, token)).response.status, 401);
      }
    });
    await t.test("wrong algorithm, issuer, audience, subject and missing/overlong expiry are rejected", async () => {
      const now = Math.floor(Date.now() / 1000);
      for (const token of [await signed({}, "HS384"), await signed({ iss: "wrong" }), await signed({ aud: "wrong" }),
        await signed({ sub: "not-a-uuid" }), await signed({ exp: undefined }), await signed({ iat: undefined }),
        await signed({ exp: now + config.jwtLifetimeSeconds + 60 })]) {
        assert.equal((await request(base, "/api/v1/patients/me", "GET", undefined, token)).response.status, 401);
      }
      const unsigned = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + tokenA.split(".")[1] + ".";
      assert.equal((await request(base, "/api/v1/patients/me", "GET", undefined, unsigned)).response.status, 401);
    });
    await t.test("profile updates persist permitted fields and maintain update timestamps", async () => {
      const before = (await request(base, "/api/v1/patients/me", "GET", undefined, tokenA)).data.patient!;
      const changed = await request(base, "/api/v1/patients/me", "PATCH",
        { full_name: "  Synthetic Updated Patient  ", date_of_birth: "2001-01-15", phone_number: "0300-1234567" }, tokenA);
      assert.equal(changed.response.status, 200);
      assert.equal(changed.data.patient?.id, patientA);
      assert.equal(changed.data.patient?.full_name, "Synthetic Updated Patient");
      assert.equal(changed.data.patient?.date_of_birth, "2001-01-15");
      assert.ok(changed.data.patient!.updated_at > before.updated_at);
      const persisted = await request(base, "/api/v1/patients/me", "GET", undefined, tokenA);
      assert.equal(persisted.data.patient?.full_name, "Synthetic Updated Patient");
    });
    await t.test("optional birth date and phone can be cleared explicitly", async () => {
      const result = await request(base, "/api/v1/patients/me", "PATCH", { date_of_birth: null, phone_number: null }, tokenA);
      assert.equal(result.response.status, 200);
      assert.equal(result.data.patient?.date_of_birth, null);
      assert.equal(result.data.patient?.phone_number, null);
    });
    await t.test("forbidden and unknown profile fields are rejected", async () => {
      for (const field of ["id", "patient_id", "email", "password", "password_hash", "created_at", "updated_at", "role", "unknown"]) {
        assert.equal((await request(base, "/api/v1/patients/me", "PATCH", { [field]: patientB }, tokenA)).response.status, 400);
      }
    });
    await t.test("invalid profile values and empty patches are rejected", async () => {
      for (const body of [{}, [], { full_name: null }, { full_name: "\u0000name" }, { full_name: "n".repeat(121) },
        { date_of_birth: "2025-02-29" }, { date_of_birth: "2000-1-01" }, { phone_number: "123" }, { phone_number: 3001234567 }]) {
        assert.equal((await request(base, "/api/v1/patients/me", "PATCH", body, tokenA)).response.status, 400);
      }
    });
    await t.test("patient A cannot target patient B by URL, query, body or forged subject", async () => {
      const before = (await request(base, "/api/v1/patients/me", "GET", undefined, tokenB)).data.patient;
      assert.equal((await request(base, "/api/v1/patients/" + patientB, "GET", undefined, tokenA)).response.status, 404);
      assert.equal((await request(base, "/api/v1/patients/me?patient_id=" + patientB, "GET", undefined, tokenA)).response.status, 400);
      assert.equal((await request(base, "/api/v1/patients/me", "PATCH", { id: patientB, full_name: "Intruder" }, tokenA)).response.status, 400);
      const pieces = tokenA.split(".");
      pieces[1] = Buffer.from(JSON.stringify({ ...decodeJwt(tokenA), sub: patientB })).toString("base64url");
      assert.equal((await request(base, "/api/v1/patients/me", "PATCH", { full_name: "Intruder" }, pieces.join("."))).response.status, 401);
      const after = (await request(base, "/api/v1/patients/me", "GET", undefined, tokenB)).data.patient;
      assert.deepEqual(after, before);
    });
    await t.test("SQL-looking profile text remains harmless parameter data", async () => {
      const literal = "Synthetic '); DROP TABLE patients; --";
      const result = await request(base, "/api/v1/patients/me", "PATCH", { full_name: literal }, tokenA);
      assert.equal(result.response.status, 200);
      assert.equal(result.data.patient?.full_name, literal);
      assert.equal((await request(base, "/api/v1/patients/me", "GET", undefined, tokenB)).data.patient?.id, patientB);
    });
    await t.test("nonexistent signed subjects expose no profile", async () => {
      assert.equal((await request(base, "/api/v1/patients/me", "GET", undefined, await signed({ sub: randomUUID() }))).response.status, 404);
    });
    await t.test("rate limiting applies to login and registration and ignores spoofed forwarded IPs", async () => {
      const limited = await listen(createApp({ auth: { ...config, rateLimitMax: 2 } }));
      for (const path of ["/api/v1/auth/login", "/api/v1/auth/register"]) {
        assert.equal((await request(limited, path, "POST", {}, undefined, { "X-Forwarded-For": "203.0.113.1" })).response.status, 400);
      }
      const blocked = await request(limited, "/api/v1/auth/login", "POST", { email: emails[0], password }, undefined, { "X-Forwarded-For": "203.0.113.2" });
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.data.error?.code, "RATE_LIMITED");
      assert.ok(blocked.response.headers.get("retry-after"));
      assert.equal(blocked.response.headers.get("cache-control"), "no-store");
    });
    await t.test("password work concurrency is bounded without exposing input", async () => {
      const service = createPasswordService({ ...config, maxHashConcurrency: 1 });
      const first = service.hash(password);
      await assert.rejects(service.hash(password), (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 503);
      await first;
    });
    await t.test("malformed JSON, unsupported content type and oversized bodies return safe errors", async () => {
      const invalid: Response = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":', signal: AbortSignal.timeout(10000) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "INVALID_BODY");
      assert.equal((await request(base, "/api/v1/auth/login", "POST", {}, undefined, { "Content-Type": "text/plain" })).response.status, 415);
      assert.equal((await request(base, "/api/v1/auth/register", "POST", { padding: "x".repeat(110000) })).response.status, 413);
    });
    await t.test("internal database failures never disclose raw details", async () => {
      const broken = await listen(createApp({ auth: config, database: { async query() { throw new Error("synthetic-private-driver-detail"); } } }));
      const result = await request(broken, "/api/v1/auth/login", "POST", { email: emails[0], password });
      assert.equal(result.response.status, 500);
      assert.equal(result.data.error?.code, "INTERNAL_ERROR");
      assert.ok(!JSON.stringify(result.data).includes("synthetic-private-driver-detail"));
    });
    await t.test("existing API and database health endpoints retain successful behavior", async () => {
      for (const route of ["/api/v1/health", "/api/v1/health/db"]) {
        assert.equal((await request(base, route)).response.status, 200);
      }
    });
    await t.test("JWT secret is ignored, private and absent from tracked/nonignored source", async () => {
      const root = new URL("../../../", import.meta.url);
      assert.equal((await stat(new URL("backend/.env", root))).mode & 0o077, 0);
      assert.equal(execFileSync("git", ["check-ignore", "backend/.env"], { cwd: root, encoding: "utf8" }).trim(), "backend/.env");
      assert.equal(execFileSync("git", ["ls-files", "--", "backend/.env"], { cwd: root, encoding: "utf8" }), "");
      const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
      for (const file of files) {
        assert.ok(!(await readFile(new URL(file, root), "utf8")).includes(privateEnv.JWT_SECRET), "JWT secret found in source: " + file);
      }
    });
  } finally {
    try {
      await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    } finally {
      try {
        if (cleanupAuthorized) {
          await pool.query("DELETE FROM public.patients WHERE email = ANY($1::text[])", [emails]);
          assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE email = ANY($1::text[])", [emails])).rows[0].n, 0);
        }
      } finally { await closeDatabasePool(); }
    }
  }
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { chromium, expect, type Page } from "@playwright/test";
let browser: Awaited<ReturnType<typeof chromium.launch>>,
  vite: ReturnType<typeof spawn>;
let origin = "";
const ADMIN = { email: "admin@example.invalid", password: "Synthetic admin passphrase 731!" };
const TOKEN = "admin.synthetic-only";
// The first 8 characters (what the screens show as a short label) are unique per row.
const id = (n: number, kind = 1) =>
  `${String(n).padStart(4, "0")}${String(kind).repeat(4)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Fields the backend must never send. The fixtures add them anyway, to prove the screens do not render anything they were not designed to show.
const LEAKS = {
  original_filename: "LEAK-report.pdf",
  extracted_text: "LEAK extracted OCR text",
  summary_text: "LEAK summary text",
  hospital_name: "LEAK Hospital",
  date_of_birth: "1980-01-01",
  phone_number: "+1555LEAK",
  lease_token: "LEAK-lease-token",
};
type Patient = {
  id: string; email: string; full_name: string; account_status: string; email_verified: boolean;
  email_verified_at: string | null; created_at: string; updated_at: string;
};
type Job = {
  document_id: string; patient_id: string; state: string; attempt_count: number; max_attempts: number;
  last_error_code: string | null; next_attempt_at: string; created_at: string; updated_at: string;
  started_at: string | null; finished_at: string | null; lease_active: boolean; lease_expired: boolean;
};
function fixtures() {
  const names = ["Amara Okafor", "Bilal Raza", "Chen Wei", "Dana Whitfield", "Elif Demir", "Farid Nasser", "Grace Liu", "Hugo Martin", "Ines Costa", "Jonas Berg", "Kavya Rao", "Lena Fischer", "Mateo Ruiz"];
  const patients: Patient[] = names.map((full_name, i) => ({
    id: id(i + 1),
    email: full_name.split(" ")[0].toLowerCase() + "@example.invalid",
    full_name,
    account_status: i === 2 ? "suspended" : i === 4 ? "unverified" : i === 11 ? "deleted" : "active",
    email_verified: i !== 4,
    email_verified_at: i === 4 ? null : "2026-01-02T10:00:00.000Z",
    created_at: new Date(Date.UTC(2026, 0, 20 - i, 9, 30)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 21 - i, 9, 30)).toISOString(),
  }));
  const states: [string, string | null, number][] = [
    ["failed", "PROCESSOR_FAILED", 1], ["failed", "INVALID_INPUT", 2], ["running", null, 1], ["pending", null, 0], ["completed", null, 1],
    ["retry_wait", "PROCESSOR_TIMEOUT", 1], ["failed", "PROCESSOR_TIMEOUT", 3], ["completed", null, 1], ["pending", null, 0], ["failed", "LEASE_EXPIRED", 1],
    ["running", null, 1], ["completed", null, 1],
  ];
  const jobs: Job[] = states.map(([state, code, attempts], i) => ({
    document_id: id(i + 1, 2),
    patient_id: patients[i % 3].id,
    state, attempt_count: attempts, max_attempts: 3, last_error_code: code,
    next_attempt_at: "2026-02-01T10:00:00.000Z",
    created_at: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 1, 1, 12 - Math.floor(i / 2), 59 - i)).toISOString(),
    started_at: attempts ? "2026-02-01T08:05:00.000Z" : null,
    finished_at: state === "failed" || state === "completed" ? "2026-02-01T08:09:00.000Z" : null,
    lease_active: false, lease_expired: state === "running" && i === 10,
  }));
  return { patients, jobs };
}
before(async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  origin = "http://127.0.0.1:" + port;
  let startup = "";
  vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/admin/vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout?.on("data", (b) => { startup += b; });
  vite.stderr?.on("data", (b) => { startup += b; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (vite.exitCode !== null) throw new Error("Vite startup failed: " + startup);
    try {
      if ((await fetch(origin + "/", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Local Vite failed readiness: " + startup);
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => {
  await browser?.close();
  vite?.kill();
});
interface Options { expiresIn?: number; rejectAfter?: number; mutateFail?: "conflict" | "forbidden"; viewport?: { width: number; height: number } }
async function setup({ expiresIn = 900, rejectAfter, mutateFail, viewport }: Options = {}) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const data = fixtures();
  const calls: { method: string; path: string; query: URLSearchParams; auth?: string; body: string | null }[] = [];
  let loginAt = 0;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    calls.push({ method, path, query: url.searchParams, auth: req.headers().authorization, body: req.postData() });
    const reply = (status: number, value: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value), headers: { "cache-control": "no-store" } });
    if (path === "/api/v1/admin/auth/login") {
      const body = req.postDataJSON();
      if (body.email !== ADMIN.email || body.password !== ADMIN.password) return reply(401, { error: { code: "INVALID_CREDENTIALS" } });
      loginAt = Date.now();
      return reply(200, { success: true, access_token: TOKEN, token_type: "Bearer", expires_in: expiresIn });
    }
    if (!path.startsWith("/api/v1/admin/")) return reply(404, { error: { code: "NOT_FOUND" } });
    if (req.headers().authorization !== "Bearer " + TOKEN || (rejectAfter !== undefined && Date.now() - loginAt > rejectAfter))
      return reply(401, { error: { code: "UNAUTHORIZED" } });
    const rest = path.replace("/api/v1/admin/", "");
    const page_ = <T,>(rows: T[]) => {
      const limit = Number(url.searchParams.get("limit") ?? 25), start = Number((url.searchParams.get("cursor") ?? "c0").slice(1));
      const end = start + limit;
      return { slice: rows.slice(start, end), next: end < rows.length ? "c" + end : null };
    };
    if (rest === "patients" && method === "GET") {
      const q = url.searchParams.get("q")?.toLowerCase(), status = url.searchParams.get("status"), verified = url.searchParams.get("verified");
      const rows = data.patients.filter((p) => (!q || p.full_name.toLowerCase().includes(q) || p.email.includes(q)) && (!status || p.account_status === status) && (verified === null || String(p.email_verified) === verified));
      const { slice, next } = page_(rows);
      return reply(200, { success: true, patients: slice.map((p) => ({ ...p, ...LEAKS })), next_cursor: next });
    }
    const patient = /^patients\/([^/]+)(?:\/(suspend|reactivate))?$/.exec(rest);
    if (patient) {
      const found = data.patients.find((p) => p.id === patient[1]);
      if (!found) return reply(404, { error: { code: "NOT_FOUND" } });
      if (method === "GET" && !patient[2]) return reply(200, { success: true, patient: { ...found, ...LEAKS } });
      if (method === "POST" && patient[2]) {
        if (mutateFail === "forbidden") return reply(403, { error: { code: "FORBIDDEN" } });
        const from = patient[2] === "suspend" ? "active" : "suspended";
        if (mutateFail === "conflict" || found.account_status !== from) return reply(409, { error: { code: "ACCOUNT_STATE_CONFLICT" } });
        found.account_status = patient[2] === "suspend" ? "suspended" : "active";
        return reply(200, { success: true, patient: { ...found, ...LEAKS } });
      }
    }
    if (rest === "processing/summary" && method === "GET") {
      const by: Record<string, number> = { pending: 0, running: 0, retry_wait: 0, completed: 0, failed: 0, cancelled: 0 };
      const codes: Record<string, number> = { PROCESSOR_FAILED: 0, PROCESSOR_TIMEOUT: 0, INTERRUPTED: 0, INVALID_INPUT: 0, LEASE_EXPIRED: 0 };
      for (const j of data.jobs) { by[j.state]++; if (j.last_error_code && (j.state === "failed" || j.state === "retry_wait")) codes[j.last_error_code]++; }
      return reply(200, { success: true, summary: { by_state: by, failures_by_error_code: codes, running_with_expired_lease: data.jobs.filter((j) => j.lease_expired).length, total: data.jobs.length } });
    }
    if (rest === "processing/jobs" && method === "GET") {
      const s = url.searchParams, rows = data.jobs.filter((j) => (!s.get("state") || j.state === s.get("state")) && (!s.get("error_code") || j.last_error_code === s.get("error_code")) && (!s.get("patient_id") || j.patient_id === s.get("patient_id")));
      const { slice, next } = page_(rows);
      return reply(200, { success: true, jobs: slice.map((j) => ({ ...j, ...LEAKS })), next_cursor: next });
    }
    const job = /^processing\/jobs\/([^/]+?)(\/retry)?$/.exec(rest);
    if (job) {
      const found = data.jobs.find((j) => j.document_id === job[1]);
      if (!found) return reply(404, { error: { code: "NOT_FOUND" } });
      if (method === "GET" && !job[2]) return reply(200, { success: true, job: { ...found, ...LEAKS } });
      if (method === "POST" && job[2]) {
        if (found.state !== "failed" || found.attempt_count >= found.max_attempts || found.last_error_code === "INVALID_INPUT") return reply(409, { error: { code: "JOB_NOT_RETRYABLE" } });
        found.state = "retry_wait";
        return reply(200, { success: true, job: { ...found, ...LEAKS } });
      }
    }
    return reply(404, { error: { code: "NOT_FOUND" } });
  });
  await page.goto(origin + "/");
  return { page, context, calls, data };
}
async function signIn(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function login(page: Page) {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Amara Okafor" })).toBeVisible();
}
const noStorage = (page: Page) =>
  page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
async function noLeaks(page: Page) {
  const text = await page.locator("body").innerText();
  for (const word of ["LEAK", "1980-01-01", "+1555"]) assert.ok(!text.includes(word), "the page shows " + word);
}

test("P8-ADMIN-WEB-01 sign-in: wrong credentials are refused, the token stays in memory, and only admin endpoints are called", async () => {
  const { page, context, calls } = await setup();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  assert.equal(calls.length, 0, "nothing is requested before sign-in");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await signIn(page, ADMIN.email, "wrong password");
  await expect(page.getByText("Sign-in failed. Check your email and password.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toHaveCount(0);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText(/Session ends in 1[45]:\d\d/);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  const protectedCalls = calls.filter((c) => c.path !== "/api/v1/admin/auth/login");
  assert.ok(protectedCalls.length >= 1 && protectedCalls.every((c) => c.auth === "Bearer " + TOKEN), "every data request carries the in-memory token");
  assert.ok(calls.every((c) => c.path.startsWith("/api/v1/admin/")), "only admin endpoints are used");
  assert.equal(calls.filter((c) => c.path.endsWith("/auth/login")).every((c) => c.auth === undefined), true, "the login request itself carries no token");
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await context.close();
});

test("P8-ADMIN-WEB-02 patient accounts: search, filters, paging and detail show account metadata only", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  const lastList = () => calls.filter((c) => c.path === "/api/v1/admin/patients").at(-1)!;
  assert.equal(lastList().query.get("limit"), "10");
  await expect(page.getByRole("row")).toHaveCount(11);
  await expect(page.getByText("Page 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next →" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "← Previous" })).toBeDisabled();
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Mateo Ruiz" })).toBeVisible();
  assert.equal(lastList().query.get("cursor"), "c10");
  await expect(page.getByRole("button", { name: "Next →" })).toBeDisabled();
  await page.getByRole("button", { name: "← Previous" }).click();
  await expect(page.getByText("Page 1")).toBeVisible();
  await page.getByLabel("Search name or email").fill("a");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Enter at least 2 characters")).toBeVisible();
  await page.getByLabel("Search name or email").fill("chen");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Chen Wei" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
  assert.equal(lastList().query.get("q"), "chen");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Status").selectOption("suspended");
  await page.getByLabel("Email verified").selectOption("true");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Chen Wei" })).toBeVisible();
  assert.deepEqual([lastList().query.get("status"), lastList().query.get("verified")], ["suspended", "true"]);
  await page.getByLabel("Status").selectOption("");
  await page.getByLabel("Email verified").selectOption("false");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Elif Demir" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "No", exact: true })).toBeVisible();
  await page.getByLabel("Search name or email").fill("nobody-here");
  await page.getByLabel("Email verified").selectOption("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No patient accounts match.")).toBeVisible();
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open Elif Demir" }).click();
  const detail = page.getByRole("complementary", { name: "Account detail" });
  await expect(detail.getByRole("heading", { name: "Elif Demir" })).toBeVisible();
  await expect(detail).toContainText("elif@example.invalid");
  await expect(detail).toContainText("unverified");
  await expect(detail).toContainText("No");
  await expect(detail).toContainText("2026-01-16 09:30 UTC");
  await expect(detail.getByRole("button", { name: "Suspend account" })).toHaveCount(0);
  await expect(detail).toContainText("No admin action is available for a unverified account.");
  await noLeaks(page);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  await context.close();
});

test("P8-ADMIN-WEB-03 suspend and reactivate need a confirmation step, then show clear success; conflicts and role denials show clear errors", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  const posts = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/login"));
  await page.getByRole("button", { name: "Open Amara Okafor" }).click();
  const detail = page.getByRole("complementary", { name: "Account detail" });
  await expect(detail.getByRole("button", { name: "Suspend account" })).toBeVisible();
  await detail.getByRole("button", { name: "Suspend account" }).click();
  await expect(detail.getByRole("heading", { name: "Suspend Amara Okafor?" })).toBeVisible();
  await expect(detail).toContainText("signed out everywhere");
  assert.equal(posts().length, 0, "nothing is sent until the admin confirms");
  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(detail.getByRole("button", { name: "Suspend account" })).toBeVisible();
  assert.equal(posts().length, 0, "cancel sends nothing");
  await detail.getByRole("button", { name: "Suspend account" }).click();
  await detail.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(detail.getByText(/Amara Okafor was suspended\. Their sessions, doctor shares and report links were ended\./)).toBeVisible();
  assert.equal(posts().length, 1);
  assert.match(posts()[0].path, /\/patients\/00011111-0000-4000-8000-000000000001\/suspend$/);
  assert.equal(posts()[0].body, null, "the action sends no body");
  await expect(detail.getByRole("button", { name: "Reactivate account" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Suspend account" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Amara Okafor/ })).toContainText("suspended");
  await detail.getByRole("button", { name: "Reactivate account" }).click();
  await expect(detail.getByRole("heading", { name: "Reactivate Amara Okafor?" })).toBeVisible();
  await expect(detail).toContainText("do not come back");
  assert.equal(posts().length, 1);
  await detail.getByRole("button", { name: "Confirm reactivate" }).click();
  await expect(detail.getByText(/Amara Okafor was reactivated\. They must sign in again/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Amara Okafor/ })).toContainText("active");
  assert.equal(posts().length, 2);
  await noLeaks(page);
  await context.close();
  // someone else changed the account first: a clear message, and the real status is reloaded
  const second = await setup({ mutateFail: "conflict" });
  await login(second.page);
  await second.page.getByRole("button", { name: "Open Bilal Raza" }).click();
  const d2 = second.page.getByRole("complementary", { name: "Account detail" });
  await d2.getByRole("button", { name: "Suspend account" }).click();
  await d2.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(d2.getByRole("alert")).toContainText("not in a state that allows this action");
  await expect(d2.getByRole("button", { name: "Suspend account" })).toBeVisible();
  await second.context.close();
  // a role without the permission: clear message, and the admin stays signed in
  const third = await setup({ mutateFail: "forbidden" });
  await login(third.page);
  await third.page.getByRole("button", { name: "Open Bilal Raza" }).click();
  const d3 = third.page.getByRole("complementary", { name: "Account detail" });
  await d3.getByRole("button", { name: "Suspend account" }).click();
  await d3.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(d3.getByRole("alert")).toContainText("Your admin role is not allowed to do this.");
  await expect(third.page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(third.page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await third.context.close();
});

test("P8-ADMIN-WEB-04 processing: summary counts, filters, paging and job detail show job metadata only", async () => {
  const { page, context, calls, data } = await setup();
  await login(page);
  await page.getByRole("button", { name: "Processing" }).click();
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  const cards = page.getByRole("region", { name: "Processing summary" });
  await expect(cards).toContainText("12");
  await expect(cards.getByRole("listitem").filter({ hasText: "All jobs" })).toContainText("12");
  await expect(cards.getByRole("listitem").filter({ hasText: "failed" })).toContainText("4");
  await expect(cards.getByRole("listitem").filter({ hasText: "expired leases" })).toContainText("1");
  await expect(cards).toContainText("processor timeout 2");
  const lastJobs = () => calls.filter((c) => c.path === "/api/v1/admin/processing/jobs").at(-1)!;
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  assert.equal(lastJobs().query.get("cursor"), "c10");
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByRole("button", { name: "← Previous" }).click();
  await page.getByLabel("State").selectOption("failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(5);
  assert.equal(lastJobs().query.get("state"), "failed");
  await page.getByLabel("Failure reason").selectOption("PROCESSOR_TIMEOUT");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  assert.deepEqual([lastJobs().query.get("state"), lastJobs().query.get("error_code")], ["failed", "PROCESSOR_TIMEOUT"]);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Patient ID").fill("not-an-id");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("The patient ID must be a full ID")).toBeVisible();
  await page.getByLabel("Patient ID").fill(data.patients[1].id);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(5);
  assert.equal(lastJobs().query.get("patient_id"), data.patients[1].id);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Open job 00012222" }).click();
  const detail = page.getByRole("complementary", { name: "Job detail" });
  await expect(detail).toContainText("failed");
  await expect(detail).toContainText("1 of 3");
  await expect(detail).toContainText("processor failed");
  await expect(detail).toContainText("2026-02-01 08:05 UTC");
  await expect(detail).toContainText(data.jobs[0].document_id);
  await noLeaks(page);
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  assert.ok(calls.every((c) => c.path.startsWith("/api/v1/admin/")));
  await context.close();
});

test("P8-ADMIN-WEB-05 retry needs a confirmation step, then queues the job; a job that cannot be retried gives a clear message", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await page.getByRole("button", { name: "Processing" }).click();
  const posts = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/login"));
  const detail = page.getByRole("complementary", { name: "Job detail" });
  await page.getByRole("button", { name: "Open job 00032222" }).click();
  await expect(detail).toContainText("running");
  await expect(detail.getByRole("button", { name: "Retry job" })).toHaveCount(0);
  await expect(detail).toContainText("Only failed jobs can be retried.");
  await page.getByRole("button", { name: "Open job 00012222" }).click();
  await detail.getByRole("button", { name: "Retry job" }).click();
  await expect(detail.getByRole("heading", { name: "Retry this job?" })).toBeVisible();
  await expect(detail).toContainText("Attempts are not reset");
  assert.equal(posts().length, 0, "nothing is sent until the admin confirms");
  await detail.getByRole("button", { name: "Cancel" }).click();
  assert.equal(posts().length, 0);
  const summaries = calls.filter((c) => c.path.endsWith("/processing/summary")).length;
  await detail.getByRole("button", { name: "Retry job" }).click();
  await detail.getByRole("button", { name: "Confirm retry" }).click();
  await expect(detail.getByText(/Retry queued\. The job is waiting for the processing worker/)).toBeVisible();
  assert.equal(posts().length, 1);
  assert.match(posts()[0].path, /\/processing\/jobs\/00012222-0000-4000-8000-000000000001\/retry$/);
  assert.equal(posts()[0].body, null);
  await expect(detail).toContainText("retry wait");
  await expect(page.getByRole("row", { name: /00012222/ })).toContainText("retry wait");
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/processing/summary")).length).toBeGreaterThan(summaries);
  // exhausted attempts: the backend refuses, the screen explains and shows the real state
  await page.getByRole("button", { name: "Open job 00072222" }).click();
  await detail.getByRole("button", { name: "Retry job" }).click();
  await detail.getByRole("button", { name: "Confirm retry" }).click();
  await expect(detail.getByRole("alert")).toContainText("This job cannot be retried right now");
  await expect(detail).toContainText("3 of 3");
  await noLeaks(page);
  await context.close();
});

test("P8-ADMIN-WEB-06 sign out clears the session, sends nothing afterwards, and shows no data on the sign-in screen", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await page.getByRole("button", { name: "Open Amara Okafor" }).click();
  await expect(page.getByRole("complementary", { name: "Account detail" }).getByRole("heading", { name: "Amara Okafor" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("You signed out. Nothing is kept in this browser.")).toBeVisible();
  await expect(page.getByText("Amara Okafor")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  const used = calls.length;
  await page.waitForTimeout(500);
  assert.equal(calls.length, used, "no request is made after sign-out");
  assert.deepEqual(await noStorage(page), { local: 0, session: 0, cookies: "" });
  await login(page);
  await context.close();
});

test("P8-ADMIN-WEB-07 when the 15-minute token runs out the admin returns to sign-in with a clear message, and comes back to the same screen", async () => {
  const { page, context, calls } = await setup({ expiresIn: 2 });
  await login(page);
  await page.getByRole("button", { name: "Processing" }).click();
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText(/Session ends in 0:0[12]/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 6000 });
  await expect(page.getByText("Your session expired after 15 minutes. Sign in again to continue.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Document processing" })).toHaveCount(0);
  const used = calls.length;
  await page.waitForTimeout(400);
  assert.equal(calls.length, used, "no request is made with an expired token");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  await context.close();
  // the server stops accepting the token before the clock does (revoked, role changed, admin disabled)
  const rejected = await setup({ rejectAfter: 300 });
  await signIn(rejected.page);
  await expect(rejected.page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  await rejected.page.waitForTimeout(500);
  await rejected.page.getByRole("button", { name: "Next →" }).click();
  await expect(rejected.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(rejected.page.getByText("Your session is no longer valid. Sign in again.")).toBeVisible();
  await rejected.context.close();
});

test("P8-ADMIN-WEB-08 the screens fit a laptop without sideways scrolling and the main controls can be reached by keyboard", async () => {
  const { page, context } = await setup({ viewport: { width: 1280, height: 720 } });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(await fits());
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Patient accounts" })).toBeVisible();
  assert.ok(await fits(), "patient accounts fit 1280 px");
  await page.getByRole("button", { name: "Open Amara Okafor" }).click();
  await expect(page.getByRole("complementary", { name: "Account detail" })).toBeVisible();
  assert.ok(await fits(), "with a detail panel open");
  await page.getByRole("button", { name: "Processing" }).click();
  await expect(page.getByRole("heading", { name: "Document processing" })).toBeVisible();
  assert.ok(await fits(), "processing fits 1280 px");
  const box = await page.getByRole("complementary", { name: "Job detail" }).boundingBox();
  assert.ok(box && box.width >= 300, "the detail panel is wide enough to read");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  assert.ok(["A", "BUTTON", "INPUT", "SELECT"].includes(focused ?? ""), "keyboard focus moves onto a control");
  await context.close();
});

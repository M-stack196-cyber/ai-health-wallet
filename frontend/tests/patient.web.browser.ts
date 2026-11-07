// Patient app in a real browser (headless Google Chrome) against the RUNNING local stack. Synthetic data only.
// Prerequisite: ./local-stack/up.sh   Run: npm run test:patient-web   (from frontend/)
// Proves what a person would see on http://localhost:8081. Not a phone, not Safari/Firefox, not a release build.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { syntheticDigitalPdf } from "../../backend/src/processing/fixtures/pdf-fixtures.ts";

const WEB = process.env.HW_PATIENT_WEB ?? "http://localhost:8081";
const MAIL = process.env.HW_MAILBOX ?? "http://127.0.0.1:8026/messages";
const SHARE_ORIGIN = process.env.HW_SHARE_ORIGIN ?? "http://127.0.0.1:5173";
const PASSWORD = "Synthetic Web passphrase 7731!";
let browser: Browser;
before(async () => {
  for (const url of [WEB, MAIL]) {
    try { await fetch(url, { signal: AbortSignal.timeout(5000) }); }
    catch { throw new Error("The local stack is not running (" + url + "). Start it with ./local-stack/up.sh"); }
  }
  browser = await chromium.launch({ executablePath: process.env.HW_CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

async function open(): Promise<{ context: BrowserContext; page: Page; problems: string[] }> {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage(); const problems: string[] = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message.slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && /CORS|blocked by|Access-Control/i.test(m.text())) problems.push("console: " + m.text().slice(0, 200)); });
  await page.goto(WEB, { waitUntil: "load", timeout: 120000 });
  await page.getByText("Welcome back.", { exact: true }).waitFor({ timeout: 90000 });
  return { context, page, problems };
}
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
async function mailedCode(to: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const messages = (await (await fetch(MAIL)).json()) as { to: string; text: string }[];
    const match = [...messages].reverse().find((m) => m.to === to);
    const code = match?.text.match(/[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("No synthetic email arrived for the test patient.");
}
async function browserHolds(page: Page, context: BrowserContext) {
  const held = await page.evaluate(async () => ({
    local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie,
    databases: "databases" in indexedDB ? (await indexedDB.databases()).length : 0 }));
  return { ...held, contextCookies: (await context.cookies()).length };
}

test("PW-01 the registration screen renders in a real browser, with no script errors", async () => {
  const { context, page, problems } = await open();
  try {
    await page.getByText("YOUR RECORDS. YOUR CONTROL.", { exact: true }).waitFor();
    await button(page, "Register").click();
    await page.getByText("Register", { exact: true }).first().waitFor();
    for (const label of ["Email", "Full name", "Date of birth (YYYY-MM-DD)", "Password"]) await field(page, label).waitFor({ timeout: 10000 });
    assert.ok((await page.innerText("body")).length > 200, "the page has real content");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});
test("PW-02 the banner tells the truth about what a browser cannot do", async () => {
  const { context, page } = await open();
  try {
    const text = (await page.innerText("body")).replace(/\s+/g, " ");
    for (const phrase of ["local development only", "Screen-capture protection is NOT available", "kept in memory only", "reloading this page signs you out",
      "saved by your browser", "Native sharing may be unavailable"]) assert.ok(text.includes(phrase), "banner says: " + phrase);
  } finally { await context.close(); }
});
test("PW-03 full patient flow in the browser: register, verify, sign in, upload, process, download, share, revoke, delete", { timeout: 420000 }, async () => {
  const { context, page, problems } = await open();
  const email = randomUUID() + "@example.invalid";
  const pdf = Buffer.from(syntheticDigitalPdf([["WEB TEST REPORT", "Glucose: 90 mg/dL"]]));
  const dialogs: string[] = [];
  try {
    // Registration and email verification through the real synthetic mailbox.
    await button(page, "Register").click();
    await field(page, "Email").fill(email);
    await field(page, "Full name").fill("Synthetic Web Patient");
    await field(page, "Date of birth (YYYY-MM-DD)").fill("2000-01-01");
    await field(page, "Password").fill(PASSWORD);
    await button(page, "Register").click();
    await page.getByText("Registration received.", { exact: false }).waitFor({ timeout: 30000 });
    await field(page, "Complete code from email").fill(await mailedCode(email));
    await button(page, "Verify email").click();
    await page.getByText("Email verified.", { exact: false }).waitFor({ timeout: 30000 });
    await field(page, "Password").fill(PASSWORD);
    await button(page, "Sign in").click();
    await page.getByText("PATIENT WORKSPACE", { exact: false }).waitFor({ timeout: 60000 });

    // Memory only: nothing in browser storage or cookies while signed in; a reload signs the person out.
    const signedIn = await browserHolds(page, context);
    assert.deepEqual(signedIn, { local: 0, session: 0, cookie: "", databases: 0, contextCookies: 0 }, "sign-in secrets are not in browser storage or cookies");

    // Upload through the browser file chooser.
    await button(page, "Upload").click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button(page, "Choose PDF, JPG, JPEG or PNG").click()]);
    await chooser.setFiles({ name: "web-report.pdf", mimeType: "application/pdf", buffer: pdf });
    await field(page, "Hospital name").fill("Synthetic Hospital");
    await button(page, "Upload original").click();
    await page.getByText("Original uploaded.", { exact: false }).waitFor({ timeout: 60000 });
    // Open the record and wait until the processing endpoint (what the detail screen shows) reports completed.
    // The list's own status text stays "processing": migration 0007 keeps the document-level status there on purpose (tracker M14-008).
    await button(page, "Open web-report.pdf").click();
    let state = "";
    for (let i = 0; i < 45 && state !== "completed"; i++) {
      const answer = page.waitForResponse((r) => /\/documents\/[^/]+\/processing$/.test(r.url()), { timeout: 30000 });
      await button(page, "Refresh processing status").click();
      const body = await (await answer).json();
      state = (body.data ?? body).processing?.state ?? (body.data ?? body).processing?.status ?? "";
      if (state !== "completed") await page.waitForTimeout(2000);
    }
    assert.equal(state, "completed", "the Python OCR/text pipeline finished the upload");

    // Download of the original: a browser download whose bytes equal what was uploaded.
    page.once("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), button(page, "View / download original").click()]);
    const openDialog = dialogs.find((m) => m.includes("Open original?")) ?? "";
    assert.ok(openDialog.includes("through your browser") && !openDialog.includes("share sheet"), "the confirmation says what really happens in a browser: " + JSON.stringify(openDialog));
    assert.equal(download.suggestedFilename(), "original.pdf");
    const saved = await readFile((await download.path())!);
    assert.equal(createHash("sha256").update(saved).digest("hex"), createHash("sha256").update(pdf).digest("hex"), "downloaded bytes equal the uploaded bytes");

    // Summary requested, produced by the real summary service, then read.
    await button(page, "Request report summary").click();
    await page.getByText("Summary job:", { exact: false }).waitFor({ timeout: 30000 });
    for (let i = 0; i < 40 && !(await page.innerText("body")).includes("Summary job: completed"); i++) {
      await page.waitForTimeout(2000);
      await button(page, "Refresh summary job").click();
    }
    assert.ok((await page.innerText("body")).includes("Summary job: completed"), "the summary job completed");
    const summary = page.waitForResponse((r) => /\/documents\/[^/]+\/summary$/.test(r.url()) && r.status() === 200, { timeout: 30000 });
    await button(page, "Load report summary").click();
    await summary;

    // Sharing: copy link works, native share says plainly that it is unavailable, revoke asks first.
    page.on("dialog", () => undefined);
    await button(page, "Sharing").click();
    await button(page, "web-report.pdf").click();
    await button(page, "Create selected-record share").click();
    await button(page, "Copy link").waitFor({ timeout: 30000 });
    await button(page, "Copy link").click();
    await page.getByText("Link copied.", { exact: false }).waitFor({ timeout: 15000 });
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith(SHARE_ORIGIN + "/"), "the copied link points at the doctor web app");
    if (!(await page.evaluate(() => typeof navigator.share === "function"))) {
      await button(page, "Share link").click();
      await page.getByText("Native sharing is not available in this browser", { exact: false }).waitFor({ timeout: 15000 });
    }
    page.removeAllListeners("dialog");
    page.once("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await button(page, "Revoke share").click();
    await page.waitForTimeout(1500);
    assert.ok(dialogs.some((m) => m.includes("Revoke this share?")), "a confirmation was shown");
    assert.equal(await page.getByText("Share revoked.", { exact: true }).count(), 0, "cancel did not revoke");
    page.once("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    await button(page, "Revoke share").click();
    await page.getByText("Share revoked.", { exact: true }).waitFor({ timeout: 30000 });

    // Reload signs the person out (memory only).
    await page.reload({ waitUntil: "load" });
    await page.getByText("Welcome back.", { exact: true }).waitFor({ timeout: 60000 });
    assert.deepEqual(await browserHolds(page, context), { local: 0, session: 0, cookie: "", databases: 0, contextCookies: 0 });

    // Account deletion request: cancel does nothing, accept runs. Sign in again first.
    await field(page, "Email").fill(email); await field(page, "Password").fill(PASSWORD);
    await button(page, "Sign in").click();
    await page.getByText("PATIENT WORKSPACE", { exact: false }).waitFor({ timeout: 60000 });
    await button(page, "Profile").click();
    await button(page, "Start deletion request").click();
    await field(page, "Current password").fill(PASSWORD);
    await field(page, "Type DELETE_MY_ACCOUNT to confirm").fill("DELETE_MY_ACCOUNT");
    page.once("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await button(page, "Submit deletion request").click();
    await page.waitForTimeout(1500);
    assert.equal(await page.getByText("DELETION REQUESTED", { exact: true }).count(), 0, "cancel did not send the request");
    page.once("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    await button(page, "Submit deletion request").click();
    await page.getByText("DELETION REQUESTED", { exact: true }).waitFor({ timeout: 60000 });
    assert.ok(dialogs.some((m) => m.includes("Request account deletion?")));
    assert.deepEqual(problems, [], "no script or cross-origin errors during the whole flow");
  } finally { await context.close(); }
});
test("PW-04 the web files keep secrets out of browser storage (static check)", async () => {
  const read = (p: string) => readFile(new URL("../apps/patient/" + p, import.meta.url), "utf8");
  const web = (await read("src/platform.web.ts")) + (await read("src/WebApp.tsx")) + (await read("index.web.ts"));
  assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB|expo-secure-store|expo-file-system/.test(web));
  for (const file of ["src/web-shims/alert.ts", "src/web-shims/share.ts", "src/web-shims/expo-file-system.ts", "src/web-shims/expo-screen-capture.ts"])
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(await read(file)), file);
  const metro = await read("metro.config.js");
  assert.match(metro, /platform !== "web"\) return resolve\(context, moduleName, platform\)/, "native platforms pass straight through");
});

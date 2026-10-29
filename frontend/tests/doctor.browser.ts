import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { chromium, expect, type Page } from "@playwright/test";
let browser: Awaited<ReturnType<typeof chromium.launch>>,
  vite: ReturnType<typeof spawn>;
let origin = "";
const reference = "sh1." + "a".repeat(64),
  selected = "11111111-1111-4111-8111-111111111111";
const document = {
  id: selected,
  original_filename: "selected-lab.pdf",
  category: "lab_report",
  category_label: "Lab Report",
  hospital_name: "Synthetic Hospital",
  document_date: "2026-01-02",
  uploaded_at: "2026-01-03T12:00:00Z",
  content_type: "application/pdf",
  size_bytes: 80,
  processing_status: "processing",
};
const summary = {
  text: "Glucose reported: 90 mg/dL",
  generated_at: "2026-01-03",
  mode: "synthetic-offline",
  provider: "synthetic",
  model: "bounded",
  limitations: ["Not a diagnosis."],
};
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
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout?.on("data", (b) => {
    startup += b;
  });
  vite.stderr?.on("data", (b) => {
    startup += b;
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (vite.exitCode !== null)
      throw new Error("Vite startup failed: " + startup);
    try {
      if (
        (await fetch(origin + "/", { signal: AbortSignal.timeout(1000) })).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Local Vite failed readiness: " + startup);
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});
after(async () => {
  await browser?.close();
  vite?.kill();
});
async function setup({
  expiry = 60000,
  otpFailure = false,
  challengeSeconds = 600,
}: { expiry?: number; otpFailure?: boolean; challengeSeconds?: number } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let denied = false;
  const calls: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    calls.push(path);
    const post = () => req.postDataJSON();
    let value: unknown = {},
      status = 200;
    if (path === "/api/v1/sharing/open") {
      assert.equal(post().share_token, reference);
      value = {
        requires_email_otp: true,
        expires_at: new Date(Date.now() + expiry).toISOString(),
      };
    } else if (path === "/api/v1/sharing/otp") {
      assert.equal(post().name, "Synthetic Doctor");
      assert.equal(post().email, "doctor@example.invalid");
      value = { challenge_id: "challenge", expires_in: challengeSeconds };
      status = 202;
    } else if (path === "/api/v1/sharing/otp/verify") {
      if (otpFailure) {
        status = 403;
        value = { error: { code: "SHARE_ACCESS_DENIED" } };
      } else {
        value = {
          access_token: "ds1.synthetic-only",
          expires_at: new Date(Date.now() + expiry).toISOString(),
        };
      }
    } else if (path.startsWith("/api/v1/doctor/")) {
      assert.equal(req.headers().authorization, "Bearer ds1.synthetic-only");
      if (denied) {
        status = 403;
        value = { error: { code: "SHARE_ACCESS_DENIED" } };
      } else if (path.endsWith("/download") || path.endsWith("/view")) {
        await route.fulfill({
          status: 200,
          contentType: "application/pdf",
          body: "%PDF-1.4\nSynthetic selected original\n%%EOF",
          headers: { "cache-control": "no-store" },
        });
        return;
      } else if (path.endsWith("/summary")) value = { summary };
      else if (path.endsWith("/history-summary"))
        value = {
          scope: "selected_records_only",
          entries: [
            {
              source_document_id: selected,
              date: "2026-01-02",
              date_source: "document_date",
              summary,
            },
          ],
          limitations: ["Selected sources only"],
        };
      else if (path.endsWith("/timeline"))
        value = {
          entries: [
            {
              source_document_id: selected,
              event_date: "2026-01-02",
              date_source: "document_date",
              document,
            },
          ],
          pagination: { has_more: false },
        };
      else if (path.endsWith("/rag/queries"))
        value = {
          result: {
            status: post().question.includes("unknown")
              ? "insufficient"
              : "answered",
            answer: post().question.includes("unknown")
              ? "Insufficient evidence."
              : "Glucose: 90 mg/dL [C1]",
            mode: "synthetic-offline",
            citations: post().question.includes("unknown")
              ? []
              : [
                  {
                    id: "C1",
                    document_id: selected,
                    document_name: document.original_filename,
                    document_date: document.document_date,
                    upload_date: document.uploaded_at,
                    page: 1,
                    quote: "Glucose 90 mg/dL",
                  },
                ],
          },
        };
      else if (path === "/api/v1/doctor/records")
        value = { documents: [document], pagination: { has_more: false } };
      else if (path === "/api/v1/doctor/records/" + selected)
        value = { document };
      else {
        status = 403;
        value = { error: { code: "SHARE_ACCESS_DENIED" } };
      }
    } else {
      status = 404;
      value = { error: { code: "NOT_FOUND" } };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
      headers: { "cache-control": "no-store" },
    });
  });
  await page.goto(origin + "/#/share/" + reference);
  return {
    page,
    context,
    calls,
    revoke: () => {
      denied = true;
    },
  };
}
async function identify(page: Page) {
  await page.getByRole("button", { name: /Continue securely/ }).click();
  await page.getByLabel("Doctor name").fill("Synthetic Doctor");
  await page
    .getByLabel("Email", { exact: true })
    .fill("doctor@example.invalid");
  await page.getByRole("button", { name: /Send verification code/ }).click();
}
async function login(page: Page) {
  await identify(page);
  await page
    .getByLabel("Complete email verification code")
    .fill("complete.synthetic-code");
  await page.getByRole("button", { name: /Verify & open/ }).click();
  await expect(
    page.getByRole("heading", { name: /The records you can review/ }),
  ).toBeVisible();
}
test("P8-WEB-01 link/QR reference entry and identity gate show no medical data before OTP", async () => {
  const { page, context, calls } = await setup();
  assert.equal(new URL(page.url()).hash, "");
  await expect(page.getByText("selected-lab.pdf", { exact: true })).toHaveCount(
    0,
  );
  await identify(page);
  assert.equal(calls.filter((c) => c.startsWith("/api/v1/doctor/")).length, 0);
  await page
    .getByLabel("Complete email verification code")
    .fill("complete.synthetic-code");
  await page.getByRole("button", { name: /Verify & open/ }).click();
  await expect(
    page.getByText("selected-lab.pdf", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
    { local: 0, session: 0 },
  );
  await context.close();
});
test("P8-WEB-02 invalid OTP and expired challenge remain outside workspace; resend supported", async () => {
  const { page, context } = await setup({
    otpFailure: true,
    challengeSeconds: 1,
  });
  await identify(page);
  await page
    .getByLabel("Complete email verification code")
    .fill("invalid-code");
  await page.getByRole("button", { name: /Verify & open/ }).click();
  await expect(
    page.getByText(/Access expired, revoked or unavailable/),
  ).toBeVisible();
  await expect(
    page.getByText("Code expired. Request a new code."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Verify & open/ }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Resend code" }).click();
  await expect(
    page.getByText(/A verification code was requested/),
  ).toBeVisible();
  await context.close();
});
test("P8-WEB-03 selected records, filters, secure file view/download, scoped timeline/summary/RAG", async () => {
  const { page, context, calls } = await setup();
  await login(page);
  await expect(
    page.getByText("selected-lab.pdf", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search loaded records").fill("unshared");
  await expect(page.getByText("selected-lab.pdf", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Search loaded records").fill("");
  await page.getByRole("button", { name: /selected-lab.pdf/ }).click();
  await page
    .getByRole("button", { name: "View original", exact: true })
    .click();
  await expect(page.getByTitle("Authorized original document")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await page.getByRole("button", { name: "Close original" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original" }).click();
  assert.equal((await download).suggestedFilename(), "selected-lab.pdf");
  await page.getByRole("button", { name: "Load report summary" }).click();
  await expect(page.getByText(summary.text, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Timeline$/ }).click();
  await expect(
    page.getByText("Synthetic Hospital · Document date"),
  ).toBeVisible();
  await page.getByRole("button", { name: /Summary$/ }).click();
  await expect(page.getByText(summary.text, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Ask records$/ }).click();
  await page.getByLabel("Your question").fill("What is the Glucose?");
  await page.getByRole("button", { name: /Ask shared records/ }).click();
  await expect(page.getByText("C1 · selected-lab.pdf")).toBeVisible();
  await expect(page.getByText(/Page 1/)).toBeVisible();
  await page.getByLabel("Your question").fill("unknown");
  await page.getByRole("button", { name: /Ask shared records/ }).click();
  await expect(
    page.getByText("INSUFFICIENT EVIDENCE", { exact: true }),
  ).toBeVisible();
  assert.ok(
    calls.some((c) => c.endsWith("/view")) &&
      calls.some((c) => c.endsWith("/download")),
  );
  await context.close();
});
test("P8-WEB-04 revoke while open removes records, summaries, and original iframe on next denial", async () => {
  const { page, context, revoke } = await setup();
  await login(page);
  await page.getByRole("button", { name: /selected-lab.pdf/ }).click();
  await page
    .getByRole("button", { name: "View original", exact: true })
    .click();
  await expect(page.getByTitle("Authorized original document")).toBeVisible();
  revoke();
  await page.getByRole("button", { name: "Load report summary" }).click();
  await expect(page.getByText(/Access ended/)).toBeVisible();
  await expect(page.getByTitle("Authorized original document")).toHaveCount(0);
  await expect(page.getByText(/selected-lab.pdf/)).toHaveCount(0);
  await context.close();
});
test("P8-WEB-05 expiry while open clears sensitive content without a further request", async () => {
  const { page, context } = await setup({ expiry: 6000 });
  await login(page);
  await expect(
    page.getByText("selected-lab.pdf", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Access ended/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("selected-lab.pdf", { exact: true })).toHaveCount(
    0,
  );
  await context.close();
});
test("P8-WEB-06 responsive entry and workspace have no horizontal overflow", async () => {
  const { page, context } = await setup();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "../.private-evidence/prd-v2-phase8-20261029/doctor-entry-mobile.png",
    fullPage: true,
  });
  await login(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "../.private-evidence/prd-v2-phase8-20261029/doctor-workspace-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "../.private-evidence/prd-v2-phase8-20261029/doctor-workspace-desktop.png",
    fullPage: true,
  });
  await context.close();
});

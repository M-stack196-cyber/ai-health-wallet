// Phase R8: client build, security-setting and measurement checks that need no database.
// Run from frontend/:  node --import tsx --test tests/r8.quality.ts
//
// What this does NOT cover: installed Android/iOS devices, TalkBack/VoiceOver, a deployed stack, load tests
// and usability sessions with people. CFG-10 has no approved numeric thresholds in the repository, so the
// measurements below are recorded, not compared with an invented target.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "hw-r8-"));
after(() => rmSync(work, { recursive: true, force: true }));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const kb = (n: number) => Math.round(n / 102.4) / 10;
// Patterns that must never appear in a shipped client bundle.
const SECRET_SHAPES: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /AKIA[0-9A-Z]{16}/],
  ["bearer token literal", /Bearer [A-Za-z0-9._-]{30,}/],
  ["JWT literal", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["argon2 hash", /\$argon2id\$/],
];
function assertCleanBundle(dir: string, label: string) {
  const all = files(dir);
  assert.ok(all.length > 0, label + " produced no files");
  assert.deepEqual(all.filter((f) => f.endsWith(".map")), [], label + " must not ship source maps");
  assert.deepEqual(all.filter((f) => /(^|\/)\.env/.test(f)), [], label + " must not ship .env files");
  for (const file of all) {
    const text = readFileSync(file).toString("latin1");
    for (const [name, pattern] of SECRET_SHAPES) assert.ok(!pattern.test(text), label + ": " + name + " found in " + file);
  }
  return all;
}

test("R8-BUILD-01 patient mobile app exports Android and iOS bundles with no source maps, .env files or secret-shaped strings", () => {
  const out = join(work, "mobile");
  const run = spawnSync("npx", ["expo", "export", "--platform", "android", "--platform", "ios", "--max-workers", "2", "--output-dir", out], {
    cwd: join(frontend, "apps/patient"),
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_PUBLIC_API_URL: "https://api.example.invalid" },
    encoding: "utf8", timeout: 480000,
  });
  assert.equal(run.status, 0, "expo export failed: " + (run.stderr || run.stdout).slice(-600));
  const all = assertCleanBundle(out, "mobile export");
  const sizes: Record<string, number> = {};
  for (const platform of ["android", "ios"]) {
    const bundles = all.filter((f) => f.includes("/js/" + platform + "/"));
    assert.equal(bundles.length, 1, platform + " must have exactly one JavaScript bundle");
    sizes[platform] = kb(statSync(bundles[0]).size);
  }
  console.log("R8_MOBILE_BUNDLE_KB " + JSON.stringify(sizes));
});

test("R8-BUILD-02 mobile app settings: secure storage, HTTPS-only API, screen-capture blocking, no backup, no plain storage of tokens", () => {
  const app = join(frontend, "apps/patient");
  const config = JSON.parse(readFileSync(join(app, "app.json"), "utf8")).expo;
  assert.equal(config.android.allowBackup, false, "Android backup must stay off");
  assert.deepEqual(config.platforms.sort(), ["android", "ios", "web"]);
  assert.ok(config.plugins.includes("expo-secure-store"));
  assert.equal(config.updates.enabled, false, "over-the-air updates stay off");
  const platform = readFileSync(join(app, "src/platform.ts"), "utf8");
  assert.match(platform, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/, "refresh credential uses device-only secure storage");
  assert.match(platform, /startsWith\("https:\/\/"\)/, "API address must be HTTPS");
  assert.match(platform, /__DEV__/, "plain HTTP only in development");
  const entry = readFileSync(join(app, "App.tsx"), "utf8");
  assert.match(entry, /preventScreenCaptureAsync/, "screen capture is blocked while signed in");
  assert.match(entry, /allowScreenCaptureAsync/, "and released on sign-out");
  const sources = files(join(app, "src")).concat(join(app, "App.tsx")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.tsx"));
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/AsyncStorage|localStorage|sessionStorage/.test(text), file + " must not use plain storage");
  }
});

test("R8-BUILD-03 mobile colours: the palette meets the 4.5:1 WCAG AA reference for text on both backgrounds", () => {
  const source = readFileSync(join(frontend, "apps/patient/src/ui.tsx"), "utf8");
  const block = source.match(/export const palette = \{([\s\S]*?)\};/)![1];
  const palette = Object.fromEntries([...block.matchAll(/(\w+):\s*"(#[0-9a-fA-F]{3,6})"/g)].map((m) => [m[1], m[2]]));
  const lum = (hex: string) => {
    const h = hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const measured: Record<string, number> = {};
  for (const text of ["ink", "muted", "green", "amber"])
    for (const background of ["background", "paper"]) {
      measured[text + " on " + background] = ratio(palette[text], palette[background]);
      assert.ok(measured[text + " on " + background] >= 4.5, text + " on " + background + " = " + measured[text + " on " + background]);
    }
  assert.ok(ratio("#ffffff", palette.green) >= 4.5, "white text on the green button");
  console.log("R8_MOBILE_CONTRAST " + JSON.stringify(measured));
});

const staticTypes: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
function serve(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(root, path === "/" ? "index.html" : path);
    try {
      if (!file.startsWith(root)) throw new Error("outside");
      const body = readFileSync(file);
      res.writeHead(200, { "Content-Type": staticTypes[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: "http://127.0.0.1:" + (server.address() as { port: number }).port })));
}

for (const app of ["doctor", "admin"] as const) {
  test(`R8-BUILD-0${app === "doctor" ? 4 : 5} ${app} web app builds, ships no source maps or secret-shaped strings, and its first screen loads in Chrome (timing recorded, no target applied)`, async () => {
    const out = join(work, app);
    const run = spawnSync("npx", ["vite", "build", "--config", `apps/${app}/vite.config.ts`, "--outDir", out, "--emptyOutDir"], { cwd: frontend, encoding: "utf8", timeout: 240000 });
    assert.equal(run.status, 0, "vite build failed: " + (run.stderr || run.stdout).slice(-600));
    const all = assertCleanBundle(out, app + " build");
    const total = all.reduce((sum, f) => sum + statSync(f).size, 0);
    const { server, origin } = await serve(out);
    const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const loads: number[] = [];
      for (let i = 0; i < 7; i++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const start = performance.now();
        await page.goto(origin + "/", { waitUntil: "load" });
        await page.getByRole("heading").first().waitFor();
        loads.push(performance.now() - start);
        const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
        assert.equal(storage, 0, "nothing is stored in the browser on first load");
        await context.close();
      }
      loads.shift(); // first run warms the browser; not counted
      loads.sort((a, b) => a - b);
      console.log(`R8_WEB_LOAD_${app.toUpperCase()} ` + JSON.stringify({ total_kb: kb(total), runs: loads.length, first_screen_p50_ms: Math.round(loads[Math.floor(loads.length / 2)]), max_ms: Math.round(loads.at(-1)!) }));
    } finally {
      await browser.close();
      server.close();
    }
  });
}

// Render check used by up.sh: opens a web app in headless Chrome and requires real text on the page and no script errors.
// "The port answers" is not enough: the patient preview once served a blank page. Usage: node check-web.mjs <url> <expected text>
import { createRequire } from "node:module";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const [url, expected] = process.argv.slice(2);
if (!url || !expected) { console.error("usage: check-web.mjs <url> <expected text>"); process.exit(2); }
const browser = await chromium.launch({ executablePath: process.env.HW_CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let ok = false, reason = "";
try {
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.getByText(expected, { exact: false }).first().waitFor({ timeout: 60000 });
  ok = errors.length === 0; reason = errors.join("; ");
} catch (e) { reason = String(e.message).split("\n")[0].slice(0, 160); }
finally { await browser.close(); }
console.log(ok ? "render ok" : "render FAILED: " + reason);
process.exit(ok ? 0 : 1);

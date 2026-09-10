// Captures the popup (before and after translating the fixture page), the options page, and the
// translated fixture itself from headless Chromium, into docs/screenshots. Uses the chrome-smoke
// build for the same reason the smoke test does: automation cannot click the toolbar button.
// Run `npm run screenshots`.
import http from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const profileDir = path.join(root, ".tmp", "chromium-screenshot-profile");
const outDir = path.join(root, "docs", "screenshots");
const fixtureDir = path.join(root, "tests", "fixtures");

const server = http.createServer(async (request, response) => {
  const file = path.join(fixtureDir, path.basename(new URL(request.url, "http://127.0.0.1").pathname));
  let body = null;
  try {
    body = await readFile(file);
  } catch {
    body = null;
  }
  if (body) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
await mkdir(outDir, { recursive: true });

// GLOSSA_CHROMIUM_PATH picks a specific Chromium binary, for the same reason the smoke supports it:
// a firewall that allows outbound traffic per binary may not know about a fresh Playwright build.
const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: true,
  deviceScaleFactor: 2,
  colorScheme: "dark",
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`http://127.0.0.1:${port}/es.html`, { waitUntil: "load" });
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id ?? null, `http://127.0.0.1:${port}/es.html`);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 344, height: 420 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector("#action:not([disabled])", { timeout: 60_000 });
  await popup.selectOption("#target", "en");
  await popup.waitForFunction(() => /Download|Translate page/.test(document.getElementById("action")?.textContent ?? ""), null, { timeout: 60_000 });
  await popup.screenshot({ path: path.join(outDir, "popup-before.png") });

  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, { timeout: 240_000 });
  await popup.screenshot({ path: path.join(outDir, "popup-after.png") });
  await page.bringToFront();
  await page.screenshot({ path: path.join(outDir, "page-bilingual.png"), fullPage: false });

  // The light theme is a media query, so it needs a page that says it prefers light. Both themes
  // ship, and a screenshot of only one of them hides half of what a reader gets.
  const light = await context.newPage();
  await light.emulateMedia({ colorScheme: "light" });
  await light.setViewportSize({ width: 344, height: 420 });
  await light.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await light.waitForSelector("#action:not([disabled])", { timeout: 60_000 });
  await light.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, {
    timeout: 60_000
  });
  await light.screenshot({ path: path.join(outDir, "popup-light.png") });
  await light.close();

  const options = await context.newPage();
  await options.setViewportSize({ width: 900, height: 1250 });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => (document.getElementById("catalog-status")?.textContent ?? "").includes("Catalog"), null, { timeout: 60_000 });
  await options.screenshot({ path: path.join(outDir, "options.png"), fullPage: true });
  console.info(`screenshots: wrote 5 files to ${path.relative(root, outDir)}`);
} finally {
  await context.close();
  server.close();
}

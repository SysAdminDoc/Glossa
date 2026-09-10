// Accessibility check: run axe against the popup and the options page as the browser actually
// renders them, and against a translated fixture page so the bilingual blocks are judged in place.
// Run with `npm run smoke:a11y` after `npm run build -- --smoke`.
import http from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const profileDir = path.join(root, ".tmp", "a11y-profile");
const fixtureDir = path.join(root, "tests", "fixtures");

function assert(condition, message) {
  if (!condition) throw new Error(`a11y: ${message}`);
}

async function serveFixtures() {
  const server = http.createServer(async (request, response) => {
    const file = path.join(fixtureDir, path.basename(new URL(request.url, "http://127.0.0.1").pathname));
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

// Extension pages carry a strict CSP, so axe cannot be injected as a script tag. An init script is
// evaluated by the browser before the page's own scripts and is not subject to that policy.
async function withAxe(page) {
  await page.addInitScript({ path: axePath });
  return page;
}

async function audit(page, label) {
  const ready = await page.evaluate(() => typeof window.axe !== "undefined");
  assert(ready, `axe was not loaded into ${label}`);
  const result = await page.evaluate(async () => {
    // Colour contrast needs a real paint; everything else is structural.
    return window.axe.run(document, { resultTypes: ["violations"] });
  });
  const violations = result.violations.filter((v) => v.impact !== "minor" || v.id === "aria-hidden-focus");
  for (const violation of violations) {
    console.error(`a11y: ${label}: ${violation.id} (${violation.impact}) ${violation.help}`);
    for (const node of violation.nodes.slice(0, 3)) console.error(`         ${node.html.slice(0, 120)} | ${(node.any?.[0]?.message ?? "").slice(0, 160)}`);
  }
  console.info(`a11y: ${label}: ${violations.length} violation(s)`);
  return violations.length;
}

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
const { server, port } = await serveFixtures();
const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;

  const page = await withAxe(await context.newPage());
  await page.goto(`http://127.0.0.1:${port}/es.html`, { waitUntil: "load" });
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, `http://127.0.0.1:${port}/es.html`);

  let total = 0;
  const popup = await withAxe(await context.newPage());
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector("#action:not([disabled])", { timeout: 60_000 });
  total += await audit(popup, "popup");

  const options = await withAxe(await context.newPage());
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForTimeout(1500);
  total += await audit(options, "options");

  // Translate the fixture, then judge the bilingual blocks where they live.
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, {
    timeout: 240_000
  });
  total += await audit(page, "translated page");

  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll("glossa-translation")).map((block) => ({
      lang: block.getAttribute("lang"),
      dir: block.getAttribute("dir")
    }))
  );
  assert(labels.length > 0, "no translation blocks to check");
  const unlabelled = labels.filter((block) => block.lang !== "en" || (block.dir !== "ltr" && block.dir !== "rtl"));
  assert(unlabelled.length === 0, `${unlabelled.length} translation blocks carry no language or direction`);
  console.info(`a11y: ${labels.length} translation blocks all carry lang and dir`);

  assert(total === 0, `${total} accessibility violation(s)`);
  console.info("a11y: PASS");
} finally {
  await context.close();
  server.close();
}

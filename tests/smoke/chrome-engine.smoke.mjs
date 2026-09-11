// Chrome engine smoke: Chrome's built-in Translator ships only in branded Chrome (138 or later, on a
// desktop that meets its disk and GPU gate), so this drives installed Chrome rather than Playwright's
// Chromium. The chrome-smoke build is switched to the Chrome engine, the real popup downloads the
// pack from a real click and translates the Spanish fixture, and the run fails if anything reaches
// one of Mozilla's hosts.
//
// Branded Chrome has ignored --load-extension since 137, and Playwright passes it
// --disable-extensions by default. So that default is dropped, the browser gets
// --enable-unsafe-extension-debugging, and the extension goes in through CDP's
// Extensions.loadUnpacked. Run with `npm run smoke:chrome-engine`.
import http from "node:http";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const fixtureDir = path.join(root, "tests", "fixtures");
const english = JSON.parse(await readFile(path.join(root, "src", "extension", "_locales", "en", "messages.json"), "utf8"));
const MOZILLA = /(^|\.)mozilla\.(com|net)$|moz-fx-translations/;

function assert(condition, message) {
  if (!condition) throw new Error(`smoke:chrome-engine: ${message}`);
}

const server = http.createServer(async (request, response) => {
  try {
    const body = await readFile(path.join(fixtureDir, path.basename(new URL(request.url, "http://127.0.0.1").pathname)));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
// A fresh profile every run: a reused one would already hold the pack and skip the download path.
const profileDir = await mkdtemp(path.join(os.tmpdir(), "glossa-chrome-engine-"));
const started = Date.now();
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"]
});
const seen = [];
context.on("request", (request) => seen.push(request.url()));

// Evaluate inside the offscreen document, which Playwright hands out no page object for.
const browserSession = await context.browser().newBrowserCDPSession();
let nextMessage = 1;
const waiting = new Map();
browserSession.on("Target.receivedMessageFromTarget", ({ message }) => {
  const parsed = JSON.parse(message);
  waiting.get(parsed.id)?.(parsed);
  waiting.delete(parsed.id);
});
async function inOffscreen(expression) {
  const { targetInfos } = await browserSession.send("Target.getTargets");
  const target = targetInfos.find((info) => info.url.endsWith("/offscreen.html"));
  if (!target) return null;
  const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  const id = nextMessage++;
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  await browserSession.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })
  });
  return (await reply).result?.result?.value ?? null;
}

try {
  const { id: extensionId } = await browserSession.send("Extensions.loadUnpacked", { path: extensionPath });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  console.info(`smoke:chrome-engine: extension ${extensionId} loaded into ${context.browser().version()}`);

  // Switched before anything asks the engine a question. Opened with Bergamot selected, the options
  // page lists Bergamot's languages from Mozilla's catalog, which is right for Bergamot and would
  // make the no-Mozilla check at the end prove nothing. From here on the whole run must be clean,
  // the options page included.
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), engine: "chrome" } });
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const offered = await options.evaluate(() => ({
    translator: typeof self.Translator,
    hidden: document.getElementById("engine-field")?.hidden ?? null,
    value: document.getElementById("engine")?.value ?? null
  }));
  assert(offered.translator === "function", "this Chrome exposes no Translator API (needs Chrome 138+ on a qualifying desktop)");
  assert(offered.hidden === false, "the engine choice is hidden although the browser has the API");
  assert(offered.value === "chrome", `the engine choice shows "${offered.value}" instead of the stored setting`);
  // The control stores what it shows, in both directions.
  await options.selectOption("#engine", "bergamot");
  await options.waitForFunction(async () => (await chrome.storage.local.get("settings")).settings?.engine === "bergamot");
  await options.selectOption("#engine", "chrome");
  await options.waitForFunction(async () => (await chrome.storage.local.get("settings")).settings?.engine === "chrome");
  await options.close();
  console.info("smoke:chrome-engine: the options page offers the engine choice and stores it");

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/es.html`, { waitUntil: "load" });
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id ?? null, `http://127.0.0.1:${port}/es.html`);
  assert(tabId, "fixture tab not found by the service worker");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const downloadLabel = english.popupChromeDownloadAndTranslate.message;
  await popup.waitForFunction((label) => document.getElementById("action")?.textContent === label, downloadLabel, {
    timeout: 60_000
  });
  const status = await popup.$eval("#status", (element) => element.textContent);
  assert(/Spanish → English/.test(status ?? ""), `the popup did not name the pack it will download: "${status}"`);
  console.info(`smoke:chrome-engine: popup offers "${downloadLabel}" (${status})`);

  // A real click: the gesture Chrome requires before it downloads a pack.
  await popup.click("#action");
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("glossa-translation")).some((node) => /library/i.test(node.textContent ?? "")),
    null,
    { timeout: 300_000 }
  );
  const sample = await page.$eval("glossa-translation", (node) => node.textContent);
  console.info(`smoke:chrome-engine: page translated through Chrome's engine ("${sample}")`);
  await popup.waitForFunction(() => /Show original/.test(document.getElementById("action")?.textContent ?? ""), null, {
    timeout: 60_000
  });

  // Markup survives: the fixture's inline link is still a link inside its translation.
  const linked = await page.evaluate(() =>
    Array.from(document.querySelectorAll("glossa-translation")).some((node) => node.querySelector("a") !== null)
  );
  assert(linked, "inline links were lost in the translation");

  // With the pack on disk, a later translation needs no gesture: restore, then translate again from
  // the worker, which is how an "always" site and the context menu reach the engine.
  await popup.click("#action");
  await page.waitForFunction(() => document.querySelectorAll("glossa-translation").length === 0, null, { timeout: 30_000 });
  const again = await popup.evaluate(
    async (tab) => chrome.runtime.sendMessage({ type: "glossa:translate-page", tabId: tab }),
    tabId
  );
  assert(again?.translated === true && !again.lastError, `a translation without a gesture failed: ${JSON.stringify(again)}`);
  console.info(`smoke:chrome-engine: translated again with no gesture (${again.blocksDone} blocks)`);

  // Nothing may have gone to Mozilla. Page and popup requests are visible to Playwright; the
  // offscreen document is where the model store lives, so its own resource timeline is read too.
  const offscreenFetches = await inOffscreen(`performance.getEntriesByType("resource").map((entry) => entry.name)`);
  // The document closes itself after 15 idle seconds, and a timeline that is gone reads as clean.
  assert(offscreenFetches !== null, "the offscreen document was gone before its requests could be read");
  const popupFetches = await popup.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  const offending = [
    ...seen.map((url) => ["page", url]),
    ...offscreenFetches.map((url) => ["offscreen", url]),
    ...popupFetches.map((url) => ["popup", url])
  ].filter(([, url]) => {
    try {
      return MOZILLA.test(new URL(url).hostname) || MOZILLA.test(url);
    } catch {
      return false;
    }
  });
  assert(
    offending.length === 0,
    `requests reached Mozilla's hosts: ${offending.map(([where, url]) => `${where} ${url}`).join(", ")}`
  );
  console.info(
    `smoke:chrome-engine: no request to Mozilla (${seen.length} page requests, ${offscreenFetches.length} offscreen, ${popupFetches.length} popup)`
  );
  console.info(`smoke:chrome-engine: passed in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await context.close();
  server.close();
  await rm(profileDir, { recursive: true, force: true });
}

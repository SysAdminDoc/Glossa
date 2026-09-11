// Mirror smoke: point the chrome-smoke build at a model mirror on the loopback server and translate
// the Spanish fixture through the real popup. The run fails if any request reaches a Mozilla or
// Google host, and it also fails if the mirror's own files are missing from what the extension
// fetched: a clean network log only means something when the downloads it should contain are there.
// The mirror is built with tools/mirror-models.mjs into .tmp/mirror on first use (one es:en download
// from Mozilla, about 25 MB) and reused afterwards. Run with `npm run smoke:mirror`.
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const profileDir = path.join(root, ".tmp", "mirror-smoke-profile");
const mirrorDir = path.join(root, ".tmp", "mirror");
const fixtureDir = path.join(root, "tests", "fixtures");
const FORBIDDEN = /mozilla\.(com|net)|googleapis\.com|moz-fx-translations/;

function assert(condition, message) {
  if (!condition) throw new Error(`smoke:mirror: ${message}`);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(path.join(mirrorDir, "records.json")))) {
  console.info("smoke:mirror: building the es:en mirror in .tmp/mirror");
  const built = spawnSync(process.execPath, [path.join(root, "tools", "mirror-models.mjs"), "--out", mirrorDir, "--pairs", "es:en"], {
    stdio: "inherit"
  });
  assert(built.status === 0, "tools/mirror-models.mjs failed");
}

// What the mirror served, from the server's side. A request the extension made is here whatever
// Playwright can or cannot see of it.
const served = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/mirror/")) {
      const file = path.resolve(mirrorDir, decodeURIComponent(url.pathname.slice("/mirror/".length)));
      assert(file.startsWith(mirrorDir + path.sep), `request outside the mirror: ${url.pathname}`);
      const body = await readFile(file);
      served.push(url.pathname);
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
      response.end(body);
      return;
    }
    const body = await readFile(path.join(fixtureDir, path.basename(url.pathname)));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const mirrorUrl = `http://127.0.0.1:${port}/mirror/`;

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
const seen = [];
context.on("request", (request) => seen.push(request.url()));
const started = Date.now();

// The offscreen document's own resource timeline, read over CDP: Playwright does not see its
// requests, and it is where the model store fetches.
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
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  // Set before anything asks the engine a question, so not even the first catalog read goes out.
  await worker.evaluate(async (url) => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), mirrorUrl: url } });
  }, mirrorUrl);

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/es.html`, { waitUntil: "load" });
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id ?? null, `http://127.0.0.1:${port}/es.html`);
  assert(tabId, "fixture tab not found by the service worker");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.waitForFunction(() => /^Download .* and translate$/.test(document.getElementById("action")?.textContent ?? ""), null, {
    timeout: 60_000
  });
  console.info(`smoke:mirror: popup offers "${await popup.$eval("#action", (element) => element.textContent)}" from the mirror's catalog`);
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, { timeout: 240_000 });
  const intro = await page.$eval("#intro glossa-translation", (element) => element.textContent ?? "");
  assert(/library/i.test(intro), `the intro was not translated: "${intro}"`);
  console.info(`smoke:mirror: translated through mirrored models ("${intro.trim().slice(0, 60)}")`);

  const offscreenFetches = await inOffscreen(`performance.getEntriesByType("resource").map((entry) => entry.name)`);
  assert(offscreenFetches !== null, "the offscreen document was gone before its requests could be read");
  const popupFetches = await popup.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  const everything = [
    ...seen.map((url) => ["page", url]),
    ...offscreenFetches.map((url) => ["offscreen", url]),
    ...popupFetches.map((url) => ["popup", url])
  ];
  const forbidden = everything.filter(([, url]) => FORBIDDEN.test(url));
  assert(forbidden.length === 0, `requests left the mirror: ${forbidden.map(([where, url]) => `${where} ${url}`).join(", ")}`);
  // The control: the mirror's catalog and at least one model file must be in both logs, or the
  // check above would pass on a run that never downloaded anything.
  assert(served.includes("/mirror/records.json"), "the mirror never served its catalog");
  const servedFiles = served.filter((entry) => entry !== "/mirror/records.json");
  assert(servedFiles.length >= 2, `the mirror served ${servedFiles.length} model files`);
  assert(
    offscreenFetches.some((url) => url.startsWith(mirrorUrl) && !url.endsWith("records.json")),
    "the offscreen timeline does not show the model downloads, so it cannot vouch for anything"
  );
  console.info(`smoke:mirror: ${servedFiles.length} model files and the catalog came from the mirror, nothing from Mozilla or Google`);
  console.info(`smoke:mirror: PASS in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await context.close();
  server.close();
}

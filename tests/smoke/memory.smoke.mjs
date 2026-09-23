// Memory smoke: how big the engine's heap gets on the fixture set, and whether the engine lets it go
// when idle. The fixture is translated into English (one model), then French and German, which both
// pivot through English and share its English model, so the three routes hold three models, the
// most the worker keeps. After each, the worker reports its WebAssembly heap, which grows and never
// shrinks: the last reading is the peak.
// Then the idle timer: the engine's document must be gone after the default 15 seconds, and still
// there after 20 when the setting says a minute. Downloads three pairs (about 70 MB) on a fresh
// profile. Run with `npm run smoke:memory`.
import http from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const profileDir = path.join(root, ".tmp", "memory-smoke-profile");
const fixtureDir = path.join(root, "tests", "fixtures");
// The heap may not pass this. Set from the measured peak with headroom (see README, Memory).
const HEAP_CEILING_MB = Number(process.env.GLOSSA_HEAP_CEILING_MB ?? 480);

function assert(condition, message) {
  if (!condition) throw new Error(`smoke:memory: ${message}`);
}
const mb = (bytes) => Math.round(bytes / (1024 * 1024));

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

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

// The engine lives in the offscreen document, which Playwright hands out no page object for.
const browserSession = await context.browser().newBrowserCDPSession();
let nextMessage = 1;
const waiting = new Map();
browserSession.on("Target.receivedMessageFromTarget", ({ message }) => {
  const parsed = JSON.parse(message);
  waiting.get(parsed.id)?.(parsed);
  waiting.delete(parsed.id);
});
async function offscreenTarget() {
  const { targetInfos } = await browserSession.send("Target.getTargets");
  return targetInfos.find((info) => info.url.endsWith("/offscreen.html")) ?? null;
}
async function inOffscreen(expression) {
  const target = await offscreenTarget();
  if (!target) return null;
  const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  const id = nextMessage++;
  const reply = new Promise((resolve) => waiting.set(id, resolve));
  await browserSession.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })
  });
  const answer = await reply;
  await browserSession.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  return answer.result?.result?.value ?? null;
}

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const url = `http://127.0.0.1:${port}/es.html`;
  await page.goto(url, { waitUntil: "load" });
  const tabId = await worker.evaluate(async (target) => (await chrome.tabs.query({ url: target }))[0]?.id ?? null, url);
  assert(tabId, "fixture tab not found");
  // Any extension page can talk to the background; the options page is one.
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/options.html`);
  const send = (message) => ui.evaluate((m) => chrome.runtime.sendMessage(m), message);

  const readings = [];
  for (const target of ["en", "fr", "de"]) {
    await send({ type: "glossa:restore-page", tabId });
    const started = Date.now();
    const state = await send({ type: "glossa:translate-page", tabId, targetLanguage: target, sourceLanguage: "es" });
    assert(state?.translated === true && !state.lastError, `es -> ${target} failed: ${JSON.stringify(state)}`);
    const ping = await inOffscreen(`glossaEngineHost.handle({ target: "glossa-engine", type: "ping" })`);
    const { loaded, models } = await inOffscreen(`glossaEngineHost.call({ type: "status", id: 0 }).then(({ loaded, models }) => ({ loaded, models }))`);
    assert(ping && ping.heapBytes > 0, `the engine reported no heap: ${JSON.stringify(ping)}`);
    readings.push({ target, heapMb: mb(ping.heapBytes), loaded, models, seconds: Math.round((Date.now() - started) / 1000) });
    console.info(`smoke:memory: es -> ${target}: heap ${mb(ping.heapBytes)} MB, models ${JSON.stringify(models)}, routes ${JSON.stringify(loaded)} (${readings.at(-1).seconds} s)`);
  }
  const peak = Math.max(...readings.map((reading) => reading.heapMb));
  assert(peak <= HEAP_CEILING_MB, `the heap reached ${peak} MB, over the ${HEAP_CEILING_MB} MB ceiling`);
  assert(readings.at(-1).models.length <= 3, `more models stayed loaded than the limit: ${JSON.stringify(readings.at(-1).models)}`);
  // Three routes in three models is only possible with es->en shared between them; each loaded on
  // its own would take five, and the cap would have evicted routes.
  assert(readings.at(-1).loaded.length === 3, `the routes did not all fit, so the models were not shared: ${JSON.stringify(readings.at(-1).loaded)}`);

  // The idle timer, at the default: nothing is asked for 17 seconds, and the document is gone.
  await page.waitForTimeout(17_000);
  assert((await offscreenTarget()) === null, "the engine was still loaded 17 s after the last request, with a 15 s idle time");
  console.info("smoke:memory: with the default 15 s, the engine let its memory go");

  // And at a minute: 20 seconds later it is still there.
  await ui.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, engineIdleSeconds: 60 } });
  });
  await send({ type: "glossa:restore-page", tabId });
  const again = await send({ type: "glossa:translate-page", tabId, targetLanguage: "en", sourceLanguage: "es" });
  assert(again?.translated === true, `the translation for the idle check failed: ${JSON.stringify(again)}`);
  await page.waitForTimeout(20_000);
  assert((await offscreenTarget()) !== null, "the engine went away after 20 s although the setting says a minute");
  console.info("smoke:memory: with a minute set, the engine was still loaded after 20 s");
  console.info(`smoke:memory: PASS, peak heap ${peak} MB`);
} finally {
  await context.close();
  server.close();
}

// Browser smoke: load the unpacked chrome-smoke build in headless Chromium, open a Spanish
// fixture page from a loopback server, drive the real popup, and check what the page became.
// Every run starts from a fresh profile: Chromium keeps the previous build's service worker alive
// in a reused profile, which makes the test exercise stale code. The price is one es->en model
// download (about 25 MB compressed) per run. Run with `npm run smoke` after
// `npm run build -- --smoke`.
import http from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const profileDir = path.join(root, ".tmp", "chromium-smoke-profile");
const fixtureDir = path.join(root, "tests", "fixtures");

function assert(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`);
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

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
const { server, port } = await serveFixtures();
const started = Date.now();
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

const ALLOWED_HOSTS = new Set([
  "firefox.settings.services.mozilla.com",
  "firefox-settings-attachments.cdn.mozilla.net",
  "storage.googleapis.com"
]);
const seenHosts = [];
context.on("request", (request) => {
  const url = new URL(request.url());
  if (url.protocol === "chrome-extension:" || url.hostname === "127.0.0.1") return;
  if (!seenHosts.includes(url.hostname)) seenHosts.push(url.hostname);
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  console.info(`smoke: extension ${extensionId} loaded`);

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/es.html`, { waitUntil: "load" });
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, `http://127.0.0.1:${port}/es.html`);
  assert(tabId, "fixture tab not found by the service worker");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector("#action:not([disabled])", { timeout: 60_000 });

  const detected = await popup.$eval("#source", (select) => select.value);
  assert(detected === "es", `expected detected language es, got "${detected}"`);
  await popup.selectOption("#target", "en");
  await popup.waitForFunction(() => {
    const status = document.getElementById("status")?.textContent ?? "";
    return !status.includes("unavailable");
  }, null, { timeout: 60_000 });
  const label = await popup.$eval("#action", (button) => button.textContent);
  console.info(`smoke: action button reads "${label}"`);

  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, {
    timeout: 240_000
  });
  const status = await popup.$eval("#status", (element) => element.textContent);
  console.info(`smoke: popup status "${status}"`);

  // The intro paragraph must carry a bilingual block in English, and the original must survive.
  const intro = await page.$eval("#intro", (element) => ({
    original: element.childNodes[0]?.textContent ?? "",
    translation: element.querySelector("glossa-translation")?.textContent ?? "",
    unit: element.getAttribute("data-glossa-unit"),
    linkKept: Boolean(element.querySelector("glossa-translation a[href='#catalogo']"))
  }));
  console.info(`smoke: intro translation: ${intro.translation.trim().slice(0, 120)}`);
  assert(intro.unit === "bilingual", `intro unit state was ${intro.unit}`);
  assert(/biblioteca/.test(intro.original), "original Spanish text was removed");
  assert(/library/i.test(intro.translation), "intro translation does not mention the library");
  assert(intro.linkKept, "inline link was not preserved through translation");

  const title = await page.$eval("#title", (element) => element.querySelector("glossa-translation")?.textContent ?? "");
  assert(/welcome/i.test(title), `title translation was "${title}"`);

  const code = await page.$eval("#code", (element) => element.textContent);
  assert(code === 'const saludo = "hola mundo";', "pre block was modified");
  const brand = await page.$eval("#brand span[translate='no']", (element) => element.textContent);
  assert(brand === "Café Aurora", "translate=no span was modified");
  const room = await page.$eval("#rules .notranslate", (element) => element.textContent);
  assert(room === "Sala 3B", "notranslate element was modified");
  const inlineCode = await page.$eval("main p code", (element) => element.textContent);
  assert(inlineCode === "npm install", "inline code was modified");
  const codeLine = await page.$eval("main p code", (element) => element.closest("p")?.querySelector("glossa-translation")?.textContent ?? "");
  assert(/run\s+npm install\s+at/.test(codeLine), `spacing around inline code was lost: "${codeLine}"`);

  const shadow = await page.evaluate(() => {
    const root = document.getElementById("host")?.shadowRoot;
    const block = root?.querySelector("glossa-translation");
    return { text: block?.textContent ?? "", display: block ? getComputedStyle(block).display : "" };
  });
  assert(/shadow/i.test(shadow.text), `shadow root text was not translated: "${shadow.text}"`);
  assert(shadow.display === "block", `shadow root translation is not styled as a block (display: ${shadow.display})`);

  // Dynamic content: reveal the hidden paragraph and add a new one; the observer must catch both.
  await page.evaluate(() => {
    const late = document.getElementById("late");
    late.hidden = false;
    const fresh = document.createElement("p");
    fresh.id = "dynamic";
    fresh.textContent = "Este párrafo se añadió después de la traducción.";
    document.querySelector("main").append(fresh);
  });
  await page.waitForFunction(
    () => document.querySelector("#dynamic glossa-translation")?.textContent?.length > 0,
    null,
    { timeout: 120_000 }
  );
  const dynamic = await page.$eval("#dynamic glossa-translation", (element) => element.textContent);
  console.info(`smoke: dynamic paragraph: ${dynamic}`);
  assert(/paragraph|added/i.test(dynamic), "dynamic paragraph translation looks wrong");

  // Restore must leave no trace.
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Translate page", null, {
    timeout: 30_000
  });
  const leftovers = await page.evaluate(() => ({
    blocks: document.querySelectorAll("glossa-translation").length,
    units: document.querySelectorAll("[data-glossa-unit]").length,
    intro: document.getElementById("intro")?.textContent ?? ""
  }));
  assert(leftovers.blocks === 0 && leftovers.units === 0, `restore left ${leftovers.blocks} blocks and ${leftovers.units} units`);
  assert(/consultar el catálogo en línea/.test(leftovers.intro), "restore did not bring the original paragraph back");

  // Network audit: every request Playwright saw from the extension must go to a model host.
  // Requests from the offscreen document are not always surfaced by Playwright, so this is a
  // guard on what is observable, not a proof of the whole picture. The proof is the manifest:
  // the extension holds host permissions for those two hosts and nothing else.
  const offenders = seenHosts.filter((host) => !ALLOWED_HOSTS.has(host));
  console.info(`smoke: extension requests went to ${JSON.stringify(seenHosts)}`);
  assert(offenders.length === 0, `unexpected network hosts: ${offenders.join(", ")}`);

  console.info(`smoke: PASS in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await context.close();
  server.close();
}

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
// GLOSSA_CHROMIUM_PATH picks a specific Chromium binary. On a machine whose firewall denies
// outbound by default, a freshly downloaded Playwright build has no allow rule yet and every model
// request fails with ERR_NETWORK_ACCESS_DENIED; pointing at a build that does have one is the way
// through without touching the test itself.
const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
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

  const cardsBefore = await page.$eval("#cards", (grid) => grid.querySelectorAll("a").length);
  assert(cardsBefore === 2, `fixture card grid should hold 2 anchors, found ${cardsBefore}`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector("#action:not([disabled])", { timeout: 60_000 });

  // Chromium grants the manifest's hosts at install, so the permission notice must be invisible.
  // `hidden` alone is not enough: a class that sets `display` overrides it.
  const notice = await popup.$eval("#grant-row", (row) => ({
    display: getComputedStyle(row).display,
    height: row.getBoundingClientRect().height
  }));
  assert(
    notice.display === "none" && notice.height === 0,
    `the model-host permission notice is visible with the hosts granted (display ${notice.display})`
  );

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

  // An inline wrapper holding blocks must be walked into, not sent whole: a grid sent as one unit
  // comes back duplicated in bilingual mode and the anchor count doubles.
  const cards = await page.$eval("#cards", (grid) => ({
    anchors: grid.querySelectorAll("a").length,
    translatedNames: Array.from(grid.querySelectorAll(".name glossa-translation")).map((b) => b.textContent ?? ""),
    unitOnGrid: grid.getAttribute("data-glossa-unit")
  }));
  assert(cards.anchors === 2, `card grid anchors went from 2 to ${cards.anchors} after translation`);
  assert(cards.unitOnGrid === null, "the card grid itself was sent as one unit");
  assert(cards.translatedNames.length === 2, `expected 2 translated card names, got ${cards.translatedNames.length}`);

  // A paragraph that declares its own language is not part of the Spanish route. No Arabic model is
  // installed here, so it has to be left exactly as it was rather than pushed through es->en.
  const rtl = await page.$eval("#rtl", (element) => ({
    blocks: element.querySelectorAll("glossa-translation").length,
    unit: element.getAttribute("data-glossa-unit"),
    text: element.textContent ?? ""
  }));
  assert(rtl.blocks === 0, `the Arabic paragraph was translated through the Spanish route (${rtl.blocks} blocks)`);
  assert(rtl.unit === null, `the Arabic paragraph was marked as a unit (${rtl.unit})`);
  assert(rtl.text.trim() === "هذا النص مكتوب باللغة العربية.", "the Arabic text changed");

  // A url, an email address and a reference number have to come back byte for byte, spacing and all.
  const contact = await page.$eval("#contact glossa-translation", (block) => block.textContent ?? "");
  console.info(`smoke: contact line: ${contact}`);
  for (const literal of ["info@ejemplo.es", "https://ejemplo.es/catalogo?sala=3", "2026123456"]) {
    assert(contact.includes(literal), `"${literal}" did not survive translation: "${contact}"`);
  }
  assert(!contact.includes("ejemplo. es"), `a protected literal was split: "${contact}"`);

  const shadow = await page.evaluate(() => {
    const root = document.getElementById("host")?.shadowRoot;
    const block = root?.querySelector("glossa-translation");
    return { text: block?.textContent ?? "", display: block ? getComputedStyle(block).display : "" };
  });
  assert(/shadow/i.test(shadow.text), `shadow root text was not translated: "${shadow.text}"`);
  assert(shadow.display === "block", `shadow root translation is not styled as a block (display: ${shadow.display})`);

  // Dynamic content. Four kinds of change at once: a node added, a `hidden` paragraph revealed, the
  // text of a translated unit replaced in place, and a `<details>` panel opened. The observer has to
  // catch all four, and the edited unit must end up with exactly one translation, not two.
  await page.evaluate(() => {
    const late = document.getElementById("late");
    late.hidden = false;
    const fresh = document.createElement("p");
    fresh.id = "dynamic";
    fresh.textContent = "Este párrafo se añadió después de la traducción.";
    document.querySelector("main").append(fresh);
    document.getElementById("edited").firstChild.data = "Ahora este párrafo dice algo completamente distinto.";
    document.getElementById("det").open = true;
  });
  await page.waitForFunction(
    () => document.querySelector("#dynamic glossa-translation")?.textContent?.length > 0,
    null,
    { timeout: 120_000 }
  );
  const dynamic = await page.$eval("#dynamic glossa-translation", (element) => element.textContent);
  console.info(`smoke: dynamic paragraph: ${dynamic}`);
  assert(/paragraph|added/i.test(dynamic), "dynamic paragraph translation looks wrong");

  await page.waitForFunction(() => document.querySelector("#late glossa-translation")?.textContent?.length > 0, null, {
    timeout: 120_000
  });

  await page.waitForFunction(
    () => /different|says/i.test(document.querySelector("#edited glossa-translation")?.textContent ?? ""),
    null,
    { timeout: 120_000 }
  );
  const edited = await page.$eval("#edited", (element) => ({
    blocks: element.querySelectorAll("glossa-translation").length,
    original: element.firstChild?.textContent ?? "",
    translation: element.querySelector("glossa-translation")?.textContent ?? ""
  }));
  console.info(`smoke: edited paragraph: ${edited.translation}`);
  assert(edited.blocks === 1, `edited paragraph carries ${edited.blocks} translation blocks`);
  assert(/completamente distinto/.test(edited.original), "edited paragraph lost its new source text");

  await page.waitForFunction(() => document.querySelector("#panel glossa-translation")?.textContent?.length > 0, null, {
    timeout: 120_000
  });
  const panel = await page.$eval("#panel", (element) => element.querySelectorAll("glossa-translation").length);
  assert(panel === 1, `opened details panel carries ${panel} translation blocks`);

  // The engine must never be handed its own output. Insert a copy of a finished translation next to
  // a fresh Spanish paragraph: the Spanish one is the positive control that proves the observer ran
  // at all, and the copy must come out with no translation block under it.
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const echo = document.createElement("p");
    echo.id = "echo";
    echo.textContent = document.querySelector("#intro glossa-translation").textContent;
    const control = document.createElement("p");
    control.id = "control";
    control.textContent = "Este párrafo de control está escrito en español y debe traducirse.";
    main.append(echo, control);
  });
  await page.waitForFunction(
    () => document.querySelector("#control glossa-translation")?.textContent?.length > 0,
    null,
    { timeout: 120_000 }
  );
  const echoed = await page.$eval("#echo", (element) => ({
    blocks: element.querySelectorAll("glossa-translation").length,
    unit: element.getAttribute("data-glossa-unit")
  }));
  assert(echoed.blocks === 0, `a copy of our own translation was translated again (${echoed.blocks} blocks)`);
  assert(echoed.unit === null, `a copy of our own translation was marked as a unit (${echoed.unit})`);

  // Restore must leave no trace.
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Translate page", null, {
    timeout: 30_000
  });
  const leftovers = await page.evaluate(() => ({
    blocks: document.querySelectorAll("glossa-translation").length,
    units: document.querySelectorAll("[data-glossa-unit]").length,
    intro: document.getElementById("intro")?.textContent ?? "",
    anchors: document.querySelectorAll("#cards a").length
  }));
  assert(leftovers.anchors === 2, `restore left ${leftovers.anchors} card anchors instead of 2`);
  assert(leftovers.blocks === 0 && leftovers.units === 0, `restore left ${leftovers.blocks} blocks and ${leftovers.units} units`);
  assert(/consultar el catálogo en línea/.test(leftovers.intro), "restore did not bring the original paragraph back");

  // Replace mode has to put the translation into the page's own elements. A copy would look the
  // same and behave differently: this listener is on the element the page created, and it has to
  // still fire after the paragraph has been translated in place.
  await page.evaluate(() => {
    const link = document.querySelector("#intro a");
    window.__glossaClicks = 0;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.__glossaClicks++;
    });
    link.dataset.glossaProbe = "1";
  });
  await popup.click("#mode-replace");
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, {
    timeout: 240_000
  });
  const replaced = await page.evaluate(() => {
    const link = document.querySelector("#intro a");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return {
      sameNode: link?.dataset.glossaProbe === "1",
      clicks: window.__glossaClicks,
      text: link?.textContent ?? "",
      leftoverIds: document.querySelectorAll("[data-glossa-id]").length,
      unit: document.getElementById("intro")?.getAttribute("data-glossa-unit")
    };
  });
  console.info(`smoke: replace mode link "${replaced.text}", listener fired ${replaced.clicks} time(s)`);
  assert(replaced.unit === "replaced", `intro was ${replaced.unit} in replace mode`);
  assert(replaced.sameNode, "the page's own link was swapped for a copy");
  assert(replaced.clicks === 1, "the link's click listener did not survive replace mode");
  assert(/catalog/i.test(replaced.text), `the link text was not translated: "${replaced.text}"`);
  assert(replaced.leftoverIds === 0, `${replaced.leftoverIds} elements were left numbered`);

  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Translate page", null, {
    timeout: 30_000
  });
  const restoredLink = await page.$eval("#intro a", (link) => ({
    same: link.dataset.glossaProbe === "1",
    text: link.textContent ?? ""
  }));
  assert(restoredLink.same, "restore replaced the page's link with a copy");
  assert(/catálogo/.test(restoredLink.text), `restore left the link translated: "${restoredLink.text}"`);
  await popup.click("#mode-bilingual");

  // Settings have to change behaviour, not just persist. With the default on, an editable block is
  // left alone; with it off, the same block is translated. Anything else means a dead control.
  const editableDefault = await page.$eval("#editable", (element) => element.querySelectorAll("glossa-translation").length);
  assert(editableDefault === 0, "an editable block was translated while the skip setting was on");

  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...stored.settings, skipFormFields: false } });
  });
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Show original", null, {
    timeout: 240_000
  });
  await page.waitForFunction(() => document.querySelectorAll("#editable glossa-translation").length === 1, null, {
    timeout: 120_000
  });
  const editableOff = await page.$eval("#editable glossa-translation", (block) => block.textContent ?? "");
  console.info(`smoke: editable block with the skip off: ${editableOff}`);
  assert(/edit/i.test(editableOff), `editable block translation looks wrong: "${editableOff}"`);

  // And a "never" rule for this host turns the whole thing off, with the reason in the popup.
  await popup.click("#action");
  await popup.waitForFunction(() => document.getElementById("action")?.textContent === "Translate page", null, {
    timeout: 30_000
  });
  await worker.evaluate(async (host) => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...stored.settings, siteRules: { [host]: "never" } } });
  }, "127.0.0.1");
  await popup.reload();
  await popup.waitForFunction(
    () => document.getElementById("action")?.textContent === "Turned off for this page",
    null,
    { timeout: 30_000 }
  );
  const blockedStatus = await popup.$eval("#status", (element) => element.textContent ?? "");
  console.info(`smoke: blocked status "${blockedStatus}"`);
  assert(/127\.0\.0\.1/.test(blockedStatus), `the popup did not name the blocked host: "${blockedStatus}"`);
  assert(await popup.$eval("#action", (button) => button.disabled), "the action button stayed enabled on a never host");
  const afterRule = await page.evaluate(() => document.querySelectorAll("glossa-translation").length);
  assert(afterRule === 0, `a never host still carried ${afterRule} translations`);

  // An "always" rule has to translate on its own, with no popup and no click. The smoke build holds
  // a loopback host permission, which is what such a rule needs on a real site.
  await worker.evaluate(async (host) => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...stored.settings, siteRules: { [host]: "always" } } });
  }, "127.0.0.1");
  const auto = await context.newPage();
  await auto.goto(`http://127.0.0.1:${port}/es.html`, { waitUntil: "load" });
  await auto.waitForFunction(
    () => (document.querySelector("#intro glossa-translation")?.textContent ?? "").length > 0,
    null,
    { timeout: 120_000 }
  );
  const autoText = await auto.$eval("#intro glossa-translation", (block) => block.textContent ?? "");
  console.info(`smoke: always-rule page translated itself: ${autoText.trim().slice(0, 80)}`);
  assert(/library/i.test(autoText), `automatic translation looks wrong: "${autoText}"`);
  await auto.close();

  // A page with no prose must be reported as undetectable rather than guessed at. This is where
  // most wrong verdicts come from: a wall of numbers, dates and urls that CLD will happily label.
  const numbers = await context.newPage();
  await numbers.goto(`http://127.0.0.1:${port}/numbers.html`, { waitUntil: "load" });
  const numbersTabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, `http://127.0.0.1:${port}/numbers.html`);
  const numbersPopup = await context.newPage();
  await numbersPopup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${numbersTabId}`);
  await numbersPopup.waitForFunction(
    () => (document.getElementById("action")?.textContent ?? "") !== "Checking page…",
    null,
    { timeout: 60_000 }
  );
  const numbersLabel = await numbersPopup.$eval("#action", (button) => button.textContent);
  const numbersSource = await numbersPopup.$eval("#source", (select) => select.value);
  console.info(`smoke: a page of numbers reads "${numbersLabel}" with source "${numbersSource}"`);
  assert(numbersSource === "", `a page of numbers was detected as "${numbersSource}"`);
  assert(
    numbersLabel === "Choose the page language",
    `a page of numbers was offered for translation ("${numbersLabel}")`
  );
  // Choosing a language by hand is a decision, not a guess: it has to be remembered for the host.
  await numbersPopup.selectOption("#source", "es");
  await numbersPopup.waitForTimeout(500);
  await numbersPopup.close();

  const numbersPopupAgain = await context.newPage();
  await numbersPopupAgain.goto(`chrome-extension://${extensionId}/popup.html?tabId=${numbersTabId}`);
  await numbersPopupAgain.waitForFunction(
    () => (document.getElementById("source")?.value ?? "") !== "",
    null,
    { timeout: 30_000 }
  );
  const remembered = await numbersPopupAgain.$eval("#source", (select) => select.value);
  console.info(`smoke: the popup reopened with source "${remembered}"`);
  assert(remembered === "es", `the manual language choice was not remembered (got "${remembered}")`);
  await numbersPopupAgain.close();
  await numbers.close();
  // Every fixture shares this host, so the remembered choice cannot be left behind.
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...stored.settings, sourceLanguages: {} } });
  });

  // The selection popover floats over the page, so it has to behave: dismissible with Escape, a
  // close target big enough to hit, clear of the text it explains, and outside any editor.
  await page.evaluate(() => {
    const target = document.getElementById("intro");
    const range = document.createRange();
    range.selectNodeContents(target.firstChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    window.__editableBefore = document.getElementById("editable").innerHTML;
  });
  await worker.evaluate(async (id) => {
    await chrome.tabs.sendMessage(id, {
      type: "glossa:page-command",
      command: "translate-selection",
      targetLanguage: "en"
    });
  }, tabId);
  await page.waitForFunction(
    () => {
      const body = document.querySelector(".glossa-popover-body");
      return body && body.textContent && !body.textContent.includes("…");
    },
    null,
    { timeout: 120_000 }
  );
  const popover = await page.evaluate(() => {
    const box = document.querySelector(".glossa-popover");
    const close = document.querySelector(".glossa-popover-close");
    const rect = box.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const selectionRect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    const overlaps =
      rect.left < selectionRect.right &&
      rect.right > selectionRect.left &&
      rect.top < selectionRect.bottom &&
      rect.bottom > selectionRect.top;
    return {
      text: document.querySelector(".glossa-popover-body").textContent ?? "",
      insideEditor: Boolean(document.querySelector("#editable .glossa-popover")),
      parentIsRoot: box.parentElement === document.documentElement,
      closeWidth: closeRect.width,
      closeHeight: closeRect.height,
      overlaps,
      editableUnchanged: document.getElementById("editable").innerHTML === window.__editableBefore
    };
  });
  console.info(`smoke: selection popover says: ${popover.text.trim().slice(0, 60)}`);
  assert(/library/i.test(popover.text), `the selection was not translated: "${popover.text}"`);
  assert(popover.parentIsRoot && !popover.insideEditor, "the popover was inserted inside the page's content");
  assert(popover.editableUnchanged, "the popover changed the editable region's content");
  assert(
    popover.closeWidth >= 24 && popover.closeHeight >= 24,
    `the close control is ${popover.closeWidth}x${popover.closeHeight}, under the 24 px minimum`
  );
  assert(!popover.overlaps, "the popover covers the selection it is explaining");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".glossa-popover") === null, null, { timeout: 5_000 });
  console.info("smoke: Escape closed the popover");

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

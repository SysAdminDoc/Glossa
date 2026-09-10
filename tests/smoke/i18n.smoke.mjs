// Checks that the interface really follows the browser's UI language. Chrome picks the _locales
// folder from the UI language, which is set by the --lang flag, not by Accept-Language, so this
// launches a Spanish browser and reads the popup and options pages back.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(root, "dist", "chrome-smoke");
const profileDir = path.join(root, ".tmp", "i18n-profile");

function assert(condition, message) {
  if (!condition) throw new Error(`i18n: ${message}`);
}

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
const executablePath = process.env.GLOSSA_CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--lang=es"]
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;

  const uiLanguage = await worker.evaluate(() => chrome.i18n.getUILanguage());
  console.info(`i18n: the browser reports its interface language as ${uiLanguage}`);
  assert(uiLanguage.startsWith("es"), `expected a Spanish browser, got ${uiLanguage}`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => document.querySelector(".label")?.textContent !== "Page language", null, {
    timeout: 30_000
  });
  const popupText = await popup.evaluate(() => document.body.innerText);
  console.info(`i18n: popup says "${popupText.split("\n").filter(Boolean).slice(0, 3).join(" / ")}"`);
  for (const spanish of ["Idioma de la página", "Traducir a", "Ajustes e idiomas"]) {
    assert(popupText.includes(spanish), `the popup is missing "${spanish}"`);
  }
  assert(!popupText.includes("Page language"), "the popup is still in English");

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.title !== "Glossa settings", null, { timeout: 30_000 });
  const optionsText = await options.evaluate(() => document.body.innerText);
  for (const spanish of ["Traducción", "Idiomas que lees", "Reglas por sitio", "Modelos de idioma", "Privacidad"]) {
    assert(optionsText.includes(spanish), `the options page is missing "${spanish}"`);
  }
  assert(await options.title() === "Ajustes de Glossa", `the options page title is "${await options.title()}"`);
  console.info("i18n: PASS");
} finally {
  await context.close();
}

import { api } from "../shared/api.ts";
import { formatBytes } from "../shared/hash.ts";
import { knownLanguageCodes, languageName } from "../shared/languages.ts";
import type {
  ModelsListResponse,
  PageState,
  PageStatusResponse,
  ProgressEvent,
  RouteStatus
} from "../shared/messages.ts";
import { loadSettings, saveSettings, type DisplayMode } from "../shared/settings.ts";
import { sendUi } from "../shared/ui-client.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const sourceSelect = $<HTMLSelectElement>("source");
const targetSelect = $<HTMLSelectElement>("target");
const actionButton = $<HTMLButtonElement>("action");
const statusLine = $<HTMLParagraphElement>("status");
const progressBox = $<HTMLDivElement>("progress");
const progressFill = $<HTMLDivElement>("progress-fill");
const progressText = $<HTMLDivElement>("progress-text");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode"));

let tabId: number | null = null;
let page: PageState | null = null;
let route: RouteStatus | null = null;
// Set when the user's own settings rule this page out: a "never" rule for the host, or a page in a
// language they said they read.
let blocked: string | null = null;
let displayMode: DisplayMode = "bilingual";
let busy = false;

function setStatus(text: string, tone: "" | "ok" | "warn" | "error" = ""): void {
  statusLine.textContent = text;
  statusLine.className = `status ${tone}`.trim();
}

function fillLanguages(select: HTMLSelectElement, codes: string[], selected: string | null, includeUnknown: boolean): void {
  select.replaceChildren();
  if (includeUnknown) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Detect automatically";
    select.append(option);
  }
  const unique = Array.from(new Set(codes)).sort((a, b) => languageName(a).localeCompare(languageName(b)));
  for (const code of unique) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = languageName(code);
    select.append(option);
  }
  if (selected && unique.includes(selected)) {
    select.value = selected;
  } else if (includeUnknown) {
    select.value = "";
  }
}

function setMode(mode: DisplayMode): void {
  displayMode = mode;
  for (const button of modeButtons) {
    button.classList.toggle("active", button.dataset["mode"] === mode);
  }
}

function showProgress(fraction: number | null, text: string): void {
  progressBox.hidden = false;
  if (fraction === null) {
    progressFill.classList.add("indeterminate");
    progressFill.style.width = "";
  } else {
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }
  progressText.textContent = text;
}

function hideProgress(): void {
  progressBox.hidden = true;
  progressFill.classList.remove("indeterminate");
  progressFill.style.width = "0";
}

function render(): void {
  const injected = page?.injected === true;
  const source = sourceSelect.value || page?.detectedLanguage || "";
  const target = targetSelect.value;
  actionButton.classList.remove("secondary");

  if (blocked && !page?.translated) {
    actionButton.textContent = "Turned off for this page";
    actionButton.disabled = true;
    return;
  }
  if (!injected) {
    actionButton.textContent = "Translate page";
    actionButton.disabled = busy;
    return;
  }
  if (page?.translated) {
    actionButton.textContent = "Show original";
    actionButton.classList.add("secondary");
    actionButton.disabled = busy;
    return;
  }
  if (page?.translating) {
    actionButton.textContent = "Translating…";
    actionButton.disabled = true;
    return;
  }
  if (!source) {
    actionButton.textContent = "Choose the page language";
    actionButton.disabled = true;
    return;
  }
  if (source === target) {
    actionButton.textContent = "Already in this language";
    actionButton.disabled = true;
    return;
  }
  if (route && route.hops === null) {
    actionButton.textContent = "No model for this pair";
    actionButton.disabled = true;
    return;
  }
  if (route && !route.installed) {
    actionButton.textContent = `Download ${formatBytes(route.downloadBytes)} and translate`;
    actionButton.disabled = busy;
    return;
  }
  actionButton.textContent = "Translate page";
  actionButton.disabled = busy;
}

async function refreshRoute(): Promise<void> {
  if (blocked) {
    // Nothing to ask the engine about: the user's settings already ruled this page out.
    route = null;
    render();
    return;
  }
  const source = sourceSelect.value || page?.detectedLanguage || null;
  const target = targetSelect.value;
  if (!source || !target || source === target) {
    route = null;
    render();
    return;
  }
  route = await sendUi<RouteStatus>({ type: "glossa:route-status", sourceLanguage: source, targetLanguage: target });
  if (route.catalogError && route.hops === null) {
    setStatus(`Model catalog unavailable: ${route.catalogError}`, "error");
  } else if (route.hops === null) {
    setStatus(`No on-device model can translate ${languageName(source)} to ${languageName(target)} yet.`, "warn");
  } else if (route.hops.length === 2) {
    setStatus(`Translates through English (two models, ${formatBytes(route.hops.reduce((s, h) => s + h.bytes, 0))} on disk).`);
  } else if (!route.installed) {
    setStatus(`${languageName(source)} → ${languageName(target)} model is ${formatBytes(route.hops[0]?.bytes ?? 0)} once installed.`);
  } else {
    setStatus("Model ready. Translation runs on this device.", "ok");
  }
  render();
}

async function loadPage(): Promise<void> {
  if (tabId === null) return;
  const response = await sendUi<PageStatusResponse>({ type: "glossa:page-status", tabId });
  blocked = response.blocked;
  if (blocked) setStatus(blocked, "warn");
  if (response.page.injected) {
    page = response.page;
    route = response.route;
    if (page.detectedLanguage && sourceSelect.value === "") {
      sourceSelect.value = page.detectedLanguage;
      if (sourceSelect.value !== page.detectedLanguage) sourceSelect.value = "";
    }
    if (blocked) {
      // Already shown above; a stale page error must not replace it.
    } else if (page.lastError) {
      setStatus(page.lastError, "error");
    } else if (page.translated) {
      setStatus(`Translated ${page.blocksDone} blocks on this device.`, "ok");
    }
  } else {
    page = null;
    route = null;
    if (response.page.reason === "unsupported-page") {
      setStatus("This page cannot be translated (browser or extension page).", "warn");
      actionButton.disabled = true;
      return;
    }
    if (!blocked) setStatus("Click Translate to read this page in your language.");
  }
  render();
}

async function onAction(): Promise<void> {
  if (tabId === null || busy) return;
  busy = true;
  render();
  try {
    if (page?.translated) {
      page = await sendUi<PageState>({ type: "glossa:restore-page", tabId });
      hideProgress();
      setStatus("Original page restored.", "ok");
      render();
      return;
    }
    const source = sourceSelect.value || undefined;
    const target = targetSelect.value;
    await saveSettings({ targetLanguage: target, displayMode });
    if (route && !route.installed) {
      showProgress(0, "Starting download…");
    } else {
      showProgress(null, "Translating…");
    }
    setStatus("");
    const result = await sendUi<PageState | undefined>({
      type: "glossa:translate-page",
      tabId,
      targetLanguage: target,
      ...(source ? { sourceLanguage: source } : {})
    });
    if (result) page = result;
    hideProgress();
    if (page?.lastError) {
      setStatus(page.lastError, "error");
    } else if (page?.translated) {
      setStatus(`Translated ${page.blocksDone} blocks on this device.`, "ok");
    }
    await refreshRoute();
  } catch (error) {
    hideProgress();
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    busy = false;
    render();
  }
}

api.runtime.onMessage.addListener((message: unknown) => {
  const event = message as ProgressEvent;
  if (!event || event.type !== "glossa:progress") return;
  if (event.phase === "download") {
    const fraction = event.totalBytes > 0 ? event.loadedBytes / event.totalBytes : null;
    showProgress(fraction, `Downloading ${event.pairKey}: ${formatBytes(event.loadedBytes)} of ${formatBytes(event.totalBytes)}`);
  } else if (event.phase === "store" || event.phase === "verify" || event.phase === "decompress") {
    showProgress(null, `Verifying ${event.file ?? event.pairKey}…`);
  } else if (event.phase === "load") {
    showProgress(null, `Loading ${event.pairKey} into the engine…`);
  } else if (event.phase === "error") {
    hideProgress();
    setStatus(event.error ?? "Download failed", "error");
  }
  const state = message as { type?: string; state?: PageState };
  if (state.type === "glossa:page-state" && state.state) {
    page = state.state;
    if (page.translating && page.blocksTotal > 0) {
      showProgress(page.blocksDone / page.blocksTotal, `Translated ${page.blocksDone} of ${page.blocksTotal} blocks`);
    }
    render();
  }
});

async function init(): Promise<void> {
  const manifest = api.runtime.getManifest();
  $("version").textContent = `v${manifest.version}`;

  const settings = await loadSettings();
  setMode(settings.displayMode);

  let codes = knownLanguageCodes();
  try {
    const models = await sendUi<ModelsListResponse>({ type: "glossa:models:list" });
    if (models.targets.length > 0) codes = Array.from(new Set([...models.sources, ...models.targets]));
    if (models.catalogError && models.targets.length === 0) {
      setStatus(`Model catalog unavailable: ${models.catalogError}`, "error");
    }
  } catch {
    // Fall back to the static list; the route check will surface the real error.
  }
  fillLanguages(sourceSelect, codes, null, true);
  fillLanguages(targetSelect, codes, settings.targetLanguage, false);

  // The popup normally acts on the active tab. When opened as a full page (the browser smoke test
  // does this, since nothing can click a toolbar button in automation) a tabId query parameter
  // names the tab instead.
  const params = new URLSearchParams(location.search);
  const override = Number(params.get("tabId"));
  const tabUrl = params.get("tabUrl");
  if (Number.isInteger(override) && override > 0) {
    tabId = override;
  } else if (tabUrl) {
    const [tab] = await api.tabs.query({ url: tabUrl });
    tabId = tab?.id ?? null;
  } else {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
  }
  if (tabId === null) {
    setStatus("No active tab.", "warn");
    return;
  }
  try {
    await loadPage();
    await refreshRoute();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }

  sourceSelect.addEventListener("change", () => void refreshRoute());
  targetSelect.addEventListener("change", () => {
    void saveSettings({ targetLanguage: targetSelect.value });
    void refreshRoute();
  });
  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      setMode(button.dataset["mode"] as DisplayMode);
      void saveSettings({ displayMode: displayMode });
    });
  }
  actionButton.addEventListener("click", () => void onAction());
  $("open-options").addEventListener("click", (event) => {
    event.preventDefault();
    void api.runtime.openOptionsPage();
  });
}

void init();

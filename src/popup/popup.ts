import { api } from "../shared/api.ts";
import { MODEL_ORIGINS } from "../shared/catalog.ts";
import { formatBytes } from "../shared/hash.ts";
import { localize, t } from "../shared/i18n.ts";
import { knownLanguageCodes, languageName } from "../shared/languages.ts";
import type {
  ModelsListResponse,
  PageState,
  PageStatusResponse,
  ProgressEvent,
  RouteStatus
} from "../shared/messages.ts";
import { hostOf, loadSettings, saveSettings, type DisplayMode } from "../shared/settings.ts";
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
const progressBar = $<HTMLDivElement>("progress-bar");
const progressFill = $<HTMLDivElement>("progress-fill");
const progressText = $<HTMLDivElement>("progress-text");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode"));
const grantRow = $<HTMLDivElement>("grant-row");
const grantButton = $<HTMLButtonElement>("grant");

let tabId: number | null = null;
let page: PageState | null = null;
let route: RouteStatus | null = null;
// Set when the user's own settings rule this page out: a "never" rule for the host, or a page in a
// language they said they read.
let blocked: string | null = null;
// Firefox hands out `host_permissions` as optional ones, and a temporary install gets none at all,
// so a download can fail with nothing but a network error to show for it.
let modelHostsGranted = true;
// False only on a machine whose processor cannot run the engine, where nothing else matters.
let engineSupported = true;
// The host of the tab the popup is acting on, so a manual language choice can be remembered for it.
let pageHost: string | null = null;
let displayMode: DisplayMode = "bilingual";
let busy = false;
// The user chose Chrome's built-in translator and this browser has it. Its packs are downloaded
// from here, because only a click on the extension's own page can start that download.
let chromeEngine = false;

// Set once the engine reports it cannot run here. Nothing else may write over that: a status line
// saying "model ready" under a button saying "not supported on this computer" is a contradiction,
// and the reason the user cannot translate is the part they need.
let statusLocked = false;

function setStatus(text: string, tone: "" | "ok" | "warn" | "error" = "", lock = false): void {
  if (statusLocked && !lock) return;
  statusLine.textContent = text;
  statusLine.className = `status ${tone}`.trim();
  if (lock) statusLocked = true;
}

function fillLanguages(select: HTMLSelectElement, codes: string[], selected: string | null, includeUnknown: boolean): void {
  select.replaceChildren();
  if (includeUnknown) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("popupDetectAutomatically");
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
    const active = button.dataset["mode"] === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function showProgress(fraction: number | null, text: string): void {
  progressBox.hidden = false;
  if (fraction === null) {
    progressFill.classList.add("indeterminate");
    progressFill.style.width = "";
    progressBar.removeAttribute("aria-valuenow");
  } else {
    const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(percent));
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

  // Chrome's own packs do not come from Mozilla's hosts, so their permission does not matter then.
  grantRow.hidden = modelHostsGranted || chromeEngine;
  if (!engineSupported) {
    actionButton.textContent = t("popupUnsupportedButton");
    actionButton.disabled = true;
    return;
  }
  if (blocked && !page?.translated) {
    actionButton.textContent = t("popupBlockedButton");
    actionButton.disabled = true;
    return;
  }
  if (!modelHostsGranted && !chromeEngine && !page?.translated) {
    actionButton.textContent = t("popupGrantFirst");
    actionButton.disabled = true;
    return;
  }
  if (!injected) {
    actionButton.textContent = t("popupTranslate");
    actionButton.disabled = busy;
    return;
  }
  if (page?.translated) {
    actionButton.textContent = t("popupShowOriginal");
    actionButton.classList.add("secondary");
    actionButton.disabled = busy;
    return;
  }
  if (page?.translating) {
    actionButton.textContent = t("popupTranslating");
    actionButton.disabled = true;
    return;
  }
  if (!source) {
    actionButton.textContent = t("popupChooseLanguage");
    actionButton.disabled = true;
    return;
  }
  if (source === target) {
    actionButton.textContent = t("popupAlreadyTarget");
    actionButton.disabled = true;
    return;
  }
  if (route && route.hops === null) {
    actionButton.textContent = t("popupNoModel");
    actionButton.disabled = true;
    return;
  }
  if (route && !route.installed) {
    actionButton.textContent = chromeEngine
      ? t("popupChromeDownloadAndTranslate")
      : t("popupDownloadAndTranslate", formatBytes(route.downloadBytes));
    actionButton.disabled = busy;
    return;
  }
  actionButton.textContent = t("popupTranslate");
  actionButton.disabled = busy;
}

// A permission check, not a request: asking may only happen from a click handler.
async function checkModelHosts(): Promise<void> {
  try {
    modelHostsGranted = await api.permissions.contains({ origins: [...MODEL_ORIGINS] });
  } catch {
    // A browser that cannot answer is treated as granted; the download error will say otherwise.
    modelHostsGranted = true;
  }
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
  if (chromeEngine) {
    if (route.hops === null) {
      setStatus(t("popupChromeNoPair", languageName(source), languageName(target)), "warn");
    } else if (!route.installed) {
      setStatus(t("popupChromePackNeeded", `${languageName(source)} → ${languageName(target)}`));
    } else {
      setStatus(t("popupChromeReady"), "ok");
    }
    render();
    return;
  }
  if (route.catalogError && route.hops === null) {
    setStatus(t("popupCatalogUnavailable", route.catalogError ?? ""), "error");
  } else if (route.hops === null) {
    setStatus(t("popupNoRoute", languageName(source), languageName(target)), "warn");
  } else if (route.hops.length === 2) {
    setStatus(t("popupPivot", formatBytes(route.hops.reduce((sum, hop) => sum + hop.bytes, 0))));
  } else if (!route.installed) {
    setStatus(t("popupModelSize", `${languageName(source)} → ${languageName(target)}`, formatBytes(route.hops[0]?.bytes ?? 0)));
  } else {
    setStatus(t("popupModelReady"), "ok");
  }
  render();
}

async function loadPage(): Promise<void> {
  if (tabId === null) return;
  const response = await sendUi<PageStatusResponse>({ type: "glossa:page-status", tabId });
  blocked = response.blocked;
  if (blocked) setStatus(blocked, "warn");
  pageHost = hostOf(response.page.url);
  if (response.page.injected) {
    page = response.page;
    route = response.route;
    // A language the user picked for this host beats a guess, but not a confident detection: a host
    // that serves several languages would otherwise be stuck on whichever one was chosen first.
    const remembered = pageHost ? (await loadSettings()).sourceLanguages[pageHost] : undefined;
    const preferred = page.confident ? (page.detectedLanguage ?? remembered) : (remembered ?? page.detectedLanguage);
    if (preferred && sourceSelect.value === "") {
      sourceSelect.value = preferred;
      if (sourceSelect.value !== preferred) sourceSelect.value = "";
    }
    if (remembered && preferred === remembered && remembered !== page.detectedLanguage) {
      setStatus(t("popupRemembered", languageName(remembered)));
    }
    if (blocked) {
      // Already shown above; a stale page error must not replace it.
    } else if (page.lastError) {
      setStatus(page.lastError, "error");
    } else if (page.translated) {
      setStatus(t("popupTranslatedBlocks", String(page.blocksDone)), "ok");
    }
  } else {
    page = null;
    route = null;
    if (response.page.reason === "unsupported-page") {
      setStatus(t("popupUnsupportedPage"), "warn");
      actionButton.disabled = true;
      return;
    }
    if (!blocked) setStatus(t("popupInvite"));
  }
  render();
}

// Chrome's pack for the pair, downloaded here with the click as the gesture Chrome asks for. The
// translator made for it is thrown away: the offscreen document makes its own for the page, and
// with the pack on disk it needs no gesture to do that.
async function downloadChromePack(source: string, target: string): Promise<void> {
  const translatorApi = self.Translator;
  if (!translatorApi) throw new Error(t("pageChromeUnavailable"));
  const translator = await translatorApi.create({
    sourceLanguage: source,
    targetLanguage: target,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        showProgress(event.loaded, t("popupChromeDownloading", String(Math.round(event.loaded * 100))));
      });
    }
  });
  translator.destroy();
}

async function onAction(): Promise<void> {
  if (tabId === null || busy) return;
  busy = true;
  render();
  try {
    if (page?.translated) {
      page = await sendUi<PageState>({ type: "glossa:restore-page", tabId });
      hideProgress();
      setStatus(t("popupRestored"), "ok");
      render();
      return;
    }
    const source = sourceSelect.value || undefined;
    const target = targetSelect.value;
    // Chrome starts a pack download only inside a user gesture, and this click is the one there is,
    // so the download begins before the first await while the click still counts.
    const packSource = source ?? page?.detectedLanguage ?? null;
    const packDownload = chromeEngine && route && !route.installed && packSource ? downloadChromePack(packSource, target) : null;
    packDownload?.catch(() => undefined);
    if (packDownload) showProgress(0, t("popupChromeDownloading", "0"));
    await saveSettings({ targetLanguage: target, displayMode });
    if (packDownload) {
      await packDownload;
      showProgress(null, t("popupTranslating"));
    } else if (route && !route.installed) {
      showProgress(0, t("popupStartingDownload"));
    } else {
      showProgress(null, t("popupTranslating"));
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
      setStatus(t("popupTranslatedBlocks", String(page.blocksDone)), "ok");
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
    showProgress(fraction, t("popupDownloading", event.pairKey, formatBytes(event.loadedBytes), formatBytes(event.totalBytes)));
  } else if (event.phase === "store" || event.phase === "verify" || event.phase === "decompress") {
    showProgress(null, t("popupVerifying", event.file ?? event.pairKey));
  } else if (event.phase === "load") {
    showProgress(null, t("popupLoadingEngine", event.pairKey));
  } else if (event.phase === "error") {
    hideProgress();
    setStatus(event.error ?? t("popupDownloadFailed"), "error");
  }
  const state = message as { type?: string; state?: PageState };
  if (state.type === "glossa:page-state" && state.state) {
    page = state.state;
    if (page.translating && page.blocksTotal > 0) {
      showProgress(page.blocksDone / page.blocksTotal, t("popupTranslatingProgress", String(page.blocksDone), String(page.blocksTotal)));
    }
    render();
  }
});

async function init(): Promise<void> {
  localize();
  const manifest = api.runtime.getManifest();
  $("version").textContent = `v${manifest.version}`;

  const settings = await loadSettings();
  setMode(settings.displayMode);
  chromeEngine = settings.engine === "chrome" && typeof self.Translator?.create === "function";

  let codes = knownLanguageCodes();
  try {
    const models = await sendUi<ModelsListResponse>({ type: "glossa:models:list" });
    engineSupported = models.engineSupported !== false;
    if (!engineSupported) {
      setStatus(t("popupUnsupportedCpu"), "error", true);
    }
    // Chrome's engine covers its own set of languages, which the Mozilla catalog knows nothing about.
    if (models.targets.length > 0 && !chromeEngine) codes = Array.from(new Set([...models.sources, ...models.targets]));
    if (models.catalogError && models.targets.length === 0 && !chromeEngine) {
      setStatus(t("popupCatalogUnavailable", models.catalogError ?? ""), "error");
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
    setStatus(t("popupNoTab"), "warn");
    return;
  }
  try {
    await checkModelHosts();
    await loadPage();
    await refreshRoute();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }

  sourceSelect.addEventListener("change", () => {
    // Remember the choice for this host: the detector will make the same mistake next time.
    // Choosing "Detect automatically" is how that choice is taken back, so it clears the entry.
    const host = pageHost;
    if (host) {
      void loadSettings().then((current) => {
        const next = { ...current.sourceLanguages };
        if (sourceSelect.value) next[host] = sourceSelect.value;
        else delete next[host];
        return saveSettings({ sourceLanguages: next });
      });
    }
    void refreshRoute();
  });
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
  // The request has to happen inside the click handler: both browsers refuse it otherwise.
  grantButton.addEventListener("click", () => {
    api.permissions.request({ origins: [...MODEL_ORIGINS] }).then(
      async (granted) => {
        modelHostsGranted = granted;
        if (granted) {
          setStatus(t("popupGrantAllowed"), "ok");
          // No reload needed: the next fetch carries the new permission.
          await refreshRoute();
        } else {
          setStatus(t("popupGrantRefused"), "warn");
        }
        render();
      },
      (error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error), "error");
      }
    );
  });

  actionButton.addEventListener("click", () => void onAction());
  $("open-options").addEventListener("click", (event) => {
    event.preventDefault();
    void api.runtime.openOptionsPage();
  });
}

void init();

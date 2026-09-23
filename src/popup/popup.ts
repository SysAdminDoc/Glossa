import { api, hasOffscreenApi } from "../shared/api.ts";
import { MODEL_ORIGINS, mirrorPermissionPattern } from "../shared/catalog.ts";
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
import { describeQuality } from "../shared/quality.ts";
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
// The user's own model mirror, when there is one. Downloads need that host and none of Mozilla's.
let mirrorUrl = "";

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

// A translated page, and the reason some blocks were left in their own language when the engine
// gave one. That reason is a warning beside the count, not an error in place of it.
function showTranslated(state: PageState): void {
  const done = t("popupTranslatedBlocks", String(state.blocksDone));
  if (state.notice) setStatus(`${done} ${state.notice}`, "warn");
  else setStatus(done, "ok");
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
  // Showing the original needs no engine, no permission and no model, so nothing below may take
  // that button away from a translated page.
  if (page?.translated) {
    actionButton.textContent = t("popupShowOriginal");
    actionButton.classList.add("secondary");
    actionButton.disabled = busy;
    return;
  }
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

// The hosts downloads will come from: the user's mirror when there is one, Mozilla's otherwise.
function modelOrigins(): string[] {
  return mirrorUrl ? [mirrorPermissionPattern(mirrorUrl)] : [...MODEL_ORIGINS];
}

// A permission check, not a request: asking may only happen from a click handler.
async function checkModelHosts(): Promise<void> {
  try {
    modelHostsGranted = await api.permissions.contains({ origins: modelOrigins() });
  } catch {
    // A browser that cannot answer is treated as granted; the download error will say otherwise.
    modelHostsGranted = true;
  }
}

// Before a download, how the pair's model compares with an online translator. Nothing once the
// model is on disk, and nothing when no score is known (a mirror, Chrome's engine, offline).
function renderQuality(): void {
  const box = $<HTMLParagraphElement>("quality");
  const hops = route && !route.installed ? route.quality : undefined;
  box.hidden = !hops;
  if (!hops) return;
  const { label, detail, lower } = describeQuality(hops);
  box.textContent = label;
  box.title = detail;
  box.classList.toggle("lower", lower);
}

async function refreshRoute(): Promise<void> {
  if (blocked) {
    // Nothing to ask the engine about: the user's settings already ruled this page out.
    route = null;
    renderQuality();
    render();
    return;
  }
  const source = sourceSelect.value || page?.detectedLanguage || null;
  const target = targetSelect.value;
  if (!source || !target || source === target) {
    route = null;
    renderQuality();
    render();
    return;
  }
  route = await sendUi<RouteStatus>({ type: "glossa:route-status", sourceLanguage: source, targetLanguage: target });
  renderQuality();
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
      showTranslated(page);
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
  renderQuality();
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
      monitor.addEventListener("downloadprogress", (event) => showPackProgress(event.loaded));
    }
  });
  translator.destroy();
}

function showPackProgress(fraction: number): void {
  showProgress(fraction, t("popupChromeDownloading", String(Math.round(fraction * 100))));
}

// Asks the engine's own document to start the same download with this click, so the download and the
// page's translation carry on if the popup closes (ChromeEngine.claimPack says why the popup's own
// download is not enough). A message sent from here carries the click to the extension pages that
// receive it, for a few seconds. That document closes when idle, and one the first message had to
// start received it without the click, so a refusal is asked once more.
async function claimChromePack(source: string, target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answer = await sendUi<{ claimed?: boolean }>({ type: "glossa:chrome-pack", sourceLanguage: source, targetLanguage: target });
      if (answer?.claimed) return true;
    } catch {
      return false;
    }
  }
  return false;
}

// A download or a translation started from an earlier popup carries on without it. Opening the
// popup again picks up where that one left off: the live bar now, the result when the page reports it.
async function resumeProgress(): Promise<void> {
  if (!page?.translating) return;
  if (chromeEngine) {
    // Chrome tells only the document that started a download how far along it is. The engine's
    // document passes that on as it comes, so the bar fills in from the next report.
    if (route && !route.installed) showProgress(null, t("popupChromePackArriving"));
    else showProgress(null, t("popupTranslating"));
    return;
  }
  const hops = new Set(route?.hops?.map((hop) => hop.pairKey) ?? []);
  const { downloads } = await sendUi<{ downloads: Array<{ pairKey: string; loadedBytes: number; totalBytes: number }> }>({
    type: "glossa:models:downloads"
  });
  const download = downloads.find((entry) => hops.has(entry.pairKey));
  if (download) {
    showDownload(download.pairKey, download.loadedBytes, download.totalBytes);
  } else if (page.blocksTotal > 0) {
    showProgress(page.blocksDone / page.blocksTotal, t("popupTranslatingProgress", String(page.blocksDone), String(page.blocksTotal)));
  } else {
    showProgress(null, t("popupTranslating"));
  }
}

function showDownload(key: string, loadedBytes: number, totalBytes: number): void {
  const fraction = totalBytes > 0 ? loadedBytes / totalBytes : null;
  showProgress(fraction, t("popupDownloading", key, formatBytes(loadedBytes), formatBytes(totalBytes)));
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
    // Chrome starts a pack download only inside a user gesture, and this click is the one there is.
    // The engine's own document takes the download on with it first: that one outlives the popup.
    // Only if it cannot does the popup download the pack itself, still inside the few seconds a
    // click counts for, and then the page waits for it here, as a translation handed over early
    // would find neither the pack nor a click. One download either way: two for the same pack, one
    // of them dropped when the popup closed, is the case that stalled in the smoke.
    const packSource = source ?? page?.detectedLanguage ?? null;
    const packNeeded = chromeEngine && route && !route.installed && packSource;
    if (packNeeded) showPackProgress(0);
    const claimed = packNeeded ? await claimChromePack(packSource, target) : false;
    const pack = packNeeded && !claimed ? downloadChromePack(packSource, target) : null;
    await saveSettings({ targetLanguage: target, displayMode });
    if (pack) {
      await pack;
      showProgress(null, t("popupTranslating"));
    } else if (packNeeded) {
      // The engine's document reports the download as it goes; the bar follows its reports.
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
      showTranslated(page);
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

api.runtime.onMessage.addListener((message: unknown, sender) => {
  const event = message as ProgressEvent;
  if (event?.type === "glossa:progress") {
    if (event.phase === "download") {
      showDownload(event.pairKey, event.loadedBytes, event.totalBytes);
    } else if (event.phase === "pack") {
      showPackProgress(event.totalBytes > 0 ? event.loadedBytes / event.totalBytes : 0);
    } else if (event.phase === "store" || event.phase === "verify" || event.phase === "decompress") {
      showProgress(null, t("popupVerifying", event.file ?? event.pairKey));
    } else if (event.phase === "load") {
      showProgress(null, t("popupLoadingEngine", event.pairKey));
    } else if (event.phase === "error") {
      hideProgress();
      setStatus(event.error ?? t("popupDownloadFailed"), "error");
    }
    return;
  }
  const state = message as { type?: string; state?: PageState };
  // Every content script in every tab reports here. Only the tab this popup acts on counts, and only
  // its top frame is the page it shows; the other frames are in the count the background merges.
  if (state?.type !== "glossa:page-state" || !state.state) return;
  if (sender.tab?.id !== tabId) return;
  if ((sender.frameId ?? 0) !== 0) {
    // A frame that finishes after the top one is how a reopened popup learns the page is done.
    if (!busy && page?.translating) rereadSoon();
    return;
  }
  const wasTranslating = page?.translating === true;
  page = state.state;
  if (page.translating && page.blocksTotal > 0) {
    showProgress(page.blocksDone / page.blocksTotal, t("popupTranslatingProgress", String(page.blocksDone), String(page.blocksTotal)));
  } else if (wasTranslating && !page.translating && !busy) {
    // A translation this popup did not start (an earlier popup's, or an "always" site's) has ended,
    // at least in the top frame. Say so now, and read the whole tab back for the full count and for
    // a frame still working. The click handler reports its own.
    hideProgress();
    if (page.lastError) setStatus(page.lastError, "error");
    else if (page.translated) showTranslated(page);
    rereadSoon();
  }
  render();
});

// Read the tab back whole, every frame counted, once its reports have stopped for a moment. The bar
// stays up only while some frame is still translating.
let rereadTimer: number | null = null;
function rereadSoon(): void {
  if (rereadTimer !== null) window.clearTimeout(rereadTimer);
  rereadTimer = window.setTimeout(() => {
    rereadTimer = null;
    // A click since then drives the page itself, and reports what it did.
    if (busy) return;
    loadPage().then(
      () => {
        if (page?.translating) showProgress(null, t("popupTranslating"));
        else hideProgress();
      },
      () => undefined
    );
  }, 300);
}

async function init(): Promise<void> {
  localize();
  const manifest = api.runtime.getManifest();
  $("version").textContent = `v${manifest.version}`;

  const settings = await loadSettings();
  setMode(settings.displayMode);
  chromeEngine = settings.engine === "chrome" && typeof self.Translator?.create === "function";
  mirrorUrl = settings.mirrorUrl;
  // The permission notice names the host that is missing, which with a mirror is the user's own.
  if (mirrorUrl) $("grant-text").textContent = t("popupGrantMirror", new URL(mirrorUrl).host);

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
  // Chrome's translator was chosen, but this Chrome does not have it (an older one, or the API
  // switched off). Say so, rather than the "no model" an empty route would otherwise produce.
  // Firefox is not this case: the background uses Bergamot there whatever the setting says.
  if (settings.engine === "chrome" && hasOffscreenApi && !chromeEngine) {
    engineSupported = false;
    setStatus(t("pageChromeUnavailable"), "error", true);
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
    await resumeProgress();
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
    api.permissions.request({ origins: modelOrigins() }).then(
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

import { api, hasOffscreenApi } from "../shared/api.ts";
import { normalizeLanguageTag } from "../shared/catalog.ts";
import {
  ENGINE_TARGET,
  type DistributiveOmit,
  isEngineRequest,
  isGlossaMessage,
  type DetectRequest,
  type DetectResponse,
  type EngineRequest,
  type EngineResponse,
  type PageCommand,
  type PageState,
  type PageStatusResponse,
  type TranslateRequest,
  type TranslateResponse,
  type UiRequest
} from "../shared/messages.ts";
import { blockedReason, catalogMaxAgeMs, hostOf, loadSettings } from "../shared/settings.ts";
import { languageName } from "../shared/languages.ts";
import { EngineHost } from "../engine/engine-host.ts";

// Background: routes messages between the content script, the UI pages, and the engine. On Chrome
// this is a service worker and the engine sits in an offscreen document; on Firefox this is a
// persistent-enough event page that hosts the engine directly.

const MENU_TRANSLATE_PAGE = "glossa-translate-page";
const MENU_TRANSLATE_SELECTION = "glossa-translate-selection";
const localEngine: EngineHost | null = hasOffscreenApi ? null : new EngineHost();
let creating: Promise<void> | null = null;

// ---- engine bridge ----

// Chrome only. The label is what the Firefox build drops (esbuild `dropLabels`), so that bundle
// carries no call to an API Firefox does not have, which is what AMO's linter refuses. Firefox
// hosts the engine in its background page and never needs a second document.
async function ensureEngineHostDocument(): Promise<void> {
  CHROME_ONLY: {
    if (creating) return creating;
    creating = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
      });
      if (contexts.length > 0) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the on-device translation engine in a Web Worker"
      });
    })().finally(() => {
      creating = null;
    });
    return creating;
  }
}

async function engineCall<T>(request: DistributiveOmit<EngineRequest, "target">): Promise<T> {
  // The engine host cannot read settings on Chrome, so the one setting that changes which catalog
  // records are usable rides along with the request.
  const settings = await loadSettings();
  const full = {
    target: ENGINE_TARGET,
    experimental: settings.experimentalModels,
    catalogMaxAgeMs: catalogMaxAgeMs(settings),
    ...request
  } as EngineRequest;
  if (localEngine) {
    return (await localEngine.handle(full)) as T;
  }
  await ensureEngineHostDocument();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = (await api.runtime.sendMessage(full)) as EngineResponse | undefined;
      if (!response) throw new Error("The engine did not answer");
      if (!response.ok) throw new Error(response.error);
      return response.result as T;
    } catch (error) {
      lastError = error;
      const text = error instanceof Error ? error.message : String(error);
      // The offscreen document may still be booting on the first call after creation.
      if (!/Receiving end does not exist|did not answer/.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---- content script plumbing ----

async function ensureContentScript(tabId: number): Promise<void> {
  const probe = await sendToTab<PageState | undefined>(tabId, { type: "glossa:page-command", command: "status" });
  if (probe?.injected) return;
  await api.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function sendToTab<T>(tabId: number, message: PageCommand): Promise<T | undefined> {
  try {
    return (await api.tabs.sendMessage(tabId, message)) as T;
  } catch {
    return undefined;
  }
}

async function translatePage(tabId: number, targetOverride?: string, sourceOverride?: string): Promise<PageState | undefined> {
  const settings = await loadSettings();
  let url: string | null = null;
  try {
    url = (await api.tabs.get(tabId)).url ?? null;
  } catch {
    url = null;
  }
  // A "never" rule for the host means exactly that: nothing is injected and nothing is sent.
  const ruleBlock = blockedReason(settings, url, null, languageName);
  if (ruleBlock) {
    const current = await sendToTab<PageState>(tabId, { type: "glossa:page-command", command: "status" });
    return current ? { ...current, lastError: ruleBlock } : undefined;
  }
  await ensureContentScript(tabId);
  const command: PageCommand = {
    type: "glossa:page-command",
    command: "translate",
    targetLanguage: targetOverride ?? settings.targetLanguage,
    displayMode: settings.displayMode,
    showOriginalOnHover: settings.showOriginalOnHover,
    skipFormFields: settings.skipFormFields,
    ...(sourceOverride ? { sourceLanguage: sourceOverride } : {})
  };
  return sendToTab<PageState>(tabId, command);
}

async function detectLanguage(request: DetectRequest): Promise<DetectResponse> {
  const fromHtml = normalizeLanguageTag(request.htmlLang);
  // An empty sample means the page holds no prose to judge. Guessing from a handful of characters
  // is where most wrong verdicts come from, so say nothing and let the user choose.
  if (!request.sample.trim()) {
    return { language: fromHtml, confident: false };
  }
  try {
    const result = await api.i18n.detectLanguage(request.sample);
    const best = result.languages
      .map((entry) => ({ language: normalizeLanguageTag(entry.language), percentage: entry.percentage }))
      .filter((entry): entry is { language: string; percentage: number } => entry.language !== null)
      .sort((a, b) => b.percentage - a.percentage)[0];
    if (!best) return { language: fromHtml, confident: false };
    // Two independent signals agreeing is worth more than one confident detector: CLD is reliable
    // on long prose and wrong often enough on short or mixed pages.
    const agrees = fromHtml !== null && fromHtml === best.language;
    if (agrees) return { language: best.language, confident: true };
    if (result.isReliable && best.percentage >= 70) {
      return { language: best.language, confident: true };
    }
    // Unsure: offer the page's own declaration if it has one, and mark it as a guess either way.
    return { language: fromHtml ?? best.language, confident: false };
  } catch {
    // Detection is best effort; the html lang attribute is the fallback.
  }
  return { language: fromHtml, confident: false };
}

async function translateFragments(request: TranslateRequest): Promise<TranslateResponse> {
  try {
    const result = await engineCall<{ fragments: string[]; inferenceMs: number }>({
      type: "translate",
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      fragments: request.fragments
    });
    return { ok: true, fragments: result.fragments, inferenceMs: result.inferenceMs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pageStatus(tabId: number): Promise<PageStatusResponse> {
  const settings = await loadSettings();
  let url: string | null = null;
  try {
    url = (await api.tabs.get(tabId)).url ?? null;
  } catch {
    url = null;
  }
  // A host the user turned Glossa off for is never touched, not even to detect its language.
  const hostBlock = blockedReason(settings, url, null, languageName);
  if (hostBlock) {
    return { page: { injected: false, url, reason: "site-never" }, route: null, blocked: hostBlock };
  }
  // Opening the popup is the user gesture that grants activeTab, so the content script can go in
  // now and detect the page language before anything is translated.
  let injectError: string | null = null;
  if (url && /^(https?|file):/.test(url)) {
    try {
      await ensureContentScript(tabId);
    } catch (error) {
      // Browser-internal or store pages refuse injection; the popup shows the reason.
      injectError = error instanceof Error ? error.message : String(error);
    }
  }
  const page = await sendToTab<PageState>(tabId, { type: "glossa:page-command", command: "status" });
  if (!page) {
    const reason = injectError ?? (url && /^(https?|file):/.test(url) ? "not-injected" : "unsupported-page");
    return { page: { injected: false, url, reason }, route: null, blocked: null };
  }
  const source = page.detectedLanguage;
  const target = page.targetLanguage ?? settings.targetLanguage;
  // A page in a language the user reads is detected but never offered.
  const blocked = blockedReason(settings, url, source, languageName);
  const route = source && source !== target && !blocked
    ? await engineCall<PageStatusResponse["route"]>({ type: "route-status", sourceLanguage: source, targetLanguage: target })
    : null;
  return { page, route, blocked };
}

async function handleUiRequest(request: UiRequest): Promise<unknown> {
  switch (request.type) {
    case "glossa:page-status":
      return pageStatus(request.tabId);
    case "glossa:translate-page":
      return translatePage(request.tabId, request.targetLanguage, request.sourceLanguage);
    case "glossa:restore-page":
      return sendToTab<PageState>(request.tabId, { type: "glossa:page-command", command: "restore" });
    case "glossa:translate-selection": {
      const settings = await loadSettings();
      await ensureContentScript(request.tabId);
      return sendToTab(request.tabId, {
        type: "glossa:page-command",
        command: "translate-selection",
        targetLanguage: settings.targetLanguage
      });
    }
    case "glossa:models:list":
      return engineCall({ type: "models-list" });
    case "glossa:models:install":
      return engineCall({ type: "ensure-route", sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage });
    case "glossa:models:delete":
      return engineCall({ type: "models-delete", pairKey: request.pairKey });
    case "glossa:catalog:refresh":
      return engineCall({ type: "catalog-refresh" });
    case "glossa:route-status":
      return engineCall({ type: "route-status", sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage });
  }
}

api.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Engine traffic is answered by the offscreen document on Chrome, or by the local host on
  // Firefox where this listener is the only one.
  if (isEngineRequest(message)) {
    if (!localEngine) return false;
    localEngine
      .handle(message)
      .then((result) => sendResponse({ ok: true, result } satisfies EngineResponse))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies EngineResponse)
      );
    return true;
  }
  if (!isGlossaMessage(message)) return false;

  let work: Promise<unknown>;
  if (message.type === "glossa:detect") {
    work = detectLanguage(message as DetectRequest);
  } else if (message.type === "glossa:translate") {
    work = translateFragments(message as TranslateRequest);
  } else if (message.type === "glossa:page-state") {
    // A content script reporting state; nothing to do beyond a badge.
    const state = (message as unknown as { state: PageState }).state;
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void updateBadge(tabId, state);
    return false;
  } else if (message.type === "glossa:progress") {
    return false;
  } else {
    work = handleUiRequest(message as UiRequest);
  }
  work.then(sendResponse, (error: unknown) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

async function updateBadge(tabId: number, state: PageState): Promise<void> {
  try {
    const text = state.translating ? "…" : state.translated ? "✓" : "";
    await api.action.setBadgeText({ tabId, text });
    await api.action.setBadgeBackgroundColor({ tabId, color: "#7c6cf2" });
  } catch {
    // The tab may already be gone.
  }
}

// ---- automatic translation ----

// A host with an "always" rule translates itself on load. Reading that page needs a host permission
// for it, which is optional and granted from the options page, so nothing happens on a site the
// user has not opted into. Detection runs first, so a page in a language they read is left alone.
async function maybeAutoTranslate(tabId: number, url: string | null): Promise<void> {
  if (!url || !/^https?:/.test(url)) return;
  const settings = await loadSettings();
  const host = hostOf(url);
  if (!host || settings.siteRules[host] !== "always") return;
  let allowed = false;
  try {
    // A match pattern carries no port, so the origin cannot be used as one: a page on
    // http://127.0.0.1:8080 has to be asked about as http://127.0.0.1/*.
    const parsed = new URL(url);
    allowed = await api.permissions.contains({ origins: [`${parsed.protocol}//${parsed.hostname}/*`] });
  } catch {
    allowed = false;
  }
  if (!allowed) return;
  const status = await pageStatus(tabId);
  if (status.blocked || !status.page.injected || status.page.translated || status.page.translating) return;
  await translatePage(tabId);
}

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  void maybeAutoTranslate(tabId, tab.url ?? null).catch(() => undefined);
});

// ---- context menus ----

function installMenus(): void {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: MENU_TRANSLATE_PAGE,
      title: "Translate this page with Glossa",
      contexts: ["page", "frame", "link", "image"]
    });
    api.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: "Translate selection with Glossa",
      contexts: ["selection"]
    });
  });
}

api.runtime.onInstalled.addListener(() => {
  installMenus();
});
api.runtime.onStartup.addListener(() => {
  installMenus();
});

api.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  if (info.menuItemId === MENU_TRANSLATE_PAGE) {
    void translatePage(tabId);
  } else if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
    void handleUiRequest({ type: "glossa:translate-selection", tabId });
  }
});

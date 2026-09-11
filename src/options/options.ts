import { api } from "../shared/api.ts";
import { localize, t } from "../shared/i18n.ts";
import { formatBytes } from "../shared/hash.ts";
import { mirrorPermissionPattern, normalizeMirrorUrl } from "../shared/catalog.ts";
import { knownLanguageCodes, languageName } from "../shared/languages.ts";
import type { ModelsListResponse, ProgressEvent } from "../shared/messages.ts";
import { loadSettings, saveSettings, type DisplayMode, type Settings, type SiteRule } from "../shared/settings.ts";
import { sendUi } from "../shared/ui-client.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

let settings: Settings;
let models: ModelsListResponse | null = null;
let toastTimer: number | null = null;

function toast(text: string, tone: "ok" | "error" | "" = ""): void {
  const box = $("toast");
  box.textContent = text;
  box.className = `toast ${tone}`.trim();
  box.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

function fillLanguages(select: HTMLSelectElement, codes: string[], selected?: string): void {
  select.replaceChildren();
  const unique = Array.from(new Set(codes)).sort((a, b) => languageName(a).localeCompare(languageName(b)));
  for (const code of unique) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = languageName(code);
    select.append(option);
  }
  if (selected && unique.includes(selected)) select.value = selected;
}

async function persist(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  toast(t("optionsSaved"), "ok");
}

function renderModes(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
    button.classList.toggle("active", button.dataset["mode"] === settings.displayMode);
  }
}

function renderNever(): void {
  const chips = $("never-chips");
  chips.replaceChildren();
  for (const code of settings.neverTranslateLanguages) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = languageName(code);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("optionsRemoveLanguage", languageName(code)));
    remove.addEventListener("click", () => {
      void persist({ neverTranslateLanguages: settings.neverTranslateLanguages.filter((c) => c !== code) }).then(renderNever);
    });
    chip.append(remove);
    chips.append(chip);
  }
}

// An "always" rule needs access to that site or it does nothing at all, and the permission can be
// declined at the prompt or taken back later from the browser's own extension page. The table is
// the only place that can say so.
async function ruleIsArmed(host: string, rule: SiteRule): Promise<boolean> {
  if (rule !== "always") return true;
  try {
    return await api.permissions.contains({ origins: [`*://${host}/*`] });
  } catch {
    return false;
  }
}

function renderRules(): void {
  const body = $<HTMLTableElement>("rules").tBodies[0]!;
  body.replaceChildren();
  const hosts = Object.keys(settings.siteRules).sort();
  if (hosts.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = "empty";
    cell.textContent = t("optionsRulesEmpty");
    return;
  }
  for (const host of hosts) {
    const row = body.insertRow();
    row.insertCell().textContent = host;
    const rule = settings.siteRules[host]!;
    const state = row.insertCell();
    state.textContent = t(rule === "always" ? "optionsRuleAlwaysLong" : "optionsRuleNeverLong");
    void ruleIsArmed(host, rule).then((armed) => {
      if (armed) return;
      state.textContent = t("optionsRuleWaiting");
      state.title = t("optionsRuleWaitingTitle", host);
      state.className = "warn";
    });
    const actions = row.insertCell();
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small danger";
    remove.textContent = t("optionsRemove");
    remove.addEventListener("click", () => {
      const next = { ...settings.siteRules };
      delete next[host];
      void persist({ siteRules: next }).then(renderRules);
    });
    actions.append(remove);
  }
}

function renderModels(): void {
  const body = $<HTMLTableElement>("models").tBodies[0]!;
  body.replaceChildren();
  const status = $("catalog-status");
  // Mozilla's two sources, and the button that retries the CDN, mean nothing while a mirror serves.
  $("source-hint").hidden = Boolean(settings.mirrorUrl);
  if (!models) {
    status.textContent = t("optionsCatalogLoading");
    return;
  }
  if (models.catalogFetchedAt) {
    const age = Math.max(0, Date.now() - models.catalogFetchedAt);
    const hours = Math.round(age / 3_600_000);
    const source =
      models.byteSource === "mirror" && settings.mirrorUrl
        ? t("optionsSourceMirrorName", new URL(settings.mirrorUrl).host)
        : t(models.byteSource === "mozilla-gcs" ? "optionsSourceBucketName" : "optionsSourceCdnName");
    status.textContent = t(
      "optionsCatalogLine",
      String(models.sources.length),
      String(models.targets.length),
      hours < 1 ? t("optionsCatalogJustNow") : t("optionsCatalogHoursAgo", String(hours)),
      source
    );
  } else {
    status.textContent = models.catalogError
      ? t("optionsCatalogUnavailableLine", models.catalogError)
      : t("optionsCatalogNotFetched");
  }
  if (models.installed.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = "empty";
    cell.textContent = t("optionsModelsEmptyLine");
  }
  for (const pair of models.installed.sort((a, b) => a.pairKey.localeCompare(b.pairKey))) {
    const row = body.insertRow();
    row.insertCell().textContent = `${languageName(pair.sourceLanguage)} → ${languageName(pair.targetLanguage)}`;
    row.insertCell().textContent = pair.version;
    row.insertCell().textContent = formatBytes(pair.bytes);
    const actions = row.insertCell();
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small danger";
    remove.textContent = t("optionsDeleteModel");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await sendUi({ type: "glossa:models:delete", pairKey: pair.pairKey });
      toast(t("optionsDeleted", pair.pairKey), "ok");
      await refreshModels();
    });
    actions.append(remove);
  }
  const codes = models.targets.length > 0 ? Array.from(new Set([...models.sources, ...models.targets])) : knownLanguageCodes();
  const from = $<HTMLSelectElement>("install-from");
  const to = $<HTMLSelectElement>("install-to");
  const previousFrom = from.value;
  const previousTo = to.value;
  fillLanguages(from, codes, previousFrom || undefined);
  fillLanguages(to, codes, previousTo || settings.targetLanguage);
}

async function refreshModels(): Promise<void> {
  try {
    models = await sendUi<ModelsListResponse>({ type: "glossa:models:list" });
  } catch (error) {
    models = { installed: [], sources: [], targets: [], catalogFetchedAt: null, catalogError: String(error), engineLoaded: false, engineSupported: true, byteSource: "mozilla-cdn" };
  }
  renderModels();
}

function showProgress(fraction: number | null, text: string): void {
  const box = $("progress");
  const fill = $("progress-fill");
  box.hidden = false;
  const bar = $("progress-bar");
  if (fraction === null) {
    fill.classList.add("indeterminate");
    fill.style.width = "";
    bar.removeAttribute("aria-valuenow");
  } else {
    const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    fill.classList.remove("indeterminate");
    fill.style.width = `${percent}%`;
    bar.setAttribute("aria-valuenow", String(percent));
  }
  $("progress-text").textContent = text;
}

function hideProgress(): void {
  $("progress").hidden = true;
}

api.runtime.onMessage.addListener((message: unknown) => {
  const event = message as ProgressEvent;
  if (!event || event.type !== "glossa:progress") return;
  if (event.phase === "download") {
    showProgress(
      event.totalBytes ? event.loadedBytes / event.totalBytes : null,
      t("popupDownloading", event.pairKey, formatBytes(event.loadedBytes), formatBytes(event.totalBytes))
    );
  } else if (event.phase === "store") {
    showProgress(null, t("popupVerifying", event.file ?? event.pairKey));
  } else if (event.phase === "load") {
    showProgress(null, t("popupLoadingEngine", event.pairKey));
  } else if (event.phase === "done") {
    hideProgress();
    void refreshModels();
  } else if (event.phase === "error") {
    hideProgress();
    toast(event.error ?? t("popupDownloadFailed"), "error");
  }
});

async function init(): Promise<void> {
  localize();
  $("version").textContent = `v${api.runtime.getManifest().version}`;
  settings = await loadSettings();

  const target = $<HTMLSelectElement>("target");
  fillLanguages(target, knownLanguageCodes(), settings.targetLanguage);
  target.addEventListener("change", () => void persist({ targetLanguage: target.value }));

  // Chrome's own translator is offered only where this page can see it (Chrome 138 or later, on a
  // desktop), so Firefox never shows the choice. Someone who picked it keeps a way back, even if the
  // browser has since lost the API.
  if (typeof self.Translator?.create === "function" || settings.engine === "chrome") {
    const engine = $<HTMLSelectElement>("engine");
    $("engine-field").hidden = false;
    engine.value = settings.engine;
    engine.addEventListener("change", () => void persist({ engine: engine.value === "chrome" ? "chrome" : "bergamot" }));
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
    button.addEventListener("click", () => {
      void persist({ displayMode: button.dataset["mode"] as DisplayMode }).then(renderModes);
    });
  }
  renderModes();

  const hover = $<HTMLInputElement>("hover");
  hover.checked = settings.showOriginalOnHover;
  hover.addEventListener("change", () => void persist({ showOriginalOnHover: hover.checked }));

  const skipFields = $<HTMLInputElement>("skip-form-fields");
  skipFields.checked = settings.skipFormFields;
  skipFields.addEventListener("change", () => void persist({ skipFormFields: skipFields.checked }));

  const selectionPopup = $<HTMLInputElement>("selection-popup");
  selectionPopup.checked = settings.selectionPopup;
  selectionPopup.addEventListener("change", () => void persist({ selectionPopup: selectionPopup.checked }));

  const neverAdd = $<HTMLSelectElement>("never-add");
  fillLanguages(neverAdd, knownLanguageCodes());
  $("never-add-btn").addEventListener("click", () => {
    const code = neverAdd.value;
    if (!code || settings.neverTranslateLanguages.includes(code)) return;
    void persist({ neverTranslateLanguages: [...settings.neverTranslateLanguages, code] }).then(renderNever);
  });
  renderNever();

  // What the browser will call this host when a page from it is open: punycode for a non-ASCII name,
  // no port, no path. A rule stored under anything else can never match and looks active forever.
  function normalizeHost(value: string): string {
    const raw = value.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
    if (!raw) return "";
    try {
      return new URL(`https://${raw}`).hostname;
    } catch {
      return raw.toLowerCase().replace(/:\d+$/, "");
    }
  }

  $("rule-add").addEventListener("click", () => {
    const input = $<HTMLInputElement>("rule-host");
    const host = normalizeHost(input.value);
    if (!host) {
      toast(t("optionsEnterHost"), "error");
      return;
    }
    const kind = $<HTMLSelectElement>("rule-kind").value as SiteRule;
    // "Always" means Glossa reads that site on its own, which needs a host permission for it. The
    // request has to be made from this click, and a refusal leaves the rule in place but inert.
    if (kind === "always") {
      api.permissions.request({ origins: [`*://${host}/*`] }).then(
        (granted) => {
          if (!granted) {
            toast(t("optionsNoAccessToast", host), "error");
          }
        },
        () => toast(t("optionsBadHostToast", host), "error")
      );
    }
    void persist({ siteRules: { ...settings.siteRules, [host]: kind } }).then(() => {
      input.value = "";
      renderRules();
    });
  });
  renderRules();

  const experimental = $<HTMLInputElement>("experimental-models");
  experimental.checked = settings.experimentalModels;
  experimental.addEventListener("change", async () => {
    await persist({ experimentalModels: experimental.checked });
    // The language lists and every route depend on which records the catalog gate lets through.
    await refreshModels();
  });

  // A mirror is the user's own server. Its host is asked for from this click, because both browsers
  // refuse a permission request anywhere else, and only a granted one is saved: a mirror Glossa may
  // not reach would turn every download into a bare network error.
  const mirror = $<HTMLInputElement>("mirror");
  mirror.value = settings.mirrorUrl;
  $("mirror-save").addEventListener("click", () => {
    const url = normalizeMirrorUrl(mirror.value);
    if (!url) {
      toast(t("optionsMirrorInvalid"), "error");
      return;
    }
    const host = new URL(url).host;
    api.permissions.request({ origins: [mirrorPermissionPattern(url)] }).then(
      async (granted) => {
        if (!granted) {
          toast(t("optionsMirrorNoAccess", host), "error");
          return;
        }
        settings = await saveSettings({ mirrorUrl: url });
        mirror.value = url;
        toast(t("optionsMirrorSaved", host), "ok");
        await refreshModels();
      },
      () => toast(t("optionsMirrorNoAccess", host), "error")
    );
  });
  $("mirror-clear").addEventListener("click", async () => {
    settings = await saveSettings({ mirrorUrl: "" });
    mirror.value = "";
    toast(t("optionsMirrorCleared"), "ok");
    await refreshModels();
  });

  $("catalog-refresh").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("catalog-refresh");
    button.disabled = true;
    try {
      const result = await sendUi<{ fetchedAt: number | null; error: string | null }>({ type: "glossa:catalog:refresh" });
      toast(result.error ? t("optionsCatalogRefreshFailed", result.error) : t("optionsCatalogRefreshed"), result.error ? "error" : "ok");
    } finally {
      button.disabled = false;
      await refreshModels();
    }
  });

  // What is being downloaded right now, so the button can stop it.
  let downloading: string | null = null;

  $("cancel-download").addEventListener("click", async () => {
    if (!downloading) return;
    await sendUi({ type: "glossa:models:cancel", pairKey: downloading }).catch(() => undefined);
    toast(t("optionsDownloadCancelled"));
  });

  $("reset-source").addEventListener("click", async () => {
    const result = await sendUi<{ byteSource: string }>({ type: "glossa:models:reset-source" });
    toast(t(result.byteSource === "mozilla-cdn" ? "optionsSourceCdn" : "optionsSourceBucket"), "ok");
    await refreshModels();
  });

  $("install").addEventListener("click", async () => {
    const from = $<HTMLSelectElement>("install-from").value;
    const to = $<HTMLSelectElement>("install-to").value;
    if (!from || !to || from === to) {
      toast(t("optionsPickTwo"), "error");
      return;
    }
    const button = $<HTMLButtonElement>("install");
    button.disabled = true;
    downloading = `${from}->${to}`;
    showProgress(0, t("popupStartingDownload"));
    try {
      await sendUi({ type: "glossa:models:install", sourceLanguage: from, targetLanguage: to });
      toast(t("optionsPairReady", languageName(from), languageName(to)), "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      button.disabled = false;
      downloading = null;
      hideProgress();
      await refreshModels();
    }
  });

  await refreshModels();
}

void init();

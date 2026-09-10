import { api } from "../shared/api.ts";
import { formatBytes } from "../shared/hash.ts";
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
  toast("Saved", "ok");
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
    remove.setAttribute("aria-label", `Remove ${languageName(code)}`);
    remove.addEventListener("click", () => {
      void persist({ neverTranslateLanguages: settings.neverTranslateLanguages.filter((c) => c !== code) }).then(renderNever);
    });
    chip.append(remove);
    chips.append(chip);
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
    cell.textContent = "No site rules yet.";
    return;
  }
  for (const host of hosts) {
    const row = body.insertRow();
    row.insertCell().textContent = host;
    row.insertCell().textContent = settings.siteRules[host] === "always" ? "Always translate" : "Never translate";
    const actions = row.insertCell();
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small danger";
    remove.textContent = "Remove";
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
  if (!models) {
    status.textContent = "Loading catalog…";
    return;
  }
  if (models.catalogFetchedAt) {
    const age = Math.max(0, Date.now() - models.catalogFetchedAt);
    const hours = Math.round(age / 3_600_000);
    const source = models.byteSource === "mozilla-gcs" ? "Mozilla's model registry bucket" : "Mozilla's Remote Settings CDN";
    status.textContent = `Catalog: ${models.sources.length} source and ${models.targets.length} target languages, refreshed ${hours < 1 ? "just now" : `${hours} h ago`}. Downloads come from ${source}.`;
  } else {
    status.textContent = models.catalogError ? `Catalog unavailable: ${models.catalogError}` : "Catalog not fetched yet.";
  }
  if (models.installed.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = "empty";
    cell.textContent = "No models downloaded yet. The first translation downloads what it needs.";
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
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await sendUi({ type: "glossa:models:delete", pairKey: pair.pairKey });
      toast(`Deleted ${pair.pairKey}`, "ok");
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
  if (fraction === null) {
    fill.classList.add("indeterminate");
    fill.style.width = "";
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = `${Math.round(fraction * 100)}%`;
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
    showProgress(event.totalBytes ? event.loadedBytes / event.totalBytes : null, `Downloading ${event.pairKey}: ${formatBytes(event.loadedBytes)} of ${formatBytes(event.totalBytes)}`);
  } else if (event.phase === "store") {
    showProgress(null, `Verifying ${event.file ?? ""}…`);
  } else if (event.phase === "load") {
    showProgress(null, `Loading ${event.pairKey}…`);
  } else if (event.phase === "done") {
    hideProgress();
    void refreshModels();
  } else if (event.phase === "error") {
    hideProgress();
    toast(event.error ?? "Download failed", "error");
  }
});

async function init(): Promise<void> {
  $("version").textContent = `v${api.runtime.getManifest().version}`;
  settings = await loadSettings();

  const target = $<HTMLSelectElement>("target");
  fillLanguages(target, knownLanguageCodes(), settings.targetLanguage);
  target.addEventListener("change", () => void persist({ targetLanguage: target.value }));

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

  $("rule-add").addEventListener("click", () => {
    const input = $<HTMLInputElement>("rule-host");
    const host = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) {
      toast("Enter a host name first", "error");
      return;
    }
    const kind = $<HTMLSelectElement>("rule-kind").value as SiteRule;
    // "Always" means Glossa reads that site on its own, which needs a host permission for it. The
    // request has to be made from this click, and a refusal leaves the rule in place but inert.
    if (kind === "always") {
      api.permissions.request({ origins: [`*://${host}/*`] }).then(
        (granted) => {
          if (!granted) {
            toast(`Without access to ${host}, that rule cannot translate on its own`, "error");
          }
        },
        () => toast(`${host} is not a host Glossa can ask for`, "error")
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

  $("catalog-refresh").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("catalog-refresh");
    button.disabled = true;
    try {
      const result = await sendUi<{ fetchedAt: number | null; error: string | null }>({ type: "glossa:catalog:refresh" });
      toast(result.error ? `Catalog refresh failed: ${result.error}` : "Catalog refreshed", result.error ? "error" : "ok");
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
    toast("Download cancelled");
  });

  $("reset-source").addEventListener("click", async () => {
    const result = await sendUi<{ byteSource: string }>({ type: "glossa:models:reset-source" });
    toast(`Next download will try ${result.byteSource === "mozilla-cdn" ? "Mozilla's CDN" : "Mozilla's bucket"} first`, "ok");
    await refreshModels();
  });

  $("install").addEventListener("click", async () => {
    const from = $<HTMLSelectElement>("install-from").value;
    const to = $<HTMLSelectElement>("install-to").value;
    if (!from || !to || from === to) {
      toast("Pick two different languages", "error");
      return;
    }
    const button = $<HTMLButtonElement>("install");
    button.disabled = true;
    downloading = `${from}->${to}`;
    showProgress(0, "Starting download…");
    try {
      await sendUi({ type: "glossa:models:install", sourceLanguage: from, targetLanguage: to });
      toast(`${languageName(from)} → ${languageName(to)} ready`, "ok");
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

import { api } from "./api.ts";
import { t } from "./i18n.ts";

export type DisplayMode = "bilingual" | "replace";
export type SiteRule = "always" | "never";

export interface Settings {
  schemaVersion: 1;
  // Language to translate into. Defaults to the browser UI language at first run.
  targetLanguage: string;
  displayMode: DisplayMode;
  // Show the original text as a tooltip when hovering a translated block in replace mode.
  showOriginalOnHover: boolean;
  // Selection popup is opt-in. Popups on every selection are a known irritant.
  selectionPopup: boolean;
  // Per-host rules. "always" needs the optional all-sites permission to fire automatically.
  siteRules: Record<string, SiteRule>;
  // Languages the user reads fluently. Pages in these languages are never offered for translation.
  neverTranslateLanguages: string[];
  // Never translate inside form fields, even when a rule matches.
  skipFormFields: boolean;
  // Refresh the model catalog at most this often. The catalog is the only periodic network call.
  catalogRefreshHours: number;
  // A source language the user picked by hand for a host, remembered so they do not pick it again
  // on every visit. Detection is a guess; this is not.
  sourceLanguages: Record<string, string>;
  // Offer the catalog's prerelease models (Azerbaijani, Belarusian, Bosnian, Norwegian, Nynorsk).
  // Mozilla gates them to its nightly channel, so they are off by default here too.
  experimentalModels: boolean;
}

export const SETTINGS_KEY = "settings";

export function defaultSettings(uiLanguage?: string): Settings {
  const target = normalizeUiLanguage(uiLanguage) ?? "en";
  return {
    schemaVersion: 1,
    targetLanguage: target,
    displayMode: "bilingual",
    showOriginalOnHover: true,
    selectionPopup: false,
    siteRules: {},
    neverTranslateLanguages: [target],
    skipFormFields: true,
    catalogRefreshHours: 24,
    sourceLanguages: {},
    experimentalModels: false
  };
}

function normalizeUiLanguage(tag: string | undefined): string | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) {
    return /hant|tw|hk|mo/.test(lower) ? "zh-Hant" : "zh-Hans";
  }
  const primary = lower.split(/[-_]/)[0];
  return primary && primary.length >= 2 ? primary : null;
}

// Merge stored values over defaults so a newly added key always has a value and a corrupt
// stored blob never takes the extension down.
export function mergeSettings(stored: unknown, uiLanguage?: string): Settings {
  const base = defaultSettings(uiLanguage);
  if (!stored || typeof stored !== "object") return base;
  const input = stored as Partial<Record<keyof Settings, unknown>>;
  const out: Settings = { ...base };
  if (typeof input.targetLanguage === "string" && input.targetLanguage) {
    out.targetLanguage = input.targetLanguage;
  }
  if (input.displayMode === "bilingual" || input.displayMode === "replace") {
    out.displayMode = input.displayMode;
  }
  if (typeof input.showOriginalOnHover === "boolean") out.showOriginalOnHover = input.showOriginalOnHover;
  if (typeof input.selectionPopup === "boolean") out.selectionPopup = input.selectionPopup;
  if (typeof input.skipFormFields === "boolean") out.skipFormFields = input.skipFormFields;
  if (typeof input.experimentalModels === "boolean") out.experimentalModels = input.experimentalModels;
  if (typeof input.catalogRefreshHours === "number" && input.catalogRefreshHours >= 1) {
    out.catalogRefreshHours = Math.min(input.catalogRefreshHours, 24 * 30);
  }
  if (Array.isArray(input.neverTranslateLanguages)) {
    out.neverTranslateLanguages = input.neverTranslateLanguages.filter(
      (value): value is string => typeof value === "string" && value.length > 0
    );
  }
  if (input.sourceLanguages && typeof input.sourceLanguages === "object") {
    const chosen: Record<string, string> = {};
    for (const [host, code] of Object.entries(input.sourceLanguages as Record<string, unknown>)) {
      if (host && typeof code === "string" && code) chosen[host] = code;
    }
    out.sourceLanguages = chosen;
  }
  if (input.siteRules && typeof input.siteRules === "object") {
    const rules: Record<string, SiteRule> = {};
    for (const [host, rule] of Object.entries(input.siteRules as Record<string, unknown>)) {
      if ((rule === "always" || rule === "never") && host) rules[host] = rule;
    }
    out.siteRules = rules;
  }
  return out;
}

// The catalog is the only periodic network call Glossa makes, so the interval is a setting rather
// than a constant.
export function catalogMaxAgeMs(settings: Pick<Settings, "catalogRefreshHours">): number {
  const hours = Number.isFinite(settings.catalogRefreshHours) ? settings.catalogRefreshHours : 24;
  return Math.max(1, Math.min(hours, 24 * 30)) * 60 * 60 * 1000;
}

// Whether the user's settings allow translating this page at all. Returns the reason not to, or
// null when nothing is in the way.
export function blockedReason(
  settings: Pick<Settings, "siteRules" | "neverTranslateLanguages">,
  url: string | null,
  detectedLanguage: string | null,
  languageName: (code: string) => string
): string | null {
  const host = hostOf(url);
  if (host && settings.siteRules[host] === "never") {
    return t("blockedBySiteRule", host);
  }
  if (detectedLanguage && settings.neverTranslateLanguages.includes(detectedLanguage)) {
    return t("blockedByKnownLanguage", languageName(detectedLanguage));
  }
  return null;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export async function loadSettings(): Promise<Settings> {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY], api.i18n.getUILanguage());
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings({ ...current, ...patch }, api.i18n.getUILanguage());
  await api.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

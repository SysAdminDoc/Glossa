import type { DisplayMode } from "./settings.ts";

// Every message carries a `type` prefixed with "glossa:" so unrelated extension traffic on the
// same channel can be ignored cheaply. Engine-bound messages add `target: "glossa-engine"` because
// on Chrome the engine lives in an offscreen document that shares runtime.onMessage with the popup
// and options page.

export const ENGINE_TARGET = "glossa-engine";
export const UI_TARGET = "glossa-ui";

// ---- content script <-> background ----

export interface DetectRequest {
  type: "glossa:detect";
  sample: string;
  htmlLang: string | null;
}
export interface DetectResponse {
  language: string | null;
  confident: boolean;
}

export interface TranslateRequest {
  type: "glossa:translate";
  sourceLanguage: string;
  targetLanguage: string;
  // Each entry is an HTML fragment of one block. The engine keeps inline tags in place.
  fragments: string[];
}
export type TranslateResponse =
  | { ok: true; fragments: string[]; inferenceMs: number }
  | { ok: false; error: string };

export type PageCommand =
  | { type: "glossa:page-command"; command: "translate"; targetLanguage: string; displayMode: DisplayMode; showOriginalOnHover: boolean; skipFormFields: boolean; sourceLanguage?: string }
  | { type: "glossa:page-command"; command: "restore" }
  | { type: "glossa:page-command"; command: "status" }
  | { type: "glossa:page-command"; command: "translate-selection"; targetLanguage: string };

export interface PageState {
  injected: true;
  url: string;
  detectedLanguage: string | null;
  confident: boolean;
  translated: boolean;
  translating: boolean;
  targetLanguage: string | null;
  blocksTotal: number;
  blocksDone: number;
  lastError: string | null;
}

// ---- popup / options <-> background ----

export interface PageStatusRequest {
  type: "glossa:page-status";
  tabId: number;
}
export interface PageStatusResponse {
  page: PageState | { injected: false; url: string | null; reason: string };
  route: RouteStatus | null;
  // Set when the user's own settings say this page must not be translated: a "never" rule for the
  // host, or a page in a language they told us they read. The text is shown as-is in the popup.
  blocked: string | null;
}

export interface TranslatePageRequest {
  type: "glossa:translate-page";
  tabId: number;
  targetLanguage?: string;
  sourceLanguage?: string;
}
export interface RestorePageRequest {
  type: "glossa:restore-page";
  tabId: number;
}
export interface TranslateSelectionRequest {
  type: "glossa:translate-selection";
  tabId: number;
}

export interface ModelsListRequest {
  type: "glossa:models:list";
}
export interface ModelsInstallRequest {
  type: "glossa:models:install";
  sourceLanguage: string;
  targetLanguage: string;
}
export interface ModelsDeleteRequest {
  type: "glossa:models:delete";
  pairKey: string;
}
export interface ModelsCancelRequest {
  type: "glossa:models:cancel";
  pairKey: string;
}
export interface ModelsDownloadsRequest {
  type: "glossa:models:downloads";
}
export interface ModelsResetSourceRequest {
  type: "glossa:models:reset-source";
}
export interface CatalogRefreshRequest {
  type: "glossa:catalog:refresh";
}
export interface RouteStatusRequest {
  type: "glossa:route-status";
  sourceLanguage: string;
  targetLanguage: string;
}

export type UiRequest =
  | PageStatusRequest
  | TranslatePageRequest
  | RestorePageRequest
  | TranslateSelectionRequest
  | ModelsListRequest
  | ModelsInstallRequest
  | ModelsDeleteRequest
  | ModelsCancelRequest
  | ModelsDownloadsRequest
  | ModelsResetSourceRequest
  | CatalogRefreshRequest
  | RouteStatusRequest;

// ---- background <-> engine host ----

export interface InstalledPair {
  pairKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  version: string;
  bytes: number;
  installedAt: number;
}

export interface RouteStatus {
  sourceLanguage: string;
  targetLanguage: string;
  // null when the catalog has no way to serve the pair
  hops: Array<{ pairKey: string; installed: boolean; downloadBytes: number; bytes: number }> | null;
  installed: boolean;
  downloadBytes: number;
  catalogAgeMs: number | null;
  catalogError: string | null;
}

export interface ModelsListResponse {
  installed: InstalledPair[];
  sources: string[];
  targets: string[];
  catalogFetchedAt: number | null;
  catalogError: string | null;
  engineLoaded: boolean;
  // False when this machine's CPU (or the browser's WASM settings) cannot run the engine at all.
  engineSupported: boolean;
  // Where the next model download will come from. Chrome browsers end up on the registry bucket
  // because Mozilla's attachment CDN refuses their user agent.
  byteSource: "mozilla-cdn" | "mozilla-gcs";
}

// The engine host has no access to storage on Chrome (an offscreen document gets no
// chrome.storage), so every request carries the one setting that changes which catalog records are
// usable. The background reads it and stamps it on.
interface EngineEnvelope {
  target: typeof ENGINE_TARGET;
  experimental?: boolean;
  // How stale the model catalog may be before it is fetched again, from the user's settings.
  catalogMaxAgeMs?: number;
}

export type EngineRequest =
  | (EngineEnvelope & { type: "translate"; sourceLanguage: string; targetLanguage: string; fragments: string[] })
  | (EngineEnvelope & { type: "ensure-route"; sourceLanguage: string; targetLanguage: string })
  | (EngineEnvelope & { type: "route-status"; sourceLanguage: string; targetLanguage: string })
  | (EngineEnvelope & { type: "models-list" })
  | (EngineEnvelope & { type: "models-delete"; pairKey: string })
  | (EngineEnvelope & { type: "models-downloads" })
  | (EngineEnvelope & { type: "models-cancel"; pairKey: string })
  | (EngineEnvelope & { type: "models-reset-source" })
  | (EngineEnvelope & { type: "catalog-refresh" })
  | (EngineEnvelope & { type: "ping" });

// Omit does not distribute over a union; this one does.
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EngineResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

// ---- engine host -> any UI page (broadcast, best effort) ----

export interface ProgressEvent {
  target: typeof UI_TARGET;
  type: "glossa:progress";
  pairKey: string;
  phase: "download" | "verify" | "decompress" | "store" | "load" | "done" | "error";
  file: string | null;
  loadedBytes: number;
  totalBytes: number;
  error?: string;
}

export function isGlossaMessage(value: unknown): value is { type: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("glossa:");
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  return Boolean(value) && typeof value === "object" && (value as { target?: unknown }).target === ENGINE_TARGET;
}

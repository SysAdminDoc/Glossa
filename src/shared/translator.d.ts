// Chrome's on-device Translator API (Chrome 138+). @types/chrome carries no typings for it, and the
// DOM lib does not either yet, so only the surface Glossa touches is declared here.
// https://webmachinelearning.github.io/translation-api/

export type TranslatorAvailability = "unavailable" | "downloadable" | "downloading" | "available";

export interface TranslatorLanguages {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TranslatorDownloadProgress extends Event {
  // A fraction between 0 and 1.
  loaded: number;
}

export interface TranslatorMonitor extends EventTarget {
  addEventListener(type: "downloadprogress", listener: (event: TranslatorDownloadProgress) => void): void;
}

export interface TranslatorCreateOptions extends TranslatorLanguages {
  monitor?: (monitor: TranslatorMonitor) => void;
  signal?: AbortSignal;
}

export interface TranslatorInstance {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  // Chrome 152 reports null here; not relied on.
  readonly inputQuota?: number | null;
  translate(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

export interface TranslatorConstructor {
  availability(languages: TranslatorLanguages): Promise<TranslatorAvailability>;
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
}

declare global {
  // Absent on Firefox, on Chrome before 138, and in any context the browser does not expose it to.
  // Always read it through `self.Translator` with a typeof check.
  var Translator: TranslatorConstructor | undefined;
}

import type { RouteStatus } from "../shared/messages.ts";
import type { TranslatorConstructor, TranslatorInstance } from "../shared/translator.d.ts";

// Chrome's on-device Translator (Chrome 138+) as a second engine, opted into from the settings.
// It runs in the offscreen document next to Bergamot: that is a Window on the extension's own origin,
// which is what the API needs. A content script will not do. There the API answers for the page's
// origin, which keeps reporting "downloadable" after the pack is on disk and refuses create()
// without a gesture in the page itself.
//
// The first download of a pack needs a user gesture on the extension's origin, so the popup starts
// it from the Translate click. Everything after that (the page, a selection, a field, an "always"
// site) goes through here with no gesture at all. Nothing in this path talks to Mozilla's hosts:
// the packs come from Chrome's own component updater.

// Error texts the background turns into localised messages. The offscreen document has no
// chrome.i18n, so it cannot say these itself.
export const CHROME_NEEDS_DOWNLOAD = "glossa:chrome-needs-download";
export const CHROME_UNAVAILABLE = "glossa:chrome-unavailable";

function translatorApi(): TranslatorConstructor | null {
  const candidate = (globalThis as { Translator?: TranslatorConstructor }).Translator;
  return candidate && typeof candidate.create === "function" ? candidate : null;
}

export function chromeTranslatorAvailable(): boolean {
  return translatorApi() !== null;
}

export class ChromeEngine {
  // One translator per pair, shared by every request for it. A failed create is not kept: the next
  // request tries again, which is what makes "download it from the popup, then retry" work.
  private readonly translators = new Map<string, Promise<TranslatorInstance>>();

  async routeStatus(sourceLanguage: string, targetLanguage: string): Promise<RouteStatus> {
    const base: RouteStatus = {
      sourceLanguage,
      targetLanguage,
      hops: null,
      installed: false,
      downloadBytes: 0,
      catalogAgeMs: null,
      catalogError: null
    };
    const api = translatorApi();
    if (!api || sourceLanguage === targetLanguage) return base;
    let availability: string;
    try {
      availability = await api.availability({ sourceLanguage, targetLanguage });
    } catch {
      // An unknown language tag throws rather than answering "unavailable".
      availability = "unavailable";
    }
    if (availability === "unavailable") return base;
    const installed = availability === "available";
    // Chrome does not say how big a pack is, so the size is left at zero and the popup words it
    // without one.
    return {
      ...base,
      hops: [{ pairKey: `${sourceLanguage}->${targetLanguage}`, installed, downloadBytes: 0, bytes: 0 }],
      installed
    };
  }

  async translate(
    sourceLanguage: string,
    targetLanguage: string,
    fragments: string[]
  ): Promise<{ fragments: string[]; inferenceMs: number }> {
    const started = performance.now();
    const translator = await this.translator(sourceLanguage, targetLanguage);
    // Each fragment is one block of HTML. Chrome keeps inline tags and their attributes in place,
    // including the ids the renderer uses to put text back into the page's own elements.
    const out = await Promise.all(
      fragments.map((fragment) => (fragment.trim() ? translator.translate(fragment) : Promise.resolve(fragment)))
    );
    return { fragments: out, inferenceMs: Math.round(performance.now() - started) };
  }

  // Ready the pair without translating anything: what "download this pair" means for this engine.
  async ensure(sourceLanguage: string, targetLanguage: string): Promise<string> {
    await this.translator(sourceLanguage, targetLanguage);
    return `${sourceLanguage}->${targetLanguage}`;
  }

  private translator(sourceLanguage: string, targetLanguage: string): Promise<TranslatorInstance> {
    const key = `${sourceLanguage}->${targetLanguage}`;
    const known = this.translators.get(key);
    if (known) return known;
    const api = translatorApi();
    if (!api) return Promise.reject(new Error(CHROME_UNAVAILABLE));
    const created = api.create({ sourceLanguage, targetLanguage }).catch((error: unknown) => {
      this.translators.delete(key);
      const name = (error as { name?: unknown } | null)?.name;
      // The pack is not on disk yet, and only a gesture can start the download.
      if (name === "NotAllowedError") throw new Error(CHROME_NEEDS_DOWNLOAD);
      throw error instanceof Error ? error : new Error(String(error));
    });
    this.translators.set(key, created);
    return created;
  }

  // Called when the engine host goes idle. A translator holds the model in memory.
  release(): void {
    for (const pending of this.translators.values()) {
      pending.then((translator) => translator.destroy(), () => undefined);
    }
    this.translators.clear();
  }
}

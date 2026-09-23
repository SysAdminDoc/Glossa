import type { RouteStatus } from "../shared/messages.ts";
import type { TranslatorConstructor, TranslatorCreateOptions, TranslatorInstance } from "../shared/translator.d.ts";

// Chrome's on-device Translator (Chrome 138+) as a second engine, opted into from the settings.
// It runs in the offscreen document next to Bergamot: that is a Window on the extension's own origin,
// which is what the API needs. A content script will not do. There the API answers for the page's
// origin, which keeps reporting "downloadable" after the pack is on disk and refuses create()
// without a gesture in the page itself.
//
// The first download of a pack needs a user gesture on the extension's origin, so it starts from the
// popup's Translate click, both in the popup and here (claimPack). Everything after that (the page,
// a selection, a field, an "always" site) goes through here with no gesture at all. Nothing in this path talks to Mozilla's hosts:
// the packs come from Chrome's own component updater.

// Error texts the background turns into localised messages. The offscreen document has no
// chrome.i18n, so it cannot say these itself.
export const CHROME_NEEDS_DOWNLOAD = "glossa:chrome-needs-download";
export const CHROME_UNAVAILABLE = "glossa:chrome-unavailable";
export const CHROME_TOO_LONG = "glossa:chrome-too-long";

function describeFailure(error: unknown): Error {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError") return new Error(CHROME_TOO_LONG);
  return error instanceof Error ? error : new Error(String(error));
}

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
  // Translators a claim can hand out as they are: started with the user's click, or already made.
  private readonly usable = new WeakSet<Promise<TranslatorInstance>>();

  // Start the pack download here, in the document that outlives the popup. Without it, a popup
  // closed mid-download leaves this document with a pack it cannot open: create() refuses without a
  // click while the pack is not ready, and Chrome answers "downloadable" here for the whole download,
  // never "downloading", so a pack on its way looks like one nobody asked for (Chrome 153, probed
  // 2026-09-23). A message from the popup brings its click here for a few seconds, and a create()
  // started with it keeps downloading after the popup is gone. Returns the download, or null when
  // this document has no click to start it with.
  claimPack(sourceLanguage: string, targetLanguage: string, progress: (fraction: number) => void): Promise<TranslatorInstance> | null {
    const activation = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator?.userActivation;
    if (!activation?.isActive) return null;
    const known = this.translators.get(`${sourceLanguage}->${targetLanguage}`);
    if (known && this.usable.has(known)) return known;
    // One started without a click (another tab's batch, an "always" site) is about to be refused for
    // want of one. Whatever waits on it gets that answer; from here on the pair waits for this one.
    return this.start(sourceLanguage, targetLanguage, progress, true);
  }

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
  ): Promise<{ fragments: string[]; inferenceMs: number; notice?: string }> {
    const started = performance.now();
    const translator = await this.translator(sourceLanguage, targetLanguage);
    // Each fragment is one block of HTML. Chrome keeps inline tags and their attributes in place,
    // including the ids the renderer uses to put text back into the page's own elements.
    // A block Chrome refuses (too long for it, or a passing failure) must not take the page down
    // with it, not even when it is the only block in its batch, which is how the scheduler sends a
    // long one. It comes back empty, the renderer leaves it in its own language, and the notice says
    // why while the rest of the page carries on.
    const settled = await Promise.allSettled(
      fragments.map((fragment) => (fragment.trim() ? translator.translate(fragment) : Promise.resolve(fragment)))
    );
    const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    return {
      fragments: settled.map((result) => (result.status === "fulfilled" ? result.value : "")),
      inferenceMs: Math.round(performance.now() - started),
      ...(failures.length > 0 ? { notice: describeFailure(failures[0]).message } : {})
    };
  }

  // A translation that asks while a claimed download is running gets that download's translator,
  // which is how the page waits for the pack.
  private translator(sourceLanguage: string, targetLanguage: string): Promise<TranslatorInstance> {
    return this.translators.get(`${sourceLanguage}->${targetLanguage}`) ?? this.start(sourceLanguage, targetLanguage, null, false);
  }

  private start(
    sourceLanguage: string,
    targetLanguage: string,
    progress: ((fraction: number) => void) | null,
    clicked: boolean
  ): Promise<TranslatorInstance> {
    const key = `${sourceLanguage}->${targetLanguage}`;
    const api = translatorApi();
    if (!api) return Promise.reject(new Error(CHROME_UNAVAILABLE));
    const options: TranslatorCreateOptions = { sourceLanguage, targetLanguage };
    if (progress) {
      options.monitor = (monitor) => monitor.addEventListener("downloadprogress", (event) => progress(event.loaded));
    }
    const created: Promise<TranslatorInstance> = api.create(options).then(
      (translator) => {
        this.usable.add(created);
        return translator;
      },
      (error: unknown) => {
        // A claim may have replaced this one in the meantime, and that one stays.
        if (this.translators.get(key) === created) this.translators.delete(key);
        const name = (error as { name?: unknown } | null)?.name;
        // The pack is not on disk yet, and only a gesture can start the download.
        if (name === "NotAllowedError") throw new Error(CHROME_NEEDS_DOWNLOAD);
        throw error instanceof Error ? error : new Error(String(error));
      }
    );
    if (clicked) this.usable.add(created);
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

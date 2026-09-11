import assert from "node:assert/strict";
import { test } from "node:test";

// Chrome's built-in Translator as an engine. The browser global is faked, the network is a trap that
// records anything that reaches it, and the Bergamot worker refuses to start: in Chrome mode a page
// translation must use neither.

const fetches: string[] = [];
const globals = globalThis as Record<string, unknown>;
globals.fetch = (url: unknown) => {
  fetches.push(String(url));
  return Promise.reject(new Error("the network is off in this test"));
};
globals.Worker = class {
  constructor() {
    throw new Error("the Bergamot worker must not start in Chrome mode");
  }
};
globals.chrome = {
  storage: { local: {} },
  i18n: { getUILanguage: () => "en-US", getMessage: () => "" },
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: () => Promise.resolve(undefined)
  }
};
globals.__GLOSSA_HAS_OFFSCREEN__ = true;

// What the fake Translator knows. A pair missing here is one Chrome has no pack for.
const availability = new Map<string, string>();
const created: string[] = [];
let destroyed = 0;

function refusal(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

globals.Translator = {
  availability: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) =>
    availability.get(`${sourceLanguage}->${targetLanguage}`) ?? "unavailable",
  create: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
    const key = `${sourceLanguage}->${targetLanguage}`;
    created.push(key);
    const state = availability.get(key) ?? "unavailable";
    if (state === "unavailable") throw refusal("NotSupportedError", "Unable to create translator for the given source and target language.");
    // What Chrome does without a gesture when the pack is not on disk yet.
    if (state !== "available") throw refusal("NotAllowedError", 'Requires a user gesture when availability is "downloadable".');
    return {
      sourceLanguage,
      targetLanguage,
      inputQuota: null,
      translate: async (input: string) => {
        if (input.includes("TOO LONG")) throw refusal("QuotaExceededError", "The input is too large.");
        if (input.includes("FLAKY")) throw refusal("UnknownError", "Other generic failures occurred.");
        return `EN[${input}]`;
      },
      destroy: () => {
        destroyed++;
      }
    };
  }
};

const { EngineHost } = await import("../src/engine/engine-host.ts");
const { ChromeEngine, CHROME_NEEDS_DOWNLOAD, CHROME_TOO_LONG, CHROME_UNAVAILABLE } = await import("../src/engine/chrome-translator.ts");
const { defaultSettings, mergeSettings } = await import("../src/shared/settings.ts");
const { ENGINE_TARGET } = await import("../src/shared/messages.ts");

// A host whose model store fails loudly if anything asks it for the catalog or a model, except for
// the offline catalog read models-list is allowed to make.
function chromeHost() {
  const host = new EngineHost();
  const catalogCalls: Array<{ offline?: boolean }> = [];
  const store = host.store as unknown as Record<string, unknown>;
  store["getCatalog"] = async (options: { offline?: boolean }) => {
    catalogCalls.push(options);
    if (!options.offline) throw new Error("the catalog was fetched in Chrome mode");
    return null;
  };
  store["ensurePair"] = async () => {
    throw new Error("a Bergamot model was requested in Chrome mode");
  };
  store["listInstalled"] = async () => [];
  store["activeSource"] = async () => "mozilla-cdn";
  return { host, catalogCalls };
}

function reset(): void {
  availability.clear();
  created.length = 0;
  destroyed = 0;
}

test("route status follows Chrome's availability and never needs the catalog", async () => {
  reset();
  availability.set("es->en", "downloadable");
  availability.set("fr->en", "available");
  const { host, catalogCalls } = chromeHost();
  const ask = (sourceLanguage: string) =>
    host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "route-status", sourceLanguage, targetLanguage: "en" }) as Promise<{
      hops: Array<{ installed: boolean }> | null;
      installed: boolean;
    }>;
  const es = await ask("es");
  assert.equal(es.hops?.length, 1);
  assert.equal(es.installed, false, "a pack still to download is not installed");
  const fr = await ask("fr");
  assert.equal(fr.installed, true);
  const de = await ask("de");
  assert.equal(de.hops, null, "a pair Chrome has no pack for has no route");
  assert.equal(catalogCalls.length, 0);
  assert.deepEqual(fetches, []);
  await host.shutdown();
});

test("translating keeps one translator per pair and the fragments in order", async () => {
  reset();
  availability.set("fr->en", "available");
  const { host } = chromeHost();
  const request = (fragments: string[]) =>
    host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "translate", sourceLanguage: "fr", targetLanguage: "en", fragments }) as Promise<{
      fragments: string[];
    }>;
  const first = await request(["Bonjour", "  ", 'Le <b data-glossa-id="0">livre</b>']);
  // A block of nothing but whitespace is sent to neither engine and comes back empty, which the
  // renderer already treats as "leave this block alone".
  assert.deepEqual(first.fragments, ["EN[Bonjour]", "", 'EN[Le <b data-glossa-id="0">livre</b>]']);
  await request(["Merci"]);
  assert.deepEqual(created, ["fr->en"], "the second batch reused the first translator");
  assert.deepEqual(fetches, []);
  await host.shutdown();
});

test("a pack that is not on disk yet sends the reader to the popup, and the next request tries again", async () => {
  reset();
  availability.set("es->en", "downloadable");
  const { host } = chromeHost();
  const request = () =>
    host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "translate", sourceLanguage: "es", targetLanguage: "en", fragments: ["Hola"] }) as Promise<{
      fragments: string[];
    }>;
  await assert.rejects(request(), (error: Error) => error.message === CHROME_NEEDS_DOWNLOAD);
  // The popup downloaded it in the meantime.
  availability.set("es->en", "available");
  assert.deepEqual((await request()).fragments, ["EN[Hola]"]);
  assert.deepEqual(created, ["es->en", "es->en"], "the failed create was not cached");
  await host.shutdown();
});

test("going idle destroys Chrome's translators along with everything else", async () => {
  reset();
  availability.set("fr->en", "available");
  const { host } = chromeHost();
  await host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "translate", sourceLanguage: "fr", targetLanguage: "en", fragments: ["Bonjour"] });
  await host.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(destroyed, 1);
});

test("models-list in Chrome mode reads the catalog from disk only, and Bergamot mode does not", async () => {
  reset();
  const { host, catalogCalls } = chromeHost();
  const list = (await host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "models-list" })) as { engineSupported: boolean };
  assert.deepEqual(catalogCalls, [{ maxAgeMs: 24 * 60 * 60 * 1000, offline: true }]);
  assert.equal(list.engineSupported, true);
  // The control: without the engine field the same request would go to the network, which the
  // store above refuses. If this stopped throwing, the assertion above would prove nothing.
  await assert.rejects(host.handle({ target: ENGINE_TARGET, type: "models-list" }), /fetched in Chrome mode/);
  assert.deepEqual(fetches, []);
  await host.shutdown();
});

test("without the browser's Translator there is no route, and translating says so", async () => {
  reset();
  const saved = globals.Translator;
  delete globals.Translator;
  try {
    const engine = new ChromeEngine();
    assert.equal((await engine.routeStatus("es", "en")).hops, null);
    await assert.rejects(engine.translate("es", "en", ["Hola"]), (error: Error) => error.message === CHROME_UNAVAILABLE);
  } finally {
    globals.Translator = saved;
  }
});

test("one block Chrome refuses stays as it was and the rest of the batch is translated", async () => {
  reset();
  availability.set("fr->en", "available");
  const { host } = chromeHost();
  const answer = (await host.handle({
    target: ENGINE_TARGET,
    engine: "chrome",
    type: "translate",
    sourceLanguage: "fr",
    targetLanguage: "en",
    fragments: ["Bonjour", "TOO LONG un très long tableau", "Au revoir"]
  })) as { fragments: string[]; notice?: string };
  assert.deepEqual(answer.fragments, ["EN[Bonjour]", "", "EN[Au revoir]"]);
  assert.equal(answer.notice, CHROME_TOO_LONG, "the page was not told why a block was left alone");
  await host.shutdown();
});

test("a block Chrome refuses on its own, the way a long one is sent, does not stop the page", async () => {
  reset();
  availability.set("fr->en", "available");
  const { host } = chromeHost();
  const request = (fragments: string[]) =>
    host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "translate", sourceLanguage: "fr", targetLanguage: "en", fragments }) as Promise<{
      fragments: string[];
      notice?: string;
    }>;
  const tooLong = await request(["TOO LONG"]);
  assert.deepEqual(tooLong.fragments, [""]);
  assert.equal(tooLong.notice, CHROME_TOO_LONG);
  const flaky = await request(["FLAKY", "  "]);
  // The refused block and the whitespace-only one both come back empty; only the first was sent.
  assert.deepEqual(flaky.fragments, ["", ""]);
  assert.match(flaky.notice ?? "", /Other generic failures/);
  const clean = await request(["Merci"]);
  assert.equal(clean.notice, undefined, "a batch with nothing refused carried a notice");
  await host.shutdown();
});

test("the options page's Download still reaches Bergamot with Chrome selected", async () => {
  reset();
  availability.set("fr->en", "available");
  const { host, catalogCalls } = chromeHost();
  // The store above refuses an online catalog read, which is exactly where Bergamot's download
  // starts. Reaching it proves the request went to Bergamot; Chrome's engine would have answered.
  await assert.rejects(
    host.handle({ target: ENGINE_TARGET, engine: "chrome", type: "ensure-route", sourceLanguage: "fr", targetLanguage: "en" }),
    /fetched in Chrome mode/
  );
  assert.deepEqual(catalogCalls, [{ maxAgeMs: 24 * 60 * 60 * 1000 }]);
  assert.deepEqual(created, [], "Chrome's translator was asked for a Bergamot download");
  await host.shutdown();
});

test("the engine is Bergamot unless the user picked Chrome", () => {
  assert.equal(defaultSettings("en-US").engine, "bergamot");
  assert.equal(mergeSettings({ engine: "chrome" }, "en-US").engine, "chrome");
  assert.equal(mergeSettings({ engine: "google" }, "en-US").engine, "bergamot");
});

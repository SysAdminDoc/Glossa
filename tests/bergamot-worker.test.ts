import assert from "node:assert/strict";
import { test } from "node:test";

// The translation worker's bookkeeping, with Bergamot faked: which models are built, shared between
// routes, and let go. Each real model costs about 140 MB of heap, so building one twice, or keeping
// one nobody can use, is the defect this guards against.

const built: string[] = [];
const deleted: string[] = [];
const posted = new Map<number, { ok: boolean; result?: unknown; error?: string }>();
// Pairs whose model fails to build, the way a damaged file does.
const unbuildable = new Set<string>();

class FakeMemory {
  private readonly bytes: Uint8Array;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }
  getByteArrayView() {
    return this.bytes;
  }
  delete() {}
}

const fakeModule = {
  HEAP8: new Int8Array(64),
  AlignedMemory: FakeMemory,
  AlignedMemoryList: class {
    push_back() {}
  },
  TranslationModel: class {
    readonly source: string;
    readonly target: string;
    constructor(source: string, target: string) {
      if (unbuildable.has(`${source}->${target}`)) throw new Error(`Marian could not read ${source}->${target}`);
      this.source = source;
      this.target = target;
      built.push(`${source}->${target}`);
    }
    delete() {
      deleted.push(`${this.source}->${this.target}`);
    }
  },
  BlockingService: class {
    translate(model: { source: string; target: string }, messages: { items: string[] }) {
      return responses(messages.items.map((text) => `${model.target}[${text}]`));
    }
    translateViaPivoting(first: { target: string }, second: { target: string }, messages: { items: string[] }) {
      return responses(messages.items.map((text) => `${second.target}[${first.target}[${text}]]`));
    }
  },
  VectorString: class {
    items: string[] = [];
    push_back(text: string) {
      this.items.push(text);
    }
    size() {
      return this.items.length;
    }
    delete() {}
  },
  VectorResponseOptions: class {
    push_back() {}
    delete() {}
  }
};

function responses(texts: string[]) {
  return { size: () => texts.length, get: (index: number) => ({ getTranslatedText: () => texts[index] }), delete() {} };
}

const scope = {
  importScripts() {},
  postMessage(message: { id: number; ok: boolean; result?: unknown; error?: string }) {
    posted.set(message.id, message);
  },
  onmessage: null as ((event: { data: unknown }) => Promise<void>) | null
};
const globals = globalThis as Record<string, unknown>;
globals.self = scope;
globals.loadBergamot = (options: { onRuntimeInitialized: () => void }) => {
  queueMicrotask(() => options.onRuntimeInitialized());
  return fakeModule;
};

await import("../src/engine/bergamot.worker.ts");

let nextId = 1;
async function send(message: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  await scope.onmessage!({ data: { ...message, id } });
  const answer = posted.get(id);
  assert.ok(answer, `no answer to ${String(message["type"])}`);
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

const model = (source: string, target: string) => ({
  sourceLanguage: source,
  targetLanguage: target,
  modelName: `model.${source}${target}.intgemm.alphas.bin`,
  files: { model: new ArrayBuffer(8), lex: new ArrayBuffer(8), vocab: new ArrayBuffer(8) }
});
const status = () => send({ type: "status" }) as Promise<{ loaded: string[]; models: string[]; heapBytes: number }>;

await send({ type: "init", wasm: new ArrayBuffer(8) });

test("a pivot route uses the model its direct route already loaded", async () => {
  await send({ type: "load-route", routeKey: "es->en", models: [model("es", "en")] });
  await send({ type: "load-route", routeKey: "es->en|en->fr", models: [model("es", "en"), model("en", "fr")] });
  assert.deepEqual(built, ["es->en", "en->fr"], "es->en was built a second time for the pivot route");
  const now = await status();
  assert.deepEqual(now.loaded, ["es->en", "es->en|en->fr"]);
  assert.deepEqual(now.models, ["es->en", "en->fr"]);
  assert.equal(now.heapBytes, 64, "the heap size is not reported");
  const answer = (await send({ type: "translate", routeKey: "es->en|en->fr", fragments: ["hola"], html: false })) as { fragments: string[] };
  assert.deepEqual(answer.fragments, ["fr[en[hola]]"]);
});

test("a third model fits beside a pivot route, and a fourth evicts the one used longest ago", async () => {
  await send({ type: "load-route", routeKey: "es->en|en->de", models: [model("es", "en"), model("en", "de")] });
  assert.deepEqual(built, ["es->en", "en->fr", "en->de"]);
  assert.deepEqual(deleted, [], "a model was evicted with room for three");
  // en->fr was last used by the pivot translation in the first test; everything else since.
  await send({ type: "translate", routeKey: "es->en|en->de", fragments: ["hola"], html: false });
  await send({ type: "load-route", routeKey: "it->en", models: [model("it", "en")] });
  assert.deepEqual(deleted, ["en->fr"]);
  const now = await status();
  assert.deepEqual(now.models, ["es->en", "en->de", "it->en"]);
  assert.deepEqual(now.loaded, ["es->en", "es->en|en->de", "it->en"], "a route through the evicted model was still listed");
  await assert.rejects(send({ type: "translate", routeKey: "es->en|en->fr", fragments: ["hola"], html: false }), /not loaded/);
});

test("a route whose second model fails to build leaves no model behind that nothing uses", async () => {
  unbuildable.add("en->pt");
  await assert.rejects(send({ type: "load-route", routeKey: "de->en|en->pt", models: [model("de", "en"), model("en", "pt")] }), /could not read/);
  const now = await status();
  assert.ok(!now.models.includes("de->en"), `de->en was left loaded with no route: ${JSON.stringify(now.models)}`);
  for (const route of now.loaded) {
    for (const key of route.split("|")) assert.ok(now.models.includes(key), `${route} is listed but ${key} is gone`);
  }
  unbuildable.clear();
});

test("unloading a route lets go of the models no other route uses", async () => {
  await send({ type: "load-route", routeKey: "es->en", models: [model("es", "en")] });
  await send({ type: "load-route", routeKey: "es->en|en->de", models: [model("es", "en"), model("en", "de")] });
  await send({ type: "unload-route", routeKey: "es->en|en->de" });
  const after = await status();
  assert.ok(!after.models.includes("en->de"), "en->de outlived its only route");
  assert.ok(after.models.includes("es->en"), "es->en went although its own route still uses it");
  assert.deepEqual(((await send({ type: "translate", routeKey: "es->en", fragments: ["hola", " "], html: false })) as { fragments: string[] }).fragments, ["en[hola]", ""]);
});

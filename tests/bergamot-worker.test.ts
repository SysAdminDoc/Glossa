import assert from "node:assert/strict";
import { test } from "node:test";

// The translation worker's bookkeeping, with Bergamot faked: which models are built, shared between
// routes, and let go. Each real model costs about 170 MB of heap, so building one twice, or keeping
// one nobody can use, is the defect this guards against.

const built: string[] = [];
const deleted: string[] = [];
const posted = new Map<number, { ok: boolean; result?: unknown; error?: string }>();

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

test("a third model evicts one the new route does not use, and every route that ran through it", async () => {
  // The new route needs es->en, which is loaded, and en->de, which is not: en->fr has to make room.
  await send({ type: "load-route", routeKey: "es->en|en->de", models: [model("es", "en"), model("en", "de")] });
  assert.deepEqual(built, ["es->en", "en->fr", "en->de"]);
  assert.deepEqual(deleted, ["en->fr"]);
  const now = await status();
  assert.deepEqual(now.models, ["es->en", "en->de"]);
  assert.deepEqual(now.loaded, ["es->en", "es->en|en->de"], "a route through the evicted model was still listed");
  await assert.rejects(send({ type: "translate", routeKey: "es->en|en->fr", fragments: ["hola"], html: false }), /not loaded/);
});

test("unloading a route lets go of the models no other route uses", async () => {
  await send({ type: "unload-route", routeKey: "es->en|en->de" });
  assert.deepEqual(deleted, ["en->fr", "en->de"], "en->de outlived its only route, or es->en went with it");
  assert.deepEqual((await status()).models, ["es->en"]);
  assert.deepEqual(((await send({ type: "translate", routeKey: "es->en", fragments: ["hola", " "], html: false })) as { fragments: string[] }).fragments, ["en[hola]", ""]);
});

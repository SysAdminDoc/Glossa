import assert from "node:assert/strict";
import { test } from "node:test";

// The engine host owns a Web Worker it cannot see inside. These tests give it a fake one so the
// parts that matter without WebAssembly can be exercised: what happens when the worker dies mid
// batch, and what the host holds on to afterwards.

interface FakeRequest {
  type: string;
  id: number;
  routeKey?: string;
  fragments?: string[];
}

const workers: FakeWorker[] = [];
// Set to make every worker, including replacements, die on a translate.
let crashEveryWorker = false;

// How long the fake worker takes to answer. Zero keeps the fast tests fast; a test that needs a
// call to still be in flight when something else happens sets it.
let answerDelayMs = 0;

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly seen: FakeRequest[] = [];
  terminated = false;
  // Set to make the next translate look like a worker that aborted instead of answering.
  crashOnTranslate = false;

  constructor() {
    workers.push(this);
  }

  postMessage(message: FakeRequest): void {
    this.seen.push(message);
    const deliver = () => {
      if (message.type === "translate" && (this.crashOnTranslate || crashEveryWorker)) {
        this.onerror?.({ message: "simulated abort" });
        return;
      }
      const result =
        message.type === "status"
          ? { loaded: [message.routeKey ?? "es->en"] }
          : message.type === "translate"
            ? { fragments: (message.fragments ?? []).map((f) => `EN(${f})`), inferenceMs: 1 }
            : {};
      this.onmessage?.({ data: { id: message.id, ok: true, result } });
    };
    if (answerDelayMs > 0) setTimeout(deliver, answerDelayMs);
    else queueMicrotask(deliver);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const globals = globalThis as Record<string, unknown>;
globals.Worker = FakeWorker;
globals.chrome = {
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: () => Promise.resolve(undefined)
  }
};
globals.fetch = () => Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
// esbuild substitutes this in a real build; Node's type stripping does not, so the test provides it.
globals.__GLOSSA_HAS_OFFSCREEN__ = true;

const { EngineHost, NO_SIMD_MESSAGE, supportsSimd } = await import("../src/engine/engine-host.ts");

function record(fileType: string, source: string, target: string) {
  return {
    id: `${fileType}-${source}${target}`,
    name: `${fileType}.${source}${target}.bin`,
    version: "3.0",
    fileType,
    sourceLanguage: source,
    targetLanguage: target,
    attachment: { hash: "0".repeat(64), size: 10, filename: "x.zst", location: "x", mimetype: "application/zstd" },
    decompressedHash: "1".repeat(64),
    decompressedSize: 20
  };
}

// The store is the only part that talks to the network and to Cache storage. Everything it would
// have fetched is answered here, so the tests stay about the host.
function fakeStore(host: { store: Record<string, unknown> }): void {
  host.store["getCatalog"] = async () => ({
    fetchedAt: Date.now(),
    records: [record("model", "es", "en"), record("vocab", "es", "en")]
  });
  host.store["ensurePair"] = async () => ({ model: new ArrayBuffer(4), vocab: new ArrayBuffer(4) });
  host.store["isPairInstalled"] = async () => true;
  host.store["listInstalled"] = async () => [];
  host.store["activeSource"] = async () => "mozilla-cdn";
}

test("the SIMD probe actually tests SIMD", async () => {
  assert.equal(supportsSimd(), true);
  assert.match(NO_SIMD_MESSAGE, /SIMD/);
  // A module without a v128 in it would validate on any engine, so the probe has to be shown to
  // depend on the SIMD opcode: corrupting that one instruction must make it invalid.
  const { SIMD_PROBE } = await import("../src/engine/engine-host.ts");
  const prefix = SIMD_PROBE.indexOf(0xfd);
  assert.ok(prefix > 0, "the probe carries no SIMD opcode prefix");
  assert.equal(SIMD_PROBE[prefix + 1], 0x0c, "the opcode after the prefix is not v128.const");
  assert.ok(SIMD_PROBE.includes(0x7b), "the probe does not return a v128");
  // Take one byte out of the sixteen the v128 constant needs. That only breaks a module the engine
  // is really parsing as SIMD, which is what makes this a probe rather than a formality.
  const short = Uint8Array.from([...SIMD_PROBE.subarray(0, prefix + 2), ...SIMD_PROBE.subarray(prefix + 3)]);
  assert.equal(WebAssembly.validate(short), false, "the probe validates with a malformed v128 constant");
});

test("a translation goes to the worker and comes back", async () => {
  workers.length = 0;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  const result = (await host.translate("es", "en", ["Hola"])) as { fragments: string[] };
  assert.deepEqual(result.fragments, ["EN(Hola)"]);
  assert.equal(workers.length, 1);
  await host.shutdown();
});

test("a worker that dies mid batch is replaced and the batch is finished", async () => {
  workers.length = 0;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  // Warm the engine, then arrange for the next translate to abort the worker.
  await host.translate("es", "en", ["uno"]);
  workers[0]!.crashOnTranslate = true;
  const result = (await host.translate("es", "en", ["dos"])) as { fragments: string[] };
  assert.deepEqual(result.fragments, ["EN(dos)"], "the retry did not produce a translation");
  assert.equal(workers.length, 2, "the host did not start a replacement worker");
  assert.equal(workers[1]?.seen.some((request) => request.type === "translate"), true, "the replacement worker was never asked to translate");
  await host.shutdown();
});

test("a second death on the same batch is reported rather than retried forever", async () => {
  workers.length = 0;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  await host.translate("es", "en", ["uno"]);
  crashEveryWorker = true;
  try {
    await assert.rejects(host.translate("es", "en", ["dos"]), /abort/i);
    // One warm worker, one replacement, and no more: a dead engine is reported, not looped on.
    assert.equal(workers.length, 2, `expected one retry, ${workers.length} workers were started`);
  } finally {
    crashEveryWorker = false;
    await host.shutdown();
  }
});

test("shutdown lets go of the worker and tells its host page to close", async () => {
  workers.length = 0;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  let closed = 0;
  host.onIdle = () => {
    closed++;
  };
  await host.translate("es", "en", ["Hola"]);
  await host.shutdown();
  assert.equal(workers[0]?.terminated, true, "the worker was left running");
  assert.equal(closed, 1, "the host page was not asked to close");
  // A translation after a shutdown starts a fresh worker rather than failing.
  const again = (await host.translate("es", "en", ["otra vez"])) as { fragments: string[] };
  assert.deepEqual(again.fragments, ["EN(otra vez)"]);
  assert.equal(workers.length, 2);
  await host.shutdown();
});

test("a shutdown while a call is in flight fails that call instead of hanging on it", async () => {
  workers.length = 0;
  answerDelayMs = 50;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  try {
    const inFlight = host.translate("es", "en", ["uno"]);
    // Something else tears the engine down while the worker is still thinking.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.shutdown();
    await assert.rejects(inFlight, /shut down/i, "the in-flight call never settled");

    // And the host still works afterwards rather than being stuck behind a promise that never ends.
    answerDelayMs = 0;
    const after = (await host.translate("es", "en", ["dos"])) as { fragments: string[] };
    assert.deepEqual(after.fragments, ["EN(dos)"], "the host was left unusable by the shutdown");
  } finally {
    answerDelayMs = 0;
    await host.shutdown();
  }
});

test("a route that was being loaded when the engine stopped can be loaded again", async () => {
  workers.length = 0;
  answerDelayMs = 50;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  try {
    const first = host.translate("es", "en", ["uno"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.shutdown();
    await assert.rejects(first, /shut down/i);
    answerDelayMs = 0;
    const key = await host.ensureRoute("es", "en");
    assert.equal(key, "es->en", "the route stayed stuck on the interrupted load");
  } finally {
    answerDelayMs = 0;
    await host.shutdown();
  }
});

test("the second worker death on the same page is recovered too", async () => {
  workers.length = 0;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  try {
    await host.translate("es", "en", ["bloque uno"]);
    // First abort, first recovery.
    workers[workers.length - 1]!.crashOnTranslate = true;
    assert.deepEqual(((await host.translate("es", "en", ["bloque dos"])) as { fragments: string[] }).fragments, [
      "EN(bloque dos)"
    ]);
    // Later on the same page, the engine dies again. The retry budget is per batch, so this one
    // recovers as well rather than abandoning the rest of the page.
    workers[workers.length - 1]!.crashOnTranslate = true;
    const third = (await host.translate("es", "en", ["bloque tres"])) as { fragments: string[] };
    assert.deepEqual(third.fragments, ["EN(bloque tres)"], "the second abort on the page was not recovered");
  } finally {
    await host.shutdown();
  }
});

test("a failure that is not the worker dying does not spend the retry budget", async () => {
  workers.length = 0;
  const host = new EngineHost();
  fakeStore(host as unknown as { store: Record<string, unknown> });
  const store = host.store as unknown as Record<string, unknown>;
  const goodCatalog = store["getCatalog"];
  store["getCatalog"] = async () => {
    throw new Error("offline");
  };
  try {
    await assert.rejects(host.translate("es", "en", ["uno"]), /offline/);
    assert.equal(workers.length, 0, "a catalog failure should not have started a worker");
    store["getCatalog"] = goodCatalog;
    // The budget is intact: a real abort right after still recovers.
    await host.translate("es", "en", ["dos"]);
    workers[workers.length - 1]!.crashOnTranslate = true;
    const recovered = (await host.translate("es", "en", ["tres"])) as { fragments: string[] };
    assert.deepEqual(recovered.fragments, ["EN(tres)"]);
  } finally {
    await host.shutdown();
  }
});

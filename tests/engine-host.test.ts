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
    queueMicrotask(() => {
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
    });
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

test("the SIMD probe is a real module and this machine passes it", () => {
  assert.equal(supportsSimd(), true);
  assert.match(NO_SIMD_MESSAGE, /SIMD/);
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
  assert.equal(workers[1]?.crashOnTranslate, false);
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

import assert from "node:assert/strict";
import { test } from "node:test";

// The model store is the only part of Glossa that talks to the network and to persistent storage.
// These tests give it a fake of each: a Cache API that lives in a Map, and a fetch that can be told
// to drop a connection, refuse a range, or answer a 406 the way Mozilla's CDN does to Chrome.

class FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: null = null;
  readonly headers: { get(name: string): string | null };
  private readonly bytes: Uint8Array;

  // `declared` is what the server says the body is, which is not always what it delivers: that is
  // exactly what a dropped connection looks like from the client side.
  constructor(bytes: Uint8Array, status = 200, declared = bytes.byteLength) {
    this.bytes = bytes;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = { get: (name: string) => (name.toLowerCase() === "content-length" ? String(declared) : null) };
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength) as ArrayBuffer;
  }

  async json(): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(this.bytes));
  }
}

class FakeCache {
  readonly store = new Map<string, Uint8Array>();

  async match(key: string): Promise<FakeResponse | undefined> {
    const value = this.store.get(key);
    return value ? new FakeResponse(value) : undefined;
  }

  async put(key: string, response: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<void> {
    this.store.set(key, new Uint8Array(await response.arrayBuffer()));
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

const caches_ = new Map<string, FakeCache>();
const globals = globalThis as Record<string, unknown>;
globals.caches = {
  open: async (name: string) => {
    const existing = caches_.get(name);
    if (existing) return existing;
    const fresh = new FakeCache();
    caches_.set(name, fresh);
    return fresh;
  }
};
// esbuild substitutes this in a real build; Node's type stripping does not.
globals.__GLOSSA_HAS_OFFSCREEN__ = true;
globals.chrome = { runtime: { getURL: (p: string) => p, sendMessage: async () => undefined }, permissions: { contains: async () => true } };
// Response is NOT faked: the store builds real ones to put in the cache, and the decompression
// helpers read their streams. A fake without a body silently decompresses to nothing.

// The file every test downloads: raw bytes, and the gzip of them that the bucket serves.
const PLAIN = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251));
const { gzipSync } = await import("node:zlib");
const GZIPPED = new Uint8Array(gzipSync(PLAIN));
const { createHash } = await import("node:crypto");
const PLAIN_HASH = createHash("sha256").update(PLAIN).digest("hex");
const GZIP_HASH = createHash("sha256").update(GZIPPED).digest("hex");

interface FetchPlan {
  // Number of bytes to deliver before the connection drops, per attempt. undefined means all of it.
  dropAfter?: number[];
  ignoreRange?: boolean;
  calls: Array<{ url: string; range: string | undefined }>;
}

let plan: FetchPlan = { calls: [] };
// When set, any request to Mozilla's attachment CDN answers with this status instead of bytes.
let refuseCdnWith: number | null = null;

globals.fetch = async (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
  const range = init?.headers?.["range"];
  plan.calls.push({ url, range });
  if (init?.signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
  if (refuseCdnWith !== null && url.includes("firefox-settings-attachments")) {
    return new FakeResponse(new Uint8Array(), refuseCdnWith);
  }
  if (url.includes("db/models.json")) {
    return new FakeResponse(
      new TextEncoder().encode(
        JSON.stringify({
          baseUrl: "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data",
          models: {
            "es-en": [
              {
                files: {
                  model: { path: "models/es-en/model.bin.gz", uncompressedHash: PLAIN_HASH },
                  vocab: { path: "models/es-en/vocab.bin.gz", uncompressedHash: PLAIN_HASH }
                }
              }
            ]
          }
        })
      )
    );
  }
  const attempt = plan.calls.filter((c) => c.url === url).length - 1;
  const dropAfter = plan.dropAfter?.[attempt];
  const start = range && !plan.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
  const slice = GZIPPED.subarray(start, dropAfter === undefined ? undefined : start + dropAfter);
  // A dropped connection: the server promised the rest of the file and delivered part of it.
  const declared = GZIPPED.byteLength - start;
  return new FakeResponse(slice, start > 0 ? 206 : 200, declared);
};

const { ModelStore } = await import("../src/engine/model-store.ts");

function record(fileType: string, id: string) {
  return {
    id,
    name: `${fileType}.esen.bin`,
    version: "3.0",
    fileType,
    sourceLanguage: "es",
    targetLanguage: "en",
    attachment: {
      hash: GZIP_HASH,
      size: GZIPPED.byteLength,
      filename: `${fileType}.bin.zst`,
      location: `main-workspace/${id}.zst`,
      mimetype: "application/zstd"
    },
    decompressedHash: PLAIN_HASH,
    decompressedSize: PLAIN.byteLength
  };
}

function pair() {
  return {
    sourceLanguage: "es",
    targetLanguage: "en",
    version: "3.0",
    records: { model: record("model", "m1"), vocab: record("vocab", "v1") }
  };
}

// A store that has not been told anything about the CDN yet, so it tries the CDN first the way a
// fresh install does.
function freshStoreTryingCdn() {
  caches_.clear();
  plan = { calls: [] };
  return new ModelStore();
}

function freshStore() {
  caches_.clear();
  plan = { calls: [] };
  const store = new ModelStore();
  // Pretend the CDN already refused us, so every test takes the bucket path with its gzip files.
  (store as unknown as { sourceState: unknown }).sourceState = { cdnRefusedAt: Date.now() };
  return store;
}

test("two callers asking for the same pair share one download", async () => {
  const store = freshStore();
  const [a, b] = await Promise.all([
    store.ensurePair(pair() as never, () => undefined),
    store.ensurePair(pair() as never, () => undefined)
  ]);
  assert.ok(a.model && b.model);
  const modelFetches = plan.calls.filter((c) => c.url.endsWith("model.bin.gz")).length;
  assert.equal(modelFetches, 1, `the model file was fetched ${modelFetches} times`);
  assert.equal(await store.isPairInstalled(pair() as never), true);
});

test("a dropped connection resumes from where it stopped instead of starting over", async () => {
  const store = freshStore();
  // The first attempt at each file delivers half and then fails the size check.
  plan.dropAfter = [Math.floor(GZIPPED.byteLength / 2)];
  await store.ensurePair(pair() as never, () => undefined);
  const modelCalls = plan.calls.filter((c) => c.url.endsWith("model.bin.gz"));
  assert.equal(modelCalls.length, 2, "the model file should have been asked for twice");
  assert.equal(modelCalls[0]?.range, undefined, "the first attempt asked for a range");
  assert.equal(
    modelCalls[1]?.range,
    `bytes=${Math.floor(GZIPPED.byteLength / 2)}-`,
    "the retry did not ask for the rest of the file"
  );
  assert.equal(await store.isPairInstalled(pair() as never), true);
});

test("cancelling leaves nothing installed and nothing half-written", async () => {
  const store = freshStore();
  const running = store.ensurePair(pair() as never, () => undefined);
  await store.cancel("es->en");
  await assert.rejects(running, /cancelled/i);
  assert.equal(await store.isPairInstalled(pair() as never), false);
  assert.deepEqual(await store.listInstalled(), []);
  const models = caches_.get("glossa-models-v1");
  const leftovers = [...(models?.store.keys() ?? [])].filter((key) => key.includes("/partial/"));
  assert.deepEqual(leftovers, [], `a cancelled download left ${leftovers.length} partial files behind`);
});

test("a download that cannot fit is refused before it starts", async () => {
  const store = freshStore();
  // navigator is a getter on globalThis in Node, so it has to be redefined rather than assigned.
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { estimate: async () => ({ quota: 1_000_000, usage: 999_000 }) } }
  });
  try {
    await assert.rejects(store.ensurePair(pair() as never, () => undefined), /free storage/i);
    assert.equal(plan.calls.length, 0, "bytes were requested despite there being no room");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("resetting the byte source sends the next download back to the CDN", async () => {
  const store = freshStore();
  assert.equal(await store.activeSource(), "mozilla-gcs");
  await store.resetSource();
  assert.equal(await store.activeSource(), "mozilla-cdn");
});

test("a CDN that refuses this browser sends the download to the bucket, once", async () => {
  const store = freshStoreTryingCdn();
  // What Mozilla's attachment CDN answers to any user agent containing "Chrome".
  refuseCdnWith = 406;
  try {
    await store.ensurePair(pair() as never, () => undefined);
    const cdnCalls = plan.calls.filter((call) => call.url.includes("firefox-settings-attachments"));
    const bucketCalls = plan.calls.filter((call) => call.url.includes("model.bin.gz") || call.url.includes("vocab.bin.gz"));
    assert.equal(cdnCalls.length, 1, `the CDN was asked ${cdnCalls.length} times after refusing`);
    assert.equal(bucketCalls.length, 2, "both files should have come from the bucket");
    assert.equal(await store.activeSource(), "mozilla-gcs", "the refusal was not remembered");
    assert.equal(await store.isPairInstalled(pair() as never), true);
  } finally {
    refuseCdnWith = null;
  }
});

test("a CDN failure that is not a refusal is reported rather than silently rerouted", async () => {
  const store = freshStoreTryingCdn();
  refuseCdnWith = 500;
  try {
    await assert.rejects(store.ensurePair(pair() as never, () => undefined), /50\d/);
    assert.equal(await store.activeSource(), "mozilla-cdn", "a server error was mistaken for a refusal");
  } finally {
    refuseCdnWith = null;
  }
});

test("a cached file cut short is fetched again instead of reaching the engine", async () => {
  const store = freshStore();
  await store.ensurePair(pair() as never, () => undefined);
  // Damage the cached model the way a truncated entry looks: right key, too few bytes.
  const models = caches_.get("glossa-models-v1");
  const key = [...(models?.store.keys() ?? [])].find((entry) => entry.endsWith("/models/m1"));
  assert.ok(models && key, "the model was not cached");
  models.store.set(key, models.store.get(key)!.subarray(0, 100));
  plan = { calls: [] };
  const bytes = await store.ensurePair(pair() as never, () => undefined);
  assert.equal(bytes.model?.byteLength, PLAIN.byteLength, "the short file reached the engine");
  assert.equal(plan.calls.filter((call) => call.url.endsWith("model.bin.gz")).length, 1, "the short model was not fetched again");
  assert.equal(plan.calls.filter((call) => call.url.endsWith("vocab.bin.gz")).length, 0, "an intact file was fetched again");
  assert.equal(models.store.get(key)?.byteLength, PLAIN.byteLength, "the cache still holds the short file");
});

test("persistent storage is asked for once, when the first file is downloaded", async () => {
  const store = freshStore();
  let asked = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        persist: async () => {
          asked++;
          return true;
        }
      }
    }
  });
  try {
    await store.ensurePair(pair() as never, () => undefined);
    assert.equal(asked, 1, "the first download did not ask to keep its storage");
    // Everything is cached now: loading it again downloads nothing and asks nothing.
    await store.ensurePair(pair() as never, () => undefined);
    assert.equal(asked, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

// Rewrites the stored installed-pairs entry for es->en, the way an older build would have left it.
function patchInstalledEntry(patch: Record<string, unknown>): void {
  const meta = caches_.get("glossa-meta-v1");
  const key = "https://store.glossa.invalid/meta/installedPairs";
  const stored = meta?.store.get(key);
  assert.ok(meta && stored, "nothing was installed");
  const manifest = JSON.parse(new TextDecoder().decode(stored)) as Record<string, Record<string, unknown>>;
  manifest["es->en"] = { ...manifest["es->en"], ...patch };
  meta.store.set(key, new TextEncoder().encode(JSON.stringify(manifest)));
}

test("a model installed for another engine major is not installed for this one", async () => {
  const store = freshStore();
  await store.ensurePair(pair() as never, () => undefined);
  assert.equal(await store.isPairInstalled(pair() as never), true);
  patchInstalledEntry({ engineMajor: 5 });
  assert.equal(await store.isPairInstalled(pair() as never), false, "a model from another engine counted as installed");
  assert.deepEqual(await store.listInstalled(), [], "the options page would list it as usable");
  patchInstalledEntry({ engineMajor: 4, modelMajor: 2 });
  assert.equal(await store.isPairInstalled(pair() as never), false, "a model of another model major counted as installed");
});

test("a model installed before entries were stamped counts as this engine's", async () => {
  const store = freshStore();
  await store.ensurePair(pair() as never, () => undefined);
  // JSON drops undefined, so this leaves the entry exactly as a build before the stamps wrote it.
  patchInstalledEntry({ engineMajor: undefined, modelMajor: undefined });
  assert.equal(await store.isPairInstalled(pair() as never), true);
});

test("replacing a pair's files drops the old ones and keeps what is still used", async () => {
  const store = freshStore();
  await store.ensurePair(pair() as never, () => undefined);
  // The same pair with a newer model file: a new record id for the model, the same vocab.
  const newer = pair();
  newer.records.model = record("model", "m2");
  plan = { calls: [] };
  await store.ensurePair(newer as never, () => undefined);
  const keys = [...(caches_.get("glossa-models-v1")?.store.keys() ?? [])];
  assert.ok(!keys.some((entry) => entry.endsWith("/models/m1")), "the old model file stayed in the cache");
  assert.ok(keys.some((entry) => entry.endsWith("/models/m2")), "the new model file was not cached");
  assert.ok(keys.some((entry) => entry.endsWith("/models/v1")), "a file the pair still uses was deleted");
});

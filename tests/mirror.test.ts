import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

// A model mirror is the only place the store may ask once one is set. The network here serves a
// mirror and a stand-in for Mozilla's catalog, records every address it is asked for, and refuses
// anything else. The Cache API lives in a Map, and the permission API answers per origin.

class FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: null = null;
  readonly headers: { get(name: string): string | null };
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, status = 200, extra: Record<string, string> = {}) {
    this.bytes = bytes;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = {
      get: (name: string) => (name.toLowerCase() === "content-length" ? String(bytes.byteLength) : (extra[name.toLowerCase()] ?? null))
    };
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength) as ArrayBuffer;
  }

  async json(): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(this.bytes));
  }
}

// Keeps each entry's headers as well as its bytes, the way the real Cache API does.
class FakeCache {
  readonly store = new Map<string, { bytes: Uint8Array; headers: Record<string, string> }>();
  async match(key: string): Promise<FakeResponse | undefined> {
    const value = this.store.get(key);
    return value ? new FakeResponse(value.bytes, 200, value.headers) : undefined;
  }
  async put(
    key: string,
    response: { arrayBuffer(): Promise<ArrayBuffer>; headers?: { forEach(callback: (value: string, name: string) => void): void } }
  ): Promise<void> {
    const headers: Record<string, string> = {};
    response.headers?.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    this.store.set(key, { bytes: new Uint8Array(await response.arrayBuffer()), headers });
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

const caches_ = new Map<string, FakeCache>();
const globals = globalThis as Record<string, unknown>;
globals.caches = {
  open: async (name: string) => {
    const existing = caches_.get(name) ?? new FakeCache();
    caches_.set(name, existing);
    return existing;
  }
};
// Which host patterns the browser has granted. null grants everything.
let grantedOrigins: Set<string> | null = null;
globals.chrome = {
  runtime: { getURL: (p: string) => p, sendMessage: async () => undefined },
  permissions: {
    contains: async ({ origins }: { origins: string[] }) => grantedOrigins === null || origins.every((origin) => grantedOrigins!.has(origin))
  },
  storage: { local: {} },
  i18n: { getUILanguage: () => "en-US", getMessage: () => "" }
};
globals.__GLOSSA_HAS_OFFSCREEN__ = true;

const MIRROR = "https://models.example.org/glossa/";
const MOZILLA_CATALOG = "https://firefox.settings.services.mozilla.com/";
const PLAIN = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251));
const ZSTD = new Uint8Array(zstdCompressSync(PLAIN));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function record(fileType: string, id: string) {
  return {
    id,
    name: `${fileType}.esen.bin`,
    version: "3.0",
    fileType,
    sourceLanguage: "es",
    targetLanguage: "en",
    attachment: {
      hash: sha256(ZSTD),
      size: ZSTD.byteLength,
      filename: `${fileType}.esen.bin.zst`,
      location: `main-workspace/translations-models-v2/${id}.zst`,
      mimetype: "application/zstd"
    },
    decompressedHash: sha256(PLAIN),
    decompressedSize: PLAIN.byteLength
  };
}

const MIRROR_RECORDS = [record("model", "m1"), record("vocab", "v1")];
// Mozilla's catalog here holds a different pair, so a catalog served for the wrong source shows.
const MOZILLA_RECORDS = [{ ...record("model", "fr1"), sourceLanguage: "fr" }];

const calls: string[] = [];
let tamper = false;
let unreachable = false;
// Set to hold Mozilla's catalog answer back, so a request to it can be caught in flight.
let holdMozilla: Promise<void> | null = null;
// Set to hold the mirror's model files back, so a download can be caught halfway.
let holdMirrorFiles: Promise<void> | null = null;

function json(value: unknown) {
  return new FakeResponse(new TextEncoder().encode(JSON.stringify(value)));
}

globals.fetch = async (url: string) => {
  calls.push(url);
  if (unreachable) throw new TypeError("Failed to fetch");
  if (url === `${MIRROR}records.json`) return json({ data: MIRROR_RECORDS });
  if (url.startsWith(MIRROR)) {
    if (holdMirrorFiles) await holdMirrorFiles;
    const bytes = ZSTD.slice();
    if (tamper) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    return new FakeResponse(bytes);
  }
  if (url.startsWith(MOZILLA_CATALOG)) {
    if (holdMozilla) await holdMozilla;
    return json({ data: MOZILLA_RECORDS });
  }
  return new FakeResponse(new Uint8Array(), 403);
};

const { ModelStore } = await import("../src/engine/model-store.ts");
const { EngineHost } = await import("../src/engine/engine-host.ts");
const { MODEL_ORIGINS, mirrorPermissionPattern, normalizeMirrorUrl } = await import("../src/shared/catalog.ts");
const { mergeSettings } = await import("../src/shared/settings.ts");
const { ENGINE_TARGET } = await import("../src/shared/messages.ts");

function reset(): void {
  caches_.clear();
  calls.length = 0;
  tamper = false;
  unreachable = false;
  holdMozilla = null;
  holdMirrorFiles = null;
  grantedOrigins = null;
}

function freshStore(mirror: string | null) {
  reset();
  const store = new ModelStore();
  store.setMirror(mirror);
  return store;
}

const PAIR = { sourceLanguage: "es", targetLanguage: "en", version: "3.0", records: { model: MIRROR_RECORDS[0], vocab: MIRROR_RECORDS[1] } };

test("with a mirror set, the catalog and every model file come from it and from nowhere else", async () => {
  const store = freshStore(MIRROR);
  const catalog = await store.getCatalog({ maxAgeMs: 60_000 });
  assert.deepEqual(catalog?.records.map((entry) => entry.id), ["m1", "v1"]);
  const bytes = await store.ensurePair(PAIR as never, () => undefined);
  assert.equal(bytes.model?.byteLength, PLAIN.byteLength, "the model did not decompress to its catalog size");
  assert.equal(await store.isPairInstalled(PAIR as never), true);
  assert.equal(await store.activeSource(), "mirror");
  assert.deepEqual(calls.filter((url) => !url.startsWith(MIRROR)), [], "something other than the mirror was asked");
  assert.ok(calls.includes(`${MIRROR}main-workspace/translations-models-v2/m1.zst`), "the model file was not fetched from the mirror");
});

test("a catalog from one source is never served for the other", async () => {
  const store = freshStore(null);
  assert.deepEqual((await store.getCatalog({ maxAgeMs: 60_000 }))?.records.map((entry) => entry.id), ["fr1"]);
  store.setMirror(MIRROR);
  // Fresh enough by age, but it is Mozilla's: the mirror's own catalog has to be fetched.
  assert.deepEqual((await store.getCatalog({ maxAgeMs: 60_000 }))?.records.map((entry) => entry.id), ["m1", "v1"]);
  store.setMirror(null);
  assert.deepEqual((await store.getCatalog({ maxAgeMs: 60_000 }))?.records.map((entry) => entry.id), ["fr1"]);
  assert.equal(calls.length, 3, `expected one catalog request per switch, saw ${calls.length}`);
});

test("switching to a mirror while Mozilla's catalog is still loading gets the mirror's", async () => {
  const store = freshStore(null);
  let release: () => void = () => undefined;
  holdMozilla = new Promise((resolve) => {
    release = resolve;
  });
  const first = store.getCatalog({ maxAgeMs: 60_000 });
  // Only once Mozilla has actually been asked is its request in flight.
  while (!calls.some((url) => url.startsWith(MOZILLA_CATALOG))) await new Promise((resolve) => setTimeout(resolve, 1));
  store.setMirror(MIRROR);
  // Mozilla answers a little later either way, so a store that waits on it cannot hang the test.
  setTimeout(release, 20);
  const second = await store.getCatalog({ maxAgeMs: 60_000 });
  await first;
  assert.deepEqual(second?.records.map((entry) => entry.id), ["m1", "v1"], "the mirror was given Mozilla's catalog");
});

test("a mirror file that fails its hash is refused, and nothing falls back to Mozilla or Google", async () => {
  const store = freshStore(MIRROR);
  tamper = true;
  await assert.rejects(store.ensurePair(PAIR as never, () => undefined), /from the mirror failed its hash check/);
  assert.equal(await store.isPairInstalled(PAIR as never), false);
  assert.deepEqual(calls.filter((url) => !url.startsWith(MIRROR)), [], "the store went elsewhere after the mirror failed");
});

test("a mirror the browser may not reach is named in the error, whatever Mozilla's hosts allow", async () => {
  const store = freshStore(MIRROR);
  unreachable = true;
  // Mozilla's hosts are granted, the mirror is not: the check has to ask about the mirror.
  grantedOrigins = new Set(MODEL_ORIGINS);
  assert.equal(await store.getCatalog({ maxAgeMs: 60_000 }), null);
  assert.match(store.catalogError ?? "", /your model mirror/);
  assert.deepEqual(calls, [`${MIRROR}records.json`]);
  // With the mirror granted too, a network failure is reported as what it is.
  grantedOrigins.add(mirrorPermissionPattern(MIRROR));
  await store.getCatalog({ maxAgeMs: 60_000 });
  assert.match(store.catalogError ?? "", /Failed to fetch/);
});

test("an engine request carrying a mirror sends the store there, and one without it does not", async () => {
  reset();
  const host = new EngineHost();
  await host.handle({ target: ENGINE_TARGET, type: "models-list", mirror: MIRROR });
  assert.deepEqual(calls, [`${MIRROR}records.json`]);
  calls.length = 0;
  await host.handle({ target: ENGINE_TARGET, type: "models-list" });
  assert.ok(calls[0]?.startsWith(MOZILLA_CATALOG), `a request without a mirror went to ${calls[0]}`);
  await host.shutdown();
});

test("mirror addresses are https, or plain http on this machine, with one trailing slash", () => {
  const cases: Array<[string, string | null]> = [
    ["https://models.example.org/glossa", "https://models.example.org/glossa/"],
    ["  https://models.example.org/glossa/?token=1#top ", "https://models.example.org/glossa/"],
    ["http://127.0.0.1:8080/mirror", "http://127.0.0.1:8080/mirror/"],
    ["http://localhost/m/", "http://localhost/m/"],
    ["http://models.example.org/glossa/", null],
    ["https://user:secret@models.example.org/", null],
    ["javascript:alert(1)", null],
    ["ftp://models.example.org/", null],
    ["models.example.org/glossa", null],
    ["", null]
  ];
  for (const [input, expected] of cases) assert.equal(normalizeMirrorUrl(input), expected, input);
  assert.equal(mirrorPermissionPattern("http://127.0.0.1:8080/mirror/"), "http://127.0.0.1/*");
  assert.equal(mirrorPermissionPattern("https://models.example.org/glossa/"), "https://models.example.org/*");
});

test("a stored mirror address goes through the same check as a typed one", () => {
  assert.equal(mergeSettings({ mirrorUrl: "https://models.example.org/glossa" }, "en-US").mirrorUrl, "https://models.example.org/glossa/");
  assert.equal(mergeSettings({ mirrorUrl: "http://models.example.org/" }, "en-US").mirrorUrl, "");
  assert.equal(mergeSettings({}, "en-US").mirrorUrl, "");
});

test("a file a mirror stored under Mozilla's record id is not taken for Mozilla's", async () => {
  const store = freshStore(MIRROR);
  await store.ensurePair(PAIR as never, () => undefined);
  // Mozilla's catalog names the same record ids with other bytes behind them.
  const OTHER = new Uint8Array(4096).fill(3);
  const mozillaPair = {
    ...PAIR,
    records: {
      model: { ...MIRROR_RECORDS[0], decompressedHash: sha256(OTHER) },
      vocab: { ...MIRROR_RECORDS[1], decompressedHash: sha256(OTHER) }
    }
  };
  store.setMirror(null);
  assert.equal(await store.isPairInstalled(mozillaPair as never), false, "the mirror's files count as Mozilla's");
  calls.length = 0;
  // Mozilla is unreachable in this test, so the only way this resolves is with the mirror's bytes.
  await assert.rejects(store.ensurePair(mozillaPair as never, () => undefined));
  assert.deepEqual(calls.filter((url) => url.startsWith(MIRROR)), [], "the mirror was asked after switching away from it");
});

test("a download keeps the source it started with when the setting changes halfway", async () => {
  const store = freshStore(MIRROR);
  let release: () => void = () => undefined;
  holdMirrorFiles = new Promise((resolve) => {
    release = resolve;
  });
  const running = store.ensurePair(PAIR as never, () => undefined);
  while (!calls.some((url) => url.startsWith(MIRROR) && url.endsWith(".zst"))) await new Promise((resolve) => setTimeout(resolve, 1));
  store.setMirror(null);
  release();
  await running;
  const files = calls.filter((url) => url.endsWith(".zst") || url.endsWith(".gz"));
  assert.equal(files.length, 2);
  assert.deepEqual(files.filter((url) => !url.startsWith(MIRROR)), [], "the download changed source halfway");
});

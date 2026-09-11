import { api } from "../shared/api.ts";
import {
  attachmentUrl,
  ENGINE_MAJOR_VERSION,
  MODEL_MAJOR_VERSION,
  MODEL_ORIGINS,
  MODEL_SOURCES,
  mirrorCatalogUrl,
  mirrorFileUrl,
  mirrorPermissionPattern,
  pairKey,
  REMOTE_SETTINGS,
  type ModelFileType,
  type ModelRecord,
  type PairFiles
} from "../shared/catalog.ts";
import { decompress } from "../shared/compression.ts";
import { sha256Hex } from "../shared/hash.ts";
import type { InstalledPair, ProgressEvent } from "../shared/messages.ts";

// Everything the store persists lives in the Cache API: model bytes under a synthetic URL per
// record id, plus small JSON documents (the catalog, the installed-pairs manifest, the byte-source
// state). The Cache API is the one storage that every context this code runs in can reach:
// Chrome's offscreen document has no chrome.storage at all, Firefox's background page has
// everything. It survives extension updates and holds tens of megabytes without the storage.local
// size cap. Presence in the manifest is a claim, not proof: the cache is checked before any pair
// is reported as installed, so a half-finished download after a crash never shows up as ready.
//
// Bytes come from one of two Mozilla-operated sources that hold byte-identical files:
//   1. The Remote Settings attachment CDN (zstd). It answers 406 to any Chrome user agent, so it
//      effectively serves Firefox only.
//   2. Mozilla's public model registry bucket on Google Cloud Storage (gzip), which serves anyone.
// The Remote Settings catalog is always the hash authority: every file from either source is
// checked against the catalog's decompressed hash and size before it is stored.
// A user who runs their own mirror (tools/mirror-models.mjs) replaces all of this: the catalog and
// every file come from that server only, verified the same way against the mirror's catalog.

const CACHE_NAME = "glossa-models-v1";
const META_CACHE_NAME = "glossa-meta-v1";
const CATALOG_KEY = "catalog";
// The source recorded for Mozilla's own catalog. A mirror's catalog is recorded under its address.
const MOZILLA_SOURCE = "mozilla";
const INSTALLED_KEY = "installedPairs";
const SOURCE_KEY = "byteSource";
const GCS_REGISTRY_KEY = "gcsRegistry";
const CDN_REFUSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A dropped connection on a 40 MB file is ordinary. Three tries with a widening gap, and what
// arrived before the drop is kept so the next try asks only for the rest.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
// Refuse to start a download that cannot fit, with room for the decompressed copy beside it.
const STORAGE_HEADROOM = 2.5;
const GCS_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

// Cache keys must be http(s) URLs; chrome-extension: URLs are refused by Cache.put. The host is
// a reserved .invalid name so the key can never collide with, or be fetched from, a real origin.
const KEY_ORIGIN = "https://store.glossa.invalid";

async function readMeta<T>(key: string): Promise<T | null> {
  const cache = await caches.open(META_CACHE_NAME);
  const hit = await cache.match(metaKey(key));
  if (!hit) return null;
  try {
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

async function writeMeta(key: string, value: unknown): Promise<void> {
  const cache = await caches.open(META_CACHE_NAME);
  await cache.put(
    metaKey(key),
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
  );
}

function metaKey(key: string): string {
  return `${KEY_ORIGIN}/meta/${key}`;
}

function recordKey(id: string): string {
  return `${KEY_ORIGIN}/models/${id}`;
}

// Where a half-finished download waits for the next attempt. Kept apart from the finished file so
// nothing can ever mistake a partial for a complete, verified one.
function partialKey(id: string): string {
  return `${KEY_ORIGIN}/partial/${id}`;
}

export class CancelledError extends Error {
  constructor(pairKey: string) {
    super(`Download of ${pairKey} was cancelled`);
    this.name = "CancelledError";
  }
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof CancelledError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "CancelledError"))
  );
}

interface StoredCatalog {
  fetchedAt: number;
  records: ModelRecord[];
  // Which source served it. Entries written before mirrors existed have none and are Mozilla's.
  source?: string;
}

interface InstalledManifestEntry extends InstalledPair {
  recordIds: string[];
  // The model major and engine major the pair was installed under. Absent on entries written
  // before these were recorded, which were all installed under LEGACY_STAMP.
  modelMajor?: number;
  engineMajor?: number;
}

// The only versions this store ever ran before entries were stamped.
const LEGACY_STAMP = { modelMajor: 3, engineMajor: 4 };

// A model from another model major or another engine major cannot be loaded by the engine that
// ships now, so it counts as not installed and is downloaded again.
function matchesRunningEngine(entry: InstalledManifestEntry): boolean {
  return (
    (entry.modelMajor ?? LEGACY_STAMP.modelMajor) === MODEL_MAJOR_VERSION &&
    (entry.engineMajor ?? LEGACY_STAMP.engineMajor) === ENGINE_MAJOR_VERSION
  );
}

interface SourceState {
  cdnRefusedAt: number | null;
}

interface GcsRegistryFile {
  path: string;
  uncompressedSize?: number;
  uncompressedHash?: string;
}

interface GcsRegistryModel {
  architecture: string;
  sourceLanguage: string;
  targetLanguage: string;
  files: Record<string, GcsRegistryFile>;
}

interface GcsRegistry {
  fetchedAt: number;
  baseUrl: string;
  models: Record<string, GcsRegistryModel[]>;
}

const GCS_FILE_KEYS: Record<ModelFileType, string> = {
  model: "model",
  lex: "lexicalShortlist",
  vocab: "vocab",
  srcvocab: "srcVocab",
  trgvocab: "trgVocab"
};

export type ProgressSink = (event: Omit<ProgressEvent, "target" | "type">) => void;

export type PairBytes = Partial<Record<ModelFileType, ArrayBuffer>>;

export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// Firefox grants `host_permissions` as optional ones and a temporary install starts with none, so a
// network failure there is usually a missing permission rather than a missing network. The check is
// cheap and only runs when a request has already failed.
const MISSING_PERMISSION_MESSAGE =
  "Glossa has no permission to reach Mozilla's model hosts yet. Open the Glossa popup and choose " +
  "\"Allow model downloads\".";

const MISSING_MIRROR_PERMISSION_MESSAGE =
  "Glossa has no permission to reach your model mirror. Open Glossa's options and click \"Use this mirror\" " +
  "again to allow it.";

async function describeNetworkFailure(error: unknown, mirror: string | null): Promise<Error> {
  try {
    const origins = mirror ? [mirrorPermissionPattern(mirror)] : [...MODEL_ORIGINS];
    const granted = await api.permissions.contains({ origins });
    if (!granted) return new Error(mirror ? MISSING_MIRROR_PERMISSION_MESSAGE : MISSING_PERMISSION_MESSAGE);
  } catch {
    // A browser that cannot answer leaves the original error in place.
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface ActiveDownload {
  pairKey: string;
  loadedBytes: number;
  totalBytes: number;
}

export class ModelStore {
  private catalogPromise: Promise<StoredCatalog> | null = null;
  private lastCatalogError: string | null = null;
  private sourceState: SourceState | null = null;
  // The user's own mirror, or null for Mozilla. Set from every engine request.
  private mirror: string | null = null;
  // Which source the catalog request in flight is for, so a switch never reuses the wrong one.
  private catalogPromiseSource: string | null = null;
  // One download per pair, however many callers ask for it, and a handle to stop it.
  private readonly downloads = new Map<string, Promise<PairBytes>>();
  // Which source each running download fetches from: the mirror's address, or null for Mozilla.
  private readonly downloadSources = new Map<string, string | null>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly progressState = new Map<string, ActiveDownload>();

  get catalogError(): string | null {
    return this.lastCatalogError;
  }

  setMirror(mirror: string | null): void {
    this.mirror = mirror;
  }

  // Asked once, the first time a file is actually downloaded. The models are tens of megabytes
  // each, and storage the browser may evict under pressure takes every one of them with it.
  // Extensions holding unlimitedStorage are normally granted this without a prompt; a browser that
  // says no still works, it only keeps the right to evict.
  private persistenceAsked = false;

  private askForPersistence(): void {
    if (this.persistenceAsked) return;
    this.persistenceAsked = true;
    const storage = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator?.storage;
    void storage?.persist?.().catch(() => false);
  }

  private catalogSource(): string {
    return this.mirror ?? MOZILLA_SOURCE;
  }

  // Serve the stored catalog when it is fresh enough; refresh it otherwise. A failed refresh
  // keeps the stale copy, so a machine that is offline still translates with what it has.
  // `offline` serves whatever is stored, however old, and never fetches: Chrome's built-in engine
  // lists languages from it, and that is not a reason to contact Mozilla.
  async getCatalog(options: { maxAgeMs: number; force?: boolean; offline?: boolean }): Promise<StoredCatalog | null> {
    const stored = await this.readStoredCatalog();
    if (options.offline) return stored;
    const age = stored ? Date.now() - stored.fetchedAt : Number.POSITIVE_INFINITY;
    if (stored && !options.force && age < options.maxAgeMs) {
      return stored;
    }
    const source = this.catalogSource();
    if (!this.catalogPromise || this.catalogPromiseSource !== source) {
      this.catalogPromiseSource = source;
      const promise: Promise<StoredCatalog> = this.fetchCatalog(source).finally(() => {
        if (this.catalogPromise === promise) this.catalogPromise = null;
      });
      this.catalogPromise = promise;
    }
    try {
      const fresh = await this.catalogPromise;
      this.lastCatalogError = null;
      return fresh;
    } catch (error) {
      this.lastCatalogError = error instanceof Error ? error.message : String(error);
      return stored;
    }
  }

  private async readStoredCatalog(): Promise<StoredCatalog | null> {
    const value = await readMeta<StoredCatalog>(CATALOG_KEY);
    if (!value || !Array.isArray(value.records) || typeof value.fetchedAt !== "number") return null;
    // A catalog from another source says nothing about this one: switching to a mirror, or back to
    // Mozilla, must not offer pairs the new source cannot serve.
    if ((value.source ?? MOZILLA_SOURCE) !== this.catalogSource()) return null;
    return value;
  }

  private async fetchCatalog(source: string): Promise<StoredCatalog> {
    let response: Response;
    try {
      response = await fetch(source === MOZILLA_SOURCE ? REMOTE_SETTINGS.recordsUrl : mirrorCatalogUrl(source), {
        cache: "no-store"
      });
    } catch (error) {
      throw await describeNetworkFailure(error, source === MOZILLA_SOURCE ? null : source);
    }
    if (!response.ok) {
      throw new HttpError(`Catalog request failed: HTTP ${response.status}`, response.status);
    }
    const body = (await response.json()) as { data?: unknown };
    if (!body || !Array.isArray(body.data)) {
      throw new Error("Catalog response had no record list");
    }
    const records = body.data.filter(isModelRecord);
    if (records.length === 0) {
      throw new Error("Catalog response contained no usable records");
    }
    const catalog: StoredCatalog = { fetchedAt: Date.now(), records, source };
    await writeMeta(CATALOG_KEY, catalog);
    return catalog;
  }

  async listInstalled(): Promise<InstalledPair[]> {
    const manifest = await this.readManifest();
    const cache = await caches.open(CACHE_NAME);
    const result: InstalledPair[] = [];
    for (const entry of Object.values(manifest)) {
      if (matchesRunningEngine(entry) && (await this.entryIsComplete(cache, entry))) {
        result.push({
          pairKey: entry.pairKey,
          sourceLanguage: entry.sourceLanguage,
          targetLanguage: entry.targetLanguage,
          version: entry.version,
          bytes: entry.bytes,
          installedAt: entry.installedAt
        });
      }
    }
    return result;
  }

  async isPairInstalled(pair: PairFiles): Promise<boolean> {
    const manifest = await this.readManifest();
    const entry = manifest[pairKey(pair.sourceLanguage, pair.targetLanguage)];
    if (!entry || !matchesRunningEngine(entry)) return false;
    const wanted = Object.values(pair.records).map((record) => record.id).sort();
    const have = [...entry.recordIds].sort();
    if (wanted.length !== have.length || wanted.some((id, index) => id !== have[index])) return false;
    const cache = await caches.open(CACHE_NAME);
    for (const record of Object.values(pair.records)) {
      const hit = await cache.match(recordKey(record.id));
      if (!hit) return false;
      // The same record id with other bytes is a mirror's file under Mozilla's catalog, or the
      // reverse: not installed for this catalog, whatever the manifest says.
      const stored = hit.headers.get("x-glossa-hash");
      if (stored && record.decompressedHash && stored !== record.decompressedHash) return false;
    }
    return true;
  }

  // What is downloading right now, for any UI that opens mid-download.
  activeDownloads(): ActiveDownload[] {
    return [...this.progressState.values()];
  }

  // Stop a download. Nothing partial is ever reported as installed, so the only cleanup needed is
  // dropping what was kept for a resume.
  async cancel(key: string): Promise<boolean> {
    const controller = this.controllers.get(key);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // Forget that the attachment CDN refused us, so the next download tries it again. Exposed for the
  // options page: the refusal is remembered for a week, which is a long time to be wrong.
  async resetSource(): Promise<void> {
    this.sourceState = null;
    await writeMeta(SOURCE_KEY, { cdnRefusedAt: 0 } satisfies SourceState);
  }

  // Download whatever is missing for a pair, verify it, and return every file's bytes. Two callers
  // asking for the same pair at the same time (the popup and the options page, or two tabs) share
  // one download rather than racing each other for the same bytes.
  ensurePair(pair: PairFiles, progress: ProgressSink): Promise<PairBytes> {
    const key = pairKey(pair.sourceLanguage, pair.targetLanguage);
    const running = this.downloads.get(key);
    if (running) {
      if (this.downloadSources.get(key) === this.mirror) return running;
      // A download from the other source is still going, and its bytes were checked against the
      // other catalog, so they are not this caller's answer. Let it finish, then fetch from this one.
      return running.then(
        () => this.ensurePair(pair, progress),
        () => this.ensurePair(pair, progress)
      );
    }
    const controller = new AbortController();
    this.controllers.set(key, controller);
    // The source is fixed for the whole download: a setting changed halfway applies to the next one.
    const mirror = this.mirror;
    this.downloadSources.set(key, mirror);
    const run = this.downloadPair(pair, key, progress, controller.signal, mirror).finally(() => {
      this.downloads.delete(key);
      this.controllers.delete(key);
      this.progressState.delete(key);
      this.downloadSources.delete(key);
    });
    this.downloads.set(key, run);
    return run;
  }

  private async downloadPair(
    pair: PairFiles,
    key: string,
    progress: ProgressSink,
    signal: AbortSignal,
    mirror: string | null
  ): Promise<PairBytes> {
    const cache = await caches.open(CACHE_NAME);
    const bytes: PairBytes = {};
    const records = Object.entries(pair.records) as Array<[ModelFileType, ModelRecord]>;
    const totalBytes = records.reduce((sum, [, record]) => sum + record.attachment.size, 0);
    let loadedBefore = 0;
    this.progressState.set(key, { pairKey: key, loadedBytes: 0, totalBytes });
    await assertRoomFor(records.reduce((sum, [, record]) => sum + (record.decompressedSize ?? record.attachment.size), 0));

    for (const [fileType, record] of records) {
      const cached = await cache.match(recordKey(record.id));
      if (cached) {
        const buffer = await cached.arrayBuffer();
        // A cached file that is not the size the catalog says was cut short somewhere: a damaged
        // disk, or a partial that outlived a crash. Handed to the engine it aborts the worker with
        // nothing to show for it, so it is dropped and fetched again like a missing one.
        // Files are keyed by record id, which a mirror's catalog may share with Mozilla's while
        // holding other bytes, so the hash recorded at download time has to match this catalog too.
        // Files cached before the hash was recorded are trusted as before.
        const storedHash = cached.headers.get("x-glossa-hash");
        const sameFile = !storedHash || !record.decompressedHash || storedHash === record.decompressedHash;
        if (sameFile && (record.decompressedSize === undefined || buffer.byteLength === record.decompressedSize)) {
          bytes[fileType] = buffer;
          loadedBefore += record.attachment.size;
          this.progressState.set(key, { pairKey: key, loadedBytes: loadedBefore, totalBytes });
          continue;
        }
        await cache.delete(recordKey(record.id));
      }
      this.askForPersistence();
      const data = await this.downloadRecord(pair, fileType, record, signal, mirror, (loaded) => {
        this.progressState.set(key, { pairKey: key, loadedBytes: loadedBefore + loaded, totalBytes });
        progress({ pairKey: key, phase: "download", file: record.name, loadedBytes: loadedBefore + loaded, totalBytes });
      });
      progress({ pairKey: key, phase: "store", file: record.name, loadedBytes: loadedBefore + record.attachment.size, totalBytes });
      await cache.put(
        recordKey(record.id),
        new Response(data as BodyInit, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(data.byteLength),
            "x-glossa-record": record.id,
            // What the catalog said these bytes are, so another catalog cannot mistake them for its own.
            "x-glossa-hash": record.decompressedHash ?? ""
          }
        })
      );
      bytes[fileType] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      loadedBefore += record.attachment.size;
    }

    const manifest = await this.readManifest();
    // Files the pair's previous entry used and this one does not (a newer model, or one installed
    // for another engine) would stay in the cache for good. Records are per direction in the
    // catalog, and in a mirror built from it, so no other pair shares them.
    const keep = new Set(records.map(([, record]) => record.id));
    for (const id of manifest[key]?.recordIds ?? []) {
      if (!keep.has(id)) await cache.delete(recordKey(id));
    }
    manifest[key] = {
      pairKey: key,
      sourceLanguage: pair.sourceLanguage,
      targetLanguage: pair.targetLanguage,
      version: pair.version,
      bytes: records.reduce((sum, [, record]) => sum + (record.decompressedSize ?? record.attachment.size), 0),
      installedAt: Date.now(),
      recordIds: records.map(([, record]) => record.id),
      modelMajor: MODEL_MAJOR_VERSION,
      engineMajor: ENGINE_MAJOR_VERSION
    };
    await writeMeta(INSTALLED_KEY, manifest);
    progress({ pairKey: key, phase: "done", file: null, loadedBytes: totalBytes, totalBytes });
    return bytes;
  }

  async deletePair(key: string): Promise<boolean> {
    const manifest = await this.readManifest();
    const entry = manifest[key];
    if (!entry) return false;
    const cache = await caches.open(CACHE_NAME);
    for (const id of entry.recordIds) {
      await cache.delete(recordKey(id));
      // A partial from an interrupted download of the same file has no owner once the pair is gone.
      await cache.delete(partialKey(id));
    }
    delete manifest[key];
    await writeMeta(INSTALLED_KEY, manifest);
    return true;
  }

  // Which byte source the next download will try first. Exposed for the options page.
  async activeSource(): Promise<"mozilla-cdn" | "mozilla-gcs" | "mirror"> {
    if (this.mirror) return "mirror";
    return (await this.cdnRefused()) ? "mozilla-gcs" : "mozilla-cdn";
  }

  private async downloadRecord(
    pair: PairFiles,
    fileType: ModelFileType,
    record: ModelRecord,
    signal: AbortSignal,
    mirror: string | null,
    onLoaded: (loaded: number) => void
  ): Promise<Uint8Array> {
    if (!record.decompressedHash || !record.decompressedSize) {
      throw new Error(`Catalog record ${record.name} carries no decompressed hash; refusing to download unverifiable data`);
    }
    let data: Uint8Array | null = null;
    if (mirror) {
      // The user's own mirror holds Mozilla's zstd files under their catalog locations, and it is
      // the only place asked: a file missing there is an error, never a quiet trip to Mozilla.
      const compressed = await this.fetchBytes(mirrorFileUrl(mirror, record), record.attachment.size, record.id, signal, onLoaded, mirror);
      if ((await sha256Hex(compressed)) !== record.attachment.hash) {
        throw new Error(`Download of ${record.name} from the mirror failed its hash check`);
      }
      data = await decompress(compressed, "zstd", record.decompressedSize);
    } else if (!(await this.cdnRefused())) {
      try {
        const compressed = await this.fetchBytes(attachmentUrl(record), record.attachment.size, record.id, signal, onLoaded, null);
        const compressedHash = await sha256Hex(compressed);
        if (compressedHash !== record.attachment.hash) {
          throw new Error(`Download of ${record.name} failed its hash check`);
        }
        data = await decompress(compressed, "zstd", record.decompressedSize);
      } catch (error) {
        // 406 is the CDN's answer to a Chrome user agent; a 403 would mean the same for us.
        if (error instanceof HttpError && (error.status === 406 || error.status === 403)) {
          await this.rememberCdnRefusal();
        } else {
          throw error;
        }
      }
    }
    if (!data) {
      const url = await this.gcsUrlFor(pair, fileType, record);
      const compressed = await this.fetchBytes(url, null, record.id, signal, onLoaded, null);
      data = await decompress(compressed, "gzip");
    }
    const hash = await sha256Hex(data);
    if (hash !== record.decompressedHash) {
      throw new Error(`${record.name} failed its hash check after download`);
    }
    if (data.byteLength !== record.decompressedSize) {
      throw new Error(`${record.name} was ${data.byteLength} bytes, expected ${record.decompressedSize}`);
    }
    return data;
  }

  // One file, with the network's ordinary failures handled: a dropped connection is retried with a
  // widening gap, and whatever arrived first is kept and asked for with a Range header so a 40 MB
  // download does not start again from zero. An abort is never retried.
  private async fetchBytes(
    url: string,
    expectedSize: number | null,
    recordId: string,
    signal: AbortSignal,
    onLoaded: (loaded: number) => void,
    mirror: string | null
  ): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new CancelledError(recordId);
      const partial = await readPartial(recordId);
      try {
        const bytes = await this.fetchOnce(url, partial, recordId, signal, onLoaded, mirror);
        if (expectedSize !== null && bytes.byteLength > expectedSize) {
          // More than the catalog says the file holds: this is not the file we asked for.
          await dropPartial(recordId);
          throw new Error(`Download was ${bytes.byteLength} bytes, expected ${expectedSize}`);
        }
        if (expectedSize !== null && bytes.byteLength < expectedSize) {
          // Short: the connection ended early. What arrived stays on disk for the next attempt.
          throw new HttpError(`Download stopped at ${bytes.byteLength} of ${expectedSize} bytes`, 500);
        }
        await dropPartial(recordId);
        return bytes;
      } catch (error) {
        lastError = error;
        if (isAbort(error) || signal.aborted) throw new CancelledError(recordId);
        // A refusal or a missing file will not get better by asking again.
        if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
          throw error;
        }
        if (attempt === MAX_ATTEMPTS - 1) break;
        await delay(RETRY_BASE_MS * 2 ** attempt, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchOnce(
    url: string,
    partial: Uint8Array | null,
    recordId: string,
    signal: AbortSignal,
    onLoaded: (loaded: number) => void,
    mirror: string | null
  ): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    if (partial && partial.byteLength > 0) headers["range"] = `bytes=${partial.byteLength}-`;
    let response: Response;
    try {
      response = await fetch(url, { cache: "no-store", signal, headers });
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw new CancelledError(recordId);
      throw await describeNetworkFailure(error, mirror);
    }
    if (!response.ok) {
      // The server ignored the range, or the partial is stale: start over rather than splice
      // mismatched bytes together.
      if (response.status === 416) {
        await dropPartial(recordId);
        throw new HttpError(`Download from ${new URL(url).host} could not resume`, 500);
      }
      throw new HttpError(`Download from ${new URL(url).host} failed: HTTP ${response.status}`, response.status);
    }
    const resuming = response.status === 206 && partial !== null;
    const already = resuming ? partial.byteLength : 0;
    let received: Uint8Array;
    try {
      received = await readWithProgress(response, (loaded) => onLoaded(already + loaded));
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw new CancelledError(recordId);
      // Keep what arrived: the next attempt asks for the rest.
      throw error;
    }
    const bytes = resuming ? concat(partial, received) : received;
    await writePartial(recordId, bytes);
    // The bucket path has no size from the catalog to check against (its files are gzip, the
    // catalog measures zstd), so the server's own content-length is the only way to notice a
    // connection that ended early. Without this a truncated file reaches the decompressor.
    const declared = Number(response.headers?.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > 0 && received.byteLength < declared) {
      throw new HttpError(`Download stopped at ${received.byteLength} of ${declared} bytes`, 500);
    }
    return bytes;
  }

  // Locate the same file in Mozilla's GCS registry. The registry only carries a hash for the
  // model file, so the model record's decompressed hash is the join key; vocab and shortlist
  // paths come from the matched entry and are verified against the catalog after download.
  private async gcsUrlFor(pair: PairFiles, fileType: ModelFileType, record: ModelRecord): Promise<string> {
    const registry = await this.getGcsRegistry();
    const modelRecord = pair.records.model;
    if (!modelRecord?.decompressedHash) {
      throw new Error("Pair has no model hash to match against the registry");
    }
    const candidates = registry.models[`${pair.sourceLanguage}-${pair.targetLanguage}`] ?? [];
    const entry = candidates.find((candidate) => candidate.files["model"]?.uncompressedHash === modelRecord.decompressedHash);
    if (!entry) {
      throw new Error(
        `${pair.sourceLanguage} to ${pair.targetLanguage} (${pair.version}) is not available from Mozilla's model registry in this browser`
      );
    }
    const file = entry.files[GCS_FILE_KEYS[fileType]];
    if (!file?.path) {
      throw new Error(`Registry entry for ${pair.sourceLanguage}-${pair.targetLanguage} has no ${fileType} file (${record.name})`);
    }
    return `${registry.baseUrl.replace(/\/$/, "")}/${file.path}`;
  }

  private async getGcsRegistry(): Promise<GcsRegistry> {
    const stored = await readMeta<GcsRegistry>(GCS_REGISTRY_KEY);
    if (stored && Date.now() - stored.fetchedAt < GCS_REGISTRY_TTL_MS) return stored;
    let response: Response;
    try {
      response = await fetch(MODEL_SOURCES.gcsRegistryUrl, { cache: "no-store" });
    } catch (error) {
      if (stored) return stored;
      throw error;
    }
    if (!response.ok) {
      if (stored) return stored;
      throw new HttpError(`Model registry request failed: HTTP ${response.status}`, response.status);
    }
    const body = (await response.json()) as { baseUrl?: unknown; models?: unknown };
    if (typeof body.baseUrl !== "string" || !body.models || typeof body.models !== "object") {
      throw new Error("Model registry response had an unexpected shape");
    }
    if (!body.baseUrl.startsWith(MODEL_SOURCES.gcsBaseUrl)) {
      throw new Error(`Model registry points at ${body.baseUrl}, which is not the expected bucket`);
    }
    const registry: GcsRegistry = {
      fetchedAt: Date.now(),
      baseUrl: body.baseUrl,
      models: body.models as Record<string, GcsRegistryModel[]>
    };
    await writeMeta(GCS_REGISTRY_KEY, registry);
    return registry;
  }

  private async cdnRefused(): Promise<boolean> {
    if (!this.sourceState) {
      this.sourceState = (await readMeta<SourceState>(SOURCE_KEY)) ?? { cdnRefusedAt: null };
    }
    const at = this.sourceState.cdnRefusedAt;
    return at !== null && Date.now() - at < CDN_REFUSAL_TTL_MS;
  }

  private async rememberCdnRefusal(): Promise<void> {
    this.sourceState = { cdnRefusedAt: Date.now() };
    await writeMeta(SOURCE_KEY, this.sourceState);
  }

  private async readManifest(): Promise<Record<string, InstalledManifestEntry>> {
    const value = await readMeta<Record<string, InstalledManifestEntry>>(INSTALLED_KEY);
    return value && typeof value === "object" ? value : {};
  }

  private async entryIsComplete(cache: Cache, entry: InstalledManifestEntry): Promise<boolean> {
    for (const id of entry.recordIds) {
      const hit = await cache.match(recordKey(id));
      if (!hit) return false;
    }
    return true;
  }
}

async function readPartial(recordId: string): Promise<Uint8Array | null> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(partialKey(recordId));
  if (!hit) return null;
  const buffer = await hit.arrayBuffer();
  return buffer.byteLength > 0 ? new Uint8Array(buffer) : null;
}

async function writePartial(recordId: string, bytes: Uint8Array): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await cache.put(partialKey(recordId), new Response(body as BodyInit));
}

async function dropPartial(recordId: string): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(partialKey(recordId));
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(tail, head.byteLength);
  return out;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// A download that cannot fit is better refused than started: the browser evicts the whole cache
// when it runs out, which would take every installed model with it.
async function assertRoomFor(bytes: number): Promise<void> {
  const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } })
    .navigator?.storage;
  if (!storage?.estimate) return;
  try {
    const { quota, usage } = await storage.estimate();
    if (typeof quota !== "number" || typeof usage !== "number") return;
    const free = quota - usage;
    if (free < bytes * STORAGE_HEADROOM) {
      throw new Error(
        `Not enough free storage for this language: it needs about ${Math.ceil((bytes * STORAGE_HEADROOM) / 1e6)} MB and the browser offers ${Math.floor(free / 1e6)} MB.`
      );
    }
  } catch (error) {
    // Only the refusal above is worth reporting; an estimate that throws is not a reason to stop.
    if (error instanceof Error && error.message.startsWith("Not enough free storage")) throw error;
  }
}

async function readWithProgress(response: Response, onLoaded: (loaded: number) => void): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onLoaded(buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (loaded - lastReport > 256 * 1024) {
      lastReport = loaded;
      onLoaded(loaded);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onLoaded(loaded);
  return out;
}

function isModelRecord(value: unknown): value is ModelRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ModelRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.version === "string" &&
    typeof record.fileType === "string" &&
    typeof record.sourceLanguage === "string" &&
    typeof record.targetLanguage === "string" &&
    Boolean(record.attachment) &&
    typeof record.attachment?.hash === "string" &&
    typeof record.attachment?.location === "string" &&
    typeof record.attachment?.size === "number"
  );
}

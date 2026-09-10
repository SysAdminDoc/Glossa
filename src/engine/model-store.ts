import {
  attachmentUrl,
  MODEL_SOURCES,
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

const CACHE_NAME = "glossa-models-v1";
const META_CACHE_NAME = "glossa-meta-v1";
const CATALOG_KEY = "catalog";
const INSTALLED_KEY = "installedPairs";
const SOURCE_KEY = "byteSource";
const GCS_REGISTRY_KEY = "gcsRegistry";
const CDN_REFUSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

interface StoredCatalog {
  fetchedAt: number;
  records: ModelRecord[];
}

interface InstalledManifestEntry extends InstalledPair {
  recordIds: string[];
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

export class ModelStore {
  private catalogPromise: Promise<StoredCatalog> | null = null;
  private lastCatalogError: string | null = null;
  private sourceState: SourceState | null = null;

  get catalogError(): string | null {
    return this.lastCatalogError;
  }

  // Serve the stored catalog when it is fresh enough; refresh it otherwise. A failed refresh
  // keeps the stale copy, so a machine that is offline still translates with what it has.
  async getCatalog(options: { maxAgeMs: number; force?: boolean }): Promise<StoredCatalog | null> {
    const stored = await this.readStoredCatalog();
    const age = stored ? Date.now() - stored.fetchedAt : Number.POSITIVE_INFINITY;
    if (stored && !options.force && age < options.maxAgeMs) {
      return stored;
    }
    if (!this.catalogPromise) {
      this.catalogPromise = this.fetchCatalog().finally(() => {
        this.catalogPromise = null;
      });
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
    return value;
  }

  private async fetchCatalog(): Promise<StoredCatalog> {
    const response = await fetch(REMOTE_SETTINGS.recordsUrl, { cache: "no-store" });
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
    const catalog: StoredCatalog = { fetchedAt: Date.now(), records };
    await writeMeta(CATALOG_KEY, catalog);
    return catalog;
  }

  async listInstalled(): Promise<InstalledPair[]> {
    const manifest = await this.readManifest();
    const cache = await caches.open(CACHE_NAME);
    const result: InstalledPair[] = [];
    for (const entry of Object.values(manifest)) {
      if (await this.entryIsComplete(cache, entry)) {
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
    if (!entry) return false;
    const wanted = Object.values(pair.records).map((record) => record.id).sort();
    const have = [...entry.recordIds].sort();
    if (wanted.length !== have.length || wanted.some((id, index) => id !== have[index])) return false;
    const cache = await caches.open(CACHE_NAME);
    return this.entryIsComplete(cache, entry);
  }

  // Download whatever is missing for a pair, verify it, and return every file's bytes.
  async ensurePair(pair: PairFiles, progress: ProgressSink): Promise<PairBytes> {
    const key = pairKey(pair.sourceLanguage, pair.targetLanguage);
    const cache = await caches.open(CACHE_NAME);
    const bytes: PairBytes = {};
    const records = Object.entries(pair.records) as Array<[ModelFileType, ModelRecord]>;
    const totalBytes = records.reduce((sum, [, record]) => sum + record.attachment.size, 0);
    let loadedBefore = 0;

    for (const [fileType, record] of records) {
      const cached = await cache.match(recordKey(record.id));
      if (cached) {
        bytes[fileType] = await cached.arrayBuffer();
        loadedBefore += record.attachment.size;
        continue;
      }
      const data = await this.downloadRecord(pair, fileType, record, (loaded) => {
        progress({ pairKey: key, phase: "download", file: record.name, loadedBytes: loadedBefore + loaded, totalBytes });
      });
      progress({ pairKey: key, phase: "store", file: record.name, loadedBytes: loadedBefore + record.attachment.size, totalBytes });
      await cache.put(
        recordKey(record.id),
        new Response(data as BodyInit, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(data.byteLength),
            "x-glossa-record": record.id
          }
        })
      );
      bytes[fileType] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      loadedBefore += record.attachment.size;
    }

    const manifest = await this.readManifest();
    manifest[key] = {
      pairKey: key,
      sourceLanguage: pair.sourceLanguage,
      targetLanguage: pair.targetLanguage,
      version: pair.version,
      bytes: records.reduce((sum, [, record]) => sum + (record.decompressedSize ?? record.attachment.size), 0),
      installedAt: Date.now(),
      recordIds: records.map(([, record]) => record.id)
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
    }
    delete manifest[key];
    await writeMeta(INSTALLED_KEY, manifest);
    return true;
  }

  // Which byte source the next download will try first. Exposed for the options page.
  async activeSource(): Promise<"mozilla-cdn" | "mozilla-gcs"> {
    return (await this.cdnRefused()) ? "mozilla-gcs" : "mozilla-cdn";
  }

  private async downloadRecord(
    pair: PairFiles,
    fileType: ModelFileType,
    record: ModelRecord,
    onLoaded: (loaded: number) => void
  ): Promise<Uint8Array> {
    if (!record.decompressedHash || !record.decompressedSize) {
      throw new Error(`Catalog record ${record.name} carries no decompressed hash; refusing to download unverifiable data`);
    }
    let data: Uint8Array | null = null;
    if (!(await this.cdnRefused())) {
      try {
        const compressed = await this.fetchBytes(attachmentUrl(record), record.attachment.size, onLoaded);
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
      const compressed = await this.fetchBytes(url, null, onLoaded);
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

  private async fetchBytes(url: string, expectedSize: number | null, onLoaded: (loaded: number) => void): Promise<Uint8Array> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new HttpError(`Download from ${new URL(url).host} failed: HTTP ${response.status}`, response.status);
    }
    const bytes = await readWithProgress(response, onLoaded);
    if (expectedSize !== null && bytes.byteLength !== expectedSize) {
      throw new Error(`Download was ${bytes.byteLength} bytes, expected ${expectedSize}`);
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

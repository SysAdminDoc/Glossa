import { api } from "../shared/api.ts";
import {
  catalogEnvironment,
  languageCoverage,
  pairKey,
  planRoute,
  routeBytes,
  routeDownloadBytes,
  type CatalogEnvironment,
  type ModelFileType,
  type ModelRecord,
  type PairFiles
} from "../shared/catalog.ts";
import {
  UI_TARGET,
  type EngineRequest,
  type ModelsListResponse,
  type ProgressEvent,
  type RouteStatus
} from "../shared/messages.ts";
import { ModelStore, type PairBytes } from "./model-store.ts";
import { ChromeEngine } from "./chrome-translator.ts";
import type { WorkerModelInput, WorkerRequest, WorkerResponse } from "./bergamot.worker.ts";

// The engine host runs wherever a Worker can live long enough to keep a 40 MB model warm:
// Chrome's offscreen document, or Firefox's background page. It serialises translation requests
// into the worker, fetches models through the store, and publishes download progress to any open
// popup or options page.

const DEFAULT_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The engine idles out. Firefox uses 15 seconds per engine and discards it when a tab goes away;
// this releases the worker, its models, and on Chrome the whole document hosting them.
const ENGINE_IDLE_MS = 15_000;

// A WebAssembly module whose body is `(module (func (result v128) (v128.const i32x4 0 0 0 0)))`.
// It compiles only where SIMD is available, which is what the engine needs and what a pre-SSE4.1
// desktop CPU, a 32-bit ARM phone, or a browser with its WASM optimiser switched off does not have.
export const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b
]);

export const NO_SIMD_MESSAGE =
  "This computer's processor lacks the SIMD instructions the engine needs. On a desktop that means " +
  "a CPU older than SSE4.1; in Brave or Chrome it can also mean the WebAssembly optimiser is " +
  "switched off for this site.";

// Never cached across sessions: Firefox 149 shipped a bug where a stale unsupported verdict stuck
// (Bugzilla 2019140). One check per engine host is cheap.
export function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

// One retry per host. A second crash on the same batch is a real failure, not a hiccup.
const MAX_RESTARTS = 1;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class EngineHost {
  readonly store = new ModelStore();
  // Chrome's built-in Translator, used instead of Bergamot when the user picked it.
  readonly chrome = new ChromeEngine();
  // Called when the engine has been idle long enough to release everything it holds.
  onIdle: (() => void) | null = null;
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly loadedRoutes = new Set<string>();
  private readonly routeLoads = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  // The refresh interval is a setting, and the host cannot read settings on Chrome, so each request
  // brings the current value with it.
  private catalogMaxAgeMs = DEFAULT_CATALOG_MAX_AGE_MS;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // How many requests are being served right now. The engine is never taken down while this is
  // above zero: the first translation of a session downloads, verifies, decompresses and loads tens
  // of megabytes, which takes far longer than the idle timeout, and tearing that down mid-flight
  // used to leave the host permanently stuck.
  private busy = 0;

  async handle(request: EngineRequest): Promise<unknown> {
    // Which catalog records count depends on the platform and on whether the user asked for the
    // prerelease models, and the request is the only place that answer can come from here.
    const environment = catalogEnvironment(
      typeof navigator === "undefined" ? "" : navigator.userAgent,
      request.experimental === true
    );
    if (typeof request.catalogMaxAgeMs === "number" && request.catalogMaxAgeMs > 0) {
      this.catalogMaxAgeMs = request.catalogMaxAgeMs;
    }
    this.busy++;
    try {
      return await this.dispatch(request, environment);
    } finally {
      this.busy--;
      this.keepAlive();
    }
  }

  private async dispatch(request: EngineRequest, environment: CatalogEnvironment): Promise<unknown> {
    // Everything a page translation asks for goes to Chrome's engine when it is selected, and none
    // of it may touch the catalog or the model hosts. Managing Bergamot's own models from the
    // options page still works as before: that is the user asking for Mozilla's files by name.
    if (request.engine === "chrome") {
      switch (request.type) {
        case "translate":
          return this.chrome.translate(request.sourceLanguage, request.targetLanguage, request.fragments);
        case "route-status":
          return this.chrome.routeStatus(request.sourceLanguage, request.targetLanguage);
        case "ensure-route":
          return { routeKey: await this.chrome.ensure(request.sourceLanguage, request.targetLanguage) };
        case "models-list":
          return this.modelsList(environment, true);
        default:
          break;
      }
    }
    switch (request.type) {
      case "ping":
        return { alive: true, engineLoaded: this.worker !== null };
      case "translate":
        return this.translate(request.sourceLanguage, request.targetLanguage, request.fragments, environment);
      case "ensure-route":
        return { routeKey: await this.ensureRoute(request.sourceLanguage, request.targetLanguage, environment) };
      case "route-status":
        return this.routeStatus(request.sourceLanguage, request.targetLanguage, environment);
      case "models-list":
        return this.modelsList(environment);
      case "models-downloads":
        return { downloads: this.store.activeDownloads() };
      case "models-cancel":
        return { cancelled: await this.store.cancel(request.pairKey) };
      case "models-reset-source": {
        await this.store.resetSource();
        return { byteSource: await this.store.activeSource() };
      }
      case "models-delete":
        return { deleted: await this.deletePair(request.pairKey) };
      case "catalog-refresh": {
        const catalog = await this.store.getCatalog({ maxAgeMs: 0, force: true });
        return { fetchedAt: catalog?.fetchedAt ?? null, error: this.store.catalogError };
      }
    }
  }

  async translate(
    sourceLanguage: string,
    targetLanguage: string,
    fragments: string[],
    environment?: CatalogEnvironment
  ) {
    // One request at a time: Bergamot blocks the worker thread for the whole batch. A batch that
    // dies with the worker is tried once more on the restarted one; Bergamot aborts the whole
    // service on a parse error it cannot recover from, and one bad block should not end the page.
    // The budget is per batch, not per host: the third block on a page deserves the same chance to
    // recover as the first.
    const run = this.queue.then(async () => {
      let restarts = 0;
      for (;;) {
        const workerBefore = this.worker;
        try {
          const routeKey = await this.ensureRoute(sourceLanguage, targetLanguage, environment);
          return await this.call({ type: "translate", id: 0, routeKey, fragments, html: true });
        } catch (error) {
          // Only a worker that actually died is worth restarting for. A missing model or an
          // unsupported processor fails the same way however many times it is asked.
          const workerDied = workerBefore !== null && this.worker === null;
          if (!workerDied || restarts >= MAX_RESTARTS) throw error;
          restarts++;
        }
      }
    });
    this.queue = run.catch(() => undefined);
    return run as Promise<{ fragments: string[]; inferenceMs: number }>;
  }

  // Hold the engine open while work is arriving, and let it go when it stops. A timer that fires
  // while something is still in flight arms itself again rather than pulling the floor out.
  private keepAlive(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy > 0) {
        this.keepAlive();
        return;
      }
      void this.shutdown();
    }, ENGINE_IDLE_MS);
  }

  // Drop the worker, its models, and on Chrome the offscreen document that exists only to host it.
  // Nothing is cached in memory that a later request cannot rebuild from the model store.
  async shutdown(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = null;
    this.loadedRoutes.clear();
    this.chrome.release();
    // Anything still waiting on the worker has to be told, or its caller waits for an answer that
    // can never come and the queue behind it never moves again.
    const stopped = new Error("The translation engine was shut down");
    for (const pending of this.pending.values()) pending.reject(stopped);
    this.pending.clear();
    this.routeLoads.clear();
    this.queue = Promise.resolve();
    // On Chrome the host runs inside an offscreen document that would otherwise live until the
    // browser exits. That document has no access to chrome.offscreen (only chrome.runtime), so it
    // closes itself: offscreen.ts passes window.close as this hook. Firefox needs none of it.
    this.onIdle?.();
  }

  async routeStatus(
    sourceLanguage: string,
    targetLanguage: string,
    environment?: CatalogEnvironment
  ): Promise<RouteStatus> {
    const catalog = await this.store.getCatalog({ maxAgeMs: this.catalogMaxAgeMs });
    const base: RouteStatus = {
      sourceLanguage,
      targetLanguage,
      hops: null,
      installed: false,
      downloadBytes: 0,
      catalogAgeMs: catalog ? Date.now() - catalog.fetchedAt : null,
      catalogError: this.store.catalogError
    };
    if (!catalog) return base;
    const route = planRoute(catalog.records, sourceLanguage, targetLanguage, environment);
    if (!route) return base;
    const hops: NonNullable<RouteStatus["hops"]> = [];
    let downloadBytes = 0;
    for (const pair of route) {
      const installed = await this.store.isPairInstalled(pair);
      const pairDownload = routeDownloadBytes([pair]);
      if (!installed) downloadBytes += pairDownload;
      hops.push({
        pairKey: pairKey(pair.sourceLanguage, pair.targetLanguage),
        installed,
        downloadBytes: pairDownload,
        bytes: routeBytes([pair])
      });
    }
    return { ...base, hops, installed: hops.every((hop) => hop.installed), downloadBytes };
  }

  // With Chrome's engine selected the catalog is read from disk only, and the processor check does
  // not apply: Bergamot is not what will run.
  async modelsList(environment?: CatalogEnvironment, chrome = false): Promise<ModelsListResponse> {
    const catalog = await this.store.getCatalog({ maxAgeMs: this.catalogMaxAgeMs, offline: chrome });
    const coverage = catalog ? languageCoverage(catalog.records, environment) : { sources: [], targets: [] };
    return {
      installed: await this.store.listInstalled(),
      sources: coverage.sources,
      targets: coverage.targets,
      catalogFetchedAt: catalog?.fetchedAt ?? null,
      catalogError: this.store.catalogError,
      engineLoaded: this.worker !== null,
      engineSupported: chrome || supportsSimd(),
      byteSource: await this.store.activeSource()
    };
  }

  private async deletePair(key: string): Promise<boolean> {
    // Drop any loaded route that used this pair before the bytes disappear underneath it.
    for (const routeKey of [...this.loadedRoutes]) {
      if (routeKey.split("|").includes(key)) {
        await this.call({ type: "unload-route", id: 0, routeKey });
        this.loadedRoutes.delete(routeKey);
      }
    }
    return this.store.deletePair(key);
  }

  // Resolve a language pair to a loaded worker route, downloading and loading on demand.
  async ensureRoute(
    sourceLanguage: string,
    targetLanguage: string,
    environment?: CatalogEnvironment
  ): Promise<string> {
    if (sourceLanguage === targetLanguage) {
      throw new Error("Source and target language are the same");
    }
    const catalog = await this.store.getCatalog({ maxAgeMs: this.catalogMaxAgeMs });
    if (!catalog) {
      throw new Error(this.store.catalogError ?? "The model catalog could not be loaded");
    }
    const route = planRoute(catalog.records, sourceLanguage, targetLanguage, environment);
    if (!route) {
      throw new Error(`No model is available for ${sourceLanguage} to ${targetLanguage}`);
    }
    const routeKey = route.map((pair) => pairKey(pair.sourceLanguage, pair.targetLanguage)).join("|");
    if (this.loadedRoutes.has(routeKey)) return routeKey;

    const inFlight = this.routeLoads.get(routeKey);
    if (inFlight) return inFlight;
    const load = this.loadRoute(routeKey, route).finally(() => this.routeLoads.delete(routeKey));
    this.routeLoads.set(routeKey, load);
    return load;
  }

  private async loadRoute(routeKey: string, route: PairFiles[]): Promise<string> {
    await this.ensureWorker();
    const models: WorkerModelInput[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const pair of route) {
      const key = pairKey(pair.sourceLanguage, pair.targetLanguage);
      const bytes = await this.store.ensurePair(pair, (event) => this.broadcast(event));
      this.broadcast({ pairKey: key, phase: "load", file: null, loadedBytes: 0, totalBytes: 0 });
      const files = copyForTransfer(bytes, transfer);
      models.push({
        sourceLanguage: pair.sourceLanguage,
        targetLanguage: pair.targetLanguage,
        modelName: (pair.records.model as ModelRecord).name,
        files
      });
    }
    await this.call({ type: "load-route", id: 0, routeKey, models }, transfer);
    // The worker evicts the least recently used route when it is full; mirror that bookkeeping
    // loosely by trusting its reported list.
    const status = (await this.call({ type: "status", id: 0 })) as { loaded: string[] };
    this.loadedRoutes.clear();
    for (const key of status.loaded) this.loadedRoutes.add(key);
    for (const pair of route) {
      this.broadcast({
        pairKey: pairKey(pair.sourceLanguage, pair.targetLanguage),
        phase: "done",
        file: null,
        loadedBytes: 0,
        totalBytes: 0
      });
    }
    return routeKey;
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady;
    if (!supportsSimd()) return Promise.reject(new Error(NO_SIMD_MESSAGE));
    this.workerReady = (async () => {
      const worker = new Worker(api.runtime.getURL("bergamot-worker.js"));
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onWorkerMessage(event.data);
      worker.onerror = (event) => {
        const error = new Error(`Engine worker failed: ${event.message}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.worker = null;
        this.workerReady = null;
        this.loadedRoutes.clear();
      };
      this.worker = worker;
      const response = await fetch(api.runtime.getURL("bergamot-translator.wasm"));
      if (!response.ok) {
        throw new Error("The bundled engine binary is missing from the package");
      }
      const wasm = await response.arrayBuffer();
      await this.call({ type: "init", id: 0, wasm }, [wasm]);
    })().catch((error) => {
      this.worker?.terminate();
      this.worker = null;
      this.workerReady = null;
      throw error;
    });
    return this.workerReady;
  }

  private call(request: WorkerRequest, transfer: ArrayBuffer[] = []): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Engine worker is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  private onWorkerMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error));
    }
  }

  private broadcast(event: Omit<ProgressEvent, "target" | "type">): void {
    const message: ProgressEvent = { target: UI_TARGET, type: "glossa:progress", ...event };
    // No popup open is the normal case; the rejection is noise.
    api.runtime.sendMessage(message).catch(() => undefined);
  }
}

// Model buffers are handed to the worker by transfer so the host does not hold a second copy.
// The store already returned fresh ArrayBuffers, so they can be moved rather than cloned.
function copyForTransfer(bytes: PairBytes, transfer: ArrayBuffer[]): Partial<Record<ModelFileType, ArrayBuffer>> {
  const out: Partial<Record<ModelFileType, ArrayBuffer>> = {};
  for (const [fileType, buffer] of Object.entries(bytes) as Array<[ModelFileType, ArrayBuffer]>) {
    out[fileType] = buffer;
    transfer.push(buffer);
  }
  return out;
}

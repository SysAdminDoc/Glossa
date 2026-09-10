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
import type { WorkerModelInput, WorkerRequest, WorkerResponse } from "./bergamot.worker.ts";

// The engine host runs wherever a Worker can live long enough to keep a 40 MB model warm:
// Chrome's offscreen document, or Firefox's background page. It serialises translation requests
// into the worker, fetches models through the store, and publishes download progress to any open
// popup or options page.

const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class EngineHost {
  readonly store = new ModelStore();
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly loadedRoutes = new Set<string>();
  private readonly routeLoads = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();

  async handle(request: EngineRequest): Promise<unknown> {
    // Which catalog records count depends on the platform and on whether the user asked for the
    // prerelease models, and the request is the only place that answer can come from here.
    const environment = catalogEnvironment(
      typeof navigator === "undefined" ? "" : navigator.userAgent,
      request.experimental === true
    );
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
    const routeKey = await this.ensureRoute(sourceLanguage, targetLanguage, environment);
    // One request at a time: Bergamot blocks the worker thread for the whole batch.
    const run = this.queue.then(() =>
      this.call({ type: "translate", id: 0, routeKey, fragments, html: true })
    );
    this.queue = run.catch(() => undefined);
    return run as Promise<{ fragments: string[]; inferenceMs: number }>;
  }

  async routeStatus(
    sourceLanguage: string,
    targetLanguage: string,
    environment?: CatalogEnvironment
  ): Promise<RouteStatus> {
    const catalog = await this.store.getCatalog({ maxAgeMs: CATALOG_MAX_AGE_MS });
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

  async modelsList(environment?: CatalogEnvironment): Promise<ModelsListResponse> {
    const catalog = await this.store.getCatalog({ maxAgeMs: CATALOG_MAX_AGE_MS });
    const coverage = catalog ? languageCoverage(catalog.records, environment) : { sources: [], targets: [] };
    return {
      installed: await this.store.listInstalled(),
      sources: coverage.sources,
      targets: coverage.targets,
      catalogFetchedAt: catalog?.fetchedAt ?? null,
      catalogError: this.store.catalogError,
      engineLoaded: this.worker !== null,
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
    const catalog = await this.store.getCatalog({ maxAgeMs: CATALOG_MAX_AGE_MS });
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

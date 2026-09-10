import type {
  BergamotAlignedMemory,
  BergamotModule,
  BergamotTranslationModel
} from "./bergamot.d.ts";
import type { ModelFileType } from "../shared/catalog.ts";

// The translation worker. It owns the WASM instance and every loaded model, and it is the only
// place page text is ever processed. Translation is synchronous inside Bergamot, so requests are
// handled one at a time; the host serialises them.

// The project compiles against the DOM lib (the content script and pages need it), and TypeScript
// cannot load the DOM and WebWorker libs together. The worker global is typed locally instead.
interface WorkerScope {
  importScripts(...urls: string[]): void;
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}
const workerSelf = self as unknown as WorkerScope;

// Bergamot requires model blobs at these alignments inside the WASM heap.
const FILE_ALIGNMENTS: Record<ModelFileType, number> = {
  model: 256,
  lex: 64,
  vocab: 64,
  srcvocab: 64,
  trgvocab: 64
};

// How many translation routes stay resident. A route is one or two models (pivoting). Each base
// model is roughly 20 to 45 MB of heap, so two routes keeps a page pair plus one more warm.
const MAX_LOADED_ROUTES = 2;

export interface WorkerModelInput {
  sourceLanguage: string;
  targetLanguage: string;
  modelName: string;
  files: Partial<Record<ModelFileType, ArrayBuffer>>;
}

export type WorkerRequest =
  | { type: "init"; id: number; wasm: ArrayBuffer }
  | { type: "load-route"; id: number; routeKey: string; models: WorkerModelInput[] }
  | { type: "translate"; id: number; routeKey: string; fragments: string[]; html: boolean }
  | { type: "unload-route"; id: number; routeKey: string }
  | { type: "status"; id: number };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

interface LoadedRoute {
  models: BergamotTranslationModel[];
  memory: BergamotAlignedMemory[];
  lastUsed: number;
}

let bergamot: BergamotModule | null = null;
let service: InstanceType<BergamotModule["BlockingService"]> | null = null;
const routes = new Map<string, LoadedRoute>();

workerSelf.importScripts("bergamot-translator.js");

workerSelf.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    const result = await handle(message);
    const response: WorkerResponse = { id: message.id, ok: true, result };
    workerSelf.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    };
    workerSelf.postMessage(response);
  }
};

async function handle(message: WorkerRequest): Promise<unknown> {
  switch (message.type) {
    case "init":
      await initialize(message.wasm);
      return { loaded: true };
    case "load-route":
      loadRoute(message.routeKey, message.models);
      return { routeKey: message.routeKey, loaded: [...routes.keys()] };
    case "translate":
      return translate(message.routeKey, message.fragments, message.html);
    case "unload-route":
      unloadRoute(message.routeKey);
      return { loaded: [...routes.keys()] };
    case "status":
      return { engine: Boolean(bergamot), loaded: [...routes.keys()] };
  }
}

function initialize(wasm: ArrayBuffer): Promise<void> {
  if (bergamot) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const module = loadBergamot({
      // Start small and let the heap grow; Mozilla measured lower peak memory this way.
      INITIAL_MEMORY: 40 * 1024 * 1024,
      wasmBinary: wasm,
      print: () => {},
      printErr: (line: string) => console.warn("[glossa engine]", line),
      onAbort(reason: unknown) {
        if (settled) return;
        settled = true;
        reject(new Error(`Bergamot aborted: ${String(reason)}`));
      },
      onRuntimeInitialized() {
        // Let the glue finish assigning exports before we touch them.
        queueMicrotask(() => {
          if (settled) return;
          settled = true;
          bergamot = module;
          service = new module.BlockingService({ cacheSize: 0 });
          resolve();
        });
      }
    });
  });
}

function requireEngine(): BergamotModule {
  if (!bergamot || !service) {
    throw new Error("Engine is not initialised");
  }
  return bergamot;
}

function loadRoute(routeKey: string, models: WorkerModelInput[]): void {
  const engine = requireEngine();
  if (routes.has(routeKey)) {
    routes.get(routeKey)!.lastUsed = Date.now();
    return;
  }
  if (models.length === 0 || models.length > 2) {
    throw new Error(`A route needs one or two models, got ${models.length}`);
  }
  evictIfNeeded();

  const memory: BergamotAlignedMemory[] = [];
  const built: BergamotTranslationModel[] = [];
  try {
    for (const input of models) {
      built.push(constructModel(engine, input, memory));
    }
  } catch (error) {
    for (const model of built) model.delete();
    for (const block of memory) block.delete();
    throw error;
  }
  routes.set(routeKey, { models: built, memory, lastUsed: Date.now() });
}

function constructModel(
  engine: BergamotModule,
  input: WorkerModelInput,
  memoryOut: BergamotAlignedMemory[]
): BergamotTranslationModel {
  const aligned: Partial<Record<ModelFileType, BergamotAlignedMemory>> = {};
  for (const [fileType, buffer] of Object.entries(input.files) as Array<[ModelFileType, ArrayBuffer]>) {
    const block = new engine.AlignedMemory(buffer.byteLength, FILE_ALIGNMENTS[fileType]);
    block.getByteArrayView().set(new Uint8Array(buffer));
    aligned[fileType] = block;
    memoryOut.push(block);
  }
  if (!aligned.model) {
    throw new Error(`Model ${input.modelName} has no model file`);
  }
  const vocabs = new engine.AlignedMemoryList();
  if (aligned.vocab) {
    vocabs.push_back(aligned.vocab);
  } else if (aligned.srcvocab && aligned.trgvocab) {
    vocabs.push_back(aligned.srcvocab);
    vocabs.push_back(aligned.trgvocab);
  } else {
    throw new Error(`Model ${input.modelName} has no vocabulary`);
  }

  const config = marianConfig({
    "beam-size": "1",
    normalize: "1.0",
    "word-penalty": "0",
    "max-length-break": "128",
    "mini-batch-words": "1024",
    workspace: "128",
    "max-length-factor": "2.0",
    "skip-cost": "true",
    "cpu-threads": "0",
    quiet: "true",
    "quiet-translation": "true",
    "gemm-precision": input.modelName.endsWith("intgemm8.bin") ? "int8shiftAll" : "int8shiftAlphaAll",
    alignment: "soft"
  });

  return new engine.TranslationModel(
    input.sourceLanguage,
    input.targetLanguage,
    config,
    aligned.model,
    aligned.lex ?? null,
    vocabs,
    null
  );
}

// Marian reads a YAML document; the indentation is part of the contract.
function marianConfig(values: Record<string, string>): string {
  const indent = "            ";
  let out = "\n";
  for (const [key, value] of Object.entries(values)) {
    out += `${indent}${key}: ${value}\n`;
  }
  return out + indent;
}

function evictIfNeeded(): void {
  while (routes.size >= MAX_LOADED_ROUTES) {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, route] of routes) {
      if (route.lastUsed < oldest) {
        oldest = route.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    unloadRoute(oldestKey);
  }
}

function unloadRoute(routeKey: string): void {
  const route = routes.get(routeKey);
  if (!route) return;
  for (const model of route.models) model.delete();
  for (const block of route.memory) block.delete();
  routes.delete(routeKey);
}

function translate(routeKey: string, fragments: string[], html: boolean): { fragments: string[]; inferenceMs: number } {
  const engine = requireEngine();
  const route = routes.get(routeKey);
  if (!route) {
    throw new Error(`Route ${routeKey} is not loaded`);
  }
  route.lastUsed = Date.now();

  // Empty inputs crash the decoder; keep their slots and skip them.
  const indices: number[] = [];
  const messages = new engine.VectorString();
  const options = new engine.VectorResponseOptions();
  const output = new Array<string>(fragments.length).fill("");
  let responses: ReturnType<NonNullable<typeof service>["translate"]> | null = null;
  const started = performance.now();
  try {
    fragments.forEach((fragment, index) => {
      if (fragment.trim().length === 0) return;
      indices.push(index);
      messages.push_back(fragment);
      options.push_back({ qualityScores: false, alignment: html, html });
    });
    if (messages.size() > 0) {
      responses =
        route.models.length === 1
          ? service!.translate(route.models[0]!, messages, options)
          : service!.translateViaPivoting(route.models[0]!, route.models[1]!, messages, options);
      for (let i = 0; i < responses.size(); i++) {
        const target = indices[i];
        if (target !== undefined) {
          output[target] = responses.get(i).getTranslatedText();
        }
      }
    }
  } finally {
    messages.delete();
    options.delete();
    responses?.delete();
  }
  return { fragments: output, inferenceMs: performance.now() - started };
}

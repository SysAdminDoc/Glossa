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

// How many models stay resident. A route is one model, or two when it pivots through English, and
// routes share models: es->en and es->en->fr hold two between them, not three. A model costs about
// 140 MB of heap once loaded, most of it Marian's 128 MB workspace (the figure Firefox uses too),
// and the heap never shrinks. Two was tried and thrashed: a Spanish page with a German quote,
// translated into French, needs es->en, de->en and en->fr, and swapped a model on every change of
// language (review 2026-09-23), as do two tabs on different pairs. Three holds a pivot route and
// one more language beside it. Measured with `npm run smoke:memory` (README, Memory).
const MAX_LOADED_MODELS = 3;

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

interface LoadedModel {
  model: BergamotTranslationModel;
  memory: BergamotAlignedMemory[];
  lastUsed: number;
}

let bergamot: BergamotModule | null = null;
let service: InstanceType<BergamotModule["BlockingService"]> | null = null;
// Models by language pair ("es->en"), and each loaded route as the pairs it runs through, in order.
const models = new Map<string, LoadedModel>();
const routes = new Map<string, string[]>();
// Orders uses for eviction. A count, not the time: two uses in the same millisecond still have an
// order, and the one used first is the one that goes.
let clock = 0;

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
      // A WebAssembly heap grows and never shrinks, so its size is the most this worker has held.
      return {
        engine: Boolean(bergamot),
        loaded: [...routes.keys()],
        models: [...models.keys()],
        heapBytes: bergamot?.HEAP8?.buffer.byteLength ?? 0
      };
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

const modelKey = (input: WorkerModelInput): string => `${input.sourceLanguage}->${input.targetLanguage}`;

// The host sends every file of the route, and a model already loaded for another route is used as
// it is: its bytes here are dropped unread.
function loadRoute(routeKey: string, inputs: WorkerModelInput[]): void {
  const engine = requireEngine();
  if (inputs.length === 0 || inputs.length > 2) {
    throw new Error(`A route needs one or two models, got ${inputs.length}`);
  }
  const keys = inputs.map(modelKey);
  const missing = inputs.filter((input) => !models.has(modelKey(input)));
  // Room first, keeping whatever this route shares with what is loaded.
  evictFor(missing.length, new Set(keys));
  const built: string[] = [];
  try {
    for (const input of missing) {
      const memory: BergamotAlignedMemory[] = [];
      let model: BergamotTranslationModel;
      try {
        model = constructModel(engine, input, memory);
      } catch (error) {
        for (const block of memory) block.delete();
        throw error;
      }
      models.set(modelKey(input), { model, memory, lastUsed: ++clock });
      built.push(modelKey(input));
    }
  } catch (error) {
    // A route that could not be finished leaves behind nothing that no route uses.
    const inUse = new Set([...routes.values()].flat());
    for (const key of built) if (!inUse.has(key)) dropModel(key);
    throw error;
  }
  const now = ++clock;
  for (const key of keys) models.get(key)!.lastUsed = now;
  routes.set(routeKey, keys);
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

// Drop the least recently used models, never one in `keep`, until `incoming` more fit. A route that
// ran through a dropped model goes with it.
function evictFor(incoming: number, keep: Set<string>): void {
  while (models.size + incoming > MAX_LOADED_MODELS) {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of models) {
      if (!keep.has(key) && entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    dropModel(oldestKey);
  }
}

function dropModel(key: string): void {
  const entry = models.get(key);
  if (!entry) return;
  entry.model.delete();
  for (const block of entry.memory) block.delete();
  models.delete(key);
  for (const [routeKey, keys] of routes) {
    if (keys.includes(key)) routes.delete(routeKey);
  }
}

// A route asked to go (its model is being deleted from disk) takes every model no other route uses.
function unloadRoute(routeKey: string): void {
  const keys = routes.get(routeKey);
  if (!keys) return;
  routes.delete(routeKey);
  const inUse = new Set([...routes.values()].flat());
  for (const key of keys) {
    if (!inUse.has(key)) dropModel(key);
  }
}

function translate(routeKey: string, fragments: string[], html: boolean): { fragments: string[]; inferenceMs: number } {
  const engine = requireEngine();
  const route = routes.get(routeKey)?.map((key) => models.get(key));
  if (!route || route.some((entry) => !entry)) {
    throw new Error(`Route ${routeKey} is not loaded`);
  }
  const loaded = route as LoadedModel[];
  const now = ++clock;
  for (const entry of loaded) entry.lastUsed = now;

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
        loaded.length === 1
          ? service!.translate(loaded[0]!.model, messages, options)
          : service!.translateViaPivoting(loaded[0]!.model, loaded[1]!.model, messages, options);
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

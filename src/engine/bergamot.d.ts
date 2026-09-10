// Minimal typings for the Emscripten glue in vendor/bergamot/bergamot-translator.js. Only the
// surface the worker touches is declared.

export interface BergamotAlignedMemory {
  size(): number;
  getByteArrayView(): Uint8Array;
  delete(): void;
}

export interface BergamotAlignedMemoryList {
  push_back(memory: BergamotAlignedMemory): void;
  delete(): void;
}

export interface BergamotTranslationModel {
  delete(): void;
}

export interface BergamotVectorString {
  push_back(value: string): void;
  size(): number;
  get(index: number): string;
  delete(): void;
}

export interface BergamotResponseOptions {
  qualityScores: boolean;
  alignment: boolean;
  html: boolean;
}

export interface BergamotVectorResponseOptions {
  push_back(value: BergamotResponseOptions): void;
  delete(): void;
}

export interface BergamotResponse {
  getTranslatedText(): string;
  getOriginalText(): string;
}

export interface BergamotVectorResponse {
  size(): number;
  get(index: number): BergamotResponse;
  delete(): void;
}

export interface BergamotBlockingService {
  translate(
    model: BergamotTranslationModel,
    messages: BergamotVectorString,
    options: BergamotVectorResponseOptions
  ): BergamotVectorResponse;
  translateViaPivoting(
    first: BergamotTranslationModel,
    second: BergamotTranslationModel,
    messages: BergamotVectorString,
    options: BergamotVectorResponseOptions
  ): BergamotVectorResponse;
  delete(): void;
}

export interface BergamotModule {
  AlignedMemory: new (size: number, alignment: number) => BergamotAlignedMemory;
  AlignedMemoryList: new () => BergamotAlignedMemoryList;
  TranslationModel: new (
    sourceLanguage: string,
    targetLanguage: string,
    config: string,
    model: BergamotAlignedMemory,
    shortlist: BergamotAlignedMemory | null,
    vocabs: BergamotAlignedMemoryList,
    qualityModel: BergamotAlignedMemory | null
  ) => BergamotTranslationModel;
  BlockingService: new (options: { cacheSize: number }) => BergamotBlockingService;
  VectorString: new () => BergamotVectorString;
  VectorResponseOptions: new () => BergamotVectorResponseOptions;
}

export interface BergamotModuleOptions {
  INITIAL_MEMORY?: number;
  wasmBinary: ArrayBuffer;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  onAbort?: (reason: unknown) => void;
  onRuntimeInitialized?: () => void;
}

declare global {
  function loadBergamot(options: BergamotModuleOptions): BergamotModule;
}

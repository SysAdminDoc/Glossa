// Model catalog: the Mozilla Remote Settings collection that lists every Bergamot language model
// Firefox itself uses. Glossa reads the same records, so language coverage tracks Firefox exactly.
// Records point at zstd-compressed attachments on a CDN, each with hashes for the compressed and
// the decompressed bytes. Nothing here talks to the network; see engine/model-store.ts for that.

export const REMOTE_SETTINGS = {
  recordsUrl:
    "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records",
  attachmentBaseUrl: "https://firefox-settings-attachments.cdn.mozilla.net/"
} as const;

// Mozilla's public model registry bucket. It holds the same exported files (gzip rather than
// zstd) and, unlike the Remote Settings CDN, serves every browser. Its registry JSON is the
// join table from a catalog record to a bucket path; the catalog stays the hash authority.
export const MODEL_SOURCES = {
  gcsBaseUrl: "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data",
  gcsRegistryUrl: "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json"
} as const;

// The only origins Glossa ever reaches. Firefox treats `host_permissions` as optional and a
// temporary install starts with none of them, so the UI has to be able to ask for these by name.
export const MODEL_ORIGINS: readonly string[] = [
  "https://firefox.settings.services.mozilla.com/*",
  "https://firefox-settings-attachments.cdn.mozilla.net/*",
  "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/*"
];

// Firefox pins the model major version it can load. Bergamot 4.0 (the engine we vendor) reads 3.x.
export const MODEL_MAJOR_VERSION = 3;

export const PIVOT_LANGUAGE = "en";

export type ModelFileType = "model" | "lex" | "vocab" | "srcvocab" | "trgvocab";

export interface ModelRecord {
  id: string;
  name: string;
  version: string;
  fileType: ModelFileType;
  sourceLanguage: string;
  targetLanguage: string;
  architecture?: string;
  attachment: {
    hash: string;
    size: number;
    filename: string;
    location: string;
    mimetype: string;
  };
  decompressedHash?: string;
  decompressedSize?: number;
  filter_expression?: string;
  last_modified?: number;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  prerelease: string | null;
}

export interface PairFiles {
  sourceLanguage: string;
  targetLanguage: string;
  version: string;
  records: Partial<Record<ModelFileType, ModelRecord>>;
}

export function pairKey(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage}->${targetLanguage}`;
}

// "3.0", "3.1", "3.0a1" (alpha). Anything unparseable sorts last.
export function parseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)([a-z]+\d*)?$/i.exec(version.trim());
  if (!match) {
    return { major: -1, minor: -1, prerelease: null };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    prerelease: match[3] ? match[3].toLowerCase() : null
  };
}

// Stable beats prerelease, then higher major.minor wins. Returns > 0 when `a` is preferable.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if ((pa.prerelease === null) !== (pb.prerelease === null)) {
    return pa.prerelease === null ? 1 : -1;
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.prerelease && pb.prerelease) return pa.prerelease.localeCompare(pb.prerelease);
  return 0;
}

// Remote Settings gates some records with a JEXL filter expression that Firefox evaluates against
// its own environment. Three expressions are in use (checked against the live collection on
// 2026-09-10): two split a pair into a desktop `base` build and an Android `base-memory` build, and
// one keeps prerelease pairs (az, be, bs, nb, nn at 3.0a1) on the nightly channel. Ignoring them
// means a desktop browser loading the Android build and offering prereleases as if they shipped.
export interface CatalogEnvironment {
  os: "desktop" | "android";
  // "release" is every normal install. "nightly" is what the experimental-models setting asks for,
  // and it is the only way the prerelease-gated pairs become visible.
  channel: "release" | "nightly";
}

export const DEFAULT_ENVIRONMENT: CatalogEnvironment = { os: "desktop", channel: "release" };

const KNOWN_FILTERS = new Map<string, (environment: CatalogEnvironment) => boolean>([
  ["env.appinfo.OS == 'Android'", (environment) => environment.os === "android"],
  ["env.appinfo.OS != 'Android'", (environment) => environment.os !== "android"],
  ["env.channel == 'default' || env.channel == 'nightly'", (environment) => environment.channel === "nightly"]
]);

// A full JEXL evaluator would be a liability in an extension, and an expression nobody has read is
// a gate nobody understands, so anything outside the known set makes the record unusable.
export function matchesEnvironment(expression: string | undefined, environment: CatalogEnvironment): boolean {
  const trimmed = expression?.trim();
  if (!trimmed) return true;
  const test = KNOWN_FILTERS.get(trimmed);
  return test ? test(environment) : false;
}

export function catalogEnvironment(userAgent: string, experimental: boolean): CatalogEnvironment {
  return {
    os: /\bandroid\b/i.test(userAgent) ? "android" : "desktop",
    channel: experimental ? "nightly" : "release"
  };
}

export function isRecordUsable(record: ModelRecord, environment: CatalogEnvironment = DEFAULT_ENVIRONMENT): boolean {
  if (!record.sourceLanguage || !record.targetLanguage || !record.attachment) return false;
  if (!matchesEnvironment(record.filter_expression, environment)) return false;
  const parsed = parseVersion(record.version);
  return parsed.major === MODEL_MAJOR_VERSION;
}

// Pick the best file set for one direct pair. Per file type the newest stable record wins;
// a prerelease is only used when no stable record exists. A pair needs a model plus either a
// shared vocab or a src/trg vocab pair. The lexical shortlist is optional (Firefox treats it the
// same way).
export function selectPairFiles(
  records: ModelRecord[],
  sourceLanguage: string,
  targetLanguage: string,
  environment: CatalogEnvironment = DEFAULT_ENVIRONMENT
): PairFiles | null {
  const candidates = records.filter(
    (record) =>
      isRecordUsable(record, environment) &&
      record.sourceLanguage === sourceLanguage &&
      record.targetLanguage === targetLanguage
  );
  if (candidates.length === 0) return null;

  const best: Partial<Record<ModelFileType, ModelRecord>> = {};
  for (const record of candidates) {
    const current = best[record.fileType];
    if (!current || compareVersions(record.version, current.version) > 0) {
      best[record.fileType] = record;
    }
  }
  const model = best.model;
  if (!model) return null;
  const hasVocab = Boolean(best.vocab) || Boolean(best.srcvocab && best.trgvocab);
  if (!hasVocab) return null;

  // Keep the set version-consistent: drop optional files whose version differs from the model.
  const files: Partial<Record<ModelFileType, ModelRecord>> = { model };
  if (best.vocab) files.vocab = best.vocab;
  if (best.srcvocab && best.trgvocab) {
    files.srcvocab = best.srcvocab;
    files.trgvocab = best.trgvocab;
  }
  if (best.lex && compareVersions(best.lex.version, model.version) === 0) {
    files.lex = best.lex;
  }
  return { sourceLanguage, targetLanguage, version: model.version, records: files };
}

// Route a request through the catalog: a direct pair when it exists, otherwise two hops through
// English. Returns null when the catalog cannot serve the pair at all.
export function planRoute(
  records: ModelRecord[],
  sourceLanguage: string,
  targetLanguage: string,
  environment: CatalogEnvironment = DEFAULT_ENVIRONMENT
): PairFiles[] | null {
  if (sourceLanguage === targetLanguage) return [];
  const direct = selectPairFiles(records, sourceLanguage, targetLanguage, environment);
  if (direct) return [direct];
  if (sourceLanguage === PIVOT_LANGUAGE || targetLanguage === PIVOT_LANGUAGE) return null;
  const toPivot = selectPairFiles(records, sourceLanguage, PIVOT_LANGUAGE, environment);
  const fromPivot = selectPairFiles(records, PIVOT_LANGUAGE, targetLanguage, environment);
  if (!toPivot || !fromPivot) return null;
  return [toPivot, fromPivot];
}

export function routeBytes(route: PairFiles[]): number {
  let total = 0;
  for (const pair of route) {
    for (const record of Object.values(pair.records)) {
      total += record.decompressedSize ?? record.attachment.size;
    }
  }
  return total;
}

export function routeDownloadBytes(route: PairFiles[]): number {
  let total = 0;
  for (const pair of route) {
    for (const record of Object.values(pair.records)) {
      total += record.attachment.size;
    }
  }
  return total;
}

export interface LanguageCoverage {
  // Languages the catalog can translate FROM (into English, directly or as a pivot source).
  sources: string[];
  // Languages the catalog can translate INTO.
  targets: string[];
}

export function languageCoverage(
  records: ModelRecord[],
  environment: CatalogEnvironment = DEFAULT_ENVIRONMENT
): LanguageCoverage {
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const record of records) {
    if (!isRecordUsable(record, environment) || record.fileType !== "model") continue;
    sources.add(record.sourceLanguage);
    targets.add(record.targetLanguage);
  }
  // English is always both, since every other language pivots through it.
  sources.add(PIVOT_LANGUAGE);
  targets.add(PIVOT_LANGUAGE);
  return {
    sources: [...sources].sort(),
    targets: [...targets].sort()
  };
}

export function attachmentUrl(record: ModelRecord): string {
  return REMOTE_SETTINGS.attachmentBaseUrl + record.attachment.location;
}

// Normalise a BCP-47 tag from a page or the detector to the catalog's spelling.
// The catalog uses bare codes ("de", "pt") except for Chinese, which is script-tagged.
export function normalizeLanguageTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("zh")) {
    const parts = lower.split(/[-_]/);
    if (parts.includes("hant") || parts.includes("tw") || parts.includes("hk") || parts.includes("mo")) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }
  if (lower === "nb" || lower === "no" || lower === "nn") return "nb";
  if (lower === "iw") return "he";
  if (lower === "in") return "id";
  const primary = lower.split(/[-_]/)[0];
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

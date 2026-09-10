import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogEnvironment,
  compareVersions,
  isRecordUsable,
  languageCoverage,
  matchesEnvironment,
  normalizeLanguageTag,
  parseVersion,
  planRoute,
  routeBytes,
  routeDownloadBytes,
  selectPairFiles,
  type ModelRecord
} from "../src/shared/catalog.ts";
import { knownLanguageCodes, languageName } from "../src/shared/languages.ts";

let counter = 0;
function record(overrides: Partial<ModelRecord> & Pick<ModelRecord, "fileType" | "sourceLanguage" | "targetLanguage">): ModelRecord {
  counter++;
  return {
    id: `rec-${counter}`,
    name: `${overrides.fileType}.${overrides.sourceLanguage}${overrides.targetLanguage}.bin`,
    version: "3.0",
    attachment: {
      hash: "0".repeat(64),
      size: 1000,
      filename: "x.zst",
      location: `main-workspace/translations-models-v2/${counter}.zst`,
      mimetype: "application/zstd"
    },
    decompressedSize: 4000,
    ...overrides
  };
}

function pair(source: string, target: string, version = "3.0", withLex = true): ModelRecord[] {
  const out = [
    record({ fileType: "model", sourceLanguage: source, targetLanguage: target, version }),
    record({ fileType: "vocab", sourceLanguage: source, targetLanguage: target, version })
  ];
  if (withLex) out.push(record({ fileType: "lex", sourceLanguage: source, targetLanguage: target, version }));
  return out;
}

test("parseVersion handles stable and prerelease tags", () => {
  assert.deepEqual(parseVersion("3.1"), { major: 3, minor: 1, prerelease: null });
  assert.deepEqual(parseVersion("3.0a1"), { major: 3, minor: 0, prerelease: "a1" });
  assert.deepEqual(parseVersion("garbage"), { major: -1, minor: -1, prerelease: null });
});

test("compareVersions prefers stable over any prerelease, then higher numbers", () => {
  assert.ok(compareVersions("3.0", "3.1a1") > 0);
  assert.ok(compareVersions("3.1", "3.0") > 0);
  assert.ok(compareVersions("3.0a2", "3.0a1") > 0);
  assert.equal(compareVersions("3.0", "3.0"), 0);
});

test("selectPairFiles picks the newest stable record per file type", () => {
  const records = [...pair("es", "en", "3.0"), ...pair("es", "en", "3.1"), ...pair("es", "en", "4.0")];
  const files = selectPairFiles(records, "es", "en");
  assert.ok(files);
  assert.equal(files.version, "3.1");
  assert.equal(files.records.model?.version, "3.1");
  assert.equal(files.records.lex?.version, "3.1");
  assert.equal(files.records.vocab?.version, "3.1");
});

test("selectPairFiles falls back to a prerelease only when nothing stable exists", () => {
  const records = pair("az", "en", "3.0a1");
  const files = selectPairFiles(records, "az", "en");
  assert.ok(files);
  assert.equal(files.version, "3.0a1");
});

test("selectPairFiles drops a lex file from a different version than the model", () => {
  const records = [...pair("de", "en", "3.1", false), record({ fileType: "lex", sourceLanguage: "de", targetLanguage: "en", version: "3.0" })];
  const files = selectPairFiles(records, "de", "en");
  assert.ok(files);
  assert.equal(files.records.lex, undefined);
});

test("selectPairFiles refuses a pair without a vocabulary or without a model", () => {
  const noVocab = [record({ fileType: "model", sourceLanguage: "fr", targetLanguage: "en" })];
  assert.equal(selectPairFiles(noVocab, "fr", "en"), null);
  const noModel = [record({ fileType: "vocab", sourceLanguage: "fr", targetLanguage: "en" })];
  assert.equal(selectPairFiles(noModel, "fr", "en"), null);
});

test("selectPairFiles accepts a src/trg vocabulary pair", () => {
  const records = [
    record({ fileType: "model", sourceLanguage: "ja", targetLanguage: "en" }),
    record({ fileType: "srcvocab", sourceLanguage: "ja", targetLanguage: "en" }),
    record({ fileType: "trgvocab", sourceLanguage: "ja", targetLanguage: "en" })
  ];
  const files = selectPairFiles(records, "ja", "en");
  assert.ok(files);
  assert.ok(files.records.srcvocab && files.records.trgvocab);
});

test("planRoute returns a direct hop, pivots through English, or gives up", () => {
  const records = [...pair("es", "en"), ...pair("en", "fr"), ...pair("de", "en")];
  assert.equal(planRoute(records, "es", "en")?.length, 1);
  const pivot = planRoute(records, "es", "fr");
  assert.equal(pivot?.length, 2);
  assert.equal(pivot?.[0]?.targetLanguage, "en");
  assert.equal(pivot?.[1]?.sourceLanguage, "en");
  assert.equal(planRoute(records, "de", "fr")?.length, 2);
  assert.equal(planRoute(records, "es", "de"), null);
  assert.equal(planRoute(records, "en", "de"), null);
  assert.deepEqual(planRoute(records, "en", "en"), []);
});

test("route byte totals add up per hop", () => {
  const records = [...pair("es", "en"), ...pair("en", "fr")];
  const route = planRoute(records, "es", "fr");
  assert.ok(route);
  assert.equal(routeDownloadBytes(route), 6 * 1000);
  assert.equal(routeBytes(route), 6 * 4000);
});

test("languageCoverage lists every model source and target plus English", () => {
  const records = [...pair("es", "en"), ...pair("en", "fr"), record({ fileType: "vocab", sourceLanguage: "xx", targetLanguage: "en" })];
  const coverage = languageCoverage(records);
  assert.deepEqual(coverage.sources, ["en", "es"]);
  assert.deepEqual(coverage.targets, ["en", "fr"]);
});

test("normalizeLanguageTag maps page tags to catalog codes", () => {
  assert.equal(normalizeLanguageTag("es-MX"), "es");
  assert.equal(normalizeLanguageTag("zh-TW"), "zh-Hant");
  assert.equal(normalizeLanguageTag("zh"), "zh-Hans");
  assert.equal(normalizeLanguageTag("zh-Hans-CN"), "zh-Hans");
  assert.equal(normalizeLanguageTag("no"), "nb");
  assert.equal(normalizeLanguageTag("iw"), "he");
  assert.equal(normalizeLanguageTag(""), null);
  assert.equal(normalizeLanguageTag(null), null);
  assert.equal(normalizeLanguageTag("x-default"), null);
});

// ---- filter_expression gates (live shapes as of 2026-09-10) ----

const DESKTOP = { os: "desktop", channel: "release" } as const;
const ANDROID = { os: "android", channel: "release" } as const;
const NIGHTLY = { os: "desktop", channel: "nightly" } as const;

const ANDROID_ONLY = "env.appinfo.OS == 'Android'";
const DESKTOP_ONLY = "env.appinfo.OS != 'Android'";
const PRERELEASE_ONLY = "env.channel == 'default' || env.channel == 'nightly'";

function splitPair(source: string, target: string): ModelRecord[] {
  // What the catalog actually holds for ja->en, ko->en, zh-Hans->en, en->ko and en->ru: a desktop
  // build at 3.0 and a higher-versioned Android build that would otherwise win on version alone.
  return [
    record({ fileType: "model", sourceLanguage: source, targetLanguage: target, version: "3.0", architecture: "base", filter_expression: DESKTOP_ONLY }),
    record({ fileType: "vocab", sourceLanguage: source, targetLanguage: target, version: "3.0", filter_expression: DESKTOP_ONLY }),
    record({ fileType: "model", sourceLanguage: source, targetLanguage: target, version: "3.1", architecture: "base-memory", filter_expression: ANDROID_ONLY }),
    record({ fileType: "vocab", sourceLanguage: source, targetLanguage: target, version: "3.1", filter_expression: ANDROID_ONLY })
  ];
}

test("an unknown filter expression makes a record unusable", () => {
  assert.equal(matchesEnvironment(undefined, DESKTOP), true);
  assert.equal(matchesEnvironment("   ", DESKTOP), true);
  assert.equal(matchesEnvironment("env.version|versionCompare('140') >= 0", DESKTOP), false);
  const gated = record({ fileType: "model", sourceLanguage: "es", targetLanguage: "en", filter_expression: "env.os == 'Haiku'" });
  assert.equal(isRecordUsable(gated, DESKTOP), false);
});

test("desktop gets the base build and Android gets base-memory for a split pair", () => {
  const records = splitPair("ja", "en");
  const desktop = selectPairFiles(records, "ja", "en", DESKTOP);
  assert.equal(desktop?.version, "3.0");
  assert.equal(desktop?.records.model?.architecture, "base");
  const android = selectPairFiles(records, "ja", "en", ANDROID);
  assert.equal(android?.version, "3.1");
  assert.equal(android?.records.model?.architecture, "base-memory");
});

test("prerelease-gated pairs stay hidden until experimental models are on", () => {
  const records = [
    record({ fileType: "model", sourceLanguage: "nn", targetLanguage: "en", version: "3.0a1", filter_expression: PRERELEASE_ONLY }),
    record({ fileType: "vocab", sourceLanguage: "nn", targetLanguage: "en", version: "3.0a1", filter_expression: PRERELEASE_ONLY })
  ];
  assert.equal(selectPairFiles(records, "nn", "en", DESKTOP), null);
  assert.equal(planRoute(records, "nn", "en", DESKTOP), null);
  assert.equal(languageCoverage(records, DESKTOP).sources.includes("nn"), false);
  assert.equal(selectPairFiles(records, "nn", "en", NIGHTLY)?.version, "3.0a1");
  assert.equal(languageCoverage(records, NIGHTLY).sources.includes("nn"), true);
});

test("the environment comes from the user agent and the experimental setting", () => {
  const phone = "Mozilla/5.0 (Android 15; Mobile; rv:155.0) Gecko/155.0 Firefox/155.0";
  const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36";
  assert.deepEqual(catalogEnvironment(phone, false), { os: "android", channel: "release" });
  assert.deepEqual(catalogEnvironment(desktop, false), { os: "desktop", channel: "release" });
  assert.deepEqual(catalogEnvironment(desktop, true), { os: "desktop", channel: "nightly" });
});

test("every language the catalog can route has a display name", () => {
  // The 56 model languages in translations-models-v2 on 2026-09-10, including the prerelease ones.
  const catalogLanguages = (
    "af ar az be bg bn bs ca cs da de el en es et eu fa fi fr gl gu he hi hr hu id is it ja kn ko " +
    "lt lv ml mr ms nb nl nn pl pt ro ru sk sl sq sr sv ta te th tr uk ur vi zh-Hans zh-Hant"
  ).split(" ");
  const known = new Set(knownLanguageCodes());
  const missing = catalogLanguages.filter((code) => !known.has(code) || languageName(code) === code);
  assert.deepEqual(missing, []);
});

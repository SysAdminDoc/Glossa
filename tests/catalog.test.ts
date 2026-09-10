import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  languageCoverage,
  normalizeLanguageTag,
  parseVersion,
  planRoute,
  routeBytes,
  routeDownloadBytes,
  selectPairFiles,
  type ModelRecord
} from "../src/shared/catalog.ts";

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

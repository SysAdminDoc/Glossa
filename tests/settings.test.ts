import assert from "node:assert/strict";
import { test } from "node:test";

// settings.ts imports the extension API alias at module load. Provide a stub global before the
// import so the module evaluates under Node.
(globalThis as { chrome?: unknown }).chrome = { storage: { local: {} }, i18n: { getUILanguage: () => "en-US" } };
const { defaultSettings, mergeSettings } = await import("../src/shared/settings.ts");

test("defaults follow the UI language and never translate it", () => {
  const settings = defaultSettings("de-DE");
  assert.equal(settings.targetLanguage, "de");
  assert.deepEqual(settings.neverTranslateLanguages, ["de"]);
  assert.equal(settings.displayMode, "bilingual");
  assert.equal(settings.selectionPopup, false);
  assert.equal(defaultSettings("zh-TW").targetLanguage, "zh-Hant");
  assert.equal(defaultSettings(undefined).targetLanguage, "en");
});

test("mergeSettings keeps valid stored values and discards garbage", () => {
  const merged = mergeSettings(
    {
      targetLanguage: "fr",
      displayMode: "sideways",
      showOriginalOnHover: "yes",
      siteRules: { "example.com": "never", "bad.example": "sometimes", "": "always" },
      neverTranslateLanguages: ["fr", 42, ""],
      catalogRefreshHours: 0
    },
    "en-US"
  );
  assert.equal(merged.targetLanguage, "fr");
  assert.equal(merged.displayMode, "bilingual");
  assert.equal(merged.showOriginalOnHover, true);
  assert.deepEqual(merged.siteRules, { "example.com": "never" });
  assert.deepEqual(merged.neverTranslateLanguages, ["fr"]);
  assert.equal(merged.catalogRefreshHours, 24);
});

test("mergeSettings survives a non-object blob", () => {
  assert.equal(mergeSettings("corrupt", "en").targetLanguage, "en");
  assert.equal(mergeSettings(null, "es").targetLanguage, "es");
});

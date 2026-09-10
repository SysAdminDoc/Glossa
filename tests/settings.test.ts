import assert from "node:assert/strict";
import { test } from "node:test";

// settings.ts imports the extension API alias at module load. Provide a stub global and the
// build-time target flag (esbuild substitutes that one in a real build) before the import, so the
// module evaluates under Node.
(globalThis as { chrome?: unknown }).chrome = { storage: { local: {} }, i18n: { getUILanguage: () => "en-US" } };
(globalThis as { __GLOSSA_HAS_OFFSCREEN__?: boolean }).__GLOSSA_HAS_OFFSCREEN__ = false;
const { blockedReason, catalogMaxAgeMs, defaultSettings, hostOf, mergeSettings } = await import("../src/shared/settings.ts");

test("defaults follow the UI language and never translate it", () => {
  const settings = defaultSettings("de-DE");
  assert.equal(settings.targetLanguage, "de");
  assert.deepEqual(settings.neverTranslateLanguages, ["de"]);
  assert.equal(settings.displayMode, "bilingual");
  assert.equal(settings.selectionPopup, false);
  // Mozilla gates its prerelease models to nightly; Glossa does not offer them by default either.
  assert.equal(settings.experimentalModels, false);
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

test("the catalog refresh interval comes from the setting, clamped to something sane", () => {
  assert.equal(catalogMaxAgeMs({ catalogRefreshHours: 24 }), 24 * 60 * 60 * 1000);
  assert.equal(catalogMaxAgeMs({ catalogRefreshHours: 1 }), 60 * 60 * 1000);
  assert.equal(catalogMaxAgeMs({ catalogRefreshHours: 6 }), 6 * 60 * 60 * 1000);
  // Out of range or nonsense falls back inside the bounds rather than disabling the refresh.
  assert.equal(catalogMaxAgeMs({ catalogRefreshHours: 0 }), 60 * 60 * 1000);
  assert.equal(catalogMaxAgeMs({ catalogRefreshHours: 100_000 }), 30 * 24 * 60 * 60 * 1000);
  assert.equal(catalogMaxAgeMs({ catalogRefreshHours: Number.NaN }), 24 * 60 * 60 * 1000);
});

test("a never rule for the host stops the page, whatever its language", () => {
  const settings = { siteRules: { "example.com": "never" as const }, neverTranslateLanguages: [] };
  const reason = blockedReason(settings, "https://example.com/some/page?q=1", "es", (code) => code);
  assert.match(reason ?? "", /example\.com/);
  // A different host, and a subdomain, are not covered by the rule.
  assert.equal(blockedReason(settings, "https://other.com/", "es", (code) => code), null);
  assert.equal(blockedReason(settings, "https://www.example.com/", "es", (code) => code), null);
});

test("a page in a language the user reads is left alone", () => {
  const settings = { siteRules: {}, neverTranslateLanguages: ["es", "en"] };
  assert.match(blockedReason(settings, "https://example.com/", "es", () => "Spanish") ?? "", /Spanish/);
  assert.equal(blockedReason(settings, "https://example.com/", "fr", () => "French"), null);
  // Nothing detected yet is not a reason to stop.
  assert.equal(blockedReason(settings, "https://example.com/", null, () => "x"), null);
});

test("hostOf survives the urls a browser tab can actually hold", () => {
  assert.equal(hostOf("https://example.com:8443/x"), "example.com");
  assert.equal(hostOf("file:///C:/tmp/page.html"), null);
  assert.equal(hostOf("about:blank"), null);
  assert.equal(hostOf(null), null);
  assert.equal(hostOf("not a url"), null);
});

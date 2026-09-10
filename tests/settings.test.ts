import assert from "node:assert/strict";
import { test } from "node:test";

// settings.ts imports the extension API alias at module load. Provide a stub global and the
// build-time target flag (esbuild substitutes that one in a real build) before the import, so the
// module evaluates under Node.
// The stub answers i18n.getMessage from the real English catalogue, so a test that reads a message
// is checking what a user would see rather than a placeholder.
const messages = JSON.parse(
  await (await import("node:fs/promises")).readFile("src/extension/_locales/en/messages.json", "utf8")
) as Record<string, { message: string }>;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { local: {} },
  i18n: {
    getUILanguage: () => "en-US",
    getMessage: (key: string, substitutions: string[] = []) =>
      (messages[key]?.message ?? "").replace(/\$(\d)/g, (_, index: string) => substitutions[Number(index) - 1] ?? "")
  }
};
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

test("every language the interface ships in carries the same message keys", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const base = "src/extension/_locales";
  const locales = (await readdir(base)).sort();
  assert.ok(locales.includes("en"), "English is the fallback and has to exist");
  const english = Object.keys(messages).sort();
  for (const locale of locales) {
    const other = JSON.parse(await readFile(`${base}/${locale}/messages.json`, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(other).sort(),
      english,
      `${locale} does not carry the same keys as English`
    );
    for (const [key, value] of Object.entries(other)) {
      const message = (value as { message?: unknown }).message;
      assert.equal(typeof message, "string", `${locale}/${key} has no message`);
      assert.ok((message as string).length > 0, `${locale}/${key} is empty`);
      // A placeholder in English has to survive translation, or the value it stands for is lost.
      const wanted = (messages[key]?.message.match(/\$\d/g) ?? []).sort();
      const got = ((message as string).match(/\$\d/g) ?? []).sort();
      assert.deepEqual(got, wanted, `${locale}/${key} does not use the same placeholders as English`);
    }
  }
});

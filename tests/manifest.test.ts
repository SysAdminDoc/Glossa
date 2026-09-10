import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

// House rules and privacy claims that must hold in every shipped manifest. These read the source
// manifests, so they run without a build.
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };

const MODEL_HOSTS = [
  "https://firefox.settings.services.mozilla.com/*",
  "https://firefox-settings-attachments.cdn.mozilla.net/*",
  "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/*"
];

for (const target of ["chrome", "firefox"]) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "src", "extension", `manifest.${target}.json`), "utf8")
  ) as Record<string, unknown>;

  test(`${target}: version matches package.json`, () => {
    assert.equal(manifest["version"], pkg.version);
  });

  test(`${target}: no keyboard shortcuts and no static content scripts`, () => {
    assert.equal(manifest["commands"], undefined);
    assert.equal(manifest["content_scripts"], undefined);
  });

  test(`${target}: host permissions are exactly the three model sources`, () => {
    assert.deepEqual(manifest["host_permissions"], MODEL_HOSTS);
  });

  test(`${target}: CSP allows WASM and nothing remote`, () => {
    const csp = (manifest["content_security_policy"] as { extension_pages: string }).extension_pages;
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(csp, /https?:/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
  });

  test(`${target}: permissions stay within the documented set`, () => {
    const allowed = new Set(["storage", "unlimitedStorage", "offscreen", "activeTab", "scripting", "contextMenus"]);
    for (const permission of manifest["permissions"] as string[]) {
      assert.ok(allowed.has(permission), `unexpected permission ${permission}`);
    }
  });
}

test("firefox manifest uses an event page, chrome a service worker", async () => {
  const chrome = JSON.parse(await readFile(path.join(root, "src", "extension", "manifest.chrome.json"), "utf8"));
  const firefox = JSON.parse(await readFile(path.join(root, "src", "extension", "manifest.firefox.json"), "utf8"));
  assert.equal(typeof chrome.background.service_worker, "string");
  assert.ok(Array.isArray(firefox.background.scripts));
  assert.ok(chrome.permissions.includes("offscreen"));
  assert.ok(!firefox.permissions.includes("offscreen"));
});

test("firefox declares its data collection, which AMO requires for new submissions", async () => {
  const firefox = JSON.parse(await readFile(path.join(root, "src", "extension", "manifest.firefox.json"), "utf8"));
  const gecko = firefox.browser_specific_settings.gecko;
  // Mandatory for every new AMO submission since 2025-11-03. Glossa collects nothing, and "none"
  // is the keyword that says so; it may not be combined with any other value.
  assert.deepEqual(gecko.data_collection_permissions, { required: ["none"] });
  // The key itself landed in Firefox 140 and in Firefox for Android 142. A lower floor makes
  // `web-ext lint` report the key as unsupported by the minimum version.
  const [major] = gecko.strict_min_version.split(".").map(Number);
  assert.ok(major >= 142, `strict_min_version ${gecko.strict_min_version} is below the data collection key's floor`);
});

test("README and CHANGELOG carry the package version", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  assert.ok(readme.includes(`version-${pkg.version}-`), "README badge version is stale");
  assert.ok(changelog.includes(`## [${pkg.version}]`), "CHANGELOG has no entry for the current version");
});

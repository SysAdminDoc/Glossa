// Builds dist/chrome and dist/firefox (load-unpacked ready) and one ZIP per target.
// Every build starts from a clean dist so a renamed or removed file cannot linger.
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { packDirectoryAsStoreZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "vendor", "bergamot", "engine.lock.json"), "utf8"));
// `--smoke` adds a third target, chrome-smoke, identical to chrome except that it also holds a host
// permission for the loopback server the browser smoke test serves fixtures from. Automation
// cannot click the toolbar button, so activeTab never gets granted there. The shipped targets are
// unchanged and the smoke target is never zipped.
const SMOKE = process.argv.includes("--smoke");
const TARGETS = SMOKE ? ["chrome", "firefox", "chrome-smoke", "firefox-smoke"] : ["chrome", "firefox"];
const ICON_SIZES = [16, 32, 48, 128];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const wasmPath = path.join(root, "vendor", "bergamot", lock.decompressed.filename);
if (!(await exists(wasmPath))) {
  throw new Error(`Missing ${wasmPath}. Run \`npm run engine:fetch\` first.`);
}
const wasmHash = createHash("sha256").update(await readFile(wasmPath)).digest("hex");
if (wasmHash !== lock.decompressed.sha256) {
  throw new Error(`Engine binary hash mismatch. Expected ${lock.decompressed.sha256}, got ${wasmHash}. Re-run \`npm run engine:fetch\`.`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// "chrome-smoke" builds the chrome manifest, "firefox-smoke" the firefox one.
function manifestTargetOf(target) {
  return target.replace(/-smoke$/, "");
}

// The offscreen document exists only to host the engine on Chrome.
const CHROME_ONLY = new Set(["offscreen.js", "offscreen.html"]);

const bundles = [
  { entry: "src/background/background.ts", out: "background.js" },
  { entry: "src/content/content.ts", out: "content.js" },
  { entry: "src/engine/bergamot.worker.ts", out: "bergamot-worker.js" },
  { entry: "src/engine/offscreen.ts", out: "offscreen.js" },
  { entry: "src/popup/popup.ts", out: "popup.js" },
  { entry: "src/options/options.ts", out: "options.js" }
];

const copies = [
  ["src/content/content.css", "content.css"],
  ["src/engine/offscreen.html", "offscreen.html"],
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/options/options.html", "options.html"],
  ["src/options/options.css", "options.css"],
  ["vendor/bergamot/bergamot-translator.js", "bergamot-translator.js"],
  [`vendor/bergamot/${lock.decompressed.filename}`, "bergamot-translator.wasm"],
  ["vendor/bergamot/LICENSE", "LICENSE.bergamot.txt"],
];

// Every language the interface exists in. English is the fallback for a key a locale is missing,
// so a new key only has to be added to English to be safe, but the check below makes sure a key the
// code asks for exists there at all.
const LOCALES = (await readdir(path.join(root, "src", "extension", "_locales"))).sort();
for (const locale of LOCALES) {
  copies.push([`src/extension/_locales/${locale}/messages.json`, `_locales/${locale}/messages.json`]);
}

// Keys the code asks for, from the markup and from every `t("...")` call. A build that ships a key
// with no message shows the key to the user, which is exactly the bug this catches.
const english = JSON.parse(await readFile(path.join(root, "src", "extension", "_locales", "en", "messages.json"), "utf8"));
const used = new Set();
const sources = [
  "src/popup/popup.html",
  "src/popup/popup.ts",
  "src/options/options.html",
  "src/options/options.ts",
  "src/content/content.ts",
  "src/shared/settings.ts",
  "src/extension/manifest.chrome.json",
  "src/extension/manifest.firefox.json"
];
for (const file of sources) {
  const text = await readFile(path.join(root, file), "utf8");
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])t\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g)) used.add(match[1]);
  for (const match of text.matchAll(/data-i18n="([^"]+)"/g)) used.add(match[1]);
  for (const match of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(",")) {
      const key = pair.split("=")[1]?.trim();
      if (key) used.add(key);
    }
  }
  for (const match of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(match[1]);
}
// A stray control character in a source file is invisible in an editor and in most greps, and it
// silently broke the very check below once: a regex escape written through a shell heredoc became a
// literal backspace, so the scan matched nothing and reported everything as fine.
for (const file of sources) {
  const text = await readFile(path.join(root, file), "utf8");
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
  if (control) {
    throw new Error(`${file} contains a control character (0x${control[0].charCodeAt(0).toString(16)}) at ${control.index}`);
  }
}

const missing = [...used].filter((key) => !english[key]).sort();
if (missing.length > 0) {
  throw new Error(`No English message for: ${missing.join(", ")}`);
}
console.info(`build: ${Object.keys(english).length} messages, ${LOCALES.length} locales, ${used.size} keys in use`);

for (const target of TARGETS) {
  const targetDir = path.join(dist, target);
  await mkdir(targetDir, { recursive: true });

  const chromeTarget = !manifestTargetOf(target).startsWith("firefox");
  const targetBundles = bundles.filter((bundle) => chromeTarget || !CHROME_ONLY.has(bundle.out));
  const targetCopies = copies.filter(([, to]) => chromeTarget || !CHROME_ONLY.has(to));

  for (const bundle of targetBundles) {
    await esbuild.build({
      entryPoints: [path.join(root, bundle.entry)],
      outfile: path.join(targetDir, bundle.out),
      bundle: true,
      format: "iife",
      target: ["chrome116", "firefox128"],
      platform: "browser",
      minify: false,
      sourcemap: false,
      legalComments: "inline",
      define: {
        __GLOSSA_VERSION__: JSON.stringify(pkg.version),
        __GLOSSA_TARGET__: JSON.stringify(target),
        // Firefox has no offscreen API. False here removes the `chrome.offscreen` reference from
        // expressions; the statements guarded by the CHROME_ONLY label go with dropLabels below.
        __GLOSSA_HAS_OFFSCREEN__: JSON.stringify(chromeTarget)
      },
      // Everything inside a `CHROME_ONLY:` label is cut from the Firefox bundle. AMO's linter
      // refuses calls to APIs Firefox does not implement, even on a branch that never runs.
      dropLabels: chromeTarget ? [] : ["CHROME_ONLY"],
      logLevel: "warning"
    });
  }

  for (const [from, to] of targetCopies) {
    const destination = path.join(targetDir, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, from), destination);
  }

  const iconsDir = path.join(targetDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    await copyFile(path.join(root, "src", "extension", "icons", `icon-${size}.png`), path.join(iconsDir, `icon-${size}.png`));
  }

  const manifestTarget = manifestTargetOf(target);
  const manifest = JSON.parse(await readFile(path.join(root, "src", "extension", `manifest.${manifestTarget}.json`), "utf8"));
  manifest.version = pkg.version;
  if (target.endsWith("-smoke")) {
    manifest.host_permissions.push("http://127.0.0.1/*");
  }
  await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Bundled code must never contain eval; the extension CSP forbids it and store review flags it.
  // The Firefox bundle must also carry no call to a Chrome-only API: AMO's linter reports those as
  // UNSUPPORTED_API even on a branch that can never run.
  for (const bundle of targetBundles) {
    const code = await readFile(path.join(targetDir, bundle.out), "utf8");
    if (!chromeTarget && /chrome\.offscreen|OFFSCREEN_DOCUMENT/.test(code)) {
      throw new Error(`${bundle.out} in the Firefox build still references the offscreen API`);
    }
    if (/\beval\s*\(/.test(code) || /new Function\s*\(/.test(code)) {
      throw new Error(`${bundle.out} contains eval or new Function`);
    }
  }

  const files = [];
  for await (const filePath of walk(targetDir)) {
    files.push(path.relative(targetDir, filePath).replace(/\\/g, "/"));
  }
  const artifacts = {};
  for (const file of files) {
    artifacts[file] = createHash("sha256").update(await readFile(path.join(targetDir, file))).digest("hex");
  }
  await writeFile(
    path.join(targetDir, "build-info.json"),
    `${JSON.stringify({ product: "Glossa", target, version: pkg.version, engine: lock.release, artifacts }, null, 2)}\n`
  );

  if (target.endsWith("-smoke")) {
    // Firefox's temporary-install API takes a ZIP; Chromium loads the directory.
    if (target === "firefox-smoke") {
      await packDirectoryAsStoreZip(targetDir, path.join(dist, `${target}.zip`));
    }
    console.info(`build: ${target} -> dist/${target} (test variant, not released)`);
    continue;
  }
  const zipPath = path.join(dist, `glossa-${target}-v${pkg.version}.zip`);
  await packDirectoryAsStoreZip(targetDir, zipPath);
  const size = (await stat(zipPath)).size;
  console.info(`build: ${target} -> ${path.relative(root, zipPath)} (${(size / 1024 / 1024).toFixed(1)} MB, ${files.length} files)`);
}

async function* walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const next = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(next);
    } else if ((await stat(next)).isFile()) {
      yield next;
    }
  }
}

// A store-only (uncompressed) ZIP written by hand so entry names always use forward slashes.

// Builds dist/chrome and dist/firefox (load-unpacked ready) and one ZIP per target.
// Every build starts from a clean dist so a renamed or removed file cannot linger.
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "vendor", "bergamot", "engine.lock.json"), "utf8"));
// `--smoke` adds a third target, chrome-smoke, identical to chrome except that it also holds a host
// permission for the loopback server the browser smoke test serves fixtures from. Automation
// cannot click the toolbar button, so activeTab never gets granted there. The shipped targets are
// unchanged and the smoke target is never zipped.
const SMOKE = process.argv.includes("--smoke");
const TARGETS = SMOKE ? ["chrome", "firefox", "chrome-smoke"] : ["chrome", "firefox"];
const ICON_SIZES = [16, 32, 48, 128];
// Fixed timestamp keeps the ZIPs byte-reproducible for a given source tree.
const STORE_ZIP_DATE = new Date(Date.UTC(2026, 0, 1));
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

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
  ["src/extension/_locales/en/messages.json", "_locales/en/messages.json"]
];

for (const target of TARGETS) {
  const targetDir = path.join(dist, target);
  await mkdir(targetDir, { recursive: true });

  for (const bundle of bundles) {
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
      define: { __GLOSSA_VERSION__: JSON.stringify(pkg.version), __GLOSSA_TARGET__: JSON.stringify(target) },
      logLevel: "warning"
    });
  }

  for (const [from, to] of copies) {
    const destination = path.join(targetDir, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, from), destination);
  }

  const iconsDir = path.join(targetDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    await copyFile(path.join(root, "src", "extension", "icons", `icon-${size}.png`), path.join(iconsDir, `icon-${size}.png`));
  }

  const manifestTarget = target === "chrome-smoke" ? "chrome" : target;
  const manifest = JSON.parse(await readFile(path.join(root, "src", "extension", `manifest.${manifestTarget}.json`), "utf8"));
  manifest.version = pkg.version;
  if (target === "chrome-smoke") {
    manifest.host_permissions.push("http://127.0.0.1/*");
  }
  await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Bundled code must never contain eval; the extension CSP forbids it and store review flags it.
  for (const bundle of bundles) {
    const code = await readFile(path.join(targetDir, bundle.out), "utf8");
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

  if (target === "chrome-smoke") {
    console.info(`build: ${target} -> dist/${target} (unpacked only)`);
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
// PowerShell's Compress-Archive writes backslashes, which Chrome's manifest loader does not
// normalise, and it is not worth a dependency to avoid.
async function packDirectoryAsStoreZip(directory, outputPath) {
  const entries = [];
  for await (const filePath of walk(directory)) {
    const relative = path.relative(directory, filePath).replace(/\\/g, "/");
    entries.push({ filename: relative, data: new Uint8Array(await readFile(filePath)) });
  }
  await writeFile(outputPath, buildStoreZip(entries));
}

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoreZip(entries) {
  const encoder = new TextEncoder();
  const localBlocks = [];
  const centralBlocks = [];
  let offset = 0;
  const date = STORE_ZIP_DATE;
  const dosDate = ((Math.max(date.getUTCFullYear() - 1980, 0) & 0x7f) << 9) | (((date.getUTCMonth() + 1) & 0x0f) << 5) | (date.getUTCDate() & 0x1f);
  const dosTime = ((date.getUTCHours() & 0x1f) << 11) | ((date.getUTCMinutes() & 0x3f) << 5) | (Math.floor(date.getUTCSeconds() / 2) & 0x1f);

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30 + nameBytes.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    const localBytes = new Uint8Array(local.buffer);
    localBytes.set(nameBytes, 30);
    localBlocks.push(localBytes, entry.data);

    const central = new DataView(new ArrayBuffer(46 + nameBytes.length));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(central.buffer);
    centralBytes.set(nameBytes, 46);
    centralBlocks.push(centralBytes);

    offset += localBytes.length + entry.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const block of centralBlocks) centralSize += block.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  const output = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const block of [...localBlocks, ...centralBlocks, new Uint8Array(end.buffer)]) {
    output.set(block, cursor);
    cursor += block.length;
  }
  return output;
}

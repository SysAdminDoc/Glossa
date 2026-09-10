// Builds the source archive that AMO asks for whenever the submitted files were produced by a build
// step. A reviewer has to be able to rebuild the exact package from it, so the archive carries the
// source, the lockfile, the engine pin, and a plain description of how to run the build and what to
// compare afterwards. Nothing here is generated: everything in the archive is what is in the repo.
//
//   node tools/source-archive.mjs
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packFilesAsStoreZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "vendor", "bergamot", "engine.lock.json"), "utf8"));

// Everything a build needs and nothing it does not. The wasm binary is deliberately absent: it is
// fetched and hash-checked by `npm run engine:fetch`, and the hash it is checked against is here.
const DIRECTORIES = ["src", "tools", "tests", "vendor/bergamot"];
const FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "eslint.config.mjs",
  "README.md",
  "LICENSE",
  "CHANGELOG.md"
];
const SKIP = new Set([".zst", ".wasm"]);

async function collect(directory) {
  const out = [];
  const absolute = path.join(root, directory);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await collect(relative)));
      continue;
    }
    if (SKIP.has(path.extname(entry.name))) continue;
    out.push(relative);
  }
  return out;
}

const members = [...FILES];
for (const directory of DIRECTORIES) members.push(...(await collect(directory)));
members.sort();

const building = `Building Glossa ${pkg.version} from source
${"=".repeat(40)}

Environment used to produce the submitted package:

  Node    ${process.version}
  npm     ${pkg.engines?.node ?? ""} or newer required; the lockfile pins every dependency
  OS      any; the build writes no absolute paths and no timestamps

Steps:

  1. npm ci --ignore-scripts
     esbuild's install script is the only one in the tree. It only unpacks the platform binary,
     and --ignore-scripts skips it, so run "npm rebuild esbuild" afterwards if the build cannot
     find it.

  2. npm run engine:fetch
     Downloads the Bergamot WebAssembly binary from Mozilla's Remote Settings attachment CDN and
     checks it against both hashes pinned in vendor/bergamot/engine.lock.json:

       compressed   ${lock.attachment.sha256}
       decompressed ${lock.decompressed.sha256}

     The binary is not in this archive because it is not source: it is Mozilla's published build
     of https://github.com/mozilla/translations, release ${lock.release}, under MPL-2.0. Its
     Emscripten glue (vendor/bergamot/bergamot-translator.js) IS in this archive, unmodified.

  3. npm run build
     Writes dist/chrome and dist/firefox and one ZIP per target. The ZIP is byte-reproducible: it
     uses a fixed timestamp and a fixed file order, so the SHA-256 of the file it produces can be
     compared with the SHA-256 of the submitted file directly.

  4. Optional: npm run verify
     Type check, lint, unit tests, then the build.

What the extension does with the network:

  Nothing except fetch language models, from three Mozilla-operated locations listed in the
  manifest. Page text never leaves the browser: translation runs in a Web Worker inside the
  extension, using the WebAssembly engine bundled in the package. There is no analytics, no
  telemetry, no account and no remote configuration.

Files in this archive: ${members.length}
`;

const entries = [];
for (const member of members) {
  const absolute = path.join(root, member);
  const info = await stat(absolute);
  if (!info.isFile()) continue;
  entries.push({ name: member, data: await readFile(absolute) });
}
entries.push({ name: "BUILDING.txt", data: Buffer.from(building, "utf8") });
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const target = path.join(dist, `glossa-source-v${pkg.version}.zip`);
await packFilesAsStoreZip(entries, target);
const digest = createHash("sha256").update(await readFile(target)).digest("hex");
await writeFile(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`);
console.info(`source: ${path.relative(root, target)} (${entries.length} files)`);

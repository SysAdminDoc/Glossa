// Proves the claim the source archive makes: that a reviewer with nothing but that archive arrives
// at the same bytes as the published package. Unpacks it into a scratch directory, installs from
// the lockfile, fetches the pinned engine, builds, and compares SHA-256 with dist/.
//
//   node tools/verify-source.mjs
//
// Takes a couple of minutes and needs the network, so it is not part of `npm run verify`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const scratch = path.join(root, ".tmp", "verify-source");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

const archive = path.join(dist, `glossa-source-v${pkg.version}.zip`);
console.info(`verify-source: unpacking ${path.relative(root, archive)}`);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });

// Node has no unzip, and the archive is stored (uncompressed), so read it directly.
const bytes = new Uint8Array(await readFile(archive));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
// The writer never uses data descriptors, zip64 or directory entries, and never writes a comment,
// so the end-of-central-directory record sits in the last 22 bytes and holds the entry count. Any
// of those features means this is not an archive the build wrote, and it is refused rather than
// half-read: a reader that stops early would report a reproducibility failure that is really its
// own bug.
const eocd = bytes.length - 22;
if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) {
  throw new Error("the source archive does not end with the record this writer puts there");
}
const expected = view.getUint16(eocd + 10, true);
const root_ = path.resolve(scratch) + path.sep;
let offset = 0;
let extracted = 0;
const decoder = new TextDecoder();
const { writeFile } = await import("node:fs/promises");
while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
  const flags = view.getUint16(offset + 6, true);
  const size = view.getUint32(offset + 18, true);
  if (flags & 0x0008) throw new Error("the source archive uses data descriptors, which this build never writes");
  if (size === 0xffffffff) throw new Error("the source archive uses zip64, which this build never writes");
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const nameStart = offset + 30;
  const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
  const dataStart = nameStart + nameLength + extraLength;
  offset = dataStart + size;
  extracted++;
  if (name.endsWith("/")) continue;
  const target = path.resolve(scratch, name);
  if (!target.startsWith(root_)) throw new Error(`refusing to unpack ${name} outside the scratch directory`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes.subarray(dataStart, dataStart + size));
}
if (extracted !== expected) {
  throw new Error(`unpacked ${extracted} of the ${expected} entries the archive says it holds`);
}

console.info("verify-source: npm ci --ignore-scripts");
run("npm", ["ci", "--ignore-scripts"], scratch);
run("npm", ["rebuild", "esbuild"], scratch);
console.info("verify-source: npm run engine:fetch");
run("npm", ["run", "engine:fetch"], scratch);
console.info("verify-source: npm run build");
run("npm", ["run", "build"], scratch);

let mismatches = 0;
for (const target of ["chrome", "firefox"]) {
  const name = `glossa-${target}-v${pkg.version}.zip`;
  const published = await sha256(path.join(dist, name));
  const rebuilt = await sha256(path.join(scratch, "dist", name));
  const same = published === rebuilt;
  if (!same) mismatches++;
  console.info(`verify-source: ${same ? "MATCH " : "DIFFER"} ${name}`);
  if (!same) {
    console.info(`               published ${published}`);
    console.info(`               rebuilt   ${rebuilt}`);
  }
}
if (mismatches > 0) throw new Error(`${mismatches} artifact(s) did not reproduce from the source archive`);
console.info("verify-source: the source archive reproduces every published package byte for byte");

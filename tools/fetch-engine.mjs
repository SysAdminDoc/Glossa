// Downloads the Bergamot WASM binary pinned in vendor/bergamot/engine.lock.json, verifies both the
// compressed and decompressed SHA-256 hashes, and writes the decompressed binary next to the glue.
// The binary ships inside the extension package (WASM is code, and store policy forbids remote
// code), so it has to be present before `npm run build`.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor", "bergamot");
const lock = JSON.parse(await readFile(path.join(vendorDir, "engine.lock.json"), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyGlue() {
  const glue = await readFile(path.join(vendorDir, lock.glue.filename));
  const actual = sha256(glue);
  if (actual !== lock.glue.sha256) {
    throw new Error(`Glue hash mismatch for ${lock.glue.filename}: expected ${lock.glue.sha256}, got ${actual}`);
  }
  const versionMatch = glue.toString("utf8").match(/BERGAMOT_VERSION_FULL = "([^"]+)"/);
  if (!versionMatch || versionMatch[1] !== lock.glue.versionString) {
    throw new Error(`Glue version string mismatch: expected ${lock.glue.versionString}, found ${versionMatch?.[1]}`);
  }
}

async function alreadyPresent() {
  try {
    const existing = await readFile(path.join(vendorDir, lock.decompressed.filename));
    return existing.length === lock.decompressed.size && sha256(existing) === lock.decompressed.sha256;
  } catch {
    return false;
  }
}

await verifyGlue();
if (await alreadyPresent()) {
  console.info(`engine: ${lock.decompressed.filename} already present and verified (${lock.decompressed.size} bytes)`);
  process.exit(0);
}

console.info(`engine: downloading ${lock.attachment.url}`);
const response = await fetch(lock.attachment.url);
if (!response.ok) {
  throw new Error(`Download failed: HTTP ${response.status}`);
}
const compressed = Buffer.from(await response.arrayBuffer());
if (compressed.length !== lock.attachment.size) {
  throw new Error(`Compressed size mismatch: expected ${lock.attachment.size}, got ${compressed.length}`);
}
const compressedHash = sha256(compressed);
if (compressedHash !== lock.attachment.sha256) {
  throw new Error(`Compressed hash mismatch: expected ${lock.attachment.sha256}, got ${compressedHash}`);
}

const decompressed = zstdDecompressSync(compressed);
if (decompressed.length !== lock.decompressed.size) {
  throw new Error(`Decompressed size mismatch: expected ${lock.decompressed.size}, got ${decompressed.length}`);
}
const decompressedHash = sha256(decompressed);
if (decompressedHash !== lock.decompressed.sha256) {
  throw new Error(`Decompressed hash mismatch: expected ${lock.decompressed.sha256}, got ${decompressedHash}`);
}

await mkdir(vendorDir, { recursive: true });
await writeFile(path.join(vendorDir, lock.decompressed.filename), decompressed);
console.info(`engine: wrote ${lock.decompressed.filename} (${decompressed.length} bytes, sha256 ${decompressedHash})`);

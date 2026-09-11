// Builds a model mirror: a directory any web server can serve, holding a copy of Mozilla's catalog
// and the model files for the pairs you choose, laid out the way Glossa reads them once a mirror is
// set in its options (`<mirror>records.json` and `<mirror><attachment.location>`). Every file is
// checked against the compressed and decompressed hashes in Mozilla's catalog before it is written,
// and a file already on disk with the right hash is not downloaded again.
//
//   node tools/mirror-models.mjs --out <dir> --pairs es:en,en:es
//   node tools/mirror-models.mjs --out <dir> --all [--experimental]
//
// A pair with no direct model goes through English, as it does in the extension, so `--pairs es:fr`
// mirrors es:en and en:fr. `es-en` works as well as `es:en`; script-tagged codes need the colon
// (`zh-Hans:en`).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { attachmentUrl, catalogEnvironment, isRecordUsable, pairKey, planRoute, REMOTE_SETTINGS } from "../src/shared/catalog.ts";

// Thrown for anything the user should read, and turned into one line and exit status 1 below.
// process.exit() is not used: called while fetch still holds a socket open, it trips a libuv
// assertion on Windows and the status comes out as 127.
class MirrorError extends Error {}

function fail(message) {
  throw new MirrorError(message);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parsePair(text) {
  const parts = text.includes(":") ? text.split(":") : text.split("-");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(`cannot read the pair "${text}"; write it as source:target, for example es:en or zh-Hans:en`);
  }
  return { source: parts[0], target: parts[1] };
}

async function main() {
  const out = option("--out");
  if (!out) fail("--out <dir> is required");
  const all = process.argv.includes("--all");
  const pairsOption = option("--pairs");
  if (!all && !pairsOption) fail("name the pairs with --pairs es:en,en:es, or pass --all");
  // Read before the network is touched, so a typo costs nothing.
  const requested = all ? null : pairsOption.split(",").map((text) => parsePair(text.trim()));
  const environment = catalogEnvironment("", process.argv.includes("--experimental"));
  const root = path.resolve(out);

  console.info(`mirror: reading ${REMOTE_SETTINGS.recordsUrl}`);
  const catalogResponse = await fetch(REMOTE_SETTINGS.recordsUrl, { cache: "no-store" });
  if (!catalogResponse.ok) fail(`catalog request failed: HTTP ${catalogResponse.status}`);
  const records = (await catalogResponse.json()).data;
  if (!Array.isArray(records)) fail("the catalog response had no record list");

  // Which direct pairs to mirror, as routes through the same planner the extension uses.
  const wanted =
    requested ??
    [
      ...new Set(
        records
          .filter((record) => record.fileType === "model" && isRecordUsable(record, environment))
          .map((record) => pairKey(record.sourceLanguage, record.targetLanguage))
      )
    ].map((key) => {
      const [source, target] = key.split("->");
      return { source, target };
    });

  const chosen = new Map();
  for (const { source, target } of wanted) {
    const route = planRoute(records, source, target, environment);
    if (!route || route.length === 0) fail(`the catalog has no model for ${source} to ${target}`);
    for (const pair of route) {
      for (const record of Object.values(pair.records)) chosen.set(record.id, record);
    }
  }

  let downloaded = 0;
  let kept = 0;
  let bytes = 0;
  for (const record of chosen.values()) {
    const target = path.resolve(root, record.attachment.location);
    // The location comes from the network. It must name a file inside the mirror and nothing else.
    if (!target.startsWith(root + path.sep)) fail(`refusing ${record.attachment.location}: it points outside ${root}`);
    try {
      const existing = await readFile(target);
      if (existing.length === record.attachment.size && sha256(existing) === record.attachment.hash) {
        kept++;
        bytes += existing.length;
        continue;
      }
    } catch {
      // Not there yet.
    }
    const response = await fetch(attachmentUrl(record), { cache: "no-store" });
    if (!response.ok) fail(`${record.name}: HTTP ${response.status} from ${new URL(attachmentUrl(record)).host}`);
    const compressed = Buffer.from(await response.arrayBuffer());
    if (compressed.length !== record.attachment.size) {
      fail(`${record.name}: ${compressed.length} bytes, the catalog says ${record.attachment.size}`);
    }
    if (sha256(compressed) !== record.attachment.hash) fail(`${record.name}: compressed hash does not match the catalog`);
    // The same check the extension makes, so a mirror never serves a file the extension would refuse.
    if (record.decompressedHash) {
      const plain = zstdDecompressSync(compressed);
      if (plain.length !== record.decompressedSize || sha256(plain) !== record.decompressedHash) {
        fail(`${record.name}: decompressed file does not match the catalog`);
      }
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, compressed);
    downloaded++;
    bytes += compressed.length;
    console.info(`mirror: ${record.name} (${(compressed.length / 1_048_576).toFixed(1)} MB)`);
  }

  // Only what was mirrored goes in the mirror's catalog, so Glossa never offers a pair the mirror
  // cannot serve. The records are Mozilla's, byte for byte, filter expressions included.
  const mirrored = [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "records.json"),
    `${JSON.stringify({ mirroredFrom: REMOTE_SETTINGS.recordsUrl, mirroredAt: new Date().toISOString(), data: mirrored })}\n`
  );
  console.info(
    `mirror: ${mirrored.length} files for ${wanted.length} pair(s), ${downloaded} downloaded, ${kept} already present, ` +
      `${(bytes / 1_048_576).toFixed(1)} MB in ${root}`
  );
  console.info("mirror: serve that directory over HTTPS and enter its address in Glossa's options, under Language models.");
}

main().catch((error) => {
  console.error(`mirror: ${error instanceof MirrorError ? error.message : error?.stack ?? error}`);
  process.exitCode = 1;
});

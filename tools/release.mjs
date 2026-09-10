// Builds the release artifacts and, with --publish, tags the commit and creates the GitHub release.
//
//   node tools/release.mjs            # artifacts and sidecars only
//   node tools/release.mjs --publish  # also tag, push and create the release
//
// The ZIP is the primary install asset for both browsers. The CRX is a convenience for Chromium
// users who prefer a single file; Chromium refuses to install a self-signed CRX from the web
// (CRX_REQUIRED_PROOF_MISSING), so it is never the documented path. The signing key lives in
// glossa.pem, which is gitignored and generated on first use.
import { createHash, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const keyPath = path.join(root, "glossa.pem");
const publish = process.argv.includes("--publish");

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root, shell: false, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "a signal"}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "a signal"}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// ---- CRX3 ----
// Cr24 | version 3 | header length | CrxFileHeader | zip. The header holds the public key and a
// signature over "CRX3 SignedData\0", the length of the signed header, the signed header, and the
// zip bytes. The signed header is a protobuf SignedData carrying the 16-byte extension id.
function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function field(fieldNumber, payload) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

function packCrx3(zip, privateKeyPem) {
  const publicKey = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
  const crxId = createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);

  // "CRX3 SignedData" followed by a NUL byte, exactly as Chromium's verifier builds it.
  const magic = Buffer.concat([Buffer.from("CRX3 SignedData", "ascii"), Buffer.from([0])]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length, 0);

  const signer = createSign("sha256");
  signer.update(magic);
  signer.update(length);
  signer.update(signedHeaderData);
  signer.update(zip);
  const signature = signer.sign(privateKeyPem);

  const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10_000, signedHeaderData)]);

  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

async function loadOrCreateKey() {
  if (await exists(keyPath)) return readFile(keyPath, "utf8");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(keyPath, pem);
  console.info("release: generated glossa.pem (gitignored, keep it to keep the same extension id)");
  return pem;
}

// ---- build ----
console.info(`release: Glossa ${tag}`);
run(process.execPath, [path.join(root, "tools", "build.mjs")]);

// AMO requires the source when the submitted files came out of a build step, and it is worth
// publishing either way: anyone can check that the package matches the source it claims.
run(process.execPath, [path.join(root, "tools", "source-archive.mjs")]);

const zips = (await readdir(dist)).filter((name) => name.startsWith("glossa-") && name.endsWith(".zip"));
if (zips.length === 0) throw new Error("no release ZIP in dist/");

const assets = [];
const key = await loadOrCreateKey();
for (const name of zips) {
  const full = path.join(dist, name);
  assets.push(full);
  if (name.includes("-source-")) continue;
  if (name.includes("-chrome-")) {
    const crxPath = full.replace(/\.zip$/, ".crx");
    await writeFile(crxPath, packCrx3(await readFile(full), key));
    assets.push(crxPath);
  }
}

// One sidecar per asset, so a download can be checked without trusting the release page.
for (const asset of [...assets]) {
  const digest = createHash("sha256").update(await readFile(asset)).digest("hex");
  const sidecar = `${asset}.sha256`;
  await writeFile(sidecar, `${digest}  ${path.basename(asset)}\n`);
  assets.push(sidecar);
}

for (const asset of assets) {
  console.info(`release: ${path.relative(root, asset)}`);
}

if (!publish) {
  console.info("release: artifacts only. Re-run with --publish to tag and create the GitHub release.");
  process.exit(0);
}

// ---- publish ----
const status = capture("git", ["status", "--porcelain"]);
if (status) throw new Error(`working tree is dirty:\n${status}`);

const notes = await releaseNotes();
const existingTag = capture("git", ["tag", "--list", tag]);
if (!existingTag) {
  run("git", ["tag", "-a", tag, "-m", `Glossa ${tag}`]);
}
run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", tag]);

const notesPath = path.join(dist, "release-notes.md");
await writeFile(notesPath, notes);
run("gh", ["release", "create", tag, ...assets, "--title", tag, "--notes-file", notesPath]);
console.info(`release: published ${tag}`);

async function releaseNotes() {
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf(`## [${version}]`);
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}; run tools/bump.mjs first`);
  const after = changelog.indexOf("\n## [", start + 1);
  const body = changelog.slice(changelog.indexOf("\n", start) + 1, after === -1 ? undefined : after).trim();
  return `${body}\n`;
}

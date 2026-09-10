// Moves every version string in the tree to the same number, and turns the Unreleased section of
// the changelog into a dated release heading. One source of truth, invoked as
// `node tools/bump.mjs 0.2.0`.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node tools/bump.mjs <major.minor.patch>");
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);

async function editJson(file, edit) {
  const full = path.join(root, file);
  const data = JSON.parse(await readFile(full, "utf8"));
  edit(data);
  await writeFile(full, `${JSON.stringify(data, null, 2)}\n`);
  console.info(`bump: ${file}`);
}

async function editText(file, edit) {
  const full = path.join(root, file);
  const before = await readFile(full, "utf8");
  const after = edit(before);
  if (after === before) {
    console.info(`bump: ${file} unchanged`);
    return;
  }
  await writeFile(full, after);
  console.info(`bump: ${file}`);
}

await editJson("package.json", (pkg) => {
  pkg.version = version;
});
for (const manifest of ["src/extension/manifest.chrome.json", "src/extension/manifest.firefox.json"]) {
  await editJson(manifest, (data) => {
    data.version = version;
  });
}

// The README badge is the only version string in the docs; everything else reads it from the build.
await editText("README.md", (text) => text.replace(/version-\d+\.\d+\.\d+-/, `version-${version}-`));

await editText("CHANGELOG.md", (text) => {
  if (text.includes(`## [${version}]`)) return text;
  if (!text.includes("## [Unreleased]")) {
    throw new Error("CHANGELOG.md has no ## [Unreleased] section to release");
  }
  return text.replace("## [Unreleased]", `## [${version}] - ${today}`);
});

console.info(`bump: Glossa v${version} (${today})`);

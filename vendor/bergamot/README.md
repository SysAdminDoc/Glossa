# Bergamot translator (vendored)

This directory holds the on-device translation engine that Glossa runs. It is the same Marian NMT build that Firefox ships for its built-in translation feature, compiled to WebAssembly by Mozilla.

| File | What it is | Source |
|---|---|---|
| `bergamot-translator.js` | Emscripten glue, exposes `loadBergamot(Module)` | Firefox tree, `toolkit/components/translations/bergamot-translator/` |
| `bergamot-translator.wasm` | The engine binary. Not tracked in git. Run `npm run engine:fetch` to download it. | Mozilla Remote Settings, collection `translations-wasm-v2`, version 4.0 |
| `engine.lock.json` | Pinned URLs, sizes and SHA-256 hashes for both files | maintained by hand when bumping |
| `LICENSE` | Mozilla Public License 2.0 | upstream |

Both files are licensed under the MPL-2.0. Glossa itself is MIT. The MPL only covers these two files, and the license text ships in every build next to them.

## Updating

1. Read the current record from `https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm-v2/records`.
2. Copy `attachment.location`, `attachment.hash`, `attachment.size`, `decompressedHash` and `decompressedSize` into `engine.lock.json`.
3. Replace `bergamot-translator.js` with the copy from the Firefox tree at a revision that ships that same major version (`TranslationsParent.BERGAMOT_MAJOR_VERSION` in `TranslationsParent.sys.mjs`). Update `glue.sha256`.
4. If the Remote Settings major changed, bump `ENGINE_MAJOR_VERSION` in `src/shared/catalog.ts` to match, and `MODEL_MAJOR_VERSION` too if the engine reads a new model major. Installed models from another major then count as not installed and download again. `tests/manifest.test.ts` fails until the engine major matches this lock file.
5. Run `npm run engine:fetch` and `npm run verify`.

The glue and the binary must come from the same release. Mixing versions fails at runtime with an import mismatch, not at build time.

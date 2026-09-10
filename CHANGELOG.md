# Changelog

All notable changes to Glossa are recorded here. Dates are ISO (YYYY-MM-DD).

## [0.1.0] - 2026-09-10

First scaffold. Everything below works end to end in Chromium; Firefox loads and is wired the same way but has not yet been exercised by an automated test.

### Added
- On-device translation with the Bergamot engine (the same Marian NMT WebAssembly build Firefox ships), vendored under an MPL-2.0 notice with a hash-pinned fetch step.
- Model catalog read from Mozilla's Remote Settings collection, so language coverage tracks Firefox. Models download once on first use, are checked against both published SHA-256 hashes, and stay in the browser's Cache storage.
- Bilingual display (translation under the original block) as the default, with an in-place replace mode that keeps the original as a hover tooltip.
- Block-level DOM segmentation that keeps inline links and emphasis inside a sentence, honours `translate="no"`, `.notranslate`, `code`, `pre`, form fields, and open shadow roots.
- Mutation observer so single-page apps and late content get translated after the first pass.
- Show original without a reload.
- Context menu entries for the page and for a selection, with a small in-page result popover.
- Popup with page language, target language, mode toggle, download size before anything is fetched, and live progress. Options page with site rules, languages you read, a model manager, and a plain privacy statement.
- No host permission for the web. The content script is injected on demand through activeTab. The only hosts the extension can reach are the three Mozilla-operated model locations.
- Two model byte sources with one hash authority. Mozilla's Remote Settings CDN refuses Chrome user agents with a 406, so Chromium browsers fall back to Mozilla's model registry bucket, whose files match the catalog hashes byte for byte.
- Inline `translate="no"` and `.notranslate` elements inside a sentence are swapped for placeholders the engine copies verbatim and restored afterwards, and the whitespace Bergamot drops around inline code is put back.
- Translations inside open shadow roots get their block styling through an adopted stylesheet.
- Chrome MV3 (offscreen document hosts the engine) and Firefox MV3 (event page hosts it) builds from one source tree, plus a headless Chromium smoke test that drives the real popup.

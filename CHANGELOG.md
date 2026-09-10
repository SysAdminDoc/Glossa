# Changelog

All notable changes to Glossa are recorded here. Dates are ISO (YYYY-MM-DD).

## [Unreleased]

### Fixed
- Card grids and other link-wrapped blocks (`div > a > div`) are walked into instead of being sent to the engine as one unit, so bilingual mode no longer appends a second copy of every card.
- Content revealed after the first pass is picked up: the observer now watches text edits and the attributes that decide whether a block is translatable (`hidden`, `open`, `lang`, `translate`, `aria-hidden`), and re-checks the blocks an earlier pass skipped when a class or style changes.
- A block the page re-renders in place is translated again instead of keeping a stale translation forever, and the old translation goes with it.
- Writes to the page are no longer seen as page changes by the extension's own observer, so translated text is never fed back to the engine.
- Restore puts back a `lang` attribute the page set itself instead of deleting it.
- The engine is never handed its own output. Text it produced on the page is remembered for ten minutes, so a page that copies a finished translation into a new element does not get that text translated a second time.

## [0.1.0] - 2026-09-10

First scaffold. Everything below works end to end in headless Chromium 153 and in Firefox 155, each driven through the real popup by an automated smoke test.

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
- Chrome MV3 (offscreen document hosts the engine) and Firefox MV3 (event page hosts it) builds from one source tree, plus headless smoke tests for both browsers that drive the real popup.

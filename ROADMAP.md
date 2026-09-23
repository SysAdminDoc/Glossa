# Roadmap

Open work only. Items come from the 2026-09-10 research pass (see RESEARCH.md) and from what the first scaffold left unfinished. Ordered by priority, then by root-cause fixes before polish.

## P2

- [ ] G-12 — Layout-safety regression suite
  Why: broken layouts are the most reproducible complaint class for every competitor. A public list of sites rendered correctly is a checkable differentiator.
  Research note 2026-09-10: seed the fixture list from competitor defects: Wikipedia infobox with an excluded descendant (immersive-translate #2997), MathJax on IEEE and ar5iv (TWP #704), Reddit comment box (kiss #670), YouTube sidebar rail (kiss #561), Mastodon root `notranslate` with per-post `translate` (TWP #651), Svelte empty text-node placeholders (TWP #393), Google News icon-font ligatures (translatelocally #4), `<ruby>` (Bugzilla 1947054), inline-block card grids (local probe 2026-09-10).
  Touches: tests/fixtures (Wikipedia, MDN, GitHub, Hacker News snapshots), tests/smoke
  Acceptance: each fixture translates with no horizontal overflow and no element moving more than a set threshold, measured by Playwright.
  Complexity: M

## P3

- [ ] G-15 — Optional self-hosted LibreTranslate endpoint
  Why: no maintained LibreTranslate extension exists; the server has 16k stars and Simple Translate's request for it has been open since 2021.
  Touches: engine interface from G-06, options (endpoint URL, optional host permission for it)
  Acceptance: with an endpoint set, the page translates through it and the request goes only to that host.
  Complexity: M

- [ ] G-16 — PDF translation in the browser's viewer
  Why: repeatedly requested, poorly served. Needs a text-layer approach rather than DOM replacement.
  Complexity: XL

- [ ] G-17 — Firefox for Android
  Research note 2026-09-10: needs `browser_specific_settings.gecko_android` (Firefox Android 113+) or the listing is desktop-only; `background.scripts` is correct because background service workers are unsupported there; WASM SIMD exists on arm64 only (Firefox 90, Bugzilla 1625130), never arm32, so armeabi-v7a devices must get a readable "unsupported CPU" error (G-28); the catalog's Android-gated `base-memory` records (G-25) are the ones Firefox Android uses; `data_collection_permissions` needs Firefox Android 142.
  Why: as of 2026-09-10 nothing offline works on mobile. Firefox Android supports MV3 extensions and the engine needs SIMD, which recent phones have.
  Acceptance: the Firefox build installs on Firefox Android and translates the fixture.
  Complexity: L

## Research-Driven Additions

Added 2026-09-10 from the research pass in RESEARCH.md. Ids continue from G-17.

### P0

### P1

### P2

- [ ] P2 — G-54 — Decide whether curly quotes should be normalised before translation
  Why: G-38 (soft hyphens, CJK punctuation before a quote, edge whitespace) left curly quotes alone. mozilla/translations #977 reports that they change the output, but nothing in hand says which rewrite helps (straight quotes in, curly back out? only in some languages?), and rewriting quotes blind can damage text that uses them on purpose.
  Evidence: mozilla/translations #977; G-38 work 2026-09-10 (src/engine/text-prep.ts).
  Touches: src/engine/text-prep.ts, a comparison script under tools/ that translates a sample with and without the rewrite and reports the difference
  Acceptance: a measured comparison on at least three language pairs decides it; if a rewrite wins, it lands with tests, otherwise this item records why not.
  Complexity: S

- [ ] P2 — G-41 — Show per-pair quality and size before download
  Why: Bergamot trails Google by 4 COMET22 on average and by 7 to 9 on en-th, hi-en, en-ko, en-hi and en-lv; users on those pairs will blame the extension unless told first.
  Evidence: Mozilla eval DB (`db/db.sqlite`, 105 Release pairs, means Bergamot 84.8 vs Google 88.8) and registry `metrics.flores200-plus.comet22` in `models.json`.
  Touches: src/engine/model-store.ts (read the registry metrics already fetched for Chromium; fetch once for Firefox), src/popup/popup.ts and src/options/options.ts (a "quality: standard / lower" label with the COMET figure in a tooltip)
  Acceptance: the popup shows the label for the detected pair before download; the ten weakest pairs from RESEARCH.md show "lower".
  Complexity: S

- [ ] P2 — G-53 — Handle a page that changes part of a unit translated in replace mode
  Why: G-50 covers a page that renders a replaced unit again from what it reads on screen (the record is kept and "show original" still works). A page that changes only part of such a unit, adding a node or editing one of its own inside the translated text, still gets the record dropped, and the mixed text (translation plus the page's change) is then sent to the engine as if it were source text. Restoring the originals first would throw the page's change away, so this needs a decision rather than a quick fix: keep the page's nodes and restore around them, or report the block as not restorable.
  Evidence: G-50 work 2026-09-10; `reset` in src/content/renderer.ts compares the unit's text with what was written and keeps the record only on an exact match.
  Touches: src/content/renderer.ts (`reset`, restore), src/content/content.ts (count blocks that cannot be restored), src/popup/popup.ts (say so)
  Acceptance: after a page edits a word inside a replaced unit, "show original" either brings back the original with the page's edit applied, or the popup names the blocks it could not restore; the edited text is never sent as source text.
  Complexity: M

- [ ] P2 — G-43 — Progressive per-sentence rendering
  Why: long paragraphs appear all at once after the whole batch returns; the engine already reports sentence byte ranges that would let the first sentence render early.
  Evidence: v0.6.0 embind surface exposes `Response.size()`, `getSourceSentence(i)`, `getTranslatedSentence(i)` (`inference/wasm/bindings`, verified 2026-09-10); translatelocally #26.
  Touches: src/engine/bergamot.worker.ts (return sentence ranges), src/content/renderer.ts (fill a block sentence by sentence)
  Acceptance: on the 500-paragraph fixture the first visible sentence renders before the batch completes, measured in the smoke.
  Complexity: M

### P3

- [ ] P3 — G-45 — Main-content-first mode
  Why: Immersive Translate's most praised behaviour is translating the article body and leaving chrome alone; Readability.js is MPL-licensed and already shipped by Firefox and trialled by Chrome.
  Evidence: immersive-translate feature list; mozilla/readability (candidate scoring on text length, link density, class patterns).
  Touches: src/content/segmenter.ts (optional Readability pass to rank units), src/options
  Acceptance: with the mode on, a Wikipedia fixture translates the article before navigation and sidebars, and a setting disables it.
  Complexity: M

- [ ] P3 — G-55 — Hold only the matched part of a partly matched inline tag
  Why: a split-run hold must carry exactly the matched text, so when the tag at one end also holds other words (`https://ejemplo.<b>es y disfruta de la tienda</b>`) the run falls back to per-node protection. The prose stays translatable, but only the head of the address is protected, and the tail inside the tag reaches the engine as ordinary text.
  Evidence: adversarial review 2026-09-10 (finding 1 on 848e4a8) and its fix; `protectRunsAcrossTags` in src/content/segmenter.ts.
  Touches: src/content/segmenter.ts (split the partly matched element at the run boundary, cloning it the way Range.extractContents does, so the matched part is held and the rest stays prose), src/content/renderer.ts (put the split element back whole on restore), tests/split-protected.test.ts
  Acceptance: in both review probes the neighbouring prose still reaches the engine and the whole address comes back byte for byte, in both display modes, with the page's tag intact after "show original".
  Complexity: M

- [ ] P3 — G-52 — Make the Firefox smoke's "page translated" wait independent of language groups
  Why: the smoke brings the page tab to the front until no unit is `pending`, but `translateByLanguage` marks one language group pending at a time, so on a profile with a second route installed the wait can pass between groups and the popup tab hides the page again mid-run. A fresh profile never has a second route, so it does not bite today.
  Evidence: adversarial review 2026-09-10 (finding 9); `select_tab` wait in tests/smoke/firefox.smoke.py.
  Touches: tests/smoke/firefox.smoke.py (wait on a completion signal the content script exposes, or read the popup's state from the chrome context without selecting its tab)
  Acceptance: the smoke passes with an Arabic to English model already installed.
  Complexity: S

- [ ] P3 — G-46 — Learner hover delay for the selection popover
  Why: a configurable delay before the translation appears lets a learner guess first; it is the one idea in the hover-translator category with sustained praise.
  Evidence: TransOver (100k users, delay setting); Reverso's idiom auto-expansion.
  Touches: src/content/content.ts (depends on G-07), src/options
  Acceptance: with a 2 s delay set, the popover shows the source first and fills the translation after the delay.
  Complexity: S

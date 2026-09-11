# Roadmap

Open work only. Items come from the 2026-09-10 research pass (see RESEARCH.md) and from what the first scaffold left unfinished. Ordered by priority, then by root-cause fixes before polish.

## P2

- [ ] G-10 — Persist detected language and translation state across the popup closing during a download
  Why: closing the popup mid-download hides progress; the download continues but the user has no way to see it. With Chrome's engine it is worse: the popup starts the language pack download itself, so closing it before the pack arrives means the page is never translated until Translate is clicked again (adversarial review 2026-09-10, finding 7).
  Touches: src/popup/popup.ts (query engine for in-flight downloads on open; for Chrome's engine, hand the translate request to the background before the pack finishes), src/engine/engine-host.ts (expose active downloads)
  Acceptance: reopening the popup during a download shows the live progress bar, and a Chrome pack download that finishes after the popup closed still translates the page.
  Complexity: S

- [ ] G-11 — Per-page glossary and never-translate terms
  Why: brand names and technical terms get mangled; a glossary is a recurring request and Bergamot has no built-in mechanism, so it has to be a pre-pass that wraps terms in `translate="no"` spans.
  Touches: src/content/segmenter.ts, src/options
  Acceptance: a term added to the glossary survives translation verbatim on the fixture page.
  Complexity: M

- [ ] G-12 — Layout-safety regression suite
  Why: broken layouts are the most reproducible complaint class for every competitor. A public list of sites rendered correctly is a checkable differentiator.
  Research note 2026-09-10: seed the fixture list from competitor defects: Wikipedia infobox with an excluded descendant (immersive-translate #2997), MathJax on IEEE and ar5iv (TWP #704), Reddit comment box (kiss #670), YouTube sidebar rail (kiss #561), Mastodon root `notranslate` with per-post `translate` (TWP #651), Svelte empty text-node placeholders (TWP #393), Google News icon-font ligatures (translatelocally #4), `<ruby>` (Bugzilla 1947054), inline-block card grids (local probe 2026-09-10).
  Touches: tests/fixtures (Wikipedia, MDN, GitHub, Hacker News snapshots), tests/smoke
  Acceptance: each fixture translates with no horizontal overflow and no element moving more than a set threshold, measured by Playwright.
  Complexity: M

- [ ] G-13 — Memory ceiling and route eviction tuning
  Why: two loaded routes plus the WASM heap can pass 300 MB. There is no telemetry, so the ceiling has to be measured locally.
  Note 2026-09-10: the 15 s idle unload landed with G-28 (`ENGINE_IDLE_MS`), and on Chrome the offscreen document closes with it. What is left here is measuring the peak and tuning `MAX_LOADED_ROUTES`.
  Touches: src/engine/bergamot.worker.ts (MAX_LOADED_ROUTES, unload after idle), src/engine/engine-host.ts, docs
  Acceptance: an idle timer unloads models after a configurable period and the measured peak on the fixture set is documented in README.
  Complexity: S

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

- [ ] P2 — G-38 — Normalise text before submission: soft hyphens, curly quotes, CJK punctuation spacing, edge whitespace
  Why: soft hyphens (pervasive on Wikipedia) become garbage, curly quotes change output, CJK sentence splitting fails at full-width punctuation before a quote, and leading or trailing whitespace confuses the model.
  Evidence: bergamot-translator #337; mozilla/translations #977; Firefox worker `cleanText()` (strips U+00AD, `FULL_WIDTH_PUNCTUATION_REGEX` for ja/ko/zh, preserves edge whitespace).
  Touches: src/engine/bergamot.worker.ts or src/content/segmenter.ts (normalise on the way in, re-attach edge whitespace on the way out), tests
  Acceptance: a fixture paragraph containing U+00AD translates without `Ã` artefacts; a Japanese sentence ending in `。“` splits correctly; leading and trailing whitespace of every unit is byte-identical after translation.
  Complexity: S

- [ ] P2 — G-39 — Walk closed shadow roots with the extension DOM API
  Why: sites built on closed shadow roots (yandex.ru sidebar, many web-component frameworks) stay untranslated; the API to reach them exists in both browsers.
  Evidence: translatelocally #2, #38; `chrome.dom.openOrClosedShadowRoot` and `browser.dom.openOrClosedShadowRoot` (verified present on both engines 2026-09-10); `segmenter.ts` line 85 uses `element.shadowRoot`.
  Touches: src/content/segmenter.ts (`openOrClosedShadowRoot` with a fallback to `shadowRoot`), tests/fixtures
  Acceptance: a fixture with a closed shadow root is translated in both browser smokes.
  Complexity: S

- [ ] P2 — G-40 — Reset translation state on bfcache restore and cancel on page hide
  Why: a page restored from the back-forward cache keeps stale detection and unit state, and an unloading page keeps engine work queued.
  Evidence: translatelocally #17 (old page answered the new page's detection request); `content.ts` has no `pageshow`/`pagehide` handling.
  Touches: src/content/content.ts (`pageshow` with `persisted` re-runs detection, `pagehide` bumps the generation and stops the observer)
  Acceptance: navigating away and back on the fixture leaves the popup showing the correct language and state; no engine call arrives after `pagehide`.
  Complexity: S

- [ ] P2 — G-41 — Show per-pair quality and size before download
  Why: Bergamot trails Google by 4 COMET22 on average and by 7 to 9 on en-th, hi-en, en-ko, en-hi and en-lv; users on those pairs will blame the extension unless told first.
  Evidence: Mozilla eval DB (`db/db.sqlite`, 105 Release pairs, means Bergamot 84.8 vs Google 88.8) and registry `metrics.flores200-plus.comet22` in `models.json`.
  Touches: src/engine/model-store.ts (read the registry metrics already fetched for Chromium; fetch once for Firefox), src/popup/popup.ts and src/options/options.ts (a "quality: standard / lower" label with the COMET figure in a tooltip)
  Acceptance: the popup shows the label for the detected pair before download; the ten weakest pairs from RESEARCH.md show "lower".
  Complexity: S

- [ ] P2 — G-42 — Verify cached model bytes on load and request persistent storage
  Why: a truncated cache entry aborts the WASM with no explanation, and Cache API storage for extension origins can in principle be evicted on Firefox.
  Evidence: `model-store.ts` `ensurePair` returns cached bytes without a size check; MDN storage quotas (persistence semantics differ per browser); Bugzilla 1861489 (partial model files surviving cleanup).
  Touches: src/engine/model-store.ts (compare `byteLength` with `decompressedSize` on read, evict and re-download on mismatch, call `navigator.storage.persist()` once)
  Acceptance: a deliberately truncated cache entry is re-downloaded instead of crashing the worker; a unit test covers the mismatch path.
  Complexity: S

- [ ] P2 — G-47 — Engine and model major-version upgrade path
  Why: the engine is pinned to Remote Settings wasm 4.0 and models to major 3; when Mozilla publishes wasm 5.0 or models 4.x, installed 3.x models must be invalidated and re-downloaded, and at HEAD a6cce06 nothing handles that beyond a constant and a cache name.
  Evidence: `TranslationsParent.sys.mjs` L764-791 (version ladder: 1.x tiny, 2.x CJK and base, 3.x zstd; `LANGUAGE_MODEL_MAJOR_VERSION_MIN/MAX` both 3; `BERGAMOT_MAJOR_VERSION` 4); `src/shared/catalog.ts` `MODEL_MAJOR_VERSION`; `src/engine/model-store.ts` `CACHE_NAME = "glossa-models-v1"`.
  Touches: src/engine/model-store.ts (store the model major and engine release with each manifest entry; drop entries that do not match the running engine), vendor/bergamot/README.md (bump procedure names the model major), tests/model-store.test.ts
  Acceptance: a manifest entry recorded under a different engine release is reported as not installed and re-downloaded; a unit test covers the mismatch.
  Complexity: S

- [ ] P2 — G-49 — Protect a url or address that an inline tag splits in two
  Why: protection works per text node, but the gate tests the whole unit, so `Visita https://ejemplo.<b>es/catalogo</b>` holds the first half and hands `es/catalogo` to the engine as prose. Pages wrap url tails in `<b>`, `<wbr>` or `<span>` for line breaking all the time.
  Evidence: adversarial review 2026-09-10 (probe2 PROBE J); src/content/segmenter.ts `protectText` walks text nodes one at a time.
  Touches: src/content/segmenter.ts (match across the unit's flattened text, or merge adjacent partial matches), tests/segmenter.test.ts
  Acceptance: a url split across an inline tag comes back byte-identical, and the inline tag survives.
  Complexity: M

- [ ] P2 — G-50 — Keep a restore path for a unit the page re-renders in replace mode
  Why: when the page replaces the children of a unit translated in replace mode, the recorded original nodes no longer belong in the tree, so the record is dropped and "show original" can never bring that block's source text back. Bilingual mode is unaffected.
  Evidence: adversarial review 2026-09-10 (probe3 PROBE L); src/content/renderer.ts `reset` drops the record without restoring `originalChildren`.
  Touches: src/content/renderer.ts (keep the original text per unit and offer it on restore even after a re-render), tests
  Acceptance: a unit the page re-renders in replace mode still shows its pre-translation text after "show original", or the popup says plainly which blocks could not be restored.
  Complexity: M

- [ ] P2 — G-43 — Progressive per-sentence rendering
  Why: long paragraphs appear all at once after the whole batch returns; the engine already reports sentence byte ranges that would let the first sentence render early.
  Evidence: v0.6.0 embind surface exposes `Response.size()`, `getSourceSentence(i)`, `getTranslatedSentence(i)` (`inference/wasm/bindings`, verified 2026-09-10); translatelocally #26.
  Touches: src/engine/bergamot.worker.ts (return sentence ranges), src/content/renderer.ts (fill a block sentence by sentence)
  Acceptance: on the 500-paragraph fixture the first visible sentence renders before the batch completes, measured in the smoke.
  Complexity: M

- [ ] P2 — G-51 — Make the attribute pass cost proportional to what changed
  Why: every mutation flush runs `querySelectorAll("*")` over each queued root plus a `closest()` and a dozen `hasAttribute` calls per element, and the markers suppress the output but never the walk, so a page that toggles `hidden` or `aria-hidden` on a large wrapper pays a full rescan every 250 ms.
  Evidence: adversarial review 2026-09-10, instrumented on a 2,404-element feed (33,014 `hasAttribute` calls per flush, the same on the second pass with everything already marked); src/content/segmenter.ts `collectReadableAttributes`.
  Touches: src/content/segmenter.ts (skip marked or translated subtrees with one selector query, not per-element checks), src/content/content.ts (queue attribute work only for elements whose attributes actually changed)
  Acceptance: a second flush over an already-translated 2,000-element subtree performs under a tenth of the first flush's attribute checks, measured in a unit test with counted DOM calls.
  Complexity: S

### P3

- [ ] P3 — G-45 — Main-content-first mode
  Why: Immersive Translate's most praised behaviour is translating the article body and leaving chrome alone; Readability.js is MPL-licensed and already shipped by Firefox and trialled by Chrome.
  Evidence: immersive-translate feature list; mozilla/readability (candidate scoring on text length, link density, class patterns).
  Touches: src/content/segmenter.ts (optional Readability pass to rank units), src/options
  Acceptance: with the mode on, a Wikipedia fixture translates the article before navigation and sidebars, and a setting disables it.
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

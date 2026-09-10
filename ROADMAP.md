# Roadmap

Open work only. Items come from the 2026-09-10 research pass (see RESEARCH.md) and from what the first scaffold left unfinished. Ordered by priority, then by root-cause fixes before polish.

## P1

- [ ] G-04 — Keep original inline elements in place instead of re-parsing translated HTML
  Why: the renderer replaces a unit's children with nodes parsed from the engine's HTML output. Event listeners on inline elements (React links, buttons inside paragraphs) are lost until restore.
  Evidence: src/content/renderer.ts `parseFragment`; Firefox's translations-document.sys.mjs stamps `data-moz-translations-id` on every descendant before submitting (L3071) and its `merge()` (L6261) reorders the live nodes to match the translated tree, cloning when the engine duplicates an id and keeping original text when a node comes back empty.
  Research note 2026-09-10: do not build this on engine alignments. bergamot-translator #298 and #362 show alignments attach to tag-plus-token byte ranges, and Bugzilla 1844096 shows pivot alignment duplicating a linked word. Use the id-stamping merge; the engine already carries `data-*` attributes through unchanged.
  Touches: src/content/renderer.ts, src/content/segmenter.ts (stamp ids in `serializeUnit`)
  Acceptance: a paragraph containing a link with a click listener still fires that listener after translation in replace mode; the smoke test asserts it.
  Complexity: L

- [ ] G-05 — Signed Firefox build for permanent installs
  Research note 2026-09-10: blocked on G-24 (`data_collection_permissions` is mandatory for new AMO submissions since 2025-11-03) and G-35 (reproducible source archive; esbuild output triggers AMO's source-submission rule and a reviewer must rebuild a byte-identical XPI). The AMO API is v5; `web-ext sign --channel unlisted --upload-source-code`.
  Why: temporary add-ons vanish when Firefox closes. AMO unlisted signing is automated and needs no public listing.
  Evidence: README install section; Astra-Deck 2026-09-04 research confirmed unlisted signing works without a listing.
  Touches: tools/release-firefox.mjs (new, web-ext sign or the AMO API), README.md
  Acceptance: the release carries a signed `.xpi` that installs from `about:addons` and survives a restart.
  Complexity: M

- [ ] G-06 — Chrome built-in Translator API as an optional second engine
  Why: on Chrome 138+ and Edge 148+ the on-device Translator API needs no model download from a third party and covers a few languages Bergamot lacks. It must stay opt-in: the packs come from Google's component updater.
  Evidence: research pass section 2; Linguist issue #611 asks for the same.
  Research note 2026-09-10: the spec is `[Exposed=Window]`, so the API is not callable from the service worker at all; the offscreen document is a Window but running it there is undocumented (open question in RESEARCH.md), so host it in the popup or options page first. Hardware gate is 22 GB free disk and over 4 GB VRAM, desktop only. `@types/chrome` 0.2.9 has no typings; hand-write declarations. Do not add the expired `aiLanguageModelOriginTrial` permission.
  Touches: src/engine/ (new engine interface with Bergamot and Chrome implementations), src/popup or src/options (hosts the API call, needs user activation for the first download), src/options
  Acceptance: an "Engine" setting with Bergamot as default; choosing Chrome built-in translates a page with no request to the Mozilla hosts; Firefox hides the option.
  Complexity: M

- [ ] G-07 — Selection popup when the setting is on
  Why: the setting exists and does nothing yet. It stays off by default because popups on every selection are the most cited irritant in competitor reviews.
  Evidence: src/shared/settings.ts `selectionPopup`; research pass community section.
  Touches: src/content/content.ts (selectionchange listener, small trigger button near the selection, reuses the popover)
  Acceptance: with the setting on, selecting text on an injected page shows a small button; clicking it translates the selection in the popover; with the setting off nothing appears.
  Complexity: S

- [ ] G-08 — Input field translation
  Why: composing in your language and sending in theirs is a top-five request across trackers.
  Evidence: research pass; kiss-translator and immersive-translate both ship it.
  Touches: src/content/ (context menu on editable targets, replace the field value), src/background/background.ts (menu entry with `editable` context)
  Acceptance: right-clicking inside a textarea offers "Translate this field to <language>", and the field content is replaced with the translation.
  Complexity: S

- [ ] G-09 — Mirror the model catalog and files to the project's own release host
  Why: on Chromium browsers the model bytes come from a Mozilla bucket on Google Cloud Storage because the Remote Settings CDN refuses Chrome user agents (RESEARCH.md findings). Privacy-community users check the network tab, and the HN reaction to Firefox Translations hosting models on Google's infrastructure is the precedent. A self-hosted mirror also survives a catalog move (the v1 collection is already deprecated).
  Evidence: live 406 from `firefox-settings-attachments.cdn.mozilla.net` with a Chrome UA on 2026-09-10; HN thread 33792447.
  Touches: tools/mirror-models.mjs (new), src/shared/catalog.ts (mirror base URL setting with Mozilla as fallback), manifest host permissions
  Acceptance: a setting selects the mirror; with it set, no request goes to a Mozilla host and hashes still verify.
  Complexity: M

## P2

- [ ] G-10 — Persist detected language and translation state across the popup closing during a download
  Why: closing the popup mid-download hides progress; the download continues but the user has no way to see it.
  Touches: src/popup/popup.ts (query engine for in-flight downloads on open), src/engine/engine-host.ts (expose active downloads)
  Acceptance: reopening the popup during a download shows the live progress bar.
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

- [ ] P1 — G-26 — Translate same-origin iframes without double injection
  Why: content inside same-origin frames (comment widgets, docs viewers, Thunderbird-style mail bodies) is never translated; naive `allFrames` injection produces duplicate translations.
  Evidence: local probe 2026-09-10 (`#frm` case untouched); kiss-translator #730 (two identical lines from top-frame plus iframe injection); immersive-translate #4052 (heap growth from hundreds of short-lived iframes).
  Touches: src/background/background.ts (`executeScript` with `allFrames: true`, per-frame status keyed by `frameId`), src/content/content.ts (frame-local state, ignore cross-origin failures), src/popup/popup.ts (sum block counts)
  Acceptance: the probe's iframe paragraph gets a bilingual block exactly once; a page with 50 empty iframes translates in the same time as without them.
  Complexity: M

- [ ] P1 — G-27 — Translate attributes and `<option>` labels with Firefox's criteria map
  Why: `title`, `placeholder`, `alt`, `aria-label`, `<option>` text and `document.title` stay in the source language; this is the oldest open request on the Bergamot extensions.
  Evidence: local probe 2026-09-10 (`#inp`, `#img`, `#title-p`, document title); translatelocally #69, bergamot #314; Firefox `TRANSLATABLE_ATTRIBUTES` (L435: `alt` on AREA/IMAGE/IMG/INPUT, `placeholder` on INPUT/TEXTAREA, `title` everywhere, ten `aria-*`, `content` on `META[name=description|keywords]`, `value` only on `INPUT[type=button|reset]`), `<option>` explicit-value preservation (L6213-6222).
  Touches: src/content/segmenter.ts (attribute segments), src/content/renderer.ts (write attributes, preserve `<option value>`, restore), src/shared/messages.ts, tests
  Acceptance: the probe's placeholder, alt, title and document title are translated and restored; a `<select>` keeps its selected value and every option's original `value` after translation.
  Complexity: M

- [ ] P1 — G-29 — Viewport-first scheduling with priorities and a pause when the tab is hidden
  Why: at HEAD a6cce06 every unit is queued in one pass sorted once by bounding rect, so a long page blocks on off-screen text while translations pop in at scattered positions; background tabs keep the engine busy.
  Evidence: translatelocally #26 (scattered pop-in); Firefox four IntersectionObservers with `rootMargin` `0%` and `150% 50%` (L1164-1396), P0-P7 by scroll direction (L3662), `AntiStarvationStack(2, 1)` with one request in flight (L4692, L5039), `onHidePage()` releasing the engine (L5333); `content.ts` `orderViewportFirst`.
  Touches: src/content/content.ts (IntersectionObserver-driven queue, `visibilitychange` pause), src/content/segmenter.ts
  Acceptance: on a 500-paragraph fixture the visible paragraphs are translated before any off-screen one and scrolling re-prioritises; a hidden tab issues no engine calls until shown.
  Complexity: L

- [ ] P1 — G-30 — Accessibility of bilingual output
  Why: two languages in one document must be programmatically distinguishable (WCAG 3.1.2); inserted blocks carry `lang` but not `dir`; duplicated links inside translation blocks read twice to screen readers; the popup status and progress are not announced.
  Evidence: WCAG 3.1.2 and 1.3.1; Bugzilla 1901177 (Gecko a11y cache ignores `lang` changes, so also set `dir` and keep tags minimal), 1902352 (announce first result, not completion); NVDA subtag handling; `popup.html` progress bar has no `role`, mode buttons no `aria-pressed`.
  Touches: src/content/renderer.ts (`dir` from the target language, walk to `li`/`td` ancestors like Firefox L3310; `aria-hidden` only on translation blocks with no focusable descendants), src/popup/popup.html and popup.ts (`role="progressbar"` with `aria-valuenow`, `aria-live="polite"` on the status line, `aria-pressed` on mode buttons), tests (axe run on popup and options)
  Acceptance: an axe pass on popup and options reports no violations; every `glossa-translation` element has `lang` and `dir`; a screen-reader transcript of the fixture does not read link text twice.
  Complexity: M

- [ ] P1 — G-31 — Selection popover meets WCAG hover and target rules and never lands inside an editor
  Why: the popover cannot be dismissed with Esc, its close target is under 24 px, it can cover the selection it explains, and it is appended to the document root without checking editors.
  Evidence: WCAG 1.4.13, 2.5.8, 2.4.11; linguist #344 (focus stolen from the selection); simple-translate #342 (popup saved into TinyMCE content); `content.ts` `showPopover`.
  Touches: src/content/content.ts `showPopover`, src/content/content.css
  Acceptance: Esc closes the popover; the close control measures at least 24 by 24 CSS px; the popover is positioned outside the selection rect; on a `contenteditable` page the popover is a sibling of the editor, never inside it, and the editor's `innerHTML` is unchanged afterwards.
  Complexity: S

- [ ] P1 — G-34 — Release pipeline and version bump script
  Why: no release exists; version strings live in four files edited by hand; the house rule is ZIP as the primary asset with a CRX3 secondary and SHA-256 sidecars.
  Evidence: README install section points at a releases page with nothing on it; tests/manifest.test.ts guards the strings but nothing bumps them; house release rules.
  Touches: tools/bump.mjs (package.json, both manifests, README badge, CHANGELOG heading), tools/release.mjs (build, CRX3 with a gitignored selfhost pem, `.sha256` sidecars, `gh release create` with notes from CHANGELOG), README.md
  Acceptance: `npm run release -- 0.2.0` produces both ZIPs, a CRX, sidecars, a tagged commit and a GitHub release whose assets download and match the sidecars.
  Complexity: M

- [ ] P1 — G-35 — Reproducible source archive and reviewer notes for AMO and the Chrome Web Store
  Why: esbuild output triggers AMO's source-submission rule; reviewers must rebuild a byte-identical XPI from a README naming OS and exact tool versions; neither store's policy addresses runtime-fetched model weights, so the listing must explain them.
  Evidence: extensionworkshop source-code-submission (default reviewer environment Ubuntu 24.04 ARM64, Node 24.14.0, npm 11.9.0); Chrome remote-hosted-code policy names WASM (bundled here) and allows data fetches; CWS 2026-08-01 policy update on single purpose.
  Touches: tools/source-archive.mjs (source, lockfile, engine.lock.json, build script, README with `npm ci --ignore-scripts && npm run engine:fetch && npm run build`), docs/store/ (single-purpose statement, permission justifications, model-data explanation, privacy statement)
  Acceptance: a clean checkout on the documented Node version reproduces `dist/glossa-firefox-v*.zip` byte for byte; the docs/store texts exist and are linked from README.
  Complexity: S

- [ ] P1 — G-36 — Localise the extension UI
  Why: a translator whose own popup and options are English-only is a documented complaint; every UI string is hardcoded in HTML and TypeScript and `_locales` holds only the name and description.
  Evidence: translatelocally #43; `src/popup/popup.html`, `src/options/options.html`, `src/extension/_locales/en/messages.json`.
  Touches: src/extension/_locales (en plus es, de, fr, ja, zh-Hans as human-written files), src/popup, src/options (a small `t()` over `i18n.getMessage`), tools/build.mjs (fail on missing keys)
  Acceptance: switching the browser UI language to Spanish renders the popup and options in Spanish; a build with a missing key fails.
  Complexity: M

- [ ] P1 — G-37 — Unit and smoke coverage for the engine path and the probe cases
  Why: the model store's 406 fallback, hash-mismatch rejection and partial-download handling have no tests; the smoke never asserts the hidden reveal, a pivot route, replace mode, or Firefox; the compression test's `fzstd` assertion inverts once Node adds zstd to `DecompressionStream`.
  Evidence: tests/ directory listing 2026-09-10; `tests/compression.test.ts` line asserting `zstdBackend() === "fzstd"`; local probe cases.
  Touches: tests/model-store.test.ts (fake `fetch` and `caches`), tests/engine-host.test.ts (fake Worker), tests/smoke/chromium.smoke.mjs (probe fixture, es→fr pivot, replace mode, light-theme screenshot), package.json (`verify:release` runs both smokes), tests/compression.test.ts (assert against `"zstd" in` a DecompressionStream probe)
  Acceptance: `npm run verify` covers the 406 fallback with a fake server; `npm run verify:release` runs both browser smokes and the probe fixture; the compression test passes regardless of native zstd support.
  Complexity: M

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

### P3

- [ ] P3 — G-45 — Main-content-first mode
  Why: Immersive Translate's most praised behaviour is translating the article body and leaving chrome alone; Readability.js is MPL-licensed and already shipped by Firefox and trialled by Chrome.
  Evidence: immersive-translate feature list; mozilla/readability (candidate scoring on text length, link density, class patterns).
  Touches: src/content/segmenter.ts (optional Readability pass to rank units), src/options
  Acceptance: with the mode on, a Wikipedia fixture translates the article before navigation and sidebars, and a setting disables it.
  Complexity: M

- [ ] P3 — G-46 — Learner hover delay for the selection popover
  Why: a configurable delay before the translation appears lets a learner guess first; it is the one idea in the hover-translator category with sustained praise.
  Evidence: TransOver (100k users, delay setting); Reverso's idiom auto-expansion.
  Touches: src/content/content.ts (depends on G-07), src/options
  Acceptance: with a 2 s delay set, the popover shows the source first and fills the translation after the delay.
  Complexity: S

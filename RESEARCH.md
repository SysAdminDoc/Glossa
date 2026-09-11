# Research — Glossa
Date: 2026-09-10 — replaces all prior research.

## Executive Summary

Glossa (v0.1.0, two commits, no tracker traffic) is a Chrome and Firefox MV3 extension that translates pages on-device with Mozilla's Bergamot WASM engine, using the Remote Settings catalog as hash authority and Mozilla's GCS model registry as the byte source for Chromium (the Mozilla CDN answers 406 to Chrome user agents). It already has the three properties no shipping competitor combines: no cloud code path, bilingual display under the original, and no host permission for websites. Both browser smokes pass. Its strongest current shape is a correct, small, honest core; its weakest is everything the smoke does not exercise. A behavioural probe on 2026-09-10 against the built extension found eight defects (inline-wrapped card grids duplicated whole, hidden-then-revealed and edited text left stale, re-rendered units never re-translated, same-origin iframes and attributes untranslated, URLs and emails mangled, per-element `lang` ignored), and the options page carries four controls whose settings nothing reads. Mozilla's own `translations-document.sys.mjs` is the reference implementation for every one of those gaps and is MPL-2.0, so the highest-value direction is to port its node-selection, mutation, priority, and merge techniques rather than invent them.

Top opportunities in priority order:
1. Fix the DOM correctness defects the probe exposed (segmentation of inline wrappers, mutation coverage, re-translation guard, URL and email protection, per-element `lang`).
2. Make every settings control act or remove it; the options page currently misleads.
3. Add `data_collection_permissions` and strip Chrome-only code from the Firefox bundle; `web-ext lint` is otherwise clean.
4. Evaluate catalog `filter_expression` so desktop gets the `base` builds Firefox desktop gets and nightly-only prereleases stay hidden.
5. Attributes, iframes, and closed shadow roots (all reachable with existing APIs).
6. Engine lifecycle: idle unload at 15 s like Firefox, worker restart on abort, per-session SIMD detection with a readable error.
7. Accessibility of bilingual output (`lang` plus `dir` on every inserted node, duplicate-content policy, live announcements) and the release pipeline that does not exist yet.

## Product Map

- Core workflows: translate the current tab (bilingual or replace), show original without reload, translate a selection from the context menu, manage downloaded models, per-site rules (collected, not yet enforced).
- Personas: privacy-conscious readers who reject vendor translators; language learners who want the original kept; Brave, Firefox, and corporate users where cloud translation is blocked or slow; machines below Chrome's on-device Translator hardware gate (22 GB free disk, over 4 GB VRAM).
- Platforms: Chromium 116+ (offscreen document hosts the engine worker), Firefox 128+ (event page hosts it). Firefox for Android needs the `gecko_android` manifest key and arm64 (WASM SIMD never shipped for arm32, Bugzilla 1625130).
- Data flow: content script → background → engine worker; catalog from `translations-models-v2` (125 model records, 109 directed pairs, all English-pivoted, versions 3.0, 3.1, 3.0a1); engine binary bundled from `translations-wasm-v2` 4.0, still at upstream HEAD (`inference/BERGAMOT_VERSION` v0.6.0). Bytes from the Mozilla CDN (Firefox) or the GCS registry (Chromium). No other network.

## Competitive Landscape

- **Firefox built-in Translations** (reference, MPL-2.0). Learn: `nodeNeedsSubdividing` recursion with computed-display block detection (`translations-document.sys.mjs` L6624-6657), the tiered `isNodeHidden` ladder (L5997), `TRANSLATABLE_ATTRIBUTES` per-tag criteria map (L435), `data-moz-translations-id` stamping plus `merge()` reusing live nodes (L3060, L6261), the output-string `LRUCache` that refuses to resubmit its own output (L76, L268), four IntersectionObservers with P0-P7 scroll-direction priorities (L1164-1396, L3662), 25 ms write batching with the observer paused around writes (L348, L3449), `dir` propagation to list and table ancestors (L3310), 15 s engine idle timeout (`translations-engine.sys.mjs` L125), soft-hyphen stripping and CJK punctuation spacing in the worker. Avoid its open bugs: `translate="no"` on `<html>` and `<title>` ignored (Bugzilla 1842814, 1969828), `lang` left stale after translation (1901177), no completion announcement (1902352).
- **Chrome and Edge built-in.** The page-translate UI still uses the Google Translate server (Chromium design doc); only detection is local. The on-device Translator API (Chrome 138, Edge 148) is Window-only, desktop-only, gated on 22 GB disk and 4 GB VRAM, and Mozilla's standards position on it is negative (mozilla/standards-positions #1015). Learn: Edge's per-pair `downloadprogress` monitor and model sharing across sites. Avoid: treating it as a baseline.
- **Safari.** Apple's own document states page translation sends the full page text to Apple's servers. Not on-device.
- **DeepL extension** (4M users). Paywalls full-page translation itself. Learn: rewrite and tone alternatives as the free hook. Avoid: its data disclosure list.
- **Immersive Translate** (3M users, Pro $14.99/mo, Max $39.99/mo, token-metered). Learn: main-content detection, hover-a-paragraph, input-box translate, subtitle and PDF modes. Avoid: cloud-only, quota UX, the 2025-08 snapshot leak.
- **Linguist** (BSD-3, strongest open-source privacy option). Learn: hash-verified downloads. Avoid: cloud default, single S3 model host, no bilingual view. Issue #603 (Bergamot silent on Brave) reproduced on plain Chrome and was partly user error from an unsupported pair with no error shown.
- **kiss-translator** (GPL-3). Learn: dual inline design, per-URL rules. Avoid: tag loss on the LLM path (#835), zh-TW/zh-CN two-character compare (#708), observer desync after tab switch (#742), duplicate injection in iframes (#730).
- **TWP** (MV2, 557k Firefox DAU) and **translatelocally-web-ext** (MV2). Learn: TWP's popup polish; as-you-type translation. Avoid: Svelte placeholder text-node wrapping (TWP #393), node-identity destruction on YouTube (#12), bfcache stale detection (#17), models lost on restart (#55).
- **Simple Translate.** Avoid: selection firing a network request with no click (#228, passwords sent to Google), popup injected into TinyMCE and saved into published content (#342).
- **Lingvanex.** Its Chrome page claims local translation while its extensions page says offline is not provided; the 2.12 MiB payload cannot hold models. A citable contradiction.
- **TransOver and Mouse Tooltip Translator.** Learn: configurable hover delay for learners; tooltip translation inside PDFs.
- **Local LLM tools** (NativeMind, offline-browser-translate, TranslateGemma wrappers). Quality within 1 to 2 COMET of DeepL needs 24B+ parameters (arXiv 2605.31452); WMT25 compression shows sub-3 GB models collapse. Not a Bergamot substitute in a browser.

## Reported Issues

Glossa's tracker has no issues, PRs, or discussions as of 2026-09-10. Defects below come from a local probe (a 20-case fixture run against `dist/chrome-smoke` on Chromium 153) and from `web-ext lint` on `dist/firefox`.

Verified bugs at HEAD `a6cce06`:
- Inline wrapper with block descendants is treated as one unit: `<div id=cards><a><div>…</div></a></div>` sends the whole grid as HTML and bilingual mode appends a second copy of every card and anchor. `src/content/segmenter.ts` `isContainer` checks direct children tag names only.
- `hidden` removed, `<details>` opened, text node edited, or `lang` flipped after translation: nothing happens, or a stale translation stays under new text. `src/content/content.ts` `startObserver` watches `childList` only; `checkVisibility` is evaluated once at collection.
- An element the page re-renders in place keeps `data-glossa-unit` and is skipped forever (`shouldSkip`, `segmenter.ts` line 123).
- Same-origin iframes untranslated: `ensureContentScript` in `background.ts` injects the top frame only.
- `title`, `placeholder`, `alt`, `aria-*`, `<option>` labels, and `document.title` untranslated.
- URL rendered as `https://example.com/ruta? x=1`; `nombre@ejemplo.com` became `name@example.com`. No protection for URLs, emails, or bare numbers (Bergamot renders bare digits as `5 5`, mozilla/translations #600).
- An Arabic `lang="ar"` paragraph on a Spanish page was sent through the es→en route.
- Case mismatch: `segmenter.ts` line 19 holds `[translate="no" i]`, `renderer.ts` line 62 repairs spacing with case-sensitive `[translate='no']`.
- `web-ext lint`: `MISSING_DATA_COLLECTION_PERMISSIONS` (mandatory for new AMO submissions since 2025-11-03) and two `UNSUPPORTED_API` warnings because the Firefox bundle carries the Chrome offscreen calls.
- Catalog: `filter_expression` is stored but never evaluated. Desktop picks the Android `base-memory` 3.1 record over the desktop `base` 3.0 record for en→ko, en→ru, ja→en, ko→en, zh-Hans→en; nightly-only 3.0a1 pairs (az, be, bs, nb, nn) are offered; `nn`, `az`, `be` have no display name in `src/shared/languages.ts`.
- Settings persisted and never read: `siteRules`, `neverTranslateLanguages`, `selectionPopup`, `catalogRefreshHours`; `skipFormFields` is hardcoded `true` in `content.ts` lines 160 and 279.

Feature demand with evidence: show original without reload and keep the original visible are the top-voted Firefox Translations bugs (1831768, 1846698; Glossa already does both); attribute translation (translatelocally #69, bergamot #314); download progress (Bugzilla 1836465); scattered pop-in of batches (translatelocally #26); per-URL language memory and auto-translate rules (linguist #38, #117, #527; kiss #516, #958); language mis-detection is the highest-volume live Firefox complaint (meta 2069562, five new bugs in the week before 2026-09-10).

Judged not actionable: Linguist #603 (never diagnosed, reporter absent); Brave service-worker inactivity after restart (brave-browser #45338, no root cause); Opera keeping MV2 (no Glossa impact).

## Security, Privacy, and Reliability

- The engine binary is bundled and hash-gated at build (`tools/build.mjs`), so the Chrome remote-code policy that names WASM does not apply; model weights are fetched as data. Residual store-review risk: no primary source rules on ML weights; pre-empt in listing notes.
- Every downloaded file is verified against the catalog's decompressed hash (`src/engine/model-store.ts` `downloadRecord`). Cached bytes are not re-checked on load; a cheap size check would catch a truncated cache entry before it aborts the WASM.
- Translated HTML is parsed inert and imported; scripts, `on*` handlers, and `javascript:` URLs are stripped (`src/content/renderer.ts` `parseFragment`). Trusted Types safe (YouTube enforces it; immersive-translate #4015 died on it).
- The selection popover is appended to `document.documentElement`; simple-translate #342 shows a popup inserted inside an editor gets saved into content. The popover must never land inside a `contenteditable` host.
- No SIMD detection: pre-SSE4 CPUs get `CompileError: Wasm SIMD unsupported` (bergamot #418); Chromium's "disable V8 optimizer" content setting also disables WASM (brave-browser #36187). Detect per session and never cache the result (Firefox 149 regression, Bugzilla 2019140).
- Worker failure handling: any HTML parse error inside Bergamot aborts the whole service with no exception path (bergamot #316); `engine-host.ts` `onerror` rejects all pending calls and drops route state, with no restart or retry.
- Downloads: no cancel, retry, resume, or single-flight lock; the popup and options page can start the same pair twice; `cdnRefusedAt` is remembered for seven days with no reset control.
- Engine memory is never released: no idle unload, worker never terminated, offscreen document never closed. Firefox tears an engine down 15 s after last use.
- Firefox stores the pathed GCS host permission as the bare host (`storage.googleapis.com/*`); a temporary install grants no host permissions at all; `permissions.request` must run synchronously inside a click handler.
- `SharedArrayBuffer` is unavailable in Firefox extension pages (Bugzilla 1673477 reopened) and needs COOP/COEP manifest keys in Chrome; `WebAssembly.mozIntGemm` requires a system principal (`WasmFeatures.cpp`). Glossa will always be slower than Firefox's built-in translator; say so in the README.
- Dependencies: 0 advisories on the lockfile (`npm audit`, 2026-09-10); happy-dom's five historical RCE-class CVEs are all below the 20.14.3 pin; TypeScript 7 is blocked by typescript-eslint's `<6.1.0` peer range (typescript-eslint #12518) until TS 7.1's programmatic API lands.

## Architecture Assessment

- `src/content/segmenter.ts`: `isContainer` must recurse and use computed `display` like Firefox's `getIsBlockLike`; the `closest('[translate="no" i]')` fallback is dead code at the Chrome 116 and Firefox 128 floors since the `translate` IDL property shipped everywhere in March 2023.
- `src/content/content.ts`: the observer needs `attributes` with an `attributeFilter` (`hidden`, `open`, `lang`, `dir`, plus translatable attributes), `characterData`, and a pause-around-own-writes guard; state should be keyed by node identity with the unit marker cleared when children are replaced.
- `src/content/renderer.ts`: G-04's in-place approach should follow Firefox's id-stamping `merge()`, not engine alignments; bergamot #298 and #362 show alignments attach to tag-plus-token ranges and Bugzilla 1844096 shows pivot alignment duplicating linked words.
- `src/engine/engine-host.ts`: lacks idle unload, worker restart, request cancellation (translatelocally #73: five hops, no `AbortSignal`), and per-session capability detection. `Response.getTranslatedSentence(i)` byte ranges exist in the v0.6.0 embind surface and would allow per-sentence progressive rendering.
- `src/shared/catalog.ts`: evaluate `filter_expression` against a fixed environment; document the version ladder from `TranslationsParent.sys.mjs` L764-791.
- `src/background/background.ts`: the Firefox bundle carries offscreen calls behind a runtime branch; an esbuild `define` per target would strip them and silence the linter.
- Tests: no unit coverage for `model-store.ts` (406 fallback, hash mismatch, partial download) or `engine-host.ts`; the smoke asserts neither the hidden reveal nor a pivot route nor replace mode; `tests/compression.test.ts` asserts `zstdBackend() === "fzstd"` unconditionally and inverts the day Node adds zstd to `DecompressionStream`.
- Docs: README omits the speed gap versus Firefox and the quality gap versus Google (Bergamot averages 4.0 COMET22 below Google across 105 Release pairs in Mozilla's eval DB and is never ahead; weakest pairs en-mr, en-hi, mr-en, en-ar, en-te, en-th). No CONTRIBUTING, SECURITY, or store privacy page.

## Rejected Ideas

- WASM threads via SharedArrayBuffer: impossible in Firefox extension pages (Bugzilla 1673477), needs COOP/COEP keys in Chrome, and the shipped build is single-threaded anyway.
- `WebAssembly.mozIntGemm`: system-principal only (`js/src/wasm/WasmFeatures.cpp`, Bugzilla 1746631).
- fastText language identification (previous G-14): Firefox dropped fastText for in-tree CLD2 (Bugzilla 1861516); `browser.i18n.detectLanguage` already gives CLD2 on both browsers; the `translations-identification-models` record is a 2023 leftover.
- Quality estimation scores: no `getQualityScores` in the v0.6.0 embind surface; Firefox ships `qualityScores: false`; bergamot #361 shows the scores are wrong with `skip-cost`.
- Native `DecompressionStream("zstd")`: not in the WHATWG spec; Firefox pref off on every channel; keep fzstd.
- Engine alignment as the basis for in-place rendering: bergamot #298, #362; Bugzilla 1844096.
- Find-bar eager mode (Firefox L1703): extensions cannot observe the find bar.
- Local LLM engines in-extension: no sub-1B model closes the gap (TranslateGemma's smallest is 4B; WMT25 compression findings).
- Chrome Translator API as baseline: Window-only, desktop-only, 22 GB disk and 4 GB VRAM gate; it stays an opt-in second engine (G-06).
- Keyboard shortcuts (linguist #117, kiss #516 requests): house rule, click-only controls.
- Telemetry or crash reporting for observability: contradicts the product promise; readable local error copy (G-28) and the options page's model list are the diagnostics surface.
- Multi-user or sync features: a single-profile browser extension; settings stay in `storage.local` by design.

## Sources

Reference implementation
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/content/translations-document.sys.mjs
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/content/translations-engine.sys.mjs
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/content/translations-engine.worker.js
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/actors/TranslationsParent.sys.mjs
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/docs/resources/01_overview.md
- https://github.com/mozilla/translations/tree/main/inference/wasm/bindings

Catalog, models, quality
- https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records
- https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm-v2/records
- https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json
- https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/db.sqlite
- https://mozilla.github.io/translations/final-evals/
- https://arxiv.org/html/2605.31452v1
- https://www2.statmt.org/wmt25/model-compression.html

Platform and store policy
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- https://developer.chrome.com/docs/webstore/program-policies/privacy
- https://developer.chrome.com/blog/cws-policy-updates-2026
- https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation
- https://developer.chrome.com/docs/ai/translator-api
- https://webmachinelearning.github.io/translation-api/
- https://github.com/mozilla/standards-positions/issues/1015
- https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
- https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/
- https://extensionworkshop.com/documentation/publish/source-code-submission/
- https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/
- https://github.com/mozilla/addons-linter/blob/master/src/const.js
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/parent/ext-backgroundPage.js
- https://searchfox.org/firefox-main/source/toolkit/components/extensions/parent/ext-i18n.js
- https://bugzilla.mozilla.org/show_bug.cgi?id=1861516
- https://bugzilla.mozilla.org/show_bug.cgi?id=1673477
- https://bugzilla.mozilla.org/show_bug.cgi?id=1625130
- https://raw.githubusercontent.com/mozilla-firefox/firefox/main/js/src/wasm/WasmFeatures.cpp
- https://compression.spec.whatwg.org/
- https://github.com/mdn/browser-compat-data/blob/main/api/DecompressionStream.json
- https://html.spec.whatwg.org/multipage/dom.html#the-translate-attribute
- https://playwright.dev/docs/chrome-extensions
- https://github.com/typescript-eslint/typescript-eslint/issues/12518
- https://github.com/advisories/GHSA-6q6h-j7hj-3r64

Competitor trackers and Bugzilla
- https://github.com/translate-tools/linguist/issues/603
- https://github.com/fishjar/kiss-translator/issues/730
- https://github.com/FilipePS/Traduzir-paginas-web/issues/393
- https://github.com/jelmervdl/translatelocally-web-ext/issues/69
- https://github.com/jelmervdl/translatelocally-web-ext/issues/17
- https://github.com/sienori/simple-translate/issues/342
- https://github.com/browsermt/bergamot-translator/issues/316
- https://github.com/browsermt/bergamot-translator/issues/418
- https://github.com/browsermt/bergamot-translator/issues/298
- https://github.com/browsermt/bergamot-translator/issues/337
- https://github.com/mozilla/translations/issues/945
- https://github.com/mozilla/translations/issues/600
- https://bugzilla.mozilla.org/rest/bug?product=Firefox&component=Translations&resolution=---
- https://bugzilla.mozilla.org/show_bug.cgi?id=1844096
- https://bugzilla.mozilla.org/show_bug.cgi?id=1901177
- https://bugzilla.mozilla.org/show_bug.cgi?id=1902352
- https://bugzilla.mozilla.org/show_bug.cgi?id=2019140
- https://bugzilla.mozilla.org/show_bug.cgi?id=2069562
- https://github.com/brave/brave-browser/issues/36187

Commercial and adjacent
- https://www.chromium.org/developers/design-documents/translate/
- https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api
- https://support.apple.com/guide/safari/webpage-translation-in-safari-on-mac-ibrw6ea421e3/mac
- https://www.deepl.com/en/chrome-extension
- https://immersivetranslate.com/docs/MEMBERSHIP-TERMS/
- https://lingvanex.com/products/all-extensions/
- https://github.com/mozilla/readability
- https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
- https://www.wcag.com/developers/3-1-2-language-of-parts/
- https://github.com/kiwix/kiwix-android/issues/2093

## Open Questions

- Answered 2026-09-10 on Chrome 152 (headless, CDP-loaded extension): yes, the offscreen document gets `Translator`. Its availability is per origin, and the extension origin reports "available" once any extension page (the popup, from a click) has created a translator for the pair. After that the offscreen document creates one with no gesture, and HTML fragments come back with their inline tags, attributes and entities intact. A content script is the wrong host: it answers for the page's origin, which keeps reporting "downloadable" and throws NotAllowedError without a gesture in the page. G-06 shipped on that design.
- Does a signed (non-temporary) Firefox install on 128 ESR grant the manifest host permissions at install, and does the GCS pattern widen there too? Needs the signed build from G-05.
- Does Brave with default shields load the engine, and does the "disable V8 optimizer" content setting explain Linguist #603? Needs a Brave smoke run.
- Will AMO or Chrome Web Store reviewers treat runtime-fetched model weights as remote code? No primary source answers it; only a submission does.

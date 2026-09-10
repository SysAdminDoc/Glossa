# Research — Glossa
Date: 2026-09-10 — replaces all prior research.

## Executive Summary

Glossa is a Chrome and Firefox MV3 extension that translates pages fully on-device with the Bergamot engine (Mozilla's Marian NMT WebAssembly build, MPL-2.0) and Mozilla's model catalog. The research established three things. First, Bergamot is the only on-device engine that is cross-browser, permissively licensed, small enough to ship (about 22 MB compressed per direction), and built for HTML: transformers.js models are larger and its best multilingual model is non-commercial, local LLMs are too slow for whole pages, and Firefox exposes no extension API to its own translator. Second, no existing extension makes offline the default: Linguist, the closest competitor, ships with a cloud engine selected and has been silently broken on Brave since April 2026. Third, the incumbents users love are dying of MV2 (TWP, 557k daily Firefox users) or have earned distrust (Immersive Translate's 2025 snapshot leak, closed source, subscriptions).

Top opportunities in priority order:
1. Offline by default with no cloud code path at all, and no host permission for websites.
2. Bilingual inline display combined with a local engine, which no Bergamot-based extension offers today.
3. MV3-native on both browsers while the incumbents are stuck on MV2.
4. A provable network story: three Mozilla-operated model locations in the manifest and nothing else, with a self-hosted mirror option later.
5. Layout safety: block-level segmentation, `translate="no"`, code and form fields untouched, shadow DOM and dynamic content covered.
6. Chrome's built-in Translator API as an opt-in second engine (almost unused by open-source extensions).
7. Selection, input-field, and glossary features that trackers ask for repeatedly.

## Product Map

- Core workflows: translate the current page (bilingual or replace), show original, translate a selection, manage downloaded models, per-site rules.
- Personas: privacy-conscious readers who distrust vendor translators; language learners who want the original kept; people on Brave, Firefox, or corporate machines where cloud translation is blocked.
- Platforms: Chromium 116+ (offscreen document hosts the engine), Firefox 128+ (event page hosts it). Firefox for Android is a later target.
- Integrations and data flow: content script → background → engine worker; models from Mozilla Remote Settings (`translations-models-v2`), engine binary bundled from `translations-wasm-v2` v4.0. No other network.

## Competitive Landscape

- **Linguist** (translate-tools/linguist, BSD-3, 1,060 stars, 13.6k AMO daily users). Offline Bergamot exists but is opt-in; default is a cloud "AutoTranslator". Solved MV3 with an offscreen sandbox. Learn: hash-verified model download, Netflix subtitles, TTS. Avoid: cloud default, single S3 model host with no mirror, Bergamot silently failing on Brave (#603), no bilingual view.
- **kiss-translator** (GPL-3, 12.4k stars). Best UX in open source: dual inline, hover, inputs, YouTube subtitles. Local paths are Chrome's Translator API and Ollama only. Learn: the dual-inline design and per-site selector rules. Avoid: 30 engines and a cloud default; GPL would constrain reuse.
- **TranslateLocally for Firefox** (MPL-2, MV2). The Mozilla add-on's fork. Learn: as-you-type translation. Avoid: MV2, model download lost after restart (#55), English-only UI.
- **TWP / Translate Web Pages** (MPL-2, 557k AMO DAU, MV2). Polished page translation on Google/Bing/Yandex. Its users are the ones displaced by Chromium 150 removing MV2. No local option.
- **Simple Translate** (MPL-2, 245k AMO DAU). Hardcoded Google endpoint with an embedded key. Self-hosted backend request open since 2021 (#293).
- **Immersive Translate** (closed source, 18.8k stars on an issues-only repo). Defines the bilingual standard. Mandatory sign-in, quotas, and a 2025-08 public-bucket leak of user page snapshots. This is the privacy argument in one paragraph.
- **NativeMind, Margin Read, ImmerseFree, quick-read-translator**: bring-your-own local LLM (Ollama, LM Studio). Good for power users, too slow and inconsistent for whole pages; keep as a later optional endpoint.
- **Firefox built-in Translations**: the reference implementation. About 52 languages, CJK since 2025-08. Open bugs on `translate="no"`, shadow DOM, `lang` mutations, download management, and "show original without reload" (highest-voted). Every one of those is a checklist item for Glossa.
- **Chrome built-in Translator API** (Chrome 138+, Edge 148+): on-device, desktop only, not in workers, needs user activation for the first download, packs come from Google. Good opt-in second engine, never the baseline.

## Reported Issues

Glossa has no tracker yet. The relevant reports live in competitor trackers and Bugzilla and are cited in the roadmap: Linguist #603, #611, #612, #620; translatelocally #5, #55, #63; kiss-translator #670; TWP #904, #1028; Simple Translate #293; Bugzilla 1831768, 1846698, 1969828, 1842820, 1855260.

## Findings from the first build (2026-09-10)

- Mozilla's Remote Settings attachment CDN (`firefox-settings-attachments.cdn.mozilla.net`, Varnish) returns `406 Not Supported` to any request whose User-Agent contains "Chrome", for every collection. curl with a Firefox or blank agent gets 200. `fetch` cannot override the User-Agent from an extension page. Verified live; see `src/engine/model-store.ts`.
- Mozilla's model registry bucket (`storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json`, linked from the archived `firefox-translations-models` README) serves every browser and holds the same exported files as gzip. For es-en, en-es and ja-en the decompressed SHA-256 of model, vocab and shortlist match the Remote Settings records exactly; 118 of 124 catalog model records have a registry match, the six misses are superseded versions plus ur-en and nb-en.
- Chrome's offscreen document has no `chrome.storage`; only `runtime` and a few others. Cache API is available there and `Cache.put` refuses `chrome-extension:` keys.
- Chrome 153 exposes a `browser` alias in extension pages, so `typeof browser` no longer identifies Firefox.
- Bergamot's HTML mode copies `code`, `kbd`, `samp`, `var`, `math` verbatim (`inference/src/translator/html.h`, `ignoredTags`) but drops the whitespace around them, and has no notion of `translate="no"`.

## Security, Privacy, and Reliability

- Engine binary ships in the package; WASM fetched at runtime would count as remote code under store policy. Pinned by two SHA-256 hashes in `vendor/bergamot/engine.lock.json`.
- Model files are verified against the compressed and decompressed hashes published in the catalog before they are stored (`src/engine/model-store.ts`).
- Translated HTML never goes through `innerHTML` on the live page: it is parsed inert, scripts and `on*` handlers stripped, then nodes are imported (`src/content/renderer.ts`). This also survives Trusted Types policies.
- Chrome's offscreen document has no `chrome.storage`; all engine-side persistence uses the Cache API with `https://store.glossa.invalid/...` keys (Cache.put refuses `chrome-extension:` URLs).
- Missing guardrails: no Firefox permission recovery (G-02), no idle model unload (G-13), no check that SIMD is available before loading the engine (a hard failure on very old CPUs should be a readable error), and Chromium users' model downloads touch Google's edge (G-09 mirror).
- Recovery: "Show original" restores exact child nodes; a half-finished download is never listed as installed because the cache is checked, not the manifest.

## Architecture Assessment

- `src/shared/catalog.ts` is pure and unit-tested; engine selection lives in `planRoute`.
- `src/engine/engine-host.ts` is the seam for a second engine (G-06, G-15): extract an `Engine` interface with `translate(source, target, fragments)` and `routeStatus`.
- `src/content/renderer.ts` re-parses engine HTML; the alignment-based in-place approach (G-04) is the biggest quality improvement available.
- Test gaps: Firefox smoke (G-01), layout regression fixtures (G-12), a worker-level test that loads the WASM in Node (possible: the glue supports Node) to catch glue/binary drift without a browser.
- Docs: README carries install and privacy; vendor/bergamot/README.md carries the engine update procedure.

## Rejected Ideas

- transformers.js as the engine: `opus-mt` quantized encoder alone is larger than a whole Bergamot pair; NLLB-200 is CC-BY-NC; default model resolution hits huggingface.co. (Hugging Face model cards, transformers.js v4 release notes.)
- WebLLM in-extension: multi-GB downloads, GPU-bound, no HTML alignment. (WebLLM docs.)
- Firefox `browser.trial.ml`: Nightly-gated, unstable across majors, no translation task, no access to the real Translations component. (Firefox source docs, WebExtensions AI API page.)
- Any cloud engine, even as a fallback: the product promise is that there is nothing to leak.
- Keyboard shortcuts: house rule, click-only controls.
- Bundling models in the package: AMO's 200 MB cap and a full review on every model update. Download on first use instead.

## Sources

Engine and models
- https://github.com/mozilla/translations
- https://github.com/mozilla-firefox/firefox/tree/main/toolkit/components/translations
- https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm-v2/records
- https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records
- https://firefox-source-docs.mozilla.org/toolkit/components/translations/resources/03_bergamot.html
- https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html

Platform APIs
- https://developer.chrome.com/docs/ai/translator-api
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy
- https://github.com/WICG/translation-api

Competitors
- https://github.com/translate-tools/linguist
- https://github.com/fishjar/kiss-translator
- https://github.com/jelmervdl/translatelocally-web-ext
- https://github.com/FilipePS/Traduzir-paginas-web
- https://github.com/sienori/simple-translate
- https://github.com/immersive-translate/immersive-translate
- https://github.com/NativeMindBrowser/NativeMindExtension
- https://github.com/LibreTranslate/LibreTranslate

Community signal
- https://news.ycombinator.com/item?id=33792447
- https://bugzilla.mozilla.org/buglist.cgi?product=Firefox&component=Translations&resolution=---
- https://stable-learn.com/en/immersive-translate-2025-security-incident/
- https://www.privacyguides.org/en/language-tools/
- https://discuss.privacyguides.net/t/translation-software-services/12645

## Open Questions

- Does Firefox's `i18n.detectLanguage` return usable results on Firefox 128+ ESR, or does G-14 need to land before Firefox detection is trustworthy? Needs a live run (G-01).
- Whether Brave's WASM SIMD path behaves like Chrome's for this engine, given Linguist's open Brave bug. Needs a Brave smoke run.

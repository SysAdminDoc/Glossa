# Roadmap

Open work only. Items come from the 2026-09-10 research pass (see RESEARCH.md) and from what the first scaffold left unfinished. Ordered by priority, then by root-cause fixes before polish.

## P0

- [ ] G-01 — Firefox smoke test
  Why: the Firefox build is wired (event page hosts the engine, no offscreen) but nothing has run it. `browser.scripting.executeScript` with activeTab, `i18n.detectLanguage`, and Cache storage from the background page all need one real pass.
  Evidence: tests/smoke covers Chromium only; MDN lists `i18n.detectLanguage` for Firefox but the research pass marked it "verify before relying on it".
  Touches: tests/smoke/firefox.smoke.mjs (new), src/background/background.ts, package.json
  Acceptance: `npm run smoke:firefox` translates tests/fixtures/es.html through the popup in a headless Firefox launched by Playwright, with the same assertions as the Chromium smoke.
  Complexity: M

- [ ] G-02 — Explain and recover a missing model-host permission on Firefox
  Why: Firefox MV3 treats `host_permissions` as optional. If a user declines them at install, every model download fails with a bare fetch error.
  Evidence: MDN manifest `host_permissions` notes for Firefox 127+; src/engine/model-store.ts has no permission check.
  Touches: src/engine/model-store.ts, src/popup/popup.ts, src/options/options.ts
  Acceptance: when `permissions.contains` for the two hosts is false, the popup shows a one-line reason and a button that calls `permissions.request` in the click handler; a download then succeeds without a reload.
  Complexity: S

- [ ] G-03 — Auto-translate for sites with an "always" rule
  Why: the options page already collects per-host rules but nothing acts on "always". Users who set a rule expect the page to change on load.
  Evidence: src/shared/settings.ts `siteRules`; research signal ranks per-site rules as table stakes.
  Touches: src/background/background.ts (tabs.onUpdated + `permissions.contains("<all_urls>")` gate), src/options/options.ts (request the optional permission when the first "always" rule is added)
  Acceptance: with the optional all-sites permission granted and a rule for a host, navigating to that host translates the page without a click; without the permission the options page explains what is missing.
  Complexity: M

## P1

- [ ] G-04 — Keep original inline elements in place instead of re-parsing translated HTML
  Why: the renderer replaces a unit's children with nodes parsed from the engine's HTML output. Event listeners on inline elements (React links, buttons inside paragraphs) are lost until restore.
  Evidence: src/content/renderer.ts `parseFragment`; Firefox's translations-document.sys.mjs moves the original nodes using the engine's alignment data instead.
  Touches: src/content/renderer.ts, src/engine/bergamot.worker.ts (return alignment), src/content/segmenter.ts
  Acceptance: a paragraph containing a link with a click listener still fires that listener after translation in replace mode; the smoke test asserts it.
  Complexity: L

- [ ] G-05 — Signed Firefox build for permanent installs
  Why: temporary add-ons vanish when Firefox closes. AMO unlisted signing is automated and needs no public listing.
  Evidence: README install section; Astra-Deck 2026-09-04 research confirmed unlisted signing works without a listing.
  Touches: tools/release-firefox.mjs (new, web-ext sign or the AMO API), README.md
  Acceptance: the release carries a signed `.xpi` that installs from `about:addons` and survives a restart.
  Complexity: M

- [ ] G-06 — Chrome built-in Translator API as an optional second engine
  Why: on Chrome 138+ and Edge 148+ the on-device Translator API needs no model download from a third party and covers a few languages Bergamot lacks. It must stay opt-in: the packs come from Google's component updater.
  Evidence: research pass section 2; Linguist issue #611 asks for the same.
  Touches: src/engine/ (new engine interface with Bergamot and Chrome implementations), src/engine/offscreen.ts (the API is unavailable in workers and needs user activation for the first download), src/options
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
  Touches: tests/fixtures (Wikipedia, MDN, GitHub, Hacker News snapshots), tests/smoke
  Acceptance: each fixture translates with no horizontal overflow and no element moving more than a set threshold, measured by Playwright.
  Complexity: M

- [ ] G-13 — Memory ceiling and route eviction tuning
  Why: two loaded routes plus the WASM heap can pass 300 MB. There is no telemetry, so the ceiling has to be measured locally.
  Touches: src/engine/bergamot.worker.ts (MAX_LOADED_ROUTES, unload after idle), docs
  Acceptance: an idle timer unloads models after a configurable period and the measured peak on the fixture set is documented in README.
  Complexity: S

- [ ] G-14 — Language detection with the fastText model Firefox ships
  Why: `i18n.detectLanguage` is CLD3 on Chrome and unverified on Firefox. Mozilla publishes a 1 MB fastText WASM plus a language ID model in the same Remote Settings collection.
  Touches: src/engine (second worker or same worker), src/background/background.ts
  Acceptance: detection works identically on both browsers with no browser API involved.
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
  Why: nothing offline works on mobile today. Firefox Android supports MV3 extensions and the engine needs SIMD, which recent phones have.
  Acceptance: the Firefox build installs on Firefox Android and translates the fixture.
  Complexity: L

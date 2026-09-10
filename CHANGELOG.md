# Changelog

All notable changes to Glossa are recorded here. Dates are ISO (YYYY-MM-DD).

## [Unreleased]

### Added
- Text that is not in the page's body is translated too: the tab title, tooltips, image descriptions, placeholders, aria labels and the labels of a dropdown. A dropdown keeps submitting the value it submitted before, and everything goes back exactly as it was when you show the original.
- Every release now carries a source archive, and the packages are byte-reproducible from it: the same source and the same commands produce ZIPs with the same SHA-256 as the published ones. `npm run verify:source` checks that by unpacking the archive and rebuilding.
- The README explains, for a store reviewer, what each permission is for, why the model files are data rather than remote code, and how to rebuild the package.

## [0.3.0] - 2026-09-10

### Added
- The engine lets go of its models after fifteen seconds of quiet, and on Chrome the hidden document that hosts it closes too, so an idle browser is not holding a few hundred megabytes.
- A processor that cannot run the engine is reported plainly ("this computer's processor lacks the SIMD instructions the engine needs") before anything is downloaded, instead of failing with a stack trace.
- A translation whose engine dies mid page is retried once on a fresh engine rather than ending the page.
- Selecting text can offer a translation on the spot. The offer is a small button next to the selection, it takes no focus away from what you selected, and it only appears if you turn it on in the options page.
- The selection popover closes with Escape, keeps clear of the text it is explaining, has a close button big enough to hit, and stays outside the page's own editors so it can never be saved into a document you are writing.
- Accessibility: every translation says which language and direction it is in, the popup and options pages announce their status and progress to a screen reader, and both pass an axe check with no violations. In bilingual mode the added copy is kept out of the accessibility tree where it holds nothing focusable, so a screen reader does not read every block twice.
- Replace mode keeps the page's own links and buttons instead of rebuilding them, so anything the page had attached to them still works after a translation. Restoring puts each one's original text back.
- Model downloads survive a bad connection: a dropped transfer picks up where it stopped instead of starting the whole file again, and a download can be cancelled from the options page. Two pages asking for the same language share one download, and a download that would not fit is refused before it starts with the numbers to explain why.
- The options page can send downloads back to Mozilla's CDN after it has fallen back to the bucket.
- Language detection only looks at prose now. A page of numbers, dates or links is reported as undetectable and left alone instead of being guessed at, and a language you choose by hand is remembered for that site.
- A site with an "always" rule translates itself when you open it, with no click. Glossa asks for access to that site when you add the rule, and the rule stays inert until you allow it.

## [0.2.1] - 2026-09-10

### Added
- Firefox: when the model hosts are not allowed, the popup says so and offers a button that asks for them. Downloads work straight after, with no reload. This is what you see if you switch those hosts off in `about:addons`.

### Fixed
- The engine no longer shuts itself down in the middle of a translation. A first translation that spends more than fifteen seconds downloading and loading a model used to be killed by its own idle timer and left the extension unable to translate anything until the browser restarted.
- Pages in Japanese, Chinese, Korean, Hindi, Thai and Arabic are detected again. Measuring "enough text to judge" in letters made every one of those scripts look like an empty page, which fell back to whatever the page's own `lang` said and, on a page built from an English template, blocked translation entirely.
- A language chosen by hand no longer overrides a confident detection, so a host that serves several languages is not stuck on whichever one was chosen first, and picking "Detect automatically" clears the choice again.
- An "always" site rule uses the language chosen for that site.
- A site rule typed with a port or a non-ASCII name is stored the way the browser spells it, so it actually matches, and a rule that is waiting for site access says so in the table.
- The second engine crash on a page is recovered like the first instead of abandoning the rest of the page.
- The permission notice appeared in the popup for everyone, including people who had already allowed the model hosts. A stylesheet rule was overriding the attribute that hides it.

## [0.2.0] - 2026-09-10

### Added
- An option to offer Mozilla's prerelease language models (Azerbaijani, Belarusian, Bosnian, Norwegian, Nynorsk), off by default because Firefox ships them to its nightly channel only.

### Changed
- The Firefox build declares that it collects no data, which Mozilla requires of every new add-on submission, and its minimum Firefox version is now 142 (the release where that declaration is understood on both desktop and Android).
- The Firefox build no longer carries any Chrome-only code. The offscreen-document branch is cut at build time, so `web-ext lint` reports no errors, warnings or notices.

### Fixed
- Card grids and other link-wrapped blocks (`div > a > div`) are walked into instead of being sent to the engine as one unit, so bilingual mode no longer appends a second copy of every card.
- Content revealed after the first pass is picked up: the observer now watches text edits and the attributes that decide whether a block is translatable (`hidden`, `open`, `lang`, `translate`, `aria-hidden`), and re-checks the blocks an earlier pass skipped when a class or style changes.
- A block the page re-renders in place is translated again instead of keeping a stale translation forever, and the old translation goes with it.
- Writes to the page are no longer seen as page changes by the extension's own observer, so translated text is never fed back to the engine.
- Restore puts back a `lang` attribute the page set itself instead of deleting it.
- The engine is never handed its own output. Text it produced on the page is remembered for ten minutes, so a page that copies a finished translation into a new element does not get that text translated a second time.
- Web addresses, email addresses and long reference numbers inside a sentence come back exactly as they went in. The engine used to put a space inside a query string and translate the domain part of an address.
- The model catalog's own platform gates are respected. A desktop browser was picking the Android build of the Japanese, Korean, Chinese and Russian models, and prerelease models were offered as if they had shipped. Norwegian Nynorsk now has a display name instead of showing as `nn`.
- A block that declares its own language is translated with that language's model, or left alone when the model is not installed. An Arabic quotation on a Spanish page used to be pushed through the Spanish model and came back as nonsense.
- Every setting on the options page now changes what the extension does. A "never" rule keeps Glossa off that site entirely and says so in the popup, a page in a language you read is not offered, the editable-field skip is honoured, and the catalog refresh uses the interval you set.
- A protected run of text keeps its exact spacing. A version number like `v1.2.3` is no longer spaced out, and a url in brackets stays tight against them.
- One block's protected text no longer switches protection off for the next block, which happened whenever a block's only text sat inside `<code>`.
- A footnote or tooltip block nested inside a link no longer splits the sentence around it into fragments.
- A block the page re-renders gets its original language back, so it is offered for translation again instead of looking like it is already translated.
- When the engine fails, every block it did not reach is released instead of being skipped for the rest of the page's life.
- A change the page makes while a translation is being written to the page is no longer lost.

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

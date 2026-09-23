import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// The user's glossary: a term comes through a translation exactly as written, or always as the
// user's own translation, whatever the engine would have made of it.

const window = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.Node = window.Node;
globals.Element = window.Element;
globals.ShadowRoot = window.ShadowRoot;
globals.Document = window.Document;
globals.DocumentFragment = window.DocumentFragment;
globals.HTMLElement = window.HTMLElement;
globals.DOMParser = window.DOMParser;
globals.NodeFilter = window.NodeFilter;

const { compileGlossary, formatGlossary, parseGlossary, sanitizeGlossary, GLOSSARY_MAX_ENTRIES } = await import("../src/shared/glossary.ts");
const { collectSegments, plainFragment, segmentFragment } = await import("../src/content/segmenter.ts");
const { Renderer } = await import("../src/content/renderer.ts");

const replace = { displayMode: "replace" as const, showOriginalOnHover: false, targetLanguage: "en" };
const bilingual = { displayMode: "bilingual" as const, showOriginalOnHover: false, targetLanguage: "en" };
const PLACEHOLDER = /<var [^>]*data-glossa-hold[^>]*>[\s\S]*?<\/var>/g;

function glossary(text: string) {
  const compiled = compileGlossary(parseGlossary(text));
  assert.ok(compiled, "the glossary compiled to nothing");
  return compiled;
}

function unitOf(html: string, terms: string) {
  window.document.body.innerHTML = html;
  const segment = collectSegments(window.document.body as unknown as Element, { skipFormFields: true, glossary: glossary(terms) }).find(
    (candidate) => candidate.kind === "element"
  );
  assert.ok(segment && segment.kind === "element", "the paragraph is not a unit");
  return segment;
}

// What the engine is asked to translate: the unit with every placeholder's content taken out.
function visible(html: string): string {
  return html.replace(PLACEHOLDER, "").replace(/<[^>]+>/g, "");
}

// Stands in for the engine: translates the words it can see and hands every placeholder back as is.
function engine(html: string, words: Record<string, string>): string {
  let out = html;
  for (const [from, to] of Object.entries(words)) out = out.replace(from, to);
  return out;
}

const byId = (id: string) => window.document.getElementById(id) as unknown as HTMLElement;

test("one entry per line: a bare term is kept, 'term = translation' is replaced", () => {
  assert.deepEqual(parseGlossary("Café Aurora\n\n  plaza mayor = Main Square  \r\nC++\n"), [
    { term: "Café Aurora", translation: "" },
    { term: "plaza mayor", translation: "Main Square" },
    { term: "C++", translation: "" }
  ]);
  // A term given twice keeps its last line, and a line with nothing to match is dropped.
  assert.deepEqual(parseGlossary("Glossa = one\n= orphan\n---\nGlossa = two"), [{ term: "Glossa", translation: "two" }]);
  assert.equal(formatGlossary(parseGlossary("Café Aurora\nplaza mayor = Main Square")), "Café Aurora\nplaza mayor = Main Square");
});

test("a stored glossary is checked like a typed one", () => {
  assert.deepEqual(sanitizeGlossary("Café Aurora"), []);
  assert.deepEqual(sanitizeGlossary([{ term: " Glossa " }, { term: 7 }, null, { term: "x".repeat(101) }]), [{ term: "Glossa", translation: "" }]);
  const many = Array.from({ length: GLOSSARY_MAX_ENTRIES + 20 }, (_, index) => ({ term: `term${index}`, translation: "" }));
  const kept = sanitizeGlossary(many);
  assert.equal(kept.length, GLOSSARY_MAX_ENTRIES);
  assert.equal(kept.at(-1)?.term, `term${GLOSSARY_MAX_ENTRIES + 19}`, "the newest entries were the ones dropped");
});

test("terms match their exact case, as whole words, except in scripts written without spaces", () => {
  const { scanner } = glossary("Rust\n任天堂\nC++\nNew York\nNew York Times");
  const found = (text: string) => text.match(scanner) ?? [];
  assert.deepEqual(found("Rust, rust and Rusty"), ["Rust"]);
  assert.deepEqual(found("x任天堂の新作"), ["任天堂"]);
  assert.deepEqual(found("C++ y C+"), ["C++"]);
  assert.deepEqual(found("the New York Times in New York"), ["New York Times", "New York"]);
});

test("a glossary term reaches the engine as a placeholder and comes back as written", () => {
  const unit = unitOf(`<p id="p">Nuestro patrocinador está en la plaza mayor desde hoy.</p>`, "plaza mayor");
  assert.ok(!/plaza mayor/.test(visible(unit.html)), `the term reached the engine: "${visible(unit.html)}"`);
  new Renderer().apply(unit, engine(unit.html, { "Nuestro patrocinador está en la": "Our sponsor is on the", "desde hoy.": "from today." }), replace);
  assert.equal(byId("p").textContent, "Our sponsor is on the plaza mayor from today.");
});

test("a term with a translation comes back as that translation, and show original puts the term back", () => {
  const unit = unitOf(`<p id="p">La biblioteca abre en la plaza mayor todos los días.</p>`, "plaza mayor = Main Square");
  const renderer = new Renderer();
  renderer.apply(unit, engine(unit.html, { "La biblioteca abre en la": "The library opens on the", "todos los días.": "every day." }), replace);
  assert.equal(byId("p").textContent, "The library opens on the Main Square every day.");
  renderer.restoreAll();
  assert.equal(byId("p").textContent, "La biblioteca abre en la plaza mayor todos los días.");
});

test("a term the page split across an inline tag is held whole, with its tag in the bilingual copy", () => {
  const unit = unitOf(`<p id="p">Nuestro patrocinador es Café <b>Aurora</b>, en la plaza mayor de la ciudad.</p>`, "Café Aurora");
  assert.ok(!/Café|Aurora/.test(visible(unit.html)), `part of the term reached the engine: "${visible(unit.html)}"`);
  new Renderer().apply(unit, engine(unit.html, { "Nuestro patrocinador es": "Our sponsor is", ", en la plaza mayor de la ciudad.": ", in the town's main square." }), bilingual);
  const copy = window.document.querySelector("glossa-translation");
  assert.ok(copy, "no translation was shown");
  assert.match(copy.textContent ?? "", /Our sponsor is Café Aurora, in the town's main square\./);
  assert.equal(copy.querySelector("b")?.textContent, "Aurora", "the page's <b> was lost from the copy");
});

test("an address still wins over a term inside it, and a term next to one is still held", () => {
  const unit = unitOf(`<p>Visita https://rust-lang.org para aprender Rust esta semana.</p>`, "rust\nRust");
  assert.equal(unit.holds.length, 2, `expected the address and the term, held ${unit.holds.length}`);
  assert.equal(visible(unit.html).replace(/\s+/g, " ").trim(), "Visita para aprender esta semana.");
});

test("tooltips and bare text carry the glossary too", () => {
  window.document.body.innerHTML = `<div><img id="i" alt="Fachada de la plaza mayor" src="x.png"><p>Texto.</p>Visita la plaza mayor.<p>Más texto.</p></div>`;
  const compiled = glossary("plaza mayor = Main Square");
  const segments = collectSegments(window.document.body as unknown as Element, { skipFormFields: true, glossary: compiled });
  const alt = segments.find((segment) => segment.kind === "attribute");
  const bare = segments.find((segment) => segment.kind === "text");
  assert.ok(alt && bare, "the alt text or the bare text was not collected");
  for (const segment of [alt, bare]) {
    const fragment = segmentFragment(segment, compiled);
    assert.ok(!/plaza mayor/.test(visible(fragment)), `the term reached the engine: "${fragment}"`);
    assert.match(fragment, /<var [^>]*>Main Square<\/var>/);
  }
  // Bergamot drops the whitespace around a `var` it copies through; the tooltip gets it back.
  const answer = engine(segmentFragment(alt, compiled), { "Fachada de la": "Front of the" }).replace(/\s+(<var)/, "$1");
  assert.match(answer, /the<var/, "the stand-in engine did not drop the space");
  new Renderer().apply(alt, answer, bilingual);
  assert.equal(byId("i").getAttribute("alt"), "Front of the Main Square");
  // Without a glossary the fragment is plain escaped text, as before.
  assert.equal(segmentFragment(alt), "Fachada de la plaza mayor");
});

// Found by the review of 2026-09-23.

test("a block that is only a term with a translation gets the translation, with no trip to the engine", () => {
  window.document.body.innerHTML = `<table><tr><td id="a">martes</td><td id="b">martes 10:00</td><td id="c">Glossa</td></tr></table>`;
  const compiled = glossary("martes = TUESDAY\nGlossa");
  const segments = collectSegments(window.document.body as unknown as Element, { skipFormFields: true, glossary: compiled });
  const units = segments.filter((segment) => segment.kind === "element");
  // The kept term alone has nothing to translate and is left out, as before.
  assert.deepEqual(units.map((unit) => (unit.kind === "element" ? [unit.element.id, unit.local] : null)), [["a", true], ["b", true]]);
  const renderer = new Renderer();
  for (const unit of units) {
    if (unit.kind === "element") renderer.apply(unit, unit.html, replace);
  }
  assert.equal(byId("a").textContent, "TUESDAY");
  assert.equal(byId("b").textContent, "TUESDAY 10:00");
  renderer.restoreAll();
  assert.equal(byId("a").textContent, "martes");
});

test("a term inside an address in a tooltip, a selection or a text box is part of the address", () => {
  const compiled = glossary("rust = óxido");
  assert.equal(plainFragment("https://github.com/rust-lang/rust", compiled), "https://github.com/rust-lang/rust");
  assert.equal(plainFragment("rust@ejemplo.es", compiled), "rust@ejemplo.es");
  assert.match(plainFragment("aprende rust hoy", compiled), /^aprende <var [^>]*>óxido<\/var> hoy$/);
});

test("a term matches whatever whitespace the page puts between its words", () => {
  const { scanner, translationOf } = glossary("plaza mayor = Main Square");
  for (const text of ["en la plaza\n      mayor hoy", "en la plaza\u00a0mayor hoy"]) {
    const found = text.match(scanner) ?? [];
    assert.equal(found.length, 1, `no match in ${JSON.stringify(text)}`);
    assert.equal(translationOf(found[0]!), "Main Square");
  }
});

test("a Latin term is a whole word next to Japanese or Chinese text", () => {
  const { scanner } = glossary("iPhone = アイフォーン");
  assert.deepEqual("新しいiPhoneが出た".match(scanner), ["iPhone"]);
  assert.deepEqual("新しいiPhones".match(scanner), null);
});

test("a term the page ends inside a tag is not a whole word when the next letter follows the tag", () => {
  const unit = unitOf(`<p>Me gusta el <b id="b">Rust</b>y de la tienda y Rust mismo también.</p>`, "Rust = Óxido");
  assert.equal(unit.holds.length, 1, `the page's "Rusty" was held as a term: ${unit.html}`);
  assert.match(unit.html, /<b [^>]*>Rust<\/b>y/);
});

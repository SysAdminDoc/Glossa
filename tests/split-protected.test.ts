import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// A url, address or number the page wrapped partly in an inline tag has to reach the engine as one
// placeholder, not as a protected head and an unprotected tail, and come back byte for byte with
// its tags still in place.

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

const { collectSegments } = await import("../src/content/segmenter.ts");
const { Renderer } = await import("../src/content/renderer.ts");

const options = { skipFormFields: true };
const replace = { displayMode: "replace" as const, showOriginalOnHover: false, targetLanguage: "en" };
const bilingual = { displayMode: "bilingual" as const, showOriginalOnHover: false, targetLanguage: "en" };
const PLACEHOLDER = /<var [^>]*data-glossa-hold[^>]*>[\s\S]*?<\/var>/g;

function unitOf(html: string) {
  window.document.body.innerHTML = html;
  const segment = collectSegments(window.document.body as unknown as Element, options).find((candidate) => candidate.kind === "element");
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

test("a url whose tail the page put in <b> is held whole and comes back byte for byte", () => {
  const unit = unitOf(`<p id="p">Visita https://ejemplo.<b id="tail">es/catalogo</b> antes de venir.</p>`);
  assert.ok(!/ejemplo|catalogo/.test(visible(unit.html)), `part of the url reached the engine: "${visible(unit.html)}"`);
  new Renderer().apply(unit, engine(unit.html, { Visita: "Visit", "antes de venir.": "before you come." }), replace);
  const text = byId("p").textContent ?? "";
  assert.match(text, /^Visit https:\/\/ejemplo\.es\/catalogo before you come\.$/, text);
  assert.equal(byId("p").querySelectorAll("b").length, 1, "the <b> was lost or doubled");
  assert.equal(byId("tail").textContent, "es/catalogo");
});

test("an address split by a <span> survives into a bilingual copy with the span", () => {
  const unit = unitOf(`<p id="p">Escribe a info@ejemplo.<span>es</span> hoy mismo, por favor.</p>`);
  assert.ok(!/info|ejemplo/.test(visible(unit.html)), `part of the address reached the engine: "${visible(unit.html)}"`);
  new Renderer().apply(unit, engine(unit.html, { "Escribe a": "Write to", "hoy mismo, por favor.": "today, please." }), bilingual);
  const copy = window.document.querySelector("glossa-translation");
  assert.ok(copy, "no translation was shown");
  assert.match(copy.textContent ?? "", /Write to info@ejemplo\.es today, please\./);
  assert.ok(copy.querySelector("span"), "the span was lost from the copy");
});

test("a url broken up with <wbr> for line wrapping is one run", () => {
  const unit = unitOf(`<p>Descarga https://ejemplo.es/<wbr>descargas/<wbr>glossa.zip cuando quieras.</p>`);
  assert.ok(!/descargas|glossa\.zip/.test(visible(unit.html)), `part of the url reached the engine: "${visible(unit.html)}"`);
  assert.equal(unit.holds.length, 1, `the url was held in ${unit.holds.length} pieces`);
  assert.match(visible(unit.html), /Descarga\s+cuando quieras/);
});

test("a line break still ends a run: the next line is prose", () => {
  const unit = unitOf(`<p>Visita https://ejemplo.es<br>Siguiente línea del texto.</p>`);
  assert.match(visible(unit.html), /Siguiente línea del texto/, "the line after the break was held with the url");
});

test("a run inside one text node is held exactly as before", () => {
  const unit = unitOf(`<p>Visita https://ejemplo.es/catalogo hoy mismo.</p>`);
  assert.equal(unit.holds.length, 1);
  assert.match(visible(unit.html), /^Visita\s+hoy mismo\.$/);
});

test("a split run the engine repeats does not repeat the page's ids", () => {
  const unit = unitOf(`<p id="p">Visita https://ejemplo.<b id="tail">es/catalogo</b> antes de venir a la biblioteca.</p>`);
  const placeholder = unit.html.match(PLACEHOLDER)?.[0] ?? "";
  assert.ok(placeholder, "no placeholder in the unit");
  new Renderer().apply(unit, `Visit ${placeholder} or ${placeholder} before coming to the library.`, replace);
  assert.equal(byId("p").querySelectorAll("b").length, 2, "the repeat was dropped");
  assert.equal(window.document.querySelectorAll("#tail").length, 1, "the repeat carried the page's id");
  assert.equal(window.document.querySelectorAll("[data-glossa-id]").length, 0, "numbers were left on the page");
});

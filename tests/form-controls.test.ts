import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// Form controls are the page's own live widgets. None of their content may reach the engine, a
// bilingual copy must never hold a second, dead copy of one, and no copy may repeat a page id.

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
const bilingual = { displayMode: "bilingual" as const, showOriginalOnHover: false, targetLanguage: "en" };
const replace = { displayMode: "replace" as const, showOriginalOnHover: false, targetLanguage: "en" };

function load(html: string) {
  window.document.body.innerHTML = html;
  return window.document.body as unknown as Element;
}

// Every segment rendered with an answer that keeps the markup it was given, the way the engine
// does, so what ends up in the page is exactly what the renderer builds from each unit.
function translateAll(body: Element) {
  const segments = collectSegments(body, options);
  const renderer = new Renderer();
  for (const segment of segments) {
    renderer.apply(segment, `EN ${segment.kind === "element" ? segment.html : segment.text}`, bilingual);
  }
  return segments;
}

test("a paragraph holding nothing but a textarea sends nothing and copies nothing", () => {
  const body = load(`<p id="compose"><textarea id="message">Hola, quiero reservar una sala de lectura para el martes.</textarea></p>`);
  const segments = translateAll(body);
  assert.ok(!segments.some((segment) => /reservar/.test(segment.text)), "the field's text went to the engine");
  assert.equal(window.document.querySelectorAll("textarea").length, 1, "the textarea was copied");
  assert.equal(window.document.querySelector("textarea")?.textContent, "Hola, quiero reservar una sala de lectura para el martes.");
});

test("the words around a form control are translated and the control stays the page's own", () => {
  const body = load(
    `<p id="attrs">Consulta los <a id="tip" href="#h">horarios de la biblioteca</a> y elige una sala para tu visita: ` +
      `<select id="room"><option>Sala de lectura</option><option value="infantil">Sala infantil</option></select> ` +
      `<input id="search" type="search" placeholder="Buscar en el catálogo"> ` +
      `<button id="go" type="button">Reservar la sala</button></p>`
  );
  const segments = translateAll(body);
  for (const segment of segments) {
    if (segment.kind === "element") {
      assert.ok(!/<(select|input|textarea|button)\b/i.test(segment.html), `a unit carried a form control: ${segment.html}`);
    }
  }
  const doc = window.document;
  assert.equal(doc.querySelectorAll("select").length, 1, "the select was copied");
  assert.equal(doc.querySelectorAll("input").length, 1, "the input was copied");
  assert.equal(doc.querySelectorAll("button").length, 1, "the button was copied");
  assert.equal(doc.querySelectorAll("#tip").length, 1, "the link's id was repeated");
  const text = doc.body.textContent ?? "";
  assert.match(text, /EN Consulta los/, "the words before the control were not translated");
  assert.match(text, /EN Reservar la sala/, "the button's own label was not translated");
});

test("a bilingual copy keeps its links but never repeats one of the page's ids", () => {
  const body = load(
    `<p id="intro">La biblioteca abre todos los días. Consulta <a id="catalogo" href="#c">el catálogo en línea</a> antes de tu visita.</p>`
  );
  translateAll(body);
  const doc = window.document;
  assert.ok(doc.querySelector("glossa-translation a[href='#c']"), "the link was lost from the translation");
  assert.equal(doc.querySelectorAll("#catalogo").length, 1, "the copy repeated the link's id");
  assert.equal(doc.querySelectorAll("#intro").length, 1);
});

test("an element the engine repeats in replace mode does not repeat the page's id", () => {
  const body = load(`<p id="r">Hola <b id="fuerte">mundo</b> y adiós a todos.</p>`);
  const [segment] = collectSegments(body, options).filter((candidate) => candidate.kind === "element");
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(
    segment,
    'Hello <b id="fuerte" data-glossa-id="0">world</b> and <b id="fuerte" data-glossa-id="0">goodbye</b> everyone.',
    replace
  );
  const doc = window.document;
  assert.equal(doc.querySelectorAll("#r b").length, 2, "the repeated element was dropped");
  assert.equal(doc.querySelectorAll("#fuerte").length, 1, "the repeated element carried the page's id");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// A page may render a unit Glossa translated in replace mode again. What it writes decides what
// "show original" can still do: the translation read back off the screen is not new text and must
// not cost the way back, while text of the page's own is the new original.

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
const byId = (id: string) => window.document.getElementById(id) as unknown as HTMLElement;

function translateInPlace(html: string) {
  window.document.body.innerHTML = html;
  const original = byId("q").outerHTML;
  const unit = collectSegments(window.document.body as unknown as Element, options).find((segment) => segment.kind === "element");
  assert.ok(unit && unit.kind === "element");
  const renderer = new Renderer();
  renderer.apply(unit, unit.html.replace("La biblioteca abre", "The library opens").replace("de la semana", "of the week"), replace);
  assert.match(byId("q").textContent ?? "", /^The library opens/);
  return { renderer, original };
}

test("a page that renders the translation again from the screen still gets its original back", () => {
  const { renderer, original } = translateInPlace(`<p id="q">La biblioteca abre <a id="a" href="#h">todos los días</a> de la semana.</p>`);
  // What a framework does when it rebuilds the block from the text it reads back.
  const unit = byId("q");
  unit.innerHTML = unit.innerHTML;
  assert.equal(renderer.reset(unit as unknown as Element), false, "the way back was dropped");
  renderer.restoreAll();
  assert.equal(byId("q").outerHTML, original, "show original did not bring the page's own text back");
});

test("a unit kept after a re-render keeps its own translated tooltip", () => {
  window.document.body.innerHTML = `<p id="q" title="Haz clic aquí para abrir la ficha">La biblioteca abre <a id="a" href="#h">todos los días</a> de la semana.</p>`;
  const original = byId("q").outerHTML;
  const renderer = new Renderer();
  for (const segment of collectSegments(window.document.body as unknown as Element, options)) {
    if (segment.kind === "element") renderer.apply(segment, segment.html.replace("La biblioteca abre", "The library opens"), replace);
    else if (segment.kind === "attribute") renderer.apply(segment, "Click here to open the record", replace);
  }
  const unit = byId("q");
  assert.equal(unit.getAttribute("title"), "Click here to open the record", "the tooltip was not translated");
  unit.innerHTML = unit.innerHTML;
  assert.equal(renderer.reset(unit as unknown as Element), false);
  assert.equal(unit.getAttribute("title"), "Click here to open the record", "the kept unit's tooltip went back to the original");
  renderer.restoreAll();
  assert.equal(byId("q").outerHTML, original);
});

test("a page that writes new text of its own keeps it, and it is translated afresh", () => {
  const { renderer } = translateInPlace(`<p id="q">La biblioteca abre <a id="a" href="#h">todos los días</a> de la semana.</p>`);
  const unit = byId("q");
  unit.textContent = "Hoy la biblioteca cierra a las ocho de la tarde.";
  assert.equal(renderer.reset(unit as unknown as Element), true, "new text of the page's own was not handed back for translation");
  renderer.restoreAll();
  assert.equal(byId("q").textContent, "Hoy la biblioteca cierra a las ocho de la tarde.", "restore wrote an old original over the page's new text");
});

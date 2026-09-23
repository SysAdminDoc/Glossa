import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// A page that edits part of a block Glossa translated in place (G-53). What is there afterwards is
// the translation with the page's edit in it: never source text for the engine, and "show original"
// either brings the original back with the edit carried over or leaves the block and says so.

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

const replace = { displayMode: "replace" as const, showOriginalOnHover: false, targetLanguage: "en" };
const byId = (id: string) => window.document.getElementById(id) as unknown as HTMLElement;

// A message count the page keeps up to date, translated in place.
function translated(): { renderer: InstanceType<typeof Renderer>; p: HTMLElement } {
  window.document.body.innerHTML = `<p id="p">Tienes <span id="n">3</span> mensajes nuevos en tu buzón de entrada.</p>`;
  const segment = collectSegments(window.document.body as unknown as Element, { skipFormFields: true }).find((s) => s.kind === "element");
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  const answer = segment.html.replace("Tienes", "You have").replace("mensajes nuevos en tu buzón de entrada.", "new messages in your inbox.");
  renderer.apply(segment, answer, replace);
  const p = byId("p");
  assert.equal(p.textContent, "You have 3 new messages in your inbox.");
  assert.equal(byId("n").textContent, "3", "the page's own span was not reused");
  return { renderer, p };
}

test("a page updating its own element inside the block gets the original back with its update", () => {
  const { renderer, p } = translated();
  byId("n").textContent = "4";
  assert.equal(renderer.reset(p), false, "the block was handed back to be translated again");
  assert.equal(p.textContent, "You have 4 new messages in your inbox.");
  const { restored, kept } = renderer.restoreAll();
  assert.deepEqual({ restored, kept }, { restored: 1, kept: 0 });
  assert.equal(p.textContent, "Tienes 4 mensajes nuevos en tu buzón de entrada.");
  assert.equal(p.getAttribute("data-glossa-unit"), null);
});

test("a page editing the translation itself keeps its edit, and show original says it left the block", () => {
  const { renderer, p } = translated();
  const first = p.firstChild as Text;
  first.data = "You now have ";
  assert.equal(renderer.reset(p), false, "the edited translation was handed back as source text");
  const { restored, kept } = renderer.restoreAll();
  assert.deepEqual({ restored, kept }, { restored: 0, kept: 1 });
  assert.equal(p.textContent, "You now have 3 new messages in your inbox.");
  // A later translation of the page must not take it for the page's language either.
  assert.equal(p.getAttribute("data-glossa-unit"), "kept");
  assert.equal(collectSegments(window.document.body as unknown as Element, { skipFormFields: true }).length, 0);
  // And an edit after that is still not a reason to send it.
  first.data = "You no longer have ";
  assert.equal(renderer.reset(p), false);
});

test("the page writing the translation back with a word changed is an edit too", () => {
  const { renderer, p } = translated();
  p.textContent = "You have 5 new messages in your inbox.";
  assert.equal(renderer.reset(p), false);
  assert.equal(renderer.restoreAll().kept, 1);
  assert.equal(p.textContent, "You have 5 new messages in your inbox.");
});

test("new text of the page's own is still translated afresh", () => {
  const { renderer, p } = translated();
  p.textContent = "La biblioteca cierra hoy por la tarde por obras de mantenimiento.";
  assert.equal(renderer.reset(p), true, "the page's new text was not handed back for translation");
  assert.equal(p.getAttribute("data-glossa-unit"), null);
});

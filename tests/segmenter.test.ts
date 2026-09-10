import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// One window for the whole file. happy-dom windows are expensive and leak if created per test.
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

const { batchSegments, collectFromNodes, collectSegments, escapeHtml, segmentFragment } = await import("../src/content/segmenter.ts");
const { Renderer } = await import("../src/content/renderer.ts");

function load(html: string) {
  window.document.body.innerHTML = html;
  return window.document.body as unknown as Element;
}

const options = { skipFormFields: true };

test("inline-only blocks become one unit each and keep their inline markup", () => {
  const body = load(`<p id="a">Hola <a href="#x">mundo</a> y <b>todos</b>.</p><ul><li>Uno</li><li>Dos</li></ul>`);
  const segments = collectSegments(body, options);
  const units = segments.filter((s) => s.kind === "element");
  assert.equal(units.length, 3);
  assert.equal((units[0] as { html: string }).html, 'Hola <a href="#x">mundo</a> y <b>todos</b>.');
});

test("containers with block children are recursed, and their loose text becomes text segments", () => {
  const body = load(`<div>Texto suelto<p>Un párrafo</p></div>`);
  const segments = collectSegments(body, options);
  assert.deepEqual(
    segments.map((s) => (s.kind === "text" ? `text:${s.text}` : `el:${s.element.tagName}`)),
    ["text:Texto suelto", "el:P"]
  );
});

test("code, pre, translate=no, notranslate, hidden, and inputs are skipped", () => {
  const body = load(`
    <p>Ejecuta <code>npm install</code> ahora.</p>
    <pre>const x = 1;</pre>
    <p translate="no">Café Aurora</p>
    <div class="notranslate">Sala 3B</div>
    <p hidden>Escondido</p>
    <textarea>hola</textarea>
    <p><span translate="no">Marca</span> registrada</p>
  `);
  const segments = collectSegments(body, options);
  const texts = segments.map((s) => (s.kind === "element" ? s.element.textContent : s.text));
  assert.deepEqual(texts, ["Ejecuta npm install ahora.", "Marca registrada"]);
  // The unit still carries the inline code element; the engine's HTML mode leaves it as-is.
  assert.match((segments[0] as { html: string }).html, /<code>npm install<\/code>/);
  // An inline translate="no" span becomes a var placeholder the engine copies verbatim.
  const brand = segments[1] as { html: string; holds: Element[] };
  assert.equal(brand.html, '<var data-glossa-hold="0">Marca</var> registrada');
  assert.equal(brand.holds.length, 1);
  assert.equal(brand.holds[0]?.outerHTML, '<span translate="no">Marca</span>');
});

test("renderer restores protected inline elements from their placeholders", () => {
  const body = load(`<p id="p">La marca <span translate="no" class="brand">Café Aurora</span> abre hoy con muchas novedades.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, 'The brand <var data-glossa-hold="0">Café Aurora</var> opens today with many new things.', {
    displayMode: "bilingual",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const block = window.document.querySelector("#p glossa-translation")!;
  assert.equal(block.querySelector("var"), null);
  assert.equal(block.querySelector("span.brand")?.outerHTML, '<span translate="no" class="brand">Café Aurora</span>');
  assert.equal(block.textContent, "The brand Café Aurora opens today with many new things.");
});

test("blocks without letters are ignored", () => {
  const body = load(`<p>12345</p><p>...</p><p>ok!</p>`);
  const segments = collectSegments(body, options);
  assert.equal(segments.length, 1);
});

test("open shadow roots are walked", () => {
  const body = load(`<section id="host"></section>`);
  const host = window.document.getElementById("host")!;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = "<p>Dentro de la sombra</p>";
  const segments = collectSegments(body, options);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "element");
});

test("collectFromNodes treats the given nodes themselves as candidates", () => {
  load("");
  const fresh = window.document.createElement("p");
  fresh.textContent = "Nuevo párrafo";
  window.document.body.append(fresh);
  const segments = collectFromNodes([fresh as unknown as Node], options);
  assert.equal(segments.length, 1);
});

test("batches respect item and character limits", () => {
  const body = load(Array.from({ length: 30 }, (_, i) => `<p>Párrafo número ${i} con algo de texto.</p>`).join(""));
  const segments = collectSegments(body, options);
  const batches = batchSegments(segments, 8, 100_000);
  assert.deepEqual(batches.map((b) => b.length), [8, 8, 8, 6]);
  const tight = batchSegments(segments, 100, 80);
  assert.ok(tight.every((b) => b.length <= 2), "80-char budget allows at most two short paragraphs");
});

test("text segments are escaped before they reach the engine", () => {
  const body = load(`<div>a &lt; b &amp; c<p>x</p></div>`);
  const segments = collectSegments(body, options);
  const text = segments.find((s) => s.kind === "text");
  assert.ok(text);
  assert.equal(segmentFragment(text), "a &lt; b &amp; c");
  assert.equal(escapeHtml("<x>&"), "&lt;x&gt;&amp;");
});

test("renderer bilingual mode appends a block and restore removes it", () => {
  const body = load(`<p id="p">Hola <a href="#x">mundo</a>, bienvenidos</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, 'Hello <a href="#x">world</a>, welcome', { displayMode: "bilingual", showOriginalOnHover: true, targetLanguage: "en" });
  const p = window.document.getElementById("p")!;
  assert.equal(p.getAttribute("data-glossa-unit"), "bilingual");
  assert.equal(p.querySelector("glossa-translation")?.textContent, "Hello world, welcome");
  assert.equal(p.querySelector("glossa-translation a")?.getAttribute("href"), "#x");
  assert.equal(renderer.restoreAll(), 1);
  assert.equal(p.querySelector("glossa-translation"), null);
  assert.equal(p.getAttribute("data-glossa-unit"), null);
  assert.equal(p.innerHTML, 'Hola <a href="#x">mundo</a>, bienvenidos');
});

test("renderer replace mode swaps children, keeps the original for hover, and restores exactly", () => {
  const body = load(`<h1 id="h">Bienvenido</h1>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "Welcome", { displayMode: "replace", showOriginalOnHover: true, targetLanguage: "en" });
  const h = window.document.getElementById("h")!;
  assert.equal(h.textContent, "Welcome");
  assert.equal(h.getAttribute("title"), "Bienvenido");
  assert.equal(h.getAttribute("lang"), "en");
  renderer.restoreAll();
  assert.equal(h.textContent, "Bienvenido");
  assert.equal(h.getAttribute("title"), null);
  assert.equal(h.getAttribute("lang"), null);
});

test("renderer restores the space Bergamot drops around copied inline code", () => {
  const body = load(`<p id="p">Para instalar el programa ejecuta <code>npm install</code> en la terminal.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "To install the program run<code>npm install</code>at the terminal.", {
    displayMode: "bilingual",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const block = window.document.querySelector("#p glossa-translation")!;
  assert.equal(block.textContent, "To install the program run npm install at the terminal.");
});

test("renderer leaves punctuation tight against inline code", () => {
  const body = load(`<p id="p">Escribe <code>ls</code>, luego <code>cd</code>.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "Type <code>ls</code>, then <code>cd</code>.", { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" });
  assert.equal(window.document.getElementById("p")!.textContent, "Type ls, then cd.");
});

test("renderer strips scripts and event handlers from a translated fragment", () => {
  const body = load(`<p id="p">Texto con <a href="#a">enlace</a> suficientemente largo para ser bilingüe.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(
    segment,
    'Text with <a href="javascript:alert(1)" onclick="alert(1)">link</a><script>alert(2)</script> long enough.',
    { displayMode: "bilingual", showOriginalOnHover: false, targetLanguage: "en" }
  );
  const block = window.document.querySelector("#p glossa-translation")!;
  assert.equal(block.querySelector("script"), null);
  const a = block.querySelector("a")!;
  assert.equal(a.getAttribute("onclick"), null);
  assert.equal(a.getAttribute("href"), null);
});

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
globals.NodeFilter = window.NodeFilter;

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

test("an inline wrapper with block descendants is a container, not a unit", () => {
  const body = load(
    `<div id="cards">` +
      `<a href="#1"><div class="name">Libro primero</div><div class="price">Diez euros</div></a>` +
      `<a href="#2"><div class="name">Libro segundo</div><div class="price">Doce euros</div></a>` +
      `</div>`
  );
  const segments = collectSegments(body, options);
  const units = segments.filter((s) => s.kind === "element");
  // One unit per inner div, never the grid and never the anchors.
  assert.deepEqual(
    units.map((s) => (s as { element: Element }).element.className),
    ["name", "price", "name", "price"]
  );
});

test("an inline icon deep inside a unit does not split the unit", () => {
  const body = load(`<p id="p">Mira <a href="#x"><svg viewBox="0 0 1 1"></svg>el mapa</a> ahora mismo.</p>`);
  const segments = collectSegments(body, options);
  const units = segments.filter((s) => s.kind === "element");
  assert.equal(units.length, 1);
  assert.equal((units[0] as { element: Element }).element.id, "p");
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

test("urls, email addresses and reference numbers become placeholders", () => {
  const body = load(
    `<p id="p">Escribe a <a href="#c">info@ejemplo.es</a> o visita https://ejemplo.es/ruta?x=1 con el expediente 2026123456 antes del 5 de mayo.</p>`
  );
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const html = (segment as { html: string }).html;
  // Three placeholders, and the short number stays inside the sentence.
  assert.match(html, /<var data-glossa-hold="0" data-glossa-pad="lr">info@ejemplo\.es<\/var>/);
  assert.match(html, /<var data-glossa-hold="1" data-glossa-pad="lr">https:\/\/ejemplo\.es\/ruta\?x=1<\/var>/);
  assert.match(html, /<var data-glossa-hold="2" data-glossa-pad="lr">2026123456<\/var>/);
  assert.match(html, /5 de mayo/);
  assert.equal((segment as { holds: unknown[] }).holds.length, 3);
});

test("a protected url survives byte for byte even when the engine mangles the spacing", () => {
  const body = load(`<p id="p">Visita https://ejemplo.es/ruta?x=1 para ver el catálogo completo de la biblioteca.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  // What the engine does to a placeholder: keeps it, loses the spaces around it.
  renderer.apply(segment, 'Visit<var data-glossa-hold="0">https://ejemplo.es/ruta?x=1</var>to see the full library catalogue.', {
    displayMode: "bilingual",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const block = window.document.querySelector("#p glossa-translation")!;
  assert.equal(block.querySelector("var"), null);
  assert.equal(block.textContent, "Visit https://ejemplo.es/ruta?x=1 to see the full library catalogue.");
});

test("an email domain is not translated away", () => {
  const body = load(`<p id="p">Para reservar una sala escribe a info@ejemplo.es y espera la confirmación.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, 'To book a room write to <var data-glossa-hold="0">info@example.com</var> and wait for confirmation.', {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  assert.match(window.document.getElementById("p")!.textContent ?? "", /info@ejemplo\.es/);
});

test("each unit carries the language the page declares for it", () => {
  window.document.documentElement.setAttribute("lang", "es");
  const body = load(
    `<p id="es">Un párrafo en español con bastante texto.</p>` +
      `<blockquote lang="ar" id="ar"><p>نص عربي مكتوب هنا.</p></blockquote>` +
      `<p lang="fr-CA" id="fr">Un paragraphe écrit en français.</p>`
  );
  const segments = collectSegments(body, options);
  const byId = new Map(
    segments
      .filter((s) => s.kind === "element")
      .map((s) => [(s as { element: Element }).element.id || (s as { element: Element }).element.parentElement?.id, s.lang])
  );
  assert.equal(byId.get("es"), "es");
  // The nested paragraph inherits the quote's language, not the document's.
  assert.equal(byId.get("ar"), "ar");
  assert.equal(byId.get("fr"), "fr-CA");
});

test("one unit's protected text does not disable the next unit's", () => {
  // The scan is global, so a gate that leaves its lastIndex behind makes the following unit start
  // matching in the middle of its own text. The first unit's only text lives inside <code>, which
  // the protection skips, so nothing resets the index on its behalf.
  const body = load(
    `<li id="doc"><code>https://api.ejemplo.es/v1/usuarios</code></li>` +
      `<p id="victim">Escribe a info@ejemplo.es hoy mismo para reservar una sala de lectura.</p>`
  );
  const segments = collectSegments(body, options);
  const victim = segments.find((s) => s.kind === "element" && s.element.id === "victim") as
    | { html: string; holds: unknown[] }
    | undefined;
  assert.ok(victim, "the second paragraph was not collected");
  assert.equal(victim.holds.length, 1);
  assert.match(victim.html, /<var data-glossa-hold="0"[^>]*>info@ejemplo\.es<\/var>/);
});

test("a block nested inside an inline element does not split the sentence around it", () => {
  const body = load(
    `<p id="p">El préstamo dura quince días<sup><a href="#n1">1<div class="tip">Nota al pie.</div></a></sup> y se puede renovar.</p>`
  );
  const segments = collectSegments(body, options);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "element");
  assert.equal((segments[0] as { element: Element }).element.id, "p");
});

test("a number welded to letters is left inside the word", () => {
  const body = load(`<p id="p">La tarjeta RTX4090 no cabe en este equipo pequeño de la sala.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  assert.equal((segment as { holds: unknown[] }).holds.length, 0);
});

test("a version string keeps its shape through the engine's spacing damage", () => {
  const body = load(`<p id="p">Actualiza a la versión v1.2.3 de la aplicación ahora por favor.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  // The protected run had no space before it, so no space may be put back there.
  const html = (segment as { html: string }).html;
  assert.match(html, /v<var data-glossa-hold="0" data-glossa-pad="r">1\.2\.3<\/var>/);
  const renderer = new Renderer();
  renderer.apply(segment, 'Update to version v<var data-glossa-hold="0" data-glossa-pad="r">1.2.3</var>of the app now please.', {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  assert.equal(
    window.document.getElementById("p")!.textContent,
    "Update to version v1.2.3 of the app now please."
  );
});

test("a url in brackets keeps the brackets tight", () => {
  const body = load(`<p id="p">Consulta el catálogo (https://ejemplo.es/catalogo) cuando quieras hoy.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(
    segment,
    'Check the catalogue (<var data-glossa-hold="0" data-glossa-pad="">https://ejemplo.es/catalogo</var>) whenever you like today.',
    { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" }
  );
  assert.equal(
    window.document.getElementById("p")!.textContent,
    "Check the catalogue (https://ejemplo.es/catalogo) whenever you like today."
  );
});

test("a block that is only a url is never sent", () => {
  const body = load(`<p id="p">https://ejemplo.es/catalogo/2026</p><p id="q">1234567890</p>`);
  assert.deepEqual(collectSegments(body, options), []);
});

test("the lang we stamp on a replaced unit is not read back as the page's language", () => {
  window.document.documentElement.setAttribute("lang", "es");
  const body = load(`<p id="p">Un párrafo en español que se reemplaza del todo.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "A Spanish paragraph that is replaced entirely.", {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const p = window.document.getElementById("p")!;
  assert.equal(p.getAttribute("lang"), "en");
  // New Spanish content the page renders inside that unit must still read as Spanish.
  const fresh = window.document.createElement("span");
  fresh.textContent = "Una frase nueva en español dentro del bloque.";
  p.append(fresh);
  const again = collectFromNodes([fresh as unknown as Node], options);
  assert.equal(again.length, 1);
  assert.equal(again[0]?.lang, "es");
});

test("reset gives a replaced unit its language back so it can be translated again", () => {
  const body = load(`<p id="p" lang="es">Otro párrafo en español para reemplazar entero.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "Another Spanish paragraph to replace entirely.", {
    displayMode: "replace",
    showOriginalOnHover: true,
    targetLanguage: "en"
  });
  const p = window.document.getElementById("p")!;
  assert.equal(renderer.reset(p as unknown as Element), true);
  assert.equal(p.getAttribute("lang"), "es");
  assert.equal(p.getAttribute("title"), null);
  assert.equal(p.getAttribute("data-glossa-unit"), null);
});

test("reset reports a unit that was only marked pending, so it is collected again", () => {
  const body = load(`<p id="p">Un párrafo que todavía espera al motor de traducción.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.markPending(segment);
  assert.equal(renderer.reset(window.document.getElementById("p") as unknown as Element), true);
  assert.equal(window.document.getElementById("p")!.getAttribute("data-glossa-unit"), null);
});

test("candidates that are not rendered yet are reported as deferred", () => {
  const body = load(`<p id="now">Visible desde el principio.</p><p id="later" hidden>Aparece más tarde.</p>`);
  const deferred = new Set<Element>();
  const segments = collectSegments(body, { skipFormFields: true, deferred });
  assert.equal(segments.length, 1);
  assert.deepEqual(Array.from(deferred).map((element) => element.id), ["later"]);
});

test("reset drops a unit's record and its translation block so it can be translated again", () => {
  const body = load(`<p id="p">Primera versión del texto de esta prueba.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "First version of this test text.", {
    displayMode: "bilingual",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const p = window.document.getElementById("p")!;
  assert.equal(p.querySelectorAll("glossa-translation").length, 1);
  assert.equal(renderer.reset(p as unknown as Element), true);
  assert.equal(p.querySelector("glossa-translation"), null);
  assert.equal(p.getAttribute("data-glossa-unit"), null);
  // Nothing is left to undo, and the element is a candidate again.
  assert.equal(renderer.restoreAll(), 0);
  const again = collectSegments(body, options);
  assert.equal(again.length, 1);
});

test("replace mode puts the page's own lang back on restore", () => {
  const body = load(`<p id="p" lang="es">Texto en español que se traduce.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "Spanish text being translated.", {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const p = window.document.getElementById("p")!;
  assert.equal(p.getAttribute("lang"), "en");
  renderer.restoreAll();
  assert.equal(p.getAttribute("lang"), "es");
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

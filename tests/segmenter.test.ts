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

const { collectFromNodes, collectSegments, escapeHtml, segmentFragment } = await import("../src/content/segmenter.ts");
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
  // Every element is numbered on the way out so replace mode can put the text back into the page's
  // own elements rather than into copies.
  assert.equal(
    (units[0] as { html: string }).html,
    'Hola <a href="#x" data-glossa-id="0">mundo</a> y <b data-glossa-id="1">todos</b>.'
  );
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
  assert.match((segments[0] as { html: string }).html, /<code data-glossa-id="0">npm install<\/code>/);
  // An inline translate="no" span becomes a var placeholder the engine copies verbatim.
  const brand = segments[1] as { html: string; holds: Element[] };
  assert.equal(brand.html, '<var data-glossa-hold="0">Marca</var> registrada');
  // The placeholder replaced the numbered element, so no stray numbering is left in the fragment.
  assert.equal(brand.holds.length, 1);
  // The live element carries its number until the unit is restored.
  assert.equal(brand.holds[0]?.outerHTML, '<span translate="no" data-glossa-id="0">Marca</span>');
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

test("replace mode keeps the page's own link, listeners and all", () => {
  const body = load(`<p id="p">Visita el <a id="link" href="#c">catálogo en línea</a> antes de venir.</p>`);
  const link = window.document.getElementById("link")!;
  let clicks = 0;
  link.addEventListener("click", () => {
    clicks++;
  });
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const html = (segment as { html: string }).html;
  assert.match(html, /data-glossa-id="0"/);
  const renderer = new Renderer();
  renderer.apply(segment, 'Visit the <a id="link" href="#c" data-glossa-id="0">online catalogue</a> before coming.', {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const after = window.document.getElementById("link")!;
  assert.equal(after, link, "the link was replaced by a copy");
  assert.equal(after.textContent, "online catalogue");
  assert.equal(after.getAttribute("data-glossa-id"), null, "the numbering was left in the page");
  after.dispatchEvent(new window.Event("click"));
  assert.equal(clicks, 1, "the click listener did not survive the translation");

  renderer.restoreAll();
  assert.equal(window.document.getElementById("link"), link);
  assert.equal(link.textContent, "catálogo en línea", "the link's original text did not come back");
  assert.equal(window.document.getElementById("p")!.querySelector("[data-glossa-id]"), null);
});

test("an element the engine repeats becomes a copy, not the page's element twice", () => {
  const body = load(`<p id="p">Compra el <b id="b">libro</b> aquí mismo hoy sin esperas.</p>`);
  const bold = window.document.getElementById("b")!;
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(
    segment,
    'Buy the <b data-glossa-id="0">book</b> here today, the <b data-glossa-id="0">book</b>, without waiting.',
    { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" }
  );
  const p = window.document.getElementById("p")!;
  const bolds = Array.from(p.querySelectorAll("b"));
  assert.equal(bolds.length, 2);
  assert.equal(bolds[0], bold, "the first occurrence should be the page's own element");
  assert.notEqual(bolds[1], bold, "the page's element cannot be in two places at once");
  assert.equal(bolds[1]?.getAttribute("data-glossa-id"), null);
});

test("bilingual mode leaves no numbering in the block it adds", () => {
  const body = load(`<p id="p">Visita el <a href="#c">catálogo en línea</a> antes de tu visita de hoy.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, 'Visit the <a href="#c" data-glossa-id="0">online catalogue</a> before your visit today.', {
    displayMode: "bilingual",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const block = window.document.querySelector("#p glossa-translation")!;
  assert.equal(block.querySelector("[data-glossa-id]"), null);
  assert.equal(block.querySelector("a")?.getAttribute("href"), "#c");
  renderer.restoreAll();
  assert.equal(window.document.getElementById("p")!.querySelector("[data-glossa-id]"), null);
});

test("readable attributes and option labels are collected, and unreadable ones are not", () => {
  const body = load(
    `<p><img alt="Fachada de la biblioteca" src="x.gif" />` +
      `<input type="search" placeholder="Buscar en el catálogo" aria-label="Buscar por título" value="texto del usuario" />` +
      `<a href="#h" title="Consulta los horarios">Horarios</a>` +
      `<select><option>Sala de lectura</option><option value="infantil">Sala infantil</option></select></p>`
  );
  const segments = collectSegments(body, options);
  const found = segments
    .filter((s) => s.kind === "attribute" || s.kind === "label")
    .map((s) => (s.kind === "attribute" ? `${s.attribute}=${s.text}` : `label=${s.text}`));
  assert.deepEqual(found, [
    "alt=Fachada de la biblioteca",
    "placeholder=Buscar en el catálogo",
    "aria-label=Buscar por título",
    "title=Consulta los horarios",
    "label=Sala de lectura",
    "label=Sala infantil"
  ]);
  // What the user typed into a search box is not ours to translate.
  assert.ok(!found.some((entry) => entry.startsWith("value=")));
});

test("an attribute inside a translate=no block is left alone", () => {
  const body = load(`<div translate="no"><img alt="Café Aurora, la marca" src="x.gif" /><a title="Marca registrada">x</a></div>`);
  const segments = collectSegments(body, options);
  assert.deepEqual(segments.filter((s) => s.kind === "attribute"), []);
});

test("a translated attribute is written back and restored, and an option keeps what it submits", () => {
  const body = load(
    `<p><input id="s" type="search" placeholder="Buscar en el catálogo" />` +
      `<select id="sel"><option id="o">Sala de lectura</option></select></p>`
  );
  const segments = collectSegments(body, options);
  const placeholder = segments.find((s) => s.kind === "attribute")!;
  const label = segments.find((s) => s.kind === "label")!;
  const renderer = new Renderer();
  renderer.apply(placeholder, "Search the catalogue", { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" });
  renderer.apply(label, "Reading room", { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" });

  const input = window.document.getElementById("s")!;
  const option = window.document.getElementById("o")! as unknown as { value: string; textContent: string };
  assert.equal(input.getAttribute("placeholder"), "Search the catalogue");
  assert.equal(input.getAttribute("data-glossa-was-placeholder"), "Buscar en el catálogo");
  assert.equal(option.textContent, "Reading room");
  // The form still submits what it submitted before the label was translated.
  assert.equal(option.value, "Sala de lectura");

  renderer.restoreAll();
  assert.equal(input.getAttribute("placeholder"), "Buscar en el catálogo");
  assert.equal(input.getAttribute("data-glossa-was-placeholder"), null);
  assert.equal(option.textContent, "Sala de lectura");
  assert.equal(window.document.getElementById("o")!.getAttribute("value"), null);
});


test("a text node handed to the collector is not an error", () => {
  // The observer queues raw text nodes. Asking one for its descendants used to throw and take the
  // whole flush with it, including the units it had already dropped records for.
  const body = load(`<div id="host">Texto suelto que aparece más tarde en la página.</div>`);
  void body;
  const text = window.document.getElementById("host")!.firstChild as unknown as Node;
  const segments = collectFromNodes([text], options);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "text");
});

test("an editable region is left alone, attributes and all", () => {
  const body = load(
    `<div id="editor" contenteditable="true">` +
      `<p>Texto que el usuario está escribiendo ahora mismo.</p>` +
      `<img alt="Fachada de la biblioteca" src="x.gif" />` +
      `<a href="#h" title="Consulta los horarios">Horarios</a>` +
      `</div>`
  );
  const before = window.document.getElementById("editor")!.innerHTML;
  const segments = collectSegments(body, options);
  assert.deepEqual(segments, [], "nothing inside an editable region may be collected");
  assert.equal(window.document.getElementById("editor")!.innerHTML, before);
});

test("an attribute is collected once, however many passes run over it", () => {
  const body = load(`<p><a href="#h" id="link" title="Consulta los horarios de apertura">Horarios</a></p>`);
  const [attribute] = collectSegments(body, options).filter((s) => s.kind === "attribute");
  assert.ok(attribute);
  const renderer = new Renderer();
  renderer.apply(attribute, "Check the opening hours", {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  // A second pass sees the marker and leaves it alone: without that the translation goes back
  // through the engine on every mutation flush.
  assert.deepEqual(collectSegments(body, options).filter((s) => s.kind === "attribute"), []);
  renderer.restoreAll();
  assert.equal(window.document.getElementById("link")!.getAttribute("title"), "Consulta los horarios de apertura");
  assert.equal(collectSegments(body, options).filter((s) => s.kind === "attribute").length, 1);
});

test("the hover original this extension parks on a unit is never translated", () => {
  const body = load(`<p id="p">Consultar el catálogo en línea es muy cómodo para todos.</p>`);
  const [segment] = collectSegments(body, options);
  assert.ok(segment && segment.kind === "element");
  const renderer = new Renderer();
  renderer.apply(segment, "Searching the catalogue online is very convenient.", {
    displayMode: "replace",
    showOriginalOnHover: true,
    targetLanguage: "en"
  });
  const p = window.document.getElementById("p")!;
  assert.equal(p.getAttribute("title"), "Consultar el catálogo en línea es muy cómodo para todos.");
  // The title is the original, kept for hovering. Collecting it would send it back to the engine
  // and replace the one thing it exists to show.
  assert.deepEqual(collectSegments(body, options).filter((s) => s.kind === "attribute"), []);
});

test("a page that rewrites a translated attribute keeps its own value", () => {
  const body = load(`<p><a href="#h" id="link" title="Consulta los horarios">Horarios</a></p>`);
  const [attribute] = collectSegments(body, options).filter((s) => s.kind === "attribute");
  assert.ok(attribute);
  const renderer = new Renderer();
  renderer.apply(attribute, "Check the opening hours", {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const link = window.document.getElementById("link")!;
  link.setAttribute("title", "Quedan 3 plazas");
  renderer.restoreAll();
  assert.equal(link.getAttribute("title"), "Quedan 3 plazas", "restore overwrote what the page had written");
  assert.equal(link.getAttribute("data-glossa-was-title"), null);
});

test("resetting a unit puts its attributes back so it can be translated again", () => {
  const body = load(`<p id="p" title="Consulta los horarios">Un párrafo con su propia descripción emergente.</p>`);
  const segments = collectSegments(body, options);
  const attribute = segments.find((s) => s.kind === "attribute")!;
  const renderer = new Renderer();
  renderer.apply(attribute, "Check the opening hours", {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  const p = window.document.getElementById("p")!;
  assert.equal(p.getAttribute("title"), "Check the opening hours");
  renderer.reset(p as unknown as Element);
  assert.equal(p.getAttribute("title"), "Consulta los horarios", "reset left the attribute translated with no way back");
  assert.equal(p.getAttribute("data-glossa-was-title"), null);
});

test("markers on an element the page cloned are swept on restore", () => {
  const body = load(`<p id="p"><img id="photo" alt="Fachada de la biblioteca" src="x.gif" /></p>`);
  const [attribute] = collectSegments(body, options).filter((s) => s.kind === "attribute");
  assert.ok(attribute);
  const renderer = new Renderer();
  renderer.apply(attribute, "Library frontage", {
    displayMode: "replace",
    showOriginalOnHover: false,
    targetLanguage: "en"
  });
  // The page duplicates the widget after it was translated. The copy carries the marker and no
  // record knows about it.
  const clone = window.document.getElementById("photo")!.cloneNode(true);
  clone.id = "photo-copy";
  window.document.getElementById("p")!.append(clone as never);
  renderer.restoreAll();
  assert.equal(window.document.querySelectorAll("[data-glossa-was-alt]").length, 0, "a marker was left in the page");
  assert.equal(window.document.getElementById("photo-copy")!.getAttribute("alt"), "Fachada de la biblioteca");
});

test("what a form submits is never changed by a translation", () => {
  const body = load(
    `<form>` +
      `<select id="sel"><option id="o">\n      Sala de lectura\n    </option></select>` +
      `<input id="go" type="submit" name="accion" value="Guardar cambios" />` +
      `<input id="plain" type="button" value="Mostrar más" />` +
      `<datalist id="list"><option>Sala infantil</option></datalist>` +
      `</form>`
  );
  const segments = collectSegments(body, options);
  const values = segments
    .filter((s) => s.kind === "attribute" && s.attribute === "value")
    .map((s) => (s as { text: string }).text);
  // A submit button's value is what the form posts; a plain button's is only a label.
  assert.deepEqual(values, ["Mostrar más"]);
  // A datalist option is inserted by value, so its text is not a label to translate.
  const labels = segments.filter((s) => s.kind === "label").map((s) => (s as { text: string }).text);
  assert.deepEqual(labels, ["Sala de lectura"]);

  const label = segments.find((s) => s.kind === "label")!;
  const renderer = new Renderer();
  renderer.apply(label, "Reading room", { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" });
  // The value written is what the browser would have submitted: stripped and collapsed.
  assert.equal(window.document.getElementById("o")!.getAttribute("value"), "Sala de lectura");
});

test("an attribute inside a translate=no element is left alone through the property too", () => {
  const body = load(`<p><img id="brand" alt="Café Aurora, la marca" src="x.gif" /></p>`);
  const image = window.document.getElementById("brand")!;
  // happy-dom has no `translate` IDL attribute, and a browser does: define it so the branch a
  // browser actually takes is the one under test.
  Object.defineProperty(image, "translate", { value: false, configurable: true });
  assert.deepEqual(collectSegments(body, options).filter((s) => s.kind === "attribute"), []);
});


test("an attribute the page rewrites after translation is the page's again", async () => {
  const { attributeSegment } = await import("../src/content/segmenter.ts");
  const body = load(`<p><a href="#h" id="link" title="Consulta los horarios">Horarios</a></p>`);
  const [first] = collectSegments(body, options).filter((s) => s.kind === "attribute");
  assert.ok(first);
  const renderer = new Renderer();
  renderer.apply(first, "Check the opening hours", { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" });
  const link = window.document.getElementById("link")! as unknown as Element;
  // Marked: the same attribute is not offered twice.
  assert.equal(attributeSegment(link, "title", options), null);
  link.setAttribute("title", "Quedan tres plazas libres");
  renderer.forgetAttribute(link, "title");
  const again = attributeSegment(link, "title", options);
  assert.equal(again && again.kind === "attribute" ? again.text : null, "Quedan tres plazas libres");
  renderer.restoreAll();
  assert.equal(link.getAttribute("title"), "Quedan tres plazas libres", "restore put an old original over the page's value");
});

test("a single changed attribute obeys the same rules as the full pass", async () => {
  const { attributeSegment } = await import("../src/content/segmenter.ts");
  load(
    `<form>` +
      `<input id="go" type="submit" value="Guardar cambios" />` +
      `<div contenteditable="true"><a id="e" href="#" title="Nota del editor">x</a></div>` +
      `<span class="notranslate"><a id="n" href="#" title="Marca registrada">y</a></span>` +
      `<a id="ok" href="#" title="Consulta los horarios">z</a>` +
      `</form>`
  );
  const byId = (id: string) => window.document.getElementById(id) as unknown as Element;
  assert.equal(attributeSegment(byId("go"), "value", options), null, "a submit button's value is what the form posts");
  assert.equal(attributeSegment(byId("e"), "title", options), null, "an editable region is left alone");
  assert.equal(attributeSegment(byId("n"), "title", options), null, "notranslate is honoured");
  assert.notEqual(attributeSegment(byId("ok"), "title", options), null);
});

test("forgetting a label drops the value it pinned and leaves the page's text", () => {
  const body = load(`<select><option id="o">Sala de lectura</option></select>`);
  const label = collectSegments(body, options).find((s) => s.kind === "label")!;
  const renderer = new Renderer();
  renderer.apply(label, "Reading room", { displayMode: "replace", showOriginalOnHover: false, targetLanguage: "en" });
  const option = window.document.getElementById("o")! as unknown as Element;
  assert.equal(option.getAttribute("value"), "Sala de lectura");
  option.textContent = "Sala nueva";
  renderer.forgetLabel(option);
  assert.equal(option.getAttribute("value"), null);
  assert.equal(option.getAttribute("data-glossa-label"), null);
  renderer.restoreAll();
  assert.equal(option.textContent, "Sala nueva");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// Form fields are the page's own live widgets. Nothing in them may reach the engine, the sentence
// around them keeps its context and its protection, replace mode puts the live field back, and no
// copy of anything may hold a second, dead control or repeat a page id.

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

function byId(id: string) {
  return window.document.getElementById(id) as unknown as HTMLElement;
}

function units(body: Element) {
  return collectSegments(body, options).flatMap((segment) => (segment.kind === "element" ? [segment] : []));
}

// Every segment rendered with an answer that keeps the markup it was given, the way the engine
// does, so what ends up in the page is exactly what the renderer builds from each unit.
function translateAll(body: Element, mode = bilingual) {
  const segments = collectSegments(body, options);
  const renderer = new Renderer();
  for (const segment of segments) {
    renderer.apply(segment, `EN ${segment.kind === "element" ? segment.html : segment.text}`, mode);
  }
  return { segments, renderer };
}

test("a paragraph holding nothing but a textarea sends nothing and copies nothing", () => {
  const body = load(`<p id="compose"><textarea id="message">Hola, quiero reservar una sala de lectura para el martes.</textarea></p>`);
  const { segments } = translateAll(body);
  assert.ok(!segments.some((segment) => /reservar/.test(segment.text)), "the field's text went to the engine");
  assert.equal(window.document.querySelectorAll("textarea").length, 1, "the textarea was copied");
  assert.equal(byId("message").textContent, "Hola, quiero reservar una sala de lectura para el martes.");
});

test("a sentence keeps its fields as empty numbered slots, with nothing of theirs sent", () => {
  const body = load(
    `<p id="attrs">Consulta los <a id="tip" href="#h">horarios</a> y elige una sala ` +
      `<select id="room" name="sala"><option>Sala de lectura</option><option value="infantil">Sala infantil</option></select> ` +
      `o busca <input id="search" type="search" name="q" value="texto del usuario" placeholder="Buscar en el catálogo"> ` +
      `<input type="hidden" name="token" value="a1b2c3d4e5f6"> antes de <button id="go" type="button">Reservar la sala</button>.</p>`
  );
  const [unit, ...rest] = units(body);
  assert.ok(unit, "the paragraph is still one unit");
  assert.equal(rest.length, 0, "the sentence was split");
  for (const secret of ["Sala de lectura", "texto del usuario", "a1b2c3d4e5f6", "Buscar en el catálogo"]) {
    assert.ok(!unit.html.includes(secret), `"${secret}" went to the engine: ${unit.html}`);
  }
  // Field names and values are the form's, not prose ("sala" and "token" here), and go nowhere.
  assert.ok(!/<(input|select|textarea)\b[^>]*\b(name|value|placeholder|type)=/i.test(unit.html), `a field kept its attributes: ${unit.html}`);
  assert.match(unit.html, /<select data-glossa-id="\d+"><\/select>/, "the select is not an empty numbered slot");
  assert.ok(!/Sala de lectura/.test(unit.text), "the unit's text counts the options");
  assert.match(unit.html, /Reservar la sala/, "a button's label is prose and is sent");
});

test("a url, an address and a reference number stay protected in a sentence with a control", () => {
  const body = load(
    `<p id="contact">Escribe a info@ejemplo.es o visita https://ejemplo.es/catalogo?sala=3 con el expediente 2026123456 ` +
      `<button type="button">Enviar</button></p>`
  );
  const [unit] = units(body);
  assert.ok(unit, "the paragraph is not a unit");
  assert.ok(unit.holds.length >= 3, `only ${unit.holds.length} protected runs`);
  const outsideHolds = unit.html.replace(/<var [^>]*data-glossa-hold[^>]*>[\s\S]*?<\/var>/g, "");
  for (const literal of ["info@ejemplo.es", "https://ejemplo.es", "2026123456"]) {
    assert.ok(!outsideHolds.includes(literal), `${literal} reached the engine unprotected`);
  }
});

test("bilingual copies hold no fields and no dead buttons, and the page's controls stay single", () => {
  const body = load(
    `<p id="attrs">Consulta los <a id="tip" href="#h">horarios de la biblioteca</a> y elige una sala para tu visita: ` +
      `<select id="room"><option>Sala de lectura</option></select> <input id="search" type="search"> ` +
      `<button id="go" type="button">Reservar la sala</button></p>`
  );
  translateAll(body);
  const doc = window.document;
  assert.equal(doc.querySelectorAll("select").length, 1, "the select was copied");
  assert.equal(doc.querySelectorAll("input").length, 1, "the input was copied");
  assert.equal(doc.querySelectorAll("button").length, 1, "the button was copied");
  assert.equal(doc.querySelectorAll("#tip").length, 1, "the link's id was repeated");
  const copy = doc.querySelector("glossa-translation");
  assert.ok(copy, "no translation was shown");
  assert.match(copy.textContent ?? "", /Reservar la sala/, "the button's label was lost from the copy");
});

test("replace mode puts the page's own select back, with its options and its choice", () => {
  const body = load(
    `<p id="q">Elige una sala <select id="room"><option>Sala de lectura</option><option value="infantil">Sala infantil</option></select> para tu visita de mañana.</p>`
  );
  const live = byId("room") as unknown as { value: string; options: { length: number } };
  live.value = "infantil";
  const [unit] = units(body);
  assert.ok(unit);
  const renderer = new Renderer();
  const slot = /<select data-glossa-id="\d+"><\/select>/.exec(unit.html)?.[0] ?? "";
  renderer.apply(unit, `Choose a room ${slot} for your visit tomorrow.`, replace);
  assert.equal(byId("room") as unknown, live, "the select was replaced by a copy");
  assert.equal(live.options.length, 2, "the select lost its options");
  assert.equal(live.value, "infantil", "the reader's choice was lost");
  assert.match(byId("q").textContent ?? "", /Choose a room/);
  assert.equal(window.document.querySelectorAll("[data-glossa-id]").length, 0, "numbers were left on the page, inside the select");
  renderer.restoreAll();
  assert.equal(byId("room") as unknown, live);
  assert.match(byId("q").textContent ?? "", /Elige una sala/);
  assert.equal(live.value, "infantil");
});

test("when the engine drops a field, the unit is shown bilingually and the field stays", () => {
  const body = load(
    `<p id="q">Elige una sala <select id="room"><option>Sala de lectura</option></select> para tu visita de mañana por la tarde.</p>`
  );
  const live = byId("room");
  const [unit] = units(body);
  assert.ok(unit);
  new Renderer().apply(unit, "Choose a room for your visit tomorrow afternoon.", replace);
  assert.equal(byId("room"), live, "the page's select was taken off the page");
  assert.match(byId("q").childNodes[0]?.textContent ?? "", /Elige una sala/, "the original was replaced anyway");
  assert.ok(window.document.querySelector("#q glossa-translation"), "the translation was not shown");
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
  const [unit] = units(body);
  assert.ok(unit);
  new Renderer().apply(
    unit,
    'Hello <b id="fuerte" data-glossa-id="0">world</b> and <b id="fuerte" data-glossa-id="0">goodbye</b> everyone.',
    replace
  );
  assert.equal(window.document.querySelectorAll("#r b").length, 2, "the repeated element was dropped");
  assert.equal(window.document.querySelectorAll("#fuerte").length, 1, "the repeated element carried the page's id");
});

// Replace, then show the original: the page has to be exactly what it was, node for node, with
// every field still where it was and still holding what the reader put in it.
function replaceAndRestore(html: string, fieldId: string, touch: (field: HTMLElement) => void) {
  load(html);
  const field = byId(fieldId);
  touch(field);
  const original = byId("q").outerHTML;
  const [unit] = units(window.document.body as unknown as Element);
  assert.ok(unit, "the paragraph is not a unit");
  const renderer = new Renderer();
  renderer.apply(unit, unit.html.replace(/^(\s*)(\S+)/, "$1EN"), replace);
  assert.match(byId("q").textContent ?? "", /^EN/, "replace mode did not run");
  renderer.restoreAll();
  assert.equal(byId(fieldId), field, "the field is not the page's own any more");
  assert.equal(field.isConnected, true, "restoring took the field off the page");
  assert.equal(byId("q").outerHTML, original, "the paragraph did not come back as it was");
  return field;
}

test("a checkbox inside a label is back in its label, still ticked, after showing the original", () => {
  const field = replaceAndRestore(
    `<p id="q">Marca la casilla <label id="l">aquí mismo <input id="c" type="checkbox"></label> para aceptar las condiciones.</p>`,
    "c",
    (input) => {
      (input as unknown as { checked: boolean }).checked = true;
    }
  );
  assert.equal((field as unknown as { checked: boolean }).checked, true, "the tick was lost");
  assert.equal(byId("l").contains(field), true);
});

test("a field inside a button, or inside a link inside a span, comes back where it was", () => {
  replaceAndRestore(
    `<p id="q">Pulsa <button id="btn" type="button">Aceptar <input id="n" type="number"></button> para seguir leyendo la página.</p>`,
    "n",
    () => undefined
  );
  const typed = replaceAndRestore(
    `<p id="q">Hola <span id="s"><a id="a" href="#x">enlace <input id="t" type="text"></a></span> y adiós a todos.</p>`,
    "t",
    (input) => {
      (input as unknown as { value: string }).value = "lo que escribí";
    }
  );
  assert.equal((typed as unknown as { value: string }).value, "lo que escribí", "what was typed was lost");
});

test("a bold word inside a link is back inside the link after showing the original", () => {
  load(`<p id="q">Una <a id="a" href="#x">casa <b id="b">muy</b> grande</a> junto al río.</p>`);
  const original = byId("q").outerHTML;
  const [unit] = units(window.document.body as unknown as Element);
  assert.ok(unit);
  const renderer = new Renderer();
  renderer.apply(unit, unit.html.replace("Una", "A"), replace);
  renderer.restoreAll();
  assert.equal(byId("q").outerHTML, original);
  assert.equal(byId("a").contains(byId("b")), true, "the bold word left the link");
});

test("a field slot the engine repeats in replace mode leaves one field, the page's own", () => {
  load(`<p id="q">Elige una sala <select id="room"><option>Sala de lectura</option></select> para la visita de mañana.</p>`);
  const live = byId("room");
  const [unit] = units(window.document.body as unknown as Element);
  assert.ok(unit);
  const slot = /<select data-glossa-id="\d+"><\/select>/.exec(unit.html)?.[0] ?? "";
  new Renderer().apply(unit, `Choose ${slot} a room ${slot} for tomorrow's visit.`, replace);
  assert.equal(window.document.querySelectorAll("select").length, 1, "the repeated slot became a second select");
  assert.equal(byId("room"), live);
});

// The engine is free to drop an element's tags and keep what was inside. Whatever was inside still
// has to go back into it when the original is shown.
function dropTagsThenRestore(html: string, tag: string): string {
  load(html);
  const original = byId("q").outerHTML;
  const [unit] = units(window.document.body as unknown as Element);
  assert.ok(unit, "the paragraph is not a unit");
  const renderer = new Renderer();
  const answer = unit.html.replace(new RegExp(`</?${tag}\\b[^>]*>`, "g"), "").replace(/^(\s*)(\S+)/, "$1EN");
  renderer.apply(unit, answer, replace);
  assert.match(byId("q").textContent ?? "", /^EN/, "replace mode did not run");
  renderer.restoreAll();
  return original;
}

test("a field whose label the engine dropped is back in its label after showing the original", () => {
  const original = dropTagsThenRestore(
    `<p id="q">Escribe <label id="l">tu nombre completo <input id="i" value="x"></label> para la reserva de mañana.</p>`,
    "label"
  );
  assert.equal(byId("i").isConnected, true, "the field was left off the page");
  assert.equal(byId("l").contains(byId("i")), true, "the field was left outside its label");
  assert.equal(byId("q").outerHTML, original);
});

test("a bold word whose link the engine dropped is back in its link after showing the original", () => {
  const original = dropTagsThenRestore(`<p id="q">Lee <a id="a" href="#m">el <b id="b">manual</b> completo</a> antes de empezar a trabajar.</p>`, "a");
  assert.equal(byId("a").contains(byId("b")), true, "the bold word was left outside its link");
  assert.equal(byId("q").outerHTML, original);
});

test("a protected element the engine repeats in replace mode does not repeat the page's id", () => {
  const body = load(`<p id="b">Nuestro patrocinador es <span translate="no" id="brand">Café Aurora</span>, en la plaza mayor.</p>`);
  const [unit] = units(body);
  assert.ok(unit && unit.holds.length === 1);
  const placeholder = /<var [^>]*data-glossa-hold[^>]*>[\s\S]*?<\/var>/.exec(unit.html)?.[0] ?? "";
  assert.ok(placeholder, "no placeholder in the unit");
  new Renderer().apply(unit, `Our sponsor is ${placeholder}, yes ${placeholder}, in the main square.`, replace);
  assert.equal(window.document.querySelectorAll("#b span").length, 2, "the repeated element was dropped");
  assert.equal(window.document.querySelectorAll("#brand").length, 1, "the repeat carried the page's id");
});

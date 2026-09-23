import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// The attribute pass has to cost what changed. A flush over a subtree whose tooltips, image text and
// labels are already translated used to ask every element about every attribute again, a dozen
// calls apiece, which a page that toggles `hidden` on a large wrapper paid every 250 ms.

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

const { collectFromNodes, collectSegments } = await import("../src/content/segmenter.ts");
const { Renderer } = await import("../src/content/renderer.ts");

// Every question the pass can put to an element about its attributes or its ancestors.
const COUNTED = ["hasAttribute", "getAttribute", "getAttributeNames", "closest", "matches"] as const;
let calls = 0;
const prototype = window.Element.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of COUNTED) {
  const original = prototype[name]!;
  prototype[name] = function (this: unknown, ...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  };
}

// A feed of 100 posts, each with an avatar, a profile link, a timestamp, a message with a link, and
// three icon buttons: about 2,000 elements, most of them carrying something a reader sees.
function feed(): Element {
  const post = (index: number) => `
    <article>
      <header><div><img alt="Foto de perfil de Ana" src="a.png"><a href="/ana" title="Ver el perfil de Ana"><span>Ana</span></a>
        <time title="Publicado hace dos horas">2 h</time></div></header>
      <p>Este es el mensaje número ${index} con un <a href="/x" title="Abrir el enlace completo">enlace</a> dentro.</p>
      <footer><div>
        <button aria-label="Me gusta esta publicación"><i></i></button>
        <button aria-label="Responder a la publicación"><i></i></button>
        <button aria-label="Compartir la publicación"><i></i></button>
        <span><b></b><b></b><b></b></span>
      </div></footer>
    </article>`;
  window.document.body.innerHTML = `<main id="feed">${Array.from({ length: 100 }, (_, index) => post(index)).join("")}</main>`;
  return window.document.getElementById("feed") as unknown as Element;
}

// What the attribute pass alone costs: the same collection with and without it. The unit walk is
// the same either way, and in happy-dom it is inflated anyway (no `translate` property, and an
// `isContentEditable` that reads attributes up the tree), where a browser answers both natively.
function attributePassCalls(collect: (attributes: boolean) => unknown[]): { calls: number; segments: unknown[] } {
  calls = 0;
  collect(false);
  const walk = calls;
  calls = 0;
  const segments = collect(true);
  return { calls: calls - walk, segments };
}

test("a second flush over a translated subtree asks under a tenth of what the first one did", () => {
  const root = feed();
  const elements = root.querySelectorAll("*").length;
  assert.ok(elements >= 1_900, `the feed has only ${elements} elements`);
  const options = { skipFormFields: true };

  const first = attributePassCalls((attributes) => collectSegments(root, { ...options, attributes }));
  const firstSegments = first.segments as ReturnType<typeof collectSegments>;
  assert.equal(firstSegments.filter((segment) => segment.kind === "attribute").length, 700, "the tooltips, image text and button labels were not all collected");

  // Translate everything the first flush found, the way the page would be after it.
  const renderer = new Renderer();
  const bilingual = { displayMode: "bilingual" as const, showOriginalOnHover: false, targetLanguage: "en" };
  for (const segment of firstSegments) renderer.apply(segment, segment.kind === "element" ? segment.html : `EN ${segment.text}`, bilingual);

  // The page hides and shows the whole feed: the observer hands the wrapper back as a root.
  const second = attributePassCalls((attributes) => collectFromNodes([root], { ...options, attributes }));
  assert.equal(
    (second.segments as ReturnType<typeof collectFromNodes>).filter((segment) => segment.kind === "attribute").length,
    0,
    "a translated attribute was collected again"
  );
  console.info(`attribute pass over ${elements} elements: first flush ${first.calls} calls, second ${second.calls}`);
  assert.ok(second.calls * 10 < first.calls, `the second flush made ${second.calls} calls against ${first.calls} for the first`);
});

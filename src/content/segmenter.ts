// Turns a live DOM into translation units. A unit is either an element whose children are all
// inline (a paragraph, a list item, a heading, a table cell) or a bare text node sitting next to
// block children. Splitting at block boundaries rather than at every inline element is what keeps
// sentences intact through links and emphasis; Bergamot's HTML mode carries the inline tags
// through the translation.

export const UNIT_ATTRIBUTE = "data-glossa-unit";
export const TRANSLATION_CLASS = "glossa-t";
export const TRANSLATION_TAG = "GLOSSA-TRANSLATION";

export type Segment =
  | { kind: "element"; element: Element; html: string; text: string; holds: Hold[] }
  | { kind: "text"; node: Text; text: string };

// What a placeholder stands for: an inline element the page marked as untranslatable, or a run of
// text inside a sentence (a URL, an address, a reference number) that has to come back unchanged.
export type Hold = Element | Text;

// Inline elements inside a unit that must survive untouched. Bergamot copies `code`, `kbd`,
// `samp`, `var` and `math` through verbatim on its own; translate="no" and .notranslate are DOM
// conventions it knows nothing about, so those are swapped for a `var` placeholder before the
// fragment leaves the page and swapped back when the translation returns.
const HOLD_SELECTOR = '[translate="no" i], .notranslate';
export const HOLD_ATTRIBUTE = "data-glossa-hold";

// Elements whose contents are never translated, either because the text is not prose or because
// changing it would break the page.
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "OPTGROUP",
  "CODE", "PRE", "KBD", "SAMP", "VAR", "MATH", "SVG", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT",
  "EMBED", "HEAD", "TITLE", "META", "LINK", "BASE", "PARAM", "SOURCE", "TRACK", "WBR", "PROGRESS", "METER",
  TRANSLATION_TAG
]);

// Tags that start a new block. Any element with one of these as a direct child is a container,
// not a unit. Presentation-driven blocks (a span styled display:block) are caught by the fallback
// check on the computed style for large containers only, to keep the walk cheap.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "CENTER", "COL", "COLGROUP", "DD",
  "DETAILS", "DIALOG", "DIR", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "FRAMESET", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "HTML", "LEGEND", "LI",
  "MAIN", "MENU", "NAV", "OL", "P", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD",
  "TR", "UL", "PRE", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "SVG"
]);

// Replaced or inline-by-default elements. They appear in BLOCK_TAGS because a direct child of that
// kind splits a unit, but an icon buried inside a link must not turn the paragraph around it into a
// container, so the deep search below ignores them.
const INLINE_BY_DEFAULT = new Set(["SVG", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "COL", "COLGROUP"]);

const BLOCK_SELECTOR = Array.from(BLOCK_TAGS)
  .filter((tag) => !INLINE_BY_DEFAULT.has(tag))
  .map((tag) => tag.toLowerCase())
  .join(",");

// Units in these tags read as paragraphs and get the bilingual (translation below) treatment.
export const PARAGRAPH_TAGS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "DD", "DT", "FIGCAPTION", "SUMMARY",
  "CAPTION", "ADDRESS", "ARTICLE", "SECTION", "DIV", "TD", "TH"
]);

const LETTER = /\p{L}/u;

export interface SegmentOptions {
  skipFormFields: boolean;
  // Candidates passed over because they are not rendered yet (a `hidden` attribute, display:none,
  // a closed `<details>`). They are collected here so the observer can re-check exactly those
  // elements when a class or style changes instead of walking the page again.
  deferred?: Set<Element>;
}

export function collectSegments(root: Node, options: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  walk(root, out, options);
  return out;
}

// Same walk, but starting from a list of nodes (the added nodes of a mutation record), so the
// nodes themselves can become units rather than only their children.
export function collectFromNodes(nodes: Node[], options: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  visit(nodes, out, options);
  return out;
}

function walk(root: Node, out: Segment[], options: SegmentOptions): void {
  visit(Array.from(root.childNodes), out, options);
}

function visit(children: Node[], out: Segment[], options: SegmentOptions): void {
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child as Text;
      if (LETTER.test(text.data) && !isMarkedText(text)) {
        out.push({ kind: "text", node: text, text: text.data });
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    if (shouldSkip(element, options)) {
      if ((element as HTMLElement).hidden) options.deferred?.add(element);
      continue;
    }

    if (element.shadowRoot) {
      walk(element.shadowRoot, out, options);
    }
    if (isContainer(element)) {
      walk(element, out, options);
      continue;
    }
    const text = element.textContent ?? "";
    if (!LETTER.test(text)) continue;
    if (!isRenderable(element)) {
      options.deferred?.add(element);
      continue;
    }
    const { html, holds } = serializeUnit(element);
    out.push({ kind: "element", element, html, text, holds });
  }
}

// Serialise a unit for the engine. Protected inline descendants become `var` placeholders that
// Bergamot passes through untouched; the originals are returned so the renderer can put them
// back by index. Clone and original are walked with the same selector, so indexes line up.
export function serializeUnit(element: Element): { html: string; holds: Hold[] } {
  const holds: Hold[] = Array.from(element.querySelectorAll(HOLD_SELECTOR));
  const source = element.textContent ?? "";
  if (holds.length === 0 && !PROTECTED_TEXT.test(source)) {
    return { html: element.innerHTML, holds };
  }
  const clone = element.cloneNode(true) as Element;
  const cloneHolds = Array.from(clone.querySelectorAll(HOLD_SELECTOR));
  cloneHolds.forEach((held, index) => {
    // A protected element nested in another protected element is already covered by its parent.
    if (held.parentElement?.closest(HOLD_SELECTOR)) return;
    const placeholder = clone.ownerDocument.createElement("var");
    placeholder.setAttribute(HOLD_ATTRIBUTE, String(index));
    placeholder.textContent = held.textContent ?? "";
    held.replaceWith(placeholder);
  });
  protectText(clone, holds);
  return { html: clone.innerHTML, holds };
}

// Runs of text the engine must not touch. It has been seen putting a space inside a query string
// (`ruta? x=1`) and translating the domain of an email address (`ejemplo` to `example`), and long
// digit runs come back duplicated. Short numbers stay in the sentence: a model that cannot see
// "5 libros" has no way to get the agreement right.
const PROTECTED_TEXT =
  /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|www\.[a-z0-9][^\s<>"']*|[^\s<>"'@,;:()[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}|\d{4,}|\d+(?:[.,:/-]\d+){2,}/giu;

// Text-level holds, applied to the clone only. Each match becomes the same `var` placeholder an
// untranslatable element gets, and the exact original characters are kept to be put back.
function protectText(clone: Element, holds: Hold[]): void {
  const doc = clone.ownerDocument;
  const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    // Anything already protected, verbatim by the engine or by a placeholder, is left alone.
    if (text.parentElement?.closest(`var, code, kbd, samp, math, ${HOLD_SELECTOR}`)) continue;
    PROTECTED_TEXT.lastIndex = 0;
    if (!PROTECTED_TEXT.test(text.data)) continue;
    PROTECTED_TEXT.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (let match = PROTECTED_TEXT.exec(text.data); match; match = PROTECTED_TEXT.exec(text.data)) {
      if (match.index > cursor) fragment.append(doc.createTextNode(text.data.slice(cursor, match.index)));
      const placeholder = doc.createElement("var");
      placeholder.setAttribute(HOLD_ATTRIBUTE, String(holds.length));
      placeholder.textContent = match[0];
      holds.push(doc.createTextNode(match[0]));
      fragment.append(placeholder);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.data.length) fragment.append(doc.createTextNode(text.data.slice(cursor)));
    text.replaceWith(fragment);
  }
}

export function shouldSkip(element: Element, options: SegmentOptions): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute(UNIT_ATTRIBUTE)) return true;
  if (element.classList.contains(TRANSLATION_CLASS)) return true;
  if (element.classList.contains("notranslate")) return true;
  const html = element as HTMLElement;
  // `translate` reflects the inherited translate="no" state, which covers ancestors too. Older
  // DOM implementations lack the property, so fall back to walking the ancestors.
  if ("translate" in html) {
    if (html.translate === false) return true;
  } else if (element.closest('[translate="no" i]')) {
    return true;
  }
  if (html.hidden) return true;
  if (options.skipFormFields && html.isContentEditable) return true;
  if (element.getAttribute("aria-hidden") === "true" && !element.querySelector("*")) return true;
  return false;
}

function isContainer(element: Element): boolean {
  for (const child of element.children) {
    if (BLOCK_TAGS.has(child.tagName)) return true;
    if (child.shadowRoot) return true;
    // An inline wrapper whose subtree holds blocks: card grids are built as `div > a > div`, and
    // sending the wrapper as one unit makes bilingual mode append a second copy of every card
    // inside it. Firefox recurses for the same reason (nodeNeedsSubdividing).
    if (child.querySelector(BLOCK_SELECTOR)) return true;
  }
  return false;
}

// Skip units that are laid out invisible. checkVisibility accounts for ancestor display:none and
// content-visibility, which is exactly the class of hidden menus and templates we want to defer
// until the observer sees them appear.
function isRenderable(element: Element): boolean {
  const probe = element as Element & { checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean };
  if (typeof probe.checkVisibility === "function") {
    return probe.checkVisibility({ checkVisibilityCSS: true });
  }
  return true;
}

function isMarkedText(node: Text): boolean {
  const next = node.nextSibling;
  return Boolean(next && next.nodeType === Node.ELEMENT_NODE && (next as Element).tagName === TRANSLATION_TAG);
}

// Batch segments so each request carries a bounded amount of text. Viewport-first ordering makes
// the visible part of the page change before the rest.
export function orderViewportFirst(segments: Segment[]): Segment[] {
  const viewportHeight = window.innerHeight || 800;
  const inView: Segment[] = [];
  const later: Segment[] = [];
  for (const segment of segments) {
    const element = segment.kind === "element" ? segment.element : segment.node.parentElement;
    if (!element) {
      later.push(segment);
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.bottom >= 0 && rect.top <= viewportHeight) {
      inView.push(segment);
    } else {
      later.push(segment);
    }
  }
  return inView.concat(later);
}

export function batchSegments(segments: Segment[], maxItems = 24, maxChars = 6000): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let chars = 0;
  for (const segment of segments) {
    const length = segment.kind === "element" ? segment.html.length : segment.text.length;
    if (current.length > 0 && (current.length >= maxItems || chars + length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function segmentFragment(segment: Segment): string {
  return segment.kind === "element" ? segment.html : escapeHtml(segment.text);
}

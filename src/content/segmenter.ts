// Turns a live DOM into translation units. A unit is either an element whose children are all
// inline (a paragraph, a list item, a heading, a table cell) or a bare text node sitting next to
// block children. Splitting at block boundaries rather than at every inline element is what keeps
// sentences intact through links and emphasis; Bergamot's HTML mode carries the inline tags
// through the translation.

export const UNIT_ATTRIBUTE = "data-glossa-unit";
export const TRANSLATION_CLASS = "glossa-t";
export const TRANSLATION_TAG = "GLOSSA-TRANSLATION";

export type Segment =
  | { kind: "element"; element: Element; html: string; text: string; holds: Hold[]; lang: string | null }
  | { kind: "text"; node: Text; text: string; lang: string | null }
  // An attribute a user can read: a tooltip, a placeholder, the text an image stands in for.
  | { kind: "attribute"; element: Element; attribute: string; text: string; lang: string | null }
  // An element whose plain text is the whole of it: an <option>, or the document's <title>.
  | { kind: "label"; element: Element; text: string; lang: string | null };

// What a placeholder stands for: an inline element the page marked as untranslatable, or a run of
// text inside a sentence (a URL, an address, a reference number) that has to come back unchanged.
// What a placeholder stands for: an untranslatable element, a protected run inside one text node,
// or a protected run the page split across inline tags, held as the fragment of nodes it touches.
export type Hold = Element | Text | DocumentFragment;

// Inline elements inside a unit that must survive untouched. Bergamot copies `code`, `kbd`,
// `samp`, `var` and `math` through verbatim on its own; translate="no" and .notranslate are DOM
// conventions it knows nothing about, so those are swapped for a `var` placeholder before the
// fragment leaves the page and swapped back when the translation returns.
const HOLD_SELECTOR = '[translate="no" i], .notranslate';
export const HOLD_ATTRIBUTE = "data-glossa-hold";

// Every element inside a unit is numbered before the unit is sent. The engine carries data-*
// attributes through untouched, so the translation comes back saying which of the page's own
// elements each piece belongs to, and replace mode can put the text into those elements rather
// than into copies of them. A copy looks identical and behaves differently: its click handlers,
// its framework bindings and its focus are all gone. Firefox does the same thing with
// data-moz-translations-id.
export const ID_ATTRIBUTE = "data-glossa-id";

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

// What Firefox translates, and where. Anything not on this list is left alone: `value` on a text
// input is what the user typed, `alt` on a spacer is empty, and `title` on a link to a file is
// often a path. Taken from TRANSLATABLE_ATTRIBUTES in translations-document.sys.mjs.
const ARIA_TEXT_ATTRIBUTES = [
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "aria-braillelabel",
  "aria-brailleroledescription",
  "aria-colindextext",
  "aria-rowindextext"
];

const TRANSLATABLE_ATTRIBUTES: Array<{ attribute: string; applies: (element: Element) => boolean }> = [
  { attribute: "title", applies: () => true },
  { attribute: "alt", applies: (element) => ["AREA", "IMG", "IMAGE", "INPUT"].includes(element.tagName) },
  { attribute: "placeholder", applies: (element) => ["INPUT", "TEXTAREA"].includes(element.tagName) },
  {
    // Only on a button that submits nothing. A submit button's value is both its label and the
    // value the form posts, and a server that branches on it would see a different answer.
    attribute: "value",
    applies: (element) =>
      element.tagName === "INPUT" && ["button", "reset"].includes((element.getAttribute("type") ?? "").toLowerCase())
  },
  // The visible label of a group of options, and of an option that carries one.
  { attribute: "label", applies: (element) => element.tagName === "OPTGROUP" || element.tagName === "OPTION" },
  ...ARIA_TEXT_ATTRIBUTES.map((attribute) => ({ attribute, applies: () => true }))
];

export interface SegmentOptions {
  skipFormFields: boolean;
  // Attributes and labels are collected unless this is explicitly false. Used by the selection
  // path, which is about the text a user highlighted and nothing around it.
  attributes?: boolean;
  // Candidates passed over because they are not rendered yet (a `hidden` attribute, display:none,
  // a closed `<details>`). They are collected here so the observer can re-check exactly those
  // elements when a class or style changes instead of walking the page again.
  deferred?: Set<Element>;
}

export function collectSegments(root: Node, options: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  walk(root, out, options);
  // Attributes are a separate pass over the whole subtree. The unit walk stops at the first block
  // that is a unit, and the placeholder of an input inside that block still has to be found.
  if (options.attributes !== false) collectReadableAttributes(root, out, options);
  return out;
}

// Same walk, but starting from a list of nodes (the added nodes of a mutation record), so the
// nodes themselves can become units rather than only their children.
export function collectFromNodes(nodes: Node[], options: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  visit(nodes, out, options);
  if (options.attributes !== false) {
    for (const node of nodes) collectReadableAttributes(node, out, options);
  }
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
        out.push({ kind: "text", node: text, text: text.data, lang: effectiveLang(text.parentElement) });
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
    const text = unitText(element);
    if (!LETTER.test(text)) continue;
    if (!isRenderable(element)) {
      options.deferred?.add(element);
      continue;
    }
    const { html, holds } = serializeUnit(element);
    // A block that is nothing but a url or a reference number has no prose left once the
    // placeholders are in; sending it wastes a round trip and risks the engine rewriting it.
    if (holds.length > 0 && !LETTER.test(textOutsideHolds(html))) continue;
    out.push({ kind: "element", element, html, text, holds, lang: effectiveLang(element) });
  }
}

// Every element under this root that carries something a person reads. Elements the page marked as
// untranslatable are skipped whole, and so is anything already translated.
function collectReadableAttributes(root: Node, out: Segment[], options: SegmentOptions): void {
  // A text node has no attributes and no descendants. It arrives here from the observer, which
  // queues raw text nodes, and asking it for querySelectorAll used to throw and take the whole
  // flush with it: the stale units it had already dropped records for were then unrestorable.
  const scope =
    root.nodeType === Node.ELEMENT_NODE
      ? (root as Element)
      : root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? (root as Document | DocumentFragment)
        : null;
  if (!scope) return;

  const candidates: Element[] = [];
  if (root.nodeType === Node.ELEMENT_NODE) candidates.push(root as Element);
  candidates.push(...Array.from(scope.querySelectorAll("*")));
  for (const element of candidates) {
    // Anything inside our own output, or inside a block already translated, is not source text.
    // The `title` a replace-mode unit carries is the original this extension parked there, and
    // translating that is how the show-original-on-hover feature quietly disappears.
    if (element.closest(SKIP_ATTRIBUTE_SCOPE)) continue;
    if (isProtected(element)) continue;
    if (options.skipFormFields && (element as HTMLElement).isContentEditable) continue;
    collectAttributes(element, out);
    // A shadow root is part of the page too, and querySelectorAll does not cross into one.
    if (element.shadowRoot) collectReadableAttributes(element.shadowRoot, out, options);
    if (element.tagName !== "OPTION" && element.tagName !== "TITLE") continue;
    // A datalist option is a suggestion the browser inserts by value, so translating its text
    // changes what gets typed into the field rather than what the user reads.
    if (element.tagName === "OPTION" && element.closest("datalist")) continue;
    const label = (element.textContent ?? "").trim();
    if (!label || !LETTER.test(label)) continue;
    if (element.hasAttribute(LABEL_MARKER)) continue;
    out.push({ kind: "label", element, text: label, lang: effectiveLang(element) });
  }
}

// Subtrees the attribute pass never enters. Everything here is either Glossa's own output or a
// block it has already been through.
const SKIP_ATTRIBUTE_SCOPE = `${TRANSLATION_TAG.toLowerCase()}, .${TRANSLATION_CLASS}, [${UNIT_ATTRIBUTE}], [hidden]`;

export const LABEL_MARKER = "data-glossa-label";

// Every attribute marker plus the label marker, as a selector. Restoring sweeps these rather than
// trusting its own records: an element cloned by the page after translation carries the marker into
// the copy, where no record has ever heard of it.
export const MARKER_SELECTOR = [
  ...new Set(TRANSLATABLE_ATTRIBUTES.map(({ attribute }) => `[${attributeMarker(attribute)}]`)),
  `[${LABEL_MARKER}]`
].join(", ");

// Every attribute name Glossa can translate, for an observer that has to notice a page rewriting one.
export const READABLE_ATTRIBUTES: readonly string[] = [
  ...new Set(TRANSLATABLE_ATTRIBUTES.map(({ attribute }) => attribute))
];

// One attribute the page just set, judged by the same rules as the full pass. It does not skip
// elements inside a translated block, because the page rewriting a tooltip in there is exactly the
// case this exists for, and the full pass would never look.
export function attributeSegment(element: Element, attribute: string, options: SegmentOptions): Segment | null {
  if (!TRANSLATABLE_ATTRIBUTES.some((entry) => entry.attribute === attribute && entry.applies(element))) return null;
  if (element.closest(`${TRANSLATION_TAG.toLowerCase()}, .${TRANSLATION_CLASS}`)) return null;
  if (isProtected(element)) return null;
  if (options.skipFormFields && (element as HTMLElement).isContentEditable) return null;
  if (element.hasAttribute(attributeMarker(attribute))) return null;
  const text = element.getAttribute(attribute)?.trim() ?? "";
  if (text.length < 2 || !LETTER.test(text)) return null;
  return { kind: "attribute", element, attribute, text, lang: effectiveLang(element) };
}

function collectAttributes(element: Element, out: Segment[]): void {
  for (const { attribute, applies } of TRANSLATABLE_ATTRIBUTES) {
    if (!element.hasAttribute(attribute) || !applies(element)) continue;
    const text = element.getAttribute(attribute)?.trim() ?? "";
    // Nothing to say, or nothing that reads as language: a url, a token, a single letter.
    if (text.length < 2 || !LETTER.test(text)) continue;
    if (element.hasAttribute(attributeMarker(attribute))) continue;
    out.push({ kind: "attribute", element, attribute, text, lang: effectiveLang(element) });
  }
}

// Where the original value of a translated attribute is kept, so restoring needs no bookkeeping
// beyond the page itself and a reload cannot leave a half-translated tooltip behind.
export function attributeMarker(attribute: string): string {
  return `data-glossa-was-${attribute.replace(/[^a-z0-9-]/gi, "-")}`;
}

// Anything the page marked as untranslatable, checked without the rest of the skip rules: an input
// inside a `translate="no"` block still has a placeholder, and it still must not be touched.
function isProtected(element: Element): boolean {
  const html = element as HTMLElement;
  // `translate` reflects the inherited state, so it covers ancestors in one read. Only where the
  // property is missing does this have to walk, and then it walks once for both conventions.
  if ("translate" in html && html.translate === false) return true;
  return Boolean(element.closest('[translate="no" i], .notranslate'));
}

// The language this unit is written in, as the page declares it. A `lang` deeper in the tree wins
// over the one on `<html>`, which is the whole point: a quoted paragraph in another language must
// not go through the page's route.
function effectiveLang(start: Element | null): string | null {
  // A `lang` on one of our own replaced units is the target language we stamped there, not the
  // language of the page's content. Skipping those keeps new source text inside a translated block
  // from looking like it is already translated.
  const holder = start?.closest(`[lang]:not([${UNIT_ATTRIBUTE}])`);
  const value = holder?.getAttribute("lang")?.trim();
  return value ? value : null;
}

// Serialise a unit for the engine. Protected inline descendants become `var` placeholders that
// Bergamot passes through untouched; the originals are returned so the renderer can put them
// back by index. Clone and original are walked with the same selector, so indexes line up.
export function serializeUnit(element: Element): { html: string; holds: Hold[] } {
  stampIds(element);
  // A field is never a hold, and neither is anything inside one: fields are emptied below, and
  // original and clone have to be filtered the same way for the indexes to line up.
  const outsideFields = (held: Element) => !held.closest(FORM_FIELD_SELECTOR);
  const holds: Hold[] = Array.from(element.querySelectorAll(HOLD_SELECTOR)).filter(outsideFields);
  const hasFields = element.querySelector(FORM_FIELD_SELECTOR) !== null;
  const source = unitText(element);
  if (holds.length === 0 && !hasFields && !hasProtectedText(source)) {
    return { html: element.innerHTML, holds };
  }
  const clone = element.cloneNode(true) as Element;
  const cloneHolds = Array.from(clone.querySelectorAll(HOLD_SELECTOR)).filter(outsideFields);
  // Before any placeholder or protected-text scan, so neither ever sees what is in a field.
  emptyFields(clone);
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

function stampIds(element: Element): void {
  let index = 0;
  for (const child of element.querySelectorAll("*")) {
    // What is inside a field (a select's options) is never sent and never comes back, so it is not
    // numbered: a number left on the page's own option would outlive the translation.
    if (child.parentElement?.closest(FORM_FIELD_SELECTOR)) continue;
    child.setAttribute(ID_ATTRIBUTE, String(index++));
  }
}

// Take the numbering back off, which is what restoring a unit has to do.
export function clearIds(element: Element): void {
  element.removeAttribute(ID_ATTRIBUTE);
  for (const child of element.querySelectorAll(`[${ID_ATTRIBUTE}]`)) {
    child.removeAttribute(ID_ATTRIBUTE);
  }
}

// Runs of text the engine must not touch. It has been seen putting a space inside a query string
// (`ruta? x=1`) and translating the domain of an email address (`ejemplo` to `example`), and long
// digit runs come back duplicated. Short numbers stay in the sentence: a model that cannot see
// "5 libros" has no way to get the agreement right, and a number welded to letters (`RTX4090`) is
// part of a word, not a reference.
//
// The quantifiers are bounded. An unbroken 16k-character token (an inline data URI, a hash) makes an
// unbounded version backtrack for hundreds of milliseconds on the page's critical path.
const PROTECTED_PATTERN = [
  // scheme://rest, never ending on sentence punctuation
  "[a-z][a-z0-9+.-]{0,31}://[^\\s<>\"']{0,512}[^\\s<>\"'.,;:!?)\\]}]",
  // bare www host and path
  "www\\.[a-z0-9][^\\s<>\"']{0,512}[^\\s<>\"'.,;:!?)\\]}]",
  // local@domain.tld
  "[^\\s<>\"'@,;:()\\[\\]]{1,128}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\\.[a-z0-9-]{1,63})*\\.[a-z]{2,24}",
  // A grouped number comes first, so 2026-09-10 is one run rather than "2026" plus a tail. A letter
  // may sit in front of a group ("v1.2.3" is a version string), but a plain digit run welded to
  // letters is part of a word ("RTX4090"), so that one needs clear space on both sides.
  "\\d{1,16}(?:[.,:/-]\\d{1,16}){2,8}(?![\\p{L}\\p{N}])",
  "(?<![\\p{L}\\p{N}])\\d{4,32}(?![\\p{L}\\p{N}])"
].join("|");

// Two regexes over one pattern on purpose. A `/g` regex carries `lastIndex` between calls, and a
// `test()` that leaves it set makes the next unit's scan start in the middle of its text and miss
// everything before it. The gate is stateless; only the scanner is global.
const PROTECTED_GATE = new RegExp(PROTECTED_PATTERN, "iu");
const PROTECTED_SCANNER = new RegExp(PROTECTED_PATTERN, "giu");

// Where the source text had whitespace next to a placeholder, so the renderer knows which side may
// get a space back when the engine drops it. "v1.2.3" must not come back as "v 1.2.3".
export const PAD_ATTRIBUTE = "data-glossa-pad";

export function hasProtectedText(text: string): boolean {
  return PROTECTED_GATE.test(text);
}

// Elements that end a run of text for this purpose. A line break, an image or a form field sits
// between two words; a <wbr>, <b> or <span> inside a url does not.
const RUN_BREAK_TAGS = new Set(["BR", "HR", "IMG", "INPUT", "SELECT", "TEXTAREA", "BUTTON"]);

// A url, address or number the page wrapped partly in an inline tag (`https://ejemplo.<b>es</b>`,
// or a <wbr> for line breaking) is only visible in the unit's joined text: scanned one text node at
// a time, the tail inside the tag reaches the engine as prose. Each such run becomes one placeholder
// holding every node it touches, inline tags included, so the engine gets none of it and the tags
// come back intact. A run inside a single text node is left to the per-node pass that follows.
function protectRunsAcrossTags(clone: Element, holds: Hold[]): void {
  const doc = clone.ownerDocument;
  const pieces: Array<{ node: Text; start: number }> = [];
  let flat = "";
  const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (RUN_BREAK_TAGS.has((node as Element).tagName)) flat += "\n";
      continue;
    }
    const text = node as Text;
    // Already protected, by the engine or by a placeholder: a boundary no run may cross.
    if (text.parentElement?.closest(`var, code, kbd, samp, math, ${HOLD_SELECTOR}`)) {
      flat += "\n";
      continue;
    }
    pieces.push({ node: text, start: flat.length });
    flat += text.data;
  }
  if (pieces.length < 2 || !hasProtectedText(flat)) return;
  const matches: Array<{ start: number; end: number }> = [];
  PROTECTED_SCANNER.lastIndex = 0;
  for (let match = PROTECTED_SCANNER.exec(flat); match; match = PROTECTED_SCANNER.exec(flat)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  // Last first: holding a run splits and moves only nodes after every run still to be handled.
  for (const { start, end } of matches.reverse()) {
    const first = locateInPieces(pieces, start, false);
    const last = locateInPieces(pieces, end, true);
    if (!first || !last || first.node === last.node) continue;
    if (last.at < last.node.data.length) last.node.splitText(last.at);
    const startNode = first.at > 0 ? first.node.splitText(first.at) : first.node;
    const endNode = last.node;
    // The run is held as whole children of the nearest element holding both of its ends.
    const ancestors = new Set<Node>();
    for (let node: Node | null = startNode; node; node = node.parentNode) ancestors.add(node);
    let common: Node | null = endNode;
    while (common && !ancestors.has(common)) common = common.parentNode;
    if (!common) continue;
    const childOf = (node: Node): Node => {
      let current = node;
      while (current.parentNode && current.parentNode !== common) current = current.parentNode;
      return current;
    };
    const firstChild = childOf(startNode);
    const lastChild = childOf(endNode);
    const held: Node[] = [];
    for (let node: Node | null = firstChild; node; node = node.nextSibling) {
      held.push(node);
      if (node === lastChild) break;
    }
    // A placeholder inside a hold would never be swapped back; leave such a run as it was.
    const nestsHold = held.some(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        ((node as Element).matches(`var[${HOLD_ATTRIBUTE}]`) || (node as Element).querySelector(`var[${HOLD_ATTRIBUTE}]`))
    );
    if (nestsHold) continue;
    const before = firstChild.previousSibling?.textContent ?? "";
    const after = lastChild.nextSibling?.textContent ?? "";
    const placeholder = doc.createElement("var");
    placeholder.setAttribute(HOLD_ATTRIBUTE, String(holds.length));
    placeholder.setAttribute(PAD_ATTRIBUTE, `${!before || SPACE.test(before.slice(-1)) ? "l" : ""}${!after || SPACE.test(after.charAt(0)) ? "r" : ""}`);
    placeholder.textContent = held.map((node) => node.textContent ?? "").join("");
    common.insertBefore(placeholder, firstChild);
    const fragment = doc.createDocumentFragment();
    fragment.append(...held);
    holds.push(fragment);
  }
}

// The text node holding a position of the joined text. An end position belongs to the node it
// closes, a start position to the node it opens.
function locateInPieces(pieces: Array<{ node: Text; start: number }>, offset: number, end: boolean): { node: Text; at: number } | null {
  for (const piece of pieces) {
    const from = piece.start;
    const to = piece.start + piece.node.data.length;
    if (end ? offset > from && offset <= to : offset >= from && offset < to) return { node: piece.node, at: offset - from };
  }
  return null;
}

// Text-level holds, applied to the clone only. Each match becomes the same `var` placeholder an
// untranslatable element gets, and the exact original characters are kept to be put back.
function protectText(clone: Element, holds: Hold[]): void {
  protectRunsAcrossTags(clone, holds);
  const doc = clone.ownerDocument;
  const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    // Anything already protected, verbatim by the engine or by a placeholder, is left alone.
    if (text.parentElement?.closest(`var, code, kbd, samp, math, ${HOLD_SELECTOR}`)) continue;
    if (!hasProtectedText(text.data)) continue;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    PROTECTED_SCANNER.lastIndex = 0;
    for (let match = PROTECTED_SCANNER.exec(text.data); match; match = PROTECTED_SCANNER.exec(text.data)) {
      if (match.index > cursor) fragment.append(doc.createTextNode(text.data.slice(cursor, match.index)));
      const end = match.index + match[0].length;
      const placeholder = doc.createElement("var");
      placeholder.setAttribute(HOLD_ATTRIBUTE, String(holds.length));
      placeholder.setAttribute(PAD_ATTRIBUTE, padSides(text.data, match.index, end));
      placeholder.textContent = match[0];
      holds.push(doc.createTextNode(match[0]));
      fragment.append(placeholder);
      cursor = end;
    }
    if (cursor < text.data.length) fragment.append(doc.createTextNode(text.data.slice(cursor)));
    text.replaceWith(fragment);
  }
}

const SPACE = /\s/u;

function padSides(data: string, start: number, end: number): string {
  const left = start === 0 || SPACE.test(data.charAt(start - 1));
  const right = end >= data.length || SPACE.test(data.charAt(end));
  return `${left ? "l" : ""}${right ? "r" : ""}`;
}

// The serialized unit with every placeholder's content removed, which is what the engine is
// actually being asked to translate.
function textOutsideHolds(html: string): string {
  return html.replace(/<var [^>]*data-glossa-hold[^>]*>[\s\S]*?<\/var>/gi, "").replace(/<[^>]+>/g, "");
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

// A form field is one of the page's live widgets, and what is in it (typed text, the options of a
// select, a hidden input's token) never goes to the engine. It stays in its sentence as an empty
// element carrying nothing but its number, so the words around it keep their context and replace
// mode can put the live field back where the engine left the slot. The renderer does the rest.
export const FORM_FIELD_SELECTOR = "input, select, textarea";

// What a unit says, leaving out anything typed or listed in its form fields.
function unitText(element: Element): string {
  if (!element.querySelector(FORM_FIELD_SELECTOR)) return element.textContent ?? "";
  const clone = element.cloneNode(true) as Element;
  emptyFields(clone);
  return clone.textContent ?? "";
}

// A field goes to the engine as an empty element with its number and nothing else: no options, no
// text, no value, no name.
function emptyFields(root: Element): void {
  for (const field of root.querySelectorAll(FORM_FIELD_SELECTOR)) {
    field.replaceChildren();
    for (const attribute of Array.from(field.attributes)) {
      if (attribute.name !== ID_ATTRIBUTE) field.removeAttribute(attribute.name);
    }
  }
}

function isContainer(element: Element): boolean {
  for (const child of element.children) {
    if (BLOCK_TAGS.has(child.tagName)) return true;
    if (child.shadowRoot) return true;
  }
  // An inline wrapper can still hold blocks: card grids are built as `div > a > div`, and sending
  // the wrapper as one unit makes bilingual mode append a second copy of every card in it. That
  // only applies to an element with no prose of its own. A paragraph with a footnote tooltip
  // inside a `<sup><a>` has to stay one sentence, which is the whole point of block-level units.
  if (hasOwnText(element)) return false;
  for (const child of element.children) {
    if (child.querySelector(BLOCK_SELECTOR)) return true;
  }
  return false;
}

function hasOwnText(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && LETTER.test((child as Text).data)) return true;
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

// The element a segment lives in, whatever kind it is.
export function segmentElement(segment: Segment): Element | null {
  switch (segment.kind) {
    case "element":
    case "attribute":
    case "label":
      return segment.element;
    case "text":
      return segment.node.parentElement;
  }
}

// How much text a segment carries, for batching.
export function segmentLength(segment: Segment): number {
  return segment.kind === "element" ? segment.html.length : segment.text.length;
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


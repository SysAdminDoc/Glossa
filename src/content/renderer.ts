import {
  attributeMarker,
  clearIds,
  FORM_FIELD_SELECTOR,
  LABEL_MARKER,
  MARKER_SELECTOR,
  HOLD_ATTRIBUTE,
  ID_ATTRIBUTE,
  PAD_ATTRIBUTE,
  PARAGRAPH_TAGS,
  TRANSLATION_CLASS,
  TRANSLATION_TAG,
  UNIT_ATTRIBUTE,
  type Hold,
  type Segment
} from "./segmenter.ts";
import { isRtlLanguage } from "../shared/languages.ts";
import type { DisplayMode } from "../shared/settings.ts";

// Applies translated fragments back to the page and remembers enough to undo it without a reload.
// Translated HTML never touches innerHTML on the live document: it is parsed in an inert
// DOMParser document and the resulting nodes are moved in. That sidesteps Trusted Types policies
// on strict pages and means no script in a fragment could ever run.

export interface RenderOptions {
  displayMode: DisplayMode;
  showOriginalOnHover: boolean;
  targetLanguage: string;
}

interface ElementRecord {
  kind: "element";
  element: Element;
  originalChildren: Node[];
  // Elements of the page that were reused in the translation rather than copied, with the children
  // they held before. Restoring means giving each one its own contents back.
  reused: Array<{ element: Element; children: Node[] }>;
  addedTitle: boolean;
  previousTitle: string | null;
  // A page that labels its own elements keeps its attributes through translate and restore, so the
  // values we found are put back rather than removed.
  previousLang: string | null;
  previousDir: string | null;
  appended: Element | null;
  // The text that was written, and in replace mode the nodes it was written as, so a page that
  // renders the unit again from what it reads on screen can be told apart from a page that wrote
  // new text of its own, or one that only changed an attribute of the unit.
  translatedText: string;
  written: Node[];
}

interface TextRecord {
  kind: "text";
  node: Text;
  originalData: string;
  appended: Element | null;
}

interface AttributeRecord {
  kind: "attribute";
  element: Element;
  attribute: string;
  original: string;
  // What was written. A page that rewrites the attribute afterwards owns it, and restoring has to
  // leave that alone rather than putting a stale original back over live content.
  translated: string;
}

interface LabelRecord {
  kind: "label";
  element: Element;
  original: string;
  translated: string;
  // An <option> with no value of its own submits its text, so translating the text would change
  // what the form sends. The value is written out explicitly before that can happen.
  addedValue: boolean;
}

type Record_ = ElementRecord | TextRecord | AttributeRecord | LabelRecord;

const parser = new DOMParser();

// The page-level stylesheet (content.css) does not reach shadow roots, so the block rule for the
// translation element is adopted into every shadow root that receives one.
const SHADOW_STYLE = `glossa-translation.glossa-t{display:block;margin-top:.3em;padding-left:.6em;border-left:2px solid rgba(124,108,242,.55);color:inherit;font:inherit;line-height:inherit;white-space:normal}glossa-translation.glossa-t.glossa-inline{display:inline;margin:0 0 0 .35em;padding:0;border:0;opacity:.85}`;
const styledRoots = new WeakSet<ShadowRoot>();

function ensureShadowStyle(node: Node): void {
  const root = node.getRootNode();
  if (!(root instanceof ShadowRoot) || styledRoots.has(root)) return;
  styledRoots.add(root);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHADOW_STYLE);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement("style");
    style.setAttribute("data-glossa", "");
    style.textContent = SHADOW_STYLE;
    root.append(style);
  }
}

// Bergamot copies `code`, `kbd`, `samp` and `var` through verbatim but drops the whitespace that
// separated them from the surrounding words. Put a space back wherever a word character now
// touches such an element on either side.
const WORD_EDGE = /[\p{L}\p{N}]/u;

export function repairInlineSpacing(root: ParentNode): void {
  for (const element of root.querySelectorAll("code, kbd, samp, var, [translate='no'], .notranslate")) {
    // A text-level placeholder records where the source actually had whitespace. "v1.2.3" and
    // "(https://example.com)" had none, and putting a space there would corrupt them.
    const pad = element.getAttribute(PAD_ATTRIBUTE);
    const padLeft = pad === null || pad.includes("l");
    const padRight = pad === null || pad.includes("r");
    const previous = element.previousSibling;
    if (padLeft && previous && previous.nodeType === Node.TEXT_NODE) {
      const text = previous as Text;
      if (text.data.length > 0 && WORD_EDGE.test(text.data.slice(-1))) text.data += " ";
    }
    const next = element.nextSibling;
    if (padRight && next && next.nodeType === Node.TEXT_NODE) {
      const text = next as Text;
      if (text.data.length > 0 && WORD_EDGE.test(text.data.charAt(0))) text.data = " " + text.data;
    }
  }
}

export class Renderer {
  private readonly records: Record_[] = [];

  get count(): number {
    return this.records.length;
  }

  markPending(segment: Segment): void {
    if (segment.kind === "element") {
      segment.element.setAttribute(UNIT_ATTRIBUTE, "pending");
    }
  }

  unmark(segment: Segment): void {
    if (segment.kind === "element" && segment.element.getAttribute(UNIT_ATTRIBUTE) === "pending") {
      segment.element.removeAttribute(UNIT_ATTRIBUTE);
    }
  }

  // Returns the plain text it wrote, which the caller remembers so the engine is never handed its
  // own output back. Null means nothing was applied.
  apply(segment: Segment, translatedHtml: string, options: RenderOptions): string | null {
    if (!translatedHtml.trim()) {
      this.unmark(segment);
      return null;
    }
    if (segment.kind === "attribute") return this.applyAttribute(segment, translatedHtml);
    if (segment.kind === "label") return this.applyLabel(segment, translatedHtml);
    const nodes = parseFragment(translatedHtml, segment.kind === "element" ? segment.holds : []);
    if (segment.kind === "text") {
      return this.applyText(segment, nodes, options);
    }
    const element = segment.element;
    if (!element.isConnected) return null;
    const applied = nodes.map((node) => node.textContent ?? "").join("");
    // Replace mode puts the page's live fields back into the translation by number. If the engine
    // dropped one, replacing would take a working control off the page, so that unit is shown the
    // bilingual way instead, with the original left exactly as it was.
    const bilingual =
      (options.displayMode === "bilingual" && wantsBilingual(element, segment.text)) || !fieldsSurvive(nodes, element);
    if (bilingual) {
      const block = document.createElement(TRANSLATION_TAG.toLowerCase());
      block.className = TRANSLATION_CLASS;
      labelLanguage(block, options.targetLanguage);
      block.append(...nodes);
      // The original stays where it is in this mode, so the translation is a copy and the page's
      // numbering has no meaning inside it.
      clearIds(block);
      dropPageIds(block);
      dropFormControls(block);
      hideDuplicateFromScreenReaders(block);
      ensureShadowStyle(element);
      element.append(block);
      element.setAttribute(UNIT_ATTRIBUTE, "bilingual");
      this.records.push({
        kind: "element",
        element,
        originalChildren: [],
        reused: [],
        addedTitle: false,
        previousTitle: null,
        previousLang: element.getAttribute("lang"),
        previousDir: element.getAttribute("dir"),
        appended: block,
        translatedText: applied,
        written: []
      });
      return applied;
    }
    const originalChildren = Array.from(element.childNodes);
    const previousTitle = element.getAttribute("title");
    let addedTitle = false;
    // Replace mode owns the block, so the block's own elements can be moved into the translation.
    const merged = mergeLiveElements(nodes, element);
    const reused = merged.reused;
    element.replaceChildren(...merged.nodes);
    if (options.showOriginalOnHover && previousTitle === null) {
      const original = segment.text.replace(/\s+/g, " ").trim();
      if (original) {
        element.setAttribute("title", original);
        addedTitle = true;
      }
    }
    element.setAttribute(UNIT_ATTRIBUTE, "replaced");
    const previousLang = element.getAttribute("lang");
    const previousDir = element.getAttribute("dir");
    labelLanguage(element, options.targetLanguage);
    this.records.push({
      kind: "element",
      element,
      originalChildren,
      reused,
      translatedText: applied,
      written: merged.nodes,
      addedTitle,
      previousTitle,
      previousLang,
      previousDir,
      appended: null
    });
    return applied;
  }

  // Attributes carry no markup, so the engine's answer is taken as text and nothing is parsed.
  private applyAttribute(segment: Extract<Segment, { kind: "attribute" }>, translated: string): string | null {
    const element = segment.element;
    if (!element.isConnected) return null;
    const text = plainText(translated).trim();
    if (!text || text === segment.text) return null;
    const marker = attributeMarker(segment.attribute);
    if (element.hasAttribute(marker)) return null;
    const original = element.getAttribute(segment.attribute) ?? "";
    element.setAttribute(marker, original);
    element.setAttribute(segment.attribute, text);
    this.records.push({ kind: "attribute", element, attribute: segment.attribute, original, translated: text });
    return text;
  }

  private applyLabel(segment: Extract<Segment, { kind: "label" }>, translated: string): string | null {
    const element = segment.element;
    if (!element.isConnected) return null;
    const text = plainText(translated).trim();
    if (!text || text === segment.text) return null;
    const original = element.textContent ?? "";
    let addedValue = false;
    if (element.tagName === "OPTION" && !element.hasAttribute("value")) {
      // Pin what this option submits before its text changes underneath it. An option with no
      // value of its own submits its text stripped and collapsed, which is not the raw content:
      // an option written across three lines would otherwise start posting the whitespace too.
      element.setAttribute("value", original.replace(/\s+/gu, " ").trim());
      addedValue = true;
    }
    element.textContent = text;
    element.setAttribute(LABEL_MARKER, "1");
    this.records.push({ kind: "label", element, original, translated: text, addedValue });
    return text;
  }

  private applyText(segment: Extract<Segment, { kind: "text" }>, nodes: Node[], options: RenderOptions): string | null {
    const node = segment.node;
    if (!node.isConnected) return null;
    const translated = nodes.map((n) => n.textContent ?? "").join("");
    const bilingual = options.displayMode === "bilingual" && segment.text.trim().length >= 40;
    if (bilingual) {
      const inline = document.createElement(TRANSLATION_TAG.toLowerCase());
      inline.className = `${TRANSLATION_CLASS} glossa-inline`;
      labelLanguage(inline, options.targetLanguage);
      inline.textContent = translated;
      hideDuplicateFromScreenReaders(inline);
      ensureShadowStyle(node);
      node.after(inline);
      this.records.push({ kind: "text", node, originalData: node.data, appended: inline });
      return translated;
    }
    const originalData = node.data;
    node.data = translated;
    this.records.push({ kind: "text", node, originalData, appended: null });
    return translated;
  }

  // The page re-rendered a unit in place: its text changed, its children were replaced, or its
  // `lang` flipped. The bookkeeping for it is stale, so drop it and take our own output with it.
  // The caller re-collects the element afterwards, which translates it exactly once more.
  reset(target: Element): boolean {
    let dropped = false;
    let kept = false;
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index]!;
      const owner = record.kind === "text" ? record.node.parentElement : record.element;
      if (owner !== target) continue;
      // Some pages render a unit again from what they read on screen, which in replace mode is the
      // translation. That is not new source text, and the engine is never asked for its own output
      // again, so dropping the record would lose the way back to the original for good. It stays,
      // and "show original" still puts the page's own text back. Only when the page really wrote
      // new nodes, though: with the nodes Glossa wrote still in place, the unit went stale for
      // another reason (its `lang` or `translate` changed) and has to be reset as usual.
      if (
        record.kind === "element" &&
        record.appended === null &&
        !record.written.some((node) => target.contains(node)) &&
        sameText(target.textContent ?? "", record.translatedText)
      ) {
        kept = true;
        continue;
      }
      if (record.kind === "attribute") {
        // The unit is being re-collected, so this attribute has to go back to what the page said
        // before it can be translated again. Dropping only the record left the translation in
        // place with nothing able to undo it.
        restoreAttribute(record);
        this.records.splice(index, 1);
        dropped = true;
        continue;
      }
      if (record.kind === "label") {
        if ((record.element.textContent ?? "") === record.translated) {
          record.element.textContent = record.original;
        }
        record.element.removeAttribute(LABEL_MARKER);
        if (record.addedValue) record.element.removeAttribute("value");
        this.records.splice(index, 1);
        dropped = true;
        continue;
      }
      if (record.appended?.isConnected) record.appended.remove();
      if (record.kind === "element") {
        clearIds(record.element);
        if (record.addedTitle) record.element.removeAttribute("title");
        // The `lang` we stamped in replace mode says "this is English now". Leaving it behind makes
        // the block look like it is already in the target language, and it would never be offered
        // for translation again.
        if (record.previousLang === null) record.element.removeAttribute("lang");
        else record.element.setAttribute("lang", record.previousLang);
        if (record.previousDir === null) record.element.removeAttribute("dir");
        else record.element.setAttribute("dir", record.previousDir);
      }
      this.records.splice(index, 1);
      dropped = true;
    }
    // A unit whose record was kept above is still translated: its marker stays, and nothing about
    // it needs collecting again.
    if (kept) return false;
    // A unit still waiting on the engine has a marker but no record yet. Clearing it is what lets
    // the caller collect the element again, so report that as a reset too.
    const hadMarker = target.hasAttribute(UNIT_ATTRIBUTE);
    target.removeAttribute(UNIT_ATTRIBUTE);
    return dropped || hadMarker;
  }

  // The page rewrote something this extension had translated. The value there now is the page's,
  // so the record goes without touching it: restoring later must not put an old original back.
  forgetAttribute(element: Element, attribute: string): void {
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index]!;
      if (record.kind === "attribute" && record.element === element && record.attribute === attribute) {
        this.records.splice(index, 1);
      }
    }
    element.removeAttribute(attributeMarker(attribute));
  }

  forgetLabel(element: Element): void {
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index]!;
      if (record.kind !== "label" || record.element !== element) continue;
      if (record.addedValue) element.removeAttribute("value");
      this.records.splice(index, 1);
    }
    element.removeAttribute(LABEL_MARKER);
  }

  restoreAll(): number {
    let restored = 0;
    for (const record of this.records.reverse()) {
      if (record.kind === "attribute") {
        restoreAttribute(record);
        restored++;
        continue;
      }
      if (record.kind === "label") {
        // Only if the page has not written its own text there since.
        if ((record.element.textContent ?? "") === record.translated) {
          record.element.textContent = record.original;
        }
        record.element.removeAttribute(LABEL_MARKER);
        if (record.addedValue) record.element.removeAttribute("value");
        restored++;
        continue;
      }
      if (record.kind === "text") {
        if (record.appended) {
          record.appended.remove();
        } else {
          record.node.data = record.originalData;
        }
        restored++;
        continue;
      }
      const element = record.element;
      if (record.appended) {
        record.appended.remove();
      } else {
        for (const { element: reused, children } of record.reused) reused.replaceChildren(...children);
        element.replaceChildren(...record.originalChildren);
        if (record.addedTitle) element.removeAttribute("title");
        else if (record.previousTitle !== null) element.setAttribute("title", record.previousTitle);
      }
      clearIds(element);
      element.removeAttribute(UNIT_ATTRIBUTE);
      if (record.previousLang === null) element.removeAttribute("lang");
      else element.setAttribute("lang", record.previousLang);
      if (record.previousDir === null) element.removeAttribute("dir");
      else element.setAttribute("dir", record.previousDir);
      restored++;
    }
    this.records.length = 0;
    // A marker with no record behind it is an element the page cloned after it was translated.
    // Sweeping them is what keeps a duplicated widget from being skipped forever afterwards.
    for (const stray of document.querySelectorAll(MARKER_SELECTOR)) {
      for (const attribute of Array.from(stray.attributes)) {
        if (attribute.name.startsWith("data-glossa-was-")) {
          stray.setAttribute(attribute.name.slice("data-glossa-was-".length), attribute.value);
          stray.removeAttribute(attribute.name);
        }
      }
      stray.removeAttribute(LABEL_MARKER);
    }
    return restored;
  }
}

function restoreAttribute(record: { element: Element; attribute: string; original: string; translated: string }): void {
  const current = record.element.getAttribute(record.attribute);
  // Only undo what is still ours. A page that rewrote the tooltip since keeps its own value.
  if (current === record.translated) {
    if (record.original) record.element.setAttribute(record.attribute, record.original);
    else record.element.removeAttribute(record.attribute);
  }
  record.element.removeAttribute(attributeMarker(record.attribute));
}

// Rebuild the translated tree out of the page's own elements. Every element the engine gave back
// with a number is looked up in the block being replaced; the translated children move into that
// element and the copy is thrown away. An id the engine repeated gets a shallow clone, and an
// element the engine invented or dropped is left as the copy it already is.
function mergeLiveElements(
  nodes: Node[],
  unit: Element
): { nodes: Node[]; reused: Array<{ element: Element; children: Node[] }> } {
  const live = new Map<string, Element>();
  for (const candidate of unit.querySelectorAll(`[${ID_ATTRIBUTE}]`)) {
    const id = candidate.getAttribute(ID_ATTRIBUTE);
    if (id !== null) live.set(id, candidate);
  }
  if (live.size === 0) return { nodes, reused: [] };
  // Every live element's children as they are now, before the walk below moves any of them. The
  // walk goes deepest first, so a snapshot taken inside it would show a <label> already without the
  // input moved out of it, and restoring from that would leave the input off the page.
  const before = new Map<Element, Node[]>();
  for (const element of live.values()) before.set(element, Array.from(element.childNodes));
  const reused: Array<{ element: Element; children: Node[] }> = [];
  const used = new Set<string>();

  // One fragment so the top level of the translation is walked by the same code as every level
  // below it. Handling it separately is how a repeated element at the top slips through.
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);

  const visit = (parent: ParentNode): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const copy = child as Element;
      // Depth first: the deepest elements are swapped before the ones holding them.
      visit(copy);
      const id = copy.getAttribute(ID_ATTRIBUTE);
      if (id === null) continue;
      const original = live.get(id);
      if (!original) continue;
      if (original.matches(FORM_FIELD_SELECTOR)) {
        // A field is the page's live widget: its options, what was typed in it and its listeners
        // stay as they are. It went to the engine empty, so nothing that came back belongs inside
        // it, and a second copy of it would be a control that does nothing.
        if (used.has(id)) {
          copy.remove();
        } else {
          used.add(id);
          original.removeAttribute(ID_ATTRIBUTE);
          copy.replaceWith(original);
        }
        continue;
      }
      if (used.has(id)) {
        // The engine repeated this element. A shallow clone keeps the markup without pretending
        // the page's own element is in two places.
        const clone = original.cloneNode(false) as Element;
        clone.removeAttribute(ID_ATTRIBUTE);
        clone.removeAttribute("id");
        clone.replaceChildren(...Array.from(copy.childNodes));
        copy.replaceWith(clone);
        continue;
      }
      used.add(id);
      reused.push({ element: original, children: before.get(original) ?? Array.from(original.childNodes) });
      original.replaceChildren(...Array.from(copy.childNodes));
      original.removeAttribute(ID_ATTRIBUTE);
      copy.replaceWith(original);
    }
  };
  visit(fragment);
  return { nodes: Array.from(fragment.childNodes), reused };
}

// Two languages in one document have to be distinguishable to anything reading it, which is what
// WCAG 3.1.2 asks for, and a right-to-left translation inside a left-to-right page needs to say so
// or its punctuation lands at the wrong end.
function labelLanguage(element: Element, language: string): void {
  element.setAttribute("lang", language);
  element.setAttribute("dir", isRtlLanguage(language) ? "rtl" : "ltr");
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

// A copy must not repeat the page's ids. Two elements with one id is invalid, and whatever looks an
// element up by it (a label's `for`, an in-page link, the page's own scripts) would find the original
// only by luck of document order.
function dropPageIds(root: Element): void {
  for (const element of root.querySelectorAll("[id]")) element.removeAttribute("id");
}

// The copy below the original is text to read. A field or a button in it would be a second control
// that does nothing, so fields go and a button leaves only its label behind.
function dropFormControls(block: Element): void {
  for (const field of block.querySelectorAll(FORM_FIELD_SELECTOR)) field.remove();
  for (const button of block.querySelectorAll("button")) button.replaceWith(...Array.from(button.childNodes));
}

// Whether every live field of the unit came back from the engine, by number.
function fieldsSurvive(nodes: Node[], unit: Element): boolean {
  const fields = Array.from(unit.querySelectorAll(FORM_FIELD_SELECTOR));
  if (fields.length === 0) return true;
  const returned = new Set<string>();
  for (const node of nodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    for (const numbered of [element, ...Array.from(element.querySelectorAll(`[${ID_ATTRIBUTE}]`))]) {
      const id = numbered.getAttribute(ID_ATTRIBUTE);
      if (id !== null) returned.add(id);
    }
  }
  return fields.every((field) => returned.has(field.getAttribute(ID_ATTRIBUTE) ?? ""));
}

// In bilingual mode the page says everything twice, and a screen reader reads it twice. The added
// copy is the one to take out of the accessibility tree, but only when it holds nothing focusable:
// aria-hidden does not remove anything from the tab order, so hiding a block with a link in it
// leaves a focusable element that announces as nothing at all.
function hideDuplicateFromScreenReaders(block: Element): void {
  const focusable = block.querySelector("a[href], button, input, select, textarea, [tabindex], [contenteditable]");
  if (!focusable) block.setAttribute("aria-hidden", "true");
}

// The engine answers in HTML even for plain text, so an answer that came back with markup in it is
// flattened rather than trusted.
function plainText(html: string): string {
  if (!/[<&]/.test(html)) return html;
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html");
  return doc.body.textContent ?? "";
}

function wantsBilingual(element: Element, text: string): boolean {
  if (PARAGRAPH_TAGS.has(element.tagName)) return text.trim().length >= 12;
  return text.trim().length >= 60;
}

function parseFragment(html: string, holds: Hold[]): Node[] {
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html");
  // Spacing first, while the placeholders are still elements. The engine drops the whitespace
  // around anything it copies verbatim, and once a placeholder has become a bare text node (a URL,
  // a reference number) there is nothing left to recognise it by.
  repairInlineSpacing(doc.body);
  // Then put back what each placeholder stands for, byte for byte.
  // A placeholder the engine repeated is put back as a second copy of the held element, and only the
  // first may keep the page's ids.
  const placed = new Set<number>();
  for (const placeholder of doc.body.querySelectorAll(`var[${HOLD_ATTRIBUTE}]`)) {
    const index = Number(placeholder.getAttribute(HOLD_ATTRIBUTE));
    const original = holds[index];
    if (original) {
      const copy = doc.importNode(original, true);
      if (copy.nodeType === Node.ELEMENT_NODE) {
        const element = copy as Element;
        element.removeAttribute(ID_ATTRIBUTE);
        for (const nested of element.querySelectorAll(`[${ID_ATTRIBUTE}]`)) nested.removeAttribute(ID_ATTRIBUTE);
        if (placed.has(index)) {
          element.removeAttribute("id");
          for (const nested of element.querySelectorAll("[id]")) nested.removeAttribute("id");
        }
      }
      // A run the page split across inline tags comes back as a fragment that keeps its numbers,
      // so replace mode puts the page's own tags back, and mergeLiveElements turns a repeat into a
      // plain copy the way it does for every element the engine repeats.
      placed.add(index);
      placeholder.replaceWith(copy);
    } else {
      placeholder.replaceWith(doc.createTextNode(placeholder.textContent ?? ""));
    }
  }
  // Nothing executable survives the trip. Scripts are inert in a parsed document already; strip
  // them and event handler attributes anyway so a fragment can never carry one back.
  for (const script of doc.querySelectorAll("script, iframe, object, embed")) script.remove();
  for (const element of doc.body.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if ((attribute.name === "href" || attribute.name === "src") && /^\s*javascript:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return Array.from(doc.body.childNodes).map((node) => document.importNode(node, true));
}

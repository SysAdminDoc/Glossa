import {
  clearIds,
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
}

interface TextRecord {
  kind: "text";
  node: Text;
  originalData: string;
  appended: Element | null;
}

type Record_ = ElementRecord | TextRecord;

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
    const nodes = parseFragment(translatedHtml, segment.kind === "element" ? segment.holds : []);
    if (segment.kind === "text") {
      return this.applyText(segment, nodes, options);
    }
    const element = segment.element;
    if (!element.isConnected) return null;
    const applied = nodes.map((node) => node.textContent ?? "").join("");
    const bilingual = options.displayMode === "bilingual" && wantsBilingual(element, segment.text);
    if (bilingual) {
      const block = document.createElement(TRANSLATION_TAG.toLowerCase());
      block.className = TRANSLATION_CLASS;
      labelLanguage(block, options.targetLanguage);
      block.append(...nodes);
      // The original stays where it is in this mode, so the translation is a copy and the page's
      // numbering has no meaning inside it.
      clearIds(block);
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
        appended: block
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
      addedTitle,
      previousTitle,
      previousLang,
      previousDir,
      appended: null
    });
    return applied;
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
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index]!;
      const owner = record.kind === "element" ? record.element : record.node.parentElement;
      if (owner !== target) continue;
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
    // A unit still waiting on the engine has a marker but no record yet. Clearing it is what lets
    // the caller collect the element again, so report that as a reset too.
    const hadMarker = target.hasAttribute(UNIT_ATTRIBUTE);
    target.removeAttribute(UNIT_ATTRIBUTE);
    return dropped || hadMarker;
  }

  restoreAll(): number {
    let restored = 0;
    for (const record of this.records.reverse()) {
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
    return restored;
  }
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
      if (used.has(id)) {
        // The engine repeated this element. A shallow clone keeps the markup without pretending
        // the page's own element is in two places.
        const clone = original.cloneNode(false) as Element;
        clone.removeAttribute(ID_ATTRIBUTE);
        clone.replaceChildren(...Array.from(copy.childNodes));
        copy.replaceWith(clone);
        continue;
      }
      used.add(id);
      reused.push({ element: original, children: Array.from(original.childNodes) });
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

// In bilingual mode the page says everything twice, and a screen reader reads it twice. The added
// copy is the one to take out of the accessibility tree, but only when it holds nothing focusable:
// aria-hidden does not remove anything from the tab order, so hiding a block with a link in it
// leaves a focusable element that announces as nothing at all.
function hideDuplicateFromScreenReaders(block: Element): void {
  const focusable = block.querySelector("a[href], button, input, select, textarea, [tabindex], [contenteditable]");
  if (!focusable) block.setAttribute("aria-hidden", "true");
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
  for (const placeholder of doc.body.querySelectorAll(`var[${HOLD_ATTRIBUTE}]`)) {
    const index = Number(placeholder.getAttribute(HOLD_ATTRIBUTE));
    const original = holds[index];
    if (original) {
      const copy = doc.importNode(original, true);
      if (copy.nodeType === Node.ELEMENT_NODE) {
        const element = copy as Element;
        element.removeAttribute(ID_ATTRIBUTE);
        for (const nested of element.querySelectorAll(`[${ID_ATTRIBUTE}]`)) nested.removeAttribute(ID_ATTRIBUTE);
      }
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

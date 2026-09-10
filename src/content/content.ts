import { api } from "../shared/api.ts";
import { normalizeLanguageTag } from "../shared/catalog.ts";
import { t } from "../shared/i18n.ts";
import { loadSettings, SETTINGS_KEY, type Settings } from "../shared/settings.ts";
import type {
  DetectRequest,
  DetectResponse,
  PageCommand,
  PageState,
  RouteStatus,
  TranslateRequest,
  TranslateResponse
} from "../shared/messages.ts";
import { buildSample } from "./detect-sample.ts";
import { OutputCache } from "./output-cache.ts";
import { createScheduler, whenVisible } from "./scheduler.ts";
import { Renderer, type RenderOptions } from "./renderer.ts";
import {
  collectFromNodes,
  collectSegments,
  segmentFragment,
  UNIT_ATTRIBUTE,
  READABLE_ATTRIBUTES,
  attributeMarker,
  attributeSegment,
  type Segment
} from "./segmenter.ts";

// Injected on demand (activeTab + scripting) rather than declared for every site, so the extension
// carries no host permission for the web at all. Once injected it stays until navigation and
// answers status queries from the popup.

const INJECT_FLAG = "glossaInjected";
const OBSERVER_DEBOUNCE_MS = 250;
// Long enough that dragging a selection does not flash a button at every character.
const SELECTION_DEBOUNCE_MS = 250;
// One request carries at most this much: enough to keep the engine busy, small enough that the
// first blocks appear quickly.
const BATCH_MAX_ITEMS = 24;
const BATCH_MAX_CHARS = 6000;

// Attributes worth reacting to. `hidden`, `open`, `translate`, `lang` and `aria-hidden` change
// whether a block should be translated at all; `class` and `style` only ever trigger a re-check of
// the elements an earlier pass deferred, never a fresh walk of the page.
// The readable ones are watched too: a page that rewrites a tooltip Glossa translated owns that
// tooltip again, and its new text needs translating rather than being overwritten on restore.
const WATCHED_ATTRIBUTES = ["hidden", "open", "translate", "lang", "aria-hidden", "class", "style", ...READABLE_ATTRIBUTES];
const DIRECT_ATTRIBUTES = new Set(["hidden", "open", "translate", "lang", "aria-hidden"]);

interface Controller {
  state: PageState;
  renderer: Renderer;
  options: RenderOptions | null;
  observer: MutationObserver | null;
  observerTimer: number | null;
  generation: number;
  // Nodes the observer wants looked at, units the page re-rendered under us, and candidates an
  // earlier pass skipped because they were not rendered yet.
  pending: Set<Node>;
  stale: Set<Element>;
  deferred: Set<Element>;
  // Readable attributes the page set after the first pass, and whether it changed its own title.
  attributeChanges: Map<Element, Set<string>>;
  titleChanged: boolean;
  // Everything the engine has already written on this page, so it is never sent back in.
  output: OutputCache;
  // What `<html lang>` claims. A unit that declares a different language is written in that one.
  pageLanguage: string | null;
  // The pair the page is currently translated with, so a late mutation is handled the same way.
  source: string | null;
  target: string | null;
  // From the user's settings, carried on the translate command: the engine never sees the content of
  // an editable field unless this is off.
  skipFormFields: boolean;
  // Per-language answer to "is there a model for this on disk", so a page with three quoted
  // languages asks once each.
  routes: Map<string, boolean>;
  // The user's settings, read here because the selection button has to work before anything has
  // been translated. Kept current through storage changes rather than needing a reload.
  settings: Settings | null;
  selectionTimer: number | null;
}

function boot(): void {
  if (document.documentElement.dataset[INJECT_FLAG] === "1") return;
  document.documentElement.dataset[INJECT_FLAG] = "1";

  const controller: Controller = {
    state: {
      injected: true,
      url: location.href,
      detectedLanguage: null,
      confident: false,
      translated: false,
      translating: false,
      targetLanguage: null,
      blocksTotal: 0,
      blocksDone: 0,
      lastError: null
    },
    renderer: new Renderer(),
    options: null,
    observer: null,
    observerTimer: null,
    generation: 0,
    pending: new Set(),
    stale: new Set(),
    deferred: new Set(),
    attributeChanges: new Map(),
    titleChanged: false,
    output: new OutputCache(),
    pageLanguage: null,
    source: null,
    target: null,
    skipFormFields: true,
    routes: new Map(),
    settings: null,
    selectionTimer: null
  };

  api.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (value: unknown) => void) => {
    const command = message as PageCommand;
    if (!command || command.type !== "glossa:page-command") return false;
    handleCommand(controller, command).then(sendResponse, (error: unknown) => {
      controller.state.lastError = error instanceof Error ? error.message : String(error);
      sendResponse(controller.state);
    });
    return true;
  });

  // Detect early so the popup can show the page language before anything is translated.
  void detect(controller);
  void watchSelection(controller);
}

async function handleCommand(controller: Controller, command: PageCommand): Promise<PageState> {
  switch (command.command) {
    case "status":
      if (!controller.state.detectedLanguage) await detect(controller);
      return controller.state;
    case "translate":
      await translatePage(controller, command);
      return controller.state;
    case "restore":
      restore(controller);
      return controller.state;
    case "translate-selection":
      await translateSelection(controller, command.targetLanguage);
      return controller.state;
    case "translate-field":
      await translateField(controller, command.targetLanguage);
      return controller.state;
  }
}

async function detect(controller: Controller): Promise<void> {
  const sample = sampleText(document.body ?? document.documentElement);
  const request: DetectRequest = {
    type: "glossa:detect",
    sample,
    htmlLang: document.documentElement.getAttribute("lang")
  };
  try {
    const response = (await api.runtime.sendMessage(request)) as DetectResponse | undefined;
    if (response) {
      controller.state.detectedLanguage = response.language;
      controller.state.confident = response.confident;
    }
  } catch {
    // Background may not be listening yet; the popup will ask again.
  }
}

function sampleText(root: Element, limit = 4000): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "CODE" || tag === "PRE") {
        return NodeFilter.FILTER_REJECT;
      }
      return /\p{L}/u.test((node as Text).data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const lines: string[] = [];
  let budget = limit * 4;
  while (budget > 0) {
    const node = walker.nextNode() as Text | null;
    if (!node) break;
    lines.push(node.data);
    budget -= node.data.length + 1;
  }
  return buildSample(lines, limit);
}

async function translatePage(
  controller: Controller,
  command: Extract<PageCommand, { command: "translate" }>
): Promise<void> {
  if (controller.state.translated || controller.state.translating) {
    // A second click while a page is translated switches nothing; restore first.
    return;
  }
  // Claim the page before the first await. Detection can take a round trip, and a second command
  // arriving inside that window would otherwise start a whole second pass over the same blocks.
  controller.state.translating = true;
  // An automatic translation can arrive before the first detection has come back.
  if (!command.sourceLanguage && !controller.state.detectedLanguage) await detect(controller);
  const source = command.sourceLanguage ?? controller.state.detectedLanguage;
  if (!source) {
    controller.state.translating = false;
    controller.state.lastError = t("pageNoLanguage");
    return;
  }
  if (source === command.targetLanguage) {
    controller.state.translating = false;
    controller.state.lastError = t("pageAlreadyTarget", command.targetLanguage);
    return;
  }
  controller.state.detectedLanguage = source;
  controller.state.targetLanguage = command.targetLanguage;
  controller.source = source;
  controller.target = command.targetLanguage;
  controller.skipFormFields = command.skipFormFields;
  controller.state.lastError = null;
  controller.options = {
    displayMode: command.displayMode,
    showOriginalOnHover: command.showOriginalOnHover,
    targetLanguage: command.targetLanguage
  };
  const generation = ++controller.generation;
  controller.state.translating = true;
  controller.state.blocksDone = 0;
  controller.state.blocksTotal = 0;
  report(controller);

  try {
    controller.pageLanguage = normalizeLanguageTag(document.documentElement.getAttribute("lang"));
    // Models can have been installed since the last run.
    controller.routes.clear();
    const segments = collectSegments(document.body, segmentOptions(controller));
    // The tab's title is outside the body, and it is the first thing a reader sees.
    const title = document.querySelector("head > title");
    if (title) segments.unshift(...collectFromNodes([title], segmentOptions(controller)));
    controller.state.blocksTotal = segments.length;
    await translateByLanguage(controller, segments, source, command.targetLanguage, generation);
    if (generation !== controller.generation) return;
    controller.state.translated = controller.state.lastError === null || controller.state.blocksDone > 0;
    startObserver(controller);
  } finally {
    if (generation === controller.generation) {
      controller.state.translating = false;
      report(controller);
    }
  }
}

// A page is not always written in one language. A unit that declares a `lang` of its own (a quoted
// paragraph, a foreign title, an RTL excerpt) is grouped under that language: pushing Arabic through
// a Spanish model returns nonsense. Such a group is only translated when its model is already on
// this device, because downloading 25 MB for one quoted paragraph is not a decision to make on the
// user's behalf; otherwise it is left in its original language.
async function translateByLanguage(
  controller: Controller,
  segments: Segment[],
  pageSource: string,
  target: string,
  generation: number
): Promise<void> {
  const groups = new Map<string, Segment[]>();
  let skipped = 0;
  for (const segment of segments) {
    const declared = normalizeLanguageTag(segment.lang);
    const language = declared && declared !== controller.pageLanguage ? declared : pageSource;
    if (language === target) {
      // Already in the language the reader asked for.
      skipped++;
      continue;
    }
    const group = groups.get(language);
    if (group) group.push(segment);
    else groups.set(language, [segment]);
  }
  if (skipped > 0) controller.state.blocksTotal -= skipped;

  // The page's own language first: that is the one the user accepted a download for.
  const order = [pageSource, ...[...groups.keys()].filter((language) => language !== pageSource)];
  for (const language of order) {
    const group = groups.get(language);
    if (!group) continue;
    if (language !== pageSource && !(await hasInstalledRoute(controller, language, target))) {
      controller.state.blocksTotal -= group.length;
      continue;
    }
    if (generation !== controller.generation) return;
    await translateSegments(controller, group, language, target, generation);
  }
}

async function hasInstalledRoute(controller: Controller, source: string, target: string): Promise<boolean> {
  const key = `${source}->${target}`;
  const known = controller.routes.get(key);
  if (known !== undefined) return known;
  let installed = false;
  try {
    const status = (await api.runtime.sendMessage({
      type: "glossa:route-status",
      sourceLanguage: source,
      targetLanguage: target
    })) as RouteStatus | undefined;
    installed = Boolean(status?.hops && status.installed);
  } catch {
    installed = false;
  }
  controller.routes.set(key, installed);
  return installed;
}

async function translateSegments(
  controller: Controller,
  segments: Segment[],
  source: string,
  target: string,
  generation: number
): Promise<void> {
  // Text the engine produced earlier on this page is not source text, whatever the page does with
  // it afterwards. Drop those segments before anything is marked or sent.
  const fresh = segments.filter((segment) => !controller.output.has(segment.text));
  const echoed = segments.length - fresh.length;
  if (echoed > 0) controller.state.blocksTotal -= echoed;
  withObserverPaused(controller, fresh, () => {
    for (const segment of fresh) controller.renderer.markPending(segment);
  });

  const scheduler = createScheduler(fresh);
  for (;;) {
    // A tab in the background is not worth the engine's time, and holding it there keeps the models
    // in memory for a reader who is not reading.
    await whenVisible();
    const batch = scheduler.next(BATCH_MAX_ITEMS, BATCH_MAX_CHARS);
    if (batch.length === 0) break;
    if (generation !== controller.generation) {
      unmarkAll(controller, [batch, scheduler.next(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]);
      scheduler.stop();
      return;
    }
    const request: TranslateRequest = {
      type: "glossa:translate",
      sourceLanguage: source,
      targetLanguage: target,
      fragments: batch.map(segmentFragment)
    };
    let response: TranslateResponse;
    try {
      response = (await api.runtime.sendMessage(request)) as TranslateResponse;
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (generation !== controller.generation) {
      unmarkAll(controller, [batch, scheduler.next(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]);
      scheduler.stop();
      return;
    }
    if (!response || !response.ok) {
      controller.state.lastError = response?.error ?? t("pageEngineSilent");
      // A failing engine fails for every batch, so stop. Every block still carrying a marker has to
      // lose it, or it counts as handled and no later run will ever pick it up again.
      unmarkAll(controller, [batch, scheduler.next(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]);
      scheduler.stop();
      report(controller);
      return;
    }
    withObserverPaused(controller, batch, () => {
      batch.forEach((segment, slot) => {
        // A unit that lost its marker while the batch was in flight was reset or restored under us;
        // writing the old translation into it now would undo whatever replaced it.
        if (segment.kind === "element" && segment.element.getAttribute(UNIT_ATTRIBUTE) !== "pending") return;
        const translated = response.fragments[slot] ?? "";
        const applied = controller.renderer.apply(segment, translated, controller.options!);
        if (applied) controller.output.remember(applied);
      });
    });
    controller.state.blocksDone += batch.length;
    report(controller);
  }
  scheduler.stop();
}

function unmarkAll(controller: Controller, batches: Segment[][]): void {
  const all = batches.flat();
  withObserverPaused(controller, all, () => {
    for (const segment of all) controller.renderer.unmark(segment);
  });
}

function restore(controller: Controller): void {
  controller.generation++;
  stopObserver(controller);
  controller.deferred.clear();
  controller.output.clear();
  controller.routes.clear();
  controller.source = null;
  controller.target = null;
  controller.renderer.restoreAll();
  controller.state.translated = false;
  controller.state.translating = false;
  controller.state.blocksDone = 0;
  controller.state.blocksTotal = 0;
  controller.state.lastError = null;
  report(controller);
}

// Single-page apps keep rendering after the first pass, and they also reveal, edit and re-render
// blocks in place. Watch for all four: added nodes, text edits, the attributes that decide whether
// a block is translatable, and class or style changes that may have revealed a deferred candidate.
function startObserver(controller: Controller): void {
  stopObserver(controller);
  const observer = new MutationObserver((mutations) => {
    let queued = false;
    for (const mutation of mutations) {
      if (classify(controller, mutation)) queued = true;
    }
    if (queued) schedule(controller);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES
  });
  // The tab title lives in <head>. A single-page app sets a new one on every route, and the one
  // Glossa translated is gone at that point. Same observer, so paused writes cover it as well.
  if (document.head) observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  controller.observer = observer;
}

// Sort one mutation into "look at these nodes" or "this translated unit is stale". Returns whether
// anything was queued.
function classify(controller: Controller, mutation: MutationRecord): boolean {
  if (isOurs(mutation.target)) return false;
  switch (mutation.type) {
    case "childList":
      // A change inside a translated unit invalidates the unit as a whole: whatever it now says, the
      // translation hanging off it was made from different text. Handling the added nodes on their
      // own instead would translate a fragment and leave the rest stale.
      if (markStale(controller, mutation.target)) return true;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          if (!isOurs(node)) controller.pending.add(node);
        }
      }
      return controller.pending.size > 0;
    case "characterData":
      // An edit inside a translated unit invalidates that unit; anywhere else it is new text.
      if (markStale(controller, mutation.target)) return true;
      controller.pending.add(mutation.target);
      return true;
    case "attributes": {
      const element = mutation.target as Element;
      const name = mutation.attributeName ?? "";
      if (READABLE_ATTRIBUTES.includes(name)) {
        // The page set a tooltip, a placeholder or a label. If Glossa had translated the old value,
        // that bookkeeping is stale: what is there now is the page's, and it is translated afresh.
        if (element.hasAttribute(attributeMarker(name))) controller.renderer.forgetAttribute(element, name);
        const names = controller.attributeChanges.get(element) ?? new Set<string>();
        names.add(name);
        controller.attributeChanges.set(element, names);
        return true;
      }
      let queued = false;
      if (name === "lang" || name === "translate") queued = markStale(controller, element) || queued;
      if (DIRECT_ATTRIBUTES.has(name)) {
        controller.pending.add(element);
        queued = true;
      }
      const revealed = recheckDeferred(controller);
      return queued || revealed;
    }
    default:
      return false;
  }
}

function schedule(controller: Controller): void {
  if (
    controller.pending.size === 0 &&
    controller.stale.size === 0 &&
    controller.attributeChanges.size === 0 &&
    !controller.titleChanged
  ) {
    return;
  }
  if (controller.observerTimer !== null) window.clearTimeout(controller.observerTimer);
  controller.observerTimer = window.setTimeout(() => {
    controller.observerTimer = null;
    void translateChanged(controller);
  }, OBSERVER_DEBOUNCE_MS);
}

// Find the translated unit a changed node belongs to, if any, and mark it for a fresh translation.
function markStale(controller: Controller, node: Node): boolean {
  let current: Node | null = node;
  while (current && current !== document.body) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;
      if (element.hasAttribute(UNIT_ATTRIBUTE)) {
        controller.stale.add(element);
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

// A class or style change may have revealed something an earlier pass skipped. Only those exact
// elements are re-examined, so this stays cheap on pages that churn classes constantly.
function recheckDeferred(controller: Controller): boolean {
  if (controller.deferred.size === 0) return false;
  let queued = false;
  for (const element of controller.deferred) {
    if (!element.isConnected) {
      controller.deferred.delete(element);
      continue;
    }
    if (isShown(element)) {
      controller.deferred.delete(element);
      controller.pending.add(element);
      queued = true;
    }
  }
  return queued;
}

function isShown(element: Element): boolean {
  if ((element as HTMLElement).hidden) return false;
  const probe = element as Element & { checkVisibility?: () => boolean };
  return typeof probe.checkVisibility === "function" ? probe.checkVisibility() : true;
}

async function translateChanged(controller: Controller): Promise<void> {
  const source = controller.source;
  const target = controller.target;
  if (!controller.state.translated || !source || !target) return;
  const roots = Array.from(controller.pending);
  controller.pending.clear();
  const stale = Array.from(controller.stale);
  controller.stale.clear();
  const attributeChanges = Array.from(controller.attributeChanges);
  controller.attributeChanges.clear();
  const retitled = controller.titleChanged;
  controller.titleChanged = false;

  // Dropping our own output is itself a mutation, so do it inside a paused window.
  withObserverPaused(controller, stale, () => {
    for (const element of stale) {
      const dropped = controller.renderer.reset(element);
      if (dropped && element.isConnected) roots.push(element);
    }
  });

  // Only the topmost of any overlapping roots may be walked. Keeping both an ancestor and one of its
  // descendants collects that descendant twice, which appends two translations to the same block.
  const candidates = Array.from(new Set(roots)).filter((root) => {
    if (!root.isConnected) return false;
    // A text node inside a unit we are keeping was handled as a stale unit above.
    return !(root.nodeType === Node.TEXT_NODE && root.parentElement?.hasAttribute(UNIT_ATTRIBUTE));
  });
  const live = candidates.filter((root) => !candidates.some((other) => other !== root && other.contains(root)));
  const segments = collectFromNodes(live, segmentOptions(controller));
  for (const [element, names] of attributeChanges) {
    if (!element.isConnected) continue;
    for (const name of names) {
      const segment = attributeSegment(element, name, segmentOptions(controller));
      if (segment) segments.push(segment);
    }
  }
  const title = retitled ? document.querySelector("head > title") : null;
  if (title) segments.push(...collectFromNodes([title], segmentOptions(controller)));
  if (segments.length === 0) return;
  controller.state.blocksTotal += segments.length;
  await translateByLanguage(controller, segments, source, target, controller.generation);
}

function isOurs(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;
      if (element.tagName === "GLOSSA-TRANSLATION" || element.classList.contains("glossa-popover")) return true;
    }
    current = current.parentNode;
  }
  return false;
}

function stopObserver(controller: Controller): void {
  controller.observer?.disconnect();
  controller.observer = null;
  controller.pending.clear();
  controller.stale.clear();
  controller.attributeChanges.clear();
  controller.titleChanged = false;
  if (controller.observerTimer !== null) {
    window.clearTimeout(controller.observerTimer);
    controller.observerTimer = null;
  }
}

// Writes to the page must never come back as mutations to react to. `takeRecords` empties the queue
// without running the callback, but that queue can also hold changes the page made in the same turn
// (its own async work runs between our await and our write), and throwing those away loses content
// for good. So the records are taken and replayed: the ones targeting a node we just wrote to are
// dropped, everything else is classified as usual.
function withObserverPaused<T>(controller: Controller, written: Iterable<Segment> | Iterable<Node>, write: () => T): T {
  const ours = new Set<Node>();
  for (const entry of written as Iterable<Segment | Node>) {
    if (isSegment(entry)) {
      if (entry.kind === "text") {
        ours.add(entry.node);
        if (entry.node.parentNode) ours.add(entry.node.parentNode);
      } else {
        ours.add(entry.element);
      }
    } else {
      ours.add(entry);
    }
  }
  try {
    return write();
  } finally {
    const records = controller.observer?.takeRecords() ?? [];
    let queued = false;
    for (const record of records) {
      if (ours.has(record.target)) continue;
      if (classify(controller, record)) queued = true;
    }
    if (queued) schedule(controller);
  }
}

function isSegment(value: Segment | Node): value is Segment {
  return typeof (value as Segment).kind === "string" && (value as { nodeType?: number }).nodeType === undefined;
}

function segmentOptions(controller: Controller): { skipFormFields: boolean; deferred: Set<Element> } {
  return { skipFormFields: controller.skipFormFields, deferred: controller.deferred };
}

function report(controller: Controller): void {
  api.runtime.sendMessage({ type: "glossa:page-state", state: controller.state }).catch(() => undefined);
}

// ---- editable fields ----

// The field the user last opened a context menu in. `document.activeElement` is not reliable here:
// a right-click does not always move focus, and by the time the menu command arrives the focus may
// have moved on.
let lastEditable: HTMLElement | null = null;

document.addEventListener(
  "contextmenu",
  (event) => {
    const target = event.target as HTMLElement | null;
    lastEditable = target && isEditable(target) ? target : null;
  },
  true
);

function isEditable(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return !element.readOnly && !element.disabled && ["text", "search", "email", "url", "tel", ""].includes(type);
  }
  return element.isContentEditable;
}

function fieldText(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  return element.innerText ?? element.textContent ?? "";
}

// Written through the editor's own input machinery where possible, so the page's framework sees the
// change and the browser's undo history keeps what was there before.
function writeField(element: HTMLElement, text: string): void {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    element.select();
    if (!document.execCommand("insertText", false, text)) {
      element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (!document.execCommand("insertText", false, text)) {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

async function translateField(controller: Controller, target: string): Promise<void> {
  const element = lastEditable && lastEditable.isConnected ? lastEditable : null;
  if (!element) {
    showPopover(t("fieldNotFound"), null, true);
    return;
  }
  const rect = element.getBoundingClientRect();
  const text = fieldText(element).trim();
  if (!text) {
    showPopover(t("fieldEmpty"), rect, true);
    return;
  }
  const detectRequest: DetectRequest = {
    type: "glossa:detect",
    sample: text.slice(0, 2000),
    htmlLang: document.documentElement.getAttribute("lang")
  };
  const detected = (await api.runtime.sendMessage(detectRequest)) as DetectResponse | undefined;
  const source = detected?.language ?? controller.state.detectedLanguage;
  if (!source) {
    showPopover(t("popoverNoLanguage"), rect, true);
    return;
  }
  if (source === target) {
    showPopover(t("popoverAlready", target), rect, true);
    return;
  }
  const pending = showPopover(t("popoverTranslating"), rect, false);
  const request: TranslateRequest = {
    type: "glossa:translate",
    sourceLanguage: source,
    targetLanguage: target,
    // Paragraph by paragraph, so a long message keeps its shape.
    fragments: text.split(/\n{2,}/).map((paragraph) => escapeForEngine(paragraph))
  };
  const response = (await api.runtime.sendMessage(request)) as TranslateResponse | undefined;
  // Closed while the engine worked: leave it closed, and leave the field as the reader left it.
  if (pending !== popoverToken) return;
  if (!response || !response.ok) {
    showPopover(response?.error ?? t("popoverNoAnswer"), rect, true);
    return;
  }
  const parsed = new DOMParser().parseFromString(`<body>${response.fragments.join("\n\n")}</body>`, "text/html");
  writeField(element, parsed.body.textContent ?? "");
  showPopover(t("fieldTranslated"), rect, false);
}

function escapeForEngine(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- selection ----

// Offering a translation for every selection is the most complained-about behaviour in this whole
// category of extension, so it is off by default. When it is on, the offer is a button next to the
// selection: nothing is sent anywhere until it is pressed.
async function watchSelection(controller: Controller): Promise<void> {
  try {
    controller.settings = await loadSettings();
  } catch {
    return;
  }
  api.storage.onChanged.addListener((changes, area) => {
    const stored = area === "local" ? changes[SETTINGS_KEY]?.newValue : undefined;
    if (stored) controller.settings = stored as Settings;
    if (controller.settings?.selectionPopup !== true) removeSelectionButton();
  });
  // The offer is placed against where the selection was. Once the page scrolls it would point at
  // other text, so it goes; selecting again brings it back.
  window.addEventListener("scroll", removeSelectionButton, { passive: true, capture: true });
  document.addEventListener("selectionchange", () => {
    if (controller.selectionTimer !== null) window.clearTimeout(controller.selectionTimer);
    controller.selectionTimer = window.setTimeout(() => {
      controller.selectionTimer = null;
      offerSelection(controller);
    }, SELECTION_DEBOUNCE_MS);
  });
}

const SELECTION_BUTTON_CLASS = "glossa-selection-button";

function removeSelectionButton(): void {
  document.querySelector(`.${SELECTION_BUTTON_CLASS}`)?.remove();
}

function offerSelection(controller: Controller): void {
  const settings = controller.settings;
  if (!settings?.selectionPopup) return;
  removeSelectionButton();
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (!selection || selection.rangeCount === 0 || text.length < 2) return;
  const range = selection.getRangeAt(0);
  // A selection inside Glossa's own popover is not something to offer a translation of.
  if (isOurs(range.commonAncestorContainer)) return;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = SELECTION_BUTTON_CLASS;
  button.setAttribute("translate", "no");
  button.textContent = t("selectionOffer", settings.targetLanguage.toUpperCase());
  button.title = t("selectionOfferTitle");
  // Pressing the button must not take the selection away before it can be read.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    removeSelectionButton();
    void translateSelection(controller, settings.targetLanguage);
  });
  // Below the selection when there is room, above it when there is not: never on top of it.
  const below = rect.bottom + 6;
  button.style.top = `${below + 32 <= window.innerHeight ? below : Math.max(8, rect.top - 38)}px`;
  button.style.left = `${Math.min(window.innerWidth - 180, Math.max(8, rect.left))}px`;
  document.documentElement.append(button);
}

async function translateSelection(controller: Controller, target: string): Promise<void> {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (!text) {
    controller.state.lastError = t("popoverNothingSelected");
    return;
  }
  const detectRequest: DetectRequest = { type: "glossa:detect", sample: text.slice(0, 2000), htmlLang: document.documentElement.getAttribute("lang") };
  const detected = (await api.runtime.sendMessage(detectRequest)) as DetectResponse | undefined;
  const source = detected?.language ?? controller.state.detectedLanguage;
  const anchor = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  if (!source) {
    showPopover(t("popoverNoLanguage"), anchor, true);
    return;
  }
  if (source === target) {
    showPopover(t("popoverAlready", target), anchor, true);
    return;
  }
  const pending = showPopover(t("popoverTranslating"), anchor, false);
  const request: TranslateRequest = {
    type: "glossa:translate",
    sourceLanguage: source,
    targetLanguage: target,
    fragments: text.split(/\n{2,}/).map((paragraph) => escapeForEngine(paragraph))
  };
  const response = (await api.runtime.sendMessage(request)) as TranslateResponse | undefined;
  // Closed while the engine worked: an answer arriving later must not reopen it.
  if (pending !== popoverToken) return;
  if (!response || !response.ok) {
    showPopover(response?.error ?? t("popoverNoAnswer"), anchor, true);
    return;
  }
  const parsed = new DOMParser().parseFromString(`<body>${response.fragments.join("\n\n")}</body>`, "text/html");
  showPopover(parsed.body.textContent ?? "", anchor, false);
}

// The popover floats over the page, so it has to behave like something floating over a page:
// dismissible with Escape (WCAG 1.4.13), a close target of at least 24 px (2.5.8), and placed clear
// of the text it is explaining so it never covers the selection (2.4.11). It is attached to the
// document element rather than near the selection, which keeps it out of any editor the page is
// running: a box inserted inside a rich text editor gets saved as part of the document.
let closePopover: (() => void) | null = null;
// Bumped on every show and every dismissal, so a translation that finishes after the reader closed
// its "Translating…" note can tell, and the popover stays closed.
let popoverToken = 0;

function showPopover(text: string, anchor: DOMRect | null, isError: boolean): number {
  dismissPopover();
  const token = ++popoverToken;
  const box = document.createElement("div");
  box.className = `glossa-popover${isError ? " glossa-popover-error" : ""}`;
  box.setAttribute("translate", "no");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", t("popoverLabel"));
  const body = document.createElement("div");
  body.className = "glossa-popover-body";
  body.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "glossa-popover-close";
  close.textContent = t("popoverClose");
  close.addEventListener("click", () => dismissPopover());
  box.append(body, close);
  document.documentElement.append(box);
  place(box, anchor);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismissPopover();
  };
  document.addEventListener("keydown", onKeyDown, true);
  closePopover = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    box.remove();
    closePopover = null;
  };
  return token;
}

function dismissPopover(): void {
  popoverToken++;
  if (closePopover) closePopover();
  else document.querySelector(".glossa-popover")?.remove();
}

// Below the selection when there is room, above it when there is not, and never across it.
function place(box: HTMLElement, anchor: DOMRect | null): void {
  const gap = 8;
  const height = box.getBoundingClientRect().height || 80;
  const width = box.getBoundingClientRect().width || 330;
  if (!anchor) {
    box.style.top = `${gap * 2}px`;
    box.style.left = `${gap * 2}px`;
    return;
  }
  const clampLeft = (left: number): number => Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - width - gap));
  const clampTop = (top: number): number => Math.min(Math.max(gap, top), Math.max(gap, window.innerHeight - height - gap));
  let top: number;
  let left: number;
  if (anchor.bottom + gap + height <= window.innerHeight - gap) {
    top = anchor.bottom + gap;
    left = clampLeft(anchor.left);
  } else if (anchor.top - gap - height >= gap) {
    top = anchor.top - gap - height;
    left = clampLeft(anchor.left);
  } else if (anchor.right + gap + width <= window.innerWidth - gap) {
    // A tall selection leaves no room above or below, so the popover goes beside it.
    top = clampTop(anchor.top);
    left = anchor.right + gap;
  } else if (anchor.left - gap - width >= gap) {
    top = clampTop(anchor.top);
    left = anchor.left - gap - width;
  } else {
    // A selection that fills the screen leaves nowhere clear of it. The bottom corner covers the
    // least of where the reader started.
    top = Math.max(gap, window.innerHeight - height - gap);
    left = clampLeft(window.innerWidth - width - gap);
  }
  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
}

boot();

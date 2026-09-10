import { api } from "../shared/api.ts";
import type { DetectRequest, DetectResponse, PageCommand, PageState, TranslateRequest, TranslateResponse } from "../shared/messages.ts";
import { Renderer, type RenderOptions } from "./renderer.ts";
import {
  batchSegments,
  collectFromNodes,
  collectSegments,
  orderViewportFirst,
  segmentFragment,
  UNIT_ATTRIBUTE,
  type Segment
} from "./segmenter.ts";

// Injected on demand (activeTab + scripting) rather than declared for every site, so the extension
// carries no host permission for the web at all. Once injected it stays until navigation and
// answers status queries from the popup.

const INJECT_FLAG = "glossaInjected";
const OBSERVER_DEBOUNCE_MS = 250;

// Attributes worth reacting to. `hidden`, `open`, `translate`, `lang` and `aria-hidden` change
// whether a block should be translated at all; `class` and `style` only ever trigger a re-check of
// the elements an earlier pass deferred, never a fresh walk of the page.
const WATCHED_ATTRIBUTES = ["hidden", "open", "translate", "lang", "aria-hidden", "class", "style"];
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
    deferred: new Set()
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
  const parts: string[] = [];
  let length = 0;
  while (length < limit) {
    const node = walker.nextNode() as Text | null;
    if (!node) break;
    const text = node.data.replace(/\s+/g, " ").trim();
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
  }
  return parts.join(" ").slice(0, limit);
}

async function translatePage(
  controller: Controller,
  command: Extract<PageCommand, { command: "translate" }>
): Promise<void> {
  if (controller.state.translated || controller.state.translating) {
    // A second click while a page is translated switches nothing; restore first.
    return;
  }
  const source = command.sourceLanguage ?? controller.state.detectedLanguage;
  if (!source) {
    controller.state.lastError = "Could not detect the page language";
    return;
  }
  if (source === command.targetLanguage) {
    controller.state.lastError = `The page is already in ${command.targetLanguage}`;
    return;
  }
  controller.state.detectedLanguage = source;
  controller.state.targetLanguage = command.targetLanguage;
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
    const segments = orderViewportFirst(collectSegments(document.body, segmentOptions(controller)));
    controller.state.blocksTotal = segments.length;
    await translateSegments(controller, segments, source, command.targetLanguage, generation);
    if (generation !== controller.generation) return;
    controller.state.translated = controller.state.lastError === null || controller.state.blocksDone > 0;
    startObserver(controller, source, command.targetLanguage);
  } finally {
    if (generation === controller.generation) {
      controller.state.translating = false;
      report(controller);
    }
  }
}

async function translateSegments(
  controller: Controller,
  segments: Segment[],
  source: string,
  target: string,
  generation: number
): Promise<void> {
  withObserverPaused(controller, () => {
    for (const segment of segments) controller.renderer.markPending(segment);
  });
  for (const batch of batchSegments(segments)) {
    if (generation !== controller.generation) {
      withObserverPaused(controller, () => {
        for (const segment of batch) controller.renderer.unmark(segment);
      });
      continue;
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
      withObserverPaused(controller, () => {
        for (const segment of batch) controller.renderer.unmark(segment);
      });
      continue;
    }
    if (!response || !response.ok) {
      controller.state.lastError = response?.error ?? "No answer from the translation engine";
      withObserverPaused(controller, () => {
        for (const segment of batch) controller.renderer.unmark(segment);
      });
      report(controller);
      // A failing engine fails for every batch; stop instead of spamming the same error.
      break;
    }
    withObserverPaused(controller, () => {
      batch.forEach((segment, index) => {
        const translated = response.fragments[index] ?? "";
        controller.renderer.apply(segment, translated, controller.options!);
      });
    });
    controller.state.blocksDone += batch.length;
    report(controller);
  }
}

function restore(controller: Controller): void {
  controller.generation++;
  stopObserver(controller);
  controller.deferred.clear();
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
function startObserver(controller: Controller, source: string, target: string): void {
  stopObserver(controller);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (isOurs(mutation.target)) continue;
      switch (mutation.type) {
        case "childList":
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
              if (!isOurs(node)) controller.pending.add(node);
            }
          }
          // Children removed from a translated unit means the page re-rendered it: our record
          // points at nodes that are no longer in the tree.
          if (mutation.removedNodes.length > 0) markStale(controller, mutation.target);
          break;
        case "characterData":
          // An edit inside a translated unit invalidates that unit; anywhere else it is new text.
          if (!markStale(controller, mutation.target)) controller.pending.add(mutation.target);
          break;
        case "attributes": {
          const element = mutation.target as Element;
          const name = mutation.attributeName ?? "";
          if (name === "lang" || name === "translate") markStale(controller, element);
          if (DIRECT_ATTRIBUTES.has(name)) controller.pending.add(element);
          recheckDeferred(controller);
          break;
        }
      }
    }
    if (controller.pending.size === 0 && controller.stale.size === 0) return;
    if (controller.observerTimer !== null) window.clearTimeout(controller.observerTimer);
    controller.observerTimer = window.setTimeout(() => {
      controller.observerTimer = null;
      void translateChanged(controller, source, target);
    }, OBSERVER_DEBOUNCE_MS);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES
  });
  controller.observer = observer;
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
function recheckDeferred(controller: Controller): void {
  if (controller.deferred.size === 0) return;
  for (const element of controller.deferred) {
    if (!element.isConnected) {
      controller.deferred.delete(element);
      continue;
    }
    if (isShown(element)) {
      controller.deferred.delete(element);
      controller.pending.add(element);
    }
  }
}

function isShown(element: Element): boolean {
  if ((element as HTMLElement).hidden) return false;
  const probe = element as Element & { checkVisibility?: () => boolean };
  return typeof probe.checkVisibility === "function" ? probe.checkVisibility() : true;
}

async function translateChanged(controller: Controller, source: string, target: string): Promise<void> {
  if (!controller.state.translated) return;
  const roots = Array.from(controller.pending);
  controller.pending.clear();
  const stale = Array.from(controller.stale);
  controller.stale.clear();

  // Dropping our own output is itself a mutation, so do it inside a paused window.
  withObserverPaused(controller, () => {
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
  if (segments.length === 0) return;
  controller.state.blocksTotal += segments.length;
  await translateSegments(controller, segments, source, target, controller.generation);
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
  if (controller.observerTimer !== null) {
    window.clearTimeout(controller.observerTimer);
    controller.observerTimer = null;
  }
}

// Writes to the page must never come back as mutations to react to. The records a synchronous write
// queues are dropped with takeRecords, which empties the queue without running the callback.
function withObserverPaused<T>(controller: Controller, write: () => T): T {
  try {
    return write();
  } finally {
    controller.observer?.takeRecords();
  }
}

function segmentOptions(controller: Controller): { skipFormFields: boolean; deferred: Set<Element> } {
  return { skipFormFields: true, deferred: controller.deferred };
}

function report(controller: Controller): void {
  api.runtime.sendMessage({ type: "glossa:page-state", state: controller.state }).catch(() => undefined);
}

// ---- selection ----

async function translateSelection(controller: Controller, target: string): Promise<void> {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (!text) {
    controller.state.lastError = "Nothing is selected";
    return;
  }
  const detectRequest: DetectRequest = { type: "glossa:detect", sample: text.slice(0, 2000), htmlLang: document.documentElement.getAttribute("lang") };
  const detected = (await api.runtime.sendMessage(detectRequest)) as DetectResponse | undefined;
  const source = detected?.language ?? controller.state.detectedLanguage;
  const anchor = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  if (!source) {
    showPopover("Could not detect the language of the selection.", anchor, true);
    return;
  }
  if (source === target) {
    showPopover(`Already in ${target}.`, anchor, true);
    return;
  }
  showPopover("Translating…", anchor, false);
  const request: TranslateRequest = {
    type: "glossa:translate",
    sourceLanguage: source,
    targetLanguage: target,
    fragments: text.split(/\n{2,}/).map((paragraph) => paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
  };
  const response = (await api.runtime.sendMessage(request)) as TranslateResponse | undefined;
  if (!response || !response.ok) {
    showPopover(response?.error ?? "The translation engine did not answer.", anchor, true);
    return;
  }
  const parsed = new DOMParser().parseFromString(`<body>${response.fragments.join("\n\n")}</body>`, "text/html");
  showPopover(parsed.body.textContent ?? "", anchor, false);
}

function showPopover(text: string, anchor: DOMRect | null, isError: boolean): void {
  document.querySelector(".glossa-popover")?.remove();
  const box = document.createElement("div");
  box.className = `glossa-popover${isError ? " glossa-popover-error" : ""}`;
  box.setAttribute("translate", "no");
  const body = document.createElement("div");
  body.className = "glossa-popover-body";
  body.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "glossa-popover-close";
  close.textContent = "Close";
  close.addEventListener("click", () => box.remove());
  box.append(body, close);
  const top = anchor ? Math.min(window.innerHeight - 40, Math.max(8, anchor.bottom + 8)) : 16;
  const left = anchor ? Math.min(window.innerWidth - 340, Math.max(8, anchor.left)) : 16;
  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
  document.documentElement.append(box);
}

boot();

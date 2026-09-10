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
const OBSERVER_DEBOUNCE_MS = 400;

interface Controller {
  state: PageState;
  renderer: Renderer;
  options: RenderOptions | null;
  observer: MutationObserver | null;
  observerTimer: number | null;
  generation: number;
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
    generation: 0
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
    const segments = orderViewportFirst(collectSegments(document.body, { skipFormFields: true }));
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
  for (const segment of segments) controller.renderer.markPending(segment);
  for (const batch of batchSegments(segments)) {
    if (generation !== controller.generation) {
      for (const segment of batch) controller.renderer.unmark(segment);
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
      for (const segment of batch) controller.renderer.unmark(segment);
      continue;
    }
    if (!response || !response.ok) {
      controller.state.lastError = response?.error ?? "No answer from the translation engine";
      for (const segment of batch) controller.renderer.unmark(segment);
      report(controller);
      // A failing engine fails for every batch; stop instead of spamming the same error.
      break;
    }
    batch.forEach((segment, index) => {
      const translated = response.fragments[index] ?? "";
      controller.renderer.apply(segment, translated, controller.options!);
    });
    controller.state.blocksDone += batch.length;
    report(controller);
  }
}

function restore(controller: Controller): void {
  controller.generation++;
  stopObserver(controller);
  controller.renderer.restoreAll();
  controller.state.translated = false;
  controller.state.translating = false;
  controller.state.blocksDone = 0;
  controller.state.blocksTotal = 0;
  controller.state.lastError = null;
  report(controller);
}

// Single-page apps keep rendering after the first pass. Watch for new blocks and translate them
// with the same settings, ignoring the nodes this extension inserted.
function startObserver(controller: Controller, source: string, target: string): void {
  stopObserver(controller);
  const pending = new Set<Node>();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (isOurs(mutation.target)) continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          if (!isOurs(node)) pending.add(node);
        }
      }
    }
    if (pending.size === 0) return;
    if (controller.observerTimer !== null) window.clearTimeout(controller.observerTimer);
    controller.observerTimer = window.setTimeout(() => {
      controller.observerTimer = null;
      const roots = Array.from(pending);
      pending.clear();
      void translateAdded(controller, roots, source, target);
    }, OBSERVER_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  controller.observer = observer;
}

async function translateAdded(controller: Controller, roots: Node[], source: string, target: string): Promise<void> {
  if (!controller.state.translated) return;
  const live: Node[] = [];
  const seen = new Set<Node>();
  for (const root of roots) {
    if (!root.isConnected || seen.has(root)) continue;
    // A text node whose parent is already a translated unit was re-rendered by the page; the
    // unit will be picked up again only if the page replaced the whole block.
    if (root.nodeType === Node.TEXT_NODE && root.parentElement?.hasAttribute(UNIT_ATTRIBUTE)) continue;
    // Skip nodes nested under another added node; the ancestor walk covers them.
    let covered = false;
    for (const other of seen) {
      if (other !== root && other.contains(root)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    seen.add(root);
    live.push(root);
  }
  const segments = collectFromNodes(live, { skipFormFields: true });
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
  if (controller.observerTimer !== null) {
    window.clearTimeout(controller.observerTimer);
    controller.observerTimer = null;
  }
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

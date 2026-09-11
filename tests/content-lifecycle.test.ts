import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

// The content script as a page sees it: loaded into a document, talking to a fake extension API
// that records every message it sends and can hold an engine answer back. Used here for what
// happens when the reader leaves a page mid-translation and comes back through the back-forward
// cache.

const window = new Window({ url: "https://example.org/articulo" });
const globals = globalThis as Record<string, unknown>;
for (const name of [
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "ShadowRoot",
  "Document",
  "DocumentFragment",
  "DOMParser",
  "NodeFilter",
  "MutationObserver",
  "Event",
  "KeyboardEvent"
]) {
  globals[name] = (window as unknown as Record<string, unknown>)[name];
}
globals.window = window;
globals.document = window.document;
globals.location = window.location;
globals.__GLOSSA_HAS_OFFSCREEN__ = true;

type Message = { type: string; [key: string]: unknown };
const sent: Message[] = [];
let onMessage: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean) | null = null;
// Every translate request waits on this until a test lets it through.
let gate: Promise<void> = Promise.resolve();

globals.chrome = {
  runtime: {
    onMessage: {
      addListener: (listener: typeof onMessage) => {
        onMessage = listener;
      }
    },
    sendMessage: async (message: Message) => {
      sent.push(message);
      if (message.type === "glossa:detect") return { language: "es", confident: true };
      if (message.type === "glossa:translate") {
        await gate;
        const fragments = message["fragments"] as string[];
        return { ok: true, fragments: fragments.map((fragment) => `EN ${fragment}`), inferenceMs: 1 };
      }
      return undefined;
    }
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => undefined } },
  i18n: { getMessage: (key: string) => key, getUILanguage: () => "en-US" }
};

// More paragraphs than one batch holds (24), so a translation takes at least two requests.
window.document.body.innerHTML = Array.from(
  { length: 30 },
  (_, index) => `<p>Este es el párrafo número ${index + 1} de la página, con texto suficiente para traducir.</p>`
).join("");

await import("../src/content/content.ts");
assert.ok(onMessage, "the content script did not listen for commands");

function command(message: Record<string, unknown>): Promise<{ translating: boolean; translated: boolean; detectedLanguage: string | null }> {
  return new Promise((resolve) => {
    onMessage!({ type: "glossa:page-command", ...message }, {}, resolve as (value: unknown) => void);
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "timed out waiting");
}

const count = (type: string) => sent.filter((message) => message.type === type).length;

test("leaving the page mid-translation sends nothing more to the engine", async () => {
  let release: () => void = () => undefined;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = command({ command: "translate", targetLanguage: "en", displayMode: "bilingual", showOriginalOnHover: false, skipFormFields: true });
  await until(() => count("glossa:translate") === 1);
  window.dispatchEvent(new window.Event("pagehide"));
  release();
  await running;
  // Give a second batch every chance to go out if something still wanted to send it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(count("glossa:translate"), 1, "a batch was sent after the page was left");
  const state = await command({ command: "status" });
  assert.equal(state.translating, false, "the page still claims to be translating");
});

test("coming back from the back-forward cache checks the language again", async () => {
  const before = count("glossa:detect");
  const shown = new window.Event("pageshow");
  Object.defineProperty(shown, "persisted", { value: true });
  window.dispatchEvent(shown);
  await until(() => count("glossa:detect") === before + 1);
});

test("an ordinary page load does not count as coming back", async () => {
  const before = count("glossa:detect");
  const shown = new window.Event("pageshow");
  Object.defineProperty(shown, "persisted", { value: false });
  window.dispatchEvent(shown);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(count("glossa:detect"), before);
});

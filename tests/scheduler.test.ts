import assert from "node:assert/strict";
import { test } from "node:test";

// The scheduler decides what the engine sees next. What matters is the order under a viewport that
// moves, so the IntersectionObserver is faked here: entries are delivered on demand, which is the
// only way to say "this block is on screen now, that one is not" in a test.

interface FakeEntry {
  target: unknown;
  isIntersecting: boolean;
}

let deliver: ((entries: FakeEntry[]) => void) | null = null;
const observed: unknown[] = [];

class FakeIntersectionObserver {
  constructor(callback: (entries: FakeEntry[]) => void) {
    deliver = callback;
  }
  observe(target: unknown): void {
    observed.push(target);
  }
  disconnect(): void {
    deliver = null;
  }
}

const globals = globalThis as Record<string, unknown>;
globals.IntersectionObserver = FakeIntersectionObserver;

const { createScheduler, whenVisible } = await import("../src/content/scheduler.ts");

function block(id: string, characters = 40) {
  const element = { id } as unknown as Element;
  return {
    kind: "element" as const,
    element,
    html: "x".repeat(characters),
    text: "x".repeat(characters),
    holds: [],
    lang: null
  };
}

function ids(batch: Array<{ element: Element }>): string[] {
  return batch.map((segment) => (segment.element as unknown as { id: string }).id);
}

test("with nothing on screen yet, the queue keeps document order", () => {
  observed.length = 0;
  const scheduler = createScheduler([block("a"), block("b"), block("c")]);
  assert.equal(scheduler.size, 3);
  assert.deepEqual(ids(scheduler.next(2, 10_000) as never), ["a", "b"]);
  assert.deepEqual(ids(scheduler.next(2, 10_000) as never), ["c"]);
  assert.deepEqual(scheduler.next(2, 10_000), []);
  scheduler.stop();
});

test("blocks on screen are translated before blocks that are not", () => {
  observed.length = 0;
  const blocks = ["a", "b", "c", "d", "e"].map((id) => block(id));
  const scheduler = createScheduler(blocks);
  assert.equal(observed.length, 5, "every block should be watched");
  // The reader is looking at d and e.
  deliver?.([
    { target: blocks[3]!.element, isIntersecting: true },
    { target: blocks[4]!.element, isIntersecting: true }
  ]);
  assert.deepEqual(ids(scheduler.next(2, 10_000) as never), ["d", "e"]);
  // Then the rest, in document order.
  assert.deepEqual(ids(scheduler.next(5, 10_000) as never), ["a", "b", "c"]);
  scheduler.stop();
});

test("scrolling re-orders what is left", () => {
  observed.length = 0;
  const blocks = ["a", "b", "c", "d"].map((id) => block(id));
  const scheduler = createScheduler(blocks);
  deliver?.([{ target: blocks[0]!.element, isIntersecting: true }]);
  assert.deepEqual(ids(scheduler.next(1, 10_000) as never), ["a"]);
  // The reader scrolls: c comes into view, and it goes next even though b is earlier.
  deliver?.([{ target: blocks[2]!.element, isIntersecting: true }]);
  assert.deepEqual(ids(scheduler.next(1, 10_000) as never), ["c"]);
  assert.deepEqual(ids(scheduler.next(4, 10_000) as never), ["b", "d"]);
  scheduler.stop();
});

test("a block that scrolls out of view before its turn goes back in the queue", () => {
  observed.length = 0;
  const blocks = ["a", "b"].map((id) => block(id));
  const scheduler = createScheduler(blocks);
  deliver?.([{ target: blocks[1]!.element, isIntersecting: true }]);
  deliver?.([{ target: blocks[1]!.element, isIntersecting: false }]);
  assert.deepEqual(ids(scheduler.next(2, 10_000) as never), ["a", "b"]);
  scheduler.stop();
});

test("a batch is bounded by both its count and its characters", () => {
  observed.length = 0;
  const blocks = Array.from({ length: 30 }, (_, index) => block(`b${index}`, 50));
  const scheduler = createScheduler(blocks);
  assert.equal(scheduler.next(8, 100_000).length, 8);
  // 50 characters each: a 120-character budget takes two, and always at least one.
  assert.equal(scheduler.next(100, 120).length, 2);
  assert.equal(scheduler.next(100, 1).length, 1, "a budget smaller than one block must still move");
  scheduler.stop();
});

test("stopping empties the queue", () => {
  observed.length = 0;
  const scheduler = createScheduler([block("a")]);
  scheduler.stop();
  assert.equal(scheduler.size, 0);
  assert.deepEqual(scheduler.next(10, 10_000), []);
});

test("a visible tab does not wait", async () => {
  const globals2 = globalThis as Record<string, unknown>;
  globals2.document = { visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined };
  await whenVisible();
  assert.ok(true, "whenVisible resolved on a visible tab");
});

test("a hidden tab waits until it is shown again", async () => {
  const listeners: Array<() => void> = [];
  const fakeDocument = {
    visibilityState: "hidden",
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    removeEventListener: () => undefined
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  let resolved = false;
  const waiting = whenVisible().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false, "a hidden tab should still be waiting");
  fakeDocument.visibilityState = "visible";
  for (const listener of listeners) listener();
  await waiting;
  assert.equal(resolved, true);
});

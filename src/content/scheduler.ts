import { segmentElement, segmentLength, type Segment } from "./segmenter.ts";

// What to translate next. A long page has hundreds of blocks and the engine works through them one
// batch at a time, so the order decides whether the reader watches the text they are looking at
// turn into their language, or watches paragraphs far below the fold change while the ones in front
// of them sit in the source language.
//
// Reading positions with getBoundingClientRect per block would force a layout for every decision.
// An IntersectionObserver reports the same thing for free, and keeps reporting it as the reader
// scrolls, so the queue re-orders itself under a moving viewport. Firefox does the same with four
// observers and scroll-direction priorities; one observer plus "visible first" is most of the value.

export interface Scheduler {
  readonly size: number;
  // The next batch, visible blocks first, bounded by count and by characters.
  next(maxItems: number, maxChars: number): Segment[];
  stop(): void;
}

export function createScheduler(segments: Segment[]): Scheduler {
  const waiting = new Set<Segment>(segments);
  const visible = new Set<Segment>();
  const byElement = new Map<Element, Segment[]>();
  for (const segment of segments) {
    const element = segmentElement(segment);
    if (!element) continue;
    const list = byElement.get(element);
    if (list) list.push(segment);
    else byElement.set(element, [segment]);
  }

  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        for (const segment of byElement.get(entry.target) ?? []) {
          if (!waiting.has(segment) && !visible.has(segment)) continue;
          if (entry.isIntersecting) {
            waiting.delete(segment);
            visible.add(segment);
          } else if (visible.delete(segment)) {
            waiting.add(segment);
          }
        }
      }
    });
    for (const element of byElement.keys()) observer.observe(element);
  }

  function take(from: Set<Segment>, batch: Segment[], budget: { chars: number }, maxItems: number, maxChars: number): void {
    for (const segment of from) {
      if (batch.length >= maxItems) return;
      const length = segmentLength(segment);
      if (batch.length > 0 && budget.chars + length > maxChars) return;
      batch.push(segment);
      budget.chars += length;
      from.delete(segment);
    }
  }

  return {
    get size(): number {
      return waiting.size + visible.size;
    },
    next(maxItems: number, maxChars: number): Segment[] {
      const batch: Segment[] = [];
      const budget = { chars: 0 };
      take(visible, batch, budget, maxItems, maxChars);
      take(waiting, batch, budget, maxItems, maxChars);
      return batch;
    },
    stop(): void {
      observer?.disconnect();
      observer = null;
      waiting.clear();
      visible.clear();
    }
  };
}

// A tab nobody is looking at should not be holding the engine. Resolves as soon as the tab is
// shown, and immediately when it already is.
export function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

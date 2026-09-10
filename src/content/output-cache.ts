// Remembers what the engine has already produced on this page, so its own output never goes back
// in. Two ways that happens without a guard: the page copies translated text into a new node (a
// sticky header, a "recently viewed" list), or a mutation slips past the paused observer. Feeding
// target-language text to a source-language model produces garbage, which Firefox solves the same
// way, with an LRU of output strings behind `isAlreadyTranslated()`.
//
// Short strings are left out on purpose. "Total", "Email", "OK" and most single words are identical
// in several languages, and skipping those would leave real source text untranslated.

const MAX_ENTRIES = 5000;
const TTL_MS = 10 * 60 * 1000;
const MIN_LENGTH = 20;

export function normaliseOutput(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export class OutputCache {
  // Insertion-ordered, so the first key is always the least recently used.
  private readonly seen = new Map<string, number>();

  get size(): number {
    return this.seen.size;
  }

  remember(text: string, now = Date.now()): void {
    const key = normaliseOutput(text);
    if (key.length < MIN_LENGTH) return;
    this.seen.delete(key);
    this.seen.set(key, now);
    this.evict(now);
  }

  has(text: string, now = Date.now()): boolean {
    const key = normaliseOutput(text);
    if (key.length < MIN_LENGTH) return false;
    const stamp = this.seen.get(key);
    if (stamp === undefined) return false;
    if (now - stamp > TTL_MS) {
      this.seen.delete(key);
      return false;
    }
    // A hit makes the entry the most recent one: text the page keeps re-inserting stays known.
    this.seen.delete(key);
    this.seen.set(key, now);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  private evict(now: number): void {
    for (const [key, stamp] of this.seen) {
      if (now - stamp <= TTL_MS) break;
      this.seen.delete(key);
    }
    while (this.seen.size > MAX_ENTRIES) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

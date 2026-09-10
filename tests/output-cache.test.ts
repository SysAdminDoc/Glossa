import assert from "node:assert/strict";
import { test } from "node:test";

const { OutputCache, normaliseOutput } = await import("../src/content/output-cache.ts");

const LONG = "The library is open every day of the week except Sundays.";

test("text the engine produced is recognised again, whitespace and all", () => {
  const cache = new OutputCache();
  assert.equal(cache.has(LONG), false);
  cache.remember(LONG);
  assert.equal(cache.has(LONG), true);
  // A page that re-inserts the string with different wrapping is still re-inserting our output.
  assert.equal(cache.has(`\n   The library is open every   day of the week except Sundays.  `), true);
  assert.equal(normaliseOutput("  a \n b  "), "a b");
});

test("a different sentence is not a hit", () => {
  const cache = new OutputCache();
  cache.remember(LONG);
  assert.equal(cache.has("The library opens on Sundays as well, which is new."), false);
});

test("short strings are never remembered, because they collide across languages", () => {
  const cache = new OutputCache();
  cache.remember("Total");
  assert.equal(cache.size, 0);
  assert.equal(cache.has("Total"), false);
});

test("entries expire after ten minutes", () => {
  const cache = new OutputCache();
  const t0 = 1_000_000;
  cache.remember(LONG, t0);
  assert.equal(cache.has(LONG, t0 + 9 * 60_000), true);
  // The hit above refreshed the stamp, so measure the expiry from there.
  assert.equal(cache.has(LONG, t0 + 9 * 60_000 + 11 * 60_000), false);
  assert.equal(cache.size, 0);
});

test("the cache is bounded and drops the least recently used entry first", () => {
  const cache = new OutputCache();
  for (let index = 0; index < 5010; index++) {
    cache.remember(`Sentence number ${index} of the translated page.`);
  }
  assert.equal(cache.size, 5000);
  assert.equal(cache.has("Sentence number 0 of the translated page."), false);
  assert.equal(cache.has("Sentence number 5009 of the translated page."), true);
});

test("a refreshed entry survives eviction", () => {
  const cache = new OutputCache();
  const keep = "Sentence number 0 of the translated page.";
  cache.remember(keep);
  for (let index = 1; index < 5000; index++) {
    cache.remember(`Sentence number ${index} of the translated page.`);
    if (index % 1000 === 0) cache.has(keep);
  }
  cache.remember("One more sentence that pushes the cache over its limit.");
  assert.equal(cache.has(keep), true);
});

test("clear forgets everything, which is what showing the original must do", () => {
  const cache = new OutputCache();
  cache.remember(LONG);
  cache.clear();
  assert.equal(cache.has(LONG), false);
});

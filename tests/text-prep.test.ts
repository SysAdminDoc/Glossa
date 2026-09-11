import assert from "node:assert/strict";
import { test } from "node:test";

const { prepareForEngine, restoreEdges } = await import("../src/engine/text-prep.ts");

test("soft hyphens are taken out before the engine sees the text", () => {
  assert.equal(prepareForEngine("La biblio­teca muni­cipal abre hoy.", "es").core, "La biblioteca municipal abre hoy.");
  assert.equal(prepareForEngine("­Hola", "es").core, "Hola");
});

test("the page's own edges are set aside and put back byte for byte", () => {
  const prepared = prepareForEngine(" \n\tHola, mundo.  \n", "es");
  assert.equal(prepared.core, "Hola, mundo.");
  // Whatever the engine does with spacing at the edges, the page's comes back.
  assert.equal(restoreEdges("  Hello, world.  ", prepared), " \n\tHello, world.  \n");
  assert.equal(restoreEdges("Hello, world.", prepareForEngine("Hola, mundo.", "es")), "Hello, world.");
});

test("an empty answer stays empty, so the renderer leaves the block alone", () => {
  assert.equal(restoreEdges("   ", prepareForEngine("  Hola  ", "es")), "");
  assert.equal(prepareForEngine("   \n ", "es").core, "");
});

test("Japanese, Chinese and Korean get a space between a full stop and an opening quote", () => {
  assert.equal(prepareForEngine("今日は晴れ。“明日は雨”", "ja").core, "今日は晴れ。 “明日は雨”");
  assert.equal(prepareForEngine("好的！「走吧」", "zh-Hans").core, "好的！ 「走吧」");
  assert.equal(prepareForEngine("정말요？『네』", "ko").core, "정말요？ 『네』");
  // A closing quote after the full stop belongs to that sentence and is left where it is.
  assert.equal(prepareForEngine("「こんにちは。」次です。", "ja").core, "「こんにちは。」次です。");
  // Other source languages keep their text exactly as it was.
  assert.equal(prepareForEngine("Fin。“Otro”", "es").core, "Fin。“Otro”");
});

test("a long run of spaces does not slow the edge scan down", () => {
  const spaces = " ".repeat(200_000);
  const started = performance.now();
  const prepared = prepareForEngine(`${spaces}a${spaces}b${spaces}`, "es");
  assert.equal(prepared.core, `a${spaces}b`);
  assert.ok(performance.now() - started < 200, "the edge scan took too long on a long run of spaces");
});

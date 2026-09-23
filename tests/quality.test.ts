import assert from "node:assert/strict";
import { test } from "node:test";

// The quality label before a download. The model's score comes from Mozilla's registry at run time;
// these are the registry's figures for the released models on 2026-09-23 (tools/quality-reference.mjs
// prints them), so the verdicts below are the ones a reader saw that day.

const globals = globalThis as Record<string, unknown>;
// esbuild substitutes this in a real build; Node's type stripping does not.
globals.__GLOSSA_HAS_OFFSCREEN__ = true;
globals.chrome = { i18n: { getMessage: (key: string, values: string[]) => `${key}(${values.join("|")})`, getUILanguage: () => "en" } };

const { describeQuality, isLowerQuality, referenceScore } = await import("../src/shared/quality.ts");

const hop = (pairKey: string, comet: number) => ({ pairKey, comet, reference: referenceScore(pairKey) });

test("the ten pairs furthest behind Google Translate read as lower", () => {
  const weakest: Array<[string, number]> = [
    ["ml->en", 0.8485], ["en->az", 0.8372], ["en->fa", 0.8462], ["en->lv", 0.8686], ["kn->en", 0.8434],
    ["te->en", 0.8507], ["ta->en", 0.8425], ["lt->en", 0.8365], ["bn->en", 0.8547], ["en->th", 0.8593]
  ];
  for (const [pairKey, comet] of weakest) {
    assert.ok(referenceScore(pairKey) !== null, `no Google score for ${pairKey}`);
    assert.equal(isLowerQuality([hop(pairKey, comet)]), true, `${pairKey} read as standard`);
  }
});

test("a typical pair reads as standard, and so does the one ahead of Google", () => {
  assert.equal(isLowerQuality([hop("es->en", 0.8572)]), false);
  assert.equal(isLowerQuality([hop("gu->en", 0.8695)]), false, "4.4 points behind is not yet lower");
  assert.equal(isLowerQuality([hop("en->ur", 0.8316)]), false);
});

test("a route through English is lower when either half is, and a pair with no Google score is judged on nothing", () => {
  assert.equal(isLowerQuality([hop("es->en", 0.8572), hop("en->th", 0.8593)]), true);
  assert.equal(isLowerQuality([{ pairKey: "hbs->en", comet: 0.7, reference: null }]), false);
});

test("the label carries both scores for the tooltip", () => {
  const { label, detail, lower } = describeQuality([hop("en->th", 0.8593)]);
  assert.equal(lower, true);
  assert.equal(label, "qualityLower()");
  assert.match(detail, /^qualityDetail\(.+\|85\.9\|90\.5\)$/);
});

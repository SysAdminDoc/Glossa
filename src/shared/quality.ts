import { t } from "./i18n.ts";
import { languageName } from "./languages.ts";
import { GOOGLE_COMET22 } from "./quality-reference.ts";

// How a language pair's model compares with an online translator, shown before its download so a
// reader on a weak pair knows what to expect. Both scores are COMET22 on the FLORES+ test set, the
// one Mozilla grades its models on: the model's own comes from Mozilla's registry for the exact
// file Glossa would download, Google Translate's from Mozilla's evaluation database
// (tools/quality-reference.mjs).

// A pair is "lower" when its model trails Google Translate by this much. Across Mozilla's released
// models the gap averages 3.1 points, and at 4.5 about ten pairs qualify (2026-09-23).
export const LOWER_QUALITY_GAP = 0.045;

export interface HopQuality {
  pairKey: string;
  // The model's score, and Google Translate's on the same test when Mozilla measured it.
  comet: number;
  reference: number | null;
}

export function referenceScore(pairKey: string): number | null {
  return GOOGLE_COMET22[pairKey] ?? null;
}

// A route through English is as weak as its weaker half.
export function isLowerQuality(hops: HopQuality[]): boolean {
  return hops.some((hop) => hop.reference !== null && hop.reference - hop.comet >= LOWER_QUALITY_GAP);
}

// The label, and the figures behind it for a tooltip, worded for the reader.
export function describeQuality(hops: HopQuality[]): { label: string; detail: string; lower: boolean } {
  const lower = isLowerQuality(hops);
  const detail = hops
    .map((hop) => {
      const [source = "", target = ""] = hop.pairKey.split("->");
      const pair = `${languageName(source)} → ${languageName(target)}`;
      const score = (hop.comet * 100).toFixed(1);
      return hop.reference === null
        ? t("qualityDetailAlone", pair, score)
        : t("qualityDetail", pair, score, (hop.reference * 100).toFixed(1));
    })
    .join("\n");
  return { label: lower ? t("qualityLower") : t("qualityStandard"), detail, lower };
}

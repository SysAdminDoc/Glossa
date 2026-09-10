// What the language detector is allowed to see. Detection is the single most complained-about part
// of every translator (Firefox's own meta bug collects a fresh report most weeks), and almost every
// bad verdict comes from feeding the detector something that is not prose: a wall of numbers, a list
// of urls, navigation labels in a different language from the article, or ten characters of text.
//
// So: only lines that read like sentences, and enough of them to mean something. "Enough" cannot be
// a character count. A Japanese paragraph says in 40 characters what English needs 150 for, Hangul
// packs a syllable into one character, Thai writes without spaces at all, and Devanagari and Arabic
// carry half their vowels as combining marks that are not letters at all. Counting raw letters made
// every one of those scripts look like a page with nothing on it.

const LETTER = /[\p{L}\p{M}]/u;
const LETTERS = /[\p{L}\p{M}]/gu;

// Scripts where one character is a syllable or a whole word. Worth several Latin letters each to
// anything trying to identify the language.
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/gu;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/giu;

// Weighted, not counted: see above. Calibrated on three-paragraph pages in Spanish, Japanese,
// Chinese, Korean, Hindi, Thai and Arabic, which all sit above it, against pages of numbers, dates
// and navigation labels, which all sit below. An unsure verdict costs the user one click; a wrong
// one costs them a page translated from the wrong language, so the floor stays low and the
// reliability check downstream does the rest.
export const MIN_SAMPLE_WEIGHT = 60;
// One dense character is a whole syllable, so a single hanzi in its own text node still counts.
// Japanese pages with furigana put every character in a node of its own.
const MIN_LINE_WEIGHT = 2;

export function weighText(text: string): number {
  const letters = text.match(LETTERS)?.length ?? 0;
  const dense = text.match(DENSE)?.length ?? 0;
  return letters + dense * 2.5;
}

export function isProseLine(line: string): boolean {
  const withoutUrls = line.replace(URL_LIKE, " ");
  if (weighText(withoutUrls) < MIN_LINE_WEIGHT) return false;
  // Half the visible characters have to be letters. "2026-09-10 12:45:01 [INFO] ok" does not pass,
  // and neither does a price list or a row of ids.
  const visible = withoutUrls.replace(/\s+/gu, "").length;
  const letters = withoutUrls.match(LETTERS)?.length ?? 0;
  return visible > 0 && letters / visible >= 0.5;
}

// Build the sample from the lines that survive, in document order, up to a budget. Returns an empty
// string when the page does not hold enough prose to judge, which the caller must treat as "unsure"
// rather than as a language.
export function buildSample(lines: Iterable<string>, limit = 4000): string {
  const kept: string[] = [];
  let weight = 0;
  let length = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+/gu, " ").trim();
    if (!line || !LETTER.test(line) || !isProseLine(line)) continue;
    kept.push(line);
    weight += weighText(line);
    length += line.length + 1;
    if (length >= limit) break;
  }
  if (weight < MIN_SAMPLE_WEIGHT) return "";
  return kept.join(" ").slice(0, limit);
}

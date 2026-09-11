// Text is cleaned on its way to the engine, and its edges are put back on the way out. Firefox's own
// translation worker does the same (`cleanText` in translations-engine.worker.js), for reasons this
// engine shares:
// - a soft hyphen (U+00AD, all over Wikipedia) is invisible on the page, but the model reads it as a
//   character and it comes back as garbage in the middle of a word;
// - Bergamot's sentence splitter does not split after 。！？ when an opening quote follows with no
//   space between them, so two Japanese, Chinese or Korean sentences go through as one;
// - leading and trailing whitespace confuses the model, and whatever it does with it, the page's own
//   spacing around a block has to come back byte for byte.

const SOFT_HYPHEN = /­/g;
const WHITESPACE = /\s/;
const CJK_SOURCES = new Set(["ja", "ko", "zh-Hans", "zh-Hant"]);
// Full-width sentence punctuation directly followed by an opening quote. A closing quote after the
// full stop belongs to that sentence and is left alone.
const CJK_SENTENCE_BEFORE_QUOTE = /([。！？])(?=["“‘「『])/g;

export interface PreparedText {
  core: string;
  lead: string;
  trail: string;
}

export function prepareForEngine(fragment: string, sourceLanguage: string): PreparedText {
  // Scanned rather than matched with /\s*$/, which backtracks badly on a long run of spaces.
  let start = 0;
  let end = fragment.length;
  while (start < end && WHITESPACE.test(fragment.charAt(start))) start++;
  while (end > start && WHITESPACE.test(fragment.charAt(end - 1))) end--;
  let core = fragment.slice(start, end).replace(SOFT_HYPHEN, "");
  if (CJK_SOURCES.has(sourceLanguage)) core = core.replace(CJK_SENTENCE_BEFORE_QUOTE, "$1 ");
  return { core, lead: fragment.slice(0, start), trail: fragment.slice(end) };
}

// The engine's answer with the page's own edges. An empty answer stays empty, which is how the
// renderer knows nothing was translated.
export function restoreEdges(output: string, prepared: PreparedText): string {
  const core = output.trim();
  return core ? `${prepared.lead}${core}${prepared.trail}` : "";
}

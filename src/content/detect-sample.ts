// What the language detector is allowed to see. Detection is the single most complained-about part
// of every translator (Firefox's own meta bug collects a fresh report most weeks), and almost every
// bad verdict comes from feeding the detector something that is not prose: a wall of numbers, a list
// of urls, navigation labels in a different language from the article, or ten characters of text.
//
// So: only lines that read like sentences, and enough of them to mean something.

// A line has to be mostly letters to count. A price list, a table of ids or a stack of urls is not
// evidence of any language.
const LETTER = /\p{L}/u;
const LETTERS = /\p{L}/gu;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/giu;

export const MIN_SAMPLE_LETTERS = 200;

export function isProseLine(line: string): boolean {
  const withoutUrls = line.replace(URL_LIKE, " ");
  const letters = withoutUrls.match(LETTERS)?.length ?? 0;
  if (letters < 8) return false;
  // Half the visible characters have to be letters. "2026-09-10 12:45:01 [INFO] ok" does not pass.
  const visible = withoutUrls.replace(/\s+/gu, "").length;
  return visible > 0 && letters / visible >= 0.5;
}

// Build the sample from the lines that survive, in document order, up to a budget. Returns an empty
// string when the page does not hold enough prose to judge, which the caller must treat as "unsure"
// rather than as a language.
export function buildSample(lines: Iterable<string>, limit = 4000): string {
  const kept: string[] = [];
  let letters = 0;
  let length = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+/gu, " ").trim();
    if (!line || !LETTER.test(line) || !isProseLine(line)) continue;
    kept.push(line);
    letters += line.match(LETTERS)?.length ?? 0;
    length += line.length + 1;
    if (length >= limit) break;
  }
  if (letters < MIN_SAMPLE_LETTERS) return "";
  return kept.join(" ").slice(0, limit);
}

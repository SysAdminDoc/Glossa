// The user's glossary: names and terms that must come through a translation as written, or always
// as the user's own translation. Neither engine can be told this, so it happens before either one
// sees the text: every match becomes a `var` placeholder, which both engines copy through untouched,
// and the placeholder is filled with the term, or its translation, when the answer comes back.

export interface GlossaryEntry {
  term: string;
  // What the term becomes in a translation. Empty keeps the term exactly as written.
  translation: string;
}

export const GLOSSARY_MAX_ENTRIES = 500;
export const GLOSSARY_MAX_LENGTH = 100;

// One entry per line. "term" is never translated; "term = translation" is always translated that
// way. Blank lines are ignored, and a term given twice keeps its last line.
export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const split = line.indexOf("=");
    const term = (split < 0 ? line : line.slice(0, split)).trim();
    const translation = split < 0 ? "" : line.slice(split + 1).trim();
    entries.push({ term, translation });
  }
  return sanitizeGlossary(entries);
}

export function formatGlossary(entries: GlossaryEntry[]): string {
  return entries.map((entry) => (entry.translation ? `${entry.term} = ${entry.translation}` : entry.term)).join("\n");
}

// Whatever is stored goes through here, typed or imported: no empty terms, nothing over the length
// limit, one entry per term, and no more entries than the limit.
export function sanitizeGlossary(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];
  const byTerm = new Map<string, GlossaryEntry>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { term, translation } = item as { term?: unknown; translation?: unknown };
    if (typeof term !== "string") continue;
    const cleanTerm = term.trim();
    const cleanTranslation = typeof translation === "string" ? translation.trim() : "";
    // A term with no letter or digit in it would match punctuation all over the page.
    if (!/[\p{L}\p{N}]/u.test(cleanTerm)) continue;
    if (cleanTerm.length > GLOSSARY_MAX_LENGTH || cleanTranslation.length > GLOSSARY_MAX_LENGTH) continue;
    byTerm.delete(cleanTerm);
    byTerm.set(cleanTerm, { term: cleanTerm, translation: cleanTranslation });
  }
  return [...byTerm.values()].slice(-GLOSSARY_MAX_ENTRIES);
}

// A compiled glossary. Terms match with their exact case: "Apple" the company is not "apple" the
// fruit, and a name typed in capitals is a different entry from the same word in lower case.
export interface Glossary {
  // Global and case-sensitive. Longer terms are tried first, so "New York Times" is one match
  // rather than "New York" plus a stray word.
  scanner: RegExp;
  // The translation for each term that has one.
  translations: Map<string, string>;
}

// Scripts written without spaces between words. A term in one of them is matched wherever it
// occurs; anywhere else it has to stand as a whole word, so "Rust" leaves "Rusty" alone.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

export function compileGlossary(entries: GlossaryEntry[]): Glossary | null {
  if (entries.length === 0) return null;
  const alternatives = [...entries]
    .sort((a, b) => b.term.length - a.term.length)
    .map(({ term }) => {
      const first = term.charAt(0);
      const last = term.slice(-1);
      const before = WORD_CHAR.test(first) && !UNSPACED.test(first) ? "(?<![\\p{L}\\p{M}\\p{N}])" : "";
      const after = WORD_CHAR.test(last) && !UNSPACED.test(last) ? "(?![\\p{L}\\p{M}\\p{N}])" : "";
      return `${before}${escapeRegExp(term)}${after}`;
    });
  const translations = new Map<string, string>();
  for (const entry of entries) {
    if (entry.translation) translations.set(entry.term, entry.translation);
  }
  return { scanner: new RegExp(alternatives.join("|"), "gu"), translations };
}

function escapeRegExp(text: string): string {
  // Only the syntax characters: in a "u" pattern, escaping anything else ("\-") is an error.
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

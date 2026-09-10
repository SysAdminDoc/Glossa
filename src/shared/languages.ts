// Display names for the language codes the catalog uses. Kept as a static table so the popup
// never needs Intl.DisplayNames (which is inconsistent for script-tagged codes) and never hits
// the network for a name.
const NAMES: Record<string, string> = {
  af: "Afrikaans",
  ar: "Arabic",
  az: "Azerbaijani",
  be: "Belarusian",
  bg: "Bulgarian",
  bn: "Bangla",
  bs: "Bosnian",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  eu: "Basque",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  gl: "Galician",
  gu: "Gujarati",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  kn: "Kannada",
  ko: "Korean",
  lt: "Lithuanian",
  lv: "Latvian",
  ml: "Malayalam",
  mr: "Marathi",
  ms: "Malay",
  nb: "Norwegian Bokmål",
  nl: "Dutch",
  nn: "Norwegian Nynorsk",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sl: "Slovenian",
  sq: "Albanian",
  sr: "Serbian",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
  "zh-Hans": "Chinese (Simplified)",
  "zh-Hant": "Chinese (Traditional)"
};

// Languages in the catalog written right to left. A translation block that does not say so renders
// its punctuation in the wrong place and reads wrongly to a screen reader (WCAG 1.3.1).
const RTL = new Set(["ar", "fa", "he", "ur"]);

export function isRtlLanguage(code: string): boolean {
  return RTL.has(code.toLowerCase().split(/[-_]/)[0] ?? "");
}

export function languageName(code: string): string {
  return NAMES[code] ?? code;
}

export function knownLanguageCodes(): string[] {
  return Object.keys(NAMES);
}

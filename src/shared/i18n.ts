import { api } from "./api.ts";

// Every string a person reads goes through here. `chrome.i18n` picks the file under _locales that
// matches the browser's UI language and falls back to English, so a locale that is missing a key
// gets the English one rather than an empty box.
//
// A translator whose own interface is English-only is a complaint people actually file, so this
// covers the popup, the options page and what the content script puts on the page. What it does not
// cover is the engine's diagnostics: those name hosts, hashes and file sizes, and an English
// sentence around them is easier to search for than a translated one.

export function t(key: string, ...substitutions: string[]): string {
  const message = api.i18n.getMessage(key, substitutions);
  // An unknown key returns an empty string. Showing the key is more useful than showing nothing,
  // and the build refuses to ship a key that is not in the English file.
  return message || key;
}

// Fills in a document that marks its strings up:
//   <span data-i18n="popupPageLanguage"></span>
//   <input data-i18n-attr="placeholder=optionsRuleHostPlaceholder" />
// Attributes are listed as `attribute=key`, separated by commas.
export function localize(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset["i18n"];
    if (key) element.textContent = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-attr]")) {
    for (const pair of (element.dataset["i18nAttr"] ?? "").split(",")) {
      const [attribute, key] = pair.split("=").map((part) => part.trim());
      if (attribute && key) element.setAttribute(attribute, t(key));
    }
  }
}

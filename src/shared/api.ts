// One handle for the extension API in both browsers. Firefox exposes the promise-returning
// `browser` namespace; Chrome MV3 returns promises from `chrome.*` whenever no callback is passed,
// and Chrome 153 exposes a `browser` alias of its own. Every call site in Glossa uses the promise
// form, so this alias is enough. Do not use the presence of `browser` to detect Firefox.
declare const browser: typeof chrome | undefined;

export const api: typeof chrome =
  typeof browser !== "undefined" && browser ? browser : chrome;

// Chrome's service worker cannot host a Worker or the WASM engine for long, so the engine lives in
// an offscreen document there. Firefox has no offscreen API and no need for one: its background
// page keeps the engine resident.
export const hasOffscreenApi: boolean = typeof chrome !== "undefined" && Boolean(chrome.offscreen);

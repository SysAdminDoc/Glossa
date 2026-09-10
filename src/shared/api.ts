// One handle for the extension API in both browsers. Firefox exposes the promise-returning
// `browser` namespace; Chrome MV3 returns promises from `chrome.*` whenever no callback is passed,
// and Chrome 153 exposes a `browser` alias of its own. Every call site in Glossa uses the promise
// form, so this alias is enough. Do not use the presence of `browser` to detect Firefox.
declare const browser: typeof chrome | undefined;

export const api: typeof chrome =
  typeof browser !== "undefined" && browser ? browser : chrome;

// Chrome's service worker cannot host a Worker or the WASM engine for long, so the engine lives in
// an offscreen document there. Firefox has no such API and no need for one: its background page
// keeps the engine resident. The build sets the flag per target, which lets esbuild drop the Chrome
// branch from the Firefox bundle entirely. AMO rejects calls to APIs Firefox does not have.
declare const __GLOSSA_HAS_OFFSCREEN__: boolean;

export const hasOffscreenApi: boolean =
  __GLOSSA_HAS_OFFSCREEN__ && typeof chrome !== "undefined" && Boolean(chrome.offscreen);

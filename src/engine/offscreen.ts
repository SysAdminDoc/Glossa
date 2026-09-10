import { api } from "../shared/api.ts";
import { isEngineRequest, type EngineResponse } from "../shared/messages.ts";
import { EngineHost } from "./engine-host.ts";

// Chrome only. The service worker cannot keep a Worker alive between events, so the engine is
// hosted in this offscreen document and the service worker talks to it over runtime messages.

const host = new EngineHost();
// An offscreen document created for the WORKERS reason has no lifetime of its own: it lives until
// the browser exits unless something closes it. It cannot call chrome.offscreen either (only
// chrome.runtime is available here), so it closes itself once the engine has gone idle.
host.onIdle = () => window.close();
// Exposed for the browser smoke and for manual debugging from the page's devtools.
(globalThis as { glossaEngineHost?: EngineHost }).glossaEngineHost = host;

api.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: EngineResponse) => void) => {
  if (!isEngineRequest(message)) return false;
  host
    .handle(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
  return true;
});

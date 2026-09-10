import { api } from "./api.ts";
import type { UiRequest } from "./messages.ts";

// The background answers UI requests with either the result or `{ ok: false, error }` when the
// handler threw. Surface the latter as a rejection so callers have one error path.
export async function sendUi<T>(request: UiRequest): Promise<T> {
  const response = (await api.runtime.sendMessage(request)) as T | { ok: false; error: string } | undefined;
  if (response && typeof response === "object" && (response as { ok?: unknown }).ok === false) {
    throw new Error((response as { error: string }).error);
  }
  return response as T;
}

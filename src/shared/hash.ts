export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  // Typed arrays over a SharedArrayBuffer are not BufferSource in TS 5.9+; the data here is always
  // a plain ArrayBuffer, so the cast is a typing detail, not a runtime one.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const view = new Uint8Array(digest);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

import { decompress as fzstdDecompress } from "fzstd";

// Model attachments are zstd frames. Prefer the browser's native DecompressionStream when it
// knows the format (feature-detected, since support arrived at different times per engine), and
// fall back to the pure-JS decoder otherwise. Both paths return the full buffer; the caller
// verifies the decompressed hash before anything is stored.
let nativeZstd: boolean | null = null;

function hasNativeZstd(): boolean {
  if (nativeZstd !== null) return nativeZstd;
  try {
    // The constructor throws a TypeError for unsupported formats.
    new DecompressionStream("zstd" as CompressionFormat);
    nativeZstd = true;
  } catch {
    nativeZstd = false;
  }
  return nativeZstd;
}

export async function decompressZstd(compressed: Uint8Array, expectedSize?: number): Promise<Uint8Array> {
  if (hasNativeZstd()) {
    try {
      const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(
        new DecompressionStream("zstd" as CompressionFormat)
      );
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      // A native decoder that exists but rejects the frame should not hide a real corruption
      // error behind a JS fallback, so only fall through when the format itself is refused.
      if (!(error instanceof TypeError)) throw error;
      nativeZstd = false;
    }
  }
  const out = expectedSize ? new Uint8Array(expectedSize) : undefined;
  return fzstdDecompress(compressed, out);
}

export function zstdBackend(): "native" | "fzstd" {
  return hasNativeZstd() ? "native" : "fzstd";
}

// Gzip has been in DecompressionStream everywhere since 2023; no fallback needed.
export async function decompressGzip(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type Compression = "zstd" | "gzip" | "none";

export function decompress(compressed: Uint8Array, compression: Compression, expectedSize?: number): Promise<Uint8Array> {
  switch (compression) {
    case "zstd":
      return decompressZstd(compressed, expectedSize);
    case "gzip":
      return decompressGzip(compressed);
    case "none":
      return Promise.resolve(compressed);
  }
}

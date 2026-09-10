import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { gzipSync } from "node:zlib";
import { decompress, decompressZstd, zstdBackend } from "../src/shared/compression.ts";

// Node's DecompressionStream does not know zstd, so this exercises the fzstd fallback, which is
// the path Chromium and Firefox take today as well.
test("decompressZstd round-trips a frame through the JS fallback", async () => {
  const original = new TextEncoder().encode("model bytes ".repeat(50_000));
  const compressed = new Uint8Array(zstdCompressSync(original));
  assert.ok(compressed.byteLength < original.byteLength / 10);
  const output = await decompressZstd(compressed, original.byteLength);
  assert.equal(output.byteLength, original.byteLength);
  assert.deepEqual(Buffer.from(output).subarray(0, 24), Buffer.from(original).subarray(0, 24));
  assert.equal(zstdBackend(), "fzstd");
});

test("decompressZstd rejects a corrupt frame instead of returning garbage", async () => {
  const compressed = new Uint8Array(zstdCompressSync(new TextEncoder().encode("x".repeat(10_000))));
  const middle = compressed.byteLength >> 1;
  compressed[middle] = (compressed[middle] ?? 0) ^ 0xff;
  compressed[compressed.byteLength - 4] = (compressed[compressed.byteLength - 4] ?? 0) ^ 0xff;
  await assert.rejects(decompressZstd(compressed));
});

test("decompress routes gzip through the native stream", async () => {
  const original = new TextEncoder().encode("vocab ".repeat(20_000));
  const compressed = new Uint8Array(gzipSync(original));
  const output = await decompress(compressed, "gzip");
  assert.equal(output.byteLength, original.byteLength);
  assert.equal(new TextDecoder().decode(output.subarray(0, 12)), "vocab vocab ");
});

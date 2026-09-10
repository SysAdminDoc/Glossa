// The ZIP writer both store artifacts go through. It is deliberately dull: stored order, a fixed
// timestamp and no extra fields, so the same source tree always produces the same bytes. A store
// reviewer rebuilding the package has to arrive at the same SHA-256, and a timestamp would make
// that impossible.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_ZIP_DATE = new Date(Date.UTC(2026, 0, 1));
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

// Every file under a directory, in one deterministic order.
export async function packDirectoryAsStoreZip(directory, outputPath) {
  const entries = [];
  for await (const filePath of walk(directory)) {
    const relative = path.relative(directory, filePath).split(path.sep).join("/");
    entries.push({ filename: relative, data: new Uint8Array(await readFile(filePath)) });
  }
  entries.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  await writeFile(outputPath, buildStoreZip(entries));
}

// An explicit list of {name, data} entries, for archives assembled rather than walked.
export async function packFilesAsStoreZip(entries, outputPath) {
  const members = entries.map((entry) => ({ filename: entry.name, data: new Uint8Array(entry.data) }));
  await writeFile(outputPath, buildStoreZip(members));
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoreZip(entries) {
  const encoder = new TextEncoder();
  const localBlocks = [];
  const centralBlocks = [];
  let offset = 0;
  const date = STORE_ZIP_DATE;
  const dosDate = ((Math.max(date.getUTCFullYear() - 1980, 0) & 0x7f) << 9) | (((date.getUTCMonth() + 1) & 0x0f) << 5) | (date.getUTCDate() & 0x1f);
  const dosTime = ((date.getUTCHours() & 0x1f) << 11) | ((date.getUTCMinutes() & 0x3f) << 5) | (Math.floor(date.getUTCSeconds() / 2) & 0x1f);

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30 + nameBytes.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    const localBytes = new Uint8Array(local.buffer);
    localBytes.set(nameBytes, 30);
    localBlocks.push(localBytes, entry.data);

    const central = new DataView(new ArrayBuffer(46 + nameBytes.length));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(central.buffer);
    centralBytes.set(nameBytes, 46);
    centralBlocks.push(centralBytes);

    offset += localBytes.length + entry.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const block of centralBlocks) centralSize += block.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  const output = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const block of [...localBlocks, ...centralBlocks, new Uint8Array(end.buffer)]) {
    output.set(block, cursor);
    cursor += block.length;
  }
  return output;
}

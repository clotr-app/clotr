// Tests extension/zip.js, Look Back's streaming zip and JSON reader.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deflateRawSync, crc32 } = require("node:zlib");

globalThis.Clotr = {};
require("../extension/zip.js");
const { fromBytes, openZip, entryBytes, jsonItems, jsonlItems, zipError } = globalThis.Clotr;
const { EXPORTS, zipOf } = require("./fixtures/exports/make-exports.js");

// ---------- A small, flexible zip builder for the synthetic cases make-exports.js can't make ----------
// Each file is { name, data: Buffer, method = 8, encrypted = false, zip64 = { size, csize, at } }. Setting
// zip64 forces those fields to the 0xFFFFFFFF sentinel in both headers and adds a ZIP64 extra field carrying
// the real values, so the ZIP64 decode path can be tried without building an actual multi-gigabyte file. The
// entryCount, cdOffset and cdSize options let a test deliberately lie about the end-of-central-directory
// record's own fields, after the real bytes are already built.
function buildZip(files, { entryCountOverride } = {}) {
  // A real zip can't claim more than 65,535 entries without a ZIP64 end record, since the plain field is only
  // 16 bits. So an override past that is written as a ZIP64 end record plus a locator, exactly like a
  // genuinely huge archive would be.
  if (entryCountOverride !== undefined && entryCountOverride > 0xffff) {
    const plain = buildZip(files, {});
    const dirLen = (() => {
      const v = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
      const eocd = plain.length - 22;
      return { size: v.getUint32(eocd + 12, true), offset: v.getUint32(eocd + 16, true) };
    })();
    const body = plain.subarray(0, plain.length - 22);
    const z64Abs = body.length;
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeBigUInt64LE(BigInt(entryCountOverride), 24);
    z64.writeBigUInt64LE(BigInt(entryCountOverride), 32);
    z64.writeBigUInt64LE(BigInt(dirLen.size), 40);
    z64.writeBigUInt64LE(BigInt(dirLen.offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(z64Abs), 8);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
    return Buffer.concat([body, z64, locator, end]);
  }
  return buildZipPlain(files, { entryCountOverride });
}
function buildZipPlain(files, { entryCountOverride } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = f.data;
    const method = f.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data, { level: 9 }) : data;
    const nameBytes = Buffer.from(f.name, "utf8");
    const crc = crc32(data) >>> 0;
    const flags = 0x0800 | (f.encrypted ? 0x0001 : 0);
    const z64 = f.zip64 || {};
    const extra = [];
    if (z64.size !== undefined || z64.csize !== undefined || z64.at !== undefined) {
      const fields = [];
      if (z64.size !== undefined) fields.push(["size", z64.size]);
      if (z64.csize !== undefined) fields.push(["csize", z64.csize]);
      if (z64.at !== undefined) fields.push(["at", z64.at]);
      const body = Buffer.alloc(8 * fields.length);
      fields.forEach(([, v], i) => body.writeBigUInt64LE(BigInt(v), i * 8));
      const header = Buffer.alloc(4);
      header.writeUInt16LE(0x0001, 0);
      header.writeUInt16LE(body.length, 2);
      extra.push(header, body);
    }
    const extraBuf = Buffer.concat(extra);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(z64.csize !== undefined ? 0xffffffff : packed.length, 18);
    local.writeUInt32LE(z64.size !== undefined ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(z64.csize !== undefined ? 0xffffffff : packed.length, 20);
    entry.writeUInt32LE(z64.size !== undefined ? 0xffffffff : data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(extraBuf.length, 30);
    entry.writeUInt32LE(z64.at !== undefined ? 0xffffffff : offset, 42);
    central.push(entry, nameBytes, extraBuf);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = entryCountOverride ?? files.length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

async function readAll(source, entry, opts) {
  return Buffer.from(await entryBytes(source, entry, opts));
}

// ---------- Every fixture zip, read back to its folder's exact bytes ----------

test("every fixture zip reads back to its folder's exact bytes", async () => {
  for (const name of Object.keys(EXPORTS)) {
    const source = fromBytes(zipOf(name));
    const { entries } = await openZip(source);
    assert.deepEqual(entries.map((e) => e.name).sort(), Object.keys(EXPORTS[name]).sort(), name);
    for (const entry of entries) {
      const want = EXPORTS[name][entry.name];
      const wantBytes = Buffer.isBuffer(want) ? want : Buffer.from(want, "utf8");
      const got = await readAll(source, entry);
      assert.deepEqual(got, wantBytes, `${name}:${entry.name}`);
    }
  }
});

// ---------- Synthetic zip shapes ----------

test("a stored (uncompressed) entry reads back exactly", async () => {
  const data = Buffer.from("plain stored bytes, no deflate", "utf8");
  const source = fromBytes(buildZip([{ name: "stored.txt", data, method: 0 }]));
  const { entries } = await openZip(source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 0);
  assert.deepEqual(await readAll(source, entries[0]), data);
});

test("ZIP64 central-directory fields (size, csize, offset) are read, not the 32-bit sentinels", async () => {
  const data = Buffer.from(JSON.stringify({ hello: "world, in a zip64 entry" }), "utf8");
  const packed = deflateRawSync(data, { level: 9 });
  const built = buildZip([
    { name: "big.json", data, method: 8, zip64: { size: data.length, csize: packed.length, at: 0 } },
  ]);
  const source = fromBytes(built);
  const { entries } = await openZip(source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].size, data.length);
  assert.equal(entries[0].csize, packed.length);
  assert.deepEqual(await readAll(source, entries[0]), data);
});

test("a data descriptor zip's sizes come from the central directory, never the local header's zeros", async () => {
  // make-exports.js's "chatgpt" fixture is written with bit 3 set, meaning sizes follow the data. The
  // fixture-roundtrip test above already covers it, and only passes if entry sizes are read from the central directory.
  const source = fromBytes(zipOf("chatgpt"));
  const { entries } = await openZip(source);
  const conv = entries.find((e) => e.name === "conversations.json");
  assert.ok(conv.size > 0 && conv.csize > 0);
  const got = await readAll(source, conv);
  assert.deepEqual(got, Buffer.from(EXPORTS.chatgpt["conversations.json"], "utf8"));
});

test("a truncated file (no end of central directory) is refused, not guessed at", async () => {
  const whole = buildZip([{ name: "a.txt", data: Buffer.from("hello"), method: 0 }]);
  const cut = whole.subarray(0, whole.length - 10);
  const source = fromBytes(cut);
  await assert.rejects(
    () => openZip(source),
    (err) => {
      assert.ok(err.code, "expected a typed ZipError");
      return true;
    },
  );
});

test("an encrypted entry can't be read", async () => {
  const data = Buffer.from("secret stuff");
  const source = fromBytes(buildZip([{ name: "locked.txt", data, method: 0, encrypted: true }]));
  const { entries } = await openZip(source);
  assert.equal(entries[0].encrypted, true);
  await assert.rejects(
    () => readAll(source, entries[0]),
    (err) => {
      assert.equal(err.code, "cant-read");
      return true;
    },
  );
});

test("a ../ entry name is just a label, never used as a path", async () => {
  const data = Buffer.from("not actually escaping anywhere");
  const source = fromBytes(buildZip([{ name: "../../etc/secret.txt", data, method: 0 }]));
  const { entries } = await openZip(source);
  assert.equal(entries[0].name, "../../etc/secret.txt");
  assert.deepEqual(await readAll(source, entries[0]), data);
});

test("more than 200,000 entries is refused before reading any of them", async () => {
  const data = Buffer.from("x");
  const built = buildZip([{ name: "one.txt", data, method: 0 }], { entryCountOverride: 200001 });
  const source = fromBytes(built);
  await assert.rejects(
    () => openZip(source),
    (err) => {
      assert.equal(err.code, "too-many-entries");
      return true;
    },
  );
});

test("a zip bomb trips the unpack-limit before the whole thing is inflated", async () => {
  const data = Buffer.alloc(200000, 0x20); // compresses tiny, decompresses far past a shrunk test cap
  const source = fromBytes(buildZip([{ name: "bomb.bin", data, method: 8 }]));
  const { entries } = await openZip(source);
  await assert.rejects(
    () => readAll(source, entries[0], { ratio: 2, extra: 100 }),
    (err) => {
      assert.equal(err.code, "unpack-limit");
      return true;
    },
  );
});

test("a small file under the shrunk test cap still reads fine (the cap doesn't fire on ordinary files)", async () => {
  const data = Buffer.from("short");
  const source = fromBytes(buildZip([{ name: "small.txt", data, method: 0 }]));
  const { entries } = await openZip(source);
  assert.deepEqual(await readAll(source, entries[0], { ratio: 2, extra: 100 }), data);
});

// ---------- jsonItems(): a streaming top-level-array scanner ----------

async function* iterChunks(str, size) {
  for (let i = 0; i < str.length; i += size) yield str.slice(i, i + size);
}

// Runs `text` through jsonItems both as one chunk and split one character at a time, since a streaming scanner
// must give the same answer regardless of where the chunk boundaries fall.
async function scanBothWays(text, opts) {
  const whole = [];
  for await (const item of jsonItems(iterChunks(text, text.length || 1), opts)) whole.push(item);
  const byChar = [];
  for await (const item of jsonItems(iterChunks(text, 1), opts)) byChar.push(item);
  assert.deepEqual(byChar, whole, "chunking should not change the result");
  return whole;
}

test("a plain top-level array yields each item's raw text", async () => {
  const items = await scanBothWays('[{"a":1},{"b":2}]');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '{"b":2}' }]);
});

test("an object wrapper with a top-level conversations array is found", async () => {
  const items = await scanBothWays('{"id":"x","conversations":[{"a":1}],"after":"y"}');
  assert.deepEqual(items, [{ text: '{"a":1}' }]);
});

test("a conversations key nested deeper than the top level is not mistaken for the array", async () => {
  const items = await scanBothWays('{"outer":{"conversations":[1,2]}}');
  assert.deepEqual(items, []);
});

test("brackets and escaped quotes inside a string don't confuse the item boundary", async () => {
  const items = await scanBothWays('[{"t":"a[b]{c}\\"d\\""}]');
  assert.deepEqual(items, [{ text: '{"t":"a[b]{c}\\"d\\""}' }]);
});

test("scalar array items (bare strings) are captured too", async () => {
  const items = await scanBothWays('[{"a":1}, "ok", 42]');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '"ok"' }, { text: "42" }]);
});

test("an item at or over the cap is still counted, as a truncated prefix", async () => {
  const items = await scanBothWays('[{"long":"xxxxxxxxxxxxxxxxxxxx"}]', { cap: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].text, null);
  assert.equal(items[0].tooBig, true);
  assert.equal(items[0].prefix.length, 10);
  assert.equal(items[0].prefix, '{"long":"x');
});

test("an item over the cap doesn't stop the next (shorter) item from being read in full", async () => {
  const items = await scanBothWays('[{"long":"xxxxxxxxxxxxxxxxxxxx"}, "ok"]', { cap: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0].tooBig, true);
  assert.deepEqual(items[1], { text: '"ok"' });
});

test("a malformed item is still returned as raw text, never dropped or thrown", async () => {
  const items = await scanBothWays('[{not valid json}, {"fine":1}]');
  assert.deepEqual(items, [{ text: "{not valid json}" }, { text: '{"fine":1}' }]);
});

test("reading stops once the target array closes, ignoring anything after it", async () => {
  const items = await scanBothWays('[{"a":1}] trailing garbage not even json {{{');
  assert.deepEqual(items, [{ text: '{"a":1}' }]);
});

test("a top-level value that is neither an array nor an object yields nothing", async () => {
  const items = await scanBothWays('"just a string"');
  assert.deepEqual(items, []);
});

test("a top-level object with no conversations array yields nothing", async () => {
  const items = await scanBothWays('{"a":1,"b":2}');
  assert.deepEqual(items, []);
});

test("whitespace between items is never captured as part of an item", async () => {
  const items = await scanBothWays('[\n  {"a":1},\n  {"b":2}\n]');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '{"b":2}' }]);
});

test("whitespace inside a scalar string item is kept, not mistaken for an item separator", async () => {
  const items = await scanBothWays('[" has  spaces ", {"a":1}]');
  assert.deepEqual(items, [{ text: '" has  spaces "' }, { text: '{"a":1}' }]);
});

test("an empty array yields nothing", async () => {
  const items = await scanBothWays("[]");
  assert.deepEqual(items, []);
});

// ---------- jsonlItems(): one JSON record per line (Claude's October 2026 export) ----------

// Same chunk-boundary-independence check as scanBothWays(), for jsonlItems().
async function scanLinesBothWays(text, opts) {
  const whole = [];
  for await (const item of jsonlItems(iterChunks(text, text.length || 1), opts)) whole.push(item);
  const byChar = [];
  for await (const item of jsonlItems(iterChunks(text, 1), opts)) byChar.push(item);
  assert.deepEqual(byChar, whole, "chunking should not change the result");
  return whole;
}

test("one JSON document per line yields each line's raw text", async () => {
  const items = await scanLinesBothWays('{"a":1}\n{"b":2}\n');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '{"b":2}' }]);
});

test("a trailing line with no final newline is still read", async () => {
  const items = await scanLinesBothWays('{"a":1}\n{"b":2}');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '{"b":2}' }]);
});

test("CRLF line endings don't leave a trailing carriage return in the text", async () => {
  const items = await scanLinesBothWays('{"a":1}\r\n{"b":2}\r\n');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '{"b":2}' }]);
});

test("blank lines are skipped, never returned as empty items", async () => {
  const items = await scanLinesBothWays('{"a":1}\n\n\n{"b":2}\n');
  assert.deepEqual(items, [{ text: '{"a":1}' }, { text: '{"b":2}' }]);
});

test("a line at or over the cap is still counted, as a truncated prefix", async () => {
  const items = await scanLinesBothWays('{"long":"xxxxxxxxxxxxxxxxxxxx"}\n', { cap: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].text, null);
  assert.equal(items[0].tooBig, true);
  assert.equal(items[0].prefix.length, 10);
  assert.equal(items[0].prefix, '{"long":"x');
});

test("a line over the cap doesn't stop the next (shorter) line from being read in full", async () => {
  const items = await scanLinesBothWays('{"long":"xxxxxxxxxxxxxxxxxxxx"}\n{"ok":1}\n', { cap: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0].tooBig, true);
  assert.deepEqual(items[1], { text: '{"ok":1}' });
});

test("an empty input yields nothing", async () => {
  const items = await scanLinesBothWays("");
  assert.deepEqual(items, []);
});

test("zipError() makes a typed, catchable error", () => {
  const e = zipError("cant-read", "nope");
  assert.equal(e.code, "cant-read");
  assert.equal(e.message, "nope");
  assert.ok(e instanceof Error);
});

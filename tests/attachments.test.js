// Covers how extension/attachments.js reads attached files as text. Node already has File and
// DecompressionStream built in, and what the browser shows when someone attaches a file lives in the e2e suite.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { crc32 } = require("../tools/package.js");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/attachments.js");
const { readAttachment } = globalThis.Clotr;
const { retrySlowAsync, timedAsync } = require("./timing.js");

// Builds a minimal zip file from a list of [name, text, deflate?] entries.
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text, "utf8");
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}

const docXml = (text) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

test("Word documents: text read from stored and compressed parts; other parts ignored", async () => {
  const stored = new File(
    [
      zip([
        ["word/document.xml", docXml("call 555-555-0123"), false],
        ["docProps/app.xml", "<x>ignore me 555-0199</x>", false],
      ]),
    ],
    "a.docx",
  );
  const text = await readAttachment(stored);
  assert.match(text, /555-555-0123/);
  assert.doesNotMatch(text, /555-0199/);
  const packed = new File([zip([["word/document.xml", docXml("my key AKIA4HPQ7XZ2R6TWLJ3N"), true]])], "b.docx");
  assert.match(await readAttachment(packed), /AKIA4HPQ7XZ2R6TWLJ3N/);
});

test("text files are read; unknown kinds and broken files give null (fail open)", async () => {
  assert.equal(await readAttachment(new File(["email me: a@b.co"], "notes.txt")), "email me: a@b.co");
  assert.equal(await readAttachment(new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" })), null);
  assert.equal(await readAttachment(new File(["not a zip"], "broken.docx")), null);
  assert.equal(await readAttachment(new File(["%not a pdf"], "x.pdf")), null);
});

// Firefox hands a content script the page's own bytes, and the script can't slice them up as they are, so
// ownBytes copies them into the script's own realm first. In Chrome, Brave, Edge and Node the bytes are already
// its own, so they pass through untouched.
test("ownBytes: bytes from another realm are copied into this one; this realm's pass through", () => {
  const { ownBytes } = globalThis.Clotr;
  const mine = new Uint8Array([1, 2, 3]);
  assert.equal(ownBytes(mine), mine);
  assert.equal(ownBytes(mine.buffer), mine.buffer);
  const theirs = require("node:vm").runInNewContext("new Uint8Array([7, 8, 9])");
  assert.ok(!(theirs instanceof Uint8Array) && !(theirs.buffer instanceof ArrayBuffer));
  const bytes = ownBytes(theirs);
  const buffer = ownBytes(theirs.buffer);
  assert.ok(bytes instanceof Uint8Array && buffer instanceof ArrayBuffer);
  assert.deepEqual([...bytes], [7, 8, 9]);
  assert.deepEqual([...new Uint8Array(buffer)], [7, 8, 9]);
});

test("zip bomb: a part that inflates far past the cap stops at 2 MB", async () => {
  const bomb = new File(
    [zip([["word/document.xml", `<w:t>${"A".repeat(30 * 1024 * 1024)}</w:t>`, true]])],
    "bomb.docx",
  );
  const text = await readAttachment(bomb);
  assert.ok(text.length <= 2 * 1024 * 1024 + 1, `read ${text.length} characters`);
  // Five seconds on a quiet computer, more on a busy one, scaled by how much slower this computer is right
  // now than the reference timing in tests/timing.js.
  await retrySlowAsync(async () => {
    const t = await timedAsync(() => readAttachment(bomb));
    if (await t.overAsync(5000))
      return `took ${Math.round(t.wall)} ms (${Math.round(t.allowed)} allowed on this computer now)`;
  });
});

// An SVG file is text underneath. The words it displays get read like any text file, but the numbers in its
// drawing instructions don't, so a path coordinate can't be mistaken for a phone number.
test("SVG pictures are read as text: the words they show, not their drawing numbers", async () => {
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="80">
    <path d="M 555 555 0123 L 212 555 0199 Z" fill="#555"/>
    <text x="10" y="40">Write to ann.lee@gmail.com</text></svg>`;
  for (const file of [
    new File([svg], "chart.svg"),
    new File([svg], "chart", { type: "image/svg+xml" }),
    new File([svg], "CHART.SVG", { type: "" }),
  ]) {
    const text = await readAttachment(file);
    assert.match(text || "", /ann\.lee@gmail\.com/, file.name);
    assert.doesNotMatch(text, /0123|0199/, `${file.name}: drawing numbers read as text`);
  }
  assert.equal(await readAttachment(new File([svg.repeat(30000)], "huge.svg")), null, "over the 2 MB text cap");
});

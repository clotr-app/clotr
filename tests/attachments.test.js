// Covers how extension/attachments.js reads attached files as text. Node already has File and
// DecompressionStream built in, and what the browser shows when someone attaches a file lives in the e2e suite.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { crc32 } = require("../tools/package.js");
const { bestOfAsyncPair, bestOfPair, grewMoreThan } = require("./timing.js");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/attachments.js");
const { readAttachment } = globalThis.Clotr;

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

test("zip bomb: output stays capped, and below-cap reads grow with their size", async () => {
  const makePart = (length) =>
    new File([zip([["word/document.xml", `<w:t>${"A".repeat(length)}</w:t>`, true]])], "bomb.docx");
  const small = makePart(256 * 1024);
  const big = makePart(1024 * 1024);
  const smallText = await readAttachment(small);
  const bigText = await readAttachment(big);
  assert.ok(smallText.length >= 256 * 1024 && smallText.length <= 256 * 1024 + 1);
  assert.ok(bigText.length >= 1024 * 1024 && bigText.length <= 1024 * 1024 + 1);
  const [smallTime, bigTime] = await bestOfAsyncPair(
    () => readAttachment(small),
    () => readAttachment(big),
    4,
  );
  assert.ok(!grewMoreThan(smallTime, bigTime, 16), "reading 4× as much decompressed text grew too much");

  const bomb = new File(
    [zip([["word/document.xml", `<w:t>${"A".repeat(30 * 1024 * 1024)}</w:t>`, true]])],
    "bomb.docx",
  );
  const text = await readAttachment(bomb);
  assert.ok(text.length <= 2 * 1024 * 1024 + 1, `read ${text.length} characters`);
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

// Builds a minimal PDF from [object number, dictionary, stream bytes or null, plain body or null] entries.
function pdf(objects) {
  let out = "%PDF-1.4\n";
  for (const [n, dict, data, body] of objects) {
    out += `${n} 0 obj\n${dict === null ? "" : `<< ${dict} >>\n`}`;
    if (data) out += `stream\n${data.toString("latin1")}\nendstream\n`;
    if (body !== undefined && body !== null) out += `${body}\n`;
    out += "endobj\n";
  }
  return new File([Buffer.from(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1")], "a.pdf", {
    type: "application/pdf",
  });
}
const pageStream = (s) => zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${s}) Tj ET`));
const SSN_PAGE = "My SSN is 078-05-1120";

// LibreOffice and many other writers give a stream's length as another object ("/Length 12 0 R"). Reading the
// object number's first digits as the length cut the stream to a byte or two, and the page came back empty.
test("PDF: a stream whose /Length names another object is still read, whatever that object's number", async () => {
  const data = pageStream(SSN_PAGE);
  for (const n of [7, 12, 345]) {
    const withObject = pdf([
      [1, "/Type /Catalog", null],
      [5, `/Length ${n} 0 R /Filter /FlateDecode`, data],
      [n, null, null, String(data.length)],
    ]);
    assert.match(await readAttachment(withObject), /078-05-1120/, `/Length ${n} 0 R`);
    const withoutObject = pdf([
      [1, "/Type /Catalog", null],
      [5, `/Length ${n} 0 R /Filter /FlateDecode`, data],
    ]);
    assert.match(await readAttachment(withoutObject), /078-05-1120/, `/Length ${n} 0 R, no such object`);
  }
  // Every page of a longer document, each with its length kept in its own object.
  const pages = Array.from({ length: 70 }, (_, i) => pageStream(i === 69 ? SSN_PAGE : `Page ${i}`));
  const long = pdf([
    [1, "/Type /Catalog", null],
    ...pages.flatMap((p, i) => [
      [10 + 2 * i, `/Length ${11 + 2 * i} 0 R /Filter /FlateDecode`, p],
      [11 + 2 * i, null, null, String(p.length)],
    ]),
  ]);
  assert.match(await readAttachment(long), /078-05-1120/, "the 70th page");
});

// Excel writes each sheet before xl/sharedStrings.xml, where every text cell lives. A sheet's markup (row and
// cell tags around numbers and string indices) passed the 2 MB budget long before its text did, and the shared
// strings, names and SSNs and all, were never read.
test("big spreadsheets: the shared strings are read even when a sheet's markup alone passes 2 MB", async () => {
  const rows = Array.from(
    { length: 40000 },
    (_, i) =>
      `<row r="${i + 1}" spans="1:3" x14ac:dyDescent="0.25"><c r="A${i + 1}" s="1" t="s"><v>${i % 2}</v></c>` +
      `<c r="B${i + 1}" s="2"><v>${1000 + i}</v></c></row>`,
  ).join("");
  const sheet = `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  assert.ok(sheet.length > 3 * 1024 * 1024, `${sheet.length} characters of sheet markup`);
  const strings = '<sst count="2"><si><t>Employee</t></si><si><t>SSN 078-05-1120</t></si></sst>';
  const book = new File(
    [
      zip([
        ["[Content_Types].xml", "<Types/>", true],
        ["xl/workbook.xml", "<workbook/>", true],
        ["xl/worksheets/sheet1.xml", sheet, true],
        ["xl/sharedStrings.xml", strings, true],
      ]),
    ],
    "staff.xlsx",
  );
  const text = await readAttachment(book);
  assert.match(text, /078-05-1120/);
  // A Word file's own formatting tags count for nothing either: only the words they wrap do.
  const styled = (words) =>
    `<w:r><w:rPr>${'<w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/>'.repeat(8)}</w:rPr><w:t>${words}</w:t></w:r>`;
  const body = Array.from({ length: 6000 }, (_, i) => styled(`Line ${i}`)).join("") + styled("SSN 078-05-1120");
  const doc = new File(
    [zip([["word/document.xml", `<w:document><w:body><w:p>${body}</w:p></w:body></w:document>`, true]])],
    "long.docx",
  );
  assert.match(await readAttachment(doc), /078-05-1120/);
});

// A simple font's ToUnicode map has one-byte codes (<20> to <7E>), and a hex string in its text is read a byte
// at a time. Stepping four hex digits for every code, as for a two-byte font, dropped every second letter.
test("PDF page text: a one-byte ToUnicode map reads every character of a hex string", () => {
  const { pdfPageText, detect } = globalThis.Clotr;
  const ssn = "<53534E3A203037382D30352D31313230>"; // "SSN: 078-05-1120"
  const range =
    "begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0020> endbfrange endcmap";
  const text = pdfPageText([range, `BT /F1 12 Tf ${ssn} Tj ET`]);
  assert.match(text, /SSN: 078-05-1120/);
  assert.ok(detect(text).some((r) => r.id === "us_ssn"));
  const chars = "begincmap 2 beginbfchar <41> <0041> <42> <0042> endbfchar endcmap";
  assert.match(pdfPageText([chars, "BT <414243> Tj ET"]), /AB/);
  // Two-byte codes still read four hex digits at a time.
  const wide = "begincmap 1 beginbfrange <0001> <0050> <0041> endbfrange endcmap";
  assert.match(pdfPageText([wide, "BT <000100020003> Tj ET"]), /ABC/);
});

// Embedded font programs and colour profiles are streams too, often written before the pages. Unpacking them
// spent the 2 MB budget on binary data (and fed it to the text reader), and pictures used up the 400-stream cap,
// so a later page with real text was never read.
test("PDF: fonts, colour profiles and pictures don't use up the budget the page text needs", async () => {
  const crypto = require("node:crypto");
  const page = pageStream(SSN_PAGE);
  const font = zlib.deflateSync(Buffer.concat([crypto.randomBytes(400 * 1024), Buffer.from("Tj".repeat(2000))]));
  const bigFont = zlib.deflateSync(Buffer.alloc(900 * 1024, 7));
  const fonts = pdf([
    [1, "/Type /Catalog", null],
    [2, `/Length ${font.length} /Length1 ${400 * 1024 + 4000} /Filter /FlateDecode`, font],
    ...[3, 4, 5].map((n) => [n, `/Length ${bigFont.length} /Length1 ${900 * 1024} /Filter /FlateDecode`, bigFont]),
    [6, `/N 3 /Alternate /DeviceRGB /Length ${bigFont.length} /Filter /FlateDecode`, bigFont],
    [7, `/Length ${page.length} /Filter /FlateDecode`, page],
  ]);
  const text = await readAttachment(fonts);
  assert.match(text, /078-05-1120/);
  assert.ok(text.length < 1000, `${text.length} characters read from a one-line page`);
  const picture = Buffer.from("not really a jpeg");
  const pictures = pdf([
    [1, "/Type /Catalog", null],
    ...Array.from({ length: 450 }, (_, i) => [
      10 + i,
      `/Type /XObject /Subtype /Image /Filter /DCTDecode /Length ${picture.length}`,
      picture,
    ]),
    [9, `/Length ${page.length} /Filter /FlateDecode`, page],
  ]);
  assert.match(await readAttachment(pictures), /078-05-1120/);
});

// A soft line break, tab or space in Office XML is a tag of its own. Dropping it with no separator glued the
// words on either side together, and "Card" plus a card number on the next line read as one token.
test("Office XML to text: soft line breaks, tabs and spaces keep the words apart", () => {
  const { xmlToText, detect } = globalThis.Clotr;
  const card = "4111 1111 1111 1111";
  const ids = (xml) => detect(xmlToText(xml)).map((r) => r.id);
  for (const gap of [
    "<a:br/>",
    '<a:br><a:rPr lang="en-US"/></a:br>',
    "<w:cr/>",
    '<w:br w:type="textWrapping"/>',
    "<text:tab/>",
    "<text:line-break/>",
    "<text:s/>",
    '<text:s text:c="2"/>',
  ]) {
    const xml = `<a:p><a:r><a:t>Card</a:t></a:r>${gap}<a:r><a:t>${card}</a:t></a:r></a:p>`;
    assert.match(xmlToText(xml), /Card\s+4111/, gap);
    assert.ok(ids(xml).includes("credit_card"), gap);
  }
  assert.match(
    xmlToText("<a:p><a:r><a:t>Call Ann</a:t></a:r><a:br/><a:r><a:t>555-555-5636</a:t></a:r></a:p>"),
    /Call Ann\s+555-555-5636/,
  );
});

// A PDF literal string may hold balanced parentheses without escaping them. Ending the string at the first ")"
// lost everything after a parenthetical: "(Employee (contractor) SSN …)" read as "Employee (contractor".
test("PDF page text: balanced parentheses inside a literal string keep the rest of the string", () => {
  const { pdfPageText, detect } = globalThis.Clotr;
  const text = pdfPageText(["BT /F1 12 Tf (Employee (contractor) SSN 078-05-1120) Tj ET"]);
  assert.match(text, /Employee \(contractor\) SSN 078-05-1120/);
  assert.ok(detect(text).some((r) => r.id === "us_ssn"));
  assert.match(pdfPageText(["BT ((a (b)) c) Tj (next) Tj ET"]), /\(a \(b\)\) c\s*next/);
  // An escaped parenthesis doesn't count toward the nesting.
  assert.match(pdfPageText([String.raw`BT (one \( two) Tj (three) Tj ET`]), /one \( two\s*three/);
  // An inner "(" that never closes: the string still ends at the first ")", as before.
  assert.match(pdfPageText(["BT (a ( b) Tj (c) Tj ET"]), /a \( b\s*c/);
  // Hostile strings: every inner "(" left open, or nested ever deeper, still costs one pass.
  for (const unit of ["(()", "(()(", "((", "(a)"]) {
    const page = (k) => `BT ${unit.repeat(k)} Tj ET`;
    const [small, big] = bestOfPair(
      () => pdfPageText([page(20000)]),
      () => pdfPageText([page(80000)]),
      4,
      3,
    );
    assert.ok(!grewMoreThan(small, big, 16), `${unit}: time grew too much for 4× the input`);
    // Rescanning a 4,096-character window for every few characters grows linearly too, just a thousand times
    // slower, so the bigger page also has a generous time limit.
    assert.ok(big.wall < 2000, `${unit}: ${big.wall.toFixed(0)} ms for 80,000 copies`);
  }
});

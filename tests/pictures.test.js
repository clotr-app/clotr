// Tests extension/pictures.js, which handles attached pictures. Node has File built in, so these run directly.
// Clotr never reads the words in a picture: it only checks a picture's hidden location (EXIF GPS) and its
// name. What Clotr does with that inside a real page is covered by the e2e suite instead. Every picture here
// is built byte by byte by tools/make-picture-fixtures.js, using public landmarks, never a real photo.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/attachments.js"); // provides ownBytes, and loads before pictures.js just like in the real page
require("../extension/pictures.js");
const { isPicture } = globalThis.Clotr;
const fx = require("../tools/make-picture-fixtures.js");
const { retrySlow, retrySlowAsync, bestOfBoth, timedAsync } = require("./timing.js");

test("isPicture: by type or by name; an SVG is text, not a picture", () => {
  const file = (name, type = "") => new File([new Uint8Array([1, 2, 3])], name, { type });
  for (const f of [
    file("IMG_2041.jpg", "image/jpeg"),
    file("Screenshot 2026-10-02 at 09.14.png", "image/png"),
    file("photo.HEIC"), // Windows often gives no type for HEIC
    file("scan.tiff"),
    file("chart.webp"),
    file("frame.avif"),
    file("x.bmp"),
    file("anim.gif"),
    file("pasted", "image/png"), // a pasted screenshot can come without a name's ending
    file("photo.heif", "image/heif"),
  ])
    assert.equal(isPicture(f), true, `${f.name} (${f.type})`);
  for (const f of [
    file("chart.svg", "image/svg+xml"),
    file("chart.svg"),
    file("logo", "image/svg+xml"),
    file("notes.txt", "text/plain"),
    file("report.pdf", "application/pdf"),
    file("photo.jpg.zip", "application/zip"),
    file("budget.xlsx"),
  ])
    assert.equal(isPicture(f), false, `${f.name} (${f.type})`);
  for (const odd of [null, undefined, {}, { name: 5, type: null }]) assert.equal(isPicture(odd), false);
});

// ---------- A photo's hidden location: the place a camera saved inside the file (EXIF GPS) ----------

// Some kinds only ever come from a picture, and appear in settings, presets and the report, but should never
// match plain text: not in any message from the everyday corpora, and not even in a message that holds
// coordinates or a file name.
test("picture-only kinds never match any text", () => {
  require("../extension/detector.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const { PATTERNS, detect } = globalThis.Clotr;
  const only = new Set(PATTERNS.filter((p) => p.picture).map((p) => p.id));
  assert.ok(only.has("photo_location") && only.has("id_picture"), [...only].join());
  const messages = ["normal-messages.txt", "normal-messages-es.txt"].flatMap((f) =>
    fs
      .readFileSync(path.join(__dirname, "corpus", f), "utf8")
      .split(/\r?\n---\r?\n/)
      .slice(1),
  );
  messages.push("We met at 40.689,-74.045 by the statue", "GPS 40°41'21\"N 74°2'40\"W, file passport-scan.jpg");
  const hits = messages.filter((m) => detect(m).some((r) => only.has(r.id)));
  assert.deepEqual(hits, []);
});

const { liberty, opera } = fx.PLACES;
const bytes = (b) => new Uint8Array(b);
const near = (got, want) => Boolean(got) && Math.abs(got.lat - want.lat) < 1e-4 && Math.abs(got.lon - want.lon) < 1e-4;

test("gpsFrom: the place a camera saved, in every format people attach", () => {
  const { gpsFrom } = globalThis.Clotr;
  const cases = [
    ["JPEG", fx.jpegWithGps(liberty), liberty],
    ["JPEG, big-endian", fx.jpegWithGps({ ...opera, bigEndian: true }), opera],
    ["JPEG, decimal minutes", fx.jpegWithGps({ ...liberty, parts: 2 }), liberty],
    ["JPEG, decimal degrees", fx.jpegWithGps({ ...opera, parts: 1 }), opera],
    ["JPEG, signed degrees, no N/S or E/W", fx.jpegWithGps({ ...opera, signed: true, refs: false }), opera],
    ["PNG (eXIf)", fx.pngWithGps(opera), opera],
    ["WebP (EXIF)", fx.webpWithGps(liberty), liberty],
    ["HEIC", fx.heifWithGps({ tiff: fx.tiffGps(opera) }), opera],
    ["HEIC, item list version 1", fx.heifWithGps({ ilocVersion: 1 }), liberty],
    [
      "HEIC, version 2, 8-byte offsets and a base",
      fx.heifWithGps({ ilocVersion: 2, offsetSize: 8, baseOffset: true }),
      liberty,
    ],
    ["HEIC, the item kept in the meta box (idat)", fx.heifWithGps({ ilocVersion: 1, method: 1 }), liberty],
    [
      "HEIF, big-endian EXIF",
      fx.heifWithGps({ brand: "mif1", tiff: fx.tiffGps({ ...opera, bigEndian: true }) }),
      opera,
    ],
    ["AVIF", fx.heifWithGps({ brand: "avif", tiff: fx.tiffGps(opera) }), opera],
    ["TIFF", fx.tiffGps(opera), opera],
    ["XMP text in a JPEG", fx.jpegWithXmp(), liberty],
    ["XMP text, south and east", fx.jpegWithXmp("33,51,24.42S", "151,12,55.07E"), opera],
  ];
  for (const [what, b, want] of cases)
    assert.ok(near(gpsFrom(bytes(b)), want), `${what}: ${JSON.stringify(gpsFrom(bytes(b)))}`);
});

test("gpsFrom: no place when there is none, at 0,0, out of range, or in a damaged or hostile file", () => {
  const { gpsFrom } = globalThis.Clotr;
  for (const [what, b] of [
    ["a JPEG without location", fx.BASE.jpeg],
    ["a PNG without location", fx.BASE.png],
    ["a WebP without location", fx.BASE.webp],
    ["a HEIC whose EXIF has no GPS", fx.heifWithGps({ tiff: fx.tiffGps({ gps: false }) })],
    ...Object.entries(fx.hostile()),
  ])
    assert.equal(gpsFrom(bytes(b)), null, what);
  for (const odd of [new Uint8Array(0), new Uint8Array([0xff, 0xd8]), null, undefined, "IMG_2041.jpg"])
    assert.equal(gpsFrom(odd), null);
});

test("2,000 damaged pictures never throw, never give a place out of range, and finish within two seconds", () => {
  const { gpsFrom } = globalThis.Clotr;
  let seed = 20261002;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const bases = [
    fx.jpegWithGps(),
    fx.pngWithGps(),
    fx.webpWithGps(),
    fx.heifWithGps(),
    fx.heifWithGps({ ilocVersion: 2, offsetSize: 8, baseOffset: true }),
    fx.heifWithGps({ ilocVersion: 1, method: 1 }),
    fx.tiffGps({ bigEndian: true }),
    fx.jpegWithXmp(),
  ].map(bytes);
  const damaged = [];
  for (let i = 0; i < 2000; i++) {
    const base = bases[i % bases.length];
    const m = base.slice(0, rand() < 0.3 ? Math.floor(rand() * base.length) : base.length);
    for (let k = 0, n = 1 + Math.floor(rand() * 8); k < n && m.length; k++)
      m[Math.floor(rand() * m.length)] = Math.floor(rand() * 256);
    damaged.push(m);
  }
  for (const m of damaged) {
    const got = gpsFrom(m);
    assert.ok(got === null || (Math.abs(got.lat) <= 90 && Math.abs(got.lon) <= 180), JSON.stringify(got));
  }
  // Two seconds is the budget on a quiet computer. A busy one gets more time, scaled by tests/timing.js's reference task.
  retrySlow(() => {
    const t = bestOfBoth(() => damaged.forEach((m) => gpsFrom(m)), 1);
    if (t.over(2000)) return `${Math.round(t.wall)} ms (${Math.round(t.allowed)} allowed on this computer now)`;
  });
});

// A File that records every part of it that is read.
function spyFile(b, name, type = "") {
  const real = new File([b], name, { type });
  const reads = [];
  const file = {
    name,
    type,
    size: real.size,
    slice: (a, z) => {
      reads.push([a, z]);
      return real.slice(a, z);
    },
  };
  return { file, reads };
}

test("readPicture: the place, rounded to 3 decimals (about 110 m), as the kind Photo Location", async () => {
  const { readPicture } = globalThis.Clotr;
  const at = async (b, name = "IMG_2041.jpg") => readPicture(new File([b], name, { type: "image/jpeg" }));
  const found = await at(fx.jpegWithGps(liberty));
  assert.deepEqual(
    found.map((r) => [r.id, r.name, r.group, r.severity, r.matches]),
    [["photo_location", "Photo Location", "personal", "medium", ["40.689,-74.045"]]],
  );
  assert.deepEqual((await at(fx.heifWithGps({ tiff: fx.tiffGps(opera) }), "IMG_0007.HEIC"))[0].matches, [
    "-33.857,151.215",
  ]);
  // Two photos taken a few meters apart at home round to the same value, so "the same item again" and
  // "fine to share" still work.
  const a = await at(fx.jpegWithGps({ lat: 40.68921, lon: -74.04462 }));
  const b = await at(fx.jpegWithGps({ lat: 40.68938, lon: -74.04471 }));
  assert.deepEqual(a[0].matches, b[0].matches);
  // A rounded value is never shown as "-0.000", and a reading of 0,0 counts as no place at all.
  assert.deepEqual((await at(fx.jpegWithGps({ lat: -0.0004, lon: 6.5 })))[0].matches, ["0.000,6.500"]);
  assert.deepEqual(await at(fx.jpegWithGps({ lat: 0, lon: 0 })), []);
  assert.deepEqual(await at(fx.BASE.jpeg), []);
});

test("readPicture reads the first 256 KB at most, plus a HEIC's location item (64 KB at most) wherever it is", async () => {
  const { readPicture } = globalThis.Clotr;
  const HEAD = 256 * 1024;
  // An iPhone-style HEIC with its location item 1 MB in is still found, with one read of the start and one small extra read.
  const heic = spyFile(fx.heifWithGps({ far: 1024 * 1024 }), "IMG_0001.HEIC");
  assert.deepEqual(
    (await readPicture(heic.file)).map((r) => r.id),
    ["photo_location"],
  );
  assert.equal(heic.reads.length, 2, JSON.stringify(heic.reads));
  assert.deepEqual(heic.reads[0], [0, HEAD]);
  assert.ok(heic.reads[1][0] > HEAD && heic.reads[1][1] - heic.reads[1][0] <= 64 * 1024, JSON.stringify(heic.reads));
  // A JPEG whose EXIF comes after 325 KB of other blocks sits past the first 256 KB Clotr reads, so it's missed
  // and gives no place.
  const filler = fx.segment(0xe2, Buffer.alloc(65000));
  const late = spyFile(fx.jpegWith(filler, filler, filler, filler, filler, fx.exifSegment(fx.tiffGps())), "late.jpg");
  assert.deepEqual(await readPicture(late.file), []);
  assert.deepEqual(late.reads, [[0, HEAD]]);
  // A 25 MB photo only needs one read of the start, and stays quick: 200 ms on a quiet computer, more on a busy one.
  const big = spyFile(fx.bigJpeg(25), "IMG_9999.jpg", "image/jpeg");
  assert.deepEqual(
    (await readPicture(big.file)).map((r) => r.id),
    ["photo_location"],
  );
  assert.deepEqual(big.reads, [[0, HEAD]]);
  await retrySlowAsync(async () => {
    const t = await timedAsync(() => readPicture(big.file));
    if (await t.overAsync(200))
      return `${Math.round(t.wall)} ms for 25 MB (${Math.round(t.allowed)} allowed on this computer now)`;
  });
});

test("readPicture: hostile and unreadable pictures give nothing, never throw, and never hold the chat", async () => {
  const { readPicture } = globalThis.Clotr;
  const hostile = Object.entries(fx.hostile()).map(([name, b]) => [name, new File([b], `IMG_${name}`)]);
  for (const [name, file] of hostile) assert.deepEqual(await readPicture(file), [], name);
  // Budgets half a second for all of them on a quiet computer, more on a busy one.
  await retrySlowAsync(async () => {
    const t = await timedAsync(async () => {
      for (const [, file] of hostile) await readPicture(file);
    });
    if (await t.overAsync(500))
      return `${Math.round(t.wall)} ms for every hostile picture (${Math.round(t.allowed)} allowed on this computer now)`;
  });
  // A file the browser can no longer read, because it was removed from disk after being chosen, gives nothing and no error.
  const gone = {
    name: "IMG_0001.jpg",
    type: "image/jpeg",
    size: 5000,
    slice: () => ({ arrayBuffer: () => Promise.reject(new Error("NotReadableError")) }),
  };
  assert.deepEqual(await readPicture(gone), []);
  for (const odd of [null, undefined, {}, { name: 5, size: "x" }]) assert.deepEqual(await readPicture(odd), []);
});

// ---------- File names that say "passport": a short list of clue words, read from the name's words ----------
function pictureNames() {
  const fs = require("node:fs");
  const path = require("node:path");
  const lines = fs.readFileSync(path.join(__dirname, "corpus", "picture-names.txt"), "utf8").split(/\r?\n/);
  const pick = (mark) => lines.filter((l) => l.startsWith(mark)).map((l) => l.slice(2).trim());
  return { warn: pick("+ "), quiet: pick("- ") };
}

test("the picture-names corpus: over 100 names, both ways, each one once", () => {
  const { warn, quiet } = pictureNames();
  assert.ok(warn.length >= 50 && quiet.length >= 50, `${warn.length} to warn, ${quiet.length} quiet`);
  const all = [...warn, ...quiet];
  assert.equal(new Set(all.map((n) => n.toLowerCase())).size, all.length, "a name is in the corpus twice");
});

// Perfection is the goal, but the test only asks for no worse than 1 wrong in 50, in either direction.
test("nameClues: the picture-names corpus is held to the floor, no worse than 1 in 50 either way", () => {
  const { nameClues } = globalThis.Clotr;
  const { warn, quiet } = pictureNames();
  const missed = warn.filter((n) => !nameClues(n).length);
  const wrong = quiet.filter((n) => nameClues(n).length);
  assert.ok(missed.length * 50 <= warn.length, `missed: ${missed.join(" | ")}`);
  assert.ok(wrong.length * 50 <= quiet.length, `wrong warnings: ${wrong.join(" | ")}`);
});

test("nameClues: words and pairs from the name; never 'id', 'card', 'visa' or 'statement' alone", () => {
  const { nameClues } = globalThis.Clotr;
  for (const n of [
    "id.jpg",
    "card.png",
    "visa.jpg",
    "statement.pdf",
    "my id.png",
    "license plate.jpg",
    "MIT license.png",
    "IMG_1099.jpg",
    "passportal.png",
    "",
  ])
    assert.deepEqual(nameClues(n), [], n);
  for (const n of [
    "passport.jpg",
    "DriversLicense_front.jpg", // camelCase
    "IDCard.png",
    "idcard.png", // joined
    "W-2 2025.pdf", // a form's number
    "1099-NEC.png",
    "Cédula.jpg", // accents dropped
    "PASSPORT.HEIC",
  ])
    assert.ok(nameClues(n).length, n);
  for (const odd of [null, undefined, 5, {}]) assert.deepEqual(nameClues(odd), []);
});

test("readPicture: a picture named like an ID or a document is an ID or Document Picture, its value the name", async () => {
  const { readPicture, PATTERNS } = globalThis.Clotr;
  assert.ok(PATTERNS.find((p) => p.id === "id_picture")?.picture, "id_picture is a picture-only kind");
  const named = await readPicture(new File([fx.BASE.jpeg], "Passport-Scan.JPG", { type: "image/jpeg" }));
  assert.deepEqual(
    named.map((r) => [r.id, r.name, r.group, r.severity, r.matches]),
    [["id_picture", "ID or Document Picture", "personal", "medium", ["passport-scan.jpg"]]],
  );
  const both = await readPicture(new File([fx.jpegWithGps()], "passport.jpg", { type: "image/jpeg" }));
  assert.deepEqual(
    both.map((r) => r.id),
    ["id_picture", "photo_location"],
  );
  assert.deepEqual(await readPicture(new File([fx.BASE.jpeg], "IMG_2041.jpg")), []);
});

test("namedDocument: a scan's name (a PDF with no text in it) gets the same check", () => {
  const { namedDocument } = globalThis.Clotr;
  assert.deepEqual(
    namedDocument({ name: "w2-2025.pdf" }).map((r) => [r.id, r.matches]),
    [["id_picture", ["w2-2025.pdf"]]],
  );
  assert.deepEqual(namedDocument({ name: "meeting notes.pdf" }), []);
  for (const odd of [null, undefined, {}, { name: 5 }]) assert.deepEqual(namedDocument(odd), []);
});

// Once a picture has been sent, the report and the popup's advice treat a picture of an ID the same as an ID itself.
test("advice: an ID or document picture that was sent gets the identity-theft advice, like the ID numbers", () => {
  require("../extension/insights.js");
  const { adviceFor } = globalThis.ClotrInsights;
  assert.equal(adviceFor("id_picture"), adviceFor("passport"));
  assert.equal(adviceFor("photo_location"), adviceFor("street_address"));
});

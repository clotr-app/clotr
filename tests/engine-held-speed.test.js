"use strict";

// Inputs that took seconds in one step the scan's time limit can't stop: an email spelled out across long runs of
// spaces, a long line of dashes under a table's header, and a run of seed list words under a seed label. All
// values are made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("./load-engine.js")("rules", "detect");
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

const Clotr = globalThis.Clotr;

function scan(text) {
  Clotr.detect.forget();
  return Clotr.detect(text);
}

// An email written out with words ("john at gmail dot com") is found across any run of spaces, and its fingerprint
// folds the spaces away. Each space in a long run that isn't followed by "at", "@" or a dot was tried as the start
// of one again, so 2 × 37,500 spaces took about a second to fingerprint and 2 × 150,000 about 45.
test("an email spelled out across long runs of spaces fingerprints in linear time", () => {
  for (const gap of [" ", "\t"]) {
    const make = (n) => `john${gap.repeat(n)}at gmail${gap.repeat(n)}dot com`;
    const small = make(10000);
    const big = make(40000);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => Clotr.normalize("email", small),
          () => Clotr.normalize("email", big),
          1,
          3,
        ),
      (s, b) => grewMoreThan(s, b, 10),
    );
    assert.equal(slow, null, `${JSON.stringify(gap)}: time grew too much for 4× the input`);
  }
  assert.equal(
    Clotr.normalize("email", `john${" ".repeat(50)}at gmail${"\t".repeat(50)}dot com`),
    "email:john@gmail.com",
  );
  assert.equal(Clotr.normalize("email", "john (at) gmail [dot] com"), "email:john@gmail.com");
  assert.equal(Clotr.normalize("email", "john @ gmail . com"), "email:john@gmail.com");
  // A separator right after another one's spaces is still folded on its own, as before.
  assert.equal(Clotr.normalize("email", "ann @ (at) gmail . (dot) com"), Clotr.normalize("email", "ann@@gmail..com"));
});

// A Markdown table's second line is a row of dashes, and the password-table reader tested the line under every line
// with a "|" in it with one pattern whose dashes could be split three ways. A long line of dashes that ended in
// anything else ("------ end of report") took time growing with the cube of its length: 2,000 dashes took about 2
// seconds, 3,000 about 8 and 4,000 about 19.
test("a long line of dashes under a table's header is read in a moment", () => {
  const password = "Tr0ub4dor" + "&3x";
  const dashes = (n) => `| user | password |\n${"-".repeat(n)} end of report\n| bob | ${password} |`;
  // 4 times the dashes may take at most 10 times as long, where the cube takes 64 times.
  const slow = grewEveryTime(
    () =>
      bestOfPair(
        () => scan(dashes(750)),
        () => scan(dashes(3000)),
        4,
        3,
      ),
    (s, b) => grewMoreThan(s, b, 10),
  );
  assert.equal(slow, null, "time grew too much for 4× the dashes");
  // A fixed limit as well, until a timed lane of its own holds it.
  const text = dashes(3000);
  const started = performance.now();
  scan(text);
  const spent = performance.now() - started;
  assert.ok(spent < 1000, `3,000 dashes took ${spent.toFixed(0)} ms`);
  // A real table under its dash line is still read.
  const table = `| user | password |\n|------|----------|\n| bob | ${password} |`;
  assert.ok(Clotr.redact(table, scan(table)).indexOf(password) < 0, "the table's password survived Cover it");
});

const WORDS = require("./load-engine.js")
  .source("rules")
  .match(/const BIP39 = new Set\(\s*`([\s\S]*?)`/)[1]
  .trim()
  .split(/\s+/);

// A seed phrase made the standard way from random entropy, so its last word carries the real checksum.
function makeSeed(bytes) {
  const hash = crypto.createHash("sha256").update(bytes).digest();
  const bits =
    [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("") +
    hash[0]
      .toString(2)
      .padStart(8, "0")
      .slice(0, (bytes.length * 8) / 32);
  return bits.match(/.{11}/g).map((b) => WORDS[parseInt(b, 2)]);
}

// Under a seed label each window of a run of list words is checked against its checksum, and each check built a
// bit string, several arrays and a fresh hash state, so a 38 KB labelled run took about 9 times as long as the same
// words without a label.
test("a labelled run of list words costs not much more than an unlabelled one", () => {
  const parts = [];
  for (let i = 0, length = 0; length < 38000; i++) {
    parts.push(WORDS[(i * 7919) % WORDS.length]);
    length += parts[i].length + 1;
  }
  const list = parts.join(" ");
  const labelled = `my seed phrase backup: ${list}`;
  const plain = `my shopping notes, a: ${list}`;
  assert.ok(labelled.length <= Clotr.DETECT_WINDOW_CHARS);
  const slow = grewEveryTime(
    () =>
      bestOfPair(
        () => scan(plain),
        () => scan(labelled),
        1,
        3,
      ),
    (p, l) => grewMoreThan(p, l, 4),
  );
  assert.ok(!slow, `a labelled run took ${slow?.map((m) => m.wall.toFixed(1)).join(" against ")} ms`);
});

// The faster checksum still agrees with a standard SHA-256: a valid phrase of every length is found, and the hash
// matches Node's on inputs of many lengths.
test("the seed checksum agrees with a standard SHA-256", () => {
  for (const n of [12, 15, 18, 21, 24]) {
    for (let k = 0; k < 40; k++) {
      const phrase = makeSeed(crypto.randomBytes((n * 32) / 24));
      assert.ok(
        scan(`my seed phrase: ${phrase.join(" ")}`).some((r) => r.id === "crypto_secret"),
        `a valid ${n}-word phrase wasn't found`,
      );
    }
  }
  for (let k = 0; k < 2048; k++) {
    const input = Buffer.from(String(k).repeat(k % 70));
    assert.equal(
      Buffer.from(Clotr.sha256Bytes(input)).toString("hex"),
      crypto.createHash("sha256").update(input).digest("hex"),
    );
  }
});

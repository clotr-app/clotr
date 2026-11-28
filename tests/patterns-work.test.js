// Engine growth tests that count the work instead of timing it (tests/work.js). They live in their own file because
// the meter keeps V8's block counting on from before the engine loads until the process ends, and with it on the
// engine runs slower, more so on bigger input. The clock tests in tests/patterns.test.js would see that as growth.
// Clock tests don't belong here for the same reason.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The work meter counts steps only in code loaded after it, so it comes before the engine.
const { assertWorkLinear: assertWorkLinearIn } = require("./work.js");
require("./load-engine.js")("rules", "detect", "decide");
const { workRatio, overLimit } = require("./work.js");

// 4 times the input may make at most WORK_GROWTH (8) times the steps, characters read or regex runs: linear work
// measured x3.4 to x4.8, and a pass per find or a loop over every pair x9.8 to x18 where it was most of the work.
const assertWorkLinear = (fn, makeInput, units, n, limit) =>
  assertWorkLinearIn(fn, makeInput, units, n, limit, [__filename]);

// A pass over the text for every find grows much faster than the fourfold increase in input, while linear work
// stays near that increase.
test("the count growth check fails a pass over the text for every find, and passes linear work", () => {
  const repeat = (u, n) => u.repeat(n);
  // This repeats the old two-step sign-in key reader's mistake: each find makes its own pass over the whole text,
  // so 4 times the text takes 16 times as long. That version took 19 seconds on 20,000 links.
  const quadratic = (text) => {
    let n = 0;
    for (const m of text.matchAll(/\d+/g)) n += text.replace(/\d/g, "#").length & m.index;
    return n;
  };
  assert.throws(() => assertWorkLinear(quadratic, repeat, ["7 Oak Dr. "], 700), /work grew too much/);
  // 400 passes over the text is a lot of work, but 4 times the text makes only about 4 times as much.
  const linear = (t) => {
    let n = 0;
    for (let pass = 0; pass < 400; pass++) n += t.replace(/\d/g, "#").length;
    return n;
  };
  assertWorkLinear(linear, repeat, ["7 Oak Dr. "], 700);
});

// Text that looks machine-made but is the same every run, so a slow case stays slow.
const madeUp = (alphabet, length, seed) => {
  let out = "";
  for (let i = 0, x = seed >>> 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += alphabet[(x >>> 8) % alphabet.length];
  }
  return out;
};
const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Every value under a TWILIO_ label looked for Twilio's SID and token pairs through the whole text again, so 256 KB
// of such lines ran past detect()'s time limit and every kind after them went unchecked.
test("many Twilio labels and pairs scan in linear time", () => {
  const blocks = (unit, n, block) => Array.from({ length: n }, (_, i) => block(unit, i * 3)).join("");
  const shapes = {
    tokens: (unit, i) => `${unit}_TOKEN=${madeUp(ALNUM, 16, i)}\n`,
    passwords: (unit, i) => `${unit}_PASSWORD=${madeUp(ALNUM, 16, i)}\n`,
    pairs: (unit, i) => `${unit}_ACCOUNT_SID=AC${madeUp(HEX, 32, i)}\n${unit}_AUTH_TOKEN=${madeUp(HEX, 32, i + 1)}\n`,
  };
  for (const [name, n] of [
    ["tokens", 250],
    ["passwords", 250],
    ["pairs", 80],
  ]) {
    const makeInput = (unit, size) => blocks(unit, size, shapes[name]);
    assert.ok(
      makeInput("TWILIO", n * 4).length <= globalThis.Clotr.DETECT_WINDOW_CHARS,
      `${name} growth check should exercise one detector window`,
    );
    assertWorkLinear((text) => globalThis.Clotr.detect(text), makeInput, ["TWILIO"], n);
  }
});

// A huge paste of digits has to stay linear to read. The old code re-checked the whole run for a list marker like
// "1." or "2)" every time a new digit was added, so 40,000 digits took about a second and froze the chat page.
test("reading a long run of digits grows in step with its length (no freeze on a huge paste)", () => {
  assertWorkLinear(
    (text) => globalThis.Clotr.detect(text),
    (u, n) => u.repeat(n) + "x",
    ["1"],
    1000,
  );
});

test("Cover it grows linearly when the same secret is on every line of a long log", () => {
  const token = "ghp_" + "Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
  const coverOnly = ({ text, results }) => globalThis.Clotr.redact(text, results);
  const makeInput = (unit, n) => {
    const text = unit.repeat(n);
    return { text, results: globalThis.Clotr.detect(text) };
  };
  assertWorkLinear(
    coverOnly,
    makeInput,
    [`GET /api/items Authorization: token ${token} 200\n`, "-----BEGIN PRIVATE KEY-----\n"],
    500,
  );
});

// A paste of thousands of links or key-shaped words still makes linear work. The first build blanked each link
// with its own pass over the whole text, which took 19 seconds on 20,000 links.
test("two-step sign-in keys: a paste full of links or key-shaped words grows linearly", () => {
  const detectOnly = (text) => globalThis.Clotr.detect(text);
  assertWorkLinear(
    detectOnly,
    (u, n) => u.repeat(n),
    ["otpauth://totp/x?secret=N4XQ2ZK7PLM3RTY5 ", "2fa setup key: ab3d cd4e ", "my 2fa secret key is "],
    500,
  );
});

// Each of these once took about ten times longer for four times the text. Every wrapped value, every value of a kind
// and every key ID searched the whole text again, or every line break, so a paste a few hundred kilobytes long took
// seconds where 1.4.1 took a fifth of one.
test("many wrapped values, many values of one kind and many key pairs scan in linear time", () => {
  const blocks = (unit, n, block) => Array.from({ length: n }, (_, i) => block(unit, i * 3)).join("");
  const shapes = {
    wraps: (unit, i) => `${unit}${madeUp(HEX, 10, i)}\n${madeUp(HEX, 6, i + 1)}\n${madeUp(HEX, 6, i + 2)}\nthanks\n`,
    addresses: (unit, i) => `${unit}${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}, `,
    pairs: (unit, i) => `${unit}${madeUp("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16, i)} ${madeUp(ALNUM, 40, i + 1)} `,
  };
  for (const [name, unit, n] of [
    ["wraps", "ghp_", 250],
    ["addresses", "10.", 500],
    ["pairs", "AKIA", 300],
  ]) {
    assertWorkLinear(
      (text) => globalThis.Clotr.detect(text),
      (u, size) => blocks(u, size, shapes[name]),
      [unit],
      n,
    );
  }
});

// PDF page text reads attacker-controlled streams. A regex version rescanned 20,000 characters for every ToUnicode
// range whose "[" never closed, a pass per range that the count sees.
test("PDF page text: hostile streams and ToUnicode ranges make linear work", () => {
  const { pdfPageText } = globalThis.Clotr;
  const read = (x) => pdfPageText([x]);
  assertWorkLinear(read, (u, n) => "BT " + u.repeat(n) + " Tj", ["(", "<0", "beginbfchar ", "[(", "(a\\"]);
  // ToUnicode maps are only read from streams with "begincmap", so these hostile ranges sit inside one.
  assertWorkLinear(read, (u, n) => "begincmap beginbfrange " + u.repeat(n) + " endbfrange endcmap", [
    "<0><0>[",
    "<0> <0> [<0041> ",
    "<0><0>[<0041>] ",
  ]);
  // A single range is already capped at 5,001 codes, so a block with four times as many ranges makes about four
  // times the work. The limit stays 16, as it was when this was timed.
  const ranges = (n) => "begincmap beginbfrange " + "<0000><ffff><0000> ".repeat(n) + "endbfrange endcmap";
  read(ranges(125));
  const shown = overLimit(workRatio(read, ranges(250), ranges(1000), [__filename]), 16);
  assert.ok(!shown, `reading ranges grew too much: ${shown}`);
});

test("private keys: a lone header on a long paste makes linear work", () => {
  assertWorkLinear(
    (text) => globalThis.Clotr.detect(text),
    (_, n) => `${["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ")}\n${"A".repeat(n)}`,
    ["lone header"],
    2500,
  );
});

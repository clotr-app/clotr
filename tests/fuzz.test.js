// Dynamic analysis for the one engine every pasted message passes through. A seeded generator builds thousands of
// strings shaped like the things that have gone wrong before: mixed scripts, near-miss credentials, and the
// invisible or malformed Unicode a copied page can carry. None of it may ever make Clotr.detect() throw, return
// something malformed, or disagree with itself on a second look, and none of it may take long, the freeze class of
// bug the 12 Oct security scan found (crafted text that made a pattern's regex back track for seconds). The
// generator is seeded so a failure reproduces exactly: it prints the seed and the iteration that broke, and running
// this file again fuzzes the identical strings in the identical order.
//
// Run from the repo root: node --test tests/fuzz.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { bestOfPair, grewMoreThan } = require("./timing.js");

// A small, fast generator (mulberry32). The seed is fixed, not time-based, so every run of this file fuzzes the
// same strings in the same order; printing it in a failure message is enough to reproduce the run by hand.
const SEED = 0xc10771a5;
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[int(rng, arr.length)];
const repeat = (s, n) => s.repeat(Math.max(0, n));

// ---------- building blocks the generated text is assembled from ----------

const PUNCT = "-_.,:;@/\\+()[]{}#$%^&*!?='\"<>|~`";
const DIGITS = "0123456789";
const ALNUM_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Stand-ins for scripts other than Latin, so the same engine that reads an English paste also reads one mixed with
// these: Cyrillic, Arabic, Greek, Hebrew, CJK, and full-width and Arabic-Indic digits.
const SCRIPT_RANGES = [
  [0x0400, 0x04ff],
  [0x0600, 0x06ff],
  [0x0370, 0x03ff],
  [0x0590, 0x05ff],
  [0x4e00, 0x9fff],
  [0xff10, 0xff19],
  [0x0660, 0x0669],
];
// Zero-width space, zero-width joiner and non-joiner, soft hyphen, BOM, word joiner: characters a copied page can
// carry that render as nothing.
const INVISIBLE = [0x200b, 0x200c, 0x200d, 0x00ad, 0xfeff, 0x2060];
// Combining diacritics, stacked onto a base letter below.
const COMBINING = [0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0308, 0x030a, 0x0323];

const randScriptChar = (rng) => {
  const [lo, hi] = pick(rng, SCRIPT_RANGES);
  return String.fromCharCode(lo + int(rng, hi - lo + 1));
};
// A codepoint outside the basic plane, written as a real surrogate pair (an emoji range).
const randEmoji = (rng) => String.fromCodePoint(0x1f300 + int(rng, 0x400));
// A single high or low surrogate with no partner: a valid JS string, invalid UTF-16, the kind of input a regex
// engine must read without crashing.
const randLoneSurrogate = (rng) => {
  const high = rng() < 0.5;
  return String.fromCharCode(high ? 0xd800 + int(rng, 0x400) : 0xdc00 + int(rng, 0x400));
};
const randCombiningRun = (rng) => {
  let out = pick(rng, ["a", "e", "n", "o", "A", "5"]);
  for (let i = 0, n = 1 + int(rng, 6); i < n; i++) out += String.fromCharCode(pick(rng, COMBINING));
  return out;
};
const randDigits = (rng, n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += DIGITS[int(rng, 10)];
  return s;
};
const randAlnum = (rng, n, alphabet = ALNUM_UPPER) => {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[int(rng, alphabet.length)];
  return s;
};
const randWord = (rng, n) => {
  let s = "";
  const a = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < n; i++) s += a[int(rng, a.length)];
  return s;
};
// A query string built from many key=value pairs, some with long random values: the shape a tracking or auth link
// gets dragged through, not a specific site's real parameters.
function longQuery(rng, params) {
  const out = [];
  for (let i = 0; i < params; i++) {
    const key = randWord(rng, 1 + int(rng, 8));
    const val = rng() < 0.3 ? randAlnum(rng, 5 + int(rng, 300)) : randWord(rng, 1 + int(rng, 40));
    out.push(`${key}=${encodeURIComponent(val).slice(0, 400)}`);
  }
  return out.join("&");
}

// Each of these reads like a real kind of secret or detail Clotr looks for, but isn't quite one: the wrong length
// or case for a key prefix, a digit run shaped like a card or SSN but almost never a real one, a malformed email, a
// link with a huge query string, and otpauth links with an oversized or padding-only secret.
const NEAR_MISS = [
  (rng) => "AKIA" + randAlnum(rng, 8 + int(rng, 20)),
  (rng) => "akia" + randAlnum(rng, 16, "abcdefghijklmnopqrstuvwxyz0123456789"),
  (rng) => (rng() < 0.5 ? "4" : "5") + randDigits(rng, 11 + int(rng, 8)),
  (rng) => Array.from({ length: 4 }, () => randDigits(rng, 4)).join(rng() < 0.5 ? "-" : " "),
  (rng) => `${randDigits(rng, 3)}-${randDigits(rng, 2)}-${randDigits(rng, 4)}`,
  (rng) => `000-${randDigits(rng, 2)}-${randDigits(rng, 4)}`,
  (rng) => `666-${randDigits(rng, 2)}-${randDigits(rng, 4)}`,
  (rng) => `${randWord(rng, 3 + int(rng, 8))}@@${randWord(rng, 3 + int(rng, 8))}..com`,
  (rng) => `${randWord(rng, 3 + int(rng, 8))}@${randWord(rng, 3 + int(rng, 10))}`,
  (rng) => `https://${randWord(rng, 5)}.example/${randWord(rng, 4)}?${longQuery(rng, 5 + int(rng, 60))}`,
  (rng) =>
    `otpauth://totp/${randWord(rng, 6)}?secret=${randAlnum(rng, 8 + int(rng, 300), BASE32)}&issuer=${randWord(rng, 6)}`,
  (rng) => `otpauth://totp/x?secret=${repeat("=", 4 + int(rng, 300))}`,
  (rng) =>
    `otpauth://totp/${repeat("a", 2 + int(rng, 40))}@${repeat("b", 2 + int(rng, 40))}?secret=AAAA${repeat("=", 1 + int(rng, 200))}`,
];

// One piece of generated text: ordinary mixed characters, a long run of one character (the classic ReDoS shape),
// a near-miss credential or link, a run of another script, emoji, digits threaded with invisible characters, a
// letter buried under combining marks, lone surrogates, or a run of plain whitespace (a label with nothing after
// it). `randomText` below strings many of these together until it reaches the length asked for.
function chunk(rng) {
  switch (int(rng, 9)) {
    case 0: {
      let s = "";
      for (let i = 0, n = 1 + int(rng, 40); i < n; i++) {
        const r = rng();
        s += r < 0.5 ? randWord(rng, 1) : r < 0.75 ? DIGITS[int(rng, 10)] : PUNCT[int(rng, PUNCT.length)];
      }
      return s;
    }
    case 1: {
      const unit =
        rng() < 0.5
          ? PUNCT[int(rng, PUNCT.length)]
          : rng() < 0.5
            ? DIGITS[int(rng, 10)]
            : pick(rng, ["a", "A", "1", "-", ".", " ", "="]);
      return repeat(unit, 5 + int(rng, 600));
    }
    case 2:
      return pick(rng, NEAR_MISS)(rng);
    case 3: {
      let s = "";
      for (let i = 0, n = 1 + int(rng, 30); i < n; i++) s += randScriptChar(rng);
      return s;
    }
    case 4: {
      let s = "";
      for (let i = 0, n = 1 + int(rng, 10); i < n; i++) s += randEmoji(rng);
      return s;
    }
    case 5: {
      let s = "";
      for (let i = 0, n = 1 + int(rng, 20); i < n; i++) {
        s += DIGITS[int(rng, 10)];
        if (rng() < 0.6) s += String.fromCharCode(pick(rng, INVISIBLE));
      }
      return s;
    }
    case 6:
      return randCombiningRun(rng);
    case 7: {
      let s = "";
      for (let i = 0, n = 1 + int(rng, 8); i < n; i++) s += randLoneSurrogate(rng);
      return s;
    }
    default:
      return repeat(pick(rng, [" ", "\n", "\t", " "]), 1 + int(rng, 50));
  }
}
function randomText(rng, targetLen) {
  let s = "";
  while (s.length < targetLen) s += chunk(rng);
  return s.slice(0, targetLen);
}

// What every finding detect() returns has to look like, the fields tests/patterns.test.js reads off every result
// (id, severity, name, matches), plus the rule every match already has to follow there too: it's a real, non-empty
// piece of the exact text passed in, so its position sits inside the input instead of past the end of it or
// nowhere in it at all.
const SEVERITIES = new Set(["high", "medium", "low"]);
function wellFormedProblems(results, text) {
  const problems = [];
  if (!Array.isArray(results)) return ["detect() did not return an array"];
  for (const r of results) {
    if (typeof r.id !== "string" || !r.id) problems.push(`a finding has a bad id: ${JSON.stringify(r.id)}`);
    if (!SEVERITIES.has(r.severity)) problems.push(`${r.id}: bad severity ${JSON.stringify(r.severity)}`);
    if (typeof r.name !== "string" || !r.name) problems.push(`${r.id}: bad name ${JSON.stringify(r.name)}`);
    if (!Array.isArray(r.matches) || r.matches.length === 0) {
      problems.push(`${r.id}: matches isn't a non-empty array (${JSON.stringify(r.matches)})`);
      continue;
    }
    for (const m of r.matches) {
      if (typeof m !== "string" || !m) {
        problems.push(`${r.id}: a match isn't a non-empty string: ${JSON.stringify(m)}`);
        continue;
      }
      const at = text.indexOf(m);
      if (at < 0 || at + m.length > text.length) {
        problems.push(`${r.id}: match doesn't sit inside the input it came from: ${JSON.stringify(m.slice(0, 60))}`);
      }
    }
  }
  if (results.truncated !== undefined && typeof results.truncated !== "boolean") {
    problems.push(`truncated flag isn't a boolean: ${JSON.stringify(results.truncated)}`);
  }
  return problems;
}

// For comparing two runs on the same text: ids and their matches, order-independent either way, since detect()'s
// own ordering only reflects severity and overlap, not anything about the input that should change run to run.
// `truncated` is left out on purpose: it's set from the wall clock, so a slow moment on the machine running the
// test could flip it without that being a real difference in what was found.
const shape = (results) =>
  [...results]
    .map((r) => ({ id: r.id, matches: [...r.matches].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

test("fuzz: thousands of seeded random strings never crash detect(), every finding is well formed, and a repeat call agrees", () => {
  const rng = makeRng(SEED);
  const ITER = 2000;
  const problems = [];
  for (let i = 0; i < ITER && problems.length < 20; i++) {
    const text = randomText(rng, 1 + int(rng, 400));
    let first;
    try {
      first = globalThis.Clotr.detect(text);
    } catch (e) {
      problems.push(`seed ${SEED} iteration ${i}: detect() threw on ${JSON.stringify(text.slice(0, 200))}\n${e.stack}`);
      continue;
    }
    const formed = wellFormedProblems(first, text);
    if (formed.length) {
      problems.push(`seed ${SEED} iteration ${i}: ${formed.join("; ")} (input ${JSON.stringify(text.slice(0, 200))})`);
    }
    let second;
    try {
      second = globalThis.Clotr.detect(text);
    } catch (e) {
      problems.push(
        `seed ${SEED} iteration ${i}: detect() threw on the repeat call for ${JSON.stringify(text.slice(0, 200))}\n${e.stack}`,
      );
      continue;
    }
    try {
      assert.deepEqual(shape(first), shape(second));
    } catch {
      problems.push(
        `seed ${SEED} iteration ${i}: a repeat call on the same text found something different: ${JSON.stringify(text.slice(0, 200))}`,
      );
    }
  }
  assert.deepEqual(
    problems,
    [],
    `seed ${SEED}; ${problems.length} problem(s) (capped at 20), first few:\n${problems.join("\n")}`,
  );
});

// Each seeded hostile string contributes a 1,000-character and 4,000-character prefix. Warmed best-of-three
// measurements compare their growth, so runner load affects both sizes in the same run.
test("fuzz: detection grows with hostile text", () => {
  const rng = makeRng(SEED ^ 0x9e3779b9);
  const CASES = 10;
  const slow = [];
  for (let i = 0; i < CASES; i++) {
    const len = 2000 + int(rng, 18000);
    const text = randomText(rng, len);
    const [small, big] = bestOfPair(
      () => globalThis.Clotr.detect(text.slice(0, 1000)),
      () => globalThis.Clotr.detect(text.slice(0, 4000)),
      4,
      3,
    );
    if (grewMoreThan(small, big, 16)) slow.push(`seed ${SEED} case ${i} (${len} chars) grew too fast`);
  }
  assert.deepEqual(slow, []);
});

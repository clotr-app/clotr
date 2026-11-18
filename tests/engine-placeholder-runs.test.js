"use strict";

// A made-up stand-in after a key's prefix, counted down ("fedcba98…") or a short group repeated ("a1b2c3d4a1b2…"),
// stays quiet after every prefix rule that asks isPlaceholder, while a random value of the same shape still fires.
// The values are built from each rule's own regex, so a rule added later is covered too. Every value is made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

require("../extension/patterns.js");
require("../extension/detector.js");

const SOURCE = fs.readFileSync(path.join(__dirname, "../extension/patterns.js"), "utf8");

// The table of provider prefixes in patterns.js isn't exported, so it is read from the source as data.
function prefixedTokenSources() {
  const start = SOURCE.indexOf("const PREFIXED_TOKENS = [");
  const end = SOURCE.indexOf("].map(([markers, back, source", start);
  const before = /const BEFORE = (String\.raw`[^`]*`);/.exec(SOURCE)[1];
  const after = /const AFTER = (String\.raw`[^`]*`);/.exec(SOURCE)[1];
  const stub = () => true;
  const context = { ownPrefix: stub, machineMade: stub, strictlyRandom: stub, randomMixedCase: stub };
  const rows = vm.runInNewContext(
    `const BEFORE = ${before}; const AFTER = ${after}; ${SOURCE.slice(start + 6, end)}];`.replace(
      "PREFIXED_TOKENS = [",
      "rows = [",
    ) + " rows",
    context,
  );
  return rows.map((row) => row[2]);
}

function serviceTokenSources() {
  const start = SOURCE.indexOf("const SERVICE_TOKEN_RE = new RegExp(");
  const open = SOURCE.indexOf("[", start);
  const end = SOURCE.indexOf('].join("|")', open);
  return vm.runInNewContext(SOURCE.slice(open, end + 1));
}

// Splits a source at its top-level "|" so each alternative is tried on its own.
function alternatives(source) {
  const out = [];
  let depth = 0;
  let inClass = false;
  let from = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      out.push(source.slice(from, i));
      from = i + 1;
    }
  }
  out.push(source.slice(from));
  return out;
}

const ALL = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const ESCAPES = {
  d: "0123456789".split(""),
  s: [" "],
  w: ALL.filter((c) => /\w/.test(c)),
};

// Reads a source into literal characters and character sets, taking the fewest repeats a fixed part allows, up to 20 in a range, the first
// branch of each inner choice and skipping lookarounds and \b.
function parse(source) {
  let i = 0;
  function charSet() {
    i++; // [
    const negate = source[i] === "^";
    if (negate) i++;
    const set = new Set();
    let prev = null;
    while (source[i] !== "]") {
      let chars;
      if (source[i] === "\\") {
        const e = source[i + 1];
        chars = ESCAPES[e] || [e];
        i += 2;
      } else if (source[i] === "-" && prev && source[i + 1] !== "]") {
        const to = source[i + 1] === "\\" ? source[i + 2] : source[i + 1];
        i += source[i + 1] === "\\" ? 3 : 2;
        for (let c = prev.charCodeAt(0); c <= to.charCodeAt(0); c++) set.add(String.fromCharCode(c));
        prev = null;
        continue;
      } else {
        chars = [source[i]];
        i++;
      }
      for (const c of chars) set.add(c);
      prev = chars.length === 1 ? chars[0] : null;
    }
    i++; // ]
    return negate ? ALL.filter((c) => !set.has(c)) : [...set];
  }
  function sequence() {
    const parts = [];
    while (i < source.length && source[i] !== ")" && source[i] !== "|") {
      let part;
      const c = source[i];
      if (c === "(") {
        const look = /^\(\?<?[=!]/.exec(source.slice(i));
        i += look ? look[0].length : source.startsWith("(?:", i) ? 3 : 1;
        const inner = sequence();
        while (source[i] === "|") {
          i++;
          sequence();
        }
        i++; // )
        if (look) continue;
        part = { group: inner };
      } else if (c === "[") {
        part = { set: charSet() };
      } else if (c === "\\") {
        const e = source[i + 1];
        i += 2;
        if (e === "b") continue;
        part = ESCAPES[e] ? { set: ESCAPES[e] } : { lit: e };
      } else if (c === "^" || c === "$") {
        i++;
        continue;
      } else {
        part = { lit: c === "." ? "x" : c };
        i++;
      }
      const q = /^(?:\{(\d+)(,(\d*))?\}|[?*+])\??/.exec(source.slice(i));
      part.times = 1;
      if (q) {
        i += q[0].length;
        // A range reaches 20 when it allows it, so a short minimum still leaves room for a stand-in.
        const most = q[3] ? Number(q[3]) : Infinity;
        part.times =
          q[1] === undefined
            ? q[0][0] === "+"
              ? 1
              : 0
            : q[2]
              ? Math.min(Math.max(Number(q[1]), 20), most)
              : Number(q[1]);
      }
      parts.push(part);
    }
    return parts;
  }
  return sequence();
}

// Fills the sets from a stream of characters the stand-in is made of; literal parts stay as they are.
function build(parts, fill) {
  let out = "";
  for (const part of parts) {
    for (let n = 0; n < part.times; n++) {
      if (part.lit !== undefined) out += part.lit;
      else if (part.group) out += build(part.group, fill);
      else out += fill(part.set);
    }
  }
  return out;
}

const DOWN = "zyxwvutsrqponmlkjihgfedcba9876543210";

// Counted down through the characters the set allows, in its own case, and round again.
function countDown() {
  let at = 0;
  return (set) => {
    const letters = set.includes("a") ? DOWN : DOWN.toUpperCase();
    const order = letters.split("").filter((c) => set.includes(c));
    const list = order.length ? order : set;
    return list[at++ % list.length];
  };
}

// The same short group over and over: "a1b2c3d4" or "abc", mapped into the set when a character isn't in it.
function repeating(group) {
  let at = 0;
  return (set) => {
    const i = at++ % group.length;
    const c = group[i];
    if (set.includes(c)) return c;
    if (set.includes(c.toUpperCase())) return c.toUpperCase();
    return set[i % set.length];
  };
}

// A seeded random stream, so a failure is the same on every run.
function random(seed) {
  let s = seed >>> 0;
  return (set) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return set[Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * set.length)];
  };
}

// Rules a value built from the regex alone can't stand for: the real one carries a checksum, binary fields or
// JSON in base64, or a set word, so a random fill isn't real-shaped for it.
const NOT_BUILT = [
  /^gh[pousr]_|^github_pat_|^ghs_/, // GitHub's tokens end in a checksum
  /^eyJ|^ops_eyJ|^sntrys_eyJ|^sk\.eyJ/, // base64 JSON
  /^ATCTT3|^ATATT3/, // Atlassian's carries a checksum
  /^FlyV1/, // Fly.io's is base64 of binary fields
  /^1\.Ax|^0\.Ax/, // Microsoft Entra refresh tokens are base64 of binary fields
  /^perm:/, // YouTrack's is base64 of a name
  /^https:|^\d+:AA|^xoxe\.xapp-/, // links and bot tokens with a set structure
  /^(?:AccountKey|SharedAccessKey)=/, // a connection string, read by its label
];

function rules() {
  const sources = [
    ...prefixedTokenSources(),
    ...serviceTokenSources(),
    ...globalThis.Clotr.PATTERNS.filter((p) => p.secret && p.regex).map((p) => p.regex.source),
  ];
  const out = [];
  for (const source of sources) {
    for (const alt of alternatives(source)) {
      const parts = parse(alt);
      if (!NOT_BUILT.some((re) => re.test(build(parts, random(1))))) out.push({ source: alt, parts });
    }
  }
  return out;
}

const found = (value) =>
  globalThis.Clotr.detect(`here it is ${value} ok`).some((r) =>
    r.matches.some((m) => m.length >= 8 && (value.includes(m) || m.includes(value))),
  );

const RULES = rules();

test("the prefix rules are read from the engine's own tables", () => {
  assert.ok(RULES.length >= 100, `only ${RULES.length} prefix rules read`);
  // The prefixes the review tried, as their rules write them.
  for (const p of ["fc-", "sq[upa]_", "CLOJARS_", "csk-", "lin_", "xsmtpsib-", "sk_(", "napi_", "rubygems_"]) {
    assert.ok(
      RULES.some((r) => r.source.includes(p)),
      `no rule read for ${p}`,
    );
  }
});

test("a random value of each prefix rule's shape is still found", () => {
  const missed = [];
  for (const rule of RULES) {
    // A few seeds, since a random fill can read as words or miss a digit by chance.
    const hit = [1, 2, 3, 4, 5].some((seed) => found(build(rule.parts, random(seed))));
    if (!hit) missed.push(build(rule.parts, random(1)));
  }
  assert.deepEqual(missed, []);
});

for (const [name, fill] of [
  ["counted down", countDown],
  ["a1b2c3d4 repeated", () => repeating("a1b2c3d4")],
  ["abc repeated", () => repeating("abc")],
]) {
  test(`a stand-in ${name} after each prefix rule stays quiet`, () => {
    const loud = [];
    for (const rule of RULES) {
      const value = build(rule.parts, fill());
      if (found(value)) loud.push(value);
    }
    assert.deepEqual(loud, []);
  });
}

test("isPlaceholder knows counted-down runs and short repeated groups", () => {
  const { isPlaceholder } = globalThis.Clotr;
  for (const v of [
    "fc-fedcba9876543210fedcba9876543210",
    "squ_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
    "CLOJARS_abcabcabcabcabcabcabcabcabcabcabcabc",
    "sk_ZYXWVUTS",
    "napi_9876543210",
  ]) {
    assert.equal(isPlaceholder(v), true, v);
  }
  // Random values, and runs too short to be more than chance.
  for (const v of [
    "fc-3e9a71c04bd2f86e5a1c97d03b4e28f6",
    "csk-k3v9q2m8x4w7r1t6y5u0p2l8n4j7h3g9f1d5s6a2",
    "sk_fedcba9q2m8x4w7r1t6y5u0p2l8n4",
    "napi_a1b2a1b2x9w8v7u6t5",
  ]) {
    assert.equal(isPlaceholder(v), false, v);
  }
});

// The table read above takes the first branch of a choice inside a rule, so Linear's OAuth token is tried here.
test("Linear's OAuth token: a stand-in stays quiet and a random one is found", () => {
  const hex = (fill) => build(parse("[a-f0-9]{64}"), fill);
  assert.equal(found(`lin_oauth_${hex(countDown())}`), false);
  assert.equal(found(`lin_oauth_${hex(repeating("a1b2c3d4"))}`), false);
  assert.equal(found(`lin_oauth_${hex(random(1))}`), true);
});

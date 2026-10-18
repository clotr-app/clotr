// Property-based fuzzing for the engine, on top of the seeded generator in tests/fuzz.test.js. fast-check builds
// its own random inputs from the arbitraries below and shrinks any failure to the smallest string that still
// breaks the property, so a crash here points straight at the cause instead of a 400-character paste.
// Run from the repo root: node --test tests/fuzz-properties.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("fast-check");
const { bestOfBoth } = require("./timing.js");

require("../extension/patterns.js");
require("../extension/detector.js");

const SEVERITIES = new Set(["high", "medium", "low"]);

// The same shape tests/patterns.test.js and tests/fuzz.test.js expect of every finding: a real id and severity, a
// name, and a non-empty list of matches that are each a genuine, non-empty piece of the exact text passed in.
function wellFormed(results, text) {
  if (!Array.isArray(results)) return false;
  for (const r of results) {
    if (typeof r.id !== "string" || !r.id) return false;
    if (!SEVERITIES.has(r.severity)) return false;
    if (typeof r.name !== "string" || !r.name) return false;
    if (!Array.isArray(r.matches) || r.matches.length === 0) return false;
    for (const m of r.matches) {
      if (typeof m !== "string" || !m) return false;
      const at = text.indexOf(m);
      if (at < 0 || at + m.length > text.length) return false;
    }
  }
  return results.truncated === undefined || typeof results.truncated === "boolean";
}

// Order-independent, so a run that found the same things in a different order still compares equal.
const shape = (results) =>
  [...results]
    .map((r) => ({ id: r.id, matches: [...r.matches].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// Any string fast-check can build: full Unicode, including lone surrogates and invisible characters, up to a
// length long enough to exercise real patterns without making every run of the suite slow.
const text = fc.string({ unit: "binary", maxLength: 2000 });

const detect = (t) => globalThis.Clotr.detect(t);

test("property: detect() never throws on any string", () => {
  fc.assert(
    fc.property(text, (t) => {
      detect(t);
    }),
  );
});

test("property: every finding detect() returns is well formed", () => {
  fc.assert(
    fc.property(text, (t) => {
      assert.ok(wellFormed(detect(t), t));
    }),
  );
});

test("property: detect() agrees with itself on the same text", () => {
  fc.assert(
    fc.property(text, (t) => {
      assert.deepEqual(shape(detect(t)), shape(detect(t)));
    }),
  );
});

test("property: detect() stays fast on an ordinary-sized paste", () => {
  fc.assert(
    fc.property(text, (t) => {
      // Clock and this process's own processor time both have to be over, scaled to how busy the computer is right
      // now (tests/timing.js): a full suite next to a Rust build once took this past 2 s on the clock alone.
      const timing = bestOfBoth(() => detect(t), 1);
      assert.ok(!timing.over(2000), `detect() took too long on ${JSON.stringify(t.slice(0, 80))}`);
    }),
  );
});

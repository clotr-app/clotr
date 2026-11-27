// A link password shaped like code: many names joined by dots, arrows, colons, brackets or braces, ending in a
// character a name can't hold. A pattern that could read each name two ways once took time that doubled with
// every name, so one 106-character line froze the chat tab for 13 seconds.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

// ---------- Long code-shaped passwords ----------

const JOINS = [".A", "->B", ":A", "[B]", "{B}", ".DB"];
const NAMES_THAT_FROZE = 26;
// A line takes about a millisecond, so this leaves room for a slow machine and still catches the doubling.
const ONE_LINE_MS = 500;

function chainLine(join, names) {
  return `DATABASE_URL=postgres://app:$A${join.repeat(names)}!@localhost:5432/app`;
}

function timeOnce(fn) {
  globalThis.Clotr.detect.forget?.();
  const started = performance.now();
  fn();
  return performance.now() - started;
}

test("a link password of 26 joined names reads in well under a second", () => {
  for (const join of JOINS) {
    const line = chainLine(join, NAMES_THAT_FROZE);
    const ms = timeOnce(() => detect(line));
    assert.ok(ms < ONE_LINE_MS, `${line}: ${ms.toFixed(0)} ms`);
  }
});

test("a long code-shaped link password reads in linear time", () => {
  for (const join of JOINS) {
    const small = chainLine(join, 1000);
    const big = chainLine(join, 16000);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => detect(small),
          () => detect(big),
        ),
      (s, b) => grewMoreThan(s, b, 32),
    );
    const ratio = slow ? (slow[1].wall / slow[0].wall).toFixed(1) : "";
    assert.ok(!slow, `a password of ${JSON.stringify(join)} names: time grew ${ratio}× for 16× the names`);
  }
});

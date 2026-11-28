// The work meter (tests/work.js) against five slowdowns planted around the real engine. Each test says which check
// catches its slowdown and which don't, so a change to the meter or to a limit that blinds a check fails here.
//   the count growth check     4 times the text may not make more than WORK_GROWTH times the steps, characters
//                              read or regex runs, as assertWorkLinear in tests/patterns-work.test.js checks
//   the count against the engine  the planted engine may not do more than AGAINST times the unplanted engine's
//                              steps, characters read or regex runs on the same text
//   the clock growth check     what assertLinear in tests/patterns.test.js does, timed with tests/timing.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { work, workGrowth, WORK_GROWTH } = require("./work.js");
require("./load-engine.js")("rules", "detect", "decide");
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

const AGAINST = 1.15; // the most extra work a rule may do against the last release, by count
const N = 1500;

const engine = (text) => globalThis.Clotr.detect(text);
const oldEmail = /[\w.-]+@[\w-]+\.\w+/; // the email pattern that once backtracked from every start
const slowClass = /(?:[a-z]|[0-9]|[ -/]|[^\x00-\x7f])*$/; // linear, but several times the work per character

// Each plant runs the real detect() and then its own extra work. None of this is in the extension.
const PLANTS = {
  // Every word compared with every other in plain JS, as the overlap check once did.
  "a pairwise loop in JS": (t) => {
    const found = engine(t);
    const words = t.split(/\s+/);
    let n = 0;
    for (const a of words) for (const b of words) if (a.length > b.length) n++;
    return n && found;
  },
  // Each find makes its own pass over the whole text, as the old two-step sign-in key reader did.
  "a pass over the text for every find": (t) => {
    const found = engine(t);
    let n = 0;
    for (const m of t.matchAll(/\S+/g)) n += t.replace(/\d/g, "#").length & m.index;
    return n && found;
  },
  // A third of the text read again: every size slower by the same share, so growth looks the same.
  "a third more regex runs": (t) => {
    engine(t.slice(0, Math.floor(t.length / 3)));
    return engine(t);
  },
  // A regex call that backtracks from every start: one run whatever the length. Three of them, so the backtracking
  // outweighs the engine's own time at a size the clock check can run quickly.
  "backtracking inside one regex call": (t) => {
    const found = engine(t);
    for (let i = 0; i < 3; i++) oldEmail.test(t);
    return found;
  },
  // Every size slower by the same share, inside regex runs the engine counts the same.
  "slower inside the same regex runs": (t) => {
    const found = engine(t);
    for (let i = 0; i < 12; i++) slowClass.test(t);
    return found;
  },
};

const prose = "The meeting moved to Thursday at 3pm, call me on 555-0100 if that fails. ";
const SHAPES = {
  "plain prose": (_u, n) => prose.repeat(Math.ceil(n / 10)),
  "'a-' repeated": (_u, n) => "a-".repeat(n),
  "emails, one a line": (_u, n) =>
    Array.from({ length: Math.ceil(n / 4) }, (_, i) => `user${i}@example.com`).join("\n"),
};

// The steps in this file count too, since that's where the plants are.
const counts = (fn, text) => work(() => fn(text), [__filename]);

// The shapes on which 4 times the text grew a count past the limit.
function growthCatches(fn) {
  const caught = [];
  for (const [shape, make] of Object.entries(SHAPES)) {
    const grew = workGrowth(fn, make, "", N, [__filename]);
    for (const [count, times] of Object.entries(grew)) {
      if (times > WORK_GROWTH) caught.push(`${shape}: ${count} x${times.toFixed(1)}`);
    }
  }
  return caught;
}

// The shapes on which the plant did more than AGAINST times the unplanted engine's work. Both texts end in a new
// tail of the same length, so neither is an answer the engine kept.
let tail = 0;
function againstCatches(fn) {
  const caught = [];
  for (const [shape, make] of Object.entries(SHAPES)) {
    const text = make("", N * 4);
    const fresh = () => `${text} ${((tail++ % 26) + 10).toString(36)}`;
    const base = counts(engine, fresh());
    const planted = counts(fn, fresh());
    for (const count of ["steps", "chars", "execs"]) {
      const times = planted[count] / base[count];
      if (times > AGAINST) caught.push(`${shape}: ${count} x${times.toFixed(2)}`);
    }
  }
  return caught;
}

const which = (caught, count) => caught.filter((line) => line.includes(`: ${count} `));

test("the meter gives the same characters and regex runs on 5 runs in a row, and steps within 2%", () => {
  const text = prose.repeat(400);
  engine(`${text} w`);
  const runs = Array.from({ length: 5 }, (_, i) => counts(engine, `${text} ${i}`));
  for (const run of runs) {
    assert.equal(run.chars, runs[0].chars);
    assert.equal(run.execs, runs[0].execs);
    assert.ok(Math.abs(run.steps / runs[0].steps - 1) <= 0.02, `steps ${run.steps} against ${runs[0].steps}`);
  }
  assert.ok(runs[0].steps > 0 && runs[0].chars > text.length && runs[0].execs > 0, JSON.stringify(runs[0]));
});

test("the unplanted engine passes both count checks", () => {
  assert.deepEqual(growthCatches(engine), []);
  assert.deepEqual(againstCatches(engine), []);
});

test("a pairwise loop in JS: the steps growth check catches it, the characters one doesn't", () => {
  const caught = growthCatches(PLANTS["a pairwise loop in JS"]);
  assert.ok(which(caught, "steps").length, caught.join("; "));
  assert.deepEqual(which(caught, "chars"), []);
});

test("a pass over the text for every find: the characters growth check catches it, the steps one doesn't", () => {
  const caught = growthCatches(PLANTS["a pass over the text for every find"]);
  assert.ok(which(caught, "chars").length, caught.join("; "));
  assert.deepEqual(which(caught, "steps"), []);
});

test("a third more regex runs: the count against the unplanted engine catches it, the growth check doesn't", () => {
  const plant = PLANTS["a third more regex runs"];
  assert.deepEqual(growthCatches(plant), []);
  const caught = againstCatches(plant);
  assert.ok(which(caught, "execs").length, caught.join("; "));
});

test("backtracking inside one regex call: neither count catches it, the clock growth check does", () => {
  const plant = PLANTS["backtracking inside one regex call"];
  assert.deepEqual(growthCatches(plant), []);
  assert.deepEqual(againstCatches(plant), []);
  // The clock check as assertLinear runs it, on the shape that makes this pattern backtrack.
  const small = "a-".repeat(2000);
  const big = "a-".repeat(8000);
  const slow = grewEveryTime(
    () =>
      bestOfPair(
        () => plant(small),
        () => plant(big),
        4,
        3,
      ),
    (s, b) => grewMoreThan(s, b, 10),
  );
  assert.ok(slow, "the clock growth check missed backtracking inside one regex call");
});

test("slower inside the same regex runs: neither count catches it", () => {
  const plant = PLANTS["slower inside the same regex runs"];
  assert.deepEqual(growthCatches(plant), []);
  assert.deepEqual(againstCatches(plant), []);
});

// A count test that fails throws out of work(). The methods it wrapped and the optimizers it turned off have to come
// back all the same, or every test after it in the process runs on the wrapped methods or unoptimized code.
test("a measured call that throws leaves the String and RegExp methods and the optimizers as they were", () => {
  const { spawnSync } = require("node:child_process");
  const child = `
    const before = [RegExp.prototype.exec, String.prototype.indexOf, String.prototype.replace];
    const { work } = require(${JSON.stringify(require.resolve("./work.js"))});
    try { work(() => { throw new Error("planted"); }); } catch {}
    const after = [RegExp.prototype.exec, String.prototype.indexOf, String.prototype.replace];
    function hot(x) { let s = 0; for (let i = 0; i < 50; i++) s += x * i; return s; }
    %PrepareFunctionForOptimization(hot); hot(1); hot(2); %OptimizeFunctionOnNextCall(hot); hot(3);
    console.log(JSON.stringify({ restored: before.every((f, i) => f === after[i]), optimized: Boolean(%GetOptimizationStatus(hot) & 16) }));
  `;
  const run = spawnSync(process.execPath, ["--allow-natives-syntax", "-e", child], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { restored: true, optimized: true });
});

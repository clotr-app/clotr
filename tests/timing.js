// These are speed checks, and they have to survive running on a busy machine: tests often share every core with
// browsers, builds and other test runs at once.
//
// A busy computer slows a measurement in two separate ways, and each needs its own fix. First, the code has to
// wait its turn for a processor, and that wait shows up on the clock. While a check is measuring, this file asks
// the system to run its process first, a raised priority, so the clock measures the code itself rather than the
// wait.
//
// Second, every core runs slower when the system is busy, since cores share power and memory and a busy system
// moves work onto its smaller, slower cores. That can stretch processor time by up to about 2.5 times when every
// core is busy. So a budget is set in milliseconds for a quiet computer, and if a check misses its budget, it
// times a fixed reference piece of work in turns with the code being measured, and lets the budget grow by
// whatever the reference slowed down by. Growth checks, which expect roughly 4 times the text to take roughly 4
// times as long, time their two sizes in turns too, so a slow moment lands on both of them over the same span:
// the small text is read as many times as the big one is bigger, since a 12 ms timing next to a 200 ms one
// wouldn't be a fair pair on a busy computer otherwise, as the short one often runs entirely on a fast core while
// the long one rarely does. The reference is repeated the same way, so it takes about as long as the code it is
// compared against.
//
// If a check still misses its budget, it measures again after a short pause, up to three tries, and only fails
// once every try has missed. Real slowness, like a pattern that backtracks or code whose time grows with the
// square of its input, misses on every try, at rest and under load, and still fails: the speed checks at the top
// of patterns.test.js plant examples of both.
"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");

// Waits without returning to the event loop, so synchronous tests can use it.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// check() measures and returns nothing on a pass, or a message describing what was too slow. On success,
// retrySlow returns how many tries it took. It only fails, with the last message, once every try has missed.
function retrySlow(check, { tries = 3, pauseMs = 300 } = {}) {
  let miss;
  for (let i = 0; i < tries; i++) {
    if (i) pause(pauseMs);
    miss = check();
    if (!miss) return i + 1;
  }
  assert.fail(`${miss} (slow on all ${tries} tries)`);
}

// The same for an async check().
async function retrySlowAsync(check, { tries = 3, pauseMs = 300 } = {}) {
  let miss;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    miss = await check();
    if (!miss) return i + 1;
  }
  assert.fail(`${miss} (slow on all ${tries} tries)`);
}

// Runs fn() with this process bumped one step above its normal priority, then puts the priority back afterward.
// Linux and macOS refuse this without special rights, so there fn() just runs at the usual priority and `raised`
// stays false. This works for async functions too.
let raised = false;
function prioritized(fn) {
  let before;
  try {
    before = os.getPriority(0);
    os.setPriority(0, Math.min(before, os.constants.priority.PRIORITY_ABOVE_NORMAL));
    raised = os.getPriority(0) < 0;
  } catch {
    before = undefined;
    raised = false;
  }
  const restore = () => {
    try {
      if (before !== undefined) os.setPriority(0, before);
    } catch {
      // nothing to restore
    }
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

// Times `times` runs of fn() in a row. Returns the clock time and this process's own processor time for one run,
// both in milliseconds, plus `span`, how long the whole timing took on the clock.
function timeOnce(fn, times = 1) {
  const c = process.cpuUsage();
  const s = performance.now();
  for (let i = 0; i < times; i++) fn();
  const span = performance.now() - s;
  const d = process.cpuUsage(c);
  return { wall: span / times, cpu: (d.user + d.system) / 1000 / times, span, times };
}

async function timeOnceAsync(fn) {
  const c = process.cpuUsage();
  const s = performance.now();
  await fn();
  const wall = performance.now() - s;
  const d = process.cpuUsage(c);
  return { wall, cpu: (d.user + d.system) / 1000, raised };
}

const keepBest = (best, t) => {
  best.wall = Math.min(best.wall, t.wall);
  best.cpu = Math.min(best.cpu, t.cpu);
  best.span = Math.min(best.span ?? Infinity, t.span ?? t.wall);
  best.times = t.times ?? 1;
  best.raised = raised;
};

// The reference is a fixed piece of work shaped like the code under test: regular expressions over a long text,
// plus the strings built from it. It builds a new text on every pass, so the engine can't shortcut it with a
// cached answer.
const REFERENCE_TEXT = Array.from(
  { length: 4000 },
  (_, i) => `Line ${i}: call 555-555-${1000 + i} or write to p${i}@example.com, at ${i} Oak Dr. `,
).join("");
let referenceRuns = 0;
function reference() {
  let n = 0;
  for (let r = 0; r < 20; r++) {
    const text = REFERENCE_TEXT + referenceRuns++;
    for (const m of text.matchAll(/\b(\d{3})-(\d{3})-(\d{4})\b|[\w.]+@[\w.]+\.\w+|\d+ \w+ (?:Dr|St)\b/g))
      n += m.index & 1;
    n += text.toLowerCase().split(/[\s,.:]+/).length;
    n += text.replace(/\d/g, "#").length;
  }
  return n;
}
// How long the reference takes on a quiet computer. This was measured on the 2024 laptop the budgets were set on,
// as the fastest of three runs, the same way the checks measure. A slower or busier computer takes longer, so its
// budgets grow to match, while a faster one keeps the budgets as written.
const REFERENCE_MS = 90;
// Times the reference once, for about as long as `ms` would take on a quiet computer, and returns how long it took
// on this computer right now.
const referenceFor = (ms) => timeOnce(reference, Math.min(10, Math.max(1, Math.round(ms / REFERENCE_MS)))).wall;

// Adds a budget check to a timing: over(budget) reports whether fn() takes `budget` ms or more, counting only this
// process's own work. Both the clock time and the processor time have to be over budget, since waiting for a turn
// only shows up on the clock. If the first timing is over budget, fn() is timed again in turns with the reference,
// and the budget grows by however much slower the reference ran than on a quiet computer. Those new timings replace
// wall and cpu, and `allowed` records what the budget grew to.
function withBudget(t, fn, runs, times = 1) {
  t.allowed = undefined;
  t.over = (budget) => {
    t.allowed = budget;
    if (t.wall < budget || t.cpu < budget) return false;
    const again = { wall: Infinity, cpu: Infinity };
    let ref = Infinity;
    prioritized(() => {
      for (let r = 0; r < runs; r++) {
        ref = Math.min(ref, referenceFor(budget * times));
        keepBest(again, timeOnce(fn, times));
      }
      ref = Math.min(ref, referenceFor(budget * times));
    });
    t.wall = again.wall;
    t.cpu = again.cpu;
    t.allowed = budget * Math.max(1, ref / REFERENCE_MS);
    return t.wall >= t.allowed && t.cpu >= t.allowed;
  };
  return t;
}

// Takes the fastest of `runs` timings of fn(), both on the clock and in this process's own processor time, in
// milliseconds, and attaches its budget check as `over(budget)`.
function bestOfBoth(fn, runs = 3) {
  const best = { wall: Infinity, cpu: Infinity };
  prioritized(() => {
    for (let r = 0; r < runs; r++) keepBest(best, timeOnce(fn));
  });
  return withBudget(best, fn, runs);
}

// The same idea for an async fn(), like a file read, timed just once. Its budget check times the reference
// immediately before and immediately after fn() runs.
async function timedAsync(fn) {
  const t = await prioritized(() => timeOnceAsync(fn));
  t.overAsync = async (budget) => {
    t.allowed = budget;
    if (t.wall < budget || t.cpu < budget) return false;
    const again = await prioritized(async () => {
      const before = referenceFor(budget);
      const timed = await timeOnceAsync(fn);
      return { ...timed, ref: Math.min(before, referenceFor(budget)) };
    });
    t.wall = again.wall;
    t.cpu = again.cpu;
    t.allowed = budget * Math.max(1, again.ref / REFERENCE_MS);
    return t.wall >= t.allowed && t.cpu >= t.allowed;
  };
  return t;
}

// Times small() and big() for a growth check, where big() is expected to read `times` times as much text. It takes
// the fastest of `runs` timings of each, alternating small, big, small, big, so a busy moment or a slower core
// affects both sizes equally. Each small timing reads the small text `times` times in a row, so one run of each
// takes about as long. Both come back with a budget check, the same as bestOfBoth's.
function bestOfPair(small, big, times, runs = 3) {
  const s = { wall: Infinity, cpu: Infinity };
  const b = { wall: Infinity, cpu: Infinity };
  prioritized(() => {
    for (let r = 0; r < runs; r++) {
      keepBest(s, timeOnce(small, times));
      keepBest(b, timeOnce(big));
    }
  });
  return [withBudget(s, small, runs, times), withBudget(b, big, runs)];
}

// Returns the fastest of `runs` timings of fn() on the clock alone, in milliseconds, at the raised priority.
function bestOf(fn, runs = 3) {
  return bestOfBoth(fn, runs).wall;
}

// Checks whether `big` grew more than `limit` times `small`, on the clock and in this process's own processor
// time. The clock time alone can be trusted only when both timings ran at the raised priority over spans long
// enough, 50 ms each, that a garbage collection or a compile can't swing the result; otherwise a busy moment during
// either timing could inflate it, so processor time has to agree too. Windows counts processor time in 16 ms
// steps, so a timing's processor time there is treated as at least 16 ms, which keeps a timing too short to measure
// from making the ratio look huge. `floor` keeps the small side from rounding down to nothing.
const CPU_STEP = process.platform === "win32" ? 16 : 0;
function grewMoreThan(small, big, limit, floor = 5) {
  const clock = big.wall / Math.max(small.wall, floor) >= limit;
  const long = (t) => (t.span ?? t.wall) >= 50;
  if (small.raised && big.raised && long(small) && long(big)) return clock;
  return clock && big.cpu / Math.max(small.cpu, CPU_STEP / (small.times ?? 1), floor) >= limit;
}

module.exports = {
  retrySlow,
  retrySlowAsync,
  bestOf,
  bestOfBoth,
  bestOfPair,
  timedAsync,
  grewMoreThan,
  pause,
  reference,
  REFERENCE_MS,
};

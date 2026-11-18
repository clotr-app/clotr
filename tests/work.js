// A work meter for growth tests, with no clock in it. For one call it returns three counts:
//   steps  how many times V8 entered each function and block of code in the chosen scripts (its precise block counts)
//   chars  how many characters the call's regex runs and string scans read, and items its array searches read
//   execs  how many regex runs the call made (match, matchAll, replace, split and test all run through exec)
// A count reads the same on a busy machine as on a quiet one, so a growth limit on counts can be tight. It can't see
// backtracking inside one regex run, so the tests that guard against that keep their clock check.
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const v8 = require("node:v8");
const inspector = require("node:inspector");
const { fileURLToPath } = require("node:url");

// V8 counts blocks only in code compiled after counting starts, so the engine has to load after this file.
if (globalThis.Clotr) throw new Error("tests/work.js has to be loaded before the engine");

const session = new inspector.Session();
session.connect();
// session.post answers a Profiler call before it returns, so it can be read straight away.
function post(method, params) {
  let out;
  let error;
  session.post(method, params, (err, result) => {
    error = err;
    out = result;
  });
  if (error) throw error;
  return out;
}
// Started once and never stopped: stopping and starting again set every count back to 1.
post("Profiler.enable");
post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

// Block counting stays on between calls too, and code runs slower with it, more so on bigger input, so a clock test in
// a file that loads this one can time growth that isn't the code's own. Keep clock tests out of such files.

// V8 drops block counts inside optimized code, so steps drifted a few percent between runs of the same call. While a
// call is measured the optimizers are off, and switching the coverage mode away and back throws out code they already
// made. They come back on afterwards. This assumes they were on to begin with, as they are by default.
function countEveryStep() {
  v8.setFlagsFromString("--no-turbofan");
  v8.setFlagsFromString("--no-maglev");
  post("Profiler.startPreciseCoverage", { callCount: false, detailed: true });
  post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
}
function optimizeAgain() {
  v8.setFlagsFromString("--turbofan");
  v8.setFlagsFromString("--maglev");
}

const EXTENSION = path.join(__dirname, "..", "extension");

let chars = 0;
let execs = 0;
let on = false;

// Characters a regex run reads: up to the end of its match, or to the end of the text when it finds nothing. A sticky
// regex only tries one place, so a miss counts 1, or a linear scan made of sticky steps would look quadratic.
function wrapExec(exec) {
  return function (s) {
    if (!on) return exec.call(this, s);
    const text = String(s);
    const from = this.global || this.sticky ? this.lastIndex : 0;
    const found = exec.call(this, text);
    execs++;
    if (found) chars += found.index + found[0].length - from + 1;
    else chars += this.sticky ? 1 : Math.max(0, text.length - from) + 1;
    return found;
  };
}

// String methods that read the whole string. With a regex argument they run through exec, which counts it already.
const WHOLE = [
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "normalize",
  "trim",
  "trimStart",
  "trimEnd",
  "split",
  "replace",
  "replaceAll",
  "match",
  "matchAll",
  "search",
  "localeCompare",
];
// String methods whose work is the length of what they return.
const RESULT = ["slice", "substring", "substr", "concat", "repeat", "padStart", "padEnd"];
const realIndexOf = String.prototype.indexOf;
const realLastIndexOf = String.prototype.lastIndexOf;

function wrapWhole(fn) {
  return function (...args) {
    if (on && !(args[0] instanceof RegExp)) chars += this.length + 1;
    return fn.apply(this, args);
  };
}
function wrapResult(fn) {
  return function (...args) {
    const out = fn.apply(this, args);
    if (on) chars += out.length + 1;
    return out;
  };
}
// indexOf and includes read up to where they find the needle, or to the end.
function wrapFind(fn) {
  return function (needle, from = 0) {
    if (on) {
      const start = Math.max(0, Math.min(this.length, Math.trunc(Number(from)) || 0));
      const at = realIndexOf.call(this, needle, start);
      chars += (at < 0 ? this.length - start : at - start + String(needle).length) + 1;
    }
    return fn.call(this, needle, from);
  };
}

// lastIndexOf reads backwards from where it starts, the end unless told otherwise, down to its find or the start.
function wrapFindBack(fn) {
  return function (needle, from = Infinity) {
    if (on) {
      const n = String(needle).length;
      const start = Math.max(0, Math.min(this.length - n, Number.isNaN(Number(from)) ? Infinity : Number(from)));
      const at = realLastIndexOf.call(this, needle, start);
      chars += (at < 0 ? start : start - at) + n + 1;
    }
    return fn.call(this, needle, from);
  };
}

// An array search reads from where it starts, the near end unless told otherwise, to its find or the far end.
const realArrayIndexOf = Array.prototype.indexOf;
const realArrayLastIndexOf = Array.prototype.lastIndexOf;
function wrapArrayFind(fn, backwards) {
  return function (item, ...from) {
    if (on) {
      const at = (backwards ? realArrayLastIndexOf : realArrayIndexOf).call(this, item, ...from);
      const asked = from.length ? Math.trunc(Number(from[0])) || 0 : backwards ? this.length - 1 : 0;
      const start = Math.max(0, Math.min(this.length - 1, asked < 0 ? this.length + asked : asked));
      const end = backwards ? -1 : this.length;
      chars += Math.abs((at < 0 ? end : at + (backwards ? -1 : 1)) - start) + 1;
    }
    return fn.call(this, item, ...from);
  };
}

function patch() {
  const saved = [[RegExp.prototype, "exec", RegExp.prototype.exec]];
  for (const name of ["indexOf", "includes", "lastIndexOf"]) saved.push([Array.prototype, name, Array.prototype[name]]);
  for (const name of [...WHOLE, ...RESULT, "indexOf", "includes", "lastIndexOf"]) {
    saved.push([String.prototype, name, String.prototype[name]]);
  }
  RegExp.prototype.exec = wrapExec(RegExp.prototype.exec);
  for (const name of WHOLE) String.prototype[name] = wrapWhole(String.prototype[name]);
  for (const name of RESULT) String.prototype[name] = wrapResult(String.prototype[name]);
  for (const name of ["indexOf", "includes"]) String.prototype[name] = wrapFind(String.prototype[name]);
  String.prototype.lastIndexOf = wrapFindBack(String.prototype.lastIndexOf);
  for (const name of ["indexOf", "includes"]) Array.prototype[name] = wrapArrayFind(Array.prototype[name], false);
  Array.prototype.lastIndexOf = wrapArrayFind(Array.prototype.lastIndexOf, true);
  return () => {
    for (const [owner, name, fn] of saved) owner[name] = fn;
  };
}

// V8 keeps each block's count in 32 bits, so a block run 2^32 times reads as a small number again. No block may run
// more than this many times in one counted call: a bigger count fails loudly instead of being read wrapped. The
// smaller call is held 64 times further under it (see workGrowth), so the bigger one can grow up to 64 times, well
// past a quadratic's 16, before a block could wrap.
const MOST_BLOCK_RUNS = 2 ** 31;

// Block counts since the last take, summed over the scripts named in `scripts`: a path covers that file or folder, a
// bare name (no folder) is a script a vm loaded under that name. Also the most times any one block ran.
function steps(coverage, scripts) {
  let sum = 0;
  let most = 0;
  for (const script of coverage.result) {
    const file = script.url.startsWith("file:") ? fileURLToPath(script.url) : script.url;
    if (!scripts.some((s) => file === s || file.startsWith(s + path.sep))) continue;
    for (const fn of script.functions) {
      for (const range of fn.ranges) {
        sum += range.count;
        most = Math.max(most, range.count);
      }
    }
  }
  return { sum, most };
}

// The work fn() does, counting steps in the extension's scripts and in any other files named (a bare name is a script a
// vm loaded under it). fn must finish before it returns: anything it leaves to run later isn't counted.
function work(fn, also = []) {
  const scripts = [EXTENSION, ...also].map((s) => (path.basename(s) === s ? s : path.resolve(s)));
  countEveryStep();
  const restore = patch();
  post("Profiler.takePreciseCoverage");
  chars = 0;
  execs = 0;
  on = true;
  let coverage;
  try {
    fn();
  } finally {
    on = false;
    restore();
    // Taken before the optimizers come back, so none of the call's code is optimized and loses its counts first.
    coverage = post("Profiler.takePreciseCoverage");
    optimizeAgain();
  }
  const { sum, most } = steps(coverage, scripts);
  if (most > MOST_BLOCK_RUNS) {
    throw new Error(`a block ran ${most} times, too near V8's 32-bit count to read: count smaller`);
  }
  return { steps: sum, chars, execs, most };
}

// The most any count may grow for 4 times the input. Linear work measured x3.4 to x4.8 on every count, and a loop over
// every pair or a pass per find measured x9.8 to x18 where it was most of the work, so 8 sits between them. A count
// doesn't move with the machine's load, so the limit needs no room for that.
const WORK_GROWTH = 8;

// How much each count grew from n units of input to 4n, each text new to the engine. The first call in a process
// counts differently, so a half-size input goes first and isn't measured.
// Making the input is counted too.
function workGrowth(fn, makeInput, unit, n, also = []) {
  fn(makeInput(unit, Math.ceil(n / 2)));
  const small = work(() => fn(makeInput(unit, n)), also);
  if (small.most > MOST_BLOCK_RUNS / 64) {
    throw new Error(
      `a block ran ${small.most} times at the smaller size, too many to count 4 times as much: count smaller`,
    );
  }
  const big = work(() => fn(makeInput(unit, n * 4)), also);
  return grewBy(small, big);
}

// How much each count grew from the small input to the big one, made beforehand. The caller warms the code up first.
function workRatio(fn, smallInput, bigInput, also = []) {
  return grewBy(
    work(() => fn(smallInput), also),
    work(() => fn(bigInput), also),
  );
}

function grewBy(small, big) {
  return {
    steps: big.steps / Math.max(1, small.steps),
    chars: big.chars / Math.max(1, small.chars),
    execs: big.execs / Math.max(1, small.execs),
  };
}

// The counts in a ratio that went over the limit, as "chars x12.3", or "" when none did.
function overLimit(grew, limit) {
  return Object.entries(grew)
    .filter(([, times]) => times > limit)
    .map(([count, times]) => `${count} x${times.toFixed(1)}`)
    .join(", ");
}

// 4 times the input may make at most `limit` times any count, for each unit, with steps counted in this file's caller
// too when it's named in `also`. A slowdown in a small part of a big call is diluted, and backtracking inside one
// regex run isn't counted, so a test whose old slowdown this misses keeps its clock check.
function assertWorkLinear(fn, makeInput, units, n = 8000, limit = WORK_GROWTH, also = []) {
  for (const unit of units) {
    const shown = overLimit(workGrowth(fn, makeInput, unit, n, also), limit);
    assert.ok(!shown, `${JSON.stringify(unit)}: work grew too much for 4× the input: ${shown}`);
  }
}

// A stand-in for Date.now while fn runs that moves only with the characters read, so detect()'s 10 s backstop trips
// on a rule that reads far too much but never on a busy machine. The 300 KB scans in the engine tests read about 58
// million characters, about 170 ms here, so at 30,000 a millisecond (a device ten times slower) they use under 2 s.
const CHARS_PER_MS = 30_000;
function onWorkClock(fn) {
  const realNow = Date.now;
  const start = realNow();
  const restore = patch();
  chars = 0;
  on = true;
  Date.now = () => start + Math.floor(chars / CHARS_PER_MS);
  try {
    return fn();
  } finally {
    on = false;
    restore();
    Date.now = realNow;
  }
}

module.exports = { work, workGrowth, workRatio, overLimit, assertWorkLinear, onWorkClock, WORK_GROWTH };

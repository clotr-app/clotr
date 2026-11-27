// How the phone rule's cost grows on a long paste of Prometheus-style metric lines ('m_total{a="b"} 4155550134').
// Every line holds a phone-shaped number, so every line is a candidate the rule has to clear. Clearing one by
// walking every metric line in the text made the rule grow with the square of the paste.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
// The work meter counts steps only in code loaded after it, so it comes before the engine. The meter can't see into a
// vm context, so the growth test reads the engine loaded here.
const { assertWorkLinear } = require("./work.js");
require("./load-engine.js")("rules", "detect");

// The engine from `dir` in a context of its own, the way tests/decide.test.js loads it, so this test runs in the
// public repo too. The context comes back as well, for the test that counts what the rule does there.
function engineContext(dir = path.join(__dirname, "..", "extension")) {
  const quiet = { info() {}, log() {}, warn() {}, error() {} };
  const context = vm.createContext({ console: quiet, URLSearchParams, TextEncoder, TextDecoder });
  // A folder without the engine's list (an older copy) has the three old files.
  const { GROUPS, engineFiles } = require("../tools/engine-files.js");
  for (const f of engineFiles(GROUPS, dir)) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  return { context, Clotr: vm.runInContext("globalThis.Clotr", context) };
}

const UNIT = 'm_total{a="b"} 4155550134\n';
const metricText = (kb) => UNIT.repeat(Math.ceil((kb * 1024) / UNIT.length)).slice(0, kb * 1024);
const SIZES = [40, 80, 160, 320, 640];

const phoneRule = (Clotr) => Clotr.PATTERNS.find((p) => p.id === "phone_number").find;

function median(fn, runs = 5) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    fn();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[runs >> 1];
}

// The rule's median time at each size, handed the whole text, the way the reader-growth tests time it.
function timesAt(find) {
  const texts = SIZES.map(metricText);
  find(texts[0]);
  return texts.map((text) => median(() => find(text)));
}

// Counted (tests/work.js), 4 times the text may make at most WORK_GROWTH times the work. The rule measured x4.3 to
// x4.9 on the three counts here, and a walk over every line for each candidate x15.1 to x15.9.
test("the phone rule grows with a metric-line paste, not its square", () => {
  assertWorkLinear(phoneRule(globalThis.Clotr), (_unit, kb) => metricText(kb), ["metric lines"], 160, undefined, [
    __filename,
  ]);
});

// Counting what the rule does doesn't depend on the machine's load. On one window of detect()'s scan, the rule
// clears each line's number with one look-up instead of a fresh scan of the text around it.
test("the phone rule's work on one window of metric lines stays near the line count", () => {
  const { context, Clotr } = engineContext();
  const find = phoneRule(Clotr);
  const text = metricText(40);
  const proto = vm.runInContext("RegExp.prototype", context);
  const exec = proto.exec;
  let runs = 0;
  proto.exec = function (s) {
    runs++;
    return exec.call(this, s);
  };
  let found;
  try {
    found = find(text);
  } finally {
    proto.exec = exec;
  }
  assert.equal(found.length, 0);
  // 1,576 lines. Live 1.6.1, which doesn't know metric lines, makes about 115,000 runs here.
  assert.ok(runs < 100000, `${runs} regular expression runs on 40 KB of metric lines`);
});

// With CLOTR_LIVE_ENGINE set to a folder holding live's engine files, the tip's growth is
// also held to live's on the same machine. Without it this check is skipped.
const liveDir = process.env.CLOTR_LIVE_ENGINE;
test("the phone rule grows no faster than live's", { skip: !liveDir && "CLOTR_LIVE_ENGINE isn't set" }, () => {
  const tip = phoneRule(engineContext().Clotr);
  const live = phoneRule(engineContext(path.resolve(liveDir)).Clotr);
  let ok = false;
  let rows = "";
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    const t = timesAt(tip);
    const l = timesAt(live);
    ok = t[4] / t[0] <= 1.5 * (l[4] / l[0]);
    rows = SIZES.map((kb, i) => `${kb} KB tip ${t[i].toFixed(1)} live ${l[i].toFixed(1)}`).join(", ");
  }
  assert.ok(ok, `tip grew faster than live: ${rows}`);
});

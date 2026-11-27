"use strict";

// Guard's deadline tests on a made-up clock: Date.now reads the real time plus every wait a test skips, so a wait of
// seconds costs the test none, and Guard's deadlines are reached just as they would be.

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { HOOK_CHECK_MAX_MS } = require("../apps/guard/lib/limits-and-messages.js");

const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
const inGuardCode = (key) => key.startsWith(path.join(GUARD_DIR, "lib")) || key.startsWith(path.join(GUARD_DIR, "bin"));

// Runs `fn(clock)` with Date.now on the made-up clock. `clock.skip(ms)` moves it on as if `ms` had passed.
function onStandInClock(fn) {
  const realNow = Date.now;
  let skipped = 0;
  const clock = { now: () => realNow() + skipped, skip: (ms) => (skipped += ms) };
  Date.now = clock.now;
  try {
    return fn(clock);
  } finally {
    Date.now = realNow;
  }
}

// What a process ended at its timeout gives back, for spawnSync and execFileSync.
function timedOut(command, options = {}) {
  const error = Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: "ETIMEDOUT" });
  const empty = options.encoding && options.encoding !== "buffer" ? "" : Buffer.alloc(0);
  return { pid: 0, output: [null, empty, empty], stdout: empty, stderr: empty, status: null, signal: "SIGKILL", error };
}

// Guard's code (lib and bin) loaded fresh, with spawnSync and execFileSync standing in for a process that takes
// `waitFor(command, args)` ms (0 or undefined: at once) before it runs as usual. A wait past the call's timeout ends
// there, as Node ends a process at its timeout, and the clock moves on by the timeout instead. `env` (optional) is
// given to every process started. Returns `load(file)`, a require of a Guard file, and `calls`, the commands started.
function guardWithSlowProcesses(clock, waitFor, env) {
  const real = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync };
  const calls = [];
  const slow = (name) =>
    function (command, args, options = {}) {
      calls.push(path.basename(String(command)));
      const opts = env ? { ...options, env } : options;
      const wait = waitFor(String(command), args || []) || 0;
      const timeout = options.timeout > 0 ? options.timeout : Infinity;
      if (wait >= timeout) {
        clock.skip(timeout);
        const result = timedOut(command, options);
        if (name === "execFileSync") throw Object.assign(result.error, { status: null, signal: "SIGKILL" });
        return result;
      }
      clock.skip(wait);
      return real[name].call(childProcess, command, args, opts);
    };
  const dropped = new Map(Object.entries(require.cache).filter(([key]) => inGuardCode(key)));
  for (const key of dropped.keys()) delete require.cache[key];
  childProcess.spawnSync = slow("spawnSync");
  childProcess.execFileSync = slow("execFileSync");
  const loaded = {};
  try {
    for (const file of [
      "lib/hooks/file-read-check.js",
      "lib/search-checks/search-check.js",
      "lib/check-budget.js",
      "bin/clotr-guard.js",
    ]) {
      loaded[file] = require(path.join(GUARD_DIR, file));
    }
  } finally {
    Object.assign(childProcess, real);
    for (const key of Object.keys(require.cache).filter(inGuardCode)) delete require.cache[key];
    for (const [key, entry] of dropped) require.cache[key] = entry;
  }
  return { load: (file) => loaded[file], calls };
}

// Code for a hook's --require preload that moves its clock for timers. The hook's only timers longer than 5 seconds
// are its deadline's, so "now" makes the deadline come at once, and "never" makes it never come: a hook that still
// answers did so without it.
const DEADLINE_PRELOAD = {
  now: `{ const real = setTimeout; globalThis.setTimeout = (fn, ms, ...rest) => real(fn, ms > 5000 ? 0 : ms, ...rest); }`,
  never: `{ const real = setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => (ms > 5000 ? real(() => {}, 2 ** 31 - 1).unref() : real(fn, ms, ...rest)); }`,
};

// Preload code, put after DEADLINE_PRELOAD so it sees the length Guard asked for, that writes down in `file` when the
// hook exits each timer over 5 seconds it set (`asked`, and `ranAt`, ms from its start or null) and `exitAt`. A process
// the hook starts with -e writes nothing.
function recordLongTimers(file) {
  return `if (typeof process._eval !== "string") {
  const real = setTimeout; const timers = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (!(ms > 5000)) return real(fn, ms, ...rest);
    const timer = { asked: ms, ranAt: null }; timers.push(timer);
    return real((...args) => { timer.ranAt = performance.now(); return fn(...args); }, ms, ...rest);
  };
  process.on("exit", () => require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({ timers, exitAt: performance.now() })));
}`;
}

// How long after its deadline a hook may take to answer and exit, as in the real-clock test's 10 to 11 seconds.
const AFTER_DEADLINE_MS = 1000;

// What recordLongTimers wrote in `file`, or null when the hook wrote nothing.
const readLongTimers = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

// Checks what recordLongTimers wrote (`recorded`): the hook set a deadline, none of its long timers asked for more than
// HOOK_CHECK_MAX_MS, and, given `ran`, the deadline came and the hook exited within AFTER_DEADLINE_MS of it.
function assertDeadlineKept(recorded, label, { ran }) {
  assert.ok(recorded, `${label}: the hook wrote no timers`);
  const { timers, exitAt } = recorded;
  assert.ok(timers.length > 0, `${label}: the hook set no deadline`);
  for (const { asked } of timers) assert.ok(asked <= HOOK_CHECK_MAX_MS, `${label}: a deadline ${asked} ms away`);
  if (!ran) return;
  const deadline = timers.find((timer) => timer.ranAt !== null);
  assert.ok(deadline, `${label}: the deadline didn't come`);
  const late = exitAt - deadline.ranAt;
  assert.ok(late < AFTER_DEADLINE_MS, `${label}: exited ${Math.round(late)} ms after its deadline`);
}

module.exports = {
  onStandInClock,
  guardWithSlowProcesses,
  DEADLINE_PRELOAD,
  recordLongTimers,
  readLongTimers,
  assertDeadlineKept,
  GUARD_DIR,
};

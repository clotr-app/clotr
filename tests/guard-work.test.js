// Guard growth tests that count the work instead of timing it (tests/work.js). They live in their own file because
// the meter keeps V8's block counting on until the process ends, and with it on Guard runs slower, more so on bigger
// input, so a clock test beside them would see growth that isn't Guard's. Clock tests don't belong here.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The work meter counts steps only in code loaded after it, so it comes before Guard.
const { workGrowth, WORK_GROWTH } = require("./work.js");
const {
  quotedSeparatorShell,
  blankSpaceCommands,
  dottedOperandCommands,
  quotedRunCommands,
} = require("./guard-shell.js");

const GUARD = path.join(__dirname, "..", "apps", "guard");

// Guard loads the engine from its own bundle, which npm's prepack builds; build it here when it's missing.
if (!fs.existsSync(path.join(GUARD, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-work-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs fn on a clock that stands still, so a check slowed by the meter never reaches a deadline and is counted whole.
function onAStoppedClock(fn) {
  const realNow = Date.now;
  const now = realNow();
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

// How much each named count grew from `size` units of input to 4 times that, in Guard's own code. Fails when any
// grew more than WORK_GROWTH (8): linear work measured x3.4 to x4.8, a pass per find x9.8 to x18. A count can't see
// backtracking inside one regex run, so the tests written for a slow pattern keep a clock check in their own file.
function assertGuardWorkLinear(label, fn, size, counts = ["steps", "chars", "execs"]) {
  const grew = workGrowth(
    (n) => onAStoppedClock(() => fn(n)),
    (_unit, n) => n,
    null,
    size,
    [GUARD],
  );
  const over = counts.filter((count) => grew[count] > WORK_GROWTH);
  const shown = over.map((count) => `${count} x${grew[count].toFixed(1)}`).join(", ");
  assert.ok(!over.length, `${label}: work grew too much for 4× the input: ${shown}`);
}

// The shell check reads each long quoted run (tests/guard-shell.js) of 75,000 characters at most 8 times as hard as
// one a quarter of its size, and still gives its answer at that size. Its clock growth is in tests/guard-hook-gaps.test.js.
test("a long quoted run takes work in step with its length", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const shell = quotedSeparatorShell(root);
  for (const [label, commandOf, toolName, action, counts] of quotedRunCommands()) {
    let outcome;
    assertGuardWorkLinear(label, (size) => (outcome = shell(commandOf(size), toolName)), 18_750, counts);
    assert.equal(outcome.action, action === "stop" ? "block" : action, label);
    if (action === "block") assert.equal(outcome.location, ".env", `${label} is stopped for .env`);
  }
});

// The counts beside the clock growth checks in tests/guard-hook-gaps.test.js for the same commands.
test("a long run of blank space before a shell reader takes work in step with its length", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const shell = quotedSeparatorShell(root);
  for (const [label, commandOf, toolName, size] of blankSpaceCommands()) {
    let outcome;
    assertGuardWorkLinear(label, (n) => (outcome = shell(commandOf(n), toolName)), size / 4);
    assert.equal(outcome.location, ".env", `${label} is stopped for .env`);
  }
});

test("an operand with a long run of dots, spaces or colons takes work in step with its length", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const shell = quotedSeparatorShell(root);
  for (const [label, commandOf, toolName] of dottedOperandCommands()) {
    let outcome;
    assertGuardWorkLinear(label, (n) => (outcome = shell(commandOf(n), toolName)), 75_000);
    assert.equal(outcome.location, ".env", `${label} is stopped for .env`);
  }
});

test("a run of unclosed `${` is read in linear time", (t) => {
  const root = tempDir(t);
  const shell = quotedSeparatorShell(root);
  const command = (n) => `cat a${"${a".repeat(n)}`;
  // Counted at 15,625 and 62,500 repeats, where a pass over the text every 64th character still fits V8's 32-bit block
  // counts (tests/work.js), then answered once at 250,000.
  assertGuardWorkLinear("unclosed ${", (n) => shell(command(n), "Bash"), 15_625);
  assert.equal(onAStoppedClock(() => shell(command(250_000), "Bash")).unfinished, undefined);
});

// Runs some of a test file's growth tests again in a child with CLOTR_WORK=1, where the file loads the work meter
// (tests/work.js) before the engine and its growth checks count work instead of timing it. The meter slows the
// engine more on bigger input, so it stays out of the process the clock checks run in.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const COUNTED = process.env.CLOTR_WORK === "1";

// The work meter when this process counts, or null when it times.
const meter = () => (COUNTED ? require("./work.js") : null);

// The child reports for itself, not to a test runner this process may be running under.
function childEnv() {
  const env = { ...process.env, CLOTR_WORK: "1" };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function assertCounted(file, names) {
  const exact = names.map((name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const run = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...exact.map((p) => `--test-name-pattern=${p}`), file],
    { encoding: "utf8", env: childEnv() },
  );
  const failing = run.stdout.split("\n").filter((line) => /^not ok|error:|grew too much/.test(line.trim()));
  assert.equal(run.status, 0, failing.join("\n") || run.stderr);
  assert.match(run.stdout, new RegExp(`^# pass ${names.length}$`, "m"), "not every counted test ran");
}

module.exports = { COUNTED, meter, assertCounted };

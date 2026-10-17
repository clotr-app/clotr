// A temp folder left behind by every run adds up: one run once left 50,523 of them (about 80 GB) because nothing
// removed its own. The first check below doesn't prove every mkdtemp is paired with the right rmSync in the right
// place, only the cheap, honest half of that: a file that makes one also removes one, somewhere in itself. The
// second actually runs a sample of the test files that make temp folders and checks the real thing: nothing named
// clotr-* left in TEMP once they're done, pass or fail.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f && f.endsWith(".js") && fs.existsSync(path.join(ROOT, f)));

test("a file that makes a temp folder (mkdtemp) also removes one (rmSync)", () => {
  const offenders = tracked()
    .filter((f) => !f.startsWith("node_modules/"))
    .filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      return /\bmkdtemp(Sync)?\(/.test(text) && !/\brmSync\(/.test(text);
    });
  assert.deepEqual(offenders, [], "these call mkdtemp but never rmSync, so every run leaves a folder behind");
});

// Run the tests that own the reported Node prefixes with TEMP pointed at a scratch folder of its own, so a leak
// here is unmistakably this run's, not something already sitting in the real TEMP from elsewhere.
test("reported temp-folder tests leave no clotr-* folder behind in TEMP", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-leak-sample-"));
  try {
    const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
    delete env.NODE_TEST_CONTEXT;
    const sample = ["tests/package.test.js", "tests/sign-chrome.test.js"];
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...sample], {
      cwd: ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `the sample itself failed:\n${r.stdout}\n${r.stderr}`);
    const left = fs.readdirSync(scratch).filter((n) => n.startsWith("clotr-"));
    assert.deepEqual(left, [], `left behind in TEMP: ${left.join(", ")}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});

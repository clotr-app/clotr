// How a commit check's cost grows with the size of one staged file.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
// The work meter counts steps only in code loaded after it, so it comes before Guard.
const { workGrowth, WORK_GROWTH } = require("./work.js");

const { execFileSync, spawnSync } = childProcess;
const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
}

// Git's start-up costs the same whatever the file's size, and it runs outside this process, where nothing is counted.
// Guard is loaded with a stand-in that runs each git command once and replays its answer after that, so the counted
// checks are Guard's own work on the staged lines.
let gitRuns = 0;
const gitAnswers = new Map();
childProcess.execFileSync = (file, args, options) => {
  const key = JSON.stringify([file, args, options?.cwd, options?.encoding]);
  if (!gitAnswers.has(key)) {
    gitRuns++;
    gitAnswers.set(key, execFileSync(file, args, options));
  }
  return gitAnswers.get(key);
};
const { checkStaged } = require("../apps/guard/bin/clotr-guard.js");
const { engineContext } = require("../apps/guard/lib/text-checks/engine-loader.js");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

// One repository per size, each with one staged file of that many lines, made once.
function stagedRepos(t) {
  const repos = new Map();
  return (count) => {
    if (repos.has(count)) return repos.get(count);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(dir, ["init", "-q"]);
    const lines = Array.from({ length: count }, (_, i) => `const value${i} = "setting ${i}";`);
    fs.writeFileSync(path.join(dir, "big.js"), `${lines.join("\n")}\n`);
    git(dir, ["add", "big.js"]);
    repos.set(count, dir);
    return dir;
  };
}

// The work of a staged check on 200 added lines against 800, counted in Guard's own code, this file's (where the
// planted scan below runs) and the engine's, each without the engine's kept answer, so a repeat isn't counted as a
// cache hit. The engine runs in a vm context under its bundle's name, where the meter counts its steps but not its
// string and regex work, which has that context's own methods.
const LINES = 200;
function stagedWorkGrowth(t) {
  const repoOf = stagedRepos(t);
  const check = (count) => {
    engineContext().Clotr.detect.forget();
    checkStaged({ cwd: repoOf(count) });
  };
  for (const count of [LINES / 2, LINES, LINES * 4]) check(count);
  const before = gitRuns;
  const grew = workGrowth(check, (_unit, count) => count, null, LINES, [GUARD_DIR, __filename, "clotr-engine.js"]);
  assert.equal(gitRuns, before, "the counted checks ran git");
  return grew;
}

const grewTooMuch = (grew) => Object.entries(grew).filter(([, times]) => times > WORK_GROWTH);
const shown = (grew) =>
  Object.entries(grew)
    .map(([count, times]) => `${count} x${times.toFixed(1)}`)
    .join(", ");

test("a staged file's check grows with its added lines, not their square", (t) => {
  assert.ok(LINES * 4 * 40 <= engineContext().Clotr.DETECT_WINDOW_CHARS, "the bigger file fits in one scanned window");
  const grew = stagedWorkGrowth(t);
  assert.deepEqual(grewTooMuch(grew), [], `staged check work grew too much for 4× the file: ${shown(grew)}`);
});

// Each added line here costs work that grows with the number of added lines, so the scan is quadratic.
test("the staged growth check fails a scan that is quadratic in the added lines", (t) => {
  const Clotr = engineContext().Clotr;
  const detect = Clotr.detect;
  let sink = 0;
  Clotr.detect = Object.assign((text, ...rest) => {
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
      for (let k = 0; k < at; k++) sink += text.charCodeAt(k);
    }
    return detect(text, ...rest);
  }, detect);
  t.after(() => {
    Clotr.detect = detect;
  });
  const grew = stagedWorkGrowth(t);
  assert.ok(grewTooMuch(grew).length, `a quadratic scan passed (${shown(grew)}, ${sink})`);
});

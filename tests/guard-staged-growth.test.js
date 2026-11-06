// How a commit check's cost grows with the size of one staged file.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

const { execFileSync, spawnSync } = childProcess;
const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
}

// Git's start-up, three processes of about 70 ms in all, costs the same whatever the file's size, next to a few
// milliseconds of Guard's own work, so timing whole checks could never fail: even a cubic scan stayed under the limit
// until it took seconds. Guard is loaded with a stand-in that runs each git command once and replays its answer after
// that, so the timed checks measure Guard's own work on the staged lines.
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
const { engineContext } = require("../apps/guard/lib/engine.js");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

// One repository per size, each with one staged file of that many lines.
function stagedRepos(t, sizes) {
  const repos = {};
  for (const [name, count] of Object.entries(sizes)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(dir, ["init", "-q"]);
    const lines = Array.from({ length: count }, (_, i) => `const value${i} = "setting ${i}";`);
    fs.writeFileSync(path.join(dir, "big.js"), `${lines.join("\n")}\n`);
    git(dir, ["add", "big.js"]);
    repos[name] = dir;
  }
  return repos;
}

// Each timed check starts without the engine's kept answer, so a repeat isn't timed as a cache hit.
const timed = (dir) => () => {
  engineContext().Clotr.detect.forget();
  checkStaged({ cwd: dir });
};

// 8 times the lines, so linear work grows about 8 times (about 5 measured, with the check's fixed costs) and quadratic
// work about 64 times (35 to 39 measured with the scan planted below). The limit of 16 sits more than twice away from
// both on a busy machine. With 4 times the lines and a limit of 10, the planted quadratic measured 13 to 15 and went
// under the limit on 2 runs in 7.
const GROWTH = 8;
const LIMIT = 16;

function stagedCheckGrew(repos) {
  return grewEveryTime(
    () => bestOfPair(timed(repos.small), timed(repos.big), GROWTH),
    (small, big) => grewMoreThan(small, big, LIMIT),
  );
}

// Both files fit in one window of the engine's scan (about 2.5 KB and 22 KB), since a text past one window costs about
// twice as much per character, which would read as growth on its own.
const SIZES = { small: 100, big: 100 * GROWTH };

test("a staged file's check grows with its added lines, not their square", (t) => {
  const repos = stagedRepos(t, SIZES);
  assert.ok(
    fs.statSync(path.join(repos.big, "big.js")).size <= engineContext().Clotr.DETECT_WINDOW_CHARS,
    "the bigger file fits in one scanned window",
  );
  checkStaged({ cwd: repos.small });
  checkStaged({ cwd: repos.big });
  const before = gitRuns;
  assert.ok(!stagedCheckGrew(repos), `staged checks grew too fast for ${GROWTH}× the file`);
  assert.equal(gitRuns, before, "the timed checks ran git");
});

// Each added line here costs work that grows with the number of added lines, so the scan is quadratic, and on the
// smaller file that work already costs a few times the rest of the check. The scan rereads the text before each line
// rather than splitting it again: work that only reads holds the same growth on a busy machine, while the time to
// build thousands of arrays varied enough under load that the growth sometimes fell under the limit.
test("the staged growth check fails a scan that is quadratic in the added lines", (t) => {
  const repos = stagedRepos(t, SIZES);
  const Clotr = engineContext().Clotr;
  const detect = Clotr.detect;
  let sink = 0;
  Clotr.detect = Object.assign((text, ...rest) => {
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
      for (let pass = 0; pass < 6; pass++) for (let k = 0; k < at; k++) sink += text.charCodeAt(k);
    }
    return detect(text, ...rest);
  }, detect);
  t.after(() => {
    Clotr.detect = detect;
  });
  assert.ok(stagedCheckGrew(repos), `a quadratic scan passed (${sink})`);
});

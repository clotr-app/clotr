// A Git that doesn't answer (a network drive, a huge repository, a credential window that never shows) can't hold
// Guard's hooks past their time: each Git call has a limit, the late Git is ended, and the person is told. Made-up
// values only.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GUARD_ENGINE = path.join(__dirname, "..", "apps", "guard", "dist", "clotr-engine.js");
if (!fs.existsSync(GUARD_ENGINE)) {
  const { build } = require("../tools/engine-bundle.js");
  fs.mkdirSync(path.dirname(GUARD_ENGINE), { recursive: true });
  fs.writeFileSync(GUARD_ENGINE, build().text);
}
const SCRIPT = path.join(__dirname, "..", "apps", "guard", "bin", "clotr-guard.js");
const { GIT_TIMEOUT_MS, HOOK_CHECK_MAX_MS, SEARCH_WALK_MAX_MS } = require("../apps/guard/lib/limits-and-messages.js");
const { onStandInClock, guardWithSlowProcesses } = require("./guard-stand-in-clock.js");

// Two late Git calls at 2 seconds each, plus Node starting the hook and its shell check on a busy machine.
const ANSWER_WITHIN_MS = 8000;
// The stand-in Git waits far longer than any hook may, so a hook with no limit on Git is plainly late.
const STAND_IN_WAIT_MS = 30000;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A folder holding a `git` that is Node itself, which waits and never answers. NODE_OPTIONS loads the wait only into a
// process started as `git`, and each one writes its process id beside it so the test can see it was ended. Given
// `realGit`, it waits `waitMs` and then runs the real Git with the same arguments, like a Git slow to start.
function slowGit(t, { waitMs = STAND_IN_WAIT_MS, realGit } = {}) {
  // Removed after the stand-ins are ended (below), since the after hooks run in the order they were added.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-slow-git-"));
  const git = path.join(bin, process.platform === "win32" ? "git.exe" : "git");
  try {
    fs.linkSync(process.execPath, git);
  } catch {
    fs.copyFileSync(process.execPath, git);
  }
  fs.chmodSync(git, 0o755);
  const slow = path.join(bin, "slow.js");
  fs.writeFileSync(
    slow,
    `if (/^git(?:\\.exe)?$/i.test(require("path").basename(process.execPath))) {
  require("fs").writeFileSync(require("path").join(${JSON.stringify(bin)}, "pid-" + process.pid), "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${waitMs});
  const realGit = ${JSON.stringify(realGit || null)};
  if (realGit) {
    // Node takes the Git command for its script's name, so the command is that name's last part.
    const args = [require("path").basename(process.argv[1]), ...process.argv.slice(2)];
    const ran = require("child_process").spawnSync(realGit, args, { stdio: "inherit" });
    process.exit(ran.status ?? 1);
  }
}
`,
  );
  const pids = () =>
    fs
      .readdirSync(bin)
      .filter((name) => name.startsWith("pid-"))
      .map((name) => Number(name.slice(4)));
  // Any stand-in still running when the test ends is ended here, so a failing run leaves nothing behind.
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { bin, slow, pids };
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function environment(t, git) {
  const home = tempDir(t, "clotr-git-home-");
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
  env.XDG_DATA_HOME = path.join(home, "data");
  env.XDG_STATE_HOME = path.join(home, "state");
  env.GIT_TERMINAL_PROMPT = "0";
  delete env.NODE_TEST_CONTEXT;
  if (git) {
    env.PATH = `${git.bin}${path.delimiter}${process.env.PATH}`;
    env.NODE_OPTIONS = `--require ${JSON.stringify(git.slow)}`;
  }
  return env;
}

// Runs Guard once and says how long it took. The 15 seconds are the assistants' own limit on a hook.
function runGuard(args, { cwd, env, input }) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 15000,
    killSignal: "SIGKILL",
  });
  return { ...result, elapsed: Date.now() - started };
}

function noteOf(stdout) {
  try {
    return JSON.parse(stdout || "{}").systemMessage || "";
  } catch {
    return "";
  }
}

const LATE = /Git didn't answer in time/;

test("the prompt hook answers in time when Git doesn't answer, and says so", (t) => {
  const folder = tempDir(t, "clotr-git-folder-");
  const git = slowGit(t);
  const result = runGuard(["hook", "claude"], {
    cwd: folder,
    env: environment(t, git),
    input: JSON.stringify({ prompt: "What does this function do?", cwd: folder }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsed < ANSWER_WITHIN_MS, `answered in ${result.elapsed} ms`);
  assert.match(noteOf(result.stdout), LATE);
  assert.doesNotMatch(result.stdout, /"decision"/);
  assert.ok(git.pids().length > 0, "the stand-in Git was asked");
  for (const pid of git.pids()) assert.equal(running(pid), false, `Git ${pid} was left running`);
});

test("the shell hook answers in time when Git doesn't answer, and lets a plain command through with a note", (t) => {
  const folder = tempDir(t, "clotr-git-folder-");
  const git = slowGit(t);
  const result = runGuard(["shell", "claude"], {
    cwd: folder,
    env: environment(t, git),
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hello" }, cwd: folder }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsed < ANSWER_WITHIN_MS, `answered in ${result.elapsed} ms`);
  assert.match(noteOf(result.stdout), LATE);
  assert.doesNotMatch(result.stdout, /"deny"/);
  assert.ok(git.pids().length > 0, "the stand-in Git was asked");
  for (const pid of git.pids()) assert.equal(running(pid), false, `Git ${pid} was left running`);
});

test("the shell hook still stops a secret read when Git doesn't answer", (t) => {
  const folder = tempDir(t, "clotr-git-folder-");
  fs.writeFileSync(path.join(folder, ".env"), "PLACEHOLDER=1\n");
  const git = slowGit(t);
  const result = runGuard(["shell", "claude"], {
    cwd: folder,
    env: environment(t, git),
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat .env" }, cwd: folder }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsed < ANSWER_WITHIN_MS, `answered in ${result.elapsed} ms`);
  assert.match(result.stdout, /"deny"/);
});

test("with a Git that answers, the hooks add no note about Git", (t) => {
  const folder = tempDir(t, "clotr-git-folder-");
  const env = environment(t, null);
  const prompt = runGuard(["hook", "claude"], {
    cwd: folder,
    env,
    input: JSON.stringify({ prompt: "What does this function do?", cwd: folder }),
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.doesNotMatch(prompt.stdout, LATE);
  const shell = runGuard(["shell", "claude"], {
    cwd: folder,
    env,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hello" }, cwd: folder }),
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.doesNotMatch(shell.stdout, LATE);
});

test("commit-check stops the commit and says why when Git doesn't answer", (t) => {
  const repo = tempDir(t, "clotr-git-repo-");
  const plain = environment(t, null);
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: repo, env: plain }).status, 0, args.join(" "));
  }
  fs.writeFileSync(path.join(repo, "notes.txt"), "nothing to see\n");
  assert.equal(spawnSync("git", ["add", "notes.txt"], { cwd: repo, env: plain }).status, 0);
  // The same commit passes with a Git that answers.
  const normal = runGuard(["commit-check"], { cwd: repo, env: plain });
  assert.equal(normal.status, 0, normal.stderr);
  const git = slowGit(t);
  const result = runGuard(["commit-check"], { cwd: repo, env: environment(t, git) });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.elapsed < ANSWER_WITHIN_MS, `answered in ${result.elapsed} ms`);
  assert.match(result.stderr, LATE);
  assert.match(result.stderr, /stopped/);
  for (const pid of git.pids()) assert.equal(running(pid), false, `Git ${pid} was left running`);
});

// The real Git on PATH, for a stand-in that is only slow to start.
function realGitPath() {
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (dir && fs.existsSync(file)) return file;
    }
  }
  return null;
}

// A small Git project whose .env is git-ignored, so a content search there can't read it.
function smallProject(t) {
  const repo = tempDir(t, "clotr-git-search-");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo, env: environment(t, null) }).status, 0);
  fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER=1\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(repo, "app.js"), "// PLACEHOLDER\n");
  return repo;
}

const geminiSearch = (repo) =>
  JSON.stringify({
    tool_name: "search_file_content",
    tool_input: { pattern: "PLACEHOLDER", dir_path: repo },
    cwd: repo,
  });

const HELD = /ran out of time/;

// A search let through because its check couldn't finish says so; one whose check finished says nothing about it.
const UNCHECKED = /went through|couldn't finish/;

// The read hook's search, run here on the made-up clock, with every Git call `waitMs` slow. Gives its answer as the
// hook prints it, the time it took on that clock, Git's part of that time, the real time it took in ms, and how many
// times Git was started. Only Git waits, so every move of the clock is Git's time.
function searchOnStandInClock(t, repo, waitMs) {
  const env = environment(t, null);
  const isGit = (command) => /^git(\.exe)?$/i.test(path.basename(command));
  return onStandInClock((clock) => {
    let gitMs = 0;
    const counted = {
      now: clock.now,
      skip: (ms) => {
        gitMs += ms;
        return clock.skip(ms);
      },
    };
    const { load, calls } = guardWithSlowProcesses(counted, (command) => (isGit(command) ? waitMs : 0), env);
    const guard = load("bin/clotr-guard.js");
    // The read check's own file, loaded with the slow Git: the bin loads it only when a check first runs.
    const read = load("lib/hooks/file-read-check.js");
    const realStart = performance.now();
    const startedAt = Date.now();
    const outcome = read.inspectRead("gemini", JSON.parse(geminiSearch(repo)), { startedAt, cwd: repo });
    const elapsed = Date.now() - startedAt;
    const realMs = Math.round(performance.now() - realStart);
    const { stdout } = guard.readHookOutput("gemini", outcome);
    return { stdout, elapsed, gitMs, realMs, gitStarts: calls.filter(isGit).length };
  });
}

// What a search's answer was, in a word: let through unchecked, held for time, stopped, or let through after its check.
function answerOf(stdout) {
  if (UNCHECKED.test(stdout)) return "through unchecked";
  if (HELD.test(stdout)) return "held";
  return /"deny"/.test(stdout) ? "stopped" : "checked";
}

// What a failure shows: Git's time on the made-up clock, the answer, and the real time.
const seen = (result) =>
  `Git ${result.gitMs} ms in ${result.gitStarts} starts on the made-up clock, ` +
  `search ${result.elapsed} ms there, answer ${answerOf(result.stdout)}, real ${result.realMs} ms`;

// The same small project with a few plain source files beside its one secret file, so a search walks more than one
// file but has only `.env` to ask Git about.
function smallProjectWithSources(t) {
  const repo = smallProject(t);
  for (let file = 0; file < 8; file++) fs.writeFileSync(path.join(repo, `part${file}.js`), "// nothing secret\n");
  return repo;
}

// Git's slowness is judged on the made-up clock, so a process the computer starts late isn't counted as Git's. Each
// search asks Git once, about `.env`, and its 300 ms are well inside Guard's 2 seconds, so all 10 are checked.
test("a content search in a small Git project is checked when Git is slow to start", (t) => {
  const repo = smallProjectWithSources(t);
  for (let ask = 0; ask < 10; ask++) {
    const result = searchOnStandInClock(t, repo, 300);
    assert.ok(result.gitStarts > 0, `the slow Git was asked: ${seen(result)}`);
    assert.equal(answerOf(result.stdout), "checked", `search ${ask + 1} of 10: ${seen(result)}`);
    assert.ok(result.gitMs < GIT_TIMEOUT_MS, `search ${ask + 1} of 10: ${seen(result)}`);
  }
  // One real run, with the real hook and a real stand-in Git: it may be held for time on a busy computer, but a
  // search is never let through unchecked.
  const realGit = realGitPath();
  assert.ok(realGit, "Git is on PATH");
  const git = slowGit(t, { waitMs: 300, realGit });
  const real = runGuard(["read", "gemini"], { cwd: repo, env: environment(t, git), input: geminiSearch(repo) });
  assert.equal(real.status, 0, real.stderr);
  assert.ok(git.pids().length > 0, "the stand-in Git was asked");
  const answer = answerOf(real.stdout);
  assert.ok(["checked", "held"].includes(answer), `real run: answer ${answer} in ${real.elapsed} ms`);
});

// A Git project with a git-ignored `.env` at its root and a `config/.env.production` that isn't ignored.
function mixedProject(t) {
  const repo = smallProject(t);
  fs.writeFileSync(path.join(repo, ".gitignore"), "/.env\n");
  fs.mkdirSync(path.join(repo, "config"));
  fs.writeFileSync(path.join(repo, "config", ".env.production"), "PLACEHOLDER=1\n");
  return repo;
}

// Each search asks Git about `.env` and then `config/.env.production`. On the made-up clock a Git 300 ms slow leaves
// both asks inside Guard's 2 seconds, so the search is stopped and the file named; at 1000 or 1900 ms the asks reach
// the 2 seconds and the search may be held for time. Either way it ends inside the walk's own time plus Guard's 2
// seconds of waiting on Git, and it is never let through.
for (const waitMs of [300, 1000, 1900]) {
  test(`with a Git ${waitMs} ms slow, a search that reaches a secret file is stopped or held, never let through`, (t) => {
    const repo = mixedProject(t);
    // With a Git that answers at once, the search is stopped and the file named.
    const normal = runGuard(["read", "gemini"], { cwd: repo, env: environment(t, null), input: geminiSearch(repo) });
    assert.match(normal.stdout, /"deny"/);
    assert.match(normal.stdout, /config\/\.env\.production/);
    const result = searchOnStandInClock(t, repo, waitMs);
    assert.ok(result.gitStarts > 0, `the slow Git was asked: ${seen(result)}`);
    const answers = waitMs === 300 ? ["stopped"] : ["stopped", "held"];
    assert.ok(answers.includes(answerOf(result.stdout)), seen(result));
    if (!HELD.test(result.stdout)) assert.match(result.stdout, /config\/\.env\.production/, seen(result));
    assert.ok(result.elapsed < SEARCH_WALK_MAX_MS + GIT_TIMEOUT_MS, seen(result));
    // One real run, with the real hook and a real stand-in Git: stopped or held, never let through.
    const realGit = realGitPath();
    assert.ok(realGit, "Git is on PATH");
    const git = slowGit(t, { waitMs, realGit });
    const real = runGuard(["read", "gemini"], { cwd: repo, env: environment(t, git), input: geminiSearch(repo) });
    assert.equal(real.status, 0, real.stderr);
    assert.ok(git.pids().length > 0, "the stand-in Git was asked");
    const answer = answerOf(real.stdout);
    assert.ok(["stopped", "held"].includes(answer), `real run: answer ${answer} in ${real.elapsed} ms`);
  });
}

test("a content search is still held when Git doesn't answer, inside the hook's own limit", (t) => {
  const repo = smallProject(t);
  const git = slowGit(t);
  const result = runGuard(["read", "gemini"], { cwd: repo, env: environment(t, git), input: geminiSearch(repo) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsed < HOOK_CHECK_MAX_MS, `answered in ${result.elapsed} ms`);
  assert.match(result.stdout, /"deny"/);
  assert.match(result.stdout, HELD);
  for (const pid of git.pids()) assert.equal(running(pid), false, `Git ${pid} was left running`);
});

test("a search over many git-ignored secret files with a slow Git is held or checked inside the hook's own limit", (t) => {
  const repo = smallProject(t);
  for (let folder = 0; folder < 8; folder++) {
    fs.mkdirSync(path.join(repo, `svc${folder}`));
    fs.writeFileSync(path.join(repo, `svc${folder}`, ".env"), "PLACEHOLDER=1\n");
  }
  const result = searchOnStandInClock(t, repo, 1900);
  assert.ok(result.gitStarts > 0, "the slow Git was asked");
  assert.doesNotMatch(result.stdout, UNCHECKED);
  assert.ok(result.elapsed < HOOK_CHECK_MAX_MS, `answered in ${result.elapsed} ms`);
});

// A `git` that is a shell script: it sleeps `waitMs`, then runs the real Git. It starts in a few milliseconds, so the
// Git it stands in for is slow by about `waitMs` and no more. Only on systems with `sh`.
function shellSlowGit(t, waitMs, realGit) {
  const bin = tempDir(t, "clotr-sh-git-");
  const git = path.join(bin, "git");
  fs.writeFileSync(git, `#!/bin/sh\nsleep ${waitMs / 1000}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  fs.chmodSync(git, 0o755);
  return bin;
}

// A Git project with `count` git-ignored `.env` files, one per folder, and nothing a search can reach.
function manyIgnoredProject(t, count) {
  const repo = smallProject(t);
  fs.rmSync(path.join(repo, ".env"));
  for (let folder = 0; folder < count; folder++) {
    const dir = path.join(repo, `s${String(folder).padStart(3, "0")}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".env"), "PLACEHOLDER=1\n");
  }
  return repo;
}

// A search over many git-ignored secret files waits on Git 2 seconds at most in all, then is answered the way 0.1.3
// answers it. 0.1.3's own walk stops after its 250 ms, so its time is about the time of the same search over one
// ignored file plus that 250 ms. The search here takes no more than that and Guard's 2 seconds.
// Both stay on the real clock: 20 Git calls of 100 ms never reach the 2-second cap, so the 20-file search can't be
// shown failing on a made-up clock when the cap is taken out.
for (const [count, waitMs] of [
  [50, 200],
  [20, 100],
]) {
  test(
    `a search over ${count} git-ignored secret files with a Git ${waitMs} ms slow waits on Git 2 seconds at most`,
    { skip: process.platform === "win32" && "the stand-in Git is a shell script" },
    (t) => {
      const realGit = realGitPath();
      assert.ok(realGit, "Git is on PATH");
      const bin = shellSlowGit(t, waitMs, realGit);
      const env = { ...environment(t, null), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
      const one = manyIgnoredProject(t, 1);
      const oneFile = runGuard(["read", "gemini"], { cwd: one, env, input: geminiSearch(one) });
      assert.equal(oneFile.status, 0, oneFile.stderr);
      const repo = manyIgnoredProject(t, count);
      const result = runGuard(["read", "gemini"], { cwd: repo, env, input: geminiSearch(repo) });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /"deny"/);
      assert.doesNotMatch(result.stdout, HELD);
      const bound = oneFile.elapsed + SEARCH_WALK_MAX_MS + GIT_TIMEOUT_MS;
      assert.ok(result.elapsed < bound, `answered in ${result.elapsed} ms, over ${bound} ms`);
    },
  );
}

// A probe that answers just inside the walk's time leaves the walk almost none, and the search must not go through for
// that: the walk keeps what it had left when the probe started. A 240 ms Git lands there about half the time.
test(
  "with a Git 240 ms slow, a search that reaches a secret file is stopped every time",
  { skip: process.platform === "win32" && "the stand-in Git is a shell script" },
  (t) => {
    const realGit = realGitPath();
    assert.ok(realGit, "Git is on PATH");
    const repo = mixedProject(t);
    const bin = shellSlowGit(t, 240, realGit);
    const env = { ...environment(t, null), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const answers = [];
    for (let ask = 0; ask < 6; ask++) {
      const result = runGuard(["read", "gemini"], { cwd: repo, env, input: geminiSearch(repo) });
      assert.equal(result.status, 0, result.stderr);
      answers.push(UNCHECKED.test(result.stdout) ? "through" : /"deny"/.test(result.stdout) ? "stopped" : "other");
    }
    assert.deepEqual(answers, Array(6).fill("stopped"));
  },
);

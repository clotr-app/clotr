// Inputs that could hold a hook past its time: a search given millions of filters, a tool call nested thousands
// deep, and a hook input that never closes. Each gets the answer a check that ran out of time gets, in time.
// Made-up values only.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const GUARD_ENGINE = path.join(__dirname, "..", "apps", "guard", "dist", "clotr-engine.js");
if (!fs.existsSync(GUARD_ENGINE)) {
  const { build } = require("../tools/engine-bundle.js");
  fs.mkdirSync(path.dirname(GUARD_ENGINE), { recursive: true });
  fs.writeFileSync(GUARD_ENGINE, build().text);
}
const SCRIPT = path.join(__dirname, "..", "apps", "guard", "bin", "clotr-guard.js");
const { inspectTool } = require("../apps/guard/lib/hooks/file-read-check.js");
const { HOOK_CHECK_MAX_MS, HOOK_TIMEOUT_SECONDS } = require("../apps/guard/lib/limits-and-messages.js");
const {
  onStandInClock,
  guardWithSlowProcesses,
  DEADLINE_PRELOAD,
  recordLongTimers,
  readLongTimers,
  assertDeadlineKept,
} = require("./guard-stand-in-clock.js");

// Half the hook's own check limit: a capped search answers long before it, and an uncapped one didn't.
const QUICK_MS = HOOK_CHECK_MAX_MS / 2;
// So many filters that reading them one by one took the hook to its limit.
const MANY = 5000000;

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-input-limits-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "notes\n");
  fs.writeFileSync(path.join(dir, "deploy.pem"), "made-up key file\n");
  return dir;
}

function readHook(tool, event, cwd) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [SCRIPT, "read", tool], {
    cwd,
    input: JSON.stringify({ ...event, cwd }),
    encoding: "utf8",
    maxBuffer: 1 << 20,
    timeout: 60000,
  });
  return { ...result, took: Date.now() - started };
}

function claudeDecision(result) {
  return JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision;
}

test("a Grep glob of millions of pieces gets the time-out answer well inside the limit", (t) => {
  const cwd = project(t);
  const glob = Array.from({ length: MANY }, (_, index) => `a${index}*`).join(" ") + " *.pem";
  const result = readHook(
    "claude",
    { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", glob } },
    cwd,
  );
  assert.equal(result.status, 0);
  assert.equal(claudeDecision(result), "ask", result.stdout);
  assert.match(result.stdout, /ran out of time/);
  assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
});

test("a Grep glob of millions of comma-joined pieces gets the time-out answer well inside the limit", (t) => {
  const cwd = project(t);
  const glob = Array.from({ length: MANY }, (_, index) => `d${index}/x`).join(",") + ",*.pem";
  const result = readHook(
    "claude",
    { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", glob } },
    cwd,
  );
  assert.equal(result.status, 0);
  assert.equal(claudeDecision(result), "ask", result.stdout);
  assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
});

test("a read_many_files include list of millions gets the time-out answer well inside the limit", (t) => {
  const cwd = project(t);
  const include = Array.from({ length: MANY }, (_, index) => `a${index}*`).concat("*.pem");
  const result = readHook("gemini", { tool_name: "read_many_files", tool_input: { include } }, cwd);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, "deny", result.stdout);
  assert.match(result.stdout, /ran out of time/);
  assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
});

test("a read_many_files exclude list of millions is stopped, not let through as a failed check", (t) => {
  const cwd = project(t);
  const exclude = Array.from({ length: MANY }, (_, index) => `b${index}`);
  const result = readHook("gemini", { tool_name: "read_many_files", tool_input: { include: ["*.pem"], exclude } }, cwd);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, "deny", result.stdout);
  assert.match(result.stdout, /ran out of time/);
  assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
});

test("one long Grep glob that still names a secret file is still denied for it", (t) => {
  const cwd = project(t);
  const glob = `q${"w".repeat(300000)}* *.pem`;
  const result = readHook(
    "claude",
    { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", glob } },
    cwd,
  );
  assert.equal(claudeDecision(result), "deny", result.stdout);
  assert.match(result.stdout, /deploy\.pem/);
  assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
});

function nested(depth) {
  let value = "made-up";
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
}

test("a tool call nested 10,000 deep gets the time-out answer, not an internal error that allows", () => {
  const outcome = inspectTool("claude", { tool_name: "mcp__notes__save", tool_input: nested(10000) });
  assert.equal(outcome.action, "block");
  assert.equal(outcome.unfinished, true);
  assert.ok(!outcome.internalError);
});

test("a tool call nested 10,000 deep is stopped through the real hook", (t) => {
  const cwd = project(t);
  const input = `{"tool_name":"mcp__notes__save","cwd":${JSON.stringify(cwd)},"tool_input":${'{"a":'.repeat(10000)}"x"${"}".repeat(10000)}}`;
  const result = spawnSync(process.execPath, [SCRIPT, "tool", "claude"], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0);
  assert.equal(claudeDecision(result), "ask", result.stdout);
  assert.match(result.stdout, /ran out of time/);
});

test("a tool call nested a few levels deep is still checked as before", () => {
  const outcome = inspectTool("claude", { tool_name: "mcp__notes__save", tool_input: nested(20) });
  assert.equal(outcome.action, "allow");
  assert.ok(!outcome.internalError && !outcome.unfinished);
});

// Starts a hook, writes part of an event and leaves its input open, the way an assistant that stalls would. `preload`
// is code the hook runs first, and with it `timers` is what recordLongTimers wrote.
function openInputHook(t, args, cwd, preload) {
  return new Promise((resolve) => {
    const started = Date.now();
    const first = [];
    const timers = path.join(cwd, "timers.json");
    if (preload) {
      first.push("--require", path.join(cwd, "preload.js"));
      fs.writeFileSync(first[1], `${preload}\n${recordLongTimers(timers)}`);
    }
    const child = spawn(process.execPath, [...first, SCRIPT, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    // Well past the hook's own timeout, so a hook with no deadline on its input is plainly late.
    const killer = setTimeout(() => child.kill(), (HOOK_TIMEOUT_SECONDS + 10) * 1000);
    t.after(() => {
      clearTimeout(killer);
      child.kill();
    });
    child.stdin.write('{"prompt":"hello');
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, took: Date.now() - started, timers: readLongTimers(timers) });
    });
  });
}

test("the prompt hook answers by its deadline while its input stays open", async (t) => {
  const cwd = project(t);
  const result = await openInputHook(t, ["hook", "claude"], cwd);
  assert.equal(result.signal, null, "the hook was still waiting when the test ended it");
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).decision, "block", result.stdout);
  assert.match(result.stdout, /ran out of time/);
  assert.ok(result.took < HOOK_TIMEOUT_SECONDS * 1000, `answered in ${result.took} ms`);
});

// The prompt hook above waits for the deadline for real; this one's deadline comes at once, and the length it asked
// for is checked instead.
test("the read hook answers by its deadline while its input stays open", async (t) => {
  const cwd = project(t);
  const result = await openInputHook(t, ["read", "claude"], cwd, DEADLINE_PRELOAD.now);
  assert.equal(result.signal, null, "the hook was still waiting when the test ended it");
  assert.equal(result.code, 0);
  assert.equal(claudeDecision(result), "ask", result.stdout);
  assert.match(result.stdout, /ran out of time/);
  assertDeadlineKept(result.timers, "the read hook", { ran: true });
});

// A network share that stops answering holds any look at it. These stand in for one: a mount table naming the test's
// folder as NFS, and a probe that waits far past the hook's time, as a look at a share that doesn't answer would.
const search = require("../apps/guard/lib/path-forms/network-mounts.js");

const MOUNTS = [
  "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw",
  "40 22 0:35 / /mnt/nas rw,relatime - nfs4 nas.example:/export rw,vers=4.2",
  "41 22 0:36 / /mnt/my\\040share rw - cifs //files.example/share rw",
  "42 22 0:37 / /mnt/nas/local rw - ext4 /dev/sdb1 rw",
].join("\n");

test("a path on an NFS or SMB mount is named as a network path, and a local mount inside it isn't", () => {
  assert.equal(search.networkMountOf("/mnt/nas/notes.txt", MOUNTS), "nfs4");
  assert.equal(search.networkMountOf("/mnt/nas", MOUNTS), "nfs4");
  assert.equal(search.networkMountOf("/mnt/my share/a/b", MOUNTS), "cifs");
  assert.equal(search.networkMountOf("/mnt/nas/local/notes.txt", MOUNTS), null);
  assert.equal(search.networkMountOf("/mnt/nasty/notes.txt", MOUNTS), null);
  assert.equal(search.networkMountOf("/home/notes.txt", MOUNTS), null);
});

// A folder standing in for a network share, named so the tests below can tell a look at it from any other.
const STALL_MS = 60000;
function shareFolder(t) {
  const dir = project(t);
  const stalled = path.join(dir, "stalled-share");
  fs.mkdirSync(stalled);
  fs.writeFileSync(path.join(stalled, "deploy.pem"), "made-up key file\n");
  return { dir, stalled };
}
const onTheShare = (target) => (target.includes("stalled-share") ? "nfs" : null);

// The share stops answering for real: any Node process started with its name in its arguments waits STALL_MS.
function stalledFolder(t) {
  const { dir, stalled } = shareFolder(t);
  const wait = path.join(dir, "wait.js");
  fs.writeFileSync(
    wait,
    `if (process.argv.some((arg) => String(arg).includes("stalled-share"))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${STALL_MS});
}
`,
  );
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(wait)}`;
  t.after(() => {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  });
  return { dir, stalled };
}

// The same share on the made-up clock: a look at it takes STALL_MS there, or the look's own timeout if that's less.
// `fn` gets Guard loaded fresh to look through it, and the clock.
function onStalledShare(t, fn) {
  const { dir, stalled } = shareFolder(t);
  return onStandInClock((clock) => {
    const slow = (command, args) =>
      command === process.execPath && args.some((arg) => String(arg).includes("stalled-share")) ? STALL_MS : 0;
    const { load } = guardWithSlowProcesses(clock, slow);
    return fn({
      dir,
      stalled,
      clock,
      slowSearch: load("lib/search-checks/search-check.js"),
      read: load("lib/hooks/file-read-check.js"),
    });
  });
}

// The one real wait on the look's own timer; the tests after it run on the made-up clock.
test("a look at a network path that doesn't answer is given up on at its deadline", (t) => {
  const { dir, stalled } = stalledFolder(t);
  const started = Date.now();
  assert.equal(search.networkPathAnswers(stalled, Date.now() + 1000), false);
  assert.ok(Date.now() - started < 3000, `gave up in ${Date.now() - started} ms`);
  assert.equal(search.networkPathAnswers(path.join(dir, "notes.txt"), Date.now() + 5000), true);
});

test("a search of a network folder that doesn't answer gets the time-out answer in time", (t) =>
  onStalledShare(t, ({ dir, stalled, slowSearch }) => {
    const started = Date.now();
    const found = slowSearch.findSecretInSearchTree(
      stalled,
      { include: [], exclude: [] },
      "claude",
      "grep",
      {},
      { deadline: Date.now() + 2000, mountTypeOf: onTheShare, cwd: dir },
    );
    assert.deepEqual(found, { unfinished: true });
    assert.ok(Date.now() - started < 4000, `answered in ${Date.now() - started} ms`);
  }));

test("a read of a file on a network folder that doesn't answer gets the time-out answer in time", (t) =>
  onStalledShare(t, ({ dir, stalled, read }) => {
    const started = Date.now();
    const outcome = read.inspectRead(
      "claude",
      { tool_name: "Read", tool_input: { file_path: path.join(stalled, "notes.txt") } },
      { cwd: dir, startedAt: Date.now(), mountTypeOf: onTheShare },
    );
    assert.equal(outcome.action, "block");
    assert.equal(outcome.unfinished, true);
    assert.ok(Date.now() - started < HOOK_CHECK_MAX_MS + 2000, `answered in ${Date.now() - started} ms`);
  }));

test("a shell command's walk of a network folder that doesn't answer stops in the walk's time", (t) =>
  onStalledShare(t, ({ dir, stalled, slowSearch }) => {
    const { shellWalkBudget } = require("../apps/guard/lib/check-budget.js");
    const budget = { ...shellWalkBudget({ shellCheckMaxMs: 2000 }), trees: new Map(), listings: new Map() };
    const started = Date.now();
    const found = slowSearch.findSecretInSearchTree(
      stalled,
      { include: [], exclude: [] },
      "shell",
      "grep",
      {},
      { budget, mountTypeOf: onTheShare, cwd: dir },
    );
    assert.deepEqual(found, { limited: true });
    assert.ok(Date.now() - started < 4000, `answered in ${Date.now() - started} ms`);
  }));

test("a Grep of a network folder that doesn't answer gets the time-out answer in time", (t) =>
  onStalledShare(t, ({ dir, stalled, read }) => {
    const started = Date.now();
    const outcome = read.inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", path: stalled } },
      { cwd: dir, startedAt: Date.now(), mountTypeOf: onTheShare },
    );
    assert.equal(outcome.action, "block");
    assert.equal(outcome.unfinished, true);
    assert.ok(Date.now() - started < HOOK_CHECK_MAX_MS + 2000, `answered in ${Date.now() - started} ms`);
  }));

// A search of a few thousand filters is checked in full, as it was before the caps: one that names a secret file is
// denied for it, and one that names none goes through.
function grepGlob(count, extra) {
  return Array.from({ length: count }, (_, index) => `src/f${index}*.js`)
    .concat(extra)
    .join(" ");
}

for (const [count, extra, file] of [
  [4096, ["*.pem"], /deploy\.pem/],
  [4999, [".env"], /\.env/],
  [19999, ["*.pem"], /deploy\.pem/],
]) {
  test(`a Grep glob of ${count + 1} filters that names ${extra[0]} is denied for it`, (t) => {
    const cwd = project(t);
    fs.writeFileSync(path.join(cwd, ".env"), "MADE_UP=1\n");
    const glob = grepGlob(count, extra);
    const result = readHook(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", glob } },
      cwd,
    );
    assert.equal(result.status, 0);
    assert.equal(claudeDecision(result), "deny", result.stdout);
    assert.match(result.stdout, file);
    assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
  });
}

test("a Grep glob of 5,000 filters that names no secret file goes through", (t) => {
  const cwd = project(t);
  const glob = grepGlob(5000, []);
  const result = readHook(
    "claude",
    { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", glob } },
    cwd,
  );
  assert.equal(result.status, 0);
  assert.equal(claudeDecision(result), undefined, result.stdout);
  assert.doesNotMatch(result.stdout, /ran out of time/);
  assert.ok(result.took < QUICK_MS, `answered in ${result.took} ms`);
});

// WSL 2 mounts the Windows drives as 9p. This stands in for one: a preload answers the mount table with the test's
// folder as WSL's drive, and counts the hook's looks at a network path (see networkPathAnswers).
function wslDrive(cwd) {
  const table = path.join(cwd, "mountinfo.txt");
  fs.writeFileSync(
    table,
    [
      "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw",
      `90 22 0:50 / ${cwd} rw,noatime - 9p drvfs rw,aname=drvfs;path=C:\\134;uid=1000`,
    ].join("\n") + "\n",
  );
  const looks = path.join(cwd, "looks.txt");
  const preload = path.join(cwd, "wsl-drive.js");
  fs.writeFileSync(
    preload,
    `const fs = require("fs");
const childProcess = require("child_process");
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  return readFileSync.call(fs, file === "/proc/self/mountinfo" ? ${JSON.stringify(table)} : file, ...rest);
};
const spawnSync = childProcess.spawnSync;
let count = 0;
childProcess.spawnSync = function (command, args, ...rest) {
  if (command === process.execPath && args?.[0] === "-e" && String(args[1]).includes("statSync")) count += 1;
  return spawnSync.call(childProcess, command, args, ...rest);
};
process.on("exit", () => {
  if (count) fs.appendFileSync(${JSON.stringify(looks)}, count + "\\n");
});
`,
  );
  const many = path.join(cwd, "many");
  fs.mkdirSync(many);
  const paths = [];
  for (let index = 1; index <= 200; index += 1) {
    paths.push(path.join(many, `f${index}.txt`));
    fs.writeFileSync(paths[paths.length - 1], "notes\n");
  }
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  const lookCount = () => (fs.existsSync(looks) ? Number(fs.readFileSync(looks, "utf8").trim()) : 0);
  return { env, paths, lookCount };
}

test("a read of 200 files on a WSL drive looks at the drive once, not once a file", (t) => {
  if (process.platform !== "linux") {
    t.skip("the mount table is Linux's");
    return;
  }
  const cwd = project(t);
  const { env, paths, lookCount } = wslDrive(cwd);
  const result = spawnSync(process.execPath, [SCRIPT, "read", "claude"], {
    cwd,
    env,
    input: JSON.stringify({ tool_name: "mcp__fs__read_multiple_files", tool_input: { paths }, cwd }),
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(claudeDecision(result), undefined, result.stdout);
  assert.equal(lookCount(), 1);
});

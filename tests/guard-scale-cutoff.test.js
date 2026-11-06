// Two ways a big text got past Guard unchecked. Placing tens of thousands of findings searched the text from the start
// once for each of them, so a prompt or tool call holding a key and a pasted contact list ran past the assistant's
// 15-second hook timeout, and an assistant goes ahead without a hook that times out. And a scan the engine's own time
// limit cut short passed as clean in the prompt, read and tool hooks and in the commit check, so a credential behind
// enough slow filler went through with no word. Made-up values only, built from parts.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const GUARD_ENGINE = path.join(ROOT, "apps", "guard", "dist", "clotr-engine.js");
if (!fs.existsSync(GUARD_ENGINE)) {
  const { build } = require("../tools/engine-bundle.js");
  fs.mkdirSync(path.dirname(GUARD_ENGINE), { recursive: true });
  fs.writeFileSync(GUARD_ENGINE, build().text);
}
const ENGINE_JS = path.join(ROOT, "apps", "guard", "lib", "engine.js");
const GUARD_JS = path.join(ROOT, "apps", "guard", "bin", "clotr-guard.js");
const guardEngine = require(ENGINE_JS);
const guard = require(GUARD_JS);

const KEY = ["AKIA", "Z7Q2M4N6", "P8R3T5V1"].join("");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-scale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function emails(count) {
  return Array.from({ length: count }, (_, i) => `u${i}@d${i}.com`);
}

// ---------- Placing many findings ----------

// The placing rules as they were written first, one search from the start of the text for each value: the answers the
// faster placing must keep.
function placesByScanning(text, values) {
  const starts = values.map(() => -1);
  const taken = [];
  const order = values.map((_, i) => i).sort((a, b) => values[b].length - values[a].length || a - b);
  for (const i of order) {
    const value = values[i];
    if (!value) {
      starts[i] = 0;
      continue;
    }
    let first = -1;
    let fresh = -1;
    let free = -1;
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
      const end = at + value.length;
      if (first < 0) first = at;
      if (taken.some((span) => span.value === value && at < span.end && span.start < end)) continue;
      if (fresh < 0) fresh = at;
      if (!taken.some((span) => span.start <= at && end <= span.end)) {
        free = at;
        break;
      }
    }
    const start = free >= 0 ? free : fresh >= 0 ? fresh : first;
    if (start >= 0) taken.push({ value, start, end: start + value.length });
    starts[i] = start;
  }
  return starts;
}

test("Guard places tens of thousands of findings in a megabyte in well under a second's work each thousand", () => {
  const context = guardEngine.engineContext();
  const list = emails(56_000);
  const text = `${list.join(" ")}\n${KEY}`;
  // In text order and backwards: the engine can list a kind's matches in either.
  for (const matches of [list, [...list].reverse()]) {
    const started = Date.now();
    const findings = guardEngine.findingsFromDetections(context, text, [
      { id: "email", name: "Email", severity: "medium", matches },
      { id: "aws_access_key", name: "AWS Access Key", severity: "high", matches: [KEY] },
    ]);
    const elapsed = Date.now() - started;
    // About a quarter of a second on an idle computer; searching from the start for each took about 25 seconds.
    assert.ok(elapsed < 5000, `placing 56,001 findings took ${elapsed} ms`);
    assert.equal(findings.length, matches.length + 1);
    matches.forEach((value, i) => assert.equal(text.slice(findings[i].start, findings[i].end), value));
    assert.equal(findings[matches.length].start, text.lastIndexOf(KEY));
  }
});

test("Guard's placing gives the same places as searching from the start for every value", () => {
  const context = guardEngine.engineContext();
  // A small seeded generator, so a failure can be run again.
  let seed = 0x5eed;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  for (let round = 0; round < 3000; round += 1) {
    const alphabet = round % 3 === 0 ? "ab" : round % 3 === 1 ? "abc" : "ab-";
    const length = 1 + random(40);
    let text = "";
    for (let i = 0; i < length; i += 1) text += alphabet[random(alphabet.length)];
    const values = [];
    const count = 1 + random(14);
    for (let i = 0; i < count; i += 1) {
      const pick = random(10);
      if (pick === 0 && values.length) values.push(values[random(values.length)]);
      else if (pick === 1) values.push(`${alphabet[random(alphabet.length)]}z${alphabet[random(alphabet.length)]}`);
      else {
        const from = random(text.length);
        values.push(text.slice(from, from + 1 + random(Math.min(6, text.length - from))));
      }
    }
    const findings = guardEngine.findingsFromDetections(context, text, [
      { id: "probe", name: "Probe", severity: "high", matches: values },
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.start),
      placesByScanning(text, values),
      `${JSON.stringify(text)} ${JSON.stringify(values)}`,
    );
  }
});

// In text that repeats, one value's copies overlap, so each search for its next copy moves on one character but
// compares about the value's whole length. Counting only how far the searches moved let 20 such values in 60,000
// characters (checked on the hook's own thread, where no deadline can stop it) take 4 to 7.5 seconds, and many short
// ones in a megabyte keep about 700 MB of copies.
test("Guard's placing stays quick for values whose copies overlap", () => {
  const context = guardEngine.engineContext();
  const run = (length, count, size) => ({
    text: "a".repeat(length),
    values: ["a".repeat(length), ...Array.from({ length: count }, (_, k) => "a".repeat(size(k)))],
  });
  const cases = [
    run(60_000, 20, (k) => 20_000 - k),
    run(1_000_000, 20, (k) => 1000 - k),
    run(1_000_000, 64, (k) => 1 + k),
    {
      text: "ab".repeat(30_000),
      values: ["ab".repeat(30_000), ...Array.from({ length: 20 }, (_, k) => "ab".repeat(10_000 - k))],
    },
  ];
  for (const { text, values } of cases) {
    const started = Date.now();
    const findings = guardEngine.findingsFromDetections(context, text, [
      { id: "probe", name: "Probe", severity: "high", matches: values },
    ]);
    const elapsed = Date.now() - started;
    // Well under a second on an idle computer; charging only the distance moved took 4 to 11 seconds.
    assert.ok(elapsed < 2000, `placing ${values.length} values in ${text.length} characters took ${elapsed} ms`);
    // Out of search, a value still sits on a real copy of itself.
    values.forEach((value, i) => assert.equal(text.slice(findings[i].start, findings[i].end), value));
  }
});

function runHook(args, event, dataDir) {
  const started = Date.now();
  const child = spawnSync(process.execPath, [GUARD_JS, ...args], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, CLOTR_GUARD_DATA_DIR: dataDir },
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ...child, elapsed: Date.now() - started };
}

test("a prompt and a tool call holding a key among a megabyte of email addresses answer well inside 15 seconds", (t) => {
  const dataDir = tempDir(t);
  const body = `${emails(56_000).join(" ")} \n${KEY}`;
  assert.ok(Buffer.byteLength(JSON.stringify({ prompt: body })) < 1024 * 1024);
  const prompt = runHook(
    ["hook", "claude"],
    { hook_event_name: "UserPromptSubmit", session_id: "s", cwd: dataDir, prompt: body },
    dataDir,
  );
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /"decision":"block"/);
  assert.match(prompt.stdout, /AWS Access Key/);
  // About two seconds on an idle computer; placing the findings one search at a time took about 30.
  assert.ok(prompt.elapsed < 12_000, `the prompt hook took ${prompt.elapsed} ms`);

  // Without the key both of the tool hook's passes run: the strings as written, then the arguments as JSON.
  const plain = runHook(
    ["tool", "claude"],
    {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: dataDir,
      tool_name: "mcp__mail__send",
      tool_input: { to: "someone", body: emails(56_000).join(" ") },
    },
    dataDir,
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /ask|deny|block/);
  assert.ok(plain.elapsed < 12_000, `the tool hook took ${plain.elapsed} ms`);
});

// ---------- A scan cut short by the engine's time limit ----------

// A pattern that pretends to take longer than the engine's whole time limit, on a fake clock in Guard's engine realm.
// Returns the undo.
function stallGuardEngine() {
  const realm = vm.runInContext("globalThis", guardEngine.engineContext());
  const { Clotr, Date: RealmDate } = realm;
  const realNow = RealmDate.now;
  let now = realNow();
  RealmDate.now = () => now;
  const slow = {
    id: "test_stalled",
    severity: "low",
    name: "stalled",
    find: () => ((now += Clotr.DETECT_BACKSTOP_MS + 200), []),
  };
  Clotr.PATTERNS.push(slow);
  return () => {
    RealmDate.now = realNow;
    Clotr.PATTERNS.splice(Clotr.PATTERNS.indexOf(slow), 1);
  };
}

function stalled(t) {
  const undo = stallGuardEngine();
  t.after(undo);
}

const STALL_PRELOAD = `const engine = require(${JSON.stringify(ENGINE_JS)});
const realm = require("node:vm").runInContext("globalThis", engine.engineContext());
let now = realm.Date.now(); realm.Date.now = () => now;
realm.Clotr.PATTERNS.push({ id: "test_stalled", severity: "low", name: "stalled",
  find: () => ((now += realm.Clotr.DETECT_BACKSTOP_MS + 200), []) });
`;

test("Guard's check() calls a scan cut short a block, findings or not", (t) => {
  stalled(t);
  const result = guardEngine.check("a note about lunch the engine runs out of time on");
  assert.equal(result.truncated, true);
  assert.equal(result.decision, "block");
});

test("a prompt the engine runs out of time on is stopped, says why in plain words, and isn't let through by sending it again", (t) => {
  const dataDir = tempDir(t);
  stalled(t);
  const options = { dataDir, cwd: dataDir };
  for (const prompt of ["a note about lunch, cut short", `a key ${KEY} in a note, cut short`]) {
    const first = guard.inspectPrompt("claude", prompt, { ...options, now: 10_000 });
    assert.equal(first.action, "block", prompt);
    assert.equal(first.unfinished, true, prompt);
    const again = guard.inspectPrompt("claude", prompt, { ...options, now: 11_000 });
    assert.equal(again.action, "block", "sending it again let a part-checked prompt through");
    for (const tool of ["claude", "cursor", "gemini", "windsurf", "cline", "codex"]) {
      const output = guard.hookOutput(tool, first);
      const said = `${output.stdout || ""}${output.stderr || ""}`;
      assert.match(said, /ran out of time/, `${tool} ${prompt}`);
      // Windsurf is stopped by the exit code alone.
      if (tool === "windsurf") assert.equal(output.code, 2);
      else assert.match(said, /block|deny|"continue":false|"cancel":true/, `${tool} ${prompt}`);
    }
  }
});

test("a tool call and a file read the engine runs out of time on aren't let through", (t) => {
  const dataDir = tempDir(t);
  stalled(t);
  const tool = guard.inspectTool(
    "claude",
    { tool_name: "mcp__mail__send", tool_input: { body: "a note about lunch, cut short" }, cwd: dataDir },
    { dataDir },
  );
  assert.equal(tool.action, "block");
  assert.equal(tool.unfinished, true);
  for (const name of ["claude", "cursor"]) {
    const output = JSON.parse(guard.boundaryOutput(name, tool, "tool").stdout);
    assert.match(JSON.stringify(output), /ran out of time/);
    assert.equal(output.hookSpecificOutput?.permissionDecision ?? output.permission, "ask");
  }

  const file = path.join(dataDir, "notes.txt");
  fs.writeFileSync(file, "a note about lunch, cut short\n");
  const read = guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { dataDir });
  assert.equal(read.action, "block");
  assert.equal(read.unfinished, true);
  const asked = JSON.parse(guard.readHookOutput("claude", read).stdout);
  assert.equal(asked.hookSpecificOutput.permissionDecision, "ask");
  assert.match(asked.hookSpecificOutput.permissionDecisionReason, /ran out of time/);
  for (const name of ["gemini", "cursor", "cline", "windsurf"]) {
    const output = guard.readHookOutput(name, read);
    assert.match(`${output.stdout || ""}${output.stderr || ""}`, /ran out of time/, name);
    assert.match(`${output.stdout || ""}`, /deny|"cancel":true|^$/, name);
    if (name === "windsurf") assert.equal(output.code, 2);
  }

  // The shell hook already stops a check that didn't finish; a cut-short scan is one.
  const shell = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command: "echo a note about lunch, cut short", cwd: dataDir } },
    { dataDir, cwd: dataDir },
  );
  assert.equal(shell.action, "block");
  assert.equal(shell.location, "a check that didn't finish");
});

function initRepo(t) {
  const root = tempDir(t);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  git("init", "-q");
  return { root, git };
}

test("a commit whose added lines the engine runs out of time on is stopped and the file named", (t) => {
  const { root, git } = initRepo(t);
  fs.writeFileSync(path.join(root, "data.txt"), "a note about lunch, cut short\n");
  git("add", "data.txt");
  stalled(t);
  const { issues } = guard.checkStaged({ cwd: root });
  const unfinished = issues.find((issue) => issue.kind === "staged_check_unfinished");
  assert.ok(unfinished, JSON.stringify(issues));
  assert.equal(unfinished.file, "data.txt");
  assert.match(unfinished.masked, /ran out of time/);
});

test("the prompt hook, the commit check and clotr-guard check fail closed when the engine runs out of time", (t) => {
  const dir = tempDir(t);
  const preload = path.join(dir, "stall.js");
  fs.writeFileSync(preload, STALL_PRELOAD);
  const run = (args, input, cwd = dir) =>
    spawnSync(process.execPath, ["--require", preload, GUARD_JS, ...args], {
      input,
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "data") },
    });

  const prompt = run(
    ["hook", "claude"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: dir, prompt: "a note, cut short" }),
  );
  assert.equal(prompt.status, 0, prompt.stderr);
  const answer = JSON.parse(prompt.stdout);
  assert.equal(answer.decision, "block");
  assert.match(answer.reason, /ran out of time/);

  const tool = run(
    ["tool", "claude"],
    JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "mcp__x__y", tool_input: { a: "a note" } }),
  );
  assert.equal(tool.status, 0, tool.stderr);
  assert.equal(JSON.parse(tool.stdout).hookSpecificOutput.permissionDecision, "ask");

  const { root, git } = initRepo(t);
  fs.writeFileSync(path.join(root, "data.txt"), "a note about lunch, cut short\n");
  git("add", "data.txt");
  const commit = run(["commit-check"], "", root);
  assert.equal(commit.status, 1, commit.stderr);
  assert.match(commit.stderr, /"data\.txt":0 staged_check_unfinished .*ran out of time/);

  const check = run(["check"], "a note about lunch, cut short");
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stderr, /part of this text wasn't checked/i);
  const json = run(["check", "--json"], "a note about lunch, cut short");
  assert.equal(json.status, 1, json.stderr);
  assert.equal(JSON.parse(json.stdout).decision, "block");
});

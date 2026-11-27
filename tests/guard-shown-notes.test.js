// What Guard's hooks have to say reaches the person, in the one field each assistant shows. Most of them don't show
// stderr from a hook that lets the action through, so a note there was never seen. Made-up values only, built from
// parts.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const GUARD_ENGINE = path.join(__dirname, "..", "apps", "guard", "dist", "clotr-engine.js");
if (!fs.existsSync(GUARD_ENGINE)) {
  const { build } = require("../tools/engine-bundle.js");
  fs.mkdirSync(path.dirname(GUARD_ENGINE), { recursive: true });
  fs.writeFileSync(GUARD_ENGINE, build().text);
}
const guardEngine = require("../apps/guard/lib/text-checks/engine-loader.js");
const guard = require("../apps/guard/bin/clotr-guard.js");

const KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");
const TOOLS = ["claude", "cursor", "gemini", "windsurf", "cline", "codex"];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-shown-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// What a hook's answer shows the person, from the one field each tool shows: stderr only for Windsurf, a block's
// reason, an ask or deny reason, Cursor's user_message, Cline's contextModification or errorMessage, and everyone
// else's systemMessage.
function visibleNote(tool, output) {
  if (tool === "windsurf") return output.stderr || "";
  const answer = JSON.parse(output.stdout || "{}");
  const stopped = /^(?:ask|deny)$/.test(answer.hookSpecificOutput?.permissionDecision || "");
  return [
    answer.systemMessage,
    answer.user_message,
    answer.contextModification,
    answer.errorMessage,
    answer.decision === "block" || answer.decision === "deny" ? answer.reason : "",
    stopped ? answer.hookSpecificOutput.permissionDecisionReason : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// A pattern that pretends to take longer than the engine's whole time limit, on a fake clock in Guard's engine realm.
function stallGuardEngine(t) {
  const { Clotr, Date: RealmDate } = vm.runInContext("globalThis", guardEngine.engineContext());
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
  t.after(() => {
    RealmDate.now = realNow;
    Clotr.PATTERNS.splice(Clotr.PATTERNS.indexOf(slow), 1);
  });
}

// ---------- A check the engine ran out of time on ----------

test("a prompt the engine runs out of time on says so, with what it found, in every tool's own field", (t) => {
  const dir = tempDir(t);
  stallGuardEngine(t);
  const options = { dataDir: dir, cwd: dir };
  const plain = guard.inspectPrompt("claude", "an ordinary prompt the engine runs out of time on", options);
  const keyed = guard.inspectPrompt("claude", `use the key ${KEY} please`, options);
  for (const outcome of [plain, keyed]) assert.equal(outcome.action, "block");
  for (const tool of TOOLS) {
    assert.match(visibleNote(tool, guard.hookOutput(tool, plain)), /ran out of time/, tool);
    const said = visibleNote(tool, guard.hookOutput(tool, keyed));
    assert.match(said, /AWS Access Key/, tool);
    assert.match(said, /ran out of time/, tool);
    assert.doesNotMatch(said, /R6TWLJ3N/, tool);
  }
});

test("a read the engine runs out of time on says so in every tool's own field and in the question before it", (t) => {
  const dir = tempDir(t);
  const plainFile = path.join(dir, "notes.txt");
  const keyFile = path.join(dir, "keys.txt");
  fs.writeFileSync(plainFile, "ordinary notes the engine runs out of time on\n");
  fs.writeFileSync(keyFile, `KEY=${KEY}\n`);
  stallGuardEngine(t);
  const read = (file) =>
    guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: dir });
  const plain = read(plainFile);
  const keyed = read(keyFile);
  for (const outcome of [plain, keyed]) assert.equal(outcome.action, "block");
  const asked = JSON.parse(guard.readHookOutput("claude", keyed).stdout).hookSpecificOutput;
  assert.equal(asked.permissionDecision, "ask");
  assert.match(asked.permissionDecisionReason, /AWS Access Key/);
  assert.match(asked.permissionDecisionReason, /ran out of time/);
  for (const tool of TOOLS) {
    assert.match(visibleNote(tool, guard.readHookOutput(tool, plain)), /ran out of time/, tool);
    assert.match(visibleNote(tool, guard.readHookOutput(tool, keyed)), /ran out of time/, tool);
    // Beside the size limit's line, both show.
    const both = visibleNote(tool, guard.readHookOutput(tool, { ...plain, partial: true }));
    assert.match(both, /ran out of time/, tool);
    assert.match(both, /first 256 KiB/, tool);
  }
});

test("a shell command or tool call the engine runs out of time on says so in the tool's own field", (t) => {
  const dir = tempDir(t);
  stallGuardEngine(t);
  const shell = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command: "echo an ordinary command the engine runs out of time on" } },
    { cwd: dir, dataDir: dir },
  );
  assert.equal(shell.action, "block");
  for (const tool of TOOLS) {
    assert.match(visibleNote(tool, guard.boundaryOutput(tool, shell, "shell")), /didn't finish in time/, tool);
  }
  const call = guard.inspectTool(
    "cursor",
    { tool_name: "notes", tool_input: { text: "ordinary words the engine runs out of time on" }, cwd: dir },
    { dataDir: dir },
  );
  assert.equal(call.action, "block");
  for (const tool of ["claude", "cursor"]) {
    assert.match(visibleNote(tool, guard.boundaryOutput(tool, call, "tool")), /ran out of time/, tool);
  }
});

// ---------- What passes with something to say ----------

test("a prompt or read that passes with something found says so in the tool's own field, not only on stderr", (t) => {
  const dir = tempDir(t);
  const options = { dataDir: dir, cwd: dir, includePersonalDetails: true };
  const address = guard.inspectPrompt("claude", "The staging server at 192.168.1.20 returns a 500 error.", options);
  const email = guard.inspectPrompt("claude", "Email me at hello@example.com", options);
  assert.equal(address.action, "allow");
  assert.equal(email.belowMinimumOnly, true);
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "Email me at hello@example.com\n");
  const read = guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, options);
  assert.equal(read.action, "allow");
  for (const tool of TOOLS) {
    const said = visibleNote(tool, guard.hookOutput(tool, address));
    assert.match(said, /Internal IP Address/, tool);
    assert.doesNotMatch(said, /192\.168|1\.20/, tool);
    assert.match(visibleNote(tool, guard.hookOutput(tool, email)), /below the stop level/, tool);
    assert.match(visibleNote(tool, guard.readHookOutput(tool, read)), /below the stop level/, tool);
    // Still a pass, and still on stderr for the tools that read it there.
    for (const output of [guard.hookOutput(tool, email), guard.readHookOutput(tool, read)]) {
      assert.equal(output.code, 0, tool);
      assert.match(output.stderr || "", /below the stop level/, tool);
      assert.doesNotMatch(output.stdout || "", /"continue":false|"decision":"(?:block|deny)"|"cancel":true|"deny"/);
    }
  }
});

test("a search Guard couldn't finish checking for secret files says so in the tool's own field", () => {
  const outcome = { action: "allow", searchLimited: true };
  for (const tool of TOOLS) {
    const output = guard.readHookOutput(tool, outcome);
    assert.equal(output.code, 0, tool);
    assert.match(visibleNote(tool, output), /couldn't finish checking this search/, tool);
    assert.doesNotMatch(output.stdout || "", /"deny"|"cancel":true/, tool);
  }
});

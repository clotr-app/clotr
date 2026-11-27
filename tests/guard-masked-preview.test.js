"use strict";
/* global require, process, __dirname */

// Every place Guard prints a masked value shows none of a password and at most a quarter of any other value.
// All values here are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
const PASSWORDS = ["Zq7#mVx2!", "Zq7#mVx2!kLp"];
const OTHERS = { aws_access_key: "AKIA4HPQ7XZ2R6TWLJ3N", credit_card: "4111 1111 1111 1111" };
const HOOK_TOOLS = ["claude", "cursor", "gemini", "codex", "windsurf", "cline"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-mask-"));
}

function guard(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...options });
}

// The characters of the value a masked form still shows.
function shownCount(masked) {
  return masked.replace(/[•…]/g, "").length;
}

function assertNoPassword(masked, value, where) {
  assert.match(masked, /^•+$/, `${where}: ${masked}`);
  assert.ok(!masked.includes(value[0]), where);
}

function assertQuarter(masked, value, where) {
  assert.ok(
    shownCount(masked) <= Math.floor(value.length / 4),
    `${where}: ${masked} shows too much of ${value.length}`,
  );
}

// No two characters of the value in a row anywhere in the output.
function assertNoRun(output, value, where) {
  for (let i = 0; i + 2 <= value.length; i++) {
    assert.ok(!output.includes(value.slice(i, i + 2)), `${where} shows "${value.slice(i, i + 2)}"`);
  }
}

// Windsurf and Cline send a prompt in their own shapes.
function promptEvent(tool, prompt) {
  if (tool === "windsurf") return { tool_info: { user_prompt: prompt } };
  if (tool === "cline") return { hookName: "UserPromptSubmit", userPromptSubmit: { prompt } };
  return { prompt };
}

function only(findings, kind) {
  const found = findings.filter((finding) => finding.kind === kind);
  assert.equal(found.length, 1, `${kind}: ${JSON.stringify(findings.map((finding) => finding.kind))}`);
  return found[0];
}

for (const password of PASSWORDS) {
  const text = `password: ${password}`;
  const where = `${password.length}-character password`;

  test(`check's text output shows none of a ${where}`, () => {
    const result = guard(["check"], { input: text });
    assert.equal(result.status, 1, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("password: "));
    assert.ok(line, result.stdout);
    assertNoPassword(line.slice("password: ".length), password, where);
  });

  test(`check --json shows none of a ${where}`, () => {
    const result = guard(["check", "--json"], { input: text });
    assert.equal(result.status, 1, result.stderr);
    assertNoPassword(only(JSON.parse(result.stdout).findings, "password").masked, password, where);
    assert.ok(!result.stdout.includes(password), where);
  });

  test(`the Git hook shows none of a ${where}`, () => {
    const dir = tempDir();
    try {
      const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
      git(["init", "-q"]);
      git(["config", "user.name", "Guard Test"]);
      git(["config", "user.email", "guard-test@example.invalid"]);
      fs.writeFileSync(path.join(dir, "settings.txt"), `${text}\n`);
      git(["add", "settings.txt"]);
      const result = guard(["commit-check"], { cwd: dir });
      assert.equal(result.status, 1, result.stderr);
      const line = result.stderr.split("\n").find((entry) => entry.includes(" password ("));
      assert.ok(line, result.stderr);
      assertNoPassword(line.slice(line.indexOf(" password (") + 11, -1), password, where);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`each assistant hook's message shows none of a ${where}`, () => {
    const dir = tempDir();
    try {
      for (const tool of HOOK_TOOLS) {
        const env = { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, tool) };
        const prompt = guard(["hook", tool], { input: JSON.stringify(promptEvent(tool, text)), env });
        assert.match(`${prompt.stdout}${prompt.stderr}`, /Password/, tool);
        assertNoRun(`${prompt.stdout}${prompt.stderr}`, password, `${tool} prompt hook`);
      }
      const file = path.join(dir, "settings.txt");
      fs.writeFileSync(file, `${text}\n`);
      const env = { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "read") };
      const read = guard(["read", "claude"], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } }),
        env,
      });
      assert.match(`${read.stdout}${read.stderr}`, /Password/, "read hook");
      // The read hook names the file, quoted and escaped, and a random temp folder name can hold two of the
      // password's characters. Its backslashes are folded so the folder can be taken out in any escaping.
      const said = `${read.stdout}${read.stderr}`.replace(/\\+/g, "/").split(dir.replace(/\\+/g, "/")).join("");
      assertNoRun(said, password, "claude read hook");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const [kind, value] of Object.entries(OTHERS)) {
  const text = `Use ${value} here`;

  test(`check and the Git hook show at most a quarter of a ${kind}`, () => {
    const plain = guard(["check"], { input: text });
    const line = plain.stdout.split("\n").find((entry) => entry.startsWith(`${kind}: `));
    assert.ok(line, plain.stdout);
    assertQuarter(line.slice(kind.length + 2), value, "check");

    const json = guard(["check", "--json"], { input: text });
    assertQuarter(only(JSON.parse(json.stdout).findings, kind).masked, value, "check --json");

    const dir = tempDir();
    try {
      const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
      git(["init", "-q"]);
      fs.writeFileSync(path.join(dir, "notes.txt"), `${text}\n`);
      git(["add", "notes.txt"]);
      const commit = guard(["commit-check"], { cwd: dir });
      const found = commit.stderr.split("\n").find((entry) => entry.includes(` ${kind} (`));
      assert.ok(found, commit.stderr);
      assertQuarter(found.slice(found.indexOf(` ${kind} (`) + kind.length + 3, -1), value, "commit-check");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

"use strict";
/* global require, process, __dirname */

// Setup writes Guard's own path into every hook it installs. If that path is worked out wrong, the hook can't start,
// exits with no answer and the assistant's own rule decides, so a wrong path lets reads through without a word.
// These check the path each setup writes is the real bin/clotr-guard.js, wherever the code that writes it lives.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
const VSCODE_CLI = path.resolve(__dirname, "../apps/vscode/guard/bin/clotr-guard.js");
const { managedHooks } = require(CLI);

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-own-paths-"));
  const dirs = { root, cwd: path.join(root, "project"), home: path.join(root, "home"), data: path.join(root, "data") };
  for (const dir of [dirs.cwd, dirs.home, dirs.data]) fs.mkdirSync(dir, { recursive: true });
  const git = spawnSync("git", ["init", "-q", "."], { cwd: dirs.cwd, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  return dirs;
}

function runCli(dirs, args) {
  const env = { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home, CLOTR_GUARD_DATA_DIR: dirs.data };
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dirs.cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
}

// Every Guard script a hook file names: a JSON args entry or a quoted word in a command or shell script.
function scriptsIn(text) {
  const found = new Set();
  // JSON doubles each Windows backslash, so undo that before comparing paths.
  for (const match of text.matchAll(/["']([^"']*clotr-guard\.js)["']/g)) found.add(match[1].replace(/\\\\/g, "\\"));
  return [...found];
}

const SETUPS = [
  { tool: "claude", args: ["setup", "claude", "--project"], file: [".claude", "settings.json"] },
  { tool: "cursor", args: ["setup", "cursor", "--project"], file: [".cursor", "hooks.json"] },
  { tool: "git", args: ["setup", "git"], file: [".git", "hooks", "pre-commit"] },
];

for (const { tool, args, file } of SETUPS) {
  test(`${args.join(" ")} writes the path of Guard's own bin/clotr-guard.js, and managedHooks names it`, () => {
    const dirs = scratch();
    try {
      runCli(dirs, args);
      const text = fs.readFileSync(path.join(dirs.cwd, ...file), "utf8");
      const scripts = scriptsIn(text);
      assert.deepEqual(scripts, [CLI], tool);
      assert.equal(fs.existsSync(scripts[0]), true, tool);
      assert.equal(
        path.relative(path.resolve(__dirname, ".."), scripts[0]).split(path.sep).join("/"),
        "apps/guard/bin/clotr-guard.js",
      );
      const managed = managedHooks(tool, { project: true, cwd: dirs.cwd, home: dirs.home });
      assert.ok(managed.length > 0, tool);
      for (const entry of managed) assert.equal(entry.script, CLI, tool);
    } finally {
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });
}

// isGuardScriptPath isn't exported, so this reads it through the hook a setup wrote: managedHooks keeps a hook only
// when its script is Guard's own.
test("Guard's own script and the VS Code copy count as Guard, a look-alike in another folder doesn't", () => {
  const dirs = scratch();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "guard-own-paths-other-"));
  try {
    runCli(dirs, ["setup", "claude", "--project"]);
    const settings = path.join(dirs.cwd, ".claude", "settings.json");
    const written = fs.readFileSync(settings, "utf8");
    const lookAlike = path.join(elsewhere, "tools", "bin", "clotr-guard.js");
    fs.mkdirSync(path.dirname(lookAlike), { recursive: true });
    fs.copyFileSync(CLI, lookAlike);
    const scriptsWith = (script) => {
      fs.writeFileSync(settings, written.replaceAll(JSON.stringify(CLI), JSON.stringify(script)));
      return [
        ...new Set(managedHooks("claude", { project: true, cwd: dirs.cwd, home: dirs.home }).map((e) => e.script)),
      ];
    };
    assert.deepEqual(scriptsWith(CLI), [CLI]);
    assert.deepEqual(scriptsWith(VSCODE_CLI), [VSCODE_CLI]);
    assert.deepEqual(scriptsWith(lookAlike), []);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

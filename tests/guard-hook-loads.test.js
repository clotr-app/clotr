"use strict";

// Each hook is a new Node process, and on Windows every file Node opens adds to the wait before the
// assistant can go on. So loading Guard's command leaves the checks, the commands and setup for the
// first call that needs them.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GUARD = path.join(__dirname, "..", "apps", "guard");
const BIN = path.join(GUARD, "bin", "clotr-guard.js");

// Files that only a check, a command or setup uses.
const LOADED_LATER = [
  "lib/shell-checks/shell-check.js",
  "lib/hooks/file-read-check.js",
  "lib/search-checks/search-check.js",
  "lib/commands/commit-check.js",
  "lib/commands/check-command.js",
  "lib/setup/installed-hooks.js",
  "lib/setup/assistant-settings.js",
];

// The Guard files loaded after `code` runs with the command required as `guard`, in a fresh Node.
function loadedAfter(code) {
  const script = [
    `const guard = require(${JSON.stringify(BIN)});`,
    code,
    `const root = ${JSON.stringify(path.dirname(path.dirname(BIN)) + path.sep)};`,
    "const files = Object.keys(require.cache).filter((key) => key.startsWith(root));",
    "console.log(JSON.stringify(files.map((key) => key.slice(root.length).split(require('path').sep).join('/'))));",
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("loading Guard's command leaves the checks, the commands and setup for later", () => {
  const loaded = loadedAfter("");
  for (const file of LOADED_LATER) assert.ok(!loaded.includes(file), `${file} loaded with the command`);
});

test("a check loads its files the first time it's called", () => {
  const loaded = loadedAfter('guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command: "ls" } }, {});');
  assert.ok(loaded.includes("lib/shell-checks/shell-check.js"), JSON.stringify(loaded));
  assert.ok(!loaded.includes("lib/setup/installed-hooks.js"), JSON.stringify(loaded));
});

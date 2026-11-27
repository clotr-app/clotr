"use strict";
/* global require, __dirname */
// When Guard is running and catches its own error (the engine file is missing or isn't JavaScript, or an error or a
// rejected promise nothing else caught), the prompt is stopped, a read is asked about or stopped, a tool call is asked
// about and a shell command is stopped. A read Guard couldn't open here (a missing file, a file on another computer)
// still goes through with the "couldn't check" note.
// Each way of breaking runs in a copy of Guard under the temp folder, or through a preload file named in NODE_OPTIONS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GUARD = path.join(__dirname, "..", "apps", "guard");
const ENGINE_PATH = path.join(GUARD, "dist", "clotr-engine.js");
const { build } = require("../tools/engine-bundle.js");
const bundle = build().text;
if (!fs.existsSync(ENGINE_PATH) || fs.readFileSync(ENGINE_PATH, "utf8") !== bundle) {
  fs.mkdirSync(path.dirname(ENGINE_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_PATH, bundle);
}

// A made-up key, built from pieces so no whole value sits in this file.
const madeUpKey = ["AKIA", "4HPQ", "7XZ2", "R6TW", "LJ3N"].join("");
const madeUpValue = ["made", "up", "value", "for", "guard"].join("-");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "guard-caught-error-"));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const proj = path.join(home, "proj");
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, ".env"), `APP_TOKEN=${madeUpValue}\n`);
const keyed = path.join(proj, "deploy-notes.txt");
fs.writeFileSync(keyed, `notes\nkey ${madeUpKey}\n`);

function copyGuard(name, change) {
  const to = path.join(home, name);
  fs.cpSync(GUARD, to, { recursive: true, filter: (from) => !from.includes("node_modules") });
  change(to);
  return to;
}
function preload(name, text) {
  const file = path.join(home, `${name}.js`);
  fs.writeFileSync(file, text);
  return file;
}

const engineFile = (root) => path.join(root, "dist", "clotr-engine.js");
const WAYS = [
  { id: "no-engine", root: copyGuard("noengine", (to) => fs.rmSync(engineFile(to))) },
  { id: "bad-engine", root: copyGuard("badengine", (to) => fs.writeFileSync(engineFile(to), "this is (not js")) },
  {
    id: "throw-later",
    root: GUARD,
    env: { NODE_OPTIONS: `--require ${preload("throwlater", "setTimeout(() => { throw new Error('x'); }, 1);")}` },
  },
  {
    id: "reject-later",
    root: GUARD,
    env: {
      NODE_OPTIONS: `--require ${preload("rejectlater", "setTimeout(() => { Promise.reject(new Error('x')); }, 1);")}`,
    },
  },
];

function run(root, args, event, env = {}) {
  const data = fs.mkdtempSync(path.join(home, "data-"));
  const out = spawnSync(process.execPath, [path.join(root, "bin", "clotr-guard.js"), ...args], {
    input: JSON.stringify(event),
    env: { ...process.env, CLOTR_GUARD_DATA_DIR: data, HOME: home, ...env },
    encoding: "utf8",
    timeout: 30000,
    cwd: proj,
  });
  return { code: out.status, stdout: (out.stdout || "").trim(), stderr: (out.stderr || "").trim() };
}

const prompt = `please use ${madeUpKey} for the deploy`;
const promptEvent = (tool) =>
  tool === "windsurf"
    ? { tool_info: { user_prompt: prompt } }
    : tool === "cline"
      ? { userPromptSubmit: { prompt } }
      : { prompt, session_id: "caught", cwd: proj };
const readEvent = (tool, file) =>
  tool === "cursor"
    ? { file_path: file, content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" }
    : tool === "windsurf"
      ? { tool_info: { file_path: file } }
      : tool === "cline"
        ? { preToolUse: { toolName: "read_file", parameters: { path: file } } }
        : { tool_name: tool === "gemini" ? "read_file" : "Read", tool_input: { file_path: file }, cwd: proj };

// What the answer does: "stop", "ask" or "through", read from each assistant's own shape.
function verdict(tool, out) {
  if (out.code === 2) return "stop";
  assert.equal(out.code, 0, `${tool} exited ${out.code}: ${out.stderr}`);
  const answer = out.stdout ? JSON.parse(out.stdout) : {};
  const hook = answer.hookSpecificOutput || {};
  if (hook.permissionDecision === "ask" || answer.permission === "ask") return "ask";
  if (
    answer.decision === "block" ||
    answer.decision === "deny" ||
    answer.continue === false ||
    answer.cancel === true ||
    answer.permission === "deny" ||
    hook.permissionDecision === "deny"
  ) {
    return "stop";
  }
  return "through";
}
const shown = (out) => `${out.stdout}\n${out.stderr}`;

for (const way of WAYS) {
  test(`${way.id}: the prompt hook stops the prompt and says how to fix it`, () => {
    for (const tool of ["claude", "cursor", "gemini", "codex", "windsurf", "cline"]) {
      const out = run(way.root, ["hook", tool], promptEvent(tool), way.env);
      assert.equal(verdict(tool, out), "stop", `${tool}: ${shown(out)}`);
      assert.ok(
        shown(out).includes(
          `Clotr hit an error and couldn't check this prompt, so it was stopped. Try again. If it keeps happening, run clotr-guard setup ${tool} again.`,
        ),
        `${tool}: ${shown(out)}`,
      );
      assert.doesNotMatch(shown(out), /went through/, tool);
    }
  });

  test(`${way.id}: the read hook asks in claude and stops the read in the other tools`, () => {
    for (const tool of ["claude", "cursor", "gemini", "windsurf", "cline"]) {
      const out = run(way.root, ["read", tool], readEvent(tool, keyed), way.env);
      assert.equal(verdict(tool, out), tool === "claude" ? "ask" : "stop", `${tool}: ${shown(out)}`);
      assert.match(
        shown(out),
        tool === "claude"
          ? /Clotr hit an error and couldn't check .*, so it's asking first\. Allow the read only if you want the assistant to see it\./
          : /Clotr hit an error and couldn't check .*, so it wasn't read\. Tell the person what you were trying to read and let them decide; don't try to read it another way\./,
        tool,
      );
      // A .env never goes through either: it's stopped by its name, or asked about or stopped as a failed check.
      const env = run(way.root, ["read", tool], readEvent(tool, path.join(proj, ".env")), way.env);
      assert.notEqual(verdict(tool, env), "through", `${tool} .env: ${shown(env)}`);
    }
  });

  test(`${way.id}: the tool hook asks first`, () => {
    for (const tool of ["claude", "cursor"]) {
      const event = { tool_name: "mcp__files__write", tool_input: { text: prompt }, cwd: proj };
      const out = run(way.root, ["tool", tool], event, way.env);
      assert.equal(verdict(tool, out), "ask", `${tool}: ${shown(out)}`);
      assert.ok(
        shown(out).includes("Clotr hit an error and couldn't check these tool arguments, so it's asking first."),
        `${tool}: ${shown(out)}`,
      );
    }
  });

  test(`${way.id}: the shell hook stops the command as a check that hit an error`, () => {
    for (const tool of ["claude", "cursor"]) {
      const event =
        tool === "cursor"
          ? { command: "cat .env", cwd: proj }
          : { tool_name: "Bash", tool_input: { command: "cat .env" }, cwd: proj };
      const out = run(way.root, ["shell", tool], event, way.env);
      assert.equal(verdict(tool, out), "stop", `${tool}: ${shown(out)}`);
      if (way.env) assert.match(shown(out), /its check hit an internal error/, tool);
      assert.doesNotMatch(shown(out), /didn't finish in time/, tool);
    }
  });
}

test("a read of a file that isn't there, or is on another computer, still goes through with the note", () => {
  const files = [path.join(proj, "not-there.txt"), "/net/remote.example/export/notes.md"];
  for (const file of files) {
    for (const tool of ["claude", "gemini"]) {
      const out = run(GUARD, ["read", tool], readEvent(tool, file));
      assert.equal(verdict(tool, out), "through", `${tool} ${file}: ${shown(out)}`);
      assert.ok(shown(out).includes("Clotr couldn't check this read, so it went through."), `${tool} ${file}`);
    }
  }
});

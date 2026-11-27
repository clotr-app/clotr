"use strict";
// Guard's hook commands for a user folder or install path that holds an apostrophe, straight or curly. PowerShell
// reads the curly ones as quote marks too, so a path like C:\Users\O’Brien has to be quoted for that. Every path here
// is made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
}
const { gitHookBody } = require("../apps/guard/lib/setup/git-hook-setup.js");
const { parseHookCommand } = require("../apps/guard/lib/setup/hook-command-reader.js");
const { hookCommand } = require("../apps/guard/lib/setup/hook-command-writer.js");

// PowerShell's single quote marks: the straight one, and U+2018, U+2019, U+201A and U+201B.
const PS_QUOTES = "'\u2018\u2019\u201a\u201b";

// Read a hook command the way PowerShell's tokenizer reads `& 'a' 'b' ...`. Any of its quote marks opens or closes
// a single-quoted string, and two of them in a row stand for the second one. Anything else, or a string that runs
// into the next word, gives null, since PowerShell would then read the command some other way.
function powershellWords(source) {
  let index = 0;
  const words = [];
  const space = () => {
    while (source[index] === " ") index += 1;
  };
  if (source[index] !== "&") return null;
  index += 1;
  space();
  while (index < source.length) {
    if (!PS_QUOTES.includes(source[index])) return null;
    index += 1;
    let value = "";
    let closed = false;
    while (index < source.length) {
      const character = source[index];
      if (PS_QUOTES.includes(character)) {
        if (index + 1 < source.length && PS_QUOTES.includes(source[index + 1])) {
          value += source[index + 1];
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      value += character;
      index += 1;
    }
    if (!closed) return null;
    if (index < source.length && source[index] !== " ") return null;
    words.push(value);
    space();
  }
  return words;
}

const NAMES = [
  ["U+2019", "O\u2019Brien"],
  ["U+2018", "O\u2018Brien"],
  ["a straight apostrophe", "O'Brien"],
  ["U+201A", "O\u201aBrien"],
  ["U+201B", "O\u201bBrien"],
];

// The Windows key each tool's hook runs under PowerShell.
const POWERSHELL_KEYS = { cursor: "command", gemini: "command", windsurf: "powershell", codex: "commandWindows" };

for (const [label, name] of NAMES) {
  test(`Windows hooks keep a path with ${label} whole in PowerShell`, () => {
    const node = `C:\\Users\\${name}\\AppData\\Local\\nodejs\\node.exe`;
    const script = `C:\\Users\\${name}\\AppData\\Roaming\\npm\\node_modules\\clotr-guard\\bin\\clotr-guard.js`;
    for (const [tool, key] of Object.entries(POWERSHELL_KEYS)) {
      const hook = hookCommand(tool, "prompt", "medium", false, { platform: "win32", node, script });
      const expected = [node, path.resolve(script), "hook", tool, "--min-severity", "medium"];
      assert.deepEqual(powershellWords(hook[key]), expected, `${tool} as PowerShell reads it`);
      assert.deepEqual(parseHookCommand(hook[key]), expected, `${tool} as Guard reads it back`);
    }
  });

  test(`Claude Code's Windows hook passes a path with ${label} as its own argument`, () => {
    const node = `C:\\Users\\${name}\\node.exe`;
    const script = `C:\\Users\\${name}\\clotr-guard\\bin\\clotr-guard.js`;
    const hook = hookCommand("claude", "prompt", "medium", false, { platform: "win32", node, script });
    assert.equal(hook.command, node);
    assert.equal(hook.args[0], path.resolve(script));
  });

  test(
    `POSIX hooks and the Git hook run with a path holding ${label}`,
    { skip: process.platform === "win32" ? "needs /bin/sh" : false },
    () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clotr-quote-")));
      try {
        const folder = path.join(dir, name);
        fs.mkdirSync(folder);
        // A stand-in for node that prints the arguments it was given, one a line.
        const node = path.join(folder, "node");
        fs.writeFileSync(node, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
        const script = path.join(folder, "clotr-guard.js");
        fs.writeFileSync(script, "");
        for (const tool of ["cursor", "gemini", "windsurf", "codex", "cline"]) {
          const hook = hookCommand(tool, "prompt", "medium", false, { platform: "linux", node, script });
          const run = spawnSync("/bin/sh", ["-c", hook.command], { encoding: "utf8" });
          assert.equal(run.status, 0, run.stderr);
          assert.deepEqual(run.stdout.split("\n").slice(0, -1), [script, "hook", tool, "--min-severity", "medium"]);
          assert.deepEqual(parseHookCommand(hook.command), [node, script, "hook", tool, "--min-severity", "medium"]);
        }
        const body = gitHookBody(path.join(folder, "pre-commit.backup"), script);
        const hookFile = path.join(folder, "pre-commit");
        fs.writeFileSync(hookFile, body, { mode: 0o755 });
        const run = spawnSync("/bin/sh", [hookFile], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        assert.doesNotMatch(run.stderr, /wasn't found/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test("a hook an earlier Guard wrote with one curly apostrophe is still read back as Clotr's", () => {
  const node = "C:\\Users\\O\u2019Brien\\node.exe";
  const script = "C:\\Users\\O\u2019Brien\\clotr-guard\\bin\\clotr-guard.js";
  const old = `& '${node}' '${script}' hook cursor --min-severity medium`.replace(
    / (hook|cursor|--min-severity|medium)/g,
    " '$1'",
  );
  assert.deepEqual(parseHookCommand(old), [node, script, "hook", "cursor", "--min-severity", "medium"]);
});

// Guard 0.1.3 doubled only the straight mark in its PowerShell commands. This writes a hook the way it did.
function powershell013(words) {
  return `& ${words.map((word) => `'${word.replace(/'/g, "''")}'`).join(" ")}`;
}

function eachHook(settings, fn) {
  for (const list of Object.values(settings.hooks || {})) {
    for (const [index, item] of list.entries()) {
      if (Array.isArray(item.hooks)) item.hooks = item.hooks.map(fn);
      else list[index] = fn(item);
    }
  }
  return settings;
}

function hookList(settings) {
  const all = [];
  eachHook(JSON.parse(JSON.stringify(settings)), (hook) => (all.push(hook), hook));
  return all;
}

// Settings holding every hook 0.1.3 wrote for this tool on Windows, plus one hook of the person's own.
function settingsFrom013(setup, tool, node, script) {
  const settings = eachHook(setup.mergeHook({}, tool), (hook) => {
    const [, , action, , , minimum] = setup.parseHookCommand(hook.command);
    const mode = action === "hook" ? "prompt" : action;
    const old = setup.hookCommand(tool, mode, minimum, false, { platform: "win32", node, script });
    old[POWERSHELL_KEYS[tool]] = powershell013([node, script, action, tool, "--min-severity", minimum]);
    return old;
  });
  const first = Object.values(settings.hooks)[0];
  if (Array.isArray(first[0].hooks)) first.push({ hooks: [{ type: "command", command: "echo O’Brien", timeout: 5 }] });
  else first.push({ command: "echo O’Brien" });
  return settings;
}

// Setup and remove with Windows' key order, which reads each tool's PowerShell key first.
function asWindows(fn) {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: real });
  }
}

function checkSetupAndRemove(setup, tool, node, script, dir) {
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const old = settingsFrom013(setup, tool, node, script);
  const oldHooks = hookList(old).filter((hook) => !/^echo /.test(hook.command));
  const file = setup.toolSettingsPath(tool, { home, cwd });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(old, null, 2));
  const isOld = (hook) => oldHooks.some((oldHook) => JSON.stringify(oldHook) === JSON.stringify(hook));
  const isMine = (hook) => /^echo /.test(hook.command);

  asWindows(() => setup.updateSettings(tool, { home, cwd, platform: "win32" }));
  let now = hookList(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(now.filter(isOld).length, 0, `${tool}: setup replaces 0.1.3's hooks`);
  assert.equal(now.filter((hook) => !isOld(hook) && !isMine(hook)).length, oldHooks.length, `${tool}: one each`);
  assert.equal(now.filter(isMine).length, 1, `${tool}: the person's hook stays`);

  fs.writeFileSync(file, JSON.stringify(old, null, 2));
  asWindows(() => setup.updateSettings(tool, { home, cwd, remove: true, platform: "win32" }));
  now = hookList(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(now.filter(isOld).length, 0, `${tool}: remove takes 0.1.3's hooks away`);
  assert.equal(now.length, 1, `${tool}: only the person's hook is left`);
}

test("setup replaces and remove takes away 0.1.3's hook for a curly mark before a straight one", () => {
  const setup = {
    ...require("../apps/guard/lib/setup/assistant-settings-paths.js"),
    ...require("../apps/guard/lib/setup/assistant-settings.js"),
    ...require("../apps/guard/lib/setup/hook-command-writer.js"),
    ...require("../apps/guard/lib/setup/hook-command-reader.js"),
  };
  for (const tool of ["cursor", "gemini"]) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clotr-quote-")));
    try {
      const folder = path.join(dir, "a’'b");
      const node = path.join(folder, "node.exe");
      const script = path.join(folder, "npm", "node_modules", "clotr-guard", "bin", "clotr-guard.js");
      checkSetupAndRemove(setup, tool, node, script, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

for (const name of ["a’’b", "‚‚", "’’’’"]) {
  test(`setup replaces and remove takes away 0.1.3's hook from a source checkout in ${name}`, () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clotr-quote-")));
    try {
      // A copy of Guard in the folder, so the hook names Guard's own script there.
      const copy = path.join(dir, name, "apps", "guard");
      for (const part of ["bin", "lib", "dist", "package.json"]) {
        fs.cpSync(path.join(GUARD_DIR, part), path.join(copy, part), { recursive: true });
      }
      const setup = {
        ...require(path.join(copy, "lib", "setup", "assistant-settings-paths.js")),
        ...require(path.join(copy, "lib", "setup", "assistant-settings.js")),
        ...require(path.join(copy, "lib", "setup", "hook-command-writer.js")),
        ...require(path.join(copy, "lib", "setup", "hook-command-reader.js")),
      };
      const node = path.join(dir, name, "node.exe");
      const script = path.join(copy, "bin", "clotr-guard.js");
      for (const tool of ["cursor", "gemini", "windsurf", "codex"]) {
        checkSetupAndRemove(setup, tool, node, script, path.join(dir, tool));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("setup replaces and remove takes away 0.1.3's hook for a curly mark between two straight ones", () => {
  const setup = {
    ...require("../apps/guard/lib/setup/assistant-settings-paths.js"),
    ...require("../apps/guard/lib/setup/assistant-settings.js"),
    ...require("../apps/guard/lib/setup/hook-command-writer.js"),
    ...require("../apps/guard/lib/setup/hook-command-reader.js"),
  };
  for (const tool of ["cursor", "gemini", "windsurf", "codex"]) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clotr-quote-")));
    try {
      const folder = path.join(dir, "a'’'b");
      const node = path.join(folder, "node.exe");
      const script = path.join(folder, "npm", "node_modules", "clotr-guard", "bin", "clotr-guard.js");
      checkSetupAndRemove(setup, tool, node, script, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("remove leaves a hook alone when the person added a command after 0.1.3's", () => {
  const setup = {
    ...require("../apps/guard/lib/setup/assistant-settings-paths.js"),
    ...require("../apps/guard/lib/setup/assistant-settings.js"),
    ...require("../apps/guard/lib/setup/hook-command-writer.js"),
    ...require("../apps/guard/lib/setup/hook-command-reader.js"),
  };
  const node = "/home/a’'b/node.exe";
  const script = "/home/a’'b/npm/node_modules/clotr-guard/bin/clotr-guard.js";
  for (const tool of ["windsurf", "codex"]) {
    const words = [node, script, "hook", tool, "--min-severity", "medium"];
    const hook = setup.hookCommand(tool, "prompt", "medium", false, { platform: "win32", node, script });
    hook[POWERSHELL_KEYS[tool]] = powershell013(words);
    hook.command += "; echo mine";
    for (const order of ["win32", "linux"]) {
      const real = process.platform;
      Object.defineProperty(process, "platform", { value: order });
      try {
        assert.equal(setup.hookCommandWords(hook, "/work", tool), null, `${tool}, ${order} key order`);
      } finally {
        Object.defineProperty(process, "platform", { value: real });
      }
    }
  }
});

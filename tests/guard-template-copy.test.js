"use strict";
// Making the real env file from its example is an everyday setup step. In PowerShell and cmd it runs with a second
// line or a comment after the copy, and the copy's own line is what copies. A copy that reads the real file, or any
// other secret file, still stops however it's written. Sample values are made up.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Guard loads the engine from its own bundle, which npm's prepack builds; build it here when it's missing.
const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.strictEqual(built.status, 0, built.stderr);
}
const guard = require("../apps/guard/bin/clotr-guard.js");

// A small project with a real env file, a local one, an example env file and some everyday files.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-template-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=made-up-value\n");
  fs.writeFileSync(path.join(root, ".env.local"), "SAMPLE_TOKEN=made-up-value\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SAMPLE_TOKEN=\n");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  return root;
}

// The hook's answer, then each reading on its own: Guard's first one and the shell's own.
function outcomes(root, command, tool) {
  return [undefined, "first", "new"].map((shellReading) => {
    const options = { cwd: root, shellReading };
    const outcome =
      tool === "Cursor"
        ? guard.inspectShell("cursor", { command, cwd: root }, options)
        : guard.inspectShell("claude", { tool_name: tool, tool_input: { command, cwd: root } }, options);
    return [shellReading || "both readings", outcome];
  });
}

// Each copies only the example env file, so each runs.
const RUNS = [
  ["Cursor", "if not exist .env copy .env.example .env ^& echo ok"],
  ["Cursor", "if not exist .env copy /y .env.example .env ^& echo ok"],
  ["PowerShell", "Copy-Item .env.example .env\nnpm install"],
  ["PowerShell", "Copy-Item .env.example .env  # first run only"],
  ["PowerShell", "Copy-Item .env.example .env -Force\nnpm install"],
  ["PowerShell", "Copy-Item -Path .env.example -Destination .env  # first run only"],
  ["PowerShell", "cp .env.example .env  # first run only"],
  ["PowerShell", "cp .env.example .env\nnpm install"],
  ["PowerShell", "copy .env.example .env\r\nnpm install"],
  ["PowerShell", "Copy-Item .env.example .env"],
  ["PowerShell", "copy .env.example .env"],
  ["PowerShell", "cp .env.example .env"],
  ["Cursor", "Copy-Item .env.example .env"],
  ["Cursor", "copy .env.example .env"],
  ["Cursor", "cp .env.example .env"],
  ["Bash", "cp .env.example .env"],
  // Words like functions, source and alias before or around a copy don't rename it.
  ["Bash", "cp supabase/functions/.env.example supabase/functions/.env"],
  ["Cursor", "cp supabase/functions/.env.example supabase/functions/.env"],
  ["Bash", "cd functions && cp .env.example .env"],
  ["Bash", "source .venv/bin/activate && cp .env.example .env"],
  ["Cursor", "source .venv/bin/activate && cp .env.example .env"],
  ["Bash", "git config alias.st status && cp .env.example .env"],
  ["Bash", "cp .env.example .env && gh workflow run deploy.yml"],
  ["Cursor", 'cp .env.example .env && echo "add a function later"'],
  // Bash's hash alone, -r and -d don't point a copy at another program.
  ["Bash", "hash; cp .env.example .env"],
  ["Cursor", "hash; cp .env.example .env"],
  ["Bash", "hash -r; cp .env.example .env"],
  ["Cursor", "hash -r; cp .env.example .env"],
  ["Bash", "hash -d cp; cp .env.example .env"],
  ["Cursor", "hash -d cp; cp .env.example .env"],
  // builtin, command and a leading backslash before something that renames nothing. command -v only
  // describes the word after it.
  ["Bash", "command -v cp && cp .env.example .env"],
  ["Cursor", "command -v cp && cp .env.example .env"],
  ["Bash", "builtin cd app; cp .env.example .env"],
  ["Cursor", "builtin cd app; cp .env.example .env"],
  ["Bash", "command cp .env.example .env"],
  ["Cursor", "command cp .env.example .env"],
  ["Bash", String.raw`\cp .env.example .env`],
  ["Cursor", String.raw`\cp .env.example .env`],
  ["Bash", "command -v hash -p /usr/bin/cat cp; cp .env.example .env"],
  ["Cursor", "command -v hash -p /usr/bin/cat cp; cp .env.example .env"],
  ["PowerShell", String.raw`copy .\.env.example .env`],
  ["Cursor", String.raw`copy .\.env.example .env`],
  // Bash's if, while, time and `!` before a command that renames nothing. `!hash` with no space is a
  // command of that name, not `!`.
  ["Bash", "if [ -f .env ]; then echo ok; fi; cp .env.example .env"],
  ["Cursor", "if [ -f .env ]; then echo ok; fi; cp .env.example .env"],
  ["Bash", "while read l; do echo $l; done < list.txt; cp .env.example .env"],
  ["Cursor", "while read l; do echo $l; done < list.txt; cp .env.example .env"],
  ["Bash", "time npm ci && cp .env.example .env"],
  ["Cursor", "time npm ci && cp .env.example .env"],
  ["Bash", "! grep -q x file && cp .env.example .env"],
  ["Cursor", "! grep -q x file && cp .env.example .env"],
  ["Bash", "if command -v cp; then cp .env.example .env; fi"],
  ["Cursor", "if command -v cp; then cp .env.example .env; fi"],
  ["Bash", "!hash -p /usr/bin/cat cp; cp .env.example .env"],
];

for (const [tool, command] of RUNS) {
  test(`${tool}: ${JSON.stringify(command)} copies only the example env file, so it runs`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, tool)) {
      assert.equal(outcome.action, "allow", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

// Each reads the real env file or another secret file, so each stops in the hook.
const STOPPED = [
  ["PowerShell", "Copy-Item .env .env.example\nnpm install"],
  ["PowerShell", "Copy-Item .env .env.example  # keep a copy"],
  ["PowerShell", "cp .env out\nnpm install"],
  ["PowerShell", "Copy-Item .env.local .env  # first run only"],
  ["PowerShell", "Copy-Item .env.example, .env out  # both"],
  ["PowerShell", "Copy-Item .env.example .env -Recurse .env\nnpm install"],
  ["PowerShell", "Copy-Item `\n.env out  # backup"],
  ["Cursor", "if not exist .env.bak copy .env .env.bak ^& echo ok"],
  ["Cursor", "copy .env.example+.env out ^& echo ok"],
  ["Cursor", "copy /y .env.local .env ^& echo ok"],
];

for (const [tool, command] of STOPPED) {
  test(`${tool}: ${JSON.stringify(command)} reads a secret file, so it stops`, (t) => {
    const root = project(t);
    const [[, outcome]] = outcomes(root, command, tool);
    assert.equal(outcome.action, "block", JSON.stringify(outcome));
    assert.ok(!outcome.internalError, "hit an internal error");
    assert.match(String(outcome.location), /\.env/, String(outcome.location));
  });
}

// Each makes the copy command another one first, a function or an alias that prints the file it's given, so
// the example copy reads the real env file. Each stops, as it did before example copies ran. The readings
// named stop it on their own too.
const RENAMED = [
  ["PowerShell", "function Copy-Item { gc $args[1] }; Copy-Item .env.example .env", ["first", "new"]],
  ["PowerShell", "Set-Alias Copy-Item Get-Content; Copy-Item .env.example .env", ["first", "new"]],
  ["PowerShell", "function global:Copy-Item { gc $args[1] }; Copy-Item .env.example .env.local", ["first", "new"]],
  ["PowerShell", "function Copy-Item { gc $args[1] }\nCopy-Item .env.example .env  # first run only", ["first", "new"]],
  ["PowerShell", "Set-Alias -Force cp gc; cp .env.example .env  # x", ["first"]],
  ["Cursor", 'function cp { cat "$2"; }; cp .env.example .env # x', ["first"]],
  ["Cursor", "alias cp=cat; cp .env.example .env # x", ["first"]],
  // The same on one line with nothing after, where the copy's last word is where it writes.
  ["PowerShell", "function copy { gc $args[1] }; copy .env.example .env", ["first", "new"]],
  ["Cursor", "function copy { gc $args[1] }; copy .env.example .env", ["first", "new"]],
  ["PowerShell", "function cp { gc $args[1] }; cp .env.example .env", ["first", "new"]],
  ["Cursor", "function cp { gc $args[1] }; cp .env.example .env", ["first", "new"]],
  ["PowerShell", "Set-Alias copy gc; copy .env.example .env", ["first", "new"]],
  ["Cursor", "Set-Alias copy gc; copy .env.example .env", ["first", "new"]],
  ["PowerShell", "New-Alias copy gc; copy .env.example .env", ["first", "new"]],
  ["PowerShell", "sal cp gc; cp .env.example .env", ["first", "new"]],
  ["PowerShell", "nal copy gc; copy .env.example .env", ["first", "new"]],
  ["PowerShell", "Set-Item function:copy { gc $args[1] }; copy .env.example .env", ["first", "new"]],
  ["Cursor", "Set-Item function:copy { gc $args[1] }; copy .env.example .env", ["first", "new"]],
  ["Bash", 'cp() { cat "$2"; }; cp .env.example .env', ["first", "new"]],
  ["Cursor", 'cp() { cat "$2"; }; cp .env.example .env', ["first", "new"]],
  ["Bash", 'function cp { cat "$2"; }; cp .env.example .env', ["first", "new"]],
  ["Bash", "alias cp=cat; cp .env.example .env", ["first", "new"]],
  ["Cursor", "alias cp=cat; cp .env.example .env", ["first", "new"]],
  ["PowerShell", "iex 'sal copy gc'; copy .env.example .env", ["first", "new"]],
  ["Bash", 'if true; then function cp { cat "$2"; }; fi; cp .env.example .env', ["first", "new"]],
  // Bash's hash -p points the copy at another program, -p alone, after an option or holding its path.
  ["Bash", "hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "hash -p /bin/cat copy; copy .env.example .env", ["first", "new"]],
  ["Cursor", "hash -p /bin/cat copy; copy .env.example .env", ["first", "new"]],
  ["Bash", "hash -l -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "hash -l -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "hash -lp /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "hash -lp /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "hash -p/usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "hash -p/usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  // The same through builtin, command or a leading backslash, which still run Bash's own hash or alias.
  ["Bash", "builtin hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "builtin hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "command hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "command hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "command -p hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "command -p hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", String.raw`\hash -p /usr/bin/cat cp; cp .env.example .env`, ["first", "new"]],
  ["Cursor", String.raw`\hash -p /usr/bin/cat cp; cp .env.example .env`, ["first", "new"]],
  ["Bash", "builtin alias cp=cat; cp .env.example .env", ["first", "new"]],
  ["Cursor", "builtin alias cp=cat; cp .env.example .env", ["first", "new"]],
  ["Bash", "command alias cp=cat; cp .env.example .env", ["first", "new"]],
  ["Cursor", "command alias cp=cat; cp .env.example .env", ["first", "new"]],
  ["Bash", String.raw`\alias cp=cat; cp .env.example .env`, ["first", "new"]],
  ["Cursor", String.raw`\alias cp=cat; cp .env.example .env`, ["first", "new"]],
  ["Bash", "command builtin hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "builtin -- hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", String.raw`\builtin alias cp=cat; cp .env.example .env`, ["first", "new"]],
  // The same after Bash's if, elif, while, until, time or `!`, where a command starts too.
  ["Bash", "if hash -p /usr/bin/cat cp; then cp .env.example .env; fi", ["new"]],
  ["Cursor", "if hash -p /usr/bin/cat cp; then cp .env.example .env; fi", ["new"]],
  ["Bash", "if false; then :; elif hash -p /usr/bin/cat cp; then cp .env.example .env; fi", ["new"]],
  ["Cursor", "if false; then :; elif hash -p /usr/bin/cat cp; then cp .env.example .env; fi", ["new"]],
  ["Bash", "while hash -p /usr/bin/cat cp; do break; done; cp .env.example .env", ["first", "new"]],
  ["Cursor", "while hash -p /usr/bin/cat cp; do break; done; cp .env.example .env", ["first", "new"]],
  ["Bash", "until hash -p /usr/bin/cat cp; do :; done; cp .env.example .env", ["first", "new"]],
  ["Cursor", "until hash -p /usr/bin/cat cp; do :; done; cp .env.example .env", ["first", "new"]],
  ["Bash", "! hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "! hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "time hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "time hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "time -p hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Cursor", "time -p hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "time -p -- hash -p /usr/bin/cat cp; cp .env.example .env", ["first", "new"]],
  ["Bash", "if alias cp=cat; then :; fi\ncp .env.example .env", ["first", "new"]],
  ["Cursor", "if alias cp=cat; then :; fi\ncp .env.example .env", ["first", "new"]],
  ["Bash", "! alias cp=cat\ncp .env.example .env", ["first", "new"]],
  ["Bash", "time -p alias cp=cat\ncp .env.example .env", ["first", "new"]],
  ["Bash", 'if function cp { cat "$2"; }; then cp .env.example .env; fi', ["new"]],
];

for (const [tool, command, readings] of RENAMED) {
  test(`${tool}: ${JSON.stringify(command)} renames the copy first, so it stops`, (t) => {
    const root = project(t);
    const stopping = outcomes(root, command, tool).filter(([reading]) => {
      return reading === "both readings" || readings.includes(reading);
    });
    for (const [reading, outcome] of stopping) {
      assert.equal(outcome.action, "block", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
      assert.match(String(outcome.location), /\.env/, `${reading}: ${outcome.location}`);
    }
  });
}

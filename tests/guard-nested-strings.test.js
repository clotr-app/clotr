// Guard's shell check and a reader inside a string handed to something else: a shell (`bash -c`, `cmd /c`,
// `powershell -Command`), PowerShell's Start-Process, or inline code (`python -c`, `node -e`). Also a rare character,
// U+10FFFF, which the check must answer for rather than stop on.
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
const { embeddedReaders } = require("../apps/guard/lib/shell-reading/nested-commands.js");

// A small project with a .env and ordinary files. The value is made up.
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-nested-"));
  const made = ["made", "up", "value"].join("-");
  fs.writeFileSync(path.join(dir, ".env"), `APP_TOKEN=${made}\n`);
  fs.writeFileSync(path.join(dir, ".env.example"), "APP_TOKEN=\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "notes\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function answer(shell, command, cwd) {
  if (shell === "cursor") return guard.inspectShell("cursor", { command, cwd }, { cwd });
  return guard.inspectShell("claude", { tool_name: shell, tool_input: { command } }, { cwd });
}

// One test for each case, so each is seen on its own: [shell, command] pairs stopped at .env, or let through.
function eachStopped(title, cases) {
  for (const [shell, command] of cases) {
    test(`${title}, stopped: ${shell} ${command}`, (t) => {
      const outcome = answer(shell, command, project(t));
      assert.strictEqual(outcome.action, "block");
      assert.strictEqual(outcome.location, ".env");
    });
  }
}

function eachAllowed(title, cases) {
  for (const [shell, command] of cases) {
    test(`${title}, let through: ${shell} ${command}`, (t) => {
      assert.strictEqual(answer(shell, command, project(t)).action, "allow");
    });
  }
}

test("a U+10FFFF character gets an answer, not an internal error", (t) => {
  const cwd = project(t);
  const commands = [
    "echo $'\\U0010FFFF'",
    "echo \u{10ffff}",
    'echo "`u{10FFFF}"',
    "echo $'\\U00110000'",
    'echo "`u{110000}"',
    "echo \ud800",
  ];
  for (const shell of ["Bash", "PowerShell", "cursor"]) {
    for (const command of commands) {
      const outcome = answer(shell, command, cwd);
      assert.strictEqual(outcome.action, "allow", `${shell}: ${JSON.stringify(command)}`);
    }
  }
});
eachStopped("U+10FFFF", [
  ["Bash", "cat \u{10ffff} .env"],
  ["PowerShell", "cat \u{10ffff} .env"],
  ["cursor", "cat \u{10ffff} .env"],
]);

eachStopped("another shell's escapes", [
  ["Bash", 'bash -c "cat \\".env\\""'],
  ["Bash", "bash -c 'cat .e\\nv'"],
  ["Bash", 'sh -c "cat \\.env"'],
  ["Bash", "sh -c 'cat \".e\"nv'"],
  ["Bash", "bash -c \"cat \\$'\\\\x2eenv'\""],
  ["Bash", 'cmd /c "type .e^nv"'],
  ["PowerShell", 'cmd /c "type .e^nv"'],
  ["Bash", "pwsh -c 'gc .e`nv'"],
  ["PowerShell", "powershell -Command 'gc .e`nv'"],
  ["PowerShell", 'powershell -Command "gc .e``nv"'],
]);

eachStopped("Start-Process", [
  ["PowerShell", "Start-Process cat -ArgumentList '.env' -NoNewWindow -Wait"],
  ["PowerShell", "Start-Process cmd -ArgumentList '/c type .env'"],
  ["PowerShell", "Start-Process cmd '/c type .env'"],
  ["PowerShell", 'Start-Process cmd -ArgumentList "/c type .e^nv"'],
  ["PowerShell", "Start-Process -FilePath bash -ArgumentList '-c','cat .env'"],
  ["PowerShell", "Start-Process powershell -ArgumentList '-Command', 'gc .env'"],
  ["PowerShell", "Start-Process -Wait -NoNewWindow -FilePath cat -ArgumentList .env"],
  ["PowerShell", "Start-Process -FilePath:cat -ArgumentList:.env"],
  ["PowerShell", "saps cat .env"],
  ["PowerShell", "start cat .env"],
  ["PowerShell", "Start-Process -FilePath sort -RedirectStandardInput .env -Wait"],
  ["cursor", "Start-Process cat .env"],
  ["Bash", 'pwsh -c "Start-Process cat .env"'],
]);
eachAllowed("Start-Process", [
  ["PowerShell", "Start-Process cmd '/c type notes.txt'"],
  ["PowerShell", "Start-Process notepad -ArgumentList notes.txt"],
  ["PowerShell", "Start-Process cat .env.example -Wait"],
  ["PowerShell", "Start-Process -FilePath sort -RedirectStandardInput notes.txt -RedirectStandardOutput .env"],
]);

eachStopped("inline code", [
  ["Bash", 'python -c "print(open(\\".env\\").read())"'],
  ["PowerShell", 'python -c "print(open(\\".env\\").read())"'],
  ["Bash", "python -c \"import pathlib; print(pathlib.Path('.env').read_text())\""],
  ["Bash", "python3 -c \"from pathlib import Path; print(Path('.env').read_text())\""],
  ["Bash", 'python3 -c "from pathlib import Path; print(Path(\\".env\\").read_bytes())"'],
  ["Bash", "python3 -c \"import os; print(open(os.path.join('.', '.env')).read())\""],
  ["Bash", "node -e \"console.log(require('fs').readFileSync(\\\".env\\\",'utf8'))\""],
  ["Bash", "node -e \"const fs=require('fs');const p='.env';console.log(fs.readFileSync(p,'utf8'))\""],
  ["Bash", 'node -e \'console.log(require("fs").readFileSync(`.env`,"utf8"))\''],
]);
eachAllowed("inline code", [
  ["Bash", 'python -c "print(open(\\"notes.txt\\").read())"'],
  ["Bash", "python3 -c \"import os; print(os.path.join('.', '.env'))\""],
  ["Bash", "python3 -c \"from pathlib import Path; print(Path('.env').exists())\""],
  ["Bash", "node -e \"const p='.env.example';console.log(require('fs').readFileSync(p,'utf8'))\""],
]);

// Inline code with many short reads by name: the check reads the code's assignments once, not once a call.
test("inline code with many short reads through a name is checked inside 2 seconds", (t) => {
  const cwd = project(t);
  const command = `python -c "${"open(a);".repeat(20480)}"`;
  const started = process.hrtime.bigint();
  const result = answer("Bash", command, cwd);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.strictEqual(result.action, "allow");
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

// A quoted name in inline code followed by a long run of backslashes: the inline-code reader reads it in one
// pass, so 64,000 backslashes take a few milliseconds, not seconds. The reader is timed on its own, since the
// hook's time also holds starting git, and the hook gives an answer rather than stopping at its time limit.
const BACKSLASH_RUNS = [
  ["an escaped quote", "Bash", (run) => `python -c "open(\\"${run}'`],
  ["pathlib", "PowerShell", (run) => `python -c "Path('${run}'`],
  ["a joined path", "cursor", (run) => `python -c "open(os.path.join(${run}))"`],
  ["a name set first", "Bash", (run) => `python -c "p='${run}; open(p)"`],
];
for (const [form, shell, make] of BACKSLASH_RUNS) {
  const command = make("\\".repeat(64000));
  test(`inline code with 64,000 backslashes is read inside half a second: ${form}`, (t) => {
    const started = process.hrtime.bigint();
    assert.deepStrictEqual(embeddedReaders(command), []);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
    const result = answer(shell, command, project(t));
    assert.strictEqual(result.action, "allow", JSON.stringify(result));
  });
}

"use strict";
// A variable Guard can't see the value of may be empty, and then the shell opens the name around it: `cat $u.env`
// opens `.env` when `u` is unset. Each of these reads a secret file that way and is stopped in every reading, and the
// everyday commands below them still run. Sample values are made up.
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

// A small project with a .env at its top and in a subfolder, an example env file and some everyday files.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-empty-variable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=made-up-value\n");
  fs.writeFileSync(path.join(root, "sub", ".env"), "SAMPLE_TOKEN=made-up-value\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SAMPLE_TOKEN=\n");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  fs.writeFileSync(path.join(root, "config.json"), "{}\n");
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

const STOPPED = [
  ["Bash", "cat $u.env"],
  ["Bash", "cat ${u}.env"],
  ["Bash", "cat ./$u.env"],
  ["Bash", "cat .e$@nv"],
  ["Bash", "cat .e$1nv"],
  ["Bash", 'cat .e"$u"nv'],
  ["Bash", "cat .e${u}nv"],
  ["Bash", 'cat "$u".env'],
  ["Bash", "cat sub/$u.env"],
  ["Cursor", "type %u%.env"],
];

for (const [tool, command] of STOPPED) {
  test(`${tool}: ${command} reads .env when the variable is empty, so it stops`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, tool)) {
      assert.equal(outcome.action, "block", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
      assert.match(String(outcome.location), /\.env$/, `${reading}: ${outcome.location}`);
    }
  });
}

const RUNS = [
  "cat $HOME/notes.txt",
  'cat "$dir/README.md"',
  "cat $file",
  "cat ${name}.json",
  "cp .env.example $out",
  "echo $u.env",
];

for (const command of RUNS) {
  test(`Bash: ${command} names no secret file with its variable empty, so it runs`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, "Bash")) {
      assert.equal(outcome.action, "allow", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

// A grep or rg search pattern with a variable in it is text to match, not a file to open, so it stays as written
// while the files after it are read with the variable empty. One of these runs in a folder with no .env at all.
const SEARCHES = [
  ['grep -r "$u.env" docs', "project"],
  ['grep -r "$u.env" docs', "bare folder"],
  ['grep -rn "$PREFIX.env" src', "project"],
  ['grep "$u.env" README.md', "project"],
  ['grep -e "$u.env" -r docs', "project"],
  ['grep "$NAME.env" .gitignore', "project"],
  ['rg "$u.env" docs', "project"],
];

function bareFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-empty-variable-bare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# guide\n");
  return root;
}

for (const [command, where] of SEARCHES) {
  test(`Bash: ${command} in a ${where} searches for a pattern with a variable in it, so it runs`, (t) => {
    const root = where === "project" ? project(t) : bareFolder(t);
    for (const [reading, outcome] of outcomes(root, command, "Bash")) {
      assert.equal(outcome.action, "allow", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

test("Bash: grep x $u.env searches .env when the variable is empty, so it stops", (t) => {
  const root = project(t);
  for (const [reading, outcome] of outcomes(root, "grep x $u.env", "Bash")) {
    assert.equal(outcome.action, "block", `${reading}: ${JSON.stringify(outcome)}`);
    assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    assert.match(String(outcome.location), /\.env$/, `${reading}: ${outcome.location}`);
  }
});

// PowerShell's and cmd's own search tools: their pattern word names no file, but their file words do.
const OTHER_SEARCHES = [
  ["PowerShell", 'Select-String "$u.env" docs\\*.md'],
  ["PowerShell", 'sls "$u.env" *.md'],
  ["Cursor", 'findstr /s "%u%.env" *.md'],
  ["PowerShell", 'Select-String -Pattern "$u.env" -Path docs\\*.md'],
  ["Cursor", 'findstr "%u%.env" README.md'],
];

for (const [tool, command] of OTHER_SEARCHES) {
  test(`${tool}: ${command} searches for a pattern with a variable in it, so it runs`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, tool)) {
      assert.equal(outcome.action, "allow", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

const OTHER_SEARCH_READS = [
  ["PowerShell", "Select-String TOKEN $u.env"],
  ["PowerShell", "Select-String -Path $u.env -Pattern TOKEN"],
  ["Cursor", "findstr TOKEN %u%.env"],
];

for (const [tool, command] of OTHER_SEARCH_READS) {
  test(`${tool}: ${command} searches .env when the variable is empty, so it stops`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, tool)) {
      assert.equal(outcome.action, "block", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

// The same searches spelled with a common parameter before the pattern, with the search after an assignment or
// `cmd /c`, with its module's name, or with the pattern in `( )` or `@( )`: the pattern still names no file.
const MORE_SEARCHES = [
  ["PowerShell", 'Select-String -ErrorAction SilentlyContinue "$u.env" *.md'],
  ["PowerShell", 'sls -ea 0 "$u.env" *.md'],
  ["PowerShell", 'Select-String -OutVariable hits "$u.env" *.md'],
  ["PowerShell", 'Select-String -Path *.md -ea 0 "$u.env"'],
  ["PowerShell", 'Select-String -InputObject "$u.env" -Pattern x'],
  ["PowerShell", '$r = Select-String "$u.env" *.md'],
  ["PowerShell", '$hits = sls "$u.env" *.md'],
  ["Cursor", 'cmd /c findstr /s "%u%.env" *.md'],
  ["PowerShell", 'Microsoft.PowerShell.Utility\\Select-String "$u.env" *.md'],
  ["PowerShell", 'sls ("$u.env") *.md'],
  ["Cursor", 'sls ("$u.env") *.md'],
  ["PowerShell", 'sls @("$u.env") *.md'],
  ["Cursor", 'sls @("$u.env") *.md'],
];

for (const [tool, command] of MORE_SEARCHES) {
  test(`${tool}: ${command} searches for a pattern with a variable in it, so it runs`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, tool)) {
      assert.equal(outcome.action, "allow", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

// The file word stays emptied in those spellings, so a read of .env still stops. Guard's first reading alone doesn't
// see a search after `$name =` or by its module's name even with `.env` written out, so there it answers as it does
// for that.
const MORE_SEARCH_READS = [
  ["PowerShell", "Select-String -ErrorAction SilentlyContinue TOKEN $u.env"],
  ["PowerShell", "$r = Select-String TOKEN $u.env"],
  ["Cursor", "cmd /c findstr TOKEN %u%.env"],
  ["PowerShell", "Microsoft.PowerShell.Utility\\Select-String -Path $u.env -Pattern TOKEN"],
];

for (const [tool, command] of MORE_SEARCH_READS) {
  test(`${tool}: ${command} searches .env when the variable is empty, so it stops`, (t) => {
    const root = project(t);
    const written = outcomes(root, command.replace(/\$u|%u%/, ""), tool);
    for (const [index, [reading, outcome]] of outcomes(root, command, tool).entries()) {
      const action = reading === "first" ? written[index][1].action : "block";
      assert.equal(outcome.action, action, `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

// The search after an operator assignment, with patterns or a parameter's command in `( )` or `@( )`, or with
// `-InputObject:` and a colon: the pattern still names no file, so these run.
const GROUPED_SEARCHES = [
  ["PowerShell", '$r += sls "$u.env" *.md'],
  ["PowerShell", '$r -= sls "$u.env" *.md'],
  ["PowerShell", '$r += sls -SimpleMatch "$u.env" *.md'],
  ["PowerShell", 'sls ("$u.env", "x") *.md'],
  ["PowerShell", 'sls @("$u.env", "x") *.md'],
  ["PowerShell", 'sls -Pattern ("$u.env","x") *.md'],
  ["PowerShell", 'sls -Path (gci -r *.md) "$u.env"'],
  ["PowerShell", 'sls -Path @(gci -r *.md) "$u.env"'],
  ["PowerShell", 'sls -Path (gci *.md) -Pattern "$u.env"'],
  ["PowerShell", 'sls -InputObject:"$u.env" -Pattern x'],
  ["PowerShell", "sls -InputObject:$u.env -Pattern x"],
];

for (const [tool, command] of GROUPED_SEARCHES) {
  test(`${tool}: ${command} searches for a pattern with a variable in it, so it runs`, (t) => {
    const root = project(t);
    for (const [reading, outcome] of outcomes(root, command, tool)) {
      assert.equal(outcome.action, "allow", `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

// The same spellings reading a file through a variable: the file word stays emptied, so these stop. Guard's first
// reading alone doesn't see a command after `$name +=` even with `.env` written out, so there it answers as it does
// for that.
const GROUPED_SEARCH_READS = [
  ["PowerShell", "$r += Get-Content $u.env"],
  ["PowerShell", "$r += sls TOKEN $u.env"],
  ["PowerShell", "sls -Path ($u.env) TOKEN"],
  ["PowerShell", 'sls TOKEN ($u.env, "x.md")'],
  ["PowerShell", "sls -InputObject:x -Path $u.env TOKEN"],
];

for (const [tool, command] of GROUPED_SEARCH_READS) {
  test(`${tool}: ${command} reads .env when the variable is empty, so it stops`, (t) => {
    const root = project(t);
    const written = outcomes(root, command.replace(/\$u/, ""), tool);
    for (const [index, [reading, outcome]] of outcomes(root, command, tool).entries()) {
      const action = reading === "first" ? written[index][1].action : "block";
      assert.equal(outcome.action, action, `${reading}: ${JSON.stringify(outcome)}`);
      assert.ok(!outcome.internalError, `${reading} hit an internal error`);
    }
  });
}

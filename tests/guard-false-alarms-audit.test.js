// Everyday commands an audit of Guard 0.1.2 against 0.1.1 found newly stopped, each beside a near twin that reads a
// secret file and still stops. Sample values are made up and harmless.
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

// A project with docs that mention secret files by name, and the secret files themselves.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "README.md"), "Keep credentials and id_rsa out of Git.\n");
  fs.writeFileSync(path.join(root, "docs", "setup.md"), "Copy .env.example to .env, then add credentials.\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SAMPLE=\n");
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "credentials.json"), "{}\n");
  return root;
}

// The tool that runs a command: Claude's Bash tool, its PowerShell tool, or Cursor, whose terminal could be either.
// Each reading is tried on its own too: Guard's first one and the shell's own.
function outcomes(root, command, toolName) {
  return [undefined, "first", "new"].map((shellReading) => {
    const options = { cwd: root, shellReading };
    const outcome =
      toolName === "Cursor"
        ? guard.inspectShell("cursor", { command, cwd: root }, options)
        : guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, options);
    return [shellReading || "both readings", outcome];
  });
}

function assertAllowed(root, command, toolName) {
  for (const [reading, outcome] of outcomes(root, command, toolName)) {
    assert.equal(outcome.action, "allow", `${toolName}, ${reading}: ${JSON.stringify(command)}`);
    assert.ok(!outcome.internalError, `${toolName}, ${reading}: ${JSON.stringify(command)} hit an internal error`);
  }
}

function assertBlocked(root, command, toolName) {
  const [[, outcome]] = outcomes(root, command, toolName);
  assert.equal(outcome.action, "block", `${toolName}: ${JSON.stringify(command)}`);
}

test("a search's pattern that names a secret file isn't read as a file it searches", (t) => {
  const root = project(t);
  for (const [command, toolName] of [
    ['rg -n "credentials" README.md docs', "Bash"],
    ['rg -n "\\.env" docs/setup.md', "Bash"],
    ["rg -n id_rsa README.md", "Cursor"],
    ["Select-String -Path docs/setup.md -Pattern 'credentials'", "Cursor"],
    ["Select-String -Path README.md -Pattern '\\.env'", "Cursor"],
    ["Select-String -Pattern:credentials -Path README.md", "PowerShell"],
    ["sls -Path README.md -Patt id_rsa", "PowerShell"],
    ['findstr /i "credentials" docs\\setup.md', "Cursor"],
    ['findstr /n ".env" docs\\setup.md', "PowerShell"],
    ['findstr /i "id_rsa" README.md', "Cursor"],
    ["rg id_rsa README.md", "Bash"],
  ]) {
    assertAllowed(root, command, toolName);
  }
  // Cursor's terminal may be Git Bash, where findstr reads the word after `/n` as a file: only where none is there.
  fs.rmSync(path.join(root, ".env"));
  assertAllowed(root, 'findstr /n ".env" docs\\setup.md', "Cursor");
});

test("a search that reads a secret file, or takes its patterns from one, still stops", (t) => {
  const root = project(t);
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    for (const command of [
      "rg FAKE .env",
      "rg -n credentials README.md .env",
      "rg .env .env",
      "rg -f .env README.md",
      "rg -e credentials .env",
      "rg $X .env",
      "rg * README.md",
      "rg -g credentials credentials .env",
      "rg --no-ignore FAKE .",
      "Select-String -Path .env -Pattern x",
      "Select-String -Pattern x -Path .env",
      "Select-String -Pattern .env -Path .env",
      "Select-String -Path README.md -Pattern (Get-Content .env)",
      "Select-String -- -Pattern .env",
      "Select-String -Pattern:x .env",
      "Select-String x .env",
      "findstr x .env",
      "findstr /i credentials .env",
      "findstr /c:x .env",
      "findstr .env .env",
      "findstr x README.md .env",
      "findstr %X% .env",
      "findstr /v '/i' .env README.md",
      "rg -v '-n' .env README.md",
      "rg .env README.md",
      // An rg config file can give rg its patterns, so a word that may be a file there is read as one.
      "rg id_rsa. README.md",
      "cd docs && rg id_rsa README.md",
      "echo x > id_rsa; rg id_rsa README.md",
    ]) {
      assertBlocked(root, command, toolName);
    }
    // Windows opens `C:id_rsa` as id_rsa in the working folder of drive C. Elsewhere it's a file of that whole name,
    // which isn't a secret file's.
    if (process.platform === "win32") assertBlocked(root, "rg C:id_rsa README.md", toolName);
  }
  assertBlocked(root, "RIPGREP_CONFIG_PATH=c.cfg rg id_rsa README.md", "Bash");
  // Git Bash hands findstr `/i` as a path, its pattern, so the next word is a file it reads.
  for (const toolName of ["Bash", "Cursor"]) {
    for (const command of [
      "findstr /n .env docs\\setup.md",
      "findstr /i credentials.json README.md",
      "findstr -i/nv .env README.md",
    ]) {
      assertBlocked(root, command, toolName);
    }
  }
});

test("Copy-Item's destination is never read as a file it copies", (t) => {
  const root = project(t);
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    for (const command of [
      "Copy-Item .env.example .env",
      "Copy-Item -Path .env.example -Destination .env",
      "Copy-Item .env.example -Destination .env",
      "cp .env.example .env",
    ]) {
      assertAllowed(root, command, toolName);
    }
    for (const command of [
      "Copy-Item .env backup.txt",
      "Copy-Item -Path .env -Destination backup.txt",
      "Copy-Item -Destination backup.txt .env",
      "Copy-Item .env -Destination backup.txt",
      "Copy-Item -LiteralPath .env backup.txt",
      "Copy-Item .env backup.txt -Recurse",
      "Copy-Item backup.txt -Pat .env",
      "Copy-Item backup.txt -L .env",
      "Copy-Item backup.txt -PSP .env",
      "Copy-Item -d backup.txt .env",
      "Copy-Item -Path: .env backup.txt",
      "Copy-Item -LiteralPath: .env backup.txt",
      "$p = @{Destination = 'backup.txt'}; Copy-Item @p .env",
      "cp .env backup.txt",
      "copy .env backup.txt",
    ]) {
      assertBlocked(root, command, toolName);
    }
  }
});

test("a search's pattern after a word with a / is read as a file only by findstr in Git Bash", (t) => {
  const root = project(t);
  for (const toolName of ["Bash", "Cursor"]) {
    for (const command of [
      "Select-String -Path docs/setup.md -Pattern .env",
      "Select-String -Path docs/setup.md -Pattern '.env'",
      "Select-String -Path docs/setup.md -Pattern 'credentials.json'",
      "Select-String -Path docs/setup.md -Pattern:.env",
      "sls -Path docs/setup.md -Pattern credentials.json",
      "Select-String -Path ./README.md -Pattern credentials.json",
      // Git Bash hands findstr `//i` as `/i`, a switch.
      "findstr //i .env README.md",
    ]) {
      assertAllowed(root, command, toolName);
    }
    for (const command of [
      "Select-String -Path .env -Pattern x",
      "Select-String -Path docs/setup.md, .env -Pattern x",
      // `//c:x` reaches findstr as `/c:x`, its pattern, so the next word is a file it reads.
      "findstr //c:x .env README.md",
      "findstr //i/n .env README.md",
    ]) {
      assertBlocked(root, command, toolName);
    }
  }
  // findstr itself passes over a doubled `/`.
  assertAllowed(root, "findstr //i .env README.md", "PowerShell");
  assertBlocked(root, "findstr //c:x .env README.md", "PowerShell");
});

test("a splat in Copy-Item leaves the words given by place where PowerShell binds them", (t) => {
  const root = project(t);
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    for (const command of [
      "$p=@{ErrorAction='Stop'}; Copy-Item @p .env.example .env",
      "$common=@{Force=$true; ErrorAction='Stop'}; Copy-Item @common .env.example .env",
      "$p=@{Force=$true}; Copy-Item @p .env.example .env.local",
      "$p=@{Force=$true}; Copy-Item @p -Path .env.example .env",
      "$p=@{Force=$true}; Copy-Item .env.example .env @p",
      // The splat names the source, so the one word given by place is the destination.
      "$p=@{Path='.env.example'}; Copy-Item @p .env",
      '$p = @{ LiteralPath = ".env.example"; Force = $true }\nCopy-Item @p .env',
    ]) {
      assertAllowed(root, command, toolName);
    }
    for (const command of [
      "$p = @{Destination = 'backup.txt'}; Copy-Item @p .env",
      "$p=@{Force=$true}; Copy-Item @p .env",
      "$p=@{Force=$true}; Copy-Item @p .env backup.txt",
      "Copy-Item @PSBoundParameters .env",
      // A splat the command doesn't set could name any parameter, so the copy is read as Guard first read it.
      "Copy-Item @PSBoundParameters .env.example .env",
      "$p=@{Path='.env.example'}; Copy-Item @q .env",
      "$p=@{Path='.env.example'}; $p.Remove('Path'); Copy-Item @p .env",
      "if ($x) { $p=@{Path='.env.example'} }; Copy-Item @p .env",
      "echo \"x; $p=@{Path='.env.example'}\"; Copy-Item @p .env",
      "$p=@{Path=$x}; Copy-Item @p .env",
      "$p=@{Pa='.env.example'}; Copy-Item @p .env",
    ]) {
      assertBlocked(root, command, toolName);
    }
  }
});

test("Copy-Item is read as Guard first read it where its words aren't plain", (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, "id_rsa"), "placeholder\n");
  // Each beside its plain twin. PowerShell ends a parameter's name at `.`, `[` or `(`; a scoped splat, a filter on
  // paths from a variable, a group or the pipe, and a Copy-Item made into a reader each copy or read the secret file.
  const pairs = [
    ["Copy-Item -Destination.x .env", "Copy-Item -Destination x .env"],
    ["Copy-Item -Dest.x .env", "Copy-Item -Dest x .env"],
    ["Copy-Item -Destination[x] .env", "Copy-Item -Destination x .env"],
    ["Copy-Item -Destination.x id_rsa", "Copy-Item -Destination x id_rsa"],
    ["$global:p=@{Destination='x'}; Copy-Item @global:p .env", "$p=@{Destination='x'}; Copy-Item @p .env"],
    ["$script:p=@{Destination='x'}; Copy-Item @script:p .env", "$p=@{Destination='x'}; Copy-Item @p .env"],
    ["$local:p=@{Destination='x'}; Copy-Item @local:p .env", "$p=@{Destination='x'}; Copy-Item @p .env"],
    ["$p='.\\*'; Copy-Item -Filter .env -Path $p out", "Copy-Item -Filter .env -Path .\\* out"],
    ["$p='.\\*'; Copy-Item -Include .env $p out", "Copy-Item -Include .env .\\* out"],
    ['".\\*" | Copy-Item -Filter .env -Destination out', "Copy-Item .\\* -Filter .env -Destination out"],
    ["Copy-Item -Filter id_rsa -Path (Join-Path $HOME '.ssh\\*') out", "Copy-Item -Filter id_rsa -Path .\\* out"],
    ["gci -Force | Copy-Item -Filter .env -Destination out", "Copy-Item -Path .\\* -Filter .env -Destination out"],
    ["function Copy-Item { Get-Content $args }; Copy-Item x .env", "Get-Content x .env"],
    ["Set-Alias Copy-Item Get-Content; Copy-Item x .env", "Get-Content x .env"],
  ];
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    for (const [form, twin] of pairs) {
      assertBlocked(root, twin, toolName);
      assertBlocked(root, form, toolName);
    }
  }
  // Guard 0.1.2's PowerShell reading takes the group for -Destination's value too, so there only Cursor's other
  // readings stop it.
  for (const toolName of ["Bash", "Cursor"]) assertBlocked(root, 'Copy-Item -Destination("x") .env', toolName);
  // The same plain forms with the secret file as the destination still run.
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    for (const command of [
      "Copy-Item -Destination .env .env.example",
      "$p=@{Destination='.env'}; Copy-Item @p .env.example",
      "Copy-Item -Filter *.md -Path docs\\* out",
    ]) {
      assertAllowed(root, command, toolName);
    }
  }
});

test("prose starting with Copy in a here-string isn't read as a copy of the files it names", (t) => {
  const root = project(t);
  for (const command of [
    "Set-Content -Path docs/setup.md -Value @'\nCopy .env.example to .env for local work.\n'@",
    "Set-Content docs/setup.md @'\nCopy .env.example to .env after install.\n'@",
  ]) {
    assertAllowed(root, command, "PowerShell");
    assertAllowed(root, command, "Cursor");
  }
  for (const toolName of ["PowerShell", "Cursor"]) {
    for (const command of [
      "Set-Content docs/out.md (Get-Content .env)",
      "Set-Content docs/out.md @'\nCopy .env backup.txt\n'@",
      "Set-Content docs/out.md @'\nCopy .env.example to .env\nGet-Content .env\n'@",
      'Set-Content docs/out.md @"\nCopy .env.example to .env $(Get-Content .env)\n"@',
      "copy /y .env backup.txt",
      "copy -Filter x .env backup.txt",
      "copy a b c\nGet-Content .env",
    ]) {
      assertBlocked(root, command, toolName);
    }
  }
  // cmd's copy joins the files around a `+`; in PowerShell it's part of the name.
  assertBlocked(root, "copy a.txt+.env backup.txt", "Cursor");
  // There a file can be named -Item, so `copy -Item +.env out` copies .env onto the end of it.
  for (const command of ["copy -Item +.env out", "copy -Item + .env", "cmd /c copy -Item +.env out"]) {
    assertBlocked(root, command, "Cursor");
  }
});

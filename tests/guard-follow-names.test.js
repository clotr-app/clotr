// Guard's shell check and a secret file reached through something earlier in the same command: a folder change, a
// variable, a rename or a link. Also readers that get their file names from somewhere else (`xargs`, `find -exec`),
// readers run by a lead-in such as `nice` or `timeout`, and recursive copies read as readers of the whole folder.
// Where a name is only made when the command runs, Guard keeps the answer it gave before.
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

// A small project with a .env, a .kube folder and ordinary files. The values are made up.
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-follow-"));
  const made = ["made", "up", "value"].join("-");
  const put = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  put(".env", `APP_TOKEN=${made}\n`);
  put(".kube/config", `token: ${made}\n`);
  put("notes.txt", "notes\n");
  put("src/app.js", "console.log(1);\n");
  put("src/config", "plain\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function answer(shell, command, cwd) {
  if (shell === "cursor") return guard.inspectShell("cursor", { command, cwd }, { cwd });
  return guard.inspectShell("claude", { tool_name: shell, tool_input: { command } }, { cwd });
}

function assertStopped(cases, cwd) {
  for (const [shell, command] of cases) {
    assert.equal(answer(shell, command, cwd).action, "block", `${shell}: ${command}`);
  }
}

function assertPasses(cases, cwd) {
  for (const [shell, command] of cases) {
    assert.equal(answer(shell, command, cwd).action, "allow", `${shell}: ${command}`);
  }
}

test("a folder change earlier in the command is followed", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "cd .kube && cat config"],
      ["Bash", "cd .kube; cat ./config"],
      ["Bash", "pushd .kube && head config"],
      ["Bash", "cd src && cd ../.kube && cat config"],
      ["PowerShell", "Set-Location .kube; gc config"],
      ["PowerShell", "cd .kube; Get-Content config"],
      ["cursor", "cd .kube && type config"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["Bash", "cd src && cat config"],
      ["Bash", "cd .kube && cd .. && cat notes.txt"],
      ["PowerShell", "Set-Location src; gc config"],
    ],
    cwd,
  );
});

test("a variable set earlier in the command is followed", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "u=.env; cat $u"],
      ["Bash", 'u=.env; cat "$u"'],
      ["Bash", "u=.env && cat ${u}"],
      ["Bash", "export u=.env; cat $u"],
      ["Bash", "d=.kube; cat $d/config"],
      ["PowerShell", '$f=".env"; gc $f'],
      ["PowerShell", "$f = '.env'; Get-Content $f"],
      ["cursor", "set u=.env && type %u%"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["Bash", "u=notes.txt; cat $u"],
      ["PowerShell", "$f = 'notes.txt'; gc $f"],
    ],
    cwd,
  );
});

test("a rename earlier in the command is followed", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "mv .env zz.txt && cat zz.txt"],
      ["Bash", "mv .env zz.txt; cat ./zz.txt"],
      ["Bash", "mv .env a && mv a b && cat b"],
      ["Bash", "mv .kube k && cat k/config"],
      ["Bash", "mv .env src && cat src/.env"],
      ["PowerShell", "Move-Item .env zz.txt; gc zz.txt"],
      ["PowerShell", "ren .env zz.txt; gc zz.txt"],
      ["PowerShell", "Rename-Item -Path .env -NewName zz.txt; Get-Content zz.txt"],
      ["cursor", "move .env zz.txt && type zz.txt"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["Bash", "mv notes.txt zz.txt && cat zz.txt"],
      ["PowerShell", "Move-Item notes.txt zz.txt; gc zz.txt"],
    ],
    cwd,
  );
});

test("a link made earlier in the command is followed", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "ln -s .env zz && cat zz"],
      ["Bash", "ln -sf ../.env src/zz && cat src/zz"],
      ["Bash", "ln .env zz && cat zz"],
      ["Bash", "ln -s .kube k && cat k/config"],
      ["cursor", "mklink zz .env && type zz"],
      ["PowerShell", "New-Item -ItemType SymbolicLink -Path zz -Target .env; gc zz"],
    ],
    cwd,
  );
  assertPasses([["Bash", "ln -s notes.txt zz && cat zz"]], cwd);
});

test("xargs reads the names it's given", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "echo .env | xargs cat"],
      ["Bash", "printf '%s\\n' .env | xargs cat"],
      ["Bash", "echo .env | xargs -I{} cat {}"],
      ["Bash", "find . -name .env | xargs cat"],
      ["Bash", "find . -name .env -print0 | xargs -0 cat"],
      ["Bash", "ls -a | xargs cat"],
      ["Bash", "xargs -a .env echo"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["Bash", "echo notes.txt | xargs cat"],
      ["Bash", "find . -name '*.js' | xargs cat"],
      ["Bash", "ls | xargs cat"],
    ],
    cwd,
  );
});

test("find -exec reads the files find matches", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "find . -name .env -exec cat {} \\;"],
      ["Bash", "find . -name '.env*' -exec cat {} +"],
      ["Bash", "find . -type f -exec cat {} +"],
      ["Bash", "find .kube -exec cat {} +"],
      ["Bash", "find . -iname .ENV -execdir cat {} \\;"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["Bash", "find . -name '*.js' -exec cat {} +"],
      ["Bash", "find src -type f -exec cat {} +"],
      ["Bash", "find . -name .env -exec rm {} \\;"],
    ],
    cwd,
  );
});

test("a reader behind a lead-in is read", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "nice cat .kube/config"],
      ["Bash", "nice -n 5 cat .env"],
      ["Bash", "timeout 5 cat .env"],
      ["Bash", "sudo -u root cat .kube/config"],
      ["Bash", "watch cat .env"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["Bash", "nice cat notes.txt"],
      ["Bash", "timeout 5 cat notes.txt"],
    ],
    cwd,
  );
});

test("recursive copies read the folder they copy", (t) => {
  const cwd = project(t);
  assertStopped(
    [
      ["cursor", "robocopy . out /e"],
      ["cursor", "robocopy .kube out"],
      ["cursor", "xcopy . out /s /i"],
      ["PowerShell", "robocopy . C:\\out /mir"],
      ["Bash", "rsync -a . /tmp/out"],
      ["Bash", "scp -r . host:backup"],
    ],
    cwd,
  );
  assertPasses(
    [
      ["cursor", "robocopy src out /e"],
      ["cursor", "xcopy src out /s /i"],
      ["Bash", "rsync -a src/ /tmp/out"],
    ],
    cwd,
  );
});

test("a name made only when the command runs keeps today's answer", (t) => {
  const cwd = project(t);
  assertPasses(
    [
      ["Bash", "u=$(pick-one); cat $u"],
      ["Bash", "git ls-files | xargs cat"],
      ["Bash", 'cd "$(mktemp -d)" && cat config'],
      ["Bash", 'mv "$x" zz.txt && cat zz.txt'],
    ],
    cwd,
  );
});

// A folder whose only secret file is a .env, for copies that leave it out.
function onlyEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-follow-only-"));
  fs.writeFileSync(path.join(dir, ".env"), `APP_TOKEN=${["made", "up", "value"].join("-")}\n`);
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("find's -not, !, -prune and a group of name tests narrow what it reads", (t) => {
  const cwd = project(t);
  assertPasses(
    [
      ["Bash", "find . -name '*.js' -not -path './node_modules/*' -exec cat {} +"],
      ["Bash", "find . -path ./node_modules -prune -o -name '*.js' -exec cat {} +"],
      ["Bash", "find . -type d -name node_modules -prune -o -name '*.js' -print | xargs cat"],
      ["Bash", "find . \\( -name '*.js' -o -name '*.ts' \\) -exec cat {} +"],
      ["Bash", "find . -name '*.js' ! -name '*.min.js' -exec cat {} +"],
      ["Bash", "find . -type f -name '*.md' -not -name 'CHANGELOG.md' -exec cat {} +"],
      ["Bash", "find . -name '*.json' -not -path './node_modules/*' | xargs cat"],
      ["Bash", "find . -name '*.js' 2>/dev/null | xargs cat"],
    ],
    cwd,
  );
  assertStopped(
    [
      ["Bash", "find . -not -name '*.js' -exec cat {} +"],
      ["Bash", "find . ! -name '*.js' | xargs cat"],
      ["Bash", "find . \\( -name '*.js' -o -type f \\) -exec cat {} +"],
      ["Bash", "find . \\( -name '*.js' -o -name '.env' \\) -exec cat {} +"],
      ["Bash", "find . -name '.env*' -not -path './node_modules/*' -exec cat {} +"],
      ["Bash", "find . -path ./node_modules -prune -o -name '.env' -exec cat {} +"],
      ["Bash", "find . -name '.env' -prune -o -name '*.js' | xargs cat"],
      ["Bash", "find . -name '*.js' -newerXY x -exec cat {} +"],
      ["Bash", "find . -type f | xargs grep TODO"],
      ["Bash", "find . -type f -exec grep -l TODO {} +"],
    ],
    cwd,
  );
});

test("a recursive copy's own exclusions are applied", (t) => {
  const only = onlyEnv(t);
  fs.writeFileSync(path.join(only, ".rsyncignore"), "# made up\n.env\n.kube\n");
  assertPasses(
    [
      ["Bash", "rsync -a --exclude .env . ../out/"],
      ["Bash", "rsync -a --exclude=.env --exclude=.kube . ../out/"],
      ["Bash", "rsync -a --exclude-from=.rsyncignore . ../out/"],
      ["Bash", "rsync -a --exclude '.e*' . ../out/"],
      ["cursor", "robocopy . out /e /xf .env"],
      ["cursor", "robocopy . out /e /XF .env *.bak"],
    ],
    only,
  );
  const cwd = project(t);
  assertStopped(
    [
      ["Bash", "rsync -a --exclude .env . ../out/"],
      ["Bash", "rsync -a --include .env --exclude '.*' . ../out/"],
      ["Bash", "rsync -a --filter '- .env' . ../out/"],
      ["Bash", "rsync -a --exclude-from=missing.txt . ../out/"],
      ["Bash", "rsync -a --exclude src/.env . ../out/"],
      ["Bash", "rsync -av --exclude node_modules . host:/app"],
      ["cursor", "robocopy . out /e /xf .env"],
      ["cursor", "robocopy . out /e /xf .kube"],
    ],
    cwd,
  );
  assertPasses([["cursor", "robocopy . out /e /xf .env /xd .kube"]], cwd);
});

test("a link with no target is skipped", (t) => {
  const cwd = project(t);
  assertPasses(
    [
      ["Bash", "ln"],
      ["Bash", "ln -s"],
      ["Bash", "ln -sf"],
      ["Bash", "ln -t src"],
      ["Bash", "ln -s -- "],
      ["Bash", "sudo ln -s"],
      ["Bash", "echo hi; ln -s"],
      ["Bash", "ln -s && cat notes.txt"],
      ["Bash", 'ln -s ""'],
      ["Bash", "mv -t"],
      ["PowerShell", "ln -s"],
      ["cursor", "ln -s"],
      ["cursor", "mklink x"],
      ["cursor", "mklink /d"],
    ],
    cwd,
  );
  for (const command of ["ln -s", "ln -t src", "mklink x"]) {
    assert.notEqual(answer("Bash", command, cwd).internalError, true, command);
  }
});

test("a folder change inside a subshell ends with it", (t) => {
  const cwd = project(t);
  assertPasses(
    [
      ["Bash", "(cd .kube); cat config"],
      ["Bash", "(cd .kube && ls); cat config"],
      ["Bash", "echo $(cd .kube; pwd) && cat config"],
      ["Bash", "(cd src && (cd ../.kube)); cat app.js"],
    ],
    cwd,
  );
  assertStopped(
    [
      ["Bash", "(cd .kube && cat config)"],
      ["Bash", "{ cd .kube; }; cat config"],
      ["Bash", "(cd src); cd .kube; cat config"],
      ["PowerShell", "(cd .kube); gc config"],
    ],
    cwd,
  );
});

test("long rename and folder-change chains finish", (t) => {
  const cwd = project(t);
  const renames = Array.from({ length: 8000 }, (_, i) => `mv f${i} f${i + 1}`).join(" && ") + " && cat f8000";
  assert.equal(answer("Bash", renames, cwd).action, "allow", "8,000 renames");
  assert.equal(answer("Bash", "cd a;".repeat(10000) + " cat x.txt", cwd).action, "allow", "10,000 cd a;");
  assert.equal(answer("Bash", "mv .env f0 && " + renames, cwd).action, "block", "8,000 renames from .env");
});

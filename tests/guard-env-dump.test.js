// Guard's shell check and commands that print the whole environment. Such a command is stopped however it's
// written: with a redirection, inside a group or a substitution, after `sudo` or a variable, or run by another shell.
// A command that prints one named variable, or a line of text that only names such a command, isn't.
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

// A folder with no secret file in it, so only the environment rule can stop a command.
function plainDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-env-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "notes\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function answer(shell, command, cwd) {
  if (shell === "cursor") return guard.inspectShell("cursor", { command, cwd }, { cwd });
  return guard.inspectShell("claude", { tool_name: shell, tool_input: { command } }, { cwd });
}

function assertStopped(shell, command, cwd) {
  const outcome = answer(shell, command, cwd);
  assert.equal(outcome.action, "block", `${shell}: ${command}`);
  assert.equal(outcome.location, "the environment", `${shell}: ${command}`);
}

// A read of one variable whose name looks like a secret, or isn't written out, is stopped with its own words.
function assertVariableStopped(shell, command, cwd, location) {
  const outcome = answer(shell, command, cwd);
  assert.equal(outcome.action, "block", `${shell}: ${command}`);
  assert.equal(outcome.location, location, `${shell}: ${command}`);
}

function assertPasses(shell, command, cwd) {
  assert.equal(answer(shell, command, cwd).action, "allow", `${shell}: ${command}`);
}

const KEPT = [
  ["Bash", "env"],
  ["Bash", "env | grep -i token"],
  ["Bash", "printenv"],
  ["Bash", "export -p"],
  ["Bash", "export"],
  ["Bash", "set"],
  ["Bash", "env -0"],
  ["PowerShell", "gci env:"],
  ["PowerShell", "Get-ChildItem Env:"],
  ["PowerShell", "dir env:"],
  ["PowerShell", "Get-ChildItem -Path Env:"],
  ["PowerShell", "[Environment]::GetEnvironmentVariables()"],
];

const DUMPS = [
  ["Bash", "env > e.txt"],
  ["Bash", "env 2>&1"],
  ["Bash", "(env)"],
  ["Bash", 'echo "$(env)"'],
  ["Bash", "if true; then env; fi"],
  ["Bash", "sudo env"],
  ["Bash", "FOO=1 env"],
  ["Bash", "declare -x"],
  ["Bash", 'x=$(printenv); echo "$x"'],
  ["PowerShell", "$x = gci env:"],
  ["PowerShell", "& { gci env: }"],
  ["PowerShell", "(gci env:).Value"],
  ["PowerShell", "cmd /c set"],
  ["cursor", "set > e.txt"],
  ["cursor", "cmd /c set"],
  ["Bash", "/usr/bin/env"],
  ["Bash", "typeset -p"],
  ["Bash", 'bash -c "env"'],
  ["Bash", "bash <<'EOF'\nprintenv\nEOF"],
  ["Bash", "cat <<EOF\n$(env)\nEOF"],
];

// PowerShell's env: drive read some other way than by one plain name lists it.
const DRIVE = [
  ["PowerShell", "Get-ChildItem Env:?*"],
  ["PowerShell", "gci env:*TOKEN*"],
  ["PowerShell", "gci env:[A-Z]*"],
  ["PowerShell", "gci env:[a-z]*,env:[0-9_]*"],
  ["PowerShell", "Get-ChildItem Env:."],
  ["PowerShell", "gci Env:\\."],
  ["PowerShell", "gci Env:\\\\"],
  ["PowerShell", "Get-ChildItem env:\\..\\"],
  ["PowerShell", "gci env:`"],
  ["cursor", "gci env:}"],
];

// A redirection written against the command's name or its drive.
const GLUED = [
  ["Bash", "printenv>e.txt"],
  ["Bash", "env&>e.txt"],
  ["PowerShell", "gci env:>e.txt"],
  ["Bash", "env>e.txt"],
  ["Bash", "env>>e.txt"],
  ["Bash", "set>e.txt"],
  ["Bash", "export>e.txt"],
  ["Bash", "sudo env>e.txt"],
];

// A script on its own lines that a shell runs, however it gets there.
const HANDED = [
  ["Bash", "cat <<EOF | bash\nenv\nEOF"],
  ["Bash", "cat <<'EOF' | sh\nprintenv\nEOF"],
  ["Bash", "echo '\nenv\n' | bash"],
  ["PowerShell", "@'\ngci env:\n'@ | pwsh -"],
  ["PowerShell", '@"\nGet-ChildItem Env:\n"@ | iex'],
  ["Bash", "source /dev/stdin <<EOF\nenv\nEOF"],
  ["Bash", 'bash -c "$(cat <<EOF\nenv\nEOF\n)"'],
  ["Bash", 'eval "$(cat <<EOF\nenv\nEOF\n)"'],
  ["Bash", "bash < <(cat <<EOF\nenv\nEOF\n)"],
  ["Bash", "timeout 5 sh -c '\nenv\n'"],
  ["Bash", "su - -c '\nenv\n'"],
  ["Bash", "ssh host '\nenv\n'"],
  ["Bash", "ssh host <<EOF\nenv\nEOF"],
  ["Bash", "docker exec c sh -c '\nenv\n'"],
  ["Bash", "kubectl exec p -- sh -c '\nenv\n'"],
  ["Bash", "cat > run.sh <<'EOF'\n#!/bin/sh\nenv\nEOF\nsh run.sh"],
  ["Bash", "cat > run.sh <<EOF\nenv\nEOF\nchmod +x run.sh && ./run.sh"],
];

// A script on its own lines that reaches a shell some other way: a here-string, a file written and then run by name,
// a shell Guard doesn't know, or another program that runs what it's given. What Guard can't place is stopped when a
// line of it is a dump on its own.
const REACHED = [
  ["Bash", "bash <<< '\nenv\n'"],
  ["Bash", "sh -s <<< '\nenv\n'"],
  ["Bash", "cat <<< '\nenv\n' | bash"],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\n. r.sh"],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\nsource ./r.sh"],
  ["Bash", 'cat > r.sh <<EOF\nenv\nEOF\nchmod +x r.sh; "$PWD/r.sh"'],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\nchmod +x r.sh; xargs ./r.sh < /dev/null"],
  ["Bash", "cat > scripts/r.sh <<EOF\nenv\nEOF\ncd scripts && ./r.sh"],
  ["Bash", "tee r.sh <<EOF\nenv\nEOF\nchmod +x r.sh; ./r.sh"],
  ["Bash", "cat > Makefile <<EOF\nall:\n\tenv\nEOF\nmake"],
  ["Bash", "cat > .git/hooks/pre-commit <<EOF\nenv\nEOF\ngit commit -m x"],
  ["PowerShell", "Set-Content run.ps1 @'\ngci env:\n'@; .\\run.ps1"],
  ["PowerShell", "@'\ngci env:\n'@ | Out-File run.ps1; & .\\run.ps1"],
  ["Bash", 'cat <<EOF | "bash"\nenv\nEOF'],
  ["Bash", "cat <<EOF | \\bash\nenv\nEOF"],
  ["Bash", "cat <<EOF | tcsh\nenv\nEOF"],
  ["Bash", "$SHELL <<EOF\nenv\nEOF"],
  ["Bash", "$SHELL -c '\nenv\n'"],
  ["Bash", "sudo -i <<EOF\nenv\nEOF"],
  ["Bash", "cat <<EOF | parallel\nenv\nEOF"],
  ["Bash", "flock /tmp/l -c '\nenv\n'"],
  ["Bash", "trap '\nenv\n' EXIT"],
  ["Bash", "git rebase -x '\nenv\n' main"],
  ["Bash", "x='\nenv\n'\n$x"],
  ["Bash", "python3 - <<EOF\nimport os\nos.system('''\nenv\n''')\nEOF"],
  ["PowerShell", "& ([scriptblock]::Create(@'\ngci env:\n'@))"],
];

// `env` is found under any case on macOS and in Git Bash.
const CAPITALS = [
  ["Bash", "ENV"],
  ["Bash", "Env"],
  ["Bash", "ENV | sort"],
  ["Bash", "ENV -0"],
  ["Bash", "sudo ENV"],
  ["Bash", "ENV > e.txt"],
];

// `env` and `printenv` are programs, so a copy in a folder prints what they print.
const PROGRAM_PATHS = [
  ["Bash", "/usr/bin/env"],
  ["Bash", "/usr/bin/printenv"],
  ["Bash", "env.exe"],
  ["Bash", "./env"],
  ["Bash", "tools/env"],
  ["Bash", "./printenv"],
  ["Bash", "node_modules/.bin/env"],
];

// `export`, `set`, `declare` and `typeset` are builtins, so one with a folder in front is a project's own program.
const OWN_PROGRAMS = [
  ["Bash", "./export"],
  ["Bash", "bin/export"],
  ["Bash", "./scripts/set"],
  ["Bash", "./declare"],
  ["Bash", "~/bin/export"],
  ["Bash", "./export.exe"],
  ["cursor", ".\\export.exe"],
];

const SECRET_VARIABLE = "a variable whose name looks like a secret";
const UNREAD_VARIABLE = "a variable whose name isn't written out";

// One variable whose name looks like a secret, among others or alone.
const SECRET_NAMED = [
  ["Bash", "printenv GITHUB_TOKEN"],
  ["PowerShell", "Get-ChildItem Env:GITHUB_TOKEN"],
  ["cursor", "Get-ChildItem Env:GITHUB_TOKEN"],
  ["Bash", "declare -p AWS_SECRET_ACCESS_KEY"],
  ["Bash", "typeset -p DB_PASSWORD"],
  ["Bash", "export -p NPM_AUTH"],
  ["Bash", "printenv PATH GITHUB_TOKEN"],
  ["PowerShell", "gci env:PATH, env:API_KEY"],
  ["PowerShell", "Get-Item Env:SENTRY_DSN"],
  ["PowerShell", "ls env:\\DATABASE_URL"],
  ["Bash", "printenv github_token"],
  ["Bash", "npm test && printenv GITHUB_TOKEN"],
];

const UNREAD_NAMED = [
  ["Bash", 'printenv "$name"'],
  ["Bash", "printenv $VAR"],
  ["Bash", "declare -p ${!x}"],
  ["PowerShell", "Get-ChildItem Env:$n"],
];

const ONE_VARIABLE = [
  ["Bash", "printenv PATH"],
  ["Bash", "printenv PATH HOME"],
  ["Bash", "printenv PWD"],
  ["Bash", "printenv OLDPWD"],
  ["Bash", "echo $GITHUB_TOKEN"],
  ["PowerShell", "$env:GITHUB_TOKEN"],
  ["PowerShell", "gci env:PATH, env:HOME"],
  ["PowerShell", "Get-ChildItem Env:ProgramFiles(x86)"],
  ["PowerShell", "dir env:\\PATH"],
  ["Bash", "printenv HOME"],
  ["Bash", "echo $PATH"],
  ["Bash", "declare -p HOME"],
  ["PowerShell", "Get-ChildItem Env:PATH"],
  ["PowerShell", "$env:PATH"],
];

const TEXT = [["Bash", 'echo "run env to see them"']];

// Text on its own lines (a here-document, a here-string, a quoted word over several lines) gets one test wherever it
// goes: a line of it that starts with a bare dump stops the command. So a note or a message with such a line is
// stopped too.
const TEXT_WITH_A_DUMP_LINE = [
  ["Bash", "cat > notes.md <<'EOF'\nTo see your variables run:\nprintenv\nEOF"],
  ["Bash", 'git commit -m "docs: list the variables\n\nset\n"'],
  ["Bash", "cat > run.sh <<EOF\nenv\nEOF"],
  ["Bash", "tee notes.txt <<EOF\nexport\nEOF"],
  ["Bash", "python3 - <<EOF\nimport os\nenv\nEOF"],
  ["Bash", "node <<EOF\nset\nEOF"],
  ["Bash", "git commit -F - <<EOF\nfix\n\nenv\nEOF"],
  ["Bash", 'node -e "\nenv\n"'],
  ["PowerShell", "@'\ngci env:\n'@ | Set-Content n.md"],
  ["Bash", "bash <<EOF\nprintenv GITHUB_TOKEN\nEOF"],
  ["Bash", "ssh host '\nprintenv GITHUB_TOKEN\n'"],
];

// A script written to a file and then run, however the shell is started or the file reaches it.
const SCRIPT_RUN = [
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\nbash -euo pipefail r.sh"],
  ["PowerShell", "Set-Content r.ps1 @'\ngci env:\n'@; powershell -ExecutionPolicy Bypass -File r.ps1"],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\ntimeout 5 sh r.sh"],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\nsudo -u bob sh r.sh"],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\nsh < r.sh"],
  ["Bash", "cat > r.sh <<EOF\nenv\nEOF\ncat r.sh | sh"],
];

// Each part of a command gets its own answer, and a stop wins: a dump on one line after a here-document.
const BESIDE_TEXT = [["Bash", "cat > notes.md <<'EOF'\nnotes\nEOF\nsudo env"]];

// A lone CR ends a line, as PowerShell reads it, so the line after it is read as its own, on every host.
const AFTER_A_LONE_CR = [
  ["PowerShell", "echo a\rgci env:"],
  ["PowerShell", "echo a\rGet-ChildItem Env:"],
  ["cursor", "echo a\rgci env:"],
  ["Bash", "echo a\renv"],
  ["Bash", "cat <<EOF\renv\rEOF\r"],
  ["Bash", "echo 'a\renv\r'"],
];

// A here-document or here-string with no command in front gets the same line test as one given to a command.
const TEXT_WITH_NO_COMMAND = [
  ["Bash", "<<EOF\nenv\nEOF"],
  ["Bash", "echo ok && <<EOF\nenv\nEOF"],
  ["Bash", "<<< '\nenv\n'"],
  ["cursor", "<<EOF\nset\nEOF"],
  ["cursor", "<<< '\ngci env:\n'"],
];

// In PowerShell a quoted word alone at the start of a statement is a string, and nothing runs it.
const POWERSHELL_STRINGS = [
  ["PowerShell", "'env' >> .gitignore"],
  ["PowerShell", "'env' | Out-File .gitignore"],
  ["PowerShell", '"set" | clip'],
  ["PowerShell", "$dirs = @(\n  'env'\n  'node_modules'\n)"],
  ["PowerShell", "'printenv'"],
];

// The call operator runs the quoted name, and Bash runs a quoted word as a command.
const QUOTED_NAMES_RUN = [
  ["PowerShell", "& 'env'"],
  ["PowerShell", "&'env'"],
  ["PowerShell", '& "set"'],
  ["Bash", "'env' >> .gitignore"],
];

// A shell's text over several lines is read by the line test alone, which takes only a bare dump at a line's start.
const SHELL_TEXT_ON_LINES = [["Bash", "bash -c '\nsudo env\n'"]];

// A part the shell reads as a command with no words, `$(< file)` and the like, beside text on its own lines.
const NO_WORDS = [
  ["Bash", "git commit -m \"$(cat <<'EOF'\nFix the build\n\nMore words.\nEOF\n)\"\nv=$(< VERSION)"],
  ["Bash", "cat > notes.md <<'EOF'\nnotes\nEOF\nv=`< VERSION`"],
  ["Bash", "cat > notes.md <<'EOF'\nnotes\nEOF\n< VERSION"],
];

// A note or a message that names a dump goes to a file nothing runs or to a commit, whatever else the command runs.
const NOTES_BESIDE_RUNNERS = [
  ["Bash", "cat > notes.md <<'EOF'\nGuard now stops `sudo env` and `env > e.txt`.\nEOF\nnpm run watch"],
  ["Bash", "cat > notes.md <<'EOF'\nsudo env\nEOF\nbash tools/check.sh"],
  ["Bash", "cat > notes.md <<'EOF'\nsudo env\nEOF\ngit push origin ssh"],
  ["Bash", "cat > notes.md <<'EOF'\nsudo env\nEOF\nsh -n notes.md"],
  ["Bash", "cat > notes.md <<EOF\n(env)\nEOF\nwc -l notes.md | sh -c 'cat'"],
  ["Bash", 'git commit -m "Stop more dumps\n\nsudo env\n" && bash tools/after-commit.sh'],
  ["Bash", 'bash tools/lint.sh && git commit -m "Docs\n\nsudo printenv GITHUB_TOKEN\n"'],
  ["PowerShell", "Set-Content notes.md @'\ncmd /c set\n'@; pwsh tools/check.ps1"],
];

// Commands with the same names that print no variable.
const OTHER_USES = [
  ["Bash", "set -e; npm test"],
  ["Bash", "set -euo pipefail"],
  ["Bash", "env NODE_ENV=test npm test"],
  ["Bash", "declare -f"],
  ["Bash", "env --help"],
  ["Bash", "env --version"],
  ["Bash", "export -f"],
  ["Bash", "export -n"],
  ["Bash", "declare -fx"],
];

for (const [shell, command] of KEPT) {
  test(`still stopped, ${shell}: ${JSON.stringify(command)}`, (t) => assertStopped(shell, command, plainDir(t)));
}
for (const [shell, command] of DUMPS) {
  test(`whole environment stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertStopped(shell, command, plainDir(t)));
}
for (const [shell, command] of [
  ...DRIVE,
  ...GLUED,
  ...HANDED,
  ...REACHED,
  ...CAPITALS,
  ...PROGRAM_PATHS,
  ...TEXT_WITH_A_DUMP_LINE,
  ...SCRIPT_RUN,
  ...BESIDE_TEXT,
  ...AFTER_A_LONE_CR,
  ...TEXT_WITH_NO_COMMAND,
  ...QUOTED_NAMES_RUN,
]) {
  test(`whole environment stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertStopped(shell, command, plainDir(t)));
}
for (const [shell, command] of OWN_PROGRAMS) {
  test(`a project's own program passes, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, plainDir(t)));
}
for (const [shell, command] of SECRET_NAMED) {
  test(`a secret-looking variable stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, plainDir(t), SECRET_VARIABLE));
}
for (const [shell, command] of UNREAD_NAMED) {
  test(`a variable not written out stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, plainDir(t), UNREAD_VARIABLE));
}

// The words a secret-looking name holds, in any case, and the endings. It's a guess from the name alone.
test("names that look like a secret, and the working folder's, which doesn't", (t) => {
  const cwd = plainDir(t);
  const words = ["TOKEN", "SECRET", "KEY", "PASS", "CREDENTIAL", "AUTH", "PRIVATE", "DSN", "CONNECTION_STRING"];
  const names = [...words.map((word) => `MY_${word}_1`), "database_url", "MYSQL_PWD", "GIT_PAT"];
  for (const name of names) assertVariableStopped("Bash", `printenv ${name}`, cwd, SECRET_VARIABLE);
  for (const name of ["PWD", "OLDPWD", "PATH", "HOME", "PWD_HOME", "PATH_X"]) {
    assertPasses("Bash", `printenv ${name}`, cwd);
  }
});

// `SK` as a whole part of the name, between underscores or at an end, looks like a secret; inside a word it doesn't.
test("a name with SK as a whole part looks like a secret", (t) => {
  const cwd = plainDir(t);
  for (const name of ["STRIPE_SK", "SK_LIVE", "stripe_sk"]) {
    assertVariableStopped("Bash", `printenv ${name}`, cwd, SECRET_VARIABLE);
  }
  assertVariableStopped("PowerShell", "Get-ChildItem Env:STRIPE_SK", cwd, SECRET_VARIABLE);
});

test("a name with SK inside a word passes", (t) => {
  const cwd = plainDir(t);
  for (const name of ["TASK_ID", "DESKTOP", "SKIP_TESTS", "DISK"]) assertPasses("Bash", `printenv ${name}`, cwd);
});

for (const [shell, command] of ONE_VARIABLE) {
  test(`one variable passes, ${shell}: ${JSON.stringify(command)}`, (t) => assertPasses(shell, command, plainDir(t)));
}
for (const [shell, command] of [...TEXT, ...NOTES_BESIDE_RUNNERS]) {
  test(`text that names a dump passes, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, plainDir(t)));
}
for (const [shell, command] of OTHER_USES) {
  test(`no variable printed passes, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, plainDir(t)));
}
for (const [shell, command] of NO_WORDS) {
  test(`a part with no words passes with no error, ${shell}: ${JSON.stringify(command)}`, (t) => {
    const outcome = answer(shell, command, plainDir(t));
    assert.equal(outcome.action, "allow", `${shell}: ${command}`);
    assert.ok(!outcome.internalError, `${shell}: ${command}`);
  });
}
for (const [shell, command] of [...POWERSHELL_STRINGS, ...SHELL_TEXT_ON_LINES]) {
  test(`nothing run passes, ${shell}: ${JSON.stringify(command)}`, (t) => assertPasses(shell, command, plainDir(t)));
}

// Known gaps closed: a read of one variable in any spelling the shell runs, and a dump behind a lead-in, a remote
// shell, another language or a shell fed one line. The environment holds a made-up key while these run, as an
// assistant's shell would.
const MADE_UP_KEY = ["ghp", "madeUpValueForGuardTests000000000000"].join("_");

function withMadeUpKey(t) {
  const before = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = MADE_UP_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = before;
  });
  return plainDir(t);
}

// One secret-looking variable, read after a lead-in, in a group or a substitution, or from PowerShell's env: drive.
const ONE_SECRET_ANY_SPELLING = [
  ["Bash", "sudo printenv GITHUB_TOKEN"],
  ["Bash", "sudo -E printenv GITHUB_TOKEN"],
  ["Bash", "(printenv GITHUB_TOKEN)"],
  ["Bash", "{ printenv GITHUB_TOKEN; }"],
  ["Bash", 'echo "$(printenv GITHUB_TOKEN)"'],
  ["Bash", "x=$(printenv GITHUB_TOKEN)"],
  ["Bash", "echo `printenv GITHUB_TOKEN`"],
  ["Bash", "if true; then printenv GITHUB_TOKEN; fi"],
  ["Bash", "declare -xp GITHUB_TOKEN"],
  ["Bash", "sudo declare -p GITHUB_TOKEN"],
  ["Bash", "bash -c 'printenv GITHUB_TOKEN'"],
  ["Bash", "nice printenv GITHUB_TOKEN"],
  ["Bash", "timeout 5 printenv GITHUB_TOKEN"],
  ["Bash", "find . -maxdepth 0 -exec printenv GITHUB_TOKEN \\;"],
  ["Bash", "ssh host printenv GITHUB_TOKEN"],
  ["PowerShell", "Get-Content Env:GITHUB_TOKEN"],
  ["PowerShell", "gc env:GITHUB_TOKEN"],
  ["PowerShell", "cat Env:GITHUB_TOKEN"],
  ["PowerShell", "type env:GITHUB_TOKEN"],
  ["PowerShell", "Get-Content -Path Env:GITHUB_TOKEN"],
  ["PowerShell", "$x = Get-Content Env:GITHUB_TOKEN"],
  ["PowerShell", "gi env:GITHUB_TOKEN"],
  ["PowerShell", "$t = gci env:GITHUB_TOKEN"],
  ["PowerShell", "(Get-Item Env:GITHUB_TOKEN).Value"],
  ["cursor", "Get-Content Env:GITHUB_TOKEN"],
];

const ONE_UNREAD_ANY_SPELLING = [
  ["PowerShell", 'gci "Env:$name"'],
  ["Bash", 'sudo printenv "$name"'],
];

// A plain name that only holds a place, a socket or a word with KEY, AUTH or PASS inside it.
const PLAIN_NAMES = [
  "SSH_AUTH_SOCK",
  "PASSWORD_STORE_DIR",
  "KEYTAB_PATH",
  "GNUPG_KEY_HOME",
  "KEYBOARD_LAYOUT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
];

const PLAIN_NAME_SPELLINGS = [
  ["Bash", "sudo printenv SSH_AUTH_SOCK"],
  ["Bash", "x=$(printenv KEYBOARD_LAYOUT)"],
  ["Bash", "bash -c 'printenv SSH_AUTH_SOCK'"],
  ["PowerShell", "gci Env:SSH_AUTH_SOCK"],
  ["PowerShell", "Get-Content Env:PATH"],
  ["PowerShell", "(Get-Item Env:KEYBOARD_LAYOUT).Value"],
];

// The whole environment, printed behind a lead-in, by env given options, by a shell fed one line, by another
// language, by ps, over a remote shell or a container, through PowerShell's env: drive, or by cmd's set.
const LEAD_IN_DUMPS = [
  ["Bash", "sudo -E env"],
  ["Bash", "sudo -E -u root env"],
  ["Bash", "sudo --preserve-env env"],
  ["Bash", "nice env"],
  ["Bash", "nice -n 5 env"],
  ["Bash", "timeout 5 env"],
  ["Bash", "timeout -s KILL 5 env"],
  ["Bash", "echo | xargs env"],
  ["Bash", "xargs -0 env < /dev/null"],
  ["Bash", "watch env"],
  ["Bash", "watch -n 1 env"],
  ["Bash", "find . -maxdepth 0 -exec env \\;"],
  ["Bash", "find . -maxdepth 0 -execdir env ';'"],
  ["Bash", "env -u PATH"],
  ["Bash", "env -C /tmp"],
  ["Bash", "env -u FOO -C /tmp"],
  ["Bash", "env -uFOO"],
  ["Bash", "env --chdir /tmp"],
  ["Bash", "sudo env -u FOO"],
];

const ONE_LINE_FED = [
  ["Bash", "echo env | bash"],
  ["Bash", "echo env | sh"],
  ["Bash", "printf 'env\\n' | bash"],
  ["Bash", "bash <<< env"],
  ["Bash", "echo env > e.sh; bash e.sh"],
  ["Bash", "echo env > e.sh && sh e.sh"],
  ["Bash", "echo env > e.sh; source e.sh"],
  ["PowerShell", "'gci env:' | pwsh -"],
];

const OTHER_LANGUAGES = [
  ["Bash", "node -e 'console.log(process.env)'"],
  ["Bash", "node -p process.env"],
  ["Bash", 'node -e "console.log(JSON.stringify(process.env))"'],
  ["Bash", "python -c 'import os; print(os.environ)'"],
  ["Bash", 'python3 -c "import os;print(dict(os.environ))"'],
  ["Bash", "perl -e 'print \"$_=$ENV{$_}\\n\" for keys %ENV'"],
  ["Bash", "perl -E 'say for %ENV'"],
  ["Bash", "jq -n env"],
  ["Bash", "jq -n '$ENV'"],
  ["Bash", "awk 'BEGIN{for(k in ENVIRON) print k, ENVIRON[k]}'"],
  ["PowerShell", "node -e 'console.log(process.env)'"],
];

const PROCESS_LISTS = [
  ["Bash", "ps eww"],
  ["Bash", "ps eww $$"],
  ["Bash", "ps auxeww"],
  ["Bash", "ps e"],
];

const REMOTE_DUMPS = [
  ["Bash", "ssh host env"],
  ["Bash", "ssh host 'env'"],
  ["Bash", "ssh -p 2222 user@host printenv"],
  ["Bash", "docker exec app env"],
  ["Bash", "docker exec -it app env"],
  ["Bash", "docker exec -e A=1 app env"],
  ["Bash", "docker compose exec web env"],
  ["Bash", "docker-compose exec web env"],
  ["Bash", "docker compose run --rm web env"],
  ["Bash", "docker run --rm alpine env"],
  ["Bash", "docker run --rm -e A=1 alpine env"],
  ["Bash", "kubectl exec pod -- env"],
  ["Bash", "kubectl exec -it pod -- printenv"],
];

const DRIVE_OTHER_WAYS = [
  ["PowerShell", "$d = 'env:'; gci $d"],
  ["PowerShell", '$d = "Env:"; Get-ChildItem -Path $d'],
  ["PowerShell", "Get-Content Env:"],
  ["PowerShell", "Set-Location Env:; gci"],
  ["PowerShell", "cd env:; ls"],
  ["PowerShell", "sl env:; dir"],
  ["PowerShell", "Push-Location Env:; gci"],
];

const CMD_SET_FORMS = [
  ["PowerShell", 'cmd /c "@set"'],
  ["PowerShell", "cmd /c call set"],
  ["PowerShell", "cmd /c set GITHUB"],
  ["PowerShell", "cmd /c set G"],
  ["cursor", "cmd /c @set"],
  ["Bash", "cmd.exe /c set GITHUB"],
];

// The same lead-ins, languages and remote shells doing ordinary work.
const ORDINARY_WORK = [
  ["Bash", "nice make"],
  ["Bash", "timeout 5 npm test"],
  ["Bash", "sudo -E npm test"],
  ["Bash", "watch -n 5 npm test"],
  ["Bash", "xargs -n1 echo"],
  ["Bash", "find . -name '*.js' -exec grep env {} +"],
  ["Bash", "find . -exec env {} +"],
  ["Bash", "env -u FOO npm test"],
  ["Bash", "env -C /tmp ls"],
  ["Bash", "echo ls | bash"],
  ["Bash", "echo 'env' > notes.txt"],
  ["Bash", "echo env > notes.txt; bash tools/check.sh"],
  ["Bash", "echo env | grep -c env"],
  ["Bash", "node -e 'console.log(process.env.PORT)'"],
  ["Bash", "node -p process.env.HOME"],
  ["Bash", "node -e 'console.log(process.env[\"HOME\"])'"],
  ["Bash", "python -c 'import os; print(os.environ[\"HOME\"])'"],
  ["Bash", "python -c 'import os; print(os.environ.get(\"HOME\"))'"],
  ["Bash", "perl -e 'print $ENV{HOME}'"],
  ["Bash", "jq -n env.HOME"],
  ["Bash", "jq -n '$ENV.PATH'"],
  ["Bash", "jq '.env' package.json"],
  ["Bash", "jq '.[\"env\"]' package.json"],
  ["Bash", "awk '{print ENVIRON[\"HOME\"]}' notes.txt"],
  ["Bash", "ps aux"],
  ["Bash", "ps -ef"],
  ["Bash", "ps -e"],
  ["Bash", "ssh host ls"],
  ["Bash", "ssh host 'ls -la'"],
  ["Bash", "docker exec app ls"],
  ["Bash", "docker run --rm -e NODE_ENV=test alpine npm test"],
  ["Bash", "docker compose exec web npm test"],
  ["Bash", "kubectl exec pod -- ls"],
  ["PowerShell", "Set-Location C:\\proj"],
  ["PowerShell", "Get-Content notes.txt"],
  ["PowerShell", "$d = 'notes.txt'; gc $d"],
  ["PowerShell", "cmd /c set X=1"],
  ["PowerShell", "cmd /c set /a x=1+1"],
];

for (const [shell, command] of ONE_SECRET_ANY_SPELLING) {
  test(`one secret-looking variable stopped in any spelling, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, withMadeUpKey(t), SECRET_VARIABLE));
}
for (const [shell, command] of ONE_UNREAD_ANY_SPELLING) {
  test(`a variable not written out stopped in any spelling, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, withMadeUpKey(t), UNREAD_VARIABLE));
}
test("a plain name with KEY, AUTH or PASS inside it passes", (t) => {
  const cwd = withMadeUpKey(t);
  for (const name of PLAIN_NAMES) assertPasses("Bash", `printenv ${name}`, cwd);
  for (const name of ["AUTHORIZATION", "SSH_AUTH", "APIKEY", "MY_KEYS", "GITHUB_TOKEN"]) {
    assertVariableStopped("Bash", `printenv ${name}`, cwd, SECRET_VARIABLE);
  }
});
for (const [shell, command] of PLAIN_NAME_SPELLINGS) {
  test(`a plain name passes in any spelling, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, withMadeUpKey(t)));
}
for (const [shell, command] of [
  ...LEAD_IN_DUMPS,
  ...ONE_LINE_FED,
  ...OTHER_LANGUAGES,
  ...PROCESS_LISTS,
  ...REMOTE_DUMPS,
  ...DRIVE_OTHER_WAYS,
  ...CMD_SET_FORMS,
]) {
  test(`whole environment stopped past a lead-in, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertStopped(shell, command, withMadeUpKey(t)));
}
for (const [shell, command] of ORDINARY_WORK) {
  test(`ordinary work passes, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, withMadeUpKey(t)));
}

// A name with KEY at the start of a longer word still holds a key (`DEPLOY_KEYPAIR`, `JWT_KEYSET`). Only a few plain
// words pass: a keyboard, a key's id, a vault's name and a key file's path.
const KEY_WORD_NAMES = [
  ["Bash", "printenv API_KEYVALUE"],
  ["Bash", "printenv OPENAI_APIKEYVALUE"],
  ["Bash", "printenv DEPLOY_KEYPAIR"],
  ["Bash", "printenv SIGNING_KEYPAIR"],
  ["Bash", "printenv JWT_KEYSET"],
  ["Bash", "printenv APP_KEYMATERIAL"],
  ["Bash", "printenv ENCRYPTION_KEYDATA"],
  ["Bash", "printenv MASTER_KEYSTRING"],
  ["Bash", "printenv CLIENT_KEYPEM"],
  ["Bash", "printenv LICENSE_KEYCODE"],
  ["PowerShell", "gci env:API_KEYVALUE"],
];
const KEY_PLAIN_WORDS = ["KEYBOARD_LAYOUT", "GPG_KEYID", "KEYVAULT", "SSH_KEYFILE"];

// PowerShell's `ps` is Get-Process, and a word like `user` isn't BSD's `e` form, so these list processes only.
const PROCESS_NAMES = [
  ["PowerShell", "ps node"],
  ["PowerShell", "ps chrome"],
  ["PowerShell", "ps explorer"],
  ["PowerShell", "ps node | Stop-Process"],
  ["PowerShell", "ps code,node"],
  ["Bash", "ps user"],
];
const BSD_ENVIRONMENT_LISTS = [
  ["Bash", "ps eww"],
  ["Bash", "ps auxe"],
  ["Bash", "ps axe"],
  ["Bash", "ps uxe"],
];

// cmd's `set PATH` prints only PATH and PATHEXT. A bare `set`, a short prefix and one that could start a secret's name
// print more.
const CMD_SET_PLAIN = [
  ["PowerShell", "cmd /c set PATH"],
  ["Bash", "cmd.exe /c set PATH"],
];
const CMD_SET_WIDE = [
  ["PowerShell", "cmd /c set"],
  ["PowerShell", "cmd /c set G"],
  ["PowerShell", "cmd /c set GITHUB"],
  ["Bash", "cmd.exe /c set"],
  ["Bash", "cmd.exe /c set G"],
  ["Bash", "cmd.exe /c set GITHUB"],
];

for (const [shell, command] of KEY_WORD_NAMES) {
  test(`a name with KEY starting a longer word is stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, withMadeUpKey(t), SECRET_VARIABLE));
}
for (const name of KEY_PLAIN_WORDS) {
  test(`a plain word with KEY in it passes: ${name}`, (t) =>
    assertPasses("Bash", `printenv ${name}`, withMadeUpKey(t)));
}
for (const [shell, command] of [...PROCESS_NAMES, ...CMD_SET_PLAIN]) {
  test(`an everyday command passes, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, withMadeUpKey(t)));
}
for (const [shell, command] of [...BSD_ENVIRONMENT_LISTS, ...CMD_SET_WIDE]) {
  test(`the environment still stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertStopped(shell, command, withMadeUpKey(t)));
}

// A plain word passes only when the word ends right after it: at an `_`, the name's end or a plural `S`. A longer
// word that starts the same way, like an SSH identity or a key file's data, holds the key itself.
const KEY_LONGER_WORDS = [
  ["Bash", "printenv KEYIDENTITY"],
  ["Bash", "printenv API_KEYIDENTITY"],
  ["Bash", "printenv SSH_KEYIDENTITY"],
  ["Bash", "printenv keyidentity"],
  ["Bash", "printenv SSH_KEYFILEDATA"],
  ["Bash", "printenv SSH_KeyFileData"],
  ["Bash", "printenv MASTER_KEYFILEBLOB"],
  ["Bash", "printenv DEPLOY_KEYFILECONTENT"],
  ["Bash", "printenv TLS_KEYFILEBODY"],
  ["PowerShell", "gci env:KEYIDENTITY"],
  ["Bash", "printenv API_KEYVALUE"],
  ["Bash", "printenv DEPLOY_KEYPAIR"],
  ["Bash", "printenv KEYIDX"],
];
const KEY_WHOLE_WORDS = [
  "KEYBOARD_LAYOUT",
  "GPG_KEYID",
  "API_KEYIDS",
  "KEYVAULT",
  "KEYVAULT_NAME",
  "AZURE_KEYVAULT_URL",
  "SSH_KEYFILE",
];

// Windows' own names, so `set` with one written whole passes.
const CMD_SET_WINDOWS_NAMES = [
  ["PowerShell", "cmd /c set USERNAME"],
  ["PowerShell", "cmd /c set USERPROFILE"],
  ["PowerShell", "cmd /c set TEMP"],
  ["PowerShell", "cmd /c set APPDATA"],
  ["PowerShell", "cmd /c set OS"],
  ["PowerShell", "cmd /c set NUMBER_OF_PROCESSORS"],
  ["PowerShell", "cmd /c set HOMEPATH"],
  ["Bash", "cmd.exe /c set USERNAME"],
  ["PowerShell", "cmd /c set username"],
  ["PowerShell", "cmd /c set LocalAppData"],
  ["PowerShell", "cmd /c set PROCESSOR_IDENTIFIER"],
  ["PowerShell", "cmd /c set PATH"],
];
const CMD_SET_STILL_WIDE = [
  ["PowerShell", "cmd /c set"],
  ["PowerShell", "cmd /c set G"],
  ["PowerShell", "cmd /c set GITHUB"],
  ["PowerShell", "cmd /c set USER"],
  ["PowerShell", "cmd /c set PATH_TOKEN"],
  ["PowerShell", "cmd /c set USERNAME_X"],
];

for (const [shell, command] of KEY_LONGER_WORDS) {
  test(`a longer word starting with KEY is stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, withMadeUpKey(t), SECRET_VARIABLE));
}
for (const name of KEY_WHOLE_WORDS) {
  test(`a plain word with KEY, ending there, passes: ${name}`, (t) =>
    assertPasses("Bash", `printenv ${name}`, withMadeUpKey(t)));
}
for (const [shell, command] of CMD_SET_WINDOWS_NAMES) {
  test(`cmd's set with one of Windows' own names passes, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertPasses(shell, command, withMadeUpKey(t)));
}
for (const [shell, command] of CMD_SET_STILL_WIDE) {
  test(`cmd's set that can print a secret is stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertStopped(shell, command, withMadeUpKey(t)));
}

// A key file's name that goes on past an `_` to say what it holds, like its data or its text, holds the key itself.
const KEYFILE_CONTENT_NAMES = [
  ["Bash", "printenv SSH_KEYFILE_DATA"],
  ["Bash", "printenv SSH_KEYFILE_CONTENT"],
  ["Bash", "printenv TLS_KEYFILE_B64"],
  ["PowerShell", "gci env:SSH_KEYFILE_DATA"],
  ["PowerShell", "gci env:SSH_KEYFILE_CONTENT"],
  ["PowerShell", "gci env:TLS_KEYFILE_B64"],
  ["Bash", "printenv KEYFILE_DATA"],
  ["Bash", "printenv SSH_KEYFILE_PEM"],
  ["Bash", "printenv KEYFILE_CONTENTS"],
  ["Bash", "printenv KEYFILES_DATA"],
  ["PowerShell", "gci env:SSH_KEYFILE_B64"],
];
// A key file's own name or its place, a key's id, a vault's name and a keyboard still pass.
const KEY_NAMES_THAT_PASS = [
  "KEYFILE",
  "SSH_KEYFILE",
  "SSH_KEYFILES",
  "KEYFILE_PATH",
  "SSH_KEYFILE_PATH",
  "KEYFILE_DIR",
  "GPG_KEYID",
  "KEYID_",
  "DEPLOY_KEYID_VALUE",
  "KEYVAULT_NAME",
  "KEYBOARDS_X",
];
const KEY_NAMES_THAT_STOP = ["SSH_KEYIDENTITY", "SSH_KEYFILEDATA", "KEYIDX"];

for (const [shell, command] of KEYFILE_CONTENT_NAMES) {
  test(`a key file's content is stopped, ${shell}: ${JSON.stringify(command)}`, (t) =>
    assertVariableStopped(shell, command, withMadeUpKey(t), SECRET_VARIABLE));
}
for (const name of KEY_NAMES_THAT_PASS) {
  test(`a KEY name that holds no key passes: ${name}`, (t) =>
    assertPasses("Bash", `printenv ${name}`, withMadeUpKey(t)));
}
for (const name of KEY_NAMES_THAT_STOP) {
  test(`a KEY name that holds a key is stopped: ${name}`, (t) =>
    assertVariableStopped("Bash", `printenv ${name}`, withMadeUpKey(t), SECRET_VARIABLE));
}

// Regressions for gaps in Guard's hooks, commit check and MCP server. Sample values are assembled at run time, so this
// file holds no whole made-up credential.
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
const { countingLookups } = require("./guard-lookups.js");
const {
  quotedSeparatorShell,
  blankSpaceCommands,
  dottedOperandCommands,
  quotedRunCommands,
} = require("./guard-shell.js");
const { DEADLINE_PRELOAD, recordLongTimers, readLongTimers, assertDeadlineKept } = require("./guard-stand-in-clock.js");
// Tests that aren't about the search check's time limit give it time to finish on a busy machine.
const inspectRead = (tool, event, options) => guard.inspectRead(tool, event, { searchWalkMaxMs: 10000, ...options });

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-gaps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initGit(root) {
  const result = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// Guard asks the real rg what it would read when one is on PATH, and works it out from ripgrep's own rules when not,
// as on most machines. The rg cases run both ways, so the two answers can't drift apart.
const RIPGREP_ON_PATH = spawnSync("rg", ["--version"], { windowsHide: true }).status === 0;
const NO_RIPGREP =
  "no rg on PATH, so only ripgrep's rules were tried; put a folder holding rg first on PATH to try both";

function withoutRipgrep(t) {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  const original = process.env.PATH;
  process.env.PATH = original
    .split(path.delimiter)
    .filter((dir) => dir && !fs.existsSync(path.join(dir, name)))
    .join(path.delimiter);
  t.after(() => {
    process.env.PATH = original;
  });
}

// Each rg check here may start rg or git once or twice per file, so it gets time for that on a busy computer; only
// its other limits are tested.
const RIPGREP_ROOM = { searchWalkMaxMs: 10000 };

function bothRipgrepWays(name, fn) {
  test(`${name}, worked out from ripgrep's rules`, (t) => {
    withoutRipgrep(t);
    return fn(t);
  });
  test(`${name}, as the real rg reads it`, { skip: RIPGREP_ON_PATH ? false : NO_RIPGREP }, fn);
}

bothRipgrepWays("a search glob that names an ignored or hidden secret file overrides ripgrep's ignore rules", (t) => {
  const root = tempDir(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "app.js"), "const SAMPLE = 1;\n");
  const grep = (extra = {}) =>
    inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "SAMPLE", path: root, output_mode: "content", ...extra } },
      { cwd: root },
    );
  assert.equal(grep().action, "allow", "without a glob ripgrep skips the ignored .env");
  assert.equal(grep({ glob: "*.js" }).action, "allow", "a glob that leaves .env out passes");
  for (const glob of ["*", "**/*", ".env*", "*.{env,local}", ".env"]) {
    const outcome = grep({ glob });
    assert.equal(outcome.action, "block", `glob ${glob}`);
    assert.equal(outcome.location, ".env", `glob ${glob}`);
  }

  const cline = (extra = {}) =>
    inspectRead(
      "cline",
      {
        preToolUse: { toolName: "search_files", parameters: JSON.stringify({ path: root, regex: "SAMPLE", ...extra }) },
      },
      { cwd: root },
    );
  assert.equal(cline().action, "allow", "Cline's search skips the hidden, ignored .env");
  assert.equal(cline({ file_pattern: "*.js" }).action, "allow");
  assert.equal(cline({ file_pattern: "*" }).action, "block", "a file pattern overrides hidden and ignore rules");
});

bothRipgrepWays("Gemini's read_many_files passes over a git-ignored secret file and still finds a later one", (t) => {
  const root = tempDir(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env.local\n");
  fs.writeFileSync(path.join(root, ".env.local"), "SAMPLE=placeholder\n");
  const readMany = (include) =>
    inspectRead("gemini", { tool_name: "read_many_files", tool_input: { include } }, { cwd: root });
  const ignoredOnly = readMany(["**/*"]);
  assert.equal(ignoredOnly.action, "allow", "Gemini leaves the ignored file out");
  assert.ok(!ignoredOnly.searchLimited, "an ignored file is not a limit reached");

  fs.writeFileSync(path.join(root, "secrets.json"), '{"user":"example"}\n');
  const outcome = readMany(["**/*"]);
  assert.equal(outcome.action, "block");
  assert.equal(outcome.location, "secrets.json");
});

test("a Windows short name for a secret file is treated like the long name", (t) => {
  if (process.platform !== "win32") {
    t.skip("short names are a Windows file system feature");
    return;
  }
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "DB_HOST=localhost\n");
  fs.writeFileSync(path.join(root, "credentials.json"), '{"user":"example"}\n');
  let envShort;
  try {
    envShort = path.basename(fs.realpathSync.native(path.join(root, "ENV~1"))) === ".env" ? "ENV~1" : null;
  } catch {
    envShort = null;
  }
  if (!envShort) {
    t.skip("this volume doesn't make short names");
    return;
  }
  const mcp = require("../apps/guard/bin/clotr-mcp.js");
  for (const name of ["ENV~1", "CREDEN~1.JSO"]) {
    const file = path.join(root, name);
    const read = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root });
    assert.equal(read.action, "block", `Read ${name}`);
    assert.equal(read.secretFile, true, `Read ${name}`);
    assert.deepEqual(mcp.callTool("is_secret_file", { path: file }), { is_secret_file: true }, `MCP ${name}`);
  }
  for (const command of ["Get-Content ENV~1", "type ENV~1"]) {
    const shell = guard.inspectShell(
      "claude",
      { tool_name: "PowerShell", tool_input: { command, cwd: root } },
      { cwd: root },
    );
    assert.equal(shell.action, "block", command);
  }
});

// A folder with a secret file, an ordinary one, and a junction (a link to a folder, which any Windows account can make)
// with an ordinary name that opens .kube, where the secret file is config. The values are made up.
function devicePathFixture(t) {
  const root = fs.realpathSync.native(tempDir(t));
  fs.writeFileSync(path.join(root, ".env"), "DB_PASSWORD=synthetic-not-real-123\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "readme.md"), "readme\n");
  fs.mkdirSync(path.join(root, ".kube"));
  fs.writeFileSync(path.join(root, ".kube", "config"), "token: synthetic-not-real-123\n");
  fs.symlinkSync(path.join(root, ".kube"), path.join(root, "kubedir"), "junction");
  return root;
}

// Each way a Windows device path can name a file on a drive: `\\?\`, `\\.\`, `\??\`, Git Bash's `//?/`, and the device
// root's other names. Each opens the same file as the drive path.
const DEVICE_PREFIXES = ["\\\\?\\", "\\\\.\\", "\\??\\", "//?/", "//./", "\\\\.\\GLOBALROOT\\??\\", "\\\\?\\Global\\"];

// Every check that takes a path: Read, a content Grep of the file, Bash, PowerShell, cmd and the MCP tool.
function devicePathChecks(root) {
  const mcp = require("../apps/guard/bin/clotr-mcp.js");
  const shell = (command, toolName) =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  return {
    Read: (file) => inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root }).action,
    Grep: (file) =>
      inspectRead(
        "claude",
        { tool_name: "Grep", tool_input: { pattern: "DB_", path: file, output_mode: "content" } },
        { cwd: root },
      ).action,
    Bash: (file) => shell(`cat '${file.replace(/\\/g, "/")}'`, "Bash").action,
    PowerShell: (file) => shell(`Get-Content -LiteralPath '${file}'`, "PowerShell").action,
    cmd: (file) => shell(`cmd /c type "${file}"`, "PowerShell").action,
    MCP: (file) => (mcp.callTool("is_secret_file", { path: file }).is_secret_file ? "block" : "allow"),
  };
}

test("a junction behind a \\\\?\\ or \\\\.\\ device path is looked up like the drive path it opens", (t) => {
  if (process.platform !== "win32") {
    t.skip("device paths are a Windows feature");
    return;
  }
  const root = devicePathFixture(t);
  const checks = devicePathChecks(root);
  for (const prefix of DEVICE_PREFIXES) {
    // `..` is resolved the way Windows resolves it for `\\.\`, so it can't hide the folder the path ends in.
    for (const rest of ["kubedir\\config", "docs\\..\\kubedir\\config", "docs\\.\\..\\kubedir\\.\\config"]) {
      const file = `${prefix}${root}\\${rest}`;
      for (const [name, check] of Object.entries(checks)) assert.equal(check(file), "block", `${name} ${file}`);
    }
  }
  // A glob in a device path is expanded in the folder it opens, as it is in the drive path.
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "PowerShell", tool_input: { command, cwd: root } }, { cwd: root });
  for (const prefix of ["\\\\?\\", "\\\\.\\"]) {
    assert.equal(shell(`Get-Content '${prefix}${root}\\kubedir\\*'`).action, "block", `${prefix} kubedir\\*`);
    assert.equal(shell(`Get-Content '${prefix}${root}\\*'`).action, "block", `${prefix} *`);
  }
});

test("a Windows short name behind a \\\\?\\ or \\\\.\\ device path is treated like the long name", (t) => {
  if (process.platform !== "win32") {
    t.skip("short names are a Windows file system feature");
    return;
  }
  const root = devicePathFixture(t);
  let short;
  try {
    short = path.basename(fs.realpathSync.native(path.join(root, "ENV~1"))) === ".env" ? "ENV~1" : null;
  } catch {
    short = null;
  }
  if (!short) {
    t.skip("this volume doesn't make short names");
    return;
  }
  const checks = devicePathChecks(root);
  for (const prefix of DEVICE_PREFIXES) {
    for (const rest of [short, `docs\\..\\${short}`, `${short}::$DATA`]) {
      const file = `${prefix}${root}\\${rest}`;
      for (const [name, check] of Object.entries(checks)) assert.equal(check(file), "block", `${name} ${file}`);
    }
  }
});

test("a short name on a path Guard never looks up is stopped, since it could be any secret file", () => {
  // Guard doesn't look these up (see guard-network-paths.test.js), so a part like ENV~1 can't be told from .env.
  for (const file of [
    "\\\\fileserver.example\\share\\ENV~1",
    "\\\\?\\UNC\\fileserver.example\\share\\proj\\CREDEN~1.JSO",
    "//fileserver.example/share/ENV~1.",
  ]) {
    assert.equal(guard.isSecretPath(file), true, file);
    const shell = guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command: `cat '${file}'` } });
    assert.equal(shell.action, "block", file);
  }
  assert.equal(guard.isSecretPath("\\\\fileserver.example\\share\\notes~draft.txt"), false);
  // A relative operand in such a folder, a WSL one say, is judged by its name: `HEAD~1` there is a Git revision.
  const wsl = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj";
  assert.equal(guard.isSecretPath("HEAD~1", "", wsl), false);
  const revision = guard.inspectShell("claude", {
    tool_name: "Bash",
    tool_input: { command: "diff <(git show HEAD~1:app.js) app.js", cwd: wsl },
  });
  assert.equal(revision.action, "allow");
});

test("an ordinary file behind a \\\\?\\ or \\\\.\\ device path still goes through", (t) => {
  if (process.platform !== "win32") {
    t.skip("device paths are a Windows feature");
    return;
  }
  const root = devicePathFixture(t);
  const checks = devicePathChecks(root);
  for (const prefix of DEVICE_PREFIXES) {
    for (const rest of ["notes.txt", "docs\\readme.md", "docs\\..\\notes.txt", "no-such-file.txt"]) {
      const file = `${prefix}${root}\\${rest}`;
      for (const [name, check] of Object.entries(checks)) assert.equal(check(file), "allow", `${name} ${file}`);
    }
  }
  const shell = (command, toolName = "PowerShell") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const prefix of ["\\\\?\\", "\\\\.\\"]) {
    assert.equal(shell(`Get-Content '${prefix}${root}\\docs\\*'`).action, "allow", `${prefix} docs\\*`);
    assert.equal(shell(`Get-Content '${prefix}${root}\\docs\\*.md'`).action, "allow", `${prefix} docs\\*.md`);
  }
});

test("a device path is judged as written and as Windows tidies it, so a folder's last dots or spaces hide nothing", (t) => {
  if (process.platform !== "win32") {
    t.skip("device paths are a Windows feature");
    return;
  }
  const root = devicePathFixture(t);
  // `\\?\` makes folders whose names Windows would otherwise tidy away, each a junction to .kube.
  const names = ["k.", "s ", "d..", "..."];
  for (const name of names) fs.symlinkSync(path.join(root, ".kube"), `\\\\?\\${root}\\${name}`, "junction");
  const checks = devicePathChecks(root);
  for (const prefix of ["\\\\?\\", "\\??\\", "\\\\.\\", "//?/", "//./"]) {
    for (const name of names) {
      const file = `${prefix}${root}\\${name}\\config`;
      for (const [check, run] of Object.entries(checks)) assert.equal(run(file), "block", `${check} ${file}`);
    }
  }
  // `\\.\` drops a part's one last dot, the drive's (`C:.`) too, and the last part's dots and spaces.
  const drive = root.slice(0, 2);
  for (const file of [
    `\\\\.\\${drive}.${root.slice(2)}\\kubedir\\config`,
    `\\\\.\\${root}\\kubedir.\\config`,
    `\\\\.\\${root}\\kubedir\\config. .`,
  ]) {
    for (const [check, run] of Object.entries(checks)) assert.equal(run(file), "block", `${check} ${file}`);
  }
  // A device path written into a script's string doubles its backslashes.
  const shell = (command, toolName) =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  const inScript = `\\\\.\\${root}\\kubedir\\config`.replace(/\\/g, "\\\\");
  for (const toolName of ["Bash", "PowerShell"]) {
    const command = `node -e "require('fs').readFileSync('${inScript}')"`;
    assert.equal(shell(command, toolName).action, "block", `${toolName} ${command}`);
  }
  // Only a secret file is stopped, however the path is written.
  for (const file of [`\\\\?\\${root}\\notes.txt.`, `\\\\.\\${drive}.${root.slice(2)}\\docs\\readme.md`]) {
    for (const [check, run] of Object.entries(checks)) assert.equal(run(file), "allow", `${check} ${file}`);
  }
});

test("a double-quoted credential in MCP tool arguments is caught as it would be anywhere else", (t) => {
  const dir = tempDir(t);
  const value = ["Zq7k", "Lm2p", "R9vT", "x4Wn"].join("");
  const contents = [
    `DB_PASSWORD="${value}"`,
    `const config = { password: "${value}" };`,
    `password: "${value}"`,
    `{"client_secret": "${value}Q8sY3abc"}`,
  ];
  for (const content of contents) {
    for (const tool of ["claude", "cursor"]) {
      const input = { path: "x", content };
      const event = { tool_name: "mcp__fs__write_file", tool_input: tool === "cursor" ? JSON.stringify(input) : input };
      const outcome = guard.inspectTool(tool, event, { cwd: dir, dataDir: dir });
      assert.equal(outcome.action, "block", `${tool}: ${content.replace(value, "<value>")}`);
    }
  }
  const clean = guard.inspectTool(
    "claude",
    { tool_name: "mcp__fs__write_file", tool_input: { path: "x", content: 'const name = "example";' } },
    { cwd: dir, dataDir: dir },
  );
  assert.equal(clean.action, "allow");
});

function git(root, args, input) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8", input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitRepo(t) {
  const root = tempDir(t);
  initGit(root);
  git(root, ["config", "user.name", "Example"]);
  git(root, ["config", "user.email", "example@example.invalid"]);
  git(root, ["config", "core.symlinks", "false"]);
  return root;
}

const PASSWORD_LINE = `db_password = ${["Zq7k", "Lm2p", "R9vT", "x4Wn"].join("")}`;

test("commit-check reads a path whose type changed from a link to a file", (t) => {
  const root = commitRepo(t);
  fs.writeFileSync(path.join(root, "app.example.cfg"), "db_password = \n");
  git(root, ["add", "app.example.cfg"]);
  const target = git(root, ["hash-object", "-w", "--stdin"], "app.example.cfg");
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${target},app.cfg`]);
  git(root, ["commit", "-q", "-m", "link"]);
  const blob = git(root, ["hash-object", "-w", "--stdin"], `${PASSWORD_LINE}\n`);
  git(root, ["update-index", "--cacheinfo", `100644,${blob},app.cfg`]);
  assert.match(git(root, ["diff", "--cached", "--name-status"]), /^T\s+app\.cfg$/);
  const { issues } = guard.checkStaged({ cwd: root });
  assert.deepEqual(
    issues.map((issue) => [issue.file, issue.kind]),
    [["app.cfg", "password"]],
  );
});

test("commit-check reads an added line whose text starts with '++ '", (t) => {
  const root = commitRepo(t);
  fs.writeFileSync(path.join(root, "notes.md"), `++ ${PASSWORD_LINE}\n`);
  git(root, ["add", "notes.md"]);
  const { issues } = guard.checkStaged({ cwd: root });
  assert.deepEqual(
    issues.map((issue) => [issue.file, issue.line, issue.kind]),
    [["notes.md", 1, "password"]],
  );
});

test("check reads a UTF-16 file the way it reads UTF-16 on stdin", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const text = `${PASSWORD_LINE}\r\n`;
  const files = {
    "u8.txt": Buffer.from(text, "utf8"),
    "u16.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    "u16be.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
    "u16-no-mark.txt": Buffer.from(text, "utf16le"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), bytes);
    const result = spawnSync(process.execPath, [script, "check", name, "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(
      JSON.parse(result.stdout).findings.map((finding) => finding.kind),
      ["password"],
      name,
    );
  }
  fs.writeFileSync(path.join(root, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x05]));
  const binary = spawnSync(process.execPath, [script, "check", "data.bin"], { cwd: root, encoding: "utf8" });
  assert.equal(binary.status, 2, "bytes that aren't text can't be checked");
});

const AWS_LINE = `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}`;

// A file that isn't clean text was answered "couldn't check" with exit 2, so a script that stops only on exit 1 let a
// key in it through.
test("check reports a key in a file with stray control bytes, and can't check only a file where none is found", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const run = (...args) => spawnSync(process.execPath, [script, "check", ...args], { cwd: root, encoding: "utf8" });
  const line = Buffer.from(`${AWS_LINE}\n`);
  const sqlite = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\0").copy(sqlite, 0);
  sqlite.writeUInt16BE(4096, 16);
  line.copy(sqlite, 2048);
  const shapes = {
    "UTF-8 text with a stray NUL": Buffer.concat([Buffer.from("notes\n"), Buffer.from([0]), line]),
    "a database page holding a key": sqlite,
    "single-byte text with control bytes": Buffer.concat([line, Buffer.from([1, 2, 0xe9, 0x0a])]),
  };
  for (const [shape, bytes] of Object.entries(shapes)) {
    fs.writeFileSync(path.join(root, "blob.dat"), bytes);
    const json = run("--json", "blob.dat");
    assert.equal(json.status, 1, `${shape}: ${json.stderr}`);
    assert.deepEqual(
      JSON.parse(json.stdout).findings.map((finding) => finding.kind),
      ["aws_access_key"],
      shape,
    );
    const plain = run("blob.dat");
    assert.equal(plain.status, 1, shape);
    assert.match(plain.stdout, /aws_access_key/, shape);
    assert.doesNotMatch(plain.stdout, /R6TWLJ3N/, shape);
  }
  fs.writeFileSync(path.join(root, "blob.dat"), Buffer.concat([Buffer.from("notes\n"), Buffer.from([0, 1, 2])]));
  const clean = run("blob.dat");
  assert.equal(clean.status, 2, "a file that isn't text, with nothing found, isn't called clean");
  assert.equal(clean.stdout, "");
  assert.match(clean.stderr, /couldn't check/);
});

// Read as UTF-8, a compressed or compiled file is mostly broken and control characters, where loose patterns turn up
// findings that aren't there.
test("check says it can't check a file of mostly binary bytes, instead of listing findings that aren't there", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  // The same bytes every run: a small linear congruential generator.
  let seed = 12345;
  const noise = Buffer.alloc(1024 * 1024 - 64);
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    noise[i] = seed >>> 24;
  }
  for (const [name, bytes] of Object.entries({
    "noise.bin": noise,
    "noise-and-key.bin": Buffer.concat([noise.subarray(0, 4096), Buffer.from(`\n${AWS_LINE}\n`), noise.subarray(4096)]),
    "zeros.bin": Buffer.alloc(4096),
  })) {
    fs.writeFileSync(path.join(root, name), bytes);
    const out = spawnSync(process.execPath, [script, "check", name], { cwd: root, encoding: "utf8" });
    assert.equal(out.status, 2, `${name}: ${out.stdout}`);
    assert.equal(out.stdout, "", name);
    assert.match(out.stderr, /couldn't check/, name);
  }
});

// Windows PowerShell 5.1's `>` writes UTF-16, and `cmd /c echo ... >>`, Node or Python then add UTF-8 lines, which a
// UTF-16 reading turns into other letters.
function utf16WithUtf8Line(line) {
  const u16 = (text) => Buffer.from(text, "utf16le");
  return {
    "UTF-16LE with a mark, then a UTF-8 line": Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      u16("log start\r\n"),
      Buffer.from(`${line}\n\n`),
    ]),
    "UTF-16LE without a mark, then a UTF-8 line": Buffer.concat([
      u16("log start one\r\nlog start two\r\nlog start three, a longer line of notes\r\n"),
      Buffer.from(`${line}\n`),
    ]),
    "a mark, then UTF-8": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${line}\n`)]),
    "UTF-16BE with a mark, then a UTF-8 line": Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(u16("log start\r\n")).swap16(),
      Buffer.from(`${line}\n\n`),
    ]),
  };
}

test("check, the read hook and the commit check find a key in a UTF-8 line added to a UTF-16 file", (t) => {
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  for (const [shape, bytes] of Object.entries(utf16WithUtf8Line(AWS_LINE))) {
    const root = commitRepo(t);
    const file = path.join(root, "log.txt");
    fs.writeFileSync(file, bytes);
    const out = spawnSync(process.execPath, [script, "check", "--json", file], { cwd: root, encoding: "utf8" });
    assert.equal(out.status, 1, `${shape}: ${out.stderr}`);
    assert.deepEqual(
      JSON.parse(out.stdout).findings.map((finding) => finding.kind),
      ["aws_access_key"],
      shape,
    );
    const read = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root });
    assert.equal(read.action, "block", shape);
    git(root, ["add", "log.txt"]);
    assert.deepEqual(
      guard.checkStaged({ cwd: root }).issues.map((issue) => issue.kind),
      ["aws_access_key"],
      shape,
    );
  }
  // A UTF-16 file alone, its letters all beside a zero byte, has no other reading to add.
  const root = tempDir(t);
  const file = path.join(root, "notes.txt");
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("plain notes, é and ü\r\n", "utf16le")]),
  );
  const out = spawnSync(process.execPath, [script, "check", "--json", file], { cwd: root, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root }).action,
    "allow",
  );
});

// A UTF-8 line with an odd number of bytes leaves a UTF-16 file a byte past its last whole letter. Such a file was
// read as its UTF-8 line alone, so a key in the UTF-16 part passed, and check called the file clean.
function utf16WithOddLine(line, after) {
  const u16 = (text) => Buffer.from(text, "utf16le");
  return {
    "UTF-16LE with a mark": Buffer.concat([Buffer.from([0xff, 0xfe]), u16(`${line}\r\n`), Buffer.from(after)]),
    "UTF-16LE without a mark": Buffer.concat([
      u16(`REGION=eu-west-1\r\nDEBUG=false\r\n${line}\r\n`),
      Buffer.from(after),
    ]),
    "UTF-16BE with a mark": Buffer.concat([Buffer.from([0xfe, 0xff]), u16(`${line}\r\n`).swap16(), Buffer.from(after)]),
  };
}

test("check, the read hook and the commit check find a key in a UTF-16 file with an odd-length UTF-8 line after it", (t) => {
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const check = (root, file) =>
    spawnSync(process.execPath, [script, "check", "--json", file], { cwd: root, encoding: "utf8" });
  for (const after of ["REGION=us-east-1\n", "NAME=café\n"]) {
    for (const [shape, bytes] of Object.entries(utf16WithOddLine(AWS_LINE, after))) {
      const name = `${shape}, then ${JSON.stringify(after)}`;
      assert.equal(bytes.length % 2, 1, name);
      const root = commitRepo(t);
      const file = path.join(root, "notes.txt");
      fs.writeFileSync(file, bytes);
      const out = check(root, file);
      assert.equal(out.status, 1, `${name}: ${out.stderr}`);
      assert.deepEqual(
        JSON.parse(out.stdout).findings.map((finding) => finding.kind),
        ["aws_access_key"],
        name,
      );
      const read = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root });
      assert.equal(read.action, "block", name);
      git(root, ["add", "notes.txt"]);
      assert.deepEqual(
        guard.checkStaged({ cwd: root }).issues.map((issue) => issue.kind),
        ["aws_access_key"],
        name,
      );
    }
  }
  const root = tempDir(t);
  const file = path.join(root, "both.env");
  const stripe = ["sk_", "live_", "Rf8Wq2Lx", "7Nd4Tz9K", "p3Vb6Hm1"].join("");
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${AWS_LINE}\r\n`, "utf16le"),
      Buffer.from(`STRIPE_KEY=${stripe}\n`),
    ]),
  );
  const both = check(root, file);
  assert.equal(both.status, 1, both.stderr);
  assert.deepEqual(
    JSON.parse(both.stdout)
      .findings.map((finding) => finding.kind)
      .sort(),
    ["aws_access_key", "stripe_secret_key"],
  );
  // Clean only when both parts were read: a rest that isn't UTF-8 leaves the file not checked in full.
  const shapes = {
    "a clean UTF-16 file and a clean UTF-8 line": [Buffer.from("LOG=info\n"), 0],
    "a clean UTF-16 file and bytes that aren't text": [Buffer.from([0x41, 0x01, 0xc3]), 2],
  };
  for (const [shape, [rest, status]] of Object.entries(shapes)) {
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("REGION=us-east-1\r\n", "utf16le"), rest]),
    );
    const out = check(root, file);
    assert.equal(out.status, status, `${shape}: ${out.stdout}${out.stderr}`);
    assert.equal(JSON.parse(out.stdout || '{"findings":[]}').findings.length, 0, shape);
  }
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${AWS_LINE}\r\n`, "utf16le"), Buffer.from([0x41, 1, 0xc3])]),
  );
  const keyAndBytes = check(root, file);
  assert.equal(keyAndBytes.status, 1, keyAndBytes.stderr);
  assert.deepEqual(
    JSON.parse(keyAndBytes.stdout).findings.map((finding) => finding.kind),
    ["aws_access_key"],
  );
  // UTF-16 added after the odd line, as PowerShell 5.1's `>>` adds it, is a byte out of step with the file's own.
  const u16 = (text) => Buffer.from(text, "utf16le");
  const later = (rest) =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), u16("REGION=us-east-1\r\n"), Buffer.from("LOG=info\n"), u16(rest)]);
  fs.writeFileSync(file, later(`${AWS_LINE}\r\n`));
  const shifted = check(root, file);
  assert.equal(shifted.status, 1, shifted.stderr);
  assert.deepEqual(
    JSON.parse(shifted.stdout).findings.map((finding) => finding.kind),
    ["aws_access_key"],
  );
  assert.equal(
    inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root }).action,
    "block",
  );
  fs.writeFileSync(file, later("DEBUG=false\r\n"));
  assert.equal(check(root, file).status, 2, "UTF-16 out of step isn't read in full");
});

// The engine reads a word just before a zero byte or a control byte as a value, so a file with a stray zero byte in
// ordinary text got a made-up finding where check had said it couldn't check the file.
test("check reads zero and control bytes in a file that isn't clean text as spaces", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const file = path.join(root, "app.log");
  const ordinary = "build finished, 42 files changed\n".repeat(40);
  for (const line of [
    "Go to the login / signup page and click next. The login form has username / password fields.",
    "I changed my password. Thanks for the tip about the password manager!",
  ]) {
    for (const stray of [[0], [1, 0], [0x1b, 0], [0x7f, 0], [0xff, 0], [0, 0xc2, 0x85]]) {
      const name = `${line.slice(0, 20)} + ${stray.join(",")}`;
      fs.writeFileSync(
        file,
        Buffer.concat([Buffer.from(`${ordinary}${line}`), Buffer.from(stray), Buffer.from(`\n${ordinary}`)]),
      );
      const out = spawnSync(process.execPath, [script, "check", file], { cwd: root, encoding: "utf8" });
      assert.equal(out.status, 2, `${name}: ${out.stdout}`);
      assert.equal(out.stdout, "", name);
      assert.match(out.stderr, /couldn't check/, name);
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(ordinary), Buffer.from(AWS_LINE), Buffer.from([0, 0x0a])]));
  const key = spawnSync(process.execPath, [script, "check", file], { cwd: root, encoding: "utf8" });
  assert.equal(key.status, 1, key.stderr);
  assert.match(key.stdout, /aws_access_key/);
});

// Hindi in UTF-16 without a byte order mark isn't mostly ASCII, so it isn't read as UTF-16, and read loosely as UTF-8 its
// digits come out a space apart, which the engine took for phone numbers in ordinary messages.
test("check finds nothing in ordinary messages saved as UTF-16 without a byte order mark", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const file = path.join(root, "messages.txt");
  for (const language of ["", "-ar", "-de", "-es", "-es-numbers", "-fr", "-hi", "-ja", "-pt", "-zh"]) {
    const name = `normal-messages${language}.txt`;
    const text = fs
      .readFileSync(path.join(__dirname, "corpus", name), "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line !== "---")
      .join("\r\n");
    for (const order of ["little", "big"]) {
      const bytes = Buffer.from(text, "utf16le");
      fs.writeFileSync(file, order === "big" ? bytes.swap16() : bytes);
      const out = spawnSync(process.execPath, [script, "check", "--json", file], { cwd: root, encoding: "utf8" });
      assert.notEqual(out.status, 1, `${name}, ${order}-endian: ${out.stdout}`);
    }
  }
});

// Windows PowerShell 5.1's `>>` adds UTF-16 without a byte order mark to a UTF-8 log. A few such lines, read loosely as
// UTF-8, came out as digits a space apart, which the engine took for a phone number that isn't in the file.
test("check lists only what's in a UTF-8 log with a few UTF-16 lines PowerShell added to it", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const findings = (bytes) => {
    fs.writeFileSync(path.join(root, "build.log"), bytes);
    const out = spawnSync(process.execPath, [script, "check", "--json", "build.log"], { cwd: root, encoding: "utf8" });
    const listed = JSON.parse(out.stdout || '{"findings":[]}').findings;
    return { status: out.status, listed: listed.map((finding) => `${finding.kind} ${finding.masked}`) };
  };
  const steps = (lines) =>
    Array.from(
      { length: lines },
      (_, i) =>
        `[${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}] step ${i}: module ${i % 17}, ok\n`,
    ).join("");
  const log = (lines, from = 0) =>
    Array.from(
      { length: lines },
      (_, i) => `2026-11-10 10:${String((i + from) % 60).padStart(2, "0")}:00 INFO build step ${i + from} finished\n`,
    ).join("");
  const key16 = `AWS_ACCESS_KEY_ID=${["AKIA", "Q7ZD2MXK", "P4WT9RLB"].join("")}\r\n`;
  // Each shape's parts, true for one PowerShell added in UTF-16, and what check lists in it.
  const shapes = {
    "two ipconfig lines": [
      [
        [false, steps(300)],
        [
          true,
          "   IPv4 Address. . . . . . . . . . . : 192.168.1.23\r\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\r\n",
        ],
      ],
      ["internal_ip 19…3"],
    ],
    "a test summary, a duration and a date": [
      [
        [false, steps(150)],
        [true, "Tests: 412 passed, 0 failed\r\nDuration: 00:01:23.4567\r\nDone at 2026-11-10 10:42\r\n"],
      ],
      [],
    ],
    "two deploy lines between UTF-8 runs": [
      [
        [false, steps(120)],
        [true, "Deploy 2026-11-10 10:42:17 start\r\n"],
        [false, steps(80)],
        [true, "Deploy 2026-11-10 10:44:03 end\r\n"],
      ],
      [],
    ],
    "two log lines": [
      [
        [false, log(60)],
        [true, log(2, 500)],
        [false, log(20, 900)],
      ],
      [],
    ],
    "a key in UTF-8 after the UTF-16": [
      [
        [false, log(60)],
        [true, log(2, 500)],
        [false, `${AWS_LINE}\n${log(20, 900)}`],
      ],
      ["aws_access_key AK…3N"],
    ],
    "a key in UTF-8 before the UTF-16": [
      [
        [false, `${AWS_LINE}\n${log(60)}`],
        [true, log(2, 500)],
        [false, log(20, 900)],
      ],
      ["aws_access_key AK…3N"],
    ],
    "a key in the UTF-16": [
      [
        [false, log(60)],
        [true, `${key16}${log(2, 500)}`],
        [false, log(20, 900)],
      ],
      ["aws_access_key AK…LB"],
    ],
  };
  for (const [shape, [parts, listed]] of Object.entries(shapes)) {
    const asUtf8 = findings(Buffer.from(parts.map(([, text]) => text).join("")));
    assert.deepEqual(asUtf8.listed, listed, `${shape}, all in UTF-8`);
    const mixed = findings(Buffer.concat(parts.map(([wide, text]) => Buffer.from(text, wide ? "utf16le" : "utf8"))));
    assert.deepEqual(mixed.listed, listed, shape);
    assert.equal(mixed.status, listed.length ? 1 : 2, shape);
  }
});

// A character whose low byte is zero, like the box-drawing line ─ or the ideographic space, reads a byte out of step as
// an ASCII letter, so a clean UTF-16 file with a run of them was taken for one a UTF-8 line had knocked out of step.
test("check passes clean UTF-16 files with box-drawing lines or runs of ideographic spaces", (t) => {
  const root = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const file = path.join(root, "notes.txt");
  const le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const be = (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  const minutes = "議事録\r\n　　　　　出席者　田中　佐藤\r\n本文です　　　　以上\r\n";
  const shapes = {
    "a table PowerShell saved": le(
      "┏━━━━━━━━┳━━━━━━━━━━┓\r\n┃ Name   ┃ Value    ┃\r\n┡━━━━━━━━╇━━━━━━━━━━┩\r\n│ mode   │ dev      │\r\n" +
        "│ region │ eu-west  │\r\n└────────┴──────────┘\r\n",
    ),
    "a rule under a heading": le("Results\r\n────────────────────\r\nall checks passed\r\n"),
    "Japanese notes lined up with ideographic spaces": le(
      "会議メモ\r\n日時　　　　１１月１０日\r\n場所　　　　会議室Ａ\r\n出席者　　　田中、佐藤\r\n",
    ),
    "Chinese notes lined up the same way": le("项目说明\r\n名称　　　　测试环境\r\n负责人　　　王伟\r\n"),
    "Japanese minutes, little-endian": le(minutes),
    "Japanese minutes, big-endian": be(minutes),
    "20 ideographic spaces": le(`見出し${"　".repeat(20)}終わり\r\n`),
    "a box around Japanese": le("┌────────────┐\r\n│ メモ       │\r\n└────────────┘\r\n"),
    "an ASCII table with a box rule": le("Name      Value\r\n──────────────────\r\nmode      dev\r\n"),
    "a run of 一": le("数字一一一一一です\r\n"),
  };
  for (const [shape, bytes] of Object.entries(shapes)) {
    fs.writeFileSync(file, bytes);
    const out = spawnSync(process.execPath, [script, "check", file], { cwd: root, encoding: "utf8" });
    assert.equal(out.status, 0, `${shape}: ${out.stdout}${out.stderr}`);
  }
  // UTF-16 a UTF-8 line knocked out of step is still read for its letters, after a rule too.
  fs.writeFileSync(
    file,
    Buffer.concat([
      le("Results\r\n────────────────────\r\n"),
      Buffer.from("LOG=info\n"),
      Buffer.from(`${AWS_LINE}\r\n`, "utf16le"),
    ]),
  );
  const out = spawnSync(process.execPath, [script, "check", "--json", file], { cwd: root, encoding: "utf8" });
  assert.equal(out.status, 1, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).findings.map((finding) => finding.kind),
    ["aws_access_key"],
  );
});

// A UTF-16 letter outside ASCII reads as UTF-8 as a broken byte, an ASCII letter or a tab, so a second UTF-8 reading of
// a Japanese or Hindi file gave the engine about half again as much text, all of it made of nothing.
test("the second reading of a UTF-16 file in another script adds next to nothing", () => {
  const corpus = (name) =>
    fs
      .readFileSync(path.join(__dirname, "corpus", name), "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line !== "---")
      .join("\r\n");
  for (const language of ["ja", "zh", "hi", "ar"]) {
    const name = `normal-messages-${language}.txt`;
    const text = corpus(name);
    const read = guard.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), false);
    assert.ok(read.startsWith(text), name);
    const added = read.slice(text.length).replace(/\s/g, "").length;
    assert.ok(added * 20 <= text.length, `${name}: ${added} characters added to ${text.length}`);
  }
});

test("the read hook's second reading of a UTF-16 file stays linear on 300 KB of zero bytes and letters", (t) => {
  const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");
  const dir = tempDir(t);
  const shapes = {
    "letter, zero, zero": [0x61, 0, 0],
    "zero, letter, zero": [0, 0x61, 0],
    "a mark's bytes": [0xff, 0xfe, 0],
    "UTF-8 beside UTF-16": [0x61, 0, 0x62, 0x63, 0xe9, 0],
  };
  for (const [name, unit] of Object.entries(shapes)) {
    const make = (n, file) => {
      const body = Buffer.alloc(n);
      for (let i = 0; i < n; i++) body[i] = unit[i % unit.length];
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
      return () => inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: dir });
    };
    const small = make(30_000, path.join(dir, "small.txt"));
    const big = make(300_000, path.join(dir, "big.txt"));
    const grew = grewEveryTime(
      () => bestOfPair(small, big),
      (s, b) => grewMoreThan(s, b, 30),
    );
    assert.equal(grew, null, `${name}: ${grew && grew.map((x) => x.wall.toFixed(1)).join(" -> ")} ms`);
  }
});

// Blank space before a reader, long runs of dots, spaces or colons, and long quoted runs were slow shapes for a regex,
// whose backtracking inside one run no count sees (their counts are in tests/guard-work.test.js), so they're timed as
// growth, each measured again before it's called slow: 4 times the input may take at most 10 times as long, where
// backtracking took 16 or more, unless `times` and `limit` say otherwise. `commandOf(size)` has a run of about `size`
// characters, and `action` is its answer, "block" stopped for .env and "stop" for any file.
const SHELL_TIME_GROWTH = 10;
function assertShellTimeLinear(root, label, commandOf, toolName, size, { action = "block", times = 4, limit } = {}) {
  const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");
  const shell = quotedSeparatorShell(root);
  const check = (command) => () => shell(command, toolName);
  const small = check(commandOf(size / times));
  const big = check(commandOf(size));
  const outcome = big();
  assert.equal(outcome.action, action === "stop" ? "block" : action, label);
  if (action === "block") {
    assert.equal(outcome.location, ".env", `${label} is stopped for .env, not for running out of time`);
  }
  const grew = grewEveryTime(
    () => bestOfPair(small, big, times),
    (s, b) => grewMoreThan(s, b, limit ?? SHELL_TIME_GROWTH),
  );
  assert.equal(grew, null, `${label}: ${grew && grew.map((x) => x.wall.toFixed(1)).join(" -> ")} ms`);
}

test("a long run of blank space before a shell reader is checked quickly", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  for (const [label, commandOf, toolName, size] of blankSpaceCommands()) {
    assertShellTimeLinear(root, label, commandOf, toolName, size);
  }
});

test("an operand with a long run of dots, spaces or colons is read quickly, wherever the run sits", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  for (const [label, commandOf, toolName] of dottedOperandCommands()) {
    assertShellTimeLinear(root, label, commandOf, toolName, 300_000);
  }
});

// Timed at 8,000 and 64,000 characters, both under the 64 KB where a commit message's content check moves to a worker
// (about 7 ms to 210 ms), which a pair across it would read as growth. Under it a backtracking pattern costs little
// beside the rest, so the pair is 8 times the input with a limit of 16, the staged check's clock growth before it was
// counted, where linear work measured 3.3 and a planted quadratic scan 37 and up.
test("a long quoted run is checked in linear time", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  for (const [label, commandOf, toolName, action] of quotedRunCommands()) {
    assertShellTimeLinear(root, label, commandOf, toolName, 64_000, { action, times: 8, limit: 16 });
  }
});

test("a glob at the end of a 300,000-character path is checked in linear time", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const run = (text) => text.repeat(Math.ceil(300_000 / text.length));
  // A glob at the end of a long path is found by joining the path's plain folders once. A path too long to look up is
  // judged by its name, which a `*` could make a secret file's, so it's stopped there: for any file, not only .env.
  for (const [command, toolName] of [
    [`cat ${run("a/")}*; cat .env`, "Bash"],
    [`cat ${run("a/")}*; cat .env`, "PowerShell"],
    [`cat ${run("a/")}*; cat .env`, "Cursor"],
    [`grep -r SAMPLE ${run("a/")}*; cat .env`, "Bash"],
  ]) {
    const label = `${toolName} ${JSON.stringify(command.slice(0, 24))}…`;
    const started = Date.now();
    const outcome =
      toolName === "Cursor"
        ? guard.inspectShell("cursor", { command, cwd: root })
        : guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } });
    const elapsed = Date.now() - started;
    assert.equal(outcome.action, "block", label);
    assert.ok(elapsed < 2500, `${label} took ${elapsed} ms`);
  }
});

test("ordinary file names with spaces and dots in them go through", (t) => {
  const root = tempDir(t);
  const names = [
    "release notes v1.2.3.txt",
    "draft . final.md",
    "notes .. backup.txt",
    "...hidden notes.txt",
    `notes${" .".repeat(100)}txt`,
  ];
  for (const name of names) fs.writeFileSync(path.join(root, name), "ordinary text\n");
  const quoted = names.map((name) => `"${name}"`).join(" ");
  for (const [command, toolName] of [
    [`cat ${quoted}`, "Bash"],
    [`grep text ${quoted}`, "Bash"],
    [`Get-Content -LiteralPath ${names.map((name) => `'${name}'`).join(",")}`, "PowerShell"],
  ]) {
    const outcome = guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } });
    assert.equal(outcome.action, "allow", `${toolName} ${command}`);
  }
  for (const name of names) {
    assert.equal(guard.isSecretPath(path.join(root, name), "", root), false, name);
    const read = inspectRead(
      "claude",
      { tool_name: "Read", tool_input: { file_path: path.join(root, name) } },
      {
        cwd: root,
      },
    );
    assert.equal(read.action, "allow", `Read ${name}`);
  }
});

test("the shell check knows close variants of the forms it already stops", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "export -p",
    "typeset -p",
    "sudo cat .env",
    "command cat .env",
    "nohup cat .env",
    "time cat .env",
    "env cat .env",
    "grep -rn SAMPLE .",
    "grep -r SAMPLE",
    "grep --recursive SAMPLE .",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
  for (const command of [
    "Get-ChildItem -Path Env:",
    "$all = [Environment]::GetEnvironmentVariables()",
    "Select-String -Path .env -Pattern KEY",
    "sls KEY .env",
    "findstr KEY .env",
    "cmd /c type .env",
  ]) {
    assert.equal(shell(command, "PowerShell").action, "block", command);
  }
  for (const command of [
    "export FOO=1",
    "command -v node",
    "time npm test",
    "grep -rn SAMPLE src",
    "grep -rn --include=*.js SAMPLE .",
    "grep -n SAMPLE src/app.js",
    "findstr SAMPLE src\\app.js",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
});

// Commands that read .env however their words are quoted, by the tool that runs them. Each list is a test's below;
// the last test runs them all again.
function quotedSeparatorBlocks() {
  const cases = [];
  for (const separator of ["|", ";", "&", ")", "`", "&&", "||", "\n"]) {
    const one = separator.length === 1;
    // In Bash's double quotes a backtick starts a command that never ends, so Bash runs none of it.
    const bashDouble = separator !== "`";
    // Bash: single quotes, double quotes, backslash and $'…'.
    cases.push([`cat 'a${separator}b' .env`, "Bash"]);
    if (bashDouble) cases.push([`cat "a${separator}b" .env`, "Bash"]);
    if (one) cases.push([`cat a\\${separator}b .env`, "Bash"]);
    cases.push([`cat $'a${separator}b' .env`, "Bash"]);
    cases.push([`grep SAMPLE "x" 'a${separator}b' .env`, "Bash"]);
    // PowerShell: both quotes, its typographic quotes, the backtick escape, and a comma list.
    cases.push([`Get-Content "a${separator}b", .env`, "PowerShell"]);
    cases.push([`Get-Content 'a${separator}b' .env`, "PowerShell"]);
    cases.push([`Get-Content “a${separator}b”, .env`, "PowerShell"]);
    cases.push([`type ‘a${separator}b’ .env`, "PowerShell"]);
    if (one) cases.push([`Get-Content a\`${separator}b .env`, "PowerShell"]);
    // cmd: double quotes and ^, run through cmd /c from either shell, and in Cursor's terminal.
    if (bashDouble) cases.push([`cmd /c type "a${separator}b" .env`, "Bash"]);
    cases.push([`cmd /c type "a${separator}b" .env`, "PowerShell"]);
    cases.push([`type "a${separator}b" .env`, "Cursor"]);
    if (one) {
      if (bashDouble) cases.push([`cmd /c "type a^${separator}b .env"`, "Bash"]);
      cases.push([`cmd /c "type a^${separator}b .env"`, "PowerShell"]);
      cases.push([`type a^${separator}b .env`, "Cursor"]);
    }
  }
  return cases;
}

// Each is stopped for .env by the shell's own reading of the command.
function assertStoppedForEnv(shell, cases) {
  for (const [command, toolName] of cases) {
    const outcome = shell(command, toolName);
    assert.equal(outcome.action, "block", `${toolName} ${JSON.stringify(command)}`);
    assert.equal(outcome.location, ".env", `${toolName} ${JSON.stringify(command)} is stopped for .env`);
  }
}

test("a separator inside quotes doesn't end a reader's files, in Bash, PowerShell or cmd", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  assertStoppedForEnv(quotedSeparatorShell(root, "new"), quotedSeparatorBlocks());
});

const NESTED_QUOTING_BLOCKS = [
  // Quotes inside a command substitution inside quotes, arithmetic and ${…}, which hold their own `|`.
  ['cat "$(echo "a|b")" .env', "Bash"],
  ["cat $((1|2)) .env", "Bash"],
  ["cat ${x:-a|b} .env", "Bash"],
  // Quoted parts of one word, and a name spelled with $'…' escapes.
  ['cat ".e"nv', "Bash"],
  ["cat $'\\x2eenv'", "Bash"],
  ['tr a b < ".e"nv', "Bash"],
  // A quote over a line break, a redirection, `--`, and a quote after a real separator.
  ["cat 'a\n|b' .env", "Bash"],
  ["cat a 2>&1 .env", "Bash"],
  ["cat -- .env", "Bash"],
  ["echo \"x; y\" && cat 'a&b' .env", "Bash"],
  // An apostrophe in a here-document is text, and a shell given one runs its lines.
  ['cat <<EOF\nit\'s\nEOF\ncat "a|b" .env', "Bash"],
  ['bash <<EOF\ncat "a|b" .env\nEOF', "Bash"],
  // Shells inside shells, each read with its own quote rules.
  ["sh -c \"x; cat 'a|b' .env\"", "Bash"],
  ["bash -lc 'cat \"a|b\" .env'", "Bash"],
  ["ssh host \"x; cat 'a|b' .env\"", "Bash"],
  ["pwsh -NoProfile -Command \"Get-Content 'a;b', .env\"", "PowerShell"],
  ["powershell -ExecutionPolicy Bypass \"Get-Content 'a;b', .env\"", "Bash"],
  ['cmd /c "type .env"', "PowerShell"],
  ['bash -c \'pwsh -c "Get-Content \\"a;b\\", .env"\'', "Bash"],
  // PowerShell's doubled quotes, here-strings, script blocks and assignments.
  ['Get-Content "a""|b" .env', "PowerShell"],
  ["gc 'it''s;x' .env", "PowerShell"],
  ['Get-Content @"\na;b\n"@, .env', "PowerShell"],
  ["Invoke-Command { Get-Content 'a|b', .env }", "PowerShell"],
  ["$x = Get-Content 'a;b', .env", "PowerShell"],
  ["Get-Content -Path:.env", "PowerShell"],
  ['cat "a`b" .env', "PowerShell"],
  ["cat 'a|b' .env", "Cursor"],
  // A reader inside another reader's words, a here-document or a here-string, which run what's in $(…).
  ["cat <<EOF\n$(cat .env)\nEOF", "Bash"],
  ["cat > out.txt <<EOF\nvalue: $(cat .env)\nEOF", "Bash"],
  ["head -5 README.md\nwc -l <<EOF\n$(cat .env)\nEOF", "Bash"],
  ["cat README.md\necho $[1<<2]\ncat .env", "Bash"],
  ['timeout 5 sh -c "echo hi\ncat x\ncat .env"', "Bash"],
  ['Get-Content README.md\n@"\n$(gc .env)\n"@', "PowerShell"],
  ['sls -InputObject @"\n$(gc .env)\n"@ -Pattern .', "PowerShell"],
  // However the command in that $(…) starts.
  ["cat <<EOF\n$(\\cat .env)\nEOF", "Bash"],
  ["cat <<EOF\n$({ cat .env; })\nEOF", "Bash"],
  ["cat <<EOF\n$(/bin/cat .env)\nEOF", "Bash"],
  ["cat <<EOF\n$(x=1 cat .env)\nEOF", "Bash"],
  ['cat <<EOF\n$("cat" .env)\nEOF', "Bash"],
  ["cat > out.txt <<EOF\nv=$(\\cat .env)\nEOF", "Bash"],
  ["head -1 README.md\nwc -l <<EOF\n`\\cat .env`\nEOF", "Bash"],
  ['Get-Content README.md\n@"\n$(. gc .env)\n"@', "PowerShell"],
  ['Get-Content README.md\n@"\n$(& "gc" .env)\n"@', "PowerShell"],
  // Quoted text another shell runs, where the quote around one reader isn't the one around the next.
  ["ssh host \"cat 'a\ncat b' .env\"", "Bash"],
  ["ssh host \"echo 'x;cat a'; cat .env\"", "Bash"],
  // Backticks inside backticks, and a backtick that closes what a here-document opened.
  ["echo `echo \\`cat .env\\``", "Bash"],
  ["cat <<EOF\n`cat .env`\nEOF", "Bash"],
  // An empty command substitution inside a name, Windows PowerShell's `e, a braced variable holding a quote, and a
  // backtick before a Windows line break.
  ["cat .e$()nv", "Bash"],
  ["gc .e$()nv", "PowerShell"],
  ['gc ".`env"', "PowerShell"],
  ['gc -Path "x${b"}",.env,\'"\' #\'', "PowerShell"],
  ["gc -Raw `\r\n.env", "PowerShell"],
  // A single quote is a letter to cmd, so in a cmd terminal this reads .env.
  ["type x' .env '", "Cursor"],
];

test("nested or unusual quoting can't hide a reader's files either", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const shell = quotedSeparatorShell(root, "new");
  assertStoppedForEnv(shell, NESTED_QUOTING_BLOCKS);
  // Shells nested deeper than Guard reads stop the command.
  const deep = shell(`${"bash -c ".repeat(8)}"cat 'a|b' .env"`, "Bash");
  assert.equal(deep.action, "block", "shells nested eight deep");
});

function carryOnBlocks() {
  const cases = [
    // Bash ends $'…' at a quote after \c, so the quote doesn't carry the next words with it.
    ["cat $'\\c' .env '\\'", "Bash"],
    ["cp $'\\c' .env /tmp/x '\\'", "Bash"],
    ["cat a $'x\\c' .env 'y\\'", "Bash"],
    ["echo $'\\c' x; \\cat .env; echo '\\'", "Bash"],
    // A PowerShell argument list carries on past a line break after a comma.
    ["gc a,\n.env", "PowerShell"],
    ["Get-Content README.md,\n.env", "PowerShell"],
    ["gc a, \n  .env", "PowerShell"],
    ["gc a,#c\n.env", "PowerShell"],
    ["gc a,\r\n.env", "PowerShell"],
    ["gc a,\n\n.env", "PowerShell"],
    ["type README.md,\n.env", "PowerShell"],
    ["sls x a,\n.env", "PowerShell"],
    ["Select-String -Path README.md,\n.env -Pattern x", "PowerShell"],
    ["copy README.md,\n.env out", "PowerShell"],
    ["gc a,\n'.env'", "PowerShell"],
    ["gc 'a|b',\n.env", "PowerShell"],
    // After --%, PowerShell passes the rest of the line to the program as it is: # and ; are text there.
    ["findstr --% x #y .env", "PowerShell"],
    ["findstr.exe --% /n x #y .env", "PowerShell"],
    ["cat.exe --% x #y .env", "PowerShell"],
    ["findstr --% x ; .env", "PowerShell"],
    ["findstr --% x 'a .env b'", "PowerShell"],
    ['cmd --% /c type "a|b" .env', "PowerShell"],
    ["cmd /c --% type .env", "PowerShell"],
    // A group as an argument, on one line or several.
    ["gc @(\n'.env'\n)", "PowerShell"],
    ["gc (\n'.env')", "PowerShell"],
    ["gc ('.env')", "PowerShell"],
    ["gc @('a','.env')", "PowerShell"],
    // A wrapper word written with quotes or a backslash still only runs the command after it.
    ['"sudo" cat .env', "Bash"],
    ["'time' cat .env", "Bash"],
    ["\\time cat .env", "Bash"],
    ['"env" cat .env', "Bash"],
    ["\\command cat .env", "Bash"],
    ["'sudo' bash -c 'cat .env'", "Bash"],
    ['cat README.md\n"sudo" cat .env', "Bash"],
    // Inside "${…}", a single quote is a letter, so the $(…) after it runs.
    ["echo \"${x:-'$(\\cat .env)'}\"", "Bash"],
    ["echo \"${x:-'$(x=1 cat .env)'}\"", "Bash"],
    ['echo "${x:-\'$("cat" .env)\'}"', "Bash"],
    ["echo \"${x:-'$(/bin/cat .env)'}\"", "Bash"],
    // A redirection before the command's name, and >|.
    ["2>&1 cat .env", "Bash"],
    ["2>/dev/null cat .env", "Bash"],
    ["cat >| out.txt .env", "Bash"],
    ["cat README.md\n2>/dev/null cat .env", "Bash"],
    ["<<< hi cat .env", "Bash"],
    ["<<<hi \\cat .env", "Bash"],
    ["0<&0 cat .env", "Bash"],
    ["{fd}>/dev/null cat .env", "Bash"],
    // \c takes the escape after it whole, and an escaped > before | is a letter, so the | still ends the command.
    ["cat $'\\c\\'' .env '\\'", "Bash"],
    ["cat $'\\c\\\\' .env '\\'", "Bash"],
    ["echo $'\\c\\'' x; \\cat .env; echo '\\'", "Bash"],
    ["echo \\>| \\cat .env", "Bash"],
    ["echo a\\>| /bin/cat .env", "Bash"],
    ['echo \\>| "cat" .env', "Bash"],
    // After #, % or / in "${…}", a single quote is a quote again.
    ["echo \"${x#'}' \"'$(\\cat .env)'\" }\"", "Bash"],
    ["echo \"${x##'}' \"'$(\\cat .env)'\" }\"", "Bash"],
    ["echo \"${x%'}' \"'$(x=1 cat .env)'\" }\"", "Bash"],
    ["echo \"${x/'}' \"'$(/bin/cat .env)'\" }\"", "Bash"],
    ["echo \"${x#'}' \"'$(\\cat .env)'\" }\"", "Cursor"],
    // A group's words where the group stands.
    ["copy ('.env') out", "PowerShell"],
    ["gc (Join-Path . '.env')", "PowerShell"],
  ];
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    // cmd finds /c or /k glued to the text it runs, or to the switches before it.
    cases.push(['cmd /c"type .env"', toolName], ["cmd /ctype .env", toolName]);
  }
  for (const toolName of ["PowerShell", "Cursor"]) {
    cases.push(
      ["cmd /d/c type .env", toolName],
      ['cmd /s/c"type .env"', toolName],
      ["cmd /d /s/c type .env", toolName],
    );
  }
  for (const command of ['"sudo" cat .env', "\\time cat .env", "2>/dev/null cat .env"]) cases.push([command, "Cursor"]);
  return cases;
}

test("a line that carries on, raw arguments, a group or a quoted wrapper word can't hide a reader's files", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  assertStoppedForEnv(quotedSeparatorShell(root, "new"), carryOnBlocks());
  const shell = quotedSeparatorShell(root);
  // Each still reads only what it names.
  fs.writeFileSync(path.join(root, "README.md"), "plain notes\n");
  // Guard's first reading ran a reader's words on over a line break, so these are still stopped, as they were before.
  const lineSpills = [
    ["gc README.md\nWrite-Output .env", "PowerShell"],
    ["gc README.md, notes.md\nWrite-Output .env", "PowerShell"],
    ["gc README.md, # .env\nnotes.md", "PowerShell"],
    ["findstr --% x README.md\necho .env", "PowerShell"],
  ];
  const newReading = quotedSeparatorShell(root, "new");
  for (const [command, toolName] of lineSpills) {
    assert.equal(newReading(command, toolName).action, "allow", `new: ${toolName} ${JSON.stringify(command)}`);
    assert.equal(shell(command, toolName).action, "block", `${toolName} ${JSON.stringify(command)}`);
  }
  for (const [command, toolName] of [
    ["findstr --% x README.md | Write-Output .env", "PowerShell"],
    ["gc (Join-Path src app.js)", "PowerShell"],
    ["gc @('README.md')", "PowerShell"],
    ["echo $'\\c' .env", "Bash"],
    ['"echo" .env', "Bash"],
    ["2>&1 echo .env", "Bash"],
    ['cmd /c"echo .env"', "PowerShell"],
    // A group that's a copy's destination stays its destination, and a filter's words aren't files.
    ["cp .env.example (Join-Path $root '.env')", "PowerShell"],
    ["copy README.md (Join-Path $env:TEMP '.env')", "PowerShell"],
    ["sls TODO -Path (gci -Recurse -File | ? Name -ne '.env').FullName", "PowerShell"],
    ["echo \"${HOME#'/'}\"; echo \"${x:-'it'}\"", "Bash"],
  ]) {
    assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
  }
});

function paramQuoteAndFilterBlocks() {
  const cases = [];
  // Inside "${x:-…}" (and =, + or ?) a single quote pairs with the next one, wherever the `}` falls, so the words after
  // that pair are the reader's.
  for (const toolName of ["Bash", "Cursor"]) {
    cases.push(
      ["cat \"${x:-'}\" '}\" .env ; echo \\'", toolName],
      ["cat \"${x='}\" '}\" .env ; echo \\'", toolName],
      ["cat \"${x+'}\" '}\" .env ; echo \\'", toolName],
      ["cat \"${x:?'}\" '}\" .env ; echo \\'", toolName],
      ["cat \"${arr[0]:-'}\" '}\" .env ; echo \\'", toolName],
      ["echo $(cat \"${x:-'}\" '}\" .env ; echo \\')", toolName],
      // The pair's text is read like double-quoted text: its $(…), backticks and ${…} run.
      ["echo \"${x:-'`\\cat .env`'}\"", toolName],
      ["echo \"${x:-'${y:-$(\\cat .env)}'}\"", toolName],
      ["echo \"${x:-a'$(\\cat .env)'}\"", toolName],
    );
  }
  // A quoted filter word in a group is a value, and a filter's -InputObject, -In or foreach list is what it gives on.
  for (const toolName of ["PowerShell", "Cursor"]) {
    cases.push(
      ["gc ('select', '.env')", toolName],
      ['gc ("%", ".env")', toolName],
      ["gc @('?', '.env')", toolName],
      ["Get-Content -Path ('select', '.env')", toolName],
      ["sls x ('where', '.env')", toolName],
      ["gc ('select',\n'.env')", toolName],
      ["cp ('select', '.env') out.txt", toolName],
      ["gc ((('select', '.env')))", toolName],
      ["gc (Select-Object -InputObject '.env')", toolName],
      ["gc (Select-Object -InputObject:'.env')", toolName],
      ["gc (where -InputObject '.env' {1})", toolName],
      ["gc (where -in '.env')", toolName],
      ["gc $(foreach ($f in '.env') { $f })", toolName],
      // cmd's switches can carry a value, glued to the /c after them.
      ["cmd /v:on/c type .env", toolName],
      ["cmd /e:on/c type .env", toolName],
      ["cmd /d/v:on/c type .env", toolName],
      ["cmd /t:0a/c type .env", toolName],
    );
  }
  return cases;
}

test("a quote inside \"${x:-…}\", a filter word in a group or a cmd switch's value can't hide a reader's files", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  assertStoppedForEnv(quotedSeparatorShell(root, "new"), paramQuoteAndFilterBlocks());
  for (const [command, toolName] of paramQuoteAndFilterBlocks()) {
    assert.equal(
      quotedSeparatorShell(root)(command, toolName).action,
      "block",
      `${toolName} ${JSON.stringify(command)}`,
    );
  }
});

test("every command is also read as Guard first read it, so none it stopped goes through", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "README.md"), "plain notes\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
  const both = quotedSeparatorShell(root);
  const first = quotedSeparatorShell(root, "first");
  const cases = [
    ...quotedSeparatorBlocks(),
    ...NESTED_QUOTING_BLOCKS,
    ...carryOnBlocks(),
    ...paramQuoteAndFilterBlocks(),
    // Ones Guard first stopped. The sudo line reads .env, and the shell's own reading now stops it too, past sudo's
    // options. The rest don't read it, and are stopped as they were before: the reader's words ran over a line break,
    // into a comment, or past a quoted `|`.
    ["gc README.md\nWrite-Output .env", "PowerShell"],
    ["gc README.md # mentions .env", "PowerShell"],
    ["cat README.md\nsudo -u root cat .env", "Bash"],
    ["grep -rn 'a|b' src", "Bash"],
  ];
  let firstStops = 0;
  for (const [command, toolName] of cases) {
    const label = `${toolName} ${JSON.stringify(command)}`;
    assert.equal(both(command, toolName).action, "block", label);
    if (first(command, toolName).action === "block") firstStops += 1;
  }
  // The first reading stops some of these on its own, not all, and the two together stop every one.
  assert.ok(
    firstStops > 0 && firstStops < cases.length,
    `the first reading alone stops ${firstStops} of ${cases.length}`,
  );
  for (const [command, toolName] of [
    ["gc README.md\nWrite-Output .env", "PowerShell"],
    ["gc README.md # mentions .env", "PowerShell"],
  ]) {
    assert.equal(first(command, toolName).action, "block", `first: ${toolName} ${JSON.stringify(command)}`);
    assert.equal(
      quotedSeparatorShell(root, "new")(command, toolName).action,
      "allow",
      `new: ${JSON.stringify(command)}`,
    );
  }
  const sudo = "cat README.md\nsudo -u root cat .env";
  assert.equal(first(sudo, "Bash").action, "block", "first: sudo -u");
  assert.equal(quotedSeparatorShell(root, "new")(sudo, "Bash").action, "block", "new: sudo -u");
});

test("the first reading has its own walk budget and doesn't join a glob a Windows program expands itself", (t) => {
  // The shell's own reading can spend its walk on text the first reading never reads, `{ grep -r x pad; }`; the
  // first reading runs first, so it still walks `config` as it did before.
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "pad"));
  for (let k = 0; k < 120; k += 1) fs.writeFileSync(path.join(root, "pad", `f${k}.txt`), "x\n");
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", ".env"), "SAMPLE=placeholder\n");
  const small = (command, toolName) => {
    const options = { cwd: root, searchWalkMaxEntries: 100 };
    return toolName === "Cursor"
      ? guard.inspectShell("cursor", { command, cwd: root }, options)
      : guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, options);
  };
  for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
    for (const command of [
      "grep -r SAMPLE config",
      "{ grep -rq x pad; }; grep -r SAMPLE config",
      "if grep -rq x pad; then :; fi; grep -r SAMPLE config",
    ]) {
      assert.equal(small(command, toolName).action, "block", `${toolName} ${JSON.stringify(command)}`);
    }
  }

  // findstr, a Windows program, matches a glob Bash left alone against short names too, so `"e"*` can read .env
  // (ENV~1): its `*` stays a glob of its own.
  const dot = tempDir(t);
  fs.writeFileSync(path.join(dot, ".env"), "SAMPLE=placeholder\n");
  const shell = quotedSeparatorShell(dot);
  for (const command of ['findstr -s KEY "e"*', 'findstr /si KEY "E"*', 'findstr /s KEY "en"*']) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }
});

test("a quoted name glued to a glob is read as the first check read it when its folder can't be listed", (t) => {
  // `"x"*` is joined into `x*` only when Guard lists the folder it matches in, in the command's first call. After a
  // `cd` it isn't that call, and in a folder too big to list the joined glob could only be judged by name, which lets
  // `x.pem` through; the first check's bare `*` stopped it there, so it still does.
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", "x.pem"), "placeholder\n");
  fs.mkdirSync(path.join(root, "notes", "dev-kit", "keys"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "dev-kit", "keys", "server.key"), "placeholder\n");
  const shell = quotedSeparatorShell(root);
  for (const command of [
    'cd config && cat "x"*',
    'cd config && head -n 5 "x"*',
    'cd config && sed -n 1p "x"*',
    'cd config && grep KEY "x"*',
    'cd config && sudo cat "x"*',
    'cd config; source "x"*',
    'pushd config; cat "x"*',
    'cd notes && grep -r SAMPLE "dev"*',
    'cd notes && cp -r "dev"* /tmp/x',
    'cd notes && diff -r "dev"* /tmp',
  ]) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }

  const big = tempDir(t);
  for (let k = 0; k < 2100; k += 1) fs.writeFileSync(path.join(big, `f${k}.txt`), "x\n");
  fs.writeFileSync(path.join(big, "x.pem"), "placeholder\n");
  assert.equal(quotedSeparatorShell(big)('cat "x"*', "Bash").action, "block", "a folder too big to list");

  // `"x"*` is x.txt alone, but once a later path spends the walk, the first check's bare `*`, which matched id_rsa,
  // is back.
  const spent = tempDir(t);
  fs.mkdirSync(path.join(spent, "pad"));
  for (let k = 0; k < 120; k += 1) fs.writeFileSync(path.join(spent, "pad", `f${k}.txt`), "x\n");
  fs.writeFileSync(path.join(spent, "x.txt"), "x\n");
  fs.writeFileSync(path.join(spent, "id_rsa"), "placeholder\n");
  const command = 'cat "x"* pad/*';
  const walked = (searchWalkMaxEntries) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: spent } },
      { cwd: spent, searchWalkMaxEntries },
    ).action;
  assert.equal(walked(undefined), "allow", "with the walk to spare");
  assert.equal(walked(100), "block", "once the walk is spent");

  // cp's last glob, walked as files it copies, doesn't spend the walk that the first check's reading of a later
  // search needs.
  const copied = tempDir(t);
  for (const name of ["src/a.js", "cfg/.env"]) {
    fs.mkdirSync(path.dirname(path.join(copied, name)), { recursive: true });
    fs.writeFileSync(path.join(copied, name), "SAMPLE=placeholder\n");
  }
  fs.mkdirSync(path.join(copied, "data", "xbig"), { recursive: true });
  for (let k = 0; k < 150; k += 1) fs.writeFileSync(path.join(copied, "data", "xbig", `f${k}.txt`), "x\n");
  for (const [copy, toolName] of [
    ["cp -r src data/x*; grep -r KEY cfg", "Bash"],
    ["cp -r src data/x* && cp -r cfg out", "Bash"],
    ["cp -r src data/x*; grep -r KEY cfg", "PowerShell"],
  ]) {
    const result = guard.inspectShell(
      "claude",
      { tool_name: toolName, tool_input: { command: copy, cwd: copied } },
      { cwd: copied, searchWalkMaxEntries: 100 },
    );
    assert.equal(result.action, "block", copy);
  }

  // Where the folder is listed, the joined glob is what's read.
  const listed = tempDir(t);
  fs.writeFileSync(path.join(listed, "id_rsa"), "placeholder\n");
  fs.writeFileSync(path.join(listed, "x.txt"), "x\n");
  assert.equal(quotedSeparatorShell(listed)('cat "x"*', "Bash").action, "allow");
});

test("a quoted name glued to a glob is read as the paths Bash hands the command", (t) => {
  // Bash expands `"qqdata/"*` before cp sees it, so `cp -r src "qqdata/"*` copies qqdata/a into qqdata/b, and
  // `grep -r "x"* src` searches xb with xa.txt as its pattern. The joined glob is neither a copy's destination nor a
  // search's pattern. Unquoted, a copy's last glob is read as the sources it can expand to as well.
  const root = tempDir(t);
  for (const [name, text] of [
    ["qqdata/a/.env", "SAMPLE=placeholder\n"],
    ["qqdata/b/keep.txt", "x\n"],
    ["xa.txt", "x\n"],
    ["xb/.env", "SAMPLE=placeholder\n"],
    ["src/app.js", "x\n"],
    ["README.md", "x\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  const shell = quotedSeparatorShell(root);
  for (const command of [
    'cp -r src "qqdata/"*',
    'cp -r README.md "qqdata/"*',
    'cp -R src "qqdata/"?',
    "cp -r src qqdata/*",
    "cp -r src qqdata/?",
    'grep -r "x"* src',
    'grep -rn "x"* src',
    'grep -r "x"* README.md',
  ]) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }
  for (const command of ['cp -r "src"* /tmp/x', "cp -r README.md src/*", 'cat "READ"*', 'cat "x"* src/app.js']) {
    assert.equal(shell(command, "Bash").action, "allow", command);
  }

  // On Linux, `"/proc/self/environ"*` reads the environment. It's stopped by how it's written, before any listing of
  // /proc, which Windows hasn't got.
  for (const command of ['cat "/proc/self/environ"*', 'cat "/proc/1/environ"*', "cat /proc/self/env*"]) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }

  // A walk under the joined glob's paths that a folder it can't open cuts short judges them by name, where the first
  // check's bare `*` stopped the command.
  const walked = tempDir(t);
  fs.mkdirSync(path.join(walked, "qqdata", "a"), { recursive: true });
  fs.mkdirSync(path.join(walked, "qqdata", "z"));
  fs.writeFileSync(path.join(walked, "qqdata", "a", ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(walked, "README.md"), "x\n");
  const opendirSync = fs.opendirSync;
  t.mock.method(fs, "opendirSync", function (folder, ...rest) {
    if (/[\\/]qqdata[\\/]z$/.test(String(folder))) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return opendirSync.call(this, folder, ...rest);
  });
  for (const command of [
    'grep -r SAMPLE "qq"*',
    'grep -rn SAMPLE "qqdata"*',
    'cp -r "qq"* /tmp/x',
    'diff -r "qq"* src',
  ]) {
    assert.equal(quotedSeparatorShell(walked)(command, "Bash").action, "block", command);
  }
});

test("a joined glob stands in for its paths only where Bash's order, bytes and folder can't move them", (t) => {
  const make = (files) => {
    const root = tempDir(t);
    for (const name of files) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), name.endsWith(".env") ? "SAMPLE=placeholder\n" : "x\n");
    }
    return quotedSeparatorShell(root);
  };
  // Bash sorts matches its own way (`qq_b qqa` in Git Bash), so which one is a search's pattern or a copy's target
  // isn't Guard's to say when there are two.
  const order = make(["qqa/.env", "qq_b/x.txt", "src/a.js", "README.md"]);
  for (const command of [
    'grep -rv "qq"* src',
    'grep -r "qq"* src',
    'grep -rv "qq"* README.md',
    'grep -r -e "qq"* src',
    'cp -r -t "qq"* src',
    'cp -r --target-directory "qq"* src',
  ]) {
    assert.equal(order(command, "Bash").action, "block", command);
  }
  // In the C locale Bash's `?` is one byte, so `"q"??` can match `qé`.
  const bytes = make(["qé/.env", "src/a.js"]);
  for (const command of ['grep -r K "q"??', 'cp -r "q"?? /tmp/o', 'diff -r "q"?? src']) {
    assert.equal(bytes(command, "Bash").action, "block", command);
  }
  // A folder change Guard's own check doesn't see as one still keeps the words split.
  const moved = make(["qq1/x.txt", "sub/qq1/.env", "config/.env"]);
  for (const command of [
    '"cd" sub; grep -r K "qq"*',
    '\\cd sub; grep -r K "qq"*',
    "c'd' sub; grep -r K \"qq\"*",
    'eval "cd sub"; grep -r K "qq"*',
    'source ./go.sh; grep -r K "qq"*',
    'shopt -s nocaseglob; grep -r K "QQ"*',
  ]) {
    assert.equal(moved(command, "Bash").action, "block", command);
  }
  // A function defined anywhere a command can start has a body of its own.
  const env = make([".env", "README.md"]);
  for (const command of [
    "{ f() { cat .env; }; f; }",
    "if true; then f() { cat .env; }; f; fi",
    "while :; do f() { cat .env; }; f; break; done",
    "until false; do h() { head .env; }; h; break; done",
    "if false; then :; else f() { cat .env; }; f; fi",
    "true && { f() { cat .env; }; f; }",
    "! f() { cat .env; }; f",
    "{ f () { cat .env; }; f; }",
    "{ function f() { cat .env; }; f; }",
    "f@() { cat .env; }; f@",
    "cmd ///ctype .env",
  ]) {
    assert.equal(env(command, "Bash").action, "block", command);
  }
  // A process's environment under /proc, however the path to it is written.
  for (const command of [
    "cat /proc/*/environ",
    "cat /proc/sel?/environ",
    "cat /proc/1/task/1/environ",
    "cat /proc//self/environ",
    "cat /proc/./self/environ",
    "cat /proc/self/../self/environ",
    "cat /proc/$$/environ",
    "cat /proc/self/env*",
    // Git Bash's /proc, reached from a drive's folder.
    "cat /c/../proc/self/environ",
    // Or climbed to from the working folder: Bash stays at the root past it.
    `cat ${"../".repeat(40)}proc/1/environ`,
    "cat /pro$X/self/environ",
    "cat /proc/self/env$X",
  ]) {
    assert.equal(env(command, "Bash").action, "block", command);
  }
  for (const command of ['cat "$dir/$file"', "cat /proc/self/status", "cut -d, -f1 README.md"]) {
    assert.equal(env(command, "Bash").action, "allow", command);
  }
  // cp's last glob is read as sources only where it can expand to more than one path and isn't quoted.
  const many = make(["config/.env", "conf2/x.txt", "src/a.js"]);
  assert.equal(many("cp -r src conf*", "Bash").action, "block");
  // The first check's reading of it, read again after the others with the last glob as sources, stops it too.
  const manyRoot = tempDir(t);
  for (const name of ["config/.env", "conf2/x.txt", "src/a.js"]) {
    fs.mkdirSync(path.dirname(path.join(manyRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(manyRoot, name), "SAMPLE=placeholder\n");
  }
  assert.equal(quotedSeparatorShell(manyRoot, "first")("cp -r src conf*", "Bash").action, "block", "first reading");
  const copy = make(["config/.env", "src/a.js", "README.md"]);
  for (const command of [
    "cp README.md 'id*'",
    'cp README.md "cred*"',
    "cp -r src config*",
    "cp -r src 'secrets*'",
    'cp -r src "conf"*',
  ]) {
    assert.equal(copy(command, "Bash").action, "allow", command);
  }
  // Joined, `"READ"*` is README.md alone, where the first check's bare `*` was every file, id_rsa too.
  assert.equal(make(["id_rsa", "README.md", "src/a.js"])('cat "READ"*', "Bash").action, "allow");
});

test("a joined glob stands in for its path only in a command that is that one reader call", (t) => {
  const make = (files) => {
    const root = tempDir(t);
    for (const name of files) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), name.endsWith(".env") ? "SAMPLE=placeholder\n" : "x\n");
    }
    fs.writeFileSync(path.join(root, "go.sh"), "cd sub\n");
    return quotedSeparatorShell(root);
  };
  // An earlier command can add a match, change folder where Guard can't see it, or start a shell with other options:
  // Guard lists the folder before any of it runs.
  const state = make(["qqa/.env", "src/a.js", "sub/qqb/.env", "config/.env"]);
  for (const command of [
    'mkdir qq0; grep -rv "qq"* src',
    'mkdir qq0 && grep -rv "qq"* src',
    "mkdir qqz; cp -r src qq*",
    'c\\\nd sub; grep -rv "qq"* src',
    'pu\\\nshd sub; grep -rv "qq"* src',
    "bash -O nullglob <<'X'\ngrep -rv \"zz\"* KEY\nX",
    "BASH_ENV=go.sh bash <<'X'\ngrep -rv \"qq\"* src\nX",
  ]) {
    assert.equal(state(command, "Bash").action, "block", command);
  }
  // Guard reads a leading `!` in a glob as a negation Bash doesn't know, and Git Bash shows a name Windows can't hold,
  // `q:a`, as a private-use letter.
  for (const [files, command] of [
    [["!qq0/x.txt", "!qqa/.env", "src/a.js"], 'grep -rv "!qq"* src'],
    [["!qa/.env", "qq0/x.txt"], 'grep -r K "!q"*'],
    [["q0/x.txt", "qa/.env", "src/a.js"], 'grep -rv "q:"* src'],
    // cp's last glob: `?` is a byte in the C locale, and a leading `!` is Bash's own.
    [["config/.env", "cénfi/x.txt", "src/a.js"], "cp -r src c?????"],
    [["config/.env", "cénfi/x.txt", "src/a.js"], "LC_ALL=C; cp -r src c?????"],
    [["!qa/.env", "!qb/x.txt", "src/a.js"], "cp -r src !q*"],
  ]) {
    assert.equal(make(files)(command, "Bash").action, "block", command);
  }
  // A glob starting with `!` still stands for the names earlier versions read it as, as well as the shell's: cmd with
  // delayed expansion drops the `!`.
  const bang = make(["id_rsa", "notes.txt", "sub/id_rsa"]);
  for (const [command, tool] of [
    ["cat !*", "Bash"],
    ["cat !id*", "Bash"],
    ["grep -r x !s*", "Bash"],
    ["Get-Content !*", "PowerShell"],
    ["type !*", "Cursor"],
  ]) {
    assert.equal(bang(command, tool).action, "block", command);
  }
  // A joined glob's quoted name is still judged by its own name, as earlier versions judged it: a key's backup is read.
  const backup = make(["server.key.bak", "cert.p12.bak", "README.md"]);
  for (const command of [
    'cat "server.key"*',
    'head -n 5 "server.key"*; echo hi',
    'base64 "cert.p12"*',
    'cp -r "server.key"* out',
  ]) {
    assert.equal(backup(command, "Bash").action, "block", command);
  }
  // A function defined after `time` is one too, and /dev/fd and /dev/stdin lead back into /proc.
  const env = make([".env", "README.md", "READ ME.txt", "id_rsa"]);
  for (const command of [
    "time f() { cat .env; }; f",
    "time -p f() { cat .env; }; f",
    "cat /dev/fd/../environ",
    "cat /dev/stdin/../../environ",
  ]) {
    assert.equal(env(command, "Bash").action, "block", command);
  }
  // A lone reader call joins whatever its switches, and a folder held in a variable is no /proc.
  for (const command of ['head -c 50 "READ ME"*', 'tail -n 5 "READ ME"*', 'cat "$d"/e*', "cat $d/env*", "cat */e*"]) {
    assert.equal(env(command, "Bash").action, "allow", command);
  }
  // grep can be handed a file to read by a switch, so its words stay split and the bare `*` still counts, as it did.
  assert.equal(env('grep -c x "READ ME"*', "Bash").action, "block");
});

test("a joined glob or cp's last glob written from the root isn't listed as Guard finds it", (t) => {
  // Git Bash's `/` is Git's own folder, and /tmp its temp folder: the same path from Node is another folder on the
  // drive. So a path from the root is never listed to join or to settle where cp copies to.
  const root = tempDir(t);
  for (const name of ["READ ME.txt", "id_rsa", "config/.env", "src/a.js"]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), name.endsWith(".env") ? "SAMPLE=placeholder\n" : "x\n");
  }
  const fromRoot = root.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  const shell = quotedSeparatorShell(root);
  for (const command of [`cat "${fromRoot}/READ ME"*`, `cp -r src ${fromRoot}/conf*`]) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }
  // The same paths written from the working folder are listed.
  for (const command of ['cat "READ ME"*', "cp -r src conf*"]) {
    assert.equal(shell(command, "Bash").action, "allow", command);
  }
});

test("a joined glob stays in the first call's own words and never climbs out of a link", (t) => {
  // Bash opens `link/..` through the link, into the folder holding the link's target; Node folds it away by its text.
  const root = tempDir(t);
  const work = path.join(root, "work");
  const files = ["work/id_e_notes.txt", "work/credentials.json", "work/fo.lnk", "other/id_ed25519"];
  for (const name of [...files, "other/inner/x.txt"]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), "SAMPLE=placeholder\n");
  }
  fs.symlinkSync(
    path.join(root, "other", "inner"),
    path.join(work, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  // A link Git Bash made as a system file, which Node sees as a plain one, a hard link, and a name with a blank space
  // that isn't Bash's.
  const marker = Buffer.from("!<symlink>\xff\xfe", "latin1");
  fs.writeFileSync(path.join(work, "notes"), Buffer.concat([marker, Buffer.from("credentials.json\0", "utf16le")]));
  fs.linkSync(path.join(work, "credentials.json"), path.join(work, "hardnote"));
  fs.writeFileSync(path.join(work, "READ ME.txt"), "x\n");
  fs.writeFileSync(path.join(work, "x\u00a0READ ME.pem"), "SAMPLE=placeholder\n");
  const shell = quotedSeparatorShell(work);
  for (const command of [
    // A later line's words are expanded after the lines before it have run.
    'cat id_e_notes.txt\n"cd" other\ncat "id_e"*',
    'cat id_e_notes.txt\nc\\d ../other\ncat "id_e"*',
    'cat "link/../id_e"*',
    // Git Bash shows a link it made as a .lnk file by its name without .lnk, and opens what it leads to.
    'cat "f"*',
    'cat "no"*',
    'grep -h . "no"*',
    'cat "ha"*',
    'cat x\u00a0"READ ME"*',
    'cat x\u000b"READ ME"*',
    // A reader whose switches or script name a file it reads: base's bare `*` was all that stopped these.
    'diff --from-file=credentials.json "READ ME"*',
    "sed 'r credentials.json' \"READ ME\"*",
    'sed 1rcredentials.json "READ ME"*',
    'awk -fcredentials.json "READ ME"*',
    'grep --file=credentials.json "READ ME"*',
    'grep -fcredentials.json "READ ME"*',
  ]) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }
  // `id_e*` could match a secret key's name, but it's looked up in its folder: here it matches only the notes, and in
  // `other` it matches the key.
  assert.equal(shell('cat "id_e"* ; echo done', "Bash").action, "allow");
  assert.equal(quotedSeparatorShell(path.join(root, "other"))('cat "id_e"* ; echo done', "Bash").action, "block");
  assert.equal(shell('cat "READ"* ; echo done', "Bash").action, "allow");
  // A file bigger than any link file can be isn't opened to look, since that downloads a file kept only in the cloud.
  fs.writeFileSync(path.join(work, "zbig.bin"), Buffer.concat([marker, Buffer.alloc(80000, 0x41)]));
  assert.equal(shell('cat "zbig"*', "Bash").action, "allow");
  // Joins in a big folder list it once between them, so they don't spend the walk that later paths need.
  const big = path.join(root, "big");
  fs.mkdirSync(big);
  for (let i = 0; i < 1100; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), "x\n");
  fs.writeFileSync(path.join(big, "READ ME.txt"), "x\n");
  const bigShell = quotedSeparatorShell(big);
  for (const command of [`cat ${'"READ ME"* '.repeat(9)}`, `cat ${'"nomatch"* '.repeat(9)}`]) {
    assert.equal(bigShell(command, "Bash").action, "allow", command);
  }
});

test("a process's environment is found from the root, not in a project's own dev or proc folder", (t) => {
  const root = path.join(tempDir(t), "proj");
  for (const name of [
    "../dev/a.txt",
    "../proc/a.md",
    "k8s/overlays/dev/a.yaml",
    "dev/a.txt",
    "scripts/dev/a.txt",
    "docs/proc/a.md",
    "config/dev/env.sample.txt",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), "x\n");
  }
  const shell = quotedSeparatorShell(root);
  // Globs in both the proc part and the environ part, or a glob for every part.
  for (const command of [
    "cat /p*/self/env*",
    "cat /[p]roc/self/[e]nviron",
    "cat /*/self/e*",
    "cat /*/*/*",
    'cat "/proc/self/environ"',
    // POSIX classes and, with extglob on, a pattern list.
    "cat /proc/self/env[[:alpha:]]ron",
    "wc -c < /proc/self/env[[=i=]]ron",
    "cp /proc/self/env[[.i.]]ron out.txt",
    "cat /[[:alpha:]]roc/self/environ",
    "cat /proc/self/env[![:space:]]ron",
    "shopt -s extglob\ncat /proc/self/@(environ)",
    "shopt -s extglob\ncat /proc/self/+([a-z])",
    "shopt -s extglob\ncat /proc/self/!(x)",
  ]) {
    assert.equal(shell(command, "Bash").action, "block", command);
  }
  // Climbed to from the working folder, which Git Bash starts in its /tmp when it's in the temp folder.
  const depth =
    process.platform === "win32"
      ? path.relative(os.tmpdir(), root).split(path.sep).length + 1
      : root.split("/").filter(Boolean).length;
  const climb = `cat ${"../".repeat(depth)}proc/self/environ`;
  assert.equal(shell(climb, "Bash").action, "block", climb);
  for (const [command, toolName] of [
    ["cat k8s/overlays/dev/*", "Bash"],
    ["head -n 20 dev/*", "Bash"],
    ["grep -rn x dev/*", "Bash"],
    ["cp -r k8s/overlays/dev/* /tmp/out/", "Bash"],
    ["cat config/dev/env*", "Bash"],
    ["diff dev/* scripts/dev/*", "Bash"],
    ["cat docs/proc/*", "Bash"],
    // A folder beside the working one.
    ["cp ../dev/* .", "Bash"],
    ["cat ../dev/*", "Bash"],
    ["grep -n TODO ../dev/*", "Bash"],
    ["head -n 3 ../proc/*", "Bash"],
    ["Get-Content config/dev/*", "PowerShell"],
    ["type config\\dev\\*", "Cursor"],
  ]) {
    assert.equal(shell(command, toolName).action, "allow", command);
  }
});

test("glued cmd switches with a quoted separator, Git Bash's //c and a function's body are read", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  const shell = quotedSeparatorShell(root);
  for (const [command, toolName] of [
    ['cmd /d/c type "a&b" .env', "Cursor"],
    ['cmd /v:on/c type "a&b" .env', "Cursor"],
    ['cmd /ctype "a&b" .env', "Cursor"],
    ["cmd //c type .env", "Bash"],
    ["cmd.exe //c type .env", "Bash"],
    ["cmd //c type .env", "Cursor"],
    ["f() { cat .env; }; f", "Bash"],
    ["f () { cat .env; }; f", "Bash"],
    ["function f { cat .env; }; f", "Bash"],
    ["function f() { cat .env; }; f", "Bash"],
    ["f(){ cat .env;}; f", "Bash"],
    ["cmd //ctype .env", "Bash"],
    ["cmd //Ctype .env", "Bash"],
    ['cmd //c"type .env"', "Bash"],
    ["cmd //d //ctype .env", "Bash"],
    // An empty process substitution or extglob pattern is part of a word, not a function's name.
    ["cat <() .env", "Bash"],
    ["cat >() .env", "Bash"],
    ["cat <(  ) .env", "Bash"],
    ["grep -h SAMPLE <( ) .env", "Bash"],
    ["diff <() .env", "Bash"],
    ["shopt -s extglob\ncat @() .env", "Bash"],
    ["shopt -s extglob; cat x@() .env", "Bash"],
    ["cat ?( ) .env", "Bash"],
    ["cat *() .env", "Bash"],
    ["cat +() .env", "Bash"],
    ["cat !() .env", "Bash"],
  ]) {
    assert.equal(shell(command, toolName).action, "block", `${toolName} ${JSON.stringify(command)}`);
  }
  for (const [command, toolName] of [
    ["cmd //c dir", "Bash"],
    ['cmd /d/c type "a&b" README.md', "Cursor"],
    ["f() { cat README.md; }; f", "Bash"],
    ["arr=(); echo ok", "Bash"],
  ]) {
    assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
  }
});

test("common commands with a separator inside quotes go through when they read no secret file", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
  const shell = quotedSeparatorShell(root);
  for (const [command, toolName] of [
    ['git commit -m "fix: a|b; c&d"', "Bash"],
    ['grep "a|b" src', "Bash"],
    ['echo "x;y"', "Bash"],
    ["rg 'foo|bar'", "Bash"],
    ["sed -n '1,5p;/x/q' src/app.js", "Bash"],
    ["awk -F'|' '{ print $1; }' src/app.js", "Bash"],
    ['Write-Output "a;b"', "PowerShell"],
    ['git commit -m "fix: a|b; c&d"', "PowerShell"],
    ["Select-String -Pattern 'a|b' -Path src\\app.js", "PowerShell"],
    ['git commit -m "fix: a|b; c&d"', "Cursor"],
    ["rg 'foo|bar'", "Cursor"],
    // A `^` in a quoted pattern is a regex anchor, not cmd's escape, so cmd's rules don't split the pattern.
    ["grep -rn '^import .*' src", "Cursor"],
    ["grep -n '^const .* = require' src/app.js", "Cursor"],
    ["rg '^import .* from' src", "Cursor"],
    ['findstr /r "^import .*" src\\app.js', "Cursor"],
    ["git commit -m 'it'\\''s done' && grep -rn 'x .* y' src", "Cursor"],
    // A quote in the middle of a switch is the switch's value.
    ["grep -rn --include='*.js' '^import .*' src", "Cursor"],
    ["rg -g'*.ts' '^export .*' src", "Cursor"],
    ["grep --exclude-dir='node_modules' -rn '^x .*' src", "Cursor"],
    ["git log --pretty=format:'%h %s' | grep '^abc .*'", "Cursor"],
  ]) {
    assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
  }
  // A reader in a PowerShell message's Markdown code span reads up to the span's closing backtick, in a single or a
  // double quote or a here-string, as Guard's first reading does: not the backtick as a letter of its name, and not
  // the words of the message past it.
  for (const command of [
    "git commit -m 'docs: see `cat .env.example`'",
    "git commit -m @'\ndocs: run `cat .env.example` to see the keys\n'@",
    "Write-Host 'Tip: `type .env.sample`'",
    'git commit -m "docs: use `cat .env.example` as a template and save it as `.env`"',
    'git commit -m "Use `grep -r x src`, not `.env`"',
    'Write-Host "Run `cat src\\app.js`; ignore `.env`"',
    'git commit -m @"\ndocs: use `cat .env.example` as a template and save it as `.env`\n"@',
  ]) {
    for (const toolName of ["PowerShell", "Cursor"]) {
      assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
    }
  }
  // A reader named in a message's words reads up to a `)` or `|` after it, as Guard's first reading does: an
  // apostrophe between letters doesn't pair with a later one to hide it. A PowerShell `{ ... }` read as Bash ends at its
  // last `}`, so a copy's destination there isn't taken for a source.
  for (const command of [
    "git commit -m \"Fix README (cat doesn't exist on Windows) so it's clear that .env is ignored\"",
    "git commit -m \"$(cat <<'EOF'\nDocs: setup on Windows (cat isn't there) - it's why .env setup failed\nEOF\n)\"",
    'gh pr create --title "Docs" --body "Windows (type, cat aren\'t the same) - we\'ll stop reading .env files"',
    "git commit -m @'\nFix (cat won't | it's .env)\n'@",
    "git commit -F - <<'EOF'\nFix docs (cat won't work | it's .env now)\nEOF",
    "git commit -m 'Fix docs (cat won’t work | it’s .env now)'",
    "if (!(Test-Path .env)) { cp .env.example .env }",
    "if (Test-Path .env.example) { copy .env.example .env }",
    "& { cp .env.example .env }",
    // A `}` that closes a block before an `else`; and PowerShell's own copy switches, which Bash's cp refuses.
    'if (!(Test-Path .env)) { cp .env.example .env } else { Write-Host ".env exists" }',
    "if (-not (Test-Path .env)) { cp .env.example .env -ErrorAction SilentlyContinue }",
    "if (-not (Test-Path .env)) { cp .env.example .env -WhatIf }",
    "if (-not (Test-Path .env)) { cp -LiteralPath .env.example -Destination .env }",
    "if (-not (Test-Path .env)) { cp -Path .env.example .env -Force }",
  ]) {
    for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
      assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
    }
  }
  // PowerShell runs nothing of a command it can't parse, so a Bash search's `{` there doesn't open a block.
  for (const command of ["grep -rn {{ src", "grep -rn 'x' src \\}"]) {
    assert.equal(shell(command, "Cursor").action, "allow", `Cursor ${JSON.stringify(command)}`);
  }
  // Copy-Item still reads what it copies, and Bash's cp what it copies with options it knows.
  for (const command of [
    "{ cp .env backup.txt -Force }",
    "{ cp -LiteralPath .env -Destination backup.txt }",
    "{ cp -Path .env backup.txt }",
  ]) {
    assert.equal(shell(command, "PowerShell").action, "block", `PowerShell ${JSON.stringify(command)}`);
  }
  assert.equal(shell("{ cp -pv .env backup.txt }", "Bash").action, "block", "Bash cp -pv");
  for (const command of ["{ cp .env backup.txt }", "{ cat 'a|b' .env }"]) {
    assert.equal(shell(command, "Bash").action, "block", `Bash ${JSON.stringify(command)}`);
  }
  // A Bash cp's short options, read as PowerShell's in Cursor's terminal, aren't Copy-Item's -PipelineVariable or
  // -InformationVariable, whose value would be the template.
  for (const command of ["cp -iv .env.example .env", "cp -pv .env.example .env", "cp -T .env.example .env"]) {
    for (const toolName of ["Bash", "PowerShell", "Cursor"]) {
      assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
    }
  }
  // Copy-Item copies every file in a list after -Path. PowerShell starts a comment at a `#` that ends a group or an
  // expression's value, and keeps a backtick that ends the text, or one in `--%`, as a letter: none of these keeps it
  // from parsing the text.
  for (const command of [
    'cp -Path "a;b", .env out',
    'cp -Force -LiteralPath "a;b", .env out',
    'gc "a;b", .env; $x=1#)',
    'if ($LASTEXITCODE) { exit 1 }# fail (non-zero\ngc "a;b", .env',
    'gc "a;b", .env; dir | % { $_.Name }#)',
    'gc "a;b", .env; echo done`',
    'echo `--% )\ngc "a;b", .env',
    // Past a command's name, a `#` glued to a value is a letter; a group in a list is one of its items.
    '$x = gc "a;b", $y#, .env',
    'cp -Path ("a;b"), .env out',
  ]) {
    for (const toolName of ["PowerShell", "Cursor"]) {
      assert.equal(shell(command, toolName).action, "block", `${toolName} ${JSON.stringify(command)}`);
    }
  }
  // cp options uutils' cp knows (`-g`), and a long option's value given as the next word, aren't options cp refuses.
  for (const command of ['cp -g "a|b" .env out', 'cp --suffix -old -b "a|b" .env out']) {
    for (const toolName of ["Bash", "Cursor"]) {
      assert.equal(shell(command, toolName).action, "block", `${toolName} ${JSON.stringify(command)}`);
    }
  }
  // Guard's first reading cut a search's words at the quoted `|` and took it to search the whole folder, .env with it.
  // That reading still runs, so these are still stopped, though the shell's own reading lets them through.
  const quotedPipeSearches = [
    ["grep -rn 'a|b' src", "Bash"],
    ["grep -rnE '^(foo|bar)' src", "Cursor"],
  ];
  for (const [command, toolName] of quotedPipeSearches) {
    assert.equal(quotedSeparatorShell(root, "new")(command, toolName).action, "allow", `new: ${command}`);
    assert.equal(shell(command, toolName).action, "block", `${toolName} ${JSON.stringify(command)}`);
  }

  // A glob's `*` right after a quote was once read as a glob of its own, which found the secret file beside it. Bash
  // reads it as part of the quoted word, and so does Guard's first reading, for Bash, now.
  const project = tempDir(t);
  fs.writeFileSync(path.join(project, ["credentials", "json"].join(".")), "{}\n");
  fs.writeFileSync(path.join(project, ".npmrc"), "registry=https://registry.example/\n");
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "app.js"), "const SAMPLE = 1;\n");
  const kit = path.join(project, "notes", "dev-kit");
  fs.mkdirSync(kit, { recursive: true });
  for (const name of ["READ ME FIRST.txt", "checklist.md", "launch-post.md"]) {
    fs.writeFileSync(path.join(kit, name), "plain notes\n");
  }
  fs.writeFileSync(path.join(project, "launch-post.md"), "plain notes\n");
  const inProject = quotedSeparatorShell(project);
  for (const command of [
    'cat "notes/dev-kit/READ ME"*',
    // The command that was stopped on 3 Nov.
    "cat \"notes/dev-kit/READ ME\"* ; head launch-post.md ; grep -E '0\\.1\\.1|1\\.5\\.0|1\\.100|not live|masked|@[a-z]+\\.(com|dev|io)|is_secret_file|hash' notes/dev-kit/*.md",
  ]) {
    assert.equal(inProject(command, "Bash").action, "allow", command);
    assert.equal(quotedSeparatorShell(project, "first")(command, "Bash").action, "allow", `first: ${command}`);
  }
  // A quoted part that may not be the word's whole start, or that reads differently unquoted, keeps the `*` apart, as
  // before; so does a shell other than Bash.
  for (const command of [
    'cat "notes/dev-kit/READ*"*',
    'cat "$HOME"*',
    'cat "`pwd`"*',
    'cat "a""b"*',
    'cat \\ "a"*',
    'cat "-n"*',
    'cat "~"*',
    'cat "{a,b}"*',
    'cat"a"*',
  ]) {
    assert.equal(inProject(command, "Bash").action, "block", command);
  }
  assert.equal(inProject('cat "notes/dev-kit/READ ME"*', "Cursor").action, "block", "Cursor");
  assert.equal(inProject('cat "notes/dev-kit/READ ME"*', "PowerShell").action, "block", "PowerShell");
  // The quoted-`|` searches above, here too.
  for (const command of ["rg 'foo|bar' src", "grep -rn 'a|b' src"]) {
    assert.equal(quotedSeparatorShell(project, "new")(command, "Bash").action, "allow", `new: ${command}`);
    assert.equal(inProject(command, "Bash").action, "block", command);
  }
  assert.equal(inProject("rg 'foo|bar'", "Bash").action, "block", "a search of the whole folder still finds the file");
});

test("a separator outside quotes still ends a reader's files", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
  const shell = quotedSeparatorShell(root);
  for (const [command, toolName] of [
    ["cat a | grep x", "Bash"],
    ["cat src/app.js; echo .env", "Bash"],
    ["cat src/app.js && echo .env", "Bash"],
    ["cat 'src/app.js' | echo .env", "Bash"],
    ["Get-Content src/app.js; Write-Output .env", "PowerShell"],
    ["Get-Content 'src/app.js' | Write-Output .env", "PowerShell"],
    ["cat src/app.js; echo .env", "Cursor"],
  ]) {
    assert.equal(shell(command, toolName).action, "allow", `${toolName} ${JSON.stringify(command)}`);
  }
  for (const [command, toolName] of [
    ["cat a; cat .env", "Bash"],
    ["cat 'a;b' | cat .env", "Bash"],
    ["Get-Content src/app.js; Get-Content .env", "PowerShell"],
    ["type a & type .env", "Cursor"],
  ]) {
    const outcome = shell(command, toolName);
    assert.equal(outcome.action, "block", `${toolName} ${JSON.stringify(command)}`);
    assert.equal(outcome.location, ".env", `${toolName} ${JSON.stringify(command)} is stopped for .env`);
  }
});

test("a broad shell glob is stopped only when its folder holds a secret file it matches", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "app.js"), "const SAMPLE = 1;\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "notes.txt"), "notes\n");
  fs.mkdirSync(path.join(root, "keys"));
  fs.writeFileSync(path.join(root, "keys", "credentials.json"), '{"user":"example"}\n');
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "grep -n TODO src/*",
    "cat docs/*",
    "head -n 3 *",
    "sort data/*",
    "cat docs/*.txt",
    "wc -l < docs/*",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
  for (const command of [
    "cat keys/*",
    "cat keys/*.json",
    "cat .en*",
    "cd keys && cat *",
    "shopt -s dotglob; cat *",
    "cat $HOME/*",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
  assert.equal(shell("Get-Content *", "PowerShell").action, "block", "PowerShell's * matches .env");
  assert.equal(shell("Get-Content docs/*", "PowerShell").action, "allow");
});

test("a recursive read of a broad shell glob walks the folders it matches", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "app.js"), "const SAMPLE = 1;\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "notes.txt"), "notes\n");
  fs.mkdirSync(path.join(root, "keys"));
  fs.writeFileSync(path.join(root, "keys", "credentials.json"), '{"user":"example"}\n');
  fs.mkdirSync(path.join(root, "svc"));
  fs.writeFileSync(path.join(root, "svc", ".env"), "SAMPLE=placeholder\n");
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "grep -r SAMPLE *",
    "grep -rn SAMPLE ./*",
    "grep -R SAMPLE *vc",
    "grep --recursive SAMPLE ?eys",
    "grep -rn --include=*.json SAMPLE *",
    "cp -r * /tmp/out",
    "cp -R ./* out",
    "cp -a *vc out",
    "cp -r keys out",
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    assert.match(outcome.location, /^(?:keys\/credentials\.json|svc\/\.env)$/, command);
  }
  for (const command of [
    "grep -n SAMPLE *",
    "grep -r SAMPLE *ocs",
    "grep -rn SAMPLE docs/*",
    "grep -rn --include=*.js SAMPLE *",
    "cp -r docs/* out",
    "cp -r ?ocs out",
    "cp * out",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
});

function recursiveFixture(t) {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "app.js"), "const SAMPLE = 1;\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "notes.txt"), "notes\n");
  fs.mkdirSync(path.join(root, "keys"));
  fs.writeFileSync(path.join(root, "keys", "credentials.json"), '{"user":"example"}\n');
  fs.mkdirSync(path.join(root, "svc"));
  fs.writeFileSync(path.join(root, "svc", ".env"), "SAMPLE=placeholder\n");
  return root;
}

test("diff -r reads every file under the folders it compares", (t) => {
  const root = recursiveFixture(t);
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "diff -r * /tmp/x",
    "diff -r keys /tmp/x",
    "diff -ru docs keys",
    "diff -Naur /tmp/x svc",
    "diff --recursive /tmp/x ?eys",
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    assert.match(outcome.location, /^(?:keys\/credentials\.json|svc\/\.env)$/, command);
  }
  for (const command of [
    "diff -r docs /tmp/x",
    "diff -r docs/* /tmp/x",
    "diff app.js docs/notes.txt",
    "diff keys svc",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
});

test("rg and findstr /s read the folders under them the way grep -r does", (t) => {
  const root = recursiveFixture(t);
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "rg SAMPLE keys",
    "rg SAMPLE *",
    "rg SAMPLE",
    "rg -n -e SAMPLE -- keys",
    "rg --hidden SAMPLE svc",
    "rg -uu SAMPLE svc",
    "rg -. SAMPLE svc",
    "rg -g '*.env' SAMPLE svc",
    "rg --max-depth 2 SAMPLE keys",
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    assert.match(outcome.location, /^(?:keys\/credentials\.json|svc\/\.env)$/, command);
  }
  for (const command of [
    "rg SAMPLE docs",
    "rg SAMPLE svc",
    "rg SAMPLE app.js",
    "rg --max-depth 0 SAMPLE keys",
    "rg -d0 SAMPLE keys",
    "rg -g '*.txt' SAMPLE",
    "rg SAMPLE docs/*",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
  for (const command of [
    "findstr /s SAMPLE *",
    "findstr /s /i SAMPLE *.json",
    "findstr /si SAMPLE .\\*.json",
    'findstr /s /c:"SAMPLE value" *',
    "findstr /s /d:keys SAMPLE *",
  ]) {
    const outcome = shell(command, "PowerShell");
    assert.equal(outcome.action, "block", command);
    assert.match(outcome.location, /^(?:keys\/credentials\.json|svc\/\.env)$/, command);
  }
  for (const command of [
    "findstr /s SAMPLE *.txt",
    "findstr SAMPLE *",
    "findstr /s SAMPLE docs\\*",
    "findstr /s /d:docs SAMPLE *",
  ]) {
    assert.equal(shell(command, "PowerShell").action, "allow", command);
  }
});

// What a shell command is stopped for when a recursive reader's folders can't all be walked.
const FOLDER_TOO_BIG = "a folder too big to check";

test("a recursive read of a broad glob Guard can't finish walking is stopped", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "big", "zz"), { recursive: true });
  for (let index = 0; index < 120; index += 1) fs.writeFileSync(path.join(root, "big", `f${index}.txt`), "x\n");
  fs.writeFileSync(path.join(root, "big", "zz", ".env"), "SAMPLE=placeholder\n");
  const shell = (command, options = {}) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, searchWalkMaxEntries: 50, ...options },
    );
  for (const command of ["grep -r SAMPLE *", "cp -r * out", "diff -r * /tmp/x", "rg -uu SAMPLE *"]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    assert.equal(outcome.location, "*", command);
  }

  // Every walk in one command shares one budget: ten small folders, each well under the limit on its own.
  const many = tempDir(t);
  for (let folder = 0; folder < 10; folder += 1) {
    fs.mkdirSync(path.join(many, `d${folder}`));
    for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(many, `d${folder}`, `f${index}.txt`), "x\n");
  }
  const shellMany = (command) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: many } },
      { cwd: many, searchWalkMaxEntries: 100 },
    );
  assert.equal(shellMany("grep -r SAMPLE d1").action, "allow", "one folder fits the budget");
  assert.equal(shellMany("grep -r SAMPLE *").action, "block", "ten folders don't");
  // A glob that can't name a secret file is stopped too: its folders couldn't all be walked.
  const glob = shellMany("grep -r SAMPLE d*");
  assert.equal(glob.action, "block");
  assert.equal(glob.location, FOLDER_TOO_BIG);
});

// A tree with a secret file past what a small walk budget reads: wide (`big`, 120 files before the secret's folder) and
// deep (`deep`, 40 folders down). `clean` is as wide with no secret file in it.
function bigTreeFixture(t) {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "app.js"), "const SAMPLE = 1;\n");
  fs.mkdirSync(path.join(root, "big", "zz"), { recursive: true });
  fs.mkdirSync(path.join(root, "clean", "zz"), { recursive: true });
  for (let index = 0; index < 120; index += 1) {
    fs.writeFileSync(path.join(root, "big", `f${index}.txt`), "x\n");
    fs.writeFileSync(path.join(root, "clean", `f${index}.txt`), "x\n");
  }
  fs.writeFileSync(path.join(root, "big", "zz", ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "clean", "zz", "notes.txt"), "notes\n");
  let deep = path.join(root, "deep");
  for (let index = 0; index < 40; index += 1) deep = path.join(deep, `d${index}`);
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, ".env"), "SAMPLE=placeholder\n");
  return root;
}

const BIG_TREE_READERS = [
  ["grep -r SAMPLE big"],
  ["grep -rn SAMPLE ."],
  ["grep -rn SAMPLE"],
  ["grep -R SAMPLE big"],
  ["grep -r SAMPLE deep"],
  ["grep -r --include=*.env SAMPLE deep"],
  ["rg -uu SAMPLE big"],
  ["rg --hidden --no-ignore SAMPLE deep"],
  ["cp -r big out"],
  ["cp -a deep /tmp/out"],
  ["diff -r big /tmp/x"],
  ["findstr /s SAMPLE big\\*.env", "PowerShell"],
  ["findstr /s /d:deep SAMPLE *.env", "PowerShell"],
];

test("a recursive read of a folder too big to walk in full is stopped, not let through", (t) => {
  const root = bigTreeFixture(t);
  const shell = (command, toolName = "Bash", options = {}) =>
    guard.inspectShell(
      "claude",
      { tool_name: toolName, tool_input: { command, cwd: root } },
      { cwd: root, searchWalkMaxEntries: 30, ...options },
    );
  for (const [command, toolName] of BIG_TREE_READERS) {
    const outcome = shell(command, toolName);
    assert.equal(outcome.action, "block", command);
    // findstr's `*.env` could name a secret file, so it's what the command is stopped for.
    assert.ok([FOLDER_TOO_BIG, "big\\*.env", "*.env"].includes(outcome.location), `${command}: ${outcome.location}`);
  }
  // rg leaves out a hidden .env, but it would read every other file under a folder Guard couldn't finish.
  assert.equal(shell("rg SAMPLE big").location, FOLDER_TOO_BIG);
  assert.equal(shell("grep -r SAMPLE clean").location, FOLDER_TOO_BIG, "too big to tell, secret or not");
  // With room for the whole tree, each reader finds the secret file itself, and a clean folder goes through.
  for (const [command, toolName] of BIG_TREE_READERS) {
    const outcome = shell(command, toolName, { searchWalkMaxEntries: 1000 });
    assert.equal(outcome.action, "block", command);
    assert.notEqual(outcome.location, FOLDER_TOO_BIG, command);
  }
  for (const command of ["grep -r SAMPLE clean", "rg SAMPLE big", "cp -r clean out", "grep -rn SAMPLE app.js"]) {
    assert.equal(shell(command, "Bash", { searchWalkMaxEntries: 1000 }).action, "allow", command);
  }
  // The message says why, and how to go on.
  const output = JSON.stringify(guard.boundaryOutput("claude", shell("grep -r SAMPLE clean"), "shell"));
  assert.match(output, /couldn't check in full/);
  assert.match(output, /Search a smaller folder/);
});

// Counted, not timed: the walk's clock is set to have run out before it starts, or advanced by a fake clock.
test("a walk that runs out of time stops the command, and gives its time back to the lookups after it", (t) => {
  const root = bigTreeFixture(t);
  const shell = (command, options = {}) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root, ...options });
  for (const command of ["grep -r SAMPLE clean", "grep -r SAMPLE big", "cp -r deep out"]) {
    assert.equal(shell(command, { searchWalkMaxMs: 0 }).location, FOLDER_TOO_BIG, command);
  }
  // Reading `slow` takes 3 seconds by the fake clock: past base's 2-second lookup window, inside the 4-second walk.
  fs.mkdirSync(path.join(root, "slow"));
  fs.writeFileSync(path.join(root, "slow", "notes.txt"), "notes\n");
  const realNow = Date.now;
  const realReaddir = fs.readdirSync;
  const realOpendir = fs.opendirSync;
  let offset = 0;
  const slowRead = (folder) => {
    if (path.basename(String(folder)) === "slow") offset += 3000;
  };
  Date.now = () => realNow() + offset;
  fs.readdirSync = function readdirSync(folder, ...rest) {
    slowRead(folder);
    return realReaddir.call(this, folder, ...rest);
  };
  fs.opendirSync = function opendirSync(folder, ...rest) {
    slowRead(folder);
    return realOpendir.call(this, folder, ...rest);
  };
  t.after(() => {
    Date.now = realNow;
    fs.readdirSync = realReaddir;
    fs.opendirSync = realOpendir;
  });
  const outcome = shell("grep -r SAMPLE slow && cat app.js", {
    shellCheckMaxMs: 600_000,
    hookCheckMaxMs: 600_000,
  });
  assert.deepEqual([outcome.action, outcome.location], ["allow", undefined]);
});

test("a folder the walk can't read stops the command, unless it's one this account isn't allowed to open", (t) => {
  const root = tempDir(t);
  // `zz-locked` comes last in the listing, so the walk reads it before `svc`.
  for (const folder of ["svc", "docs", "zz-locked"]) fs.mkdirSync(path.join(root, folder));
  fs.writeFileSync(path.join(root, "svc", ".env"), "SAMPLE=placeholder\n");
  fs.writeFileSync(path.join(root, "docs", "notes.txt"), "notes\n");
  const realReaddir = fs.readdirSync;
  const realOpendir = fs.opendirSync;
  let code = "EACCES";
  const fail = (folder) => {
    if (path.basename(String(folder)).startsWith("zz-")) {
      throw Object.assign(new Error(`${code}: can't read ${folder}`), { code });
    }
  };
  fs.readdirSync = function readdirSync(folder, ...rest) {
    fail(folder);
    return realReaddir.call(this, folder, ...rest);
  };
  fs.opendirSync = function opendirSync(folder, ...rest) {
    fail(folder);
    return realOpendir.call(this, folder, ...rest);
  };
  t.after(() => {
    fs.readdirSync = realReaddir;
    fs.opendirSync = realOpendir;
  });
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (code of ["EACCES", "EPERM"]) {
    // The reader can't open that folder either, so the walk goes on past it to the rest.
    assert.equal(shell("grep -rn SAMPLE .").location, "svc/.env", code);
    assert.equal(shell("grep -rn SAMPLE docs zz-locked").action, "allow", code);
  }
  for (code of ["EIO", "ENAMETOOLONG", "EMFILE"]) {
    assert.equal(shell("grep -rn SAMPLE docs zz-locked").location, FOLDER_TOO_BIG, code);
  }
  // Run as another user, the reader may open what this account can't.
  for (code of ["EACCES", "EPERM"]) {
    for (const command of ["sudo grep -rn SAMPLE docs zz-locked", "sudo cp -r . /tmp/out", "sudo rg -uu SAMPLE ."]) {
      assert.equal(shell(command).action, "block", `${command} ${code}`);
    }
  }
  // A folder removed since it was listed has nothing left to read, so the walk goes on past it.
  for (code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(shell("grep -rn SAMPLE .").location, "svc/.env", code);
    assert.equal(shell("grep -rn SAMPLE docs zz-locked").action, "allow", code);
  }
  // One whose name Node couldn't spell (it reads back with U+FFFD in it) can't be passed over: the reader can open it.
  // It comes last in the listing, so the walk reads it first.
  fs.mkdirSync(path.join(root, "zz-\uFFFD"));
  for (code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(shell("grep -rn SAMPLE docs .").location, FOLDER_TOO_BIG, code);
  }
});

// A busy computer lists folders slower, so the walk has all of the path check's time, not a part of it.
test("the walk has the path check's whole time, and stops at its deadline", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "src", "svc"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "svc", ".env"), "SAMPLE=placeholder\n");
  const realNow = Date.now;
  const realReaddir = fs.readdirSync;
  let started = 0;
  let late = 0;
  // Each folder listed takes the clock this far on, so the walk's second folder is read this late into the check.
  fs.readdirSync = function readdirSync(...args) {
    started += late;
    return realReaddir.apply(this, args);
  };
  Date.now = () => realNow() + started;
  t.after(() => {
    fs.readdirSync = realReaddir;
    Date.now = realNow;
  });
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  late = 2200;
  assert.equal(shell("grep -rn SAMPLE src").location, "src/svc/.env");
  started = 0;
  late = 6000;
  assert.equal(shell("grep -rn SAMPLE src").location, FOLDER_TOO_BIG);
});

// Credential stores known by their folder (`.kube/config`) are found when that folder is the one read.
test("a recursive read of a credential store's own folder finds the file its folder makes secret", (t) => {
  const root = tempDir(t);
  const files = {
    ".kube/config": "token: placeholder\n",
    ".docker/config.json": '{"auths":{}}\n',
    ".config/gh/hosts.yml": "oauth_token: placeholder\n",
    ".config/gcloud/application_default_credentials.json": "{}\n",
    ".codex/auth.json": "{}\n",
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "grep -r token .kube",
    "cp -r .kube /tmp/k",
    "cp -r .docker /tmp/d",
    "grep -r oauth .config/gh",
    "grep -r refresh .config/gcloud",
    "rg -uu token .codex",
    "findstr /s token .kube\\*",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
  // A file of the same name elsewhere stays ordinary.
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app", "config"), "x\n");
  assert.equal(shell("grep -r x app").action, "allow");
  // The store's folder named another way: a junction to it, or its Windows short name where the drive makes them.
  fs.symlinkSync(path.join(root, ".kube"), path.join(root, "k"), process.platform === "win32" ? "junction" : "dir");
  fs.mkdirSync(path.join(root, ".config", "GitHub CLI"));
  fs.writeFileSync(path.join(root, ".config", "GitHub CLI", "hosts.yml"), "oauth_token: placeholder\n");
  const aliases = ["k"];
  for (const [folder, short] of [
    [".kube", "KUBE~1"],
    [".config/GitHub CLI", ".config/GITHUB~1"],
  ]) {
    try {
      if (fs.realpathSync.native(path.join(root, short)) === fs.realpathSync.native(path.join(root, folder))) {
        aliases.push(short);
      }
    } catch {
      // No short names on this drive.
    }
  }
  for (const alias of aliases) {
    assert.equal(shell(`grep -r token ${alias}`).action, "block", alias);
  }
});

// A folder walked once is judged again for each later reader's filters, and that has the walk's deadline too.
test("judging a walked folder's secret files for another reader stops at the walk's deadline", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "d"));
  for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(root, "d", `k${index}.pem`), "x\n");
  // A filter that takes a second to match each file, as a glob of many brace groups can: its match asks path.isAbsolute
  // first, and each ask moves the clock on.
  const slow = "zz-slow-*.pem";
  const realNow = Date.now;
  const realIsAbsolute = path.isAbsolute;
  let late = 0;
  let matched = 0;
  path.isAbsolute = function isAbsolute(text) {
    if (text === slow) {
      matched += 1;
      late += 1000;
    }
    return realIsAbsolute.call(this, text);
  };
  Date.now = () => realNow() + late;
  t.after(() => {
    path.isAbsolute = realIsAbsolute;
    Date.now = realNow;
  });
  const outcome = guard.inspectShell(
    "claude",
    {
      tool_name: "Bash",
      tool_input: { command: `grep -r --include=*.txt x d; grep -r --include=${slow} x d`, cwd: root },
    },
    { cwd: root },
  );
  assert.equal(outcome.action, "block");
  assert.equal(outcome.location, FOLDER_TOO_BIG);
  assert.ok(matched <= 7, `${matched} files matched past the deadline`);
});

test("a recursive read named after the lookups run out is still walked, even when it isn't one of the command's words", (t) => {
  const root = recursiveFixture(t);
  const shell = (command, options, toolName = "Bash") =>
    guard.inspectShell(
      "claude",
      { tool_name: toolName, tool_input: { command, cwd: root } },
      { cwd: root, shellCheckMaxMs: 600_000, searchWalkMaxMs: 600_000, ...options },
    );
  // diff's --from-file folder, grep's working folder and findstr's aren't operands the reader check looks up first.
  const padding = distinctOperands(4000);
  for (const [command, toolName] of [
    ["diff -r --from-file=svc missing.txt"],
    [`cat ${padding}; grep -r SAMPLE`],
    [`cat ${padding}; rg -uu SAMPLE`],
    [`findstr /s SAMPLE ${padding}.env`, "PowerShell"],
    [`findstr /s SAMPLE ${padding}svc\\*`, "PowerShell"],
  ]) {
    for (const options of [{}, { shellOperandMaxMs: 0 }, { shellOperandMaxLookups: 50 }]) {
      const outcome = shell(command, options, toolName);
      assert.equal(outcome.action, "block", `${command.slice(-40)} ${JSON.stringify(options)}`);
    }
  }
  for (const options of [{}, { shellOperandMaxMs: 0 }, { shellOperandMaxLookups: 50 }]) {
    assert.equal(shell("diff -r --from-file=docs missing.txt", options).action, "allow", JSON.stringify(options));
    assert.equal(
      shell(`cat ${padding}; findstr /s SAMPLE notes.txt`, options).action,
      "allow",
      JSON.stringify(options),
    );
  }
  // Past the lookups the walk still finds the secret file itself, not just a reason to stop.
  const found = shell(`cat ${padding}; grep -r SAMPLE`, { shellOperandMaxLookups: 50 });
  assert.equal(found.location, "svc/.env");
});

// Counted, not timed: findstr looks for each file name it's given in every folder below, so many names are one walk.
test("one folder a command's recursive readers read many times over is walked once", (t) => {
  const root = recursiveFixture(t);
  const realReaddir = fs.readdirSync;
  let listings = 0;
  fs.readdirSync = function readdirSync(...args) {
    listings += 1;
    return realReaddir.apply(this, args);
  };
  t.after(() => {
    fs.readdirSync = realReaddir;
  });
  const names = Array.from({ length: 2000 }, (_, index) => `n${index}.txt`).join(" ");
  const outcome = guard.inspectShell(
    "claude",
    { tool_name: "PowerShell", tool_input: { command: `findstr /s SAMPLE ${names}`, cwd: root } },
    { cwd: root, searchWalkMaxEntries: 100, shellCheckMaxMs: 600_000, searchWalkMaxMs: 600_000 },
  );
  assert.equal(outcome.action, "allow");
  // The fixture's four folders, once.
  assert.ok(listings <= 4, `${listings} folder listings`);
  // The one walk still finds a secret file for a later name.
  const secret = guard.inspectShell(
    "claude",
    { tool_name: "PowerShell", tool_input: { command: `findstr /s SAMPLE ${names} *.*`, cwd: root } },
    { cwd: root, searchWalkMaxEntries: 100 },
  );
  assert.equal(secret.action, "block");
});

// Counted, not timed: how many folders the walk lists and how many entries they hold.
test("a walk stops listing folders once its entries are spent, and lists each folder in one call", (t) => {
  const root = tempDir(t);
  for (let folder = 0; folder < 50; folder += 1) {
    fs.mkdirSync(path.join(root, "tree", `d${folder}`), { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      fs.writeFileSync(path.join(root, "tree", `d${folder}`, `f${index}.txt`), "x\n");
    }
  }
  const realReaddir = fs.readdirSync;
  const realOpendir = fs.opendirSync;
  let listed = 0;
  let opened = 0;
  fs.readdirSync = function readdirSync(...args) {
    const entries = realReaddir.apply(this, args);
    listed += entries.length;
    return entries;
  };
  fs.opendirSync = function opendirSync(...args) {
    opened += 1;
    return realOpendir.apply(this, args);
  };
  t.after(() => {
    fs.readdirSync = realReaddir;
    fs.opendirSync = realOpendir;
  });
  const outcome = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command: "grep -r SAMPLE tree", cwd: root } },
    { cwd: root, searchWalkMaxEntries: 100, searchWalkMaxMs: 600_000 },
  );
  assert.equal(outcome.location, FOLDER_TOO_BIG);
  assert.equal(opened, 0, "each folder is read in one call");
  // The top folder's 50 entries, then 20 at a time until 100 are spent: about 150 listed, never the whole 1,050.
  assert.ok(listed <= 50 + 100 + 20, `listed ${listed} entries on a budget of 100`);
});

// rg leaves out hidden folders unless told otherwise, and Guard already takes a secret file under one as out of rg's
// reach, so the walk for rg doesn't spend its budget on them: a big `.venv` doesn't stop `rg foo`.
test("the walk for rg skips the hidden folders rg skips, and no others", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, ".venv", "lib"), { recursive: true });
  for (let index = 0; index < 200; index += 1) fs.writeFileSync(path.join(root, ".venv", "lib", `m${index}.py`), "x\n");
  fs.writeFileSync(path.join(root, ".venv", ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell(
      "claude",
      { tool_name: toolName, tool_input: { command, cwd: root } },
      { cwd: root, searchWalkMaxEntries: 50, searchWalkMaxMs: 600_000, shellCheckMaxMs: 600_000 },
    );
  for (const command of ["rg SAMPLE", "rg -n SAMPLE .", "rg -i sample src", "rg -u SAMPLE"]) {
    assert.equal(shell(command).action, "allow", command);
  }
  // A reader that does read hidden folders still walks them all, and so does rg when told to.
  for (const command of [
    "rg --hidden SAMPLE",
    "rg -uu SAMPLE",
    "rg -g '*.py' SAMPLE",
    "grep -rn SAMPLE .",
    "cp -r . /tmp/out",
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
  }
  // The same folder read by rg, then by grep in one command, is walked in full for grep.
  assert.equal(shell("rg SAMPLE . && grep -r SAMPLE .").action, "block");
  // A hidden folder named as rg's own folder is read, so it's walked.
  assert.equal(shell("rg SAMPLE .venv").action, "block");
});

// A fresh copy of Guard's shell check whose child processes are counted by program name in `spawns`.
// Every cached Guard module is dropped before the reload, so callers that moved out of the bin count too,
// and the cache is put back exactly as it was afterwards, since other tests hold the modules loaded
// earlier. It's the shell check's own file, since the bin loads that only when a check first runs, after
// the cache is back.
function guardCountingSpawns(spawns) {
  const childProcess = require("child_process");
  const guardPath = require.resolve(path.join(GUARD_DIR, "lib", "shell-checks", "shell-check.js"));
  const inGuard = (key) => key.startsWith(GUARD_DIR + path.sep);
  const real = childProcess.spawnSync;
  const dropped = new Map(
    Object.keys(require.cache)
      .filter(inGuard)
      .map((key) => [key, require.cache[key]]),
  );
  childProcess.spawnSync = function countedSpawnSync(command, ...rest) {
    const name = path.basename(String(command)).replace(/\.exe$/i, "");
    spawns[name] = (spawns[name] || 0) + 1;
    return real.call(this, command, ...rest);
  };
  for (const key of dropped.keys()) delete require.cache[key];
  try {
    return require(guardPath);
  } finally {
    childProcess.spawnSync = real;
    for (const key of Object.keys(require.cache).filter(inGuard)) delete require.cache[key];
    for (const [key, entry] of dropped) require.cache[key] = entry;
  }
}

// Counted, not timed: among many git-ignored secret files, rg's walk used to ask Git about each one, two processes a
// file without rg on PATH, and ran past its deadline.
test("rg's walk asks Git about all the secret files it finds at once", (t) => {
  const root = tempDir(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "cache/\n");
  for (let index = 0; index < 30; index += 1) {
    fs.mkdirSync(path.join(root, "cache", `k${index}`), { recursive: true });
    fs.writeFileSync(path.join(root, "cache", `k${index}`, "server.key"), "placeholder\n");
  }
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
  const spawns = {};
  const counted = guardCountingSpawns(spawns);
  const shell = (command) =>
    counted.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  const asked = (command) => {
    for (const key of Object.keys(spawns)) delete spawns[key];
    const outcome = shell(command);
    return { outcome, count: (spawns.git || 0) + (spawns.rg || 0) };
  };
  // What a command with no secret file in its folder starts, for Git and rg, without the walk asking anything.
  const quiet = asked("rg SAMPLE src").count;
  for (const command of ["rg SAMPLE", "rg -n SAMPLE .", "rg -i sample . src"]) {
    const { outcome, count } = asked(command);
    assert.equal(outcome.action, "allow", command);
    // The copy counts: the walk asks Git about the git-ignored secret files.
    assert.ok(count > 0, `${command}: nothing counted`);
    // One rg probe (or its listing), one batch of files and one question about the folder itself.
    assert.ok(count <= quiet + 3, `${command}: ${JSON.stringify(spawns)}, ${quiet} without secret files`);
  }
  // rg reads a git-ignored folder it's given by name, so its secret files are found there.
  assert.equal(shell("rg SAMPLE cache").action, "block");
  // A secret file Git doesn't ignore is still found among them.
  fs.writeFileSync(path.join(root, "src", "server.key"), "placeholder\n");
  const outcome = shell("rg SAMPLE");
  assert.deepEqual([outcome.action, outcome.location], ["block", "src/server.key"]);
});

// Git and rg don't always agree on what's ignored: Git on Windows ignores `Secrets/` for a folder named `secrets`, and
// takes a `.git` that isn't a repository as no boundary. With rg on PATH its own listing says which folders to skip.
bothRipgrepWays("rg's walk leaves out only the folders rg's own listing leaves out", (t) => {
  const root = tempDir(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "Secrets/\ntarget/\nvault/\n");
  fs.mkdirSync(path.join(root, "target"));
  for (let index = 0; index < 400; index += 1) fs.writeFileSync(path.join(root, "target", `lib${index}.rlib`), "x\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  const shell = (command) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, searchWalkMaxEntries: 300, searchWalkMaxMs: 600_000, shellCheckMaxMs: 600_000 },
    );
  assert.equal(shell("rg main").action, "allow", "target is left out");
  const realRipgrep = spawnSync("rg", ["--version"], { windowsHide: true }).status === 0;
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "server.key"), "placeholder\n");
  fs.mkdirSync(path.join(root, "inner", "vault"), { recursive: true });
  fs.mkdirSync(path.join(root, "inner", ".git"));
  fs.writeFileSync(path.join(root, "inner", "vault", "server.key"), "placeholder\n");
  const outcome = shell("rg main");
  if (realRipgrep) {
    assert.equal(outcome.action, "block");
    assert.ok(["secrets/server.key", "inner/vault/server.key"].includes(outcome.location), outcome.location);
    fs.rmSync(path.join(root, "secrets"), { recursive: true });
    assert.equal(shell("rg main").location, "inner/vault/server.key");
  }
});

// A folder named with a last dot or space opens as the folder without it on Windows, as rg, grep and findstr read it.
test(
  "a recursive read of a folder named with a last dot is walked as the folder Windows opens",
  {
    skip: process.platform !== "win32" && "Windows only",
  },
  (t) => {
    const root = tempDir(t);
    fs.mkdirSync(path.join(root, "secrets"));
    fs.writeFileSync(path.join(root, "secrets", "server.key"), "placeholder\n");
    fs.mkdirSync(path.join(root, ".kube"));
    fs.writeFileSync(path.join(root, ".kube", "config"), "token: placeholder\n");
    const shell = (command) =>
      guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
    for (const command of [
      "rg -uu SAMPLE secrets.",
      "grep -r SAMPLE ./secrets.",
      "grep -r SAMPLE secrets./",
      'grep -r SAMPLE "secrets. ."',
      "cp -r secrets.. /tmp/out",
      "grep -r token .kube.",
    ]) {
      assert.equal(shell(command).action, "block", command);
    }
  },
);

// Git Bash's grep, cp and diff open a folder named with a last dot as written, where findstr and rg.exe open the folder
// without it, so both are walked.
test("a recursive read of a folder named with a last dot walks that folder too, not only the one without it", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "secrets."));
  fs.writeFileSync(path.join(root, "secrets.", ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "readme.txt"), "notes\n");
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "grep -r SAMPLE secrets.",
    "grep -r SAMPLE secrets./",
    "cp -r secrets. /tmp/out",
    "diff -r secrets. secrets",
    "rg -uu SAMPLE secrets.",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
  assert.equal(shell("grep -r SAMPLE secrets").action, "allow");
});

// grep's --exclude-dir counts only where grep reads it as that option: after an option that takes a value, or one Guard
// doesn't know (a short form, say, which grep accepts), it may be something else, so nothing is left out.
// The shells split, join, expand and redirect grep's words in more ways than Guard can model, so --exclude-dir could
// be read as something else, or not reach grep at all: the walk leaves no folder out for it.
test("the walk for grep leaves no folder out for its --exclude-dir", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, ".kube"));
  fs.writeFileSync(path.join(root, ".kube", "config"), "token: placeholder\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "token\n");
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    // Each shell passes grep its words its own way, so no --exclude-dir is taken to leave a folder out.
    "grep -rn --exclude-dir=.kube token .",
    "grep -rn -i --exclude-dir .kube token .",
    "grep -r --exclude-dir=.kube -e token &>o.txt .kube/.",
    "grep -r --exclude-dir=.kube token `echo .kube/.`",
    "grep -r --group-separator --exclude-dir=.kube token .",
    "grep -r --regex --exclude-dir=.kube -e token .",
    "grep -r -X --exclude-dir=.kube token .",
    "grep -r --exclude-d=.kube --colour=never token .",
    "grep -r --unknown-option --exclude-dir=.kube token .",
    // The shell expands a wildcard (or drops it, or matches a file named like the option) before grep sees it, and
    // reads quotes and `$` its own way; Git's grep.exe expands a wildcard itself when PowerShell starts it.
    "grep -rl token . --exclude-dir *",
    "grep -rl token . --exclude-dir=*",
    "grep -rl token . --exclude-dir=.k*",
    "grep -rl token . --exclude-dir=.kub?",
    "grep -rl token . --exclude-dir='.kube",
    'grep -rl token . --exclude-dir=$HOME/.kube --exclude-dir="$D"',
    "grep -rl token . --exclude-dir=~",
    // The words after a line break belong to the next command.
    "grep -rl token .\n--exclude-dir=.kube",
    // The shell joins a quoted word to what follows it with no space, and splits only at spaces and tabs: grep gets
    // the pattern `x--exclude-dir=.kube`.
    "grep -r -e token -e 'x'--exclude-dir=.kube .",
    'grep -rv "x"--exclude-dir=.kube .',
    "grep -r -e token -e x\v--exclude-dir=.kube .",
    "grep -r -e token -e x\f--exclude-dir=.kube .",
    "grep -r -e token -e x\u00a0--exclude-dir=.kube .",
    // With these set, grep reads an option after its operands as a file, or adds options of its own.
    "export POSIXLY_CORRECT=1; grep -r token . --exclude-dir=.kube",
    "export GREP_OPTIONS=-e; grep --exclude-dir=.kube -r -e token .",
    // Set in a way the command's text doesn't name, or by a command before grep, or before the command runs (a file
    // the shell reads first): grep reads an option after its first operand as a file when POSIXLY_CORRECT is set.
    "v=POSIXLY; export ${v}_CORRECT=1; grep -r token --exclude-dir=.kube .",
    ". ./p.sh; grep -r token --exclude-dir=.kube .",
    "v=GREP; export ${v}_OPTIONS='-r -e token --'; grep --exclude-dir=.kube -r x .",
    "grep -r token . --exclude-dir=.kube",
    "grep -r token --exclude-dir=.kube .",
    // What follows a redirection's target with no blank between is part of the target's name, not a word of grep's.
    'grep -r 2>e"--exclude-dir=.kube" token .',
    "grep -r 1>q'--exclude-dir=.kube' token .",
    "grep -r 2>e\\ --exclude-dir=.kube token .",
    "grep -r 2>$x--exclude-dir=.kube token .",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
  // PowerShell splits a quoted run from what follows it: grep gets `--exclude-dir=.ku` and `be`.
  const powerShell = (command) =>
    guard.inspectShell("claude", { tool_name: "PowerShell", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "grep -r token . '--exclude-dir=.ku'be",
    'grep -r token . "--exclude-dir=.ku"be',
    "grep -r --exclude-dir '.ku'be token .",
    "grep -r --exclude-dir '.kube''' token .",
    // PowerShell drops an empty quoted word, so the option before it takes `--exclude-dir=.kube` as its value.
    "grep -r --exclude '' --exclude-dir=.kube token .",
    "grep -rv -e '' --exclude-dir=.kube token .",
    'grep -rv -e "" --exclude-dir=.kube token .',
    // PowerShell splits a word starting with one `-` at a dot: grep gets `-etoken` and `.x`, an operand.
    "grep -r -etoken.x --exclude-dir=.kube .",
    'grep -r 2>e"--exclude-dir=.kube" token .',
    "grep -r 1>q'--exclude-dir=.kube' token .",
    "grep -r 2>e` --exclude-dir=.kube token .",
    // PowerShell passes what follows a target's property on to grep: `-e` here, which takes the next word.
    "grep -r -e token 2>$x.y-e --exclude-dir=.kube .",
    "grep -r --exclude-dir=.kube -e token `\n .kube/.",
    "grep -rn --exclude-dir=.kube token .",
    'grep -rn --exclude-dir=".kube" token .',
    "grep -rn --exclude-dir=.kube token . 2>$null",
  ]) {
    assert.equal(powerShell(command).action, "block", command);
  }
  // zsh reads a word starting with `=` as a command's path, so grep doesn't get `=ls` to leave out.
  const equals = tempDir(t);
  fs.mkdirSync(path.join(equals, "=ls"));
  fs.writeFileSync(path.join(equals, "=ls", ".env"), "SAMPLE=placeholder\n");
  const zsh = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command: "grep -r SAMPLE . --exclude-dir =ls", cwd: equals } },
    { cwd: equals },
  );
  assert.deepEqual([zsh.action, zsh.location], ["block", "=ls/.env"]);
  // The shell takes the quotes off: `'x'` leaves out `x`, not a folder named `'x`.
  const quoted = tempDir(t);
  fs.mkdirSync(path.join(quoted, "'x"));
  fs.writeFileSync(path.join(quoted, "'x", ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(quoted, "x"));
  fs.writeFileSync(path.join(quoted, "x", ".env"), "SAMPLE=placeholder\n");
  const inQuoted = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: quoted } }, { cwd: quoted });
  assert.equal(inQuoted('grep -rl --exclude-dir="x" SAMPLE .').action, "block");
  // cmd.exe reads `^` and `%...%` in grep's words again, and PowerShell takes curly quotes for quotes.
  const odd = tempDir(t);
  for (const name of ["cfg^1", "a%OS%", "cfg"]) {
    fs.mkdirSync(path.join(odd, name));
    fs.writeFileSync(path.join(odd, name, ".env"), "SAMPLE=placeholder\n");
  }
  const inOdd = (command) =>
    guard.inspectShell("claude", { tool_name: "PowerShell", tool_input: { command, cwd: odd } }, { cwd: odd });
  for (const command of [
    'cmd /c grep -r --exclude-dir="cfg^1" --exclude-dir=a%OS% --exclude-dir=cfg SAMPLE .',
    'cmd /c grep -r --exclude-dir="cfg^1" --exclude-dir="a%OS%" --exclude-dir=cfg SAMPLE .',
    'grep -r -e SAMPLE -e "x\u201c" --exclude-dir=cfg "\u201c" .',
    "grep -r -e SAMPLE -e 'x\u2018' --exclude-dir=cfg '\u2018' .",
  ]) {
    assert.equal(inOdd(command).action, "block", command);
  }
});

// grep compares bytes in its own locale, which a name outside ASCII may not share with Node, so it's never left out.
test("the walk for grep leaves out no folder named outside ASCII", (t) => {
  const root = tempDir(t);
  for (const name of ["\u{1F600}", "é"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, ".env"), "SAMPLE=placeholder\n");
  }
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "grep -r --exclude-dir=?? SAMPLE .",
    "grep -r --exclude-dir=? SAMPLE .",
    "grep -r --exclude-dir=* --exclude-dir=é SAMPLE .",
    "grep -r --exclude-dir=é --exclude-dir=\u{1F600} SAMPLE .",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
});

// A folder whose name Node reads back with U+FFFD in it isn't spelled the way rg or Git spell it, so neither's answer
// leaves it out of the walk, and a secret file in it is taken as one rg reads.
bothRipgrepWays("rg's walk keeps a folder whose name Node can't spell", (t) => {
  const root = tempDir(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "a\uFFFDb/\n");
  fs.mkdirSync(path.join(root, "a\uFFFDb"));
  fs.writeFileSync(path.join(root, "a\uFFFDb", "id_rsa"), "placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  const outcome = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command: "rg main", cwd: root } },
    { cwd: root, searchWalkMaxEntries: 300, searchWalkMaxMs: 600_000, shellCheckMaxMs: 600_000 },
  );
  assert.deepEqual([outcome.action, outcome.location], ["block", "a\uFFFDb/id_rsa"]);
});

// A redirection's words name where the output goes, not a folder to read: with only a pattern, the reader still reads
// the working folder, and a folder after a redirection is read too.
test("the walk for a recursive reader takes no redirection for a folder it reads", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  const check = (tool, command) =>
    guard.inspectShell("claude", { tool_name: tool, tool_input: { command, cwd: root } }, { cwd: root });
  for (const [tool, command, location] of [
    ["Bash", "grep -rn SAMPLE_TOKEN 2>/dev/null", ".env"],
    ["Bash", "grep -rn SAMPLE_TOKEN 2> /dev/null", ".env"],
    ["Bash", "grep -r SAMPLE_TOKEN > out.txt", ".env"],
    ["Bash", "grep -r SAMPLE_TOKEN >>out.txt", ".env"],
    ["Bash", "grep -r SAMPLE_TOKEN 2>&1", ".env"],
    ["Bash", "grep -r SAMPLE_TOKEN >|out.txt", ".env"],
    ["Bash", "grep -r -e SAMPLE_TOKEN 2>&1 sub", "sub/.env"],
    ["Bash", "grep -r -e SAMPLE_TOKEN 2>/dev/null src sub", "sub/.env"],
    ["Bash", "rg --hidden SAMPLE_TOKEN 2>/dev/null", ".env"],
    ["Bash", "cp -r sub backup 2>/dev/null", "sub/.env"],
    ["Bash", "grep -r -e SAMPLE_TOKEN &>out.txt sub", "sub/.env"],
    ["Bash", "cat src/main.rs 2>&1 sub/.env", "sub/.env"],
    ["PowerShell", "grep -r SAMPLE_TOKEN 2>$null", ".env"],
    ["PowerShell", "grep -r -e SAMPLE_TOKEN *>&1 sub", "sub/.env"],
    ["PowerShell", "grep -r -e SAMPLE_TOKEN 3>&1 sub", "sub/.env"],
    // rg with no folder is taken to read the working folder, whatever its input.
    ["Bash", "true || rg --hidden SAMPLE_TOKEN", ".env"],
    ["Bash", "true && rg --hidden SAMPLE_TOKEN", ".env"],
    ["Bash", "sleep 1 & rg --hidden SAMPLE_TOKEN", ".env"],
    ["Bash", "git log | rg --hidden SAMPLE_TOKEN", ".env"],
    ["Bash", "cat src/main.rs | rg --hidden -f -", ".env"],
    ["Bash", "echo SAMPLE_TOKEN | rg --hidden --file=-", ".env"],
    ["Bash", "echo SAMPLE_TOKEN | rg --hidden -f-", ".env"],
    ["PowerShell", "Get-Content src/main.rs | rg --hidden -f -", ".env"],
    ["PowerShell", "Get-Content src/main.rs | rg --hidden SAMPLE_TOKEN", ".env"],
    // A `|` the line before, in a comment or quotes, doesn't pipe into a reader on the next line.
    ["Bash", "# x |rg -e\nrg --hidden -e SAMPLE_TOKEN", ".env"],
    ["Bash", "echo 'a |rg -e'\nrg --hidden -e SAMPLE_TOKEN", ".env"],
    // An escaped `>` or `<` is a word, so the `&` or `|` after it still ends the command.
    ["Bash", "cat src/main.rs \\>& grep -r SAMPLE_TOKEN", ".env"],
    ["Bash", "cat src/main.rs \\<& rg --hidden SAMPLE_TOKEN", ".env"],
    ["Bash", "cat src/main.rs \\>|grep -r SAMPLE_TOKEN", ".env"],
    ["Bash", "head -1 src/main.rs =\\>& grep -r SAMPLE_TOKEN", ".env"],
    ["PowerShell", 'cmd /c "type src\\main.rs ^>& grep -r SAMPLE_TOKEN"', ".env"],
    // A folder it's given is read whatever its input, and grep -r reads the working folder whatever its input.
    ["Bash", "git log | rg --hidden SAMPLE_TOKEN sub", "sub/.env"],
    ["Bash", "git log | grep -r SAMPLE_TOKEN", ".env"],
    ["Bash", "grep -r SAMPLE_TOKEN < src/main.rs", ".env"],
  ]) {
    const outcome = check(tool, command);
    assert.deepEqual([outcome.action, outcome.location], ["block", location], command);
  }
  // Each reading of a reader's words is walked, never one in place of another, since shells split, join, quote and
  // redirect words their own ways: as Guard always read them, and without what looks like a redirection.
  for (const [tool, command] of [
    ["Bash", 'echo SAMPLE_TOKEN | rg --hidden -l --file="-"'],
    ["Bash", "echo SAMPLE_TOKEN | rg --hidden -l --file='-'"],
    ["Bash", "echo SAMPLE_TOKEN | rg --hidden -l --file=\\-"],
    ["Bash", 'echo SAMPLE_TOKEN | rg --hidden -l -f"-"'],
    ["Bash", 'echo SAMPLE_TOKEN | rg --hidden -l --file=-""'],
    ["PowerShell", '"SAMPLE_TOKEN" | rg --hidden -l --file="-"'],
    ["Bash", "rg --hidden -l -e SAMPLE_TOKEN -e' <src/main.rs'"],
    ["Bash", 'rg --hidden -l -e SAMPLE_TOKEN -e" <<<x"'],
    ["PowerShell", "rg --hidden -l -e SAMPLE_TOKEN -e' <src/main.rs'"],
    ["Bash", "rg --hidden -l SAMPLE_TOKEN # < ."],
    ["Bash", "echo x | rg --hidden -l {SAMPLE_TOKEN,sub}"],
    ["Bash", "echo x | rg --hidden -l *"],
    ["Bash", "P='SAMPLE_TOKEN sub'; echo x | rg --hidden -l $P"],
    ["Bash", "echo x | rg --hidden -l `echo SAMPLE_TOKEN sub`"],
    ["PowerShell", '"x" | rg --hidden -l SAMPLE_TOKEN,sub'],
    ["PowerShell", '"x" | rg --hidden -l @a'],
    ["Bash", "echo x | cmd /c rg --hidden -l -e 'SAMPLE_TOKEN sub '"],
    ["Bash", "echo \\|& rg --hidden -l SAMPLE_TOKEN"],
    ["Bash", "rg --hidden -l SAMPLE_TOKEN < ."],
    ["Bash", "rg --hidden -l SAMPLE_TOKEN < sub"],
    // PowerShell 5.1 splits `-x.y` at its dot, closes a quote on a typographic one, and passes `0>`, `7>` and every
    // `N<` on as words; `eval` and `powershell -c` join their words and read them again.
    ["PowerShell", "Get-Content src/main.rs | rg --hidden SAMPLE_TOKEN -i."],
    ["PowerShell", "Get-Content src/main.rs | rg --hidden -e SAMPLE_TOKEN -s./sub"],
    ["PowerShell", "Get-Content src/main.rs | rg --hidden 'SAMPLE_TOKEN\u2019 sub \u2018x'"],
    ["PowerShell", 'Get-Content src/main.rs | rg --hidden "SAMPLE_TOKEN\u201d sub \u201cx"'],
    ["PowerShell", "rg --hidden SAMPLE_TOKEN src 1< sub"],
    ["PowerShell", "Get-Content src/main.rs | rg --hidden SAMPLE_TOKEN 7> sub"],
    ["PowerShell", "grep -r SAMPLE_TOKEN src 1< sub"],
    ["PowerShell", "grep -r SAMPLE_TOKEN src 0> sub"],
    ["Bash", "eval 'cat src/main.rs | rg --hidden -i ' SAMPLE_TOKEN sub ';'"],
    ["Bash", "eval 'cat src/main.rs | rg --hidden -i ' SAMPLE_TOKEN . ';'"],
    ["PowerShell", "powershell -NoProfile -c 'Get-Content src/main.rs | rg --hidden -i ' SAMPLE_TOKEN sub ';'"],
    // An rg option that takes a value isn't the pattern.
    ["Bash", "rg --hidden --regex-size-limit 1G SAMPLE_TOKEN"],
    ["Bash", "rg --hidden --field-match-separator : SAMPLE_TOKEN"],
  ]) {
    assert.equal(check(tool, command).action, "block", command);
  }
  for (const [tool, command] of [
    ["Bash", "grep -rn main src 2>/dev/null"],
    ["Bash", "grep -rn main src > out.txt"],
    ["Bash", "grep -rn main src 2>&1 | head"],
    ["Bash", "rg main src 2>/dev/null"],
    // rg's input redirection names what it reads instead of a folder, so it stays one of its words.
    ["Bash", "rg --hidden SAMPLE_TOKEN < src/main.rs"],
    ["Bash", "rg --hidden SAMPLE_TOKEN <src/main.rs > out.txt"],
    ["Bash", "rg --hidden SAMPLE_TOKEN 0<src/main.rs"],
    ["Bash", "rg --hidden SAMPLE_TOKEN <> src/main.rs"],
    ["Bash", 'rg --hidden SAMPLE_TOKEN <<< "$text"'],
    ["Bash", "rg --hidden SAMPLE_TOKEN <<EOF"],
    ["Bash", "echo x | rg --hidden SAMPLE_TOKEN < src/main.rs"],
    // Piped into, rg reads its input, so its words are read only as Guard always read them.
    ["Bash", "git log | rg --hidden SAMPLE_TOKEN 2>/dev/null"],
    ["PowerShell", "git log | rg --hidden SAMPLE_TOKEN 2>$null"],
  ]) {
    assert.equal(check(tool, command).action, "allow", command);
  }
});

// A small project with a big git-ignored build folder (a Rust `target`, say): rg never reads that folder, so its walk
// doesn't either, and the project isn't stopped as too big. Counted against a budget of 300 entries.
test("a reader's redirection doesn't hide the command after it", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  const check = (tool, command, cwd = root) =>
    guard.inspectShell("claude", { tool_name: tool, tool_input: { command, cwd } }, { cwd });
  // A reader is found after the line, `$(`, `<(` or `(` that follows another reader's redirection, as before it.
  for (const [tool, command, location] of [
    ["Bash", "cat notes.txt 2>&1\ngrep -r SAMPLE_TOKEN .", ".env"],
    ["Bash", "cat notes.txt 2>&1\r\ngrep -r SAMPLE_TOKEN .", ".env"],
    ["Bash", "head -n 1 notes.txt 2>/dev/null >&2\nrg -uu SAMPLE_TOKEN", ".env"],
    ["Bash", "sort notes.txt &>/dev/null\ngrep -r SAMPLE_TOKEN sub", "sub/.env"],
    ["Bash", "cat notes.txt >| out.txt\nrg -uu SAMPLE_TOKEN", ".env"],
    ["Bash", "cp notes.txt out.txt 2>&1\ncat .env", ".env"],
    ["Bash", "cp -r src dst 2>&1\ngrep -r SAMPLE_TOKEN .", ".env"],
    ["PowerShell", "Get-Content notes.txt 2>&1\nrg -uu SAMPLE_TOKEN", ".env"],
    ["Bash", "cat notes.txt 2>&1 $(grep -r SAMPLE_TOKEN .)", ".env"],
    ["Bash", "cat notes.txt 2>&1 <(grep -r SAMPLE_TOKEN .)", ".env"],
    ["Bash", "tail notes.txt 2>&1 <(rg -uu SAMPLE_TOKEN)", ".env"],
    ["Bash", "head notes.txt &>/dev/stderr $(grep -r SAMPLE_TOKEN .)", ".env"],
    ["Bash", "cp notes.txt out.txt 2>&1 $(cat sub/.env)", "sub/.env"],
    ["PowerShell", "cat notes.txt 2>&1 (rg -uu SAMPLE_TOKEN)", ".env"],
    ["PowerShell", "cp notes.txt out.txt 2>&1 (cat .env)", ".env"],
  ]) {
    const outcome = check(tool, command);
    assert.deepEqual([outcome.action, outcome.location], ["block", location], command);
  }
  // A reader's words as Guard always read them are checked as well as those with the words past a redirection, since a
  // quote opened before the redirection and closed after it joins words the shell keeps apart.
  for (const [tool, command, location] of [
    ["Bash", "cat x'1 \"' .env 2>&1 '\"'", ".env"],
    ["Bash", 'cat a"b \'" .env 2>&1 "\'"', ".env"],
    ["Bash", "cat x'1 \"' .env >|log '\"'", ".env"],
    ["Bash", "cat x'1 \"' .env &>log '\"'", ".env"],
    ["Bash", "sudo cat x'1 \"' .env >&2 '\"'", ".env"],
    ["Bash", "cp a'b \"' .env out 2>&1 '\"'", ".env"],
    ["PowerShell", "Get-Content x'1 \"' .env 2>&1 '\"'", ".env"],
  ]) {
    const outcome = check(tool, command);
    assert.deepEqual([outcome.action, outcome.location], ["block", location], command);
  }
  // A copy's destination stays its destination with a redirection after it.
  for (const command of [
    "cp .env.example .env &>/dev/null",
    "cp -n .env.example .env &>/dev/null || true",
    "cp notes.txt id_rsa &>/dev/null",
  ]) {
    assert.equal(check("Bash", command).action, "allow", command);
  }
  // The words past a redirection end with the line, so the next line's words aren't the reader's.
  for (const [tool, command, cwd] of [
    ["Bash", "grep -rn TODO . 2>&1\ncd .. && ls", path.join(root, "src")],
    ["Bash", "cat > out.log 2>&1 <<'EOF'\nsee sub/.env\nEOF", root],
    ["Bash", "head -50 notes.txt 2>&1\necho done", root],
  ]) {
    assert.equal(check(tool, command, cwd).action, "allow", command);
  }
});

// The quote-aware reading on its own: an output redirection after a copy isn't its destination, unless a quote or
// escape makes it a word cp is given, and rg with its input redirected reads that input, not the working folder.
test("the quote-aware reading takes a copy's destination and rg's input past a redirection", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SAMPLE_TOKEN=\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  const check = quotedSeparatorShell(root, "new");
  for (const command of [
    "cp .env out &>/dev/null",
    "cp .env out 2> err.log",
    "cp notes.txt .env 2\\>x",
    "cp notes.txt .env '2>x'",
    "cp notes.txt .env 2'>'x",
    "cp notes.txt .env \\&>x",
    'cp notes.txt .env "1"<notes.txt',
    "cp notes.txt .env \\1<notes.txt",
    "rg --hidden SAMPLE_TOKEN < sub",
    "rg --hidden SAMPLE_TOKEN < src/main.rs; rg --hidden SAMPLE_TOKEN",
    "rg --hidden SAMPLE_TOKEN < src/main.rs sub",
  ]) {
    assert.equal(check(command, "Bash").action, "block", command);
  }
  for (const command of [
    "cp .env.example .env &>/dev/null",
    "cp .env.example .env 2>/dev/null",
    "cp .env.example .env > log 2>&1",
    "cp -n .env.example .env &>/dev/null || true",
    "cp .env.example .env <&3",
    "cp .env.example .env 0<&-",
    "rg --hidden SAMPLE_TOKEN < src/main.rs",
    "rg --hidden SAMPLE_TOKEN 0<src/main.rs",
    "rg --hidden SAMPLE_TOKEN <<< x",
    "rg --hidden SAMPLE_TOKEN <<EOF\nx\nEOF",
  ]) {
    assert.equal(check(command, "Bash").action, "allow", command);
  }
  for (const command of ["copy .env.example .env 2>$null", "copy .env.example .env *>&1 | Out-Null"]) {
    assert.equal(check(command, "PowerShell").action, "allow", command);
  }
});

// ripgrep reads its input in place of the working folder only when that input is a file or a pipe: not a device, not
// a folder, and not when the redirection is to some other stream than its input.
test("rg reads the working folder unless its input is redirected from a file", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  for (const reading of [undefined, "new"]) {
    const check = quotedSeparatorShell(root, reading);
    for (const command of [
      "rg --hidden SAMPLE_TOKEN < /dev/null",
      "rg --hidden SAMPLE_TOKEN </dev/null",
      "rg --hidden SAMPLE_TOKEN < /dev/stdin",
      "rg --hidden SAMPLE_TOKEN < NUL",
      "rg --hidden SAMPLE_TOKEN < nul",
      "rg --hidden SAMPLE_TOKEN < CON",
      "rg --hidden SAMPLE_TOKEN < sub",
      "rg --hidden SAMPLE_TOKEN < src/main.rs < /dev/null",
      "rg --hidden SAMPLE_TOKEN 2< src/main.rs",
      "rg --hidden SAMPLE_TOKEN 1<src/main.rs",
      "rg --hidden SAMPLE_TOKEN 9< src/main.rs",
      "rg --hidden SAMPLE_TOKEN {fd}< src/main.rs",
      "rg --hidden SAMPLE_TOKEN 3<<EOF\nx\nEOF",
      "rg --hidden SAMPLE_TOKEN 3<<< x",
      'rg --hidden SAMPLE_TOKEN < "$F"',
      "rg --hidden SAMPLE_TOKEN < ~/in.txt",
      "rg --hidden SAMPLE_TOKEN < src/*.rs",
      // A device written another way, and a path with nothing at it now, which an earlier command may make a folder.
      "rg --hidden SAMPLE_TOKEN < /./dev/null",
      "rg --hidden SAMPLE_TOKEN < ///dev/null",
      "rg --hidden SAMPLE_TOKEN < /usr/../dev/null",
      "rg --hidden SAMPLE_TOKEN < ../../../../../../../../../../../../dev/null",
      "rg --hidden SAMPLE_TOKEN < /./proc/self/fd/0",
      "mkdir d; rg --hidden SAMPLE_TOKEN < d",
      "mkdir d && rg --hidden SAMPLE_TOKEN < d",
      "ln -s . d; rg --hidden SAMPLE_TOKEN < d",
      "rg --hidden SAMPLE_TOKEN < in.txt",
      // Its input copied from another stream, or closed.
      "rg --hidden SAMPLE_TOKEN 3<sub < src/main.rs <&3",
      "rg --hidden SAMPLE_TOKEN 3<sub 0<&3",
      "rg --hidden SAMPLE_TOKEN 3</dev/null <&3",
      "rg --hidden SAMPLE_TOKEN <&-",
      "rg --hidden SAMPLE_TOKEN 0<&-",
      "rg --hidden SAMPLE_TOKEN <& 3",
      // Its input closed or sent elsewhere after the file, as a stream 0 output redirection does.
      "rg --hidden SAMPLE_TOKEN <src/main.rs 0>&-",
      "rg --hidden SAMPLE_TOKEN < src/main.rs 0>/dev/null",
      "rg --hidden SAMPLE_TOKEN < src/main.rs 0>>log",
      "rg --hidden SAMPLE_TOKEN < src/main.rs 0>|log",
      "rg --hidden SAMPLE_TOKEN <<<hi 0>&-",
      // A command before rg's may move the working folder or make the file a folder, and a shell run by the command
      // may run after one; rg's input is taken as a file only in the command's first command, or after an echo piped in.
      "rm src/main.rs; mkdir src/main.rs; rg --hidden SAMPLE_TOKEN < src/main.rs",
      "cd .. && rg --hidden SAMPLE_TOKEN < src/main.rs",
      "pushd sub; rg --hidden SAMPLE_TOKEN < src/main.rs",
      "true; rg --hidden SAMPLE_TOKEN < src/main.rs",
      "true\nrg --hidden SAMPLE_TOKEN < src/main.rs",
      "mkdir x | rg --hidden SAMPLE_TOKEN < src/main.rs",
      "echo x; rg --hidden SAMPLE_TOKEN < src/main.rs",
      "bash -c 'rg --hidden SAMPLE_TOKEN < src/main.rs'",
      // Piped into, but its input redirected or closed after the pipe, which wins over it.
      "echo | rg --hidden SAMPLE_TOKEN 2>/dev/null </dev/null",
      "git log | rg --hidden SAMPLE_TOKEN 2>/dev/null <&-",
      "echo | rg --hidden SAMPLE_TOKEN >out.txt < /dev/null",
      "echo | rg --hidden SAMPLE_TOKEN 2>/dev/null 0>&-",
      "echo |& rg --hidden SAMPLE_TOKEN 2>&1 </dev/null",
      // Its input read for the patterns (`-f -`), which leaves the working folder to search.
      "rg --hidden -f - < src/main.rs",
      "rg --hidden -f- < src/main.rs",
      "rg --hidden --file=- < src/main.rs",
      "rg --hidden --file - < src/main.rs",
      "rg --hidden -e x -f - < src/main.rs",
      "echo SAMPLE_TOKEN | rg --hidden -f - 2>/dev/null",
      // Piped into a group or compound command whose input is then redirected, which wins over the pipe.
      "echo x | { rg --hidden SAMPLE_TOKEN; } </dev/null",
      "echo x | { rg --hidden SAMPLE_TOKEN; } <&-",
      "echo x | { rg --hidden SAMPLE_TOKEN; } 0>&-",
      ": | { rg --hidden SAMPLE_TOKEN; } < /dev/null",
      "echo x | if rg --hidden SAMPLE_TOKEN; then :; fi </dev/null",
      "echo x | while rg --hidden SAMPLE_TOKEN; do :; done </dev/null",
      "echo x | until rg --hidden SAMPLE_TOKEN; do :; done </dev/null",
      // Stream 0 written with more than one digit.
      "echo x | rg --hidden SAMPLE_TOKEN 00>&-",
      "echo x | rg --hidden SAMPLE_TOKEN 000>/dev/null",
      "rg --hidden SAMPLE_TOKEN < src/main.rs 00>&-",
      // A redirection whose target alone is quoted or escaped is still one.
      'git log | rg --hidden SAMPLE_TOKEN 0>"/dev/null"',
      "git log | rg --hidden SAMPLE_TOKEN 0>'/dev/null'",
      "git log | rg --hidden SAMPLE_TOKEN 0>/dev/nul\\l",
      "git log | rg --hidden SAMPLE_TOKEN 0>&'-'",
      'rg --hidden SAMPLE_TOKEN < src/main.rs 0>"/dev/null"',
      'echo | rg --hidden SAMPLE_TOKEN 2>"/dev/null" </dev/null',
      "echo | rg --hidden SAMPLE_TOKEN 2>'/dev/null' <&-",
    ]) {
      assert.equal(check(command, "Bash").action, "block", `${reading} ${command}`);
    }
    for (const command of [
      "rg --hidden SAMPLE_TOKEN < NUL",
      "rg --hidden SAMPLE_TOKEN < NUL:",
      "rg --hidden SAMPLE_TOKEN < con.txt",
      "echo x | rg --hidden SAMPLE_TOKEN 2>nul <nul",
      "echo x | if rg --hidden SAMPLE_TOKEN; then :; fi </dev/null",
      ". rg --hidden SAMPLE_TOKEN",
    ]) {
      assert.equal(check(command, "Cursor").action, "block", `${reading} Cursor ${command}`);
    }
    // PowerShell's `.` runs the command after it.
    for (const command of [
      'cmd /c "echo x | rg --hidden SAMPLE_TOKEN 2>nul <nul"',
      ". rg --hidden SAMPLE_TOKEN",
      ". 'rg' --hidden SAMPLE_TOKEN",
      ". . rg --hidden SAMPLE_TOKEN",
      ". grep -r SAMPLE_TOKEN",
    ]) {
      assert.equal(check(command, "PowerShell").action, "block", `${reading} PowerShell ${command}`);
    }
    assert.equal(check(". rg --hidden SAMPLE_TOKEN src", "PowerShell").action, "allow", `${reading} PowerShell . rg`);
    for (const command of [
      "rg --hidden SAMPLE_TOKEN < src/main.rs",
      "rg --hidden SAMPLE_TOKEN 0< src/main.rs",
      "rg --hidden SAMPLE_TOKEN <> src/main.rs",
      "rg --hidden SAMPLE_TOKEN 2<&1 < src/main.rs",
      "rg --hidden SAMPLE_TOKEN <<< x",
      "rg --hidden SAMPLE_TOKEN <<EOF\nx\nEOF",
      "rg --hidden SAMPLE_TOKEN < src/main.rs < src/main.rs",
      "echo x | rg --hidden SAMPLE_TOKEN 2>/dev/null",
      "echo x | rg --hidden SAMPLE_TOKEN 2>/dev/null < src/main.rs",
      'echo x | rg --hidden SAMPLE_TOKEN 2>"/dev/null"',
      // A quoted or escaped redirection is a word, here a path rg reads in place of the working folder.
      'echo x | rg --hidden SAMPLE_TOKEN "0">x',
      "echo x | rg --hidden SAMPLE_TOKEN 0\\>x",
    ]) {
      assert.equal(check(command, "Bash").action, "allow", `${reading} ${command}`);
    }
  }
});

// The shell opens rg's input through a link, so `..` after a link to a folder goes up from where it points.
test(
  "rg's input path goes up from where a link points",
  { skip: process.platform === "win32" && "`..` is undone by name on Windows" },
  (t) => {
    const root = tempDir(t);
    const other = tempDir(t);
    fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
    fs.writeFileSync(path.join(root, "f.txt"), "notes\n");
    fs.mkdirSync(path.join(other, "sub"));
    fs.mkdirSync(path.join(other, "f.txt"));
    fs.symlinkSync(path.join(other, "sub"), path.join(root, "link"));
    for (const reading of [undefined, "new"]) {
      const check = quotedSeparatorShell(root, reading);
      const command = "rg --hidden SAMPLE_TOKEN < link/../f.txt";
      assert.equal(check(command, "Bash").action, "block", `${reading} ${command}`);
      assert.equal(check("rg --hidden SAMPLE_TOKEN < f.txt", "Bash").action, "allow", `${reading} f.txt`);
    }
  },
);

// cmd's own rules: no `&>`, a `^` before a blank or `,` `;` `=` still splits, a `(` among the arguments is text,
// `if` and `for` run a command after their condition, `type.env` is `type` given `.env`, and `copy` joins files
// given with `+`. Bash ends a here-document at its marker with `$'…'` and `$"…"` taken off; PowerShell runs a name a
// group gives; rg takes the last `--max-depth` given.
test("cmd, here-document and call forms read as their shells read them", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  for (const reading of [undefined, "new"]) {
    const check = quotedSeparatorShell(root, reading);
    for (const [command, tool] of [
      ['cmd /c "echo hi &>y type .env"', "PowerShell"],
      ['cmd //c "echo hi &>y2 type .env"', "Bash"],
      ['cmd /c "findstr . a^|b x^ .env"', "PowerShell"],
      ['cmd //c "findstr . a^|b x^ .env"', "Bash"],
      ["findstr . a^|b x^ .env", "Cursor"],
      ['cmd /c "type a^&b x^,.env"', "PowerShell"],
      ['cmd /c "type a^&b x^;.env"', "PowerShell"],
      ['cmd /c "type a^&b x^=.env"', "PowerShell"],
      ['cmd /c "type a^&b ( .env )"', "PowerShell"],
      ['cmd //c "type a^&b ( .env )"', "Bash"],
      ["type a^&b ( .env )", "Cursor"],
      ['cmd /c "if 1==1 type .env"', "PowerShell"],
      ['cmd /c "if /i a==a findstr . .env"', "PowerShell"],
      ['cmd /c "if errorlevel 0 type .env"', "PowerShell"],
      ['cmd /c "if 1==1 more .env"', "PowerShell"],
      ['cmd //c "for %i in (x) do type .env"', "Bash"],
      ['cmd /c "if 1==1 cmd /c type .env"', "PowerShell"],
      ["cmd //c type.env", "Bash"],
      ["cmd //c copy.env out.txt", "Bash"],
      ["cmd //c copy a.txt+.env out.txt", "Bash"],
      ["cmd /c copy a.txt+.env out.txt", "PowerShell"],
      ["cat <<$'X'\nhi\nX\nif true; then cat \"a|b\" .env; fi", "Bash"],
      ['cat <<$"X"\nhi\nX\n! cat "a|b" .env', "Bash"],
      ['cat <<$(x)\nhi\n$(x)\nif true; then cat "a|b" .env; fi', "Bash"],
      ["& ('cat') .env", "PowerShell"],
      ["&('gc') .env", "PowerShell"],
      [". ('gc') .env", "PowerShell"],
      ["rg --hidden -d 0 -d 9 SAMPLE_TOKEN", "Bash"],
      ["rg --hidden --max-depth=0 --max-depth=9 SAMPLE_TOKEN", "Bash"],
      ["rg --hidden -d 0 -d 9 SAMPLE_TOKEN", "PowerShell"],
      // A here-document marker Guard may read otherwise than Bash, or never finds: its lines are read as commands too.
      ["true <<$'\\x41'\nA\n'cat' .env", "Bash"],
      ['true <<$(a ")" b)\n$(a ")" b)\n\'cat\' .env', "Bash"],
      ["true <<${x y}\n${x y}\n'cat' .env", "Bash"],
      ["true <<\"a\\$b\"\na$b\n'cat' .env", "Bash"],
      ["true <<`a b`\n`a b`\nx=1 cat .env", "Bash"],
      // copy's switches glued to a file, and `for /f`'s files and command text.
      ['cmd /c "copy .env/y out1.txt"', "PowerShell"],
      ['cmd /c "copy a.txt+.env/b out1.txt"', "PowerShell"],
      ["copy .env/y out1.txt ^", "Cursor"],
      ['cmd /c "for /f "delims=" %i in (.env) do echo %i"', "PowerShell"],
      ['cmd //c "for /f %i in (.env) do echo %i"', "Bash"],
      ["for /f %i in (.env) do echo %i ^", "Cursor"],
      ["cmd /c \"for /f %i in ('type .env') do echo %i\"", "PowerShell"],
      ['cmd /c "for /f %i in ( a.txt .env ) do echo %i"', "PowerShell"],
      // `if` glued to its condition, and `@` before a command.
      ['cmd /c "if(1)==(1) type .env"', "PowerShell"],
      ["if(1)==(1) type .env ^", "Cursor"],
      ['cmd /c "for %i in (x) do @type .env"', "PowerShell"],
      ['cmd /c "if 1==1 @type .env"', "PowerShell"],
      ['cmd /c "@type .env"', "PowerShell"],
      ['cmd /c "for /f %i in (x) do (type .env)"', "PowerShell"],
      // A PowerShell group too deep in a command's name stops it, as one in a reader's words does.
      ["& (((('gc')))) .env", "PowerShell"],
      // A here-document marker cut by a character Bash doesn't split on, and a line break inside `$(` or a backtick.
      ["true <<EOF\u00a0X\nEOF\u00a0X\n'cat' .env\nEOF", "Bash"],
      ["true <<EOF\fX\nEOF\fX\n'cat' .env\nEOF", "Bash"],
      ["true <<EOF\rX\nEOF\rX\nx=1 cat .env\nEOF", "Bash"],
      ["true <<EOF $(\n'cat' .env >&2\n)\nbody\nEOF", "Bash"],
      ["true <<EOF `\n\\cat .env >&2\n`\nbody\nEOF", "Bash"],
      // A `for /f` set wherever its `for` is, and one glued to `do`.
      ['cmd /c "if 1==1 for /f %i in (.env) do @echo %i"', "PowerShell"],
      ['cmd /c "for %a in (x) do for /f %i in (.env) do @echo %i"', "PowerShell"],
      ['cmd /c "if 1==2 (echo no) else for /f %i in (.env) do @echo %i"', "PowerShell"],
      ['cmd /c "if 1==1 cmd /c for /f %i in (.env) do @echo %i"', "PowerShell"],
      ['cmd /c "if 1==1 (for /f %i in (.env) do echo %i)"', "PowerShell"],
      ['cmd /c "for /f %i in (.env)do @echo %i"', "PowerShell"],
      ['cmd //c "for /f %i in (.env)do @echo %i"', "Bash"],
      ["for /f %i in (.env)do echo %i ^", "Cursor"],
      ["cmd /c \"for /f %i in ('type .env')do @echo %i\"", "PowerShell"],
      ['cmd /c "for %i in (x)do(type .env)"', "PowerShell"],
      // cmd's glued `type.` and `copy/` after `@`, `if` or `for`.
      ['cmd /c "@type.env"', "PowerShell"],
      ['cmd /c "@copy/b .env out.txt"', "PowerShell"],
      ['cmd /c "if 1==1 type.env"', "PowerShell"],
      ['cmd /c "for %i in (x) do @type.env"', "PowerShell"],
      ['cmd /c "if 1==1 copy/b .env out.txt"', "PowerShell"],
      // A `for` set ends at its first `)`; a `for` among the arguments opens no set.
      ["cmd /c 'for %i in ((a) do (@type .env)'", "PowerShell"],
      ["cmd /c 'for /f %i in ((a) do (@type .env)'", "PowerShell"],
      ["for %i in ((a) do (@type .env) ^& echo", "Cursor"],
      ["cmd /c 'if 1==2 (for %i in ((a) do echo) else (@type .env)'", "PowerShell"],
      ["cmd /c 'if 1==2 (echo for in (x) else type .env'", "PowerShell"],
      ["cmd /c 'if 1==2 (echo for in (x) else (@type .env)'", "PowerShell"],
      ['cmd /c "if 1==1 (echo a)else(type .env)"', "PowerShell"],
      // A `do` inside a `for /f` command text.
      ["cmd /c 'for /f %i in (''findstr /v do .env'') do @echo %i'", "PowerShell"],
      ["cmd /c \"for /f %i in ('type do .env') do @echo %i\"", "PowerShell"],
      // Bash starts a here-document's lines at a line break inside a subshell.
      ["cat <<EOF; ( true\nEOF\n)\nc''at .env\nEOF", "Bash"],
      ["cat <<EOF; (\nEOF\ntrue)\nc''at .env\nEOF", "Bash"],
      // A reserved word after a compound command with no `;`, a case pattern's command, and a name only a substitution
      // makes.
      ["if (true) then cat .env; fi", "Bash"],
      ["if [[ -f .env ]] then cat .env; fi", "Bash"],
      ["if ((1)) then cat .env; fi", "Bash"],
      ["if { true; } then cat .env; fi", "Bash"],
      ["until (true) do cat .env; done", "Bash"],
      ["case x in (x) cat .env;; esac", "Bash"],
      ["$(true) cat .env", "Bash"],
      ["`true` cat .env", "Bash"],
      // `]]` and `}` among a reader's words, where they're plain words.
      ["cat 'a;b' } do .env", "Bash"],
      ["cat 'a|b' ]] then .env", "Bash"],
      ["grep -h x 'a|b' } do .env", "Bash"],
      ["while [[ -f x ]] do cat .env; done", "Bash"],
    ]) {
      assert.equal(check(command, tool).action, "block", `${reading} ${tool} ${command}`);
    }
    for (const [command, tool] of [
      ['cmd /c "if 1==1 type notes.txt"', "PowerShell"],
      ['cmd //c "for %i in (x) do type notes.txt"', "Bash"],
      ["cmd /c copy a.txt+notes.txt out.txt", "PowerShell"],
      ["cat <<$'X'\nhi\nX\ncat notes.txt", "Bash"],
      ["& ('cat') notes.txt", "PowerShell"],
      ["rg --hidden -d 9 -d 0 SAMPLE_TOKEN", "Bash"],
      ['cmd /c "for /f %i in (notes.txt) do echo %i"', "PowerShell"],
      ['cmd /c "for %i in (x) do @type notes.txt"', "PowerShell"],
      ['cmd /c "for /f %i in (x) do (type notes.txt)"', "PowerShell"],
      ['cmd /c "for %i in (*.txt) do echo %i"', "PowerShell"],
      ["cat <<'EOF'\nhello\nEOF\ncat notes.txt", "Bash"],
      ["cat <<\\EOF\nhello\nEOF\ncat notes.txt", "Bash"],
      ["cmd /c \"for /f %i in ('git rev-parse HEAD') do @echo %i\"", "PowerShell"],
      ['cmd /c "for /f %i in (notes.txt)do @echo %i"', "PowerShell"],
      ['cmd /c "if 1==1 (for /f %i in (notes.txt) do echo %i)"', "PowerShell"],
      ['cmd /c "for %i in (x)do(type notes.txt)"', "PowerShell"],
      ['cmd /c "@copy/b notes.txt out.txt"', "PowerShell"],
      ["cat <<EOF $(\necho hi\n)\nhello\nEOF\ncat notes.txt", "Bash"],
      ["cmd /c 'if 1==2 (echo for in (x)) else type notes.txt'", "PowerShell"],
      ['cmd /c "if exist notes.txt (type notes.txt) else (echo none)"', "PowerShell"],
      ["if (true) then cat notes.txt; fi", "Bash"],
      ["(cd src && ls) > out.txt", "Bash"],
      ["echo $(date) notes.txt", "Bash"],
    ]) {
      assert.equal(check(command, tool).action, "allow", `${reading} ${tool} ${command}`);
    }
  }
});

// cmd's `for /f` runs the command text in its set: a search there walks the folder as it would on its own.
test("cmd's for /f command text is read as a command", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  for (const reading of [undefined, "new"]) {
    const check = quotedSeparatorShell(root, reading);
    for (const [command, tool] of [
      ['cmd /c "for /f "delims=" %i in (\'findstr /s SAMPLE *.*\') do @echo %i"', "PowerShell"],
      ['cmd /c "for /f "delims=" %i in (\'rg --hidden SAMPLE_TOKEN\') do @echo %i"', "PowerShell"],
      ['cmd //c "for /f "delims=" %i in (\'rg --hidden SAMPLE_TOKEN\') do @echo %i"', "Bash"],
      ["cmd /c \"for /f %i in ('type sub\\.env') do @echo %i\"", "PowerShell"],
    ]) {
      assert.equal(check(command, tool).action, "block", `${reading} ${tool} ${command}`);
    }
    for (const [command, tool] of [
      ["cmd /c \"for /f %i in ('findstr SAMPLE notes.txt') do @echo %i\"", "PowerShell"],
      ["cmd /c \"for /f %i in ('type notes.txt') do @echo %i\"", "PowerShell"],
    ]) {
      assert.equal(check(command, tool).action, "allow", `${reading} ${tool} ${command}`);
    }
  }
});

// cmd takes one digit after `<&` or `>&` as the handle and the rest of the word as an argument of its own.
test("cmd reads a name glued to a handle copy as a word", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  for (const reading of [undefined, "new"]) {
    const check = quotedSeparatorShell(root, reading);
    for (const [command, tool] of [
      ['cmd /c "type <&1.env"', "Bash"],
      ["cmd /c 'type <&1.env'", "PowerShell"],
      ['cmd /c "findstr SAMPLE <&1.env"', "Bash"],
      ['cmd /c "copy <&1.env out.txt"', "Bash"],
      ['cmd /c "type >&2.env"', "Bash"],
      ["type <&1.env ^& echo", "Cursor"],
      ["type >&2.env", "Cursor"],
    ]) {
      const outcome = check(command, tool);
      assert.deepEqual([outcome.action, outcome.location], ["block", ".env"], `${reading} ${tool} ${command}`);
    }
    for (const [command, tool] of [
      ['cmd /c "type notes.txt 2>&1"', "Bash"],
      ["type notes.txt 2>&1", "Cursor"],
    ]) {
      assert.equal(check(command, tool).action, "allow", `${reading} ${tool} ${command}`);
    }
  }
});

// A PowerShell group's words stand where the group does however deep it's nested, so `gc ((('.env')))` with one more
// pair of brackets is read too.
test("a PowerShell reader's file in groups nested deep is still read", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  for (const reading of [undefined, "new"]) {
    const check = quotedSeparatorShell(root, reading);
    for (const command of [
      "gc ((('.env')))",
      "gc (((('.env'))))",
      "type ((((('.env')))))",
      "Get-Content -Path (((('.env'))))",
      "gc $($($($('.env'))))",
      "gc @(@(@(@('.env'))))",
      "gc ((((.env))))",
      "gc ((((('notes.txt', '.env')))))",
    ]) {
      assert.equal(check(command, "PowerShell").action, "block", `${reading} ${command}`);
    }
    // Past three groups, a reader's words aren't all kept, so one naming no secret file is stopped as too much to check.
    const deep = check("gc (((('notes.txt'))))", "PowerShell");
    assert.deepEqual([deep.action, deep.location], ["block", "too many paths to check"], `${reading} deep`);
    for (const command of ["Write-Host ((((1 + 2) * 3) - 4) / 5)", "$x = [math]::Round(((((1 + 2) / 3) * 4)), 2)"]) {
      assert.equal(check(command, "PowerShell").action, "allow", `${reading} ${command}`);
    }
  }
});

test("the words past a reader's redirection are read once however many readers follow it", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE_TOKEN=placeholder\n");
  const check = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  // `2>&cat` sends a stream to a file named cat, so every `cat` after the first is a word of the first, and the words
  // past its redirections run to the end of the line. Read again for each `cat`, they'd cost the square of the line's
  // length. The regular expression tests and the text tokenised are counted here, for a line twice as long.
  const regexTest = RegExp.prototype.test;
  const stringMatch = String.prototype.match;
  let work = 0;
  const measure = (command) => {
    work = 0;
    RegExp.prototype.test = function (...args) {
      work += 1;
      return regexTest.apply(this, args);
    };
    String.prototype.match = function (...args) {
      work += this.length;
      return stringMatch.apply(this, args);
    };
    let outcome;
    try {
      outcome = check(command);
    } finally {
      RegExp.prototype.test = regexTest;
      String.prototype.match = stringMatch;
    }
    assert.deepEqual([outcome.action, outcome.location], ["block", ".env"], command.slice(0, 40));
    return work;
  };
  for (const unit of ["cat x 2>&", "cat x >|", "grep -r x >&"]) {
    const line = (count) => `${"cat notes.txt 2>&".concat(unit.repeat(count))}cat\ncat .env`;
    const once = measure(line(1000));
    const twice = measure(line(2000));
    assert.ok(twice < once * 3, `${unit}: ${once} for a thousand, ${twice} for two thousand`);
  }
});

test("the walk for rg skips the folders Git ignores, unless something rg reads could take them back", (t) => {
  const above = tempDir(t);
  const root = path.join(above, "proj");
  fs.mkdirSync(root);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "target/\n");
  for (let folder = 0; folder < 4; folder += 1) {
    const dir = path.join(root, "target", "debug", `deps${folder}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 100; index += 1) fs.writeFileSync(path.join(dir, `lib${index}.rlib`), "x\n");
  }
  fs.writeFileSync(path.join(root, "target", "debug", "server.key"), "placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  const shell = (command) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, searchWalkMaxEntries: 300, searchWalkMaxMs: 600_000, shellCheckMaxMs: 600_000 },
    );
  for (const command of ["rg main", "rg -n main .", "rg --hidden main", "rg -g '!*.md' main"]) {
    assert.equal(shell(command).action, "allow", command);
  }
  // Readers that do read it still walk it all.
  for (const command of [
    "grep -rn main .",
    "rg -u main",
    "rg --no-ignore-vcs main",
    "rg -g '*.rs' main",
    "rg main target",
  ]) {
    assert.equal(shell(command).action, "block", command);
  }
  // An `.ignore` file, which rg reads and Git doesn't, can take the folder back, here or in a folder above.
  fs.writeFileSync(path.join(root, ".ignore"), "!target/\n");
  assert.equal(shell("rg main").action, "block", "root .ignore");
  fs.rmSync(path.join(root, ".ignore"));
  fs.mkdirSync(path.join(root, "pkg", "target"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", ".rgignore"), "!target/\n");
  fs.writeFileSync(path.join(root, "pkg", "target", "server.key"), "placeholder\n");
  // Its folder is walked, so rg's own listing finds the file there; ripgrep's rules worked out without rg take Git's
  // word for it (a known gap), so the walk is what's checked.
  const realReaddir = fs.readdirSync;
  const read = [];
  fs.readdirSync = function readdirSync(folder, ...rest) {
    read.push(path.relative(root, String(folder)).replace(/\\/g, "/"));
    return realReaddir.call(this, folder, ...rest);
  };
  t.after(() => {
    fs.readdirSync = realReaddir;
  });
  for (const command of ["rg main", "rg main pkg"]) {
    read.length = 0;
    const outcome = shell(command);
    assert.ok(read.includes("pkg/target"), `${command}: ${read.join(", ")}`);
    assert.ok(!read.includes("target/debug"), `${command}: ${read.join(", ")}`);
    if (RIPGREP_ON_PATH) assert.equal(outcome.location, "pkg/target/server.key", command);
  }
  fs.readdirSync = realReaddir;
  fs.rmSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(above, ".ignore"), "!target/\n");
  assert.equal(shell("rg main").action, "block", "parent .ignore");
});

// The default budget covers a tree bigger than the 8,192 entries the walk once stopped at; counted, not timed.
test("the walk's default budget reads a tree of more than 8,192 entries in full", (t) => {
  const root = tempDir(t);
  for (let folder = 0; folder < 83; folder += 1) {
    const dir = path.join(root, "src", `m${String(folder).padStart(2, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 99; index += 1) fs.writeFileSync(path.join(dir, `f${index}.js`), "x\n");
  }
  const shell = (command) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, searchWalkMaxMs: 600_000, shellOperandMaxMs: 600_000, shellCheckMaxMs: 600_000 },
    );
  assert.equal(shell("grep -rn SAMPLE src").action, "allow");
  // The walk reads the last-listed folder first, so the secret file goes in the first one, read last.
  fs.writeFileSync(path.join(root, "src", "m00", ".env"), "SAMPLE=placeholder\n");
  assert.equal(shell("grep -rn SAMPLE src").location, "src/m00/.env");
});

test("a recursive reader's glob that doesn't start with a star, or names folders, is expanded and walked", (t) => {
  const root = recursiveFixture(t);
  fs.mkdirSync(path.join(root, "nest", "inner"), { recursive: true });
  fs.writeFileSync(path.join(root, "nest", "inner", ".env"), "SAMPLE=placeholder\n");
  const shell = (command, options = {}) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root, ...options });
  for (const [command, location] of [
    ["grep -r SAMPLE ke*", "keys/credentials.json"],
    ["grep -r SAMPLE ./ke*", "keys/credentials.json"],
    ["cp -r ke?s out", "keys/credentials.json"],
    ["diff -r ke[y]s /tmp/x", "keys/credentials.json"],
    ["rg -uu SAMPLE sv*", "svc/.env"],
    ["grep -r SAMPLE */", /^(?:keys\/credentials\.json|svc\/\.env|nest\/inner\/\.env)$/],
    ["grep -r SAMPLE n*/in*", "nest/inner/.env"],
    ["grep -r SAMPLE */inner", "nest/inner/.env"],
    ["grep -r SAMPLE ne*/", "nest/inner/.env"],
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    if (typeof location === "string") assert.equal(outcome.location, location, command);
    else assert.match(outcome.location, location, command);
  }
  for (const command of [
    "grep -r SAMPLE do*",
    "grep -r SAMPLE */notes*",
    "grep -r SAMPLE x*",
    "grep -r SAMPLE n*/x*",
    "rg SAMPLE sv*",
    "cp -r do* out",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
  // Past the walk's budget such a glob is stopped: its folders couldn't be walked.
  assert.equal(shell("grep -r SAMPLE ke*", { searchWalkMaxEntries: 1 }).location, FOLDER_TOO_BIG);
  assert.equal(shell("grep -r SAMPLE .e*", { searchWalkMaxEntries: 1 }).action, "block");
  // A glob that could name a secret file still stops the reader, even with nothing there for it to match.
  assert.equal(shell("grep -r SAMPLE .e*").action, "block");
  // After a `cd`, Guard can't tell which folder the glob is expanded in.
  assert.equal(shell("cd docs && grep -r SAMPLE ke*").action, "allow");
});

// Counted, not timed: a limit of 3 seconds failed on a busy machine, yet neither bug below took a second here. The
// check looks at its clock once per folder entry a glob is matched against and at each step for an operand, so its
// clock reads count its steps; its time limits are lifted so that only the counts can stop it. Without each operand's
// verdict kept, the repeated glob made 25,223 lookups instead of 1,207 (and the command was stopped); without the
// folder entries spent from the shared budget, the distinct globs read the clock 4 million times instead of 340,000.
test("many broad shell globs in one command are checked in a bounded number of steps", (t) => {
  const root = tempDir(t);
  for (let index = 0; index < 400; index += 1) fs.writeFileSync(path.join(root, `f${index}.txt`), "x\n");
  const distinct = Array.from({ length: 5000 }, (_, index) => `*x${index}`).join(" ");
  // The same glob over and over, which judging a glob by name alone used to stop at the first.
  const repeated = "* ".repeat(100_000);
  const roomy = { shellOperandMaxMs: 600_000, shellCheckMaxMs: 600_000, searchWalkMaxMs: 600_000 };
  for (const [name, globs, maxLookups, maxSteps] of [
    ["5,000 different globs", distinct, 5000 + 100, 5000 * 100],
    ["one glob 100,000 times", repeated, 2000, 2000],
  ]) {
    let steps = 0;
    const { result, lookups } = countingLookups(() => {
      const now = Date.now;
      Date.now = () => (steps++, now());
      try {
        return guard.inspectShell(
          "claude",
          { tool_name: "Bash", tool_input: { command: `cat ${globs}`, cwd: root } },
          { cwd: root, ...roomy },
        );
      } finally {
        Date.now = now;
      }
    });
    assert.equal(result.action, "allow", name);
    assert.ok(lookups <= maxLookups, `${name}: ${lookups} lookups`);
    assert.ok(steps <= maxSteps, `${name}: ${steps} clock reads`);
  }
});

// The commands below name thousands of operands for each reader, in two shapes: all different (none of them on disk),
// and one folder over and over. A megabyte of them is timed under load outside npm test; here the path check's own
// limits are counted, not timed.
const MANY_OPERAND_READERS = [
  ["cp -r", (operands) => `cp -r ${operands}out`],
  ["rg", (operands) => `rg SAMPLE ${operands}`],
  ["grep -r", (operands) => `grep -r SAMPLE ${operands}`],
  ["diff -r", (operands) => `diff -r ${operands}`],
  ["cp", (operands) => `cp ${operands}out`],
  ["cat", (operands) => `cat ${operands}`],
  ["findstr /s", (operands) => `findstr /s SAMPLE ${operands}`, "PowerShell"],
];

function distinctOperands(length) {
  let operands = "";
  for (let index = 0; operands.length < length; index += 1) operands += `a${index} `;
  return operands;
}

// Runs `fn` with forty folders that aren't there at the front of PATH, so finding Git costs more lookups than any
// real PATH would (npm test adds about a dozen), on every computer.
function withLongPath(fn) {
  const original = process.env.PATH;
  process.env.PATH = [
    ...Array.from({ length: 40 }, (_, index) => path.join(os.tmpdir(), `clotr-no-such-folder-${index}`)),
    original,
  ].join(path.delimiter);
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

test("a reader's operands make no more disk lookups than the shell check's budget allows", (t) => {
  const root = recursiveFixture(t);
  const dataDir = tempDir(t);
  const distinct = distinctOperands(40_000);
  const repeated = "docs ".repeat(8000);
  // Only the lookup count may stop the lookups here, not the clock.
  const roomy = { shellOperandMaxMs: 600_000, shellCheckMaxMs: 600_000, searchWalkMaxMs: 600_000 };
  const shell = (command, toolName, options) =>
    guard.inspectShell(
      "claude",
      { tool_name: toolName, tool_input: { command, cwd: root } },
      { cwd: root, dataDir, ...roomy, ...options },
    );
  // Finding Git for the .clotrignore check looks in each PATH folder until it's found, so a long PATH (npm test adds
  // about a dozen) costs lookups too, and the budget covers them. It's looked for once a check, not once an operand.
  // Past the budget an operand costs one quick lookup to show nothing is there (one that's there stops the command), so
  // the lookups past it are one lstat an operand at most; the check's deadline bounds those.
  const operandCount = distinct.trim().split(" ").length;
  for (const [name, form, toolName = "Bash"] of MANY_OPERAND_READERS) {
    for (const budget of [200, 800]) {
      const { result, lookups, byName } = countingLookups(() =>
        withLongPath(() => shell(form(distinct), toolName, { shellOperandMaxLookups: budget })),
      );
      assert.equal(result.action, "allow", `${name} with ${budget} lookups`);
      const others = lookups - (byName.lstatSync || 0);
      assert.ok(others <= budget + 20, `${name} made ${others} lookups other than lstat on a budget of ${budget}`);
      assert.ok(lookups <= budget + 20 + operandCount, `${name} made ${lookups} lookups on a budget of ${budget}`);
      // A secret file named after more operands than the check looks up on disk is still stopped, by its name.
      const secret = shell(form(`${distinct}svc/.env `), toolName, { shellOperandMaxLookups: budget });
      assert.equal(secret.action, "block", `${name} then a secret file`);
      assert.equal(secret.location, "svc/.env", `${name} then a secret file`);
    }
    // The same folder named eight thousand times is looked up and walked once: no more lookups than naming it once.
    // Both checks find Git on the same PATH, so its lookups (up to two a folder until Git, which npm test's longer PATH
    // puts further in) are the same in each and drop out of the difference.
    const once = countingLookups(() => shell(form("docs "), toolName, {}));
    assert.equal(once.result.action, "allow", `${name} with one folder once`);
    const { result, lookups } = countingLookups(() => shell(form(repeated), toolName, {}));
    assert.equal(result.action, "allow", `${name} with one folder over and over`);
    assert.ok(
      lookups <= once.lookups + 5,
      `${name} made ${lookups} lookups for one folder over and over, ${once.lookups} for it once`,
    );
  }
});

test("a shell check that runs out of time stops the command, after no more lookups than its time allows", (t) => {
  const root = recursiveFixture(t);
  const dataDir = tempDir(t);
  const distinct = distinctOperands(40_000);
  // The check's clock starts once Git is found for the .clotrignore (its lookups come out of the lookup budget, not
  // the time), so those lookups, however many PATH folders cost, are counted apart: a check with no time at all makes
  // them and then stops. A long PATH makes sure they're there to count.
  const checkFor = (toolName, command, shellCheckMaxMs) =>
    countingLookups(
      () =>
        withLongPath(() =>
          guard.inspectShell(
            "claude",
            { tool_name: toolName, tool_input: { command, cwd: root } },
            { cwd: root, dataDir, shellCheckMaxMs, shellOperandMaxMs: 600_000, searchWalkMaxMs: 600_000 },
          ),
        ),
      { tick: true },
    );
  for (const [name, form, toolName = "Bash"] of MANY_OPERAND_READERS) {
    const findingGit = checkFor(toolName, form(distinct), 0);
    assert.equal(findingGit.result.location, "too many paths to check", `${name} with no time`);
    assert.ok(findingGit.lookups >= 40, `${name} made ${findingGit.lookups} lookups finding Git on a long PATH`);
    // Each lookup costs a millisecond on the made-up clock, so 300 ms of checking is at most 300 lookups.
    const { result, lookups } = checkFor(toolName, form(distinct), 300);
    assert.equal(result.action, "block", name);
    assert.equal(result.location, "too many paths to check", name);
    const checking = lookups - findingGit.lookups;
    assert.ok(checking <= 310, `${name} made ${checking} lookups in 300 ms, after ${findingGit.lookups} finding Git`);
  }
});

test("a hundred kilobytes of operands goes through the hook well inside its timeout", (t) => {
  const root = recursiveFixture(t);
  const dataDir = tempDir(t);
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const distinct = distinctOperands(100_000);
  for (const [name, form, toolName = "Bash"] of MANY_OPERAND_READERS) {
    const event = { tool_name: toolName, tool_input: { command: form(distinct), cwd: root } };
    const started = Date.now();
    const child = spawnSync(process.execPath, [script, "shell", "claude"], {
      input: JSON.stringify(event),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: dataDir },
    });
    const elapsed = Date.now() - started;
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stdout, /block|deny/i, name);
    // About half a second on an idle computer; the hook's own timeout is fifteen.
    assert.ok(elapsed < 10_000, `${name} took ${elapsed} ms`);
  }
});

test("the whole shell check has a deadline, and a content check that can't finish by it stops the command", (t) => {
  const root = recursiveFixture(t);
  const dataDir = tempDir(t);
  const shell = (command, options = {}) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, dataDir, ...options },
    );
  const unfinished = (outcome, label) => {
    assert.equal(outcome.action, "block", label);
    assert.equal(outcome.location, "a check that didn't finish", label);
    const output = guard.boundaryOutput("claude", outcome, "shell");
    assert.match(JSON.stringify(output), /check didn't finish in time/, label);
  };
  // A hook that started long ago has no time left for any of it.
  unfinished(shell("echo hello", { startedAt: Date.now() - 60_000 }), "no time left");
  unfinished(shell("cat docs/notes.txt", { startedAt: Date.now() - 60_000 }), "no time left for a reader");
  assert.equal(shell("echo hello").action, "allow");

  // Four megabytes take the content check several seconds; a long text is checked where it can be stopped at the
  // deadline, so the hook answers on time instead of running into its own timeout, which would let the command through.
  let words = "";
  for (let index = 0; words.length < 4_000_000; index += 1) words += `w${index.toString(36)}q `;
  const started = Date.now();
  unfinished(shell(`echo ${words}`, { hookCheckMaxMs: 1500 }), "four megabytes");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6000, `the check stopped after ${elapsed} ms`);

  // Checked that way, a long text gets the same findings as one checked on the spot.
  const command = `echo ${"x".repeat(300_000)} && echo ${PASSWORD_LINE}`;
  const onTheSpot = guard.inspectPrompt("claude", command, { dataDir, cwd: root });
  const outcome = shell(command, { hookCheckMaxMs: 60_000 });
  assert.equal(outcome.action, "block");
  assert.ok(outcome.findings?.length, "the password is found");
  assert.deepEqual(
    outcome.findings.map(({ kind, masked }) => [kind, masked]),
    onTheSpot.findings.map(({ kind, masked }) => [kind, masked]),
  );
});

// Runs `fn` on a made-up clock that moves a millisecond each time anything looks at it, and counts the looks, so a
// deadline is reached after a known amount of checking, however fast or busy the computer is.
function lookingAtTheClock(fn) {
  const realNow = Date.now;
  const start = realNow();
  let looks = 0;
  Date.now = () => {
    looks += 1;
    return start + looks;
  };
  try {
    const result = fn();
    return { result, looks };
  } finally {
    Date.now = realNow;
  }
}

test("the path check stops at the whole check's deadline when that comes before its own", (t) => {
  const root = recursiveFixture(t);
  const dataDir = tempDir(t);
  const distinct = distinctOperands(40_000);
  for (const [name, form, toolName = "Bash"] of MANY_OPERAND_READERS) {
    // The path check alone could run ten minutes; the whole check has 300 ms, a lookup a millisecond.
    const { result, lookups } = countingLookups(
      () =>
        guard.inspectShell(
          "claude",
          { tool_name: toolName, tool_input: { command: form(distinct), cwd: root } },
          {
            cwd: root,
            dataDir,
            hookCheckMaxMs: 300,
            shellCheckMaxMs: 600_000,
            shellOperandMaxMs: 600_000,
            searchWalkMaxMs: 600_000,
          },
        ),
      { tick: true },
    );
    assert.equal(result.action, "block", name);
    assert.equal(result.location, "a check that didn't finish", name);
    assert.ok(lookups <= 310, `${name} made ${lookups} lookups in 300 ms`);
  }
});

test("the deadline is looked at between the secret names a glob is tried against", (t) => {
  const root = tempDir(t);
  const dataDir = tempDir(t);
  // After a `cd` a glob is judged by the secret names it could match: `.e?v` matches the first, .env, and
  // `private.tfstate.b?ckup` only the last, so judging the second takes about sixty more looks at the clock.
  const shell = (glob, shellCheckMaxMs = 600_000) =>
    lookingAtTheClock(() =>
      guard.inspectShell(
        "claude",
        { tool_name: "Bash", tool_input: { command: `cd . && cat ${glob}`, cwd: root } },
        { cwd: root, dataDir, shellCheckMaxMs, shellOperandMaxMs: 600_000, searchWalkMaxMs: 600_000 },
      ),
    );
  const early = shell(".e?v");
  const late = shell("private.tfstate.b?ckup");
  assert.equal(early.result.location, ".e?v");
  assert.equal(late.result.location, "private.tfstate.b?ckup");
  assert.ok(late.looks >= early.looks + 30, `${early.looks} looks for the first name, ${late.looks} for the last`);
  // With only as much time as the first takes, the second runs out partway through the names.
  assert.equal(shell(".e?v", early.looks).result.location, ".e?v");
  const stopped = shell("private.tfstate.b?ckup", early.looks);
  assert.equal(stopped.result.action, "block");
  assert.equal(stopped.result.location, "too many paths to check");
  assert.ok(stopped.looks <= early.looks + 5, `${stopped.looks} looks with ${early.looks} ms to spend`);
});

test("the deadline is looked at between the folder entries a glob is matched against", (t) => {
  const root = tempDir(t);
  const dataDir = tempDir(t);
  for (let index = 0; index < 1500; index += 1) fs.writeFileSync(path.join(root, `f${index}.txt`), "x\n");
  const shell = (shellCheckMaxMs) =>
    lookingAtTheClock(() =>
      guard.inspectShell(
        "claude",
        { tool_name: "Bash", tool_input: { command: "cat *q*", cwd: root } },
        { cwd: root, dataDir, shellCheckMaxMs, shellOperandMaxMs: 600_000, searchWalkMaxMs: 600_000 },
      ),
    );
  const all = shell(600_000);
  assert.equal(all.result.action, "allow");
  assert.ok(all.looks >= 1500, `${all.looks} looks for 1,500 entries`);
  // Time for a tenth of the entries: the check stops there, and looks at the clock only a few more times.
  const budget = Math.round(all.looks / 10);
  const stopped = shell(budget);
  assert.equal(stopped.result.action, "block");
  assert.equal(stopped.result.location, "too many paths to check");
  assert.ok(stopped.looks <= budget + 10, `${stopped.looks} looks with ${budget} ms to spend`);
});

// Starts the real shell hook with its worker thread swapped for one that fails the way a worker can: `before` wakes
// the hook without an answer and then throws (Node stops a worker out of memory the same way, without an answer),
// and `after` throws just after it answers. Either error reaches the hook only after it has answered: stopping the
// worker waits until it has thrown.
function hookWithFailingWorker(t, mode, command, root) {
  const dir = tempDir(t);
  const preload = path.join(dir, "failing-worker.js");
  fs.writeFileSync(
    preload,
    `const threads = require("worker_threads");
    const Real = threads.Worker;
    const fail = 'Atomics.store(require("worker_threads").workerData.thrown, 0, 1); throw new Error("worker failed");';
    threads.Worker = class extends Real {
      constructor(source, options) {
        const thrown = new Int32Array(new SharedArrayBuffer(4));
        const wake = 'const { done } = require("worker_threads").workerData; Atomics.store(done, 0, 1); Atomics.notify(done, 0);';
        super(${JSON.stringify(mode)} === "before" ? wake + fail : source + ";" + fail, {
          ...options,
          workerData: { ...options.workerData, thrown },
        });
        this.thrown = thrown;
      }
      terminate() {
        Atomics.wait(this.thrown, 0, 0, 5000);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        return super.terminate();
      }
    };`,
  );
  return spawnSync(
    process.execPath,
    ["--require", preload, path.join(GUARD_DIR, "bin", "clotr-guard.js"), "shell", "claude"],
    {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command, cwd: root } }),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "data") },
    },
  );
}

test("a worker thread that fails can't crash the shell hook into letting the command through", (t) => {
  const root = recursiveFixture(t);
  const long = `echo ${"lorem ipsum ".repeat(10_000)}`;
  // A worker that fails before it answers: the check didn't finish, so the command is stopped, and the hook still
  // exits 0, which is how the assistant reads its answer at all; any other code is read as a hook that failed.
  const before = hookWithFailingWorker(t, "before", long, root);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /"permissionDecision":"deny"/);
  assert.match(before.stdout, /check didn't finish in time/);
  // One that fails after it answers leaves its answer standing, a secret found (the person is asked) or not.
  const after = hookWithFailingWorker(t, "after", `${long} && echo ${PASSWORD_LINE}`, root);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /"permissionDecision":"ask".*Password/);
  const clean = hookWithFailingWorker(t, "after", long, root);
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /deny|ask/);
});

test("a worker thread's error after the shell check has answered is heard, not thrown again", async (t) => {
  const root = recursiveFixture(t);
  const threads = require("worker_threads");
  const Real = threads.Worker;
  let failing;
  // Wakes the check without an answer, then throws; stopping it waits until it has.
  threads.Worker = class extends Real {
    constructor(_source, options) {
      const thrown = new Int32Array(new SharedArrayBuffer(4));
      super(
        'const { done, thrown } = require("worker_threads").workerData; Atomics.store(done, 0, 1); Atomics.notify(done, 0); Atomics.store(thrown, 0, 1); throw new Error("worker failed");',
        { ...options, workerData: { ...options.workerData, thrown } },
      );
      this.thrown = thrown;
      failing = this;
    }
    terminate() {
      Atomics.wait(this.thrown, 0, 0, 5000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      return super.terminate();
    }
  };
  let outcome;
  try {
    outcome = guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command: `echo ${"lorem ipsum ".repeat(10_000)}`, cwd: root } },
      { cwd: root, dataDir: tempDir(t) },
    );
  } finally {
    threads.Worker = Real;
  }
  assert.equal(outcome.action, "block");
  assert.equal(outcome.location, "a check that didn't finish");
  // Its error arrives before it exits; one nothing listened for would fail this test as an uncaught exception.
  await new Promise((resolve) => failing.on("exit", resolve));
});

test("an error nothing catches ends a hook with the answer a failed check gives, and exit code 0", (t) => {
  const root = recursiveFixture(t);
  const dir = tempDir(t);
  // Thrown once the hook has started and before it has read the event, so before it has any answer.
  const preload = path.join(dir, "crash.js");
  fs.writeFileSync(preload, 'process.nextTick(() => { throw new Error("crash"); });\n');
  const hook = (args, event) =>
    spawnSync(process.execPath, ["--require", preload, path.join(GUARD_DIR, "bin", "clotr-guard.js"), ...args], {
      input: JSON.stringify(event),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "data") },
    });
  // The shell hook stops the command, as for a check that hit an internal error.
  const shell = hook(["shell", "claude"], { tool_name: "Bash", tool_input: { command: "echo hello", cwd: root } });
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /"permissionDecision":"deny".*check hit an internal error/);
  // The prompt hook stops the prompt, and the read hook asks in Claude Code, as their own failed checks do.
  const prompt = hook(["hook", "claude"], { prompt: "hello", cwd: root });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /"decision":"block".*hit an error and couldn't check this prompt, so it was stopped/);
  const read = hook(["read", "claude"], { tool_name: "Read", tool_input: { file_path: path.join(root, "app.js") } });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /"permissionDecision":"ask".*hit an error and couldn't check/);
});

// A fresh copy of Guard whose helper `name` from the lib module `lib` throws, as an internal error would. Every other
// cached Guard module is dropped before the reload, so callers that moved out of the bin pick up the swap too, and the
// cache is put back exactly as it was afterwards, since other tests hold the modules loaded earlier.
// The shell check is its own file's, since the bin loads that only when a check first runs, after the
// cache is back.
function guardWithThrowing(lib, name) {
  const libPath = require.resolve(path.join(GUARD_DIR, "lib", lib));
  const guardPath = require.resolve(path.join(GUARD_DIR, "bin", "clotr-guard.js"));
  const shellCheckPath = require.resolve(path.join(GUARD_DIR, "lib", "shell-checks", "shell-check.js"));
  const inGuard = (key) => key.startsWith(GUARD_DIR + path.sep) && key !== libPath;
  const real = require(libPath);
  const dropped = new Map(
    Object.keys(require.cache)
      .filter(inGuard)
      .map((key) => [key, require.cache[key]]),
  );
  require.cache[libPath].exports = {
    ...real,
    [name]: () => {
      throw new Error(`injected ${name} failure`);
    },
  };
  for (const key of dropped.keys()) delete require.cache[key];
  try {
    return { ...require(guardPath), inspectShell: require(shellCheckPath).inspectShell };
  } finally {
    require.cache[libPath].exports = real;
    for (const key of Object.keys(require.cache).filter(inGuard)) delete require.cache[key];
    for (const [key, entry] of dropped) require.cache[key] = entry;
  }
}

test("an internal error the shell check catches stops the command and says why", (t) => {
  const root = recursiveFixture(t);
  const dataDir = tempDir(t);
  const event = { tool_name: "Bash", tool_input: { command: "cat app.js", cwd: root } };
  // One in the path check (a secret-file name lookup) and one in the content check (the engine).
  for (const [lib, name] of [
    ["secret-files.js", "isSecretFile"],
    ["text-checks/engine-loader.js", "check"],
  ]) {
    const broken = guardWithThrowing(lib, name);
    const outcome = broken.inspectShell("claude", event, { cwd: root, dataDir });
    assert.equal(outcome.action, "block", name);
    assert.equal(outcome.location, "a check that hit an internal error", name);
    assert.ok(!outcome.internalError, name);
    for (const tool of ["claude", "cursor"]) {
      const output = broken.boundaryOutput(tool, outcome, "shell");
      assert.match(output.stdout, /deny/, `${name} ${tool}`);
      assert.match(output.stdout, /check hit an internal error/, `${name} ${tool}`);
      assert.doesNotMatch(output.stdout, /went through/, `${name} ${tool}`);
    }
  }
  // The real hook, its engine throwing: it answers, exits 0 so the assistant reads the answer, and stops the command.
  const preload = path.join(dataDir, "throwing-engine.js");
  fs.writeFileSync(
    preload,
    `require(${JSON.stringify(path.join(GUARD_DIR, "lib", "text-checks", "engine-loader.js"))}).check = () => { throw new Error("injected"); };\n`,
  );
  const run = (mode, input) =>
    spawnSync(process.execPath, ["--require", preload, path.join(GUARD_DIR, "bin", "clotr-guard.js"), mode, "claude"], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: dataDir },
    });
  const shell = run("shell", event);
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /"permissionDecision":"deny".*check hit an internal error/);
  // The prompt hook stops the prompt too, and says how to fix it.
  const prompt = run("hook", { prompt: "hello", cwd: root });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /"decision":"block".*hit an error and couldn't check this prompt, so it was stopped/);
});

// Runs the real hook without waiting on it, so the slow cases run side by side. `preload` is loaded first in the hook
// and in its check's process; `checker` is code only the check's process runs (it's started with -e, the hook isn't).
// `input` undefined, or `keepOpen`, leaves stdin open. A hook still running after `killAfter` is stopped, status null.
// `elapsed` counts from the call; `fromHookStart` counts from the hook process's own start, the time its deadline
// counts from, so it leaves out how long the system took to start the process. `timers`: see recordLongTimers.
function hookRun(
  args,
  input,
  {
    preload = "",
    checker = "",
    flags = [],
    env = {},
    cwd,
    keepOpen = false,
    killAfter = 25_000,
    dataDir,
    recordTimers = false,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-hook-run-"));
  const file = path.join(dir, "preload.js");
  const origin = path.join(dir, "origin");
  const timers = path.join(dir, "timers.json");
  fs.writeFileSync(
    file,
    `${preload}\n${recordTimers ? recordLongTimers(timers) : ""}\nif (typeof process._eval === "string") {\n${checker}\n} else {\n` +
      `require("fs").writeFileSync(${JSON.stringify(origin)}, String(performance.timeOrigin));\n}\n`,
  );
  const started = Date.now();
  const child = require("child_process").spawn(
    process.execPath,
    [...flags, "--require", file, path.join(GUARD_DIR, "bin", "clotr-guard.js"), ...args],
    {
      cwd,
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: dataDir || path.join(dir, "data"), ...env },
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  if (input !== undefined) child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
  if (input !== undefined && !keepOpen) child.stdin.end();
  const killer = setTimeout(() => child.kill("SIGKILL"), killAfter);
  return new Promise((resolve) => {
    child.on("close", (status) => {
      const ended = Date.now();
      clearTimeout(killer);
      const fromHookStart = fs.existsSync(origin) ? ended - Number(fs.readFileSync(origin, "utf8")) : NaN;
      const recorded = readLongTimers(timers);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ status, stdout, stderr, elapsed: ended - started, fromHookStart, timers: recorded });
    });
  });
}

const STUCK_NAME = "clotr-stuck-here.txt";
// Holds up the check where it looks at STUCK_NAME, whichever way it looks and in whichever process: busy, or blocked in
// a call to the system, as a lookup on a drive that doesn't answer is. That one is a process run to its end, which
// stopping a worker thread can't interrupt (Atomics.wait it can), so only a check the hook can kill passes.
function stuckAt(how) {
  const hold =
    how === "busy"
      ? "for (;;) {}"
      : 'require("child_process").execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true });';
  return `const fs = require("fs");
  for (const name of ["lstatSync", "statSync", "realpathSync", "existsSync", "readdirSync", "openSync", "readFileSync", "accessSync"]) {
    const real = fs[name];
    if (typeof real !== "function") continue;
    fs[name] = function (target, ...rest) {
      if (String(target).includes(${JSON.stringify(STUCK_NAME)})) { ${hold} }
      return real.call(this, target, ...rest);
    };
    if (real.native) fs[name].native = real.native;
  }`;
}

const UNFINISHED = /check didn't finish in time/;
const FAILED = /check hit an internal error/;

test("the shell hook stops a command whose check is held up past its deadline, by the deadline", async (t) => {
  const root = recursiveFixture(t);
  fs.writeFileSync(path.join(root, STUCK_NAME), "x\n");
  const bash = { tool_name: "Bash", tool_input: { command: `cat ${STUCK_NAME}`, cwd: root } };
  // Each check's process writes down its id, to see that it's gone once the hook has answered.
  const pids = tempDir(t);
  const stuck = (how, index) => ({
    preload: stuckAt(how),
    checker: `require("fs").writeFileSync(${JSON.stringify(path.join(pids, `${index}.pid`))}, String(process.pid));`,
  });
  const runs = await Promise.all([
    hookRun(["shell", "claude"], bash, stuck("busy", 0)),
    hookRun(["shell", "claude"], bash, stuck("blocked", 1)),
    // The event never ends: the hook can't read it, and answers at the deadline all the same.
    hookRun(["shell", "claude"], undefined),
    hookRun(["shell", "claude"], '{"tool_name":"Bash","tool_input":{"command":"echo', { keepOpen: true }),
    hookRun(["shell", "cursor"], { command: `cat ${STUCK_NAME}`, cwd: root }, stuck("blocked", 4)),
    hookRun(
      ["shell", "claude"],
      { tool_name: "PowerShell", tool_input: { command: `Get-Content ${STUCK_NAME}`, cwd: root } },
      stuck("busy", 5),
    ),
  ]);
  for (const [index, run] of runs.entries()) {
    const label = `run ${index}: ${run.fromHookStart} ms from the hook's start (${run.elapsed} ms from the call), ${run.stdout}${run.stderr}`;
    // Exit 0, so the assistant reads the answer, which stops the command and says why.
    assert.equal(run.status, 0, label);
    assert.match(run.stdout, index === 4 ? /"permission":"deny"/ : /"permissionDecision":"deny"/, label);
    assert.match(run.stdout, UNFINISHED, label);
    // Ten seconds from the hook's start, plus a little to stop the check and exit, well inside the 15-second timeout.
    assert.ok(run.fromHookStart >= 9_500 && run.fromHookStart < 11_000, label);
  }
  // The held-up checks were stopped, not left running. (On Windows a process's children end with it anyway; on other
  // systems only the hook's own stop ends them.)
  const written = fs.readdirSync(pids);
  assert.equal(written.length, 4, written.join(", "));
  for (const name of written) {
    const pid = Number(fs.readFileSync(path.join(pids, name), "utf8"));
    assert.ok(!stillRunning(pid), `the check in run ${name} is still running`);
  }
});

// Whether a process is still running. On Linux a killed process whose parent has exited is a zombie until the
// system's first process collects it, which in some containers takes a second or more; it runs nothing, so it's gone.
function stillRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z";
  } catch {
    return false;
  }
}

test("a check that can't start, crashes or answers wrongly stops the command and says so", async (t) => {
  const root = recursiveFixture(t);
  const bash = { tool_name: "Bash", tool_input: { command: "echo hello", cwd: root } };
  // The hook's deadline never comes here, so each answer is the failed check's own, given without waiting for it.
  const never = (options) => ({ ...options, preload: `${DEADLINE_PRELOAD.never}\n${options.preload || ""}` });
  const runs = await Promise.all([
    // It can't start: no unbounded check on the hook's own thread instead.
    hookRun(
      ["shell", "claude"],
      bash,
      never({
        preload: 'require("child_process").spawn = () => { throw new Error("EAGAIN"); };',
      }),
    ),
    hookRun(
      ["shell", "claude"],
      bash,
      never({
        preload: `const cp = require("child_process"); const real = cp.spawn;
      cp.spawn = (command, args, options) => real(${JSON.stringify(path.join(root, "no-such-node.exe"))}, args, options);`,
      }),
    ),
    // Out of file handles (EMFILE), Node hands back a process with no pipes.
    hookRun(
      ["shell", "claude"],
      bash,
      never({
        preload: `const { EventEmitter } = require("events");
      require("child_process").spawn = () => Object.assign(new EventEmitter(), {
        stdin: null, stdout: null, stderr: null, exitCode: null, signalCode: null, kill: () => false, unref() {},
      });`,
      }),
    ),
    // It crashes, exits without an answer, answers with something else, or runs out of memory.
    hookRun(["shell", "claude"], bash, never({ checker: 'throw new Error("checker failed");' })),
    hookRun(["shell", "claude"], bash, never({ checker: "process.exit(0);" })),
    hookRun(["shell", "claude"], bash, never({ checker: "process.exitCode = 3;" })),
    hookRun(["shell", "claude"], bash, never({ checker: 'process.stdout.write("garbage");' })),
    hookRun(
      ["shell", "claude"],
      bash,
      never({
        checker: `const guard = require(${JSON.stringify(path.join(GUARD_DIR, "bin", "clotr-guard.js"))});
      guard.shellCheckReply = () => ({ outcome: { action: "maybe" } });`,
      }),
    ),
    hookRun(
      ["shell", "claude"],
      bash,
      never({
        flags: ["--max-old-space-size=64"],
        checker: "const kept = []; for (;;) kept.push(new Array(100000).fill(kept.length));",
      }),
    ),
    hookRun(
      ["shell", "cursor"],
      { command: "echo hello", cwd: root },
      never({ checker: 'throw new Error("checker failed");' }),
    ),
  ]);
  for (const [index, run] of runs.entries()) {
    const label = `run ${index}: ${run.elapsed} ms, ${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, label);
    assert.match(run.stdout, index === runs.length - 1 ? /"permission":"deny"/ : /"permissionDecision":"deny"/, label);
    assert.match(run.stdout, FAILED, label);
    assert.ok(run.elapsed < 9_000, label);
  }
});

test("the check's process starts with Node options that once stopped it from starting", async (t) => {
  const root = recursiveFixture(t);
  const bash = { tool_name: "Bash", tool_input: { command: "echo hello", cwd: root } };
  const runs = await Promise.all([
    // Code given with -e would be read as a module, where `require` isn't defined.
    hookRun(["shell", "claude"], bash, { env: { NODE_OPTIONS: "--input-type=module" } }),
    // A debugger's port, the hook's own to use, written as two arguments or one.
    hookRun(["shell", "claude"], bash, { flags: ["--inspect-port", "9339"] }),
    hookRun(["shell", "claude"], bash, { flags: ["--inspect-port=9339"] }),
  ]);
  for (const [index, run] of runs.entries()) {
    const label = `run ${index}: ${run.elapsed} ms, ${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, label);
    assert.equal(run.stdout.trim(), "{}", label);
  }
});

test("the shell hook's answers are unchanged with its check in a process of its own", async (t) => {
  const root = recursiveFixture(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".clotrignore"), "value: placeholder-written-out\n");
  const run = (tool, event) => hookRun(["shell", tool], event, { cwd: root });
  const [clean, secretFile, finding, cursor, wrongTool, wrongEvent, tooLarge] = await Promise.all([
    run("claude", { tool_name: "Bash", tool_input: { command: "git status", cwd: root } }),
    run("claude", { tool_name: "Bash", tool_input: { command: "cat .env", cwd: root } }),
    run("claude", { tool_name: "Bash", tool_input: { command: `echo ${PASSWORD_LINE}`, cwd: root } }),
    run("cursor", { command: "cat .env", cwd: root }),
    run("gemini", { tool_name: "run_shell_command", tool_input: { command: "echo hello" } }),
    run("claude", { tool_name: "Read", tool_input: { file_path: "x" } }),
    run("claude", `{"tool_name":"Bash","tool_input":{"command":"echo ${"x".repeat(1_100_000)}"}}`),
  ]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), "{}");
  // A raw value in .clotrignore is still pointed out, once.
  assert.equal((clean.stderr.match(/Use clotr-guard ignore-value\./g) || []).length, 1, clean.stderr);
  assert.match(secretFile.stdout, /"permissionDecision":"deny".*secret file at \\".env\\"/);
  assert.equal(finding.status, 0, finding.stderr);
  assert.match(finding.stdout, /"permissionDecision":"ask".*Password/);
  assert.match(cursor.stdout, /"permission":"deny".*secret file/);
  for (const [name, result] of Object.entries({ wrongTool, wrongEvent, tooLarge })) {
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /deny/, name);
  }
});

// How each client is told to stop a command, and the words it shows: claude and codex read the answer only on exit 0,
// and exit 2 with the reason on stderr is windsurf's stop.
const STOPPED_BY = {
  claude: (answer) => answer.hookSpecificOutput?.permissionDecision === "deny",
  codex: (answer) => answer.hookSpecificOutput?.permissionDecision === "deny",
  cursor: (answer) => answer.permission === "deny",
  gemini: (answer) => answer.decision === "deny",
  cline: (answer) => answer.cancel === true,
  windsurf: null,
};

function assertStops(tool, { code, stdout = "", stderr = "" }, words, label) {
  assert.ok(Object.hasOwn(STOPPED_BY, tool), `${tool} has no stop format here`);
  if (STOPPED_BY[tool]) {
    assert.equal(code, 0, label);
    assert.ok(STOPPED_BY[tool](JSON.parse(stdout)), label);
    assert.match(stdout, words, label);
  } else {
    assert.equal(code, 2, label);
    assert.match(stderr, words, label);
  }
}

test("every client reads the shell hook's unfinished and failed answers as a stop", async (t) => {
  for (const tool of guard.IMPLEMENTED_TOOL_NAMES) {
    for (const [outcome, words] of [
      [guard.SHELL_UNFINISHED_OUTCOME, UNFINISHED],
      [guard.SHELL_FAILED_OUTCOME, FAILED],
    ]) {
      const output = guard.boundaryOutput(tool, outcome, "shell");
      assertStops(tool, output, words, `${tool}: ${JSON.stringify(output)}`);
    }
  }
  // Through the real hook: for each client an event that never ends, and for claude's Bash and PowerShell and for
  // cursor, a check that fails.
  const root = recursiveFixture(t);
  const failing = { checker: 'throw new Error("checker failed");' };
  const cases = [
    // The deadline comes at once here, and its length and the exit after it are checked; the test above waits for it
    // for real.
    ...guard.IMPLEMENTED_TOOL_NAMES.map((tool) => [
      tool,
      UNFINISHED,
      hookRun(["shell", tool], undefined, { cwd: root, preload: DEADLINE_PRELOAD.now, recordTimers: true }),
    ]),
    [
      "claude",
      FAILED,
      hookRun(["shell", "claude"], { tool_name: "Bash", tool_input: { command: "ls", cwd: root } }, failing),
    ],
    [
      "claude",
      FAILED,
      hookRun(["shell", "claude"], { tool_name: "PowerShell", tool_input: { command: "dir", cwd: root } }, failing),
    ],
    ["cursor", FAILED, hookRun(["shell", "cursor"], { command: "ls", cwd: root }, failing)],
  ];
  const runs = await Promise.all(cases.map(([, , run]) => run));
  for (const [index, run] of runs.entries()) {
    const [tool, words] = cases[index];
    const label = `${tool}: ${run.elapsed} ms, status ${run.status}, ${run.stdout}${run.stderr}`;
    assertStops(tool, { code: run.status, stdout: run.stdout, stderr: run.stderr }, words, label);
    // The failed runs use the real clock, so they're bounded by it: an answer on time that holds the hook open fails.
    if (words === UNFINISHED) assertDeadlineKept(run.timers, label, { ran: true });
    else assert.ok(run.elapsed < 11_000, label);
  }
});

test("a glob at the end of a 300,000-character path is judged through the real shell hook, well before the deadline", async (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const long = "a/".repeat(150_000);
  // Too long to look up, so it's judged by its name, which the `*` could make a secret file's (see the in-process test).
  const runs = await Promise.all([
    hookRun(["shell", "claude"], { tool_name: "Bash", tool_input: { command: `cat ${long}*; cat .env`, cwd: root } }),
    hookRun(["shell", "claude"], { tool_name: "PowerShell", tool_input: { command: `cat ${long}*`, cwd: root } }),
    hookRun(["shell", "cursor"], { command: `grep -r SAMPLE ${long}*`, cwd: root }),
    hookRun(["shell", "claude"], { tool_name: "Bash", tool_input: { command: `cat ${long}`, cwd: root } }),
  ]);
  for (const [index, run] of runs.entries()) {
    const label = `run ${index}: ${run.elapsed} ms, ${run.stdout.slice(0, 200)}${run.stderr}`;
    assert.equal(run.status, 0, label);
    if (index === 3) assert.doesNotMatch(run.stdout, /deny|ask/, label);
    else assert.match(run.stdout, /"(permissionDecision|permission)":"deny".*secret file/, label);
    assert.ok(run.elapsed < 6_000, label);
  }
});

bothRipgrepWays("rg searches an ignored folder it's named, and skips one it finds below", (t) => {
  const root = recursiveFixture(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "keys/\n");
  fs.mkdirSync(path.join(root, "nested", "keys"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", "keys", "credentials.json"), '{"user":"example"}\n');
  const shell = (command) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, ...RIPGREP_ROOM },
    );
  const grep = (folder) =>
    inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "SAMPLE", path: path.join(root, folder), output_mode: "content" } },
      { cwd: root },
    );
  // An ignore rule is never applied to the folder ripgrep is asked to search, only to what it finds inside.
  for (const [command, location] of [
    ["rg SAMPLE keys", "keys/credentials.json"],
    ["rg SAMPLE nested/keys", "nested/keys/credentials.json"],
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    assert.equal(outcome.location, location, command);
  }
  assert.equal(grep("keys").action, "block");
  assert.equal(grep("keys").location, "credentials.json");
  for (const command of ["rg SAMPLE", "rg SAMPLE .", "rg SAMPLE nested", "rg SAMPLE docs"]) {
    assert.equal(shell(command).action, "allow", command);
  }
  assert.equal(grep("nested").action, "allow");
});

bothRipgrepWays("rg's long unrestricted and partial no-ignore flags are read", (t) => {
  const root = recursiveFixture(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "keys/\n");
  const shell = (command) =>
    guard.inspectShell(
      "claude",
      { tool_name: "Bash", tool_input: { command, cwd: root } },
      { cwd: root, ...RIPGREP_ROOM },
    );
  for (const command of [
    "rg --unrestricted --unrestricted SAMPLE svc",
    "rg -u --unrestricted SAMPLE svc",
    "rg -uuu SAMPLE svc",
    "rg --unrestricted SAMPLE .",
    "rg --no-ignore-dot SAMPLE .",
    "rg --no-ignore-parent SAMPLE .",
    "rg --no-ignore-files SAMPLE .",
    "rg --no-ignore-vcs SAMPLE .",
    "rg --no-ignore-global SAMPLE .",
  ]) {
    const outcome = shell(command);
    assert.equal(outcome.action, "block", command);
    assert.match(outcome.location, /^(?:keys\/credentials\.json|svc\/\.env)$/, command);
  }
  for (const command of ["rg --unrestricted SAMPLE svc", "rg SAMPLE .", "rg -u SAMPLE docs"]) {
    assert.equal(shell(command).action, "allow", command);
  }
});

test(
  "what the real rg lists counts against the search's budget",
  { skip: RIPGREP_ON_PATH ? false : NO_RIPGREP },
  (t) => {
    const root = tempDir(t);
    initGit(root);
    fs.writeFileSync(path.join(root, ".gitignore"), "secrets.json\n");
    fs.mkdirSync(path.join(root, "a"));
    for (let index = 0; index < 300; index += 1) fs.writeFileSync(path.join(root, "a", `f${index}.txt`), "x\n");
    fs.writeFileSync(path.join(root, "a", "secrets.json"), '{"user":"example"}\n');
    fs.mkdirSync(path.join(root, "a", "sub"));
    fs.writeFileSync(path.join(root, "a", "sub", "secrets.json"), '{"user":"example"}\n');
    fs.writeFileSync(path.join(root, "a", "sub", "z.txt"), "x\n");
    // The walk reads about 300 entries, and rg lists about 300 files, once, to say both secrets.json files are ignored:
    // 800 covers that, 500 doesn't. A search that ran out is judged as one that couldn't finish: a broad glob by the
    // secret names it could match.
    const grep = (searchWalkMaxEntries) =>
      inspectRead(
        "claude",
        { tool_name: "Grep", tool_input: { pattern: "SAMPLE", path: path.join(root, "a"), output_mode: "content" } },
        { cwd: root, searchWalkMaxEntries, ...RIPGREP_ROOM },
      );
    assert.deepEqual(grep(800), { action: "allow" });
    assert.deepEqual(grep(500), { action: "allow", searchLimited: true });
    const shell = (searchWalkMaxEntries) =>
      guard.inspectShell(
        "claude",
        { tool_name: "Bash", tool_input: { command: "rg SAMPLE *", cwd: root } },
        { cwd: root, searchWalkMaxEntries, ...RIPGREP_ROOM },
      );
    // A shell check's rg listing isn't charged on top of its walk: every file rg lists is one the walk reads too, so
    // the walk's own count (about 305 here) bounds both.
    assert.equal(shell(800).action, "allow");
    assert.equal(shell(320).action, "allow");
    const outcome = shell(250);
    assert.equal(outcome.action, "block");
    assert.equal(outcome.location, "*");
  },
);

// rg lists what it can and exits 2 when a folder can't be opened; the rg the command runs can't open it either, unless
// it runs as another user.
test(
  "rg's walk takes rg's listing of a project with a folder this account can't open",
  { skip: RIPGREP_ON_PATH ? false : NO_RIPGREP },
  (t) => {
    const root = tempDir(t);
    initGit(root);
    fs.writeFileSync(path.join(root, ".gitignore"), "secrets.json\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.txt"), "x\n");
    fs.writeFileSync(path.join(root, "src", "secrets.json"), '{"user":"example"}\n');
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "b.txt"), "x\n");
    const user = process.env.USERNAME;
    const lock = () =>
      process.platform === "win32"
        ? spawnSync("icacls", [locked, "/deny", `${user}:(RX)`], { windowsHide: true }).status === 0
        : (fs.chmodSync(locked, 0), true);
    const unlock = () =>
      process.platform === "win32"
        ? spawnSync("icacls", [locked, "/remove:d", user], { windowsHide: true })
        : fs.chmodSync(locked, 0o755);
    if ((process.platform === "win32" && !user) || !lock()) {
      t.diagnostic("skipped: can't take this account's access to a folder away");
      return;
    }
    // Given back before the folder is removed.
    try {
      if (spawnSync("rg", ["--files"], { cwd: root, windowsHide: true }).status !== 2) {
        t.diagnostic("skipped: this account can still open the folder");
        return;
      }
      const shell = (command) =>
        guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
      assert.equal(shell("rg foo").action, "allow");
      assert.equal(shell("sudo rg foo").action, "block");
    } finally {
      unlock();
    }
  },
);

test("findstr's joined switches are read", (t) => {
  const root = recursiveFixture(t);
  const shell = (command, toolName = "PowerShell") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const command of [
    "findstr /s/i SAMPLE *",
    "findstr /i/s SAMPLE *.json",
    "findstr -s/i SAMPLE *",
    "findstr /s/c:SAMPLE *",
  ]) {
    const outcome = shell(command, "PowerShell");
    assert.equal(outcome.action, "block", command);
    assert.match(outcome.location, /^(?:keys\/credentials\.json|svc\/\.env)$/, command);
  }
  for (const command of ["findstr /i/n SAMPLE *", "findstr /s/i SAMPLE *.txt"]) {
    assert.equal(shell(command, "PowerShell").action, "allow", command);
  }
});

test("operands past the shell check's lookups stop the command unless nothing's there, and so does a check that can't finish", (t) => {
  const root = recursiveFixture(t);
  const shell = (command, options) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root, ...options });
  const spent = { shellOperandMaxLookups: 0 };
  for (const command of ["cat svc/.env", "grep -r SAMPLE *", "cp -r * out", "rg SAMPLE *", "findstr /s SAMPLE *"]) {
    assert.equal(shell(command, spent).action, "block", command);
  }
  // A folder that's there can't be judged by its name once the lookups are spent: it could be a link to anything.
  assert.equal(shell("grep -r SAMPLE keys", spent).location, "too many paths to check");
  assert.equal(shell("grep -r SAMPLE keys", {}).action, "block");
  // A path with nothing at it is still judged by its name.
  assert.equal(shell("cat no-such-file.txt", spent).action, "allow");
  const outcome = shell("cat docs/notes.txt", { shellCheckMaxMs: 0 });
  assert.equal(outcome.action, "block");
  assert.equal(outcome.location, "too many paths to check");
  assert.match(JSON.stringify(guard.readHookOutput("claude", outcome)), /more paths than it can check in time/);
});

// recursiveFixture, with links that have ordinary names: a junction (any Windows account can make one) or folder link
// to .kube, and, where this account may make one, a file link to svc/.env. The values are made up.
function linkedFixture(t) {
  const root = recursiveFixture(t);
  fs.mkdirSync(path.join(root, ".kube"));
  fs.writeFileSync(path.join(root, ".kube", "config"), "token: synthetic-not-real-123\n");
  fs.writeFileSync(path.join(root, "svc", ".env"), "DB_PASSWORD=synthetic-not-real-123\n");
  fs.symlinkSync(
    path.join(root, ".kube"),
    path.join(root, "kubedir"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let fileLink;
  try {
    fs.symlinkSync(path.join(root, "svc", ".env"), path.join(root, "notes-link.txt"), "file");
    fileLink = "notes-link.txt";
  } catch (error) {
    fileLink = { skip: `this account can't make a file link (${error.code})` };
  }
  let shortName = null;
  try {
    if (path.basename(fs.realpathSync.native(path.join(root, "svc", "ENV~1"))) === ".env") shortName = "svc/ENV~1";
  } catch {
    // No short names on this volume.
  }
  return { root, fileLink, shortName: shortName || { skip: "this volume doesn't make short names" } };
}

test("an operand past the shell check's lookups that's on disk stops the command, however the lookups ran out", (t) => {
  const { root, fileLink, shortName } = linkedFixture(t);
  const dataDir = tempDir(t);
  // Made-up names cost a lookup each and open nothing, so they use up a small lookup budget.
  const padding = distinctOperands(4000);
  const roomy = { shellOperandMaxMs: 600_000, shellCheckMaxMs: 600_000, searchWalkMaxMs: 600_000 };
  const shell = (command, options, toolName = "Bash") =>
    guard.inspectShell(
      "claude",
      { tool_name: toolName, tool_input: { command, cwd: root } },
      { cwd: root, dataDir, ...options },
    );
  for (const target of ["kubedir/config", fileLink, shortName]) {
    if (typeof target !== "string") {
      t.diagnostic(`skipped a case: ${target.skip}`);
      continue;
    }
    // Each is stopped by its real path while the lookups last.
    assert.equal(shell(`cat ${target}`, roomy).action, "block", target);
    // Padded until the lookup count runs out, or with the lookup window already over: never judged by its name.
    for (const [label, command, options] of [
      ["count", `cat ${padding}${target}`, { ...roomy, shellOperandMaxLookups: 50 }],
      ["time", `cat ${target}`, { ...roomy, shellOperandMaxMs: 0 }],
      ["redirect", `tr a b < ${target}`, { ...roomy, shellOperandMaxMs: 0 }],
      ["PowerShell", `Get-Content ${padding}${target}`, { ...roomy, shellOperandMaxLookups: 50 }, "PowerShell"],
    ]) {
      const outcome = shell(command, options, label === "PowerShell" ? "PowerShell" : "Bash");
      assert.equal(outcome.action, "block", `${target} (${label})`);
      assert.match(
        JSON.stringify(guard.readHookOutput("claude", outcome)),
        /more paths than it can check in time|could read a secret file/,
        `${target} (${label})`,
      );
    }
  }
  // Made-up names alone open nothing, and are judged by their names as before; a secret name is stopped by it.
  assert.equal(shell(`cat ${padding}`, { ...roomy, shellOperandMaxLookups: 50 }).action, "allow");
  const named = shell(`cat ${padding}svc/.env`, { ...roomy, shellOperandMaxLookups: 50 });
  assert.equal(named.location, "svc/.env");
});

test("a long reader command of ordinary files goes through", (t) => {
  const root = tempDir(t);
  const dataDir = tempDir(t);
  fs.mkdirSync(path.join(root, "src"));
  const files = Array.from({ length: 400 }, (_, index) => `src/file-${index}.js`);
  for (const file of files) fs.writeFileSync(path.join(root, file), "const value = 1;\n");
  fs.writeFileSync(path.join(root, ".env"), "DB_PASSWORD=synthetic-not-real-123\n");
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root, dataDir });
  const list = files.join(" ");
  for (const command of [
    `cat ${list}`,
    `grep -n value ${list}`,
    `head -n 5 ${list}`,
    `wc -l ${list} && cat src/file-1.js src/file-2.js`,
    `git add ${list}`,
    `git diff -- ${list}`,
    "npm run lint && npm test",
    "cat a b c",
  ]) {
    assert.equal(shell(command).action, "allow", command.slice(0, 40));
  }
  assert.equal(shell(`Get-Content ${list}`, "PowerShell").action, "allow");
  assert.equal(shell(`cat ${list} .env`).location, ".env");
});

test("a glob with many stars is matched against long file names quickly", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "a".repeat(40)), "x\n");
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a".repeat(200)), "x\n");
  // Matched with a regular expression, each star could take any part of the name, and twelve took minutes.
  const glob = `${"*a".repeat(12)}*b`;
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const [command, toolName] of [
    [`cat ${glob}; cat .env`, "Bash"],
    [`rg -g '${glob}' SAMPLE src; cat .env`, "Bash"],
    [`grep -r --include='${glob}' SAMPLE src; cat .env`, "Bash"],
    [`findstr /s SAMPLE ${glob}; type .env`, "PowerShell"],
  ]) {
    const started = Date.now();
    const outcome = shell(command, toolName);
    const elapsed = Date.now() - started;
    assert.equal(outcome.action, "block", command);
    assert.equal(outcome.location, ".env", command);
    assert.ok(elapsed < 3000, `${command.slice(0, 20)}... took ${elapsed} ms`);
  }
  const started = Date.now();
  const search = inspectRead("claude", {
    tool_name: "Grep",
    tool_input: { pattern: "SAMPLE", glob, path: path.join(root, "src"), output_mode: "content" },
  });
  const elapsed = Date.now() - started;
  assert.equal(search.action, "allow");
  assert.ok(elapsed < 3000, `the search took ${elapsed} ms`);
  // The same stars still match what they did.
  for (const command of ["cat *a*a*", "cat ?a*a", `cat ${"*a".repeat(12)}*`]) {
    assert.equal(shell(`${command}; cat .env`).location, ".env", command);
  }
  fs.writeFileSync(path.join(root, `${"a".repeat(40)}.pem`), "placeholder\n");
  // Globs whose own text names no secret file, so it's the match against the folder that stops them; the shell reads
  // `[...]` as a class.
  for (const pattern of ["*a*A*.P?M", "*a?p?m", `${"*a".repeat(12)}.p*`, "*{x,a}.p?m", "*[a].p[e]m", "*.p[!x]m"]) {
    const outcome = shell(`cat ${pattern}`);
    assert.equal(outcome.action, "block", pattern);
    assert.equal(outcome.location, pattern, pattern);
  }
  for (const pattern of [`${"*a".repeat(12)}.px*`, "*[b].p?m", "*.p[!e]m", "*[!m]"]) {
    assert.equal(shell(`cat ${pattern}`).action, "allow", pattern);
  }
});

test("a glob's [...] classes are read once per letter, and one too long to be written matches any letter", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  const shell = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root });
  // After a `cd` a glob is judged by the secret names it could match, which tries each class against every letter of
  // about sixty names, again and again. Two hundred globs of two classes, each of eighty ranges no name's letters fall
  // in, are each read once per letter: a class's ranges are tried with Array.prototype.some, counted here. Read on
  // every try it was 1.7 million; once per letter, about 64,000. (A megabyte of classes is timed in the load runs.)
  const ranges = Array.from(
    { length: 80 },
    (_, index) => `${String.fromCharCode(0xc0 + index)}-${String.fromCharCode(0xc0 + index)}`,
  ).join("");
  const globs = Array.from(
    { length: 200 },
    (_, index) => `*[${String.fromCharCode(0x400 + index)}${ranges}]*[${ranges}]*`,
  );
  const some = Array.prototype.some;
  let tries = 0;
  Array.prototype.some = function (...args) {
    tries += 1;
    return some.apply(this, args);
  };
  let outcome;
  try {
    outcome = shell(`cd . && cat ${globs.join(" ")}`);
  } finally {
    Array.prototype.some = some;
  }
  assert.equal(outcome.action, "allow");
  assert.ok(tries < 200 * 1000, `${tries} lookups for two hundred globs`);
  // A class longer than 256 characters matches any letter but a slash, as `?` does, so it's never read letter by
  // letter; it's read only where matching more is safe. A shorter one is read as written.
  assert.equal(shell(`cd . && cat .e[${"x".repeat(300)}]v`).action, "block");
  assert.equal(shell(`cd . && cat .e[${"x".repeat(200)}]v`).action, "allow");
  const long = `*[${"x".repeat(480_000)}]*[${"x".repeat(480_000)}]*`;
  assert.equal(shell(`cd . && cat ${long}`).location, long);
  // What the classes match is unchanged.
  for (const pattern of ["*.[e]nv", "*.e[!x]v", "*.[a-z]nv", "*.e[[:alpha:]]v", "*.E[N]V"]) {
    assert.equal(shell(`cd . && cat ${pattern}`).action, "block", pattern);
  }
  for (const pattern of ["*.[x]nv", "*.e[!n]v", "*.[0-9]nv", "*.e[[:digit:]]v"]) {
    assert.equal(shell(`cd . && cat ${pattern}`).action, "allow", pattern);
  }
});

test("a glob of only [...] classes, or one that starts with letters, is read as a glob", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "SAMPLE=placeholder\n");
  fs.mkdirSync(path.join(root, "cert"));
  fs.writeFileSync(path.join(root, "cert", "server.pem"), "placeholder\n");
  fs.writeFileSync(path.join(root, "cert", "server.txt"), "notes\n");
  fs.mkdirSync(path.join(root, "deep", "a", "b", "c", "d"), { recursive: true });
  fs.writeFileSync(path.join(root, "deep", "a", "b", "c", "d", "id_rsa"), "placeholder\n");
  const shell = (command, toolName = "Bash") =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  for (const [command, toolName] of [
    ["cat .e[n]v", "Bash"],
    ["cat .[!a]nv", "Bash"],
    ["Get-Content .[e]nv", "PowerShell"],
    ["cat deep/a/b/c/d/[i]d_rsa", "Bash"],
    ["cat cert/server.p?m", "Bash"],
    ["cat cert/serv*", "Bash"],
    ["cat cert/s[e]rver.pem", "Bash"],
  ]) {
    assert.equal(shell(command, toolName).action, "block", command);
  }
  for (const command of ["cat cert/server.t?t", "cat cert/serv*.txt", "cat cert/s[e]rver.txt", "cat cert/x*"]) {
    assert.equal(shell(command).action, "allow", command);
  }
  // A glob that could name a secret file is looked up in its folder too, so it's stopped only by a file it matches.
  assert.equal(shell("cat .e?v.local").action, "allow");
  assert.equal(shell("cat id_r?a").action, "allow");
  fs.writeFileSync(path.join(root, "id_rsa"), "placeholder\n");
  assert.equal(shell("cat id_r?a").action, "block");
});

test("personal details off leaves out every personal kind the engine reports, but not card or bank numbers", (t) => {
  const dir = tempDir(t);
  const mcp = require("../apps/guard/bin/clotr-mcp.js");
  const samples = {
    drivers_license: "My driver's license number is D1234567",
    insurance_id: "Insurance member ID: XJH123456789",
    medical_record: "MRN: 00123456",
    medicare_id: "Medicare number 1EG4-TE5-MK73",
    public_ip: "my ip is 203.0.113.77 and the site won't load",
  };
  for (const [kind, text] of Object.entries(samples)) {
    const on = guard.inspectPrompt("claude", text, { dataDir: dir, repeat: false, includePersonalDetails: true });
    assert.ok(
      on.findings?.some((finding) => finding.kind === kind),
      `${kind} is found with personal details on`,
    );
    const off = guard.inspectPrompt("claude", text, { dataDir: dir, repeat: false });
    assert.equal(off.action, "allow", `${kind} doesn't stop a prompt with personal details off`);
    assert.ok(
      !mcp.checkResult(text, false).findings.some((finding) => finding.kind === kind),
      `MCP leaves ${kind} out`,
    );
    assert.ok(
      mcp.checkResult(text, true).findings.some((finding) => finding.kind === kind),
      `MCP reports ${kind}`,
    );
  }
  const card = `Card ${["4111", "1111", "1111", "1111"].join(" ")} exp 12/30`;
  assert.equal(guard.inspectPrompt("claude", card, { dataDir: dir, repeat: false }).action, "block");
});

test("a content search of one ordinary file passes without a note about limits", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "app.js"), "const x = 1;\n");
  for (const target of [path.join(root, "app.js"), "app.js"]) {
    const outcome = inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "x", path: target, output_mode: "content" } },
      { cwd: root },
    );
    assert.deepEqual(outcome, { action: "allow" }, target);
    assert.equal(guard.readHookOutput("claude", outcome).stderr || "", "", target);
  }
  const gemini = inspectRead(
    "gemini",
    { tool_name: "grep_search", tool_input: { pattern: "x", dir_path: path.join(root, "app.js") } },
    { cwd: root },
  );
  assert.deepEqual(gemini, { action: "allow" });
});

test("the skill tells a check that let the action through from one that stopped it", () => {
  const skill = fs.readFileSync(path.join(GUARD_DIR, "skills", "clotr", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  const script = path.join(GUARD_DIR, "bin", "clotr-guard.js");
  const stopped = spawnSync(process.execPath, [script, "read", "claude"], { input: "{}", encoding: "utf8" });
  const stoppedReason = JSON.parse(stopped.stdout).hookSpecificOutput.permissionDecisionReason;
  const through = JSON.parse(
    guard.hookOutput("claude", { action: "allow", internalError: true, boundary: "shell" }).stdout,
  ).systemMessage;
  for (const message of [stoppedReason, through]) {
    const ending = /^Clotr couldn't check this \w+(, so it (?:was stopped|went through))/.exec(message);
    assert.ok(ending, message);
    assert.ok(skill.includes(ending[1]), `the skill explains "${ending[1]}"`);
  }
});

test("the MCP server never answers a notification, whatever state it's in", () => {
  const server = path.join(GUARD_DIR, "bin", "clotr-mcp.js");
  const run = (messages) => {
    const result = spawnSync(process.execPath, [server], {
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      encoding: "utf8",
    });
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  assert.deepEqual(run([{ jsonrpc: "2.0", method: "notifications/initialized" }]), [], "before initialize");
  const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
  const replies = run([
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: meta },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, _meta: { [Object.keys(meta._meta)[0]]: "1999-01-01" } },
    },
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.id),
    [1],
    "only the request is answered",
  );
});

test("both MCP entry points exit 2 when they can't print a configuration", () => {
  for (const entry of [
    path.join(GUARD_DIR, "bin", "clotr-mcp.js"),
    path.join(GUARD_DIR, "..", "mcp", "bin", "clotr-mcp.js"),
  ]) {
    const bad = spawnSync(process.execPath, [entry, "--print-config", "nonsense"], { encoding: "utf8" });
    assert.equal(bad.status, 2, entry);
    assert.match(bad.stderr, /^Choose claude/, entry);
    const good = spawnSync(process.execPath, [entry, "--print-config", "claude"], { encoding: "utf8" });
    assert.equal(good.status, 0, entry);
  }
});

test("the shell reader keeps where each word ends, so the word as written can be taken back", () => {
  // Each case: the dialect, the text, and its first command's words as written, as start-to-end slices.
  const cases = [
    ["bash", `cat 'a;b' x"y z"w notes.txt`, ["cat", `'a;b'`, `x"y z"w`, "notes.txt"]],
    ["bash", `cat "a b" $(echo a) \`pwd\` <(ls) x`, ["cat", `"a b"`, "$(echo a)", "`pwd`", "<(ls)", "x"]],
    ["bash", `cat "open $(a b`, ["cat", `"open $(a b`]],
    [
      "powershell",
      `gc 'a;b', "x;y" a"b"c (gc x) $(1) @(2)`,
      ["gc", `'a;b'`, `"x;y"`, `a"b"c`, "(gc x)", "$(1)", "@(2)"],
    ],
    ["powershell", `gc "a\`"b" 'it''s' x`, ["gc", '"a`"b"', `'it''s'`, "x"]],
    ["powershell", `x --% p "q r" s`, ["x", "p", `"q r"`, "s"]],
    ["cmd", `type "a&b" x^&y z`, ["type", `"a&b"`, "x^&y", "z"]],
  ];
  for (const [dialect, text, expected] of cases) {
    const { first } = guard.parseShellCommands(text, dialect, { left: 1e6 });
    assert.deepEqual(
      first.words.map((word) => text.slice(word.start, word.end)),
      expected,
      `${dialect}: ${text}`,
    );
  }
  // A group's values keep theirs too.
  const text = `gc ('a;b', "c")`;
  const { first } = guard.parseShellCommands(text, "powershell", { left: 1e6 });
  assert.deepEqual(
    first.words[1].values.map((word) => text.slice(word.start, word.end)),
    [`'a;b'`, `"c"`],
  );
});

// A file read through an add-on tool server, from any server and through each hook that sees one. The made-up
// `.env` holds no value: a secret file's name alone stops the read.
function toolReadRoot(t) {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "NAME=example\n");
  fs.writeFileSync(path.join(root, ".env.example"), "NAME=\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Notes\n");
  return root;
}

const toolCall = (root, tool, name, args) =>
  guard.inspectTool(tool, { tool_name: name, tool_input: args, cwd: root }, { cwd: root, dataDir: root }).action;
const geminiRead = (root, name, args) =>
  inspectRead("gemini", { tool_name: name, tool_input: args, cwd: root }, { cwd: root, dataDir: root }).action;

test("Claude's tool hook stops another server's get_file_contents on .env", (t) => {
  const root = toolReadRoot(t);
  assert.equal(toolCall(root, "claude", "mcp__other__get_file_contents", { path: ".env" }), "block");
});

test("Cursor's tool hook stops read_file on .env", (t) => {
  const root = toolReadRoot(t);
  assert.equal(toolCall(root, "cursor", "read_file", JSON.stringify({ path: ".env" })), "block");
});

test("Gemini's read hook stops mcp_filesystem_read_file on .env", (t) => {
  const root = toolReadRoot(t);
  assert.equal(geminiRead(root, "mcp_filesystem_read_file", { path: ".env" }), "block");
});

test("the added read names are stopped on .env whatever server they come from", (t) => {
  const root = toolReadRoot(t);
  for (const name of ["get_file_contents", "view_file", "open_file", "read_text_file"]) {
    assert.equal(toolCall(root, "claude", `mcp__docs__${name}`, { path: ".env" }), "block", `claude ${name}`);
    assert.equal(toolCall(root, "cursor", name, { file_path: ".env" }), "block", `cursor ${name}`);
    assert.equal(geminiRead(root, `mcp_docs_${name}`, { path: ".env" }), "block", `gemini ${name}`);
  }
  for (const name of ["read_many_files", "read_multiple_files"]) {
    const args = { paths: ["README.md", ".env"] };
    assert.equal(toolCall(root, "claude", `mcp__docs__${name}`, args), "block", `claude ${name}`);
    assert.equal(toolCall(root, "cursor", name, args), "block", `cursor ${name}`);
    assert.equal(geminiRead(root, `mcp_docs_${name}`, args), "block", `gemini ${name}`);
  }
});

test("tool calls that only name .env, or read an ordinary file, still pass", (t) => {
  const root = toolReadRoot(t);
  const calls = [
    ["write_file", { path: ".env", content: "NAME=example" }],
    ["edit_file", { path: ".env", edits: [{ oldText: "NAME=", newText: "NAME=x" }] }],
    ["read_file", { path: ".env.example" }],
    ["read_file", { path: "README.md" }],
    ["get_file_contents", { path: "README.md" }],
    ["create_issue", { title: "Setup", body: "Copy .env.example to .env before you start." }],
    ["search_files", { path: ".", pattern: ".env" }],
  ];
  for (const [name, args] of calls) {
    assert.equal(toolCall(root, "claude", `mcp__other__${name}`, args), "allow", `claude ${name}`);
    assert.equal(toolCall(root, "cursor", name, JSON.stringify(args)), "allow", `cursor ${name}`);
    assert.equal(geminiRead(root, `mcp_other_${name}`, args), "allow", `gemini ${name}`);
  }
});

// An add-on read of a file this computer can't open is judged by its name, as 0.1.3 judged it, and passes with no note
// when the name isn't a secret file's. Claude Code's filesystem reads keep the note they had.
const plainAllow = (outcome, label) => {
  assert.equal(outcome.action, "allow", label);
  for (const flag of ["internalError", "skipped", "partial", "unfinished"]) {
    assert.ok(!outcome[flag], `${label} ${flag}`);
  }
};
const toolOutcome = (root, tool, name, args) =>
  guard.inspectTool(tool, { tool_name: name, tool_input: args, cwd: root }, { cwd: root, dataDir: root });
const geminiOutcome = (root, name, args) =>
  inspectRead("gemini", { tool_name: name, tool_input: args, cwd: root }, { cwd: root, dataDir: root });

const remoteSource = { owner: "octo", repo: "demo", path: "src/index.js" };
const remoteSourceCalls = [
  ["Claude's tool hook", (root) => toolOutcome(root, "claude", "mcp__github__get_file_contents", remoteSource)],
  ["Cursor's tool hook", (root) => toolOutcome(root, "cursor", "get_file_contents", JSON.stringify(remoteSource))],
  ["Gemini's read hook", (root) => geminiOutcome(root, "mcp_github_get_file_contents", remoteSource)],
];
for (const [label, call] of remoteSourceCalls) {
  test(`${label} passes a GitHub server's get_file_contents of a file in a remote repo with no note`, (t) => {
    plainAllow(call(toolReadRoot(t)), label);
  });
}

const unopenablePaths = [
  ["a missing file", "nothere.txt"],
  ["a home path", "~/clotr-made-up-notes.txt"],
  ["a Windows path on Linux", "C:\\Users\\someone\\project\\README.md"],
  ["a path with a zero byte", ".env\u0000.txt"],
  ["a 64 KB name", "x".repeat(65536)],
];

for (const [label, filePath] of unopenablePaths) {
  test(`Cursor's tool hook passes an add-on read of ${label} with no note`, (t) => {
    if (process.platform === "win32" && label === "a Windows path on Linux") return;
    const root = toolReadRoot(t);
    plainAllow(toolOutcome(root, "cursor", "read_file", JSON.stringify({ path: filePath })), label);
  });

  test(`Gemini's read hook passes an add-on read of ${label} with no note`, (t) => {
    if (process.platform === "win32" && label === "a Windows path on Linux") return;
    const root = toolReadRoot(t);
    plainAllow(geminiOutcome(root, "mcp_srv_read_file", { path: filePath }), label);
  });
}

test("a GitHub server's get_file_contents naming .env in a remote repo is still stopped", (t) => {
  const root = tempDir(t);
  for (const filePath of [".env", "config/.env.production"]) {
    const args = { owner: "octo", repo: "demo", path: filePath };
    assert.equal(toolCall(root, "claude", "mcp__github__get_file_contents", args), "block", `claude ${filePath}`);
    assert.equal(toolCall(root, "cursor", "get_file_contents", JSON.stringify(args)), "block", `cursor ${filePath}`);
  }
});

// Cursor's tool hook gets no file contents, so a read there costs only what the hook reads from disk: at most
// CURSOR_DISK_READ's bytes of each file, through reads of that size. This counts each read call and the bytes it
// asked for and got while the hook runs, on a clock that stands still so its 50 ms of reading never runs out. A read
// with no size of its own (a whole file at once) counts as unbounded.
const CURSOR_READ_BYTES =
  Number(
    /const CURSOR_DISK_READ = \{ bytes: (\d+) \* 1024,/.exec(
      fs.readFileSync(path.join(GUARD_DIR, "lib", "hooks", "file-read-tools.js"), "utf8"),
    )[1],
  ) * 1024;

function cursorDiskReads(root, name, args) {
  const call = () =>
    guard.inspectTool("cursor", { tool_name: name, tool_input: JSON.stringify(args), cwd: root }, { cwd: root });
  // The first call loads the engine from disk, which isn't the read's cost.
  call();
  const counted = { calls: 0, bytes: 0, biggest: 0, unbounded: 0 };
  const originals = ["readSync", "readFileSync", "readvSync", "createReadStream"].map((n) => [n, fs[n]]);
  fs.readSync = function (fd, buffer, ...rest) {
    const asked = typeof rest[0] === "object" && rest[0] ? rest[0].length : rest[1];
    const got = originals[0][1].call(this, fd, buffer, ...rest);
    counted.calls += 1;
    counted.bytes += got;
    counted.biggest = Math.max(counted.biggest, asked ?? buffer.length);
    return got;
  };
  for (const [n, original] of originals.slice(1)) {
    fs[n] = function (...a) {
      counted.calls += 1;
      counted.unbounded += 1;
      return original.apply(this, a);
    };
  }
  const realNow = Date.now;
  const now = realNow();
  Date.now = () => now;
  try {
    return { action: call().action, ...counted };
  } finally {
    for (const [n, original] of originals) fs[n] = original;
    Date.now = realNow;
  }
}

// Every read asks for at most the bound and one byte more (that byte tells a file that goes on), each file takes at
// most two reads (the second finds its end), and the bytes read stay inside the bound for each file.
function assertCursorReadsBounded(read, files) {
  assert.equal(read.action, "allow");
  assert.equal(read.unbounded, 0, `${read.unbounded} reads of a whole file`);
  assert.ok(read.biggest <= CURSOR_READ_BYTES + 1, `a read asked for ${read.biggest} bytes`);
  assert.ok(read.calls <= 2 * files, `${read.calls} reads for ${files} files`);
  assert.ok(read.bytes <= files * (CURSOR_READ_BYTES + 1), `${read.bytes} bytes read for ${files} files`);
}

test("Cursor's tool hook reads only its bound of a 5 MB file for a read_file", (t) => {
  const root = tempDir(t);
  const line = "ordinary line of text for the big file, nothing to see here\n";
  fs.writeFileSync(path.join(root, "big.txt"), line.repeat(Math.ceil((5 * 1024 * 1024) / line.length)));
  const read = cursorDiskReads(root, "read_file", { path: "big.txt" });
  assertCursorReadsBounded(read, 1);
  assert.equal(read.calls, 1, "one read of the bound fills the buffer");
});

test("Cursor's tool hook reads only its bound of each of 200 small files for a read_multiple_files", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "many"));
  const paths = [];
  for (let i = 1; i <= 200; i++) {
    fs.writeFileSync(path.join(root, "many", `f${i}.txt`), `file ${i}\n`);
    paths.push(`many/f${i}.txt`);
  }
  const read = cursorDiskReads(root, "read_multiple_files", { paths });
  assertCursorReadsBounded(read, 200);
  assert.equal(read.calls, 400, "each small file is read to its end, all 200 of them");
});

test("Cursor's tool hook still stops a read of a service account file under a plain name", (t) => {
  const root = toolReadRoot(t);
  fs.writeFileSync(path.join(root, "notes.json"), '{ "type": "service_account", "project_id": "made-up" }\n');
  assert.equal(toolCall(root, "cursor", "read_file", JSON.stringify({ path: "notes.json" })), "block");
  assert.equal(
    toolCall(root, "cursor", "read_multiple_files", JSON.stringify({ paths: ["README.md", "notes.json"] })),
    "block",
  );
});

// Opening a named pipe waits until something writes to it, so a read of one is checked in a child process that's
// ended after 10 seconds, and the check inside it must answer within 1 second. mkfifo doesn't exist on Windows, so
// these tests are skipped there.
const NO_FIFO = process.platform === "win32" ? "mkfifo doesn't exist on Windows" : false;

function fifoRoot(t, name) {
  const root = toolReadRoot(t);
  const made = spawnSync("mkfifo", [path.join(root, name)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return root;
}

// Runs one hook's check of a read in a child process: its outcome and how long the check took, or null when it hung.
function checkInChild(root, hook, name, args) {
  const script = `
    const guard = require(${JSON.stringify(path.join(GUARD_DIR, "bin", "clotr-guard.js"))});
    const [hook, name, args, root] = JSON.parse(process.argv[1]);
    const tool = hook === "gemini-read" ? "gemini" : hook;
    const event = { tool_name: name, tool_input: tool === "cursor" ? JSON.stringify(args) : args, cwd: root };
    const options = { cwd: root, dataDir: root, searchWalkMaxMs: 10000 };
    const started = performance.now();
    const outcome = hook === "gemini-read" ? guard.inspectRead(tool, event, options) : guard.inspectTool(tool, event, options);
    process.stdout.write(JSON.stringify({ outcome, ms: performance.now() - started }));`;
  const result = spawnSync(process.execPath, ["-e", script, JSON.stringify([hook, name, args, root])], {
    encoding: "utf8",
    timeout: 10000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.signal) return null;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const fileName of ["pipe.json", "notes.json"]) {
  for (const [label, hook, name] of [
    ["Cursor's tool hook", "cursor", "read_file"],
    ["Gemini's read hook", "gemini-read", "mcp_fs_read_file"],
  ]) {
    test(
      `${label} judges a read_file of a named pipe called ${fileName} by its name within 1 second`,
      { skip: NO_FIFO },
      (t) => {
        const root = fifoRoot(t, fileName);
        const answer = checkInChild(root, hook, name, { path: fileName });
        assert.ok(answer, "no answer within 10 seconds");
        assert.ok(answer.ms < 1000, `${Math.round(answer.ms)} ms`);
        plainAllow(answer.outcome, label);
      },
    );
  }
}

test(
  "Claude's tool hook gives a filesystem read of a named pipe the couldn't-check note within 1 second",
  { skip: NO_FIFO },
  (t) => {
    const root = fifoRoot(t, "pipe.json");
    const answer = checkInChild(root, "claude", "mcp__fs__read_file", { path: "pipe.json" });
    assert.ok(answer, "no answer within 10 seconds");
    assert.ok(answer.ms < 1000, `${Math.round(answer.ms)} ms`);
    assert.equal(answer.outcome.action, "allow");
    assert.equal(answer.outcome.internalError, true);
  },
);

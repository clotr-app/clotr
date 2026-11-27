"use strict";
/* global require, __dirname, process */
// WSL keeps a Linux distribution's files behind `\\wsl.localhost\<distro>\` and `\\wsl$\<distro>\`. Windows serves
// those from this computer, so the read hook opens a file there and checks it, like any file on a drive. Other hosts
// that only look like them are still another computer's, judged by name and never opened. The tests don't need WSL:
// the opens are sent to a local file, and on Windows the probe that opens the file first (see wslAnswers) runs for
// real on that local file too.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

const guard = require("../apps/guard/bin/clotr-guard.js");

// A made-up key, never a real one.
const KEY_TEXT = "aws_access_key_id = AKIA4HPQ7XZ2R6TWLJ3N\n";
const PLAIN_TEXT = "Meeting notes: bring the slides.\n";

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-wsl-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "key.txt"), KEY_TEXT);
  fs.writeFileSync(path.join(folder, "plain.txt"), PLAIN_TEXT);
  return folder;
}

// Sends an open of a path matching `host` to the local file `target`, and records every path opened.
function redirectOpens(t, host, target) {
  const opened = [];
  const original = fs.openSync;
  t.mock.method(fs, "openSync", function (file, ...rest) {
    opened.push(String(file));
    return original.call(this, host.test(String(file)) ? target : file, ...rest);
  });
  return opened;
}

// Windows opens a WSL file first in a child process (see wslAnswers), which the mock above can't reach. This runs the
// real probe on `target` instead, and records the path each probe was asked about.
function probeTo(target, asked) {
  return (file, deadline) => {
    asked.push(file);
    return guard.wslAnswers(target, deadline);
  };
}

function read(filePath, cwd = os.tmpdir(), probe = undefined) {
  return guard.inspectRead(
    "claude",
    { tool_name: "Read", tool_input: { file_path: filePath } },
    { cwd, wslAnswers: probe },
  );
}

const WINDOWS = process.platform === "win32";

const WSL_FORMS = ["\\\\wsl.localhost\\Ubuntu\\home\\u\\proj\\notes.txt", "\\\\wsl$\\Ubuntu\\home\\u\\proj\\notes.txt"];

for (const form of WSL_FORMS) {
  const label = form.startsWith("\\\\wsl$") ? "wsl$" : "wsl.localhost";
  test(`a read under ${label} is opened and checked for keys`, (t) => {
    const folder = fixture(t);
    const host = /^[\\/]{2}wsl/i;
    for (const written of [form, form.toUpperCase().replace("NOTES.TXT", "notes.txt"), form.replace(/\\/g, "/")]) {
      const asked = [];
      const keyOpens = redirectOpens(t, host, path.join(folder, "key.txt"));
      const stopped = read(written, undefined, probeTo(path.join(folder, "key.txt"), asked));
      assert.equal(stopped.action, "block", written);
      assert.ok(keyOpens.length > 0, `${written} was opened`);
      t.mock.restoreAll();

      redirectOpens(t, host, path.join(folder, "plain.txt"));
      const passed = read(written, undefined, probeTo(path.join(folder, "plain.txt"), asked));
      assert.equal(passed.action, "allow", written);
      assert.equal(passed.internalError, undefined, `${written} has no "couldn't check" note`);
      t.mock.restoreAll();
      assert.equal(asked.length, WINDOWS ? 2 : 0, `${written} is probed on Windows only`);
      for (const value of asked) assert.ok(host.test(value), `probed ${value}`);
    }
  });

  test(`a relative read from a working folder under ${label} is opened and checked`, (t) => {
    const folder = fixture(t);
    const opened = redirectOpens(t, /^[\\/]{2}wsl/i, path.join(folder, "key.txt"));
    const cwd = form.slice(0, form.lastIndexOf("\\"));
    const asked = [];
    const outcome = read("notes.txt", cwd, probeTo(path.join(folder, "key.txt"), asked));
    assert.equal(outcome.action, "block");
    assert.ok(opened.includes(form), `opened ${opened.join(", ")}`);
    assert.deepEqual(asked, WINDOWS ? [form] : []);
  });

  test(
    `a read under ${label} that doesn't open in time isn't opened here and gets a "couldn't check" note`,
    {
      skip: !WINDOWS,
    },
    (t) => {
      const opened = redirectOpens(t, /^[\\/]{2}wsl/i, path.join(fixture(t), "key.txt"));
      const asked = [];
      const outcome = read(form, undefined, (file) => {
        asked.push(file);
        return false;
      });
      assert.deepEqual(outcome, { action: "allow", internalError: true });
      assert.deepEqual(asked, [form]);
      assert.deepEqual(opened, []);
    },
  );

  test(`a secret file's name under ${label} is stopped`, () => {
    for (const name of ["\\.env", "\\.ssh\\id_ed25519", "\\.aws\\credentials"]) {
      const value = form.replace(/\\proj\\notes\.txt$/, name);
      const outcome = read(value);
      assert.equal(outcome.action, "block", value);
      assert.equal(outcome.secretFile, true, value);
    }
  });
}

test("a host that only looks like WSL's is still another computer: judged by name, never opened", (t) => {
  const opened = redirectOpens(t, /^$/, "");
  for (const value of [
    "\\\\wsl.localhost.example\\Ubuntu\\home\\u\\proj\\notes.txt",
    "\\\\wsl$x\\Ubuntu\\home\\u\\proj\\notes.txt",
    "\\\\fileserver\\share\\proj\\notes.txt",
  ]) {
    assert.deepEqual(read(value), { action: "allow", internalError: true }, value);
    assert.equal(read(value.replace("notes.txt", ".env")).action, "block", value);
  }
  assert.deepEqual(opened, []);
});

test("a drive's share on this computer is still read from its drive", (t) => {
  const opened = redirectOpens(t, /^$/, "");
  read("\\\\localhost\\C$\\proj\\notes.txt");
  assert.ok(
    opened.some((value) => value.toLowerCase() === "c:\\proj\\notes.txt"),
    `opened ${opened.join(", ")}`,
  );
  assert.ok(!opened.some((value) => /^[\\/]{2}/.test(value)), "the share itself isn't opened");
});

test("a search rooted at a WSL path still isn't walked", () => {
  for (const root of ["\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", "\\\\wsl$\\Ubuntu\\home\\u\\proj"]) {
    const outcome = guard.inspectRead("claude", {
      tool_name: "Grep",
      tool_input: { pattern: "token", path: root, output_mode: "content" },
    });
    assert.deepEqual(outcome, { action: "allow", searchLimited: true }, root);
  }
});

test("the WSL probe answers for a file that opens, and not for a missing one or a deadline already past", (t) => {
  const folder = fixture(t);
  assert.equal(guard.wslAnswers(path.join(folder, "plain.txt"), Date.now() + 5000), true);
  assert.equal(guard.wslAnswers(path.join(folder, "plain.txt"), undefined), true);
  assert.equal(guard.wslAnswers(path.join(folder, "missing.txt"), Date.now() + 5000), false);
  const started = Date.now();
  assert.equal(guard.wslAnswers(path.join(folder, "plain.txt"), Date.now() - 1), false);
  assert.ok(Date.now() - started < 100, "a deadline already past doesn't start a probe");
});

test("a WSL share that doesn't answer in time counts as not answering", { skip: WINDOWS }, (t) => {
  const folder = fixture(t);
  // A named pipe with no writer never finishes opening, like a distribution that is slow to start.
  const pipe = path.join(folder, "slow");
  childProcess.execFileSync("mkfifo", [pipe]);
  const started = Date.now();
  assert.equal(guard.wslAnswers(pipe, Date.now() + 1000), false);
  assert.ok(Date.now() - started < 4000, "the probe was stopped at its time");
});

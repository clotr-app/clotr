"use strict";
/* global require, __dirname */
// False alarms from the shell check's folder walk, the walk that reads every folder a recursive reader (`grep -r`,
// `rg`, `findstr /s`) would read to look for a secret file there. Two readers of one folder shared one budget, a
// folder rg leaves out because Git ignores it was walked all the same, a public certificate bundle inside a Python
// virtual env was taken for a key, and one huge folder was listed in a single call that the walk's time limit
// couldn't stop. Made-up files only.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ENGINE_PATH = path.join(__dirname, "..", "apps", "guard", "dist", "clotr-engine.js");
if (!fs.existsSync(ENGINE_PATH)) {
  const { build } = require("../tools/engine-bundle.js");
  fs.mkdirSync(path.dirname(ENGINE_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_PATH, build().text);
}
const guard = require("../apps/guard/bin/clotr-guard.js");

const FOLDER_TOO_BIG = "a folder too big to check";
// Room enough in time that only the entry counts decide.
const ROOM = { searchWalkMaxMs: 600_000, shellCheckMaxMs: 600_000 };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-walk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fill(folder, count, name = (index) => `f${index}.txt`) {
  fs.mkdirSync(folder, { recursive: true });
  for (let index = 0; index < count; index += 1) fs.writeFileSync(path.join(folder, name(index)), "x\n");
}

function shell(root, command, options = {}, toolName = "Bash") {
  return guard.inspectShell(
    "claude",
    { tool_name: toolName, tool_input: { command, cwd: root } },
    { cwd: root, ...options },
  );
}

const hasGit = !spawnSync("git", ["--version"]).error;
const hasRipgrep = !spawnSync("rg", ["--version"]).error;

test("two different readers of one folder each get their own share of the walk's budget", (t) => {
  const root = tempDir(t);
  fill(path.join(root, "big"), 70);
  const options = { searchWalkMaxEntries: 100, ...ROOM };
  assert.equal(shell(root, "grep -r SAMPLE big", options).action, "allow", "grep alone");
  assert.equal(shell(root, "rg SAMPLE big", options).action, "allow", "rg alone");
  for (const command of [
    "grep -r SAMPLE big; rg SAMPLE big",
    "rg SAMPLE big && grep -rn SAMPLE big",
    "grep -r SAMPLE big | rg SAMPLE big",
  ]) {
    assert.equal(shell(root, command, options).action, "allow", command);
  }
  // One reader's folders still share its own share: two folders of 70 don't fit a budget of 100.
  fill(path.join(root, "more"), 70);
  assert.equal(shell(root, "grep -r SAMPLE big more", options).location, FOLDER_TOO_BIG);
  // And each reader still finds a secret file in what it reads.
  fs.writeFileSync(path.join(root, "big", ".env"), "SAMPLE=placeholder\n");
  assert.equal(shell(root, "rg -uu SAMPLE big; grep -r SAMPLE big", options).action, "block");
});

test(
  "the walk for rg stops reading a folder Git ignores once it knows, as rg leaves it out",
  { skip: !hasGit },
  (t) => {
    const root = tempDir(t);
    spawnSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), "target/\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "app.js"), "const SAMPLE = 1;\n");
    // Past the point where the walk asks which folders rg leaves out, and past the walk's budget, in one folder.
    fill(path.join(root, "target"), 5000, (index) => `f${index}.o`);
    const options = { searchWalkMaxEntries: 4500, ...ROOM };
    for (const command of ["rg SAMPLE", "rg -n SAMPLE .", "rg -i sample ."]) {
      assert.equal(shell(root, command, options).action, "allow", command);
    }
    // Readers that do read a git-ignored folder still walk it, and stop when it's too big.
    assert.equal(shell(root, "grep -r SAMPLE .", options).location, FOLDER_TOO_BIG, "grep -r");
    assert.equal(shell(root, "rg --no-ignore SAMPLE", options).location, FOLDER_TOO_BIG, "rg --no-ignore");
    assert.equal(shell(root, "findstr /s SAMPLE *.*", options, "PowerShell").action, "block", "findstr /s");
  },
);

test("a secret file in a folder Git ignores is still found by a reader that reads it", { skip: !hasGit }, (t) => {
  const root = tempDir(t);
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), "target/\n");
  fill(path.join(root, "target"), 5000, (index) => `f${index}.o`);
  fs.mkdirSync(path.join(root, "target", "keys"));
  fs.writeFileSync(path.join(root, "target", "keys", "id_rsa"), "placeholder\n");
  const options = { searchWalkMaxEntries: 20_000, ...ROOM };
  assert.equal(shell(root, "grep -r SAMPLE .", options).location, "target/keys/id_rsa");
  if (hasRipgrep) assert.equal(shell(root, "rg SAMPLE", options).action, "allow", "rg leaves target/ out");
});

function venvFixture(t) {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "SAMPLE = 1\n");
  for (const venv of [".venv", "venv"]) {
    const certifi = path.join(root, venv, "lib", "python3.12", "site-packages", "certifi");
    fs.mkdirSync(certifi, { recursive: true });
    fs.writeFileSync(
      path.join(certifi, "cacert.pem"),
      "-----BEGIN CERTIFICATE-----\nMADEUP\n-----END CERTIFICATE-----\n",
    );
    fs.writeFileSync(path.join(certifi, "core.py"), "def where(): pass\n");
  }
  const pip = path.join(root, "venv", "lib", "python3.12", "site-packages", "pip", "_vendor", "certifi");
  fs.mkdirSync(pip, { recursive: true });
  fs.writeFileSync(path.join(pip, "cacert.pem"), "-----BEGIN CERTIFICATE-----\nMADEUP\n-----END CERTIFICATE-----\n");
  return root;
}

test("a public certificate bundle inside a virtual env doesn't stop a recursive read", (t) => {
  const root = venvFixture(t);
  for (const command of [
    "grep -rn SAMPLE .",
    "rg SAMPLE",
    "rg -uu SAMPLE",
    "grep -r SAMPLE venv",
    "grep -r SAMPLE .venv",
  ]) {
    assert.equal(shell(root, command).action, "allow", command);
  }
  assert.equal(shell(root, "findstr /s SAMPLE *.py", {}, "PowerShell").action, "allow", "findstr /s");
});

test("a private key inside a virtual env still stops a recursive read", (t) => {
  for (const [folder, name] of [
    ["certifi", "private.pem"],
    ["certifi", "id_rsa"],
    ["somepkg", "server.key"],
    ["somepkg", "cacert.pem.key"],
  ]) {
    const root = venvFixture(t);
    const where = path.join(root, "venv", "lib", "python3.12", "site-packages", folder);
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, name), "placeholder\n");
    const outcome = shell(root, "grep -rn SAMPLE .");
    assert.equal(outcome.action, "block", `${folder}/${name}`);
    assert.equal(outcome.location, `venv/lib/python3.12/site-packages/${folder}/${name}`);
  }
  // A cacert.pem outside a virtual env or package folder is judged as before.
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "certs"));
  fs.writeFileSync(path.join(root, "certs", "cacert.pem"), "placeholder\n");
  assert.equal(shell(root, "grep -rn SAMPLE .").location, "certs/cacert.pem");
});

// Counted, not timed: how many entries the walk lists from one huge folder before its budget stops it.
test("one huge folder is read in pieces, so the walk stops at its limit inside it", (t) => {
  const root = tempDir(t);
  const huge = path.join(root, "huge");
  fill(huge, 9000, (index) => `generated-output-file-number-${String(index).padStart(6, "0")}.txt`);
  if (fs.statSync(huge).size < 256 * 1024) {
    t.skip("this file system doesn't report a folder's size");
    return;
  }
  const realReaddir = fs.readdirSync;
  const realOpendir = fs.opendirSync;
  let listed = 0;
  // Only the walk's own listings count. Looking up `.` also lists the folders above the search root.
  const inRoot = (folder) => {
    const full = path.resolve(String(folder));
    return full === root || full.startsWith(root + path.sep);
  };
  fs.readdirSync = function readdirSync(...args) {
    const entries = realReaddir.apply(this, args);
    if (inRoot(args[0])) listed += entries.length;
    return entries;
  };
  fs.opendirSync = function opendirSync(...args) {
    const handle = realOpendir.apply(this, args);
    const counted = inRoot(args[0]);
    const readSync = handle.readSync.bind(handle);
    handle.readSync = () => {
      const entry = readSync();
      if (entry && counted) listed += 1;
      return entry;
    };
    return handle;
  };
  t.after(() => {
    fs.readdirSync = realReaddir;
    fs.opendirSync = realOpendir;
  });
  for (const command of ["grep -r SAMPLE .", "rg -uu SAMPLE ."]) {
    listed = 0;
    const outcome = shell(root, command, { searchWalkMaxEntries: 100, ...ROOM });
    assert.equal(outcome.location, FOLDER_TOO_BIG, command);
    assert.ok(listed > 0, `${command}: no listing inside the searched folder was counted`);
    assert.ok(listed <= 200, `${command}: listed ${listed} entries on a budget of 100`);
  }
});

test("a key named like a certificate bundle at a project root is still stopped when a folder above is a venv", (t) => {
  const project = path.join(tempDir(t), "venv", "myproj");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "app.py"), "SAMPLE = 1\n");
  fs.writeFileSync(path.join(project, "cacert.pem"), "made-up placeholder key\n");
  const outcome = shell(project, "grep -r SAMPLE .");
  assert.equal(outcome.action, "block");
  assert.equal(outcome.location, "cacert.pem");
});

test("a certificate bundle name in other letter case inside a venv is still stopped", (t) => {
  const root = tempDir(t);
  const certifi = path.join(root, ".venv", "lib", "python3.12", "site-packages", "certifi");
  fs.mkdirSync(certifi, { recursive: true });
  fs.writeFileSync(path.join(certifi, "CACERT.PEM"), "made-up placeholder key\n");
  for (const command of ["grep -r SAMPLE .", "rg -uu SAMPLE ."]) {
    const outcome = shell(root, command);
    assert.equal(outcome.action, "block", command);
    assert.equal(outcome.location, ".venv/lib/python3.12/site-packages/certifi/CACERT.PEM", command);
  }
});

test("a venv searched from inside still lets its own certificate bundle through", (t) => {
  const root = venvFixture(t);
  const venv = path.join(root, "venv");
  for (const command of ["grep -r SAMPLE .", "rg -uu SAMPLE ."]) {
    assert.equal(shell(venv, command).action, "allow", `venv: ${command}`);
  }
  const sitePackages = path.join(venv, "lib", "python3.12", "site-packages");
  assert.equal(shell(sitePackages, "grep -r SAMPLE .").action, "allow", "site-packages");
});

// Windows gives every folder's size as 0, so a size-0 folder is what a Windows walk sees.
test("a folder that reports its size as 0 is still judged in full", (t) => {
  const root = tempDir(t);
  fill(path.join(root, "huge"), 9000);
  const realStat = fs.statSync;
  fs.statSync = function statSync(...args) {
    const stats = realStat.apply(this, args);
    if (stats?.isDirectory?.()) Object.defineProperty(stats, "size", { value: 0 });
    return stats;
  };
  t.after(() => {
    fs.statSync = realStat;
  });
  assert.equal(fs.statSync(path.join(root, "huge")).size, 0);
  const options = { searchWalkMaxEntries: 100, ...ROOM };
  for (const command of ["grep -r SAMPLE .", "rg -uu SAMPLE ."]) {
    assert.equal(shell(root, command, options).location, FOLDER_TOO_BIG, command);
  }
  fs.writeFileSync(path.join(root, "huge", "server.key"), "made-up placeholder\n");
  const roomy = { searchWalkMaxEntries: 20_000, ...ROOM };
  assert.equal(shell(root, "grep -r SAMPLE .", roomy).location, "huge/server.key");
});

// A link can need extra rights on Windows; where one can't be made, the link tests are skipped.
function canLink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-link-"));
  try {
    fs.mkdirSync(path.join(dir, "target"));
    fs.symlinkSync("target", path.join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const linksWork = canLink();

// A plain folder holding a made-up key saved as `cacert.pem`, reached through a link named `venv`.
function linkedKey(t) {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "certs"));
  fs.writeFileSync(path.join(root, "certs", "cacert.pem"), "made-up placeholder key\n");
  fs.symlinkSync("certs", path.join(root, "venv"), "dir");
  return root;
}

test("a root linked under a package folder's name is judged by its name on disk", { skip: !linksWork }, (t) => {
  for (const command of ["grep -R SAMPLE venv", ...(hasRipgrep ? ["rg -uu SAMPLE venv"] : [])]) {
    const outcome = shell(linkedKey(t), command);
    assert.equal(outcome.action, "block", command);
    assert.equal(outcome.location, "venv/cacert.pem", command);
  }
});

test(
  "a working folder given as a link named like a package folder is judged by its name on disk",
  { skip: !linksWork },
  (t) => {
    const outcome = shell(path.join(linkedKey(t), "venv"), "grep -r SAMPLE .");
    assert.equal(outcome.action, "block");
    assert.equal(outcome.location, "cacert.pem");
  },
);

test(
  "a link named venv below the project to a plain folder elsewhere is judged by its name on disk",
  { skip: !linksWork },
  (t) => {
    const base = tempDir(t);
    fs.mkdirSync(path.join(base, "secrets"));
    fs.writeFileSync(path.join(base, "secrets", "cacert.pem"), "made-up placeholder key\n");
    fs.mkdirSync(path.join(base, "proj", "src"), { recursive: true });
    fs.writeFileSync(path.join(base, "proj", "src", "a.txt"), "x\n");
    fs.symlinkSync("../secrets", path.join(base, "proj", "venv"), "dir");
    const outcome = shell(path.join(base, "proj"), "grep -R SAMPLE venv");
    assert.equal(outcome.action, "block");
    assert.equal(outcome.location, "venv/cacert.pem");
  },
);

test(
  "a plain-named link into a real .venv is still stopped by a key saved as cacert.pem",
  { skip: !linksWork },
  (t) => {
    const root = tempDir(t);
    fs.mkdirSync(path.join(root, "real", ".venv"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", ".venv", "cacert.pem"), "made-up placeholder key\n");
    fs.symlinkSync(path.join("real", ".venv"), path.join(root, "lnk"), "dir");
    for (const command of ["grep -R SAMPLE lnk", ...(hasRipgrep ? ["rg -uu SAMPLE lnk"] : [])]) {
      assert.equal(shell(root, command).action, "block", command);
    }
    assert.equal(shell(path.join(root, "lnk"), "grep -r SAMPLE .").action, "block", "working folder");
  },
);

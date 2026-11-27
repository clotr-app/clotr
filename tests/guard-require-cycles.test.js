"use strict";

// Guard's files take names out of a `require` as they load. If file A loads B while B is still loading A, B gets
// an empty value for each name and no error. So this follows every relative `require` that runs as a file loads,
// from Guard's commands, and fails on a cycle, naming the files in it. A require inside a function (a command
// that loads another part of Guard only when it's asked for) runs after every file has loaded, so it can't make
// this cycle. A file a command loads on first use starts a load of its own later, so it's followed too.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const GUARD = path.join(__dirname, "..", "apps", "guard");
// The commands are the files in package.json's `bin`.
const COMMANDS = Object.values(require(path.join(GUARD, "package.json")).bin).map((file) => path.join(GUARD, file));
// Top-level statements start at the line's first column. That includes `} = require(...)` closing a long one.
const RELATIVE_REQUIRE = /^(?=\S).*?\brequire\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/gm;
// A file a command loads on first use, as in `onFirstUse("../lib/shell-checks/shell-check.js", [...])`.
const FIRST_USE_FILE = /\bonFirstUse\(\s*(["'])(\.{1,2}\/[^"']+)\1/g;

// ---------- Following requires ----------

// The Guard files a file requires by a relative path as it loads.
function requiredFiles(file) {
  const text = fs.readFileSync(file, "utf8");
  const found = [];
  for (const match of text.matchAll(RELATIVE_REQUIRE)) {
    const target = require.resolve(path.resolve(path.dirname(file), match[2]));
    found.push(target);
  }
  return found;
}

// Each cycle met on the way down from `file`, as the list of files from the first one back to it.
function cyclesFrom(file, onPath, done, cycles) {
  if (done.has(file)) return;
  const at = onPath.indexOf(file);
  if (at >= 0) {
    cycles.push([...onPath.slice(at), file]);
    return;
  }
  onPath.push(file);
  for (const target of requiredFiles(file)) cyclesFrom(target, onPath, done, cycles);
  onPath.pop();
  done.add(file);
}

// The Guard files a command loads on first use.
function firstUseFiles(file) {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(FIRST_USE_FILE)].map((match) => require.resolve(path.resolve(path.dirname(file), match[2])));
}

function shown(file) {
  return path.relative(GUARD, file).split(path.sep).join("/");
}

// ---------- Tests ----------

test("Guard's files load with no require cycle", () => {
  const done = new Set();
  const cycles = [];
  for (const command of COMMANDS) {
    cyclesFrom(command, [], done, cycles);
    for (const later of firstUseFiles(command)) cyclesFrom(later, [], done, cycles);
  }
  const named = cycles.map((cycle) => cycle.map(shown).join(" -> "));
  assert.deepEqual(named, [], `require cycles:\n${named.join("\n")}`);
  assert.ok(done.size >= 20, `expected Guard's lib files to be followed, reached ${done.size}`);
});

test("a require cycle is found and named", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "guard-cycles-"));
  try {
    fs.writeFileSync(path.join(dir, "a.js"), 'require("./b.js");\nfunction later() {\n  require("./c.js");\n}\n');
    fs.writeFileSync(path.join(dir, "c.js"), 'require("./a.js");\n');
    fs.writeFileSync(path.join(dir, "b.js"), 'const { x } = require("./a.js");\n');
    const cycles = [];
    cyclesFrom(path.join(dir, "a.js"), [], new Set(), cycles);
    assert.deepEqual(
      cycles.map((cycle) => cycle.map((file) => path.basename(file))),
      [["a.js", "b.js", "a.js"]],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

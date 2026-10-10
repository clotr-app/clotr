// A temp folder left behind by every run adds up: one run once left 50,523 of them (about 80 GB) because nothing
// removed its own. This doesn't prove every mkdtemp is paired with the right rmSync in the right place, only the
// cheap, honest half of that: a file that makes one also removes one, somewhere in itself.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f && f.endsWith(".js") && fs.existsSync(path.join(ROOT, f)));

test("a file that makes a temp folder (mkdtemp) also removes one (rmSync)", () => {
  const offenders = tracked()
    .filter((f) => !f.startsWith("node_modules/"))
    .filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      return /\bmkdtemp(Sync)?\(/.test(text) && !/\brmSync\(/.test(text);
    });
  assert.deepEqual(offenders, [], "these call mkdtemp but never rmSync, so every run leaves a folder behind");
});

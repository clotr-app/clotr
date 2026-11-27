// The engine releases on its own, before the extension, so its bundle has to build from the engine's files alone.
// tools/engine-bundle.js reads the extension's list (extension/extension-files.js) only for Clotr for Windows'
// scan parts, which the plain bundle never carries.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const { parts, build } = require("../tools/engine-bundle.js");

// What the plain bundle reads: the two tools, the engine's number and list, and the bundle's own parts.
const ENGINE_FILES = [
  "tools/engine-bundle.js",
  "tools/engine-files.js",
  "apps/engine/package.json",
  "extension/engine/files.js",
  ...parts(),
];

function copyInto(dir, files) {
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
}

test("the bundle builds from the engine's files alone, with no extension/extension-files.js", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-bundle-alone-"));
  try {
    copyInto(dir, ENGINE_FILES);
    assert.equal(fs.existsSync(path.join(dir, "extension", "extension-files.js")), false);

    const out = path.join(dir, "out", "clotr-engine.js");
    execFileSync(process.execPath, [path.join(dir, "tools", "engine-bundle.js"), "--out", out], { stdio: "pipe" });
    assert.ok(fs.readFileSync(out, "utf8") === build().text, "the bundle built alone isn't the one built here");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

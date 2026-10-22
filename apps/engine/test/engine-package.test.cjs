"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeProcess = require("node:process");
const { spawnSync } = require("node:child_process");

const PACKAGE = path.dirname(require.resolve("../package.json"));
const ROOT = path.join(PACKAGE, "..", "..");

function runNode(source, args = []) {
  const result = spawnSync(nodeProcess.execPath, [...args, source], {
    cwd: PACKAGE,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("clotr-engine exports the isolated engine from ESM and CommonJS without changing globalThis", () => {
  const cjs = runNode(
    `const before = Reflect.ownKeys(globalThis).map(String).sort();
const api = require("clotr-engine");
const after = Reflect.ownKeys(globalThis).map(String).sort();
process.stdout.write(JSON.stringify({ before, after, exports: Object.keys(api).sort() }));`,
    ["-e"],
  );
  const esm = runNode(
    `const before = Reflect.ownKeys(globalThis).map(String).sort();
const api = await import("clotr-engine");
const after = Reflect.ownKeys(globalThis).map(String).sort();
process.stdout.write(JSON.stringify({ before, after, exports: Object.keys(api).sort() }));`,
    ["--input-type=module", "-e"],
  );

  for (const { before, after, exports } of [JSON.parse(cjs), JSON.parse(esm)]) {
    assert.deepEqual(after, before);
    assert.deepEqual(exports, ["PATTERNS", "detect", "redact"]);
  }
});

test("clotr-engine matches the extension version and declares its result shape", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
  assert.equal(pkg.name, "clotr-engine");
  assert.equal(pkg.version, manifest.version.split(".").slice(0, 3).join("."));
  assert.equal(pkg.private, true);
  assert.equal(pkg.exports["."].import, "./index.mjs");
  assert.equal(pkg.exports["."].require, "./index.cjs");

  const declarations = fs.readFileSync(path.join(PACKAGE, "index.d.ts"), "utf8");
  for (const name of ["detect", "redact", "PATTERNS", "DetectionResult", "DetectionResults"]) {
    assert.match(declarations, new RegExp(`\\b${name}\\b`));
  }
});

test("clotr-engine detects and redacts a made-up email address", () => {
  const api = require(path.join(PACKAGE, "index.cjs"));
  const text = "Write to person@example.test";
  const results = api.detect(text);

  assert.ok(Object.isFrozen(api.PATTERNS));
  assert.ok(api.PATTERNS.some((pattern) => pattern.id === "email"));
  assert.ok(results.some((result) => result.id === "email" && result.matches.includes("person@example.test")));
  assert.doesNotMatch(api.redact(text, results), /person@example\.test/);
});

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

// The array detect() returned is a plain array: one edited in place (a false alarm taken out) is redacted as it
// now reads, the same as a filtered copy.
test("clotr-engine redacts what the results array holds now, after edits made in place", () => {
  const api = require(path.join(PACKAGE, "index.cjs"));
  const text = "Email jane.doe@example.org or call 555-555-5636.";
  const kept = "Email jane.doe@example.org or call [REDACTED PHONE NUMBER].";
  const spliced = api.detect(text);
  spliced.splice(
    spliced.findIndex((result) => result.id === "email"),
    1,
  );
  assert.equal(api.redact(text, spliced), kept);
  const cleared = api.detect(text);
  cleared.find((result) => result.id === "email").matches.length = 0;
  assert.equal(api.redact(text, cleared), kept);
  const emptied = api.detect(text);
  emptied.length = 0;
  assert.equal(api.redact(text, emptied), text);
  const untouched = api.detect(text);
  assert.equal(api.redact(text, untouched), "Email [REDACTED EMAIL ADDRESS] or call [REDACTED PHONE NUMBER].");
});

// redact() given a copy of detect()'s results (here filtered, so not the array detect() returned) hides those
// values from that same scan. A second scan cut short at a different point could find less: a preload stalls the
// engine's clock so the first scan stops after every rule and the next before any.
test("clotr-engine redacts every value in a copy of the results even when a second scan would stop earlier", () => {
  const preload = path.join(require("node:os").tmpdir(), `clotr-engine-stall-${nodeProcess.pid}.cjs`);
  fs.writeFileSync(
    preload,
    `const vm = require("node:vm");
const run = vm.runInContext;
vm.runInContext = function (code, context, options) {
  const out = run.call(this, code, context, options);
  if (options && options.filename === "clotr-engine.js") {
    run.call(this, \`(() => {
      let now = Date.now();
      Date.now = () => now;
      let scans = 0;
      const stall = () => (now += Clotr.DETECT_BACKSTOP_MS + 200);
      Clotr.PATTERNS.unshift({ id: "test_stall_head", severity: "low", name: "stall", find: () => (++scans > 1 && stall(), []) });
      Clotr.PATTERNS.push({ id: "test_stall_tail", severity: "low", name: "stall", find: () => (scans === 1 && stall(), []) });
    })()\`, context);
  }
  return out;
};
`,
  );
  try {
    const out = runNode(
      `const api = require("clotr-engine");
const text = "Write to person@example.test";
const results = api.detect(text);
const emails = results.filter((result) => result.id === "email");
process.stdout.write(JSON.stringify({ truncated: results.truncated === true, found: emails.length > 0, hidden: api.redact(text, emails) }));`,
      ["--require", preload, "-e"],
    );
    const { truncated, found, hidden } = JSON.parse(out);
    assert.equal(truncated, true);
    assert.equal(found, true);
    assert.doesNotMatch(hidden, /person@example\.test/);
  } finally {
    fs.rmSync(preload, { force: true });
  }
});

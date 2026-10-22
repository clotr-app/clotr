"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "engine-diff.js");
// Values go into the generated files as JSON, with the characters that could end a script or a line escaped too.
const CODE_ESCAPES = {
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};
const literal = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (c) => CODE_ESCAPES[c]);
const engineDiff = fs.existsSync(TOOL) ? require(TOOL) : null;
const { labelProbeRows, parseArgs } = engineDiff || {};

function toolTest(name, fn) {
  if (engineDiff) test(name, fn);
}

function fixture(t, text, match, replacement = match, { baseKind = "phone_number", newKind = baseKind } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-engine-diff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, contents) => {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  write(
    "extension/patterns.js",
    `globalThis.Clotr = { PATTERNS: [{ id: ${literal(baseKind)}, name: ${literal(baseKind)} }] };\n`,
  );
  const detector = (value, kind) => `globalThis.Clotr.detect = (text) => text.includes(${literal(match)}) ? [{
    id: ${literal(kind)}, name: ${literal(kind)}, severity: "medium", matches: [${literal(value)}]
  }] : [];\n`;
  write("extension/detector.js", detector(match, baseKind));
  write(
    "extension/decide.js",
    `globalThis.Clotr.mask = (value) => value.length <= 8 ? "•".repeat(value.length) : value.slice(0, 4) + "…" + value.slice(-2);\n`,
  );
  write("tests/corpus/normal-messages.txt", `# Made-up message\n---\n${text}\n`);
  write("tools/engine-diff-allow.json", "[]\n");
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "extension");
  git("commit", "-q", "-m", "Create the base engine");
  write("extension/detector.js", detector(replacement, newKind));
  return { dir, write };
}

function run(dir) {
  return spawnSync(process.execPath, [TOOL, "--base", "HEAD"], { cwd: dir, encoding: "utf8" });
}

toolTest("a silenced finding exits 1 and names its corpus row", (t) => {
  const sample = "555-555-0194";
  const { dir, write } = fixture(t, `Emergency contacts: ${sample}`, sample);
  write("extension/detector.js", "globalThis.Clotr.detect = () => [];\n");

  const result = run(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /normal-messages\.txt #1 phone_number/);
  assert.match(result.stdout, /555-…94/);
});

toolTest("an allowance requires and prints its reason", (t) => {
  const sample = "555-555-0194";
  const { dir, write } = fixture(t, `Emergency contacts: ${sample}`, sample);
  write("extension/detector.js", "globalThis.Clotr.detect = () => [];\n");
  write(
    "tools/engine-diff-allow.json",
    `${JSON.stringify([{ corpus: "normal-messages.txt", row: 1, kind: "phone_number", reason: "a false alarm removed on purpose" }], null, 2)}\n`,
  );

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /allowed: a false alarm removed on purpose/);
});

toolTest("a changed span is reported without failing", (t) => {
  const sample = "555-555-0194";
  const { dir } = fixture(t, `Phone: ${sample}`, sample, "555-555-019");

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /span changes:/);
  assert.match(result.stdout, /555-…94 → 555-…19/);
});

toolTest("a kind change at the same span is reported as renamed", (t) => {
  const sample = "same-span-value";
  const { dir } = fixture(t, `key: ${sample}`, sample, sample, {
    baseKind: "password",
    newKind: "developer_token",
  });

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /renamed:/);
  assert.match(result.stdout, /password \u2192 developer_token \(same\u2026ue\)/);
  assert.ok(result.stdout.includes("silenced:\n  (none)"));
  assert.match(result.stdout, /summary: 0 silenced \(0 unallowed, 0 allowed\), 1 renamed, 0 new, 0 span changes/);
});

toolTest("the default label probe samples 40 seeded words and full mode keeps the whole list", () => {
  const text = Array.from({ length: 200 }, (_, index) => `candidate${index}ts`).join(" ");
  const rows = [{ text }];
  const engine = { clotr: { PATTERNS: [], BANDAGE_WORDS: {} }, sources: { "patterns.js": "" } };
  const sample = labelProbeRows(engine, engine, rows);
  const repeated = labelProbeRows(engine, engine, rows);
  const full = labelProbeRows(engine, engine, rows, { full: true });
  const labels = (probeRows) => new Set(probeRows.map((row) => row.text.slice(0, row.text.indexOf(":"))));
  const sampleLabels = labels(sample);
  const fullLabels = labels(full);

  assert.equal(parseArgs([]).full, false);
  assert.equal(parseArgs(["--full"]).full, true);
  assert.deepEqual(sample, repeated);
  assert.equal(sampleLabels.size, 40);
  assert.ok(fullLabels.size > sampleLabels.size);
  assert.ok([...sampleLabels].every((word) => fullLabels.has(word)));
});

toolTest("a finding row prints a masked made-up key", (t) => {
  const sample = "AKIAIOSFODNN7EXAMPLE";
  const { dir, write } = fixture(t, `key: ${sample}`, sample);
  write("extension/detector.js", "globalThis.Clotr.detect = () => [];\n");

  const result = run(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(sample));
  assert.match(result.stdout, /AKIA…LE/);
});

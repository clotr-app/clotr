// Tests for tools/coverage.js, which measures how much of extension/ the tests run, line by line.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const {
  lineCoverage,
  extensionFile,
  browserFile,
  merge,
  mergeBrowserRun,
  foldBrowserFile,
  summary,
} = require("../tools/coverage.js");

const ROOT = path.join(__dirname, "..");

const SOURCE = [
  "function pick(n) {", // 1
  "  // a comment, never counted", // 2
  "  if (n > 1) {", // 3
  "    return 'big';", // 4
  "  }", // 5
  "", // 6
  "  return 'small';", // 7
  "}", // 8
  "pick(0);", // 9
].join("\n");
const at = (line) =>
  SOURCE.split("\n")
    .slice(0, line - 1)
    .join("\n").length + (line > 1 ? 1 : 0);

test("a line inside a block that never ran is uncovered; blank and comment lines aren't counted", () => {
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }] },
    {
      ranges: [
        { startOffset: 0, endOffset: at(9) - 1, count: 1 },
        { startOffset: at(3) + "  if (n > 1) ".length, endOffset: at(5) + 3, count: 0 },
      ],
    },
  ];
  const lines = lineCoverage(SOURCE, functions);
  assert.equal(lines[1], null, "the comment line is counted");
  assert.equal(lines[5], null, "the blank line is counted");
  assert.deepEqual(
    [0, 2, 3, 4, 6, 7, 8].map((i) => lines[i]),
    [true, true, false, false, true, true, true],
  );
});

test("a function that never ran leaves all of its lines uncovered", () => {
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }] },
    { ranges: [{ startOffset: 0, endOffset: at(9) - 1, count: 0 }] },
  ];
  const lines = lineCoverage(SOURCE, functions);
  assert.deepEqual(
    [0, 2, 3, 4, 6, 7].map((i) => lines[i]),
    [false, false, false, false, false, false],
  );
  assert.equal(lines[8], true, "the call after the function ran");
});

test("a script is matched to extension/ by its file URL, or by a bare name from the vm-loaded tests", () => {
  const real = path.join(ROOT, "extension", "patterns.js");
  assert.equal(extensionFile(pathToFileURL(real).href, ROOT), "extension/patterns.js");
  assert.equal(extensionFile("background.js", ROOT), "extension/background.js");
  assert.equal(extensionFile("evalmachine.<anonymous>", ROOT), null);
  assert.equal(extensionFile(pathToFileURL(path.join(ROOT, "tools", "package.js")).href, ROOT), null);
  assert.equal(extensionFile("node:fs", ROOT), null);
});

test("a line run in any test process counts as covered", () => {
  assert.deepEqual(merge([true, false, null, false], [false, false, null, true]), [true, false, null, true]);
  assert.deepEqual(merge(undefined, [false, true]), [false, true]);
});

test("a file no unit test loads counts as 0% of its lines in the total", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-coverage-"));
  try {
    fs.mkdirSync(path.join(dir, "extension"));
    fs.writeFileSync(path.join(dir, "extension", "seen.js"), "a();\nb();\n");
    fs.writeFileSync(path.join(dir, "extension", "unseen.js"), "c();\n// note\nd();\ne();\n");
    const rows = summary(dir, { "extension/seen.js": [true, false, null] });
    const unseen = rows.files.find((r) => r.file === "extension/unseen.js");
    assert.deepEqual([unseen.covered, unseen.total, unseen.loaded], [0, 3, false]);
    assert.deepEqual([rows.covered, rows.total], [1, 5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the lines come out right from a real V8 coverage run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-coverage-v8-"));
  try {
    const script = path.join(dir, "pick.js");
    fs.writeFileSync(script, SOURCE + "\n");
    const out = path.join(dir, "v8");
    const r = spawnSync(process.execPath, [script], { env: { ...process.env, NODE_V8_COVERAGE: out } });
    assert.equal(r.status, 0);
    const entry = fs
      .readdirSync(out)
      .flatMap((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).result)
      .find((e) => e.url === pathToFileURL(script).href);
    assert.ok(entry, "no coverage for the script");
    const lines = lineCoverage(SOURCE + "\n", entry.functions);
    assert.equal(lines[3], false, "the branch that never ran is covered");
    assert.equal(lines[6], true, "the branch that ran is uncovered");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser script counts for extension/ only when the copy it was loaded from reads the same as the file here", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-coverage-"));
  try {
    fs.mkdirSync(path.join(dir, "extension", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extension", "page.js"), "a();\n");
    fs.writeFileSync(path.join(dir, "extension", "sub", "deep.js"), "b();\n");
    fs.mkdirSync(path.join(dir, "copy"));
    fs.writeFileSync(path.join(dir, "copy", "page.js"), "a();\n");
    fs.mkdirSync(path.join(dir, "changed"));
    fs.writeFileSync(path.join(dir, "changed", "page.js"), "changed();\n");
    const [id, copy, changed, unknown] = ["a", "b", "c", "d"].map((c) => c.repeat(32));
    const dirs = new Map([
      [id, path.join(dir, "extension")],
      [copy, path.join(dir, "copy")],
      [changed, path.join(dir, "changed")],
    ]);
    assert.equal(browserFile(`chrome-extension://${id}/page.js`, dirs, dir), "extension/page.js");
    assert.equal(browserFile(`chrome-extension://${id}/sub/deep.js`, dirs, dir), "extension/sub/deep.js");
    assert.equal(browserFile(`chrome-extension://${copy}/page.js`, dirs, dir), "extension/page.js");
    assert.equal(browserFile(`chrome-extension://${copy}/sub/deep.js`, dirs, dir), null, "a file the copy lacks");
    assert.equal(browserFile(`chrome-extension://${changed}/page.js`, dirs, dir), null, "a copy that differs");
    assert.equal(browserFile(`chrome-extension://${unknown}/page.js`, dirs, dir), null, "another extension");
    assert.equal(browserFile(`chrome-extension://${id}/gone.js`, dirs, dir), null);
    assert.equal(browserFile("https://chatgpt.com/page.js", dirs, dir), null);
    assert.equal(browserFile(`chrome-extension://${id}/../page.js`, dirs, dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the all-on build's saved run folds into the plain build's file, a line run by either counting as run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-coverage-"));
  try {
    const target = path.join(dir, "plain.json");
    const extra = path.join(dir, "all-on.json");
    fs.writeFileSync(
      target,
      JSON.stringify({ lines: { "extension/lookback.js": [false, false, null], "extension/a.js": [true] } }),
    );
    fs.writeFileSync(extra, JSON.stringify({ lines: { "extension/lookback.js": [true, false, null] } }));
    foldBrowserFile(target, extra);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
      lines: { "extension/lookback.js": [true, false, null], "extension/a.js": [true] },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved browser run merges into the unit tests' lines, a line run by either counting as run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-coverage-"));
  try {
    const file = path.join(dir, "e2e.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ lines: { "extension/a.js": [false, true, null], "extension/b.js": [true] } }),
    );
    const byFile = mergeBrowserRun({ "extension/a.js": [true, false, null] }, file);
    assert.deepEqual(byFile, { "extension/a.js": [true, true, null], "extension/b.js": [true] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

"use strict";

// push(...list) passes every value as its own argument, and a long enough list (about 120,000 values) overflows the
// stack, which stops every warning in that paste. The code that handles what a page or a paste controls appends in
// a loop instead (1.5.0 security review, F1 and L4).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FILES = ["content.js", "detector.js", "editor.js", "patterns.js"];

test("the scan code never spreads a list into push()", () => {
  for (const name of FILES) {
    const source = fs.readFileSync(path.join(__dirname, "..", "extension", name), "utf8");
    const lines = source
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\.push\(\s*\.\.\./.test(line));
    assert.deepEqual(lines, [], `${name} spreads into push() at line ${lines.map(([n]) => n).join(", ")}`);
  }
});

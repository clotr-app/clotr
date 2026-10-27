// The patterns that tell a reply from a forward in an email app run on the whole quoted message at every scan.
// A sender controls that text, so each one has to stay linear on any input: a message made of blank lines once
// cost seconds a scan. The patterns live inside the content script's closure, so this reads them out of the
// source the way patterns.test.js reads its own.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bestOfPair, grewMoreThan } = require("./timing.js");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

function patternNamed(name) {
  const m = new RegExp(`const ${name} =\\s*/((?:\\\\.|[^/\\n])+)/([a-z]*);`).exec(source);
  assert.ok(m, `${name} not found in content.js`);
  return new RegExp(m[1], m[2]);
}

const shapes = {
  "newline and space": "\n ".repeat(50000),
  "newline and tab": "\n\t".repeat(50000),
  "no-break space and newline": "\u00a0\n".repeat(50000),
  "blank lines with a dash": "- \n".repeat(40000),
};

for (const name of ["FORWARD_WORDS", "GMAIL_FORWARD_HEADER"]) {
  test(`${name} grows in step with blank-line text`, () => {
    const pattern = patternNamed(name);
    for (const [shape, text] of Object.entries(shapes)) {
      const small = text.slice(0, Math.floor(text.length / 4));
      const [a, b] = bestOfPair(
        () => pattern.test(small),
        () => pattern.test(text),
        4,
      );
      assert.ok(!grewMoreThan(a, b, 16), `${name} grew too fast on ${shape}`);
    }
  });
}

test("FORWARD_WORDS still finds a forward and leaves a reply alone", () => {
  const pattern = patternNamed("FORWARD_WORDS");
  for (const text of [
    "---------- Forwarded message ---------\nFrom: someone",
    "Begin forwarded message:",
    "Subject: Fwd: the notes",
    "Subject : FW: the notes",
    "Hi,\n  Fwd: see below",
    "Hola,\nMensaje reenviado",
  ]) {
    assert.ok(pattern.test(text), `not read as a forward: ${JSON.stringify(text)}`);
  }
  for (const text of ["On Monday, Someone wrote:\n> the old message", "Thanks for the forward of the parcel"]) {
    assert.ok(!pattern.test(text), `read as a forward: ${JSON.stringify(text)}`);
  }
});

// A password's own .value (db.password.value=…) is the password, so it's read like db.password=… The values are
// made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const passwords = (text) =>
  detect(text)
    .filter((result) => result.id === "password")
    .flatMap((result) => result.matches);

test("a password under .value is found", () => {
  for (const [text, value] of [
    ["db.password.value=abcdef12", "abcdef12"],
    ["db.password.value=changeme123", "changeme123"],
    ["db.password.value=3638tiger", "3638tiger"],
    ["`db.password.value=3638tiger`", "3638tiger"],
    ['Set `db.password.value: "maple_2093"` in the config.', "maple_2093"],
    ["db.passwd.value=river_7781", "river_7781"],
  ]) {
    assert.deepEqual(passwords(text), [value], text);
  }
});

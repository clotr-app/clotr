// A session or auth key that looks like a stored key ("sessionKey: …") is found, as other key names are. The values
// are made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

test("a session or auth key is found", () => {
  const session = ["A7!qP2", "#vL9@", "xR4$m"].join("");
  const auth = ["Zq8mR2", "!xK7pW", "4nL9"].join("");
  for (const [text, value] of [
    [`sessionKey: ${session}`, session],
    [`config:\n  sessionKey: ${session}`, session],
    [`authKey: ${auth}`, auth],
  ]) {
    const found = detect(text).flatMap((result) => result.matches);
    assert.ok(found.includes(value), `${text.split(":")[0]}: ${found.length} found`);
  }
});

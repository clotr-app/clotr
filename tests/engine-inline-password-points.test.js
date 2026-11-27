// Under a password's dotted .ref, .arn or .reference name in inline code, a password written as two camelCase words
// or as a word and one digit is found, as it is under the password's own name. The value is found without the
// closing backticks.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const passwordValues = (text) =>
  detect(text)
    .filter((result) => result.group === "credentials")
    .flatMap((result) => result.matches);

// Made-up values, joined from pieces at run time.
const join = (...parts) => parts.join("");
const WRAPPERS = [
  ["=", (name, value) => "Then run it with `" + name + "=" + value + "` set."],
  [":", (name, value) => "Set `" + name + ": " + value + "` in the config and restart."],
];
const VALUES = [
  join("purple", "Mon", "key"),
  join("gato", "Ne", "gro"),
  join("sunny", "Bea", "ch"),
  join("sun", "shine", "1"),
  join("dragon", "5"),
  join("jordan", "-", "4"),
];
const NAMES = ["db.password.ref", "db.password.arn", "db.password.reference", "admin.pass.ref", "db.clave.ref"];

for (const value of VALUES) {
  for (const name of NAMES) {
    for (const [sign, wrap] of WRAPPERS) {
      test(`a password under ${name} with ${sign} in inline code is found: ${value.slice(0, 3)}..`, () => {
        const found = passwordValues(wrap(name, value));
        assert.ok(found.includes(value), `found ${found.length} value(s), none the password`);
        assert.ok(!found.some((match) => match.includes("`")), "a backtick was kept on the value");
      });
    }
  }
}

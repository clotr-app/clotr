// A password setting written in inline code in a sentence, like "Set `db.password.value=…` first", is still read
// when its value is a word and a number or two words in camelCase. The value is found without the closing backticks.
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
const VALUES = [
  ["word and number", ["jordan", "-", "4417"].join("")],
  ["word and number", ["maple", "_", "2093"].join("")],
  ["word and number", ["falcon", "-", "6188"].join("")],
  ["camelCase words", ["my", "Monkey"].join("")],
  ["camelCase words", ["top", "Secret"].join("")],
  ["camelCase words", ["big", "Shadow"].join("")],
];
const NAMES = ["db.password.value", "password", "db_pin_ref", "admin.password.value"];
const WRAPPERS = [
  ["=", (name, value) => "Then run it with `" + name + "=" + value + "` set."],
  [":", (name, value) => "Set `" + name + ": " + value + "` in the config and restart."],
];

for (const [shape, value] of VALUES) {
  for (const name of NAMES) {
    for (const [sign, wrap] of WRAPPERS) {
      test(`${shape} under ${name} with ${sign} in inline code is found without its backtick`, () => {
        const found = passwordValues(wrap(name, value));
        assert.ok(found.includes(value), `found ${found.length} value(s), none the password`);
        assert.ok(!found.some((match) => match.includes("`")), "a backtick was kept on the value");
      });
    }
  }
}

// The same settings with a setting word stay quiet.
for (const word of ["true", "required", "auto", "write", "none", "optional"]) {
  for (const name of NAMES) {
    test(`a setting word under ${name} in inline code stays quiet: ${word}`, () => {
      assert.deepEqual(passwordValues("Set `" + name + ": " + word + "` in the config."), []);
    });
  }
}

// A name in code or a type in the same place stays quiet, as it does without the backticks.
for (const value of ["secretKeyRef", "hashedPassword", "passwordInput", "SecretStr", "getPassword()"]) {
  for (const name of ["pw_value", "secret_arn", "token_ref", "access_token.value", "PASSWD_ARN"]) {
    test(`a code name under ${name} in inline code stays quiet: ${value}`, () => {
      assert.deepEqual(passwordValues("Set `" + name + ": " + value + "` in the config and restart."), []);
      assert.deepEqual(passwordValues("Then run it with `" + name + "=" + value + "` set."), []);
    });
  }
}

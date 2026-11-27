// A password setting in inline code is read by its name. Under a password's name, a camelCase phrase that ends in
// Secret ("ourSecret") is the password, and under a password's .ref or .arn name a word and a year is too. The value
// is found without the closing backticks. A code name under .ref stays quiet.
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
const CASES = [
  [join("our", "Se", "cret"), ["password", "db_password", "DB_PASSWORD", "pwd", "db.password.value", "db.clave.value"]],
  [join("sweet", "Se", "cret"), ["passwd", "admin.pass.value", "db.password.ref", "db.password.arn"]],
  [join("nana", "Se", "cret"), ["password", "admin.pass.ref", "password_ref", "DB_PASS_ARN"]],
  [join("maple", "19", "90"), ["db.password.ref", "admin.pass.ref", "db.password.arn", "db.clave.ref"]],
  [join("jordan", "-", "20", "11"), ["db.password.ref", "db.pwd.arn"]],
];

for (const [value, names] of CASES) {
  for (const name of names) {
    for (const [sign, wrap] of WRAPPERS) {
      test(`a password under ${name} with ${sign} in inline code is found: ${value.slice(0, 3)}..`, () => {
        const found = passwordValues(wrap(name, value));
        assert.ok(found.includes(value), `found ${found.length} value(s), none the password`);
        assert.ok(!found.some((match) => match.includes("`")), "a backtick was kept on the value");
      });
    }
  }
}

// A value that says where the secret is kept stays quiet under .ref and .arn, as do a code name and a setting word.
const QUIET = [
  join("use", "Memo"),
  join("config", "Map"),
  "vault/prod/db",
  "op://vault/db/password",
  "${DB_PASS}",
  "true",
  "required",
  "auto",
];
for (const value of QUIET) {
  for (const name of ["db.password.ref", "admin.pass.arn"]) {
    test(`a reference or code name under ${name} in inline code stays quiet: ${value}`, () => {
      for (const [, wrap] of WRAPPERS) assert.deepEqual(passwordValues(wrap(name, value)), [], wrap(name, value));
    });
  }
}

// Under a secret's or a token's name, a camelCase name ending in Secret still names one.
for (const name of ["secret", "client_secret", "token", "api_token"]) {
  test(`a Secret name under ${name} in inline code stays quiet`, () => {
    for (const [, wrap] of WRAPPERS) {
      for (const value of [join("client", "Secret"), join("jwt", "Secret")]) {
        assert.deepEqual(passwordValues(wrap(name, value)), [], wrap(name, value));
      }
    }
  });
}

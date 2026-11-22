// A setting in inline code whose value is a short code word with a number ("md5", "kv2"), a camelCase name that ends
// in Secret under a secret's or a token's name ("jwtSecret"), or a code name under a .value name ("token.value: useState") stays quiet, as the same
// setting does when it is read without a second look at its closing backticks.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect } = globalThis.Clotr;

const credentials = (text) => detect(text).filter((result) => result.group === "credentials");

// Made-up words, joined from pieces at run time.
const join = (...parts) => parts.join("");
const SHORT_WORDS = [join("md", "5"), join("kv", "2"), join("oauth", "2"), join("ec", "2"), join("rc", "1")];
const SECRET_NAMES = [join("client", "Secret"), join("jwt", "Secret"), join("app", "Secret")];
const DOT_VALUE_NAMES = [join("use", "State"), join("config", "Map"), join("staging", "2"), join("release-", "2026")];
const NAMES = ["password", "secret", "token", "db_password", "client_secret"];
const WRAPPERS = [
  (name, value) => "Then run it with `" + name + "=" + value + "` set.",
  (name, value) => "Set `" + name + ": " + value + "` in the config and restart.",
  (name, value) => "Repro: with `" + name + "=" + value + "` the login page 500s.",
];

// Under a password's own name a camelCase value ending in Secret is read as the password, so those names are
// checked with the short words only.
const PASSWORD_NAMES = new Set(["password", "db_password"]);
for (const value of [...SHORT_WORDS, ...SECRET_NAMES]) {
  for (const name of NAMES) {
    if (SECRET_NAMES.includes(value) && PASSWORD_NAMES.has(name)) continue;
    test(`a code word under ${name} in inline code stays quiet: ${value}`, () => {
      for (const wrap of WRAPPERS) assert.deepEqual(credentials(wrap(name, value)), [], wrap(name, value));
    });
  }
}

for (const value of DOT_VALUE_NAMES) {
  test(`a code name under token.value in inline code stays quiet: ${value}`, () => {
    for (const wrap of WRAPPERS) {
      assert.deepEqual(credentials(wrap("token.value", value)), [], wrap("token.value", value));
    }
  });
}

test("real config lines with a short code word in inline code stay quiet", () => {
  for (const text of [
    "In postgresql.conf, set `password_encryption = " + join("md", "5") + "` for the old clients.",
    "Vault mounts it with `secret_engine: " + join("kv", "2") + "`.",
    "We use `auth_token: " + join("oauth", "2") + "` in the gateway config.",
    "Set `secret_backend: " + join("ec", "2") + "` on the role.",
    "Pass `secret: " + join("jwt", "Secret") + "` into the middleware.",
    "Set `token.value: " + join("use", "State") + "` there.",
  ]) {
    assert.deepEqual(credentials(text), [], text);
  }
});

// Under .ref or .arn the value names where the secret is kept, so a code name there stays quiet too.
for (const name of ["password.ref", "db.password.arn"]) {
  test(`a code name under ${name} in inline code stays quiet`, () => {
    for (const wrap of WRAPPERS) {
      const text = wrap(name, join("use", "Memo"));
      assert.deepEqual(credentials(text), [], text);
    }
  });
}

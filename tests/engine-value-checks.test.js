// A typed password is judged by its whole value, so one that only sounds fake ("example123!") is found, while a
// test login in a curl command stays quiet. A password in inline code stops before the closing backtick. Words after
// any secret's label read as a passphrase, under a password's ref name too, unless they name where it's kept. All
// values are made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const passwords = (text) =>
  detect(text)
    .filter((result) => result.id === "password")
    .flatMap((result) => result.matches);

test("a typed password that only sounds fake is found", () => {
  for (const value of ["example123!", "aaaaaa1!", "xxxxxx99"]) {
    assert.deepEqual(passwords(`password: ${value}`), [value], value);
  }
});

test("a test login in a curl command stays quiet", () => {
  for (const value of ["test_pass_42", "demo-Secret-7"]) {
    assert.deepEqual(passwords("`curl -u admin:" + value + "`"), [], value);
  }
});

test("the word password typed as a password is found", () => {
  assert.deepEqual(passwords("my password is password"), ["password"]);
  assert.deepEqual(passwords("DB_PASSWORD=Password"), ["Password"]);
});

test("a password in inline code stops before the closing backtick", () => {
  for (const value of ["abcdef12", "your_password1"]) {
    assert.deepEqual(passwords("`curl -u admin:" + value + "`"), [value], value);
  }
});

test("words after a secret's label read as a passphrase", () => {
  const phrase = ["purple", "monkey", "dishwasher", "sunset"].join(" ");
  for (const label of ["secret: ", "client_secret: ", "SECRET=", "api_key: ", "token: ", "password: "]) {
    assert.deepEqual(passwords(label + phrase), [phrase], label);
  }
});

// A name ending in ref, reference or arn says where a password is kept, so a pointer there stays quiet. Separate
// words are still a passphrase, as on 1.6.3.
test("separate words under a password's ref name read as a passphrase", () => {
  const phrase = ["correct", "horse", "battery", "staple"].join(" ");
  for (const label of [
    "db_password_ref: ",
    "password_ref: ",
    "db_password_ref = ",
    "DB_PASSWORD_REF=",
    "  password_ref: ",
    "db_password_arn: ",
    "db_password_reference: ",
  ]) {
    assert.deepEqual(passwords(label + phrase), [phrase], label);
  }
});

test("a pointer or a named place under a password's ref name stays quiet", () => {
  for (const text of [
    "db_password_ref: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf",
    "db_password_ref: ${DB_PASSWORD}",
    "DbPasswordRef: !Ref DbPass",
    "password_ref: prod_db_password",
    "db_password_ref: the prod database password",
    "password_ref: prod database password",
    "password_ref: main postgres password",
    "password_ref: payments service secret",
    "password_ref: orders vault entry",
  ]) {
    assert.deepEqual(passwords(text), [], text);
  }
});

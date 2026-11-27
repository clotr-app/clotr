// After "what … my password is.", a sign-off like "Thanks!" ends the message; it isn't the password. Any other word
// there ("Sunshine!") still is.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const passwords = (text) =>
  detect(text)
    .filter((result) => result.id === "password")
    .flatMap((result) => result.matches);

test("a sign-off after a question about a password is quiet", () => {
  for (const text of [
    "I forgot what my password is. Thanks!",
    "I forgot what my password was. Thanks!",
    "Do you know what the wifi password is. Cheers!",
  ]) {
    assert.deepEqual(passwords(text), [], text);
  }
});

test("any other word after the question is still the password", () => {
  for (const [text, value] of [
    ["remind me what my password is. Sunshine!", "Sunshine!"],
    ["Do you know what the wifi password is. Xyzzy!!", "Xyzzy!!"],
  ]) {
    assert.deepEqual(passwords(text), [value], text);
  }
});

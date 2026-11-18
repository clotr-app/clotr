// The npm package's detect() is called from other people's code, so input that isn't text gives an empty result,
// the same way redact() already returns "" for it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The package loads its built bundle, which git ignores. A fresh checkout (or the public export) builds it here, as
// `npm run engine-bundle` would.
const { write, OUT } = require("../tools/engine-bundle.js");
if (!fs.existsSync(OUT)) write();

const api = require(path.join(__dirname, "..", "apps", "engine", "index.cjs"));

const NOT_TEXT = [
  ["undefined", undefined],
  ["null", null],
  ["an array", ["person@example.test"]],
  ["a number", 4111111111111111],
  ["an object", { text: "person@example.test" }],
  ["a boolean", true],
];

for (const [label, value] of NOT_TEXT) {
  test(`detect() of ${label} returns an empty array`, () => {
    let results;
    assert.doesNotThrow(() => {
      results = api.detect(value);
    });
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0);
  });
}

test("detect() with nothing at all returns an empty array", () => {
  let results;
  assert.doesNotThrow(() => {
    results = api.detect();
  });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test("detect() of text still finds what it found before", () => {
  assert.equal(api.detect("").length, 0);
  const results = api.detect("Write to person@example.test");
  assert.ok(results.some((result) => result.id === "email" && result.matches.includes("person@example.test")));
});

const WRAPPED = [
  ["an email", "Write to person@example.test"],
  ["a made-up AWS key", "key AKIA4HPQ7XZ2R6TWLJ3N"],
];

for (const [label, text] of WRAPPED) {
  test(`detect() of a String object with ${label} finds what the plain text finds`, () => {
    const plain = api.detect(text).map(({ id, matches }) => ({ id, matches }));
    assert.ok(plain.length > 0);
    const wrapped = api.detect(new String(text)).map(({ id, matches }) => ({ id, matches }));
    assert.deepEqual(wrapped, plain);
  });
}

test("detect() of a String object from another realm finds what the plain text finds", () => {
  const text = "Write to person@example.test";
  const other = require("node:vm").runInNewContext("new String(t)", { t: text });
  const ids = (results) => results.map(({ id, matches }) => ({ id, matches }));
  assert.deepEqual(ids(api.detect(other)), ids(api.detect(text)));
});

// A String object is turned into text the way String() does it, so its own toString or Symbol.toPrimitive counts,
// as it did before. The key below is made up.
const MAIL = "mail person@example.test";
const KEY = "key AKIA4HPQ7XZ2R6TWLJ3N";
const found = (results) => results.map(({ id, severity, matches }) => ({ id, severity, matches }));

test("detect() of a String object with its own toString finds what that toString returns", () => {
  const value = new String(MAIL);
  value.toString = () => KEY;
  assert.deepEqual(found(api.detect(value)), found(api.detect(KEY)));
  assert.ok(api.detect(value).some((result) => result.id === "aws_access_key" && result.severity === "high"));
});

test("detect() of a String object with its own Symbol.toPrimitive finds what it returns", () => {
  const value = new String(MAIL);
  value[Symbol.toPrimitive] = () => KEY;
  assert.deepEqual(found(api.detect(value)), found(api.detect(KEY)));
});

test("detect() of a String object whose toString throws still finds the text it holds", () => {
  const value = new String(MAIL);
  value.toString = () => {
    throw new Error("made-up failure");
  };
  assert.deepEqual(found(api.detect(value)), found(api.detect(MAIL)));
  assert.ok(api.detect(value).some((result) => result.id === "email"));
});

test("detect() of a plain object that fakes the String tag returns an empty array", () => {
  const value = { [Symbol.toStringTag]: "String", toString: () => MAIL, valueOf: () => MAIL };
  assert.equal(api.detect(value).length, 0);
});

test("detect() runs none of the caller's code that the last release didn't run", () => {
  let calls = 0;
  const plain = {
    valueOf() {
      calls++;
      return MAIL;
    },
  };
  assert.equal(api.detect(plain).length, 0);
  const boxed = new String(MAIL);
  boxed.valueOf = () => {
    calls++;
    return KEY;
  };
  Object.defineProperty(boxed, "constructor", {
    get() {
      calls++;
      return String;
    },
  });
  assert.deepEqual(found(api.detect(boxed)), found(api.detect(MAIL)));
  assert.equal(calls, 0);
});

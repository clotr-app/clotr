// mask() takes one string. It used to read value.length and value.slice and nothing else, so an array or an object
// with a length came back as dots or, for a longer array, with its items shown whole. Anything that isn't a string
// now throws a TypeError. A string with no kind gets the rule for any other value, at most a quarter of it shown
// (mask-kind.test.js covers the kinds). The bundle the apps load (tools/engine-bundle.js) has to agree on every
// input.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

require("./load-engine.js")("rules", "detect", "decide");
const { build } = require("../tools/engine-bundle.js");
const { mask } = globalThis.Clotr;

const letters = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
const FORTY = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const TYPE_ERROR = { throws: "TypeError" };

// What mask gives, or the name of what it throws. By name, since the bundle's errors come from another realm.
function outcome(fn, value) {
  try {
    return { gives: fn(value) };
  } catch (e) {
    return { throws: e.name };
  }
}

const CASES = [
  // Strings, with no kind.
  ["a made-up 20-character key", "AKIA4HPQ7XZ2R6TWLJ3N", { gives: "AK…3N" }],
  ["8 characters", "12345678", { gives: "••••••••" }],
  ["an empty string", "", { gives: "" }],
  ["one character", "a", { gives: "•" }],
  ["9 characters", "123456789", { gives: "1…9" }],
  ["40 characters", FORTY, { gives: "ab…CD" }],
  // These threw a TypeError already, and still do.
  ["a number", 12345, TYPE_ERROR],
  ["true", true, TYPE_ERROR],
  ["null", null, TYPE_ERROR],
  ["undefined", undefined, TYPE_ERROR],
  ["{}", {}, TYPE_ERROR],
  ["a symbol", Symbol("x"), TYPE_ERROR],
  ["{ length: 9 }", { length: 9 }, TYPE_ERROR],
  ["{ length: 20 }", { length: 20 }, TYPE_ERROR],
  ["{ length: NaN }", { length: NaN }, TYPE_ERROR],
  // These came back as dots or shown whole, or threw the wrong error.
  ["{ length: 0 }", { length: 0 }, TYPE_ERROR],
  ["{ length: 3 }", { length: 3 }, TYPE_ERROR],
  ["{ length: 8 }", { length: 8 }, TYPE_ERROR],
  ["{ length: 2.5 }", { length: 2.5 }, TYPE_ERROR],
  ["{ length: -1 }", { length: -1 }, TYPE_ERROR],
  ["[]", [], TYPE_ERROR],
  ["[1, 2, 3]", [1, 2, 3], TYPE_ERROR],
  ["an array of 9 strings", letters(9), TYPE_ERROR],
  ["an array of 10 strings", letters(10), TYPE_ERROR],
];

for (const [label, value, want] of CASES) {
  test(`mask: ${label}`, () => {
    assert.deepEqual(outcome(mask, value), want);
  });
}

test("Clotr.mask in the engine bundle gives the same answer as the extension's mask on every input", () => {
  const context = vm.createContext({});
  vm.runInContext(build().text, context, { filename: "clotr-engine.js" });
  const bundled = vm.runInContext("globalThis.Clotr.mask", context);
  for (const [label, value] of CASES) {
    assert.deepEqual(outcome(bundled, value), outcome(mask, value), label);
  }
});

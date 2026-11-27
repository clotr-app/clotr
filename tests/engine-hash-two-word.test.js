// A weak password with "#" and a secret word after it, under a camelCase password setting, is found as on 1.6.2
// when the part before "#" has two parts (dogs-rule#password1) or the key after it has two words (welcome#pass_1).
// Every value here is made up and built in parts.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");

const Clotr = globalThis.Clotr;

const SETTINGS = ["dbPassword", "adminPassword", "rootPassword", "redisPassword", "clientSecret", "accessToken"];

// One line, one level down, quoted and JSON.
const fourWays = (name, value) => [
  `${name}: ${value}`,
  `config:\n  ${name}: ${value}`,
  `auth:\n  ${name}: "${value}"`,
  `{"app": {"${name}": "${value}"}}`,
];

// The texts whose value no finding holds, or whose value Hide it leaves behind.
function missed(values) {
  const out = [];
  for (const name of SETTINGS) {
    for (const value of values) {
      for (const text of fourWays(name, value)) {
        const found = Clotr.detect(text);
        const held = found.some((f) => (f.matches || []).some((m) => m.includes(value)));
        if (!held || Clotr.redact(text, found).includes(value)) out.push(text);
      }
    }
  }
  return out;
}

test("a password with a two-part head before # under a camelCase password setting is found", () => {
  const values = ["dogs-" + "rule#password1", "my_" + "dog#pw1", "blue." + "sky#pass1", "mary-" + "jane#Pass1"];
  assert.deepEqual(missed(values), []);
});

test("a password with a two-word key after # under a camelCase password setting is found", () => {
  const values = ["welcome" + "#pass_1", "hello" + "#passWord1", "summer" + "#Pass-2024", "iloveyou" + "#my-pass2"];
  assert.deepEqual(missed(values), []);
});

// Two backup or recovery labels joined by "and" or "and the", then a colon or a verb, then a lone year or count
// and a short word that starts a sentence, as in "my backup codes and recovery codes: 2024 is when I printed
// them", are a sentence about codes and stay quiet, as they do after one label. The same labels with real codes
// after them still have every code found and covered.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

// Numbers and made-up codes, built from pieces so no whole value sits in this file.
const join = (...parts) => parts.join("");
const YEAR = join("20", "24");
const COUNT = join("8", "47");
const CODES = {
  A: ["158", "364"],
  B: ["5821", " ", "0937"],
  C: ["kq7m", "-", "x4rt"],
  D: ["48", "29"],
  E: ["90", "27", "31"],
};
const fill = (template) => template.replace(/\{([A-E])\}/g, (_, key) => CODES[key].join(""));
const used = (template) => [...template.matchAll(/\{([A-E])\}/g)].map((m) => CODES[m[1]].join(""));

const QUIET = [
  `my backup codes and recovery codes: ${YEAR} is when I printed them`,
  `I lost my two-factor codes and recovery codes is: ${YEAR} is the year I printed them`,
  `the 2fa code and the claves de recuperación was ${COUNT} is the year I printed them`,
  `my 2fa codes and códigos de respaldo are ${YEAR} of them are left`,
  `mfa key and the recovery codes: ${COUNT} is the year I printed them`,
  `the backup code and mfa key is ${YEAR} of them are left`,
];

for (const text of QUIET) {
  test(`two joined labels before a lone number and a short word stay quiet: ${text}`, () => {
    assert.deepEqual(detect(text), []);
  });
}

const LISTS = [
  "backup code and recovery code: {A}",
  "backup code and recovery code: {A} is mine",
  "backup code and recovery code: {D}",
  "my backup codes and recovery codes: {B} is mine",
  "backup codes and the recovery codes: {C} is it",
  "backup code and recovery code: {D}, {E}",
  "recovery code {D} and backup code {E}",
  "backup codes {D} or recovery key {E}",
];

for (const template of LISTS) {
  const text = fill(template);
  test(`every code after two joined labels is found and covered: ${template}`, () => {
    const results = detect(text);
    assert.ok(results.length > 0, "a warning");
    const out = redact(text, results);
    for (const code of used(template)) {
      assert.ok(!out.includes(code), `a code survived Cover it: ${template}`);
    }
  });
}

test("a two-factor code and a backup code still read as two codes", () => {
  const text = join("two-factor code ", CODES.E.join(""), ", backup code: ", CODES.A.join(""));
  const out = redact(text, detect(text));
  assert.ok(!out.includes(CODES.E.join("")));
  assert.ok(!out.includes(CODES.A.join("")));
});

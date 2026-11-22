// Two backup or recovery labels joined by "and", then a colon or "is", then a year or a small number, then a comma
// or a space and a long or accented word, as in "backup codes and recovery codes: 2003, remaining" or "...: 2000
// más", are a sentence about codes and stay quiet. The same labels with real codes after them still have every
// code found and covered.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect, redact } = globalThis.Clotr;

// Numbers and made-up codes, built from pieces so no whole value sits in this file.
const join = (...parts) => parts.join("");
const NUMS = { YA: ["20", "03"], YB: ["20", "00"], YC: ["19", "99"], NA: ["3", "71"], NB: ["8", "03"], NC: ["1", "4"] };
const CODES = {
  A: ["158", "364"],
  B: ["5821", " ", "0937"],
  C: ["kq7m", "-", "x4rt"],
  D: ["48", "29"],
  E: ["90", "27", "31"],
  F: ["7k4m", "q2x9"],
  G: ["4417", "2093", "61"],
};
const fill = (template, set) => template.replace(/\{([A-Z]+)\}/g, (_, key) => set[key].join(""));
const used = (template) => [...template.matchAll(/\{([A-Z])\}/g)].map((m) => CODES[m[1]].join(""));

const QUIET = [
  "backup codes and recovery codes: {YA}, remaining",
  "backup codes and recovery codes: {YB} más",
  "recovery codes and mfa codes is: {YA} más",
  "my backup codes and the recovery keys is {YC}, approximately",
  "backup codes and recovery codes are: {YC}, somewhere",
  "backup codes and recovery codes is {YC}, más",
  "the 2fa codes and backup codes is {YB}, también",
  "my backup codes and the recovery keys is: {NA}, somewhere",
  "my backup codes and the recovery keys: {NB} aún",
  "códigos de respaldo and claves de recuperación: {YA}, después",
  "backup codes and recovery codes: {NC}, pequeño",
  "backup codes and recovery codes: {YB} über",
];

for (const template of QUIET) {
  const text = fill(template, NUMS);
  test(`joined labels before a number and a long or accented word stay quiet: ${template}`, () => {
    assert.deepEqual(detect(text), []);
  });
}

const LISTS = [
  "backup codes and recovery codes: {A}, remaining",
  "backup codes and recovery codes: {B} más",
  "backup codes and recovery codes: {C}, también",
  "backup codes and recovery codes: {F}, approximately",
  "backup codes and recovery codes: {G} más",
  "backup code and recovery code: {D}",
  "backup code and recovery code: {D}, {E}",
  "códigos de respaldo and claves de recuperación: {A}, {E}, después",
];

for (const template of LISTS) {
  const text = fill(template, CODES);
  test(`every code after joined labels and before a long word is covered: ${template}`, () => {
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

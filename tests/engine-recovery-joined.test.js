// Two backup or recovery labels joined by "and", then "is" or a colon, then words and a number, as in
// "my backup codes and two-factor codes: not working since 2024", are a sentence about codes and stay quiet.
// The same labels with real codes after them still have every code found and covered.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

// Numbers and made-up codes, built from pieces so no whole value sits in this file.
const join = (...parts) => parts.join("");
const YEAR = join("20", "24");
const STAFF = join("2", "50");
const CODES = {
  A: ["kq7m", "-", "x4rt"],
  B: ["5821", " ", "0937"],
  C: ["HW3PN", "-", "8KD2Q"],
  D: ["ycgh", "-", "swdt"],
  E: ["7261", "3225"],
  // A code of letters only.
  F: ["kxeb", "ehur"],
  G: ["63", "18"],
};
const fill = (template) => template.replace(/\{([A-G])\}/g, (_, key) => CODES[key].join(""));
const used = (template) => [...template.matchAll(/\{([A-G])\}/g)].map((m) => CODES[m[1]].join(""));

const QUIET = [
  `my backup codes and two-factor codes: not working since ${YEAR}`,
  `my backup code and two-factor code is not working since ${YEAR}`,
  `my 2fa code and backup code is not working since ${YEAR}`,
  `Our 2fa codes and backup codes: reset for all ${STAFF} staff after the audit`,
  `my recovery keys and mfa codes: lost in ${YEAR}`,
  `the backup codes and the recovery codes: expire after ${STAFF} days`,
  // Three labels, or a Spanish second label read as words.
  `the mfa key and the two-factor codes, and recovery keys is here ${STAFF} staff`,
  `my backup codes and the claves de recuperación: not working since ${YEAR}`,
  // The number first, then words.
  `my backup codes and two-factor codes: ${YEAR} was when they stopped working`,
];

for (const text of QUIET) {
  test(`two joined labels before words and a number stay quiet: ${text}`, () => {
    assert.deepEqual(detect(text), []);
  });
}

const LISTS = [
  "my backup codes and two-factor codes: {A}, {B}",
  "backup codes and recovery codes: {B}, {C}",
  "my 2fa code and backup code is {A}",
  "backup codes and recovery codes: here {A} {C}",
  "my recovery keys and backup codes: here {B} staff",
  "my backup codes and recovery codes: new {E} staff",
  "backup codes and códigos de respaldo: here {B}",
  "recovery key and the códigos de respaldo is new {B}",
  "recovery code {A} and backup code {B}",
  "backup code {D} or backup code {B}",
  "two-factor codes: {D} and recovery code {B}",
  // A code with no digit, after labels where "2fa" holds one.
  "my mfa codes and the backup code, 2fa code were {D} after the audit",
  "backup codes {F}, backup code: {B}",
  "two-factor codes: {F}, backup code: {E}",
  "backup codes are {E}, {A}, backup code: {F}, {G}",
];

for (const template of LISTS) {
  test(`codes after two joined labels are covered: ${template}`, () => {
    const text = fill(template);
    const results = detect(text);
    assert.ok(results.length > 0, "a warning");
    const out = redact(text, results);
    for (const code of used(template)) assert.ok(!out.includes(code), "each code is covered");
  });
}

test("a login code and a backup code still read as two codes", () => {
  const text = join("two-factor code ", "9027", "31, backup code: ", "1583", "64");
  const out = redact(text, detect(text));
  assert.ok(!out.includes(join("9027", "31")));
  assert.ok(!out.includes(join("1583", "64")));
});

test("a plain joining word between two lists is left in place", () => {
  const text = `I lost my backup codes and recovery codes ${YEAR} and my phone and my laptop`;
  const out = redact(text, detect(text));
  assert.ok(out.includes("my phone and my laptop"));
});

// A second backup label right after a first list, then a comma or semicolon and more codes, as in "backup codes
// {A} {B}, recovery codes, {C} {D}", has every code found and covered, as one long list did before. Two labels
// joined by "and", then a colon or "is", then a lone year or count and one word, as in "my backup codes and
// recovery codes: 2024, when I printed them", are a sentence about codes and stay quiet.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

// Numbers and made-up codes, built from pieces so no whole value sits in this file.
const join = (...parts) => parts.join("");
const YEAR = join("20", "24");
const COUNT = join("3", "17");
const CODES = {
  A: ["5821", " ", "0937"],
  B: ["kq7m", "-", "x4rt"],
  C: ["90", "27", "31"],
  D: ["wz4", "pn8", "h"],
  E: ["13", "57", "92", "46"],
  F: ["68", "25"],
};
const fill = (template) => template.replace(/\{([A-F])\}/g, (_, key) => CODES[key].join(""));
const used = (template) => [...template.matchAll(/\{([A-F])\}/g)].map((m) => CODES[m[1]].join(""));

const LISTS = [
  "backup codes {A} {B}, recovery codes, {C} {D}",
  "backup codes {A} {B}; recovery codes; {C} {D}",
  "backup codes {A} {B}, recovery codes,{C} {D}",
  "my recovery codes: {C}, {E}; backup code, {D}",
  "here are my backup code {C}, mfa codes, {E} {D}",
  "recovery code: {E}, {C} backup codes, {D}",
  "2fa codes {B} {D}\nrecovery key; {E}",
  "backup codes {C}, recovery codes, {E}, two-factor codes; {D} {B}",
  "códigos de respaldo {C} {E}, claves de recuperación, {D}",
  "recovery codes {C}, backup codes, {F}",
  "backup code two-factor codes, {E} {C}",
  "recovery codes: {D}\nbackup code ; {C}",
];

for (const template of LISTS) {
  const text = fill(template);
  test(`every code after a second label and a comma or semicolon is covered: ${template}`, () => {
    const results = detect(text);
    assert.ok(results.length > 0, "a warning");
    const out = redact(text, results);
    for (const code of used(template)) {
      assert.ok(!out.includes(code), `a code survived Cover it: ${template}`);
    }
  });
}

const QUIET = [
  `my backup codes and recovery codes: ${YEAR}, when I printed them`,
  `the 2fa code and the backup code is ${YEAR} edition`,
  `our recovery keys and two-factor codes are: ${COUNT} unused`,
  `my two-factor codes and the backup code is: ${COUNT} left, 7 used`,
  `mfa key, 2fa code and mfa codes is: ${YEAR} model`,
  `I lost my backup codes and recovery codes: ${YEAR} unfortunately`,
  `my recovery code and the recovery key is: ${YEAR} was a bad year for them`,
  `the códigos de respaldo and the backup codes es ${YEAR} version`,
  `about my 2fa code and the two factor code is ${YEAR} maybe?`,
  `our backup codes and mfa codes are: ${YEAR}`,
  `the recovery codes, mfa codes, and backup code were ${YEAR} unfortunately`,
  `about my backup codes, recovery keys, and 2fa codes ${YEAR} maybe?`,
];

for (const text of QUIET) {
  test(`joined labels before a lone number and one word stay quiet: ${text}`, () => {
    assert.deepEqual(detect(text), []);
  });
}

test("a lone code after joined labels and a colon is still covered", () => {
  const text = join("backup code and recovery code: ", CODES.F.join(""));
  const out = redact(text, detect(text));
  assert.ok(!out.includes(CODES.F.join("")));
});

test("a two-factor code and a backup code still read as two codes", () => {
  const text = join("two-factor code ", CODES.C.join(""), ", backup code: ", join("158", "364"));
  const out = redact(text, detect(text));
  assert.ok(!out.includes(CODES.C.join("")));
  assert.ok(!out.includes(join("158", "364")));
});

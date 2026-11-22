// A backup code list where a plain word comes before "code", "codes" or "key" inside the list, as in
// "backup codes: first code A, second code B", has every code found and covered. Only another backup or
// recovery label ends the list early.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect, redact } = globalThis.Clotr;

// Made-up codes, built from pieces so no whole code sits in this file.
const CODES = {
  A: ["kq7m", "-", "x4rt"],
  B: ["5821", " ", "0937"],
  C: ["HW3PN", "-", "8KD2Q"],
  // A code with no digit in it.
  D: ["ycgh", "-", "swdt"],
};
const fill = (template) => template.replace(/\{([ABCD])\}/g, (_, key) => CODES[key].join(""));
const used = (template) => [...template.matchAll(/\{([ABCD])\}/g)].map((m) => CODES[m[1]].join(""));

const LISTS = [
  "backup codes: first code {A}, second code {B}",
  "backup codes are {A}, {B}, new codes {C}",
  "recovery codes: {A}, {B} and the master key {C}",
  "backup codes {A} {B}, spare codes {C}",
  "backup codes: {A}, {B}, extra code {C}",
  "recovery codes are {A} {B} last code {C}",
  "backup codes: old codes {A}, {B}",
  "2fa codes: {A} {B} the code {C}",
  "backup codes are {A}, {B}, other codes {C}",
  "recovery key: {A}, device key {B}",
  "backup codes: {A}, {B}, unused codes {C}",
  "my backup codes:\nold code {A}\nspare code {B}\nlast code {C}",
  "códigos de respaldo: primer codigo {A}, otro codigo {B}",
  // Another label still starts its own list, and both are covered.
  "backup codes are {A}, {B} and recovery code {C}",
  // A code with no digit is covered too when a list beside it holds one.
  "two-factor codes: {D} and recovery code {B}",
  "recovery codes: {A}; {D} and recovery code {B} thanks",
];

for (const template of LISTS) {
  test(`every code in the list is covered: ${template}`, () => {
    const text = fill(template);
    const results = detect(text);
    assert.ok(results.length > 0, "a warning");
    const out = redact(text, results);
    for (const code of used(template)) assert.ok(!out.includes(code), "each code is covered");
  });
}

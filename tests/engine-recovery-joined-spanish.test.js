// A backup or recovery label, then "and" and a Spanish backup label, then a colon, "is" or "are:", then a 4-digit
// code and a short tail, as in "backup codes and códigos de recuperación: <code>, for my account". The code is
// found and covered. A year or small number after the same labels that ends in a short sentence stays quiet.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

// Made-up codes and numbers, built from pieces so no whole value sits in this file.
const join = (...parts) => parts.join("");
const CODES = [join("48", "21"), join("73", "09"), join("5", "638")];
const YEAR = join("20", "03");

const FIRST = ["backup codes", "recovery codes", "códigos de respaldo"];
const SECOND = ["códigos de recuperación", "códigos de respaldo", "código de recuperación"];
const JOINS = [" and ", " and the "];
const HEADS = [": ", " is ", " are: "];
const TAILS = [", for my account", ", for", " for me", ", ok", ""];

const cases = [];
for (const a of FIRST) {
  for (const b of SECOND) {
    if (a === b) continue;
    for (const j of JOINS) {
      for (const h of HEADS) for (const t of TAILS) cases.push({ head: `${a}${j}${b}${h}`, tail: t });
    }
  }
}

test("a 4-digit code after an English label, 'and' and a Spanish label is found and covered", () => {
  let k = 0;
  for (const { head, tail } of cases) {
    const code = CODES[k++ % CODES.length];
    const text = `${head}${code}${tail}`;
    const hits = detect(text);
    assert.ok(hits.length > 0, `no warning: ${head}<code>${tail}`);
    assert.ok(!redact(text, hits).includes(code), `code left after cover: ${head}<code>${tail}`);
  }
});

test("a year and a short sentence after the same labels stays quiet", () => {
  const quiet = [
    `backup codes and códigos de recuperación: ${YEAR}, remaining`,
    `recovery codes and claves de recuperación is ${YEAR}, después`,
    `backup codes and códigos de respaldo: ${YEAR} más`,
  ];
  for (const text of quiet) assert.deepEqual(detect(text), [], text);
});

test("a two-factor code, then a backup code, still reads as two codes", () => {
  const first = join("418", "293");
  const second = join("905", "716");
  const text = `my 2fa code is ${first}, backup code: ${second}`;
  const covered = redact(text, detect(text));
  assert.ok(!covered.includes(first) && !covered.includes(second), "both codes are covered");
});

// "nought" and "naught" read as zero, and "ninty" and "nintey" as ninety, so a phone number spelled with them is
// read like one spelled right. The numbers are made up (415 555 …).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const phones = (text) =>
  detect(text)
    .filter((result) => result.id === "phone_number")
    .flatMap((result) => result.matches);

test("nought, naught, ninty and nintey are read as number words", () => {
  for (const [word, rest] of [
    ["ninety", " one twenty three"],
    ["ninty", " one twenty three"],
    ["nintey", " one twenty three"],
    ["zero", " one two three"],
    ["nought", " one two three"],
    ["naught", " one two three"],
  ]) {
    const number = `four one five, five five five, ${word}${rest}`;
    assert.deepEqual(phones(`call me at ${number}`), [number], word);
  }
});

// A UK mobile said with nought and no phone word near it. Read whole, 07… isn't a phone here, so the ten words
// after nought are read on their own, as before nought counted as a number word. After a phone word the whole
// number is found, nought too.
test("a number after a leading nought or naught is still found with no phone word near it", () => {
  for (const zero of ["nought", "naught", "Nought"]) {
    const rest = "seven four five nine one seven two nine nine eight";
    assert.deepEqual(phones(`it is ${zero} ${rest}`), [rest], zero);
    const grouped = "seven four five nine, one seven two nine nine eight";
    assert.deepEqual(phones(`it is ${zero} ${grouped}`), [grouped], zero);
    assert.deepEqual(phones(`call me on ${zero} ${rest}`), [`${zero} ${rest}`], zero);
  }
});

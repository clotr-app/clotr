"use strict";

// The phone check on one long run of decimal-looking digits ("0.1234567" over and over) has to stay linear. Every
// dot joins the next digits into the same run, so a big paste is a single run of many thousands of groups, and the
// run's digits used to be rebuilt by each check that asked for them. All values are made up.

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

const findPhones = globalThis.Clotr.PATTERNS.find((p) => p.id === "phone_number").find;
const repeat = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

// 16 times the input, so growth that is only a little faster than linear shows well above the timer's noise.
// Linear work grows about 16 times; the limit is twice that.
test("the phone check stays linear on one long run of dotted digits", () => {
  for (const unit of ["0.1234567", "1.2345678."]) {
    const small = repeat(unit, 75 * 1024);
    const big = repeat(unit, 1200 * 1024);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => findPhones(small),
          () => findPhones(big),
        ),
      (s, b) => grewMoreThan(s, b, 32),
    );
    const ratio = slow ? (slow[1].wall / slow[0].wall).toFixed(1) : "";
    assert.ok(!slow, `phone_number on ${JSON.stringify(unit)} repeated: time grew ${ratio}× for 16× the input`);
  }
});

// Building the digits once must not change what is found.
test("a phone in a long run of dotted digits is still read the same way", () => {
  const filler = repeat("0.1234567", 9 * 1000);
  assert.deepEqual(findPhones(filler), []);
  assert.deepEqual(findPhones(`${filler} call me at 415-555-0134`), ["415-555-0134"]);
  assert.deepEqual(findPhones("call 415.555.0134 tonight"), ["415.555.0134"]);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

function expectOnly(text, id, match) {
  const found = detect(text);
  assert.deepEqual(Object.keys(found), [id], `${JSON.stringify(text)} → ${JSON.stringify(found)}`);
  if (match !== undefined) assert.deepEqual(found[id], [match]);
}

function expectNoKind(text, id) {
  assert.equal(detect(text)[id], undefined, `${JSON.stringify(text)} should not be ${id}`);
}

const PPS_CHECKS = "WABCDEFGHIJKLMNOPQRSTUV";
const NHI_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const IRD_PRIMARY = [3, 2, 7, 6, 5, 4, 3, 2];
const IRD_SECONDARY = [7, 4, 3, 2, 5, 2, 7, 6];

function makePps(base, second = "") {
  const weighted = [...base].reduce((sum, digit, i) => sum + Number(digit) * [8, 7, 6, 5, 4, 3, 2][i], 0);
  const extra = second ? (second.charCodeAt(0) - 64) * 9 : 0;
  return base + PPS_CHECKS[(weighted + extra) % 23] + second;
}

function makeIrd(base) {
  const padded = base.padStart(8, "0");
  const checkFor = (weights) => {
    const remainder = [...padded].reduce((sum, digit, i) => sum + Number(digit) * weights[i], 0) % 11;
    return remainder === 0 ? 0 : 11 - remainder;
  };
  const primary = checkFor(IRD_PRIMARY);
  const secondary = primary === 10;
  const check = secondary ? checkFor(IRD_SECONDARY) : primary;
  assert.ok(check < 10, `synthetic IRD base ${base} must have a valid check digit`);
  return { value: base + check, secondary };
}

function makeNhi(body, modulus) {
  const sum = [...body].reduce((total, char, i) => {
    const value = /[A-Z]/.test(char) ? NHI_LETTERS.indexOf(char) + 1 : Number(char);
    return total + value * (7 - i);
  }, 0);
  if (modulus === 11) {
    const remainder = sum % 11;
    const check = 11 - remainder;
    assert.ok(remainder !== 0 && check <= 9, "synthetic old-format NHI must have a numeric check digit");
    return body + check;
  }
  return body + NHI_LETTERS[23 - (sum % 23) - 1];
}

test("Irish PPS numbers: English and Irish labels, separators and bare checked values", () => {
  const pps = makePps("1234" + "567");
  const ppsWithSuffix = makePps("1234" + "568", "A");
  for (const text of [
    `my PPS number is ${pps}`,
    `PPSN: ${ppsWithSuffix}`,
    `Uimhir phearsanta seirbhíse poiblí: ${pps}`,
    `Uimhir PSP ${ppsWithSuffix}`,
  ]) {
    const expected = text.includes(ppsWithSuffix) ? ppsWithSuffix : pps;
    expectOnly(text, "national_id", expected);
  }

  const spaced = `${pps.slice(0, 3)} ${pps.slice(3, 7)}-${pps.slice(7)}`;
  expectOnly(`My PPSN is ${spaced}`, "national_id", spaced);
  expectOnly(spaced, "national_id", spaced);
  expectOnly(pps, "national_id", pps);

  const wrongCheck = pps.slice(0, 7) + (pps[7] === "A" ? "B" : "A");
  expectNoKind(`my PPS number is ${wrongCheck}`, "national_id");
  expectNoKind(wrongCheck, "national_id");
});

test("New Zealand IRD numbers: 8 and 9 digits, both weight sets, labels and separators", () => {
  const eightDigits = makeIrd("1234" + "567");
  const nineDigits = makeIrd("1234" + "5684");
  assert.equal(eightDigits.secondary, false);
  assert.equal(nineDigits.secondary, true);

  expectOnly(`my IRD number is ${eightDigits.value}`, "national_id", eightDigits.value);
  const grouped = `${nineDigits.value.slice(0, 3)}-${nineDigits.value.slice(3, 6)}-${nineDigits.value.slice(6)}`;
  expectOnly(`New Zealand IRD: ${grouped}`, "national_id", grouped);
  expectOnly(`Inland Revenue number ${nineDigits.value}`, "national_id", nineDigits.value);

  const wrongCheck = nineDigits.value.slice(0, -1) + ((Number(nineDigits.value.at(-1)) + 1) % 10);
  expectNoKind(`my IRD number is ${wrongCheck}`, "national_id");
  expectNoKind(`IRD number: ${grouped.slice(0, -1)}${(Number(grouped.at(-1)) + 1) % 10}`, "national_id");
  const aboveRange = makeIrd("2000" + "0000");
  assert.ok(Number(aboveRange.value) > 200_000_000);
  expectNoKind(`IRD number ${aboveRange.value}`, "national_id");
  // IRD digits share too much with order numbers, phone numbers and dates for bare detection.
  for (const text of [
    `Order ${eightDigits.value}`,
    `Call ${eightDigits.value}`,
    "The event is on 2026-11-02",
    "Order 12-345-678",
  ]) {
    expectNoKind(text, "national_id");
  }
});

test("New Zealand NHI numbers: old mod-11 and expanded mod-23 checks, labelled and bare", () => {
  const oldNhi = makeNhi("ZZZ" + "000", 11);
  const newNhi = makeNhi("ZZZ" + "00" + "A", 23);
  assert.equal(oldNhi, "ZZZ0008");
  assert.equal(newNhi, "ZZZ00AC");

  for (const value of [oldNhi, newNhi]) {
    expectOnly(`my NHI number is ${value}`, "national_id", value);
    expectOnly(value, "national_id", value);
    const invalid = value.slice(0, -1) + (value.at(-1) === "A" ? "B" : "A");
    expectNoKind(`NHI: ${invalid}`, "national_id");
    expectNoKind(invalid, "national_id");
  }

  for (const text of ["Order ABC1234", "Call me on 0211234567", "The date is 2026-11-02"]) {
    expectNoKind(text, "national_id");
  }
});

test("New Zealand driver licence numbers use the existing labelled licence kind", () => {
  const fakeLicence = "AB" + "123456";
  expectOnly(`my New Zealand driver licence number is ${fakeLicence}`, "drivers_license", fakeLicence);
  expectOnly(`NZ driver's license: ${fakeLicence}`, "drivers_license", fakeLicence);
  expectNoKind(fakeLicence, "drivers_license");
});

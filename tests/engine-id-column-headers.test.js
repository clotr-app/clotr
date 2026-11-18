"use strict";

// A French "Numéro national" or Czech "r. č." column header marks a column of national ID numbers, the way the same
// words already work as labels in prose. Every number here is made up, with its check digit computed below.

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

const ids = (text) => globalThis.Clotr.detect(text).find((r) => r.id === "national_id")?.matches || [];

const belgium = (body) => body + String(97 - (Number(body) % 97)).padStart(2, "0");
const czech = (body) => {
  const check = Number(body) % 11;
  assert.ok(check < 10, "rodné číslo check must be a digit");
  return body + check;
};

const BE = ["850730123", "920214456", "770911088"].map(belgium);
const RC = ["855101123", "905203321", "760412001"].map(czech);
const RC_SLASHED = RC.map((v) => `${v.slice(0, 6)}/${v.slice(6)}`);
const NAMES = ["Anna Novak", "Marc Dupont", "Eva Horak"];

// A header row, then one row per number, with the name first and the number second.
const table = (sep, header, values) =>
  [["Nom", header].join(sep), ...values.map((v, i) => [NAMES[i], v].join(sep))].join("\n");
const SEPARATORS = { comma: ",", tab: "\t", pipe: " | " };

test("the headers' words already find these numbers in prose", () => {
  assert.deepEqual(ids(`Numéro national : ${BE[0]}`), [BE[0]]);
  assert.deepEqual(ids(`r. č. ${RC_SLASHED[0]}`), [RC_SLASHED[0]]);
});

for (const [name, sep] of Object.entries(SEPARATORS)) {
  test(`a "Numéro national" column finds its numbers (${name} separated)`, () => {
    for (const header of ["Numéro national", "Numero national", "NUMÉRO NATIONAL", "numero_national"]) {
      assert.deepEqual(ids(table(sep, header, BE)), BE, header);
    }
  });

  test(`an "r. č." column finds its numbers (${name} separated)`, () => {
    for (const header of ["r. č.", "r.č.", "R. Č."]) {
      assert.deepEqual(ids(table(sep, header, RC)), RC, header);
      assert.deepEqual(ids(table(sep, header, RC_SLASHED)), RC_SLASHED, `${header} with slashes`);
    }
  });
}

test("headers that worked before still find their numbers", () => {
  assert.deepEqual(ids(table(",", "Rijksregisternummer", BE)), BE);
  assert.deepEqual(ids(table(",", "Registre national", BE)), BE);
  assert.deepEqual(ids(table(",", "NISS", BE)), BE);
  assert.deepEqual(ids(table("\t", "rodné číslo", RC)), RC);
  assert.deepEqual(ids(table(" | ", "Rodne cislo", RC_SLASHED)), RC_SLASHED);
});

test("the same numbers under an unrelated header stay quiet", () => {
  for (const sep of Object.values(SEPARATORS)) {
    for (const header of ["Référence", "Numéro", "Code national", "national", "r.", "Numéro de commande"]) {
      assert.deepEqual(ids(table(sep, header, BE)), [], `${header} over Belgian numbers`);
      assert.deepEqual(ids(table(sep, header, RC_SLASHED)), [], `${header} over Czech numbers`);
    }
  }
});

test("numbers that fail their check stay quiet under the new headers", () => {
  const broken = (v) => v.slice(0, -1) + ((Number(v.slice(-1)) + 1) % 10);
  assert.deepEqual(ids(table(",", "Numéro national", BE.map(broken))), []);
  assert.deepEqual(ids(table(",", "r. č.", RC.map(broken))), []);
});

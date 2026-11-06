// The toolbar popup's own words: the caught-items lines and the chart's last label, in English and Spanish, and its
// outside link. popup.js is large, so the pieces under test are read out of its source and run against the real
// patterns.js and locale files.
// Run from the repo root: node --test tests/popup-page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadPage, locale, EXT } = require("./fake-page.js");

const src = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
const piece = (re) => {
  const m = re.exec(src);
  assert.ok(m, `popup.js has no ${re}`);
  return m[0];
};

// "A credit card number was covered.": the two caught-item lines for a kind, in the given locale.
function caughtLines(lang) {
  const page = loadPage(["patterns.js"], { messages: lang === "en" ? {} : locale(lang) });
  const run = `
    const { msg, PATTERNS } = Clotr;
    const PATTERN_NAMES = Object.fromEntries(PATTERNS.map((p) => [p.id, p.name]));
    ${piece(/^const aKind = (?:.*;$|[\s\S]*?^\};$)/m)}
    (id) => {
      const name = PATTERN_NAMES[id];
      return [${piece(/msg\("pp_itemCovered".*?(?=,?$)/m)}, ${piece(/msg\("pp_itemSent".*?(?=,?$)/m)}];
    };`;
  return vm.runInContext(run, page.ctx);
}

test("popup: the caught-items lines read as English sentences", () => {
  const lines = caughtLines("en");
  assert.deepEqual(
    [...lines("credit_card")],
    ["A credit Card Number was covered.", "A credit Card Number went through as it was."],
  );
  assert.equal(lines("email")[0], "An email Address was covered.");
  // A name that starts with letters said one by one keeps them, and takes the article they sound like.
  assert.equal(lines("us_ssn")[0], "A US Social Security Number was covered.");
  assert.equal(lines("aws_access_key")[0], "An AWS Access Key was covered.");
  assert.equal(lines("id_picture")[0], "An ID or Document Picture was covered.");
});

test("popup: in Spanish the caught-items lines carry no English article", () => {
  const lines = caughtLines("es");
  for (const id of ["credit_card", "email", "us_ssn"]) {
    for (const line of lines(id)) {
      assert.doesNotMatch(line, /^An? /, line);
      assert.match(line, /se (cubrió|envió tal cual)\.$/, line);
    }
  }
  assert.match(lines("credit_card")[0], /^Número de tarjeta de crédito/);
});

// The chart's day labels: the last bar is today, in the popup's language like the other days.
function lastBarLabel(lang) {
  const page = loadPage(["patterns.js"], { messages: lang === "en" ? {} : locale(lang) });
  const run = `
    const { msg } = Clotr;
    const fmtDay = { format: () => "lun" };
    const b = { date: new Date() };
    const isLast = true;
    const tx = {};
    ${piece(/^\s*tx\.textContent = .*;$/m)}
    tx.textContent;`;
  return vm.runInContext(run, page.ctx);
}

test("popup: the chart's last bar says Today in English and Hoy in Spanish", () => {
  assert.equal(lastBarLabel("en"), "Today");
  assert.equal(lastBarLabel("es"), "Hoy");
});

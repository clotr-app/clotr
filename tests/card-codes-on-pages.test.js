// A card's security code and a gift card's code on the extension's own pages: the advice after one went
// out, the warning's line on who really asks, and the report's risky moments. These read the extension's
// page files, so they live with the extension's tests and ship with its release.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("advice for a card's security code that went out: call the card company, not a password's", () => {
  require("../extension/page-parts/insights.js");
  const { adviceFor } = globalThis.ClotrInsights;
  assert.equal(
    adviceFor("card_code"),
    "Call the number on your card and ask for a new one if someone else could have it.",
  );
  assert.notEqual(adviceFor("card_code"), adviceFor("password"));
});

// Two places treat money details alike: the warning's line on who really asks, behind "Why am I seeing this?", and
// the report's risky moments. A card's code used to count as a password there; now it counts as a card detail.
test("a card's security code still gets the warning's scam line and counts as a risky moment in the report", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "extension", f), "utf8");
  const scam = /const SCAM_TARGETS = new Set\(\[([^\]]*)\]\)/.exec(read("on-websites/warning-ui.js"))[1];
  assert.match(scam, /"card_code"/);
  const risky = /function renderRisky[\s\S]*?\[([^\]]*)\]\.includes\(e\.type\)/.exec(
    read("clotr-pages/exposure-report/exposure-report.js"),
  )[1];
  assert.match(risky, /"card_code"/);
});

test("a gift card's code that went out gets the warning's scam line, counts in the report, and its advice says to call the gift card company", () => {
  require("../extension/page-parts/insights.js");
  const { adviceFor } = globalThis.ClotrInsights;
  assert.equal(
    adviceFor("gift_card"),
    "Call the gift card company on the number on the back of the card. Say a scammer got the number and PIN, and ask for your money back.",
  );
  const fs = require("fs");
  const path = require("path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "extension", f), "utf8");
  assert.match(
    /const SCAM_TARGETS = new Set\(\[([^\]]*)\]\)/.exec(read("on-websites/warning-ui.js"))[1],
    /"gift_card"/,
  );
  assert.match(
    /function renderRisky[\s\S]*?\[([^\]]*)\]\.includes\(e\.type\)/.exec(
      read("clotr-pages/exposure-report/exposure-report.js"),
    )[1],
    /"gift_card"/,
  );
});

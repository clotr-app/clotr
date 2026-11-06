// The "What Clotr stores" page (stored.html): what it says Clotr can reach, and what its raw data shows.
// Run from the repo root: node --test tests/stored-page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, settle } = require("./fake-page.js");

const EVERYWHERE = "https://*/*";

async function openStored(options = {}) {
  const page = loadPage(["patterns.js", "sites.js", "stored.js"], options);
  await settle();
  return page;
}
// The reach list as [label, why] pairs.
const reach = (page) => {
  const c = page.$("permissions").children;
  const rows = [];
  for (let i = 0; i < c.length; i += 2) rows.push([c[i].textContent, c[i + 1]?.textContent || ""]);
  return rows;
};

test("stored page: with only the built-in AI chats, the reach list says Clotr reads no other site", async () => {
  const page = await openStored();
  const text = reach(page)
    .map((r) => r.join(" "))
    .join("\n");
  assert.match(text, /Never any other site\./);
  assert.doesNotMatch(text, /Everywhere I type/);
});

test("stored page: with Everywhere I type on, the reach list says so and drops 'Never any other site'", async () => {
  const page = await openStored();
  await page.grant([EVERYWHERE]);
  await settle();
  const rows = reach(page);
  const text = rows.map((r) => r.join(" ")).join("\n");
  assert.doesNotMatch(text, /Never any other site/);
  const everywhere = rows.find(([label]) => /Everywhere I type/.test(label));
  assert.ok(everywhere, `no Everywhere I type row: ${text}`);
  assert.match(everywhere[1], /every website/i);
});

test("stored page: an email or chat app switched on drops 'Never any other site' and is named", async () => {
  const page = await openStored();
  await page.grant(["https://mail.google.com/*"]);
  await settle();
  const text = reach(page)
    .map((r) => r.join(" "))
    .join("\n");
  assert.doesNotMatch(text, /Never any other site/);
  assert.match(text, /mail\.google\.com/);
});

// ---------- Show the raw data: what's shown, and the two secrets that aren't ----------

test("stored page: the raw data hides the fingerprint secret and the PIN record", async () => {
  // Made-up values in the shape Clotr stores them.
  const lock = { salt: "12".repeat(16), iterations: 150000, hash: "cd".repeat(32) };
  const page = await openStored({ local: { salt: "34".repeat(16), lock, keepDays: 90 } });
  const raw = JSON.parse(page.$("raw").textContent);
  assert.equal(raw.salt, "(hidden)");
  assert.equal(raw.lock, "(set)");
  assert.equal(raw.keepDays, 90, "everything else is shown as kept");
  assert.doesNotMatch(page.$("raw").textContent, /1212|cdcd|3434/);
});

test("stored page: the raw data's note says the PIN is hidden too, in English and Spanish", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { EXT, locale } = require("./fake-page.js");
  const html = fs.readFileSync(path.join(EXT, "stored.html"), "utf8");
  const note = /data-i18n="st_theExactRecordsAsA">([^<]*)</.exec(html)[1];
  assert.match(note, /fingerprint secret and the PIN are hidden/);
  assert.match(locale("es").st_theExactRecordsAsA.message, /huellas y el PIN están ocultos/);
});

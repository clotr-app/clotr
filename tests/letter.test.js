// Tests extension/letter.js's letterFor(), the deletion letter builder. It's pure, so this file proves it two
// ways: plain cases that check the law table, the joining words and the blank count, and then the real thing,
// turning each export fixture's own scan result into a letter that never carries a raw value.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
require("../extension/attachments.js");
require("../extension/pictures.js");
require("../extension/zip.js");
require("../extension/lookback-core.js");
require("../extension/letter.js");
const C = globalThis.Clotr;

const DIR = path.join(__dirname, "fixtures", "exports");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const { EXPORTS } = require("./fixtures/exports/make-exports.js");

function kindName(id) {
  return C.PATTERNS.find((p) => p.id === id)?.name || id;
}

test("letterFor(): the EU letter names the law, the kinds and the dates, and fills the chats blank", () => {
  const { text, blanks } = C.letterFor({
    company: "OpenAI",
    tool: "ChatGPT",
    kindNames: ["Password", "Email address"],
    firstDate: "2025-01-14",
    lastDate: "2025-03-22",
    links: ["https://chatgpt.com/c/6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10"],
    place: "eu",
    lang: "en",
  });
  assert.match(text, /To OpenAI,/);
  assert.match(text, /Article 17 of the GDPR/);
  assert.match(text, /Password and Email address/);
  assert.match(text, /January 14, 2025/);
  assert.match(text, /March 22, 2025/);
  assert.match(text, /https:\/\/chatgpt\.com\/c\/6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10/);
  assert.match(text, /Article 12\(3\)/); // the EU deadline line
  assert.doesNotMatch(text, /links or titles of those chats/);
  // letterFor can never fill two blanks itself, the account's email and the person's name. The links were
  // given here, so the third possible blank, for chat links, never opens up.
  assert.equal(blanks, 2);
  assert.ok(text.includes("[the email on your account]"));
  assert.ok(text.includes("[Your name]"));
});

test("letterFor(): no links given leaves the chats blank open, and counts it", () => {
  const { text, blanks } = C.letterFor({
    company: "Anthropic",
    tool: "Claude",
    kindNames: ["Credit card"],
    firstDate: "2025-01-01",
    lastDate: "2025-01-01",
    place: "other",
    lang: "en",
  });
  assert.ok(text.includes("[links or titles of those chats, if you have them]"));
  assert.equal(blanks, 3);
});

test("letterFor(): UK and California each name their own law and deadline", () => {
  const uk = C.letterFor({ company: "X", tool: "Y", kindNames: ["Password"], place: "uk" });
  assert.match(uk.text, /Article 17 of the UK GDPR/);
  assert.match(uk.text, /Please let me know what you did\./);

  const ca = C.letterFor({ company: "X", tool: "Y", kindNames: ["Password"], place: "california" });
  assert.match(ca.text, /California Consumer Privacy Act/);
  assert.match(ca.text, /within 45 days/);
});

test("letterFor(): 'Somewhere else' names no law, and still reads as a full sentence", () => {
  const { text } = C.letterFor({ company: "X", tool: "Y", kindNames: ["Password"], place: "other" });
  assert.match(text, /^I ask you to delete this information/m);
  assert.doesNotMatch(text, /Under [a-z]/); // no law lead with nothing to lead
});

test("letterFor(): the AI's replies are only mentioned when there's something to mention", () => {
  const withMentions = C.letterFor({
    company: "X",
    tool: "Y",
    kindNames: ["Password"],
    mentionedKindNames: ["Phone number"],
  });
  assert.match(withMentions.text, /Y's replies also brought up Phone number\./);

  const withoutMentions = C.letterFor({ company: "X", tool: "Y", kindNames: ["Password"] });
  assert.doesNotMatch(withoutMentions.text, /also brought up/);
});

test("letterFor(): three or more kinds join with a comma list and 'and'", () => {
  const { text } = C.letterFor({ company: "X", tool: "Y", kindNames: ["A key", "A password", "An address"] });
  assert.match(text, /A key, A password and An address/);
});

test("letterFor(): Spanish uses 'y', its own law wording, and its own blanks", () => {
  const { text, blanks } = C.letterFor({
    company: "OpenAI",
    tool: "ChatGPT",
    kindNames: ["Contraseña", "Correo electrónico"],
    firstDate: "2025-01-14",
    lastDate: "2025-03-22",
    place: "eu",
    lang: "es",
  });
  assert.match(text, /^A OpenAI:/);
  assert.match(text, /artículo 17 del RGPD/);
  assert.match(text, /Contraseña y Correo electrónico/);
  assert.ok(text.includes("[el correo de tu cuenta]"));
  assert.ok(text.includes("[Tu nombre]"));
  assert.equal(blanks, 3); // no links given here, so all three Spanish blanks are open
});

test("letterFor(): nothing about the call is kept (calling it twice never affects the other)", () => {
  const first = C.letterFor({ company: "A", tool: "B", kindNames: ["Password"], place: "eu" });
  const second = C.letterFor({ company: "C", tool: "D", kindNames: ["Email"], place: "california" });
  assert.doesNotMatch(second.text, /Password|Article 17 of the GDPR/);
  assert.doesNotMatch(first.text, /Email|California/);
});

// ---------- From each fixture's own scan result: names kinds, dates and links, never a value ----------

async function scan(name) {
  return C.readExport(C.folderFileEntries(EXPORTS[name]), { salt: "s" });
}

function letterFromResult(result, place, lang) {
  const chats = result.chats;
  const dates = chats
    .map((c) => c.date)
    .filter(Boolean)
    .sort();
  const kindIds = new Set();
  for (const c of chats) for (const id of Object.keys(c.kinds)) kindIds.add(id);
  const links =
    result.grouping === "day"
      ? chats.map((c) => c.date)
      : chats.map((c) => (c.link && C.chatLinkOk(c.link) ? c.link : c.title));
  return C.letterFor({
    company: result.company,
    tool: result.tool,
    kindNames: [...kindIds].map(kindName),
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    links,
    place,
    lang,
  });
}

for (const name of ["chatgpt", "claude", "gemini"]) {
  test(`letterFor(): the ${name} fixture's letter names its kinds and links, never a value`, async () => {
    const result = await scan(name);
    const { text } = letterFromResult(result, "eu", "en");
    assert.equal(text.includes(result.company), true);
    assert.equal(text.includes(result.tool), true);
    for (const c of result.chats) {
      for (const id of Object.keys(c.kinds)) assert.ok(text.includes(kindName(id)), `names ${id}`);
      if (result.grouping !== "day" && c.link && C.chatLinkOk(c.link))
        assert.ok(text.includes(c.link), "carries the chat's link");
      if (result.grouping === "day") assert.ok(text.includes(c.date), "names the day instead of the one shared link");
    }
    // None of the fixtures' own decoy values or real matched secrets, listed in expected.json's notTheirs plus
    // the values the "found" rows match on, should ever show up verbatim in a letter built only from names and links.
    const neverRaw = [
      ...(expected[name].notTheirs || []),
      "AKIA4HPQ7XZ2R6TWLJ3N",
      "219-09-9999",
      "1EG4-TE5-MK73",
      "X12345678",
    ];
    for (const value of neverRaw) assert.equal(text.includes(value), false, `never includes ${value}`);
  });
}

test("letterFor(): Gemini's blank names the days, not a repeated activity link", () => {
  return scan("gemini").then((result) => {
    const { text } = letterFromResult(result, "other", "en");
    for (const c of result.chats) assert.ok(text.includes(c.date), `names the day ${c.date}`);
    // myactivity.google.com is the same address for every day, and "Open your Gemini activity" already offers
    // it elsewhere on the page, so the letter's chats blank holds the days instead of repeating that one link.
    assert.equal((text.match(/myactivity\.google\.com/g) || []).length, 0);
  });
});

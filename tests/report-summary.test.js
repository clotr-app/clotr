// Tests "Copy my summary" in Report a problem, which shares kinds and counts only. The summary goes into a
// public report, so it's built only from Clotr's own words, the built-in kinds' names and ids, and counts. It
// never carries a detected value, a site, a time, a fingerprint, a page's text, or anything else a person or a
// page could have put in storage.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js"); // kind names (English here) and Clotr.msg
require("../extension/report.js");
const { Report, PATTERNS } = globalThis.Clotr;

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 2, 15, 42, 7);
const ABOUT = { version: "1.3.0", browser: "Brave" };

const ev = (type, action, extra = {}) => ({
  t: NOW - DAY,
  site: "chatgpt.com",
  type,
  name: type,
  severity: "medium",
  action,
  fp: "a000000000000001",
  ...extra,
});

const lines = (text) => text.split("\n");

test("summary: one line per kind found in the last 30 days, with only the counts that aren't zero", () => {
  const text = Report.summaryText(
    {
      events: [
        ev("phone_number", "redacted", { via: "bandage" }),
        ev("phone_number", "redacted"),
        ev("phone_number", "allowed"),
        ev("phone_number", "allowed"),
        ev("phone_number", "allowed"),
        ev("email", "suppressed"),
        ev("email", "suppressed"),
        ev("aws_access_key", "redacted"),
        // Anything older than 30 days is left out, so a kind with nothing recent gets no line at all.
        ev("credit_card", "allowed", { t: NOW - 31 * DAY }),
        ev("phone_number", "allowed", { t: NOW - 45 * DAY }),
      ],
      mentions: [ev("my_name", "mentioned"), ev("my_name", "mentioned", { t: NOW - 40 * DAY })],
      responses: { phone_number: "block", us_ssn: "block", email: "log", jwt: "warn" },
      bandage: { "chatgpt.com": true, "claude.ai": true, "gemini.google.com": false },
    },
    NOW,
    ABOUT,
  );
  assert.deepEqual(lines(text), [
    "Clotr 1.3.0 on Brave, last 30 days. Counts only: no details, sites or times.",
    "Phone Number (phone_number): 5 found, 2 hidden (1 by Bandage), 3 sent",
    "Email Address (email): 2 found, 2 just counted",
    "AWS Access Key (aws_access_key): 1 found, 1 hidden",
    "AI replies that brought up your details: 1",
    "Kinds set to Ask before sending: 2",
    "Kinds set to Just count: 1",
    "AI sites with Bandage on: 2",
  ]);
});

test("summary: with nothing recent it says so, and lines with a zero are left out", () => {
  const text = Report.summaryText({ events: [ev("phone_number", "allowed", { t: NOW - 60 * DAY })] }, NOW, ABOUT);
  assert.deepEqual(lines(text), [
    "Clotr 1.3.0 on Brave, last 30 days. Counts only: no details, sites or times.",
    "Nothing found in the last 30 days.",
  ]);
});

test("summary: a team's own kinds never show their name or id (it could name a client); unknown kinds neither", () => {
  const text = Report.summaryText(
    {
      events: [
        ev("team_acme_matter", "redacted", { name: "Acme Matter Number" }),
        ev("team_globex_client", "allowed", { name: "Globex client" }),
        ev("old_kind_from_before", "allowed", { name: "Some old kind" }),
      ],
    },
    NOW,
    ABOUT,
  );
  assert.deepEqual(lines(text).slice(1), [
    "Kinds your organization added: 2 found, 1 hidden, 1 sent",
    "Other kinds: 1 found, 1 sent",
  ]);
  assert.doesNotMatch(text, /acme|globex|matter|client|old_kind|some old/i);
});

// This is the core guarantee: details are planted everywhere a person, a page or a crafted message could put
// them, and not one of them should reach the text. Every line must be one Clotr wrote itself.
test("summary: details planted in every stored field never reach the text", () => {
  const PLANTED = {
    phone: "555-555-0147",
    email: "jane.doe@example.com",
    name: "Jane Doe",
    address: "1428 Elm Street",
    key: "AKIA4HPQ7XZ2R6TWLJ3N",
    fp: "c0ffee00deadbeef",
    host: "secret-intranet.example",
    page: "Here is my diagnosis from Dr. Who",
    salt: "0123456789abcdef0123456789abcdef",
  };
  const everywhere = (action, i) => ({
    t: NOW - i * 1000,
    site: i % 2 ? PLANTED.host : "chatgpt.com",
    // A known kind with a planted name, then planted text as the kind itself.
    type: i % 3 ? "phone_number" : PLANTED.phone,
    name: `${PLANTED.name} ${PLANTED.page}`,
    severity: "high",
    action,
    fp: PLANTED.fp,
    via: i % 4 ? "bandage" : PLANTED.address,
    value: PLANTED.key, // a field that should never exist
  });
  const stored = {
    events: ["redacted", "allowed", "suppressed", PLANTED.email].flatMap((a, i) =>
      [0, 1, 2, 3, 4, 5].map((j) => everywhere(a, i * 6 + j)),
    ),
    mentions: [0, 1, 2].map((i) => everywhere("mentioned", i)),
    responses: { [PLANTED.phone]: "block", jane_doe: "log", phone_number: PLANTED.address },
    bandage: { [PLANTED.host]: true, [PLANTED.email]: true },
    vault: [{ kind: "word", type: "my_name", words: PLANTED.name, fp: PLANTED.fp }],
    salt: PLANTED.salt,
    spotted: { [PLANTED.host]: true },
    siteModes: { [PLANTED.host]: "block" },
    paused: { [PLANTED.host]: true },
  };
  const text = Report.summaryText(stored, NOW, { version: PLANTED.phone, browser: PLANTED.name });

  for (const [what, value] of Object.entries(PLANTED)) {
    assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `the ${what} reached the summary:\n${text}`);
  }
  for (const piece of ["555", "0147", "jane", "doe", "elm", "akia", "secret", "intranet", "diagnosis"]) {
    assert.ok(!text.toLowerCase().includes(piece), `"${piece}" reached the summary:\n${text}`);
  }
  assert.doesNotMatch(text, /[0-9a-f]{16}/i, "no fingerprint or code");
  assert.doesNotMatch(text, /\b\d{1,2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/, "no clock time or date");
  assert.doesNotMatch(text, /\b[a-z0-9-]+\.(com|ai|org|net|example)\b/i, "no host name");
  assert.doesNotMatch(text, /@/, "no email address");
  assertOnlyClotrsOwnLines(text);
});

// Plants random text in every string field across many events. Whatever lands in the summary has to be Clotr's
// own: a built-in kind's name or id, a number, or a fixed line, never the planted string.
test("summary: random planted strings never come back, whatever field they're in", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const word = () =>
    Array.from({ length: 6 + Math.floor(rand() * 10) }, () => "qxzjkvwy0123456789-_.@ "[Math.floor(rand() * 23)])
      .join("")
      .trim();
  const planted = new Set();
  const plant = () => {
    const w = `qz${word()}`;
    planted.add(w);
    return w;
  };
  const ids = PATTERNS.map((p) => p.id);
  const events = Array.from({ length: 300 }, (_, i) => ({
    t: NOW - Math.floor(rand() * 29 * DAY),
    site: plant(),
    type: i % 2 ? ids[i % ids.length] : i % 3 ? `team_${plant().replace(/[^a-z_]/g, "")}` : plant(),
    name: plant(),
    severity: "medium",
    action: ["redacted", "allowed", "suppressed"][i % 3],
    fp: plant(),
    ...(i % 5 ? {} : { via: "bandage" }),
  }));
  const text = Report.summaryText(
    { events, mentions: events.slice(0, 20), responses: { [plant()]: "block" }, bandage: { [plant()]: true } },
    NOW,
    ABOUT,
  );
  for (const w of planted) assert.ok(!text.includes(w), `planted "${w}" reached the summary`);
  assertOnlyClotrsOwnLines(text);
});

test("summary: odd or broken storage never throws and still gives a summary", () => {
  for (const stored of [
    undefined,
    null,
    {},
    { events: "nope", mentions: 5, responses: [], bandage: "x" },
    { events: [null, 7, "x", { t: "soon", type: 3, action: "allowed" }, { action: "redacted" }] },
  ]) {
    const text = Report.summaryText(stored, NOW, ABOUT);
    assert.match(text, /^Clotr 1\.3\.0 on Brave, last 30 days\./);
    assertOnlyClotrsOwnLines(text);
  }
  // Without a version or a browser the first line still reads.
  assert.match(Report.summaryText({}, NOW), /^Clotr, last 30 days\. Counts only/);
});

test("summary: in Spanish through Clotr.msg, counts written as labels so 1 reads right", () => {
  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "_locales", "es", "messages.json")));
  const before = globalThis.chrome;
  globalThis.chrome = {
    i18n: {
      getMessage: (key, subs = []) =>
        es[key]?.message.replace(/\$(\d)/g, (_, n) => String(subs[n - 1] ?? "")).replace(/\$\$/g, "$") || "",
    },
  };
  try {
    const text = Report.summaryText(
      {
        events: [ev("phone_number", "redacted", { via: "bandage" }), ev("phone_number", "allowed")],
        mentions: [ev("my_name", "mentioned")],
        responses: { email: "log" },
        bandage: { "chatgpt.com": true },
      },
      NOW,
      ABOUT,
    );
    assert.deepEqual(lines(text), [
      es.rpt_sumHeader.message.replace("$1", "Clotr 1.3.0").replace("$2", "Brave"),
      `${es.type_phone_number.message} (phone_number): ${[
        es.rpt_sumFound.message.replace("$1", "2"),
        `${es.rpt_sumHidden.message.replace("$1", "1")} ${es.rpt_sumByBandage.message.replace("$1", "1")}`,
        es.rpt_sumSent.message.replace("$1", "1"),
      ].join(", ")}`,
      es.rpt_sumMentions.message.replace("$1", "1"),
      es.rpt_sumJustCount.message.replace("$1", "1"),
      es.rpt_sumBandage.message.replace("$1", "1"),
    ]);
    assert.match(text, /Número de teléfono \(phone_number\)/);
  } finally {
    globalThis.chrome = before;
  }
});

// Every line is the first line, a built-in kind's line, the team or other line, or one of the fixed count lines.
function assertOnlyClotrsOwnLines(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kinds = PATTERNS.map((p) => `${esc(p.name)} \\(${p.id}\\)`).join("|");
  const part = "\\d+ (?:found|hidden(?: \\(\\d+ by Bandage\\))?|sent|just counted)";
  const allowed = [
    /^Clotr(?: \d+(?:\.\d+){0,3})?(?: on (?:Brave|Chrome|Edge|Firefox|Opera))?, last 30 days\. Counts only: no details, sites or times\.$/,
    new RegExp(`^(?:${kinds}|Kinds your organization added|Other kinds): ${part}(?:, ${part})*$`),
    /^AI replies that brought up your details: \d+$/,
    /^Kinds set to (?:Ask before sending|Just count): \d+$/,
    /^AI sites with Bandage on: \d+$/,
    /^Nothing found in the last 30 days\.$/,
  ];
  for (const line of lines(text)) {
    assert.ok(
      allowed.some((re) => re.test(line)),
      `a line Clotr didn't write itself: ${JSON.stringify(line)}`,
    );
  }
}

// A record that stands for a long list is counted as its `n`, the whole list it folds together.
test("summary: a record that stands for a long list counts as the whole list", () => {
  require("../extension/sites.js");
  const text = Report.summaryText(
    {
      events: [
        ...Array.from({ length: 10 }, () => ev("email", "allowed")),
        ev("email", "allowed", { fp: "", n: 290 }),
        ev("email", "redacted", { fp: "", n: "40" }), // not a count Clotr wrote: one record
      ],
    },
    NOW,
    ABOUT,
  );
  assert.ok(lines(text).includes("Email Address (email): 301 found, 1 hidden, 300 sent"), text);
});

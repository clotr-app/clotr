"use strict";

// Secrets and personal details typed in pieces: a key read out in groups or one character at a time, a key split
// into quoted pieces a program joins, a card number grouped some other way than in fours, and a card number wrapped
// inside a quoted email reply. All values are made up.

const test = require("node:test");
const assert = require("node:assert/strict");

// The work meter counts steps only in code loaded after it, so it comes before the engine.
const { work, assertWorkLinear } = require("./work.js");
require("./load-engine.js")("rules", "detect");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

// What's left of the value after Cover it, as the longest run of 8 or more of its characters still in the output
// (spaces, quotes and joins don't count, so a key split into pieces can't hide behind them).
function residual(value, output, min = 8) {
  const squash = (s) => s.replace(/\[REDACTED [^\]]*\]/g, "|").replace(/[\s"'`+\\>_.-]|️|⃣/g, "");
  const body = squash(value);
  const left = squash(output);
  for (let i = 0; i + min <= body.length; i++) if (left.includes(body.slice(i, i + min))) return body.slice(i, i + min);
  return "";
}

function expectCovered(text, kind, value) {
  const results = globalThis.Clotr.detect(text);
  assert.ok(
    results.some((r) => r.id === kind),
    `${JSON.stringify(text)}: no ${kind} finding → ${JSON.stringify(detect(text))}`,
  );
  const covered = globalThis.Clotr.redact(text, results);
  assert.equal(
    residual(value, covered),
    "",
    `${JSON.stringify(text)}: part of the value survives Cover it: ${covered}`,
  );
  return covered;
}

function expectQuiet(text, kind) {
  const found = detect(text);
  if (kind) assert.equal(found[kind], undefined, `${JSON.stringify(text)} should not be ${kind}`);
  else assert.deepEqual(found, {}, `${JSON.stringify(text)} should not match`);
}

// Made-up keys, built from pieces the way the other engine tests build theirs.
const AWS = "AKIA" + "4HPQ7XZ2R6TWLJ3N";
const GITHUB = "ghp_" + "7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi";
const OPENAI = "sk-proj-" + "Q7mZ2xR9kL4vB8nT1cY6pJ3sH5dF0gA2eUiW7rK2qX9zLmN4bV8cT1yP6jS3hD5fG0aE2uI";
const groups = (s, n) => s.match(new RegExp(`.{1,${n}}`, "g"));

test("a key read out in groups is found and covered whole", () => {
  const shapes = [
    [`my key is ${groups(AWS, 4).join(" ")}`, "aws_access_key", AWS],
    [`key: ${groups(AWS, 4).join(" ")}.`, "aws_access_key", AWS],
    [`key ${groups(AWS, 4).join(" ")} thanks`, "aws_access_key", AWS],
    [`token ${groups(GITHUB, 4).join(" ")}`, "github_token", GITHUB],
    [`token ${GITHUB.slice(0, 4)} ${groups(GITHUB.slice(4), 6).join(" ")} ok?`, "github_token", GITHUB],
    [`token: ${GITHUB.slice(0, 20)} ${GITHUB.slice(20)}`, "github_token", GITHUB],
    [`key: sk-proj- ${groups(OPENAI.slice(8), 8).join(" ")}`, "openai_key", OPENAI],
    [`key:\t${groups(OPENAI, 10).join("\t")}`, "openai_key", OPENAI],
  ];
  for (const [text, kind, value] of shapes) expectCovered(text, kind, value);
});

test("a key spelled out one character at a time is found and covered whole", () => {
  expectCovered(`token: ${GITHUB.split("").join(" ")}`, "github_token", GITHUB);
  expectCovered(`here: ${AWS.split("").join(" ")} - that's it`, "aws_access_key", AWS);
});

test("a key split into quoted pieces a program joins is covered whole", () => {
  const head = OPENAI.slice(0, 40);
  const rest = OPENAI.slice(40);
  const shapes = [
    [`const k = "${head}" + "${rest}";`, "openai_key", OPENAI],
    [`const k = '${head}' +\n  '${rest}';`, "openai_key", OPENAI],
    [`apiKey: "${head}"\n+ "${rest}"`, "openai_key", OPENAI],
    [`token = (\n    "${GITHUB.slice(0, 20)}"\n    "${GITHUB.slice(20)}"\n)`, "github_token", GITHUB],
    [`TOKEN="${GITHUB.slice(0, 20)}" \\\n  "${GITHUB.slice(20)}"`, "github_token", GITHUB],
    [`token: \`${GITHUB.slice(0, 20)}\`\n\`${GITHUB.slice(20)}\``, "github_token", GITHUB],
  ];
  for (const [text, kind, value] of shapes) {
    const covered = expectCovered(text, kind, value);
    assert.ok(!covered.includes(rest) && !covered.includes(GITHUB.slice(20)), `${text}: the second piece survives`);
  }
});

test("prose and code that only start like a key stay quiet", () => {
  expectQuiet("sk-learn is the library I use for the model, and pandas for the data");
  expectQuiet("AKIA is how an access key id starts, ASIA for a temporary one");
  expectQuiet("ASIA ZONE WIDE SALE DATA");
  expectQuiet("ASIA TEAM: WEST EAST SOUTH");
  expectQuiet("the ghp_ prefix marks a classic token and github_pat_ a fine-grained one");
  expectQuiet('const prefix = "sk-" + "proj-";');
  expectQuiet('label = "ghp_" + name + "_token"');
  expectQuiet("a b c d e f g h i j k l m n o p q r s t u v w x y z");
  expectQuiet("s k - p r o j - is how the key starts, spelled out");
  // A key in groups with a group too many or too few characters doesn't join into a key.
  expectQuiet(`key ${groups(AWS, 4).join(" ").slice(0, -2)}`, "aws_access_key");
});

// The Luhn check digit for a made-up card number's first 15 digits.
function withCheckDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + ((10 - (sum % 10)) % 10);
}
const CARD = withCheckDigit("453914880343646");
const MASTERCARD = withCheckDigit("522851097316284");

test("a card number grouped some other way is found when a card word is near it", () => {
  const shapes = [
    `card number ${CARD.split("").join(" ")}`,
    `my visa is ${groups(CARD, 4)
      .map((g) => g.split("").join(" "))
      .join("  ")}`,
    `card: ${CARD.split("").join("-")}`,
    `card number: ${CARD.slice(0, 8)} ${CARD.slice(8)}`,
    `card number: ${CARD.slice(0, 4)} ${CARD.slice(4, 8)} ${CARD.slice(8, 12)} ${CARD.slice(12, 15)} ${CARD.slice(15)}`,
    `card ${groups(CARD, 4).join("_")}`,
    `card ${CARD.slice(0, 8).replace(/(\d{4})/, "$1 ")} / ${CARD.slice(8).replace(/(\d{4})/, "$1 ")}`,
    `mastercard ${MASTERCARD.split("").join(" ")}, exp 04/29`,
  ];
  for (const text of shapes) {
    expectCovered(text, "credit_card", CARD.startsWith(text.match(/\d/)[0]) ? CARD : MASTERCARD);
  }
});

test("digits grouped like that without a card word, or failing the card checks, stay quiet", () => {
  expectQuiet(CARD.split("").join(" "), "credit_card");
  expectQuiet(`${CARD.slice(0, 8)} ${CARD.slice(8)}`, "credit_card");
  // Luhn fails with the last digit changed.
  const wrong = CARD.slice(0, 15) + ((Number(CARD[15]) + 1) % 10);
  expectQuiet(`card number ${wrong.split("").join(" ")}`, "credit_card");
  // Passes Luhn but no card network starts with 1 and the label doesn't vouch for 17 digits either.
  expectQuiet("bingo card: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15", "credit_card");
  expectQuiet("card game scores 12 9 7 14 3 8 11 6 2 13", "credit_card");
});

test("a card number wrapped inside a quoted email reply is found and covered", () => {
  const [a, b, c, d] = groups(CARD, 4);
  for (const text of [
    `On Mon, Sam wrote:\n> my card is ${a} ${b}\n> ${c} ${d}\n> thanks`,
    `> > card: ${a} ${b} ${c}\n> > ${d}`,
    `>card ${a}\n>${b}\n>${c}\n>${d}`,
  ]) {
    expectCovered(text, "credit_card", CARD);
  }
  // Four-digit numbers one to a quoted line, with no card word, stay quiet.
  expectQuiet(`> ${a}\n> ${b}\n> ${c}\n> ${d}`, "credit_card");
});

// A made-up number in the 555 range, area code 212.
const PHONE = "212" + "555" + "0147";
const SSN = "536" + "22" + "9104";

test("a phone number or SSN wrapped over lines under its own label is found and covered", () => {
  const [area, exchange, line] = [PHONE.slice(0, 3), PHONE.slice(3, 6), PHONE.slice(6)];
  for (const text of [
    `my number is ${area} ${exchange}\n${line}`,
    `my number:\n${area}\n${exchange}\n${line}`,
    `call me on ${area}-${exchange}\n${line} after 5`,
    `> text me at ${area} ${exchange}\n> ${line}\n> thanks`,
  ]) {
    expectCovered(text, "phone_number", PHONE);
  }
  for (const text of [
    `my ssn is ${SSN.slice(0, 3)}\n${SSN.slice(3, 5)}\n${SSN.slice(5)}`,
    `SSN: ${SSN.slice(0, 3)}-${SSN.slice(3, 5)}\n${SSN.slice(5)}`,
    `> social security number ${SSN.slice(0, 3)} ${SSN.slice(3, 5)}\n> ${SSN.slice(5)}`,
  ]) {
    expectCovered(text, "us_ssn", SSN);
  }
});

test("short numbers one to a line without a phone or SSN label stay quiet", () => {
  expectQuiet(`order number:\n${PHONE.slice(0, 3)}\n${PHONE.slice(3, 6)}\n${PHONE.slice(6)}`, "phone_number");
  expectQuiet(`scores\n${PHONE.slice(0, 3)} ${PHONE.slice(3, 6)}\n${PHONE.slice(6)}`, "phone_number");
  expectQuiet(`totals:\n${SSN.slice(0, 3)}\n${SSN.slice(3, 5)}\n${SSN.slice(5)}`, "us_ssn");
  // The label is there but the digits aren't a valid number: an area code can't start with 1.
  expectQuiet("my number is 112 555\n0147", "phone_number");
});

test("digits written as keycap emoji read as digits", () => {
  const keycaps = (digits) => [...digits].map((d) => `${d}️⃣`).join("");
  const card = groups(CARD, 4).map(keycaps).join(" ");
  expectCovered(`card ${card}`, "credit_card", CARD);
  expectCovered(`my number is ${keycaps(PHONE)}`, "phone_number", PHONE);
  // A keycap emoji on its own in a sentence stays a plain digit.
  expectQuiet(`I rate it ${keycaps("5")} out of ${keycaps("5")}`);
});

test("a password on the line under its label in a quoted email reply is found and covered", () => {
  const value = "Tr0ub4dor" + "&3x";
  for (const text of [
    `On Mon, Sam wrote:\n> password:\n> ${value}\n> thanks`,
    `> > the password is:\n> > ${value}`,
    `>password:\n>${value}`,
  ]) {
    expectCovered(text, "password", value);
  }
  // A quoted line under the label that reads as a sentence is quiet.
  for (const body of ["Reset your password:\nClick the link below to choose a new one.", "Password:\nForgot it?"]) {
    expectQuiet(body.replace(/^/gm, "> "), "password");
  }
});

test("joining a key's pieces stays linear on big hostile input", () => {
  const unit = [
    "AKIA a ",
    'sk-a" + "b',
    "a ",
    `${groups(AWS, 4).join(" ")} `,
    `${GITHUB.split("").join(" ")} `,
    "A K I A s k - ",
    "AKIA AKIA ",
    "sk-a1 B2c3 D4e5 F6g7 ",
    `${groups(GITHUB, 4).join(" ")} `.repeat(40) + "\n",
    "call 212 555\n> 0147\n",
    "12-34    \n",
    "password:  \n> > > ",
  ];
  const make = (u, n) => u.repeat(Math.ceil(n / u.length));
  assertWorkLinear((text) => globalThis.Clotr.detect(text), make, unit, 75_000);
});

// A second made-up AWS key id, in the letters and digits 2-7 a real one is written in.
const AWS2 = "AKIA" + "Q7WE" + "RT3Y" + "UI2O" + "PA5S";

test("a key's prefix earlier on the line doesn't swallow the key typed after it", () => {
  const second = groups(AWS2, 4).join(" ");
  const both = expectCovered(`old key ${AWS} new key ${second}`, "aws_access_key", AWS2);
  assert.equal(residual(AWS, both), "", `the first key survives: ${both}`);
  expectCovered(`AKIA keys are long-term and mine is ${second}`, "aws_access_key", AWS2);
  expectCovered(`ASIA keys expire, AKIA ones don't: ${second}`, "aws_access_key", AWS2);
  const openai = "sk-proj-" + "Q7wE" + "rT9y" + "Ui2o" + "Pa5s" + "Df8g" + "Hj3k";
  expectCovered(`sk-proj keys rotate so use sk-proj- ${groups(openai.slice(8), 4).join(" ")}`, "openai_key", openai);
  // The same in quoted pieces, and spelled out after a word or another key spelled out.
  const head = OPENAI.slice(0, 40);
  const rest = OPENAI.slice(40);
  expectCovered(`parts = "sk-" "${head}" "${rest}"`, "openai_key", OPENAI);
  expectCovered(`step 2 ${AWS2.split("").join(" ")}`, "aws_access_key", AWS2);
  const spelled = expectCovered(`${AWS.split("").join(" ")} ${AWS2.split("").join(" ")}`, "aws_access_key", AWS2);
  assert.equal(residual(AWS, spelled), "", `the first key survives: ${spelled}`);
  // A key on its own after its label is still read whole.
  expectCovered(`key: ${second}`, "aws_access_key", AWS2);
});

test("lines that only start like a key don't switch off reading one typed in pieces", () => {
  const key = `my key ${groups(AWS2, 4).join(" ")}`;
  const asia = Array.from({ length: 200 }, (_, i) => `ASIA region sales up ${i} percent`).join("\n");
  expectCovered(`${asia}\n${key}`, "aws_access_key", AWS2);
  const sk = Array.from({ length: 200 }, (_, i) => `sk-learn model ${i} scored 0.${i} on run 2${i}`).join("\n");
  expectCovered(`${sk}\n${key}`, "aws_access_key", AWS2);
  const quoted = Array.from({ length: 200 }, (_, i) => `label = "ghp_" "x${i}" "y2"`).join("\n");
  expectCovered(`${quoted}\nk = "${OPENAI.slice(0, 40)}" "${OPENAI.slice(40)}"`, "openai_key", OPENAI);
});

test("headlines in capitals that start with ASIA and a year aren't an AWS key", () => {
  for (const text of [
    "BTS WORLD TOUR ASIA 2025 TOUR DATE LIST ANNOUNCED",
    "ASIA 2026 FULL YEAR PLAN",
    "ASIA EMEA 2025 2026 PLAN",
    "ASIA PAC1 DATA FEED 2025",
    "ASIA 2025 TOUR SALE DATA",
    "ASIA 20 25 TO UR SA LE DA TA",
    "A S I A 2 0 2 5 T O U R S A L E D A T A",
  ]) {
    expectQuiet(text, "aws_access_key");
  }
});

test("a phone number or a list of small numbers near a card word isn't a card", () => {
  const phone = "Lost your card? Call me on +49 159 " + "2190 3006";
  expectQuiet(phone, "credit_card");
  assert.ok(detect(phone).phone_number, `${phone}: the phone number is still found`);
  expectQuiet("Cards dealt: 5 7 4 5 8 3 6 6 8 3 2 3 4 5", "credit_card");
  expectQuiet("Discover Park trailhead: 47 83 16 122 89 18", "credit_card");
});

test("a key's prefix spelled out over and over costs about what other spelled-out text does", () => {
  // Each prefix spelled out in a long run is read up to the next one and then to the run's end. Text that mixes too
  // few kinds of character to hold a key has to be turned down without doing that work, or 300 KB of it took four
  // times as long as the same text with a letter changed so it starts no key.
  const pairs = [
    ["s k - ", "q k - "],
    ["h f _ ", "h q _ "],
    ["A K I A ", "A K I Q "],
    [`${"s k - ".repeat(39)}s\n`, `${"q k - ".repeat(39)}s\n`],
  ];
  // Counted (tests/work.js), the hostile text may make at most 2.5 times the plain text's steps, characters read or
  // regex runs. The first call in a process counts differently, so a short text goes first.
  globalThis.Clotr.detect(pairs.flat().join(""));
  for (const [hostile, plain] of pairs) {
    const make = (u) => u.repeat(Math.ceil(300_000 / u.length));
    const control = work(() => globalThis.Clotr.detect(make(plain)));
    const big = work(() => globalThis.Clotr.detect(make(hostile)));
    const over = Object.keys(big).filter((count) => big[count] > 2.5 * control[count]);
    const shown = over.map((count) => `${count} x${(big[count] / control[count]).toFixed(2)}`).join(", ");
    assert.ok(!over.length, `${JSON.stringify(hostile)}: ${shown} against the plain text`);
  }
});

test("lotto lines, order numbers, CSV rows and IMEIs near a card word aren't a card", () => {
  for (const text of [
    "My lotto card this week: 44 20 34 42 35 38 06 03",
    "Keno card: 4 41 46 68 45 72 37 3 58",
    "Card game scores: 24 42 51 96 12 17 60 66",
    // Amazon's order numbers are grouped 3-7-7, and some pass Luhn and start like a Maestro card.
    "I paid with my card for order 503-3144377-3643959",
    "I paid with my card for order 503 3144377 3643959",
    "card_id,amount,ts\n573778,925,1715687370",
    "SIM card slot 1, IMEI 50 138043 579441 7",
  ]) {
    expectQuiet(text, "credit_card");
  }
  const account = "Debit card account 67 39 92 54136422 4";
  expectQuiet(account, "credit_card");
  assert.ok(detect(account).bank_account, `${account}: the account number is still found`);
});

test("a heading over a column of numbers isn't a phone or SSN label", () => {
  for (const text of [
    "Mobile breakpoints:\n320\n768\n1024",
    "Phone screen widths:\n360\n412\n1080",
    "Text widths in px:\n320\n480\n1024",
    "Cell counts:\n312\n455\n1290",
    "Tel Aviv temps:\n305\n298\n3011",
    "Mobile app downloads by month:\n812 945\n1203",
    "Cell values\n> 245\n> 380\n> 1200",
  ]) {
    expectQuiet(text, "phone_number");
  }
  for (const text of [
    "Social security payments by year:\n512\n34\n6789",
    "Social Security Administration offices:\n512\n34\n6789",
  ]) {
    expectQuiet(text, "us_ssn");
  }
  const [area, exchange, line] = [PHONE.slice(0, 3), PHONE.slice(3, 6), PHONE.slice(6)];
  for (const text of [
    `Call me: ${area} ${exchange}\n${line}`,
    `Phone number:\n${area}\n${exchange}\n${line}`,
    `my cell is ${area}-${exchange}\n${line}`,
    `Mobile: ${area} ${exchange}\n${line}`,
    `my phone number is\n${area} ${exchange}\n${line}`,
    `You can reach me at ${area} ${exchange}\n${line}`,
  ]) {
    expectCovered(text, "phone_number", PHONE);
  }
  expectCovered(`Social Security #:\n${SSN.slice(0, 3)} ${SSN.slice(3, 5)}\n${SSN.slice(5)}`, "us_ssn", SSN);
});

test("table cells, number lists and spaced order numbers near a card word aren't a card", () => {
  for (const text of [
    "card_id\tamount\tts\n562942\t854\t1736185289",
    "Card\tQty\tPrice\tOrder\n4255\t292\t5584\t75908",
    "card_ids = [2499 27051 222 2111]",
    ">>> deck.card_values\narray([47761 6180 39462 77285])",
    "Card game totals: 671 676 687 221 528",
    "Card dispute ref 509835 83489 20671 51",
    "I paid with my card for order 506 - 1650052 - 2521160",
  ]) {
    expectQuiet(text, "credit_card");
  }
  // A card copied from a sheet's cells, one group to a cell, is still a card.
  expectCovered(`card ${groups(CARD, 4).join("\t")}`, "credit_card", CARD);
});

test("a sentence on the quoted line under a password label isn't the password", () => {
  for (const text of [
    "Reset your password:\n> Click the link below to continue",
    "On Tue, IT wrote:\n> To change your password:\n> Open Settings, then Security",
    "Reset your password:\nClick the link below to choose a new one.".replace(/^/gm, "> "),
  ]) {
    expectQuiet(text, "password");
  }
});

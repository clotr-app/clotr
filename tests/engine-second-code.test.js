// A message with two login codes in it, like "482913 is my verification code: 551234", has both codes found,
// each as the code alone. Numbers that aren't codes, like an order number or a price, stay quiet.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const passwordFinding = (text) => detect(text).find((result) => result.id === "password");
const sorted = (list) => [...list].sort();

// Made-up messages, each with two made-up login codes.
const TWO_CODES = [
  ["482913 is my verification code: 551234", ["482913", "551234"]],
  ["729104 is the login code: 640318", ["729104", "640318"]],
  ["send 318274, my verification code is 905162", ["318274", "905162"]],
  ["first code 274615, second verification code: 813490", ["274615", "813490"]],
  ["the old one was 561902 but the new login code: 447215", ["561902", "447215"]],
  ["two-factor code 902731, backup code: 158364", ["902731", "158364"]],
  // A code on each side of its name.
  ["630518 was the login code, the new one is 274906", ["630518", "274906"]],
  ["the verification code was 4829, now it's 7351", ["4829", "7351"]],
  // Two codes after one name.
  ["my verification code is 482913 or maybe 551234", ["482913", "551234"]],
  ["my WhatsApp code is 482-913, the next one was 551-234", ["482-913", "551-234"]],
];

for (const [text, codes] of TWO_CODES) {
  test(`both login codes are found, each alone: ${text}`, () => {
    const finding = passwordFinding(text);
    assert.ok(finding, "a finding");
    assert.equal(finding.severity, "high");
    assert.deepEqual(sorted(finding.matches), sorted(codes));
  });
}

// Hide it covers both codes, and the words around them stay.
for (const [text, codes] of TWO_CODES) {
  test(`Hide it leaves neither code in the message: ${text}`, () => {
    const out = globalThis.Clotr.redact(text, detect(text));
    for (const code of codes) assert.ok(!out.includes(code), `${code} is covered`);
    assert.equal(out.match(/\[REDACTED [^\]]*\]/g).length, codes.length);
  });
}

// A number after "then" with other words after it isn't read as a second code, since "then 1430 when the shop
// opens" is as likely a plain number. The login code is found and covered, as on 1.6.1.
const THEN_WITH_WORDS = [["login code: {A}, then {B} when that one expired", { A: ["309", "417"], B: ["862", "035"] }]];
for (const [template, pieces] of THEN_WITH_WORDS) {
  test(`the login code is found and covered, as on 1.6.1: ${template}`, () => {
    const text = template.replace(/\{(\w)\}/g, (_, key) => pieces[key].join(""));
    const code = pieces.A.join("");
    assert.deepEqual(passwordFinding(text).matches, [code]);
    assert.ok(!globalThis.Clotr.redact(text, detect(text)).includes(code));
  });
}

// One code, as before: the other number in the sentence isn't a code.
const ONE_CODE = [
  ["my verification code: 551234", ["551234"]],
  ["my verification code is 482913, order 551234 shipped", ["482913"]],
  ["my verification code is 482913 and my account number is 551234", ["482913"]],
  ["my login code is 4829, it expires at 1130", ["4829"]],
  ["my login code was 4829 in 2026", ["4829"]],
  ["the verification code is 4829 and rent is $1250", ["4829"]],
  ["the verification code is 4829 and it cost 1250 dollars", ["4829"]],
  ["my verification code: 4829, phone 555 1234", ["4829"]],
  ["my login code is 482913, room 551234 is booked", ["482913"]],
  ["my verification code is 482913, tracking number 551234", ["482913"]],
  ["my login code is 482913, the zip is 551234", ["482913"]],
  ["my verification code is 482913, it's 5512 steps away", ["482913"]],
  ["my verification code is 482913 and 551234 is my zip", ["482913"]],
  ["the verification code is 4829, the price is 1250", ["4829"]],
  ["my verification code is 482913, the score was 551234", ["482913"]],
];

for (const [text, codes] of ONE_CODE) {
  test(`one login code, the other number stays quiet: ${text}`, () => {
    const finding = passwordFinding(text);
    assert.ok(finding, "a finding");
    assert.equal(finding.severity, "high");
    assert.deepEqual(sorted(finding.matches), sorted(codes));
  });
}

// No login code at all.
const QUIET = [
  "order 482913 shipped, tracking code: 551234",
  "room 4829 is booked",
  "order 482913 and order 551234 both shipped",
  "the invoice 482913 was paid on 05/11/2026 for $551234",
  "call 555 1234 or 555 4321 after 1130",
  "in 2025 and 2026 we sold 4829 and 5512 units",
];

for (const text of QUIET) {
  test(`no login code, nothing found: ${text}`, () => {
    assert.equal(passwordFinding(text), undefined);
  });
}

// A word with "code" or "key" after it starts another label, so a backup code list ends before it.
const LISTS = [
  ["the two-factor code: 482913, backup codes: 1234 5678, 2345 6789", ["482913", "1234 5678, 2345 6789"]],
  ["my 2fa code 482913 recovery key 9f8e7d6c", ["482913", "9f8e7d6c"]],
];

for (const [text, codes] of LISTS) {
  test(`a backup code list ends before the next label: ${text}`, () => {
    assert.deepEqual(sorted(passwordFinding(text).matches), sorted(codes));
  });
}

// A backup code list still reads as before.
test("a list of backup codes is still one finding", () => {
  const finding = passwordFinding("my backup codes are 4829 1736, 5512 9043, 6620 1185");
  assert.ok(finding);
  assert.deepEqual(finding.matches, ["4829 1736, 5512 9043, 6620 1185"]);
});

// A login code with an everyday labelled number beside it, like a customer number, a price or a postcode. Only the
// login code is found, and Hide it leaves the other number. Values are joined from pieces so no code sits whole here.
const six = { C: ["482", "913"], N: ["551", "234"] };
const four = { C: ["48", "29"], N: ["12", "50"] };
const five = { C: ["482", "91"], N: ["902", "10"] };
const dashed = { C: ["482-", "913"], N: ["555-", "123"] };
const EVERYDAY = [
  ["my verification code is {C}, receipt: {N}", six],
  ["my verification code is {C}, transaction: {N}", six],
  ["my verification code is {C}, customer: {N}", six],
  ["my verification code is {C}, policy: {N}", six],
  ["my verification code is {C}, claim: {N}", six],
  ["my verification code is {C}, parcel: {N}", six],
  ["my verification code is {C}, patient: {N}", six],
  ["my verification code is {C}, employee: {N}", six],
  ["receipt: {N}, my verification code is {C}", six],
  ["Hi, my login code is {C}, my membership: {N}", six],
  ["my verification code is {C}, total: {N}.", four],
  ["my verification code is {C}, price: {N}", four],
  ["my verification code is {C}, balance: {N}", four],
  ["my verification code is {C}, score: {N}", four],
  ["my verification code is {C}, points: {N}", four],
  ["my verification code is {C}, steps today: {N}", four],
  ["my verification code is {C}, km: {N}", four],
  ["my verification code is {C}, and it's {N}", four],
  ["my verification code is {C}, it's {N} now", four],
  ["my verification code is {C}, the time: {N}", four],
  ["my verification code is {C}, people: {N}", four],
  ["my verification code is {C}, paid: {N}", four],
  ["my verification code is {C}, rent: {N}", four],
  ["my verification code is {C}, last four of my card: {N}", four],
  ["my verification code is {C}, the last 4 digits: {N}", four],
  ["my verification code is {C}, I live in Beverly Hills, {N}", five],
  ["my verification code is {C}, Beverly Hills CA, {N}", five],
  ["my verification code is {C}, postcode: {N}", five],
  ["my verification code is {C}, mobile: {N}", dashed],
  ["my verification code is {C}, my cell: {N}", dashed],
  ["my verification code is {C}, date: {N}", { C: ["4829", "1307"], N: ["2026", "1117"] }],
  ["my verification code is {C}, license: {N}", { C: ["4829", "1307"], N: ["5512", "3409"] }],
  ["Hi, I can't log in. Customer: {N}, verification code: {C}", six],
  ["Patient: {N}, the login code they sent me is {C}", six],
  ["Employee: {N}, my verification code is {C}, can you reset my access?", six],
  ["My verification code is {C}, my receipt: {N}, what do I do next?", six],
  ["{C} is my verification code, amount: {N}, is this a scam?", four],
];
const fill = (template, pieces) => {
  const values = Object.fromEntries(Object.entries(pieces).map(([key, parts]) => [key, parts.join("")]));
  return { text: template.replace(/\{(\w)\}/g, (_, key) => values[key]), values };
};

for (const [template, pieces] of EVERYDAY) {
  test(`only the login code is found, not the labelled number: ${template}`, () => {
    const { text, values } = fill(template, pieces);
    const results = detect(text);
    assert.deepEqual(passwordFinding(text).matches, [values.C]);
    for (const result of results) for (const m of result.matches) assert.ok(!m.includes(values.N), `${result.id}`);
    assert.ok(globalThis.Clotr.redact(text, results).includes(values.N), "the number stays");
  });
}

// Short backup or recovery codes after a second label are covered by Hide it, as a long list is.
const shortDigits = { A: ["48", "29"], B: ["55", "12"], C: ["73", "51"], D: ["90", "38"] };
const sixChars = { A: ["ab12", "cd"], B: ["ef56", "gh"], C: ["jk90", "mn"] };
const SHORT_LISTS = [
  ["recovery codes: {A} {B} {C} backup codes {D}", shortDigits],
  ["recovery code {A} and backup code {B}", shortDigits],
  ["recovery code {A} and backup code {B}", sixChars],
  ["backup codes: {A} {B} recovery key {C}", sixChars],
  ["backup codes: {A} {B} and recovery codes {C}", shortDigits],
  ["recovery code {A}, backup code {B}", sixChars],
  ["backup codes: none yet, recovery key {A}", sixChars],
  ["my recovery key is lost, backup code {A}", sixChars],
];

for (const [template, pieces] of SHORT_LISTS) {
  test(`Hide it covers every short backup code: ${template}`, () => {
    const { text, values } = fill(template, pieces);
    const out = globalThis.Clotr.redact(text, detect(text));
    for (const [key, code] of Object.entries(values)) {
      if (template.includes(`{${key}}`)) assert.ok(!out.includes(code), `${key} is covered`);
    }
  });
}

// A login code with plain numbers after it, as in "code 482913, 551234 and 640318 are the invoice numbers". Only the
// login code is found, and Hide it leaves the plain numbers, as on 1.6.1. The last field lists what is found: the
// login code, and in one text a number named as a pin.
const fourList = { C: ["73", "16"], N: ["36", "42"], P: ["58", "17"] };
const sixList = { C: ["374", "816"], N: ["620", "419"], P: ["815", "302"] };
const times = { C: ["73", "16"], N: ["14", "30"], P: ["16", "00"] };
const AFTER_THE_CODE = [
  ["my login code is {C}, {N} and counting", fourList, ["C"]],
  ["my verification code is {C}, {N} or so in rent", fourList, ["C"]],
  ["my verification code is {C}, {N}.", fourList, ["C"]],
  ["the verification code is {C}, {N}, {P}", sixList, ["C"]],
  ["my verification code is {C}, {N} too", fourList, ["C"]],
  ["my verification code is {C}, {N} then", fourList, ["C"]],
  ["the login code is {C}, {N} by Friday", fourList, ["C"]],
  ["login code {C}, {N} and {P} are my case numbers", sixList, ["C"]],
  ["my verification code is {C}, {N}", fourList, ["C"]],
  ["my verification code is {C}, {N}", sixList, ["C"]],
  ["my verification code is {C}, {N} also", fourList, ["C"]],
  ["my verification code is {C}, {N}", { C: ["1711", "2026"], N: ["1811", "2026"] }, ["C"]],
  ["my verification code is {C}, {N}", { C: ["374", " 816"], N: ["555", " 019"] }, ["C"]],
  ["Customer gave verification code {C}, {N} and {P} are the order numbers they asked about", sixList, ["C"]],
  ["my login code is {C}, {N} and {P} are free for the call", times, ["C"]],
  ["Hi, verification code {C}, {N} and {P} are the tickets from last week", sixList, ["C"]],
  ["my verification code is {C}, {N} and {P} are the invoice numbers", sixList, ["C"]],
  ["my verification code is {C}; {N} and {P} are the case numbers", sixList, ["C"]],
  ["verification code {C}, {N} then {P} for parking", times, ["C"]],
  ["verification code {C}, {N}, that's my extension", times, ["C"]],
  ["the sms code is {C}, {N} and the pin is {P}", times, ["C", "P"]],
];

for (const [template, pieces, keys] of AFTER_THE_CODE) {
  test(`a plain number after the login code stays quiet: ${template}`, () => {
    const { text, values } = fill(template, pieces);
    const results = detect(text);
    assert.deepEqual(sorted(passwordFinding(text).matches), sorted(keys.map((key) => values[key])));
    const out = globalThis.Clotr.redact(text, results);
    for (const key of Object.keys(values)) {
      if (keys.includes(key) || !template.includes(`{${key}}`)) continue;
      for (const result of results) for (const m of result.matches) assert.ok(!m.includes(values[key]), result.id);
      assert.ok(out.includes(values[key]), `${key} stays`);
    }
  });
}

// A list of codes with nothing after it naming them reads as on 1.6.1: the login code is found and covered.
test("a bare list after a login code keeps the login code found and covered", () => {
  const { text, values } = fill("my verification code is {A}, {B}, {D}", { A: sixList.C, B: sixList.N, D: sixList.P });
  assert.ok(passwordFinding(text).matches.includes(values.A));
  assert.ok(!globalThis.Clotr.redact(text, detect(text)).includes(values.A));
});

// A plain number after "and", "or", "then" or "send" next to a login code, in a support paste like "code 482913 and
// 551234 and 640318 are the case numbers". Only the login code is found, and Hide it leaves the plain numbers, as on
// 1.6.1.
const sixAnd = { C: ["518", "273"], N: ["402", "817"], P: ["639", "105"], Q: ["771", "348"] };
const fourAnd = { C: ["84", "61"], N: ["12", "00"], P: ["14", "30"], Q: ["25", "00"] };
const AFTER_A_JOINING_WORD = [
  ["Hi, my verification code is {C} and {N} and {P} are the case numbers you asked for", sixAnd],
  ["verification code {C} and {N} and {P} are the order numbers", sixAnd],
  ["verification code is {C}, and {N} and {P} are the meeting times", fourAnd],
  ["my verification code is {C} and {N} or {P} are the order numbers", sixAnd],
  ["verification code is {C} and {N}, {P} are the ticket numbers", sixAnd],
  ["verification code is {C}, then {P} when the shop opens", fourAnd],
  ["my verification code is {C}, send {Q} by Friday for the rent", fourAnd],
  ["the login code is {C} and {N} too, for the parking", fourAnd],
  ["verification code is {C} or {N}, either way the total is {Q}", fourAnd],
];

for (const [template, pieces] of AFTER_A_JOINING_WORD) {
  test(`a plain number after a joining word stays quiet: ${template}`, () => {
    const { text, values } = fill(template, pieces);
    const results = detect(text);
    assert.deepEqual(passwordFinding(text).matches, [values.C]);
    const out = globalThis.Clotr.redact(text, results);
    assert.ok(!out.includes(values.C), "the login code is covered");
    for (const key of ["N", "P", "Q"]) {
      if (!template.includes(`{${key}}`)) continue;
      for (const result of results) for (const m of result.matches) assert.ok(!m.includes(values[key]), result.id);
      assert.ok(out.includes(values[key]), `${key} stays`);
    }
  });
}

// "the login code is 8461 and 1200." could be two codes, since no words after the second number name it. The login
// code is found and covered either way.
test("a login code with a bare number after it is still covered", () => {
  const { text, values } = fill("the login code is {C} and {N}.", fourAnd);
  assert.ok(passwordFinding(text).matches.includes(values.C));
  assert.ok(!globalThis.Clotr.redact(text, detect(text)).includes(values.C));
});

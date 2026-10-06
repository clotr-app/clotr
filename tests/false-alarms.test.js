// Codes that only look like a real detail should stay quiet, while every real one keeps its warning. A made-up
// code can pass a check digit by chance, the way 1 IBAN in 97 passes its mod-97 check, or can start with the
// same letters as a real label, the way "DL380" names a server but "DL1234" names a Delta flight. Every value
// here is made up; the IBANs' check digits are computed below the way a bank would compute them.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { retrySlow, bestOfBoth, grewMoreThan } = require("./timing.js");

// Calls the extension's own detect() and reshapes the result to { kind: [matched text, ...] }.
function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}
function expectOnly(text, id, match) {
  const found = detect(text);
  assert.deepEqual(Object.keys(found), [id], `"${text}" → ${JSON.stringify(found)}`);
  if (match !== undefined) assert.deepEqual(found[id], [match], text);
}
function expectNothing(text) {
  assert.deepEqual(detect(text), {}, `"${text}" should not match`);
}

// A seeded random generator, so the counts are the same every run.
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CAPITALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const codes = (count, make) => Array.from({ length: count }, make);
const chars = (random, set, n) => Array.from({ length: n }, () => set[Math.floor(random() * set.length)]).join("");

// ---------- IBANs ----------

// Builds an IBAN from a country code and an account number, working out its two check digits the way the
// ISO 7064 mod-97 standard does.
function iban(country, account) {
  const moved = (account + country + "00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97;
  return `${country}${String(98 - rest).padStart(2, "0")}${account}`;
}
// Printed the way a bank prints it, in groups of four.
const printed = (v) => v.replace(/(.{4})(?=.)/g, "$1 ");

// One made-up account per country, in the layout the IBAN Registry gives it. The countries run from the
// shortest IBAN, Norway's 15 characters, to the longest, Russia's 33, and some use letters where their layout
// calls for them, like the UK's bank code or Italy's check letter.
const ACCOUNTS = {
  NO: "58314170558",
  BE: "431790355611",
  NL: "FJYF1348723257",
  DK: "02931206948633",
  FI: "83831664037966",
  SI: "227380378975721",
  MK: "3169FU6SCSKVN03",
  AT: "7178489179676480",
  LT: "7748993440972592",
  EE: "9511709036786881",
  XK: "2273359796836697",
  CH: "31698MNSKV1SHOS3R",
  HR: "01091769253754901",
  LV: "UDEYEB1F7P9997RFP",
  DE: "213053020695604096",
  GB: "LHPY79001422116219",
  IE: "QQVS11912285660907",
  BG: "EWDF0500706NFQIJHP",
  IL: "0782703740572779206",
  AE: "1212114454931806638",
  ES: "34358224607971321045",
  SE: "88594711040147465363",
  RO: "WYDLIENVU4PW7VRNLKZC",
  CZ: "15254042374312363158",
  PT: "505793315548997405142",
  IS: "8974163269658958702610",
  TR: "502241AN7ZG9NJ93KGG796",
  FR: "9524536023JXDSYBG4CR916",
  IT: "P4408155266YZLNYYHF0B3L",
  GR: "4636444Z2DTRKI97Q4II1V6",
  MC: "1434447296BTIT6WIW4G867",
  PL: "779502869335113305966983",
  HU: "206953453590697256447403",
  CY: "77053953OMWTLWJTIQVG4ULS",
  BR: "93429386957356607652258TW",
  UA: "105980BMOWHVM3YHXBGDI6INB",
  QA: "UGMUEFLI70EGP6KVFM0HT9ZJA",
  JO: "OWDX05969G9PD9B0YHIU3NPDAG",
  KW: "OBEQLCF7OPTXIQ60W8NLSQ5DSW",
  MU: "MNWZ0319531274792052492MOU",
  MT: "FZIU86711ZI3ACF7P1GJBURMET1",
  SC: "QQQU36719179183011085879FNN",
  LC: "NRWS1S9FGZHR6BF7QKMXRFQY325S",
  RU: "33623685469543MR8ONRMOFXU3L9P",
};

// Checks that an IBAN is caught only as an IBAN: the digits inside it don't also read as a card number, and
// "PW" inside one isn't mistaken for a password's label.
test("IBANs from many countries are caught: on their own, in groups of four, after their name in any case", () => {
  const missed = [];
  for (const [country, account] of Object.entries(ACCOUNTS)) {
    const v = iban(country, account);
    for (const [text, want] of [
      [v, v],
      [`Wire it to ${printed(v)} today`, printed(v)],
      [`my iban is ${v}`, v],
      [`iban: ${printed(v).toLowerCase()}`, printed(v).toLowerCase()],
      [`Mi IBAN es ${printed(v)}`, printed(v)],
    ]) {
      const found = detect(text);
      if (JSON.stringify(found) !== JSON.stringify({ bank_account: [want] }))
        missed.push(`${country}: ${JSON.stringify(text)} → ${JSON.stringify(found)}`);
    }
  }
  assert.deepEqual(missed, []);
});

// A right check digit isn't enough. The country has to actually have IBANs, and the code has to match that
// country's length and layout, like Germany's 22 all-digit characters after the country code, or the UK's
// four-letter bank code.
test("not an IBAN: a right check digit with an unknown country, the wrong length or the wrong layout", () => {
  const wrong = [
    iban("XY", "12345678901234567890"), // no country XY
    iban("US", "021000021123456789"), // the US has no IBANs
    iban("DE", "21305302069560409"), // Germany: one digit short
    iban("DE", "2130530206956040961"), // one too many
    iban("DE", "21305302069560409A"), // a letter where Germany has digits
    iban("GB", "123479001422116219"), // digits where the UK has its bank's letters
    iban("FR", "9524536023JXDSYBG4CR91"), // France is 27
    iban("NL", "FJYF13487232"), // the Netherlands is 18
    iban("ES", "3435822460797132104"), // Spain is 24
  ];
  for (const v of wrong) {
    expectNothing(v);
    expectNothing(`Wire it to ${printed(v)} today`);
    expectNothing(`my iban is ${v}`); // after its name, the same rule
    expectNothing(`iban: ${printed(v).toLowerCase()}`);
  }
});

// Order, booking and tracking codes, serial numbers and license keys, each built here so it happens to pass
// the mod-97 check by chance. None of them is an IBAN.
test("order, booking and tracking codes, serials and keys that pass the IBAN check stay quiet", () => {
  for (const text of [
    `Order ${iban("OR", "D48291173556")} never arrived`,
    `my booking code is ${iban("BK", "Q7P2X9R4M3")}`,
    `Tracking: ${iban("TR", "ACK59302847116")}`, // TR (Turkey) is 26, this is 18
    `serial no. ${iban("SN", "7KJ3M04L92681")} on the router`,
    `license key ${iban("LK", "2P9RT4M3WB8N6HJ5")}`,
    `the invoice is ${iban("IN", "V20261002004")}`,
    iban("TA", "306HGI9I73A6R1R"), // a random 17-character code
    iban("AK", "304KAJ98ZJZZS71"),
    `PO ${iban("PO", "20261002118833")}`,
  ])
    expectNothing(text);
});

// Checks how often a random code passes as an IBAN, with a seeded generator so the counts are the same every
// run. Without checking the registry of real country codes, a 17-character run of capitals and digits would
// pass 1 time in 2,500, and a code shaped like an IBAN, two capitals then digits, would pass 1 time in 100,
// since only the mod-97 check would stand in the way. The bounds here are loose, so a rule that gets removed
// by accident still shows up as a failure.
test("IBAN: random codes almost never pass", () => {
  const random = seeded(20261002);
  const count = (list) => list.reduce((n, c) => n + (detect(c).bank_account || []).length, 0);
  const capitals = codes(20000, () => chars(random, CAPITALS + DIGITS, 17));
  assert.equal(count([capitals.join(" ")]), 0, "17 capitals and digits");
  let shaped = 0;
  for (const length of [15, 16, 18, 20, 22, 24, 27, 28]) {
    const list = codes(2500, () => chars(random, CAPITALS, 2) + chars(random, DIGITS, length - 2));
    shaped += count([list.join(" ")]);
  }
  assert.ok(shaped <= 20, `IBAN-shaped codes: ${shaped} in 20000`);
});

// ---------- Driver's licenses: "DL" ----------

test("a code that starts with DL isn't a driver's license: servers, flights, deliveries, part numbers", () => {
  for (const text of [
    "HP ProLiant DL380G10 server",
    "is the DL380 Gen10 any good?",
    "Delta flight DL 1234 to Atlanta",
    "my flight is DL1234 tomorrow",
    "delivery code DL48291123",
    "your delivery code is DL-4829-1123",
    "part DL4500-2231 in stock?",
    "DL 4521 9932",
    "Dell PowerEdge DL 5521",
    "order DL7JK6S23K",
    "DLXNGXF386T0MPRIJ",
    "DL6BPH03NPKJTU91H",
    "DL0573013103930",
  ])
    expectNothing(text);
});

test("a driver's license after its label is still caught, DL with a state's number too", () => {
  for (const [text, value] of [
    ["driver's license: D1234567", "D1234567"],
    ["driving licence number 12345678", "12345678"],
    ["DL# S12345678", "S12345678"],
    ["DL: D1234567", "D1234567"],
    ["DL no. 123456789", "123456789"],
    ["my DL is 123456789", "123456789"],
    ["D.L. D4826193", "D4826193"],
    ["DL (D1234567)", "D1234567"],
    ["licencia de manejo: A1234567", "A1234567"],
    // "DL" and a space: the number must be shaped like a state's license
    ["DL D4826193", "D4826193"], // California: a letter and seven digits
    ["DL 12345678", "12345678"], // Texas: eight digits
    ["DL F123-456-78-901-0", "F123-456-78-901-0"], // Florida: a letter and twelve digits
    ["Name: Jane Roe, DL SB123456", "SB123456"], // Ohio: two letters and six digits
  ])
    expectOnly(text, "drivers_license", value);
});

test("driver's license: random codes that start with DL never pass", () => {
  const random = seeded(20261003);
  const list = codes(5000, () => "DL" + chars(random, CAPITALS + DIGITS, 8 + Math.floor(random() * 16)));
  const found = detect(list.join(" ")).drivers_license || [];
  assert.equal(found.length, 0, `${found.length} in 5000`);
});

// ---------- Cards: the Luhn check passes 1 number in 10 ----------

// Works out a valid Luhn check digit for a made-up card number.
function card(start) {
  for (let d = 0; d < 10; d++) {
    const n = (start + d).replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < n.length; i++) {
      let v = Number(n[n.length - 1 - i]);
      if (i % 2) v = v * 2 > 9 ? v * 2 - 9 : v * 2;
      sum += v;
    }
    if (sum % 10 === 0) return start + d;
  }
}

// Amazon's order numbers are grouped 3-7-7 digits, and 1 in 10 of them passes the card check, so only the
// grouping tells an order number apart from a card. A card is typed in fours, with a shorter last group, or
// grouped 4-6-5 for American Express and 4-6-4 for Diners Club.
test("an order number grouped another way isn't a card: Amazon's 3-7-7", () => {
  for (const text of [
    "Order #819-6824017-3062417 never arrived",
    "my order 586-7423846-0807778 was charged twice",
    "Pedido 143-4550015-9079957: ¿cuándo llega?",
    `the refund for ${card("114-5502817-391782")} is late`,
  ])
    expectNothing(text);
  const random = seeded(20261004);
  const orders = codes(
    2000,
    () => `${chars(random, DIGITS, 3)}-${chars(random, DIGITS, 7)}-${chars(random, DIGITS, 7)}`,
  );
  const found = detect(`My orders: ${orders.join(", ")}`).credit_card || [];
  assert.equal(found.length, 0, `${found.length} of 2000 order numbers read as a card`);
});

test("a card is still caught however it's typed: in fours, with dashes, in one run, every network", () => {
  for (const value of [
    "4111 1111 1111 1111", // Visa
    "4111-1111-1111-1111",
    "4111111111111111",
    "5555 5555 5555 4444", // Mastercard
    card("2221 0000 0000 000"), // Mastercard, the 2017 expansion (2221-2720)
    "3782 822463 10005", // American Express, as printed on the card
    "3782 8224 6310 005", // and in fours
    "378282246310005",
    card("6011 0009 9013 942"), // Discover
    "3056 930902 5904", // Diners Club
    card("3528 0000 0000 000"), // JCB
    "4222 2222 2222 2", // 13 digits
    card("6212 3456 7890 1234 56"), // UnionPay, 19 digits
    card("601100099013942412"), // Discover, 19 digits
    card("6304 0000 0000 000"), // Maestro, 13 digits
  ])
    expectOnly(`my card is ${value} exp 09/28`, "credit_card", value);
});

// An IBAN printed in groups of four has a run of digits that can pass a card check, which used to make 1 in
// 10 IBANs raise two warnings instead of one.
test("the digits inside an IBAN aren't a card", () => {
  for (const text of [
    `Wire it to ${printed(iban("IL", "0782703740572779206"))} today`,
    `iban: ${printed(iban("LT", "7748993440972592")).toLowerCase()}`,
    `Mi IBAN es ${printed(iban("PL", "779502869335113305966983"))}`,
  ])
    assert.deepEqual(Object.keys(detect(text)), ["bank_account"], text);
});

// A bare 13-to-19-digit number passes the Luhn check about 1 time in 10, so real tracking, order, confirmation
// and account numbers of that length land in it by chance. With no card word nearby, the number also has to
// fall within a real network's prefix and length before it counts as a card.
test("a bare card-shaped number with no card word nearby must be from a real network: made-up prefixes stay quiet", () => {
  for (const text of [
    `The tracking number is ${card("199999999999999")} for your package.`, // prefix 19: no network uses it
    `order ref ${card("999999999999999")}`, // prefix 99: no network uses it
    `confirmation ${card("012345678901234")}`, // starts with 0
    `Can you check ${card("199999999999999")}? It looks wrong.`,
    card("199999999999999"), // nothing around it at all
  ])
    expectNothing(text);
});

// The same made-up numbers still count once a card word names them. Someone who says "my card is ..." means
// it, even for a network this list doesn't have yet, so a labelled number is never held to the prefix rule.
test("a card number after its label still counts even from a made-up prefix", () => {
  for (const [text, value] of [
    [`my card is ${card("199999999999999")} exp 09/28`, card("199999999999999")],
    [`my Visa card number is ${card("999999999999999")}`, card("999999999999999")],
    [`la tarjeta de crédito es ${card("012345678901234")}`, card("012345678901234")],
  ])
    expectOnly(text, "credit_card", value);
});

// Checks how often a random 13-to-19-digit number passes as a card, with a seeded generator so the count is
// the same every run. Without the real-network rule, the Luhn check alone would pass about 1 in 10. The bound
// here is loose, so a rule that gets removed by accident still shows up as a failure.
test("card: random bare numbers almost never pass once a real network is required", () => {
  const random = seeded(20261008);
  let hits = 0;
  const count = 20000;
  for (let i = 0; i < count; i++) {
    const len = 13 + Math.floor(random() * 7); // 13..19
    const n = chars(random, DIGITS, len);
    if ((detect(`the number is ${n} on the form`).credit_card || []).length) hits++;
  }
  assert.ok(hits <= 400, `${hits} of ${count} random numbers read as a card`);
});

// ---------- US tax numbers (ITIN): no check digit at all ----------

// An ITIN is shaped like a Social Security number but starts with 9, and it has no check digit, so 1 in 23
// random 9-digit numbers happen to fit its ranges. Like an SSN, 9 digits in one solid run only count after a
// label, but with its dashes an ITIN counts on its own.
test("9 digits starting with 9 aren't an ITIN without its dashes or its name", () => {
  for (const text of ["912701234", "the code is 946512345", "ref 946512345", "tracking 970123456 hasn't moved"])
    expectNothing(text);
  const random = seeded(20261005);
  const numbers = codes(5000, () => "9" + chars(random, DIGITS, 8));
  const found = numbers.filter((n) => detect(n).national_id);
  assert.equal(found.length, 0, `${found.length} of 5000 read as an ITIN`);
});

test("an ITIN with its dashes or after its name is still caught", () => {
  for (const [text, value] of [
    ["912-70-1234", "912-70-1234"],
    ["my ITIN is 912-70-1234", "912-70-1234"],
    ["912 70 1234 is my number", "912 70 1234"],
    ["my ITIN is 912701234", "912701234"],
    ["ITIN: 912701234", "912701234"],
    ["my tax id is 912701234", "912701234"],
  ])
    expectOnly(text, "national_id", value);
});

// ---------- Phones: the "00" international prefix ----------

// Dialling abroad starts with "00" and then the country code. A solid run of digits that merely starts with
// "00" and a digit 2-9 is, far more often, just an ID with two leading zeros, like a request, order,
// confirmation, account or reference number. The examples here are made up; none is a real international number.
test("a code that starts 00 and a digit isn't a phone from abroad: IDs, orders, confirmations, accounts, refs", () => {
  for (const text of [
    "The log says request id 0049372819462.", // the shape that does it: 00, a digit 2-9, 8+ more digits
    "Can you check 0093728194621 for me?",
    "order 0071234567890 shipped today",
    "confirmation 0066123456789",
    "the invoice number is 0082736451902",
    "ref 0028374659102",
    "0049372819462", // nothing around it at all
    "0093728194621",
  ])
    expectNothing(text);
});

// A real international number still counts, whether it's written with a "+", spelled out as "plus", printed
// in pieces the way a country code and national number usually are, or typed as one run near a phone word.
test("a real international number after 00 is still caught, in pieces or near a phone word", () => {
  for (const [text, value] of [
    ["0044 20 7946 0958", "0044 20 7946 0958"],
    ["call 0093 7146 5600 about it", "0093 7146 5600"],
    ["+44 20 7946 0958", "+44 20 7946 0958"],
    ["call me on 0044207946095 8", "0044207946095 8"], // two groups, not one solid run
    ["call 0044207946958 when you land", "0044207946958"], // a phone word right before a solid run
  ])
    expectOnly(text, "phone_number", value);
});

// Checks how often a random code passes as a phone number this way, with a seeded generator so the count is
// the same every run. A code shaped "00", a digit 2-9, then 7 or more digits happens about 1 in 120 by chance,
// and almost every one used to pass. The bound here is loose, so a rule that gets removed by accident still
// shows up as a failure.
test("phone: random codes shaped 00-and-a-digit almost never pass", () => {
  const random = seeded(20261009);
  let hits = 0;
  const count = 40000;
  for (let i = 0; i < count; i++) {
    const len = 12 + Math.floor(random() * 4); // 12..15, clear of the 10/11-digit NANP shape
    const code = chars(random, DIGITS, len);
    if ((detect(code).phone_number || []).length) hits++;
  }
  assert.ok(hits <= 10, `${hits} of ${count} random codes read as a phone`);
});

// ---------- UK National Insurance numbers: no check digit at all ----------

// A NINO is two letters, six digits, then a letter, with no check digit at all, so a bare match passes about 1
// random code of that shape in 11.5, as measured below. Far more often it's really a product code, a flight
// or booking reference, or a serial number, so a bare match only counts with a National Insurance word nearby,
// the same kind of rule used for a bare card or phone number.
test("a bare NINO-shaped code isn't a National Insurance number without an NI word nearby", () => {
  for (const text of [
    "product code AB 12 34 56 C",
    "flight reference AB 12 34 56 C",
    "booking ref AB123456C",
    "serial number AB 12 34 56 C",
    "AB123456C", // nothing around it at all
  ])
    expectNothing(text);
});

// Checks how often a random NINO-shaped code, using real prefix and suffix letters, 6 digits and a final
// letter A-D, passes without a label. That should land close to the 1-in-11.5 estimate expected from having
// no check digit at all. The bound below is loose, so a rule that gets removed by accident still shows up as
// a failure.
test("NINO: random bare codes of the right shape almost never pass without a label", () => {
  const random = seeded(20261010);
  let hits = 0;
  const count = 20000;
  for (let i = 0; i < count; i++) {
    const code = chars(random, CAPITALS, 2) + chars(random, DIGITS, 6) + chars(random, CAPITALS, 1);
    if ((detect(`the code is ${code} on the form`).national_id || []).length) hits++;
  }
  assert.ok(hits <= 50, `${hits} of ${count} random codes read as a national_id`);
});

// ---------- Labels stuck to other letters or digits ----------

// A label's letters inside a code aren't its label. "4PW" can turn up in an IBAN's group, "MRN" at the start
// of a code, or "CCV" right in front of a code whose digits run on into letters. Random codes used to warn for
// a password about 1 list in 1,250.
test("a label's letters inside a code aren't a label", () => {
  for (const text of [
    "U4PW 7VRN LKZC",
    "the code 4PW 7VRN",
    "0ACTWFKDAIXL875PW BWNCFC7L4E1H4GKVM",
    "MRNWQ3FY8P394VH6U",
    "the part is MRNZT22KNPFJN6Y7G",
    "CCV581MFYU0P3VKJQ",
  ])
    expectNothing(text);
  const random = seeded(20261006);
  const lists = codes(2000, () => codes(5, () => chars(random, CAPITALS + DIGITS, 17)).join(" "));
  const found = lists.filter((l) => detect(l).password || detect(l).medical_record || detect(l).card_code);
  assert.equal(found.length, 0, `${found.length} of 2000 lists of codes warned`);
});

test("the labels themselves still count: pw, MRN, CVV", () => {
  for (const [text, id, value] of [
    ["pw Fluffy!23", "password", "Fluffy!23"],
    ["my pw is Summer2024", "password", "Summer2024"],
    ["wifi pw: Tr0ub4dor", "password", "Tr0ub4dor"],
    ["MRN 00123456", "medical_record", "00123456"],
    ["MRN#00123456", "medical_record", "00123456"],
    ["MRN00123456", "medical_record", "00123456"],
    ["MRN: A1234567", "medical_record", "A1234567"],
    ["my CVV is 581", "card_code", "581"],
    ["cvv 123", "card_code", "123"],
    ["CVV581", "card_code", "581"],
  ])
    expectOnly(text, id, value);
});

// ---------- Speed ----------

// Repeating the same hostile text thousands of times should take about 4 times as long when there's 4 times
// as much of it, never 16 times, since no rule here reads the text again for each thing it finds. Takes the
// best of 3 runs and remeasures a miss (see tests/timing.js).
test("these rules stay fast on hostile text", () => {
  let runs = 0; // each run gets its own text, so no kept answer hides the work
  const detectFresh = (text) => globalThis.Clotr.detect(text + " ".repeat(++runs % 7));
  for (const unit of [
    "DL ",
    "DL# 1234 ",
    "DL 12345678 ",
    "DL1234567 ",
    "AB12 3456 7890 1234 4111 1111 1111 1111 ", // a card inside a code shaped like an IBAN
    "4111 1111 1111 1111. AB12 CDEF GHIJ. ", // and next to one
    "4111-1111-1111-1111 ",
    "819-6824017-3062417 ",
    "iban: es16 3435 ",
    "DE89 3704 0044 0532 0130 00 ",
  ]) {
    const small = unit.repeat(1000);
    const big = unit.repeat(4000);
    retrySlow(() => {
      const a = bestOfBoth(() => detectFresh(small));
      const b = bestOfBoth(() => detectFresh(big));
      if (b.over(1500)) return `${JSON.stringify(unit)}: ${b.wall.toFixed(0)} ms for 4000 repeats`;
      if (b.wall >= 50 && grewMoreThan(a, b, 10))
        return `${JSON.stringify(unit)}: ${a.wall.toFixed(0)} → ${b.wall.toFixed(0)} ms for 4 times the text`;
    });
  }
});

// Tests the message corpus behind "Is this a scam?": real-looking scam messages and the everyday messages that
// resemble them, in English and Spanish, each labelled with the warning signs it actually contains. Every value
// in them is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { retrySlow, bestOfBoth, bestOfPair, grewMoreThan } = require("./timing.js");

// The signs, in their order.
const SIGN_IDS = [
  "asks_code",
  "asks_card_code",
  "asks_gift_card",
  "asks_remote",
  "asks_details",
  "asks_command",
  "pay_crypto",
  "pay_hard_to_undo",
  "pay_move_money",
  "press_rush",
  "press_secret",
  "press_threat",
  "press_stay",
  "pret_gov",
  "pret_bank",
  "pret_support",
  "pret_family",
  "pret_romance",
  "pret_knows_you",
  "prob_account",
  "prob_prize",
];

// The four corpus files, and the minimum number of messages each must hold.
const CORPORA = {
  "scam-messages.txt": { min: 150, scam: true },
  "scam-messages-es.txt": { min: 75, scam: true },
  "scam-lookalikes.txt": { min: 150, scam: false },
  "scam-lookalikes-es.txt": { min: 75, scam: false },
};

// A corpus file has comment lines first, then messages separated by lines of "---", each starting with its own label line.
function readFile(file) {
  return fs.readFileSync(path.join(__dirname, "corpus", file), "utf8");
}
function readLabelled(file) {
  return readFile(file)
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((m) => {
      const nl = m.indexOf("\n");
      return nl < 0 ? { label: m, text: "" } : { label: m.slice(0, nl).trim(), text: m.slice(nl + 1).trim() };
    });
}
// "[signs: asks_code, press_rush]" → ["asks_code", "press_rush"]; "[signs: none]" → []; anything else → null.
function parseLabel(label) {
  const m = /^\[signs: ([a-z_, ]+)\]$/.exec(label);
  if (!m) return null;
  return m[1] === "none" ? [] : m[1].split(",").map((s) => s.trim());
}

// Lists what can be wrong with one file's shape: a label that doesn't parse, an unknown or repeated sign, a
// scam message with no sign at all, an empty message, or a message that appears twice.
function shapeProblems(file, { scam }) {
  const problems = [];
  const seen = new Set();
  for (const { label, text } of readLabelled(file)) {
    const signs = parseLabel(label);
    const where = `${file}: ${text.slice(0, 50)}`;
    if (!signs) problems.push(`${where}: bad label ${label}`);
    else {
      for (const s of signs) if (!SIGN_IDS.includes(s)) problems.push(`${where}: unknown sign ${s}`);
      if (new Set(signs).size !== signs.length) problems.push(`${where}: a sign twice`);
      if (scam && !signs.length) problems.push(`${where}: a scam message with no sign`);
      if (signs.includes("pret_knows_you")) problems.push(`${where}: pret_knows_you needs a vault, test it apart`);
    }
    if (!text) problems.push(`${where}: no message`);
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) problems.push(`${where}: there twice`);
    seen.add(key);
  }
  return problems;
}

// Checks that every value is made up: a phone number must be a 555-01xx one, and a web address or email must
// be under example.com, .org, .net or example.invalid. Returns whatever isn't.
const PHONE = /(?<![\d$€.,])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])?\d{3}[\s.-]\d{4}(?![\d.,])/g;
const MADE_UP_PHONE = /555[\s.-]01\d\d$/;
const HOST =
  /(?<![\p{L}\p{N}@.-])(?:[a-z0-9-]+\.)+(?:com|org|net|gov|edu|invalid|info|io|co|us|uk|es|mx|biz|app|xyz|online|site|top)(?![\p{L}\p{N}-])/giu;
const MADE_UP_HOST = /(?:^|\.)example\.(?:com|org|net|invalid)$/i;
const EMAIL_HOST = /[\w.+-]@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
function realValues(text) {
  const out = [];
  for (const m of text.matchAll(PHONE)) if (!MADE_UP_PHONE.test(m[0])) out.push(`phone ${m[0]}`);
  for (const m of text.matchAll(HOST)) if (!MADE_UP_HOST.test(m[0])) out.push(`address ${m[0]}`);
  for (const m of text.matchAll(EMAIL_HOST))
    if (!MADE_UP_HOST.test(m[1].replace(/\.$/, ""))) out.push(`email @${m[1]}`);
  return out;
}

test("the scam corpora have their sizes and are well formed", () => {
  for (const [file, { min, scam }] of Object.entries(CORPORA)) {
    const msgs = readLabelled(file);
    assert.ok(msgs.length >= min, `${file}: ${msgs.length} messages, at least ${min} wanted`);
    assert.deepEqual(shapeProblems(file, { scam }), [], file);
    assert.match(readFile(file), /^# /, `${file}: no header`);
  }
});

test("every phone number, web address and email in the scam corpora is made up", () => {
  for (const file of Object.keys(CORPORA)) {
    const found = readLabelled(file).flatMap(({ text }) => realValues(text).map((v) => `${v} ← ${text.slice(0, 50)}`));
    assert.deepEqual(found, [], file);
  }
});

test("the made-up check catches a real-looking number, address and email", () => {
  assert.deepEqual(realValues("Call (555) 555-0142 or 1-800-555-0199, see example.com/x or bank.example.invalid"), []);
  assert.deepEqual(realValues("Call 555-282-4410 at mybank.com or write to help@realbank.com"), [
    "phone 555-282-4410",
    "address mybank.com",
    "email @realbank.com",
  ]);
  // Amounts of money and times of day are never mistaken for a number to call.
  assert.deepEqual(realValues("Pay $2,400.00 by 11:59 PM, 1.500 € or 0,1 BTC"), []);
});

// The corpora cover every scenario and every sign except the vault's, which needs the person's own details to trigger.
test("the scam corpora use every sign, in both languages, and the look-alikes are mostly none", () => {
  const used = (file) => new Set(readLabelled(file).flatMap(({ label }) => parseLabel(label) || []));
  for (const file of ["scam-messages.txt", "scam-messages-es.txt"]) {
    const missing = SIGN_IDS.filter((s) => s !== "pret_knows_you" && !used(file).has(s));
    assert.deepEqual(missing, [], `${file}: signs with no message`);
  }
  for (const file of ["scam-lookalikes.txt", "scam-lookalikes-es.txt"]) {
    const msgs = readLabelled(file);
    const none = msgs.filter(({ label }) => label === "[signs: none]").length;
    assert.ok(none / msgs.length >= 0.9, `${file}: only ${none} of ${msgs.length} have no sign`);
  }
});

// ---------- The signs (scam-signs.js) ----------

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/scam-signs.js");
const { scamSigns, SCAM_SIGNS, askLabels, detect } = globalThis.Clotr;

const found = (text, opts) => scamSigns(text, opts).map((s) => s.id);
// Returns the words a sign actually marked, for the messages below.
const words = (text, id) =>
  scamSigns(text)
    .find((s) => s.id === id)
    ?.spans.map((s) => text.slice(s.start, s.end));

test("the signs match their defined order and groups", () => {
  assert.deepEqual(
    SCAM_SIGNS.map((s) => s.id),
    SIGN_IDS,
  );
  for (const s of SCAM_SIGNS) assert.equal(s.group, s.id.split("_")[0], s.id);
});

// Lists what's wrong with a corpus: a listed sign that wasn't found counts as a miss, and a found sign that
// isn't listed counts as a wrong one.
function signProblems(file) {
  const problems = [];
  for (const { label, text } of readLabelled(file)) {
    const want = parseLabel(label);
    const got = found(text);
    for (const s of want) if (!got.includes(s)) problems.push(`missed ${s} ← ${text.slice(0, 70)}`);
    for (const s of got) if (!want.includes(s)) problems.push(`wrong ${s} ← ${text.slice(0, 70)}`);
  }
  return problems;
}

// Runs that check against all four corpora: every listed sign must be found, and no sign beyond what the label lists.
for (const file of Object.keys(CORPORA))
  test(`every message's signs are exactly its label's (${file})`, () => {
    assert.deepEqual(signProblems(file), []);
  });

test("the made-up message gives exactly its four signs, in both languages, marking their words", () => {
  const en =
    "This is the fraud team at Anytown Bank. We stopped a strange payment on your card. To cancel it, reply right away with the 6-digit code we just texted you. Don't tell anyone at the branch, they may be in on it.";
  const es =
    "Somos el equipo de fraude de Banco Ejemplo. Hemos parado un pago extraño con tu tarjeta. Para cancelarlo, responde ya con el código de 6 cifras que te acabamos de enviar. No se lo digas a nadie de la oficina, pueden estar metidos.";
  for (const text of [en, es])
    assert.deepEqual(found(text), ["asks_code", "press_rush", "press_secret", "pret_bank"], text.slice(0, 30));
  assert.deepEqual(words(en, "asks_code"), ["the 6-digit code we just texted you"]);
  assert.deepEqual(words(en, "press_rush"), ["right away"]);
  assert.deepEqual(words(en, "press_secret"), ["Don't tell anyone at the branch", "they may be in on it"]);
  assert.deepEqual(words(en, "pret_bank"), ["the fraud team at Anytown Bank"]);
  assert.deepEqual(words(es, "asks_code"), ["el código de 6 cifras que te acabamos de enviar"]);
});

test("a bank's or the government's name alone isn't a sign: it needs an ask or a way to pay beside it", () => {
  assert.deepEqual(found("Anytown Bank Fraud Alert: a purchase of $82.10 was approved on your card."), []);
  assert.deepEqual(found("This is the IRS. Your return was received and is being processed."), []);
  assert.deepEqual(found("Anytown Bank fraud team: please tell me the code we just texted you."), [
    "asks_code",
    "pret_bank",
  ]);
  assert.deepEqual(found("This is the IRS. Pay your balance by wire transfer."), ["pay_hard_to_undo", "pret_gov"]);
});

test("a request said as a warning against itself isn't a sign, whether it's never, don't, or someone else asking", () => {
  for (const text of [
    "We will never ask you for the code we sent you.",
    "Don't give the 3 numbers on the back of your card to anyone.",
    "If someone asks you for the code we texted you, hang up.",
    "Anyone who asks for your Social Security number by text is a scammer.",
    "Nunca te pediremos el código de verificación.",
    "Si alguien te pide los 3 números de atrás de tu tarjeta, cuelga.",
  ])
    assert.deepEqual(found(text), [], text);
  // "If you didn't…" and "si no…" are conditions, not warnings.
  assert.deepEqual(found("If it wasn't you, reply with the code we sent to your email."), ["asks_code"]);
  assert.deepEqual(found("Si no fue usted, responda con el código que le enviamos."), ["asks_code"]);
});

test("scamSigns reports which kinds of your own details it saw, never the values themselves", () => {
  const text = "Hello Maria Lopez, this is the IRS. Confirm your Social Security number today.";
  const at = text.indexOf("Maria Lopez");
  const mine = [{ kind: "my_name", start: at, end: at + "Maria Lopez".length }];
  const signs = scamSigns(text, { mine });
  const knows = signs.find((s) => s.id === "pret_knows_you");
  assert.deepEqual(knows.kinds, ["my_name"]);
  assert.deepEqual(knows.spans, [{ start: at, end: at + 11 }]);
  // What comes back never holds the name itself, only positions and the names of kinds.
  assert.ok(!JSON.stringify(signs).includes("Maria"), JSON.stringify(signs));
  assert.equal(found(text).includes("pret_knows_you"), false, "without your details, no such sign");
  // A span that isn't in the text is dropped.
  assert.equal(found(text, { mine: [{ kind: "my_name", start: 500, end: 510 }] }).includes("pret_knows_you"), false);
});

test("every sign's spans are inside the text, in order, and don't repeat", () => {
  for (const file of Object.keys(CORPORA))
    for (const { text } of readLabelled(file))
      for (const s of scamSigns(text)) {
        assert.ok(s.spans.length, `${s.id} with no words ← ${text.slice(0, 40)}`);
        let last = -1;
        for (const { start, end } of s.spans) {
          assert.ok(start >= 0 && end <= text.length && end > start && start >= last, `${s.id}: ${start}-${end}`);
          last = end;
        }
      }
});

// The scam rules that recognize a told code and the signs that recognize someone asking for one share the same
// label patterns, so the wording can't drift apart between them. Each case below pairs a phrase where someone
// already gave the code, found by detect() as that code, with a phrase where someone is asking for it, found as
// the matching sign.
test("Clotr.askLabels: the scam rules' own labels, and what detect() finds after them", () => {
  assert.deepEqual(Object.keys(askLabels).sort(), [
    "card_code",
    "gift_card",
    "login_code",
    "recovery_codes",
    "remote_code",
    "security_answer",
  ]);
  for (const re of Object.values(askLabels)) assert.ok(re instanceof RegExp && re.flags.includes("i"), String(re));
  const kindOf = (text) => detect(text).map((r) => (r.id === "password" ? r.asks?.join("+") || r.id : r.id));
  for (const [label, told, asked, kind] of [
    ["login_code", "the code they texted me is 482913", "tell me the code we texted you", "login_code"],
    ["login_code", "my verification code is 552019", "what's your verification code?", "login_code"],
    ["card_code", "the 3 numbers on the back are 482", "read me the 3 numbers on the back", "card_code"],
    [
      "gift_card",
      "the gift card code is 7KQ2-9PMX-4RT8",
      "send me the numbers on the back of the gift card",
      "gift_card",
    ],
    ["remote_code", "my AnyDesk code is 123 456 789", "install AnyDesk", "remote_code"],
    ["recovery_codes", "my backup codes are 1234 5678, 2345 6789", "send us your backup codes", "recovery_codes"],
    ["security_answer", "my mother's maiden name is Smith", "what's your mother's maiden name?", "security_answer"],
  ]) {
    assert.ok(new RegExp(askLabels[label].source, "iu").test(told), `${label} doesn't read: ${told}`);
    assert.ok(new RegExp(askLabels[label].source, "iu").test(asked), `${label} doesn't read: ${asked}`);
    assert.deepEqual(kindOf(told), [kind], told);
  }
  // Each rule is built from its label, and that label's source is written only once, in patterns.js.
  const src = fs.readFileSync(path.join(__dirname, "..", "extension", "patterns.js"), "utf8");
  for (const name of [
    "LOGIN_NAMES",
    "CODE_THEY_SENT",
    "LOGIN_LABEL_ES",
    "CARD_LABEL",
    "GIFT_WORDS",
    "REMOTE_WORDS",
    "REMOTE_WORDS_ES",
    "RECOVERY_LABEL",
    "ANSWER_LABEL",
    "ANSWER_LABEL_ES",
  ])
    assert.ok((src.match(new RegExp(`\\$\\{${name}\\}`, "g")) || []).length >= 1, `${name} isn't used by a rule`);
});

// A long paste, such as a whole email thread, must be read in time that grows with its length, not faster than
// that; this is the same budget that once caught a slowdown in the otp_secret rule. It's measured the same way
// as the other speed checks in tests/timing.js: best of three runs, the two lengths timed in alternating turns,
// retried after a pause if a busy moment slowed one of them, with a budget that grows on a busy computer by as
// much as a reference task slows down.
test("a long message is read in linear time, and hostile text in a moment", () => {
  const block = readLabelled("scam-messages.txt")
    .map((m) => m.text)
    .join("\n");
  const big = Array(8).fill(block).join("\n");
  retrySlow(() => {
    const [one, eight] = bestOfPair(
      () => scamSigns(block),
      () => scamSigns(big),
      8,
      8,
    );
    if (grewMoreThan(one, eight, 16, 1)) return `8× the text: ${one.wall.toFixed(0)} → ${eight.wall.toFixed(0)} ms`;
  });
  // Long runs of the words the rules look for.
  for (const text of ["code ".repeat(20000), "send me ".repeat(10000), "a".repeat(100000), "the 3 ".repeat(15000)])
    retrySlow(() => {
      const t = bestOfBoth(() => scamSigns(text), 1);
      if (t.over(3000))
        return `${text.slice(0, 10)}…: ${t.wall.toFixed(0)} ms (${t.allowed.toFixed(0)} allowed on this computer now)`;
    });
});

test("nothing but text in: an empty, missing or odd input gives no signs and doesn't throw", () => {
  for (const v of ["", "   ", undefined, null, 42, {}]) assert.deepEqual(scamSigns(v), []);
});

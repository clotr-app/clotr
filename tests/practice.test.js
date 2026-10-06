// The practice page gives someone six made-up scam messages to answer, then a Spot the Leak round. Every
// reveal comes from the real engine, so these tests run every drill's reply and every Spot-the-Leak message
// through detect(), in both English and Spanish. If the engine changes, a drill fails here before it can show
// something Clotr doesn't actually do. Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
const ES = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect } = globalThis.Clotr;

// Stands in for chrome.i18n, built from the Spanish locale file, and also handles the browser's bare $1 placeholders.
function spanish(key, subs = []) {
  const m = ES[key];
  if (!m) return "";
  return m.message
    .replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => {
      const n = Number(/^\$(\d)$/.exec(m.placeholders[name].content)[1]);
      return subs[n - 1] ?? "";
    })
    .replace(/\$(\d)/g, (_, n) => subs[n - 1] ?? "");
}

// Loads the practice data in one language: English comes straight from the file, Spanish comes through _locales.
function load(lang) {
  const file = require.resolve("../extension/practice-data.js");
  delete require.cache[file];
  const before = globalThis.chrome;
  globalThis.chrome = lang === "es" ? { i18n: { getMessage: spanish } } : undefined;
  try {
    require(file);
    return globalThis.Clotr.practice;
  } finally {
    globalThis.chrome = before;
  }
}
const LANGS = { en: load("en"), es: load("es") };

// Formats what detect() finds the way the data lists it: each kind appears once, and a scam code's reasons follow a colon.
const finds = (text) =>
  detect(text)
    .map((r) => (r.asks ? `${r.id}:${r.asks.join(",")}` : r.id))
    .sort();

test("six drills and 24 Spot-the-leak messages, the same in English and Spanish, in the same order", () => {
  const { en, es } = LANGS;
  assert.equal(en.drills.length, 6);
  assert.equal(en.leaks.length, 24);
  assert.deepEqual(
    es.drills.map((d) => d.id),
    en.drills.map((d) => d.id),
  );
  assert.deepEqual(
    es.leaks.map((l) => [l.id, l.finds]),
    en.leaks.map((l) => [l.id, l.finds]),
  );
  assert.equal(en.leaks.filter((l) => l.finds.length).length, 12, "12 with something private");
  assert.equal(en.leaks.filter((l) => !l.finds.length).length, 12, "12 without");
  // Checks that Spanish really is Spanish, not just the English text left in place.
  for (const [i, d] of es.drills.entries())
    for (const field of ["who", "from", "message", "reply", "safer", "why"])
      assert.notEqual(d[field], en.drills[i][field], `drill ${d.id}: ${field} has no Spanish`);
  for (const [i, l] of es.leaks.entries()) assert.notEqual(l.text, en.leaks[i].text, `${l.id} has no Spanish`);
});

test("every drill's made-up reply finds what the drill says, in both languages, and its safer reply finds nothing", () => {
  for (const [lang, data] of Object.entries(LANGS)) {
    for (const d of data.drills) {
      assert.deepEqual(finds(d.reply), [...d.finds].sort(), `${lang} drill ${d.id}: "${d.reply}"`);
      assert.deepEqual(finds(d.safer), [], `${lang} drill ${d.id}'s safer reply: "${d.safer}"`);
    }
  }
  // The six drills ask, in order, for a sign-in code, a gift card, a buyer's code, a remote-access code,
  // a card's security code, and a home address.
  assert.deepEqual(
    LANGS.en.drills.map((d) => d.finds),
    [
      ["password:login_code"],
      ["gift_card"],
      ["password:login_code"],
      ["password:remote_code"],
      ["card_code"],
      ["street_address"],
    ],
  );
});

// Five drills ask outright for a code, a PIN, a remote-access number or a card's numbers. A bare reply in that
// exact shape must still find nothing for real, since a real chat has to stay quiet on a number alone unless it
// happens to match another kind's shape, like an SSN. The support drill's sample is chosen to avoid that overlap
// on purpose. Because detect() stays quiet here, each drill's own data has to say so honestly; detect() and
// decide.js never carry this exception themselves.
test("a bare reply shaped like what a drill asked for stays quiet for detect(), but the drill has its own honest line about it", () => {
  const withBareAsk = ["bank", "grandson", "buyer", "support", "shop"];
  for (const [lang, data] of Object.entries(LANGS)) {
    assert.deepEqual(
      data.drills.filter((d) => d.bareAsk).map((d) => d.id),
      withBareAsk,
      `${lang}: which drills ask outright for a bare number`,
    );
    for (const d of data.drills) {
      if (!d.bareAsk) continue;
      assert.deepEqual(
        finds(d.bareAsk.sample),
        [],
        `${lang} drill ${d.id}: a bare "${d.bareAsk.sample}" must still find nothing for real`,
      );
      assert.ok(d.bareAsk.shape(d.bareAsk.sample), `${lang} drill ${d.id}: its own sample must match its own shape`);
      assert.ok(
        !d.bareAsk.shape(`${d.bareAsk.sample} please`),
        `${lang} drill ${d.id}: not bare with other words around it`,
      );
      assert.ok(d.bareAsk.text.trim(), `${lang} drill ${d.id}: needs its own honest line`);
    }
  }
  // Checks that this line is genuinely Spanish too.
  for (const [i, d] of LANGS.es.drills.entries())
    if (d.bareAsk)
      assert.notEqual(d.bareAsk.text, LANGS.en.drills[i].bareAsk.text, `drill ${d.id}: bareAsk has no Spanish`);
});

test("every Spot-the-leak message finds exactly what it lists, in both languages", () => {
  for (const [lang, data] of Object.entries(LANGS))
    for (const l of data.leaks) assert.deepEqual(finds(l.text), [...l.finds].sort(), `${lang} ${l.id}: "${l.text}"`);
});

// Every value in the practice data must be made up, never a real person's detail: phone numbers use 555-01xx,
// email addresses and links use example.com or example.invalid, and the card number is the well-known test
// number. A kind that isn't listed below fails until someone checks its value is made up and adds it here.
const MADE_UP = {
  phone_number: /^(\(\d{3}\) )?555-01\d\d$/,
  email: /@example\.(com|invalid)$/,
  credit_card: /^4111 1111 1111 1111$/,
  street_address: /^(42 Maple Street(, apartment 3)?|15 Birch Road|calle (Arce 42|Abedul 15))$/,
  date_of_birth: /^(14 March 1961|14 de marzo de 1961)$/,
  us_ssn: /^219-09-9999$/, // the Social Security Administration's own example, never issued
  bank_account: /^(1234567890|ES26 0000 1234 5612 3456 7890)$/, // the IBAN: bank 0000, no real bank
  aws_access_key: /^AKIA4HPQ7XZ2R6TWLJ3N$/, // the test suite's fake key
  password: /^(482913|552019|666 197 342|Sunflower-2024|Girasol-2024)$/,
  gift_card: /^(7KQ2-9PMX-4RT8|4471)$/,
  card_code: /^482$/,
};

test("every value in the practice is made up", () => {
  for (const [lang, data] of Object.entries(LANGS)) {
    const texts = [
      ...data.drills.flatMap((d) => [d.who, d.from, d.message, d.reply, d.safer, d.why]),
      ...data.leaks.flatMap((l) => [l.text, l.instead || ""]),
    ];
    for (const text of texts) {
      for (const r of detect(text))
        for (const m of r.matches)
          assert.match(m, MADE_UP[r.id] || /^$/, `${lang}: ${r.id} "${m}" in "${text}" isn't on the made-up list`);
      // Any web address found here must use one of the reserved example domains.
      for (const [host] of text.matchAll(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|es|io|gov|invalid)\b/gi))
        assert.match(host, /(^|\.)example\.(com|invalid)$/, `${lang}: "${host}" in "${text}"`);
    }
  }
});

test("a message with something Bandage can't cover says what the AI needs instead, and the rest just get Bandage's line", () => {
  const coverable = (r) => r.group !== "credentials" && r.bandage !== false;
  for (const [lang, data] of Object.entries(LANGS)) {
    for (const l of data.leaks) {
      const found = detect(l.text);
      const all = found.length > 0 && found.every(coverable);
      if (!found.length) assert.equal(l.instead, undefined, `${lang} ${l.id}: nothing found, nothing instead`);
      else if (all) assert.equal(l.instead, undefined, `${lang} ${l.id}: Bandage covers it all`);
      else assert.ok(l.instead, `${lang} ${l.id}: Bandage can't cover ${found.map((r) => r.id)}, so say what instead`);
    }
  }
});

// The practice page has to be a safe place to try risky-looking text: it loads only Clotr's own scripts, and
// its code never writes to storage, never messages the rest of Clotr so nothing reaches the history, and never
// goes online.
test("the practice page loads only Clotr's own scripts and never stores, sends or fetches anything", () => {
  const html = fs.readFileSync(path.join(EXT, "practice.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 4, "the page's scripts");
  for (const [, attrs, body] of scripts) {
    const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
    assert.ok(src && /^[a-z0-9-]+\.js$/.test(src), `a script that isn't one of Clotr's files: ${attrs}`);
    assert.ok(fs.existsSync(path.join(EXT, src)), `${src} isn't in the extension`);
    assert.equal(body.trim(), "", "no inline script");
  }
  assert.doesNotMatch(html, /\b(src|href)="(https?:)?\/\//, "nothing from elsewhere");
  assert.match(html, /<textarea[^>]*id="reply"[^>]*autocomplete="off"[^>]*spellcheck="false"/);
  const own = ["practice.js", "practice-data.js", "page-notice.js"].map((f) =>
    fs
      .readFileSync(path.join(EXT, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n"),
  );
  for (const code of own) {
    assert.doesNotMatch(code, /storage\.\w+\.(set|remove|clear)|sendMessage|connect\(|fetch\(|XMLHttpRequest/);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.\w+\(/);
  }
});

// Spot the Leak's Bandage line names the labels Bandage would really send, in the order they appear. It uses
// the same bl_ message words and the same numbering rules as content.js's bandageLabel(), and keeps a written
// birth year down to its decade.
test("Spot the leak: Bandage's labels are the ones Bandage would send, in both languages", () => {
  const labels = (lang, id) => {
    const data = LANGS[lang];
    const text = data.leaks.find((l) => l.id === id).text;
    const before = globalThis.chrome;
    globalThis.chrome = lang === "es" ? { i18n: { getMessage: spanish } } : undefined; // as the page's browser would
    try {
      return data.coverLabels(text, detect(text));
    } finally {
      globalThis.chrome = before;
    }
  };
  assert.deepEqual(labels("en", "landlord"), ["[Address 1]", "[Phone 1]"]);
  assert.deepEqual(labels("en", "cover"), ["[Email 1]", "[Phone 1]"]);
  assert.deepEqual(labels("en", "retirement"), ["[born in the 1960s]"]);
  assert.deepEqual(labels("en", "gym"), ["[Card 1]"]);
  assert.deepEqual(labels("en", "deposit"), ["[Account 1]"]);
  assert.deepEqual(labels("en", "tax"), ["[ID 1]"]);
  assert.deepEqual(labels("es", "landlord"), ["[Dirección 1]", "[Teléfono 1]"]);
  assert.deepEqual(labels("es", "retirement"), ["[nacimiento en los años 1960]"]);
  // Two of one kind are numbered.
  assert.deepEqual(LANGS.en.coverLabels("call 555-0142 or 555-0143", detect("call 555-0142 or 555-0143")), [
    "[Phone 1]",
    "[Phone 2]",
  ]);
  // These words for each kind come straight from content.js, so a kind added there needs adding here too.
  const content = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  const body = /function bandageWord\(id\) \{([\s\S]*?)\n {4}\}\n {2}\}/.exec(content)[1];
  const theirs = Object.fromEntries(
    [...body.matchAll(/case "(\w+)":\s*return \["(bl_\w+)"/g)].map(([, id, word]) => [id, word]),
  );
  assert.ok(Object.keys(theirs).length >= 10, `read ${Object.keys(theirs).length} kinds from content.js`);
  assert.deepEqual(LANGS.en.coverWords, theirs);
  assert.match(body, /return \["bl_id", msg\("bl_id", "ID"\)\]/, "anything else is an ID, as here");
});

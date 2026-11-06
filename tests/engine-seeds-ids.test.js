// Crypto seed phrases that are really everyday word lists, and national ID numbers from outside the US.
// Every value here is made up: seeds come from a seeded random generator with the BIP-39 checksum worked out
// below, and every ID number from its own country's public check-digit rule, so none belongs to anyone.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");
require("../extension/detector.js");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}
function expectOnly(text, id, match) {
  const found = detect(text);
  assert.deepEqual(Object.keys(found), [id], `"${text}" → ${JSON.stringify(found)}`);
  if (match !== undefined) assert.deepEqual(found[id], [match], `"${text}" → ${JSON.stringify(found)}`);
}
function expectNoKind(text, id) {
  const found = detect(text);
  assert.ok(!found[id], `"${text}" should not be ${id} → ${JSON.stringify(found)}`);
}

// mulberry32: the same numbers every run, so a failure can be replayed.
function makeRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const pad2 = (n) => String(n).padStart(2, "0");
const digits = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join("");

// ---------- Seed phrases ----------

const WORDS = fs
  .readFileSync(path.join(__dirname, "..", "extension", "patterns.js"), "utf8")
  .match(/const BIP39 = new Set\(\s*`([\s\S]*?)`/)[1]
  .trim()
  .split(/\s+/);
assert.equal(WORDS.length, 2048);

// A phrase with a real BIP-39 checksum: random entropy, then the first n/3 bits of its SHA-256.
function makeSeed(rand, n) {
  const entropy = Buffer.from(Array.from({ length: (n * 32) / 24 }, () => Math.floor(rand() * 256)));
  const hash = crypto.createHash("sha256").update(entropy).digest();
  const bits =
    [...entropy].map((b) => b.toString(2).padStart(8, "0")).join("") +
    hash[0]
      .toString(2)
      .padStart(8, "0")
      .slice(0, n / 3);
  return Array.from({ length: n }, (_, i) => WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
}
// A list of different list words, the way a shopping or vocabulary list would use them.
function randomWords(rand, n) {
  const chosen = new Set();
  while (chosen.size < n) chosen.add(pick(rand, WORDS));
  return [...chosen];
}
const SHAPES = {
  comma: (w) => w.join(", "),
  newline: (w) => w.join("\n"),
  bullet: (w) => w.map((x) => `- ${x}`).join("\n"),
  semicolon: (w) => w.join("; "),
};
const flagged = (text) => Boolean(detect(text).crypto_secret);
const coversSeed = (text, seed) => {
  const found = detect(text).crypto_secret || [];
  const joined = found.join(" ").toLowerCase();
  return found.length > 0 && seed.every((w) => joined.includes(w));
};

test("seed phrases: everyday word lists longer than a phrase aren't read as one", () => {
  const rand = makeRand(7);
  for (const [shape, join] of Object.entries(SHAPES)) {
    for (const n of [13, 16, 20, 22, 25, 30, 36, 40]) {
      let hits = 0;
      for (let trial = 0; trial < 40; trial++) if (flagged(join(randomWords(rand, n)))) hits++;
      assert.equal(hits, 0, `${shape} list of ${n} words flagged ${hits} of 40 times`);
    }
  }
  // The grocery list shape, with a short intro line.
  for (let trial = 0; trial < 40; trial++) {
    const text = `Shopping list for the weekend:\n${randomWords(rand, 22).join(", ")}`;
    assert.ok(!flagged(text), text);
  }
});

test("seed phrases: a long run of list words typed with spaces needs a seed word nearby", () => {
  const rand = makeRand(11);
  // Every 12- to 24-word window used to be checked, and most 24- and 30-word runs passed somewhere.
  for (const n of [20, 24, 30]) {
    let hits = 0;
    for (let trial = 0; trial < 200; trial++) if (flagged(randomWords(rand, n).join(" "))) hits++;
    assert.ok(hits <= 3, `${n} space-separated list words flagged ${hits} of 200 times`);
  }
  // A real phrase in the middle of a long run still counts when the message says what it is.
  const seed = makeSeed(rand, 12);
  const mid = [...randomWords(rand, 9), ...seed, ...randomWords(rand, 9)].join(" ");
  assert.ok(coversSeed(`my wallet recovery phrase: ${mid}`, seed));
});

test("seed phrases: real phrases in common paste shapes are still found", () => {
  const rand = makeRand(3);
  const shapes = {
    bareSpace: (s) => s.join(" "),
    labelled: (s) => `seed phrase: ${s.join(" ")}`,
    sentence: (s) => `here is my recovery phrase ${s.join(" ")} please keep it safe`,
    mnemonicEnv: (s) => `MNEMONIC="${s.join(" ")}"`,
    mnemonicJson: (s) => `{"mnemonic": "${s.join(" ")}"}`,
    numbered: (s) => s.map((w, i) => `${i + 1}. ${w}`).join(" "),
    numberedLines: (s) => s.map((w, i) => `${i + 1}. ${w}`).join("\n"),
    numberedParen: (s) => s.map((w, i) => `${i + 1}) ${w}`).join("\n"),
    numberedPlain: (s) => s.map((w, i) => `${i + 1} ${w}`).join(" "),
    newlineLabelled: (s) => `Wallet backup words\n${s.join("\n")}`,
    commaLabelled: (s) => `My MetaMask secret recovery phrase: ${s.join(", ")}`,
    bulletLabelled: (s) => `Ledger backup:\n${s.map((w) => `- ${w}`).join("\n")}`,
    spanish: (s) => `mi frase semilla es ${s.join(" ")}`,
    spanishWords: (s) => `estas son mis ${s.length} palabras de recuperación:\n${s.join("\n")}`,
    labelledFarAway: (s) =>
      `Writing down the seed phrase for the new wallet today.\n${"We went to the market and then walked home along the river. ".repeat(8)}\n${s.join(" ")}`,
    wrapped: (s) => `${s.slice(0, s.length / 2).join(" ")}\n${s.slice(s.length / 2).join(" ")}`,
    newlineExact: (s) => s.join("\n"),
    commaExact: (s) => s.join(", "),
    afterOtherListWords: (s) => `${randomWords(rand, 3).join(" ")} ${s.join(" ")}`,
    beforeOtherListWords: (s) => `${s.join(" ")} ${randomWords(rand, 3).join(" ")}`,
    // Two lines run together into one long run; each line is still read on its own.
    twoLines: (s) =>
      `${randomWords(rand, 2).join(" ")} ${s.join(" ")}\r\n${randomWords(rand, 2).join(" ")} ${s.join(" ")}`,
    labelledInsideList: (s) =>
      `keep this wallet seed safe: ${[...randomWords(rand, 5), ...s, ...randomWords(rand, 5)].join(", ")}`,
  };
  for (const n of [12, 24]) {
    for (const [name, make] of Object.entries(shapes)) {
      for (let trial = 0; trial < 5; trial++) {
        const seed = makeSeed(rand, n);
        const text = make(seed);
        assert.ok(coversSeed(text, seed), `${name} (${n} words) missed in "${text}": ${JSON.stringify(detect(text))}`);
      }
    }
  }
});

// The BIP-39 checksum of a 12- or 24-word list, worked out the same way as makeSeed.
function checksumOk(words) {
  const bits = words.map((w) => WORDS.indexOf(w).toString(2).padStart(11, "0")).join("");
  const n = words.length;
  const entropyBits = bits.slice(0, (n * 32) / 3);
  const entropy = Buffer.from(entropyBits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const hash = crypto.createHash("sha256").update(entropy).digest();
  return (
    hash[0]
      .toString(2)
      .padStart(8, "0")
      .slice(0, n / 3) === bits.slice((n * 32) / 3)
  );
}

test("seed phrases: a lucky window of the other list words doesn't hide the real phrase next to it", () => {
  const rand = makeRand(17);
  for (const n of [12, 24]) {
    for (const where of ["after", "before"]) {
      let tried = 0;
      for (let trial = 0; trial < 3; trial++) {
        // Keep drawing until the first (or last) n words, mostly the phrase plus the other words, pass the
        // checksum by chance too: 1 time in 16 for 12 words, 1 in 256 for 24.
        let seed, others, words;
        do {
          assert.ok(tried++ < 20000);
          seed = makeSeed(rand, n);
          others = randomWords(rand, 3);
          words = where === "after" ? [...others, ...seed] : [...seed, ...others];
        } while (!checksumOk(where === "after" ? words.slice(0, n) : words.slice(3)));
        const text = words.join(" ");
        assert.ok(coversSeed(text, seed), `${where} (${n} words) missed in "${text}": ${JSON.stringify(detect(text))}`);
      }
    }
  }
});

test("seed phrases: a numbered grid copied column by column is read in its numbered order", () => {
  const rand = makeRand(5);
  for (let trial = 0; trial < 10; trial++) {
    const seed = makeSeed(rand, 12);
    const rows = [0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => `${c * 4 + r + 1}. ${seed[c * 4 + r]}`).join("   "));
    const text = rows.join("\n");
    assert.ok(coversSeed(text, seed), `grid missed:\n${text}`);
  }
});

test("seed phrases: a numbered list of everyday words longer or shorter than a phrase stays quiet", () => {
  const rand = makeRand(13);
  for (const n of [10, 14, 20, 30]) {
    for (let trial = 0; trial < 40; trial++) {
      const text = randomWords(rand, n)
        .map((w, i) => `${i + 1}. ${w}`)
        .join("\n");
      assert.ok(!flagged(text), text);
    }
  }
});

test("seed phrases: a phrase inside a sentence of everyday words is found without a seed word", () => {
  // "can", "you", "check", "this", "please", "right", "still", "old", "one" are all BIP-39 words, so the sentence
  // and the phrase make one long run with more than a few other words on both sides.
  const rand = makeRand(19);
  const shapes = {
    checkThisPlease: (p) => `can you check this ${p} please`,
    checkThis: (p) => `can you check this ${p}`,
    pleaseHelp: (p) => `please help ${p} what is wrong`,
    whatAbout: (p) => `what about this one ${p} right`,
    isThisReal: (p) => `is this real ${p} please check`,
    stillWorks: (p) => `old one ${p} still works?`,
    testWith: (p) => `you can test with ${p} again`,
    rightAfter: (p) => `${p} right`,
  };
  for (const n of [12, 24]) {
    for (const [name, make] of Object.entries(shapes)) {
      for (let trial = 0; trial < 8; trial++) {
        const seed = makeSeed(rand, n);
        const text = make(seed.join(" "));
        assert.ok(coversSeed(text, seed), `${name} (${n} words) missed in "${text}": ${JSON.stringify(detect(text))}`);
      }
    }
  }
});

test("seed phrases: quoted, JSON-array, pipe and slash shapes", () => {
  const rand = makeRand(23);
  const shapes = {
    emailQuote: (s) => `> ${s.slice(0, s.length / 2).join(" ")}\n> ${s.slice(s.length / 2).join(" ")}\n>\n> thanks`,
    jsonArray: (s) => `["${s.join('","')}"]`,
    jsonArraySpaced: (s) => `[ "${s.join('", "')}" ]`,
    pipes: (s) => s.join(" | "),
    slashes: (s) => s.join(" / "),
    numberColon: (s) => s.map((w, i) => `${i + 1}:${w}`).join(" "),
    numberHash: (s) => s.map((w, i) => `#${i + 1} ${w}`).join("\n"),
  };
  for (const n of [12, 24]) {
    for (const [name, make] of Object.entries(shapes)) {
      for (let trial = 0; trial < 5; trial++) {
        const seed = makeSeed(rand, n);
        const text = make(seed);
        assert.ok(coversSeed(text, seed), `${name} (${n} words) missed in "${text}": ${JSON.stringify(detect(text))}`);
      }
    }
  }
  // Longer pipe or slash lists are list-shaped: a table row of everyday words stays quiet.
  for (let trial = 0; trial < 40; trial++) {
    assert.ok(!flagged(randomWords(rand, 20).join(" | ")));
    assert.ok(!flagged(randomWords(rand, 20).join(" / ")));
  }
});

// ---------- National ID numbers ----------

// Brazil CPF: 9 digits and two mod-11 check digits.
function cpfCheck(body) {
  const dv = (s) => {
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += Number(s[i]) * (s.length + 1 - i);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(body);
  return `${d1}${dv(body + d1)}`;
}
function makeCpf(rand) {
  const body = digits(rand, 9);
  return body + cpfCheck(body);
}
const cpfDotted = (c) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
// Brazil CNPJ: 12 digits and two mod-11 check digits with weights 2-9 from the right.
function cnpjDigit(s) {
  let sum = 0;
  for (let i = s.length - 1, w = 2; i >= 0; i--, w = w === 9 ? 2 : w + 1) sum += Number(s[i]) * w;
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}
function makeCnpj(rand) {
  const body = digits(rand, 8) + "0001";
  const d1 = cnpjDigit(body);
  return body + d1 + cnpjDigit(body + d1);
}
const cnpjDotted = (c) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
// France NIR: sex, year, month, department, town, order, then a key of 97 minus the number mod 97.
function makeNir(rand) {
  const sex = pick(rand, ["1", "2"]);
  const month = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
  const dept = pick(rand, ["75", "69", "13", "2A", "2B", "33"]);
  const body = `${sex}${digits(rand, 2)}${month}${dept}${digits(rand, 6)}`;
  const n = BigInt(body.replace("2A", "19").replace("2B", "18"));
  const key = String(97n - (n % 97n)).padStart(2, "0");
  return body + key;
}
const nirSpaced = (v) =>
  [v.slice(0, 1), v.slice(1, 3), v.slice(3, 5), v.slice(5, 7), v.slice(7, 10), v.slice(10, 13), v.slice(13)].join(" ");
// Netherlands BSN: the 11-test (9×d1 + 8×d2 + … + 2×d8 − d9 is a multiple of 11).
function makeBsn(rand) {
  for (;;) {
    const body = digits(rand, 8);
    if (body[0] === "0") continue;
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += Number(body[i]) * (9 - i);
    const check = sum % 11;
    if (check < 10) return body + check;
  }
}
// Poland PESEL: birth date (century in the month), serial, weighted check digit.
function makePesel(rand) {
  const year = 1950 + Math.floor(rand() * 70);
  const month = 1 + Math.floor(rand() * 12) + (year >= 2000 ? 20 : 0);
  const day = 1 + Math.floor(rand() * 28);
  const body = `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}${digits(rand, 4)}`;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = [...body].reduce((s, d, i) => s + Number(d) * w[i], 0);
  return body + ((10 - (sum % 10)) % 10);
}
// Italy codice fiscale: odd and even position values, sum mod 26 as the check letter.
const CF_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
function cfValue(ch, odd) {
  const i = /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
  return odd ? CF_ODD[i] : i;
}
function cfCheck(body) {
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += cfValue(body[i], i % 2 === 0);
  return String.fromCharCode(65 + (sum % 26));
}
function makeCf(rand) {
  const L = () => String.fromCharCode(65 + Math.floor(rand() * 26));
  const body =
    Array.from({ length: 6 }, L).join("") +
    digits(rand, 2) +
    pick(rand, [..."ABCDEHLMPRST"]) +
    String(1 + Math.floor(rand() * 28) + (rand() < 0.5 ? 40 : 0)).padStart(2, "0") +
    L() +
    digits(rand, 3);
  return body + cfCheck(body);
}
// Singapore NRIC/FIN: S/T (citizens) or F/G (foreigners), 7 digits, check letter from weights 2,7,6,5,4,3,2.
function nricCheck(prefix, d) {
  const w = [2, 7, 6, 5, 4, 3, 2];
  let sum = [...d].reduce((s, ch, i) => s + Number(ch) * w[i], 0);
  if (prefix === "T" || prefix === "G") sum += 4;
  return ("ST".includes(prefix) ? "JZIHGFEDCBA" : "XWUTRQPNMLK")[sum % 11];
}
function makeNric(rand) {
  const prefix = pick(rand, ["S", "T", "F", "G"]);
  // A T number starts with its holder's birth year, 2000 or later.
  const d = prefix === "T" ? pad2(Math.floor(rand() * 26)) + digits(rand, 5) : digits(rand, 7);
  return prefix + d + nricCheck(prefix, d);
}
// South Africa ID: YYMMDD, 4-digit serial, citizenship (0/1), 8, then a Luhn digit.
function luhnDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = Number(body[i]);
    if (dbl) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
function makeSaId(rand) {
  const yy = String(Math.floor(rand() * 100)).padStart(2, "0");
  const mm = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
  const dd = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
  const body = `${yy}${mm}${dd}${digits(rand, 4)}${pick(rand, ["0", "1"])}8`;
  return body + luhnDigit(body);
}
// Germany Steuer-ID: 11 digits, first not 0, one digit repeated in the first ten, ISO 7064 MOD 11,10 check.
function steuerCheck(d10) {
  let product = 10;
  for (const ch of d10) {
    let sum = (Number(ch) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = 11 - product;
  return check === 10 ? 0 : check;
}
function makeSteuerId(rand) {
  for (;;) {
    const pool = [..."0123456789"].sort(() => rand() - 0.5).slice(0, 9);
    const list = [...pool, pool[Math.floor(rand() * 9)]].sort(() => rand() - 0.5);
    if (list[0] === "0") continue;
    const d10 = list.join("");
    if (/(\d)\1\1/.test(d10)) continue;
    return d10 + steuerCheck(d10);
  }
}
// Korea RRN: YYMMDD-G + 5 digits + check, weights 2..9,2..5. G is 1 or 2 for people born in the 1900s (here
// 1930-1999), 3 or 4 for the 2000s (here 2000-2014).
function makeRrn(rand) {
  const g = pick(rand, ["1", "2", "3", "4"]);
  const yy = String(g < "3" ? 30 + Math.floor(rand() * 70) : Math.floor(rand() * 15)).padStart(2, "0");
  const mm = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
  const dd = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
  const body = `${yy}${mm}${dd}${g}${digits(rand, 5)}`;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = [...body].reduce((s, d, i) => s + Number(d) * w[i], 0);
  const v = body + ((11 - (sum % 11)) % 10);
  return `${v.slice(0, 6)}-${v.slice(6)}`;
}
// Japan My Number: 11 digits and a check digit, weights 2-7 then 2-6 counted from the right.
function makeMyNumber(rand) {
  const body = digits(rand, 11);
  let sum = 0;
  for (let n = 1; n <= 11; n++) sum += Number(body[11 - n]) * (n <= 6 ? n + 1 : n - 5);
  const r = sum % 11;
  return body + (r <= 1 ? 0 : 11 - r);
}
// China resident ID: 6-digit region, birth date, 3-digit serial, ISO 7064 MOD 11-2 check (X for 10).
function makeChinaId(rand) {
  const year = 1950 + Math.floor(rand() * 60);
  const mm = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
  const dd = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
  const body = `${pick(rand, ["110101", "310104", "440305", "510107"])}${year}${mm}${dd}${digits(rand, 3)}`;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...body].reduce((s, d, i) => s + Number(d) * w[i], 0);
  return body + "10X98765432"[sum % 11];
}
// India PAN: 3 letters, a holder-type letter, the surname's first letter, 4 digits, a letter.
function makePan(rand) {
  const L = () => String.fromCharCode(65 + Math.floor(rand() * 26));
  return `${L()}${L()}${L()}${pick(rand, [..."PCHFATBLJG"])}${L()}${digits(rand, 4)}${L()}`;
}
// Changes the last digit (or letter) so the check no longer holds.
function breakCheck(v, good) {
  for (const ch of "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ") {
    const bad = v.slice(0, -1) + ch;
    if (bad !== v && !good(bad) && /\d/.test(ch) === /\d/.test(v.slice(-1))) return bad;
  }
  throw new Error(`no broken form for ${v}`);
}

const ID_TRIALS = 25;

test("national IDs: Brazil CPF and CNPJ by their check digits", () => {
  const rand = makeRand(101);
  for (let i = 0; i < ID_TRIALS; i++) {
    const cpf = makeCpf(rand);
    expectOnly(`CPF: ${cpfDotted(cpf)}`, "national_id", cpfDotted(cpf));
    expectOnly(`meu CPF é ${cpf}`, "national_id", cpf);
    expectOnly(`Cliente ${cpfDotted(cpf)} cadastrado`, "national_id", cpfDotted(cpf));
    const badCpf = breakCheck(cpf, (v) => v === cpf);
    expectNoKind(`CPF: ${cpfDotted(badCpf)}`, "national_id");
    // 11 bare digits are too common (phones, order numbers) to count without the label.
    expectNoKind(`order ${cpf} shipped`, "national_id");
    const cnpj = makeCnpj(rand);
    expectOnly(`CNPJ ${cnpjDotted(cnpj)}`, "national_id", cnpjDotted(cnpj));
    expectOnly(`Empresa ${cnpjDotted(cnpj)} ativa`, "national_id", cnpjDotted(cnpj));
    expectOnly(`CNPJ: ${cnpj}`, "national_id", cnpj);
    const badCnpj = breakCheck(cnpj, (v) => v === cnpj);
    expectNoKind(`CNPJ ${cnpjDotted(badCnpj)}`, "national_id");
    expectNoKind(`ref ${cnpj}`, "national_id");
  }
  expectNoKind("CPF: 111.111.111-11", "national_id");
});

test("national IDs: India PAN after its label", () => {
  const rand = makeRand(102);
  for (let i = 0; i < ID_TRIALS; i++) {
    const pan = makePan(rand);
    expectOnly(`PAN: ${pan}`, "national_id", pan);
    expectOnly(`my PAN card number is ${pan}`, "national_id", pan);
    expectOnly(`Permanent Account Number ${pan}`, "national_id", pan);
    expectNoKind(`batch code ${pan} printed`, "national_id");
  }
  // The fourth letter says who holds it; X isn't a holder type.
  expectNoKind("PAN: ABCXE1234F", "national_id");
});

test("national IDs: France NIR by its key", () => {
  const rand = makeRand(103);
  for (let i = 0; i < ID_TRIALS; i++) {
    const nir = makeNir(rand);
    expectOnly(`numéro de sécurité sociale : ${nir}`, "national_id", nir);
    expectOnly(`NIR ${nirSpaced(nir)}`, "national_id", nirSpaced(nir));
    expectOnly(`carte vitale ${nirSpaced(nir)} à jour`, "national_id", nirSpaced(nir));
    expectOnly(`le numéro ${nirSpaced(nir)} est le sien`, "national_id", nirSpaced(nir));
    const bad = breakCheck(nir, (v) => v === nir);
    expectNoKind(`NIR ${nirSpaced(bad)}`, "national_id");
    expectNoKind(`id ${nir.replace(/[AB]/, "0")}`, "national_id");
  }
});

test("national IDs: Netherlands BSN (11-test) and Poland PESEL after their label", () => {
  const rand = makeRand(104);
  for (let i = 0; i < ID_TRIALS; i++) {
    const bsn = makeBsn(rand);
    expectOnly(`BSN: ${bsn}`, "national_id", bsn);
    expectOnly(`mijn burgerservicenummer is ${bsn}`, "national_id", bsn);
    expectNoKind(`BSN: ${breakCheck(bsn, (v) => v === bsn)}`, "national_id");
    expectNoKind(`invoice ${bsn}`, "national_id");
    const pesel = makePesel(rand);
    expectOnly(`PESEL: ${pesel}`, "national_id", pesel);
    expectOnly(`numer PESEL ${pesel}`, "national_id", pesel);
    expectNoKind(`PESEL: ${breakCheck(pesel, (v) => v === pesel)}`, "national_id");
    expectNoKind(`tracking ${pesel}`, "national_id");
  }
});

test("national IDs: Italy codice fiscale and Singapore NRIC by their check letter", () => {
  const rand = makeRand(105);
  for (let i = 0; i < ID_TRIALS; i++) {
    const cf = makeCf(rand);
    expectOnly(`codice fiscale: ${cf}`, "national_id", cf);
    expectOnly(`Il mio CF è ${cf}`, "national_id", cf);
    expectNoKind(`codice fiscale: ${breakCheck(cf, (v) => v === cf)}`, "national_id");
    const nric = makeNric(rand);
    expectOnly(`NRIC ${nric}`, "national_id", nric);
    expectOnly(`please update ${nric} on the form`, "national_id", nric);
    expectNoKind(`NRIC ${breakCheck(nric, (v) => v === nric)}`, "national_id");
  }
});

test("national IDs: South Africa, Germany, Korea, Japan and China", () => {
  const rand = makeRand(106);
  for (let i = 0; i < ID_TRIALS; i++) {
    const sa = makeSaId(rand);
    expectOnly(`SA ID number: ${sa}`, "national_id", sa);
    expectOnly(`identity number ${sa}`, "national_id", sa);
    expectNoKind(`SA ID number: ${breakCheck(sa, (v) => v === sa)}`, "national_id");
    expectNoKind(`created ${sa}`, "national_id");
    const st = makeSteuerId(rand);
    expectOnly(`Steuer-ID: ${st}`, "national_id", st);
    expectOnly(`meine Steueridentifikationsnummer ist ${st}`, "national_id", st);
    expectNoKind(`Steuer-ID: ${breakCheck(st, (v) => v === st)}`, "national_id");
    expectNoKind(`Kundennummer ${st}`, "national_id");
    const rrn = makeRrn(rand);
    expectOnly(`주민등록번호 ${rrn}`, "national_id", rrn);
    expectOnly(`RRN: ${rrn}`, "national_id", rrn);
    expectOnly(`her number ${rrn} is on file`, "national_id", rrn);
    expectNoKind(`ref ${breakCheck(rrn, (v) => v === rrn)} sent`, "national_id");
    const my = makeMyNumber(rand);
    expectOnly(`マイナンバー: ${my}`, "national_id", my);
    expectOnly(`My Number ${my}`, "national_id", my);
    expectNoKind(`マイナンバー: ${breakCheck(my, (v) => v === my)}`, "national_id");
    expectNoKind(`order ${my}`, "national_id");
    const cn = makeChinaId(rand);
    expectOnly(`身份证号码 ${cn}`, "national_id", cn);
    expectOnly(`resident ID ${cn}`, "national_id", cn);
    expectOnly(`${cn}`, "national_id", cn);
    expectNoKind(`${breakCheck(cn, (v) => v === cn)}`, "national_id");
  }
});

test("national IDs: order numbers, timestamps, phone numbers and long ids stay quiet", () => {
  const rand = makeRand(107);
  for (let i = 0; i < 300; i++) {
    const ms = String(1600000000000 + Math.floor(rand() * 200000000000));
    expectNoKind(`created_at: ${ms}`, "national_id");
    expectNoKind(`Order #${digits(rand, 11)} has shipped`, "national_id");
    expectNoKind(`ticket ${digits(rand, 9)} closed`, "national_id");
    expectNoKind(`call me on +55 11 9${digits(rand, 4)}-${digits(rand, 4)}`, "national_id");
    expectNoKind(`"id": "${digits(rand, 18)}"`, "national_id");
    // A Korean-shaped number needs a real date and a gender digit as well as its check digit.
    expectNoKind(`build 99${13 + Math.floor(rand() * 87)}01-${digits(rand, 7)}`, "national_id");
  }
});

// The ID numbers that only count after their label, each with a value, its label and a key or column name.
function labelOnlyIds(rand) {
  const pesel = makePesel(rand);
  return [
    ["CPF", makeCpf(rand), "cpf", "cpfNumber", "numero_cpf"],
    ["CNPJ", makeCnpj(rand), "cnpj", "cnpjEmpresa", "cnpj_cliente"],
    ["PAN", makePan(rand), "PAN", "panNumber", "pan_no"],
    ["NIR", makeNir(rand), "NIR", "numeroSecu", "nir_patient"],
    ["BSN", makeBsn(rand), "BSN", "bsnNummer", "klant_bsn"],
    ["PESEL", pesel, "PESEL", "peselNumber", "nr_pesel"],
    ["SA ID", makeSaId(rand), "ID number", "saIdNumber", "sa_id_number"],
    ["Steuer-ID", makeSteuerId(rand), "Steuer-ID", "steuerIdNr", "steuer_id"],
    ["RRN", makeRrn(rand), "RRN", "rrnNo", "resident_registration_number"],
    ["My Number", makeMyNumber(rand), "My Number", "myNumber", "my_number"],
  ];
}

test("national IDs: label-only numbers in a CSV column, a table or a camelCase or snake_case key", () => {
  const rand = makeRand(108);
  for (let trial = 0; trial < 10; trial++) {
    for (const [name, v, label, camel, snake] of labelOnlyIds(rand)) {
      const shapes = {
        csv: `nome,${label.toLowerCase()},email\nAna Silva,${v},ana@example.com`,
        csvSecondRow: `name;${label};city\nBruno Lima;000;Recife\nAna Silva;${v};Lisboa`,
        tsv: `name\t${label}\nAna\t${v}`,
        mdTable: `| Nome | ${label} |\n|---|---|\n| Ana | ${v} |`,
        camelJson: `{"${camel}":"${v}","nome":"Ana"}`,
        snakeJson: `{"${snake}": "${v}"}`,
        snakeYaml: `${snake}: ${v}`,
        query: `https://api.example.com/users?${camel}=${v}&page=2`,
        labelAbove: `${label}:\n${v}`,
      };
      for (const [shape, text] of Object.entries(shapes)) {
        const found = detect(text).national_id || [];
        assert.ok(
          found.includes(v),
          `${name} ${shape} missed in ${JSON.stringify(text)}: ${JSON.stringify(detect(text))}`,
        );
      }
      // A number that fails its check stays quiet in the same column. PAN has no check to fail, and a labelled
      // RRN needs only its date (newer ones have no check digit).
      if (name !== "PAN" && name !== "RRN") {
        const bad = breakCheck(v, (x) => x === v);
        expectNoKind(`nome,${label.toLowerCase()},email\nAna Silva,${bad},ana@example.com`, "national_id");
      }
    }
  }
  // A spaced CPF or PESEL after its label.
  for (let trial = 0; trial < 10; trial++) {
    const cpf = makeCpf(rand);
    const cpfSpaced = `${cpf.slice(0, 3)} ${cpf.slice(3, 6)} ${cpf.slice(6, 9)} ${cpf.slice(9)}`;
    expectOnly(`CPF: ${cpfSpaced}`, "national_id", cpfSpaced);
    const pesel = makePesel(rand);
    const peselSpaced = `${pesel.slice(0, 3)} ${pesel.slice(3, 6)} ${pesel.slice(6, 9)} ${pesel.slice(9)}`;
    expectOnly(`PESEL: ${peselSpaced}`, "national_id", peselSpaced);
  }
  // A column whose header isn't an ID label says nothing, and neither does a key that only contains the letters.
  const cpf = makeCpf(rand);
  expectNoKind(`order_id,total\n${cpf},49.90`, "national_id");
  expectNoKind(`{"companyNumber":"${cpf}"}`, "national_id");
  expectNoKind(`{"spanId":"${cpf}"}`, "national_id");
});

// A Korean RRN with a chosen birth date and sex/century digit, and a valid check digit.
function rrnWith(rand, yy, mm, dd, g) {
  const body = `${yy}${mm}${dd}${g}${digits(rand, 5)}`;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = [...body].reduce((s, d, i) => s + Number(d) * w[i], 0);
  const v = body + ((11 - (sum % 11)) % 10);
  return `${v.slice(0, 6)}-${v.slice(6)}`;
}
// A China-ID-shaped number with a chosen start and date, and a valid check character.
function cnWith(rand, start, ymd) {
  const body = `${start}${ymd}${digits(rand, 3)}`;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...body].reduce((s, d, i) => s + Number(d) * w[i], 0);
  return body + "10X98765432"[sum % 11];
}
const recentDate = (rand) => [2017 + Math.floor(rand() * 10), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)];

test("national IDs: order and reference numbers shaped like bare IDs stay quiet", () => {
  const rand = makeRand(109);
  for (let i = 0; i < 100; i++) {
    // A dashed reference dated in the last ten years, checksum and all: a child born then, or someone over 100.
    const [y, m, d] = recentDate(rand);
    const ref = rrnWith(rand, pad2(y % 100), pad2(m), pad2(d), pick(rand, ["1", "2", "3", "4"]));
    expectNoKind(`Commande: ${ref}`, "national_id");
    expectNoKind(`your reference ${ref} is confirmed`, "national_id");
    // A store number, a recent order date and a sequence number: an order number, not a resident ID.
    const order = cnWith(rand, digits(rand, 6).replace(/^0/, "1"), `${y}${pad2(m)}${pad2(d)}`);
    expectNoKind(`Order ${order} shipped`, "national_id");
    // Born in 2091.
    expectNoKind(`user ${cnWith(rand, "110101", `2091${pad2(m)}${pad2(d)}`)} joined`, "national_id");
    // A region code no province has.
    expectNoKind(`id ${cnWith(rand, "291234", `1985${pad2(m)}${pad2(d)}`)}`, "national_id");
    // A SKU or reference after its own label.
    const nric = makeNric(rand);
    expectNoKind(`Bestellung: ${nric}`, "national_id");
    expectNoKind(`SKU ${nric} back in stock`, "national_id");
    expectNoKind(`ref ${cpfDotted(makeCpf(rand))}`, "national_id");
    expectNoKind(`Pedido nº ${cpfDotted(makeCpf(rand))}`, "national_id");
  }
  // A column of references where most fail the check: the few that pass are chance, not IDs.
  for (let trial = 0; trial < 10; trial++) {
    const rows = [];
    for (let r = 0; r < 30; r++) {
      const yy = pad2(60 + Math.floor(rand() * 40));
      rows.push(
        `${r + 1},${yy}${pad2(1 + Math.floor(rand() * 12))}${pad2(1 + Math.floor(rand() * 28))}-1${digits(rand, 6)},ok`,
      );
      rows.push(`${r + 1},110101${1960 + Math.floor(rand() * 40)}0${1 + Math.floor(rand() * 9)}1${digits(rand, 5)},ok`);
      rows.push(`${r + 1},${digits(rand, 3)}.${digits(rand, 3)}.${digits(rand, 3)}-${digits(rand, 2)},ok`);
    }
    expectNoKind(`n,ref,status\n${rows.join("\n")}`, "national_id");
  }
});

test("national IDs: bare IDs still count in a list of real ones and in ordinary sentences", () => {
  const rand = makeRand(110);
  for (let trial = 0; trial < 10; trial++) {
    const cpfs = Array.from({ length: 6 }, () => cpfDotted(makeCpf(rand)));
    assert.deepEqual(detect(cpfs.join("\n")).national_id, cpfs);
    const cns = Array.from({ length: 6 }, () => makeChinaId(rand));
    assert.deepEqual(detect(cns.map((c) => `Ana,${c},ok`).join("\n")).national_id, cns);
    // Adults: born 1930-2010.
    const yy = 30 + Math.floor(rand() * 70);
    const rrn = rrnWith(
      rand,
      pad2(yy),
      pad2(1 + Math.floor(rand() * 12)),
      pad2(1 + Math.floor(rand() * 28)),
      pick(rand, ["1", "2"]),
    );
    expectOnly(`her number ${rrn} is on file`, "national_id", rrn);
    const t = rrnWith(rand, pad2(Math.floor(rand() * 10)), "05", "17", pick(rand, ["3", "4"]));
    expectOnly(`his number is ${t}`, "national_id", t);
  }
});

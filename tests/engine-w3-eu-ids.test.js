"use strict";

// National ID and tax numbers from EU and EEA countries. Every value here is built from made-up digits, with its
// check digit computed below, so none belongs to anyone.

const test = require("node:test");
const assert = require("node:assert/strict");
const { COUNTED, meter, assertCounted } = require("./work-child.js");
const work = meter(); // before the engine, so the meter counts its steps
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

require("../extension/patterns.js");
require("../extension/detector.js");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

function expectOnly(text, id, match) {
  const found = detect(text);
  assert.deepEqual(Object.keys(found), [id], `${JSON.stringify(text)} → ${JSON.stringify(found)}`);
  if (match !== undefined) assert.deepEqual(found[id], [match], JSON.stringify(text));
}

function expectNoKind(text, id) {
  assert.equal(detect(text)[id], undefined, `${JSON.stringify(text)} should not be ${id}`);
}

const sumOf = (digits, weights) => weights.reduce((s, w, i) => s + w * Number(digits[i]), 0);
const luhnCheck = (body) => {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
};
// The last digit changed to another, so the check no longer holds (the other ID rules must not read it either).
const broken = (value) => value.slice(0, -1) + ((Number(value.slice(-1)) + 1) % 10);

// Each maker returns the value with its check digit, or fails when the made-up body can't take one.
const make = {
  belgium(body) {
    const check = 97 - (Number(body) % 97);
    return body + String(check).padStart(2, "0");
  },
  sweden: (body) => body + luhnCheck(body.slice(-9)),
  norway(body) {
    const k = (digits, weights) => {
      const r = 11 - (sumOf(digits, weights) % 11);
      return r === 11 ? 0 : r;
    };
    const k1 = k(body, [3, 7, 6, 1, 8, 9, 4, 5, 2]);
    assert.ok(k1 < 10, "first Norwegian check must be a digit");
    const k2 = k(body + k1, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
    assert.ok(k2 < 10, "second Norwegian check must be a digit");
    return body + k1 + k2;
  },
  finland: (date, sign, serial) => date + sign + serial + "0123456789ABCDEFHJKLMNPRSTUVWXY"[Number(date + serial) % 31],
  iceland(body, century) {
    const r = sumOf(body, [3, 2, 7, 6, 5, 4, 3, 2]) % 11;
    const check = r === 0 ? 0 : 11 - r;
    assert.ok(check < 10, "kennitala check must be a digit");
    return body + check + century;
  },
  portugal(body) {
    const r = sumOf(body, [9, 8, 7, 6, 5, 4, 3, 2]) % 11;
    return body + (r < 2 ? 0 : 11 - r);
  },
  romania(body) {
    const r = sumOf(body, [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9]) % 11;
    return body + (r === 10 ? 1 : r);
  },
  bulgaria(body) {
    const r = sumOf(body, [2, 4, 8, 5, 10, 9, 7, 3, 6]) % 11;
    return body + (r === 10 ? 0 : r);
  },
  czech(body) {
    const check = Number(body) % 11;
    assert.ok(check < 10, "rodné číslo check must be a digit");
    return body + check;
  },
  croatia(body) {
    let product = 10;
    for (const ch of body) {
      const s = (Number(ch) + product) % 10 || 10;
      product = (s * 2) % 11;
    }
    return body + ((11 - product) % 10);
  },
  amka: (body) => body + luhnCheck(body),
  afm: (body) => body + (([...body].reduce((s, ch, i) => s + Number(ch) * 2 ** (8 - i), 0) % 11) % 10),
  austria(serial, date) {
    const digits = serial + "0" + date;
    const check = sumOf(digits, [3, 7, 9, 0, 5, 8, 4, 2, 1, 6]) % 11;
    assert.ok(check < 10, "SV-Nummer check must be a digit");
    return serial + check + date;
  },
  germanPension(area, date, letter, serial) {
    const digits = area + date + String(letter.charCodeAt(0) - 64).padStart(2, "0") + serial;
    const weights = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];
    const sum = weights.reduce((s, w, i) => {
      const p = w * Number(digits[i]);
      return s + Math.floor(p / 10) + (p % 10);
    }, 0);
    return { area, date, letter, serial, check: String(sum % 10) };
  },
  estonia(body) {
    let r = sumOf(body, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1]) % 11;
    if (r === 10) r = (sumOf(body, [3, 4, 5, 6, 7, 8, 9, 1, 2, 3]) % 11) % 10;
    return body + r;
  },
  latvia(body) {
    const check = (1101 - sumOf(body, [1, 6, 3, 7, 9, 10, 5, 8, 4, 2])) % 11;
    assert.ok(check < 10, "personas kods check must be a digit");
    return body + check;
  },
  slovenia(body) {
    const r = sumOf(body, [7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) % 11;
    const check = r === 0 ? 0 : 11 - r;
    assert.ok(check < 10, "EMŠO check must be a digit");
    return body + check;
  },
  taj: (body) => body + (sumOf(body, [3, 7, 3, 7, 3, 7, 3, 7]) % 10),
  hungaryTax(body) {
    const check = sumOf(body, [1, 2, 3, 4, 5, 6, 7, 8, 9]) % 11;
    assert.ok(check < 10, "adóazonosító jel check must be a digit");
    return body + check;
  },
  nip(body) {
    const check = sumOf(body, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
    assert.ok(check < 10, "NIP check must be a digit");
    return body + check;
  },
};

test("Belgium's national register number: labelled in each language, dotted or not", () => {
  const id = make.belgium("850101" + "123");
  const dotted = `${id.slice(0, 2)}.${id.slice(2, 4)}.${id.slice(4, 6)}-${id.slice(6, 9)}.${id.slice(9)}`;
  expectOnly(`Rijksregisternummer: ${id}`, "national_id", id);
  expectOnly(`numéro de registre national ${id}`, "national_id", id);
  expectOnly(`my NISS is ${id}`, "national_id", id);
  expectOnly(`INSZ ${dotted}`, "national_id", dotted);
  expectNoKind(`see you, it's ${dotted} on the card`, "national_id");
  // Born in 2000 or later: the check is taken with a 2 in front.
  const young = (() => {
    const body = "050101" + "123";
    return body + String(97 - (Number("2" + body) % 97)).padStart(2, "0");
  })();
  expectOnly(`rijksregisternummer ${young}`, "national_id", young);
  expectNoKind(`Rijksregisternummer: ${id.slice(0, 9)}${id.slice(9) === "01" ? "02" : "01"}`, "national_id");
  expectNoKind(id, "national_id");
  expectNoKind(`Order ${dotted}`, "national_id");
});

test("Nordic personal numbers: Sweden, Denmark, Norway, Finland and Iceland after their labels", () => {
  const se = make.sweden("850101" + "123");
  const seDashed = `${se.slice(0, 6)}-${se.slice(6)}`;
  expectOnly(`personnummer: ${seDashed}`, "national_id", seDashed);
  expectOnly(`Mitt personnummer är 19${seDashed}`, "national_id", `19${seDashed}`);
  expectOnly(`samordningsnummer ${make.sweden("850161" + "123")}`, "national_id", make.sweden("850161" + "123"));
  expectNoKind(`personnummer: ${broken(seDashed)}`, "national_id");

  // Denmark has no check digit on newer numbers, so the birth date and its century digit are what's checked.
  expectOnly("CPR-nr.: 010185-1234", "national_id", "010185-1234");
  expectOnly("mit CPR nummer er 0101851234", "national_id", "0101851234");
  expectNoKind("CPR-nr.: 320185-1234", "national_id");

  const no = make.norway("010185" + "123");
  expectOnly(`fødselsnummer ${no}`, "national_id", no);
  expectOnly(`Fodselsnummer: ${no.slice(0, 6)} ${no.slice(6)}`, "national_id", `${no.slice(0, 6)} ${no.slice(6)}`);
  expectNoKind(`fødselsnummer ${broken(no)}`, "national_id");

  const fi = make.finland("010185", "-", "123");
  expectOnly(`henkilötunnus ${fi}`, "national_id", fi);
  expectOnly(`HETU: ${fi}`, "national_id", fi);
  const fiNew = make.finland("010105", "A", "123");
  expectOnly(`personbeteckning ${fiNew}`, "national_id", fiNew);
  // A letter check is read after the label, and even with a letter in it a HETU needs its label.
  const fiLetter = ["124", "125", "126", "127", "128", "129", "130"]
    .map((s) => make.finland("010185", "-", s))
    .find((v) => /[A-Z]$/.test(v));
  expectOnly(`henkilötunnus ${fiLetter}`, "national_id", fiLetter);
  expectNoKind(`it's ${fiLetter}`, "national_id");
  expectNoKind(`hers is ${make.finland("010110", "A", "123")}`, "national_id");
  const wrongFi = fiLetter.slice(0, -1) + (fiLetter.endsWith("Y") ? "X" : "Y");
  expectNoKind(`henkilötunnus ${wrongFi}`, "national_id");
  expectNoKind(wrongFi, "national_id");

  const kt = make.iceland("010185" + "23", "9");
  expectOnly(`kennitala ${kt.slice(0, 6)}-${kt.slice(6)}`, "national_id", `${kt.slice(0, 6)}-${kt.slice(6)}`);
  expectNoKind(`kennitala ${kt.slice(0, 8)}${(Number(kt[8]) + 1) % 10}${kt[9]}`, "national_id");

  // Bare digits of these shapes are dates and times in file names and logs.
  for (const text of [`backup-19${seDashed}.tar`, `log ${seDashed}`, `build ${no}`, `${kt}`, "0101851234"]) {
    expectNoKind(text, "national_id");
  }
});

test("Southern and western EU tax and personal numbers: Portugal, Greece", () => {
  const nif = make.portugal("12345678");
  expectOnly(`NIF: ${nif}`, "national_id", nif);
  expectOnly(
    `número de contribuinte ${nif.slice(0, 3)} ${nif.slice(3, 6)} ${nif.slice(6)}`,
    "national_id",
    `${nif.slice(0, 3)} ${nif.slice(3, 6)} ${nif.slice(6)}`,
  );
  expectNoKind(`NIF: ${broken(nif)}`, "national_id");

  const amka = make.amka("010185" + "1234");
  expectOnly(`ΑΜΚΑ: ${amka}`, "national_id", amka);
  expectOnly(`my AMKA is ${amka}`, "national_id", amka);
  expectNoKind(`AMKA ${broken(amka)}`, "national_id");
  const afm = make.afm("12345678");
  expectOnly(`ΑΦΜ ${afm}`, "national_id", afm);
  expectOnly(`AFM: ${afm}`, "national_id", afm);
  expectNoKind(`AFM: ${broken(afm)}`, "national_id");
  for (const text of [nif, amka, afm, `Order ${nif}`]) expectNoKind(text, "national_id");
});

test("Central and eastern EU personal numbers: Romania, Bulgaria, Czechia and Slovakia, Croatia, Slovenia", () => {
  const cnp = make.romania("1850101" + "40" + "123");
  expectOnly(`CNP: ${cnp}`, "national_id", cnp);
  expectOnly(`codul numeric personal ${cnp}`, "national_id", cnp);
  expectNoKind(`CNP: ${broken(cnp)}`, "national_id");
  expectNoKind(`CNP: ${make.romania("1851301" + "40" + "123")}`, "national_id");

  const egn = make.bulgaria("850101" + "123");
  expectOnly(`ЕГН ${egn}`, "national_id", egn);
  expectOnly(`EGN: ${egn}`, "national_id", egn);
  const egn2000 = make.bulgaria("054101" + "123");
  expectOnly(`ЕГН: ${egn2000}`, "national_id", egn2000);
  expectNoKind(`EGN: ${broken(egn)}`, "national_id");

  const rc = make.czech("855101" + "123");
  const rcSlash = `${rc.slice(0, 6)}/${rc.slice(6)}`;
  expectOnly(`rodné číslo: ${rcSlash}`, "national_id", rcSlash);
  expectOnly(`rodne cislo ${rc}`, "national_id", rc);
  // An account and its bank code are written with the same slash, so the slash alone isn't enough.
  expectNoKind(`moje je ${rcSlash}`, "national_id");
  expectNoKind(`/archive/${rcSlash}/index`, "national_id");
  expectNoKind(`rodné číslo ${rc.slice(0, 6)}/${broken(rc).slice(6)}`, "national_id");
  expectNoKind(`${rc.slice(0, 6)}/${broken(rc).slice(6)}`, "national_id");

  const oib = make.croatia("1234567890");
  expectOnly(`OIB: ${oib}`, "national_id", oib);
  expectNoKind(`OIB: ${broken(oib)}`, "national_id");

  const emso = make.slovenia("0101985" + "50" + "123");
  expectOnly(`EMŠO ${emso}`, "national_id", emso);
  expectOnly(`emso: ${emso}`, "national_id", emso);
  expectNoKind(`EMŠO ${broken(emso)}`, "national_id");
  for (const text of [cnp, egn, oib, emso, rc]) expectNoKind(text, "national_id");
});

test("Austria's and Germany's social insurance numbers", () => {
  const svnr = make.austria("123", "010185");
  expectOnly(`SVNR: ${svnr}`, "national_id", svnr);
  expectOnly(
    `Sozialversicherungsnummer ${svnr.slice(0, 4)} ${svnr.slice(4)}`,
    "national_id",
    `${svnr.slice(0, 4)} ${svnr.slice(4)}`,
  );
  expectNoKind(`SVNR: ${svnr.slice(0, 3)}${(Number(svnr[3]) + 1) % 10}${svnr.slice(4)}`, "national_id");
  expectNoKind(svnr, "national_id");

  const rv = make.germanPension("12", "010185", "M", "12");
  const compact = rv.area + rv.date + rv.letter + rv.serial + rv.check;
  const spaced = `${rv.area} ${rv.date} ${rv.letter} ${rv.serial}${rv.check}`;
  expectOnly(`Rentenversicherungsnummer: ${compact}`, "national_id", compact);
  expectOnly(`meine Sozialversicherungsnummer ist ${spaced}`, "national_id", spaced);
  // Part codes put a letter between digits and a date too, so without its label it stays quiet.
  expectNoKind(`die Nummer ${spaced}`, "national_id");
  const wrong = compact.slice(0, -1) + ((Number(rv.check) + 1) % 10);
  expectNoKind(`Versicherungsnummer ${wrong}`, "national_id");
  expectNoKind(wrong, "national_id");
});

test("Baltic and Hungarian and Polish numbers", () => {
  const ee = make.estonia("3850101" + "123");
  expectOnly(`isikukood ${ee}`, "national_id", ee);
  expectOnly(`asmens kodas: ${ee}`, "national_id", ee);
  expectNoKind(`isikukood ${broken(ee)}`, "national_id");

  const lv = make.latvia("010185" + "1" + "234");
  const lvDashed = `${lv.slice(0, 6)}-${lv.slice(6)}`;
  expectOnly(`personas kods ${lvDashed}`, "national_id", lvDashed);
  expectNoKind(`personas kods ${broken(lvDashed)}`, "national_id");

  const taj = make.taj("12345678");
  expectOnly(
    `TAJ szám: ${taj.slice(0, 3)} ${taj.slice(3, 6)} ${taj.slice(6)}`,
    "national_id",
    `${taj.slice(0, 3)} ${taj.slice(3, 6)} ${taj.slice(6)}`,
  );
  expectNoKind(`TAJ szám: ${broken(taj)}`, "national_id");
  const ado = make.hungaryTax("8" + "4321" + "0123");
  expectOnly(`adóazonosító jel: ${ado}`, "national_id", ado);
  expectNoKind(`adóazonosító jel: ${broken(ado)}`, "national_id");

  const nip = make.nip("123456780");
  const nipDashed = `${nip.slice(0, 3)}-${nip.slice(3, 6)}-${nip.slice(6, 8)}-${nip.slice(8)}`;
  expectOnly(`NIP: ${nipDashed}`, "national_id", nipDashed);
  expectOnly(`NIP ${nip}`, "national_id", nip);
  expectNoKind(`NIP: ${broken(nip)}`, "national_id");
  for (const text of [ee, lvDashed, taj, ado, nip]) expectNoKind(text, "national_id");
});

test("the new IDs are read as JSON keys and table columns named for them", () => {
  const cnp = make.romania("2850101" + "40" + "123");
  const egn = make.bulgaria("850101" + "124");
  const oib = make.croatia("1234567891");
  expectOnly(`{"cnp": "${cnp}"}`, "national_id", cnp);
  expectOnly(`egn=${egn}`, "national_id", egn);
  expectOnly(`name,oib\nAna,${oib}`, "national_id", oib);
  expectOnly(`name;Personnummer\nEva;${make.sweden("850101" + "123")}`, "national_id", make.sweden("850101" + "123"));
});

test("the new labels stay quiet on everyday words and wrong numbers", () => {
  for (const text of [
    "I took a CPR class on 12 March, room 214.",
    "Visited the Taj Mahal in 2019, ticket 1234567890.",
    "Mon NIP de carte est 1234.",
    "The AFM scan took 120 minutes at 512 x 512.",
    "Please send the kennitala and the IBAN by Friday.",
    "Our personal code review is on 2026-11-02.",
  ]) {
    expectNoKind(text, "national_id");
  }
});

// About n characters of the unit repeated.
const repeated = (unit, n) => unit.repeat(Math.ceil(n / unit.length));

// 4 times the input may take at most 10 times as long. Run with CLOTR_WORK=1 (assertCounted), it may make at most
// WORK_GROWTH times the work instead. The ID labels are read by regexes whose spaces can backtrack inside one run,
// which only the clock sees, and a pass or a loop too many hides under the clock's limit, which the count sees.
function assertLinear(fn, makeInput, units, n) {
  if (work) {
    work.assertWorkLinear(fn, makeInput, units, n, undefined, [__filename]);
    return;
  }
  for (const unit of units) {
    const small = makeInput(unit, n);
    const big = makeInput(unit, n * 4);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => fn(small),
          () => fn(big),
          4,
          3,
        ),
      (s, b) => grewMoreThan(s, b, 10),
    );
    assert.ok(!slow, `${JSON.stringify(unit)}: time grew too much for 4× the input`);
  }
}

test("the new ID readers stay linear on long hostile text", () => {
  const find = globalThis.Clotr.PATTERNS.find((p) => p.id === "national_id").find;
  const units = [
    "CNP ",
    "personnummer ",
    "rodné číslo ",
    "85.01.01-",
    "850101/",
    "12 010185 M ",
    "010185A",
    "1",
    "1 ",
    "1-",
    "NIP 123-",
    "CPR-nr. ",
    "cpr is ",
    "TAJ ",
    "AFM: ",
  ];
  assertLinear(find, repeated, units, 75000);
});

test("a data cell that is an ID's name doesn't take over the table's columns", () => {
  // Fake BSNs, each passing the 11-check.
  const bsns = ["123456782", "234567892", "345678916", "456789121"];
  const found = (text) => (detect(text).national_id || []).slice().sort();
  const all = bsns.slice().sort();
  assert.deepEqual(found(`name,bsn\nAnna,${bsns[0]}\nTaj,${bsns[1]}\nPiet,${bsns[2]}\nMila,${bsns[3]}`), all);
  assert.deepEqual(
    found(`naam,bsn,certificaat\nJan,${bsns[0]},BHV\nEva,${bsns[1]},CPR\nKees,${bsns[2]},EHBO\nLot,${bsns[3]},none`),
    all,
  );
  for (const word of ["CPR", "Taj", "Nip", "NIF", "AFM", "OIB", "CNP", "NISS", "personnummer", "Versicherungsnummer"]) {
    assert.deepEqual(
      found(`name,bsn\nAnna,${bsns[0]}\n${word},${bsns[1]}\nPiet,${bsns[2]}\nMila,${bsns[3]}`),
      all,
      `a row named ${word}`,
    );
  }
  // A row with no digits in it that only names a kind ("CPR" in a certificates column, with no BSN given) adds
  // that column but keeps the ones above it.
  assert.deepEqual(
    found(`naam,bsn,certificaat\nJan,${bsns[0]},BHV\nEva,onbekend,CPR\nKees,${bsns[2]},EHBO\nLot,${bsns[3]},none`),
    [bsns[0], bsns[2], bsns[3]].sort(),
  );
  // A header with a digit in it still reads as the header at the top of the table.
  assert.deepEqual(found(`naam,bsn,adres 2\nJan,${bsns[0]},Straat 1\nEva,${bsns[1]},Laan 3`), bsns.slice(0, 2).sort());
  // A new table after a blank line has its own columns.
  assert.deepEqual(found(`naam,bsn\nJan,${bsns[0]}\n\nbsn,naam\n${bsns[1]},Eva`), bsns.slice(0, 2).sort());
});

test("CPR as the English first-aid word doesn't turn the phone number after it into a Danish ID", () => {
  for (const text of [
    "Babysitter, CPR certified, call 3105551234",
    "Need CPR? call 2105550199",
    "Completed CPR training 1203851234",
    "CPR and first aid certified, text 3105551234",
  ]) {
    expectNoKind(text, "national_id");
  }
  assert.deepEqual(detect("Babysitter, CPR certified, call 3105551234").phone_number, ["3105551234"]);
  // US phones from area codes that read as a day of the month: none becomes a Danish ID after the word.
  for (let area = 201; area <= 319; area += 3) {
    for (const rest of ["5551234", "5550199", "4441010", "7778888"]) {
      expectNoKind(`Babysitter, CPR certified, call ${area}${rest}`, "national_id");
    }
  }
  // Right after the label, the Danish number still counts, in each way it's written.
  expectOnly("CPR: 0101901234", "national_id", "0101901234");
  expectOnly("CPR-nr. 0101901234", "national_id", "0101901234");
  expectOnly("cpr-nummer: 010190-1234", "national_id", "010190-1234");
  expectOnly("my CPR number is 0101901234", "national_id", "0101901234");
  expectOnly("mit cpr er 010190-1234", "national_id", "010190-1234");
  expectOnly("cpr 0101901234", "national_id", "0101901234");
  expectOnly("CPR\n0101901234", "national_id", "0101901234");
});

test("TAJ and AFM count in capitals, not as a first name or a lab's microscope", () => {
  for (const text of ["Taj: 512 345 673", "Call Taj at 512 345 673", "AFM sample 202403153 imaged", "taj 512345673"]) {
    expectNoKind(text, "national_id");
  }
  assert.deepEqual(detect("Call Taj at 512 345 673").phone_number, ["512 345 673"]);
  const taj = make.taj("51234567");
  expectOnly(`TAJ: ${taj.slice(0, 3)} ${taj.slice(3, 6)} ${taj.slice(6)}`, "national_id");
  expectOnly(`TAJ ${taj}`, "national_id", taj);
  expectOnly(`taj szám ${taj}`, "national_id", taj);
  expectOnly(`TAJ-szám: ${taj}`, "national_id", taj);
  const afm = make.afm("20240315");
  expectOnly(`AFM: ${afm}`, "national_id", afm);
  expectOnly(`ΑΦΜ μου ${afm}`, "national_id", afm);
  expectOnly(`{"afm": "${afm}"}`, "national_id", afm);
  expectOnly(`{"taj": "${taj}"}`, "national_id", taj);
});

test("a header with a digit in it starts new columns under a line that already named one", () => {
  const bsns = ["123456782", "234567892"];
  const found = (text) => (detect(text).national_id || []).slice().sort();
  // A comma line in prose right above the table, then the table's own header with "Adres 1" in it.
  assert.deepEqual(found(`Stuur naam, BSN\nNaam,Adres 1,BSN\nJan,Straat 1,${bsns[0]}\nEva,Laan 2,${bsns[1]}`), bsns);
  // Two tables back to back, the second with "tel 2" in its header.
  assert.deepEqual(found(`naam,bsn\nJan,${bsns[0]}\nnaam,tel 2,bsn\nEva,0612345678,${bsns[1]}`), bsns);
  assert.deepEqual(found(`naam,bsn\nJan,${bsns[0]}\nQ1 2024,naam,bsn\nx,Eva,${bsns[1]}`), bsns);
  // A data row whose ID cell names another kind keeps the column's first kind too.
  assert.deepEqual(found(`naam,bsn\nJan,${bsns[0]}\nAnna,NIF\nEva,${bsns[1]}`), bsns);
});

test("CPR, AFM and TAJ count with the words people write between the label and the number", () => {
  for (const text of [
    "Cpr.nr. 010190-1234",
    "cpr.nr. 0101901234",
    "CPR no. 010190-1234",
    "CPR No: 010190-1234",
    "Patientens CPR-nummeret er 010190-1234",
  ]) {
    assert.deepEqual(detect(text).national_id, [text.match(/\d[\d-]+$/)[0]], text);
  }
  const afm = make.afm("12345678");
  for (const text of [`AFM number: ${afm}`, `Greek AFM no. ${afm}`, `AFM (tax id): ${afm}`]) {
    expectOnly(text, "national_id", afm);
  }
  const taj = make.taj("12345678");
  const tajSpaced = `${taj.slice(0, 3)} ${taj.slice(3, 6)} ${taj.slice(6)}`;
  for (const text of [`TAJ no. ${tajSpaced}`, `TAJ számát: ${tajSpaced}`, `taj számom ${tajSpaced}`]) {
    expectOnly(text, "national_id", tajSpaced);
  }
  // The words alone don't make a label: a lab's AFM, a sentence after CPR, "for Taj" in Hungarian.
  for (const text of [
    `AFM sample no ${afm}`,
    "CPR. No pets. Call 3105551234",
    "CPR no pets, call 3105551234",
    `Taj számára ${tajSpaced}`,
    `Taj no. ${tajSpaced}`,
  ]) {
    expectNoKind(text, "national_id");
  }
});

test("a US phone after CPR set off by punctuation stays a phone number", () => {
  for (let area = 201; area <= 319; area++) {
    for (const rest of ["5551234", "2345678", "9871234"]) {
      const phone = `${area}${rest}`;
      for (const text of [
        `Babysitter (CPR) ${phone}`,
        `Lifeguard, first aid, CPR, ${phone}`,
        `Nanny - CPR - ${phone}`,
        ` cpr: ${phone}`,
        `Cpr ${phone}`,
      ]) {
        const found = detect(text);
        assert.equal(found.national_id, undefined, `${JSON.stringify(text)} → ${JSON.stringify(found)}`);
        assert.deepEqual(found.phone_number, [phone], `${JSON.stringify(text)} is still flagged`);
      }
    }
  }
  // A Danish number that can't be a US phone (or is written with its dash) still counts after the same words.
  for (const text of [
    "Babysitter (CPR) 0101901234",
    "CPR, 0101901234",
    "Nanny - CPR - 2505901234".replace("2505901234", "250590-1234"),
    "CPR (010190-1234)",
    "cpr: 0101901234",
    "cpr 1503801234",
  ]) {
    assert.deepEqual(detect(text).national_id, [text.match(/\d[\d-]+/)[0]], text);
  }
  // Written as a form's field in capitals, the label is the Danish one whatever the digits.
  expectOnly("CPR: 2505901234", "national_id", "2505901234");
});

test("table columns stay linear when one wide header is followed by many short rows", () => {
  const find = globalThis.Clotr.PATTERNS.find((p) => p.id === "national_id").find;
  const table = (_unit, size) => "bsn,".repeat(size / 8) + "\n" + "a,1\n".repeat(size / 8);
  assertLinear(find, table, ["one wide header"], 75000);
  const units = ["Cpr.nr. ", "CPR no. ", "cpr-nummeret er ", "AFM (tax id) ", "AFM no. ", "TAJ számát ", "CPR, "];
  assertLinear(find, repeated, units, 75000);
});

test("the ID readers' growth tests also pass on a count of work", { skip: COUNTED }, () => {
  assertCounted(__filename, [
    "the new ID readers stay linear on long hostile text",
    "table columns stay linear when one wide header is followed by many short rows",
  ]);
});

// Made-up values for the table checks below, each passing its own check: TAJ, AFM and NIP numbers, Danish CPR
// numbers that can't be dialled as a US phone (a day before the 20th), and US phones that are also a Danish date
// (310 555 1234 reads as 31 May 1955).
const many = (count, makeOne) => {
  const out = [];
  for (let i = 0; out.length < count; i++) {
    const value = makeOne(i);
    if (value) out.push(value);
  }
  return out;
};
const tajs = many(60, (i) => make.taj(String(20000000 + i * 654321).slice(-8)));
const afms = many(60, (i) => make.afm(String(10000000 + i * 765431).slice(-8)));
const nips = many(60, (i) => {
  const body = String(100000000 + i * 8765431).slice(-9);
  return sumOf(body, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11 < 10 && make.nip(body);
});
const cprs = many(60, (i) => {
  const date = String((i % 19) + 1).padStart(2, "0") + String((i % 12) + 1).padStart(2, "0") + String(50 + (i % 50));
  return date + String(1000 + ((i * 377) % 3000));
});
const usPhones = many(60, (i) => `${20 + (i % 12)}0${2 + (i % 8)}${50 + ((i * 7) % 50)}${1000 + ((i * 377) % 3000)}`);

test("a first name, a skill, a microscope or a product's name in a table doesn't make its column an ID column", () => {
  const quiet = [
    [tajs, (v) => `| Name | Taj Patel |\n| Account | ${v} |`],
    [tajs, (v) => `| Name | Taj |\n| Account | ${v} |`],
    [tajs, (v) => `Contact,Details\nName,Taj Singh\nMember ID,${v}`],
    [tajs, (v) => `Hi Taj, here is the order\n${v}, 4 units`],
    [cprs, (v) => `Skills | CPR, First Aid\nMember no | ${v}`],
    [afms, (v) => `Ana | AFM sample prep\nSample | ${v}`],
    [nips, (v) => `| Product | Nip and tuck serum |\n| Order | ${v} |`],
    [nips, (v) => `| Product | Nip |\n| Order | ${v} |`],
    [nips, (v) => `Nip: ${v}`],
  ];
  for (const [values, template] of quiet) {
    for (const value of values) expectNoKind(template(value), "national_id");
  }
});

test("a US phone in a column headed by the bare word CPR stays a phone number", () => {
  for (const phone of usPhones) {
    for (const text of [
      `Amy Smith\nCPR, First Aid\n${phone}, amy@example.com`,
      `First aid | CPR\nPhone | ${phone}`,
      `name,CPR\nAmy,${phone}`,
    ]) {
      const found = detect(text);
      assert.equal(found.national_id, undefined, `${JSON.stringify(text)} → ${JSON.stringify(found)}`);
      assert.deepEqual(found.phone_number, [phone], `${JSON.stringify(text)} is still flagged`);
    }
  }
});

test("a column headed by an ID's short name still reads its numbers", () => {
  const reads = (text, value) => assert.deepEqual(detect(text).national_id, [value], JSON.stringify(text));
  for (const cpr of cprs.slice(0, 20)) {
    reads(`name,CPR\nAmy,${cpr}`, cpr);
    reads(`name,cpr_nr\nAmy,${cpr}`, cpr);
    reads(`navn,Cpr-nr.\nEva,${cpr}`, cpr);
    reads(`name,Patient CPR\nAmy,${cpr}`, cpr);
    reads(`navn,Cpr\nEva,${cpr}`, cpr);
    reads(`firstName,patientCpr\nAmy,${cpr}`, cpr);
    reads(`name,CPR #\nAmy,${cpr}`, cpr);
  }
  // With the number word after it, the label is the Danish one whatever the digits, as in prose.
  reads("navn;CPR-nummer\nEva;2505901234", "2505901234");
  reads("navn;personnummer\nEva;2505901234", "2505901234");
  for (const taj of tajs.slice(0, 20)) {
    reads(`nev,TAJ szám\nAnna,${taj}`, taj);
    reads(`| Név | TAJ |\n| Anna | ${taj} |`, taj);
  }
  for (const afm of afms.slice(0, 20)) {
    reads(`name,ΑΦΜ\nEleni,${afm}`, afm);
    reads(`name,AFM\nEleni,${afm}`, afm);
    reads(`name,afm\nEleni,${afm}`, afm);
    reads(`name,Afm\nEleni,${afm}`, afm);
  }
  for (const nip of nips.slice(0, 20)) {
    reads(`firma,NIP\nKowalski,${nip}`, nip);
    reads(`firma,nip\nKowalski,${nip}`, nip);
    reads(`faktura;NIP nabywcy\nFV/1;${nip}`, nip);
    reads(`NIP: ${nip}`, nip);
    reads(`{"nip": "${nip}"}`, nip);
  }
});

test("Belgium's dotted number, a rodné číslo with its slash, a German pension number and a HETU need their label", () => {
  // Everyday text takes these layouts too (a part code with a date in it, an account and its bank code, a number
  // and a year), and up to 1 in 13 of them passes the check by chance. Each value here passes its check.
  const label = {
    be: "Rijksregisternummer",
    rc: "rodné číslo",
    rv: "Rentenversicherungsnummer",
    fi: "henkilötunnus",
  };
  const seen = [
    ["be", "Zie 53.26.20-621.06 voor details.", "53.26.20-621.06"],
    ["be", "See 17.09.01-862.42 please.", "17.09.01-862.42"],
    ["rc", "Siehe 602107/0077, danke.", "602107/0077"],
    ["rc", "Kontoauszug: 891015/2010 EUR", "891015/2010"],
    ["rc", "126017/2023", "126017/2023"],
    ["rv", "See 18 190116 P 883 please.", "18 190116 P 883"],
    ["rv", "See 49 170135 I 053 please.", "49 170135 I 053"],
    ["fi", "Viz 050942W6775.", "050942W6775"],
  ];
  const frames = [(v) => `See ${v} please.`, (v) => `Siehe ${v}, danke.`, (v) => `Zie ${v} voor details.`, (v) => v];
  for (const [kind, text, value] of seen) {
    assert.deepEqual(detect(text), {}, JSON.stringify(text));
    for (const frame of frames) expectNoKind(frame(value), "national_id");
    expectOnly(`${label[kind]}: ${value}`, "national_id", value);
    assert.deepEqual(detect(`name;${label[kind]}\nAnna;${value}`).national_id, [value], `${label[kind]} column`);
  }
});

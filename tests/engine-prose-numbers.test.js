// Everyday prose in other languages is full of numbers: dates with times, prices, populations, ISBNs, bus lines,
// lottery draws and order numbers. None of them is a phone or a card, and the phones and cards written next to
// them still are. All values are made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The work meter counts steps only in code loaded after it, so it comes before the engine.
const { assertWorkLinear } = require("./work.js");
require("./load-engine.js")("rules", "detect");

const detect = (text) => Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));

function expectQuiet(messages) {
  const loud = messages.map((m) => [m, detect(m)]).filter(([, found]) => Object.keys(found).length);
  assert.deepEqual(
    loud.map(([m, found]) => `${JSON.stringify(found)} <- ${m}`),
    [],
  );
}

test("a date with its hour isn't a phone, in any order of year, month and day", () => {
  expectQuiet([
    "截止日期：2025-03-22 22:04，请按时提交。",
    "締切は2025/03/22 22:04です。",
    "Am 22.04.2026 07 Uhr 45 geht es los.",
    "The upload window closes 2025-03-22 22:04 sharp.",
  ]);
});

test("a dated reference (year, month, then a counter) isn't a phone", () => {
  expectQuiet([
    "Die Rechnung 2025-10-0471 über 1.234,56 € ist bis zum 30.11.2025 fällig.",
    "Invoice 2026-10-1485 is due next week.",
  ]);
});

test("an amount written with thousands groups and decimals isn't a phone", () => {
  expectQuiet([
    "Das kostet 23.392.382,41 € inkl. MwSt.",
    "Preço: R$ 123.456.789,00 à vista.",
    "It costs $23,392,382.41 in total.",
  ]);
});

test("an amount or a count right next to its currency or noun isn't a phone", () => {
  expectQuiet([
    "Budget : 712 345 678 € sur cinq ans.",
    "Im Jahr 2028 wurden 610.692.216 Fahrgäste gezählt.",
    "La ciudad pasó a 712 345 678 habitantes según la proyección.",
  ]);
});

test("an ISBN isn't a phone", () => {
  expectQuiet(["El libro tiene ISBN 978-99-574-6437-8.", "Le roman (978-2-07-036024-8) est en rupture de stock."]);
});

test("numbers listed with commas aren't a phone", () => {
  expectQuiet(["Linhas 681, 646, 943 e 145 passam lá.", "Bus routes 201, 555, 0136 and 145 stop there."]);
});

test("a lottery draw or a row of small numbers isn't a phone", () => {
  expectQuiet(["Los números de la lotería: 4 8 16 14 44 14.", "Die Lottozahlen waren 18 15 46 3 31 35."]);
});

test("an order number grouped 3-7-7 isn't a phone", () => {
  expectQuiet([
    "Bestellnummer 302-4471882-1190245, bitte bis 10.11.2025 zurücksenden.",
    "मेरा ऑर्डर नंबर 403-5512378-9921034 है, डिलीवरी 05/11/2025 तक होनी थी।",
    "302-4471882-1190245 hasn't arrived yet.",
  ]);
});

test("a number named as an order, invoice, booking or tracking number isn't a phone, in eight languages", () => {
  expectQuiet([
    "Meine Bestellnummer 715-3425577 ist noch nicht angekommen.",
    "Rechnungsnummer 3489635250, bitte prüfen.",
    "Meine Sendungsnummer 8602-907878 hängt seit Tagen fest.",
    "Ma commande n° 837.140.668 n'est toujours pas arrivée.",
    "Le numéro de suivi 910-8833885 ne donne rien.",
    "Facture n° 5756-435743 réglée hier.",
    "Meu código de rastreio 54 75 60 85 97 não atualiza.",
    "A nota fiscal 930-694-1790 veio errada.",
    "Mi número de seguimiento 0736 5171 2450 sigue sin moverse.",
    "Il mio ordine n. 675-506-8315 non è ancora arrivato.",
    "注文番号353-447-8371の荷物がまだ届きません。",
    "ご予約番号881.343.593でお願いします。",
    "运单号687.358.449的包裹还没到。",
    "快递单号619 462 669显示已签收。",
    "मेरा ट्रैकिंग नंबर 3197-401257 है।",
    "मेरा PNR नंबर 660.613.394 है।",
    "رقم الطلب 8653-978734 لم يصل بعد.",
    "رقم الحجز 882.633.972 مؤكد.",
    "رقم العضوية 69 29 68 14 27 لم يتغير.",
    "我的会员号391-249-1858还能用吗？",
  ]);
});

test("an unbroken order number that happens to pass the card check isn't a card", () => {
  expectQuiet([
    "订单号6558568867488107还没发货。",
    "Order number 6558568867488107 hasn't shipped.",
    "Il mio numero di tracking 5684227892460636 non è ancora arrivato.",
    "Il mio ordine n. 5684227892460636 non è ancora arrivato.",
  ]);
});

// What stays: the same numbers next to a phone, card or phone word.
test("phones and cards next to these numbers are still found", () => {
  const cases = [
    ["Llámame al 612 345 678 cuando puedas.", "phone_number", "612 345 678"],
    ["call me at 202, 555, 0136", "phone_number", "202, 555, 0136"],
    ["Llámame al 612, 345, 678", "phone_number", "612, 345, 678"],
    ["Bizum de 20 € al 612 345 678", "phone_number", "612 345 678"],
    ["12/04/2026 202-555-0136", "phone_number", "202-555-0136"],
    ["2025-11-03 202-555-0136 called", "phone_number", "202-555-0136"],
    ["ISBN 978-1-4028-9462-6, questions to 978-555-0136", "phone_number", "978-555-0136"],
    ["the numbers 2 0 2 5 5 5 0 1 3 6 are my cell", "phone_number", "2 0 2 5 5 5 0 1 3 6"],
    ["Bestellnummer 302-4471882, ruf mich an unter 0171 2345678", "phone_number", "0171 2345678"],
    ["Order 123, call me at 202-555-0136", "phone_number", "202-555-0136"],
    ["电话：注文番号の件は090-1234-5678まで", "phone_number", "090-1234-5678"],
    ["my card for order 4111 1111 1111 1111", "credit_card", "4111 1111 1111 1111"],
    ["Bestellnummer 4111 1111 1111 1111", "credit_card", "4111 1111 1111 1111"],
    ["Bestellnummer: Visa 4111111111111111", "credit_card", "4111111111111111"],
  ];
  for (const [text, kind, value] of cases) {
    const found = detect(text);
    assert.ok((found[kind] || []).includes(value), `${text} → ${JSON.stringify(found)}`);
  }
});

// Everyday messages in eight more languages, heavy on numbers, must not warn at all. Unlike the English and Spanish
// ratchet there is no accepted list: every message here was quiet when the corpus was written.
const EVERYDAY = [
  ["normal-messages-es-numbers.txt", 25],
  ["normal-messages-fr.txt", 40],
  ["normal-messages-de.txt", 38],
  ["normal-messages-pt.txt", 38],
  ["normal-messages-ja.txt", 25],
  ["normal-messages-zh.txt", 25],
  ["normal-messages-hi.txt", 20],
  ["normal-messages-ar.txt", 20],
];
function readCorpus(file) {
  return fs
    .readFileSync(path.join(__dirname, "corpus", file), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
}
for (const [file, min] of EVERYDAY) {
  test(`no wrong warnings in the everyday messages (${file})`, () => {
    const msgs = readCorpus(file);
    assert.ok(msgs.length >= min, `corpus has only ${msgs.length} messages`);
    expectQuiet(msgs);
  });
}

// The checks around a phone-shaped number look only at a short stretch of text around it, so a long paste of
// grouped numbers, dates and amounts makes linear work, counted by tests/work.js. The phone and card readers run on the whole paste here,
// not on detect()'s 40 KB windows, so a quadratic check would show.
const finder = (id) => globalThis.Clotr.PATTERNS.find((p) => p.id === id).find;
// About n characters of the unit repeated.
const repeated = (unit, n) => unit.repeat(Math.ceil(n / unit.length));
test("the date, amount, ISBN and list checks stay linear on a long paste", () => {
  const phones = finder("phone_number");
  const cards = finder("credit_card");
  const scan = (text) => phones(text).length + cards(text).length;
  const units = [
    "22.04.2026 07 ",
    "712 345 678 € ",
    "23.392.382,41 ",
    "978-99-574-6437-8 ",
    "4 8 16 14 44 14 ",
    "Bestellnummer 715-3425577 ",
    "订单号6558568867488107 ",
    "注文の件、注文番号：353-447-8371 ",
    "Jane Doe\t415-555-0136\t$120.00\n",
    "Te envío mi número: 612 345 678 ",
  ];
  assertWorkLinear(scan, repeated, units, 75000);
});

// The reference labels above must not reach past the number they name. A verb or a loose word that only shares a
// stem with one ("Te envío…", "Suivi de…", "Im Auftrag von…"), a label further back in a CJK sentence, or a label
// with "call me" between it and the number leaves the phone, ID or card found.
const expectFound = (cases) => {
  const missed = cases
    .map(([text, kind, value]) => [text, kind, value, detect(text)])
    .filter(([, kind, value, found]) => !(found[kind] || []).includes(value));
  assert.deepEqual(
    missed.map(([text, kind, value, found]) => `${kind} ${value} missed in ${text} → ${JSON.stringify(found)}`),
    [],
  );
};

test("a phone after a verb or word that shares a reference label's stem is still found", () => {
  expectFound([
    ["Te envío mi número: 612 345 678", "phone_number", "612 345 678"],
    ["Envío mi contacto: 612 345 678", "phone_number", "612 345 678"],
    ["Suivi de notre échange : 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Dossier Martin, joignable au 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Billet pris, mon numéro 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Pratica chiusa. Mio numero: 345 678 9012", "phone_number", "345 678 9012"],
    ["Spedizione ok, il mio numero 345 678 9012", "phone_number", "345 678 9012"],
    ["Seguimiento: mi número es 612 345 678", "phone_number", "612 345 678"],
    ["Im Auftrag von Herrn Müller: 0171 2345678", "phone_number", "0171 2345678"],
    ["Bestellung angekommen, erreichbar unter 0171 2345678", "phone_number", "0171 2345678"],
    ["Handyvertrag Rechnung 0171 2345678", "phone_number", "0171 2345678"],
    ["Handy Nr. 0171 2345678", "phone_number", "0171 2345678"],
    ['{"pedido":"envío","contacto":"612 345 678"}', "phone_number", "612 345 678"],
  ]);
});

test("a phone in a CJK sentence that mentions an order or booking further back is still found", () => {
  expectFound([
    ["订单有问题请联系我：13812345678", "phone_number", "13812345678"],
    ["预订请联系 13812345678", "phone_number", "13812345678"],
    ["予約の件で連絡ください 090-1234-5678", "phone_number", "090-1234-5678"],
    ["注文の件、090-1234-5678まで連絡ください", "phone_number", "090-1234-5678"],
    ["追跡できない場合は 090-1234-5678 へ", "phone_number", "090-1234-5678"],
  ]);
});

// A made-up resident ID with its check digit worked out, as the national ID tests do.
function cnResidentId(first17) {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...first17].reduce((a, d, i) => a + Number(d) * weights[i], 0);
  return first17 + "10X98765432"[sum % 11];
}

test("a resident ID in a sentence that mentions a booking or membership is still found", () => {
  const id = cnResidentId("1101011990" + "0307123");
  expectFound([
    ["预订人身份证号：" + id, "national_id", id],
    ["办理会员需要身份证号：" + id, "national_id", id],
    ["会员身份证号：" + id, "national_id", id],
    ["身份证号：" + id, "national_id", id],
  ]);
});

test("a card number with a card network's prefix after an order or payment word is still a card", () => {
  const card = "4111" + "1111" + "1111" + "1111";
  expectFound([
    ["订单付款 " + card, "credit_card", card],
    ["订单付款用的这张 " + card, "credit_card", card],
    ["Envío: " + card, "credit_card", card],
    ["Je t'envoie le suivi: " + card, "credit_card", card],
    ["Protocolo n " + card, "credit_card", card],
    ["Bestellung: " + card, "credit_card", card],
  ]);
});

test("a phone in a table row next to an amount, or before a word that starts with a counter, is still found", () => {
  expectFound([
    ["Jane Doe\t415-555-0136\t$120.00", "phone_number", "415-555-0136"],
    ["Jane Doe 415-555-0136 $120 owed", "phone_number", "415-555-0136"],
    ["Tanaka\t090-1234-5678\t¥5,000", "phone_number", "090-1234-5678"],
    ["Müller\t0171 2345678\t€ 45", "phone_number", "0171 2345678"],
    ["連絡先：090-1234-5678 名古屋市中区栄1-2-3", "phone_number", "090-1234-5678"],
    ["連絡先 090-1234-5678 件名：見積もり", "phone_number", "090-1234-5678"],
    ["联系方式 13812345678 个人号", "phone_number", "13812345678"],
  ]);
});

test("everyday words that look like phone words don't turn a labelled number into a phone", () => {
  expectQuiet([
    "Have your order number handy: 415 555 0136",
    "Keep your ticket number handy: 415-555-0136",
    "Keep the confirmation code handy, it's 415 555 0136",
    "Portable build, case 415-555-0136",
    "Appellate case no. 415-555-0136",
    "Über Telefon beitreten, Meeting-ID: 845 2931 7710",
    "Telefonkonferenz: Meeting-ID 845 2931 7710",
  ]);
});

test("a label that says number right before it wins over a contact word further back", () => {
  expectQuiet([
    "注文の件でご連絡します。注文番号：353-447-8371",
    "请联系客服，订单号 3534478371",
    "Ruf mich an wegen Bestellnummer 715-3425577",
    "Join by phone, Meeting ID: 845 2931 7710",
    "会议号：845 2931 7710",
  ]);
  expectFound([
    ["订单号查不到，请联系我：13812345678", "phone_number", "13812345678"],
    ["Meeting ID 845 2931 7710 or call 415-555-0136", "phone_number", "415-555-0136"],
  ]);
});

// A phone line's label names the line, not a number: a plural ("Reservations", "Buchungen"), a compound with a
// phone word in it ("Bestellhotline", "Buchungstelefonnummer") or a contact word ("お問い合わせ") leaves the
// phone found, and so does a phone word before a stem word that only ends in "n" ("für Bestellungen").
test("a phone after a booking, order or billing line's name is still found", () => {
  const cases = [
    ["Telefon für Buchungen: 030 12345678", "030 12345678"],
    ["Telefon für Bestellungen: 030 12345678", "030 12345678"],
    ["Rufen Sie uns an für Bestellungen: 030 12345678", "030 12345678"],
    ["Telefonisch bestellen: 030 1234567", "030 1234567"],
    ["Llámanos, facturación: 912 345 678", "912 345 678"],
    ["Telefon für Buchung: 030 12345678", "030 12345678"],
    ["Reservations: 415-555-0136", "415-555-0136"],
    ["Réservations : 01 42 34 56 78", "01 42 34 56 78"],
    ["Prenotazioni: 06 1234 5678", "06 1234 5678"],
    ["Commandes : 01 42 34 56 78", "01 42 34 56 78"],
    ["Facturation : 01 42 34 56 78", "01 42 34 56 78"],
    ["Encomendas: 912 345 678", "912 345 678"],
    ["Bestellhotline: 0800 1234567", "0800 1234567"],
    ["Bestelltelefon: 030 1234567", "030 1234567"],
    ["Buchungshotline 089 1234567", "089 1234567"],
    ["Rechnungsabteilung: 030 1234567", "030 1234567"],
    ["Bestellannahme: 0171 2345678", "0171 2345678"],
    ["Buchungen: 030 12345678", "030 12345678"],
    ["Bestelltelefonnummer: 030 1234567", "030 1234567"],
    ["Buchungstelefonnummer 030 1234567", "030 1234567"],
    ["Bestellfaxnummer: 030 1234567", "030 1234567"],
    ["Bestellfax: 030 1234567", "030 1234567"],
    ["お問い合わせ：03-1234-5678", "03-1234-5678"],
    ["お問い合わせ 0120-123-456", "0120-123-456"],
    ["お問合せ：03-1234-5678", "03-1234-5678"],
    ["ご予約・お問い合わせ：03-1234-5678", "03-1234-5678"],
    ["ご注文・お問い合わせ：03-1234-5678", "03-1234-5678"],
    ["予約：03-1234-5678", "03-1234-5678"],
    ["注文：03-1234-5678", "03-1234-5678"],
    ["請求：03-1234-5678", "03-1234-5678"],
    ["预订：13812345678", "13812345678"],
    ["预订 13812345678", "13812345678"],
    ["快递：13812345678", "13812345678"],
    ["订单 13812345678", "13812345678"],
    ["会员：13812345678", "13812345678"],
    ["发票：13812345678", "13812345678"],
    ["बुकिंग: 98765 43210", "98765 43210"],
  ];
  expectFound(cases.map(([text, value]) => [text, "phone_number", value]));
});

// "n°" with "my" before it is "my number", and a bare "n°" with no word for what it numbers names nothing.
test("a phone after my n° or a bare n° is still found", () => {
  expectFound([
    ["Mon n° : 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Mon n°: 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Il mio n°: 345 678 9012", "phone_number", "345 678 9012"],
    ["N° : 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Mi nº: 612 345 678", "phone_number", "612 345 678"],
  ]);
});

// The order-number exception for cards is narrow: an expiry date or a security code next to the number makes it a
// card, and a transaction, ticket, refund or booking reference, or any ID, doesn't vouch for a card-length number.
test("a card after an order number with its expiry or code, or after an ID or reference, is still a card", () => {
  const card = "4111" + "1111" + "1111" + "1111";
  expectFound(
    [
      "Order no. " + card + " CVV 123",
      "Order no. " + card + " exp 12/27 cvv 123",
      "Order number " + card + " valid thru 12/27",
      "Order no. " + card + ", 12/27, 123",
      "Transaction ID: " + card,
      "Ticket ID: " + card,
      "Refund number: " + card,
      "Booking ref no " + card,
      "मेरा बुकिंग आईडी " + card + " है।",
    ].map((text) => [text, "credit_card", card]),
  );
});

// English words that share letters with a phone word ("mobility", "telephony", "Mobilfunk"), or a contact word
// that isn't introducing a number ("contacto de soporte"), don't turn a ticket or order number into a phone.
test("words that only look like phone words don't override a ticket or order label", () => {
  expectQuiet([
    "Mobility ticket #415-555-0136",
    "Mobilization order 415-555-0136",
    "Contacto de soporte, ticket #415-555-0136",
    "Telephony case #415-555-0136",
    "Mobilfunk ticket #415-555-0136",
  ]);
  expectFound([
    ["Envío mi contacto: 612 345 678", "phone_number", "612 345 678"],
    ["Contacto: 612 345 678", "phone_number", "612 345 678"],
    ["Mobil: 0171 2345678", "phone_number", "0171 2345678"],
    ["Mobilnummer 0171 2345678", "phone_number", "0171 2345678"],
  ]);
});

// Phone words with an everyday sense count only in their phone sense, so a server that isn't reachable, a call for
// tenders, a laptop or a file's name doesn't turn a ticket number into a phone.
test("phone words in their everyday sense don't override a ticket label", () => {
  expectQuiet([
    "Réparation du portable, ticket #415-555-0136",
    "Server nicht erreichbar, Ticket #415-555-0136",
    "Serveur non joignable, ticket #415-555-0136",
    "Appel d'offres, ticket #415-555-0136",
    "Il file chiamato ticket #415-555-0136",
    "Anrufliste Ticket #415-555-0136",
    "Ruf des Hauses, Ticket #415-555-0136",
    "Telephones ticket #415-555-0136",
  ]);
  expectFound([
    ["Appelez-moi, commande 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
    ["Chiamami, ordine 345 678 9012", "phone_number", "345 678 9012"],
    ["Ruf mich an wegen Bestellung 0171 2345678", "phone_number", "0171 2345678"],
    ["Rufen Sie an, Bestellung 0171 2345678", "phone_number", "0171 2345678"],
    ["Mon portable, commande 06 12 34 56 78", "phone_number", "06 12 34 56 78"],
  ]);
});

test("the narrowed labels, phone words and card checks stay linear on a long paste", () => {
  const phones = finder("phone_number");
  const cards = finder("credit_card");
  const scan = (text) => phones(text).length + cards(text).length;
  const card = "4111" + "1111" + "1111" + "1111";
  const units = [
    "Telefon für Buchungen: 030 12345678 ",
    "Bestellfaxnummer: 030 1234567 ",
    "Mon n° : 06 12 34 56 78 ",
    "Mon billet de train n° 2157239274 ",
    "お問い合わせ：03-1234-5678 ",
    "Order no. " + card + " CVV 123 ",
    "Server nicht erreichbar, Ticket #415-555-0136 ",
    "Bestellungsbestellungsbestellungs",
  ];
  assertWorkLinear(scan, repeated, units, 75000);
});

// Amounts and counts aren't written with a "+" country code, an area code in brackets or dashes, so a phone written
// that way stays a phone with "Visitors" or "Members" after it, as on a flyer copied onto one line.
test("a formatted phone followed by a count or currency word is still a phone", () => {
  expectFound(
    [
      ["Reservas: +34 612 345 678 Personas con movilidad reducida, avisen", "+34 612 345 678"],
      ["Questions? 415-555-0136 Visitors welcome!", "415-555-0136"],
      ["Info: (415) 555-0136 Members $10, guests $15", "(415) 555-0136"],
      ["RSVP to Jane at +1 415 555 0136 Members only", "+1 415 555 0136"],
      ["Kontakt: Frau Meier +49 30 1234567 Besucher melden sich am Empfang", "+49 30 1234567"],
      ["Infos : +33 6 12 34 56 78 Visiteurs bienvenus", "+33 6 12 34 56 78"],
      ["Dúvidas: +55 11 91234-5678 Visitantes são bem-vindos", "+55 11 91234-5678"],
      ["Zelle $ 415-555-0136", "415-555-0136"],
    ].map(([text, phone]) => [text, "phone_number", phone]),
  );
});

// The engine's own card code label knows CCV, CSC, CV2, "código de seguridad" and PIN, and a card word in German,
// French, Japanese or Chinese names a card too, so a card after an order number with any of these is still a card.
test("a card after an order number with its code under another name or a card word is still a card", () => {
  const card = "4111" + "1111" + "1111" + "1111";
  expectFound(
    [
      "Order no. " + card + " CCV 123",
      "Order no. " + card + " CSC: 123",
      "Order number " + card + " CV2: 123",
      "Número de pedido: " + card + " código de seguridad: 123",
      "Order number " + card + " PIN 1234",
      "Order number " + card + " Kreditkarte",
      "Numéro de commande " + card + " carte bleue",
      "注文番号 " + card + " セキュリティコード 123",
      "订单号 " + card + " 安全码 123",
    ].map((text) => [text, "credit_card", card]),
  );
});

// "Mi chiamo" is "my name is" and "si chiama" is "is called", and a handyman isn't a phone ("Handy"), so neither
// turns an order or ticket number into a phone.
test("an Italian name or a handyman doesn't turn an order or ticket number into a phone", () => {
  expectQuiet([
    "Ciao, mi chiamo Sara. Order #3456789012 non è arrivato",
    "Buongiorno, mi chiamo Luca. Ticket 3456789012 ancora aperto",
    "Mi chiamo Luca, case 3456789012",
    "Mi chiamo Luca, booking ref 3456789012",
    "Salve, mi chiamo Anna. Pedido 3456789012",
    "Il prodotto si chiama Foo, order #3456789012",
    "Handyman order #4155550136",
    "Handyman service, order #415-555-0136",
  ]);
  expectFound([["Ti chiamo per l'ordine #3456789012", "phone_number", "3456789012"]]);
});

// A "+" dials a country code, and no order, customer or tracking number starts with one, so a phone written that way
// right after one of these labels is still a phone. Shops and carriers often use the phone as the customer number.
// Written the national way it stays quiet, since order numbers come in the same shapes.
test("a phone with a + country code right after a reference label is still found", () => {
  const labels = [
    "Kundennummer",
    "Bestellnummer",
    "Rechnungsnummer",
    "Sendungsnummer",
    "Aktenzeichen",
    "Buchungsnummer",
    "Vorgangsnummer",
    "Ticketnummer",
    "número de cliente",
    "número de seguimiento",
    "numéro de commande",
    "numéro de suivi",
    "nota fiscal",
    "código de rastreio",
  ];
  const phones = [
    "+49 151 23456789",
    "+34 612 345 678",
    "+33 6 12 34 56 78",
    "+55 11 91234-5678",
    "+1 415 555 0136",
    "+44 7700 900123",
  ];
  expectFound(
    labels.flatMap((label) =>
      phones.flatMap((phone) => [
        [`${label} ${phone}`, "phone_number", phone],
        [`${label}: ${phone}`, "phone_number", phone],
      ]),
    ),
  );
  expectFound([
    ["Mi número de cliente es +34 612 345 678, llámame", "phone_number", "+34 612 345 678"],
    ["Kundennummer +49 151 23456789 bitte zurückrufen", "phone_number", "+49 151 23456789"],
  ]);
  expectQuiet(["Kundennummer 0151 2345 6789", "Mi número de cliente 0038 5512 7790", "Numéro de suivi 06 12 34 56 78"]);
});

// The same goes for a "+" with a space after it, of any kind, and for the plus written out before a country code.
// After "plus" a number starting with 0 is national, and an amount ("plus 19 % MwSt.") isn't a phone either.
test("a phone dialled with a spaced or spelled + right after a reference label is still found", () => {
  const labels = [
    "Kundennummer",
    "Bestellnummer",
    "Rechnungsnummer",
    "Sendungsnummer",
    "Aktenzeichen",
    "Buchungsnummer",
    "Vorgangsnummer",
    "Ticketnummer",
    "número de cliente",
    "número de seguimiento",
    "numéro de commande",
    "numéro de suivi",
    "facture n°",
    "référence",
    "colis",
    "nota fiscal",
    "código de rastreio",
    "encomenda nº",
    "fatura",
    "ordine n.",
    "fattura",
    "prenotazione",
    "注文番号",
    "订单号",
    "会員番号",
    "ऑर्डर नंबर",
    "رقم الطلب",
    "Customer number",
  ];
  const phones = [
    ["+ 1 415 555 0136", "1 415 555 0136"],
    ["+ 1 415 555 0136", "1 415 555 0136"],
    ["+ 1 415 555 0136", "1 415 555 0136"],
    ["+ 1 (415) 555-0136", "1 (415) 555-0136"],
    ["+ 1-415-555-0136", "1-415-555-0136"],
    ["plus 49 151 23456789", "plus 49 151 23456789"],
    ["plus 34 612 345 678", "plus 34 612 345 678"],
    ["plus 33 6 12 34 56 78", "plus 33 6 12 34 56 78"],
    ["plus 55 11 98765-4321", "plus 55 11 98765-4321"],
    ["plus 1 415 555 0136", "1 415 555 0136"],
    ["plus 44 7700 900123", "plus 44 7700 900123"],
    ["Plus 44 7700 900123", "Plus 44 7700 900123"],
  ];
  expectFound(
    labels.flatMap((label) =>
      phones.flatMap(([phone, found]) => [
        [`${label} ${phone}`, "phone_number", found],
        [`${label}: ${phone}`, "phone_number", found],
      ]),
    ),
  );
  expectQuiet([
    "Kundennummer plus 0151 2345678",
    "Bestellnummer plus 0049 171 2345678",
    "Rechnungsnummer plus 19 % MwSt.",
    "Rechnungsnummer 12345678 plus 19 % MwSt.",
    "Bestellnummer plus 15 € Versand",
    "Kundennummer plus 1 234 567 €",
    "Numéro de suivi plus 06 12 34 56 78",
  ]);
});

// A card after an order label is still a card with its security code named in any language beside it, whichever
// language the label is in.
test("a card after an order label with its code named in another language is still a card", () => {
  const labels = [
    "Order no.",
    "Order number",
    "Invoice number",
    "Tracking number",
    "Bestellnummer",
    "Rechnungsnummer",
    "Sendungsnummer",
    "numéro de commande",
    "numéro de suivi",
    "número de pedido",
    "numero di spedizione",
    "número de rastreio",
    "fattura n.",
  ];
  const codes = [
    "Prüfnummer",
    "Kartenprüfnummer",
    "Sicherheitscode",
    "cryptogramme",
    "code de sécurité",
    "codice di sicurezza",
    "código de segurança",
    "CVV",
    "CVC",
    "CCV",
    "CSC",
    "CV2",
    "PIN",
    "código de seguridad",
    "exp",
    "gültig bis",
    "セキュリティコード",
    "安全码",
  ];
  const cards = ["4111" + "1111" + "1111" + "1111", "5555" + "5555" + "5555" + "4444"];
  expectFound(
    labels.flatMap((label) =>
      codes.flatMap((code) => cards.map((card) => [`${label} ${card} ${code} 123`, "credit_card", card])),
    ),
  );
});

// A card after an order label is still a card with its expiry written in words beside it, in any language.
test("a card after an order label with its expiry written in words is still a card", () => {
  const labels = [
    "Order no.",
    "número de pedido",
    "numéro de commande",
    "ordine n.",
    "nota fiscal",
    "Bestellnummer",
    "ऑर्डर नंबर",
    "注文番号",
    "订单号",
    "رقم الطلب",
  ];
  const expiries = [
    "expires April 2029",
    "valid until April 2029",
    "exp April 2029",
    "vence en abril de 2029",
    "válida hasta abril de 2029",
    "caduca en abril",
    "caduca en abril de 2029",
    "expire en avril 2029",
    "valable jusqu'en avril 2029",
    "date d'expiration avril 2029",
    "scade ad aprile 2029",
    "valida fino ad aprile 2029",
    "scadenza aprile 2029",
    "válido até abril de 2029",
    "vence em abril de 2029",
    "validade abril de 2029",
    "expira em abril de 2029",
    "läuft im April 2029 ab",
    "gültig bis April 2029",
    "Ablauf April 2029",
    "समाप्ति अप्रैल 2029",
    "समाप्ति तिथि अप्रैल 2029",
    "एक्सपायरी अप्रैल 2029",
    "वैधता अप्रैल 2029 तक",
    "有効期限 2029年4月",
    "期限 2029年4月",
    "有效期 2029年4月",
    "到期 2029年4月",
    "تنتهي في أبريل 2029",
    "صالحة حتى أبريل 2029",
    "تاريخ الانتهاء أبريل 2029",
  ];
  const cards = ["4539" + "1488" + "0343" + "6467", "5425" + "2334" + "3010" + "9903"];
  expectFound(
    labels.flatMap((label) =>
      expiries.flatMap((expiry) => cards.map((card) => [`${label} ${card} ${expiry}`, "credit_card", card])),
    ),
  );
});

// Each language with an order label in the engine, with its labels, its names for a card's security code and the
// ways it writes a card's expiry. The engine keeps its order labels in a table by language, and a language added
// there has to come here too, with names that keep a card found beside one of its labels. Its shop deadlines, which
// name a day where a card's expiry names only the month, keep a card-shaped order number quiet.
const ORDER_LABEL_LANGUAGES = {
  en: {
    labels: ["Order no.", "Order number", "Invoice number", "Tracking number"],
    codes: ["CVV", "CVC", "CCV", "CSC", "CV2", "PIN", "security code"],
    expiries: ["expires April 2029", "valid until April 2029", "exp April 2029", "valid thru 04/29"],
    deadlines: ["return by April 30"],
  },
  es: {
    labels: ["Número de pedido", "Factura nº", "número de seguimiento", "número de envío", "número de guía"],
    codes: ["código de seguridad"],
    expiries: [
      "vence en abril de 2029",
      "fecha de vencimiento abril de 2029",
      "caducidad abril de 2029",
      "válida hasta abril de 2029",
      "caduca en abril",
      "caduca a finales de abril de 2029",
      "expira en abril de 2029",
    ],
    deadlines: ["el cupón caduca el 15 de abril", "oferta válida hasta el 30 de abril"],
  },
  fr: {
    labels: ["Numéro de commande", "numéro de suivi", "Commande n°", "Facture n°"],
    codes: ["cryptogramme", "cryptogramme visuel", "code de sécurité", "code sécurité"],
    expiries: [
      "date d'expiration avril 2029",
      "expire en avril 2029",
      "valable jusqu'en avril 2029",
      "valable jusqu’à fin avril 2029",
      "fin de validité avril 2029",
    ],
    deadlines: ["offre valable jusqu'au 30 avril", "retour valable jusqu'au 30 avril 2029"],
  },
  it: {
    labels: ["Ordine n.", "Fattura n.", "Numero di spedizione", "Numero ordine"],
    codes: ["codice di sicurezza", "codice sicurezza"],
    expiries: [
      "data di scadenza aprile 2029",
      "scadenza aprile 2029",
      "scade ad aprile 2029",
      "scade a fine aprile 2029",
      "valida fino ad aprile 2029",
    ],
    deadlines: ["il coupon scade il 30 aprile", "reso valido fino al 30 aprile 2029"],
  },
  pt: {
    labels: ["Encomenda nº", "Fatura nº", "Número de rastreio", "Código de rastreamento"],
    codes: ["código de segurança", "codigo de seguranca"],
    expiries: [
      "validade abril de 2029",
      "data de validade abril de 2029",
      "vence em abril de 2029",
      "válido até abril de 2029",
      "expira em abril de 2029",
      "vencimento em abril de 2029",
    ],
    deadlines: ["cupom válido até 30 de abril", "o boleto tem vencimento em 30 de abril"],
  },
  de: {
    labels: ["Bestellnummer", "Rechnungsnummer", "Sendungsnummer", "Lieferscheinnummer", "Bestellnr."],
    codes: ["Prüfnummer", "Kartenprüfnummer", "Pruefnummer", "Sicherheitscode", "Sicherheits-Code"],
    expiries: [
      "gültig bis April 2029",
      "Ablaufdatum April 2029",
      "Ablauf April 2029",
      "läuft im April 2029 ab",
      "läuft Ende April 2029 ab",
    ],
    deadlines: ["Rückgabe läuft am 30. April ab", "Ablauf der Bestellung: am 30. April"],
  },
  hi: {
    labels: ["ऑर्डर नंबर", "ट्रैकिंग नंबर", "इनवॉइस नंबर", "बिल नंबर"],
    codes: ["सीवीवी", "सुरक्षा कोड"],
    expiries: ["समाप्ति तिथि अप्रैल 2029", "एक्सपायरी अप्रैल 2029", "समाप्ति अप्रैल 2029", "वैधता अप्रैल 2029 तक"],
    deadlines: ["ऑफ़र की वैधता 30 अप्रैल तक"],
  },
  ja: {
    labels: ["注文番号", "追跡番号", "伝票番号", "請求番号"],
    codes: ["セキュリティコード", "セキュリティーコード"],
    expiries: ["有効期限 2029年4月", "期限 2029年4月", "期限：2029年4月"],
    deadlines: ["返品期限 2029年4月30日"],
  },
  zh: {
    labels: ["订单号", "訂單號碼", "运单号", "快递单号", "发票号码"],
    codes: ["安全码", "安全碼"],
    expiries: ["有效期 2029年4月", "有效期至 2029年4月", "到期 2029年4月", "到期日 2029年4月"],
    deadlines: ["退货到期 2029年4月30日", "优惠券到期日 2029年4月30日"],
  },
  ar: {
    labels: ["رقم الطلب", "رقم الفاتورة", "رقم الشحنة", "رقم التتبع"],
    codes: ["رمز الأمان", "رمز امان"],
    expiries: [
      "تاريخ الانتهاء أبريل 2029",
      "تاريخ انتهاء الصلاحية أبريل 2029",
      "تنتهي في أبريل 2029",
      "صالحة حتى أبريل 2029",
    ],
    deadlines: ["العرض صالح حتى 30 أبريل"],
  },
};

test("each order label's language names a card's security code and expiry too", () => {
  const source = require("./load-engine.js").source("rules");
  const table = source.match(/const ORDER_LABELS = \{\n([\s\S]*?)\n {2}\};/)[1];
  const entries = Object.fromEntries(
    table
      .split(/^ {4}(?=\w+: \{)/m)
      .filter(Boolean)
      .map((entry) => [entry.match(/^(\w+):/)[1], entry]),
  );
  assert.deepEqual(Object.keys(entries).sort(), Object.keys(ORDER_LABEL_LANGUAGES).sort());
  for (const [language, entry] of Object.entries(entries)) {
    for (const field of ["code", "expiry"]) {
      assert.match(entry, new RegExp(String.raw`\b${field}: `), `${language} has no ${field}`);
      assert.doesNotMatch(
        entry,
        new RegExp(String.raw`\b${field}: [^\n]*?(["'\`])\1`),
        `${language} has an empty ${field}`,
      );
    }
  }

  // Every label with every hint, from its own language or another, and a written date.
  const hints = [
    ...Object.values(ORDER_LABEL_LANGUAGES).flatMap(({ codes }) => codes.map((code) => ` ${code} 123`)),
    ...Object.values(ORDER_LABEL_LANGUAGES).flatMap(({ expiries }) => expiries.map((expiry) => ` ${expiry}`)),
    ", 04/29",
  ];
  const cardsIn = (text) => detect(text).credit_card || [];
  const missed = [];
  for (const [language, { labels, deadlines }] of Object.entries(ORDER_LABEL_LANGUAGES)) {
    for (const label of labels) {
      for (const card of ["4111" + "1111" + "1111" + "1111", "5555" + "5555" + "5555" + "4444"]) {
        assert.deepEqual(cardsIn(`${label} ${card}`), [], `${language}: "${label}" isn't an order label`);
        for (const deadline of deadlines) {
          const text = `${label} ${card}, ${deadline}`;
          assert.deepEqual(cardsIn(text), [], `${language}: a shop deadline keeps the card in ${text}`);
        }
        for (const hint of hints) {
          const text = `${label} ${card}${hint}`;
          if (!cardsIn(text).includes(card)) missed.push(`${language}: ${text}`);
        }
      }
    }
  }
  assert.deepEqual(missed, []);
});

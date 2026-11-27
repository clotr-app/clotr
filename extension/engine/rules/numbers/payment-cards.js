// findCards(): payment card numbers, by their shape, their check digit and a card word nearby, but not an order
// number that happens to pass the check.
(() => {
  "use strict";

  const {
    validLuhn,
    spanText,
    digitsOf,
    hasNumberWord,
    digitCount,
    numberRuns,
    REF_GLUED_NUMBER_WORD,
    REF_SEP,
    REF_WORD_END,
    worldNationalIds,
  } = globalThis.ClotrInternal;

  // ---------- What a card looks like ----------

  // ── Card shapes ────────────────────────────────────

  // Digits with spaces or dashes allowed, checked with the Luhn sum.
  const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
  // A card typed in parts is grouped the way it's printed: fours with a short last group, 4-6-5 for
  // American Express, 4-6-4 for Diners Club. Some are in threes. Luhn and the issuer still have to pass.
  const CARD_GROUPS = /^(?:\d+|(?:\d{4}[ -])+\d{1,4}|(?:\d{3}[ -]){5}\d|\d{4}[ -]\d{6}[ -]\d{4,5})$/;
  // An IBAN, or a code shaped like one ("es16 3435 8224 …"), has digit runs that pass Luhn 1 time in 10.
  const IBAN_SHAPED = /\b[a-z]{2}\d{2}(?:[ -]?[a-z0-9]){11,30}\b/gi;

  // No card network uses 978 or 979, and about 1 ISBN in 10 passes Luhn anyway.
  function isIsbn13(candidate) {
    return /^97[89]\d{10}$/.test(candidate.replace(/\D/g, ""));
  }

  // Each network's issuer prefix and lengths (ISO/IEC 7812). Luhn alone passes 1 random number in 10,
  // so a bare number must fit one. A number a label calls a card only needs Luhn, so a new network counts.
  const CARD_NETWORKS = [
    { re: /^4/, lengths: [13, 16, 19] }, // Visa
    { re: /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/, lengths: [16] }, // Mastercard, incl. 2221-2720
    { re: /^3[47]/, lengths: [15] }, // American Express
    { re: /^(?:6011|64[4-9]|65|622(?:1[2-9]\d|[2-8]\d\d|9[01]\d|92[0-5]))/, lengths: [16, 19] }, // Discover
    { re: /^(?:30[0-5]|3[689])/, lengths: [14] }, // Diners Club
    { re: /^35(?:2[89]|[3-8]\d)/, lengths: [16] }, // JCB
    { re: /^62/, lengths: [16, 17, 18, 19] }, // UnionPay
    { re: /^(?:5[0678]|6304|6390|67)/, lengths: [12, 13, 14, 15, 16, 17, 18, 19] }, // Maestro
  ];
  // ── Card labels ────────────────────────────────────

  function cardNetwork(digits) {
    return CARD_NETWORKS.some((network) => network.lengths.includes(digits.length) && network.re.test(digits));
  }

  // "my card is …" or "Visa ending in …" vouches for the number. A gift card's code is another shape (giftCode).
  const CARD_NAMES = [
    String.raw`(?:(?:credit|debit|bank)[\s-]*)?cards?|visa|master\s*card|mastercard|amex|american\s+express`,
    String.raw`discover|diners(?:\s+club)?|jcb|union\s*pay|maestro|tarjetas?(?:\s+de\s+(?:cr[eé]dito|d[eé]bito))?`,
  ].join("|");
  const CARD_WORD = new RegExp(String.raw`(?<![\p{L}])(?:${CARD_NAMES})(?![\p{L}])`, "iu");

  function cardLabelNear(text, index) {
    if (CARD_WORD.test(text.slice(Math.max(0, index - 35), index))) return true;
    return CARD_WORD.test(text.slice(index, index + 35));
  }

  // ---------- Numbers that only look like cards ----------

  // ── Order numbers that pass the card check ─────────

  // About 1 order number in 10 passes Luhn. Right after a label that says "number" ("Order number …",
  // "Bestellnummer", "订单号"), an unbroken run of digits is that order, invoice or parcel. "Bestellung: …"
  // without "number" may be the card that paid, and an ID, ticket or booking may be anything.
  // It's still a card in groups of four, or with a card or payment word, a security code or an expiry nearby.
  //
  // Each language has its labels, security code names and expiry words. A test checks that a new
  // language has all three, or a card with its code beside one of the labels goes quiet.
  // A card's expiry names only a month and year ("abril de 2029", "2029年4月"). A coupon deadline names
  // the day too, so "caduca", "scade", "期限" and "到期" count only before a month and year.
  function wholeWord(words) {
    return String.raw`(?<![\p{L}])(?:${words})(?![\p{L}])`;
  }

  const MONTH_NAMES = [
    "january|february|march|april|may|june|july|august|september|october|november|december",
    "enero|febrero|marzo|abril|mayo|junio|julio|agosto|se?ptiembre|octubre|noviembre|diciembre",
    "janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre",
    "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre",
    "janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro",
    "januar|j[äa]nner|februar|m(?:ä|ae|a)rz|april|mai|juni|juli|august|september|oktober|november|dezember",
    "जनवरी|फरवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|अक्तूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर",
    String.raw`يناير|فبراير|مارس|[أاإ]بريل|مايو|يوني[وه]|يولي[وه]|[أا]غسطس|سبتمبر|[أا]كتوبر|نوفمبر|ديسمبر`,
    String.raw`كانون[^\S\n]+(?:الثاني|الأول)|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين[^\S\n]+(?:الأول|الثاني)`,
  ].join("|");

  // A month name, up to three short words after the deadline word, then a year or no number at all: "April 2029",
  // "fin de abril de 2029". A number right after it would be the day.
  const UP_TO_3_WORDS = String.raw`(?:[\p{L}\p{M}]{1,8}[^\S\n]+){0,3}`;
  const MONTH_NAME = String.raw`(?<![\p{L}\p{M}])(?:${MONTH_NAMES})(?![\p{L}\p{M}])`;
  const YEAR_OR_NO_DAY = String.raw`(?:[^\S\n]+(?:de[^\S\n]+)?20\d\d(?!\d)|(?![^\S\n]*\d))`;
  const MONTH_THEN_YEAR = String.raw`${UP_TO_3_WORDS}${MONTH_NAME}${YEAR_OR_NO_DAY}`;
  // "2029年4月".
  const YEAR_NEN_MONTH = String.raw`20\d\d[^\S\n]*年[^\S\n]*(?:0?[1-9]|1[0-2])[^\S\n]*月(?![^\S\n]*\d)`;

  // A deadline word followed by a month and year, and no day.
  function expiresOn(words) {
    return String.raw`(?:${words})[^\S\n]*[:：]?[^\S\n]*(?:${MONTH_THEN_YEAR}|${YEAR_NEN_MONTH})`;
  }

  // before: the word before "number" ("Order no."). after: the word after it ("número de pedido").
  // whole: the full label ("Bestellnummer", "注文番号").
  const ORDER_LABELS = {
    en: {
      before: "order|invoice|tracking",
      after: "order|invoice|tracking",
      code: wholeWord(String.raw`cvv2?|cvc2?|ccv|csc|cv2|pin|security[^\S\n]+code|card[^\S\n]+verification`),
      expiry: wholeWord(String.raw`exp(?:iry|ires?|iration|ired)?|valid[^\S\n]+(?:thru|through|until|to)`),
    },
    es: {
      before: "factura",
      after: String.raw`pedido|factura|seguimiento|env[ií]o|gu[ií]a`,
      code: wholeWord(String.raw`c[oó]digo[^\S\n]+de[^\S\n]+seguridad`),
      expiry: [
        wholeWord("vence|vencimiento|caducidad"),
        expiresOn(wholeWord(String.raw`caduca|expira|v[aá]lid[ao]s?[^\S\n]+hasta`)),
      ].join("|"),
    },
    fr: {
      before: "commande|facture",
      after: "facture|commande|suivi",
      code: wholeWord(String.raw`cryptogramme|code[^\S\n]+(?:de[^\S\n]+)?s[ée]curit[ée]`),
      expiry: [
        wholeWord(String.raw`date[^\S\n]+d['’]expiration|fin[^\S\n]+de[^\S\n]+validit[ée]`),
        expiresOn(String.raw`(?<![\p{L}])valable[^\S\n]+jusqu['’]`),
      ].join("|"),
    },
    it: {
      before: "fattura|ordine",
      after: "fattura|ordine|spedizione",
      code: wholeWord(String.raw`codice[^\S\n]+(?:di[^\S\n]+)?sicurezza`),
      expiry: [wholeWord("scadenza"), expiresOn(wholeWord(String.raw`scade|valid[ao][^\S\n]+fino`))].join("|"),
    },
    pt: {
      before: "fatura|encomenda",
      after: "rastreio|rastreamento",
      code: wholeWord(String.raw`c[oó]digo[^\S\n]+(?:de[^\S\n]+)?seguran[cç]a`),
      expiry: [
        wholeWord("validade"),
        expiresOn(wholeWord(String.raw`vencimento|expira|v[aá]lid[oa]s?[^\S\n]+at[eé]`)),
      ].join("|"),
    },
    de: {
      // "Bestellnummer", "Rechnungsnr.", up to four letters between, but not a fax or phone ("Bestellfaxnr.").
      whole:
        String.raw`(?<![\p{L}])(?:bestell|rechnung|sendung|lieferschein)` +
        String.raw`(?:(?!fax|tel|ruf)\p{L}){0,4}(?:nummer|nr\.?)`,
      code: wholeWord(String.raw`(?:karten)?pr(?:[uü]|ue)f(?:nummer|code)|(?:karten)?sicherheits-?code`),
      expiry: [
        wholeWord(String.raw`g[uü]ltig|ablaufdatum`),
        expiresOn(wholeWord(String.raw`l(?:ä|ae)uft|ablauf`)),
      ].join("|"),
    },
    hi: {
      whole:
        String.raw`(?<![\p{L}])(?:ऑर्डर|ट्रैकिंग|इनवॉइस|बिल)` + String.raw`${REF_WORD_END}${REF_SEP}(?:नंबर|संख्या)`,
      code: wholeWord(String.raw`सीवीवी|(?:सुरक्षा|सिक्योरिटी)[^\S\n]+कोड`),
      expiry: [
        wholeWord(String.raw`एक्सपायरी|समाप्ति[^\S\n]+(?:तिथि|तारीख)`),
        expiresOn(wholeWord("समाप्ति|वैधता|वैध")),
      ].join("|"),
    },
    ja: {
      whole: String.raw`(?:注文|追跡|伝票|請求)${REF_GLUED_NUMBER_WORD}`,
      code: "セキュリティー?コード",
      expiry: `有効期限|${expiresOn("期限")}`,
    },
    zh: {
      whole: String.raw`(?:订单|訂單|运单|運單|快递|快遞|发票|發票|物流单|物流單)${REF_GLUED_NUMBER_WORD}|单号|單號`,
      code: "安全[码碼]",
      expiry: `有效期|${expiresOn("到期日?")}`,
    },
    ar: {
      whole: String.raw`رقم[^\S\n]+(?:ال)?(?:طلب|فاتورة|شحنة|تتبع)`,
      code: String.raw`رمز[^\S\n]+(?:ال)?[أا]مان`,
      expiry: [
        wholeWord(String.raw`تاريخ[^\S\n]+(?:ال)?انتهاء`),
        expiresOn(wholeWord(String.raw`تنتهي|صالح[ةه]?[^\S\n]+حتى`)),
      ].join("|"),
    },
  };

  // One part ("before", "code", …) from every language, as one alternation.
  function cardOrderLabels(part) {
    return Object.values(ORDER_LABELS)
      .flatMap((language) => language[part] || [])
      .join("|");
  }

  const CARD_ORDER_NUMBER_WORD = String.raw`(?:n[º°o]?|nr|num\p{L}*|number|nummer|n[uú]mero|numero)`;
  const LABELS_BEFORE = cardOrderLabels("before");
  const LABELS_AFTER = cardOrderLabels("after");
  // "Order no.", "invoice number".
  const ORDER_NO = String.raw`(?<![\p{L}])(?:${LABELS_BEFORE})${REF_WORD_END}${REF_SEP}${CARD_ORDER_NUMBER_WORD}\.?`;
  // "número de pedido", "numero della fattura".
  const NUMBER_WORDS = String.raw`(?:number|n[uú]mero|num[ée]ro|numero|n[º°]|c[oó]digo|codice)`;
  const OF_WORDS = String.raw`(?:of|de|di|do|da|du|del|della)`;
  const NO_OF_ORDER = String.raw`(?<![\p{L}])${NUMBER_WORDS}[^\S\n]*(?:${OF_WORDS}[^\S\n]+)?(?:${LABELS_AFTER})`;
  const ORDER_NUMBER_RIGHT_BEFORE = new RegExp(
    String.raw`(?:${ORDER_NO}|${NO_OF_ORDER}|${cardOrderLabels("whole")})${REF_SEP}$`,
    "iu",
  );
  // Chinese, Japanese and Arabic words count without word edges.
  const PAYMENT_WORDS = [
    String.raw`pay|paid|payment|pago|pagar|pagu[eé]|pagamento|paiement|pay[ée]|payer`,
    String.raw`zahlung|bezahl\p{L}*|भुगतान`,
  ].join("|");
  const PAYMENT_WORD = new RegExp(
    String.raw`(?<![\p{L}])(?:${PAYMENT_WORDS})(?![\p{L}])|付款|支付|付費|決済|支払|دفع`,
    "iu",
  );
  // A security code, an expiry, a card word in another language ("Kreditkarte", "carte bleue"), or "04/29".
  const CARTE = String.raw`carte(?:[^\S\n]+(?:bleue|bancaire|de[^\S\n]+cr[ée]dit))?`;
  const OTHER_CARD_WORD = String.raw`(?<![\p{L}])(?:(?:kredit|bank|ec-)?karte|${CARTE}|cb)(?![\p{L}])`;
  const MONTH_SLASH_YEAR = String.raw`(?<![\d/])(?:0[1-9]|1[0-2])[^\S\n]*\/[^\S\n]*(?:20)?\d\d(?![\d/])`;
  const CARD_DETAIL_NEAR = new RegExp(
    String.raw`${cardOrderLabels("code")}|${cardOrderLabels("expiry")}|${OTHER_CARD_WORD}|${MONTH_SLASH_YEAR}`,
    "iu",
  );

  function orderNumberNotCard(text, match) {
    if (!/^\d+$/.test(match[0])) return false;
    if (!ORDER_NUMBER_RIGHT_BEFORE.test(text.slice(Math.max(0, match.index - 40), match.index))) return false;
    if (cardLabelNear(text, match.index)) return false;
    const around = text.slice(Math.max(0, match.index - 35), match.index + match[0].length + 35);
    return !PAYMENT_WORD.test(around) && !CARD_DETAIL_NEAR.test(around);
  }

  // ---------- Reading every card ----------

  // ── Finding cards ──────────────────────────────────

  // Four groups of four with dots, the way some forms and receipts print a card.
  const CARD_DOTS_RE = /(?<![\d.])\d{4}\.\d{4}\.\d{4}\.\d{4}(?![\d.])/g;
  // A card over two to four lines in its fours, maybe with "> " from a quoted reply. Only with a card word
  // near it, since four-digit numbers one to a line pass Luhn 1 time in 10.
  const FOURS_ON_A_LINE = String.raw`\d{4}(?:[ -]\d{4}){0,2}`;
  const NEXT_LINE = String.raw`[^\S\n]{0,4}\r?\n[^\S\n]{0,4}(?:>[^\S\n]?){0,3}`;
  const CARD_LINES_RE = new RegExp(
    String.raw`(?<![\d.])${FOURS_ON_A_LINE}(?:${NEXT_LINE}${FOURS_ON_A_LINE}){1,3}(?![\d])`,
    "g",
  );
  const AMAZON_ORDER = /^\d{3}\s*-?\s*\d{7}\s*-?\s*\d{7}$/;

  // IBAN-shaped codes, found once and only when needed. They come in the same order as the numbers,
  // so each number checks only the next code that hasn't ended yet.
  function ibanRanges(text) {
    let ranges = null;
    let next = 0;
    function all() {
      if (!ranges) ranges = [...text.matchAll(IBAN_SHAPED)].map((iban) => [iban.index, iban.index + iban[0].length]);
      return ranges;
    }
    function overlapsIban(match) {
      const list = all();
      while (next < list.length && list[next][1] <= match.index) next++;
      return next < list.length && list[next][0] < match.index + match[0].length;
    }
    return { all, overlapsIban };
  }

  // "3.4111111111111111": digits right after a decimal point are a fraction.
  function afterDecimalPoint(text, index) {
    return index >= 2 && /\d/.test(text[index - 2]) && text[index - 1] === ".";
  }

  function typedCard(text, match, ibans) {
    if (afterDecimalPoint(text, match.index)) return false;
    if (!validLuhn(match[0]) || isIsbn13(match[0])) return false;
    if (!CARD_GROUPS.test(match[0])) return false;
    if (ibans.overlapsIban(match)) return false;
    if (!cardNetwork(match[0].replace(/\D/g, "")) && !cardLabelNear(text, match.index)) return false;
    return !orderNumberNotCard(text, match);
  }

  // One digit a group, or groups of 3+ with a shorter last one and at most one middle group that isn't four.
  // Ones and twos are a lotto line, scores or an IMEI read out.
  function cardGrouping(sizes) {
    if (sizes.every((size) => size === 1)) return true;
    const middle = sizes.slice(0, -1);
    if (middle.some((size) => size < 3)) return false;
    return middle.filter((size) => size !== 4).length <= 1;
  }

  // A card typed some other way than its printed groups ("4 5 3 9 …", two halves of eight, a slip in the
  // grouping). It needs a card word near it, Luhn and a network, and 15+ digits: 12 to 14 is also a phone's.
  // Returns the card as written, or null.
  function looselyGroupedCard(text, run, ibans) {
    const digits = digitsOf(run.groups);
    if (run.groups.length < 2 || digits.length < 15 || digits.length > 19) return null;
    if (!validLuhn(digits) || !cardNetwork(digits)) return null;
    const sizes = run.groups.map(digitCount);
    if (!cardGrouping(sizes)) return null;

    const span = spanText(text, run.groups);
    // A comma splits a list or a CSV row. A tab splits cells, unless they hold a card's fours.
    if (span.includes(",")) return null;
    if (span.includes("\t") && sizes.slice(0, -1).some((size) => size !== 4)) return null;
    if (AMAZON_ORDER.test(span)) return null;

    const from = run.groups[0][0].start;
    if (text[from - 1] === "+") return null; // "+49 159 …" dials a phone
    if (CARD_GROUPS.test(span)) return null; // already read above
    if (!cardLabelNear(text, from)) return null;
    if (ibans.all().some(([start, end]) => start < from + span.length && from < end)) return null;
    return span;
  }

  function findCards(text) {
    const ibans = ibanRanges(text);
    const found = [...text.matchAll(CARD_RE)].filter((match) => typedCard(text, match, ibans)).map((match) => match[0]);

    for (const run of numberRuns(text)) {
      if (hasNumberWord(run.groups)) {
        // Spelled out ("four five three nine …"): starts like a card and passes Luhn.
        const digits = digitsOf(run.groups);
        if (/^[3-6]/.test(digits) && validLuhn(digits)) found.push(spanText(text, run.groups));
        continue;
      }
      const span = looselyGroupedCard(text, run, ibans);
      if (span && !found.some((card) => span.includes(card))) found.push(span);
    }

    if (/\d[^\S\n]*\n[^\S\n]*(?:>[^\S\n]?){0,3}\d/.test(text)) {
      for (const match of text.matchAll(CARD_LINES_RE)) {
        const digits = match[0].replace(/\D/g, "");
        if (digits.length === 16 && validLuhn(digits) && cardNetwork(digits) && cardLabelNear(text, match.index)) {
          found.push(match[0]);
        }
      }
    }

    if (text.includes(".")) {
      for (const match of text.matchAll(CARD_DOTS_RE)) {
        if (validLuhn(match[0]) && cardNetwork(match[0].replace(/\D/g, ""))) found.push(match[0]);
      }
    }

    // A labelled South African ID passes Luhn too, and one born in the 1940s to 60s starts like a card.
    if (!found.length) return found;
    const ids = worldNationalIds(text);
    if (!ids.length) return found;
    return found.filter((card) => !ids.some((id) => id.includes(card)));
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, isIsbn13, findCards };
})();

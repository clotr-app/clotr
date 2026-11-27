// What a number is by what's around it: a label, a log or version line, a date, an amount, a wrapped line.
// Phones, cards, SSNs and IDs ask these before they report a number.
(() => {
  "use strict";

  const {
    lastItem,
    spanText,
    gapBefore,
    digitsOf,
    hasNumberWord,
    numberGroupSizes,
    PHONE_CONTEXT,
    ssnLabelBefore,
    ACCOUNT_NAME_BEFORE,
    checkedAccountAt,
  } = globalThis.ClotrInternal;

  // ---------- Local phone numbers ----------

  // ── UK, Australian and European numbers ────────────

  // "07700 900123" or "020 7946 0958", grouped like a phone or right after a phone word.
  // A bare "order 07123456789" isn't one.
  const LOCAL_PHONE = /^(?:07\d{9}|04\d{8}|0[12]\d{8,9})$/;
  const LOCAL_SHAPES = new Set(["5,6", "5,3,3", "4,3,3", "4,3,4", "3,4,4", "4,6", "2,4,4", "4,4,3"]);
  const LOCAL_CONTEXT = /\b(?:call|ring|text|phone|mobile|cell|whatsapp|tel|number)\b[^\d\n]{0,20}$/i;

  function localPhone(text, run) {
    if (!LOCAL_PHONE.test(digitsOf(run.groups))) return false;
    if (LOCAL_SHAPES.has(numberGroupSizes(run.groups)) && !commaSplit(text, run.groups)) return true;
    const start = run.units[0].start;
    return LOCAL_CONTEXT.test(text.slice(Math.max(0, start - 30), start));
  }

  // Each country's lengths and groupings. A phone word also lets one be typed without separators.
  const EUROPEAN_NATIONAL_FORMATS = [
    { digits: (d) => /^0[1-9]\d{8}$/.test(d), groups: new Set(["2,2,2,2,2"]) },
    {
      digits: (d) => /^0[2-9]\d{8,10}$/.test(d) || /^01[5-7]\d{8,9}$/.test(d),
      groups: new Set([
        "2,8",
        "2,9",
        "2,10",
        "3,7",
        "3,8",
        "3,9",
        "3,3,4",
        "3,4,4",
        "4,6",
        "4,7",
        "4,8",
        "4,4,4",
        "5,6",
        "5,7",
      ]),
    },
    { digits: (d) => /^04[5-9]\d{7}$/.test(d), groups: new Set(["4,2,2,2", "2,8"]) },
    { digits: (d) => /^0[1-9]\d{7}$/.test(d), groups: new Set(["2,3,2,2", "2,7"]) },
    { digits: (d) => /^0[1-9]\d{8}$/.test(d), groups: new Set(["2,8", "3,7", "3,3,4", "2,4,4"]) },
    { digits: (d) => /^[6-9]\d{8}$/.test(d), groups: new Set(["3,2,2,2", "2,3,2,2", "3,3,3"]) },
    { digits: (d) => /^(?:0[1-9]|3\d)\d{8}$/.test(d), groups: new Set(["2,4,4", "2,3,5", "3,3,4", "3,4,3"]) },
  ];
  // A version, a secret or a remote-access code, not a phone.
  const CODE_WORDS = [
    "version|password|passcode|pin|secret|token|credential",
    String.raw`anydesk\s+code|remote\s+access\s+code|c[oó]digo\s+de\s+anydesk|api[\s_-]*key`,
  ].join("|");
  const EUROPEAN_NUMBER_LABEL_BEFORE = new RegExp(
    String.raw`(?<![\p{L}])(?:${CODE_WORDS})(?![\p{L}])[^\d\n]{0,25}$`,
    "iu",
  );

  function europeanNationalPhone(text, run) {
    const digits = digitsOf(run.groups);
    if (![9, 10, 11, 12].includes(digits.length)) return false;
    if (hasNumberWord(run.groups) || labelledAsOther(text, run) || ssnLabelBefore(text, run)) return false;

    const start = run.units[0].start;
    const before = text.slice(Math.max(0, start - 30), start);
    if (EUROPEAN_NUMBER_LABEL_BEFORE.test(before) && !phoneWordIn(before)) return false;

    const sizes = numberGroupSizes(run.groups);
    const grouped = /[ .-]/.test(spanText(text, run.groups)) && !commaSplit(text, run.groups);
    const phoneWord = PHONE_CONTEXT.test(before);
    return EUROPEAN_NATIONAL_FORMATS.some(
      (format) => format.digits(digits) && ((grouped && format.groups.has(sizes)) || phoneWord),
    );
  }

  // ---------- Labels, codes and machine output ----------

  // ── Numbers labelled as something else ─────────────

  // "Order #445-2231987", "meeting ID is 845 2931 7710". The label can sit a few words back,
  // but a phone word close by wins ("about the order, call me at …").
  const OTHER_NUMBER_WORDS = [
    String.raw`order|invoice|ticket|case|ref(?:erence)?|tracking|confirmation|booking|reservation|meeting|claim`,
    String.raw`serial|model|part|sku|po`,
    // Spanish
    String.raw`pedido|factura|referencia|reuni[oó]n|reserva|localizador`,
    // Health and tax IDs
    String.raw`nhs|medicare|aadhaar|aadhar|tfn|tax\s+file`,
    // Bank accounts and routing numbers
    String.raw`clabe|cbu|cvu|cci|iban|n[uú]mero\s+de\s+ruta|ruta\s+bancaria`,
    // A machine's ID
    String.raw`(?:request|transaction|trace|session|correlation|device)[\s_-]*id`,
  ].join("|");
  const OTHER_NUMBER_BEFORE = new RegExp(
    String.raw`(?:#\s*$|(?<![\p{L}])(?:${OTHER_NUMBER_WORDS})(?![\p{L}])[^\d\n]{0,25}$)`,
    "iu",
  );

  // The same labels in other languages count only right before the number, with at most a number word
  // and a colon between. Stems share letters with everyday words ("Bestellung angekommen, erreichbar
  // unter …"), and a plural or compound names a phone line ("Reservations: …", "Bestellhotline: …").
  // "予約：…" is the line to call, so most Chinese and Japanese labels need their number word.
  // Words with an everyday sense ("envío", "suivi") need one too ("numéro de suivi").
  const REF_WORDS = [
    String.raw`bestellung|rechnung|auftrags(?:nummer|nr)|sendung|buchung|vorgang|ticketn(?:ummer|r)`, // German
    String.raw`kunden(?:nummer|nr)|aktenzeichen|artikelnummer|lieferschein`,
    String.raw`commande|facture|factura|r[ée]servation|r[ée]f[ée]rence|colis`, // French
    String.raw`encomenda|fatura|nota\s+fiscal|rastreio|rastreamento|protocolo|boleto`, // Portuguese
    String.raw`albar[aá]n`, // Spanish
    String.raw`ordine|fattura|prenotazione`, // Italian
    String.raw`pnr`,
    String.raw`ऑर्डर|ट्रैकिंग|इनवॉइस|बिल\s+नंबर|टिकट|रसीद`, // Hindi
  ].join("|");
  // "Bestellnummer", "Rechnungsnr.": up to four letters between, but not a fax or phone line ("Bestellfaxnr.").
  const REF_STEMS = "bestell|rechnung|sendung|buchung|vorgang|lieferschein";
  const REF_COMPOUND = String.raw`(?:${REF_STEMS})(?:(?!fax|tel|ruf)\p{L}){0,4}(?:nummer|nr\.?)`;
  // "número de seguimiento", "numéro de suivi", "codice pratica": a number word, then what it's the number of.
  const REF_NUMBER_FIRST = String.raw`(?:n[uú]mero|num[ée]ro|numero|n[º°]|c[oó]digo|codice)`;
  const REF_OF = String.raw`(?:(?:de|di|do|da|du|del|della)[^\S\n]+)?`;
  const REF_OF_WHAT = [
    "suivi|seguimiento|env[ií]o|gu[ií]a|cliente|client|socio|dossier|billet|pratica|spedizione",
    "tracking|rastreio|rastreamento|ordine|pedido|commande|prenotazione|protocolo|r[ée]servation",
  ].join("|");
  const REF_AFTER_NUMBER_WORD = String.raw`${REF_NUMBER_FIRST}[^\S\n]*${REF_OF}(?:${REF_OF_WHAT})`;
  const REF_GLUED = String.raw`注文|予約|問い?合わ?せ|追跡|伝票|請求|会员|會員|订单|訂單|运单|運單|快递|快遞|发票|發票|预订|預訂|工单|物流单|物流單`;
  const REF_GLUED_BARE = String.raw`伝票|运单|運單`;
  const REF_NUMBER_WORD = String.raw`(?:n[º°o]|n\.|nr|no|num\p{L}*|number|nummer|id|नंबर|आईडी|संख्या)`;
  const REF_GLUED_NUMBER_WORD = String.raw`(?:号码|號碼|番号|编号|編號|号|號|码|碼)`;
  const REF_SEP = String.raw`[^\S\n]{0,3}[:：#№=]?[^\S\n]{0,3}`;
  const REF_WORD_END = String.raw`(?![\p{L}\p{M}])`;
  const REF_RIGHT_BEFORE = new RegExp(
    String.raw`(?:` +
      String.raw`(?<![\p{L}])(?:${REF_WORDS})${REF_WORD_END}(?:${REF_SEP}(?:${REF_NUMBER_WORD}|n)\.?)?` +
      String.raw`|(?<![\p{L}])${REF_AFTER_NUMBER_WORD}` +
      // "billet de train n°"
      String.raw`|(?<![\p{L}])billet(?:[^\S\n]+(?:de[^\S\n]+|d['’])\p{L}+)?${REF_SEP}n[º°o]\.?` +
      String.raw`|${REF_GLUED_BARE}` +
      String.raw`)${REF_SEP}$`,
    "iu",
  );
  // A label with "number" in a word of its own ("Aktenzeichen", "Kundennummer") can sit a few words back,
  // as in "Mein Aktenzeichen beim Amt ist …".
  const NUMBER_LABEL_STEMS =
    "bestell|rechnungs?|auftrags|sendungs|buchungs|vorgangs|kunden|artikel|ticket|lieferschein";
  const REF_NUMBER_LABEL_BEFORE = new RegExp(
    String.raw`(?:(?<![\p{L}])(?:aktenzeichen|(?:${NUMBER_LABEL_STEMS})(?:nummer|nr)|nota[^\S\n]+fiscal)` +
      String.raw`|(?<![\p{L}])${REF_AFTER_NUMBER_WORD})(?![\p{L}])[^\d\n]{0,25}$`,
    "iu",
  );
  // A label that says "number" outright ("Bestellnummer", "commande n°", "注文番号", "رقم الطلب") wins even
  // over a phone word further back, as in "请联系客服，订单号 …". "बुकिंग" (booking) needs its number word.
  const REF_NAMED = [
    String.raw`(?<![\p{L}])${REF_COMPOUND}`,
    String.raw`(?<![\p{L}])(?:${REF_WORDS}|बुकिंग)${REF_WORD_END}${REF_SEP}(?:${REF_NUMBER_WORD}|n)\.?`,
    String.raw`(?<![\p{L}])${REF_AFTER_NUMBER_WORD}`,
    String.raw`(?:${REF_GLUED})${REF_GLUED_NUMBER_WORD}`,
    "会員番号|受付番号|管理番号|整理番号|单号|單號",
    String.raw`رقم[^\S\n]+(?:ال)?(?:طلب|فاتورة|حجز|شحنة|تتبع|تذكرة|عضوية)`,
  ].join("|");
  const REF_NAMED_RIGHT_BEFORE = new RegExp(String.raw`(?:${REF_NAMED})${REF_SEP}$`, "iu");
  // Wins over a phone word too: a German Zoom invite says "Über Telefon beitreten, Meeting-ID: …".
  const MEETING_WORDS = String.raw`meeting|besprechungs?|konferenz|webinar|r[ée]union|reuni[oó]n|reuni[aã]o|riunione`;
  const MEETING_ID_RIGHT_BEFORE = new RegExp(
    String.raw`(?:` +
      // "Meeting-ID", "Besprechungsnummer"
      String.raw`(?<![\p{L}])(?:${MEETING_WORDS})[\s_-]*(?:id|nummer|kennung|number|no\.?|#)` +
      // "ID de la reunión", "ID da reunião", "ID della riunione"
      String.raw`|(?<![\p{L}])id[^\S\n]+(?:de[^\S\n]+(?:la[^\S\n]+)?(?:reuni[oó]n|r[ée]union)` +
      String.raw`|da[^\S\n]+reuni[aã]o|(?:della[^\S\n]+)?riunione)` +
      String.raw`|会议号|會議號|会议ID|會議ID|ミーティングID|ミーティング番号` +
      String.raw`)${REF_SEP}$`,
    "iu",
  );

  // Phone words, one language a line. Whole words only, so "mobility", "Mobilfunk" and "Handyman" don't count.
  const PHONE_WORDS = [
    String.raw`call|ring|text|phone|mobile|cell|whatsapp|tel`, // English
    String.raw`ll[aá]m\p{L}*|tel[eé]fono|m[oó]vil|celular`, // Spanish
    // "my contact": "mis contactos", "meus contatos", "contacto:"
    String.raw`(?:mis?|mi[ao]s?|meus?|minhas?|nuestros?|nossos?|tus?|teus?|su|seus?)[^\S\n]+contac?t[oa]s?`,
    String.raw`contac?t[oa]s?"?[^\S\n]*:`,
    String.raw`telefone|lig(?:ue|ar|a-me|ue-me)`, // Portuguese
    // German. "Telefonie" isn't a phone, and "Ruf des Hauses" isn't "ruf mich an".
    String.raw`telefon(?!ie(?![\p{L}]))\p{L}*|rufnummer|anruf(?:e[nt]?|st)?`,
    String.raw`ruf(?:e|t|en)|ruf[^\S\n]+(?:mich|uns|doch|einfach|an)`,
    String.raw`mobil(?:nummer|nr|telefon|funknummer)?|erreichbar(?:[^\S\n]+unter|[^\S\n]*:)`,
    String.raw`t[ée]l[ée]phon(?:e[drz]?|ons|ique(?:ment)?)?|t[ée]l|appel(?:le[rz]?|ez|ons)`, // French
    String.raw`(?:mon|ton|son|votre)[^\S\n]+portable|portable[^\S\n]*:|joignable(?:[^\S\n]+(?:au|sur|par)|[^\S\n]*:)`,
    // Italian. "mi chiamo" is "my name is".
    String.raw`(?<!(?<![\p{L}])mi[^\S\n]+)chiamo|(?<!(?<![\p{L}])si[^\S\n]+)chiam(?:a(?:mi|ci|re|teci|te)?)`,
    String.raw`telefono|cellulare`,
    String.raw`फ़ोन|फोन|मोबाइल|कॉल`, // Hindi
  ].join("|");
  // Chinese, Japanese and Arabic words sit right against the number, so no word edges.
  const PHONE_WORDS_GLUED = [
    String.raw`電話|携帯|ケータイ|連絡|問い合わせ先|お?問い?合わ?せ`, // Japanese
    String.raw`电话|手机|手機|致电|联系|聯繫|聯絡|联络|打我`, // Chinese
    String.raw`هاتف|جوال|موبايل|اتصل|اتصال`, // Arabic
  ].join("|");
  const PHONE_WORD_ANY_CASE = new RegExp(
    String.raw`(?<![\p{L}])(?:${PHONE_WORDS})(?![\p{L}])|${PHONE_WORDS_GLUED}`,
    "iu",
  );
  // German "Handy" ("Handynummer", "Handy: …"), not "keep your order number handy".
  const HANDY_WORD = /(?<![\p{L}])Handy(?!m[ae]n(?![\p{L}]))(?:\p{L}+|[^\S\n]*(?:Nr\.?|Nummer|:))/u;
  // "Mio numero: …", "Mon n° : …", but not the label's own number in "mi número de pedido".
  const MY_WORD = String.raw`(?:my|mi|mon|ma|mio|meu|minha|mein\p{L}*)`;
  const NUMBER_NOUN = String.raw`(?:number|n[uú]mero|num[ée]ro|numero|nummer|n[º°]|no\.)`;
  const NOT_NUMBER_OF = String.raw`(?![^\S\n]+(?:de|di|do|da|du|of|des|del|della)(?![\p{L}]))`;
  const MY_NUMBER = new RegExp(
    String.raw`(?<![\p{L}])${MY_WORD}[^\S\n]+${NUMBER_NOUN}(?![\p{L}])${NOT_NUMBER_OF}`,
    "iu",
  );
  // Too common to beat an order label, but they beat a version word or a long decimal.
  const CONTACT_WORD = /(?<![\p{L}])(?:contact|number|reach|sms)(?![\p{L}])/iu;

  function phoneWordIn(before) {
    return PHONE_WORD_ANY_CASE.test(before) || HANDY_WORD.test(before) || MY_NUMBER.test(before);
  }

  function saysPhone(before) {
    return phoneWordIn(before) || CONTACT_WORD.test(before);
  }

  // "número de matrícula 2019630123", "plate number 555 1234".
  const STUDENT_LABELS = [
    String.raw`\bstudent[\s-]*(?:id|number|no\.?|#|card)|\bschool[\s-]*id|\bmatric(?:ulation)?\s+(?:number|no\.?|#)`,
    String.raw`(?<![\p{L}])matr[ií]cula|(?<![\p{L}])(?:de\s+(?:estudiante|alumn[oa])|c[oó]digo\s+estudiantil)`,
  ].join("|");
  const PLATE_LABELS = [
    String.raw`\blicen[cs]e[\s-]+plates?|\b(?:number|reg(?:istration)?)\s+plates?|\bplates?\s*(?:number|no\.?|#)`,
    String.raw`\brego|(?<![\p{L}])(?:placas?|patente)`,
  ].join("|");
  const STUDENT_LABEL_BEFORE = new RegExp(
    String.raw`(?:${STUDENT_LABELS}|${PLATE_LABELS})\s*(?:[:#=]|is|was|es|son|era)?\s*$`,
    "iu",
  );
  const SID_BEFORE = /(?<![\p{L}\d])SID(?:\s*(?:number|no\.?|num|#))?\s*(?:[:#]|is|was)?\s*$/u;
  // "versionCode 2024010100", "commit 7475674945".
  const VERSION_NUMBER_BEFORE =
    /(?<![\p{L}])(?:build|version(?:[\s_-]*(?:code|number|no\.?))?|commit|revision|rev)["']?[\s"':=#]*$/iu;
  // "/actions/runs/7002003507/job/…", "/pull/…".
  const CI_PATH_WORDS = [
    "runs|jobs?|builds?|pipelines?|attempts|artifacts|check-runs|check-suites|deployments|workflows",
    "issues|pulls?|merge_requests|commits?",
  ].join("|");
  const CI_PATH_BEFORE = new RegExp(String.raw`\/(?:${CI_PATH_WORDS})\/$`, "i");

  // No order or tracking number starts with "+", so a dialled phone gets past the reference labels:
  // "Kundennummer +49 …", or "plus 49 151 …" (a country code never starts with 0).
  function dialledBefore(text, start, before) {
    if (/\+[^\S\n]*$/.test(before)) return true;
    return /(?<![\p{L}])plus[^\S\n]+$/iu.test(before) && text[start] !== "0";
  }

  function otherLabelBefore(before, dialled) {
    if (OTHER_NUMBER_BEFORE.test(before)) return true;
    if (dialled) return false;
    return REF_RIGHT_BEFORE.test(before) || REF_NUMBER_LABEL_BEFORE.test(before);
  }

  // A build or version number is one unbroken string. A phone has spaces or dashes in it.
  function versionNumber(text, run, before) {
    if (!VERSION_NUMBER_BEFORE.test(before)) return false;
    // The label's own "number" ("version number 2024010100") isn't a phone word.
    if (saysPhone(before.replace(VERSION_NUMBER_BEFORE, ""))) return false;
    const number = text.slice(run.units[0].start, lastItem(run.units).end);
    return !/[^\d.]/.test(number);
  }

  function labelledAsOther(text, run) {
    const start = run.units[0].start;
    const before = text.slice(Math.max(0, start - 40), start);
    const dialled = dialledBefore(text, start, before);
    if (otherLabelBefore(before, dialled) && !phoneWordIn(before)) return true;
    // These win even over a phone word close by.
    if (!dialled && REF_NAMED_RIGHT_BEFORE.test(before)) return true;
    if (MEETING_ID_RIGHT_BEFORE.test(before)) return true;
    if (versionNumber(text, run, before)) return true;
    if (CI_PATH_BEFORE.test(before)) return true;
    if (STUDENT_LABEL_BEFORE.test(before)) return true;
    if (ACCOUNT_NAME_BEFORE.test(before)) return true;
    if (SID_BEFORE.test(before)) return true;
    return checkedAccountAt(text, run);
  }

  // ── Codes that hold a phone's digits ───────────────

  // "NDC 0093-7146-56" would read as "00" plus a country code. NDC codes are 4-4-2, 5-3-2, 5-4-1,
  // or 11 digits as 5-4-2. Any other shape after "NDC" is still read as a phone.
  const NDC_BEFORE = /(?<![\p{L}])NDC(?:\s*(?:code|number|no\.?|#))?\s*(?:[:=]|is)?\s*$/iu;
  const NDC_SHAPES = new Set(["4,4,2", "5,3,2", "5,4,1", "5,4,2", "10", "11"]);

  function ndcCode(text, run) {
    if (!NDC_SHAPES.has(numberGroupSizes(run.groups))) return false;
    const start = run.units[0].start;
    return NDC_BEFORE.test(text.slice(Math.max(0, start - 20), start));
  }

  // "1HGCM82633A004352 2003" is a VIN and its year side by side in a spreadsheet, not "004352 2003".
  function inVinCode(text, at) {
    const back = /[A-Z\d]{0,17}$/.exec(text.slice(Math.max(0, at - 17), at))[0].length;
    const codeStart = at - back;
    if (/[A-Za-z\d]/.test(text[codeStart - 1] || "")) return false;
    const code = /^[A-Z\d]*/.exec(text.slice(codeStart, codeStart + 18))[0];
    if (code.length !== 17) return false;
    return /^[A-HJ-NPR-Z\d]{13}\d{4}$/.test(code) && /[A-Z].*[A-Z]/.test(code);
  }

  // A Windows security ID always starts "S-1-": "S-1-5-21-3623811015-3361044348-30300820-1013".
  function windowsSid(text, run) {
    const first = run.groups[0];
    if (first.length !== 1 || first[0].digits !== "1") return false;
    const start = run.units[0].start;
    return /(?<![\p{L}\d])S-$/u.test(text.slice(Math.max(0, start - 3), start));
  }

  // ── Machine output: logs, versions, metrics ────────

  // Date and clock digits side by side can look like a phone.
  const TIME_KEYS = "@timestamp|ts|timestamp|time|created_at|createdAt|eventTime|timeCreated";
  const LOG_TIMESTAMP_PATTERNS = [
    /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/gi,
    /\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\]/g,
    /\b[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:AM|PM)\b/gi,
    /\b\d{2}:\d{2}:\d{2}\.\d{3,}\b/g,
    // A log's time key, then a Unix time in seconds or milliseconds.
    new RegExp(String.raw`(?<![\w-])["']?(?:${TIME_KEYS})["']?\s*:\s*["']?(\d{10}(?:\d{3})?)["']?`, "gi"),
    /\b(?:took|lasted|duration|elapsed)(?:\s+(?:for|of))?\s+(\d+(?:\.\d+)?)\s*(?:ms|milliseconds?)\b/gi,
  ];
  // Numbers a machine prints with a phone's digit count.
  const MACHINE_NUMBER_PATTERNS = [
    /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\s+\d{1,2}:\d{2}\b/g, // "25/02/2026 11:52"
    /\bHTTP\/\d(?:\.\d)?"\s+(\d{3}\s+\d{1,12})\b/g, // a web log's status and size
    /^[ \t]*Merge:[ \t]+([0-9a-f]{7,40}(?:[ \t]+[0-9a-f]{7,40})+)$/gm,
    /\b\d{1,2}:\d{2}:\d{2}\s+\d{4}\s+[+-]\d{4}\b/g, // git's "21:24:38 2026 +0000"
    /(?<![\w-])[A-Za-z][\w-]{0,40}\/(\d+(?:\.\d+){2,})(?![\d.])/g, // "Chrome/131.0.6778.205"
    /^\[\s*(\d{1,7}\.\d{6})\]/gm, // a kernel log's "[12345.678901]"
    /(?<![\d.])(\d{7,}(?:\.\d+)?)\s*(?:ns|µs|us|ms|nanoseconds?|microseconds?|milliseconds?|bytes|cycles|ticks)\b/g,
    /(?<![\d.-])(?:2147483647|2147483648|4294967295|4294967296)(?![\d.-])/g,
    /(?<![\d.])\d{2,3}\.0\.\d{4}\.\d{1,3}(?![\d.])/g, // "Google Chrome 131.0.6778.205"
    /(?<![\d.])20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\.\d{1,3}(?![\d.])/g, // "Build 20240130.10"
    // A git range ("2147a04..1355673", maybe with a file mode after). It needs a hex letter:
    // two plain numbers joined by dots can be two phones.
    new RegExp(
      String.raw`(?<![0-9A-Za-z.])(?=[0-9a-f.]{0,83}[a-f])[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}(?![0-9A-Za-z.])` +
        String.raw`(?: [0-7]{6}(?![\w.]))?`,
      "g",
    ),
    /(?<![0-9A-Za-z])_?G[AS]\d\.\d\.\d+\.\d+/g, // a Google Analytics cookie
    /(?<![0-9A-Za-z])[if](?:32|64)\.const\s+-?\d+/g, // WebAssembly "i32.const 4155550134"
  ];
  // A Prometheus line: a name with labels or a unit ending, its value, maybe a time. A name that says
  // phone or contact holds one. The word stands alone, since "telemetry" and "cellular" start the same.
  const METRIC_ENDINGS = "total|count|sum|bucket|bytes|seconds|info|created|ratio|size|max|min|current|limit|usage";
  const METRIC_NAME = String.raw`[A-Za-z_:][\w:]*(?:\{[^}\n]{0,300}\}|_(?:${METRIC_ENDINGS}))`;
  const METRIC_VALUE = String.raw`-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:[ \t]+\d{10,13})?`;
  const METRIC_LINE = new RegExp(String.raw`^(${METRIC_NAME}[ \t]+)(${METRIC_VALUE})[ \t]*\r?$`, "gm");
  const PHONE_METRIC_WORD = /(?<![A-Za-z])(?:phone|mobile|cell|tel|contact|whatsapp|sms)(?![a-z])/i;
  // "loss: 0.8912116821" is a measurement. "1.4155550134" is a WHOIS phone without its "+", so never.
  const LONG_DECIMAL = /(?<![\d.+])(?!1\.\d{10}(?![\d.]))\d\.\d{7,}(?![\d.])/g;
  const NUMBER_LIST = /\[\s*\d+(?:\s*,\s*\d+)+\s*,?\s*\]/g;
  const LIST_OF_PHONES = /(?:phone|mobile|cell|tel|contact|number|whatsapp|sms|call)[^[\n]{0,30}$/i;
  const UUID_SHAPE = /(?<![a-z0-9])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![a-z0-9])/gi;
  // A GPG or SSH fingerprint: five or more groups of four hex characters, with a hex letter somewhere.
  const HEX_GROUP_RUN = /(?<![0-9A-Za-z])[0-9A-Fa-f]{4}(?:[ ]{1,2}[0-9A-Fa-f]{4}){4,}(?![0-9A-Za-z])/g;

  function inHexGroups(text, start, end) {
    const from = Math.max(0, start - 60);
    const nearby = text.slice(from, Math.min(text.length, end + 60));
    for (const match of nearby.matchAll(HEX_GROUP_RUN)) {
      const runStart = from + match.index;
      if (runStart <= start && runStart + match[0].length >= end && /[A-Fa-f]/.test(match[0])) return true;
    }
    return false;
  }

  // A pattern's first group, when it has one, is the part that counts.
  function matchedValue(match) {
    return match[1] || match[0];
  }

  function matchedStart(match) {
    return match.index + (match[1] ? match[0].indexOf(match[1]) : 0);
  }

  // An epoch field counts as a time only between 2001 and 2036, so "any time: 5558675309" stays a phone.
  function outsideEpochYears(value) {
    if (/^\d{10}$/.test(value)) return value < "1000000000" || value > "2100000000";
    if (/^\d{13}$/.test(value)) return value < "1000000000000" || value > "2100000000000";
    return false;
  }

  function addTimestamps(text, ranges) {
    for (const pattern of LOG_TIMESTAMP_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const value = matchedValue(match);
        if (outsideEpochYears(value)) continue;
        const start = matchedStart(match);
        ranges.push([start, start + value.length]);
      }
    }
  }

  function addMachineNumbers(text, ranges) {
    for (const pattern of MACHINE_NUMBER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const start = matchedStart(match);
        ranges.push([start, start + matchedValue(match).length]);
      }
    }
  }

  function addMetricValues(text, ranges) {
    for (const match of text.matchAll(METRIC_LINE)) {
      if (PHONE_METRIC_WORD.test(match[1])) continue;
      const start = match.index + match[1].length;
      ranges.push([start, start + match[2].length]);
    }
  }

  // A numbered list typed without a space ("2.6505550199" at a line's start or after a comma) is a phone.
  function numberedListItem(text, match) {
    if (!/^[1-9]\.\d{10}$/.test(match[0])) return false;
    const lead = text.slice(Math.max(0, match.index - 20), match.index);
    if (/[\n,;][ \t]*$/.test(lead)) return true;
    return match.index <= 20 && /^[ \t]*$/.test(lead);
  }

  function addLongDecimals(text, ranges) {
    for (const match of text.matchAll(LONG_DECIMAL)) {
      if (numberedListItem(text, match)) continue;
      if (saysPhone(text.slice(Math.max(0, match.index - 40), match.index))) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // A list of numbers in code is data, unless a phone word names it.
  function addCodeLists(text, ranges) {
    for (const match of text.matchAll(NUMBER_LIST)) {
      if (LIST_OF_PHONES.test(text.slice(Math.max(0, match.index - 40), match.index))) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  function logTimestampRanges(text) {
    const ranges = [];
    addTimestamps(text, ranges);
    addMachineNumbers(text, ranges);
    addMetricValues(text, ranges);
    addLongDecimals(text, ranges);
    addCodeLists(text, ranges);
    return ranges;
  }

  // Asks "is [start, end] inside one of these ranges?" with a binary search, so a paste with a range on
  // every line costs a few steps per number. Each sorted range keeps the furthest end reached so far.
  function rangeLookup(ranges) {
    ranges.sort((a, b) => a[0] - b[0]);
    const begins = ranges.map((range) => range[0]);
    const reach = [];
    let furthest = -1;
    for (const [, finish] of ranges) {
      furthest = Math.max(furthest, finish);
      reach.push(furthest);
    }
    return (start, end) => {
      let lo = 0;
      let hi = begins.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (begins[mid] <= start) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 && reach[lo - 1] >= end;
    };
  }

  // ---------- Wrapped lines, amounts and counts ----------

  // ── Numbers wrapped over lines ─────────────────────

  // A phone or SSN wrapped over two or three lines by a narrow window or a quoted reply ("> ").
  // Only right under its own label, since short numbers one to a line are usually a list,
  // and "Mobile breakpoints:" over a column of numbers doesn't count.
  // One line's digits: a group of 2 to 4, maybe a second one after a space or a dash.
  const LINE_DIGITS = String.raw`\d{2,4}(?:[ -]\d{2,4})?`;
  // A quoted reply's "> " marks, up to three deep.
  const REPLY_MARKS = String.raw`(?:>[^\S\n]?){0,3}`;
  const NEXT_LINE = String.raw`[^\S\n]{0,4}\r?\n[^\S\n]{0,4}${REPLY_MARKS}`;
  const NUMBER_LINES_RE = new RegExp(
    String.raw`(?<![\d.])${LINE_DIGITS}(?:${NEXT_LINE}${LINE_DIGITS}){1,2}(?![\d-])`,
    "g",
  );
  // The end of a label: "is", a colon or the like, and the reply marks of the next line.
  const LABEL_END = String.raw`(?:\s+(?:is|was))?[^\S\n]*[:#=-]?\s*${REPLY_MARKS}$`;
  const CALL_ME_AT = String.raw`\b(?:call|text|ring|reach)(?:\s+(?:me|us|him|her|them))?(?:\s+(?:at|on))?`;
  const PHONE_NUMBER_WORDS = String.raw`\b(?:phone|cell|mobile|whatsapp|tel)(?:\s+(?:number|no\.?|#))?`;
  const MY_PHONE_NUMBER = String.raw`\bmy\s+(?:phone\s+|cell\s+|mobile\s+)?number`;
  const PHONE_LABEL_NEAR = new RegExp(
    String.raw`(?:${CALL_ME_AT}|${PHONE_NUMBER_WORDS}|${MY_PHONE_NUMBER})${LABEL_END}`,
    "i",
  );
  const SSN_LABEL_NEAR = new RegExp(
    String.raw`(?:\bssn|\bsocial\s+security(?:\s+(?:number|no\.?|#))?)${LABEL_END}`,
    "i",
  );

  function wrappedNumbers(text, labelPattern) {
    const found = [];
    if (!/\d[^\S\n]*\r?\n/.test(text)) return found;
    for (const match of text.matchAll(NUMBER_LINES_RE)) {
      if (!labelPattern.test(text.slice(Math.max(0, match.index - 40), match.index))) continue;
      const pieces = match[0].match(/\d+/g);
      found.push({
        span: match[0],
        digits: pieces.join(""),
        sizes: pieces.map((piece) => piece.length).join(","),
        at: match.index,
      });
    }
    return found;
  }

  // ── Dates, amounts and counts ──────────────────────

  // Everyday numbers a phone's digits can be cut from. Looked for only near a candidate, so it stays linear.
  const ISBN_13 = /(?<![\d-])97[89]([- ])\d{1,5}\1\d{1,7}\1\d{1,7}\1\d(?![\d-])/g;
  const NOT_PHONE_NEAR = [
    /(?<![\d./-])(?:19|20)\d\d([-/.])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])(?!\d)/g, // "2025/03/22 22:04"
    /(?<![\d./-])(?:0?[1-9]|[12]\d|3[01])([-/.])(?:0?[1-9]|[12]\d|3[01])\1(?:19|20)\d\d(?!\d)/g, // "22.04.2026 07 Uhr"
    /(?<![\d./-])(?:19|20)\d\d([-/.])(?:0[1-9]|1[0-2])\1\d{3,8}(?!\d)/g, // "Rechnung 2025-10-0471"
    ISBN_13, // "978-99-574-6437-8"
    /(?<![\d.,])\d{1,3}([.,' ])\d{3}(?:\1\d{3})*(?!\1)[.,]\d{1,2}(?!\d)/g, // "23.392.382,41"
  ];
  const NOT_PHONE_WINDOW = 40;

  function partOfOtherNumber(text, start, end) {
    const from = Math.max(0, start - NOT_PHONE_WINDOW);
    const nearby = text.slice(from, Math.min(text.length, end + NOT_PHONE_WINDOW));
    // A match at the window's cut edge may be the tail of a longer number.
    const cut = from > 0 && /[\d./,-]/.test(text[from - 1]);
    for (const pattern of NOT_PHONE_NEAR) {
      for (const match of nearby.matchAll(pattern)) {
        if (cut && match.index === 0) continue;
        if (pattern === ISBN_13 && match[0].replace(/\D/g, "").length !== 13) continue;
        const at = from + match.index;
        if (at < end && at + match[0].length > start) return true;
      }
    }
    return false;
  }

  // "610.692.216 Fahrgäste", "31,882,049人". A currency sign doesn't count when it belongs to the amount
  // before, starts the next one, or sits across a tab in a spreadsheet row. A Chinese or Japanese counter
  // counts only glued to the digits, not as the start of a longer word ("名古屋", "件名").
  const CURRENCY_SIGNS = "[€$£¥₹₩₽]";
  const CURRENCY_CODES = "CHF|EUR|USD|GBP|BRL|MXN|INR|JPY|CNY|RMB|SAR|AED";
  const AMOUNT_BEFORE = new RegExp(
    String.raw`(?<![\d.,][^\S\n]?)(?:${CURRENCY_SIGNS}|R\$|US\$|Rs\.?` +
      String.raw`|(?<![\p{L}])(?:${CURRENCY_CODES}))[ \u00a0\u202f]?$`,
    "u",
  );
  const AMOUNT_LOOK = 10;
  // Words that say what a number counts.
  const COUNTED_WORDS = [
    // Money
    String.raw`euros?|reais|pesos|d[oó]lares|dollars?|francs?|franken|yuan|yen|rupees?|rupias?|libras|livres`,
    // Sizes and weights
    String.raw`km|km²|m²|kg|toneladas|tonnes|tonnen|tons|litros|litres|liter`,
    // People
    String.raw`habitantes|habitants|einwohner\p{L}*|inhabitants|residents|personas|personnes|pessoas|menschen|people`,
    // Visitors and passengers
    String.raw`visitantes|visiteurs|besucher\p{L}*|visitors|espectadores|spectateurs|zuschauer\p{L}*`,
    String.raw`torcedores|fahrg[äa]st\p{L}*|passageiros|passagers|pasajeros|passengers`,
    // Votes
    String.raw`votos|voix|stimmen|votes`,
    // Units and copies
    String.raw`unidades|unit[ée]s|einheiten|units|ejemplares|exemplaires|exemplares|exemplare|copies`,
    // Members, users, followers
    String.raw`miembros|membres|membros|mitglieder|members|usuarios|usu[áa]rios`,
    String.raw`utilisateurs|nutzer\p{L}*|users|seguidores|abonn[ée]s|follower\p{L}*`,
    // Views and downloads
    String.raw`views|vues|visualiza\p{L}*|aufrufe|downloads|descargas|t[ée]l[ée]chargements`,
  ].join("|");
  // A currency after the number, unless it starts the next amount.
  const CURRENCY_AFTER = String.raw`(?:${CURRENCY_SIGNS}|(?:${CURRENCY_CODES})(?![\p{L}]))(?![^\S\n]?\d)`;
  // Dollars, euros, rupees, people and visitors in Japanese, Hindi and Arabic.
  const OTHER_COUNTED = "ドル|ユーロ|रुपये|रुपए|लोग|ريال|درهم|جنيه|دولار|نسمة|زائر|متفرج|شخص";
  const COUNTERS = String.raw`(?:円|元|人次?|万[人円元件]?|億[人円元]?|亿[人元]?|件|個|个|名様?|票)(?!\p{Script=Han})`;
  const COUNTED_AFTER = new RegExp(
    String.raw`^(?:[ \u00a0\u202f]?(?:${CURRENCY_AFTER}` +
      String.raw`|(?:${COUNTED_WORDS})(?![\p{L}])|${OTHER_COUNTED})|${COUNTERS})`,
    "iu",
  );

  // A phone word right before still wins.
  function amountOrCount(text, start, end) {
    const amount = AMOUNT_BEFORE.test(text.slice(Math.max(0, start - AMOUNT_LOOK), start));
    if (!amount && !COUNTED_AFTER.test(text.slice(end, end + 30))) return false;
    return !phoneWordIn(text.slice(Math.max(0, start - 30), start));
  }

  // "Linhas 681, 646, 943" is a list, not one phone. A phone word before still wins
  // ("call me at 202, 555, 0136"), and so does a spelled-out number.
  function commaSplit(text, span) {
    if (hasNumberWord(span)) return false;
    return span.some((_, i) => i > 0 && gapBefore(text, span, i).includes(","));
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    localPhone,
    europeanNationalPhone,
    REF_GLUED_NUMBER_WORD,
    REF_SEP,
    REF_WORD_END,
    labelledAsOther,
    ndcCode,
    inVinCode,
    windowsSid,
    UUID_SHAPE,
    inHexGroups,
    logTimestampRanges,
    rangeLookup,
    PHONE_LABEL_NEAR,
    SSN_LABEL_NEAR,
    wrappedNumbers,
    partOfOtherNumber,
    amountOrCount,
    commaSplit,
  };
})();

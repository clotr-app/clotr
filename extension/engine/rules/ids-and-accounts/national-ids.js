// findNationalIds(): national ID and tax numbers by their label, on their own or under a column name, from
// the US to the EU and Asia. national-id-check-digits.js says whether each one is real.
(() => {
  "use strict";

  const {
    validLuhn,
    NUMBER_WORDS,
    SOUND_ALIKES,
    TYPO_WORDS,
    isLetter,
    readTypo,
    lastItem,
    digitsOf,
    hasNumberWord,
    readNumberRuns,
    numberAfter,
    ID_VALUE_END,
    idLabel,
    labelledId,
    acronymId,
    PPS_LABELLED,
    PPS_BARE,
    ppsValid,
    IRD_LABELLED,
    irdValid,
    NHI_LABELLED,
    NHI_BARE,
    nhiValid,
    CPF_VALUE,
    CNPJ_VALUE,
    CPF_LABELLED,
    CNPJ_LABELLED,
    CPF_DOTTED,
    CNPJ_DOTTED,
    cpfValid,
    cnpjValid,
    PAN_VALUE,
    PAN_LABELLED,
    panValid,
    NIR_VALUE,
    NIR_LABELLED,
    NIR_SPACED,
    nirValid,
    BSN_VALUE,
    BSN_LABELLED,
    bsnValid,
    PESEL_VALUE,
    PESEL_LABELLED,
    peselValid,
    CODICE_FISCALE_BARE,
    CODICE_FISCALE_LABELLED,
    codiceFiscaleValid,
    NRIC_BARE,
    nricValid,
    SA_ID_VALUE,
    SA_ID_LABELLED,
    southAfricanIdValid,
    STEUER_VALUE,
    STEUER_LABELLED,
    steuerIdValid,
    RRN_BARE,
    RRN_SHAPE,
    RRN_VALUE,
    RRN_LABELLED,
    rrnDated,
    rrnValid,
    MY_NUMBER_VALUE,
    MY_NUMBER_LABELLED,
    myNumberValid,
    CN_ID_BARE,
    CN_ID_SHAPE,
    chineseIdValid,
    BELGIAN_NUMBER_VALUE,
    belgianNumberValid,
    PERSONNUMMER_VALUE,
    personnummerValid,
    CPR_VALUE,
    cprValid,
    nanpShaped,
    cprNotAPhone,
    FODSELSNUMMER_VALUE,
    fodselsnummerValid,
    HETU_VALUE,
    hetuValid,
    KENNITALA_VALUE,
    kennitalaValid,
    PT_NIF_VALUE,
    ptNifValid,
    cnpValid,
    egnValid,
    RODNE_CISLO_VALUE,
    rodneCisloValid,
    oibValid,
    amkaValid,
    afmValid,
    AUSTRIAN_SVNR_VALUE,
    austrianSvnrValid,
    GERMAN_RVNR_VALUE,
    germanRvnrValid,
    isikukoodValid,
    PERSONAS_KODS_VALUE,
    personasKodsValid,
    emsoValid,
    TAJ_VALUE,
    tajValid,
    hungarianTaxIdValid,
    NIP_VALUE,
    nipValid,
    AADHAAR_LABELS,
    TFN_LABELS,
    aadhaarValid,
    tfnValid,
    spanishNationalIds,
    inHexGroups,
  } = globalThis.ClotrInternal;

  // ---------- IDs from the UK, Canada, Spain and Mexico ----------

  // ── UK and Canadian insurance numbers ─────────────

  // A UK National Insurance number has no check digit, so a bare match of its shape passes about 1 random
  // code in 11.5. It only counts with an NI word nearby, the same rule a bare card or phone number follows
  // (cardLabelNear, internationalPhone).
  const NINO_RE = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi;
  const NINO_WORD =
    /\bnational\s+insurance(?:\s+number)?\b|\bNINO\b|\bNI\s*(?:number|no\.?)\b|\bN\.I\.|\bseguro\s+nacional\b/i;

  function ninoLabelNear(text, index) {
    if (NINO_WORD.test(text.slice(Math.max(0, index - 40), index))) return true;
    return NINO_WORD.test(text.slice(index, index + 40));
  }

  // Canadian Social Insurance Number: 9 digits after a label, Luhn-valid.
  const SIN_LABELS = [/\b(?:SIN|social insurance(?:\s+number)?)(?:\s*(?:#|no\.?|number))?\s*(?:is\s*)?[:#-]?\s*/g];

  // ── Spain's DNI and NIE, Mexico's CURP ────────────
  // Spain: DNI (8 digits + check letter) and NIE (X/Y/Z + 7 digits + check letter). Mexico: CURP
  // (18 characters with a state code and a check digit). All validated, so ordinary codes stay quiet.

  const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
  // A digit, or a digit said out loud: its word, a word that sounds like it, or a typo of it.
  const SPOKEN_DIGIT_WORDS = [...Object.keys(NUMBER_WORDS), ...Object.keys(SOUND_ALIKES), ...Object.keys(TYPO_WORDS)];
  const SPOKEN_DIGIT_TOKEN = `(?:\\d|zoro|${SPOKEN_DIGIT_WORDS.sort().join("|")})`;
  const SPOKEN_DNI_CANDIDATE = new RegExp(
    String.raw`\b(?:[XYZ][\s-]*)?${SPOKEN_DIGIT_TOKEN}(?:[\s-]+${SPOKEN_DIGIT_TOKEN}){6,7}[\s-]*[A-HJ-NP-TV-Z]\b`,
    "i",
  );
  const DNI_RE = /\b(\d{8}|\d{1,3}(?:[- ]\d{1,3}){1,2})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const NIE_RE = /\b([XYZ])[- ]?(\d{7}|\d{1,3}(?:[- ]\d{1,3}){1,2})[- ]?([A-HJ-NP-TV-Z])\b/g;

  // A CURP's sex letter (H, M or X) and state code, then 3 consonants from the name.
  const CURP_STATES =
    "AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE";
  const CURP_STATE_AND_NAME = String.raw`[HMX](?:${CURP_STATES})[B-DF-HJ-NP-TV-Z]{3}`;
  const CURP_RE = new RegExp(String.raw`\b[A-Z][AEIOUX][A-Z]{2}\d(?:-?\d){5}${CURP_STATE_AND_NAME}[0-9A-Z]\d\b`, "g");
  // A CURP read out: 4 letters, the 6 date digits as words, the state and name letters, then the last two.
  const SPOKEN_CURP = new RegExp(
    String.raw`\b([A-Z][AEIOUX][A-Z]{2})` +
      String.raw`\s*(${SPOKEN_DIGIT_TOKEN}(?:[\s-]+${SPOKEN_DIGIT_TOKEN}){5})` +
      String.raw`\s*(${CURP_STATE_AND_NAME})` +
      String.raw`\s*(?:([A-Z])\s*(${SPOKEN_DIGIT_TOKEN})|(${SPOKEN_DIGIT_TOKEN})\s*(${SPOKEN_DIGIT_TOKEN}))\b`,
    "gi",
  );
  const CURP_CHARS = "0123456789ABCDEFGHIJKLMN\u00d1OPQRSTUVWXYZ";

  function curpValid(curp) {
    const normalized = curp.replace(/-/g, "");
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += CURP_CHARS.indexOf(normalized[i]) * (18 - i);
    return String((10 - (sum % 10)) % 10) === normalized[17];
  }

  function curpShaped(value) {
    CURP_RE.lastIndex = 0;
    const shaped = CURP_RE.test(value);
    CURP_RE.lastIndex = 0;
    return shaped;
  }

  // One spoken digit ("five", "cinco", a slip like "fiev") as its digit, or "" when it isn't one.
  function spokenDigit(token) {
    if (/^\d$/.test(token)) return token;
    const word = token.toLowerCase();
    return NUMBER_WORDS[word] || SOUND_ALIKES[word] || TYPO_WORDS[word] || readTypo(token, 0)?.digits || "";
  }

  // A DNI or NIE read out in words, with its check letter after.
  function spokenDniNie(text) {
    if (!SPOKEN_DNI_CANDIDATE.test(text)) return [];
    const found = [];
    for (const run of readNumberRuns(text, true)) {
      if (!hasNumberWord(run.groups)) continue;
      const digits = digitsOf(run.groups);
      const start = run.units[0].start;
      const end = lastItem(run.units).end;
      const check = /^\s*([A-HJ-NP-TV-Z])\b/.exec(text.slice(end));
      if (!check) continue;
      const checkLetter = check[1].toUpperCase();
      const checkEnd = end + check[0].length;
      const prefix = /([XYZ])[\s-]*$/i.exec(text.slice(Math.max(0, start - 4), start));
      const prefixStart = prefix ? start - prefix[0].length : start;
      const standalonePrefix = prefix && (prefixStart === 0 || !isLetter(text[prefixStart - 1]));
      if (standalonePrefix) {
        if (digits.length !== 7) continue;
        const value = Number("XYZ".indexOf(prefix[1].toUpperCase()) + Number(digits));
        if (DNI_LETTERS[value % 23] === checkLetter) found.push(text.slice(prefixStart, checkEnd));
        continue;
      }
      if (digits.length === 8 && DNI_LETTERS[Number(digits) % 23] === checkLetter) {
        found.push(text.slice(start, checkEnd));
      }
    }
    return found;
  }

  function spokenCurps(text) {
    const found = [];
    for (const match of text.matchAll(SPOKEN_CURP)) {
      const date = match[2]
        .split(/[\s-]+/)
        .map(spokenDigit)
        .join("");
      const check = match[4] || spokenDigit(match[6]);
      const last = spokenDigit(match[5] || match[7]);
      if (date.length !== 6 || !/^[A-Z0-9]$/.test(check) || !/^\d$/.test(last)) continue;
      const value = `${match[1]}${date}${match[3]}${check}${last}`.toUpperCase();
      if (curpShaped(value) && curpValid(value)) found.push(match[0]);
    }
    return found;
  }

  // ---------- Tax and EU numbers after a label ----------

  // ── Tax and social security numbers after a label ─
  // Mexico's RFC (a tax ID: 3 to 4 letters, a date, then 3 characters) and Spain's social security number
  // (12 digits) only count right after their label, since in English "RFC 7231" names an internet standard.

  const RFC_RE =
    /\bRFC\b(?:\s+(?:es|is))?\s*(?::\s*)?([A-ZÑ&]{3,4}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z0-9]{3})\b/giu;
  const NSS_RE = /(?:\bNSS\b|seguridad\s+social)[^\n\d]{0,20}?(\d{2}[\s/-]?\d{8}[\s/-]?\d{2})(?![\d])/giu;
  // A US ITIN, the tax number for people without an SSN, is shaped like an SSN but starts with 9 and has
  // its own middle ranges, so with its dashes or spaces it counts on its own. It has no check digit and 1 in
  // 23 nine-digit numbers fits those ranges, so like an SSN its bare digits only count right after its name
  // (US_ID_LABELLED), same as tax IDs, immigration numbers and VA file numbers below.
  const ITIN_RE = /\b9\d{2}[- ](?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])[- ]\d{4}\b/g;
  const US_ID_WORDS = [
    // Tax
    String.raw`ITIN|EIN|TIN|tax\s*(?:payer\s*)?id(?:entification)?(?:\s+number)?|employer\s+identification\s+number`,
    // Immigration
    String.raw`a-?number|alien\s+(?:registration\s+)?number|uscis\s*(?:number|#)`,
    String.raw`green\s+card(?:\s+(?:number|receipt))?`,
    // Veterans
    String.raw`va\s+(?:file|claim)\s+number`,
  ].join("|");
  const US_ID_LABELLED = new RegExp(
    String.raw`\b(?:${US_ID_WORDS})\s*(?:(?:#|no\.?|number)\s*)?(?:(?:is|:|=)\s*)?` +
      String.raw`((?:[A-Z]{1,3}[\s-]?)?\d(?:[\d-]{6,12})\d)(?![\d-])`,
    "gi",
  );

  // ── The EU and EEA labels ─────────────────────────
  // Each kind: its label as written in prose (`words`), the key or column name it goes by (split into lowercase
  // words), its value and check, and any short labels read only right before the value (`acronyms`: name, flags,
  // gap allowed after it, and a check of its own if it needs one). "personnummer" is the word in Sweden, Norway
  // and Denmark, so it leads to each of their checks. Two prose labels also head a table column as they are, read
  // by `columnKinds`.

  const BELGIAN_NATIONAL_WORDS = String.raw`num[ée]ro\s+national`;
  const RODNE_CISLO_SHORT_WORDS = String.raw`r\.\s?č\.`;

  function euIdKind({ words, key, value, ok, acronyms = [] }) {
    const shortLabels = acronyms.map(({ name, flags, gap, check = ok }) => [acronymId(name, value, flags, gap), check]);
    return {
      labelled: [[labelledId(idLabel(words), value), ok], ...shortLabels],
      key,
      value,
      ok,
      acronym: acronyms.length > 0,
    };
  }

  const EU_IDS = [
    {
      words: [
        String.raw`rijksregister(?:nummer)?|(?:num[ée]ro\s+(?:de\s+)?)?registre\s+national|${BELGIAN_NATIONAL_WORDS}`,
        String.raw`national\s+regist(?:er|ry)\s+number|NISS|INSZ`,
      ].join("|"),
      key: /\b(?:rijksregister(?:nummer)?|niss|insz|registre national|national regist(?:er|ry) number)\b/,
      value: BELGIAN_NUMBER_VALUE,
      ok: belgianNumberValid,
    },
    {
      words: String.raw`person(?:nummer|nr\.?)|samordningsnummer`,
      key: /\b(?:person ?nummer|personnr|samordningsnummer)\b/,
      value: PERSONNUMMER_VALUE,
      ok: personnummerValid,
    },
    {
      words: String.raw`cpr(?:\.|[\s-]*)(?:nr|nummer(?:et)?)\.?|personnummer`,
      key: /\b(?:cpr(?: ?(?:nr|nummer|number))?|person ?nummer)\b/,
      value: CPR_VALUE,
      ok: cprValid,
      acronyms: [
        // "CPR no.", "cpr number", "my CPR is", "mit cpr er".
        {
          name: String.raw`CPR(?:(?:\.|[\s-]*)(?:nr|nummer(?:et)?|no|number)\.?(?:\s+(?:is|er))?|\s+(?:is|er))`,
          flags: "giu",
        },
        // "CPR: " or "CPR " in capitals, as a form's field.
        { name: "CPR", flags: "gu", gap: String.raw`[ \t]*(?:[:#=][ \t]*)?` },
        // Any other way, a number that could be a US phone is left to the phone check.
        { name: "CPR", flags: "giu", check: cprNotAPhone },
      ],
    },
    {
      words: String.raw`f[øo]dselsnummer|f[øo]dselsnr\.?|personnummer|D-nummer`,
      key: /\b(?:f[øo]dselsn(?:ummer|r)|person ?nummer)\b/,
      value: FODSELSNUMMER_VALUE,
      ok: fodselsnummerValid,
    },
    {
      words: String.raw`HETU|henkil[öo]tunnus|personbeteckning|Finnish\s+personal\s+identity\s+code`,
      key: /\b(?:hetu|henkil[öo]tunnus|personbeteckning)\b/,
      value: HETU_VALUE,
      ok: hetuValid,
    },
    { words: String.raw`kennitala|kt\.`, key: /\bkennitala\b/, value: KENNITALA_VALUE, ok: kennitalaValid },
    {
      words: [
        String.raw`NIF|N\.I\.F\.|NIPC|(?:n[uú]mero\s+de\s+)?contribuinte`,
        String.raw`n[uú]mero\s+de\s+identifica[çc][ãa]o\s+fiscal`,
      ].join("|"),
      key: /\b(?:nif|nipc|contribuinte)\b/,
      value: PT_NIF_VALUE,
      ok: ptNifValid,
    },
    {
      words: String.raw`CNP|C\.N\.P\.|cod(?:ul)?\s+numeric\s+personal|personal\s+numeric\s+code`,
      key: /\b(?:cnp|cod numeric personal|personal numeric code)\b/,
      value: String.raw`\d{13}`,
      ok: cnpValid,
    },
    {
      words: String.raw`ЕГН|EGN|единен\s+граждански\s+номер|unified\s+civil\s+number`,
      key: /\begn\b|егн/,
      value: String.raw`\d{10}`,
      ok: egnValid,
    },
    {
      words: String.raw`rodn[ée]\s+[čc][íi]slo|${RODNE_CISLO_SHORT_WORDS}|birth\s+number`,
      key: /\brodn[eé] [cč][ií]slo\b/,
      value: RODNE_CISLO_VALUE,
      ok: rodneCisloValid,
    },
    {
      words: String.raw`OIB|osobni\s+identifikacijski\s+broj`,
      key: /\boib\b/,
      value: String.raw`\d{11}`,
      ok: oibValid,
    },
    { words: String.raw`ΑΜΚΑ|Α\.Μ\.Κ\.Α\.?|AMKA`, key: /\bamka\b|αμκα/, value: String.raw`\d{11}`, ok: amkaValid },
    {
      words: String.raw`ΑΦΜ|Α\.Φ\.Μ\.?`,
      key: /\bafm\b|αφμ/,
      value: String.raw`\d{9}`,
      ok: afmValid,
      acronyms: [
        { name: String.raw`AFM(?:[\s-]*(?:no\.?|nr\.?|number))?(?:\s*\(tax\s+(?:id|number|no\.?)\))?`, flags: "gu" },
      ],
    },
    {
      words: String.raw`SVNR|VSNR|SV-?Nr\.?|SV-?Nummer|(?:Sozial)?versicherungsnummer`,
      key: /\b(?:svnr|vsnr|sv ?n(?:r|ummer)|(?:sozial)?versicherungsnummer)\b/,
      value: AUSTRIAN_SVNR_VALUE,
      ok: austrianSvnrValid,
    },
    {
      words: String.raw`RVNR|SV-?Nummer|(?:Sozial|Renten)?versicherungsnummer`,
      key: /\b(?:rvnr|sv ?nummer|(?:sozial|renten)?versicherungsnummer)\b/,
      value: GERMAN_RVNR_VALUE,
      ok: germanRvnrValid,
    },
    {
      words: String.raw`isikukood|asmens\s+kodas|personal\s+(?:identification\s+)?code`,
      key: /\b(?:isikukood|asmens kodas)\b/,
      value: String.raw`\d{11}`,
      ok: isikukoodValid,
    },
    { words: String.raw`personas\s+kods`, key: /\bpersonas kods\b/, value: PERSONAS_KODS_VALUE, ok: personasKodsValid },
    {
      words: String.raw`EM[ŠS]O|JMBG|enotna\s+mati[čc]na\s+[šs]tevilka(?:\s+ob[čc]ana)?`,
      key: /\b(?:em[sš]o|jmbg)\b/,
      value: String.raw`\d{13}`,
      ok: emsoValid,
    },
    {
      words: [
        String.raw`taj[\s-]*sz[áa]m(?:a|[áa]t|om|omat)?`,
        String.raw`t[áa]rsadalombiztos[íi]t[áa]si\s+azonos[íi]t[óo](?:\s+jel)?`,
      ].join("|"),
      key: /\btaj(?: ?sz[aá]m)?\b/,
      value: TAJ_VALUE,
      ok: tajValid,
      acronyms: [{ name: String.raw`TAJ(?:[\s-]*(?:no\.?|nr\.?|number))?`, flags: "gu" }],
    },
    {
      words: String.raw`ad[óo]azonos[íi]t[óo](?:\s+jel)?|ad[óo]\s+azonos[íi]t[óo](?:\s+jel)?`,
      key: /\bad[oó] ?azonos[ií]t[oó]/,
      value: String.raw`8\d{9}`,
      ok: hungarianTaxIdValid,
    },
  ].map(euIdKind);
  // Poland's NIP only in capitals, since French and Spanish speakers in Canada call a card's PIN their "nip".
  const NIP_LABELLED = labelledId(idLabel(String.raw`NIP|[Nn]umer\s+identyfikacji\s+podatkowej`), NIP_VALUE, "gu");

  // Each match's value (its first group, or the whole match) that passes the check.
  function valuesOf(re, text, ok) {
    return [...text.matchAll(re)].map((match) => match[1] ?? match[0]).filter(ok);
  }

  function euNationalIds(text) {
    return [
      ...EU_IDS.flatMap((kind) => kind.labelled.flatMap(([re, ok]) => valuesOf(re, text, ok))),
      ...valuesOf(NIP_LABELLED, text, nipValid),
    ];
  }

  // ---------- Where an ID stands ----------

  // ── Bare IDs ──────────────────────────────────────

  // A bare ID right after the name of something else ("Order", "SKU", "ref", "Commande:", "Pedido nº") is
  // that thing's number.
  const REFERENCE_WORDS = [
    String.raw`order|invoice|ticket|sku|ref|reference|tracking|booking`,
    String.raw`confirmation|transaction|txn|serial|model|part|item|article`,
    String.raw`artikel|art\.?-?nr|bestell|rechnung|auftrag|commande|facture`,
    String.raw`pedido|factura|ordine|fattura|zam[oó]wieni|faktur|factuur|reserv`,
    String.raw`주문|注文|订单|运单|快递`,
  ].join("|");
  // "no.", "nº", "number", or "de", "do", "da" as in "Pedido de".
  const NO_WORD = String.raw`(?:no|nr|n[º°o]|num(?:ber|ero|éro)?|id|de|do|da)`;
  const ID_REFERENCE_BEFORE = new RegExp(
    String.raw`(?<![\p{L}])(?:${REFERENCE_WORDS})\p{L}*[^\n\d\p{L}]{0,6}(?:${NO_WORD}\.?[^\n\d\p{L}]{0,4})?$`,
    "iu",
  );

  function referenceLabelBefore(text, at) {
    return ID_REFERENCE_BEFORE.test(text.slice(Math.max(0, at - 40), at));
  }

  // Bare IDs, minus those after a reference label. When most numbers of the same shape in the message fail the
  // check (a column of order references, an SQL dump of 18-digit ids), the few that pass are chance and none
  // counts. A list of real IDs passes all of them.
  function bareIds(re, text, ok, shape = re) {
    const valid = [];
    for (const match of text.matchAll(re)) if (ok(match[0], text, match.index)) valid.push(match);
    if (!valid.length) return [];
    const sameShape = [...text.matchAll(shape)].length;
    if (sameShape >= 3 && valid.length * 2 < sameShape) return [];
    return valid
      .filter((match) => !referenceLabelBefore(text, match.index))
      .filter((match) => !inHexGroups(text, match.index, match.index + match[0].length))
      .map((match) => match[0]);
  }

  // ── IDs under a key or column name ────────────────
  // The IDs that only count after their label, also found under a CSV or table column of that name, or as the
  // value of a JSON, YAML or URL key named for them ("cpfNumber", "nr_pesel", "steuerIdNr"). The column or key
  // name is split into words first, so "cpfNumber" reads "cpf number".

  function labelOnlyKind([name, value, ok, acronym]) {
    return {
      name,
      whole: new RegExp(`^(?:${value})$`, "i"),
      at: new RegExp(`(?:${value})${ID_VALUE_END}`, "iuy"),
      ok,
      acronym,
    };
  }

  // [the name's words, value, check, whether the name is a short label]
  const LABEL_ONLY_IDS = [
    [/\bcpf\b/, CPF_VALUE, cpfValid],
    [/\bcnpj\b/, CNPJ_VALUE, cnpjValid],
    [/\bpan\b|\bpermanent account number\b/, PAN_VALUE, panValid],
    [/\b(?:nir|insee|s[eé]cu|carte vitale)\b|s[eé]curit[eé] sociale/, NIR_VALUE, nirValid],
    [/\b(?:bsn|burgerservicenummer|sofi ?nummer)\b/, BSN_VALUE, bsnValid],
    [/\bpesel\b/, PESEL_VALUE, peselValid],
    [/\b(?:(?:sa|rsa|south african) id|identity (?:number|no)|id (?:number|no))\b/, SA_ID_VALUE, southAfricanIdValid],
    [/\b(?:steuer ?id|steuer ?identifikationsnummer|identifikationsnummer|id ?nr)\b/, STEUER_VALUE, steuerIdValid],
    [/\brrn\b|\bresident registration\b|주민등록번호|주민번호/, RRN_VALUE, rrnDated],
    [/\b(?:my ?number|individual number)\b|マイナンバー|個人番号/, MY_NUMBER_VALUE, myNumberValid],
    ...EU_IDS.map((kind) => [kind.key, kind.value, kind.ok, kind.acronym]),
    [/\bnip\b/, NIP_VALUE, nipValid, true],
  ].map(labelOnlyKind);
  const ID_NAME_WORDS = [
    String.raw`cpf|cnpj|pan|nir|insee|s[eé]cu|vitale|bsn|burgerservice|sofi|pesel`,
    String.raw`identity|id|steuer|identifikation|rrn|resident|number|nummer`,
    String.raw`niss|insz|regist|person|samordning|cpr|f[øo]dsels|hetu|henkil`,
    String.raw`kennitala|nif|nipc|contribuinte|cnp|numeric|egn|егн|rodn|oib`,
    String.raw`amka|αμκα|afm|αφμ|svnr|vsnr|sv ?nr|rvnr|isikukood|asmens`,
    String.raw`emso|emšo|jmbg|taj|ad[oó] ?azonos|nip|주민|マイナンバー|個人番号`,
  ].join("|");
  const ID_NAME_HINT = new RegExp(ID_NAME_WORDS, "i");
  const ID_KEY_RE = /(?<![\p{L}\d_])["']?(\p{L}[\p{L}\d_.-]{0,40}?)["']?[ \t]*[:=][ \t]*["']?(?=[\dA-Za-z])/gu;

  // "cpfNumber", "nr_pesel" or "Steuer-ID" as lowercase words: "cpf number", "nr pesel", "steuer id".
  function nameWords(name) {
    return name
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/[_.\-\s]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function kindsNamed(name) {
    const words = nameWords(name);
    return LABEL_ONLY_IDS.filter((kind) => kind.name.test(words));
  }

  function keyedIds(text) {
    const found = [];
    for (const match of text.matchAll(ID_KEY_RE)) {
      const key = match[1];
      if (!ID_NAME_HINT.test(key)) continue;
      // "Taj:" in prose is someone named Taj; the key for the ID is "taj", "TAJ" or "tajSzam".
      const titleWord = /^\p{Lu}\p{Ll}+$/u.test(key);
      // " cpr: " not in capitals can be a résumé's first-aid line, and ten digits after it that dial as a US phone
      // are the phone, which still counts as one.
      const firstAid = key !== "CPR" && nameWords(key) === "cpr";
      for (const kind of kindsNamed(key)) {
        if (titleWord && kind.acronym) continue;
        kind.at.lastIndex = match.index + match[0].length;
        const value = kind.at.exec(text);
        if (!value || !kind.ok(value[0])) continue;
        if (!(firstAid && nanpShaped(value[0]))) found.push(value[0]);
      }
    }
    return found;
  }

  // A line's cells, split on the first of "|", tab, comma or semicolon it holds.
  function cellsOf(line) {
    const separator = ["|", "\t", ",", ";"].find((candidate) => line.includes(candidate));
    if (!separator) return [line];
    return line.split(separator).map((cell) => cell.trim().replace(/^["']|["']$/g, ""));
  }

  // CPR, TAJ, AFM and NIP are also a first-aid course, a first name, a lab's microscope and a word in a product's
  // name ("Taj Patel", "CPR, First Aid", "AFM sample prep"). So a cell names one only when it ends in it, with
  // "nr", "no", "number", "szám" or whose NIP it is ("NIP nabywcy") allowed after, and it is the whole cell
  // ("cpr_nr", "TAJ szám") or is written in capitals ("Patient CPR") or joined on ("patientCpr"). "Taj" and "Nip"
  // on their own are a person and a word, as with keys.
  const NUMBER_AFTER = String.raw`nr|no|nummer(?:et)?|number|sz[aá]m\p{L}{0,3}`;
  // Whose NIP it is, in Polish: the company's, the buyer's, the seller's and so on.
  const NIP_OWNERS = "firmy|nabywcy|sprzedawcy|kontrahenta|dostawcy|odbiorcy|klienta";
  const SHORT_ID_END = new RegExp(
    String.raw`(?:^|\s)(cpr|taj|afm|nip)( (?:${NUMBER_AFTER}|${NIP_OWNERS}))?[^\p{L}\p{N}]*$`,
    "u",
  );
  const SHORT_ID_WORD = /\b(?:cpr|taj|afm|nip)\b/g;
  const CPR_KIND = LABEL_ONLY_IDS.find((kind) => kind.ok === cprValid);
  // Under the bare word CPR, a number that could be a US phone is left to the phone check, as in prose.
  const CPR_BARE_KIND = { ...CPR_KIND, ok: cprNotAPhone };
  // A cell that is wholly "Numéro national" (numero_national) or "r. č." names its kind, as written or split into
  // words. The loose hint only lets a table with one of them be read. Each pattern runs only on text that holds its
  // plain word ("national", "č", "numero" or "numéro"), so a table without them costs what it did before.
  const PROSE_HEADERS = [
    [BELGIAN_NATIONAL_WORDS, belgianNumberValid, "national"],
    [RODNE_CISLO_SHORT_WORDS, rodneCisloValid, "č"],
  ].map(([words, ok, plain]) => [
    new RegExp(`^(?:${words})$`, "iu"),
    LABEL_ONLY_IDS.find((kind) => kind.ok === ok),
    plain,
  ]);
  const PROSE_HEADER_HINT = /num[ée]ro|r\.\s?č\./iu;

  function proseKinds(cell) {
    const lower = cell.toLowerCase();
    return PROSE_HEADERS.filter(
      ([re, , plain]) => lower.includes(plain) && (re.test(cell) || re.test(nameWords(cell))),
    ).map(([, kind]) => kind);
  }

  function proseHinted(text) {
    const lower = text.toLowerCase();
    const hasPlainWord = lower.includes("numero") || lower.includes("numéro") || lower.includes("č");
    return hasPlainWord && PROSE_HEADER_HINT.test(text);
  }

  function idHinted(text) {
    return ID_NAME_HINT.test(text) || proseHinted(text);
  }

  // Whether a cell that ends in CPR, TAJ, AFM or NIP (`end`, from SHORT_ID_END) names that ID.
  function namesShortId(cell, end) {
    if (end.index === 0) return !/^(?:Taj|Nip)$/.test(cell);
    return cell.includes(end[1].toUpperCase()) || /[\p{Ll}\d](?:Cpr|Taj|Afm|Nip)(?!\p{Ll})/u.test(cell);
  }

  // The kinds a header cell names.
  function columnKinds(cell) {
    const prose = proseKinds(cell);
    if (prose.length) return prose;
    const words = nameWords(cell);
    const end = SHORT_ID_END.exec(words);
    if (!end || !namesShortId(cell, end)) return kindsNamed(words.replace(SHORT_ID_WORD, " "));
    const kinds = kindsNamed(words);
    const bareCpr = end[1] === "cpr" && !end[2];
    if (!bareCpr) return kinds;
    return kinds.map((kind) => (kind === CPR_KIND ? CPR_BARE_KIND : kind));
  }

  // Adds the kinds each cell names to its column, newest first. Returns the columns, or null if none yet.
  function addHeaderKinds(cells, columns) {
    let found = columns;
    for (const [i, cell] of cells.entries()) {
      if (cell.length > 40 || /\d/.test(cell) || !idHinted(cell)) continue;
      const kinds = columnKinds(cell);
      if (!kinds.length) continue;
      if (!found) found = new Map();
      const known = found.get(i) || [];
      found.set(i, [...kinds, ...known.filter((kind) => !kinds.includes(kind))]);
    }
    return found;
  }

  function idColumns(text) {
    if (!text.includes("\n") || !idHinted(text)) return [];
    const found = [];
    // Column number → the kinds its header names.
    let columns = null;
    for (const line of text.split("\n")) {
      const cells = cellsOf(line);
      // A blank line or a line without cells ends the table.
      if (cells.length < 2) {
        columns = null;
        continue;
      }
      // A cell that names a kind adds that kind to its column and keeps every column above it, since the row may
      // be data ("CPR" in a column of certificates, the first name Taj) or the table's own header under a line that
      // named one ("Naam,Adres 1,BSN"). Each row is then read as data, since a header's names never pass a check.
      columns = addHeaderKinds(cells, columns);
      if (!columns) continue;
      for (const [i, cell] of cells.entries()) {
        const kinds = columns.get(i);
        if (cell && kinds && kinds.some((kind) => kind.whole.test(cell) && kind.ok(cell))) found.push(cell);
      }
    }
    return found;
  }

  // ---------- Reading every national ID ----------

  // ── All national IDs ──────────────────────────────

  // After its label, a codice fiscale in capitals is already read bare.
  function codiceFiscaleNotCapitals(value) {
    return value !== value.toUpperCase() && codiceFiscaleValid(value);
  }

  function readWorldNationalIds(text) {
    const ids = [
      ...valuesOf(PPS_LABELLED, text, ppsValid),
      ...bareIds(PPS_BARE, text, ppsValid),
      ...valuesOf(IRD_LABELLED, text, irdValid),
      ...valuesOf(NHI_LABELLED, text, nhiValid),
      ...bareIds(NHI_BARE, text, nhiValid),
      ...valuesOf(CPF_LABELLED, text, cpfValid),
      ...bareIds(CPF_DOTTED, text, cpfValid),
      ...valuesOf(CNPJ_LABELLED, text, cnpjValid),
      ...bareIds(CNPJ_DOTTED, text, cnpjValid),
      ...valuesOf(PAN_LABELLED, text, panValid),
      ...valuesOf(NIR_LABELLED, text, nirValid),
      ...bareIds(NIR_SPACED, text, nirValid),
      ...valuesOf(BSN_LABELLED, text, bsnValid),
      ...valuesOf(PESEL_LABELLED, text, peselValid),
      ...bareIds(CODICE_FISCALE_BARE, text, codiceFiscaleValid),
      ...valuesOf(CODICE_FISCALE_LABELLED, text, codiceFiscaleNotCapitals),
      ...bareIds(NRIC_BARE, text, nricValid),
      ...valuesOf(SA_ID_LABELLED, text, southAfricanIdValid),
      ...valuesOf(STEUER_LABELLED, text, steuerIdValid),
      ...bareIds(RRN_BARE, text, rrnValid, RRN_SHAPE),
      ...valuesOf(RRN_LABELLED, text, rrnDated),
      ...valuesOf(MY_NUMBER_LABELLED, text, myNumberValid),
      ...bareIds(CN_ID_BARE, text, chineseIdValid, CN_ID_SHAPE),
      ...euNationalIds(text),
      ...keyedIds(text),
      ...idColumns(text),
    ];
    return [...new Set(ids)];
  }

  // Each value once, though a dotted CPF after its label is read by both its rules. National IDs, cards and phones
  // all ask for these on the same text, so the last text's answer is kept and handed out as a copy.
  let lastWorldIdsText = null;
  let lastWorldIds = null;

  function worldNationalIds(text) {
    if (text !== lastWorldIdsText) {
      lastWorldIds = readWorldNationalIds(text);
      lastWorldIdsText = text;
    }
    return [...lastWorldIds];
  }

  // A check letter right before a drive separator (E:\, T:/) belongs to the path, not an ID.
  function driveLetter(text, match) {
    return /^:[\\/]/.test(text.slice(match.index + match[0].length));
  }

  function typedDnis(text) {
    const found = [];
    for (const match of text.matchAll(DNI_RE)) {
      const digits = match[1].replace(/\D/g, "");
      if (digits.length !== 8 || DNI_LETTERS[Number(digits) % 23] !== match[2]) continue;
      if (!driveLetter(text, match)) found.push(match[0]);
    }
    return found;
  }

  // An NIE's X, Y or Z stands for 0, 1 or 2 in front of its digits.
  function typedNies(text) {
    const found = [];
    for (const match of text.matchAll(NIE_RE)) {
      const digits = match[2].replace(/\D/g, "");
      if (digits.length !== 7) continue;
      const number = Number(String("XYZ".indexOf(match[1])) + digits);
      if (DNI_LETTERS[number % 23] !== match[3]) continue;
      if (!driveLetter(text, match)) found.push(match[0]);
    }
    return found;
  }

  function sinValid(digits) {
    return digits.length === 9 && validLuhn(digits.padStart(13, "0"));
  }

  function findNationalIds(text) {
    return [
      ...worldNationalIds(text),
      ...(text.match(ITIN_RE) || []),
      ...[...text.matchAll(US_ID_LABELLED)].map((match) => match[1]),
      ...[...text.matchAll(RFC_RE)].map((match) => match[1]),
      ...[...text.matchAll(NSS_RE)].map((match) => match[1]),
      ...[...text.matchAll(NINO_RE)].filter((match) => ninoLabelNear(text, match.index)).map((match) => match[0]),
      ...numberAfter(SIN_LABELS, text, sinValid),
      ...numberAfter(AADHAAR_LABELS, text, aadhaarValid),
      ...numberAfter(TFN_LABELS, text, tfnValid),
      ...typedDnis(text),
      ...typedNies(text),
      ...spokenDniNie(text),
      ...(text.match(CURP_RE) || []).filter(curpValid),
      ...spokenCurps(text),
      ...spanishNationalIds(text),
    ];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, worldNationalIds, findNationalIds };
})();

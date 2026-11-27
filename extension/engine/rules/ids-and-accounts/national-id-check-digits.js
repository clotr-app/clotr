// One check per country's ID number: its check digit, letter or key, and a real birth date where it holds one.
// national-ids.js finds the IDs, and these say whether a found one is real.
(() => {
  "use strict";

  const { validLuhn, mod97 } = globalThis.ClotrInternal;

  // ---------- Other countries' national IDs and their checks ----------
  // Each has a public check (digits, a letter or a key), so a random number of the same shape passes 1 time in
  // 10 to 97 at most, and most also carry a birth date that has to be real. The ones that are only digits, a
  // shape order numbers, phones and timestamps share, count only after their label. The ones with a layout of
  // their own count anywhere: Brazil's dotted CPF and CNPJ, France's spaced NIR, Italy's codice fiscale,
  // Singapore's NRIC, Korea's dashed RRN and China's 18-digit resident ID.

  // A label, up to 20 characters that aren't digits ("CPF:", "my BSN is", "numer PESEL", "Nr."), then the value.
  const ID_VALUE_END = String.raw`(?![\p{L}\d]|[.,/-]\d)`;
  const NOW_YEAR = new Date().getUTCFullYear();

  function idLabel(words) {
    return String.raw`(?<![\p{L}\d])(?:${words})(?![\p{L}])`;
  }

  // The value can also start the next line, under a label of its own ("CPF:" then the number).
  function labelledId(labelSource, value, flags = "giu") {
    return new RegExp(
      String.raw`(?:${labelSource})[^\n\d]{0,20}?(?:\n[ \t]*)?(?<![\p{L}\d])(${value})${ID_VALUE_END}`,
      flags,
    );
  }

  // A short label that is also an English word or abbreviation or a name ("CPR certified, call", "Taj", an "AFM
  // sample"): only right before the value, with no word between, and (with the "gu" flags) only in capitals.
  function acronymId(acronym, value, flags, gap = String.raw`[^\n\d\p{L}]{0,6}`) {
    return new RegExp(
      String.raw`(?<![\p{L}\d])(?:${acronym})(?![\p{L}])${gap}(?:\n[ \t]*)?(?<![\p{L}\d])(${value})${ID_VALUE_END}`,
      flags,
    );
  }

  function bareId(value, flags = "gu") {
    return new RegExp(String.raw`(?<![\p{L}\d]|\d[.,/-])(?:${value})${ID_VALUE_END}`, flags);
  }

  // The ID's letters and digits in capitals, without spaces, dots or dashes.
  function idCharacters(value) {
    return value.replace(/[^\dA-Za-z]/g, "").toUpperCase();
  }

  function realDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1) return false;
    return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // A birth year a bare number can carry: someone at least 10 and under 100. Order and booking references
  // dated this decade fit the same shapes, and read as a young child (or, in the other century, someone
  // over 100). After the ID's own label, any real birth date counts.
  function adultBirthYear(year) {
    return year <= NOW_YEAR - 10 && year > NOW_YEAR - 100;
  }

  // Each digit times its weight, added up.
  function weightedSum(digits, weights) {
    return weights.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0);
  }

  // ISO 7064 MOD 11,10, the check on Germany's Steuer-ID and Croatia's OIB.
  function iso7064Mod11x10Valid(digits) {
    let product = 10;
    for (const char of digits.slice(0, -1)) {
      const sum = (Number(char) + product) % 10 || 10;
      product = (sum * 2) % 11;
    }
    return (11 - product) % 10 === Number(digits[digits.length - 1]);
  }

  // ── Ireland and New Zealand ───────────────────────

  // Ireland's PPS number has seven digits and a mod-23 check letter. A second letter can follow it. English
  // labels and the Irish name, Uimhir Phearsanta Seirbhíse Poiblí, all point to the same national ID.
  const PPS_CHECK = "WABCDEFGHIJKLMNOPQRSTUV";
  const PPS_VALUE = String.raw`\d(?:[ \t-]?\d){6}[ \t-]?[A-W][A-IW]?`;
  const PPS_LABELLED = labelledId(
    idLabel(
      String.raw`PPSN|PPS\s*(?:number|no\.?|#)|personal\s+public\s+service(?:\s+number)?|` +
        String.raw`UPSP|PSP|uimhir\s+(?:phearsanta\s+)?seirbh[ií]se\s+poibl[ií]`,
    ),
    PPS_VALUE,
  );
  const PPS_BARE = bareId(PPS_VALUE);

  function ppsValid(value) {
    const parts = /^(\d{7})([A-W])([A-IW]?)$/.exec(idCharacters(value));
    if (!parts) return false;
    const [, digits, check, second] = parts;
    // A second letter other than W adds its place in the alphabet times 9.
    const extra = second && second !== "W" ? (second.charCodeAt(0) - 64) * 9 : 0;
    return PPS_CHECK[(weightedSum(digits, [8, 7, 6, 5, 4, 3, 2]) + extra) % 23] === check;
  }

  // Inland Revenue checks eight or nine digits with two mod-11 weight sets. Keep this label-only: a valid
  // checksum still passes often enough for order numbers, phone numbers and other bare digit strings to collide.
  const IRD_LABELLED = labelledId(
    idLabel(String.raw`(?:New\s+Zealand\s+)?(?:IRD|Inland\s+Revenue(?:\s+Department)?)`),
    String.raw`\d{2,3}(?:[ \t-]?\d{3}){2}`,
  );
  const IRD_PRIMARY = [3, 2, 7, 6, 5, 4, 3, 2];
  const IRD_SECONDARY = [7, 4, 3, 2, 5, 2, 7, 6];

  function irdCheckDigit(base, weights) {
    const remainder = weightedSum(base, weights) % 11;
    return remainder === 0 ? 0 : 11 - remainder;
  }

  function irdValid(value) {
    const digits = idCharacters(value);
    const number = Number(digits);
    if (!/^\d{8,9}$/.test(digits) || number < 10000000 || number > 200000000) return false;
    const base = digits.slice(0, -1).padStart(8, "0");
    let check = irdCheckDigit(base, IRD_PRIMARY);
    if (check === 10) check = irdCheckDigit(base, IRD_SECONDARY);
    return check < 10 && check === Number(digits[digits.length - 1]);
  }

  // New Zealand NHI checks use letters A–Z without I or O. The old seven-character form ends in a mod-11
  // digit; the expanded form ends in a mod-23 letter.
  const NHI_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const NHI_SHAPE = String.raw`(?:[A-HJ-NP-Z]{3}\d{3}\d|[A-HJ-NP-Z]{3}\d{2}[A-HJ-NP-Z]{2})`;
  const NHI_LABELLED = labelledId(idLabel(String.raw`NHI|National\s+Health\s+Index`), NHI_SHAPE);
  const NHI_BARE = bareId(NHI_SHAPE);

  // The first six characters weighted 7 down to 2, a letter counting as its place in NHI_LETTERS.
  function nhiSum(body) {
    return [...body].reduce(
      (total, char, i) => total + (/[A-Z]/.test(char) ? NHI_LETTERS.indexOf(char) + 1 : Number(char)) * (7 - i),
      0,
    );
  }

  function nhiValid(value) {
    const id = idCharacters(value);
    const old = /^([A-HJ-NP-Z]{3})(\d{3})(\d)$/.exec(id);
    if (old) {
      const remainder = nhiSum(old[1] + old[2]) % 11;
      const check = 11 - remainder;
      return remainder !== 0 && check <= 9 && check === Number(old[3]);
    }
    const newer = /^([A-HJ-NP-Z]{3})(\d{2})([A-HJ-NP-Z])([A-HJ-NP-Z])$/.exec(id);
    if (!newer) return false;
    const sum = nhiSum(newer[1] + newer[2] + newer[3]);
    return NHI_LETTERS[23 - (sum % 23) - 1] === newer[4];
  }

  // ── Brazil and India ──────────────────────────────

  // Brazil: CPF (people) and CNPJ (companies), two mod-11 check digits each.
  const CPF_LABEL = idLabel(String.raw`C\.?P\.?F\.?`);
  const CNPJ_LABEL = idLabel(String.raw`C\.?N\.?P\.?J\.?`);
  const CPF_VALUE = String.raw`\d{3}[. ]?\d{3}[. ]?\d{3}[-. ]?\d{2}`;
  const CNPJ_VALUE = String.raw`\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}`;
  const CPF_LABELLED = labelledId(CPF_LABEL, CPF_VALUE);
  const CNPJ_LABELLED = labelledId(CNPJ_LABEL, CNPJ_VALUE);
  const CPF_DOTTED = bareId(String.raw`\d{3}\.\d{3}\.\d{3}-\d{2}`);
  const CNPJ_DOTTED = bareId(String.raw`\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}`);

  function brazilCheckDigit(digits, weights) {
    const remainder = weightedSum(digits, weights) % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  }

  function oneDigitRepeated(digits) {
    return /^(\d)\1+$/.test(digits);
  }

  function cpfValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{11}$/.test(digits) || oneDigitRepeated(digits)) return false;
    if (brazilCheckDigit(digits, [10, 9, 8, 7, 6, 5, 4, 3, 2]) !== Number(digits[9])) return false;
    return brazilCheckDigit(digits, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[10]);
  }

  function cnpjValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{14}$/.test(digits) || oneDigitRepeated(digits)) return false;
    if (brazilCheckDigit(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) !== Number(digits[12])) return false;
    return brazilCheckDigit(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[13]);
  }

  // India's PAN: its fourth letter says who holds it (P a person, C a company, …). No public check, so only
  // after its label.
  const PAN_VALUE = String.raw`[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]`;
  const PAN_LABELLED = labelledId(idLabel(String.raw`PAN|permanent\s+account\s+number`), PAN_VALUE);
  const PAN_WHOLE = new RegExp(`^${PAN_VALUE}$`, "i");

  function panValid(value) {
    return PAN_WHOLE.test(value);
  }

  // ── France, the Netherlands, Poland, Italy ────────

  // France's NIR (social security number): sex, birth year and month, department (2A/2B for Corsica), town,
  // order, then a key of 97 minus the first 13 digits mod 97.
  const NIR_VALUE = String.raw`[1-478]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}\s?\d{2}`;
  const NIR_LABELLED = labelledId(
    idLabel(String.raw`NIR|INSEE|s[ée]curit[ée]\s+sociale|s[ée]cu|carte\s+vitale`),
    NIR_VALUE,
  );
  const NIR_SPACED = bareId(String.raw`[12] \d{2} \d{2} (?:\d{2}|2[AB]) \d{3} \d{3} \d{2}`, "giu");

  function nirValid(value) {
    const nir = idCharacters(value);
    if (!/^[1-478]\d{2}(?:0[1-9]|1[0-2]|[2-9]\d)(?:\d{2}|2[AB])\d{8}$/.test(nir)) return false;
    // Corsica's 2A and 2B count as 19 and 18.
    const body = nir.slice(0, 13).replace("2A", "19").replace("2B", "18");
    return 97 - mod97(body) === Number(nir.slice(13));
  }

  // The Netherlands' BSN: the "11-test" (9×d1 + 8×d2 + … + 2×d8 − d9 is a multiple of 11).
  const BSN_VALUE = String.raw`\d{9}|\d{4}\.\d{2}\.\d{3}|\d{3}[ .]\d{3}[ .]\d{3}`;
  const BSN_LABELLED = labelledId(idLabel(String.raw`BSN|burgerservicenummer|sofi-?nummer`), BSN_VALUE);

  function bsnValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{9}$/.test(digits) || digits === "000000000") return false;
    return weightedSum(digits, [9, 8, 7, 6, 5, 4, 3, 2, -1]) % 11 === 0;
  }

  // Poland's PESEL: birth date (the century added to the month), serial, weighted check digit.
  const PESEL_VALUE = String.raw`\d{11}|\d{3} \d{3} \d{3} \d{2}`;
  const PESEL_LABELLED = labelledId(idLabel("PESEL"), PESEL_VALUE);
  const PESEL_CENTURY = { 0: 1900, 1: 2000, 2: 2100, 3: 2200, 4: 1800 };

  function peselValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{11}$/.test(digits)) return false;
    const month = Number(digits.slice(2, 4));
    const century = PESEL_CENTURY[Math.floor(month / 20)];
    if (!realDate(century + Number(digits.slice(0, 2)), month % 20, Number(digits.slice(4, 6)))) return false;
    return (10 - (weightedSum(digits, [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]) % 10)) % 10 === Number(digits[10]);
  }

  // Italy's codice fiscale: 6 letters of name, birth year, month letter, day (+40 for women), town code, check
  // letter. Digits can be swapped for letters (L for 0 … V for 9) when two people would share one.
  const CODICE_FISCALE_VALUE = String.raw`[A-Z]{6}[\dLMNP-V]{2}[ABCDEHLMPRST][\dLMNP-V]{2}[A-Z][\dLMNP-V]{3}[A-Z]`;
  const CODICE_FISCALE_BARE = bareId(CODICE_FISCALE_VALUE);
  const CODICE_FISCALE_LABELLED = labelledId(idLabel(String.raw`codice\s+fiscale|C\.F\.`), CODICE_FISCALE_VALUE);
  // What a character in an odd place (1st, 3rd, …) adds: A and 0 add 1, B and 1 add 0, and so on.
  const CODICE_FISCALE_ODD = [
    1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
  ];

  function codiceFiscaleValid(value) {
    const code = value.toUpperCase();
    const day = Number(code.slice(9, 11).replace(/[LMNP-V]/g, (letter) => "LMNPQRSTUV".indexOf(letter)));
    const manDay = day >= 1 && day <= 31;
    const womanDay = day >= 41 && day <= 71;
    if (!manDay && !womanDay) return false;
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      const place = /\d/.test(code[i]) ? Number(code[i]) : code.charCodeAt(i) - 65;
      sum += i % 2 === 0 ? CODICE_FISCALE_ODD[place] : place;
    }
    return String.fromCharCode(65 + (sum % 26)) === code[15];
  }

  // ── Singapore, South Africa, Germany ──────────────

  // Singapore's NRIC and FIN: S or T (citizens), F or G (foreigners), 7 digits, a check letter. A T number
  // starts with its holder's birth year (2000 on), so it can't be ahead of this year.
  const NRIC_BARE = bareId(String.raw`[STFG]\d{7}[A-Z]`);
  const NRIC_CITIZEN_LETTERS = "JZIHGFEDCBA";
  const NRIC_FOREIGNER_LETTERS = "XWUTRQPNMLK";

  function nricValid(nric) {
    if (nric[0] === "T" && 2000 + Number(nric.slice(1, 3)) > NOW_YEAR) return false;
    const sum = weightedSum(nric.slice(1, 8), [2, 7, 6, 5, 4, 3, 2]) + (/[TG]/.test(nric[0]) ? 4 : 0);
    const letters = "ST".includes(nric[0]) ? NRIC_CITIZEN_LETTERS : NRIC_FOREIGNER_LETTERS;
    return letters[sum % 11] === nric[8];
  }

  // South Africa's ID: birth date, serial, citizenship (0, 1 or 2), a digit, Luhn. Bare 13 digits are often
  // timestamps, so only after an ID label.
  const SA_ID_VALUE = String.raw`\d{6}\s?\d{4}\s?\d{3}`;
  const SA_ID_LABELLED = labelledId(
    idLabel(
      String.raw`(?:SA|RSA|South\s+African)\s+ID(?:\s+(?:number|no\.?|#))?|` +
        String.raw`identity\s+(?:number|no\.?)|ID\s*(?:number|no\.?|#)`,
    ),
    SA_ID_VALUE,
  );

  function southAfricanIdValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{10}[012]\d{2}$/.test(digits)) return false;
    return realDate(2000, Number(digits.slice(2, 4)), Number(digits.slice(4, 6))) && validLuhn(digits);
  }

  // Germany's Steuer-ID: 11 digits, the first not 0, one digit used twice or three times in the first ten (the
  // rest at most once), an ISO 7064 MOD 11,10 check digit.
  const STEUER_VALUE = String.raw`\d{2}\s?\d{3}\s?\d{3}\s?\d{3}`;
  const STEUER_LABELLED = labelledId(
    idLabel(
      String.raw`steuer-?id(?:nr\.?)?|steuer-?identifikationsnummer|` +
        String.raw`steuerliche\s+identifikationsnummer|identifikationsnummer|IdNr\.?`,
    ),
    STEUER_VALUE,
  );

  function steuerIdValid(value) {
    const digits = idCharacters(value);
    if (!/^[1-9]\d{10}$/.test(digits)) return false;
    const counts = new Array(10).fill(0);
    for (const char of digits.slice(0, 10)) counts[Number(char)]++;
    const repeated = counts.filter((count) => count > 1).length;
    if (repeated !== 1 || counts.some((count) => count > 3)) return false;
    return iso7064Mod11x10Valid(digits);
  }

  // ── Korea, Japan, China ───────────────────────────

  // South Korea's resident registration number: birth date, a digit for sex and century, then 6 digits. Its
  // last digit was a check digit until late 2020, so bare ones need it; after a label the date is enough.
  const RRN_CENTURY = { 1: 1900, 2: 1900, 3: 2000, 4: 2000, 5: 1900, 6: 1900, 7: 2000, 8: 2000 };
  const RRN_BARE = bareId(String.raw`\d{6}-[1-8]\d{6}`);
  const RRN_SHAPE = bareId(String.raw`\d{6}-\d{7}`);
  const RRN_VALUE = String.raw`\d{6}-?[1-8]\d{6}`;
  const RRN_LABELLED = labelledId(
    String.raw`주민등록번호|주민번호|${idLabel(String.raw`RRN|resident\s+registration\s+number`)}`,
    RRN_VALUE,
  );

  function rrnYear(digits) {
    return RRN_CENTURY[digits[6]] + Number(digits.slice(0, 2));
  }

  function rrnDated(value) {
    const digits = idCharacters(value);
    if (rrnYear(digits) > NOW_YEAR) return false;
    return realDate(rrnYear(digits), Number(digits.slice(2, 4)), Number(digits.slice(4, 6)));
  }

  function rrnValid(value) {
    const digits = idCharacters(value);
    if (!rrnDated(value) || !adultBirthYear(rrnYear(digits))) return false;
    return (11 - (weightedSum(digits, [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]) % 11)) % 10 === Number(digits[12]);
  }

  // Japan's My Number: 12 digits, the last a check digit. In English only "My Number" in capitals, since "my
  // number is …" is usually a phone.
  const MY_NUMBER_VALUE = String.raw`\d{4}\s?\d{4}\s?\d{4}`;
  const MY_NUMBER_LABELLED = labelledId(
    String.raw`マイナンバー|個人番号|(?<![\p{L}])(?:My\s?Number|[Ii]ndividual\s+[Nn]umber)(?![\p{L}])`,
    MY_NUMBER_VALUE,
    "gu",
  );

  function myNumberValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{12}$/.test(digits)) return false;
    // Counting from the right of the first 11, the weights run 2 to 7, then 2 to 6.
    let sum = 0;
    for (let n = 1; n <= 11; n++) sum += Number(digits[11 - n]) * (n <= 6 ? n + 1 : n - 5);
    const remainder = sum % 11;
    return (remainder <= 1 ? 0 : 11 - remainder) === Number(digits[11]);
  }

  // China's resident ID: region, birth date (YYYYMMDD), serial, ISO 7064 MOD 11-2 check (X for 10).
  // The first two digits are a province (11 Beijing … 65 Xinjiang, 71 Taiwan, 81-83 Hong Kong, Macau, Taiwan
  // residents), and the birth date can't be in the future. Bare, it also needs an adult's birth year, unless an
  // ID-card label is right before it.
  const CN_ID_BARE = bareId(String.raw`[1-8]\d{5}(?:18|19|20)\d{2}[01]\d[0-3]\d\d{3}[\dXx]`);
  const CN_ID_SHAPE = bareId(String.raw`\d{17}[\dXx]`);
  const CN_PROVINCE = /^(?:1[1-5]|2[1-3]|3[1-7]|4[1-6]|5[0-4]|6[1-5]|71|8[1-3])/;
  const CN_ID_LABEL_BEFORE =
    /(?:身份证|身份證|身份号码|身份號碼|(?<![\p{L}])(?:resident|identity|ID)\s*(?:ID|card)?)[^\n\d]{0,20}$/iu;
  const CN_ID_CHECKS = "10X98765432";

  function chineseIdValid(value, text, index) {
    const id = value.toUpperCase();
    const year = Number(id.slice(6, 10));
    if (!CN_PROVINCE.test(id) || year > NOW_YEAR) return false;
    if (!realDate(year, Number(id.slice(10, 12)), Number(id.slice(12, 14)))) return false;
    const sum = weightedSum(id, [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]);
    if (CN_ID_CHECKS[sum % 11] !== id[17]) return false;
    if (adultBirthYear(year)) return true;
    return CN_ID_LABEL_BEFORE.test(text.slice(Math.max(0, index - 40), index));
  }

  // ---------- Checks for EU and EEA personal and tax numbers ----------
  // Each is checked by its own check digit (or, for Denmark, whose newer numbers have none, its birth date and
  // century digit), and those carrying a birth date need a real one. Plain digits are what order numbers, phones
  // and log timestamps (YYMMDD-HHMM) look like, so these count only after their label, under a column or key of
  // that name. That goes for the layouts with their own punctuation too (Belgium's "YY.MM.DD-NNN.CC", the Czech
  // and Slovak "YYMMDD/NNNN", a pension number or HETU with a letter in it), since part codes with a date in them,
  // an account and its bank code, or a number and a year take those layouts and some pass the check by chance.

  // A real date, not in a future year.
  function pastBirthDate(year, month, day) {
    return year <= NOW_YEAR && realDate(year, month, day);
  }

  // The weighted sum mod 11, with `ten` standing in for a remainder of 10.
  function mod11CheckDigit(digits, weights, ten) {
    const remainder = weightedSum(digits, weights) % 11;
    return remainder === 10 ? ten : remainder;
  }

  // Belgium: birth date (month +20 or +40 for a bis number, 00 when unknown), serial, then 97 minus the first nine
  // digits mod 97, with a 2 put in front for people born from 2000.
  const BELGIAN_NUMBER_VALUE = String.raw`\d{2}[. ]?\d{2}[. ]?\d{2}[-. ]?\d{3}[. ]?\d{2}`;

  function belgianNumberValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{11}$/.test(digits)) return false;
    const month = Number(digits.slice(2, 4));
    if (month > 52 || month % 20 > 12 || Number(digits.slice(4, 6)) > 31) return false;
    const body = Number(digits.slice(0, 9));
    const check = Number(digits.slice(9));
    return 97 - (body % 97) === check || 97 - ((2e9 + body) % 97) === check;
  }

  // Sweden: YYMMDD (day +60 for a coordination number), serial, Luhn; the century can be written in front.
  const PERSONNUMMER_VALUE = String.raw`(?:19|20)?\d{6}[-+ ]?\d{4}`;

  // Written with its century, the year is as written. Without, it's the latest year that isn't in the future.
  function swedishBirthYear(all, yy) {
    if (all.length === 12) return Number(all.slice(0, 4));
    return 2000 + yy > NOW_YEAR ? 1900 + yy : 2000 + yy;
  }

  function personnummerValid(value) {
    const all = idCharacters(value);
    if (!/^(?:\d{10}|(?:19|20)\d{10})$/.test(all)) return false;
    const digits = all.slice(-10);
    const year = swedishBirthYear(all, Number(digits.slice(0, 2)));
    const day = Number(digits.slice(4, 6)) % 60;
    return pastBirthDate(year, Number(digits.slice(2, 4)), day) && validLuhn(digits.padStart(14, "0"));
  }

  // Denmark's CPR: DDMMYY, then four digits whose first sets the century. Numbers since 2007 have no check digit.
  const CPR_VALUE = String.raw`\d{6}[- ]?\d{4}`;

  function cprCentury(centuryDigit, yy) {
    if (centuryDigit <= 3) return 1900;
    if (centuryDigit === 4 || centuryDigit === 9) return yy <= 36 ? 2000 : 1900;
    return yy <= 57 ? 2000 : 1800;
  }

  function cprValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{10}$/.test(digits)) return false;
    const yy = Number(digits.slice(4, 6));
    const century = cprCentury(Number(digits[6]), yy);
    return pastBirthDate(century + yy, Number(digits.slice(2, 4)), Number(digits.slice(0, 2)));
  }

  // Ten digits that dial as a US or Canadian number (area code and exchange each start 2-9): after the bare word
  // "CPR" set off by punctuation ("Babysitter (CPR) 3105551234") that is the phone, which still counts as one.
  function nanpShaped(value) {
    return /^[2-9]\d\d[2-9]\d{6}$/.test(value);
  }

  // Under the bare word CPR, a number that could be a US phone is left to the phone check.
  function cprNotAPhone(value) {
    return !nanpShaped(value) && cprValid(value);
  }

  // Norway's fødselsnummer: DDMMYY (day +40 for a D number, month +40 for an H number), an individual number that
  // sets the century, then two mod-11 check digits.
  const FODSELSNUMMER_VALUE = String.raw`\d{6}[ ]?\d{5}`;

  // The century from the individual number, or 0 when it can't be one.
  function norwegianCentury(individual, yy) {
    if (individual < 500) return 1900;
    if (yy <= 39) return 2000;
    if (individual >= 900) return 1900;
    if (individual < 750 && yy >= 54) return 1800;
    return 0;
  }

  function norwegianCheckDigit(digits, weights) {
    return (11 - (weightedSum(digits, weights) % 11)) % 11;
  }

  function fodselsnummerValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{11}$/.test(digits)) return false;
    const day = Number(digits.slice(0, 2)) % 40;
    const month = Number(digits.slice(2, 4)) % 40;
    const yy = Number(digits.slice(4, 6));
    const century = norwegianCentury(Number(digits.slice(6, 9)), yy);
    if (!century || !pastBirthDate(century + yy, month, day)) return false;
    if (norwegianCheckDigit(digits, [3, 7, 6, 1, 8, 9, 4, 5, 2]) !== Number(digits[9])) return false;
    return norwegianCheckDigit(digits, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) === Number(digits[10]);
  }

  // Finland's HETU: DDMMYY, a century sign (+ 1800s; - or U-Y 1900s; A-F 2000s), serial, a mod-31 check
  // character.
  const HETU_CHECK = "0123456789ABCDEFHJKLMNPRSTUVWXY";
  const HETU_VALUE = String.raw`\d{6}[-+A-FU-Y]\d{3}[\dA-FHJ-NPR-Y]`;
  const HETU_WHOLE = new RegExp(`^(?:${HETU_VALUE})$`);

  function hetuYear(hetu) {
    const yy = Number(hetu.slice(4, 6));
    if (hetu[6] === "+") return 1800 + yy;
    if (/[A-F]/.test(hetu[6])) return 2000 + yy;
    return 1900 + yy;
  }

  function hetuValid(value) {
    const hetu = value.toUpperCase();
    if (!HETU_WHOLE.test(hetu)) return false;
    if (!pastBirthDate(hetuYear(hetu), Number(hetu.slice(2, 4)), Number(hetu.slice(0, 2)))) return false;
    return HETU_CHECK[Number(hetu.slice(0, 6) + hetu.slice(7, 10)) % 31] === hetu[10];
  }

  // Iceland's kennitala: DDMMYY, two digits, a mod-11 check digit, a century digit (8, 9 or 0). Companies add 40
  // to the day and aren't a person's number.
  const KENNITALA_VALUE = String.raw`\d{6}[- ]?\d{4}`;
  const KENNITALA_CENTURY = { 8: 1800, 9: 1900, 0: 2000 };

  function kennitalaValid(value) {
    const digits = idCharacters(value);
    const century = KENNITALA_CENTURY[digits[9]];
    if (!/^\d{10}$/.test(digits) || !century) return false;
    const year = century + Number(digits.slice(4, 6));
    if (!pastBirthDate(year, Number(digits.slice(2, 4)), Number(digits.slice(0, 2)))) return false;
    const remainder = weightedSum(digits, [3, 2, 7, 6, 5, 4, 3, 2]) % 11;
    return remainder !== 1 && (11 - remainder) % 11 === Number(digits[8]);
  }

  // Portugal's NIF: nine digits, the last a mod-11 check digit.
  const PT_NIF_VALUE = String.raw`\d{3}[ .]?\d{3}[ .]?\d{3}`;

  function ptNifValid(value) {
    const digits = idCharacters(value);
    if (!/^[1-9]\d{8}$/.test(digits)) return false;
    const remainder = weightedSum(digits, [9, 8, 7, 6, 5, 4, 3, 2]) % 11;
    return (remainder < 2 ? 0 : 11 - remainder) === Number(digits[8]);
  }

  // Romania's CNP: sex and century, YYMMDD, county (01-52, or 70), serial, a mod-11 check digit (10 written 1).
  // Residents (7, 8, 9) don't say their century.
  const CNP_CENTURY = { 1: [1900], 2: [1900], 3: [1800], 4: [1800], 5: [2000], 6: [2000] };

  function cnpValid(value) {
    const digits = idCharacters(value);
    if (!/^[1-9]\d{12}$/.test(digits)) return false;
    const yy = Number(digits.slice(1, 3));
    const centuries = CNP_CENTURY[digits[0]] || [1900, 2000];
    const born = centuries.some((century) =>
      pastBirthDate(century + yy, Number(digits.slice(3, 5)), Number(digits.slice(5, 7))),
    );
    const county = Number(digits.slice(7, 9));
    if (!born || county < 1 || (county > 52 && county !== 70)) return false;
    return mod11CheckDigit(digits, [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9], 1) === Number(digits[12]);
  }

  // Bulgaria's EGN: YYMMDD (month +20 for the 1800s, +40 for the 2000s), serial, a mod-11 check digit (10 is 0).
  function egnCentury(month) {
    if (month > 40) return 2000;
    if (month > 20) return 1800;
    return 1900;
  }

  function egnValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{10}$/.test(digits)) return false;
    const month = Number(digits.slice(2, 4));
    const year = egnCentury(month) + Number(digits.slice(0, 2));
    if (!pastBirthDate(year, month % 20, Number(digits.slice(4, 6)))) return false;
    return mod11CheckDigit(digits, [2, 4, 8, 5, 10, 9, 7, 3, 6], 0) === Number(digits[9]);
  }

  // Czechia and Slovakia's rodné číslo: YYMMDD (month +50 for women, +20 or +70 when a day runs out), a slash, then
  // three digits (before 1954) or four, the whole a multiple of 11 (or ending 0 when the first nine leave 10).
  const RODNE_CISLO_VALUE = String.raw`\d{6}[ \t]?\/?[ \t]?\d{3,4}`;

  function rodneCisloYear(digits) {
    const yy = Number(digits.slice(0, 2));
    return digits.length === 10 && yy < 54 ? 2000 + yy : 1900 + yy;
  }

  function rodneCisloMonth(written) {
    if (written > 70) return written - 70;
    if (written > 50) return written - 50;
    if (written > 20) return written - 20;
    return written;
  }

  function rodneCisloValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{9,10}$/.test(digits)) return false;
    const year = rodneCisloYear(digits);
    if (digits.length === 9 && year >= 1954) return false;
    const month = rodneCisloMonth(Number(digits.slice(2, 4)));
    if (!pastBirthDate(year, month, Number(digits.slice(4, 6)))) return false;
    return digits.length === 9 || (Number(digits.slice(0, 9)) % 11) % 10 === Number(digits[9]);
  }

  // Croatia's OIB: 11 digits with the ISO 7064 MOD 11,10 check.
  function oibValid(value) {
    const digits = idCharacters(value);
    return /^\d{11}$/.test(digits) && iso7064Mod11x10Valid(digits);
  }

  // Greece: AMKA (social security) is DDMMYY, four digits and a Luhn digit; AFM (tax) has nine digits, the last
  // a check of the others weighted by powers of two.
  function amkaValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{11}$/.test(digits) || !validLuhn(digits.padStart(14, "0"))) return false;
    const yy = Number(digits.slice(4, 6));
    return [1900, 2000].some((century) =>
      pastBirthDate(century + yy, Number(digits.slice(2, 4)), Number(digits.slice(0, 2))),
    );
  }

  function afmValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{9}$/.test(digits) || digits === "000000000") return false;
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += Number(digits[i]) * 2 ** (8 - i);
    return (sum % 11) % 10 === Number(digits[8]);
  }

  // Austria's social insurance number: three digits, a mod-11 check digit, then the birth date as DDMMYY.
  const AUSTRIAN_SVNR_VALUE = String.raw`\d{4}[ \t]?\d{6}`;

  function austrianSvnrValid(value) {
    const digits = idCharacters(value);
    if (!/^[1-9]\d{9}$/.test(digits)) return false;
    const day = Number(digits.slice(4, 6));
    const month = Number(digits.slice(6, 8));
    if (day < 1 || day > 31 || month < 1 || month > 12) return false;
    const remainder = weightedSum(digits, [3, 7, 9, 0, 5, 8, 4, 2, 1, 6]) % 11;
    return remainder !== 10 && remainder === Number(digits[3]);
  }

  // Germany's pension (social insurance) number: area, DDMMYY, the surname's first letter, serial, and a check
  // digit over all of them with the letter as its place in the alphabet.
  const GERMAN_RVNR_VALUE = String.raw`\d{2}[ \t]?\d{6}[ \t]?[A-Z][ \t]?\d{3}`;
  const GERMAN_RVNR_WEIGHTS = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];

  function germanRvnrValid(value) {
    const parts = /^(\d{2})(\d{2})(\d{2})(\d{2})([A-Z])(\d{3})$/.exec(idCharacters(value));
    if (!parts) return false;
    const [, area, day, month, yy, letter, serial] = parts;
    if (Number(area) < 2 || Number(area) > 89) return false;
    const born = [1900, 2000].some((century) => pastBirthDate(century + Number(yy), Number(month), Number(day)));
    if (!born) return false;
    const letterNumber = String(letter.charCodeAt(0) - 64).padStart(2, "0");
    const digits = area + day + month + yy + letterNumber + serial.slice(0, 2);
    // Each product's digits are added, as in 7 × 8 = 56 adding 5 + 6.
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const product = GERMAN_RVNR_WEIGHTS[i] * Number(digits[i]);
      sum += Math.floor(product / 10) + (product % 10);
    }
    return sum % 10 === Number(serial[2]);
  }

  // Estonia's isikukood and Lithuania's asmens kodas: sex and century, YYMMDD, serial, a two-stage mod-11 check.
  function isikukoodValid(value) {
    const digits = idCharacters(value);
    if (!/^[1-6]\d{10}$/.test(digits)) return false;
    const century = 1800 + 100 * Math.floor((Number(digits[0]) - 1) / 2);
    const year = century + Number(digits.slice(1, 3));
    if (!pastBirthDate(year, Number(digits.slice(3, 5)), Number(digits.slice(5, 7)))) return false;
    let remainder = weightedSum(digits, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1]) % 11;
    if (remainder === 10) remainder = (weightedSum(digits, [3, 4, 5, 6, 7, 8, 9, 1, 2, 3]) % 11) % 10;
    return remainder === Number(digits[10]);
  }

  // Latvia's personas kods: DDMMYY, a century digit, serial, check; codes issued since 2017 start with 32 and carry
  // neither a date nor a check.
  const PERSONAS_KODS_VALUE = String.raw`\d{6}-?\d{5}`;
  const PERSONAS_KODS_CENTURY = { 0: 1800, 1: 1900, 2: 2000 };

  function personasKodsValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{11}$/.test(digits)) return false;
    if (digits.startsWith("32")) return true;
    const century = PERSONAS_KODS_CENTURY[digits[6]];
    if (!century) return false;
    const year = century + Number(digits.slice(4, 6));
    if (!pastBirthDate(year, Number(digits.slice(2, 4)), Number(digits.slice(0, 2)))) return false;
    return (1101 - weightedSum(digits, [1, 6, 3, 7, 9, 10, 5, 8, 4, 2])) % 11 === Number(digits[10]);
  }

  // Slovenia's EMŠO (the JMBG of former Yugoslavia): DDMM, the year's last three digits, region, serial, mod-11.
  function emsoValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{13}$/.test(digits)) return false;
    const yyy = Number(digits.slice(4, 7));
    const year = yyy >= 800 ? 1000 + yyy : 2000 + yyy;
    if (!pastBirthDate(year, Number(digits.slice(2, 4)), Number(digits.slice(0, 2)))) return false;
    const remainder = weightedSum(digits, [7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) % 11;
    return remainder !== 1 && (11 - remainder) % 11 === Number(digits[12]);
  }

  // Hungary: the TAJ (health insurance) number has eight digits and a check of them weighted 3 and 7; the tax ID
  // (adóazonosító jel) starts with 8, then the birth date as days since 1867, serial, a mod-11 check.
  const TAJ_VALUE = String.raw`\d{3}[ -]?\d{3}[ -]?\d{3}`;

  function tajValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{9}$/.test(digits) || digits === "000000000") return false;
    return weightedSum(digits, [3, 7, 3, 7, 3, 7, 3, 7]) % 10 === Number(digits[8]);
  }

  function hungarianTaxIdValid(value) {
    const digits = idCharacters(value);
    if (!/^8\d{9}$/.test(digits) || Number(digits.slice(1, 6)) > (NOW_YEAR - 1867) * 366) return false;
    const remainder = weightedSum(digits, [1, 2, 3, 4, 5, 6, 7, 8, 9]) % 11;
    return remainder !== 10 && remainder === Number(digits[9]);
  }

  // Poland's NIP (tax ID): ten digits, often grouped 3-3-2-2 or 3-2-2-3, the last a mod-11 check digit.
  const NIP_VALUE = String.raw`\d{3}-?\d{3}-?\d{2}-?\d{2}|\d{3}-\d{2}-\d{2}-\d{3}|\d{3} \d{3} \d{2} \d{2}`;

  function nipValid(value) {
    const digits = idCharacters(value);
    if (!/^\d{10}$/.test(digits)) return false;
    const remainder = weightedSum(digits, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
    return remainder !== 10 && remainder === Number(digits[9]);
  }

  // ── Aadhaar, Tax File Number, Australian Medicare ─
  // India's Aadhaar (12 digits, Verhoeff check) and Australia's Tax File Number (9 digits, weighted check),
  // after their label.

  const AADHAAR_LABELS = [/\b(?:aadhaar|aadhar|UIDAI?)(?:\s+(?:card\s+)?(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  const TFN_LABELS = [/\b(?:TFN|tax\s+file\s+number)\s*(?:is\s*)?[:#-]?\s*/gi];
  // Verhoeff's two tables: how two digits combine, and how each digit is shuffled by its place.
  const VERHOEFF_MULTIPLY = [
    "0123456789",
    "1234067895",
    "2340178956",
    "3401289567",
    "4012395678",
    "5987604321",
    "6598710432",
    "7659821043",
    "8765932104",
    "9876543210",
  ];
  const VERHOEFF_PERMUTE = [
    "0123456789",
    "1576283094",
    "5803796142",
    "8916043527",
    "9453126870",
    "4286573901",
    "2793806415",
    "7046913258",
  ];

  function verhoeffValid(digits) {
    let check = 0;
    const reversed = [...digits].reverse();
    for (let i = 0; i < reversed.length; i++) {
      const shuffled = Number(VERHOEFF_PERMUTE[i % 8][Number(reversed[i])]);
      check = Number(VERHOEFF_MULTIPLY[check][shuffled]);
    }
    return check === 0;
  }

  function aadhaarValid(digits) {
    return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
  }

  const TFN_WEIGHTS = [1, 4, 3, 7, 5, 8, 6, 9, 10];

  function tfnValid(digits) {
    return /^\d{9}$/.test(digits) && weightedSum(digits, TFN_WEIGHTS) % 11 === 0;
  }

  // Australian Medicare card: 10 digits (or 11 with the person's number), first 2-6, check digit 9th.
  const AU_MEDICARE_LABELS = [/\bmedicare(?:\s+card)?(?:\s+(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  const MEDICARE_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9];

  function auMedicareValid(digits) {
    if (!/^[2-6]\d{9,10}$/.test(digits)) return false;
    return weightedSum(digits, MEDICARE_WEIGHTS) % 10 === Number(digits[8]);
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
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
    AU_MEDICARE_LABELS,
    auMedicareValid,
  };
})();

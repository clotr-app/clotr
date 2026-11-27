// findBirthDates(): a date right after a birth word, in digits or spelled out.
(() => {
  "use strict";

  const { NUM_WORDS } = globalThis.ClotrInternal;

  // ---------- Dates of birth (only next to a birth word, since a plain date isn't personal) ----------

  // Only right after a birth word, since a plain date isn't personal: "born 3/14/1948", "DOB: 1948-03-14",
  // "born on the fourteenth of March nineteen forty eight".
  const BIRTH_MONTHS =
    "january|february|march|april|may|june|july|august|september|october|november|december|" +
    "jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
  const ORDINAL_WORDS =
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|" +
    "fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth";
  // "twenty-first", "thirty first".
  const COMPOUND_ORDINAL = String.raw`(?:twenty|thirty)[\s-]+(?:${ORDINAL_WORDS})`;
  const BIRTH_DAY = String.raw`(?:\d{1,2}(?:st|nd|rd|th)?|${COMPOUND_ORDINAL}|(?:${ORDINAL_WORDS}))`;
  // "nineteen eighty seven", "nineteen oh five", "two thousand and three".
  const SPOKEN_CENTURY_YEAR = String.raw`(?:eighteen|nineteen|twenty)(?:[\s-]+(?:oh|${NUM_WORDS})){1,2}`;
  const SPOKEN_2000S_YEAR = String.raw`two\s+thousand(?:\s+and)?(?:[\s-]+(?:${NUM_WORDS}))?`;
  const BIRTH_YEAR = String.raw`(?:\d{4}|'\d{2}|${SPOKEN_CENTURY_YEAR}|${SPOKEN_2000S_YEAR})`;
  // Year first takes a slash or a dot too ("1987/04/12"), and a form's "12-Apr-1987" its dashes.
  const NUMERIC_DATE = String.raw`\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})`;
  const YEAR_FIRST_DATE = String.raw`\d{4}[/.-]\d{1,2}[/.-]\d{1,2}`;
  const FORM_DATE = String.raw`(?:0?[1-9]|[12]\d|3[01])-(?:${BIRTH_MONTHS})-(?:\d{4}|\d{2})`;
  // "March 14, 1948" and "the fourteenth of March".
  const MONTH_FIRST_DATE = String.raw`(?:${BIRTH_MONTHS})\.?\s+${BIRTH_DAY}(?:,?\s+${BIRTH_YEAR})?`;
  const DAY_FIRST_DATE = String.raw`${BIRTH_DAY}\s+(?:of\s+)?(?:${BIRTH_MONTHS})\.?(?:,?\s+${BIRTH_YEAR})?`;
  const BIRTH_DATE_RE = new RegExp(
    String.raw`(?:${NUMERIC_DATE}|${YEAR_FIRST_DATE}|${FORM_DATE}|${MONTH_FIRST_DATE}|${DAY_FIRST_DATE})(?![\w/])`,
    "iy",
  );
  // Also a data key like "dob": "1948-03-14".
  const BIRTH_WORD = String.raw`\b(?:born|birthday|b-?day|birth[\s_]*date|date[\s_]+of[\s_]+birth|d\.?o\.?b\.?)`;
  const KEY_OR_SPACE = String.raw`(?:["']?\s*[:=-]\s*["']?|\s+)`;
  const BIRTH_WORDS = new RegExp(String.raw`${BIRTH_WORD}${KEY_OR_SPACE}(?:(?:is|was|on|the)\s+)*`, "gi");

  // Spanish: "nací el 14 de marzo de 1962", "mi cumpleaños es el 3 de julio".
  const SPANISH_MONTHS =
    "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
  const SPANISH_BIRTH_NUMBERS =
    "cero|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|" +
    "dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiún|veintidós|" +
    "veintidos|veintitrés|veintitres|veinticuatro|veinticinco|veintiséis|veintiseis|veintisiete|" +
    "veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa";
  const SPANISH_BIRTH_DAY = String.raw`(?:\d{1,2}|primero|(?:${SPANISH_BIRTH_NUMBERS})(?:\s+y\s+uno)?)`;
  // "mil novecientos", "dos mil".
  const SPANISH_CENTURY = String.raw`(?:mil\s+(?:novecientos|ochocientos)|dos\s+mil)`;
  const SPANISH_BIRTH_YEAR = String.raw`(?:\d{4}|${SPANISH_CENTURY}(?:\s+(?:y\s+)?(?:${SPANISH_BIRTH_NUMBERS})){0,3})`;
  // "14 de marzo de 1962", "tres de julio".
  const SPANISH_DAY_MONTH = String.raw`${SPANISH_BIRTH_DAY}\s+de\s+(?:${SPANISH_MONTHS})`;
  const SPANISH_WORDS_DATE = String.raw`${SPANISH_DAY_MONTH}(?:\s+(?:de|del)\s+${SPANISH_BIRTH_YEAR})?`;
  const SPANISH_BIRTH_DATE_RE = new RegExp(
    String.raw`(?:${NUMERIC_DATE}|${YEAR_FIRST_DATE}|${SPANISH_WORDS_DATE})(?![\p{L}\d/])`,
    "iuy",
  );
  // "nací", "nacido el …", "fecha de nacimiento", a form's "F. nac." and "cumpleaños".
  const WAS_BORN = String.raw`nac[ií]|naci[oó]|nacid[oa]s?`;
  const FORM_NAC = String.raw`(?:fecha\s+|f\.\s?)(?:de\s+)?nac\.?`;
  const SPANISH_BIRTH_WORD = String.raw`(?:${WAS_BORN}|(?:fecha\s+de\s+)?nacimiento|${FORM_NAC}|cumplea(?:ñ|n)os)`;
  const SPANISH_BIRTH_WORDS = new RegExp(
    String.raw`(?<![\p{L}])${SPANISH_BIRTH_WORD}(?:\s*:\s*|\s+)(?:(?:es|fue|el|en\s+el)\s+)*`,
    "giu",
  );

  function validNumericDate(date) {
    const [first, second, third] = date.split(/[/.-]/).map(Number);
    if (first > 31) return second >= 1 && second <= 12 && third >= 1 && third <= 31; // yyyy-mm-dd
    if (first < 1 || second < 1) return false;
    return (first <= 12 && second <= 31) || (second <= 12 && first <= 31); // m/d or d/m
  }

  // "99/99/1980" is digits only but no date.
  function numericButInvalid(date) {
    return /^[\d/.-]+$/.test(date) && !validNumericDate(date);
  }

  // The date right after each birth word, if there is one.
  function datesAfter(text, birthWords, dateRe) {
    const dates = [];
    for (const word of text.matchAll(birthWords)) {
      dateRe.lastIndex = word.index + word[0].length;
      const date = dateRe.exec(text);
      if (!date || numericButInvalid(date[0])) continue;
      dates.push(date[0]);
    }
    return dates;
  }

  function findBirthDates(text) {
    return [
      ...datesAfter(text, BIRTH_WORDS, BIRTH_DATE_RE),
      ...datesAfter(text, SPANISH_BIRTH_WORDS, SPANISH_BIRTH_DATE_RE),
    ];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findBirthDates };
})();

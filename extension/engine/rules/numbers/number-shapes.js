// Reading a run of number groups: phone, SSN and card shapes, counts and repeats, and release or file names.
// Phones, cards, SSNs and the ID rules ask these what a run looks like.
(() => {
  "use strict";

  const { validLuhn, isLetter } = globalThis.ClotrInternal;

  // ---------- Reading a run ----------

  // ── Reading a run of number groups ─────────────────

  function lastItem(items) {
    return items[items.length - 1];
  }

  // Where the run's groups end, past any trailing words.
  function groupsEnd(run) {
    return lastItem(lastItem(run.groups)).end;
  }

  function spanText(text, groups) {
    return text.slice(groups[0][0].start, lastItem(groups[groups.length - 1]).end);
  }

  // The text between group i and the one before it.
  function gapBefore(text, groups, i) {
    return text.slice(lastItem(groups[i - 1]).end, groups[i][0].start);
  }

  // A run over 16 groups keeps its digits once they're read. "0.1234567" pasted over and over is one run of
  // thousands of groups, and rebuilding its digits for every rule grew faster than the paste did.
  const longRunDigits = new WeakMap();
  function digitsOf(groups) {
    const long = groups.length > 16;
    if (long && longRunDigits.has(groups)) return longRunDigits.get(groups);
    let digits = "";
    for (const group of groups) {
      for (const unit of group) if (unit.digits != null) digits += unit.digits;
    }
    if (long) longRunDigits.set(groups, digits);
    return digits;
  }

  function hasNumberWord(groups) {
    return groups.flat().some((unit) => unit.isWord);
  }

  function digitCount(group) {
    return group.reduce((total, unit) => total + unit.digits.length, 0);
  }

  // "3,3,4" for "555 123 4567".
  function numberGroupSizes(groups) {
    return groups.map(digitCount).join(",");
  }

  // "4242424242": the same 1, 2 or 3 digits over and over.
  function repeatsEvery(digits, step) {
    return [...digits].every((digit, i) => i < step || digit === digits[i - step]);
  }

  function chant(digits) {
    return [1, 2, 3].some((step) => repeatsEvery(digits, step));
  }

  // A count: numbers that go up or down by one each step, like "6 7 8 9 10".
  function countsByOne(values) {
    const step = values[1] - values[0];
    if (Math.abs(step) !== 1) return false;
    return values.every((value, i) => i === 0 || value - values[i - 1] === step);
  }

  // ---------- Shapes of phones, SSNs and cards ----------

  // ── Phone, SSN and card shapes ─────────────────────

  // North American: area code and exchange can't start with 0 or 1.
  const NANP10 = /^[2-9]\d{2}[2-9]\d{6}$/;
  const TOLL_FREE = /^1?8(?:00|33|44|55|66|77|88)/;
  // Same rule as findSSNs: area not 000, 666 or 9xx, group not 00, serial not 0000.
  const VALID_SSN_SHAPE = /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/;

  // Spanish mobiles start with 6 or 7, landlines with 8 or 9.
  function wholePhone(digits, spanish) {
    if (NANP10.test(digits)) return true;
    if (digits[0] === "1" && NANP10.test(digits.slice(1))) return true;
    return spanish && /^[6-9]\d{8}$/.test(digits);
  }

  // A spelled-out SSN is looser than a card, so it also needs a clear typo like "to" for "two" (simple).
  function wholeSsnOrCard(digits, simple) {
    const cardShaped = digits.length >= 13 && digits.length <= 19 && /^[3-6]/.test(digits);
    if (cardShaped && validLuhn(digits)) return true;
    return simple && digits.length === 9 && VALID_SSN_SHAPE.test(digits);
  }

  // Toll-free numbers belong to businesses and help lines, never a person.
  function tollFree(digits) {
    if (digits.length === 9) return /^[89]00/.test(digits); // Spain
    if (digits.length === 10) return TOLL_FREE.test("1" + digits);
    if (digits.length === 11) return TOLL_FREE.test(digits);
    return false;
  }

  function isPhone(groups, wholeRun) {
    const digits = digitsOf(groups);
    // "one two … nine" is a 9-digit SSN, so spelled-out phones must be the whole run.
    if (hasNumberWord(groups) && !wholeRun) return false;
    if (digits.length === 10) return NANP10.test(digits);
    if (digits.length === 11) return digits[0] === "1" && NANP10.test(digits.slice(1));
    // A bare "5555636" is more often an amount or ID, so 7 digits need a phone's grouping.
    if (digits.length === 7) {
      return /^[2-9]/.test(digits) && (hasNumberWord(groups) || numberGroupSizes(groups) === "3,4");
    }
    return false;
  }

  // "+44 20 7946 0958", "0044 …" or "plus four four …", at most 15 digits after the prefix.
  // A solid run starting "00" is more often an ID, so without a "+" it needs pieces or a phone word.
  function internationalPhone(text, run) {
    const start = run.units[0].start;
    const plus = /(?:\+|\bplus\s+)$/i.exec(text.slice(Math.max(0, start - 6), start));
    let digits = digitsOf(run.groups);
    if (!plus && !/^00[1-9]/.test(digits)) return null;
    if (!plus && run.groups.length < 2 && !phoneContextBefore(text, run)) return null;
    if (!plus) digits = digits.slice(2);
    if (digits[0] === "1" || digits[0] === "0") return null; // +1 is North American, read elsewhere

    const prefixLength = plus ? 0 : 2;
    let lastGroup = 0;
    let total = 0;
    for (let i = 0; i < run.groups.length; i++) {
      total += digitsOf([run.groups[i]]).length;
      if (total - prefixLength > 15) break;
      lastGroup = i;
    }
    const kept = digitsOf(run.groups.slice(0, lastGroup + 1)).length - prefixLength;
    if (kept < 8) return null;
    return text.slice(start - (plus ? plus[0].length : 0), lastItem(run.groups[lastGroup]).end);
  }

  // A phone cut out of a longer run has to be phone-shaped, so "1, 2, 3, 5, 8, 13, 21, 34" isn't one.
  const PHONE_SHAPES = new Set(["10", "11", "3,3,4", "1,3,3,4", "3,4", "3,7"]);

  function allDigits(group) {
    return group.every((unit) => unit.kind === "digit");
  }

  // Six or more digit groups split by spaces are a list, like a row of readings. Two neighbours from its
  // middle can fit a phone by chance ("824 1992"), so only a slice at the list's start or end can be one.
  function spacedList(text, groups) {
    if (groups.length < 6) return false;
    if (!groups.every(allDigits)) return false;
    return groups.every((_, i) => i === 0 || /^[ \t]+$/.test(gapBefore(text, groups, i)));
  }

  // Digits glued to letters belong to a hash, UUID or model number.
  // An extension ("555-555-0136x12") doesn't count as a letter.
  function glued(text, span) {
    const first = span[0][0];
    const last = lastItem(lastItem(span));
    if (first.kind === "digit" && isLetter(text[first.start - 1])) return true;
    const extension = /^x\d{1,5}\b/i.test(text.slice(last.end, last.end + 7));
    return last.kind === "digit" && isLetter(text[last.end]) && !extension;
  }

  // ── Release and file names ─────────────────────────

  // "Title.Part.Two.2024.2160p.REMUX" names a file, and so does a number glued to "2160p" or "x265".
  // Each side looks at most 80 characters, so a huge paste stays linear.
  const FILENAME_WINDOW = 80;

  // [A-Za-z0-9.] by character code: this runs on every character beside a number.
  function isFileNameCode(code) {
    if (code >= 48 && code <= 57) return true;
    if ((code | 32) >= 97 && (code | 32) <= 122) return true;
    return code === 46;
  }

  function sideToken(text, pos, step) {
    let i = pos;
    let length = 0;
    while (i >= 0 && i < text.length && length < FILENAME_WINDOW && isFileNameCode(text.charCodeAt(i))) {
      i += step;
      length++;
    }
    return step < 0 ? text.slice(i + 1, pos + 1) : text.slice(pos, i);
  }

  function inFileName(text, run) {
    const first = run.units[0].start;
    const end = lastItem(run.units).end;
    if (/^x\d{1,5}\b/i.test(text.slice(end, end + 7))) return false; // a phone extension
    const before = sideToken(text, first - 1, -1);
    const after = sideToken(text, end, 1);
    const number = text.slice(first, end);
    const parts = (before + number + after).split(".");
    if (parts.length >= 3 && /[A-Za-z]/.test(before) && /[A-Za-z]/.test(after)) return true;
    if (/^(?:2160|1440|1080|720|480)p$/i.test(number + after)) return true;
    return /^(?:x265|x264|h265|h264)$/i.test(before + number);
  }

  // ---------- Words just before a number ----------

  // ── Phone words and SSN labels just before ─────────

  // After "llámame al …" or "my cell is …", 9 digits are a phone (Spain, much of Europe and Latin America).
  const ENGLISH_PHONE_WORDS = "call|text|phone|cell|mobile|whatsapp|tel";
  const SPANISH_PHONE_WORDS = "ll[aá]mame|llamar|llama|tel[eé]fono|m[oó]vil|celular|fijo|n[uú]mero";
  const PHONE_CONTEXT = new RegExp(
    String.raw`(?:\b(?:${ENGLISH_PHONE_WORDS})|${SPANISH_PHONE_WORDS})\b[^\d\n]{0,20}$`,
    "i",
  );
  // "ssn: 219099999" or "social security #…" beats a phone word further back.
  const SSN_NUMBER_WORD = String.raw`(?:[\s_]+(?:number|no\.?|#))?`;
  const SSN_SHORT = String.raw`s\.?s\.?n\.?|ss\s*#`;
  const SOC_SEC = String.raw`soc(?:ial)?\.?\s+sec(?:urity|\.)?${SSN_NUMBER_WORD}`;
  const SOCIAL_SECURITY = String.raw`social(?:[\s_]+security)?${SSN_NUMBER_WORD}`;
  const SSN_LABEL = new RegExp(
    String.raw`\b(?:${SSN_SHORT}|${SOC_SEC}|${SOCIAL_SECURITY})["']?\s*(?:is\s*)?[:=>#-]?\s*["']?$`,
    "i",
  );
  // "confirming who I am", "verify my identity", "quién soy".
  const CONFIRMING = String.raw`\b(?:confirm(?:ing)?|verify(?:ing)?)\b`;
  const WHO_I_AM = String.raw`\b(?:who\s+i\s+am|my\s+identity|identity|it'?s\s+me)\b`;
  const ENGLISH_IDENTITY = String.raw`${CONFIRMING}[^\n]{0,25}${WHO_I_AM}|\bmy\s+identity\b|\bwho\s+i\s+am\b`;
  const SPANISH_IDENTITY = String.raw`qui[eé]n\s+soy|verificar\s+mi\s+identidad|\bmi\s+identidad\b`;
  const SSN_IDENTITY_WORDS = new RegExp(`${ENGLISH_IDENTITY}|${SPANISH_IDENTITY}`, "i");
  const SSN_STRIP = /[\s.,;:!?'"“”‘’()#*-]/g;
  const SSN_WINDOW = 60;

  function ssnLabelBefore(text, run) {
    const start = run.units[0].start;
    const before = text.slice(Math.max(0, start - 30), start);
    return SSN_LABEL.test(before.replace(/\b[A-Za-z]\s*$/, ""));
  }

  function phoneContextBefore(text, run) {
    if (ssnLabelBefore(text, run)) return false;
    const start = run.units[0].start;
    return PHONE_CONTEXT.test(text.slice(Math.max(0, start - 30), start));
  }

  // A bare 9 digits is an SSN only when the message says so: it's just the number, "my number is" and the
  // number, or "verify my identity" nearby. Order, tracking or ZIP context never does.
  function bareSSNContext(text, run) {
    const start = run.units[0].start;
    const end = lastItem(run.units).end;
    // Only a short message can be "just the number", so a long paste isn't scanned for every one.
    if (text.length <= 9 + SSN_WINDOW * 2) {
      const rest = (text.slice(0, start) + text.slice(end)).replace(SSN_STRIP, "").toLowerCase();
      if (rest === "" || rest === "mynumberis") return true;
    }
    const before = text.slice(Math.max(0, start - SSN_WINDOW), start);
    const after = text.slice(end, end + SSN_WINDOW);
    return SSN_IDENTITY_WORDS.test(before) || SSN_IDENTITY_WORDS.test(after);
  }

  // Counting aloud ("one two three … ten", "diez nueve ocho …") isn't a phone or SSN unless a label says so.
  // Number words only: digits keep their own rules.
  function counting(text, run) {
    if (run.units.length < 3) return false;
    if (!run.units.every((unit) => unit.isWord)) return false;
    if (!countsByOne(run.units.map((unit) => Number(unit.digits)))) return false;
    return !ssnLabelBefore(text, run) && !phoneContextBefore(text, run);
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    lastItem,
    groupsEnd,
    spanText,
    gapBefore,
    digitsOf,
    hasNumberWord,
    digitCount,
    numberGroupSizes,
    chant,
    countsByOne,
    NANP10,
    VALID_SSN_SHAPE,
    wholePhone,
    wholeSsnOrCard,
    tollFree,
    isPhone,
    internationalPhone,
    PHONE_SHAPES,
    spacedList,
    glued,
    inFileName,
    PHONE_CONTEXT,
    ssnLabelBefore,
    phoneContextBefore,
    bareSSNContext,
    counting,
  };
})();

// findPhones(): phone numbers, however they're written, but not a number another rule already reads as an ID.
(() => {
  "use strict";

  const {
    isLetter,
    lastItem,
    groupsEnd,
    spanText,
    digitsOf,
    hasNumberWord,
    digitCount,
    numberGroupSizes,
    NANP10,
    tollFree,
    isPhone,
    internationalPhone,
    PHONE_SHAPES,
    spacedList,
    glued,
    inFileName,
    phoneContextBefore,
    counting,
    numberRuns,
    spanishNationalIds,
    spanishPassports,
    spanishLicenses,
    spanishMedicalRecords,
    spanishInsuranceIds,
    localPhone,
    europeanNationalPhone,
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
    listBreakAfter,
    worldNationalIds,
  } = globalThis.ClotrInternal;

  // ---------- Phones and the runs that aren't ----------

  // ── Finding phone numbers ──────────────────────────

  // Every value read after a Spanish ID label (spanish-labelled-ids.js) or as another country's national ID
  // (national-ids.js), so findPhones doesn't also read it as a phone: "número de afiliado 912345678",
  // "mi NSS es 12345678901", "CPF: 123.456.789-09", "PESEL 44051401458".
  function spanishIdValues(text) {
    return [
      ...worldNationalIds(text),
      ...spanishNationalIds(text),
      ...spanishPassports(text),
      ...spanishLicenses(text),
      ...spanishMedicalRecords(text),
      ...spanishInsuranceIds(text),
    ];
  }

  // A phone with one letter glued in front, like "m4155550136".
  const LETTER_THEN_TEN_DIGITS = /(?<![\p{L}\d])([A-Za-z])(\d{10})(?![\p{L}\d])/gu;
  const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  // Amazon prints order numbers this way: "302-4471882-1190245".
  const ORDER_NUMBER_3_7_7 = /^\d{3}-\d{7}-\d{7}$/;

  // A phone wrapped over lines under its label ("my number:" with the number below).
  function wrappedPhones(text) {
    const phones = [];
    for (const wrapped of wrappedNumbers(text, PHONE_LABEL_NEAR)) {
      const before = text.slice(Math.max(0, wrapped.at - 40), wrapped.at);
      if (wrapped.sizes !== "3,3,4" || !NANP10.test(wrapped.digits)) continue;
      if (!SSN_LABEL_NEAR.test(before)) phones.push(wrapped.span);
    }
    return phones;
  }

  // UUIDs are rare, so look for one only around a candidate instead of scanning every paste.
  function overlapsUuid(text, start, end) {
    const from = Math.max(0, start - 37);
    const nearby = text.slice(from, Math.min(text.length, end + 37));
    for (const match of nearby.matchAll(UUID_SHAPE)) {
      const uuidStart = from + match.index;
      if (uuidStart < end && uuidStart + match[0].length > start) return true;
    }
    return false;
  }

  // Most text has no phone candidate, so log shapes are only looked for once one turns up.
  // After that they're the cheapest check, and on a log paste they clear nearly every candidate.
  function logLookup(text) {
    let inRange;
    return (start, end) => {
      if (!inRange) inRange = rangeLookup(logTimestampRanges(text));
      return inRange(start, end);
    };
  }

  // A run's phones sit inside it, except an international one that reaches back up to 6 characters
  // for its "+" or "plus". If all of that sits in one log shape, the run can't give a phone.
  function runInLog(text, run, inLog) {
    const at = run.units[0].start;
    const before = text.slice(Math.max(0, at - 6), at);
    const reachBack = /\+|plus/i.test(before) || before.includes(text[at]);
    const start = Math.min(at, run.groups[0][0].start) - (reachBack ? 6 : 0);
    return inLog(Math.max(0, start), Math.max(lastItem(run.units).end, groupsEnd(run)));
  }

  // Runs labelled or shaped as something else: an order, a code, a file name.
  function notAPhoneRun(text, run) {
    if (labelledAsOther(text, run) || tollFree(digitsOf(run.groups)) || counting(text, run)) return true;
    if (ndcCode(text, run) || inVinCode(text, run.units[0].start) || windowsSid(text, run)) return true;
    if (inFileName(text, run)) return true;
    const written = spanText(text, run.groups);
    if (numberGroupSizes(run.groups) === "3,7,7" && ORDER_NUMBER_3_7_7.test(written)) return true;
    // A local number glued to letters at its end is part of a name, like "fixture-0125/337909e6.png".
    const last = lastItem(lastItem(run.groups));
    const gluedEnd = isLetter(text[last.end]) && last.kind === "digit";
    return gluedEnd && /[/_]/.test(written);
  }

  // "73.162.44.201" has a phone's digits but is an address.
  function isIPv4(written) {
    const parts = IPV4.exec(written);
    return parts !== null && parts.slice(1).every((part) => Number(part) <= 255);
  }

  // Without a "+", a "00" number inside a word or path ("fixture-0044/264107a3.png") is part of a name.
  function internationalInName(text, start, phone) {
    if (!/^00/.test(phone)) return false;
    if (/[\p{L}\d][-_]$|\/$/u.test(text.slice(Math.max(0, start - 2), start))) return true;
    const end = start + phone.length;
    return /^(?:[\p{L}]|\.\w)/u.test(text.slice(end, end + 2));
  }

  // ---------- The longest phone in a run ----------
  // Spelled out, a stretch from list break to list break counts as whole ("…six three six, two one nine…"
  // is two numbers). Digits keep the stricter rule, so "1, 2, 3, 5, 8, 13" stays a list.
  function wholeStretch(text, groups, first, last, looseList) {
    if (first === 0 && last === groups.length - 1 && !looseList) return true;
    if (!hasNumberWord(groups.slice(first, last + 1))) return false;
    if (first > 0 && !listBreakAfter(text, groups, first - 1) && !afterBritishZero(text, groups, first)) return false;
    return last === groups.length - 1 || listBreakAfter(text, groups, last);
  }

  // "Nought" and "naught" are the British 0. When one opens a run that isn't a phone whole, like
  // "nought seven four five …" with no phone word near it, the words after it still count as whole,
  // as they did before those two were read as number words.
  const BRITISH_ZERO = /^n[ao]ught$/i;
  function afterBritishZero(text, groups, first) {
    if (first !== 1 || groups[0].length !== 1) return false;
    const zero = groups[0][0];
    return BRITISH_ZERO.test(text.slice(zero.start, zero.end));
  }

  // The last group of the longest phone that starts at `first`, or -1.
  function longestPhoneEnd(text, groups, first, list) {
    let bestEnd = -1;
    let digits = 0;
    for (let last = first; last < groups.length; last++) {
      digits += digitCount(groups[last]);
      if (digits > 11) break;
      if (digits !== 7 && digits < 10) continue; // a phone has 7, 10 or 11 digits (isPhone)
      if (list.spaced && first > 0 && last < groups.length - 1) continue;
      const span = groups.slice(first, last + 1);
      const wholeRun = wholeStretch(text, groups, first, last, list.loose);
      if (!wholeRun && !hasNumberWord(span) && !PHONE_SHAPES.has(numberGroupSizes(span))) continue;
      if (glued(text, span)) continue;
      if (!list.nearPhoneWord && commaSplit(text, span)) continue;
      if (isPhone(span, wholeRun)) bestEnd = last;
    }
    return bestEnd;
  }

  function findPhones(text) {
    const found = wrappedPhones(text);
    const inLog = logLookup(text);

    function addPhone(start, end) {
      if (inLog(start, end)) return;
      if (overlapsUuid(text, start, end) || inHexGroups(text, start, end)) return;
      if (partOfOtherNumber(text, start, end)) return;
      if (!/[+()-]/.test(text.slice(start, end)) && amountOrCount(text, start, end)) return;
      found.push(text.slice(start, end));
    }

    for (const match of text.matchAll(LETTER_THEN_TEN_DIGITS)) {
      const start = match.index + match[0].indexOf(match[2]);
      if (/^[2-9]\d{9}$/.test(match[2]) && !inVinCode(text, start)) addPhone(start, match.index + match[0].length);
    }

    for (const run of numberRuns(text)) {
      // Every phone has at least 7 digits, so most numbers in a message skip the checks below.
      if (digitCount(run.units) < 7) continue;
      if (runInLog(text, run, inLog)) continue;
      if (notAPhoneRun(text, run)) continue;

      // These take the run whole.
      const nineDigitsAfterPhoneWord = () => digitsOf(run.groups).length === 9 && phoneContextBefore(text, run);
      if (localPhone(text, run) || europeanNationalPhone(text, run) || nineDigitsAfterPhoneWord()) {
        addPhone(run.groups[0][0].start, groupsEnd(run));
        continue;
      }
      if (isIPv4(spanText(text, run.groups))) continue;

      const international = internationalPhone(text, run);
      if (international) {
        const start = text.indexOf(international, Math.max(0, run.units[0].start - 6));
        if (start < 0 || internationalInName(text, start, international)) continue;
        addPhone(start, start + international.length);
        continue;
      }

      // Otherwise cut the longest phone from each point in the run. A row of six or more small numbers
      // ("4 8 16 14 44 14", a lottery draw) is a list even whole, unless it's single digits read out
      // one by one or a phone word comes before it.
      const groups = run.groups;
      const spaced = spacedList(text, groups);
      const nearPhoneWord = phoneContextBefore(text, run);
      const list = {
        spaced,
        nearPhoneWord,
        loose: spaced && groups.some((group) => group.length > 1) && !nearPhoneWord,
      };
      let first = 0;
      while (first < groups.length) {
        const bestEnd = longestPhoneEnd(text, groups, first, list);
        if (bestEnd < 0) {
          first++;
          continue;
        }
        // Take an opening "(" or "+" too, so redaction doesn't leave it behind.
        const start = groups[first][0].start;
        const lead = /[(+]/.test(text[start - 1] || "") ? 1 : 0;
        addPhone(start - lead, lastItem(groups[bestEnd]).end);
        first = bestEnd + 1;
      }
    }

    if (!found.length) return found;
    // A value after a Spanish ID label isn't a phone ("número de afiliado 912345678", "mi NSS es …").
    const claimed = spanishIdValues(text);
    return found.filter((phone) => !claimed.some((value) => value.includes(phone)));
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findPhones };
})();

// Number words in each language, their sound-alikes and one-letter typos, and reading one unit of a number.
// number-runs.js builds runs from these, and other rules read the word lists.
(() => {
  "use strict";

  // ---------- Number words, their sound-alikes and typos ----------
  // A number spelled out is still readable over your shoulder, so Clotr reads digits, number words, and both mixed.

  // Digit words and common misspellings. Only "oh" is also an everyday word; the rest of those are SOUND_ALIKES.
  const ENGLISH_NUMBER_WORDS = {
    zero: "0",
    zeero: "0",
    nought: "0",
    naught: "0",
    zro: "0",
    oh: "0",
    sicks: "6",
    siks: "6",
    eigt: "8",
    eihgt: "8",
    nien: "9",
    fiev: "5",
    sevin: "7",
    one: "1",
    two: "2",
    three: "3",
    thre: "3",
    four: "4",
    five: "5",
    fiv: "5",
    six: "6",
    seven: "7",
    sevn: "7",
    seve: "7",
    eight: "8",
    eigth: "8",
    eigh: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
  };
  const SPANISH_NUMBER_WORDS = {
    cero: "0",
    uno: "1",
    dos: "2",
    tres: "3",
    cuatro: "4",
    cinco: "5",
    seis: "6",
    siete: "7",
    ocho: "8",
    nueve: "9",
    // Read out in pairs ("seis cero cero, doce, treinta y cuatro"). "once" (11) is an English word: see SOUND_ALIKES.
    diez: "10",
    doce: "12",
    trece: "13",
    catorce: "14",
    quince: "15",
    dieciseis: "16",
    dieciséis: "16",
    diecisiete: "17",
    dieciocho: "18",
    diecinueve: "19",
    veintiuno: "21",
    veintidos: "22",
    veintidós: "22",
    veintitres: "23",
    veintitrés: "23",
    veinticuatro: "24",
    veinticinco: "25",
    veintiseis: "26",
    veintiséis: "26",
    veintisiete: "27",
    veintiocho: "28",
    veintinueve: "29",
  };
  const NUMBER_WORDS = { ...ENGLISH_NUMBER_WORDS, ...SPANISH_NUMBER_WORDS };
  // "fifty five" is 55 and "fifty" alone is 50; "treinta y cuatro" is 34.
  const ENGLISH_TENS_WORDS = {
    twenty: "2",
    thirty: "3",
    forty: "4",
    fourty: "4",
    fifty: "5",
    sixty: "6",
    seventy: "7",
    eighty: "8",
    ninety: "9",
    ninty: "9",
    nintey: "9",
  };
  const SPANISH_TENS_WORDS = {
    veinte: "2",
    treinta: "3",
    cuarenta: "4",
    cincuenta: "5",
    sesenta: "6",
    setenta: "7",
    ochenta: "8",
    noventa: "9",
  };
  // Spanish hundreds are one word: "quinientos cincuenta y cinco" is 555.
  const HUNDRED_WORDS = {
    cien: "1",
    ciento: "1",
    doscientos: "2",
    doscientas: "2",
    trescientos: "3",
    trescientas: "3",
    cuatrocientos: "4",
    cuatrocientas: "4",
    quinientos: "5",
    quinientas: "5",
    seiscientos: "6",
    seiscientas: "6",
    setecientos: "7",
    setecientas: "7",
    ochocientos: "8",
    ochocientas: "8",
    novecientos: "9",
    novecientas: "9",
  };
  const TENS_WORDS = { ...ENGLISH_TENS_WORDS, ...SPANISH_TENS_WORDS };
  // Everyday words that sound like digits, plus Spanish "once" (11). They only count inside a number (keepSoundAlikes).
  const SOUND_ALIKES = { won: "1", to: "2", too: "2", for: "4", fore: "4", ate: "8", once: "11" };
  // Often right before a number ("text to …", "wait for …"), so never part of one at its edge.
  const NOT_AT_EDGE = new Set(["to", "for"]);
  const SPANISH = new Set([
    ...Object.keys(SPANISH_NUMBER_WORDS),
    ...Object.keys(SPANISH_TENS_WORDS),
    ...Object.keys(HUNDRED_WORDS),
    "mil",
    "once",
  ]);
  // Words read with one typo ("sevne" for seven), only inside a number. Four letters or more: shorter words are one
  // typo from too many everyday words.
  const TYPO_WORDS = {
    zero: "0",
    three: "3",
    four: "4",
    five: "5",
    seven: "7",
    eight: "8",
    nine: "9",
    cero: "0",
    tres: "3",
    cuatro: "4",
    cinco: "5",
    seis: "6",
    siete: "7",
    ocho: "8",
    nueve: "9",
  };
  // Letters that look like digits.
  const LOOK_ALIKES = { O: "0", o: "0", l: "1" };
  // How many places each fills: "five hundred fifty five" is 555, "six thousand seven hundred" is 6700.
  const MULTIPLIERS = { hundred: 2, thousand: 3, mil: 3 };
  // "double five" is 55, "triple seven" is 777.
  const REPEATS = { double: 2, triple: 3 };
  const ALL_WORDS = { ...NUMBER_WORDS, ...TENS_WORDS, ...HUNDRED_WORDS, ...SOUND_ALIKES, ...MULTIPLIERS, ...REPEATS };
  const UNIT_HINT_RE = new RegExp(`\\d|${Object.keys(ALL_WORDS).join("|")}`, "i");
  // Longest words first, so "seventeen" wins over "seven" and "three" over "thre".
  const UNIT_RE = new RegExp(
    `\\d|${Object.keys(ALL_WORDS)
      .sort((a, b) => b.length - a.length)
      .join("|")}|[Ool]`,
    "iy",
  );
  // The ASCII characters a unit can start with, so the reader skips the rest without running UNIT_RE.
  const UNIT_START = new Uint8Array(128);
  for (const first of ["0123456789Ool", ...Object.keys(ALL_WORDS).map((w) => w[0])].join("")) {
    for (const ch of [first, first.toLowerCase(), first.toUpperCase()]) {
      if (ch.charCodeAt(0) < 128) UNIT_START[ch.charCodeAt(0)] = 1;
    }
  }
  // What may sit between digits of one number: spaces, dashes, dots, commas, parentheses, slashes, plus.
  const SEPARATOR_RE = /^[ \t \-–.,()/+_*]{1,3}$/;
  // Runs on nearly every character, so ASCII skips the regex. | 32 turns A-Z into a-z, so one check covers both.
  const LETTER_RE = /\p{L}/u;
  const isLetter = (ch) => {
    if (ch === undefined) return false;
    const code = ch.charCodeAt(0);
    if (code < 128) return (code | 32) >= 97 && (code | 32) <= 122;
    return LETTER_RE.test(ch);
  };
  // Or the separator said as a word: "two one nine dash oh nine".
  const SPOKEN_SEPARATOR_RE = /^\s+(?:dash|hyphen|gui[oó]n)\s+$/i;
  const isGap = (g) => g === "" || SEPARATOR_RE.test(g) || SPOKEN_SEPARATOR_RE.test(g);

  function readUnit(s, start) {
    const w = s.toLowerCase();
    const unit = (digits, kind) => ({
      start,
      end: start + s.length,
      digits,
      kind,
      isWord: kind !== "digit" && kind !== "lookAlike",
      // The word's language; undefined for digits and sound-alikes, which could be either.
      lang: SPANISH.has(w) ? "es" : ["word", "tens", "multiplier", "repeat"].includes(kind) ? "en" : undefined,
    });
    if (/^\d$/.test(s)) return unit(s, "digit");
    if (s.length === 1) return LOOK_ALIKES[s] ? unit(LOOK_ALIKES[s], "lookAlike") : null;
    if (NUMBER_WORDS[w]) return unit(NUMBER_WORDS[w], "word");
    if (TENS_WORDS[w]) return unit(TENS_WORDS[w], "tens");
    if (HUNDRED_WORDS[w]) return unit(HUNDRED_WORDS[w], "hundreds");
    if (MULTIPLIERS[w]) return { ...unit("", "multiplier"), places: MULTIPLIERS[w] };
    if (REPEATS[w]) return { ...unit("", "repeat"), times: REPEATS[w] };
    return { ...unit(SOUND_ALIKES[w], "soundAlike"), edgeOk: !NOT_AT_EDGE.has(w) };
  }

  // True when `typed` is `word` with one letter added, dropped or changed, or two side by side swapped.
  function oneTypo(typed, word) {
    if (typed === word || Math.abs(typed.length - word.length) > 1) return false;
    let i = 0;
    while (i < typed.length && typed[i] === word[i]) i++;
    if (typed.length > word.length) return typed.slice(i + 1) === word.slice(i);
    if (typed.length < word.length) return typed.slice(i) === word.slice(i + 1);
    return (
      typed.slice(i + 1) === word.slice(i + 1) ||
      (typed[i] === word[i + 1] && typed[i + 1] === word[i] && typed.slice(i + 2) === word.slice(i + 2))
    );
  }

  // Every a-z word one typo from a digit word. Prose with none of these and no number words skips the reader.
  const TYPO_WORD_KEYS = Object.keys(TYPO_WORDS);
  const TYPO_CANDIDATES = new Set(TYPO_WORD_KEYS);
  const TYPO_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
  for (const word of TYPO_WORD_KEYS) {
    for (let i = 0; i < word.length; i++) {
      TYPO_CANDIDATES.add(word.slice(0, i) + word.slice(i + 1));
      for (const letter of TYPO_ALPHABET) {
        TYPO_CANDIDATES.add(word.slice(0, i) + letter + word.slice(i + 1));
        TYPO_CANDIDATES.add(word.slice(0, i) + letter + word.slice(i));
      }
    }
    for (let i = 0; i + 1 < word.length; i++) {
      TYPO_CANDIDATES.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    }
    for (const letter of TYPO_ALPHABET) TYPO_CANDIDATES.add(word + letter);
  }
  function hasTypoCandidate(text) {
    for (const m of text.matchAll(/\p{L}+/gu)) {
      const word = m[0].toLowerCase();
      if (word.length < 4 || word.length > 7) continue;
      if (TYPO_CANDIDATES.has(word)) return true;
      if (/[^\x00-\x7f]/.test(word) && TYPO_WORD_KEYS.some((candidate) => oneTypo(word, candidate))) return true;
    }
    return false;
  }

  // A whole word one typo from a digit word, read as a sound-alike. A typo of two digits ("fine": five or nine) isn't.
  const WORD_AT = /\p{L}+/uy;
  const isPlainLower = (w) => /^[a-z]*$/.test(w);
  // A word's reading depends only on the word, so it's kept across texts, up to TYPO_MEMO_MAX words.
  const TYPO_MEMO = new Map();
  const TYPO_MEMO_MAX = 20000;
  function readTypo(text, start) {
    // An a-z word under 4 or over 7 letters is a typo of nothing. (| 32 turns A-Z into a-z.)
    let end = start;
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end) | 32;
      if (code < 97 || code > 122) break;
    }
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (after < 128 && (end - start < 4 || end - start > 7)) return null;
    WORD_AT.lastIndex = start;
    const s = WORD_AT.exec(text)[0];
    // Nor is any other word that short or long. Not kept either: a run of Chinese letters is one long word.
    if (s.length < 4 || s.length > 7) return null;
    const w = s.toLowerCase();
    let cached = TYPO_MEMO.get(w);
    if (cached === undefined) {
      cached = typoOf(s, w);
      if (TYPO_MEMO.size >= TYPO_MEMO_MAX) TYPO_MEMO.clear();
      TYPO_MEMO.set(w, cached);
    }
    return cached ? { start, end: start + s.length, ...cached, kind: "soundAlike", isWord: true, typo: true } : null;
  }
  // { digits, lang } for a word one typo from one digit word, or null.
  function typoOf(s, w) {
    if (s.length < 4 || s.length > 7 || Object.prototype.hasOwnProperty.call(ALL_WORDS, w)) return null;
    // A plain a-z word missing from TYPO_CANDIDATES is a typo of none, so skip comparing it with each digit word.
    if (!TYPO_CANDIDATES.has(w) && isPlainLower(w)) return null;
    const words = TYPO_WORD_KEYS.filter((word) => oneTypo(w, word));
    const digits = new Set(words.map((word) => TYPO_WORDS[word]));
    if (digits.size !== 1) return null;
    const es = words.filter((word) => SPANISH.has(word)).length;
    return { digits: [...digits][0], lang: es === words.length ? "es" : es === 0 ? "en" : undefined };
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    NUMBER_WORDS,
    SOUND_ALIKES,
    TYPO_WORDS,
    ALL_WORDS,
    UNIT_HINT_RE,
    UNIT_RE,
    UNIT_START,
    isLetter,
    isGap,
    readUnit,
    hasTypoCandidate,
    readTypo,
  };
})();

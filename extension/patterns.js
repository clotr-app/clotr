// Every pattern Clotr looks for in a message lives here. detector.js runs them and turns a
// match into a response and a fingerprint.
//
// This is a classic script, not an ES module, because MV3 content scripts can't use `export`.
// Patterns reach content.js through a global namespace instead.
(() => {
  "use strict";

  // Real card numbers pass the Luhn check, so this skips random 16-digit numbers that only look like cards.
  function luhn(candidate) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  }

  // Drops trailing characters that `set` (a one-character class like /[.,;]/) matches, as in a link's closing
  // ")." in a sentence. A regex like /[.,;]+$/ looks the same, but when a long run of those characters has
  // something else after it, it retries the run from every start, so a link with thousands of dots in the middle
  // took quadratic time and froze the tab. Walking back from the end reads each character once.
  function trimTrailing(s, set) {
    let end = s.length;
    while (end > 0 && set.test(s[end - 1])) end--;
    return s.slice(0, end);
  }

  // ---------- Fewer false alarms for credentials ----------

  // Skips placeholder keys from docs and examples, like AWS's own AKIAIOSFODNN7EXAMPLE, since nobody's
  // real key looks like that.
  function isPlaceholder(m) {
    if (/example|your[_-]?(api[_-]?)?(key|token|secret)|placeholder|dummy|redacted|insert[_-]?here/i.test(m)) {
      return true;
    }
    if (/JBSW\s?Y3DP\s?EHPK\s?3PXP/i.test(m)) return true; // the two-step sign-in documentation's example secret
    // An X (Twitter) bearer token starts with a run of A's, and only the rest of it says whether it's real. A Fly.io
    // token is base64 of binary fields, whose zero bytes read as runs of A's anywhere in it, so those don't count.
    const fly = /^FlyV1\s+fm\d_/.exec(m);
    if (fly && m.slice(fly[0].length).replace(/A/g, "").length < 40) return true; // mostly A's: no real fields
    const body = (fly ? m.replace(/A{6,}/g, "A") : m).replace(/^A{20,24}(?=[A-Za-z0-9%]{40})/, "");
    if (/(.)\1{5,}/.test(body)) return true; // six of the same character in a row
    let run = 1; // a long alphabet/number sequence: ABCDEFGH, 12345678
    for (let i = 1; i < body.length; i++) {
      run = body.charCodeAt(i) === body.charCodeAt(i - 1) + 1 && /[A-Za-z0-9]/.test(body[i]) ? run + 1 : 1;
      if (run >= 8) return true;
    }
    return false;
  }

  function entropy(s) {
    const counts = {};
    for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
    return Object.values(counts).reduce((h, c) => h - (c / s.length) * Math.log2(c / s.length), 0);
  }

  // Whether the body has a run of at least `length` characters with no dash or underscore in it. Counting in one
  // pass keeps a value made of hundreds of thousands of dashes from overflowing the stack, as spreading its pieces
  // into Math.max once did.
  function hasUnbrokenRun(body, length) {
    let run = 0;
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);
      run = code === 45 || code === 95 ? 0 : run + 1;
      if (run >= length) return true;
    }
    return false;
  }

  // A prefix like "sk-" can also start an ordinary word, like "sk-learn-". So I check that what follows it
  // actually looks machine-made: mixed case, digits, and long unbroken runs instead of a slug's dashes.
  function looksRandom(body, minLen = 20) {
    return (
      body.length >= minLen &&
      /\d/.test(body) &&
      /[a-z]/.test(body) &&
      /[A-Z]/.test(body) &&
      hasUnbrokenRun(body, Math.min(12, minLen)) &&
      entropy(body) >= 3.5
    );
  }

  // Hex has no case to mix, and some providers don't say which case their letters come in, so a body like that
  // passes on its own terms: digits and letters, a long unbroken run like the one above, and about the spread of
  // characters random hex has. Repeats like "deadbeef", a run of "abcdef" and a snake_case name all fall short.
  function looksRandomAnyCase(body) {
    const s = body.toLowerCase();
    return /\d/.test(s) && /[a-z]/.test(s) && hasUnbrokenRun(s, 12) && entropy(s.replace(/[-_]/g, "")) >= 3;
  }

  function looksRandomLetters(body) {
    return /^[A-Za-z]+$/.test(body) && entropy(body) >= 3.5;
  }

  // ---------- Numbers written any way ----------
  // Spelling a number out doesn't hide it from a person reading over your shoulder, so it shouldn't hide it
  // from Clotr either. This reads a run of digits whether it's typed as digits, spelled out as words, or
  // mixed together, with or without separators between them.

  // ---------- Translations ----------
  // The browser picks the language (Spanish from _locales/es). English is written in the code and is
  // the fallback: a missing translation, or a context lost after an update, never breaks a warning.
  function msg(key, english, ...subs) {
    let text = "";
    try {
      text = globalThis.chrome?.i18n?.getMessage(key, subs.map(String)) || "";
    } catch {
      /* extension context gone: English */
    }
    if (text) return text;
    return subs.length ? english.replace(/\$(\d)/g, (_, n) => String(subs[n - 1] ?? "")) : english;
  }

  // Digit words, including common misspellings. None of these double as an everyday word; the ones that
  // do, like "won" for one, go in WEAK_WORDS below instead.
  const ENGLISH_NUMBER_WORDS = {
    zero: "0",
    zeero: "0",
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
  // Spanish
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
    // Spanish numbers are often read out in pairs ("seis cero cero, doce, treinta y cuatro"). "once" (eleven) is
    // an everyday English word, so it's with the sound-alikes (WEAK_WORDS).
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
  // "Fifty five" reads as 55 and "fifty" alone as 50. Spanish works the same way: "treinta y cuatro" reads as 34.
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
  // Spanish hundreds are one word ("quinientos cincuenta y cinco" = 555).
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
  // Sound-alikes for digits, plus Spanish "once" (eleven). These are also everyday English words, so
  // keepSoftUnits below only counts them when they're inside a number.
  const WEAK_WORDS = { won: "1", to: "2", too: "2", for: "4", fore: "4", ate: "8", once: "11" };
  // The words most often right before a number ("text to …", "wait for …"): never part of it at its edge.
  const NOT_AT_EDGE = new Set(["to", "for"]);
  const SPANISH = new Set([
    ...Object.keys(SPANISH_NUMBER_WORDS),
    ...Object.keys(SPANISH_TENS_WORDS),
    ...Object.keys(HUNDRED_WORDS),
    "mil",
    "once",
  ]);
  // A one-letter typo in these words, like "sevne" for seven, counts too, but only like a sound-alike: inside
  // a spelled-out number, never on its own. I only do this for four-letter-plus words, since shorter ones are
  // one typo away from too many everyday words.
  const SLIP_WORDS = {
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
  const WEAK_LETTERS = { O: "0", o: "0", l: "1" };
  // "five hundred fifty five" = 555, "six thousand seven hundred" = 6700: how many places each fills.
  const MULTIPLIERS = { hundred: 2, thousand: 3, mil: 3 };
  // "double five" = 55, "triple seven" = 777.
  const REPEATS = { double: 2, triple: 3 };
  const ALL_WORDS = { ...NUMBER_WORDS, ...TENS_WORDS, ...HUNDRED_WORDS, ...WEAK_WORDS, ...MULTIPLIERS, ...REPEATS };
  const UNIT_HINT_RE = new RegExp(`\\d|${Object.keys(ALL_WORDS).join("|")}`, "i");
  // Longest words first, so "seventeen" wins over "seven" and "three" over "thre".
  const UNIT_RE = new RegExp(
    `\\d|${Object.keys(ALL_WORDS)
      .sort((a, b) => b.length - a.length)
      .join("|")}|[Ool]`,
    "iy",
  );
  // The plain ASCII characters UNIT_RE can start on (a digit, a number word's first letter in either case, O or l),
  // so the reader skips any other without running it. Any other character still goes through UNIT_RE.
  const UNIT_START = new Uint8Array(128);
  for (const first of ["0123456789Ool", ...Object.keys(ALL_WORDS).map((w) => w[0])].join("")) {
    for (const ch of [first, first.toLowerCase(), first.toUpperCase()]) {
      if (ch.charCodeAt(0) < 128) UNIT_START[ch.charCodeAt(0)] = 1;
    }
  }
  // What may sit between digits of one number: spaces, dashes, dots, commas, parentheses, slashes, plus.
  const SEPARATOR_RE = /^[ \t \-–.,()/+_*]{1,3}$/;
  // It runs for nearly every character of a text, so a plain ASCII character is answered without a regex.
  const LETTER_RE = /\p{L}/u;
  const isLetter = (ch) => {
    if (ch === undefined) return false;
    const code = ch.charCodeAt(0);
    if (code < 128) return ((code | 32) >= 97 && (code | 32) <= 122) || (ch.length > 1 && LETTER_RE.test(ch));
    return LETTER_RE.test(ch);
  };
  // …or the separator said as a word: "two one nine dash oh nine".
  const SPOKEN_SEPARATOR_RE = /^\s+(?:dash|hyphen|gui[oó]n)\s+$/i;
  const isGap = (g) => g === "" || SEPARATOR_RE.test(g) || SPOKEN_SEPARATOR_RE.test(g);

  function readUnit(s, start) {
    const w = s.toLowerCase();
    const unit = (digits, kind) => ({
      start,
      end: start + s.length,
      digits,
      kind,
      isWord: kind !== "digit" && kind !== "letter",
      // which language this word belongs to, left undefined for digits and English sound-alikes since those
      // could be either
      lang: SPANISH.has(w) ? "es" : ["word", "tens", "mult", "rep"].includes(kind) ? "en" : undefined,
    });
    if (/^\d$/.test(s)) return unit(s, "digit");
    if (s.length === 1) return WEAK_LETTERS[s] ? unit(WEAK_LETTERS[s], "letter") : null;
    if (NUMBER_WORDS[w]) return unit(NUMBER_WORDS[w], "word");
    if (TENS_WORDS[w]) return unit(TENS_WORDS[w], "tens");
    if (HUNDRED_WORDS[w]) return unit(HUNDRED_WORDS[w], "hund");
    if (MULTIPLIERS[w]) return { ...unit("", "mult"), places: MULTIPLIERS[w] };
    if (REPEATS[w]) return { ...unit("", "rep"), times: REPEATS[w] };
    return { ...unit(WEAK_WORDS[w], "weak"), atEdge: !NOT_AT_EDGE.has(w) };
  }

  // True when `typed` is `word` with one letter added, dropped or changed, or two side by side swapped.
  function oneSlip(typed, word) {
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

  // A number run with no digits or number words can only start from one of these one-letter slips. A quick pass
  // over whole words lets ordinary prose skip the per-character reader without losing misspelled digit words.
  const SLIP_WORD_KEYS = Object.keys(SLIP_WORDS);
  const SLIP_CANDIDATES = new Set(SLIP_WORD_KEYS);
  const SLIP_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
  for (const word of SLIP_WORD_KEYS) {
    for (let i = 0; i < word.length; i++) {
      SLIP_CANDIDATES.add(word.slice(0, i) + word.slice(i + 1));
      for (const letter of SLIP_ALPHABET) {
        SLIP_CANDIDATES.add(word.slice(0, i) + letter + word.slice(i + 1));
        SLIP_CANDIDATES.add(word.slice(0, i) + letter + word.slice(i));
      }
    }
    for (let i = 0; i + 1 < word.length; i++) {
      SLIP_CANDIDATES.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    }
    for (const letter of SLIP_ALPHABET) SLIP_CANDIDATES.add(word + letter);
  }
  function hasSlipCandidate(text) {
    for (const m of text.matchAll(/\p{L}+/gu)) {
      const word = m[0].toLowerCase();
      if (word.length < 4 || word.length > 7) continue;
      if (SLIP_CANDIDATES.has(word)) return true;
      if (/[^\x00-\x7f]/.test(word) && SLIP_WORD_KEYS.some((candidate) => oneSlip(word, candidate))) return true;
    }
    return false;
  }

  // A whole word that is a slip of a digit word (SLIP_WORDS), read as a sound-alike. A slip of two different
  // digits ("fine": "five" or "nine") is neither.
  const WORD_AT = /\p{L}+/uy;
  const isPlainLower = (w) => {
    for (let i = 0; i < w.length; i++) {
      const code = w.charCodeAt(i);
      if (code < 97 || code > 122) return false;
    }
    return true;
  };
  // What each word reads as depends on the word alone, so it's worked out once and kept across texts (and the three
  // readings of each), up to a bound.
  const SLIP_MEMO = new Map();
  const SLIP_MEMO_MAX = 20000;
  function readSlip(text, start) {
    // A word of a-z letters alone, shorter than 4 or longer than 7, is a slip of nothing: no need to read it out.
    let end = start;
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end) | 32;
      if (code < 97 || code > 122) break;
    }
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (after < 128 && (end - start < 4 || end - start > 7)) return null;
    WORD_AT.lastIndex = start;
    const s = WORD_AT.exec(text)[0];
    // Nor is any other word that short or long, and it's never kept: a run of Chinese letters is one long word.
    if (s.length < 4 || s.length > 7) return null;
    const w = s.toLowerCase();
    let cached = SLIP_MEMO.get(w);
    if (cached === undefined) {
      cached = slipOf(s, w);
      if (SLIP_MEMO.size >= SLIP_MEMO_MAX) SLIP_MEMO.clear();
      SLIP_MEMO.set(w, cached);
    }
    return cached ? { start, end: start + s.length, ...cached, kind: "weak", isWord: true, slip: true } : null;
  }
  // { digits, lang } for a word that's a slip of one digit, or null.
  function slipOf(s, w) {
    if (s.length < 4 || s.length > 7 || Object.prototype.hasOwnProperty.call(ALL_WORDS, w)) return null;
    // SLIP_CANDIDATES holds every a-z word one slip from a digit word, so a plain a-z word missing from it is a
    // slip of none, found without comparing it with each digit word.
    if (!SLIP_CANDIDATES.has(w) && isPlainLower(w)) return null;
    const words = SLIP_WORD_KEYS.filter((word) => oneSlip(w, word));
    const digits = new Set(words.map((word) => SLIP_WORDS[word]));
    if (digits.size !== 1) return null;
    const es = words.filter((word) => SPANISH.has(word)).length;
    return { digits: [...digits][0], lang: es === words.length ? "es" : es === 0 ? "en" : undefined };
  }

  // Splits text into runs of digits. A run is a list of groups, where a group is digits written together
  // with no separator between them, and each group is a list of unit objects ({ start, end, digits, kind,
  // isWord }). Several patterns read the same message, so I cache the last result and recompute it once per
  // scan instead of once per pattern, which keeps a big paste fast.
  let lastRunsText = null;
  let lastRuns = null;
  function numberRuns(text) {
    if (text === lastRunsText) return lastRuns;
    const runs = readNumberRuns(text);
    lastRunsText = text;
    lastRuns = runs;
    return runs;
  }

  // When a label right before the text says a number follows, like a card's security code in findSecrets, I
  // treat every sound-alike and slip as a real digit. The exception is "to" and "for", since "three to four
  // digits" is describing a range, not giving a number.
  function readNumberRuns(text, labelled = false) {
    const placed = placedUnits(text);
    if (!placed.length) return [];
    return runsFromUnits(text, placed, labelled);
  }

  // The digits and number words of a text, read once: numberRuns and a labelled reading of the same text (as
  // spokenDniNie's) share them, so the last text's are kept. Nothing downstream changes a unit.
  let lastUnitsText = null;
  let lastUnits = null;
  function placedUnits(text) {
    if (text === lastUnitsText) return lastUnits;
    const placed = readUnits(text);
    lastUnitsText = text;
    lastUnits = placed;
    return placed;
  }

  function readUnits(text) {
    if (!UNIT_HINT_RE.test(text) && !hasSlipCandidate(text)) return [];
    const units = [];
    for (let i = 0; i < text.length;) {
      UNIT_RE.lastIndex = i;
      const slip = isLetter(text[i]) && !isLetter(text[i - 1]) ? readSlip(text, i) : null;
      if (!slip) {
        const code = text.charCodeAt(i);
        if (code < 128 && !UNIT_START[code]) {
          i++;
          continue;
        }
      }
      const m = !slip && UNIT_RE.exec(text);
      const u = slip || (m && readUnit(m[0], i));
      if (!u) {
        i++;
        continue;
      }
      units.push(u);
      i = u.end;
    }

    // A number word only counts when it isn't buried inside an ordinary word, like "someone" or "phone".
    const wordOk = (u, k) => {
      const touchesPrev = k > 0 && units[k - 1].end === u.start;
      const touchesNext = k < units.length - 1 && units[k + 1].start === u.end;
      return (touchesPrev || !isLetter(text[u.start - 1])) && (touchesNext || !isLetter(text[u.end]));
    };
    const strong = units.map(
      (u, k) => u.kind === "digit" || (["word", "tens", "hund", "mult", "rep"].includes(u.kind) && wordOk(u, k)),
    );
    // A letter needs a real digit on both sides, and must touch one ("555-O636"). Sound-alikes and slips stay for
    // now: whether they're part of a number is decided once the runs are read (keepSoftUnits).
    const valid = units.filter((u, k) => {
      if (strong[k]) return true;
      if (u.kind === "weak") return wordOk(u, k);
      if (u.kind !== "letter") return false;
      if (!strong[k - 1] || !strong[k + 1]) return false;
      const before = text.slice(units[k - 1].end, u.start);
      const after = text.slice(u.end, units[k + 1].start);
      return isGap(before) && isGap(after) && (before === "" || after === "");
    });

    // "Double five" reads as 55: the next single digit, repeated. A "double" with no digit right after it
    // doesn't count.
    const repeated = [];
    for (let k = 0; k < valid.length; k++) {
      const u = valid[k],
        next = valid[k + 1];
      if (u.kind !== "rep") {
        repeated.push(u);
        continue;
      }
      if (
        next &&
        (next.kind === "word" || next.kind === "digit") &&
        /^\d$/.test(next.digits) &&
        /^[\s-]?$/.test(text.slice(u.end, next.start))
      ) {
        repeated.push({ ...next, start: u.start, digits: next.digits.repeat(u.times), kind: "word", isWord: true });
        k++;
      }
    }

    // "Fifty six" reads as 56. A lone "fifty" reads as 50.
    const merged = [];
    for (let k = 0; k < repeated.length; k++) {
      const u = repeated[k];
      if (u.kind !== "tens") {
        merged.push(u);
        continue;
      }
      const next = repeated[k + 1];
      if (
        next &&
        next.kind === "word" &&
        /^[1-9]$/.test(next.digits) &&
        /^(?:[\s-]?|\s+y\s+)$/i.test(text.slice(u.end, next.start))
      ) {
        merged.push({ ...u, end: next.end, digits: u.digits + next.digits, kind: "word" });
        k++;
      } else {
        merged.push({ ...u, digits: u.digits + "0", kind: "word" });
      }
    }

    // "Five hundred and fifty five" reads as 555. Hundreds resolve first, so "six thousand seven hundred"
    // reads as 6700. A multiplier with no number word in front of it, like a lone "a hundred", isn't a digit.
    const withPlaces = (list, places) => {
      const out = [];
      for (let k = 0; k < list.length; k++) {
        const u = list[k],
          m = list[k + 1],
          low = list[k + 2];
        if (places === 2 && u.kind === "hund") {
          // "quinientos cincuenta y cinco": the hundred is in the word
          const fill = m?.kind === "word" && m.digits.length <= 2 && /^[\s-]+$/.test(text.slice(u.end, m.start));
          out.push({
            ...u,
            kind: "word",
            end: (fill ? m : u).end,
            digits: u.digits + (fill ? m.digits.padStart(2, "0") : "00"),
          });
          k += fill ? 1 : 0;
          continue;
        }
        const lead =
          u.kind === "word" &&
          /^[1-9]\d?$/.test(u.digits) &&
          m?.kind === "mult" &&
          m.places === places &&
          /^[\s-]?$/.test(text.slice(u.end, m.start));
        if (!lead) {
          out.push(u);
          continue;
        }
        const fill =
          low?.kind === "word" &&
          low.digits.length <= places &&
          /^[\s-]+(?:and\s+)?$/i.test(text.slice(m.end, low.start));
        out.push({
          ...u,
          end: (fill ? low : m).end,
          digits: u.digits + (fill ? low.digits.padStart(places, "0") : "0".repeat(places)),
        });
        k += fill ? 2 : 1;
      }
      return out;
    };
    return withPlaces(withPlaces(merged, 2), 3).filter((u) => u.kind !== "mult");
  }

  // The runs those units make: a labelled reading keeps every sound-alike and slip, an unlabelled one only those
  // that belong to a number.
  function runsFromUnits(text, placed, labelled) {
    // A numbered list's item number ("1. …", "2) …" at the start of a line) isn't part of the detail after it.
    const atLineStart = (at) => {
      // only spaces or tabs back to a line break (looks back no further, so it stays linear)
      let i = at - 1;
      while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
      return i < 0 || text[i] === "\n";
    };
    // I check the cheap conditions first. This runs for every unit added to a run, and walking the whole run
    // each time made a huge paste quadratic: one real paste of 40,000 digits froze the page for a second.
    const listNumber = (r, gap) =>
      r.units.length <= 3 &&
      r.groups.length === 1 &&
      /^[.)][^\S\n]+$/.test(gap) &&
      r.units.every((x) => x.kind === "digit") &&
      atLineStart(r.units[0].start);
    // A full stop before a number word usually ends a sentence, so "It's 2024. Nine one one is for emergencies"
    // reads as the year 2024 and the number 911, not "2024911". But a phone keyboard capitalizes the first
    // letter after a period, so spelling a number out can create fake sentence breaks, like "Call five five
    // five. Five five five. Zero one two three." I rejoin pieces like that into one number when they split
    // exactly where a phone number's groups do (3, 3 and 4 digits) or an SSN's (3, 2 and 4).
    const sentenceEnd = (gap, u) => u.isWord && /^\.[^\S\n]+$/.test(gap);
    const size = (run) => run.units.reduce((n, x) => n + x.digits.length, 0);
    const SPLIT_SHAPES = new Set(["3,3,4", "3,7", "6,4", "3,2,4"]);
    const rejoin = (runs) => {
      const out = [];
      for (let k = 0; k < runs.length; k++) {
        const take = [3, 2].find((n) => {
          const pieces = runs.slice(k, k + n);
          return (
            pieces.length === n &&
            pieces.slice(1).every((p) => p.afterEnd) &&
            SPLIT_SHAPES.has(pieces.map(size).join(","))
          );
        });
        if (!take) {
          out.push(runs[k]);
          continue;
        }
        const pieces = runs.slice(k, k + take);
        out.push({ units: pieces.flatMap((p) => p.units), groups: pieces.flatMap((p) => p.groups) });
        k += take - 1;
      }
      return out;
    };
    const buildRuns = (list) => {
      const runs = [];
      let run = null;
      for (const u of list) {
        const gap = run ? text.slice(run.units[run.units.length - 1].end, u.start) : null;
        const joins = run && isGap(gap) && !listNumber(run, gap);
        if (joins && !sentenceEnd(gap, u)) {
          if (gap !== "") run.groups.push([]);
          run.groups[run.groups.length - 1].push(u);
          run.units.push(u);
        } else {
          run = { units: [u], groups: [[u]], afterEnd: Boolean(joins) };
          runs.push(run);
        }
      }
      return runs.some((r) => r.afterEnd) ? rejoin(runs) : runs;
    };
    if (labelled) return buildRuns(placed.filter((u) => u.kind !== "weak" || u.slip || u.atEdge));
    // Read with every sound-alike and slip that touches a number, then again with only those that belong to it.
    const runs = buildRuns(placed);
    if (!placed.some((u) => u.kind === "weak")) return runs;
    const kept = keepSoftUnits(runs, text);
    return buildRuns(placed.filter((u) => u.kind !== "weak" || kept.has(u)));
  }

  // "Won", "too", "fore" and other everyday words double as digit sound-alikes, and a one-letter slip like
  // "sevne" can too, so I only count them as part of a number when the context actually supports that reading.
  // Between two digits or number words a sound-alike always counts, except "to" and "for", which just as often
  // sit in a range like "two to four" or a duration like "one to two minutes".
  // In a fully spelled-out number, I add back the fewest sound-alikes at the edges needed to complete a valid
  // phone number, SSN or Luhn-valid card. A slip never counts at an edge, and "to"/"for" only do when the number
  // next to them has no literal digit, since a phone keyboard's autocorrect never touches an actual digit key.
  // With no number words at all, a run of sound-alikes can be a whole phone number by itself, unless it's a
  // chant: the same one to three words repeated, like "too too too …". "To" and "for" always end a chant like
  // that.
  // Inside a number, sound-alikes never outnumber the real number words around them, and a 7-digit local
  // number needs no "to" or "for" at all. A "to"/"for" between two rising numbers, set off by the number's end
  // or a comma, reads as a range instead, like "ages two to four, five to seven", except inside a longer phone
  // number where both sides are already digits.
  // Spanish sound-alikes and slips only count among Spanish number words, and English ones only among English
  // ones, so a plain count like "seis siete ocho nueve diez once doce" never gets misread as a number.
  function keepSoftUnits(runs, text) {
    const kept = new Set();
    const soft = (u) => u.kind === "weak";
    const strong = (u) => u.kind !== "weak" && u.kind !== "letter";
    const linking = (u) => soft(u) && !u.slip && !u.atEdge; // "to" and "for"
    const digits = (list) => list.map((u) => u.digits).join("");
    for (const { units } of runs) {
      if (!units.some(soft)) continue;
      const between = (k) => k > 0 && k < units.length - 1 && strong(units[k - 1]) && strong(units[k + 1]);
      units.forEach((u, k) => {
        if (soft(u) && !u.slip && !u.lang && !linking(u) && between(k)) kept.add(u);
      });
      const first = units.findIndex(strong);
      let lastIndex = units.length - 1;
      while (lastIndex >= 0 && !strong(units[lastIndex])) lastIndex -= 1;
      if (first < 0) {
        keepSoundAlikePhones(units);
        continue;
      }
      const core = units.slice(first, lastIndex + 1);
      const words = core.filter(strong);
      if (core.some((u) => u.kind === "letter")) continue; // a look-alike letter is too ambiguous to guess a shape around
      const lang = words.every((u) => u.lang === "es") ? "es" : words.every((u) => u.lang === "en") ? "en" : null;
      const fits = (u) => !u.lang || u.lang === lang;
      const inside = core.filter(soft);
      if (!inside.every(fits)) continue;
      if (inside.filter((u) => !u.atEdge).length > words.length) continue; // "to", "for" and slips
      const few = inside.length <= words.length;
      // A count ("seis siete ocho nueve diez once doce") isn't a number, judged with its edge words: "too won too
      // thre fore fiv sicks seve eigt nien" is 212-345-6789.
      const isCount = (list) => countsByOne(list.map((u) => Number(u.digits)));
      // A pair set off from other number words: by the number's end, a comma or another "to" or "for".
      const setOff = (a, b) => !a || !b || linking(a) || linking(b) || /[,;.]/.test(text.slice(a.end, b.start));
      const range = (k) =>
        linking(core[k]) &&
        strong(core[k - 1]) &&
        strong(core[k + 1]) &&
        Number(core[k - 1].digits) < Number(core[k + 1].digits) &&
        setOff(core[k - 2], core[k - 1]) &&
        setOff(core[k + 1], core[k + 2]);
      if (core.some((_u, k) => range(k))) continue; // "two to four, five to seven": ranges
      const middle = digits(core);
      // A phone keyboard's autocorrect only ever turns a typed word into "to" or "for", never a digit key into
      // one, so only a fully spelled core can borrow one at its edge (below). That keeps an ordinary preposition
      // before a real digit number, like "waiting for 123456789 to clear", from being misread.
      const coreAllWords = core.every((u) => u.kind !== "digit");
      // A real "wait for …" or "text to …" has its verb in the 30 characters right before the word
      // (PHONE_CONTEXT, below), so "to"/"for" never borrows past one when that ordinary reading is right there.
      const noVerbBefore = (pos) => !PHONE_CONTEXT.test(text.slice(Math.max(0, pos - 30), pos));
      // Edge candidates, nearest the number first, up to as many digits as the longest detail (a 19-digit card)
      // has room for; the first one that can't sit at an edge stops the search. A sound-alike can always be
      // one; "to"/"for" only when the core next to them is fully spelled and nothing ordinary explains them.
      const edge = (from, step) => {
        const out = [];
        let room = 19 - middle.length;
        for (
          let k = from;
          units[k] &&
          fits(units[k]) &&
          (units[k].atEdge || (coreAllWords && linking(units[k]) && noVerbBefore(units[k].start)));
          k += step
        ) {
          room -= units[k].digits.length;
          if (room < 0) break;
          out.push(units[k]);
        }
        return out;
      };
      const before = edge(first - 1, -1);
      const after = edge(lastIndex + 1, 1);
      // Every edge-word combination, fewest first (a 7-digit local phone number only with none).
      const combos = [];
      for (let n = 0; n <= before.length + after.length; n++) {
        for (let i = Math.min(n, before.length); i >= 0; i--) {
          if (n - i > after.length) continue;
          const lead = before.slice(0, i).reverse();
          const trail = after.slice(0, n - i);
          combos.push({ lead, trail, all: [...lead, ...core, ...trail] });
        }
      }
      // I check for a phone number first, trying the fewest edge words first. Its shape is exact (10 or 11 NANP
      // digits, or Spain's 9), unlike the SSN or card shape below, which can match by coincidence: "to zero six
      // seven three three for one five one" reads as a 10-digit phone, not the SSN its first nine digits alone
      // would also match.
      let pick = null;
      for (const { lead, trail, all } of combos) {
        if (!isCount(all) && wholePhone(digits(all), lang === "es")) {
          pick = [...lead, ...trail];
          break;
        }
      }
      // A card's length, issuer and checksum make its full spelled-out value distinctive. A spelled SSN needs
      // an autocorrect slip because its shape alone is loose enough to fit by chance.
      for (const { lead, trail, all } of combos) {
        if (pick) break;
        const simple =
          coreAllWords &&
          [...inside, ...lead, ...trail].some(linking) &&
          all.every((u) => u.digits.length === 1) &&
          !/[,;.]/.test(spanText(text, [all]));
        // An SSN label right before says what the run is, so any sound-alike in it ("my ssn is fore five six …",
        // "… nine won too three") counts, as long as the whole run has an SSN's shape.
        const named = VALID_SSN_SHAPE.test(digits(all)) && ssnLabelBefore(text, { units: all });
        if (!isCount(all) && (named || wholeSsnOrCard(digits(all), simple))) pick = [...lead, ...trail];
      }
      if (!pick && few && !inside.some(linking) && /^[2-9]\d{6}$/.test(middle) && !isCount(core)) pick = [];
      if (pick) for (const u of [...inside, ...pick]) kept.add(u);
    }
    return kept;

    // Each stretch of English sound-alikes in a run with no number word (cut at "to", "for", slips and "once").
    function keepSoundAlikePhones(units) {
      let stretch = [];
      for (const u of [...units, null]) {
        if (u?.atEdge && !u.lang) {
          stretch.push(u);
          continue;
        }
        const d = digits(stretch);
        if (wholePhone(d, false) && !chant(d)) for (const s of stretch) kept.add(s);
        stretch = [];
      }
    }
  }

  // A count: numbers that go up or down by one each step, like "6 7 8 9 10".
  function countsByOne(values) {
    const by = values[1] - values[0];
    return Math.abs(by) === 1 && values.every((v, k) => k === 0 || v - values[k - 1] === by);
  }

  // A chant, not a number: digits that repeat every one, two or three characters, like "4242424242".
  const chant = (d) => [1, 2, 3].some((p) => [...d].every((c, k) => k < p || c === d[k - p]));

  const lastItem = (items) => items[items.length - 1];
  const spanText = (text, groups) => text.slice(groups[0][0].start, lastItem(groups[groups.length - 1]).end);
  // Asked of every number run by several rules, so it's a plain loop rather than flat, map and join.
  const digitsOf = (groups) => {
    let d = "";
    for (const group of groups) for (const u of group) if (u.digits != null) d += u.digits;
    return d;
  };
  const hasWord = (groups) => groups.flat().some((u) => u.isWord);
  const sizesOf = (groups) => groups.map((g) => g.reduce((n, u) => n + u.digits.length, 0)).join(",");

  // North American numbering: area code and exchange can't start with 0 or 1.
  const NANP10 = /^[2-9]\d{2}[2-9]\d{6}$/;
  // A whole phone number by its digits alone: North American (10, or 11 with a leading 1), or Spain's 9 digits
  // (mobiles start with 6 or 7, landlines with 8 or 9) for a number read in Spanish.
  const wholePhone = (d, spanish) =>
    NANP10.test(d) || (d[0] === "1" && NANP10.test(d.slice(1))) || (spanish && /^[6-9]\d{8}$/.test(d));
  // An SSN's shape (same rule as findSSNs): 9 digits, area not 000/666/9xx, group not 00, serial not 0000.
  const VALID_SSN_SHAPE = /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/;
  // A full card needs its fixed length, issuer range and Luhn check. A spelled-out SSN is looser, so it also
  // needs a clear autocorrect slip like "to" or "for" and one digit per word.
  const wholeSsnOrCard = (d, simple) =>
    (d.length >= 13 && d.length <= 19 && /^[3-6]/.test(d) && luhn(d)) ||
    (simple && d.length === 9 && VALID_SSN_SHAPE.test(d));
  // Toll-free numbers belong to businesses and help lines ("poison control at 1-800-222-1222"), never a person.
  const TOLL_FREE = /^1?8(?:00|33|44|55|66|77|88)/;
  // Spain's free numbers are 9 digits: 900 and 800.
  const tollFree = (d) =>
    ((d.length === 10 || d.length === 11) && TOLL_FREE.test(d.length === 11 ? d : "1" + d)) ||
    (d.length === 9 && /^[89]00/.test(d));
  function isPhone(groups, wholeRun) {
    const d = digitsOf(groups);
    // Spelled-out numbers must be the whole run, so "one two … nine" (a 9-digit SSN) isn't read as a phone.
    if (hasWord(groups) && !wholeRun) return false;
    if (d.length === 10) return NANP10.test(d);
    if (d.length === 11) return d[0] === "1" && NANP10.test(d.slice(1));
    // A 7-digit local number only counts when it's clearly phone-shaped. A plain "5555636" is too often an
    // amount or ID instead.
    if (d.length === 7) return /^[2-9]/.test(d) && (hasWord(groups) || sizesOf(groups) === "3,4");
    return false;
  }

  // Reads international numbers like "+44 20 7946 0958", also written "0044 …" or spelled out as "plus four
  // four …". The prefix is required so ordinary long numbers stay quiet, and E.164 allows at most 15 digits
  // after it. Without a "+", "00" only counts as a dialling prefix when the number is written in pieces or
  // near a phone word, since a solid run merely starting "00" then 1-9 is far more often an ID with two
  // leading zeros, about 1 in 120 by chance.
  function internationalPhone(text, run) {
    const start = run.units[0].start;
    const plus = /(?:\+|\bplus\s+)$/i.exec(text.slice(Math.max(0, start - 6), start));
    let d = digitsOf(run.groups);
    if (!plus && !/^00[1-9]/.test(d)) return null;
    if (!plus && run.groups.length < 2 && !phoneContextBefore(text, run)) return null;
    if (!plus) d = d.slice(2);
    if (d[0] === "1" || d[0] === "0") return null; // +1 is North American: handled below
    // Longest prefix of groups that stays within 15 digits.
    let end = 0,
      n = 0;
    for (let k = 0; k < run.groups.length; k++) {
      n += digitsOf([run.groups[k]]).length;
      if (n - (plus ? 0 : 2) > 15) break;
      end = k;
    }
    const digits = digitsOf(run.groups.slice(0, end + 1)).length - (plus ? 0 : 2);
    if (digits < 8) return null;
    return text.slice(start - (plus ? plus[0].length : 0), lastItem(run.groups[end]).end);
  }

  // A phone number cut out of a longer run of digits still has to be phone-shaped, so a list like "1, 2, 3, 5,
  // 8, 13, 21, 34" isn't read as one. A whole run, on the other hand, can be grouped any way and still count.
  const PHONE_SHAPES = new Set(["10", "11", "3,3,4", "1,3,3,4", "3,4", "3,7"]);
  // Six or more plain digit groups split only by spaces read as a list of numbers, like an RSA ciphertext or a row of
  // readings. A phone-shaped slice from its middle is two neighbours that happen to fit ("824 1992"), so only a
  // slice that starts or ends the list can be a phone.
  const spacedList = (text, groups) =>
    groups.length >= 6 &&
    groups.every((g) => g.every((u) => u.kind === "digit")) &&
    groups.every((g, i) => i === 0 || /^[ \t]+$/.test(text.slice(lastItem(groups[i - 1]).end, g[0].start)));
  // Digits glued to letters belong to a bigger token (a hash, UUID or model number).
  const glued = (text, span) => {
    const first = span[0][0];
    const end = lastItem(lastItem(span));
    // An extension right after the number ("555-555-0136x12") doesn't make it part of a word.
    const extension = /^x\d{1,5}\b/i.test(text.slice(end.end, end.end + 7));
    return (
      (first.kind === "digit" && isLetter(text[first.start - 1])) ||
      (end.kind === "digit" && isLetter(text[end.end]) && !extension)
    );
  };

  // A release or file name strings words and digits together with dots and no spaces, like
  // "Title.Part.Two.2024.2160p.REMUX" or "Old.Film.451.1966.1080p.BluRay": a number run sitting inside one,
  // with a letter somewhere on each side of it, names a thing, not a number someone wrote. A number glued
  // straight onto a letter right at its own edge ("2160p", "x265") reads the same way even with no dot there
  // at all, unless it's a phone extension ("555-555-0136x12"). The look each way is bounded (FILENAME_WINDOW),
  // so a huge paste still scans in linear time.
  // [A-Za-z0-9.], read by character code: it's asked of up to 80 characters on each side of a number.
  const isFileNameCode = (code) =>
    (code >= 48 && code <= 57) || ((code | 32) >= 97 && (code | 32) <= 122) || code === 46;
  const FILENAME_WINDOW = 80;
  const sideToken = (text, pos, step) => {
    let i = pos;
    let n = 0;
    while (i >= 0 && i < text.length && n < FILENAME_WINDOW && isFileNameCode(text.charCodeAt(i))) {
      i += step;
      n++;
    }
    return step < 0 ? text.slice(i + 1, pos + 1) : text.slice(pos, i);
  };
  function inFileName(text, run) {
    const first = run.units[0].start;
    const end = lastItem(run.units).end;
    const extension = /^x\d{1,5}\b/i.test(text.slice(end, end + 7));
    if (extension) return false;
    const before = sideToken(text, first - 1, -1);
    const after = sideToken(text, end, 1);
    const parts = (before + text.slice(first, end) + after).split(".");
    return (
      (parts.length >= 3 && /[A-Za-z]/.test(before) && /[A-Za-z]/.test(after)) ||
      /^(?:2160|1440|1080|720|480)p$/i.test(text.slice(first, end) + after) ||
      /^(?:x265|x264|h265|h264)$/i.test(before + text.slice(first, end))
    );
  }

  // When a phone word sits right before a number, like "llámame al …" or "my cell is …", I read 9 digits as a
  // phone number, common in Spain, much of Europe and Latin America, rather than a US Social Security number.
  const PHONE_CONTEXT =
    /(?:\b(?:call|text|phone|cell|mobile|whatsapp|tel)|ll[aá]mame|llamar|llama|tel[eé]fono|m[oó]vil|celular|fijo|n[uú]mero)\b[^\d\n]{0,20}$/i;
  // An SSN label right before the number, like "ssn: 219099999" or "social security #…", beats a phone word
  // that's further back, as in "<phone>…</phone><ssn>…".
  const SSN_LABEL =
    /\b(?:s\.?s\.?n\.?|ss\s*#|soc(?:ial)?\.?\s+sec(?:urity|\.)?(?:[\s_]+(?:number|no\.?|#))?|social(?:[\s_]+security)?(?:[\s_]+(?:number|no\.?|#))?)["']?\s*(?:is\s*)?[:=>#-]?\s*["']?$/i;
  const ssnLabelBefore = (text, run) =>
    SSN_LABEL.test(text.slice(Math.max(0, run.units[0].start - 30), run.units[0].start).replace(/\b[A-Za-z]\s*$/, ""));
  // A bare 9 digits with no dashes and no label only counts as an SSN when the message itself makes that
  // clear: it's nothing but the number, an identity phrase like "confirm who I am" or "verify my identity"
  // (or Spanish "quién soy") sits nearby, or it follows "my number is" with nothing else in the message.
  // Order, tracking, invoice and ZIP context never trigger this, so no separate exclusion list is needed.
  const SSN_IDENTITY_WORDS =
    /\b(?:confirm(?:ing)?|verify(?:ing)?)\b[^\n]{0,25}\b(?:who\s+i\s+am|my\s+identity|identity|it'?s\s+me)\b|\bmy\s+identity\b|\bwho\s+i\s+am\b|qui[eé]n\s+soy|verificar\s+mi\s+identidad|\bmi\s+identidad\b/i;
  const SSN_STRIP = /[\s.,;:!?'"“”‘’()#*-]/g;
  // A window, not the whole text, around the number: a big paste full of bare numbers must still scan in linear
  // time, and identity words always sit in the same sentence as the number anyway.
  const SSN_WINDOW = 60;
  const bareSSNContext = (text, run) => {
    const start = run.units[0].start;
    const end = lastItem(run.units).end;
    // "The message is just the number": only worth checking once the whole text is already about that short
    // (a cheap length check avoids scanning a long paste per occurrence).
    if (text.length <= 9 + SSN_WINDOW * 2) {
      const rest = (text.slice(0, start) + text.slice(end)).replace(SSN_STRIP, "").toLowerCase();
      if (rest === "") return true; // the message is just the number
      if (rest === "mynumberis") return true; // "my number is 219099999", nothing else
    }
    const before = text.slice(Math.max(0, start - SSN_WINDOW), start);
    const after = text.slice(end, end + SSN_WINDOW);
    return SSN_IDENTITY_WORDS.test(before) || SSN_IDENTITY_WORDS.test(after);
  };
  const phoneContextBefore = (text, run) =>
    !ssnLabelBefore(text, run) &&
    PHONE_CONTEXT.test(text.slice(Math.max(0, run.units[0].start - 30), run.units[0].start));
  // Counting aloud, like "one two three … ten" or "diez nueve ocho …", is three or more number words each
  // one more or less than the last. I don't read that as a phone or SSN unless a phone word or SSN label
  // right before it says otherwise, the same as for digits typed out; digits keep their own rules either way.
  const counting = (text, run) =>
    run.units.length >= 3 &&
    run.units.every((u) => u.isWord) &&
    countsByOne(run.units.map((u) => Number(u.digits))) &&
    !ssnLabelBefore(text, run) &&
    !phoneContextBefore(text, run);

  // Reads UK and Australian numbers written the local way, like the mobile "07700 900123" or the UK landline
  // "020 7946 0958". This only counts when the number is grouped like a phone or sits right after a phone
  // word, as in "ring me on 07700900123"; a bare "order 07123456789" isn't one.
  const LOCAL_PHONE = /^(?:07\d{9}|04\d{8}|0[12]\d{8,9})$/;
  const LOCAL_SHAPES = new Set(["5,6", "5,3,3", "4,3,3", "4,3,4", "3,4,4", "4,6", "2,4,4", "4,4,3"]);
  const LOCAL_CONTEXT = /\b(?:call|ring|text|phone|mobile|cell|whatsapp|tel|number)\b[^\d\n]{0,20}$/i;
  function localPhone(text, run) {
    if (!LOCAL_PHONE.test(digitsOf(run.groups))) return false;
    const start = run.units[0].start;
    return LOCAL_SHAPES.has(sizesOf(run.groups)) || LOCAL_CONTEXT.test(text.slice(Math.max(0, start - 30), start));
  }

  // Local plans use different lengths and groupings; a phone word also allows typing one without separators.
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
  const EUROPEAN_NUMBER_LABEL_BEFORE =
    /(?<![\p{L}])(?:version|password|passcode|pin|secret|token|credential|anydesk\s+code|remote\s+access\s+code|c[oó]digo\s+de\s+anydesk|api[\s_-]*key)(?![\p{L}])[^\d\n]{0,25}$/iu;
  function europeanNationalPhone(text, run) {
    const digits = digitsOf(run.groups);
    if (![9, 10, 11, 12].includes(digits.length)) return false;
    if (hasWord(run.groups) || labelledAsOther(text, run) || ssnLabelBefore(text, run)) return false;
    const sizes = sizesOf(run.groups);
    const start = run.units[0].start;
    const before = text.slice(Math.max(0, start - 30), start);
    if (EUROPEAN_NUMBER_LABEL_BEFORE.test(before) && !PHONE_WORD.test(before)) return false;
    const grouped = /[ .-]/.test(spanText(text, run.groups));
    const phoneWord = PHONE_CONTEXT.test(before);
    return EUROPEAN_NATIONAL_FORMATS.some(
      (format) => format.digits(digits) && ((grouped && format.groups.has(sizes)) || phoneWord),
    );
  }

  // A number labelled as something else isn't read as a phone, as with "Order #445-2231987" or "meeting ID is
  // 845 2931 7710". The label can sit a few words back, like "El ID de la reunión de Zoom es …", but a phone
  // word after it wins instead, as in "about the order, call me at …".
  const OTHER_NUMBER_BEFORE =
    /(?:#\s*$|(?<![\p{L}])(?:order|invoice|ticket|case|ref(?:erence)?|tracking|confirmation|booking|reservation|meeting|claim|serial|model|part|sku|po|pedido|factura|referencia|reuni[oó]n|reserva|localizador|nhs|medicare|aadhaar|aadhar|tfn|tax\s+file|clabe|cbu|cvu|cci|iban|n[uú]mero\s+de\s+ruta|ruta\s+bancaria|(?:request|transaction|trace|session|correlation|device)[\s_-]*id)(?![\p{L}])[^\d\n]{0,25}$)/iu;
  const PHONE_WORD =
    /(?<![\p{L}])(?:call|ring|text|phone|mobile|cell|whatsapp|tel|ll[aá]m\p{L}*|tel[eé]fono|m[oó]vil|celular)(?![\p{L}])/iu;
  // A student number or a license plate right after its label isn't a phone either, as with "número de
  // matrícula 2019630123" or "plate number 555 1234".
  const STUDENT_LABEL_BEFORE =
    /(?:\bstudent[\s-]*(?:id|number|no\.?|#|card)|\bschool[\s-]*id|\bmatric(?:ulation)?\s+(?:number|no\.?|#)|(?<![\p{L}])matr[ií]cula|(?<![\p{L}])(?:de\s+(?:estudiante|alumn[oa])|c[oó]digo\s+estudiantil)|\blicen[cs]e[\s-]+plates?|\b(?:number|reg(?:istration)?)\s+plates?|\bplates?\s*(?:number|no\.?|#)|\brego|(?<![\p{L}])(?:placas?|patente))\s*(?:[:#=]|is|was|es|son|era)?\s*$/iu;
  const SID_BEFORE = /(?<![\p{L}\d])SID(?:\s*(?:number|no\.?|num|#))?\s*(?:[:#]|is|was)?\s*$/u;
  function labelledAsOther(text, run) {
    const start = run.units[0].start;
    const before = text.slice(Math.max(0, start - 40), start);
    // A phone word anywhere close by wins over the other label, as in "about the order, call me at …".
    return (
      (OTHER_NUMBER_BEFORE.test(before) && !PHONE_WORD.test(before)) ||
      STUDENT_LABEL_BEFORE.test(before) ||
      ACCOUNT_NAME_BEFORE.test(before) ||
      SID_BEFORE.test(before) ||
      checkedAccountAt(text, run)
    );
  }

  // A National Drug Code right after "NDC" isn't a phone. Without this, "NDC 0093-7146-56" would read as "00"
  // plus a country code. NDC codes come in three shapes, 4-4-2, 5-3-2 and 5-4-1, or as 11 digits in the shape
  // 5-4-2, with or without dashes. Any other shape after "NDC" is still read as a phone.
  const NDC_BEFORE = /(?<![\p{L}])NDC(?:\s*(?:code|number|no\.?|#))?\s*(?:[:=]|is)?\s*$/iu;
  const NDC_SHAPES = new Set(["4,4,2", "5,3,2", "5,4,1", "5,4,2", "10", "11"]);
  const ndcCode = (text, run) =>
    NDC_SHAPES.has(sizesOf(run.groups)) &&
    NDC_BEFORE.test(text.slice(Math.max(0, run.units[0].start - 20), run.units[0].start));

  // The digits at the end of a VIN-shaped code aren't a phone, even together with the number right after
  // them. "1HGCM82633A004352 2003", a VIN and its year sitting side by side in a spreadsheet, isn't the
  // phone number "004352 2003".
  function inVinCode(text, at) {
    const back = /[A-Z\d]{0,17}$/.exec(text.slice(Math.max(0, at - 17), at))[0].length;
    if (/[A-Za-z\d]/.test(text[at - back - 1] || "")) return false;
    const code = /^[A-Z\d]*/.exec(text.slice(at - back, at - back + 18))[0];
    return code.length === 17 && /^[A-HJ-NPR-Z\d]{13}\d{4}$/.test(code) && /[A-Z].*[A-Z]/.test(code);
  }

  // A Windows security ID isn't a phone: "S-1-5-21-3623811015-3361044348-30300820-1013" (every one starts "S-1-").
  const windowsSid = (text, run) =>
    run.groups[0].length === 1 &&
    run.groups[0][0].digits === "1" &&
    /(?<![\p{L}\d])S-$/u.test(text.slice(Math.max(0, run.units[0].start - 3), run.units[0].start));

  // Log times can look like a phone when adjacent date and clock digits are grouped together.
  const LOG_TIMESTAMP_PATTERNS = [
    /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/gi,
    /\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\]/g,
    /\b[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:AM|PM)\b/gi,
    /\b\d{2}:\d{2}:\d{2}\.\d{3,}\b/g,
    /(?<![\w-])["']?(?:@timestamp|ts|timestamp|time|created_at|createdAt|eventTime|timeCreated)["']?\s*:\s*["']?(\d{10}(?:\d{3})?)["']?/gi,
    /\b(?:took|lasted|duration|elapsed)(?:\s+(?:for|of))?\s+(\d+(?:\.\d+)?)\s*(?:ms|milliseconds?)\b/gi,
  ];
  // Numbers a machine prints that have a phone's digit count: git's "21:24:38 2026 +0000" date, a browser or
  // package version after its name ("Chrome/131.0.6778.205"), a kernel log's "[12345.678901]" clock, a count of
  // nanoseconds or bytes, the integer limits 2147483647 and 4294967295, a date and time like "25/02/2026 11:52",
  // a web server log's status and size after the request ('HTTP/1.1" 200 2537'), the two short hashes on a git
  // "Merge:" line, and a bracketed list of plain numbers.
  const MACHINE_NUMBER_PATTERNS = [
    /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\s+\d{1,2}:\d{2}\b/g,
    /\bHTTP\/\d(?:\.\d)?"\s+(\d{3}\s+\d{1,12})\b/g,
    /^[ \t]*Merge:[ \t]+([0-9a-f]{7,40}(?:[ \t]+[0-9a-f]{7,40})+)$/gm,
    /\b\d{1,2}:\d{2}:\d{2}\s+\d{4}\s+[+-]\d{4}\b/g,
    /(?<![\w-])[A-Za-z][\w-]{0,40}\/(\d+(?:\.\d+){2,})(?![\d.])/g,
    /^\[\s*(\d{1,7}\.\d{6})\]/gm,
    /(?<![\d.])(\d{7,}(?:\.\d+)?)\s*(?:ns|µs|us|ms|nanoseconds?|microseconds?|milliseconds?|bytes|cycles|ticks)\b/g,
    /(?<![\d.-])(?:2147483647|2147483648|4294967295|4294967296)(?![\d.-])/g,
  ];
  const NUMBER_LIST = /\[\s*\d+(?:\s*,\s*\d+)+\s*,?\s*\]/g;
  const LIST_OF_PHONES = /(?:phone|mobile|cell|tel|contact|number|whatsapp|sms|call)[^[\n]{0,30}$/i;
  const UUID_SHAPE = /(?<![a-z0-9])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![a-z0-9])/gi;
  function logTimestampRanges(text) {
    const ranges = [];
    for (const pattern of LOG_TIMESTAMP_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const start = match.index + (match[1] ? match[0].indexOf(match[1]) : 0);
        const value = match[1] || match[0];
        // An epoch field only counts as a time when it lands between 2001 and 2036 (seconds, or milliseconds), so
        // "any time: 5558675309" still reads as the phone number it is.
        if (/^\d{10}$/.test(value) && (value < "1000000000" || value > "2100000000")) continue;
        if (/^\d{13}$/.test(value) && (value < "1000000000000" || value > "2100000000000")) continue;
        ranges.push([start, start + value.length]);
      }
    }
    for (const pattern of MACHINE_NUMBER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const start = match.index + (match[1] ? match[0].indexOf(match[1]) : 0);
        ranges.push([start, start + (match[1] || match[0]).length]);
      }
    }
    // A list of numbers in code is data, unless a phone word names it.
    for (const match of text.matchAll(NUMBER_LIST)) {
      if (!LIST_OF_PHONES.test(text.slice(Math.max(0, match.index - 40), match.index))) {
        ranges.push([match.index, match.index + match[0].length]);
      }
    }
    return ranges;
  }

  function findPhones(text) {
    const found = [];
    let timestamps;
    const overlapsUuid = (start, end) => {
      // UUIDs are uncommon, so look for one only around a phone-shaped candidate instead of scanning every paste.
      const from = Math.max(0, start - 37);
      const nearby = text.slice(from, Math.min(text.length, end + 37));
      for (const match of nearby.matchAll(UUID_SHAPE)) {
        const uuidStart = from + match.index;
        if (uuidStart < end && uuidStart + match[0].length > start) return true;
      }
      return false;
    };
    const addPhone = (start, end) => {
      if (overlapsUuid(start, end)) return;
      // Most text has no phone candidate, so don't scan it for log shapes.
      if (!timestamps) timestamps = logTimestampRanges(text);
      if (!timestamps.some(([begin, finish]) => start >= begin && end <= finish)) found.push(text.slice(start, end));
    };
    for (const m of text.matchAll(/(?<![\p{L}\d])([A-Za-z])(\d{10})(?![\p{L}\d])/gu)) {
      const start = m.index + m[0].indexOf(m[2]);
      if (/^[2-9]\d{9}$/.test(m[2]) && !inVinCode(text, start)) addPhone(start, m.index + m[0].length);
    }
    for (const run of numberRuns(text)) {
      // Every phone below has at least 7 digits (a local number), so a shorter run, like most numbers in a
      // message, skips the label and name checks.
      let size = 0;
      for (const u of run.units) size += u.digits.length;
      if (size < 7) continue;
      if (labelledAsOther(text, run) || tollFree(digitsOf(run.groups)) || counting(text, run)) continue;
      if (ndcCode(text, run) || inVinCode(text, run.units[0].start) || windowsSid(text, run) || inFileName(text, run)) {
        continue;
      }
      // A local number glued to letters at its end is part of a name, like "fixture-0125/337909e6.png".
      const gluedEnd =
        isLetter(text[lastItem(lastItem(run.groups)).end]) && lastItem(lastItem(run.groups)).kind === "digit";
      if (gluedEnd && /[/_]/.test(spanText(text, run.groups))) continue;
      if (localPhone(text, run)) {
        addPhone(run.groups[0][0].start, lastItem(lastItem(run.groups)).end);
        continue;
      }
      if (europeanNationalPhone(text, run)) {
        addPhone(run.groups[0][0].start, lastItem(lastItem(run.groups)).end);
        continue;
      }
      if (digitsOf(run.groups).length === 9 && phoneContextBefore(text, run)) {
        addPhone(run.groups[0][0].start, lastItem(lastItem(run.groups)).end);
        continue;
      }
      // A dotted IPv4 address ("73.162.44.201") has phone-like digits but isn't one.
      const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(spanText(text, run.groups));
      if (ip && ip.slice(1).every((n) => Number(n) <= 255)) continue;
      const intl = internationalPhone(text, run);
      if (intl) {
        const start = text.indexOf(intl, Math.max(0, run.units[0].start - 6));
        // Without a "+", a "00" number inside a word or a path ("fixture-0044/264107a3.png") is part of a name.
        const inName =
          /^00/.test(intl) &&
          (/[\p{L}\d][-_]$|\/$/u.test(text.slice(Math.max(0, start - 2), start)) ||
            /^(?:[\p{L}]|\.\w)/u.test(text.slice(start + intl.length, start + intl.length + 2)));
        if (start >= 0 && !inName) addPhone(start, start + intl.length);
        continue;
      }
      const g = run.groups;
      const list = spacedList(text, g);
      for (let s = 0; s < g.length;) {
        let bestEnd = -1;
        let len = 0; // digits in g[s..e], counted as the span grows
        for (let e = s; e < g.length; e++) {
          for (const u of g[e]) len += u.digits.length;
          if (len > 11) break;
          if (len !== 7 && len < 10) continue; // a phone has 7, 10 or 11 digits (isPhone)
          if (list && s > 0 && e < g.length - 1) continue;
          const span = g.slice(s, e + 1);
          // Spelled out, from a list break to a list break counts as whole ("…six three six, two one nine…" is
          // two numbers). Digits keep the stricter rule, so "1, 2, 3, 5, 8, 13" stays a list.
          const wholeRun =
            (s === 0 && e === g.length - 1) ||
            (hasWord(span) &&
              (s === 0 || listBreakAfter(text, g, s - 1)) &&
              (e === g.length - 1 || listBreakAfter(text, g, e)));
          if (!wholeRun && !hasWord(span) && !PHONE_SHAPES.has(sizesOf(span))) continue;
          if (glued(text, span)) continue;
          if (isPhone(span, wholeRun)) bestEnd = e; // keep the longest
        }
        if (bestEnd >= 0) {
          // Include an opening "(" or "+" right before the number, so redaction doesn't leave it behind.
          const first = g[s][0].start;
          const lead = /[(+]/.test(text[first - 1] || "") ? 1 : 0;
          addPhone(first - lead, lastItem(g[bestEnd]).end);
          s = bestEnd + 1;
        } else {
          s++;
        }
      }
    }
    if (!found.length) return found;
    // A value read after a Spanish ID label isn't a phone too ("número de afiliado 912345678", "mi NSS es …").
    const claimed = spanishIdValues(text);
    return found.filter((f) => !claimed.some((v) => v.includes(f)));
  }

  // Reads card numbers in digits, with spaces or dashes allowed, or spelled out in words like "four five
  // three nine…", and checks them with the Luhn sum. A spelled-out number has to start like a card (3-6) and
  // be the whole run. A 13-digit number starting 978 or 979 is a book's ISBN instead, since no card network
  // uses that prefix, even though about one in ten ISBNs happens to pass Luhn anyway.
  const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
  const isIsbn13 = (candidate) => /^97[89]\d{10}$/.test(candidate.replace(/\D/g, ""));
  // When a card number is typed in parts, it's grouped in fours, with a shorter last group for 13 or 19
  // digits, or as 4-6-5 for American Express and 4-6-4 for Diners Club, matching how it's printed on the
  // card. Amazon's order numbers, grouped 3-7-7, pass the Luhn sum about 1 time in 10 too.
  // Some valid card numbers are split into groups of three; Luhn and the issuer prefix still have to pass.
  const CARD_GROUPS = /^(?:\d+|(?:\d{4}[ -])+\d{1,4}|(?:\d{3}[ -]){5}\d|\d{4}[ -]\d{6}[ -]\d{4,5})$/;
  // The digits of an IBAN, or of a code shaped like one such as "es16 3435 8224 …" in any case, aren't a
  // card. An IBAN printed in groups of four has a run of digits that happens to pass the Luhn sum about 1
  // time in 10.
  const IBAN_SHAPED = /\b[a-z]{2}\d{2}(?:[ -]?[a-z0-9]){11,30}\b/gi;
  // The issuer prefix and length each real card network uses (IIN ranges, ISO/IEC 7812). A bare number must
  // fit one of these, since Luhn alone passes about 1 in 10 random numbers; a number a label already calls a
  // card keeps the simpler Luhn-only rule, so a network not listed here, or a new one, still counts.
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
  const cardNetwork = (digits) => CARD_NETWORKS.some((n) => n.lengths.includes(digits.length) && n.re.test(digits));
  // A card word near the number, like "my card is …" or "Visa ending in …", is the label that vouches for it.
  // A gift card's own code is a different shape, handled by giftCode below, so this rarely confuses the two.
  const CARD_WORD =
    /(?<![\p{L}])(?:(?:(?:credit|debit|bank)[\s-]*)?cards?|visa|master\s*card|mastercard|amex|american\s+express|discover|diners(?:\s+club)?|jcb|union\s*pay|maestro|tarjetas?(?:\s+de\s+(?:cr[eé]dito|d[eé]bito))?)(?![\p{L}])/iu;
  const cardLabelNear = (text, index) =>
    CARD_WORD.test(text.slice(Math.max(0, index - 35), index)) || CARD_WORD.test(text.slice(index, index + 35));
  function findCards(text) {
    // Find the IBAN-shaped codes once up front. They're in the same order as the numbers, so each number only
    // has to check the next code that hasn't ended yet, which is what k keeps track of.
    let ibans = null;
    let k = 0;
    const inIban = (m) => {
      if (!ibans) ibans = [...text.matchAll(IBAN_SHAPED)].map((i) => [i.index, i.index + i[0].length]);
      while (k < ibans.length && ibans[k][1] <= m.index) k++;
      return k < ibans.length && ibans[k][0] < m.index + m[0].length;
    };
    // Digits immediately after a decimal point are a fraction, not a card number.
    const found = [...text.matchAll(CARD_RE)]
      .filter(
        (m) =>
          !(m.index >= 2 && /\d/.test(text[m.index - 2]) && text[m.index - 1] === ".") &&
          luhn(m[0]) &&
          !isIsbn13(m[0]) &&
          CARD_GROUPS.test(m[0]) &&
          !inIban(m) &&
          (cardNetwork(m[0].replace(/\D/g, "")) || cardLabelNear(text, m.index)),
      )
      .map((m) => m[0]);
    for (const run of numberRuns(text)) {
      if (!hasWord(run.groups)) continue;
      const d = digitsOf(run.groups);
      if (/^[3-6]/.test(d) && luhn(d)) found.push(spanText(text, run.groups));
    }
    for (const m of /\d[^\S\n]*\n[^\S\n]*\d/.test(text) ? text.matchAll(CARD_LINES_RE) : []) {
      const d = m[0].replace(/\D/g, "");
      if (d.length === 16 && luhn(d) && cardNetwork(d) && cardLabelNear(text, m.index)) found.push(m[0]);
    }
    // Written with dots, the way some forms and receipts print it, in exactly four groups of four.
    for (const m of text.includes(".") ? text.matchAll(CARD_DOTS_RE) : []) {
      if (luhn(m[0]) && cardNetwork(m[0].replace(/\D/g, ""))) found.push(m[0]);
    }
    // A labelled South African ID passes Luhn too, and one born in the 1940s to 60s starts like a card.
    if (!found.length) return found;
    const ids = worldNationalIds(text);
    return ids.length ? found.filter((f) => !ids.some((v) => v.includes(f))) : found;
  }
  const CARD_DOTS_RE = /(?<![\d.])\d{4}\.\d{4}\.\d{4}\.\d{4}(?![\d.])/g;
  // A card number typed over two or more lines in its groups of four, only with a card word near it, since a short
  // list of four-digit numbers one to a line passes the Luhn sum about 1 time in 10. Four groups at most, so a long
  // run of numbers costs each start only a few steps.
  const CARD_LINES_RE =
    /(?<![\d.])\d{4}(?:[ -]\d{4}){0,2}(?:[^\S\n]{0,4}\r?\n[^\S\n]{0,4}\d{4}(?:[ -]\d{4}){0,2}){1,3}(?![\d])/g;

  // Finds an SSN written in digits inside a longer list, like "555-555-5636, 219-09-9999": a 3-2-4 group set
  // off by a comma or semicolon, with no comma inside it. A comma followed by a space also joins the parts of a
  // spelled-out phone number, so the number reader keeps those in one run instead of splitting them here.
  // This cuts a run at its list breaks into [[group, …], …].
  const listBreakAfter = (text, groups, i) =>
    i < groups.length - 1 && /[,;]/.test(text.slice(lastItem(groups[i]).end, groups[i + 1][0].start));
  function listChunks(text, groups) {
    const chunks = [[]];
    groups.forEach((g, i) => {
      lastItem(chunks).push(g);
      if (listBreakAfter(text, groups, i)) chunks.push([]);
    });
    return chunks;
  }
  function listedSSNs(text, groups) {
    const chunks = listChunks(text, groups);
    if (chunks.length < 2) return [];
    return chunks
      .filter((c) => {
        const d = digitsOf(c);
        return (
          d.length === 9 &&
          (hasWord(c) || sizesOf(c) === "3,2,4") &&
          /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(d)
        );
      })
      .map((c) => spanText(text, c));
  }

  // In a CSV export with an SSN column, like "phone,ssn" followed by "5555555636,219099999", the header says
  // what the plain 9-digit values in that column are.
  const SSN_COLUMN = /^["']?(?:ssn|social[\s_]*security(?:[\s_]*(?:number|no))?|social)["']?$/i;
  function ssnColumn(text) {
    if (!/ssn|social/i.test(text)) return [];
    const found = [];
    let col = -1;
    for (const line of text.split("\n")) {
      const cells = line.split(",").map((c) => c.trim());
      const header = cells.findIndex((c) => SSN_COLUMN.test(c));
      if (header >= 0) {
        col = header;
        continue;
      }
      if (col < 0 || cells.length <= col) {
        col = cells.length > 1 ? col : -1;
        continue;
      }
      const v = cells[col].replace(/^["']|["']$/g, "");
      if (/^\d{3}-?\d{2}-?\d{4}$/.test(v) && /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(v.replace(/-/g, ""))) {
        found.push(v);
      }
    }
    return found;
  }

  // A stock, part or model number can have an SSN's 3-2-4 shape; its label right before says what it is.
  const PRODUCT_CODE_BEFORE =
    /(?<![\p{L}])(?:sku|part|item|model|serial|product|catalog(?:ue)?|stock|upc|ean|lot|batch|p\/n|mpn|asin)(?![\p{L}])(?:\s*(?:number|no\.?|num|#|code|id))?\s*(?:[:=#]|is)?\s*$/iu;
  const productCodeBefore = (text, run) =>
    PRODUCT_CODE_BEFORE.test(text.slice(Math.max(0, run.units[0].start - 30), run.units[0].start));

  function findSSNs(text) {
    const found = ssnColumn(text);
    for (const run of numberRuns(text)) {
      const d = digitsOf(run.groups);
      if (d.length !== 9) {
        for (const ssn of listedSSNs(text, run.groups)) found.push(ssn); // a long list can't be spread into one call
        continue;
      }
      if (phoneContextBefore(text, run)) continue; // "call me at …": a 9-digit phone number, not an SSN
      if (europeanNationalPhone(text, run)) continue;
      if (counting(text, run)) continue;
      if (inFileName(text, run)) continue; // a release or file name, like "Dune.Part.Two.2024.2160p"
      if (productCodeBefore(text, run) && !ssnLabelBefore(text, run)) continue; // "SKU 460-12-3447"
      // Digits need the 3-2-4 shape unless an SSN label says what they are, or the message itself does.
      // Spelled-out numbers can be written any way.
      if (
        !hasWord(run.groups) &&
        sizesOf(run.groups) !== "3,2,4" &&
        !ssnLabelBefore(text, run) &&
        !bareSSNContext(text, run)
      ) {
        continue;
      }
      if (!/^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(d)) continue;
      if (isLetter(text[lastItem(run.units).end]) && !ssnLabelBefore(text, run)) continue;
      found.push(spanText(text, run.groups));
    }
    return found;
  }

  // ---------- Emails, including spelled-out forms ----------

  // Each part is bounded by its real limit: 64 for the local part, 253 for the domain, 63 for a label.
  // Without those bounds, an unbounded repeat backtracked quadratically on hostile text like "a-a-a-…".
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
  const TLDS = "com|net|org|edu|gov|mil|us|uk|ca|au|de|fr|io|co|me|info|biz|app|dev|ai|es|mx|ar|cl|pe";
  // When someone writes "at" instead of @, I only call it an email if the provider is a personal one like
  // gmail. That way "I work at google dot com" stays quiet and "bob at gmail dot com" still gets caught. The
  // list also covers the usual misspellings, like "gmial" or "yahooo", for when an address is spelled out.
  const PROVIDERS =
    "gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|protonmail|proton|pm|comcast|att|verizon|sbcglobal|bellsouth|charter|cox|earthlink|gmx|zoho|yandex|mail" +
    "|gmial|gmal|gamil|gmaill|gnail|yaho|yahooo|yahho|hotmial|hotmal|hotmai|homail|outlok|outloook|iclod|icoud";
  // "jane dot doe", "jane(dot)doe", Spanish "juan punto perez".
  const LOCAL = String.raw`[A-Za-z0-9._%+-]{1,64}(?:(?:\s+(?:dot|punto)\s+|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*)[A-Za-z0-9._%+-]{1,64}){0,4}`;
  const LABEL = String.raw`[A-Za-z0-9-]{1,63}`;
  const DOT = String.raw`(?:\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+|\s*\.\s*)`;
  // "(at)", "[at]", "{at}", "<at>", or an "@" with spaces around it: always obfuscation.
  const BRACKET_AT = String.raw`(?:\s*[(\[{<]\s*at\s*[)\]}>]\s*|\s+@\s*|\s*@\s+)`;
  const EMAIL_BRACKETED = new RegExp(
    String.raw`\b${LOCAL}${BRACKET_AT}${LABEL}(?:${DOT}${LABEL}){0,4}?${DOT}(?:${TLDS})\b`,
    "gi",
  );
  const EMAIL_WORDED = new RegExp(
    String.raw`\b${LOCAL}\s+(?:at|arroba)\s+(?:${PROVIDERS})(?:${DOT}${LABEL}){0,4}?${DOT}(?:${TLDS})\b`,
    "gi",
  );
  // Catches "my email is janedoe at yahoo", a big provider with no ".com" after it, but only right after an
  // email word, so "I work at yahoo" stays quiet.
  const BIG_PROVIDERS = "gmail|googlemail|yahoo|ymail|hotmail|outlook|aol|icloud|protonmail|comcast|gmx|zoho|yandex";
  const EMAIL_NO_TLD = new RegExp(
    String.raw`\b(?:e-?mail|correo)\b[^\n@]{0,20}?\b([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}\s+(?:at|arroba)\s+(?:${BIG_PROVIDERS}))\b(?!\s*(?:[(\[{<]\s*)?(?:dot|punto)\b|\.[A-Za-z]|\s*@)`,
    "gi",
  );

  // A git remote over SSH, like git@github.com:acme/app.git or ssh://git@gitlab.com/acme/app, is a server's login, not
  // someone's address. "git@acme-mail.com wrote:" is still an email.
  const gitRemote = (text, m) =>
    /^(?:git|hg)@/i.test(m[0]) &&
    (/^:[\w.~-]+\/[\w.-]+/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 200)) ||
      /ssh:\/\/$/i.test(text.slice(Math.max(0, m.index - 6), m.index)));
  function findEmails(text) {
    // .invalid is reserved for addresses deliberately made unable to resolve.
    return [
      ...[...text.matchAll(EMAIL_RE)].filter((m) => !gitRemote(text, m)).map((m) => m[0]),
      ...(text.match(EMAIL_BRACKETED) || []),
      ...(text.match(EMAIL_WORDED) || []),
      ...[...text.matchAll(EMAIL_NO_TLD)].map((m) => m[1]),
    ].filter((address) => !/\.invalid$/i.test(address));
  }

  // ---------- Where a sentence ends ----------
  // A detail never spans a sentence end, so "in 5 minutes. Drive safe!" isn't the street "5 minutes Drive". A
  // dot after an abbreviation, an initial, or an already-dotted word doesn't end a sentence, as in "123 Main
  // St. Apt 4", and neither does one after a word no sentence ends on: "The. Xbox name…" is really two
  // spaces a phone keyboard turned into a period.
  const ABBREVIATIONS = new Set(
    (
      "st mt ft dr jr sr mr mrs ms mx prof rev gen col lt sgt capt gov sen rep pres no nos vs etc approx inc co corp " +
      "ltd apt ste bldg fl rm dept ave av rd blvd ln ct pl ter cir pkwy hwy trl sq cres ne nw se sw jan feb mar apr " +
      "jun jul aug sep sept oct nov dec sra srta dra avda pza cra nro núm ud uds lic ing"
    ).split(" "),
  );
  const NO_SENTENCE_ENDS_ON = "a|an|the|my|your|his|her|our|their|this|that|el|la|los|las|un|una|mi|mis|tu|tus|su|sus";
  const NO_END_WORD = new RegExp(`^(?:${NO_SENTENCE_ENDS_ON})$`, "i");
  // Whether a full stop right after `word` ends a sentence.
  const dotEndsSentence = (word) =>
    word.length > 1 && !word.includes(".") && !ABBREVIATIONS.has(word.toLowerCase()) && !NO_END_WORD.test(word);

  // ---------- Street addresses (US style), digits or spelled out ----------
  // "123 Main St, Springfield, IL 62704", "4500 N. Oak Ridge Road Apt 4B",
  // "one twenty three main street apt 4", "P.O. Box 1234".

  const NUM_WORDS =
    "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
  // At most 8 number words, since a real house number is shorter than that, and an unbounded run made the
  // scan quadratic on long spelled-out text (4 seconds for 40,000 characters). This only reads one line, so a
  // "twenty" ending the line above isn't read as part of "Twelve Oak Street" below it.
  const HOUSE_NUM = String.raw`(?:\d{1,6}[A-Za-z]?|(?:${NUM_WORDS})(?:(?:[^\S\n]|-)+(?:${NUM_WORDS}|and)){0,7})`;
  const DIRECTION = String.raw`(?:north|south|east|west|n|s|e|w|ne|nw|se|sw)\.?`;
  // The British, Canadian and Australian words after "crescent/cres" are UK/AU suffixes added for 1.4.0.
  const SUFFIX_PLAIN = String.raw`(?:street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|trail|trl|square|sq|loop|pike|crescent|cres|close|mews|gardens|grove|croft|parade|esplanade|quay|wynd|circuit|promenade)`;
  // These eight are everyday words too, so a street only ends on one when the word right after it isn't
  // itself a plain suffix ("Sparrow Hill Dr" is the street "Sparrow Hill", not "Sparrow" on "Hill Dr"), and
  // AMBIGUOUS_SUFFIX below still asks for a tail, a flat or unit front, or an address phrase nearby.
  const SUFFIX_AMBIGUOUS = String.raw`(?:park|green|hill|view|gate|walk|rise|row)`;
  const SUFFIX = String.raw`(?:${SUFFIX_PLAIN}|${SUFFIX_AMBIGUOUS}(?!\.?[^\S\n]+${SUFFIX_PLAIN}\.?\b))\.?`;
  const AMBIGUOUS_SUFFIX = new Set(["park", "green", "hill", "view", "gate", "walk", "rise", "row"]);
  // Between a label and its value, each run of spaces is read in one way only: "\s*(?:#\s*)?" rather than
  // "\s*#?\s*", whose two runs could split the same spaces between them in every possible way. Text with a
  // label, a huge run of spaces and then no value would otherwise take quadratic time (cubic with three runs)
  // to rule out. The same goes for every label-to-value gap below.
  const UNIT = String.raw`(?:,?\s+(?:apt|apartment|unit|suite|ste|#)\.?\s*(?:#\s*)?[A-Za-z0-9-]+)?`;
  // A flat or apartment number before the house number ("Flat 3, 12 Acacia Avenue"), an Australian unit before
  // a slash ("Unit 4/12", "4/12"), or a Canadian unit-dash ("12-345 Main St"), so Hide it covers the unit too.
  // The canonical fingerprint (addressCore) still ignores it, the same way it already ignores UNIT above.
  const FRONT = String.raw`(?:(?:flat|apartment|apt)\.?\s*\d{1,4}[a-z]?,?[^\S\n]+|(?:unit[^\S\n]+)?\d{1,4}\/[^\S\n]*|\d{1,4}-[^\S\n]*)`;
  // This only matches within one line (using [^\S\n] for spaces, not line breaks), since a match that ran on
  // from a ZIP code into the next line used to hide the address written there.
  const STREET_RE = new RegExp(
    String.raw`\b(?<front>${FRONT})?(?<num>${HOUSE_NUM})[^\S\n]+(?:(?<pre>${DIRECTION})[^\S\n]+)?(?<name>(?:[A-Za-z0-9][\w'.-]*[^\S\n]+){0,3}?[A-Za-z0-9][\w'.-]*)[^\S\n]+(?<suf>${SUFFIX})(?:[^\S\n]+(?<post>${DIRECTION}))?(?![\w])${UNIT}`,
    "gi",
  );
  const PO_BOX_RE = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*(?:#\s*)?\d{1,6}\b/gi;
  // Words that make "<number> <word> <street word>" something else: "2 hard drive", "5 minutes drive".
  const NOT_A_STREET = new Set(
    (
      "hard test disk flash usb thumb long right wrong the a an this that my your our his her " +
      "any some no one other same half all each every way lane minute minutes min mins hour hours mile miles km " +
      "day days week weeks year years time times people more less of to in for and or star stars point points step " +
      "steps bed beds bedroom bedrooms room rooms car cars story stories person man men dollar dollars a.m p.m am pm " +
      // Linking words never name a street: "at 3 with Dr", half typed before the doctor's name.
      "with at by from on about after before until till near into onto without around against"
    ).split(" "),
  );
  const STATES =
    "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
  // Case-sensitive tail, so "…St, then walk to me" doesn't swallow the rest of the sentence.
  const CITY_STATE_ZIP = new RegExp(
    String.raw`^(?:,?\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2},?\s+(?:${STATES})\b(?:\s+\d{5}(?:-\d{4})?)?|,?\s+(?:${STATES})\s+\d{5}(?:-\d{4})?|,?\s+\d{5}(?:-\d{4})?\b)`,
  );
  // A UK postcode: the outward part (one or two letters, a digit, an optional letter or digit) and the inward
  // part (a digit, two letters), with the letters Royal Mail never puts first (Q, V, X) excluded.
  const UK_POSTCODE = String.raw`[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\s?\d[A-Z]{2}`;
  const UK_TAIL_RE = new RegExp(String.raw`^,?\s*[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2},?\s+${UK_POSTCODE}\b`, "i");
  // A Canadian postal code: A1A 1A1, the letters D, F, I, O, Q, U never used in either half.
  const CA_POSTAL = String.raw`[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]\s?\d[ABCEGHJKLMNPRSTVWXYZ]\d`;
  const CA_PROVINCES = "AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT";
  // Only a space separates the town's words. A dash already belongs to the word, so "Saint-Jean-sur-Richelieu"
  // reads as one word either way, and letting a dash split words too gave a long dash-joined run cubically many
  // readings to rule out before failing.
  const CA_TAIL_RE = new RegExp(
    String.raw`^,?\s*[A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'-]+){0,2},?\s+(?:\(Qu[ée]bec\)|${CA_PROVINCES})\s+${CA_POSTAL}\b`,
    "iu",
  );
  const AU_STATES = "NSW|VIC|QLD|WA|SA|TAS|ACT|NT";
  const AU_TAIL_RE = new RegExp(
    String.raw`^,?\s*[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2},?\s+(?:${AU_STATES})\s+\d{4}\b`,
    "i",
  );
  // The longest of these that matches right after a street becomes its tail, so Hide it covers the town and
  // postcode too, the way CITY_STATE_ZIP already does for a US address. Longest, not first, because a state
  // code can read both ways ("WA" is Washington and Western Australia): the shorter, ZIP-less US reading
  // would otherwise win over the Australian one that actually accounts for the postcode after it.
  function addressTail(rest) {
    let best = null;
    for (const re of [CITY_STATE_ZIP, UK_TAIL_RE, CA_TAIL_RE, AU_TAIL_RE]) {
      const m = re.exec(rest);
      if (m && (!best || m[0].length > best.length)) best = m[0];
    }
    return best;
  }
  // The everyday suffix words in AMBIGUOUS_SUFFIX only count as a street when something nearby says this is an
  // address: a tail (checked by the caller), a flat or unit front, or a phrase like "I live at" or "send it to".
  const ADDRESS_PHRASE_EN =
    /\b(?:I\s+live\s+at|living\s+at|send\s+it\s+to|ship\s+it\s+to|mail\s+it\s+to|deliver\s+it\s+to|my\s+address\s+is|moved\s+to|move\s+to)\s*$/i;

  // Turns the same address into one canonical core for fingerprints no matter how it's written, so "123 Oak
  // St., Springfield" and "one twenty three oak street apt 4" both become "123 oak street".
  const SUFFIX_CANON = {
    st: "street",
    ave: "avenue",
    av: "avenue",
    rd: "road",
    blvd: "boulevard",
    dr: "drive",
    ln: "lane",
    ct: "court",
    pl: "place",
    ter: "terrace",
    cir: "circle",
    pkwy: "parkway",
    hwy: "highway",
    trl: "trail",
    sq: "square",
    cres: "crescent",
  };
  const DIR_CANON = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    ne: "northeast",
    nw: "northwest",
    se: "southeast",
    sw: "southwest",
  };
  const canon = (word, map) => {
    const w = word.toLowerCase().replace(/\.$/, "");
    return map[w] || w;
  };

  function addressCore(text) {
    const box = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*(?:#\s*)?(\d{1,6})\b/i.exec(text);
    if (box) return `po box ${box[1]}`;
    const m = new RegExp(STREET_RE.source, "i").exec(text);
    if (!m) return colombianAddressCore(text) || spanishAddressCore(text);
    const g = m.groups;
    const num = /^\d/.test(g.num)
      ? g.num.toLowerCase()
      : numberRuns(g.num)
          .flatMap((r) => r.units)
          .map((u) => u.digits)
          .join("");
    return [
      num,
      g.pre && canon(g.pre, DIR_CANON),
      ...g.name.toLowerCase().replace(/\./g, "").split(/\s+/),
      canon(g.suf, SUFFIX_CANON),
      g.post && canon(g.post, DIR_CANON),
    ]
      .filter(Boolean)
      .join(" ");
  }

  // Spanish: street type, a capitalized name (with "de la", "del"…), then the number.
  const ES_STREET_TYPES =
    "[Cc]alle|[Cc]/|[Aa]venida|[Aa]vda\\.?|[Aa]v\\.|[Pp]aseo|[Pp]laza|[Pp]za\\.|[Cc]arrera|[Cc]ra\\.|[Cc]amino|[Rr]onda|[Tt]raves[ií]a|[Cc]alzada|[Bb]ulevar";
  const ES_WORD = "[A-ZÁÉÍÓÚÑ][\\p{L}.'-]*";
  const ES_JOIN = "(?:de(?:l|\\s+la|\\s+los|\\s+las)?\\s+)?";
  const ES_STREET_RE = new RegExp(
    `(?<![\\p{L}])(?:${ES_STREET_TYPES})\\s*${ES_JOIN}${ES_WORD}(?:\\s+${ES_JOIN}${ES_WORD}){0,4},?\\s+(?:(?:n[º°o.]|n[uú]mero|num\\.?)\\s*)?\\d{1,4}(?!\\d)`,
    "gu",
  );
  // Map coordinates can be as exact as an address, as in "my home is at 40.712776, -74.005974". I only read
  // them this way after a home phrase and with 4 or more decimals, about 10 meters of precision. A
  // landmark's or a restaurant search's coordinates aren't read as yours.
  const COORD_NUM = String.raw`-?\d{1,3}\.\d{4,}°?`;
  const COORD = String.raw`${COORD_NUM}\s*[NSEW]?`;
  const HOME_COORDINATES = new RegExp(
    String.raw`(?<![\p{L}])(?:my\s+(?:home|house|place|apartment|flat|address)|I\s+live|mi\s+(?:casa|piso|domicilio)|vivo)(?![\p{L}])[^\n\d-]{0,25}(${COORD_NUM}\s*(?:[NSEW]\s*)?(?:,\s*)?${COORD})`,
    "giu",
  );
  // Matches in any case, but only right after an address phrase like "vivo en" or "mi dirección es".
  const ES_STREET_ANY_CASE = new RegExp(ES_STREET_RE.source, "iuy");
  const ES_NOT_A_STREET = new Set(
    "al lado hace que con en muy por para desde hasta cerca frente junto donde esta este esa ese una un y o sin sobre entre tras hacia según como".split(
      " ",
    ),
  );
  const ES_ADDRESS_CONTEXT =
    /(?<![\p{L}])(?:viv(?:o|e|imos|en)\s+en(?:\s+la)?|(?:mi\s+)?(?:direcci[oó]n|domicilio)(?:\s+es|\s*:)|(?:m[aá]nd|env[ií])\p{L}*\s+a)\s+/giu;
  // Turns the same Spanish address into one form no matter how it's written, so "C/ Alcalá, 45" becomes
  // "calle alcalá 45" for vault fingerprints.
  const ES_TYPE_CANON = [
    [/^c(?:alle|\/)$/, "calle"],
    [/^av(?:enida|da\.?|\.)$/, "avenida"],
    [/^p(?:laza|za\.)$/, "plaza"],
    [/^c(?:arrera|ra\.?)$/, "carrera"],
    [/^traves[ií]a$/, "travesía"],
  ];
  function spanishAddressCore(text) {
    const m = new RegExp(ES_STREET_RE.source, "iu").exec(text); // any case: the vault says it's an address
    if (!m) return null;
    const words = m[0]
      .toLowerCase()
      .replace(/,/g, " ")
      .replace(/(?<![\p{L}])(?:n[º°o.]|n[uú]mero|num\.?)(?:\s+|(?=\d))/gu, "")
      .split(/\s+/)
      .filter(Boolean);
    const [type, ...rest] = /^c\/./.test(words[0]) ? ["c/", words[0].slice(2), ...words.slice(1)] : words;
    const canonType = (ES_TYPE_CANON.find(([re]) => re.test(type)) || [null, type])[1];
    return [canonType, ...rest].join(" ");
  }

  // A house number like 1900-2099 only reads as a year after a time word, as in "in 2024 the road…" or "by
  // 2030 Main Street will…". Without one, "ship it to 2068 Oak Street" reads as an address.
  const YEAR_BEFORE =
    /(?<!\p{L})(?:in|since|by|from|until|till|before|after|during|of|circa|around|the|en|desde|hasta)\s+$/iu;
  // In "at 3 with Dr. Okafor" or "a las 4 con el Dr. Ramírez", "Dr" means doctor, not Drive. A title like "Dr"
  // comes right before a capitalized name, with the word before it in lowercase: someone who capitalizes
  // "Okafor" also capitalizes a street name, as in "418 Maple Dr. Springfield". An address's own words after
  // it, like "Apt" or a direction, or a ZIP code, still read it as a street.
  const NAME_AFTER_TITLE =
    /^Dr\.?[^\S\n]+(?:(?:de|del|la|las|los|van|von|da|di|du|le)[^\S\n]+){0,2}(?!(?:Apt|Apartment|Unit|Suite|Ste|North|South|East|West)(?![\p{L}]))\p{Lu}[\p{Ll}'’]/u;
  // Words like "with" count as lowercase even when capitalized, as in "Follow-up At 3 With Dr. Okafor".
  const BEFORE_A_TITLE = /^(?:with|and|see|seeing|con|el|la|y|ver)$/i;
  function doctorNotDrive(text, m) {
    const { name, suf } = m.groups;
    const surname = lastItem(name.split(/\s+/));
    if (!/^Dr\.?$/.test(suf) || !(/^\p{Ll}/u.test(surname) || BEFORE_A_TITLE.test(surname))) return false;
    const at = m.index + m[0].lastIndexOf(suf);
    if (!NAME_AFTER_TITLE.test(text.slice(at, at + 60))) return false;
    const tail = CITY_STATE_ZIP.exec(text.slice(at + suf.length));
    return !(tail && /\d{5}/.test(tail[0]));
  }
  // A postcode given as the person's own, with no street name: "my postcode is SW1A 1AA", "postal code: K1A
  // 0B1". A bare Australian 4-digit code is too everyday on its own, so it only counts next to a state.
  const POSTCODE_LABEL = /\b(?:my\s+)?post(?:al\s+code|code)(?:\s+(?:is|number))?\s*[:=]?\s*/gi;
  function ownPostcodes(text) {
    const found = [];
    for (const m of text.matchAll(POSTCODE_LABEL)) {
      const rest = text.slice(m.index + m[0].length);
      const uk = new RegExp(`^${UK_POSTCODE}\\b`, "i").exec(rest);
      if (uk) {
        found.push(uk[0]);
        continue;
      }
      const ca = new RegExp(String.raw`^${CA_POSTAL}\b`, "i").exec(rest);
      if (ca) {
        found.push(ca[0]);
        continue;
      }
      // The comma owns the space after it, so a long gap before a non-state can only be read one way.
      const au = new RegExp(String.raw`^\d{4}(?=\s*(?:,\s*)?(?:${AU_STATES})\b)`, "i").exec(rest);
      if (au) found.push(au[0]);
    }
    return found;
  }
  // Quebec writes the street type lower-case, after the number, like Spanish: "123 rue Sainte-Catherine", "12
  // chemin de la Rivière". No addressCore form yet (Later): the vault only matches these by their own text.
  const QC_JOIN = String.raw`(?:(?:de|du|des|d'|la|le|les)\s*){0,2}`;
  const QC_WORD = "[A-ZÀ-Ý][\\p{L}.'-]*";
  const QC_STREET_RE = new RegExp(
    String.raw`\b\d{1,6}[^\S\n]+(?:rue|avenue|boulevard|chemin)[^\S\n]+${QC_JOIN}${QC_WORD}(?:[^\S\n]+${QC_JOIN}${QC_WORD}){0,3}`,
    "giu",
  );
  function findAddresses(text) {
    const found = [];
    const withTail = (start, end) => {
      const tail = addressTail(text.slice(end));
      found.push(text.slice(start, end + (tail ? tail.length : 0)));
    };
    STREET_RE.lastIndex = 0;
    for (let m; (m = STREET_RE.exec(text));) {
      // A word followed by its sentence's full stop means whatever comes after is the next sentence, as in "5
      // minutes. Drive safe!" or even uncapitalized, "2 tickets. elm street…", since no real street name has a
      // full stop after a whole word. I pick the search back up from the next number, as in "…5 minutes. 42
      // Oak Street".
      const typed = m.groups.name.split(/[^\S\n]+/);
      const words = typed.map((w) => trimTrailing(w, /\./));
      if (typed.some((w, k) => w !== words[k] && dotEndsSentence(words[k]))) {
        STREET_RE.lastIndex = m.index + (m.groups.front || "").length + m.groups.num.length;
        continue;
      }
      if (words.some((w) => NOT_A_STREET.has(w.toLowerCase()))) continue;
      const yearLike = /^(?:19|20)\d\d$/.test(m[0].split(/\s/)[0]);
      if (yearLike && YEAR_BEFORE.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (doctorNotDrive(text, m)) continue;
      // An everyday word like "park" or "view" only counts as a street when it has a front, an address phrase
      // right before it, or a tail (checked the same way withTail does, just slightly ahead of it here).
      if (AMBIGUOUS_SUFFIX.has(m.groups.suf.toLowerCase().replace(/\.$/, ""))) {
        const hasFront = Boolean(m.groups.front);
        const hasTail = Boolean(addressTail(text.slice(m.index + m[0].length)));
        const hasPhrase = ADDRESS_PHRASE_EN.test(text.slice(Math.max(0, m.index - 40), m.index));
        if (!hasFront && !hasTail && !hasPhrase) continue;
      }
      withTail(m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(PO_BOX_RE)) withTail(m.index, m.index + m[0].length);
    for (const m of text.matchAll(ES_STREET_RE)) found.push(m[0]);
    for (const m of text.matchAll(QC_STREET_RE)) found.push(m[0]);
    for (const m of text.matchAll(HOME_COORDINATES)) found.push(m[1]);
    for (const postcode of ownPostcodes(text)) found.push(postcode);
    // Reads an address all in lowercase, like "vivo en calle mayor 5", but only right after an address phrase
    // that says what follows is one.
    for (const m of text.matchAll(ES_ADDRESS_CONTEXT)) {
      ES_STREET_ANY_CASE.lastIndex = m.index + m[0].length;
      const s = ES_STREET_ANY_CASE.exec(text);
      // Everyday words mean a sentence, not a street name ("vivo en la calle de al lado hace 5 años").
      if (
        s &&
        !s[0]
          .toLowerCase()
          .split(/[\s,]+/)
          .some((w) => ES_NOT_A_STREET.has(w))
      ) {
        found.push(s[0]);
      }
    }
    return withColombianStreets(text, found);
  }

  // ---------- Dates of birth (only next to a birth word, since a plain date isn't personal) ----------
  // Reads things like "born 3/14/1948", "DOB: 1948-03-14", or "born on the fourteenth of March nineteen forty
  // eight".

  const MONTHS =
    "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
  const ORDINAL_WORDS =
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth";
  const DAY = String.raw`(?:\d{1,2}(?:st|nd|rd|th)?|(?:twenty|thirty)[\s-]+(?:${ORDINAL_WORDS})|(?:${ORDINAL_WORDS}))`;
  const YEAR = String.raw`(?:\d{4}|'\d{2}|(?:eighteen|nineteen|twenty)(?:[\s-]+(?:oh|${NUM_WORDS})){1,2}|two\s+thousand(?:\s+and)?(?:[\s-]+(?:${NUM_WORDS}))?)`;
  // Year first takes a slash or a dot too ("1987/04/12"), and a form's "12-Apr-1987" its dashes.
  const DATE_RE = new RegExp(
    String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|(?:0?[1-9]|[12]\d|3[01])-(?:${MONTHS})-(?:\d{4}|\d{2})` +
      String.raw`|(?:${MONTHS})\.?\s+${DAY}(?:,?\s+${YEAR})?` +
      String.raw`|${DAY}\s+(?:of\s+)?(?:${MONTHS})\.?(?:,?\s+${YEAR})?)(?![\w/])`,
    "iy",
  );
  // Also matches a data key like "dob": "1948-03-14".
  const BIRTH_WORDS =
    /\b(?:born|birthday|b-?day|birth[\s_]*date|date[\s_]+of[\s_]+birth|d\.?o\.?b\.?)(?:["']?\s*[:=-]\s*["']?|\s+)(?:(?:is|was|on|the)\s+)*/gi;
  // Spanish: reads things like "nací el 14 de marzo de 1962" or "mi cumpleaños es el 3 de julio".
  const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
  const ES_NUM =
    "cero|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiún|veintidós|veintidos|veintitrés|veintitres|veinticuatro|veinticinco|veintiséis|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa";
  const DIA = String.raw`(?:\d{1,2}|primero|(?:${ES_NUM})(?:\s+y\s+uno)?)`;
  const ANIO = String.raw`(?:\d{4}|(?:mil\s+(?:novecientos|ochocientos)|dos\s+mil)(?:\s+(?:y\s+)?(?:${ES_NUM})){0,3})`;
  const DATE_ES_RE = new RegExp(
    String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|${DIA}\s+de\s+(?:${MESES})(?:\s+(?:de|del)\s+${ANIO})?)(?![\p{L}\d/])`,
    "iuy",
  );
  // Matches birth words like "nací", "nacido el …", "fecha de nacimiento", a form's "F. nac." and "cumpleaños".
  const BIRTH_WORDS_ES =
    /(?<![\p{L}])(?:nac[ií]|naci[oó]|nacid[oa]s?|(?:fecha\s+de\s+)?nacimiento|(?:fecha\s+|f\.\s?)(?:de\s+)?nac\.?|cumplea(?:ñ|n)os)(?:\s*:\s*|\s+)(?:(?:es|fue|el|en\s+el)\s+)*/giu;

  function validNumericDate(d) {
    const parts = d.split(/[/.-]/).map(Number);
    if (parts[0] > 31) return parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1 && parts[2] <= 31; // yyyy-mm-dd
    const [a, b] = parts;
    return a >= 1 && b >= 1 && ((a <= 12 && b <= 31) || (b <= 12 && a <= 31)); // m/d or d/m
  }

  function findBirthDates(text) {
    const found = [];
    for (const m of text.matchAll(BIRTH_WORDS)) {
      DATE_RE.lastIndex = m.index + m[0].length;
      const d = DATE_RE.exec(text);
      if (!d) continue;
      if (/^\d/.test(d[0]) && /^[\d/.-]+$/.test(d[0]) && !validNumericDate(d[0])) continue;
      found.push(d[0]);
    }
    for (const m of text.matchAll(BIRTH_WORDS_ES)) {
      DATE_ES_RE.lastIndex = m.index + m[0].length;
      const d = DATE_ES_RE.exec(text);
      if (!d || (/^[\d/.-]+$/.test(d[0]) && !validNumericDate(d[0]))) continue;
      found.push(d[0]);
    }
    return found;
  }

  // ---------- Bank and ID numbers: the value right after a label ----------
  // Reads things like "account number is 1234…", "routing: 021000021" or "driver's license: D1234567".
  // Medicare numbers can also stand on their own.

  const CONNECT = String.raw`(?:\s*(?:number|no\.?|num|#|id))?\s*(?:[:=#]|is|was)?\s*`;
  const label = (words, flags = "gi") => new RegExp(String.raw`\b(?:${words})(?![a-z])${CONNECT}`, flags);
  const BANK_LABELS = [label(String.raw`(?:(?:bank|checking|savings)\s+)?(?:account|acct)`)];
  const ROUTING_LABELS = [label(String.raw`routing|aba|rtn`)];
  // Matches "driver's license", "driving licence" and short forms like "D.L." or "DL#", but only "DL" in
  // capitals, since lowercase "dl" is a download. "DL" stuck directly to what follows is never a label, since
  // "DL380" is a server and "DL1234" a Delta flight. "DL" followed by just a space only counts before a
  // number shaped like a state's license (LICENSE_SHAPE); otherwise "DL 1234" is still a flight.
  const LICENSE_WORDS = String.raw`(?:driver'?s?|driving)\s+lic(?:en[cs]e|\.)?`;
  const LICENSE_LABELS = [label(LICENSE_WORDS)];
  const DL_LABEL = label(String.raw`D\.L\.?|DL\.?(?![A-Za-z0-9])`, "g");
  // A state's license number, the way states actually write them: one to three letters and five or more
  // digits, like California's D1234567, or six or more digits alone, like Texas's 12345678. Some states add a
  // letter at the end, like Idaho's AB123456C. Dashes don't count toward the digits.
  const LICENSE_SHAPE = /^(?:[A-Z]{1,3}\d{5,14}|\d{6,14})[A-Z]?$/i;
  function dlLicenses(text) {
    const found = [];
    for (const m of text.matchAll(DL_LABEL)) {
      const v = idAt(text, m.index + m[0].length);
      const bare = /^DL\.?\s*$/.test(m[0]); // no "#", ":", "no." or "is" after it
      if (v && (!bare || LICENSE_SHAPE.test(v.replace(/-/g, "")))) found.push(v);
    }
    return found;
  }
  const PASSPORT_LABELS = [label("passport")];
  const INSURANCE_LABELS = [
    label(String.raw`(?:insurance|member|policy|subscriber|medicaid)(?=\s*(?:id|number|no\.?|#))`),
  ];
  const MEDICARE_LABELS = [label("medicare")];
  // Medicare Beneficiary Identifier: 11 characters in a fixed letter/digit layout (no S, L, O, I, B, Z).
  const MBI_L = "[AC-HJKMNP-RT-Y]";
  const MBI_RE = new RegExp(
    String.raw`\b[1-9]${MBI_L}[AC-HJKMNP-RT-Y0-9]\d-?${MBI_L}[AC-HJKMNP-RT-Y0-9]\d-?${MBI_L}{2}\d{2}\b`,
    "g",
  );
  const ALNUM_ID = /[A-Za-z0-9][A-Za-z0-9-]{3,19}/y;

  // A number (digits or number words) that starts exactly where the label ends.
  function numberAfter(labels, text, okDigits) {
    let byStart = null; // run by where it starts, built only once a label is found
    const found = [];
    for (const re of labels) {
      for (const m of text.matchAll(re)) {
        const at = m.index + m[0].length;
        if (!byStart) byStart = new Map(numberRuns(text).map((r) => [r.units[0].start, r]));
        const run = byStart.get(at);
        if (run && okDigits(digitsOf(run.groups))) found.push(spanText(text, run.groups));
      }
    }
    return found;
  }

  // A letters-and-digits ID right after the label (must contain a digit: "the license is MIT" isn't one).
  function idAt(text, at) {
    ALNUM_ID.lastIndex = at;
    const v = ALNUM_ID.exec(text)?.[0].replace(/-+$/, "");
    return v && (v.match(/\d/g) || []).length >= 4 ? v : null;
  }
  function idAfter(labels, text) {
    const found = [];
    for (const re of labels) {
      for (const m of text.matchAll(re)) {
        const v = idAt(text, m.index + m[0].length);
        if (v) found.push(v);
      }
    }
    return found;
  }

  // ABA routing checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10).
  function abaValid(d) {
    if (d.length !== 9) return false;
    const n = [...d].map(Number);
    return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
  }

  // Spanish bank accounts: reads things like "número de cuenta 1234567890" or "mi cuenta bancaria es la
  // 1234567890", plus Peru's 20-digit CCI. Accounts run up to 22 digits across the region, covering Spain's
  // old 20-digit account, Mexico's 18 and Argentina's 22. An amount right after isn't an account, so "en mi
  // cuenta de ahorros 150000 pesos" stays quiet.
  const CUENTA = String.raw`(?:(?:n[uú]mero|n\.?\s?[º°o]\.?|n[uú]m\.|nro\.?)\s+de\s+(?:(?:la|mi|tu|su)\s+)?cuenta(?:\s+(?:bancaria|corriente|de\s+ahorros?|de\s+cheques|n[oó]mina))?|cuenta\s+(?:bancaria|corriente|de\s+ahorros?|de\s+cheques|n[oó]mina))`;
  const ES_CONNECT = String.raw`(?![\p{L}])\s*(?:[:=#]|(?:es|era)(?![\p{L}]))?\s*(?:(?:el|la)\s+)?`;
  const CUENTA_LABEL = new RegExp(String.raw`(?<![\p{L}])${CUENTA}${ES_CONNECT}`, "giu");
  // A number right after an account's name is read as the account only, never also as a phone
  // (labelledAsOther), as in "account number 12345678901" or "cuenta de ahorros 12345678901".
  const ACCOUNT_NAME_BEFORE = new RegExp(
    String.raw`(?:\b(?:(?:bank|checking|savings)\s+)?(?:account|acct)(?:\s*(?:number|no\.?|num|#|id))?\s*(?:[:=#]|is|was)?|(?<![\p{L}])${CUENTA}${ES_CONNECT}|(?<![\p{L}])cci(?:\s+interbancari[oa])?${ES_CONNECT})\s*$`,
    "iu",
  );
  const CCI_LABEL = new RegExp(String.raw`(?<![\p{L}])cci(?:\s+interbancari[oa])?${ES_CONNECT}`, "giu");
  const AMOUNT_AFTER =
    /^\s*(?:pesos|euros?|d[oó]lares|dollars?|usd|eur|mxn|ars|cop|clp|pen|soles|€|\$|%|mil(?![\p{L}])|millones)/iu;
  function accountAfter(re, text, okDigits) {
    let byStart = null;
    const found = [];
    for (const m of text.matchAll(re)) {
      if (!byStart) byStart = new Map(numberRuns(text).map((r) => [r.units[0].start, r]));
      const run = byStart.get(m.index + m[0].length);
      if (!run || !okDigits(digitsOf(run.groups))) continue;
      const end = lastItem(lastItem(run.groups)).end;
      if (!AMOUNT_AFTER.test(text.slice(end, end + 12))) found.push(spanText(text, run.groups));
    }
    return found;
  }

  // Reads Mexico's CLABE (18 digits, the last a check digit) and Argentina's CBU and CVU (22 digits, two
  // check digits). The check digit makes these reliable enough to read a little after their name on the same
  // line, as in "Mi CLABE interbancaria para el depósito es …". A wrong check digit means it isn't one.
  const CHECKED_LABEL = /(?<![\p{L}])(clabe|cbu|cvu)(?![\p{L}])/giu;
  function clabeValid(d) {
    if (d.length !== 18) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += (Number(d[i]) * [3, 7, 1][i % 3]) % 10;
    return (10 - (sum % 10)) % 10 === Number(d[17]);
  }
  // Checks the bank and branch (7 digits) against the weights 7, 1, 3, 9 …, then the account (13 digits)
  // against 3, 9, 7, 1 …. Each check digit brings its part's sum up to a multiple of ten.
  function cbuValid(d) {
    const check = (from, to, weights) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += Number(d[i]) * weights[(i - from) % 4];
      return (10 - (sum % 10)) % 10 === Number(d[to]);
    };
    return d.length === 22 && check(0, 7, [7, 1, 3, 9]) && check(8, 21, [3, 9, 7, 1]);
  }
  // The same idea applies to phones (labelledAsOther): a Banamex CLABE starts with 002, which otherwise
  // reads like an international number.
  const CHECKED_NAME_BEFORE = /(?<![\p{L}])(?:clabe|cbu|cvu)(?![\p{L}])[^\n]*$/iu;
  function checkedAccountAt(text, run) {
    const d = digitsOf(run.groups);
    if (!clabeValid(d) && !cbuValid(d)) return false;
    const start = run.units[0].start;
    return CHECKED_NAME_BEFORE.test(text.slice(Math.max(0, start - 80), start));
  }
  function checkedAccounts(text) {
    const found = [];
    let runs = null;
    let k = 0; // the first run that starts after the last name read: names come in order, so each run is passed once
    for (const m of text.matchAll(CHECKED_LABEL)) {
      if (!runs) runs = numberRuns(text);
      const from = m.index + m[0].length;
      const valid = m[1].toLowerCase() === "clabe" ? clabeValid : cbuValid;
      while (k < runs.length && runs[k].units[0].start < from) k++;
      for (let j = k; j < runs.length && runs[j].units[0].start < from + 80; j++) {
        if (text.slice(from, runs[j].units[0].start).includes("\n")) break;
        if (!valid(digitsOf(runs[j].groups))) continue;
        found.push(spanText(text, runs[j].groups));
        break;
      }
    }
    return found;
  }

  // Reads an IBAN after its name in any case, like "iban: es26 0000 …". On its own, an IBAN must be in
  // capitals instead (see findIbans).
  const IBAN_LABELLED =
    /(?<![\p{L}])iban(?![\p{L}])\s*(?:(?:[:=#]|(?:is|was|es|era)(?![\p{L}]))\s*)?(?:(?:el|la)\s+)?([a-z]{2}\d{2}(?:[ -]?[a-z0-9]){11,30})(?![\p{L}\d])/giu;

  // The number before its name: "1234567890 is my account number", "1234567890 es mi número de cuenta".
  const ACCOUNT_NAMED_AFTER = new RegExp(
    String.raw`(?<![\p{L}\d])(?<!\d[-./])(\d{2,22}(?:[ -]\d{2,8}){0,5})\s*(?:,\s*)?(?:is|was|es|era)\s+(?:my|our|the|mi|el|nuestro)\s+(?:(?:(?:bank|checking|savings)\s+)?(?:account|acct)\s+(?:number|no\.?|#)|${CUENTA}|clabe|cbu|cvu)(?![\p{L}])`,
    "giu",
  );

  const accountSize = (d) => d.length >= 6 && d.length <= 22;
  // A UK sort code, an Australian BSB, or a Canadian transit and institution number, each read with the
  // account number right after it as one match, so Hide it takes the whole thing. None of these three has a
  // check digit, so on their own they'd be too easy to confuse with another number; the account right after
  // is what tells them apart from an everyday mention of a sort code or a BSB with nothing else next to it.
  // The gap after each name reads every run of spaces one way only, like the address gaps above.
  const BANK_CONNECT = String.raw`(?:\s*(?:number|no\.?|num|#))?\s*(?:(?:[:=#]|is|was)\s*)?`;
  const ACCOUNT_WORD = String.raw`account(?:\s+(?:number|no\.?|num|#))?`;
  const UK_SORT_CODE_RE = new RegExp(
    String.raw`\bsort\s*code\b${BANK_CONNECT}\d{2}[- ]?\d{2}[- ]?\d{2}\b[^\n\d]{0,30}\b${ACCOUNT_WORD}\b${BANK_CONNECT}\d{6,10}\b`,
    "gi",
  );
  const AU_BSB_RE = new RegExp(
    String.raw`\bBSB\b${BANK_CONNECT}\d{3}[- ]?\d{3}\b[^\n\d]{0,30}\b${ACCOUNT_WORD}\b${BANK_CONNECT}\d{3,10}(?:[ ]\d{3,6}){0,2}\b`,
    "gi",
  );
  const CA_TRANSIT_RE = new RegExp(
    String.raw`\btransit(?:\s+number)?\b${BANK_CONNECT}\d{5}\b[^\n\d]{0,30}\binstitution(?:\s+number)?\b${BANK_CONNECT}\d{3}\b[^\n\d]{0,30}\b${ACCOUNT_WORD}\b${BANK_CONNECT}\d{5,12}\b`,
    "gi",
  );
  const findBankNumbers = (text) => {
    const combined = [
      ...(text.match(UK_SORT_CODE_RE) || []),
      ...(text.match(AU_BSB_RE) || []),
      ...(text.match(CA_TRANSIT_RE) || []),
    ];
    const plain = [
      ...numberAfter(BANK_LABELS, text, (d) => d.length >= 6 && d.length <= 17),
      ...numberAfter([...ROUTING_LABELS, ROUTING_ES], text, abaValid),
      ...accountAfter(CUENTA_LABEL, text, accountSize),
      ...accountAfter(CCI_LABEL, text, (d) => d.length === 20),
      ...checkedAccounts(text),
      ...[...text.matchAll(IBAN_LABELLED)].map((m) => m[1]).filter((v) => ibanValid(v.toUpperCase())),
      ...[...text.matchAll(ACCOUNT_NAMED_AFTER)].map((m) => m[1]).filter((v) => accountSize(v.replace(/\D/g, ""))),
    ];
    // A sort code, BSB or transit number's own account digits would also match the plain "account …" label on
    // their own; dropping anything already inside a combined match keeps Hide it from leaving the code behind.
    const cloud = plain.some((v) => /^\d{12}$/.test(v)) ? awsAccountIds(text) : new Set();
    return [...combined, ...plain.filter((v) => !combined.some((c) => c.includes(v)) && !cloud.has(v))];
  };
  // An AWS account ID is 12 digits too, and "account 482019375564" beside an ARN, the word AWS or a region like
  // us-east-1 is that, not a bank account. A bank, checking, savings or routing word nearby still wins.
  const AWS_MARKER =
    /\barn:aws|(?<![\p{L}])AWS(?![\p{L}])|\b(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:north|south|east|west|central|northeast|southeast|northwest|southwest)-\d\b/iu;
  const BANK_WORD = /\b(?:bank|banking|checking|savings|routing|iban|swift|deposit|wire|ach)\b/i;
  function awsAccountIds(text) {
    const ids = new Set();
    for (const m of text.matchAll(/(?<!\d)\d{12}(?!\d)/g)) {
      const near = text.slice(Math.max(0, m.index - 80), m.index + 92);
      if (AWS_MARKER.test(near) && !BANK_WORD.test(near)) ids.add(m[0]);
    }
    // One mention in a bank's words keeps the number reported wherever else it appears.
    for (const m of text.matchAll(/(?<!\d)\d{12}(?!\d)/g)) {
      const near = text.slice(Math.max(0, m.index - 80), m.index + 92);
      if (BANK_WORD.test(near) || !AWS_MARKER.test(near)) ids.delete(m[0]);
    }
    return ids;
  }
  // A UK driving licence's 16-character number, unlabelled: 5 letters (the surname, padded with 9s if
  // shorter), 6 digits encoding the date of birth (month +50 for a woman, so it reads 1-12 or 51-62), 2
  // letters (initials, 9 if there's no middle one), a digit and 2 more letters. This is a structure check,
  // not the DVLA's full algorithm, so it's read only on its own, the same way a bare VIN is.
  const UK_DL_RE = /\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/g;
  function ukDlValid(v) {
    const month = Number(v.slice(6, 8)) % 50;
    const day = Number(v.slice(8, 10));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  const findUkLicences = (text) => (text.match(UK_DL_RE) || []).filter(ukDlValid);
  const CA_HEALTH_CARD_LABELS = [label(String.raw`(?:provincial\s+)?health\s+card|OHIP`)];
  const findMedicare = (text) => [
    ...(text.match(MBI_RE) || []),
    ...idAfter(MEDICARE_LABELS, text),
    ...numberAfter(AU_MEDICARE_LABELS, text, auMedicareValid),
    ...idAfter(CA_HEALTH_CARD_LABELS, text),
  ];
  // Also checks Spanish labels, in spanishLicenses and the functions below it.
  const findLicenses = (text) => [
    ...idAfter(LICENSE_LABELS, text),
    ...dlLicenses(text),
    ...spanishLicenses(text),
    ...findUkLicences(text),
  ];
  const findPassports = (text) => [...idAfter(PASSPORT_LABELS, text), ...spanishPassports(text)];
  const findInsuranceIds = (text) => [...idAfter(INSURANCE_LABELS, text), ...spanishInsuranceIds(text)];

  // ---------- Cars and school ----------

  // Names the car a Spanish label is about, like "del coche" or "de mi camioneta", for a VIN or a plate.
  const CAR = String.raw`(?:del?|de\s+(?:la|mi|tu|su))\s+(?:coche|carro|auto|veh[ií]culo|moto|camioneta|furgoneta)`;

  // A vehicle identification number is 17 letters and digits without I, O or Q. Right after its label, like
  // "VIN", "chassis number" or "número de bastidor", it matches in any case, since a VIN from outside North
  // America may have no check digit and the label is what vouches for it. Next to a vehicle word, it needs
  // a capitals code ending in four digits with a valid check digit instead. On its own, see VIN_ALONE below.
  const VIN_LABELLED = new RegExp(
    String.raw`\b(?:VIN|vehicle\s+identification|chassis|chasis|n[uú]mero\s+de\s+bastidor|bastidor|NIV|n[uú]mero\s+de\s+identificaci[oó]n\s+vehicular|n[uú]mero\s+de\s+serie\s+${CAR})(?![\p{L}\d])(?:\s*(?:number|no\.?|num|#))?\s*(?:(?:[:=#]|is|was|es|era)\s*)?([A-HJ-NPR-Z0-9]{17})(?![\p{L}\d])`,
    "giu",
  );
  const VIN_RE = /(?<![\p{L}\d_/-])[A-HJ-NPR-Z0-9]{13}\d{4}(?![\p{L}\d_/-])/gu;
  const VEHICLE_WORD = new RegExp(
    String.raw`(?<![\p{L}\d])(?:cars?|trucks?|vehicles?|title|registration|dealer(?:ship)?s?|insurance|auto|suv|van|pickup|sedan|motorcycle|motorbike|carfax|dmv|recall|coches?|carros?|autos?|veh[ií]culos?|camioneta|moto|concesionario|seguro|honda|toyota|ford|chevrolet|chevy|nissan|hyundai|kia|subaru|mazda|volkswagen|vw|bmw|mercedes|audi|jeep|dodge|gmc|tesla|lexus|acura|buick|cadillac|chrysler|volvo|porsche|mitsubishi|infiniti|fiat|peugeot|renault|citro[eë]n|skoda|opel|suzuki)(?![\p{L}\d])`,
    "iu",
  );
  // A VIN with no label and no vehicle word nearby only counts when every part of it checks out, so codes
  // that merely look like one stay quiet. The shape follows the US government's rules (NHTSA, 49 CFR 565.13
  // and 565.15): 17 characters, digits plus letters other than I, O and Q, with a check digit at position 9,
  // a model-year code at position 10 (skipping U, Z and 0), and a digit-only serial for the last four. It
  // also has to stand alone between spaces, commas or the message's edges, in capitals with at least 2
  // letters, so a link, file name or base64 blob that happens to contain a VIN-like substring stays quiet.
  // Among random codes, only 1 in 19,600 passes this, which is also why a code another label already claims
  // stays quiet too.
  const VIN_ALONE =
    /(?<=(?:^|[\s,;|])[([{"'«¿¡*_]{0,3})[A-HJ-NPR-Z0-9]{13}\d{4}(?=[)\]}"'».,;:!?*_]{0,4}(?:$|[\s,;|]))/gu;
  const VIN_YEAR = /[A-HJ-NPR-TV-Y1-9]/;
  // Right before a code, a label that says it's something else: "tracking number", "Order", "serial no.", "build".
  const OTHER_CODE_BEFORE =
    /(?<![\p{L}])(?:order|invoice|ticket|tracking|confirmation|booking|reservation|reference|ref|serial|part|sku|model|product|licen[cs]e|key|token|hash|commit|build|version|id|pedido|factura|referencia|reserva|localizador|seguimiento|serie|pieza|clave)(?![\p{L}])[^\n]{0,20}$/iu;
  // The check digit, from 49 CFR 565.15(c): each letter has a value (A-H are 1-8, J-N are 1-5, P is 7, R is
  // 9, S-Z are 2-9), and each position has a weight (8 7 6 5 4 3 2 10, then 0 for the check digit's own
  // position, then 9 8 7 6 5 4 3 2). The sum of value times weight, divided by 11, gives the check digit,
  // written as X when the remainder is 10.
  const VIN_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const VIN_VALUES = "12345678123457923456789";
  const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  function vinCheckValid(vin) {
    let sum = 0;
    for (let i = 0; i < 17; i++) {
      const c = vin[i];
      sum += (/\d/.test(c) ? Number(c) : Number(VIN_VALUES[VIN_LETTERS.indexOf(c)])) * VIN_WEIGHTS[i];
    }
    const check = sum % 11;
    return vin[8] === (check === 10 ? "X" : String(check));
  }
  const vinAlone = (vin) => (vin.match(/[A-Z]/g) || []).length >= 2 && VIN_YEAR.test(vin[9]) && vinCheckValid(vin);
  function findVins(text) {
    const found = [...text.matchAll(VIN_LABELLED)].map((m) => m[1]).filter((v) => /\d/.test(v));
    const vehicle = VEHICLE_WORD.test(text);
    if (vehicle) for (const [v] of text.matchAll(VIN_RE)) if (/[A-Z]/.test(v) && vinCheckValid(v)) found.push(v);
    for (const m of text.matchAll(VIN_ALONE)) {
      const otherLabel = !vehicle && OTHER_CODE_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index));
      if (!otherLabel && vinAlone(m[0])) found.push(m[0]);
    }
    return found;
  }

  // A plate as typed is up to three groups of letters and digits joined by a space, dash or middle dot, 2 to
  // 8 characters in all with at least one digit, like "AB12 CDE" or "ABC-123-D". A group joins the plate when
  // it has a digit, is in capitals, follows a dash or dot, or is a short lowercase group after an all-lowercase
  // start, but never when it's an everyday word like "and". A lowercase start with no digit isn't a plate, as
  // in "rego is due 12 May", and neither is a bare year or fewer than four digits alone.
  const PLATE_GROUP = /[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/y;
  const PLATE_STOP = new Set(
    "a i y e o u al and any are but can del did el en es for had has its la las lo los mi not now our por que su the too tu un una was yet you".split(
      " ",
    ),
  );
  const JUST_A_YEAR = /^(?:19|20)\d\d(?:[-/](?:\d\d|(?:19|20)\d\d))?$/;
  function plateAt(text, at) {
    const groups = [];
    let i = at;
    let size = 0;
    while (groups.length < 3) {
      PLATE_GROUP.lastIndex = i;
      const g = PLATE_GROUP.exec(text)?.[0];
      if (!g || size + g.length > 8) break;
      const digit = /\d/.test(g);
      if (!groups.length) {
        if (!digit && !/^[A-Z]{1,4}$/.test(g)) return null;
      } else {
        const joined = text[i - 1] !== " ";
        const lower = /^[a-z]{1,3}$/.test(g) && !/[A-Z]/.test(groups[0]) && !PLATE_STOP.has(g);
        if (!digit && !/^[A-Z]{1,4}$/.test(g) && !(joined && /^[A-Za-z]{1,4}$/.test(g)) && !lower) break;
      }
      groups.push(g);
      size += g.length;
      i += g.length;
      if (!/^[ \-·][A-Za-z0-9]/.test(text.slice(i, i + 2))) break;
      i++;
    }
    const plate = text.slice(at, at + groups.join(" ").length);
    const chars = groups.join("");
    if (size < 2 || !/\d/.test(chars)) return null;
    if (/^\d+$/.test(chars) && (chars.length < 4 || JUST_A_YEAR.test(plate))) return null;
    return plate;
  }
  // The plate shapes of Spain, Mexico and Argentina, like "1234 BCD" or "M-1234-AB". After "matrícula" these
  // count as a plate even with no car mentioned.
  const PLATE_SHAPED =
    /^(?:\d{4}[ -]?[B-DF-HJ-NP-TV-Z]{3}|[A-Z]{1,2}[ -]?\d{4}[ -]?[A-Z]{1,2}|[A-Z]{2,3}[ -]?\d{2,3}[ -]?[A-Z0-9]{1,2}|[A-Z]{2,3}[ -]?\d{3,4})$/i;

  // A student ID right after its label, like "student ID" or "número de estudiante", is letters and digits
  // with at least four digits, never a bare year like "student ID 2026". "Matrícula" doubles as both a
  // student number and a car plate in Spanish, so after it, something plate-shaped or near a vehicle word
  // reads as a plate and everything else as the student's number; with no label, a number never counts.
  const STUDENT_LABELS = [
    label(
      String.raw`(?:student|school)[\s-]*id(?:entification)?(?:\s+card)?|student[\s-]*card|student(?=\s*(?:number|no\.?|num|#)(?![a-z]))|matric(?:ulation)?(?=\s*(?:number|no\.?|#))`,
    ),
    /(?<![\p{L}])(?:(?:n[uú]mero|n[º°o]\.?|num\.?|c[oó]digo|id)\s+de\s+(?:estudiante|alumn[oa])|c[oó]digo\s+estudiantil|carn[eé]t?\s+(?:de\s+)?(?:estudiante|estudiantil|universitario))(?![\p{L}])\s*(?:[:=#]|es(?:\s+el)?|era)?\s*/giu,
  ];
  // "SID" is short for student ID at many universities ("SID 20481234"). In tech talk it's a Windows security ID
  // ("S-1-5-21-…"), a database's or a session's ID, or a PubChem substance's number. So it counts only in capitals,
  // right before 7 to 10 digits, and not in a message about computers or chemistry unless it's about school too.
  const SID_LABEL =
    /(?<![\p{L}\d])SID(?:\s*(?:number|no\.?|num|#))?\s*(?:(?:[:#]|is|was)\s*)?(\d{7,10})(?![\p{L}\d]|[-./,]\d)/gu;
  const SID_TECH =
    /(?<![\p{L}])(?:windows|security|domain|registry|powershell|active\s+directory|ldap|kerberos|sql|oracle|database|db|server|session|process|pid|kill|twilio|api|pubchem|substance|compound|cid|assay|chemical|molecule|gsm|cdma|network|cookie|token)(?![\p{L}])/iu;
  const SID_SCHOOL =
    /(?<![\p{L}])(?:students?|school|universit(?:y|ies)|uni|college|campus|class(?:es)?|course|professor|teacher|tutor|registrar|enrol(?:l?ment|led)?|exams?|grades?|tuition|library|semester|estudiantes?|universidad|escuela|colegio|profesora?|clases?|curso|ex[aá]men(?:es)?)(?![\p{L}])/iu;
  function findSids(text) {
    const found = [...text.matchAll(SID_LABEL)].map((m) => m[1]);
    return found.length && (!SID_TECH.test(text) || SID_SCHOOL.test(text)) ? found : [];
  }

  const MATRICULA =
    /(?<![\p{L}])(?:n[uú]mero\s+de\s+)?matr[ií]cula(?![\p{L}])\s*(?:[:=#]|es(?:\s+(?:la|el))?|era)?\s*/giu;
  // After "matrícula": { plate } when the value is a plate, else { id } when it's a student's number.
  function afterMatricula(text, m) {
    const at = m.index + m[0].length;
    const plate = plateAt(text, at);
    const near = () => VEHICLE_WORD.test(text.slice(Math.max(0, m.index - 60), at + plate.length + 40));
    if (plate && (PLATE_SHAPED.test(plate) || near())) return { plate };
    const id = idAt(text, at);
    return id && !JUST_A_YEAR.test(id) ? { id } : {};
  }
  const findStudentIds = (text) => [
    ...idAfter(STUDENT_LABELS, text).filter((v) => !JUST_A_YEAR.test(v)),
    ...[...text.matchAll(MATRICULA)].map((m) => afterMatricula(text, m).id).filter(Boolean),
    ...findSids(text),
  ];

  // A license plate right after its label, like "license plate", "plate number", "car reg" or "número de
  // placa". "Patente" only counts with a letter in it, since Argentina's and Chile's plates have one but a
  // patent's number doesn't. A bare "registration number" is a company's or a course's, not a plate. This
  // kind starts out set to Just count rather than warning.
  const PLATE_LABELS = [
    label(
      String.raw`licen[cs]e[\s-]+plates?|number\s+plates?|reg(?:istration)?\s+plates?|(?:car|vehicle)(?:'s)?\s+reg(?:istration)?|rego|plates?(?=\s*(?:number|no\.?|num|#)(?![a-z]))`,
    ),
    new RegExp(
      String.raw`(?<![\p{L}])(?:n[uú]mero\s+de\s+placa|placas?(?:\s+${CAR}|(?=\s*(?:[:=#]|es|son|era|eran)(?![\p{L}])))|matr[ií]cula\s+${CAR})(?![\p{L}])\s*(?:[:=#]|es|son|era|eran)?\s*`,
      "giu",
    ),
  ];
  const PATENTE = new RegExp(String.raw`(?<![\p{L}])patente(?:\s+${CAR})?(?![\p{L}])\s*(?:[:=#]|es|era)?\s*`, "giu");
  const platesAfter = (re, text) => [...text.matchAll(re)].map((m) => plateAt(text, m.index + m[0].length));
  const findPlates = (text) =>
    [
      ...PLATE_LABELS.flatMap((re) => platesAfter(re, text)),
      ...platesAfter(PATENTE, text).filter((p) => /[A-Za-z]/.test(p || "")),
      ...[...text.matchAll(MATRICULA)].map((m) => afterMatricula(text, m).plate),
    ].filter(Boolean);

  // ---------- Gamer tags: the handle reader ----------

  // A handle right after a gaming-account label, counted quietly (the kind starts as Just count). Handles are
  // everywhere in everyday chat ("add me on Discord", "my tag is"), so only a clear gaming label counts, like
  // "gamertag", "Riot ID" or "my IGN", a platform's username, name, ID or tag ("Xbox", "Steam", "Discord" and
  // the like), the same the other way round ("username on Roblox"), or a console's friend code.
  const GAME_SITE = String.raw`xbox(?:\s+live)?|psn|playstation(?:\s+network)?|steam|epic\s+games|riot(?:\s+games)?|battle\.net|minecraft|roblox|fortnite|discord`;
  const GAME_LABEL = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:gamer\s?tag|battle\s?tag|riot\s+id|summoner\s+name|nombre\s+de\s+invocador|in[\s-]game\s+name|(?:my|his|her|your|our|their|whose|mi|su|tu)\s+ign|(?:${GAME_SITE})\s+(?:user\s?name|user|(?:display\s+)?name|nick(?:name)?|handle|id|online\s+id|gamer\s?tag)|epic\s+(?:user\s?name|id|display\s+name)|(?:xbox|psn|playstation|discord)\s+tag|(?:nombre\s+de\s+usuario|user\s?name|usuario|nombre|name|nick(?:name)?|apodo|handle|id|tag|gamer\s?tag)\s+(?:on|in|for|de|en|para)\s+(?:${GAME_SITE}|epic))(?:\s+(?:on|in|for|de|en)\s+(?:${GAME_SITE}|epic))?(?![\p{L}\p{N}])(?:(?<link>['’]s(?![\p{L}\p{N}])|\s*[:=]|\s*(?:is|es)(?![\p{L}\p{N}]))|\s*(?:was|era)(?![\p{L}\p{N}]))?\s*`,
    "giu",
  );
  // A console's friend code is 12 digits in fours, with a Switch one starting "SW-" (Steam's is 8 to 10
  // digits instead). A shop's "friend code" with letters in it is a referral code, not a gamer's.
  const FRIEND_LABEL =
    /(?<![\p{L}\p{N}])(?:(?:(steam)|switch|nintendo|3ds|pok[eé]mon(?:\s+go)?)\s+)?(?:friend\s+code|c[oó]digo\s+de\s+amigo)(?![\p{L}\p{N}])\s*(?:[:=]|(?:is|was|es|era)(?![\p{L}\p{N}]))?\s*/giu;
  const FRIEND_CODE = /(?:SW[-\s]?)?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?![\p{L}\p{N}])/iuy;
  const STEAM_FRIEND_CODE = /\d{8,10}(?![\p{L}\p{N}])/uy;
  // Whose label it is: "my", "his", "mi", "Sam's", or one that starts the message, a line or a sentence ("Gamertag:
  // …"). "The Xbox name is Microsoft's" and "the name on Steam is Hollow Knight" are about the game, not a player.
  const OWNER_BEFORE =
    /(?:[\n.!?:;,(¿¡]\s*|(?<![\p{L}\p{N}])(?:my|his|her|your|our|their|mi|mis|su|sus|tu|tus)\s+|\p{L}['’]s\s+)$/iu;
  const OWNED_LABEL = /^(?:my|his|her|your|our|their|whose|mi|su|tu)\s/i;
  const DOT_AFTER_NO_END = new RegExp(String.raw`(?<![\p{L}])(${NO_SENTENCE_ENDS_ON})\.\s+$`, "iu");
  // A word made only of letters counts as a handle only right after someone's label that says "is", ":" or
  // "es" (or sits in quotes), and only when it isn't an ordinary word people actually write there, like
  // "private" or "banned". Fillers like "now" and "still" are skipped over, so "is now ShadowFox99" still
  // works.
  const HANDLE_FILLER =
    /(?:(?:now|still|currently|called|named|ahora|todav[ií]a|actualmente|ya)\s+){0,3}(["“”'‘`@]?)/iuy;
  const HANDLE_STOP = new Set(
    `a about above actually after again all also always am amazing an and another any anyone anything are as at
    available awesome bad banned basic basically be because been before being below best better between bigger
    black blank blue boring both broken but by can case chosen cool correct could cringe cringey cringy cute did
    different do does done down dumb each empty epic etc even every everyone everything fake fine fire for forgotten
    free from funny garbage given gold golden gone good got gotten gray great green grey had has have he her here
    hers hidden his hit i if in inappropriate incorrect into invalid is it its just kind kinda known lame left like
    literally lit long longer lost lowercase made me mean mid mine more my new newer nice no none not nothing now
    numbers of off offline ok okay old older on one online only or orange original other our out over perfect
    personal pink pretty private public purple random real really red reset right rude same secret seen set short
    shorter shown sick silly simply so some something sort still stolen stuck stupid such sus taken terrible than
    that the their them then there these they this those too toxic trash ugly under unique unknown up uppercase us
    used valid very visible was we weird well were what when where which while white who whose why will with
    without won worse worst wrong yellow yet you your yours
    al algo alguien aquí azul con cual cuál como cómo de del diferente el ella ellos en es esa ese eso esta este
    esto feo fea gracioso igual la largo larga las le lo los mas más me mejor mi mis mismo misma muy nada nadie ni
    no nos nuevo nueva o otra otro para peor pero por privado privada público pública que qué raro rara rojo se
    secreto si sí sin su sus también te todo tu tus un una uno verde viejo vieja y ya`.split(/\s+/),
  );
  const EVERYDAY_ENDING =
    /(?:ed|ing|ive|ous|ful|less|able|ible|ly|ish|ness|ment|tion|ado|ada|ido|ida|ble|oso|osa|mente|ción)$/;
  const HANDLE_RUN = /[\p{L}\p{N}_.-]+(?::\d+)*/uy;
  const HANDLE_TAG = /#[\p{L}\p{N}]{3,5}(?![\p{L}\p{N}#])/uy;
  // A Riot name may have spaces before its #tag ("Hide on bush#KR1").
  const HANDLE_SPACED = /[\p{L}\p{N}_.][\p{L}\p{N}_. ]{1,14}[\p{L}\p{N}_.]#[\p{L}\p{N}]{3,5}(?![\p{L}\p{N}#])/uy;
  const sticky = (re, text, at) => ((re.lastIndex = at), re.exec(text));
  function looksLikeHandle(name, firm) {
    if (HANDLE_STOP.has(name.toLowerCase())) return false;
    if (/^[\d.,:-]+$/.test(name)) return /^\d{15,}$/.test(name); // a Steam or Discord number, never a count or a year
    if (/^\d+[a-z]{1,3}$/i.test(name) || /\.(?:com|net|org|gg|io|tv|me|co|es|mx|uk|app|dev)$/i.test(name)) return false;
    if (/[\d_:]|\p{Ll}\p{Lu}|[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(name)) return true; // digits, "_", camelCase, a dot
    if (!firm) return false;
    const titled = /^\p{Lu}\p{Ll}/u.test(name);
    const parts = name.toLowerCase().split("-");
    return !parts.some((w) => HANDLE_STOP.has(w) || (!titled && w.length >= 6 && EVERYDAY_ENDING.test(w)));
  }
  function handleAt(text, at, firmLabel) {
    const lead = sticky(HANDLE_FILLER, text, at);
    const i = at + lead[0].length;
    const spaced = sticky(HANDLE_SPACED, text, i)?.[0];
    if (spaced && / /.test(spaced) && !HANDLE_STOP.has(spaced.split(" ")[0].toLowerCase())) return spaced;
    let name = sticky(HANDLE_RUN, text, i)?.[0];
    if (!name || !/^[\p{L}\p{N}_]/u.test(name)) return null;
    const tag = sticky(HANDLE_TAG, text, i + name.length)?.[0];
    if (tag) return name.length >= 2 && name.length <= 32 ? name + tag : null;
    if (/[@/]/.test(text[i + name.length] || "")) return null; // an email or a link, not a handle
    name = trimTrailing(name, /[.-]/);
    return name.length >= 3 && name.length <= 32 && looksLikeHandle(name, firmLabel || Boolean(lead[1])) ? name : null;
  }
  function findGamerTags(text) {
    const found = [];
    for (const m of text.matchAll(GAME_LABEL)) {
      // A dot after "the" or "my" starts no sentence: "The. Xbox name is…" is "The Xbox name is…".
      const lead = text.slice(Math.max(0, m.index - 12), m.index).replace(DOT_AFTER_NO_END, "$1 ");
      const owned = (m.index <= 12 && !lead.trim()) || OWNER_BEFORE.test(lead) || OWNED_LABEL.test(m[0]);
      found.push(handleAt(text, m.index + m[0].length, owned && Boolean(m.groups.link)));
    }
    for (const m of text.matchAll(FRIEND_LABEL)) {
      const at = m.index + m[0].length;
      found.push(sticky(FRIEND_CODE, text, at)?.[0] || (m[1] && sticky(STEAM_FRIEND_CODE, text, at)?.[0]));
    }
    return found.filter(Boolean);
  }

  // ---------- International IDs, medical record numbers, your IP ----------

  // An IBAN is a country's code, 2 check digits, then the account in that country's own layout. The mod-97
  // check has to pass too.
  const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g;
  // Each country's layout after the check digits, from SWIFT's IBAN Registry for ISO 13616 (89 countries).
  // "8n10n" means 8 digits then 10 digits, "a" is a capital letter and "c" is a letter or digit; Germany's
  // IBAN, for example, is 22 all-digit characters after "DE". A code from a country not listed, or of a
  // different length or layout, isn't treated as an IBAN, since the mod-97 check alone passes 1 random code
  // in 97. A territory that shares a country's code uses its layout too, so Jersey's IBANs start with GB.
  const IBAN_LAYOUTS = `
    AD 4n4n12c  AE 3n16n  AL 8n16c  AT 5n11n  AZ 4a20c  BA 3n3n8n2n  BE 3n7n2n  BG 4a4n2n8c  BH 4a14c  BI 5n5n11n2n
    BR 8n5n10n1a1c  BY 4c4n16c  CH 5n12c  CR 4n14n  CY 3n5n16c  CZ 4n6n10n  DE 8n10n  DJ 5n5n11n2n  DK 4n9n1n
    DO 4c20n  EE 2n14n  EG 4n4n17n  ES 4n4n1n1n10n  FI 3n11n  FK 2a12n  FO 4n9n1n  FR 5n5n11c2n  GB 4a6n8n  GE 2a16n
    GI 4a15c  GL 4n9n1n  GR 3n4n16c  GT 4c20c  HN 4a20n  HR 7n10n  HU 3n4n1n15n1n  IE 4a6n8n  IL 3n3n13n  IQ 4a3n12n
    IS 4n2n6n10n  IT 1a5n5n12c  JO 4a4n18c  KW 4a22c  KZ 3n13c  LB 4n20c  LC 4a24c  LI 5n12c  LT 5n11n  LU 3n13c
    LV 4a13c  LY 3n3n15n  MC 5n5n11c2n  MD 2c18c  ME 3n13n2n  MK 3n10c2n  MN 4n12n  MR 5n5n11n2n  MT 4a5n18c
    MU 4a2n2n12n3n3a  NI 4a20n  NL 4a10n  NO 4n6n1n  OM 3n16c  PK 4a16c  PL 8n16n  PS 4a21c  PT 4n4n11n2n  QA 4a21c
    RO 4a16c  RS 3n13n2n  RU 9n5n15c  SA 2n18c  SC 4a2n2n16n3a  SD 2n12n  SE 3n16n1n  SI 5n8n2n  SK 4n6n10n
    SM 1a5n5n12c  SO 4n3n12n  ST 4n4n11n2n  SV 4a20n  TL 3n14n2n  TN 2n3n13n2n  TR 5n1n16c  UA 6n19c  VA 3n15n
    VG 4a16n  XK 4n10n2n  YE 4a4n18c
  `;
  const IBAN_PART = { n: "\\d", a: "[A-Z]", c: "[A-Z0-9]" };
  const IBAN_SHAPES = new Map(
    [...IBAN_LAYOUTS.matchAll(/([A-Z]{2}) (\S+)/g)].map(([, country, layout]) => [
      country,
      new RegExp(`^${country}\\d\\d${layout.replace(/(\d+)([nac])/g, (_, n, k) => `${IBAN_PART[k]}{${n}}`)}$`),
    ]),
  );
  function ibanValid(raw) {
    const s = raw.replace(/[ -]/g, "");
    if (!IBAN_SHAPES.get(s.slice(0, 2))?.test(s)) return false;
    const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let rest = 0;
    for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97;
    return rest === 1;
  }
  const findIbans = (text) => (text.match(IBAN_RE) || []).filter(ibanValid);

  // A UK National Insurance number has no check digit, so a bare match of its shape passes about 1 random
  // code in 11.5. It only counts with an NI word nearby, the same rule a bare card or phone number follows
  // (cardLabelNear, internationalPhone).
  const NINO_RE = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi;
  const NINO_WORD =
    /\bnational\s+insurance(?:\s+number)?\b|\bNINO\b|\bNI\s*(?:number|no\.?)\b|\bN\.I\.|\bseguro\s+nacional\b/i;
  const ninoLabelNear = (text, index) =>
    NINO_WORD.test(text.slice(Math.max(0, index - 40), index)) || NINO_WORD.test(text.slice(index, index + 40));
  // Canadian Social Insurance Number: 9 digits after a label, Luhn-valid.
  const SIN_LABELS = [/\b(?:SIN|social insurance(?:\s+number)?)(?:\s*(?:#|no\.?|number))?\s*(?:is\s*)?[:#-]?\s*/g];
  // Spain: DNI (8 digits + check letter) and NIE (X/Y/Z + 7 digits + check letter). Mexico: CURP
  // (18 characters with a state code and a check digit). All validated, so ordinary codes stay quiet.
  const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
  const SPOKEN_DIGIT_TOKEN = `(?:\\d|zoro|${[...Object.keys(NUMBER_WORDS), ...Object.keys(WEAK_WORDS), ...Object.keys(SLIP_WORDS)].sort().join("|")})`;
  const SPOKEN_DNI_CANDIDATE = new RegExp(
    String.raw`\b(?:[XYZ][\s-]*)?${SPOKEN_DIGIT_TOKEN}(?:[\s-]+${SPOKEN_DIGIT_TOKEN}){6,7}[\s-]*[A-HJ-NP-TV-Z]\b`,
    "i",
  );
  const DNI_RE = /\b(\d{8}|\d{1,3}(?:[- ]\d{1,3}){1,2})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const NIE_RE = /\b([XYZ])[- ]?(\d{7}|\d{1,3}(?:[- ]\d{1,3}){1,2})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const CURP_RE =
    /\b[A-Z][AEIOUX][A-Z]{2}\d(?:-?\d){5}[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d\b/g;
  const CURP_CHARS = "0123456789ABCDEFGHIJKLMN\u00d1OPQRSTUVWXYZ";
  function curpValid(c) {
    const normalized = c.replace(/-/g, "");
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += CURP_CHARS.indexOf(normalized[i]) * (18 - i);
    return String((10 - (sum % 10)) % 10) === normalized[17];
  }
  function spokenDniNie(text) {
    if (!SPOKEN_DNI_CANDIDATE.test(text)) return [];
    const found = [];
    for (const run of readNumberRuns(text, true)) {
      if (!hasWord(run.groups)) continue;
      const digits = digitsOf(run.groups);
      const start = run.units[0].start;
      const end = lastItem(run.units).end;
      const check = /^\s*([A-HJ-NP-TV-Z])\b/.exec(text.slice(end));
      if (!check) continue;
      const before = text.slice(Math.max(0, start - 4), start);
      const prefix = /([XYZ])[\s-]*$/i.exec(before);
      const prefixStart = prefix ? start - prefix[0].length : start;
      if (prefix && (prefixStart === 0 || !isLetter(text[prefixStart - 1]))) {
        if (digits.length !== 7) continue;
        const value = Number("XYZ".indexOf(prefix[1].toUpperCase()) + Number(digits));
        if (DNI_LETTERS[value % 23] === check[1].toUpperCase()) {
          found.push(text.slice(start - prefix[0].length, end + check[0].length));
        }
      } else if (digits.length === 8 && DNI_LETTERS[Number(digits) % 23] === check[1].toUpperCase()) {
        found.push(text.slice(start, end + check[0].length));
      }
    }
    return found;
  }
  function spokenCurps(text) {
    const found = [];
    const tail = String.raw`[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}`;
    const spoken = new RegExp(
      String.raw`\b([A-Z][AEIOUX][A-Z]{2})\s*(${SPOKEN_DIGIT_TOKEN}(?:[\s-]+${SPOKEN_DIGIT_TOKEN}){5})\s*(${tail})\s*(?:([A-Z])\s*(${SPOKEN_DIGIT_TOKEN})|(${SPOKEN_DIGIT_TOKEN})\s*(${SPOKEN_DIGIT_TOKEN}))\b`,
      "gi",
    );
    const toDigit = (token) =>
      /^\d$/.test(token)
        ? token
        : NUMBER_WORDS[token.toLowerCase()] ||
          WEAK_WORDS[token.toLowerCase()] ||
          SLIP_WORDS[token.toLowerCase()] ||
          readSlip(token, 0)?.digits ||
          "";
    for (const match of text.matchAll(spoken)) {
      const date = match[2]
        .split(/[\s-]+/)
        .map(toDigit)
        .join("");
      const check = match[4] || toDigit(match[6]);
      const last = toDigit(match[5] || match[7]);
      if (date.length !== 6 || !/^[A-Z0-9]$/.test(check) || !/^\d$/.test(last)) continue;
      const value = `${match[1]}${date}${match[3]}${check}${last}`.toUpperCase();
      CURP_RE.lastIndex = 0;
      const hasShape = CURP_RE.test(value);
      CURP_RE.lastIndex = 0;
      if (hasShape && curpValid(value)) {
        found.push(match[0]);
      }
    }
    return found;
  }
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
  const US_ID_LABELLED =
    /\b(?:ITIN|EIN|TIN|tax\s*(?:payer\s*)?id(?:entification)?(?:\s+number)?|employer\s+identification\s+number|a-?number|alien\s+(?:registration\s+)?number|uscis\s*(?:number|#)|green\s+card(?:\s+(?:number|receipt))?|va\s+(?:file|claim)\s+number)\s*(?:(?:#|no\.?|number)\s*)?(?:(?:is|:|=)\s*)?((?:[A-Z]{1,3}[\s-]?)?\d(?:[\d-]{6,12})\d)(?![\d-])/gi;

  // ---------- National IDs from other countries ----------
  // Each has a public check (digits, a letter or a key), so a random number of the same shape passes 1 time in
  // 10 to 97 at most, and most also carry a birth date that has to be real. The ones that are only digits, a
  // shape order numbers, phones and timestamps share, count only after their label. The ones with a layout of
  // their own count anywhere: Brazil's dotted CPF and CNPJ, France's spaced NIR, Italy's codice fiscale,
  // Singapore's NRIC, Korea's dashed RRN and China's 18-digit resident ID.
  const ID_WORD = (words) => String.raw`(?<![\p{L}\d])(?:${words})(?![\p{L}])`;
  // A label, up to 20 characters that aren't digits ("CPF:", "my BSN is", "numer PESEL", "Nr."), then the value.
  const ID_END = String.raw`(?![\p{L}\d]|[.,/-]\d)`;
  // The value can also start the next line, under a label of its own ("CPF:" then the number).
  const labelledId = (labelSource, value, flags = "giu") =>
    new RegExp(String.raw`(?:${labelSource})[^\n\d]{0,20}?(?:\n[ \t]*)?(?<![\p{L}\d])(${value})${ID_END}`, flags);
  const bareId = (value, flags = "gu") => new RegExp(String.raw`(?<![\p{L}\d]|\d[.,/-])(?:${value})${ID_END}`, flags);
  const idDigits = (v) => v.replace(/[^\dA-Za-z]/g, "").toUpperCase();
  const realDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  const NOW_YEAR = new Date().getUTCFullYear();
  // A birth year a bare number can carry: someone at least 10 and under 100. Order and booking references
  // dated this decade fit the same shapes, and read as a young child (or, in the other century, someone
  // over 100). After the ID's own label, any real birth date counts.
  const adultBirthYear = (y) => y <= NOW_YEAR - 10 && y > NOW_YEAR - 100;
  const weighted = (d, weights) => weights.reduce((s, w, i) => s + w * Number(d[i]), 0);
  // Ireland's PPS number has seven digits and a mod-23 check letter. A second letter can follow it. English
  // labels and the Irish name, Uimhir Phearsanta Seirbhíse Poiblí, all point to the same national ID.
  const PPS_CHECK = "WABCDEFGHIJKLMNOPQRSTUV";
  function ppsValid(value) {
    const v = idDigits(value);
    const m = /^(\d{7})([A-W])([A-IW]?)$/.exec(v);
    if (!m) return false;
    const extra = m[3] && m[3] !== "W" ? (m[3].charCodeAt(0) - 64) * 9 : 0;
    return PPS_CHECK[(weighted(m[1], [8, 7, 6, 5, 4, 3, 2]) + extra) % 23] === m[2];
  }
  const PPS_VALUE = String.raw`\d(?:[ \t-]?\d){6}[ \t-]?[A-W][A-IW]?`;
  const PPS_LABELLED = labelledId(
    ID_WORD(
      String.raw`PPSN|PPS\s*(?:number|no\.?|#)|personal\s+public\s+service(?:\s+number)?|UPSP|PSP|uimhir\s+(?:phearsanta\s+)?seirbh[ií]se\s+poibl[ií]`,
    ),
    PPS_VALUE,
  );
  const PPS_BARE = bareId(PPS_VALUE);

  // Inland Revenue checks eight or nine digits with two mod-11 weight sets. Keep this label-only: a valid
  // checksum still passes often enough for order numbers, phone numbers and other bare digit strings to collide.
  const IRD_LABELLED = labelledId(
    ID_WORD(String.raw`(?:New\s+Zealand\s+)?(?:IRD|Inland\s+Revenue(?:\s+Department)?)`),
    String.raw`\d{2,3}(?:[ \t-]?\d{3}){2}`,
  );
  const IRD_PRIMARY = [3, 2, 7, 6, 5, 4, 3, 2];
  const IRD_SECONDARY = [7, 4, 3, 2, 5, 2, 7, 6];
  function irdValid(value) {
    const d = idDigits(value);
    const n = Number(d);
    if (!/^\d{8,9}$/.test(d) || n < 10000000 || n > 200000000) return false;
    const base = d.slice(0, -1).padStart(8, "0");
    const checkFor = (weights) => {
      const remainder = weighted(base, weights) % 11;
      return remainder === 0 ? 0 : 11 - remainder;
    };
    let check = checkFor(IRD_PRIMARY);
    if (check === 10) check = checkFor(IRD_SECONDARY);
    return check < 10 && check === Number(d[d.length - 1]);
  }

  // New Zealand NHI checks use letters A–Z without I or O. The old seven-character form ends in a mod-11
  // digit; the expanded form ends in a mod-23 letter.
  const NHI_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const NHI_SHAPE = String.raw`(?:[A-HJ-NP-Z]{3}\d{3}\d|[A-HJ-NP-Z]{3}\d{2}[A-HJ-NP-Z]{2})`;
  const NHI_LABELLED = labelledId(ID_WORD(String.raw`NHI|National\s+Health\s+Index`), NHI_SHAPE);
  const NHI_BARE = bareId(NHI_SHAPE);
  function nhiValid(value) {
    const d = idDigits(value);
    const old = /^([A-HJ-NP-Z]{3})(\d{3})(\d)$/.exec(d);
    if (old) {
      const body = old[1] + old[2];
      const sum = [...body].reduce(
        (total, ch, i) => total + (/[A-Z]/.test(ch) ? NHI_LETTERS.indexOf(ch) + 1 : Number(ch)) * (7 - i),
        0,
      );
      const remainder = sum % 11;
      const check = 11 - remainder;
      return remainder !== 0 && check <= 9 && check === Number(old[3]);
    }
    const newer = /^([A-HJ-NP-Z]{3})(\d{2})([A-HJ-NP-Z])([A-HJ-NP-Z])$/.exec(d);
    if (!newer) return false;
    const body = newer[1] + newer[2] + newer[3];
    const sum = [...body].reduce(
      (total, ch, i) => total + (/[A-Z]/.test(ch) ? NHI_LETTERS.indexOf(ch) + 1 : Number(ch)) * (7 - i),
      0,
    );
    return NHI_LETTERS[23 - (sum % 23) - 1] === newer[4];
  }

  // Brazil: CPF (people) and CNPJ (companies), two mod-11 check digits each.
  function mod11Br(d, weights) {
    const r = weighted(d, weights) % 11;
    return r < 2 ? 0 : 11 - r;
  }
  function cpfValid(v) {
    const d = idDigits(v);
    if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
    return (
      mod11Br(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[9]) &&
      mod11Br(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[10])
    );
  }
  function cnpjValid(v) {
    const d = idDigits(v);
    if (!/^\d{14}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
    return (
      mod11Br(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[12]) &&
      mod11Br(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[13])
    );
  }
  const CPF_LABEL = ID_WORD(String.raw`C\.?P\.?F\.?`);
  const CNPJ_LABEL = ID_WORD(String.raw`C\.?N\.?P\.?J\.?`);
  const CPF_VALUE = String.raw`\d{3}[. ]?\d{3}[. ]?\d{3}[-. ]?\d{2}`;
  const CNPJ_VALUE = String.raw`\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}`;
  const CPF_LABELLED = labelledId(CPF_LABEL, CPF_VALUE);
  const CNPJ_LABELLED = labelledId(CNPJ_LABEL, CNPJ_VALUE);
  const CPF_DOTTED = bareId(String.raw`\d{3}\.\d{3}\.\d{3}-\d{2}`);
  const CNPJ_DOTTED = bareId(String.raw`\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}`);
  // India's PAN: its fourth letter says who holds it (P a person, C a company, …). No public check, so only
  // after its label.
  const PAN_VALUE = String.raw`[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]`;
  const PAN_LABELLED = labelledId(ID_WORD(String.raw`PAN|permanent\s+account\s+number`), PAN_VALUE);
  const panValid = (v) => new RegExp(`^${PAN_VALUE}$`, "i").test(v);
  // France's NIR (social security number): sex, birth year and month, department (2A/2B for Corsica), town,
  // order, then a key of 97 minus the first 13 digits mod 97.
  const NIR_VALUE = String.raw`[1-478]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}\s?\d{2}`;
  const NIR_LABELLED = labelledId(
    ID_WORD(String.raw`NIR|INSEE|s[ée]curit[ée]\s+sociale|s[ée]cu|carte\s+vitale`),
    NIR_VALUE,
  );
  const NIR_SPACED = bareId(String.raw`[12] \d{2} \d{2} (?:\d{2}|2[AB]) \d{3} \d{3} \d{2}`, "giu");
  function nirValid(v) {
    const s = idDigits(v);
    if (!/^[1-478]\d{2}(?:0[1-9]|1[0-2]|[2-9]\d)(?:\d{2}|2[AB])\d{8}$/.test(s)) return false;
    let rest = 0;
    for (const ch of s.slice(0, 13).replace("2A", "19").replace("2B", "18")) rest = (rest * 10 + Number(ch)) % 97;
    return 97 - rest === Number(s.slice(13));
  }
  // The Netherlands' BSN: the "11-test" (9×d1 + 8×d2 + … + 2×d8 − d9 is a multiple of 11).
  const BSN_VALUE = String.raw`\d{9}|\d{4}\.\d{2}\.\d{3}|\d{3}[ .]\d{3}[ .]\d{3}`;
  const BSN_LABELLED = labelledId(ID_WORD(String.raw`BSN|burgerservicenummer|sofi-?nummer`), BSN_VALUE);
  function bsnValid(v) {
    const d = idDigits(v);
    return /^\d{9}$/.test(d) && d !== "000000000" && weighted(d, [9, 8, 7, 6, 5, 4, 3, 2, -1]) % 11 === 0;
  }
  // Poland's PESEL: birth date (the century added to the month), serial, weighted check digit.
  const PESEL_VALUE = String.raw`\d{11}|\d{3} \d{3} \d{3} \d{2}`;
  const PESEL_LABELLED = labelledId(ID_WORD("PESEL"), PESEL_VALUE);
  const PESEL_CENTURY = { 0: 1900, 1: 2000, 2: 2100, 3: 2200, 4: 1800 };
  function peselValid(v) {
    const d = idDigits(v);
    if (!/^\d{11}$/.test(d)) return false;
    const mm = Number(d.slice(2, 4));
    const century = PESEL_CENTURY[Math.floor(mm / 20)];
    if (!realDate(century + Number(d.slice(0, 2)), mm % 20, Number(d.slice(4, 6)))) return false;
    return (10 - (weighted(d, [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]) % 10)) % 10 === Number(d[10]);
  }
  // Italy's codice fiscale: 6 letters of name, birth year, month letter, day (+40 for women), town code, check
  // letter. Digits can be swapped for letters (L for 0 … V for 9) when two people would share one.
  const CF_VALUE = String.raw`[A-Z]{6}[\dLMNP-V]{2}[ABCDEHLMPRST][\dLMNP-V]{2}[A-Z][\dLMNP-V]{3}[A-Z]`;
  const CF_BARE = bareId(CF_VALUE);
  const CF_LABELLED = labelledId(ID_WORD(String.raw`codice\s+fiscale|C\.F\.`), CF_VALUE);
  const CF_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
  function cfValid(v) {
    const s = v.toUpperCase();
    const day = Number(s.slice(9, 11).replace(/[LMNP-V]/g, (c) => "LMNPQRSTUV".indexOf(c)));
    if (!((day >= 1 && day <= 31) || (day >= 41 && day <= 71))) return false;
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      const n = /\d/.test(s[i]) ? Number(s[i]) : s.charCodeAt(i) - 65;
      sum += i % 2 === 0 ? CF_ODD[n] : n;
    }
    return String.fromCharCode(65 + (sum % 26)) === s[15];
  }
  // Singapore's NRIC and FIN: S or T (citizens), F or G (foreigners), 7 digits, a check letter. A T number
  // starts with its holder's birth year (2000 on), so it can't be ahead of this year.
  const NRIC_BARE = bareId(String.raw`[STFG]\d{7}[A-Z]`);
  function nricValid(v) {
    if (v[0] === "T" && 2000 + Number(v.slice(1, 3)) > NOW_YEAR) return false;
    const sum = weighted(v.slice(1, 8), [2, 7, 6, 5, 4, 3, 2]) + (/[TG]/.test(v[0]) ? 4 : 0);
    return ("ST".includes(v[0]) ? "JZIHGFEDCBA" : "XWUTRQPNMLK")[sum % 11] === v[8];
  }
  // South Africa's ID: birth date, serial, citizenship (0, 1 or 2), a digit, Luhn. Bare 13 digits are often
  // timestamps, so only after an ID label.
  const SA_ID_VALUE = String.raw`\d{6}\s?\d{4}\s?\d{3}`;
  const SA_ID_LABELLED = labelledId(
    ID_WORD(
      String.raw`(?:SA|RSA|South\s+African)\s+ID(?:\s+(?:number|no\.?|#))?|identity\s+(?:number|no\.?)|ID\s*(?:number|no\.?|#)`,
    ),
    SA_ID_VALUE,
  );
  function saIdValid(v) {
    const d = idDigits(v);
    return /^\d{10}[012]\d{2}$/.test(d) && realDate(2000, Number(d.slice(2, 4)), Number(d.slice(4, 6))) && luhn(d);
  }
  // Germany's Steuer-ID: 11 digits, the first not 0, one digit used twice or three times in the first ten (the
  // rest at most once), an ISO 7064 MOD 11,10 check digit.
  const STEUER_VALUE = String.raw`\d{2}\s?\d{3}\s?\d{3}\s?\d{3}`;
  const STEUER_LABELLED = labelledId(
    ID_WORD(
      String.raw`steuer-?id(?:nr\.?)?|steuer-?identifikationsnummer|steuerliche\s+identifikationsnummer|identifikationsnummer|IdNr\.?`,
    ),
    STEUER_VALUE,
  );
  function steuerIdValid(v) {
    const d = idDigits(v);
    if (!/^[1-9]\d{10}$/.test(d)) return false;
    const counts = new Array(10).fill(0);
    for (const ch of d.slice(0, 10)) counts[Number(ch)]++;
    if (counts.filter((c) => c > 1).length !== 1 || counts.some((c) => c > 3)) return false;
    let product = 10;
    for (const ch of d.slice(0, 10)) {
      const sum = (Number(ch) + product) % 10 || 10;
      product = (sum * 2) % 11;
    }
    return (11 - product) % 10 === Number(d[10]);
  }
  // South Korea's resident registration number: birth date, a digit for sex and century, then 6 digits. Its
  // last digit was a check digit until late 2020, so bare ones need it; after a label the date is enough.
  const RRN_CENTURY = { 1: 1900, 2: 1900, 3: 2000, 4: 2000, 5: 1900, 6: 1900, 7: 2000, 8: 2000 };
  const RRN_BARE = bareId(String.raw`\d{6}-[1-8]\d{6}`);
  const RRN_SHAPE = bareId(String.raw`\d{6}-\d{7}`);
  const RRN_VALUE = String.raw`\d{6}-?[1-8]\d{6}`;
  const RRN_LABELLED = labelledId(
    String.raw`주민등록번호|주민번호|${ID_WORD(String.raw`RRN|resident\s+registration\s+number`)}`,
    RRN_VALUE,
  );
  const rrnYear = (d) => RRN_CENTURY[d[6]] + Number(d.slice(0, 2));
  function rrnDated(v) {
    const d = idDigits(v);
    return rrnYear(d) <= NOW_YEAR && realDate(rrnYear(d), Number(d.slice(2, 4)), Number(d.slice(4, 6)));
  }
  const rrnValid = (v) => {
    const d = idDigits(v);
    return (
      rrnDated(v) &&
      adultBirthYear(rrnYear(d)) &&
      (11 - (weighted(d, [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]) % 11)) % 10 === Number(d[12])
    );
  };
  // Japan's My Number: 12 digits, the last a check digit. In English only "My Number" in capitals, since "my
  // number is …" is usually a phone.
  const MY_NUMBER_VALUE = String.raw`\d{4}\s?\d{4}\s?\d{4}`;
  const MY_NUMBER_LABELLED = labelledId(
    String.raw`マイナンバー|個人番号|(?<![\p{L}])(?:My\s?Number|[Ii]ndividual\s+[Nn]umber)(?![\p{L}])`,
    MY_NUMBER_VALUE,
    "gu",
  );
  function myNumberValid(v) {
    const d = idDigits(v);
    if (!/^\d{12}$/.test(d)) return false;
    let sum = 0;
    for (let n = 1; n <= 11; n++) sum += Number(d[11 - n]) * (n <= 6 ? n + 1 : n - 5);
    const r = sum % 11;
    return (r <= 1 ? 0 : 11 - r) === Number(d[11]);
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
  function cnIdValid(v, text, index) {
    const d = v.toUpperCase();
    const year = Number(d.slice(6, 10));
    if (!CN_PROVINCE.test(d) || year > NOW_YEAR) return false;
    if (!realDate(year, Number(d.slice(10, 12)), Number(d.slice(12, 14)))) return false;
    const sum = weighted(d, [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]);
    if ("10X98765432"[sum % 11] !== d[17]) return false;
    return adultBirthYear(year) || CN_ID_LABEL_BEFORE.test(text.slice(Math.max(0, index - 40), index));
  }
  const valuesOf = (re, text, ok) => [...text.matchAll(re)].map((m) => m[1] ?? m[0]).filter(ok);

  // A bare ID right after the name of something else ("Order", "SKU", "ref", "Commande:", "Pedido nº") is
  // that thing's number.
  const ID_REFERENCE_BEFORE =
    /(?<![\p{L}])(?:order|invoice|ticket|sku|ref|reference|tracking|booking|confirmation|transaction|txn|serial|model|part|item|article|artikel|art\.?-?nr|bestell|rechnung|auftrag|commande|facture|pedido|factura|ordine|fattura|zam[oó]wieni|faktur|factuur|reserv|주문|注文|订单|运单|快递)\p{L}*[^\n\d\p{L}]{0,6}(?:(?:no|nr|n[º°o]|num(?:ber|ero|éro)?|id|de|do|da)\.?[^\n\d\p{L}]{0,4})?$/iu;
  // Bare IDs, minus those after a reference label. When most numbers of the same shape in the message fail the
  // check (a column of order references, an SQL dump of 18-digit ids), the few that pass are chance and none
  // counts. A list of real IDs passes all of them.
  function bareIds(re, text, ok, shape = re) {
    const valid = [];
    for (const m of text.matchAll(re)) if (ok(m[0], text, m.index)) valid.push(m);
    if (!valid.length) return [];
    const all = [...text.matchAll(shape)].length;
    if (all >= 3 && valid.length * 2 < all) return [];
    return valid
      .filter((m) => !ID_REFERENCE_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index)))
      .map((m) => m[0]);
  }

  // The IDs that only count after their label, also found under a CSV or table column of that name, or as the
  // value of a JSON, YAML or URL key named for them ("cpfNumber", "nr_pesel", "steuerIdNr"). The column or key
  // name is split into words first, so "cpfNumber" reads "cpf number".
  const LABEL_ONLY_IDS = [
    [/\bcpf\b/, CPF_VALUE, cpfValid],
    [/\bcnpj\b/, CNPJ_VALUE, cnpjValid],
    [/\bpan\b|\bpermanent account number\b/, PAN_VALUE, panValid],
    [/\b(?:nir|insee|s[eé]cu|carte vitale)\b|s[eé]curit[eé] sociale/, NIR_VALUE, nirValid],
    [/\b(?:bsn|burgerservicenummer|sofi ?nummer)\b/, BSN_VALUE, bsnValid],
    [/\bpesel\b/, PESEL_VALUE, peselValid],
    [/\b(?:(?:sa|rsa|south african) id|identity (?:number|no)|id (?:number|no))\b/, SA_ID_VALUE, saIdValid],
    [/\b(?:steuer ?id|steuer ?identifikationsnummer|identifikationsnummer|id ?nr)\b/, STEUER_VALUE, steuerIdValid],
    [/\brrn\b|\bresident registration\b|주민등록번호|주민번호/, RRN_VALUE, rrnDated],
    [/\b(?:my ?number|individual number)\b|マイナンバー|個人番号/, MY_NUMBER_VALUE, myNumberValid],
  ].map(([name, value, ok]) => ({
    name,
    whole: new RegExp(`^(?:${value})$`, "i"),
    at: new RegExp(`(?:${value})${ID_END}`, "iuy"),
    ok,
  }));
  const ID_NAME_HINT =
    /cpf|cnpj|pan|nir|insee|s[eé]cu|vitale|bsn|burgerservice|sofi|pesel|identity|id|steuer|identifikation|rrn|resident|number|주민|マイナンバー|個人番号/i;
  const nameWords = (name) =>
    name
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/[_.\-\s]+/g, " ")
      .trim()
      .toLowerCase();
  const kindsNamed = (name) => {
    const words = nameWords(name);
    return LABEL_ONLY_IDS.filter((k) => k.name.test(words));
  };
  const ID_KEY_RE = /(?<![\p{L}\d_])["']?(\p{L}[\p{L}\d_.-]{0,40}?)["']?[ \t]*[:=][ \t]*["']?(?=[\dA-Za-z])/gu;
  function keyedIds(text) {
    const found = [];
    for (const m of text.matchAll(ID_KEY_RE)) {
      if (!ID_NAME_HINT.test(m[1])) continue;
      for (const kind of kindsNamed(m[1])) {
        kind.at.lastIndex = m.index + m[0].length;
        const value = kind.at.exec(text);
        if (value && kind.ok(value[0])) found.push(value[0]);
      }
    }
    return found;
  }
  const cellsOf = (line) => {
    const sep = ["|", "\t", ",", ";"].find((s) => line.includes(s));
    return sep ? line.split(sep).map((c) => c.trim().replace(/^["']|["']$/g, "")) : [line];
  };
  function idColumns(text) {
    if (!text.includes("\n") || !ID_NAME_HINT.test(text)) return [];
    const found = [];
    let columns = null;
    for (const line of text.split("\n")) {
      const cells = cellsOf(line);
      if (cells.length < 2) {
        columns = null;
        continue;
      }
      const header = [];
      cells.forEach((c, i) => {
        if (c.length <= 40 && !/\d/.test(c) && ID_NAME_HINT.test(c)) {
          const kinds = kindsNamed(c);
          if (kinds.length) header.push([i, kinds]);
        }
      });
      if (header.length) {
        columns = header;
        continue;
      }
      for (const [i, kinds] of columns || []) {
        const cell = cells[i];
        if (cell && kinds.some((k) => k.whole.test(cell) && k.ok(cell))) found.push(cell);
      }
    }
    return found;
  }

  // Each value once, though a dotted CPF after its label is read by both its rules. National IDs, cards and phones
  // all ask for these on the same text, so the last text's answer is kept and handed out as a copy.
  let lastWorldIdsText = null;
  let lastWorldIds = null;
  const worldNationalIds = (text) => {
    if (text !== lastWorldIdsText) {
      lastWorldIds = readWorldNationalIds(text);
      lastWorldIdsText = text;
    }
    return [...lastWorldIds];
  };
  const readWorldNationalIds = (text) => [
    ...new Set([
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
      ...bareIds(CF_BARE, text, cfValid),
      ...valuesOf(CF_LABELLED, text, (v) => v !== v.toUpperCase() && cfValid(v)),
      ...bareIds(NRIC_BARE, text, nricValid),
      ...valuesOf(SA_ID_LABELLED, text, saIdValid),
      ...valuesOf(STEUER_LABELLED, text, steuerIdValid),
      ...bareIds(RRN_BARE, text, rrnValid, RRN_SHAPE),
      ...valuesOf(RRN_LABELLED, text, rrnDated),
      ...valuesOf(MY_NUMBER_LABELLED, text, myNumberValid),
      ...bareIds(CN_ID_BARE, text, cnIdValid, CN_ID_SHAPE),
      ...keyedIds(text),
      ...idColumns(text),
    ]),
  ];
  const findNationalIds = (text) => [
    ...worldNationalIds(text),
    ...(text.match(ITIN_RE) || []),
    ...[...text.matchAll(US_ID_LABELLED)].map((m) => m[1]),
    ...[...text.matchAll(RFC_RE)].map((m) => m[1]),
    ...[...text.matchAll(NSS_RE)].map((m) => m[1]),
    ...[...text.matchAll(NINO_RE)].filter((m) => ninoLabelNear(text, m.index)).map((m) => m[0]),
    ...numberAfter(SIN_LABELS, text, (d) => d.length === 9 && luhn(d.padStart(13, "0"))),
    ...numberAfter(AADHAAR_LABELS, text, aadhaarValid),
    ...numberAfter(TFN_LABELS, text, tfnValid),
    // A check letter right before a drive separator (E:\, T:/) belongs to the path, not an ID.
    ...[...text.matchAll(DNI_RE)]
      .filter(
        (m) =>
          m[1].replace(/\D/g, "").length === 8 &&
          DNI_LETTERS[Number(m[1].replace(/\D/g, "")) % 23] === m[2] &&
          !/^:[\\/]/.test(text.slice(m.index + m[0].length)),
      )
      .map((m) => m[0]),
    ...[...text.matchAll(NIE_RE)]
      .filter(
        (m) =>
          m[2].replace(/\D/g, "").length === 7 &&
          DNI_LETTERS[Number("XYZ".indexOf(m[1]) + m[2].replace(/\D/g, "")) % 23] === m[3] &&
          !/^:[\\/]/.test(text.slice(m.index + m[0].length)),
      )
      .map((m) => m[0]),
    ...spokenDniNie(text),
    ...(text.match(CURP_RE) || []).filter(curpValid),
    ...spokenCurps(text),
    ...spanishNationalIds(text),
  ];

  // Reads medical record and patient numbers after their label, and UK NHS numbers (10 digits, with a mod
  // 11 check). When "MRN" has letters right after it, like "MRNWQ3FY8P394VH6U", that's the start of a code,
  // not a label, though "MRN00123456" still counts.
  const MRN_LABELS = [
    /\b(?:MRN(?![a-z])|medical\s+record(?:\s+(?:number|no\.?|#))?|patient\s+(?:id|number|no\.?|#))\s*(?:is\s*)?[:#-]?\s*/gi,
  ];
  const NHS_LABELS = [/\bNHS(?:\s+(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  function nhsValid(d) {
    if (!/^\d{10}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    return check !== 10 && check === Number(d[9]);
  }
  const findMedicalRecords = (text) => [
    ...idAfter(MRN_LABELS, text),
    ...numberAfter(NHS_LABELS, text, nhsValid),
    ...spanishMedicalRecords(text),
  ];

  // India's Aadhaar (12 digits, Verhoeff check) and Australia's Tax File Number (9 digits, weighted check),
  // after their label.
  const AADHAAR_LABELS = [/\b(?:aadhaar|aadhar|UIDAI?)(?:\s+(?:card\s+)?(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  const TFN_LABELS = [/\b(?:TFN|tax\s+file\s+number)\s*(?:is\s*)?[:#-]?\s*/gi];
  const VERHOEFF_D = [
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
  const VERHOEFF_P = [
    "0123456789",
    "1576283094",
    "5803796142",
    "8916043527",
    "9453126870",
    "4286573901",
    "2793806415",
    "7046913258",
  ];
  function verhoeffValid(d) {
    let c = 0;
    [...d].reverse().forEach((ch, i) => {
      c = Number(VERHOEFF_D[c][Number(VERHOEFF_P[i % 8][Number(ch)])]);
    });
    return c === 0;
  }
  const aadhaarValid = (d) => /^[2-9]\d{11}$/.test(d) && verhoeffValid(d);
  const TFN_WEIGHTS = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  const tfnValid = (d) =>
    /^\d{9}$/.test(d) && [...d].reduce((s, ch, i) => s + Number(ch) * TFN_WEIGHTS[i], 0) % 11 === 0;
  // Australian Medicare card: 10 digits (or 11 with the person's number), first 2-6, check digit 9th.
  const AU_MEDICARE_LABELS = [/\bmedicare(?:\s+card)?(?:\s+(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  const MEDICARE_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9];
  const auMedicareValid = (d) =>
    /^[2-6]\d{9,10}$/.test(d) &&
    [...d.slice(0, 8)].reduce((s, ch, i) => s + Number(ch) * MEDICARE_WEIGHTS[i], 0) % 10 === Number(d[8]);

  // Reads your public IP when you say it's yours, as in "my home IP is 73.162.44.201". Private ranges are
  // handled by internal_ip instead.
  const MY_IP_RE =
    /\b(?:my|our)\s+(?:home\s+|public\s+|router\s+|wan\s+|external\s+)?ip(?:\s+address)?\s*(?:is|:|=)\s*((?:\d{1,3}\.){3}\d{1,3})\b/gi;
  const findMyIps = (text) =>
    [...text.matchAll(MY_IP_RE)]
      .map((m) => m[1])
      .filter(
        (ip) =>
          ip.split(".").every((n) => Number(n) <= 255) &&
          !/^(?:10|127|0)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^169\.254\./.test(ip),
      );

  // ---------- IDs after a Spanish label, and Colombia's numbered streets ----------
  // How people in Spanish-speaking countries write who they are, in forms the patterns above missed. Each
  // one only counts right after its own label, so the same digits sitting anywhere else stay quiet.

  // Between a label and its value I allow "es", "era", ":", "#", "n.º", "No.", "número", or an abbreviation
  // in brackets, as in "mi pasaporte es G12345678" or "Número de Seguridad Social (NSS): …". This also
  // matches in English, as in "my IMSS number is …".
  // The scan reads "º" as a plain "o", so "n.º" arrives as "n.o" and "nº" as "no", even before a letter-led ID.
  const ES_NO = String.raw`(?:n[uú]mero|number|n[uú]m\.?|nro\.?|n\.?\s?[º°]\.?|n\.\s?o\.?(?![\p{L}])|no\.|no(?=\s*[A-Za-z]{0,3}\d))`;
  const ES_LINK = String.raw`(?![\p{L}])(?:\s*\([\p{L}.\s]{2,12}\))?(?:\s*${ES_NO})?(?:\s*(?:[:=#]|(?:es|era|is|was)(?![\p{L}])(?:\s+(?:el|la)(?![\p{L}]))?))?\s*`;
  const esLabel = (words) => new RegExp(String.raw`(?<![\p{L}])(?:${words})${ES_LINK}`, "giu");
  // read(text, at, label) gives the value that starts where the label ends, or nothing.
  const afterLabel = (re, text, read) =>
    [...text.matchAll(re)].map((m) => read(text, m.index + m[0].length, m[0])).filter(Boolean);
  const idNotYear = (text, at) => {
    const v = idAt(text, at);
    return v && !JUST_A_YEAR.test(v) ? v : null;
  };

  // Mexico's social security number (NSS) is 11 digits after "NSS", "IMSS" or "seguro social" (Spain's has
  // 12 digits, handled by NSS_RE above). The IMSS help line, "01 800 …", isn't one.
  const MX_NSS_LABEL = esLabel(String.raw`NSS|IMSS|segur(?:o|idad)\s+social`);
  const MX_NSS = /(?!01[\s-]?800)\d(?:[\s-]?\d){10}(?![\s-]?\d)/y;
  // Argentina's and Peru's DNI: 7 or 8 digits, with or without dots ("DNI 30.571.264"). Spain's, with its check
  // letter, has its own rule (DNI_RE).
  const DNI_LABEL = esLabel(String.raw`D\.?N\.?I\.?|documento\s+nacional\s+de\s+identidad`);
  const DNI_DIGITS = /(?:\d{1,2}\.\d{3}\.\d{3}|\d{7,8})(?![.,]?\d|\p{L}|[-\s][A-HJ-NP-TV-Z](?![\p{L}\d]))/uy;
  // Colombia's cédula, and other countries' "cédula de identidad", is 6 to 10 digits, with or without dots,
  // maybe a Venezuelan V- or E- in front or a check digit after. It counts after "cédula", "C.C." or "CC".
  const CEDULA_LABEL = esLabel(
    String.raw`c[eé]dula(?:\s+de\s+(?:ciudadan[ií]a|identidad|extranjer[ií]a|identificaci[oó]n))?|c\.\s?c\.|cc`,
  );
  const CEDULA_DIGITS = /(?:[VE]-?)?(?:\d{1,3}(?:\.\d{3}){2,3}|\d{6,10})(?:-[\dkK])?(?![.,]?\d|\p{L})/uy;
  // Chile's RUT (or RUN): "12.345.678-5", only with a right check digit (mod 11, K for 10).
  const RUT_LABEL = esLabel(String.raw`R\.?U\.?[TN]\.?`);
  // "CC" and "RUN" count only in capitals: "cc" is a copy and "run" an English word.
  const lowercaseShort = (foundLabel) =>
    /^(?:c\.?\s?c|r\.?u\.?n)(?![\p{L}])/iu.test(foundLabel) && !/^(?:C\.?\s?C|R\.?U\.?N)/.test(foundLabel);
  const RUT_DIGITS = /(\d{1,2}(?:\.\d{3}){2}|\d{7,8})-?([\dkK])(?![\p{L}\d])/uy;
  function rutValid(body, check) {
    const d = body.replace(/\./g, "");
    let sum = 0;
    for (let i = d.length - 1, w = 2; i >= 0; i--, w = w === 7 ? 2 : w + 1) sum += Number(d[i]) * w;
    const r = 11 - (sum % 11);
    return (r === 11 ? "0" : r === 10 ? "K" : String(r)) === check.toUpperCase();
  }
  const spanishNationalIds = (text) => [
    ...afterLabel(MX_NSS_LABEL, text, (t, at) => sticky(MX_NSS, t, at)?.[0]),
    ...afterLabel(DNI_LABEL, text, (t, at) => sticky(DNI_DIGITS, t, at)?.[0]),
    ...afterLabel(
      CEDULA_LABEL,
      text,
      (t, at, foundLabel) => !lowercaseShort(foundLabel) && sticky(CEDULA_DIGITS, t, at)?.[0],
    ),
    ...afterLabel(RUT_LABEL, text, (t, at, foundLabel) => {
      const r = !lowercaseShort(foundLabel) && sticky(RUT_DIGITS, t, at);
      return r && rutValid(r[1], r[2]) && r[0];
    }),
  ];

  // Reads a passport after "pasaporte", a driver's license after "licencia de manejo" or "conducir" (Peru's
  // "brevete"), and in English a license number in brackets after its label, as in "driver's license
  // (D1234567)". Spain's "carné de conducir" carries the DNI number, which the national ID patterns above
  // already find.
  const PASAPORTE = esLabel("pasaporte");
  const LICENCIA = esLabel(String.raw`lic(?:encia|\.)?\s+de\s+(?:manejo|manejar|conducir|conducci[oó]n)|brevete`);
  const LICENSE_IN_BRACKETS = [
    new RegExp(String.raw`\b${LICENSE_WORDS}(?:\s*(?:number|no\.?|num|#))?\s*\(\s*`, "gi"),
    /\bD\.?L\.?\s*\(\s*/g,
  ];
  const spanishPassports = (text) => afterLabel(PASAPORTE, text, idNotYear);
  const spanishLicenses = (text) => [
    ...afterLabel(LICENCIA, text, idNotYear),
    ...LICENSE_IN_BRACKETS.flatMap((re) => afterLabel(re, text, idNotYear)),
  ];

  // Reads "historia clínica", and a clinic's "expediente" when it's someone's or numbered, as in "mi
  // expediente" or "número de expediente". A court's "expediente 1234/2023" isn't a medical record.
  const HISTORIA = esLabel(String.raw`historia\s+cl[ií]nica`);
  const EXPEDIENTE = esLabel(
    String.raw`(?:mi|su|tu|n[uú]mero|n[uú]m\.?|nro\.?|n\.?\s?[º°]\.?|no\.)\s+(?:de(?:l)?\s+)?expediente(?:\s+(?:cl[ií]nico|m[eé]dico|hospitalario))?|expediente\s+(?:cl[ií]nico|m[eé]dico|hospitalario)`,
  );
  const spanishMedicalRecords = (text) => [
    ...afterLabel(HISTORIA, text, idNotYear),
    ...afterLabel(EXPEDIENTE, text, (t, at) => {
      const v = idNotYear(t, at);
      return v && t[at + v.length] !== "/" && v;
    }),
  ];

  // Reads "Medicaid ID es …" or "número de Medicaid es …" (Medicaid's number also counts as an insurance
  // member ID in English), plus an "afiliado" number of 6+ digits, as in "número de afiliada: 15234987/02".
  // A bare "Medicaid" only counts with "es" right after it, since "Medicaid 1115 waivers" names a law.
  const MEDICAID_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:n[uú]mero\s+de(?:l)?\s+medicaid${ES_LINK}|medicaid(?:\s+(?:id|number|no\.?|#))?\s+(?:es|era)(?![\p{L}])(?:\s+(?:el|la)(?![\p{L}]))?\s*)`,
    "giu",
  );
  const AFILIADO = esLabel(String.raw`afiliad[oa]`);
  // A US routing number in Spanish, as US banks write it: "número de ruta 021000021", "ruta bancaria: …". Its
  // check digit (abaValid) still has to be right.
  const ROUTING_ES = esLabel(String.raw`${ES_NO}\s+de\s+ruta(?:\s+bancaria)?|ruta\s+(?:bancaria|ABA)`);
  // Letters, digits, dashes and slashes, or digits in groups with single spaces ("61 234567 8 01").
  const MEMBER_ID = /\d{2,12}(?: \d{1,12}){1,4}(?![\p{L}\d/-])|[A-Za-z0-9][A-Za-z0-9/-]{3,24}/uy;
  function memberIdAt(text, at) {
    const v = sticky(MEMBER_ID, text, at)?.[0].replace(/[-/]+$/, "");
    const dateOrYear = (s) => JUST_A_YEAR.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
    return v && (v.match(/\d/g) || []).length >= 6 && !dateOrYear(v) ? v : null;
  }
  // An insurance policy or health insurance number, as in "número de póliza 4402-778-19" or "número de seguro
  // médico: W482913765". The number word has to be there, before or after the name, since "la póliza 2024-2025"
  // is a policy year and "mi seguro médico cubre …" says nothing about a number.
  const POLICY_ES = String.raw`p[oó]liza|seguro\s+m[eé]dico`;
  const POLIZA = esLabel(
    String.raw`${ES_NO}\s+de(?:l)?\s+(?:(?:la|mi|tu|su)\s+)?(?:${POLICY_ES})|(?:${POLICY_ES})(?=\s*(?:${ES_NO}|[:#]))`,
  );
  const spanishInsuranceIds = (text) => [
    ...afterLabel(MEDICAID_ES, text, idNotYear),
    ...afterLabel(AFILIADO, text, memberIdAt),
    ...afterLabel(POLIZA, text, memberIdAt),
  ];

  // Every value read after one of these labels, so findPhones doesn't also read it as a phone, as with
  // "número de afiliado 912345678" or "mi NSS es 12345678901", and the other countries' national IDs above
  // ("CPF: 123.456.789-09", "PESEL 44051401458").
  const spanishIdValues = (text) => [
    ...worldNationalIds(text),
    ...spanishNationalIds(text),
    ...spanishPassports(text),
    ...spanishLicenses(text),
    ...spanishMedicalRecords(text),
    ...spanishInsuranceIds(text),
  ];

  // Reads Colombia's numbered streets: a street type and number, then "#" or "No." and the house's "93-47",
  // as in "Carrera 15 # 93-47" or "Cra. 7 No. 45-10". This matches in any case, since the "# 93-47" part is
  // what makes it an address; "calle 72 es bonita" on its own isn't one.
  const CO_TYPE = String.raw`(?:av(?:enida|\.)?[^\S\n]{0,3})?(?:carrera|cra\.?|kra\.?|kr\.?|calle|cll\.?|cl\.?|diagonal|diag\.?|dg\.?|transversal|transv\.?|tv\.?|avenida|av\.?)`;
  const CO_NUM = String.raw`\d{1,3}(?:[^\S\n]?[a-z])?(?:[^\S\n]?bis(?:[^\S\n]?[a-z])?)?(?:[^\S\n]{1,3}(?:sur|este))?`;
  const CO_STREET_RE = new RegExp(
    String.raw`(?<![\p{L}\d])(${CO_TYPE})[^\S\n]{0,3}(${CO_NUM})[^\S\n]{0,3}(?:#|n[º°o]\.?|nro\.?|n[uú]mero)[^\S\n]{0,3}(\d{1,3}(?:[^\S\n]?[a-z])?(?:[^\S\n]?bis)?)[^\S\n]{0,3}-[^\S\n]{0,3}(\d{1,3})(?![\p{L}\d])`,
    "giu",
  );
  // The same street however it's written (vault fingerprints): "Cra. 15 No. 93 - 47" = "carrera 15 # 93-47".
  const CO_TYPE_CANON = {
    cra: "carrera",
    kra: "carrera",
    kr: "carrera",
    cll: "calle",
    cl: "calle",
    diag: "diagonal",
    dg: "diagonal",
    transv: "transversal",
    tv: "transversal",
    av: "avenida",
  };
  function colombianAddressCore(text) {
    const m = new RegExp(CO_STREET_RE.source, "iu").exec(text);
    if (!m) return null;
    const type = m[1]
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter(Boolean)
      .map((w) => CO_TYPE_CANON[w] || w);
    const tight = (s) => s.toLowerCase().replace(/\s+/g, "");
    return `${type.join(" ")} ${tight(m[2])} # ${tight(m[3])}-${tight(m[4])}`;
  }
  // A Colombian street replaces a shorter match inside it ("Av. Calle 26" in "Av. Calle 26 # 69-76").
  function withColombianStreets(text, found) {
    const co = [...text.matchAll(CO_STREET_RE)].map((m) => m[0]);
    return co.length ? [...found.filter((f) => !co.some((c) => c.includes(f))), ...co] : found;
  }

  // ---------- Crypto wallets ----------

  // BIP-39 English word list (the official list; sha256 of the newline-joined list 2f5eed53…dbda).
  const BIP39 = new Set(
    `abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve
      acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult
      advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album
      alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount
      amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique
      anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around
      arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete
      atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake
      aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner
      bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave
      behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird
      birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat
      body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass
      brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush
      bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter
      buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe
      canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual
      cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal
      certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest
      chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil
      claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth
      cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine
      come comfort comic common company concert conduct confirm congress connect consider control convince cook cool
      copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle
      craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch
      crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain
      curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris
      decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise
      denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy
      detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma
      dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide
      divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon
      drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch
      duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort
      egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace
      emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine
      enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase
      erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example
      excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect
      expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame
      family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal
      fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find
      fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip
      float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork
      fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost
      frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage
      garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant
      gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue
      goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity
      great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half
      hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog
      height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow
      home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred
      hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image
      imitate immense immune impact impose improve impulse inch include income increase index indicate indoor
      industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane
      insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory
      jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk
      just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife
      knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn
      lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens
      leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list
      little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky
      luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage
      mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material
      math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory
      mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum
      minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor
      monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much
      muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow
      nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news
      next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear
      number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer
      office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option
      orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside
      oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper
      parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear
      peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano
      picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate
      play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position
      possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty
      prevent price pride primary print priority prison private prize problem process produce profit program project
      promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy
      purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote
      rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather
      raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform
      refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent
      reopen repair repeat replace report require rescue resemble resist resource response result retire retreat
      return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple
      risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route
      royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same
      sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science
      scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed
      seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft
      shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove
      shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing
      siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide
      slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer
      social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source
      south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split
      spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage
      stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool
      story stove strategy street strike strong struggle student stuff stumble style subject submit subway success
      such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise
      surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol
      symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell
      ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive
      throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler
      toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado
      tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel
      tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth
      try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly
      umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown
      unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless
      usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor
      venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village
      vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage
      wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel
      weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width
      wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood
      wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra
      zero zone zoo`
      .trim()
      .split(/\s+/),
  );
  // Every word's place in the official list, so a mnemonic's own checksum can be checked against it.
  const BIP39_LIST = [...BIP39];
  const BIP39_INDEX = new Map(BIP39_LIST.map((w, i) => [w, i]));

  // A small SHA-256 of its own, over raw bytes rather than text: a wallet's checksum is SHA-256 of the
  // mnemonic's entropy bytes, not of a string, and this is a classic script with no crypto.subtle and no
  // import. The standard FIPS 180-4 test vectors ("", "abc", the 448-bit one) are checked in patterns.test.js.
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  function sha256Bytes(bytes) {
    const len = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(len);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(len - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(len - 4, (bytes.length * 8) >>> 0);
    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < len; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i];
        const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += hh;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] >>> 0);
    return out;
  }

  // A real wallet seed's last word carries a checksum: SHA-256 of the entropy bits that came before it, its
  // first few bits (4 for 12 words, up to 8 for 24). `words` is already confirmed to be BIP-39 list words.
  function bip39ChecksumValid(words) {
    const n = words.length;
    const csBits = n / 3; // 12->4, 15->5, 18->6, 21->7, 24->8
    let bits = "";
    for (const w of words) bits += BIP39_INDEX.get(w).toString(2).padStart(11, "0");
    const entBits = bits.slice(0, bits.length - csBits);
    const wantBits = bits.slice(bits.length - csBits);
    const entropyBytes = new Uint8Array(entBits.length / 8);
    for (let i = 0; i < entropyBytes.length; i++) entropyBytes[i] = parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
    const gotBits = sha256Bytes(entropyBytes)[0].toString(2).padStart(8, "0").slice(0, csBits);
    return gotBits === wantBits;
  }

  // A real seed is exactly one of these lengths; a window this size inside a longer run of everyday words
  // still passes the checksum about 1 time in 16 by chance, so a window shorter than the whole run also needs
  // no word repeated in it, which a real seed (2048 possible words) almost never has. The whole run, when it's
  // exactly one of these lengths, has nowhere else to be, so it's checked on the checksum alone: that's how the
  // standard BIP-39 test vectors, several of which repeat a word on purpose, still flag.
  const SEED_LENGTHS = [24, 21, 18, 15, 12];
  // A cap on how many windows one run is checked against, so a huge paste of everyday words still scans in
  // linear time: real seeds are never embedded in thousands of words of surrounding list words anyway.
  const SEED_WINDOW_CAP = 10000;
  const SEED_SHORT_RUN = 48;
  const SEED_EXTRA_WORDS = 3;
  // List words people also write in everyday sentences, so a phrase pasted into "can you check this … please"
  // runs on into them. Up to SEED_PROSE_WORDS of them at either end of a run are read as the sentence around it.
  const SEED_PROSE_WORDS = 8;
  const EVERYDAY_LIST_WORDS = new Set(
    `about above across act add again age agree ahead all almost alone already also always among another answer
    any appear area around ask away because become before begin behind below best better between bring call can
    car case cause certain change check child city close come common company country course day deal door draw
    during early easy either else end enough example eye face fall family feel few field final find fine first
    fit follow food force forget found friend front fun funny game give glad good great group grow guess half
    hand happy hard have head help high hold home hope hour idea inside into issue item job just keep kind know
    large later learn leave left life like list little live long love main make man matter mean message middle
    mind minute miss moment more move much must name near need never next nice night normal note nothing now
    number off offer often okay old once one only open order other over own page pass people perfect person place
    play please point possible post power pretty problem put question quick rather ready real reason receive
    record remember report result return right road room round run same save say second sense short side simple
    since small soon sorry sort sound speak special stand start state stay step still story strong such suggest
    sure talk team tell test thank that then there they thing this thought three time today together top total
    toward try turn twice two under until upon use used usual very view wait want way what when where will wish
    wonder word work world wrong year you young`.split(/\s+/),
  );
  function seedWindows(run) {
    const found = [];
    let checked = 0;
    for (const n of SEED_LENGTHS) {
      if (n > run.length) continue;
      const counts = new Map();
      for (let i = 0; i < n; i++) counts.set(run[i].word, (counts.get(run[i].word) || 0) + 1);
      for (let s = 0; s + n <= run.length; s++) {
        const edge = s === 0 || s + n === run.length;
        // A valid phrase embedded in a longer run is extremely unlikely to repeat a word. Skipping those windows
        // avoids hashing every overlapping slice of a long everyday-word run, while checking run edges preserves
        // legitimate vectors with repeated words at the start or end. A short run is cheap to check whole, and a
        // random 12-word phrase repeats a word about 1 time in 30, so there every window is checked.
        if (edge || counts.size === n || run.length <= SEED_SHORT_RUN) {
          if (checked++ >= SEED_WINDOW_CAP) return found;
          const window = run.slice(s, s + n);
          if (bip39ChecksumValid(window.map((u) => u.word))) found.push(window);
        }
        if (s + n < run.length) {
          const outgoing = run[s].word;
          const remaining = counts.get(outgoing) - 1;
          if (remaining) counts.set(outgoing, remaining);
          else counts.delete(outgoing);
          const incoming = run[s + n].word;
          counts.set(incoming, (counts.get(incoming) || 0) + 1);
        }
      }
    }
    return found;
  }

  // Words that say a run of list words is a wallet's recovery phrase. SEED_LABEL counts anywhere in the
  // message ("here's my seed phrase" and the words further down); SEED_NEAR only within a few lines of the run,
  // since "seed", "wallet" or "backup" alone could be about a garden, a purse or a hard drive.
  const SEED_LABEL =
    /\b(?:seed[\s-]*(?:phrase|words?)|mnemonic|recovery[\s-]*(?:phrase|words?|seed|sentence)|secret[\s-]*(?:recovery[\s-]*)?phrase|(?:backup|wallet)[\s-]*(?:phrase|words?|seed)|bip[\s-]?39|metamask|trezor|electrum|frase[\s-]+(?:semilla|secreta|mnem[oó]nica|de[\s-]+(?:recuperaci[oó]n|respaldo|seguridad))|palabras[\s-]+(?:semilla|secretas|de[\s-]+(?:recuperaci[oó]n|respaldo|seguridad))|mnem[oó]nic[oa])/gi;
  const SEED_NEAR =
    /\b(?:seeds?|wallet|recovery|recover|restore|backup|ledger|crypto|bitcoin|btc|ethereum|eth|coinbase|binance|exodus|phantom|(?:12|24|twelve|twenty[\s-]?four)[\s-]+(?:\w+[\s-]+)?words|semilla|cartera|billetera|monedero|respaldo|recuperaci[oó]n|cripto|(?:12|24|doce|veinticuatro)[\s-]+(?:\w+[\s-]+)?palabras)\b/i;
  const SEED_NEAR_BEFORE = 300;
  const SEED_NEAR_AFTER = 100;
  // The number in front of a list word, as in "3. word", "3) word", "3: word", "#3 word" or "3 word".
  const SEED_NUMBER = /(?:^|\D)(\d{1,2})[.):]?\s*$/;
  // What can sit between two words of a phrase: spaces, line breaks, numbering, commas, quotes, brackets, pipes,
  // slashes and "> " email quoting (a JSON array, "a | b | c", a quoted reply). A colon only after a number.
  const SEED_GAP = /^(?:[\s,;.)\-\d"'[\]|/>#]|(?<=\d):)*$/;
  // A numbered list that runs 1 to n with nothing numbered n+1 after it, in any order (a grid copied column by
  // column reads 1, 5, 9, 2, …), put back into its numbered order.
  function numberedSeed(run, s, n) {
    if (s + n > run.length || (s + n < run.length && run[s + n].num === n + 1)) return null;
    const ordered = new Array(n);
    for (let i = s; i < s + n; i++) {
      const k = run[i].num;
      if (!k || k > n || ordered[k - 1]) return null;
      ordered[k - 1] = run[i];
    }
    return ordered;
  }
  // A run is list-shaped when commas, semicolons, full stops, dashes, pipes or slashes separate its words, or it
  // has one word per line, as a shopping, packing or vocabulary list does. Spaces (and the odd number) make a
  // typed phrase.
  function listShaped(run) {
    let lines = 0;
    for (let i = 1; i < run.length; i++) {
      if (/[,;.|/-]/.test(run[i].gap)) return true;
      if (run[i].gap.includes("\n")) lines++;
    }
    return lines * 2 >= run.length - 1;
  }

  // Twelve or more BIP-39 list words in a row with a valid checksum is a seed phrase. Numbering, commas and
  // line breaks between the words are fine. A run that's exactly a phrase's length is checked as a whole, and
  // so is a numbered list running 1 to 12 (or 15, 18, 21, 24). Inside a longer run, every 12-24-word window
  // passes the checksum about 1 time in 16 by chance, so a long shopping or vocabulary list would almost always
  // pass somewhere: those windows are only checked with seed words nearby (SEED_LABEL, SEED_NEAR). Without them,
  // a run typed with spaces still has its first and last 12 and 24 words checked when at most SEED_EXTRA_WORDS
  // other list words sit next to the phrase (prose around a pasted phrase: "send abuse boss … tattoo"), or when
  // the run is longer than any everyday list (a phrase pasted after a dump of list words), and the phrase can
  // start anywhere among up to SEED_PROSE_WORDS everyday words at either end ("can you check this … please").
  // A comma, bullet or one-per-line list is checked only when it's exactly a phrase's length.
  // `labelled` is true when a SEED_LABEL sits outside `text`: a paste too large to read in one go is read a window
  // at a time (detector.js), and when the window that holds a phrase and its label finds the phrase near a seam, the
  // window on the seam's other side, which reads the phrase whole but can't see the label, is told about it.
  function findSeedPhrases(text, labelled) {
    const found = [];
    let run = [];
    let lastEnd = -1;
    let labels = null;
    const report = (window) => {
      let start = window[0].start;
      let end = window[0].end;
      for (const w of window) {
        if (w.start < start) start = w.start;
        if (w.end > end) end = w.end;
      }
      found.push(text.slice(start, end));
    };
    const check = (window) => window && bip39ChecksumValid(window.map((w) => w.word)) && (report(window), true);
    // The first and last 12 and 24 words of a run typed with spaces (see above). Both ends, always: the other
    // words plus the start of a phrase pass the checksum by chance 1 time in 16, and that mustn't hide the phrase.
    // Then, when everyday words lead into or trail off the run ("can you check this … please"), every place the
    // phrase could start among them, as long as the window itself isn't mostly everyday words.
    const atEnds = (words) => {
      for (const n of [24, 12]) {
        const extra = words.length - n;
        if (extra <= 0) continue;
        const ends = extra <= SEED_EXTRA_WORDS || words.length > SEED_SHORT_RUN;
        if (ends) {
          check(words.slice(0, n));
          check(words.slice(extra));
        }
        const everyday = (w) => EVERYDAY_LIST_WORDS.has(w.word);
        let lead = 0;
        while (lead < extra && lead < SEED_PROSE_WORDS && everyday(words[lead])) lead++;
        let trail = 0;
        while (trail < extra && trail < SEED_PROSE_WORDS && everyday(words[words.length - 1 - trail])) trail++;
        for (let s = Math.max(0, extra - trail); s <= lead; s++) {
          if (ends && (s === 0 || s === extra)) continue;
          const window = words.slice(s, s + n);
          if (window.filter(everyday).length * 2 <= n) check(window);
        }
      }
    };
    // "seed" and "phrase" are list words themselves, so a label also counts as a run's first or last two words
    // ("seed phrase abuse boss …"). A lone "seed" in a gardening list doesn't vouch for the list it's in.
    const hasContext = () => {
      if (labelled) return true;
      const head = run[Math.min(2, run.length - 1)].start;
      const tail = run[Math.max(0, run.length - 3)].end;
      if (!labels) labels = [...text.matchAll(SEED_LABEL)].map((m) => [m.index, m.index + m[0].length]);
      if (labels.some(([a, b]) => a < head || b > tail)) return true;
      const before = text.slice(Math.max(0, run[0].start - SEED_NEAR_BEFORE), run[0].start);
      const after = text.slice(lastItem(run).end, lastItem(run).end + SEED_NEAR_AFTER);
      return SEED_NEAR.test(before) || SEED_NEAR.test(after);
    };
    // Twelve number words in a row, like someone reading out a card number, are a number, not a seed phrase.
    const allNumbers = () => run.every((w) => ALL_WORDS[w.word] !== undefined);
    const close = () => {
      if (run.length >= 12 && !allNumbers()) {
        const before = found.length;
        for (let s = 0; s < run.length; s++) {
          if (run[s].num !== 1) continue;
          for (const n of SEED_LENGTHS) check(numberedSeed(run, s, n));
        }
        if (found.length === before) {
          if (hasContext()) {
            for (const window of seedWindows(run)) report(window);
          } else {
            if (SEED_LENGTHS.includes(run.length)) check(run);
            if (found.length === before && !listShaped(run)) {
              atEnds(run);
              // Each line on its own too, for a phrase on a line of its own after other list words ("private
              // key abuse boss …" twice, one per line).
              let from = 0;
              for (let i = 1; i <= run.length; i++) {
                if (i < run.length && !run[i].gap.includes("\n")) continue;
                if (from > 0 || i < run.length) {
                  const line = run.slice(from, i);
                  if (SEED_LENGTHS.includes(line.length)) check(line);
                  atEnds(line);
                }
                from = i;
              }
            }
          }
        }
      }
      run = [];
    };
    for (const m of text.matchAll(/[A-Za-z]+/g)) {
      const word = m[0].toLowerCase();
      const gap = text.slice(Math.max(lastEnd, 0), m.index);
      const number = SEED_NUMBER.exec(gap.length > 8 ? gap.slice(-8) : gap);
      const w = { start: m.index, end: m.index + m[0].length, word, gap, num: number ? Number(number[1]) : 0 };
      const gapOk = lastEnd < 0 || SEED_GAP.test(gap);
      if (!BIP39.has(word) || !gapOk) close();
      if (BIP39.has(word)) run.push(w);
      lastEnd = w.end;
    }
    close();
    return found;
  }
  // Keep a raw private key's label with its value so the finding also matches when checked on its own.
  // Told in a sentence ("my private key is 0x…") or handed to a wallet's importprivkey command.
  const CRYPTO_KEY_RE =
    /\b(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:private|priv|wallet|secret)[\s_-]*key\b(?:\s+(?:is|was))?[\s:="'-]{0,6}((?:0x)?[0-9a-fA-F]{64}|[5KL][1-9A-HJ-NP-Za-km-z]{50,51})\b|\bimportprivkey\s+["']?[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/gi;
  const findCryptoSecrets = (text, _reasons, labelled) => [
    ...findSeedPhrases(text, labelled),
    ...[...text.matchAll(CRYPTO_KEY_RE)].map((m) => m[0]),
  ];

  // ---------- Private keys written as JSON Web Keys ----------
  // A private key can also show up in JWK form (RFC 7517) instead of PEM or OpenSSH, as its own object or
  // inside a JWKS's "keys" array, pretty-printed, minified, or pasted as a JS object literal or Python dict.
  // Either way it counts as the same `private_key` kind as a PEM block further down.

  // Finds every `{...}` span with no brace nested inside it. A JWK's own members are always strings, numbers
  // or arrays of strings, never another object, so a leaf span is exactly one JWK, or inside a JWKS, one of
  // its "keys" entries rather than the wrapper around them. This walks the text once with a stack of open
  // braces, which stays fast even on a huge paste; a backtracking regex trying every "{" would be far slower.
  function leafJsonSpans(text, max = 2000) {
    const out = [];
    const stack = [];
    for (let i = 0; i < text.length && out.length < max; i++) {
      const c = text[i];
      if (c === "{") {
        if (stack.length) stack[stack.length - 1].hasInner = true;
        stack.push({ start: i, hasInner: false });
      } else if (c === "}" && stack.length) {
        const frame = stack.pop();
        if (!frame.hasInner) out.push(text.slice(frame.start, i + 1));
      }
    }
    return out;
  }

  // Tries strict JSON first. If that fails, it's loose enough to read a JS object literal or Python dict
  // pasted as code: it quotes bare identifier keys, turns single-quoted strings into double-quoted ones,
  // and reads Python's None/True/False as JSON's null/true/false.
  function looseJsonParse(span) {
    try {
      return JSON.parse(span);
    } catch {
      // fall through to the loose reading below
    }
    try {
      const loose = span
        .replace(
          /'((?:[^'\\]|\\.)*)'/g,
          (_, s) => `"${s.replace(/\\'|\\.|"/g, (m) => (m === "\\'" ? "'" : m === '"' ? '\\"' : m))}"`,
        )
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
        .replace(/\bNone\b/g, "null")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      return JSON.parse(loose);
    } catch {
      return null;
    }
  }

  // Each key type from RFC 7518 has one member that only a private or symmetric key carries: EC, OKP and RSA
  // all use "d" (RSA has more, but "d" alone already proves it's private), the symmetric type "oct" uses "k",
  // its only key material, so an oct JWK is always a shared secret, and the post-quantum "AKP" type (RFC
  // 9964) holds its 32-byte private seed in "priv".
  const JWK_PRIVATE_MEMBER = { EC: "d", OKP: "d", RSA: "d", oct: "k", AKP: "priv" };

  // True only when "kty" is one of the known types above and its private member is present and non-empty.
  // A public JWK, an unrelated object that happens to have a "d" field, or an OpenID configuration
  // document with no "kty" at all should all come back false.
  function isPrivateJwk(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.kty !== "string") return false;
    const member = JWK_PRIVATE_MEMBER[obj.kty];
    return Boolean(member) && typeof obj[member] === "string" && obj[member].length > 0;
  }

  function findJwkPrivateKeys(text) {
    const found = [];
    for (const span of leafJsonSpans(text)) {
      if (!span.includes("kty")) continue; // cheap skip before paying for a parse
      if (isPrivateJwk(looseJsonParse(span))) {
        found.push(span);
        continue;
      }
      const unescaped = span.replace(/\\(["\\])/g, "$1");
      if (unescaped !== span && isPrivateJwk(looseJsonParse(unescaped))) found.push(span);
    }
    return found;
  }

  // A missing footer must not leave the base64 body behind when the header is covered.
  const PEM_HEADER_RE = /-----[ \t]*BEGIN ((?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?)[ \t]*-----(?!-)/g;
  const PEM_FOOTER_RE = /-----[ \t]*END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \t]*-----(?!-)/g;
  function pemBodyEnd(text, from, nextHeader) {
    const firstBreak = text.indexOf("\n", from);
    if (firstBreak < 0 || (nextHeader >= 0 && nextHeader < firstBreak)) return from;
    let position = firstBreak + 1;
    let end = from;
    let hasBody = false;
    let blankBefore = false;
    while (position <= text.length) {
      const newline = text.indexOf("\n", position);
      const rawEnd = newline < 0 ? text.length : newline;
      const lineEnd = rawEnd > position && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
      let start = position;
      while (start < lineEnd && (text[start] === " " || text[start] === "\t")) start++;
      let stop = lineEnd;
      while (stop > start && (text[stop - 1] === " " || text[stop - 1] === "\t")) stop--;
      if (start === stop) {
        // A chat box that keeps each line as its own paragraph reads one blank line between the key's lines.
        if (blankBefore || newline < 0) break;
        blankBefore = true;
        position = newline + 1;
        continue;
      }
      const line = text.slice(start, stop);
      // Past a blank line, a plain word like "Thanks" is the message going on, not more of the key.
      if (blankBefore && !/[\d+/=]/.test(line)) break;
      blankBefore = false;
      if (!hasBody && /^(?:Proc-Type:|DEK-Info:)/.test(line)) {
        // Encrypted PEM keys list their encryption details before the base64 body.
      } else {
        let valid = true;
        for (let i = start; i < stop; i++) {
          const c = text.charCodeAt(i);
          if (
            !(c >= 65 && c <= 90) &&
            !(c >= 97 && c <= 122) &&
            !(c >= 48 && c <= 57) &&
            c !== 43 &&
            c !== 47 &&
            c !== 61
          ) {
            valid = false;
            break;
          }
        }
        if (!valid) break;
        hasBody = true;
        end = lineEnd;
      }
      if (newline < 0) break;
      position = newline + 1;
    }
    return hasBody ? end : from;
  }
  // A PEM or OpenSSH header and a JWK private key both count as the same `private_key` kind.
  function findPrivateKeys(text) {
    const found = [];
    const hasPemMarker = text.includes("-----");
    const headers = hasPemMarker ? [...text.matchAll(PEM_HEADER_RE)] : [];
    const footers = hasPemMarker ? [...text.matchAll(PEM_FOOTER_RE)] : [];
    let footerIndex = 0;
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      const from = header.index + header[0].length;
      const nextHeader = headers[i + 1]?.index ?? -1;
      while (footerIndex < footers.length && footers[footerIndex].index < from) footerIndex++;
      const footer = footers[footerIndex];
      if (footer && (nextHeader < 0 || footer.index < nextHeader)) {
        found.push(text.slice(header.index, footer.index + footer[0].length));
        footerIndex++;
        continue;
      }
      const bodyEnd = pemBodyEnd(text, from, nextHeader);
      found.push(text.slice(header.index, bodyEnd > from ? bodyEnd : from));
    }
    const base64Pem = [];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    // Decode only the recognizable prefix so arbitrary base64 data stays out of the private-key path.
    if (text.includes("LS0tLS1CRUdJTi")) {
      for (const match of text.matchAll(/LS0tLS1CRUdJTi[A-Za-z0-9+/=]{40,}(?:\r?\n[ \t]*[A-Za-z0-9+/=]{8,})*/g)) {
        let bits = 0;
        let buffer = 0;
        let decoded = "";
        const prefix = match[0].replace(/[\r\n \t]/g, "").slice(0, 64);
        for (const character of prefix) {
          if (character === "=") break;
          const value = alphabet.indexOf(character);
          if (value < 0) break;
          buffer = (buffer << 6) | value;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            decoded += String.fromCharCode((buffer >> bits) & 255);
          }
        }
        if (decoded.includes("PRIVATE KEY")) base64Pem.push(match[0]);
      }
    }
    // A WireGuard config's own key and its peer's shared key (the public key beside them is meant to be shared), and
    // an age key file's secret line.
    if (text.includes("PrivateKey") || text.includes("PresharedKey") || text.includes("AGE-SECRET-KEY-")) {
      for (const m of text.matchAll(OTHER_PRIVATE_KEY_RE)) found.push(m[0]);
    }
    const jwk = text.includes("{") ? findJwkPrivateKeys(text) : [];
    return found.concat(jwk, base64Pem);
  }
  const OTHER_PRIVATE_KEY_RE =
    /\b(?:PrivateKey|PresharedKey)[^\S\n]*=[^\S\n]*[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])|\bAGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}\b/g;

  // ---------- Two-step sign-in keys (otp_secret) ----------
  // This is the secret an authenticator app turns into your sign-in codes, so anyone who has it can make
  // your codes too. People paste it two ways: as the otpauth:// link a sign-in QR code holds (Google
  // Authenticator's export link, otpauth-migration://, works the same way), or as the "setup key" a site
  // shows under the QR code for when you can't scan it.
  const OTP_LINK_RE = /\botpauth(?:-migration)?:\/\/[^\s"'<>]+/gi;
  // A setup key is base32 (A-Z and 2-7), either in one piece or in groups of four like Google's "5dkq 7xh2 …".
  const OTP_KEY_RE = /(?<![A-Za-z0-9])(?:[A-Za-z2-7]{4}(?: [A-Za-z2-7]{4}){3,15}|[A-Za-z2-7]{16,64})(?![A-Za-z0-9])/g;
  // I only treat a base32 run as a setup key when something right before it names what it is, like "setup
  // key", "secret", "seed" or "clave", and something nearby says what it's for, like two-step sign-in or an
  // authenticator app. "Setup key" on its own already covers both.
  const OTP_KEY_WORD =
    /(?:\b(?:set-?up\s+key|key|secret|seed|clave(?:\s+(?:secreta|de\s+configuraci[oó]n))?|secreto)\b[^\n.?!]{0,40}?)\s*(?:\bis\b|\bes\b|\bwas\b|[:=])?\s*["'“‘(]?$/i;
  const OTP_TOPIC =
    /\b(?:2fa|two[- ]?factor|two[- ]?step|2[- ]?step|mfa|totp|hotp|otp|authenticator|authy|set-?up\s+key|autenticador|autenticaci[oó]n|dos\s+pasos|doble\s+factor|clave\s+de\s+configuraci[oó]n)\b/i;

  // Returns every key found as [{ start, end, value }], in order: the links first, then the setup keys in
  // the rest of the text. The result is cached for the last text read, since the password check asks about
  // the same text right after this does.
  const blank = (m) => " ".repeat(m.length);
  let otpLast = { text: null, found: [] };
  function otpFinds(text) {
    if (otpLast.text === text) return otpLast.found;
    const found = [];
    for (const m of text.matchAll(OTP_LINK_RE)) {
      const link = trimTrailing(m[0], /[).,;:!?\]}>]/);
      const query = new URLSearchParams(link.includes("?") ? link.slice(link.indexOf("?") + 1) : "");
      const secret = /^otpauth-migration:/i.test(link)
        ? query.get("data") || ""
        : trimTrailing((query.get("secret") || "").replace(/\s+/g, ""), /=/);
      const ok = /^otpauth-migration:/i.test(link)
        ? secret.length >= 20
        : /^[A-Za-z2-7]{16,}$/.test(secret) && !isPlaceholder(secret);
      if (ok) found.push({ start: m.index, end: m.index + link.length, value: link, link: true });
    }
    const rest = text.replace(OTP_LINK_RE, blank); // the same length, without its links
    for (const m of rest.matchAll(OTP_KEY_RE)) {
      const before = rest.slice(Math.max(0, m.index - 80), m.index);
      if (!OTP_KEY_WORD.test(before) || !OTP_TOPIC.test(before)) continue;
      let groups = m[0].split(" ");
      // A key can run on into the sentence, as in "… kd7e what do I do", so a four-letter word right
      // after it isn't part of the key.
      if (/^ [A-Za-z]/.test(rest.slice(m.index + m[0].length))) {
        while (groups.length > 4 && !/[2-7]/.test(lastItem(groups))) groups = groups.slice(0, -1);
      }
      const value = groups.join(" ");
      const key = groups.join("");
      if (key !== key.toUpperCase() && key !== key.toLowerCase()) continue; // sites show it in one case
      // Plain four-letter words in a row aren't a key. When the match is split into groups, a real key
      // has a digit somewhere, or four letters in a row with no vowel, like "qrst". A single unbroken
      // run of 16 letters or more right after "setup key" or "secret" still counts as a key.
      if (!/[A-Za-z]/.test(key)) continue;
      if (groups.length > 1 && !/[2-7]/.test(key) && !/[b-df-hj-np-tv-xz]{4}/i.test(key)) continue;
      if (isPlaceholder(key)) continue;
      found.push({ start: m.index, end: m.index + value.length, value });
    }
    otpLast = { text, found };
    return found;
  }
  const findOtpSecrets = (text) => otpFinds(text).map((f) => f.value);

  // ---------- Clean link: a URL's own tracking code ----------
  // A link copied out of an app often carries more than the address: a code that ties it back to whoever
  // copied it (YouTube's and Spotify's "si", Instagram's and Threads' "igsh"/"igshid", Reddit's "share_id"),
  // or an ad network's own click id (Google, Meta, Microsoft, TikTok, X and LinkedIn each set their own,
  // plus any "utm_" campaign tag). Both ride as ordinary query parameters, so cleaning a link just means
  // dropping the matching name=value pairs and leaving everything else, including the #fragment, exactly as
  // it was typed. Written from each company's own naming, not copied from a filter list, since those are GPL.
  const SHARE_HOSTS = {
    "youtube.com": ["si"],
    "www.youtube.com": ["si"],
    "m.youtube.com": ["si"],
    "music.youtube.com": ["si"],
    "youtu.be": ["si"],
    "open.spotify.com": ["si"],
    "instagram.com": ["igsh", "igshid"],
    "www.instagram.com": ["igsh", "igshid"],
    "threads.com": ["xmt", "igshid"],
    "threads.net": ["xmt", "igshid"],
    "reddit.com": ["share_id"],
    "www.reddit.com": ["share_id"],
  };
  const AD_PARAMS = new Set(["gclid", "fbclid", "msclkid", "ttclid", "twclid", "li_fat_id", "mc_eid"]);
  const isAdParam = (name) => AD_PARAMS.has(name) || name.startsWith("utm_");
  // A plain, bounded character class, so a link thousands of characters long still costs one pass, never a
  // backtrack.
  const LINK_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

  // The host a link's address names, lowercased, stopping at the first "/", ":", "?" or "#" and skipping
  // any "user:pass@" in front of it.
  function linkHost(link) {
    const m = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(link);
    return m ? m[1].toLowerCase() : "";
  }

  // Splits a link into its base, its query string and everything from its "#" on (kept as-is), or null when
  // there's no "?" to split on.
  function linkQuery(link) {
    const at = link.indexOf("?");
    if (at < 0) return null;
    const hash = link.indexOf("#", at);
    return {
      base: link.slice(0, at),
      query: link.slice(at + 1, hash < 0 ? link.length : hash),
      tail: hash < 0 ? "" : link.slice(hash),
    };
  }

  // The share code and ad-tracking parameter names this link actually carries, in the order they appear.
  // Reading the query string pair by pair with indexOf, rather than a regex over the whole link, keeps a
  // link packed with thousands of short parameters at one pass over its own length.
  function cleanableParamsOf(link) {
    const parts = linkQuery(link);
    if (!parts?.query) return [];
    const codes = SHARE_HOSTS[linkHost(link)] || [];
    const found = [];
    for (const pair of parts.query.split("&")) {
      const eq = pair.indexOf("=");
      const name = eq < 0 ? pair : pair.slice(0, eq);
      if (isAdParam(name) || codes.includes(name)) found.push(name);
    }
    return found;
  }

  function findShareLinks(text) {
    const found = [];
    for (const m of text.matchAll(LINK_RE)) {
      const link = trimTrailing(m[0], /[).,;:!?\]}>]/);
      if (cleanableParamsOf(link).length) found.push(link);
    }
    return found;
  }

  // Drops the share code and ad-tracking parameters from a link, keeping every other parameter in its
  // original order and spelling, and the #fragment untouched. A "?" left with nothing after it goes too.
  function cleanShareLink(link) {
    const parts = linkQuery(link);
    if (!parts) return link;
    const codes = SHARE_HOSTS[linkHost(link)] || [];
    const kept = parts.query.split("&").filter((pair) => {
      const eq = pair.indexOf("=");
      const name = eq < 0 ? pair : pair.slice(0, eq);
      return !isAdParam(name) && !codes.includes(name);
    });
    return (kept.length ? `${parts.base}?${kept.join("&")}` : parts.base) + parts.tail;
  }

  // ---------- Developer secrets: connection strings, JWTs, internal addresses ----------

  // A connection string like scheme://user:password@host, matched only when the password part looks real. A
  // driver can follow the scheme, as in SQLAlchemy's postgresql+psycopg2:// or mysql+pymysql://, and the user
  // name can hold an "@", as in Azure's user@server, typed as is or as user%40server.
  const CONN_SCHEME_RE =
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis|rediss|amqps?|mssql|sqlserver|oracle|ftp|sftp|smtp|https?)(?:\+[a-z][a-z0-9_]{0,23})?:\/\//gi;
  const CONN_USER_END = /[\s:/]/;
  const CONN_PASSWORD_END = /[\s@]/;
  const CONN_HOST_END = /[\s"'<>]/;
  const PLACEHOLDER_PASSWORDS = new Set([
    "password",
    "pass",
    "passwd",
    "pwd",
    "secret",
    "xxx",
    "xxxx",
    "changeme",
    "***",
    "****",
  ]);
  function findConnectionStrings(text) {
    const schemes = text.matchAll(CONN_SCHEME_RE);
    const first = schemes.next();
    if (first.done || text.indexOf("@") < 0) return [];

    // Passwords can contain slashes, so a failed candidate needs its next @ without rescanning the text.
    const nextPasswordEnd = new Int32Array(text.length + 1);
    let passwordEnd = text.length;
    for (let i = text.length - 1; i >= 0; i--) {
      // Plain ASCII without a regex: "@", or a space, tab or line break (\s's ASCII members, 9 to 13 and 32).
      const code = text.charCodeAt(i);
      if (code < 128 ? code === 64 || code === 32 || (code >= 9 && code <= 13) : CONN_PASSWORD_END.test(text[i])) {
        passwordEnd = i;
      }
      nextPasswordEnd[i] = passwordEnd;
    }
    nextPasswordEnd[text.length] = text.length;

    const found = [];
    let afterMatch = 0;
    for (let current = first; !current.done; current = schemes.next()) {
      const scheme = current.value;
      if (scheme.index < afterMatch) continue;

      let colon = scheme.index + scheme[0].length;
      while (colon < text.length && !CONN_USER_END.test(text[colon])) colon++;
      if (text[colon] !== ":") continue;

      const passwordStart = colon + 1;
      const at = nextPasswordEnd[passwordStart];
      if (at === passwordStart || text[at] !== "@") continue;

      const hostStart = at + 1;
      if (hostStart === text.length || CONN_HOST_END.test(text[hostStart])) continue;
      let end = hostStart + 1;
      while (end < text.length && !CONN_HOST_END.test(text[end])) end++;

      const password = text.slice(passwordStart, at);
      // With an "@" in the user name, "https://me@host:8080/a@b" is a host and port, not a password.
      const userHasAt = text.slice(scheme.index + scheme[0].length, colon).includes("@");
      if (
        !(userHasAt && /^\d{1,5}(?:\/|$)/.test(password)) &&
        !PLACEHOLDER_PASSWORDS.has(password.toLowerCase()) &&
        !/^[<{$[%]/.test(password) &&
        !isPlaceholder(password)
      ) {
        found.push(trimTrailing(text.slice(scheme.index, end), /[.,;)\]]/));
      }
      afterMatch = end;
    }
    return found;
  }

  // A JWT looks like header.payload.signature, where both JSON parts are base64url and start with "eyJ".
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

  // Matches the private network ranges 10/8, 172.16/12 and 192.168/16, but not when they're part of a
  // longer dotted number like a version string.
  const IP_RE = /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g;
  // A version, firmware or build number is dotted the same way, so "Firmware 10.5.14.31", "upgrade from 10.2.3.4",
  // "v10.1.2.3" and the "to" side of "from 10.2.3.4 to 10.2.3.5" aren't addresses. The version word has to be right
  // before the number, or an upgrade a package name and "from" or "to" back: "the new version is up on 10.2.3.4" and
  // "build server at 10.2.3.4" are still servers.
  const VERSION_BEFORE =
    /(?:(?<![\p{L}])(?:version|ver|firmware|fw|build|release[ds]?|rev|revision|kernel|sdk)(?:\s+(?:is|was|number|no\.?))?|(?<![\p{L}])(?:upgrade[ds]?|upgrading|downgrade[ds]?|bump(?:ed|s|ing)?)(?:\s+[^\s\d]\S{0,40})?\s+(?:from|to))[\s:=#[(]*v?$/iu;
  function findInternalIPs(text) {
    const found = [];
    let versionEnd = -1;
    for (const m of text.matchAll(IP_RE)) {
      if (!m[0].split(".").every((o) => Number(o) <= 255)) continue;
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      const versionTo = versionEnd >= 0 && /^\s*(?:to|->|→|=>)\s*v?$/i.test(text.slice(versionEnd, m.index));
      if (/(?<![\p{L}])v$/iu.test(before) || VERSION_BEFORE.test(before) || versionTo) {
        versionEnd = m.index + m[0].length;
        continue;
      }
      found.push(m[0]);
    }
    return found;
  }

  // Catches hostnames on internal-only domains, like build-01.corp, printer.local or api.internal.
  const HOST_RE =
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}(?:internal|corp|local|lan|intranet|localdomain|home\.arpa)\b(?![.-]?\w)/gi;
  // Code reads like an internal hostname too. These aren't hosts: an import or namespace (kotlinx.coroutines.internal,
  // Microsoft.AspNetCore.Internal, com.acme.billing.internal), a member read or set in code (this.internal,
  // if(spec.local), node.local = true), a Django settings.local module, and the names Docker and Kubernetes give every
  // install (host.docker.internal, redis.default.svc.cluster.local).
  const PLATFORM_HOST =
    /^(?:(?:host|gateway|kubernetes)\.docker\.internal|.*\.cluster\.local|(?:\w+\.)?settings\.local)$/i;
  const CODE_LINE = /(?:^|\n)\s*(?:import|from|using|package|namespace|@import|#include)\s[^\n]*$/;
  const REVERSE_DNS_START = /^(?:com|org|net|io|dev|co|me|uk|de|kotlinx|kotlin|java|javax|android|androidx|jakarta)$/i;
  const MEMBER_OWNER =
    /^(?:this|self|spec|node|t|e|n|r|o|s|ctx|props|state|module|exports|window|document|opts|options|cfg|config)$/;
  const MEMBER_ALWAYS = /^(?:this|self)$/;
  function codeHostName(text, at, host) {
    if (PLATFORM_HOST.test(host)) return true;
    const labels = host.split(".");
    if (labels.some((l) => /[a-z][A-Z]/.test(l)) || /^[A-Z][a-z]+$/.test(lastItem(labels))) return true;
    if (labels.length >= 3 && REVERSE_DNS_START.test(labels[0])) return true;
    const before = text.slice(Math.max(0, at - 200), at);
    if (CODE_LINE.test(before)) return true;
    if (labels.length === 2 && MEMBER_OWNER.test(labels[0])) {
      if (MEMBER_ALWAYS.test(labels[0])) return true;
      const after = text.slice(at + host.length, at + host.length + 3);
      if (/^\s*(?:=(?!=)|[);?,}\]&|])/.test(after) || /(?:[(!]|\b(?:return|if|typeof))\s*$/.test(before)) return true;
    }
    return false;
  }
  const findInternalHosts = (text) =>
    [...text.matchAll(HOST_RE)].filter((m) => !codeHostName(text, m.index, m[0])).map((m) => m[0]);

  // An AWS secret access key only has a recognizable shape beside its labeled access key ID.
  const AWS_PAIR_CHARS = 200;
  function findAwsAccessKeys(text) {
    const readable = text.replace(/\\(["\\])/g, "$1");
    const accessIds = [...readable.matchAll(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g)];
    const pairedIds = [...readable.matchAll(/\bAWS_ACCESS_KEY_ID\s*=\s*((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g)];
    const found = accessIds.map((m) => m[0]);
    let firstNearby = 0;
    for (const secret of readable.matchAll(
      /\bAWS_SECRET_ACCESS_KEY\s*=\s*["']?([A-Za-z0-9/+=]{40})["']?(?![A-Za-z0-9/+=])/g,
    )) {
      while (firstNearby < pairedIds.length && pairedIds[firstNearby].index < secret.index - 200) firstNearby++;
      if (pairedIds[firstNearby]?.index <= secret.index + 200 && !isPlaceholder(secret[1]) && looksRandom(secret[1])) {
        found.push(secret[1]);
      }
    }
    // People paste both halves of a key pair together, and the secret half often has no label of its own: "access
    // key AKIA… and secret key" then the secret on the next line, the two side by side, or a table row under the
    // ID. A 40-character value of mixed case and digits a few lines from an access key ID is that secret. One
    // that's all hex is a commit or a checksum instead, and looksRandom leaves those out.
    if (accessIds.length) {
      // Both come in the order they're written, so the first ID close enough before a secret only moves forward.
      let firstId = 0;
      for (const secret of readable.matchAll(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g)) {
        while (firstId < accessIds.length && accessIds[firstId].index < secret.index - AWS_PAIR_CHARS) firstId++;
        const near = accessIds[firstId]?.index <= secret.index + AWS_PAIR_CHARS;
        if (near && looksRandom(secret[0]) && !isPlaceholder(secret[0])) found.push(secret[0]);
      }
    }
    return [...new Set(found)];
  }

  // ---------- Your vault: things you told Clotr to protect ----------
  // Words and phrases you've added, like your name or your employer, are known only by fingerprint, a salted
  // hash of the lowercased phrase, so they never sit in storage as text. An account or ID format like
  // "AB-######" is stored as a shape instead (# for a digit, @ for a letter), and phone, email and address
  // entries are value fingerprints, matched in content.js against whatever the regular patterns found.

  let vault = null; // { salt, words: Map(fp → type), maxWords, shapes: [{ type, re, whole, near }] }
  let vaultHits = { text: null, hits: [] };

  // Turns a shape into a regular expression built only from literal characters plus a digit class for each
  // # and a letter class for each @, with no repeats, choices or groups to backtrack through. A shape is at
  // most 40 characters (MAX_SHAPE), so a team's own formats can never make matching slow.
  const MAX_SHAPE = 40;
  const shapeBody = (shape) =>
    [...shape]
      .map((ch) => (ch === "#" ? "\\d" : ch === "@" ? "[A-Za-z]" : ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")))
      .join("");
  const shapeToRegExp = (shape) => new RegExp(String.raw`(?<![\w-])${shapeBody(shape)}(?![\w-])`, "gi");

  // Whether all of `value` fits one of the saved formats, as an ID number a format found does. Cover it hides such a
  // value everywhere it appears (detector.js isSavedWord), since the number itself would still show inside a
  // longer word, where a saved name inside a longer word is a different word.
  const isVaultFormat = (value) => Boolean(vault?.shapes.some(({ whole }) => whole.test(value)));
  const goodShape = (s) => typeof s === "string" && s.length <= MAX_SHAPE && !/\d/.test(s) && /[#@].*[#@]/.test(s);

  // A format that lists "near" words only counts when one of them shows up as a whole word within the 40
  // characters before it, in any case and with or without accents. This is a plain text search, not a regex.
  const NEAR_CHARS = 40;
  const MAX_NEAR = 10;
  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wordChar = (ch) => Boolean(ch) && /[\p{L}\p{N}]/u.test(ch);
  function cleanNear(near) {
    if (!Array.isArray(near)) return null;
    const words = [];
    for (const w of near) {
      const f = typeof w === "string" ? fold(w.trim().replace(/\s+/g, " ")) : "";
      if (f && f.length <= NEAR_CHARS && !words.includes(f)) words.push(f);
      if (words.length >= MAX_NEAR) break;
    }
    return words.length ? words : null;
  }
  function nearBefore(text, index, near) {
    const before = fold(text.slice(Math.max(0, index - NEAR_CHARS), index));
    for (const w of near) {
      for (let at = before.indexOf(w); at >= 0; at = before.indexOf(w, at + 1)) {
        if (!wordChar(before[at - 1]) && !wordChar(before[at + w.length])) return true;
      }
    }
    return false;
  }

  // A team can add its own kinds at run time, named in its browser policy. Each one is checked by detect()
  // just like a built-in kind, found through the vault's words and formats of that type. They never join
  // the static PATTERNS table, so a page with no vault set only ever sees the built-in kinds.
  const MAX_KINDS = 100;
  let vaultKindList = []; // [{ id, group, name, cover, severity, team, find }]
  function cleanKinds(kinds) {
    const builtIn = new Set(PATTERNS.map((p) => p.id));
    const out = [];
    for (const k of Array.isArray(kinds) ? kinds : []) {
      if (out.length >= MAX_KINDS) break;
      const id = k && typeof k === "object" ? k.id : null;
      if (typeof id !== "string" || !/^[a-z_]{2,40}$/.test(id) || builtIn.has(id)) continue;
      if (out.some((x) => x.id === id)) continue;
      const name = typeof k.name === "string" ? k.name.trim().slice(0, 40).trim() : "";
      if (!name) continue;
      const cover = (typeof k.cover === "string" && k.cover.trim() ? k.cover : name).trim().slice(0, 20).trim();
      out.push({ id, group: "custom", name, cover, severity: "medium", team: true, find: findVault(id) });
    }
    return out;
  }
  const vaultKinds = () => vaultKindList;

  // Takes the stored vault's entries, each a word, shape or value, plus any entries a team manages, and
  // the extra kinds those entries are allowed to name beyond the built-in ones.
  function setVault(v) {
    vaultHits = { text: null, hits: [] };
    vaultKindList = cleanKinds(v?.kinds);
    const entries = v?.entries || [];
    const words = entries.filter((e) => e.kind === "word" && e.fp);
    const shapes = entries.filter((e) => e.kind === "shape" && goodShape(e.shape));
    if (!words.length && !shapes.length) {
      vault = null;
      return;
    }
    vault = {
      salt: v.salt,
      words: new Map(words.map((e) => [e.fp, e.type])),
      maxWords: Math.min(4, Math.max(1, ...words.map((e) => e.words || 1))),
      shapes: shapes.map((e) => ({
        type: e.type,
        re: shapeToRegExp(e.shape),
        whole: new RegExp(`^${shapeBody(e.shape)}$`, "i"),
        near: cleanNear(e.near),
      })),
    };
  }

  // Every vault hit in the text, computed once per text for all vault categories.
  function vaultMatches(text) {
    if (vaultHits.text === text) return vaultHits.hits;
    const hits = [];
    if (vault.words.size && vault.salt) {
      const fingerprint = globalThis.Clotr.fingerprint; // from detector.js, loaded next
      const words = [...text.matchAll(/[\p{L}\p{N}]+(?:['’._-](?!s\b)[\p{L}\p{N}]+)*/gu)].map((m) => ({
        start: m.index,
        end: m.index + m[0].length,
      }));
      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= vault.maxWords && i + n <= words.length; n++) {
          const span = text.slice(words[i].start, words[i + n - 1].end);
          const type =
            vault.words.get(fingerprint(vault.salt, "watch_list", span)) ||
            (/[^\x00-\x7f]/.test(span) && vault.words.get(fingerprint(vault.salt, "watch_list_accented", span))); // saved before 0.9.67
          if (type) hits.push({ type, span });
        }
      }
    }
    for (const { type, re, near } of vault.shapes) {
      for (const m of text.matchAll(re)) if (!near || nearBefore(text, m.index, near)) hits.push({ type, span: m[0] });
    }
    vaultHits = { text, hits };
    return hits;
  }

  // Marked `fromVault` so detect() knows the vault's words and formats don't need their own label, and
  // doesn't read them again after stripping a phone keyboard's dots back out in detector.js. The vault's
  // cached answer for this text is reused rather than recomputed.
  const findVault = (type) =>
    Object.assign(
      (text) =>
        vault
          ? vaultMatches(text)
              .filter((h) => h.type === type)
              .map((h) => h.span)
          : [],
      { fromVault: true },
    );

  // ---------- Passwords and secrets, found by the words around them ----------

  // Matches a labelled secret like "password: hunter2" or an .env-style name like DB_PASSWORD=. The name
  // prefix is limited to 4 parts, like the DB_PROD_ in DB_PROD_PASSWORD, because an unbounded version
  // backtracked quadratically on hostile text like a long run of "a-a-a-…", which CI's ReDoS fuzzing caught.
  // An "=" setting never takes its value from the next line: in an .env template, "PASSWORD=" is empty and
  // the line under it ("USERNAME=admin") is a setting of its own. "Password:" can still have it on the next line.
  // People write a key's name with a space too, as in "API key: …", "secret key: …" or "clave de API: …". Code
  // adds a type ("apiKey: string = …") or sets it by name (os.environ["DB_PASSWORD"] = …), and psql and sshpass
  // read PGPASSWORD and SSHPASS.
  const LABELLED_SECRET =
    /\b(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:password|passwd|pwd|pass|pw|passcode|passphrase|pin|secret|client_secret|token(?:\sde\sacceso)?|access_token|auth_token|api[_ -]?key|secret[ -]key|contrase(?:ñ|n)a|clave(?:\s(?:de\s)?api)?|pgpass(?:word)?|sshpass)(?:_[A-Za-z0-9]+)*["']?\]?\s*(?:\??:\s*(?:string|str)\s*=[^\S\n]*|:\s*|=[^\S\n]*)["']?([^\s"',;]+)/gi;
  // An HTTP auth header from a pasted curl command or code, like "Authorization: Bearer …".
  // Key and token labels have a distinct kind, while password labels stay in LABELLED_SECRET.
  const LABELLED_API_KEY =
    /\b(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:api[ _-]?key|[A-Za-z0-9]{1,30}[ _-](?:key|token)|client[ _-]secret|token\s+de\s+acceso)["']?\]?\s*(?:\??:\s*(?:string|str)\s*=[^\S\n]*|:\s*|=[^\S\n]*)["']?([^\s"',;]+)/gi;
  // A setting named after a secret is often about the secret rather than holding it: token_limit, pin_memory,
  // PASSWORD_RESET_TIMEOUT, api_key_header, password_hash_algorithm. These words after the secret's name mark that.
  // A place or a person (_prod, _db, _admin, _root, _user) still names the secret itself, so those aren't here.
  const ABOUT_THE_SECRET = new Set(
    (
      "count limit budget ttl timeout expiry expires expiration lifetime age duration interval window type types id ids " +
      "rate fail failed length len min max size header headers required field fields algorithm algo memory policy url " +
      "uri endpoint path file dir name names hash hashed hasher hashers version threshold digits layout prefix suffix " +
      "param params regex pattern label placeholder hint reset mode format enabled enable disabled flag style text " +
      "message msg error title description help input class kind schema strategy scheme method provider store manager " +
      "location source rotation validator validation validators strength complexity retries attempts"
    ).split(" "),
  );
  const LABEL_SECRET_WORD =
    /(?:password|passwd|pwd|pass|pw|passcode|passphrase|pin|secret|token|api[_ -]?key|key|contrase(?:ñ|n)a|clave|pgpass(?:word)?|sshpass)((?:_[a-z0-9]+)*)$/i;
  // What the value is, when it plainly isn't a secret: a flag, an empty value, a unit-bearing or decimal number, an
  // auth scheme or a Kubernetes secret type, a YAML or CloudFormation tag, a well-known resource name, or code.
  const NOT_A_SECRET_VALUE =
    /^(?:true|false|yes|no|on|off|none|null|nil|undefined|nan|bearer|basic|digest|opaque|jwt|oauth2?|secretstr|secretbytes|\d+\.\d+)$/i;
  // A number with a unit (30m, 3600s, 512mb) is a setting after a token or key label, but after a password or PIN
  // label it can be the password itself ("pin: 2024s").
  const UNIT_NUMBER = /^\d+(?:ms|s|m|h|d|kb|mb|gb|k|%)$/i;
  const PASSWORD_WORD =
    /^(?:password|passwd|pwd|pass|pw|passcode|passphrase|pin|contrase(?:ñ|n)a|clave|pgpass(?:word)?|sshpass)$/i;
  // An auth scheme word told after a secret's label, with the credential after it: "token: Bearer …", "Basic …",
  // GitHub's and Django REST's "Token …", Discord's "Bot …", and OAuth, Digest, JWT or Opaque.
  const AUTH_SCHEME = /^(?:bearer|basic|digest|oauth2?|jwt|opaque|bot|token)$/i;
  // The credential after a scheme word is the whole run up to a space, whatever marks are in it (%2B, $, !, &next=…),
  // less the sentence's own punctuation at its end. A mark the run doesn't expect never drops it. A colon, comma or
  // dash can sit between the scheme and the run ("Bearer: …", "Bearer - …"), and the run can be the whole next line
  // ("token: Bearer" then the token under it), but not a setting of its own ("expires_in: 3600").
  // A quote closing a quoted scheme word ('"Bearer" …') can sit before the run too, but not one that ends a JSON
  // key's value with more keys after it ('"Bearer", "expires_in": …').
  function schemeCredential(text, schemeEnd) {
    const from = schemeEnd + (/^["'”’][^\S\r\n]+[^\s"'{[,:;]/u.test(text.slice(schemeEnd, schemeEnd + 4)) ? 1 : 0);
    const run = /^[^\S\r\n]*(?:=>|->|[:,;=\-–—])?(?:[^\S\r\n]+|[^\S\r\n]*(\r?\n)[^\S\r\n]*)(\S+)/u.exec(
      text.slice(from, from + 600),
    );
    if (!run) return null;
    if (run[1] && (/[:=][^=]|:$/.test(run[2]) || !/^[^\S\r\n]*(?:\r?\n|$)/.test(text.slice(from + run[0].length)))) {
      return null;
    }
    const lead = /^["'“‘(<[`]*/.exec(run[2])[0].length;
    const value = run[2].slice(lead).replace(/[.,;:!?'"”’)\]}>`]+$/u, "");
    return value ? { value, end: from + run[0].length } : null;
  }
  // The scheme word at the start of a value told at `at`, less a bracket before it ("(Bearer …)") and a colon, comma
  // or dash after it, and the credential after it; null when the value doesn't start with a scheme word followed by
  // a credential.
  function schemeAt(text, at, value) {
    const lead = /^[([]?/.exec(value)[0].length;
    const word = value.slice(lead).replace(/[:,\-–—]+$/u, "");
    if (!AUTH_SCHEME.test(word)) return null;
    const credential = schemeCredential(text, at + lead + word.length);
    return credential && { word, value: credential.value, end: credential.end };
  }
  // Base64 read without atob, which Node 14 doesn't have. The "=" padding at the end is optional.
  const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function base64Text(v) {
    const padded = /=$/.test(v);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v) || (padded ? v.length % 4 !== 0 : v.length % 4 === 1)) return null;
    let bits = 0;
    let count = 0;
    let out = "";
    for (const ch of v.replace(/=+$/, "")) {
      bits = ((bits << 6) | BASE64_DIGITS.indexOf(ch)) & 0xffffff;
      count += 6;
      if (count >= 8) {
        count -= 8;
        out += String.fromCharCode((bits >> count) & 0xff);
      }
    }
    return out;
  }
  // HTTP Basic's credential is base64 of "name:password", so one that decodes to that is a sign-in.
  const basicSignIn = (plain) => Boolean(plain) && /^[\x21-\x7e][\x20-\x7e]*:[\x20-\x7e]*[\x21-\x7e]$/.test(plain);
  // A constant's name that stands in for a value still to be filled in: CHANGE_ME, TODO_FIXME, REPLACE_WITH_YOURS.
  const PLACEHOLDER_CONSTANT =
    /(?:^|_)(?:CHANGE|CHANGEME|TODO|FIXME|TBD|TBC|REPLACE|FILL|ENTER|INSERT|ASK|HERE|XXX+|DUMMY|SAMPLE|PLACEHOLDER|REDACTED|HIDDEN|MASKED|UNSET|NOTSET)(?:_|$)/;
  // A parameter after a scheme word isn't its credential: "Bearer, expires_in=3600", 'Digest realm="api"',
  // "Bearer; charset=UTF-8", "OAuth oauth_consumer_key=…", or a known parameter's name with ":" or nothing after it.
  // A token's own "=" is only base64 padding at its end, so a name and an "=" with more after it is a parameter.
  const SCHEME_PARAMETER = /^[A-Za-z_][\w.-]*=(?!=*$)/;
  const SCHEME_PARAMETER_NAME =
    /^(?:realm|scope|error|error_description|error_uri|charset|expires|expires_in|expires_at|ttl|max[_-]?age|version|kid|alg|typ|nonce|cnonce|nc|qop|opaque|algorithm|stale|domain|uri|response|username|userhash|oauth_[a-z_]+|token_type|state|audience|aud|iss|sub|exp|iat|nbf)(?:[:=]|$)/i;
  // A protocol's name and version after a scheme word: "Bearer; HTTP/1.1".
  const PROTOCOL_VERSION = /^[A-Za-z]+\/\d+(?:\.\d+)*$/;
  // Whether the run after "Bearer" or "Basic" is a credential: digits among its letters, random letters, or for
  // Basic a "name:password" in base64. "Basic Authentication" or "Bearer tokens" isn't one.
  // The standard's own example, Aladdin's "open sesame", is in every guide to Basic, and "username:password" is a
  // placeholder.
  // A Bearer token (RFC 6750's b64token) and Basic's base64 never hold a ":", so a run with one is a parameter or a
  // claim told after the scheme: "Bearer, client_id:app42", "Bearer, jti:a1b2c3".
  function schemeCredentialLike(scheme, v) {
    if (/:/.test(v)) return false;
    if (SCHEME_PARAMETER.test(v) || SCHEME_PARAMETER_NAME.test(v) || PROTOCOL_VERSION.test(v)) return false;
    if (/^basic$/i.test(scheme)) {
      const plain = base64Text(v);
      if (plain && /^(?:aladdin:open sesame|username:password)$/i.test(plain)) return false;
      if (basicSignIn(plain)) return true;
    }
    // Letters alone are a credential when they're random or switch case the way a token does ("XkfQaLmPzRtVbNw"),
    // which the same label reads as a password without the scheme word too.
    const caseSwitches = (v.match(/[a-z][A-Z]/g) || []).length;
    // A setting's name in snake case with a number on the end ("expires_in3600") is the next key, not a credential.
    if (/^[a-z]+(?:_[a-z]+)+\d*$/.test(v)) return false;
    return (
      (/\d/.test(v) && /[A-Za-z]/.test(v)) ||
      (v.length >= 16 && looksRandomLetters(v)) ||
      (v.length >= 10 && /^[A-Za-z]+$/.test(v) && caseSwitches >= 3)
    );
  }
  // The text before `index` on its line, up to 200 characters, starting with "\n" when it reaches the line's start.
  function lineBefore(text, index) {
    const from = Math.max(0, index - 200);
    const chunk = text.slice(from, index);
    const lineStart = chunk.lastIndexOf("\n");
    if (lineStart >= 0) return chunk.slice(lineStart);
    return (from === 0 ? "\n" : "") + chunk;
  }
  // What follows a value only in code: an operator like ||, && or ??, a default after a type ("password: Optional[str]
  // = None"), a comma ending the line as in an object's lines, or a bracket on the next line that closes the object or
  // call the value sits in. A comma inside a line, a ")" or "and" is ordinary writing too.
  // A comma ends an object's line only when the next line is code too: another "name:" or "name =", a call, a
  // comment, or the closing bracket. "superSecret,\nthanks" ends a line of a letter.
  const CODE_AFTER =
    /^[^\S\r\n]*(?:\|\||&&|\?\?|=(?!=)|,[^\S\r\n]*(?:\r?\n(?:[^\S\r\n]*(?:[)}\]]|["']?[\w$.-]+["']?[^\S\r\n]*[:=(]|\/\/|\/\*|#|\.\.\.|$)|[^\S\r\n]+[\w$.]+,)|$)|\r?\n[^\S\r\n]*[)}\]])/;
  // After a spaced " = " assignment, a semicolon or a Python "or", "and", "if" or "+" is code; an INI file's
  // "password = superSecret" alone is not, and nor is its comment after a spaced " ; ".
  const ASSIGNED_CODE_AFTER =
    /^(?:;|[^\S\r\n]+;[^\S\r\n]*(?:\r?\n|$|[\w$.]+[^\S\r\n]*[=(])|[^\S\r\n]*(?:\+|or\b|and\b|if\b))/;
  // What comes before a label in code: a declaration at the start of its line (let, const, private String) or an
  // object (this., self.). "the final password:" or "Our public password:" is a sentence.
  const DECLARED_BEFORE =
    /(?:^|[\n;{(,])[^\S\n]*(?:(?:export|let|const|var|val|final|static|private|public|protected|readonly|String|string|str|auto|def)\s+)+$/;
  // Declaration words that also start a sentence ("final password: …", "public password: …"). Before a label set
  // with ":" they make the value a type, and a type isn't written in lower camel case like "superSecret".
  const PROSE_DECLARATION =
    /^(?:final|public|private|protected|static)(?:\s+(?:final|public|private|protected|static))*$/;
  const MEMBER_BEFORE = /[.$]$/;
  // An INI or TOML section's header on a line of its own before the label: "[database]", "[wifi]".
  const INI_SECTION = /(?:^|\n)[^\S\r\n]*\[[A-Za-z][\w .-]*\][^\S\r\n]*\r?\n/;
  // Generic types and the types they hold, as in a Python or TypeScript annotation: Optional[str], List[str],
  // Annotated[str, Form()], Optional[SecretStr].
  const TYPE_GENERIC =
    /^(?:optional|list|dict|union|annotated|tuple|set|frozenset|sequence|mapping|mutablemapping|iterable|iterator|generator|literal|type|callable|awaitable|coroutine|classvar|final|required|notrequired|readonly|array|record|partial|promise|maybe|nullable|option|result|vec|box|rc|arc|some|ok|err|ref|cell|refcell|map|hashmap|future|lazy)$/;
  const TYPE_WORD =
    /^(?:str|int|float|bool|bytes|none|any|object|string|number|boolean|unknown|never|void|null|undefined|text|char|byte|long|integer|uuid|date|datetime|secretstr|secretbytes|emailstr|httpurl|anyurl|path|json|self|true|false)$/;
  // A secret's own word inside a name: Optional[Password], Some(Token), SECRET_KEY, ADMIN_PASS.
  const SECRET_PART =
    /^(?:pass|passwd|pwd|password|pw|pin|key|keys|token|tokens|secret|secrets|cred|creds|credential|credentials|auth|hash|api|salt)$/i;
  // A constant made only of a word that says "secret" and one that stresses it is a password typed in capitals:
  // SUPER_SECRET, TOP_SECRET. CLIENT_SECRET or DB_PASS names a stored one.
  const STRESSED_SECRET = /^(?:SUPER|TOP|VERY|ULTRA|MEGA|MOST)_SECRET$/;
  // A word and a number spelled out, the way "hunter2" is typed in capitals: HUNTER_TWO. A step, level or phase
  // with a number is an enum's value (PHASE_TWO, LEVEL_ONE), a test's or an account's constant is a fixture
  // (MOCK_TWO, ADMIN_TWO, WPA_TWO), and an instruction is a placeholder (PICK_ONE, ANY_TWO).
  // "_ONE" alone is too often "pick one" or "use one" to count.
  const CAPS_WORD_NUMBER = /^([A-Z]{3,})_(?:TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE)$/;
  const ENUM_STEP =
    /^(?:LEVEL|PHASE|STEP|STAGE|TIER|OPTION|VERSION|ROUND|PLAN|CASE|GROUP|CLASS|RULE|FACTOR|METHOD|SCHEME|POLICY|TEAM|ZONE|REGION|NODE|SLOT|PART|PAGE|ITEM|CHOICE|LAYER|GRADE|ROLE|BATCH|SHARD|REPLICA|PRIORITY|NUMBER|INDEX|ORDER|RANK|SIZE|SET|SIDE|AREA|PLAYER|SCREEN|FORM|FIELD|SECTION|ENTRY|STATE|STATUS|TEST|ANY|SOME|ALL|EACH|EVERY|NOT|NONE|ONLY|JUST|PICK|CHOOSE|SELECT|USE|GENERATE|CREATE|MAKE|ADD|GET|NEED|NEEDS|ENTER|INPUT|ASK|SEE|FIND|GIVE|TAKE|FIRST|LAST|NEXT|PREV|PREVIOUS|TOP|BOTTOM|PLUS|MINUS|TIMES|AUTO|MANUAL|STRATEGY|FLOW|TOTAL|DEMO|MOCK|FAKE|STUB|FIXTURE|TESTING|ADMIN|GUEST|ROOT|BACKUP|ACCOUNT|PRIMARY|SECONDARY|BUILD|SPRINT|DAY|WAVE|OAUTH|SHA|WPA)$/;
  // Whether a constant in capitals is a password a person typed rather than an enum's value, a setting or a
  // placeholder (SET_ME, NOT_REQUIRED, USE_SSO, MYSQL_ROOT, SOME_CONSTANT), which are far more common after a label.
  // Only a stressed "secret" (SUPER_SECRET) or a word and a number word (HUNTER_TWO) is; a quoted "MY_SECRET_PASS" is
  // a string typed out too.
  function capsPassword(v, quoted) {
    if (STRESSED_SECRET.test(v) || (quoted && /^MY_(?:(?:SUPER|TOP)_)?SECRET_PASS$/.test(v))) return true;
    const numbered = CAPS_WORD_NUMBER.exec(v);
    if (!numbered) return false;
    const w = numbered[1];
    return !(CODE_CONSTANT_PART.test(w) || SECRET_PART.test(w) || ENUM_STEP.test(w) || PLACEHOLDER_CONSTANT.test(w));
  }
  // Words in a constant's name that code uses and a typed password doesn't: DEFAULT_VALUE, MAX_LENGTH, EMPTY_STRING.
  const CODE_CONSTANT_PART =
    /^(?:DEFAULT|DEFAULTS|CONFIG|CONF|SETTING|SETTINGS|ENV|ENVIRON|VAR|VARS|VALUE|VALUES|NAME|PATH|FILE|DIR|URL|URI|HOST|PORT|USER|USERNAME|MAX|MIN|LEN|LENGTH|SIZE|EMPTY|STRING|STR|NONE|NULL|NIL|INT|BOOL|TRUE|FALSE|FIELD|FIELDS|TYPE|KIND|HEADER|PREFIX|SUFFIX|CHARS|REGEX|PATTERN|TIMEOUT|TTL|LIMIT|COUNT|MODE|FLAG|ID|KEY|DB|SQL|HTTP|HTTPS|API|APP|SERVER|CLIENT|SERVICE|CACHE|STORE|VAULT|PROD|DEV|TEST|STAGING|LOCAL|GLOBAL|CONST|INITIAL|INIT|ORIGINAL|CURRENT|OLD|NEW)$/;
  // Objects and holders that code reads a value from, at any place in a member chain: App.Settings.Value,
  // vault.kv.read, os.environ.get.
  const CODE_HOLDER =
    /^(?:settings|setting|config|configs|conf|cfg|env|environ|vault|secrets|params|request|req|client|server|instance|current|defaults|default|prefs|preferences|keys|globals|vars|variables|properties|props|attrs|attributes|fields|field|model|module|exports|process|global|locals|services|service|provider|manager|cache|storage|value|values|get|read|load|fetch|app|self|this|state|ctx|context|data|form|store|options|opts|sys|os|args|kwargs|payload|result|response|resp|res|db|api|system|environment|java|javax|microsoft|android|util|lang|security|crypto|net|io|application|credentials|creds|keychain|keyring|account|accounts|login)$/i;
  // A part of a member chain two letters or shorter is code when it has no vowel or is a usual short name in code
  // (kv, db, Pw, id, os); "I.love.my.dog" or "me.and.you" is a passphrase of short words.
  const shortCodePart = (p) =>
    p.length <= 2 && (!/[aeiouy]/i.test(p) || /^(?:id|os|io|ui|ip|op|el|ev|ex|re|ok|ai|au)$/i.test(p));
  // A function's or index's name around a single word, and what follows its bracket: "Kitty[Paw]", "Fluffy(cat)9".
  const BRACKETED = /^([A-Za-z_$][\w$]*)([([])([^()[\]{}]*)([)\]])([\s\S]*)$/;
  // A constant's or an environment variable's name: DEFAULT_HASHERS, SESSION_SECRET.
  const CONSTANT_NAME = /^[A-Z]+(?:_[A-Z]+)+$/;
  // A variable's name in code: a secret's name with a word code uses for it, like hashedPassword or access_token.
  // Words a person also puts in a weak password (admin, default, temp, new, user, db) aren't here.
  const CODE_SECRET_NAME =
    /^(?:(?:hash|hashed|encrypted|enc|salted|old|current|stored|plain|plaintext|raw|access|refresh|auth|session|csrf|jwt|input|confirm|reset|bearer|id|api)(?:password|passwd|pwd|pass|token|secret|key|pin)|(?:password|passwd|pwd|pass|token|secret|key|pin)(?:hash|hashed|encrypted|salt|input|field|value|confirm|confirmation|id|str|string|bytes|data))$/;
  // Names that are a variable in code and a weak password typed by a person alike, read as a password after a
  // password label.
  const WEAK_PASSWORD_NAME = /^(?:old|current|reset|auth|session)(?:password|passwd|pwd|pass)$/;
  // A password's word with a word code puts after it, anywhere in a longer name: resetPasswordToken,
  // sessionPasswordHash, user_password_field.
  const PASSWORD_THEN_CODE =
    /(?:password|passwd|pwd)(?:hash|hashed|encrypted|salt|input|field|value|confirm|confirmation|id|str|string|bytes|data|token|key|reset|digest)$/;
  // A function that makes or reads a secret, called around a word: Hash(pw), Decrypt(cfg), Secret(name).
  const SECRET_FUNCTION =
    /^(?:hash|crypt|encrypt|decrypt|encode|decode|digest|cipher|hmac|sign|bcrypt|scrypt|argon2|sha\d*|md5|base64|b64encode|b64decode|getenv|env|secret|token|password|passwd|key|apikey|credential|credentials)$/;
  // Whether the text just before `index` is inside code: an object's "{" or a call's or index's "(" or "[" right
  // after a name, still open. A "(" after a space or at the start is a sentence's aside: "(password: …)".
  function insideCode(text, index) {
    let depth = 0;
    for (let i = index - 1; i >= 0 && i >= index - 300; i--) {
      const c = text[i];
      if (c === ")" || c === "]" || c === "}") depth++;
      else if (c === "(" || c === "[" || c === "{") {
        if (depth > 0) {
          depth--;
          continue;
        }
        return c === "{" || /[\w$.)\]]/.test(text[i - 1] || "");
      }
    }
    return false;
  }
  // Whether a word around a word ("Kitty[Paw]", "Fluffy(cat)9") is a password rather than code. Code calls and
  // indexes look the same as these (Field(alias), Settings[key], Some(pw), Optional[str], Inject(Config)), so this
  // takes only what code doesn't write: letters or digits right after the closing bracket, or, in an INI file
  // where a value is never code, a capitalised word that isn't a generic type, a secret's function or the label's
  // word around a plain word ("[wifi]\npassword = Fluffy(cat)"). A sentence can describe code ("Set the password:
  // Input(prompt)"), so it isn't enough.
  function bracketedPassword(value, word, inCode, ini) {
    if (inCode) return false;
    const b = BRACKETED.exec(value.trim().replace(/[.,;:!?]+$/, ""));
    if (!b) return false;
    const [, fn, , inner, , rest] = b;
    // A chain on the result is code: Secret(name).value, get(pw)[0].
    if (/^(?:\.[A-Za-z_$]|[([])/.test(rest)) return false;
    if (/^[A-Za-z0-9]/.test(rest)) return true;
    if (rest || !ini || !/^[A-Z][a-z]+$/.test(fn) || !/^[A-Za-z]+$/.test(inner)) return false;
    const lower = fn.toLowerCase();
    if (TYPE_GENERIC.test(lower) || SECRET_FUNCTION.test(lower) || lower === word) return false;
    return !TYPE_WORD.test(inner.toLowerCase()) && !/pass|pwd|token|secret|key|pin|cred|auth/i.test(inner);
  }
  // The word in a setting's name that says what secret it is, run together: "apikey" for API_KEY, "password".
  function secretWordOf(settingName) {
    const named = settingName && LABEL_SECRET_WORD.exec(settingName);
    return named
      ? named[0]
          .slice(0, named[0].length - named[1].length)
          .replace(/[_ -]/g, "")
          .toLowerCase()
      : "";
  }
  const YAML_TAG =
    /^!(?:vault|Ref|Sub|GetAtt|ImportValue|Join|Select|Split|If|Base64|FindInMap|Equals|Condition|env|include|secret|encrypted)$/;
  const DOMAIN_ENDING = String.raw`\.(?:com|org|net|io|app|dev|co|ai|gov|edu|me|us|uk|de|cloud|sh)`;
  const DOMAIN_VALUE = new RegExp(String.raw`^[a-z0-9-]+(?:\.[a-z0-9-]+)*${DOMAIN_ENDING}(?:/[\w./-]*)?$`);
  // Objects that code reads a value from, like tokenizer.eos_token or state.auth.token.
  const CODE_OBJECT =
    /^(?:self|this|tokenizer|response|resp|res|state|props|ctx|context|data|user|form|session|store|auth|options|opts|cfg|conf|app|sys|os|window|document|tokens|credentials|creds|payload|result|args|kwargs|jwt|crypto|bcrypt|hashlib|secrets)$/;
  // A name in code is words, maybe with a number at the end (eos_token, getPassword, argv, v2). A random token cut at
  // its dots has digits in the middle of its pieces, so it never reads as one.
  const IDENT = String.raw`[A-Za-z_$][A-Za-z_$]*\d{0,3}(?![\w$])`;
  // Code that names, reads or computes a secret instead of holding one. `settingName` is the setting's name, lower
  // case. `around` says what's next to the value: the text before the label on its line (`before`), the text after
  // the value (`after`), whether the label was set with a spaced " = " (`assigned`) or with any "=" (`equals`), and
  // whether the label sits inside an object or a call (`enclosed`). People's passwords can look like code too
  // ("Correct.Horse.Battery", "superSecret", "Fluffy(cat)9"), so a shape that both write needs code around it, and
  // ordinary writing (a comma, a bracket, "and", an INI file's " = ") isn't that.
  // Whether a label and its value stand alone the way a note writes them: "wifi password: myPassword". Set with "=",
  // a quoted key ("password": …), a colon with no space after it, an indented line (an object's or YAML's member),
  // code punctuation or a comment right after the value, or a closing bracket after blank or comment lines is code
  // or a settings file.
  const CODE_RIGHT_AFTER = /^[^\S\r\n]*(?:[)}\];]|\/\/|\/\*|#|,[^\S\r\n]*(?:\r?\n|$))/;
  const CLOSES_LATER = /^[^\S\r\n]*(?:\r?\n[^\S\r\n]*(?:(?:\/\/|#|\/\*)[^\r\n]*)?)*\r?\n[^\S\r\n]*[)}\]]/;
  function bareLabel(near, after) {
    if (near.equals || near.quotedKey || near.tight) return false;
    if (/^\n[^\S\n]+/.test(near.before || "")) return false;
    return !CODE_RIGHT_AFTER.test(after) && !CLOSES_LATER.test(after);
  }
  // The code shapes around any variable's name, which a note doesn't write either: a quoted key with an unquoted
  // value ("password": superSecret), or a ";", "}" or "//" comment right after it, or a closing bracket after blank
  // or comment lines. A ")" or "," is a sentence's too: "(password: superSecret)", and so is an INI file's comment
  // after a spaced " ; ".
  const VARIABLE_RIGHT_AFTER = /^(?:;|[^\S\r\n]*(?:\}|\/\/|\/\*|;[^\S\r\n]*(?:\r?\n|$)))/;
  // More of an object or a call after the value, which a note doesn't write either: a comma and another member
  // ("email })", "...rest", a "remember: true" or "email: email" set to a literal or its own name) or a comment, a
  // TypeScript cast ("as string", "satisfies Login"), a "+" or a "? :" around it, or indented member lines down to
  // the bracket that closes them. A comma and a word ("thanks!", "and the guest one", "host: x") is a sentence's.
  const MEMBERS_AFTER =
    /^(?:[^\S\r\n]*,[^\S\r\n]*(?:\.\.\.|\/\/|\/\*|#|[A-Za-z_$][\w$]*[^\S\r\n]*[,)}]|([A-Za-z_$][\w$]*):[^\S\r\n]*(?:true|false|null|undefined|\d+|\1)(?![\w$]))|[^\S\r\n]+(?:as[^\S\r\n]+(?:const|string|number|boolean|any|unknown|[A-Z][\w$]*)(?![\w$])|satisfies[^\S\r\n]+[A-Za-z_$]|\+[^\S\r\n]+[\w$(]|\?[^\S\r\n]+[^\r\n]*?[^\S\r\n]:[^\S\r\n])|[^\S\r\n]*(?:\r?\n[^\S\r\n]+(?:,?[^\S\r\n]*["']?[\w$-]+["']?|\/\/|#|\/\*)[^\r\n]*)+\r?\n[^\S\r\n]*[)}\]])/;
  const variableInCode = (near, after) =>
    Boolean(near.quotedKey) ||
    VARIABLE_RIGHT_AFTER.test(after) ||
    CLOSES_LATER.test(after) ||
    MEMBERS_AFTER.test(after);
  // Whether a variable-like name stands on a bare line the way a note writes it: nothing after it up to the line's end
  // is a code character (a bracket, "=", "+", "?", ";", a quote, "<", ">", "|", "&", "!" or a member's "."), apart
  // from a ")" that closes a "(" opened before the label on its line ("(password: superSecret)") and a closing "!" or
  // "?" of a sentence, and the next line that isn't blank isn't indented and doesn't start with a closing bracket.
  // "password: superSecret, thanks" and "user: bob, password: mySecret, host: x" are bare; "password: newPassword,
  // email })", "password: newPassword === confirm" and "password: newPassword\n  ...rest\n}" aren't. An INI file's
  // comment after a spaced " ; " or " # " is the file's, not code.
  // A later member set to a camelCase name ("email: emailInput", "confirm: confirmPassword") is code too; "host: x" or
  // "wifi: HomeNet" is a note's.
  const BARE_LINE_CODE =
    /[(){}[\]=+;'"`<>|&]|![\w$!(=]|\?(?![^\S\r\n]*$)|\.[A-Za-z_$]|:[^\S\r\n]*[a-z][a-z\d]*[A-Z][\w$]*(?![\w$])/;
  function bareLine(near, rest) {
    const newline = rest.search(/\r?\n/);
    let line = newline < 0 ? rest : rest.slice(0, newline);
    if (near.assigned || near.ini) line = line.replace(/[^\S\r\n]+[;#][^\S\r\n][\s\S]*$/, "");
    const before = near.before || "";
    let opened = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
    while (opened > 0 && line.includes(")")) {
      line = line.replace(")", "");
      opened--;
    }
    if (BARE_LINE_CODE.test(line)) return false;
    if (newline < 0) return true;
    const next = /^(?:[^\S\r\n]*\r?\n)*([^\S\r\n]*)(\S?)/.exec(rest.slice(newline).replace(/^\r?\n/, ""));
    return !(next && next[2] && (next[1].length > 0 || /[)}\]]/.test(next[2])));
  }
  function codeValue(value, settingName, around) {
    const near = around || {};
    const v = value.trim().replace(/[)\]}>]+$/, "");
    // Brackets at the end that close nothing in the value, then what follows the value.
    const open = (v.match(/[([{]/g) || []).length - (v.match(/[)\]}]/g) || []).length;
    const closers = value.trim().slice(v.length + Math.max(0, open));
    const after = closers + (near.after || "");
    // A declaration before a label set with ":" makes the value a type ("private password: String"), and a type is
    // capitalised or a built-in word, so "private password: superSecret" is a sentence's label.
    const declaration = DECLARED_BEFORE.exec(near.before || "");
    const declared =
      Boolean(declaration) &&
      (Boolean(near.equals) ||
        !/^[a-z]/.test(v) ||
        TYPE_WORD.test(v) ||
        !PROSE_DECLARATION.test(declaration[0].replace(/^[\n;{(,]/, "").trim()));
    const inCode =
      Boolean(near.enclosed) ||
      CODE_AFTER.test(after) ||
      declared ||
      MEMBER_BEFORE.test(near.before || "") ||
      // An indented member ending in ";", as in a TypeScript class or interface: "  password: superSecret;".
      (/^\n[^\S\n]+$/.test(near.before || "") && /^;[^\S\r\n]*(?:\r?\n|$)/.test(after)) ||
      Boolean(near.assigned && ASSIGNED_CODE_AFTER.test(after));
    const word = secretWordOf(settingName);
    const passwordLabel = PASSWORD_WORD.test(word);
    // A type after a declaration: "private password: String", "readonly token: Token".
    if (declared && !near.equals && /^[A-Z][A-Za-z]*$/.test(v)) return true;
    // A type named for the label's own secret inside code: "token: Token;" in an interface, "password: Password,".
    if (inCode && word && /^[A-Z][A-Za-z]*$/.test(v) && v.toLowerCase().includes(word)) return true;
    // A call or an index: generate_token(32, crypt($1, response.json()["…, tokens['…, sys.argv[1, hash(pw.
    const call = new RegExp(String.raw`^(${IDENT}(?:\.${IDENT})*)(?:\(\))*([([])(.?)`).exec(v);
    if (call) {
      const [, name, , next] = call;
      if (/[._]/.test(name) || /[a-z][A-Z]/.test(name) || /^[$'")\]]$/.test(next) || next === "") return true;
      // A plain word around a word: hash(pw), creds[key], Optional[str], Field(alias), Kitty[Paw], Fluffy(cat)9.
      if (/^[A-Za-z_]$/.test(next) && !bracketedPassword(value, word, inCode, near.ini)) return true;
    }
    // A member chain: tokenizer.eos_token, state.auth.token, user.password, vault.kv.read, Settings.Db.Pw,
    // App.Settings.Value. Dotted words with nothing code-like in them ("Correct.Horse.Battery", "I.love.my.dog") are
    // a passphrase.
    const parts = new RegExp(String.raw`^${IDENT}(?:\.${IDENT})+$`).test(v) ? v.split(".") : null;
    if (parts) {
      const last = parts[parts.length - 1].toLowerCase();
      if (
        parts.some((p) => /_/.test(p) || /[a-z][A-Z]/.test(p) || shortCodePart(p) || CODE_HOLDER.test(p)) ||
        CODE_OBJECT.test(parts[0]) ||
        /pass|token|secret|key|pin/.test(last)
      ) {
        return true;
      }
    }
    // A variable named for the secret: api_key, hashedPassword, DEFAULT_HASHERS. A word plus digits stays a password.
    if (new RegExp(String.raw`^${IDENT}$`).test(v) && !/\d/.test(v)) {
      const flat = v.replace(/_/g, "").toLowerCase();
      const ownWord = Boolean(word) && flat.includes(word);
      // A constant is code, a setting or a placeholder (DB_PASSWORD, SECRET_KEY, NOT_SET, USE_SSO) unless it's a
      // password typed in capitals ("SUPER_SECRET", "HUNTER_TWO") outside code.
      // A setting for how secret something is holds a classification: PASSWORD_LEVEL=TOP_SECRET.
      if (CONSTANT_NAME.test(v)) {
        return (
          inCode ||
          ownWord ||
          !capsPassword(v, false) ||
          /[_ -](?:level|classification|scope|audience|visibility)$/.test(settingName)
        );
      }
      if (!(/_/.test(v) || /^[a-z]+[A-Z]/.test(v))) return false;
      if (!ownWord && !/password|token|secret/.test(flat)) return false;
      if (inCode) return true;
      // Whatever the label, such a name is the variable unless it stands on a bare line ("token: newPassword, email })"
      // is code; "password: dbPassword" is a weak password).
      if (!bareLine(near, closers + (near.rest != null ? near.rest : near.after || ""))) return true;
      // A name holding a password's word after a password label (newPassword, dbPassword) reads as a weak password
      // only on a bare "password: dbPassword" line. Any sign of code or settings around it makes it the variable, and
      // so does snake case (my_password), which is how a variable is written rather than a password.
      if (passwordLabel && /pass|pwd/.test(flat)) {
        if ((ownWord && /_/.test(v)) || !bareLabel(near, after)) return true;
      }
      if (variableInCode(near, after)) return true;
      // A weak password reads like a variable after a password label: oldPassword, currentPassword, authPassword.
      if (CODE_SECRET_NAME.test(flat) && !(passwordLabel && WEAK_PASSWORD_NAME.test(flat))) return true;
      if (PASSWORD_THEN_CODE.test(flat)) return true;
      // Nobody picks a token or a key by hand, so after a token, secret or key label a name holding that label's own
      // word is a variable: githubToken, webhookSecret, openai_api_key. A password is picked by hand, and a weak one
      // reads the same as a variable ("adminPassword", "superSecret"), so it's read as a password.
      if (!passwordLabel && ownWord) return true;
    }
    return false;
  }
  // Whether a value told after a secret's label is really about the secret or code, given the label's text up to
  // its ":" or "=". A real password ("Summer2024!", "Fluffy12", a PIN of digits) still passes.
  function labelledNotSecret(labelText, value, around) {
    const name = labelText
      .replace(/\??\s*(?::\s*(?:string|str)\s*)?[:=][\s\S]*$/, "")
      .replace(/["'\]\s]+$/, "")
      .replace(/^.*\[["']?/, "");
    const named = LABEL_SECRET_WORD.exec(name);
    if (named) {
      const suffix = named[1].toLowerCase().split("_").filter(Boolean);
      // Vault's AppRole secret_id is itself a credential.
      const secretId = /^secret$/i.test(named[0].slice(0, named[0].length - named[1].length)) && suffix[0] === "id";
      if (!secretId && suffix.some((part) => ABOUT_THE_SECRET.has(part))) return true;
      const prefix = name.slice(0, named.index).toLowerCase().split(/[_-]/).filter(Boolean);
      if (prefix.some((part) => /^(?:max|min|num|total|count)$/.test(part))) return true;
    }
    const v = value.trim().replace(/[.,;:!?)\]}>]+$/, "");
    if (NOT_A_SECRET_VALUE.test(v) || YAML_TAG.test(v) || DOMAIN_VALUE.test(v)) return true;
    const passwordLabel = named && PASSWORD_WORD.test(named[0].slice(0, named[0].length - named[1].length));
    if (UNIT_NUMBER.test(v) && !passwordLabel) return true;
    if (CONSTANT_NAME.test(v) && PLACEHOLDER_CONSTANT.test(v)) return true;
    // A quoted value is a string, not code that names the secret: password = "superSecret". A quoted constant's name
    // is still a placeholder, an enum's value or the name of a setting (session_secret_env = "SESSION_SECRET",
    // "password": "NOT_SET", token: "MY_API_KEY"), unless it's a password typed in capitals: password: "SUPER_SECRET".
    if (around && around.quoted) {
      if (!CONSTANT_NAME.test(v)) return false;
      const word = secretWordOf(name.toLowerCase());
      const ownWord = Boolean(word) && v.replace(/_/g, "").toLowerCase().includes(word);
      return ownWord || !capsPassword(v, true);
    }
    return codeValue(value, name.toLowerCase(), around);
  }
  const PROVIDER_CREDENTIAL_LABEL =
    /^(?:GITHUB|GH_APP_INSTALLATION|GITLAB|PERPLEXITY|SLACK|DIGITALOCEAN|HUGGINGFACE|HEROKU|1PASSWORD|OP_SERVICE_ACCOUNT|CLOUDFLARE|TWILIO)(?:_|$)/i;
  // `inTwilio` is twilioLookup of the whole text, which each caller builds once: reading the pairs again for every
  // label grew with the square of a paste full of TWILIO_ lines. `at` is where `value` starts in that text.
  function isProviderCredentialLabel(match, inTwilio, value, at) {
    const separator = match.search(/[:=]/);
    if (separator < 0) return false;
    const normalizedLabel = match.slice(0, separator).replace(/["']/g, "").replace(/[ -]/g, "_").toUpperCase();
    if (!PROVIDER_CREDENTIAL_LABEL.test(normalizedLabel)) return false;
    const kind = [
      ["GH_APP_INSTALLATION", "github_token"],
      ["GITHUB", "github_token"],
      ["GITLAB", "gitlab_token"],
      ["PERPLEXITY", "perplexity_key"],
      ["SLACK", "slack_token"],
      ["DIGITALOCEAN", "digitalocean_token"],
      ["HUGGINGFACE", "huggingface_token"],
      ["HEROKU", "heroku_token"],
      ["1PASSWORD", "onepassword_token"],
      ["OP_SERVICE_ACCOUNT", "onepassword_token"],
      ["CLOUDFLARE", "cloudflare_origin_ca_key"],
      ["TWILIO", "twilio_credentials"],
    ].find(([prefix]) => normalizedLabel.startsWith(prefix))?.[1];
    if (!kind) return false;
    // The Twilio kind needs the SID beside the token, so a token pasted alone stays with the label finders.
    if (kind === "twilio_credentials") {
      const token = trimTrailing(value, /[.)\]}>]/);
      return inTwilio(at, at + token.length);
    }
    const pattern = PATTERNS.find((candidate) => candidate.id === kind);
    if (!pattern?.regex) return false;
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace(/[gy]/g, ""));
    const candidate = value.match(regex);
    return Boolean(candidate) && candidate[0] === value && (!pattern.validate || pattern.validate(candidate[0]));
  }
  // Also set by name (headers["Authorization"] = …), in a Python f-string, or as nginx writes it with a space.
  const AUTH_HEADER =
    /\b(?:proxy-)?authorization["']?\]?(?:\s*[:=]\s*|\s+(?=["']))(?:[fbru]{1,2}(?=["']))?["']?(?:bearer|basic|token|apikey)\s+([A-Za-z0-9._~+/=-]{12,})/gi;
  // How people write a password out to a person, as in "my password is Fluffy123" or "my password for
  // netflix is …". This also catches common misspellings like "pasword" or "passwrod".
  const TOLD_SECRET =
    /\b(?:(?:my|the|our|his|her|their|your)\s+)?(?:wi-?fi\s+|email\s+|bank\s+|computer\s+|phone\s+)?(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|pw|pwd|passcode|passphrase|pin(?:\s+(?:number|code))?)(?:\s+(?:for|to|on|at|of)\s+(?:(?:my|the|our|his|her|their|your)\s+)?[A-Za-z\d.'-]+(?:\s+[A-Za-z\d.'-]+)?)?\s+(?:is|was)\s*(?::\s*)?["'“‘]?([^\s"'”’,;!?]+)/gi;
  // Spanish: "mi contraseña es Gato2024!", "la contraseña del wifi es sol-y-luna".
  const TOLD_SECRET_ES =
    /(?<![\p{L}])(?:(?:mi|la|el|tu|su|nuestra)\s+)?(?:contrase(?:ñ|n)a|clave|pin)(?:\s+(?:del?|de\s+(?:la|mi|tu|su)|para(?:\s+(?:el|la|mi|tu|su))?)\s+[\p{L}\d-]+){0,2}\s+(?:es|era)\s*(?::\s*)?["'“‘]?([^\s"'”’,;!?]+)/giu;
  // Other ways people tell a password: "the password's Pumpkin_88", "my password, it's Marigold#7", "I changed
  // my password to bluecat77", "olvidé mi contraseña, es …", "cambié mi contraseña a …". These read like
  // ordinary sentences just as often ("my password's been changed"), so the value has to look like a password.
  const PW_WORD = String.raw`(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|passcode)`;
  const TOLD_SECRET_MORE = new RegExp(
    String.raw`(?<![\p{L}\d])(?:(?:my|the|our|his|her|their|your)\s+(?:(?:wi-?fi|email|bank|computer|phone)\s+)?${PW_WORD}(?:['’]s|,\s+it(?:['’]s|\s+is))|(?:chang|updat|reset|set)(?:e|ed|es|ing|s)?\s+(?:(?:my|the|our|his|her|their|your)\s+)?(?:(?:wi-?fi|email|bank|computer|phone)\s+)?${PW_WORD}\s+to|(?:mi|la|tu|su)\s+(?:contrase(?:ñ|n)a|clave),\s+(?:es|era)|(?:cambi[éeo]|cambiar|cambiado|puse|actualic[ée])\s+(?:(?:mi|la|tu|su)\s+)?(?:contrase(?:ñ|n)a|clave)(?:\s+del?\s+[\p{L}\d-]+)?\s+(?:a|por))\s+["'“‘]?([^\s"'”’,;!?]+)`,
    "giu",
  );
  // A key told in a sentence, as in "my API key is …" or "el token es …". "Token" and "key" lead into plenty of
  // ordinary sentences ("the token is expired"), so the value has to look machine-made (keyLike below). A login
  // token (eyJ…) already has its own kind, and a crypto token's 0x… contract address is public.
  const TOLD_KEY =
    /(?<![\p{L}\d])(?:api[ _-]?key|(?:access|auth|bearer|api|bot)[ _-]?token|token|secret[ _-]?key|client[ _-]?secret|token\s+de\s+acceso)\s+(?:is|was|es|era)\s*(?::\s*)?["'“‘]?([^\s"'”’,;!?]+)/giu;
  const keyLike = (v) =>
    v.length >= 16 && /\d/.test(v) && /\p{L}/u.test(v) && !/^(?:eyJ|0x)/.test(v) && entropy(v) >= 3.5;
  // Answers to account-recovery questions work the same way passwords do, as in "my mother's maiden name
  // is Smith" or "the answer to my security question is Rover". Each label here is written once and read
  // twice: once by the rule that finds a code told after it, and once by the scam-detection check in
  // scam-signs.js, through Clotr.askLabels, so the two can't drift apart.
  const ANSWER_LABEL = String.raw`mother'?s\s+maiden\s+name|maiden\s+name|memorable\s+(?:word|information|answer|phrase)|first\s+pet'?s\s+name|answer\s+to\s+(?:my|the)\s+security\s+question|security\s+(?:question\s+)?answer`;
  const ANSWER_LABEL_ES = String.raw`apellido\s+de\s+soltera(?:\s+de\s+mi\s+madre)?|nombre\s+de\s+mi\s+primera\s+mascota|respuesta\s+(?:de|a\s+la\s+pregunta\s+de)\s+seguridad`;
  const TOLD_ANSWER = new RegExp(
    String.raw`\b(?:${ANSWER_LABEL})(?:\s*\([^()\n]{1,30}\))?\s+(?:is|was)\s*(?::\s*)?["'“‘]?([\p{L}][\p{L}'-]{1,40})`,
    "giu",
  );
  const TOLD_ANSWER_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:${ANSWER_LABEL_ES})\s+(?:es|era)\s*(?::\s*)?["'“‘]?([\p{L}][\p{L}'-]{1,40})`,
    "giu",
  );
  // A password word right before a value that looks like one, as in "…and the password Summer2024". A
  // letter or digit right before the word rules it out, so it won't catch the "PW" at the end of an
  // IBAN group like "U4PW 7VRN".
  const BARE_SECRET =
    /(?<![\p{L}\d])(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|passcode|pw|pwd|contrase(?:ñ|n)a)\s+["'“‘]?([^\s"'”’,;]{4,64})/giu;
  // More ways a password gets told, each where the words leave no doubt what the value is: German and French
  // ("Mein Passwort ist …", "mon mot de passe est …"), a login then "and it's …", "use … as the password",
  // "user bob pass …", mysql's -p with the password stuck to it, XML's <password>, a password box's value, and
  // PowerShell's ConvertTo-SecureString "…" -AsPlainText. The sentence forms want a digit or a symbol in the value,
  // since "the login is broken and it's Friday" and "use Bitwarden as the password manager" are just sentences.
  const TOLD_SECRET_DE_FR =
    /(?<![\p{L}])(?:(?:mein|dein|unser|das|mon|ton|notre|le)\s+)?(?:(?:wlan|e-?mail)-?\s*)?(?:passwort|kennwort|mot\s+de\s+passe)\s+(?:ist|lautet|war|est|était|etait)(?:\s*:)?(?:\s*["'“‘„«]\s*|\s*)([^\s"'”’“,;!?»]+)/giu;
  // The same in other languages: "minha senha é …", "mijn wachtwoord is …", "мой пароль: …", "ο κωδικός μου
  // είναι …", "senha: …". A few short words can sit between the password word and "is" ("a senha do wifi é …").
  // Where "is" is often left out, as in Russian, Turkish or Indonesian ("şifrem …", "kata sandi saya …"), the
  // word right before a value is enough when the value has a digit and is six characters or more. Each
  // language's "is" or a colon wants a value with a digit or a symbol, like the German and French forms.
  const PW_WORD_INTL = String.raw`(?:senha|wachtwoord|has[łl]o|heslo|(?<!la )parola|parolă|[şs]ifre(?:m|niz)?|parolam|пароль|kennwort|passwort|mot\s+de\s+passe|l[öo]senord(?:et)?|passord(?:et)?|adgangskoden?|kodeord(?:et)?|salasana(?:ni)?|jelsz[óo]|jelszavam|contrasenya|lozinka|geslo|κωδικ[όο]ς(?:\s+πρόσβασης)?|m[ậa]t\s+kh[ẩa]u|kata\s+sandi|كلمة\s+(?:ال)?(?:مرور|سر)|ה?סיסמ[הא]|पासवर्ड)(?![\p{L}\p{M}])`;
  const INTL_VALUE = String.raw`([^\s"'”’“,;!?»，。、：！？]+)`;
  // One whitespace path when the value isn't quoted; the quote separates the two paths when it is.
  const INTL_TOLD_GAP = String.raw`(?:\s*["'“‘„«]\s*|\s*)`;
  // Bare labels require horizontal whitespace first. The first branch handles a quote after horizontal spaces;
  // otherwise one required space and the remaining whitespace form a single run.
  const INTL_BARE_GAP = String.raw`(?=[^\S\n])(?:[^\S\n]*["'“‘„«]\s*|[^\S\n]\s*)`;
  const TOLD_SECRET_INTL = new RegExp(
    String.raw`(?<![\p{L}\p{M}\d])${PW_WORD_INTL}(?:\s+[\p{L}\p{M}'’]{1,14}){0,3}?(?:\s*[:：=]|\s+(?:è|é|e|és|ist|is|est|är|er|on|je|jest|to|este|είναι|ειναι|là|adalah|ialah|هي|היא|это|—|–|-)(?![\p{L}\p{M}])(?:\s*:)?)${INTL_TOLD_GAP}${INTL_VALUE}`,
    "giu",
  );
  const BARE_SECRET_INTL = new RegExp(
    String.raw`(?<![\p{L}\p{M}\d])${PW_WORD_INTL}(?:\s+(?:saya|ku|của\s+(?:tôi|mình)|الخاصة\s+بي|שלי|μου|mea|mia|mitt|min|ko))?${INTL_BARE_GAP}${INTL_VALUE}`,
    "giu",
  );
  // "Password" borrowed into Italian or Tagalog: "la mia password è …", "ang password ko ay …". English's own
  // "is" is TOLD_SECRET's.
  const TOLD_SECRET_LOANWORD =
    /(?<![\p{L}\d])password(?:\s+[\p{L}'’]{1,14}){0,3}?\s+(?:è|é|ay|là|adalah|este|ist|är)(?![\p{L}])(?:\s*:)?(?:\s*["'“‘„«]\s*|\s*)([^\s"'”’“,;!?»]+)/giu;
  // French "mdp", lower case only, since an "MDP" in a maths or AI question is a Markov decision process.
  const TOLD_SECRET_MDP = /(?<![\p{L}\d])[Mm]dp(?:\s*[:=]|\s+est(?![\p{L}]))(?:\s*["'“‘„«]\s*|\s*)([^\s"'”’“,;!?»]+)/gu;
  // Chinese, Japanese, Korean and Thai join "password" to "is" with no space, and the value ends where their
  // own letters or punctuation start again: "我的密码是…，", "パスワードは…です", "비밀번호는 … 입니다".
  const PW_WORD_CJK = String.raw`(?:密码|密碼|口令|パスワード|暗証番号|비밀번호|암호|รหัสผ่าน)`;
  const CJK_VALUE = String.raw`["'“‘「『]?([^\s"'”’“,;!?»，。、：！？「」『』\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]+)`;
  const TOLD_SECRET_CJK = new RegExp(
    String.raw`${PW_WORD_CJK}(?:ของ(?:ฉัน|ผม))?\s*(?:是|为|為|は|는|은|คือ|[:：=])\s*${CJK_VALUE}`,
    "gu",
  );
  const BARE_SECRET_CJK = new RegExp(String.raw`${PW_WORD_CJK}[^\S\n]+${CJK_VALUE}`, "gu");
  // A password given to a command: curl's -u user:password, sshpass -p, a registry or cloud login's -p, redis-cli's
  // -a, Java keytool's -storepass, Windows' net use after /user:, and aws configure set. Each flag only means a
  // password after its own command, so "docker run -p 8080:80" and "kubectl logs -p" stay quiet.
  const CURL_USER =
    /\bcurl\b(?:[^\n]|\\\r?\n){0,300}?\s(?:-u|--user)(?:=|[^\S\n]*)(?:"([^"\n:]{1,64}):([^"\n]{1,128})"|'([^'\n:]{1,64}):([^'\n]{1,128})'|([^\s"':]{1,64}):([^\s"']{1,128}))/g;
  const COMMAND_PASSWORD = [
    /\bsshpass\s+-p\s*(["']?)([^\s"']+)\1(?=\s|$)/g,
    /\b(?:(?:(?:docker|podman|nerdctl|buildah|skopeo|helm|oras|crane|az|oc|cf|argocd)\b[^\n]{0,60}?\blogin\b|mongo(?:sh|dump|restore|import|export)?\b)[^\n]{0,200}?\s(?:-p|-a|--password|--pass)|redis-cli\b[^\n]{0,200}?\s(?:-a|--password|--pass))(?:=|[^\S\n]+)(["']?)([^\s"'-][^\s"']*)\1(?=\s|$)/g,
    /(?<![\w-])-(?:src|dest)?(?:store|key)pass\s+(["']?)([^\s"']+)\1(?=\s|$)/g,
    /\bnet\s+use\b[^\n]{0,200}?\s\/user:\S+\s+(["']?)([^\s"'/*][^\s"']*)\1(?=\s|$)/gi,
  ];
  const AWS_CONFIGURE_SET =
    /\baws\s+configure\s+set\s+(?:[\w-]+\.)?(?:aws_secret_access_key|aws_session_token|[\w.-]*(?:password|secret)[\w.-]*)\s+(["']?)([^\s"']+)\1/gi;
  // A path handed to -p ("az login … -p ./cert.pem") is a certificate file, not a password.
  const looksLikePath = (v) => /^(?:\.{1,2}[\\/]|~[\\/]|\/)|\.(?:pem|crt|cer|pfx|p12|key|json)$/i.test(v);
  // A secret set by its name in code or config: PHP's define('DB_PASSWORD', '…'), os.environ.setdefault(…),
  // a web page's setItem("token", …), a Terraform variable's default, a .NET <add key="ApiKey" value="…"/> or a
  // hidden form field, and a YAML key whose value starts on the next line ("password: >-"). The name says which
  // kind, a password or a key whose value has to look machine-made. A form's CSRF token is part of the page.
  const SETTING_CALL =
    /\b(?:define|setenv|putenv|setdefault|SetEnvironmentVariable|setItem|setProperty|set|put|add)\s*\(\s*(["'])([\w.-]{1,60})\1\s*,\s*(["'])([^"'\n]{4,256})\3/gi;
  const ATTR_PAIR =
    /<[A-Za-z][\w:.-]*\s[^<>]{0,300}?\b(?:key|name|id)\s*=\s*(["'])([\w.:-]{1,60})\1[^<>]{0,300}?\bvalue\s*=\s*(["'])([^"'\n<>]{4,256})\3/gi;
  const HCL_DEFAULT = /\bvariable\s+"([\w-]{1,60})"\s*\{[^{}]{0,300}?\bdefault\s*=\s*"([^"\n]{4,256})"/g;
  const YAML_BLOCK =
    /(?:^|\n)([^\S\n]*)([\w.-]{1,60})[^\S\n]*:[^\S\n]*[|>][+-]?\d?[^\S\n]*\r?\n([^\S\n]+)([^\s#][^\n]{3,255})/g;
  function settingKind(name) {
    if (/csrf|xsrf|authenticity|nonce|pub(?:lic|lishable)?[_.-]?key/i.test(name)) return null;
    if (/password|passwd|passphrase|pwd|secret|(?:^|[_.-])pass(?:$|[_.-])/i.test(name)) return "password";
    if (LOOKUP_KEY_NAME.test(name)) return null;
    if (/api_?key|token|auth_?key|private_?key|salt|(?:^|[_.-])key$/i.test(name)) return "key";
    return null;
  }
  function namedSettings(text) {
    const out = [];
    const push = (name, value) => {
      const kind = settingKind(name);
      if (kind) out.push({ kind, value });
    };
    for (const re of [SETTING_CALL, ATTR_PAIR]) for (const m of text.matchAll(re)) push(m[2], m[4]);
    for (const m of text.matchAll(HCL_DEFAULT)) push(m[1], m[2]);
    // A PEM key under "private_key: |" is the private key kind's, whole.
    for (const m of text.matchAll(YAML_BLOCK)) {
      if (m[3].length > m[1].length && !m[4].startsWith("-----")) push(m[2], m[4].trim());
    }
    return out;
  }
  // requests' auth=("user", "password") and HTTPBasicAuth("user", "password"), and SQL's IDENTIFIED BY '…'.
  const AUTH_TUPLE =
    /\b(?:auth\s*=\s*|HTTP(?:Basic|Digest)Auth\s*)\(\s*(["'])[^"'\n]{1,64}\1\s*,\s*(["'])([^"'\n]{4,128})\2\s*\)/g;
  const SQL_IDENTIFIED = /\bIDENTIFIED\s+(?:WITH\s+[\w$]+\s+)?BY\s+(?:PASSWORD\s+)?(["'])([^"'\n]{1,128})\1/gi;
  // A CSV or tab-separated paste with a password column, like a browser's or a password manager's export:
  // "name,url,username,password" over its rows. A header cell like "password_changed" names something else, and a
  // row has to have as many cells as the header, so a sentence with commas in it under a list doesn't count.
  const CSV_PASSWORD_HEAD =
    /^(?:[\p{L}\d]{1,20}[ _-])?(?:password|passwd|pwd|pass|passcode|passphrase|contrase(?:ñ|n)a|senha|passwort|kennwort|mot de passe|mdp|wachtwoord|has[łl]o|heslo|lösenord|passord|salasana|пароль|密码|パスワード|비밀번호)$/iu;
  function csvCells(line, separator) {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && !cell.trim()) {
        quoted = true;
        cell = "";
      } else if (c === separator) {
        cells.push(cell.trim());
        cell = "";
      } else cell += c;
    }
    cells.push(cell.trim());
    return cells;
  }
  function csvPasswords(text) {
    if (
      !/[,;\t]/.test(text) ||
      !/pass|pwd|mdp|contrase|senha|kennwort|wachtwoord|has[łl]o|heslo|lösenord|salasana|пароль|密码|パスワード|비밀번호/i.test(
        text,
      )
    ) {
      return [];
    }
    const lines = text.split(/\r?\n/);
    const values = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      const line = lines[i];
      const counts = ["\t", ";", ","].map((s) => line.split(s).length - 1);
      const separator = counts[0] ? "\t" : counts[1] > counts[2] ? ";" : counts[2] ? "," : "";
      if (!separator) continue;
      const head = csvCells(line, separator);
      const column = head.findIndex((c) => CSV_PASSWORD_HEAD.test(c));
      if (column < 0 || head.some((c) => c.length > 32)) continue;
      let j = i + 1;
      for (; j < lines.length; j++) {
        // A rich chat box reads each pasted line back as its own paragraph, with a blank line between rows.
        if (!lines[j].trim()) continue;
        const row = csvCells(lines[j], separator);
        if (row.length !== head.length) break;
        if (row[column] && !/\s/.test(row[column])) values.push(row[column]);
      }
      i = j - 1; // each row is read once, under the nearest header above it
    }
    return values;
  }
  const LOGIN_THEN_SECRET =
    /\b(?:log-?in|user(?:\s*name)?)\s+(?:is\s+)?["']?[^\s"']{2,64}["']?(?:\s*,\s*|\s+)(?:and\s+)?(?:it['’]s|it\s+is|the\s+password\s+is|password\s+is)\s+["'“‘]?([^\s"'”’,;!?]+)/gi;
  const USE_AS_SECRET = new RegExp(
    String.raw`(?<![\p{L}\d])(?:use|using|try|enter)\s+["'“‘]?([^\s"'”’]{4,64})["'”’]?\s+as\s+(?:the|my|your|a|our)\s+(?:new\s+)?${PW_WORD}(?![\p{L}]|\s+(?:manager|reset|hint|field|box|generator|vault|app|policy|rule|requirement)s?(?![\p{L}]))`,
    "giu",
  );
  const USER_PASS = /\b(?:user(?:name)?|login)\s+[^\s:=]{2,64}\s+(?:pass|pw|pwd)\s+["']?([^\s"',;]+)/gi;
  const MYSQL_FLAG =
    /\b(?:mysql(?:dump|admin|import|show|check)?|mariadb(?:-dump)?)\b[^\n]{0,200}?\s-p(["']?)([^\s"']+)\1(?=\s|$)/g;
  const XML_SECRET = /<(password|passwd|pwd|secret)>([^<>\s]{4,128})<\/\1>/gi;
  const PASSWORD_BOX =
    /<input\b(?=[^>]{0,300}\btype\s*=\s*["']?password\b)[^>]{0,300}?\bvalue\s*=\s*(["'])([^"'\n]{4,128})\1/gi;
  const SECURE_STRING = /\bConvertTo-SecureString\s+(?:-String\s+)?(["'])([^"'\n]{4,128})\1\s+-AsPlainText\b/gi;
  // A Markdown table with a password column, as in "| user | password |" over "| bob | Tr0ub4dor&3x |". A column
  // of yes and no answers stays quiet, since a cell has to look like a password.
  const TABLE_PASSWORD_HEAD = /^(?:password|passwd|pwd|pass|passcode|contrase(?:ñ|n)a|clave|passwort|mot de passe)$/i;
  function tablePasswords(text) {
    if (!/\|/.test(text) || !/\|[^\S\n]*(?:pass|pwd|contrase|clave|mot de passe)/i.test(text)) return [];
    const cells = (line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
    const lines = text.split("\n");
    const values = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!lines[i].includes("|") || !/^[\s|:-]*-{3,}[\s|:-]*$/.test(lines[i + 1])) continue;
      const column = cells(lines[i]).findIndex((c) => TABLE_PASSWORD_HEAD.test(c));
      if (column < 0) continue;
      let j = i + 2;
      for (; j < lines.length && lines[j].includes("|"); j++) {
        const cell = cells(lines[j])[column];
        if (cell) values.push(cell);
      }
      i = j - 1; // each row is read once, under the nearest header above it
    }
    return values;
  }
  // "login: jdoe@gmail.com / Fluffy!23": a login shared as a pair.
  const LOGIN_PAIR =
    /\b(?:login|log-?in|sign[- ]?in|credentials|creds)\b[^\n]{0,20}?\s["'“‘]?[^\s/|"']{3,64}\s*[/|]\s*["'“‘]?([^\s"'”’,;/]{4,64})(?![^\s"'”’,;])/gi; // a "/" means a path, not a password
  // Codes that open a home, a card or a phone, as in "the gate code is 1234" or "the safe combination is
  // 12-34-56". Unrelated codes like a zip code or an error code stay quiet.
  const CODE_TOLD =
    /\b(?:(?:gate|alarm|garage|door|lock\s*box|locker|lock|keypad|safe|building|entry|house|atm|debit(?:\s+card)?|credit\s+card|card|phone|iphone|bank)\s+(?:code|combination|combo|passcode|pin)|passcode|combination|pin(?=\s+(?:number|code|#))|my\s+pin)(?:\s+(?:number|code))?(?:\s+(?:to|for|on|of)\s+(?:my|the|our|his|her)\s+[\p{L}-]+)?\s*(?:(?:is|was|:|=)\s*)?["'“‘]?(\d{3,10}#?|\d{1,3}(?:-\d{1,3}){2,3}|\d{1,2}(?: \d{1,2}){2,3})(?![\d-]| \d)/giu;
  // Sign-in codes sent by text or email, as in "the verification code they texted me is 482913", which is
  // what a scam caller is after. Error codes, zip codes and a plain "sent the code" stay quiet.
  // The code itself is 4 to 8 digits, or two groups of 3 like WhatsApp's "482-913". It's never a year,
  // never part of a longer number, and never a size, so "my code is 3000 lines long" doesn't match.
  const SIGN_IN_VALUE = String.raw`["'“‘]?(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)(?!\s+(?:lines?|characters?|chars|bytes?|words?|pages?|rows?|times|errors?|l[ií]neas|caracteres|palabras|p[aá]ginas|filas|veces|errores)(?![\p{L}]))`;
  const IS = String.raw`\s*(?:(?:is|was)\s*)?(?:[:=,]\s*)?`;
  const IS_SAID = String.raw`\s*(?:(?:is|was)(?![\p{L}])\s*(?:[:=]\s*)?|[:=]\s*)`;
  // The words that mark a code as a sign-in code, and the apps whose codes scammers ask for most, as in
  // "G-482913 is your Google verification code".
  const SIGN_IN_WORD = String.raw`(?:verification|one[- ]time|login|log-?in|sign[- ]?in|two[- ]factor|2fa|mfa|otp|authentication|auth|access|sms)`;
  const SIGN_IN_APP = String.raw`(?:whats\s?app|telegram|signal|google|gmail|facebook|instagram|tiktok|snapchat|uber|lyft|paypal|venmo|zelle|cash\s?app|coinbase|microsoft|outlook|yahoo|netflix)`;
  const DIGITS_LONG = String.raw`(?:(?:\d|four|six|eight)[- ]digit\s+)?`;
  const SIGN_IN_NAME = String.raw`${DIGITS_LONG}(?:${SIGN_IN_APP}\s+)?(?:${SIGN_IN_WORD}\s+)?`;
  const SIGN_IN_NAMED = String.raw`${DIGITS_LONG}(?:${SIGN_IN_APP}\s+(?:${SIGN_IN_WORD}\s+)?|${SIGN_IN_WORD}\s+)`;
  // Rules out a code that isn't a sign-in code, named right before the word "code", as in "the tracking
  // code they sent me" or "asked for the zip code".
  const NOT_SIGN_IN = String.raw`(?<!(?<![\p{L}])(?:error|zip|postal|area|status|exit|promo|promotional|discount|coupon|voucher|referral|invite|invitation|tracking|order|booking|reference|product|item|gift|source|dress|country|bar|qr|tax|billing|diagnosis|diagnostic|medical|course|class|style|colou?r|sku|post|cheat|redeem|redemption|rewards?)[\s-]+)`;
  // Who sent the code and how, as in "the code they texted me" or "the code that came to my phone".
  const SENT_TO_ME = String.raw`(?:(?:that|which)\s+)?(?:(?:they|he|she|someone|it|you|the\s+bank|i|we)\s+(?:just\s+)?(?:texted|sent|messaged|emailed|gave|got|received|was\s+sent|were\s+sent)|(?:just\s+)?(?:came|arrived|was\s+sent|were\s+sent))(?:\s+(?:to\s+)?(?:me|us|him|her|you))?(?:\s+(?:by|via|in|on|over|through|to)\s+(?:(?:a|an|the|my|your|his|her|our)\s+)?(?:text(?:\s+message)?|sms|e-?mail|message|phone|cell(?:\s?phone)?|mobile|whats\s?app))?`;
  // The value a rule with one group per way of saying it took.
  const matched = (m) => m.slice(1).find((v) => v !== undefined);
  // A code for a door or a gate isn't a sign-in code: "4821 is my code for the gate".
  const NOT_FOR_A_DOOR = String.raw`(?!\s+(?:for|to|on|of)\s+(?:the|my|our|his|her|their|your)\s+(?:front\s+|back\s+|garage\s+)?(?:gate|door|alarm|garage|lock(?:box|er)?|safe|building|house|keypad|atm|card|phone))`;
  // After a code is told without a name for it, the sentence either ends or says where the code came from,
  // as in "I got the code 482913 by text". Something like "I got the code 1500 from the tutorial" doesn't
  // match, since it doesn't end that way.
  const CODE_ENDS = String.raw`(?=\s*(?:$|[\n.,;:!?)"'”’]|(?:by|via|in|on|over|and|but|so|what|which|is|was|from\s+(?:the\s+|my\s+)?(?:bank|${SIGN_IN_APP}))(?![\p{L}])))`;
  // After a code's name that comes second, the name ends there: "12345 is my code name" is something else.
  const NAME_ENDS = String.raw`(?=\s*(?:$|[\n.,;:!?)"'”’]|(?:they|he|she|someone|it|that|which|i|we|you|from|for|to|by|via|in|on|and|but|so|sent|texted|just)(?![\p{L}])))`;
  // A number named as something else isn't a code before its name: "error 4821 - that's the code", "port 8080".
  const NOT_A_NUMBER_OF = String.raw`(?<!(?<![\p{L}])(?:error|status|exit|code|port|line|page|room|step|version|model|order|ticket|case)\s+)`;
  // The label: a sign-in code's own names, plus any phrase for a code someone sent, like "the code they
  // texted me".
  const LOGIN_NAMES = String.raw`(?:verification|one[- ]time|login|log-?in|sign[- ]?in|two[- ]factor|authentication|auth|access|sms)\s+(?:code|pin|passcode)|(?:otp|2fa|mfa)(?:\s+(?:code|pin))?`;
  const CODE_THEY_SENT = String.raw`${NOT_SIGN_IN}(?<![\p{L}])(?:pass)?code\s+${SENT_TO_ME}`;
  // The rest of the sentence names a door or a gate: "the code 4821 they gave you for the gate".
  const NOT_AT_A_DOOR = String.raw`(?![^\n.!?]{0,40}?(?<![\p{L}])(?:gate|door|alarm|garage|lock\s*box|locker|safe|building|house|keypad)(?![\p{L}]))`;
  const LOGIN_CODE = new RegExp(
    String.raw`(?<![\p{L}\d])(?:${LOGIN_NAMES})(?![\p{L}])[^\n\d]{0,30}?(?:\b(?:is|was)\b)?\s*(?:[:=]\s*)?["'“‘]?(?<!(?<![\p{L}])(?:in|since|by|from|of|until|before|after|at|to|about|around|every)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)|(?<![\p{L}])(?:(?:texted|sent|messaged|emailed|gave)\s+(?:me|us|him|her)\s+(?:(?:the|a|that|this|my)\s+)?|ask(?:ed|ing|s)?\s+(?:me\s+)?for\s+(?:the|my|a|that)\s+)(?:\p{L}+\s+)?${NOT_SIGN_IN}code\s*(?:(?:is|was)\s*)?(?:[:=]\s*)?["'“‘]?(?<!(?<![\p{L}])(?:in|since|by|from|of|until|before|after|at|to|about|around|every)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)` +
      // "the code they texted me is 482913", "the passcode I got by text: 482913"
      String.raw`|${CODE_THEY_SENT}${IS}${SIGN_IN_VALUE}` +
      // "enter the code 482913 we texted you", "the verification code 482913 they sent you by text"
      String.raw`|(?<![\p{L}])(?:the|this|that|a)\s+(?:${SIGN_IN_WORD}\s+)?(?:pass)?code\s+${SIGN_IN_VALUE}${NOT_AT_A_DOOR}\s+${SENT_TO_ME}` +
      // "the code from the text is 482913", "the code in the email: 482913"
      String.raw`|${NOT_SIGN_IN}(?<![\p{L}])(?:pass)?code\s+(?:in|from|on)\s+(?:the|that|this|my|your|their|a|an)\s+(?:text(?:\s+message)?|sms|e-?mail|message|texts)\s*(?:(?:is|was|says|said|reads)\s*)?(?:[:=,]\s*)?${SIGN_IN_VALUE}` +
      // "I got a text with the code 482913", "I received a code 482913", "my code is 482913", "Your WhatsApp code: 482-913"
      String.raw`|(?<![\p{L}])(?:(?:text|sms|message|e-?mail)\s+with|got|received|get|getting)\s+(?:a|an|the|this|that|my)\s+(?:new\s+)?${SIGN_IN_NAME}(?:pass)?code${IS}${SIGN_IN_VALUE}${CODE_ENDS}` +
      String.raw`|(?<![\p{L}])(?:my\s+(?:pass)?code|${SIGN_IN_APP}\s+(?:${SIGN_IN_WORD}\s+)?(?:pass)?code)${IS_SAID}${SIGN_IN_VALUE}` +
      // The code before its name: "texted me 482913 as a verification code", "482913 is my code", "482913 - that's the
      // code they sent me", "G-482913 is your Google verification code"
      String.raw`|(?<![\p{L}])(?:texted|sent|messaged|emailed|gave|got|received)\s+(?:(?:me|us)\s+)?${SIGN_IN_VALUE}\s+as\s+(?:a|an|the|my|our|your)\s+${SIGN_IN_NAME}(?:pass)?code(?![\p{L}])${NOT_FOR_A_DOOR}${NAME_ENDS}` +
      String.raw`|(?<!\d[-./\s])${NOT_A_NUMBER_OF}${SIGN_IN_VALUE}\s*(?:[,:–—-]\s*)?(?:is|was|that['’]?s|that\s+is|that\s+was|it['’]?s)\s+(?:my\s+${SIGN_IN_NAME}(?:pass)?code|(?:the|your)\s+${SIGN_IN_NAMED}(?:pass)?code|the\s+(?:pass)?code\s+${SENT_TO_ME})(?![\p{L}])${NOT_FOR_A_DOOR}${NAME_ENDS}`,
    "giu",
  );
  // Spanish, matching the same kinds of phrases: "el código de verificación es 482913", "me mandaron un
  // código por SMS: 552019", and the code coming before its name, as in "482913 es mi código".
  const ES_SENT = String.raw`(?:(?:mand|envi|pas)(?:aron|[oó]|aste)|dieron|di[oó]|pidieron|pidi[oó]|lleg[oó]|(?:ha|han)\s+(?:mandado|enviado|pasado|dado|pedido|llegado)|acaban?\s+de\s+(?:mandar|enviar|pasar|llegar)|est[aá]n?\s+pidiendo|piden|pide)`;
  const ES_SIGN_IN = String.raw`(?:de\s+(?:verificaci[oó]n|acceso|un\s+solo\s+uso|inicio\s+de\s+sesi[oó]n)|sms|otp|din[aá]mica)`;
  // What can follow the code's name, like "de un solo uso" or "por SMS", while ruling out words that mark
  // it as a different kind of code, like "de seguimiento" or "de la puerta".
  const ES_NOT_SIGN_IN = String.raw`(?:puerta|portal|alarma|garaje|edificio|casa|caja|cajero|tarjeta|seguimiento|descuento|promoci[oó]n|cup[oó]n|pedido|reserva|producto|referencia|error|regalo|canje|barras|[aá]rea|fuente|cliente|la|el|los|las|un|una)`;
  const ES_MORE = String.raw`(?:sms|otp|de\s+un\s+solo\s+uso|de\s+(?:\d|cuatro|seis|ocho)\s+d[ií]gitos|(?:de|del|por|para|al|en)\s+(?:(?:la|el|mi|tu|su)\s+)?(?!${ES_NOT_SIGN_IN}(?![\p{L}]))\p{L}+)`;
  const ES_VALUE = String.raw`\s*(?:(?:es|era)(?![\p{L}])\s*)?(?::\s*)?["'“‘]?(?<!(?<![\p{L}])(?:en|desde|hasta|de|del|a|al|antes|despu[eé]s|por|para|cada)\s+)${SIGN_IN_VALUE}`;
  // The label, as for English: the code's names, and a code someone sent.
  const LOGIN_LABEL_ES =
    // "el código de verificación (que me llegó) es …", "clave de acceso de un solo uso …", "la contraseña de un solo uso"
    String.raw`(?:(?:c[oó]digo|clave|pin)\s+${ES_SIGN_IN}|contrase(?:ñ|n)a\s+(?:de\s+un\s+solo\s+uso|sms|otp|din[aá]mica))(?![\p{L}])(?:\s+${ES_MORE}){0,2}(?:\s+que\s+(?:me|nos)\s+${ES_SENT}(?:\s+(?:el|la|mi)\s+\p{L}+)?)?(?:\s+${ES_MORE}){0,2}` +
    // "el código (de WhatsApp) que me llegó (por SMS) es …"
    String.raw`|c[oó]digo(?:\s+${ES_MORE}){0,2}\s+que\s+(?:me|nos)\s+${ES_SENT}(?:\s+(?:el|la|mi)\s+\p{L}+)?(?:\s+${ES_MORE}){0,2}` +
    // "me mandó un código por SMS: …", "me están pidiendo el código …", "un SMS con el código …"
    String.raw`|(?:(?:me|nos)\s+${ES_SENT}|pidieron|piden|(?:sms|mensaje|correo|e-?mail|texto|whats\s?app)\s+con)\s+(?:el|un|mi|ese|este|su)\s+c[oó]digo(?:\s+${ES_MORE}){0,2}` +
    // "el código del SMS es …", "el código de WhatsApp: …"
    String.raw`|c[oó]digo\s+(?:del\s+(?:sms|mensaje(?:\s+de\s+texto)?|correo|e-?mail|texto)|de\s+${SIGN_IN_APP})`;
  const LOGIN_CODE_ES = new RegExp(
    // …and "mi código es …"
    String.raw`(?<![\p{L}\d])(?:${LOGIN_LABEL_ES}|mi\s+c[oó]digo(?=\s*(?:(?:es|era)(?![\p{L}])|:)))(?![\p{L}])${ES_VALUE}` +
      // The code before its name: "482913 es mi código", "482913 es el código que me mandaron", "me mandaron 482913
      // como código de verificación"
      String.raw`|(?<!\d[-./\s])${SIGN_IN_VALUE}\s*(?:,\s*)?(?:es|era)\s+(?:mi\s+c[oó]digo(?:\s+${ES_SIGN_IN})?(?![\p{L}])(?!\s+(?:postal|de|del|para|fuente|en)(?![\p{L}]))|el\s+c[oó]digo\s+(?:${ES_SIGN_IN}|que\s+(?:me|nos)\s+${ES_SENT})(?![\p{L}]))` +
      String.raw`|(?<![\p{L}])(?:me|nos)\s+${ES_SENT}\s+${SIGN_IN_VALUE}\s+como\s+(?:c[oó]digo|clave)(?:\s+${ES_SIGN_IN})?(?![\p{L}])`,
    "giu",
  );
  // A card's security code, said the way people say it, or a remote-access code like "the AnyDesk code is
  // 123 456 789" from a fake support call. This covers both the code's own names, like "CVV", and how a
  // scam caller describes where it sits, like "the 3 numbers on the back". It's just the label; cardCodeAt()
  // below reads the actual code after it. "CSC" and "CV2" only count before "is" or a colon, since alone
  // they're also a course code and a code library, and "the numbers on the back" only counts for a card.
  const ON_A_CARD = String.raw`(?:\s+(?:side\s+)?of\s+(?:the|my|your|his|her|their|our|this|that|a)\s+(?:(?:credit|debit|bank)\s+)?(?:card|amex|visa|mastercard)|\s+de\s+(?:la|mi|tu|su|esta|esa)\s+tarjeta(?:\s+de\s+(?:cr[eé]dito|d[eé]bito))?)?`;
  const ON_BACK = String.raw`(?:(?:on|at|from|in)\s+(?:the\s+)?(?:back|reverse)(?:\s+side)?|behind\s+(?:the|my|your|his|her|their|our)\s+(?:(?:credit|debit|bank)\s+)?card)`;
  const ON_FRONT = String.raw`(?:on|at|from|in)\s+(?:the\s+)?front(?:\s+side)?`;
  const DETRAS = String.raw`(?:(?:que\s+(?:est[aá]n?|vienen?|salen?|hay)\s+)?(?:(?:de|en|por|a)\s+)?(?:la\s+parte\s+(?:de\s+)?)?(?:atr[aá]s|detr[aá]s)|(?:de|en)\s+la\s+parte\s+trasera|(?:del|en\s+el|al|por\s+el)\s+(?:reverso|dorso))`;
  const DELANTE = String.raw`(?:(?:de|en|por)\s+(?:la\s+parte\s+(?:de\s+)?)?(?:delante|adelante|delantera)|(?:del|en\s+el|al)\s+frente)`;
  const THE = String.raw`(?:the|my|your|his|her|their|our|those|these)\s+`;
  const NUMBERS = String.raw`(?:numbers?|digits?|nums?|numerals?|code)`;
  const LOS = String.raw`(?:los|las|mis|tus|sus|el|mi|tu|su)\s+`;
  const NUMEROS = String.raw`(?:n[uú]meros?|d[ií]gitos?|numeritos|c[oó]digo)`;
  const CARD_LABEL =
    String.raw`(?:` +
    // its names, and where it is: "the CVV on the back of my card", "el código de seguridad de atrás"
    String.raw`(?:cvv2?|cvc2?|ccv|(?:csc|cv2)(?=\s*(?:code\s*|number\s*)?(?:is|was|:|=))|card\s+verification\s+(?:value|code|number)|security\s+code|c[oó]digo\s+de\s+seguridad)` +
    String.raw`(?:\s+(?:code|number|c[oó]digo|n[uú]mero))?(?:\s+(?:${ON_BACK}|${DETRAS}))?${ON_A_CARD}` +
    // "the (last) 3 numbers on the back (of my card)", "3 digit code on the back", and an Amex's 4 on the front
    String.raw`|(?:${THE}(?:last\s+)?(?:(?:3|three|4|four)[\s-]+(?:digit\s+)?)?|(?:3|three|4|four)[\s-]+(?:digit\s+)?)${NUMBERS}\s+${ON_BACK}${ON_A_CARD}` +
    String.raw`|(?:${THE})?(?:4|four)[\s-]+(?:digit\s+)?${NUMBERS}\s+${ON_FRONT}${ON_A_CARD}` +
    // "(on) the back of my card (it) says"
    String.raw`|(?:on\s+)?(?:the\s+)?(?:back|reverse)(?:\s+side)?\s+of\s+(?:the|my|your|his|her|their|our)\s+(?:(?:credit|debit|bank)\s+)?card(?:,?\s+it)?` +
    // Spanish: "los 3 números de atrás (de la tarjeta)", "los 4 números del frente", "la parte de atrás de mi tarjeta"
    String.raw`|(?:${LOS}(?:(?:3|tres|4|cuatro)\s+)?(?:[uú]ltimos\s+)?|(?:3|tres|4|cuatro)\s+)${NUMEROS}\s+${DETRAS}${ON_A_CARD}` +
    String.raw`|(?:${LOS})?(?:4|cuatro)\s+${NUMEROS}\s+${DELANTE}${ON_A_CARD}` +
    String.raw`|(?:la\s+parte\s+(?:de\s+)?(?:atr[aá]s|detr[aá]s)|la\s+parte\s+trasera|el\s+reverso|el\s+dorso)\s+de\s+(?:la|mi|tu|su)\s+tarjeta` +
    String.raw`)`;
  const CARD_CODE = new RegExp(
    String.raw`(?<![\p{L}\d])${CARD_LABEL}["']?\s*(?:(?:is|are|was|were|reads|says|shows|es|son|era|eran|dice|dicen|pone|ponen)(?![\p{L}])|[:=#])?\s*["']?`,
    "giu",
  );
  // Reads the code right after that label, however it's typed: plain digits, spaced-out digits, or spelled
  // out like "four eight two". It has to be three or four digits that end there, so "12/27" reads as an
  // expiry date and "4111 1111 …" as a card number, not a security code. A phrase like "3 or 4 digits" is
  // describing a code rather than giving one, and digits running into letters belong to a longer code.
  const CODE_DIGITS = /^(?:\d{3,4}|\d(?: \d){2,3})(?![\d/\p{L}-]|[^\S\n]+\d)/u;
  const CODE_GAP = /^(?:[^\S\n]|[,-]){0,3}$/;
  const CODE_SIZE =
    /^[^\S\n]*(?:digits?|numbers?|characters?|long|d[ií]gitos?|n[uú]meros?|cifras?|caracteres)(?![\p{L}])/iu;
  function cardCodeAt(text, at) {
    const rest = text.slice(at, at + 60);
    let end = CODE_DIGITS.exec(rest)?.[0].length;
    if (!end) {
      // Only bothers with this slower path when the text starts like a number, so a label followed by
      // unrelated words costs nothing extra.
      UNIT_RE.lastIndex = 0;
      if (!UNIT_RE.test(rest) && !(isLetter(rest[0]) && readSlip(rest, 0))) return null;
      const units = readNumberRuns(rest, true)[0]?.units;
      if (!units || units[0].start !== 0 || !units.some((u) => u.isWord)) return null;
      if (units.some((u, k) => k && !CODE_GAP.test(rest.slice(units[k - 1].end, u.start)))) return null;
      const size = units.reduce((n, u) => n + u.digits.length, 0);
      end = lastItem(units).end;
      if (size < 3 || size > 4 || (end === rest.length && at + end < text.length)) return null;
    }
    return CODE_SIZE.test(rest.slice(end)) ? null : rest.slice(0, end);
  }
  // Spanish, matching the same kind of phrase: "el código de AnyDesk es 123 456 789".
  // A remote-access app's name, in English and in Spanish.
  const REMOTE_WORDS = String.raw`any\s*desk|team\s*viewer|remote\s+(?:access|support|desktop)|quick\s*assist|ultra\s*viewer|rust\s*desk`;
  const REMOTE_WORDS_ES = String.raw`any\s*desk|team\s*viewer|acceso\s+remoto`;
  const CODE_TOLD_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:c[oó]digo|clave|id|pin)\s+(?:de\s+la|del|de)\s+(?:${REMOTE_WORDS_ES}|puerta|portal|alarma|garaje|caja\s+fuerte|edificio|casa|cajero|tarjeta)\s*(?:(?:es|era|:)\s*)?["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{3,10}#?)(?![\d-])`,
    "giu",
  );
  const REMOTE_CODE = new RegExp(
    String.raw`\b(?:${REMOTE_WORDS})(?:\s+(?:id|code|number|address|password|pin))?\s*(?:(?:is|:|=)\s*)?["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{6,10})(?![\d-])`,
    "gi",
  );
  // Two-factor backup codes and recovery keys, as in "backup codes are 1234 5678, 2345 6789". Reads
  // everything after the label as one list of codes, and requires a digit somewhere in it, so a sentence
  // like "…is lost" doesn't count as a code.
  const RECOVERY_LABEL = String.raw`(?:backup|recovery|2fa|two[- ]factor|mfa)\s+(?:codes?|keys?)|(?:c[oó]digos?|claves?)\s+de\s+(?:respaldo|recuperaci[oó]n)`;
  const RECOVERY_CODES = new RegExp(
    String.raw`(?<![\p{L}])(?:${RECOVERY_LABEL})(?![\p{L}])(?:\s+(?:are|is|was|were|es|son|era|eran))?\s*(?::\s*)?((?:[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8}){0,7}(?:\s*[,;]\s*|\s+|$)){1,16})`,
    "giu",
  );

  // ---------- A downloaded two-step backup-code file ----------
  // Google's ten 8-digit codes (printed two to a line) or GitHub's github-recovery-codes.txt (a short
  // letters-and-digits code per line) aren't read out after a label like "backup codes are 1234…" above; they're
  // saved as their own file, so the label is somewhere in the file instead (a title line), not right next to the
  // grid. A plain list of 8-digit numbers alone is too common a shape (order numbers, part numbers) to flag on
  // its own, so this still needs the same backup/recovery/2FA wording to appear anywhere in the text.
  const RECOVERY_WORD = new RegExp(RECOVERY_LABEL, "iu");
  const BACKUP_CODE =
    /^[ \t]*([0-9]{8}|(?=[A-Za-z0-9]{6,10}$)(?=[^0-9]*[0-9])(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9]{6,10})(?:[ \t]+([0-9]{8}|(?=[A-Za-z0-9]{6,10}$)(?=[^0-9]*[0-9])(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9]{6,10}))?[ \t]*$/;
  // `labelled`: true when that wording sits outside `text`, a window of a large paste, as for findSeedPhrases.
  function findBackupCodes(text, _reasons, labelled) {
    if (!labelled && !RECOVERY_WORD.test(text)) return [];
    const found = [];
    let runStart = -1;
    let runEnd = -1;
    let codeCount = 0;
    const closeRun = () => {
      if (codeCount >= 8) found.push(text.slice(runStart, runEnd));
      runStart = -1;
      codeCount = 0;
    };
    for (const m of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
      const line = m[0].replace(/\r?\n$/, "");
      if (!line.trim()) continue; // a blank line doesn't break a run, or extend one
      const cm = BACKUP_CODE.exec(line);
      if (!cm) {
        closeRun();
        continue;
      }
      if (runStart < 0) runStart = m.index;
      runEnd = m.index + line.length;
      codeCount += cm[2] ? 2 : 1;
    }
    closeRun();
    return found;
  }

  // A session cookie from a pasted request, like "Cookie: sessionid=…". Whoever has one is logged in as
  // you, so this only matches cookies named like a session or login with a long, random-looking value.
  const SESSION_COOKIE =
    /(?<![\w.-])((?:__(?:Secure|Host)-)?(?:next-auth\.session-token|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|laravel_session|[\w.-]*sess(?:ion)?(?:[_-]?(?:id|token|key))?|sid|ssid|auth(?:[_-]?token)?|access[_-]?token|refresh[_-]?token|remember[_-]?(?:me|token)|login[_-]?token))=([^\s;,"']{16,4096})/gi;
  // Covers a case like "my password is my dog's name Rex2019", where the word right after "is" isn't the
  // password. The first password-looking word shortly after, meaning letters mixed with digits or symbols,
  // is treated as the real one.
  const LATER_SECRET = /(?<![\p{L}\d])(?=[^\s]*\p{L})(?=[^\s]*[\d!@#$%^&*])[^\s"'”’,;]{4,64}/u;
  // A passphrase is 3 to 6 plain words that end the sentence, as in "the wifi password is purple monkey
  // dishwasher." Everyday words like "the" or "required" mean it's really a sentence about the password,
  // not the password itself.
  const PASSPHRASE = /^\s*["'“‘]?(\p{L}{3,12}(?:[\s-]+\p{L}{3,12}){2,5})(?=["'”’]?\s*(?:$|[.!?,;\n]))/u;
  const EVERYDAY_WORDS = new Set(
    (
      "the an this that these those here there what where which who how click link " +
      "and or but to of in on for with at by from is are was were be been it you we they he she my your our " +
      "his her their not no too very so just really can will would should have has had do does did when then than because if all " +
      "any some every since working work letters numbers characters long short hard easy remember change reset yesterday today " +
      "tomorrow morning night login account email required before after again enough now still though anyway " +
      "y o pero de del en con por para es son era fue mi tu su muy también cuando porque todos todas cada"
    ).split(" "),
  );
  // Words that describe a password rather than being one.
  const NOT_A_SECRET = new Set(
    (
      "required incorrect wrong invalid expired weak strong short long too not the a an " +
      "being changed reset forgotten lost correct same different case sensitive saved stored empty blank missing " +
      "needed optional hidden secure safe new old mine yours here there this that what where " +
      "printed written taped stuck kept shown listed fine okay working broken locked " +
      "separate expiring expires expired temporary unique complicated complex simple easy hard personal " +
      "case-sensitive case-insensitive auto-generated autogenerated one-time single-use use only sensible " +
      "incorrecta correcta segura nueva vieja débil fuerte larga corta mía tuya igual distinta obligatoria la el una muy"
    ).split(" "),
  );

  // Cleans up a value told after a secret's label, stripping trailing punctuation, and returns null for
  // anything that isn't really a secret: too short or long, a word describing the secret rather than being
  // it, masked out, a placeholder, code reading the value from elsewhere, too plain when complexity is
  // required, or a value some other pattern already recognizes as its own kind of key.
  // Most labeled values past 128 characters are something other than a secret, but an AWS session token runs to
  // several hundred, and Google, Facebook and Dropbox access tokens are well past 128 too. One unbroken run of token
  // characters with letters and digits in it still counts, up to a size no token reaches.
  const longToken = (v) =>
    v.length <= 4096 && /^[\w+/=.~:%-]+$/.test(v) && !v.includes("://") && /\d/.test(v) && /[A-Za-z]/.test(v);
  let secretValuePatterns = null;
  function matchesSecretPattern(value) {
    if (!secretValuePatterns) {
      secretValuePatterns = PATTERNS.filter((pattern) => pattern.secret && pattern.regex).map(
        (pattern) => new RegExp(pattern.regex.source),
      );
    }
    return secretValuePatterns.some((pattern) => pattern.test(value));
  }
  // Trailing dots and closing brackets end a sentence or an aside, but a bracket that closes one the value opened is
  // part of it: "Hello(World)", "Pass[word]".
  const OPENER = { ")": "(", "]": "[", "}": "{", ">": "<" };
  function trimValueEnd(raw) {
    let end = raw.length;
    while (end > 0 && /[.)\]}>]/.test(raw[end - 1])) {
      const opener = OPENER[raw[end - 1]];
      if (opener) {
        const head = raw.slice(0, end - 1);
        if (head.split(opener).length > head.split(raw[end - 1]).length) break;
      }
      end--;
    }
    return raw.slice(0, end);
  }
  function secretValue(raw, needsComplexity, minLength = 4) {
    const v = trimValueEnd(raw);
    if (v.length < minLength || (v.length > 128 && !longToken(v)) || NOT_A_SECRET.has(v.toLowerCase())) return null;
    if (/^[*•x.#-]+$/i.test(v) || /^[<{$[%(]/.test(v) || isPlaceholder(v)) return null; // masked, template, placeholder
    // Code that reads the secret from somewhere else: process.env.X, os.environ[…], config.x.
    if (
      /^(?:process\.env|os\.environ|os\.getenv|import\.meta\.env|env|config|settings|secrets|vars|ENV|request|req|params|args|form|input|self|this|getpass|prompt)\b[.[(]/.test(
        v,
      )
    ) {
      return null;
    }
    // Code that continues on the next token or calls with nothing in the brackets: request.form['…'], getpass(),
    // Field(...).
    if (/[[(]$|\((?:\.\.\.|…)?\)$/.test(v)) return null;
    // A call whose name reads as code, like generate_token(32) or crypto.randomBytes(16), computes the secret.
    const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(.*\)$/.exec(v);
    if (call && /[._]|[a-z][A-Z]/.test(call[1])) return null;
    // PowerShell building or asking for the secret: the value is what comes after the cmdlet, if anything.
    if (/^(?:ConvertTo-SecureString|ConvertFrom-SecureString|Read-Host|Get-Credential|Get-Secret)$/i.test(v)) {
      return null;
    }
    // End-of-sentence punctuation isn't part of a password, so "a good password manager?" reads as a question.
    const core = v.replace(/[?!:]+$/, "");
    // Needs to look like a real password: a digit, a symbol, or mixed case. An accented letter still
    // counts as a letter, and a leading "¿" or "¡" means it's actually a Spanish question.
    if (
      needsComplexity &&
      (/^[¿¡]/.test(core) ||
        !(/\d/.test(core) || /[^\p{L}\p{N}]/u.test(core) || (/\p{Ll}/u.test(core) && /\p{Lu}/u.test(core))))
    ) {
      return null;
    }
    // A recognizable key after the label is reported by its own pattern.
    if (matchesSecretPattern(v)) return null;
    return v;
  }

  // The value patterns stop at punctuation that usually ends a sentence or a setting, but a password can hold the
  // same marks, like "Tr0ub4dor&3x!Qz" or "Blue,Sky42x", and Cover it once left their tails behind. This reads a
  // value on to the end of its word when more of it follows the mark. A comma or semicolon that starts the next
  // setting (";Trusted_Connection=…") still ends it, and so does a contraction ("it's"). A quoted value runs to its
  // closing quote, spaces and all, unless it reads like a sentence. A word broken after a hyphen at the end of a
  // line, the way a mail app or a narrow window wraps, carries on with the next line when that line is one word.
  const VALUE_STOP = /[,;!?'"”’]/u;
  const QUOTE_CLOSE = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  const CONTRACTION = /^['’](?:s|t|re|ve|ll|d|m)(?![\p{L}\d])/iu;
  const NEXT_SETTING = /[,;][A-Za-z_][\w.-]{0,40}\s*[=:]/;
  // Chinese, Japanese and Korean go on with no space, so a value's word also ends where their letters or
  // punctuation start: "我的密码是…，为什么", "パスワードは…です".
  const WORD_END = /[\s，。、：；！？「」『』\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  function wholeValue(text, at, value) {
    const open = text[at - 1];
    const close = QUOTE_CLOSE[open];
    if (close) {
      const escaped = text[at - 2] === "\\";
      for (let i = at; i < text.length && i < at + 128 && text[i] !== "\n" && text[i] !== "\r"; i++) {
        if (text[i] === "\\" && !(escaped && text[i + 1] === close)) {
          i++;
          continue;
        }
        const end = escaped ? text[i] === "\\" && text[i + 1] === close : text[i] === close;
        if (!end || !/^(?:$|[\s,;.:!?)\]}>])/u.test(text.slice(i + (escaped ? 2 : 1), i + (escaped ? 3 : 2)))) continue;
        const inner = text.slice(at, i);
        if (!/\s/.test(inner)) return inner.length > value.length ? inner : value;
        const words = inner.toLowerCase().split(/\s+/);
        const sentence = words.length > 8 || words.some((w) => EVERYDAY_WORDS.has(w));
        return sentence || words.filter((w) => NOT_A_SECRET.has(w)).length > 1 ? value : inner;
      }
    }
    let end = at + value.length;
    // A value ending in a backslash is really the \" that opens an escaped string, not a password with a quote in it.
    if (VALUE_STOP.test(text[end] || "") && !value.endsWith("\\") && !CONTRACTION.test(text.slice(end, end + 4))) {
      let stop = end;
      while (stop < text.length && !WORD_END.test(text[stop])) stop++;
      let word = text.slice(at, stop);
      const setting = NEXT_SETTING.exec(word);
      if (setting) word = word.slice(0, setting.index);
      word = word.replace(/[.,;:!?'"”’)\]}>]+$/u, "");
      const plain = word.replace(/[,;!?'"”’]/gu, "");
      const looksLikeOne =
        /\d/.test(plain) || /[^\p{L}\p{N}]/u.test(plain) || (/\p{Ll}/u.test(plain) && /\p{Lu}/u.test(plain));
      if (word.length > value.length && looksLikeOne) end = at + word.length;
    }
    // One blank line in between is the same break read back from a box that keeps each line as a paragraph.
    const wrapped = /^-(\r?\n(?:\r?\n)?)(\S{4,64})(?=\r?\n|$)/.exec(text.slice(end - 1, end + 72));
    if (wrapped) end += wrapped[1].length + wrapped[2].replace(/[.,;:!?'"”’)\]}>]+$/u, "").length;
    return text.slice(at, end);
  }

  // Finds a card's security code, which counts as its own money-related kind alongside the card number
  // rather than as a password. This matches the label, reads the code after it with cardCodeAt(), and
  // runs it through the same value checks a password gets. The result is cached for the last text read,
  // since the password kind needs it too, to leave these codes out of its own matches.
  let cardCodesFor = { text: null, codes: [] };
  function findCardCodes(text) {
    if (cardCodesFor.text !== text) {
      const codes = [];
      for (const m of text.matchAll(CARD_CODE)) {
        const code = cardCodeAt(text, m.index + m[0].length);
        const v = code && secretValue(code, false, 3);
        if (v) codes.push(v);
      }
      cardCodesFor = { text, codes: [...new Set(codes)] };
    }
    return [...cardCodesFor.codes];
  }

  // ---------- Gift card codes ----------
  // The US FTC says gift cards are what scammers most often ask older people to pay with, telling them to
  // "buy gift cards and read me the numbers on the back". This looks for a gift card word, like a plain
  // gift card, a specific store's card, or "tarjeta regalo", followed by its numbers in the same sentence
  // or the next one, as in "the gift card code is 7KQ2-9PMX-4RT8".
  const GIFT_WORDS =
    String.raw`(?:` +
    String.raw`(?:e-?\s?)?gift[\s-]*cards?` +
    String.raw`|(?:apple|itunes|google\s*play|steam|amazon|target|walmart|ebay|razer\s*gold|xbox|play\s*station|psn|nintendo(?:\s*e-?shop)?|vanilla|best\s*buy|sephora)\s+(?:gift\s*)?cards?` +
    String.raw`|(?:claim|redemption)\s+codes?` +
    String.raw`|(?:numbers?|digits?|codes?)\s+(?:off|on|from)\s+(?:the\s+)?back\s+of\s+(?:the|my|your|this|that|these|those|a|each)\s+(?:gift\s*)?cards?` +
    String.raw`|tarjetas?\s+(?:de\s+)?regalo|c[oó]digos?\s+de\s+canje` +
    String.raw`|tarjetas?\s+(?:de\s+)?(?:google\s*play|apple|itunes|amazon|steam|xbox|play\s*station|psn|nintendo)` +
    String.raw`)`;
  const GIFT_LABEL = new RegExp(String.raw`(?<![\p{L}\d])${GIFT_WORDS}(?![\p{L}])`, "giu");
  // Finds where the n-th sentence ends in a stretch of text, meaning its stop before a space or the end,
  // or a line break, falling back to the end of the stretch if there aren't that many. Giving every search
  // a definite end like this means no text ever gets read twice.
  const SENTENCE_END = /[.!?…]+(?=\s|$)|\n/g;
  function sentenceStop(text, from, to, n) {
    let seen = 0;
    for (const m of text.slice(from, to).matchAll(SENTENCE_END)) if (++seen === n) return from + m.index;
    return to;
  }
  // A code can be typed as letters and digits joined by dashes, like "7KQ2-9PMX-4RT8", or as one piece.
  const CODE_PIECE = /(?<![\p{L}\p{N}])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\p{L}\p{N}])/gu;
  // Rules out a piece that's really part of something else, like an amount of money, a percentage, a date,
  // a link, or a phone's country code.
  const NOT_BEFORE_PIECE = /[$€£¥#@/\\.+_%&=~]/;
  const NOT_AFTER_PIECE = /^(?:[@/\\%_&=~€]|[.,]\p{N})/u;
  // Common words, in English or Spanish, that a code can never actually be.
  const NOT_CODE_WORDS = new Set(
    "pin nip and the are is was code codes card cards gift and pero con son es era pin y el la los".split(" "),
  );
  // Rules out a number someone names as something else right before it, like an order or tracking number.
  const NAMED_OTHER =
    /(?<![\p{L}])(?:order|tracking|track|confirmation|reference|ref|invoice|receipt|transaction|account|routing|sku|model|serial|upc|isbn|item|part|phone|call|text|tel|fax|pedido|seguimiento|referencia|factura|recibo|cuenta|tel[eé]fono|m[oó]vil|llama)(?:\s+(?:number|no\.?|#|id|code|n[uú]mero|c[oó]digo))?\s*(?:is|was|es|era)?\s*[:#]?\s*$/iu;
  // The gift card's PIN, told after its code in the same sentence, as in "and the pin is 4471".
  const GIFT_PIN = /(?<![\p{L}])(?:pin|nip)(?![\p{L}])[^\n\d.!?]{0,20}?(?<![\p{L}\p{N}])(\d{4,8})(?![\p{L}\p{N}])/iu;

  // Describes one piece's shape so pieces can be joined into a code: it needs a digit, or to be all
  // capitals, like the group "PMXR".
  const pieceOf = (text, m) => {
    const s = m[0];
    const end = m.index + s.length;
    const apart = NOT_BEFORE_PIECE.test(text[m.index - 1] || "") || NOT_AFTER_PIECE.test(text.slice(end, end + 2));
    const digit = /\d/.test(s);
    const caps = !digit && /^[A-Z]{3,8}$/.test(s) && !NOT_CODE_WORDS.has(s.toLowerCase());
    return { start: m.index, end, s, dash: s.includes("-"), ok: !apart && (digit || caps) };
  };
  // Decides whether a run of pieces reads as one gift card code: 10 to 25 letters and digits (an Xbox code
  // runs to 25), with at least two digits and the letters all one case, so "iPhone15ProMax" doesn't qualify.
  // All-digit codes only count from 12 digits up, since fewer would be a phone number and one starting "00"
  // a phone called from abroad; one that passes the Luhn check still reads as a card number instead.
  function giftCode(value) {
    const plain = value.replace(/[\s-]/g, "");
    const digits = plain.replace(/\D/g, "").length;
    if (plain.length < 10 || plain.length > 25 || digits < 2 || isPlaceholder(plain)) return false;
    if (/[a-z]/.test(plain) && /[A-Z]/.test(plain)) return false;
    if (digits === plain.length) return digits >= 12 && !plain.startsWith("00") && !(luhn(plain) && !isIsbn13(plain));
    return true;
  }

  // Reads the codes out of one stretch of text after a gift card's word. Pieces separated by a single space
  // join into one code when they're the same size, like a printed card's groups "7KQ2 PMXR 4RT8 W9ZL",
  // though the last can be shorter if it has a digit; a piece with dashes already in it counts as a
  // complete code on its own. Each code that passes the checks goes into `out`, with any PIN found after it.
  function giftCodesIn(text, from, to, out) {
    const pieces = [];
    for (const m of text.slice(from, to).matchAll(CODE_PIECE)) {
      pieces.push(pieceOf(text, { 0: m[0], index: from + m.index }));
    }
    let run = [];
    const close = () => {
      if (!run.length) return;
      const start = run[0].start;
      const value = text.slice(start, lastItem(run).end);
      run = [];
      if (!giftCode(value) || NAMED_OTHER.test(text.slice(Math.max(0, start - 40), start))) return;
      out.push(value);
      const end = start + value.length;
      const pin = GIFT_PIN.exec(text.slice(end, sentenceStop(text, end, Math.min(text.length, end + 80), 1)));
      if (pin && !isPlaceholder(pin[1])) out.push(pin[1]);
    };
    for (const p of pieces) {
      const first = run[0];
      const joins =
        first &&
        p.ok &&
        !p.dash &&
        !first.dash &&
        text.slice(lastItem(run).end, p.start) === " " &&
        (p.s.length === first.s.length || (p.s.length < first.s.length && /\d/.test(p.s)));
      if (joins) {
        run.push(p);
        if (p.s.length < first.s.length) close(); // a shorter group ends the code it's the last part of
        continue;
      }
      close();
      if (p.ok) run = [p];
    }
    close();
  }

  // Each gift card word reads up to the end of the next sentence, 300 characters at most, or up to the next
  // such word, which then reads on from there, so every stretch of text is read once. The result is
  // cached for the last text read, the same way findCardCodes caches its answer.
  let giftCardsFor = { text: null, codes: [] };
  function findGiftCards(text) {
    if (giftCardsFor.text !== text) {
      const labels = [...text.matchAll(GIFT_LABEL)];
      const codes = [];
      labels.forEach((m, k) => {
        const from = m.index + m[0].length;
        const to = sentenceStop(text, from, Math.min(text.length, from + 300, labels[k + 1]?.index ?? Infinity), 2);
        if (to > from) giftCodesIn(text, from, to, codes);
      });
      giftCardsFor = { text, codes: [...new Set(codes)] };
    }
    return [...giftCardsFor.codes];
  }

  // The kinds of code a scammer asks for, in the order the warning names them in. This only decides what
  // the words on screen say, and nothing about it gets stored.
  const ASK_REASONS = ["login_code", "remote_code", "recovery_codes", "security_answer", "home_code"];
  const REMOTE_LABEL = new RegExp(REMOTE_WORDS_ES, "i");
  // Used only for matching label text. Secret values and ordinary Russian or Greek text stay unchanged.
  const CONFUSABLE_LABELS = Object.freeze({
    "\u0430": "a",
    "\u0410": "A",
    "\u0435": "e",
    "\u0415": "E",
    "\u043e": "o",
    "\u041e": "O",
    "\u0440": "p",
    "\u0420": "P",
    "\u0441": "c",
    "\u0421": "C",
    "\u0445": "x",
    "\u0425": "X",
    "\u0443": "y",
    "\u0423": "Y",
    "\u0456": "i",
    "\u0406": "I",
    "\u0458": "j",
    "\u0408": "J",
    "\u043a": "k",
    "\u041a": "K",
    "\u043c": "m",
    "\u041c": "M",
    "\u0442": "t",
    "\u0422": "T",
    "\u0432": "b",
    "\u0412": "B",
    "\u043d": "h",
    "\u041d": "H",
    "\u0455": "s",
    "\u0405": "S",
    "\u04cf": "l",
    "\u04c0": "I",
    "\u03b1": "a",
    "\u0391": "A",
    "\u03b5": "e",
    "\u0395": "E",
    "\u03bf": "o",
    "\u039f": "O",
    "\u03c1": "p",
    "\u03a1": "P",
    "\u03c4": "t",
    "\u03a4": "T",
    "\u03c7": "x",
    "\u03a7": "X",
    "\u03b9": "i",
    "\u0399": "I",
    "\u03ba": "k",
    "\u039a": "K",
    "\u03bc": "m",
    "\u039c": "M",
    "\u03bd": "v",
    "\u039d": "N",
    "\u0392": "B",
    "\u0396": "Z",
    "\u0397": "H",
    "\u03a5": "Y",
  });
  const CONFUSABLE_LABEL_CHARS = new RegExp(`[${Object.keys(CONFUSABLE_LABELS).join("")}]`, "g");
  const CONFUSABLE_LABEL_CHAR = new RegExp(`[${Object.keys(CONFUSABLE_LABELS).join("")}]`);
  function forConfusableLabelMatches(source, re, visit, hasConfusableLabel = CONFUSABLE_LABEL_CHAR.test(source)) {
    if (!hasConfusableLabel) return;
    const folded = source.replace(CONFUSABLE_LABEL_CHARS, (ch) => CONFUSABLE_LABELS[ch]);
    for (const m of folded.matchAll(re)) {
      const at = m.index + m[0].length - m[1].length;
      if (!CONFUSABLE_LABEL_CHAR.test(source.slice(m.index, at))) continue;
      const original = Array.from(m);
      original[1] = source.slice(at, at + m[1].length);
      original.index = m.index;
      original.input = source;
      visit(original);
    }
  }

  // The labels above, reused here for a message that asks for one of these codes, as in "tell me the code
  // we texted you". This is what scam-signs.js reads, matching labels only and never an actual value, in
  // both English and Spanish.
  const askLabels = Object.freeze({
    login_code: new RegExp(`${LOGIN_NAMES}|${CODE_THEY_SENT}|${LOGIN_LABEL_ES}`, "giu"),
    card_code: new RegExp(CARD_LABEL, "giu"),
    gift_card: new RegExp(GIFT_WORDS, "giu"),
    remote_code: new RegExp(`${REMOTE_WORDS}|${REMOTE_WORDS_ES}`, "giu"),
    recovery_codes: new RegExp(RECOVERY_LABEL, "giu"),
    security_answer: new RegExp(`${ANSWER_LABEL}|${ANSWER_LABEL_ES}`, "giu"),
  });

  // `why` is an optional Map from detect() that records, for each value this finds that a scam code's rule
  // matched, which reason it matched for. Without it, the values returned are the same either way.
  function findSecrets(rawText, why) {
    let text = rawText;
    const found = [];
    const reasons = new Map();
    const inTwilio = twilioLookup(text);
    const hasConfusableLabel = CONFUSABLE_LABEL_CHAR.test(text);
    // The first reason in ASK_REASONS' order wins when two rules take the same value ("my ATM pin is 4821").
    const rank = (reason) => (reason ? ASK_REASONS.indexOf(reason) : ASK_REASONS.length);
    const because = (v, reason) => {
      if (v && rank(reason) < rank(reasons.get(v))) reasons.set(v, reason);
    };
    // A money detail told after its own label, like a card's security code or a gift card's code and PIN,
    // is reported as its own kind, so it's never counted as a password too.
    const theirs = new Set([
      ...findCardCodes(text),
      ...findGiftCards(text),
      ...findAwsAccessKeys(text),
      ...findServiceTokens(text, inTwilio, hasConfusableLabel),
      ...findConnectionStrings(text),
    ]);
    // A two-step sign-in key or link is already reported as its own otp_secret kind, even a documentation
    // example, so it's blanked out here to keep its "secret=…" from also being read as a password.
    const keys = otpFinds(text).filter((f) => !f.link);
    text = text.replace(OTP_LINK_RE, blank);
    if (keys.length) {
      let out = "";
      let at = 0;
      for (const f of keys) {
        out += text.slice(at, f.start) + blank(f.value);
        at = f.end;
      }
      text = out + text.slice(at);
    }
    // The pairs as the label finders below see the text, with those sign-in keys blanked.
    const labelTwilio = text === rawText ? inTwilio : twilioLookup(text);
    const labelHasConfusableLabel = text === rawText ? hasConfusableLabel : CONFUSABLE_LABEL_CHAR.test(text);
    // Returns the value taken as a secret, or false.
    const add = (raw, needsComplexity, minLength = 4) => {
      const v = secretValue(raw, needsComplexity, minLength);
      if (!v) return false;
      found.push(v);
      return v;
    };
    const passphraseAt = (pos) => {
      const p = PASSPHRASE.exec(text.slice(pos, pos + 90));
      const words = p ? p[1].toLowerCase().split(/[\s-]+/) : [];
      // One describing word can still be part of a real passphrase, like "correct horse battery staple".
      // Two describing words mean it's a sentence describing the password instead.
      if (!p || words.some((w) => EVERYDAY_WORDS.has(w)) || words.filter((w) => NOT_A_SECRET.has(w)).length > 1) {
        return false;
      }
      found.push(p[1]);
      return true;
    };
    const valueStart = (m) => m.index + m[0].length - m[1].length;
    // The value read on past punctuation inside it (wholeValue), or the value as matched when that isn't a secret.
    const addWhole = (m, needsComplexity) => {
      const whole = wholeValue(text, valueStart(m), m[1]);
      return add(whole, needsComplexity) || (whole !== m[1] && add(m[1], needsComplexity));
    };
    // Reads a secret told in words, trying a passphrase first, then the word right after "is", then the
    // first password-looking word shortly after that.
    const told = (m) => {
      if (passphraseAt(valueStart(m))) return;
      // A length range: "the password is 8-16 characters long".
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
      if (/^\d+[-–]\d+$/.test(m[1]) && /^\s+(?:characters|chars|letters|digits|caracteres)/i.test(after)) return;
      // A PIN is digits: "my pin is loose" is about hardware.
      if (/^(?:(?:my|the|our|his|her|their|your)\s+)?pin\b/i.test(m[0]) && !/\d/.test(m[1])) return;
      if (addWhole(m, false)) return;
      const later = LATER_SECRET.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
      if (later) add(later[0], true);
    };
    // Qt's PASS result lines can look like `PASS : TestCipher::testRoundTrip(QByteArray, 42)`. Neutralize only
    // that label at the same length, so a password later on the line (including a test argument) still gets checked.
    const labelledSecretText = text.replace(
      /^[\t ]*(?:>[\t ]*)?PASS(?=\s*:\s*Test[\w.$]*::test[\w$]*\()/gm,
      (match) => `${match.slice(0, -4)}    `,
    );
    const labelledSecret = (m) => {
      const at = valueStart(m);
      if (inTwilio(at, at + m[1].length)) return;
      if (isProviderCredentialLabel(m[0], labelTwilio, m[1], at)) return;
      const whole = wholeValue(text, at, m[1]);
      const before = lineBefore(text, m.index);
      const labelPart = m[0].slice(0, m[0].length - m[1].length);
      const enclosed = insideCode(text, m.index);
      // An unquoted scheme word ("Bearer", "Basic", "Token", "Bot" …) is the scheme, and the credential is the run after
      // it, even past a colon, comma, dash or line break: "token: Bearer …", "token: Bearer: …". That run is what gets
      // reported and covered. "Bearer" alone ("token_type: Bearer") is a scheme name.
      const scheme = schemeAt(text, at, whole);
      if (scheme) {
        const credential = scheme.value;
        const after = text.slice(scheme.end, scheme.end + 40);
        if (labelledNotSecret(m[0], credential, { before, after, enclosed })) return;
        if (LOOKUP_TOKEN_LABEL.test(text.slice(Math.max(0, m.index - 40), at))) return;
        if (schemeCredentialLike(scheme.word, credential)) add(credential, false, 8);
        return;
      }
      // Judged on the whole value and what's around it, so "Bearer" alone is a scheme name and "hashedPassword," in
      // code names the secret, while a password that looks like code ("superSecret", "Correct.Horse.Battery") is read.
      const afterValue = text.slice(at + whole.length, at + whole.length + 40);
      const around = {
        before,
        after: afterValue,
        rest: text.slice(at + whole.length, at + whole.length + 400),
        ini: INI_SECTION.test(text.slice(Math.max(0, m.index - 2000), m.index)),
        assigned: /\s=/.test(labelPart),
        equals: /=/.test(labelPart),
        quotedKey: /["']\]?\s*(?:\??:|=)/.test(labelPart),
        tight: /:["']?$/.test(labelPart),
        enclosed,
        quoted: Boolean(QUOTE_CLOSE[text[at - 1]]),
      };
      if (labelledNotSecret(m[0], whole, around)) return;
      if (LOOKUP_TOKEN_LABEL.test(text.slice(Math.max(0, m.index - 40), at))) return;
      // A quoted sentence after the label is a message or a hint ("Enter your password here"), not the password.
      const close = QUOTE_CLOSE[text[at - 1]];
      if (close && /^[^\S\r\n]+[^\s"'”’]/.test(text.slice(at + m[1].length, at + m[1].length + 8))) {
        const end = text.indexOf(close, at + m[1].length);
        const inner = end > 0 && end - at <= 128 ? text.slice(at, end) : "";
        if (inner && !/[\r\n]/.test(inner) && wholeValue(text, at, m[1]) === m[1]) return;
      }
      if (!addWhole(m, true)) passphraseAt(at);
    };
    for (const m of labelledSecretText.matchAll(LABELLED_SECRET)) labelledSecret(m);
    forConfusableLabelMatches(text, LABELLED_SECRET, labelledSecret, labelHasConfusableLabel);
    for (const m of text.matchAll(AUTH_HEADER)) {
      // Twilio's SID and auth token are two labeled fields, so a bearer-style wrapper can capture the SID as text.
      if (/^TWILIO_(?:ACCOUNT_SID|AUTH_TOKEN)=/i.test(m[1])) continue;
      add(m[1], true);
    }
    for (const m of text.matchAll(TOLD_SECRET)) told(m);
    for (const m of text.matchAll(TOLD_SECRET_ES)) told(m);
    forConfusableLabelMatches(text, TOLD_SECRET, told, labelHasConfusableLabel);
    forConfusableLabelMatches(text, TOLD_SECRET_ES, told, labelHasConfusableLabel);
    // Not a range ("8-16 characters") or a describing word ("one-time", "case-sensitive").
    for (const m of text.matchAll(TOLD_SECRET_MORE)) {
      if (/\p{L}/u.test(m[1]) && !/^\p{Ll}+(?:-\p{Ll}+)+$/u.test(m[1])) addWhole(m, true);
    }
    for (const m of text.matchAll(TOLD_KEY)) if (keyLike(trimTrailing(m[1], /[.)\]}>]/))) add(m[1], true);
    for (const m of text.matchAll(TOLD_ANSWER)) because(add(m[1], false), "security_answer");
    for (const m of text.matchAll(TOLD_ANSWER_ES)) because(add(m[1], false), "security_answer");
    for (const m of text.matchAll(BARE_SECRET)) {
      // A capital letter starting the next line belongs to that line, not the password. Otherwise "I
      // forgot my password" followed by "Drive safe!" on its own line would read "Drive" as the password.
      if (m[0].includes("\n") && /^\p{Lu}\p{Ll}*[.?!:]*$/u.test(m[1])) continue;
      addWhole(m, true);
    }
    for (const m of text.matchAll(LOGIN_PAIR)) add(m[1], true);
    const strong = (v) => /\d|[^\p{L}\p{N}]/u.test(v.replace(/[.,;:!?]+$/, ""));
    for (const re of [TOLD_SECRET_DE_FR, LOGIN_THEN_SECRET, USER_PASS]) {
      for (const m of text.matchAll(re)) if (strong(wholeValue(text, valueStart(m), m[1]))) addWhole(m, true);
    }
    for (const m of text.matchAll(USE_AS_SECRET)) if (strong(m[1])) add(m[1], true);
    // A range is a length rule, as in "密码是8-16位" (8 to 16 characters).
    const range = (v) => /^\d+[-–~～]\d+$/.test(trimTrailing(v, /[.)\]}>]/));
    for (const re of [TOLD_SECRET_INTL, TOLD_SECRET_LOANWORD, TOLD_SECRET_MDP, TOLD_SECRET_CJK]) {
      for (const m of text.matchAll(re)) {
        const v = wholeValue(text, valueStart(m), m[1]);
        if (strong(v) && !range(v)) addWhole(m, true);
      }
    }
    for (const re of [BARE_SECRET_INTL, BARE_SECRET_CJK]) {
      for (const m of text.matchAll(re)) {
        const v = wholeValue(text, valueStart(m), m[1]);
        if (/\d/.test(v) && v.length >= 6 && !range(v)) addWhole(m, true);
      }
    }
    for (const re of [MYSQL_FLAG, XML_SECRET, PASSWORD_BOX, SECURE_STRING]) {
      for (const m of text.matchAll(re)) add(m[2], false);
    }
    // Docs write these commands out as "-u user:password", so the value has to look like a real one.
    for (const m of text.matchAll(CURL_USER)) add(m[2] ?? m[4] ?? m[6], true);
    for (const re of COMMAND_PASSWORD) for (const m of text.matchAll(re)) if (!looksLikePath(m[2])) add(m[2], true);
    for (const m of text.matchAll(AWS_CONFIGURE_SET)) add(m[2], true);
    // A key that isn't random enough to be its own kind, like 32 hex characters, is still a secret by its name.
    for (const setting of namedSettings(text)) add(setting.value, true, setting.kind === "key" ? 16 : 4);
    for (const m of text.matchAll(AUTH_TUPLE)) add(m[3], false);
    for (const m of text.matchAll(SQL_IDENTIFIED)) add(m[2], false);
    for (const cell of tablePasswords(text)) add(cell, true);
    for (const cell of csvPasswords(text)) add(cell, true);
    for (const m of text.matchAll(REMOTE_CODE)) because(add(m[1], false), "remote_code");
    for (const m of text.matchAll(LOGIN_CODE)) because(add(matched(m), false), "login_code");
    for (const m of text.matchAll(SESSION_COOKIE)) {
      const v = m[2];
      if (/\d/.test(v) && /[A-Za-z]/.test(v)) add(v, true); // random-looking, not "sessionid=0000000000000000"
    }
    for (const m of text.matchAll(RECOVERY_CODES)) {
      const codes = trimTrailing(m[1], /[\s,;]/);
      if (/\d/.test(codes) && codes.length >= 8) {
        found.push(codes);
        because(codes, "recovery_codes");
      }
    }
    for (const m of text.matchAll(CODE_TOLD_ES)) {
      because(add(m[1], false), REMOTE_LABEL.test(m[0]) ? "remote_code" : "home_code");
    }
    for (const m of text.matchAll(LOGIN_CODE_ES)) because(add(matched(m), false), "login_code");
    for (const m of text.matchAll(CODE_TOLD)) {
      // "1-2-3" reads as an example rather than a real code. A real combination lock uses 2-digit numbers,
      // and a real keypad code has 4 or more digits, like "1-9-7-5".
      if (
        /[- ]/.test(m[1]) &&
        !/\d\d/.test(m[1]) &&
        (m[1].split(/[- ]/).length < 4 || "0123456789".includes(m[1].replace(/[- ]/g, "")))
      ) {
        continue;
      }
      because(add(m[1], false), "home_code");
    }
    // Several ways of saying it can find the same value.
    const out = [...new Set(found)].filter((v) => !theirs.has(v));
    if (why) for (const v of out) if (reasons.has(v)) why.set(v, reasons.get(v));
    return out;
  }

  // Provider tokens told apart by a prefix or marker their provider puts in every one, in each provider's documented
  // length and characters. The rest of the token has to look machine-made, so a doc's "dckr_pat_your_token_here" or a
  // body spelled out of words stays quiet. A prefix that ordinary words or names could start, like "secret_" or "fw_",
  // asks for mixed case and a digit as well.
  // A body with no digit reads as words when its lowercase comes in runs of several letters with vowels in them, as
  // in "DockerHubPersonalToken". Random letters rarely do.
  const readsAsWords = (s) => {
    const runs = s.match(/[a-z]+/g) || [];
    const letters = runs.join("");
    return (
      letters.length > 0 &&
      letters.length >= 2.5 * runs.length &&
      (letters.match(/[aeiou]/g) || []).length >= 0.3 * letters.length
    );
  };
  // A short body drawn from letters, digits, "-" and "_" can have its runs broken up by chance, so one in mixed case
  // with a digit also passes on its letters and digits alone.
  const machineMade = (body) =>
    looksRandomAnyCase(body) ||
    (looksRandomLetters(body) && !readsAsWords(body)) ||
    (/[-_]/.test(body) && /[A-Z]/.test(body) && /[a-z]/.test(body) && looksRandomAnyCase(body.replace(/[-_]/g, "")));
  const strictlyRandom = (body) => looksRandom(body, Math.min(20, body.length));
  // A prefix only one provider uses, at a fixed length, needs no digit: a random body can go without one by chance.
  // Mixed case and the spread of random characters are enough, unless it has no digit and reads as words.
  const randomMixedCase = (body) => {
    const s = body.replace(/[^A-Za-z0-9]/g, "");
    return /[A-Z]/.test(s) && /[a-z]/.test(s) && entropy(s) >= 3.5 && (/\d/.test(s) || !readsAsWords(s));
  };
  const ownPrefix = (body) => machineMade(body) || randomMixedCase(body);
  // A token can sit between Markdown's emphasis underscores, "_token_", but not inside a longer name like "my_token".
  const BEFORE = String.raw`(?<![A-Za-z0-9])(?<![A-Za-z0-9_]_)`;
  const AFTER = String.raw`(?![A-Za-z0-9-])(?!_[A-Za-z0-9_-])`;
  // [marker(s) found by indexOf, how far before the marker the token starts, source, check]. The source matches at
  // the token's start; its first group, when it has one, is the part the check reads.
  const PREFIXED_TOKENS = [
    ["GOCSPX-", 0, String.raw`${BEFORE}GOCSPX-([A-Za-z0-9_-]{28})${AFTER}`, ownPrefix],
    ["ya29.", 0, String.raw`${BEFORE}ya29\.([A-Za-z0-9_-]{40,2048})${AFTER}`],
    // A Google refresh token.
    ["1//0", 0, String.raw`(?<![A-Za-z0-9/:])(?<![A-Za-z0-9_]_)1//0([A-Za-z0-9_-]{60,512})${AFTER}`, strictlyRandom],
    // A Microsoft Entra client secret: three characters, a digit, "Q~" and 31 to 34 more. A "." can be inside one
    // but not end it, so a sentence's full stop stays out.
    [
      "Q~",
      4,
      String.raw`(?<![A-Za-z0-9~.-])(?<![A-Za-z0-9_]_)[A-Za-z0-9_~.-]{3}\dQ~([A-Za-z0-9_~.-]{30,33}[A-Za-z0-9_~-])(?![A-Za-z0-9~-])(?![_.][A-Za-z0-9_~-])`,
      ownPrefix,
    ],
    // An Azure DevOps token in its 84-character form carries "AZDO" at a fixed place.
    ["AZDO", 76, String.raw`(?<![A-Za-z0-9])[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}(?![A-Za-z0-9])`, strictlyRandom],
    // An Azure Container Registry password carries "+ACR" at a fixed place.
    ["+ACR", 42, String.raw`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42}\+ACR[A-Za-z0-9]{6}(?![A-Za-z0-9+/=])`, strictlyRandom],
    // A Microsoft Entra refresh token.
    [
      ["0.A", "1.A"],
      0,
      String.raw`(?<![A-Za-z0-9.-])(?<![A-Za-z0-9_]_)[01]\.A([A-Za-z0-9_-]{50,4000}(?:\.\d)?\.Ag[A-Za-z0-9_-]{250,8000}(?:\.A[A-Za-z0-9_-]{200,8000})?)${AFTER}`,
    ],
    ["sbp_", 0, String.raw`${BEFORE}sbp_([a-z0-9]{40})${AFTER}`],
    ["lsv2_", 0, String.raw`${BEFORE}lsv2_(?:pt|sk)_([a-f0-9]{32}_[a-f0-9]{10})${AFTER}`],
    ["sk-lf-", 0, String.raw`${BEFORE}sk-lf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})${AFTER}`],
    ["pcsk_", 0, String.raw`${BEFORE}pcsk_([A-Za-z0-9]{5,6}_[A-Za-z0-9]{63})${AFTER}`],
    ["dckr_pat_", 0, String.raw`${BEFORE}dckr_pat_([A-Za-z0-9_-]{27})${AFTER}`, ownPrefix],
    ["dckr_oat_", 0, String.raw`${BEFORE}dckr_oat_([A-Za-z0-9_-]{32})${AFTER}`, ownPrefix],
    // A Notion token: 11 digits, then the random part.
    ["ntn_", 0, String.raw`${BEFORE}ntn_\d{11}([A-Za-z0-9]{35})${AFTER}`],
    ["secret_", 0, String.raw`${BEFORE}secret_([A-Za-z0-9]{43})${AFTER}`, strictlyRandom],
    // An Airtable token: "pat", 14 characters, a dot and 64 hex.
    ["pat", 0, String.raw`${BEFORE}pat([A-Za-z0-9]{14}\.[a-f0-9]{64})${AFTER}`],
    ["ATBB", 0, String.raw`${BEFORE}ATBB([A-Za-z0-9_=-]{28,64})(?![A-Za-z0-9_=-])`],
    ["BBDC-", 0, String.raw`${BEFORE}BBDC-([A-Za-z0-9+/_-]{44})(?![A-Za-z0-9+/=-])(?!_[A-Za-z0-9+/=_-])`],
    // A Terraform Cloud token: 14 characters, ".atlasv1." and the secret.
    [".atlasv1.", 14, String.raw`(?<![A-Za-z0-9])[A-Za-z0-9]{14}\.atlasv1\.([A-Za-z0-9_=-]{60,70})(?![A-Za-z0-9_=-])`],
    [
      "dp.",
      0,
      String.raw`(?<![A-Za-z0-9.])(?<![A-Za-z0-9_]_)dp\.(?:ct|pt|st(?:\.[a-z0-9_-]{2,35})?|sa|scim|audit)\.([A-Za-z0-9]{40,44})${AFTER}`,
    ],
    // A Discord bot token for a newer bot, whose ID in base64 starts with "O". "O" is too common to look for one at a
    // time, so this one is a single scan.
    [
      null,
      0,
      String.raw`(?<![A-Za-z0-9])(?<![A-Za-z0-9_]_)O([A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38})(?![A-Za-z0-9])(?!_[A-Za-z0-9_-])`,
    ],
    ["fw_", 0, String.raw`${BEFORE}fw_([A-Za-z0-9]{20,40})${AFTER}`, strictlyRandom],
    ["EAAA", 0, String.raw`${BEFORE}EAAA([A-Za-z0-9_+=-]{60})(?![A-Za-z0-9+=-])(?!_[A-Za-z0-9_+=-])`],
    ["sq0c", 0, String.raw`${BEFORE}sq0c[a-z]{2}-([A-Za-z0-9_-]{40,50})${AFTER}`, ownPrefix],
    ["sq0atp-", 0, String.raw`${BEFORE}sq0atp-([A-Za-z0-9_-]{22})${AFTER}`, ownPrefix],
    [
      "access_token$",
      0,
      String.raw`${BEFORE}access_token\$(?:production|sandbox)\$([a-z0-9]{16}\$[a-f0-9]{32})(?![A-Za-z0-9])`,
    ],
    // A Facebook (Meta) access token.
    ["EAA", 0, String.raw`${BEFORE}EAA[A-Z]([A-Za-z0-9]{100,1000})${AFTER}`, strictlyRandom],
    // A Dropbox token.
    [
      "sl.",
      0,
      String.raw`(?<![A-Za-z0-9.])(?<![A-Za-z0-9_]_)sl\.(?:u\.)?([A-Za-z0-9_=-]{130,2000})(?![A-Za-z0-9_=-])`,
      strictlyRandom,
    ],
    // A Mapbox secret token: base64 of its owner, then a random part too short to be sure of a digit in it.
    [
      "sk.eyJ",
      0,
      String.raw`(?<![A-Za-z0-9.])(?<![A-Za-z0-9_]_)sk\.eyJ[A-Za-z0-9_-]{20,400}\.([A-Za-z0-9_-]{20,100})${AFTER}`,
      randomMixedCase,
    ],
    // A TestPyPI token, whose fixed start is base64 of the index's name. That start is made of characters its body
    // allows, so the guard in front is what keeps each copy of it in a long run from scanning the rest of the run.
    [
      "pypi-AgENdGVzdC5weXBpLm9yZw",
      0,
      String.raw`(?<![A-Za-z0-9-])(?<![A-Za-z0-9_]_)pypi-AgENdGVzdC5weXBpLm9yZw([A-Za-z0-9_-]{50,4096})${AFTER}`,
    ],
    ["CFPAT-", 0, String.raw`${BEFORE}CFPAT-([A-Za-z0-9_-]{43})${AFTER}`],
    ["NRAK-", 0, String.raw`${BEFORE}NRAK-([A-Z0-9]{27})${AFTER}`],
    ["napi_", 0, String.raw`${BEFORE}napi_([a-z0-9]{64})${AFTER}`],
    ["pscale_", 0, String.raw`${BEFORE}pscale_(?:tkn|pw|oauth)_([A-Za-z0-9_=-]{32,64})(?![A-Za-z0-9_=-])`],
    ["figd_", 0, String.raw`${BEFORE}figd_([A-Za-z0-9_-]{40})${AFTER}`],
    ["bkua_", 0, String.raw`${BEFORE}bkua_([a-z0-9]{40})${AFTER}`],
    ["tfp_", 0, String.raw`${BEFORE}tfp_([A-Za-z0-9_-]{40,59})${AFTER}`],
    ["pnu_", 0, String.raw`${BEFORE}pnu_([A-Za-z0-9]{36})${AFTER}`],
    ["rdme_", 0, String.raw`${BEFORE}rdme_([a-z0-9]{70})${AFTER}`],
    ["dt0c01.", 0, String.raw`${BEFORE}dt0c01\.([A-Z0-9]{24}\.[A-Z0-9]{64})(?![A-Za-z0-9])`],
    ["EZ", 0, String.raw`${BEFORE}EZ[AT]K([A-Za-z0-9]{54})${AFTER}`],
    ["fio-u-", 0, String.raw`${BEFORE}fio-u-([A-Za-z0-9_=-]{64})(?![A-Za-z0-9=-])(?!_[A-Za-z0-9_=-])`],
    ["ico-", 0, String.raw`${BEFORE}ico-([A-Za-z0-9]{32})${AFTER}`, strictlyRandom],
    ["xkeysib-", 0, String.raw`${BEFORE}xkeysib-([a-f0-9]{64}-[A-Za-z0-9]{16})${AFTER}`],
    ["shippo_", 0, String.raw`${BEFORE}shippo_(?:live|test)_([a-f0-9]{40})${AFTER}`],
    ["duffel_", 0, String.raw`${BEFORE}duffel_(?:live|test)_([A-Za-z0-9_-]{43})${AFTER}`],
    // JFrog Artifactory: an API key, and a reference token, whose "cmVmd" is base64 of "ref".
    ["AKCp", 0, String.raw`${BEFORE}AKCp([A-Za-z0-9]{69})${AFTER}`],
    [
      "cmVmd",
      0,
      String.raw`(?<![A-Za-z0-9+/])(?<![A-Za-z0-9_]_)cmVmd([A-Za-z0-9]{59})(?![A-Za-z0-9+/=-])(?!_[A-Za-z0-9_+/=-])`,
      strictlyRandom,
    ],
    // An Alibaba Cloud access key ID.
    [
      "LTAI",
      0,
      String.raw`${BEFORE}LTAI([A-Za-z0-9]{20})${AFTER}`,
      (body) => strictlyRandom(body) || randomMixedCase(body),
    ],
    // A ClickHouse Cloud key secret.
    ["4b1d", 0, String.raw`${BEFORE}4b1d([A-Za-z0-9]{38})${AFTER}`, strictlyRandom],
    // An Adobe client secret.
    ["p8e-", 0, String.raw`${BEFORE}p8e-([A-Za-z0-9]{32})${AFTER}`],
    // An OpenShift user token.
    ["sha256~", 0, String.raw`${BEFORE}sha256~([A-Za-z0-9_-]{43})${AFTER}`],
    ["tk-us-", 0, String.raw`${BEFORE}tk-us-([A-Za-z0-9_-]{48})${AFTER}`],
    // A Harness token: "pat." or "sat.", the account, the token's ID and its secret.
    [
      ["pat.", "sat."],
      0,
      String.raw`${BEFORE}[ps]at\.([A-Za-z0-9_-]{22}\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{20})(?![A-Za-z0-9])`,
    ],
    ["sgp_", 0, String.raw`${BEFORE}sgp_((?:[a-f0-9]{16}|local)_[a-f0-9]{40}|[a-f0-9]{40})${AFTER}`],
    // An Octopus Deploy key.
    ["API-", 0, String.raw`${BEFORE}API-([A-Z0-9]{26})${AFTER}`],
    ["FLWSECK", 0, String.raw`${BEFORE}FLWSECK(?:_TEST)?-([a-h0-9]{32})-X${AFTER}`],
    // A MaxMind licence key ends in "_mmk".
    ["_mmk", 36, String.raw`${BEFORE}([A-Za-z0-9]{6}_[A-Za-z0-9]{29})_mmk${AFTER}`],
    // A 42 network (intra.42.fr) client secret.
    ["s-s4t2", 0, String.raw`${BEFORE}s-s4t2(?:ud|af)-([a-f0-9]{64})${AFTER}`],
    ["ramp_sec_", 0, String.raw`${BEFORE}ramp_sec_([A-Za-z0-9]{48})${AFTER}`],
    ["sm_", 0, String.raw`${BEFORE}sm_(?:aat|pat|sat)_([A-Za-z0-9]{16})${AFTER}`, ownPrefix],
    ["nvapi-", 0, String.raw`${BEFORE}nvapi-([A-Za-z0-9_-]{64})${AFTER}`],
    // An ElevenLabs key.
    ["sk_", 0, String.raw`${BEFORE}sk_([a-f0-9]{48})${AFTER}`],
  ].map(([markers, back, source, check = machineMade]) => ({
    markers: markers && [].concat(markers),
    back,
    re: new RegExp(source, markers ? "y" : "g"),
    check,
  }));
  // A Mailgun key in its newer form: 32 hex, then two groups of 8. Cache keys and IDs come in the same shape, so it
  // only reads as one near the word Mailgun.
  const MAILGUN_KEY_RE = /(?<![A-Za-z0-9_-])([0-9a-f]{32})-[0-9a-f]{8}-[0-9a-f]{8}(?![A-Za-z0-9_-])/g;
  const MAILGUN_WORD = /mailgun/i;
  // An Okta API token is "00" and 40 more, which only reads as one after its "SSWS" scheme or near the word Okta.
  const OKTA_TOKEN_RE =
    /(?<![A-Za-z0-9=-])(?<![A-Za-z0-9_]_)00([A-Za-z0-9_=-]{40})(?![A-Za-z0-9=-])(?!_[A-Za-z0-9_=-])/g;
  const OKTA_WORD = /okta/i;
  const SSWS_BEFORE = /\bSSWS\s{1,4}$/;
  // An Azure DevOps token in its older form is 52 lowercase letters and digits, which only reads as one near Azure.
  const OLD_AZURE_DEVOPS_RE = /(?<![A-Za-z0-9])[a-z0-9]{52}(?![A-Za-z0-9])/g;
  const AZURE_WORD = /azure|devops|visualstudio/i;
  // An Azure shared access signature: a link's sig= is the HMAC that lets anyone holding the link in, and an sv=
  // storage version in the same query says it is Azure's. Its value is 32 bytes in base64, percent-encoded or not.
  // HTML writes the query's "&" as "&amp;", and Go's JSON (terraform.tfstate) as "\u0026".
  const SAS_SIG_RE = /(?:[?&]|&amp;|\\u0026)sig=([A-Za-z0-9%+/=]{40,140})/g;
  const SAS_VERSION = /(?:^|[?&;=]|\\u0026)sv=\d{4}-\d\d-\d\d(?!\d)/;
  const SAS_QUERY_END = /[\s"'<>;]/;
  const queryEndsAt = (text, i) => SAS_QUERY_END.test(text[i]) && !(text[i] === ";" && text.endsWith("&amp", i));

  function findPrefixedTokens(text) {
    const found = [];
    for (const { markers, back, re, check } of PREFIXED_TOKENS) {
      if (!markers) {
        for (const m of text.matchAll(re)) if (!isPlaceholder(m[0]) && check(m[1] ?? m[0])) found.push(m[0]);
        continue;
      }
      for (const marker of markers) {
        for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
          if (at < back) continue;
          re.lastIndex = at - back;
          const m = re.exec(text);
          if (m && !isPlaceholder(m[0]) && check(m[1] ?? m[0])) found.push(m[0]);
        }
      }
    }
    if (MAILGUN_WORD.test(text)) {
      for (const m of text.matchAll(MAILGUN_KEY_RE)) {
        const near = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 100);
        if (MAILGUN_WORD.test(near) && looksRandomAnyCase(m[1])) found.push(m[0]);
      }
    }
    if (text.includes("SSWS") || OKTA_WORD.test(text)) {
      for (const m of text.matchAll(OKTA_TOKEN_RE)) {
        const before = text.slice(Math.max(0, m.index - 200), m.index);
        const near = SSWS_BEFORE.test(before) || OKTA_WORD.test(before + text.slice(m.index, m.index + 142));
        if (near && !isPlaceholder(m[0]) && machineMade(m[1])) found.push(m[0]);
      }
    }
    if (AZURE_WORD.test(text)) {
      for (const m of text.matchAll(OLD_AZURE_DEVOPS_RE)) {
        const near = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 100);
        if (AZURE_WORD.test(near) && !isPlaceholder(m[0]) && looksRandomAnyCase(m[0])) found.push(m[0]);
      }
    }
    if (text.includes("sig=")) {
      // One query read for every sig= in it, so a query of many of them is not walked again for each.
      let query = "";
      let queryEnd = -1;
      for (const m of text.matchAll(SAS_SIG_RE)) {
        if (m.index >= queryEnd) {
          let start = m.index;
          const floor = Math.max(0, m.index - 2000);
          while (start > floor && !queryEndsAt(text, start - 1)) start--;
          queryEnd = m.index + m[0].length;
          const ceiling = Math.min(text.length, queryEnd + 2000);
          while (queryEnd < ceiling && !queryEndsAt(text, queryEnd)) queryEnd++;
          query = text.slice(start, queryEnd);
        }
        const sig = m[1].replace(/%2B/gi, "+").replace(/%2F/gi, "/").replace(/%3D/gi, "=");
        if (SAS_VERSION.test(query) && /^[A-Za-z0-9+/]{43}=$/.test(sig) && !isPlaceholder(sig)) {
          found.push(m[1]);
        }
      }
    }
    return found;
  }

  // `group` = the Settings section: "credentials" (keys, passwords), "personal" (info about a person),
  // or "custom" (the user's own watch list).
  // Distinct provider prefixes share one service-token kind and one Settings row.
  const SERVICE_TOKEN_RE = new RegExp(
    [
      String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
      String.raw`\bovsxat_(?:[A-Za-z0-9]{43}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?![A-Za-z0-9_-])`,
      String.raw`\brubygems_[0-9a-f]{48}(?![A-Za-z0-9_-])`,
      String.raw`\bperm:(?:[A-Za-z0-9+/=_-]{16,}(?:\.[A-Za-z0-9+/=_-]{8,})*|[A-Za-z0-9+/=_-]{4,}(?:\.[A-Za-z0-9+/=_-]{8,}){2,})(?![A-Za-z0-9+/=_-])`,
      String.raw`\bgsk_[A-Za-z0-9]{52}(?![A-Za-z0-9_-])`,
      String.raw`\bsk-or-v1-[0-9a-f]{64}(?![A-Za-z0-9_-])`,
      String.raw`\bsb_secret_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])`,
      String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`,
      String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`,
      String.raw`\bSK[0-9a-fA-F]{32}\b`,
      String.raw`\bkey-[0-9a-f]{32}\b`,
      String.raw`(?:(?<=/bot)|(?<![A-Za-z0-9_]))\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])`,
      String.raw`\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b`,
      String.raw`\b(?:AccountKey|SharedAccessKey)=["']?[A-Za-z0-9+/]{40,88}={0,2}["']?`,
      String.raw`https://hooks\.slack\.com/(?:workflows|triggers)/[A-Za-z0-9/_-]{20,120}`,
      String.raw`https://hooks\.slack\.com/services/(?!T[A-Za-z0-9_]{1,40}/B[A-Za-z0-9_]{1,40}/)[A-Za-z0-9/_-]{20,120}`,
      String.raw`https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d{5,25}/[A-Za-z0-9_-]{20,100}`,
      String.raw`\btskey-(?:auth|api|client|scim|webhook)-[A-Za-z0-9]{8,}-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])`,
      String.raw`\bFlyV1\s+fm\d_[A-Za-z0-9+/=_-]{40,}(?:,fm\d_[A-Za-z0-9+/=_-]{20,})*`,
      String.raw`\bfo1_[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])`,
      String.raw`\boy2(?=[a-z0-9]{0,42}\d)[a-z0-9]{43}(?![A-Za-z0-9_-])`,
      String.raw`\bcio(?=[A-Za-z0-9]{0,31}\d)(?=[A-Za-z0-9]{0,31}[A-Z])(?=[A-Za-z0-9]{0,31}[a-z])[A-Za-z0-9]{32}(?![A-Za-z0-9_-])`,
    ].join("|"),
    "g",
  );
  function findServiceTokens(
    text,
    inTwilio = twilioLookup(text),
    hasConfusableLabel = CONFUSABLE_LABEL_CHAR.test(text),
  ) {
    const found = [...text.matchAll(SERVICE_TOKEN_RE)].map((m) => m[0]);
    const awsKeys = new Set(findAwsAccessKeys(text));
    const labelledApiKey = (m) => {
      const at = m.index + m[0].length - m[1].length;
      // A provider label only takes this path when its value matches that provider's own token shape.
      if (isProviderCredentialLabel(m[0], inTwilio, m[1], at)) return;
      if (inTwilio(at, at + m[1].length)) return;
      const lookupLabel = m[0].slice(0, m[0].length - m[1].length);
      const labelBefore = text.slice(Math.max(0, m.index - 40), m.index) + lookupLabel;
      if (LOOKUP_TOKEN_LABEL.test(labelBefore)) return;
      // "stripe key: Bearer …" or "stripe key: 'Bearer …'": a scheme word starts the value, and the credential is the
      // whole run after it.
      let told = m[1];
      if (AUTH_SCHEME.test(m[1].replace(/[:,\-–—]+$/u, ""))) {
        const scheme = schemeAt(text, at, m[1]);
        if (!scheme || !schemeCredentialLike(scheme.word, scheme.value)) return;
        told = scheme.value;
      }
      if (LOOKUP_KEY_LABEL.test(lookupLabel)) {
        const rawValue = told.split(/\\[nrt]/)[0];
        const value = trimTrailing(rawValue, /[.)\]}>]/);
        const contextBefore = text
          .slice(Math.max(0, m.index - 40), m.index)
          .trimEnd()
          .toLowerCase();
        const duplicateDatabaseKey = contextBefore.endsWith("duplicate");
        // An Azure storage account key or an AWS secret pasted as someone's bucket key is still a credential.
        const cloudKey = /^[A-Za-z0-9+/]{40,88}={0,2}$/.test(value) && keyLike(value);
        const primaryCredential =
          /\bprimary[ _.-]key\b/i.test(lookupLabel) &&
          !duplicateDatabaseKey &&
          ((hexKey(value) && !isPlaceholder(value)) || cloudKey);
        const storageCredential = /(?:storage|s3)[ _.-]key\b/i.test(lookupLabel) && cloudKey;
        if (!primaryCredential && !storageCredential) return;
      }
      // A key named for a credential (api, access, secret, license…) is read whatever its value; any other key or
      // token holding a name or a file path is a lookup key.
      if (!CREDENTIAL_KEY_LABEL.test(lookupLabel) && namedValue(trimTrailing(told.split(/\\[nrt]/)[0], /[.)\]}>]/))) {
        return;
      }
      // A JSON string's \n or \t ends the value; what follows one is read again on its own (detector.js).
      const raw = told.split(/\\[nrt]/)[0];
      // A hex key's "sk-" also starts an OpenAI key, whose own rule turns it down for having no capitals.
      const hex = trimTrailing(raw, /[.)\]}>]/);
      // A public key is meant to be shared, so its label alone can't vouch for a hex value or a very long one,
      // like an age public key joined to the secret key on the line under it.
      const publicKey = /pub(?:lic|lishable)?[ _.-]?key/i.test(m[0].slice(0, -m[1].length));
      if (!publicKey && hexKey(hex) && !isPlaceholder(hex)) {
        if (!takenByItsOwnRule(hex)) found.push(hex);
        return;
      }
      const value = secretValue(raw, true, 16);
      if (value && (!publicKey || value.length <= 128) && keyLike(value) && !awsKeys.has(value)) found.push(value);
    };
    for (const m of text.matchAll(LABELLED_API_KEY)) labelledApiKey(m);
    forConfusableLabelMatches(text, LABELLED_API_KEY, labelledApiKey, hasConfusableLabel);
    for (const setting of namedSettings(text)) {
      const value = setting.kind === "key" && secretValue(setting.value, true, 16);
      if (value && (keyLike(value) || hexKey(value)) && !awsKeys.has(value)) found.push(value);
    }
    // An .npmrc line: whatever follows its _authToken= is the registry's token, whatever its length.
    for (const m of text.matchAll(NPMRC_TOKEN)) {
      const value = secretValue(m[1], false, 8);
      if (value) found.push(value);
    }
    for (const token of findPrefixedTokens(text)) found.push(token);
    return [...new Set(found)];
  }
  const NPMRC_TOKEN = /(?<![\w-]):?_authToken\s*=\s*["']?([^\s"']+)/g;
  // A key in hex, like DeepSeek's "sk-" and 32 hex characters, has less spread than keyLike asks of a mixed-case
  // key, so after a key's label it only has to look like random hex. Without a label, "sk-" and hex stays quiet.
  const hexKey = (v) =>
    /^(?:[a-z]{2,6}[-_])?[0-9a-f]{32,64}$/i.test(v) && looksRandomAnyCase(v.replace(/^[a-z]{2,6}[-_]/i, ""));
  // A key named for what it looks up rather than what it unlocks, like a cache, sort, partition or idempotency key or a
  // table's primary key, holds a hash or an ID, and "Cache saved with key: …" is a line of a CI log. A primary key in
  // an Azure portal can still be a real credential, so keep that label when its value has an Azure key shape.
  // A translation, message, Redis, bucket, React, storage, env, feature-flag, hash, map or registry key names a thing too.
  // Only said ones count: a setting named S3_KEY or STORAGE_KEY can hold the real key.
  const LOOKUP_KEY_WORD = String.raw`(?:cache|caching|sort|partition|primary|foreign|composite|object|idempotency|dedup(?:e|lication)?|lookup|row|routing|shard|range|index|search|unique|etag|checksum|with|from|by)`;
  const SAID_LOOKUP_KEY_WORD = String.raw`(?:${LOOKUP_KEY_WORD.slice(3, -1)}|translation|i18n|l10n|locale|message|msg|redis|s3|react|storage|env|flag|hash|map|dict|registry)`;
  // A page, cursor or CSRF token, or a model's padding and end-of-text tokens, is not a credential someone can reuse.
  const LOOKUP_TOKEN_LABEL =
    /(?:^|[^A-Za-z0-9])(?:next|page|continuation|pagination|cursor|csrf|xsrf|pad|eos|bos|unk|sep|cls|mask)[ _.-]token["'\]]?[^A-Za-z0-9]*$/i;
  // The word before "key" or "token" that makes it a credential whatever its value looks like.
  const CREDENTIAL_KEY_LABEL =
    /(?:api|access|secret|private|license|licence|product|service|auth|client|master|signing|encryption|account|admin|deploy|app|bearer|refresh|session|personal|bot|webhook)[ _.-]?(?:key|token)["'\]]?[^A-Za-z0-9]*$/i;
  // A value made of words and short numbers names something (user:12345:session:v2, home.hero.title_2024,
  // ERR_TOKEN_EXPIRED_401, HKEY_LOCAL_MACHINE\SOFTWARE\…), and a file path ends in an extension. A key has random parts.
  const NAMED_PART = /^(?:[a-z]+|[A-Z][a-z]+|[A-Za-z]+\d{1,4}|\d{1,8}|\d{1,4}[A-Za-z]{1,2})$/;
  function namedValue(v) {
    if (/^HKEY_[A-Z_]+\\/.test(v)) return true;
    if (/^[A-Z]+(?:_[A-Z]+\d{0,4}|_\d{1,4}){2,}$/.test(v)) return true;
    if (/^[\w.-]*(?:\/[\w.-]+)+\.[a-z][a-z0-9]{0,4}$/i.test(v) && !/\/\//.test(v)) return true;
    const parts = v.split(/[:._/#\\-]/);
    return parts.length >= 2 && parts.every((p) => NAMED_PART.test(p)) && parts.some((p) => /[a-z]{3}/i.test(p));
  }
  const LOOKUP_KEY_LABEL = new RegExp(
    String.raw`(?:^|[^A-Za-z0-9])${SAID_LOOKUP_KEY_WORD}[ _.-]key["'\]]?[^A-Za-z0-9]*(?:(?:string|str)[^A-Za-z0-9]*)?$`,
    "i",
  );
  const LOOKUP_KEY_NAME = new RegExp(String.raw`(?:^|[_.-])${LOOKUP_KEY_WORD}[_.-]key$`, "i");
  // Whether a provider's own rule reports the value, its checks included.
  const takenByItsOwnRule = (v) =>
    PATTERNS.some((p) => {
      if (!p.secret || !p.regex) return false;
      const m = new RegExp(p.regex.source, p.regex.flags.replace(/[gy]/g, "")).exec(v);
      return Boolean(m) && (!p.validate || p.validate(m[0]));
    });

  const TWILIO_CREDENTIALS_RE =
    /\b(?:TWILIO_ACCOUNT_SID|accountSid)\s*[:=]\s*["']?(AC[0-9a-fA-F]{32})["']?(?=[\s,;]*[,\n ;])[\s,;]+(?:TWILIO_AUTH_TOKEN|authToken)\s*[:=]\s*["']?([A-Za-z0-9_-]{16,256})/gi;
  const TWILIO_LABEL = /^(?:TWILIO_ACCOUNT_SID|accountSid|TWILIO_AUTH_TOKEN|authToken)\s*[:=]/i;
  // A credential wrapped onto a new line is read again with the break taken out. A line that starts one of its
  // labels is a setting of its own, not a wrap, and what the lines as written already hold wins, so the word on
  // the line after a credential stays out of it.
  function findTwilioCredentials(text) {
    return twilioSpans(text).map(([start, end]) => text.slice(start, end));
  }
  // Whether text[start, end) lies inside one of the text's SID and token pairs, which twilio_credentials reports
  // whole. Only that copy is left out of the label finders: the same token written again under a label of its own
  // is theirs, or Cover it would hide the pair and leave that copy. A binary search over the pairs in order, each
  // with the furthest end reached so far, answers it without reading the text again.
  function twilioLookup(text) {
    const spans = twilioSpans(text).sort((a, b) => a[0] - b[0]);
    let furthest = -1;
    const reach = spans.map(([, end]) => (furthest = Math.max(furthest, end)));
    return (start, end) => {
      let lo = 0;
      let hi = spans.length - 1;
      let last = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid][0] <= start) {
          last = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return last >= 0 && reach[last] >= end;
    };
  }
  function twilioSpans(text) {
    const spans = [...text.matchAll(TWILIO_CREDENTIALS_RE)]
      .filter((m) => looksRandomAnyCase(m[2]))
      .map((m) => [m.index, m.index + m[0].length]);
    // Only a break between two word characters is taken out. Each cut keeps where it falls in the joined text and
    // how much has been taken out up to there, so a match maps back to the text as written. Text with no such
    // break is never copied.
    const pieces = [];
    const cuts = [];
    let from = 0;
    let removed = 0;
    for (const m of text.matchAll(/\r\n|\r|\n/g)) {
      const next = m.index + m[0].length;
      if (
        /[A-Za-z0-9_]/.test(text[m.index - 1] || "") &&
        /[A-Za-z0-9_]/.test(text[next] || "") &&
        !TWILIO_LABEL.test(text.slice(next, next + 40))
      ) {
        pieces.push(text.slice(from, m.index));
        cuts.push([m.index - removed, removed + m[0].length]);
        removed += m[0].length;
        from = next;
      }
    }
    if (!cuts.length) return spans;
    pieces.push(text.slice(from));
    const sourceAt = (j) => {
      let shift = 0;
      for (const [at, total] of cuts) {
        if (at > j) break;
        shift = total;
      }
      return j + shift;
    };
    const asWritten = spans.length;
    for (const m of pieces.join("").matchAll(TWILIO_CREDENTIALS_RE)) {
      if (!looksRandomAnyCase(m[2])) continue;
      const start = sourceAt(m.index);
      const end = sourceAt(m.index + m[0].length - 1) + 1;
      if (!spans.slice(0, asWritten).some(([a, b]) => a < end && start < b)) spans.push([start, end]);
    }
    return spans;
  }

  const PATTERNS = [
    // --- Credentials (high) ---
    // `secret: true` drops placeholder matches. `validate` adds a check specific to that pattern.
    {
      id: "private_key",
      group: "credentials",
      name: "Private Key",
      severity: "high",
      find: findPrivateKeys,
    },
    {
      id: "aws_access_key",
      group: "credentials",
      secret: true,
      name: "AWS Access Key",
      severity: "high",
      find: findAwsAccessKeys,
    },
    {
      id: "github_token",
      group: "credentials",
      secret: true,
      name: "GitHub Token",
      severity: "high",
      regex:
        /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}(?![A-Za-z0-9_])|\bghs_[0-9]{1,20}_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_.-])/g,
      validate: (m) => {
        if (!m.startsWith("ghs_")) return true;
        const appIdEnd = m.indexOf("_", 4);
        return appIdEnd < 0 || looksRandomAnyCase(m.slice(appIdEnd + 1).replace(/\./g, ""));
      },
    },
    {
      id: "stripe_secret_key",
      group: "credentials",
      secret: true,
      name: "Stripe Secret Key",
      severity: "high",
      // A webhook's signing secret (whsec_…) lets anyone forge Stripe's events to that site.
      regex: /\b(?:[sr]k_live_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g,
    },
    {
      id: "anthropic_key",
      group: "credentials",
      secret: true,
      name: "Anthropic API Key",
      severity: "high",
      regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
      validate: (m) => looksRandom(m.replace(/^sk-ant-(?:[a-z]+\d+-)?/, "")),
    },
    {
      id: "openai_key",
      group: "credentials",
      secret: true,
      name: "OpenAI API Key",
      severity: "high",
      regex: /\bsk-(?!ant-|or-v1-)(?:proj-)?[A-Za-z0-9_-]{20,}/g,
      validate: (m) => looksRandom(m.replace(/^sk-(?:proj-)?/, "")),
    },
    {
      id: "xai_key",
      group: "credentials",
      secret: true,
      name: "xAI API Key",
      severity: "high",
      // Same `xai-` prefix shadow-ai-dlp matches (MIT, Erik Sanchez, see THIRD-PARTY-NOTICES), with the same
      // randomness check Clotr already runs on Anthropic and OpenAI keys on top of the prefix match.
      regex: /\bxai-[A-Za-z0-9_-]{16,}/g,
      validate: (m) => looksRandom(m.replace(/^xai-/, ""), 16),
    },
    {
      id: "google_api_key",
      group: "credentials",
      secret: true,
      name: "Google API Key",
      severity: "high",
      regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, // it may end in "-" (no \b after it)
    },
    {
      id: "slack_token",
      group: "credentials",
      secret: true,
      name: "Slack Token",
      severity: "high",
      regex:
        /(?:\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bxoxe\.xox[abp]-[A-Za-z0-9-]{20,200}(?![A-Za-z0-9-])|\bxoxe\.xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]{20,100}(?![A-Za-z0-9-])|\bxoxe-\d-[A-Za-z0-9-]{20,200}(?![A-Za-z0-9-])|\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]{20,100}(?![A-Za-z0-9-])|\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{1,40}\/B[A-Za-z0-9_]{1,40}\/[A-Za-z0-9_]{16,100}(?![A-Za-z0-9_]))/g,
      validate: (m) => {
        if (m.startsWith("xoxe.xapp-")) return looksRandomAnyCase(m.slice(m.lastIndexOf("-") + 1));
        if (m.startsWith("xapp-")) return looksRandomAnyCase(m.slice(m.lastIndexOf("-") + 1));
        if (m.startsWith("xoxe-")) return looksRandomAnyCase(m.slice(m.lastIndexOf("-") + 1));
        if (m.startsWith("xoxe.")) return looksRandomAnyCase(m.slice(m.lastIndexOf("-") + 1));
        if (m.startsWith("https://hooks.slack.com/")) return looksRandomAnyCase(m.slice(m.lastIndexOf("/") + 1));
        // A bot, user or app token carries its workspace's and user's numbers, a random part, or both. Words alone
        // ("not-a-real-token" after the prefix) or counting digits ("1234-5678-abcd") are a docs placeholder.
        const tail = m.slice(m.lastIndexOf("-") + 1);
        if (looksRandomAnyCase(tail) || (tail.length >= 20 && looksRandomLetters(tail))) return true;
        // Random letters swap case often; a camelCase name ("notARealToken") only at each word.
        if (/^[A-Za-z]{8,}$/.test(tail) && (tail.match(/[a-z][A-Z]/g) || []).length >= 3) return true;
        const digits = m.slice(5).replace(/\D/g, "");
        return digits.length > 0 && !isPlaceholder(digits);
      },
    },
    {
      id: "gitlab_token",
      group: "credentials",
      secret: true,
      name: "GitLab Token",
      severity: "high",
      regex:
        /(?:\bglpat-[A-Za-z0-9_-]{20,300}(?:\.[a-z0-9]{9})?|\bgldt-[A-Za-z0-9_-]{20,300}|\bglcbt-(?:[0-9a-fA-F]{2}_)?[A-Za-z0-9_-]{20,300}|\bglrt-(?:t\d_[A-Za-z0-9_-]{27,300}\.[a-z0-9]{9}|[A-Za-z0-9_-]{20,300})|\bglft-[A-Za-z0-9_-]{20,300}|\bglsoat-[A-Za-z0-9_-]{20,300}|\bglagent-[A-Za-z0-9_-]{50,1024}|\bgloas-[A-Za-z0-9_-]{64}|\bglptt-[0-9a-f]{40}|\bglffct-[A-Za-z0-9_-]{20}|\bglimt-[A-Za-z0-9_-]{25}|\bGR1348941[A-Za-z0-9_-]{20})(?![A-Za-z0-9_-])/g,
      validate: (m) => {
        const body = m.replace(/^(?:gl(?:pat|dt|cbt|rt|ft|soat|agent|oas|ptt|ffct|imt)-?|GR1348941)/, "");
        const randomBody = body
          .replace(/\.[a-z0-9]{9}$/, "")
          .replace(/^t\d_/, "")
          .replace(/^[0-9a-fA-F]{2}_/, "");
        const normalizedBody = randomBody.replace(/[-_]/g, "");
        return looksRandomAnyCase(normalizedBody) || looksRandomLetters(normalizedBody);
      },
    },
    {
      id: "perplexity_key",
      group: "credentials",
      secret: true,
      name: "Perplexity API Key",
      severity: "high",
      regex: /\bpplx-[A-Za-z0-9]{16,128}(?![A-Za-z0-9])/g,
      validate: (m) => looksRandomAnyCase(m.slice(5)),
    },
    {
      id: "digitalocean_token",
      group: "credentials",
      secret: true,
      name: "DigitalOcean Token",
      severity: "high",
      regex: /\bd(?:op|oo|or)_v1_[0-9a-fA-F]{64}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(7)),
    },
    {
      id: "huggingface_token",
      group: "credentials",
      secret: true,
      name: "Hugging Face Token",
      severity: "high",
      regex: /\b(?:hf_|api_org_)[A-Za-z]{34}\b/g,
      validate: (m) => looksRandomLetters(m.slice(m.startsWith("hf_") ? 3 : 8)),
    },
    {
      id: "heroku_token",
      group: "credentials",
      secret: true,
      name: "Heroku Token",
      severity: "high",
      regex: /\bHRKU-[A-Za-z0-9_-]{60}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(5)),
    },
    {
      id: "onepassword_token",
      group: "credentials",
      secret: true,
      name: "1Password Token",
      severity: "high",
      regex:
        /(?:\bops_eyJ[A-Za-z0-9+/=_-]{250,4096}(?![A-Za-z0-9+/=_-])|\bA3-[A-Z0-9]{6}-(?:[A-Z0-9]{11}|[A-Z0-9]{6}-[A-Z0-9]{5})-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b)/g,
      validate: (m) => looksRandomAnyCase(m.startsWith("ops_") ? m.slice(4) : m.replace(/-/g, "").slice(2)),
    },
    {
      id: "cloudflare_origin_ca_key",
      group: "credentials",
      secret: true,
      name: "Cloudflare Origin CA Key",
      severity: "high",
      regex: /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(5).replace(/-/g, "")),
    },
    {
      id: "twilio_credentials",
      group: "credentials",
      secret: true,
      name: "Twilio Credentials",
      severity: "high",
      find: findTwilioCredentials,
    },
    // Developer tools' tokens, each in the shape its provider documents. A key or token label in front still
    // names the provider, since the labelled-key check leaves out any value one of these regexes recognizes.
    {
      id: "sentry_token",
      group: "credentials",
      secret: true,
      name: "Sentry Auth Token",
      severity: "high",
      // User, app and integration tokens are 64 hex. An organization token is base64 JSON about the org, then
      // "_" and a 43-character base64 secret.
      regex: /\bsntry(?:[uai]_[0-9a-f]{64}\b|s_eyJ[A-Za-z0-9+/]{20,1000}={0,2}_[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=_-]))/g,
      validate: (m) => (m.startsWith("sntrys_") ? looksRandom(m.slice(-43)) : looksRandomAnyCase(m.slice(7))),
    },
    {
      id: "grafana_token",
      group: "credentials",
      secret: true,
      name: "Grafana Token",
      severity: "high",
      // A service account token ends in "_" and an 8-hex checksum. A Grafana Cloud token is one base64 run, and so is
      // an older API key, whose "eyJrIjoi" is base64 of the start of its JSON.
      regex:
        /\b(?:gl(?:sa_[A-Za-z0-9]{32}_[0-9a-f]{8}\b|c_[A-Za-z0-9+/]{32,400}={0,3}(?![A-Za-z0-9+/=]))|eyJrIjoi[A-Za-z0-9]{70,400}={0,3}(?![A-Za-z0-9+/=]))/g,
      validate: (m) => {
        if (m.startsWith("glsa_")) return looksRandom(m.slice(5, 37));
        return looksRandom(m.slice(m.startsWith("glc_") ? 4 : 8).replace(/=+$/, ""));
      },
    },
    {
      id: "vault_token",
      group: "credentials",
      secret: true,
      name: "HashiCorp Vault Token",
      severity: "high",
      // Service, batch and recovery tokens. Vault only promises 24 characters or more after the prefix.
      regex: /\bhv[sbr]\.[A-Za-z0-9_-]{24,1000}(?![A-Za-z0-9_-])/g,
      validate: (m) => looksRandom(m.slice(4), 24),
    },
    {
      id: "replicate_token",
      group: "credentials",
      secret: true,
      name: "Replicate API Token",
      severity: "high",
      regex: /\br8_[A-Za-z0-9]{37}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(3)),
    },
    {
      id: "linear_key",
      group: "credentials",
      secret: true,
      name: "Linear API Key",
      severity: "high",
      regex: /\blin_api_[A-Za-z0-9]{40}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(8)),
    },
    {
      id: "postman_key",
      group: "credentials",
      secret: true,
      name: "Postman API Key",
      severity: "high",
      regex: /\bPMAK-[0-9a-fA-F]{24}-[0-9a-fA-F]{34}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(5).replace("-", "")),
    },
    {
      id: "shopify_token",
      group: "credentials",
      secret: true,
      name: "Shopify Access Token",
      severity: "high",
      // Admin API, custom app and delegate access tokens, and an app's shared secret.
      regex: /\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(6)),
    },
    {
      id: "atlassian_token",
      group: "credentials",
      secret: true,
      name: "Atlassian API Token",
      severity: "high",
      // An account's API token or an organization's admin key. Atlassian treats the body as opaque and may change
      // its length, so the length here is a range around today's tokens, which end in "=" and an 8-character
      // checksum.
      regex: /\bAT[AC]TT3[A-Za-z0-9_=-]{150,250}=[A-Za-z0-9]{8}(?![A-Za-z0-9_=-])/g,
      validate: (m) => looksRandom(m.slice(6, -9)),
    },
    {
      id: "netlify_token",
      group: "credentials",
      secret: true,
      name: "Netlify Access Token",
      severity: "high",
      // Personal, CLI, OAuth, app and build tokens.
      regex: /\bnf[pcoub]_[A-Za-z0-9_]{36}(?![A-Za-z0-9_])/g,
      validate: (m) => looksRandomAnyCase(m.slice(4)),
    },
    {
      id: "pulumi_token",
      group: "credentials",
      secret: true,
      name: "Pulumi Access Token",
      severity: "high",
      regex: /\bpul-[a-z0-9]{40}\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(4)),
    },
    {
      id: "databricks_token",
      group: "credentials",
      secret: true,
      name: "Databricks Access Token",
      severity: "high",
      // Some end in "-" and a digit.
      regex: /\bdapi[0-9a-fA-F]{32}(?:-\d)?\b/g,
      validate: (m) => looksRandomAnyCase(m.slice(4, 36)),
    },
    // Covers the keys from several other services under one Settings row: Hugging Face, npm, PyPI,
    // GitLab, SendGrid, Twilio, Mailgun, DigitalOcean, Telegram and Discord bots, Azure storage
    // and service-bus keys, Tailscale, Fly.io, NuGet and crates.io, and Slack or Discord
    // webhook URLs, since anyone with one of those URLs can post as the bot that owns it.
    // The service-token row (below) also holds the provider tokens in PREFIXED_TOKENS: Google OAuth,
    // Microsoft Entra and Azure DevOps, Azure storage signatures, Okta, and developer platforms
    // like Docker Hub, Supabase, Notion, Terraform Cloud, Doppler and Square.
    {
      id: "crypto_secret",
      group: "credentials",
      name: "Crypto Wallet Seed or Key",
      severity: "high",
      find: findCryptoSecrets,
      labelAnywhere: SEED_LABEL,
    },
    {
      id: "service_token",
      group: "credentials",
      secret: true,
      name: "Service Access Token",
      severity: "high",
      find: findServiceTokens,
    },

    {
      id: "connection_string",
      group: "credentials",
      name: "Database/Service Connection String",
      severity: "high",
      find: findConnectionStrings,
    },
    { id: "jwt", group: "credentials", secret: true, name: "Login Token (JWT)", severity: "high", regex: JWT_RE },
    { id: "internal_ip", group: "credentials", name: "Internal IP Address", severity: "medium", find: findInternalIPs },
    {
      id: "internal_host",
      group: "credentials",
      name: "Internal Hostname",
      severity: "medium",
      find: findInternalHosts,
    },
    {
      id: "otp_secret",
      group: "credentials",
      name: "Two-Step Sign-in Key",
      severity: "high",
      find: findOtpSecrets,
    },
    {
      id: "backup_codes",
      group: "credentials",
      name: "Backup Codes",
      severity: "high",
      find: findBackupCodes,
      labelAnywhere: RECOVERY_WORD,
    },
    { id: "password", group: "credentials", name: "Password or Secret", severity: "high", find: findSecrets },

    // --- Personal data ---
    // Phone, SSN and email use find() instead of a single regex, so they also catch
    // spelled-out and mixed forms ("five five five…", "5fivefiv5…", "bob at gmail dot com").
    { id: "us_ssn", group: "personal", name: "US Social Security Number", severity: "high", find: findSSNs },
    { id: "credit_card", group: "personal", name: "Credit Card Number", severity: "high", find: findCards },
    // These are the codes a scammer asks you to read out, so `bandage: false` keeps their own warning,
    // which already says what they are, instead of letting Bandage cover them with a generic label.
    {
      id: "card_code",
      group: "personal",
      name: "Card Security Code",
      severity: "high",
      bandage: false,
      find: findCardCodes,
    },
    {
      id: "gift_card",
      group: "personal",
      name: "Gift Card Code",
      severity: "high",
      bandage: false,
      find: findGiftCards,
    },
    {
      id: "stripe_publishable_key",
      group: "credentials",
      secret: true,
      name: "Stripe Publishable Key",
      severity: "medium",
      regex: /\bpk_live_[A-Za-z0-9]{24,}\b/g,
    },
    { id: "street_address", group: "personal", name: "Street Address", severity: "medium", find: findAddresses },
    {
      id: "bank_account",
      group: "personal",
      name: "Bank Account or Routing Number",
      severity: "high",
      find: (text) => [...findBankNumbers(text), ...findIbans(text)],
    },
    { id: "national_id", group: "personal", name: "National ID Number", severity: "high", find: findNationalIds },
    {
      id: "medical_record",
      group: "personal",
      name: "Medical Record Number",
      severity: "high",
      find: findMedicalRecords,
    },
    { id: "public_ip", group: "personal", name: "Your IP Address", severity: "medium", find: findMyIps },
    { id: "medicare_id", group: "personal", name: "Medicare Number", severity: "high", find: findMedicare },
    { id: "passport", group: "personal", name: "Passport Number", severity: "high", find: findPassports },
    {
      id: "drivers_license",
      group: "personal",
      name: "Driver's License Number",
      severity: "medium",
      find: findLicenses,
    },
    // These two are only found in an attached picture, never in text, so `find` gives nothing back and
    // detect() never reports them on its own. One is the place a photo was taken, when the camera saved
    // that inside the file. The other is a picture, or a text-free scan, whose file name says it's an ID
    // or a document, like "passport-scan.jpg".
    {
      id: "photo_location",
      group: "personal",
      name: "Photo Location",
      severity: "medium",
      picture: true,
      find: () => [],
    },
    {
      id: "id_picture",
      group: "personal",
      name: "ID or Document Picture",
      severity: "medium",
      picture: true,
      find: () => [],
    },
    { id: "insurance_id", group: "personal", name: "Insurance Member ID", severity: "medium", find: findInsuranceIds },
    { id: "vin", group: "personal", name: "Vehicle Identification Number", severity: "medium", find: findVins },
    { id: "student_id", group: "personal", name: "Student ID Number", severity: "medium", find: findStudentIds },
    // Starts as Just count, so it's counted but never shown unless the person switches it to Warn.
    { id: "license_plate", group: "personal", name: "License Plate", severity: "low", start: "log", find: findPlates },
    // Starts as Just count too.
    { id: "gamer_tag", group: "personal", name: "Gamer Tag", severity: "low", start: "log", find: findGamerTags },
    { id: "date_of_birth", group: "personal", name: "Date of Birth", severity: "medium", find: findBirthDates },
    { id: "phone_number", group: "personal", name: "Phone Number", severity: "medium", find: findPhones },
    { id: "my_name", group: "personal", name: "Your Name", severity: "high", find: findVault("my_name") },
    {
      id: "family_name",
      group: "personal",
      name: "Family Member's Name",
      severity: "high",
      find: findVault("family_name"),
    },
    { id: "employer", group: "personal", name: "Your Employer", severity: "medium", find: findVault("employer") },
    { id: "my_id", group: "personal", name: "Your Account/ID Number", severity: "high", find: findVault("my_id") },
    { id: "watch_list", group: "custom", name: "Watch List Item", severity: "medium", find: findVault("watch_list") },
    { id: "email", group: "personal", name: "Email Address", severity: "low", find: findEmails },

    // --- Links ---
    // Its own Settings group, so the switch for personal details doesn't hold it, and `bandage: false` keeps
    // Bandage from covering it while typing: a link isn't finished until the whole thing is there to clean.
    {
      id: "share_link",
      group: "links",
      name: "Share Code in a Link",
      severity: "low",
      bandage: false,
      find: findShareLinks,
      replace: cleanShareLink,
    },
  ];
  // Names in the browser's language (English is the name written above).
  for (const p of PATTERNS) p.name = msg(`type_${p.id}`, p.name);

  globalThis.Clotr = {
    ...(globalThis.Clotr || {}),
    PATTERNS,
    ASK_REASONS,
    askLabels,
    numberRuns,
    isPlaceholder,
    setVault,
    vaultKinds,
    isVaultFormat,
    addressCore,
    msg,
    cleanableParamsOf,
    cleanShareLink,
    findShareLinks,
    sha256Bytes,
  };
})();

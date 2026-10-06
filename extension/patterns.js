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

  // ---------- Fewer false alarms for credentials ----------

  // Skips placeholder keys from docs and examples, like AWS's own AKIAIOSFODNN7EXAMPLE, since nobody's
  // real key looks like that.
  function isPlaceholder(m) {
    if (/example|your[_-]?(api[_-]?)?(key|token|secret)|placeholder|dummy|redacted|insert[_-]?here/i.test(m))
      return true;
    if (/JBSW\s?Y3DP\s?EHPK\s?3PXP/i.test(m)) return true; // the two-step sign-in documentation's example secret
    if (/(.)\1{5,}/.test(m)) return true; // six of the same character in a row
    let run = 1; // a long alphabet/number sequence: ABCDEFGH, 12345678
    for (let i = 1; i < m.length; i++) {
      run = m.charCodeAt(i) === m.charCodeAt(i - 1) + 1 && /[A-Za-z0-9]/.test(m[i]) ? run + 1 : 1;
      if (run >= 8) return true;
    }
    return false;
  }

  function entropy(s) {
    const counts = {};
    for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
    return Object.values(counts).reduce((h, c) => h - (c / s.length) * Math.log2(c / s.length), 0);
  }

  // A prefix like "sk-" can also start an ordinary word, like "sk-learn-". So I check that what follows it
  // actually looks machine-made: mixed case, digits, and long unbroken runs instead of a slug's dashes.
  function looksRandom(body) {
    return (
      body.length >= 20 &&
      /\d/.test(body) &&
      /[a-z]/.test(body) &&
      /[A-Z]/.test(body) &&
      Math.max(...body.split(/[-_]/).map((seg) => seg.length)) >= 12 &&
      entropy(body) >= 3.5
    );
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
  // Longest words first, so "seventeen" wins over "seven" and "three" over "thre".
  const UNIT_RE = new RegExp(
    `\\d|${Object.keys(ALL_WORDS)
      .sort((a, b) => b.length - a.length)
      .join("|")}|[Ool]`,
    "iy",
  );
  // What may sit between digits of one number: spaces, dashes, dots, commas, parentheses, slashes, plus.
  const SEPARATOR_RE = /^[ \t \-–.,()/+_*]{1,3}$/;
  const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);
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

  // A whole word that is a slip of a digit word (SLIP_WORDS), read as a sound-alike. A slip of two different
  // digits ("fine": "five" or "nine") is neither.
  const WORD_AT = /\p{L}+/uy;
  function readSlip(text, start) {
    WORD_AT.lastIndex = start;
    const s = WORD_AT.exec(text)[0];
    const w = s.toLowerCase();
    if (s.length < 4 || s.length > 7 || Object.hasOwn(ALL_WORDS, w)) return null;
    const words = Object.keys(SLIP_WORDS).filter((word) => oneSlip(w, word));
    const digits = new Set(words.map((word) => SLIP_WORDS[word]));
    if (digits.size !== 1) return null;
    const es = words.filter((word) => SPANISH.has(word)).length;
    return {
      start,
      end: start + s.length,
      digits: [...digits][0],
      kind: "weak",
      isWord: true,
      slip: true,
      lang: es === words.length ? "es" : es === 0 ? "en" : undefined,
    };
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
    const units = [];
    for (let i = 0; i < text.length;) {
      UNIT_RE.lastIndex = i;
      const slip = isLetter(text[i]) && !isLetter(text[i - 1]) ? readSlip(text, i) : null;
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
    const placed = withPlaces(withPlaces(merged, 2), 3).filter((u) => u.kind !== "mult");

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
      const last = units.findLastIndex(strong);
      if (first < 0) {
        keepSoundAlikePhones(units);
        continue;
      }
      const core = units.slice(first, last + 1);
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
        +core[k - 1].digits < +core[k + 1].digits &&
        setOff(core[k - 2], core[k - 1]) &&
        setOff(core[k + 1], core[k + 2]);
      if (core.some((u, k) => range(k))) continue; // "two to four, five to seven": ranges
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
      const after = edge(last + 1, 1);
      // Every edge-word combination, fewest first (a 7-digit local phone number only with none).
      const combos = [];
      for (let n = 0; n <= before.length + after.length; n++)
        for (let i = Math.min(n, before.length); i >= 0; i--) {
          if (n - i > after.length) continue;
          const lead = before.slice(0, i).reverse();
          const trail = after.slice(0, n - i);
          combos.push({ lead, trail, all: [...lead, ...core, ...trail] });
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
      // Only once no phone reading fits do I try an SSN or card, and only because of an actual "to" or "for" in
      // the run, never an ordinary sound-alike: a run of sound-alikes alone can already be nine digits long and
      // loose enough to pass the SSN shape by chance, which coreAllWords above guards against.
      for (const { lead, trail, all } of combos) {
        if (pick) break;
        const simple =
          coreAllWords &&
          [...inside, ...lead, ...trail].some(linking) &&
          all.every((u) => u.digits.length === 1) &&
          !/[,;.]/.test(spanText(text, [all]));
        if (!isCount(all) && wholeSsnOrCard(digits(all), simple)) pick = [...lead, ...trail];
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

  const spanText = (text, groups) => text.slice(groups[0][0].start, groups[groups.length - 1].at(-1).end);
  const digitsOf = (groups) =>
    groups
      .flat()
      .map((u) => u.digits)
      .join("");
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
  // Tests whether the digits alone form an SSN (9 digits, valid shape) or a card number (13 to 19 digits that
  // start 3 to 6 and pass Luhn). This only runs inside a spelled-out run with a "to" or "for" somewhere in it,
  // where every word is a single digit ("two", never "twenty" or "double") and nothing is set off by a comma,
  // semicolon or full stop, so a real SSN or card reads in one breath and something like "Final scores: two
  // to one, three to two" doesn't match by chance. "To"/"for" only ever supply an edge digit next to a fully
  // spelled number (keepSoftUnits above), so this never catches a count or price next to "for"/"to".
  const wholeSsnOrCard = (d, simple) =>
    simple &&
    ((d.length === 9 && VALID_SSN_SHAPE.test(d)) || (d.length >= 13 && d.length <= 19 && /^[3-6]/.test(d) && luhn(d)));
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
    return text.slice(start - (plus ? plus[0].length : 0), run.groups[end].at(-1).end);
  }

  // A phone number cut out of a longer run of digits still has to be phone-shaped, so a list like "1, 2, 3, 5,
  // 8, 13, 21, 34" isn't read as one. A whole run, on the other hand, can be grouped any way and still count.
  const PHONE_SHAPES = new Set(["10", "11", "3,3,4", "1,3,3,4", "3,4", "3,7"]);
  // Digits glued to letters belong to a bigger token (a hash, UUID or model number).
  const glued = (text, span) => {
    const first = span[0][0];
    const last = span.at(-1).at(-1);
    // An extension right after the number ("555-555-0136x12") doesn't make it part of a word.
    const extension = /^x\d{1,5}\b/i.test(text.slice(last.end, last.end + 7));
    return (
      (first.kind === "digit" && isLetter(text[first.start - 1])) ||
      (last.kind === "digit" && isLetter(text[last.end]) && !extension)
    );
  };

  // When a phone word sits right before a number, like "llámame al …" or "my cell is …", I read 9 digits as a
  // phone number, common in Spain, much of Europe and Latin America, rather than a US Social Security number.
  const PHONE_CONTEXT =
    /(?:\b(?:call|text|phone|cell|mobile|whatsapp|tel)|ll[aá]mame|llamar|llama|tel[eé]fono|m[oó]vil|celular|fijo|n[uú]mero)\b[^\d\n]{0,20}$/i;
  // An SSN label right before the number, like "ssn: 219099999" or "social security #…", beats a phone word
  // that's further back, as in "<phone>…</phone><ssn>…".
  const SSN_LABEL =
    /\b(?:s\.?s\.?n\.?|ss\s*#|soc(?:ial)?\.?\s+sec(?:urity|\.)?(?:[\s_]+(?:number|no\.?|#))?|social(?:[\s_]+security)?(?:[\s_]+(?:number|no\.?|#))?)["']?\s*(?:is\s*)?[:=>#-]?\s*["']?$/i;
  const ssnLabelBefore = (text, run) =>
    SSN_LABEL.test(text.slice(Math.max(0, run.units[0].start - 30), run.units[0].start));
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
    const end = run.units.at(-1).end;
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

  // A number labelled as something else isn't read as a phone, as with "Order #445-2231987" or "meeting ID is
  // 845 2931 7710". The label can sit a few words back, like "El ID de la reunión de Zoom es …", but a phone
  // word after it wins instead, as in "about the order, call me at …".
  const OTHER_NUMBER_BEFORE =
    /(?:#\s*$|(?<![\p{L}])(?:order|invoice|ticket|case|ref(?:erence)?|tracking|confirmation|booking|reservation|meeting|claim|serial|model|part|sku|po|pedido|factura|referencia|reuni[oó]n|reserva|localizador|nhs|medicare|aadhaar|aadhar|tfn|tax\s+file|clabe|cbu|cvu|cci|iban|(?:request|transaction|trace|session|correlation|device)[\s_-]*id)(?![\p{L}])[^\d\n]{0,25}$)/iu;
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
  function inVinCode(text, run) {
    const at = run.units[0].start;
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

  function findPhones(text) {
    const found = [];
    for (const run of numberRuns(text)) {
      if (labelledAsOther(text, run) || tollFree(digitsOf(run.groups)) || counting(text, run)) continue;
      if (ndcCode(text, run) || inVinCode(text, run) || windowsSid(text, run)) continue;
      if (localPhone(text, run)) {
        found.push(spanText(text, run.groups));
        continue;
      }
      if (digitsOf(run.groups).length === 9 && phoneContextBefore(text, run)) {
        found.push(spanText(text, run.groups));
        continue;
      }
      // A dotted IPv4 address ("73.162.44.201") has phone-like digits but isn't one.
      const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(spanText(text, run.groups));
      if (ip && ip.slice(1).every((n) => Number(n) <= 255)) continue;
      const intl = internationalPhone(text, run);
      if (intl) {
        found.push(intl);
        continue;
      }
      const g = run.groups;
      for (let s = 0; s < g.length;) {
        let bestEnd = -1;
        let len = 0; // digits in g[s..e], counted as the span grows
        for (let e = s; e < g.length; e++) {
          for (const u of g[e]) len += u.digits.length;
          if (len > 11) break;
          if (len !== 7 && len < 10) continue; // a phone has 7, 10 or 11 digits (isPhone)
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
          found.push(text.slice(first - lead, g[bestEnd].at(-1).end));
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
  const CARD_GROUPS = /^(?:\d+|(?:\d{4}[ -])+\d{1,4}|\d{4}[ -]\d{6}[ -]\d{4,5})$/;
  // The digits of an IBAN, or of a code shaped like one such as "es16 3435 8224 …" in any case, aren't a
  // card. An IBAN printed in groups of four has a run of digits that happens to pass the Luhn sum about 1
  // time in 10.
  const IBAN_SHAPED = /\b[a-z]{2}\d{2}(?: ?[a-z0-9]{4}){2,7}(?: ?[a-z0-9]{1,4})?\b/gi;
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
      ibans ??= [...text.matchAll(IBAN_SHAPED)].map((i) => [i.index, i.index + i[0].length]);
      while (k < ibans.length && ibans[k][1] <= m.index) k++;
      return k < ibans.length && ibans[k][0] < m.index + m[0].length;
    };
    const found = [...text.matchAll(CARD_RE)]
      .filter(
        (m) =>
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
    return found;
  }

  // Finds an SSN written in digits inside a longer list, like "555-555-5636, 219-09-9999": a 3-2-4 group set
  // off by a comma or semicolon, with no comma inside it. A comma followed by a space also joins the parts of a
  // spelled-out phone number, so the number reader keeps those in one run instead of splitting them here.
  // This cuts a run at its list breaks into [[group, …], …].
  const listBreakAfter = (text, groups, i) =>
    i < groups.length - 1 && /[,;]/.test(text.slice(groups[i].at(-1).end, groups[i + 1][0].start));
  function listChunks(text, groups) {
    const chunks = [[]];
    groups.forEach((g, i) => {
      chunks.at(-1).push(g);
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
      if (/^\d{3}-?\d{2}-?\d{4}$/.test(v) && /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(v.replace(/-/g, "")))
        found.push(v);
    }
    return found;
  }

  function findSSNs(text) {
    const found = ssnColumn(text);
    for (const run of numberRuns(text)) {
      const d = digitsOf(run.groups);
      if (d.length !== 9) {
        found.push(...listedSSNs(text, run.groups));
        continue;
      }
      if (phoneContextBefore(text, run)) continue; // "call me at …": a 9-digit phone number, not an SSN
      if (counting(text, run)) continue;
      // Digits need the 3-2-4 shape unless an SSN label says what they are, or the message itself does.
      // Spelled-out numbers can be written any way.
      if (
        !hasWord(run.groups) &&
        sizesOf(run.groups) !== "3,2,4" &&
        !ssnLabelBefore(text, run) &&
        !bareSSNContext(text, run)
      )
        continue;
      if (!/^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(d)) continue;
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

  function findEmails(text) {
    return [
      ...(text.match(EMAIL_RE) || []),
      ...(text.match(EMAIL_BRACKETED) || []),
      ...(text.match(EMAIL_WORDED) || []),
      ...[...text.matchAll(EMAIL_NO_TLD)].map((m) => m[1]),
    ];
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
  const SUFFIX = String.raw`(?:street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|trail|trl|square|sq|loop|pike|crescent|cres)\.?`;
  const UNIT = String.raw`(?:,?\s+(?:apt|apartment|unit|suite|ste|#)\.?\s*#?\s*[A-Za-z0-9-]+)?`;
  // This only matches within one line (using [^\S\n] for spaces, not line breaks), since a match that ran on
  // from a ZIP code into the next line used to hide the address written there.
  const STREET_RE = new RegExp(
    String.raw`\b(?<num>${HOUSE_NUM})[^\S\n]+(?:(?<pre>${DIRECTION})[^\S\n]+)?(?<name>(?:[A-Za-z0-9][\w'.-]*[^\S\n]+){0,3}?[A-Za-z0-9][\w'.-]*)[^\S\n]+(?<suf>${SUFFIX})(?:[^\S\n]+(?<post>${DIRECTION}))?(?![\w])${UNIT}`,
    "gi",
  );
  const PO_BOX_RE = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*#?\s*\d{1,6}\b/gi;
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
    const box = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*#?\s*(\d{1,6})\b/i.exec(text);
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
  const COORD = String.raw`-?\d{1,3}\.\d{4,}°?\s*[NSEW]?`;
  const HOME_COORDINATES = new RegExp(
    String.raw`(?<![\p{L}])(?:my\s+(?:home|house|place|apartment|flat|address)|I\s+live|mi\s+(?:casa|piso|domicilio)|vivo)(?![\p{L}])[^\n\d-]{0,25}(${COORD}\s*,?\s*${COORD})`,
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
    const canon = (ES_TYPE_CANON.find(([re]) => re.test(type)) || [null, type])[1];
    return [canon, ...rest].join(" ");
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
    const last = name.split(/\s+/).at(-1);
    if (!/^Dr\.?$/.test(suf) || !(/^\p{Ll}/u.test(last) || BEFORE_A_TITLE.test(last))) return false;
    const at = m.index + m[0].lastIndexOf(suf);
    if (!NAME_AFTER_TITLE.test(text.slice(at, at + 60))) return false;
    const tail = CITY_STATE_ZIP.exec(text.slice(at + suf.length));
    return !(tail && /\d{5}/.test(tail[0]));
  }
  function findAddresses(text) {
    const found = [];
    const withTail = (start, end) => {
      const tail = CITY_STATE_ZIP.exec(text.slice(end));
      found.push(text.slice(start, end + (tail ? tail[0].length : 0)));
    };
    STREET_RE.lastIndex = 0;
    for (let m; (m = STREET_RE.exec(text));) {
      // A word followed by its sentence's full stop means whatever comes after is the next sentence, as in "5
      // minutes. Drive safe!" or even uncapitalized, "2 tickets. elm street…", since no real street name has a
      // full stop after a whole word. I pick the search back up from the next number, as in "…5 minutes. 42
      // Oak Street".
      const typed = m.groups.name.split(/[^\S\n]+/);
      const words = typed.map((w) => w.replace(/\.+$/, ""));
      if (typed.some((w, k) => w !== words[k] && dotEndsSentence(words[k]))) {
        STREET_RE.lastIndex = m.index + m.groups.num.length;
        continue;
      }
      if (words.some((w) => NOT_A_STREET.has(w.toLowerCase()))) continue;
      const yearLike = /^(?:19|20)\d\d$/.test(m[0].split(/\s/)[0]);
      if (yearLike && YEAR_BEFORE.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (doctorNotDrive(text, m)) continue;
      withTail(m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(PO_BOX_RE)) withTail(m.index, m.index + m[0].length);
    for (const m of text.matchAll(ES_STREET_RE)) found.push(m[0]);
    for (const m of text.matchAll(HOME_COORDINATES)) found.push(m[1]);
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
      )
        found.push(s[0]);
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
  const DATE_RE = new RegExp(
    String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{1,2}-\d{1,2}` +
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
    String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{1,2}-\d{1,2}|${DIA}\s+de\s+(?:${MESES})(?:\s+(?:de|del)\s+${ANIO})?)(?![\p{L}\d/])`,
    "iuy",
  );
  // Matches birth words like "nací", "nacido el …", "fecha de nacimiento" and "cumpleaños".
  const BIRTH_WORDS_ES =
    /(?<![\p{L}])(?:nac[ií]|naci[oó]|nacid[oa]s?|(?:fecha\s+de\s+)?nacimiento|fecha\s+(?:de\s+)?nac\.?|cumplea(?:ñ|n)os)(?:\s*:\s*|\s+)(?:(?:es|fue|el|en\s+el)\s+)*/giu;

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
        byStart ??= new Map(numberRuns(text).map((r) => [r.units[0].start, r]));
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
      byStart ??= new Map(numberRuns(text).map((r) => [r.units[0].start, r]));
      const run = byStart.get(m.index + m[0].length);
      if (!run || !okDigits(digitsOf(run.groups))) continue;
      const end = run.groups.at(-1).at(-1).end;
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
      runs ??= numberRuns(text);
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
    /(?<![\p{L}])iban(?![\p{L}])\s*(?:[:=#]|(?:is|was|es|era)(?![\p{L}]))?\s*(?:(?:el|la)\s+)?([a-z]{2}\d{2}(?: ?[a-z0-9]{4}){2,7}(?: ?[a-z0-9]{1,4})?)(?![\p{L}\d])/giu;

  // The number before its name: "1234567890 is my account number", "1234567890 es mi número de cuenta".
  const ACCOUNT_NAMED_AFTER = new RegExp(
    String.raw`(?<![\p{L}\d])(?<!\d[-./])(\d{2,22}(?:[ -]\d{2,8}){0,5})\s*,?\s*(?:is|was|es|era)\s+(?:my|our|the|mi|el|nuestro)\s+(?:(?:(?:bank|checking|savings)\s+)?(?:account|acct)\s+(?:number|no\.?|#)|${CUENTA}|clabe|cbu|cvu)(?![\p{L}])`,
    "giu",
  );

  const accountSize = (d) => d.length >= 6 && d.length <= 22;
  const findBankNumbers = (text) => [
    ...numberAfter(BANK_LABELS, text, (d) => d.length >= 6 && d.length <= 17),
    ...numberAfter(ROUTING_LABELS, text, abaValid),
    ...accountAfter(CUENTA_LABEL, text, accountSize),
    ...accountAfter(CCI_LABEL, text, (d) => d.length === 20),
    ...checkedAccounts(text),
    ...[...text.matchAll(IBAN_LABELLED)].map((m) => m[1]).filter((v) => ibanValid(v.toUpperCase())),
    ...[...text.matchAll(ACCOUNT_NAMED_AFTER)].map((m) => m[1]).filter((v) => accountSize(v.replace(/\D/g, ""))),
  ];
  const findMedicare = (text) => [
    ...(text.match(MBI_RE) || []),
    ...idAfter(MEDICARE_LABELS, text),
    ...numberAfter(AU_MEDICARE_LABELS, text, auMedicareValid),
  ];
  // Also checks Spanish labels, in spanishLicenses and the functions below it.
  const findLicenses = (text) => [...idAfter(LICENSE_LABELS, text), ...dlLicenses(text), ...spanishLicenses(text)];
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
    String.raw`\b(?:VIN|vehicle\s+identification|chassis|chasis|n[uú]mero\s+de\s+bastidor|bastidor|NIV|n[uú]mero\s+de\s+identificaci[oó]n\s+vehicular|n[uú]mero\s+de\s+serie\s+${CAR})(?![\p{L}\d])(?:\s*(?:number|no\.?|num|#))?\s*(?:[:=#]|is|was|es|era)?\s*([A-HJ-NPR-Z0-9]{17})(?![\p{L}\d])`,
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
    /(?<![\p{L}\d])SID(?:\s*(?:number|no\.?|num|#))?\s*(?:[:#]|is|was)?\s*(\d{7,10})(?![\p{L}\d]|[-./,]\d)/gu;
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
    name = name.replace(/[.-]+$/, "");
    return name.length >= 3 && name.length <= 32 && looksLikeHandle(name, firmLabel || !!lead[1]) ? name : null;
  }
  function findGamerTags(text) {
    const found = [];
    for (const m of text.matchAll(GAME_LABEL)) {
      // A dot after "the" or "my" starts no sentence: "The. Xbox name is…" is "The Xbox name is…".
      const lead = text.slice(Math.max(0, m.index - 12), m.index).replace(DOT_AFTER_NO_END, "$1 ");
      const owned = (m.index <= 12 && !lead.trim()) || OWNER_BEFORE.test(lead) || OWNED_LABEL.test(m[0]);
      found.push(handleAt(text, m.index + m[0].length, owned && !!m.groups.link));
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
  const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
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
    const s = raw.replace(/ /g, "");
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
  const DNI_RE = /\b(\d{8})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const NIE_RE = /\b([XYZ])[- ]?(\d{7})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const CURP_RE =
    /\b[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d\b/g;
  const CURP_CHARS = "0123456789ABCDEFGHIJKLMN\u00d1OPQRSTUVWXYZ";
  function curpValid(c) {
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += CURP_CHARS.indexOf(c[i]) * (18 - i);
    return String((10 - (sum % 10)) % 10) === c[17];
  }
  // Mexico's RFC (a tax ID: 3 to 4 letters, a date, then 3 characters) and Spain's social security number
  // (12 digits) only count right after their label, since in English "RFC 7231" names an internet standard.
  const RFC_RE =
    /\bRFC\b(?:\s+(?:es|is))?\s*:?\s*([A-ZÑ&]{3,4}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z0-9]{3})\b/giu;
  const NSS_RE = /(?:\bNSS\b|seguridad\s+social)[^\n\d]{0,20}?(\d{2}[\s/-]?\d{8}[\s/-]?\d{2})(?![\d])/giu;
  // A US ITIN, the tax number for people without an SSN, is shaped like an SSN but starts with 9 and has
  // its own middle ranges, so with its dashes or spaces it counts on its own. It has no check digit and 1 in
  // 23 nine-digit numbers fits those ranges, so like an SSN its bare digits only count right after its name
  // (US_ID_LABELLED), same as tax IDs, immigration numbers and VA file numbers below.
  const ITIN_RE = /\b9\d{2}[- ](?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])[- ]\d{4}\b/g;
  const US_ID_LABELLED =
    /\b(?:ITIN|EIN|TIN|tax\s*(?:payer\s*)?id(?:entification)?(?:\s+number)?|employer\s+identification\s+number|a-?number|alien\s+(?:registration\s+)?number|uscis\s*(?:number|#)|green\s+card(?:\s+(?:number|receipt))?|va\s+(?:file|claim)\s+number)\s*(?:#|no\.?|number)?\s*(?:is|:|=)?\s*((?:[A-Z]{1,3}[\s-]?)?\d(?:[\d-]{6,12})\d)(?![\d-])/gi;
  const findNationalIds = (text) => [
    ...(text.match(ITIN_RE) || []),
    ...[...text.matchAll(US_ID_LABELLED)].map((m) => m[1]),
    ...[...text.matchAll(RFC_RE)].map((m) => m[1]),
    ...[...text.matchAll(NSS_RE)].map((m) => m[1]),
    ...[...text.matchAll(NINO_RE)].filter((m) => ninoLabelNear(text, m.index)).map((m) => m[0]),
    ...numberAfter(SIN_LABELS, text, (d) => d.length === 9 && luhn(d.padStart(13, "0"))),
    ...numberAfter(AADHAAR_LABELS, text, aadhaarValid),
    ...numberAfter(TFN_LABELS, text, tfnValid),
    ...[...text.matchAll(DNI_RE)].filter((m) => DNI_LETTERS[Number(m[1]) % 23] === m[2]).map((m) => m[0]),
    ...[...text.matchAll(NIE_RE)]
      .filter((m) => DNI_LETTERS[Number("XYZ".indexOf(m[1]) + m[2]) % 23] === m[3])
      .map((m) => m[0]),
    ...(text.match(CURP_RE) || []).filter(curpValid),
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
  const ES_NO = String.raw`(?:n[uú]mero|number|n[uú]m\.?|nro\.?|n\.?\s?[º°]\.?|no\.|no(?=\s*\d))`;
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
  const lowercaseShort = (label) =>
    /^(?:c\.?\s?c|r\.?u\.?n)(?![\p{L}])/iu.test(label) && !/^(?:C\.?\s?C|R\.?U\.?N)/.test(label);
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
    ...afterLabel(CEDULA_LABEL, text, (t, at, label) => !lowercaseShort(label) && sticky(CEDULA_DIGITS, t, at)?.[0]),
    ...afterLabel(RUT_LABEL, text, (t, at, label) => {
      const r = !lowercaseShort(label) && sticky(RUT_DIGITS, t, at);
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
  // Letters, digits, dashes and slashes, or digits in groups with single spaces ("61 234567 8 01").
  const MEMBER_ID = /\d{2,12}(?: \d{1,12}){1,4}(?![\p{L}\d/-])|[A-Za-z0-9][A-Za-z0-9/-]{3,24}/uy;
  function memberIdAt(text, at) {
    const v = sticky(MEMBER_ID, text, at)?.[0].replace(/[-/]+$/, "");
    const dateOrYear = (s) => JUST_A_YEAR.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
    return v && (v.match(/\d/g) || []).length >= 6 && !dateOrYear(v) ? v : null;
  }
  const spanishInsuranceIds = (text) => [
    ...afterLabel(MEDICAID_ES, text, idNotYear),
    ...afterLabel(AFILIADO, text, memberIdAt),
  ];

  // Every value read after one of these labels, so findPhones doesn't also read it as a phone, as with
  // "número de afiliado 912345678" or "mi NSS es 12345678901".
  const spanishIdValues = (text) => [
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
  // Twelve or more BIP-39 list words in a row is a seed phrase. Numbering, commas and line breaks
  // between the words are fine.
  function findSeedPhrases(text) {
    const found = [];
    let run = [];
    let lastEnd = -1;
    // Twelve number words in a row, like someone reading out a card number, are a number, not a seed phrase.
    const allNumbers = () => run.every((w) => ALL_WORDS[text.slice(w.start, w.end).toLowerCase()] !== undefined);
    const close = () => {
      if (run.length >= 12 && !allNumbers()) found.push(text.slice(run[0].start, run.at(-1).end));
      run = [];
    };
    for (const m of text.matchAll(/[A-Za-z]+/g)) {
      const w = { start: m.index, end: m.index + m[0].length };
      const gapOk = lastEnd < 0 || /^[\s,;.)\-\d]*$/.test(text.slice(lastEnd, w.start));
      if (!BIP39.has(m[0].toLowerCase()) || !gapOk) close();
      if (BIP39.has(m[0].toLowerCase())) run.push(w);
      lastEnd = w.end;
    }
    close();
    return found;
  }
  // Matches a raw private key, either 64 hex characters or a Bitcoin WIF key, written right after
  // the words "private key" or "wallet key".
  const CRYPTO_KEY_RE =
    /\b(?:private|priv|wallet|secret)\s*key\b[\s:="'-]{0,6}((?:0x)?[0-9a-fA-F]{64}|[5KL][1-9A-HJ-NP-Za-km-z]{50,51})\b/gi;
  const findCryptoSecrets = (text) => [...findSeedPhrases(text), ...[...text.matchAll(CRYPTO_KEY_RE)].map((m) => m[1])];

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
    return !!member && typeof obj[member] === "string" && obj[member].length > 0;
  }

  function findJwkPrivateKeys(text) {
    const found = [];
    for (const span of leafJsonSpans(text)) {
      if (!span.includes("kty")) continue; // cheap skip before paying for a parse
      if (isPrivateJwk(looseJsonParse(span))) found.push(span);
    }
    return found;
  }

  const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g;
  // A PEM or OpenSSH header and a JWK private key both count as the same `private_key` kind.
  function findPrivateKeys(text) {
    return [...text.matchAll(PEM_PRIVATE_KEY_RE)].map((m) => m[0]).concat(findJwkPrivateKeys(text));
  }

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
      const link = m[0].replace(/[).,;:!?\]}>]+$/, "");
      const query = new URLSearchParams(link.includes("?") ? link.slice(link.indexOf("?") + 1) : "");
      const secret = /^otpauth-migration:/i.test(link)
        ? query.get("data") || ""
        : (query.get("secret") || "").replace(/\s+/g, "").replace(/=+$/, "");
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
      if (/^ [A-Za-z]/.test(rest.slice(m.index + m[0].length)))
        while (groups.length > 4 && !/[2-7]/.test(groups.at(-1))) groups = groups.slice(0, -1);
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

  // ---------- Developer secrets: connection strings, JWTs, internal addresses ----------

  // A connection string like scheme://user:password@host, matched only when the password part looks real.
  const CONN_RE =
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|oracle|ftp|sftp|smtp|https?):\/\/[^\s:/@]+:([^\s@/]+)@[^\s"'<>]+/gi;
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
    return [...text.matchAll(CONN_RE)]
      .filter((m) => !PLACEHOLDER_PASSWORDS.has(m[1].toLowerCase()) && !/^[<{$[%]/.test(m[1]) && !isPlaceholder(m[1]))
      .map((m) => m[0].replace(/[.,;)\]]+$/, ""));
  }

  // A JWT looks like header.payload.signature, where both JSON parts are base64url and start with "eyJ".
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

  // Matches the private network ranges 10/8, 172.16/12 and 192.168/16, but not when they're part of a
  // longer dotted number like a version string.
  const IP_RE = /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g;
  const findInternalIPs = (text) =>
    (text.match(IP_RE) || []).filter((ip) => ip.split(".").every((o) => Number(o) <= 255));

  // Catches hostnames on internal-only domains, like build-01.corp, printer.local or api.internal.
  const HOST_RE =
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}(?:internal|corp|local|lan|intranet|localdomain|home\.arpa)\b(?![.-]?\w)/gi;

  // ---------- Your vault: things you told Clotr to protect ----------
  // Words and phrases you've added, like your name or your employer, are known only by fingerprint, a salted
  // hash of the lowercased phrase, so they never sit in storage as text. An account or ID format like
  // "AB-######" is stored as a shape instead (# for a digit, @ for a letter), and phone, email and address
  // entries are value fingerprints, matched in content.js against whatever the regular patterns found.

  let vault = null; // { salt, words: Map(fp → type), maxWords, shapes: [{ type, re, near }] }
  let vaultHits = { text: null, hits: [] };

  // Turns a shape into a regular expression built only from literal characters plus a digit class for each
  // # and a letter class for each @, with no repeats, choices or groups to backtrack through. A shape is at
  // most 40 characters (MAX_SHAPE), so a team's own formats can never make matching slow.
  const MAX_SHAPE = 40;
  function shapeToRegExp(shape) {
    const body = [...shape]
      .map((ch) => (ch === "#" ? "\\d" : ch === "@" ? "[A-Za-z]" : ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")))
      .join("");
    return new RegExp(String.raw`(?<![\w-])${body}(?![\w-])`, "gi");
  }
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
      shapes: shapes.map((e) => ({ type: e.type, re: shapeToRegExp(e.shape), near: cleanNear(e.near) })),
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
  const LABELLED_SECRET =
    /\b(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:password|passwd|pwd|pass|pw|passcode|passphrase|pin|secret|client_secret|token|access_token|auth_token|api[_-]?key|contrase(?:ñ|n)a|clave)(?:_[A-Za-z0-9]+)*["']?\s*[:=]\s*["']?([^\s"',;]+)/gi;
  // An HTTP auth header from a pasted curl command or code, like "Authorization: Bearer …".
  const AUTH_HEADER =
    /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|apikey)\s+([A-Za-z0-9._~+/=-]{12,})/gi;
  // How people write a password out to a person, as in "my password is Fluffy123" or "my password for
  // netflix is …". This also catches common misspellings like "pasword" or "passwrod".
  const TOLD_SECRET =
    /\b(?:(?:my|the|our|his|her|their|your)\s+)?(?:wi-?fi\s+|email\s+|bank\s+|computer\s+|phone\s+)?(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|pw|pwd|passcode|passphrase|pin(?:\s+(?:number|code))?)(?:\s+(?:for|to|on|at|of)\s+(?:(?:my|the|our|his|her|their|your)\s+)?[A-Za-z\d.'-]+(?:\s+[A-Za-z\d.'-]+)?)?\s+(?:is|was)\s*:?\s*["'“‘]?([^\s"'”’,;!?]+)/gi;
  // Spanish: "mi contraseña es Gato2024!", "la contraseña del wifi es sol-y-luna".
  const TOLD_SECRET_ES =
    /(?<![\p{L}])(?:(?:mi|la|el|tu|su|nuestra)\s+)?(?:contrase(?:ñ|n)a|clave|pin)(?:\s+(?:del?|de\s+(?:la|mi|tu|su)|para(?:\s+(?:el|la|mi|tu|su))?)\s+[\p{L}\d-]+){0,2}\s+(?:es|era)\s*:?\s*["'“‘]?([^\s"'”’,;!?]+)/giu;
  // Answers to account-recovery questions work the same way passwords do, as in "my mother's maiden name
  // is Smith" or "the answer to my security question is Rover". Each label here is written once and read
  // twice: once by the rule that finds a code told after it, and once by the scam-detection check in
  // scam-signs.js, through Clotr.askLabels, so the two can't drift apart.
  const ANSWER_LABEL = String.raw`mother'?s\s+maiden\s+name|maiden\s+name|memorable\s+(?:word|information|answer|phrase)|first\s+pet'?s\s+name|answer\s+to\s+(?:my|the)\s+security\s+question|security\s+(?:question\s+)?answer`;
  const ANSWER_LABEL_ES = String.raw`apellido\s+de\s+soltera(?:\s+de\s+mi\s+madre)?|nombre\s+de\s+mi\s+primera\s+mascota|respuesta\s+(?:de|a\s+la\s+pregunta\s+de)\s+seguridad`;
  const TOLD_ANSWER = new RegExp(
    String.raw`\b(?:${ANSWER_LABEL})(?:\s*\([^()\n]{1,30}\))?\s+(?:is|was)\s*:?\s*["'“‘]?([\p{L}][\p{L}'-]{1,40})`,
    "giu",
  );
  const TOLD_ANSWER_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:${ANSWER_LABEL_ES})\s+(?:es|era)\s*:?\s*["'“‘]?([\p{L}][\p{L}'-]{1,40})`,
    "giu",
  );
  // A password word right before a value that looks like one, as in "…and the password Summer2024". A
  // letter or digit right before the word rules it out, so it won't catch the "PW" at the end of an
  // IBAN group like "U4PW 7VRN".
  const BARE_SECRET =
    /(?<![\p{L}\d])(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|passcode|pw|pwd|contrase(?:ñ|n)a)\s+["'“‘]?([^\s"'”’,;]{4,64})/giu;
  // "login: jdoe@gmail.com / Fluffy!23": a login shared as a pair.
  const LOGIN_PAIR =
    /\b(?:login|log-?in|sign[- ]?in|credentials|creds)\b[^\n]{0,20}?\s["'“‘]?[^\s/|"']{3,64}\s*[/|]\s*["'“‘]?([^\s"'”’,;/]{4,64})(?![^\s"'”’,;])/gi; // a "/" means a path, not a password
  // Codes that open a home, a card or a phone, as in "the gate code is 1234" or "the safe combination is
  // 12-34-56". Unrelated codes like a zip code or an error code stay quiet.
  const CODE_TOLD =
    /\b(?:(?:gate|alarm|garage|door|lock\s*box|locker|lock|keypad|safe|building|entry|house|atm|debit(?:\s+card)?|credit\s+card|card|phone|iphone|bank)\s+(?:code|combination|combo|passcode|pin)|passcode|combination|pin(?=\s+(?:number|code|#))|my\s+pin)(?:\s+(?:number|code))?(?:\s+(?:to|for|on|of)\s+(?:my|the|our|his|her)\s+[\p{L}-]+)?\s*(?:is|was|:|=)?\s*["'“‘]?(\d{3,10}#?|\d{1,3}(?:-\d{1,3}){2,3}|\d{1,2}(?: \d{1,2}){2,3})(?![\d-]| \d)/giu;
  // Sign-in codes sent by text or email, as in "the verification code they texted me is 482913", which is
  // what a scam caller is after. Error codes, zip codes and a plain "sent the code" stay quiet.
  // The code itself is 4 to 8 digits, or two groups of 3 like WhatsApp's "482-913". It's never a year,
  // never part of a longer number, and never a size, so "my code is 3000 lines long" doesn't match.
  const SIGN_IN_VALUE = String.raw`["'“‘]?(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)(?!\s+(?:lines?|characters?|chars|bytes?|words?|pages?|rows?|times|errors?|l[ií]neas|caracteres|palabras|p[aá]ginas|filas|veces|errores)(?![\p{L}]))`;
  const IS = String.raw`\s*(?:(?:is|was)\s*)?[:=,]?\s*`;
  const IS_SAID = String.raw`\s*(?:(?:is|was)(?![\p{L}])\s*[:=]?|[:=])\s*`;
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
  const LOGIN_CODE = new RegExp(
    String.raw`(?<![\p{L}\d])(?:${LOGIN_NAMES})(?![\p{L}])[^\n\d]{0,30}?(?:\b(?:is|was)\b)?\s*[:=]?\s*["'“‘]?(?<!(?<![\p{L}])(?:in|since|by|from|of|until|before|after|at|to|about|around|every)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)|(?<![\p{L}])(?:(?:texted|sent|messaged|emailed|gave)\s+(?:me|us|him|her)\s+(?:(?:the|a|that|this|my)\s+)?|ask(?:ed|ing|s)?\s+(?:me\s+)?for\s+(?:the|my|a|that)\s+)(?:\p{L}+\s+)?${NOT_SIGN_IN}code\s*(?:(?:is|was)\s*)?[:=]?\s*["'“‘]?(?<!(?<![\p{L}])(?:in|since|by|from|of|until|before|after|at|to|about|around|every)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)` +
      // "the code they texted me is 482913", "the passcode I got by text: 482913"
      String.raw`|${CODE_THEY_SENT}${IS}${SIGN_IN_VALUE}` +
      // "the code from the text is 482913", "the code in the email: 482913"
      String.raw`|${NOT_SIGN_IN}(?<![\p{L}])(?:pass)?code\s+(?:in|from|on)\s+(?:the|that|this|my|your|their|a|an)\s+(?:text(?:\s+message)?|sms|e-?mail|message|texts)\s*(?:(?:is|was|says|said|reads)\s*)?[:=,]?\s*${SIGN_IN_VALUE}` +
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
  const ES_VALUE = String.raw`\s*(?:(?:es|era)(?![\p{L}]))?\s*:?\s*["'“‘]?(?<!(?<![\p{L}])(?:en|desde|hasta|de|del|a|al|antes|despu[eé]s|por|para|cada)\s+)${SIGN_IN_VALUE}`;
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
      String.raw`|(?<!\d[-./\s])${SIGN_IN_VALUE}\s*,?\s*(?:es|era)\s+(?:mi\s+c[oó]digo(?:\s+${ES_SIGN_IN})?(?![\p{L}])(?!\s+(?:postal|de|del|para|fuente|en)(?![\p{L}]))|el\s+c[oó]digo\s+(?:${ES_SIGN_IN}|que\s+(?:me|nos)\s+${ES_SENT})(?![\p{L}]))` +
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
      end = units.at(-1).end;
      if (size < 3 || size > 4 || (end === rest.length && at + end < text.length)) return null;
    }
    return CODE_SIZE.test(rest.slice(end)) ? null : rest.slice(0, end);
  }
  // Spanish, matching the same kind of phrase: "el código de AnyDesk es 123 456 789".
  // A remote-access app's name, in English and in Spanish.
  const REMOTE_WORDS = String.raw`any\s*desk|team\s*viewer|remote\s+(?:access|support|desktop)|quick\s*assist|ultra\s*viewer|rust\s*desk`;
  const REMOTE_WORDS_ES = String.raw`any\s*desk|team\s*viewer|acceso\s+remoto`;
  const CODE_TOLD_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:c[oó]digo|clave|id|pin)\s+(?:de\s+la|del|de)\s+(?:${REMOTE_WORDS_ES}|puerta|portal|alarma|garaje|caja\s+fuerte|edificio|casa|cajero|tarjeta)\s*(?:es|era|:)?\s*["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{3,10}#?)(?![\d-])`,
    "giu",
  );
  const REMOTE_CODE = new RegExp(
    String.raw`\b(?:${REMOTE_WORDS})(?:\s+(?:id|code|number|address|password|pin))?\s*(?:is|:|=)?\s*["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{6,10})(?![\d-])`,
    "gi",
  );
  // Two-factor backup codes and recovery keys, as in "backup codes are 1234 5678, 2345 6789". Reads
  // everything after the label as one list of codes, and requires a digit somewhere in it, so a sentence
  // like "…is lost" doesn't count as a code.
  const RECOVERY_LABEL = String.raw`(?:backup|recovery|2fa|two[- ]factor|mfa)\s+(?:codes?|keys?)|(?:c[oó]digos?|claves?)\s+de\s+(?:respaldo|recuperaci[oó]n)`;
  const RECOVERY_CODES = new RegExp(
    String.raw`(?<![\p{L}])(?:${RECOVERY_LABEL})(?![\p{L}])(?:\s+(?:are|is|was|were|es|son|era|eran))?\s*:?\s*((?:[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8}){0,7}(?:\s*[,;]\s*|\s+|$)){1,16})`,
    "giu",
  );
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
      "incorrecta correcta segura nueva vieja débil fuerte larga corta mía tuya igual distinta obligatoria la el una muy"
    ).split(" "),
  );

  // Cleans up a value told after a secret's label, stripping trailing punctuation, and returns null for
  // anything that isn't really a secret: too short or long, a word describing the secret rather than being
  // it, masked out, a placeholder, code reading the value from elsewhere, too plain when complexity is
  // required, or a value some other pattern already recognizes as its own kind of key.
  function secretValue(raw, needsComplexity, minLength = 4) {
    const v = raw.replace(/[.)\]}>]+$/, "");
    if (v.length < minLength || v.length > 128 || NOT_A_SECRET.has(v.toLowerCase())) return null;
    if (/^[*•x.#-]+$/i.test(v) || /^[<{$[%(]/.test(v) || isPlaceholder(v)) return null; // masked, template, placeholder
    // Code that reads the secret from somewhere else: process.env.X, os.environ[…], config.x.
    if (
      /^(?:process\.env|os\.environ|os\.getenv|import\.meta\.env|env|config|settings|secrets|vars|ENV|request|req|params|args|form|input|self|this|getpass|prompt)\b[.[(]/.test(
        v,
      )
    )
      return null;
    if (/[[(]$/.test(v)) return null; // code that continues on the next token: request.form['…'], getpass(
    // End-of-sentence punctuation isn't part of a password, so "a good password manager?" reads as a question.
    const core = v.replace(/[?!:]+$/, "");
    // Needs to look like a real password: a digit, a symbol, or mixed case. An accented letter still
    // counts as a letter, and a leading "¿" or "¡" means it's actually a Spanish question.
    if (
      needsComplexity &&
      (/^[¿¡]/.test(core) ||
        !(/\d/.test(core) || /[^\p{L}\p{N}]/u.test(core) || (/\p{Ll}/u.test(core) && /\p{Lu}/u.test(core))))
    )
      return null;
    // A recognizable key after the label is reported by its own pattern.
    if (PATTERNS.some((p) => p.secret && p.regex && new RegExp(p.regex.source).test(v))) return null;
    return v;
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
    for (const m of text.slice(from, to).matchAll(CODE_PIECE))
      pieces.push(pieceOf(text, { 0: m[0], index: from + m.index }));
    let run = [];
    const close = () => {
      if (!run.length) return;
      const start = run[0].start;
      const value = text.slice(start, run.at(-1).end);
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
        text.slice(run.at(-1).end, p.start) === " " &&
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
  function findSecrets(text, why) {
    const found = [];
    const reasons = new Map();
    // The first reason in ASK_REASONS' order wins when two rules take the same value ("my ATM pin is 4821").
    const rank = (reason) => (reason ? ASK_REASONS.indexOf(reason) : ASK_REASONS.length);
    const because = (v, reason) => {
      if (v && rank(reason) < rank(reasons.get(v))) reasons.set(v, reason);
    };
    // A money detail told after its own label, like a card's security code or a gift card's code and PIN,
    // is reported as its own kind, so it's never counted as a password too.
    const theirs = new Set([...findCardCodes(text), ...findGiftCards(text)]);
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
      if (!p || words.some((w) => EVERYDAY_WORDS.has(w)) || words.filter((w) => NOT_A_SECRET.has(w)).length > 1)
        return false;
      found.push(p[1]);
      return true;
    };
    const valueStart = (m) => m.index + m[0].length - m[1].length;
    // Reads a secret told in words, trying a passphrase first, then the word right after "is", then the
    // first password-looking word shortly after that.
    const told = (m) => {
      if (passphraseAt(valueStart(m))) return;
      // A PIN is digits: "my pin is loose" is about hardware.
      if (/^(?:(?:my|the|our|his|her|their|your)\s+)?pin\b/i.test(m[0]) && !/\d/.test(m[1])) return;
      if (add(m[1], false)) return;
      const later = LATER_SECRET.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
      if (later) add(later[0], true);
    };
    for (const m of text.matchAll(LABELLED_SECRET)) if (!add(m[1], true)) passphraseAt(valueStart(m));
    for (const m of text.matchAll(AUTH_HEADER)) add(m[1], true);
    for (const m of text.matchAll(TOLD_SECRET)) told(m);
    for (const m of text.matchAll(TOLD_SECRET_ES)) told(m);
    for (const m of text.matchAll(TOLD_ANSWER)) because(add(m[1], false), "security_answer");
    for (const m of text.matchAll(TOLD_ANSWER_ES)) because(add(m[1], false), "security_answer");
    for (const m of text.matchAll(BARE_SECRET)) {
      // A capital letter starting the next line belongs to that line, not the password. Otherwise "I
      // forgot my password" followed by "Drive safe!" on its own line would read "Drive" as the password.
      if (m[0].includes("\n") && /^\p{Lu}\p{Ll}*[.?!:]*$/u.test(m[1])) continue;
      add(m[1], true);
    }
    for (const m of text.matchAll(LOGIN_PAIR)) add(m[1], true);
    for (const m of text.matchAll(REMOTE_CODE)) because(add(m[1], false), "remote_code");
    for (const m of text.matchAll(LOGIN_CODE)) because(add(matched(m), false), "login_code");
    for (const m of text.matchAll(SESSION_COOKIE)) {
      const v = m[2];
      if (/\d/.test(v) && /[A-Za-z]/.test(v)) add(v, true); // random-looking, not "sessionid=0000000000000000"
    }
    for (const m of text.matchAll(RECOVERY_CODES)) {
      const codes = m[1].replace(/[\s,;]+$/, "");
      if (/\d/.test(codes) && codes.length >= 8) {
        found.push(codes);
        because(codes, "recovery_codes");
      }
    }
    for (const m of text.matchAll(CODE_TOLD_ES))
      because(add(m[1], false), REMOTE_LABEL.test(m[0]) ? "remote_code" : "home_code");
    for (const m of text.matchAll(LOGIN_CODE_ES)) because(add(matched(m), false), "login_code");
    for (const m of text.matchAll(CODE_TOLD)) {
      // "1-2-3" reads as an example rather than a real code. A real combination lock uses 2-digit numbers,
      // and a real keypad code has 4 or more digits, like "1-9-7-5".
      if (
        /[- ]/.test(m[1]) &&
        !/\d\d/.test(m[1]) &&
        (m[1].split(/[- ]/).length < 4 || "0123456789".includes(m[1].replace(/[- ]/g, "")))
      )
        continue;
      because(add(m[1], false), "home_code");
    }
    // Several ways of saying it can find the same value.
    const out = [...new Set(found)].filter((v) => !theirs.has(v));
    if (why) for (const v of out) if (reasons.has(v)) why.set(v, reasons.get(v));
    return out;
  }

  // `group` = the Settings section: "credentials" (keys, passwords), "personal" (info about a person),
  // or "custom" (the user's own watch list).
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
      regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
      id: "github_token",
      group: "credentials",
      secret: true,
      name: "GitHub Token",
      severity: "high",
      regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    },
    {
      id: "stripe_secret_key",
      group: "credentials",
      secret: true,
      name: "Stripe Secret Key",
      severity: "high",
      regex: /\b[sr]k_live_[A-Za-z0-9]{24,}\b/g,
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
      regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g,
      validate: (m) => looksRandom(m.replace(/^sk-(?:proj-)?/, "")),
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
      regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    // Covers the keys from several other services under one Settings row: Hugging Face, npm, PyPI,
    // GitLab, SendGrid, Twilio, Mailgun, Shopify, DigitalOcean, Telegram and Discord bots, Azure storage
    // and service-bus keys, and Slack or Discord webhook URLs, since anyone with one of those URLs can
    // post as the bot that owns it.
    {
      id: "crypto_secret",
      group: "credentials",
      name: "Crypto Wallet Seed or Key",
      severity: "high",
      find: findCryptoSecrets,
    },
    {
      id: "service_token",
      group: "credentials",
      secret: true,
      name: "Service Access Token",
      severity: "high",
      regex: new RegExp(
        [
          String.raw`\bhf_[A-Za-z0-9]{30,}\b`,
          String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
          String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`,
          String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
          String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b`,
          String.raw`\bSK[0-9a-fA-F]{32}\b`,
          String.raw`\bkey-[0-9a-f]{32}\b`,
          String.raw`\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}\b`,
          String.raw`\bdop_v1_[0-9a-f]{64}\b`,
          String.raw`\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b`,
          String.raw`\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b`,
          String.raw`\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{40,88}={0,2}`,
          String.raw`https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]{20,120}`,
          String.raw`https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d{5,25}/[A-Za-z0-9_-]{20,100}`,
        ].join("|"),
        "g",
      ),
    },

    {
      id: "connection_string",
      group: "credentials",
      name: "Database/Service Connection String",
      severity: "high",
      find: findConnectionStrings,
    },
    { id: "jwt", group: "credentials", name: "Login Token (JWT)", severity: "high", regex: JWT_RE },
    { id: "internal_ip", group: "credentials", name: "Internal IP Address", severity: "medium", find: findInternalIPs },
    { id: "internal_host", group: "credentials", name: "Internal Hostname", severity: "medium", regex: HOST_RE },
    {
      id: "otp_secret",
      group: "credentials",
      name: "Two-Step Sign-in Key",
      severity: "high",
      find: findOtpSecrets,
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
    addressCore,
    msg,
  };
})();

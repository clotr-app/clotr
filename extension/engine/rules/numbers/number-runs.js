// numberRuns(): a text's digits and number words read as runs of groups, the shape most number rules work from.
(() => {
  "use strict";

  const {
    UNIT_HINT_RE,
    UNIT_RE,
    UNIT_START,
    isLetter,
    isGap,
    readUnit,
    hasTypoCandidate,
    readTypo,
    spanText,
    chant,
    countsByOne,
    VALID_SSN_SHAPE,
    wholePhone,
    wholeSsnOrCard,
    PHONE_CONTEXT,
    ssnLabelBefore,
  } = globalThis.ClotrInternal;

  // ---------- A text's number runs ----------
  // The text's number runs. A run is a list of groups (units written with no separator between them), and a group
  // is a list of units ({ start, end, digits, kind, isWord }). Many rules read one text, so the last result is kept.
  let lastRunsText = null;
  let lastRuns = null;
  function numberRuns(text) {
    if (text === lastRunsText) return lastRuns;
    const runs = readNumberRuns(text);
    lastRunsText = text;
    lastRuns = runs;
    return runs;
  }

  // labelled: a label says a number follows (a card's security code), so every sound-alike and typo counts as a
  // digit, except "to" and "for": "three to four digits" is a range.
  function readNumberRuns(text, labelled = false) {
    const placed = numberUnits(text);
    if (!placed.length) return [];
    return runsFromUnits(text, placed, labelled);
  }

  // ---------- Digits and number words ----------
  // A text's digits and number words. numberRuns and a labelled reading of the same text share them, so the last
  // text's are kept. Nothing downstream changes a unit.
  let lastUnitsText = null;
  let lastUnits = null;
  function numberUnits(text) {
    if (text === lastUnitsText) return lastUnits;
    const units = readNumberUnits(text);
    lastUnitsText = text;
    lastUnits = units;
    return units;
  }

  function readNumberUnits(text) {
    if (!UNIT_HINT_RE.test(text) && !hasTypoCandidate(text)) return [];
    const units = [];
    for (let i = 0; i < text.length;) {
      // A typo can only start at the start of a word.
      let u = isLetter(text[i]) && !isLetter(text[i - 1]) ? readTypo(text, i) : null;
      if (!u) {
        const code = text.charCodeAt(i);
        if (code < 128 && !UNIT_START[code]) {
          i++;
          continue;
        }
        UNIT_RE.lastIndex = i;
        const m = UNIT_RE.exec(text);
        u = m && readUnit(m[0], i);
      }
      if (!u) {
        i++;
        continue;
      }
      units.push(u);
      i = u.end;
    }

    // A number word only counts when it isn't buried in an ordinary word, like "someone" or "phone".
    const wordOk = (u, k) => {
      const touchesPrev = k > 0 && units[k - 1].end === u.start;
      const touchesNext = k < units.length - 1 && units[k + 1].start === u.end;
      return (touchesPrev || !isLetter(text[u.start - 1])) && (touchesNext || !isLetter(text[u.end]));
    };
    // A word and the word it builds on ("fifty three", "double five", "four hundred") may have a hyphen or up to 3
    // spaces between them, like digits can.
    const tight = (a, b) => /^(?:\s|[^\S\n]{0,3}-?[^\S\n]{0,3})$/.test(text.slice(a.end, b.start));
    const NUMBER_KINDS = ["word", "tens", "hundreds", "multiplier", "repeat"];
    const sure = units.map((u, k) => u.kind === "digit" || (NUMBER_KINDS.includes(u.kind) && wordOk(u, k)));
    // A look-alike letter needs a real digit on both sides and must touch one ("555-O636"). Sound-alikes and
    // typos stay for now. keepSoundAlikes decides on them once the runs are read.
    const valid = units.filter((u, k) => {
      if (sure[k]) return true;
      if (u.kind === "soundAlike") return wordOk(u, k);
      if (u.kind !== "lookAlike") return false;
      if (!sure[k - 1] || !sure[k + 1]) return false;
      const before = text.slice(units[k - 1].end, u.start);
      const after = text.slice(u.end, units[k + 1].start);
      return isGap(before) && isGap(after) && (before === "" || after === "");
    });

    // "Double five" is 55. A "double" with no single digit right after it is dropped.
    const withRepeats = [];
    for (let k = 0; k < valid.length; k++) {
      const u = valid[k],
        next = valid[k + 1];
      if (u.kind !== "repeat") {
        withRepeats.push(u);
        continue;
      }
      if (next && (next.kind === "word" || next.kind === "digit") && /^\d$/.test(next.digits) && tight(u, next)) {
        withRepeats.push({ ...next, start: u.start, digits: next.digits.repeat(u.times), kind: "word", isWord: true });
        k++;
      }
    }

    // "Fifty six" is 56. A lone "fifty" is 50.
    const withTens = [];
    for (let k = 0; k < withRepeats.length; k++) {
      const u = withRepeats[k],
        next = withRepeats[k + 1];
      if (u.kind !== "tens") {
        withTens.push(u);
        continue;
      }
      if (
        next &&
        next.kind === "word" &&
        /^[1-9]$/.test(next.digits) &&
        (tight(u, next) || /^\s+y\s+$/i.test(text.slice(u.end, next.start)))
      ) {
        withTens.push({ ...u, end: next.end, digits: u.digits + next.digits, kind: "word" });
        k++;
      } else {
        withTens.push({ ...u, digits: u.digits + "0", kind: "word" });
      }
    }

    // "Five hundred and fifty five" is 555. Hundreds go first, so "six thousand seven hundred" is 6700. A
    // multiplier with no number word before it, like "a hundred", is dropped.
    const withPlaces = (list, places) => {
      const out = [];
      for (let k = 0; k < list.length; k++) {
        const u = list[k],
          m = list[k + 1],
          low = list[k + 2];
        // "quinientos cincuenta y cinco": the hundred is in the word.
        if (places === 2 && u.kind === "hundreds") {
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
          m?.kind === "multiplier" &&
          m.places === places &&
          tight(u, m);
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
    return withPlaces(withPlaces(withTens, 2), 3).filter((u) => u.kind !== "multiplier");
  }

  // ---------- From units to runs ----------
  // "to" and "for": sound-alikes that sit in ranges and durations just as often as in a number.
  const toOrFor = (u) => u.kind === "soundAlike" && !u.typo && !u.edgeOk;
  // The group sizes a phone number (3, 3, 4) or an SSN (3, 2, 4) can be split into.
  const SPLIT_SHAPES = new Set(["3,3,4", "3,7", "6,4", "3,2,4"]);

  // The runs those units make. A labelled reading keeps every sound-alike and typo but "to" and "for". An
  // unlabelled one keeps only those that belong to a number.
  function runsFromUnits(text, placed, labelled) {
    // Only spaces or tabs back to a line break. It looks back no further, so it stays linear.
    const atLineStart = (at) => {
      let i = at - 1;
      while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
      return i < 0 || text[i] === "\n";
    };
    // A list's item number ("1. …", "2) …" at a line's start) isn't part of the detail after it. Cheap checks go
    // first: this runs for every unit added to a run, and a 40,000-digit paste once froze the page for a second.
    const listNumber = (r, gap) =>
      r.units.length <= 3 &&
      r.groups.length === 1 &&
      /^[.)][^\S\n]+$/.test(gap) &&
      r.units.every((x) => x.kind === "digit") &&
      atLineStart(r.units[0].start);
    // A full stop before a number word usually ends a sentence: "It's 2024. Nine one one is for emergencies" is
    // 2024 and 911. But a phone keyboard capitalizes after a period, so "Call five five five. Five five five.
    // Zero one two three." looks like three sentences. Pieces that split where a phone number's or an SSN's
    // groups do are joined back into one number.
    const sentenceEnd = (gap, u) => u.isWord && /^\.[^\S\n]+$/.test(gap);
    const runDigitCount = (run) => run.units.reduce((n, x) => n + x.digits.length, 0);
    const splitsLikeANumber = (pieces, n) =>
      pieces.length === n &&
      pieces.slice(1).every((p) => p.afterPeriod) &&
      SPLIT_SHAPES.has(pieces.map(runDigitCount).join(","));
    const rejoin = (runs) => {
      const out = [];
      for (let k = 0; k < runs.length; k++) {
        const take = [3, 2].find((n) => splitsLikeANumber(runs.slice(k, k + n), n));
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
          run = { units: [u], groups: [[u]], afterPeriod: Boolean(joins) };
          runs.push(run);
        }
      }
      return runs.some((r) => r.afterPeriod) ? rejoin(runs) : runs;
    };
    if (labelled) return buildRuns(placed.filter((u) => !toOrFor(u)));
    // Read once with every sound-alike and typo that touches a number, then again with only those that belong.
    const runs = buildRuns(placed);
    if (!placed.some((u) => u.kind === "soundAlike")) return runs;
    const kept = keepSoundAlikes(runs, text);
    return buildRuns(placed.filter((u) => u.kind !== "soundAlike" || kept.has(u)));
  }

  // ---------- Sound-alikes that stay words ----------
  // Everyday words like "won", "too" and "fore" double as digits, and so can a one-letter typo like "sevne".
  // They only count when the run around them is a number. Spanish ones only count among Spanish number words and
  // English ones among English, so a plain count like "seis siete ocho nueve diez once doce" stays a count.
  function keepSoundAlikes(runs, text) {
    const kept = new Set();
    const soft = (u) => u.kind === "soundAlike";
    const strong = (u) => u.kind !== "soundAlike" && u.kind !== "lookAlike";
    const digits = (list) => list.map((u) => u.digits).join("");
    // A count isn't a number. It's judged with its edge words, so "too won too thre fore fiv sicks seve eigt
    // nien" is still 212-345-6789.
    const isCount = (list) => countsByOne(list.map((u) => Number(u.digits)));
    // Set off from other number words by the number's end, a comma or another "to" or "for".
    const setOff = (a, b) => !a || !b || toOrFor(a) || toOrFor(b) || /[,;.]/.test(text.slice(a.end, b.start));
    // A real "wait for …" or "text to …" has its verb in the 30 characters before (PHONE_CONTEXT).
    const noVerbBefore = (pos) => !PHONE_CONTEXT.test(text.slice(Math.max(0, pos - 30), pos));
    // Sound-alikes alone, with no number word: each English stretch (cut at "to", "for", typos and "once") can be
    // a whole phone number, unless it's a chant like "too too too …".
    const keepSoundAlikePhones = (units) => {
      let stretch = [];
      for (const u of [...units, null]) {
        if (u?.edgeOk && !u.lang) {
          stretch.push(u);
          continue;
        }
        const d = digits(stretch);
        if (wholePhone(d, false) && !chant(d)) for (const s of stretch) kept.add(s);
        stretch = [];
      }
    };

    for (const { units } of runs) {
      if (!units.some(soft)) continue;
      // Between two number words, an English sound-alike always counts. Not "to" or "for", and not a typo.
      const between = (k) => k > 0 && k < units.length - 1 && strong(units[k - 1]) && strong(units[k + 1]);
      units.forEach((u, k) => {
        if (u.edgeOk && !u.lang && between(k)) kept.add(u);
      });
      const first = units.findIndex(strong);
      let last = units.length - 1;
      while (last >= 0 && !strong(units[last])) last -= 1;
      if (first < 0) {
        keepSoundAlikePhones(units);
        continue;
      }
      const core = units.slice(first, last + 1);
      const words = core.filter(strong);
      if (core.some((u) => u.kind === "lookAlike")) continue; // too unsure to guess a shape around
      const lang = words.every((u) => u.lang === "es") ? "es" : words.every((u) => u.lang === "en") ? "en" : null;
      const fits = (u) => !u.lang || u.lang === lang;
      const inside = core.filter(soft);
      if (!inside.every(fits)) continue;
      // Sound-alikes never outnumber the number words around them ("to", "for" and typos).
      if (inside.filter((u) => !u.edgeOk).length > words.length) continue;
      const few = inside.length <= words.length;
      // "two to four, five to seven": a "to" or "for" between two rising numbers, each set off, is a range.
      const range = (k) =>
        toOrFor(core[k]) &&
        strong(core[k - 1]) &&
        strong(core[k + 1]) &&
        Number(core[k - 1].digits) < Number(core[k + 1].digits) &&
        setOff(core[k - 2], core[k - 1]) &&
        setOff(core[k + 1], core[k + 2]);
      if (core.some((_u, k) => range(k))) continue;
      const middle = digits(core);
      // Autocorrect turns a typed word into "to" or "for", never a digit key. So only a fully spelled core can
      // take one at its edge, and "waiting for 123456789 to clear" stays quiet.
      const coreAllWords = core.every((u) => u.kind !== "digit");
      // Words that could sit at the edges, nearest first, up to a 19-digit card's room. The first that can't stops
      // the search. Any sound-alike can, "to" and "for" only next to a fully spelled core with no verb before.
      const edge = (from, step) => {
        const out = [];
        let room = 19 - middle.length;
        for (
          let k = from;
          units[k] &&
          fits(units[k]) &&
          (units[k].edgeOk || (coreAllWords && toOrFor(units[k]) && noVerbBefore(units[k].start)));
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
      // Every mix of edge words, fewest first.
      const combos = [];
      for (let n = 0; n <= before.length + after.length; n++) {
        for (let i = Math.min(n, before.length); i >= 0; i--) {
          if (n - i > after.length) continue;
          const lead = before.slice(0, i).reverse();
          const trail = after.slice(0, n - i);
          combos.push({ lead, trail, all: [...lead, ...core, ...trail] });
        }
      }
      // A phone number goes first. Its shape is exact (10 or 11 NANP digits, or Spain's 9). An SSN's or card's
      // can match by chance: "to zero six seven three three for one five one" is a 10-digit phone, not the SSN
      // its first nine digits would also fit.
      const phone = combos.find(({ all }) => !isCount(all) && wholePhone(digits(all), lang === "es"));
      // A card's length, issuer and checksum make a spelled one distinctive. A spelled SSN's shape is loose, so it
      // needs a "to" or "for", unless an SSN label comes right before ("my ssn is fore five six …").
      const ssnOrCard =
        !phone &&
        combos.find(({ lead, trail, all }) => {
          const simple =
            coreAllWords &&
            [...inside, ...lead, ...trail].some(toOrFor) &&
            all.every((u) => u.digits.length === 1) &&
            !/[,;.]/.test(spanText(text, [all]));
          const named = VALID_SSN_SHAPE.test(digits(all)) && ssnLabelBefore(text, { units: all });
          return !isCount(all) && (named || wholeSsnOrCard(digits(all), simple));
        });
      const found = phone || ssnOrCard;
      let pick = found ? [...found.lead, ...found.trail] : null;
      // A 7-digit local number, with no edge words and no "to" or "for".
      if (!pick && few && !inside.some(toOrFor) && /^[2-9]\d{6}$/.test(middle) && !isCount(core)) pick = [];
      if (pick) for (const u of [...inside, ...pick]) kept.add(u);
    }
    return kept;
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, numberRuns, readNumberRuns };
})();

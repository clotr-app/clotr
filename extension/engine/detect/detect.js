// detect() runs every rule over a text, one window at a time, and returns what it found. This file also puts the
// detect group's public names on globalThis.Clotr, where pages, apps and decide.js read them.
(() => {
  "use strict";

  const { PATTERNS, isPlaceholder, vaultKinds, vaultCutShort, setScanDeadline, setVaultSource, ASK_REASONS } =
    globalThis.Clotr;
  const {
    findPdfStreams,
    pdfPageText,
    xmlToText,
    SEVERITY_RANK,
    LOG,
    DETECT_BUDGET_CHARS,
    DETECT_BACKSTOP_MS,
    DETECT_WINDOW_CHARS,
    DETECT_WINDOW_OVERLAP,
    DETECT_PRIVATE_KEY_FALLBACK_CHARS,
    PEM_BEGIN,
    PEM_END,
    partialPem,
    cleanText,
    linkAt,
    PHONE_DOT,
    AFTER_IS,
    ASKS,
    secondReading,
    MAX_JOINED_TOKEN,
    MAX_WORD_TAIL_READS,
    isTokenCode,
    yamlLiteralBlockLines,
    hasTokenLineBreak,
    TAIL_WORD,
    LABEL_KINDS,
    withoutTokenLineBreaks,
    piecedKeys,
    addedByReading,
    copyResults,
    RESPONSES,
    defaultResponse,
    responseFor,
    stricter,
    normalize,
    sha256,
    fingerprint,
    fingerprintStrong,
    fingerprintFor,
    wordEntry,
    wordStarts,
    isSavedWord,
    redact,
    generalForms,
    generalize,
    BANDAGE_WORDS,
    BANDAGE_BORN_IN,
    bandageKindOf,
    readBandageLabels,
  } = globalThis.ClotrInternal;

  // ---------- Window seams ----------
  // A window that cuts a value at its edge can find a piece of it (a card's first 10 digits read as a phone), while
  // the window across that seam sees it whole. So a window leaves finds within SEAM_ZONE of a seam to its neighbour.
  // A kind that needs its label nearby, like a seed phrase, is the exception (seamRescue).
  const SEAM_ZONE = 1024;
  const SEAM_VALUE_MAX = DETECT_WINDOW_OVERLAP - 2 * SEAM_ZONE;
  // `held` touches the window's end and is kept only if the next window can't finish; `dropped` touches its start,
  // which the window before read whole. A value longer than the overlap stays, and so does a private key.
  function seamParts(results, windowText, trimStart, trimEnd) {
    if (!trimStart && !trimEnd) return { kept: results, held: [], dropped: [] };
    const length = windowText.length;
    // Within SEAM_ZONE of the window's end, and only in the overlap the next window reads too.
    const atEnd = (match) =>
      trimEnd &&
      windowText.indexOf(match, Math.max(0, length - SEAM_ZONE - match.length + 1)) >= 0 &&
      windowText.indexOf(match) >= length - DETECT_WINDOW_OVERLAP + SEAM_ZONE;
    // The same at the window's start, which the window before read.
    const atStart = (match) =>
      trimStart &&
      windowText.lastIndexOf(match, SEAM_ZONE - 1) >= 0 &&
      windowText.lastIndexOf(match) + match.length <= DETECT_WINDOW_OVERLAP - SEAM_ZONE;
    const kept = [];
    const held = [];
    const dropped = [];
    const part = (result, matches) => {
      if (matches.length === result.matches.length) return result;
      const out = { ...result, matches };
      if (result.reasonOf) {
        const own = new Set(matches);
        out.reasonOf = new Map([...result.reasonOf].filter(([match]) => own.has(match)));
      }
      return out;
    };
    for (const result of results) {
      if (result.id === "private_key") {
        kept.push(result);
        continue;
      }
      const keep = [];
      const hold = [];
      const drop = [];
      for (const match of result.matches) {
        if (!match || match.length > SEAM_VALUE_MAX) keep.push(match);
        else if (atEnd(match)) hold.push(match);
        else if (atStart(match)) drop.push(match);
        else keep.push(match);
      }
      if (keep.length) kept.push(part(result, keep));
      if (hold.length) held.push(part(result, hold));
      if (drop.length) dropped.push(part(result, drop));
    }
    return { kept, held, dropped };
  }

  // A kind that needs its label nearby (`labelAnywhere`: a seed phrase, a backup-code file) can be missed at a seam:
  // each window leaves the value to the other, but only one sees the label. So what `own` found near its seam with
  // `other`, and `other` didn't report, is read again by `other` for those kinds, told the label is there. `other`
  // reads it whole, so a piece of a longer list counts only if the whole list is a phrase too. The label still counts
  // only from a window that holds the value. `labelled` holds those kinds' ids; a window is
  // { from, to, text, link, results }.
  function seamRescue(pieces, own, other, labelled, scan) {
    const lo = Math.max(own.from, other.from);
    const hi = Math.min(own.to, other.to);
    const placeOf = (match, win) => {
      const at = win.text.indexOf(match, Math.max(0, lo - win.from - match.length + 1));
      return at >= 0 && win.from + at < hi ? [win.from + at, win.from + at + match.length] : null;
    };
    const overlaps = (match, win, spans) => {
      const at = win.text.indexOf(match, Math.max(0, spans[0][0] - win.from - match.length + 1));
      if (at < 0) return false;
      const from = win.from + at;
      const to = from + match.length;
      return spans.some(([start, end]) => from < end && to > start);
    };
    const missed = new Map(); // kind → where its values sit in the paste
    for (const result of pieces) {
      if (!labelled.has(result.id)) continue;
      const theirs = other.results.find((otherResult) => otherResult.id === result.id);
      for (const match of result.matches) {
        const span = placeOf(match, own);
        if (!span || (theirs && theirs.matches.some((their) => overlaps(their, other, [span])))) continue;
        if (!missed.has(result.id)) missed.set(result.id, []);
        missed.get(result.id).push(span);
      }
    }
    if (!missed.size || scan.timedOut) return [];
    const only = PATTERNS.filter((pattern) => missed.has(pattern.id));
    const told = new Map(only.map((pattern) => [pattern, true]));
    const found = [];
    for (const result of detectWindow(other.text, scan, { told, only, link: other.link })) {
      const spans = missed.get(result.id);
      if (!spans) continue;
      spans.sort((a, b) => a[0] - b[0]);
      const matches = result.matches.filter((match) => match && overlaps(match, other, spans));
      if (!matches.length) continue;
      const out = { ...result, matches };
      if (result.reasonOf) out.reasonOf = new Map([...result.reasonOf].filter(([match]) => matches.includes(match)));
      found.push(out);
    }
    return found;
  }

  // ---------- detect() and its last answer ----------
  // The last answer: a typing pause and then Send scan one draft twice, so detect() hands the same text a copy of
  // its last answer. It holds while the rules and vault are unchanged, and never for an answer the time limit cut
  // short. detect.forget() drops it, for a timing test.
  let lastDetect = null;
  // detect() returns every pattern hit as [{ ...pattern, matches: [text, …] }], most severe first. A match inside a
  // more severe one (an Amex card's first ten digits read as a phone) is dropped. Matches are pieces of the original
  // text, not the cleaned copy. Built-in kinds come first, then a team's vault kinds (setVault).
  // A password result can carry `asks` (the codes a scammer asked for) and `reasonOf` (each match's reason, as the
  // words shown on screen). Nothing about a reason is ever stored.
  function detect(text) {
    const vault = vaultKinds();
    const rules = [...PATTERNS, ...vault];
    const kept = lastDetect;
    if (
      kept?.text === text &&
      kept.vault === vault &&
      kept.rules.length === rules.length &&
      rules.every((rule, i) => rule === kept.rules[i] && rule.name === kept.names[i])
    ) {
      return copyResults(kept.results);
    }
    const results = detectFresh(text);
    lastDetect = results.truncated
      ? null
      : { text, vault, rules, names: rules.map((rule) => rule.name), results: copyResults(results) };
    return results;
  }
  detect.forget = () => {
    lastDetect = null;
  };

  // The vault's words stop at the same deadline as the rest of the scan (setScanDeadline in vault/saved-words.js).
  function detectFresh(text) {
    const scan = { deadline: Date.now() + DETECT_BACKSTOP_MS, charsLeft: DETECT_BUDGET_CHARS, timedOut: false };
    setScanDeadline(scan.deadline);
    try {
      return detectAll(text, scan);
    } finally {
      setScanDeadline(Infinity);
      setVaultSource(null);
    }
  }

  // ---------- A large paste, window by window ----------
  function detectAll(text, scan) {
    if (text.length <= DETECT_WINDOW_CHARS) return detectWindow(text, scan);

    // Keep every rule's input bounded, and share one budget across the whole paste. The overlap preserves values
    // that cross a seam; matches returned from a window are mapped to the text as the person wrote it. A PEM key
    // longer than the overlap gets one bounded, key-only pass below so its body is not split across results.
    const merged = new Map();
    const partialPrivateKeys = new Map();
    const merge = (results, windowText, windowStart) => {
      for (const result of results) {
        if (result.id === "private_key") {
          for (const match of result.matches) {
            if (!partialPem(match)) continue;
            let at = 0;
            while ((at = windowText.indexOf(match, at)) >= 0) {
              let partials = partialPrivateKeys.get(windowStart + at);
              if (!partials) {
                partials = new Set();
                partialPrivateKeys.set(windowStart + at, partials);
              }
              partials.add(match);
              at += Math.max(1, match.length);
            }
          }
        }
        let entry = merged.get(result.id);
        if (!entry) {
          entry = { pattern: result, matches: new Set(), reasonOf: new Map(), asks: new Set() };
          merged.set(result.id, entry);
        }
        for (const match of result.matches) entry.matches.add(match);
        for (const [match, reason] of result.reasonOf || []) entry.reasonOf.set(match, reason);
        for (const ask of result.asks || []) entry.asks.add(ask);
      }
    };

    // A window that starts inside a link reads it as the paste read from its start would (linkAt), so a label or a
    // value URL-encoded in a link that crosses a seam reads the same from either window. A kind that needs its label
    // in the text it reads gets one more look at each seam (seamRescue).
    const labelled = new Set(
      PATTERNS.filter((pattern) => pattern.labelAnywhere && pattern.find).map((pattern) => pattern.id),
    );
    let from = 0;
    let held = null; // what the last window found in its own last stretch, kept only if the next one can't finish
    let last = null; // the window before, for seamRescue
    while (from < text.length) {
      let to = Math.min(from + DETECT_WINDOW_CHARS, text.length);
      if (to < text.length && text.charCodeAt(to - 1) >= 0xd800 && text.charCodeAt(to - 1) <= 0xdbff) to--;
      const windowText = text.slice(from, to);
      const link = from > 0 ? linkAt(text, from) : null;
      const results = detectWindow(windowText, scan, { link });
      const win = { from, to, text: windowText, link, results };
      if (held && scan.timedOut) merge(held.results, held.windowText, held.from);
      const isLast = scan.timedOut || to === text.length;
      const parts = seamParts(results, windowText, from > 0, !isLast);
      merge(parts.kept, windowText, from);
      if (last && labelled.size && !scan.timedOut) {
        if (held) merge(seamRescue(held.results, last, win, labelled, scan), windowText, from);
        merge(seamRescue(parts.dropped, win, last, labelled, scan), last.text, last.from);
      }
      held = parts.held.length ? { results: parts.held, windowText, from } : null;
      if (isLast) break;
      last = win;
      from = to - DETECT_WINDOW_OVERLAP;
      if (from > 0 && text.charCodeAt(from) >= 0xdc00 && text.charCodeAt(from) <= 0xdfff) from--;
    }

    if (!scan.timedOut && partialPrivateKeys.size) {
      const pattern = PATTERNS.find((item) => item.id === "private_key");
      const entry = merged.get("private_key");
      const partialCounts = new Map();
      for (const partials of partialPrivateKeys.values()) {
        for (const partial of partials) partialCounts.set(partial, (partialCounts.get(partial) || 0) + 1);
      }
      for (const [at, partials] of partialPrivateKeys) {
        const partial = partials.values().next().value;
        const begin = PEM_BEGIN.exec(partial);
        if (!begin) {
          scan.truncated = true;
          continue;
        }
        PEM_END.lastIndex = at + begin[0].length;
        const footer = PEM_END.exec(text);
        // The key runs to its footer, or to the end of the paste when it has none.
        const to = footer ? footer.index + footer[0].length : text.length;
        if (to - at > DETECT_PRIVATE_KEY_FALLBACK_CHARS) {
          scan.truncated = true;
          continue;
        }
        const block = text.slice(at, to);
        const cost = block.length * 2; // clean the candidate and run the private-key rule once
        scan.charsLeft -= cost;
        if (scan.charsLeft <= 0 || Date.now() > scan.deadline) {
          scan.timedOut = true;
          scan.truncated = true;
          console.info(LOG, "a scan ran past its time limit; sending what it found so far");
          break;
        }
        const cleaned = cleanText(block);
        for (const match of pattern.find(cleaned.clean)) {
          const matchAt = cleaned.clean.indexOf(match);
          if (matchAt < 0) continue;
          const raw =
            cleaned.start === null
              ? match
              : block.slice(cleaned.start[matchAt], cleaned.end[matchAt + match.length - 1]);
          if (!raw) continue;
          for (const previous of partials) {
            if (!raw.includes(previous)) continue;
            const remaining = partialCounts.get(previous) - 1;
            if (remaining <= 0) {
              partialCounts.delete(previous);
              entry.matches.delete(previous);
            } else {
              partialCounts.set(previous, remaining);
            }
          }
          entry.matches.add(raw);
        }
      }
    }

    const order = new Map([...PATTERNS, ...vaultKinds()].map((pattern, index) => [pattern.id, index]));
    const results = [...merged.values()].map(({ pattern, matches, reasonOf, asks }) => {
      const result = { ...pattern, matches: [...matches] };
      if (reasonOf.size) result.reasonOf = reasonOf;
      if (asks.size) result.asks = [...asks];
      return result;
    });
    results.sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    if (scan.truncated || scan.timedOut) results.truncated = true;
    return results;
  }

  // ---------- One window ----------
  // Words that close a message, not a password: "Do you know what my password is. Thanks!"
  const SIGN_OFF =
    /^(?:thanks|thank you|thx|ty|cheers|regards|best|please|gracias|merci|danke|ok|okay|lol|haha)[!.?,]*$/i;

  // A sign-off word that starts the sentence after "what … password is." is dropped. Any other word there is still
  // read as the password.
  function dropQuestionSentencePasswords(results, clean) {
    if (!results.some((result) => result.id === "password") || !clean.includes(". ")) return results;
    const questionSentenceStarts = new Set();
    const dotPattern = new RegExp(PHONE_DOT.source, PHONE_DOT.flags);
    for (const dot of clean.matchAll(dotPattern)) {
      if (!dot[1]) continue;
      const before = clean.slice(Math.max(0, dot.index - 60), dot.index);
      if (AFTER_IS.test(before) && ASKS.test(before)) questionSentenceStarts.add(dot.index + 2);
    }
    if (!questionSentenceStarts.size) return results;
    const onlyAtQuestionStart = (match) => {
      if (!match || !SIGN_OFF.test(match)) return false;
      let found = false;
      for (let at = clean.indexOf(match); at >= 0; at = clean.indexOf(match, at + 1)) {
        found = true;
        if (!questionSentenceStarts.has(at)) return false;
      }
      return found;
    };
    for (const result of results) {
      if (result.id === "password") result.matches = result.matches.filter((match) => !onlyAtQuestionStart(match));
    }
    for (let i = results.length - 1; i >= 0; i--) if (!results[i].matches.length) results.splice(i, 1);
    return results;
  }

  // A window of a large paste (detectFresh) can get `how`: `link` when it starts inside a link (linkAt); and `only`
  // and `told` when seamRescue reads it again for those kinds alone, told their labels are there (a Map, kind → true).
  function detectWindow(text, scan, how) {
    const { link, only, told } = how || {};
    const { clean, start, end, jsonBreaks } = cleanText(text, link);
    // The vault reads its words in the text as written too, before cleaning folds what UTF-8 read as Windows-1252
    // shows (unescapedView in vault/vault-unescape.js).
    setVaultSource(start ? { text, clean, start } : null);
    vaultCutShort(); // from here on: whether the vault left part of this window unread
    const yamlLines = yamlLiteralBlockLines(clean);
    const results = [];
    const kinds = only || [...PATTERNS, ...vaultKinds()];
    const why = [new Map(), new Map(), new Map()]; // one per reading: value → reason
    const read = (pattern, input, reasons) => {
      if (!pattern.find) return input.match(pattern.regex) || [];
      if (pattern.id === "password") return pattern.find(input, reasons);
      if (told && told.has(pattern)) return pattern.find(input, undefined, told.get(pattern));
      return pattern.find(input);
    };
    const { deadline } = scan;
    let charsLeft = scan.charsLeft;
    let timedOut = scan.timedOut;
    // `cost` is the length of text this call is about to hand a pattern, spent from the character budget before
    // the wall clock is even looked at, since that budget alone is enough for anything normal.
    const withinBudget = (cost) => {
      if (timedOut || scan.timedOut) return false;
      charsLeft -= cost;
      scan.charsLeft = charsLeft;
      if (charsLeft > 0 && Date.now() <= deadline) return true;
      timedOut = true;
      scan.timedOut = true;
      scan.truncated = true;
      console.info(LOG, "a scan ran past its time limit; sending what it found so far");
      return false;
    };
    // Every pattern reads the full text first, then the phone-dot and token-wrap readings. They run in that order
    // because numberRuns() keeps the previous text's runs, so interleaving the readings would throw that away.
    const first = kinds.map((pattern) => (withinBudget(clean.length) ? read(pattern, clean, why[0]) : []));
    const reading = withinBudget(clean.length) && secondReading(clean);
    const second = reading
      ? (only || PATTERNS).map((pattern) =>
          pattern.find?.fromVault || !withinBudget(reading.text.length) ? [] : read(pattern, reading.text, why[1]),
        )
      : [];
    const joinedReading =
      (jsonBreaks?.size || hasTokenLineBreak(clean, yamlLines)) && withinBudget(clean.length)
        ? withoutTokenLineBreaks(clean, jsonBreaks, yamlLines)
        : null;
    // The vault's own words and formats don't read Bandage labels (findVault in vault/saved-words.js), and a team's
    // kinds are just more vault entries.
    const third = joinedReading
      ? kinds.map((pattern) =>
          withinBudget(joinedReading.text.length) ? read(pattern, joinedReading.text, why[2]) : [],
        )
      : [];
    // A word like "Thanks" on the line under a wrapped key is joined on as a possible last bit of it, which turns a
    // key of fixed length into one too long for its rule. So each run that ends in such a word is read once more,
    // stopping right before the word, and what that finds is a value of the joined reading too.
    if (joinedReading) {
      let snippets = 0;
      for (const [last, tailEnd] of joinedReading.tails) {
        if (snippets >= MAX_WORD_TAIL_READS) break;
        if (!TAIL_WORD.test(joinedReading.text.slice(last, tailEnd))) continue;
        let from = Math.max(joinedReading.text.lastIndexOf("\n", last - 1) + 1, last - MAX_JOINED_TOKEN - 256);
        while (from < last && isTokenCode(joinedReading.text.charCodeAt(from - 1))) from++;
        const before = joinedReading.text.slice(from, last);
        snippets++;
        for (const [i, pattern] of kinds.entries()) {
          if (!withinBudget(before.length)) break;
          for (const match of read(pattern, before, why[2])) if (!third[i].includes(match)) third[i].push(match);
        }
      }
    }
    // A key typed in pieces, by kind: { match: the key joined up, value: the pieces as written, from, to }.
    const pieced = new Map();
    if (withinBudget(clean.length)) {
      for (const key of piecedKeys(clean)) {
        const rawFrom = start ? start[key.from] : key.from;
        const rawTo = end ? end[key.to - 1] : key.to;
        const list = pieced.get(key.index) || [];
        list.push({ match: key.match, value: text.slice(rawFrom, rawTo), from: key.from, to: key.to });
        pieced.set(key.index, list);
      }
    }
    // The vault stopped looking up runs in this window before it was done (RUN_LOOKUPS_PER_CHAR in
    // vault/saved-words.js).
    if (vaultCutShort()) scan.truncated = true;
    // A value its kind accepts, and not a secret's placeholder.
    const counts = (pattern, value) =>
      (!pattern.validate || pattern.validate(value)) && !(pattern.secret && isPlaceholder(value));
    // What the first reading found, by where it ends in the cleaned text.
    let firstEnds = null;
    const firstEndingAt = (to) => {
      if (!firstEnds) {
        firstEnds = new Map();
        for (const [i, pattern] of kinds.entries()) {
          for (const match of first[i]) {
            if (!match || !counts(pattern, match)) continue;
            for (let at = clean.indexOf(match); at >= 0; at = clean.indexOf(match, at + 1)) {
              const ending = firstEnds.get(at + match.length) || [];
              ending.push({ at, pattern, match });
              firstEnds.set(at + match.length, ending);
            }
          }
        }
      }
      return firstEnds.get(to) || [];
    };
    // Whether a whole value already runs from `at` up to a tail break: one this kind finds there, or one the lines
    // as written hold that its kind finds on its own. A label's kind doesn't count, since the label only says where
    // the value starts, so "token: ghp_…" with the token's last 2 characters on the next line is still one token.
    const wholeBefore = (pattern, at, splitAt) => {
      const from = joinedReading.sourceStart[at];
      for (const found of firstEndingAt(joinedReading.sourceEnd[splitAt - 1])) {
        if (found.at > from) continue;
        if (found.pattern === pattern || read(found.pattern, found.match, new Map()).includes(found.match)) return true;
      }
      const before = joinedReading.text.slice(Math.max(0, at - 256), splitAt);
      if (!withinBudget(before.length)) return false;
      return read(pattern, before, new Map()).some(
        (match) => match.length >= splitAt - at && before.endsWith(match) && counts(pattern, match),
      );
    };
    // Whether the first reading found a valid value of this same kind from `at` (or before) up to the break, or,
    // for a kind read from a label (a password, a service token), a provider's own kind found exactly there: the
    // more specific kind keeps the value.
    const sameKindEndsAt = (pattern, at, splitAt) => {
      const from = joinedReading.sourceStart[at];
      return firstEndingAt(joinedReading.sourceEnd[splitAt - 1]).some(
        (found) =>
          (found.pattern === pattern && found.at <= from) ||
          (LABEL_KINDS.has(pattern.id) &&
            found.at === from &&
            found.pattern.secret &&
            found.pattern.group === "credentials" &&
            !LABEL_KINDS.has(found.pattern.id)),
      );
    };
    // Breaks are in the order they're written, so the first one after a place is a binary search away. A paste can
    // hold thousands of them, and walking the whole list for every value would take seconds.
    const breakAfter = (at) => {
      const breaks = joinedReading.breaks;
      let low = 0;
      let high = breaks.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (breaks[middle] <= at) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const crossesBreak = (from, to) => joinedReading.breaks[breakAfter(from)] < to;
    // A value that crosses a break starts and ends within NEAR_BREAK characters of it, so a value is looked for
    // in the text around the breaks before it's looked for everywhere. Most values found in a long paste aren't
    // near one, and searching the whole text again from every break for each of them is slow.
    const NEAR_BREAK = 256;
    let nearBreaks = null;
    const nearABreak = (match) => {
      if (match.length > NEAR_BREAK) return true;
      if (nearBreaks === null) {
        const windows = [];
        let from = -1;
        let to = -1;
        for (const splitAt of joinedReading.breaks) {
          const windowStart = Math.max(0, splitAt - NEAR_BREAK);
          const windowEnd = Math.min(joinedReading.text.length, splitAt + NEAR_BREAK);
          if (windowStart <= to) to = windowEnd;
          else {
            if (to > from) windows.push(joinedReading.text.slice(from, to));
            from = windowStart;
            to = windowEnd;
          }
        }
        if (to > from) windows.push(joinedReading.text.slice(from, to));
        nearBreaks = windows.join("\0");
      }
      return nearBreaks.includes(match);
    };
    const joinedToRaw = (match, pattern) => {
      const mapped = [];
      if (!match || !nearABreak(match)) return mapped;
      const { breaks } = joinedReading;
      const lastBreak = breaks[breaks.length - 1];
      for (
        let at = joinedReading.text.indexOf(match);
        at >= 0 && at < lastBreak;
        at = joinedReading.text.indexOf(match, at + 1)
      ) {
        if (!crossesBreak(at, at + match.length)) continue;
        // A short last line that reads as a word stays out when the value is whole without it. The "Thanks"
        // under a whole key stays the person's own, and a key's last 2 characters on a line of their own don't.
        let length = match.length;
        const last = breaks[breakAfter(at + length - 1) - 1];
        const tailEnd = joinedReading.tails.get(last);
        if (
          tailEnd !== undefined &&
          TAIL_WORD.test(joinedReading.text.slice(last, tailEnd)) &&
          wholeBefore(pattern, at, last)
        ) {
          length = last - at;
          if (!crossesBreak(at, at + length)) continue;
        }
        // A key this kind already found whole on the first line, ending right at the one break the match crosses,
        // keeps the next line out unless that line reads as the rest of a key: "token: ghp_…" over "B=2", "2026", a
        // UUID or a timestamp stays the token alone, so Cover it leaves that line and the fingerprint stays put.
        const firstBreak = breakAfter(at);
        if (breakAfter(at + length - 1) - firstBreak === 1) {
          const splitAt = breaks[firstBreak];
          if (joinedReading.notKeyRest.has(splitAt) && sameKindEndsAt(pattern, at, splitAt)) continue;
        }
        const cleanFrom = joinedReading.sourceStart[at];
        const cleanTo = joinedReading.sourceEnd[at + length - 1];
        const rawFrom = start ? start[cleanFrom] : cleanFrom;
        const rawTo = end ? end[cleanTo - 1] : cleanTo;
        mapped.push({
          match: joinedReading.text.slice(at, at + length),
          value: text.slice(rawFrom, rawTo),
          from: cleanFrom,
          to: cleanTo,
        });
      }
      return mapped;
    };
    const joinedSpans = [];
    for (const [i, pattern] of kinds.entries()) {
      const firstFound = new Set(first[i]);
      const raw = new Set(firstFound);
      for (const match of second[i] || []) {
        const added = addedByReading(match, firstFound, reading);
        if (!added) continue;
        raw.add(added);
        if (why[1].has(match)) why[0].set(added, why[1].get(match)); // its reason, as written
      }
      const wrapped = [];
      const wrappedRaw = new Set();
      for (const match of third[i] || []) {
        if ((pattern.validate && !pattern.validate(match)) || (pattern.secret && isPlaceholder(match))) continue;
        for (const mapped of joinedToRaw(match, pattern)) {
          if (mapped.to - mapped.from > mapped.match.length) {
            wrapped.push(mapped);
            joinedSpans.push(mapped);
          }
          raw.add(mapped.value);
          wrappedRaw.add(mapped.value);
          if (why[2].has(match)) why[0].set(mapped.value, why[2].get(match));
        }
      }
      for (const mapped of pieced.get(i) || []) {
        wrapped.push(mapped);
        joinedSpans.push(mapped);
        raw.add(mapped.value);
        wrappedRaw.add(mapped.value);
      }
      // Only a value inside a wrapped one can be covered by it. Checking that first, against the few wrapped values,
      // keeps a paste of thousands of addresses from searching the whole text once for each.
      const wrappedText = wrapped.map((item) => item.match).join("\0");
      const coveredByWrap = (match) => {
        if (!match || !wrappedText.includes(match)) return false;
        let found = false;
        for (let at = clean.indexOf(match); at >= 0 && match; at = clean.indexOf(match, at + 1)) {
          found = true;
          const inWrap = (item) => item.match.includes(match) && item.from <= at && item.to >= at + match.length;
          if (!wrapped.some(inWrap)) return false;
        }
        return found;
      };
      const matches = [...raw].filter(
        (match) =>
          wrappedRaw.has(match) ||
          (!coveredByWrap(match) &&
            (!pattern.validate || pattern.validate(match)) &&
            !(pattern.secret && isPlaceholder(match))),
      );
      if (matches.length) results.push({ ...pattern, matches });
    }
    const spanText = joinedSpans.map((span) => span.match).join("\0"); // the same first check as coveredByWrap's
    for (const result of results) {
      result.matches = result.matches.filter((match) => {
        if (!match || !spanText.includes(match)) return true;
        let found = false;
        for (let at = clean.indexOf(match); at >= 0 && match; at = clean.indexOf(match, at + 1)) {
          found = true;
          if (
            !joinedSpans.some(
              (span) =>
                span.value !== match && span.match.includes(match) && span.from <= at && span.to >= at + match.length,
            )
          ) {
            return true;
          }
        }
        return !found;
      });
    }
    for (let i = results.length - 1; i >= 0; i--) if (!results[i].matches.length) results.splice(i, 1);
    results.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    dropQuestionSentencePasswords(results, clean);

    // A weaker match is hidden only when every occurrence sits inside a more severe match. A separate copy must
    // keep its own warning. Longer values are checked first so a paste full of details does not need pairwise work.
    // `overlapChecks` counts candidates, never values, so the growth check can use the algorithm's work instead of
    // the clock, which is too noisy on a busy machine.
    const kept = [];
    if (!only) globalThis.Clotr.overlapChecks = 0; // a window read again adds its own
    const occurrenceCache = new Map();
    const spansOf = (value) => {
      if (occurrenceCache.has(value)) return occurrenceCache.get(value);
      const spans = [];
      for (let at = clean.indexOf(value); at >= 0 && value; at = clean.indexOf(value, at + 1)) {
        spans.push([at, at + value.length]);
      }
      occurrenceCache.set(value, spans);
      return spans;
    };
    for (const result of results) {
      const moreSevere = kept.filter((other) => SEVERITY_RANK[other.severity] > SEVERITY_RANK[result.severity]);
      const inside = (match) => {
        const containers = [];
        for (const stronger of moreSevere) {
          for (const longer of stronger.longestFirst) {
            globalThis.Clotr.overlapChecks++;
            if (longer.length <= match.length) break;
            // One at a time: a value pasted 130,000 times has that many spans, too many to spread into one call.
            if (longer.includes(match)) for (const span of spansOf(longer)) containers.push(span);
          }
        }
        if (!containers.length) return false;
        const occurrences = spansOf(match);
        if (!occurrences.length) return false;
        containers.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
        let next = 0;
        let farthestEnd = -1;
        for (const [occurrenceStart, occurrenceEnd] of occurrences) {
          while (next < containers.length && containers[next][0] <= occurrenceStart) {
            farthestEnd = Math.max(farthestEnd, containers[next][1]);
            next++;
          }
          globalThis.Clotr.overlapChecks++;
          if (farthestEnd < occurrenceEnd) return false;
        }
        return true;
      };
      const matches = result.matches.filter((match) => !inside(match));
      if (matches.length) {
        kept.push({
          ...result,
          matches,
          longestFirst: [...matches].sort((a, b) => b.length - a.length),
        });
      }
    }
    for (const result of kept) {
      delete result.longestFirst;
      if (result.id !== "password") continue;
      // `reasonOf` keeps each code's own reason, so a warning still knows them even after some matches got
      // filtered out.
      const withReason = result.matches.filter((match) => why[0].has(match));
      const reasonOf = new Map(withReason.map((match) => [match, why[0].get(match)]));
      const reasons = new Set(reasonOf.values());
      const asks = ASK_REASONS.filter((reason) => reasons.has(reason));
      if (asks.length) Object.assign(result, { asks, reasonOf });
    }
    // Marked on the array itself so a caller that wants to know can, without changing the shape every caller
    // already reads. A host has to read this flag off detect()'s own return value, since map/filter/flatMap
    // all build a new array and leave it behind.
    const flagged = (arr) => {
      if (timedOut || scan.timedOut || scan.truncated) arr.truncated = true;
      return arr;
    };
    if (!start) return flagged(kept);
    // Maps each cleaned match back to every place it occurs in the original text.
    const original = (match) => {
      const out = new Set();
      for (let at = clean.indexOf(match); at >= 0 && match; at = clean.indexOf(match, at + 1)) {
        out.add(text.slice(start[at], end[at + match.length - 1]));
      }
      return out.size ? [...out] : [match];
    };
    return flagged(
      kept.map((result) => {
        const matches = [...new Set(result.matches.flatMap(original))];
        if (!result.reasonOf) return { ...result, matches };
        const asWritten = ([match, reason]) => original(match).map((written) => [written, reason]);
        const reasonOf = new Map([...result.reasonOf].flatMap(asWritten));
        return { ...result, matches, reasonOf };
      }),
    );
  }

  globalThis.Clotr = {
    ...globalThis.Clotr,
    SEVERITY_RANK,
    DETECT_BUDGET_CHARS,
    DETECT_BACKSTOP_MS,
    DETECT_WINDOW_CHARS,
    DETECT_WINDOW_OVERLAP,
    DETECT_PRIVATE_KEY_FALLBACK_CHARS,
    detect,
    redact,
    generalize,
    wordStarts,
    isSavedWord,
    generalForms,
    BANDAGE_WORDS,
    BANDAGE_BORN_IN,
    readBandageLabels,
    bandageKindOf,
    RESPONSES,
    defaultResponse,
    responseFor,
    stricter,
    normalize,
    cleanText,
    findPdfStreams,
    pdfPageText,
    xmlToText,
    sha256,
    fingerprint,
    fingerprintStrong,
    fingerprintFor,
    wordEntry,
  };
})();

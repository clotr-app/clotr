// The vault: the words, IDs and formats a person or a team saved, kept only as fingerprints, and finding them in
// a text. detect() runs it with the rules, and the vault page saves to it through globalThis.Clotr.
(() => {
  "use strict";

  const {
    ruleTable,
    GLUE,
    GLUE_STOP,
    TRAIL,
    ABBREVIATION,
    mayAbbreviate,
    CAPITALS,
    HAN_AFTER,
    NAME_AFTER,
    JOINED_PART,
    SEPARATED,
    PROSE_BREAK,
    CELL_SPLIT,
    HTML_BACK,
    cellsHoldName,
    LEADS,
    JOINER,
    MARKED_LETTER,
    CLOSED_MAX,
    CLOSED_GAP,
    closedAnywhere,
    VAULT_WORD,
    isClosedLetter,
    closedAt,
    stepsOf,
    SPLITS,
    PIECE_MIN,
    DIGIT_PIECE_MIN,
    PERSON_KINDS,
    pieceLength,
    piecesOf,
    HEAD_BITS,
    stepMark,
    headOf,
    unescapedView,
    changedNear,
    HANGUL,
    ONLY_HANGUL,
    PARTICLES_MAX,
    SEEN_COUNTS,
    SEEN_SPAN_MAX,
    RUN_AFTER,
    PARTICLES,
    FOR_PEOPLE,
    CASE_PARTICLE,
    SENTENCE_GOES_ON,
    opensSentence,
    onWordEdges,
  } = globalThis.ClotrInternal;

  // ---------- Your vault: things you told Clotr to protect ----------
  // Words and phrases you've added, like your name or your employer, are known only by fingerprint, a salted hash
  // of the lowercased phrase, so they never sit in storage as text. An account or ID format like "AB-######" is
  // stored as a shape instead (# for a digit, @ for a letter). Phone, email and address entries are value
  // fingerprints, matched in content.js against whatever the regular patterns found.

  let vault = null; // { salt, words: Map(fp → type), maxWords, closed, shapes: [{ type, re, whole, near }] }
  let vaultHits = { text: null, hits: [] };

  // ---------- Saved formats ----------

  // ── Saved ID shapes ──
  // A shape becomes a regex of literal characters plus a digit class for each # and a letter class for each @, with
  // no repeats, choices or groups to backtrack through. At MAX_SHAPE characters, a team's own formats can never
  // make matching slow.
  const MAX_SHAPE = 40;
  // A space in a format is also a tab, a no-break space or a plus sign, as a search link writes one ("q=AB+1234").
  const SHAPE_SPACE = "[ \\t\\u00a0\\u202f+]";

  function shapePatternBody(shape) {
    return [...shape]
      .map((character) => {
        if (character === "#") return "\\d";
        if (character === "@") return "[A-Za-z]";
        if (character === " ") return SHAPE_SPACE;
        return character.replace(/[$.*+?^{}()|[\]\\/-]/g, "\\$&");
      })
      .join("");
  }

  function shapeEdgeClass(character) {
    if (character === "#") return "\\d";
    if (character === "@" || /[A-Za-z]/.test(character)) return "[A-Za-z]";
    return "[A-Za-z0-9]";
  }

  // A format stands beside anything but a letter or a digit, so it's found in a file or branch name
  // ("report_AB-1234.pdf") but never inside a longer ID ("XAB-1234", "AB-12345"). Beside a hyphen it stands only
  // when the other kind of character follows, as a word does in a branch name ("AB-1234-fix-login", "2024-AB-1234"),
  // since the same kind ("AB-1234-5678", "XY-AB-1234") is a longer ID.
  function compileShapePattern(shape) {
    const firstEdge = shapeEdgeClass(shape[0]);
    const lastEdge = shapeEdgeClass(shape[shape.length - 1]);
    const body = shapePatternBody(shape);
    const pattern = "(?<![A-Za-z0-9]|" + firstEdge + "-)" + body + "(?![A-Za-z0-9]|-" + lastEdge + ")";
    return new RegExp(pattern, "gi");
  }

  // Whether all of `value` fits a saved format, as an ID a format found does. Cover hides such a value everywhere it
  // appears (isSavedWord in respond/cover-values.js), since the number would still show inside a longer word, where a
  // saved name inside a longer word is a different word.
  const isVaultFormat = (value) => Boolean(vault?.shapes.some(({ whole }) => whole.test(value)));

  function isValidVaultShape(shape) {
    if (typeof shape !== "string") return false;
    if (shape.length > MAX_SHAPE) return false;
    if (/\d/.test(shape)) return false;
    return /[#@].*[#@]/.test(shape);
  }

  // ── Near words ──
  // A format that lists "near" words only counts when one shows up as a whole word in the 40 characters before it,
  // in any case and with or without accents. A plain text search, not a regex.
  const NEAR_CHARS = 40;
  const MAX_NEAR = 10;
  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wordChar = (ch) => Boolean(ch) && /[\p{L}\p{N}]/u.test(ch);

  function cleanNearWords(near) {
    if (!Array.isArray(near)) return null;
    const words = [];
    for (const nearWord of near) {
      if (typeof nearWord !== "string") continue;
      const foldedWord = fold(nearWord.trim().replace(/\s+/g, " "));
      if (!foldedWord || foldedWord.length > NEAR_CHARS || words.includes(foldedWord)) continue;
      words.push(foldedWord);
      if (words.length >= MAX_NEAR) break;
    }
    return words.length ? words : null;
  }

  function nearBefore(text, index, near) {
    const before = fold(text.slice(Math.max(0, index - NEAR_CHARS), index));
    // In a script written without spaces ("案件番号は…"), a word stands as one beside any letter.
    const edge = (inner, outer) => !wordChar(outer) || isClosedLetter(inner) || isClosedLetter(outer);
    for (const nearWord of near) {
      for (let at = before.indexOf(nearWord); at >= 0; at = before.indexOf(nearWord, at + 1)) {
        if (edge(nearWord[0], before[at - 1]) && edge(nearWord[nearWord.length - 1], before[at + nearWord.length])) {
          return true;
        }
      }
    }
    return false;
  }

  // ---------- Loading the vault ----------

  // ── Team kinds ──
  // A team can add its own kinds at run time, named in its browser policy. detect() checks each like a built-in
  // kind, through the vault's words and formats of that type. They never join the static PATTERNS table, so a page
  // with no vault set only ever sees the built-in kinds.
  const MAX_VAULT_KINDS = 100;
  let customVaultKinds = []; // [{ id, group, name, cover, severity, team, find }]

  function cleanVaultKinds(kinds) {
    const builtInKinds = new Set(ruleTable().map((pattern) => pattern.id));
    const cleanedKinds = [];
    const kindsToRead = Array.isArray(kinds) ? kinds : [];

    for (const kind of kindsToRead) {
      if (cleanedKinds.length >= MAX_VAULT_KINDS) break;
      if (!kind || typeof kind !== "object") continue;

      const id = kind.id;
      if (typeof id !== "string" || !/^[a-z_]{2,40}$/.test(id)) continue;
      if (builtInKinds.has(id) || cleanedKinds.some((savedKind) => savedKind.id === id)) continue;

      const name = typeof kind.name === "string" ? kind.name.trim().slice(0, 40).trim() : "";
      if (!name) continue;

      const coverText = typeof kind.cover === "string" && kind.cover.trim() ? kind.cover : name;
      const cover = coverText.trim().slice(0, 20).trim();
      cleanedKinds.push({ id, group: "custom", name, cover, severity: "medium", team: true, find: findVault(id) });
    }
    return cleanedKinds;
  }

  const vaultKinds = () => customVaultKinds;

  // ── Loading the vault ──
  // Takes the stored vault's entries (each a word, shape or value, plus any a team manages) and the extra kinds
  // those entries may name beyond the built-in ones.
  function setVault(v) {
    vaultHits = { text: null, hits: [] };
    customVaultKinds = cleanVaultKinds(v?.kinds);

    const entries = v?.entries || [];
    const words = entries.filter((entry) => entry.kind === "word" && entry.fp);
    const shapes = entries.filter((entry) => entry.kind === "shape" && isValidVaultShape(entry.shape));
    if (!words.length && !shapes.length) {
      vault = null;
      return;
    }

    // A loop rather than Math.max(...), which runs out of stack on a vault of a few hundred thousand words.
    let maxWords = 1;
    // The counts of steps saved with each head (closedHead); a count saved without one is never looked up in a run.
    const heads = new Map();
    // Words saved without a count and a head, looked up in the pieces of such a run (oldWordsIn).
    const loose = new Set();

    for (const entry of words) {
      maxWords = Math.max(maxWords, Math.min(4, Number(entry.words) || 1));
      const hasClosedCount = Number.isInteger(entry.closed) && entry.closed >= 2 && entry.closed <= CLOSED_MAX;
      const hasValidHead = Number.isInteger(entry.head) && entry.head >= 0 && entry.head < 1 << HEAD_BITS;
      if (!hasClosedCount || !hasValidHead) {
        loose.add(entry.fp);
        continue;
      }

      const counts = heads.get(entry.head) || [];
      if (counts.includes(entry.closed)) continue;
      heads.set(
        entry.head,
        [...counts, entry.closed].sort((left, right) => left - right),
      );
    }

    // A name saved with an apostrophe is also found by its form without one (wordEntry in respond/fingerprints.js).
    const wordEntries = words.flatMap((entry) => {
      const fingerprint = [entry.fp, entry.type];
      if (typeof entry.joined !== "string") return [fingerprint];
      return [fingerprint, [entry.joined, entry.type]];
    });

    vault = {
      salt: v.salt,
      words: new Map(wordEntries),
      maxWords,
      heads,
      loose,
      shapes: shapes.map((entry) => ({
        type: entry.type,
        re: compileShapePattern(entry.shape),
        whole: new RegExp("^" + shapePatternBody(entry.shape) + "$", "i"),
        near: cleanNearWords(entry.near),
      })),
    };
  }

  // ---------- Reading a text for saved words ----------

  // ── What detect() tells the vault scan ──
  // The time detect() must be done by, so a vault whose words make it look up a great many stretches of text stops
  // there (detect() then marks its answer cut short) rather than run on. Infinity outside a detect() call.
  let scanDeadline = Infinity;
  function setScanDeadline(value) {
    scanDeadline = typeof value === "number" ? value : Infinity;
  }

  // The text detect() is reading as written ({ text, clean, start }: cleanText's answer for it), so a saved word in
  // it is read before cleaning folds what UTF-8 read as Windows-1252 shows (unescapedView). Null outside it.
  let vaultSource = null;
  function setVaultSource(source) {
    vaultSource = source || null;
  }

  // Whether the vault left runs unread in a text it read since this was last asked (RUN_LOOKUPS_PER_CHAR), so
  // detect() marks its answer cut short.
  let vaultShort = false;
  function vaultCutShort() {
    const wasShort = vaultShort;
    vaultShort = false;
    return wasShort;
  }

  // ── Looking words up in the vault ──
  // How a scan looks a stretch of text up: `typeOf(span)` in every form a saved word may have, and `lookup(form,
  // span)` in one. Up to LOOKUPS_KEPT answers are kept, so a phrase written again (a long paste repeats its words)
  // isn't cleaned and hashed again.
  const LOOKUPS_KEPT = 50_000;
  // The runs looked up in a text of `length` characters (vaultWordsIn) stop after RUN_LOOKUPS_PER_CHAR per character
  // and RUN_LOOKUPS_MORE more: far more than any text needs unless it repeats the first letters of many saved words of
  // different lengths, each time with something new after them, and a fingerprint costs about as much as reading a
  // character with every other rule. The scan is then marked cut short (vaultCutShort), and goes on.
  const RUN_LOOKUPS_PER_CHAR = 2;
  const RUN_LOOKUPS_MORE = 20_000;

  function lookupsFor(length = 0) {
    const fingerprint = globalThis.Clotr.fingerprint; // set by respond/fingerprints.js, read when called
    const findSavedType = (form, span) => vault.words.get(fingerprint(vault.salt, form, span));

    function cacheAnswers(answer) {
      const answersByKey = new Map();
      return function cachedAnswer(key) {
        let cachedType = answersByKey.get(key);
        if (cachedType !== undefined) return cachedType || undefined;
        cachedType = answer(key);
        if (answersByKey.size >= LOOKUPS_KEPT) answersByKey.clear();
        answersByKey.set(key, cachedType || null);
        return cachedType;
      };
    }

    function readSavedType(span) {
      const savedType = findSavedType("watch_list", span);
      const hasHyphen = /[-'`]/.test(span);
      if (savedType || (!hasHyphen && !/[^\x00-\x7f]/.test(span))) return savedType;

      // A word saved before hyphens read as spaces and apostrophes as nothing kept them, and one saved before a space
      // or a middle dot between letters of a script written without spaces was dropped kept that.
      const savedSpaced =
        hasHyphen || /[\u2019\u02bc\u00b4]/.test(span) || (/[\s\u30fb\uff65]/.test(span) && closedAnywhere.test(span));
      const spacedType = savedSpaced && findSavedType("watch_list_spaced", span);
      if (spacedType) return spacedType;

      // The form saved before 0.9.67 differs from today's wherever taking marks off changes the word: an accent
      // (written on the letter or as a mark of its own) or a Korean syllable, which NFD splits into its letters.
      const decomposed = span.normalize("NFD");
      if (decomposed !== span || /\p{M}/u.test(decomposed)) {
        const accentedType = findSavedType("watch_list_accented", span);
        if (accentedType) return accentedType;
      }
      if (hasHyphen || MARKED_LETTER.test(span)) {
        const markedType = findSavedType("watch_list_marks", span);
        if (markedType) return markedType;
      }
      return undefined;
    }

    const typeOf = cacheAnswers(readSavedType);
    const currentFormLookup = cacheAnswers((span) => findSavedType("watch_list", span));
    const spacedFormLookup = cacheAnswers((span) => findSavedType("watch_list_spaced", span));

    // A step's part in a head (stepMark), kept by the step as written (a letter by its code).
    const stepMarks = new Map();
    function markOf(key, stepText, start, end) {
      let cachedMark = stepMarks.get(key);
      if (cachedMark === undefined) {
        cachedMark = stepMark(vault.salt, stepText.slice(start, end));
        if (stepMarks.size >= LOOKUPS_KEPT) stepMarks.clear();
        stepMarks.set(key, cachedMark);
      }
      return cachedMark;
    }

    function lookup(form, span) {
      if (form === "watch_list") return currentFormLookup(span);
      return spacedFormLookup(span);
    }

    return {
      typeOf,
      lookup,
      markOf,
      left: RUN_LOOKUPS_PER_CHAR * length + RUN_LOOKUPS_MORE,
    };
  }

  // ── Words saved without a count of steps ──
  // A word saved without one (as 1.6.1's vault page saved every word) is also looked for inside a run of letters of a
  // script written without spaces, in the pieces its marks split it into, as 1.6.1 read such a run ("มาลีมาแล้ว" is
  // "มาลี", "มาแล้", "ว"), up to maxWords pieces in a row. A piece keeps the marks after it, so a word ending in a
  // vowel sign is found and hidden whole. Each hit goes to `addHit`; given `nearEscape`, only the phrases it says are
  // near an escape are looked up. True when the scan ran out of time.
  const MARKED_PIECE = /[\p{L}\p{N}]+\p{M}*/gu;
  function oldWordsIn(textView, savedWords, addHit, vaultLookups, nearEscape) {
    const fingerprint = globalThis.Clotr.fingerprint;
    let lookedUpCount = 0;

    for (const word of savedWords) {
      // With no mark, the word is one piece, and it was looked up whole.
      if (!word.closed || !/\p{M}/u.test(textView.slice(word.start, word.end))) continue;
      const pieces = [...textView.slice(word.start, word.end).matchAll(MARKED_PIECE)];

      for (let firstPieceIndex = 0; firstPieceIndex < pieces.length; firstPieceIndex++) {
        for (
          let lastPieceIndex = firstPieceIndex;
          lastPieceIndex < pieces.length && lastPieceIndex - firstPieceIndex < vault.maxWords;
          lastPieceIndex++
        ) {
          const pieceStart = word.start + pieces[firstPieceIndex].index;
          const pieceEnd = word.start + pieces[lastPieceIndex].index + pieces[lastPieceIndex][0].length;
          const isWholeWord = pieceStart === word.start && pieceEnd === word.end;
          if (isWholeWord || (nearEscape && !nearEscape(pieceStart, pieceEnd))) continue;

          if (--vaultLookups.left < 0) return false; // the scan is marked cut short (vaultMatches)
          lookedUpCount++;
          if (lookedUpCount % 1024 === 0 && Date.now() > scanDeadline) return true;

          const fingerprintValue = fingerprint(vault.salt, "watch_list", textView.slice(pieceStart, pieceEnd));
          addHit(vault.loose.has(fingerprintValue) && vault.words.get(fingerprintValue), pieceStart, pieceEnd);
        }
      }
    }
    return false;
  }
  // ── Finding saved words in a text ──
  function vaultWordsIn(view, asWritten, hits, lookups, near = null) {
    const { typeOf, lookup, markOf } = lookups;

    function hit(type, start, end) {
      if (!type) return;
      hits.push({ type, span: asWritten(start, end) });
    }
    function writtenBefore(start) {
      return asWritten(Math.max(0, start - HTML_BACK), start);
    }

    // A phrase from `start` to `end`, as written and in the other ways a saved word may be written there.
    // A phrase of letters, digits and marks alone (`isPlainPhrase`) has nothing between its words to read another
    // way, so a long paste of words written straight into each other ("3年B組") skips those readings.
    function tryPhrase(start, end, isPlainPhrase = false) {
      if (near && !near(start, end)) return;
      const span = view.slice(start, end);
      // A name found split across cells counts only where they hold one (cellsHoldName).
      function phraseHit(type, from, to) {
        if (!type) return;
        const written = PERSON_KINDS.has(type) && !isPlainPhrase && asWritten(from, to);
        if (written && CELL_SPLIT.test(written) && !cellsHoldName(view, from, written, writtenBefore)) return;
        hits.push({ type, span: asWritten(from, to) });
      }

      phraseHit(typeOf(span), start, end);
      let trail = null;
      if (".!?+".includes(view[end] || "x")) {
        TRAIL.lastIndex = end;
        trail = TRAIL.exec(view);
      }
      if (trail) {
        for (let trailLength = 1; trailLength <= trail[0].length; trailLength++) {
          phraseHit(typeOf(span + trail[0].slice(0, trailLength)), start, end + trailLength);
        }
      }
      if (mayAbbreviate(view.charCodeAt(end - 1)) && ABBREVIATION.test(span) && trail?.[0][0] !== ".") {
        phraseHit(typeOf(`${span}.`), start, end);
      }
      if (LEADS.includes(view[start - 1])) phraseHit(typeOf(view[start - 1] + span), start - 1, end);
      if (isPlainPhrase) return;

      JOINER.lastIndex = 0;
      const joined = JOINER.test(span) && span.replace(JOINER, " ");
      if (joined) phraseHit(typeOf(joined), start, end);
      SEPARATED.lastIndex = 0;
      if (!SEPARATED.test(span)) return;
      const apart = span.replace(SEPARATED, (gap) => (PROSE_BREAK.test(gap) || GLUE_STOP.test(gap) ? gap : " "));
      if (apart !== span && apart !== joined) phraseHit(typeOf(apart), start, end);
    }

    // ── The words, and phrases of them ──
    const words = [];
    let previousWordEnd = 0;
    for (const wordMatch of view.matchAll(VAULT_WORD)) {
      const wordStart = wordMatch.index;
      const wordEnd = wordStart + wordMatch[0].length;
      // Most words in such a paste touch the one before, and an empty gap needs no reading.
      const gap = wordStart === previousWordEnd ? "" : view.slice(previousWordEnd, wordStart);
      // In a script written without spaces. None of them comes before Thai.
      const closed = view.charCodeAt(wordStart) >= 0xe00 && closedAt(view, wordStart);
      const previousWord = gap === "" ? words[words.length - 1] : undefined;
      if (
        previousWord &&
        closed &&
        !previousWord.closed &&
        (CAPITALS.test(view.slice(previousWord.start, previousWord.end)) ||
          (HAN_AFTER.test(view.slice(wordStart, wordStart + 2)) &&
            !NAME_AFTER.test(view.slice(wordStart, wordStart + 2))))
      ) {
        previousWord.inCompound = true;
      }
      words.push({
        start: wordStart,
        end: wordEnd,
        spaced: gap !== "" && /\s/.test(gap),
        stop: gap !== "" && GLUE_STOP.test(gap),
        blank: gap === "" || CLOSED_GAP.test(gap),
        closed,
        plain: closed || !JOINED_PART.test(wordMatch[0]),
        capsBefore: previousWord?.closed === true && !closed && CAPITALS.test(wordMatch[0]),
        // Set by the next word. Every word starts with it, so they all read alike in the loops below.
        inCompound: false,
      });
      previousWordEnd = wordEnd;
    }

    for (let firstWordIndex = 0; firstWordIndex < words.length; firstWordIndex++) {
      const start = words[firstWordIndex].start;
      let spacedGroups = 1;
      let isPlainPhrase = true;
      for (
        let lastWordIndex = firstWordIndex;
        lastWordIndex < words.length && lastWordIndex - firstWordIndex < vault.maxWords + GLUE;
        lastWordIndex++
      ) {
        if (lastWordIndex > firstWordIndex && words[lastWordIndex].spaced) spacedGroups++;
        else if (lastWordIndex > firstWordIndex && words[lastWordIndex].stop) break;
        if (spacedGroups > vault.maxWords) break;
        isPlainPhrase =
          isPlainPhrase &&
          words[lastWordIndex].plain &&
          (lastWordIndex === firstWordIndex || words[lastWordIndex].start === words[lastWordIndex - 1].end);
        if (!words[firstWordIndex].capsBefore && !words[lastWordIndex].inCompound) {
          tryPhrase(start, words[lastWordIndex].end, isPlainPhrase);
        }
      }

      // ── Pieces of one joined word ──
      // Inside one joined word ("in/ann-smith-4b2a", "INITECH_API", "AnnSmith1990"), its pieces in a row are tried
      // as a phrase too, with spaces, and a piece on its own when nothing but an underscore, a dot or a digit's edge
      // sets it off ("initech.com", "smith1990"). A hyphen or an apostrophe makes one name of its parts
      // ("Ann-Marie", "O'Brien"), and a capital inside a word ("McDonald") only splits a whole saved phrase.
      // A word of one character has no pieces.
      const end = words[firstWordIndex].end;
      if (end - start < 2 || (near && !near(start, end))) continue;
      const token = view.slice(start, end);
      if (!SPLITS.test(token)) continue;
      // How many characters of the token finish an escape before it ("%" + "C3...", "\" + "u00e9..."), or -1.
      let escaped = -1;
      if (view[start - 1] === "%" && /^[0-9a-fA-F]{2}/.test(token)) escaped = 2;
      else if (view[start - 1] === "\\" && /^u[0-9a-fA-F]{4}/.test(token)) escaped = 5;
      const pieces = piecesOf(token, start, escaped);
      const pieceCount = pieces.length;
      // What sets off the piece at `pieceIndex` from the one before it.
      const jointBefore = (pieceIndex) =>
        pieceIndex === 0 || pieceIndex === pieceCount ? "end" : pieces[pieceIndex].joint;
      const isFreeJoint = (pieceIndex) => ["end", "free", "digit"].includes(jointBefore(pieceIndex));

      for (let firstPieceIndex = 0; firstPieceIndex < pieceCount; firstPieceIndex++) {
        let phrase = view.slice(pieces[firstPieceIndex].start, pieces[firstPieceIndex].end);
        if (pieceCount > 1 && isFreeJoint(firstPieceIndex) && isFreeJoint(firstPieceIndex + 1)) {
          // Set off by an underscore or a dot, a piece needs PIECE_MIN letters and is never a person's name: code is
          // named after things ("hunter_config", "tree_walker"), and a company or project is what it's named for
          // ("INITECH_API"). Set off only by digits, it needs DIGIT_PIECE_MIN and a number of two or more digits as
          // the rest of the word, as a username writes one ("smith1990", "ortiz88"), not a version or a room
          // ("mark2", "gemma3", "ward3b").
          const dotted = jointBefore(firstPieceIndex) === "free" || jointBefore(firstPieceIndex + 1) === "free";
          const otherPiece = pieces[1 - firstPieceIndex];
          const numbered = pieceCount === 2 && /^\p{N}{2,}$/u.test(view.slice(otherPiece.start, otherPiece.end));
          const longEnough = pieceLength(phrase) >= (dotted ? PIECE_MIN : DIGIT_PIECE_MIN);
          const type = longEnough && (dotted || numbered) && typeOf(phrase);
          if (type && !(dotted && PERSON_KINDS.has(type))) {
            hit(type, pieces[firstPieceIndex].start, pieces[firstPieceIndex].end);
          }
        }
        for (
          let lastPieceIndex = firstPieceIndex + 1;
          lastPieceIndex < pieceCount && lastPieceIndex - firstPieceIndex < vault.maxWords;
          lastPieceIndex++
        ) {
          if (pieces[lastPieceIndex].joint === "quote") break;
          phrase += ` ${view.slice(pieces[lastPieceIndex].start, pieces[lastPieceIndex].end)}`;
          hit(typeOf(phrase), pieces[firstPieceIndex].start, pieces[lastPieceIndex].end);
        }
      }
    }

    // ── Words written into each other ──
    // Words with nothing between them, where letters of a script written without spaces meet other letters or
    // digits ("101동1203호", "3年B組"), are also one word, as up to maxWords such words in a row. Not past CLOSED_MAX
    // words, longer than any run looked up below: a long paste with no space in it ("3年B組3年C組…") is read in its
    // words and runs, not hashed whole.
    const units = [];
    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
      const touching = wordIndex > 0 && words[wordIndex].start === words[wordIndex - 1].end;
      if (touching) {
        const unit = units[units.length - 1];
        unit.end = words[wordIndex].end;
        unit.touching = true;
        unit.wordCount++;
      } else {
        units.push({ start: words[wordIndex].start, end: words[wordIndex].end, touching, wordCount: 1 });
      }
    }
    for (let firstUnitIndex = 0; firstUnitIndex < units.length; firstUnitIndex++) {
      let touching = false;
      let wordCount = 0;
      for (
        let lastUnitIndex = firstUnitIndex;
        lastUnitIndex < units.length && lastUnitIndex - firstUnitIndex < vault.maxWords;
        lastUnitIndex++
      ) {
        touching = touching || units[lastUnitIndex].touching;
        wordCount += units[lastUnitIndex].wordCount;
        if (wordCount > CLOSED_MAX) break;
        // One with no word written into another was tried above.
        if (touching) tryPhrase(units[firstUnitIndex].start, units[lastUnitIndex].end);
      }
    }

    if (vault.loose.size && oldWordsIn(view, words, hit, lookups, near)) return true;
    if (!vault.heads.size) return false;

    // ── Runs of steps in scripts written without spaces ──
    // Where many counts share a head, a run start whose text and surroundings were all seen at another one before (a
    // paste repeating the first letters of a saved company's name) starts the very runs already looked up there,
    // found or not, so it's skipped: the letter before it says whether it starts a word, and RUN_AFTER letters after
    // its longest run whether the word goes on. Only in the text as written (no `near`), where a run found is pushed
    // as it reads, so the one found before is the same.
    const seen = new Set();
    function seenAround(stepStarts, stepEnds, stepIndex, counts) {
      const runStart = stepStarts[stepIndex];
      const codeBefore = view.charCodeAt(runStart - 1);
      // After a mark or half of a pair, whether it starts a word depends on what comes before that.
      if ((codeBefore >= 0xd800 && codeBefore <= 0xdfff) || /\p{M}/u.test(view[runStart - 1] || "")) return false;
      const runEnd = stepEnds[Math.min(stepIndex + counts[counts.length - 1], stepStarts.length) - 1];
      if (runEnd - runStart > SEEN_SPAN_MAX) return false;
      const stop = Math.min(view.length, runEnd + RUN_AFTER);
      const characterBefore = runStart > 0 ? view[runStart - 1] : "";
      const key = `${characterBefore}|${runEnd - runStart}|${stop - runEnd}|${view.slice(runStart, stop)}`;
      if (seen.has(key)) return true;
      if (seen.size >= LOOKUPS_KEPT) seen.clear();
      seen.add(key);
      return false;
    }

    // Every run of a saved count of steps in a stretch of words with nothing or only spaces between them and a letter
    // of a script written without spaces ("山田 太郎さん", "ジョン・スミスさん"), where a word with that count was saved
    // with the head the run starts with. A saved word is in today's form once it has a count, or in the form it had
    // before a space or a middle dot in it was dropped, which a run with one in it is looked up in too.
    let lookedUpCount = 0;
    for (let stretchStart = 0, stretchEnd; stretchStart < words.length; stretchStart = stretchEnd) {
      let stretchClosed = false;
      for (
        stretchEnd = stretchStart;
        stretchEnd < words.length && (stretchEnd === stretchStart || words[stretchEnd].blank);
        stretchEnd++
      ) {
        stretchClosed = stretchClosed || words[stretchEnd].closed;
      }
      if (!stretchClosed) continue;

      const stretch = words.slice(stretchStart, stretchEnd);
      const { starts: stepStarts, ends: stepEnds, owner: stepOwners } = stepsOf(view, stretch);
      // A step is kept by its code where it's one character long (markOf).
      const stepMarks = stepStarts.map((stepStart, stepIndex) => {
        if (!stretch[stepOwners[stepIndex]].closed) return 0;
        const stepEnd = stepEnds[stepIndex];
        const key = stepEnd - stepStart === 1 ? view.charCodeAt(stepStart) : view.slice(stepStart, stepEnd);
        return markOf(key, view, stepStart, stepEnd);
      });

      for (let stepIndex = 0; stepIndex + 1 < stepStarts.length; stepIndex++) {
        if (++lookedUpCount % 1024 === 0 && Date.now() > scanDeadline) return true;
        const counts = vault.heads.get(headOf(stepMarks[stepIndex], stepMarks[stepIndex + 1]));
        if (!counts) continue;
        if (!near && counts.length >= SEEN_COUNTS && seenAround(stepStarts, stepEnds, stepIndex, counts)) continue;

        for (const stepCount of counts) {
          if (stepIndex + stepCount > stepStarts.length) break;
          const runStart = stepStarts[stepIndex];
          const runEnd = stepEnds[stepIndex + stepCount - 1];
          const firstWord = stretch[stepOwners[stepIndex]];
          const lastWord = stretch[stepOwners[stepIndex + stepCount - 1]];
          // A whole word, looked up above.
          if (runStart === firstWord.start && runEnd === lastWord.end && firstWord === lastWord) continue;
          if (near && !near(firstWord.start, lastWord.end)) continue;
          const run = view.slice(runStart, runEnd);

          let isEverydayHangul = false;
          if (HANGUL.test(run)) {
            // Across a space, only from a word's start; and a run of nothing but Korean, or one across a space,
            // ends at a word's end or at the particles after it.
            const hasSpace = /\s/.test(run);
            if (hasSpace && runStart !== firstWord.start) continue;
            if (hasSpace || ONLY_HANGUL.test(run)) {
              // Only the Korean letters straight after it are the rest of its word ("김민수山田" ends at "수").
              let koreanWordEnd = runEnd;
              while (
                koreanWordEnd < lastWord.end &&
                koreanWordEnd - runEnd <= PARTICLES_MAX &&
                HANGUL.test(view[koreanWordEnd])
              ) {
                koreanWordEnd++;
              }
              const restOfWord = view.slice(runEnd, koreanWordEnd);
              if (koreanWordEnd > runEnd && (koreanWordEnd - runEnd > PARTICLES_MAX || !PARTICLES.test(restOfWord))) {
                continue;
              }
              // A word of two Korean letters is as often an everyday word ("박수를", applause; "지은이는", the
              // author), so a saved name that starts a written word with particles after it takes one said of people,
              // or opens its sentence with a subject, topic or object particle and goes on ("민수가 왔어요."), where
              // nothing before it says what it is ("이 책의 지은이는", "모두 박수를") and it isn't a word on its own.
              isEverydayHangul =
                stepCount === 2 &&
                !hasSpace &&
                koreanWordEnd > runEnd &&
                runStart === firstWord.start &&
                !FOR_PEOPLE.test(view.slice(runEnd, koreanWordEnd + 1)) &&
                !(
                  CASE_PARTICLE.test(restOfWord) &&
                  opensSentence(view, runStart) &&
                  SENTENCE_GOES_ON.test(view.slice(koreanWordEnd, koreanWordEnd + 8))
                );
            }
          }

          if (--lookups.left < 0) return false; // the scan is marked cut short (vaultMatches)
          // A run found counts where it starts and ends on the edges of the words around it (onWordEdges). No
          // function is made here: one that held `stepIndex` would give every step of a long paste a scope of its own.
          const firstStepEnd = stepEnds[stepIndex];
          const lastStepStart = stepStarts[stepIndex + stepCount - 1];
          const isTwoStepRun = stepCount === 2;
          let type = lookup("watch_list", run);
          if (isEverydayHangul && PERSON_KINDS.has(type)) type = undefined;
          let isPersonName = PERSON_KINDS.has(type);
          hit(
            type &&
              onWordEdges(view, runStart, runEnd, firstStepEnd, lastStepStart, isTwoStepRun, isPersonName) &&
              type,
            runStart,
            runEnd,
          );
          if (++lookedUpCount % 1024 === 0 && Date.now() > scanDeadline) return true;

          if (!/[\s\u30fb\uff65]/.test(run)) continue;
          type = lookup("watch_list_spaced", run);
          isPersonName = PERSON_KINDS.has(type);
          hit(
            type &&
              onWordEdges(view, runStart, runEnd, firstStepEnd, lastStepStart, isTwoStepRun, isPersonName) &&
              type,
            runStart,
            runEnd,
          );
          if (++lookedUpCount % 1024 === 0 && Date.now() > scanDeadline) return true;
        }
      }
    }
    return false;
  }

  // ---------- Every hit in a text ----------

  // ── Long repeats ──
  // A paste that repeats a few characters over and over ("3年B組3年B組…", "-=-=-=…") reads the same at every copy, so
  // the vault reads a long stretch of it only REPEAT_KEEP copies into each end, and the copies in between, cut out
  // whole, show it nothing the ends don't. The ends keep more than any lookup reaches across (a run of CLOSED_MAX
  // steps, the letters after it and the words around it), so a word is found there exactly as it would be in the
  // middle. Only a saved word as long as the whole stretch would read differently.
  const REPEAT_UNIT_MAX = 64;
  const REPEAT_KEEP = 160;
  const REPEAT_EVERY = 512;

  // The length of the shortest unit that repeats at `offset` for at least 2 * REPEAT_UNIT_MAX characters, or 0.
  function repeatingUnitLengthAt(text, offset) {
    const span = 2 * REPEAT_UNIT_MAX;
    for (let unitLength = 1; unitLength <= REPEAT_UNIT_MAX; unitLength++) {
      if (text.charCodeAt(offset) !== text.charCodeAt(offset + unitLength)) continue;
      let sameLength = 1;
      while (
        sameLength < span &&
        text.charCodeAt(offset + sameLength) === text.charCodeAt(offset + unitLength + sameLength)
      ) {
        sameLength++;
      }
      if (sameLength === span) return unitLength;
    }
    return 0;
  }

  // `text` with the middle of each long repeating stretch cut out, whole copies at a time.
  function textWithoutRepeatedMiddle(text) {
    let shortened = "";
    let keptFrom = 0;
    for (let offset = REPEAT_EVERY; offset + 3 * REPEAT_UNIT_MAX < text.length; offset += REPEAT_EVERY) {
      if (offset < keptFrom) continue;
      const unitLength = repeatingUnitLengthAt(text, offset);
      if (!unitLength) continue;

      let repeatStart = offset;
      while (
        repeatStart > keptFrom &&
        text.charCodeAt(repeatStart - 1) === text.charCodeAt(repeatStart - 1 + unitLength)
      ) {
        repeatStart--;
      }
      let repeatEnd = offset + unitLength;
      while (repeatEnd < text.length && text.charCodeAt(repeatEnd) === text.charCodeAt(repeatEnd - unitLength)) {
        repeatEnd++;
      }
      const keptLength = REPEAT_KEEP * unitLength;
      const cutLength = Math.floor((repeatEnd - repeatStart - 2 * keptLength) / unitLength) * unitLength;
      if (cutLength > 0) {
        shortened += text.slice(keptFrom, repeatStart + keptLength);
        keptFrom = repeatStart + keptLength + cutLength;
      }
      offset = Math.max(offset, repeatEnd - REPEAT_EVERY);
    }
    if (!keptFrom) return text;
    return shortened + text.slice(keptFrom);
  }

  // ── Every vault hit in a text ──
  // Computed once per text for all vault categories (once per scan when the scan's deadline cut it short).
  function vaultMatches(text) {
    if (
      vaultHits.text === text &&
      vaultHits.source === vaultSource &&
      (!vaultHits.cut || vaultHits.deadline === scanDeadline)
    ) {
      if (vaultHits.short) vaultShort = true;
      return vaultHits.hits;
    }
    const hits = [];
    let cut = false;
    let short = false;
    // The text as written that `text` was cleaned from, when detect() is reading that (setVaultSource).
    const source = vaultSource?.clean === text && vaultSource.start ? vaultSource : null;
    let decodedView = null;

    if (vault.words.size && vault.salt) {
      const lookups = lookupsFor(text.length);
      const shortened = textWithoutRepeatedMiddle(text);
      cut = vaultWordsIn(shortened, (start, end) => shortened.slice(start, end), hits, lookups);
      decodedView = !cut && unescapedView(text, source);
      // Only the phrases in or beside what an escape was read into: the rest read as they do in the text.
      if (decodedView) {
        const asWritten = (start, end) => text.slice(decodedView.from[start], decodedView.to[end - 1]);
        cut = vaultWordsIn(decodedView.text, asWritten, hits, lookups, (start, end) =>
          changedNear(decodedView, start, end),
        );
      }
      short = lookups.left < 0;
      if (short) vaultShort = true;
    }

    // A format is looked for in the text as written and, where it has escapes, as they read ("q=%22AB-1234%22",
    // "AB%201234"), each copy found there covered as written.
    if (vault.shapes.length && !decodedView) decodedView = unescapedView(text, source);
    for (const { type, re, near: nearWords } of vault.shapes) {
      const foundAt = new Set();
      for (const match of text.matchAll(re)) {
        if (nearWords && !nearBefore(text, match.index, nearWords)) continue;
        foundAt.add(match.index);
        hits.push({ type, span: match[0] });
      }
      if (!decodedView) continue;
      for (const match of decodedView.text.matchAll(re)) {
        const start = decodedView.from[match.index];
        if (foundAt.has(start) || (nearWords && !nearBefore(decodedView.text, match.index, nearWords))) continue;
        hits.push({ type, span: text.slice(start, decodedView.to[match.index + match[0].length - 1]) });
      }
    }
    vaultHits = { text, hits, cut, short, deadline: scanDeadline, source: vaultSource };
    return hits;
  }

  // Marked `fromVault` so detect() knows the vault's words and formats don't need their own label, and
  // doesn't read them again in its second reading, with a phone keyboard's dots taken out. The vault's
  // cached answer for this text is reused rather than recomputed.
  const findVault = (type) =>
    Object.assign(
      (text) => {
        if (!vault) return [];
        return vaultMatches(text)
          .filter((entry) => entry.type === type)
          .map((entry) => entry.span);
      },
      { fromVault: true },
    );

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    isVaultFormat,
    vaultKinds,
    setVault,
    setScanDeadline,
    setVaultSource,
    vaultCutShort,
    findVault,
  };
})();

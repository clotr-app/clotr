// A saved phrase's shape: the marks, cells and line breaks that may split it, the pieces of a joined word, and its
// count of letters in a script without spaces. saved-words.js and the respond files read these.
(() => {
  "use strict";

  const { BIP39 } = globalThis.ClotrInternal;

  // ---------- Where a saved phrase ends ----------

  // ── Phrases and punctuation ──
  // A saved phrase counts its words by spaces (vault.js), so "AT&T" is one word to it but two here: words glued by
  // other punctuation can add up to GLUE more to a phrase.
  const GLUE = 2;
  // But not across the end of a sentence or a clause in Chinese or Japanese (where no space follows one).
  const GLUE_STOP = /[、。！？；：]/;
  // A phrase saved with its closing punctuation ("Yahoo!", "C++") is also tried with the first one to three marks
  // that follow it in the text ("Yahoo!!", "C+++"). One ending in a company's or a name's abbreviation ("Acme Corp.",
  // "John Smith Jr.") is also tried whatever the text puts after it ("Acme Corp!", "Jr,").
  const TRAIL = /[.!?+]{1,3}/y;
  const ABBREVIATION = /(?<![\p{L}\p{N}\p{M}])(?:corp|inc|ltd|co|llc|plc|llp|jr|sr|bros|intl|mfg|pty|ltda|cia|univ)$/iu;

  // Only a phrase whose last letter is a Latin one (or "ſ" or the Kelvin sign, which fold to "s" and "k") can end in
  // one, so a long run of other letters skips the test.
  function mayAbbreviate(characterCode) {
    const lowercaseCode = characterCode | 32;
    if (lowercaseCode >= 97 && lowercaseCode <= 122) return true;
    return characterCode === 0x17f || characterCode === 0x212a;
  }

  // ── Latin words beside Chinese and Japanese ──
  // A word in capitals only ("MAX", "PDF") written straight up to a script without spaces is part of a compound
  // there ("MAX値", "PDF化", "USBメモリ"), not a word of its own, as a name written like one is ("社員Ann",
  // "Annさん", "Smith様").
  const CAPITALS = /^(?=(?:\P{L}*\p{Lu}){2})\P{Ll}*$/u;
  // Any other Latin word written straight up to Chinese characters is a compound too ("max値", "page数", "bill番号"),
  // unless a title or a word said only after a name follows ("Smith様", "Ann的", "Ann说").
  const HAN_AFTER = /^\p{Script=Han}/u;
  const TITLES = String.raw`[様殿氏君宛说說们們]|先生|先輩|社長|部長|課長|係長|店長|会長|教授|博士|選手|女士|小姐|老师|老師|经理|經理|总|總|同学|同學|医生|醫生|主任|老板|老闆`;
  const TITLE_AFTER = new RegExp("^(?:" + TITLES + ")", "u");
  const NAME_AFTER = new RegExp("^(?:[的是和跟与與给給也都在吗嗎呢吧]|" + TITLES + ")", "u");
  // A word joined from parts by one of these (VAULT_WORD) isn't letters, digits and marks alone.
  const JOINED_PART = /['’._-]/;

  // ---------- Phrases split by marks and cells ----------

  // ── Phrases split by marks, cells and line breaks ──
  // A saved phrase written with other marks between its words, as Markdown, a CSV row or a path sets them apart
  // ("**Ann** Smith", "Ann,Smith", "Ann/Smith", "Ann | Smith"), is also tried with a space for each.
  const SEPARATED = /(?<=[\p{L}\p{N}\p{M}])[^\p{L}\p{N}\p{M}]{1,5}(?=[\p{L}\p{N}])/gu;
  // But not across a break in prose: a sentence or clause end with its space ("Ann. Smith", "In June, Carter said"),
  // a spaced dash or slash ("It will - Smith says", "May / Lee"), or a new line with list or table marks ("- Ann\n-
  // Lee").
  const PROSE_BREAK = /^\s+$|[.!?,;:]\s|\s[-\u2010-\u2015/]+\s|[\n\r][^]*\S|\S[^]*[\n\r]/;
  // Words in cells side by side ("| Ann | Smith |", "7,Lena,Ortiz", "<td>Ann</td><td>Smith</td>"), but not split by
  // an entity's ";" ("Ann&nbsp;Smith").
  const CELL_SPLIT = /\||,(?!\s)|(?<!&#?\w{1,8});(?!\s)|<\/?t[dh]\b/i;
  // A header cell that names a part of a name ("First", "Last name", "first_name", "Surname").
  const NAME_KINDS = "first|last|given|family|middle";
  const NAME_PART = new RegExp(
    `^(?:(?:${NAME_KINDS}|full|sur|fore)[ _.-]?names?|[fl]names?|names?|${NAME_KINDS})$`,
    "i",
  );
  // A CSV header written as one: labels in small letters ("month,owner"), which a row of names never is.
  const HEADER_LABEL = /^[\p{Ll}\d_ ]*\p{Ll}[\p{Ll}\d_ ]*$/u;
  const SEPARATOR_ROW = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/;
  // An HTML table's cells, and how far above a cell its header row is looked for.
  const HTML_CELL = /<t[dh](?=[\s>])[^>]*>/gi;
  const HTML_BACK = 16384;
  const HTML_TABLE_EDGE = /<\/?table(?=[\s>])/i;

  // ── HTML table headers ──
  // Where the last tag `tagName` (in small letters or capitals) starts in `source` before `end`, or -1. Capitals are
  // looked for only after the last one in small letters, so a page written in one case is read once.
  function lastHtmlTagAt(source, tagName, end) {
    let best = -1;
    const tagNames = [tagName, tagName.toUpperCase()];

    for (const writtenName of tagNames) {
      const part = source.slice(best + 1, end);
      for (
        let at = part.lastIndexOf("<" + writtenName);
        at >= 0;
        at = at ? part.lastIndexOf("<" + writtenName, at - 1) : -1
      ) {
        const afterTag = part[at + writtenName.length + 1];
        if (afterTag !== ">" && afterTag !== " " && afterTag !== "\t" && afterTag !== "\n" && afterTag !== "\r") {
          continue;
        }
        best += at + 1;
        break;
      }
    }
    return best;
  }

  // The header cells, as text, of the row above the end of `before` that holds <th> cells, and the column that end
  // is in, or null with no such row in its table.
  function readHtmlHeader(before) {
    const rowStart = lastHtmlTagAt(before, "tr", before.length);
    if (rowStart < 0) return null;

    const column = (before.slice(rowStart).match(HTML_CELL) || []).length - 1;
    if (column < 0) return null;

    const headStart = lastHtmlTagAt(before, "th", rowStart);
    if (headStart < 0 || HTML_TABLE_EDGE.test(before.slice(headStart, rowStart))) return null;

    const headRowStart = Math.max(0, lastHtmlTagAt(before, "tr", headStart));
    const rowEnds = [before.indexOf("</tr", headStart), before.indexOf("</TR", headStart)].filter(
      (at) => at > headStart && at < rowStart,
    );
    const rowEnd = Math.min(rowStart, ...rowEnds);
    const cells = before
      .slice(headRowStart, rowEnd)
      .split(HTML_CELL)
      .slice(1)
      .map((cell) => cell.replace(/<[^>]*>/g, "").trim());

    return { cells, column };
  }

  // ── Does a split phrase hold a name? ──
  // Everyday words that are also first names, beside the BIP-39 list's ("grace", "hope", "page", "rose").
  const EVERYDAY_FIRST = new Set(
    `january february march april may june july august september october november december monday tuesday wednesday
    thursday friday saturday sunday mark bill will frank ray max jack bob pat sue rob rod guy dean drew gene wade ward
    earl duke king glen dale lane brook penny sandy holly ivy iris lily daisy violet heather hazel pearl ruby amber
    carol star sky angel rocky chip bud buck lance miles rain storm candy honey rusty chance hunter`.split(/\s+/),
  );

  // Whether a phrase found split across cells, from `start` in `text` (`written`: as written), holds a name there.
  // Under a header naming the parts of a name ("First | Last", "first_name,last_name") it does; under one naming
  // other things ("Month | Owner") its words are what those columns hold. With no header, a first word that's also
  // an everyday word ("June", "Page", "Mark") is more likely a column value than a name. An HTML header is read in
  // `writtenBefore`, the text as written before `start`, since the vault reads text without its tags.
  function cellsHoldName(text, start, written, writtenBefore) {
    let separator;
    if (written.includes("|")) {
      separator = "|";
    } else {
      const withoutEntities = written.replace(/&#?\w{1,8};/g, "");
      separator = /,(?!\s)|;(?!\s)/.exec(withoutEntities)?.[0] || null;
    }

    let header = null;
    let decisive = false;
    if (separator) {
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;

      // The rows above in the same table or CSV: a Markdown header is the row above its |---| row, a CSV's is its
      // first row.
      for (let at = lineStart; at > 0;) {
        const from = text.lastIndexOf("\n", at - 2) + 1;
        const line = text.slice(from, at - 1);
        if (!line.includes(separator)) break;

        if (separator === "|" && SEPARATOR_ROW.test(line)) {
          const above = text.lastIndexOf("\n", from - 2) + 1;
          header = from > 0 ? text.slice(above, from - 1) : null;
          decisive = header !== null;
          break;
        }

        if (separator !== "|") header = line;
        at = from;
      }

      if (header !== null) {
        const unquote = (cell) => cell.trim().replace(/^"(.*)"$/, "$1");
        const headerCells = header.split(separator).map(unquote);
        const column = text.slice(lineStart, start).split(separator).length - 1;
        const writtenCellCount = written.split(separator).length;
        const cellsAbove = headerCells.slice(column, column + writtenCellCount);

        if (cellsAbove.length === writtenCellCount && cellsAbove.every((cell) => NAME_PART.test(cell))) return true;
        decisive = decisive || (separator !== "|" && headerCells.every((cell) => HEADER_LABEL.test(cell)));
        if (decisive) return false;
      }
    }

    const first = /^\p{L}+/u.exec(text.slice(start))?.[0].toLowerCase() || "";
    if (!EVERYDAY_FIRST.has(first) && !BIP39.has(first)) return true;
    // An HTML header names a name the same way ("<th>First</th><th>Last</th>"). Only an everyday first word needs
    // it, so it's read only then.
    if (separator) return false;
    if (!/<\/?t[dh]\b/i.test(written)) return false;
    if (start === 0) return false;

    const headerRow = readHtmlHeader(writtenBefore(start));
    const cellCount = (written.match(/<t[dh]\b/gi) || []).length + 1;
    const cellsAbove = headerRow ? headerRow.cells.slice(headerRow.column, headerRow.column + cellCount) : [];
    return cellsAbove.length === cellCount && cellsAbove.every((cell) => NAME_PART.test(cell));
  }

  // ---------- Handles, other scripts and joined words ----------

  // ── Handles, links and old folds ──
  // A handle saved with its @ ("@ann_w") or a tag with its # is also tried with the one written before it.
  const LEADS = "@#";
  // A phrase written with its words joined by hyphens, underscores, dots or plus signs, as in a username, a link or a
  // search ("ann_smith", "in/ann-smith-4b2a", "q=Ann+Smith"), is also tried with spaces between them.
  const JOINER = /(?<=[\p{L}\p{N}\p{M}])[-_.+](?=[\p{L}\p{N}])/gu;
  // Letters that keep their mark inside them (plainLetters in respond/fingerprints.js): a word saved before they were
  // folded is also tried in its old form.
  const MARKED_LETTER = /[ŁłĐđÐðØøßẞÆæŒœıĦħÞþŦŧ\u06cc\u06a9\u0629\u0640\uff61-\uff9f]/;

  // ── Scripts written without spaces ──
  // Chinese, Japanese, Thai and the like have no spaces between words, and Korean puts its particles right after a
  // name, so a saved word in those scripts is looked for anywhere in a run of their letters. A word in any other
  // script ends where one of their letters starts, so a name written into such text ("我叫Ann。") is a word of its
  // own. In a stretch with no space or punctuation ("私は3年B組です"), each of their letters and each other word is a
  // step. A saved word in such a script, or mixing one with others ("3年B組", "三菱UFJ銀行"), keeps its count of steps
  // (`closed`, 2 to CLOSED_MAX) and a head (closedHead), and every run of that many steps with that head is looked
  // up. A word saved before that count was kept is found only as a whole word, and a vault with none looks up no runs.
  const CLOSED_MAX = 64;
  const EAST_ASIAN_SCRIPTS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
  const SOUTHEAST_ASIAN_SCRIPTS = String.raw`\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}`;
  // The kana long-vowel mark and half-width kana's own marks.
  const KANA_MARKS = String.raw`ー\uff70\uff9e\uff9f`;
  const CLOSED_LETTER = String.raw`(?=[\p{L}\p{N}])[${EAST_ASIAN_SCRIPTS}${SOUTHEAST_ASIAN_SCRIPTS}${KANA_MARKS}]`;
  // A step is a letter with its marks, a half-width kana's voicing marks (ﾞ, ﾟ) included.
  const CLOSED_EACH = /[^\p{M}\uff9e\uff9f][\p{M}\uff9e\uff9f]*/gu;
  // A space or a katakana middle dot between two of their letters is no break in a saved word (closedJoin in
  // respond/fingerprints.js): "ジョン・スミス" is one name, as "山田 太郎" is.
  const CLOSED_GAP = /^[\s\u30fb\uff65]*$/;
  const closedLetter = new RegExp("^" + CLOSED_LETTER, "u");
  const closedAnywhere = new RegExp(CLOSED_LETTER, "u");
  // A word in the text is a run of those letters, or else letters and digits of any other script with the marks
  // written on them (an accent typed as its own character, as macOS pastes it, or a Devanagari or Tamil vowel sign),
  // joined by an apostrophe, dot, underscore or hyphen ("O'Brien", "Jean-Luc"), but not a possessive "'s".
  const OPEN_LETTER = "(?!" + CLOSED_LETTER + ")[\\p{L}\\p{N}]";
  const OPEN_PART = OPEN_LETTER + "(?:" + OPEN_LETTER + "|\\p{M})*";
  const VAULT_WORD = new RegExp(
    "(?:" + CLOSED_LETTER + "\\p{M}*)+|" + OPEN_PART + "(?:['’._-](?!s\\b)" + OPEN_PART + ")*",
    "gu",
  );
  const PART = new RegExp(OPEN_PART, "gu");

  // Whether `character`, a letter at a saved word's edge, belongs to a script without spaces, where a word stands as
  // one beside any other letter (standsAsWord in respond/cover-values.js).
  const isClosedLetter = (character) => closedLetter.test(character || "");
  // Whether the letter at `index` is one, read whole where it takes two UTF-16 units ("𠮷").
  const closedAt = (text, index) => isClosedLetter(text.slice(index, index + 2));

  // Where each step of `words` (in `text`, with nothing or only spaces between them) starts and ends, and which word
  // it's in. Each word says whether it's one of those letters (`closed`).
  function stepsOf(text, words) {
    const starts = [];
    const ends = [];
    const owner = [];

    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
      const word = words[wordIndex];
      if (!word.closed || word.end - word.start === 1) {
        starts.push(word.start);
        ends.push(word.end);
        owner.push(wordIndex);
        continue;
      }

      const wordText = text.slice(word.start, word.end);
      for (const step of wordText.matchAll(CLOSED_EACH)) {
        starts.push(word.start + step.index);
        ends.push(word.start + step.index + step[0].length);
        owner.push(wordIndex);
      }
    }
    return { starts, ends, owner };
  }

  // ── Pieces of joined words ──
  // Where a joined word splits: at a joiner, where a digit meets a letter, or at a capital after a small letter
  // ("in/ann-smith", "INITECH_API", "smith1990", "AnnSmith").
  const SPLITS = /[-_.'’]|[\p{L}\p{M}]\p{N}|\p{N}\p{L}|\p{Ll}\p{M}*\p{Lu}/u;
  const PIECE_EDGE = /[\p{L}\p{M}](?=\p{N})|\p{N}(?=\p{L})|\p{Ll}\p{M}*(?=\p{Lu})/gu;
  // A piece found on its own is a saved word only when it's longer than an everyday word in code: one set off by an
  // underscore or a dot ("max_tokens", "grant_type") needs PIECE_MIN letters and digits ("INITECH_API"), and one set
  // off only by a digit ("ed25519", "win32api") needs DIGIT_PIECE_MIN ("smith1990"). A phrase of two or more pieces
  // ("ann_smith") needs neither. Where pieces are tried (vaultWordsIn), a person's name (PERSON_KINDS) needs more.
  const PIECE_MIN = 6;
  const DIGIT_PIECE_MIN = 4;
  const PERSON_KINDS = new Set(["my_name", "family_name"]);
  const pieceLength = (piece) => [...piece.replace(/\p{M}/gu, "")].length;

  // The pieces of `token` (starting at `start` in the text), each with what sets it off from the one before: "free"
  // for an underscore or a dot, "digit" for a digit's edge, "name" for a hyphen, "quote" for an apostrophe and "case"
  // for a capital. The hex digits of an escape the word starts with ("%C3%A9Ann", read as "éAnn") stand for a letter,
  // so they're no digit's edge (`escaped`: how many there are).
  function piecesOf(token, start, escaped) {
    const pieces = [];

    for (const part of token.matchAll(PART)) {
      const joiner = token[part.index - 1];
      let joint = joiner === "-" ? "name" : joiner === "'" || joiner === "’" ? "quote" : "free";
      let from = 0;

      for (const edge of part[0].matchAll(PIECE_EDGE)) {
        const cut = edge.index + edge[0].length;
        if (cut >= part[0].length) continue;

        pieces.push({
          start: start + part.index + from,
          end: start + part.index + cut,
          joint,
        });
        const touchesDigit = /\p{N}/u.test(part[0][cut]) || /\p{N}/u.test(part[0][cut - 1]);
        joint = touchesDigit && part.index + cut !== escaped ? "digit" : "case";
        from = cut;
      }

      pieces.push({
        start: start + part.index + from,
        end: start + part.index + part[0].length,
        joint,
      });
    }
    return pieces;
  }

  // ---------- Counting a phrase before it's saved ----------

  // ── Counting a phrase's steps before it's saved ──
  // Its count of steps when it has a letter of those scripts and nothing but spaces or middle dots between its words
  // ("山田太郎", "山田 太郎", "ジョン・スミス", "3年B組"), 2 to CLOSED_MAX of them; otherwise 0. Kept with the saved word
  // (wordEntry in respond/fingerprints.js) so only runs that long are looked up: a count, never the word.
  function closedLength(phrase) {
    const steps = readClosedSteps(phrase);
    if (!steps) return 0;
    return steps.length;
  }

  // The steps of such a phrase, each as written, or null.
  function readClosedSteps(phrase) {
    const normalizedPhrase = String(phrase).trim().normalize("NFC");
    const words = [];

    for (const match of normalizedPhrase.matchAll(VAULT_WORD)) {
      const previousEnd = words.length ? words[words.length - 1].end : 0;
      if (!CLOSED_GAP.test(normalizedPhrase.slice(previousEnd, match.index))) return null;

      words.push({
        start: match.index,
        end: match.index + match[0].length,
        closed: closedAt(normalizedPhrase, match.index),
      });
    }

    if (!words.length) return null;
    if (words[words.length - 1].end !== normalizedPhrase.length) return null;
    if (!words.some((word) => word.closed)) return null;

    const { starts, ends } = stepsOf(normalizedPhrase, words);
    if (starts.length < 2 || starts.length > CLOSED_MAX) return null;
    return starts.map((stepStart, stepIndex) => normalizedPhrase.slice(stepStart, ends[stepIndex]));
  }

  // ── Heads ──
  // Looking up every run of every saved count would cost a fingerprint for each count at every step, so such a word
  // also keeps HEAD_BITS bits from its first two steps (`head`, 0 to 4095), and only the counts saved with the head a
  // run starts with are looked up there. A step's part is 32 bits of its own fingerprint when it's a letter of those
  // scripts; any other word or digit counts as 0, so a run read in another case or width has the same head. A few
  // bits from the salt and two letters: never the phrase.
  const HEAD_BITS = 12;
  // Read once: Guard and the VS Code plugin run this in a vm context, where each global lookup is slow, and a head
  // is worked out at every step of a long paste.
  const imul = Math.imul;

  function stepMark(salt, step) {
    if (!closedAt(step, 0)) return 0;
    if (/^\p{N}/u.test(step)) return 0;

    const fingerprint = globalThis.Clotr.fingerprint(salt, "watch_list", step);
    return Number.parseInt(fingerprint.slice(0, 8), 16);
  }

  function headOf(firstMark, secondMark) {
    return imul(firstMark ^ imul(secondMark, 0x9e3779b1), 0x85ebca6b) >>> (32 - HEAD_BITS);
  }

  // A phrase about to be saved: its head, or -1 when it has no count of steps (closedLength).
  function closedHead(salt, phrase) {
    const steps = readClosedSteps(phrase);
    if (!steps) return -1;
    return headOf(stepMark(salt, steps[0]), stepMark(salt, steps[1]));
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    GLUE,
    GLUE_STOP,
    TRAIL,
    ABBREVIATION,
    mayAbbreviate,
    CAPITALS,
    HAN_AFTER,
    TITLE_AFTER,
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
    closedLength,
    HEAD_BITS,
    stepMark,
    headOf,
    closedHead,
  };
})();

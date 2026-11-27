// Second readings of a cleaned text: phone-keyboard dots and JSON or log escapes as spaces, and a key wrapped
// over lines joined back up. detect.js runs the rules over these too.
(() => {
  "use strict";

  // ---------- A phone keyboard's dot ----------
  // On a phone, two spaces turn into ". ", so "driver’s. license L8426037" gets a dot it never had. The text is read
  // again with those dots as spaces (same length). A find may not span a dot or start with the next sentence's first
  // word, so "I changed my password. Thanks!" doesn't catch "Thanks".
  const PHONE_DOT = /(?<=\p{L})\. (?=\S)(\p{Lu}\p{Ll}*(?![\p{L}\p{N}]))?/gu;
  // After "is", "was", "es" or "era" the next word reads lowercase ("my password is. Sunshine" → "is  sunshine") and
  // gets its capital back in the find. In a question ("I forgot what my password is. Thanks!") the dot stays.
  const AFTER_IS = /(?<![\p{L}])(?:is|was|es|era)$/iu;
  const ASKS = /(?<![\p{L}])(?:what|whatever|where|who|whose|which|how|why|when)(?![\p{L}])[^.!?\n]*$/iu;
  function withoutPhoneDots(clean) {
    if (!clean.includes(". ")) return null;
    const firstWords = new Set();
    const lowered = new Set();
    const text = clean.replace(PHONE_DOT, (dot, word, at) => {
      const before = clean.slice(Math.max(0, at - 60), at);
      const afterIs = AFTER_IS.test(before);
      if (afterIs && ASKS.test(before)) return dot;
      if (!word) return "  ";
      const lower = word.toLowerCase();
      if (afterIs && lower.length === word.length) {
        lowered.add(lower);
        return `  ${lower}`;
      }
      firstWords.add(word);
      return `  ${word}`;
    });
    return text === clean ? null : { text, firstWords, lowered };
  }

  // ---------- A JSON or log escape ----------
  // JSON and logs write a line break or tab as \n, \r or \t, so "\nAKIA…" reads as "nAKIA…". The second reading turns
  // each escape into spaces (a JSON string's \n is already a real break, from cleanText).
  // A log holding JSON escapes the backslash again ("\\nAKIA…"). Matching from a run's first backslash keeps it linear.
  const ESCAPED_BREAK = /(?<!\\)\\+[nrt]/g;
  function secondReading(clean) {
    const dots = withoutPhoneDots(clean);
    const base = dots ? dots.text : clean;
    const text = base.includes("\\") ? base.replace(ESCAPED_BREAK, (escape) => " ".repeat(escape.length)) : base;
    if (text === base) return dots;
    return { firstWords: new Set(), lowered: new Set(), ...dots, text };
  }

  // ---------- A key wrapped across lines ----------
  // Wrapped values are short, so skip huge runs and cap how many get a second scan.
  const MAX_JOINED_TOKEN = 4096;
  const MAX_JOINED_RUNS = 300;
  const MAX_WORD_TAIL_READS = 32;
  // A letter, a digit, or one of _ . / + = -, the characters a key is made of.
  const isTokenCode = (code) =>
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 46 ||
    code === 47 ||
    code === 43 ||
    code === 61 ||
    code === 45;

  // A chat box that keeps each line as its own paragraph (ProseMirror, Lexical) reads back a blank line between
  // the lines of a pasted key, so one blank line counts as the same break. Returns where the next line starts.
  function afterBreak(clean, newline) {
    let next = newline + 1;
    if (clean.charCodeAt(next) === 13 && clean.charCodeAt(next + 1) === 10) next++;
    return clean.charCodeAt(next) === 10 ? next + 1 : newline + 1;
  }

  // A wrapped key's next line can start with an indent, a tab or an email's "> " (or "> > " in a reply to a
  // reply). Returns where that line's own text starts, or `lineStart` when it has none.
  const MAX_LINE_PREFIX = 64;
  function linePrefixEnd(clean, lineStart) {
    let at = lineStart;
    while (at - lineStart < MAX_LINE_PREFIX) {
      const code = clean.charCodeAt(at);
      if (code !== 32 && code !== 9 && code !== 62) break;
      at++;
    }
    return at;
  }
  // What may follow the last part of a wrapped key on its line: a closing quote, bracket or comma, or nothing.
  // A part followed by "(", ":", "[" or "{" is code or a label, like "console.log(x)" or "region: eu".
  const CODE_AFTER = /[([{:]/;
  // A line that starts with a UUID, a date or a "name=value" is the person's own, not the rest of a key above it.
  const NOT_KEY_REST = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d\d-\d\d|[^=]+=[^=])/i;
  const LINE_REST = /["'`]?[,;)\]}]*\.?[ \t]*(?:\r?\n|$)/y;
  function restOfLineIsClosing(clean, at) {
    LINE_REST.lastIndex = at;
    return LINE_REST.test(clean);
  }

  // ---------- YAML blocks ----------
  // YAML literal and folded scalars indent every content line. Keep that indentation in the source map, but omit
  // it from the joined reading so a wrapped value can still match its provider rule.
  function yamlLiteralBlockLines(clean) {
    if (!clean.includes("\n") || !clean.includes(":") || !/[|>]/.test(clean)) return null;
    const headerPattern = /:[ \t]*[|>][+-]?[1-9]?[+-]?[ \t]*(?:#[^\r\n]*)?\r?$/m;
    if (!headerPattern.test(clean)) return null;

    const lines = new Map();
    let block = null;
    for (let lineStart = 0; lineStart < clean.length;) {
      let lineEnd = clean.indexOf("\n", lineStart);
      if (lineEnd < 0) lineEnd = clean.length;
      let contentEnd = lineEnd;
      if (contentEnd > lineStart && clean.charCodeAt(contentEnd - 1) === 13) contentEnd--;
      let firstText = lineStart;
      while (firstText < contentEnd && clean.charCodeAt(firstText) === 32) firstText++;
      const indent = firstText - lineStart;
      const blank = firstText === contentEnd;

      if (block && !blank) {
        // The block's first line of text sets its indent: the header's own number, or that line's indent.
        if (block.contentIndent === null && indent > block.parentIndent) {
          const contentIndent = block.explicitIndent === null ? indent : block.parentIndent + block.explicitIndent;
          if (indent >= contentIndent) block.contentIndent = contentIndent;
        }
        // A line indented less than the block's text ends the block.
        if (block.contentIndent === null || indent < block.contentIndent) {
          block = null;
        } else {
          const line = { contentStart: lineStart + block.contentIndent, block };
          lines.set(lineStart, line);
          lines.set(line.contentStart, line);
        }
      }

      if (!block && !blank) {
        const header = /^([^:]+):[ \t]*[|>]([+-]?[1-9]?[+-]?)[ \t]*(?:#[^\r\n]*)?$/.exec(
          clean.slice(firstText, contentEnd),
        );
        if (header) {
          const explicitIndent = /[1-9]/.exec(header[2])?.[0];
          const label = header[1].replace(/^['"]|['"]$/g, "");
          block = {
            parentIndent: indent,
            explicitIndent: explicitIndent === undefined ? null : Number(explicitIndent),
            contentIndent: null,
            sensitive: /(?:credential|secret|token|api[_. -]?key|password|private[_. -]?key)/i.test(label),
          };
        }
      }

      if (lineEnd === clean.length) break;
      lineStart = lineEnd + 1;
    }
    return lines.size ? lines : null;
  }

  function yamlContentLine(yamlLines, lineStart) {
    return yamlLines?.get(lineStart) || null;
  }

  // The start of a key whose own shape says what it is, so even a short first line of it is worth joining. An
  // email's quoted-printable "=" ending one of those lines is its soft break, not base64 padding.
  // pieced-keys.js reads this pattern's source as its list of prefixes, so the list stays in one group.
  const KEY_START = new RegExp(
    String.raw`^(?:AKIA|ASIA|gh[pousr]_|github_pat_|glpat-|sk-|[sr]k_(?:live|test)_|xox[abpors]-|AIza|hf_|npm_|` +
      String.raw`GOCSPX-|ya29\.|dckr_(?:pat|oat)_|sbp_|lsv2_|pcsk_|ntn_|gsk_|CFPAT-|pscale_|nvapi-|figd_|bkua_|` +
      String.raw`napi_|xkeysib-|sq0c[a-z]{2}-|dp\.(?:ct|pt|st|sa)\.)`,
  );
  // Where the word before a line break ends: a shell's "\" carrying a line on, or a soft "=" after a key's start,
  // belongs to the break.
  function wordEnd(clean, lineStart, lineEnd) {
    const BACKSLASH = 92;
    const EQUALS = 61;
    const mark = clean.charCodeAt(lineEnd - 1);
    if (mark !== BACKSLASH && mark !== EQUALS) return lineEnd;
    let start = lineEnd - 1;
    while (start > lineStart && isTokenCode(clean.charCodeAt(start - 1))) start--;
    if (mark === EQUALS) return KEY_START.test(clean.slice(start, lineEnd - 1)) ? lineEnd - 1 : lineEnd;
    return start < lineEnd - 1 ? lineEnd - 1 : lineEnd;
  }

  // Whether any line break sits between two key characters, the way a wrapped key's would.
  function hasTokenLineBreak(clean, yamlLines) {
    for (let newline = clean.indexOf("\n"); newline >= 0; newline = clean.indexOf("\n", newline + 1)) {
      let before = newline - 1;
      if (before >= 0 && clean.charCodeAt(before) === 13) before--;
      if (before > 0 && clean.charCodeAt(before) === 92) before--;
      const afterBreakStart = afterBreak(clean, newline);
      const after = yamlContentLine(yamlLines, afterBreakStart)?.contentStart ?? linePrefixEnd(clean, afterBreakStart);
      if (
        before >= 0 &&
        after < clean.length &&
        isTokenCode(clean.charCodeAt(before)) &&
        isTokenCode(clean.charCodeAt(after))
      ) {
        return true;
      }
    }
    return false;
  }

  // A short line under a wrapped value that reads as a word, like "Thanks" or "done.".
  const TAIL_WORD = /^[A-Z]?[a-z]+\.*$/;
  // Kinds read from a label or a value's general shape rather than a provider's own prefix.
  const LABEL_KINDS = new Set(["password", "service_token"]);

  // ---------- The joined reading ----------
  // Keep the removed line breaks in the source positions so Cover it can replace the exact pasted span.
  function withoutTokenLineBreaks(clean, jsonBreaks, yamlLines) {
    const joined = [];
    let current = null;
    let joinedRuns = 0;
    const keepCurrent = () => {
      if (current?.breaks) {
        for (const at of current.breaks) joined.push(at);
        joinedRuns++;
      }
      current = null;
    };
    let lineStart = 0;
    for (let newline = clean.indexOf("\n"); newline >= 0; newline = clean.indexOf("\n", newline + 1)) {
      const fromJson = Boolean(jsonBreaks?.has(newline));
      const currentYamlLine = yamlContentLine(yamlLines, lineStart);
      const currentStart = currentYamlLine?.contentStart ?? lineStart;
      let lineEnd = newline;
      if (lineEnd > lineStart && clean.charCodeAt(lineEnd - 1) === 13) lineEnd--;
      lineEnd = wordEnd(clean, currentStart, lineEnd);
      let leftStart = lineEnd;
      while (leftStart > currentStart && isTokenCode(clean.charCodeAt(leftStart - 1))) leftStart--;
      const afterBreakStart = afterBreak(clean, newline);
      const nextYamlLine = yamlContentLine(yamlLines, afterBreakStart);
      const sameYamlBlock = currentYamlLine && nextYamlLine && currentYamlLine.block === nextYamlLine.block;
      // An indented or "> "-quoted next line: its prefix stays out of the joined reading.
      const prefixEnd = sameYamlBlock ? afterBreakStart : linePrefixEnd(clean, afterBreakStart);
      const prefix = clean.slice(afterBreakStart, prefixEnd);
      const rightStart = sameYamlBlock ? nextYamlLine.contentStart : prefixEnd;
      let rightEnd = rightStart;
      while (rightEnd < clean.length && isTokenCode(clean.charCodeAt(rightEnd))) rightEnd++;
      const leftLength = lineEnd - leftStart;
      const rightLength = rightEnd - rightStart;
      // A key's next part under the same indent or quote is that whole line, and every later part sits under the
      // same prefix too, so indented code like "foo\n    bar()" or a quoted "region: eu" never joins.
      // A part of 8 or more followed by a space can be a key's rest too, like a split ID before its pair's next name.
      const rightWhole =
        rightLength > 0 &&
        (restOfLineIsClosing(clean, rightEnd) || (rightLength >= 8 && /[ \t]/.test(clean[rightEnd] || "")));
      const sensitiveYamlWrap =
        sameYamlBlock && currentYamlLine.block.sensitive && lineEnd - currentStart >= 16 && leftLength >= 8;
      // "B=2" or "X=1" on the next line is an assignment too, while a base64 value's last line can be just "Q==".
      const continuationAssignment = /^[A-Z](?:[A-Z0-9_]{1,39}=|=[^=\s])/.test(
        clean.slice(rightStart, rightStart + 42),
      );
      const splitAssignmentLabel =
        sensitiveYamlWrap &&
        continuationAssignment &&
        (clean.charCodeAt(lineEnd - 1) === 95 || /^TWILIO_[A-Z0-9_]+$/.test(clean.slice(leftStart, lineEnd)));
      const assignment = continuationAssignment && !splitAssignmentLabel;
      // A wrap goes on from a whole line, but a short line ends it.
      const runGoesOn = current && !current.tail && current.rightStart === leftStart && current.rightEnd === lineEnd;
      const continues = runGoesOn && current.prefix === prefix;
      const prefixFits = (!prefix || rightWhole) && (!runGoesOn || continues);
      // A JSON string's \n right after its value's first few characters, like {"secret":"AK\nIA…"} or a connection
      // string's "postgres\n://…", splits that one value, since no space sits between the opening quote and the
      // break, nor right after it. Each line is walked back only as far as its own start.
      let firstLine = leftStart;
      while (firstLine > lineStart && !/[\s"]/.test(clean[firstLine - 1])) firstLine--;
      const valueStart =
        fromJson && lineEnd > firstLine && clean.charCodeAt(firstLine - 1) === 34 && /[^\s"]/.test(clean[rightStart]);
      // A line can end on a key's own start alone, like "ghp_" or "AKIA", with the rest of the key under it.
      const leftLong =
        leftLength >= 16 ||
        (leftLength >= 8 && sensitiveYamlWrap) ||
        (leftLength >= 3 && KEY_START.test(clean.slice(leftStart, lineEnd)));
      const eligible =
        (leftLong || continues || valueStart) && (rightLength > 0 || valueStart) && !assignment && prefixFits;
      const nextLineStart = eligible && (sameYamlBlock || prefix) ? rightStart : afterBreakStart;
      newline = nextLineStart - 1;
      // A next line under 8 characters is either a wrapped value's last bit or the next word, like the "Thanks"
      // under a key, so it joins only as a tail, which detect() keeps when the value needs it.
      const tail = rightLength < 8;
      const boundary = {
        newline,
        separatorStart: lineEnd,
        leftStart,
        leftEnd: lineEnd,
        rightStart,
        rightEnd,
        rightLength,
        tail,
        // Whether the next line's part could be the rest of a key: long enough, the whole of its line or closed by
        // a quote or bracket, and not shaped like a UUID, a date or an assignment. A JSON value split near its
        // start is one value, whatever its second line holds.
        keyRest:
          valueStart ||
          (rightLength >= 8 &&
            !CODE_AFTER.test(clean[rightEnd] || "") &&
            !NOT_KEY_REST.test(clean.slice(rightStart, rightEnd))),
      };

      if (eligible) {
        if (!continues) {
          keepCurrent();
          const size = Math.min(MAX_JOINED_TOKEN + 1, leftLength + rightLength);
          current = {
            rightStart,
            rightEnd,
            size,
            tail,
            prefix,
            breaks: joinedRuns < MAX_JOINED_RUNS && size <= MAX_JOINED_TOKEN ? [boundary] : null,
          };
        } else {
          current.tail = tail;
          current.rightStart = rightStart;
          current.rightEnd = rightEnd;
          current.size = Math.min(MAX_JOINED_TOKEN + 1, current.size + rightLength);
          if (current.breaks && current.size <= MAX_JOINED_TOKEN) current.breaks.push(boundary);
          else current.breaks = null;
        }
      } else {
        keepCurrent();
      }
      lineStart = nextLineStart;
    }
    keepCurrent();
    if (!joined.length) return null;

    const sourceStart = [];
    const sourceEnd = [];
    const breaks = [];
    const tails = new Map(); // where a tail break is → where its short line ends, both in the joined text
    const notKeyRest = new Set(); // breaks whose next line's part can't be the rest of a key
    const parts = [];
    let copiedThrough = 0;
    const copy = (from, to) => {
      parts.push(clean.slice(from, to));
      for (let i = from; i < to; i++) {
        sourceStart.push(i);
        sourceEnd.push(i + 1);
      }
    };
    for (const boundary of joined) {
      copy(copiedThrough, boundary.separatorStart);
      breaks.push(sourceStart.length);
      if (boundary.tail) tails.set(sourceStart.length, sourceStart.length + boundary.rightLength);
      if (!boundary.keyRest) notKeyRest.add(sourceStart.length);
      copiedThrough = boundary.newline + 1;
    }
    copy(copiedThrough, clean.length);
    return { text: parts.join(""), sourceStart, sourceEnd, breaks, tails, notKeyRest };
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    PHONE_DOT,
    AFTER_IS,
    ASKS,
    secondReading,
    MAX_JOINED_TOKEN,
    MAX_WORD_TAIL_READS,
    isTokenCode,
    yamlLiteralBlockLines,
    KEY_START,
    hasTokenLineBreak,
    TAIL_WORD,
    LABEL_KINDS,
    withoutTokenLineBreaks,
  };
})();

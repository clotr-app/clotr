// Runs the patterns from patterns.js against a page's text, decides how to respond to each hit, and
// fingerprints the values it finds. This is a classic script, not a module, so it shares its functions through
// globalThis.Clotr.
(() => {
  "use strict";

  const { PATTERNS, numberRuns, isPlaceholder, addressCore, vaultKinds, isVaultFormat, ASK_REASONS } = globalThis.Clotr;

  const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

  const LOG = "[Clotr]";
  // detect() is bounded by two limits, checked before each pattern (never mid-pattern: a single hung regex can't
  // be interrupted, so one slow pattern can still drag out, but nothing after it does too).
  //
  // The character budget is spent by the length of text actually handed to a pattern, which is exactly the same
  // for the same message and kind list no matter how fast the device reading it is right now, so two phones, or
  // the same phone busy and idle, skip the same patterns for the same paste instead of each cutting off at a
  // different, unpredictable point. It only matters for text far past anything normal, since it's sized for
  // every vault kind a team can add, over and over, well past attachments.js' 2 MB document cap.
  //
  // The wall-clock backstop is what actually catches an ordinary-sized message on a genuinely slow device, since
  // the character budget alone would let a huge paste run for as long as the device needs: it's generous enough
  // that a realistic document, even read twice over for the phone-keyboard-dot re-check, finishes on a phone
  // several times slower than an everyday laptop, and only cuts off something at the far edge of both size and
  // slowness, where no budget could finish fast and stay honest about what it checked.
  const DETECT_BUDGET_CHARS = 1_000_000_000;
  const DETECT_BACKSTOP_MS = 10000;
  const DETECT_WINDOW_CHARS = 40 * 1024;
  const DETECT_WINDOW_OVERLAP = 8 * 1024;
  const DETECT_PRIVATE_KEY_FALLBACK_CHARS = 64 * 1024;
  const PEM_BEGIN = /-----[ \t]*BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \t]*-----(?!-)/;
  const PEM_END_SHAPE = /-----[ \t]*END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \t]*-----(?!-)/;
  const PEM_END = /-----[ \t]*END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \t]*-----(?!-)/g;

  function partialPem(value) {
    const begin = PEM_BEGIN.exec(value);
    return begin && !PEM_END_SHAPE.test(value) && value.length > begin[0].length ? begin[0] : null;
  }

  // ---------- Text as copied from web pages, documents and chat apps ----------
  // Invisible characters, exotic spaces and dashes, and full-width or other-script digits could hide a leak, so
  // the patterns run against a cleaned copy instead. `start` and `end` map each cleaned character back to the
  // original text, so a match is reported, and redacted, the way the person actually typed it. I leave
  // look-alike letters from other alphabets alone, since mapping them would mangle real Russian or Greek text.
  const INVISIBLE =
    // eslint-disable-next-line no-misleading-character-class -- each invisible mark is matched on its own, on purpose
    /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/;
  const SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
  const DASH = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/;
  // A phone keyboard types curly quotes and apostrophes, so "driver’s license" matches "driver's license" either way.
  const QUOTE = /[‘’‚‛ʼ]/;
  const DOUBLE_QUOTE = /[“-‟]/;
  const ASCII = /^[\x20-\x7e]+$/;
  const DIGIT = /\p{Nd}/u;

  function digitValue(cp) {
    let zero = cp; // the start of this run of decimal digits, which count up from 0 to 9 in order
    while (zero > 0 && DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  }

  // A link's query can carry a secret URL-encoded (encodeURIComponent turns "/" into %2F, a space into %20 and a
  // line break into %0A), so inside a link a printable ASCII character, a tab or a line break written that way reads
  // as itself. Anything else, like the bytes of an accented letter, stays as written. Outside a link only %40 reads
  // as "@" (ann%40gmail.com), since some keys hold a literal "%3D" of their own. Two places read like a link without
  // its "://": an HTTP request line's target ("GET /pay?card=4539%201488... HTTP/1.1") reads as a link, wherever the
  // line sits (in an access log's quotes, after curl's "> ", indented), and a form body or query written on its own
  // ("card=4539%201488...&cvv=123", "body:ssn=...", "/apply?ssn=...") reads as one too from its first key on, but
  // for "%3D", "%26" and "%25", which stay as written there so a key's own literal "%3D" is kept. A "%3D" that joins
  // a key to a number ("data=card%3D4539%201488...", a form nested in another) is that form's "=" all the same. A
  // form writes a space as "+", so a value made of numbers joined by "+" ("card=4539+1488+0343+6467") reads with
  // spaces; a value with letters in it keeps its "+", since a key's base64 has them. A form also starts right after
  // a "[" ("[ssn=..." in a log line), and one encoded whole starts at a key whose "%3D" comes before a number
  // ("ssn%3D219%2D09%2D9999"). A link carried in another link's parameter is encoded twice, so inside a link a run
  // like "%2520" or "%252D" reads as the character its last two digits stand for.
  const PERCENT = /%[0-9a-f]{2}/i;
  const URL_END = /[\s"'`<>]/;
  const HEX_PAIR = /^[0-9a-f]{2}$/i;
  const ENCODED_SCHEME_END = /^%3A%2F%2F/i;
  const REQUEST_LINE = /(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) +(?=[^\s"'`<>])/y;
  const REQUEST_LEAD = /[\s"'`>([]/; // what can sit just before a request line's method
  const TOKEN = /[^\s"'`<>]*/y;
  const FORM_KEY = /[A-Za-z_][\w.[\]-]*(?:=|%3D(?=\d|%28|%2B))/iy;
  const KEY_CHAR = /[\w.[\]-]/;
  const FORM_KEEPS = /^(?:3D|26|25)$/i;
  const NESTED_VALUE = /^(?:\d|%28|%2B)/i;
  const NESTED_ESCAPE = /(?:25)*[0-9a-f]{2}/iy;
  const PLUS_HINT = /=[^\s"'`<>&;#,=]*\+/;
  const PLUS_VALUE = /(?:[\d().-]|%[0-9a-f]{2})+(?:\+(?:[\d().-]|%[0-9a-f]{2})+)+(?=[\s"'`<>&;#,]|$)/iy;
  // Where the last %XX of the token from `from` to `to` starts, or -1.
  function lastEscapeIn(text, from, to) {
    for (let j = to - 3; j >= from; j--) {
      if (text.charCodeAt(j) === 37 && HEX_PAIR.test(text.slice(j + 1, j + 3))) return j;
    }
    return -1;
  }
  function percentDecoded(text, i) {
    const hex = text.slice(i + 1, i + 3);
    if (!HEX_PAIR.test(hex)) return null;
    const code = parseInt(hex, 16);
    return (code >= 0x20 && code <= 0x7e) || code === 9 || code === 10 || code === 13
      ? String.fromCharCode(code)
      : null;
  }
  // A URL's user:password@ part keeps its encoding: there %40 is how a user name like Azure's user@server is
  // written, and the "@" it would become, or a space from %20, would end the user name or password early.
  const URL_USERINFO = /[^\s@/?#:]{1,256}:[^\s@/]{1,512}@/y;
  // Markdown escapes "_" as "\_", which would break every key with an underscore in it, so a "\_" right after a
  // letter or digit reads as "_".
  const isWordCode = (code) =>
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

  // `link` is for a window of a large paste that starts inside a link (linkAt): the window reads it as the paste
  // read from its start would, though it never sees the link's "://".
  function cleanText(text, link) {
    // Plain ASCII with no URL encoding (like ann%40gmail.com from a pasted link) and no escapes needs no cleaning.
    if (
      !/[^\x00-\x7f]/.test(text) &&
      !PERCENT.test(text) &&
      !text.includes("\\n") &&
      !text.includes("\\r\\n") &&
      !text.includes("\\_") &&
      !(text.includes("+") && PLUS_HINT.test(text))
    ) {
      return { clean: text, start: null, end: null, jsonBreaks: null };
    }
    let clean = "";
    const start = [];
    const end = [];
    const jsonBreaks = new Set(); // where each JSON string's \n landed in the cleaned text
    let jsonString = false;
    let jsonEscape = false;
    let userinfoEnd = link ? link.userinfoEnd : -1; // where the user:password part of a URL ends, at its "@"
    let inUrl = Boolean(link); // inside a link, from its "://" to the next space or quote
    let requestTarget = -1; // where an HTTP request line's target starts
    let inForm = false; // inside a key=value token outside a link, to the next space or quote
    let tokenEnd = 0; // where the run of text up to the next space or quote ends
    let tokenEscape = -1; // where that run's last %XX starts
    let plusUntil = -1; // where a form value of numbers joined by "+" ends
    const plus = text.includes("+");
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      let next = i + ch.length;
      let out = ch;
      const jsonBreak =
        jsonString &&
        !jsonEscape &&
        ch === "\\" &&
        (text[i + 1] === "n" ? 2 : text.slice(i + 1, i + 4) === "r\\n" ? 4 : 0);
      if (cp >= 68 && cp <= 80 && (i === 0 || REQUEST_LEAD.test(text[i - 1]))) {
        REQUEST_LINE.lastIndex = i;
        if (REQUEST_LINE.test(text)) requestTarget = REQUEST_LINE.lastIndex;
      }
      if (URL_END.test(ch)) inForm = false;
      else {
        if (i >= tokenEnd) {
          TOKEN.lastIndex = i;
          TOKEN.test(text);
          tokenEnd = TOKEN.lastIndex;
          tokenEscape = lastEscapeIn(text, i, tokenEnd);
        }
        if (!inUrl && !inForm && i < tokenEscape && (i === 0 || text[i - 1] === "[" || !KEY_CHAR.test(text[i - 1]))) {
          FORM_KEY.lastIndex = i;
          inForm = FORM_KEY.test(text);
        }
      }
      if (i === requestTarget) {
        inUrl = true;
      } else if (ch === ":" && text.charCodeAt(i + 1) === 47 && text.charCodeAt(i + 2) === 47) {
        inUrl = true;
        URL_USERINFO.lastIndex = i + 3;
        if (URL_USERINFO.test(text)) userinfoEnd = URL_USERINFO.lastIndex - 1;
      } else if (ch === "%" && ENCODED_SCHEME_END.test(text.slice(i, i + 9))) {
        inUrl = true; // a link encoded whole, as a redirect= parameter carries one: its "://" is "%3A%2F%2F"
      } else if (inUrl && URL_END.test(ch)) inUrl = false;
      const hex = ch === "%" ? text.slice(i + 1, i + 3) : "";
      const formDecodes =
        inForm &&
        (!FORM_KEEPS.test(hex) ||
          (/^3D$/i.test(hex) &&
            i > 0 &&
            isWordCode(text.charCodeAt(i - 1)) &&
            NESTED_VALUE.test(text.slice(i + 3, i + 6))));
      let decoded =
        ch === "%" && i >= userinfoEnd && (inUrl || /^40/.test(hex) || formDecodes) ? percentDecoded(text, i) : null;
      let width = 3;
      if (decoded === "%" && inUrl) {
        // A link carried in another link's parameter is encoded twice ("%2520" for a space), or more.
        NESTED_ESCAPE.lastIndex = i + 3;
        const nested = NESTED_ESCAPE.exec(text);
        const inner = nested ? percentDecoded(`%${nested[0].slice(-2)}`, 0) : null;
        if (inner !== null) {
          decoded = inner;
          width += nested[0].length;
        }
      }
      if (plus && (ch === "=" || decoded === "=") && i > 0 && KEY_CHAR.test(text[i - 1])) {
        PLUS_VALUE.lastIndex = decoded === "=" ? i + width : i + 1;
        if (PLUS_VALUE.test(text)) plusUntil = PLUS_VALUE.lastIndex;
      }
      if (jsonBreak) {
        // JSON strings escape token line breaks, so join them as line breaks while keeping the raw span.
        out = "\n";
        next = i + jsonBreak;
        jsonBreaks.add(clean.length);
      } else if (decoded !== null) {
        out = decoded;
        next = i + width;
      } else if (ch === "\\" && text.charCodeAt(i + 1) === 95 && i > 0 && isWordCode(text.charCodeAt(i - 1))) {
        out = ""; // Markdown's "\_"; the "_" itself is read next
      } else if (ch === "+" && i < plusUntil) {
        out = " "; // a form's space, between numbers
      } else if (cp >= 0x80) {
        if (INVISIBLE.test(ch)) out = "";
        else if (SPACE.test(ch)) out = " ";
        else if (DASH.test(ch)) out = "-";
        else if (QUOTE.test(ch)) out = "'";
        else if (DOUBLE_QUOTE.test(ch)) out = '"';
        else if (DIGIT.test(ch)) out = digitValue(cp);
        else {
          const n = ch.normalize("NFKC"); // turns full-width letters and symbols like Ａ or ＠ into plain ASCII
          if (ASCII.test(n)) out = n;
        }
      }
      for (let k = 0; k < out.length; k++) {
        clean += out[k];
        start.push(i);
        end.push(next);
      }
      if (jsonBreak) {
        jsonEscape = false;
      } else if (jsonString) {
        if (jsonEscape) jsonEscape = false;
        else if (ch === "\\") jsonEscape = true;
        else if (ch === '"') jsonString = false;
      } else if (ch === '"') {
        jsonString = true;
      }
      i = next;
    }
    return { clean, start, end, jsonBreaks };
  }

  // Whether a window of a large paste starting at `from` starts inside a link, as cleanText reading the paste from its
  // start would have it there: a "://", or a link's whole encoded "%3A%2F%2F", since the last space or quote before
  // `from`, looked for no further back than the windows' overlap. Returns cleanText's `link`, or null.
  function linkAt(text, from) {
    let i = from;
    const stop = Math.max(0, from - DETECT_WINDOW_OVERLAP);
    while (i > stop && !URL_END.test(text[i - 1])) i--;
    if (i === from) return null;
    const scheme = text.slice(i, from + 2).lastIndexOf("://", from - i - 1);
    if (scheme >= 0) {
      URL_USERINFO.lastIndex = i + scheme + 3;
      return { userinfoEnd: URL_USERINFO.test(text) ? URL_USERINFO.lastIndex - 1 - from : -1 };
    }
    const encoded = text.slice(i, from + 8).search(/%3A%2F%2F/i);
    return encoded >= 0 && encoded < from - i ? { userinfoEnd: -1 } : null;
  }

  // ---------- A phone keyboard's dot ----------
  // On a phone, two spaces typed in a row turn into ". ", so a label can end up with a dot it never had, like
  // "driver’s. license L8426037" or "my date of birth. is 10/07/1980". I read the text a second time with each of
  // those dots turned back into a space, keeping the same length so nothing shifts position. A dot can also be a
  // real sentence ending, so this second reading only adds a detail that sits entirely before or after one dot,
  // never spanning it, and never one that starts with the next sentence's first word: "I changed my password.
  // Thanks!" shouldn't catch "Thanks" as a password. The one exception is a sentence that ends on "is", "was",
  // "es" or "era" while asking a question, like "I forgot what my password is. Thanks!", where the dot is real
  // and stays. Otherwise I treat the capitalized word after one of those as the keyboard's own doing: I read it
  // back in lowercase ("my password is. Sunshine" becomes "my password is  sunshine") and restore its capital in
  // whatever gets found.
  const PHONE_DOT = /(?<=\p{L})\. (?=\S)(\p{Lu}\p{Ll}*(?![\p{L}\p{N}]))?/gu;
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
  // A JSON string or a log line keeps a line break or a tab as the two characters \n, \r or \t, so the letter after
  // the backslash glues onto whatever follows, and "\nAKIA…" reads as "nAKIA…". A JSON string's \n is a real line
  // break in the cleaned text already (cleanText), so a key wrapped inside one still joins up. Every other escape
  // gets the same second reading as a phone's dot, which turns it into spaces, keeping the length, and
  // addedByReading already drops anything spanning them. A log line that holds another program's JSON escapes the
  // backslash again ("\\nAKIA…"), so a run of them counts too. The run is matched only from its first backslash,
  // which keeps a long run of them linear.
  const ESCAPED_BREAK = /(?<!\\)\\+[nrt]/g;
  function secondReading(clean) {
    const dots = withoutPhoneDots(clean);
    const base = dots ? dots.text : clean;
    const text = base.includes("\\") ? base.replace(ESCAPED_BREAK, (escape) => " ".repeat(escape.length)) : base;
    if (text === base) return dots;
    return { firstWords: new Set(), lowered: new Set(), ...dots, text };
  }

  // Wrapped values are short, so skip huge runs and cap how many get a second scan.
  const MAX_JOINED_TOKEN = 4096;
  const MAX_JOINED_RUNS = 300;
  const MAX_WORD_TAIL_READS = 32;
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

      if (block?.contentIndent === null) {
        if (!blank) {
          if (indent <= block.parentIndent) block = null;
          else {
            const contentIndent = block.explicitIndent === null ? indent : block.parentIndent + block.explicitIndent;
            if (indent < contentIndent) block = null;
            else {
              block.contentIndent = contentIndent;
              const line = { contentStart: lineStart + contentIndent, block };
              lines.set(lineStart, line);
              lines.set(line.contentStart, line);
            }
          }
        }
      } else if (block) {
        if (!blank) {
          if (indent < block.contentIndent) block = null;
          else {
            const line = { contentStart: lineStart + block.contentIndent, block };
            lines.set(lineStart, line);
            lines.set(line.contentStart, line);
          }
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
  const KEY_START =
    /^(?:AKIA|ASIA|gh[pousr]_|github_pat_|glpat-|sk-|[sr]k_(?:live|test)_|xox[abpors]-|AIza|hf_|npm_|GOCSPX-|ya29\.|dckr_(?:pat|oat)_|sbp_|lsv2_|pcsk_|ntn_|gsk_|CFPAT-|pscale_|nvapi-|figd_|bkua_|napi_|xkeysib-|sq0c[a-z]{2}-|dp\.(?:ct|pt|st|sa)\.)/;
  // Where the word before a line break ends: a shell's "\" carrying a line on, or a soft "=" after a key's start,
  // belongs to the break.
  function wordEnd(clean, lineStart, lineEnd) {
    const mark = clean.charCodeAt(lineEnd - 1);
    if (mark !== 92 && mark !== 61) return lineEnd;
    let start = lineEnd - 1;
    while (start > lineStart && isTokenCode(clean.charCodeAt(start - 1))) start--;
    if (mark === 61) return KEY_START.test(clean.slice(start, lineEnd - 1)) ? lineEnd - 1 : lineEnd;
    return start < lineEnd - 1 ? lineEnd - 1 : lineEnd;
  }

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

  // Returns a match the second reading found that the first reading missed, written the way the page actually
  // had it, or null if there's nothing new. I skip anything the first reading already caught with its trailing
  // dot still on ("7 Willow Dr." reads the same as "7 Willow Dr"), anything that starts with the next sentence's
  // first word (a match with a digit in it can, like "October 3"), and anything that still holds one of the dots
  // I turned into a space.
  function addedByReading(m, firstFound, reading) {
    const lead = /^\p{L}+/u.exec(m)?.[0];
    const asWritten = lead && reading.lowered.has(lead) ? m[0].toUpperCase() + m.slice(1) : m;
    if (firstFound.has(asWritten) || firstFound.has(`${asWritten}.`) || / {2}| $/.test(m)) return null;
    return reading.firstWords.has(lead) && !/\p{N}/u.test(m) ? null : asWritten;
  }

  // Returns every pattern hit in the text as [{ ...pattern, matches: [text, …] }], most severe first. If a match
  // sits inside a more severe one, like the first ten digits of an Amex card also looking like a phone number, I
  // drop the weaker one so each piece of data only gets reported once. Matches are always pieces of the original
  // text, not the cleaned copy (see cleanText). The built-in kinds come first, then whatever kinds a team added
  // at run time through the vault (patterns.js' setVault).
  //
  // The password kind can also carry `asks`, the kinds of code a scammer asked for, and `reasonOf`, the reason
  // behind each individual match. Those only exist for matches that are still in the result, and only hold the
  // words shown on screen, since decide.js's whoAsks turns a reason into that wording. Nothing about a reason is
  // ever stored.
  //
  // The last answer: a pause while typing and then Send scan one draft twice, so detect() keeps its last answer and
  // hands the same text a fresh copy of it without running a rule. It holds only while the rules are the same ones
  // under the same names and the vault is unchanged (setVault makes a new kinds list each time), and an answer the
  // time limit cut short is never kept. detect.forget() drops it, for a timing test that has to scan afresh.
  let lastDetect = null;
  const copyResults = (results) =>
    results.map((r) => ({
      ...r,
      matches: [...r.matches],
      ...(r.asks ? { asks: [...r.asks] } : {}),
      ...(r.reasonOf ? { reasonOf: new Map(r.reasonOf) } : {}),
    }));

  // A window that cuts a value off at its end, or starts partway into one, can find a piece of it, like a card's
  // first 10 digits read as a phone number. The window on the other side of that seam sees the whole value, so a
  // window leaves what it found within SEAM_ZONE of a seam to its neighbour: `held` is what touches its end, which
  // the caller keeps only if the next window can't finish; anything touching its start, `dropped`, is left out, since
  // the window before already read it whole. A kind that needs its label in the text it reads, like a seed phrase's
  // "seed phrase", is the exception detectFresh looks after (seamRescue). A value long enough to reach past the
  // overlap stays, as does a private key, whose pieces detect() joins on its own.
  const SEAM_ZONE = 1024;
  const SEAM_VALUE_MAX = DETECT_WINDOW_OVERLAP - 2 * SEAM_ZONE;
  function seamParts(results, windowText, trimStart, trimEnd) {
    if (!trimStart && !trimEnd) return { kept: results, held: [], dropped: [] };
    const length = windowText.length;
    const atEnd = (m) =>
      trimEnd &&
      windowText.indexOf(m, Math.max(0, length - SEAM_ZONE - m.length + 1)) >= 0 &&
      windowText.indexOf(m) >= length - DETECT_WINDOW_OVERLAP + SEAM_ZONE;
    const atStart = (m) =>
      trimStart &&
      windowText.lastIndexOf(m, SEAM_ZONE - 1) >= 0 &&
      windowText.lastIndexOf(m) + m.length <= DETECT_WINDOW_OVERLAP - SEAM_ZONE;
    const kept = [];
    const held = [];
    const dropped = [];
    const part = (result, matches) => {
      if (matches.length === result.matches.length) return result;
      const out = { ...result, matches };
      if (result.reasonOf) {
        const own = new Set(matches);
        out.reasonOf = new Map([...result.reasonOf].filter(([m]) => own.has(m)));
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
      for (const m of result.matches) {
        if (!m || m.length > SEAM_VALUE_MAX) keep.push(m);
        else if (atEnd(m)) hold.push(m);
        else if (atStart(m)) drop.push(m);
        else keep.push(m);
      }
      if (keep.length) kept.push(part(result, keep));
      if (hold.length) held.push(part(result, hold));
      if (drop.length) dropped.push(part(result, drop));
    }
    return { kept, held, dropped };
  }

  // A kind that needs its label in the text it reads (patterns.js' `labelAnywhere`: a seed phrase, a backup-code
  // file) can be found near a seam by the window that holds the label and missed by the window on the other side,
  // which can't see it: a phrase near a window's end labelled at its start, or one right after a window's start
  // labelled further on. Each window leaves such a value to the other, so neither would report it. `pieces` are what
  // window `own` found of such kinds near its seam with window `other`; any `other` didn't report there too is read
  // again by `other`, for those kinds alone, told that the label is there, and what it then finds over the same
  // place is kept. `other` reads the value whole, so a piece of a longer list cut by the seam is kept only when the
  // whole list is a phrase too. The label still counts only from a window that holds the value: one a window or
  // more away from a column of codes or a word list says nothing about them, as in any large paste. `labelled` holds
  // those kinds' ids; each window is { from, to, text, link, results }, `results` being all it found.
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
      const a = win.from + at;
      const b = a + match.length;
      return spans.some(([s, e]) => a < e && b > s);
    };
    const missed = new Map(); // kind → where its values sit in the paste
    for (const result of pieces) {
      if (!labelled.has(result.id)) continue;
      const theirs = other.results.find((r) => r.id === result.id);
      for (const match of result.matches) {
        const span = placeOf(match, own);
        if (!span || (theirs && theirs.matches.some((m) => overlaps(m, other, [span])))) continue;
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
      const matches = result.matches.filter((m) => m && overlaps(m, other, spans));
      if (!matches.length) continue;
      const out = { ...result, matches };
      if (result.reasonOf) out.reasonOf = new Map([...result.reasonOf].filter(([m]) => matches.includes(m)));
      found.push(out);
    }
    return found;
  }

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

  function detectFresh(text) {
    const scan = { deadline: Date.now() + DETECT_BACKSTOP_MS, charsLeft: DETECT_BUDGET_CHARS, timedOut: false };
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
    const labelled = new Set(PATTERNS.filter((pattern) => pattern.labelAnywhere && pattern.find).map((p) => p.id));
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
        const footerEnd = footer ? footer.index + footer[0].length : -1;
        if (
          (footerEnd >= 0 && footerEnd - at > DETECT_PRIVATE_KEY_FALLBACK_CHARS) ||
          (footerEnd < 0 && text.length - at > DETECT_PRIVATE_KEY_FALLBACK_CHARS)
        ) {
          scan.truncated = true;
          continue;
        }
        const to = footerEnd >= 0 ? footerEnd : text.length;
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

  // A window of a large paste (detectFresh) can get `how`: `link` when it starts inside a link (linkAt); and `only`
  // and `told` when seamRescue reads it again for those kinds alone, told their labels are there (a Map, kind → true).
  function detectWindow(text, scan, how) {
    const { link, only, told } = how || {};
    const { clean, start, end, jsonBreaks } = cleanText(text, link);
    const yamlLines = yamlLiteralBlockLines(clean);
    const results = [];
    const kinds = only || [...PATTERNS, ...vaultKinds()];
    const why = [new Map(), new Map(), new Map()]; // one per reading: value → reason
    const read = (pattern, t, reasons) =>
      pattern.find
        ? pattern.id === "password"
          ? pattern.find(t, reasons)
          : told && told.has(pattern)
            ? pattern.find(t, undefined, told.get(pattern))
            : pattern.find(t)
        : t.match(pattern.regex) || [];
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
    // Every pattern reads the full text first, then the phone-dot and token-wrap readings. I run them in that
    // order because patterns.js caches the previous text's number runs, so interleaving the readings would throw
    // that cache off.
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
    // The vault's own words and formats don't read Bandage labels (patterns.js' findVault), and a team's kinds are
    // just more vault entries.
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
          for (const m of read(pattern, before, why[2])) if (!third[i].includes(m)) third[i].push(m);
        }
      }
    }
    const counts = (pattern, m) => (!pattern.validate || pattern.validate(m)) && !(pattern.secret && isPlaceholder(m));
    // What the first reading found, by where it ends in the cleaned text.
    let firstEnds = null;
    const firstEndingAt = (to) => {
      if (!firstEnds) {
        firstEnds = new Map();
        for (const [i, pattern] of kinds.entries()) {
          for (const m of first[i]) {
            if (!m || !counts(pattern, m)) continue;
            for (let at = clean.indexOf(m); at >= 0; at = clean.indexOf(m, at + 1)) {
              const ending = firstEnds.get(at + m.length) || [];
              ending.push({ at, pattern, m });
              firstEnds.set(at + m.length, ending);
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
        if (found.pattern === pattern || read(found.pattern, found.m, new Map()).includes(found.m)) return true;
      }
      const before = joinedReading.text.slice(Math.max(0, at - 256), splitAt);
      if (!withinBudget(before.length)) return false;
      return read(pattern, before, new Map()).some(
        (m) => m.length >= splitAt - at && before.endsWith(m) && counts(pattern, m),
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
    // hold thousands of them, and walking the whole list for every value took seconds.
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
    // near one, and each of them once searched the whole text again from every break.
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
      for (const m of second[i] || []) {
        const added = addedByReading(m, firstFound, reading);
        if (!added) continue;
        raw.add(added);
        if (why[1].has(m)) why[0].set(added, why[1].get(m)); // its reason, as written
      }
      const wrapped = [];
      const wrappedRaw = new Set();
      for (const m of third[i] || []) {
        if ((pattern.validate && !pattern.validate(m)) || (pattern.secret && isPlaceholder(m))) continue;
        for (const mapped of joinedToRaw(m, pattern)) {
          if (mapped.to - mapped.from > mapped.match.length) {
            wrapped.push(mapped);
            joinedSpans.push(mapped);
          }
          raw.add(mapped.value);
          wrappedRaw.add(mapped.value);
          if (why[2].has(m)) why[0].set(mapped.value, why[2].get(m));
        }
      }
      // Only a value inside a wrapped one can be covered by it. Checking that first, against the few wrapped values,
      // keeps a paste of thousands of addresses from searching the whole text once for each.
      const wrappedText = wrapped.map((item) => item.match).join("\0");
      const coveredByWrap = (m) => {
        if (!m || !wrappedText.includes(m)) return false;
        let found = false;
        for (let at = clean.indexOf(m); at >= 0 && m; at = clean.indexOf(m, at + 1)) {
          found = true;
          if (!wrapped.some((item) => item.match.includes(m) && item.from <= at && item.to >= at + m.length)) {
            return false;
          }
        }
        return found;
      };
      const matches = [...raw].filter(
        (m) =>
          wrappedRaw.has(m) ||
          (!coveredByWrap(m) && (!pattern.validate || pattern.validate(m)) && !(pattern.secret && isPlaceholder(m))),
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
    for (const r of results) {
      const moreSevere = kept.filter((k) => SEVERITY_RANK[k.severity] > SEVERITY_RANK[r.severity]);
      const inside = (m) => {
        const containers = [];
        for (const k of moreSevere) {
          for (const km of k.longestFirst) {
            globalThis.Clotr.overlapChecks++;
            if (km.length <= m.length) break;
            // One at a time: a value pasted 130,000 times has that many spans, too many to spread into one call.
            if (km.includes(m)) for (const span of spansOf(km)) containers.push(span);
          }
        }
        if (!containers.length) return false;
        const occurrences = spansOf(m);
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
      const matches = r.matches.filter((m) => !inside(m));
      if (matches.length) {
        kept.push({
          ...r,
          matches,
          longestFirst: [...matches].sort((a, b) => b.length - a.length),
        });
      }
    }
    for (const k of kept) {
      delete k.longestFirst;
      if (k.id !== "password") continue;
      // `reasonOf` keeps each code's own reason, so a warning still knows them even after some matches got
      // filtered out.
      const reasonOf = new Map(k.matches.filter((m) => why[0].has(m)).map((m) => [m, why[0].get(m)]));
      const reasons = new Set(reasonOf.values());
      const asks = ASK_REASONS.filter((r) => reasons.has(r));
      if (asks.length) Object.assign(k, { asks, reasonOf });
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
    const original = (m) => {
      const out = new Set();
      for (let at = clean.indexOf(m); at >= 0 && m; at = clean.indexOf(m, at + 1)) {
        out.add(text.slice(start[at], end[at + m.length - 1]));
      }
      return out.size ? [...out] : [m];
    };
    return flagged(
      kept.map((r) => {
        const matches = [...new Set(r.matches.flatMap(original))];
        if (!r.reasonOf) return { ...r, matches };
        const reasonOf = new Map([...r.reasonOf].flatMap(([m, reason]) => original(m).map((o) => [o, reason])));
        return { ...r, matches, reasonOf };
      }),
    );
  }

  // ---------- PDF attachments: finding the streams ----------
  // A PDF someone attaches is attacker-controlled, so this stays linear and bounded: each "stream" keyword only
  // looks back 4 KB for its dictionary, and I never look at more than 5,000 keywords total.
  function findPdfStreams(raw, max = 400) {
    const out = [];
    let at = 0;
    for (let seen = 0; out.length < max && seen < 5000; seen++) {
      const k = raw.indexOf("stream", at);
      if (k < 0) break;
      at = k + 6;
      if (raw.startsWith("end", k - 3)) continue; // "endstream"
      let s = k + 6;
      if (raw[s] === "\r") s++;
      if (raw[s] !== "\n") continue;
      s++;
      let e = k - 1;
      while (e > 0 && k - e < 64 && (raw[e] === " " || raw[e] === "\r" || raw[e] === "\n" || raw[e] === "\t")) e--;
      if (raw[e] !== ">" || raw[e - 1] !== ">") continue;
      let depth = 0;
      let dictStart = -1;
      for (let i = e, lo = Math.max(1, e - 4096); i >= lo;) {
        if (raw[i] === ">" && raw[i - 1] === ">") {
          depth++;
          i -= 2;
          continue;
        }
        if (raw[i] === "<" && raw[i - 1] === "<") {
          depth--;
          i -= 2;
          if (depth === 0) {
            dictStart = i + 1;
            break;
          }
          continue;
        }
        i--;
      }
      if (dictStart < 0) continue;
      out.push({ dict: raw.slice(dictStart + 2, e - 1), start: s });
    }
    return out;
  }

  // Reads the text-showing operators (Tj, TJ, ', ") out of already-unpacked PDF page streams, translating each
  // one through its font's ToUnicode map. Every loop here is bounded and blocks are found with indexOf, so a
  // hostile file can't make this crawl.
  const hexToString = (hex) => {
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s || String.fromCharCode(parseInt(hex || "20", 16));
  };
  function blocks(text, open, close, max = 200) {
    const out = [];
    for (let at = 0; out.length < max;) {
      const a = text.indexOf(open, at);
      if (a < 0) break;
      const b = text.indexOf(close, a + open.length);
      if (b < 0) break;
      out.push(text.slice(a + open.length, b));
      at = b + close.length;
    }
    return out;
  }
  // A single range is already capped at 5,001 codes, but nothing capped how many ranges or bfchar entries a
  // hostile file could pack in: one 2 MB stream of tiny ranges could still mean hundreds of millions of map.set
  // calls. `budget` is shared across every stream of one PDF, so the total stays bounded no matter how it's split.
  const MAX_CMAP_TOTAL = 50000;
  function readCMap(text, map, budget) {
    for (const block of blocks(text, "beginbfchar", "endbfchar")) {
      for (const m of block.matchAll(/<([0-9a-fA-F]{1,8})>\s{0,20}<([0-9a-fA-F]{1,64})>/g)) {
        if (budget.left-- <= 0) return;
        map.set(m[1].toLowerCase(), hexToString(m[2]));
      }
    }
    for (const block of blocks(text, "beginbfrange", "endbfrange")) {
      // An array entry's closing "]" (at most 20,000 characters on) is found with indexOf, and the next "]" is
      // remembered, so a hostile file full of unclosed "[" can't make every entry rescan 20,000 characters.
      const entry = /<([0-9a-fA-F]{1,8})>\s{0,20}<([0-9a-fA-F]{1,8})>\s{0,20}(?:<([0-9a-fA-F]{1,64})>|\[)/g;
      let close = -1; // the first "]" at or after the last "[" looked at; Infinity once there's none left
      for (let m = entry.exec(block); m; m = entry.exec(block)) {
        if (budget.left <= 0) return;
        let array = null;
        if (m[3] === undefined) {
          const open = entry.lastIndex;
          if (close < open) {
            close = block.indexOf("]", open);
            if (close < 0) close = Infinity;
          }
          if (close - open > 20000) {
            entry.lastIndex = m.index + 1; // not an entry: look again from the next character
            continue;
          }
          array = block.slice(open, close);
          entry.lastIndex = close + 1;
        }
        const lo = parseInt(m[1], 16);
        const hi = Math.min(parseInt(m[2], 16), lo + 5000, lo + budget.left);
        const width = m[1].length;
        const list = array ? [...array.matchAll(/<([0-9a-fA-F]{1,64})>/g)].map((x) => hexToString(x[1])) : null;
        for (let c = lo; c <= hi; c++) {
          budget.left--;
          map.set(
            c.toString(16).padStart(width, "0").toLowerCase(),
            list ? (list[c - lo] ?? "") : String.fromCharCode(parseInt(m[3], 16) + (c - lo)),
          );
        }
      }
    }
  }
  const ESCAPES = { n: " ", r: " ", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
  const pdfString = (s) =>
    s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_match, e) =>
      /[0-7]/.test(e[0]) ? String.fromCharCode(parseInt(e, 8)) : ESCAPES[e],
    );
  // `wide`: the maps have two-byte codes, so a code none of them knows is skipped four hex digits at a time. A code
  // a map does know moves on by its own width, so a simple font's one-byte map (<20> to <7E>) reads every byte.
  function showText(content, cmap, wide = true) {
    const hex = (raw) => {
      const h = raw.replace(/\s+/g, "").toLowerCase();
      if (cmap.size) {
        let s = "";
        for (let i = 0; i < h.length;) {
          const two = cmap.get(h.slice(i, i + 4));
          const one = two === undefined ? cmap.get(h.slice(i, i + 2)) : undefined;
          s += two ?? one ?? "";
          i += two !== undefined ? 4 : one !== undefined || !wide ? 2 : 4;
        }
        if (s) return s;
      }
      let s = "";
      for (let i = 0; i + 2 <= h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
      return s;
    };
    // This is a hand-written scanner. When a string or hex block never closes, I skip the whole window it
    // looked at, so a hostile file can't make any character get visited more than a bounded number of times.
    let out = "";
    let inArray = false;
    let flatUntil = 0;
    const n = content.length;
    for (let i = 0; i < n;) {
      const c = content[i];
      if (c === "(") {
        // Balanced parentheses inside a string needn't be escaped, so the string ends at the ")" that closes its own
        // "(". A file whose inner "(" never closes still ends at the first ")", as before, and so does every string
        // that starts inside the window that one looked at, so no character is looked at by more than one such scan.
        const nested = i >= flatUntil;
        let j = i + 1;
        let s = "";
        let depth = 0;
        let first = -1; // the first unescaped ")" and the string up to it
        let firstText = "";
        while (j < n && j - i <= 4096 && !(content[j] === ")" && (depth === 0 || !nested))) {
          if (content[j] === "\\") {
            s += content.slice(j, j + 2);
            j += 2;
            continue;
          }
          if (content[j] === "(") depth++;
          else if (content[j] === ")") {
            if (first < 0) [first, firstText] = [j, s];
            depth--;
          }
          s += content[j++];
        }
        if (content[j] === ")") {
          out += pdfString(s);
          i = j + 1;
        } else if (first >= 0) {
          out += pdfString(firstText);
          flatUntil = j;
          i = first + 1;
        } else i = j; // unclosed: skip it
        continue;
      }
      if (c === "<" && content[i + 1] !== "<") {
        let j = i + 1;
        while (j < n && j - i <= 8192 && /[0-9a-fA-F\s]/.test(content[j])) j++;
        if (content[j] === ">") {
          out += hex(content.slice(i + 1, j));
          i = j + 1;
        } else i = Math.max(j, i + 1);
        continue;
      }
      if (c === "[") inArray = true;
      else if (c === "]") inArray = false;
      else if (c === "E" && content[i + 1] === "T") out += " ; ";
      else if (
        c === "T" &&
        "Jj*dDm".includes(content[i + 1] || "") &&
        !inArray &&
        content[i + 1] !== "J" &&
        content[i + 1] !== "j"
      ) {
        out += " ";
      } else if ((c === "'" || c === '"') && !inArray) out += " ";
      i++;
    }
    return out;
  }
  function pdfPageText(streams) {
    const cmap = new Map();
    const budget = { left: MAX_CMAP_TOTAL };
    for (const s of streams) if (s.includes("begincmap")) readCMap(s, cmap, budget);
    let wide = false;
    for (const code of cmap.keys()) {
      if (code.length > 2) {
        wide = true;
        break;
      }
    }
    return streams
      .filter((s) => !s.includes("begincmap") && /Tj|TJ/.test(s))
      .map((s) => showText(s, cmap, wide))
      .join(" ; ");
  }

  // Turns Office XML (docx, xlsx, pptx, OpenDocument) into plain text in one linear pass. A hostile file can't
  // make this crawl; an earlier regex-based version took 54 seconds on 600 KB of "<a <a <a…".
  const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  // A paragraph's or cell's end, and the line breaks and tabs inside one (Word's w:br, w:cr and w:tab, PowerPoint's
  // a:br, OpenDocument's text:line-break and text:tab), with or without attributes, each start a new line;
  // OpenDocument's text:s is a run of spaces. Dropping them glued the words on either side into one.
  const BREAK_TAG =
    /^(?:\/(?:w:p|a:p|text:p|text:h|si|row|c)|(?:w:br|w:cr|w:tab|a:br|text:tab|text:line-break)(?:\s[\s\S]*)?\/?)$/;
  const SPACE_TAG = /^text:s(?:\s[\s\S]*)?\/?$/;
  function xmlToText(xml) {
    // Plain text gets copied in one slice per run and joined once at the end. Appending one character at a time
    // grew faster than the input on hostile "&aaaa…" text, which CI caught.
    const parts = [];
    let run = 0; // start of the plain text not yet copied
    const n = xml.length;
    for (let i = 0; i < n;) {
      const c = xml[i];
      if (c === "<") {
        const close = xml.indexOf(">", i + 1);
        if (close < 0) {
          n > run && i > run && parts.push(xml.slice(run, i));
          return parts.join("");
        } // there are no more tags, so the rest of the file isn't document text
        if (i > run) parts.push(xml.slice(run, i));
        if (close - i < 64) {
          const tag = xml.slice(i + 1, close).trim();
          if (BREAK_TAG.test(tag)) parts.push("\n");
          else if (SPACE_TAG.test(tag)) parts.push(" ");
        }
        i = run = close + 1;
        continue;
      }
      if (c === "&") {
        const near = xml.slice(i + 1, i + 12).indexOf(";"); // an entity is short, so I don't need to look further
        const semi = near < 0 ? -1 : i + 1 + near;
        const name = semi > i && semi - i <= 10 ? xml.slice(i + 1, semi) : "";
        if (name) {
          const code =
            name[0] === "#"
              ? parseInt(
                  name[1] === "x" || name[1] === "X" ? name.slice(2) : name.slice(1),
                  name[1] === "x" || name[1] === "X" ? 16 : 10,
                )
              : NaN;
          const decoded =
            name[0] === "#"
              ? code > 0 && code < 0x110000
                ? String.fromCodePoint(code)
                : ""
              : XML_ENTITIES[name.toLowerCase()];
          if (decoded !== undefined) {
            if (i > run) parts.push(xml.slice(run, i));
            parts.push(decoded);
            i = run = semi + 1;
            continue;
          }
        }
      }
      i++;
    }
    if (n > run) parts.push(xml.slice(run));
    return parts.join("");
  }

  // ---------- What to do about a detection ----------
  // A response is one of three things. Block opens a modal dialog and holds the message until the person
  // answers. Warn shows a corner notice but never holds anything. Log just counts it quietly as "Just counted."
  // There's no "off" anymore; every detection gets recorded, and an "off" stored by an older version now reads
  // as "log." The person can override any pattern's response through the `responses` storage key, a map of
  // pattern ID to response.
  const RESPONSES = ["block", "warn", "log"];
  // Nothing blocks by default; the person has to choose Block themselves. Severity still lives on the pattern
  // for the dashboard and badge, but it no longer changes the default response. A new kind can start out quiet,
  // counted but not shown, though nothing starts out blocking.
  const DEFAULT_RESPONSE = { high: "warn", medium: "warn", low: "warn" };

  function defaultResponse(patternId) {
    const p = PATTERNS.find((x) => x.id === patternId);
    return p?.start === "log" ? "log" : DEFAULT_RESPONSE[p?.severity] || "warn";
  }

  function responseFor(patternId, overrides) {
    const r = overrides?.[patternId] === "off" ? "log" : overrides?.[patternId];
    return RESPONSES.includes(r) ? r : defaultResponse(patternId);
  }

  // A team's policy sets a floor, not a ceiling: between two responses, the stricter one wins, so a required
  // "warn" can never downgrade someone's own "block". I treat an unrecognized response as "warn", the safe
  // middle ground, rather than rejecting it.
  function stricter(a, b) {
    const rank = (r) => (r === "block" ? 0 : r === "log" ? 2 : 1);
    return rank(a) <= rank(b) ? (RESPONSES.includes(a) ? a : "warn") : RESPONSES.includes(b) ? b : "warn";
  }

  // ---------- Fingerprints: salted and one-way, so the value itself is never stored ----------

  // Misspelled big providers (as in patterns.js), so a typo'd address still matches your own.
  const PROVIDER_TYPOS = {
    gmial: "gmail",
    gmal: "gmail",
    gamil: "gmail",
    gmaill: "gmail",
    gnail: "gmail",
    yaho: "yahoo",
    yahooo: "yahoo",
    yahho: "yahoo",
    hotmial: "hotmail",
    hotmal: "hotmail",
    hotmai: "hotmail",
    homail: "hotmail",
    outlok: "outlook",
    outloook: "outlook",
    iclod: "icloud",
    icoud: "icloud",
  };

  // Normalizes a value so the same detail matches no matter how it's written: "(555) 555-5636" and "five five
  // five…" become the same phone number, and "Bob@Gmail.com" matches "bob at gmail dot com".
  function normalize(patternId, raw) {
    const match = cleanText(raw).clean; // invisible characters and look-alike digits don't change a fingerprint
    if (patternId === "phone_number" || patternId === "us_ssn" || patternId === "credit_card") {
      // I drop a bracketed trunk 0, since "+44 (0)20…" and "+44 20…" are the same number dialed from abroad.
      const m = patternId === "phone_number" ? match.replace(/\(\s*0\s*\)/g, "") : match;
      let d = numberRuns(m)
        .flatMap((r) => r.units)
        .map((u) => u.digits)
        .join("");
      if (patternId === "phone_number" && d.length === 11 && d[0] === "1") d = d.slice(1);
      if (patternId === "phone_number" && /^00[1-9]/.test(d)) d = d.slice(2); // "0044…" is the same as "+44…"
      return `${patternId}:${d}`;
    }
    if (patternId === "email") {
      const e = match
        .toLowerCase()
        .replace(/\s*[([{<]\s*at\s*[)\]}>]\s*|\s+(?:at|arroba)\s+|\s*@\s*/g, "@")
        .replace(/\s*[([{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+|\s*\.\s*/g, ".")
        .replace(/\s+/g, "");
      // "janedoe at yahoo" is janedoe@yahoo.com, and "bob at gmial dot com" is bob@gmail.com.
      const full = /@[a-z0-9-]+$/.test(e) ? `${e}.com` : e;
      return `email:${full.replace(/@([a-z]+)\.com$/, (_m, host) => `@${PROVIDER_TYPOS[host] || host}.com`)}`;
    }
    // ID formats match either case ("ab-123456" = "AB-123456"), so their fingerprints do too.
    if (patternId === "my_id") return `my_id:${match.toLowerCase().trim()}`;
    // A VIN or a plate is the same in any case, with or without spaces and dashes.
    if (patternId === "vin" || patternId === "license_plate") {
      return `${patternId}:${match.toUpperCase().replace(/[\s\-·]+/g, "")}`;
    }
    // A gamer tag is the same in any case ("xXSniperXx" = "xxsniperxx"), with any spacing in a Riot name.
    if (patternId === "gamer_tag") return `gamer_tag:${match.toLowerCase().replace(/\s+/g, " ").trim()}`;
    // Your words match with or without accents ("José García" = "Jose Garcia"). Entries saved before 0.9.67
    // kept the accents, and "watch_list_accented" reproduces that form so they still match as typed.
    const words = () => match.toLowerCase().replace(/\s+/g, " ").trim();
    if (patternId === "watch_list") return `watch_list:${words().normalize("NFD").replace(/\p{M}/gu, "")}`;
    if (patternId === "watch_list_accented") return `watch_list:${words()}`;
    // The same person or employer however it's typed, for history repeats and the reply check.
    if (patternId === "my_name" || patternId === "family_name" || patternId === "employer") {
      return `${patternId}:${words().normalize("NFD").replace(/\p{M}/gu, "")}`;
    }
    // Addresses too match with or without accents ("Calle Alcalá 45" = "calle alcala 45"). Entries saved before
    // 0.9.68 kept the accents, and "street_address_accented" reproduces that form.
    if (patternId === "street_address" || patternId === "street_address_accented") {
      const core = addressCore(match) || words();
      return `street_address:${patternId === "street_address" ? core.normalize("NFD").replace(/\p{M}/gu, "") : core}`;
    }
    return `${patternId}:${match}`;
  }

  // Synchronous SHA-256 (hex), so a send can be checked the instant Enter is pressed.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  function sha256(str) {
    const bytes = new TextEncoder().encode(str);
    const len = Math.ceil((bytes.length + 9) / 64) * 64;
    const msg = new Uint8Array(len);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    const view = new DataView(msg.buffer);
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
        const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
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
    return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
  }

  // 16 hex chars of SHA-256(salt + normalized value). Every text span gets checked against the watch-list words
  // while someone types (patterns.js's vaultMatches), so this single round has to stay this cheap; it's also
  // what every saved watch-list word and team word is still fingerprinted with, scheme or no scheme.
  const fingerprint = (salt, patternId, match) => sha256(salt + normalize(patternId, match)).slice(0, 16);

  // The stronger fingerprint (scheme 2): 1,000 rounds, each folding in its own round number so a GPU can't
  // cache an intermediate state and skip ahead. Only worth paying for a value computed once per finding, never
  // once per text span: the vault's saved values, history events and reply mentions. A fp this makes is still
  // the same 16 hex characters, so storage validation and dedupe don't need to know which scheme made it.
  const FINGERPRINT_ROUNDS = 1000;
  function fingerprintStrong(salt, patternId, match) {
    let out = sha256(salt + normalize(patternId, match));
    for (let i = 1; i < FINGERPRINT_ROUNDS; i++) out = sha256(out + i);
    return out.slice(0, 16);
  }

  // Matches a stored entry's own scheme: 2 for the strengthened fingerprint, anything else (including a
  // missing field, every entry made before this existed) for the original single round. This is how an old
  // entry keeps matching without ever being rewritten: a one-way hash can't be upgraded in place, only made
  // again next time its value is typed.
  const fingerprintFor = (scheme, salt, patternId, match) =>
    scheme === 2 ? fingerprintStrong(salt, patternId, match) : fingerprint(salt, patternId, match);

  // The Hide it option replaces every found item with a label naming its kind, like "[REDACTED PHONE NUMBER]".
  // A pattern with its own `replace(match)` (Clean link) uses that instead, so "hiding" a link really means
  // cleaning it rather than blanking it out.
  // Findings can overlap, so merge their raw spans before replacing any text.
  // A saved word (the vault's) is only ever found standing as a word of its own, so a copy inside a longer word
  // ("Ann" in "Annabelle") isn't one and stays. Its edges are read as detect() read them: next to anything but a
  // letter or digit of any script (patterns.js vaultMatches), in the text as written or as cleaned (cleanText),
  // where a JSON string's "\n" is a line break and a link's "%20" a space. Every other kind, a value in a saved
  // format included, goes everywhere it appears (but for the short-value rule below), so nothing of a secret survives.
  const wordChar = (ch) => Boolean(ch) && /[\p{L}\p{N}]/u.test(ch);
  const insideWord = (match, before, after) =>
    (wordChar(match[0]) && wordChar(before)) || (wordChar(match[match.length - 1]) && wordChar(after));
  let cleanedRead = { text: null };
  // The characters just before and after text.slice(start, end) in the cleaned text, or null if nothing was cleaned.
  function cleanedAround(text, start, end) {
    if (cleanedRead.text !== text) cleanedRead = { text, ...cleanText(text) };
    const { clean, start: from } = cleanedRead;
    if (!from) return null;
    const firstAt = (at) => {
      let low = 0;
      let high = from.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (from[middle] < at) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    return { before: clean[firstAt(start) - 1], after: clean[firstAt(end)] };
  }
  // Whether the copy of `match` at `start` stands as a word, in the text as written or as cleaned.
  function standsAsWord(text, match, start) {
    const end = start + match.length;
    if (!insideWord(match, text[start - 1], text[end])) return true;
    const read = cleanedAround(text, start, end);
    return Boolean(read) && !insideWord(match, read.before, read.after);
  }
  function wordStarts(text, match, whole) {
    const starts = [];
    for (let start = text.indexOf(match); start >= 0; start = text.indexOf(match, start + 1)) {
      if (!whole || standsAsWord(text, match, start)) starts.push(start);
    }
    return starts;
  }
  // Whether `match`, found by `r`, is a saved word, covered only where it stands as one.
  const isSavedWord = (r, match) => Boolean(r.find?.fromVault) && !isVaultFormat(match);

  // Every copy of a value is hidden, except that a short one (under 16 characters) inside a longer number, like a
  // card's "123" in order "#12345", is left alone when the value also stands on its own somewhere: that copy isn't
  // the value. Only an ASCII digit beside a digit counts, as with the patterns' \d. A letter doesn't: Vietnamese,
  // Chinese or Japanese text runs words straight into numbers ("số078-05-1120"), and the value is found there all
  // the same. A long one (a token) is hidden wherever it is, and so is a value found nowhere else.
  const SHORT_VALUE = 16;
  const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";

  // A value can also be copied written another way: URL-encoded ("219%2D09%2D9999", or "%20219-09-9999" after a
  // space) in a link, a form body or a logged request, or escaped in a JSON string ("2" for "2", '\"' for '"').
  // Hide it reads the text once more with every such escape read as the character it stands for, wherever it is,
  // and hides each copy found there too; `start` and `end` map each read character back to the text as written, so
  // the whole escape goes and the rest stays exactly as it was. A form body writes a space as "+", so a value with
  // a space is looked for that way as well. This reading only finds copies of values already found, never anything new.
  const ESCAPED = /%[0-9a-f]{2}|\\[u"\\/nrt]/i;
  const JSON_UNIT = /^\\u[0-9a-f]{4}$/i;
  const JSON_ESCAPES = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t" };
  // The character an escape at `i` stands for, and its length, or null.
  function escapeAt(text, i) {
    if (text[i] === "%") {
      const decoded = percentDecoded(text, i);
      return decoded === null ? null : { ch: decoded, length: 3 };
    }
    if (text[i] !== "\\") return null;
    const unit = text.slice(i, i + 6);
    if (JSON_UNIT.test(unit)) return { ch: String.fromCharCode(parseInt(unit.slice(2), 16)), length: 6 };
    const ch = JSON_ESCAPES[text[i + 1]];
    return ch === undefined ? null : { ch, length: 2 };
  }
  function unescapedRead(text, always) {
    if (!always && !ESCAPED.test(text)) return null;
    let clean = "";
    const start = [];
    const end = [];
    for (let i = 0; i < text.length;) {
      const escape = escapeAt(text, i);
      const next = i + (escape ? escape.length : 1);
      clean += escape ? escape.ch : text[i];
      start.push(i);
      end.push(next);
      i = next;
    }
    return { clean, start, end };
  }
  const unescaped = (value) => {
    const read = unescapedRead(value);
    return read ? read.clean : value;
  };
  // The characters just before `start` and from `end` on, read through an escape that ends or starts there: the "0"
  // of "%20" is a space, not a digit the value is glued to, while "%31" is a "1". A digit just before can end any
  // escape: %XX, the same encoded again as %25XX (a link carried in a redirect= parameter), %uXXXX, a backslash's
  // \uXXXX, \UXXXXXXXX, \xXX or octal \NNN (JavaScript, Python, C), CSS's \XXXXXX, quoted-printable's =XX (raw
  // email, and a MIME "=?UTF-8?Q?...?=" subject) or an HTML &#NN with no ";". Each reads as the character it stands
  // for, so only an escape for a digit glues a copy to it; one that reads as a space or a quote never makes Hide it
  // skip a copy. Hide it fails closed: a backslash or "&#" escape it can't read for sure (a 4-digit CSS escape, an
  // HTML reference that runs on into the copy) reads as no digit, so that copy is hidden too. A "%" or "=" escape
  // always has two hex digits, so more digits after one ("50%2019", "a=2045") are plain digits.
  const ESCAPE_TAIL = /(?:%(?:25)*(u?)|\\([uUxX]?)|(=)|&#[xX]?)([0-9a-f]+)$/i;
  // What quoted-printable writes as =XX: a space, a tab or a mark, never a letter (so "id=41" stays a number), and a
  // byte of a longer character right after another =XX.
  const QP_MARK = /^[\t !-/:-@[-`{-~]$/;
  const QP_BYTE_BEFORE = /=[0-9a-f]{2}$/i;
  const UNKNOWN_ESCAPE = "";
  function readBefore(text, start) {
    const before = text[start - 1];
    if (!isDigit(before)) return before;
    const near = text.slice(Math.max(0, start - 32), start);
    const tail = ESCAPE_TAIL.exec(near);
    if (!tail) return before;
    const [escape, percentU, letter, equals, body] = tail;
    const hex = (digits) => String.fromCharCode(parseInt(digits, 16));
    if (escape[0] === "%") {
      const width = percentU ? 4 : 2;
      return body.length === width ? hex(body) : before;
    }
    if (equals) {
      if (body.length !== 2) return before;
      const ch = hex(body);
      if (QP_MARK.test(ch)) return ch;
      return ch.charCodeAt(0) >= 0x80 && QP_BYTE_BEFORE.test(near.slice(0, -3)) ? ch : before;
    }
    if (escape[0] === "&") return UNKNOWN_ESCAPE; // the browser reads on into the copy's digits
    if (letter) {
      const width = { u: 4, U: 8, x: 2, X: 2 }[letter];
      if (body.length === width) return hex(body);
      return body.length > width ? before : UNKNOWN_ESCAPE;
    }
    // A bare backslash: octal \N to \NNN, or CSS's six hex digits; seven or more end in a plain digit either way.
    if (body.length <= 3 && /^[0-7]+$/.test(body)) return String.fromCharCode(parseInt(body, 8));
    if (body.length === 6) return hex(body);
    return body.length > 6 ? before : UNKNOWN_ESCAPE;
  }
  function readAfter(text, end) {
    const escape = escapeAt(text, end);
    return escape ? escape.ch : text[end];
  }

  // Where each value starts in the text, overlapping copies included. A few values are each found with indexOf;
  // many (a pasted list of contacts) are all found in one pass over the text (Aho-Corasick), since one indexOf
  // pass per value took 18 seconds on 36,000 email addresses in 2 MB.
  function startsOf(text, values) {
    const found = new Map(values.filter(Boolean).map((s) => [s, []]));
    if (found.size <= 32) {
      for (const [s, list] of found) {
        for (let at = text.indexOf(s); at >= 0; at = text.indexOf(s, at + 1)) list.push(at);
      }
      return found;
    }
    const words = [...found.keys()];
    const lists = words.map((s) => found.get(s));
    // A trie of every value, one node per prefix: edge maps node * 65536 + a UTF-16 code unit to the next node.
    const edge = new Map();
    const parent = [0];
    const unit = [0];
    const depth = [0];
    const word = [-1]; // the value a node spells out in full, or -1
    words.forEach((s, w) => {
      let node = 0;
      for (let i = 0; i < s.length; i++) {
        const key = node * 65536 + s.charCodeAt(i);
        let next = edge.get(key);
        if (next === undefined) {
          next = parent.length;
          edge.set(key, next);
          parent.push(node);
          unit.push(s.charCodeAt(i));
          depth.push(depth[node] + 1);
          word.push(-1);
        }
        node = next;
      }
      word[node] = w;
    });
    // Each node's fallback (the longest proper suffix of its prefix that's also a prefix), shallowest nodes first,
    // and the nearest node along the fallbacks that spells out a whole value (0 for none).
    const byDepth = [];
    for (let n = 1; n < parent.length; n++) {
      if (!byDepth[depth[n]]) byDepth[depth[n]] = [];
      byDepth[depth[n]].push(n);
    }
    const fail = new Int32Array(parent.length);
    const out = new Int32Array(parent.length);
    for (const level of byDepth) {
      for (const n of level || []) {
        if (parent[n]) {
          let f = fail[parent[n]];
          let next;
          while ((next = edge.get(f * 65536 + unit[n])) === undefined && f) f = fail[f];
          fail[n] = next ?? 0;
        }
        out[n] = word[fail[n]] >= 0 ? fail[n] : out[fail[n]];
      }
    }
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let next;
      while ((next = edge.get(state * 65536 + c)) === undefined && state) state = fail[state];
      state = next ?? 0;
      for (let n = word[state] >= 0 ? state : out[state]; n; n = out[n]) lists[word[n]].push(i - depth[n] + 1);
    }
    return found;
  }
  function replaceBySpan(text, replacements) {
    const spans = [];
    const starts = startsOf(
      text,
      replacements.map((r) => r.match),
    );
    // The text read with its escapes read as characters, and each value as it reads there, plain and as a form
    // body writes it ("+" for a space).
    const plus = text.includes("+");
    const read = unescapedRead(text, plus && replacements.some((r) => / |%20/.test(r.match)));
    const readAs = new Map();
    if (read) {
      for (const { match } of replacements) {
        if (!match || readAs.has(match)) continue;
        const value = unescaped(match);
        readAs.set(match, plus && value.includes(" ") ? [value, value.replace(/ /g, "+")] : [value]);
      }
    }
    // Gathered with a loop: spreading one argument per value runs out of stack past about 125,000 values.
    const readValues = [];
    for (const list of readAs.values()) for (const value of list) readValues.push(value);
    const readStarts = read ? startsOf(read.clean, readValues) : null;
    for (const { match, replacement, clean, label, whole } of replacements) {
      if (!match) continue;
      const copies = [];
      let at = starts.get(match).map((start) => ({ start, end: start + match.length }));
      // A saved word goes only where it stands as a word, or everywhere if it stands as one nowhere: a found detail
      // is never left showing.
      if (whole) {
        const standing = at.filter(({ start }) => standsAsWord(text, match, start));
        if (standing.length) at = standing;
      }
      if (read) {
        for (const value of readAs.get(match)) {
          for (const k of readStarts.get(value)) {
            const last = k + value.length - 1;
            if (whole && insideWord(value, read.clean[k - 1], read.clean[last + 1])) continue;
            at.push({ start: read.start[k], end: read.end[last] });
          }
        }
      }
      const value = read ? readAs.get(match)[0] : match;
      const digitFirst = isDigit(value[0]);
      const digitLast = isDigit(value[value.length - 1]);
      for (const { start, end } of at) {
        const glued = (digitFirst && isDigit(readBefore(text, start))) || (digitLast && isDigit(readAfter(text, end)));
        copies.push({ start, end, glued });
      }
      const loose = match.length < SHORT_VALUE && copies.some((c) => !c.glued);
      for (const { start, end, glued } of copies) {
        if (!(loose && glued)) spans.push({ start, end, replacement, clean, label });
      }
    }
    return replaceSpans(text, spans);
  }

  // Overlapping spans become one, replaced by the longest one's replacement. A link that gets cleaned rather than
  // labeled (Clean link) is always the longest, so anything found inside it (a token, an email address in its
  // query string) is hidden first and the link cleaned after: cleaning alone keeps every parameter but the
  // trackers. When something only partly overlaps the link, the whole stretch gets the link's label.
  function replaceSpans(text, spans) {
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const span of spans) {
      const previous = merged[merged.length - 1];
      if (previous && span.start < previous.end) {
        previous.end = Math.max(previous.end, span.end);
        previous.inside.push(span);
        if (span.end - span.start > previous.top.end - previous.top.start) previous.top = span;
      } else {
        merged.push({ start: span.start, end: span.end, top: span, inside: [span] });
      }
    }
    // One pass, since slicing the whole text again for each span took seconds on a log with a token on every line.
    const parts = [];
    let at = 0;
    for (const { start, end, top, inside } of merged) {
      let replacement = top.replacement;
      if (top.clean && inside.length > 1) {
        replacement =
          start < top.start || end > top.end
            ? top.label
            : top.clean(
                replaceSpans(
                  text.slice(start, end),
                  inside.filter((s) => s !== top).map((s) => ({ ...s, start: s.start - start, end: s.end - start })),
                ),
              );
      }
      parts.push(text.slice(at, start), replacement);
      at = end;
    }
    parts.push(text.slice(at));
    return parts.join("");
  }

  // A pattern's own replace (Clean link) rides along, with the label to fall back on, for replaceSpans above.
  const cleaned = (r, match, label) =>
    r.replace ? { match, replacement: r.replace(match), clean: r.replace, label } : { match, replacement: label };

  function redact(text, results) {
    const replacements = results
      .flatMap((r) =>
        r.matches.map((match) => ({
          ...cleaned(r, match, `[REDACTED ${r.name.toUpperCase()}]`),
          whole: isSavedWord(r, match),
        })),
      )
      .sort((a, b) => b.match.length - a.match.length);
    return replaceBySpan(text, replacements);
  }

  // ---------- Generalize instead of remove ----------
  // Returns a coarser version of a detail that still helps the conversation along: a birth date keeps its
  // month and year, like "March 1948", and an address keeps just its town, like "Springfield". Returns null
  // when there's nothing safe to keep.
  const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
    ene: 1,
    abr: 4,
    ago: 8,
    dic: 12, // Spanish where it differs
  };
  const monthOf = (word) => MONTHS[word.slice(0, 3).toLowerCase()] ?? null;

  function birthMonthYear(match) {
    const iso = /\b(1[89]\d\d|20\d\d)([-/.])(\d{1,2})\2(\d{1,2})\b/.exec(match); // 1987-04-12, 1987/04/12
    if (iso) return { year: Number(iso[1]), month: Number(iso[3]) };
    const num = /\b(\d{1,2})[/.-](\d{1,2})[/.-](1[89]\d\d|20\d\d)\b/.exec(match);
    if (num) {
      const [a, b] = [Number(num[1]), Number(num[2])];
      // Day and month can only be told apart when one of them is over 12; otherwise keep just the year.
      const month = a > 12 && b <= 12 ? b : b > 12 && a <= 12 ? a : null;
      return { year: Number(num[3]), month };
    }
    const year = /\b(1[89]\d\d|20\d\d)\b/.exec(match);
    if (!year) return null;
    const word = /\b([a-záéíóú]{3,})\b/gi;
    let month = null;
    for (let m; !month && (m = word.exec(match));) month = monthOf(m[1]);
    return { year: Number(year[1]), month };
  }

  // A suite, unit or apartment part, even one lettered rather than numbered ("Suite B", "Unit Penthouse"). Words
  // that also start town names ("Flat Rock", "Ste. Genevieve") count only before a short designator ("Flat 3B").
  const UNIT_PART =
    /^(?:#|(?:apt|apartment|suite|unit|piso|puerta|depto|dpto|departamento)\b|(?:flat|floor|fl|ste|room|rm)\.?\s+\S{1,3}$)/i;

  function townOf(match) {
    const parts = match.split(",").map((p) => p.trim());
    if (parts.length < 2) return null;
    // A flat or apartment number in front of the street adds its own comma-separated part, so the town isn't
    // always parts[1]: try each part after the street and keep the first one that's left holding just a name
    // once its own trailing postcode, state or ZIP (if any) is stripped, and isn't a suite or unit.
    for (const part of parts.slice(1)) {
      if (UNIT_PART.test(part)) continue;
      const town = part
        .replace(/\s+(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)?\s*[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, "") // Canadian postal code
        .replace(/\s+\(?Qu[ée]bec\)?$/i, "") // Quebec written as the province name
        .replace(/\s+(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}$/, "") // Australian state and postcode
        .replace(/\s+[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/, "") // UK postcode
        .replace(/\s*\b\d{5}(-\d{4})?$/, "") // US ZIP
        .replace(/\s+[A-Z]{2}$/, "") // US state
        .replace(/^\d{4,5}\s+/, "") // a postal code before the town (Spain, much of Europe)
        .trim();
      if (/^[\p{L}][\p{L} .'-]{0,39}$/u.test(town)) return town;
    }
    return null;
  }

  function generalForm(patternId, match, locale = "en-US") {
    if (patternId === "date_of_birth") {
      const d = birthMonthYear(match);
      if (!d) return null;
      if (!d.month || d.month > 12) return String(d.year);
      const date = new Date(Date.UTC(d.year, d.month - 1, 15));
      return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
    }
    if (patternId === "street_address") return townOf(match);
    return null;
  }

  // The items that have a general form, for the choice that offers it.
  function generalForms(results, locale) {
    return results.flatMap((r) =>
      r.matches.map((m) => ({ id: r.id, general: generalForm(r.id, m, locale) })).filter((g) => g.general),
    );
  }

  // Like redact(), but a detail with a general form is swapped for it; the rest is hidden as before.
  function generalize(text, results, locale) {
    const replacements = results
      .flatMap((r) =>
        r.matches.map((match) => ({
          ...(r.replace
            ? cleaned(r, match, `[REDACTED ${r.name.toUpperCase()}]`)
            : { match, replacement: generalForm(r.id, match, locale) ?? `[REDACTED ${r.name.toUpperCase()}]` }),
          whole: isSavedWord(r, match),
        })),
      )
      .sort((a, b) => b.match.length - a.match.length);
    return replaceBySpan(text, replacements);
  }

  // ---------- Bandage's labels, like [Phone 1], [Me] or [born in the 1940s], in every language Clotr speaks ----------
  // content.js writes labels in the browser's language. After a reload, it reads back whatever labels a
  // conversation already has, so a new detail continues the numbering instead of restarting it, and one label
  // never ends up standing for two different details. The words themselves come from the _locales messages
  // named `bl_*`, listed in English first, and the unit tests check that the two stay in sync.
  const BANDAGE_WORDS = {
    bl_me: ["Me", "Yo"],
    bl_company: ["My company", "Mi empresa"],
    bl_family: ["Family", "Familiar"],
    bl_address: ["Address", "Dirección"],
    bl_phone: ["Phone", "Teléfono"],
    bl_email: ["Email", "Correo"],
    bl_birth: ["Birth date", "Fecha de nacimiento"],
    bl_card: ["Card", "Tarjeta"],
    bl_account: ["Account", "Cuenta"],
    bl_ip: ["IP address", "Dirección IP"],
    bl_term: ["Term", "Término"],
    bl_id: ["ID"],
  };
  const BANDAGE_BORN_IN = ["born in the $1s", "nacimiento en los años $1"];
  const BANDAGE_ALONE = new Set(["bl_me", "bl_company"]); // "[Me]", not "[Me 1]", the first time
  // Case, accents and spacing are loose: an AI may write "[telefono 2]" for "[Teléfono 2]".
  const plainWord = (w) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
  const looseWord = (w) =>
    w
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+")
      .replace(/[áéíóúñ]/g, (c) => `[${c}${plainWord(c)}]`);
  const BANDAGE_KIND = new Map(
    Object.entries(BANDAGE_WORDS).flatMap(([kind, words]) => words.map((w) => [plainWord(w), kind])),
  );
  // Matches "[word 2]", checking the longest word first so "Dirección IP" wins over "Dirección", or a decade
  // label with its year captured in a group.
  const BANDAGE_WORD_ALTS = Object.values(BANDAGE_WORDS)
    .flat()
    .sort((a, b) => b.length - a.length)
    .map(looseWord)
    .join("|");
  const BANDAGE_BORN_ALTS = BANDAGE_BORN_IN.map((t) => looseWord(t).replace("\\$1", "(\\d{4})")).join("|");
  const BANDAGE_LABEL_RE = new RegExp(
    `\\[\\s*(?:(${BANDAGE_WORD_ALTS})(?:\\s+(\\d{1,4}))?|${BANDAGE_BORN_ALTS})\\s*\\]`,
    "giu",
  );

  // A team's own kinds get covered with their own word, like "[Matter 1]". A word numbers under its own kind,
  // "team:matter", unless it's actually one of Bandage's words in any language, like "Phone" mapping to
  // "bl_phone", so one label never ends up standing for two different details.
  const bandageKindOf = (word) => BANDAGE_KIND.get(plainWord(word)) || `team:${plainWord(word)}`;
  // Matches "[word 2]" with any word up to 40 characters long, though only the words belonging to kinds set
  // through the vault actually count. The pattern itself is static, so nothing a team writes can ever change
  // what it matches. The word can't start with a space, so the spaces after "[" are only ever read one way:
  // otherwise a "[" before a long run of spaces would take time growing with the square of that run.
  const OWN_LABEL_RE = /\[\s*([^[\]\d\s][^[\]\d\n]{0,39}?)\s+(\d{1,4})\s*\]/gu;
  let coverKinds = { list: null, words: new Map() }; // the cover words of the kinds set with the vault, read once
  function teamCovers() {
    const list = globalThis.Clotr.vaultKinds?.() || [];
    if (coverKinds.list !== list) {
      const words = new Map();
      for (const k of list) {
        const kind = bandageKindOf(k.cover);
        if (kind.startsWith("team:")) words.set(plainWord(k.cover), kind);
      }
      coverKinds = { list, words };
    }
    return coverKinds.words;
  }

  // Finds every Bandage label in `text` and returns { label (as written), index, kind (the bl_* key), n, id }.
  // `id` stays the same for one label across any language or case, so "[Phone 2]" and "[teléfono 2]" both
  // become "bl_phone 2". This makes one pass over the text for the built-in words, plus one more for a team's
  // own cover words when there are any.
  function readBandageLabels(text) {
    const out = [];
    if (!text || !text.includes("[")) return out;
    const covers = teamCovers();
    if (covers.size) {
      OWN_LABEL_RE.lastIndex = 0;
      for (let m = OWN_LABEL_RE.exec(text); m; m = OWN_LABEL_RE.exec(text)) {
        const kind = covers.get(plainWord(m[1].trim()));
        const n = Number(m[2]);
        if (kind && n) out.push({ label: m[0], index: m.index, kind, n, id: `${kind} ${n}` });
      }
    }
    BANDAGE_LABEL_RE.lastIndex = 0;
    for (let m = BANDAGE_LABEL_RE.exec(text); m; m = BANDAGE_LABEL_RE.exec(text)) {
      const decade = m.slice(3).find(Boolean);
      if (decade) {
        out.push({ label: m[0], index: m.index, kind: "bl_bornIn", n: 0, id: `bl_bornIn ${decade}` });
        continue;
      }
      const kind = BANDAGE_KIND.get(plainWord(m[1]));
      const n = m[2] ? Number(m[2]) : BANDAGE_ALONE.has(kind) ? 1 : 0;
      if (kind && n) out.push({ label: m[0], index: m.index, kind, n, id: `${kind} ${n}` });
    }
    return covers.size ? out.sort((a, b) => a.index - b.index) : out;
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
  };
})();

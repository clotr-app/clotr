// The cleaned copy of a text that the rules read, mapped back to what was typed, and the limits one check
// runs under. The detect and respond files use these.
(() => {
  "use strict";

  // ---------- Severity and how long one check may run ----------
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

  // A private key's BEGIN line with no END line after it, so only part of the key is here. PEM_END_SHAPE tests for
  // an END line, and PEM_END finds each one.
  function partialPem(value) {
    const begin = PEM_BEGIN.exec(value);
    return begin && !PEM_END_SHAPE.test(value) && value.length > begin[0].length ? begin[0] : null;
  }

  // ---------- Text as copied from web pages, documents and chat apps ----------
  // Invisible characters, exotic spaces and dashes, and full-width or other-script digits could hide a leak, so the
  // patterns run against a cleaned copy instead. `start` and `end` map each cleaned character back to the original
  // text, so a match is reported, and redacted, the way the person actually typed it. Look-alike letters from other
  // alphabets stay as they are, since mapping them would mangle real Russian or Greek text. A keycap emoji like
  // 4\ufe0f\u20e3 is its digit with an invisible mark and a keycap frame (U+20E3) after it, so the frame goes too.
  const SOFT_HYPHEN_AND_SCRIPT_MARKS = String.raw`\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f`;
  const ZERO_WIDTH_AND_DIRECTION = String.raw`\u200b-\u200f\u202a-\u202e\u2060-\u206f`;
  const KEYCAP_FILLERS_AND_SELECTORS = String.raw`\u20e3\u3164\ufe00-\ufe0f\ufeff\uffa0`;
  const INVISIBLE = new RegExp(
    // eslint-disable-next-line no-misleading-character-class -- each invisible mark is matched on its own, on purpose
    `[${SOFT_HYPHEN_AND_SCRIPT_MARKS}${ZERO_WIDTH_AND_DIRECTION}${KEYCAP_FILLERS_AND_SELECTORS}]`,
  );
  const SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
  const DASH = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/;
  // A phone keyboard types curly quotes and apostrophes, so "driver’s license" matches "driver's license" either way.
  const QUOTE = /[‘’‚‛ʼ]/;
  const DOUBLE_QUOTE = /[“-‟]/;
  const ASCII = /^[\x20-\x7e]+$/;
  const DIGIT = /\p{Nd}/u;

  function digitValue(codePoint) {
    let zero = codePoint; // the start of this run of decimal digits, which count up from 0 to 9 in order
    while (zero > 0 && DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    return String((codePoint - zero) % 10);
  }

  // ---------- URL encoding and Markdown escapes ----------
  // A secret can hide URL-encoded (%2F, %20, %0A), so inside a link a printable character, tab or line break
  // written as %XX reads as itself. Outside a link only %40 reads as "@" (ann%40gmail.com), since some keys hold "%3D".
  const PERCENT = /%[0-9a-f]{2}/i;
  const URL_END = /[\s"'`<>]/;
  const HEX_PAIR = /^[0-9a-f]{2}$/i;
  const ENCODED_SCHEME_END = /^%3A%2F%2F/i;
  // A request line's target ("GET /pay?card=4539%201488... HTTP/1.1") reads as a link, wherever the line sits.
  const REQUEST_LINE = /(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) +(?=[^\s"'`<>])/y;
  const REQUEST_LEAD = /[\s"'`>([]/; // what can sit just before a request line's method
  const TOKEN = /[^\s"'`<>]*/y;
  // A form or query on its own ("card=4539%201488...&cvv=123", "[ssn=...") reads as a link from its first key.
  // A key whose "%3D" comes before a number starts one too ("ssn%3D219%2D09%2D9999").
  const FORM_KEY = /[A-Za-z_][\w.[\]-]*(?:=|%3D(?=\d|%28|%2B))/iy;
  const KEY_CHAR = /[\w.[\]-]/;
  // In a form, %3D, %26 and %25 stay as written, so a key's own "%3D" is kept.
  const FORM_KEEPS = /^(?:3D|26|25)$/i;
  // A "%3D" before a number is a nested form's "=" ("data=card%3D4539%201488...").
  const NESTED_VALUE = /^(?:\d|%28|%2B)/i;
  // A link inside another link is encoded twice: "%2520" reads as the character "20" stands for.
  const NESTED_ESCAPE = /(?:25)*[0-9a-f]{2}/iy;
  // A form writes a space as "+", so "card=4539+1488+0343+6467" reads with spaces. A value with letters keeps its
  // "+", since base64 has them.
  const PLUS_HINT = /=[^\s"'`<>&;#,=]*\+/;
  const PLUS_VALUE = /(?:[\d().-]|%[0-9a-f]{2})+(?:\+(?:[\d().-]|%[0-9a-f]{2})+)+(?=[\s"'`<>&;#,]|$)/iy;
  // Where the last %XX of the token from `from` to `to` starts, or -1.
  function lastEscapeIn(text, from, to) {
    for (let at = to - 3; at >= from; at--) {
      if (text.charCodeAt(at) === 37 && HEX_PAIR.test(text.slice(at + 1, at + 3))) return at;
    }
    return -1;
  }
  // The character the %XX at i stands for when it's printable ASCII, a tab or a line break, or null.
  function percentDecoded(text, i) {
    const hex = text.slice(i + 1, i + 3);
    if (!HEX_PAIR.test(hex)) return null;
    const code = parseInt(hex, 16);
    const printable = code >= 0x20 && code <= 0x7e;
    return printable || code === 9 || code === 10 || code === 13 ? String.fromCharCode(code) : null;
  }
  // A URL's user:password@ part keeps its encoding: there %40 is how a user name like Azure's user@server is
  // written, and the "@" it would become, or a space from %20, would end the user name or password early.
  const URL_USERINFO = /[^\s@/?#:]{1,256}:[^\s@/]{1,512}@/y;
  // Markdown escapes "_" as "\_", which would break every key with an underscore in it, so a "\_" right after a
  // letter or digit reads as "_". So does one after a run of "." and "-" that follows a letter or digit, since a
  // token like a JWT can hold "_" beside them ("a.\_b", "a-\_b"). After a space or other mark it stays as written.
  const isWordCode = (code) =>
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
  function escapesWordUnderscore(text, i) {
    let before = i - 1;
    // Back past the "." and "-" run.
    while (before > 0 && (text.charCodeAt(before) === 45 || text.charCodeAt(before) === 46)) before--;
    return isWordCode(text.charCodeAt(before));
  }

  // ---------- The cleaned copy ----------
  // `link` is for a window of a large paste that starts inside a link (linkAt): the window reads it as the paste
  // read from its start would, though it never sees the link's "://".
  function cleanText(text, link) {
    // Plain ASCII with no URL encoding (like ann%40gmail.com from a pasted link) and no escapes needs no cleaning.
    const alreadyClean =
      !/[^\x00-\x7f]/.test(text) &&
      !PERCENT.test(text) &&
      !text.includes("\\n") &&
      !text.includes("\\r\\n") &&
      !text.includes("\\_") &&
      !(text.includes("+") && PLUS_HINT.test(text));
    if (alreadyClean) return { clean: text, start: null, end: null, jsonBreaks: null };
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
      const codePoint = text.codePointAt(i);
      const character = String.fromCodePoint(codePoint);
      let next = i + character.length;
      let out = character;
      // How many characters a JSON string's \n or \r\n escape takes here, or 0.
      const jsonBreak =
        jsonString &&
        !jsonEscape &&
        character === "\\" &&
        (text[i + 1] === "n" ? 2 : text.slice(i + 1, i + 4) === "r\\n" ? 4 : 0);
      // "D" to "P": the first letter of DELETE, GET, HEAD, OPTIONS, PATCH, POST or PUT.
      if (codePoint >= 68 && codePoint <= 80 && (i === 0 || REQUEST_LEAD.test(text[i - 1]))) {
        REQUEST_LINE.lastIndex = i;
        if (REQUEST_LINE.test(text)) requestTarget = REQUEST_LINE.lastIndex;
      }
      if (URL_END.test(character)) {
        inForm = false;
      } else {
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
      } else if (character === ":" && text.charCodeAt(i + 1) === 47 && text.charCodeAt(i + 2) === 47) {
        inUrl = true;
        URL_USERINFO.lastIndex = i + 3;
        if (URL_USERINFO.test(text)) userinfoEnd = URL_USERINFO.lastIndex - 1;
      } else if (character === "%" && ENCODED_SCHEME_END.test(text.slice(i, i + 9))) {
        inUrl = true; // a link encoded whole, as a redirect= parameter carries one: its "://" is "%3A%2F%2F"
      } else if (inUrl && URL_END.test(character)) {
        inUrl = false;
      }
      const hex = character === "%" ? text.slice(i + 1, i + 3) : "";
      const formDecodes =
        inForm &&
        (!FORM_KEEPS.test(hex) ||
          (/^3D$/i.test(hex) &&
            i > 0 &&
            isWordCode(text.charCodeAt(i - 1)) &&
            NESTED_VALUE.test(text.slice(i + 3, i + 6))));
      let decoded =
        character === "%" && i >= userinfoEnd && (inUrl || /^40/.test(hex) || formDecodes)
          ? percentDecoded(text, i)
          : null;
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
      if (plus && (character === "=" || decoded === "=") && i > 0 && KEY_CHAR.test(text[i - 1])) {
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
      } else if (character === "\\" && text.charCodeAt(i + 1) === 95 && i > 0 && escapesWordUnderscore(text, i)) {
        out = ""; // Markdown's "\_"; the "_" itself is read next
      } else if (character === "+" && i < plusUntil) {
        out = " "; // a form's space, between numbers
      } else if (codePoint >= 0x80) {
        if (INVISIBLE.test(character)) out = "";
        else if (SPACE.test(character)) out = " ";
        else if (DASH.test(character)) out = "-";
        else if (QUOTE.test(character)) out = "'";
        else if (DOUBLE_QUOTE.test(character)) out = '"';
        else if (DIGIT.test(character)) out = digitValue(codePoint);
        else {
          const plain = character.normalize("NFKC"); // full-width letters like Ａ or ＠ become plain ASCII
          if (ASCII.test(plain)) out = plain;
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
        else if (character === "\\") jsonEscape = true;
        else if (character === '"') jsonString = false;
      } else if (character === '"') {
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

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
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
    percentDecoded,
    cleanText,
    linkAt,
  };
})();

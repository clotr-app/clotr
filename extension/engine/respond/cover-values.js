// Hide it: every copy of a found value, as written or behind an escape, covered with a label. redact() and
// replaceBySpan() are what pages, apps and generalize.js call.
(() => {
  "use strict";

  const { isVaultFormat, utf8At } = globalThis.Clotr;
  const { percentDecoded, cleanText, isAsciiHex, isAsciiWord, wordChar, edgeInside, insideWord, lastLetter } =
    globalThis.ClotrInternal;

  // ---------- Reading an edge through cleaning and escapes ----------
  // An edge is read as written and as cleaned (cleanText): a JSON "\n" is a line break, a link's "%20" a space.
  // The last text cleanedAround read and its cleaned form: one text, kept until a different one comes in.
  let cleanedRead = { text: null };
  // The characters just before and after text.slice(start, end) in the cleaned text, or null if nothing was cleaned.
  function cleanedAround(text, start, end) {
    if (cleanedRead.text !== text) cleanedRead = { text, ...cleanText(text) };
    // A host hands in a new copy of the same text each call, and === reads two copies letter by letter. Keeping
    // this copy makes the next look in it a quick same-object check rather than one more read of the whole text.
    else cleanedRead.text = text;
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
  // The character just before `start`, read through an escape ending there as vault/vault-unescape.js reads it: "\n",
  // "\r", "\t" or "%20" is a space, "é" is "é", and a link's escapes read as UTF-8 ("%C3%A9" is "é"). Bytes that make
  // no letter stay hex digits. A mark with no letter before it belongs to no word.
  const ESCAPED_BEFORE = /(?:\\u([0-9a-fA-F]{4})|\\[nrt]|((?:%[0-9a-fA-F]{2}){1,4}))$/;
  function charBefore(text, start) {
    // Every escape ESCAPED_BEFORE reads ends in a hex digit or n, r or t, so any other ASCII character is itself.
    const code = text.charCodeAt(start - 1);
    if (code < 128 && !isAsciiHex(code) && code !== 110 && code !== 114 && code !== 116) return text[start - 1];
    // Step back over marks to the letter they're written on.
    let at = start;
    let piece;
    for (;;) {
      piece = escapedBefore(text, at);
      if (!piece || !/^\p{M}$/u.test(piece.char)) break;
      at -= piece.length;
    }
    if (at === start || !piece) return piece?.char;
    return wordChar(piece.char) ? piece.char : " ";
  }
  // The character ending at `at` as { char, length } (how many characters it's written with), or undefined at the
  // start of the text.
  function escapedBefore(text, at) {
    if (at <= 0) return undefined;
    const m = ESCAPED_BEFORE.exec(text.slice(Math.max(0, at - 12), at));
    if (!m) {
      const pair = at >= 2 && /^[\ud800-\udbff][\udc00-\udfff]$/.test(text.slice(at - 2, at));
      return pair ? { char: text.slice(at - 2, at), length: 2 } : { char: text[at - 1], length: 1 };
    }
    if (!m[2]) return { char: m[1] ? String.fromCharCode(parseInt(m[1], 16)) : " ", length: m[0].length };
    // The last character of the run of percent escapes: its last byte and the continuation bytes before it.
    const bytes = m[2].match(/%../g).map((byte) => parseInt(byte.slice(1), 16));
    let first = bytes.length - 1;
    while (first > 0 && bytes.length - first < 4 && bytes[first] >= 0x80 && bytes[first] < 0xc0) first--;
    // Read by arithmetic (utf8At in vault/vault-unescape.js), not by catching what decodeURIComponent throws: bytes
    // that make no one character stay as written.
    const decoded = utf8At(bytes, first);
    if (decoded && first + decoded.size === bytes.length) return { char: decoded.char, length: decoded.size * 3 };
    return { char: "a", length: 3 };
  }
  // Whether the copy of `match` at `start` stands as a word, in the text as written or as cleaned. An escape just
  // before it is read only through charBefore, since cleaning keeps it as written ("%A9" would end in a digit).
  // An edge that is a plain letter or digit outside any escape reads the same in the cleaned text, so a copy inside a
  // longer word there ("Annabelle") is settled without cleaning the whole text.
  function standsAsWord(text, match, start) {
    const end = start + match.length;
    const before = charBefore(text, start);
    const atStart = edgeInside(match[0], before);
    const atEnd = edgeInside(lastLetter(match), text[end]);
    if (!atStart && !atEnd) return true;
    const escaped = before !== text[start - 1] && before !== text.slice(start - 2, start);
    // An edge cleaning can't change settles it now.
    if (atEnd && keptByCleaning(text, end)) return false;
    if (atStart && (escaped || keptByCleaning(text, start - 1))) return false;
    const read = cleanedAround(text, start, end);
    return Boolean(read) && !insideWord(match, escaped ? before : read.before, read.after);
  }
  // Whether cleanText leaves text[at] as it is, at the same place: an ASCII letter or digit that no escape reaches.
  // Cleaning reads only "%" and "\" escapes as more than one character ("%41", "%2541", "\n", "\r\n"), written in hex
  // digits, n and r after them, so one reaches `at` only through a run of those back to its "%" or "\". A run longer
  // than a few characters isn't followed, and the edge is read the long way.
  function keptByCleaning(text, at) {
    if (!isAsciiWord(text.charCodeAt(at))) return false;
    for (let i = at; i >= Math.max(0, at - 8); i--) {
      const code = text.charCodeAt(i);
      if (code === 37 || code === 92) return false; // "%" or "\\"
      if (!isAsciiHex(code) && code !== 110 && code !== 114) return true; // n, r
    }
    return at <= 8;
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

  // ---------- Short values inside longer numbers ----------
  // A short value (under 16 characters) inside a longer number, like a card code's "123" in order "#12345", is left
  // alone when the value also stands on its own somewhere. Only an ASCII digit beside it counts: Vietnamese or
  // Chinese text runs words into numbers ("số078-05-1120"). A long value, or one found nowhere else, always goes.
  const SHORT_VALUE = 16;
  const isDigit = (char) => char !== undefined && char >= "0" && char <= "9";

  // ---------- Copies written with escapes ----------
  // A copy can be written with escapes: URL-encoded ("219%2D09%2D9999", "%20219-09-9999") or escaped in JSON. Hide it
  // reads the text again with each escape as its character and hides each copy there too, whole escape included.
  // A form writes a space as "+", so a value with a space is looked for that way too. It never finds anything new.
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
  // `start` and `end` map each read character back to the text as written.
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
  function readAnotherPercentLayer(read) {
    let clean = "";
    const start = [];
    const end = [];
    for (let i = 0; i < read.clean.length;) {
      const decoded = read.clean[i] === "%" ? percentDecoded(read.clean, i) : null;
      const next = i + (decoded === null ? 1 : 3);
      clean += decoded ?? read.clean[i];
      start.push(read.start[i]);
      end.push(read.end[next - 1]);
      i = next;
    }
    return { clean, start, end };
  }
  const unescaped = (value) => {
    const read = unescapedRead(value);
    return read ? read.clean : value;
  };
  // The characters just before `start` and from `end` on, read through an escape that ends or starts there: the "0"
  // of "%20" is a space, not a digit the value is glued to, while "%31" is a "1". Only an escape for a digit glues.
  // Escapes read: %XX (and %25XX, encoded again), %uXXXX, \uXXXX, \UXXXXXXXX, \xXX, octal \NNN, CSS \XXXXXX,
  // quoted-printable =XX (and "=?UTF-8?Q?...?=") and HTML &#NN with no ";". A "%" or "=" escape has two hex digits,
  // so more digits after one ("50%2019", "a=2045") are plain digits.
  const ESCAPE_TAIL = /(?:%(?:25)*(u?)|\\([uUxX]?)|(=)|&#[xX]?)([0-9a-f]+)$/i;
  // What quoted-printable writes as =XX: a space, a tab or a mark, never a letter (so "id=41" stays a number), and a
  // byte of a longer character right after another =XX.
  const QP_MARK = /^[\t !-/:-@[-`{-~]$/;
  const QP_BYTE_BEFORE = /=[0-9a-f]{2}$/i;
  // Fails closed: an escape it can't read for sure (a 4-digit CSS one, an HTML one running into the copy) is no digit.
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
      const char = hex(body);
      if (QP_MARK.test(char)) return char;
      return char.charCodeAt(0) >= 0x80 && QP_BYTE_BEFORE.test(near.slice(0, -3)) ? char : before;
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

  // ---------- Finding every copy ----------
  // Where each value starts in the text, overlapping copies included. A few values are each found with indexOf;
  // many (a pasted list of contacts) are all found in one pass over the text (Aho-Corasick), since one indexOf
  // pass per value would take 18 seconds on 36,000 email addresses in 2 MB.
  function startsOf(text, values) {
    const found = new Map(values.filter(Boolean).map((value) => [value, []]));
    if (found.size <= 32) {
      for (const [value, list] of found) {
        for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) list.push(at);
      }
      return found;
    }
    const words = [...found.keys()];
    const lists = words.map((value) => found.get(value));
    // A trie of every value, one node per prefix: edge maps node * 65536 + a UTF-16 code unit to the next node.
    const edge = new Map();
    const parent = [0];
    const unit = [0];
    const depth = [0];
    const word = [-1]; // the value a node spells out in full, or -1
    words.forEach((value, index) => {
      let node = 0;
      for (let i = 0; i < value.length; i++) {
        const key = node * 65536 + value.charCodeAt(i);
        let next = edge.get(key);
        if (next === undefined) {
          next = parent.length;
          edge.set(key, next);
          parent.push(node);
          unit.push(value.charCodeAt(i));
          depth.push(depth[node] + 1);
          word.push(-1);
        }
        node = next;
      }
      word[node] = index;
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
      const code = text.charCodeAt(i);
      let next;
      while ((next = edge.get(state * 65536 + code)) === undefined && state) state = fail[state];
      state = next ?? 0;
      for (let n = word[state] >= 0 ? state : out[state]; n; n = out[n]) lists[word[n]].push(i - depth[n] + 1);
    }
    return found;
  }
  function replaceBySpan(text, replacements) {
    const spans = [];
    const starts = startsOf(
      text,
      replacements.map((each) => each.match),
    );
    // The text read with its escapes read as characters, and each value as it reads there, plain and as a form
    // body writes it ("+" for a space).
    const plus = text.includes("+");
    const read = unescapedRead(text, plus && replacements.some((each) => / |%20/.test(each.match)));
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
    // A link inside a link is encoded again each time (%2541, %252541), so up to 3 more layers are read.
    const layers = [];
    for (let layer = read; layer && layers.length < 3 && /%[0-9a-f]{2}/i.test(layer.clean);) {
      layer = readAnotherPercentLayer(layer);
      layers.push({ read: layer, starts: startsOf(layer.clean, readValues) });
    }
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
          for (const readAt of readStarts.get(value)) {
            const last = readAt + value.length - 1;
            // Its left edge is read as standsAsWord reads it, so a letter written as percent escapes ("Jos%C3%A9Ann")
            // still makes a longer word, where this reading sees only the escape's last hex digit.
            if (whole && insideWord(value, charBefore(text, read.start[readAt]), read.clean[last + 1])) continue;
            at.push({ start: read.start[readAt], end: read.end[last] });
          }
        }
      }
      for (const { read: nestedRead, starts: nestedStarts } of layers) {
        for (const value of readAs.get(match)) {
          for (const readAt of nestedStarts.get(value)) {
            const last = readAt + value.length - 1;
            if (whole && insideWord(value, charBefore(text, nestedRead.start[readAt]), nestedRead.clean[last + 1])) {
              continue;
            }
            at.push({ start: nestedRead.start[readAt], end: nestedRead.end[last] });
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
      const loose = match.length < SHORT_VALUE && copies.some((copy) => !copy.glued);
      for (const { start, end, glued } of copies) {
        if (!(loose && glued)) spans.push({ start, end, replacement, clean, label });
      }
    }
    return replaceSpans(text, spans);
  }

  // ---------- Replacing the spans ----------
  // Overlapping spans become one, with the longest one's replacement. A cleaned link is always the longest, so what's
  // inside it (a token, an email in its query) is hidden first, then the link cleaned. A partial overlap gets the
  // link's label over the whole stretch.
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
    // One pass, since slicing the whole text again for each span would take seconds on a log with a token per line.
    const parts = [];
    let at = 0;
    for (const { start, end, top, inside } of merged) {
      let replacement = top.replacement;
      // Partly over the link, the whole stretch gets its label. Inside it, the rest are hidden first and the link
      // cleaned after.
      if (top.clean && inside.length > 1 && (start < top.start || end > top.end)) replacement = top.label;
      else if (top.clean && inside.length > 1) {
        const others = inside
          .filter((span) => span !== top)
          .map((span) => ({ ...span, start: span.start - start, end: span.end - start }));
        replacement = top.clean(replaceSpans(text.slice(start, end), others));
      }
      parts.push(text.slice(at, start), replacement);
      at = end;
    }
    parts.push(text.slice(at));
    return parts.join("");
  }

  // A pattern's own replace (Clean link) rides along, with the label to fall back on, for replaceSpans above.
  const cleaned = (result, match, label) =>
    result.replace
      ? { match, replacement: result.replace(match), clean: result.replace, label }
      : { match, replacement: label };

  // Hide it replaces each finding with a label naming its kind ("[REDACTED PHONE NUMBER]"), or a pattern's own
  // `replace(match)` (Clean link cleans a link instead). Findings can overlap, so their spans merge first.
  // A saved vault word is hidden only where it stands as its own word ("Ann", not inside "Annabelle"), its edges read
  // as detect() reads them. Every other kind goes everywhere it appears (but for the short-value rule above).
  function redact(text, results) {
    const replacements = results
      .flatMap((result) =>
        result.matches.map((match) => ({
          ...cleaned(result, match, `[REDACTED ${result.name.toUpperCase()}]`),
          whole: isSavedWord(result, match),
        })),
      )
      .sort((a, b) => b.match.length - a.match.length);
    return replaceBySpan(text, replacements);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, wordStarts, isSavedWord, replaceBySpan, cleaned, redact };
})();

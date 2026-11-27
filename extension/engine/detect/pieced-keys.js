// A key typed in pieces, joined back up, and what a second reading finds that the first missed.
// detect.js uses these for every window it reads.
(() => {
  "use strict";

  const { PATTERNS, isPlaceholder } = globalThis.Clotr;
  const { KEY_START, LABEL_KINDS } = globalThis.ClotrInternal;

  // ---------- A key typed in pieces ----------
  // A key read out in groups ("AKIA 4HPQ 7XZ2 …"), one character at a time, or split into quoted pieces that code
  // joins ("sk-…" + "…") reads joined up, but only when the pieces make exactly one provider's key ("sk-learn is …"
  // stays prose). Hand-typed groups are one size with a shorter last one, which keeps the next word out.
  const KEY_PREFIXES = KEY_START.source.slice(4, -1);
  // A piece that starts a key of its own starts a new run ("old key AKIA… new key AKIA 4HPQ …").
  const NOT_A_KEY_START = `(?!(?:${KEY_PREFIXES}))`;
  // A key's prefix and the rest of its first piece.
  const KEY_HEAD = `(?<![\\w.-])(?:${KEY_PREFIXES})[\\w.-]*`;
  // Where one quoted piece closes and the next opens: "sk-…" + "…", on the same line or the next.
  const QUOTE = `["'\`]`;
  const PLUS = `(?:\\+[ \\t]*)?`;
  const LINE_BREAK = `(?:\\\\?\\r?\\n[ \\t]*${PLUS})?`;
  const BETWEEN_PIECES = `${QUOTE}[ \\t]*${PLUS}${LINE_BREAK}${QUOTE}`;
  const SPACED_KEY_RE = new RegExp(`${KEY_HEAD}(?:[ \\t]{1,3}${NOT_A_KEY_START}[\\w.-]+){1,48}`, "g");
  const QUOTED_PIECES_RE = new RegExp(`${KEY_HEAD}(?:${BETWEEN_PIECES}${NOT_A_KEY_START}[\\w.-]+){1,16}`, "g");
  // One character at a time the run can't stop at a prefix, which is spelled out too, so a run is cut where each
  // prefix starts inside it instead: "step 2 A K I A …", or two keys spelled out one after the other.
  const SPELLED_KEY_RE = /(?<![\w.-])(?:[\w.-][ \t]){15,119}[\w.-]\.?(?![\w.-])/g;
  const KEY_PREFIX_ANYWHERE = new RegExp(KEY_PREFIXES, "g");
  const PIECE_RE = /[\w.-]+/g;
  // How many characters one window checks against every kind of key, and how many ways of ending each run it tries.
  // Only text that could be a key costs any of it, so a report that says "ASIA" or "sk-learn" on every line doesn't
  // use it up. A key spelled out has no group size to stop at, so its last few pieces each get a try.
  const MAX_PIECED_CHARS = 32768;
  const SPACED_ENDINGS = 4;
  const keyLikePiece = (piece) => piece.length >= 8 && /\d/.test(piece) && /[A-Za-z]/.test(piece);
  function piecedKeys(clean) {
    const kinds = [];
    for (const [index, pattern] of PATTERNS.entries()) {
      if (!pattern.secret || pattern.group !== "credentials" || LABEL_KINDS.has(pattern.id)) continue;
      kinds.push({ index, pattern });
    }
    // Which kind the text is, exactly and whole, or null. A key's random part mixes at least two of capitals, small
    // letters and digits, which words in capitals ("ASIA ZONE WIDE SALE DATA") or in small letters don't. An AWS key
    // id's 16 are capitals and the digits 2 to 7 (base32), so a year ("ASIA 2025 TOUR DATE LIST") isn't one.
    let checked = 0;
    const keyKind = (joined) => {
      const lead = KEY_START.exec(joined);
      if (!lead) return null;
      const body = joined.slice(lead[0].length);
      if ([/[A-Z]/, /[a-z]/, /\d/].filter((re) => re.test(body)).length < 2) return null;
      if (/^A[KS]IA$/.test(lead[0]) && !/^[A-Z2-7]{16}$/.test(body)) return null;
      if (checked >= MAX_PIECED_CHARS || isPlaceholder(joined)) return null;
      checked += joined.length;
      for (const kind of kinds) {
        const { pattern } = kind;
        const found = pattern.find ? pattern.find(joined) : joined.match(pattern.regex) || [];
        if (found.includes(joined) && (!pattern.validate || pattern.validate(joined))) return kind;
      }
      return null;
    };
    const found = [];
    // Reads pieces `from` to `to` of a run and says whether it found a key. `offs` says where each piece starts in
    // the joined text, and `mixes` how many of capitals, small letters and digits a stretch holds. Under two, no key
    // fits, in that stretch or any shorter one inside it, so that check comes first.
    const readPieces = (run, from, to, shape) => {
      const { pieces, offs, text, mixes } = run;
      const count = to - from;
      if (count < 2) return false;
      const start = offs[from];
      const lead = KEY_START.exec(text.slice(start, offs[to]));
      if (!lead) return false;
      const bodyStart = start + lead[0].length;
      if (mixes(bodyStart, offs[to]) < 2) return false;
      // Hand-typed groups: the longest run of same-size groups after the first piece, and one shorter after it.
      let longest = count;
      if (shape === "spaced") {
        const size = pieces[from + 1].text.length;
        let k = 2;
        while (k < count && pieces[from + k].text.length === size) k++;
        longest = k < count && pieces[from + k].text.replace(/\.+$/, "").length <= size ? k + 1 : k;
      }
      const shortest = shape === "quoted" ? 2 : Math.max(2, longest - SPACED_ENDINGS + 1);
      for (let k = longest; k >= shortest; k--) {
        const last = pieces[from + k - 1];
        const end = offs[from + k];
        for (const dots of [0, (/\.+$/.exec(last.text) || [""])[0].length]) {
          if (dots && dots === last.text.length) continue;
          if (mixes(bodyStart, end - dots) < 2) continue;
          const key = text.slice(start, end - dots);
          const kind = keyKind(key);
          if (!kind) continue;
          const rest = pieces.slice(from + 1, from + k);
          if (rest.some((piece) => KEY_START.test(piece.text))) continue;
          // A whole key already in the first piece takes only key-like pieces after it, not the next word.
          if (keyKind(pieces[from].text) === kind && !rest.every((piece) => keyLikePiece(piece.text))) continue;
          found.push({ index: kind.index, match: key, from: pieces[from].at, to: last.at + last.text.length - dots });
          return true;
        }
      }
      return false;
    };
    const readRun = (m, shape) => {
      const pieces = [];
      const offs = [0];
      let text = "";
      for (const piece of m[0].matchAll(PIECE_RE)) {
        pieces.push({ text: piece[0], at: m.index + piece.index });
        text += piece[0];
        offs.push(text.length);
      }
      // How many capitals, small letters and digits come before each place in the joined text.
      const upper = new Int32Array(text.length + 1);
      const lower = new Int32Array(text.length + 1);
      const digit = new Int32Array(text.length + 1);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        upper[i + 1] = upper[i] + (code >= 65 && code <= 90 ? 1 : 0);
        lower[i + 1] = lower[i] + (code >= 97 && code <= 122 ? 1 : 0);
        digit[i + 1] = digit[i] + (code >= 48 && code <= 57 ? 1 : 0);
      }
      const mixes = (a, b) => (b <= a ? 0 : (upper[b] > upper[a]) + (lower[b] > lower[a]) + (digit[b] > digit[a]));
      const run = { pieces, offs, text, mixes };
      if (shape !== "spelled") {
        readPieces(run, 0, pieces.length, shape);
        return;
      }
      // Spelled out, each piece is one character, so where a prefix starts in the joined text is that piece. Each
      // prefix is read up to the next one, and if that isn't a key, on to the end of the run.
      const starts = [];
      KEY_PREFIX_ANYWHERE.lastIndex = 0;
      for (let prefix = KEY_PREFIX_ANYWHERE.exec(text); prefix; prefix = KEY_PREFIX_ANYWHERE.exec(text)) {
        if (prefix.index < pieces.length - 1) starts.push(prefix.index);
        KEY_PREFIX_ANYWHERE.lastIndex = prefix.index + 1;
      }
      for (let i = 0; i < starts.length; i++) {
        const next = i + 1 < starts.length ? starts[i + 1] : pieces.length;
        if (readPieces(run, starts[i], next, shape)) continue;
        if (next < pieces.length) readPieces(run, starts[i], pieces.length, shape);
      }
    };
    const readAll = (re, shape) => {
      for (const m of clean.matchAll(re)) {
        if (checked >= MAX_PIECED_CHARS) break;
        readRun(m, shape);
      }
    };
    readAll(SPACED_KEY_RE, "spaced");
    if (/["'`]/.test(clean)) readAll(QUOTED_PIECES_RE, "quoted");
    readAll(SPELLED_KEY_RE, "spelled");
    return found;
  }

  // ---------- What a second reading adds ----------
  // Returns what the second reading found that the first missed, as the page wrote it, or null. It skips a match
  // the first caught with its dot ("7 Willow Dr."), one starting with the next sentence's first word (unless it has
  // a digit, like "October 3"), and one that still holds a dot the reading turned into a space.
  function addedByReading(match, firstFound, reading) {
    const lead = /^\p{L}+/u.exec(match)?.[0];
    const asWritten = lead && reading.lowered.has(lead) ? match[0].toUpperCase() + match.slice(1) : match;
    if (firstFound.has(asWritten) || firstFound.has(`${asWritten}.`)) return null;
    // Two spaces or a space at the end is one of the dots the reading turned into a space.
    if (/ {2}| $/.test(match)) return null;
    return reading.firstWords.has(lead) && !/\p{N}/u.test(match) ? null : asWritten;
  }

  // A copy of detect()'s results, their match lists, `asks` and `reasonOf` included, so detect() can hand out its
  // last answer again without a caller's changes reaching it.
  const copyResults = (results) =>
    results.map((result) => ({
      ...result,
      matches: [...result.matches],
      ...(result.asks ? { asks: [...result.asks] } : {}),
      ...(result.reasonOf ? { reasonOf: new Map(result.reasonOf) } : {}),
    }));

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, piecedKeys, addedByReading, copyResults };
})();

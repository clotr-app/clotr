// Reading a text with its escapes undone (JSON, links, HTML, UTF-8 shown as Windows-1252), so a saved word
// written behind one is still found. The vault and Hide it use these.
(() => {
  "use strict";

  // ---------- Escapes, entities and bytes ----------

  // ── Undoing escapes before matching ──
  // The text as a JSON string or a link reads once its escapes are undone: "\u00e9" is "é", "%C3%A9" is "é", "%20" a
  // space, and a written "\n", "\r" or "\t" a space. Each character keeps where it was written (from, to), so a saved
  // word found in it is hidden as written. HTML and XML read the same way: an entity is the character it stands for
  // ("&nbsp;", "&#39;", "&eacute;"; an unknown one stays as written), and a tag is a space, so a name split by one
  // ("<b>Ann</b> Smith") is found too. UTF-8 read as Windows-1252, as a spreadsheet shows a CSV, reads as meant
  // ("JosÃ©" is "José"); a lone "Ã" before a small letter is an "í" whose second byte, a soft hyphen, was taken out
  // ("GarcÃa"). Null when the text has none of them.

  // What Windows-1252 shows for the bytes 0x80 to 0x9f.
  const CP1252 =
    "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
    "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
  // A UTF-8 byte after the first, as it shows when read as Latin-1 (0x80 to 0xbf) or as Windows-1252.
  const FOLLOW_ON_BYTE =
    String.raw`\u0080-\u00bf\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d` +
    String.raw`\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178`;
  const ESCAPE = new RegExp(
    [
      String.raw`\\u[0-9a-fA-F]{4}`,
      String.raw`\\[nrt]`,
      String.raw`(?:%[0-9a-fA-F]{2})+`,
      String.raw`&#[0-9]{1,7};`,
      String.raw`&#[xX][0-9a-fA-F]{1,6};`,
      String.raw`&[A-Za-z]{2,8};`,
      String.raw`<[/]?[A-Za-z][^<>]{0,256}>`,
      String.raw`[\u00c2-\u00f4][${FOLLOW_ON_BYTE}]{1,3}`,
      String.raw`\u00c3(?=[a-z])`,
    ].join("|"),
    "g",
  );

  const ENTITY = {
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    thinsp: " ",
    amp: "&",
    apos: "'",
    quot: '"',
    lt: "<",
    gt: ">",
    lsquo: "'",
    rsquo: "'",
    ldquo: '"',
    rdquo: '"',
    ndash: "-",
    mdash: "-",
    shy: "",
    szlig: "ß",
    aelig: "æ",
    AElig: "Æ",
    oelig: "œ",
    OElig: "Œ",
    oslash: "ø",
    Oslash: "Ø",
    eth: "ð",
    ETH: "Ð",
    thorn: "þ",
    THORN: "Þ",
  };

  // "&eacute;" and the like: a letter and the mark it names.
  const ENTITY_MARK = {
    acute: 0x301,
    grave: 0x300,
    circ: 0x302,
    uml: 0x308,
    tilde: 0x303,
    cedil: 0x327,
    ring: 0x30a,
    caron: 0x30c,
  };
  // ── HTML entities and UTF-8 bytes ──
  function decodeHtmlEntity(entity) {
    const body = entity.slice(1, -1);
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (codePoint > 0 && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(ENTITY, body)) return ENTITY[body];
    const marked = /^([A-Za-z])(acute|grave|circ|uml|tilde|cedil|ring|caron)$/.exec(body);
    if (!marked) return null;
    return (marked[1] + String.fromCharCode(ENTITY_MARK[marked[2]])).normalize("NFC");
  }

  // The character the UTF-8 `bytes` hold from `byteOffset` on, with how many bytes it takes ({ char, size }), or null
  // where they make none (a byte out of place, too few, an overlong form or a surrogate). Worked out by arithmetic,
  // since throwing and catching an error for each of 100,000 stray "%C3" in a paste is slow.
  function utf8At(bytes, byteOffset) {
    const firstByte = bytes[byteOffset];
    if (firstByte < 0x80) return { char: String.fromCharCode(firstByte), size: 1 };

    let size = 0;
    if (firstByte >= 0xc2 && firstByte <= 0xdf) size = 2;
    else if (firstByte >= 0xe0 && firstByte <= 0xef) size = 3;
    else if (firstByte >= 0xf0 && firstByte <= 0xf4) size = 4;
    if (!size || byteOffset + size > bytes.length) return null;

    let codePointMask = 0x07;
    if (size === 2) codePointMask = 0x1f;
    else if (size === 3) codePointMask = 0x0f;
    let codePoint = firstByte & codePointMask;
    for (let continuationOffset = 1; continuationOffset < size; continuationOffset++) {
      const continuationByte = bytes[byteOffset + continuationOffset];
      if ((continuationByte & 0xc0) !== 0x80) return null;
      codePoint = (codePoint << 6) | (continuationByte & 0x3f);
    }
    if (size === 3 && codePoint < 0x800) return null;
    if (size === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff)) return null;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    return { char: String.fromCodePoint(codePoint), size };
  }

  // ---------- The unescaped view ----------

  // ── Reading escapes before cleaning ──
  // The view of `text`, or, given `source` (the text as written that cleanText made `text` of, with where each of its
  // characters came from), of the text as written. Cleaning folds the very characters most UTF-8 bytes read as
  // Windows-1252 show as (a superscript 3 to "3", a curly quote to a straight one, an ellipsis to "..."), so a
  // misread "López" is read before it's cleaned. Everything outside an escape is the cleaned text, so the view's
  // places are always places in `text`. `changed` counts, up to each place in the view, how many characters an escape
  // was read into, so a phrase with none in or beside it, already looked up in `text`, needn't be again (changedNear).
  function unescapedView(text, source) {
    const raw = source ? source.text : text;
    ESCAPE.lastIndex = 0;
    const containsEscape = ESCAPE.test(raw);
    ESCAPE.lastIndex = 0; // matchAll starts where the last search stopped
    if (!containsEscape) return null;
    // Where each character of the text as written starts in `text` (the first cleaned character at or after it).
    let cleanOffsetAtRaw = null;
    if (source) {
      cleanOffsetAtRaw = new Int32Array(raw.length + 1).fill(text.length);
      for (let cleanIndex = text.length - 1; cleanIndex >= 0; cleanIndex--) {
        cleanOffsetAtRaw[source.start[cleanIndex]] = cleanIndex;
      }
      for (let rawIndex = raw.length - 1; rawIndex >= 0; rawIndex--) {
        if (cleanOffsetAtRaw[rawIndex + 1] < cleanOffsetAtRaw[rawIndex]) {
          cleanOffsetAtRaw[rawIndex] = cleanOffsetAtRaw[rawIndex + 1];
        }
      }
    }
    const cleanOffsetForRaw = (rawOffset) => (cleanOffsetAtRaw ? cleanOffsetAtRaw[rawOffset] : rawOffset);
    const decodedCharacters = [];
    const fromOffsets = [];
    const toOffsets = [];
    const escapeCounts = [0];
    let decodedCharacterCount = 0;

    // `decodedText`, read from the text as written between `rawStart` and `rawEnd`.
    function keep(decodedText, rawStart, rawEnd) {
      for (let characterIndex = 0; characterIndex < decodedText.length; characterIndex++) {
        decodedCharacters.push(decodedText[characterIndex]);
        fromOffsets.push(cleanOffsetForRaw(rawStart));
        toOffsets.push(cleanOffsetForRaw(rawEnd));
        escapeCounts.push(++decodedCharacterCount);
      }
    }
    // The text from `rawStart` to `rawEnd` as it is in `text`.
    function asIs(rawStart, rawEnd) {
      const cleanStart = cleanOffsetForRaw(rawStart);
      const cleanEnd = cleanOffsetForRaw(rawEnd);
      for (let cleanIndex = cleanStart; cleanIndex < cleanEnd; cleanIndex++) {
        decodedCharacters.push(text[cleanIndex]);
        fromOffsets.push(cleanIndex);
        toOffsets.push(cleanIndex + 1);
        escapeCounts.push(decodedCharacterCount);
      }
    }

    let rawOffset = 0;
    let decodedEscapeCount = 0;
    for (const match of raw.matchAll(ESCAPE)) {
      asIs(rawOffset, match.index);
      rawOffset = match.index + match[0].length;
      if (match[0][0] === "\\") {
        let decodedText = " ";
        if (match[0][1] === "u") decodedText = String.fromCharCode(parseInt(match[0].slice(2), 16));
        keep(decodedText, match.index, rawOffset);
        decodedEscapeCount++;
        continue;
      }
      if (match[0][0] === "<") {
        keep(" ", match.index, rawOffset);
        decodedEscapeCount++;
        continue;
      }
      if (match[0][0] === "&") {
        const decodedEntity = decodeHtmlEntity(match[0]);
        if (decodedEntity === null) {
          asIs(match.index, rawOffset);
          continue;
        }
        keep(decodedEntity, match.index, rawOffset);
        decodedEscapeCount++;
        continue;
      }
      if (match[0] === "\u00c3") {
        keep("\u00ed", match.index, rawOffset);
        decodedEscapeCount++;
        continue;
      }
      // Percent escapes, or UTF-8 bytes shown one by one as Windows-1252 letters, read as UTF-8 a character at a
      // time; bytes that don't make one stay as written.
      const isPercentEscape = match[0][0] === "%";
      const escapeWidth = isPercentEscape ? 3 : 1;
      const bytes = [];
      for (let matchOffset = 0; matchOffset < match[0].length; matchOffset += escapeWidth) {
        const characterCode = match[0].charCodeAt(matchOffset);
        if (isPercentEscape) bytes.push(parseInt(match[0].slice(matchOffset + 1, matchOffset + 3), 16));
        else if (characterCode < 0x100) bytes.push(characterCode);
        else bytes.push(0x80 + CP1252.indexOf(match[0][matchOffset]));
      }
      for (let byteOffset = 0; byteOffset < bytes.length;) {
        const rawStart = match.index + byteOffset * escapeWidth;
        const decodedCharacter = utf8At(bytes, byteOffset);
        if (decodedCharacter === null) {
          asIs(rawStart, rawStart + escapeWidth);
          byteOffset++;
          continue;
        }
        keep(decodedCharacter.char, rawStart, rawStart + decodedCharacter.size * escapeWidth);
        decodedEscapeCount++;
        byteOffset += decodedCharacter.size;
      }
    }
    asIs(rawOffset, raw.length);
    if (!decodedEscapeCount) return null;
    return { text: decodedCharacters.join(""), from: fromOffsets, to: toOffsets, changed: escapeCounts };
  }

  // Whether an escape was read into the view anywhere from `start - NEAR` to `end + NEAR`: a phrase farther from
  // every one reads as it does in the text, where it was looked up already.
  const NEAR = 4;
  function changedNear(view, start, end) {
    const nearStart = Math.max(0, start - NEAR);
    const nearEnd = Math.min(view.text.length, end + NEAR);
    return view.changed[nearEnd] !== view.changed[nearStart];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, utf8At, unescapedView, changedNear };
})();

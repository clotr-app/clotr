"use strict";
/* global require, module, Buffer */

const { TextDecoder } = require("util");

// Control characters that plain text doesn't hold; tab, the line breaks and ESC (for colored logs) are left out.
const NOT_TEXT = /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\ufffe\uffff]/;
// A zero byte, any other control character but tab and the line breaks, or U+FFFD, which a UTF-8 reading puts where a
// byte isn't UTF-8. The engine reads a word just before one as a value, so in text read loosely each is a space.
const STRAY = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\ufffd-\uffff]/g;
// What mostlyText counts as broken, a zero byte aside.
const BROKEN_CHARACTER = /[\u0001-\u0008\u000e-\u001a\u001c-\u001f\ufffd-\uffff]/;

// The file's text, or undefined when its bytes aren't text. Windows tools write UTF-16, some without a byte order
// mark, and older ones a single-byte code page; a UTF-16 .env holds the same keys, so all of those are read as text.
function decodeText(bytes, partial) {
  return readText(bytes, partial).text;
}

// decodeText's text, and whether every byte was read as text (`whole`).
function readText(bytes, partial) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return readUtf16(bytes, 2, partial);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return readUtf16(bytes, 2, partial, true);
  if (bytes.includes(0)) return looksLikeUtf16(bytes) ? readUtf16(bytes, 0, partial) : {};
  for (let trim = 0; trim <= (partial ? 3 : 0); trim += 1) {
    try {
      // A partial UTF-8 character at the end of the checked prefix can be left for the next read.
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim)),
        whole: true,
      };
    } catch {
      // Not UTF-8, or not with this many bytes trimmed.
    }
  }
  // Anything left is a single-byte code page, where every byte is a character, unless it carries control bytes.
  const text = bytes.toString("latin1");
  return NOT_TEXT.test(text) ? {} : { text, whole: true };
}

// A UTF-16 file's text from `start`, with its other reading after it so a key in either is found. A line in another
// encoding added after the UTF-16 can leave the bytes short of UTF-16 (an odd length, or letters UTF-16 can't hold).
// Then the UTF-16 is read up to its last code unit with a zero byte, and the rest is left to the other reading. The
// file is read in full only when that rest is UTF-8 and no UTF-16 after such a line is out of step.
function readUtf16(bytes, start, partial, bigEndian = false) {
  // decodeUtf16 swaps big-endian bytes in place, so it gets a copy of them.
  const body = () => (bigEndian ? Buffer.from(bytes.subarray(start)) : bytes.subarray(start));
  const other = otherReading(bytes);
  const shifted = shiftedLetters(bytes.subarray(start), bigEndian);
  let text = decodeUtf16(body(), partial, bigEndian);
  let whole = !shifted;
  if (text === undefined) {
    const end = utf16End(bytes.subarray(start));
    // With no UTF-16 before the cut, there's nothing to read as UTF-16.
    text = end ? decodeUtf16(body().subarray(0, end), partial, bigEndian) : undefined;
    whole = whole && isUtf8(bytes.subarray(start + end));
  }
  if (text === undefined) return other.text && other.clean ? { text: other.text, whole: false } : {};
  return { text: [text, other.text, shifted].filter(Boolean).join("\n"), whole };
}

// Where the UTF-16 in `body` ends: after its last code unit with a zero byte. A UTF-8 line holds none.
function utf16End(body) {
  for (let end = body.length - (body.length % 2); end > 0; end -= 2) {
    if (body[end - 1] === 0 || body[end - 2] === 0) return end;
  }
  return 0;
}

function isUtf8(bytes) {
  try {
    return !NOT_TEXT.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

// What a UTF-16 reading turns into other letters: the bytes read as UTF-8, less the runs of UTF-16 (a letter beside
// a zero byte) that reading already holds. A line added to a UTF-16 file by a tool that writes UTF-8 (Windows
// PowerShell 5.1's `>` writes UTF-16, then `cmd /c echo ... >>`, Node or Python add UTF-8) is only readable here.
// UTF-16 letters outside ASCII read as UTF-8 too, as made-up letters the engine would only read a second time, so
// only lines that end at a UTF-8 line break or the file's start or end are kept, as a line a tool added does.
// `clean` says it has no control characters, which a file read only this way mustn't have.
function otherReading(bytes) {
  const pieces = new TextDecoder("utf-8").decode(bytes).split(/(?:[^\0]\0)+|(?:\0[^\0])+/);
  const text = pieces
    .map((piece, index) => {
      const lines = piece.split("\n");
      return lines
        .map((line, at) => utf8Part(line, at > 0 || index === 0, at < lines.length - 1 || index === pieces.length - 1))
        .join("\n");
    })
    .join("\n")
    .replace(STRAY, " ");
  const clean = !pieces.some((piece) => NOT_TEXT.test(piece.replace(/\0/g, "")));
  return { text: /\S/.test(text) ? text : "", clean };
}

// The part of a line in the other reading that could be UTF-8. A line between two runs of UTF-16 is UTF-16 letters,
// and so is a line with a broken byte every character or two, though a UTF-8 line can be joined to its start or end.
function utf8Part(line, afterBreak, beforeBreak) {
  if (!afterBreak && !beforeBreak) return "";
  const first = line.search(BROKEN_CHARACTER);
  if (first < 0 || mostlyText(line)) return line;
  let last = line.length - 1;
  while (!BROKEN_CHARACTER.test(line[last])) last -= 1;
  return `${afterBreak ? line.slice(0, first) : ""}\n${beforeBreak ? line.slice(last + 1) : ""}`;
}

// The ASCII letters of UTF-16 a byte out of step with the file's own, as after a UTF-8 line with an odd number of
// bytes, which the UTF-16 reading turns into other letters: a letter and a zero byte the other way round. A character
// whose low byte is zero (一, the ideographic space, the box-drawing ─) reads that way too, so only runs of four or more
// count, and not one that is one letter over and over between its first and last, as a line of ─ or a row of
// ideographic spaces is, with a byte of the character on either side. Text a byte out of step is a mix of letters.
function shiftedLetters(body, bigEndian) {
  const runs = [];
  let run = "";
  const keep = () => {
    if (run.length >= 4 && !/^[^]([^])\1+[^]$/.test(run)) runs.push(run);
    run = "";
  };
  for (let index = 1; index + 1 < body.length; index += 2) {
    const letter = body[bigEndian ? index + 1 : index];
    if (letter !== 0 && body[bigEndian ? index : index + 1] === 0) {
      run += String.fromCharCode(letter);
      continue;
    }
    keep();
  }
  keep();
  return runs.join("\n");
}

// UTF-16LE without a byte order mark is mostly ASCII, so most code units have a zero high byte and a nonzero low one.
function looksLikeUtf16(bytes) {
  let ascii = 0;
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    if (bytes[index] !== 0 && bytes[index + 1] === 0) ascii += 1;
  }
  return ascii >= 0.75 * Math.floor(bytes.length / 2) && ascii > 0;
}

function decodeUtf16(bytes, partial, bigEndian = false) {
  let usable = bytes;
  if (bytes.length % 2) {
    if (!partial) return undefined;
    usable = usable.subarray(0, usable.length - 1);
  }
  if (bigEndian) usable.swap16();
  // The first half of a surrogate pair cut at the cap is left for the next read.
  if (partial && usable.length >= 2 && (usable.readUInt16LE(usable.length - 2) & 0xfc00) === 0xd800) {
    usable = usable.subarray(0, usable.length - 2);
  }
  try {
    const text = new TextDecoder("utf-16le", { fatal: true }).decode(usable);
    return NOT_TEXT.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

// A file's text read loosely, as UTF-8 with its zero bytes, control bytes and bytes that aren't UTF-8 as spaces. A run
// of four or more letters each beside one zero byte is UTF-16, like the few lines Windows PowerShell 5.1's `>>` adds to
// a UTF-8 log, so it's read without its zero bytes. As spaces they'd set its digits a space apart, which the engine
// takes for a phone number.
function looseText(bytes) {
  const latin1 = bytes.toString("latin1");
  let text = "";
  let from = 0;
  for (const run of latin1.matchAll(/\0?[^\0](?:\0[^\0]){3,}\0?/g)) {
    text += bytes.subarray(from, run.index).toString("utf8") + run[0].replace(/\0/g, "");
    from = run.index + run[0].length;
  }
  return (text + bytes.subarray(from).toString("utf8")).replace(STRAY, " ");
}

// Whether the zero bytes fall almost all on one side of each byte pair, on at least one pair in eight: UTF-16 that
// looksLikeUtf16 can't vouch for, like Hindi or big-endian text without a byte order mark. Read as UTF-8 its digits
// come out a space apart, which the engine takes for phone numbers.
function utf16Shaped(bytes) {
  const zeros = zeroCounts(bytes);
  const [fewer, more] = zeros[0] < zeros[1] ? zeros : [zeros[1], zeros[0]];
  return more * 16 >= bytes.length && fewer * 10 <= more;
}

// How many zero bytes sit at even and at odd offsets.
function zeroCounts(bytes) {
  const zeros = [0, 0];
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0) zeros[index % 2] += 1;
  return zeros;
}

// A file without a byte order mark read the way a file with one is: its UTF-16 from the start, and its other reading
// after it. It's for UTF-16 that looksLikeUtf16 can't vouch for: big-endian, mostly letters outside ASCII (Hindi,
// Japanese, whose few zero bytes are its spaces and digits), or with UTF-8 lines added. Its zero bytes have to sit
// almost all on one side of each byte pair, and an even offset means big-endian.
function readUnmarkedUtf16(bytes) {
  const zeros = zeroCounts(bytes);
  const [fewer, more] = zeros[0] < zeros[1] ? zeros : [zeros[1], zeros[0]];
  if (!more || fewer * 10 > more) return {};
  const bigEndian = zeros[0] > zeros[1];
  if (!asciiBesideZeros(bytes, bigEndian)) return linesInBinary(bytes);
  return readUtf16(bytes, 0, false, bigEndian);
}

// The text lines in 16-bit binary data, like a key line added after a WAV's samples, or none. Most such files hold no
// line of 16 letters or more that ends at a line break or the file's end, so they're given up on without reading them
// as UTF-8. The blank lines the samples make are left out: the engine took a third of a second on them in a 1 MiB WAV.
function linesInBinary(bytes) {
  if (!/[\t\x20-\x7e]{16}(?:\r?\n|$)/.test(bytes.toString("latin1"))) return {};
  const other = otherReading(bytes);
  const text = other.clean ? other.text.split("\n").filter((line) => /\S/.test(line)) : [];
  return text.length ? { text: text.join("\n"), whole: false } : {};
}

// Whether three in four of the byte pairs with a zero byte on the UTF-16 side are ASCII text: a printable letter, a
// tab or a line break. In UTF-16 they're its ASCII letters, spaces and digits. In 16-bit audio or pixels they're
// small samples, mostly control bytes or a zero byte too, or bright pixels, mostly bytes above ASCII.
function asciiBesideZeros(bytes, bigEndian) {
  let pairs = 0;
  let ascii = 0;
  for (let index = bigEndian ? 0 : 1; index < bytes.length; index += 2) {
    if (bytes[index] !== 0) continue;
    const letter = bytes[bigEndian ? index + 1 : index - 1];
    if (letter === undefined) continue;
    pairs += 1;
    if ((letter >= 0x20 && letter <= 0x7e) || letter === 9 || letter === 10 || letter === 13) ascii += 1;
  }
  return ascii * 4 >= pairs * 3;
}

// Whether at most one character in ten, NULs aside, is a control character or a byte that isn't UTF-8. A compressed
// or compiled file read as UTF-8 is mostly those, and loose patterns would only find things that aren't there.
function mostlyText(text) {
  let characters = 0;
  let broken = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) continue;
    characters += 1;
    // BROKEN_CHARACTER's range, one code at a time.
    if ((code < 0x20 && ![9, 10, 11, 12, 13, 27].includes(code)) || code >= 0xfffd) broken += 1;
  }
  return characters > 0 && broken * 10 <= characters;
}

module.exports = {
  NOT_TEXT,
  STRAY,
  BROKEN_CHARACTER,
  decodeText,
  readText,
  readUtf16,
  utf16End,
  isUtf8,
  otherReading,
  utf8Part,
  shiftedLetters,
  looksLikeUtf16,
  decodeUtf16,
  looseText,
  utf16Shaped,
  readUnmarkedUtf16,
  mostlyText,
};

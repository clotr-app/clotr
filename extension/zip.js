// Look back's streaming zip and JSON readers. It's a classic script with no DOM and no chrome.* calls, so the
// same code runs in the extension's worker and in Node for the tests.
//
// A "source" is anything with a byte `size`, an async `slice(start, end)` and a `stream(start, end)`. `fromFile()`
// wraps a File or a Blob, and `fromBytes()` wraps bytes already sitting in memory, which is what the tests and
// small picked files use. This reader doesn't trust a zip's own sizes, and it never writes anything: it only
// compares entry names rather than using them as paths, so a hostile name like "../x" can't do any damage. The
// unpack-ratio cap further down stops a zip bomb.
(() => {
  "use strict";

  const EOCD64_LOCATOR_SIG = 0x07064b50;
  const EOCD64_SIG = 0x06064b50;
  const CENTRAL_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;
  const MAX_EOCD_TAIL = 65557; // the 22-byte end record plus the biggest comment it can carry
  const MAX_CENTRAL_DIR = 64 * 1024 * 1024;
  const MAX_ENTRIES = 200000;
  const ENCRYPTED_FLAG = 0x0001;

  function zipError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  // ---------- Sources: anything Clotr can read a zip from ----------

  // Wraps a File or a Blob (works in a worker, a page, and Node 18+, which has a global Blob).
  function fromFile(file) {
    return {
      size: file.size,
      async slice(start, end) {
        const from = Math.max(0, start);
        const to = Math.max(from, Math.min(file.size, end));
        return new Uint8Array(await file.slice(from, to).arrayBuffer());
      },
      stream(start, end) {
        const from = Math.max(0, start);
        const to = Math.max(from, Math.min(file.size, end));
        return file.slice(from, to).stream();
      },
    };
  }

  // Wraps bytes already in memory (the tests, and a small file read whole).
  function fromBytes(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return fromFile(new Blob([buf]));
  }

  // ---------- Reading bytes as little-endian numbers ----------
  const u16 = (v, at) => v.getUint16(at, true);
  const u32 = (v, at) => v.getUint32(at, true);
  // A big archive's 64-bit sizes and offsets, converted to a plain Number. That's safe here because the caps
  // above always reject a value big enough to lose precision before this reader ever acts on it.
  const u64 = (v, at) => Number(v.getBigUint64(at, true));

  // ---------- The end of central directory, and the entries it points to ----------

  // Reads the ZIP64 extra field that replaces a central-directory entry's plain sizes and offset (APPNOTE 4.5.3).
  // Only the fields that were 0xFFFFFFFF in the main header show up here, always in the same order.
  function readZip64Extra(extra, want) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    let p = 0;
    while (p + 4 <= extra.length) {
      const tag = u16(view, p);
      const len = u16(view, p + 2);
      if (p + 4 + len > extra.length) break;
      if (tag === 0x0001) {
        let q = p + 4;
        const out = {};
        if (want.size && q + 8 <= p + 4 + len) {
          out.size = u64(view, q);
          q += 8;
        }
        if (want.csize && q + 8 <= p + 4 + len) {
          out.csize = u64(view, q);
          q += 8;
        }
        if (want.at && q + 8 <= p + 4 + len) out.at = u64(view, q);
        return out;
      }
      p += 4 + len;
    }
    return {};
  }

  function parseCentralDirectory(buf, maxEntries) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const decoder = new TextDecoder();
    const entries = [];
    let p = 0;
    while (p + 46 <= buf.length && entries.length < maxEntries) {
      if (u32(view, p) !== CENTRAL_SIG) break;
      const method = u16(view, p + 10);
      let csize = u32(view, p + 20);
      let size = u32(view, p + 24);
      const nameLen = u16(view, p + 28);
      const extraLen = u16(view, p + 30);
      const commentLen = u16(view, p + 32);
      const flags = u16(view, p + 8);
      let at = u32(view, p + 42);
      const nameStart = p + 46;
      if (nameStart + nameLen + extraLen + commentLen > buf.length) break;
      const name = decoder.decode(buf.subarray(nameStart, nameStart + nameLen));
      const extraStart = nameStart + nameLen;
      const extra = buf.subarray(extraStart, extraStart + extraLen);
      const want = { size: size === 0xffffffff, csize: csize === 0xffffffff, at: at === 0xffffffff };
      if (want.size || want.csize || want.at) {
        const z64 = readZip64Extra(extra, want);
        if (z64.size !== undefined) size = z64.size;
        if (z64.csize !== undefined) csize = z64.csize;
        if (z64.at !== undefined) at = z64.at;
      }
      entries.push({ name, method, csize, size, at, encrypted: (flags & ENCRYPTED_FLAG) !== 0 });
      p = extraStart + extraLen + commentLen;
    }
    return entries;
  }

  // Reads the end-of-central-directory record, and for a big archive the ZIP64 locator and record just before
  // it (APPNOTE 4.3.14-15). Then it reads the central directory itself and lists every entry, without ever
  // touching an entry's own data.
  async function openZip(source, opts = {}) {
    const maxEntries = opts.maxEntries || MAX_ENTRIES;
    const maxCentralDir = opts.maxCentralDir || MAX_CENTRAL_DIR;
    if (source.size < 22) throw zipError("no-eocd", "Too small to be a zip");
    const tailLen = Math.min(source.size, MAX_EOCD_TAIL);
    const tail = await source.slice(source.size - tailLen, source.size);
    const eocdOffInTail = tail.lastIndexOf(0x50) >= 0 ? findLast(tail, [0x50, 0x4b, 0x05, 0x06]) : -1;
    if (eocdOffInTail < 0 || eocdOffInTail + 22 > tail.length) throw zipError("no-eocd", "No end of central directory");
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let entryCount = u16(view, eocdOffInTail + 10);
    let cdSize = u32(view, eocdOffInTail + 12);
    let cdOffset = u32(view, eocdOffInTail + 16);
    const eocdAbs = source.size - tailLen + eocdOffInTail;

    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAbs = eocdAbs - 20;
      if (locAbs < 0) throw zipError("bad-zip64", "ZIP64 locator missing");
      const loc = await source.slice(locAbs, locAbs + 20);
      const lv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
      if (loc.length < 20 || u32(lv, 0) !== EOCD64_LOCATOR_SIG) throw zipError("bad-zip64", "ZIP64 locator missing");
      const z64Abs = u64(lv, 8);
      const z64 = await source.slice(z64Abs, Math.min(z64Abs + 56, source.size));
      const zv = new DataView(z64.buffer, z64.byteOffset, z64.byteLength);
      if (z64.length < 56 || u32(zv, 0) !== EOCD64_SIG) throw zipError("bad-zip64", "ZIP64 record missing");
      entryCount = u64(zv, 32);
      cdSize = u64(zv, 40);
      cdOffset = u64(zv, 48);
    }
    if (entryCount > maxEntries) throw zipError("too-many-entries", "Clotr can't read this export yet");
    if (cdSize > maxCentralDir) throw zipError("central-directory-too-large", "Clotr can't read this export yet");
    const central = await source.slice(cdOffset, cdOffset + cdSize);
    const entries = parseCentralDirectory(central, maxEntries);
    return { entries };
  }

  // The last offset in `buf` (a Uint8Array) where `bytes` (a small plain array) occurs, or -1 if it never does.
  function findLast(buf, bytes) {
    outer: for (let i = buf.length - bytes.length; i >= 0; i--) {
      for (let j = 0; j < bytes.length; j++) if (buf[i + j] !== bytes[j]) continue outer;
      return i;
    }
    return -1;
  }

  // ---------- Reading one entry's data ----------

  async function localHeader(source, entry) {
    const head = await source.slice(entry.at, entry.at + 30);
    if (head.length < 30) throw zipError("truncated", "This file looks damaged or incomplete");
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (u32(view, 0) !== LOCAL_SIG) throw zipError("truncated", "This file looks damaged or incomplete");
    const nameLen = u16(view, 26);
    const extraLen = u16(view, 28);
    return { dataStart: entry.at + 30 + nameLen + extraLen };
  }

  // Streams one entry's decompressed bytes as Uint8Array chunks, never the whole entry at once. Stored data
  // comes back as is, method 8 goes through the browser's own DecompressionStream, and anything else (including
  // an encrypted entry) can't be read. If the bytes coming out ever pass `ratio` times the bytes packed in,
  // plus `extra`, this throws an unpack-limit error instead of letting a zip bomb unpack. The defaults are the
  // real 64x-plus-64MB cap; the tests shrink them so a bomb test doesn't need to hold 64MB.
  async function* entryStream(source, entry, { ratio = 64, extra = 64 * 1024 * 1024 } = {}) {
    if (entry.encrypted) throw zipError("cant-read", "Clotr can't read this file");
    if (entry.method !== 0 && entry.method !== 8) throw zipError("cant-read", "Clotr can't read this file");
    const { dataStart } = await localHeader(source, entry);
    const raw = source.stream(dataStart, dataStart + entry.csize);
    const out = entry.method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw")) : raw;
    const cap = entry.csize * ratio + extra;
    const reader = out.getReader();
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        total += value.length;
        if (total > cap) {
          reader.cancel().catch(() => {});
          throw zipError("unpack-limit", "One file unpacks to far more than its size");
        }
        yield value;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released by cancel() above */
      }
    }
  }

  // Reads a whole entry, decompressed, into one Uint8Array. This is for small files like a picture. `cap`
  // bounds memory on top of the zip-bomb check above: reading just stops at `cap` bytes rather than throwing,
  // since a caller like a picture's head only wants the first part of the file anyway. `ratio` and `extra`
  // pass straight through to entryStream()'s own zip-bomb check.
  async function entryBytes(source, entry, { cap = Infinity, ratio, extra } = {}) {
    const chunks = [];
    let total = 0;
    for await (const chunk of entryStream(source, entry, { ratio, extra })) {
      const room = cap - total;
      if (room <= 0) break;
      chunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
      total += Math.min(chunk.length, room);
      if (total >= cap) break;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  // ---------- Scanning a top-level JSON array, one item at a time, without holding the whole file ----------

  const WS = new Set([" ", "\t", "\n", "\r"]);

  // Reads every item out of a top-level JSON array, one at a time, without ever holding the whole document in
  // memory. An export's top level can also be an object with a "conversations" array instead of a bare array,
  // and I handle both. `chunks` is an async iterable of Uint8Array or string pieces, such as what entryStream()
  // yields. Each item under `cap` characters comes out as `{ text }`; a bigger one comes out as
  // `{ text: null, tooBig: true, prefix }`, where `prefix` is just the first `cap` characters, usually enough to
  // find a title. Reading stops as soon as the target array closes, and a document that isn't a top-level array
  // or object yields nothing at all.
  async function* jsonItems(chunks, { cap = Infinity } = {}) {
    const decoder = new TextDecoder();
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    let mode = null; // "array" | "object" | "none"
    let targetDepth = null;
    let keyState = "none"; // "none" | "afterString" | "afterColon"
    let candidateIsKey = false;
    let keyBuf = "";
    let itemActive = false;
    let itemBuf = "";
    let itemTooBig = false;
    let done = false;

    function* flushItem() {
      if (itemActive) yield itemTooBig ? { text: null, tooBig: true, prefix: itemBuf } : { text: itemBuf };
      itemActive = false;
      itemBuf = "";
      itemTooBig = false;
    }

    for await (const chunk of chunks) {
      if (done) break;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      for (let i = 0; i < text.length && !done; i++) {
        const c = text[i];
        const preDepth = depth;
        const wasInString = inString;

        if (!started) {
          if (WS.has(c)) continue;
          started = true;
          if (c === "[") {
            mode = "array";
            targetDepth = 1;
          } else if (c === "{") {
            mode = "object";
          } else {
            done = true;
            break;
          }
        }

        // Watching for "conversations": at depth 1 of a top-level object, before the target array is found.
        if (mode === "object" && targetDepth === null && !wasInString) {
          if (keyState === "afterString") {
            if (!WS.has(c)) keyState = c === ":" ? "afterColon" : "none";
          } else if (keyState === "afterColon") {
            if (!WS.has(c)) {
              if (c === "[" && candidateIsKey) targetDepth = preDepth + 1;
              keyState = "none";
            }
          }
        }

        // The generic string/escape/bracket tracking every character goes through.
        if (wasInString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') {
            inString = false;
            if (mode === "object" && targetDepth === null && preDepth === 1) {
              candidateIsKey = keyBuf === "conversations";
              keyState = "afterString";
            }
          } else if (mode === "object" && targetDepth === null && preDepth === 1 && keyBuf.length < 32) {
            keyBuf += c;
          }
        } else if (c === '"') {
          inString = true;
          keyBuf = "";
        } else if (c === "[" || c === "{") {
          depth++;
        } else if (c === "]" || c === "}") {
          if (targetDepth !== null && preDepth === targetDepth && c === "]") {
            yield* flushItem();
            done = true;
          }
          depth--;
        }

        // Capturing the target array's items, once it's been found.
        if (!done && targetDepth !== null && preDepth >= targetDepth) {
          const structuralComma = !wasInString && preDepth === targetDepth && c === ",";
          if (structuralComma) yield* flushItem();
          else if (!wasInString && WS.has(c) && preDepth === targetDepth) {
            /* whitespace outside a string, right at the item boundary: before an item starts or after it ends */
          } else {
            if (!itemActive) itemActive = true;
            if (itemBuf.length < cap) itemBuf += c;
            else itemTooBig = true;
          }
        }
      }
    }
  }

  // ---------- Scanning a .jsonl file, one line at a time ----------

  // Reads each non-blank line of a newline-delimited JSON file, yielding the same `{ text }` or
  // `{ text: null, tooBig: true, prefix }` shape as jsonItems() so a caller can treat either kind the same way.
  // A line never grows past `cap` characters while it's being built, so even a hostile file with no newlines at
  // all still reads in bounded memory.
  async function* jsonlItems(chunks, { cap = Infinity } = {}) {
    const decoder = new TextDecoder();
    let line = "";
    let tooBig = false;
    let any = false;
    function* flush() {
      const value = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (any && value.trim()) yield tooBig ? { text: null, tooBig: true, prefix: value } : { text: value };
      line = "";
      tooBig = false;
      any = false;
    }
    for await (const chunk of chunks) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        const piece = nl < 0 ? text.slice(start) : text.slice(start, nl);
        if (piece) {
          any = true;
          if (!tooBig) {
            const room = cap - line.length;
            if (piece.length > room) {
              line += piece.slice(0, Math.max(0, room));
              tooBig = true;
            } else line += piece;
          }
        }
        if (nl < 0) break;
        yield* flush();
        start = nl + 1;
      }
    }
    yield* flush();
  }

  Object.assign(globalThis.Clotr, {
    zipError,
    fromFile,
    fromBytes,
    openZip,
    entryStream,
    entryBytes,
    jsonItems,
    jsonlItems,
  });
})();

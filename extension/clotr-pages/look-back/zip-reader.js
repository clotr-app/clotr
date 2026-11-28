// Look back's streaming zip and JSON readers. It's a classic script with no DOM and no chrome.* calls, so
// the same code runs in the extension's worker and in Node for the tests.
//
// A "source" is anything with a byte `size`, an async `slice(start, end)` and a `stream(start, end)`.
// `fromFile()` wraps a File or a Blob, and `fromBytes()` wraps bytes already sitting in memory, which is what
// the tests and small picked files use. This reader doesn't trust a zip's own sizes, and it never writes
// anything: it only compares entry names rather than using them as paths, so a hostile name like "../x"
// can't do any damage. The unpack-ratio cap further down stops a zip bomb.
(() => {
  "use strict";

  // ---------- Record markers and caps ----------

  const EOCD64_LOCATOR_SIG = 0x07064b50;
  const EOCD64_SIG = 0x06064b50;
  const CENTRAL_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;
  const MAX_EOCD_TAIL = 65557; // the 22-byte end record plus the biggest comment it can carry
  const MAX_CENTRAL_DIR = 64 * 1024 * 1024;
  const MAX_ENTRIES = 200000;
  const ENCRYPTED_FLAG = 0x0001;
  // Fixed sizes of the records this reader looks at.
  const EOCD_BYTES = 22;
  const EOCD64_LOCATOR_BYTES = 20;
  const EOCD64_BYTES = 56;
  const CENTRAL_HEADER_BYTES = 46;
  const LOCAL_HEADER_BYTES = 30;
  // A field the main header can't hold says so with this, and the ZIP64 extra field holds it instead.
  const ZIP64_MARK = 0xffffffff;
  const ZIP64_EXTRA_TAG = 0x0001;

  function zipError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
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
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return fromFile(new Blob([array]));
  }

  // ---------- Reading bytes as little-endian numbers ----------

  function u16(view, at) {
    return view.getUint16(at, true);
  }

  function u32(view, at) {
    return view.getUint32(at, true);
  }

  // A big archive's 64-bit sizes and offsets, converted to a plain Number. That's safe here because the caps
  // above always reject a value big enough to lose precision before this reader ever acts on it.
  function u64(view, at) {
    return Number(view.getBigUint64(at, true));
  }

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // ---------- The end of central directory, and the entries it points to ----------

  // Reads the ZIP64 extra field that replaces a central-directory entry's plain sizes and offset (APPNOTE
  // 4.5.3). Only the fields that were 0xFFFFFFFF in the main header show up here, always in the same order.
  function readZip64Extra(extra, want) {
    const view = viewOf(extra);
    let at = 0;
    while (at + 4 <= extra.length) {
      const tag = u16(view, at);
      const length = u16(view, at + 2);
      const end = at + 4 + length;
      if (end > extra.length) break;
      if (tag === ZIP64_EXTRA_TAG) return zip64Fields(view, at + 4, end, want);
      at = end;
    }
    return {};
  }

  // The wanted 8-byte fields, in their fixed order, as far as the field's own length allows.
  function zip64Fields(view, start, end, want) {
    let at = start;
    const fields = {};
    if (want.size && at + 8 <= end) {
      fields.size = u64(view, at);
      at += 8;
    }
    if (want.csize && at + 8 <= end) {
      fields.csize = u64(view, at);
      at += 8;
    }
    if (want.at && at + 8 <= end) fields.at = u64(view, at);
    return fields;
  }

  function parseCentralDirectory(bytes, maxEntries) {
    const view = viewOf(bytes);
    const decoder = new TextDecoder();
    const entries = [];
    let at = 0;
    while (at + CENTRAL_HEADER_BYTES <= bytes.length && entries.length < maxEntries) {
      if (u32(view, at) !== CENTRAL_SIG) break;
      const method = u16(view, at + 10);
      let csize = u32(view, at + 20);
      let size = u32(view, at + 24);
      const nameLength = u16(view, at + 28);
      const extraLength = u16(view, at + 30);
      const commentLength = u16(view, at + 32);
      const flags = u16(view, at + 8);
      let offset = u32(view, at + 42);
      const nameStart = at + CENTRAL_HEADER_BYTES;
      if (nameStart + nameLength + extraLength + commentLength > bytes.length) break;
      const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      const extraStart = nameStart + nameLength;
      const extra = bytes.subarray(extraStart, extraStart + extraLength);
      const want = { size: size === ZIP64_MARK, csize: csize === ZIP64_MARK, at: offset === ZIP64_MARK };
      if (want.size || want.csize || want.at) {
        const zip64 = readZip64Extra(extra, want);
        if (zip64.size !== undefined) size = zip64.size;
        if (zip64.csize !== undefined) csize = zip64.csize;
        if (zip64.at !== undefined) offset = zip64.at;
      }
      entries.push({ name, method, csize, size, at: offset, encrypted: (flags & ENCRYPTED_FLAG) !== 0 });
      at = extraStart + extraLength + commentLength;
    }
    return entries;
  }

  // The ZIP64 end record's entry count, directory size and offset, through the locator just before the
  // plain end record (APPNOTE 4.3.14-15).
  async function readZip64End(source, endAt) {
    const locatorAt = endAt - EOCD64_LOCATOR_BYTES;
    if (locatorAt < 0) throw zipError("bad-zip64", "ZIP64 locator missing");
    const locator = await source.slice(locatorAt, locatorAt + EOCD64_LOCATOR_BYTES);
    const locatorView = viewOf(locator);
    if (locator.length < EOCD64_LOCATOR_BYTES || u32(locatorView, 0) !== EOCD64_LOCATOR_SIG) {
      throw zipError("bad-zip64", "ZIP64 locator missing");
    }
    const recordAt = u64(locatorView, 8);
    const record = await source.slice(recordAt, Math.min(recordAt + EOCD64_BYTES, source.size));
    const recordView = viewOf(record);
    if (record.length < EOCD64_BYTES || u32(recordView, 0) !== EOCD64_SIG) {
      throw zipError("bad-zip64", "ZIP64 record missing");
    }
    return { entryCount: u64(recordView, 32), cdSize: u64(recordView, 40), cdOffset: u64(recordView, 48) };
  }

  // Reads the end-of-central-directory record, and for a big archive the ZIP64 locator and record just
  // before it. Then it reads the central directory itself and lists every entry, without ever touching an
  // entry's own data.
  async function openZip(source, opts = {}) {
    const maxEntries = opts.maxEntries || MAX_ENTRIES;
    const maxCentralDir = opts.maxCentralDir || MAX_CENTRAL_DIR;
    if (source.size < EOCD_BYTES) throw zipError("no-eocd", "Too small to be a zip");
    const tailLength = Math.min(source.size, MAX_EOCD_TAIL);
    const tail = await source.slice(source.size - tailLength, source.size);
    const endInTail = tail.lastIndexOf(0x50) >= 0 ? findLast(tail, [0x50, 0x4b, 0x05, 0x06]) : -1;
    if (endInTail < 0 || endInTail + EOCD_BYTES > tail.length) {
      throw zipError("no-eocd", "No end of central directory");
    }
    const view = viewOf(tail);
    let entryCount = u16(view, endInTail + 10);
    let cdSize = u32(view, endInTail + 12);
    let cdOffset = u32(view, endInTail + 16);
    const endAt = source.size - tailLength + endInTail;

    if (entryCount === 0xffff || cdSize === ZIP64_MARK || cdOffset === ZIP64_MARK) {
      ({ entryCount, cdSize, cdOffset } = await readZip64End(source, endAt));
    }
    if (entryCount > maxEntries) throw zipError("too-many-entries", "Clotr can't read this export yet");
    if (cdSize > maxCentralDir) throw zipError("central-directory-too-large", "Clotr can't read this export yet");
    const central = await source.slice(cdOffset, cdOffset + cdSize);
    const entries = parseCentralDirectory(central, maxEntries);
    return { entries };
  }

  // The last offset in `haystack` (a Uint8Array) where `bytes` (a small plain array) occurs, or -1 if it
  // never does.
  function findLast(haystack, bytes) {
    for (let start = haystack.length - bytes.length; start >= 0; start--) {
      if (bytes.every((byte, index) => haystack[start + index] === byte)) return start;
    }
    return -1;
  }

  // ---------- Reading one entry's data ----------

  async function localHeader(source, entry) {
    const head = await source.slice(entry.at, entry.at + LOCAL_HEADER_BYTES);
    if (head.length < LOCAL_HEADER_BYTES) throw zipError("truncated", "This file looks damaged or incomplete");
    const view = viewOf(head);
    if (u32(view, 0) !== LOCAL_SIG) throw zipError("truncated", "This file looks damaged or incomplete");
    const nameLength = u16(view, 26);
    const extraLength = u16(view, 28);
    return { dataStart: entry.at + LOCAL_HEADER_BYTES + nameLength + extraLength };
  }

  // Streams one entry's decompressed bytes as Uint8Array chunks, never the whole entry at once. Stored data
  // comes back as is, method 8 goes through the browser's own DecompressionStream, and anything else
  // (including an encrypted entry) can't be read. If the bytes coming out ever pass `ratio` times the bytes
  // packed in, plus `extra`, this throws an unpack-limit error instead of letting a zip bomb unpack. The
  // defaults are the real 64x-plus-64MB cap; the tests shrink them so a bomb test doesn't need to hold 64MB.
  async function* entryStream(source, entry, { ratio = 64, extra = 64 * 1024 * 1024 } = {}) {
    if (entry.encrypted) throw zipError("cant-read", "Clotr can't read this file");
    if (entry.method !== 0 && entry.method !== 8) throw zipError("cant-read", "Clotr can't read this file");
    const { dataStart } = await localHeader(source, entry);
    const raw = source.stream(dataStart, dataStart + entry.csize);
    const unpacked = entry.method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw")) : raw;
    const cap = entry.csize * ratio + extra;
    const reader = unpacked.getReader();
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
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    return joined;
  }

  // ---------- Scanning a top-level JSON array, one item at a time, without holding the whole file ----------

  // JSON's whitespace between tokens.
  const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

  // The scanner's state, carried from one chunk to the next.
  function newJsonScan() {
    return {
      depth: 0,
      inString: false,
      escaped: false,
      started: false,
      mode: null, // "array" | "object" | "none"
      targetDepth: null,
      keyState: "none", // "none" | "afterString" | "afterColon"
      candidateIsKey: false,
      keyBuf: "",
      itemActive: false,
      itemBuf: "",
      itemTooBig: false,
      done: false,
    };
  }

  // Yields the item gathered so far, if there is one, and starts a new one.
  function* flushJsonItem(scan) {
    if (scan.itemActive) {
      yield scan.itemTooBig ? { text: null, tooBig: true, prefix: scan.itemBuf } : { text: scan.itemBuf };
    }
    scan.itemActive = false;
    scan.itemBuf = "";
    scan.itemTooBig = false;
  }

  // The document's first character: "[" makes the top-level array the target, "{" starts the search for
  // "conversations", anything else ends the scan (false).
  function startJsonScan(scan, char) {
    scan.started = true;
    if (char === "[") {
      scan.mode = "array";
      scan.targetDepth = 1;
    } else if (char === "{") {
      scan.mode = "object";
    } else {
      scan.done = true;
      return false;
    }
    return true;
  }

  // Watching for "conversations": at depth 1 of a top-level object, before the target array is found.
  function watchForConversations(scan, char, preDepth) {
    if (scan.keyState === "afterString") {
      if (!WHITESPACE.has(char)) scan.keyState = char === ":" ? "afterColon" : "none";
    } else if (scan.keyState === "afterColon") {
      if (!WHITESPACE.has(char)) {
        if (char === "[" && scan.candidateIsKey) scan.targetDepth = preDepth + 1;
        scan.keyState = "none";
      }
    }
  }

  // The generic string/escape/bracket tracking every character goes through. True when this character
  // closes the target array, which ends the scan.
  function trackStringsAndBrackets(scan, char, preDepth, wasInString) {
    const atTopKey = scan.mode === "object" && scan.targetDepth === null && preDepth === 1;
    if (wasInString) {
      if (scan.escaped) scan.escaped = false;
      else if (char === "\\") scan.escaped = true;
      else if (char === '"') {
        scan.inString = false;
        if (atTopKey) {
          scan.candidateIsKey = scan.keyBuf === "conversations";
          scan.keyState = "afterString";
        }
      } else if (atTopKey && scan.keyBuf.length < 32) {
        scan.keyBuf += char;
      }
      return false;
    }
    if (char === '"') {
      scan.inString = true;
      scan.keyBuf = "";
    } else if (char === "[" || char === "{") {
      scan.depth++;
    } else if (char === "]" || char === "}") {
      const closesTarget = scan.targetDepth !== null && preDepth === scan.targetDepth && char === "]";
      if (closesTarget) scan.done = true;
      scan.depth--;
      return closesTarget;
    }
    return false;
  }

  // Capturing the target array's items, once it's been found. True at a comma between items.
  function captureItemChar(scan, char, preDepth, wasInString, cap) {
    const structuralComma = !wasInString && preDepth === scan.targetDepth && char === ",";
    if (structuralComma) return true;
    if (!wasInString && WHITESPACE.has(char) && preDepth === scan.targetDepth) {
      // Whitespace outside a string, right at the item boundary: before an item starts or after it ends.
      return false;
    }
    if (!scan.itemActive) scan.itemActive = true;
    if (scan.itemBuf.length < cap) scan.itemBuf += char;
    else scan.itemTooBig = true;
    return false;
  }

  // One character through the scan: "skip" (space before the document), "stop" (not an array or object),
  // "flush" (an item is complete) or "next".
  function scanJsonChar(scan, char, cap) {
    const preDepth = scan.depth;
    const wasInString = scan.inString;
    if (!scan.started) {
      if (WHITESPACE.has(char)) return "skip";
      if (!startJsonScan(scan, char)) return "stop";
    }
    if (scan.mode === "object" && scan.targetDepth === null && !wasInString) {
      watchForConversations(scan, char, preDepth);
    }
    if (trackStringsAndBrackets(scan, char, preDepth, wasInString)) return "flush";
    if (!scan.done && scan.targetDepth !== null && preDepth >= scan.targetDepth) {
      if (captureItemChar(scan, char, preDepth, wasInString, cap)) return "flush";
    }
    return "next";
  }

  // Reads every item out of a top-level JSON array, one at a time, without ever holding the whole document
  // in memory. An export's top level can also be an object with a "conversations" array instead of a bare
  // array, and both are handled. `chunks` is an async iterable of Uint8Array or string pieces, such as what
  // entryStream() yields. Each item under `cap` characters comes out as `{ text }`; a bigger one comes out
  // as `{ text: null, tooBig: true, prefix }`, where `prefix` is just the first `cap` characters, usually
  // enough to find a title. Reading stops as soon as the target array closes, and a document that isn't a
  // top-level array or object yields nothing at all.
  async function* jsonItems(chunks, { cap = Infinity } = {}) {
    const decoder = new TextDecoder();
    const scan = newJsonScan();
    for await (const chunk of chunks) {
      if (scan.done) break;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      for (let i = 0; i < text.length && !scan.done; i++) {
        const step = scanJsonChar(scan, text[i], cap);
        if (step === "stop") break;
        if (step === "flush") yield* flushJsonItem(scan);
      }
    }
  }

  // ---------- Scanning a .jsonl file, one line at a time ----------

  // Reads each non-blank line of a newline-delimited JSON file, yielding the same `{ text }` or
  // `{ text: null, tooBig: true, prefix }` shape as jsonItems() so a caller can treat either kind the same
  // way. A line never grows past `cap` characters while it's being built, so even a hostile file with no
  // newlines at all still reads in bounded memory.
  async function* jsonlItems(chunks, { cap = Infinity } = {}) {
    const decoder = new TextDecoder();
    let line = "";
    let tooBig = false;
    let hasText = false;
    function* flush() {
      const value = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (hasText && value.trim()) yield tooBig ? { text: null, tooBig: true, prefix: value } : { text: value };
      line = "";
      tooBig = false;
      hasText = false;
    }
    // Adds a piece of a line, up to the cap; past it, the line is marked too big.
    function addPiece(piece) {
      hasText = true;
      if (tooBig) return;
      const room = cap - line.length;
      if (piece.length > room) {
        line += piece.slice(0, Math.max(0, room));
        tooBig = true;
      } else line += piece;
    }
    for await (const chunk of chunks) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        const piece = newline < 0 ? text.slice(start) : text.slice(start, newline);
        if (piece) addPiece(piece);
        if (newline < 0) break;
        yield* flush();
        start = newline + 1;
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

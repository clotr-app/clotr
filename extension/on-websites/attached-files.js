// Reading attached files as text, on this computer (content script).
// Loaded after attachment-text.js (it uses xmlToText, findPdfStreams and pdfPageText) and before
// on-websites/content.js, which calls Clotr.readAttachment(file) when a file is attached, dropped or pasted.
//
// Everything here reads files that could be hostile, so each format has hard caps: file size,
// text inflated per part and in total, number of parts. Reading stops at a cap; an unreadable
// file gives null.
(() => {
  "use strict";

  const { xmlToText, findPdfStreams, pdfPageText } = globalThis.Clotr;

  // ---------- Kinds of file ----------

  const TEXT_FILE =
    /\.(?:txt|csv|tsv|md|json|jsonl|log|env|ini|conf|cfg|toml|ya?ml|xml|sql|js|mjs|ts|py|rb|go|java|cs|php|sh|ps1|html?|pem|key|ppk|ovpn|npmrc|netrc)$/i;
  // A key or sign-in file with no extension at all (ssh-keygen's own default names), or a .env variant:
  // the engine's own private-key and token patterns read these as plain text, like any other TEXT_FILE.
  const KEY_FILE_NAMES = /^(?:id_rsa|id_ed25519|credentials)$/i;
  const ENV_VARIANT = /^\.env(?:\..+)?$/i;
  // An SVG picture is text inside: the words it shows are in its text elements, its drawing in attributes.
  const SVG_FILE = /\.svg$/i;
  const OFFICE_FILE = /\.(?:docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i;
  // The parts of an Office/OpenDocument zip that hold the document's text.
  const OFFICE_PART =
    /^(?:word\/(?:document|header\d*|footer\d*|footnotes|comments)\.xml|xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml|ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml|content\.xml)$/;

  function isPdfFile(file) {
    return /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  }

  function isSvgFile(file) {
    return SVG_FILE.test(file.name) || file.type === "image/svg+xml";
  }

  // A plain-text file by its name or its type.
  function isTextFile(file) {
    if (TEXT_FILE.test(file.name) || KEY_FILE_NAMES.test(file.name)) return true;
    return ENV_VARIANT.test(file.name) || /^text\/|json/.test(file.type);
  }

  // ---------- Caps ----------

  const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_DOC_BYTES = 20 * 1024 * 1024; // Office and PDF files
  const MAX_PART_TEXT = 2 * 1024 * 1024;
  const MAX_TOTAL_TEXT = 2 * 1024 * 1024; // like plain-text files: checking more would stall the page
  // An Office part's XML, markup and all, before it's turned into text.
  // The text is then held to the caps above.
  const MAX_PART_XML = 8 * 1024 * 1024;
  const MAX_TOTAL_XML = 16 * 1024 * 1024;
  const MAX_OFFICE_PARTS = 60;
  const MAX_PDF_STREAMS = 400;

  // ---------- Bytes ----------

  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextDecoder();

  // Bytes from the page, made this script's own. Firefox gives a content script the page's own copy of a
  // file's bytes (from arrayBuffer(), or a stream's pieces) and won't let the script cut them up:
  // subarray() fails with "Permission denied". Such bytes are copied over first. Chrome, Brave and Edge
  // already give a content script its own, so nothing changes there. Used by on-websites/attached-pictures.js too.
  function ownBytes(bytes) {
    if (bytes instanceof ArrayBuffer || bytes instanceof Uint8Array) return bytes;
    return structuredClone(bytes);
  }

  // Decompresses with the browser's own DecompressionStream ("deflate-raw" in zips, "deflate" in
  // PDFs), stopping at `cap` bytes (zip bombs) and keeping what was read if the data is corrupt.
  async function inflateCapped(bytes, format, cap) {
    if (typeof DecompressionStream !== "function") return null;
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(ownBytes(value));
        size += value.length;
        if (size >= cap) {
          reader.cancel().catch(() => {});
          break;
        }
      }
    } catch {
      /* truncated or corrupt: keep what was read */
    }
    return joinChunks(chunks, Math.min(size, cap));
  }

  // The chunks laid end to end in one array of `length` bytes, the rest cut off.
  function joinChunks(chunks, length) {
    const joined = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, joined.length - at);
      joined.set(chunk.subarray(0, take), at);
      at += take;
      if (at >= joined.length) break;
    }
    return joined;
  }

  // ---------- Files Clotr can't read ----------

  // Why a doc file Clotr recognizes (by name) came back with no text, so a scan never counts it as
  // "nothing found": "locked" (a password, Office's own CFBF wrapper or a PDF's /Encrypt), "scan" (a PDF
  // with nothing but a picture of a page, never a text layer) or "damaged" (not the format its name claims).
  class UnreadableDoc extends Error {
    constructor(reason) {
      super(reason);
      this.reason = reason;
    }
  }

  // Office's own password protection wraps the whole file as a Compound File Binary (the same container
  // .doc and .xls used before .docx), never a zip: this is its fixed first 8 bytes.
  const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

  function isOle2(bytes) {
    return OLE2_MAGIC.every((byte, index) => bytes[index] === byte);
  }

  // ---------- Office files ----------

  // The zip's own record markers, little-endian.
  const END_OF_DIRECTORY = 0x06054b50;
  const DIRECTORY_ENTRY = 0x02014b50;
  const LOCAL_HEADER = 0x04034b50;
  // The end record is 22 bytes, after at most a 64 KB comment.
  const END_RECORD_BYTES = 22;
  const END_SEARCH_BYTES = 65557;

  // Where the end of the central directory starts, within the last 64 KB, or -1.
  function findDirectoryEnd(bytes, view) {
    const lowest = Math.max(0, bytes.length - END_SEARCH_BYTES);
    for (let at = bytes.length - END_RECORD_BYTES; at >= lowest; at--) {
      if (view.getUint32(at, true) === END_OF_DIRECTORY) return at;
    }
    return -1;
  }

  // The central directory's entries: each part's name, packing method, packed size and local header.
  function zipEntries(bytes, view, directoryEnd) {
    const count = Math.min(view.getUint16(directoryEnd + 10, true), MAX_OFFICE_PARTS * 20);
    let at = view.getUint32(directoryEnd + 16, true);
    const entries = [];
    for (let index = 0; index < count && at + 46 <= bytes.length; index++) {
      if (view.getUint32(at, true) !== DIRECTORY_ENTRY) break;
      const nameLength = view.getUint16(at + 28, true);
      const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      entries.push({
        name,
        method: view.getUint16(at + 10, true),
        csize: view.getUint32(at + 20, true),
        local: view.getUint32(at + 42, true),
      });
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  // One part's packed bytes, from just after its local header.
  function packedPart(bytes, view, entry) {
    const { csize, local } = entry;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    return bytes.subarray(start, Math.min(bytes.length, start + csize));
  }

  // Office documents (.docx/.xlsx/.pptx and OpenDocument) are zip files of XML: walk the zip's
  // central directory, unpack only the text parts, and turn their XML into plain text.
  async function officeText(file) {
    if (file.size > MAX_DOC_BYTES) return null;
    const bytes = new Uint8Array(ownBytes(await file.arrayBuffer()));
    if (isOle2(bytes)) throw new UnreadableDoc("locked");
    const view = new DataView(bytes.buffer);
    const directoryEnd = findDirectoryEnd(bytes, view);
    if (directoryEnd < 0) throw new UnreadableDoc("damaged");
    const entries = zipEntries(bytes, view, directoryEnd);
    // Every text cell of a spreadsheet lives in xl/sharedStrings.xml, which Excel writes after the sheets,
    // so it's read first. The budget counts the text each part gives, not its markup: a big sheet's row and
    // cell tags alone used to spend it before the shared strings were reached. The markup has its own,
    // larger cap.
    entries.sort((a, b) => (b.name === "xl/sharedStrings.xml") - (a.name === "xl/sharedStrings.xml"));
    let total = 0;
    let xml = 0;
    let parts = 0;
    let text = "";
    for (const entry of entries) {
      if (parts >= MAX_OFFICE_PARTS || total >= MAX_TOTAL_TEXT || xml >= MAX_TOTAL_XML) break;
      const { name, local } = entry;
      if (!OFFICE_PART.test(name) || local + 30 > bytes.length) continue;
      if (view.getUint32(local, true) !== LOCAL_HEADER) continue;
      const packed = packedPart(bytes, view, entry);
      const cap = Math.min(MAX_PART_XML, MAX_TOTAL_XML - xml);
      // Stored (method 0) as is, deflated (method 8) unpacked, anything else skipped.
      let xmlBytes = null;
      if (entry.method === 0) xmlBytes = packed.subarray(0, cap);
      else if (entry.method === 8) xmlBytes = await inflateCapped(packed, "deflate-raw", cap);
      if (!xmlBytes) continue;
      parts++;
      xml += xmlBytes.length;
      const words = xmlToText(utf8.decode(xmlBytes)).slice(0, MAX_TOTAL_TEXT - total);
      total += words.length;
      text += `${words}\n`;
    }
    return text;
  }

  // ---------- PDF files ----------

  // A PDF's own trailer names its encryption dictionary this way, however old or new the PDF: it's checked
  // before even looking for streams, since an encrypted PDF's streams aren't readable text anyway.
  const PDF_ENCRYPT = /\/Encrypt\s+\d+\s+\d+\s+R/;
  // findPdfStreams looks at no more than this many "stream" keywords.
  const MAX_STREAM_KEYWORDS = 5000;
  const MAX_LENGTH_OBJECTS = 50000;
  // No /Length: look for "endstream" this far ahead, for this many such streams (hostile files).
  const ENDSTREAM_SEARCH_BYTES = 2 * 1024 * 1024;
  const MAX_UNSIZED_STREAMS = 50;
  // An embedded font program (/Length1-3, or a compact font's own subtype) or a colour profile (/N) is
  // never text: unpacking it spent the budget the pages need, and its bytes could even pass for text
  // operators.
  const FONT_OR_PROFILE = /\/Length[123]\b|\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType)\b|\/N\s+\d/;
  const NOT_TEXT = /\/Subtype\s*\/XML|\/Type\s*\/XRef|\/(?:DCT|JPX|CCITTFax|JBIG2)Decode/;

  // A stream's length as its dictionary gives it, or null. A length given as another object ("/Length
  // 12 0 R", as LibreOffice writes it) is read from that object: every small "12 0 obj 345 endobj" in the
  // file (up to 50,000 of them), found once, with bounded runs so it stays one linear pass. One that isn't
  // there falls back to looking for "endstream", as a missing /Length does.
  function pdfLengthReader(raw) {
    let lengthObjects = null;
    return function lengthOf(dict) {
      const direct = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
      if (direct) return Number(direct[1]);
      const ref = /\/Length\s+(\d{1,10})\s+(\d{1,5})\s+R/.exec(dict);
      if (!ref) return null;
      if (!lengthObjects) lengthObjects = smallObjects(raw);
      return lengthObjects.get(`${Number(ref[1])} ${Number(ref[2])}`) ?? null;
    };
  }

  // Every "12 0 obj 345 endobj" in the file, as "12 0" → 345.
  function smallObjects(raw) {
    const found = new Map();
    const object = /(\d{1,10})\s{1,5}(\d{1,5})\s{1,5}obj\s{0,20}(\d{1,10})\s{0,20}endobj/g;
    for (let match; found.size < MAX_LENGTH_OBJECTS && (match = object.exec(raw));) {
      found.set(`${Number(match[1])} ${Number(match[2])}`, Number(match[3]));
    }
    return found;
  }

  // PDFs: unpack the page streams (FlateDecode, capped), then read the text-showing operators
  // through the fonts' ToUnicode maps (attachment-text.js). Scanned images have no text: nothing to find, but
  // naming that it was a picture (not Clotr failing to read a real page of text) still matters.
  async function pdfText(file) {
    if (file.size > MAX_DOC_BYTES) return null;
    const bytes = new Uint8Array(ownBytes(await file.arrayBuffer()));
    const raw = latin1.decode(bytes);
    if (!raw.startsWith("%PDF")) throw new UnreadableDoc("damaged");
    if (PDF_ENCRYPT.test(raw)) throw new UnreadableDoc("locked");
    const lengthOf = pdfLengthReader(raw);
    const streams = [];
    let total = 0;
    let unsized = 0;
    let sawImage = false;
    // The stream cap counts only the streams kept, so pictures ahead of a page can't use it up.
    for (const { dict, start } of findPdfStreams(raw, MAX_STREAM_KEYWORDS)) {
      if (streams.length >= MAX_PDF_STREAMS || total >= MAX_TOTAL_TEXT) break;
      if (FONT_OR_PROFILE.test(dict)) continue;
      const length = lengthOf(dict);
      if (length === null && ++unsized > MAX_UNSIZED_STREAMS) continue;
      const end = length !== null ? start + length : endstreamAt(raw, start);
      if (end <= start || end > bytes.length) continue;
      if (/\/Subtype\s*\/Image/.test(dict)) {
        sawImage = true;
        continue;
      }
      if (NOT_TEXT.test(dict)) continue;
      let streamBytes = bytes.subarray(start, end);
      if (/\/FlateDecode/.test(dict)) {
        streamBytes = await inflateCapped(streamBytes, "deflate", Math.min(MAX_PART_TEXT, MAX_TOTAL_TEXT - total));
      } else if (/\/Filter/.test(dict)) continue; // other encodings: skip
      if (!streamBytes) continue;
      total += streamBytes.length;
      streams.push(latin1.decode(streamBytes));
    }
    const text = pdfPageText(streams);
    if (!text.trim() && sawImage) throw new UnreadableDoc("scan");
    return text;
  }

  // Where "endstream" is, searched for at most 2 MB ahead. Not found gives start - 1, which is skipped.
  function endstreamAt(raw, start) {
    return raw.slice(start, start + ENDSTREAM_SEARCH_BYTES).indexOf("endstream") + start;
  }

  // ---------- Reading an attachment ----------

  // The text of an attached file and, when it's a kind Clotr recognizes but couldn't actually read, why:
  // never silently "nothing found" for a file that was locked, damaged or a scan with no text layer. The
  // plain `readAttachment` below keeps its own callers (the extension's live warning) exactly as they were.
  async function readAttachmentDetailed(file) {
    try {
      if (OFFICE_FILE.test(file.name)) return { text: await officeText(file), reason: null };
      if (isPdfFile(file)) return { text: await pdfText(file), reason: null };
      if (isSvgFile(file)) {
        return { text: file.size <= MAX_TEXT_FILE_BYTES ? xmlToText(await file.text()) : null, reason: null };
      }
      if (file.size <= MAX_TEXT_FILE_BYTES && isTextFile(file)) return { text: await file.text(), reason: null };
    } catch (err) {
      return { text: null, reason: err instanceof UnreadableDoc ? err.reason : "damaged" };
    }
    return { text: null, reason: null };
  }

  // The text of an attached file, or null if it isn't a kind Clotr reads (or can't be read).
  async function readAttachment(file) {
    return (await readAttachmentDetailed(file)).text;
  }

  // A kind of file Clotr reads, but past the size it reads to: readAttachmentDetailed gives it no text
  // and no reason, the same as a file of a kind it doesn't read at all.
  function overReadLimit(file) {
    if (OFFICE_FILE.test(file.name) || isPdfFile(file)) return file.size > MAX_DOC_BYTES;
    const textLike = isSvgFile(file) || isTextFile(file);
    return textLike && file.size > MAX_TEXT_FILE_BYTES;
  }

  Object.assign(globalThis.Clotr, { readAttachment, readAttachmentDetailed, overReadLimit, ownBytes });
})();

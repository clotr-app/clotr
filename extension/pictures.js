// Attached pictures (content script, loaded after attachments.js and before content.js).
//
// Clotr never reads the words in a picture: no text reader and no AI of its own, ever. It tells a
// picture apart from a document so that content.js can say so plainly, once per AI site, the first time a picture
// with nothing found in it is attached there. An SVG is text inside, so attachments.js reads it like any text
// file. What it does check in a picture: the place it was taken, when the camera saved it inside the file, and
// its name ("passport-scan.jpg"). Everything here runs in the page's frame, on the file the person chose; nothing is
// sent or stored, and a place or a name found never leaves this script except as content.js's salted fingerprint.
(() => {
  "use strict";

  const { ownBytes } = globalThis.Clotr; // attachments.js: the file's bytes as this script's own (Firefox)

  // Formats people attach as pictures, by the name's ending (Windows often gives no type for HEIC).
  const PICTURE_NAME = /\.(?:jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

  function isPicture(file) {
    const name = typeof file?.name === "string" ? file.name : "";
    const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
    if (type === "image/svg+xml" || /\.svg$/i.test(name)) return false; // text inside: read as a text file
    return type.startsWith("image/") || PICTURE_NAME.test(name);
  }

  // ---------- A photo's hidden location (EXIF GPS) ----------
  // Cameras and phones save hidden details inside a photo (EXIF): with location on, the place it was taken, to a few
  // metres. A small reader for that one detail, in the formats people attach: JPEG, PNG, WebP, HEIC/HEIF/AVIF, TIFF,
  // and the text form some editors write (XMP). The file could be hostile: every read is bounded (the first 256 KB,
  // plus a HEIC's location item, 64 KB at most, wherever it is), every offset is checked, every loop has a cap, and
  // any oddity means "no location".
  const HEAD_BYTES = 256 * 1024;
  const ITEM_BYTES = 64 * 1024;
  const latin1 = new TextDecoder("latin1");

  const tag = (b, at, text) => {
    if (at < 0 || at + text.length > b.length) return false;
    for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  const u16 = (b, at) => (at >= 0 && at + 2 <= b.length ? (b[at] << 8) | b[at + 1] : -1);
  const u32 = (b, at) =>
    at >= 0 && at + 4 <= b.length ? ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0 : -1;
  const u32le = (b, at) =>
    at >= 0 && at + 4 <= b.length ? ((b[at + 3] << 24) | (b[at + 2] << 16) | (b[at + 1] << 8) | b[at]) >>> 0 : -1;
  // A big-endian number 0, 4 or 8 bytes long (HEIF writes sizes that way); -1 past the end.
  const uintN = (b, at, size) => {
    if (size === 0) return 0;
    if (size === 4) return u32(b, at);
    if (size !== 8) return -1;
    const hi = u32(b, at);
    const lo = u32(b, at + 4);
    return hi < 0 || lo < 0 ? -1 : hi * 2 ** 32 + lo;
  };
  // EXIF blocks often start with "Exif\0\0" before the TIFF structure.
  const tiffStart = (b) => (tag(b, 0, "Exif\0\0") ? b.subarray(6) : b);

  // The TIFF structure's GPS position: { lat, lon } in degrees, or null.
  function tiffGps(t) {
    if (t.length < 8) return null;
    const le = tag(t, 0, "II");
    if (!le && !tag(t, 0, "MM")) return null;
    const r16 = (at) =>
      at >= 0 && at + 2 <= t.length ? (le ? t[at] | (t[at + 1] << 8) : (t[at] << 8) | t[at + 1]) : -1;
    const r32 = (at) =>
      at >= 0 && at + 4 <= t.length
        ? le
          ? (t[at] | (t[at + 1] << 8) | (t[at + 2] << 16) | (t[at + 3] << 24)) >>> 0
          : ((t[at] << 24) | (t[at + 1] << 16) | (t[at + 2] << 8) | t[at + 3]) >>> 0
        : -1;
    if (r16(2) !== 42) return null;
    // A directory: up to 200 twelve-byte entries, each { tag, type, count, where its value is }.
    const entries = (at) => {
      const n = r16(at);
      if (n < 0 || n > 200) return null;
      const out = new Map();
      for (let i = 0; i < n; i++) {
        const e = at + 2 + i * 12;
        if (e + 12 > t.length) return null;
        out.set(r16(e), { type: r16(e + 2), count: r32(e + 4), at: e + 8 });
      }
      return out;
    };
    const first = entries(r32(4));
    const pointer = first?.get(0x8825); // where the GPS directory is
    const gps = pointer && entries(r32(pointer.at));
    if (!gps) return null;
    // Degrees from 1 to 3 numbers (degrees, minutes, seconds), each a fraction; signed fractions (type 10) carry
    // the sign in the degrees.
    const degrees = (e) => {
      if (!e || (e.type !== 5 && e.type !== 10) || e.count < 1 || e.count > 3) return null;
      const at = r32(e.at);
      if (at < 0 || at + e.count * 8 > t.length) return null;
      const parts = [];
      for (let i = 0; i < e.count; i++) {
        let num = r32(at + i * 8);
        let den = r32(at + i * 8 + 4);
        if (e.type === 10) {
          num |= 0;
          den |= 0;
        }
        if (!den) return null;
        parts.push(num / den);
      }
      const [d, m = 0, s = 0] = parts;
      const value = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
      return d < 0 ? -value : value;
    };
    const letter = (e) => (e && e.type === 2 && e.count >= 1 && e.count <= 4 ? String.fromCharCode(t[e.at]) : "");
    let lat = degrees(gps.get(2));
    let lon = degrees(gps.get(4));
    if (lat === null || lon === null) return null;
    if (letter(gps.get(1)) === "S") lat = -Math.abs(lat);
    if (letter(gps.get(3)) === "W") lon = -Math.abs(lon);
    return { lat, lon };
  }

  // The text form (XMP): exif:GPSLatitude="40,41.35N" (degrees, minutes and maybe seconds, then N/S, E/W).
  const XMP_LAT = /(?:[A-Za-z_][\w.-]*:)?GPSLatitude(?:="|>)\s*(\d{1,3}(?:[.,]\d{1,12}){0,3})\s*([NS])?/;
  const XMP_LON = /(?:[A-Za-z_][\w.-]*:)?GPSLongitude(?:="|>)\s*(\d{1,3}(?:[.,]\d{1,12}){0,3})\s*([EW])?/;
  function xmpGps(b) {
    const text = latin1.decode(b);
    if (!/GPS(?:Latitude|Longitude)/.test(text)) return null;
    const read = (re) => {
      const m = re.exec(text);
      if (!m) return null;
      const parts = m[1].split(",").map(Number);
      if (parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
      const [d, mins = 0, s = 0] = parts;
      const value = d + mins / 60 + s / 3600;
      return m[2] === "S" || m[2] === "W" ? -value : value;
    };
    const lat = read(XMP_LAT);
    const lon = read(XMP_LON);
    return lat === null || lon === null ? null : { lat, lon };
  }

  // JPEG: the blocks before the picture data, looking for the one that starts "Exif\0\0".
  function jpegExif(b) {
    let p = 2;
    for (let n = 0; n < 100 && p + 4 <= b.length; n++) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1];
      if (marker === 0xff) {
        p++; // padding
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // the end, or the picture data: no more details
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        p += 2;
        continue;
      }
      const len = u16(b, p + 2);
      if (len < 2) return null;
      if (marker === 0xe1 && tag(b, p + 4, "Exif\0\0")) {
        return { tiff: b.subarray(p + 10, Math.min(p + 2 + len, b.length)) };
      }
      p += 2 + len;
    }
    return null;
  }

  // PNG: chunks of { length, type, data, check }; the details are an "eXIf" chunk.
  function pngExif(b) {
    let p = 8;
    for (let n = 0; n < 1000 && p + 8 <= b.length; n++) {
      const len = u32(b, p);
      if (tag(b, p + 4, "eXIf")) return { tiff: tiffStart(b.subarray(p + 8, Math.min(p + 8 + len, b.length))) };
      if (tag(b, p + 4, "IEND")) return null;
      p += 12 + len;
    }
    return null;
  }

  // WebP: RIFF chunks of { type, length, data } (padded to an even length); the details are an "EXIF" chunk.
  function webpExif(b) {
    let p = 12;
    for (let n = 0; n < 100 && p + 8 <= b.length; n++) {
      const len = u32le(b, p + 4);
      if (tag(b, p, "EXIF")) return { tiff: tiffStart(b.subarray(p + 8, Math.min(p + 8 + len, b.length))) };
      p += 8 + len + (len & 1);
    }
    return null;
  }

  // HEIF (HEIC, AVIF): boxes inside boxes. The "meta" box lists the items ("iinf"), one of type "Exif", and where
  // each item's bytes are ("iloc"): in the file, or in the meta box's own data ("idat"). Calls `visit(type, from, to)`
  // for each box in [from, to); stops at a box too small to hold itself (no endless loop) and after 1,000 boxes.
  function boxes(b, from, to, visit) {
    let p = from;
    for (let n = 0; n < 1000 && p + 8 <= to; n++) {
      let size = u32(b, p);
      let header = 8;
      if (size === 1) {
        size = uintN(b, p + 8, 8);
        header = 16;
      } else if (size === 0) size = to - p; // to the end
      if (size < header) return;
      visit(latin1.decode(b.subarray(p + 4, p + 8)), p + header, Math.min(p + size, to));
      p += size;
    }
  }

  function heifExif(b) {
    let meta = null;
    boxes(b, 0, b.length, (type, from, to) => {
      if (type === "meta" && !meta) meta = { from: from + 4, to }; // a full box: version and flags first
    });
    if (!meta) return null;
    let exifId = -1;
    let iloc = null;
    let idat = -1;
    boxes(b, meta.from, meta.to, (type, from, to) => {
      if (type === "iinf" && exifId < 0) {
        const version = b[from];
        boxes(b, from + (version === 0 ? 6 : 8), to, (t, f) => {
          if (t !== "infe" || exifId >= 0) return;
          const v = b[f];
          if (v < 2) return; // older entries have no item type
          const id = v === 2 ? u16(b, f + 4) : u32(b, f + 4);
          if (tag(b, f + (v === 2 ? 8 : 10), "Exif")) exifId = id;
        });
      } else if (type === "iloc" && !iloc) iloc = { from, to };
      else if (type === "idat" && idat < 0) idat = from;
    });
    if (exifId < 0 || !iloc) return null;
    const where = ilocItem(b, iloc.from, iloc.to, exifId);
    if (!where) return null;
    if (where.method === 1) {
      if (idat < 0) return null;
      where.at += idat;
    } else if (where.method !== 0) return null;
    return { at: where.at, length: where.length };
  }

  // Where item `id` starts and how long it is (its first piece), from an "iloc" box.
  function ilocItem(b, from, to, id) {
    const version = b[from];
    if (version > 2 || from + 8 > to) return null;
    const offsetSize = b[from + 4] >> 4;
    const lengthSize = b[from + 4] & 15;
    const baseSize = b[from + 5] >> 4;
    const indexSize = version > 0 ? b[from + 5] & 15 : 0;
    let p = from + 6;
    const count = version < 2 ? u16(b, p) : u32(b, p);
    p += version < 2 ? 2 : 4;
    for (let i = 0; i < count && i < 1000 && p < to; i++) {
      const itemId = version < 2 ? u16(b, p) : u32(b, p);
      p += version < 2 ? 2 : 4;
      let method = 0;
      if (version > 0) {
        method = u16(b, p) & 15;
        p += 2;
      }
      p += 2; // data reference
      const base = uintN(b, p, baseSize);
      p += baseSize;
      const extents = u16(b, p);
      p += 2;
      if (base < 0 || extents < 0 || p > to) return null;
      for (let e = 0; e < extents && e < 100; e++) {
        p += indexSize;
        const offset = uintN(b, p, offsetSize);
        const length = uintN(b, p + offsetSize, lengthSize);
        p += offsetSize + lengthSize;
        if (offset < 0 || length < 0 || p > to) return null;
        if (itemId === id && e === 0) return { at: base + offset, length: length || ITEM_BYTES, method };
      }
    }
    return null;
  }

  // The EXIF item of a HEIF file: 4 bytes saying where its TIFF starts, then (usually) "Exif\0\0", then the TIFF.
  function heifItemTiff(item) {
    const skip = u32(item, 0);
    if (skip < 0 || 4 + skip > item.length) return null;
    return tiffStart(item.subarray(4 + skip));
  }

  // Where the details are in the first bytes of a file: { tiff } when they're there, { at, length } when a HEIF file
  // keeps them further on (read separately, 64 KB at most), or null.
  function findExif(head) {
    if (head[0] === 0xff && head[1] === 0xd8) return jpegExif(head);
    if (tag(head, 0, "\x89PNG\r\n\x1a\n")) return pngExif(head);
    if (tag(head, 0, "RIFF") && tag(head, 8, "WEBP")) return webpExif(head);
    if (tag(head, 0, "II*\0") || tag(head, 0, "MM\0*")) return { tiff: head };
    if (tag(head, 4, "ftyp")) return heifExif(head);
    return null;
  }

  // The place in a picture: { lat, lon } or null. `head` is the file's first bytes; `readItem(at, length)` gives
  // other bytes of the file (a HEIF item), or null.
  function placeIn(head, size, readItem) {
    let found = findExif(head);
    if (found && !found.tiff) {
      const length = Math.min(found.length, ITEM_BYTES);
      if (!(found.at >= 0 && found.at + length <= size)) return null;
      const item =
        found.at + length <= head.length ? head.subarray(found.at, found.at + length) : readItem(found.at, length);
      if (item?.then) return item.then((bytes) => finish(bytes && { tiff: heifItemTiff(bytes) }, head));
      found = { tiff: item && heifItemTiff(item) };
    }
    return finish(found, head);
  }
  function finish(found, head) {
    const place = (found?.tiff && tiffGps(found.tiff)) || xmpGps(head);
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null;
    if (Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180) return null;
    // 0,0 is what some cameras write when they have no position.
    return Math.round(place.lat * 1000) === 0 && Math.round(place.lon * 1000) === 0 ? null : place;
  }

  // The place in a picture's bytes (the whole file in memory), read the same bounded way as a file: { lat, lon } or
  // null. Never throws.
  function gpsFrom(bytes) {
    try {
      if (!(bytes instanceof Uint8Array)) return null;
      return placeIn(bytes.subarray(0, HEAD_BYTES), bytes.length, (at, length) => bytes.subarray(at, at + length));
    } catch {
      return null;
    }
  }

  // "latitude,longitude" to 3 decimals (about 110 metres): two photos taken at home give the same value, so their
  // fingerprints match.
  function placeValue({ lat, lon }) {
    const round = (x) => (Math.round(x * 1000) / 1000 || 0).toFixed(3); // never -0
    return `${round(lat)},${round(lon)}`;
  }

  async function photoLocation(file) {
    const size = Number(file.size);
    if (!Number.isFinite(size) || size <= 0 || typeof file.slice !== "function") return null;
    const read = async (from, to) => new Uint8Array(ownBytes(await file.slice(from, to).arrayBuffer()));
    const head = await read(0, HEAD_BYTES);
    const place = await placeIn(head, size, (at, length) => read(at, at + length));
    return place && placeValue(place);
  }

  // ---------- Removing a photo's place, keeping the photo ----------
  // "Cover it" swaps a typed detail for a label; a photo needs a different fix, since its place isn't a word
  // on screen to replace. This rebuilds the file itself: the picture's own bytes (what a person actually
  // looks at, and its EXIF Orientation) stay exactly as they were, while the GPS directory that named the
  // place, and any XMP text packet that repeats it, are gone. A pure function: the same bytes in always give
  // the same bytes out, and the input is never written to. Redrawing the photo on a canvas would re-encode
  // it and couldn't promise the pixels come out byte for byte the same; this instead edits the file in
  // place, reusing the same bounded readers above, so JPEG and PNG keep their original image data untouched.
  // HEIC and WebP aren't rebuilt here (today's advice, "take the photo off before you send," still applies
  // to those).

  // IFD0's GPS pointer (does this TIFF structure carry a place at all) and its Orientation value (1 to 8, or
  // null), read the same bounded way tiffGps reads the position above: any oddity is "nothing to report",
  // never a throw.
  function tiffInfo(t) {
    if (t.length < 8) return null;
    const le = tag(t, 0, "II");
    if (!le && !tag(t, 0, "MM")) return null;
    const r16 = (at) =>
      at >= 0 && at + 2 <= t.length ? (le ? t[at] | (t[at + 1] << 8) : (t[at] << 8) | t[at + 1]) : -1;
    const r32 = (at) =>
      at >= 0 && at + 4 <= t.length
        ? le
          ? (t[at] | (t[at + 1] << 8) | (t[at + 2] << 16) | (t[at + 3] << 24)) >>> 0
          : ((t[at] << 24) | (t[at + 1] << 16) | (t[at + 2] << 8) | t[at + 3]) >>> 0
        : -1;
    if (r16(2) !== 42) return null;
    const at0 = r32(4);
    const n = r16(at0);
    if (n < 0 || n > 200) return null;
    let gps = false;
    let orientation = null;
    for (let i = 0; i < n; i++) {
      const e = at0 + 2 + i * 12;
      if (e + 12 > t.length) return null;
      const entryTag = r16(e);
      if (entryTag === 0x8825) gps = true;
      else if (entryTag === 0x0112) {
        const value = r16(e + 8); // a SHORT's value sits left-justified in the entry's 4-byte value field
        if (r16(e + 2) === 3 && value >= 1 && value <= 8) orientation = value;
      }
    }
    return { gps, orientation };
  }

  // A minimal TIFF structure holding nothing but one Orientation tag: "II", 42, one IFD with one entry, no
  // GPS pointer at all, so there's no place left to find in it. 26 bytes, always little-endian (the byte
  // order is this function's own choice, not the original photo's).
  function buildOrientationTiff(value) {
    const t = new Uint8Array(26);
    t.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0); // "II", 42, IFD0 at TIFF offset 8
    t[8] = 1; // one entry
    t.set([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, value & 0xff, 0, 0, 0], 10); // Orientation, SHORT, 1
    return t; // bytes 22-25 (the next IFD's offset) stay 0: no more directories
  }
  const exifSig = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
  function jpegExifSegment(tiff) {
    const len = exifSig.length + tiff.length + 2;
    const out = new Uint8Array(4 + exifSig.length + tiff.length);
    out.set([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff], 0);
    out.set(exifSig, 4);
    out.set(tiff, 4 + exifSig.length);
    return out;
  }

  // A PNG chunk: 4-byte length, the 4-byte type, the data, then the CRC32 the PNG format requires over the
  // type and data together. The table is built once, the first time any chunk needs one.
  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[i] = c;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function pngChunk(type, data) {
    const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
    const out = new Uint8Array(12 + data.length);
    const len = data.length;
    out.set([(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff], 0);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const crc = crc32(out.subarray(4, 8 + len));
    out.set([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 8 + len);
    return out;
  }

  // A JPEG rebuilt without its place: every marker segment before the image data is walked once (the same
  // bounded way jpegExif reads it, at most 100 of them); the Exif segment that carried a GPS pointer is left
  // out, replaced by a fresh Orientation-only one when it had an Orientation tag to keep, and an XMP text
  // segment is left out too if it names a GPSLatitude. Everything else -- every other segment, and the whole
  // image data onward -- is copied exactly as it was. Returns null when nothing needed removing, or the file
  // doesn't parse this bounded way (the caller then keeps today's advice instead).
  function stripJpegPlace(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    const kept = [];
    let orientation = null;
    let changed = false;
    let stop = -1;
    let p = 2;
    for (let n = 0; n < 100 && p + 4 <= b.length; n++) {
      if (b[p] !== 0xff) {
        stop = p;
        break;
      }
      const marker = b[p + 1];
      if (marker === 0xff) {
        p++;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) {
        stop = p;
        break;
      }
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        p += 2;
        continue;
      }
      const len = u16(b, p + 2);
      if (len < 2) {
        stop = p;
        break;
      }
      const dataStart = p + 4;
      const dataEnd = Math.min(p + 2 + len, b.length);
      let drop = false;
      if (marker === 0xe1 && tag(b, dataStart, "Exif\0\0")) {
        const info = tiffInfo(b.subarray(dataStart + 6, dataEnd));
        if (info?.gps) {
          drop = true;
          changed = true;
          orientation = info.orientation;
        }
      } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
        // Any block of text that names a GPSLatitude: the XMP packet, an extended XMP part, a comment.
        if (/GPS(?:Latitude|Longitude)/.test(latin1.decode(b.subarray(dataStart, dataEnd)))) {
          drop = true;
          changed = true;
        }
      }
      if (!drop) kept.push(b.subarray(p, dataEnd));
      p = dataEnd;
    }
    if (stop < 0 || !changed) return null;
    const head = [
      b.subarray(0, 2),
      ...(orientation != null ? [jpegExifSegment(buildOrientationTiff(orientation))] : []),
      ...kept,
    ];
    const total = head.reduce((n, a) => n + a.length, 0) + (b.length - stop);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of head) {
      out.set(part, at);
      at += part.length;
    }
    out.set(b.subarray(stop), at);
    return out;
  }

  // A PNG rebuilt without its place: every chunk is walked once (the same bounded way pngExif reads them, at
  // most 1,000), an eXIf chunk that carries a GPS pointer is left out, replaced by a fresh Orientation-only
  // one when it had an Orientation tag, inserted right after IHDR (always allowed there, and always before
  // any IDAT); a text chunk naming a GPSLatitude is left out too. Everything else is copied exactly as it
  // was. Returns null when nothing needed removing, or the file doesn't parse this bounded way.
  function stripPngPlace(b) {
    const chunks = [];
    let orientation = null;
    let changed = false;
    let p = 8;
    for (let n = 0; n < 1000 && p + 8 <= b.length; n++) {
      const len = u32(b, p);
      if (len < 0) return null;
      const type = latin1.decode(b.subarray(p + 4, p + 8));
      const end = Math.min(p + 12 + len, b.length);
      let drop = false;
      if (type === "eXIf") {
        const info = tiffInfo(tiffStart(b.subarray(p + 8, Math.min(p + 8 + len, b.length))));
        if (info?.gps) {
          drop = true;
          changed = true;
          orientation = info.orientation;
        }
      } else if (type === "tEXt" || type === "iTXt") {
        if (/GPS(?:Latitude|Longitude)/.test(latin1.decode(b.subarray(p + 8, Math.min(p + 8 + len, b.length))))) {
          drop = true;
          changed = true;
        }
      }
      chunks.push({ type, start: p, end, drop });
      if (type === "IEND") break;
      p = p + 12 + len;
    }
    if (!changed) return null;
    const parts = [b.subarray(0, 8)];
    let inserted = false;
    for (const c of chunks) {
      if (c.type === "IHDR") {
        parts.push(b.subarray(c.start, c.end));
        if (orientation != null && !inserted) {
          parts.push(pngChunk("eXIf", buildOrientationTiff(orientation)));
          inserted = true;
        }
        continue;
      }
      if (!c.drop) parts.push(b.subarray(c.start, c.end));
    }
    const total = parts.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // The bytes of a picture with its place removed, or null for a format this doesn't rebuild (HEIC, WebP) or
  // a file too odd to parse safely. Never mutates `bytes`.
  function stripPlace(bytes) {
    try {
      if (!(bytes instanceof Uint8Array)) return null;
      let out = null;
      if (bytes[0] === 0xff && bytes[1] === 0xd8) out = stripJpegPlace(bytes);
      else if (tag(bytes, 0, "\x89PNG\r\n\x1a\n")) out = stripPngPlace(bytes);
      return out && !placeLeft(out) ? out : null;
    } catch {
      return null;
    }
  }

  // Whether a rebuilt file still carries a place anywhere, not just where the readers above look: place text,
  // or an "Exif\0\0" structure with a GPS pointer (a second picture inside the file, as in MPO files, has its
  // own). The rebuild above copies those parts as they were, so "removed" would be untrue: the caller keeps
  // today's advice instead.
  const PLACE_TEXT = new Uint8Array([..."GPSLatitude"].map((c) => c.charCodeAt(0)));
  function indexOfBytes(b, seq, from) {
    for (let i = b.indexOf(seq[0], from); i >= 0 && i + seq.length <= b.length; i = b.indexOf(seq[0], i + 1)) {
      let k = 1;
      while (k < seq.length && b[i + k] === seq[k]) k++;
      if (k === seq.length) return i;
    }
    return -1;
  }
  function placeLeft(b) {
    if (gpsFrom(b) || indexOfBytes(b, PLACE_TEXT, 0) >= 0 || /GPSLongitude/.test(latin1.decode(b))) return true;
    for (let i = indexOfBytes(b, exifSig, 0); i >= 0; i = indexOfBytes(b, exifSig, i + 1)) {
      if (tiffInfo(b.subarray(i + exifSig.length))?.gps) return true;
    }
    return false;
  }

  // The same file, with its place taken out: a new File, same name and type, built from stripPlace()'s
  // bytes. Null when the format isn't rebuilt here or nothing could be removed, so the caller falls back to
  // today's advice (take the photo off yourself).
  const STRIP_MAX_BYTES = 50 * 1024 * 1024;
  async function removePhotoPlace(file) {
    if (!file || typeof file.arrayBuffer !== "function" || file.size > STRIP_MAX_BYTES) return null;
    const bytes = new Uint8Array(ownBytes(await file.arrayBuffer()));
    const out = stripPlace(bytes);
    if (!out) return null;
    return new File([out], file.name, { type: file.type || "" });
  }

  // ---------- File names that say "passport" ----------
  // A picture named "passport-scan.jpg" is likely a photo of one. A short list of clue words, read from the name's
  // words (split on _ - . spaces, camelCase and between letters and digits, lowercased, accents dropped), single words
  // and pairs, in English first and Spanish too. Never alone: "id", "card", "visa", "statement". Kept honest by a
  // corpus of names (tests/corpus/picture-names.txt) held to the false-alarm floor.
  const CLUES = [
    "passport",
    "pasaporte",
    "license",
    "licence",
    "licencia",
    "driverslicense",
    "driverlicense",
    "drivinglicense",
    "driverslicence",
    "drivinglicence",
    "dl front",
    "dl back",
    "dlfront",
    "dlback",
    "id card",
    "id front",
    "id back",
    "front id",
    "back id",
    "idcard",
    "idfront",
    "idback",
    "national id",
    "nationalid",
    "state id",
    "student id",
    "photo id",
    "dni",
    "cedula",
    "ssn",
    "social security",
    "socialsecurity",
    "seguro social",
    "green card",
    "greencard",
    "residence permit",
    "birth certificate",
    "birthcertificate",
    "acta de nacimiento",
    "acta nacimiento",
    "w 2",
    "1099",
    "tax return",
    "taxreturn",
    "bank statement",
    "bankstatement",
    "estado de cuenta",
    "credit card",
    "creditcard",
    "debit card",
    "debitcard",
    "tarjeta de credito",
    "tarjeta de debito",
    "insurance card",
    "insurancecard",
    "medicare",
    "medicaid",
    // Crypto wallet seed words and 2FA backup codes: stealers and careless screenshots target these by name.
    // "seed" and "wallet" alone catch too much (garden seeds, a photo of a physical wallet), so they're only
    // clues paired with the word that actually says it's a crypto secret.
    "seed phrase",
    "seedphrase",
    "recovery phrase",
    "recoveryphrase",
    "mnemonic",
    "crypto wallet",
    "cryptowallet",
    "wallet seed",
    "backup codes",
    "backupcodes",
    "recovery codes",
    "recoverycodes",
    "passwords",
    "frase semilla",
    "codigos de respaldo",
    "codigos de recuperacion",
    "contrasenas",
  ].map((c) => c.split(" "));
  // A name about the subject, not a picture of someone's document: a template, a sample, a logo, a comparison.
  const ABOUT = new Set([
    ...["template", "templates", "sample", "samples", "example", "examples", "blank", "mockup", "mockups"],
    ...["logo", "logos", "icon", "icons", "comparison", "chart", "clipart", "vector", "illustration"],
  ]);
  // "license" alone is a clue, but never a software license or a license plate.
  const LICENSE = new Set(["license", "licence", "licencia"]);
  const NOT_AN_ID_BEFORE = new Set([
    ...["mit", "apache", "gpl", "agpl", "lgpl", "bsd", "mpl", "isc", "eula", "software", "cc", "creative"],
    ...["commons", "open", "source", "font", "music", "stock", "royalty", "app"],
  ]);
  const NOT_AN_ID_AFTER = new Set(["plate", "plates", "key", "keys", "agreement", "agreements", "terms", "file"]);
  // "1099" is a tax form, and also a photo's number (IMG_1099): only alone, with years, or with a form's words.
  const FORM_1099 = new Set([
    ...["nec", "misc", "int", "div", "b", "r", "k", "g", "sa", "q", "c", "s", "oid", "ltc", "patr", "h", "a"],
    ...["form", "irs", "tax", "my"],
  ]);
  const YEAR = /^(?:19|20)\d\d$/;

  function nameWords(name) {
    return name
      .replace(/\.[A-Za-z0-9]{1,5}$/, "") // the ending (.jpg)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // accents: "Cédula" → "Cedula"
      .replace(/([a-z])([A-Z])/g, "$1 $2") // "MyPassport"
      .replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1 $2") // "IDCard"
      .replace(/([A-Za-z])(\d)/g, "$1 $2") // "W2", "passport2"
      .replace(/(\d)([A-Za-z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(0, 40);
  }

  // The clue words a file's name has (["passport"]), or none. Never throws.
  function nameClues(name) {
    if (typeof name !== "string" || !name) return [];
    const words = nameWords(name.slice(0, 260));
    if (words.some((w) => ABOUT.has(w))) return [];
    const found = new Set();
    for (let i = 0; i < words.length; i++) {
      for (const clue of CLUES) {
        if (clue.some((w, k) => words[i + k] !== w)) continue;
        const before = words[i - 1];
        const after = words[i + clue.length];
        if (clue.length === 1 && LICENSE.has(clue[0]) && (NOT_AN_ID_BEFORE.has(before) || NOT_AN_ID_AFTER.has(after))) {
          continue;
        }
        if (clue[0] === "1099") {
          const alone = words.every((w, k) => k === i || YEAR.test(w));
          if (!alone && !FORM_1099.has(before) && !FORM_1099.has(after)) continue;
        }
        found.add(clue.join(" "));
      }
    }
    return [...found];
  }

  // ---------- What a picture holds, as detect() results ----------
  const kind = (id) => globalThis.Clotr.PATTERNS.find((p) => p.id === id);
  const result = (id, value) => (kind(id) ? [{ ...kind(id), matches: [value] }] : []);

  // A file whose name says it's an ID or a document (a picture, or a PDF with no text, which is a scan): the kind
  // ID or Document Picture, its value the lowercased name (kept in this script; only its fingerprint is recorded,
  // so "fine to share" means this file). Nothing otherwise. Never throws.
  function namedDocument(file) {
    try {
      const name = typeof file?.name === "string" ? file.name : "";
      return nameClues(name).length ? result("id_picture", name.toLowerCase()) : [];
    } catch {
      return [];
    }
  }

  // A picture's findings, in detect()'s shape: [{ id, name, severity, group, matches }]. The values (the name, the
  // place) stay in this content script. Never throws: a picture Clotr can't read gives nothing, and the chat carries
  // on.
  async function readPicture(file) {
    const found = [...namedDocument(file)];
    try {
      const place = await photoLocation(file);
      if (place) found.push(...result("photo_location", place));
    } catch {
      /* unreadable or odd: no location */
    }
    return found;
  }

  Object.assign(globalThis.Clotr, {
    isPicture,
    gpsFrom,
    nameClues,
    namedDocument,
    readPicture,
    stripPlace,
    removePhotoPlace,
  });
})();

// Builds the picture fixtures the tests use, not part of the extension itself. Each one is a small picture built
// byte by byte, some carrying a GPS location the way a camera or phone would save it, and some deliberately broken
// so I can check that a bad file never stalls the chat. Every location is a public landmark, never a real address,
// and nothing here is an actual photo or ID. tests/pictures.test.js and the browser checks PIC5 to PIC8 and PIC13
// build what they need straight from the functions below, so none of these files get committed.
//
// Usage: node tools/make-picture-fixtures.js [folder] writes every fixture to that folder, or to
// tests/e2e/output/pictures if you don't give one. To try a fixture by hand, run this, then attach the file to an
// AI chat with Clotr loaded.
"use strict";

const fs = require("fs");
const path = require("path");
const { crc32, deflateSync } = require("zlib");

// A real 16x16 orange square, saved once from a browser canvas as a JPEG, a WebP and a PNG, each keeping the
// browser's own colour profile. Because a browser can actually draw these, an AI site accepts them like any other
// photo.
const BASE = {
  jpeg: Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAfEAABAgYDAAAAAAAAAAAAAAASBhQAAREWJDJDYqH/xAAUAQEAAAAAAAAAAAAAAAAAAAAG/8QAHhEAAAUFAQAAAAAAAAAAAAAAADFRgZETFCMkYmP/2gAMAwEAAhEDEQA/AKJDpK6Hua1bBxGRF2lTX2C4SVrss105PiARHtOu3kEOrbXe4TpyHKAiXWddvILhW3QywmrY+UyIesqa+wVwUO3WCDHZufNkkx//2Q==",
    "base64",
  ),
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAATUlEQVR4AeyQsQkAIAwEH8dxAXtncQBHcSJrnUr7DyRFClMY+OIhPH+fVsvHowTnBQwoY0ITEwdE4IqW/wiA2GD3Ck08qgjgB8u/D7gAAAD//y2l+qIAAAAGSURBVAMAOq89cbY6YOIAAAAASUVORK5CYII=",
    "base64",
  ),
  webp: Buffer.from(
    "UklGRk4CAABXRUJQVlA4WAoAAAAgAAAADwAADwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggYAAAAFADAJ0BKhAAEAABQCYlsAJ0ugH4AUoDYALn/9ADdqvZACJgAP7rbN/9Ref/qGmP/9OuX/kR+WgtaTA7qVCP5/oaO+bi4WRhf/mhvYYOeiX0txuYyXQMN6oz2pdXsqsAAA==",
    "base64",
  ),
};

// All public landmarks, so no fixture ever holds anyone's home address. I picked a mix north and south of the
// equator and east and west of the prime meridian, to cover every sign combination.
const PLACES = {
  liberty: { lat: 40.689247, lon: -74.044502 }, // the Statue of Liberty, New York
  opera: { lat: -33.856784, lon: 151.215297 }, // the Opera House, Sydney
  eiffel: { lat: 48.85837, lon: 2.294481 }, // the Eiffel Tower, Paris
  bigBen: { lat: 51.500729, lon: -0.124625 }, // Big Ben, London
  tokyo: { lat: 35.658581, lon: 139.745433 }, // Tokyo Tower
};

const ascii = (s) => Buffer.from(s, "latin1");
const u16be = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

// ---------- EXIF (a TIFF structure) ----------
// Cameras write GPS coordinates as degrees, minutes and seconds, each as a fraction. Pass parts as 2 to write
// decimal minutes instead, or 1 for decimal degrees, since some phones save it that way.
function rationals(value, parts) {
  const a = Math.abs(value);
  if (parts === 1) return [[Math.round(a * 1e6), 1e6]];
  const deg = Math.floor(a);
  const minutes = (a - deg) * 60;
  if (parts === 2)
    return [
      [deg, 1],
      [Math.round(minutes * 1e4), 1e4],
    ];
  const min = Math.floor(minutes);
  return [
    [deg, 1],
    [min, 1],
    [Math.round((minutes - min) * 60 * 1000), 1000],
  ];
}

// Builds a TIFF block holding a camera name and, unless gps is false, a GPS directory with the location. The rest
// of the options exist to build hostile variants: gpsAt moves where the GPS pointer actually points, gpsCount lies
// about how many entries that directory holds, ratAt moves where the latitude numbers are read from, den overrides
// every fraction's denominator, and refs set to false drops the N/S and E/W letters entirely.
function tiffGps({
  lat = PLACES.liberty.lat,
  lon = PLACES.liberty.lon,
  bigEndian = false,
  gps = true,
  parts = 3,
  signed = false,
  refs = true,
  gpsAt = null,
  gpsCount = null,
  ratAt = null,
  den = null,
} = {}) {
  const w16 = (b, o, n) => (bigEndian ? b.writeUInt16BE(n, o) : b.writeUInt16LE(n, o));
  const w32 = (b, o, n) => (bigEndian ? b.writeUInt32BE(n >>> 0, o) : b.writeUInt32LE(n >>> 0, o));
  const make = ascii("Clotr test camera\0");
  const ifd0Entries = gps ? 2 : 1;
  const ifd0 = 8;
  const gpsIfd = ifd0 + 2 + ifd0Entries * 12 + 4;
  const gpsTags = [];
  const latR = rationals(lat, parts);
  const lonR = rationals(lon, parts);
  const gpsEntries = gps ? (refs ? 4 : 2) : 0;
  const dataAt = gpsIfd + (gps ? 2 + gpsEntries * 12 + 4 : 0);
  const latAt = dataAt;
  const lonAt = latAt + latR.length * 8;
  const makeAt = lonAt + lonR.length * 8;
  const b = Buffer.alloc(makeAt + make.length);
  b.write(bigEndian ? "MM" : "II", 0, "latin1");
  w16(b, 2, 42);
  w32(b, 4, ifd0);
  w16(b, ifd0, ifd0Entries);
  const entry = (at, tag, type, count, value) => {
    w16(b, at, tag);
    w16(b, at + 2, type);
    w32(b, at + 4, count);
    if (typeof value === "string") b.write(value, at + 8, "latin1");
    else w32(b, at + 8, value);
  };
  entry(ifd0 + 2, 0x010f, 2, make.length, makeAt);
  if (gps) entry(ifd0 + 14, 0x8825, 4, 1, gpsAt ?? gpsIfd);
  w32(b, ifd0 + 2 + ifd0Entries * 12, 0);
  if (gps) {
    w16(b, gpsIfd, gpsCount ?? gpsEntries);
    const type = signed ? 10 : 5;
    if (refs) gpsTags.push([1, 2, 2, lat < 0 ? "S\0" : "N\0"]);
    gpsTags.push([2, type, latR.length, ratAt ?? latAt]);
    if (refs) gpsTags.push([3, 2, 2, lon < 0 ? "W\0" : "E\0"]);
    gpsTags.push([4, type, lonR.length, lonAt]);
    gpsTags.forEach(([tag, t, count, value], i) => entry(gpsIfd + 2 + i * 12, tag, t, count, value));
    w32(b, gpsIfd + 2 + gpsEntries * 12, 0);
    const writeRats = (at, rats, negative) =>
      rats.forEach(([num, d], i) => {
        // Signed rationals without the letters carry the sign in the degrees.
        w32(b, at + i * 8, signed && negative && !refs && i === 0 ? -num : num);
        w32(b, at + i * 8 + 4, den ?? d);
      });
    writeRats(latAt, latR, lat < 0);
    writeRats(lonAt, lonR, lon < 0);
  }
  make.copy(b, makeAt);
  return b;
}

// ---------- JPEG ----------
const segment = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data]);
const exifSegment = (tiff) => segment(0xe1, Buffer.concat([ascii("Exif\0\0"), tiff]));

// Inserts extra segments into the base JPEG right after its start marker, which is where a camera would put EXIF.
function jpegWith(...segments) {
  return Buffer.concat([BASE.jpeg.subarray(0, 2), ...segments, BASE.jpeg.subarray(2)]);
}
const jpegWithGps = (opts) => jpegWith(exifSegment(tiffGps(opts)));

// Some photo editors write the location as XMP text instead of EXIF numbers, in the form "DDD,MM,SSk" or
// "DDD,MM.mmk".
function xmpPacket(lat, lon) {
  return (
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
    'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
    `exif:GPSLatitude="${lat}" exif:GPSLongitude="${lon}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}
const jpegWithXmp = (lat = "40,41.35482N", lon = "74,2.67012W") =>
  jpegWith(segment(0xe1, Buffer.concat([ascii("http://ns.adobe.com/xap/1.0/\0"), ascii(xmpPacket(lat, lon))])));

// ---------- PNG ----------
function chunk(type, data) {
  const body = Buffer.concat([ascii(type), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
}
// Inserts extra chunks into the base PNG right after its header chunk, which ends 33 bytes in.
const pngWith = (...chunks) => Buffer.concat([BASE.png.subarray(0, 33), ...chunks, BASE.png.subarray(33)]);
const pngWithGps = (opts) => pngWith(chunk("eXIf", tiffGps(opts)));

// ---------- WebP ----------
// The base WebP already uses the extended form, with a VP8X chunk first, so this just sets its EXIF flag and
// appends an EXIF chunk at the end.
function webpWithGps(opts) {
  const tiff = tiffGps(opts);
  const exif = Buffer.concat([
    ascii("EXIF"),
    Buffer.alloc(4),
    tiff,
    tiff.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
  exif.writeUInt32LE(tiff.length, 4);
  const out = Buffer.concat([BASE.webp, exif]);
  out.writeUInt32LE(out.length - 8, 4);
  out[20] |= 0x08; // VP8X flags: EXIF present
  return out;
}

// ---------- HEIC, HEIF and AVIF: the iPhone's format, built from boxes nested inside boxes ----------
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32be(body.length + 8), ascii(type), body]);
};
const fullBox = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);
const uint = (n, size) => (size === 8 ? Buffer.concat([u32be(Math.floor(n / 2 ** 32)), u32be(n % 2 ** 32)]) : u32be(n));

// An EXIF item is the four-byte TIFF start offset, the "Exif" marker, then the TIFF block itself.
const exifItem = (tiff) => Buffer.concat([u32be(6), ascii("Exif\0\0"), tiff]);

// Builds a HEIF file as three boxes in sequence: ftyp, then meta (the item list and where each item's bytes live),
// then mdat (the bytes themselves). far pads that many extra bytes before the EXIF item, so I can test one that
// sits past the first 256 KB. method set to 1, together with ilocVersion 1 or 2, keeps the EXIF data inside the
// meta box itself instead of mdat. ilocVersion, offsetSize and baseOffset cover the different ways real writers
// describe where an item's bytes are.
function heifWithGps({
  brand = "heic",
  ilocVersion = 0,
  method = 0,
  offsetSize = 4,
  baseOffset = false,
  far = 0,
  tiff = tiffGps(),
  payload = exifItem(tiff),
} = {}) {
  const image = brand.startsWith("avi") ? "av01" : "hvc1";
  const ftyp = box("ftyp", ascii(brand), u32be(0), ascii(brand), ascii("mif1"), ascii("miaf"));
  const imageBytes = Buffer.alloc(16, 0x11);
  const id = (n) => (ilocVersion === 2 ? u32be(n) : u16be(n));
  const iloc = (imageAt, exifAt) => {
    const base = baseOffset ? 16 : 0;
    const item = (n, at, length, construction) =>
      Buffer.concat([
        id(n),
        ilocVersion >= 1 ? u16be(construction) : Buffer.alloc(0),
        u16be(0),
        baseOffset ? u32be(base) : Buffer.alloc(0),
        u16be(1),
        uint(at - base, offsetSize),
        uint(length, 4),
      ]);
    return fullBox(
      "iloc",
      ilocVersion,
      Buffer.from([(offsetSize << 4) | 4, (baseOffset ? 4 : 0) << 4]),
      ilocVersion === 2 ? u32be(2) : u16be(2),
      item(1, imageAt, imageBytes.length, 0),
      method === 1 ? item(2, exifAt, payload.length, 1) : item(2, exifAt, payload.length, 0),
    );
  };
  const meta = (imageAt, exifAt) =>
    fullBox(
      "meta",
      0,
      fullBox("hdlr", 0, u32be(0), ascii("pict"), Buffer.alloc(12), Buffer.from([0])),
      fullBox("pitm", 0, u16be(1)),
      fullBox(
        "iinf",
        0,
        u16be(2),
        fullBox("infe", 2, u16be(1), u16be(0), ascii(image), Buffer.from([0])),
        fullBox("infe", 2, u16be(2), u16be(0), ascii("Exif"), Buffer.from([0])),
      ),
      iloc(imageAt, exifAt),
      ...(method === 1 ? [box("idat", payload)] : []),
    );
  const metaSize = meta(0, 0).length; // the offsets don't change its size
  const dataAt = ftyp.length + metaSize + 8;
  const exifAt = method === 1 ? 0 : dataAt + imageBytes.length + far;
  const mdat = box("mdat", imageBytes, Buffer.alloc(far), method === 1 ? Buffer.alloc(0) : payload);
  return Buffer.concat([ftyp, meta(dataAt, exifAt), mdat]);
}

// ---------- Hostile pictures: each one must fail fast with "no location" and never throw ----------
function hostile() {
  const good = jpegWithGps();
  const heic = heifWithGps();
  const ftyp = box("ftyp", ascii("heic"), u32be(0), ascii("mif1"));
  // A PNG whose header claims it's 60,000 by 60,000 pixels, big enough to be a decompression bomb for anything
  // that tries to draw it.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(60000, 0);
  ihdr.writeUInt32BE(60000, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const hugePng = Buffer.concat([BASE.png.subarray(0, 8), chunk("IHDR", ihdr), BASE.png.subarray(33)]);
  const exifIn = (tiffOpts) => jpegWith(exifSegment(tiffGps(tiffOpts)));
  return {
    "huge-60000x60000.png": hugePng,
    "chunk-claims-4gb.png": Buffer.concat([
      BASE.png.subarray(0, 33),
      u32be(0xfffffff0),
      ascii("IDAT"),
      Buffer.alloc(64),
    ]),
    "exif-claims-4gb.png": Buffer.concat([
      BASE.png.subarray(0, 33),
      u32be(0xfffffff0),
      ascii("eXIf"),
      Buffer.alloc(64),
    ]),
    "corrupt.jpg": Buffer.concat([
      BASE.jpeg.subarray(0, 2),
      Buffer.from([0xff, 0xe1, 0x00, 0x01]),
      Buffer.alloc(300, 0xff),
    ]),
    "truncated.jpg": good.subarray(0, 60),
    "garbage.jpg": Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256)),
    "gps-points-past-the-end.jpg": exifIn({ gpsAt: 0x7ffffff0 }),
    "gps-points-at-itself.jpg": exifIn({ gpsAt: 8 }),
    "gps-claims-65535-entries.jpg": exifIn({ gpsCount: 65535 }),
    "numbers-past-the-end.jpg": exifIn({ ratAt: 0xfffffff0 }),
    "divide-by-zero.jpg": exifIn({ den: 0 }),
    "zero-zero.jpg": exifIn({ lat: 0, lon: 0 }),
    "out-of-range.jpg": exifIn({ lat: 95, lon: 200 }),
    "no-location.jpg": exifIn({ gps: false }),
    "box-smaller-than-itself.heic": Buffer.concat([ftyp, u32be(4), ascii("meta"), Buffer.alloc(64)]),
    "box-with-empty-large-size.heic": Buffer.concat([ftyp, u32be(1), ascii("meta"), Buffer.alloc(8), Buffer.alloc(64)]),
    "ten-thousand-empty-boxes.heic": Buffer.concat([ftyp, ...Array.from({ length: 10000 }, () => box("free"))]),
    "meta-boxes-without-end.heic": Buffer.concat([
      ftyp,
      ...Array.from({ length: 5000 }, () => Buffer.concat([u32be(12), ascii("meta"), Buffer.alloc(4)])),
    ]),
    "item-past-the-end.heic": heic.subarray(0, heic.length - 40),
    // Finds the EXIF item's length field inside the item list. Version 0 with 4-byte offsets lays that list out
    // as 4 bytes of version, 2 bytes of sizes, 2 bytes of count, then 14 bytes per item.
    "item-claims-4gb.heic": (() => {
      const b = Buffer.from(heic);
      b.writeUInt32BE(0xffffffff, b.indexOf(ascii("iloc")) + 4 + 4 + 2 + 2 + 14 + 10); // the EXIF item's length
      return b;
    })(),
    // Claims 65,535 items in the list, but only writes two, and neither one is the EXIF item.
    "iloc-claims-65535-items.heic": (() => {
      const b = Buffer.from(heic);
      const at = b.indexOf(ascii("iloc"));
      b.writeUInt16BE(65535, at + 4 + 4 + 2);
      b.writeUInt16BE(3, at + 4 + 4 + 2 + 2 + 14);
      return b;
    })(),
    "exif-without-tiff.heic": heifWithGps({ tiff: Buffer.alloc(0) }),
    "exif-start-past-the-end.heic": heifWithGps({ payload: Buffer.concat([u32be(0xfffffff0), ascii("Exif\0\0")]) }),
  };
}

// ---------- PDF ----------
// Builds a one-page PDF. When scanned is true the page is just the base JPEG, the way a scanner would produce it,
// with no text to read; otherwise the page holds the text string you pass in. compressed packs that text with
// FlateDecode, the way most real PDFs store it.
function pdf({ scanned = true, text = "Notes from the meeting", compressed = false } = {}) {
  const NL = "\n";
  const words = ascii(scanned ? "q 200 0 0 200 0 0 cm /Im0 Do Q" : `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`);
  const content = compressed ? deflateSync(words) : words;
  const parts = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << " +
      (scanned
        ? "/XObject << /Im0 5 0 R >>"
        : "/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>") +
      " >> >> endobj",
    `4 0 obj << /Length ${content.length}${compressed ? " /Filter /FlateDecode" : ""} >>`,
    "stream",
    "",
  ].join(NL);
  const image = scanned
    ? Buffer.concat([
        ascii(
          `${NL}5 0 obj << /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB ` +
            `/BitsPerComponent 8 /Filter /DCTDecode /Length ${BASE.jpeg.length} >>${NL}stream${NL}`,
        ),
        BASE.jpeg,
        ascii(`${NL}endstream endobj`),
      ])
    : Buffer.alloc(0);
  return Buffer.concat([
    ascii(parts),
    content,
    ascii(`${NL}endstream endobj`),
    image,
    ascii(`${NL}trailer << /Root 1 0 R >>${NL}%%EOF${NL}`),
  ]);
}

// A real JPEG with a location, padded out with mb megabytes of empty bytes. The browser checks use this to build
// their 25 MB file.
const bigJpeg = (mb) => Buffer.concat([jpegWithGps(), Buffer.alloc(mb * 1024 * 1024)]);

// Every fixture, keyed by the file name it gets written under.
function all() {
  const { liberty, opera } = PLACES;
  return {
    "photo-with-location.jpg": jpegWithGps(liberty),
    "photo-with-location-big-endian.jpg": jpegWithGps({ ...opera, bigEndian: true }),
    "photo-with-location.png": pngWithGps(opera),
    "photo-with-location.webp": webpWithGps(liberty),
    "photo-with-location.heic": heifWithGps({ tiff: tiffGps(opera) }),
    "photo-with-location.avif": heifWithGps({ brand: "avif", ilocVersion: 1, tiff: tiffGps(liberty) }),
    "photo-with-location.tiff": tiffGps(opera),
    "photo-with-location-xmp.jpg": jpegWithXmp(),
    "photo-without-location.jpg": BASE.jpeg,
    "passport-scan.jpg": BASE.jpeg,
    "w2-2025.pdf": pdf(),
    "w2 notes.pdf": pdf({ scanned: false }),
    ...Object.fromEntries(Object.entries(hostile()).map(([name, bytes]) => [`hostile-${name}`, bytes])),
  };
}

module.exports = {
  BASE,
  PLACES,
  tiffGps,
  jpegWith,
  jpegWithGps,
  jpegWithXmp,
  exifSegment,
  segment,
  pngWithGps,
  webpWithGps,
  heifWithGps,
  hostile,
  pdf,
  bigJpeg,
  all,
};

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "tests", "e2e", "output", "pictures"));
  fs.mkdirSync(dir, { recursive: true });
  const files = all();
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  console.log(`${Object.keys(files).length} picture fixtures in ${dir}`);
}

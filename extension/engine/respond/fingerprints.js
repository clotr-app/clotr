// Salted one-way fingerprints of a value, the one form every way of writing it shares, and the word-edge
// checks Hide it uses. Pages, apps, decide.js and the vault read them through globalThis.Clotr.
(() => {
  "use strict";

  const { numberRuns, addressCore, isClosedLetter, closedLength, closedHead } = globalThis.Clotr;
  const { cleanText } = globalThis.ClotrInternal;

  // ---------- Fingerprints: salted and one-way, so the value itself is never stored ----------

  // Misspelled big providers (as in rules/personal/email-addresses.js), so a typo'd address still matches your own.
  const PROVIDER_TYPOS = {
    gmial: "gmail",
    gmal: "gmail",
    gamil: "gmail",
    gmaill: "gmail",
    gnail: "gmail",
    yaho: "yahoo",
    yahooo: "yahoo",
    yahho: "yahoo",
    hotmial: "hotmail",
    hotmal: "hotmail",
    hotmai: "hotmail",
    homail: "hotmail",
    outlok: "outlook",
    outloook: "outlook",
    iclod: "icloud",
    icoud: "icloud",
  };

  // ---------- One form for every way a value is written ----------
  // Normalizes a value so the same detail matches however it's written: "(555) 555-5636" = "five five five…", and
  // "Bob@Gmail.com" = "bob at gmail dot com".
  // Letters that keep their mark under NFD (ł, đ) map to what a keyboard without them types. Arabic and Persian fold
  // too (ی = ي, ک = ك, ة = ه, tatweel dropped), but alef maksura (ى) stays, or "على" ("on") would match every "علي".
  const PLAIN_LETTER = {
    ł: "l",
    đ: "d",
    ð: "d",
    ø: "o",
    ß: "ss",
    æ: "ae",
    œ: "oe",
    ı: "i",
    ħ: "h",
    þ: "th",
    ŧ: "t",
    "\u06cc": "\u064a",
    "\u06a9": "\u0643",
    "\u0629": "\u0647",
    "\u0640": "",
  };
  const plainLetters = (text) =>
    text.replace(/[łđðøßæœıħþŧ\u06cc\u06a9\u0629\u0640]/g, (letter) => PLAIN_LETTER[letter]);
  // A hyphen between two words of a saved phrase reads as a space ("Jean-Luc" = "Jean Luc").
  const HYPHEN_JOIN = /(?<=[\p{L}\p{N}\p{M}])-(?=[\p{L}\p{N}])/gu;
  // An apostrophe inside a name reads as nothing ("Ta'Shawn" = "Ta`Shawn" = "TaShawn"), as a username or email writes
  // it. Not before a contraction's ending ("She'll" is never a saved "Shell"), and not after a word's first letter or
  // "qu" ("J'ai", "qu'il", "o'clock"): those read as "'" whatever mark was typed. "O'Brien" keeps it the same way,
  // in any case, and is also saved without it (`all`, wordEntry's `joined`).
  const APOSTROPHE_JOIN = /(?<=[\p{L}\p{M}])['\u2019\u02bc`\u00b4](?=\p{L})/gu;
  const CONTRACTION_END = /^(?:ll|re|ve|d|m|t|s)(?![\p{L}\p{M}])/iu;
  const ELIDED = /(?<![\p{L}\p{N}\p{M}])(?:\p{L}|[Qq][Uu])\p{M}*$/u;
  const joinApostrophes = (text, all = false) =>
    text.replace(APOSTROPHE_JOIN, (_mark, at) => {
      if (CONTRACTION_END.test(text.slice(at + 1, at + 4))) return "'";
      return !all && ELIDED.test(text.slice(Math.max(0, at - 8), at)) ? "'" : "";
    });
  // Half-width katakana (ﾔﾏﾀﾞ, as bank transfers and older systems write names) read as the full-width letters.
  const fullWidthKana = (text) => text.replace(/[\uff61-\uff9f]+/g, (run) => run.normalize("NFKC"));
  // Between two letters of a script written without spaces, a space or a katakana middle dot is no break in a saved
  // word: Chinese, Japanese and Korean names are written with and without one ("\u5c71\u7530 \u592a\u90ce" =
  // "\u5c71\u7530\u592a\u90ce", "\u30b8\u30e7\u30f3\u30fb\u30b9\u30df\u30b9" =
  // "\u30b8\u30e7\u30f3\u30b9\u30df\u30b9", "\uae40 \ubbfc\uc218" = "\uae40\ubbfc\uc218").
  const CLOSED_GAP = /[ \u30fb]+/g;
  // The character that ends at "at", both halves of it when it's an emoji or another two-part character.
  const charEndingAt = (text, at) =>
    /[\udc00-\udfff]/.test(text[at - 1] || "") ? text.slice(at - 2, at) : text[at - 1];
  const closedJoin = (text) =>
    text.replace(CLOSED_GAP, (gap, at) => {
      const next = text.slice(at + gap.length, at + gap.length + 2);
      return isClosedLetter(charEndingAt(text, at)) && isClosedLetter(next) ? "" : gap;
    });

  // Letters of the scripts written without spaces that cleanText leaves exactly as they are (all but their digits
  // and the Hangul and Khmer fillers it drops), so a stretch of only these needs no cleaning. The vault looks up
  // every stretch of such text by fingerprint, and cleaning each one again would be most of that work.
  const DIGITS_AND_FILLERS = String.raw`\p{Nd}|\u115f|\u1160|\u3164|\uffa0|\u17b4|\u17b5`;
  const EAST_ASIAN_SCRIPTS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
  const SOUTHEAST_ASIAN_SCRIPTS = String.raw`\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}`;
  const CLEAN_ALREADY = new RegExp(
    String.raw`^(?:(?!${DIGITS_AND_FILLERS})[${EAST_ASIAN_SCRIPTS}${SOUTHEAST_ASIAN_SCRIPTS}])+$`,
    "u",
  );

  function normalize(patternId, raw) {
    // invisible characters and look-alike digits don't change a fingerprint
    const match = CLEAN_ALREADY.test(raw) ? raw : cleanText(raw).clean;
    if (patternId === "phone_number" || patternId === "us_ssn" || patternId === "credit_card") {
      // A bracketed trunk 0 is dropped, since "+44 (0)20…" and "+44 20…" are the same number dialed from abroad.
      const written = patternId === "phone_number" ? match.replace(/\(\s*0\s*\)/g, "") : match;
      let digits = numberRuns(written)
        .flatMap((run) => run.units)
        .map((unit) => unit.digits)
        .join("");
      // A US number with its leading 1, and "0044…" for "+44…", are the same number.
      if (patternId === "phone_number" && digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
      if (patternId === "phone_number" && /^00[1-9]/.test(digits)) digits = digits.slice(2);
      return `${patternId}:${digits}`;
    }
    if (patternId === "email") {
      // Spaces in front of a separator are taken only from the start of their run: a replacement that fails from
      // the start of a run fails from anywhere inside it too, and trying every space again would make a long run
      // quadratic. A separator right after an earlier replacement's spaces still starts one of its own.
      const address = match
        .toLowerCase()
        .replace(/(?:(?<!\s)\s+)?[([{<]\s*at\s*[)\]}>]\s*|(?<!\s)\s+(?:at|arroba)\s+|(?:(?<!\s)\s+)?@\s*/g, "@")
        .replace(
          /(?:(?<!\s)\s+)?[([{<]\s*(?:dot|punto)\s*[)\]}>]\s*|(?<!\s)\s+(?:dot|punto)\s+|(?:(?<!\s)\s+)?\.\s*/g,
          ".",
        )
        .replace(/\s+/g, "");
      // "janedoe at yahoo" is janedoe@yahoo.com, and "bob at gmial dot com" is bob@gmail.com.
      const full = /@[a-z0-9-]+$/.test(address) ? `${address}.com` : address;
      return `email:${full.replace(/@([a-z]+)\.com$/, (_m, host) => `@${PROVIDER_TYPOS[host] || host}.com`)}`;
    }
    // ID formats match either case ("ab-123456" = "AB-123456"), so their fingerprints do too.
    if (patternId === "my_id") return `my_id:${match.toLowerCase().trim()}`;
    // A VIN or a plate is the same in any case, with or without spaces and dashes.
    if (patternId === "vin" || patternId === "license_plate") {
      return `${patternId}:${match.toUpperCase().replace(/[\s\-·]+/g, "")}`;
    }
    // A gamer tag is the same in any case ("xXSniperXx" = "xxsniperxx"), with any spacing in a Riot name.
    if (patternId === "gamer_tag") return `gamer_tag:${match.toLowerCase().replace(/\s+/g, " ").trim()}`;
    // Your words match with or without accents ("José García" = "Jose Garcia"), marked letters ("Łukasz" = "Lukasz",
    // "Weiß" = "WEISS"), either katakana width and either keyboard's Arabic letters. "watch_list_accented" and
    // "watch_list_marks" rebuild older saved forms (from before 0.9.67, and before marked letters were folded).
    const words = (text = match) => text.toLowerCase().replace(/\s+/g, " ").trim();
    const unmarked = (text = words()) => text.normalize("NFD").replace(/\p{M}/gu, "");
    // Today's form; the half-width kana are widened before marks come off, so "ﾀﾞ" loses its mark as "ダ" does.
    const plain = (text) => plainLetters(unmarked(fullWidthKana(words(text))));
    // A hyphen between two words reads as a space ("Jean-Luc" = "Jean Luc"), an apostrophe inside a word as nothing
    // ("O'Brien" = "OBrien"), and a space or a middle dot between two letters of a script written without spaces as
    // nothing ("山田 太郎" = "山田太郎").
    if (patternId === "watch_list" || patternId === "watch_list_joined") {
      const joined = joinApostrophes(match, patternId === "watch_list_joined");
      return `watch_list:${closedJoin(plain(joined).replace(HYPHEN_JOIN, " "))}`;
    }
    // The form saved before those: hyphens, apostrophes, spaces and middle dots as typed.
    if (patternId === "watch_list_spaced") return `watch_list:${plain()}`;
    if (patternId === "watch_list_marks") return `watch_list:${unmarked()}`;
    if (patternId === "watch_list_accented") return `watch_list:${words()}`;
    // The same person or employer however it's typed, for history repeats and the reply check.
    if (patternId === "my_name" || patternId === "family_name" || patternId === "employer") {
      return `${patternId}:${plain()}`;
    }
    // Addresses too match with or without accents ("Calle Alcalá 45" = "calle alcala 45"). Entries saved before
    // 0.9.68 kept the accents, and "street_address_accented" reproduces that form.
    if (patternId === "street_address" || patternId === "street_address_accented") {
      const core = addressCore(match) || words();
      return `street_address:${patternId === "street_address" ? core.normalize("NFD").replace(/\p{M}/gu, "") : core}`;
    }
    return `${patternId}:${match}`;
  }

  // ---------- SHA-256 ----------
  // Synchronous SHA-256 (hex), so a send can be checked the instant Enter is pressed.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  const SHA_START = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // The vault's words are looked up by fingerprint for every stretch of text that could be one, so this runs a
  // great many times on short strings: it encodes UTF-8 itself (a lone surrogate as U+FFFD, as TextEncoder does)
  // into one reused buffer, and works in 32-bit integers, with nothing allocated per call but the answer.
  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  const SHA_KEEP = 1 << 16; // a buffer up to this size is kept for the next call; a bigger one is let go
  let shaBuffer = new Uint8Array(1024);
  const shaW = new Int32Array(64);
  const shaH = new Int32Array(8);
  function sha256(str) {
    const need = Math.ceil((str.length * 3 + 9) / 64) * 64;
    let bytes = shaBuffer;
    if (need > bytes.length) {
      bytes = new Uint8Array(need);
      if (need <= SHA_KEEP) shaBuffer = bytes;
    }
    // The text as UTF-8.
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) bytes[n++] = c;
      else if (c < 0x800) {
        bytes[n++] = 0xc0 | (c >> 6);
        bytes[n++] = 0x80 | (c & 63);
      } else {
        if (c >= 0xd800 && c <= 0xdfff) {
          const next = str.charCodeAt(i + 1);
          if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
            i++;
            bytes[n++] = 0xf0 | (c >> 18);
            bytes[n++] = 0x80 | ((c >> 12) & 63);
            bytes[n++] = 0x80 | ((c >> 6) & 63);
            bytes[n++] = 0x80 | (c & 63);
            continue;
          }
          c = 0xfffd;
        }
        bytes[n++] = 0xe0 | (c >> 12);
        bytes[n++] = 0x80 | ((c >> 6) & 63);
        bytes[n++] = 0x80 | (c & 63);
      }
    }
    // Padding: a 1 bit, zeros, then the length in bits.
    const len = Math.ceil((n + 9) / 64) * 64;
    bytes.fill(0, n, len);
    bytes[n] = 0x80;
    const high = Math.floor(n / 0x20000000);
    const low = (n * 8) >>> 0;
    for (let i = 0; i < 4; i++) {
      bytes[len - 8 + i] = (high >>> (24 - 8 * i)) & 255;
      bytes[len - 4 + i] = (low >>> (24 - 8 * i)) & 255;
    }
    const w = shaW;
    const h = shaH;
    h.set(SHA_START);
    // Each 64-byte block: its message schedule, then the 64 rounds.
    for (let off = 0; off < len; off += 64) {
      for (let i = 0; i < 16; i++) {
        const p = off + i * 4;
        w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
      }
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h[0];
      let b = h[1];
      let c = h[2];
      let d = h[3];
      let e = h[4];
      let f = h[5];
      let g = h[6];
      let hh = h[7];
      for (let i = 0; i < 64; i++) {
        const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += hh;
    }
    let out = "";
    for (let i = 0; i < 8; i++) {
      const x = h[i];
      out += HEX[(x >>> 24) & 255] + HEX[(x >>> 16) & 255] + HEX[(x >>> 8) & 255] + HEX[x & 255];
    }
    return out;
  }

  // ---------- Fingerprints and vault words ----------
  // 16 hex chars of SHA-256(salt + normalized value). Every text span is checked against vault words while someone
  // types (vaultMatches in vault/saved-words.js), so this one round must stay cheap. Every saved watch-list and team
  // word uses it.
  const fingerprint = (salt, patternId, match) => sha256(salt + normalize(patternId, match)).slice(0, 16);

  // The stronger fingerprint (scheme 2): 1,000 rounds, each folding in its round number so a GPU can't skip ahead.
  // Only for values worked out once per finding (vault values, history, reply mentions). Still 16 hex characters.
  const FINGERPRINT_ROUNDS = 1000;
  function fingerprintStrong(salt, patternId, match) {
    let out = sha256(salt + normalize(patternId, match));
    for (let i = 1; i < FINGERPRINT_ROUNDS; i++) out = sha256(out + i);
    return out.slice(0, 16);
  }

  // Picks a stored entry's scheme: 2 is the strong fingerprint, anything else (or none, as on older entries) the
  // single round. A hash can't be upgraded in place, so an old entry keeps matching until its value is typed again.
  const fingerprintFor = (scheme, salt, patternId, match) =>
    scheme === 2 ? fingerprintStrong(salt, patternId, match) : fingerprint(salt, patternId, match);

  // A word or phrase to save in the vault (the vault page, a team's words): its fingerprint, its count of words
  // between spaces and, for one written only in a script without spaces, its count of letters (closedLength in
  // vault/saved-phrases.js) and the few bits of its head (closedHead), so detect() looks for it inside such text only
  // in stretches that long that start that way. Never the phrase.
  function wordEntry(salt, type, phrase) {
    // Its words are counted at hyphens too, as its fingerprint reads one as a space.
    const words = phrase.trim().split(/\s+|(?<=[\p{L}\p{N}\p{M}])-(?=[\p{L}\p{N}])/u).length;
    const entry = { kind: "word", type, fp: fingerprint(salt, "watch_list", phrase), words };
    // A name like O'Brien keeps its apostrophe as an elision does, so its form without one ("OBrien", a username's
    // "obrien") is a second fingerprint.
    const joined = fingerprint(salt, "watch_list_joined", phrase);
    if (joined !== entry.fp) entry.joined = joined;
    const closed = closedLength(phrase);
    if (closed) Object.assign(entry, { closed, head: closedHead(salt, phrase) });
    return entry;
  }

  // ---------- A word's edges ----------
  // Where a saved word stands as its own word, for Hide it (cover-values.js). One ASCII character is read by its
  // code and the rest by Unicode property, since a long paste can hold thousands of edges.
  const asciiCode = (char) => (char && char.length === 1 && char.charCodeAt(0) < 128 ? char.charCodeAt(0) : -1);
  const isAsciiDigit = (code) => code >= 48 && code <= 57;
  const isAsciiHex = (code) => isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
  const isAsciiWord = (code) => isAsciiDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  // A mark on the letter before it (an accent typed on its own, a Devanagari or Thai vowel sign) is part of a word.
  const wordChar = (char) => {
    const code = asciiCode(char);
    return code >= 0 ? isAsciiWord(code) : Boolean(char) && /[\p{L}\p{N}\p{M}]/u.test(char);
  };
  const isNumber = (char) => {
    const code = asciiCode(char);
    return code >= 0 ? isAsciiDigit(code) : /\p{N}/u.test(char);
  };
  // In a script without spaces (Chinese, Japanese, Thai, Korean with its particles) a saved word stands as one beside
  // any letter, and a word in another script stands as one beside theirs ("我叫Ann。").
  // No ASCII character belongs to a script written without spaces.
  const isClosedEdge = (char) => asciiCode(char) < 0 && isClosedLetter(char);
  // A digit beside a letter is a word's edge too, as the vault reads a joined word's pieces ("smith1990").
  const edgeInside = (edge, beside) =>
    wordChar(edge) &&
    !isClosedEdge(edge) &&
    wordChar(beside) &&
    !isClosedEdge(beside) &&
    isNumber(edge) === isNumber(beside);
  const insideWord = (match, before, after) => edgeInside(match[0], before) || edgeInside(lastLetter(match), after);
  // The last letter of `match` with any marks on it stepped over, so a Thai or Devanagari word ending in a vowel sign
  // is read by its letter.
  const lastLetter = (match) => {
    let i = match.length - 1;
    if (match.charCodeAt(i) < 0x300) return match[i]; // no mark comes before U+0300
    while (i > 0 && /\p{M}/u.test(match[i])) i--;
    return match[i];
  };

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    normalize,
    sha256,
    fingerprint,
    fingerprintStrong,
    fingerprintFor,
    wordEntry,
    isAsciiHex,
    isAsciiWord,
    wordChar,
    edgeInside,
    insideWord,
    lastLetter,
  };
})();

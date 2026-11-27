// Moving to a new computer: one file, encrypted with a password the person chooses.
// It holds settings, the vault's fingerprints and formats, the salt and the PIN's hash.
// Never history, never a value.
// Encrypted on this computer with Web Crypto (PBKDF2-SHA-256, 600,000 rounds, then AES-GCM 256).
// Nothing is sent.
// Classic script: adds globalThis.Clotr.Backup (Clotr's pages, the background, and the unit tests).
(() => {
  "use strict";

  const Clotr = (globalThis.Clotr = globalThis.Clotr || {});

  // ---------- The file ----------

  const FORMAT = "clotr-backup";
  const VERSION = 1;
  const ITERATIONS = 600000;
  const MAX_FILE_BYTES = 1024 * 1024;
  // String.fromCharCode takes its bytes as arguments, so long files go in chunks of this many.
  const BASE64_CHUNK = 0x8000;

  function toB64(bytes) {
    let binary = "";
    for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
    }
    return btoa(binary);
  }

  function fromB64(text) {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  }

  async function keyFor(password, salt, iterations, usage) {
    const passwordBytes = new TextEncoder().encode(password);
    const base = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      [usage],
    );
  }

  // The file's text: nothing in it is readable without the password.
  async function seal(settings, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = { v: VERSION, made: new Date().toISOString(), settings };
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    const key = await keyFor(password, salt, ITERATIONS, "encrypt");
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    return JSON.stringify({
      format: FORMAT,
      v: VERSION,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toB64(salt) },
      cipher: { name: "AES-GCM", iv: toB64(iv) },
      data: toB64(sealed),
    });
  }

  // Whether a parsed file has this exact format, version, key setup and sizes.
  // A 16-byte salt is 22 base64 characters and "==", a 12-byte IV is 16 characters.
  function isBackupFile(file) {
    if (file?.format !== FORMAT || file.v !== VERSION) return false;
    if (typeof file.data !== "string" || file.data.length > MAX_FILE_BYTES) return false;
    if (file?.kdf?.name !== "PBKDF2" || file.kdf.hash !== "SHA-256") return false;
    if (file?.cipher?.name !== "AES-GCM") return false;
    const iterations = file?.kdf?.iterations;
    if (!Number.isInteger(iterations) || iterations !== ITERATIONS) return false;
    if (typeof file.kdf.salt !== "string" || !/^(?:[A-Za-z0-9+/]{22}==)$/.test(file.kdf.salt)) return false;
    if (typeof file.cipher.iv !== "string" || !/^[A-Za-z0-9+/]{16}$/.test(file.cipher.iv)) return false;
    return true;
  }

  // The settings back from a file. Throws "not-a-backup" or "wrong-password".
  // AES-GCM also catches a changed file.
  async function open(text, password) {
    if (typeof text !== "string" || text.length > MAX_FILE_BYTES) throw new Error("not-a-backup");
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      throw new Error("not-a-backup");
    }
    if (!isBackupFile(file)) throw new Error("not-a-backup");
    let plain;
    try {
      const key = await keyFor(password, fromB64(file.kdf.salt), file.kdf.iterations, "decrypt");
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(file.cipher.iv) }, key, fromB64(file.data));
    } catch {
      throw new Error("wrong-password");
    }
    const payload = JSON.parse(new TextDecoder().decode(plain));
    return payload && typeof payload.settings === "object" ? payload.settings : {};
  }

  // ---------- What moves ----------

  // Not history (events, mentions, spotted), not bookkeeping, not sites you added yourself: the
  // browser has to approve those again on the new computer. Tourniquet moves; the email and chat apps it
  // turned on are sites, so the new computer's browser asks for them again. The end of the 30 days after
  // a scam (`tourniquetEnded`, `tourniquetSeen`) is this computer's bookkeeping and stays.
  const KEYS = [
    "responses",
    "paused",
    "siteModes",
    "guided",
    "advanced",
    "replyCheck",
    "commandCheck",
    "keepDays",
    "largeText",
    "lock",
    "salt",
    "vault",
    "bandage",
    "picturesNoted",
    "tourniquet",
  ];

  // The stored settings to carry, from a chrome.storage.local snapshot. Tourniquet only while it's on:
  // the 30 days after a scam carry their stored dates, so the new computer counts from the same start.
  // An ended one stays behind.
  function pick(storage, now = Date.now()) {
    const picked = {};
    for (const key of KEYS) {
      if (storage[key] !== undefined) picked[key] = storage[key];
    }
    if (picked.tourniquet !== undefined && !tourniquetOn(picked.tourniquet, now)) delete picked.tourniquet;
    return picked;
  }

  // ---------- Tourniquet ----------

  const DAY = 86400000;
  const MAX_AFTER_SCAM_DAYS = 61;

  function isTime(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  // Tourniquet: exactly one of its two words and a time, or the 30 days after a scam with their end (up to
  // 61 days after the start) before that end, or nothing. The same rule as cleanTourniquet in sites-and-policy/tourniquet-rules.js
  // (the tests hold both).
  function tourniquetOn(tourniquet, now) {
    if (!tourniquet || typeof tourniquet !== "object" || Array.isArray(tourniquet)) return null;
    if (!isTime(tourniquet.since)) return null;
    const fields = Object.keys(tourniquet).sort().join();
    const { for: forWhom, since, until } = tourniquet;
    if ((forWhom === "child" || forWhom === "adult") && fields === "for,since") return { for: forWhom, since };
    if (forWhom !== "after_scam" || fields !== "for,since,until" || !isTime(until)) return null;
    if (until <= since || until - since > MAX_AFTER_SCAM_DAYS * DAY) return null;
    if (!(now < until)) return null;
    return { for: forWhom, since, until };
  }

  // ---------- Cleaning a file's settings ----------

  const RESPONSES = ["block", "warn", "log"];
  const SITE_MODES = ["block", "log"];
  const SWITCHES = ["advanced", "replyCheck", "commandCheck", "largeText"];
  const KEEP_DAYS = [90, 365, 730];
  const MAX_PICTURES_NOTED = 200;
  const MAX_VAULT = 5000;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isKind(name) {
    return /^[a-z_]{2,40}$/.test(name);
  }

  function isHost(name) {
    return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(name);
  }

  // The object's entries that pass `allowed(key, value)`, in their order.
  function keepEntries(object, allowed) {
    const entries = Object.entries(object).filter(([key, value]) => allowed(key, value));
    return Object.fromEntries(entries);
  }

  // A PIN lock: a 16-byte salt and a 32-byte hash in hex, and a sane number of rounds.
  function isLock(lock) {
    if (!isPlainObject(lock)) return false;
    if (!/^[0-9a-f]{32}$/.test(lock.salt) || !/^[0-9a-f]{64}$/.test(lock.hash)) return false;
    return Number.isInteger(lock.iterations) && lock.iterations >= 1000 && lock.iterations <= 10000000;
  }

  // Only known keys with sane values. The vault's entries are cleaned again by the background
  // (cleanVaultEntry).
  function clean(settings, now = Date.now()) {
    const cleaned = {};
    if (!isPlainObject(settings)) return cleaned;
    const { responses, paused, siteModes, bandage, guided, picturesNoted, lock } = settings;
    if (isPlainObject(responses)) {
      cleaned.responses = keepEntries(responses, (kind, value) => isKind(kind) && RESPONSES.includes(value));
    }
    if (isPlainObject(paused)) {
      cleaned.paused = keepEntries(paused, (host, value) => isHost(host) && value === true);
    }
    if (isPlainObject(siteModes)) {
      cleaned.siteModes = keepEntries(siteModes, (host, value) => isHost(host) && SITE_MODES.includes(value));
    }
    if (isPlainObject(bandage)) {
      cleaned.bandage = keepEntries(bandage, (host, value) => isHost(host) && typeof value === "boolean");
    }
    if (isPlainObject(guided)) {
      cleaned.guided = keepEntries(guided, (kind, value) => isKind(kind) && Number.isFinite(value));
    }
    // The AI sites the "can't read pictures" note was shown on: names only, at most 200 (the newest).
    if (isPlainObject(picturesNoted)) {
      const noted = keepEntries(picturesNoted, (host, value) => isHost(host) && value === true);
      cleaned.picturesNoted = Object.fromEntries(Object.entries(noted).slice(-MAX_PICTURES_NOTED));
    }
    for (const name of SWITCHES) {
      if (typeof settings[name] === "boolean") cleaned[name] = settings[name];
    }
    if (KEEP_DAYS.includes(settings.keepDays)) cleaned.keepDays = settings.keepDays;
    if (isLock(lock)) cleaned.lock = { salt: lock.salt, iterations: lock.iterations, hash: lock.hash };
    if (typeof settings.salt === "string" && /^[0-9a-f]{32}$/.test(settings.salt)) cleaned.salt = settings.salt;
    if (Array.isArray(settings.vault)) cleaned.vault = settings.vault.slice(0, MAX_VAULT);
    const tourniquet = tourniquetOn(settings.tourniquet, now);
    if (tourniquet) cleaned.tourniquet = tourniquet;
    return cleaned;
  }

  Clotr.Backup = { FORMAT, KEYS, ITERATIONS, MAX_FILE_BYTES, pick, seal, open, clean };
})();

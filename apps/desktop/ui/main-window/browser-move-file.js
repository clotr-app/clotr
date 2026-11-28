// Bringing settings from the browser: the extension's move file (.clotr, made on its "What Clotr stores" page),
// opened here with its password by the extension's own code (backup.js in the engine bundle: PBKDF2 and AES-GCM
// with the web view's Web Crypto, nothing sent anywhere), then cleaned by the engine's guards. What comes back is
// only what Clotr for Windows keeps: settings, the salt (so the vault's fingerprints still match) and the vault's
// fingerprints and formats. Never history. Clotr for Windows checks it all again before writing it.
(() => {
  "use strict";
  const C = globalThis.Clotr;
  const Host = globalThis.ClotrHost;

  // The keys the move file carries that mean something here.
  const KEEP = ["responses", "guided", "keepDays", "largeText", "salt", "vault"];

  // The settings in `text`, opened with `password`. Throws "not-a-backup" or "wrong-password".
  async function open(text, password) {
    const settings = await C.Backup.open(String(text), String(password));
    const clean = Host.clean(settings);
    return Object.fromEntries(KEEP.filter((k) => clean[k] !== undefined).map((k) => [k, clean[k]]));
  }

  globalThis.ClotrMoveFile = { open, KEEP };
})();

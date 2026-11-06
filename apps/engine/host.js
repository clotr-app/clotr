// ClotrHost: the whole surface an app (the Android keyboard, the iPhone keyboard, Clotr for Windows and Mac) uses to
// run Clotr's engine. JSON in, JSON out: the app passes text and settings in as data and gets plain answers back.
// The bundle's last part (tools/engine-bundle.js); it reads the engine through globalThis.Clotr and adds
// globalThis.ClotrHost.
//
// What the app provides, and what it gets back:
// - Its settings, from its one writer (one JSON file; the extension's schema with paused → pausedApps and
//   siteModes → appModes, keyed by app id), the salt it made with the system's secure random (32 hex characters,
//   kept in that file) and the person's language: init(settings). Nothing else is kept here, and never any text.
// - Storage: clean(settings) before anything is written, eventsFor() for history, fingerprintFor() for the vault
//   screen. Each gives only what may be stored: settings, salted fingerprints, formats and event metadata, never a
//   detected value (the extension's own guards, extension/decide.js and backup.js).
// - Showing a warning: check() gives each found detail's response, a masked preview and the warning's words; the app
//   draws them. Hide it: redact().
// Any error comes back as { error } with no text in it, and the app lets the person go on.
(() => {
  "use strict";

  const C = globalThis.Clotr;
  // The kinds' English names, as patterns.js wrote them at load (the shim starts in English): init() names them
  // again in the person's language.
  const ENGLISH = new Map(C.PATTERNS.map((p) => [p.id, p.name]));

  let s = { salt: null, vault: [], responses: {}, siteMode: null, cache: new Map() };
  let apps = { appModes: {}, pausedApps: {} };
  const MAX_HISTORY_FINGERPRINTS_PER_CHECK = 8;

  const appId = (app) =>
    String(app ?? "")
      .replace(/[^A-Za-z0-9._-]/g, "")
      .slice(0, 200);
  const isKind = (type) => typeof type === "string" && /^[a-z_]{2,40}$/.test(type);

  // Only what may be stored, as the extension keeps it: known keys with sane values, the vault's entries checked
  // one by one (fingerprints and formats only) and without repeats, and the apps' own pause and modes.
  function clean(settings) {
    const out = C.Backup.clean(settings);
    const own = C.Backup.clean({ paused: settings?.pausedApps, siteModes: settings?.appModes });
    if (own.paused) out.pausedApps = own.paused;
    if (own.siteModes) out.appModes = own.siteModes;
    if (out.vault) out.vault = C.dedupeVault(out.vault.map(C.cleanVaultEntry).filter(Boolean));
    return out;
  }

  // The app's settings (its stored file, with the salt) and the person's language ("es", "es-MX"…; "en" if none).
  function init(settings = {}) {
    const ok = clean(settings);
    // What check() kept for History stands while the salt does (a settings change between a warning and its
    // answer): its fingerprints are the salt's.
    if ((ok.salt || null) !== s.salt) forHistory = new Map();
    s = {
      salt: ok.salt || null,
      vault: ok.vault || [],
      responses: ok.responses || {},
      siteMode: null,
      cache: new Map(),
    };
    apps = { appModes: ok.appModes || {}, pausedApps: ok.pausedApps || {} };
    recentChecks = new Map();
    C.setVault({ salt: s.salt, entries: s.vault, kinds: [] });
    const locale = C.useLocale?.(settings?.locale) || "en";
    for (const p of C.PATTERNS) p.name = C.msg(`type_${p.id}`, ENGLISH.get(p.id) ?? p.name);
    return { locale, salt: Boolean(s.salt), vault: s.vault.length };
  }

  // check()'s lists for the last few texts it checked. redact() takes ids from check() on the same text and hides
  // from that list rather than a new scan: two scans the time limit cuts short can stop at different points, so a
  // second one could miss a detail check() showed, or number the details differently. A few texts, not one, since an
  // editor checks the open file again while the person decides what to hide.
  const RECENT_CHECKS = 4;
  let recentChecks = new Map();
  function keepCheck(text, all) {
    recentChecks.delete(text);
    recentChecks.set(text, all);
    if (recentChecks.size > RECENT_CHECKS) recentChecks.delete(recentChecks.keys().next().value);
  }

  // History's strong fingerprint is 1,000 rounds of SHA-256, slow on purpose: made on every check, it cost a phone's
  // 1,000-character check about 100 ms. Only History needs it, so check() keeps the detail itself (in memory, like
  // recentChecks, by its kind and fast fingerprint) for the first eight findings of each check, and eventsFor()
  // makes the strong one when the person answers, once per detail. The last few dozen details, never stored.
  const FOR_HISTORY = 64;
  let forHistory = new Map();
  function keepForHistory(type, fp, m) {
    const key = `${type}\u0000${fp}`;
    const kept = forHistory.get(key);
    forHistory.delete(key);
    forHistory.set(key, kept || { type, m, strong: null });
    if (forHistory.size > FOR_HISTORY) forHistory.delete(forHistory.keys().next().value);
  }
  function keepCheckForHistory(all) {
    if (!s.salt) return;
    all
      .slice(0, MAX_HISTORY_FINGERPRINTS_PER_CHECK)
      .forEach(({ r, m }) => keepForHistory(r.id, C.fingerprint(s.salt, r.id, m), m));
  }

  // Every detail found, in a stable order: the same text and settings always give the same ids. `truncated` is
  // detect()'s own flag that it stopped before the end (its time limit), read before splitting drops it.
  function found(text) {
    const results = C.detect(text);
    const all = C.splitOwnIds(results, s).flatMap((r, i) => r.matches.map((m, j) => ({ id: `${i}.${j}`, r, m })));
    if (results.truncated) all.truncated = true;
    return all;
  }

  // What's in the text and what each detail does in this app: { findings, words, holds }, plus `truncated: true`
  // when the scan stopped before the end, so the app can say part of the text wasn't checked. `findings`: one per
  // detail, with a fast fp for matching (History's strong one comes from eventsFor, for up to eight per check);
  // `words`: the warning's sentence for the details to show ({ lead, items, tail }, or null when there are none);
  // `holds`: a detail is set to Ask before sending. `everyday`: an email or chat app the person switched on;
  // `source`: "typed", or "copied" for what's on the clipboard.
  function check(text, { app, everyday = false, source = "typed" } = {}) {
    const id = appId(app);
    if (typeof text !== "string" || !text || apps.pausedApps[id]) return { findings: [], words: null, holds: false };
    const here = { ...s, siteMode: apps.appModes[id] || null };
    const all = found(text);
    keepCheck(text, all);
    const findings = all.map(({ id: fid, r, m }) => ({
      id: fid,
      type: r.id,
      name: r.name,
      severity: r.severity,
      group: r.group,
      response: C.respFor(r, m, here),
      preview: C.mask(m),
      fp: s.salt ? C.fingerprint(s.salt, r.id, m) : "",
      scheme: 2,
    }));
    for (let i = 0; s.salt && i < Math.min(all.length, MAX_HISTORY_FINGERPRINTS_PER_CHECK); i++) {
      keepForHistory(all[i].r.id, findings[i].fp, all[i].m);
    }
    // The words name the details to show (not the ones only counted), kind by kind as they were found.
    const results = [];
    all.forEach(({ r, m }, i) => {
      if (findings[i].response === "log") return;
      const last = results[results.length - 1];
      if (last?.kind === r) last.matches.push(m);
      else results.push({ kind: r, name: r.name, matches: [m] });
    });
    return {
      findings,
      words: results.length ? C.noticeWords(results, { everyday: everyday === true, source }) : null,
      holds: findings.some((f) => f.response === "block"),
      ...(all.truncated ? { truncated: true } : {}),
    };
  }

  // Hide it: the text with the chosen details (ids from check() on this same text) swapped for a label naming their
  // kind, or a share link cleaned, as the extension does (the kind's own replace). An id that isn't there changes
  // nothing.
  function redact(text, findingIds = []) {
    if (typeof text !== "string") return "";
    const chosen = new Set(Array.isArray(findingIds) ? findingIds : []);
    const picked = (recentChecks.get(text) || found(text))
      .filter((f) => chosen.has(f.id))
      .map(({ r, m }) => ({ name: r.name, replace: r.replace, matches: [m] }));
    return C.redact(text, picked);
  }

  // A detail's salted fingerprint, for the vault screen (16 hex characters; "" until there is a salt).
  function fingerprintFor(type, value) {
    if (!s.salt || !isKind(type) || typeof value !== "string" || !value) return "";
    return C.fingerprint(s.salt, type, value);
  }

  // History uses the strong fingerprint; the fast one stays with the card for matching while someone types. The
  // strong one is made here, from the detail a check() found (keepForHistory), never taken from the app. `text`, the
  // checked text, is for an engine started again since that check (the keyboard closes an idle one while a warning
  // can still be up): it's found again there. At most eight are made per call, as check() kept at most eight.
  function eventsFor(findings, action, app, text) {
    const t = Date.now();
    const site = `app:${appId(app)}`;
    let made = 0;
    let lookedAgain = false;
    const strongFor = (f) => {
      if (!s.salt || typeof f?.type !== "string" || typeof f?.fp !== "string" || !f.fp) return "";
      const key = `${f.type}\u0000${f.fp}`;
      if (!forHistory.has(key) && !lookedAgain && typeof text === "string" && text) {
        lookedAgain = true;
        keepCheckForHistory(recentChecks.get(text) || found(text));
      }
      const kept = forHistory.get(key);
      if (!kept) return "";
      if (kept.strong === null) {
        if (made >= MAX_HISTORY_FINGERPRINTS_PER_CHECK) return "";
        made++;
        kept.strong = C.fingerprintStrong(s.salt, kept.type, kept.m);
      }
      return kept.strong;
    };
    return (Array.isArray(findings) ? findings : [])
      .map((f) =>
        C.cleanEvent({
          t,
          site,
          type: f?.type,
          name: f?.name,
          severity: f?.severity,
          action,
          fp: strongFor(f),
          scheme: f?.scheme,
        }),
      )
      .filter(Boolean);
  }

  const API = { init, check, redact, fingerprintFor, eventsFor, clean };

  // One way in for an app that talks to the engine in text (a sandbox that runs a script and gives back a string):
  // a JSON request { method, args } in, a JSON answer { result } or { error } out. The error is only its kind,
  // never a message, since a message could quote the text.
  function call(request) {
    try {
      const { method, args = [] } = typeof request === "string" ? JSON.parse(request) : request || {};
      if (typeof method !== "string" || !Object.prototype.hasOwnProperty.call(API, method) || !Array.isArray(args)) {
        return JSON.stringify({ error: "unknown-method" });
      }
      return JSON.stringify({ result: API[method](...args) ?? null });
    } catch (err) {
      return JSON.stringify({ error: err?.name || "Error" });
    }
  }

  globalThis.ClotrHost = Object.freeze({ ...API, call });
})();

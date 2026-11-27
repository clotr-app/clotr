// msg(): a rule's or a warning's words in the browser's language, with English when there's no translation.
(() => {
  "use strict";

  // ---------- Translations ----------
  // The browser picks the language. English is the fallback, so a missing translation never breaks a warning.
  function msg(key, english, ...subs) {
    let text = "";
    try {
      text = globalThis.chrome?.i18n?.getMessage(key, subs.map(String)) || "";
    } catch {
      /* extension context gone: English */
    }
    if (text) return text;
    return subs.length ? english.replace(/\$(\d)/g, (_, n) => String(subs[n - 1] ?? "")) : english;
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, msg };
})();

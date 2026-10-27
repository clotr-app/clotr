// The words only the apps use (apps/locales/*.json, as ClotrAppWords from ui/dist/app-words.js), in the language
// Clotr for Windows was given at start (the system's own), or Settings' Language when the person picked one.
// English when a word or a language is missing.
(() => {
  "use strict";
  const books = globalThis.ClotrAppWords || {};
  let lang = "en";
  const has = (key) => typeof (books[lang]?.[key] ?? books.en?.[key]) === "string";
  // "$1"…"$9" become the values, in order.
  function t(key, ...subs) {
    const text = books[lang]?.[key] ?? books.en?.[key] ?? key;
    return text.replace(/\$([1-9])/g, (_, n) => String(subs[n - 1] ?? ""));
  }
  function use(tag) {
    const two = String(tag || "en")
      .toLowerCase()
      .split(/[-_]/)[0];
    lang = Object.hasOwn(books, two) ? two : "en";
    document.documentElement.lang = lang;
    return lang;
  }
  // Settings' Language when it's English or Spanish, the system's own otherwise ("Like Windows", or nothing saved
  // yet). words.rs's effective_locale picks the same way for the tray and the toasts.
  function pick(language, system) {
    return language === "en" || language === "es" ? language : system;
  }
  globalThis.ClotrWords = { t, has, use, pick };
})();

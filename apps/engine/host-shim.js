// Clotr's engine outside a browser: fills in the little a bare JavaScript engine lacks (the keyboards' V8 sandbox and
// JavaScriptCore, an embedded QuickJS), so the engine's own files run there unchanged. Each piece is added only when
// the engine has none, so in a browser or a web view nothing here changes anything:
// - TextEncoder (UTF-8), which the fingerprints hash through;
// - URLSearchParams (reading a query string), which the two-step sign-in key check reads links with;
// - chrome.i18n.getMessage, from the messages bundled beside it (ClotrMessages, by language), which msg() already
//   looks for. English is written in the code, so English needs no messages.
// Clotr.useLocale(tag) picks the language ("es", "es-MX"; anything without messages is English); ClotrHost.init
// calls it. Classic script: the bundle's first part.
(() => {
  "use strict";

  // UTF-8, as the encoding standard says: a lone surrogate becomes U+FFFD.
  function utf8(text) {
    const s = String(text);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  // UTF-8 back to text, as the encoding standard says: each broken sequence becomes one U+FFFD.
  function fromUtf8(bytes) {
    let out = "";
    let needed = 0;
    let seen = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (!needed) {
        if (b <= 0x7f) out += String.fromCharCode(b);
        else if (b >= 0xc2 && b <= 0xdf) [needed, cp] = [1, b & 0x1f];
        else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          if (b === 0xed) upper = 0x9f;
          [needed, cp] = [2, b & 0xf];
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          if (b === 0xf4) upper = 0x8f;
          [needed, cp] = [3, b & 0x7];
        } else out += "\ufffd";
        continue;
      }
      if (b < lower || b > upper) {
        [needed, seen, cp, lower, upper] = [0, 0, 0, 0x80, 0xbf];
        out += "\ufffd";
        i--; // the byte starts again on its own
        continue;
      }
      [lower, upper] = [0x80, 0xbf];
      cp = (cp << 6) | (b & 0x3f);
      if (++seen === needed) {
        out += String.fromCodePoint(cp);
        [needed, seen, cp] = [0, 0, 0];
      }
    }
    return needed ? `${out}\ufffd` : out;
  }

  if (typeof globalThis.TextEncoder !== "function") {
    globalThis.TextEncoder = class TextEncoder {
      get encoding() {
        return "utf-8";
      }
      encode(input = "") {
        return utf8(input);
      }
    };
  }

  // A query string's names and values, as the URL standard reads them: "+" is a space, %XX a byte, the bytes UTF-8.
  if (typeof globalThis.URLSearchParams !== "function") {
    const decode = (part) => {
      const bytes = utf8(part.replace(/\+/g, " "));
      const out = [];
      for (let i = 0; i < bytes.length; i++) {
        const hex = String.fromCharCode(bytes[i + 1] || 0, bytes[i + 2] || 0);
        if (bytes[i] === 0x25 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
        } else out.push(bytes[i]);
      }
      return fromUtf8(out);
    };
    globalThis.URLSearchParams = class URLSearchParams {
      constructor(init = "") {
        const text = String(init).replace(/^\?/, "");
        this.pairs = text
          .split("&")
          .filter(Boolean)
          .map((pair) => {
            const at = pair.indexOf("=");
            return at < 0 ? [decode(pair), ""] : [decode(pair.slice(0, at)), decode(pair.slice(at + 1))];
          });
      }
      get(name) {
        const hit = this.pairs.find(([n]) => n === String(name));
        return hit ? hit[1] : null;
      }
      has(name) {
        return this.pairs.some(([n]) => n === String(name));
      }
    };
  }

  // The messages: the browser's way of filling them in ("$name$" from its placeholder, then $1…$9 from the values).
  let locale = "en";
  const books = () => globalThis.ClotrMessages || {};
  function getMessage(key, subs) {
    const m = books()[locale]?.[key];
    if (!m || typeof m.message !== "string") return "";
    const values = subs === undefined ? [] : [].concat(subs).map(String);
    const holders = Object.entries(m.placeholders || {});
    return m.message
      .replace(/\$([A-Za-z0-9_@]+)\$/g, (all, name) => {
        const hit = holders.find(([k]) => k.toLowerCase() === name.toLowerCase());
        return hit ? String(hit[1].content) : all;
      })
      .replace(/\$(\$|[1-9])/g, (_, d) => (d === "$" ? "$" : (values[d - 1] ?? "")));
  }
  const shimmed = !globalThis.chrome?.i18n?.getMessage;
  if (shimmed) {
    const chrome = globalThis.chrome || (globalThis.chrome = {});
    chrome.i18n = { getMessage, getUILanguage: () => locale };
  }

  // The language for everything Clotr says from now on: "es", "es-MX" and "es_ES" are Spanish; a language with no
  // messages is English. Returns the one chosen. In a browser the browser picks, and this changes nothing.
  function useLocale(tag) {
    if (!shimmed) return null;
    const lang = String(tag || "en")
      .toLowerCase()
      .split(/[-_]/)[0];
    locale = Object.prototype.hasOwnProperty.call(books(), lang) ? lang : "en";
    return locale;
  }

  globalThis.Clotr = { ...globalThis.Clotr, useLocale };
})();

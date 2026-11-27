// Private keys: PEM, OpenSSH, WireGuard and age blocks, and JSON Web Keys that carry a private member.
(() => {
  "use strict";

  // ---------- Private keys: JSON Web Keys, PEM, OpenSSH, WireGuard and age ----------
  // A private key can also be a JWK (RFC 7517): its own object or one entry of a JWKS's "keys", pretty-printed,
  // minified, or pasted as a JS object or Python dict. It counts as the same private_key kind as a PEM block.

  // Each key type has one member only a private or symmetric key carries. EC, OKP and RSA use "d" (RSA has more,
  // but "d" alone proves it's private). "oct" is symmetric, so its "k" is always a shared secret. The post-quantum
  // "AKP" type (RFC 9964) keeps its private seed in "priv".
  const JWK_PRIVATE_MEMBER = { EC: "d", OKP: "d", RSA: "d", oct: "k", AKP: "priv" };

  // Every `{...}` with no brace nested inside it. A JWK's members are never objects, so a leaf span is one JWK, or
  // one entry of a JWKS rather than its wrapper. One pass with a stack stays fast on a huge paste.
  // Inside an object, a JSON string is skipped whole, so a brace in it ("kid": "{main}") isn't the object's.
  function leafJsonObjectSpans(text, max = 2000) {
    const spans = [];
    const stack = [];
    // The last character before `i` that isn't a space.
    let previous = "";
    for (let i = 0; i < text.length && spans.length < max; i++) {
      const character = text[i];
      if (character === '"' && stack.length && JSON_STRING_BEFORE.includes(previous)) {
        i = jsonStringEndAt(text, i);
        previous = '"';
        continue;
      }
      if (character.trim()) previous = character;
      if (character === "{") {
        if (stack.length) stack[stack.length - 1].hasInner = true;
        stack.push({ start: i, hasInner: false });
      } else if (character === "}" && stack.length) {
        const open = stack.pop();
        if (!open.hasInner) spans.push(text.slice(open.start, i + 1));
      }
    }
    return spans;
  }

  // A JSON string sits after one of these, and one of JSON_STRING_END follows its closing quote. A quote anywhere
  // else is a mark in prose or code ('Use "{" to open a block'), and the walk reads on through it.
  const JSON_STRING_BEFORE = "{,:[";
  const JSON_STRING_END = ":,}]";

  // Where the JSON string opened by the quote at `open` closes, or `open` itself when it isn't one to skip: no
  // closing quote on its line (a JSON string never runs past it), the wrong thing after it, or an escaped quote in
  // it. That's JSON written inside a string ("{\"kty\":…}"), and its braces are the key's own.
  function jsonStringEndAt(text, open) {
    for (let i = open + 1; i < text.length; i++) {
      const character = text[i];
      if (character === "\\") {
        if (text[i + 1] === '"') return open;
        i++;
      } else if (character === "\n") return open;
      else if (character === '"') return JSON_STRING_END.includes(text.slice(i + 1, i + 40).trimStart()[0]) ? i : open;
    }
    return open;
  }

  // In a single-quoted string: \' becomes ', and a " gets escaped.
  function escapeLooseJsonCharacter(character) {
    if (character === "\\'") return "'";
    if (character === '"') return '\\"';
    return character;
  }

  function quoteLooseJsonString(_quoted, body) {
    return `"${body.replace(/\\'|\\.|"/g, escapeLooseJsonCharacter)}"`;
  }

  // Strict JSON first. Then a JS object or Python dict: bare keys quoted, single quotes made double, and Python's
  // None / True / False read as null / true / false.
  function parseLooseJson(span) {
    try {
      return JSON.parse(span);
    } catch {
      // fall through to the loose reading
    }
    try {
      const loose = span
        .replace(/'((?:[^'\\]|\\.)*)'/g, quoteLooseJsonString)
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
        .replace(/\bNone\b/g, "null")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      return JSON.parse(loose);
    } catch {
      return null;
    }
  }

  // A public JWK, an object that just happens to have a "d", or an OpenID config with no "kty" all come back false.
  function isPrivateJwk(jwk) {
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return false;
    if (typeof jwk.kty !== "string") return false;
    const member = JWK_PRIVATE_MEMBER[jwk.kty];
    if (!member) return false;
    return typeof jwk[member] === "string" && jwk[member].length > 0;
  }

  function findJwkPrivateKeys(text) {
    const found = [];
    for (const span of leafJsonSpansWithKty(text)) {
      if (isPrivateJwk(parseLooseJson(span))) {
        found.push(span);
        continue;
      }
      // A JWK inside a JSON string has its quotes escaped.
      const unescaped = span.replace(/\\(["\\])/g, "$1");
      if (unescaped !== span && isPrivateJwk(parseLooseJson(unescaped))) found.push(span);
    }
    return found;
  }

  // A cheap skip before paying for a parse.
  function leafJsonSpansWithKty(text) {
    return leafJsonObjectSpans(text).filter((span) => span.includes("kty"));
  }

  // ── PEM, OpenSSH, WireGuard and age keys ──────────

  const PEM_HEADER_RE = /-----[ \t]*BEGIN ((?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?)[ \t]*-----(?!-)/g;
  const PEM_FOOTER_RE = /-----[ \t]*END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?[ \t]*-----(?!-)/g;
  // A WireGuard config's own key and its peer's shared key (the public key beside them is meant to be shared), and
  // an age key file's secret line.
  const WIREGUARD_KEY = String.raw`\b(?:PrivateKey|PresharedKey)[^\S\n]*=[^\S\n]*[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])`;
  const AGE_SECRET_KEY = String.raw`\bAGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}\b`;
  const OTHER_PRIVATE_KEY_RE = new RegExp(`${WIREGUARD_KEY}|${AGE_SECRET_KEY}`, "g");
  const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // True for a line of base64 characters only (A-Z, a-z, 0-9, +, /, =).
  function base64Line(text, start, stop) {
    for (let i = start; i < stop; i++) {
      const code = text.charCodeAt(i);
      const letterOrDigit = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
      if (!letterOrDigit && code !== 43 && code !== 47 && code !== 61) return false;
    }
    return true;
  }

  // Where a PEM body with no footer ends, so a covered header doesn't leave the base64 body behind.
  function pemBodyEnd(text, from, nextHeader) {
    const firstBreak = text.indexOf("\n", from);
    if (firstBreak < 0) return from;
    if (nextHeader >= 0 && nextHeader < firstBreak) return from;
    let position = firstBreak + 1;
    let end = from;
    let hasBody = false;
    let blankBefore = false;
    while (position <= text.length) {
      const newline = text.indexOf("\n", position);
      const rawEnd = newline < 0 ? text.length : newline;
      const carriageReturn = rawEnd > position && text.charCodeAt(rawEnd - 1) === 13;
      const lineEnd = carriageReturn ? rawEnd - 1 : rawEnd;
      let start = position;
      while (start < lineEnd && (text[start] === " " || text[start] === "\t")) start++;
      let stop = lineEnd;
      while (stop > start && (text[stop - 1] === " " || text[stop - 1] === "\t")) stop--;

      if (start === stop) {
        // A chat box that keeps each line as its own paragraph puts one blank line between the key's lines.
        if (blankBefore || newline < 0) break;
        blankBefore = true;
        position = newline + 1;
        continue;
      }
      const line = text.slice(start, stop);
      // Past a blank line, a plain word like "Thanks" is the message going on, not more of the key.
      if (blankBefore && !/[\d+/=]/.test(line)) break;
      blankBefore = false;
      // An encrypted PEM key lists its encryption details before the base64 body.
      const encryptionDetail = !hasBody && /^(?:Proc-Type:|DEK-Info:)/.test(line);
      if (!encryptionDetail) {
        if (!base64Line(text, start, stop)) break;
        hasBody = true;
        end = lineEnd;
      }
      if (newline < 0) break;
      position = newline + 1;
    }
    return hasBody ? end : from;
  }

  // A whole PEM block encoded again as base64 starts "LS0tLS1CRUdJTi" ("-----BEGIN"). Only the first 64 characters
  // are decoded, so other base64 data stays out of the private-key path.
  function decodesToPrivateKey(encoded) {
    const prefix = encoded.replace(/[\r\n \t]/g, "").slice(0, 64);
    let bits = 0;
    let buffer = 0;
    let decoded = "";
    for (const character of prefix) {
      if (character === "=") break;
      const value = BASE64_ALPHABET.indexOf(character);
      if (value < 0) break;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        decoded += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    return decoded.includes("PRIVATE KEY");
  }

  // PEM and OpenSSH blocks, WireGuard and age keys, JWKs and base64 PEM all count as private_key.
  function findPrivateKeys(text) {
    const found = [];
    const hasPemMarker = text.includes("-----");
    const headers = hasPemMarker ? [...text.matchAll(PEM_HEADER_RE)] : [];
    const footers = hasPemMarker ? [...text.matchAll(PEM_FOOTER_RE)] : [];
    let footerIndex = 0;
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      const from = header.index + header[0].length;
      const nextHeader = headers[i + 1]?.index ?? -1;
      while (footerIndex < footers.length && footers[footerIndex].index < from) footerIndex++;
      const footer = footers[footerIndex];
      if (footer && (nextHeader < 0 || footer.index < nextHeader)) {
        // A doc's block with "..." or "<your private key here>" inside has no key in it. A real body, even one cut
        // short, has a line of base64.
        const body = text.slice(from, footer.index).replace(/\\[nr]/g, " ");
        if (/[A-Za-z0-9+/=]{24}/.test(body)) found.push(text.slice(header.index, footer.index + footer[0].length));
        footerIndex++;
        continue;
      }
      const bodyEnd = pemBodyEnd(text, from, nextHeader);
      found.push(text.slice(header.index, bodyEnd > from ? bodyEnd : from));
    }

    const base64Pem = [];
    if (text.includes("LS0tLS1CRUdJTi")) {
      for (const match of text.matchAll(/LS0tLS1CRUdJTi[A-Za-z0-9+/=]{40,}(?:\r?\n[ \t]*[A-Za-z0-9+/=]{8,})*/g)) {
        if (decodesToPrivateKey(match[0])) base64Pem.push(match[0]);
      }
    }
    if (text.includes("PrivateKey") || text.includes("PresharedKey") || text.includes("AGE-SECRET-KEY-")) {
      for (const match of text.matchAll(OTHER_PRIVATE_KEY_RE)) found.push(match[0]);
    }
    const jwks = text.includes("{") ? findJwkPrivateKeys(text) : [];
    return found.concat(jwks, base64Pem);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findPrivateKeys };
})();

// findOtpSecrets(): the secret behind an authenticator app's sign-in codes, as an otpauth:// link or a setup key.
(() => {
  "use strict";

  const { trimTrail, isPlaceholder, lastItem } = globalThis.ClotrInternal;

  // ---------- Two-step sign-in keys (otp_secret) ----------
  // The secret an authenticator app turns into your sign-in codes: anyone who has it can make your codes too.
  // People paste it as the otpauth:// link a sign-in QR code holds (or Google Authenticator's
  // otpauth-migration:// export), or as the "setup key" a site shows under the QR code.

  const OTP_LINK_RE = /\botpauth(?:-migration)?:\/\/[^\s"'<>]+/gi;
  // A setup key is base32 (A-Z and 2-7), in one piece or in groups of four like "5dkq 7xh2 …".
  const OTP_KEY_RE = /(?<![A-Za-z0-9])(?:[A-Za-z2-7]{4}(?: [A-Za-z2-7]{4}){3,15}|[A-Za-z2-7]{16,64})(?![A-Za-z0-9])/g;
  // A base32 run counts only with a word right before it that names it ("setup key", "secret", "seed", "clave"),
  // and a word nearby that says what it's for (two-step sign-in, an authenticator). "Setup key" covers both.
  const ENGLISH_KEY_NAMES = String.raw`set-?up\s+key|key|secret|seed`;
  const SPANISH_KEY_NAMES = String.raw`clave(?:\s+(?:secreta|de\s+configuraci[oó]n))?|secreto`;
  const IS_OR_COLON = String.raw`(?:\bis\b|\bes\b|\bwas\b|[:=])?`;
  const OTP_KEY_WORD = new RegExp(
    String.raw`(?:\b(?:${ENGLISH_KEY_NAMES}|${SPANISH_KEY_NAMES})\b[^\n.?!]{0,40}?)\s*${IS_OR_COLON}\s*["'“‘(]?$`,
    "i",
  );
  // English words, then Spanish ones.
  const OTP_TOPIC = new RegExp(
    String.raw`\b(?:2fa|two[- ]?factor|two[- ]?step|2[- ]?step|mfa|totp|hotp|otp|authenticator|authy|set-?up\s+key|` +
      String.raw`autenticador|autenticaci[oó]n|dos\s+pasos|doble\s+factor|clave\s+de\s+configuraci[oó]n)\b`,
    "i",
  );

  const blank = (match) => " ".repeat(match.length);
  let otpLast = { text: null, found: [] };

  // An export link needs its data; a plain link needs a real base32 secret.
  function otpLinkSecretValid(link) {
    const queryStart = link.indexOf("?");
    const query = new URLSearchParams(queryStart >= 0 ? link.slice(queryStart + 1) : "");
    if (/^otpauth-migration:/i.test(link)) return (query.get("data") || "").length >= 20;
    const secret = trimTrail((query.get("secret") || "").replace(/\s+/g, ""), /=/);
    return /^[A-Za-z2-7]{16,}$/.test(secret) && !isPlaceholder(secret);
  }

  // Sites show a key in one case. Plain four-letter words in a row aren't a key: split into groups, a real key has
  // a digit or four letters with no vowel, like "qrst". One unbroken run of 16+ letters still counts.
  function setupKeyShaped(groups) {
    const key = groups.join("");
    if (key !== key.toUpperCase() && key !== key.toLowerCase()) return false;
    if (!/[A-Za-z]/.test(key)) return false;
    if (groups.length > 1 && !/[2-7]/.test(key) && !/[b-df-hj-np-tv-xz]{4}/i.test(key)) return false;
    return !isPlaceholder(key);
  }

  // Every key found as { start, end, value }: the links first, then the setup keys in the rest of the text. The
  // last result is kept, since the password check asks about the same text right after.
  function otpFinds(text) {
    if (otpLast.text === text) return otpLast.found;
    const found = [];
    for (const match of text.matchAll(OTP_LINK_RE)) {
      const link = trimTrail(match[0], /[).,;:!?\]}>]/);
      if (!otpLinkSecretValid(link)) continue;
      found.push({ start: match.index, end: match.index + link.length, value: link, link: true });
    }
    const rest = text.replace(OTP_LINK_RE, blank); // the same length, without its links
    for (const match of rest.matchAll(OTP_KEY_RE)) {
      const before = rest.slice(Math.max(0, match.index - 80), match.index);
      if (!OTP_KEY_WORD.test(before) || !OTP_TOPIC.test(before)) continue;
      let groups = match[0].split(" ");
      // A key can run on into the sentence, as in "… kd7e what do I do", so a four-letter word right after it isn't
      // part of the key.
      if (/^ [A-Za-z]/.test(rest.slice(match.index + match[0].length))) {
        while (groups.length > 4 && !/[2-7]/.test(lastItem(groups))) groups = groups.slice(0, -1);
      }
      if (!setupKeyShaped(groups)) continue;
      const value = groups.join(" ");
      found.push({ start: match.index, end: match.index + value.length, value });
    }
    otpLast = { text, found };
    return found;
  }

  const findOtpSecrets = (text) => otpFinds(text).map((find) => find.value);

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, OTP_LINK_RE, blank, otpFinds, findOtpSecrets };
})();

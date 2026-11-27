// findEmails(): email addresses, spelled-out ones too ("bob at gmail dot com").
(() => {
  "use strict";

  // ---------- Emails, including spelled-out forms ----------

  // Each part is bounded by its real limit: 64 for the local part, 253 for the domain, 63 for a label.
  // Unbounded, "a-a-a-…" would backtrack quadratically.
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
  const TLDS = "com|net|org|edu|gov|mil|us|uk|ca|au|de|fr|io|co|me|info|biz|app|dev|ai|es|mx|ar|cl|pe";
  // With "at" instead of "@", only a personal provider makes it an email: "bob at gmail dot com" is one,
  // "I work at google dot com" isn't. Common misspellings ("gmial", "yahooo") are on the list.
  const PROVIDERS = [
    "gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|protonmail|proton|pm",
    "comcast|att|verizon|sbcglobal|bellsouth|charter|cox|earthlink|gmx|zoho|yandex|mail",
    // misspellings
    "gmial|gmal|gamil|gmaill|gnail|yaho|yahooo|yahho|hotmial|hotmal|hotmai|homail|outlok|outloook|iclod|icoud",
  ].join("|");
  // "jane dot doe", "jane(dot)doe", Spanish "juan punto perez".
  const LOCAL_CHARS = String.raw`[A-Za-z0-9._%+-]{1,64}`;
  const SPELLED_DOT = String.raw`(?:\s+(?:dot|punto)\s+|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*)`;
  const EMAIL_LOCAL_PART = String.raw`${LOCAL_CHARS}(?:${SPELLED_DOT}${LOCAL_CHARS}){0,4}`;
  const DOMAIN_LABEL = String.raw`[A-Za-z0-9-]{1,63}`;
  const EMAIL_DOT = String.raw`(?:\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+|\s*\.\s*)`;
  // "(at)", "[at]", "{at}", "<at>", or an "@" with spaces around it: always someone hiding an address.
  const EMAIL_AT = String.raw`(?:\s*[(\[{<]\s*at\s*[)\]}>]\s*|\s+@\s*|\s*@\s+)`;
  // The rest of the domain after its first label, up to ".com" or another ending.
  const REST_OF_DOMAIN = String.raw`(?:${EMAIL_DOT}${DOMAIN_LABEL}){0,4}?${EMAIL_DOT}(?:${TLDS})\b`;
  const EMAIL_BRACKETED = new RegExp(
    String.raw`\b${EMAIL_LOCAL_PART}${EMAIL_AT}${DOMAIN_LABEL}${REST_OF_DOMAIN}`,
    "gi",
  );
  const EMAIL_WORDED = new RegExp(
    String.raw`\b${EMAIL_LOCAL_PART}\s+(?:at|arroba)\s+(?:${PROVIDERS})${REST_OF_DOMAIN}`,
    "gi",
  );
  // "my email is janedoe at yahoo": a big provider with no ".com", only right after an email word.
  const BIG_PROVIDERS = "gmail|googlemail|yahoo|ymail|hotmail|outlook|aol|icloud|protonmail|comcast|gmx|zoho|yandex";
  // Not "janedoe at yahoo dot com" or "janedoe at yahoo.com": those are read as full addresses.
  const NO_DOT_AFTER = String.raw`(?!\s*(?:[(\[{<]\s*)?(?:dot|punto)\b|\.[A-Za-z]|\s*@)`;
  const EMAIL_NO_TLD = new RegExp(
    String.raw`\b(?:e-?mail|correo)\b[^\n@]{0,20}?` +
      String.raw`\b([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}\s+(?:at|arroba)\s+(?:${BIG_PROVIDERS}))\b${NO_DOT_AFTER}`,
    "gi",
  );
  // .invalid can't resolve by design. GitHub's and GitLab's no-reply addresses take no mail: a commit shows
  // them in place of a private address.
  const NO_MAIL_ADDRESS = /\.invalid$|@users\.noreply\.(?:github|gitlab)\.com$/i;

  // "git@github.com:acme/app.git" or "ssh://git@gitlab.com/…" is a server login. "git@acme-mail.com wrote:"
  // is still an email.
  function gitRemote(text, match) {
    if (!/^(?:git|hg)@/i.test(match[0])) return false;
    const end = match.index + match[0].length;
    if (/^:[\w.~-]+\/[\w.-]+/.test(text.slice(end, end + 200))) return true;
    return /ssh:\/\/$/i.test(text.slice(Math.max(0, match.index - 6), match.index));
  }

  // "icon@2x.png" is an image file. Only the last "@" can start the pattern, so a digit check after it
  // skips the pattern for almost every real address.
  function sizeMarkImage(address) {
    const digit = address.charCodeAt(address.lastIndexOf("@") + 1) - 48;
    const isDigit = digit >= 0 && digit <= 9;
    if (!isDigit) return false;
    return /@\d+(?:\.\d+)?x\.(?:png|jpe?g|webp|gif|svg)$/i.test(address);
  }

  function plainEmails(text) {
    const emails = [];
    // "ssh://alex:sunshine9@server.example.com" holds a password and a host, not an email. The connection
    // rule reads every link login and keeps a stand-in like "password" quiet, so an address that ends a
    // link's password is left to it, unless the password is a blank like $DB_PASS.
    // That rule loads after this file, so it's looked up here, not at load.
    let passwordEnds = null;
    for (const match of text.matchAll(EMAIL_RE)) {
      if (gitRemote(text, match) || sizeMarkImage(match[0])) continue;
      if (passwordEnds === null) passwordEnds = globalThis.ClotrInternal.linkPasswordEnds(text);
      if (passwordEnds.has(match.index + match[0].indexOf("@"))) continue;
      emails.push(match[0]);
    }
    return emails;
  }

  function findEmails(text) {
    const found = [
      ...plainEmails(text),
      ...(text.match(EMAIL_BRACKETED) || []),
      ...(text.match(EMAIL_WORDED) || []),
      ...[...text.matchAll(EMAIL_NO_TLD)].map((match) => match[1]),
    ];
    return found.filter((address) => !NO_MAIL_ADDRESS.test(address));
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findEmails };
})();

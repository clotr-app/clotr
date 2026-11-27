// findSecrets(): the secret reader. It runs its passes in order (labelled settings, headers, secrets told in a
// sentence, commands and markup, named settings, recovery lists, codes) and returns every password or secret found.
(() => {
  "use strict";

  const {
    trimTrail,
    lastItem,
    OTP_LINK_RE,
    blank,
    otpFinds,
    findConnectionStrings,
    findAwsAccessKeys,
    RECOVERY_CODES,
    RECOVERY_MARKED,
    AFTER_LABEL,
    RECOVERY_RUN,
    SESSION_COOKIE,
    LATER_SECRET,
    PASSPHRASE,
    EVERYDAY_WORDS,
    NOT_A_SECRET,
    SECRET_PLACE_WORDS,
    trimValueEnd,
    secretValue,
    QUOTE_CLOSE,
    closeInlineCode,
    inlinePasswordShape,
    labelMatches,
    readClosed,
    wholeValue,
    LOGIN_PAIR,
    CODE_TOLD,
    matched,
    LOGIN_CODE,
    otherCodes,
    LOGIN_CODE_ES,
    CODE_TOLD_ES,
    REMOTE_CODE,
    findCardCodes,
    findGiftCards,
    twilioLookup,
    LOOKUP_TOKEN_LABEL,
    typedPasswordLabel,
    PASSWORD_WORDS,
    NAME_ROLE_WORDS,
    nameRoleAlternatives,
    nameRole,
    roleNameValueReads,
    SECRET_WORD_AT_END,
    readName,
    valueRole,
    QUIET,
    valueAnswer,
    QUIET_ROLES,
    LABELLED_SECRET,
    schemeAt,
    schemeCredentialLike,
    plainName,
    labelName,
    settingRecord,
    readValue,
    isProviderCredentialLabel,
    AUTH_HEADER,
    TOLD_SECRET,
    TOLD_SECRET_ES,
    TOLD_SECRET_MORE,
    TOLD_KEY,
    keyLike,
    TOLD_ANSWER,
    TOLD_ANSWER_ES,
    BARE_SECRET,
    TOLD_SECRET_DE_FR,
    TOLD_SECRET_INTL,
    BARE_SECRET_INTL,
    TOLD_SECRET_LOANWORD,
    TOLD_SECRET_MDP,
    TOLD_SECRET_CJK,
    BARE_SECRET_CJK,
    CURL_USER,
    COMMAND_PASSWORD,
    AWS_CONFIGURE_SET,
    looksLikePath,
    commandRecord,
    AUTH_TUPLE,
    SQL_IDENTIFIED,
    csvPasswords,
    LOGIN_THEN_SECRET,
    USE_AS_SECRET,
    USER_PASS,
    MYSQL_FLAG,
    XML_SECRET,
    PASSWORD_BOX,
    SECURE_STRING,
    tablePasswords,
    ASK_REASONS,
    REMOTE_LABEL,
    CONFUSABLE_LABEL_CHAR,
    forConfusableLabelMatches,
    twinIsSecretLabel,
    namedSettings,
    findServiceTokens,
  } = globalThis.ClotrInternal;

  // ---------- What other rules already own ----------

  // ── Set-up for the secret reader ──
  // The values other rules report as their own kind, so findSecrets leaves them out.
  function ownedElsewhere({ text, inTwilio, hasConfusableLabel }) {
    return new Set([
      ...findCardCodes(text),
      ...findGiftCards(text),
      ...findAwsAccessKeys(text),
      ...findServiceTokens(text, inTwilio, hasConfusableLabel),
      ...findConnectionStrings(text),
    ]);
  }

  // The text with two-step sign-in keys and links blanked out at the same length.
  function blankSignInKeys({ text: given }) {
    let text = given;
    const keys = otpFinds(text).filter((found) => !found.link);
    text = text.replace(OTP_LINK_RE, blank);
    if (keys.length) {
      let out = "";
      let at = 0;
      for (const key of keys) {
        out += text.slice(at, key.start) + blank(key.value);
        at = key.end;
      }
      text = out + text.slice(at);
    }
    return text;
  }

  // ---------- Settings and headers ----------

  // ── Settings with a password-like label ──
  // A label's name that ends in a dotted role word (nameRoleWords).
  const DOTTED_ROLE_NAME = new RegExp(String.raw`\.(?:${nameRoleAlternatives()})$`, "i");
  // Two or more small words joined, none of them a secret's word: maple-river-stone, but not app-secret-name.
  const joinedPassphrase = (value) =>
    /^[a-z]+(?:[-_.][a-z]+)+$/.test(value) &&
    !value.split(/[-_.]/).some((word) => SECRET_WORD_AT_END.exec(word)?.index === 0);
  // Whether a value reads under a dotted role word: as it reads under any role word, or under .value as joined words.
  const dottedValueReads = (role, value) =>
    roleNameValueReads(value, role) || (role === "holds" && joinedPassphrase(value));
  // Under a password's own .value, letters with digits read too (maple_2093, 3638tiger), unless a part of it is a
  // secret's word: keyboard-cat-secret-v2 names a secret. A path or a member chain says where it is.
  const passwordValueReads = (value) =>
    value.length >= 8 &&
    !/[\s/:.$<>{}]/.test(value) &&
    /[a-z]/i.test(value) &&
    /\d/.test(value) &&
    !value.split(/[-_]/).some((word) => SECRET_WORD_AT_END.exec(word)?.index === 0);
  // An unquoted SecretString value that names the secret rather than holds it: a file the CLI reads (file://…), a key
  // on the next line (Fn::Sub:, Ref:), a date or a time from a log, or a word with no digit, like a variable in an SDK
  // call (creds_json) or a type, less the brackets that close the call.
  const secretStringNotValue = (text, m, at, value) => {
    if (!/secretstring/i.test(m[0].slice(0, at - m.index))) return false;
    // Quoted, or a query string's "?SecretString=…", is a value.
    if (QUOTE_CLOSE[text[at - 1]] || /[?&]/.test(text[m.index - 1] || "")) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /:$/.test(value)) return true;
    if (/^\d{1,4}([-/.:])\d{1,2}(?:\1\d{1,4})?(?:T[\d:.]+Z?)?$/.test(value)) return true;
    return plainName(value.replace(/[)\]}]+$/, ""));
  };
  // Reads settings with a password-like label, as in "password: …" or "token = …", including a scheme's credential.
  function readLabelledSettings({
    text,
    foundCount,
    theirs,
    inTwilio,
    labelTwilio,
    labelHasConfusableLabel,
    add,
    addWhole,
    passphraseAt,
    valueStart,
    dropClosing,
  }) {
    // Qt's PASS result lines can look like `PASS : TestCipher::testRoundTrip(QByteArray, 42)`. Neutralize only
    // that label at the same length, so a password later on the line (including a test argument) still gets checked.
    const labelledSecretText = text.replace(
      /^[\t ]*(?:>[\t ]*)?PASS(?=\s*:\s*Test[\w.$]*::test[\w$]*\()/gm,
      (match) => `${match.slice(0, -4)}    `,
    );
    const labelledSecret = (labelMatch) => {
      const before = foundCount();
      readClosed(text, labelMatch, valueStart(labelMatch), readSecret, foundCount, (value) => theirs.has(value));
      if (foundCount() === before) readWithClosing(labelMatch);
      // A label after an ARN's name whose escaped value reads nothing leaves the ARN's run to read.
      if (labelMatch.arn && foundCount() === before) labelledSecret(labelMatch.arn);
    };
    // A password in inline code that is words and a number ("jordan-4417") or camelCase words ("myMonkey"), and
    // reads as nothing without its closing backticks, is judged with them on, as it was before inline code was
    // read, and found without them.
    const readWithClosing = (labelMatch) => {
      const inCode = closeInlineCode(text, labelMatch, valueStart(labelMatch));
      const under = inCode.closing && inlineUnder(labelName(labelMatch[0]));
      if (!under || !inlinePasswordShape(inCode[1], under)) return;
      const before = foundCount();
      readSecret(labelMatch);
      dropClosing(before, inCode.closing);
    };
    // How a setting's name reads the shape (inlinePasswordShape): "password" when its last word, less any role
    // words joined with "_" or "-" (db_password, DB_PASSWORD, password_ref), is a password's, or before a dotted
    // .value (db.password.value); "points" under a password's dotted .ref or .arn; "other" for any other plain name.
    // Under any other dotted role word (token.value, secret.ref) the shapes are code names ("useState",
    // "staging2"), so they aren't read this way.
    const inlineUnder = (name) => {
      const dotted = DOTTED_ROLE_NAME.exec(name);
      const words = (dotted ? name.slice(0, dotted.index) : name).split(/[._-]+|(?<=\p{Ll})(?=\p{Lu})/u);
      while (!dotted && words.length > 1 && NAME_ROLE_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
      const password = PASSWORD_WORDS.has(words.pop().toLowerCase());
      if (!dotted) return password ? "password" : "other";
      if (!password) return null;
      return nameRole(dotted[0]) === "holds" ? "password" : "points";
    };
    const readSecret = (m) => {
      const at = valueStart(m);
      if (inTwilio(at, at + m[1].length)) return;
      if (isProviderCredentialLabel(m[0], labelTwilio, m[1], at)) return;
      const whole = wholeValue(text, at, m[1]);
      if (secretStringNotValue(text, m, at, whole)) return;
      const setting = { name: labelName(m[0]), from: m.index, labelPart: m[0].slice(0, m[0].length - m[1].length) };
      // The name is read once, for both the quiet check and the typed check.
      const reading = readName(setting.name);
      const notSecret = (record) => {
        const role = valueRole(reading);
        return QUIET_ROLES.has(role) || valueAnswer(role, readValue(record, reading)) === QUIET;
      };
      // Under a dotted role word (db.password.ref=…) the value reads under it. Under .value, small words joined like
      // a passphrase read too, as db.password=… reads them. Under .ref, .reference or .arn they name where the secret
      // is (orders-db, keyvault.prod), as do a path, a link, a member chain or the secret's name.
      // A password's own .value (db.password.value=…) is the password, so letters with digits read there too.
      const dotted = DOTTED_ROLE_NAME.exec(setting.name);
      const role = dotted && nameRole(dotted[0]);
      const dottedWords = dotted ? setting.name.slice(0, dotted.index).split(/[._-]+/) : [];
      const passwordValue = role === "holds" && PASSWORD_WORDS.has(lastItem(dottedWords).toLowerCase());
      if (dotted && !dottedValueReads(role, whole) && !(passwordValue && passwordValueReads(whole))) return;
      // An unquoted scheme word ("Bearer", "Basic", "Token", "Bot" …) is the scheme, and the credential is the run
      // after it, even past a colon, comma, dash or line break: "token: Bearer …", "token: Bearer: …". That run is
      // what gets reported and covered. "Bearer" alone ("token_type: Bearer") is a scheme name.
      const scheme = schemeAt(text, at, whole);
      if (scheme) {
        const credential = scheme.value;
        const record = settingRecord(text, {
          ...setting,
          value: credential,
          at: scheme.at,
          end: scheme.end,
          shape: "label-scheme",
        });
        if (notSecret(record)) return;
        if (LOOKUP_TOKEN_LABEL.test(text.slice(Math.max(0, m.index - 40), at))) return;
        if (!schemeCredentialLike(scheme.word, credential)) return;
        add(credential, false, 8, typedPasswordLabel(setting.name, credential, reading.kind));
        return;
      }
      // Judged on the whole value and what's around it, so "Bearer" alone is a scheme name and "hashedPassword," in
      // code names the secret, while a password that looks like code ("superSecret", "Correct.Horse.Battery") is read.
      if (notSecret(settingRecord(text, { ...setting, value: whole, at, shape: "label" }))) return;
      if (LOOKUP_TOKEN_LABEL.test(text.slice(Math.max(0, m.index - 40), at))) return;
      // A quoted sentence after the label is a message or a hint ("Enter your password here"), not the password.
      const close = QUOTE_CLOSE[text[at - 1]];
      const valueEnd = at + m[1].length;
      if (close && /^[^\S\r\n]+[^\s"'”’]/.test(text.slice(valueEnd, valueEnd + 8))) {
        const end = text.indexOf(close, valueEnd);
        const inner = end > 0 && end - at <= 128 ? text.slice(at, end) : "";
        if (inner && !/[\r\n]/.test(inner) && wholeValue(text, at, m[1]) === m[1]) return;
      }
      // A typed password gets the typed placeholder rules. Words after any label read as a passphrase.
      // A password's ref or ARN (db_password_ref) says where it's kept, so passphraseAt is stricter there.
      const typed = typedPasswordLabel(setting.name, whole, reading.kind);
      const keptElsewhere = reading.kind === "password" && !typed;
      if (!addWhole(m, true, typed)) passphraseAt(at, keptElsewhere);
    };
    for (const m of labelMatches(text, labelledSecretText, LABELLED_SECRET)) labelledSecret(m);
    forConfusableLabelMatches(text, LABELLED_SECRET, labelledSecret, labelHasConfusableLabel, labelMatches);
  }

  // ── Authorization headers ──
  // Reads the credential in an Authorization header.
  function readHeaders({ text, add }) {
    for (const m of text.matchAll(AUTH_HEADER)) {
      // Twilio's SID and auth token are two labeled fields, so a bearer-style wrapper can capture the SID as text.
      if (/^TWILIO_(?:ACCOUNT_SID|AUTH_TOKEN)=/i.test(m[1])) continue;
      add(m[1], true);
    }
  }

  // ---------- Sentences, commands and named settings ----------

  // ── Secrets told in a sentence ──
  // Reads a secret told in a sentence, as in "my password is …", in each language the rules know.
  function readToldSecrets({ text, labelHasConfusableLabel, add, addWhole, valueStart, told, because }) {
    for (const m of text.matchAll(TOLD_SECRET)) told(m);
    for (const m of text.matchAll(TOLD_SECRET_ES)) told(m);
    forConfusableLabelMatches(text, TOLD_SECRET, told, labelHasConfusableLabel);
    forConfusableLabelMatches(text, TOLD_SECRET_ES, told, labelHasConfusableLabel);
    // Not a range ("8-16 characters") or a describing word ("one-time", "case-sensitive").
    for (const m of text.matchAll(TOLD_SECRET_MORE)) {
      if (/\p{L}/u.test(m[1]) && !/^\p{Ll}+(?:-\p{Ll}+)+$/u.test(m[1])) addWhole(m, true, true);
    }
    for (const m of text.matchAll(TOLD_KEY)) if (keyLike(trimTrail(m[1], /[.)\]}>]/))) add(m[1], true);
    for (const m of text.matchAll(TOLD_ANSWER)) because(add(m[1], false), "security_answer");
    for (const m of text.matchAll(TOLD_ANSWER_ES)) because(add(m[1], false), "security_answer");
    // A password in curl's -u is read with the commands, so the sentence reader leaves it.
    const curlUserRanges = [...text.matchAll(CURL_USER)].map((m) => [m.index, m.index + m[0].length]);
    let curlUser = 0;
    for (const m of text.matchAll(BARE_SECRET)) {
      while (curlUser < curlUserRanges.length && curlUserRanges[curlUser][1] <= m.index) curlUser++;
      if (curlUser < curlUserRanges.length && curlUserRanges[curlUser][0] <= m.index) continue;
      // A capital letter starting the next line belongs to that line, not the password. Otherwise "I
      // forgot my password" followed by "Drive safe!" on its own line would read "Drive" as the password.
      if (m[0].includes("\n") && /^\p{Lu}\p{Ll}*[.?!:]*$/u.test(m[1])) continue;
      addWhole(m, true, true);
    }
    for (const m of text.matchAll(LOGIN_PAIR)) add(m[1], true, 4, true);
    // A digit or a symbol, less the sentence's last marks.
    const strong = (value) => /\d|[^\p{L}\p{N}]/u.test(value.replace(/[.,;:!?]+$/, ""));
    for (const re of [TOLD_SECRET_DE_FR, LOGIN_THEN_SECRET, USER_PASS]) {
      for (const m of text.matchAll(re)) if (strong(wholeValue(text, valueStart(m), m[1]))) addWhole(m, true, true);
    }
    for (const m of text.matchAll(USE_AS_SECRET)) if (strong(m[1])) add(m[1], true, 4, true);
    // A range is a length rule, as in "密码是8-16位" (8 to 16 characters).
    const isRange = (value) => /^\d+[-–~～]\d+$/.test(trimTrail(value, /[.)\]}>]/));
    for (const re of [TOLD_SECRET_INTL, TOLD_SECRET_LOANWORD, TOLD_SECRET_MDP, TOLD_SECRET_CJK]) {
      for (const m of text.matchAll(re)) {
        const value = wholeValue(text, valueStart(m), m[1]);
        if (strong(value) && !isRange(value)) addWhole(m, true, true);
      }
    }
    for (const re of [BARE_SECRET_INTL, BARE_SECRET_CJK]) {
      for (const m of text.matchAll(re)) {
        const value = wholeValue(text, valueStart(m), m[1]);
        if (/\d/.test(value) && value.length >= 6 && !isRange(value)) addWhole(m, true, true);
      }
    }
  }

  // ── Commands and markup ──
  // Reads a password given to a command or written in markup, as in a mysql flag, XML or curl's -u.
  function readCommandsAndMarkup({ text, add }) {
    for (const re of [MYSQL_FLAG, PASSWORD_BOX, SECURE_STRING]) {
      for (const m of text.matchAll(re)) add(m[2], false, 4, true);
    }
    for (const m of text.matchAll(XML_SECRET)) {
      const role = m[2] && nameRole(m[2]);
      if (!m[2] || (role && roleNameValueReads(m[3], role))) {
        add(m[3], false, 4, Boolean(m[2]) && typedPasswordLabel(m[2], m[3]));
      }
    }
    // Docs write these commands out as "-u user:password", so the value has to look like a real one.
    // The password stops before a closing backtick, as in `curl -u user:pass`.
    for (const m of text.matchAll(CURL_USER)) {
      add(trimTrail(trimValueEnd(m[2] ?? m[4] ?? m[6]), /`/), true, 4, true);
    }
    for (const re of COMMAND_PASSWORD) {
      for (const m of text.matchAll(re)) if (!looksLikePath(commandRecord(text, m))) add(m[2], true, 4, true);
    }
    for (const m of text.matchAll(AWS_CONFIGURE_SET)) add(m[2], true);
  }

  // ── Settings named as a secret ──
  // Reads a setting named as a secret, a login tuple or SQL grant, and the password cell of a table or CSV.
  function readNamedSettings({ text, add, passphraseAt }) {
    // A key that isn't random enough to be its own kind, like 32 hex characters, is still a secret by its name.
    for (const setting of namedSettings(text)) {
      // A camelCase key name that its snake_case twin's secret label doesn't read (privateKey, onKeyPress) gets only
      // the key reader's checks, as the twin does.
      const secretLabel = setting.camel && twinIsSecretLabel(setting.record.name);
      if (setting.camel && setting.kind === "key" && !secretLabel) continue;
      const minLength = setting.kind === "key" ? 16 : 4;
      const typed = typedPasswordLabel(setting.record.name, setting.value, setting.kind);
      const value = add(setting.value, true, minLength, typed);
      if (!value && setting.camel && setting.kind === "password") passphraseAt(setting.record.at);
    }
    for (const m of text.matchAll(AUTH_TUPLE)) add(m[3], false, 4, true);
    for (const m of text.matchAll(SQL_IDENTIFIED)) add(m[2], false, 4, true);
    for (const cell of tablePasswords(text)) add(cell, true, 4, true);
    for (const cell of csvPasswords(text)) add(cell, true, 4, true);
  }

  // ---------- Codes after their label ----------
  // A list of only joining words, like "and" or "and the" between two labels, holds no code.
  const JOINING_WORDS = /^(?:(?:and|the|my|our|your)\s*)+$/i;
  const SPANISH_RECOVERY = /c[oó]digos?\s+de\s+(?:respaldo|recuperaci[oó]n)/i;
  // A list holds a code-like word when it opens with a digit, has a number of 6 or more digits or two numbers
  // in a row, or a word mixes a digit with letters or groups joined by "-", as in "kq7m-x4rt". A first word of
  // 6 or more characters that ends the list or a comma is a code of letters. Words like "not working since
  // 2024", or a short number and then two or more words, as in "2024 was when it stopped", hold none. Nor does
  // a lone short number whose list stops at a short word that starts a sentence, as in "2024 is when I printed
  // them", where `after` is the text right after the list.
  function codeLike(codes, after = "") {
    const words = codes.split(/[\s,;]+/);
    const rest = words.slice(1);
    const sentence =
      /^\d{1,4}$/.test(words[0]) &&
      (rest.length >= 2
        ? rest.every((word) => /^[A-Za-z]+$/.test(word))
        : rest.length === 0 && /^\s+[A-Za-z]{1,2}\s+[A-Za-z]/.test(after));
    if (/\d/.test(words[0]) && !sentence) return true;
    if (/\d{6}/.test(codes) || /^[^\s,;]{6,}\s*(?:[,;]|$)/.test(codes)) return true;
    if (words.some((word, k) => /^\d+$/.test(word) && /^\d+$/.test(words[k + 1] || ""))) return true;
    return words.some((word) => (/\d/.test(word) && /[A-Za-z]/.test(word)) || /\w-\w/.test(word));
  }
  // A list with no code-like word counts only where a run of words from the first label, read as one list
  // through any later label, holds a digit and 8 or more characters. That run stops at a short word like "is"
  // or at a colon, so "backup codes and two-factor codes: not working since 2024" holds no code.
  function recoveryRuns(text) {
    return [...text.matchAll(RECOVERY_RUN)]
      .map((m) => ({ codes: trimTrail(m[1], /[\s,;]/), from: m.index + m[0].length - m[1].length }))
      .filter((run) => /\d/.test(run.codes) && run.codes.length >= 8);
  }
  // After labels joined by "and" and then a colon or "is", a lone number of up to 4 digits and one word, as in
  // "backup codes and recovery codes: 2024, when I printed them", is a sentence. So is the number before a word
  // the list stops short of, after a space or a comma, as in "2024 unfortunately", "2003, remaining" or "2000
  // más", and a year that ends the text. Any other lone number alone stays a code. After a "código" label, a
  // number and a word that are 8 or more characters together, as in "<code>, for", is one code, as on its own.
  function joinedSentence(chain, list, after) {
    const earlier = chain.slice(0, chain.indexOf(list));
    if (!earlier.every((other) => JOINING_WORDS.test(other.codes))) return false;
    if (!/(?:\s(?:is|es)|:)\s*$/i.test(list.head)) return false;
    if (/^\d{1,4}[\s,;]+[A-Za-z]+$/.test(list.codes)) {
      return !(SPANISH_RECOVERY.test(list.head) && list.codes.length >= 8);
    }
    if (!/^\d{1,4}$/.test(list.codes) || list !== chain[chain.length - 1]) return false;
    const endsText = /^(?:19|20)\d\d$/.test(list.codes) && /^\s*[.!?]?\s*$/.test(after);
    return /^(?:\s+|,\s*)\p{L}{3}/u.test(after) || endsText;
  }
  // A list of plain words with at most one year in it is a sentence or a tag list about codes, not codes:
  // "not working since 2024", "2024 audit", "2fa, tutorial". A number that isn't a year ("abcd efgh 1234") is a code.
  // Letter codes are still codes: four consonants in a row ("bxqyrwta") or words all one length ("kaxomute ribelona").
  function wordsAndAYear(codes) {
    const words = codes.split(/[\s,;]+/).filter(Boolean);
    const years = words.filter((word) => /^(?:19|20)\d\d$/.test(word));
    if (words.length < 2 || years.length > 1) return false;
    const letterWords = words.filter((word) => !years.includes(word) && !/^2fa$/i.test(word));
    const plainWord = (word) =>
      /^[A-Za-z]?[a-z]{2,}$/.test(word) && /[aeiouy]/i.test(word) && !/[^aeiou]{4}/i.test(word);
    const sameLength = letterWords.length >= 2 && letterWords.every((word) => word.length === letterWords[0].length);
    if (sameLength && letterWords[0].length >= 6) return false;
    return letterWords.every(plainWord);
  }
  const overlaps = (run, list) => run.from < list.from + list.codes.length && list.from < run.from + run.codes.length;

  // The recovery code lists in `text`. Lists right beside each other, as in "recovery code 4829 and backup code
  // 5512", are read as one: they count when together they hold a digit and 8 or more characters, or when a run
  // through them does, and then each list is found on its own.
  function readRecoveryLists({ text, found, because }) {
    const toList = (m) => {
      const from = m.index + m[0].length - m[1].length;
      const head = text.slice(m.index, from);
      return { codes: trimTrail(m[1], /[\s,;]/), from, start: m.index, end: m.index + m[0].length, head };
    };
    const lists = [...text.matchAll(RECOVERY_CODES)].map(toList);
    const starts = new Set(lists.map((list) => list.start));
    const ends = new Set(lists.map((list) => list.end));
    for (const m of text.matchAll(RECOVERY_MARKED)) {
      if (starts.has(m.index)) continue;
      if (!ends.has(m.index) && !AFTER_LABEL.test(text.slice(Math.max(0, m.index - 80), m.index))) continue;
      const list = toList(m);
      // Only joining words, as in "mfa codes, and backup codes", hold no code and join nothing.
      if (JOINING_WORDS.test(list.codes)) continue;
      lists.push(list);
      ends.add(list.end);
    }
    lists.sort((a, b) => a.start - b.start);
    const beside = (a, b) => /^[\s,;]*(?:(?:and|or|y|e)\s+)?$/i.test(text.slice(a.end, b.start));
    // The runs are read only when a chain needs them.
    let runs;
    const inRun = (list) => (runs = runs || recoveryRuns(text)).some((run) => overlaps(run, list));
    for (let first = 0; first < lists.length;) {
      let last = first;
      while (last + 1 < lists.length && beside(lists[last], lists[last + 1])) last++;
      const chain = lists.slice(first, last + 1);
      first = last + 1;
      const together = chain.map((list) => list.codes).join(" ");
      if (!(/\d/.test(together) && together.length >= 8) && !chain.some(inRun)) continue;
      for (const list of chain) {
        if (JOINING_WORDS.test(list.codes)) continue;
        // Only the last list of a chain can end a sentence; an earlier one is followed by the next label.
        const at = list.from + list.codes.length;
        const after = list === chain[chain.length - 1] ? text.slice(at, at + 40) : "";
        if (!codeLike(list.codes, after) && !inRun(list)) continue;
        if (wordsAndAYear(list.codes)) continue;
        if (list !== chain[0] && joinedSentence(chain, list, after)) continue;
        found.push(list.codes);
        because(list.codes, "recovery_codes");
      }
    }
  }

  // Reads codes told after their label, like a remote-access or door code, then session cookies and recovery codes.
  function readCodes({ text, found, add, because }) {
    for (const m of text.matchAll(REMOTE_CODE)) because(add(m[1], false), "remote_code");
    for (const m of text.matchAll(LOGIN_CODE)) {
      const code = matched(m);
      because(add(code, false), "login_code");
      for (const other of otherCodes(text, m.index, m.index + m[0].length, code)) {
        because(add(other, false), "login_code");
      }
    }
    for (const m of text.matchAll(SESSION_COOKIE)) {
      const value = m[2];
      // Random-looking, not "sessionid=0000000000000000".
      if (/\d/.test(value) && /[A-Za-z]/.test(value)) add(value, true);
    }
    readRecoveryLists({ text, found, because });
    for (const m of text.matchAll(CODE_TOLD_ES)) {
      because(add(m[1], false), REMOTE_LABEL.test(m[0]) ? "remote_code" : "home_code");
    }
    for (const m of text.matchAll(LOGIN_CODE_ES)) because(add(matched(m), false), "login_code");
    for (const m of text.matchAll(CODE_TOLD)) {
      // "1-2-3" reads as an example rather than a real code. A real combination lock uses 2-digit numbers,
      // and a real keypad code has 4 or more digits, like "1-9-7-5".
      const code = m[1];
      const spaced = /[- ]/.test(code) && !/\d\d/.test(code);
      const example = spaced && (code.split(/[- ]/).length < 4 || "0123456789".includes(code.replace(/[- ]/g, "")));
      if (example) continue;
      because(add(code, false), "home_code");
    }
  }

  // ---------- The secret reader ----------

  // ── The secret reader ──
  // Each value once, in the order found, leaving out what other rules own, with its reason copied into `why`.
  function finishSecrets({ found, theirs, reasons, why }) {
    // Several ways of saying it can find the same value.
    const out = [...new Set(found)].filter((value) => !theirs.has(value));
    if (!why) return out;
    for (const value of out) if (reasons.has(value)) why.set(value, reasons.get(value));
    return out;
  }

  // `why` is an optional Map from detect() that records, for each value this finds that a scam code's rule
  // matched, which reason it matched for. Without it, the values returned are the same either way.
  function findSecrets(rawText, why) {
    let text = rawText;
    const found = [];
    const reasons = new Map();
    const inTwilio = twilioLookup(text);
    const hasConfusableLabel = CONFUSABLE_LABEL_CHAR.test(text);
    // The first reason in ASK_REASONS' order wins when two rules take the same value ("my ATM pin is 4821").
    const rank = (reason) => (reason ? ASK_REASONS.indexOf(reason) : ASK_REASONS.length);
    const because = (value, reason) => {
      if (value && rank(reason) < rank(reasons.get(value))) reasons.set(value, reason);
    };
    // A money detail told after its own label, like a card's security code or a gift card's code and PIN,
    // is reported as its own kind, so it's never counted as a password too.
    const theirs = ownedElsewhere({ text, inTwilio, hasConfusableLabel });
    // A two-step sign-in key or link is already reported as its own otp_secret kind, even a documentation
    // example, so it's blanked out here to keep its "secret=…" from also being read as a password.
    text = blankSignInKeys({ text });
    // The pairs as the label finders below see the text, with those sign-in keys blanked.
    const labelTwilio = text === rawText ? inTwilio : twilioLookup(text);
    const labelHasConfusableLabel = text === rawText ? hasConfusableLabel : CONFUSABLE_LABEL_CHAR.test(text);
    // Returns the value taken as a secret, or false.
    // typed: the value was typed after a password label, so it gets secretValue's typed placeholder rules.
    const add = (raw, needsComplexity, minLength = 4, typed = false) => {
      const value = secretValue(raw, needsComplexity, minLength, typed);
      if (!value) return false;
      found.push(value);
      return value;
    };
    // keptElsewhere: under a name that says where the password is kept (db_password_ref). Only separate
    // words are a passphrase there, and none may name a secret or a place for one ("orders vault entry").
    const passphraseAt = (pos, keptElsewhere = false) => {
      const phrase = PASSPHRASE.exec(text.slice(pos, pos + 90));
      if (!phrase) return false;
      if (keptElsewhere && phrase[1].includes("-")) return false;
      const words = phrase[1].toLowerCase().split(/[\s-]+/);
      if (words.some((word) => EVERYDAY_WORDS.has(word))) return false;
      if (keptElsewhere && words.some((word) => SECRET_PLACE_WORDS.has(word))) return false;
      // One describing word can still be part of a real passphrase, like "correct horse battery staple".
      // Two describing words mean it's a sentence describing the password instead.
      if (words.filter((word) => NOT_A_SECRET.has(word)).length > 1) return false;
      // A mask of X's in groups, like "xxxx-xxxx-xxxx-xxxx", stands in for a key in a doc. One X word among real
      // ones ("tango xxx lima delta") is part of the passphrase.
      if (words.every((word) => /^x+$/.test(word))) return false;
      found.push(phrase[1]);
      return true;
    };
    const valueStart = (m) => m.index + m[0].length - m[1].length;
    // The value read on past punctuation inside it (wholeValue), or the value as matched when that isn't a secret.
    const addWhole = (m, needsComplexity, typed = false) => {
      const whole = wholeValue(text, valueStart(m), m[1]);
      return add(whole, needsComplexity, 4, typed) || (whole !== m[1] && add(m[1], needsComplexity, 4, typed));
    };
    // Reads a secret told in words, trying a passphrase first, then the word right after "is", then the
    // first password-looking word shortly after that.
    const told = (m) => {
      if (passphraseAt(valueStart(m))) return;
      const matchEnd = m.index + m[0].length;
      // A length range: "the password is 8-16 characters long".
      const after = text.slice(matchEnd, matchEnd + 14);
      if (/^\d+[-–]\d+$/.test(m[1]) && /^\s+(?:characters|chars|letters|digits|caracteres)/i.test(after)) return;
      // A PIN is digits: "my pin is loose" is about hardware.
      if (/^(?:(?:my|the|our|his|her|their|your)\s+)?pin\b/i.test(m[0]) && !/\d/.test(m[1])) return;
      if (addWhole(m, false, true)) return;
      const later = LATER_SECRET.exec(text.slice(matchEnd, matchEnd + 40));
      if (later) add(later[0], true, 4, true);
    };
    readLabelledSettings({
      text,
      foundCount: () => found.length,
      theirs,
      inTwilio,
      labelTwilio,
      labelHasConfusableLabel,
      add,
      addWhole,
      passphraseAt,
      valueStart,
      // Takes the inline code's closing marks off each value found since `from`.
      dropClosing: (from, closing) => {
        for (let i = from; i < found.length; i++) {
          if (found[i].endsWith(closing)) found[i] = found[i].slice(0, -closing.length);
          else found[i] = found[i].replace(/`+$/, "");
        }
      },
    });
    readHeaders({ text, add });
    readToldSecrets({ text, labelHasConfusableLabel, add, addWhole, valueStart, told, because });
    readCommandsAndMarkup({ text, add });
    readNamedSettings({ text, add, passphraseAt });
    readCodes({ text, found, add, because });
    return finishSecrets({ found, theirs, reasons, why });
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findSecrets };
})();

// Checks most rules share on a found value: a Luhn sum, a placeholder or an example, how random a key looks.
// Every other rules file and the rule table read these.
(() => {
  "use strict";

  // Luhn checksum over 13 to 19 digits. Cards and gift cards use it, and so do some national IDs (South Africa,
  // Canada's SIN), padded with zeros to 13 or 14 digits first.
  function validLuhn(candidate) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  }

  // `s` without the characters from `set` at its end.
  // It's a loop, since /[...]+$/ gets quadratic on a long run.
  function trimTrail(s, set) {
    let end = s.length;
    while (end > 0 && set.test(s[end - 1])) end--;
    return s.slice(0, end);
  }

  // ---------- Fewer false alarms for credentials ----------

  // A doc's stand-ins for values, including setting names and fake-key phrases.
  const DOC_PLACEHOLDER = new RegExp(
    String.raw`^(?:[a-z0-9]{1,12}:)?your[_-]?(?:[a-z0-9]{1,20}[_-]){0,3}(?:api[_-]?)?` +
      String.raw`(?:key|token|secret|password|pass(?:phrase)?|pwd|credentials?)(?:[_-]here)?$`,
    "i",
  );
  const CHANGE_ME = /^(?:[a-z]+[-_.]){1,3}(?:change|replace)[-_]?me$/;
  const TYPED_CHANGE_ME = /^(?:CHANGE|REPLACE)_ME$/;
  // A blank to fill in, like API_KEY_HERE or BASE64_SECRET: up to 7 capital words, then the kind of secret.
  const ENCODING_NAMES = "BASE64|BASE32|SHA256";
  const FIRST_BLANK_WORD = `(?:[A-Z]{2,30}|${ENCODING_NAMES})`;
  const NEXT_BLANK_WORD = `(?:_(?:[A-Z]{1,30}|${ENCODING_NAMES}))`;
  const SECRET_KIND = "_(?:KEY|TOKEN|SECRET|PASSWORD)";
  const BLANK_TO_FILL = new RegExp(`^${FIRST_BLANK_WORD}${NEXT_BLANK_WORD}{0,6}${SECRET_KIND}(?:_HERE)?$`);
  const STRESSED_SECRET = /^(?:SUPER|TOP|VERY|ULTRA|MEGA|MOST)_SECRET$/;
  const FAKE_WORD = /^(?:fake|mock|sample|dummy|test|demo|fixture)$/;
  const CREDENTIAL_WORD = /^(?:key|token|secret|password|pass|pwd|apikey)$/i;
  function placeholderWords(value) {
    if (value.length > 48 || !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){1,7}$/.test(value)) return false;
    const words = value.split(/[-_]/);
    return (
      words.every((word) => word.length <= 12) &&
      words.some((word) => FAKE_WORD.test(word)) &&
      words.some((word) => CREDENTIAL_WORD.test(word))
    );
  }
  const FAKE_ANYWHERE = /example|your[_-]?(api[_-]?)?(key|token|secret)|placeholder|dummy|redacted|insert[_-]?here/i;
  const FAKE_WHOLE_VALUE =
    /^(?:example|your[_-]?(?:api[_-]?)?(?:key|token|secret)|placeholder|dummy|redacted|insert[_-]?here)$/i;
  // Whether the value says it's a stand-in. A typed password has to say so with its whole value,
  // since a person can type "example123!" as their real one.
  function saysFake(value, typed = false) {
    const fakeWords = typed ? FAKE_WHOLE_VALUE : FAKE_ANYWHERE;
    if (fakeWords.test(value)) return true;
    if (DOC_PLACEHOLDER.test(value)) return true;
    if (CHANGE_ME.test(value)) return true;
    if (typed && TYPED_CHANGE_ME.test(value)) return true;
    if (placeholderWords(value)) return true;
    const blankToFill = BLANK_TO_FILL.test(value) && !STRESSED_SECRET.test(value);
    return blankToFill;
  }

  // The two-step sign-in documentation's example secret.
  function docsExample(value, typed = false) {
    const example = /JBSW\s?Y3DP\s?EHPK\s?3PXP/i;
    return typed ? /^JBSW\s?Y3DP\s?EHPK\s?3PXP$/i.test(value) : example.test(value);
  }

  // The part of a key that should look random. X and Fly tokens pad themselves with runs of A,
  // so those come out, and a Fly token with too little left gives null.
  function keyBody(value) {
    const fly = /^FlyV1\s+fm\d_/.exec(value);
    if (fly && value.slice(fly[0].length).replace(/A/g, "").length < 40) return null;
    return (fly ? value.replace(/A{6,}/g, "A") : value).replace(/^A{20,24}(?=[A-Za-z0-9%]{40})/, "");
  }

  // Whether one character repeats `length` times in a row. Each length's regex is built only once.
  const sameCharPatterns = new Map();
  function sameCharRun(body, length) {
    if (!sameCharPatterns.has(length)) sameCharPatterns.set(length, new RegExp(`(.)\\1{${length - 1},}`));
    return sameCharPatterns.get(length).test(body);
  }

  // Whether `length` characters in a row count up by one, like 345678.
  // It goes by character code, so 89ab isn't a run.
  function countsUp(body, length) {
    let run = 1;
    for (let i = 1; i < body.length; i++) {
      run = body.charCodeAt(i) === body.charCodeAt(i - 1) + 1 && /[A-Za-z0-9]/.test(body[i]) ? run + 1 : 1;
      if (run >= length) return true;
    }
    return false;
  }

  // A character's place in 0 to 9 and then a to z, for counting down. In that order ba98 is a run.
  const runRank = (character) => "0123456789abcdefghijklmnopqrstuvwxyz".indexOf(character.toLowerCase());
  function countsDown(body, length) {
    let run = 1;
    for (let i = 1; i < body.length; i++) {
      const rank = runRank(body[i]);
      run = rank >= 0 && rank === runRank(body[i - 1]) - 1 ? run + 1 : 1;
      if (run >= length) return true;
    }
    return false;
  }

  function repeatsGroup(body) {
    const compact = body.replace(/[-_.]/g, "");
    for (let size = 2; size <= 8; size++) {
      let same = 0;
      for (let i = size; i < compact.length; i++) {
        same = compact[i] === compact[i - size] && runRank(compact[i]) >= 0 ? same + 1 : 0;
        if (same + size >= 16) return true;
      }
    }
    return false;
  }

  // A JWT or a key whose body begins with one.
  const BASE64_JSON = /^(?:[A-Za-z0-9]+[_.])?eyJ/;
  function isJwt(value) {
    return BASE64_JSON.test(value);
  }

  // A stand-in from docs or examples, not a real secret.
  function isPlaceholder(value, typed = false) {
    if (saysFake(value, typed) || docsExample(value, typed)) return true;
    const body = keyBody(value);
    if (body === null) return true;
    if (typed) {
      if ((body.length >= 6 && sameCharRun(body, body.length)) || (body.length >= 8 && countsUp(body, body.length))) {
        return true;
      }
    } else if (sameCharRun(body, 6) || countsUp(body, 8)) {
      return true;
    }
    if (typed || isJwt(value)) return false;
    return countsDown(body, 8) || repeatsGroup(body);
  }

  // Keys keep the rules secretValue used before typed password checks existed.
  function isKeyPlaceholder(value) {
    if (saysFake(value) || docsExample(value)) return true;
    const body = keyBody(value);
    return body === null || sameCharRun(body, 6) || countsUp(body, 8);
  }

  // Shannon entropy in bits per character: how evenly the characters are spread.
  function entropy(s) {
    const chars = [...s];
    const counts = new Map();
    for (const ch of chars) counts.set(ch, (counts.get(ch) || 0) + 1);
    let bits = 0;
    for (const n of counts.values()) bits -= (n / chars.length) * Math.log2(n / chars.length);
    return bits;
  }

  // Keys have long runs without a dash, and slugs like my-project-name don't.
  const LONG_RUN = 12;
  // Whether the body has LONG_RUN characters in a row with no dash or underscore.
  function hasLongRun(body) {
    let run = 0;
    for (let i = 0; i < body.length; i++) {
      run = body[i] === "-" || body[i] === "_" ? 0 : run + 1;
      if (run >= LONG_RUN) return true;
    }
    return false;
  }

  // Prefixes like sk- also start words (sk-learn), so the body must look machine-made.
  function looksRandom(body, minLen = 20) {
    return (
      body.length >= minLen &&
      /\d/.test(body) &&
      /[a-z]/.test(body) &&
      /[A-Z]/.test(body) &&
      hasLongRun(body) &&
      // Dashes and underscores split a key into parts, so they don't count toward its randomness.
      entropy(body.replace(/[-_]/g, "")) >= 3.5
    );
  }

  // The same check for hex and other keys written in one case.
  // Hex has only 16 characters, at most 4 bits each, so its bar for entropy is 3 instead of 3.5.
  function looksRandomHex(body) {
    const s = body.toLowerCase();
    return /\d/.test(s) && /[a-z]/.test(s) && hasLongRun(s) && entropy(s.replace(/[-_]/g, "")) >= 3;
  }

  // Whether a key of letters only looks random. An entropy of 3.5 takes at least 12 different letters.
  function looksRandomLetters(body) {
    return /^[A-Za-z]+$/.test(body) && entropy(body) >= 3.5;
  }

  // ---------- Stand-in passwords in links ----------

  // What docs put in a link's password spot ("postgres://alex:password@db.example.com"). Only in a link:
  // typed on its own, "password" can be someone's real password. Only the clearest stand-ins count.
  // People really use 12345678 or test_password, so those warn.
  const LINK_PASSWORD_STAND_INS = new Set(["password", "pass", "passwd", "pwd", "secret", "changeme"]);
  // A doc's word for the password, like redis://:placeholder@localhost. Only as the whole password,
  // so example123 still warns.
  const DOC_PASSWORD_WORDS = new Set(["example", "placeholder", "dummy", "redacted"]);
  // The doc asking for the reader's own, like yourpassword, your-password or your_password_here.
  const YOUR_PASSWORD = /^your[-_]?pass(?:word)?(?:[-_]?here)?$/i;
  // A run of x or *, like xxxx or ****.
  const MASKED_PASSWORD = /^(?:x{3,}|\*{3,})$/i;
  // A blank for a template, printf or code to fill: <pass>, {}, ${PASS}, $(DB_PASSWORD), $cfg->{password},
  // [pass], %s. Every list of blank shapes left some out, so the first character decides.
  // A real password that starts this way, like $uperS3cret!, isn't read as one in a link.
  const LINK_PASSWORD_BLANK = /^[<{$[%]/;

  function linkPasswordBlank(password) {
    return LINK_PASSWORD_BLANK.test(password);
  }

  function linkPasswordStandIn(password) {
    const lowered = password.toLowerCase();
    if (LINK_PASSWORD_STAND_INS.has(lowered)) return true;
    if (DOC_PASSWORD_WORDS.has(lowered) || YOUR_PASSWORD.test(password)) return true;
    if (MASKED_PASSWORD.test(password)) return true;
    return linkPasswordBlank(password);
  }

  // The rule table, fetched when called rather than at load, since the table itself names finders from almost
  // every part of the engine.
  function ruleTable() {
    return globalThis.ClotrInternal.PATTERNS;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    validLuhn,
    trimTrail,
    STRESSED_SECRET,
    isPlaceholder,
    linkPasswordBlank,
    linkPasswordStandIn,
    isKeyPlaceholder,
    entropy,
    looksRandom,
    looksRandomHex,
    looksRandomLetters,
    ruleTable,
  };
})();

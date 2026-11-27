// What a scam message asks for: look-alike letters in its labels, and the labels scam-signs.js reads.
(() => {
  "use strict";

  const {
    RECOVERY_LABEL,
    LOGIN_NAMES,
    CODE_THEY_SENT,
    LOGIN_LABEL_ES,
    CARD_LABEL,
    REMOTE_WORDS,
    REMOTE_WORDS_ES,
    GIFT_WORDS,
    ANSWER_LABEL,
    ANSWER_LABEL_ES,
  } = globalThis.ClotrInternal;

  // ── What a scammer asks for ──
  // The kinds of code a scammer asks for, in the order the warning names them in. This only decides what
  // the words on screen say, and nothing about it gets stored.
  const ASK_REASONS = ["login_code", "remote_code", "recovery_codes", "security_answer", "home_code"];
  const REMOTE_LABEL = new RegExp(REMOTE_WORDS_ES, "i");
  // ── Look-alike letters in labels ──
  // Used only for matching label text. Secret values and ordinary Russian or Greek text stay unchanged.
  const CONFUSABLE_LABELS = Object.freeze({
    "\u0430": "a",
    "\u0410": "A",
    "\u0435": "e",
    "\u0415": "E",
    "\u043e": "o",
    "\u041e": "O",
    "\u0440": "p",
    "\u0420": "P",
    "\u0441": "c",
    "\u0421": "C",
    "\u0445": "x",
    "\u0425": "X",
    "\u0443": "y",
    "\u0423": "Y",
    "\u0456": "i",
    "\u0406": "I",
    "\u0458": "j",
    "\u0408": "J",
    "\u043a": "k",
    "\u041a": "K",
    "\u043c": "m",
    "\u041c": "M",
    "\u0442": "t",
    "\u0422": "T",
    "\u0432": "b",
    "\u0412": "B",
    "\u043d": "h",
    "\u041d": "H",
    "\u0455": "s",
    "\u0405": "S",
    "\u04cf": "l",
    "\u04c0": "I",
    "\u03b1": "a",
    "\u0391": "A",
    "\u03b5": "e",
    "\u0395": "E",
    "\u03bf": "o",
    "\u039f": "O",
    "\u03c1": "p",
    "\u03a1": "P",
    "\u03c4": "t",
    "\u03a4": "T",
    "\u03c7": "x",
    "\u03a7": "X",
    "\u03b9": "i",
    "\u0399": "I",
    "\u03ba": "k",
    "\u039a": "K",
    "\u03bc": "m",
    "\u039c": "M",
    "\u03bd": "v",
    "\u039d": "N",
    "\u0392": "B",
    "\u0396": "Z",
    "\u0397": "H",
    "\u03a5": "Y",
  });
  // Every look-alike letter in a label (to swap them), and whether a label has any.
  const CONFUSABLE_LABEL_CHARS = new RegExp(`[${Object.keys(CONFUSABLE_LABELS).join("")}]`, "g");
  const CONFUSABLE_LABEL_CHAR = new RegExp(`[${Object.keys(CONFUSABLE_LABELS).join("")}]`);
  function forConfusableLabelMatches(
    source,
    re,
    visit,
    hasConfusableLabel = CONFUSABLE_LABEL_CHAR.test(source),
    matches = (_text, folded, pattern) => folded.matchAll(pattern),
  ) {
    if (!hasConfusableLabel) return;
    const folded = source.replace(CONFUSABLE_LABEL_CHARS, (letter) => CONFUSABLE_LABELS[letter]);
    for (const m of matches(source, folded, re)) {
      const at = m.index + m[0].length - m[1].length;
      if (!CONFUSABLE_LABEL_CHAR.test(source.slice(m.index, at))) continue;
      const original = Array.from(m);
      original[1] = source.slice(at, at + m[1].length);
      original.index = m.index;
      original.input = source;
      visit(original);
    }
  }

  // ── Labels a scam message asks for ──
  // The code and gift card labels, reused here for a message that asks for one of those codes, as in "tell me the code
  // we texted you". This is what scam-signs.js reads, matching labels only and never an actual value, in
  // both English and Spanish.
  const askLabels = Object.freeze({
    login_code: new RegExp(`${LOGIN_NAMES}|${CODE_THEY_SENT}|${LOGIN_LABEL_ES}`, "giu"),
    card_code: new RegExp(CARD_LABEL, "giu"),
    gift_card: new RegExp(GIFT_WORDS, "giu"),
    remote_code: new RegExp(`${REMOTE_WORDS}|${REMOTE_WORDS_ES}`, "giu"),
    recovery_codes: new RegExp(RECOVERY_LABEL, "giu"),
    security_answer: new RegExp(`${ANSWER_LABEL}|${ANSWER_LABEL_ES}`, "giu"),
  });

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    ASK_REASONS,
    REMOTE_LABEL,
    CONFUSABLE_LABEL_CHAR,
    forConfusableLabelMatches,
    askLabels,
  };
})();

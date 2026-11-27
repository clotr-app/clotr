// Reading the value right after a label, which the bank, ID and license rules share.
(() => {
  "use strict";

  const { spanText, digitsOf, numberRuns } = globalThis.ClotrInternal;

  // ---------- The value right after a label ----------
  // Reads things like "account number is 1234…", "routing: 021000021" or "driver's license: D1234567".
  // Medicare numbers can also stand on their own.

  // What may sit between a label and its value: "number", "no.", "#", ":", "is".
  const LABEL_CONNECTOR = String.raw`(?:\s*(?:number|no\.?|num|#|id))?\s*(?:[:=#]|is|was)?\s*`;
  // "driver's license", "driving licence" or "driving lic." as a label. Licenses and Spanish labels both read it.
  const LICENSE_WORDS = String.raw`(?:driver'?s?|driving)\s+lic(?:en[cs]e|\.)?`;
  const LETTERS_AND_DIGITS_ID = /[A-Za-z0-9][A-Za-z0-9-]{3,19}/y;

  function label(words, flags = "gi") {
    return new RegExp(String.raw`\b(?:${words})(?![a-z])${LABEL_CONNECTOR}`, flags);
  }

  // Number runs by where they start.
  function runsByStart(text) {
    return new Map(numberRuns(text).map((run) => [run.units[0].start, run]));
  }

  // A number (digits or number words) that starts exactly where the label ends.
  function numberAfter(labels, text, okDigits) {
    let byStart = null; // built only once a label is found
    const found = [];
    for (const labelRe of labels) {
      for (const match of text.matchAll(labelRe)) {
        if (!byStart) byStart = runsByStart(text);
        const run = byStart.get(match.index + match[0].length);
        if (run && okDigits(digitsOf(run.groups))) found.push(spanText(text, run.groups));
      }
    }
    return found;
  }

  // A letters-and-digits ID right after the label. It needs 4 digits: "the license is MIT" isn't one.
  function idAt(text, at) {
    LETTERS_AND_DIGITS_ID.lastIndex = at;
    const id = LETTERS_AND_DIGITS_ID.exec(text)?.[0].replace(/-+$/, "");
    if (!id) return null;
    return id.replace(/\D/g, "").length >= 4 ? id : null;
  }

  function idAfter(labels, text) {
    const found = [];
    for (const labelRe of labels) {
      for (const match of text.matchAll(labelRe)) {
        const id = idAt(text, match.index + match[0].length);
        if (id) found.push(id);
      }
    }
    return found;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    LICENSE_WORDS,
    label,
    runsByStart,
    numberAfter,
    idAt,
    idAfter,
  };
})();

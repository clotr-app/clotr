// Where a sentence ends, so a found detail never runs from one sentence into the next.
(() => {
  "use strict";

  // ---------- Where a sentence ends ----------

  // A detail never spans a sentence end, so "in 5 minutes. Drive safe!" isn't the street "5 minutes Drive".
  // A dot after an abbreviation, an initial or a dotted word doesn't end one ("123 Main St. Apt 4"), and
  // neither does one after "The": "The. Xbox name…" is two spaces a phone keyboard turned into a period.
  const ABBREVIATIONS = new Set(
    (
      "st mt ft dr jr sr mr mrs ms mx prof rev gen col lt sgt capt gov sen rep pres no nos vs etc approx inc co corp " +
      "ltd apt ste bldg fl rm dept ave av rd blvd ln ct pl ter cir pkwy hwy trl sq cres ne nw se sw jan feb mar apr " +
      "jun jul aug sep sept oct nov dec sra srta dra avda pza cra nro núm ud uds lic ing"
    ).split(" "),
  );
  const NO_SENTENCE_ENDS_ON = "a|an|the|my|your|his|her|our|their|this|that|el|la|los|las|un|una|mi|mis|tu|tus|su|sus";
  const NO_END_WORD = new RegExp(`^(?:${NO_SENTENCE_ENDS_ON})$`, "i");

  // Whether a full stop right after `word` ends a sentence.
  function dotEndsSentence(word) {
    if (word.length <= 1 || word.includes(".")) return false;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
    return !NO_END_WORD.test(word);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, NO_SENTENCE_ENDS_ON, dotEndsSentence };
})();

// Driver's licenses, passports, Medicare and other health or insurance IDs, and medical record numbers.
(() => {
  "use strict";

  const {
    LICENSE_WORDS,
    label,
    numberAfter,
    idAt,
    idAfter,
    AU_MEDICARE_LABELS,
    auMedicareValid,
    spanishPassports,
    spanishLicenses,
    spanishMedicalRecords,
    spanishInsuranceIds,
  } = globalThis.ClotrInternal;

  // ── Driver's licenses ─────────────────────────────

  // Matches "driver's license", "driving licence" and short forms like "D.L." or "DL#", but only "DL" in
  // capitals, since lowercase "dl" is a download. "DL" stuck directly to what follows is never a label, since
  // "DL380" is a server and "DL1234" a Delta flight. "DL" followed by just a space only counts before a
  // number shaped like a state's license (LICENSE_SHAPE); otherwise "DL 1234" is still a flight.
  const LICENSE_LABELS = [label(LICENSE_WORDS)];
  const SHORT_LICENSE_LABEL = label(String.raw`D\.L\.?|DL\.?(?![A-Za-z0-9])`, "g");
  // A state's license number, the way states actually write them: one to three letters and five or more
  // digits, like California's D1234567, or six or more digits alone, like Texas's 12345678. Some states add a
  // letter at the end, like Idaho's AB123456C. Dashes don't count toward the digits.
  const LICENSE_SHAPE = /^(?:[A-Z]{1,3}\d{5,14}|\d{6,14})[A-Z]?$/i;

  function licensesAfterDL(text) {
    const found = [];
    for (const match of text.matchAll(SHORT_LICENSE_LABEL)) {
      const id = idAt(text, match.index + match[0].length);
      if (!id) continue;
      const bare = /^DL\.?\s*$/.test(match[0]); // no "#", ":", "no." or "is" after it
      if (!bare || LICENSE_SHAPE.test(id.replace(/-/g, ""))) found.push(id);
    }
    return found;
  }

  // A UK driving licence's 16-character number, unlabelled: 5 letters (the surname, padded with 9s if
  // shorter), 6 digits encoding the date of birth (month +50 for a woman, so it reads 1-12 or 51-62), 2
  // letters (initials, 9 if there's no middle one), a digit and 2 more letters. This is a structure check,
  // not the DVLA's full algorithm, so it's read only on its own, the same way a bare VIN is.
  const UK_LICENCE_RE = /\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/g;

  function ukLicenceValid(licence) {
    const month = Number(licence.slice(6, 8)) % 50;
    const day = Number(licence.slice(8, 10));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  function findUkLicences(text) {
    return (text.match(UK_LICENCE_RE) || []).filter(ukLicenceValid);
  }

  // Also checks Spanish labels, through spanishLicenses in spanish-labelled-ids.js.
  function findLicenses(text) {
    return [
      ...idAfter(LICENSE_LABELS, text),
      ...licensesAfterDL(text),
      ...spanishLicenses(text),
      ...findUkLicences(text),
    ];
  }

  // ── Health, passport and insurance IDs ────────────

  const PASSPORT_LABELS = [label("passport")];
  const INSURANCE_LABELS = [
    label(String.raw`(?:insurance|member|policy|subscriber|medicaid)(?=\s*(?:id|number|no\.?|#))`),
  ];
  const MEDICARE_LABELS = [label("medicare")];
  const CA_HEALTH_CARD_LABELS = [label(String.raw`(?:provincial\s+)?health\s+card|OHIP`)];
  // Medicare Beneficiary Identifier: 11 characters in a fixed letter/digit layout (no S, L, O, I, B, Z).
  const MBI_LETTER = "[AC-HJKMNP-RT-Y]";
  const MBI_LETTER_OR_DIGIT = "[AC-HJKMNP-RT-Y0-9]";
  // The middle two groups are each a letter, a letter or digit, and a digit.
  const MBI_GROUP = String.raw`${MBI_LETTER}${MBI_LETTER_OR_DIGIT}\d`;
  const MBI_RE = new RegExp(String.raw`\b[1-9]${MBI_GROUP}-?${MBI_GROUP}-?${MBI_LETTER}{2}\d{2}\b`, "g");

  function findMedicare(text) {
    return [
      ...(text.match(MBI_RE) || []),
      ...idAfter(MEDICARE_LABELS, text),
      ...numberAfter(AU_MEDICARE_LABELS, text, auMedicareValid),
      ...idAfter(CA_HEALTH_CARD_LABELS, text),
    ];
  }

  function findPassports(text) {
    return [...idAfter(PASSPORT_LABELS, text), ...spanishPassports(text)];
  }

  function findInsuranceIds(text) {
    return [...idAfter(INSURANCE_LABELS, text), ...spanishInsuranceIds(text)];
  }

  // ── Medical record numbers ────────────────────────
  // Reads medical record and patient numbers after their label, and UK NHS numbers (10 digits, with a mod
  // 11 check). When "MRN" has letters right after it, like "MRNWQ3FY8P394VH6U", that's the start of a code,
  // not a label, though "MRN00123456" still counts.

  const MEDICAL_RECORD = String.raw`medical\s+record(?:\s+(?:number|no\.?|#))?`;
  const PATIENT_NUMBER = String.raw`patient\s+(?:id|number|no\.?|#)`;
  const MRN_LABELS = [
    new RegExp(String.raw`\b(?:MRN(?![a-z])|${MEDICAL_RECORD}|${PATIENT_NUMBER})\s*(?:is\s*)?[:#-]?\s*`, "gi"),
  ];
  const NHS_LABELS = [/\bNHS(?:\s+(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];

  function nhsValid(digits) {
    if (!/^\d{10}$/.test(digits)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    return check !== 10 && check === Number(digits[9]);
  }

  function findMedicalRecords(text) {
    return [...idAfter(MRN_LABELS, text), ...numberAfter(NHS_LABELS, text, nhsValid), ...spanishMedicalRecords(text)];
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    findLicenses,
    findMedicare,
    findPassports,
    findInsuranceIds,
    findMedicalRecords,
  };
})();

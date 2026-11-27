// IDs, passports, licenses and insurance numbers right after a Spanish label. Phones skip what these read.
(() => {
  "use strict";

  const { LICENSE_WORDS, idAt, JUST_A_YEAR, sticky } = globalThis.ClotrInternal;

  // ---------- IDs after a Spanish label ----------
  // ── Reading a value after a Spanish label ─────────
  // How people in Spanish-speaking countries write who they are, in forms the other ID rules miss. Each
  // one only counts right after its own label, so the same digits sitting anywhere else stay quiet.

  // Between a label and its value: "es", "era", ":", "#", "n.º", "No.", "número", or an abbreviation in
  // brackets, as in "mi pasaporte es G12345678" or "Número de Seguridad Social (NSS): …". This also matches in
  // English, as in "my IMSS number is …".
  // The scan reads "º" as a plain "o", so "n.º" arrives as "n.o" and "nº" as "no", even before a letter-led ID.
  const NUMBER_WORD = String.raw`n[uú]mero|number|n[uú]m\.?|nro\.?|n\.?\s?[º°]\.?`;
  const NO_WORD = String.raw`n\.\s?o\.?(?![\p{L}])|no\.|no(?=\s*[A-Za-z]{0,3}\d)`;
  const SPANISH_NUMBER_LABEL = `(?:${NUMBER_WORD}|${NO_WORD})`;
  const THEN_ABBREVIATION = String.raw`(?:\s*\([\p{L}.\s]{2,12}\))?`;
  const THEN_NUMBER_WORD = String.raw`(?:\s*${SPANISH_NUMBER_LABEL})?`;
  const IS_THE = String.raw`(?:es|era|is|was)(?![\p{L}])(?:\s+(?:el|la)(?![\p{L}]))?`;
  const THEN_COLON_OR_IS = String.raw`(?:\s*(?:[:=#]|${IS_THE}))?`;
  const SPANISH_LABEL_CONNECTOR = String.raw`(?![\p{L}])${THEN_ABBREVIATION}${THEN_NUMBER_WORD}${THEN_COLON_OR_IS}\s*`;

  // A label glued to a digit before it is part of a code, like the "CC" in an uppercase hash "…88728063CC849338".
  function spanishLabel(words) {
    return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${words})${SPANISH_LABEL_CONNECTOR}`, "giu");
  }

  // Every value `read(text, at, label)` finds where a label ends.
  function valuesAfterLabel(labelRe, text, read) {
    return [...text.matchAll(labelRe)]
      .map((match) => read(text, match.index + match[0].length, match[0]))
      .filter(Boolean);
  }

  function idNotYear(text, at) {
    const id = idAt(text, at);
    return id && !JUST_A_YEAR.test(id) ? id : null;
  }

  // ── National IDs: NSS, DNI, cédula, RUT ───────────

  // Mexico's social security number (NSS) is 11 digits after "NSS", "IMSS" or "seguro social" (Spain's has
  // 12 digits, handled by NSS_RE in national-ids.js). The IMSS help line, "01 800 …", isn't one.
  const MX_NSS_LABEL = spanishLabel(String.raw`NSS|IMSS|segur(?:o|idad)\s+social`);
  const MX_NSS_VALUE = /(?!01[\s-]?800)\d(?:[\s-]?\d){10}(?![\s-]?\d)/y;
  // Argentina's and Peru's DNI: 7 or 8 digits, with or without dots ("DNI 30.571.264"). Spain's, with its check
  // letter, has its own rule (DNI_RE).
  const LATAM_DNI_LABEL = spanishLabel(String.raw`D\.?N\.?I\.?|documento\s+nacional\s+de\s+identidad`);
  const LATAM_DNI_VALUE = /(?:\d{1,2}\.\d{3}\.\d{3}|\d{7,8})(?![.,]?\d|\p{L}|[-\s][A-HJ-NP-TV-Z](?![\p{L}\d]))/uy;
  // Colombia's cédula, and other countries' "cédula de identidad", is 6 to 10 digits, with or without dots,
  // maybe a Venezuelan V- or E- in front or a check digit after. It counts after "cédula", "C.C." or "CC".
  const CEDULA_LABEL = spanishLabel(
    String.raw`c[eé]dula(?:\s+de\s+(?:ciudadan[ií]a|identidad|extranjer[ií]a|identificaci[oó]n))?|c\.\s?c\.|cc`,
  );
  const CEDULA_VALUE = /(?:[VE]-?)?(?:\d{1,3}(?:\.\d{3}){2,3}|\d{6,10})(?:-[\dkK])?(?![.,]?\d|\p{L})/uy;
  // Chile's RUT (or RUN): "12.345.678-5", only with a right check digit (mod 11, K for 10).
  const RUT_LABEL = spanishLabel(String.raw`R\.?U\.?[TN]\.?`);
  const RUT_VALUE = /(\d{1,2}(?:\.\d{3}){2}|\d{7,8})-?([\dkK])(?![\p{L}\d])/uy;

  // "CC" and "RUN" count only in capitals: "cc" is a copy and "run" an English word.
  function lowercaseShortLabel(foundLabel) {
    if (!/^(?:c\.?\s?c|r\.?u\.?n)(?![\p{L}])/iu.test(foundLabel)) return false;
    return !/^(?:C\.?\s?C|R\.?U\.?N)/.test(foundLabel);
  }

  // The RUT's digits from the right, weighted 2, 3, 4, 5, 6, 7, then 2 again.
  function rutValid(body, check) {
    const digits = body.replace(/\./g, "");
    let sum = 0;
    let weight = 2;
    for (let i = digits.length - 1; i >= 0; i--) {
      sum += Number(digits[i]) * weight;
      weight = weight === 7 ? 2 : weight + 1;
    }
    const result = 11 - (sum % 11);
    let expected = String(result);
    if (result === 11) expected = "0";
    if (result === 10) expected = "K";
    return expected === check.toUpperCase();
  }

  function mxNssAt(text, at) {
    return sticky(MX_NSS_VALUE, text, at)?.[0];
  }

  function latamDniAt(text, at) {
    return sticky(LATAM_DNI_VALUE, text, at)?.[0];
  }

  function cedulaAt(text, at, foundLabel) {
    if (lowercaseShortLabel(foundLabel)) return null;
    return sticky(CEDULA_VALUE, text, at)?.[0];
  }

  function rutAt(text, at, foundLabel) {
    if (lowercaseShortLabel(foundLabel)) return null;
    const rut = sticky(RUT_VALUE, text, at);
    return rut && rutValid(rut[1], rut[2]) ? rut[0] : null;
  }

  function spanishNationalIds(text) {
    return [
      ...valuesAfterLabel(MX_NSS_LABEL, text, mxNssAt),
      ...valuesAfterLabel(LATAM_DNI_LABEL, text, latamDniAt),
      ...valuesAfterLabel(CEDULA_LABEL, text, cedulaAt),
      ...valuesAfterLabel(RUT_LABEL, text, rutAt),
    ];
  }

  // ── Passports, licenses, medical records ──────────

  // Reads a passport after "pasaporte", a driver's license after "licencia de manejo" or "conducir" (Peru's
  // "brevete"), and in English a license number in brackets after its label, as in "driver's license
  // (D1234567)". Spain's "carné de conducir" carries the DNI number, which national-ids.js
  // already finds.
  const PASAPORTE_LABEL = spanishLabel("pasaporte");
  const LICENCIA_LABEL = spanishLabel(
    String.raw`lic(?:encia|\.)?\s+de\s+(?:manejo|manejar|conducir|conducci[oó]n)|brevete`,
  );
  const LICENSE_IN_BRACKETS = [
    new RegExp(String.raw`\b${LICENSE_WORDS}(?:\s*(?:number|no\.?|num|#))?\s*\(\s*`, "gi"),
    /\bD\.?L\.?\s*\(\s*/g,
  ];

  function spanishPassports(text) {
    return valuesAfterLabel(PASAPORTE_LABEL, text, idNotYear);
  }

  function spanishLicenses(text) {
    return [
      ...valuesAfterLabel(LICENCIA_LABEL, text, idNotYear),
      ...LICENSE_IN_BRACKETS.flatMap((labelRe) => valuesAfterLabel(labelRe, text, idNotYear)),
    ];
  }

  // Reads "historia clínica", and a clinic's "expediente" when it's someone's or numbered, as in "mi
  // expediente" or "número de expediente". A court's "expediente 1234/2023" isn't a medical record.
  const HISTORIA_LABEL = spanishLabel(String.raw`historia\s+cl[ií]nica`);
  const WHOSE_OR_NUMBER = String.raw`(?:mi|su|tu|n[uú]mero|n[uú]m\.?|nro\.?|n\.?\s?[º°]\.?|no\.)`;
  const MEDICAL_KIND = String.raw`(?:cl[ií]nico|m[eé]dico|hospitalario)`;
  const EXPEDIENTE_LABEL = spanishLabel(
    String.raw`${WHOSE_OR_NUMBER}\s+(?:de(?:l)?\s+)?expediente(?:\s+${MEDICAL_KIND})?|expediente\s+${MEDICAL_KIND}`,
  );

  function medicalExpedienteAt(text, at) {
    const id = idNotYear(text, at);
    if (!id) return id;
    const courtCase = text[at + id.length] === "/";
    return courtCase ? false : id;
  }

  function spanishMedicalRecords(text) {
    return [
      ...valuesAfterLabel(HISTORIA_LABEL, text, idNotYear),
      ...valuesAfterLabel(EXPEDIENTE_LABEL, text, medicalExpedienteAt),
    ];
  }

  // ── Insurance, member and routing numbers ─────────

  // Reads "Medicaid ID es …" or "número de Medicaid es …" (Medicaid's number also counts as an insurance
  // member ID in English), plus an "afiliado" number of 6+ digits, as in "número de afiliada: 15234987/02".
  // A bare "Medicaid" only counts with "es" right after it, since "Medicaid 1115 waivers" names a law.
  const MEDICAID_NUMBER = String.raw`n[uú]mero\s+de(?:l)?\s+medicaid${SPANISH_LABEL_CONNECTOR}`;
  const MEDICAID_ID_WORD = String.raw`(?:\s+(?:id|number|no\.?|#))?`;
  const MEDICAID_IS = String.raw`medicaid${MEDICAID_ID_WORD}\s+(?:es|era)(?![\p{L}])(?:\s+(?:el|la)(?![\p{L}]))?\s*`;
  const MEDICAID_ES = new RegExp(String.raw`(?<![\p{L}])(?:${MEDICAID_NUMBER}|${MEDICAID_IS})`, "giu");
  const AFILIADO_LABEL = spanishLabel(String.raw`afiliad[oa]`);
  // A US routing number in Spanish, as US banks write it: "número de ruta 021000021", "ruta bancaria: …". Its
  // check digit (abaValid) still has to be right.
  const ROUTING_ES = spanishLabel(
    String.raw`${SPANISH_NUMBER_LABEL}\s+de\s+ruta(?:\s+bancaria)?|ruta\s+(?:bancaria|ABA)`,
  );
  // Letters, digits, dashes and slashes, or digits in groups with single spaces ("61 234567 8 01").
  const MEMBER_ID = /\d{2,12}(?: \d{1,12}){1,4}(?![\p{L}\d/-])|[A-Za-z0-9][A-Za-z0-9/-]{3,24}/uy;
  // An insurance policy or health insurance number, as in "número de póliza 4402-778-19" or "número de seguro
  // médico: W482913765". The number word has to be there, before or after the name, since "la póliza 2024-2025"
  // is a policy year and "mi seguro médico cubre …" says nothing about a number.
  const POLICY_ES = String.raw`p[oó]liza|seguro\s+m[eé]dico`;
  const NUMBER_OF_POLICY = String.raw`${SPANISH_NUMBER_LABEL}\s+de(?:l)?\s+(?:(?:la|mi|tu|su)\s+)?(?:${POLICY_ES})`;
  const POLICY_THEN_NUMBER = String.raw`(?:${POLICY_ES})(?=\s*(?:${SPANISH_NUMBER_LABEL}|[:#]))`;
  const POLIZA_LABEL = spanishLabel(`${NUMBER_OF_POLICY}|${POLICY_THEN_NUMBER}`);

  function dateOrYear(value) {
    return JUST_A_YEAR.test(value) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);
  }

  // A member ID with at least 6 digits that isn't a date.
  function memberIdAt(text, at) {
    const id = sticky(MEMBER_ID, text, at)?.[0].replace(/[-/]+$/, "");
    if (!id) return null;
    if (id.replace(/\D/g, "").length < 6) return null;
    return dateOrYear(id) ? null : id;
  }

  function spanishInsuranceIds(text) {
    return [
      ...valuesAfterLabel(MEDICAID_ES, text, idNotYear),
      ...valuesAfterLabel(AFILIADO_LABEL, text, memberIdAt),
      ...valuesAfterLabel(POLIZA_LABEL, text, memberIdAt),
    ];
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    spanishNationalIds,
    spanishPassports,
    spanishLicenses,
    spanishMedicalRecords,
    ROUTING_ES,
    spanishInsuranceIds,
  };
})();

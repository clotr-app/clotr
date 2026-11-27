// findIbans(): IBANs, by each country's layout and the mod-97 check.
(() => {
  "use strict";

  // ---------- IBANs ----------
  // ── IBANs ─────────────────────────────────────────
  // An IBAN is a country's code, 2 check digits, then the account in that country's own layout. The mod-97
  // check has to pass too.

  const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g;
  // Each country's layout after the check digits, from SWIFT's IBAN Registry for ISO 13616 (89 countries).
  // "8n10n" means 8 digits then 10 digits, "a" is a capital letter and "c" is a letter or digit; Germany's
  // IBAN, for example, is 22 all-digit characters after "DE". A code from a country not listed, or of a
  // different length or layout, isn't treated as an IBAN, since the mod-97 check alone passes 1 random code
  // in 97. A territory that shares a country's code uses its layout too, so Jersey's IBANs start with GB.
  const IBAN_LAYOUTS = `
    AD 4n4n12c  AE 3n16n  AL 8n16c  AT 5n11n  AZ 4a20c  BA 3n3n8n2n  BE 3n7n2n  BG 4a4n2n8c  BH 4a14c  BI 5n5n11n2n
    BR 8n5n10n1a1c  BY 4c4n16c  CH 5n12c  CR 4n14n  CY 3n5n16c  CZ 4n6n10n  DE 8n10n  DJ 5n5n11n2n  DK 4n9n1n
    DO 4c20n  EE 2n14n  EG 4n4n17n  ES 4n4n1n1n10n  FI 3n11n  FK 2a12n  FO 4n9n1n  FR 5n5n11c2n  GB 4a6n8n  GE 2a16n
    GI 4a15c  GL 4n9n1n  GR 3n4n16c  GT 4c20c  HN 4a20n  HR 7n10n  HU 3n4n1n15n1n  IE 4a6n8n  IL 3n3n13n  IQ 4a3n12n
    IS 4n2n6n10n  IT 1a5n5n12c  JO 4a4n18c  KW 4a22c  KZ 3n13c  LB 4n20c  LC 4a24c  LI 5n12c  LT 5n11n  LU 3n13c
    LV 4a13c  LY 3n3n15n  MC 5n5n11c2n  MD 2c18c  ME 3n13n2n  MK 3n10c2n  MN 4n12n  MR 5n5n11n2n  MT 4a5n18c
    MU 4a2n2n12n3n3a  NI 4a20n  NL 4a10n  NO 4n6n1n  OM 3n16c  PK 4a16c  PL 8n16n  PS 4a21c  PT 4n4n11n2n  QA 4a21c
    RO 4a16c  RS 3n13n2n  RU 9n5n15c  SA 2n18c  SC 4a2n2n16n3a  SD 2n12n  SE 3n16n1n  SI 5n8n2n  SK 4n6n10n
    SM 1a5n5n12c  SO 4n3n12n  ST 4n4n11n2n  SV 4a20n  TL 3n14n2n  TN 2n3n13n2n  TR 5n1n16c  UA 6n19c  VA 3n15n
    VG 4a16n  XK 4n10n2n  YE 4a4n18c
  `;
  const IBAN_PART = { n: "\\d", a: "[A-Z]", c: "[A-Z0-9]" };

  // "DE 8n10n" becomes /^DE\d\d\d{8}\d{10}$/.
  function ibanShape(country, layout) {
    const parts = layout.replace(/(\d+)([nac])/g, (_, count, kind) => `${IBAN_PART[kind]}{${count}}`);
    return new RegExp(`^${country}\\d\\d${parts}$`);
  }

  const IBAN_SHAPES = new Map(
    [...IBAN_LAYOUTS.matchAll(/([A-Z]{2}) (\S+)/g)].map(([, country, layout]) => [country, ibanShape(country, layout)]),
  );

  // The remainder of a long string of digits divided by 97, one digit at a time.
  function mod97(digits) {
    let rest = 0;
    for (const char of digits) rest = (rest * 10 + Number(char)) % 97;
    return rest;
  }

  function ibanValid(raw) {
    const iban = raw.replace(/[ -]/g, "");
    if (!IBAN_SHAPES.get(iban.slice(0, 2))?.test(iban)) return false;
    // The country and check digits move to the end, and each letter becomes a number (A is 10, B is 11 …).
    const moved = iban.slice(4) + iban.slice(0, 4);
    const digits = moved.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
    return mod97(digits) === 1;
  }

  function findIbans(text) {
    return (text.match(IBAN_RE) || []).filter(ibanValid);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, mod97, ibanValid, findIbans };
})();

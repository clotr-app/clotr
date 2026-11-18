// The hostile units for the service-token growth tests, shared by the clock checks in tests/engine-recall.test.js
// and the count checks in tests/engine-recall-work.test.js.
"use strict";

// Each provider rule's own prefix or marker. Repeated, a marker made of characters its body allows must not send
// the scan over the rest of the text again from every copy.
const MARKERS = [
  "pypi-AgENdGVzdC5weXBpLm9yZw",
  "GOCSPX-",
  "ya29.",
  "1//0",
  "aB18Q~",
  "AZDO",
  "+ACR",
  "0.A",
  "1.A",
  "sbp_",
  "lsv2_pt_",
  "sk-lf-",
  "pcsk_",
  "dckr_pat_",
  "dckr_oat_",
  "ntn_",
  "secret_",
  "pat",
  "ATBB",
  "BBDC-",
  ".atlasv1.",
  "dp.st.",
  "O",
  "fw_",
  "EAAA",
  "sq0csp-",
  "sq0atp-",
  "access_token$production$",
  "EAAB",
  "sl.",
  "sk.eyJ",
  "CFPAT-",
  "NRAK-",
  "napi_",
  "pscale_tkn_",
  "figd_",
  "bkua_",
  "tfp_",
  "pnu_",
  "rdme_",
  "dt0c01.",
  "EZAK",
  "fio-u-",
  "ico-",
  "xkeysib-",
  "shippo_live_",
  "duffel_live_",
  "AKCp",
  "cmVmd",
  "LTAI",
  "4b1d",
  "p8e-",
  "sha256~",
  "tk-us-",
  "pat.",
  "sgp_",
  "API-",
  "FLWSECK-",
  "_mmk",
  "s-s4t2ud-",
  "ramp_sec_",
  "sm_pat_",
  "nvapi-",
  "sk_",
];

// Units around the provider rules that read the words or link parts near a token. `random(set, n)` makes the bodies.
function contextUnits(random) {
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const HEX = "0123456789abcdef";
  const sig = `${random(ALNUM, 43)}=`;
  return [
    `&sig=${sig}`,
    `?sv=2022-11-02&sig=${sig}`,
    `&amp;sv=2022-11-02&amp;sig=${sig}`,
    `\\u0026sv=2022-11-02\\u0026sig=${sig}`,
    "&sig=",
    `${random(HEX, 32)}-${random(HEX, 8)}-${random(HEX, 8)} mailgun `,
    `${random(HEX, 32)}-`,
    `okta 00${random(`${ALNUM}-_`, 40)} `,
    "SSWS 00",
    `azure ${random("abcdefghijklmnopqrstuvwxyz0123456789", 52)} `,
  ];
}

module.exports = { MARKERS, contextUnits };

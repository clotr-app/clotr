// Developer credentials found by their provider's own shape, with no label in front: bare, inside a sentence and
// after a label. Every value is built here from a seeded generator, so none is a working credential.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestOfPair, grewMoreThan } = require("./timing.js");

require("../extension/patterns.js");
require("../extension/detector.js");

const Clotr = globalThis.Clotr;

// { kind: [matches] }
function detect(text) {
  return Object.fromEntries(Clotr.detect(text).map((r) => [r.id, r.matches]));
}

let seed = 20261101;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOW = "abcdefghijklmnopqrstuvwxyz";
const DIG = "0123456789";
const HEX = "0123456789abcdef";
const ALNUM = UP + LOW + DIG;
const URLSAFE = `${ALNUM}-_`;
// A random string; the first and last characters come from the letters and digits of the set, so a value never
// starts or ends on a separator.
function random(set, n) {
  const ends = set.replace(/[^A-Za-z0-9]/g, "") || set;
  let s = "";
  for (let i = 0; i < n; i++) {
    const from = i === 0 || i === n - 1 ? ends : set;
    s += from[Math.floor(rnd() * from.length)];
  }
  return s;
}
// The same length and characters as a real body, but spelled out of words, the way a doc or a variable name is.
function wordy(set, n) {
  let word = "TokenValueGoesHere";
  if (set === HEX) word = "deadbeefcafe";
  else if (set === DIG) word = "20261101";
  else if (!/[A-Z]/.test(set)) word = "tokenvaluegoeshere";
  else if (!/[a-z]/.test(set)) word = "TOKENVALUEGOESHERE";
  return word.repeat(Math.ceil(n / word.length)).slice(0, n);
}
const uuid = (g) => [8, 4, 4, 4, 12].map((n) => g(HEX, n)).join("-");

// Where Cover it leaves a 12-character run of the token in the text, as an offset into the token, so a failure
// never prints the value.
function leftover(token, text) {
  const out = Clotr.redact(text, Clotr.detect(text));
  for (let i = 0; i + 12 <= token.length; i++) if (out.includes(token.slice(i, i + 12))) return `from ${i}`;
  return "";
}

const credentialKinds = (text) =>
  Clotr.detect(text)
    .filter((r) => r.group === "credentials")
    .map((r) => r.id);

// [provider, make(gen) → token, placeholder written the way a doc or a template writes it]
const PROVIDERS = [
  ["Google OAuth client secret", (g) => `GOCSPX-${g(URLSAFE, 28)}`, "GOCSPX-your_client_secret_here"],
  ["Google OAuth access token", (g) => `ya29.${g(URLSAFE, 160)}`, "ya29.your_access_token_here"],
  ["Google OAuth refresh token", (g) => `1//0${g(URLSAFE, 99)}`, "1//0your_refresh_token_here"],
  [
    "Microsoft Entra client secret",
    (g) => `${g(ALNUM, 3)}8Q~${g(`${ALNUM}_~.-`, 34)}`,
    "abc8Q~your_client_secret_value_goes_here",
  ],
  [
    "Azure DevOps token",
    (g) => `${g(ALNUM, 76)}AZDO${g(ALNUM, 4)}`,
    `your_azure_devops_token_here${"x".repeat(48)}AZDOxxxx`,
  ],
  ["Azure Container Registry password", (g) => `${g(ALNUM, 42)}+ACR${g(ALNUM, 6)}`, `your_registry_password+ACRxxxxxx`],
  ["Supabase access token", (g) => `sbp_${g(HEX, 40)}`, "sbp_your_access_token_here"],
  ["LangSmith key", (g) => `lsv2_pt_${g(HEX, 32)}_${g(HEX, 10)}`, "lsv2_pt_your_api_key_here"],
  ["Langfuse secret key", (g) => `sk-lf-${uuid(g)}`, ["sk", "lf", "your", "secret", "key", "here"].join("-")],
  ["Pinecone key", (g) => `pcsk_${g(ALNUM, 6)}_${g(ALNUM, 63)}`, "pcsk_your_api_key_here"],
  ["Docker Hub token", (g) => `dckr_pat_${g(URLSAFE, 27)}`, "dckr_pat_your_token_here"],
  ["Docker Hub organization token", (g) => `dckr_oat_${g(URLSAFE, 32)}`, "dckr_oat_your_token_here"],
  ["Notion token", (g) => `ntn_${g(DIG, 11)}${g(ALNUM, 35)}`, "ntn_your_integration_token_here"],
  ["Notion legacy token", (g) => `secret_${g(ALNUM, 43)}`, "secret_your_integration_token_here"],
  ["Airtable token", (g) => `pat${g(ALNUM, 14)}.${g(HEX, 64)}`, "patYourTokenHere.your_token_here"],
  ["Bitbucket app password", (g) => `ATBB${g(ALNUM, 32)}`, "ATBByour_app_password_here"],
  ["Bitbucket Data Center token", (g) => `BBDC-${g(`${ALNUM}+`, 44)}`, "BBDC-your-token-here"],
  ["Terraform Cloud token", (g) => `${g(ALNUM, 14)}.atlasv1.${g(ALNUM, 67)}`, "xxxxxxxxxxxxxx.atlasv1.your_token_here"],
  ["Doppler personal token", (g) => `dp.pt.${g(ALNUM, 43)}`, "dp.pt.your_token_here"],
  ["Doppler service token", (g) => `dp.st.prd.${g(ALNUM, 40)}`, "dp.st.prd.your_token_here"],
  ["TestPyPI token", (g) => `pypi-AgENdGVzdC5weXBpLm9yZw${g(URLSAFE, 120)}`, "pypi-your_api_token_here"],
  [
    "Discord bot token for a newer bot",
    (g) => `OT${g(ALNUM, 24)}.${g(URLSAFE, 6)}.${g(URLSAFE, 38)}`,
    "OTyour_bot_token_here.xxxxxx.yyyyyy",
  ],
  ["Fireworks key", (g) => `fw_${g(ALNUM, 24)}`, "fw_your_api_key_here"],
  ["Square access token", (g) => `EAAA${g(URLSAFE, 60)}`, "EAAAyour_access_token_here"],
  ["Square application secret", (g) => `sq0csp-${g(URLSAFE, 43)}`, "sq0csp-your_application_secret_here"],
  ["Square legacy access token", (g) => `sq0atp-${g(URLSAFE, 22)}`, "sq0atp-your_access_token"],
  [
    "Braintree access token",
    (g) => `access_token$production$${g(LOW + DIG, 16)}$${g(HEX, 32)}`,
    "access_token$production$your_merchant_id$your_token",
  ],
  ["Facebook access token", (g) => `EAAG${g(ALNUM, 180)}`, "EAAGyour_access_token_here"],
  ["Dropbox token", (g) => `sl.${g(URLSAFE, 135)}`, "sl.your_access_token_here"],
  ["Mapbox secret token", (g) => `sk.eyJ1Ijoi${g(ALNUM, 60)}.${g(URLSAFE, 22)}`, "sk.your_secret_token_here"],
  ["Contentful token", (g) => `CFPAT-${g(URLSAFE, 43)}`, "CFPAT-your_token_here"],
  ["New Relic user key", (g) => `NRAK-${g(UP + DIG, 27)}`, "NRAK-YOUR_API_KEY_HERE"],
  ["Neon key", (g) => `napi_${g(LOW + DIG, 64)}`, "napi_your_api_key_here"],
  ["PlanetScale token", (g) => `pscale_tkn_${g(`${ALNUM}_`, 43)}`, "pscale_tkn_your_service_token_here"],
  ["Figma token", (g) => `figd_${g(URLSAFE, 40)}`, "figd_your_personal_token_here"],
  ["Buildkite token", (g) => `bkua_${g(LOW + DIG, 40)}`, "bkua_your_api_token_here"],
  ["Typeform token", (g) => `tfp_${g(ALNUM, 44)}_${g(ALNUM, 14)}`, "tfp_your_personal_token_here"],
  ["Prefect key", (g) => `pnu_${g(ALNUM, 36)}`, "pnu_your_api_key_here"],
  ["ReadMe key", (g) => `rdme_${g(LOW + DIG, 70)}`, "rdme_your_api_key_here"],
  ["Dynatrace token", (g) => `dt0c01.${g(UP + DIG, 24)}.${g(UP + DIG, 64)}`, "dt0c01.YOUR_TOKEN_ID.YOUR_SECRET"],
  ["EasyPost key", (g) => `EZAK${g(ALNUM, 54)}`, "EZAKyour_api_key_here"],
  ["Frame.io token", (g) => `fio-u-${g(URLSAFE, 64)}`, "fio-u-your_developer_token_here"],
  ["Infracost key", (g) => `ico-${g(ALNUM, 32)}`, "ico-your_api_key_here"],
  ["Brevo key", (g) => `xkeysib-${g(HEX, 64)}-${g(ALNUM, 16)}`, "xkeysib-your_api_key_here"],
  ["Shippo token", (g) => `shippo_live_${g(HEX, 40)}`, "shippo_live_your_api_token_here"],
  ["Duffel token", (g) => `duffel_live_${g(URLSAFE, 43)}`, "duffel_live_your_access_token_here"],
  ["Artifactory key", (g) => `AKCp${g(ALNUM, 69)}`, "AKCpyour_api_key_here"],
  ["Artifactory reference token", (g) => `cmVmd${g(ALNUM, 59)}`, "cmVmdyour_reference_token"],
  ["Alibaba Cloud key ID", (g) => `LTAI${g(ALNUM, 20)}`, "LTAIyour_access_key_id"],
  ["ClickHouse Cloud key", (g) => `4b1d${g(ALNUM, 38)}`, "4b1dyour_api_secret_here"],
  ["Adobe client secret", (g) => `p8e-${g(ALNUM, 32)}`, "p8e-your_client_secret_here"],
  ["OpenShift token", (g) => `sha256~${g(URLSAFE, 43)}`, "sha256~your_token_here"],
  ["Scalingo token", (g) => `tk-us-${g(URLSAFE, 48)}`, "tk-us-your_api_token_here"],
  [
    "Harness key",
    (g) => `pat.${g(ALNUM, 22)}.${g(ALNUM, 24)}.${g(ALNUM, 20)}`,
    "pat.your_account_id.your_token_id.your_secret",
  ],
  ["Sourcegraph token", (g) => `sgp_${g(HEX, 16)}_${g(HEX, 40)}`, "sgp_your_access_token_here"],
  ["Octopus Deploy key", (g) => `API-${g(UP + DIG, 26)}`, "API-YOUR_API_KEY_HERE"],
  ["Flutterwave secret key", (g) => `FLWSECK-${g(HEX, 32)}-X`, "FLWSECK-your_secret_key-X"],
  ["MaxMind licence key", (g) => `${g(ALNUM, 6)}_${g(ALNUM, 29)}_mmk`, "your_license_key_mmk"],
  ["42 Intra secret", (g) => `s-s4t2ud-${g(HEX, 64)}`, "s-s4t2ud-your_client_secret"],
  ["Ramp secret", (g) => `ramp_sec_${g(ALNUM, 48)}`, "ramp_sec_your_client_secret"],
  ["SettleMint token", (g) => `sm_pat_${g(ALNUM, 16)}`, "sm_pat_your_token"],
  ["NVIDIA key", (g) => `nvapi-${g(URLSAFE, 64)}`, "nvapi-your_api_key_here"],
  ["ElevenLabs key", (g) => `sk_${g(HEX, 48)}`, "sk_your_api_key_here"],
  [
    "Microsoft Entra refresh token",
    (g) => `0.A${g(URLSAFE, 60)}.Ag${g(URLSAFE, 300)}`,
    "0.Ayour_refresh_token_here.Agyour_refresh_token_here",
  ],
];

for (const [provider, make, placeholder] of PROVIDERS) {
  test(`${provider}: a service token bare, in a sentence and after a label, and Cover it hides all of it`, () => {
    const token = make(random);
    for (const [shape, text] of [
      ["bare", token],
      ["sentence", `Can you see why my script fails when I set it to ${token} before the request?`],
      ["label", `token: ${token}`],
    ]) {
      const found = detect(text);
      assert.ok(found.service_token?.includes(token), `${provider} ${shape}: ${JSON.stringify(Object.keys(found))}`);
      assert.equal(found.password, undefined, `${provider} ${shape} was also read as a password`);
      assert.equal(leftover(token, text), "", `${provider} ${shape}: Cover it left part of the token`);
    }
  });

  test(`${provider}: quiet on a placeholder and on a body made of words`, () => {
    assert.deepEqual(credentialKinds(placeholder), [], `${provider} placeholder ${placeholder}`);
    const words = make(wordy);
    assert.deepEqual(credentialKinds(words), [], `${provider} word body ${words}`);
  });

  test(`${provider}: a service token between Markdown's emphasis underscores is covered`, () => {
    const token = make(random);
    const text = `the key is _${token}_ now`;
    assert.ok(
      Clotr.detect(text).some((r) => r.id === "service_token"),
      `${provider}: the token was not found`,
    );
    assert.equal(leftover(token, text), "", `${provider}: Cover it left part of the token`);
  });
}

test("an Azure shared access signature URL: the signature is covered, a sig= without sv= stays quiet", () => {
  // 32 bytes in base64 is 43 characters and "=", here with its "+" and "=" percent-encoded the way a link carries them.
  const sig = `${random(ALNUM, 39)}%2B${random(ALNUM, 3)}%3D`;
  const url =
    "https://acmefiles.blob.core.windows.net/reports/q3.pdf?sp=r&st=2026-10-01T10:00:00Z&se=2026-11-01T18:00:00Z" +
    `&spr=https&sv=2022-11-02&sr=b&sig=${sig}`;
  for (const [shape, text] of [
    ["bare", url],
    ["sentence", `the download link ${url} gives 403 since this morning`],
    ["JSON", `"blobUrl": "${url}"`],
  ]) {
    assert.ok(detect(text).service_token?.includes(sig), `${shape}: the signature was not found`);
    assert.ok(!Clotr.redact(text, Clotr.detect(text)).includes(sig.slice(0, 20)), `${shape}: the signature was left`);
  }
  // A connection string's SharedAccessSignature carries the same query with no "?" in front.
  const conn = `BlobEndpoint=https://acmefiles.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&srt=co&sp=rl&se=2026-12-01T00:00:00Z&sig=${sig}`;
  assert.ok(detect(conn).service_token?.includes(sig), "connection string: the signature was not found");
  // A sig= that is not an Azure signature: no sv= version, or a value that is not a 32-byte HMAC.
  assert.equal(detect(`https://example.org/api/download?id=42&sig=${sig}`).service_token, undefined);
  assert.equal(detect("https://acmefiles.blob.core.windows.net/a?sv=2022-11-02&sig=short").service_token, undefined);
});

test("an Azure DevOps token in the older 52-character form is caught next to Azure words only", () => {
  const pat = random(LOW + "234567", 52);
  for (const [shape, text] of [
    ["sentence", `my azure devops PAT is ${pat} and git push still asks for a password`],
    ["clone link", `git clone https://${pat}@dev.azure.com/contoso/web/_git/site`],
  ]) {
    assert.ok(detect(text).service_token?.includes(pat), `${shape}: the token was not found`);
  }
  assert.equal(detect(`the build id was ${pat} and it passed`).service_token, undefined);
});

test("a Microsoft Entra secret's Q~ inside ordinary text stays quiet", () => {
  for (const text of [
    "Q~ is the shortcut I mapped to quit",
    "see section 4Q~ for the details on quarterly numbers",
    "abc1Q~short",
  ]) {
    assert.deepEqual(credentialKinds(text), [], text);
  }
});

test("a Microsoft Entra secret at the end of a sentence is covered to its last character", () => {
  const secret = `${random(ALNUM, 3)}8Q~${random(`${ALNUM}_~-`, 33)}A`;
  const text = `The client secret is ${secret}.`;
  assert.deepEqual(detect(text).service_token, [secret]);
});

test("an Okta API token after its SSWS scheme is a service token", () => {
  const token = `00${random(URLSAFE, 40)}`;
  for (const [shape, text] of [
    ["header", `Authorization: SSWS ${token}`],
    ["curl", `curl -H "Authorization: SSWS ${token}" https://acme.okta.com/api/v1/users`],
  ]) {
    assert.ok(detect(text).service_token?.includes(token), `${shape}: the token was not found`);
    assert.equal(leftover(token, text), "", `${shape}: part of the token was left`);
  }
  assert.deepEqual(credentialKinds("Authorization: SSWS ${OKTA_API_TOKEN}"), []);
});

test("a token whose dashes and underscores happen to break it into short runs is still caught", () => {
  const chunk = () => `${random(UP, 2)}${random(DIG, 1)}${random(LOW, 2)}`;
  const token = `dckr_pat_${chunk()}-${chunk()}_${chunk()}-${chunk()}_${random(ALNUM, 3)}`;
  assert.ok(detect(`login with ${token} fails`).service_token?.includes(token));
  // A slug in one case stays quiet, digits or not.
  assert.deepEqual(credentialKinds("dckr_pat_ci-deploy-token-2026-prod-a"), []);
});

test("an Okta API token next to the word Okta is a service token, and the same shape elsewhere stays quiet", () => {
  const token = `00${random(URLSAFE, 40)}`;
  for (const [shape, text] of [
    ["sentence", `the okta token ${token} stopped working after the org moved`],
    ["setting", `OKTA_ORG_URL=https://acme.okta.com\nOKTA_CLIENT_TOKEN=${token}`],
  ]) {
    assert.ok(detect(text).service_token?.includes(token), `${shape}: the token was not found`);
  }
  assert.equal(detect(`build ${token} passed`).service_token, undefined);
  assert.deepEqual(credentialKinds(`okta token 00${wordy(URLSAFE, 40)}`), []);
});

test("a key wrapped after a short first line is joined when its prefix names the provider", () => {
  for (const token of [`GOCSPX-${random(ALNUM, 28)}`, `dckr_pat_${random(ALNUM, 27)}`, `sbp_${random(HEX, 40)}`]) {
    const prefix = token.slice(0, 5);
    const text = `here it is:\n${token.slice(0, 10)}\n${token.slice(10)}\n`;
    assert.equal(leftover(token.slice(10), text), "", `${prefix}: part of the wrapped key was left`);
    assert.ok(
      Clotr.detect(text).some((r) => r.id === "service_token"),
      `${prefix}: the wrapped key was not found`,
    );
  }
});

// The GitLab and Grafana kinds keep their own names for the token types those providers added.
test("newer GitLab tokens are GitLab tokens", () => {
  for (const token of [
    `glptt-${random(HEX, 40)}`,
    `glffct-${random(URLSAFE, 20)}`,
    `glimt-${random(URLSAFE, 25)}`,
    `GR1348941${random(URLSAFE, 20)}`,
  ]) {
    assert.ok(detect(`set it to ${token} please`).gitlab_token?.includes(token), token);
  }
  assert.deepEqual(credentialKinds(`glptt-${wordy(HEX, 40)}`), []);
});

test("a Grafana API key is a Grafana token", () => {
  const token = `eyJrIjoi${random(ALNUM, 80)}`;
  assert.ok(detect(`GF key ${token} stopped working`).grafana_token?.includes(token));
  assert.deepEqual(credentialKinds(`eyJrIjoi${wordy(ALNUM, 80)}`), []);
});

// Credential kinds that had few direct tests: a positive in the documented shape and a near miss for each.
test("thinly tested credential kinds: one positive and one near miss each", () => {
  const cases = [
    ["stripe_secret_key", `sk_live_${random(ALNUM, 24)}`, `sk_live_${random(ALNUM, 12)}`],
    ["stripe_secret_key", `whsec_${random(ALNUM, 32)}`, `whsec_${random(ALNUM, 20)}`],
    ["atlassian_token", `ATATT3${random(`${ALNUM}_-`, 180)}=${random(ALNUM, 8)}`, `ATATT3${random(`${ALNUM}_-`, 180)}`],
    ["gitlab_token", `glpat-${random(URLSAFE, 20)}`, `glpat-${random(URLSAFE, 12)}`],
    ["perplexity_key", `pplx-${random(ALNUM, 48)}`, `pplx-${wordy(ALNUM, 48)}`],
    ["digitalocean_token", `dop_v1_${random(HEX, 64)}`, `dop_v1_${random(HEX, 63)}`],
    ["huggingface_token", `hf_${random(UP + LOW, 34)}`, `hf_${random(UP + LOW, 33)}`],
    ["heroku_token", `HRKU-${random(URLSAFE, 60)}`, `HRKU-${random(URLSAFE, 59)}`],
    ["onepassword_token", `ops_eyJ${random(`${ALNUM}+/`, 300)}`, `ops_eyJ${random(ALNUM, 100)}`],
    [
      "cloudflare_origin_ca_key",
      `v1.0-${random(HEX, 24)}-${random(HEX, 146)}`,
      `v1.0-${random(HEX, 24)}-${random(HEX, 145)}`,
    ],
    ["netlify_token", `nfp_${random(`${ALNUM}_`, 36)}`, `nfp_${random(`${ALNUM}_`, 35)}`],
    ["pulumi_token", `pul-${random(LOW + DIG, 40)}`, `pul-${random(LOW + DIG, 39)}`],
  ];
  for (const [kind, positive, nearMiss] of cases) {
    const text = `my key is ${positive} and it fails`;
    assert.deepEqual(detect(text)[kind], [positive], `${kind} positive`);
    assert.equal(leftover(positive, text), "", `${kind} positive was not fully covered`);
    assert.equal(detect(nearMiss)[kind], undefined, `${kind} near miss ${nearMiss}`);
  }
});

// ---------- Hostile text ----------

// Checks that a scan grows linearly: 4 times the input should take about 4 times as long, not 16 times
// (quadratic). The timing helper warms both sizes and takes the best of three in alternating order.
function assertLinear(fn, makeInput, units, n = 6000, runs = 3, limit = 12) {
  for (const unit of units) {
    const smallInput = makeInput(unit, n);
    const bigInput = makeInput(unit, n * 4);
    const [small, big] = bestOfPair(
      () => fn(smallInput),
      () => fn(bigInput),
      4,
      runs,
    );
    assert.ok(!grewMoreThan(small, big, limit), `${JSON.stringify(unit)}: time grew too much for 4× the input`);
  }
}
const serviceTokens = Clotr.PATTERNS.find((p) => p.id === "service_token").find;
// About n characters of the unit repeated.
const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length));

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

test("a provider rule's marker repeated over and over is scanned in linear time", () => {
  assertLinear(serviceTokens, fill, MARKERS);
});

test("the context-checked provider rules are scanned in linear time", () => {
  const sig = `${random(ALNUM, 43)}=`;
  assertLinear(serviceTokens, fill, [
    `&sig=${sig}`,
    `?sv=2022-11-02&sig=${sig}`,
    `&amp;sv=2022-11-02&amp;sig=${sig}`,
    `\\u0026sv=2022-11-02\\u0026sig=${sig}`,
    "&sig=",
    `${random(HEX, 32)}-${random(HEX, 8)}-${random(HEX, 8)} mailgun `,
    `${random(HEX, 32)}-`,
    `okta 00${random(URLSAFE, 40)} `,
    "SSWS 00",
    `azure ${random(LOW + DIG, 52)} `,
  ]);
});

test("a long run of a provider's marker does not hide a later token, and Cover it finishes", () => {
  const token = `ghp_${random(ALNUM, 36)}`;
  const text = `${"pypi-AgENdGVzdC5weXBpLm9yZw".repeat(15171)}\nmy token is ${token}`;
  const heapBefore = process.memoryUsage().heapUsed;
  const found = Clotr.detect(text);
  assert.ok(!found.truncated, "the scan ran out of time");
  assert.ok(
    found.some((r) => r.id === "github_token" && r.matches.includes(token)),
    "the token after the run was missed",
  );
  const out = Clotr.redact(text, found);
  assert.ok(!out.includes(token.slice(4)), "Cover it left the token");
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 512 * 2 ** 20, "Cover it held on to too much memory");
});

// ---------- Shapes a pasted token arrives in ----------

test("an Azure shared access signature in HTML or in Go's escaped JSON is covered", () => {
  const sig = `${random(ALNUM, 39)}%2B${random(ALNUM, 3)}%3D`;
  const host = "https://acmefiles.blob.core.windows.net/r/q3.pdf";
  for (const [shape, text] of [
    ["HTML", `<a href="${host}?sv=2022-11-02&amp;sr=b&amp;sp=r&amp;sig=${sig}">q3</a>`],
    ["HTML, signature first", `<a href="${host}?sig=${sig}&amp;sv=2022-11-02&amp;sr=b">q3</a>`],
    // Go's encoding/json writes "&" as &, which is how a link looks in terraform.tfstate.
    ["Go JSON", `{"sas_url":"${host}?sv=2022-11-02\\u0026sr=b\\u0026sp=r\\u0026sig=${sig}"}`],
  ]) {
    assert.ok(detect(text).service_token?.includes(sig), `${shape}: the signature was not found`);
    assert.ok(!Clotr.redact(text, Clotr.detect(text)).includes(sig.slice(0, 20)), `${shape}: the signature was left`);
  }
  assert.equal(detect(`<a href="https://example.org/d?id=42&amp;sig=${sig}">x</a>`).service_token, undefined);
});

test("a Mailgun key in its newer form is caught next to Mailgun words only", () => {
  const key = `${random(HEX, 32)}-${random(HEX, 8)}-${random(HEX, 8)}`;
  for (const [shape, text] of [
    ["setting", `MAILGUN_API_KEY=${key}`],
    ["sentence", `my mailgun key ${key} returns 401`],
    ["curl", `curl -s --user 'api:${key}' https://api.mailgun.net/v3/mg.example.com/messages`],
    ["code", `const mg = mailgun.client({ username: "api", key: "${key}" });`],
  ]) {
    assert.ok(detect(text).service_token?.includes(key), `${shape}: the key was not found`);
    assert.equal(leftover(key, text), "", `${shape}: part of the key was left`);
  }
  // The same shape anywhere else is more likely a cache key or an ID.
  assert.equal(detect(`WARN cache key ${key} miss`).service_token, undefined);
  assert.equal(detect(key).service_token, undefined);
  assert.equal(detect(`mailgun key ${wordy(HEX, 32)}-${wordy(HEX, 8)}-${wordy(HEX, 8)}`).service_token, undefined);
});

test("a token with no digit in it is caught when its prefix belongs to one provider", () => {
  const LETTERS = UP + LOW;
  for (const token of [
    `dckr_pat_${random(LETTERS, 10)}-${random(LETTERS, 9)}_${random(LETTERS, 6)}`,
    `dckr_oat_${random(LETTERS, 32)}`,
    `GOCSPX-${random(LETTERS, 11)}-${random(LETTERS, 16)}`,
    `LTAI${random(LETTERS, 20)}`,
    `sk.eyJ1Ijoi${random(ALNUM, 60)}.${random(LETTERS, 22)}`,
    `${random(ALNUM, 3)}8Q~${random(LETTERS, 20)}.${random(LETTERS, 13)}`,
  ]) {
    const text = `the key ${token} fails`;
    assert.ok(detect(text).service_token?.includes(token), `${token.slice(0, 6)}: the token was not found`);
  }
  // The same lengths spelled out of words, the way a doc or a test fixture writes them, stay quiet.
  for (const text of [
    "dckr_pat_DockerHubPersonalTokenForCI",
    "dckr_oat_OrganizationAccessTokenForDeploy",
    "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",
    "LTAIProductionAccessKeyAb",
  ]) {
    assert.deepEqual(credentialKinds(text), [], text);
  }
});

test("a token in a link that is percent-encoded inside another link's parameter is covered", () => {
  for (const token of [`ghp_${random(ALNUM, 36)}`, `sbp_${random(HEX, 40)}`, `dckr_pat_${random(ALNUM, 27)}`]) {
    const encoded = encodeURIComponent(token);
    const text = `redirect=https%3A%2F%2Fapi.example.com%2Fcb%3Ftoken%3D${encoded}%26x%3D1`;
    assert.ok(Clotr.detect(text).length > 0, `${token.slice(0, 4)}: the token was not found`);
    assert.equal(leftover(encoded, text), "", `${token.slice(0, 4)}: part of the token was left`);
  }
});

test("a token in Markdown emphasis, between underscores, is caught", () => {
  for (const token of [`sbp_${random(HEX, 40)}`, `dckr_pat_${random(ALNUM, 27)}`, `GOCSPX-${random(ALNUM, 28)}`]) {
    const text = `the key is _${token}_ now`;
    assert.ok(detect(text).service_token?.includes(token), `${token.slice(0, 4)}: the token was not found`);
    assert.equal(leftover(token, text), "", `${token.slice(0, 4)}: part of the token was left`);
  }
  // A prefix inside a longer identifier is still not a token.
  assert.equal(detect(`const my_sbp_${random(HEX, 40)} = 1;`).service_token, undefined);
  assert.equal(detect(`sbp_${random(HEX, 40)}_backup_copy`).service_token, undefined);
});

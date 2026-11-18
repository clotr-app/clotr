// Credential formats that providers added in 2024-2026, each found by its documented, prefix-anchored shape with no
// label in front. Every value is built here from a seeded generator out of obviously synthetic parts, so none is a
// working credential. Each format has near misses beside it: a placeholder, a body spelled out of words, and a body
// one character short, which all stay quiet.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { COUNTED, meter, assertCounted } = require("./work-child.js");
const work = meter(); // before the engine, so the meter counts its steps
const { bestOfPair, grewMoreThan } = require("./timing.js");

require("../extension/patterns.js");
require("../extension/detector.js");

const Clotr = globalThis.Clotr;

// { kind: [matches] }
function detect(text) {
  return Object.fromEntries(Clotr.detect(text).map((r) => [r.id, r.matches]));
}

let seed = 20261102;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOW = "abcdefghijklmnopqrstuvwxyz";
const DIG = "0123456789";
const HEX = "0123456789abcdef";
const ALNUM = UP + LOW + DIG;
const URLSAFE = `${ALNUM}-_`;
const BASE64 = `${ALNUM}+/`;
// A random string; the first and last characters come from the letters and digits of the set.
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
const b64 = (s) => Buffer.from(s).toString("base64");

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

// An Azure key in Microsoft's common annotated format: 52 random characters, the fixed "JQQJ9" signature, a version
// and a date, the provider's four-letter signature at a fixed place and four more.
const azureKey = (g, provider = "ACOG") =>
  `${g(ALNUM, 52)}JQQJ99${g(UP, 1)}${g("ABCDEFGHIJKL", 1)}${g(ALNUM, 16)}${provider}${g(ALNUM, 4)}`;
// An AWS Bedrock short-term key: "bedrock-api-key-" and a presigned request to Bedrock in base64.
const bedrockShortTerm = (g) =>
  `bedrock-api-key-${b64(
    "bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      `&X-Amz-Credential=ASIA${g(UP + DIG, 16)}%2F20261102%2Fus-east-1%2Fbedrock%2Faws4_request` +
      `&X-Amz-Date=20261102T101500Z&X-Amz-Expires=43200&X-Amz-Security-Token=${g(BASE64, 400)}` +
      `&X-Amz-Signature=${g(HEX, 64)}&X-Amz-SignedHeaders=host&Version=1`,
  )}`;

// [provider, make(gen) → token, placeholder written the way a doc or a template writes it, whether a body spelled out
// of words stays quiet (a short-term Bedrock key is base64 of a link, so words in the link don't show in it)]
const PROVIDERS = [
  ["Azure AI services key", (g) => azureKey(g), `${"x".repeat(52)}JQQJ99BAAAAAAAAAAAAAAAAAAACOGxxxx`],
  ["Azure Event Grid key", (g) => azureKey(g, "AZEG"), "your_event_grid_key_here_JQQJ99BAAZEG"],
  [
    "AWS Bedrock long-term key",
    (g) => `ABSKQmVkcm9ja0FQSUtleS${g(BASE64, 110)}`,
    "ABSKQmVkcm9ja0FQSUtleS-your-bedrock-api-key",
  ],
  ["AWS Bedrock short-term key", bedrockShortTerm, "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t...", false],
  ["Brevo SMTP key", (g) => `xsmtpsib-${g(HEX, 64)}-${g(ALNUM, 16)}`, "xsmtpsib-your_smtp_key_here"],
  ["SonarQube user token", (g) => `squ_${g(HEX, 40)}`, "squ_your_token_here"],
  ["SonarQube project token", (g) => `sqp_${g(HEX, 40)}`, "sqp_your_project_token"],
  ["SonarQube analysis token", (g) => `sqa_${g(HEX, 40)}`, "sqa_your_analysis_token"],
  ["CircleCI personal token", (g) => `CCIPAT_${g(ALNUM, 22)}_${g(HEX, 40)}`, "CCIPAT_your_personal_token"],
  ["CircleCI project token", (g) => `CCIPRJ_${g(ALNUM, 22)}_${g(HEX, 40)}`, "CCIPRJ_your_project_token"],
  ["Clojars deploy token", (g) => `CLOJARS_${g(LOW + DIG, 60)}`, "CLOJARS_your_deploy_token_here"],
  ["Plaid access token", (g) => `access-production-${uuid(g)}`, "access-production-your-access-token"],
  [
    "Bitwarden machine account token",
    (g) => `0.${uuid(g)}.${g(ALNUM, 30)}:${g(BASE64, 22)}==`,
    `0.${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.${"x".repeat(30)}:${"x".repeat(22)}==`,
  ],
  [
    "Standard Webhooks secret",
    (g) => `whsec_${g(ALNUM, 12)}+${g(BASE64, 18)}/${g(ALNUM, 12)}=`,
    "whsec_your/webhook+secret=",
  ],
  ["Resend key", (g) => `re_${g(ALNUM, 8)}_${g(ALNUM, 24)}`, "re_your_api_key_here"],
  ["Tavily key", (g) => `tvly-dev-${g(ALNUM, 32)}`, "tvly-YOUR_API_KEY"],
  ["Firecrawl key", (g) => `fc-${g(HEX, 32)}`, "fc-YOUR_API_KEY"],
  ["Deno Deploy token", (g) => `ddp_${g(ALNUM, 36)}`, "ddp_your_deploy_token_here"],
  ["PostHog personal key", (g) => `phx_${g(ALNUM, 43)}`, "phx_your_personal_api_key"],
  ["Together AI key", (g) => `tgp_v1_${g(URLSAFE, 43)}`, "tgp_v1_your_api_key_here"],
  ["Cerebras key", (g) => `csk-${g(LOW + DIG, 48)}`, "csk-your-api-key-here"],
  ["Tencent Cloud secret ID", (g) => `AKID${g(ALNUM, 32)}`, "AKIDyour_secret_id_here"],
  ["Yandex Cloud API key", (g) => `AQVN${g(URLSAFE, 36)}`, "AQVNyour_api_key_here"],
];

for (const [provider, make, placeholder, wordsQuiet = true] of PROVIDERS) {
  test(`${provider}: a service token bare, in a sentence and after a label, and Cover it hides all of it`, () => {
    const token = make(random);
    for (const [shape, text] of [
      ["bare", token],
      ["sentence", `Can you see why my script fails when I set it to ${token} before the request?`],
      ["label", `token: ${token}`],
      ["setting", `PROVIDER_KEY="${token}"`],
    ]) {
      const found = detect(text);
      assert.ok(found.service_token?.includes(token), `${provider} ${shape}: ${JSON.stringify(Object.keys(found))}`);
      assert.equal(found.password, undefined, `${provider} ${shape} was also read as a password`);
      assert.equal(leftover(token, text), "", `${provider} ${shape}: Cover it left part of the token`);
    }
  });

  test(`${provider}: quiet on a placeholder and on a body made of words`, () => {
    assert.deepEqual(credentialKinds(placeholder), [], `${provider} placeholder ${placeholder}`);
    if (!wordsQuiet) return;
    const words = make(wordy);
    assert.deepEqual(credentialKinds(words), [], `${provider} word body ${words}`);
  });

  test(`${provider}: a service token between Markdown's emphasis underscores is covered`, () => {
    const token = make(random);
    const text = `the key is _${token}_ now`;
    assert.ok(detect(text).service_token?.includes(token), `${provider}: the token was not found`);
    assert.equal(leftover(token, text), "", `${provider}: Cover it left part of the token`);
  });
}

test("each new format one character short, or with a character it never uses, stays quiet", () => {
  for (const text of [
    `${random(ALNUM, 51)}JQQJ99BA${random(ALNUM, 16)}ACOG${random(ALNUM, 4)}`,
    // The fixed signature carries a version digit, 9, D or H.
    `${random(ALNUM, 52)}JQQJ97BA${random(ALNUM, 16)}ACOG${random(ALNUM, 4)}`,
    `ABSKQmVkcm9ja0FQSUtleS${random(BASE64, 20)}`,
    `xsmtpsib-${random(HEX, 63)}-${random(ALNUM, 16)}`,
    `squ_${random(HEX, 39)}`,
    `sqx_${random(HEX, 40)}`,
    `CCIPAT_${random(ALNUM, 21)}_${random(HEX, 40)}`,
    `CLOJARS_${random(LOW + DIG, 59)}`,
    `access-staging-${uuid(random)}`,
    `access-sandbox-${uuid(random)}`,
    `0.${uuid(random)}.${random(ALNUM, 29)}:${random(BASE64, 22)}==`,
    `re_${random(ALNUM, 7)}_${random(ALNUM, 24)}`,
    `fc-${random(HEX, 31)}`,
    `ddp_${random(ALNUM, 35)}`,
    `tgp_v2_${random(URLSAFE, 43)}`,
    `AKID${random(ALNUM, 31)}`,
    `AQVN${random(URLSAFE, 20)}`,
  ]) {
    assert.deepEqual(credentialKinds(`see ${text} here`), [], text.slice(0, 12));
  }
});

test("everyday words and code that share a new format's prefix stay quiet", () => {
  for (const text of [
    "The usual dose is 2 tablets; ask the pharmacist about access-production-ready servers too.",
    "We play fc-barcelona fans on Saturday, then fc-porto.",
    "import re; re_compile_pattern_for_email = re.compile(r'[a-z]+')",
    "Use squ_ for user tokens and sqp_ for project tokens in SonarQube.",
    "Our Plaid sandbox uses access-sandbox-tokens for tests.",
    "set TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx in .env",
    "The CircleCI docs say personal tokens start with CCIPAT_ and project tokens with CCIPRJ_.",
    "Zapier hook example: https://hooks.zapier.com/hooks/catch/123456/abcdef/",
    "ACOG guidelines changed in 2026; JQQJ9 is just a string in this sentence.",
  ]) {
    assert.deepEqual(credentialKinds(text), [], text);
  }
});

test("an existing Stripe signing secret keeps its own kind", () => {
  const secret = `whsec_${random(ALNUM, 32)}`;
  const found = detect(`STRIPE_WEBHOOK_SECRET=${secret}`);
  assert.deepEqual(found.stripe_secret_key, [secret]);
  assert.equal(found.service_token, undefined);
  // A Standard Webhooks secret whose first "+" or "/" comes late is one secret of one kind, not a Stripe one inside it.
  const svix = `whsec_${random(ALNUM, 36)}+${random(ALNUM, 6)}=`;
  const svixFound = detect(`SVIX_WEBHOOK_SECRET=${svix}`);
  assert.deepEqual(svixFound.service_token, [svix]);
  assert.equal(svixFound.stripe_secret_key, undefined);
});

test("a Stripe signing secret followed by a path, a second secret or a long tail is still covered", () => {
  const W = "whsec" + "_";
  const a = `${W}${random(ALNUM, 32)}`;
  const b = `${W}${random(ALNUM, 32)}`;
  const long40 = `${W}${random(ALNUM, 40)}`;
  const long89 = `${W}${random(ALNUM, 89)}`;
  for (const [shape, text, secrets] of [
    ["a path after it", `Stripe ${a}/my-endpoint`, [a]],
    ["a second secret after a slash", `rotated ${a}/${b}`, [a, b]],
    ["a second secret after a plus", `${a}+${b}`, [a, b]],
    ["a long tail after a slash", `${a}/${random(ALNUM, 60)}`, [a]],
    ["a long run, then a slash and more", `${long40}/${random(ALNUM, 50)}`, [long40]],
    ["a run too long for Standard Webhooks, then =", `${long89}=`, [long89]],
  ]) {
    const found = detect(text).stripe_secret_key || [];
    for (const secret of secrets) {
      assert.ok(found.includes(secret), `${shape}: the Stripe secret was not found`);
      assert.equal(leftover(secret, text), "", `${shape}: Cover it left part of the secret`);
    }
  }
  // Where the Standard Webhooks shape fits but its tail is not random, the Stripe-shaped run at its start is still a
  // secret, under either kind.
  for (const tail of [`/${"a".repeat(48)}`, `/${"0".repeat(46)}`, "+" + "x".repeat(20) + "==", "/example"]) {
    const text = `secret ${a}${tail} here`;
    assert.ok(credentialKinds(text).length, `${tail.slice(0, 4)}: the secret was not found`);
    assert.equal(leftover(a, text), "", `${tail.slice(0, 4)}: Cover it left part of the secret`);
  }
});

test("a developer's camelCase name that starts with re_ is not a Resend key", () => {
  for (const text of [
    "const re_username_validCharactersAllowed2x = 1;",
    "var re_isoDates_YYYYMMDDThhmmssWithZone2 = 1",
    // Its words start with capitals, so as typed they read short of vowels.
    "re_patterns_matchingEmailAddressList = re.compile(r'x')",
  ]) {
    assert.deepEqual(credentialKinds(text), [], text);
  }
});

test("a Linear OAuth access token is a Linear key", () => {
  const token = `lin_oauth_${random(HEX, 64)}`;
  const text = `curl -H "Authorization: Bearer ${token}" https://api.linear.app/graphql`;
  assert.ok(detect(text).linear_key?.includes(token), "the token was not found");
  assert.equal(leftover(token, text), "", "Cover it left part of the token");
  assert.deepEqual(credentialKinds(`lin_oauth_${wordy(HEX, 64)}`), []);
  assert.deepEqual(credentialKinds(`lin_oauth_${random(HEX, 63)}`), []);
});

// ---------- Webhook links whose secret is in the link itself ----------

test("a Teams or Power Automate workflow link: its signature is covered, the rest of the link stays", () => {
  const sig = random(URLSAFE, 43);
  const flow = random(HEX, 32);
  const query = `?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${sig}`;
  for (const [shape, text] of [
    ["Logic Apps", `https://prod-27.westus.logic.azure.com:443/workflows/${flow}/triggers/manual/paths/invoke${query}`],
    [
      "Power Platform",
      `POST https://default${random(HEX, 30)}.0a.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/${flow}/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${sig}`,
    ],
    [
      "HTML",
      `<a href="https://prod-27.westus.logic.azure.com/workflows/${flow}/triggers/manual/paths/invoke?api-version=2016-06-01&amp;sv=1.0&amp;sig=${sig}">run</a>`,
    ],
    [
      "signature first",
      `https://prod-27.westus.logic.azure.com/workflows/${flow}/triggers/When_a_Teams_webhook_request_is_received/paths/invoke?sig=${sig}&sv=1.0`,
    ],
  ]) {
    assert.ok(detect(text).service_token?.includes(sig), `${shape}: the signature was not found`);
    assert.equal(leftover(sig, text), "", `${shape}: Cover it left the signature`);
  }
  // A sig= in some other link, a workflow link with no signature, or one too short stays quiet.
  for (const text of [
    `https://example.org/download?id=42&sig=${sig}`,
    `https://prod-27.westus.logic.azure.com/workflows/${flow}/triggers/manual/paths/invoke?api-version=2016-06-01`,
    `https://prod-27.westus.logic.azure.com/workflows/${flow}/triggers/manual/paths/invoke?sv=1.0&sig=${sig.slice(1)}`,
    `https://prod-27.westus.logic.azure.com/workflows/${flow}/triggers/manual/paths/invoke?sv=1.0&sig=${wordy(URLSAFE, 43)}`,
  ]) {
    assert.deepEqual(credentialKinds(text), [], text.slice(-60));
  }
});

test("an Office 365 connector webhook link is covered whole", () => {
  const url = `https://contoso.webhook.office.com/webhookb2/${uuid(random)}@${uuid(random)}/IncomingWebhook/${random(HEX, 32)}/${uuid(random)}`;
  const withV2 = `${url}/V2${random(URLSAFE, 44)}`;
  for (const [shape, text] of [
    ["bare", url],
    ["sentence", `the Teams channel hook ${url} returns 400 now`],
    ["V2", `TEAMS_WEBHOOK_URL=${withV2}`],
  ]) {
    assert.ok(detect(text).service_token?.length, `${shape}: the link was not found`);
    const out = Clotr.redact(text, Clotr.detect(text));
    assert.ok(!out.includes("IncomingWebhook/"), `${shape}: Cover it left the link's secret part`);
  }
  // The documentation's own shape, with placeholders in it, stays quiet.
  assert.deepEqual(
    credentialKinds("https://contoso.webhook.office.com/webhookb2/<group-id>@<tenant-id>/IncomingWebhook/<id>/<owner>"),
    [],
  );
});

test("a Zapier catch hook link is covered, a docs example stays quiet", () => {
  const url = `https://hooks.zapier.com/hooks/catch/${random(DIG, 7)}/${random(LOW + DIG, 6)}7/`;
  for (const text of [url, `zap trigger: ${url} (POST json)`]) {
    assert.ok(detect(text).service_token?.length, "the hook was not found");
    assert.equal(leftover(url.slice(-20), text), "", "Cover it left the hook");
  }
  for (const text of [
    "https://hooks.zapier.com/hooks/catch/123456/abcdef/",
    "https://hooks.zapier.com/hooks/catch/000000/xxxxxx/",
    "https://hooks.zapier.com/hooks/catch/",
  ]) {
    assert.deepEqual(credentialKinds(text), [], text);
  }
});

test("a Zapier hook link whose account is counted down is a docs example", () => {
  for (const text of [
    "https://hooks.zapier.com/hooks/catch/9876543/zapid/",
    "https://hooks.zapier.com/hooks/catch/654321/fedcba/",
  ]) {
    assert.deepEqual(credentialKinds(text), [], text);
  }
});

test("a Google Chat webhook's token is covered, not only its shared key", () => {
  const token = random(URLSAFE, 43);
  const url = `https://chat.googleapis.com/v1/spaces/AAAA${random(ALNUM, 7)}/messages?key=AIza${random(URLSAFE, 35)}&token=${token}%3D`;
  for (const [shape, text] of [
    ["bare", url],
    ["JSON", `{"webhook": "${url}"}`],
    ["token first", `https://chat.googleapis.com/v1/spaces/AAAA${random(ALNUM, 7)}/messages?token=${token}`],
  ]) {
    assert.ok(
      detect(text).service_token?.some((m) => m.includes(token)),
      `${shape}: the token was not found`,
    );
    assert.equal(leftover(token, text), "", `${shape}: Cover it left the token`);
  }
  assert.deepEqual(credentialKinds("https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN"), []);
});

test("an IFTTT webhooks key in a trigger link is covered", () => {
  const key = random(URLSAFE, 22);
  for (const text of [
    `https://maker.ifttt.com/trigger/door_open/with/key/${key}`,
    `curl -X POST https://maker.ifttt.com/trigger/door_open/json/with/key/${key}`,
    `https://maker.ifttt.com/use/${key}`,
  ]) {
    assert.ok(detect(text).service_token?.includes(key), `${text.slice(0, 40)}: the key was not found`);
    assert.equal(leftover(key, text), "", "Cover it left the key");
  }
  assert.deepEqual(credentialKinds("https://maker.ifttt.com/trigger/{event}/with/key/{your_key}"), []);
});

// ---------- Hostile text ----------

function assertLinear(fn, makeInput, units, n = 6000, runs = 3, limit = 12) {
  if (work) {
    work.assertWorkLinear(fn, makeInput, units, n, undefined, [__filename]);
    return;
  }
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
const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length));

test("the new formats' markers repeated over and over are scanned in linear time", () => {
  assertLinear(serviceTokens, fill, [
    "JQQJ9",
    `${random(ALNUM, 52)}JQQJ99BA`,
    "ABSKQmVkcm9ja0FQSUtleS",
    "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t",
    "xsmtpsib-",
    "squ_",
    "CCIPAT_",
    "CLOJARS_",
    "access-production-",
    `0.${uuid(random)}.`,
    "whsec_+",
    "re_",
    "tvly-",
    "fc-",
    "ddp_",
    "phx_",
    "tgp_v1_",
    "csk-",
    "AKID",
    "AQVN",
    `/workflows/${random(HEX, 32)}/triggers/manual/paths/invoke?sv=1.0&`,
    "/paths/invoke?&sig=",
    "chat.googleapis.com/v1/spaces/AAAA/messages?key=1&",
    "maker.ifttt.com/trigger/a/with/key/",
    "https://hooks.zapier.com/hooks/catch/1/",
    "https://x.webhook.office.com/webhookb2/",
  ]);
});

// The service-token rule is one regex, so its clock check stays for backtracking inside it, and the same units run
// counted too (CLOTR_WORK=1), which sees a pass or a loop too many that hides under the clock's limit.
test("the new formats' markers also make linear work, counted", { skip: COUNTED }, () => {
  assertCounted(__filename, ["the new formats' markers repeated over and over are scanned in linear time"]);
});

// One regex run on the whole text: only the clock sees how much it backtracks.
test("Stripe's signing-secret rule reads runs that end in base64 in linear time", () => {
  const stripe = Clotr.PATTERNS.find((p) => p.id === "stripe_secret_key").regex;
  const W = "whsec" + "_";
  assertLinear((text) => text.match(stripe), fill, [
    `${W}${random(ALNUM, 88)}+`,
    `${W}${random(ALNUM, 32)}/`,
    `${W}${random(ALNUM, 32)}/${random(BASE64, 56)}`,
    `${W}${random(ALNUM, 200)}=`,
    `${W}${W}+`,
  ]);
});

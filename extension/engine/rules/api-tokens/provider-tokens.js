// API tokens a provider marks with its own prefix, tokens that count only near their provider's name, links
// that are the secret, and Twilio's SID and token pair.
(() => {
  "use strict";

  const { isPlaceholder, entropy, looksRandom, looksRandomHex, looksRandomLetters } = globalThis.ClotrInternal;

  // ---------- Tokens a provider marks ----------

  // ── Provider tokens with their own prefix ──
  // Provider tokens told apart by a prefix or marker their provider puts in every one, in each provider's documented
  // length and characters. The rest of the token has to look machine-made, so a doc's "dckr_pat_your_token_here" or a
  // body spelled out of words stays quiet. A prefix that ordinary words or names could start, like "secret_" or "fw_",
  // asks for mixed case and a digit as well.
  // A body with no digit reads as words when its lowercase comes in runs of several letters with vowels in them, as
  // in "DockerHubPersonalToken". Random letters rarely do.
  // Runs of lowercase read as words when they're this long on average and about a third vowels.
  const runsReadAsWords = (runs, averageLength) => {
    const letters = runs.join("");
    return (
      letters.length > 0 &&
      letters.length >= averageLength * runs.length &&
      (letters.match(/[aeiou]/g) || []).length >= 0.3 * letters.length
    );
  };
  const readsAsWords = (body) => runsReadAsWords(body.match(/[a-z]+/g) || [], 2.5);
  // Split at its capitals, a camelCase name gives back whole words ("EmailAddress" is "email" and "address", where
  // readsAsWords sees "mail" and "ddress"). Random text split the same way falls into short pieces.
  const readsAsCamelCaseWords = (body) => {
    const words = body.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return runsReadAsWords(words.match(/[a-z]+/g) || [], 5);
  };
  // A short body drawn from letters, digits, "-" and "_" can have its runs broken up by chance, so one in mixed case
  // with a digit also passes on its letters and digits alone.
  const machineMade = (body) => {
    if (looksRandomHex(body)) return true;
    if (looksRandomLetters(body) && !readsAsWords(body)) return true;
    if (!/[-_]/.test(body) || !/[A-Z]/.test(body) || !/[a-z]/.test(body)) return false;
    return looksRandomHex(body.replace(/[-_]/g, ""));
  };
  const strictlyRandom = (body) => looksRandom(body, Math.min(20, body.length));
  // A prefix only one provider uses, at a fixed length, needs no digit: a random body can go without one by chance.
  // Mixed case and the spread of random characters are enough, unless it has no digit and reads as words.
  const randomMixedCase = (body) => {
    const plain = body.replace(/[^A-Za-z0-9]/g, "");
    if (!/[A-Z]/.test(plain) || !/[a-z]/.test(plain) || entropy(plain) < 3.5) return false;
    return /\d/.test(plain) || !readsAsWords(plain);
  };
  const ownPrefix = (body) => machineMade(body) || randomMixedCase(body);
  // A token can sit between Markdown's emphasis underscores, "_token_", but not inside a longer name like "my_token".
  const BEFORE = String.raw`(?<![A-Za-z0-9])(?<![A-Za-z0-9_]_)`;
  const AFTER = String.raw`(?![A-Za-z0-9-])(?!_[A-Za-z0-9_-])`;
  // [marker(s) found by indexOf, how far before the marker the token starts, source, check, and, rarely, the part of
  // a match that still counts when the whole does not]. The source matches at the token's start; its first group,
  // when it has one, is the part the check reads.
  const PREFIXED_TOKENS = [
    ["GOCSPX-", 0, String.raw`${BEFORE}GOCSPX-([A-Za-z0-9_-]{28})${AFTER}`, ownPrefix],
    ["ya29.", 0, String.raw`${BEFORE}ya29\.([A-Za-z0-9_-]{40,2048})${AFTER}`],
    // A Google refresh token.
    ["1//0", 0, String.raw`(?<![A-Za-z0-9/:])(?<![A-Za-z0-9_]_)1//0([A-Za-z0-9_-]{60,512})${AFTER}`, strictlyRandom],
    // A Microsoft Entra client secret: three characters, a digit, "Q~" and 31 to 34 more. A "." can be inside one
    // but not end it, so a sentence's full stop stays out.
    [
      "Q~",
      4,
      String.raw`(?<![A-Za-z0-9~.-])(?<![A-Za-z0-9_]_)[A-Za-z0-9_~.-]{3}\dQ~` +
        String.raw`([A-Za-z0-9_~.-]{30,33}[A-Za-z0-9_~-])(?![A-Za-z0-9~-])(?![_.][A-Za-z0-9_~-])`,
      ownPrefix,
    ],
    // An Azure DevOps token in its 84-character form carries "AZDO" at a fixed place.
    ["AZDO", 76, String.raw`(?<![A-Za-z0-9])[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}(?![A-Za-z0-9])`, strictlyRandom],
    // An Azure Container Registry password carries "+ACR" at a fixed place.
    ["+ACR", 42, String.raw`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42}\+ACR[A-Za-z0-9]{6}(?![A-Za-z0-9+/=])`, strictlyRandom],
    // A Microsoft Entra refresh token.
    [
      ["0.A", "1.A"],
      0,
      String.raw`(?<![A-Za-z0-9.-])(?<![A-Za-z0-9_]_)[01]\.A` +
        String.raw`([A-Za-z0-9_-]{50,4000}(?:\.\d)?\.Ag[A-Za-z0-9_-]{250,8000}(?:\.A[A-Za-z0-9_-]{200,8000})?)${AFTER}`,
    ],
    ["sbp_", 0, String.raw`${BEFORE}sbp_([a-z0-9]{40})${AFTER}`],
    ["lsv2_", 0, String.raw`${BEFORE}lsv2_(?:pt|sk)_([a-f0-9]{32}_[a-f0-9]{10})${AFTER}`],
    ["sk-lf-", 0, String.raw`${BEFORE}sk-lf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})${AFTER}`],
    ["pcsk_", 0, String.raw`${BEFORE}pcsk_([A-Za-z0-9]{5,6}_[A-Za-z0-9]{63})${AFTER}`],
    ["dckr_pat_", 0, String.raw`${BEFORE}dckr_pat_([A-Za-z0-9_-]{27})${AFTER}`, ownPrefix],
    ["dckr_oat_", 0, String.raw`${BEFORE}dckr_oat_([A-Za-z0-9_-]{32})${AFTER}`, ownPrefix],
    // A Notion token: 11 digits, then the random part.
    ["ntn_", 0, String.raw`${BEFORE}ntn_\d{11}([A-Za-z0-9]{35})${AFTER}`],
    ["secret_", 0, String.raw`${BEFORE}secret_([A-Za-z0-9]{43})${AFTER}`, strictlyRandom],
    // An Airtable token: "pat", 14 characters, a dot and 64 hex.
    ["pat", 0, String.raw`${BEFORE}pat([A-Za-z0-9]{14}\.[a-f0-9]{64})${AFTER}`],
    ["ATBB", 0, String.raw`${BEFORE}ATBB([A-Za-z0-9_=-]{28,64})(?![A-Za-z0-9_=-])`],
    ["BBDC-", 0, String.raw`${BEFORE}BBDC-([A-Za-z0-9+/_-]{44})(?![A-Za-z0-9+/=-])(?!_[A-Za-z0-9+/=_-])`],
    // A Terraform Cloud token: 14 characters, ".atlasv1." and the secret.
    [".atlasv1.", 14, String.raw`(?<![A-Za-z0-9])[A-Za-z0-9]{14}\.atlasv1\.([A-Za-z0-9_=-]{60,70})(?![A-Za-z0-9_=-])`],
    [
      "dp.",
      0,
      String.raw`(?<![A-Za-z0-9.])(?<![A-Za-z0-9_]_)dp\.` +
        String.raw`(?:ct|pt|st(?:\.[a-z0-9_-]{2,35})?|sa|scim|audit)\.([A-Za-z0-9]{40,44})${AFTER}`,
    ],
    // A Discord bot token for a newer bot, whose ID in base64 starts with "O". "O" is too common to look for one at a
    // time, so this one is a single scan.
    [
      null,
      0,
      String.raw`${BEFORE}O([A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38})` +
        String.raw`(?![A-Za-z0-9])(?!_[A-Za-z0-9_-])`,
    ],
    ["fw_", 0, String.raw`${BEFORE}fw_([A-Za-z0-9]{20,40})${AFTER}`, strictlyRandom],
    // A Square access token. An uppercase SHA-256 that happens to start "EAAA" is all hex, which a token's body never
    // is.
    [
      "EAAA",
      0,
      String.raw`${BEFORE}EAAA([A-Za-z0-9_+=-]{60})(?![A-Za-z0-9+=-])(?!_[A-Za-z0-9_+=-])`,
      (body) => machineMade(body) && !/^[0-9A-Fa-f]+$/.test(body),
    ],
    ["sq0c", 0, String.raw`${BEFORE}sq0c[a-z]{2}-([A-Za-z0-9_-]{40,50})${AFTER}`, ownPrefix],
    ["sq0atp-", 0, String.raw`${BEFORE}sq0atp-([A-Za-z0-9_-]{22})${AFTER}`, ownPrefix],
    [
      "access_token$",
      0,
      String.raw`${BEFORE}access_token\$(?:production|sandbox)\$([a-z0-9]{16}\$[a-f0-9]{32})(?![A-Za-z0-9])`,
    ],
    // A Facebook (Meta) access token.
    ["EAA", 0, String.raw`${BEFORE}EAA[A-Z]([A-Za-z0-9]{100,1000})${AFTER}`, strictlyRandom],
    // A Dropbox token.
    [
      "sl.",
      0,
      String.raw`(?<![A-Za-z0-9.])(?<![A-Za-z0-9_]_)sl\.(?:u\.)?([A-Za-z0-9_=-]{130,2000})(?![A-Za-z0-9_=-])`,
      strictlyRandom,
    ],
    // A Mapbox secret token: base64 of its owner, then a random part too short to be sure of a digit in it.
    [
      "sk.eyJ",
      0,
      String.raw`(?<![A-Za-z0-9.])(?<![A-Za-z0-9_]_)sk\.eyJ[A-Za-z0-9_-]{20,400}\.([A-Za-z0-9_-]{20,100})${AFTER}`,
      randomMixedCase,
    ],
    // A TestPyPI token, whose fixed start is base64 of the index's name. That start is made of characters its body
    // allows, so the guard in front is what keeps each copy of it in a long run from scanning the rest of the run.
    [
      "pypi-AgENdGVzdC5weXBpLm9yZw",
      0,
      String.raw`(?<![A-Za-z0-9-])(?<![A-Za-z0-9_]_)pypi-AgENdGVzdC5weXBpLm9yZw([A-Za-z0-9_-]{50,4096})${AFTER}`,
    ],
    ["CFPAT-", 0, String.raw`${BEFORE}CFPAT-([A-Za-z0-9_-]{43})${AFTER}`],
    ["NRAK-", 0, String.raw`${BEFORE}NRAK-([A-Z0-9]{27})${AFTER}`],
    ["napi_", 0, String.raw`${BEFORE}napi_([a-z0-9]{64})${AFTER}`],
    ["pscale_", 0, String.raw`${BEFORE}pscale_(?:tkn|pw|oauth)_([A-Za-z0-9_=-]{32,64})(?![A-Za-z0-9_=-])`],
    ["figd_", 0, String.raw`${BEFORE}figd_([A-Za-z0-9_-]{40})${AFTER}`],
    ["bkua_", 0, String.raw`${BEFORE}bkua_([a-z0-9]{40})${AFTER}`],
    ["tfp_", 0, String.raw`${BEFORE}tfp_([A-Za-z0-9_-]{40,59})${AFTER}`],
    ["pnu_", 0, String.raw`${BEFORE}pnu_([A-Za-z0-9]{36})${AFTER}`],
    ["rdme_", 0, String.raw`${BEFORE}rdme_([a-z0-9]{70})${AFTER}`],
    ["dt0c01.", 0, String.raw`${BEFORE}dt0c01\.([A-Z0-9]{24}\.[A-Z0-9]{64})(?![A-Za-z0-9])`],
    ["EZ", 0, String.raw`${BEFORE}EZ[AT]K([A-Za-z0-9]{54})${AFTER}`],
    ["fio-u-", 0, String.raw`${BEFORE}fio-u-([A-Za-z0-9_=-]{64})(?![A-Za-z0-9=-])(?!_[A-Za-z0-9_=-])`],
    ["ico-", 0, String.raw`${BEFORE}ico-([A-Za-z0-9]{32})${AFTER}`, strictlyRandom],
    ["xkeysib-", 0, String.raw`${BEFORE}xkeysib-([a-f0-9]{64}-[A-Za-z0-9]{16})${AFTER}`],
    ["shippo_", 0, String.raw`${BEFORE}shippo_(?:live|test)_([a-f0-9]{40})${AFTER}`],
    ["duffel_", 0, String.raw`${BEFORE}duffel_(?:live|test)_([A-Za-z0-9_-]{43})${AFTER}`],
    // JFrog Artifactory: an API key, and a reference token, whose "cmVmd" is base64 of "ref".
    ["AKCp", 0, String.raw`${BEFORE}AKCp([A-Za-z0-9]{69})${AFTER}`],
    [
      "cmVmd",
      0,
      String.raw`(?<![A-Za-z0-9+/])(?<![A-Za-z0-9_]_)cmVmd([A-Za-z0-9]{59})(?![A-Za-z0-9+/=-])(?!_[A-Za-z0-9_+/=-])`,
      strictlyRandom,
    ],
    // An Alibaba Cloud access key ID.
    [
      "LTAI",
      0,
      String.raw`${BEFORE}LTAI([A-Za-z0-9]{20})${AFTER}`,
      (body) => strictlyRandom(body) || randomMixedCase(body),
    ],
    // A ClickHouse Cloud key secret.
    ["4b1d", 0, String.raw`${BEFORE}4b1d([A-Za-z0-9]{38})${AFTER}`, strictlyRandom],
    // An Adobe client secret.
    ["p8e-", 0, String.raw`${BEFORE}p8e-([A-Za-z0-9]{32})${AFTER}`],
    // An OpenShift user token.
    ["sha256~", 0, String.raw`${BEFORE}sha256~([A-Za-z0-9_-]{43})${AFTER}`],
    ["tk-us-", 0, String.raw`${BEFORE}tk-us-([A-Za-z0-9_-]{48})${AFTER}`],
    // A Harness token: "pat." or "sat.", the account, the token's ID and its secret.
    [
      ["pat.", "sat."],
      0,
      String.raw`${BEFORE}[ps]at\.([A-Za-z0-9_-]{22}\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{20})(?![A-Za-z0-9])`,
    ],
    ["sgp_", 0, String.raw`${BEFORE}sgp_((?:[a-f0-9]{16}|local)_[a-f0-9]{40}|[a-f0-9]{40})${AFTER}`],
    // An Octopus Deploy key.
    ["API-", 0, String.raw`${BEFORE}API-([A-Z0-9]{26})${AFTER}`],
    ["FLWSECK", 0, String.raw`${BEFORE}FLWSECK(?:_TEST)?-([a-h0-9]{32})-X${AFTER}`],
    // A MaxMind licence key ends in "_mmk".
    ["_mmk", 36, String.raw`${BEFORE}([A-Za-z0-9]{6}_[A-Za-z0-9]{29})_mmk${AFTER}`],
    // A 42 network (intra.42.fr) client secret.
    ["s-s4t2", 0, String.raw`${BEFORE}s-s4t2(?:ud|af)-([a-f0-9]{64})${AFTER}`],
    ["ramp_sec_", 0, String.raw`${BEFORE}ramp_sec_([A-Za-z0-9]{48})${AFTER}`],
    ["sm_", 0, String.raw`${BEFORE}sm_(?:aat|pat|sat)_([A-Za-z0-9]{16})${AFTER}`, ownPrefix],
    ["nvapi-", 0, String.raw`${BEFORE}nvapi-([A-Za-z0-9_-]{64})${AFTER}`],
    // An ElevenLabs key.
    ["sk_", 0, String.raw`${BEFORE}sk_([a-f0-9]{48})${AFTER}`],
    // An Azure key in Microsoft's common annotated format (Azure AI services, Event Grid, API Management and more):
    // 52 random characters, then "JQQJ9", a version, a date and the service's own four letters at a fixed place.
    [
      "JQQJ9",
      52,
      String.raw`(?<![A-Za-z0-9+/])([A-Za-z0-9]{52})JQQJ9` +
        String.raw`[9DH][A-Za-z0-9][A-L][A-Za-z0-9]{16}[A-Za-z][A-Za-z0-9]{7}(?:[A-Za-z0-9]{2}==)?(?![A-Za-z0-9+/=])`,
      strictlyRandom,
    ],
    // An AWS Bedrock API key. The long-term one is "ABSK" and base64 of "BedrockAPIKey-…"; the short-term one is a
    // presigned request to bedrock.amazonaws.com in base64.
    [
      "ABSKQmVkcm9ja0FQSUtleS",
      0,
      String.raw`(?<![A-Za-z0-9+/])ABSKQmVkcm9ja0FQSUtleS([A-Za-z0-9+/]{60,400})={0,2}(?![A-Za-z0-9+/=])`,
      ownPrefix,
    ],
    [
      "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t",
      0,
      String.raw`(?<![A-Za-z0-9-])(?<![A-Za-z0-9_]_)bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t` +
        String.raw`[A-Za-z0-9+/]{40,8000}={0,2}(?![A-Za-z0-9+/=])`,
      () => true,
    ],
    // A Brevo SMTP key, in the same shape as its API key.
    ["xsmtpsib-", 0, String.raw`${BEFORE}xsmtpsib-([a-f0-9]{64}-[A-Za-z0-9]{16})${AFTER}`],
    // A SonarQube user, project or global analysis token.
    [["squ_", "sqp_", "sqa_"], 0, String.raw`${BEFORE}sq[upa]_([a-f0-9]{40})${AFTER}`],
    // A CircleCI personal or project token.
    [["CCIPAT_", "CCIPRJ_"], 0, String.raw`${BEFORE}CCIP(?:AT|RJ)_([A-Za-z0-9]{22}_[a-f0-9]{40})${AFTER}`, ownPrefix],
    ["CLOJARS_", 0, String.raw`${BEFORE}CLOJARS_([a-z0-9]{60})${AFTER}`],
    // A Plaid access token for a live item. A sandbox one only reaches test data.
    [
      ["access-production-", "access-development-"],
      0,
      String.raw`${BEFORE}access-(?:production|development)-` +
        String.raw`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})${AFTER}`,
      (body) => looksRandomHex(body.replace(/-/g, "")),
    ],
    // A Bitwarden Secrets Manager access token: "0.", its ID, the client secret, ":" and the encryption key.
    [
      null,
      0,
      String.raw`(?<![A-Za-z0-9.])0\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.` +
        String.raw`([A-Za-z0-9]{30}):[A-Za-z0-9+/]{22,44}={0,2}(?![A-Za-z0-9+/=])`,
      ownPrefix,
    ],
    // A Standard Webhooks (Svix, Clerk and others) signing secret is base64 after "whsec_". One with no "+", "/" or
    // "=" in it is Stripe's shape, which its own rule names. The Stripe rule steps aside whenever this shape fits, so
    // when the whole does not count (a placeholder or a tail spelled out of words after it), a Stripe-shaped run at
    // its start still does, as the Stripe rule would have read it.
    [
      "whsec_",
      0,
      String.raw`${BEFORE}whsec_([A-Za-z0-9+/]{32,88}={0,2})(?![A-Za-z0-9+/=-])(?!_[A-Za-z0-9_+/=-])`,
      (body) => /[+/=]/.test(body) && machineMade(body.replace(/[+/=]/g, "")),
      (whole) => /^whsec_[A-Za-z0-9]{32,88}(?=[+/=])/.exec(whole),
    ],
    // A Resend key: 8 characters, "_" and 24 more. A developer's name for a regular expression has the same shape,
    // "re_username_validCharactersAllowed2x": its first part opens with a lowercase word and the rest reads as words,
    // as typed or split at its capitals.
    [
      "re_",
      0,
      String.raw`${BEFORE}re_([A-Za-z0-9]{8}_[A-Za-z0-9]{24})${AFTER}`,
      (body) =>
        ownPrefix(body) && !(/^[A-Za-z]*[a-z]{3}/.test(body) && (readsAsWords(body) || readsAsCamelCaseWords(body))),
    ],
    ["tvly-", 0, String.raw`${BEFORE}tvly-(?:dev-|prod-)?([A-Za-z0-9]{30,40})${AFTER}`, ownPrefix],
    // A Firecrawl key.
    ["fc-", 0, String.raw`${BEFORE}fc-([a-f0-9]{32})${AFTER}`],
    // A Deno Deploy token.
    ["ddp_", 0, String.raw`${BEFORE}ddp_([A-Za-z0-9]{36})${AFTER}`, ownPrefix],
    // A PostHog personal API key (its "phc_" project key is public).
    ["phx_", 0, String.raw`${BEFORE}phx_([A-Za-z0-9]{40,50})${AFTER}`, ownPrefix],
    // A Together AI key. Its last character is never Markdown's closing "_".
    ["tgp_v1_", 0, String.raw`${BEFORE}tgp_v1_([A-Za-z0-9_-]{39,49}[A-Za-z0-9-])${AFTER}`, ownPrefix],
    // A Cerebras key.
    ["csk-", 0, String.raw`${BEFORE}csk-([a-z0-9]{40,64})${AFTER}`],
    // A Tencent Cloud secret ID.
    [
      "AKID",
      0,
      String.raw`${BEFORE}AKID([A-Za-z0-9]{32})${AFTER}`,
      (body) => strictlyRandom(body) || randomMixedCase(body),
    ],
    // A Yandex Cloud API key.
    ["AQVN", 0, String.raw`${BEFORE}AQVN([A-Za-z0-9_-]{34,37}[A-Za-z0-9-])${AFTER}`, ownPrefix],
  ].map(([markers, back, source, check = machineMade, partThatCounts]) => ({
    markers: markers && [].concat(markers),
    back,
    re: new RegExp(source, markers ? "y" : "g"),
    check,
    partThatCounts,
  }));
  // ── Tokens that only count near their provider's name ──
  // A Mailgun key in its newer form: 32 hex, then two groups of 8. Cache keys and IDs come in the same shape, so it
  // only reads as one near the word Mailgun.
  const MAILGUN_KEY_RE = /(?<![A-Za-z0-9_-])([0-9a-f]{32})-[0-9a-f]{8}-[0-9a-f]{8}(?![A-Za-z0-9_-])/g;
  const MAILGUN_WORD = /mailgun/i;
  // An Okta API token is "00" and 40 more, which only reads as one after its "SSWS" scheme or near the word Okta.
  const OKTA_TOKEN_RE =
    /(?<![A-Za-z0-9=-])(?<![A-Za-z0-9_]_)00([A-Za-z0-9_=-]{40})(?![A-Za-z0-9=-])(?!_[A-Za-z0-9_=-])/g;
  const OKTA_WORD = /okta/i;
  const SSWS_BEFORE = /\bSSWS\s{1,4}$/;
  // An Azure DevOps token in its older form is 52 lowercase letters and digits, which only reads as one near Azure.
  const OLD_AZURE_DEVOPS_RE = /(?<![A-Za-z0-9])[a-z0-9]{52}(?![A-Za-z0-9])/g;
  const AZURE_WORD = /azure|devops|visualstudio/i;
  // An Azure shared access signature: a link's sig= is the HMAC that lets anyone holding the link in, and an sv=
  // storage version in the same query says it is Azure's. Its value is 32 bytes in base64, percent-encoded or not.
  // HTML writes the query's "&" as "&amp;", and Go's JSON (terraform.tfstate) as "\u0026".
  const SAS_SIG_RE = /(?:[?&]|&amp;|\\u0026)sig=([A-Za-z0-9%+/=]{40,140})/g;
  const SAS_VERSION = /(?:^|[?&;=]|\\u0026)sv=\d{4}-\d\d-\d\d(?!\d)/;
  const SAS_QUERY_END = /[\s"'<>;]/;
  const queryEndsAt = (text, i) => SAS_QUERY_END.test(text[i]) && !(text[i] === ";" && text.endsWith("&amp", i));

  // ---------- Links that are the secret ----------

  // ── Links that are the secret ──
  // A link whose own path or query is the secret: anyone holding it can post to the channel or start the flow.
  // A query's "&" may be written "&amp;" (HTML) or "&" (Go's JSON).
  // A docs example counts its IDs up ("123456/abcdef") or down ("9876543").
  const RUN_OF_CHARACTERS = "0123456789abcdefghijklmnopqrstuvwxyz";
  const RUN_DOWN = "zyxwvutsrqponmlkjihgfedcba9876543210";
  const zapierHook = (hook) =>
    hook
      .split("/")
      .every(
        (part) =>
          !RUN_OF_CHARACTERS.includes(part.toLowerCase()) &&
          !RUN_DOWN.includes(part.toLowerCase()) &&
          !isPlaceholder(part),
      );
  // [text that must be in it, regex, whether the whole match or only its group is the secret, check of the group]
  const SECRET_LINKS = [
    // A Teams workflow or any Power Automate or Logic Apps HTTP trigger: its sig= signs the request.
    [
      "/paths/invoke",
      new RegExp(
        String.raw`\/workflows\/[0-9a-f]{32}\/triggers\/[A-Za-z0-9_.%-]{1,128}\/paths\/invoke\?` +
          String.raw`(?:[^\s"'<>]{0,400}?(?:&amp;|\\u0026|&))?sig=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])`,
        "g",
      ),
      false,
      machineMade,
    ],
    // A Google Chat webhook: its key= is the same for every webhook, its token= is the secret.
    [
      "chat.googleapis.com/v1/spaces/",
      new RegExp(
        String.raw`chat\.googleapis\.com\/v1\/spaces\/[A-Za-z0-9_-]{5,40}\/messages\?` +
          String.raw`(?:[^\s"'<>]{0,300}?(?:&amp;|\\u0026|&))?token=([A-Za-z0-9_-]{40,50}(?![A-Za-z0-9_-])(?:%3D|=)?)`,
        "g",
      ),
      false,
      (token) => machineMade(token.replace(/(?:%3D|=)$/, "")),
    ],
    // An IFTTT webhooks key.
    [
      "maker.ifttt.com/",
      new RegExp(
        String.raw`maker\.ifttt\.com\/(?:trigger\/[^\s/"'<>]{1,100}\/(?:json\/)?with\/key|use)\/` +
          String.raw`([A-Za-z0-9_-]{20,64})(?![A-Za-z0-9_-])`,
        "g",
      ),
      false,
      machineMade,
    ],
    // A Zapier catch hook: the account's number and the hook's own short ID.
    [
      "hooks.zapier.com/hooks/catch/",
      /\bhooks\.zapier\.com\/hooks\/catch\/(\d{3,12}\/[A-Za-z0-9]{5,12})(?![A-Za-z0-9_-])\/?/g,
      true,
      zapierHook,
    ],
  ];

  // ---------- Finding the tokens ----------

  // ── Finding them ──
  function findPrefixedTokens(text) {
    const found = [];
    for (const { markers, back, re, check, partThatCounts } of PREFIXED_TOKENS) {
      if (!markers) {
        for (const m of text.matchAll(re)) if (!isPlaceholder(m[0]) && check(m[1] ?? m[0])) found.push(m[0]);
        continue;
      }
      for (const marker of markers) {
        for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
          if (at < back) continue;
          re.lastIndex = at - back;
          const m = re.exec(text);
          if (!m) continue;
          if (!isPlaceholder(m[0]) && check(m[1] ?? m[0])) {
            found.push(m[0]);
          } else if (partThatCounts) {
            const part = partThatCounts(m[0]);
            if (part && !isPlaceholder(part[0])) found.push(part[0]);
          }
        }
      }
    }
    if (MAILGUN_WORD.test(text)) {
      for (const m of text.matchAll(MAILGUN_KEY_RE)) {
        const near = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 100);
        if (MAILGUN_WORD.test(near) && looksRandomHex(m[1])) found.push(m[0]);
      }
    }
    if (text.includes("SSWS") || OKTA_WORD.test(text)) {
      for (const m of text.matchAll(OKTA_TOKEN_RE)) {
        const before = text.slice(Math.max(0, m.index - 200), m.index);
        const near = SSWS_BEFORE.test(before) || OKTA_WORD.test(before + text.slice(m.index, m.index + 142));
        if (near && !isPlaceholder(m[0]) && machineMade(m[1])) found.push(m[0]);
      }
    }
    if (AZURE_WORD.test(text)) {
      for (const m of text.matchAll(OLD_AZURE_DEVOPS_RE)) {
        const near = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 100);
        if (AZURE_WORD.test(near) && !isPlaceholder(m[0]) && looksRandomHex(m[0])) found.push(m[0]);
      }
    }
    for (const [gate, re, whole, check] of SECRET_LINKS) {
      if (!text.includes(gate)) continue;
      for (const m of text.matchAll(re)) if (!isPlaceholder(m[1]) && check(m[1])) found.push(whole ? m[0] : m[1]);
    }
    if (text.includes("sig=")) {
      for (const signature of sasSignatures(text)) found.push(signature);
    }
    return found;
  }

  // Each Azure shared access signature in the text. One query read for every sig= in it, so a query of many of them
  // is not walked again for each.
  function sasSignatures(text) {
    const found = [];
    let query = "";
    let queryEnd = -1;
    for (const m of text.matchAll(SAS_SIG_RE)) {
      if (m.index >= queryEnd) {
        let start = m.index;
        const floor = Math.max(0, m.index - 2000);
        while (start > floor && !queryEndsAt(text, start - 1)) start--;
        queryEnd = m.index + m[0].length;
        const ceiling = Math.min(text.length, queryEnd + 2000);
        while (queryEnd < ceiling && !queryEndsAt(text, queryEnd)) queryEnd++;
        query = text.slice(start, queryEnd);
      }
      const sig = m[1].replace(/%2B/gi, "+").replace(/%2F/gi, "/").replace(/%3D/gi, "=");
      if (SAS_VERSION.test(query) && /^[A-Za-z0-9+/]{43}=$/.test(sig) && !isPlaceholder(sig)) found.push(m[1]);
    }
    return found;
  }

  // ── Twilio's SID and token ──
  const TWILIO_SID_SET = String.raw`\b(?:TWILIO_ACCOUNT_SID|accountSid)\s*[:=]\s*["']?(AC[0-9a-fA-F]{32})["']?`;
  const TWILIO_TOKEN_SET = String.raw`(?:TWILIO_AUTH_TOKEN|authToken)\s*[:=]\s*["']?([A-Za-z0-9_-]{16,256})`;
  const TWILIO_CREDENTIALS_RE = new RegExp(
    String.raw`${TWILIO_SID_SET}(?=[\s,;]*[,\n ;])[\s,;]+${TWILIO_TOKEN_SET}`,
    "gi",
  );
  const TWILIO_LABEL = /^(?:TWILIO_ACCOUNT_SID|accountSid|TWILIO_AUTH_TOKEN|authToken)\s*[:=]/i;
  // A credential wrapped onto a new line is read again with the break taken out. A line that starts one of its
  // labels is a setting of its own, not a wrap, and what the lines as written already hold wins, so the word on
  // the line after a credential stays out of it.
  function findTwilioCredentials(text) {
    return twilioSpans(text).map(([start, end]) => text.slice(start, end));
  }
  // Whether text[start, end) lies inside one of the text's SID and token pairs, which twilio_credentials reports
  // whole. Only that copy is left out of the label finders: the same token written again under a label of its own
  // is theirs, or Cover it would hide the pair and leave that copy. A binary search over the pairs in order, each
  // with the furthest end reached so far, answers it without reading the text again.
  function twilioLookup(text) {
    const spans = twilioSpans(text).sort((a, b) => a[0] - b[0]);
    let furthest = -1;
    const reach = spans.map(([, end]) => (furthest = Math.max(furthest, end)));
    return (start, end) => {
      let lo = 0;
      let hi = spans.length - 1;
      let last = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid][0] <= start) {
          last = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return last >= 0 && reach[last] >= end;
    };
  }
  function twilioSpans(text) {
    const spans = [...text.matchAll(TWILIO_CREDENTIALS_RE)]
      .filter((m) => looksRandomHex(m[2]))
      .map((m) => [m.index, m.index + m[0].length]);
    // Only a break between two word characters is taken out. Each cut keeps where it falls in the joined text and
    // how much has been taken out up to there, so a match maps back to the text as written. Text with no such
    // break is never copied.
    const pieces = [];
    const cuts = [];
    let from = 0;
    let removed = 0;
    for (const m of text.matchAll(/\r\n|\r|\n/g)) {
      const next = m.index + m[0].length;
      const insideWord = /[A-Za-z0-9_]/.test(text[m.index - 1] || "") && /[A-Za-z0-9_]/.test(text[next] || "");
      if (insideWord && !TWILIO_LABEL.test(text.slice(next, next + 40))) {
        pieces.push(text.slice(from, m.index));
        cuts.push([m.index - removed, removed + m[0].length]);
        removed += m[0].length;
        from = next;
      }
    }
    if (!cuts.length) return spans;
    pieces.push(text.slice(from));
    const sourceAt = (j) => {
      let shift = 0;
      for (const [at, total] of cuts) {
        if (at > j) break;
        shift = total;
      }
      return j + shift;
    };
    const asWritten = spans.length;
    for (const m of pieces.join("").matchAll(TWILIO_CREDENTIALS_RE)) {
      if (!looksRandomHex(m[2])) continue;
      const start = sourceAt(m.index);
      const end = sourceAt(m.index + m[0].length - 1) + 1;
      if (!spans.slice(0, asWritten).some(([a, b]) => a < end && start < b)) spans.push([start, end]);
    }
    return spans;
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findPrefixedTokens, findTwilioCredentials, twilioLookup };
})();

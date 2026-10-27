"use strict";

const crypto = require("crypto");

const SECRET_KINDS = [
  "aws_access_key",
  "github_token",
  "stripe_secret_key",
  "anthropic_key",
  "openai_key",
  "xai_key",
  "google_api_key",
  "slack_token",
  "sentry_token",
  "grafana_token",
  "vault_token",
  "replicate_token",
  "linear_key",
  "postman_key",
  "shopify_token",
  "atlassian_token",
  "netlify_token",
  "pulumi_token",
  "databricks_token",
  "gitlab_token",
  "perplexity_key",
  "digitalocean_token",
  "huggingface_token",
  "heroku_token",
  "onepassword_token",
  "cloudflare_origin_ca_key",
  "twilio_credentials",
  "service_token",
  "stripe_publishable_key",
  "jwt",
];

const EXTRA_KINDS = ["private_key", "crypto_secret", "connection_string"];

const BIP39 = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
  "adapt",
  "add",
  "addict",
  "address",
  "adjust",
  "admit",
  "adult",
  "advance",
];

function makeGen(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const chars = (set, count) => Array.from({ length: count }, () => set[Math.floor(random() * set.length)]).join("");
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const digits = (count) => chars("0123456789", count);
  const b64u = (count) => chars(`${ALNUM}-_`, count);
  const seedPhrase = (count = 12) => {
    const checksumBits = count / 3;
    const entropyBits = count * 11 - checksumBits;
    const indices = Array.from({ length: count - 1 }, () => int(0, 31));
    const bits = indices
      .map((index) => index.toString(2).padStart(11, "0"))
      .join("")
      .padEnd(entropyBits, "0");
    const entropy = Buffer.alloc(entropyBits / 8);
    for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    const checksum = [...crypto.createHash("sha256").update(entropy).digest()]
      .map((byte) => byte.toString(2).padStart(8, "0"))
      .join("")
      .slice(0, checksumBits);
    indices.push(parseInt(checksum, 2));
    return indices.map((index) => BIP39[index]);
  };
  return { int, chars, digits, b64u, seedPhrase, ALNUM };
}

function secretValue(g, kind, variant = "") {
  const hex = "0123456789abcdef";
  switch (kind) {
    case "aws_access_key":
      return `AKIA${g.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}`;
    case "github_token":
      if (variant === "stateless") {
        return `ghs_${g.digits(10)}_eyJhbGciOiJSUzI1NiJ9.${g.b64u(150)}.${g.b64u(332)}`;
      }
      return `ghp_${g.chars(g.ALNUM, 36)}`;
    case "stripe_secret_key":
      return `sk_live_${g.chars(g.ALNUM, 24)}`;
    case "anthropic_key":
      return `sk-ant-api03-${g.b64u(86)}AA`;
    case "openai_key":
      return `sk-proj-${g.chars(g.ALNUM, 48)}`;
    case "xai_key":
      return `xai-${g.chars(g.ALNUM, 40)}`;
    case "google_api_key":
      return `AIza${g.b64u(35)}`;
    case "slack_token":
      if (variant === "app" || variant === "rotating_app") {
        const app = `xapp-1-A${g.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 10)}-${g.digits(13)}-${g.chars("abcdefghijklmnopqrstuvwxyz0123456789", 32)}`;
        return variant === "rotating_app" ? `xoxe.${app}` : app;
      }
      if (variant === "config_access") return `xoxe.xoxp-1-${g.chars(g.ALNUM, 164)}`;
      if (variant === "refresh") return `xoxe-1-${g.chars(g.ALNUM, 146)}`;
      if (variant === "webhook") {
        return `https://hooks.slack.com/services/T${g.chars(g.ALNUM, 9)}/B${g.chars(g.ALNUM, 10)}/${g.chars(g.ALNUM, 48)}`;
      }
      return `xoxb-${g.digits(12)}-${g.digits(13)}-${g.chars(g.ALNUM, 24)}`;
    case "sentry_token":
      return `sntryu_${g.chars(hex, 64)}`;
    case "grafana_token":
      return `glsa_${g.chars(g.ALNUM, 32)}_${g.chars(hex, 8)}`;
    case "vault_token":
      return `hvs.${g.chars(g.ALNUM, 91)}`;
    case "replicate_token":
      return `r8_${g.chars(g.ALNUM, 37)}`;
    case "linear_key":
      return `lin_api_${g.chars(g.ALNUM, 40)}`;
    case "postman_key":
      return `PMAK-${g.chars(hex, 24)}-${g.chars(hex, 34)}`;
    case "shopify_token":
      return `shpat_${g.chars(hex, 32)}`;
    case "atlassian_token":
      return `ATATT3xFfG${g.chars(`${g.ALNUM}_-`, 173)}=${g.chars(g.ALNUM, 8)}`;
    case "netlify_token":
      return `nfp_${g.chars(g.ALNUM, 36)}`;
    case "pulumi_token":
      return `pul-${g.chars(hex, 40)}`;
    case "databricks_token":
      return `dapi${g.chars(hex, 32)}`;
    case "gitlab_token": {
      const longLivedVariant = "a" + "gent";
      if (variant === "routable") {
        return `glpat-${g.chars(g.ALNUM, 27)}.${g.chars("abcdefghijklmnopqrstuvwxyz0123456789", 9)}`;
      }
      const prefixes = {
        deploy: "gldt-",
        ci: "glcbt-12_",
        runner: "glrt-",
        feed: "glft-",
        scim: "glsoat-",
        [longLivedVariant]: "gl" + "a" + "gent-",
        oauth: "gloas-",
      };
      const length = variant === longLivedVariant ? 50 : variant === "oauth" ? 64 : 20;
      return `${prefixes[variant] || "glpat-"}${g.chars(g.ALNUM, length)}`;
    }
    case "perplexity_key":
      return `pplx-${g.chars(g.ALNUM, 48)}`;
    case "digitalocean_token":
      return `d${variant === "oauth" ? "oo" : variant === "refresh" ? "or" : "op"}_v1_${g.chars(hex, 64)}`;
    case "huggingface_token":
      return `${variant === "organization" ? "api_org_" : "hf_"}${g.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 34)}`;
    case "heroku_token":
      return `HRKU-${g.chars(`${g.ALNUM}_-`, 60)}`;
    case "onepassword_token":
      if (variant === "secret_key") {
        const group = (length) => g.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", length);
        return `A3-${group(6)}-${group(6)}-${group(5)}-${group(5)}-${group(5)}-${group(5)}`;
      }
      return `ops_eyJ${g.chars(`${g.ALNUM}+/`, 260)}`;
    case "cloudflare_origin_ca_key":
      return `v1.0-${g.chars(hex, 24)}-${g.chars(hex, 146)}`;
    case "twilio_credentials":
      return `TWILIO_ACCOUNT_SID=AC${g.chars(hex, 32)} TWILIO_AUTH_TOKEN=${g.chars(g.ALNUM, 32)}`;
    case "service_token":
      if (variant === "telegram") return `${g.digits(9)}:AA${g.chars(`${g.ALNUM}_-`, 32)}-`;
      if (variant === "sendgrid") return `SG.${g.chars(`${g.ALNUM}_-`, 22)}.${g.chars(`${g.ALNUM}_-`, 42)}-`;
      if (variant === "groq") return `gsk_${g.chars(g.ALNUM, 52)}`;
      if (variant === "openrouter") return `sk-or-v1-${g.chars(hex, 64)}`;
      if (variant === "supabase") return `sb_secret_${g.b64u(22)}_${g.b64u(8)}`;
      if (variant === "openvsx") return `ovsxat_${g.chars(g.ALNUM, 43)}`;
      if (variant === "openvsxLegacy") {
        return `ovsxat_${g.chars(hex, 8)}-${g.chars(hex, 4)}-${g.chars(hex, 4)}-${g.chars(hex, 4)}-${g.chars(hex, 12)}`;
      }
      if (variant === "rubygems") return `rubygems_${g.chars(hex, 48)}`;
      if (variant === "jetbrains") return `perm:${g.chars(`${g.ALNUM}+/`, 20)}.${g.chars(`${g.ALNUM}+/`, 32)}==`;
      return `npm_${g.chars(g.ALNUM, 36)}`;
    case "stripe_publishable_key":
      return `pk_live_${g.chars(g.ALNUM, 24)}`;
    case "jwt":
      return `eyJhbGciOiJIUzI1NiJ9.eyJ${g.b64u(40)}.${g.b64u(43)}`;
    case "private_key":
      return `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${g.chars(`${g.ALNUM}+/`, 58)}\n${g.chars(`${g.ALNUM}+/`, 64)}\n-----END RSA PRIVATE KEY-----`;
    case "crypto_secret":
      if (variant === "hex") return `0x${g.chars(hex, 64)}`;
      return g.seedPhrase(12).join(" ");
    case "connection_string": {
      const password = variant === "slash" ? `${g.chars(g.ALNUM, 7)}/${g.chars(g.ALNUM, 8)}` : g.chars(g.ALNUM, 12);
      return `postgres://admin:${password}@db.internal:5432/app`;
    }
    default:
      throw new Error(`No seeded secret generator for ${kind}`);
  }
}

function encodeJson(value) {
  return JSON.stringify(value).slice(1, -1);
}

function wrap(value, width) {
  const flat = value.replace(/\r?\n/g, "");
  return flat.match(new RegExp(`.{1,${width}}`, "g")).join("\n");
}

function wrapWithPrefix(prefix, value, width) {
  const text = prefix + value;
  const render = (from, to) => {
    let out = "";
    for (let i = from; i < to; i++) {
      if (i > from && i % width === 0) out += "\n";
      out += text[i];
    }
    return out;
  };
  return { text: render(0, text.length), value: render(prefix.length, text.length) };
}

function primaryShapes(sample, g) {
  const { kind, value } = sample;
  const labels = {
    github_token: "GITHUB_TOKEN=",
    gitlab_token: "GITLAB_TOKEN=",
    perplexity_key: "PERPLEXITY_API_KEY=",
    slack_token: "SLACK_TOKEN=",
    digitalocean_token: "DIGITALOCEAN_ACCESS_TOKEN=",
    huggingface_token: "HUGGINGFACE_TOKEN=",
    heroku_token: "HEROKU_API_KEY=",
    onepassword_token: "OP_SERVICE_ACCOUNT_TOKEN=",
    cloudflare_origin_ca_key: "CLOUDFLARE_ORIGIN_CA_KEY=",
    twilio_credentials: "TWILIO_CREDENTIALS=",
  };
  const label =
    labels[kind] ||
    (kind === "aws_access_key"
      ? "AWS_ACCESS_KEY_ID="
      : kind === "crypto_secret"
        ? "PRIVATE_KEY="
        : kind === "connection_string"
          ? "DATABASE_URL="
          : kind === "private_key"
            ? "private key: "
            : "token: ");
  const sentence = kind === "crypto_secret" ? `the private key: ${value}` : `the key is ${value}`;
  const jsonKey = labels[kind]
    ? labels[kind].slice(0, -1)
    : kind === "crypto_secret" || kind === "private_key"
      ? "private_key"
      : kind === "connection_string"
        ? "DATABASE_URL"
        : "token";
  const envKey = labels[kind]
    ? labels[kind].slice(0, -1)
    : kind === "aws_access_key"
      ? "AWS_ACCESS_KEY_ID"
      : kind === "crypto_secret" || kind === "private_key"
        ? "PRIVATE_KEY"
        : kind === "connection_string"
          ? "DATABASE_URL"
          : "SECRET";
  const block = kind === "private_key";
  const envValue = block ? encodeJson(value) : value;
  const bare = kind === "crypto_secret" ? `private key ${value}` : value;
  const twice =
    kind === "crypto_secret" ? `private key ${value}\r\nprivate key ${value}` : `first ${value}\r\nand again ${value}`;
  const shapes = [
    { name: "bare", value, text: bare },
    { name: "label", value, text: `${label}${value}` },
    { name: "sentence", value, text: sentence },
    { name: "json", value: encodeJson(value), text: `{"${jsonKey}":"${encodeJson(value)}"}` },
    { name: "env", value: envValue, text: `${envKey}=${envValue}` },
    { name: "trailingDot", value, text: kind === "crypto_secret" ? `private key ${value}.` : `${value}.` },
    { name: "trailingComma", value, text: kind === "crypto_secret" ? `private key ${value},` : `${value},` },
    { name: "crlf", value: value.replace(/\n/g, "\r\n"), text: `${label}\r\n${value.replace(/\n/g, "\r\n")}` },
    { name: "twice", value, text: twice },
  ];
  if (kind !== "crypto_secret") shapes.push({ name: "authorization", value, text: `Authorization: Bearer ${value}` });
  // A log line in a JSON string, where the line breaks are the two characters \n.
  if (!block && kind !== "crypto_secret") {
    shapes.push({ name: "afterEscape", value, text: `{"log":"started\\n${value}\\ndone"}` });
  }

  if (value.length >= 64 && !block && kind !== "crypto_secret") {
    for (const width of [64, 76]) {
      if (value.length - width >= 8) {
        const wrapped = wrap(value, width);
        shapes.push({ name: "wrap" + width, value: wrapped, text: wrapped });
      }
    }
  }
  if (block) {
    const yaml = value
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const escaped = encodeJson(value);
    const withoutFooter = value.replace(/\n-----END [A-Z]+ PRIVATE KEY-----$/, "");
    const base64Body = withoutFooter.slice(withoutFooter.indexOf("\n") + 1);
    const damagedFooter = `${withoutFooter}\n----END RSA PRIVATE KEY`;
    shapes.push(
      { name: "yamlIndented", value: yaml, text: `private_key: |\n${yaml}` },
      { name: "jsonEscaped", value: escaped, text: `{"private_key":"${escaped}"}` },
      { name: "truncated", value: withoutFooter, text: withoutFooter },
      { name: "damagedFooter", value: base64Body, text: damagedFooter },
      { name: "cutOffFooter", value: base64Body, text: `${withoutFooter}\n---` },
    );
    const jwk = `{"kty":"OKP","crv":"Ed25519","x":"${g.chars(g.ALNUM + "-_", 43)}","d":"${g.chars(g.ALNUM + "-_", 43)}"}`;
    shapes.push({ name: "jwk", value: jwk, text: jwk }, { name: "jwkLabel", value: jwk, text: `private key: ${jwk}` });
  }
  if (kind === "crypto_secret") {
    const phrase = g.seedPhrase(12).join(" ");
    shapes.push({ name: "seedPhrase", value: phrase, text: `seed phrase: ${phrase}` });
  }
  if (kind === "service_token") {
    for (const [name, providerEnvKey, variant] of [
      ["openvsx", "OVSX_PAT", "openvsx"],
      ["openvsxLegacy", "OVSX_PAT", "openvsxLegacy"],
      ["rubygems", "GEM_HOST_API_KEY", "rubygems"],
      ["jetbrainsMarketplace", "JETBRAINS_PUBLISH_TOKEN", "jetbrains"],
    ]) {
      shapes.push(...providerTokenShapes(name, providerEnvKey, secretValue(g, "service_token", variant)));
    }
    for (const [name, providerEnvKey, variant] of [
      ["groq", "GROQ_API_KEY", "groq"],
      ["openrouter", "OPENROUTER_API_KEY", "openrouter"],
      ["supabase", "SUPABASE_SECRET_KEY", "supabase"],
    ]) {
      shapes.push(...providerTokenShapes(name, providerEnvKey, secretValue(g, "service_token", variant)));
    }
    const sendgrid = `SG.${g.chars(g.ALNUM + "_-", 22)}.${g.chars(g.ALNUM + "_-", 42)}-`;
    shapes.push({ name: "sendgridTrailingDash", value: sendgrid, text: `SENDGRID_API_KEY=${sendgrid}` });
    shapes.push(
      { name: "sendgridWrap64", value: wrap(sendgrid, 64), text: wrap(sendgrid, 64) },
      { name: "sendgridWrap76", value: wrap(sendgrid, 76), text: wrap(sendgrid, 76) },
    );
    shapes.push({ name: "telegramUrl", value, text: `https://api.telegram.org/bot${value}/getMe` });
  }
  return shapes;
}

function providerTokenShapes(name, envKey, value) {
  const shapes = [
    { name: `${name}Bare`, value, text: value },
    { name: `${name}Env`, value, text: `${envKey}=${value}` },
    { name: `${name}Sentence`, value, text: `the key is ${value}` },
    { name: `${name}Json`, value, text: JSON.stringify({ [envKey]: value }) },
    { name: `${name}Authorization`, value, text: `Authorization: Bearer ${value}` },
    { name: `${name}TrailingDot`, value, text: `${value}.` },
    { name: `${name}Twice`, value, text: `first ${value}\r\nand again ${value}` },
    { name: `${name}Crlf`, value, text: `${envKey}=\r\n${value}` },
  ];
  for (const width of [64, 76]) {
    if (value.length - width >= 8) {
      const wrapped = wrapWithPrefix(`${envKey}=`, value, width);
      shapes.push({ name: `${name}Wrap${width}`, ...wrapped });
    }
  }
  return shapes;
}

function makeSecrets(seed = 20261019) {
  const g = makeGen(seed + 4);
  return [...SECRET_KINDS, ...EXTRA_KINDS].map((kind) => {
    const variant = kind === "service_token" ? "telegram" : kind === "connection_string" ? "slash" : "";
    const value = secretValue(g, kind, variant);
    const sample = { kind, value };
    const shapes = primaryShapes(sample, g);
    if (kind === "private_key") {
      const spaced = value.replace(/-----BEGIN /g, "----- BEGIN ").replace(/KEY-----/g, "KEY -----");
      shapes.push({ name: "spacedPem", value: spaced, text: spaced });
      const pgpBody = Array.from({ length: 4 }, () => g.chars(g.ALNUM + "+/", 64)).join("\n");
      const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\n" + pgpBody + "\n-----END PGP PRIVATE KEY BLOCK-----";
      shapes.push({ name: "pgpBlock", value: pgp, text: pgp });
      const jwk =
        '{"kty":"OKP","crv":"Ed25519","x":"' +
        g.chars(g.ALNUM + "-_", 43) +
        '","d":"' +
        g.chars(g.ALNUM + "-_", 43) +
        '"}';
      const escapedJwk = JSON.stringify(jwk).slice(1, -1);
      shapes.push({ name: "jwkJsonString", value: escapedJwk, text: '{"key":"' + escapedJwk + '"}' });
      const encodedPem = Buffer.from(value).toString("base64");
      const encoded64 = wrap(encodedPem, 64);
      const encoded76 = wrap(encodedPem, 76).replace(/\n/g, "\n  ");
      shapes.push(
        { name: "base64ClientKeyData", value: encoded64, text: "client-key-data: " + encoded64 },
        { name: "base64SecretData", value: encoded76, text: "data:\n  tls.key: " + encoded76 },
      );
    }
    if (kind === "aws_access_key") {
      const secretKey = g.chars(g.ALNUM + "/+", 40);
      const command = "export AWS_ACCESS_KEY_ID=" + value + ' AWS_SECRET_ACCESS_KEY="' + secretKey + '"';
      shapes.push({
        name: "awsSecretJson",
        value: secretKey,
        text: JSON.stringify({ cmd: command }),
        contextual: true,
      });
      // The secret half pasted beside its key ID with no label of its own.
      for (const [name, text] of [
        ["awsSecretBesideId", `${value} ${secretKey}`],
        ["awsSecretNextLine", `access key ${value} and secret key\n${secretKey}`],
        ["awsSecretTableRow", `| key | ${value} |\n| secret | ${secretKey} |`],
      ]) {
        shapes.push({ name, value: secretKey, text, contextual: true });
      }
    }
    if (kind === "service_token") {
      const sendgrid = shapes.find((shape) => shape.name === "sendgridTrailingDash").value;
      const withoutOldWraps = shapes.filter((shape) => !/^sendgridWrap/.test(shape.name));
      shapes.length = 0;
      shapes.push(...withoutOldWraps);
      for (const width of [64, 76]) {
        const wrapped = wrapWithPrefix("Authorization: Bearer ", sendgrid, width);
        shapes.push({ name: "sendgridWrap" + width, value: wrapped.value, text: wrapped.text });
      }
      const npm = secretValue(g, "service_token");
      const npmrc = wrapWithPrefix("//registry.npmjs.org/:_authToken=", npm, 64);
      shapes.push({ name: "npmrcWrap64", value: npmrc.value, text: npmrc.text });
      const azureKey = g.chars(g.ALNUM + "+/", 80) + "==";
      for (const width of [64, 76]) {
        const wrapped = wrapWithPrefix("AccountKey=", azureKey, width);
        shapes.push({ name: "azureAccountKeyWrap" + width, value: wrapped.value, text: wrapped.text });
      }
    }
    if (kind === "sentry_token" || kind === "atlassian_token") {
      const label = kind === "sentry_token" ? "SENTRY_AUTH_TOKEN=" : "ATLASSIAN_API_TOKEN=";
      for (const width of [64, 76]) {
        const wrapped = wrapWithPrefix(label, value, width);
        shapes.push({ name: "labelWrap" + width, value: wrapped.value, text: wrapped.text });
      }
    }
    if (kind === "jwt") {
      for (const width of [64, 76]) {
        const jwt = "eyJ" + g.b64u(15) + ".eyJ" + g.b64u(15) + "." + g.b64u(32);
        const wrapped = wrapWithPrefix("Authorization: Bearer ", jwt, width);
        shapes.push({ name: "jwtWrap" + width, value: wrapped.value, text: wrapped.text });
      }
    }
    if (kind === "slack_token") {
      const prefixed = "xoxe." + value;
      shapes.push({ name: "xoxePrefix", value: prefixed, text: prefixed });
      for (const providerVariant of ["app", "rotating_app", "config_access", "refresh", "webhook"]) {
        const credential = secretValue(g, kind, providerVariant);
        shapes.push({ name: providerVariant, value: credential, text: credential });
      }
    }
    if (kind === "github_token") {
      const stateless = secretValue(g, kind, "stateless");
      shapes.push({ name: "stateless", value: stateless, text: stateless });
    }
    if (kind === "gitlab_token") {
      for (const providerVariant of ["routable", "deploy", "ci", "runner", "feed", "scim", "a" + "gent", "oauth"]) {
        const credential = secretValue(g, kind, providerVariant);
        shapes.push({ name: providerVariant, value: credential, text: credential });
      }
    }
    if (kind === "digitalocean_token") {
      for (const providerVariant of ["oauth", "refresh"]) {
        const credential = secretValue(g, kind, providerVariant);
        shapes.push({ name: providerVariant, value: credential, text: credential });
      }
      const token = secretValue(g, kind);
      for (const width of [64, 76]) {
        const wrapped = wrapWithPrefix("DIGITALOCEAN_ACCESS_TOKEN=", token, width);
        shapes.push({ name: "digitalOceanWrap" + width, value: wrapped.value, text: wrapped.text });
      }
    }
    if (kind === "huggingface_token" || kind === "onepassword_token") {
      const providerVariant = kind === "huggingface_token" ? "organization" : "secret_key";
      const credential = secretValue(g, kind, providerVariant);
      shapes.push({ name: providerVariant, value: credential, text: credential });
    }
    if (kind === "crypto_secret") {
      const key = secretValue(g, kind, "hex");
      for (const width of [64, 76]) {
        const wrapped = wrapWithPrefix("deployment_private_key=", key, width);
        shapes.push({ name: "wrap" + width, value: wrapped.value, text: wrapped.text });
      }
      shapes.push({ name: "privateKeyHex", value: key, text: `PRIVATE_KEY=${key}` });
    }
    return { kind, value, shapes };
  });
}

function makeSecretSamples(seed = 20261019) {
  return makeSecrets(seed).map(({ kind, value, shapes }) => ({
    kind,
    value,
    text: shapes.find((shape) => shape.name === "bare")?.text ?? shapes[0].text,
  }));
}

module.exports = { SECRET_KINDS, EXTRA_KINDS, makeGen, makeSecretSamples, makeSecrets, secretValue };

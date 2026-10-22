"use strict";

const { makeGen, makeSecrets } = require("../fixtures/secrets.js");

const LABELS = {
  aws_access_key: "AWS_ACCESS_KEY_ID=",
  github_token: "GITHUB_TOKEN=",
  stripe_secret_key: "STRIPE_SECRET_KEY=",
  anthropic_key: "ANTHROPIC_API_KEY=",
  openai_key: "OPENAI_API_KEY=",
  xai_key: "XAI_API_KEY=",
  google_api_key: "GOOGLE_API_KEY=",
  slack_token: "SLACK_TOKEN=",
  gitlab_token: "GITLAB_TOKEN=",
  perplexity_key: "PERPLEXITY_API_KEY=",
  digitalocean_token: "DIGITALOCEAN_ACCESS_TOKEN=",
  huggingface_token: "HUGGINGFACE_TOKEN=",
  heroku_token: "HEROKU_API_KEY=",
  onepassword_token: "OP_SERVICE_ACCOUNT_TOKEN=",
  cloudflare_origin_ca_key: "CLOUDFLARE_ORIGIN_CA_KEY=",
  twilio_credentials: "TWILIO_CREDENTIALS=",
  sentry_token: "SENTRY_AUTH_TOKEN=",
  grafana_token: "GRAFANA_TOKEN=",
  vault_token: "VAULT_TOKEN=",
  replicate_token: "REPLICATE_API_TOKEN=",
  linear_key: "LINEAR_API_KEY=",
  postman_key: "POSTMAN_API_KEY=",
  shopify_token: "SHOPIFY_ACCESS_TOKEN=",
  atlassian_token: "ATLASSIAN_API_TOKEN=",
  netlify_token: "NETLIFY_AUTH_TOKEN=",
  pulumi_token: "PULUMI_ACCESS_TOKEN=",
  databricks_token: "DATABRICKS_TOKEN=",
  service_token: "SERVICE_TOKEN=",
  stripe_publishable_key: "STRIPE_PUBLISHABLE_KEY=",
  jwt: "Authorization: Bearer ",
  private_key: "",
  crypto_secret: "PRIVATE_KEY=",
  connection_string: "DATABASE_URL=",
};

const EXTRA_SECRET_KINDS = ["private_key", "crypto_secret", "connection_string"];
const VARIANT_SHAPES = {
  github_token: ["stateless"],
  slack_token: ["app", "rotating_app", "config_access", "refresh", "webhook"],
  gitlab_token: ["routable", "deploy", "ci", "runner", "feed", "scim", "a" + "gent", "oauth"],
  digitalocean_token: ["oauth", "refresh"],
  huggingface_token: ["organization"],
  onepassword_token: ["secret_key"],
  service_token: [
    "sendgridTrailingDash",
    "telegramUrl",
    "npmrcWrap64",
    "azureAccountKeyWrap64",
    "azureAccountKeyWrap76",
  ],
  jwt: ["jwtWrap64", "jwtWrap76"],
  private_key: ["pgpBlock"],
  crypto_secret: ["privateKeyHex"],
};

function isSecretPattern(pattern) {
  return pattern.group === "credentials" && pattern.secret;
}

function secretPatterns() {
  return globalThis.Clotr.PATTERNS.filter(isSecretPattern);
}

function candidatesFor(seed, kind) {
  const fixture = makeSecrets(seed).find((item) => item.kind === kind);
  if (!fixture) throw new Error(`${kind} has no seeded shape`);
  const values = new Map();
  values.set(fixture.value, { name: "base", prefix: LABELS[kind] || "TOKEN=" });
  for (const shapeName of VARIANT_SHAPES[kind] || []) {
    const shape = fixture.shapes.find((item) => item.name === shapeName);
    if (!shape) throw new Error(`${kind}:${shapeName} has no seeded shape`);
    if (shape.contextual) continue;
    const at = shape.text.indexOf(shape.value);
    const prefix = at > 0 ? shape.text.slice(0, at) : LABELS[kind] || "TOKEN=";
    const value = kind === "private_key" ? shape.value : shape.value.replace(/\r?\n/g, "");
    values.set(value, { name: shape.name, prefix });
  }
  return [...values].map(([value, shape]) => ({ kind, name: shape.name, prefix: shape.prefix, value }));
}

function wrapLines(value, width) {
  return value
    .split("\n")
    .map((line) => line.match(new RegExp(`.{1,${width}}`, "g"))?.join("\n") ?? "")
    .join("\n");
}

function wrapWords(value, width) {
  const lines = [];
  let line = "";
  for (const word of value.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function zeroWidth(value) {
  const point = Math.floor(value.length / 2);
  return `${value.slice(0, point)}\u200b${value.slice(point)}`;
}

function privateKeyBase64IsRecognizable(value) {
  return /^-----BEGIN [A-Z ]*PRIVATE KEY-----|^LS0tLS1CRUdJTi/.test(value.replace(/[\s]/g, ""));
}

function wrappersFor(candidate) {
  const { kind, value } = candidate;
  const source = candidate.envelope || value;
  const label = candidate.prefix || (candidate.envelope ? "" : LABELS[kind]) || "TOKEN=";
  const jsonKey = kind.toUpperCase();
  const isPrivateKey = kind === "private_key";
  const lineValue = isPrivateKey ? source : source.replace(/\r?\n/g, "");
  const wrap = (width) =>
    kind === "crypto_secret" && !lineValue.startsWith("0x")
      ? wrapWords(`${label}${lineValue}`, width)
      : wrapLines(`${label}${lineValue}`, width);
  const line64 = wrap(64);
  const line76 = wrap(76);
  const forms = [
    { name: "bare", text: `${label}${source}`, detect: true },
    { name: "CRLF", text: `${label}${source.replace(/\n/g, "\r\n")}\r\n`, detect: true },
    { name: "line-64", text: line64, detect: true },
    { name: "line-76", text: line76, detect: true },
    { name: "JSON-escaped", text: JSON.stringify({ [jsonKey]: source }), detect: true },
    { name: "JSON-line-64", text: JSON.stringify({ [jsonKey]: line64 }), detect: true },
    { name: "JSON-line-76", text: JSON.stringify({ [jsonKey]: line76 }), detect: true },
    { name: "quoted", text: `${label}"${source}"`, detect: true },
    { name: "after-label", text: `${label}${source}`, detect: true },
    { name: "zero-width", text: `${label}${zeroWidth(source)}`, detect: true },
    {
      name: "base64",
      text: `${label}${Buffer.from(source).toString("base64")}`,
      detect: isPrivateKey && privateKeyBase64IsRecognizable(source),
    },
    { name: "log-line", text: `ERROR worker-7 ${label}${source}\r\n`, detect: true },
  ];
  return forms;
}

function privateKeyEnvelopes(seed) {
  const g = makeGen(seed + 17);
  const privateKey = makeSecrets(seed).find((fixture) => fixture.kind === "private_key").value;
  const body = Array.from({ length: 8 }, () => g.chars(`${g.ALNUM}+/`, 64)).join("\n");
  const openSsh = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
  const kubeconfig = [
    "apiVersion: v1",
    "kind: Config",
    "users:",
    "- name: demo",
    "  user:",
    `    client-key-data: ${Buffer.from(privateKey).toString("base64")}`,
  ].join("\n");
  return [
    { kind: "private_key", name: "OpenSSH", value: openSsh },
    { kind: "private_key", name: "kubeconfig", value: privateKey, envelope: kubeconfig },
  ];
}

function generatedCases(seed) {
  const patterns = secretPatterns();
  const kinds = [...new Set([...patterns.map((pattern) => pattern.id), ...EXTRA_SECRET_KINDS])];
  const fixtures = new Set(makeSecrets(seed).map((fixture) => fixture.kind));
  const missing = kinds.filter((kind) => !fixtures.has(kind));
  if (missing.length) throw new Error(`missing rule-shaped fixtures: ${missing.join(", ")}; seed=${seed}`);

  return [...kinds.flatMap((kind) => candidatesFor(seed, kind)), ...privateKeyEnvelopes(seed)];
}

const residualRun = (secret, output, min = 12) => {
  const normalize = (value) =>
    value
      .replace(/\[REDACTED [^\]]*\]/g, "")
      .replace(/\b(?:PRIVATE_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DATABASE_URL|SECRET|TOKEN)\s*[:=]\s*/gi, "")
      .replace(/[\s"'\\]/g, "");
  const body = normalize(secret);
  const left = normalize(output);
  for (let i = 0; i + min <= body.length; i++) if (left.includes(body.slice(i, i + min))) return body.slice(i, i + min);
  return "";
};

module.exports = { generatedCases, residualRun, secretPatterns, wrappersFor };

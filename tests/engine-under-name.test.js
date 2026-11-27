// A secret one level under its name in YAML: a CloudFormation parameter's Default:, a value: or text: under the name,
// or a list item under it. The value is read whole, and nothing around it is. Keys that only describe the secret,
// a parameter with no Default:, and a value that's a reference, a variable or a placeholder stay quiet.
// Every value is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const KINDS = new Set(["password", "service_token"]);
const secretFindings = (text) => detect(text).filter((f) => KINDS.has(f.id));

// [text, kind, the value as found]
const FOUND = [
  ["Parameters:\n  DbPassword:\n    Type: String\n    Default: Maple7!river\n", "password", "Maple7!river"],
  ["auth:\n  password:\n    value: Maple7!river\n", "password", "Maple7!river"],
  ["auth:\n  existingSecret: my-release-auth\n  password:\n    - Maple7!river\n", "password", "Maple7!river"],
  ["api_key:\n  text: Zq7fAkE9mAdE4uP2xK8vN3tR6wB1\n", "service_token", "Zq7fAkE9mAdE4uP2xK8vN3tR6wB1"],
];

for (const [text, kind, value] of FOUND) {
  test(`a secret one level under its name is found whole: ${JSON.stringify(text)}`, () => {
    const findings = secretFindings(text);
    assert.deepEqual(
      findings.map((f) => [f.id, f.matches]),
      [[kind, [value]]],
    );
  });
}

test("a CloudFormation ApiKey's Default: is found", () => {
  const text = "Parameters:\n  ApiKey:\n    Type: String\n    Default: Zq7fAkE9mAdE4uP2xK8vN3tR6wB1\n";
  const matches = secretFindings(text).flatMap((f) => f.matches);
  assert.ok(matches.includes("Zq7fAkE9mAdE4uP2xK8vN3tR6wB1"), JSON.stringify(matches));
});

const QUIET = [
  "Parameters:\n  DbPassword:\n    Type: String\n    NoEcho: true\n",
  "secretKeyRef:\n  name: db-creds\n  key: password\n",
  "password:\n  description: The admin password\n  type: string\n  required: true\n",
  "password:\n  enabled: true\n",
  "api_key:\n  required: false\n  type: string\n",
  "Parameters:\n  DbPassword:\n    Type: String\n    Default: ${DB_PASSWORD}\n",
  "Parameters:\n  DbPassword:\n    Type: String\n    Default: !Ref DbPassword\n",
  "Parameters:\n  DbPassword:\n    Type: String\n    Default: changeme\n",
  "auth:\n  password:\n    value: <password>\n",
  "auth:\n  password:\n    value: $DB_PASSWORD\n",
  "auth:\n  password:\n    value: YOUR_PASSWORD_HERE\n",
  "api_key:\n  text: <your-api-key>\n",
  // A key at the name's own depth isn't under it.
  "password:\nvalue: Maple7!river\n",
  "settings:\n  password:\n  value: Maple7!river\n",
];

for (const text of QUIET) {
  test(`stays quiet: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(secretFindings(text), []);
  });
}

// Live already reads the capitalised key under these names (secretKeyRef:, valueFrom:) as the password. That stays
// as it is, and nothing under the key is read.
const POINTERS = [
  "password:\n  secretKeyRef:\n    name: db-creds\n    key: password\n",
  "db_secret:\n  secretKeyRef:\n    name: db-creds\n    key: password\n",
  "db_password:\n  valueFrom:\n    secretKeyRef:\n      name: db-creds\n      key: password\n",
];

for (const text of POINTERS) {
  test(`a secretKeyRef's name and key aren't read: ${JSON.stringify(text)}`, () => {
    const matches = secretFindings(text).flatMap((f) => f.matches);
    assert.ok(!matches.some((m) => /db-creds|^password$/.test(m)), JSON.stringify(matches));
  });
}

// A value one level under a name is judged by its snake_case twin's own line, so a lookup name (nextToken, s3_key)
// stays a lookup. Under a name that points at a secret (PasswordRef, ExistingSecret, password_ref) a capitalised name
// with a number is the name of a thing. The values are built from pieces so none reads as a real one.
const UUID = ["3f2a9c1e", "4b7d", "4e2a", "9f1c", "8d3e5a7b2c4f"].join("-");
const PAGE = Buffer.from(["page", "-cursor", "-after-", "42"].join("")).toString("base64");
const REF = ["Orders", "Db", "2024"].join("");
const cfn = (name, value) => `Parameters:\n  ${name}:\n    Type: String\n    Default: ${value}\n`;
const nested = (name, value) => `config:\n  ${name}:\n    value: ${value}\n`;

// [nested text, the same name and value on one line]
const QUIET_BOTH_WAYS = [
  [cfn("S3Key", ["Handler", "v2", "Build17"].join("_")), `S3Key: ${["Handler", "v2", "Build17"].join("_")}\n`],
  [nested("nextToken", PAGE), `nextToken: ${PAGE}\n`],
  [`upload:\n  s3_key:\n    default: ${UUID}\n`, `s3_key: ${UUID}\n`],
  [`upload:\n  page_token:\n    - ${UUID}\n`, `page_token: ${UUID}\n`],
  [cfn("PasswordRef", REF), `PasswordRef: ${REF}\n`],
  [nested("ExistingSecret", REF), `ExistingSecret: ${REF}\n`],
];

for (const [text, line] of QUIET_BOTH_WAYS) {
  test(`stays quiet one level down as on its own line: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(secretFindings(line), [], "on its own line");
    assert.deepEqual(secretFindings(text), []);
  });
}

// A reference name under a name that points at a secret stays quiet one level down.
for (const text of [
  nested("passwordRef", REF),
  cfn("PasswordRef", REF),
  nested("password_ref", REF),
  nested("existing_secret", REF),
]) {
  test(`a reference under a pointing name stays quiet: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(secretFindings(text), []);
  });
}

// A password one level under a camelCase name is still found, and Hide it covers only the value.
const PW = ["Maple", "7!", "river"].join("");
for (const text of [nested("dbPassword", PW), cfn("DbPassword", PW), nested("passwordRef", PW)]) {
  test(`a password under a camelCase name is found whole: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(
      secretFindings(text).map((f) => [f.id, f.matches]),
      [["password", [PW]]],
    );
  });
}

// A camelCase or PascalCase name's value one level down is judged as the camelCase reader judges that name's own
// line: a KMS key id, a commit hash, a tier name or a resource name with a number stays quiet under every key that's
// read (Default:, value:, text: or a list item), as it does on one line.
const SHA = ["9c1f3e7a", "2b4d6f80", "1a3c5e7b", "9d0f2a4c", "6e8b0d1f"].join("");
const TIER = ["Standard", "Tier", "2"].join("");
const NAMED = [
  UUID,
  ["Users", "v2", "Index"].join("_"),
  ["Prod", "Key", "2024"].join(""),
  ["Ab", "12", "Cd", "34"].join(""),
];
const under = {
  value: (name, v) => `config:\n  ${name}:\n    value: ${v}\n`,
  default: (name, v) => `config:\n  ${name}:\n    default: ${v}\n`,
  text: (name, v) => `config:\n  ${name}:\n    text: ${v}\n`,
  item: (name, v) => `config:\n  ${name}:\n    - ${v}\n`,
  cfn,
};
const CAMEL_QUIET = [
  ["SecretKmsKey", UUID],
  ["SourceToken", SHA],
  ["accessToken", UUID],
  ["PasswordRef", ["Prod", "Api", "Key", "V3"].join("")],
  ["PasswordRef", ["DbPass", "v2", "Prod"].join("_")],
  ["ExistingSecret", ["Prod", "Api", "Key", "V3"].join("")],
  ["ExistingSecret", ["DbPass", "v2", "Prod"].join("_")],
  ...[TIER, ...NAMED].map((v) => ["clientSecret", v]),
  ...[TIER, ...NAMED.slice(1)].map((v) => ["secretKey", v]),
];

for (const [name, value] of CAMEL_QUIET) {
  test(`a value under ${name} stays quiet as on its own line: ${value}`, () => {
    assert.deepEqual(secretFindings(`${name}: ${value}\n`), [], "on its own line");
    for (const [key, build] of Object.entries(under)) {
      assert.deepEqual(secretFindings(build(name, value)), [], key);
    }
  });
}

// A real-looking password stays found one level under the same names, and only the value is taken.
for (const name of ["dbPassword", "DbPassword", "ApiSecret", "SecretArn", "clientSecret", "PasswordRef"]) {
  test(`a password under ${name} is still found whole`, () => {
    for (const [key, build] of Object.entries(under)) {
      assert.deepEqual(
        secretFindings(build(name, PW)).map((f) => [f.id, f.matches]),
        [["password", [PW]]],
        key,
      );
    }
  });
}

// A camelCase setting whose value names something (a Secret's key, an env reference, a service, an id or another
// setting's name) stays quiet, as on 1.6.1. A real-looking password under the same names is still found.
// Every value here is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

const Clotr = globalThis.Clotr;

const HELM_NAMES = [
  ["adminPasswordKey", "admin-password"],
  ["userPasswordKey", "user-password"],
  ["replicationPasswordKey", "replication-password"],
  ["rootPasswordKey", "mariadb-root-password"],
  ["passwordKey", "redis-password"],
  ["postgresPasswordKey", "postgres-password"],
  ["existingSecretPasswordKey", "db-password"],
  ["secretKey", "client-secret"],
  ["tokenKey", "api-token"],
  ["apiKeyKey", "api-key"],
  ["existingSecretKey", "client-secret"],
  ["rootPasswordSecretKey", "mongodb-root-password"],
];

function helmSet() {
  const rows = [];
  for (const [name, value] of HELM_NAMES) {
    rows.push({ text: `${name}: ${value}`, values: [value] });
    rows.push({ text: `auth:\n  secretKeys:\n    ${name}: ${value}`, values: [value] });
    rows.push({ text: `auth:\n  ${name}: "${value}"`, values: [value] });
  }
  const block = [
    "global:",
    "  postgresql:",
    "    auth:",
    "      existingSecret: pg-creds",
    "      secretKeys:",
    "        adminPasswordKey: postgres-password",
    "        userPasswordKey: password",
    "        replicationPasswordKey: replication-password",
  ].join("\n");
  rows.push({ text: block, values: ["postgres-password", "replication-password", "password"] });
  return rows;
}

const CAMEL_NAMES = [
  "accessToken",
  "clientSecret",
  "passwordRef",
  "apiKey",
  "secretKey",
  "authToken",
  "dbPassword",
  "refreshToken",
];
const CAMEL_VALUES = [
  "user_id",
  "ProdKey2024",
  "OrdersDb2024",
  "my-app-secret",
  "true",
  "session",
  "Bearer",
  "none",
  "env:TOKEN",
  "oauth2",
  "accessToken",
  "SecretsManager",
];

function camelSet() {
  const rows = [];
  for (const name of CAMEL_NAMES) {
    for (const value of CAMEL_VALUES) {
      rows.push({ name, text: `${name}: ${value}`, values: [value] });
      rows.push({ name, text: `config:\n  ${name}: "${value}"`, values: [value] });
    }
  }
  return rows;
}

// Two made-up passwords, built in parts.
const PASSWORDS = ["Xk9#" + "mQ2!vR7z", "Maple7!" + "river"];

function passwordSet() {
  return CAMEL_NAMES.flatMap((name) => PASSWORDS.map((pw) => ({ name, text: `${name}: ${pw}`, values: [pw] })));
}

// A row is flagged when a finding's match holds one of its values.
function flagged(clotr, row) {
  return clotr.detect(row.text).some((f) => (f.matches || []).some((m) => row.values.some((v) => m.includes(v))));
}

const loud = (rows) => rows.filter((row) => flagged(Clotr, row)).map((row) => row.text);

test("a Helm chart's Secret key name under its key setting is quiet", () => {
  const rows = helmSet();
  assert.equal(rows.length, 37);
  assert.deepEqual(loud(rows), []);
});

test("a camelCase setting's value that names something is quiet, apart from apiKey as on 1.6.1", () => {
  const rows = camelSet();
  assert.equal(rows.length, 192);
  assert.deepEqual(loud(rows.filter((row) => row.name !== "apiKey")), []);
});

// 1.6.1 flags these 13 under apiKey, by its key label reader. They stay as they are.
const API_KEY_FLAGGED = ["user_id", "ProdKey2024", "OrdersDb2024", "my-app-secret", "env:TOKEN", "SecretsManager"];

test("apiKey's values read as on 1.6.1", () => {
  const rows = camelSet().filter((row) => row.name === "apiKey");
  const expected = rows
    .filter((row) => API_KEY_FLAGGED.includes(row.values[0]) || row.text === 'config:\n  apiKey: "accessToken"')
    .map((row) => row.text);
  assert.equal(expected.length, 13);
  assert.deepEqual(loud(rows), expected);
});

test("a real-looking password under a camelCase name is still found", () => {
  const found = passwordSet().filter((row) => flagged(Clotr, row));
  const names = [...new Set(found.map((row) => row.name))].sort();
  assert.deepEqual(names, ["accessToken", "apiKey", "clientSecret", "dbPassword", "passwordRef"]);
  assert.equal(found.length, 10);
});

// A setting named for where a secret is kept (a Ref, Key or SecretName setting) holds a name: a key inside a Secret,
// a Secret's own name or a path in a vault.
const KEPT_IN_NAMES = [
  "adminPasswordKey",
  "rootPasswordSecretKey",
  "passwordKey",
  "userPasswordKey",
  "clientSecretKey",
  "passwordRef",
  "clientSecretRef",
  "passwordSecretName",
];
const KEPT_IN_VALUES = [
  "adminPassword",
  "rootPassword",
  "clientSecret",
  "mysqlRootPassword",
  "pg-creds",
  "my-release-postgresql",
  "vault:" + "secret/data/db",
  "secretsmanager:" + "prod/db",
  "ref+vault:" + "//secret/db#pass",
  "vault:" + "//kv/app/db",
];
// A password, secret or token setting over a Secret's name, another setting's name or an id.
const SECRET_NAMES = ["dbPassword", "adminPassword", "clientSecret", "accessToken", "redisPassword"];
const NAMED_VALUES = [
  "pg-creds",
  "mysql-auth",
  "app-env",
  "db-credentials",
  "orders-db",
  "oauthClient",
  "userService",
  "configMap",
  "DefaultConnection",
  "tenantId",
  "userId",
  "vault:" + "secret/data/db",
  "ref+vault:" + "//secret/db#pass",
];

// One line, one level down, quoted and in JSON.
const fourWays = (name, value) => [
  `${name}: ${value}`,
  `config:\n  ${name}: ${value}`,
  `auth:\n  ${name}: "${value}"`,
  `{"app": {"${name}": "${value}"}}`,
];
const crossed = (names, values) =>
  names.flatMap((name) => values.flatMap((value) => fourWays(name, value).map((text) => ({ text, values: [value] }))));

test("a Ref, Key or SecretName setting over a name or a path is quiet", () => {
  const rows = crossed(KEPT_IN_NAMES, KEPT_IN_VALUES);
  assert.equal(rows.length, 320);
  assert.deepEqual(loud(rows), []);
});

test("a password, secret or token setting over a Secret's name, a setting's name or an id is quiet", () => {
  const rows = crossed(SECRET_NAMES, NAMED_VALUES);
  assert.equal(rows.length, 260);
  assert.deepEqual(loud(rows), []);
});

// A long random key, built in parts.
const RANDOM_KEY = "Rt4w" + "Kp9zLm2Xq7" + "Vn5Bc8Jd3Hf6Ys";

test("a real-looking password or a random key under a Ref or Key setting is still found", () => {
  const rows = crossed(["passwordRef", "adminPasswordKey", "clientSecretRef"], [...PASSWORDS, RANDOM_KEY]);
  assert.equal(rows.length, 36);
  assert.deepEqual(
    rows.filter((row) => !flagged(Clotr, row)).map((row) => row.text),
    [],
  );
});

// Under a password setting only a digit with a password's mark, or a random key, is read. A word with a year, a
// passphrase and a password whose only mark is "@" stay quiet, as on 1.6.1. Built in parts.
const UNSHAPED = ["Raven" + "2023", "velvet-" + "canyon-" + "otter-" + "drum", "1qaz" + "@WSX" + "3edc"];

test("a word with a year, a passphrase or an @ as the only mark is quiet under a password setting", () => {
  const rows = crossed(["dbPassword", "adminPassword"], UNSHAPED);
  assert.equal(rows.length, 24);
  assert.deepEqual(loud(rows), []);
});

// Names with a digit in them: a Secret's or a release's name with its version, a vault or Secrets Manager path, a
// year or an id. Under a password, secret or token setting they stay quiet, as on 1.6.1. Built in parts.
const DIGIT_SETTINGS = [
  "passwordRef",
  "adminPasswordKey",
  "rootPasswordSecretKey",
  "clientSecretRef",
  "userPasswordKey",
  "dbPassword",
  "clientSecret",
  "accessToken",
  "redisPassword",
];
const DIGIT_NAMES = [
  "pg-creds-" + "v2",
  "postgres-db-" + "1",
  "my-release-postgresql-" + "0",
  "vault:" + "secret/data/db1",
  "secretsmanager:" + "prod/db-2024",
  "redis-auth-" + "v3",
  "orders-db-" + "2024",
  "kv-prod-" + "01",
  "keycloak-admin-" + "1",
  "app1-" + "creds",
  "ref+awssecrets:" + "//prod/db1#password",
];

test("a name with a digit under a password, secret or token setting is quiet", () => {
  const rows = crossed(DIGIT_SETTINGS, DIGIT_NAMES);
  assert.equal(rows.length, 396);
  assert.deepEqual(loud(rows), []);
});

// The marks a name, path, link or template doesn't join with. A made-up password with a digit and one of them.
const REAL_MARKS = ["!", "#", "%", "^", "&", "*", "?", "~"];
const markPasswords = () => REAL_MARKS.map((mark) => "Tq7" + mark + "vLp4" + "wZn");

test("a password with a digit and a real mark under a password, secret or token setting is still found", () => {
  const rows = crossed(DIGIT_SETTINGS, markPasswords());
  assert.equal(rows.length, 288);
  assert.deepEqual(
    rows.filter((row) => !flagged(Clotr, row)).map((row) => row.text),
    [],
  );
});

test("a random key under a password, secret or token setting is still found", () => {
  const rows = crossed(DIGIT_SETTINGS, [RANDOM_KEY]);
  assert.deepEqual(
    rows.filter((row) => !flagged(Clotr, row)).map((row) => row.text),
    [],
  );
});

// A name, path, link or version under a camelCase password setting stays quiet, as on 1.6.1, even with a digit and
// one of a password's marks in it: a version range, a link with a query, an encoded path, a home path, a bare YAML
// alias and an image digest. A real-looking password with a digit and
// a mark is still found under the same settings. Every value here is made up and built in parts.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

const Clotr = globalThis.Clotr;

const SETTINGS = [
  "dbPassword",
  "adminPassword",
  "passwordRef",
  "passwordFile",
  "rootPassword",
  "redisPassword",
  "clientSecret",
  "accessToken",
];

// One line, one level down, quoted, JSON and XML.
const fiveWays = (name, value) => [
  `${name}: ${value}`,
  `config:\n  ${name}: ${value}`,
  `auth:\n  ${name}: "${value}"`,
  `{"app": {"${name}": "${value}"}}`,
  `<config>\n  <${name}>${value}</${name}>\n</config>`,
];
const crossed = (values) =>
  SETTINGS.flatMap((name) => values.flatMap((value) => fiveWays(name, value).map((text) => ({ text, value }))));

// A row is flagged when a finding's match holds its value.
const flagged = (row) => Clotr.detect(row.text).some((f) => (f.matches || []).some((m) => m.includes(row.value)));
// <passwordRef> in XML is read by the element reader, not the camelCase reader, and is left as it was.
const loud = (values) =>
  crossed(values)
    .filter((row) => !row.text.includes("<passwordRef>"))
    .filter(flagged)
    .map((row) => row.text);

const hex = (n, seed) => Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + seed) % 16]).join("");
const b64 = (s) => Buffer.from(s).toString("base64");

const QUIET = {
  "a version range": ["^2" + ".3.1", "~1" + ".4.0", "^0" + ".9.2 || ^1.0.0"],
  "a link with a query": [
    "https" + "://vault.internal:8200/v1/secret/data/db?version=2",
    "vault" + "://kv/db?version=3",
    "https" + "://secrets.example.test/v1/db?rev=4&env=prod",
  ],
  "an encoded path": ["secret" + "%2Fdb-2", "kv%2F" + "prod%2Fdb-3"],
  "a home path": ["~" + "/secrets/client2.json", "~" + "/.pgpass2", "~" + "/.config/app/db-3.key"],
  "an image digest": [
    "sha" + "256:" + hex(64, 3),
    "sha" + "512:" + hex(128, 5),
    "registry.example.test/app@" + "sha256:" + hex(64, 11),
  ],
};

for (const [shape, values] of Object.entries(QUIET)) {
  test(`${shape} under a camelCase password setting is quiet, as on 1.6.1`, () => {
    assert.deepEqual(loud(values), []);
  });
}

// These are flagged as on 1.6.2. Each row has a group per setting, with a 1 for each of the five ways it's flagged.
const BASE64_OF_A_NAME = [
  [b64("admin-user-" + "2024"), "11111 11110 11111 00000 11110 11110 11110 11110"],
  [b64("pg-creds-v2-" + "2024"), "00000 00000 00001 00000 00000 00000 00000 00000"],
  [b64("vault/db/" + "password-3"), "11111 11110 11111 00000 11110 11110 11110 11110"],
];

test("the base64 of a name under a camelCase password setting is read as on 1.6.2", () => {
  for (const [value, expected] of BASE64_OF_A_NAME) {
    const row = SETTINGS.map((name) =>
      fiveWays(name, value)
        .map((text) => (flagged({ text, value }) ? 1 : 0))
        .join(""),
    ).join(" ");
    assert.equal(row, expected);
  }
});

// Bare in YAML, any alias is an alias. In quotes it's a plain value, so *defaults_2 there reads like *hunter_22, and
// *db_password_1 there is found, as on 1.6.2.
test("a bare YAML alias under a camelCase password setting is quiet, as on 1.6.1", () => {
  const values = [
    "*" + "defaults_2",
    "*" + "Base-Config-3",
    "*" + "db_password_1",
    "*" + "shared-db-pw-3",
    "*" + "redis_secret_2",
  ];
  const rows = SETTINGS.flatMap((name) =>
    values.flatMap((value) =>
      fiveWays(name, value)
        .slice(0, 2)
        .map((text) => ({ text, value })),
    ),
  );
  assert.deepEqual(
    rows.filter(flagged).map((row) => row.text),
    [],
  );
});

// Real-looking passwords with a digit and a mark, some with a "/", "#", "~", "." or "%" in them, or starting the
// way a home path, an alias or an encoded path does.
const PASSWORDS = [
  "Fern" + "~42!x",
  "river/" + "Stone#9",
  "pine." + "Cone#58",
  "~/Fern" + "42!",
  "*Fern" + "42!",
  "Moss%" + "41x!",
  "Tq7" + "?vLp4wZn",
  "^Tq7" + "vLp4wZn",
];

test("a password with a digit and a mark under a camelCase password setting is still found", () => {
  // passwordFile holds a file's path, and the XML reader reads only <dbPassword>, as on the trunk before this.
  const rows = crossed(PASSWORDS).filter((row) => !/passwordFile|<config>/.test(row.text));
  assert.deepEqual(
    rows.filter((row) => !flagged(row)).map((row) => row.text),
    [],
  );
});

test("a password in a link's query under a camelCase password setting is still found", () => {
  const values = PASSWORDS.slice(0, 3).map((pw) => "jdbc:postgresql" + "://db:5432/app?user=app&password=" + pw);
  const rows = SETTINGS.filter((name) => name !== "passwordFile").flatMap((name) =>
    values.flatMap((value) =>
      fiveWays(name, value)
        .slice(0, 4)
        .map((text) => ({ text, value })),
    ),
  );
  assert.deepEqual(
    rows.filter((row) => !flagged(row)).map((row) => row.text),
    [],
  );
});

test("a password beside a name of each shape in the same text is still found", () => {
  const names = Object.values(QUIET).map((values) => values[0]);
  const lines = names.map((value, i) => `  ${SETTINGS[i % SETTINGS.length]}: "${value}"`);
  for (const pw of PASSWORDS) {
    const text = ["app:", ...lines, `  dbPassword: "${pw}"`].join("\n");
    const found = Clotr.detect(text).flatMap((f) => f.matches || []);
    assert.ok(
      found.some((m) => m.includes(pw)),
      `the password is found among names (${pw.length} characters)`,
    );
    assert.deepEqual(
      names.filter((n) => found.some((m) => m.includes(n))),
      [],
    );
  }
});

// Real passwords that look a little like the names above, found as on 1.6.2. Each is built in parts.
const FOUND_SETTINGS = SETTINGS.filter((name) => name !== "passwordFile");
const lineDownQuotedJson = (values) =>
  FOUND_SETTINGS.flatMap((name) =>
    values.flatMap((value) =>
      fiveWays(name, value)
        .slice(0, 4)
        .map((text) => ({ text, value })),
    ),
  );
const missed = (rows) => rows.filter((row) => !flagged(row)).map((row) => row.text);

test("the base64 of a generated password under a camelCase password setting is found", () => {
  const generated = ["kqzm" + "tp-rTvx" + "wq-lbnc9d", "hW3k" + "Qz8L.pR2m" + "Xv7n", "ab4Xyq" + "Tn_e7Hp" + "Lm2v"];
  const values = generated.map(b64);
  const secret = (value) =>
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: orders-db\ndata:\n  dbPassword: ${value}\n`;
  const rows = [...lineDownQuotedJson(values), ...values.map((value) => ({ text: secret(value), value }))];
  assert.deepEqual(missed(rows), []);
});

test("a quoted password starting with * under a camelCase password setting is found", () => {
  // Quoted or in JSON, a * can't start a YAML alias, so the value is the password itself.
  const values = ["*Falcon" + "-2024", "*hunter" + "_22", "*Pass" + ".word1", "*monkey" + "_123"];
  const rows = lineDownQuotedJson(values).filter((row) => /"\*/.test(row.text));
  assert.equal(rows.length, FOUND_SETTINGS.length * values.length * 2);
  assert.deepEqual(missed(rows), []);
});

test("a password in a link's query under any parameter under a camelCase password setting is found", () => {
  const passwords = ["Maple" + "47!qz", "hunter" + "22#x"];
  const values = ["p", "credential", "sig", "access"].flatMap((param) =>
    passwords.map((pw) => "https" + "://cfg.internal/app?" + param + "=" + pw),
  );
  const rows = lineDownQuotedJson(values).map((row) => ({ ...row, value: row.value.split("=")[1] }));
  assert.deepEqual(missed(rows), []);
});

test("a quoted lowercase password starting with * and holding a secret word is found", () => {
  // In quotes YAML reads no alias and JSON has none, so *secret-123 there is the password itself.
  const values = ["*secret" + "-123", "*password" + "_1", "*my_" + "password1", "*pass" + "-word1", "*token" + ".2024"];
  const rows = lineDownQuotedJson(values).filter((row) => /"\*/.test(row.text));
  assert.equal(rows.length, FOUND_SETTINGS.length * values.length * 2);
  assert.deepEqual(missed(rows), []);
});

test("a word and a number joined by - _ or . in a login link's query is found", () => {
  const passwords = ["hunter" + "-42", "summer" + "_2024", "dragon" + ".99", "Summer" + "-2024", "letmein" + ".1"];
  const values = ["p", "credential", "access", "sig"].flatMap((param) =>
    passwords.map((pw) => "https" + "://legacy.internal/login?u=admin&" + param + "=" + pw),
  );
  const rows = lineDownQuotedJson(values).map((row) => ({ ...row, value: row.value.split("&").pop().split("=")[1] }));
  assert.deepEqual(missed(rows), []);
});

test("a quoted lowercase password of three parts starting with * and holding a secret word is found", () => {
  // In quotes or JSON a * never starts an alias, so the whole value is the password, as on 1.6.2.
  const values = [
    "*super" + "_secret" + "_1",
    "*my" + "_db" + "_pass1",
    "*admin" + "-pass" + "-word2",
    "*root" + "_password" + "_99",
    "*my" + "_token" + "_2024",
    "*db" + "_password" + "_1",
  ];
  const rows = lineDownQuotedJson(values).filter((row) => /"\*/.test(row.text));
  assert.equal(rows.length, FOUND_SETTINGS.length * values.length * 2);
  assert.deepEqual(missed(rows), []);
});

test("a word and a number in a link's query under a version or place parameter is found", () => {
  // tag=hunter-42 reads like p=hunter-42, as on 1.6.2. A number, a version or plain words there stay quiet.
  const params = ["v", "ver", "version", "rev", "revision", "release", "tag", "env", "environment", "stage"];
  const passwords = ["hunter" + "-42", "summer" + "_2024", "dragon" + ".99"];
  const values = [...params, "region", "zone"].flatMap((param) =>
    passwords.map((pw) => "https" + "://cfg.internal/app?" + param + "=" + pw),
  );
  const rows = lineDownQuotedJson(values).map((row) => ({ ...row, value: row.value.split("=")[1] }));
  assert.deepEqual(missed(rows), []);
});

test("a password starting with * between XML tags under a camelCase password setting is found", () => {
  // XML has no aliases, so after a tag's ">" a "*" is part of the password, as on 1.6.2.
  const values = ["*hunter" + "_22", "*secret" + "-123", "*super" + "_secret_1", "*my_db" + "_pass1", "*Fern" + "42!"];
  const rows = values.flatMap((value) => [
    { text: `<config>\n  <dbPassword>${value}</dbPassword>\n</config>`, value },
    { text: `<dbPassword>${value}</dbPassword>`, value },
  ]);
  assert.deepEqual(
    rows.filter((row) => !flagged(row)).map((row) => row.text),
    [],
  );
});

// A one-word head before "#" with a one-word key after it reads as a password (welcome#pass1), as on 1.6.2.
test("a password with a secret word after # under a camelCase password setting is found", () => {
  const values = [
    "welcome" + "#pass1",
    "letmein" + "#pw22",
    "iloveyou" + "#Pass1",
    "summer" + "#key2024",
    "qwerty" + "#secret1",
  ];
  assert.deepEqual(missed(lineDownQuotedJson(values)), []);
});

// A Secret's name and key after "#" have a weak password's shape (dogs-rule#password1, welcome#pass_1), so they're
// found too, as on 1.6.2.
test("a Secret's name and key after # under a camelCase password setting are found, as on 1.6.2", () => {
  const values = [
    "db-" + "secret#password2",
    "mysql-" + "auth#root_password3",
    "pg-creds-" + "v2#adminPassword",
    "redis" + "#auth-token3",
    "mysql" + "#root_password3",
    "vault" + "#adminPassword2",
  ];
  assert.deepEqual(missed(lineDownQuotedJson(values)), []);
});

// The price of finding welcome#pass1: a one-word Secret name with a one-word key is flagged, as on 1.6.2.
test("a one-word Secret name with a one-word key after # under a camelCase password setting is found", () => {
  const values = ["postgres" + "#password2", "redis" + "#password1", "vault" + "#token2", "mongo" + "#pass3"];
  assert.deepEqual(missed(lineDownQuotedJson(values)), []);
});

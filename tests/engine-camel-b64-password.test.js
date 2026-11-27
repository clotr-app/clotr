// The base64 of a word-and-number password (welcome-1234, monkey.1234, letmein-cookie-1234) under a camelCase password
// setting is found, as on 1.6.2: in a Kubernetes Secret's data:, at a line's start and in JSON. That holds when the
// password has a word a stored name is made of too (root, db, admin, secret). Every value here is made up and built in
// parts.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");

const Clotr = globalThis.Clotr;
const b64 = (s) => Buffer.from(s).toString("base64");

const NAMES = ["dbPassword", "adminPassword", "rootPassword", "postgresPassword", "userPassword"];
const PASSWORDS = [
  "welcome" + "-" + "1234",
  "Welcome" + "-" + "1234",
  "sunshine" + "_" + "9876",
  "monkey" + "." + "1234",
  "letmein" + "-cookie-" + "1234",
  "qwerty" + "_" + "9876",
];

const secret = (name, value) =>
  ["apiVersion: v1", "kind: Secret", "metadata:", "  name: db", "type: Opaque", "data:", `  ${name}: ${value}`].join(
    "\n",
  );
const threeWays = (name, value) => [secret(name, value), `${name}: ${value}`, `{ "${name}": "${value}" }`];
const flagged = (text, value) => Clotr.detect(text).some((f) => (f.matches || []).some((m) => m.includes(value)));

test("the base64 of a word-and-number password under a camelCase password setting is found", () => {
  const missed = [];
  for (const name of NAMES) {
    for (const value of PASSWORDS.map(b64)) {
      for (const text of threeWays(name, value)) if (!flagged(text, value)) missed.push(text);
    }
  }
  assert.deepEqual(missed, []);
});

// Passwords that hold a store word (root, app, db, user, prod, admin, release) or a secret's word (pass, secret).
const STORE_WORD_PASSWORDS = [
  "user" + "_hockey_" + "5604",
  "root" + ".cookie" + "1",
  "jordan" + "_db_" + "518",
  "autumn" + ".secret." + "6848",
  "app" + "-tiger-" + "4410",
  "prod" + "_maple_" + "7731",
  "admin" + ".river" + "22",
  "release" + "-falcon-" + "903",
  "pass" + "_otter_" + "2650",
];

test("the base64 of a password holding a store word or a secret's word is found", () => {
  const missed = [];
  for (const name of [...NAMES, "masterPassword", "redisPassword", "mysqlRootPassword", "apiPassword"]) {
    for (const value of STORE_WORD_PASSWORDS.map(b64)) {
      for (const text of threeWays(name, value)) if (!flagged(text, value)) missed.push(text);
    }
  }
  assert.deepEqual(missed, []);
});

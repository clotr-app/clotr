"use strict";

// The counted-down and repeated-group checks are for a stand-in after a key's prefix. A password someone typed, the
// password in a connection string, a gift card's PIN and a JWT's base64 aren't a key's body, so they're still found
// when they count down or repeat a group. Every value here is made up.

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

const { detect } = globalThis.Clotr;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const HEAD = b64({ alg: "RS256", typ: "JWT", kid: "Zq8mT3vK0pW5nR2xY7cB4dF9gH1" });
const SIG = "Xq3vP9kL2mW8nR4tY7bC1dF6gH0jS5aZ3eU8iO2pQ9wE4rT7yU1iO6pA3sD8fG2hJ5kL0zX4cV9bN7mQ1wE3rT6y";
// Shaped like a Microsoft Graph access token: its audience is Graph's app id, whose zeros repeat in base64.
const GRAPH = `${HEAD}.${b64({ aud: "00000003-0000-0000-c000-000000000000", iat: 1731567000, scp: "User.Read" })}.${SIG}`;
// Twelve same characters in a row in the payload.
const ZEROS = `${HEAD}.${b64({ sub: "1000000000000000000001", iat: 1731567000 })}.${SIG}`;

const found = (text, id) => detect(text).find((r) => r.id === id)?.matches || [];

test("a Graph-shaped JWT is found, bare and after a bearer header", () => {
  assert.deepEqual(found(GRAPH, "jwt"), [GRAPH]);
  assert.deepEqual(found(`Authorization: Bearer ${GRAPH}`, "jwt"), [GRAPH]);
});

test("a JWT with twelve same characters in a row in its payload is found", () => {
  assert.deepEqual(found(ZEROS, "jwt"), [ZEROS]);
});

test("a typed password that repeats a word or counts down is found", () => {
  for (const pw of ["Winter44Winter44", "tiger87-tiger87-tiger87", "Ocean87654321"]) {
    assert.deepEqual(found(`password=${pw}`, "password"), [pw], pw);
  }
});

test("a connection string's password that counts down is found", () => {
  const url = "postgres://app:Qz87654321@db.internal.example:5432/app";
  assert.deepEqual(found(url, "connection_string"), [url]);
});

test("a gift card's PIN that counts down is found", () => {
  const text = "my Target gift card number is 7KQ2 PMXR 4RT8 W9ZL and the PIN is 87654321";
  assert.deepEqual(found(text, "gift_card"), ["7KQ2 PMXR 4RT8 W9ZL", "87654321"]);
});

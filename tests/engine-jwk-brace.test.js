// A quoted value that holds a brace ("kid": "{main}") isn't a nested object, so the JWK around it is still found.
// The key value is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const K = ["bWFkZVVwS2V5", "VmFsdWUxMjM0", "NTY3ODkw"].join("");

test("a JWK whose quoted value holds a brace is found", () => {
  const jwk = `{"kty":"oct","k":"${K}","kid":"{main}"}`;
  const ids = detect(jwk).map((result) => result.id);
  assert.ok(ids.includes("private_key"), ids.join(", ") || "quiet");
});

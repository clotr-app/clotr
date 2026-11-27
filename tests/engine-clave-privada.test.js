// A crypto private key after "clave privada" (Spanish) is read like one after "private key". The key is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const KEY = "0x" + "0123456789abcdef".repeat(4);

test("a private key after clave privada is found", () => {
  for (const text of [`Clave privada: ${KEY}`, `La clave privada es ${KEY}`]) {
    const ids = detect(text).map((result) => result.id);
    assert.ok(ids.includes("crypto_secret"), `${text.slice(0, 20)}: ${ids.join(", ") || "quiet"}`);
  }
});

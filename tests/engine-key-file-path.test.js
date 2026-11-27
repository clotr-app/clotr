// A key setting whose value is a file path ("apiKey: ./certs/server.pem") says where the key is kept, so it's quiet.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

test("a key file's path isn't read as a password", () => {
  for (const text of ["apiKey: ./certs/server.pem", "apiKey: config/service.json"]) {
    assert.deepEqual(
      detect(text).map((result) => result.id),
      [],
      text,
    );
  }
});

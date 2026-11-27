// Number words with two spaces or a spaced hyphen between them ("fifty  three", "fifty - three") read like
// "fifty-three", so the whole phone number is found, not just its start. The numbers are made up (415 555 …).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const phones = (text) =>
  detect(text)
    .filter((result) => result.id === "phone_number")
    .flatMap((result) => result.matches);

test("extra spaces or a spaced hyphen between number words keep the number whole", () => {
  for (const gap of [" ", "  ", " - ", "-"]) {
    const number = `four one five, five fifty${gap}three, twelve thirty four`;
    assert.deepEqual(phones(`call me at ${number}`), [number], JSON.stringify(gap));
  }
});

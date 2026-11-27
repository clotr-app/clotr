// A tag list or a sentence about backup codes, with plain words and at most one year, holds no codes. A list with a
// code, digits or letters, is still found. The codes are made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

const codes = (text) => detect(text).flatMap((result) => result.matches);

test("a tag list or a dated sentence about backup codes is quiet", () => {
  for (const text of [
    "Tags: backup codes, recovery codes, 2fa, tutorial",
    "Security checklist: backup codes, recovery codes, 2024 audit",
    "Keywords: 2fa codes; backup codes; 2015; guide",
    "backup codes and recovery codes are not working since 2024",
  ]) {
    assert.deepEqual(codes(text), [], text);
  }
});

test("a list with codes is still found", () => {
  for (const [text, list] of [
    ["backup codes es 2024 audit or backup codes are 4829 1736, 9052 8810", "4829 1736, 9052 8810"],
    ["recovery codes: bxqyrwta lmnvkcpe 2021", "bxqyrwta lmnvkcpe 2021"],
    ["recovery codes: kaxomute ribelona 2021", "kaxomute ribelona 2021"],
  ]) {
    assert.ok(codes(text).includes(list), `${text}: ${codes(text).join(" | ") || "quiet"}`);
  }
});

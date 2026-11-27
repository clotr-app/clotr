// Hide it covers a value's copy behind two layers of URL encoding (%2530 for "0"), not only the plain one. The SSN is
// a made-up test number.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

test("a copy behind a second layer of URL encoding is hidden too", () => {
  const twice = "%2530%2537%2538%252D%2530%2535%252D%2531%2531%2532%2530";
  const text = `SSN 078-05-1120 also written ${twice}`;
  const hidden = redact(text, detect(text));
  assert.doesNotMatch(hidden, /078-05-1120|%2530%2537/, hidden);
});

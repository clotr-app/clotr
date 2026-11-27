// The service-token growth tests from tests/engine-recall.test.js on a count of work (tests/work.js). The clock checks
// stay there too, since the provider rules are one regex and a count can't see backtracking inside one regex run.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertWorkLinear, onWorkClock } = require("./work.js");
const { MARKERS, contextUnits } = require("./service-token-units.js");
require("./load-engine.js")("rules", "detect");

const Clotr = globalThis.Clotr;
const serviceTokens = Clotr.PATTERNS.find((p) => p.id === "service_token").find;
// About n characters of the unit repeated.
const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length));

// The same letters and digits on every run, so a slow case stays slow.
let seed = 20261101;
const random = (set, n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += set[(seed = (seed * 1103515245 + 12345) % 2147483648) % set.length];
  return s;
};

test("a provider rule's marker repeated over and over makes linear work", () => {
  assertWorkLinear(serviceTokens, fill, MARKERS, 6000);
});

test("the context-checked provider rules make linear work", () => {
  assertWorkLinear(serviceTokens, fill, contextUnits(random), 6000);
});

test("a long run of a provider's marker does not hide a later token, and Cover it finishes", () => {
  const token = `ghp_${random("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 36)}`;
  const text = `${"pypi-AgENdGVzdC5weXBpLm9yZw".repeat(15171)}\nmy token is ${token}`;
  const heapBefore = process.memoryUsage().heapUsed;
  // On the stand-in clock, so only too much reading can cut the scan short, never a busy machine.
  const found = onWorkClock(() => Clotr.detect(text));
  assert.ok(!found.truncated, "the scan ran out of time");
  assert.ok(
    found.some((r) => r.id === "github_token" && r.matches.includes(token)),
    "the token after the run was missed",
  );
  const out = Clotr.redact(text, found);
  assert.ok(!out.includes(token.slice(4)), "Cover it left the token");
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 512 * 2 ** 20, "Cover it held on to too much memory");
});

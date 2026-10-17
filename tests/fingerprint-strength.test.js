// Covers the fix for F6: a stolen profile has the salt and every stored fingerprint, and a single fast SHA-256
// let it hash every candidate for a short value (a PIN, an SSN) and find a match. See docs/security/fingerprints.md
// for the design (why only some fingerprints got slower) and the measured costs this test's budget is based on.
// Run from the repo root:  node --test tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
const { bestOf } = require("./timing.js");

const { fingerprint, fingerprintStrong, fingerprintFor, sha256, normalize } = globalThis.Clotr;

// What both fingerprints computed before this fix, and what fingerprint() (scheme 1, the watch-list word scan's
// fast path) still computes today. Rebuilt here, not imported, so this test still proves the point if the real
// function changes underneath it.
const oldScheme = (salt, patternId, match) => sha256(salt + normalize(patternId, match)).slice(0, 16);

test("fingerprintStrong: a 4-digit PIN takes real time to brute force now, not an instant hash", () => {
  const salt = "s4ltsaltsaltsalt";
  // Warm up the JIT so the first few timed calls aren't paying a one-off compile cost.
  for (let i = 0; i < 50; i++) fingerprintStrong(salt, "card_code", String(i % 10000).padStart(4, "0"));
  let i = 0;
  const perCallMs = bestOf(() => fingerprintStrong(salt, "card_code", String(i++ % 10000).padStart(4, "0")), 3);
  const PIN_SPACE = 10000; // every 4-digit PIN
  const projectedSeconds = (perCallMs * PIN_SPACE) / 1000;
  // Measured on the PC this budget was set on: about 13 ms per call in Node (the runtime these tests run under),
  // so trying all 10,000 four-digit PINs, single-threaded, takes on the order of 130 seconds, against under a
  // millisecond with one plain SHA-256. 10 seconds is a wide margin below that measurement, so the check still
  // holds on a machine several times faster or slower than this one, while still proving brute force is no
  // longer the sub-second affair a single fast hash made it.
  assert.ok(
    projectedSeconds > 10,
    `projected ${projectedSeconds.toFixed(1)}s to try every 4-digit PIN (one call took ${perCallMs.toFixed(3)} ms); ` +
      `want well over 10s so a stolen profile can't exhaust the PIN space in a coffee break`,
  );
});

test("fingerprint: the watch-list word scan's own fingerprint stays a single, cheap round", () => {
  const salt = "s4ltsaltsaltsalt";
  for (let i = 0; i < 50; i++) fingerprint(salt, "watch_list", `word ${i}`);
  let i = 0;
  const perCallMs = bestOf(() => fingerprint(salt, "watch_list", `word ${i++}`), 3);
  // patterns.js checks this once per word-span combination while someone types, so it has to stay far below
  // fingerprintStrong's per-call cost. 2 ms is a wide margin above the sub-millisecond this actually measures at.
  assert.ok(perCallMs < 2, `fingerprint() now costs ${perCallMs.toFixed(3)} ms/call, too slow for a per-span scan`);
});

test("fingerprintStrong: still exactly 16 lowercase hex characters, so storage validation and dedupe don't change", () => {
  for (const [id, value] of [
    ["card_code", "4471"],
    ["us_ssn", "123-45-6789"],
    ["email", "bob@gmail.com"],
    ["phone_number", "555-555-5636"],
  ]) {
    const fp = fingerprintStrong("s4lt", id, value);
    assert.match(fp, /^[0-9a-f]{16}$/, `${id}: ${fp}`);
  }
});

test("fingerprintStrong: deterministic and salt/value sensitive, same as fingerprint", () => {
  const a = fingerprintStrong("salt-one", "email", "bob@gmail.com");
  assert.equal(fingerprintStrong("salt-one", "email", "bob@gmail.com"), a, "same input, same output");
  assert.notEqual(fingerprintStrong("salt-two", "email", "bob@gmail.com"), a, "a different salt changes it");
  assert.notEqual(fingerprintStrong("salt-one", "email", "rob@gmail.com"), a, "a different value changes it");
});

test("fingerprintStrong: a different scheme from fingerprint, so an old stored fingerprint can't be mistaken for a new one", () => {
  const salt = "an-existing-install-salt";
  const fast = fingerprint(salt, "card_code", "4471");
  const strong = fingerprintStrong(salt, "card_code", "4471");
  assert.equal(fast, oldScheme(salt, "card_code", "4471"), "fingerprint() itself must stay the original scheme");
  assert.notEqual(strong, fast, "fingerprintStrong() must not just be fingerprint() again");
});

test("fingerprintFor: picks the fingerprint a stored entry's own scheme was made with", () => {
  const salt = "an-existing-install-salt";
  const fast = fingerprint(salt, "email", "bob@gmail.com");
  const strong = fingerprintStrong(salt, "email", "bob@gmail.com");
  assert.equal(fingerprintFor(2, salt, "email", "bob@gmail.com"), strong);
  for (const scheme of [undefined, 1, "2", null]) {
    assert.equal(fingerprintFor(scheme, salt, "email", "bob@gmail.com"), fast, `scheme ${JSON.stringify(scheme)}`);
  }
});

test("migration: a vault or history entry fingerprinted before this change still passes storage validation", () => {
  const { cleanVaultEntry, cleanEvent, dedupeVault } = globalThis.Clotr;
  const salt = "an-existing-install-salt";
  const oldFp = fingerprint(salt, "card_code", "4471");
  const newFp = fingerprintStrong(salt, "card_code", "9999");

  // An old-scheme vault entry, made before the upgrade, is still well-formed: it keeps validating, keeps
  // displaying on the vault and storage pages, and is never dropped just for predating the stronger scheme. It
  // carries no `scheme` field, same as every entry made before this existed.
  const oldEntry = cleanVaultEntry({ kind: "value", type: "card_code", mode: "protect", fp: oldFp, added: 1 });
  assert.ok(oldEntry, "an old-scheme vault entry must still clean to a valid record");
  assert.equal(oldEntry.fp, oldFp);
  assert.equal(oldEntry.scheme, undefined, "an old-scheme entry carries no scheme field");

  // A freshly-saved entry keeps its scheme, so matching knows which fingerprint it was made with.
  const newEntry = cleanVaultEntry({
    kind: "value",
    type: "card_code",
    mode: "protect",
    fp: newFp,
    scheme: 2,
    added: 2,
  });
  assert.equal(newEntry.scheme, 2);

  // A history event fingerprinted before the upgrade is the same: still a valid record, untouched.
  const oldEvent = cleanEvent({
    t: 1,
    site: "chatgpt.com",
    type: "card_code",
    severity: "high",
    action: "redacted",
    fp: oldFp,
  });
  assert.ok(oldEvent, "an old-scheme history event must still clean to a valid record");
  assert.equal(oldEvent.fp, oldFp);
  assert.equal(oldEvent.scheme, undefined);

  const newEvent = cleanEvent({
    t: 2,
    site: "chatgpt.com",
    type: "card_code",
    severity: "high",
    action: "redacted",
    fp: newFp,
    scheme: 2,
  });
  assert.equal(newEvent.scheme, 2);

  // A vault holding both an old-scheme entry and a freshly-made new-scheme entry keeps both: dedupeVault only
  // merges entries that are actually identical, so predating the stronger scheme never looks like a duplicate.
  const deduped = dedupeVault([oldEntry, newEntry]);
  assert.equal(
    deduped.length,
    2,
    "an old-scheme entry and a new-scheme entry for a different value are not duplicates",
  );
});

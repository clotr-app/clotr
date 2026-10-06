// A held-back feature's own files never reach the shipped build. tools/package.js drops them from the zip,
// not just the manifest, whenever its flag in extension/manifest.json's clotr_features is off. Nothing is
// removed from the source tree, though: running npm run test:e2e:all-on turns every flag on and ships the
// same files unchanged.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { build, FEATURE_FILES } = require("../tools/package.js");

const HELD_BACK = Object.keys(FEATURE_FILES);

test("the shipped build drops every held-back feature's own files", () => {
  const { files, manifest } = build({ zip: false });
  for (const name of HELD_BACK)
    for (const f of FEATURE_FILES[name]) assert.ok(!files.includes(f), `${f} (${name}) shipped while held back`);
  assert.ok(!files.includes("practice-data.js"), "practice-data.js shipped with Practice and Office training both off");
  assert.ok(!manifest.content_scripts.some((c) => c.js.includes("commands.js")), "commands.js still a content script");
  assert.deepEqual(manifest.optional_permissions ?? [], []);
  assert.deepEqual(manifest.clotr_features, Object.fromEntries(HELD_BACK.map((k) => [k, false])));
});

test("an all-on build ships every held-back feature's files, unchanged from the shipped build's manifest otherwise", () => {
  const allOn = Object.fromEntries(HELD_BACK.map((k) => [k, true]));
  const { files, manifest } = build({ zip: false, features: allOn });
  for (const name of HELD_BACK)
    for (const f of FEATURE_FILES[name]) assert.ok(files.includes(f), `${f} (${name}) missing`);
  assert.ok(files.includes("practice-data.js"));
  assert.ok(manifest.content_scripts.some((c) => c.js.includes("commands.js")));
  assert.deepEqual(manifest.optional_permissions, ["management"]);
  assert.deepEqual(manifest.clotr_features, allOn);
});

test("turning on one held-back feature ships only its own files, not another's", () => {
  const { files } = build({ zip: false, features: { lookback: true } });
  for (const f of FEATURE_FILES.lookback) assert.ok(files.includes(f), `${f} missing with lookback on`);
  for (const name of HELD_BACK.filter((n) => n !== "lookback"))
    for (const f of FEATURE_FILES[name]) assert.ok(!files.includes(f), `${f} (${name}) shipped unasked`);
});

// A held-back feature's own files never reach the shipped build. tools/package.js drops them from the zip,
// not just the manifest, whenever its flag in extension/manifest.json's clotr_features is off. Nothing is
// removed from the source tree, though: running npm run test:e2e:all-on turns every flag on and ships the
// same files unchanged. Scam check, Command check, Tourniquet and Practice are on in this build; Look back,
// Extension check and Office training stay held back.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { build, FEATURE_FILES } = require("../tools/package.js");
const manifestOnDisk = require("../extension/manifest.json");

const HELD_BACK = Object.keys(FEATURE_FILES);
const STILL_OFF = HELD_BACK.filter((k) => !manifestOnDisk.clotr_features[k]);

test("the shipped build drops only the features still held back", () => {
  const { files, manifest } = build({ zip: false });
  for (const name of STILL_OFF)
    for (const f of FEATURE_FILES[name]) assert.ok(!files.includes(f), `${f} (${name}) shipped while held back`);
  for (const name of HELD_BACK.filter((k) => !STILL_OFF.includes(k)))
    for (const f of FEATURE_FILES[name]) assert.ok(files.includes(f), `${f} (${name}) missing though it's on`);
  const practiceOrTraining = manifestOnDisk.clotr_features.practice || manifestOnDisk.clotr_features.training;
  assert.equal(
    files.includes("practice-data.js"),
    Boolean(practiceOrTraining),
    "practice-data.js should ship exactly when Practice or Office training is on",
  );
  assert.equal(
    manifest.content_scripts.some((c) => c.js.includes("commands.js")),
    Boolean(manifestOnDisk.clotr_features.commandcheck),
    "commands.js as a content script should match Command check's flag",
  );
  assert.deepEqual(manifest.optional_permissions ?? [], manifestOnDisk.clotr_features.extcheck ? ["management"] : []);
  // A held-back feature's key is dropped from the shipped manifest, not set to false.
  assert.deepEqual(
    manifest.clotr_features,
    Object.fromEntries(Object.entries(manifestOnDisk.clotr_features).filter(([, on]) => on)),
  );
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
  // Every other flag off, so lookback is isolated regardless of what's on in the shipped manifest.
  const allOff = Object.fromEntries(HELD_BACK.map((k) => [k, false]));
  const { files } = build({ zip: false, features: { ...allOff, lookback: true } });
  for (const f of FEATURE_FILES.lookback) assert.ok(files.includes(f), `${f} missing with lookback on`);
  for (const name of HELD_BACK.filter((n) => n !== "lookback"))
    for (const f of FEATURE_FILES[name]) assert.ok(!files.includes(f), `${f} (${name}) shipped unasked`);
});

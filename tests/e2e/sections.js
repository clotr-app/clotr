// Finds the browser suite's sections by reading file names out of ./checks, so a new area can run without anyone
// editing a list in run.js. Sections run in number order and share one browser, so a later one can build on what an
// earlier one set up. The two sections that only do something with --stress or --store always run last.
"use strict";

const fs = require("fs");
const path = require("path");

const LAST = ["16-stress", "17-store-screenshots"];

// These sections exercise a held-back feature's own doors, and only make sense once every flag named here is on
// in the build under test (extension/manifest.json's clotr_features, read from whichever folder --ext points at).
// A feature that ships for real runs its section against the normal build; npm run test:e2e:all-on turns every
// flag on at once, so every section here runs there too.
const SECTION_FLAGS = {
  "21-tourniquet": ["tourniquet"],
  "23-command-check": ["commandcheck"],
  "24-scam-check": ["scamcheck"],
  "25-practice": ["practice"],
  "26-scam-shield": ["scamcheck", "commandcheck", "tourniquet", "practice"],
  "27-training": ["training"],
  "29-quick-exit": ["checkup"],
  "31-look-back": ["lookback"],
  "32-extension-check": ["extcheck"],
  "33-popup-doors": ["lookback", "extcheck"],
};
const FEATURE_ONLY = Object.keys(SECTION_FLAGS);

// The other side of the same coin: 30-feature-gates.js proves these doors stay hidden while their flags are off,
// so it only makes sense while every flag it names is off. An all-on build turns all of them on, which is exactly
// why that section isn't in the all-on run.
const SECTION_FLAGS_OFF = {
  "30-feature-gates": ["lookback", "extcheck", "training"],
};

// Sections that only register a check behind a CLI flag CI's plain `npm run test:e2e` never passes (--stress,
// --store, --website): in every CI run they load and return without calling check() at all. tests/e2e/shards.js
// leaves them out of every shard on purpose, since no shard assignment could make them run any checks in CI.
const FLAG_GATED = ["16-stress", "17-store-screenshots", "40-website-shots", "41-team-pack-shots"];

function sections(dir = path.join(__dirname, "checks"), features = {}) {
  const found = fs
    .readdirSync(dir)
    .filter((f) => /^\d+-[\w-]+\.js$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
  const picked = found.filter(
    (s) =>
      (SECTION_FLAGS[s] || []).every((flag) => features[flag]) &&
      (SECTION_FLAGS_OFF[s] || []).every((flag) => !features[flag]),
  );
  return [...picked.filter((s) => !LAST.includes(s)), ...LAST.filter((s) => picked.includes(s))];
}

module.exports = { sections, FEATURE_ONLY, SECTION_FLAGS, SECTION_FLAGS_OFF, FLAG_GATED };

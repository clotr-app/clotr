// How the browser suite's default-build sections split across CI's matrix (.github/workflows/test.yml and
// public/.github/workflows/test.yml), so the slowest shard takes about a third of the whole suite instead of all of
// it. Picked by summing seconds per section from a real run's tests/e2e/output/report.md: each shard below lands
// within a few seconds of the others. sections.js's FLAG_GATED sections (--stress, --store, --website) run no
// checks in CI either way, so none of them need a place here; one of them (40-website-shots) is also private, left
// out of the public export entirely. Tourniquet, Command check, "Is this a scam?" and Practice are on in this
// build, so their sections (and Scam shield, which needs all four) are default-build sections too, each placed in
// whichever shard has room. ../../tests/e2e-shards.test.js fails if any other default-build section is missing
// from every shard, or sits in more than one.
"use strict";

const SHARDS = {
  1: [
    "04-scope",
    "06-disguised-details",
    "11-report-and-map",
    "12-first-time-tips",
    "13-accessibility",
    "20-everyday-sites",
    "30-feature-gates",
    "25-practice",
    "42-search-support-sites",
    "35-clean-link",
    "43-everywhere",
  ],
  2: [
    "03-popup-dashboard",
    "07-responses",
    "08-vault",
    "09-updates",
    "10-privacy-health",
    "34-big-look",
    "26-scam-shield",
    "28-truncated-warning",
  ],
  3: [
    "01-protection",
    "02-toolbar",
    "05-chat-styles",
    "14-fail-open",
    "15-performance",
    "18-bandage",
    "19-report-button",
    "22-who-asks",
    "21-tourniquet",
    "23-command-check",
    "24-scam-check",
  ],
};

// The sections a shard runs. Throws on an unknown key, so a typo in CI's matrix fails the run loudly instead of
// quietly skipping the whole suite.
function sectionsForShard(key) {
  const names = SHARDS[key];
  if (!names) throw new Error(`unknown shard "${key}" (known: ${Object.keys(SHARDS).join(", ")})`);
  return names;
}

module.exports = { SHARDS, sectionsForShard };

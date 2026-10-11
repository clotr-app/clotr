// CI splits the browser suite across parallel shards (tests/e2e/shards.js, .github/workflows/test.yml). A section
// left out of every shard would quietly stop running in CI; one claimed by two would quietly run twice. Both are
// caught here, by check ID rather than by file name, so the failure names the exact checks a shard edit stranded.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { sections, FLAG_GATED } = require("./e2e/sections.js");
const { SHARDS } = require("./e2e/shards.js");

const CHECKS_DIR = path.join(__dirname, "e2e", "checks");
const MANIFEST_FEATURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"),
).clotr_features;

function checkIdsOf(section) {
  const txt = fs.readFileSync(path.join(CHECKS_DIR, `${section}.js`), "utf8");
  return [...txt.matchAll(/\bcheck\(\s*["'`]([^"'`]+)["'`]/g)].map((m) =>
    m[1].includes("${") ? m[1].split("${")[0] : m[1],
  );
}

test("e2e shards: every shard names a section this build actually runs", () => {
  const defaultSections = new Set(sections(CHECKS_DIR, MANIFEST_FEATURES));
  for (const [shard, names] of Object.entries(SHARDS)) {
    for (const name of names) {
      assert.ok(defaultSections.has(name), `shard ${shard} names ${name}, not a default-build section`);
      assert.ok(!FLAG_GATED.includes(name), `shard ${shard} names ${name}, which never runs a check in CI`);
    }
  }
});

test("e2e shards: every check in a default-build section is covered by exactly one shard", () => {
  const defaultSections = sections(CHECKS_DIR, MANIFEST_FEATURES).filter((s) => !FLAG_GATED.includes(s));
  const shardOf = new Map(); // section name -> the shard keys that claim it
  for (const [shard, names] of Object.entries(SHARDS))
    for (const name of names) shardOf.set(name, [...(shardOf.get(name) || []), shard]);

  for (const section of defaultSections) {
    const claimedBy = shardOf.get(section) || [];
    const ids = checkIdsOf(section);
    assert.equal(
      claimedBy.length,
      1,
      `${section}.js (checks: ${ids.join(", ") || "none"}) is in ${claimedBy.length} shards` +
        (claimedBy.length ? ` (${claimedBy.join(", ")})` : ""),
    );
  }
});

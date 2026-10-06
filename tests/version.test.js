// The manifest's version must never fall below the newest release in CHANGELOG.md. A packed build installed
// over a store release has to look like an update, not a downgrade: Chrome refuses to install a lower
// version, and an export built at a lower one would read as a step backward.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("the manifest version isn't below the newest released version in CHANGELOG.md", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  const changelog = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
  const released = [...changelog.matchAll(/^## (\d+\.\d+\.\d+) \(/gm)].map((m) => m[1]);
  assert.ok(released.length, "no released version found in CHANGELOG.md");
  const newest = released[0]; // sections are newest-first
  const base = (v) => v.split(".").slice(0, 3).map(Number);
  const [a, b] = [base(manifest.version), base(newest)];
  const cmp = a.map((n, i) => n - b[i]).find((d) => d !== 0) ?? 0;
  assert.ok(
    cmp >= 0,
    `manifest version ${manifest.version} is below ${newest}, the newest released version in CHANGELOG.md`,
  );
});

// Keep the rule-by-rule reference complete and version-matched to the shipped pattern table.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");

const ROOT = path.join(__dirname, "..");
const SPEC = path.join(ROOT, "docs", "engine", "rule-reference.md");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));

test("every engine rule has a versioned example, limit and severity rationale", () => {
  assert.ok(fs.existsSync(SPEC), "missing docs/engine/rule-reference.md");
  const text = fs.readFileSync(SPEC, "utf8");
  assert.match(text, new RegExp(`^Engine version: ${manifest.version.replaceAll(".", "\\.")}\\s*$`, "m"));
  assert.match(text, /^\| Kind \| What it detects \| Example \| Known limits \| Severity \| Why \|$/m);

  const rows = new Map(
    text
      .split(/\r?\n/)
      .filter((line) => /^\| `[^`]+` \|/.test(line))
      .map((line) => {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        return [cells[0]?.replaceAll("`", ""), cells];
      }),
  );
  assert.deepEqual(
    [...rows.keys()].sort(),
    globalThis.Clotr.PATTERNS.map((rule) => rule.id).sort(),
    "the reference has exactly the built-in rule ids",
  );
  for (const rule of globalThis.Clotr.PATTERNS) {
    const cells = rows.get(rule.id);
    assert.ok(cells, `no rule-reference row for ${rule.id}`);
    assert.equal(cells.length, 6, `${rule.id} must have six documented fields`);
    for (const index of [1, 2, 3, 5]) {
      const field = cells[index];
      assert.ok(field.length > 12 && !/\b(?:tbd|todo|n\/a)\b/i.test(field), `${rule.id} field ${index} is incomplete`);
    }
    assert.equal(cells[4], rule.severity, `${rule.id} severity must match PATTERNS`);
  }
});

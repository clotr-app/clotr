"use strict";
/* global require, __dirname */

// Only the public repository publishes the engine: its workflow lives in public/.github/workflows here and in
// .github/workflows there. It has the same locks as Guard's publish.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("the engine's npm publish runs only by hand, from an engine tag, and publishes with provenance", () => {
  const overlay = path.join(ROOT, "public", ".github", "workflows");
  const wfDir = fs.existsSync(overlay) ? overlay : path.join(ROOT, ".github", "workflows");
  const wf = fs.readFileSync(path.join(wfDir, "publish-engine.yml"), "utf8");
  const triggers = /^on:\n((?:[ ]+.*\n)+)/m.exec(wf)?.[1];
  assert.equal(triggers, "  workflow_dispatch:\n");
  assert.match(wf, /^permissions:\s*\n\s+contents: read/m);
  for (const [, use] of wf.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(use, /@[0-9a-f]{40}$/);
  assert.match(wf, /persist-credentials: false/);
  const idTokens = [...wf.matchAll(/^(\s*)id-token: write/gm)];
  assert.equal(idTokens.length, 1);
  assert.ok(idTokens[0][1].length >= 6, "only the publish job gets an ID token");
  assert.match(wf, /refs\/tags\/engine-v\*\)/);
  assert.doesNotMatch(wf, /refs\/tags\/v\*/);
  assert.match(wf, /^\s+environment:\n\s+name: npm\n/m);
  // The engine's package stays private in the source. This run tests it that way, takes the flag off, then publishes
  // its own copy without running those scripts again.
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "engine", "package.json"), "utf8")).private, true);
  const order = [
    "run: npm test",
    "run: npm pack --dry-run",
    "run: npm pkg delete private",
    "npm publish --provenance --access public --ignore-scripts",
  ].map((step) => wf.indexOf(step));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    `steps out of order: ${order}`,
  );
});

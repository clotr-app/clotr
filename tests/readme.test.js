// README badges (A4, the "what's inside" proof): the Tests badge must point at a workflow file
// that actually exists, and the "no AI inside" badge must point at the rule check that enforces it.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

// Only the top of the file: badges live right under the title.
const HEAD = README.split("\n").slice(0, 10).join("\n");

test("README has a Tests badge linking to a workflow file that exists", () => {
  const m = HEAD.match(/\[!\[Tests\]\(([^)]+)\)\]\(([^)]+)\)/);
  assert.ok(m, "no Tests badge found near the top of README.md");
  const [, badge, link] = m;
  assert.match(badge, /actions\/workflows\/([\w.-]+)\/badge\.svg/, "Tests badge doesn't point at a workflow badge");
  const workflow = badge.match(/actions\/workflows\/([\w.-]+)\/badge\.svg/)[1];
  assert.ok(
    fs.existsSync(path.join(ROOT, ".github", "workflows", workflow)),
    `README's Tests badge names a workflow file that doesn't exist: ${workflow}`,
  );
  assert.match(
    link,
    new RegExp(`actions/workflows/${workflow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "Tests badge doesn't link to that workflow's runs",
  );
});

test('README has a "no AI inside" badge linking to the rule check', () => {
  assert.match(HEAD, /no%20AI%20inside/i, 'no "no AI inside" badge found near the top of README.md');
  assert.match(HEAD, /tests\/rules\.test\.js/, 'the "no AI inside" badge doesn\'t link to tests/rules.test.js');
});

// The text outside HTML comments, cut by position rather than a replace pattern (a link only inside a comment, like
// the old "once Mozilla approves" placeholder, must not count as live).
function outsideComments(s) {
  let out = "";
  let i = 0;
  for (;;) {
    const open = s.indexOf("<!--", i);
    if (open < 0) return out + s.slice(i);
    out += s.slice(i, open);
    const close = s.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
}

test("README's Install section links to all three stores, none of them a placeholder", () => {
  const live = outsideComments(README);
  const stores = [
    ["Chrome", /https:\/\/chromewebstore\.google\.com\/detail\/[\w-]+/],
    ["Microsoft Edge", /https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\/[\w-]+/],
    ["Firefox", /https:\/\/addons\.mozilla\.org\/firefox\/addon\/[\w-]+\//],
  ];
  for (const [name, re] of stores) assert.match(live, re, `README has no live ${name} store link`);
  assert.doesNotMatch(README, /REPLACE-WITH|is on its way to/i, "README still has a placeholder store link");
});

test("README has a Scorecard badge whose workflow ships in the export", () => {
  const m = HEAD.match(/\[!\[OpenSSF Scorecard\]\(([^)]+)\)\]\(([^)]+)\)/);
  assert.ok(m, "no Scorecard badge found near the top of README.md");
  const [, badge, link] = m;
  assert.match(
    badge,
    /^https:\/\/api\.scorecard\.dev\/projects\/github\.com\/clotr-app\/clotr\/badge$/,
    "Scorecard badge should point at the public repo (clotr-app/clotr)",
  );
  assert.match(
    link,
    /^https:\/\/scorecard\.dev\/viewer\/\?uri=github\.com\/clotr-app\/clotr$/,
    "Scorecard badge should link to the viewer for clotr-app/clotr",
  );
  assert.ok(
    fs.existsSync(path.join(ROOT, ".github", "workflows", "scorecard.yml")),
    "README shows the Scorecard badge but .github/workflows/scorecard.yml doesn't exist, so the public export's launch check would refuse it",
  );
});

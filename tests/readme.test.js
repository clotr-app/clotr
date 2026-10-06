// README badges: the Tests badge must point at a workflow file that actually exists, and the License badge
// must point at the actual license file.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

// Only looks at the top of the file, since badges live right under the title.
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

test("README has a License badge linking to LICENSE", () => {
  assert.match(HEAD, /license-AGPL/i, "no License badge found near the top of README.md");
  assert.match(HEAD, /\]\(LICENSE\)/, "the License badge doesn't link to LICENSE");
});

test('README has no "no AI inside" slogan badge (the claim is made once, in the text, not as a badge)', () => {
  assert.doesNotMatch(HEAD, /no%20AI%20inside/i, 'README still has the "no AI inside" badge');
});

// Returns the text outside HTML comments, cut by position rather than a replace pattern. A link that only
// appears inside a comment, like the old "once Mozilla approves" placeholder, must not count as live.
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

test("README's Install section links to the stores that are live, and is honest about Chrome", () => {
  const live = outsideComments(README);
  const stores = [
    ["Microsoft Edge", /https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\/[\w-]+/],
    ["Firefox", /https:\/\/addons\.mozilla\.org\/firefox\/addon\/[\w-]+\//],
  ];
  for (const [name, re] of stores) assert.match(live, re, `README has no live ${name} store link`);
  assert.match(live, /Chrome Web Store/, "README doesn't mention the Chrome Web Store");
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

// The JetBrains plugin icons carry the app mark unchanged and the family's one corner disc from tools/make-icons.js.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { APP_MARK, DISC, JETBRAINS_ICONS, jetbrainsIconSvg } = require("../tools/make-icons.js");
const { PLASTER_COLORS, STEEL } = require("../tools/brand");

const inner = (svg) =>
  svg
    .trim()
    .replace(/^<svg [^>]*>/, "")
    .replace(/<\/svg>$/, "");

// The app mark lives in apps/desktop, which a public export without Windows' source leaves out, so the checks that
// need it skip there, as tests/brand-drift.test.js does.
const hasAppMark = fs.existsSync(APP_MARK);

for (const file of JETBRAINS_ICONS) {
  const name = path.basename(file);
  const svg = fs.readFileSync(file, "utf8");

  test(`${name} carries the app mark unchanged`, (t) => {
    if (!hasAppMark) {
      t.skip("this checkout has no apps folder");
      return;
    }
    const nested = svg.match(/<svg x="0" y="0" width="128" height="128" viewBox="0 0 128 128">(.*?)<\/svg>/);
    assert.ok(nested, `${name} has no nested app mark`);
    assert.strictEqual(nested[1], inner(fs.readFileSync(APP_MARK, "utf8")), `${name}'s mark differs from the app mark`);
  });

  test(`${name} has the one corner disc and is what make-icons.js draws`, () => {
    const circles = [...svg.matchAll(/<circle [^>]*>/g)].map((m) => m[0]);
    assert.strictEqual(circles.length, 1, `${name} should have exactly one disc`);
    const attr = (k) => circles[0].match(new RegExp(`\\b${k}="([^"]+)"`))[1];
    assert.deepStrictEqual(
      { cx: Number(attr("cx")), cy: Number(attr("cy")), r: Number(attr("r")), stroke: Number(attr("stroke-width")) },
      DISC,
    );
    assert.strictEqual(attr("fill"), STEEL);
    assert.strictEqual(attr("stroke"), PLASTER_COLORS.key);
    if (hasAppMark) assert.strictEqual(svg, jetbrainsIconSvg(), `${name} is stale: re-run npm run icons`);
  });
}

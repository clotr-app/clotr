// A held-back feature's markup is cut out of every packaged page (tools/package.js's stripFeatureMarkup), but the
// browser checks load extension/ as it is, so an unguarded `$("id").something` on a cut element only breaks the real
// build. The popup's quick-exit button did exactly that: the whole popup stayed blank, and only the Firefox suite,
// which installs the packaged zip, noticed. This runs in `npm test`: for each page, every element the package drops
// is only ever reached through a guard in the scripts that page still loads.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { stripFeatureMarkup } = require("../tools/package.js");

const EXT = path.join(__dirname, "..", "extension");
const features = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).clotr_features || {};
const idsIn = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const scriptsIn = (html) =>
  [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((src) => !/^[a-z]+:/i.test(src));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Guarded means: `$("id")?.`, the lookup as an if's own condition, inside the block of an `if ($("id"))` /
// `if (document.getElementById("id"))` a few lines up, or on a line that first checks the very feature whose markup
// it is (`if (FEATURES.lookback) $("lb-offer")...`), since the element is only ever cut when that feature is off.
function unguarded(source, id, feature) {
  const lookup = new RegExp(`(?:\\$|document\\.getElementById)\\(\\s*["']${escape(id)}["']\\s*\\)`, "g");
  const guard = new RegExp(`if\\s*\\(\\s*!?\\s*(?:\\$|document\\.getElementById)\\(\\s*["']${escape(id)}["']\\s*\\)`);
  const bad = [];
  for (const m of source.matchAll(lookup)) {
    const after = source.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (after.startsWith("?.")) continue;
    if (/if\s*\(\s*!?\s*$/.test(source.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (guard.test(source.slice(Math.max(0, m.index - 600), m.index))) continue;
    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    if (new RegExp(`if\\s*\\(\\s*FEATURES\\.${feature}\\b`).test(source.slice(lineStart, m.index))) continue;
    bad.push(source.slice(0, m.index).split("\n").length);
  }
  return bad;
}

for (const page of fs.readdirSync(EXT).filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(EXT, page), "utf8");
  if (!/data-feature="/.test(html)) continue;
  const packaged = stripFeatureMarkup(html, features);
  const kept = idsIn(packaged);
  // Which held-back feature cuts each dropped id: strip one off feature at a time.
  const all = idsIn(stripFeatureMarkup(html, {}));
  const dropped = new Map();
  for (const [name, on] of Object.entries(features)) {
    if (on) continue;
    const left = idsIn(stripFeatureMarkup(html, { [name]: false }));
    for (const id of all) if (!left.has(id) && !kept.has(id) && !dropped.has(id)) dropped.set(id, name);
  }
  if (!dropped.size) continue;
  test(`${page}: every element the packaged build drops is reached only through a guard`, () => {
    const problems = [];
    for (const src of scriptsIn(packaged)) {
      const file = path.join(EXT, src);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const [id, feature] of dropped) {
        for (const line of unguarded(source, id, feature)) problems.push(`${src}:${line} reaches #${id} unguarded`);
      }
    }
    assert.deepEqual(problems, [], "a held-back element the package removes would throw in the real build");
  });
}

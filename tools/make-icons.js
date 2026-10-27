// Generates the extension's PNG icons from the bandage in tools/brand.js: `npm run icons`
//   icon-on    the bandage, plum pad: protecting this site
//   icon-off   the same bandage, pad greyed: default / not active on this site
//   icon-spot  the on bandage plus the spotted dot: "this page looks like an AI chat"
// The 128 px on icon is copied to apps/vscode/icon.png for the VS Code Marketplace.
// It also records a fingerprint of the drawings it rendered in tools/icons-source.sha256, so a test can tell the
// icons are current without redrawing them, since each browser smooths a small icon a little differently.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ROOT, plaster, renderPng } = require("./brand");

const OUT = path.join(ROOT, "extension", "icons");
const SIZES = [16, 32, 48, 128];
const STATES = ["on", "off", "spot"];
const FINGERPRINT = path.join(ROOT, "tools", "icons-source.sha256");
const VSCODE_ICON = path.join(ROOT, "apps", "vscode", "icon.png");

// A drawing's ids count up across every drawing made in one run, so they're renumbered from 0 in each one first:
// the same drawing then always reads the same.
function steadyIds(svg) {
  const ids = [...new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  return ids.reduce((s, id, i) => s.split(`"${id}"`).join(`"id${i}"`).split(`#${id})`).join(`#id${i})`), svg);
}

// One SHA-256 over every drawing, in a fixed order.
function iconsSourceHash() {
  const hash = crypto.createHash("sha256");
  for (const state of STATES) {
    for (const size of SIZES) hash.update(`${state}-${size}\n${steadyIds(plaster(state, { size }))}\n`);
  }
  return hash.digest("hex");
}

if (require.main === module) {
  const jobs = [];
  for (const state of STATES) {
    for (const size of SIZES) {
      jobs.push({
        file: path.join(OUT, `icon-${state}-${size}.png`),
        svg: plaster(state, { size }),
        w: size,
        h: size,
        transparent: true,
      });
    }
  }
  renderPng(jobs)
    .then(() => {
      fs.writeFileSync(FINGERPRINT, `${iconsSourceHash()}\n`);
      // The VS Code Marketplace shows a 128 px icon, the same one the browser stores show.
      fs.copyFileSync(path.join(OUT, "icon-on-128.png"), VSCODE_ICON);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { iconsSourceHash, FINGERPRINT };

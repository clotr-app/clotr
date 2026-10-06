// Generates the extension's PNG icons from the bandage in tools/brand.js: `npm run icons`
//   icon-on    the bandage, plum pad: protecting this site
//   icon-off   the same bandage, pad greyed: default / not active on this site
//   icon-spot  the on bandage plus the spotted dot: "this page looks like an AI chat"
"use strict";

const path = require("path");
const { ROOT, plaster, renderPng } = require("./brand");

const OUT = path.join(ROOT, "extension", "icons");
const SIZES = [16, 32, 48, 128];

const jobs = [];
for (const state of ["on", "off", "spot"]) {
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

renderPng(jobs).catch((e) => {
  console.error(e);
  process.exit(1);
});

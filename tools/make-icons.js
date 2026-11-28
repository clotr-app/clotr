// Generates the extension's PNG icons from the bandage in tools/brand.js: `npm run icons`
//   icon-on    the bandage, plum pad: protecting this site
//   icon-off   the same bandage, pad greyed: default / not active on this site
//   icon-spot  the on bandage plus the spotted dot: "this page looks like an AI chat"
// apps/vscode/icon.png is the on mark with the family's corner mark on it: a steel disc with the product's glyph.
// The JetBrains plugin's pluginIcon.svg and pluginIcon_dark.svg are the app mark with the same disc and its own glyph.
// It also records a fingerprint of the drawings it rendered in tools/icons-source.sha256, so a test can tell the
// icons are current without redrawing them, since each browser smooths a small icon a little differently.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ROOT, PLASTER_COLORS, STEEL, plaster, renderPng } = require("./brand");

const OUT = path.join(ROOT, "extension", "icons");
const SIZES = [16, 32, 48, 128];
const STATES = ["on", "off", "spot"];
const FINGERPRINT = path.join(ROOT, "tools", "icons-source.sha256");
const VSCODE_ICON = path.join(ROOT, "apps", "vscode", "icon.png");
const APP_MARK = path.join(ROOT, "apps", "desktop", "icon-source", "clotr-app-icon.svg");
const JETBRAINS_META = path.join(ROOT, "apps", "jetbrains", "src", "main", "resources", "META-INF");
const JETBRAINS_ICONS = ["pluginIcon.svg", "pluginIcon_dark.svg"].map((f) => path.join(JETBRAINS_META, f));

// Every product icon in the family shares one corner mark: this steel disc at the bottom right, on the 128 grid,
// with an ink outline. Only the glyph inside it changes from product to product.
const DISC = { cx: 100, cy: 100, r: 23, stroke: 3.5 };

// Below this size no corner mark reads, so a product icon is the plain Clotr mark there.
const CORNER_MIN_SIZE = 24;

// The Windows glyph's outline: a screen with round corners, then its stand and foot.
const WINDOWS_OUTLINE = {
  d: "M89 86 H111 Q113 86 113 88 V101 Q113 103 111 103 H89 Q87 103 87 101 V88 Q87 86 89 86 Z M100 103 V111 M93 112 H107",
};

// Each product's glyph, drawn in ink on the 128 grid inside the disc.
const GLYPHS = {
  // Two brackets, < >, for code.
  vscode:
    `<path d="M95 89 L85 100 L95 111 M105 89 L115 100 L105 111" fill="none" stroke="${PLASTER_COLORS.key}" ` +
    `stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
  // A solid ink globe with a steel equator and meridian cut into it, for the browser extension.
  extension:
    `<circle cx="100" cy="100" r="15" fill="${PLASTER_COLORS.key}"/>` +
    `<path d="M86.5 100 H113.5" fill="none" stroke="${STEEL}" stroke-width="2.5" stroke-linecap="round" ` +
    `stroke-linejoin="round"/>` +
    `<ellipse cx="100" cy="100" rx="6" ry="13.5" fill="none" stroke="${STEEL}" stroke-width="2.5"/>`,
  // A monitor on a stand, as an ink outline, for Windows.
  windows:
    `<path d="${WINDOWS_OUTLINE.d}" fill="none" stroke="${PLASTER_COLORS.key}" stroke-width="5" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>`,
  // A phone outline with a button dot, for Android.
  android:
    `<rect x="91" y="85" width="18" height="30" rx="4" fill="none" stroke="${PLASTER_COLORS.key}" stroke-width="5"/>` +
    `<circle cx="100" cy="108.5" r="2.2" fill="${PLASTER_COLORS.key}"/>`,
  // An IDE window: an outline, a filled title bar and a side panel.
  jetbrains:
    `<rect x="87" y="89" width="26" height="22" rx="3" fill="none" stroke="${PLASTER_COLORS.key}" stroke-width="3"/>` +
    `<path d="M87 95V92a3 3 0 0 1 3-3h20a3 3 0 0 1 3 3v3z" fill="${PLASTER_COLORS.key}"/>` +
    `<path d="M95 95v16" stroke="${PLASTER_COLORS.key}" stroke-width="3"/>`,
};

// The disc with a glyph inside, as SVG on the 128 grid.
function cornerDisc(glyph) {
  const { cx, cy, r, stroke } = DISC;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${STEEL}" stroke="${PLASTER_COLORS.key}" stroke-width="${stroke}"/>` +
    glyph
  );
}

// A product's icon at any size: the on mark with the disc and glyph, or the plain mark below CORNER_MIN_SIZE.
function productIcon(glyph, size = 128) {
  const svg = plaster("on", { size });
  if (size < CORNER_MIN_SIZE) return svg;
  return svg.replace(/<\/svg>$/, `<g transform="scale(${size / 128})">${cornerDisc(glyph)}</g></svg>`);
}

// The job that draws apps/vscode/icon.png. The Marketplace takes one 128 px file.
function vscodeIconJob(file = VSCODE_ICON) {
  return { file, svg: productIcon(GLYPHS.vscode, 128), w: 128, h: 128, transparent: true };
}

// The JetBrains plugin icon: the app mark at 40 px with the disc. The IDE takes an SVG, so one file serves the
// list at 40 px and the plugin page at 80 px, and both themes get the same drawing since the disc reads on either.
function jetbrainsIconSvg() {
  const mark = fs
    .readFileSync(APP_MARK, "utf8")
    .trim()
    .replace(/^<svg [^>]*>/, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 128 128"><title>Clotr</title>` +
    `<svg x="0" y="0" width="128" height="128" viewBox="0 0 128 128">${mark}` +
    `${cornerDisc(GLYPHS.jetbrains)}</svg>\n`
  );
}

function writeJetbrainsIcons() {
  for (const file of JETBRAINS_ICONS) fs.writeFileSync(file, jetbrainsIconSvg());
}

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
  jobs.push(vscodeIconJob());
  writeJetbrainsIcons();
  renderPng(jobs)
    .then(() => fs.writeFileSync(FINGERPRINT, `${iconsSourceHash()}\n`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  iconsSourceHash,
  FINGERPRINT,
  CORNER_MIN_SIZE,
  DISC,
  GLYPHS,
  cornerDisc,
  productIcon,
  vscodeIconJob,
  VSCODE_ICON,
  APP_MARK,
  JETBRAINS_ICONS,
  jetbrainsIconSvg,
  writeJetbrainsIcons,
};

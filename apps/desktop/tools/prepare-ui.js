// The web view's files that come from elsewhere, written into ui/dist/ (ignored by git, never edited by hand):
// - clotr-engine.js: Clotr's engine bundle (tools/engine-bundle.js --scans: the extension's detection, decisions,
//   words and move-file cleaning, with ClotrHost, plus Look back's and Extension check's shared readers),
//   byte for byte. The scan worker loads it alone: attachments.js, pictures.js, zip.js and
//   lookback-core.js all ride along in it now, so they aren't copied separately below.
// - warning-ui.js and ui-styles.js: the browser's own warning, unchanged, which the card reuses;
// - app-words.js: the words only the apps use (apps/locales/*.json) as ClotrAppWords;
// - ai-sites.js: Extension check's AI site list (extension/ai-sites.json) as ClotrAiSites, so results.js never
//   needs fetch() for its own bundled data;
// - kit/: the suite's look (the tokens, the parts and Atkinson Hyperlegible with its SIL OFL licence),
//   which the main window wears, byte for byte.
// A file is written only when it changed, so a build that runs this (build.rs) doesn't start the next build again.
// Usage: node tools/prepare-ui.js
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(__dirname, "..", "ui", "dist");
const { build } = require(path.join(ROOT, "tools", "engine-bundle.js"));

function words() {
  const dir = path.join(ROOT, "apps", "locales");
  const all = {};
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => /^[a-z]{2}\.json$/.test(n))
    .sort()) {
    const list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const [k, v] of Object.entries(list)) {
      if (typeof v !== "string") throw new Error(`${f}: ${k} must be a string`);
    }
    all[f.slice(0, 2)] = list;
  }
  return `// Written by apps/desktop/tools/prepare-ui.js from apps/locales/*.json; never edit or commit this file.\nglobalThis.ClotrAppWords = ${JSON.stringify(all, null, 1)};\n`;
}

// Extension check's AI site list: a classic-script copy of extension/ai-sites.json, the same
// way app-words.js carries the locale files in, so the page never needs `fetch()` for its own bundled data (the
// network rule bans the call outright, not just a remote address).
function aiSites() {
  const data = fs.readFileSync(path.join(ROOT, "extension", "ai-sites.json"), "utf8");
  JSON.parse(data); // a broken file stops the build, not the app
  return `// Written by apps/desktop/tools/prepare-ui.js from extension/ai-sites.json; never edit or commit this file.\nglobalThis.ClotrAiSites = ${data};\n`;
}

function desktopFeatures(env = process.env) {
  const features = {
    oneClotr:
      env.CLOTR_ONE_CLOTR_ENABLED === "true" ||
      (env.CLOTR_ONE_CLOTR_ENABLED === undefined && env.CARGO_FEATURE_ONE_CLOTR === "1"),
    scanTimes:
      env.CLOTR_SCAN_TIMES_ENABLED === "true" ||
      (env.CLOTR_SCAN_TIMES_ENABLED === undefined && env.CARGO_FEATURE_SCAN_TIMES === "1"),
  };
  return `// Written by apps/desktop/tools/prepare-ui.js from Cargo features; never edit or commit this file.\nglobalThis.ClotrDesktopFeatures = Object.freeze(${JSON.stringify(features)});\n`;
}

// The suite kit's files the pages use (design/suite/README.md has the rest).
const KIT = [
  "tokens.css",
  "components.css",
  "fonts/Recursive-var-normal.woff2",
  "fonts/OFL-Recursive.txt",
  "fonts/atkinson-hyperlegible-400.woff2",
  "fonts/atkinson-hyperlegible-700.woff2",
  "fonts/OFL.txt",
];

function files(env = process.env) {
  const copy = (name) => fs.readFileSync(path.join(ROOT, "extension", name));
  const kit = (name) => fs.readFileSync(path.join(ROOT, "design", "suite", name));
  return {
    "clotr-engine.js": Buffer.from(build({ scans: true }).text),
    "desktop-features.js": Buffer.from(desktopFeatures(env)),
    "warning-ui.js": copy("warning-ui.js"),
    "ui-styles.js": copy("ui-styles.js"),
    "ai-sites.js": Buffer.from(aiSites()),
    "app-words.js": Buffer.from(words()),
    ...Object.fromEntries(KIT.map((name) => [`kit/${name}`, kit(name)])),
  };
}

// Every file under `dir`, as "a/b.css".
function listed(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listed(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

function prepare(out = OUT) {
  fs.mkdirSync(out, { recursive: true });
  const want = files();
  const written = [];
  for (const [name, bytes] of Object.entries(want)) {
    const file = path.join(out, name);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    written.push(name);
  }
  // Nothing else: the app is built from this folder, so a file an older version wrote doesn't ride along.
  for (const name of listed(out)) if (!Object.hasOwn(want, name)) fs.rmSync(path.join(out, name));
  for (const e of fs.readdirSync(out, { withFileTypes: true })) {
    if (e.isDirectory() && !listed(path.join(out, e.name)).length) {
      fs.rmSync(path.join(out, e.name), { recursive: true });
    }
  }
  return written;
}

module.exports = { prepare, files, desktopFeatures };

if (require.main === module) {
  const written = prepare();
  console.log(written.length ? `ui/dist: ${written.join(", ")}` : "ui/dist: up to date");
}

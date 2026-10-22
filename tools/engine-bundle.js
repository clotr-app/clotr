// The engine bundle: one plain JavaScript file that every app outside the browser loads (the keyboards' JavaScript
// sandboxes, the desktop's web view), so the apps find exactly what the extension finds and decide and say the same.
// It is the extension's own files, byte for byte, in the content scripts' order, between what a bare engine lacks
// (apps/engine/host-shim.js) and the app's way in (apps/engine/host.js, ClotrHost); no page, no browser call.
// A header names the Clotr version and each part's SHA-256. Each app's build writes it; it is never edited by hand
// or committed (dist/ is ignored). A bundle written here that falls behind the files fails npm test
// (tests/engine-host.test.js), naming this command.
// Usage: node tools/engine-bundle.js               → apps/engine/dist/clotr-engine.js, and Clotr for Windows'
//                                                    pages folder brought up to date when there is one
//        node tools/engine-bundle.js --out <file>  e.g. into an app's build folder (that file only)
//        node tools/engine-bundle.js --scans [--out <file>]  the same, plus Look back's and Extension check's
//                                                    shared readers (SCAN_PARTS below), the shape Clotr for
//                                                    Windows loads; no other app needs them, so the plain bundle
//                                                    never carries them. apps/desktop/tools/prepare-ui.js always
//                                                    asks for this.
//        node tools/engine-bundle.js --scans --results --out <file>  the scans bundle plus Results' grouping
//                                                    (RESULTS_PARTS below: the apps' own words and
//                                                    apps/desktop/ui/findings.js), for Clotr for Android's Check my
//                                                    files, which groups Results with the Windows app's own code.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "apps", "engine", "dist", "clotr-engine.js");
const MARK = "//#part ";

// Look back's and Extension check's shared readers and words, Tourniquet's own rules, and "Is this a
// scam?"'s own signs: the extension's own files, so Clotr for Windows finds the same export shapes, the
// same "can read your AI chats" answer, the same presets a stronger setting for someone it helps turns on, and the
// same warning signs with no second copy of any of their rules. The readers come in the order they depend on each
// other; Tourniquet and scam-signs.js after them, since nothing else here depends on either.
const SCAN_PARTS = [
  "extension/scan-words.js",
  "extension/zip.js",
  "extension/csv.js",
  "extension/lookback-core.js",
  "extension/letter.js",
  "extension/extcheck-core.js",
  "extension/reported-extensions.js",
  "extension/attachments.js",
  "extension/pictures.js",
  "extension/insights.js",
  "extension/sites.js",
  "extension/scam-signs.js",
];

// Results' grouping and its words, after everything else: the apps' own words (apps/locales, each language as
// ClotrAppWords.<lang>), then findings.js, the Windows app's own grouping, plan.js, its "What to do first",
// file-kinds.js, what a file even is, guided.js, the Guided walk's cards, and results-note.js, the note for your
// helper, so a phone and a PC never disagree on what needs a look, what to do about it or what the note says. Only
// Clotr for Android asks for these (the Windows app loads them as pages of its own).
function resultsParts() {
  const words = fs
    .readdirSync(path.join(ROOT, "apps", "locales"))
    .filter((f) => /^[a-z]{2}\.json$/.test(f))
    .sort()
    .map((f) => `apps/locales/${f}`);
  return [
    ...words,
    "apps/desktop/ui/findings.js",
    "apps/desktop/ui/plan.js",
    "apps/desktop/ui/file-kinds.js",
    "apps/desktop/ui/guided.js",
    "apps/desktop/ui/results-note.js",
  ];
}

// What a bare engine lacks, the words (every language but English, which is written in the code), the detection
// pair, the decisions, the move file's cleaning, and ClotrHost. The order is the order they load in.
// `{ scans: true }` adds SCAN_PARTS after them (see the usage note above), and `{ results: true }` the results
// parts after those.
function parts(opts = {}) {
  const locales = fs
    .readdirSync(path.join(ROOT, "extension", "_locales"))
    .filter((l) => l !== "en" && /^[a-z]{2,3}(_[A-Z]{2})?$/.test(l))
    .sort();
  const base = [
    "apps/engine/host-shim.js",
    ...locales.map((l) => `extension/_locales/${l}/messages.json`),
    "extension/patterns.js",
    "extension/detector.js",
    "extension/decide.js",
    "extension/backup.js",
    "extension/commands.js",
    "extension/ask-someone.js",
    "apps/engine/host.js",
  ];
  return [...base, ...(opts.scans ? SCAN_PARTS : []), ...(opts.results ? resultsParts() : [])];
}

// A JSON part is a language's words: the extension's messages become ClotrMessages.<lang> and the apps' own words
// ClotrAppWords.<lang>, the JSON as it is in the file (JSON is a JavaScript value).
const jsonPart = (rel) => {
  const messages = /^extension\/_locales\/([^/]+)\/messages\.json$/.exec(rel);
  if (messages) return { global: "ClotrMessages", lang: messages[1] };
  const words = /^apps\/locales\/([a-z]{2})\.json$/.exec(rel);
  return words ? { global: "ClotrAppWords", lang: words[1] } : null;
};
const wrapFor = (rel) => {
  const json = jsonPart(rel);
  return json
    ? {
        before: `(globalThis.${json.global} = globalThis.${json.global} || {})[${JSON.stringify(json.lang)}] =\n`,
        after: ";\n",
      }
    : { before: "", after: "" };
};

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

// The bundle's text and its parts ({ path, sha256, bytes }). A part must end with a new line, and a script part with
// a semicolon, so no two parts can run together as one statement.
function build(opts = {}) {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
  const list = parts(opts).map((rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (!text.endsWith("\n")) throw new Error(`${rel} doesn't end with a new line`);
    if (!jsonPart(rel) && !text.trimEnd().endsWith(";")) throw new Error(`${rel} doesn't end with a semicolon`);
    if (jsonPart(rel)) JSON.parse(text); // a broken file stops the build, not an app
    return { path: rel, text, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
  });
  const header = [
    `// Clotr engine ${version}: Clotr's detection, decisions and words for apps outside the browser, with`,
    "// ClotrHost as the way in. Written by tools/engine-bundle.js from the files named below, each byte for byte",
    "// (SHA-256 of each); never edit or commit this file.",
    ...list.map((p) => `//   ${p.sha256}  ${p.path}`),
    "",
  ].join("\n");
  const body = list.map((p) => {
    const { before, after } = wrapFor(p.path);
    return `${MARK}${p.path}\n${before}${p.text}${after}`;
  });
  return {
    version,
    text: header + body.join(""),
    parts: list.map((p) => ({ path: p.path, sha256: p.sha256, bytes: p.bytes })),
  };
}

// The parts back out of a bundle's text: [{ path, text }], each part's text as its file was (the messages' wrapper
// taken off). What the tests compare with the files.
function split(bundle) {
  const out = [];
  const pieces = bundle.split(new RegExp(`^${MARK}(.+)\\n`, "m"));
  for (let i = 1; i < pieces.length; i += 2) {
    const rel = pieces[i];
    const { before, after } = wrapFor(rel);
    let text = pieces[i + 1];
    if (before && text.startsWith(before) && text.endsWith(after)) text = text.slice(before.length, -after.length);
    out.push({ path: rel, text });
  }
  return out;
}

// For an app that can only hand the engine a script: the one script that calls ClotrHost with `args` as data. The
// request becomes a JSON string literal, with the characters that could end a script or a string early written as
// escapes (U+2028, U+2029, "<" for "</script>"), so the person's text can never become code. Each app's own quoting
// is checked against this one.
function scriptFor(method, args = []) {
  const literal = JSON.stringify(JSON.stringify({ method, args })).replace(
    /[\u2028\u2029<>&]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `ClotrHost.call(${literal})`;
}

function write(out = OUT, opts = {}) {
  const bundle = build(opts);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bundle.text);
  return { out, ...bundle, size: Buffer.byteLength(bundle.text, "utf8") };
}

// The bundles written on this computer that an app loads as they are: this tool's own, and Clotr for Windows' copy
// in its pages' folder (apps/desktop/tools/prepare-ui.js, which its build runs too). The Android build writes its own
// from the files every time one of them changes, so it can't fall behind.
const DESKTOP_UI = path.join(ROOT, "apps", "desktop", "ui", "dist");
const WRITTEN = [OUT, path.join(DESKTOP_UI, "clotr-engine.js")];

// The parts a bundle's header names: [[path, sha256]].
const headerParts = (text) =>
  [...text.split(MARK)[0].matchAll(/^\/\/ {3}([0-9a-f]{64}) {2}(\S+)$/gm)].map((m) => [m[2], m[1]]);

// Each written bundle that isn't what the files make now (`now`, from build()): { file, changed, message }, where
// `changed` lists the files changed, added or gone since it was written (empty when only the version or the
// bundle's own format changed). A bundle never written isn't stale: nothing loads it.
function staleBundles(files = WRITTEN, now = build()) {
  const out = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text === now.text) continue;
    const was = new Map(headerParts(text));
    const changed = [
      ...now.parts.filter((p) => was.get(p.path) !== p.sha256).map((p) => p.path),
      ...[...was.keys()].filter((p) => !now.parts.some((x) => x.path === p)),
    ];
    const name = path.relative(ROOT, file).replace(/\\/g, "/");
    const since = changed.length ? changed.join(", ") : "the version or the bundle's format";
    out.push({
      file,
      changed,
      message: `${name} is stale: ${since} changed since it was written, so an app would load the old engine. Run: npm run engine-bundle`,
    });
  }
  return out;
}

module.exports = { parts, build, split, scriptFor, write, staleBundles, OUT, WRITTEN, SCAN_PARTS, resultsParts };

if (require.main === module) {
  const i = process.argv.indexOf("--out");
  const scans = process.argv.includes("--scans");
  const results = process.argv.includes("--results");
  const r = write(i > 0 ? path.resolve(process.argv[i + 1]) : OUT, { scans, results });
  console.log(
    `Clotr engine ${r.version}: ${path.relative(ROOT, r.out)} (${(r.size / 1024).toFixed(0)} KB, ${r.parts.length} parts)`,
  );
  // Clotr for Windows' pages folder, when this computer has one: brought up to date with the same files (only what
  // changed is written), so no copy is left behind.
  if (i < 0 && fs.existsSync(DESKTOP_UI)) {
    const written = require(path.join(ROOT, "apps", "desktop", "tools", "prepare-ui.js")).prepare();
    console.log(
      `Clotr for Windows: ${path.relative(ROOT, DESKTOP_UI)} ${written.length ? `(${written.join(", ")})` : "up to date"}`,
    );
  }
}

// Checks the extension's file lists and every path inside the extension: the manifest, the Firefox and Safari worker
// and the pages load what the two lists say; every path the extension names is a real file; every script is loaded
// by something; and every file name in the extension is used once in the repo, so a test can find it by name.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  LIST_FILE,
  EXTENSION_LIST_FILE,
  engineFiles,
  extensionGroups,
  allPages,
  staleFiles,
} = require("../tools/engine-files.js");
const { BACKGROUND_SCRIPTS } = require("../tools/package.js");
const bundle = require("../tools/engine-bundle.js");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const lists = extensionGroups();

// ---------- Reading the extension ----------

// Every file under extension/, by its path from there.
function extensionFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out.push(path.relative(EXT, file).split(path.sep).join("/"));
    }
  })(EXT);
  return out.sort();
}

const read = (file) => fs.readFileSync(path.join(EXT, file), "utf8");

// A path inside the extension, from the file that names it: "/x" starts at the extension's top folder, anything
// else is beside the naming file. A query or hash is left off.
function resolved(from, written) {
  const bare = written.replace(/[?#].*$/, "");
  if (bare.startsWith("/")) return bare.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), bare));
}

// A path that leaves the extension, or isn't a file path at all.
function isOutside(written) {
  return /^(https?:|mailto:|data:|javascript:|#|$)/.test(written);
}

// Every path a page names in a src or href, as { from, written }.
function pagePaths() {
  return allPages().flatMap((page) =>
    [...read(page).matchAll(/\b(?:src|href)="([^"]*)"/g)]
      .map((match) => ({ from: page, written: match[1] }))
      .filter(({ written }) => !isOutside(written)),
  );
}

// The text inside each call to `name(...)` in a script, to its own closing bracket, so a call that maps its
// arguments (the look-back worker's importScripts) is read whole.
function callArguments(source, name) {
  const out = [];
  const start = new RegExp(`\\b${name}\\(`, "g");
  for (const match of source.matchAll(start)) {
    let depth = 1;
    let at = match.index + match[0].length;
    for (; at < source.length && depth > 0; at++) {
      if (source[at] === "(") depth++;
      if (source[at] === ")") depth--;
    }
    out.push(source.slice(match.index + match[0].length, at - 1));
  }
  return out;
}

// The quoted strings inside each call to `name(...)` in a script, as written.
function stringsInCalls(source, name) {
  return callArguments(source, name).flatMap((text) => [...text.matchAll(/"([^"`$]*)"/g)].map((quoted) => quoted[1]));
}

// Every path a script names: getURL("..."), importScripts("..."), new Worker("..."), and any quoted page name it
// hands on to getURL later (the popup's and the helper page's door lists).
function scriptPaths() {
  const scripts = extensionFiles().filter((file) => file.endsWith(".js") && !file.startsWith("engine/"));
  return scripts.flatMap((file) => {
    const source = read(file);
    // getURL always starts at the extension's top folder, and so do the page names handed to it. importScripts
    // and new Worker start beside the script.
    const fromTop = (name) => (name.startsWith("/") ? name : `/${name}`);
    const written = [
      ...stringsInCalls(source, "getURL").filter(Boolean).map(fromTop),
      ...stringsInCalls(source, "importScripts"),
      ...stringsInCalls(source, "Worker"),
      ...[...source.matchAll(/"([\w./-]+\.html(?:[?#][^"]*)?)"/g)].map((match) => fromTop(match[1])),
    ];
    return written.filter((name) => name && !isOutside(name)).map((name) => ({ from: file, written: name }));
  });
}

// Every url(...) in a style sheet, outside data: addresses.
function stylePaths() {
  return extensionFiles()
    .filter((file) => file.endsWith(".css"))
    .flatMap((file) =>
      [...read(file).matchAll(/url\(\s*"?([^")]+)"?\s*\)/g)]
        .map((match) => ({ from: file, written: match[1] }))
        .filter(({ written }) => !isOutside(written)),
    );
}

// The files the manifest names, from the top folder.
function manifestPaths() {
  return [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.storage?.managed_schema,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((script) => script.js),
  ]
    .filter(Boolean)
    .map((written) => ({ from: "manifest.json", written: `/${written}` }));
}

// ---------- 1. The lists ----------

test("the manifest, the Firefox and Safari worker, and the pages load what the two lists say", () => {
  assert.deepEqual(manifest.content_scripts[0].js, [...engineFiles(), ...lists.chatPage], "the content scripts");
  assert.deepEqual(
    BACKGROUND_SCRIPTS,
    [
      LIST_FILE,
      EXTENSION_LIST_FILE,
      ...engineFiles(),
      ...lists.worker,
      ...lists.sitesAndPolicy,
      ...lists.background,
      "background.js",
    ],
    "the Firefox and Safari worker",
  );
  const worker = read("background.js");
  assert.ok(worker.includes(`importScripts("${EXTENSION_LIST_FILE}")`), "the worker loads the list");
  for (const group of ["sitesAndPolicy", "worker", "background"]) {
    assert.ok(
      worker.includes(`importScripts(...globalThis.ClotrExtensionFiles.${group})`),
      `the worker loads ${group}`,
    );
  }
  // A page that loads one of the site files loads them all, in the list's order.
  for (const page of allPages()) {
    const scripts = [...read(page).matchAll(/<script src="\/?([^"]+)"/g)].map((match) => match[1]);
    const at = lists.sitesAndPolicy.map((file) => scripts.indexOf(file));
    if (at.every((index) => index < 0)) continue;
    assert.ok(
      at.every((index, order) => index >= 0 && (order === 0 || index > at[order - 1])),
      `${page} loads the site files`,
    );
  }
  // The popup loads its own scripts in the list's order.
  const popupPage = allPages().find((page) => page.endsWith("popup/popup.html"));
  const popupScripts = [...read(popupPage).matchAll(/<script src="\/?([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    popupScripts.filter((file) => lists.popup.includes(file)),
    lists.popup,
    "popup/popup.html loads the popup group",
  );
  assert.deepEqual(staleFiles(), [], "npm run engine-files has nothing to write");
});

// ---------- 2. Every path is a real file ----------

// A file the extension reads only when it's there: a developer's local updater writes local-update.txt, and git
// ignores it (background.js, checkForLocalUpdate).
const OPTIONAL_FILES = new Set(["local-update.txt"]);

test("every path the extension names points at a real file", () => {
  const files = new Set(extensionFiles());
  const named = [...pagePaths(), ...scriptPaths(), ...stylePaths(), ...manifestPaths()];
  assert.ok(named.length > 100, `read ${named.length} paths`);
  const missing = named
    .filter(({ from, written }) => !files.has(resolved(from, written)) && !OPTIONAL_FILES.has(resolved(from, written)))
    .map(({ from, written }) => `${from}: ${written}`);
  assert.deepEqual(missing, []);
});

// ---------- 3. Every script is loaded ----------

test("every script in the extension is loaded by something: a list, a page or a worker", () => {
  const loaded = new Set([
    LIST_FILE,
    EXTENSION_LIST_FILE,
    ...engineFiles(),
    ...Object.values(lists).flat(),
    ...manifestPaths().map(({ written }) => written.slice(1)),
    ...[...pagePaths(), ...scriptPaths()].map(({ from, written }) => resolved(from, written)),
    // Clotr for Windows and Android load some files straight from the extension (tools/engine-bundle.js).
    ...bundle
      .parts({ scans: true })
      .filter((file) => file.startsWith("extension/"))
      .map((file) => file.slice("extension/".length)),
  ]);
  const unloaded = extensionFiles().filter((file) => file.endsWith(".js") && !loaded.has(file));
  assert.deepEqual(unloaded, []);
});

// ---------- 4. Every name is used once ----------

// Names that are meant to repeat: each folder's map, and each language's messages.
const SHARED_NAMES = new Set(["README.md", "messages.json"]);
// Folders a test names by path, never by a bare name: the engine, the icons, the font and the languages.
const FOUND_BY_PATH = /^(engine|icons|fonts|_locales)\//;
// A name that repeats today: a release draft keeps a copy of the changelog.
const KNOWN_REPEATS = new Set(["changelog.json"]);

test("every file name in the extension is used once in the repo, so a test can find it by name", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const count = new Map();
  for (const file of tracked) count.set(path.posix.basename(file), (count.get(path.posix.basename(file)) || 0) + 1);
  const repeated = extensionFiles()
    .filter((file) => !FOUND_BY_PATH.test(file))
    .map((file) => path.posix.basename(file))
    .filter((name) => !SHARED_NAMES.has(name) && !KNOWN_REPEATS.has(name) && (count.get(name) || 0) > 1);
  assert.deepEqual([...new Set(repeated)], []);
});

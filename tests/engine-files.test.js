// The engine's one list of files (extension/engine/files.js) and everything that has to agree with it: the manifest
// and the pages written from it, the files under extension/engine/, and the names one engine file hands another.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Linter } = require("eslint");
const globals = require("globals");
const { GROUPS, LIST_FILE, engineGroups, staleFiles } = require("../tools/engine-files.js");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const ENGINE_DIR = path.join(EXT, "engine");

// ---------- Shared helpers ----------

// What a browser page, a worker and Node all give the engine beyond JavaScript itself.
const HOST_NAMES = ["console", "URLSearchParams", "performance"];
// How engine files share names: one line that takes them, one that hands them on.
const INTERNAL = "ClotrInternal";
const IMPORT_LINE = /^\s*const \{([^}]*)\} = globalThis\.ClotrInternal;/gm;
const EXPORT_LINE = /^\s*globalThis\.ClotrInternal = \{\s*\.\.\.globalThis\.ClotrInternal,([^}]*)\};/gm;

function listedFiles() {
  const groups = engineGroups();
  return GROUPS.flatMap((group) => groups[group]);
}

function source(file) {
  return fs.readFileSync(path.join(EXT, file), "utf8");
}

// The names inside each matched { ... }, by the name they're shared under (`a` in `a: b`).
function sharedNames(text, line) {
  const names = [];
  for (const match of text.matchAll(line)) {
    for (const part of match[1].split(",")) {
      const name = part.split(":")[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

// Names the file uses but never declares, by ESLint's own scope reading.
function undeclaredNames(text, file) {
  const linter = new Linter({ configType: "flat" });
  const config = {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.builtin, ...Object.fromEntries(HOST_NAMES.map((name) => [name, "readonly"])) },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "no-undef": "error" },
  };
  const messages = linter.verify(text, config, { filename: file });
  return messages.filter((message) => message.ruleId === "no-undef").map((message) => `${file}: ${message.message}`);
}

// Every .js file under extension/engine/, by path from extension/.
function filesUnderEngine(dir = ENGINE_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnderEngine(full));
    else if (entry.name.endsWith(".js")) out.push(path.relative(EXT, full).replace(/\\/g, "/"));
  }
  return out;
}

// ---------- 1. The manifest and the pages ----------

// The extension's list comes with the extension's release. Until then its manifest loads the old engine files.
const NO_EXTENSION_LIST = !fs.existsSync(path.join(EXT, "extension-files.js")) && "no extension list here yet";

test("the manifest and every page that loads the engine match the list", { skip: NO_EXTENSION_LIST }, () => {
  assert.deepEqual(staleFiles(), [], "run npm run engine-files");
  const manifest = JSON.parse(source("manifest.json"));
  const all = listedFiles();
  assert.deepEqual(manifest.content_scripts[0].js.slice(0, all.length), all, "the content script starts with the list");
  // A page that loads sites-and-policy/protected-sites.js loads the list before it, since sites-and-policy/protected-sites.js builds its script list from it.
  for (const page of require("../tools/engine-files.js").allPages()) {
    const text = source(page);
    const sitesAt = text.indexOf('<script src="/sites-and-policy/protected-sites.js"');
    if (sitesAt < 0) continue;
    const listAt = text.indexOf(`<script src="/${LIST_FILE}"`);
    assert.ok(
      listAt >= 0 && listAt < sitesAt,
      `${page} loads sites-and-policy/protected-sites.js before the engine's list`,
    );
  }
});

// ---------- 2. The files under extension/engine/ ----------

test("every .js file under extension/engine/ is on the list once", () => {
  const listed = listedFiles();
  const twice = listed.filter((file, index) => listed.indexOf(file) !== index);
  assert.deepEqual(twice, [], "files on the list more than once");
  const missing = listed.filter((file) => !fs.existsSync(path.join(EXT, file)));
  assert.deepEqual(missing, [], "files on the list that aren't there");
  const unlisted = filesUnderEngine().filter((file) => file !== LIST_FILE && !listed.includes(file));
  assert.deepEqual(unlisted, [], "engine files the list doesn't name");
});

// ---------- 3. The names engine files share ----------

test("every engine file declares, imports or is given each name it uses, and imports only from files before it", () => {
  const exportedBy = new Map();
  const problems = [];
  for (const file of listedFiles()) {
    const text = source(file);
    problems.push(...undeclaredNames(text, file));
    for (const name of sharedNames(text, IMPORT_LINE)) {
      if (!exportedBy.has(name)) problems.push(`${file} imports ${name}, which no file before it exports`);
    }
    for (const name of sharedNames(text, EXPORT_LINE)) {
      if (exportedBy.has(name)) problems.push(`${file} exports ${name}, already exported by ${exportedBy.get(name)}`);
      exportedBy.set(name, file);
      // A value copied at load can't follow a later change, so a shared name is never a let.
      if (new RegExp(`\\blet\\s+${name}\\b`).test(text)) problems.push(`${file} exports ${name}, which is a let`);
    }
  }
  assert.deepEqual(problems, []);
});

// ---------- 4. The internal object stays inside the engine ----------

test("no file outside extension/engine/ names the engine's internal object", () => {
  // The extension's and the apps' own code. Engine files still waiting to move into extension/engine/ count as
  // inside it.
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "extension", "apps"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file.endsWith(".js") && !file.startsWith("extension/engine/"));
  const listed = new Set(listedFiles().map((file) => `extension/${file}`));
  const naming = tracked
    .filter((file) => !listed.has(file) && fs.existsSync(path.join(ROOT, file)))
    .filter((file) => fs.readFileSync(path.join(ROOT, file), "utf8").includes(INTERNAL));
  assert.deepEqual(naming, []);
});

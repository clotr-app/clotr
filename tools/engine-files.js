// The engine's file list for Node, and the program that writes the files that can't read the list themselves.
// extension/engine/files.js is the one list of the engine's files, in load order. A page and the manifest can't
// run code to read it, so this writes them from it. Tools require this file for the list itself.
// Usage: npm run engine-files              rewrites the manifest's content script and each page's engine tags
//        npm run engine-files -- --check   writes nothing, and fails if the manifest or a page is stale
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

// ---------- Reading the list ----------

const LIST_FILE = "engine/files.js";
const GROUPS = ["rules", "detect", "decide"];
// The engine before the list existed. A tool that reads an older revision falls back to these names.
const OLD_GROUPS = { rules: ["patterns.js"], detect: ["detector.js"], decide: ["decide.js"] };

// The list from its source text. It's a plain script that sets one global, so it runs in an empty context.
function groupsFromSource(source) {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: LIST_FILE });
  return checkedGroups(context.ClotrEngineFiles);
}

// The list as plain arrays, after making sure it has exactly the three groups, each a list of file names.
function checkedGroups(list) {
  if (!list || typeof list !== "object") throw new Error(`${LIST_FILE} doesn't set globalThis.ClotrEngineFiles`);
  const names = Object.keys(list);
  if (names.join() !== GROUPS.join()) throw new Error(`${LIST_FILE} needs the groups ${GROUPS.join(", ")}, in order`);
  const groups = {};
  for (const group of GROUPS) {
    const files = list[group];
    const allNames = Array.isArray(files) && files.every((file) => typeof file === "string" && file.endsWith(".js"));
    if (!allNames) throw new Error(`${LIST_FILE}: ${group} must be a list of .js file names`);
    groups[group] = [...files];
  }
  return groups;
}

// The list as it is on disk now.
function engineGroups(extDir = EXT) {
  return groupsFromSource(fs.readFileSync(path.join(extDir, LIST_FILE), "utf8"));
}

// The list from its source text, or the old three files when there's no list yet (an older revision or folder).
function engineGroupsOrOld(source) {
  if (source === null || source === undefined) return structuredClone(OLD_GROUPS);
  return groupsFromSource(source);
}

// The list in an extension folder, which may be an older copy without one.
function engineGroupsIn(extDir) {
  const listPath = path.join(extDir, LIST_FILE);
  return engineGroupsOrOld(fs.existsSync(listPath) ? fs.readFileSync(listPath, "utf8") : null);
}

// The named groups' files, in load order. With no group named, every engine file.
function engineFiles(groups = GROUPS, extDir = EXT) {
  const list = extDir === EXT ? engineGroups() : engineGroupsIn(extDir);
  return groups.flatMap((group) => list[group]);
}

// Loads the named groups from an extension folder into this Node process, the way a page loads them, and returns
// globalThis.Clotr.
function requireEngine(groups = GROUPS, extDir = EXT) {
  for (const file of engineFiles(groups, extDir)) require(path.join(extDir, file));
  return globalThis.Clotr;
}

// ---------- The engine at a git revision ----------

// A file under extension/ at a revision, or null when that revision doesn't have it.
function showOrNull(rev, file, cwd = ROOT) {
  try {
    return execFileSync("git", ["show", `${rev}:extension/${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// The engine at a revision: { list, groups, text }, where list is the list's own source (null before it existed)
// and text holds each engine file's source by name, in load order. A file the list names but the revision lacks is
// left out.
function engineAt(rev, cwd = ROOT) {
  const list = showOrNull(rev, LIST_FILE, cwd);
  const groups = engineGroupsOrOld(list);
  const text = {};
  for (const file of GROUPS.flatMap((group) => groups[group])) {
    const source = showOrNull(rev, file, cwd);
    if (source !== null) text[file] = source;
  }
  return { list, groups, text };
}

// Writes an engine from engineAt() into a folder laid out like extension/, so a tool can load it from there.
function writeEngineFolder(dir, engine) {
  const files = engine.list === null ? engine.text : { [LIST_FILE]: engine.list, ...engine.text };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
}

// ---------- The extension's own list ----------

// extension/extension-files.js lists the files outside the engine that load in a fixed order. Like the engine's
// list, it's a plain script, so it's read in an empty context.
const EXTENSION_LIST_FILE = "extension-files.js";
const EXTENSION_GROUPS = ["sitesAndPolicy", "worker", "chatPage", "popup", "background"];

function extensionGroupsFromSource(source) {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: EXTENSION_LIST_FILE });
  const list = context.ClotrExtensionFiles;
  if (!list || typeof list !== "object") throw new Error(`${EXTENSION_LIST_FILE} doesn't set ClotrExtensionFiles`);
  if (Object.keys(list).join() !== EXTENSION_GROUPS.join()) {
    throw new Error(`${EXTENSION_LIST_FILE} needs the groups ${EXTENSION_GROUPS.join(", ")}, in order`);
  }
  const groups = {};
  for (const group of EXTENSION_GROUPS) {
    const files = list[group];
    const allNames = Array.isArray(files) && files.every((file) => typeof file === "string" && file.endsWith(".js"));
    if (!allNames) throw new Error(`${EXTENSION_LIST_FILE}: ${group} must be a list of .js file names`);
    groups[group] = [...files];
  }
  return groups;
}

// The extension's list as it is on disk now.
function extensionGroups(extDir = EXT) {
  return extensionGroupsFromSource(fs.readFileSync(path.join(extDir, EXTENSION_LIST_FILE), "utf8"));
}

// ---------- Which scripts are the engine's ----------

// A script name the writer owns: one on the list, the list itself, anything under engine/, or an old engine file.
function isEngineScript(file, groups) {
  if (file === LIST_FILE || file.startsWith("engine/")) return true;
  return GROUPS.some((group) => groups[group].includes(file) || OLD_GROUPS[group].includes(file));
}

// The group a script name belongs to, or null for the list itself.
function groupOf(file, groups) {
  for (const group of GROUPS) {
    if (groups[group].includes(file) || OLD_GROUPS[group].includes(file)) return group;
  }
  return null;
}

// ---------- The manifest ----------

// The manifest's text with each content script that loads the engine given the engine's whole list, followed by
// the extension list's chat-page group. Without an extension list (an older folder), the scripts after the engine's
// files stay as they are.
function manifestFromList(text, groups, chatPage = null) {
  const manifest = JSON.parse(text);
  const allFiles = GROUPS.flatMap((group) => groups[group]);
  for (const script of manifest.content_scripts || []) {
    const first = script.js.findIndex((file) => isEngineScript(file, groups));
    if (first < 0) continue;
    const others = script.js.filter((file) => !isEngineScript(file, groups));
    const after = chatPage ? [...chatPage] : others.slice(first);
    script.js = [...others.slice(0, first), ...allFiles, ...after];
  }
  return JSON.stringify(manifest, null, 2) + "\n";
}

// ---------- The pages ----------

// Each engine script tag names its group in a data-engine attribute ("list" for the list itself), so a page shows
// which tags this program owns. A page can't carry an HTML comment, so the attribute is the marker.
// Every path starts at the extension's top folder ("/engine/..."), so a page in a folder loads the same files.
// The site files' tags carry data-list instead (below).
const SCRIPT_TAG = /^(\s*)<script src="\/?([^"]+)"( data-engine="(\w+)")?( data-list="(\w+)")?><\/script>$/;

function scriptTag(indent, file, group) {
  return `${indent}<script src="/${file}" data-engine="${group}"></script>`;
}

// One group's tags. The page's first group also carries the list itself when the page needs it.
function groupLines(indent, group, groups, withList) {
  const lines = groups[group].map((file) => scriptTag(indent, file, group));
  return withList ? [scriptTag(indent, LIST_FILE, "list"), ...lines] : lines;
}

// The page's lines cut into plain lines and engine groups ({ indent, group }), in order. A run of tags of one
// group, marked or not (a page before its first write, or a tag added by hand), is one group.
function pieces(lines, groups) {
  const out = [];
  for (const line of lines) {
    const tag = SCRIPT_TAG.exec(line);
    const owned = tag && (tag[4] || isEngineScript(tag[2], groups));
    if (!owned) {
      out.push(line);
      continue;
    }
    const group = tag[4] && tag[4] !== "list" ? tag[4] : groupOf(tag[2], groups);
    if (!group) continue; // the list's own tag comes back with the page's first group
    const previous = out[out.length - 1];
    if (previous?.group === group) continue;
    out.push({ indent: tag[1], group });
  }
  return out;
}

// The page's text as the list says it should be, or the text unchanged when it loads no engine file.
function pageFromList(text, groups, siteFiles = extensionGroups().sitesAndPolicy) {
  const parts = pieces(text.split("\n"), groups);
  const firstGroup = parts.findIndex((part) => typeof part === "object");
  if (firstGroup < 0) return text;

  // The site files build their content script list from the engine's list, so a page that loads them loads it.
  const sitesAt = parts.findIndex((part) => typeof part === "string" && isSiteTag(part, siteFiles));
  if (sitesAt >= 0 && sitesAt < firstGroup) throw new Error("the site files load before the engine's first group");
  const withList = sitesAt >= 0;

  const out = [];
  for (const [index, part] of parts.entries()) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }
    if (!GROUPS.includes(part.group)) throw new Error(`no engine group named ${part.group}`);
    out.push(...groupLines(part.indent, part.group, groups, withList && index === firstGroup));
  }
  return withSiteFiles(out, siteFiles).join("\n");
}

// ---------- The site files on a page ----------

// A page that loads the site files loads the extension's list just before them, since they read it too, then every
// file of the list's sitesAndPolicy group in its order. Their tags carry data-list, so a renamed one is still known.
function isSiteTag(line, siteFiles) {
  const tag = SCRIPT_TAG.exec(line);
  if (!tag) return false;
  return Boolean(tag[6]) || siteFiles.includes(tag[2]) || tag[2] === EXTENSION_LIST_FILE;
}

function withSiteFiles(lines, siteFiles) {
  const out = [];
  let written = false;
  for (const line of lines) {
    if (!isSiteTag(line, siteFiles)) {
      out.push(line);
      continue;
    }
    if (written) continue;
    written = true;
    const indent = SCRIPT_TAG.exec(line)[1];
    out.push(`${indent}<script src="/${EXTENSION_LIST_FILE}" data-list="extension"></script>`);
    for (const file of siteFiles) out.push(`${indent}<script src="/${file}" data-list="sitesAndPolicy"></script>`);
  }
  return out;
}

// Every page in the extension, in any folder, by its path from extension/.
function allPages(extDir = EXT) {
  const pages = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".html")) pages.push(path.relative(extDir, file).split(path.sep).join("/"));
    }
  })(extDir);
  return pages.sort();
}

// The extension's pages that load any engine file.
function enginePages(extDir = EXT) {
  const groups = engineGroups(extDir);
  return allPages(extDir).filter((name) => loadsEngine(fs.readFileSync(path.join(extDir, name), "utf8"), groups));
}

function loadsEngine(text, groups) {
  return pieces(text.split("\n"), groups).some((part) => typeof part === "object");
}

// ---------- Writing and checking ----------

// Every file the list writes, as { file, now, wanted }: the manifest first, then the pages.
function writtenFiles(extDir = EXT) {
  const groups = engineGroups(extDir);
  const out = [];
  const manifestPath = path.join(extDir, "manifest.json");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const chatPage = extensionGroups(extDir).chatPage;
  out.push({ file: manifestPath, now: manifest, wanted: manifestFromList(manifest, groups, chatPage) });
  for (const name of enginePages(extDir)) {
    const pagePath = path.join(extDir, name);
    const page = fs.readFileSync(pagePath, "utf8");
    out.push({ file: pagePath, now: page, wanted: pageFromList(page, groups) });
  }
  return out;
}

// The files that don't match the list, by path from the repo's root.
function staleFiles(extDir = EXT) {
  return writtenFiles(extDir)
    .filter((entry) => entry.now !== entry.wanted)
    .map((entry) => path.relative(ROOT, entry.file).replace(/\\/g, "/"));
}

function main(argv) {
  const check = argv.includes("--check");
  const stale = staleFiles();
  if (check) {
    if (!stale.length) {
      console.log("engine-files: the manifest and every page match extension/engine/files.js and extension-files.js");
      return 0;
    }
    const verb = stale.length === 1 ? "doesn't" : "don't";
    console.error(
      `engine-files: ${stale.join(", ")} ${verb} match extension/engine/files.js. Run npm run engine-files.`,
    );
    return 1;
  }
  for (const entry of writtenFiles()) {
    if (entry.now !== entry.wanted) fs.writeFileSync(entry.file, entry.wanted);
  }
  console.log(stale.length ? `engine-files: wrote ${stale.join(", ")}` : "engine-files: nothing to write");
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  GROUPS,
  LIST_FILE,
  EXTENSION_GROUPS,
  EXTENSION_LIST_FILE,
  extensionGroupsFromSource,
  extensionGroups,
  allPages,
  OLD_GROUPS,
  groupsFromSource,
  engineGroups,
  engineGroupsOrOld,
  engineGroupsIn,
  engineFiles,
  requireEngine,
  engineAt,
  writeEngineFolder,
  manifestFromList,
  pageFromList,
  enginePages,
  staleFiles,
};

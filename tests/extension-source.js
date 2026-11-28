// Reads one of the extension's cut files as one text: its parts joined in the order they load, from the list in
// extension/extension-files.js. A test that reads popup/popup.js, sites-and-policy/protected-sites.js or background.js as text reads it this way,
// so it keeps reading all of it once the file is cut into parts. Before a cut, the one part is the file itself.
"use strict";

const fs = require("fs");
const path = require("path");
const { extensionGroups } = require("../tools/engine-files.js");
const { EXT, extensionFile } = require("./extension-file.js");

// ---------- The parts of each cut file ----------

// The list group each cut file's parts load in.
const GROUP_OF = { "popup/popup.js": "popup", "sites-and-policy/protected-sites.js": "sitesAndPolicy" };

// The parts of a cut file, as paths from extension/, in load order. background.js stays as the loader, and its
// parts load from it, so the loader comes first.
function partsOf(name) {
  if (name === "background.js") return ["background.js", ...extensionGroups().background.map(extensionFile)];
  const group = GROUP_OF[name];
  if (!group) return [extensionFile(name)];
  return extensionGroups()[group].map(extensionFile);
}

// The files a test loads for a cut file, in load order. The site files read the extension's list, so it comes
// first, as on a page.
function loadOrder(name) {
  if (name === "sites-and-policy/protected-sites.js") return ["extension-files.js", ...partsOf(name)];
  return partsOf(name);
}

// ---------- Reading and loading them ----------

// The text a test runs for a cut file: everything in its load order, joined.
function loadSource(name) {
  return loadOrder(name)
    .map((part) => fs.readFileSync(path.join(EXT, part), "utf8"))
    .join("\n");
}

// Loads a cut file's parts into this process, the way require("../extension/sites-and-policy/protected-sites.js") loaded the whole file.
function requireParts(name) {
  for (const part of loadOrder(name)) require(path.join(EXT, part));
}

function extensionSource(name) {
  return partsOf(name)
    .map((part) => fs.readFileSync(path.join(EXT, part), "utf8"))
    .join("\n");
}

module.exports = { partsOf, loadOrder, extensionSource, loadSource, requireParts };

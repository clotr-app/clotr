// Finds a file in the extension by its name alone, so a test or a browser check keeps working when the file moves
// into a folder. extensionFile("content.js") is the one file with that name anywhere under extension/, as a path
// from there ("on-websites/content.js"). It fails when no file or more than one has that name. A name with a "/" in
// it is already a path, and comes back as it is.
"use strict";

const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");

// ---------- Every file, by name ----------

let byName = null;

// Each file name under extension/ with the paths that carry it, from extension/.
function readNames() {
  const names = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const rel = path.relative(EXT, file).split(path.sep).join("/");
      names.set(entry.name, [...(names.get(entry.name) || []), rel]);
    }
  })(EXT);
  return names;
}

// The paths with this name. A name not found, or found twice, is looked up again from disk once, in case a test
// added or removed a file since the last look.
function pathsNamed(name) {
  byName ??= readNames();
  const found = byName.get(name) || [];
  if (found.length === 1) return found;
  byName = readNames();
  return byName.get(name) || [];
}

// ---------- Finding a file ----------

function extensionFile(name) {
  if (name.includes("/")) return name;
  const found = pathsNamed(name);
  if (found.length !== 1) {
    throw new Error(`extensionFile: ${found.length} files named ${name} under extension/ (${found.join(", ")})`);
  }
  return found[0];
}

// A page's address inside the extension, from its name and any query or hash: "vault.html?welcome=1" becomes
// "clotr-pages/vault/vault.html?welcome=1" once the vault moves.
function extensionAddress(page) {
  const at = page.search(/[?#]/);
  const name = at < 0 ? page : page.slice(0, at);
  const rest = at < 0 ? "" : page.slice(at);
  return extensionFile(name) + rest;
}

module.exports = { EXT, extensionFile, extensionAddress };

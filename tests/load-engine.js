// Loads the engine into a test, the way a page loads it: the list first (extension/engine/files.js), then the named
// groups' files in the list's order.
//   require("./load-engine.js")("rules", "detect")   loads them and returns globalThis.Clotr
//   loadEngine.files("rules")                        the groups' file names, paths starting at extension/
//   loadEngine.source("rules")                       the groups' source text, joined, for a test that reads the code
// Node keeps each file it has loaded, so loading a group twice runs it once, as before the list.
"use strict";

const fs = require("fs");
const path = require("path");
const { GROUPS, LIST_FILE, engineFiles } = require("../tools/engine-files.js");

const EXT = path.join(__dirname, "..", "extension");

function loadEngine(...groups) {
  require(path.join(EXT, LIST_FILE));
  for (const file of files(...groups)) require(path.join(EXT, file));
  return globalThis.Clotr;
}

// A misspelled group would otherwise load nothing and fail somewhere far from the typo.
function files(...groups) {
  const unknown = groups.filter((group) => !GROUPS.includes(group));
  if (unknown.length) throw new Error(`no engine group named ${unknown.join(", ")}`);
  return engineFiles(groups);
}

function source(...groups) {
  return files(...groups)
    .map((file) => fs.readFileSync(path.join(EXT, file), "utf8"))
    .join("\n");
}

module.exports = Object.assign(loadEngine, { files, source });

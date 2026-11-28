"use strict";

const path = require("path");

// Whether a path is the folder or inside it, by the path text alone.
function isWithinFolder(folder, file) {
  const relative = path.relative(folder, file);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

module.exports = { isWithinFolder };

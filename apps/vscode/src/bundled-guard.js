"use strict";

const path = require("path");
const guard = require("../guard/bin/clotr-guard.js");
const { isSecretFile } = require("../guard/lib/secret-files.js");
const {
  MAX_PATTERN_LENGTH,
  globMatches,
  globMatchesAt,
  parseClotrIgnore,
  parseRule,
  readClotrIgnore,
  valueFingerprint,
} = require("../guard/lib/clotrignore.js");

// The extension's own folder. __dirname changes meaning in a file under src/, so it's named once, here.
const EXTENSION_FOLDER = path.join(__dirname, "..");
const BUNDLED_CLI = path.join(EXTENSION_FOLDER, "guard", "bin", "clotr-guard.js");

module.exports = {
  guard,
  isSecretFile,
  MAX_PATTERN_LENGTH,
  globMatches,
  globMatchesAt,
  parseClotrIgnore,
  parseRule,
  readClotrIgnore,
  valueFingerprint,
  EXTENSION_FOLDER,
  BUNDLED_CLI,
};

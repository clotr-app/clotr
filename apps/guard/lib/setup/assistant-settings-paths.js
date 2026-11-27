"use strict";
/* global require, module, process */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { IMPLEMENTED_TOOL_NAMES } = require("../limits-and-messages.js");
const { readConfigFile, assertNoSymlinkComponents } = require("../safe-file-writes.js");

// ---------- Settings files and Node ----------

function userHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function toolSettingsPath(
  tool,
  { project = false, cwd = process.cwd(), home = userHome(), windsurfJetBrains = false } = {},
) {
  if (!IMPLEMENTED_TOOL_NAMES.includes(tool)) throw new Error("unknown-tool");
  const root = project ? cwd : home;
  if (tool === "claude") return path.join(root, project ? ".claude" : ".claude", "settings.json");
  if (tool === "cursor") return path.join(root, ".cursor", "hooks.json");
  if (tool === "gemini") return path.join(root, ".gemini", "settings.json");
  if (tool === "windsurf") {
    if (!project) {
      return path.join(root, ".codeium", ...(windsurfJetBrains ? [] : ["windsurf"]), "hooks.json");
    }
    // Devin's current Cascade docs prefer .devin. Keep using the documented .windsurf fallback when it
    // already exists and no .devin settings file would take precedence over it.
    const current = path.join(root, ".devin", "hooks.json");
    const legacy = path.join(root, ".windsurf", "hooks.json");
    let currentHasHooks = false;
    try {
      assertNoSymlinkComponents(root, current);
      const existing = readConfigFile(current);
      let settings;
      try {
        settings = JSON.parse(existing.content);
      } catch {
        // Let normal settings validation report a malformed current file instead of writing beside it.
        currentHasHooks = true;
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) currentHasHooks = true;
      else currentHasHooks = Boolean(settings.hooks && Object.keys(settings.hooks).length);
    } catch (error) {
      if (error.code !== "ENOENT") currentHasHooks = true;
    }
    return currentHasHooks || !fs.existsSync(legacy) ? current : legacy;
  }
  if (tool === "cline") {
    return path.join(root, project ? ".clinerules" : "Documents", "Cline", "Hooks");
  }
  return path.join(root, ".codex", "hooks.json");
}

module.exports = {
  userHome,
  toolSettingsPath,
};

"use strict";
/* global require, module, process */

const fs = require("fs");
const path = require("path");
const { readConfigFile, assertNoSymlinkComponents } = require("../safe-file-writes.js");
const { minSeverity } = require("../text-checks/check-text.js");
const { userHome, toolSettingsPath } = require("./assistant-settings-paths.js");
const { hookCommandWords, hasManagedHook } = require("./hook-command-reader.js");
const { gitHookScript, gitHookPaths } = require("./git-hook-setup.js");
const { clineHookInfo } = require("./cline-hooks.js");

// ---------- Listing hooks and help ----------

// The Guard scripts that Clotr's hooks for one tool run, each with the options it was set up with. An editor
// that carries its own copy of Guard reads this to set the hooks up again when an update moves that copy.
function managedHooks(tool, { project = false, cwd = process.cwd(), home = userHome() } = {}) {
  const found = new Map();
  function add(script, minimum = "medium", includePersonalDetails = false) {
    const entry = { script, minimum: minSeverity(minimum), includePersonalDetails };
    found.set(JSON.stringify(entry), entry);
  }
  try {
    if (tool === "git") {
      const { commonDir, hook } = gitHookPaths(cwd);
      assertNoSymlinkComponents(commonDir, hook);
      try {
        const current = readConfigFile(hook);
        const script = gitHookScript(current.content);
        if (script) add(script);
      } catch {
        // A missing or unsafe Git hook isn't a managed hook to repair from the IDE.
      }
    } else if (tool === "cline") {
      const directory = project
        ? path.join(cwd, ".clinerules", "hooks")
        : path.join(home, "Documents", "Cline", "Hooks");
      for (const name of ["UserPromptSubmit", "PreToolUse"]) {
        const file = path.join(directory, name);
        const backup = `${file}.clotr-guard.bak`;
        let current;
        try {
          current = readConfigFile(file);
        } catch {
          continue;
        }
        const info = clineHookInfo(current.content, name, backup, cwd);
        if (info) add(info.script, info.minimum, info.includePersonalDetails);
      }
    } else {
      function visit(value) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        for (const mode of ["prompt", "read", "shell", "tool"]) {
          if (!hasManagedHook(value, tool, mode, cwd)) continue;
          const words = hookCommandWords(value, cwd, tool);
          add(words[1], words[5], words.length === 7);
          return;
        }
        Object.values(value).forEach(visit);
      }
      const file = toolSettingsPath(tool, { project, cwd, home });
      if (fs.existsSync(file)) visit(JSON.parse(readConfigFile(file).content).hooks);
    }
  } catch {
    // A settings file that isn't JSON, or a folder that isn't a repository, has no Clotr hooks to list.
  }
  return [...found.values()];
}

function previewManagedHooks(settings, tool, cwd = process.cwd()) {
  const preview = {};
  for (const [event, entries] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    if (tool === "cursor" || tool === "windsurf") {
      const hooks = entries.filter((entry) =>
        ["prompt", "read", "shell", "tool"].some((mode) => hasManagedHook(entry, tool, mode, cwd)),
      );
      if (hooks.length) preview[event] = hooks;
      continue;
    }
    const groups = entries
      .map((group) => {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return null;
        const hooks = group.hooks.filter((hook) =>
          ["prompt", "read", "shell", "tool"].some((mode) => hasManagedHook(hook, tool, mode, cwd)),
        );
        return hooks.length ? { ...group, hooks } : null;
      })
      .filter(Boolean);
    if (groups.length) preview[event] = groups;
  }
  return preview;
}

module.exports = {
  managedHooks,
  previewManagedHooks,
};

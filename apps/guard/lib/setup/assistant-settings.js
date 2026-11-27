"use strict";
/* global require, module, process */

const fs = require("fs");
const path = require("path");
const { READ_TOOLS, hasOwn, cloneJson } = require("../limits-and-messages.js");
const { removeFile, atomicWriteFile, readConfigFile, assertNoSymlinkComponents } = require("../safe-file-writes.js");
const { minSeverity } = require("../text-checks/check-text.js");
const { userHome, toolSettingsPath } = require("./assistant-settings-paths.js");
const { managedHook } = require("./hook-command-writer.js");
const { hasManagedHook } = require("./hook-command-reader.js");
const { readConfigIfThere } = require("./git-hook-setup.js");
const { updateClineHooks } = require("./cline-hooks.js");

// ---------- Settings ----------

// Each assistant's hook event for a prompt, and for a read, a shell command or a tool call.
const PROMPT_EVENTS = {
  claude: "UserPromptSubmit",
  cursor: "beforeSubmitPrompt",
  gemini: "BeforeAgent",
  codex: "UserPromptSubmit",
  windsurf: "pre_user_prompt",
};

const READ_EVENTS = { claude: "PreToolUse", cursor: "beforeReadFile", gemini: "BeforeTool", windsurf: "pre_read_code" };

function hookEventOf(tool, mode) {
  if (mode !== "read" && mode !== "shell" && mode !== "tool") return PROMPT_EVENTS[tool];
  return {
    claude: "PreToolUse",
    cursor: cursorToolEvent(mode),
    gemini: "BeforeTool",
    codex: "PreToolUse",
    windsurf: "pre_read_code",
  }[tool];
}

function cursorToolEvent(mode) {
  if (mode === "tool") return "beforeMCPExecution";
  return mode === "shell" ? "beforeShellExecution" : "beforeReadFile";
}

// The matcher a hook group of Clotr's gets, or undefined for none.
function hookMatcher(tool, mode) {
  if (mode === "shell") return "^(?:Bash|PowerShell)$";
  if (mode === "read") {
    return {
      claude: "^(?:Read|Grep)$",
      gemini: "^(?:read_file|read_many_files|search_file_content|grep_search)$",
      codex: ".*[Rr]ead.*",
    }[tool];
  }
  return mode === "tool" ? "^mcp__" : undefined;
}

function mergeHookMode(
  settings,
  tool,
  mode,
  minimum = "medium",
  remove = false,
  includePersonalDetails = false,
  cwd = process.cwd(),
) {
  const out = cloneJson(settings);
  out.hooks = out.hooks || {};
  const event = hookEventOf(tool, mode);
  if (!event) return out;
  if (tool === "cursor" || tool === "windsurf") {
    const hooks = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = hooks.filter((hook) => !hasManagedHook(hook, tool, mode, cwd));
    if (!remove) kept.push(managedHook(tool, mode, minimum, includePersonalDetails));
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  } else {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = groups.map((group) => {
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => !hasManagedHook(hook, tool, mode, cwd))
        : [];
      return { ...group, hooks: handlers };
    });
    if (!remove && (tool === "claude" || tool === "gemini" || tool === "codex" || tool === "windsurf")) {
      const matcher = hookMatcher(tool, mode);
      kept.push({ ...(matcher ? { matcher } : {}), hooks: [managedHook(tool, mode, minimum, includePersonalDetails)] });
    }
    const nonempty = kept.filter((group) => group.hooks.length);
    if (nonempty.length) out.hooks[event] = nonempty;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function mergeHook(
  settings,
  tool,
  remove = false,
  minimum = "medium",
  includePersonalDetails = false,
  cwd = process.cwd(),
) {
  // Cursor reads hooks.json only when it carries a version field, so a file Guard starts gets one.
  const needsVersion = tool === "cursor" && !remove && !hasOwn(settings, "version");
  const base = needsVersion ? { version: 1, ...settings } : settings;
  let next = mergeHookMode(base, tool, "prompt", minimum, remove, includePersonalDetails, cwd);
  // No real Codex read event has confirmed this matcher.
  if (READ_TOOLS.has(tool) && tool !== "codex") {
    next = mergeHookMode(next, tool, "read", minimum, remove, includePersonalDetails, cwd);
  }
  if (tool === "claude") next = mergeHookMode(next, tool, "shell", minimum, remove, includePersonalDetails, cwd);
  if (tool === "claude" || tool === "cursor") {
    next = mergeHookMode(next, tool, "tool", minimum, remove, includePersonalDetails, cwd);
    if (tool === "cursor") next = mergeHookMode(next, tool, "shell", minimum, remove, includePersonalDetails, cwd);
  }
  return next;
}

function validateSettingsShape(settings, tool) {
  if (settings.hooks === undefined) return;
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error("invalid-settings");
  }
  const events = new Set(
    [
      PROMPT_EVENTS[tool],
      ...(READ_TOOLS.has(tool) && tool !== "codex" ? [READ_EVENTS[tool]] : []),
      ...(tool === "claude" ? ["PreToolUse"] : []),
      ...(tool === "cursor" ? ["beforeShellExecution", "beforeMCPExecution"] : []),
    ].filter(Boolean),
  );
  const flat = tool === "cursor" || tool === "windsurf";
  for (const event of events) {
    if (!hasOwn(settings.hooks, event)) continue;
    const hooks = settings.hooks[event];
    if (!Array.isArray(hooks)) throw new Error("invalid-settings");
    if (flat) {
      if (hooks.some((hook) => !hook || typeof hook !== "object" || Array.isArray(hook))) {
        throw new Error("invalid-settings");
      }
    } else if (!hooks.every(isHookGroup)) {
      throw new Error("invalid-settings");
    }
  }
}

// A hook group as Claude, Gemini and Codex write one: an object with a `hooks` list.
function isHookGroup(group) {
  return Boolean(group) && typeof group === "object" && !Array.isArray(group) && Array.isArray(group.hooks);
}

function isJsonc(raw) {
  let plain = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quoted) {
      plain += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      plain += char;
    } else if (char === "/" && (raw[index + 1] === "/" || raw[index + 1] === "*")) {
      const block = raw[index + 1] === "*";
      index += 1;
      while (
        index + 1 < raw.length &&
        (block ? !(raw[index] === "*" && raw[index + 1] === "/") : raw[index] !== "\n")
      ) {
        if (raw[index] === "\n" || raw[index] === "\r") plain += raw[index];
        else plain += " ";
        index += 1;
      }
      if (block && index + 1 < raw.length) index += 1;
      else if (block) return false;
      plain += " ";
    } else plain += char;
  }

  let withoutTrailingCommas = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < plain.length; i++) {
    const char = plain[i];
    if (quoted) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      withoutTrailingCommas += char;
    } else if (char === ",") {
      let next = i + 1;
      while (/\s/.test(plain[next] || "")) next += 1;
      withoutTrailingCommas += plain[next] === "]" || plain[next] === "}" ? " " : char;
    } else withoutTrailingCommas += char;
  }
  try {
    JSON.parse(withoutTrailingCommas);
    return true;
  } catch {
    return false;
  }
}

// The indent a settings file was written with: its own, none for one written on one line, else two spaces.
function settingsIndent(raw) {
  const indented = /^([ \t]+)"/m.exec(raw);
  if (indented) return indented[1];
  return raw.trim().length > 2 && !raw.trim().includes("\n") ? 0 : 2;
}

function updateSettings(
  tool,
  {
    project = false,
    dryRun = false,
    remove = false,
    cwd,
    home = userHome(),
    minimum = "medium",
    includePersonalDetails = false,
    platform = process.platform,
    windsurfJetBrains = false,
  } = {},
) {
  if (tool === "cline") {
    return updateClineHooks({ project, cwd, home, dryRun, remove, minimum, includePersonalDetails, platform });
  }
  const file = toolSettingsPath(tool, { project, cwd, home, windsurfJetBrains });
  const root = path.resolve(project ? cwd : home);
  assertNoSymlinkComponents(root, file);
  const read = readSettingsFile(file);
  const { settings } = read;
  try {
    validateSettingsShape(settings, tool);
  } catch (error) {
    error.code = "settings-hooks-shape";
    error.file = file;
    throw error;
  }
  const settingsCwd = cwd || process.cwd();
  const next = mergeHook(settings, tool, remove, minimum, includePersonalDetails, settingsCwd);
  const changed = JSON.stringify(settings) !== JSON.stringify(next);
  const backup = `${file}.clotr-guard.bak`;
  assertNoSymlinkComponents(root, backup);
  const previousBackup = readConfigIfThere(backup);
  const guardAlreadyPresent =
    JSON.stringify(mergeHook(settings, tool, true, minimum, includePersonalDetails, settingsCwd)) !==
    JSON.stringify(settings);
  // A remove on a changed file leaves the backup, so a later setup finds it with no Guard hooks in the file.
  // That backup can be the person's only copy of their original file, so setup keeps it as it is and makes no
  // new one.
  const keptBackup = !remove && changed && Boolean(previousBackup) && !guardAlreadyPresent ? backup : null;
  if (!dryRun && changed) {
    writeSettingsFile({ tool, file, root, backup, next, read, remove, previousBackup, guardAlreadyPresent });
  }
  return settingsResult(tool, { file, changed, next, dryRun, remove, keptBackup, minimum });
}

// What updateSettings did, for the command line and the editors.
function settingsResult(tool, { file, changed, next, dryRun, remove, keptBackup, minimum }) {
  const event = {
    claude: "UserPromptSubmit",
    cursor: "beforeSubmitPrompt",
    gemini: "BeforeAgent",
    codex: "UserPromptSubmit",
    windsurf: "pre_user_prompt",
  }[tool];
  return {
    file,
    changed,
    settings: next,
    dryRun,
    remove,
    event,
    keptBackup,
    minimum: minSeverity(minimum),
    ...(tool === "gemini"
      ? {
          notice:
            "Gemini CLI loads .env files by default. Turn this off with advanced.ignoreLocalEnv in settings.json.",
        }
      : {}),
  };
}

// A settings file's settings, with the indentation, final newline, mode and text it came with; an empty
// object for a file that isn't there. An empty file, one that isn't plain JSON, or one that isn't a JSON object
// throws.
function readSettingsFile(file) {
  const read = { settings: {}, indent: 2, finalNewline: true, fileMode: 0o600, originalContent: null };
  try {
    const existingFile = readConfigFile(file);
    read.originalContent = existingFile.content;
    read.fileMode = existingFile.stat.mode & 0o777;
    const raw = existingFile.content;
    if (raw.trim() === "") {
      const error = new Error("settings-empty");
      error.code = "settings-empty";
      error.file = file;
      throw error;
    }
    try {
      read.settings = JSON.parse(raw);
    } catch (error) {
      if (isJsonc(raw)) {
        error.code = "settings-jsonc";
        error.file = file;
      }
      throw error;
    }
    const { settings } = read;
    if (!settings || Array.isArray(settings) || typeof settings !== "object") throw new Error("invalid-settings");
    // The file keeps the indentation and final newline it came with, so removal leaves it as it was.
    read.indent = settingsIndent(raw);
    read.finalNewline = raw.endsWith("\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return read;
}

// Writes the changed settings: the saved original back when a remove leaves just what it held, else the new
// settings, with a backup of the original the first time Guard adds a hook.
function writeSettingsFile({ tool, file, root, backup, next, read, remove, previousBackup, guardAlreadyPresent }) {
  const { originalContent, fileMode, indent, finalNewline } = read;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertNoSymlinkComponents(root, file);
  assertNoSymlinkComponents(root, backup);
  const restoreOriginal = remove && previousBackup ? restorableBackup(tool, previousBackup, next) : undefined;
  if (restoreOriginal) {
    atomicWriteFile(file, restoreOriginal.content, { mode: restoreOriginal.stat.mode & 0o777 });
    removeFile(backup, true);
    return;
  }
  // Keep the first backup; create one only when Guard adds its first hook to this file.
  if (!remove && originalContent !== null && !guardAlreadyPresent && !previousBackup) {
    atomicWriteFile(backup, originalContent, { mode: fileMode });
  }
  atomicWriteFile(file, `${JSON.stringify(next, null, indent)}${finalNewline ? "\n" : ""}`, { mode: fileMode });
}

// The backup a remove can put back: when it holds what the file holds without Guard's hooks. Undefined for
// none.
function restorableBackup(tool, previousBackup, next) {
  try {
    const originalSettings = JSON.parse(previousBackup.content);
    const restoredSettings = cloneJson(next);
    // Cursor requires a version field, so Guard adds version: 1 to a file that had none. Remove that field
    // with Guard's hooks when restoring the saved original, but keep a version the person already had.
    if (tool === "cursor" && originalSettings.version === undefined && restoredSettings.version === 1) {
      delete restoredSettings.version;
    }
    if (JSON.stringify(originalSettings) === JSON.stringify(restoredSettings)) return previousBackup;
  } catch {
    // A backup that isn't plain JSON can't be restored as settings.
  }
  return undefined;
}

module.exports = {
  mergeHookMode,
  mergeHook,
  validateSettingsShape,
  isJsonc,
  updateSettings,
};

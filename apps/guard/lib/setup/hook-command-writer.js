"use strict";
/* global require, module, process, __dirname */

const fs = require("fs");
const path = require("path");
const { HOOK_TIMEOUT_SECONDS, GUARD_SCRIPT } = require("../limits-and-messages.js");
const { pathInside } = require("../safe-file-writes.js");
const { minSeverity } = require("../text-checks/check-text.js");

// ---------- The Git hook ----------

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
// ---------- Settings files and Node ----------

// Return the actual executable instead of leaving `node` for a hook's later PATH lookup. The workspace is
// excluded because a repository can put its own node.exe or node binary on PATH.
function nodeOnPath(env = process.env, platform = process.platform, cwd = process.cwd()) {
  const extensions = platform === "win32" ? [".exe"] : [""];
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    if (!entry.trim()) continue;
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(directory)) continue;
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (pathInside(cwd, realDirectory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(realDirectory, `node${extension}`);
      try {
        const real = fs.realpathSync(candidate);
        if (!fs.statSync(real).isFile()) continue;
        if (platform !== "win32") fs.accessSync(real, fs.constants.X_OK);
        return real;
      } catch {
        // Keep looking through the absolute PATH entries.
      }
    }
  }
  return null;
}

// The Node that the hook commands name. Inside an Electron host (VS Code's extension host runs setup with
// the editor's own binary as process.execPath) that binary would open a window instead of running a script,
// so the command falls back to the node on PATH.
function nodeCommand({
  env = process.env,
  platform = process.platform,
  electron = process.versions.electron,
  execPath = process.execPath,
  cwd = process.cwd(),
} = {}) {
  if (electron) return nodeOnPath(env, platform, cwd);
  return path.resolve(execPath);
}
// ---------- Hook commands ----------

// PowerShell reads U+2018, U+2019, U+201A and U+201B as single quotes too, so a path like C:\Users\O’Brien
// would end the string early. Doubling each one keeps it inside, as PowerShell reads two quote marks in a row
// as the second.
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

function powershellQuote(value) {
  return `'${String(value).replace(POWERSHELL_QUOTES, "$&$&")}'`;
}

function hookCommand(tool, mode = "prompt", minimum = "medium", includePersonalDetails = false, options = {}) {
  const platform = options.platform || process.platform;
  const node = options.node || nodeCommand(options);
  if (!node) throw new Error("node-not-found");
  const cli = path.resolve(options.script || GUARD_SCRIPT);
  const args = [
    cli,
    hookAction(mode),
    tool,
    "--min-severity",
    minSeverity(minimum),
    ...(includePersonalDetails ? ["--personal-details"] : []),
  ];
  const posixCommand = [node, ...args].map(shellQuote).join(" ");
  const powershellCommand = `& ${[node, ...args].map(powershellQuote).join(" ")}`;
  if (tool === "claude") return { type: "command", command: node, args, timeout: HOOK_TIMEOUT_SECONDS };
  if (tool === "cursor") return { command: platform === "win32" ? powershellCommand : posixCommand };
  if (tool === "gemini") {
    return {
      type: "command",
      command: platform === "win32" ? powershellCommand : posixCommand,
      timeout: HOOK_TIMEOUT_SECONDS * 1000,
    };
  }
  if (tool === "windsurf") {
    return {
      command: posixCommand,
      ...(platform === "win32" ? { powershell: powershellCommand } : {}),
      show_output: true,
    };
  }
  if (tool === "codex") {
    return {
      type: "command",
      command: posixCommand,
      ...(platform === "win32" ? { commandWindows: powershellCommand } : {}),
      timeout: HOOK_TIMEOUT_SECONDS,
    };
  }
  return { type: "command", command: posixCommand, timeout: HOOK_TIMEOUT_SECONDS };
}

// The hook command's action for a hook mode: "read", "shell" and "tool" as they are, "hook" for a prompt's.
function hookAction(mode) {
  if (mode === "read" || mode === "shell" || mode === "tool") return mode;
  return "hook";
}

function managedHook(tool, mode = "prompt", minimum = "medium", includePersonalDetails = false) {
  const command = hookCommand(tool, mode, minimum, includePersonalDetails);
  return command;
}

// ---------- The shell hook's process ----------

function isNpxCachePath(scriptPath = __dirname) {
  return path
    .resolve(scriptPath)
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase() === "_npx");
}

module.exports = {
  shellQuote,
  nodeOnPath,
  nodeCommand,
  powershellQuote,
  hookCommand,
  hookAction,
  managedHook,
  isNpxCachePath,
};

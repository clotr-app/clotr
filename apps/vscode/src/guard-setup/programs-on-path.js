"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const vscode = require("vscode");
const { EXTENSION_FOLDER } = require("../bundled-guard.js");
const { isWithinFolder } = require("../path-within-folder.js");
const { runGuardCommand } = require("./run-guard-command.js");

// ---------- Programs on the PATH ----------

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

// Whether a path is the root or inside it, after following links in both where they still exist.
function isInside(root, candidate) {
  if (!root) return false;
  return isWithinFolder(realPathIfThere(root), realPathIfThere(candidate));
}

function realPathIfThere(file) {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // A workspace or PATH entry may disappear during executable lookup.
    return resolved;
  }
}

// Each absolute PATH folder with its links followed, skipping any inside the workspace.
// It yields one at a time, so a lookup stops reading PATH at the first folder that has the program.
function* pathFolders(env, excludedWorkspace) {
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder || !path.isAbsolute(folder)) continue;
    let realFolder;
    try {
      realFolder = fs.realpathSync(folder);
    } catch {
      continue;
    }
    if (isInside(excludedWorkspace, realFolder)) continue;
    yield realFolder;
  }
}

// An executable from an absolute PATH folder, looked up here rather than by the system,
// so the open workspace can't supply one.
function executable(name, env = process.env, platform = process.platform, excludedWorkspace = null) {
  const names = executableNames(name, platform);
  for (const realFolder of pathFolders(env, excludedWorkspace)) {
    for (const candidate of names.map((item) => path.join(realFolder, item))) {
      const runnable = runnablePath(candidate, platform, excludedWorkspace);
      if (runnable) return runnable;
    }
  }
  return null;
}

// npm is a batch file on Windows, unless a version manager put an .exe there.
function executableNames(name, platform) {
  if (platform !== "win32") return [name];
  if (name === "npm") return ["npm.exe", "npm.cmd"];
  return [`${name}.exe`];
}

// The candidate's real path when it's a file outside the workspace that may run, else null.
function runnablePath(candidate, platform, excludedWorkspace) {
  try {
    if (!isFile(candidate)) return null;
    const realCandidate = fs.realpathSync(candidate);
    if (isInside(excludedWorkspace, realCandidate)) return null;
    if (platform !== "win32") fs.accessSync(realCandidate, fs.constants.X_OK);
    return realCandidate;
  } catch (_error) {
    // Not executable here; keep looking.
    return null;
  }
}

// Whether a command is on the PATH at all, for the Guard picker. Unlike executable(), it doesn't ask
// whether the file may run.
function commandOnPath(name, env = process.env, platform = process.platform, excludedWorkspace = null) {
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const realFolder of pathFolders(env, excludedWorkspace)) {
    for (const candidate of names.map((item) => path.join(realFolder, item))) {
      if (fileOutsideWorkspace(candidate, excludedWorkspace)) return true;
    }
  }
  return false;
}

function fileOutsideWorkspace(candidate, excludedWorkspace) {
  try {
    if (!isFile(candidate)) return false;
    return !isInside(excludedWorkspace, fs.realpathSync(candidate));
  } catch {
    // A PATH entry may change while the picker is open.
    return false;
  }
}

// Guard installed with npm install -g, found through npm root -g the way the JetBrains plugin finds it.
// Hooks that name a global Guard keep working when an update replaces this extension's folder,
// so the copy inside it is only the fallback.
async function globalGuardCli(node, excludedWorkspace = null) {
  const npm = executable("npm", process.env, process.platform, excludedWorkspace);
  if (!npm || !node) return null;
  const npmRoot = npmRootCommand(npm, node);
  if (!npmRoot) return null;
  const [command, args] = npmRoot;
  // From the home folder, so no project's own npm settings take part.
  let result;
  try {
    result = await runGuardCommand(command, args, { cwd: os.homedir() });
  } catch (_error) {
    return null;
  }
  if (result.status !== 0) return null;
  const root = lastLine(result.stdout || "");
  if (!root || !path.isAbsolute(root)) return null;
  const cli = path.join(root, "clotr-guard", "bin", "clotr-guard.js");
  return isFile(cli) ? cli : null;
}

// The command and arguments for npm root -g, or null when npm's own script isn't there.
// Node starts a .cmd file only through a shell, so the npm script beside it runs on Node directly instead.
function npmRootCommand(npm, node) {
  const script = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  const [command, args] = /\.cmd$/i.test(npm) ? [node, [script, "root", "-g"]] : [npm, ["root", "-g"]];
  if (command === node && !isFile(script)) return null;
  return [command, args];
}

// The last line that isn't blank, trimmed.
function lastLine(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

function findNodeCommand({ context }) {
  // ---------- Finding Node ----------

  // The extension host's own process.execPath is the editor's binary, not Node,
  // so the CLI runs on the node from PATH, the same one the written hooks will use.
  // Node 20 or later, else null. A run past the time limit throws.
  async function nodeCommand(workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) {
    const node = context.clotrNodeCommand || executable("node", process.env, process.platform, workspace);
    if (!node) return null;
    try {
      // From this extension's folder, so a version manager's shim doesn't read the workspace's version files.
      const result = await runGuardCommand(node, ["--version"], { cwd: EXTENSION_FOLDER }, 5000);
      const version = /^v?(\d+)\.\d+\.\d+/.exec(result.stdout.trim());
      if (result.status !== 0 || !version) return null;
      return Number(version[1]) >= 20 ? node : null;
    } catch (error) {
      if (error?.code === "ETIMEDOUT") throw error;
      return null;
    }
  }
  return { nodeCommand };
}

module.exports = { isFile, isInside, executable, commandOnPath, globalGuardCli, findNodeCommand };

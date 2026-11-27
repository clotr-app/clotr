"use strict";
/* global require, module, process */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseClotrIgnore, readClotrIgnore } = require("./clotrignore.js");
const { MAX_GIT_DIFF_BUFFER, GIT_TIMEOUT_MS } = require("./limits-and-messages.js");
const { pathInside } = require("./safe-file-writes.js");
const { isRemotePath } = require("./path-forms/windows-paths.js");

// Set once a Git call in this process ran out of time, so the hook can say so.
let gitAnsweredLate = false;

// `lookups`, when given, is an object whose `count` goes up by one for each disk lookup made: one or more for each PATH
// folder until the executable is found, so a long PATH costs more.
function executableOnPath(name, cwd, env = process.env, platform = process.platform, lookups = undefined) {
  const suffixes = platform === "win32" ? [".exe"] : [""];
  const look = () => {
    if (lookups) lookups.count += 1;
  };
  for (const item of (env.PATH || "").split(path.delimiter)) {
    const directory = item.trim().replace(/^"(.*)"$/, "$1");
    if (!directory || !path.isAbsolute(directory)) continue;
    let realDirectory;
    try {
      look();
      realDirectory = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (pathInside(cwd, realDirectory)) continue;
    for (const suffix of suffixes) {
      try {
        look();
        const executable = fs.realpathSync(path.join(realDirectory, `${name}${suffix}`));
        look();
        if (!fs.statSync(executable).isFile() || pathInside(cwd, executable)) continue;
        if (platform !== "win32") {
          look();
          fs.accessSync(executable, fs.constants.X_OK);
        }
        return executable;
      } catch {
        // Skip missing, inaccessible, or non-executable candidates.
      }
    }
  }
  const error = new Error(`${name} wasn't found on an absolute PATH entry`);
  error.code = "ENOENT";
  error.path = `${name}${platform === "win32" ? ".exe" : ""}`;
  throw error;
}

// Runs Git and gives its output. A Git still running after GIT_TIMEOUT_MS is killed, and the call throws with the
// code ETIMEDOUT.
function runGit(args, cwd = process.cwd(), options = {}) {
  try {
    return execFileSync(executableOnPath("git", cwd, process.env, process.platform, options.lookups), args, {
      cwd,
      encoding: options.encoding || "utf8",
      maxBuffer: options.maxBuffer ?? MAX_GIT_DIFF_BUFFER,
      // A failed repository probe (such as MCP started outside a Git project) should stay quiet.
      stdio: options.stdio || "pipe",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if (error.code === "ETIMEDOUT") gitAnsweredLate = true;
    throw error;
  }
}

function gitWasLate() {
  return gitAnsweredLate;
}

function gitRoot(cwd = process.cwd(), lookups = undefined) {
  return runGit(["rev-parse", "--show-toplevel"], cwd, { lookups }).trim();
}

function clotrIgnoreFor(...directories) {
  for (const directory of directories) {
    const found = repositoryIgnore(directory);
    if (found) return found;
  }
  return { root: null, config: parseClotrIgnore("") };
}

// The .clotrignore of the repository `directory` is in, or null outside one. `lookups` (see executableOnPath) counts
// the lookups made finding Git.
function repositoryIgnore(directory, lookups) {
  // Git isn't started in a folder on another computer (see isRemotePath).
  if (!directory || isRemotePath(directory)) return null;
  try {
    const root = gitRoot(directory, lookups);
    return { root, config: readClotrIgnore(root) };
  } catch {
    // A hook outside a repository has no repository ignore file.
    return null;
  }
}

module.exports = {
  executableOnPath,
  runGit,
  gitWasLate,
  gitRoot,
  clotrIgnoreFor,
  repositoryIgnore,
};

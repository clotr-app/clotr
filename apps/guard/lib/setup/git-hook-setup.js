"use strict";
/* global require, module, process */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { GIT_TIMEOUT_MS, GUARD_SCRIPT } = require("../limits-and-messages.js");
const { removeFile, atomicWriteFile, readConfigFile, assertNoSymlinkComponents } = require("../safe-file-writes.js");
const { executableOnPath, runGit, gitRoot } = require("../git-repository.js");
const { shellQuote, nodeCommand } = require("./hook-command-writer.js");

// ---------- The Git hook ----------

// The Guard script a pre-commit hook written by setup runs, or null for any other hook.
function gitHookScript(text) {
  const match = /'((?:[^']|'\\'')*clotr-guard\.js)' commit-check/.exec(text);
  return match ? match[1].replace(/'\\''/g, "'") : null;
}

function isClotrGitHook(text) {
  return gitHookScript(text) !== null || text.includes("clotr-guard commit-check");
}

function gitHookBody(backup, cli = GUARD_SCRIPT) {
  // A Guard that is gone, say an editor's copy an update replaced, lets the commit through with a line rather
  // than refusing every commit until someone finds the hook.
  const missing = "Clotr Guard wasn't found, so this commit wasn't checked. Set up Clotr's Git check again to fix it.";
  const noNode = "Clotr Guard couldn't run because node isn't on PATH, so this commit wasn't checked.";
  // The shell answers 127 when it can't find node. That skips only Clotr's check, so the hook that was there
  // before still runs.
  return `#!/bin/sh\nif [ -f ${shellQuote(cli)} ]; then\n  ${shellQuote(nodeCommand())} ${shellQuote(cli)} commit-check\n  status=$?\n  if [ "$status" -eq 127 ]; then\n    echo ${shellQuote(noNode)} >&2\n  elif [ "$status" -ne 0 ]; then\n    exit "$status"\n  fi\nelse\n  echo ${shellQuote(missing)} >&2\nfi\nif [ -x ${shellQuote(backup)} ]; then exec ${shellQuote(backup)} "$@"; fi\nexit 0\n`;
}

function gitHookPaths(cwd = process.cwd()) {
  const root = gitRoot(cwd);
  const configuredHooksPath = spawnSync(executableOnPath("git", cwd), ["config", "--path", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const commonDirValue = runGit(["rev-parse", "--git-common-dir"], root).trim();
  const commonDir = path.isAbsolute(commonDirValue) ? commonDirValue : path.resolve(root, commonDirValue);
  const standardHooks = path.resolve(commonDir, "hooks");
  if (configuredHooksPath.status === 0) {
    const configured = path.isAbsolute(configuredHooksPath.stdout.trim())
      ? path.resolve(configuredHooksPath.stdout.trim())
      : path.resolve(root, configuredHooksPath.stdout.trim());
    if (configured !== standardHooks) throw new Error("custom-hooks-path");
  }
  const hook = path.join(standardHooks, "pre-commit");
  return { root, commonDir, hook, backup: `${hook}.clotr-guard.bak` };
}

function setupGit({ cwd = process.cwd(), remove = false, dryRun = false } = {}) {
  const { commonDir, hook, backup } = gitHookPaths(cwd);
  const commonStat = fs.lstatSync(commonDir);
  if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) throw new Error("unsafe-git-hooks-path");
  assertNoSymlinkComponents(commonDir, hook);
  assertNoSymlinkComponents(commonDir, backup);
  const existingFile = readConfigIfThere(hook);
  const backupFile = readConfigIfThere(backup);
  const existing = existingFile?.content ?? null;
  if (remove) return removeGitHook({ hook, backup, existing, backupFile, dryRun });
  const body = gitHookBody(backup);
  const existingScript = existing === null ? null : gitHookScript(existing);
  const exactClotrHook = existingScript !== null && existing === gitHookBody(backup, existingScript);
  if (existing !== null && isClotrGitHook(existing)) {
    // Rewrite an exact hook from an older install path. Other hooks, including one that merely calls Guard or
    // has been edited since setup, keep their text and their backup.
    if (!exactClotrHook || existing === body) return { hook, changed: false, remove: false };
    if (!dryRun) {
      atomicWriteFile(hook, body, { mode: 0o755 });
      fs.chmodSync(hook, 0o755);
    }
    return { hook, changed: true, remove: false, dryRun };
  }
  if (!exactClotrHook && backupFile) {
    // A same-named backup is user-owned unless the hook beside it is an exact Clotr hook. Never consume one
    // just because it happens to contain the same bytes as the current hook.
    throw new Error("hook-backup-exists");
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    assertNoSymlinkComponents(commonDir, hook);
    assertNoSymlinkComponents(commonDir, backup);
    if (existingFile && !backupFile) {
      atomicWriteFile(backup, existingFile.content, { mode: existingFile.stat.mode & 0o777 });
    }
    atomicWriteFile(hook, body, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
  }
  return { hook, changed: true, remove: false, dryRun };
}

// `remove git`. Only Clotr's own hook comes out. A hook the person wrote around the command, or one another
// tool put there after setup, stays, and so does the backup beside it.
function removeGitHook({ hook, backup, existing, backupFile, dryRun }) {
  const script = existing === null ? null : gitHookScript(existing);
  if (existing !== null && (script === null || existing !== gitHookBody(backup, script))) {
    return { hook, changed: false, remove: true, kept: true };
  }
  // A preview reports what remove would do and leaves the hook and its backup where they are.
  if (existing !== null && dryRun) return { hook, changed: true, remove: true, dryRun };
  if (existing !== null && backupFile) {
    removeFile(hook, true);
    fs.renameSync(backup, hook);
    return { hook, changed: true, remove: true };
  }
  if (existing !== null) {
    removeFile(hook);
    return { hook, changed: true, remove: true };
  }
  return { hook, changed: false, remove: true };
}

// ---------- Reading config files ----------

// A config file as readConfigFile reads it, or null when there's nothing at the path.
function readConfigIfThere(file) {
  try {
    return readConfigFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

module.exports = {
  gitHookScript,
  isClotrGitHook,
  gitHookBody,
  gitHookPaths,
  setupGit,
  readConfigIfThere,
};

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { guard, EXTENSION_FOLDER, BUNDLED_CLI } = require("../bundled-guard.js");
const { guardArgs, runGuard } = require("./run-guard-command.js");
const { isFile, isInside, globalGuardCli } = require("./programs-on-path.js");
const manifest = require("../../package.json");

// ---------- Hooks in an old version's folder ----------

const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`.toLowerCase();

// Whether a hook's Guard sits in another version's folder of this extension. In this editor's extensions
// folder any other version counts, since the editor removes it after an update. Elsewhere, such as another
// editor that shares the settings files, only a copy that's already gone does.
function inOldExtensionFolder(script) {
  // The script is <extension folder>/guard/bin/clotr-guard.js.
  const extensionFolder = path.dirname(path.dirname(path.dirname(script)));
  const folderName = path.basename(extensionFolder).toLowerCase();
  if (!folderName.startsWith(`${EXTENSION_ID}-`)) return false;
  if (folderName === path.basename(EXTENSION_FOLDER).toLowerCase()) return false;
  const besideThisOne = path.relative(path.dirname(EXTENSION_FOLDER), path.dirname(extensionFolder)) === "";
  return besideThisOne || !isFile(script);
}

// The open workspace's Git hook, read from its file and only in a trusted workspace.
// Each repository has its own hook, so it's read in every window, not only the first one after an update.
function staleGitHook(workspace) {
  if (!workspace || !vscode.workspace.isTrusted) return false;
  const hook = path.join(workspace, ".git", "hooks", "pre-commit");
  const script = isFile(hook) ? guard.gitHookScript(fs.readFileSync(hook, "utf8")) : null;
  return Boolean(script && inOldExtensionFolder(script));
}

// ---------- Setting stale hooks up again ----------

const QUIET_REWRITE_ATTEMPTS = 4;

// More than one workspace folder, or a workspace holding this extension or the home folder.
function workspaceCouldReachGuard(workspace) {
  const folders = vscode.workspace.workspaceFolders?.length || 0;
  if (folders > 1) return true;
  return [EXTENSION_FOLDER, os.homedir()].some((folder) => isInside(workspace, folder));
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function guardHooksAfterUpdate({ context, t, hostPlatform, nodeCommand, configureGuard }) {
  // ---------- Hooks after an update ----------

  // An assistant whose Clotr hooks name another version's folder, with the options they all share,
  // or null options when they don't share one set.
  // Cline's hooks don't run on Windows, so they're left alone there.
  function staleAssistant(tool, home) {
    if (tool === "cline" && hostPlatform === "win32") return null;
    const hooks = guard.managedHooks(tool, { home });
    if (!hooks.some((entry) => inOldExtensionFolder(entry.script))) return null;
    const sets = new Set(hooks.map((entry) => `${entry.minimum} ${entry.includePersonalDetails}`));
    const [{ minimum, includePersonalDetails }] = hooks;
    return { tool, options: sets.size === 1 ? { minimum, personalDetails: includePersonalDetails } : null };
  }
  function staleAssistants(home) {
    return guard.IMPLEMENTED_TOOL_NAMES.map((tool) => staleAssistant(tool, home)).filter(Boolean);
  }
  // One tool's stale hooks set up again, true once they're done.
  // Windows refuses to replace a file while another process has it open, such as a second window's Guard
  // reading the same settings after an update, so a failed run is tried again a few times before it counts.
  // A failed run can leave a file the re-read skips, so the same run is tried again rather than read afresh.
  async function rewriteStaleHook(node, cli, tool, home, workspace) {
    // Read again, since another window may have set this one up meanwhile.
    const options = staleHookOptions(tool, home, workspace);
    if (!options) return true;
    const cwd = tool === "git" ? workspace : EXTENSION_FOLDER;
    for (let attempt = 1; ; attempt += 1) {
      const result = await runGuard(node, guardArgs(cli, tool, options), cwd, home);
      if (result.status === 0) return true;
      if (attempt === QUIET_REWRITE_ATTEMPTS) return false;
      // A little longer before each try.
      await pause(250 * attempt);
    }
  }
  // The options to set a tool's hooks up again with, or a falsy value once they aren't stale.
  // Git's hook takes no options, so it gets {}.
  function staleHookOptions(tool, home, workspace) {
    if (tool === "git") return staleGitHook(workspace) && {};
    return staleAssistant(tool, home)?.options;
  }
  // Sets Clotr's stale hooks up again with the Guard that setup picks, each with its own options,
  // without asking.
  // Assistants' hooks live in the home folder, so Guard runs from this extension's folder, and in a workspace
  // that isn't trusted only when nothing it uses can come from the workspace. There it's always the copy
  // inside this extension, since npm starts through whichever node comes first on PATH.
  // It stops at the first failure and returns false when any run failed or couldn't start,
  // so the update stays open for the question.
  async function rewriteStaleHooks(home, workspace, assistants) {
    const trusted = vscode.workspace.isTrusted;
    if (!trusted && workspaceCouldReachGuard(workspace)) return true;
    const jobs = assistants.filter((entry) => entry.options);
    if (staleGitHook(workspace)) jobs.push({ tool: "git" });
    if (!jobs.length) return true;
    try {
      const node = await nodeCommand(workspace);
      if (!node) return false;
      const globalCli = trusted ? await globalGuardCli(node, workspace) : null;
      const cli = globalCli || BUNDLED_CLI;
      for (const { tool } of jobs) {
        if (!(await rewriteStaleHook(node, cli, tool, home, workspace))) return false;
      }
      return true;
    } catch (_error) {
      // A timeout or a Guard that won't start leaves the hooks to the question.
      return false;
    }
  }
  let repairPromptShown = false;
  // An update removes the old extension folder, leaving hooks that name a script that's gone.
  // The update counts as done once no assistant's Clotr hook names an old folder and no quiet Guard run
  // has failed since it. A failed run can leave a hook file the re-read skips, such as Cline's second one
  // when it can't be read, so the failure is kept and asks on every start until setup runs again.
  async function repairGuardHooks() {
    if (repairPromptShown) return;
    const updated = context.globalState.get("extensionVersion") !== manifest.version;
    const home = context.clotrGuardHome || os.homedir();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rewritten = await rewriteStaleHooks(home, workspace, updated ? staleAssistants(home) : []);
    if (!rewritten && updated) await context.globalState.update("guardRewriteFailed", true);
    const failed = !rewritten || (updated && context.globalState.get("guardRewriteFailed", false));
    function hooksLeft() {
      return updated && staleAssistants(home).length > 0;
    }
    async function markIfDone() {
      if (!updated || hooksLeft()) return;
      await context.globalState.update("guardRewriteFailed", undefined);
      await context.globalState.update("extensionVersion", manifest.version);
    }
    if (!failed) await markIfDone();
    if (!failed && !hooksLeft() && !staleGitHook(workspace)) return;
    repairPromptShown = true;
    const action = t("guardMovedAction");
    // A closed question asks again next time:
    // until the hooks are set up again, they run a script that's gone.
    if ((await vscode.window.showInformationMessage(t("guardMoved"), action)) !== action) return;
    if (await configureGuard()) await markIfDone();
  }
  const repairTimer = setTimeout(() => void repairGuardHooks().catch(() => {}), 0);
  return { repairTimer };
}

module.exports = { guardHooksAfterUpdate };

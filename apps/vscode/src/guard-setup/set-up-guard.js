"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { guard, BUNDLED_CLI } = require("../bundled-guard.js");
const { config } = require("../clotr-settings.js");
const { guardArgs, runGuard } = require("./run-guard-command.js");
const { commandOnPath, globalGuardCli } = require("./programs-on-path.js");

// ---------- Words for the picker and the preview ----------

// The names people know each assistant by, for the picker; Guard's CLI still gets the short tool name.
const TOOL_LABELS = {
  claude: "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  codex: "Codex CLI",
  windsurf: "Windsurf",
  cline: "Cline",
  git: "Git",
};

function toolChoiceKey(remove, configured, detected) {
  if (remove) return configured ? "guardHooksFound" : "guardHooksNotFound";
  return detected ? "assistantDetected" : "assistantNotFound";
}

function gitPreviewKey(firstLine, remove) {
  if (firstLine.includes("(no change)")) return "guardGitNoChange";
  return remove ? "guardGitWillRemove" : "guardGitWillAdd";
}

function setUpGuard({ context, t, editor, hostPlatform, nodeCommand }) {
  // ---------- Setting up Guard ----------

  // The setup flow, with its two lists and its preview. True once the change is applied.
  async function configureGuard() {
    // Setup runs the Guard CLI in the workspace and writes hooks into its repository,
    // which an untrusted one gets only once the person trusts it.
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showInformationMessage(t("guardNeedsTrust"));
      return false;
    }
    const home = context.clotrGuardHome || os.homedir();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      await vscode.window.showInformationMessage(t("guardWorkspaceRequired"));
      return false;
    }
    const node = await nodeForSetup(workspace);
    if (!node) return false;
    const operation = await vscode.window.showQuickPick(
      [
        { label: t("guardSetUpChoice"), remove: false },
        { label: t("guardRemoveChoice"), remove: true },
      ],
      { placeHolder: t("chooseGuardAction") },
    );
    if (!operation) return false;
    const remove = operation.remove;
    const selected = await vscode.window.showQuickPick(guardToolChoices(remove, home, workspace), {
      canPickMany: true,
      placeHolder: t("chooseAssistants"),
    });
    if (!selected?.length) return false;
    const cli = (await globalGuardCli(node, workspace)) || BUNDLED_CLI;
    const options = { remove, minimum: config().get("minSeverity", "medium") };
    options.personalDetails = config().get("personalDetailsInFiles", false);
    function argsFor(tool, dryRun) {
      return guardArgs(cli, tool, { ...options, dryRun });
    }
    // A dry run for each tool first, shown together for one yes.
    const previews = [];
    for (const { label, tool } of selected) {
      const result = await runSetupStep(node, argsFor(tool, true), workspace, home, "guardPreviewError");
      if (!result) return false;
      previews.push(`${label}:\n${localizedGuardPreview(tool, result.stdout.trim(), remove)}`);
    }
    const action = t("applyGuardChange");
    const confirm = await vscode.window.showWarningMessage(
      `${t(remove ? "guardRemovePreview" : "guardSetupPreview")}\n${previews.join("\n\n")}`,
      { modal: true },
      action,
    );
    if (confirm !== action) return false;
    for (const { tool } of selected) {
      const result = await runSetupStep(node, argsFor(tool, false), workspace, home, "guardApplyError");
      if (!result) return false;
    }
    await vscode.window.showInformationMessage(t(remove ? "guardRemoved" : "guardUpdated"));
    return true;
  }
  // Node for setup, or null after saying why there's none.
  async function nodeForSetup(workspace) {
    let node;
    try {
      node = await nodeCommand(workspace);
    } catch (error) {
      if (error?.code === "ETIMEDOUT") {
        await vscode.window.showErrorMessage(t("guardTimeout"));
        return null;
      }
    }
    if (!node) {
      await vscode.window.showInformationMessage(t("nodeRequired"));
      return null;
    }
    return node;
  }
  // The second list. For setup, each assistant found here starts ticked; for removal, each with Clotr hooks.
  // Git comes last and starts unticked.
  function guardToolChoices(remove, home, workspace) {
    // Cline hooks don't run on Windows, so there it's offered only for removing hooks set up elsewhere.
    const tools = guard.IMPLEMENTED_TOOL_NAMES.filter((tool) => tool !== "cline" || hostPlatform !== "win32" || remove);
    const choices = tools.map((tool) => guardToolChoice(tool, remove, home, workspace));
    choices.push({
      label: TOOL_LABELS.git,
      tool: "git",
      description: t(remove ? "gitRemoveAvailable" : "gitAvailable"),
      picked: false,
    });
    return choices;
  }
  function guardToolChoice(tool, remove, home, workspace) {
    const detected = assistantFound(tool, home, workspace);
    const configured = remove && guard.managedHooks(tool, { home }).length > 0;
    return {
      label: TOOL_LABELS[tool] || tool,
      tool,
      description: t(toolChoiceKey(remove, configured, detected)),
      picked: remove ? configured : detected,
    };
  }
  // Whether an assistant is on this computer: it's this editor, its settings folder exists,
  // its command is on PATH, or (for Cline) its extension is installed.
  function assistantFound(tool, home, workspace) {
    const settingsFolder = path.dirname(guard.toolSettingsPath(tool, { home }));
    const editorTool = { Cursor: "cursor", Windsurf: "windsurf" }[editor];
    if (tool === editorTool || fs.existsSync(settingsFolder)) return true;
    const command = { claude: "claude", codex: "codex", gemini: "gemini" }[tool];
    if (command && commandOnPath(command, context.clotrEnv || process.env, hostPlatform, workspace)) return true;
    return tool === "cline" && Boolean(vscode.extensions?.getExtension?.("saoudrizwan.claude-dev"));
  }
  // One Guard run in setup: its result, or null after saying it timed out or failed.
  async function runSetupStep(node, args, workspace, home, errorKey) {
    let result;
    try {
      result = await runGuard(node, args, workspace, home);
    } catch (error) {
      await vscode.window.showErrorMessage(t(error?.code === "ETIMEDOUT" ? "guardTimeout" : errorKey));
      return null;
    }
    if (result.status !== 0) {
      await vscode.window.showErrorMessage(t(errorKey));
      return null;
    }
    return result;
  }
  // Guard's dry-run output in this editor's language. An assistant's preview keeps Guard's first line
  // and the JSON it would write. Git's becomes a sentence from the word files.
  function localizedGuardPreview(tool, output, remove) {
    const firstLine = output.split(/\r?\n/, 1)[0];
    if (tool !== "git") {
      const jsonStart = output.indexOf("\n{");
      return jsonStart < 0 ? t("guardAssistantPreview") : `${firstLine}\n${output.slice(jsonStart + 1).trim()}`;
    }
    const kept = /^Clotr left the pre-commit hook at (.+?) as it was/.exec(firstLine);
    if (kept) return t("guardGitKept").replace("{0}", kept[1]);
    const hook = /^(?:Set up|Removed) Git pre-commit hook at (.+?)(?: \(no change\))?\.$/.exec(firstLine);
    if (!hook) return t("guardPreviewError");
    return t(gitPreviewKey(firstLine, remove)).replace("{0}", hook[1]);
  }
  return { configureGuard };
}

module.exports = { setUpGuard };

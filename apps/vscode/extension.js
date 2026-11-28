"use strict";

// The VS Code extension. It checks open files, the clipboard and selections, and sets up Guard.

// ---------- What it loads ----------

const path = require("path");
const vscode = require("vscode");
const { editorName, editorLanguage } = require("./src/editor-name.js");
const { skipListMatches } = require("./src/open-files/skipped-files.js");
const { runGuardCommand } = require("./src/guard-setup/run-guard-command.js");
const { executable, globalGuardCli, findNodeCommand } = require("./src/guard-setup/programs-on-path.js");
const { projectClotrIgnore } = require("./src/open-files/project-clotrignore.js");
const { uriKey, documentFor, openFileFindings } = require("./src/open-files/open-file-findings.js");
const { checkOpenFile } = require("./src/open-files/check-open-file.js");
const { recheckOpenFiles } = require("./src/open-files/recheck-open-files.js");
const { secretFileNote } = require("./src/secret-files-and-gitignore/secret-file-note.js");
const { statusBarAndFindingsView } = require("./src/findings-and-quick-fixes/findings-view.js");
const { moveToEnvFix } = require("./src/findings-and-quick-fixes/move-to-env.js");
const { quickFixes } = require("./src/findings-and-quick-fixes/quick-fixes.js");
const { checkClipboardAndSelection } = require("./src/commands/check-clipboard-and-selection.js");
const { welcomeAndTryIt } = require("./src/commands/welcome-and-try-it.js");
const { setUpGuard } = require("./src/guard-setup/set-up-guard.js");
const { guardHooksAfterUpdate } = require("./src/guard-setup/guard-hooks-after-update.js");
const { vscodeEngine } = require("./src/vscode-engine.js");

function activate(context) {
  // ---------- Words and the editor ----------

  const { t, findingName } = editorLanguage();
  const editor = editorName(vscode.env.appName, vscode.env.uriScheme);
  const hostPlatform = context.clotrPlatform || process.platform;

  // ---------- What Clotr keeps for the open files ----------

  const state = context.workspaceState;

  // ---------- The engine ----------

  const engine = vscodeEngine({ state });
  if (!engine) {
    vscode.window.showWarningMessage(t("startError"));
    return { dispose() {} };
  }
  const { host, checkWithDetection } = engine;

  const {
    diagnostics,
    diagnosticData,
    ignoredOnce,
    checkedDocuments,
    unchecked,
    disabled,
    addDiagnostic,
    markUnchecked,
    findingDiagnostics,
    findingForAction,
  } = openFileFindings({ state, t, editor, findingName, host });
  const { clotrIgnoreCache, clotrIgnoreForDocument, clotrIgnoreForWorkspace } = projectClotrIgnore();
  const { workspaceSecretScanned, checkWorkspaceSecrets, offerGitIgnore } = secretFileNote({ state, t });
  const { analyze } = checkOpenFile({
    t,
    host,
    checkWithDetection,
    clotrIgnoreForDocument,
    diagnostics,
    diagnosticData,
    ignoredOnce,
    checkedDocuments,
    unchecked,
    disabled,
    markUnchecked,
    addDiagnostic,
  });

  const { status, findingEmitter, findingView, updateStatus } = statusBarAndFindingsView({
    t,
    diagnosticData,
    findingDiagnostics,
    checkedDocuments,
    unchecked,
    disabled,
  });
  const { pendingDocuments, refreshAll, schedule, cancelRecheck } = recheckOpenFiles({
    analyze,
    markUnchecked,
    t,
    findingEmitter,
    updateStatus,
    checkWorkspaceSecrets,
  });

  const { moveToEnv, canMoveToEnv } = moveToEnvFix({
    t,
    host,
    findingForAction,
    diagnosticData,
    clotrIgnoreForDocument,
    analyze,
    findingEmitter,
    updateStatus,
    offerGitIgnore,
  });

  const { actions, addToClotrIgnore } = quickFixes({
    t,
    diagnosticData,
    clotrIgnoreForDocument,
    canMoveToEnv,
    findingForAction,
    clotrIgnoreCache,
    refreshAll,
  });
  const { checkClipboard, checkSelection } = checkClipboardAndSelection({
    t,
    findingName,
    host,
    checkWithDetection,
    clotrIgnoreForDocument,
    clotrIgnoreForWorkspace,
  });
  const { tryIt, showWelcome } = welcomeAndTryIt({ context, t, editor, analyze, findingEmitter, updateStatus });
  const { nodeCommand } = findNodeCommand({ context });
  const { configureGuard } = setUpGuard({ context, t, editor, hostPlatform, nodeCommand });

  // ---------- Starting up ----------

  registerCommandsAndEvents();
  refreshAll();
  void showWelcome().catch(() => {});
  const { repairTimer } = guardHooksAfterUpdate({ context, t, hostPlatform, nodeCommand, configureGuard });

  // ---------- Commands, the view and events ----------

  // Hands VS Code the diagnostics, the status bar, the view, the quick fixes, every command and every event,
  // in this order. Each goes into context.subscriptions, so VS Code disposes of it with the extension.
  function registerCommandsAndEvents() {
    context.subscriptions.push(
      diagnostics,
      status,
      findingView,
      findingEmitter,
      vscode.languages.registerCodeActionsProvider({ scheme: "file" }, actions, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
    context.subscriptions.push(vscode.commands.registerCommand("clotr.ignore", ignoreOccurrence));
    context.subscriptions.push(vscode.commands.registerCommand("clotr.addToClotrIgnore", addToClotrIgnore));
    context.subscriptions.push(vscode.commands.registerCommand("clotr.moveToEnv", moveToEnv));
    context.subscriptions.push(
      vscode.commands.registerCommand("clotr.turnOffFile", turnOffFile),
      vscode.commands.registerCommand("clotr.turnOnFile", turnOnFile),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("clotr.focusView", () =>
        vscode.commands.executeCommand("workbench.view.explorer"),
      ),
    );
    const ignoreWatcher = vscode.workspace.createFileSystemWatcher("**/.clotrignore");
    context.subscriptions.push(
      ignoreWatcher,
      ignoreWatcher.onDidCreate(recheckAfterIgnoreChange),
      ignoreWatcher.onDidChange(recheckAfterIgnoreChange),
      ignoreWatcher.onDidDelete(recheckAfterIgnoreChange),
    );
    context.subscriptions.push(vscode.commands.registerCommand("clotr.setupGuard", () => configureGuard()));
    context.subscriptions.push(vscode.commands.registerCommand("clotr.tryIt", tryIt));
    context.subscriptions.push(vscode.commands.registerCommand("clotr.checkClipboard", checkClipboard));
    context.subscriptions.push(vscode.commands.registerCommand("clotr.checkSelection", checkSelection));
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => schedule(document)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        workspaceSecretScanned.delete(uriKey(event.document.uri));
        schedule(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument(forgetClosedFile),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("clotr")) refreshAll();
      }),
    );
  }

  // Ignores one occurrence, then checks the file again.
  async function ignoreOccurrence(uri, occurrence, fingerprint) {
    const key = uriKey(uri);
    const byOccurrence = ignoredOnce.get(key) || new Map();
    byOccurrence.set(occurrence, fingerprint);
    ignoredOnce.set(key, byOccurrence);
    const doc = documentFor(uri);
    if (doc) analyze(doc);
    findingEmitter.fire();
    updateStatus();
  }
  async function turnOffFile(uri) {
    disabled.add(uriKey(uri));
    await state.update("disabledFiles", [...disabled]);
    diagnostics.delete(uri);
    const key = uriKey(uri);
    diagnosticData.delete(key);
    ignoredOnce.delete(key);
    checkedDocuments.delete(key);
    unchecked.delete(key);
    findingEmitter.fire();
    updateStatus();
  }
  // Undoes Turn off for this file: from the Command Palette it takes the file in the active editor.
  async function turnOnFile(uri) {
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (!target || !disabled.delete(uriKey(target))) return;
    await state.update("disabledFiles", [...disabled]);
    const doc = documentFor(target);
    if (doc) analyze(doc);
    findingEmitter.fire();
    updateStatus();
  }
  function recheckAfterIgnoreChange(uri) {
    clotrIgnoreCache.delete(path.resolve(path.dirname(uri.fsPath)));
    // Open files keep findings from the old rules until they're checked again,
    // so check them on the usual debounce.
    for (const document of vscode.workspace.textDocuments) pendingDocuments.set(uriKey(document.uri), document);
    schedule();
  }
  // The close event is the document itself; a { document } wrapper works too.
  function forgetClosedFile(event) {
    const document = event?.uri ? event : event?.document;
    if (!document?.uri) return;
    diagnostics.delete(document.uri);
    const key = uriKey(document.uri);
    pendingDocuments.delete(key);
    diagnosticData.delete(key);
    ignoredOnce.delete(key);
    checkedDocuments.delete(key);
    unchecked.delete(key);
    workspaceSecretScanned.delete(key);
    findingEmitter.fire();
    updateStatus();
  }

  // ---------- Shutting down ----------

  return {
    dispose() {
      cancelRecheck();
      clearTimeout(repairTimer);
      diagnostics.dispose();
      status.dispose();
      findingView.dispose();
      findingEmitter.dispose();
    },
  };
}

module.exports = { activate, executable, globalGuardCli, runGuardCommand, skipListMatches };

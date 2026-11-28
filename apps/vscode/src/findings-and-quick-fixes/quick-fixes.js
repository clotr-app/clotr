"use strict";

const path = require("path");
const vscode = require("vscode");
const { guard } = require("../bundled-guard.js");
const { SOURCE, uriKey, documentFor, diagnosticKey } = require("../open-files/open-file-findings.js");

// ---------- Diagnostics and quick fixes ----------

// A quick fix that runs a command. Turning a file off fixes no one finding, so it names none.
function quickFix(title, diagnostic, command, args) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  if (diagnostic) action.diagnostics = [diagnostic];
  action.command = { command, title: action.title, arguments: args };
  return action;
}

function quickFixes({
  t,
  diagnosticData,
  clotrIgnoreForDocument,
  canMoveToEnv,
  findingForAction,
  clotrIgnoreCache,
  refreshAll,
}) {
  // ---------- Quick fixes ----------

  const actions = {
    provideCodeActions(document, _range, ctx) {
      return ctx.diagnostics
        .filter((diagnostic) => isClotrFinding(document, diagnostic))
        .flatMap((diagnostic) => quickFixesFor(document, diagnostic));
    },
  };
  function isClotrFinding(document, diagnostic) {
    if (diagnostic.source !== SOURCE) return false;
    return diagnosticData.get(uriKey(document.uri))?.has(diagnosticKey(diagnostic));
  }
  // The fixes on one finding, in menu order: ignore once, add to .clotrignore when the project's file
  // is valid, move to .env when that's safe, then turn checking off for the file.
  function quickFixesFor(document, diagnostic) {
    const occurrence = diagnosticKey(diagnostic);
    const detail = diagnosticData.get(uriKey(document.uri)).get(occurrence);
    const ignore = quickFix(t("ignoreOne"), diagnostic, "clotr.ignore", [document.uri, occurrence, detail.fingerprint]);
    const off = quickFix(t("turnOffFile"), null, "clotr.turnOffFile", [document.uri]);
    const result = [ignore];
    const ignoreTarget = clotrIgnoreForDocument(document);
    if (ignoreTarget.root && ignoreTarget.config.valid) {
      const title = t("addFingerprintToIgnore");
      result.push(quickFix(title, diagnostic, "clotr.addToClotrIgnore", [document.uri, occurrence]));
    }
    if (canMoveToEnv(document, diagnostic, detail)) {
      result.push(quickFix(t("moveToEnv"), diagnostic, "clotr.moveToEnv", [document.uri, occurrence]));
    }
    return [...result, off];
  }
  async function addToClotrIgnore(uri, occurrence) {
    const document = documentFor(uri);
    if (!document) return;
    const finding = findingForAction(document, occurrence);
    const root = clotrIgnoreForDocument(document).root;
    if (!finding || !root) return;
    // Guard's writer: the salt sits in the committed file, so it refuses values that are easy to guess.
    try {
      if (!guard.addIgnoredValue(root, finding.value, finding.kind)) return;
    } catch (error) {
      const warning = error.message === "guessable-value" ? "clotrIgnoreGuessable" : "clotrIgnoreWriteError";
      await vscode.window.showWarningMessage(t(warning));
      return;
    }
    clotrIgnoreCache.delete(path.resolve(root));
    refreshAll();
  }
  return { actions, addToClotrIgnore };
}

module.exports = { quickFixes };

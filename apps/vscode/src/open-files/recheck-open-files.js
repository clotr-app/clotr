"use strict";

const vscode = require("vscode");
const { uriKey } = require("./open-file-findings.js");

function recheckOpenFiles({ analyze, markUnchecked, t, findingEmitter, updateStatus, checkWorkspaceSecrets }) {
  let timer;
  let refreshing = false;
  const pendingDocuments = new Map();

  // ---------- Checking again ----------

  // How long typing must pause before the changed files are checked again.
  const RECHECK_DELAY_MS = 250;

  function refreshAll() {
    clearTimeout(timer);
    timer = undefined;
    pendingDocuments.clear();
    analyzeEach(vscode.workspace.textDocuments);
    findingEmitter.fire();
    updateStatus();
    void checkWorkspaceSecrets();
  }
  function refreshDirty() {
    timer = undefined;
    const documents = [...pendingDocuments.values()];
    pendingDocuments.clear();
    if (!documents.length) return;
    analyzeEach(documents);
    findingEmitter.fire();
    updateStatus();
    void checkWorkspaceSecrets(documents);
  }
  function analyzeEach(documents) {
    refreshing = true;
    try {
      for (const doc of documents) analyzeOrMarkFailed(doc);
    } finally {
      refreshing = false;
    }
  }
  // One document that fails to check keeps its last findings rather than stopping every later check.
  function analyzeOrMarkFailed(doc) {
    try {
      analyze(doc);
    } catch (_error) {
      try {
        markUnchecked(doc, t("fileCheckFailed"));
      } catch (_markError) {
        // A failed status update must not interfere with the editor.
      }
    }
  }
  function schedule(document) {
    if (refreshing) return;
    if (document) pendingDocuments.set(uriKey(document.uri), document);
    clearTimeout(timer);
    timer = setTimeout(refreshDirty, RECHECK_DELAY_MS);
  }
  // Stops a recheck that's waiting, so nothing outside this group reads the timer.
  function cancelRecheck() {
    clearTimeout(timer);
  }
  return { pendingDocuments, refreshAll, schedule, cancelRecheck };
}

module.exports = { recheckOpenFiles };

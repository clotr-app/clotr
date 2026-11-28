"use strict";

const path = require("path");
const vscode = require("vscode");
const { uriKey, diagnosticKey } = require("../open-files/open-file-findings.js");

function statusBarAndFindingsView({ t, diagnosticData, findingDiagnostics, checkedDocuments, unchecked, disabled }) {
  // ---------- The status bar and the findings view ----------

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "clotr.focusView";
  status.tooltip = t("statusProtected").replace("{0}", "0").replace("{1}", "0");
  const findingEmitter = new vscode.EventEmitter();
  // The Clotr list in the Explorer: each open file with findings, and its findings under it.
  const treeProvider = {
    onDidChangeTreeData: findingEmitter.event,
    getChildren(element) {
      if (element?.document) {
        return element.findings
          .filter((finding) => diagnosticData.get(uriKey(element.document.uri))?.has(diagnosticKey(finding)))
          .map((finding) => ({ document: element.document, finding }));
      }
      return vscode.workspace.textDocuments
        .map((document) => ({ document, findings: findingDiagnostics(document) }))
        .filter((entry) => entry.findings.length);
    },
    getTreeItem(element) {
      if (!element.finding) {
        return new vscode.TreeItem(
          path.basename(element.document.uri.fsPath),
          vscode.TreeItemCollapsibleState.Expanded,
        );
      }
      // A finding shows the first line of its message and opens the file at it.
      const item = new vscode.TreeItem(element.finding.message.split(/\r?\n/, 1)[0]);
      item.command = {
        command: "vscode.open",
        title: t("openFinding"),
        arguments: [element.document.uri, { selection: element.finding.range }],
      };
      return item;
    },
  };
  const findingView = vscode.window.createTreeView("clotr.findings", { treeDataProvider: treeProvider });
  function updateStatus() {
    const count = vscode.workspace.textDocuments.reduce((sum, doc) => sum + findingDiagnostics(doc).length, 0);
    const files = checkedDocuments.size;
    const findingWord = t(count === 1 ? "statusFinding" : "statusFindings");
    const fileWord = t(files === 1 ? "statusFile" : "statusFiles");
    const findingsPart = count ? ` · ${count} ${findingWord}` : "";
    status.text = `$(shield) Clotr · ${files} ${fileWord}${findingsPart}`;
    if (unchecked.size) {
      status.text += ` ! ${t("statusNotChecked").replace("{0}", String(unchecked.size))}`;
      status.tooltip = t("statusUnchecked").replace("{0}", String(unchecked.size));
    } else {
      status.tooltip = t("statusProtected").replace("{0}", String(files)).replace("{1}", String(count));
    }
    const off = vscode.workspace.textDocuments.filter((doc) => disabled.has(uriKey(doc.uri))).length;
    if (off) status.tooltip += `\n${t("statusFilesOff").replace("{0}", String(off))}`;
    status.show();
  }
  return { status, findingEmitter, findingView, updateStatus };
}

module.exports = { statusBarAndFindingsView };

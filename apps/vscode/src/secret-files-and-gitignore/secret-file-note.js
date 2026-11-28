"use strict";

const path = require("path");
const vscode = require("vscode");
const { isSecretFile } = require("../bundled-guard.js");
const { editorSecretFile, boundedDocumentText } = require("../open-files/skipped-files.js");
const { projectRoot } = require("../open-files/project-clotrignore.js");
const { uriKey } = require("../open-files/open-file-findings.js");
const { addGitIgnoreLines, withGitIgnoreLine, startsInside, secretIgnored } = require("./gitignore-file.js");

// ---------- Secret files and their .gitignore ----------

function isOpenSecretFile(doc) {
  if (isSecretFile(doc.uri.fsPath)) return true;
  const bounded = boundedDocumentText(doc);
  return bounded.kind === "text" && editorSecretFile(doc.uri.fsPath, bounded.text);
}

// The { root, relativePath } whose .gitignore would name the file, or null outside every workspace folder.
function gitIgnoreTarget(doc) {
  const folder = vscode.workspace.workspaceFolders.find((item) => startsInside(item.uri.fsPath, doc.uri.fsPath));
  // A repository nested in the workspace folder never reads the folder's .gitignore, so write into its own.
  const root = folder ? projectRoot(doc.uri) || folder.uri.fsPath : null;
  const relativePath = root ? path.relative(root, doc.uri.fsPath).replace(/\\/g, "/") : null;
  if (!relativePath) return null;
  return { root, relativePath };
}

function secretFileNote({ state, t }) {
  // ---------- The secret-file note ----------

  const workspaceSecretScanned = new Set();
  let workspaceSecretNoteShown = state.get("workspaceSecretNoteShown", false);

  // Finds open secret files Git would pick up and offers to add them, once per workspace.
  async function checkWorkspaceSecrets(documents = vscode.workspace.textDocuments) {
    if (workspaceSecretNoteShown || !vscode.workspace.workspaceFolders?.length) return;
    const workspaceFiles = documents.filter((doc) =>
      vscode.workspace.workspaceFolders.some((folder) => doc.uri.fsPath.startsWith(folder.uri.fsPath)),
    );
    const unignored = [];
    for (const doc of workspaceFiles) {
      const key = uriKey(doc.uri);
      if (workspaceSecretScanned.has(key)) continue;
      workspaceSecretScanned.add(key);
      if (!isOpenSecretFile(doc)) continue;
      const target = gitIgnoreTarget(doc);
      if (target && !(await secretIgnored(doc.uri))) unignored.push(target);
    }
    if (!unignored.length) return;
    await state.update("workspaceSecretNoteShown", true);
    workspaceSecretNoteShown = true;
    await offerGitIgnore(unignored, t("unignoredSecretNote"));
  }
  // Asks before adding each { root, relativePath } to the .gitignore in its root.
  async function offerGitIgnore(unignored, message) {
    const action = await vscode.window.showInformationMessage(message, t("addToGitignore"));
    if (action !== t("addToGitignore")) return;
    try {
      const safePaths = unignored.map(withGitIgnoreLine);
      for (const root of new Set(unignored.map((item) => item.root))) {
        const lines = safePaths.filter((item) => item.root === root).map((item) => item.line);
        addGitIgnoreLines(path.join(root, ".gitignore"), lines);
      }
    } catch {
      await vscode.window.showWarningMessage(t("gitIgnoreWriteError"));
    }
  }
  return { workspaceSecretScanned, checkWorkspaceSecrets, offerGitIgnore };
}

module.exports = { secretFileNote };

"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { parseClotrIgnore, readClotrIgnore } = require("../bundled-guard.js");
const { isWithinFolder } = require("../path-within-folder.js");

// ---------- The project a file belongs to ----------

// The nearest folder with .git at or above the file, inside its workspace folder.
// Else that workspace folder.
function projectRoot(fileUri) {
  const filePath = path.resolve(fileUri.fsPath);
  const workspace = vscode.workspace.workspaceFolders?.find((folder) =>
    isWithinFolder(path.resolve(folder.uri.fsPath), filePath),
  );
  if (!workspace) return null;
  const workspaceRoot = path.resolve(workspace.uri.fsPath);
  // Stop at the opened workspace, so an unrelated .git above it can't redirect a secret
  // into a shared folder.
  let directory = path.dirname(filePath);
  while (isWithinFolder(workspaceRoot, directory)) {
    if (fs.existsSync(path.join(directory, ".git"))) return directory;
    if (!path.relative(workspaceRoot, directory)) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return workspaceRoot;
}

function projectClotrIgnore() {
  // ---------- The project's .clotrignore ----------

  const clotrIgnoreCache = new Map();

  function cachedClotrIgnore(root) {
    const key = path.resolve(root);
    if (!clotrIgnoreCache.has(key)) clotrIgnoreCache.set(key, readClotrIgnore(key));
    return clotrIgnoreCache.get(key);
  }
  function clotrIgnoreForDocument(document) {
    const root = projectRoot(document.uri);
    return { root, config: root ? cachedClotrIgnore(root) : parseClotrIgnore("") };
  }
  function clotrIgnoreForWorkspace() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return { root, config: root ? cachedClotrIgnore(root) : parseClotrIgnore("") };
  }
  return { clotrIgnoreCache, clotrIgnoreForDocument, clotrIgnoreForWorkspace };
}

module.exports = { projectRoot, projectClotrIgnore };

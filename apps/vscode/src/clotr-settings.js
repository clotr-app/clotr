"use strict";

const vscode = require("vscode");

function config() {
  return vscode.workspace.getConfiguration("clotr");
}

module.exports = { config };

"use strict";

const vscode = require("vscode");

// Joined at run time, so the packed extension never holds the whole demo key as one string.
const DEMO_AWS_KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");

function welcomeAndTryIt({ context, t, editor, analyze, findingEmitter, updateStatus }) {
  // ---------- First run and Try it ----------

  // Opens an untitled file holding the demo key and checks it, so the warning shows right away.
  async function tryIt() {
    try {
      const document = await vscode.workspace.openTextDocument({
        language: "javascript",
        content: `const AWS_ACCESS_KEY_ID = "${DEMO_AWS_KEY}";\n`,
      });
      await vscode.window.showTextDocument(document);
      analyze(document);
      findingEmitter.fire();
      updateStatus();
    } catch (_error) {
      await vscode.window.showWarningMessage(t("tryItError"));
    }
  }

  // The first time only: says Clotr is ready and offers Try it.
  async function showWelcome() {
    if (context.globalState.get("welcomeShown", false)) return;
    await context.globalState.update("welcomeShown", true);
    const choice = await vscode.window.showInformationMessage(
      t("welcomeMessage").replace("{0}", editor),
      t("tryItButton"),
    );
    if (choice === t("tryItButton")) await vscode.commands.executeCommand("clotr.tryIt");
  }
  return { tryIt, showWelcome };
}

module.exports = { welcomeAndTryIt };

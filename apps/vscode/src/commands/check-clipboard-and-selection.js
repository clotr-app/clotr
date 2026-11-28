"use strict";

const vscode = require("vscode");
const { config } = require("../clotr-settings.js");
const { MAX_BYTES } = require("../open-files/skipped-files.js");
const { listedInClotrIgnore } = require("../open-files/check-open-file.js");

function checkClipboardAndSelection({
  t,
  findingName,
  host,
  checkWithDetection,
  clotrIgnoreForDocument,
  clotrIgnoreForWorkspace,
}) {
  // ---------- Check clipboard and Check selection ----------

  // Checks text on its way out and shows what it found. When the whole text was checked,
  // it offers a copy with the findings taken out.
  async function showChecked(text) {
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      await vscode.window.showInformationMessage(t("notCheckedTextLarge"));
      return;
    }
    const rank = { high: 3, medium: 2, low: 1 };
    const minimum = config().get("minSeverity", "medium");
    // One scan: its groups map the values, and its time-limit flag says whether the whole text was checked.
    const { checked: result, groups = [] } = checkWithDetection(text, { app: "vscode", source: "copied" });
    const partial = result.truncated === true;
    const document = vscode.window.activeTextEditor?.document;
    const ignore = document ? clotrIgnoreForDocument(document).config : clotrIgnoreForWorkspace().config;
    const findings = findingsWithValues(result.findings, groups).filter(({ finding, value }) => {
      const listed = listedInClotrIgnore(ignore, value);
      return rank[finding.severity] >= rank[minimum] && !listed;
    });
    if (!findings.length) {
      if (partial) await vscode.window.showWarningMessage(t("notCheckedTextPart"));
      else await vscode.window.showInformationMessage(t("nothingFound"));
      return;
    }
    const details = findings.map(({ finding }) => `${findingName(finding)}: ${t("findingDetected")}`).join("\n");
    // A cleaned copy of text that wasn't fully checked could still hold a secret
    // past the point the scan stopped.
    if (partial) {
      await vscode.window.showWarningMessage(`${t("foundDetails")}\n${details}\n${t("notCheckedTextPart")}`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(`${t("foundDetails")}\n${details}`, t("copyClean"));
    if (!choice) return;
    const cleaned = host.redact(
      text,
      findings.map(({ finding }) => finding.id),
    );
    await vscode.env.clipboard.writeText(cleaned);
    await vscode.window.showInformationMessage(t("cleanCopied"));
  }
  // Each finding with the value it was found in, as { finding, value }, in the order detection found them.
  // A value with a fingerprint is paired by its kind and fingerprint, in turn; any other by its place,
  // "<group>.<match>", which is the finding's id.
  function findingsWithValues(findings, groups) {
    const byValue = new Map();
    const byId = new Map();
    for (const finding of findings) {
      byId.set(finding.id, finding);
      const key = `${finding.type}\0${finding.fp}`;
      byValue.set(key, [...(byValue.get(key) || []), finding]);
    }
    const matches = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      for (let matchIndex = 0; matchIndex < group.matches.length; matchIndex += 1) {
        const value = group.matches[matchIndex];
        const fingerprint = host.fingerprintFor(group.id, value);
        const key = `${group.id}\0${fingerprint}`;
        const finding = fingerprint ? byValue.get(key)?.shift() : byId.get(`${groupIndex}.${matchIndex}`);
        if (finding) matches.push({ finding, value });
      }
    }
    return matches;
  }
  async function checkClipboard() {
    try {
      await showChecked(await vscode.env.clipboard.readText());
    } catch (_error) {
      await vscode.window.showErrorMessage(t("checkFailed"));
    }
  }
  async function checkSelection() {
    try {
      const selectionEditor = vscode.window.activeTextEditor;
      // With several cursors, copying takes every selection, so all of them are checked, in document order.
      const document = selectionEditor?.document;
      const selections = (selectionEditor?.selections || [selectionEditor?.selection])
        .filter((selection) => selection && !selection.isEmpty)
        .sort((first, second) => document.offsetAt(first.start) - document.offsetAt(second.start));
      if (!selections.length) {
        await vscode.window.showInformationMessage(t("selectText"));
        return;
      }
      await showChecked(selections.map((selection) => document.getText(selection)).join("\n"));
    } catch (_error) {
      await vscode.window.showErrorMessage(t("checkFailed"));
    }
  }
  return { checkClipboard, checkSelection };
}

module.exports = { checkClipboardAndSelection };

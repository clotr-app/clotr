"use strict";

const vscode = require("vscode");

const SOURCE = "Clotr";

function uriKey(uri) {
  return uri.toString();
}

function documentFor(uri) {
  return vscode.workspace.textDocuments.find((document) => uriKey(document.uri) === uriKey(uri));
}

function diagnosticSeverity(level) {
  const severities = {
    high: vscode.DiagnosticSeverity.Error,
    medium: vscode.DiagnosticSeverity.Warning,
    low: vscode.DiagnosticSeverity.Information,
  };
  return severities[level] ?? vscode.DiagnosticSeverity.Warning;
}

// The key for one finding at one place: its kind and its range.
function diagnosticKey(diagnostic) {
  const { start, end } = diagnostic.range;
  return `${diagnostic.code}:${start.line}:${start.character}:${end.line}:${end.character}`;
}

// A warning at the very top of a file, for a check that didn't run or didn't finish.
function topOfFileWarning(document, message, code) {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(document.positionAt(0), document.positionAt(0)),
    message,
    vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = SOURCE;
  diagnostic.code = code;
  return diagnostic;
}

function openFileFindings({ state, t, editor, findingName, host }) {
  // What Clotr keeps for each open file, made once the engine has started.
  const diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  // Per file, each finding's { fingerprint, kind, range }, by its occurrence key (diagnosticKey).
  const diagnosticData = new Map();
  // Per file, the occurrences ignored once, as occurrence key -> fingerprint.
  const ignoredOnce = new Map();
  const checkedDocuments = new Set();
  const unchecked = new Set();
  const disabled = new Set(state.get("disabledFiles", []));

  // ---------- What was found in each open file ----------

  // One finding's diagnostic, or null when the person ignored this occurrence once.
  function addDiagnostic(document, entry, start, end, activeIgnored) {
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    const why = t("whyOpenFiles").replace("{0}", editor);
    const message = `${findingName(entry)}: ${t("findingDetected")}\n${why}`;
    const diagnostic = new vscode.Diagnostic(range, message, diagnosticSeverity(entry.severity));
    diagnostic.source = SOURCE;
    diagnostic.code = entry.type;
    const key = uriKey(document.uri);
    const occurrence = diagnosticKey(diagnostic);
    activeIgnored.set(occurrence, entry.fp);
    if (ignoredOnce.get(key)?.get(occurrence) === entry.fp) return null;
    const byRange = diagnosticData.get(key) || new Map();
    byRange.set(occurrence, { fingerprint: entry.fp, kind: entry.type, range });
    diagnosticData.set(key, byRange);
    return diagnostic;
  }
  function markUnchecked(document, message) {
    const key = uriKey(document.uri);
    ignoredOnce.delete(key);
    const diagnostic = topOfFileWarning(document, message, "check_unavailable");
    diagnostics.set(document.uri, [diagnostic]);
    diagnosticData.delete(key);
    checkedDocuments.delete(key);
    unchecked.add(key);
  }
  function findingDiagnostics(document) {
    const byRange = diagnosticData.get(uriKey(document.uri));
    return (diagnostics.get(document.uri) || []).filter((diagnostic) => byRange?.has(diagnosticKey(diagnostic)));
  }
  // The finding at an occurrence, with its value, while the text there is still that value.
  function findingForAction(document, occurrence) {
    const detail = diagnosticData.get(uriKey(document.uri))?.get(occurrence);
    if (!detail) return null;
    const value = document.getText(detail.range);
    if (!value || host.fingerprintFor(detail.kind, value) !== detail.fingerprint) return null;
    return { ...detail, value };
  }
  return {
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
  };
}

module.exports = {
  SOURCE,
  uriKey,
  documentFor,
  diagnosticSeverity,
  diagnosticKey,
  topOfFileWarning,
  openFileFindings,
};

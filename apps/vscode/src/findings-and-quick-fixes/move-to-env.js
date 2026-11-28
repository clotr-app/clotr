"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { MAX_BYTES } = require("../open-files/skipped-files.js");
const { uriKey, documentFor } = require("../open-files/open-file-findings.js");
const { secretIgnored } = require("../secret-files-and-gitignore/gitignore-file.js");

// ---------- Lines for .env ----------

// Whether the value at start..end sits between a matching pair of ' or " quotes.
function betweenQuotes(text, start, end) {
  const quote = text[start - 1];
  return ["'", '"'].includes(quote) && text[end] === quote;
}

// CLOTR_<KIND>, or the same with _2, _3 and on when .env already has that name.
function unusedEnvName(envText, kind) {
  const base = `CLOTR_${kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  let variable = base;
  let suffix = 2;
  while (envHasName(envText, variable)) {
    variable = `${base}_${suffix}`;
    suffix += 1;
  }
  return variable;
}

function envHasName(envText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}=`, "m").test(envText || "");
}

// The line to add, in the file's own line breaks, after a break when the file doesn't end with one.
function envLine(envText, variable, value) {
  const newline = envText?.includes("\r\n") ? "\r\n" : "\n";
  const separator = envText && !/[\r\n]$/.test(envText) ? newline : "";
  return `${separator}${variable}=${value}${newline}`;
}

function safeEnvValue(value) {
  return /^[A-Za-z0-9._/:+=-]+$/.test(value);
}

// The position just past the end of the text.
function appendPosition(text) {
  let line = 0;
  let lastBreak = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lastBreak = index;
    }
  }
  return new vscode.Position(line, text.length - lastBreak - 1);
}

// A .env's text, undefined when there's no .env, or null when it's a link, too large, binary or unreadable.
function safeExistingEnv(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_BYTES) return null;
    return text;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    return null;
  }
}

function moveToEnvFix({
  t,
  host,
  findingForAction,
  diagnosticData,
  clotrIgnoreForDocument,
  analyze,
  findingEmitter,
  updateStatus,
  offerGitIgnore,
}) {
  // ---------- Move to .env ----------

  // Moves a quoted secret into the project's .env and leaves process.env.<NAME> in its place.
  async function moveToEnv(uri, occurrence) {
    const document = documentFor(uri);
    if (!document) return;
    const finding = findingForAction(document, occurrence);
    const detail = diagnosticData.get(uriKey(document.uri))?.get(occurrence);
    const root = clotrIgnoreForDocument(document).root;
    if (!finding || !detail || !root || !safeEnvValue(finding.value)) return;
    const start = document.offsetAt(detail.range.start);
    const end = document.offsetAt(detail.range.end);
    if (!betweenQuotes(document.getText(), start, end)) return;
    const envFile = path.join(root, ".env");
    const envUri = vscode.Uri.file(envFile);
    const onDisk = safeExistingEnv(envFile);
    // An earlier move's line can sit unsaved in the open .env,
    // so its editor text decides the name and the position.
    const envDocument = onDisk === null ? null : documentFor(envUri);
    const envText = envDocument ? envDocument.getText() : onDisk;
    const openEnvUnsafe = Boolean(envDocument) && (envText.includes("\0") || Buffer.byteLength(envText) > MAX_BYTES);
    if (envText === null || openEnvUnsafe) {
      await vscode.window.showWarningMessage(t("moveToEnvError"));
      return;
    }
    const variable = unusedEnvName(envText, detail.kind);
    const line = envLine(envText, variable, finding.value);
    const edit = new vscode.WorkspaceEdit();
    // The quotes go too.
    const quoted = new vscode.Range(document.positionAt(start - 1), document.positionAt(end + 1));
    edit.replace(document.uri, quoted, `process.env.${variable}`);
    if (onDisk === undefined) edit.createFile(envUri);
    edit.insert(envUri, appendPosition(envText || ""), line);
    try {
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("edit failed");
      analyze(document);
      findingEmitter.fire();
      updateStatus();
    } catch (_error) {
      await vscode.window.showWarningMessage(t("moveToEnvError"));
      return;
    }
    // .env is skipped as a secret file,
    // so nothing else would say the credential now sits in a file Git can commit.
    if (!(await secretIgnored(envUri))) await offerGitIgnore([{ root, relativePath: ".env" }], t("movedEnvNotIgnored"));
  }
  // Offered on a quoted value in JavaScript or TypeScript that's still the found one, when the project's .env
  // can be read safely or isn't there yet.
  function canMoveToEnv(document, diagnostic, detail) {
    if (!/^(javascript|javascriptreact|typescript|typescriptreact)$/.test(document.languageId || "")) return false;
    const start = document.offsetAt(diagnostic.range.start);
    const end = document.offsetAt(diagnostic.range.end);
    const text = document.getText();
    const value = document.getText(diagnostic.range);
    const root = clotrIgnoreForDocument(document).root;
    const envText = root ? safeExistingEnv(path.join(root, ".env")) : null;
    if (!betweenQuotes(text, start, end)) return false;
    if (!safeEnvValue(value)) return false;
    if (host.fingerprintFor(detail.kind, value) !== detail.fingerprint) return false;
    return envText !== null;
  }
  return { moveToEnv, canMoveToEnv };
}

module.exports = { moveToEnvFix };

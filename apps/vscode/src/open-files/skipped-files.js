"use strict";

const vscode = require("vscode");
const { isSecretFile, globMatches } = require("../bundled-guard.js");
const { config } = require("../clotr-settings.js");

const MAX_BYTES = 1024 * 1024;

// ---------- Files Clotr skips ----------

// A secret file by its path, or a service-account key file by its content. The shared content rule matches
// the shape anywhere, so a source file or README that only mentions it would lose every finding.
// Here the file must be that key.
function editorSecretFile(file, text) {
  if (isSecretFile(file)) return true;
  if (typeof text !== "string" || !isSecretFile(file, text)) return false;
  const json = withoutByteOrderMark(text);
  try {
    return JSON.parse(json)?.type === "service_account";
  } catch {
    return false;
  }
}

function isUntitled(document) {
  return document.uri.scheme === "untitled" || document.isUntitled;
}

function withoutByteOrderMark(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// A skipList pattern as steps for Guard's glob walker. The walker reads a path once in bounded steps, so a
// star-heavy pattern can't stall a check the way a backtracking regex did.
// The steps keep the old regex's meaning:
// "**/" is any folders or none, "**" is anything, "*" and "?" stay inside one folder,
// and every other character is literal, so brackets, braces and backslashes are plain characters here.
function skipListSteps(pattern) {
  const steps = [];
  pattern.split("**/").forEach((part, partIndex) => {
    if (partIndex > 0) steps.push({ type: "folders" });
    part.split("**").forEach((section, sectionIndex) => {
      if (sectionIndex > 0) steps.push({ type: "anything" });
      // One step per UTF-16 unit, as the walker reads the path.
      for (const character of section.split("")) {
        if (character === "*") steps.push({ type: "star" });
        else if (character === "?") steps.push({ type: "one" });
        else steps.push({ type: "char", value: foldCase(character) });
      }
    });
  });
  return steps;
}

// Folds case the way a regex with only the "i" flag compares characters, one UTF-16 unit at a time.
function foldCase(text) {
  let folded = "";
  for (let index = 0; index < text.length; index += 1) folded += foldUnit(text[index]);
  return folded;
}

// The "i" flag leaves a unit as it is when its upper case is longer than one unit,
// or when it would turn a non-ASCII unit into an ASCII one.
function foldUnit(unit) {
  const upper = unit.toUpperCase();
  if (upper.length !== 1) return unit;
  if (unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) return unit;
  return upper;
}

function skipListMatches(pattern, relativePath) {
  return globMatches(skipListSteps(pattern), foldCase(relativePath));
}

// Files Clotr doesn't check: anything but a saved or untitled file, secret files by name,
// and the skip list.
function fileSkipped(document) {
  const uri = document.uri;
  const untitled = isUntitled(document);
  if (uri.scheme !== "file" && !untitled) return true;
  if (!untitled && isSecretFile(uri.fsPath)) return true;
  if (untitled) return false;
  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  return (config().get("skipList", []) || []).some((pattern) => skipListMatches(pattern, relativePath));
}

// A file's text, or why it can't be checked: too large, binary, or unreadable.
function boundedDocumentText(document) {
  try {
    if (document.offsetAt(document.positionAt(MAX_BYTES + 1)) > MAX_BYTES) return { kind: "large" };
    const text = document.getText();
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { kind: "large" };
    if (text.includes("\0")) return { kind: "binary" };
    return { kind: "text", text };
  } catch (_error) {
    return { kind: "failed" };
  }
}

module.exports = {
  MAX_BYTES,
  editorSecretFile,
  isUntitled,
  skipListMatches,
  fileSkipped,
  boundedDocumentText,
};

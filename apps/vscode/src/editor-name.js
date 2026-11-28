"use strict";

const vscode = require("vscode");
const english = require("../package.nls.json");
const spanish = require("../package.nls.es.json");

// ---------- Which editor this is ----------

// A piece of the editor's app name or URI scheme, and the name messages and Guard use for it.
// The first match wins.
const EDITOR_NAMES = [
  ["cursor", "Cursor"],
  ["windsurf", "Windsurf"],
  ["vscodium", "VSCodium"],
  ["kiro", "Kiro"],
  ["trae", "Trae"],
  ["code-server", "code-server"],
  ["codeserver", "code-server"],
  ["visual studio code", "VS Code"],
  ["vscode", "VS Code"],
];

function editorName(appName, uriScheme) {
  const known = [appName, uriScheme].map(lowerCaseName);
  for (const [fragment, label] of EDITOR_NAMES) {
    if (known.some((value) => value.includes(fragment))) return label;
  }
  // Any other editor goes by its own app name, unless it has none or it's the plain "Code".
  const application = String(appName || "").trim();
  if (!application || application.toLowerCase() === "code") return "VS Code";
  return application;
}

function lowerCaseName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

// ---------- Words and the editor ----------

function editorLanguage() {
  const isSpanish = /^es(?:-|$)/i.test(vscode.env.language);
  const words = isSpanish ? spanish : english;
  const t = (key) => words[key] || english[key] || key;
  const findingName = (entry) => words[`finding_${entry.type}`] || (isSpanish ? t("sensitiveFinding") : entry.name);
  return { t, findingName };
}

module.exports = { editorName, editorLanguage };

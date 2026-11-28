"use strict";

const vscode = require("vscode");
const { parseClotrIgnore, valueFingerprint } = require("../bundled-guard.js");
const { config } = require("../clotr-settings.js");
const { editorSecretFile, isUntitled, fileSkipped, boundedDocumentText } = require("./skipped-files.js");
const { topOfFileWarning, uriKey } = require("./open-file-findings.js");
const { pruneIgnoredOnce } = require("./ignore-once.js");

// ---------- Personal details ----------

// Card, gift-card and bank kinds: in the engine's personal group, but checked like credentials.
const MONEY_KINDS = new Set(["credit_card", "card_code", "gift_card", "bank_account"]);
// Kind names the older word list counts as personal.
const OLDER_PERSONAL_WORDS = new RegExp(
  [
    "email",
    "phone",
    "person",
    "name",
    "address",
    "ssn",
    "social",
    "passport",
    "license.?plate",
    "national.?id",
    "account.?id",
    "student.?id",
    "birth",
    "dob",
    "vin",
    "ip.?address",
  ].join("|"),
  "i",
);

// A personal detail waits for the personal details setting: every kind the engine's own results group as
// personal, and any kind whose name the older word list matches. Card, gift-card and bank numbers sit
// in that group too, but they're money, so they stay marked like a credential.
function isPersonalDetail(kind, groups) {
  const inPersonalGroup = (groups || []).some((group) => group.id === kind && group.group === "personal");
  if (inPersonalGroup && !MONEY_KINDS.has(kind)) return true;
  return OLDER_PERSONAL_WORDS.test(kind);
}

// ---------- Places in a file's text ----------

// Each place a value sits in the text, from where the last search for it ended.
function* valuePlaces(text, value, cursorKey, cursor) {
  let start = text.indexOf(value, cursor.get(cursorKey) || 0);
  while (start >= 0) {
    const end = start + value.length;
    cursor.set(cursorKey, end);
    yield { start, end };
    start = text.indexOf(value, end);
  }
}

// Whether .clotrignore lists this value by its fingerprint.
function listedInClotrIgnore(ignore, value) {
  const fingerprint = valueFingerprint(ignore?.salt, value);
  if (!fingerprint) return false;
  return Boolean(ignore?.fingerprints.has(fingerprint));
}

function checkOpenFile({
  t,
  host,
  checkWithDetection,
  clotrIgnoreForDocument,
  diagnostics,
  diagnosticData,
  ignoredOnce,
  checkedDocuments,
  unchecked,
  disabled,
  markUnchecked,
  addDiagnostic,
}) {
  let rawIgnoreWarningShown = false;

  // ---------- Checking one open file ----------

  // Checks one open file and marks what it finds. Returns the file's diagnostics.
  function analyze(document) {
    const key = uriKey(document.uri);
    const untitled = isUntitled(document);
    if (!checkingOn(document, key, untitled) || fileSkipped(document)) return forgetFile(document, key);
    const bounded = boundedDocumentText(document);
    if (bounded.kind !== "text") {
      ignoredOnce.delete(key);
      markUnchecked(document, notCheckedMessage(bounded.kind));
      return diagnostics.get(document.uri);
    }
    const text = bounded.text;
    if (!untitled && editorSecretFile(document.uri.fsPath, text)) return forgetFile(document, key);
    const ignore = document.uri.scheme === "file" ? clotrIgnoreForDocument(document) : null;
    warnAboutRawIgnoreValue(ignore);
    unchecked.delete(key);
    checkedDocuments.add(key);
    const next = findingsIn(document, text, ignore);
    diagnostics.set(document.uri, next);
    return next;
  }
  // Checking is on, for this file too, and it's a saved or untitled file.
  function checkingOn(document, key, untitled) {
    if (!config().get("enabled", true)) return false;
    if (disabled.has(key)) return false;
    return document.uri.scheme === "file" || untitled;
  }
  // Drops everything kept for a file Clotr doesn't check.
  function forgetFile(document, key) {
    ignoredOnce.delete(key);
    diagnostics.delete(document.uri);
    diagnosticData.delete(key);
    checkedDocuments.delete(key);
    unchecked.delete(key);
    return [];
  }
  function notCheckedMessage(kind) {
    if (kind === "large") return t("notCheckedLarge");
    if (kind === "binary") return t("notCheckedBinary");
    return t("fileCheckFailed");
  }
  // A .clotrignore with a secret written out in full. Said once per window.
  function warnAboutRawIgnoreValue(ignore) {
    if (ignore?.config.reason !== "raw-value" || rawIgnoreWarningShown) return;
    rawIgnoreWarningShown = true;
    void vscode.window.showWarningMessage(t("rawIgnoreValue"));
  }
  // The diagnostics for a file's text: each finding at or above the chosen level, at every place it sits.
  function findingsIn(document, text, ignore) {
    const key = uriKey(document.uri);
    const minimum = config().get("minSeverity", "medium");
    // The levels at or above the chosen one.
    const levels = ["high", "medium", "low"];
    const allowed = new Set(levels.slice(0, levels.indexOf(minimum) + 1));
    const personalDetails = config().get("personalDetailsInFiles", false);
    const { checked, groups } = checkWithDetection(text, { app: "vscode", source: "typed" });
    const found = checked.findings.filter((entry) => personalDetails || !isPersonalDetail(entry.type, groups));
    const ignoreConfig = ignore?.config || parseClotrIgnore("");
    const ranges = findRanges(text, found, groups, ignoreConfig);
    const next = [];
    const activeIgnored = new Map();
    diagnosticData.set(key, new Map());
    for (const entry of found) {
      if (!allowed.has(entry.severity)) continue;
      // Each range comes off the list as it's used,
      // so a second finding with the same fingerprint doesn't mark it again.
      const positions = ranges.get(entry.fp) || [];
      while (positions.length) {
        const range = positions.shift();
        const diagnostic = addDiagnostic(document, entry, range.start, range.end, activeIgnored);
        if (diagnostic) next.push(diagnostic);
      }
    }
    pruneIgnoredOnce(ignoredOnce.get(key), activeIgnored);
    if (!ignoredOnce.get(key)?.size) ignoredOnce.delete(key);
    // The engine stopped before the end (its time limit): say so at the top, beside whatever it did find.
    if (checked.truncated) next.push(topOfFileWarning(document, t("notCheckedPart"), "check_partial"));
    return next;
  }
  // Where each finding sits in the text, as a list of { start, end } by its fingerprint.
  // A value .clotrignore lists gets no range.
  function findRanges(text, findings, groups, ignore) {
    const ranges = new Map();
    // Per kind and value, where the last search ended, so a value listed twice isn't placed twice.
    const cursor = new Map();
    // Detection supplies only transient match strings.
    // The host's salted fingerprint maps each range to its safe finding.
    for (const group of groups || []) {
      for (const value of group.matches) {
        for (const range of valuePlaces(text, value, `${group.id}\0${value}`, cursor)) {
          if (listedInClotrIgnore(ignore, value)) continue;
          const fingerprint = host.fingerprintFor(group.id, value);
          if (!findings.some((item) => item.fp === fingerprint)) continue;
          ranges.set(fingerprint, [...(ranges.get(fingerprint) || []), range]);
        }
      }
    }
    return ranges;
  }
  return { analyze };
}

module.exports = { isPersonalDetail, listedInClotrIgnore, checkOpenFile };

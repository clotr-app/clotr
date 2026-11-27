"use strict";
/* global require, module, process, console, Buffer */

const fs = require("fs");
const { check } = require("../text-checks/engine-loader.js");
const { SEVERITIES, MAX_CHECK_BYTES } = require("../limits-and-messages.js");
const { readText, looseText, utf16Shaped, mostlyText } = require("../text-checks/text-decode.js");
const { clotrIgnoreFor } = require("../git-repository.js");
const { atLeastSeverity } = require("../text-checks/check-text.js");
const { printable } = require("./piped-input.js");

// ---------- The check command's text ----------

// The .clotrignore that `check` uses, with a note when it holds a raw value.
function checkIgnore(cwd) {
  const ignore = clotrIgnoreFor(cwd);
  if (ignore.config.reason === "raw-value") console.error("Use clotr-guard ignore-value.");
  return ignore;
}

// Checks one text for `check` and prints what it finds. With a name, each line starts with it, so the output
// of many files says which file each finding is in. Returns 1 for a finding or a text not checked to the end,
// else 0, and throws when the text can't be checked.
function checkText(read, { ignore, minimum, json, name }) {
  const result = check(read.text, {
    ignoreSalt: ignore.config.valid ? ignore.config.salt : null,
    ignoreFingerprints: ignore.config.valid ? [...ignore.config.fingerprints] : [],
  });
  const belowMinimum =
    minimum !== "low" &&
    result.findings.some((finding) => SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(minimum));
  result.findings = atLeastSeverity(result.findings, minimum);
  // A file that isn't text, with nothing found, may still hold a value the engine can't see in its bytes, so
  // it isn't called clean.
  if (read.notText && !result.findings.length) throw new Error("not-text");
  // A text not checked to the end isn't called clean: it returns 1, as a finding does.
  result.decision = result.findings.length || result.truncated ? "block" : "allow";
  const where = name === undefined ? "" : `${printable(name)}: `;
  const which = name === undefined ? "this text" : printable(name);
  if (json) console.log(JSON.stringify(result));
  else for (const finding of result.findings) console.log(`${where}${finding.kind}: ${finding.masked}`);
  if (result.truncated) console.error(`Clotr ran out of time, so part of ${which} wasn't checked.`);
  if (belowMinimum) console.error(`Clotr found details below the stop level; ${which} will pass.`);
  // Someone at a terminal can't tell silence from a check that never ran; a script reading the output gets
  // none.
  else if (name === undefined && !json && !result.findings.length && saysNothingFound(result)) {
    console.log("Nothing found.");
  }
  return result.decision === "block" ? 1 : 0;
}

// Whether `check` says so at a terminal when a whole text had nothing found.
function saysNothingFound(result) {
  return !result.truncated && process.stdout.isTTY;
}

// Checks each file in the order given. Returns 2 when any file couldn't be checked, after checking the rest,
// else 1 when any file has a finding or wasn't checked to the end, else 0. The JSON for many files isn't
// settled yet, so --json takes one file.
function checkFiles(files, { cwd, minimum, json }) {
  if (json) {
    console.error("clotr-guard check --json takes one file.");
    return 2;
  }
  let ignore;
  try {
    ignore = checkIgnore(cwd);
  } catch {
    console.error("Clotr couldn't check these files.");
    return 2;
  }
  let status = 0;
  let failed = false;
  for (const file of files) {
    try {
      status = Math.max(status, checkText(readCheckFile(file), { ignore, minimum, json, name: file }));
    } catch {
      console.error(`Clotr couldn't check ${printable(file)}.`);
      failed = true;
    }
  }
  if (failed) return 2;
  if (!status && process.stdout.isTTY) console.log("Nothing found.");
  return status;
}

function readCheckFile(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CHECK_BYTES) throw new Error("file-too-large");
    const buffer = Buffer.alloc(MAX_CHECK_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CHECK_BYTES) throw new Error("file-too-large");
    // Read like a file an assistant opens: Windows PowerShell 5.1's `>` writes UTF-16, which as UTF-8 is a
    // NUL between every character and nothing to find. Text with stray bytes (a NUL, a database page) is
    // still read as UTF-8, with those bytes as spaces, so a key in it is reported; only when nothing is found
    // does the check say it couldn't check it. A UTF-16 file with a part that isn't text is the same.
    const bytes = buffer.subarray(0, bytesRead);
    const read = readText(bytes, false);
    if (read.text !== undefined) return { text: read.text, notText: !read.whole };
    if (mostlyText(bytes.toString("utf8")) && !utf16Shaped(bytes)) return { text: looseText(bytes), notText: true };
    // UTF-16 without a byte order mark that readText can't vouch for, like a UTF-16 .env with a UTF-8 line
    // added.
    const utf16 = require("../text-checks/text-decode.js").readUnmarkedUtf16(bytes);
    if (utf16.text === undefined) throw new Error("not-text");
    return { text: utf16.text, notText: true };
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  checkIgnore,
  checkText,
  checkFiles,
  readCheckFile,
};

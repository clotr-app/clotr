"use strict";
/* global require, module, process, console, Buffer */

const path = require("path");
const { spawnSync } = require("child_process");
const { check } = require("../text-checks/engine-loader.js");
const { readClotrIgnore } = require("../clotrignore.js");
const { SEVERITIES, MAX_READ_BYTES, GIT_TIMEOUT_MS, GUARD_ROOT } = require("../limits-and-messages.js");
const { decodeText } = require("../text-checks/text-decode.js");
const { executableOnPath, runGit, gitRoot } = require("../git-repository.js");
const { isSecretPath } = require("../secret-paths/secret-path-check.js");
const { isInternalAddress, isPersonalDetail } = require("../text-checks/check-text.js");

function checkStaged({ cwd = process.cwd(), includePersonalDetails = false } = {}) {
  const root = gitRoot(cwd);
  const ignore = readClotrIgnore(root);
  const names = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"], root, { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const issues = [];
  const notes = [];
  for (const file of names) {
    if (isSecretPath(file, "", root)) {
      // A staged secret file is on its way into history whatever the ignore rules say: a git-ignored one only gets
      // here through a forced add or an old tracked copy. Its contents are not scanned; the name alone stops the
      // commit.
      const ignored = spawnSync(executableOnPath("git", root), ["check-ignore", "--no-index", "-q", "--", file], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      if (ignored.error?.code === "ETIMEDOUT") throw ignored.error;
      const masked =
        ignored.status === 0 ? "[secret file is staged although git-ignored]" : "[secret file is not git-ignored]";
      issues.push({ file, line: 0, kind: "secret_file", masked });
      continue;
    }
    let diff;
    let partial = false;
    try {
      diff = runGit(
        ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=0", "--", file],
        root,
      );
    } catch (error) {
      // A late Git stops the whole check (see runCommitCheck).
      if (error.code === "ETIMEDOUT") throw error;
      if (error.code === "ENOBUFS" && error.stdout != null) {
        diff = Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf8") : String(error.stdout);
        partial = true;
      } else {
        issues.push({
          file,
          line: 0,
          kind: "staged_diff_unreadable",
          masked: "[the staged diff couldn't be read; this commit was stopped]",
        });
        continue;
      }
    }
    // Git calls a UTF-16 text file binary, so a file it won't show as text is read from the index instead.
    const binary = /^(?:Binary files |GIT binary patch)/m.test(diff);
    if (binary && partial) {
      issues.push({
        file,
        line: 0,
        kind: "staged_diff_partial",
        masked:
          "[the staged diff is over 16 MiB, so it wasn't checked and this commit was stopped; split the change or keep large generated files out of the repository]",
      });
      continue;
    }
    let added = [];
    if (binary) ({ added, partial } = newLinesOfStagedText(root, file));
    let lineNumber = 0;
    // The `+++ b/file` header comes before a file's first hunk; inside a hunk, an added line that reads `++ x` shows as
    // `+++ x` and is content like any other. A type change has two file sections, each with its own header.
    let inHunk = false;
    for (const line of binary ? [] : diff.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        lineNumber = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk || !line.startsWith("+")) continue;
      added.push({ line: lineNumber, text: line.slice(1) });
      lineNumber += 1;
    }
    if (partial) {
      const checked = [];
      let bytes = 0;
      for (const entry of added) {
        const remaining = MAX_READ_BYTES - bytes;
        if (remaining <= 0) break;
        const textBytes = Buffer.byteLength(entry.text, "utf8");
        if (textBytes <= remaining) {
          checked.push(entry);
          bytes += textBytes + 1;
        } else {
          checked.push({ ...entry, text: Buffer.from(entry.text, "utf8").subarray(0, remaining).toString("utf8") });
          break;
        }
      }
      issues.push({
        file,
        line: 0,
        kind: "staged_diff_partial",
        masked:
          "[checked the first 256 KiB; the rest wasn't checked, so this commit was stopped; split the change or keep large generated files out of the repository]",
      });
      added = checked;
    }
    if (!added.length) continue;
    // One engine run per file, over the added lines as they sit in the file, with each finding mapped back to its
    // line by offset. A run per line cost about six milliseconds each, minutes on a large file.
    const starts = [];
    let offset = 0;
    for (const entry of added) {
      starts.push(offset);
      offset += entry.text.length + 1;
    }
    const result = check(added.map((entry) => entry.text).join("\n"), {
      ignoreSalt: ignore.valid ? ignore.salt : null,
      ignoreFingerprints: ignore.valid ? [...ignore.fingerprints] : [],
    });
    // The engine's time limit cut the scan short: the rest of the file's added lines weren't checked, so the commit
    // stops, as it does for a diff too large to check. A file already stopped for its size says so once.
    if (result.truncated && !partial) {
      issues.push({
        file,
        line: 0,
        kind: "staged_check_unfinished",
        masked:
          "[Clotr ran out of time before checking all of this file's added lines, so this commit was stopped; split the change or keep large generated files out of the repository]",
      });
    }
    for (const finding of result.findings) {
      if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf("medium")) continue;
      if (!includePersonalDetails && isPersonalDetail(finding.kind)) continue;
      const issue = { file, line: lineAt(added, starts, finding.start), kind: finding.kind, masked: finding.masked };
      (isInternalAddress(finding.kind) ? notes : issues).push(issue);
    }
  }
  return { root, issues, notes, ignoreWarning: ignore.reason === "raw-value" };
}

// Git calls a UTF-16 file binary, so its diff has no lines to check, and a .env that Windows PowerShell 5.1 wrote
// with ">" is UTF-16. A staged file that decodes as text is read from the index instead, and the lines the last
// commit didn't have are checked like any other added lines. Anything that isn't text still passes unread.
// The whole file is read, as a text diff that size is, and one past Git's buffer is read up to it and marked partial,
// so the caller checks its start and stops the commit.
function newLinesOfStagedText(root, file) {
  const read = (spec) => {
    try {
      const bytes = runGit(["cat-file", "blob", spec], root, {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { text: decodeText(bytes, false), partial: false };
    } catch (error) {
      if (error.code === "ETIMEDOUT") throw error;
      if (error.code === "ENOBUFS" && Buffer.isBuffer(error.stdout)) {
        return { text: decodeText(error.stdout, true), partial: true };
      }
      return { text: undefined, partial: false }; // not in the last commit
    }
  };
  const staged = read(`:${file}`);
  if (staged.text === undefined) return { added: [], partial: false };
  const before = new Map();
  for (const line of (read(`HEAD:${file}`).text || "").split(/\r?\n/)) before.set(line, (before.get(line) || 0) + 1);
  const added = [];
  staged.text.split(/\r?\n/).forEach((line, index) => {
    if (before.get(line)) before.set(line, before.get(line) - 1);
    else added.push({ line: index + 1, text: line });
  });
  return { added, partial: staged.partial };
}

function lineAt(added, starts, position) {
  if (position < 0) return 0;
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1] <= position) index += 1;
  return added[index].line;
}

function commitCheck(options = {}) {
  const { issues, notes, ignoreWarning } = checkStaged(options);
  if (ignoreWarning) console.error("Use clotr-guard ignore-value.");
  for (const note of notes) console.error(`${formatCommitIssue(note)}, which won't stop this commit`);
  for (const issue of issues) console.error(formatCommitIssue(issue));
  return issues.length ? 1 : 0;
}

function formatCommitIssue(issue) {
  return `${JSON.stringify(issue.file)}:${issue.line} ${issue.kind} (${issue.masked})`;
}

function unavailableCommitCheck(error) {
  if (error.code === "ENOENT" && /^(?:git|git\.exe)$/i.test(error.path || "")) return "git wasn't found";
  if (error.code === "ENOENT" && error.path) {
    const guardRoot = GUARD_ROOT;
    const missing = path.resolve(error.path);
    if (missing === guardRoot || missing.startsWith(`${guardRoot}${path.sep}`)) return "Guard's own files are missing";
  }
  const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr || "");
  if (error.status === 128 && /not a git repository/i.test(stderr)) return "this isn't a Git repository";
  return null;
}

module.exports = {
  checkStaged,
  newLinesOfStagedText,
  lineAt,
  commitCheck,
  formatCommitIssue,
  unavailableCommitCheck,
};

"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { MAX_PATTERN_LENGTH, globMatches, globMatchesAt, parseRule } = require("../bundled-guard.js");
const { projectRoot } = require("../open-files/project-clotrignore.js");

// ---------- .gitignore, read and written safely ----------

// The file's details, or null when there's none. A link or anything but a plain file is refused,
// so a write can't be sent somewhere else.
function gitIgnoreStat(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe-gitignore-file");
  return info;
}

// The opened file must still be the one checked before opening it, not one swapped in meanwhile.
function assertOpenedGitIgnore(descriptor, before) {
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile() || (before?.ino && opened.ino && before.ino !== opened.ino)) {
    throw new Error("unsafe-gitignore-file");
  }
}

function readGitIgnore(file) {
  const before = gitIgnoreStat(file);
  if (!before) return "";
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    assertOpenedGitIgnore(descriptor, before);
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendGitIgnore(file, content) {
  const before = gitIgnoreStat(file);
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = before
    ? fs.openSync(file, flags)
    : fs.openSync(file, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
  try {
    assertOpenedGitIgnore(descriptor, before);
    fs.writeSync(descriptor, content, null, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

// A relative path as the .gitignore line that names just that file,
// or null for a path with control characters, a root, or an empty, "." or ".." part.
function gitIgnoreLine(file) {
  if (!file || /[\u0000-\u001f\u007f-\u009f]/.test(file)) return null;
  if (file.startsWith("/") || /^\p{L}:/u.test(file)) return null;
  if (file.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  let escaped = "";
  for (let index = 0; index < file.length; index += 1) {
    if (needsEscape(file, index)) escaped += "\\";
    escaped += file[index];
  }
  return escaped.length <= MAX_PATTERN_LENGTH ? escaped : null;
}

// Glob characters anywhere, # or ! at the start, and trailing spaces all mean something in a .gitignore line.
function needsEscape(file, index) {
  const character = file[index];
  if ("\\*?[]".includes(character)) return true;
  if (index === 0 && "#!".includes(character)) return true;
  return character === " " && /^ *$/.test(file.slice(index));
}

// A line as Git reads it: no leading spaces, and no trailing ones unless escaped.
function normalizeGitIgnoreLine(line) {
  let normalized = line.trimStart();
  while (normalized.endsWith(" ") && !normalized.endsWith("\\ ")) normalized = normalized.slice(0, -1);
  return normalized;
}

// Adds each line the file doesn't have yet, once, starting on a line of its own.
function addGitIgnoreLines(ignoreFile, lines) {
  const existing = readGitIgnore(ignoreFile);
  const present = new Set(existing.split(/\r\n|\n|\r/).map(normalizeGitIgnoreLine));
  const additions = [...new Set(lines)].filter((line) => !present.has(line));
  if (!additions.length) return;
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  appendGitIgnore(ignoreFile, `${separator}${additions.join("\n")}\n`);
}

// A { root, relativePath } with its .gitignore line.
// A path that can't be written safely stops the whole offer.
function withGitIgnoreLine(item) {
  const line = gitIgnoreLine(item.relativePath);
  if (line === null) throw new Error("unsafe-gitignore-path");
  return { ...item, line };
}

// What one .gitignore says about each part of a path relative to its folder (each folder on the way down,
// then the file): true or false from the last of its lines that names that part, undefined when none does.
// Guard's rule parser keeps a trailing slash's folders-only meaning, and its state-set glob walker can't
// backtrack for an unbounded time the way a compiled regex could on a star-heavy rule.
function gitIgnoreDecisions(lines, parts) {
  const relativePath = parts.join("/");
  // Where each part ends in relativePath.
  const ends = [];
  let end = -1;
  for (const part of parts) {
    end += part.length + 1;
    ends.push(end);
  }
  const excluded = parts.map(() => undefined);
  for (const line of lines) {
    const rule = parseRule(line);
    if (!rule) continue;
    // A leading slash ties the rule to this .gitignore's folder, as a slash inside it does.
    const anchored = rule.hasSlash || (rule.negate ? line.slice(1) : line).startsWith("/");
    // An anchored rule names a whole path from this folder; one without a slash names any single part.
    const named = anchored
      ? globMatchesAt(rule.steps, relativePath, ends)
      : parts.map((part) => globMatches(rule.steps, part));
    if (rule.directoryOnly) named[named.length - 1] = false;
    named.forEach((match, index) => {
      if (match) excluded[index] = !rule.negate;
    });
  }
  return excluded;
}

// Whether a path starts inside a folder, comparing text without case.
function startsInside(folder, file) {
  const root = folder.replace(/[\\/]$/, "");
  return file.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
}

function gitRepositoryFor(uri) {
  const git = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI(1);
  return git?.repositories?.find((item) => startsInside(item.rootUri.fsPath, uri.fsPath));
}

// Read from the file's own repository down, as Git does: a .gitignore above a nested repository's root
// isn't one that repository reads.
function ignoredByGitIgnoreFiles(uri) {
  const root = projectRoot(uri);
  if (!root) return false;
  const parts = path.relative(root, path.resolve(uri.fsPath)).split(path.sep);
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  // Each folder on the way down and the file itself is decided by the last line that names it,
  // a deeper .gitignore's lines coming after those above it.
  // The file is ignored once any of them is: a negation that names only a folder above the file
  // can't bring back a file an earlier line excluded.
  const excluded = parts.map(() => false);
  for (let depth = 0; depth < parts.length; depth += 1) {
    let contents;
    try {
      contents = readGitIgnore(path.join(root, ...parts.slice(0, depth), ".gitignore"));
    } catch (_error) {
      continue;
    }
    if (!contents) continue;
    const lines = contents.split(/\r\n|\n|\r/).map(normalizeGitIgnoreLine);
    gitIgnoreDecisions(lines, parts.slice(depth)).forEach((decision, index) => {
      if (decision !== undefined) excluded[depth + index] = decision;
    });
  }
  return excluded.includes(true);
}

// Whether Git ignores a file. The Git extension answers when it can, else the .gitignore files do.
async function secretIgnored(uri) {
  try {
    const repo = gitRepositoryFor(uri);
    // The Git extension's checkIgnore takes a list of paths and answers with the set of those it ignores.
    if (repo?.checkIgnore) return (await repo.checkIgnore([uri.fsPath])).has(uri.fsPath);
  } catch (_error) {
    // A missing or unavailable Git extension falls back to local ignore files.
  }
  return ignoredByGitIgnoreFiles(uri);
}

module.exports = { addGitIgnoreLines, withGitIgnoreLine, startsInside, secretIgnored };

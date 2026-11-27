"use strict";
/* global require, module, process */

const path = require("path");
const { SHELL_FOLDER_TOO_BIG } = require("../limits-and-messages.js");
const { walkSpent, ShellCheckTooLong, checkShellDeadline, stopIfSpent } = require("../check-budget.js");
const { trimEndOf, localDevicePaths, remoteLocation, isDirectoryTarget } = require("../path-forms/windows-paths.js");
const { drivePathsOf, secretByName } = require("../secret-paths/secret-path-check.js");
const { broadShellGlob, expandShellGlob, expandFolderGlob } = require("../path-forms/glob-expansion.js");
const {
  secretFolderByName,
  globNamesSecretFolder,
  filterNamesSecret,
  globSecretByName,
} = require("../secret-paths/secret-name-matching.js");
const { shellReplacesPart } = require("../shell-reading/shell-quoting.js");
const { findSecretInSearchTree } = require("../search-checks/search-check.js");

// ---------- Recursive reads ----------

// A cp destination glob Guard can't list the way Bash will: from the root, with `?`, a class, a brace list,
// `!`, `:<>|`, `~`, `$`, a backtick, a backslash or a control character, or a name starting with `.` (see
// copyLastIsSource).
const GLOB_NOT_LISTED = /^\/|[?[\]{}!:<>|~$`\\\0-\x1f]|(?:^|\/)\.(?:[^/]*$|\.\/)/;

// A recursive read's target, then the same target at each drive path it opens: a device path to a drive (see
// localDevicePaths), a drive's share (judged by name unless it's this computer's, see driveSharePaths) and a
// folder Windows tidies (see windowsTidiedPaths).
function drivePathTargets(target, cwd, budget) {
  // The path as an operand's check names it (see isSecretOperand), so what that check worked out is used
  // again.
  const written = target.path.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  const devices = localDevicePaths(written) || [];
  const { shares, tidied } = devices.length ? { shares: [], tidied: [] } : drivePathsOf(written, cwd, budget);
  if (!devices.length && !shares.length && !tidied.length) return [target];
  return [
    target,
    ...devices.map((drivePath) => ({ ...target, path: drivePath })),
    ...shares.map((item) => ({ ...target, path: item.drive, nameOnly: !item.loopback })),
    ...tidied.map((drivePath) => ({ ...target, path: drivePath })),
  ];
}

// cp's last word is a glob the shell expands first, so `cp -r src qqdata/*` copies every folder it matches
// but the last into that one. It's read as files copied too unless Guard can list what it matches, as Bash
// will (see SOLE_JOIN_READER_CALL), and finds one path or none: then Bash hands cp one destination, the path
// or the glob itself. Only for a glob of `*` and plain letters, which Guard matches the way Bash does, and so
// finds every path Bash can (without regard to case, so more if anything): not a `?`, which is one byte in
// the C locale, a class or brace list, a `!`, one of `:<>|`, which Git Bash keeps as other letters in a name,
// or a name starting with `.`, which Bash also matches to `.` and `..`. Nor for a path from the root: Git
// Bash's `/` and /tmp are its own folders, not the ones Node finds there, or one with a `..` part, which Bash
// takes from where a link before it leads, or when a path it finds ends in `.lnk`, which may be a link Git
// Bash made (see firstReadingWords). The first reading keeps a quoted word's quotes, and `'id*'` is no glob.
function copyLastIsSource(last, cwd, shellGlobs) {
  if (/^(["']).*\1$/s.test(last) || !/[*?[]/.test(last)) return false;
  if (!shellGlobs?.joinable || GLOB_NOT_LISTED.test(last)) return true;
  const matches = expandShellGlob(last, cwd, shellGlobs);
  return matches === null || matches.length > 1 || matches.some((match) => /\.lnk$/i.test(match));
}

// The folder a reader opens for an absolute path on Windows, which tidies it as localDevicePaths says: a
// part's one last dot dropped (`secrets.` opens `secrets`), and the last part's dots and spaces. Node looks a
// path up as written, so `secrets.` would be no folder to it. Elsewhere the path is opened as it is.
function windowsOpenedPath(absolutePath) {
  if (process.platform !== "win32") return absolutePath;
  const { root } = path.parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(path.sep);
  const tidied = parts.map((part, index) => {
    if (index === parts.length - 1) return trimEndOf(part, ". ") || part;
    return part.endsWith(".") && !part.endsWith("..") ? part.slice(0, -1) : part;
  });
  return root + tidied.join(path.sep);
}

// The folders a recursive reader could open for an absolute path: as written, which Git Bash's grep, cp and
// diff open, and on Windows as Windows tidies it (see windowsOpenedPath), which findstr and rg.exe open. Both
// are walked.
function openedFolders(absolutePath) {
  const tidied = windowsOpenedPath(absolutePath);
  return tidied === absolutePath ? [absolutePath] : [absolutePath, tidied];
}

// What makes one recursive read the same as another: the same reader, path and filters walk the same files.
const recursiveTargetKeys = new WeakMap();
function recursiveTargetKey(reader, target) {
  return [
    reader,
    target.path,
    target.glob || "",
    target.literal ? 1 : 0,
    target.nameOnly ? 1 : 0,
    describedOnce(target.filters),
  ]
    .concat(describedOnce(target.reachability))
    .join("\u0000");
}

// An object's JSON, worked out once per object (see recursiveTargetKeys); "" for no object.
function describedOnce(value) {
  if (!value || typeof value !== "object") return "";
  if (!recursiveTargetKeys.has(value)) recursiveTargetKeys.set(value, JSON.stringify(value));
  return recursiveTargetKeys.get(value);
}

// Walks each folder a recursive reader reads all of (see recursiveReadTargets), dotfiles included unless the
// reader skips them. A broad glob is expanded first, the way the shell will, and each folder it matches is
// walked; a glob Guard can't expand (after a `cd`, say) is judged by the secret names it could match. A
// target named again is checked once, and a folder walked once (see findSecretInSearchTree). A folder, or a
// glob's folders, that the walk's budget can't read in full stops the command unless its name already does: a
// big tree, or one padded on purpose, mustn't let a secret file deeper down through. Past the check's lookups
// a folder is still walked.
function secretInRecursiveRead(targets, reader, cwd, shell) {
  const { budget } = shell;
  const name = reader.toLowerCase();
  for (const target of targets.flatMap((item) => drivePathTargets(item, cwd, budget))) {
    const filePath = target.path.replace(/\\/g, "/");
    const expands = !target.literal && /[*?[]/.test(filePath);
    // A path already found to hold nothing, or no folder, has nothing below it to read, unless it's named as
    // a credentials folder (see secretFolderByName) through a part the shell replaces (see
    // shellReplacesPart): the shell opens that by another path (`$SOMEWHERE/.kube`). Named outright (`grep -r
    // x gh`), it opens nothing.
    if (
      !expands &&
      openedFolders(path.resolve(cwd, filePath)).every((each) => budget.directories.get(each) === false)
    ) {
      if (shellReplacesPart(filePath) && secretFolderByName(filePath, cwd)) return filePath;
      continue;
    }
    const key = recursiveTargetKey(name, target);
    if (budget.targets.has(key)) continue;
    budget.targets.add(key);
    checkShellDeadline(budget);
    const glob = target.glob || (expands ? target.path : null);
    // A folder on another computer is judged by its name too (see isRemotePath).
    if (target.nameOnly || walkSpent(budget) || remoteLocation(filePath, cwd)) {
      const found = secretInUnwalkedTarget(target, filePath, glob, cwd, budget);
      if (found) return found;
      continue;
    }
    // A glob judged only by its name before, `ke*` or `*/`, still is; its folders are walked as well.
    if (expands && !broadShellGlob(filePath) && glob && globSecretByName(glob, budget)) return glob;
    const folders = expands
      ? (expandShellGlob(filePath, cwd, shell, true) ?? expandFolderGlob(filePath, cwd, shell, true))
      : [filePath];
    // A glob through a part the shell replaces matches nothing here, so its name is all there is
    // (`$SOMEWHERE/.kub?`).
    if (expands && !folders?.length && shellReplacesPart(filePath) && globNamesSecretFolder(filePath)) {
      return filePath;
    }
    if (!folders) {
      budget.byName += 1;
      if (glob && globSecretByName(glob, budget)) return glob;
      continue;
    }
    const walked = secretInWalkedFolders(folders, target, { expands, glob, name, cwd, budget });
    if (walked) return walked;
  }
  return null;
}

// A target judged by name, not walked: a glob by the secret names it could match, a folder by its name, then
// the reader's own filters. Past the walk's budget, a folder on this computer stops the command.
function secretInUnwalkedTarget(target, filePath, glob, cwd, budget) {
  const found = secretByTargetName(filePath, glob, cwd, budget);
  if (found) return found;
  // So is the reader's own filter that names a credentials folder below it (`rg -g '.kube/*'`) or a secret
  // file (`--glob=.env`, `--include=*.pem`), or a file type it adds those globs to (`--type-add 'k:.env*'
  // -tk`).
  const filter = [...(target.filters?.include || []), ...(target.filters?.typeGlobs || [])].find(
    (pattern) => globNamesSecretFolder(pattern, { whole: true }) || filterNamesSecret(pattern),
  );
  if (filter) return path.posix.join(filePath, filter);
  // Only a folder on another computer is left unwalked; past the walk's budget the command is stopped.
  if (!remoteLocation(filePath, cwd)) stopIfSpent(budget);
  return null;
}

function secretByTargetName(folder, glob, cwd, budget) {
  budget.byName += 1;
  if (glob) return globSecretByName(glob, budget) || globNamesSecretFolder(glob) ? glob : null;
  // A credentials folder (`.kube`) is read for what it holds, which its own name doesn't say.
  if (secretFolderByName(folder, cwd)) return folder;
  // An operand the reader's own check already cleared needs no second look at its name.
  if (budget.verdicts.get(`shell\u0000${folder}`) === false) return null;
  return secretByName(folder, cwd, budget) ? folder : null;
}

// Walks each of a target's folders, as each is opened (see openedFolders), for a secret file.
function secretInWalkedFolders(folders, target, { expands, glob, name, cwd, budget }) {
  for (const folder of folders) {
    // Past the lookups a folder still costs one, as an operand does (see secretPastLookups), and is still
    // walked: the walk's own budget and the check's deadline bound what's left.
    checkShellDeadline(budget);
    const opened = openedFolders(path.resolve(cwd, folder));
    for (const directory of opened) {
      if (!budget.directories.has(directory)) {
        budget.lookups -= 1;
        budget.directories.set(directory, isDirectoryTarget(directory, cwd));
      }
    }
    // A credentials folder named through something the shell replaces (`$HOME/.kube`) and not found here is
    // judged by its name.
    if (
      !expands &&
      opened.every((each) => !budget.directories.get(each)) &&
      shellReplacesPart(folder) &&
      secretFolderByName(folder, cwd)
    ) {
      return folder;
    }
    for (const directory of opened) {
      if (!budget.directories.get(directory)) continue;
      const started = Date.now();
      const reachability = target.reachability || {};
      const found = findSecretInSearchTree(directory, target.filters, "shell", name, reachability, { budget });
      // The walk's time is given back to the lookups after it (all inside the check's own deadline), so a
      // path named after a big folder is still looked up rather than stopping the command.
      budget.lookupDeadline += Date.now() - started;
      if (found.file) return path.posix.join(folder, found.file);
      if (found.limited) {
        if (glob && globSecretByName(glob, budget)) return glob;
        // The walk has the path check's whole time, so one cut short by that deadline says so too.
        throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
      }
    }
  }
  return null;
}

module.exports = {
  drivePathTargets,
  copyLastIsSource,
  windowsOpenedPath,
  openedFolders,
  recursiveTargetKeys,
  recursiveTargetKey,
  secretInRecursiveRead,
};

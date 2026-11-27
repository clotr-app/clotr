"use strict";
/* global require, module, process */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isSecretFile } = require("../secret-files.js");
const { budgetSpent, lookupsSpent, ShellCheckTooLong, checkShellDeadline } = require("../check-budget.js");
const {
  localDevicePaths,
  windowsTidiedPaths,
  driveSharePaths,
  hasShortNamePart,
  opensUnknownDevice,
  remoteLocation,
  driveRelativeFromRemote,
  driveRelativeParts,
  driveRelativePlace,
  isRemotePath,
} = require("../path-forms/windows-paths.js");
const { searchTextKey } = require("../shell-reading/search-pattern-words.js");
const { looseWordCouldBe, globSecretByName } = require("./secret-name-matching.js");
const {
  chargeGlobListing,
  expandShellGlob,
  shellNameGlob,
  expandFolderGlob,
} = require("../path-forms/glob-expansion.js");
const { driveTopNames } = require("../path-forms/drive-top-folders.js");

// ---------- Secret path check ----------

// `byName: true` judges the path by its name alone, without the disk. Under a `budget` (see shellWalkBudget),
// its deadline is looked at before each lookup on disk.
function isSecretPath(filePath, content = "", cwd = process.cwd(), { byName = false, budget } = {}) {
  if (isSecretFile(filePath, content)) return true;
  // A file named with a trailing separator (`.kube\config\`) is opened as the file by some programs, so it's
  // judged as the file too, and so is one with a last part Windows drops after it (`.kube\config\ `,
  // `.kube\config\.`), though not `..`.
  if (typeof filePath === "string") {
    const trimmed = withoutTrailingParts(filePath);
    if (trimmed && trimmed !== filePath && !trimmed.endsWith(":")) {
      if (isSecretPath(trimmed, content, cwd, { byName, budget })) return true;
    }
  }
  const placed = driveRelativeVerdict(filePath, cwd, (name) => isSecretFile(name, content), budget);
  if (placed === true) return true;
  if (typeof placed === "string") return isSecretPath(placed, content, cwd, { byName, budget });
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (isSecretFile(absolutePath, content)) return true;
  // A device path to a drive, `\\?\C:\proj\ENV~1`, is judged as the drive paths it could open.
  const drivePaths = localDevicePaths(filePath);
  if (drivePaths !== null) {
    return drivePaths.some((drivePath) => isSecretPath(drivePath, content, cwd, { byName, budget }));
  }
  // A drive's share is judged as the drive path it opens: looked up on this computer's drive only for this
  // computer's share, and by name for another's (see driveSharePaths). A path Windows tidies is judged as
  // what it opens as well.
  const shares = driveSharePaths(filePath, cwd, { lookups: !byName, budget }) || [];
  const judged = (item) => isSecretPath(item.drive, content, cwd, { byName: byName || !item.loopback, budget });
  if (shares.some(judged)) return true;
  const tidied = windowsTidiedPaths(filePath, cwd) || [];
  if (tidied.some((drive) => judged({ drive, loopback: true }))) return true;
  if (byName) return false;
  if (remoteLocation(filePath, cwd)) return remoteSecretByName(filePath, absolutePath, content, cwd);
  if (budget) checkShellDeadline(budget);
  // A path with nothing at it has no real path either, and asking for one costs many times what a missing
  // entry does.
  try {
    if (fs.lstatSync(absolutePath, { throwIfNoEntry: false }) === undefined) return false;
  } catch {
    // Anything else wrong with the path is left to the real-path lookups below.
  }
  // Each lookup is tried even when the other throws: Node's own throws for some paths the system's resolves.
  if (budget) checkShellDeadline(budget);
  try {
    if (isSecretFile(fs.realpathSync(absolutePath), content)) return true;
  } catch {
    // Left to the system's lookup below.
  }
  // Only the system's own lookup expands a Windows short name, so `ENV~1` is seen as the `.env` it opens.
  if (budget) checkShellDeadline(budget);
  try {
    return isSecretFile(fs.realpathSync.native(absolutePath), content);
  } catch {
    return false;
  }
}

// A path without its trailing separators and the last parts Windows drops after one (` `, `.`), from the end,
// each character looked at once.
function withoutTrailingParts(filePath) {
  const separator = (at) => filePath[at] === "/" || filePath[at] === "\\";
  let end = filePath.length;
  for (;;) {
    let at = end;
    while (at > 0 && separator(at - 1)) at -= 1;
    let start = at;
    while (start > 0 && (filePath[start - 1] === "." || filePath[start - 1] === " ")) start -= 1;
    end = at;
    if (start === at || start === 0 || !separator(start - 1)) break;
    if (/^\.\. *$/.test(filePath.slice(start, at))) break;
    end = start;
  }
  return filePath.slice(0, end);
}

// A path Guard never looks up, judged by name: its `.` and `..` are resolved by name, as the system resolves
// them.
function remoteSecretByName(filePath, absolutePath, content, cwd) {
  if (isSecretFile(path.normalize(absolutePath), content)) return true;
  if (hasShortNamePart(filePath)) return true;
  if (opensUnknownDevice(filePath)) return true;
  return driveRelativeFromRemote(filePath, cwd);
}

// ---------- A process's environment ----------

// A process's environment under /proc holds every variable that process was started with, keys included. It's
// judged loosely, as written and with `//`, `.` and `..` folded: any path from the root whose first folder
// could be `proc`, or `dev` (`/dev/fd/..` is a process's folder), and whose last part could be `environ`,
// whatever lies between (`self`, `$$`, `1/task/1`), and wherever it's reached from (`/c/../proc` in Git
// Bash). A path is from the root when it starts with `/`, or with `~`, `$`, a backtick or a brace list, which
// can stand for one, or climbs with `..`; any other path is read on from the working folder, as Git Bash
// writes it (`C:\proj` is `/c/proj`). So `dev/*` or `../dev/*` in a project is no process's folder. A part
// with a glob counts as one that could match, and one with `$`, a backtick or a brace list too, but then the
// last part has to be written out letter for letter, or every `"$dir"/*` would count.
function procEnviron(filePath, cwd) {
  let written = filePath.replace(/\\/g, "/").replace(/["']/g, "");
  // Most paths end in a part that can't be `environ`: they're let go before the working folder is looked at.
  const end = written.slice(written.lastIndexOf("/") + 1);
  if (!/^\.{0,2}$/.test(end) && !looseWordCouldBe(end, "environ")) return false;
  const fromRoot = /^[/~$`{]/.test(written);
  const folder = gitBashFolder(cwd);
  if (!fromRoot && typeof folder === "string" && folder.startsWith("/")) written = `${folder}/${written}`;
  const rooted = fromRoot || written.startsWith("/") || /(?:^|\/)\.\.(?:\/|$)/.test(written);
  if (!rooted) return false;
  const parts = written.split("/");
  return environUnder(parts) || environUnder(foldDotParts(parts));
}

// A working folder as Git Bash writes it: `C:\proj` is `/c/proj`, and the temp folder is its /tmp. A POSIX
// one as is.
function gitBashFolder(cwd) {
  if (typeof cwd !== "string") return cwd;
  const drive = /^([A-Za-z]):[\\/]/.exec(cwd);
  if (!drive) return cwd;
  const folder = cwd.replace(/\\/g, "/");
  const tempFolder = os.tmpdir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" && folder.toLowerCase().startsWith(tempFolder.toLowerCase())) {
    const under = folder.slice(tempFolder.length);
    if (under === "" || under.startsWith("/")) return `/tmp${under}`;
  }
  return `/${drive[1].toLowerCase()}/${folder.slice(3)}`;
}

function environUnder(parts) {
  const last = parts.length - 1;
  if (last < 1 || !looseWordCouldBe(parts[last], "environ")) return false;
  let first = 0;
  while (first < last && (parts[first] === "" || parts[first] === "." || parts[first] === "..")) first += 1;
  if (first === last) return false;
  const lead = parts[first];
  if (!looseWordCouldBe(lead, "proc") && !looseWordCouldBe(lead, "dev")) return false;
  return !/[$`{]/.test(lead) || !/[*?[$`{]/.test(parts[last]);
}

// A path's parts with `.`, empty parts and each `..` with the part before it left out, in one pass: Node's
// path.posix.normalize takes time that grows with the square of a run of `../`.
function foldDotParts(parts) {
  const kept = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
    else kept.push(part);
  }
  return kept;
}

// ---------- Operands ----------

// `budget` is a shell check's (see shellWalkBudget), given with `shell` or, for a path a command opens
// without the shell expanding it, alone. Under one, verdicts are kept for the check's length, since a command
// can name the same operand thousands of times, and an operand past the check's lookups on disk is judged as
// secretPastLookups says.
function isSecretOperand(value, cwd, shell, budget = shell?.budget) {
  const filePath = value.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  if (procEnviron(filePath, cwd)) return true;
  // A device path to a drive, `\\?\C:\proj\ENV~1`, is judged as the drive paths it could open (see
  // localDevicePaths).
  const drivePaths = localDevicePaths(filePath);
  if (drivePaths !== null) {
    return drivePaths.some((drivePath) => isSecretOperand(drivePath, cwd, shell, budget));
  }
  const nameIsSecret = (name) => isSecretFile(name) || globSecretByName(name, budget);
  const placed = driveRelativeVerdict(filePath, cwd, nameIsSecret, budget);
  if (placed === true) return true;
  if (typeof placed === "string") return isSecretOperand(placed, cwd, shell, budget);
  const key = `${shell ? "shell" : "path"}\u0000${filePath}`;
  if (budget?.verdicts.has(key)) return budget.verdicts.get(key);
  let verdict;
  if (budget) checkShellDeadline(budget);
  // A drive's share, and a path Windows tidies, are judged as the drive paths they open (see isSecretPath).
  const { shares, tidied } = drivePathsOf(filePath, cwd, budget);
  // Those drive paths take lookups of their own, more than the path as written: once the check's lookups, or
  // the part of them these may use, are spent, a path that still needs them stops the command unless its name
  // already does, as one past them does (see secretPastLookups), so padding a command with them can't hold
  // the hook.
  const needsLookups = tidied.length || shares.some((item) => item.loopback);
  const outOfLookups = budget && needsLookups && drivePathBudgetSpent(budget);
  if (outOfLookups) {
    if (!secretByName(filePath, cwd, budget)) throw new ShellCheckTooLong();
    budget.verdicts.set(key, true);
    return true;
  }
  // A path judged by its name alone counts in `byName` (see secretInFirstShellReading).
  if (budget && shares.some((item) => !item.loopback)) budget.byName += 1;
  function shareIsSecret(item) {
    if (item.loopback) return isSecretOperand(item.drive, cwd, shell, budget);
    return secretByName(item.drive, cwd, budget);
  }
  const drivesSecret =
    shares.some(shareIsSecret) || tidied.some((drivePath) => isSecretOperand(drivePath, cwd, shell, budget));
  if (drivesSecret) {
    verdict = true;
  } else if (remoteLocation(filePath, cwd)) {
    if (budget) budget.byName += 1;
    verdict = secretByName(filePath, cwd, budget);
  } else if (budget && lookupsSpent(budget)) verdict = secretPastLookups(filePath, cwd, shell, budget);
  else {
    if (budget) budget.lookups -= 1;
    const known = budget && !/[*?[]/.test(filePath) ? literalOperandVerdict(filePath, cwd, budget) : undefined;
    verdict = known ?? secretOnDisk(filePath, cwd, shell, budget);
  }
  budget?.verdicts.set(key, verdict);
  return verdict;
}

// Whether a shell check's lookups, or the time its drive paths may take, are spent.
function drivePathBudgetSpent(budget) {
  return lookupsSpent(budget) || Date.now() >= budget.drivePathDeadline;
}

// A path looked up on disk, or for a glob, what the shell could expand it to.
function secretOnDisk(filePath, cwd, shell, budget) {
  if (isSecretPath(filePath, "", cwd, { budget })) return true;
  return shell ? shellGlobReadsSecret(filePath, cwd, shell) : globSecretByName(filePath, budget);
}

// The drive paths a path opens, its drive's share mapped (see driveSharePaths) and as Windows tidies it (see
// windowsTidiedPaths), worked out once in a shell check: an operand's own check and a recursive reader's walk
// both ask.
function drivePathsOf(filePath, cwd, budget) {
  // Kept by folder, then path: one long key per path took as long to build and look up as what it saved.
  let inFolder = budget?.drivePaths.get(cwd);
  if (budget && !inFolder) budget.drivePaths.set(cwd, (inFolder = new Map()));
  const known = inFolder?.get(filePath);
  if (known) return known;
  const found = {
    shares: driveSharePaths(filePath, cwd, { budget }) || [],
    tidied: windowsTidiedPaths(filePath, cwd) || [],
  };
  inFolder?.set(filePath, found);
  return found;
}

// A path without a wildcard is looked up once, and what's found is kept for a recursive reader's own look at
// it: a path with nothing at it is judged by its name, as isSecretPath would judge it, and is no folder to
// walk. Undefined when the lookup can't say, so the full check runs.
function literalOperandVerdict(filePath, cwd, budget) {
  const absolutePath = path.resolve(cwd, filePath);
  let stats;
  checkShellDeadline(budget);
  try {
    // A name its folder's listing can answer for (see listedInFolder), `0.` or `notes.txt `, costs no lookup
    // of its own.
    if (listedInFolder(absolutePath, budget) !== false) stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  } catch (error) {
    if (error instanceof ShellCheckTooLong) throw error;
    return undefined;
  }
  if (stats === undefined) {
    budget.directories.set(absolutePath, false);
    // A drive path's own name, as a tidied one is (see windowsTidiedPaths), is the same path: judged once.
    if (isSecretFile(filePath)) return true;
    return filePath.replace(/\//g, "\\") !== absolutePath && isSecretFile(absolutePath);
  }
  if (!stats.isSymbolicLink()) budget.directories.set(absolutePath, stats.isDirectory());
  return undefined;
}

// An operand left once a shell check's lookups are spent (see lookupsSpent). Its name alone can't tell a
// link, a junction or a Windows short name from the secret file it opens, so padding a command until the
// lookups run out mustn't let one through by its name: it stops the command unless its name already does. A
// path with nothing at it opens nothing, so it is judged by its name, as literalOperandVerdict judges one,
// after the same one quick lookup. A glob the shell expands could match anything in its folder, so it stops
// the command too.
function secretPastLookups(filePath, cwd, shell, budget) {
  if (secretByName(filePath, cwd, budget)) return true;
  if (shell && /[*?[]/.test(filePath)) throw new ShellCheckTooLong();
  const absolutePath = path.resolve(cwd, filePath);
  let found = listedInFolder(absolutePath, budget);
  if (found === undefined) {
    try {
      found = fs.lstatSync(absolutePath, { throwIfNoEntry: false }) !== undefined;
    } catch {
      found = true;
    }
  }
  if (found) throw new ShellCheckTooLong();
  budget.directories.set(absolutePath, false);
  return false;
}

// The most names a folder listing kept for one shell check may hold (see listedInFolder).
const FOLDER_LISTING_MAX_NAMES = 4096;

// Whether anything is at a path, told from its folder's listing, read once for the check and kept, so many
// operands in a few folders cost a few reads, not one lookup each: a folder that isn't there, as its own
// folder's listing tells, isn't read at all. Undefined when only a lookup can tell: a name that could be a
// short name (any 8.3 name, `0` or `CONFIG.TXT`, since one can be given to any file, and not only `ENV~1`), a
// stream, a device or other than plain ASCII (which the system may match in ways a listing doesn't), or a
// folder too big or unreadable. A name ending in a dot or a space (`0.`), which no short name does, is
// answered. Letter case is ignored on every system, so a name differing only in case is looked up.
function listedInFolder(absolutePath, budget, depth = 0) {
  const folder = path.dirname(absolutePath);
  const name = path.basename(absolutePath);
  if (folder === absolutePath || !/^[\x20-\x7e]+$/.test(name) || /[~:*?"<>|\\]/.test(name)) return undefined;
  if (/^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:[. ]|$)/i.test(name)) return undefined;
  if (/^[\w!#$%&'()@^`{}-]{1,8}(?:\.[\w!#$%&'()@^`{}-]{1,3})?$/.test(name)) return undefined;
  const fold = (text) => text.toLowerCase();
  if (!budget.folderNames.has(folder)) {
    let names;
    if (depth < 64 && listedInFolder(folder, budget, depth + 1) === false) names = null;
    else {
      checkShellDeadline(budget);
      try {
        const listed = fs.readdirSync(folder);
        names = listed.length > FOLDER_LISTING_MAX_NAMES ? undefined : new Set(listed.map(fold));
      } catch (error) {
        names = error?.code === "ENOENT" ? null : undefined;
      }
    }
    budget.folderNames.set(folder, names);
  }
  const names = budget.folderNames.get(folder);
  if (names === undefined) return undefined;
  return names !== null && names.has(fold(name));
}

// A path judged without the disk: its own name, where it resolves to, for a glob, the secret names it could
// match, and on a path Guard never looks up, a part that could be a Windows short name (see hasShortNamePart)
// or a device name Guard can't place (see opensUnknownDevice).
function secretByName(filePath, cwd, budget) {
  const key = `name\u0000${filePath}`;
  if (budget?.verdicts.has(key)) return budget.verdicts.get(key);
  const verdict =
    isSecretFile(filePath) ||
    isSecretFile(path.resolve(cwd, filePath)) ||
    globSecretByName(filePath, budget) ||
    hasShortNamePart(filePath) ||
    opensUnknownDevice(filePath) ||
    driveRelativeFromRemote(filePath, cwd);
  budget?.verdicts.set(key, verdict);
  return verdict;
}

// A drive-relative path (`D:.env`) opens below its drive's current folder (see driveRelativePlace). On
// Windows it's judged there when that folder is known. When it isn't, a secret name after the colon stops it,
// and otherwise it's judged as written, at the drive path Node guesses, where a short name or a junction is
// looked up on disk. A wildcard is matched on disk instead of by name (see unplacedDriveGlob), since a word
// like `k:*.txt` is as often an option's value, an rg type or a glob, as a path. A word a search reads as
// text (see searchTextWords) isn't matched on disk, and is judged as written. Gives the drive path to judge,
// true for a secret, or undefined to judge the path as written. From a folder on another computer it's left
// to driveRelativeFromRemote.
function driveRelativeVerdict(filePath, cwd, byName, budget) {
  const parts = driveRelativeParts(filePath);
  if (!parts || (typeof cwd === "string" && isRemotePath(cwd))) return undefined;
  const place = process.platform === "win32" ? driveRelativePlace(filePath, cwd) : null;
  if (place) return place;
  if (!/[*?[]/.test(parts.rest)) return byName(parts.rest) ? true : undefined;
  // Off Windows the word names a file in the working folder, judged as written.
  if (process.platform !== "win32") return undefined;
  if (budget?.searchText?.has(searchTextKey(filePath))) return undefined;
  const found = unplacedDriveGlob(filePath, budget);
  if (found === null) return byName(parts.rest) ? true : undefined;
  return found || undefined;
}

// ---------- Drive top folders ----------

// A wildcard behind a drive whose current folder can't be known (`type D:*.txt`) is matched in the folder
// Node guesses for it, as the program given it would expand it, dotfiles included. True when a match is a
// secret file, false when none is or the drive isn't there, and null when Guard can't list the folder in time
// (see driveTopNames) or the folder has a wildcard of its own, so the name decides.
function unplacedDriveGlob(filePath, budget) {
  const guess = path.win32.resolve(filePath);
  const folder = path.win32.dirname(guess);
  const glob = shellNameGlob(path.win32.basename(guess));
  if (!glob || /[*?[]/.test(folder)) return null;
  // The same wildcard is judged again on a later pass, so its answer is kept and its lookups are charged
  // once.
  const key = `${folder.toLowerCase()}\u0000${path.win32.basename(guess)}`;
  if (budget?.driveGlobs?.has(key)) return budget.driveGlobs.get(key);
  if (budgetSpent(budget) || (budget && lookupsSpent(budget))) return null;
  const found = matchDriveGlob(folder, glob, budget);
  if (budget) {
    if (!budget.driveGlobs) budget.driveGlobs = new Map();
    budget.driveGlobs.set(key, found);
  }
  return found;
}

function matchDriveGlob(folder, glob, budget) {
  const entries = driveTopNames(folder, budget);
  if (!entries) return entries;
  if (!chargeGlobListing(budget, entries.length, false)) return null;
  const matches = entries.filter((entry) => glob.matches(entry));
  if (budget) budget.lookups -= matches.length;
  return matches.some((entry) => isSecretPath(path.win32.join(folder, entry), "", folder));
}

// ---------- Glob expansion ----------

// A shell glob (`*.txt`, `config*`, `cert/server.p?m`, `*/x*`) is expanded against its folder, the way the
// shell will, its folders one level at a time, so it's stopped only when a file it matches there is a secret
// file; Bash's `*` leaves dotfiles out, PowerShell's doesn't. A folder Guard can't read as plain text, a
// command that changes folder, or a glob left once the budget is spent is judged by the secret names it could
// match instead.
function shellGlobReadsSecret(pattern, cwd, shell) {
  if (!/[*?[]/.test(pattern)) return false;
  let matches = expandShellGlob(pattern, cwd, shell);
  if (matches === null || matches === undefined) matches = shell.budget ? expandFolderGlob(pattern, cwd, shell) : null;
  if (!matches) {
    if (shell.budget) shell.budget.byName += 1;
    return globSecretByName(pattern, shell.budget);
  }
  if (shell.budget) shell.budget.lookups -= matches.length;
  return matches.some((match) => isSecretPath(match, "", cwd) || procEnviron(match, cwd));
}

module.exports = {
  isSecretPath,
  procEnviron,
  gitBashFolder,
  environUnder,
  foldDotParts,
  isSecretOperand,
  drivePathsOf,
  literalOperandVerdict,
  secretPastLookups,
  FOLDER_LISTING_MAX_NAMES,
  listedInFolder,
  secretByName,
  shellGlobReadsSecret,
};

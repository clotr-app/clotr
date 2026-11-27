"use strict";
/* global require, module, process */

const os = require("os");
const path = require("path");

// ---------- Path readings ----------

// A home folder written at a path's start: `~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%`,
// `$USERPROFILE` and their other spellings.
const HOME_PREFIX = new RegExp(
  `^(?:${[
    "~",
    String.raw`\$HOME`,
    String.raw`\$\{HOME\}`,
    String.raw`\$env:(?:USERPROFILE|HOME)`,
    String.raw`\$\{env:(?:USERPROFILE|HOME)\}`,
    "%(?:USERPROFILE|HOME)%",
    String.raw`\$USERPROFILE`,
    String.raw`\$\{USERPROFILE\}`,
  ].join("|")})(?=[\\\\/]|$)`,
  "i",
);
// A shell's other names for its working folder (see pathReadings).
const SHELL_CWD_NAME = /^(?:~(?:\+|[+-]?0)|\/proc\/(?:self|thread-self|\d+)\/cwd)(?=\/|$)/;

// The home folders `~` and a home variable can name: USERPROFILE (PowerShell's and cmd's), HOME (Git Bash's,
// which may be written as a Git Bash drive path, `/c/Users/me`) and the account's own. Only absolute ones
// count.
function homeFolders() {
  const found = [];
  let own = "";
  try {
    own = os.homedir();
  } catch {
    // No home folder for this account: the variables are all there is.
  }
  for (const value of [process.env.USERPROFILE, process.env.HOME, own]) {
    if (typeof value !== "string" || !value) continue;
    const folder = gitBashDrivePath(value) ?? value;
    if (path.isAbsolute(folder) && !found.includes(folder)) found.push(folder);
  }
  return found;
}

// A Git Bash path as Git Bash tidies it before opening it: its `.` and `..` parts resolved (`/./c`,
// `/tmp/../c` and `/usr/../c` are `/c`) and `/proc/cygdrive` read as `/cygdrive`. Null for a path that
// doesn't start with one slash: `//host` is a share, and a relative path isn't a Git Bash one.
function gitBashTidied(value) {
  const text = value.replace(/\\/g, "/");
  if (!text.startsWith("/") || /^\/\/(?!\/)/.test(text)) return null;
  return path.posix.normalize(text).replace(/^\/proc(?=\/cygdrive(?:\/|$))/i, "");
}

// Whether a Git Bash path names a whole drive (`/c`, `/d/`, `/cygdrive/c`, `/./c`), which a recursive reader
// reads every file of. Only on Windows, where Git Bash maps those to drives.
function gitBashDriveRoot(value) {
  if (process.platform !== "win32" || typeof value !== "string") return false;
  const tidied = gitBashTidied(value.replace(/^\s*(['"])([^]*)\1\s*$/, "$2"));
  return Boolean(tidied && /^\/(?:cygdrive\/)?[a-z]\/?$/i.test(tidied));
}

// A Git Bash path on Windows as the drive path it opens: `/c/rest` and `/cygdrive/c/rest` are `C:/rest`, and
// `/tmp` is the account's temporary folder, after Git Bash tidies it (see gitBashTidied). Null for any other
// path, and elsewhere than Windows. `//host` is a share, not a drive.
function gitBashDrivePath(value) {
  if (process.platform !== "win32") return null;
  const text = gitBashTidied(value);
  if (!text) return null;
  const drive = /^\/(?:cygdrive\/)?([a-z])(?=\/|$)/i.exec(text);
  if (drive) return `${drive[1].toUpperCase()}:${text.slice(drive[0].length) || "/"}`;
  if (/^\/tmp(?=\/|$)/i.test(text)) return `${os.tmpdir().replace(/\\/g, "/")}${text.slice(4)}`;
  return null;
}

// The other paths a shell or a tool may open for a path as written: with a leading `~`, or a home variable
// (`$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%`, `$USERPROFILE`), as each home folder (see
// homeFolders), and a Git Bash drive path, in a Git Bash command (`gitBash`), as the drive path (see
// gitBashDrivePath): only one with a folder below the letter (`/c/Users`), as a bare `/s` is a switch to
// findstr, sort or more, and looking up `S:\` could reach the computer a mapped drive names. Quotes around
// the path are kept off. Other variables aren't known, so a path through one is judged by its name (see
// secretInRecursiveRead). `homeOnly` reads only a leading `~`, as a file tool that expands one does.
function pathReadings(value, { homeOnly = false, gitBash = false } = {}) {
  if (typeof value !== "string" || !value) return [];
  const text = value.replace(/^\s*(['"])([^]*)\1\s*$/, "$2").replace(/^['"]|['"]$/g, "");
  const readings = [];
  // A shell's other names for its working folder: Bash's `~+`, and `~0`, `~+0` and `~-0` from its folder
  // stack, and a process's `/proc/.../cwd`, also through `//`, `/./` or `/proc/self/root`, which Guard's own
  // process would open as its own working folder, not the command's.
  if (!homeOnly) {
    const tidied = text
      .replace(/\\/g, "/")
      .replace(/\/(?:\.?\/)+/g, "/")
      .replace(/^(?:\/proc\/(?:self|thread-self|\d+)\/root(?=\/))+/, "");
    const here = SHELL_CWD_NAME.exec(tidied);
    if (here) return [`.${tidied.slice(here[0].length)}`];
  }
  const home = homeOnly ? /^~(?=[\\/]|$)/.exec(text) : HOME_PREFIX.exec(text);
  if (home) {
    for (const folder of homeFolders()) readings.push(folder.replace(/[\\/]+$/, "") + text.slice(home[0].length));
  } else if (gitBash && /^\/(?:(?:cygdrive\/)?[a-z]\/|tmp(?:\/|$))/i.test(gitBashTidied(text) || "")) {
    const drivePath = gitBashDrivePath(text);
    if (drivePath) readings.push(drivePath);
  }
  return [...new Set(readings)].filter((reading) => reading !== value);
}

// The paths in a PowerShell list (`notes.txt,.env`), which a cmdlet reads each of and PowerShell hands a
// program as words of their own; commas inside quotes or braces (`*.{js,ts}`) don't part it. Empty when
// there's no list.
function listedPaths(value) {
  if (typeof value !== "string" || !value.includes(",")) return [];
  const pieces = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      pieces.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (!pieces.length) return [];
  pieces.push(value.slice(start));
  return pieces.filter(Boolean);
}

module.exports = {
  homeFolders,
  gitBashTidied,
  gitBashDriveRoot,
  gitBashDrivePath,
  pathReadings,
  listedPaths,
};

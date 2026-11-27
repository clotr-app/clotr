"use strict";
/* global require, module, process */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkShellDeadline } = require("../check-budget.js");
const { commandName, commandStart } = require("../shell-reading/nested-commands.js");

// ---------- Following names ----------

// A value with nothing the shell fills in when it runs. The parser puts a `\u2026` mark where a `( … )`, `$(
// … )` or backtick group sat, so a word holding one isn't plain either.
const FOLLOW_PLAIN = /^[^$`\u2026%]+$/;
const FOLDER_CHANGES = /^(?:cd|pushd|chdir|set-location|sl|push-location)$/;
const FOLDER_RETURNS = /^(?:popd|pop-location)$/;
const DECLARES = /^(?:export|declare|typeset|local|readonly)$/;
// The walk's lookups that are kept under a path as written, so a command in another folder needs its own.
const FOLLOW_CACHES = ["folders", "targets", "verdicts", "listings", "folderNames"];

// How many `cd`s in a row to folders not on disk are followed (see folderFollowed).
const FOLLOW_MISSING_MAX = 32;

// What earlier commands in the same shell text did that a later command's names depend on: the folder it runs
// in, the variables given a plain value, and the paths a rename or a link made, each mapped to the path it
// stands for. A step Guard can't follow, a folder or a name only made when the command runs, isn't kept, so
// what comes after it is judged in the folder the command started in, with the names as written. `caches`
// holds the walk's lookups for each folder the commands move to, and `moves` where in the text each folder
// change is, with the folder it left, so a Bash subshell's change ends with it.
function followStart(cwd) {
  return { cwd, vars: new Map(), names: new Map(), caches: new Map(), moves: [], missing: 0, prev: null };
}

// A path with its case folded as the system folds it.
function foldCase(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function followedPath(value, cwd) {
  if (value === "~" || /^~[\\/]/.test(value)) return path.join(os.homedir(), value.slice(1));
  return path.resolve(cwd, value);
}

// The path a made name stands for, or null: `zz.txt` after `mv .env zz.txt`, `k/config` after `ln -s .kube
// k`. `names` is keyed by each made path with its case folded as the system folds it (see foldCase). The path
// and each folder above it are looked up in turn, nearest first, so the time it takes doesn't grow with the
// names made.
function madeNameOf(absolute, names) {
  for (let at = absolute; ;) {
    const made = names.get(foldCase(at));
    if (made) return made.stands + absolute.slice(made.path.length);
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

// A word's value with the variables set earlier filled in: `$u` and `${u}`, PowerShell's in any case, cmd's
// `%u%`.
function withFollowedVars(value, vars, dialect) {
  if (!vars.size || !/[$%]/.test(value)) return value;
  return value.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g, (whole, braced, bare, cmd) => {
    const key = followedVarKey(braced || bare, cmd, dialect);
    return vars.has(key) ? vars.get(key) : whole;
  });
}

// The key a variable is kept under: cmd's and PowerShell's in lower case, as those shells ignore it.
function followedVarKey(name, cmdName, dialect) {
  if (cmdName) return `cmd:${cmdName.toLowerCase()}`;
  return dialect === "bash" ? `sh:${name}` : `ps:${name.toLowerCase()}`;
}

function followedValue(value, dialect, follow, option = false) {
  let followed = withFollowedVars(value, follow.vars, dialect);
  if (follow.names.size && !option && FOLLOW_PLAIN.test(followed)) {
    const stands = madeNameOf(followedPath(followed, follow.cwd), follow.names);
    // Shown as the person would name it from where the command is, when it's inside that folder.
    const inside = stands && path.relative(follow.cwd, stands);
    const showInside = inside && !inside.startsWith("..") && !path.isAbsolute(inside);
    if (stands) followed = showInside ? inside : stands;
  }
  return followed;
}

// A command's words with what earlier commands did followed, or the same array when nothing changes.
function followedWords(words, dialect, follow) {
  if (!follow.vars.size && !follow.names.size) return words;
  let changed = false;
  const followed = words.map((word) => {
    const value = followedValue(word.value, dialect, follow, !word.quoted && word.value.startsWith("-"));
    if (value === word.value) return word;
    changed = true;
    return { ...word, value };
  });
  return changed ? followed : words;
}

// Splits words into the values of the parameters in `named` (each a list of names, written with any start of
// three letters or more, as PowerShell takes them, or glued on with `=` or `:`), the options, and the rest.
function splitFollowArgs(words, named) {
  const values = {};
  const options = [];
  const rest = [];
  for (let at = 0; at < words.length; at += 1) {
    const { value, quoted } = words[at];
    if (quoted || !/^-./.test(value)) {
      rest.push(value);
      continue;
    }
    const glued = /^(--?[A-Za-z][\w-]*)[=:]([\s\S]*)$/.exec(value);
    const option = (glued ? glued[1] : value).replace(/^-+/, "").toLowerCase();
    const key = Object.keys(named).find((each) =>
      named[each].some((name) => name === option || (option.length >= 3 && name.startsWith(option))),
    );
    if (!key) options.push(value);
    else if (glued) values[key] = glued[2];
    else {
      values[key] = words[at + 1]?.value ?? "";
      at += 1;
    }
  }
  return { values, options, rest };
}

function isFolder(absolute) {
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

// Notes what one command does that later commands depend on (see followStart). A rename or link looks on disk
// for a folder it moves into, so each one answers to the check's deadline.
function noteFollowed(command, dialect, follow, cwd, budget = null) {
  if (dialect === "bash") endSubshells(command.words, follow);
  const words = followedWords(command.words, dialect, follow);
  follow.prev = { ...command, words };
  if (dialect === "powershell" && notePowerShellAssignment(words, follow)) return;
  const k = commandStart(words, dialect);
  if (k >= words.length) {
    if (dialect === "bash") noteAssignments(words, follow);
    return;
  }
  const name = commandName(words[k].value).toLowerCase();
  const args = words.slice(k + 1);
  if (dialect === "bash" && DECLARES.test(name)) noteAssignments(args, follow);
  else if (name === "set" && args.length === 1) noteCmdSet(args[0].value, follow);
  else if (FOLDER_CHANGES.test(name)) moveTo(follow, folderFollowed(args, dialect, follow, cwd), words[0].start);
  else if (FOLDER_RETURNS.test(name)) moveTo(follow, cwd, words[0].start);
  else {
    if (budget) checkShellDeadline(budget);
    for (const made of madePaths(name, args, follow)) follow.names.set(foldCase(made.path), made);
  }
}

function moveTo(follow, folder, at) {
  if (folder === follow.cwd) return;
  follow.moves.push({ at, from: follow.cwd });
  follow.cwd = folder;
}

// A Bash `( … )` or `$( … )` runs in a subshell, so a folder change inside it is undone where it closes. The
// parser leaves a mark word (see FOLLOW_PLAIN) that spans the text the subshell held. A `{ …; }` group isn't
// a subshell, and PowerShell's folder is the same in every group, so neither is undone.
function endSubshells(words, follow) {
  for (const word of words) {
    if (!word.grouped || word.start < 0) continue;
    const moves = follow.moves;
    while (moves.length && moves[moves.length - 1].at >= word.start && moves[moves.length - 1].at < word.end) {
      follow.cwd = moves.pop().from;
    }
  }
}

function setFollowedVar(follow, key, value) {
  if (FOLLOW_PLAIN.test(value)) follow.vars.set(key, value);
  else follow.vars.delete(key);
}

// Bash's `u=.env`, alone or after `export`.
function noteAssignments(words, follow) {
  for (const { value } of words) {
    const set = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(value);
    if (set) setFollowedVar(follow, `sh:${set[1]}`, set[2]);
  }
}

// PowerShell's `$f = ".env"` or `$f=".env"`; true when the command is one.
function notePowerShellAssignment(words, follow) {
  const glued = words.length === 1 && /^\$([A-Za-z_]\w*)=([\s\S]*)$/.exec(words[0].value);
  if (glued) {
    setFollowedVar(follow, `ps:${glued[1].toLowerCase()}`, glued[2]);
    return true;
  }
  const name = words.length >= 2 && words[1].value === "=" && /^\$([A-Za-z_]\w*)$/.exec(words[0].value);
  if (!name) return false;
  // Only one plain value is followed; `$f = gc x` gives `$f` a value Guard doesn't know.
  setFollowedVar(follow, `ps:${name[1].toLowerCase()}`, words.length === 3 ? words[2].value : "$");
  return true;
}

// cmd's `set u=.env`.
function noteCmdSet(value, follow) {
  const set = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(value);
  if (set) setFollowedVar(follow, `cmd:${set[1].toLowerCase()}`, set[2]);
}

// The folder a `cd` moves to. One Guard can't place (`cd -`, `cd "$(mktemp -d)"`) is taken as the one the
// command started in.
function folderChangedTo(args, dialect, follow, cwd) {
  const { values, rest } = splitFollowArgs(args, { path: ["path", "literalpath"] });
  const to = values.path ?? rest.find((value) => !/^\/d$/i.test(value));
  if (to === undefined) return dialect === "bash" ? os.homedir() : follow.cwd;
  if (to === "-" || !FOLLOW_PLAIN.test(to) || /[*?[]/.test(to)) return cwd;
  return followedPath(to, follow.cwd);
}

// The folder a `cd` is followed to. One that isn't on disk and isn't a made name can only be one the command
// makes first (`mkdir -p x && cd x`). After FOLLOW_MISSING_MAX of those in a row, as in `cd a; cd a; …`, the
// folder is taken as the one the command started in, so the path followed stays short and a long chain is
// checked in step with its length.
function folderFollowed(args, dialect, follow, cwd) {
  const to = folderChangedTo(args, dialect, follow, cwd);
  // A folder inside one that isn't there isn't there either, so the disk isn't asked again.
  const inMissing = follow.missing > 0 && to.startsWith(follow.cwd + path.sep);
  if (followedFolderFound(to, cwd, inMissing, follow)) follow.missing = 0;
  else follow.missing += 1;
  if (follow.missing <= FOLLOW_MISSING_MAX) return to;
  follow.missing = 0;
  return cwd;
}

// Whether a folder followed to is there: the starting folder, a folder on disk, or a made name.
function followedFolderFound(to, cwd, inMissing, follow) {
  if (to === cwd) return true;
  if (!inMissing && isFolder(to)) return true;
  return Boolean(follow.names.size && madeNameOf(to, follow.names));
}

// The paths a rename, a move or a link makes, each with the path it stands for.
function madePaths(name, args, follow) {
  if (/^(?:mv|move|mi|move-item)$/.test(name)) return madeByMove(args, follow);
  if (/^(?:ren|rename|rni|rename-item)$/.test(name)) return madeByRename(args, follow);
  if (name === "ln") return madeByLn(args, follow);
  if (name === "mklink") return madeByMklink(args, follow);
  if (name === "new-item" || name === "ni") return madeByNewItem(args, follow);
  return [];
}

// A path as the commands so far would open it.
function followedAt(follow, value) {
  return followedPath(value, follow.cwd);
}

// A name Guard can follow: written out, with no variable, group or wildcard.
function isPlainName(value) {
  return typeof value === "string" && FOLLOW_PLAIN.test(value) && !/[*?[]/.test(value);
}

// Where `source` lands when moved or linked into `folder`.
function followedInto(follow, folder, source) {
  return path.join(followedAt(follow, folder), path.basename(source));
}

function madeByMove(args, follow) {
  const { values, rest } = splitFollowArgs(args, {
    source: ["path", "literalpath"],
    to: ["destination"],
    folder: ["t", "target-directory"],
  });
  const namedTo = values.folder || values.to;
  const sources = values.source ? [values.source] : rest.slice(0, namedTo ? rest.length : -1);
  const to = values.folder ?? values.to ?? rest[rest.length - 1];
  if (!isPlainName(to)) return [];
  const intoFolder =
    Boolean(values.folder) || sources.length > 1 || isFolder(followedAt(follow, to)) || /[\\/]$/.test(to);
  return sources.filter(isPlainName).map((source) => ({
    path: intoFolder ? followedInto(follow, to, source) : followedAt(follow, to),
    stands: followedAt(follow, source),
  }));
}

function madeByRename(args, follow) {
  const { values, rest } = splitFollowArgs(args, { source: ["path", "literalpath"], to: ["newname"] });
  const source = values.source ?? rest[0];
  const to = values.to ?? rest[values.source ? 0 : 1];
  if (!isPlainName(source) || !isPlainName(to)) return [];
  const sourcePath = followedAt(follow, source);
  return [{ path: path.join(path.dirname(sourcePath), to), stands: sourcePath }];
}

function madeByLn(args, follow) {
  const { values, options, rest } = splitFollowArgs(args, { folder: ["t", "target-directory"] });
  const symbolic = options.some((option) => /^-[A-Za-z]*s|^--symbolic$/.test(option));
  const [target, link] = rest;
  // A link with no target makes nothing: `ln -s` alone.
  if (!isPlainName(target)) return [];
  let where = null;
  if (values.folder) where = followedInto(follow, values.folder, target);
  else if (link === undefined) where = followedInto(follow, ".", target);
  if (!where && !isPlainName(link)) return [];
  let made = where;
  if (!made) made = isFolder(followedAt(follow, link)) ? followedInto(follow, link, target) : followedAt(follow, link);
  // A symbolic link's target is found from the folder the link is in.
  const stands = symbolic ? path.resolve(path.dirname(made), target) : followedAt(follow, target);
  return [{ path: made, stands }];
}

function madeByMklink(args, follow) {
  const hard = args.some((word) => /^\/[hj]$/i.test(word.value));
  const [link, target] = args.map((word) => word.value).filter((value) => !/^\/[dhj]$/i.test(value));
  if (!isPlainName(link) || !isPlainName(target)) return [];
  const linkPath = followedAt(follow, link);
  const stands = hard ? followedAt(follow, target) : path.resolve(path.dirname(linkPath), target);
  return [{ path: linkPath, stands }];
}

function madeByNewItem(args, follow) {
  const { values, rest } = splitFollowArgs(args, {
    type: ["itemtype", "type"],
    where: ["path"],
    name: ["name"],
    target: ["target", "value"],
  });
  const where = values.where ?? rest[0];
  if (!/^(?:symboliclink|hardlink|junction)$/i.test(values.type || "")) return [];
  if (!isPlainName(where) || !isPlainName(values.target)) return [];
  if (values.name !== undefined && !isPlainName(values.name)) return [];
  const wherePath = followedAt(follow, where);
  return [
    { path: values.name ? path.join(wherePath, values.name) : wherePath, stands: followedAt(follow, values.target) },
  ];
}

// Runs `check` with the walk's lookups for the folder the commands moved to (see FOLLOW_CACHES).
function inFollowedFolder(follow, cwd, budget, check) {
  if (follow.cwd === cwd || !budget) return check();
  if (!follow.caches.has(follow.cwd)) {
    follow.caches.set(
      follow.cwd,
      Object.fromEntries(FOLLOW_CACHES.map((name) => [name, new budget[name].constructor()])),
    );
  }
  const kept = Object.fromEntries(FOLLOW_CACHES.map((name) => [name, budget[name]]));
  Object.assign(budget, follow.caches.get(follow.cwd));
  try {
    return check();
  } finally {
    Object.assign(budget, kept);
  }
}

// ---------- Remote runs and folder copies ----------

// Lead-ins that run their command on another computer or in a container, where a file named is not this one.
const REMOTE_LEAD_INS = /^(?:ssh|kubectl|docker|podman|docker-compose)$/;
// Copies that can take a whole folder.
const RECURSIVE_COPIES = /^(?:robocopy|xcopy|rsync|scp)$/;

module.exports = {
  FOLLOW_PLAIN,
  followStart,
  followedValue,
  followedWords,
  noteFollowed,
  inFollowedFolder,
  REMOTE_LEAD_INS,
  RECURSIVE_COPIES,
};

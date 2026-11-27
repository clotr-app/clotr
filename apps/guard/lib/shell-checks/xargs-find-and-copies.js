"use strict";
/* global require, module */

const fs = require("fs");
const path = require("path");
const { EMPTY_FILTERS } = require("../shell-reading/recursive-read-targets.js");
const { commandName, commandStart, shellRedirection } = require("../shell-reading/nested-commands.js");
const { FOLLOW_PLAIN } = require("./folder-changes-and-variables.js");
const { secretOperandOpened, secretInReaderTargets } = require("./opened-file-check.js");

// ---------- Names passed on ----------

function plainWord(value) {
  return { value, start: -1, end: -1, quoted: false, partQuoted: false };
}

// The file `xargs -a` takes its names from: its lines become the command's words, so the command shows what's
// in it.
function xargsArgFile(options) {
  for (let at = 0; at < options.length; at += 1) {
    const { value } = options[at];
    if (value === "-a" || value === "--arg-file") return options[at + 1]?.value ?? null;
    const glued = /^(?:-a|--arg-file=)([\s\S]+)$/.exec(value);
    if (glued) return glued[1];
  }
  return null;
}

// The names a command prints for `xargs`, as `{ names }` or, from `find` or `ls -R`, `{ targets }` for a
// walk. Null for one whose names Guard can't know before it runs (`git ls-files`, `cat list.txt`).
function namesFed(prev, dialect) {
  const { words } = prev;
  const nameAt = commandStart(words, dialect);
  if (nameAt >= words.length) return null;
  const name = commandName(words[nameAt].value).toLowerCase();
  const args = words.slice(nameAt + 1).filter((word) => !shellRedirection(word));
  const values = args.map((word) => word.value);
  if (name === "echo" || name === "printf") {
    const given =
      name === "echo" ? values.filter((value) => !/^-[neE]+$/.test(value)) : values.slice(values.length > 1);
    const names = given.filter((value) => FOLLOW_PLAIN.test(value)).flatMap((value) => value.split(/\s+|\\[nt0]/));
    return { names: names.filter(Boolean) };
  }
  if (name === "find") return { targets: findReads(words, nameAt, words.length) };
  if (name === "ls") return namesFedByLs(values);
  return null;
}

// What `ls` prints for `xargs`: a walk of each folder with `-R`, else each folder's names as globs.
function namesFedByLs(values) {
  const options = values.filter((value) => /^-./.test(value));
  const folders = values.filter((value) => !/^-./.test(value));
  const all = options.some((option) => /^-[A-Za-z1]*[aA]|^--(?:all|almost-all)$/.test(option));
  const recursive = options.some((option) => /^-[A-Za-z1]*R|^--recursive$/.test(option));
  const listed = folders.length ? folders : ["."];
  if (recursive) return { targets: listed.map((folder) => ({ path: folder, filters: EMPTY_FILTERS })) };
  const names = listed.flatMap((folder) => [
    ...(folder === "." ? [] : [folder]),
    ...(all ? [globInFolder(folder, ".*")] : []),
    globInFolder(folder, "*"),
  ]);
  return { names };
}

function globInFolder(folder, glob) {
  return folder === "." ? glob : path.posix.join(folder, glob);
}

// What `find` hands on, from its words up to `end` (its `-exec`, or the end for a pipe): each folder it
// starts in, with the names its `-name` or `-iname` tests keep (see findNamesKept). When its test keeps no
// names Guard can be sure of, every file under the folder counts.
function findReads(words, nameAt, end) {
  const kept = [];
  for (let at = nameAt + 1; at < end; at += 1) {
    const redirection = shellRedirection(words[at]);
    if (redirection === "word") at += 1;
    else if (!redirection) kept.push(words[at].value);
  }
  let at = 0;
  while (at < kept.length && /^-(?:[HLP]|O\d|D)$/.test(kept[at])) at += kept[at] === "-D" ? 2 : 1;
  const starts = [];
  while (at < kept.length && !/^[-(!)]/.test(kept[at])) {
    starts.push(kept[at]);
    at += 1;
  }
  const names = findNamesKept(kept.slice(at), end < words.length);
  const include = [];
  for (const { pattern, folded } of names || []) {
    include.push(pattern);
    if (folded) include.push(pattern.toLowerCase(), pattern.toUpperCase());
  }
  const filters = include.length ? { include, exclude: [] } : EMPTY_FILTERS;
  return (starts.length ? starts : ["."]).map((start) => ({ path: start, filters }));
}

// find's tests that take no value, and those that take one.
const FIND_BARE = findTestPattern([
  "true",
  "false",
  "empty",
  "readable",
  "writable",
  "executable",
  "prune",
  "quit",
  "depth",
  "d",
  "mount",
  "xdev",
  "follow",
  "nowarn",
  "warn",
  "noleaf",
  "daystart",
  "ignore_readdir_race",
  "noignore_readdir_race",
  "delete",
  "ls",
  "print0?",
  "nouser",
  "nogroup",
]);
const FIND_VALUED = findTestPattern([
  "i?name",
  "i?path",
  "i?wholename",
  "i?regex",
  "i?lname",
  "x?type",
  "maxdepth",
  "mindepth",
  "size",
  "newer",
  "[acm]newer",
  "perm",
  "user",
  "group",
  "uid",
  "gid",
  "[acm](?:time|min)",
  "links",
  "inum",
  "samefile",
  "fstype",
  "used",
  "regextype",
  "printf",
  "fprint0?",
  "fls",
  "context",
]);
// The tests that print a name or run a command on it.
const FIND_ACTS = /^-(?:print0?|printf|fprint0?|fprintf|ls|fls|exec|execdir|ok|okdir)$/;

// A whole `-test` word among `names`.
function findTestPattern(names) {
  return new RegExp(`^-(?:${names.join("|")})$`);
}

// Reads find's test into a tree: `{ or }`, `{ and }`, `{ not }` and `{ test, value }`. Null when Guard can't
// read it: a test it doesn't know, a bracket left open, or a `,`.
function findTree(test) {
  let at = 0;
  function unary() {
    const word = test[at];
    if (word === "!" || word === "-not") {
      at += 1;
      const inner = unary();
      return inner && { not: inner };
    }
    if (word === "(") {
      at += 1;
      const inner = either();
      if (!inner || test[at] !== ")") return null;
      at += 1;
      return { group: inner };
    }
    if (word === "-fprintf" && at + 2 < test.length) {
      at += 3;
      return { test: word };
    }
    if (/^-(?:exec|execdir|ok|okdir)$/.test(word)) {
      while (at < test.length && test[at] !== ";" && !(test[at] === "+" && test[at - 1] === "{}")) at += 1;
      const ended = at < test.length;
      at += 1;
      return ended ? { test: word } : null;
    }
    if (FIND_BARE.test(word)) {
      at += 1;
      return { test: word };
    }
    if (FIND_VALUED.test(word) && at + 1 < test.length) {
      at += 2;
      return { test: word, value: test[at - 1] };
    }
    return null;
  }
  function both() {
    const and = [];
    for (;;) {
      const term = unary();
      if (!term) return null;
      and.push(term);
      if (test[at] === "-a" || test[at] === "-and") at += 1;
      else if (at >= test.length || /^(?:\)|-o|-or)$/.test(test[at])) return { and };
    }
  }
  function either() {
    const or = [];
    for (;;) {
      const branch = both();
      if (!branch) return null;
      or.push(branch);
      if (test[at] !== "-o" && test[at] !== "-or") return { or };
      at += 1;
    }
  }
  if (!test.length) return { or: [{ and: [] }] };
  const tree = either();
  return tree && at === test.length ? tree : null;
}

// The names a node of findTree keeps, as `[{ pattern, folded }]`; null when it keeps files of any name, and
// false when Guard can't tell. A branch of tests that must all hold keeps the names of any `-name` among
// them, as the others (`-not -path`, `-prune`, `! -name`) can only narrow it. A group joined by `-o` keeps
// names only when each of its branches does.
function namesOfFind(node) {
  if (node.test) {
    if (!/^-i?name$/.test(node.test)) return null;
    return [{ pattern: node.value, folded: node.test === "-iname" }];
  }
  if (node.not) return null;
  if (node.group) {
    const names = namesOfFind(node.group);
    // A group joined by `-o` with a branch that keeps any name is left to the whole tree's answer.
    return node.group.or.length > 1 && !names ? false : names;
  }
  if (node.and) {
    const names = node.and.map(namesOfFind);
    if (names.includes(false)) return false;
    const kept = names.filter(Boolean);
    return kept.length ? kept.flat() : null;
  }
  const names = node.or.map(namesOfFind);
  if (names.includes(false)) return false;
  return names.every(Boolean) ? names.flat() : null;
}

// The names find hands on, from its test (see findTree), or null for files of any name. Before an `-exec`
// (`atExec`), only the last branch of a top-level `-o` reaches it. For a pipe, the branches that print do,
// or, with no test that prints or runs a command, every branch.
function findNamesKept(test, atExec) {
  const tree = findTree(test);
  if (!tree) return null;
  // A test that prints from inside a group or a `!` is past what Guard reads here.
  if (!atExec && tree.or.some((branch) => branch.and.some((term) => !term.test && actsWithin(term)))) return null;
  return namesOfFind({ or: branchesHandedOn(tree, atExec) }) || null;
}

// The branches of find's top-level `-o` whose names reach what follows (see findNamesKept).
function branchesHandedOn(tree, atExec) {
  if (atExec) return tree.or.slice(-1);
  const acts = (branch) => branch.and.some((term) => term.test && FIND_ACTS.test(term.test));
  return tree.or.some(acts) ? tree.or.filter(acts) : tree.or;
}

function actsWithin(node) {
  if (node.test) return FIND_ACTS.test(node.test);
  if (node.not || node.group) return actsWithin(node.not || node.group);
  return (node.and || node.or).some(actsWithin);
}

// The first secret file under the folders `find` reads from (see findReads), or a start it names that is one.
function secretInFindTargets(targets, cwd, shellGlobs) {
  for (const target of targets) {
    if (target.filters === EMPTY_FILTERS && secretOperandOpened(target.path, cwd, shellGlobs)) return target.path;
  }
  return secretInReaderTargets(targets, "find", cwd, shellGlobs);
}
// ---------- Recursive copies ----------

// The most of an rsync `--exclude-from` file read here.
const RSYNC_FROM_MAX = 64 * 1024;

// A recursive copy reads every file under the folders it copies. robocopy and xcopy are taken as reading the
// whole tree with or without their `/s` switch, which only a careful reading of each switch could tell apart;
// rsync and scp only with `-r` or rsync's `-a`. A source on another computer (`host:path`) isn't read here.
function secretInCopiedFolders(name, args, cwd, shellGlobs) {
  const values = args.filter((word) => !shellRedirection(word)).map((word) => word.value);
  const windows = name === "robocopy" || name === "xcopy";
  const { sources, include, exclude, recursive } = windows
    ? windowsCopyReads(name, values)
    : remoteCopyReads(name, values, cwd);
  for (const source of sources) {
    if (secretOperandOpened(source, cwd, shellGlobs)) return source;
  }
  if (!recursive) return null;
  const filters = include.length || exclude.length ? { include, exclude } : EMPTY_FILTERS;
  return secretInReaderTargets(
    sources.map((source) => ({ path: source, filters })),
    "cp",
    cwd,
    shellGlobs,
  );
}

// What robocopy or xcopy reads: its first operand, robocopy's file names after its destination as the files
// kept, and `/xf` and `/xd` names left out.
function windowsCopyReads(name, values) {
  const operands = [];
  const exclude = [];
  let excluding = null;
  for (const value of values) {
    if (isWindowsSwitch(value)) excluding = name === "robocopy" ? /^\/x[fd]$/i.exec(value)?.[0].toLowerCase() : null;
    else if (!excluding) operands.push(value);
    else if (/^[^\\/:]+$/.test(value)) exclude.push(...copyExclusion(value, excluding === "/xd" ? "folder" : "file"));
  }
  const include = name === "robocopy" ? operands.slice(2) : [];
  return { sources: operands.slice(0, 1), include, exclude, recursive: true };
}

function isWindowsSwitch(value) {
  return /^\/[A-Za-z]{1,10}(?::\S*)?$/.test(value);
}

// What rsync or scp reads: every operand but the last that's on this computer, walked with `-r` (rsync's
// `-a` too).
function remoteCopyReads(name, values, cwd) {
  const valued = name === "scp" ? /^-[cFiJlLoPSDX]$/ : /^(?:-[eBfT]|--(?:rsh|filter|exclude|include|files-from))$/;
  const operands = [];
  const options = [];
  for (let at = 0; at < values.length; at += 1) {
    if (!/^-./.test(values[at])) operands.push(values[at]);
    else if (valued.test(values[at])) at += 1;
    else options.push(values[at]);
  }
  const sources = operands.slice(0, -1).filter(isLocalCopyPath);
  const pattern = name === "scp" ? /^-[A-Za-z46]*r/ : /^-[A-Za-z]*[ra]|^--(?:recursive|archive)$/;
  const recursive = options.some((option) => pattern.test(option));
  const exclude = name === "rsync" ? rsyncExclusions(values, cwd) : [];
  return { sources, include: [], exclude, recursive };
}

// A copy's path that's on this computer: not `host:path`, though `C:\...` is.
function isLocalCopyPath(value) {
  return !/^[^/\\]*:/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

// The globs that leave out what a copy's exclusion names: a plain name or a simple glob, anywhere in the
// tree, as rsync and robocopy match one. A file's exclusion leaves out files only; rsync's also leaves out
// folders, and a trailing slash makes it folders only. One with a slash inside it, or starting with one,
// isn't applied.
function copyExclusion(value, kind) {
  const bare = kind === "both" && value.endsWith("/") ? value.slice(0, -1) : value;
  if (!bare || /[\\/]/.test(bare)) return [];
  const folder = `**/${bare}/**`;
  if (kind === "folder" || bare !== value) return [folder];
  return kind === "file" ? [`**/${bare}`] : [`**/${bare}`, folder];
}

// The exclusions an rsync command gives (see copyExclusion), from `--exclude` and from a small
// `--exclude-from` file that is there. With an `--include`, a `--filter` or a list of files, which can bring
// back what an exclusion left out, none is applied.
function rsyncExclusions(values, cwd) {
  const exclude = [];
  for (let at = 0; at < values.length; at += 1) {
    // `-f` gives a filter rule and `-F` reads filter files, alone or among other short options (`-aF`).
    if (/^-[A-Za-z0-9]*[fF]/.test(values[at])) return [];
    const option = /^(--[a-z-]+)(?:=([\s\S]*))?$/.exec(values[at]);
    if (!option) continue;
    const [, flag, glued] = option;
    if (/^--(?:include|include-from|filter|files-from)$/.test(flag)) return [];
    if (flag !== "--exclude" && flag !== "--exclude-from") continue;
    const value = glued ?? values[(at += 1)];
    if (value === undefined) continue;
    const lines = flag === "--exclude" ? [value] : linesOfSmallFile(path.resolve(cwd, value));
    for (const line of lines) {
      if (/^[+!]/.test(line)) return [];
      exclude.push(...copyExclusion(line.replace(/^- /, ""), "both"));
    }
  }
  return exclude;
}

// The rule lines of a small rsync list file, or none when it isn't there or is too big to read here.
function linesOfSmallFile(file) {
  try {
    if (fs.statSync(file).size > RSYNC_FROM_MAX) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !/^[#;]/.test(line));
  } catch {
    return [];
  }
}
// ---------- Environment dump check ----------

// The words of a command past its name that aren't redirections, so `env > e.txt` is `env` given nothing, and
// with any redirection written against them taken off.
function argumentsAfter(words, nameAt) {
  const kept = [];
  for (let at = nameAt + 1; at < words.length; at += 1) {
    const redirection = shellRedirection(words[at]);
    if (redirection === "word") at += 1;
    else if (!redirection) kept.push(beforeRedirection(words[at]));
  }
  return kept;
}

// A word with an output redirection written against it, as the shell reads it: `printenv>e.txt` is
// `printenv`, and `env:>e.txt` is `env:`. As in shellRedirection, the operator can't be quoted.
function beforeRedirection(word) {
  if (word.quoted || word.quotedAt === undefined) return word;
  const at = word.value.search(/&?>/);
  if (at <= 0 || (word.quotedAt !== -1 && word.quotedAt < at)) return word;
  return { ...word, value: word.value.slice(0, at) };
}

module.exports = {
  plainWord,
  xargsArgFile,
  namesFed,
  findReads,
  secretInFindTargets,
  secretInCopiedFolders,
  argumentsAfter,
  beforeRedirection,
};

"use strict";
/* global require, module */

const fs = require("fs");
const path = require("path");
const { lookupsSpent } = require("../check-budget.js");
const { withUnescapedGlobs } = require("../path-forms/glob-matching.js");

const EMPTY_FILTERS = Object.freeze({ include: Object.freeze([]), exclude: Object.freeze([]) });
// ---------- Option words ----------

// GNU grep's long options, so one shortened to a prefix of only one of them is read as grep reads it
// (`--rec`).
const GREP_LONG_OPTIONS = [
  "after-context",
  "basic-regexp",
  "before-context",
  "binary",
  "binary-files",
  "byte-offset",
  "color",
  "colour",
  "context",
  "count",
  "dereference-recursive",
  "devices",
  "directories",
  "exclude",
  "exclude-dir",
  "exclude-from",
  "extended-regexp",
  "file",
  "files-with-matches",
  "files-without-match",
  "fixed-strings",
  "group-separator",
  "help",
  "ignore-case",
  "include",
  "initial-tab",
  "invert-match",
  "label",
  "line-buffered",
  "line-number",
  "line-regexp",
  "max-count",
  "no-filename",
  "no-group-separator",
  "no-ignore-case",
  "no-messages",
  "null",
  "null-data",
  "only-matching",
  "perl-regexp",
  "quiet",
  "recursive",
  "regexp",
  "silent",
  "text",
  "unix-byte-offsets",
  "version",
  "with-filename",
  "word-regexp",
];

// Splits a reader's arguments into options and operands, the way getopt does: `-abc` is three flags until one
// that takes a value, which takes the rest of the word or the next word; `--name=value` or `--name value`;
// `--` ends options. With `longNames`, a reader's whole list of long options, a long option shortened to a
// prefix of only one of them (`--rec`, `--inc`) is read as that one, as getopt_long reads it.
function parseShellArgs(args, { shortValues = "", longValues = [], longNames = null } = {}) {
  const options = [];
  const operands = [];
  let onlyOperands = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = withoutEdgeQuotes(args[index]);
    if (onlyOperands || value === "-" || !value.startsWith("-")) {
      operands.push(value);
    } else if (value === "--") {
      onlyOperands = true;
    } else if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = fullOptionName(value.slice(2, equals < 0 ? undefined : equals), longNames);
      // A value quoted after the `=` (`--glob='.env*'`) is the value without its quotes.
      if (equals >= 0) options.push([name, withoutEdgeQuotes(value.slice(equals + 1))]);
      else if (longValues.includes(name) && index + 1 < args.length) {
        index += 1;
        options.push([name, withoutEdgeQuotes(args[index])]);
      } else options.push([name, true]);
    } else {
      index = readShortOptions(value, args, index, shortValues, options);
    }
  }
  function has(...names) {
    return options.some(([name]) => names.includes(name));
  }
  function values(...names) {
    const given = options.filter(([name, value]) => names.includes(name) && value !== true);
    return given.map((option) => option[1]);
  }
  return { options, operands, has, values };
}

// Reads one word of short options (`-abc`, `-e.env`) onto `options`, and gives the index of the last word
// read: one that takes a value takes the rest of the word, or else the next word.
function readShortOptions(value, args, index, shortValues, options) {
  for (let at = 1; at < value.length; at += 1) {
    if (!shortValues.includes(value[at])) {
      options.push([value[at], true]);
      continue;
    }
    const rest = withoutEdgeQuotes(value.slice(at + 1).replace(/^=/, ""));
    if (rest) options.push([value[at], rest]);
    else if (index + 1 < args.length) {
      options.push([value[at], withoutEdgeQuotes(args[index + 1])]);
      return index + 1;
    }
    break;
  }
  return index;
}

function withoutEdgeQuotes(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

// A long option's whole name, when `name` starts only one of `longNames`.
function fullOptionName(name, longNames) {
  if (!longNames || !name || longNames.includes(name)) return name;
  const matches = longNames.filter((candidate) => candidate.startsWith(name));
  return matches.length === 1 ? matches[0] : name;
}

// How grep's arguments are read: the options that take a value.
const GREP_PARSE = {
  shortValues: "efmABCdD",
  longValues: [
    "regexp",
    "file",
    "max-count",
    "after-context",
    "before-context",
    "context",
    "directories",
    "devices",
    "include",
    "exclude",
    "exclude-dir",
    "exclude-from",
    "label",
    "binary-files",
    "group-separator",
  ],
  // GNU grep takes any unambiguous start of a long option (`--rec`, `--inc=.env`).
  longNames: GREP_LONG_OPTIONS,
};
// ---------- Recursive read targets ----------

// How rg's arguments are read: the options that take a value.
const RG_PARSE = {
  shortValues: "efgtTmABCdjMrE",
  longValues: [
    "regexp",
    "file",
    "glob",
    "iglob",
    "type",
    "type-not",
    "max-count",
    "after-context",
    "before-context",
    "context",
    "max-depth",
    "maxdepth",
    "threads",
    "max-columns",
    "replace",
    "encoding",
    "pre",
    "pre-glob",
    "sort",
    "sortr",
    "color",
    "colors",
    "type-add",
    "type-clear",
    "ignore-file",
    "max-filesize",
    "path-separator",
    "context-separator",
    "engine",
    "dfa-size-limit",
    "regex-size-limit",
    "field-context-separator",
    "field-match-separator",
    "hyperlink-format",
    "hostname-bin",
  ],
};
// rg's flags that turn off some or all of its ignore files.
const RG_NO_IGNORE = [
  "no-ignore",
  "no-ignore-vcs",
  "no-ignore-dot",
  "no-ignore-parent",
  "no-ignore-files",
  "no-ignore-global",
  "no-ignore-exclude",
];
// How diff's arguments are read: the options that take a value.
const DIFF_PARSE = {
  shortValues: "xXISFLCUWD",
  longValues: [
    "exclude",
    "exclude-from",
    "ignore-matching-lines",
    "starting-file",
    "show-function-line",
    "label",
    "context",
    "unified",
    "width",
    "ifdef",
    "from-file",
    "to-file",
  ],
};
const CP_PARSE = { shortValues: "tS", longValues: ["target-directory", "suffix"] };

// Whether a command's input redirected from this path is a file to ripgrep, which reads its input in place of
// the working folder only when that's a file or a pipe. Only a path Guard finds a file, FIFO or socket at is
// one: not a device however it's written (`/dev/null`, `/usr/../dev/null`, `NUL`, `NUL:`, `CON`), a folder, a
// path the shell rewrites first (a variable, a glob, `~`), one Guard can't look up in time, or one with
// nothing at it yet, which an earlier command may make a folder (`mkdir d; rg x < d`). An empty name is an
// input copied from another stream or closed (`<&3`, `<&-`).
function stdinIsFile(from, cwd, budget) {
  if (!from || /[$`\u2026*?[\]{}~]/.test(from)) return false;
  if (/^\/(?:dev|proc)(?:\/|$)/i.test(path.posix.normalize(from.replace(/\\/g, "/")))) return false;
  if (/(?:^|[\\/])(?:nul|con|aux|prn|com\d|lpt\d|conin|conout)(?:\.[^\\/]*)?:?$/i.test(from)) return false;
  if (!budget || lookupsSpent(budget)) return false;
  budget.lookups -= 1;
  let stats;
  // Joined, not resolved: `..` after a link to a folder goes up from where the link points, as the shell
  // opens it.
  const target = path.isAbsolute(from) ? from : `${path.resolve(cwd)}${path.sep}${from}`;
  try {
    stats = fs.statSync(target, { throwIfNoEntry: false });
  } catch {
    return false;
  }
  return stats !== undefined && (stats.isFile() || stats.isFIFO() || stats.isSocket());
}

// The folders a recursive reader reads every file under, each with the reader's own filters. `glob` is what a
// target is judged by when its folders can't all be walked: the broad glob it came from, by the secret names
// it could match. grep's --exclude-dir leaves no folder out of the walk: each shell splits, joins, expands
// and redirects grep's words its own way, so the word Guard reads as --exclude-dir may reach grep as
// something else, or not at all. `lastIsSource` says whether cp's last word is copied too (see copySources).
// `stdin`: the reader's input is redirected from a file or text, so rg given no folder reads that, not the
// working folder (see stdinIsFile). `pattern`: the words are the shell's own, so grep or rg given none, with
// no `-e` or `-f` either, only prints its usage (`grep -rn #TODO`, a comment after `grep -rn`). `searched`,
// if given, has `pattern` set to the word rg or findstr searches for, when one of its words is that (see
// searchPatternAt).
function recursiveReadTargets(
  reader,
  args,
  lastIsSource = () => true,
  { stdin = false, pattern = false, searched = null } = {},
) {
  const name = reader.toLowerCase();
  if (name === "grep") return grepReadTargets(args, pattern);
  if (name === "rg") return rgReadTargets(args, { stdin, pattern, searched });
  if (name === "findstr") return findstrReadTargets(args, searched);
  if (name === "diff") return diffReadTargets(args);
  if (name === "cp") return cpReadTargets(args, lastIsSource);
  return [];
}

function grepReadTargets(args, pattern) {
  const parsed = parseShellArgs(args, GREP_PARSE);
  // grep takes a value shortened to a prefix of only one it knows (`-d rec`; `re` could be `read`).
  const recursive =
    parsed.has("r", "R", "recursive", "dereference-recursive") ||
    parsed.values("d", "directories").some((value) => value.length >= 3 && "recurse".startsWith(value));
  if (!recursive) return [];
  const filters = { include: withUnescapedGlobs(parsed.values("include")), exclude: parsed.values("exclude") };
  const given = parsed.has("e", "regexp", "f", "file");
  if (pattern && !given && !parsed.operands.length) return [];
  const operands = given ? parsed.operands : parsed.operands.slice(1);
  // With only a pattern, `grep -r` reads the working folder.
  return (operands.length ? operands : ["."]).map((operand) => ({ path: operand, filters }));
}

function rgReadTargets(args, { stdin, pattern, searched }) {
  const parsed = parseShellArgs(args, RG_PARSE);
  // `--files` lists names without reading them; a depth of 0, the last one given, reads only the files
  // named.
  const depths = parsed.values("d", "max-depth", "maxdepth");
  if (parsed.has("files", "type-list") || /^0+$/.test(depths[depths.length - 1] || "")) return [];
  const filters = rgFilters(parsed);
  // `-u` and `--unrestricted` count alike, each time given; any no-ignore flag, even one that turns off
  // only some of the ignore files, is taken as turning them all off.
  const unrestricted = parsed.options.filter(([option]) => option === "u" || option === "unrestricted").length;
  const reachability = {
    globbed: filters.include.length > 0,
    hidden: parsed.has("hidden", ".") || unrestricted >= 2,
    noIgnore: parsed.has(...RG_NO_IGNORE) || unrestricted >= 1,
  };
  const given = parsed.has("e", "regexp", "f", "file");
  if (searched && !given) searched.pattern = parsed.operands[0];
  if (pattern && !given && !parsed.operands.length) return [];
  const operands = given ? parsed.operands : parsed.operands.slice(1);
  // With no folder, rg reads its input when that's a pipe or redirected from a file or text (`stdin`),
  // unless `-f -` takes that input for the patterns; the working folder otherwise.
  if (!operands.length && stdin && !parsed.values("f", "file").includes("-")) return [];
  return (operands.length ? operands : ["."]).map((operand) => ({ path: operand, filters, reachability }));
}

// rg's globs, `!` ones excluding, and the globs of the file types it's told to search.
function rgFilters(parsed) {
  const filters = { include: [], exclude: [] };
  for (const glob of parsed.values("g", "glob", "iglob")) {
    if (glob.startsWith("!")) filters.exclude.push(glob.slice(1));
    else filters.include.push(glob);
  }
  // A file type the command adds globs to (`--type-add 'k:id_*' -tk`) searches the files they match, so on
  // a folder judged by name they count like its own filters. They don't narrow a walk: the type may be one
  // of rg's own, with more globs than the command shows.
  const types = parsed.values("t", "type");
  filters.typeGlobs = parsed
    .values("type-add")
    .map((definition) => [definition.slice(0, definition.indexOf(":")), definition.slice(definition.indexOf(":") + 1)])
    .filter(([type, glob]) => type && types.includes(type) && !/^include:/.test(glob))
    .map(([, glob]) => glob);
  filters.include = withUnescapedGlobs(filters.include);
  filters.typeGlobs = withUnescapedGlobs(filters.typeGlobs);
  return filters;
}

// findstr's switches start with `/` (or `-`): flags can share one switch (`/si`), and `/c:`, `/g:`, `/f:`,
// `/d:` and `/a:` carry a value. Switches can also be joined (`/s/i`, `/s/c:text`), a value switch last,
// taking the rest. A doubled `/` is passed over (`//i` is `/i`: findstr ignores the `//`, and Git Bash hands
// it `/i`). With /s each file name, wildcards and all, is looked for in every folder below.
function findstrReadTargets(args, searched) {
  const flags = [];
  const values = {};
  const operands = [];
  for (const arg of args) {
    const value = arg.replace(/^['"]|['"]$/g, "");
    const found = findstrSwitches(value);
    if (found) {
      flags.push(...found.flags);
      for (const [switchName, given] of found.values) values[switchName] = given;
    } else operands.push(value);
  }
  if (searched && values.c === undefined && values.g === undefined) searched.pattern = operands[0];
  if (!flags.some((flag) => flag !== "offline" && flag.includes("s"))) return [];
  const files = values.c !== undefined || values.g !== undefined ? operands : operands.slice(1);
  // findstr reads `/d:"C:\proj"` as its own arguments are read, without the quotes, in each folder of a
  // list too.
  const folders = values.d ? values.d.replace(/"/g, "").split(/[;,]/).filter(Boolean) : null;
  return files.flatMap((file) => {
    const spec = file.replace(/\\/g, "/");
    const slash = spec.lastIndexOf("/");
    const fileName = spec.slice(slash + 1);
    const filters = { include: [fileName], exclude: [] };
    const glob = /[*?]/.test(fileName) ? file : null;
    const roots = folders || [slash < 0 ? "." : spec.slice(0, slash) || "/"];
    return roots.map((folder) => ({ path: folder, filters, glob, literal: true }));
  });
}

// A word of findstr switches, its flags and its values; null when the word is no switches through to its end.
function findstrSwitches(value) {
  const found = { flags: [], values: [] };
  const switchAt = /[/-]\/*(?:([cgfda]):([^]*)|(offline|[belrsixvnmop]+)(?=\/|$))/iy;
  let at = 0;
  while (at < value.length) {
    switchAt.lastIndex = at;
    const option = switchAt.exec(value);
    if (!option) break;
    if (option[1]) found.values.push([option[1].toLowerCase(), option[2]]);
    else found.flags.push(option[3].toLowerCase());
    at = switchAt.lastIndex;
  }
  return at === value.length && value ? found : null;
}

function diffReadTargets(args) {
  const parsed = parseShellArgs(args, DIFF_PARSE);
  if (!parsed.has("r", "recursive")) return [];
  const filters = { include: [], exclude: parsed.values("x", "exclude") };
  const operands = [...parsed.operands, ...parsed.values("from-file", "to-file")];
  return operands.map((operand) => ({ path: operand, filters }));
}

function cpReadTargets(args, lastIsSource) {
  const parsed = parseShellArgs(args, CP_PARSE);
  if (!parsed.has("r", "R", "a", "recursive", "archive")) return [];
  return copySources(parsed, lastIsSource).map((operand) => ({ path: operand, filters: EMPTY_FILTERS }));
}

// What a copy reads: every operand but the last, the destination, unless -t names the destination instead.
// For cp, `lastIsSource(last)` says the last word is read too (see copyLastIsSource). cmd's copy, given
// false, reads a wildcard there as a pattern for the new names.
function copySources(parsed, lastIsSource = false) {
  if (parsed.has("t", "target-directory") || parsed.operands.length < 2) return parsed.operands;
  const last = parsed.operands[parsed.operands.length - 1];
  return lastIsSource && lastIsSource(last) ? parsed.operands : parsed.operands.slice(0, -1);
}

module.exports = {
  EMPTY_FILTERS,
  GREP_LONG_OPTIONS,
  parseShellArgs,
  GREP_PARSE,
  stdinIsFile,
  recursiveReadTargets,
  copySources,
};

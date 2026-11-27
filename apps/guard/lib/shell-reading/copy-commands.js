"use strict";
/* global require, module */

const { isSecretFile } = require("../secret-files.js");

// ---------- Copies ----------

// The first secret file a reader given these words reads, or null. `recursive` off leaves out the folders a
// search reads under, for words that may be cut short. `command` is the parsed command the words are from, if
// any: its input redirections say whether rg reads its input in place of the working folder, when
// `inputKnown`: nothing run before it could change what that input names (see secretInCommand). `work` is the
// parse's, marked `deep` when the words hold a PowerShell group nested too deep for all its words to be kept
// (see closeCode). Copy-Item's parameters, and the common ones every PowerShell command takes, by their full
// names and aliases: those that take no value, and the ones whose value is a path it copies or one it writes.
const COPY_ITEM_SWITCHES = [
  "container",
  "force",
  "recurse",
  "passthru",
  "whatif",
  "wi",
  "confirm",
  "cf",
  "verbose",
  "vb",
  "debug",
  "db",
  "usetransaction",
  "usetx",
];
const COPY_ITEM_VALUES = [
  "path",
  "literalpath",
  "pspath",
  "lp",
  "destination",
  "filter",
  "include",
  "exclude",
  "credential",
  "fromsession",
  "tosession",
  "erroraction",
  "ea",
  "warningaction",
  "wa",
  "informationaction",
  "infa",
  "progressaction",
  "proga",
  "errorvariable",
  "ev",
  "warningvariable",
  "wv",
  "informationvariable",
  "iv",
  "outvariable",
  "ov",
  "outbuffer",
  "ob",
  "pipelinevariable",
  "pv",
];
const COPY_ITEM_SOURCES = new Set(["path", "literalpath", "pspath", "lp"]);

// What PowerShell's Copy-Item (`cp`, `copy`) copies, given its words: `-Path` and `-LiteralPath` values and
// the arguments given by place, but the destination: `-Destination`'s value, or else the first argument by
// place when the paths are named, or the last one when they aren't. An argument is a word, or a list of them
// (`a, b`, or a group's values, see withGroupValues). A parameter is named by its name, an alias or a prefix
// of one name only, with its value after it or a colon; one Guard doesn't know is taken as a switch, so the
// argument after it counts as given by place. So is one written as cp's short options would be (`-pv`,
// `-iv`): in Cursor's terminal, a Bash `cp -pv a b` read as PowerShell's. `recurse`: -Recurse is given.
// `full`: Copy-Item written in full, which is never Bash's cp, so no parameter is taken as cp's options.
// There a splat (`@p`) isn't an argument by place: it names parameters, so PowerShell binds the others the
// same way or refuses to run, and those it names are known from `splat` (see splatLiteral). `unsure`: written
// in full, the words hold one this reading can't account for, so the copy is read as Guard first read it.
// That's a word written as a parameter that doesn't plainly name one Copy-Item takes (PowerShell ends a name
// at `.`, `[` or `(`, so `-Destination.x .env` copies .env, and takes `–`, `—` or `―` for `-`), a splat the
// command doesn't set just before, or -Filter or -Include on paths that aren't plain words, as from a
// variable, a group or the pipe, since the filter then picks files from folders Guard can't name.
function copyItemArgs(words, { full = false, splat = null } = {}) {
  const UNSURE = { sources: [], recurse: false, unsure: true };
  const args = copyItemArgGroups(words);
  const named = (arg) => copyItemParameter(arg, full);
  // Each source's word, a colon's value standing in for its parameter's (`-Path:a`).
  const sources = [];
  const placed = [];
  let destination = false;
  let recurse = false;
  let filtered = false;
  // Whether a splat names the paths it copies.
  let splatSource = false;
  for (let index = 0; index < args.length; index += 1) {
    const head = args[index][0];
    const parameter = named(args[index]);
    const splatted = full && args[index].length === 1 && !head.quoted && /^@(\w+)$/.exec(head.value);
    if (splatted) {
      // A key that names no one parameter Copy-Item takes stops it or can't be read, as can a splat set
      // elsewhere.
      if (!splat || splat.name !== splatted[1].toLowerCase()) return UNSURE;
      const keys = splat.keys.map(copyItemParameterName);
      if (keys.includes(null)) return UNSURE;
      splatSource = keys.some((name) => COPY_ITEM_SOURCES.has(name)) || splatSource;
      destination = keys.includes("destination") || destination;
      recurse = keys.includes("recurse") || recurse;
      filtered = keys.includes("filter") || keys.includes("include") || filtered;
      continue;
    }
    const writtenAsParameter = full && !head.quoted && /^[-\u2013-\u2015@]/.test(head.value);
    if (writtenAsParameter && !plainlyNamed(args[index], full)) return UNSURE;
    if (!parameter) {
      placed.push(args[index]);
      continue;
    }
    const { name } = parameter;
    if (name === "recurse") recurse = true;
    if (name === "filter" || name === "include") filtered = true;
    if (!name || COPY_ITEM_SWITCHES.includes(name)) continue;
    let value = [];
    // PowerShell takes the next argument for a value left empty after the colon: `-Path: a`.
    const emptied = full && parameter.value === "" && args[index].length === 1;
    if (parameter.value !== undefined && !emptied) {
      value = [{ ...head, value: parameter.value }, ...args[index].slice(1)];
    } else if (index + 1 < args.length) {
      index += 1;
      value = args[index];
    }
    if (COPY_ITEM_SOURCES.has(name)) sources.push(...value);
    else if (name === "destination") destination = true;
  }
  // With the paths named, the first argument by place is the destination.
  if (destination) sources.push(...placed.flat());
  else if (sources.length || splatSource) sources.push(...placed.slice(1).flat());
  else sources.push(...(placed.length < 2 ? placed : placed.slice(0, -1)).flat());
  if (full && filtered && (splatSource || !sources.length || !sources.every(isLiteralPath))) return UNSURE;
  return { sources: sources.map((word) => word.value), recurse };
}

// Copy-Item's arguments: each a word, or a list of them. The next word goes on the argument before it past a
// comma, and after a group's values too (`("a"), b`).
function copyItemArgGroups(words) {
  const args = [];
  let joined = false;
  for (const word of words) {
    if (args.length && (joined || word.depth)) args[args.length - 1].push(word);
    else args.push([word]);
    if (!word.depth) joined = Boolean(word.listed);
  }
  return args;
}

// The one Copy-Item parameter a name or prefix names, or null.
function copyItemParameterName(given) {
  const known = [...COPY_ITEM_SWITCHES, ...COPY_ITEM_VALUES];
  const exact = known.find((name) => name === given);
  const prefixed = known.filter((name) => name.startsWith(given));
  return exact || (prefixed.length === 1 ? prefixed[0] : null);
}

// The parameter an argument is written as, `{ name, value }`, or null. Not `full`, a value parameter written
// as cp's short options is no name.
function copyItemParameter(arg, full) {
  const match = !arg[0].quoted && /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(arg[0].value);
  // A list's first word is a parameter only with its value after a colon: `-Path:a, b`.
  if (!match || (arg.length > 1 && match[2] === undefined)) return null;
  const name = copyItemParameterName(match[1].toLowerCase());
  const cpLetters = [...match[1]].every((letter) => CP_SHORT_OPTIONS.includes(letter));
  if (!full && name && COPY_ITEM_VALUES.includes(name) && cpLetters) return { name: null };
  return { name, value: match[2] };
}

// Whether a word written as a parameter plainly names one Copy-Item takes, with no quote or escape in its
// name.
function plainlyNamed(arg, full) {
  const parameter = copyItemParameter(arg, full);
  const nameEnd = /^-[A-Za-z]+/.exec(arg[0].value)?.[0].length;
  return Boolean(parameter?.name) && !(arg[0].quotedAt >= 0 && arg[0].quotedAt <= nameEnd);
}

// A path given as it's written, with no variable, expression, group or escape in it.
function isLiteralPath(word) {
  return !word.depth && !word.deep && !/[$@`(){}\u2026]/.test(word.value);
}

// One of a hashtable's lines: a key, bare or quoted, and a plain value (quoted text with no variable in it, a
// number, $true, $false or $null).
const SPLAT_PAIR =
  /^\s*(?:(\w+)|'(\w+)'|"(\w+)")\s*=\s*(?:'[^'\r\n‘-‛]*'|"[^"$`\r\n“-„]*"|\$(?:true|false|null)|\d+)\s*$/i;

// The keys of the hashtable a command writes into a variable it then splats into Copy-Item (see
// copyItemArgs), as { name, keys } with the variable's name, or null. Only for a command that's that one
// assignment and then Copy-Item with plain words, so nothing in between can change the variable and no quote
// or group can hide another command.
function splatLiteral(command) {
  const match = /^\s*\$(\w+)\s*=\s*@\{([^{}]*)\}[^\S\r\n]*(?:;|\r?\n)\s*Copy-Item[^\S\r\n]+[\w.\\/:@ \t-]*$/i.exec(
    command,
  );
  if (!match) return null;
  const keys = [];
  // A `;` inside a quoted value splits it into lines that aren't pairs, so that hashtable isn't read.
  for (const line of match[2].split(/;|\r?\n/)) {
    if (!line.trim()) continue;
    const pair = SPLAT_PAIR.exec(line);
    if (!pair) return null;
    keys.push((pair[1] || pair[2] || pair[3]).toLowerCase());
  }
  return { name: match[1].toLowerCase(), keys };
}

// Whether a command may make Copy-Item, copy, cp or cpi another command before running it, which Copy-Item's
// own reading (see copyItemArgs) and a copy no shell runs (see copyCannotRun) can't account for: a function,
// filter or alias, PowerShell's or Bash's, or code Guard can't read run in the shell's own scope
// (dot-sourcing, Invoke-Expression, eval, a module, a command named by an expression). Blank space after a
// line break is spaces and tabs only, so a long run of line breaks costs one pass.
const COPY_REDEFINED = new RegExp(
  [
    String.raw`function|alias|executioncontext|scriptblock|invoke-expression|import-module|new-module|import-pssession`,
    String.raw`(?:^|[^\w$-])(?:filter|workflow)\s`,
    String.raw`\b(?:Copy-Item|copy|cp|cpi)[^\S\r\n]*\([^\S\r\n]*\)`,
    String.raw`(?:^|[;&|{(\r\n\u2028\u2029])[^\S\r\n]*` +
      String.raw`(?:(?:source|eval|iex|sal|nal|ipal|ipmo|nmo|ipsn|using)\b|\.\s|[.&][^\S\r\n]*[{($'"])`,
  ].join("|"),
  "i",
);

// Bash's time, with its -p or --.
const BASH_TIME = String.raw`time(?:[^\S\r\n]+-p)?(?:[^\S\r\n]+--)?`;

// Bash's words that a command can follow: then, do, else, if, elif, while, until, time, and `!` with a space
// after it (`!hash` is a command of that name).
const BASH_KEYWORD = String.raw`\b(?:then|do|else|if|elif|while|until|` + BASH_TIME + String.raw`)\s|!\s`;

// Where a command can start: the text's start, after a separator or group, after a quote (code run from a
// string, as in `iex 'sal copy gc'`), or after one of Bash's keywords.
const COMMAND_START = String.raw`(?:^|[;&|{(\r\n\u2028\u2029'"]|` + BASH_KEYWORD + String.raw`)[^\S\r\n]*`;

// Bash's builtin and command, which still run its own hash or alias: `builtin hash -p`, `command -p alias`,
// `builtin -- alias`, or one inside the other. command's -v and -V only describe the word after them.
const BUILTIN_RUNNER = String.raw`(?:builtin|command(?:[^\S\r\n]+-p+)*)(?:[^\S\r\n]+--)?[^\S\r\n]+`;

// Where one of Bash's own rename words can start. A backslash before a word only stops an alias of it, so
// `\alias` and `\builtin hash -p` rename too.
const BASH_COMMAND_START = COMMAND_START + String.raw`(?:\\?` + BUILTIN_RUNNER + String.raw`)*\\?`;

// Bash's `hash -p <path> <name>`, which runs that program for the name. Its -p may come after other options,
// on its own or in a group (`hash -l -p`, `hash -lp`), and may hold the path (`-p/usr/bin/cat`). Plain
// `hash`, `hash -r` and `hash -d` point nothing anywhere new.
const HASH_PATH = String.raw`hash(?:[^\S\r\n]+-[a-z]+)*[^\S\r\n]+-[a-z]*p`;

// Whether a command may define a function or alias that a copy then runs as: a function, filter or workflow,
// PowerShell's or Bash's, whatever its name, Bash's `cp()`, PowerShell's function and alias drives
// (`Set-Item function:copy`), an alias command, or Bash's hash -p, on their own or through builtin, command
// or a backslash. Such a copy can print any file it's given, its last word too. Narrower than
// COPY_REDEFINED, since it decides whether every copy's destination is read: a word like functions or source
// near a copy (`cd functions && cp .env.example .env`) doesn't make one here.
const COPY_RENAMED = new RegExp(
  [
    COMMAND_START + String.raw`(?:function|filter|workflow)\s`,
    String.raw`\b(?:Copy-Item|copy|cp|cpi)[^\S\r\n]*\([^\S\r\n]*\)`,
    String.raw`\b(?:function|alias):`,
    String.raw`\b(?:Set|New|Import)-Alias\b`,
    COMMAND_START + String.raw`(?:sal|nal|ipal)\s`,
    BASH_COMMAND_START + String.raw`alias\s`,
    BASH_COMMAND_START + HASH_PATH,
  ].join("|"),
  "i",
);

// Whether this reader is a copy the command may rename first (see COPY_RENAMED). A caller that doesn't say
// gets yes.
function copyMayBeRenamed(reader, shellGlobs) {
  if (!/^(?:cp|copy)$/i.test(reader)) return false;
  return shellGlobs?.copyRenamed !== false;
}

// The short options GNU's, BSD's or uutils' cp knows; `t` and `S` take a value, the rest of the word or the
// next word.
const CP_SHORT_OPTIONS = "abcdfgiHlLnPpRrsSTtuvxXZ";
// GNU cp's long options that must have a value, given after `=` or as the next word, as a prefix may name
// them.
const CP_LONG_VALUES = ["--no-preserve", "--sparse", "--suffix", "--target-directory"];

// Whether cp, given these words with their quotes taken off, stops at a short option it doesn't know, before
// `--`.
function cpRefuses(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    // `--suffix -old`: the word after is the option's value.
    if (arg.length > 2 && !arg.includes("=") && CP_LONG_VALUES.some((option) => option.startsWith(arg))) {
      index += 1;
      continue;
    }
    // A word with a substitution or variable in it could be any option.
    if (!/^-[^-]/.test(arg) || /[…$`]/.test(arg)) continue;
    for (let letterAt = 1; letterAt < arg.length; letterAt += 1) {
      if (!CP_SHORT_OPTIONS.includes(arg[letterAt])) return true;
      if (arg[letterAt] === "t" || arg[letterAt] === "S") {
        if (letterAt === arg.length - 1) index += 1;
        break;
      }
    }
  }
  return false;
}

// Whether cmd's copy and PowerShell's Copy-Item (`copy`) refuse these words ({ value, quoted }) and copy
// nothing: more than two, each of plain letters, digits, `_`, `.`, `-` and `\`, with no leading `-` (a
// parameter), no `/` (a switch), `+` (a join), list, quote, variable or glob, and no `\` ending one. Prose
// starting with Copy reads so, as in a here-string's `Copy .env.example to .env for local work.`
function copyCannotRun(words) {
  return words.length > 2 && words.every(isPlainCopyWord);
}

function isPlainCopyWord(word) {
  if (word.quoted || word.partQuoted || word.depth || word.listed) return false;
  return /^[\w.][\w.\\-]*$/.test(word.value) && !word.value.endsWith("\\");
}

// ---------- Example env file copies ----------

// Parameters of Copy-Item and switches of cmd's copy that change nothing a copy reads.
const TEMPLATE_COPY_SWITCHES = new Set(["-force", "-verbose", "/y", "/-y", "/v"]);

// The file a copy reads when its source is an example env file (`Copy-Item .env.example .env`), or null. The
// destination can be any name. Only for PowerShell's and cmd's copies, from the words ({ value, quoted }) on
// the copy's own line: a second line is its own command, and outside cmd a word starting with `#` starts a
// comment. The words left must be plain: a switch above, -Path or -LiteralPath and -Destination with a value,
// and paths, one source and one destination. cmd's copy refuses more than two paths (see copyCannotRun), so
// there a literal `&` (`^&`) and the words past it copy nothing. The source's name must start with `.env.`
// and isSecretFile must pass it. Anything else is null and read as before.
function templateCopySource(lineWords, cmd) {
  const words = wordsBeforeComment(lineWords, cmd);
  const named = { source: [], destination: [] };
  const places = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const lower = word.value.toLowerCase();
    const parameter = /^-(?:path|literalpath|destination)$/.test(lower) && !cmd ? lower : null;
    if (isPlainCopyArgument(word) && TEMPLATE_COPY_SWITCHES.has(lower)) continue;
    if (parameter && index + 1 < words.length && isPlainCopyPath(words[index + 1])) {
      named[parameter === "-destination" ? "destination" : "source"].push(words[index + 1].value);
      index += 1;
      continue;
    }
    if (!isPlainCopyPath(word) && !isCmdJoinAfterPaths(word, cmd, places)) return null;
    places.push(word.value);
  }
  const given = named.source.length + named.destination.length + places.length;
  const extra = cmd && !named.source.length && !named.destination.length ? places.length > 2 : false;
  if (given !== 2 && !extra) return null;
  if (named.source.length > 1 || named.destination.length > 1) return null;
  const source = named.source[0] || places[0];
  const name = source.replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (!name.startsWith(".env.")) return null;
  return isSecretFile(source) ? null : source;
}

// The words up to a comment: outside cmd, an unquoted word starting with `#` starts one.
function wordsBeforeComment(lineWords, cmd) {
  const words = [];
  for (const word of lineWords) {
    if (!cmd && !word.quoted && word.value.startsWith("#")) break;
    words.push(word);
  }
  return words;
}

// A word with no quote, group, list or deep nesting in it, and no `\` ending it.
function isPlainCopyArgument(word) {
  if (word.quoted || word.partQuoted || word.depth || word.listed || word.deep) return false;
  return !word.value.endsWith("\\");
}

// A plain word of letters, digits, `_`, `.`, `\` and `-`, not starting with `-`.
function isPlainCopyPath(word) {
  return isPlainCopyArgument(word) && /^[\w.\\][\w.\\-]*$/.test(word.value);
}

// cmd's literal `&` (`^&`) after the two paths, which cmd's copy takes as one more path and refuses.
function isCmdJoinAfterPaths(word, cmd, places) {
  return cmd && places.length >= 2 && !word.depth && word.value === "&";
}

module.exports = {
  COPY_ITEM_SWITCHES,
  COPY_ITEM_VALUES,
  COPY_ITEM_SOURCES,
  copyItemArgs,
  SPLAT_PAIR,
  splatLiteral,
  COPY_REDEFINED,
  COPY_RENAMED,
  copyMayBeRenamed,
  CP_SHORT_OPTIONS,
  CP_LONG_VALUES,
  cpRefuses,
  copyCannotRun,
  templateCopySource,
};

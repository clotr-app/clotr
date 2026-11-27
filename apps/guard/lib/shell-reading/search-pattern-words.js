"use strict";
/* global require, module */

const fs = require("fs");
const path = require("path");
const { lookupsSpent } = require("../check-budget.js");
const { remoteLocation } = require("../path-forms/windows-paths.js");
const { recursiveReadTargets } = require("./recursive-read-targets.js");

// ---------- Search-tool words ----------

// What comes before a command's own name (`sudo grep ...`, `if grep ...`), and the search tools whose pattern
// is text.
const COMMAND_PREFIX = /^(?:[A-Za-z_]\w*=.*|sudo|command|exec|env|time|nohup|if|then|do|else|elif|while|until|!|\{)$/;

const SEARCH_TOOL = /^(?:.*[/\\])?(?:([ef]?grep)|rg)(?:\.exe)?$/i;

const SELECT_STRING = /^(?:(?:Microsoft\.PowerShell\.Utility\\)?select-string|sls)$/i;

const FINDSTR = /^(?:.*[/\\])?findstr(?:\.exe)?$/i;

// cmd started to run a command: `cmd /c findstr ...`, with its other switches before `/c` or `/k`.
const CMD_NAME = /^(?:.*[/\\])?cmd(?:\.exe)?$/i;

// A PowerShell variable a command's result is stored in: `$hits = sls ...` or `$hits += sls ...`.
const PS_ASSIGNED = /^\$[A-Za-z_]\w*(?::[A-Za-z_]\w*)?$/;

const PS_ASSIGN = /^(?:[-+*/%]|\?\?)?=$/;

// Select-String's patterns in `( )` or `@( )`: quoted words joined by commas.
const QUOTED_LIST = /^(?:,|"[^"]*"|'[^']*')+$/;

// Select-String's parameters that take the next word as their value, its own and PowerShell's common ones
// with their aliases. PowerShell takes any unique start of a name.
const SELECT_STRING_VALUES = [
  "pattern",
  "path",
  "literalpath",
  "pspath",
  "lp",
  "encoding",
  "context",
  "include",
  "exclude",
  "culture",
  "inputobject",
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

// A `--name` option among `names`, as a whole word.
function longOptionPattern(names) {
  return new RegExp(`^--(?:${names.join("|")})$`);
}

// Each tool's options that take the next word as their value: `-e`'s value is a pattern, the others' are not.
const SEARCH_VALUE_OPTIONS = {
  grep: {
    short: "ABCDdefm",
    long: longOptionPattern([
      "regexp",
      "file",
      "after-context",
      "before-context",
      "context",
      "max-count",
      "include",
      "exclude",
      "exclude-dir",
      "exclude-from",
      "directories",
      "devices",
      "label",
      "binary-files",
    ]),
  },
  rg: {
    short: "ABCEdefgjMmrTt",
    long: longOptionPattern([
      "regexp",
      "file",
      "after-context",
      "before-context",
      "context",
      "max-count",
      "max-depth",
      "glob",
      "iglob",
      "type",
      "type-not",
      "type-add",
      "replace",
      "encoding",
      "threads",
      "max-columns",
      "max-filesize",
      "pre",
      "pre-glob",
      "sort",
      "sortr",
      "ignore-file",
      "engine",
    ]),
  },
};

// Tells, word by word, which words of a command line are a search pattern: for `grep` or `rg` the first word
// that isn't an option, or the value of `-e` or `--regexp`, and for `Select-String` and `findstr` as their
// own rules say. The tool is found past `cmd /c` and, where PowerShell may run the command, past `$name =` or
// `+=`. `word` takes a word as written and the character that ends it, and `open` and `close` are told of
// each `(` and `)`.
function searchPatternWords(kind) {
  const search = {
    kind,
    groups: [],
    tool: null,
    value: null,
    redirect: false,
    given: false,
    optionsEnded: false,
    lead: null,
    group: null,
  };
  return {
    word: (raw, next) => searchPatternWord(search, raw, next),
    reset: () => resetSearchPattern(search),
    open: () => openSearchPatternGroup(search),
    close: () => closeSearchPatternGroup(search),
    redirect: () => (search.redirect = true),
  };
}

function resetSearchPattern(search) {
  search.tool = null;
  search.value = null;
  search.lead = null;
  search.group = null;
  search.redirect = false;
  search.given = false;
  search.optionsEnded = false;
}

// The words before the tool's name: `$name =` and `cmd` with its switches up to `/c` or `/k`.
function searchPatternLeading(search, text) {
  if (search.lead === "assign") {
    search.lead = null;
    if (!PS_ASSIGN.test(text)) search.tool = "";
    return;
  }
  if (search.lead === "cmd") {
    if (/^\/+[ckr]$/i.test(text)) search.lead = null;
    else if (!/^\/[a-z](?::\S*)?$/i.test(text)) {
      search.tool = "";
      search.lead = "";
    }
    return;
  }
  if (search.kind !== "bash" && PS_ASSIGNED.test(text)) search.lead = "assign";
  else if (CMD_NAME.test(text)) search.lead = "cmd";
  else if (!COMMAND_PREFIX.test(text)) search.tool = searchToolOf(text);
}

// A Select-String group in the pattern's place is the pattern when it holds only quoted words joined by
// commas. Anything else in a group is read as a command. After a group that was another parameter's value,
// the reader goes back to Select-String.
function openSearchPatternGroup(search) {
  const sls = search.tool === "select-string" && !search.redirect;
  const patternNext = sls && (search.value === "regexp" || (!search.value && !search.given));
  let saved = null;
  if (patternNext) saved = { tool: search.tool, given: true };
  else if (sls && search.value) saved = { tool: search.tool, given: search.given, value: true };
  resetSearchPattern(search);
  search.groups.push(saved);
  if (patternNext) search.group = "start";
}

function closeSearchPatternGroup(search) {
  const saved = search.groups.pop();
  const keep = saved && (saved.value || search.group === "pattern");
  resetSearchPattern(search);
  if (keep) [search.tool, search.given] = [saved.tool, saved.given];
}

// grep and rg: whether an option word holds the pattern glued on (`-eKEY`, `--regexp=KEY`).
function searchPatternOption(search, text) {
  const { short, long } = SEARCH_VALUE_OPTIONS[search.tool];
  if (/^--(?:regexp|file)(?:=|$)/.test(text)) search.given = true;
  if (/^--(?:regexp|file)=/.test(text)) return text.startsWith("--regexp");
  if (long.test(text)) {
    search.value = text === "--regexp" ? "regexp" : "other";
    return false;
  }
  if (!/^-[A-Za-z]/.test(text) || text.startsWith("--")) return false;
  const at = [...text.slice(1)].findIndex((letter) => short.includes(letter)) + 1;
  if (at === 0) return false;
  const letter = text[at];
  if (letter === "e" || letter === "f") search.given = true;
  if (at < text.length - 1) return letter === "e";
  search.value = letter === "e" ? "regexp" : "other";
  return false;
}

function searchPatternWord(search, raw, next) {
  const text = raw.replace(/["']/g, "");
  if (/^\d*$/.test(text) && /[<>]/.test(next)) return false;
  if (search.redirect) {
    search.redirect = false;
    return false;
  }
  if (text === "@" && next === "(") return false;
  if (search.group && QUOTED_LIST.test(raw)) {
    search.group = "pattern";
    return true;
  }
  if (search.group) resetSearchPattern(search);
  if (search.tool === null) {
    searchPatternLeading(search, text);
    return false;
  }
  if (!search.tool) return false;
  if (search.tool === "findstr") return findstrPatternWord(search, text);
  if (search.tool === "select-string") return selectStringPatternWord(search, text);
  if (search.value) {
    const pattern = search.value === "regexp";
    search.value = null;
    return pattern;
  }
  if (!search.optionsEnded && text === "--") {
    search.optionsEnded = true;
    return false;
  }
  if (!search.optionsEnded && /^-./.test(text)) return searchPatternOption(search, text);
  return firstSearchOperand(search);
}

// The first word that isn't an option is the pattern, unless one was given already.
function firstSearchOperand(search) {
  if (search.given) return false;
  search.given = true;
  return true;
}

// findstr: the pattern is `/c:`'s value or the first word that isn't a `/` option; `/g:` names a file of
// patterns.
function findstrPatternWord(search, text) {
  if (/^[/-]/.test(text)) {
    if (/^[/-][cg]:/i.test(text)) search.given = true;
    return /^[/-]c:/i.test(text);
  }
  return firstSearchOperand(search);
}

// Select-String: the pattern is `-Pattern`'s value or the first word that isn't a parameter or a
// parameter's value. `-InputObject`'s value is text to search, so it stays as written too.
function selectStringPatternWord(search, text) {
  if (search.value) {
    const kept = search.value !== "other";
    search.value = null;
    return kept;
  }
  const parameter = /^-([A-Za-z]+)(:?)/.exec(text);
  if (!parameter) return firstSearchOperand(search);
  const name = parameter[1].toLowerCase();
  const isPattern = name.length > 3 && "pattern".startsWith(name);
  const isInput = name.length > 2 && "inputobject".startsWith(name);
  if (isPattern) search.given = true;
  if (parameter[2]) return isPattern || isInput;
  if (SELECT_STRING_VALUES.some((known) => known.startsWith(name))) {
    search.value = selectStringValueKind(isPattern, isInput);
  }
  return false;
}

// What a Select-String parameter's next word is: the pattern, text to search, or some other value.
function selectStringValueKind(isPattern, isInput) {
  if (isPattern) return "regexp";
  if (isInput) return "text";
  return "other";
}

// The search tool a command's name is, as searchPatternWords reads it, or "" for any other command.
function searchToolOf(name) {
  if (SEARCH_TOOL.test(name)) return SEARCH_TOOL.exec(name)[1] ? "grep" : "rg";
  if (SELECT_STRING.test(name)) return "select-string";
  return FINDSTR.test(name) ? "findstr" : "";
}

// ---------- Search patterns ----------

// A word no shell expands, splits, joins or redirects: no glob, variable, list, quote, escape, group or
// separator.
const SEARCH_PLAIN_WORD = /^[^*?[\]{}~$@%!`\u2026,;'"()<>|&^#\s\u2013-\u201f]+$/;
// Where among these words ({ value, quoted }) is the one rg, findstr or Select-String searches for, which
// names no file it reads, or -1: rg's or findstr's first operand when no `-e`, `-f`, `/c:` or `/g:` gives the
// patterns (see recursiveReadTargets), and Select-String's `-Pattern` value, given by name before any `--`.
// Only where every word up to it is plain (see SEARCH_PLAIN_WORD), so the shell passes it where it's read,
// and it starts with no `-` or `/`. For rg and findstr, no word before it is quoted either: cmd keeps single
// quotes, so `'/i'` is the pattern there. rg's config file (RIPGREP_CONFIG_PATH) can give it its patterns, so
// rg's word is a file it reads then; and Git Bash hands a Windows program a word with a `/` as a path (`/i`
// as `I:/`, `-i/nv` as `-iC:/.../nv`, findstr's `/C:`), but one starting `//` and then letters as a switch
// (`//i` as `/i`), so in a reading that may be Git Bash's (`gitBash`), findstr may take that for its pattern
// and this word for a file after one. Select-String doesn't run in Git Bash. Then the word is left out only
// where `mayBeFile(value, rg)` says no file could be at it.
function searchPatternAt(reader, words, mayBeFile = () => true, gitBash = false) {
  let at = -1;
  // `-Pattern:x` is the word itself.
  let glued = false;
  if (/^(?:select-string|sls)$/i.test(reader)) {
    for (let index = 0; index < words.length && at < 0 && !words[index].value.startsWith("--"); index += 1) {
      const word = words[index];
      const named = !word.quoted && !word.partQuoted && /^-patt(?:ern|er|e)?(:|$)/i.exec(word.value);
      const value = named ? word.value.slice(named[0].length) : "";
      if (value) {
        at = index;
        glued = !/^[-/]/.test(value);
      } else if (named && index + 1 < words.length) at = index + 1;
    }
  } else if (/^(?:rg|findstr)$/i.test(reader)) {
    const searched = {};
    recursiveReadTargets(
      reader,
      words.map((word) => word.value),
      undefined,
      { searched },
    );
    at = searched.pattern ? words.findIndex((word) => word.value === searched.pattern) : -1;
    if (at >= 0 && !words.slice(0, at).every(isUnquotedWord)) return -1;
  }
  if (at < 0 || (!glued && /^[-/]/.test(words[at].value))) return -1;
  if (!words.slice(0, at + 1).every(isPlainSearchWord)) return -1;
  const rg = /^rg$/i.test(reader);
  const slashed =
    gitBash &&
    /^findstr$/i.test(reader) &&
    words.slice(0, at).some((word) => word.value.includes("/") && !/^\/\/[a-z]+$/i.test(word.value));
  return (rg || slashed) && mayBeFile(words[at].value, rg) ? -1 : at;
}

function isPlainSearchWord(word) {
  return SEARCH_PLAIN_WORD.test(word.value) && !word.depth && !word.listed;
}

function isUnquotedWord(word) {
  return !word.quoted && !word.partQuoted;
}

// Whether a file could be at this path, as a search's pattern word (see searchPatternAt): for rg, a config
// file is named (see inspectShell); the command runs more than one call, or moves to another folder; the path
// has a `/` or `:` or ends in a dot, which Windows or Git Bash open as another path; or one is there, or
// Guard can't look, on another computer or with its lookups spent. Joined, not resolved, as the shell opens
// it.
function patternMayBeFile(value, cwd, shellGlobs, rg) {
  if (!shellGlobs || (rg && shellGlobs.rgConfig)) return true;
  if (!shellGlobs.oneCall || !shellGlobs.staysInFolder) return true;
  const { budget } = shellGlobs;
  if (/[/:]|\.$/.test(value) || remoteLocation(value, cwd)) return true;
  if (!budget || lookupsSpent(budget)) return true;
  budget.lookups -= 1;
  const target = path.isAbsolute(value) ? value : `${path.resolve(cwd)}${path.sep}${value}`;
  try {
    return fs.statSync(target, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

// ---------- Search text words ----------

// rg's and grep's options whose value is a glob, a file type or a replacement, never a file: the long names,
// and the short letters in the order SEARCH_VALUE_OPTIONS lists them.
const SEARCH_TEXT_OPTIONS = {
  grep: { long: /^--(?:include|exclude|exclude-dir)(?:=|$)/, short: "" },
  rg: { long: /^--(?:glob|iglob|type|type-not|type-add|pre-glob|replace)(?:=|$)/, short: "gtTr" },
};

// A word as the operand check sees it: no quotes, and `/` for `\`.
function searchTextKey(word) {
  return word.replace(/["']/g, "").replace(/\\/g, "/");
}

// The words of a command that grep, rg or Select-String reads as text and never opens: a pattern (see
// searchPatternWords), or the value of an option that is a glob, a file type or a replacement (`rg -g`,
// `--type-add`, grep's `--include`). Each is kept as searchTextKey writes it. A word written the same way
// anywhere else in the command, where it may be a file, is left out. Words are split at spaces and the
// shell's separators, outside quotes.
function searchTextWords(command, kind) {
  const search = searchPatternWords(kind);
  const text = new Set();
  const other = new Set();
  let tool = null;
  let valueNext = false;
  let word = null;
  let quote = null;
  function reset() {
    tool = null;
    valueNext = false;
    search.reset();
  }
  function flush(next) {
    if (word === null) return;
    const raw = word;
    word = null;
    const plain = raw.replace(/["']/g, "");
    const leadWord = CMD_NAME.test(plain) || /^\/[a-z]$/i.test(plain) || COMMAND_PREFIX.test(plain);
    if (tool === null && !leadWord) {
      if (!PS_ASSIGNED.test(plain) && !PS_ASSIGN.test(plain)) tool = searchToolOf(plain);
    }
    const pattern = search.word(raw, next);
    const valued = valueNext;
    valueNext = false;
    const options = SEARCH_TEXT_OPTIONS[tool];
    let isText = (pattern && /^(?:grep|rg|select-string)$/.test(tool)) || (valued && Boolean(options));
    if (options && !valued && options.long.test(plain)) {
      if (plain.includes("=")) text.add(searchTextKey(plain.slice(plain.indexOf("=") + 1)));
      else valueNext = true;
    } else if (options && !valued && /^-[A-Za-z]/.test(plain) && !plain.startsWith("--")) {
      const valueLetters = SEARCH_VALUE_OPTIONS[tool].short;
      const at = [...plain.slice(1)].findIndex((letter) => valueLetters.includes(letter)) + 1;
      if (at > 0 && options.short.includes(plain[at])) {
        if (at === plain.length - 1) valueNext = true;
        else text.add(searchTextKey(plain.slice(at + 1)));
      }
      isText = isText && at === 0;
    }
    if (isText) text.add(searchTextKey(raw));
    else other.add(searchTextKey(raw));
  }
  for (const char of command) {
    if (quote === null && /[\s;&|<>()]/.test(char)) {
      flush(char);
      if (char === "<" || char === ">") search.redirect();
      else if (char === "(") search.open();
      else if (char === ")") search.close();
      if (/[;&|()\n]/.test(char)) reset();
      continue;
    }
    if (char === quote) quote = null;
    else if (quote === null && (char === "'" || char === '"')) quote = char;
    word = (word ?? "") + char;
  }
  flush("");
  for (const value of other) text.delete(value);
  return text;
}

module.exports = {
  COMMAND_PREFIX,
  SEARCH_TOOL,
  SELECT_STRING,
  FINDSTR,
  CMD_NAME,
  PS_ASSIGNED,
  PS_ASSIGN,
  QUOTED_LIST,
  SELECT_STRING_VALUES,
  SEARCH_VALUE_OPTIONS,
  searchPatternWords,
  searchToolOf,
  SEARCH_PLAIN_WORD,
  searchPatternAt,
  patternMayBeFile,
  searchTextKey,
  searchTextWords,
};

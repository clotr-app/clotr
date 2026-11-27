"use strict";
/* global require, module */

const { SHELL_ESCAPES, unescapedCommand, wordsAsRun } = require("./shell-quoting.js");
const { searchPatternWords } = require("./search-pattern-words.js");

// ---------- Empty-variable spellings ----------

// A variable whose value Guard can't see may be empty, and then the shell opens the name around it: `cat
// $u.env` opens `.env`. The variables taken out: `$name`, `${name}`, `$1` to `$9`, `$@`, `$*`, PowerShell's
// `$env:name`, and where cmd may run the command, `%name%`.
const VARIABLE_NAME = String.raw`[A-Za-z_]\w{0,63}`;
const EMPTY_VARIABLE = new RegExp(
  String.raw`\$(?:\{(?:${VARIABLE_NAME}|[1-9@*])\}|${VARIABLE_NAME}(?::${VARIABLE_NAME})?|[1-9@*])`,
  "y",
);

const EMPTY_CMD_VARIABLE = /%[A-Za-z_]\w{0,63}%/y;

const WORD_BREAK = /[\s;&|<>()`]/;

// The command with each variable taken out of a word that has other text in it (`cat $u.env` read as `cat
// .env`, `cat .e"$u"nv` as `cat .e""nv`), or the command itself when no word has one. A word that is only a
// variable stays, since taking it out would move the words after it. A variable inside single quotes or after
// an escape is text and stays too, and so does a search tool's pattern (see searchPatternWords), which names
// no file. Each character is looked at once, so this is linear.
function withEmptyVariables(command, kind) {
  const cmd = kind === "any";
  let out = "";
  let pieces = [];
  let quote = null;
  const search = searchPatternWords(kind);
  const variablePatterns = cmd ? [EMPTY_VARIABLE, EMPTY_CMD_VARIABLE] : [EMPTY_VARIABLE];
  // Ends a word: its variables are left out when it has other text, unless it's a search tool's pattern.
  function flush(next) {
    const pattern = pieces.length > 0 && search.word(pieces.map((piece) => piece.text).join(""), next);
    const variable = !pattern && pieces.some((piece) => piece.variable);
    const other = pieces.some((piece) => !piece.variable && !piece.quote);
    for (const piece of pieces) if (!(variable && other && piece.variable)) out += piece.text;
    pieces = [];
  }
  function variableAt(at) {
    for (const pattern of variablePatterns) {
      pattern.lastIndex = at;
      const found = pattern.exec(command);
      if (found) return found[0];
    }
    return null;
  }
  for (let at = 0; at < command.length;) {
    const char = command[at];
    if (quote === null && WORD_BREAK.test(char) && !(char === "`" && command[at + 1] === "$")) {
      flush(char);
      if (char === "<" || char === ">") search.redirect();
      else if (char === "(") search.open();
      else if (char === ")") search.close();
      else if (endsCommand(command, at)) search.reset();
      out += char;
      at += 1;
      continue;
    }
    const escaped = char === "\\" && /[$"'\\%`]/.test(command[at + 1] ?? "");
    if (quote !== "'" && (escaped || char === "`")) {
      pieces.push({ text: command.slice(at, at + 2) });
      at += 2;
      continue;
    }
    if (char === quote || (quote === null && (char === "'" || char === '"'))) {
      quote = quote === null ? char : null;
      pieces.push({ text: char, quote: true });
      at += 1;
      continue;
    }
    const variable = quote !== "'" && (char === "$" || char === "%") ? variableAt(at) : null;
    pieces.push(variable ? { text: variable, variable: true } : { text: char });
    at += variable ? variable.length : 1;
  }
  flush("");
  return out;
}

// Whether the separator at `at` ends a command for the search reader: `;`, `|`, a bracket, a backtick, a line
// break, or an `&` that isn't part of a redirection (`2>&1`, `&>`).
function endsCommand(command, at) {
  const char = command[at];
  if (/[;|()`\n]/.test(char)) return true;
  if (char !== "&") return false;
  return !/[<>]/.test((command[at - 1] ?? "") + (command[at + 1] ?? ""));
}

// The other ways a command may be spelled for the shells that could run it (`kind`: Claude Code's Bash tool
// is "bash", its PowerShell tool "powershell", and Cursor's shell, which may be either, "any"): with Bash's
// escapes and quoting read, with PowerShell's, and with cmd's, which any of them can start, each also with
// quotes ended at line breaks, and Bash's and PowerShell's each also with their comments, here-docs and
// here-strings read (see unescapedCommand). PowerShell's reading also takes its curly quotes and dashes for
// plain ones, splits a parameter's value written after a colon (`-Path:.env`) into a word of its own and
// drops a provider's name before a path (`FileSystem::C:\...`). cmd's reading takes off the quotes `cmd /c
// "..."` drops before it reads carets. Each spelling is also read with its words as they run (see
// wordsAsRun). Each is checked as well as the command as written, never instead.
function spellingsOf(command, kind) {
  const spellings = [command];
  function add(spelling) {
    if (!spellings.includes(spelling)) spellings.push(spelling);
  }
  const lines = /[\r\n]/.test(command);
  // Each shell's escapes are read plainly, and where the command may have a comment, a here-doc or a
  // here-string, also with those read, so a misreading of one can't hide what the plain reading sees. Where a
  // Bash command a double quote holds may have a `case`, each is also read with its patterns' `)` (see
  // unescapedCommand).
  function spell(text, escapes, after = (each) => each) {
    const plain = { ...escapes, comments: false, blockComments: false, hereDocs: false, hereStrings: false };
    const readings = escapes.comments && /#|<<|@['"]/.test(text) ? [plain, escapes] : [plain];
    const joined = escapes === SHELL_ESCAPES.bash && text.replace(/\\\r?\n/g, "");
    if (joined && /case/.test(joined) && /\$\(/.test(joined)) {
      readings.push(...readings.map((options) => ({ ...options, cases: true })));
    }
    for (const options of lines ? readings.flatMap((each) => [each, { ...each, lineReset: true }]) : readings) {
      const spelling = unescapedCommand(text, options);
      if (spelling !== null) add(after(spelling));
    }
  }
  if (kind !== "powershell" && /[\\$#]/.test(command)) spell(command, SHELL_ESCAPES.bash);
  if (kind !== "bash" && /[`:#\u2013-\u2015\u2018-\u201e]/.test(command)) {
    const plain = command
      .replace(/[\u2018-\u201b]/g, "'")
      .replace(/[\u201c-\u201e]/g, '"')
      .replace(/[\u2013-\u2015]/g, "-");
    spell(plain, SHELL_ESCAPES.powershell, powershellWordsSplit);
  }
  if (command.includes("^")) {
    spell(
      command.replace(/(\bcmd(?:\.exe)?["']?[^\S\r\n]+\/[ckr][^\S\r\n]+)"([^\r\n]*)"/gi, "$1$2"),
      SHELL_ESCAPES.cmd,
    );
  }
  for (const spelling of [...spellings]) {
    add(wordsAsRun(spelling));
    if (/\$\{[A-Za-z_]\w*:?[-=+]/.test(spelling)) add(wordsAsRun(spelling, true));
  }
  return spellings;
}

// PowerShell's reading with a parameter's value after a colon (`-Path:.env`) made a word of its own, and a
// provider's name before a path (`FileSystem::C:\...`) dropped.
function powershellWordsSplit(spelling) {
  return spelling
    .replace(/(^|[\s;(|&])(-[A-Za-z][\w-]*):(?=[^\s:])/g, "$1$2 ")
    .replace(/(^|[\s,;(|&'"=:])(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/gi, "$1");
}

// The command with its variables empty (see withEmptyVariables), or the command itself when it has none.
function emptiedCommand(command, kind) {
  return /[$%]/.test(command) ? withEmptyVariables(command, kind) : command;
}

// A command's spellings (see spellingsOf), and where a word has a variable in it, also those of the command
// with the variable empty (see withEmptyVariables).
function shellSpellings(command, kind) {
  const spellings = spellingsOf(command, kind);
  const emptied = emptiedCommand(command, kind);
  if (emptied === command) return spellings;
  for (const spelling of spellingsOf(emptied, kind)) if (!spellings.includes(spelling)) spellings.push(spelling);
  return spellings;
}

module.exports = {
  EMPTY_VARIABLE,
  EMPTY_CMD_VARIABLE,
  WORD_BREAK,
  withEmptyVariables,
  spellingsOf,
  emptiedCommand,
  shellSpellings,
};

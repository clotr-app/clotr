"use strict";
/* global require, module */

const { hasOwn } = require("../limits-and-messages.js");
const { ShellCheckTooLong, checkShellDeadline } = require("../check-budget.js");

// ---------- PowerShell groups ----------

// How many PowerShell groups inside groups, `gc (('.env'))`, pass their words up as the files a reader is
// given.
const SHELL_GROUP_DEPTH = 3;
// PowerShell commands whose words are a filter or a script, not paths: `(gci | ? Name -ne x)`.
const SHELL_FILTER_WORD = /^(?:\?|%|where|Where-Object|foreach|ForEach-Object|select|Select-Object)$/i;
// A filter's switches that hand it values: -InputObject, as short as PowerShell takes it, and -In.
const SHELL_FILTER_INPUT = /^-in(?:p(?:u(?:t(?:o(?:b(?:j(?:e(?:c(?:t)?)?)?)?)?)?)?)?)?$/i;
// ---------- The parse budget ----------

// Characters of parsing a shell check may do per character of the command, past a floor; a command that needs
// more stops, like one with too many paths.
const SHELL_PARSE_STEPS_PER_CHAR = 64;
const SHELL_PARSE_MIN_STEPS = 1 << 20;
// ---------- Quotes and escapes ----------

const BLANK = /[^\S\n]/;
// Where a cmd quote ends: its closing `"` or the end of its line, at a `\r` or `\n`.
const CMD_QUOTE_END = /["\r\n]/g;
const PS_SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b";
const PS_DOUBLE_QUOTES = '"\u201c\u201d\u201e';
// PowerShell 7's `e (escape) is a plain e to Windows PowerShell 5.1, which reads ".`env" as .env.
const PS_ESCAPES = { 0: "\0", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const ANSI_C_ESCAPES = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};
// How many hex digits ANSI-C's `\x`, `\u` and `\U` read at most.
const HEX_ESCAPE_DIGITS = { x: 2, u: 4, U: 8 };
// ---------- Runs read in one step ----------

// Runs of characters with no meaning to the parser, read in one step. Each is one character class, so it
// can't backtrack.
const PLAIN_RUN = {
  bash: /[^\s;&|()<`'"\\$]+/y,
  powershell: /[^\s;&|(){},`'"\u2018\u2019\u201a\u201b\u201c\u201d\u201e$@#<]+/y,
  cmd: /[^\s,;=^"&|()<]+/y,
};
const DOUBLE_RUN = { bash: /[^"\\$`]+/y, powershell: /[^"\u201c\u201d\u201e`$]+/y };
const PS_SINGLE_RUN = /[^'\u2018\u2019\u201a\u201b]+/y;
const PROSE_LETTER = /[\p{L}\p{N}]/u;
// A PowerShell variable with members or an index (`$x.Name`, `$a[0]`), and a value an expression may end a
// token with: such a variable, a number, or an assignment of one (`$x=1`). Each part ends where the next
// can't start, so they can't backtrack; read from a word's start, where each match ends is kept on the word
// (see psTokenStarts). An index is read only so far, so a line of unclosed ones (`$a[# $a[# …`) can't take
// time on each.
const PS_VARIABLE = String.raw`\$[\w:?^]+(?:\.\w+|\[[^\]\n]{0,100}\])`;
const PS_VALUE = String.raw`(?:${PS_VARIABLE}*|[-+]?\d[\w.]*)`;
const PS_MEMBER_VALUE = new RegExp(`${PS_VARIABLE}+`, "y");
const PS_EXPRESSION_VALUE = new RegExp(String.raw`(?:${PS_VALUE}[-+*/%]?=)*${PS_VALUE}`, "y");
const PARAM_RUN = /[^}\\'"$`]+/y;
// The start of a `${…}`: a name, a number or a special parameter, a short subscript, then the operator, if
// any. A name holds no `$`, so the names of two `${` never overlap and reading them all is linear; a
// subscript, which could hold another `${`, is read up to 256 characters.
const PARAM_NAME = "(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])";
const PARAM_OPERATOR = new RegExp(`[#!]?${PARAM_NAME}(?:\\[[^\\]'"]{0,256}\\])?(:?[-=+?]|[#%/^,:@])?`, "y");

// Reserved words that may come before a function's name in its definition: `{ f() …`, `function f() …`.
const FUNCTION_LEAD_WORDS = new Set([
  "{",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "function",
  "time",
  "-p",
]);
// ---------- The command line parser ----------

// Splits shell text into its simple commands, each with its words as the shell will pass them, using one
// shell's quote rules: Bash's quotes, backslash and $'…'; PowerShell's quotes (typographic ones too),
// backtick and here-strings; cmd's double quotes and ^. Only a separator outside quotes ends a command, so
// `cat "a|b" .env` is one command of two words. `$(…)`, backticks, `(…)` and PowerShell's `{…}` are commands
// of their own; the word they sit in keeps a mark for them. One pass, each character read once, and `work`
// counts the characters read for the whole shell check. `start` and `firstOnly` read just the one command
// that starts at `start`. `body` reads the text of a here-document or here-string whose `$(…)` and backticks
// run, as double-quoted text whose quotes are letters, and gives only the commands inside it. A command's
// `heredocs` are the bodies it's given, and `expands` those whose commands run.
function parseShellCommands(
  text,
  dialect,
  work,
  { start = 0, firstOnly = false, body = false, quote = null, watch = null, prose = false } = {},
) {
  const n = text.length;
  // PowerShell: `quote` is the quote the text read from `start` sits in, as the whole command is read:
  // "literal" for a single quote or a `@'…'@`, "double" for a double quote or `@"…"@`. There a backtick
  // outside a quote of the text's own ends the command, as in Guard's first reading: the shell has kept it as
  // a letter or taken it as an escape, and in a message it's most often a Markdown code span's end (`` `cat
  // .env.example` ``). In a single quote it's kept as a letter inside a double quote of the text's own.
  // `watch`: sorted places whose quote, as above, is put in `watch.quotes`. `stepQuote`: the quote the step
  // being read is in, set by the steps that read one whole. `stray`: PowerShell's text has a `)` or `}` with
  // nothing open, which it can't parse.
  let stepQuote;
  let stray = false;
  let watched = 0;
  // PowerShell: where a `(…)`, `$(…)`, `@(…)`, `{…}` or `@{…}` that starts a word ends, which ends a token
  // there.
  let tokenEnd = -1;
  const commands = [];
  // Commands with no words that are given a here-document or here-string, `<<EOF` alone: text nothing reads.
  const textOnly = [];
  const pending = [];
  let first = null;
  let done = false;
  // Where Bash's last backslash-escaped character outside quotes is.
  let escapedAt = -1;
  const root = { type: "code", closer: "", arith: false, command: newCommand(), word: null, input: false, outer: null };
  const frames = body ? [root, { type: "doc" }] : [root];
  let code = root;
  // `touched`: the word the step being read adds to, which ends where that step does.
  let touched = null;

  // `prose`: the text is read from a reader's name the shell doesn't run there (inside a quote or a
  // here-document), most often a message's words, so a single quote between two letters is an apostrophe
  // (`doesn't`), not a quote that would pair with the next one and hide a `)` or `|` that ends the reader's
  // words.
  function apostrophe(i) {
    return i > 0 && PROSE_LETTER.test(text[i - 1]) && PROSE_LETTER.test(text[i + 1] || "");
  }

  // ---------- Commands and words ----------

  // `stdinFrom`: what the command's input, stream 0, is redirected from, in order: a file's name as written,
  // or null for a here-document's or here-string's text, or an empty name for a stream copied or closed
  // (`<&3`, `<&-`). `piped`: the command is piped into, so a reader's input is what the command before it
  // writes. `bodies`: here-documents whose end Guard may place otherwise than the shell, read as commands
  // too. In cmd, `start`: the index of the word where a command may start (after `if`'s condition, `do` or
  // `else`), where a `(` opens a block; `ifPhase`: what of an `if`'s condition is still to come; `forState`:
  // "for" past a `for` that starts a command, "set" past its `in`, "done" past its set; `setOpen`, `setFrom`:
  // the set's `(` is open, and the index of its first word; `forLines`: the `for` is a `for /f`; `sets`: each
  // `for /f` set's words, `{ from, to, lines }`.
  function newCommand() {
    return {
      dialect,
      words: [],
      inputs: [],
      heredocs: [],
      hereStrings: [],
      expands: [],
      bodies: [],
      stdinFrom: [],
      piped: false,
      start: 0,
      ifPhase: null,
      forState: null,
      setOpen: false,
      setFrom: 0,
      forLines: false,
      sets: [],
    };
  }

  // A word's `quoted` says whether it starts quoted or escaped; `partQuoted`, whether any of it is;
  // `quotedAt`, where in its value the first quoted or escaped character is (-1 for none). `start` and `end`
  // are where it's written: `text.slice(word.start, word.end)` is the word as written, with its quotes,
  // escapes and groups.
  function startWord(at, quoted = false) {
    if (code.word === null) {
      code.word = { value: "", start: at, end: at, quoted, partQuoted: quoted, quotedAt: quoted ? 0 : -1 };
    } else if (quoted && !code.word.partQuoted) {
      code.word.partQuoted = true;
      code.word.quotedAt = code.word.value.length;
    }
    touched = code.word;
    return code.word;
  }

  function add(value, at, quoted = false) {
    startWord(at, quoted).value += value;
  }

  function endWord() {
    const word = code.word;
    if (word === null) return;
    code.word = null;
    if (code.input) {
      if (code.input !== "text") code.command.inputs.push(word.value);
      else code.command.hereStrings.push(word);
      if (code.stdinNext) code.command.stdinFrom.push(word.value);
      code.input = false;
      code.stdinNext = false;
      return;
    }
    if (dialect === "bash" && !word.partQuoted && startsAfterGroup(word)) endCommand();
    code.command.words.push(word);
    if (dialect === "cmd") cmdKeyword(word);
  }

  // Bash: after a subshell or `((…))`, a word starts what follows (`(true) then cat .env`, a case pattern's
  // `(x) cat .env`), as a reserved word does after a `]]` or `}` closing a `[[` or `{` that starts the
  // command (`[[ -f x ]] then cat .env`). Among a reader's words they're plain words: `cat 'a;b' } do .env`.
  function startsAfterGroup(word) {
    const { words } = code.command;
    const before = words[words.length - 1];
    if (!before) return false;
    const redirect = /^(?:\d*|&)[<>]/.test(word.value);
    const afterGroup = before.compound && before.value === "\u2026" && !redirect;
    if (afterGroup) return true;
    if (before.partQuoted) return false;
    if (!/^(?:then|do|else|elif)$/.test(word.value)) return false;
    if (before.value === "}" && words.length === 1) return true;
    if (before.value !== "]]") return false;
    const unquotedAt = (at) => at < words.length && !words[at].partQuoted;
    const lead = unquotedAt(0) && /^(?:if|elif|while|until|!)$/.test(words[0].value) ? 1 : 0;
    return unquotedAt(lead) && words[lead].value === "[[";
  }

  function endCommand() {
    endWord();
    code.input = false;
    code.stdinNext = false;
    const command = code.command;
    // A `for` set left open is read as far as it goes.
    if (command.setOpen) {
      command.sets.push({ from: command.setFrom, to: command.words.length, lines: command.forLines });
    }
    code.command = newCommand();
    if (code.group && command.words.length) code.group.push(command);
    if (code.arith || (body && code === root)) return;
    if (command.words.length || command.inputs.length) commands.push(command);
    else if (command.givenText || command.hereStrings.length) textOnly.push(command);
    if (code === root) {
      if (first === null) first = command;
      if (firstOnly) done = true;
    }
  }

  // ---------- cmd keywords ----------

  // cmd's keywords, found only where a command starts: `for` and its `/f`, `in` and set; `if` and its
  // condition (`if /i not a==b`, `if exist x`, `if a equ b`); a `for`'s `do`; `else` after a block.
  function cmdKeyword(word) {
    const command = code.command;
    const at = command.words.length - 1;
    if (command.setOpen) return;
    // A quoted word is no keyword, but may be a part of an `if`'s condition.
    const bare = word.partQuoted ? "" : word.value.replace(/^@+/, "");
    if (command.ifPhase === "cond") {
      if (/^(?:\/i|not)$/i.test(bare)) return;
      command.ifPhase = /^(?:exist|defined|errorlevel|cmdextversion)$/i.test(bare) ? "operand" : "op";
    } else if (command.ifPhase === "op") {
      command.ifPhase = /^(?:equ|neq|lss|leq|gtr|geq)$/i.test(bare) ? "operand" : null;
      if (!command.ifPhase) command.start = at + 1;
    } else if (command.ifPhase === "operand") {
      command.ifPhase = null;
      command.start = at + 1;
    } else if (at === command.start && /^if$/i.test(bare)) command.ifPhase = "cond";
    else if (at === command.start && /^for$/i.test(bare)) {
      command.forState = "for";
      command.forLines = false;
    } else if (command.forState === "for" && /^\/f/i.test(bare)) command.forLines = true;
    else if (command.forState === "for" && /^in$/i.test(bare)) command.forState = "set";
    else if (command.forState === "done" && /^do$/i.test(bare)) {
      command.forState = null;
      command.start = at + 1;
    } else if (/^else$/i.test(bare) && at > 0 && command.words[at - 1].value === "\u2026") command.start = at + 1;
  }

  // ---------- Groups ----------

  function pushCode(closer, at, arith = false, nested = true) {
    startWord(at);
    const frame = { type: "code", closer, arith, command: newCommand(), word: null, input: false, outer: code, at };
    // How deep the frame is: a here-document's lines start at a line break as deep as its marker, or less
    // deep. A subshell's `(` isn't deeper: Bash starts them at a line break inside it.
    frame.level = (code.level || 0) + (nested ? 1 : 0);
    // A PowerShell `(…)`, `$(…)` or `@(…)` given as an argument may be the files read: `gc ('a', '.env')`.
    frame.group = dialect === "powershell" && closer === ")" ? [] : null;
    frames.push(frame);
    code = frame;
  }

  // Ends the innermost command frame and any quotes left open inside it. The word it sat in gets a mark, not
  // its text, so frames nested deep can't make the words that hold them long.
  function closeCode() {
    while (frames[frames.length - 1] !== code) frames.pop();
    endCommand();
    frames.pop();
    const inner = code;
    code = code.outer;
    add("\u2026", 0);
    code.word.grouped = true;
    if (inner.compound) code.word.compound = true;
    for (const command of inner.group || []) passGroupValues(command);
  }

  // A PowerShell group's words, past a filter's (`? Name -ne x`), are kept on the word the group sits in as
  // its `values`, so they stand where the group does. They're passed up at most SHELL_GROUP_DEPTH groups, so
  // each word is copied a bounded number of times. A word that leaves any out past that is marked `deep`, and
  // so is every word it's passed up into, so a reader given it is stopped unless a file it names is a secret
  // one (see secretInReaderWords).
  function passGroupValues(command) {
    const head = command.words[0];
    const filter = !head.quoted && SHELL_FILTER_WORD.test(head.value);
    let given = false;
    for (const word of command.words) {
      // A filter's own words aren't files, but what it's handed is: the words after -InputObject or -In, and
      // a group of its own, such as foreach's `($f in '.env')`. A quoted word, as in `('select', '.env')`, is
      // a value.
      if (filter && !word.quoted && word.value.startsWith("-")) given = SHELL_FILTER_INPUT.test(word.value);
      const handed = !filter || given || /^-in/i.test(word.value);
      const values = handed ? [word, ...(word.values || [])] : word.values || [];
      if (word.deep) code.word.deep = true;
      for (const value of values) {
        const depth = (value.depth || 0) + 1;
        if (depth > SHELL_GROUP_DEPTH) {
          code.word.deep = true;
          continue;
        }
        if (!code.word.values) code.word.values = [];
        code.word.values.push({
          value: value.value,
          start: value.start,
          end: value.end,
          quoted: value.quoted,
          depth,
          deep: value.deep,
        });
      }
    }
  }

  function closeParen(i) {
    if (code.closer === "))") {
      closeCode();
      return text[i + 1] === ")" ? i + 2 : i + 1;
    }
    if (code.closer === ")") {
      closeCode();
      // A cmd block's mark is a word of its own: `(echo a)else(type b)`.
      if (dialect === "cmd") endWord();
      return i + 1;
    }
    // A `)` with nothing open is text to cmd; to Bash and PowerShell it can only end something.
    if (dialect === "cmd") add(")", i);
    else endCommand();
    return i + 1;
  }

  // Read from a reader's name with nothing open, a backtick may close one opened before the name: it ends the
  // command.
  function backtick(i) {
    if (firstOnly && code === root) endCommand();
    else if (code.closer === "`") closeCode();
    else pushCode("`", i);
    return i + 1;
  }

  // ---------- Separators and redirects ----------

  // A `|` that isn't half of `||` pipes the command it ends into the next.
  function pipe(i) {
    endCommand();
    if (text[i - 1] !== "|" && text[i + 1] !== "|") code.command.piped = true;
    return i + 1;
  }

  // `2>&1`, `>&2` and, but in cmd, `&>` redirect; any other `&` ends a command.
  function ampersand(i) {
    // Bash's `|&` pipes, as `|` does.
    if (dialect === "bash" && text[i - 1] === "|" && text[i - 2] !== "|" && escapedAt !== i - 1) return i + 1;
    const redirects = text[i - 1] === ">" || text[i - 1] === "<" || (text[i + 1] === ">" && dialect !== "cmd");
    if (!redirects) {
      endCommand();
      // PowerShell's `&` calls the command after it.
      if (dialect === "powershell") code.command.called = true;
      return i + 1;
    }
    add("&", i);
    // cmd takes one digit after `>&` as the handle, and the rest as an argument of its own: `type >&2.env`.
    if (dialect === "cmd" && text[i - 1] === ">" && /\d/.test(text[i + 1] || "")) {
      add(text[i + 1], i + 1);
      endWord();
      return i + 2;
    }
    return i + 1;
  }

  function lessThan(i) {
    const next = text[i + 1];
    // The stream it redirects: the digits right before it (`2<file`), a new one for `{fd}<file`, or else the
    // input.
    const before = code.word !== null && !code.word.partQuoted ? code.word.value : "";
    const toInput = /^\d+$/.test(before) ? Number(before) === 0 : !/^\{\w+\}$/.test(before);
    // The digits or `{fd}` are no word of the command's.
    const stream = /^(?:\d+|\{\w+\})$/.test(before);
    if (dialect === "bash" && next === "<") {
      if (stream) code.word = null;
      else endWord();
      if (toInput) code.command.stdinFrom.push(null);
      if (text[i + 2] !== "<") return heredoc(i + 2);
      // A here-string's word is text the command reads, not a file and not its name.
      code.input = "text";
      return i + 3;
    }
    if (next === "(") {
      add("<", i);
      return i + 1;
    }
    // `0<file`: digits just before are the stream it opens, and in Bash `{fd}` names a new one.
    if (stream && (dialect === "bash" || /^\d+$/.test(before))) code.word = null;
    else endWord();
    if (next === "&") {
      // `<&3`, `0<&3`, `<&-`: a stream copied or closed. What follows is no file and no word of the
      // command's, and an input taken from it is none rg reads in place of the working folder (see
      // stdinIsFile).
      if (toInput) code.command.stdinFrom.push("");
      // cmd takes one digit as the handle, and the rest as an argument of its own: `type <&1.env`.
      if (dialect === "cmd") return /\d/.test(text[i + 2] || "") ? i + 3 : i + 2;
      code.input = "text";
      return i + 2;
    }
    code.input = true;
    code.stdinNext = toInput;
    return next === ">" ? i + 2 : i + 1;
  }

  // ---------- Here-documents ----------

  function heredoc(from) {
    let j = from;
    let strip = false;
    if (text[j] === "-") {
      strip = true;
      j += 1;
    }
    while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
    const markerStart = j;
    let delimiter = "";
    // A delimiter with any quoting keeps the body as it's written; otherwise its `$(…)` and backticks run.
    let quoted = false;
    while (j < n && !/[ \t\n;&|()<>]/.test(text[j]) && !(text[j] === "\r" && text[j + 1] === "\n")) {
      const char = text[j];
      // `$'…'` and `$"…"` are quotes; `$(…)` is part of the marker as it's written.
      if (char === "$" && (text[j + 1] === "'" || text[j + 1] === '"')) {
        j += 1;
        continue;
      }
      if (char === "$" && text[j + 1] === "(") {
        const close = markerGroupEnd(j + 1);
        delimiter += text.slice(j, Math.min(close + 1, n));
        j = close + 1;
        continue;
      }
      if (char === "'" || char === '"' || char === "\\") quoted = true;
      if (char === "'" || char === '"') {
        const end = text.indexOf(char, j + 1);
        const stop = end < 0 ? n : end;
        delimiter += text.slice(j + 1, stop);
        j = stop + 1;
      } else if (char === "\\") {
        delimiter += text[j + 1] || "";
        j += 2;
      } else {
        delimiter += char;
        j += 1;
      }
    }
    // A marker with a `$` or backtick, a space Bash doesn't split on (`\u00a0`, `\f`, `\r`), or an escape
    // inside double quotes, Guard may read otherwise than the shell.
    const marker = text.slice(markerStart, j);
    const odd = /[$`]|[^\S \t]/.test(marker) || (marker.includes('"') && marker.includes("\\"));
    if (delimiter) {
      pending.push({ delimiter, strip, quoted, odd, level: code.level || 0, command: code.command });
      code.command.givenText = true;
    }
    return j;
  }

  // Where a marker's `$(…)` that opens at `open` closes, on its line, skipping quoted text; the line's end
  // when it doesn't, or a quote isn't closed on the line.
  function markerGroupEnd(open) {
    let at = open;
    let depth = 0;
    const lineEnd = text.indexOf("\n", at);
    const stop = lineEnd < 0 ? n : lineEnd;
    for (; at < stop; at += 1) {
      if (text[at] === "'" || text[at] === '"') {
        const close = text.indexOf(text[at], at + 1);
        if (close < 0 || close >= stop) return stop;
        at = close;
      } else if (text[at] === "(") depth += 1;
      else if (text[at] === ")" && --depth === 0) break;
    }
    return at;
  }

  // A here-document's lines are its command's input, not commands; they're kept for a shell that runs them. A
  // line break inside a `$(` or backtick starts only the here-documents marked inside it: `<<EOF $(` ⏎ `cat
  // x` ⏎ `)`.
  function readHeredocs(at) {
    let i = at;
    const level = code.level || 0;
    let ready = pending.length;
    while (ready > 0 && pending[ready - 1].level >= level) ready -= 1;
    for (const doc of pending.splice(ready)) {
      const bodyStart = i;
      let bodyEnd = n;
      while (i < n) {
        const lineStart = i;
        const lineEnd = text.indexOf("\n", i);
        const stop = lineEnd < 0 ? n : lineEnd;
        let from = i;
        if (doc.strip) while (from < stop && text[from] === "\t") from += 1;
        const to = stop > from && text[stop - 1] === "\r" ? stop - 1 : stop;
        i = lineEnd < 0 ? n : lineEnd + 1;
        if (to - from === doc.delimiter.length && text.startsWith(doc.delimiter, from)) {
          bodyEnd = lineStart;
          break;
        }
      }
      const lines = text.slice(bodyStart, bodyEnd);
      doc.command.heredocs.push(lines);
      if (!doc.quoted) doc.command.expands.push(lines);
      // One whose marker Guard may misread, or never finds, may end sooner for the shell: its lines may be
      // commands.
      if (doc.odd || bodyEnd === n) doc.command.bodies.push(lines);
    }
    return i;
  }

  // ---------- Bash quotes and expansions ----------

  function singleQuoted(i) {
    if (prose && apostrophe(i)) {
      add(text[i], i);
      return i + 1;
    }
    const end = text.indexOf("'", i + 1);
    const stop = end < 0 ? n : end;
    add(text.slice(i + 1, stop), i, true);
    return stop + 1;
  }

  // Bash's `$'…'`, its escapes decoded.
  function ansiC(i) {
    let value = "";
    let j = i + 2;
    while (j < n && text[j] !== "'") {
      const char = text[j];
      if (char !== "\\" || j + 1 >= n) {
        value += char;
        j += 1;
        continue;
      }
      const escape = text[j + 1];
      if (hasOwn(ANSI_C_ESCAPES, escape)) {
        value += ANSI_C_ESCAPES[escape];
        j += 2;
      } else if (escape === "x" || escape === "u" || escape === "U") {
        const end = digitsEnd(/[0-9a-f]/i, j + 2, HEX_ESCAPE_DIGITS[escape]);
        const point = parseInt(text.slice(j + 2, end), 16);
        value += end > j + 2 && point <= 0x10ffff ? String.fromCodePoint(point) : `\\${escape}`;
        j = end;
      } else if (/[0-7]/.test(escape)) {
        const end = digitsEnd(/[0-7]/, j + 1, 3);
        value += String.fromCharCode(parseInt(text.slice(j + 1, end), 8) & 0xff);
        j = end;
      } else if (escape === "c" && j + 2 < n && text[j + 2] !== "'") {
        // Bash ends $'…' at a quote after \c: `$'\c'` doesn't take the quote as its letter. A backslash after
        // \c takes the character after it too, quote or not: `$'\c\''` is one letter.
        value += String.fromCharCode(text.charCodeAt(j + 2) & 0x1f);
        j += text[j + 2] === "\\" ? 4 : 3;
      } else {
        value += `\\${escape}`;
        j += 2;
      }
    }
    add(value, i, true);
    return j + 1;
  }

  // Where a run of at most `most` characters matching `pattern`, from `from`, ends.
  function digitsEnd(pattern, from, most) {
    let end = from;
    while (end < n && end - from < most && pattern.test(text[end])) end += 1;
    return end;
  }

  function dollar(i) {
    const next = text[i + 1];
    if (next === "(") {
      add("$", i);
      if (dialect === "bash" && text[i + 2] === "(") {
        pushCode("))", i + 1, true);
        return i + 3;
      }
      pushCode(")", i + 1);
      return i + 2;
    }
    if (next === "{" && dialect === "bash") {
      add("${", i);
      // Inside "${x:-…}" (and after =, + or ?) a single quote is kept in the value, and a `$(…)` after one
      // still runs (see bashParam). After #, % or /, as in "${x#'…'}", it's a quote.
      const outer = frames[frames.length - 1];
      const quoted = outer.type === "dq" || outer.type === "doc" || (outer.type === "param" && outer.quoted);
      PARAM_OPERATOR.lastIndex = i + 2;
      const operator = PARAM_OPERATOR.exec(text);
      const letters = quoted && operator !== null && /^:?[-=+?]$/.test(operator[1] || "");
      frames.push({ type: "param", quoted, letters });
      return i + 2;
    }
    add("$", i);
    return i + 1;
  }

  function plain(pattern, i) {
    pattern.lastIndex = i;
    const run = pattern.exec(text);
    const value = run ? run[0] : text[i];
    add(value, i);
    return i + value.length;
  }

  // ---------- Bash code ----------

  function definesFunction() {
    if (code.input) return false;
    const { words } = code.command;
    const name = code.word ?? words[words.length - 1];
    const before = code.word === null ? words.length - 1 : words.length;
    // A word with a group in it is no name, which also keeps `(a)(a)(a)…` from reading its growing word at
    // each `(`.
    if (!name || name.quoted || name.grouped || !/^[^\s"'`$\\<>|&;()]+$/.test(name.value)) return false;
    // Only reserved words can come before the name in a definition: `{ f() …`, `then f() …`, `function f()
    // …`.
    for (let index = 0; index < before; index += 1) {
      if (words[index].quoted || !FUNCTION_LEAD_WORDS.has(words[index].value)) return false;
    }
    return true;
  }

  function bashCode(i) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\n") {
      endCommand();
      return pending.length ? readHeredocs(i + 1) : i + 1;
    }
    if (BLANK.test(char)) {
      endWord();
      return i + 1;
    }
    if (char === "#" && code.word === null && !code.arith) {
      const end = text.indexOf("\n", i);
      return end < 0 ? n : end;
    }
    if (char === "\\") return bashEscape(i, next);
    if (char === "'") return singleQuoted(i);
    if (char === '"') {
      startWord(i, true);
      frames.push({ type: "dq" });
      return i + 1;
    }
    if (char === "$") {
      if (next === "'") return ansiC(i);
      if (next === '"') {
        startWord(i, true);
        frames.push({ type: "dq" });
        return i + 2;
      }
      return dollar(i);
    }
    if (char === "`") return backtick(i);
    if (char === "(") return bashOpenParen(i, next);
    if (char === ")") return closeParen(i);
    if (code.arith) {
      add(char, i);
      return i + 1;
    }
    // `>|` writes over a file even with noclobber on; it doesn't end the command. An escaped `\>` is a
    // letter, and the `|` after it does.
    if (char === "|" && text[i - 1] === ">" && code.word !== null && escapedAt !== i - 1) {
      add(char, i);
      return i + 1;
    }
    if (char === "|") return pipe(i);
    if (char === ";") {
      endCommand();
      return i + 1;
    }
    if (char === "&") return ampersand(i);
    if (char === "<") return lessThan(i);
    return plain(PLAIN_RUN.bash, i);
  }

  function bashEscape(i, next) {
    if (next === "\n") return i + 2;
    // `\`` inside backticks is one nested inside them.
    if (next === "`" && firstOnly && code === root) {
      endCommand();
      return i + 2;
    }
    add(next === undefined ? "\\" : next, i, true);
    escapedAt = i + 1;
    return i + 2;
  }

  function bashOpenParen(i, next) {
    if (next === "(" && code.word === null) {
      pushCode("))", i, true);
      code.compound = true;
      return i + 2;
    }
    // `f() { cat .env; }` and `f () …`: a function's name, so its body is a command of its own. Only a plain
    // name that starts the command (after `function`, if that's there): in `cat <() .env` or extglob's `cat
    // @() .env`, the `()` is part of a word, and the words after it are still the command's.
    if (!code.arith && definesFunction()) {
      let j = i + 1;
      while (j < n && BLANK.test(text[j])) j += 1;
      if (text[j] === ")") {
        endCommand();
        return j + 1;
      }
    }
    // A subshell, where a command starts, is a compound command.
    const subshell = code.word === null && !code.arith;
    pushCode(")", i, code.arith, !subshell);
    if (subshell) code.compound = true;
    return i + 1;
  }

  function bashDouble(i) {
    const char = text[i];
    if (char === '"') {
      frames.pop();
      // The closing quote is the word's, as written.
      touched = code.word;
      return i + 1;
    }
    if (char === "\\") {
      const next = text[i + 1];
      if (next === "\n") return i + 2;
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        add(next, i);
        return i + 2;
      }
      add("\\", i);
      return i + 1;
    }
    if (char === "$") return dollar(i);
    if (char === "`") return backtick(i);
    return plain(DOUBLE_RUN.bash, i);
  }

  function bashParam(i, frame) {
    const char = text[i];
    if (char === "}") {
      frames.pop();
      add("}", i);
      return i + 1;
    }
    if (char === "\\") {
      add(text[i + 1] || "", i);
      return i + 2;
    }
    // There a single quote still pairs with the next one, as Bash finds where the `}` is, but the text
    // between them is read as double-quoted text: its `$(…)`, backticks and `${…}` run. That text has no
    // single quote in it, so reading it on its own goes no deeper.
    if (char === "'" && frame.letters) {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      const inner = parseShellCommands(text.slice(i + 1, stop), "bash", work, { body: true });
      for (const command of inner.commands) commands.push(command);
      add(text.slice(i, stop + 1), i);
      return stop + 1;
    }
    if (char === "'") return singleQuoted(i);
    if (char === '"') {
      frames.push({ type: "dq" });
      return i + 1;
    }
    if (char === "$") return dollar(i);
    if (char === "`") return backtick(i);
    return plain(PARAM_RUN, i);
  }

  // ---------- PowerShell quotes and here-strings ----------

  // PowerShell ends an argument that starts with a quoted string where the string ends: `"a b"*` is two
  // arguments.
  function psSingle(i) {
    if (prose && apostrophe(i)) {
      add(text[i], i);
      return i + 1;
    }
    stepQuote = "literal";
    const fresh = code.word === null;
    let value = "";
    let j = i + 1;
    let closed = false;
    while (j < n) {
      PS_SINGLE_RUN.lastIndex = j;
      const run = PS_SINGLE_RUN.exec(text);
      if (run) {
        value += run[0];
        j += run[0].length;
        if (j >= n) break;
      }
      if (j + 1 < n && PS_SINGLE_QUOTES.includes(text[j + 1])) {
        value += text[j + 1];
        j += 2;
        continue;
      }
      j += 1;
      closed = true;
      break;
    }
    add(value, i, true);
    if (fresh) endWord();
    // Past the end, as an unclosed quote is.
    return closed ? j : n + 1;
  }

  // `${any name}`: a variable whose name may hold quotes, up to the first `}` a backtick doesn't escape.
  function psBraced(i) {
    let j = i + 2;
    while (j < n && text[j] !== "}") j += text[j] === "`" ? 2 : 1;
    add(text.slice(i, Math.min(j + 1, n)), i);
    return j < n ? j + 1 : n + 1;
  }

  function hereString(i, j) {
    const quotes = PS_SINGLE_QUOTES.includes(text[i + 1]) ? PS_SINGLE_QUOTES : PS_DOUBLE_QUOTES;
    stepQuote = quotes === PS_SINGLE_QUOTES ? "literal" : "double";
    let line = j;
    while (line >= 0 && !(quotes.includes(text[line + 1] || "\n") && text[line + 2] === "@")) {
      line = text.indexOf("\n", line + 1);
    }
    const lines = text.slice(j + 1, line < 0 ? n : line);
    add(lines, i, true);
    // `@"…"@` runs its `$(…)`; `@'…'@` doesn't.
    if (quotes === PS_DOUBLE_QUOTES) code.command.expands.push(lines);
    endWord();
    return line < 0 ? n : line + 3;
  }

  // A backtick's escaped character, `n` a line break and so on; nothing past the text's end.
  function psEscaped(next) {
    if (next === undefined) return "";
    return hasOwn(PS_ESCAPES, next) ? PS_ESCAPES[next] : next;
  }

  // A here-document or here-string body: double-quoted text whose quotes are letters.
  function docText(i) {
    const char = text[i];
    if (dialect === "powershell") {
      if (char === "`") {
        add(psEscaped(text[i + 1]), i);
        return i + 2;
      }
      if (char === "$" && text[i + 1] === "{") return psBraced(i);
      if (char === "$") return dollar(i);
      return plain(DOUBLE_RUN.powershell, i);
    }
    if (char === "\\") {
      const next = text[i + 1];
      if (next === "\n") return i + 2;
      if (next === "$" || next === "`" || next === "\\") {
        add(next, i);
        return i + 2;
      }
      add("\\", i);
      return i + 1;
    }
    if (char === "$") return dollar(i);
    if (char === "`") return backtick(i);
    return plain(DOUBLE_RUN.bash, i);
  }

  // ---------- PowerShell code ----------

  function psCode(i) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\n") {
      endCommand();
      return i + 1;
    }
    if (BLANK.test(char)) {
      endWord();
      return i + 1;
    }
    if (char === "#" && psTokenStarts(i)) {
      const end = text.indexOf("\n", i);
      return end < 0 ? n : end;
    }
    if (char === "<" && next === "#" && psTokenStarts(i)) {
      const end = text.indexOf("#>", i + 2);
      return end < 0 ? n : end + 2;
    }
    if (char === "`" && quote) {
      endCommand();
      return i + 1;
    }
    if ((char === "-" || char === "`") && code.word === null) {
      const end = psStopsParsing(i);
      if (end >= 0) return stopParsing(end);
    }
    if (char === "`") return psBacktick(i, next);
    if (char === "$" && next === "{") return psBraced(i);
    if (PS_SINGLE_QUOTES.includes(char)) return psSingle(i);
    if (PS_DOUBLE_QUOTES.includes(char)) {
      frames.push({ type: "dq", fresh: code.word === null });
      startWord(i, true);
      return i + 1;
    }
    const opened = psOpenGroup(i, char, next);
    if (opened >= 0) return opened;
    if (char === ")" || char === "}") {
      if (code === root && !firstOnly) stray = true;
    }
    if (code.closer === char) return psCloseGroup(i, char);
    if (char === ")") return closeParen(i);
    if (char === "}") {
      endCommand();
      return i + 1;
    }
    if (char === "|") return pipe(i);
    if (char === ";") {
      endCommand();
      return i + 1;
    }
    if (char === "&") return ampersand(i);
    if (char === ",") return psListBreak(i);
    return plain(PLAIN_RUN.powershell, i);
  }

  // A comma ends the word, which goes on a list with the next one (see copyItemArgs).
  function psListBreak(i) {
    endWord();
    const { words } = code.command;
    if (words.length) words[words.length - 1].listed = true;
    return pastListBreak(i + 1);
  }

  function psBacktick(i, next) {
    if (next === "\n") return i + 2;
    if (next === "\r" && text[i + 2] === "\n") return i + 3;
    // A backtick that ends the text is a letter.
    if (next === undefined) {
      add("`", i);
      return i + 1;
    }
    add(next, i, true);
    return i + 2;
  }

  // A here-string, or a group that opens at `i`: where reading goes on, or -1 for neither.
  function psOpenGroup(i, char, next) {
    const quoteNext = next !== undefined && (PS_SINGLE_QUOTES + PS_DOUBLE_QUOTES).includes(next);
    if (char === "@" && code.word === null && quoteNext) {
      let j = i + 2;
      while (j < n && text[j] !== "\n" && BLANK.test(text[j])) j += 1;
      if (j < n && text[j] === "\n") return hereString(i, j);
    }
    if ((char === "$" || char === "@") && next === "(") {
      add(char, i);
      pushCode(")", i + 1);
      return i + 2;
    }
    if (char === "@" && next === "{") {
      add(char, i);
      pushCode("}", i + 1);
      return i + 2;
    }
    if (char === "(") {
      pushCode(")", i);
      return i + 1;
    }
    if (char === "{") {
      pushCode("}", i);
      return i + 1;
    }
    return -1;
  }

  // Closes the group `char` closes. Where the group starts its word, a token ends after it.
  function psCloseGroup(i, char) {
    const { at } = code;
    let end;
    if (char === ")") end = closeParen(i);
    else {
      closeCode();
      end = i + 1;
    }
    const { word } = code;
    if (!word) return end;
    const startsWord = word.start === at || (word.start === at - 1 && "$@".includes(text[word.start]));
    if (startsWord) tokenEnd = end;
    return end;
  }

  // Whether a PowerShell token starts at `i`, where a `#` starts a comment: at a word's start, where a group
  // that starts a word ends (`(Get-Date)# note`), and, in an expression, past a value (`$x = 1# note`,
  // `$x.Name# note`). Glued to an argument's other text it's a letter (`a#b`, `$x#y`).
  function psTokenStarts(i) {
    const { word } = code;
    if (word === null || i === tokenEnd) return true;
    if (word.memberEnd === undefined) word.memberEnd = matchEnd(PS_MEMBER_VALUE, word.start);
    if (word.memberEnd === i) return true;
    // An expression is a command that starts with a value, up to a command's name (`$x = gc a, $y#b`, where
    // `$y#b` is an argument), and not one `&` calls.
    const { command } = code;
    const { words } = command;
    const commandStart = words.length ? words[0].start : word.start;
    if (command.called || !/[$\d]/.test(text[commandStart])) return false;
    // Each word is looked at once (`named`: one is a command's name).
    if (!command.namesSeen) command.namesSeen = 0;
    for (; command.namesSeen < words.length; command.namesSeen += 1) {
      if (/^[\p{L}_.\\]/u.test(words[command.namesSeen].value)) command.named = true;
    }
    if (command.named) return false;
    if (word.valueEnd === undefined) word.valueEnd = matchEnd(PS_EXPRESSION_VALUE, word.start);
    return word.valueEnd === i;
  }

  // Where a sticky `pattern` matched from `from` ends, or -1.
  function matchEnd(pattern, from) {
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    return match ? from + match[0].length : -1;
  }

  // Where the `--%` that starts at `i` ends, as PowerShell reads it with its backticks (`` `--% ``), or -1.
  function psStopsParsing(i) {
    let j = i;
    let token = "";
    while (token.length < 3 && j < n) {
      if (text[j] === "`" && j + 1 < n && !/[\r\n]/.test(text[j + 1])) {
        token += text[j + 1];
        j += 2;
      } else {
        token += text[j];
        j += 1;
      }
    }
    return token === "--%" && (j >= n || /[\s|]/.test(text[j])) ? j : -1;
  }

  // A list goes on past the end of a line after a comma, and past a comment there.
  function pastListBreak(from) {
    let j = from;
    while (j < n) {
      if (/\s/.test(text[j])) {
        j += 1;
        continue;
      }
      const lineComment = text[j] === "#";
      if (!lineComment && !(text[j] === "<" && text[j + 1] === "#")) break;
      const end = lineComment ? text.indexOf("\n", j) : text.indexOf("#>", j + 2);
      if (end < 0) return n;
      j = lineComment ? end : end + 2;
    }
    return j;
  }

  // After --%, PowerShell passes the rest of the line up to a `|` to the program as it's written: `#`, `;`
  // and single quotes are letters there. The program splits it at blank space outside double quotes.
  function stopParsing(from) {
    let j = from;
    let quoted = false;
    while (j < n && text[j] !== "\n" && (quoted || text[j] !== "|")) {
      const char = text[j];
      if (char === '"') {
        quoted = !quoted;
        startWord(j, true);
      } else if (!quoted && BLANK.test(char)) endWord();
      else add(char, j);
      if (code.word !== null) code.word.end = j + 1;
      j += 1;
    }
    endWord();
    // Its words' ends are set above, as the step reads more than one.
    touched = null;
    return j;
  }

  function psDouble(i) {
    const char = text[i];
    if (PS_DOUBLE_QUOTES.includes(char)) {
      if (i + 1 < n && PS_DOUBLE_QUOTES.includes(text[i + 1])) {
        add(text[i + 1], i);
        return i + 2;
      }
      touched = code.word;
      if (frames.pop().fresh) endWord();
      return i + 1;
    }
    if (char === "`" && quote === "literal") {
      add(char, i);
      return i + 1;
    }
    if (char === "`") {
      const next = text[i + 1];
      if (next === undefined) return i + 1;
      if (next === "u" && text[i + 2] === "{") {
        const end = text.indexOf("}", i + 3);
        const hex = end < 0 ? "" : text.slice(i + 3, end);
        if (/^[0-9a-f]{1,6}$/i.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
          add(String.fromCodePoint(parseInt(hex, 16)), i);
          return end + 1;
        }
      }
      add(psEscaped(next), i);
      return i + 2;
    }
    if (char === "$" && text[i + 1] === "{") return psBraced(i);
    if (char === "$") return dollar(i);
    return plain(DOUBLE_RUN.powershell, i);
  }

  // ---------- cmd code ----------

  function cmdCode(i) {
    const char = text[i];
    if (char === "\n") {
      endCommand();
      return i + 1;
    }
    if (BLANK.test(char) || char === "," || char === ";" || char === "=") {
      endWord();
      return i + 1;
    }
    if (char === "^") return cmdCaret(i);
    if (char === '"') {
      // A quote ends at the next `"`, or where its line ends, since cmd reads a line at a time.
      CMD_QUOTE_END.lastIndex = i + 1;
      const found = CMD_QUOTE_END.exec(text);
      const stop = found ? found.index : n;
      add(text.slice(i + 1, stop), i, true);
      return text[stop] === '"' ? stop + 1 : stop;
    }
    // `in(`, `do(` and `else(`: the word before the `(` is a word of its own.
    const word = code.word;
    const keywordBefore = word !== null && !word.partQuoted && word.value.length <= 4;
    if (char === "(" && keywordBefore && /^(?:in|do|else)$/i.test(word.value)) endWord();
    const inSet = cmdForSet(i, char);
    if (inSet >= 0) return inSet;
    // A `(` opens a block where a command starts (and anywhere after an `if` glued to its condition,
    // `if(1)==(1)`); among the arguments it's text: `type a ( .env )`.
    if (char === "(" && code.word === null) {
      const { command } = code;
      const { words } = command;
      const ifGlued = /^@*if\(/i.test(words.length ? words[0].value : "");
      if (words.length === command.start || ifGlued) pushCode(")", i);
      else add("(", i);
      return i + 1;
    }
    if (char === ")") return closeParen(i);
    if (char === "|") return pipe(i);
    if (char === "&") return ampersand(i);
    if (char === "<") return lessThan(i);
    return plain(PLAIN_RUN.cmd, i);
  }

  function cmdCaret(i) {
    const next = text[i + 1];
    if (next === "\n") return i + 2;
    // A blank, `,`, `;` or `=` after it still splits the words: cmd hands the line on with the `^` taken off.
    if (next !== undefined && (BLANK.test(next) || next === "," || next === ";" || next === "=")) {
      endWord();
      return i + 2;
    }
    add(next === undefined ? "" : next, i, true);
    return i + 2;
  }

  // A `for`'s set is text up to its first `)`, which ends the word: `for /f %i in (.env)do`. Where reading
  // goes on, or -1 when `char` is no part of a set's brackets.
  function cmdForSet(i, char) {
    const { command } = code;
    if (char === "(" && command.forState === "set" && !command.setOpen) {
      command.setOpen = true;
      command.setFrom = command.words.length;
      add("(", i);
      return i + 1;
    }
    if (char === "(" && command.setOpen) {
      add("(", i);
      return i + 1;
    }
    if (char === ")" && command.setOpen) {
      add(")", i);
      endWord();
      command.setOpen = false;
      command.forState = "done";
      command.sets.push({ from: command.setFrom, to: command.words.length, lines: command.forLines });
      return i + 1;
    }
    return -1;
  }

  // ---------- Reading the text ----------

  function codeStep(i) {
    if (dialect === "bash") return bashCode(i);
    if (dialect === "powershell") return psCode(i);
    return cmdCode(i);
  }

  // One step from `i`, read as the innermost frame `top` reads it.
  function readStep(i, top) {
    if (top.type === "dq") return dialect === "powershell" ? psDouble(i) : bashDouble(i);
    if (top.type === "param") return bashParam(i, top);
    if (top.type === "doc") return docText(i);
    return codeStep(i);
  }

  let i = start;
  let sinceDeadline = 0;
  while (i < n && !done) {
    const before = i;
    const top = frames[frames.length - 1];
    stepQuote = null;
    i = readStep(i, top);
    if (touched !== null) {
      touched.end = Math.min(i, n);
      touched = null;
    }
    if (watch) {
      // A quote's opening character isn't inside it.
      const inside = top.type === "dq" || top.type === "doc" ? "double" : stepQuote;
      while (watched < watch.at.length && watch.at[watched] < i) {
        watch.quotes[watched] = watch.at[watched] > before || top.type !== "code" ? inside : null;
        watched += 1;
      }
    }
    work.left -= i - before;
    sinceDeadline += i - before;
    if (work.left < 0) throw new ShellCheckTooLong();
    if (sinceDeadline >= 65536 && work.budget) {
      sinceDeadline = 0;
      checkShellDeadline(work.budget);
    }
  }
  // Text that ends inside a quote or a `(…)` is one the shell won't run as read here.
  const unclosed = frames.length > 1 || i > n;
  if (!done) {
    // A group left open goes on to the text's end, and so do the words it sits in.
    while (code !== root) {
      if (code.word !== null) code.word.end = n;
      closeCode();
      code.word.end = n;
    }
    frames.length = 1;
    endCommand();
  }
  return { commands, first, unclosed, stray, textOnly };
}

module.exports = {
  SHELL_GROUP_DEPTH,
  SHELL_FILTER_WORD,
  SHELL_FILTER_INPUT,
  SHELL_PARSE_STEPS_PER_CHAR,
  SHELL_PARSE_MIN_STEPS,
  BLANK,
  PS_SINGLE_QUOTES,
  PS_DOUBLE_QUOTES,
  PS_ESCAPES,
  ANSI_C_ESCAPES,
  PLAIN_RUN,
  DOUBLE_RUN,
  PS_SINGLE_RUN,
  PROSE_LETTER,
  PS_MEMBER_VALUE,
  PS_EXPRESSION_VALUE,
  PARAM_RUN,
  PARAM_OPERATOR,
  FUNCTION_LEAD_WORDS,
  parseShellCommands,
};

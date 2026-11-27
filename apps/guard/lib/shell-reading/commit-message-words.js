"use strict";
/* global require, module */

const {
  SHELL_PARSE_STEPS_PER_CHAR,
  SHELL_PARSE_MIN_STEPS,
  PS_SINGLE_QUOTES,
  PS_DOUBLE_QUOTES,
  parseShellCommands,
} = require("./command-line-parser.js");
const { SHELL_WRAPPER_WORD } = require("./nested-commands.js");

// ---------- Commit message removal ----------

// git's options before its command that take the next word as their value: `git -C src commit`.
const GIT_VALUE_OPTION = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)$/;
// git commit's long options that take the next word as their value, when it isn't glued on with `=`.
const COMMIT_VALUE_OPTION = new RegExp(
  `^(?:${[
    "--file",
    "--template",
    "--author",
    "--date",
    "--reuse-message",
    "--reedit-message",
    "--fixup",
    "--squash",
    "--cleanup",
    "--trailer",
    "--pathspec-from-file",
  ].join("|")})$`,
);
// git commit's short options that take a value: `-m` the message, the others a file, a commit or a key.
const COMMIT_SHORT_VALUE = /[mCcFtSu]/;
// The short options among them whose value may be the next word; `-S` and `-u` take one only glued on.
const COMMIT_SHORT_NEXT_VALUE = "mCcFt";

// The words of a `git commit` that hold its message: the word after `-m`, `--message` or a cluster ending in
// m (`-am`), and one with the message glued on (`-m"…"`, `--message=…`, `-amtext`). Null when the command
// isn't one.
function commitMessageWords(words, dialect) {
  let index = commandNameIndex(words, dialect);
  if (index >= words.length) return null;
  const name = dialect === "cmd" ? words[index].value.replace(/^@+/, "") : words[index].value;
  if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(name)) return null;
  for (index += 1; index < words.length && /^-/.test(words[index].value); index += 1) {
    if (GIT_VALUE_OPTION.test(words[index].value)) index += 1;
  }
  if (index >= words.length || words[index].value !== "commit") return null;
  const messages = [];
  for (index += 1; index < words.length; index += 1) {
    const { value } = words[index];
    if (value === "--") break;
    if (value.startsWith("--message=")) messages.push(words[index]);
    else if (value === "--message") {
      index += 1;
      if (index < words.length) messages.push(words[index]);
    } else if (COMMIT_VALUE_OPTION.test(value)) index += 1;
    else if (/^-[A-Za-z]/.test(value)) {
      // A cluster of short options: the first that takes a value takes the rest of the word, or the next
      // word.
      const at = value.slice(1).search(COMMIT_SHORT_VALUE) + 1;
      if (at === 0 || at + 1 < value.length) {
        if (at > 0 && value[at] === "m") messages.push(words[index]);
      } else if (COMMIT_SHORT_NEXT_VALUE.includes(value[at])) {
        index += 1;
        if (index < words.length && value[at] === "m") messages.push(words[index]);
      }
    }
  }
  return messages;
}

// Where the command's name is, past the variables set for it, a wrapper such as `sudo`, PowerShell's `&` or
// cmd's `@`.
function commandNameIndex(words, dialect) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word.partQuoted) break;
    const setsVariable = dialect === "bash" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value);
    const wrapper = SHELL_WRAPPER_WORD.test(word.value) || (dialect === "powershell" && word.value === "&");
    if (!setsVariable && !wrapper) break;
    index += 1;
  }
  return index;
}

// The end word of a here-document marker at `at`, when some of it is quoted (`'EOF'`, `"EOF"`, `\EOF`,
// `E"O"F`), so the shell expands nothing in the body. Returns the word as the shell compares it and where it
// stops, or null.
function quotedEndWord(text, at, end) {
  let word = "";
  let quoted = false;
  let i = at;
  while (i < end && !/[\s;&|<>()]/.test(text[i])) {
    const char = text[i];
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, i + 1);
      if (close < 0 || close >= end) return null;
      const inside = text.slice(i + 1, close);
      if (char === '"' && /[$`\\]/.test(inside)) return null;
      word += inside;
      quoted = true;
      i = close + 1;
    } else if (char === "\\") {
      if (i + 1 >= end || text[i + 1] === "\n") return null;
      word += text[i + 1];
      quoted = true;
      i += 2;
    } else if (/[A-Za-z0-9_.+-]/.test(char)) {
      word += char;
      i += 1;
    } else return null;
  }
  if (!quoted || word === "" || /\s/.test(word)) return null;
  return { word, stop: i };
}

// Where `$(cat <<'EOF'` ⏎ body ⏎ `EOF` ⏎ `)` ends when it starts at `at` (its `$`) and ends before `end`, or
// -1. It prints only its body, as the end word is quoted and cat has no file. Anything else in the `$( )`, a
// line ending other than a bare line break, or a body line that starts with the end word and goes on, isn't
// this form.
function quotedCatHeredocEnd(text, at, end) {
  const head = /^\$\([ \t]*cat[ \t]+<<(-?)[ \t]*/.exec(text.slice(at, Math.min(end, at + 64)));
  if (!head) return -1;
  const marker = quotedEndWord(text, at + head[0].length, end);
  if (!marker) return -1;
  let line = marker.stop;
  while (line < end && (text[line] === " " || text[line] === "\t")) line += 1;
  if (text[line] !== "\n") return -1;
  const tabs = head[1] === "-";
  for (let from = line + 1; from < end;) {
    const to = text.indexOf("\n", from);
    if (to < 0 || to >= end) return -1;
    const body = tabs ? text.slice(from, to).replace(/^\t+/, "") : text.slice(from, to);
    // Bash also ends it at a line like `EOF)`, and then runs what follows, so a line that only starts with
    // the end word isn't this form.
    if (body !== marker.word && body.startsWith(marker.word)) return -1;
    if (body === marker.word) return closingParenAfter(text, to + 1, end);
    from = to + 1;
  }
  return -1;
}

// Past the `)` after only blank space from `from`, or -1.
function closingParenAfter(text, from, end) {
  let at = from;
  while (at < end && /[ \t\n]/.test(text[at])) at += 1;
  return at < end && text[at] === ")" ? at + 1 : -1;
}

// What each shell quotes and escapes with, where a message word's quoted text is marked.
const MESSAGE_QUOTES = {
  bash: { singles: "'", doubles: '"', escape: "\\" },
  powershell: { singles: PS_SINGLE_QUOTES, doubles: PS_DOUBLE_QUOTES, escape: "`" },
  cmd: { singles: "", doubles: '"', escape: "^" },
};

// Marks in `blank` the letters of a message word, written from `at` to `end`, that sit inside its quotes: the
// shell hands them to git as text. In a double quote, a `$(…)`, `${…}` or backtick runs before git sees the
// text, so from the first one on nothing of the word is marked. With `heredocs`, when Bash is the only shell
// that could run it, the one `$( )` read as text is `$(cat <<'EOF'` … `EOF` ⏎ `)`, which prints its body as
// it's written. Letters outside quotes are left as they are.
function markQuotedText(text, at, end, dialect, blank, heredocs) {
  const { singles, doubles, escape } = MESSAGE_QUOTES[dialect === "powershell" || dialect === "bash" ? dialect : "cmd"];
  if (dialect === "powershell" && text[at] === "@") return;
  let i = at;
  while (i < end) {
    const char = text[i];
    if (char === escape) {
      i += 2;
      continue;
    }
    if (singles.includes(char)) {
      const close = singleQuoteEnd(text, i + 1, end, dialect, singles);
      if (close >= end) return;
      blank.fill(1, i + 1, close);
      i = close + 1;
      continue;
    }
    if (doubles.includes(char)) {
      const close = doubleQuoteEnd(text, i + 1, end, dialect, doubles, heredocs);
      // A cmd quote that its line's end closed: what's before that is still the quote's text.
      if (dialect === "cmd" && close >= 0 && !doubles.includes(text[close] || "")) {
        blank.fill(1, i + 1, close);
        i = close;
        continue;
      }
      if (close < 0 || close >= end) return;
      // PowerShell writes a double quote inside one as two.
      if (dialect === "powershell" && doubles.includes(text[close + 1] || "")) {
        blank.fill(1, i + 1, close + 1);
        i = close + 1;
        continue;
      }
      blank.fill(1, i + 1, close);
      i = close + 1;
      continue;
    }
    if (dialect !== "cmd" && runsCommand(text, i)) return;
    i += 1;
  }
}

// Where the single quote opened before `from` closes; PowerShell writes a single quote inside one as two.
function singleQuoteEnd(text, from, end, dialect, singles) {
  const doubled = dialect === "powershell";
  let at = from;
  while (at < end) {
    const isQuote = singles.includes(text[at]);
    if (isQuote && !(doubled && singles.includes(text[at + 1]))) break;
    at += doubled && isQuote ? 2 : 1;
  }
  return at;
}

// Where the double quote opened before `from` closes, past a quoted `cat` here-document (see
// quotedCatHeredocEnd); -1 where a `$(…)`, `${…}` or backtick inside it runs.
function doubleQuoteEnd(text, from, end, dialect, doubles, heredocs) {
  let at = from;
  while (at < end && !doubles.includes(text[at])) {
    // In cmd a quote ends where its line ends.
    if (dialect === "cmd" && (text[at] === "\n" || text[at] === "\r")) break;
    const heredocEnd = heredocs && text[at] === "$" ? quotedCatHeredocEnd(text, at, end) : -1;
    if (heredocEnd > 0) {
      at = heredocEnd;
      continue;
    }
    if (dialect !== "cmd" && runsCommand(text, at)) return -1;
    if (dialect === "bash" && text[at] === "\\") at += 1;
    at += 1;
  }
  return at;
}

// A backtick, `$(` or `${` at `at`: text the shell runs or expands before git sees it.
function runsCommand(text, at) {
  if (text[at] === "`") return true;
  return text[at] === "$" && /[({]/.test(text[at + 1] || "");
}

// The command with the quoted text of every `git commit` message turned to spaces, for the shells in
// `dialects` to read: git stores that text, so a reader's name in it runs nothing. A letter is turned only
// where every shell that could run the command takes it as quoted message text, and the command is left whole
// where one can't be read. Line breaks stay, so each line is where it was. `budget` is the shell check's, for
// its deadline. With `firstLineOnly`, for Cursor, whose terminal can be cmd, only a message word's first line
// is turned: cmd reads each later line as a command of its own.
function withoutCommitMessages(command, dialects, budget, firstLineOnly) {
  if (!/git/i.test(command) || !/commit/i.test(command)) return command;
  let blank = null;
  // In cmd a line break ends the command, so a here-document's body lines could run there.
  const onlyBash = dialects.length === 1 && dialects[0] === "bash";
  try {
    for (const dialect of dialects) {
      const marks = messageMarks(command, dialect, dialects, budget, { onlyBash, firstLineOnly });
      if (marks === undefined) continue;
      if (marks === null) return command;
      if (blank) for (let i = 0; i < blank.length; i += 1) blank[i] &= marks[i];
      else blank = marks;
    }
  } catch {
    return command;
  }
  if (!blank || !blank.includes(1)) return command;
  let out = "";
  for (let i = 0; i < command.length; i += 1) {
    out += blank[i] && !/[\r\n\u2028\u2029]/.test(command[i]) ? " " : command[i];
  }
  return out;
}

// One shell's marks: 1 for each letter it takes as quoted message text. Undefined where PowerShell is left
// out, null where the command can't be read.
function messageMarks(command, dialect, dialects, budget, { onlyBash, firstLineOnly }) {
  const work = { left: SHELL_PARSE_MIN_STEPS + SHELL_PARSE_STEPS_PER_CHAR * command.length, budget };
  const { commands, unclosed, stray } = parseShellCommands(command, dialect, work);
  // PowerShell runs nothing of text it can't parse, so where another shell could run it, it's left out.
  if (dialect === "powershell" && dialects.length > 1 && (unclosed || stray)) return undefined;
  if (unclosed) return null;
  const marks = new Uint8Array(command.length);
  for (const each of commands) {
    for (const word of commitMessageWords(each.words, dialect) || []) {
      markQuotedText(command, word.start, word.end, dialect, marks, onlyBash);
      if (firstLineOnly) marks.fill(0, firstLineEnd(command, word.start, word.end), word.end);
    }
  }
  return marks;
}

// Where the first line of the text from `at` to `end` ends: at its first line break, or at `end`.
function firstLineEnd(text, at, end) {
  let i = at;
  while (i < end && text[i] !== "\n" && text[i] !== "\r") i += 1;
  return i;
}

module.exports = {
  withoutCommitMessages,
};

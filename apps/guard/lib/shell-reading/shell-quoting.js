"use strict";
/* global module, process */

// ---------- What the shell does to a word ----------

// A word as the shell joins it, quoted parts and all (`"$HOME"/kj`, `'.e'nv`), without its quotes; null when
// no quote sits inside it. Guard's own reading splits a word at its quotes (see secretInShellReads), so this
// is read as well.
function joinedWords(text) {
  const words = text.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) || [];
  if (!words.some((word) => /["']/.test(word) && !/^(?:"[^"]*"|'[^']*')$/.test(word))) return null;
  return words.map((word) => word.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single));
}

// Whether a path starts with something the shell replaces that Guard can't read: a variable (`$X`, `%X%`), a
// command (`` `cmd` ``), or `~` (`~user`), and on Windows a leading single slash, which Git Bash, maybe
// Cursor's shell, opens as a path of its own (`/c/...`, `/tmp/../c/...`) that Guard doesn't read everywhere.
// What it opens isn't known, so a credentials folder named through it is judged by name.
function shellReplacesPart(value) {
  const text = String(value);
  return /[$%`]|^\s*['"]?~/.test(text) || (process.platform === "win32" && /^\s*['"]?\/(?!\/)/.test(text));
}

// A character a shell's escape makes literal (`\.`, `` `. ``, `^.`), written so Guard's reading of words
// keeps it so: as itself where no shell gives it a meaning to Guard (a backslash is a path's separator to
// it), else quoted. A character that ends a command (`;`, `&`, `|`, a bracket, a redirection or a backtick)
// ends Guard's reading of a reader's words even quoted, so it's written as `_`: no secret file's name has
// one.
function literalCharacter(char) {
  if (/[\w.\-/\\,:+@=]/.test(char)) return char;
  if (/[;&|()<>`]/.test(char)) return "_";
  return char === "'" ? `"'"` : `'${char}'`;
}

// ---------- Bash's ANSI-C quoting ----------

// The one-letter escapes of Bash's ANSI-C quoting.
const ANSI_C_SIMPLE = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

// Bash's ANSI-C quoting (`$'.e\x6ev'`) decoded from just past its `$'`: the text and the index of its closing
// quote.
function ansiCQuoted(command, start) {
  let decoded = "";
  let at = start;
  while (at < command.length && command[at] !== "'") {
    if (command[at] !== "\\" || at + 1 >= command.length) {
      decoded += command[at];
      at += 1;
      continue;
    }
    const rest = command.slice(at + 1, at + 10);
    const code =
      /^x([0-9a-f]{1,2})/i.exec(rest) ||
      /^U([0-9a-f]{1,8})/.exec(rest) ||
      /^u([0-9a-f]{1,4})/.exec(rest) ||
      /^([0-7]{1,3})/.exec(rest);
    if (code) {
      const value = parseInt(code[1], /^[0-7]+$/.test(code[0]) ? 8 : 16);
      decoded += value <= 0x10ffff ? String.fromCodePoint(value) : "";
      at += 1 + code[0].length;
    } else if (rest[0] === "c" && rest.length > 1 && rest[1] !== "'") {
      decoded += String.fromCharCode(rest.charCodeAt(1) & 31);
      at += 3;
    } else {
      decoded += ANSI_C_SIMPLE[rest[0]] ?? rest[0];
      at += 2;
    }
  }
  return { text: decoded, end: at };
}

// ---------- Here-docs, backticks and braced names ----------

// A Bash here-doc's delimiter word, read from just past its `<<` or `<<-` and the blanks after it, as Bash
// reads it: up to a blank or an operator, with its quotes and backslashes taken off (`E\OF`, `E"O"F`,
// `'EOF'x`) and `$'...'` decoded. A `$` or a backtick in it is kept as written, as Bash doesn't expand them
// there. The word and where it ends.
function hereDocWord(command, start) {
  let word = "";
  let at = start;
  while (at < command.length && !/[ \t\n;&|()<>]/.test(command[at])) {
    const char = command[at];
    if (char === "\\") {
      word += command[at + 1] === "\n" ? "" : (command[at + 1] ?? "");
      at += 2;
    } else if (char === "'") {
      const close = command.indexOf("'", at + 1);
      const end = close < 0 ? command.length : close;
      word += command.slice(at + 1, end);
      at = end + 1;
    } else if (char === "$" && command[at + 1] === "'") {
      const { text, end } = ansiCQuoted(command, at + 2);
      word += text;
      at = end + 1;
    } else if (char === '"' || (char === "$" && command[at + 1] === '"')) {
      at += char === "$" ? 2 : 1;
      while (at < command.length && command[at] !== '"') {
        if (command[at] === "\\" && /[$`"\\\n]/.test(command[at + 1] ?? "")) at += 1;
        word += command[at] === "\n" && command[at - 1] === "\\" ? "" : command[at];
        at += 1;
      }
      at += 1;
    } else if (char === "`") {
      const close = command.indexOf("`", at + 1);
      const end = close < 0 ? command.length : close + 1;
      word += command.slice(at, end);
      at = end;
    } else {
      word += char;
      at += 1;
    }
  }
  return { word, end: Math.min(at, command.length) };
}

// The command a Bash backtick holds, from just past it, and where it ends: at the next backtick an escape
// doesn't take, whatever quotes are in it. Bash takes a backslash off before `$`, a backtick or `\` (and `"`,
// in a double quote), also in a quote there, so `` `cat .e\\nv` `` opens `.env`, and a backtick left that way
// starts a command inside it (`` `a \`b\`` ``).
function backtickCommand(command, start, inDouble) {
  let text = "";
  let at = start;
  while (at < command.length && command[at] !== "`") {
    const next = command[at + 1];
    if (command[at] === "\\" && next !== undefined) {
      text += /[$`\\]/.test(next) || (inDouble && next === '"') ? next : `\\${next}`;
      at += 2;
    } else {
      text += command[at];
      at += 1;
    }
  }
  return { text, end: at };
}

// Where a PowerShell `${...}` name that starts at `start` ends: at the first `}` its backtick doesn't take,
// or -1.
function bracedVariableEnd(command, start) {
  for (let at = start; at < command.length; at += 1) {
    if (command[at] === "`") at += 1;
    else if (command[at] === "}") return at;
  }
  return -1;
}

// Where each of a command's lines last starts, by its text without a trailing `\r`, and (after a NUL) without
// its leading tabs too, so a here-doc's delimiter line is found without reading the command again.
function lineStarts(command) {
  const starts = new Map();
  for (let at = 0; ;) {
    const found = command.indexOf("\n", at);
    const line = command.slice(at, found < 0 ? command.length : found).replace(/\r$/, "");
    starts.set(line, at);
    starts.set(`\0${line.replace(/^\t+/, "")}`, at);
    if (found < 0) return starts;
    at = found + 1;
  }
}

// Where a here-doc's body ends: past the line that is its delimiter, for each here-doc started on the line
// before `start`, in turn (`<<-` lets the line start with tabs). A line's `\r` is left out on both sides, so
// a body is never taken to run on past a line Bash may end it at. -1 if one never ends: then no body is
// skipped, as a here-doc Guard misread could otherwise hide the rest of the command.
function hereDocsEnd(command, start, hereDocs, starts) {
  let at = start;
  for (const { word, tabs } of hereDocs) {
    const delimiter = word.replace(/\r$/, "");
    if (!(starts.get(tabs ? `\0${delimiter}` : delimiter) >= at)) return -1;
    for (;;) {
      if (at >= command.length) return command.length;
      const found = command.indexOf("\n", at);
      const end = found < 0 ? command.length : found;
      let line = command.slice(at, end).replace(/\r$/, "");
      if (tabs) line = line.replace(/^\t+/, "");
      at = end + 1;
      if (line === delimiter) break;
    }
  }
  return Math.min(at, command.length);
}

// ---------- Reading a command's escapes and quotes ----------

// The escapes, quoting, comments and here-documents each shell reads: Bash's backslash (literal in single
// quotes, and in double quotes only before `$`, a backtick, `"`, `\` or a line break), its `$'...'` and
// `$"..."`, `#` comments and `<<WORD` here-docs; PowerShell's backtick (literal in single quotes), its ``
// `u{...} `` escape, `#` and `<# ... #>` comments and `@'...'@` here-strings; cmd's caret (literal in double
// quotes, and cmd has no single quotes). A `#` starts a comment after one of `wordEnds` (Bash's blanks and
// operators: a `\r`, `\v` or no-break space isn't one; any blank, bracket or separator in PowerShell, which
// also ends a word at a closing quote), up to one of `commentEnds` (Bash's comment runs past a `\r`). In a
// double quote, `nests` opens a command or variable (`"$(...)"`, Bash's `"${...}"`) whose own quotes pair
// inside it. Bash's `backticks` hold a command read on its own, and PowerShell's `bracedVariables` (`${...}`)
// a name. PowerShell can't parse a `<` starting a word outside a string or comment (`reservedLess`: it's
// reserved, though `--%` passes the rest of its line on as written), so it runs nothing of such a command (a
// Bash here-doc's `cat <<'EOF'`). PowerShell's `heldQuotes`: see unescapedCommand.
const SHELL_ESCAPES = {
  bash: {
    escape: "\\",
    singleQuotes: true,
    doubleEscapes: /[$`"\\\n\r]/,
    dollarQuotes: true,
    comments: true,
    hereDocs: true,
    wordEnds: /[ \t\n;&|()<>`]/,
    commentEnds: /\n/,
    nests: /^\$[({]/,
    backticks: true,
  },
  powershell: {
    escape: "`",
    singleQuotes: true,
    doubleEscapes: /[^]/,
    unicodeEscapes: true,
    comments: true,
    blockComments: true,
    hereStrings: true,
    wordEnds: /[\s;&|(){},=]/,
    commentEnds: /[\r\n]/,
    quotesEndWords: true,
    nests: /^\$\(/,
    bracedVariables: true,
    reservedLess: true,
    heldQuotes: true,
  },
  cmd: { escape: "^", singleQuotes: false, doubleEscapes: null },
};

// A command with one shell's escapes and quoting read (see SHELL_ESCAPES), so `cat .e\nv`, `` gc `.env ``,
// `type .e^nv` and `cat $'.env'` name `.env`. An escape before a line break joins the lines. With the shell's
// `comments`, a comment starts with a `#` at a word's start outside `${...}`; it's kept as it is written,
// with no quotes or escapes read in it, so the command before it keeps its words. PowerShell's `<# ... #>`,
// at a word's start, is left out, as is a here-doc's body (`hereDocs`, not after a third `<`, in `${...}` or
// where `<<` is a shift) or a here-string's (`hereStrings`, at a word's start): they hold text, not commands.
// A here-doc's body isn't skipped in a backtick's command or when its delimiter line never comes. With
// `lineReset`, a quote still open at a line break is ended there, as a quote the shell doesn't pair would
// otherwise put every later line inside it, and an escaped line break in a quote or after a `#` that may
// start a comment ends the line; with `heldQuotes` too, a quote ended so that closes later (a multi-line
// message, a here-string) keeps its text as written up to there, quotes and escapes, so a Markdown code span
// in it isn't read as escapes. With `reservedLess`, null if a `<` starting a word is read outside a string or
// comment (other than one starting `<#`, or after `--%` on its line): the shell won't run the command. Linear
// in the command's length.
function unescapedCommand(command, options) {
  const { escape, singleQuotes, doubleEscapes, dollarQuotes, unicodeEscapes, lineReset } = options;
  const wordEnds = options.wordEnds || /[\s;&|(]/;
  let out = "";
  let quote = "";
  let comment = "";
  let wordStart = true;
  let braces = 0;
  let shifts = 0;
  let opener = "";
  let shiftBraces = 0;
  let maybeComment = false;
  let commentText = false;
  let maybeBlock = false;
  // With `heldQuotes`, where a quote `lineReset` ended at a line break would close if it ran on: up to there,
  // its text is kept as written, as the reading without `lineReset` keeps it in the quote.
  let quoteAt = -1;
  let heldEnd = -1;
  const heldFails = { "'": Infinity, '"': Infinity };
  // After PowerShell's `--%`, the rest of the line (to a `|`) is passed on as written, `<` and all.
  let stopParsing = false;
  let starts = null;
  let hereDocs = [];
  // The commands and variables open in a double quote (and those open in them), innermost last, each with its
  // closer, how deep its own brackets are, the quote it returns to and the reading's state outside it. Bash
  // ends a `${...}` at its first `}` that isn't another `${...}`'s.
  const nested = [];
  let arithmeticNests = 0;
  let bracedFails = Infinity;
  // Where the next character is, past any escaped line breaks Bash takes out before it reads a word.
  function past(at) {
    let next = at;
    while (escape === "\\" && command[next] === "\\") {
      if (command[next + 1] === "\n") next += 2;
      else if (command[next + 1] === "\r" && command[next + 2] === "\n") next += 3;
      else break;
    }
    return next;
  }
  // A word's first six characters, past escaped line breaks, to tell a keyword (`ca\` then `se` is `case`).
  function wordAt(at) {
    let word = "";
    for (let next = past(at); next < command.length && word.length < 6; next = past(next + 1)) {
      if (/[\s;&|()<>]/.test(command[next])) break;
      word += command[next];
    }
    return word;
  }
  // A word that starts where a `case` in a double-quoted command is being followed (see `cases` below): it
  // moves the case on from its subject to `in`, its patterns and its body, and ends it at `esac`.
  function followCaseWord(nest, state, at) {
    const { cases } = nest;
    const word = wordAt(at);
    if (state === "subject") cases[cases.length - 1] = "in";
    else if (state === "in" && word === "in") {
      cases[cases.length - 1] = "pattern";
      nest.patternStart = true;
    } else if (state === "pattern" && nest.patternStart && word === "esac") cases.pop();
    else if (state === "pattern") nest.patternStart = false;
    else if (nest.command && word === "case") cases.push("subject");
    else if (nest.command && state === "body" && word === "esac") cases.pop();
    nest.command = nest.command && /^(?:if|then|else|elif|do|while|until|time|!|\{)$/.test(word);
  }
  const arrayWord = /\(\(|\[|[A-Za-z_]\w*(?:\[|\+?=\()/y;
  function arrayStart(at) {
    arrayWord.lastIndex = at;
    return arrayWord.exec(command);
  }
  // Where the quote opened at `quoteAt` closes from `start` on (a here-string's at its `'@` line), or -1. A
  // search that finds none is remembered, so this stays linear.
  function quoteEnd(mark, start) {
    if (start >= heldFails[mark]) return -1;
    let end = -1;
    if (command[quoteAt - 1] === "@" && !/\S/.test(command.slice(quoteAt + 1, start - 1))) {
      const closing = new RegExp(`\\n[^\\S\\r\\n]*${mark}@`, "g");
      closing.lastIndex = start - 1;
      const found = closing.exec(command);
      end = found ? closing.lastIndex - 2 : -1;
    } else if (mark === "'") end = command.indexOf("'", start);
    else {
      for (let next = start; next < command.length && end < 0; next += 1) {
        if (command[next] === escape) next += 1;
        else if (command[next] === mark) end = next;
      }
    }
    if (end < 0) heldFails[mark] = start;
    return end;
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at];
    const lineBreak = char === "\n" || char === "\r";
    if (lineBreak) {
      maybeComment = false;
      commentText = false;
      stopParsing = false;
    }
    if (heldEnd >= 0 && at >= heldEnd) {
      const closing = at === heldEnd;
      heldEnd = -1;
      if (closing) {
        out += char;
        wordStart = Boolean(options.quotesEndWords);
        continue;
      }
    }
    if (maybeBlock && char === ">" && command[at - 1] === "#") maybeBlock = false;
    if (comment === "line" && (options.commentEnds || /[\r\n]/).test(char)) comment = "";
    if (comment === "line") {
      out += char;
      continue;
    }
    if (comment) {
      if (char === ">" && command[at - 1] === "#") {
        comment = "";
        wordStart = true;
      }
      continue;
    }
    if (lineReset && quote && lineBreak) {
      if (options.heldQuotes && !nested.length) heldEnd = quoteEnd(quote, at + 1);
      out += quote;
      quote = "";
    }
    if (char === "\n" && !quote && hereDocs.length) {
      if (!starts) starts = lineStarts(command);
      const end = hereDocsEnd(command, at + 1, hereDocs, starts);
      hereDocs = [];
      if (end >= 0) {
        out += "\n";
        at = end - 1;
        wordStart = true;
        continue;
      }
    }
    if (quote === "'") {
      out += char;
      if (char === "'") {
        quote = "";
        wordStart = Boolean(options.quotesEndWords);
      }
      continue;
    }
    if (char === escape && at + 1 < command.length && (!quote || doubleEscapes?.test(command[at + 1]))) {
      at += 1;
      const next = command[at];
      if (next === "\r" && command[at + 1] === "\n") at += 1;
      if (next === "\r" || next === "\n") {
        // With `lineReset`, an escaped line break in a quote, or after a `#` that may start a comment, where
        // the escape would be the comment's own text, ends the line too, so a quote or comment Guard misreads
        // can't take in the next line.
        if (lineReset && (quote || maybeComment)) {
          out += `${quote}\n`;
          quote = "";
          maybeComment = false;
          wordStart = true;
        }
        commentText = false;
        continue;
      }
      // After a `#` (not in `${...}`) or `<#` that may start a comment, up to the line's end or `#>`, an
      // escape is kept as written, as the reading with comments read keeps a comment's text, so a Markdown
      // code span there (`` # see `.env.example` docs ``) isn't read as escapes.
      if (!quote && (commentText || maybeBlock || heldEnd >= 0)) {
        out += escape + next;
        wordStart = false;
        continue;
      }
      const code = unicodeEscapes && next === "u" && /^\{([0-9a-f]{1,6})\}/i.exec(command.slice(at + 1, at + 9));
      const text = code ? codePointText(parseInt(code[1], 16)) : next;
      if (code) at += code[0].length;
      // In double quotes the text is kept as it is; a quote there is left out, as Guard's reading of words
      // can't hold one inside another.
      if (quote) out += text.replace(/"/g, "");
      else out += [...text].map(literalCharacter).join("");
      wordStart = false;
      continue;
    }
    // Bash's backtick runs to the next backtick an escape doesn't take, whatever quotes are in it (see
    // backtickCommand), and what it holds is read as a command of its own.
    if (options.backticks && char === "`") {
      const { text, end } = backtickCommand(command, at + 1, quote === '"');
      const inner = /[\\'"`$#({<]/.test(text)
        ? unescapedCommand(text, { ...options, hereDocs: false, closeQuotes: true })
        : text;
      out += `\`${inner}\``;
      at = end;
      wordStart = !quote;
      continue;
    }
    // PowerShell's `${...}` is a variable's name, whatever is in it up to a `}` its backtick doesn't take
    // (`${'}`).
    if (options.bracedVariables && char === "$" && command[at + 1] === "{" && at + 2 < bracedFails) {
      const close = bracedVariableEnd(command, at + 2);
      if (close < 0) bracedFails = at + 2;
      else {
        out += `\${${command.slice(at + 2, close).replace(/[^\w:\\/.~-]/g, "_")}}`;
        at = close;
        wordStart = false;
        continue;
      }
    }
    const nest = nested[nested.length - 1];
    // Bash takes out an escaped line break before it reads `$(` or `${` (`$\` then `(` on the next line).
    const second = char === "$" ? past(at + 1) : at;
    // In a command or variable a double quote holds, a `$` with one of Bash's special names (`$$(`) is read
    // as outside any quote (below), not as one that opens a command.
    const special = !quote && nest && char === "$" && /[$#?!@*0-9-]/.test(command[second] ?? "");
    const inPattern = nest && nest.cases[nest.cases.length - 1] === "pattern";
    if (!quote && nest && char === nest.closer && !nest.depth && !inPattern) {
      nested.pop();
      ({ braces, shifts, opener, shiftBraces, hereDocs } = nest.saved);
      if (nest.arithmetic) arithmeticNests -= 1;
      quote = nest.back;
      out += char;
      wordStart = !quote && wordEnds.test(char);
      continue;
    }
    const mayNest = !special && char === "$" && (quote === '"' || (!quote && nest));
    const opening = mayNest && options.nests?.exec(`$${command[second]}`);
    if (opening) {
      const closer = command[second] === "(" ? ")" : "}";
      const saved = { braces, shifts, opener, shiftBraces, hereDocs };
      const arithmetic = closer === ")" && command[past(second + 1)] === "(";
      nested.push({ closer, back: quote, depth: 0, saved, arithmetic, cases: [], command: true, patternStart: false });
      if (arithmetic) arithmeticNests += 1;
      braces = closer === "}" ? braces + 1 : 0;
      shifts = 0;
      hereDocs = [];
      quote = "";
      out += opening[0];
      at = second;
      wordStart = closer === ")";
      continue;
    }
    if (quote) {
      out += char;
      if (char === '"') {
        quote = "";
        wordStart = Boolean(options.quotesEndWords);
      }
      continue;
    }
    // With `cases`, a `case` in a command a double quote holds is read as Bash parses it, its patterns' `)`
    // (`a)`) not ending the command: spellingsOf adds this reading, as Guard can't always tell `case` is a
    // keyword. Bash takes `case` as a keyword where a command starts, `in` as the word after its subject, and
    // `esac` where a pattern or a command starts.
    if (options.cases && nest?.closer === ")") {
      const { cases } = nest;
      const state = cases[cases.length - 1];
      if (wordStart && !/[\s;&|()<>]/.test(char)) {
        followCaseWord(nest, state, at);
      } else if (
        state === "pattern" &&
        !nest.depth &&
        (char === ")" || (char === "(" && !/[@!?*+]/.test(command[at - 1])))
      ) {
        // A pattern's `)`, or the `(` it may start with (`(a)`); an extglob's `@(...)` is counted.
        if (char === ")") {
          cases[cases.length - 1] = "body";
          nest.command = true;
        }
        nest.patternStart = false;
        out += char;
        wordStart = true;
        continue;
      } else if (/[;&|\n(]/.test(char)) {
        nest.command = true;
        if (state === "body" && char === ";" && /[;&]/.test(command[at + 1] ?? "")) {
          cases[cases.length - 1] = "pattern";
          nest.patternStart = true;
        }
      }
    }
    if (nest?.closer === ")" && char === ")") nest.depth -= 1;
    else if (nest?.closer === ")" && char === "(") nest.depth += 1;
    // Where Bash reads `<<` as a shift, not a here-doc: `$((...))`, `((...))` (also after `if` or `for`),
    // `$[...]`, an array's subscript (`a[1<<2]=3`) and a list assigned to one (`a=([1<<2]=3)`). Each runs to
    // its closing bracket, not counting one in a `${...}` it holds.
    const shiftOpening = /^\$\(\(|^\$\[|^\(\(/.exec(command.slice(at, at + 3));
    const shift = options.hereDocs && !shifts && (shiftOpening || (wordStart && arrayStart(at)));
    if (shift) {
      opener = shift[0].slice(-1);
      shifts = opener === "(" && /\(\($/.test(shift[0]) ? 2 : 1;
      shiftBraces = braces;
      out += shift[0];
      at += shift[0].length - 1;
      wordStart = opener === "(";
      continue;
    }
    if (shifts && braces === shiftBraces && char === opener) shifts += 1;
    else if (shifts && braces === shiftBraces && char === (opener === "(" ? ")" : "]")) shifts -= 1;
    // A `$` with one of Bash's special names (`$$`, `$#`) isn't a `${` or a comment's `#`.
    if (char === "$" && /[$#?!@*0-9-]/.test(command[at + 1] ?? "")) {
      out += char + command[at + 1];
      at += 1;
      wordStart = false;
      continue;
    }
    if (options.comments && char === "#" && wordStart && !braces) {
      comment = "line";
      out += char;
      continue;
    }
    if (options.blockComments && char === "<" && command[at + 1] === "#" && wordStart) {
      comment = "block";
      out += " ";
      at += 1;
      continue;
    }
    if (options.hereDocs && !shifts && !braces && !arithmeticNests && char === "<" && command[at + 1] === "<") {
      // `<<<` is a here-string, its word on the same line.
      if (command[at + 2] === "<") {
        out += "<<<";
        at += 2;
        wordStart = true;
        continue;
      }
      let start = at + 2;
      const tabs = command[start] === "-";
      if (tabs) start += 1;
      while (command[start] === " " || command[start] === "\t") start += 1;
      if (start < command.length && !/[\n;&|()<>]/.test(command[start])) {
        const { word, end } = hereDocWord(command, start);
        hereDocs.push({ word, tabs });
        out += `<<${tabs ? "-" : ""}${[...word.replace(/\s/g, "_")].map(literalCharacter).join("")}`;
        at = end - 1;
        wordStart = false;
        continue;
      }
    }
    if (
      options.hereStrings &&
      char === "@" &&
      wordStart &&
      /^['"][^\S\r\n]*\r?\n/.test(command.slice(at + 1, at + 80))
    ) {
      const closing = new RegExp(`\\n[^\\S\\r\\n]*${command[at + 1]}@`, "g");
      closing.lastIndex = at + 2;
      const found = closing.exec(command);
      out += command[at + 1].repeat(2);
      at = found ? closing.lastIndex - 1 : command.length;
      wordStart = false;
      continue;
    }
    if (dollarQuotes && char === "$" && command[at + 1] === "'") {
      const { text, end } = ansiCQuoted(command, at + 2);
      out += `'${text.split("'").join(`'"'"'`)}'`;
      at = end;
      wordStart = false;
      continue;
    }
    if (dollarQuotes && char === "$" && command[at + 1] === '"') continue;
    // Where both shells surely start a token, so a `#` there starts a comment and PowerShell's `<` is an
    // error: not after `=` or `,`, the `)` of `$(...)` or a backtick, where it's part of a word (`a=#x`,
    // `$(echo a)#x`, `a<b`).
    const tokenStart = at === 0 || /[\s;&|({]/.test(command[at - 1]);
    if (char === "<" && command[at + 1] === "#" && wordStart && tokenStart && escape === "`") maybeBlock = true;
    const stopsParsing = wordStart && char === "-" && /^--%(?![^\s|])/.test(command.slice(at, at + 4));
    if (options.reservedLess && stopsParsing) stopParsing = true;
    else if (char === "|") stopParsing = false;
    const reservedLessThan = char === "<" && command[at + 1] !== "#" && tokenStart;
    if (options.reservedLess && reservedLessThan && !stopParsing && heldEnd < 0) return null;
    if (char === "$" && command[at + 1] === "{") braces += 1;
    else if (char === "}" && braces) braces -= 1;
    // A quote after a `#` or `<#` that may start a comment, or in a held quote's text, is kept as text, and
    // opens nothing.
    if ((char === '"' || (singleQuotes && char === "'")) && !commentText && !maybeBlock && heldEnd < 0) {
      quote = char;
      quoteAt = at;
    }
    if (char === "#" && wordStart && options.commentEnds) maybeComment = true;
    if (char === "#" && wordStart && tokenStart && !braces && options.commentEnds) commentText = true;
    out += char;
    wordStart = wordEnds.test(char);
  }
  // With `closeQuotes` (a backtick's command), a quote or a command still open at the end is closed, so the
  // command around it keeps its words.
  if (options.closeQuotes) {
    out += quote;
    for (let index = nested.length - 1; index >= 0; index -= 1) out += nested[index].back;
  }
  return out;
}

// A code point's text, or nothing past Unicode's last one.
function codePointText(value) {
  return value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

// ---------- Words as they run ----------

// A Bash variable's default or alternative value: `${X:-n}`, `${X:=n}`, `${X:+n}`.
const VARIABLE_DEFAULT = /\$\{[A-Za-z_]\w{0,63}:?[-=+]([^{}$\s]{0,256})\}/g;
// A variable inside a word, with other text before and after it: `.e${X}nv`, `.e$Xnv`, `.e%X:~0,0%nv`.
const VARIABLE_IN_WORD = new RegExp(
  String.raw`(?<=[^\s"'/\\;&|<>()\x60=$%{}])` +
    String.raw`(?:\$\{[^{}$\s]{0,256}\}|\$[A-Za-z_]\w*(?::[A-Za-z_]\w*)?|%[^%\s]{1,256}%)` +
    String.raw`(?=[^\s/;&|<>()\x60])`,
  "g",
);
// A command's name where a command starts, `&` or `.` before it allowed, with any quotes in it.
const COMMAND_NAME_WORD = new RegExp(
  String.raw`(^|[;&|(\x60\r\n\u2028\u2029])([^\S\r\n]*)(?:[&.][^\S\r\n]+)?` +
    String.raw`((?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"';&|()\x60<>])+)`,
  "g",
);

// A command's words as they run: a variable inside a word (`.e${X}nv`, `.e%X:~0,0%nv`) read as empty, as one
// that's unset or cut to nothing is, or with `defaults`, a Bash variable's default or alternative value put
// in its place wherever it is (`${X:-n}`, `${X:=n}`, `${X:+n}`), and a command's own name without its quotes
// (`'cat' .env`, `c''at`, PowerShell's `& 'gc' .env`), so the reader is found. A variable that is a whole
// word, or starts a path, is otherwise kept: what it holds isn't known (see shellReplacesPart). Each match is
// bounded, so this is linear.
function wordsAsRun(command, defaults = false) {
  const variables = defaults ? command.replace(VARIABLE_DEFAULT, "$1") : command.replace(VARIABLE_IN_WORD, "");
  return variables.replace(COMMAND_NAME_WORD, (whole, start, space, word) => {
    if (!/["']/.test(word)) return whole;
    return start + space + word.replace(/["']/g, "");
  });
}

module.exports = {
  joinedWords,
  shellReplacesPart,
  literalCharacter,
  ansiCQuoted,
  SHELL_ESCAPES,
  hereDocWord,
  backtickCommand,
  bracedVariableEnd,
  lineStarts,
  hereDocsEnd,
  unescapedCommand,
  wordsAsRun,
};

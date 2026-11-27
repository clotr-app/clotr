"use strict";
/* global require, module */

const { ShellCheckTooLong } = require("../check-budget.js");
const { SHELL_INVOKERS, SHELL_NEST_MAX } = require("../shell-reading/nested-commands.js");
const { SHELL_READER_NAME, CMD_GLUED_READER } = require("../shell-reading/file-reading-commands.js");
const { parseShellCommands } = require("../shell-reading/command-line-parser.js");
const {
  EMPTY_FILTERS,
  parseShellArgs,
  stdinIsFile,
  recursiveReadTargets,
  copySources,
} = require("../shell-reading/recursive-read-targets.js");
const { SHELL_ESCAPES, unescapedCommand } = require("../shell-reading/shell-quoting.js");
const { searchPatternAt, patternMayBeFile } = require("../shell-reading/search-pattern-words.js");
const {
  copyItemArgs,
  cpRefuses,
  copyCannotRun,
  templateCopySource,
  copyMayBeRenamed,
} = require("../shell-reading/copy-commands.js");
const {
  commandName,
  commandStart,
  nestedShellTexts,
  shellRedirection,
  withGroupValues,
  leadInRuns,
  startedProcess,
} = require("../shell-reading/nested-commands.js");
const { copyLastIsSource } = require("./recursive-read-check.js");
const {
  followStart,
  followedValue,
  followedWords,
  noteFollowed,
  inFollowedFolder,
  REMOTE_LEAD_INS,
  RECURSIVE_COPIES,
} = require("./folder-changes-and-variables.js");
const { secretOperandOpened, secretInReaderTargets } = require("./opened-file-check.js");
const {
  plainWord,
  xargsArgFile,
  namesFed,
  findReads,
  secretInFindTargets,
  secretInCopiedFolders,
} = require("./xargs-find-and-copies.js");

// ---------- Words to verdict ----------

function secretInReaderWords(
  reader,
  words,
  cwd,
  shellGlobs,
  recursive = true,
  command = null,
  work = null,
  inputKnown = false,
) {
  const args = words.map((word) => word.value);
  const plainWords = wordsWithoutRedirections(words);
  const plain = plainWords.map((word) => word.value);
  // In PowerShell, cp and copy are Copy-Item, whose parameters are PowerShell's (see copyItemArgs).
  const powershellCopy = command && command.dialect === "powershell" && /^(?:cp|copy)$/i.test(reader);
  const copyItem = powershellCopy ? copyItemArgs(plainWords) : null;
  // GNU's and BSD's cp copy nothing when given a short option they don't know: in Cursor's terminal, a
  // PowerShell `cp a b -WhatIf` read as Bash's.
  if (command && command.dialect === "bash" && /^cp$/i.test(reader) && cpRefuses(plain)) return null;
  // Copy-Item written in full where only its `copy` is matched (see SHELL_READER_AT): the words after `-Item`
  // are Copy-Item's, read as PowerShell reads them in every shell's reading, so its destination is never a
  // source. Not with a `+` in any word: cmd's copy joins the files around it, and `-Item` can be a file's
  // name there. Only where it's PowerShell's own Copy-Item (see COPY_REDEFINED) and the reading accounts for
  // every word (see copyItemArgs); otherwise it's read as the other copies are.
  // A copy the command may rename first reads every word as any reader does (see COPY_RENAMED).
  const renamed = copyMayBeRenamed(reader, shellGlobs);
  const asCopyItem = renamed ? null : copyReadingOf(reader, plainWords, copyItem, shellGlobs);
  // A copy of an example env file to the real one reads only the example (see templateCopySource).
  const template = renamed ? null : exampleEnvCopySource(reader, plainWords, command, shellGlobs);
  const searched = searchedWord(reader, words, plainWords, { command, cwd, shellGlobs });
  let operands;
  // A copy reads its sources, not the destination it writes, which stays its last word with an output
  // redirection after it (`cp a .env &>/dev/null`): a redirection, and its target when apart from it, aren't
  // copy words. `2\>x` and `"2>x"` are words cp copies.
  if (template) operands = [template];
  else if (asCopyItem) operands = asCopyItem.sources;
  else if (/^(?:cp|copy)$/i.test(reader) && !renamed) operands = copyOperands(reader, plain, cwd, shellGlobs);
  else operands = readerOperands(words, searched);
  const named = secretOperandAmong(operands, cwd, shellGlobs);
  if (named) return named;
  if (work && words.some((word) => word.deep)) work.deep = true;
  if (!recursive) return null;
  // rg reads its input in place of the working folder when that's a pipe, or a file its redirections give it,
  // and stream 0 isn't closed or sent elsewhere after them (`0>&-`, `0>/dev/null`). A redirection of its
  // input after the pipe wins over the pipe.
  const stdin = rgReadsInput(reader, command, inputKnown, cwd, shellGlobs);
  return secretInReaderFolders(reader, { args, plain, asCopyItem, stdin, command }, cwd, shellGlobs);
}

// How a copy reads its words as Copy-Item, or null. Copy-Item written in full where only its `copy` is matched
// (see SHELL_READER_AT): the words after `-Item` are Copy-Item's, read as PowerShell reads them in every shell's
// reading, so its destination is never a source. Not with a `+` in any word: cmd's copy joins the files around
// it, and `-Item` can be a file's name there. Only where it's PowerShell's own Copy-Item (see COPY_REDEFINED)
// and the reading accounts for every word (see copyItemArgs); otherwise it's read as the other copies are, as
// `copyItem` says. A copy no shell runs (see copyCannotRun) has only its first word read, as Guard first read a
// copy. Not cp, which outside Windows is cp in PowerShell too. Words read as Guard first read them run on past
// the reader's line, where the shell's end at it.
function copyReadingOf(reader, plainWords, copyItem, shellGlobs) {
  const item = /^copy$/i.test(reader) && copyItemInFull(plainWords);
  const redefined = shellGlobs?.copyRedefined !== false;
  const inFull = item && !redefined ? copyItemArgs(plainWords.slice(1), { full: true, splat: shellGlobs.splat }) : null;
  const fullCopyItem = inFull && !inFull.unsure ? inFull : null;
  const copyWords = copyLineWords(reader, plainWords);
  let asCopyItem = fullCopyItem || copyItem;
  if (/^copy$/i.test(reader) && !redefined && copyCannotRun(copyWords)) {
    asCopyItem = { sources: [copyWords[0].value], recurse: false };
  }
  return asCopyItem;
}

// A copy's words on its own line, past `-Item` where Copy-Item is written in full (see copyItemInFull).
function copyLineWords(reader, plainWords) {
  const item = /^copy$/i.test(reader) && copyItemInFull(plainWords);
  return plainWords.filter((word) => !word.afterLine).slice(item ? 1 : 0);
}

// The example env file a PowerShell or cmd copy makes the real one from (see templateCopySource), or null for
// any other copy, and for every copy where Bash runs it. Also null where the command may make the copy
// another command first (see COPY_REDEFINED), since a function or alias named Copy-Item can print the file.
function exampleEnvCopySource(reader, plainWords, command, shellGlobs) {
  if (!/^(?:cp|copy)$/i.test(reader)) return null;
  if (shellGlobs?.copyRedefined !== false) return null;
  const dialect = command ? command.dialect : null;
  if (shellGlobs?.kind === "bash" || dialect === "bash") return null;
  return templateCopySource(copyLineWords(reader, plainWords), dialect === "cmd");
}

// The word a search takes for its pattern on the reader's line, the same with the redirections left out,
// which isn't a file it reads; null for none.
function searchedWord(reader, words, plainWords, { command, cwd, shellGlobs }) {
  const mayBeFile = (value, rg) => patternMayBeFile(value, cwd, shellGlobs, rg);
  const gitBash = command ? command.dialect === "bash" : shellGlobs?.kind !== "powershell";
  const searchedAt = searchPatternAt(reader, words, mayBeFile, gitBash);
  const plainSearchedAt =
    searchedAt >= 0 && !words[searchedAt].afterLine ? searchPatternAt(reader, plainWords, mayBeFile, gitBash) : -1;
  return searchedAt >= 0 && plainWords[plainSearchedAt] === words[searchedAt] ? words[searchedAt] : null;
}

// The first operand that opens a secret file, as written or with an empty command substitution taken out
// (`.e$()nv`); undefined for none.
function secretOperandAmong(operands, cwd, shellGlobs) {
  for (const operand of operands) {
    if (operand && secretOperandOpened(operand, cwd, shellGlobs)) return operand;
    // A command substitution that prints nothing, as in `.e$()nv`, leaves the rest of the name as it is.
    const bare = operand.includes("…") ? operand.replace(/[$@]?…/g, "") : "";
    if (bare && secretOperandOpened(bare, cwd, shellGlobs)) return bare;
  }
  return undefined;
}

// `grep -r`, `rg`, `findstr /s`, `diff -r` and `cp -r` read every file under a folder they're given.
function secretInReaderFolders(reader, { args, plain, asCopyItem, stdin, command }, cwd, shellGlobs) {
  const lastIsSource = (last) => copyLastIsSource(last, cwd, shellGlobs);
  const pattern = command !== null;
  if (asCopyItem) {
    const copied = asCopyItem.recurse ? asCopyItem.sources : [];
    return secretInReaderTargets(
      copied.map((operand) => ({ path: operand, filters: EMPTY_FILTERS })),
      reader,
      cwd,
      shellGlobs,
    );
  }
  const targets = recursiveReadTargets(reader, args, lastIsSource, { stdin, pattern });
  // Read without its redirections too, as the first reading reads them (see withoutRedirections).
  if (plain.length !== args.length) {
    const seen = new Set(targets.map((target) => JSON.stringify(target)));
    for (const target of recursiveReadTargets(reader, plain, lastIsSource, { stdin, pattern })) {
      if (!seen.has(JSON.stringify(target))) targets.push(target);
    }
  }
  return secretInReaderTargets(targets, reader, cwd, shellGlobs);
}

// The words without their redirections (see shellRedirection), and a redirection's target when apart from it.
function wordsWithoutRedirections(words) {
  const plainWords = [];
  for (let index = 0; index < words.length; index += 1) {
    const redirection = shellRedirection(words[index]);
    if (redirection === "word") index += 1;
    else if (!redirection) plainWords.push(words[index]);
  }
  return plainWords;
}

// Whether copy's words start `-Item` as Copy-Item written in full does, with no `+` in any word.
function copyItemInFull(plainWords) {
  if (plainWords.length === 0) return false;
  const [first] = plainWords;
  if (first.quoted || first.partQuoted || !/^-item$/i.test(first.value)) return false;
  return !plainWords.some((word) => word.value.includes("+"));
}

// What cp or cmd's copy reads: its sources (see copySources).
function copyOperands(reader, plain, cwd, shellGlobs) {
  const cp = /^cp$/i.test(reader);
  const lastIsSource = cp && ((last) => copyLastIsSource(last, cwd, shellGlobs));
  const operands = copySources(parseShellArgs(plain, cp ? { shortValues: "tS" } : {}), lastIsSource);
  if (cp) return operands;
  // cmd's copy joins files given with `+`, and takes a switch glued on: `copy a.txt+.env/b out.txt`.
  const parts = (operand) => operand.split("+").flatMap((part) => [part, part.split("/")[0]]);
  return [...new Set(operands.flatMap((operand) => [operand, ...parts(operand)]))];
}

// Any other reader's operands: its words that aren't options, past `--` all of them, and a PowerShell
// parameter's value glued on with a colon. The search pattern's word is left out.
function readerOperands(words, searched) {
  const operands = [];
  let onlyOperands = false;
  for (const word of words) {
    const { value } = word;
    if (word === searched) continue;
    if (onlyOperands || word.quoted || !value.startsWith("-")) operands.push(value);
    else if (value === "--") onlyOperands = true;
    else {
      // PowerShell's `-Path:.env`.
      const named = /^-[A-Za-z]+:(.+)$/.exec(value);
      if (named) operands.push(named[1]);
    }
  }
  return operands;
}

// rg reads its input in place of the working folder when that's a pipe, or a file its redirections give it,
// and stream 0 isn't closed or sent elsewhere after them (`0>&-`, `0>/dev/null`). A redirection of its input
// after the pipe wins over the pipe.
function rgReadsInput(reader, command, inputKnown, cwd, shellGlobs) {
  if (!/^rg$/i.test(reader)) return false;
  if (command?.words.some((word) => /^0+>/.test(word.value) && shellRedirection(word))) return false;
  if (!command) return false;
  if (!command.stdinFrom.length) return command.piped;
  if (!inputKnown) return false;
  return command.stdinFrom.every((from) => from === null || stdinIsFile(from, cwd, shellGlobs.budget));
}

// The shells in `dialects` that can parse the text: PowerShell runs nothing of one with a `<` starting a word
// outside a string or comment (see unescapedCommand's `reservedLess`), read with its quotes ended at line
// breaks or not, so a Bash here-doc's Markdown (`cat > README.md <<'EOF'`) isn't read as PowerShell's
// commands. Linear in the text.
function shellsThatParse(text, dialects) {
  if (!dialects.includes("powershell") || !text.includes("<")) return dialects;
  const plain = text.replace(/[‘-‛]/g, "'").replace(/[“-„]/g, '"').replace(/[–-―]/g, "-");
  const parses = [false, true].some(
    (lineReset) => unescapedCommand(plain, { ...SHELL_ESCAPES.powershell, lineReset }) !== null,
  );
  return parses ? dialects : dialects.filter((dialect) => dialect !== "powershell");
}

// The first secret file the commands in shell text read, as each of the shells in `dialects` would split it.
// At the top level, `top.handled` gets where each reader's name starts, and `top.unclosed` whether a shell's
// reading ended inside a quote or a `(…)`.
function secretInShellText(text, dialects, cwd, shellGlobs, work, depth = 0, top = null) {
  for (const dialect of shellsThatParse(text, dialects)) {
    const watch = top && top.watch && dialect === "powershell" ? top.watch : null;
    const { commands, unclosed, stray } = parseShellCommands(text, dialect, work, { watch });
    // PowerShell parses all of a script before it runs any of it, so it runs nothing of one left open or with
    // a closing bracket that closes nothing: in Cursor's terminal, a Bash command such as `grep -rn {{ src`.
    // Text only PowerShell runs is still read, as Guard may misjudge where PowerShell's tokens end.
    if (dialect === "powershell" && dialects.length > 1 && (unclosed || stray)) {
      if (top) top.powershellFails = true;
      continue;
    }
    if (top && unclosed) top.unclosed = true;
    // Each command is judged as it's written, then with what the commands before it did followed (see
    // followStart).
    const follow = followStart(cwd);
    for (const command of commands) {
      const location =
        secretInCommand(command, dialect, cwd, shellGlobs, work, depth, top) ||
        secretInFollowed(command, dialect, follow, cwd, shellGlobs, work, depth);
      if (location) return location;
      noteFollowed(command, dialect, follow, cwd, shellGlobs.budget);
    }
  }
  return null;
}

// cmd's `if` or `for` starting a word, past its `@`s.
const CMD_IF_OR_FOR = /^@*(?:if|for)(?![A-Za-z0-9_])/i;
// What may come before the command's first command, or an echo piped into it (see secretInCommand).
const STDIN_FIRST_PREFIX = /^\s*(?:(?:echo|printf)\b[^;&|<>()`$\\\n\r]*\|\s*)?$/;

// The first secret file one parsed command reads: through an input redirection, as a reader, or in a shell it
// runs.
function secretInCommand(command, dialect, cwd, shellGlobs, work, depth, top) {
  for (const input of command.inputs) {
    if (input && secretOperandOpened(input, cwd, shellGlobs)) return input;
  }
  const inHereText = secretInHereTexts(command, dialect, cwd, shellGlobs, work, depth);
  if (inHereText) return inHereText;
  const { words } = command;
  let nameAt = commandStart(words, dialect);
  if (nameAt >= words.length) return null;
  const scan = { command, dialect, cwd, shellGlobs, work, depth, top };
  const head = words[nameAt];
  // A name PowerShell calls from a group too deep to keep stops it, as one in a reader's words does: `&
  // ((((...))))`.
  const called = nameAt === 0 ? command.called : !words[nameAt - 1].quoted && words[nameAt - 1].value === ".";
  if (head.deep && called && work) work.deep = true;
  const name = commandName(head.value);
  const reader = readerNamed(head, dialect) || (name === "." && !head.quoted ? "source" : null);
  if (reader) {
    const location = readFromWord(scan, nameAt, reader);
    if (location) return location;
  }
  // Bash: a name made only by a substitution may be empty, so a word after it may be the command: `$(true)
  // cat .env`.
  if (dialect === "bash" && !reader) {
    const location = secretPastLoneSubstitutions(scan, nameAt);
    if (location) return location;
  }
  // cmd runs an internal command glued to what follows its name: `type.env` is `type` given `.env`.
  const mayGlue = dialect === "cmd" && !reader && !head.quoted;
  const glued = mayGlue && CMD_GLUED_READER.exec(head.value.replace(/^@+/, ""));
  if (glued) {
    const location = secretInGluedReader(scan, nameAt, head, glued);
    if (location) return location;
  }
  // cmd's `for /f` reads the files in its set, or runs the command text there: `in (.env)`, `in ('type
  // .env')`. Its `for` may start any command in the words: `if 1==1 for /f …`, `for %a in (x) do for /f …`.
  if (dialect === "cmd" && !command.scanned) {
    const location = secretInCmdForSets(command, cwd, shellGlobs, work, depth);
    if (location) return location;
  }
  const afterOpener = secretAfterCmdOpener(scan, nameAt);
  if (afterOpener) return afterOpener;
  // PowerShell's `.` runs the command after it, as `&` does, as well as a script it names: `. rg x`.
  if (dialect === "powershell" && name === "." && !head.quoted) {
    const dotted = secretAfterDotCall(scan, nameAt);
    if (dotted.location) return dotted.location;
    nameAt = dotted.nameAt;
  }
  const nested = secretInNestedShells(scan, nameAt);
  if (nested) return nested;
  return secretInStartedProcess(scan, nameAt);
}

// PowerShell's Start-Process runs its program with its arguments: `Start-Process cmd '/c type .env'`.
function secretInStartedProcess({ command, dialect, cwd, shellGlobs, work, depth }, nameAt) {
  if (dialect !== "powershell") return null;
  const started = startedProcess(command.words, nameAt);
  if (!started) return null;
  if (started.input && secretOperandOpened(started.input, cwd, shellGlobs)) return started.input;
  if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
  const location = secretInShellText(started.text, ["powershell"], cwd, shellGlobs, work, depth + 1);
  return location || null;
}

// Reads the reader named at `at` with the words after it. `lead`: words read before the ones after the
// reader's name.
function readFromWord({ command, dialect, cwd, shellGlobs, work, top }, at, reader, lead = []) {
  const { words } = command;
  const head = words[at];
  if (top) top.handled.add(head.start);
  // rg's input is taken as the file it names only in the command's first command, or one an echo pipes
  // into: one before it could change the working folder or make that file a folder, and a shell the command
  // runs may run later.
  const first = top !== null && head.start < 4096 && STDIN_FIRST_PREFIX.test(top.text.slice(0, head.start));
  // Bash: a `}` in the words of a reader after a `{` is taken as that group's end, as it's plainly meant
  // (`{ cp .env.example .env } else { ... }`, a PowerShell line read as Bash's), though Bash runs it as a
  // word unless a `;` comes before it, and the group then needs a later `}` to close it.
  let after = words.slice(at + 1);
  if (dialect === "bash" && words.slice(0, at).some((word) => isBareWord(word, "{"))) {
    const close = after.findIndex((word) => isBareWord(word, "}"));
    if (close >= 0) after = after.slice(0, close);
  }
  // A pipe is rg's input only when rg starts the command piped into, not inside a group or compound command
  // (`x | { rg y; } </dev/null`), whose redirection wins over the pipe.
  return secretInReaderWords(
    reader,
    withGroupValues(lead.concat(after)),
    cwd,
    shellGlobs,
    true,
    at === 0 ? command : { ...command, piped: false },
    work,
    first,
  );
}

// Bash: the reader after words made only by substitutions, which may be empty.
function secretPastLoneSubstitutions(scan, nameAt) {
  const { words } = scan.command;
  let at = nameAt;
  while (at < words.length && isLoneSubstitution(words[at])) at += 1;
  const runs = at > nameAt && at < words.length ? readerNamed(words[at], scan.dialect) : null;
  return runs ? readFromWord(scan, at, runs) : null;
}

// cmd's `type` or `copy` glued to what follows its name, read as given that.
function secretInGluedReader(scan, nameAt, head, glued) {
  const rest = {
    value: glued[2],
    start: head.start,
    end: head.end,
    quoted: false,
    partQuoted: head.partQuoted,
    quotedAt: 0,
  };
  return readFromWord(scan, nameAt, glued[1].toLowerCase(), [rest]);
}

// cmd's `if` and `for` run a command after their condition or `do`: it's read from the first word naming a
// reader or a shell (`if 1==1 type .env`, `if(1)==(1) type .env`, `for %i in (x) do @type .env`), once: not
// again for an `if` in that command. An `if` is passed over as a wrapper to find the command's name, so it
// may be before it.
function secretAfterCmdOpener({ command, dialect, cwd, shellGlobs, work, depth, top }, nameAt) {
  const { words } = command;
  let opener = -1;
  if (dialect === "cmd" && !command.scanned) {
    opener = words.findIndex((word, at) => at <= nameAt && !word.quoted && CMD_IF_OR_FOR.test(word.value));
  }
  if (opener < 0) return null;
  for (let at = opener + 1; at < words.length; at += 1) {
    const bare = words[at].value.replace(/^@+/, "");
    const runs = commandName(bare);
    const glues = !words[at].quoted && CMD_GLUED_READER.test(bare);
    if (!readerNamed(words[at], dialect) && !glues && !SHELL_INVOKERS.some((entry) => entry.name.test(runs))) continue;
    const rest = words
      .slice(at)
      .map((word, index) => (index === 0 ? { ...word, value: word.value.replace(/^@+/, "") } : word));
    const after = { ...command, words: rest, inputs: [], expands: [], bodies: [], piped: false, scanned: true };
    return secretInCommand(after, dialect, cwd, shellGlobs, work, depth, top);
  }
  return null;
}

// PowerShell's `.` runs the command after it, as `&` does. Gives the `location` it reads, if any, and where
// the command's name is past the dots.
function secretAfterDotCall(scan, nameAt) {
  const { command, dialect } = scan;
  const { words } = command;
  let at = commandStart(words, dialect, nameAt + 1);
  while (at < words.length && words[at].value === "." && !words[at].quoted) at = commandStart(words, dialect, at + 1);
  if (at >= words.length) return { location: null, nameAt };
  const runs = readerNamed(words[at], dialect);
  return { location: runs ? readFromWord(scan, at, runs) : null, nameAt: at };
}

// `cmd /c "type .env"` is passed over as a wrapper to find the command's name, and run as a shell too.
function secretInNestedShells({ command, dialect, cwd, shellGlobs, work, depth }, nameAt) {
  const { words } = command;
  for (let at = 0; at <= nameAt; at += 1) {
    const texts = nestedShellTexts(words, at, dialect, command.heredocs);
    // Shells nested deeper than Guard reads stop the command, as one with too many paths does.
    if (texts.length && depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    for (const [inner, innerDialect] of texts) {
      const location = secretInShellText(inner, [innerDialect], cwd, shellGlobs, work, depth + 1);
      if (location) return location;
    }
  }
  return null;
}

// The commands a here-document's or here-string's `$(…)` and backticks run, however they start, and the lines
// of one whose end Guard may place otherwise than the shell.
function secretInHereTexts(command, dialect, cwd, shellGlobs, work, depth) {
  for (const lines of command.expands) {
    if (!/\$\(|`/.test(lines)) continue;
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    const { commands } = parseShellCommands(lines, dialect, work, { body: true });
    for (const inner of commands) {
      const location = secretInCommand(inner, dialect, cwd, shellGlobs, work, depth + 1, null);
      if (location) return location;
    }
  }
  for (const lines of command.bodies) {
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    for (const inner of parseShellCommands(lines, dialect, work).commands) {
      const location = secretInCommand(inner, dialect, cwd, shellGlobs, work, depth + 1, null);
      if (location) return location;
    }
  }
  return null;
}

// The reader a word names, past cmd's `@`, or in PowerShell one a group gives: `& ('cat') .env`.
function readerNamed(word, dialect) {
  const runs = commandName(dialect === "cmd" ? word.value.replace(/^@+/, "") : word.value);
  if (SHELL_READER_NAME.test(runs)) return runs;
  if (dialect !== "powershell" || !word.values) return null;
  const given = word.values.find((value) => SHELL_READER_NAME.test(commandName(value.value)));
  return given ? commandName(given.value) : null;
}

function isBareWord(word, value) {
  return !word.partQuoted && word.value === value;
}

// A word made only by a substitution, which may be empty: `$(true)`.
function isLoneSubstitution(word) {
  return !word.partQuoted && !word.compound && /^\$?\u2026$/.test(word.value);
}

// cmd's `for /f` reads the files in its set, or runs the command text there: `in (.env)`, `in ('type .env')`.
function secretInCmdForSets(command, cwd, shellGlobs, work, depth) {
  for (const set of command.sets || []) {
    if (!set.lines) continue;
    const values = command.words.slice(set.from, set.to).map((word) => word.value);
    for (const value of values) {
      const file = value.replace(/^\(+|\)+$/g, "").replace(/['"`]/g, "");
      if (file && secretOperandOpened(file, cwd, shellGlobs)) return file;
    }
    const setText = values
      .join(" ")
      .replace(/^\(([\s\S]*)\)$/, "$1")
      .trim();
    const run = /^(['`])([\s\S]*)\1$/.exec(setText);
    if (!run) continue;
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    const location = secretInShellText(run[2], ["cmd"], cwd, shellGlobs, work, depth + 1);
    if (location) return location;
  }
  return null;
}
// ---------- Following names ----------

// The first secret file one command reads once what earlier commands did is followed (see followStart), or
// through a command that passes names on (see secretPassedOn).
function secretInFollowed(command, dialect, follow, cwd, shellGlobs, work, depth) {
  const words = followedWords(command.words, dialect, follow);
  const inputs = command.inputs.map((input) => (input ? followedValue(input, dialect, follow) : input));
  const changed = words !== command.words || inputs.some((input, at) => input !== command.inputs[at]);
  const step = changed ? { ...command, words, inputs } : command;
  const moved = follow.cwd !== cwd;
  function check() {
    const found = changed || moved ? secretInCommand(step, dialect, follow.cwd, shellGlobs, work, depth, null) : null;
    return found || secretPassedOn(step, dialect, follow.cwd, shellGlobs, work, depth, follow.prev);
  }
  return inFollowedFolder(follow, cwd, shellGlobs.budget, check);
}
// ---------- Names passed on ----------

// The first secret file a command reads through a lead-in (`nice cat .env`), `xargs` given names by the
// command piped into it, `find -exec`, or a recursive copy (`robocopy`, `xcopy`, `rsync`, `scp`). `prev` is
// the command before it.
function secretPassedOn(command, dialect, cwd, shellGlobs, work, depth, prev) {
  const { words } = command;
  const nameAt = commandStart(words, dialect);
  if (nameAt >= words.length) return null;
  const name = commandName(words[nameAt].value).toLowerCase();
  if (SHELL_READER_NAME.test(name) || REMOTE_LEAD_INS.test(name)) return null;
  if (RECURSIVE_COPIES.test(name)) return secretInCopiedFolders(name, words.slice(nameAt + 1), cwd, shellGlobs);
  const runs = leadInRuns(words, nameAt, name, dialect);
  if (!runs) return null;
  if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
  if (runs.text) return secretInShellText(runs.text, [runs.dialect], cwd, shellGlobs, work, depth + 1);
  const inner = {
    ...command,
    words: words.slice(runs.from, runs.to),
    inputs: [],
    expands: [],
    bodies: [],
    piped: false,
  };
  const reader = inner.words.length ? commandName(inner.words[0].value) : "";
  if (name === "find") {
    if (!SHELL_READER_NAME.test(reader)) return null;
    return secretInFindTargets(findReads(words, nameAt, runs.from - 1), cwd, shellGlobs);
  }
  if (name === "xargs") {
    const file = xargsArgFile(words.slice(nameAt + 1, runs.from));
    if (file) return secretOperandOpened(file, cwd, shellGlobs) ? file : null;
    const fed = command.piped && prev ? namesFed(prev, dialect) : null;
    if (!fed || !SHELL_READER_NAME.test(reader)) return null;
    if (fed.targets) return secretInFindTargets(fed.targets, cwd, shellGlobs);
    const given = { ...inner, words: inner.words.concat(fed.names.map(plainWord)) };
    return secretInCommand(given, dialect, cwd, shellGlobs, work, depth + 1, null);
  }
  return (
    secretInCommand(inner, dialect, cwd, shellGlobs, work, depth + 1, null) ||
    secretPassedOn(inner, dialect, cwd, shellGlobs, work, depth + 1, null)
  );
}

module.exports = {
  secretInReaderWords,
  shellsThatParse,
  secretInShellText,
  STDIN_FIRST_PREFIX,
  secretInCommand,
  secretInFollowed,
  secretPassedOn,
};

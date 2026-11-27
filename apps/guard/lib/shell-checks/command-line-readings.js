"use strict";
/* global require, module, Buffer */

const fs = require("fs");
const path = require("path");
const { budgetSpent, lookupsSpent, ShellCheckTooLong } = require("../check-budget.js");
const { SHELL_READER_AT, SHELL_OLD_STOPS } = require("../shell-reading/file-reading-commands.js");
const {
  SHELL_PARSE_STEPS_PER_CHAR,
  SHELL_PARSE_MIN_STEPS,
  parseShellCommands,
} = require("../shell-reading/command-line-parser.js");
const { isSecretOperand } = require("../secret-paths/secret-path-check.js");
const { expandShellGlob } = require("../path-forms/glob-expansion.js");
const { shellSpellings } = require("../shell-reading/empty-variable-spellings.js");
const { parseShellArgs, recursiveReadTargets, copySources } = require("../shell-reading/recursive-read-targets.js");
const { joinedWords } = require("../shell-reading/shell-quoting.js");
const { pathReadings } = require("../path-forms/path-readings.js");
const { searchPatternAt, patternMayBeFile } = require("../shell-reading/search-pattern-words.js");
const {
  copyItemArgs,
  copyCannotRun,
  templateCopySource,
  copyMayBeRenamed,
} = require("../shell-reading/copy-commands.js");
const { withGroupValues, embeddedReaders } = require("../shell-reading/nested-commands.js");
const { copyLastIsSource } = require("./recursive-read-check.js");
const {
  withoutRedirections,
  wordsPastRedirections,
  secretOperandOpened,
  secretInReaderTargets,
} = require("./opened-file-check.js");
const { secretInReaderWords, shellsThatParse, secretInShellText, secretInCommand } = require("./secret-in-command.js");

// ---------- Environment dump check ----------

// For each place in `text`, where the next of `characters` is at or after it (the text's length if none is).
function nextStops(text, characters) {
  const stops = new Int32Array(text.length + 1);
  let next = text.length;
  stops[text.length] = next;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (characters.includes(text[at])) next = at;
    stops[at] = next;
  }
  return stops;
}
// ---------- The two readings ----------

// The first secret file a shell command's readers, redirections or embedded file opens could read, or null.
// `dialects` are the shells that could run it: "bash", "powershell", "cmd". `oldWords` also reads every
// reader's words as Guard first read them, for a shell that splits inside a single quote.
function secretInParsedShell(command, cwd, shellGlobs, dialects = ["bash", "powershell"], oldWords = false) {
  const steps = SHELL_PARSE_MIN_STEPS + SHELL_PARSE_STEPS_PER_CHAR * command.length;
  const work = { left: steps, budget: shellGlobs.budget };
  // Each command as the shell splits it: a separator inside quotes, `cat "a|b" .env`, doesn't end the
  // reader's words.
  const readers = [...command.matchAll(SHELL_READER_AT)];
  // The quote PowerShell reads each reader's name in, at its last letter (see parseShellCommands).
  const watch = { at: readers.map((match) => match.index + match[0].length - 1), quotes: [] };
  const top = { handled: new Set(), unclosed: false, text: command, watch };
  const found = secretInShellText(command, dialects, cwd, shellGlobs, work, 0, top);
  if (found) return found;
  // A reader the shell wouldn't run as a command here, inside quotes or a here-document, may still be run by
  // a shell nested in the command, and a here-document or here-string runs the `$(…)` in it. Its words are
  // read from where its name ends, with fresh quote rules, up to the first separator outside them, and a
  // command inside them is checked too. Each reader's name is found on its own, so one inside another's words
  // is read as well. A command that ends inside a quote or a `(…)` won't run as read, so its readers are also
  // read as Guard read them before: up to the next separator, quoted or not, or the next reader, in words
  // split at blank space. Each reader's words are read only up to where the next reader's match starts, so no
  // text is read twice. In PowerShell, the text is read in the quote the name sits in, where a backtick ends
  // the command (a Markdown code span in a commit message), as it does in Guard's first reading.
  const parsing = readers.length
    ? shellsThatParse(command, dialects).filter((dialect) => dialect !== "powershell" || !top.powershellFails)
    : [];
  const pass = { command, cwd, shellGlobs, readers, top, parsing, work, oldWords, stops: null };
  for (let index = 0; index < readers.length; index += 1) {
    const location = secretAtReader(pass, index);
    if (location) return location;
  }
  // A reader given a group nested too deep for all its words to be kept may read a secret file among those
  // left out.
  const location = secretInRedirectsOrOpens(command, cwd, shellGlobs);
  if (location || !work.deep) return location;
  throw new ShellCheckTooLong();
}

// A reader's text split as Guard first split it: a quoted run, or a run up to blank space. Words past the
// reader's line aren't read as a copy no shell runs or a search's pattern (see secretInReaderWords).
function firstReadingSplit(text) {
  const lineEnd = text.search(/[\r\n\u2028\u2029]/);
  return [...text.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(({ 0: value, index }) => ({
    value: value.replace(/^['"]|['"]$/g, ""),
    quoted: /^['"]/.test(value),
    afterLine: lineEnd >= 0 && index > lineEnd,
  }));
}

// One reader's words, read from where its name ends (see secretInParsedShell): by each shell that parses the
// command where the shell's reading didn't reach it, and as Guard first read them where needed.
function secretAtReader(pass, index) {
  const { command, readers, top, oldWords } = pass;
  const match = readers[index];
  const reader = match[1];
  const nameEnd = match.index + match[0].length;
  const limit = index + 1 < readers.length ? readers[index + 1].index : command.length;
  const handled = top.handled.has(nameEnd - reader.length);
  if (!handled) {
    const location = secretInReaderText(pass, { index, reader, nameEnd, limit });
    if (location) return location;
  }
  if (top.unclosed || !handled || oldWords) return secretInFirstReaderWords(pass, { reader, nameEnd, limit });
  return null;
}

// A reader's command read by each shell that parses the text, from where its name ends up to `limit`. The text
// up to the limit is a slice that shares the command's memory, and every scan in it stops at its end.
function secretInReaderText({ command, cwd, shellGlobs, top, parsing, work }, { index, reader, nameEnd, limit }) {
  const text = command.slice(0, limit);
  for (const dialect of parsing) {
    const quote = dialect === "powershell" ? top.watch.quotes[index] || null : null;
    const { commands, first } = parseShellCommands(text, dialect, work, {
      start: nameEnd,
      firstOnly: true,
      quote,
      prose: true,
    });
    const location = secretInReaderWords(
      reader,
      first ? withGroupValues(first.words) : [],
      cwd,
      shellGlobs,
      true,
      first,
      work,
    );
    if (location) return location;
    for (const inner of commands) {
      const innerLocation = inner === first ? null : secretInCommand(inner, dialect, cwd, shellGlobs, work, 0, null);
      if (innerLocation) return innerLocation;
    }
  }
  return null;
}

// A reader's words as Guard first read them. Where the shell's reading stands (this reader's command has none
// here), only the files named, not a folder a cut-short search would be taken to read.
function secretInFirstReaderWords(pass, { reader, nameEnd, limit }) {
  const { command, cwd, shellGlobs, top, work } = pass;
  if (pass.stops === null) pass.stops = nextStops(command, SHELL_OLD_STOPS);
  const end = Math.min(pass.stops[nameEnd], limit);
  work.left -= end - nameEnd;
  if (work.left < 0) throw new ShellCheckTooLong();
  const words = firstReadingSplit(command.slice(nameEnd, end));
  return secretInReaderWords(reader, words, cwd, shellGlobs, top.unclosed);
}

// The first secret file read through an input redirection or a file open written into the command, or null.
function secretInRedirectsOrOpens(command, cwd, shellGlobs) {
  // Input redirection reads the file whatever the command is: `tr a b < .env`, `cat<.env`, `<>.env`, a `while
  // read` loop. Its target is the whole word, quoted parts joined as the shell joins them (`<
  // "$HOME"/kj/config`, `< '.e'nv`), and also a run up to a blank or an operator, its quotes kept, as a quote
  // needn't close for cmd (`sort <".env`).
  const redirected = new Set();
  for (const match of command.matchAll(/<>?\s*((?:"[^"]*"|'[^']*'|[^\s<>;&|()`"'])+)/g)) {
    const unquoted = match[1].replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single);
    for (const word of new Set([match[1], unquoted])) {
      redirected.add(word);
      if (secretOperandOpened(word, cwd, shellGlobs)) return match[1];
    }
  }
  for (const match of command.matchAll(/<\s*("[^"]*"|'[^']*'|[^\s<>;&|()`]+)/g)) {
    if (!redirected.has(match[1]) && isSecretOperand(match[1], cwd, shellGlobs)) return match[1];
  }
  // File names inline code opens (see embeddedReaders), each as written and as each path it may stand for.
  const readingOptions = { gitBash: Boolean(shellGlobs.gitBash) };
  for (const name of embeddedReaders(command)) {
    for (const reading of [name, ...pathReadings(name, readingOptions)]) {
      if (isSecretOperand(reading, cwd, undefined, shellGlobs.budget)) return name;
    }
  }
  return null;
}
// ---------- The first reading ----------

// A reader and its words as Guard's first shell check read them: up to the next separator, quoted or not.
const SHELL_FIRST_READERS = new RegExp(`${SHELL_READER_AT.source}([^;&|)\`]*)`, "gim");
// Readers that are POSIX tools on every system Bash runs on, Git Bash's included, never expand a glob
// themselves, and read only the files they're given as words: no switch or script of theirs names one (`grep
// -f`, `diff --from-file`, sed's `r`, `awk -f`, `less -k`, `source -p`), which the bare `*` of the split
// words could have caught.
const SHELL_FIRST_JOIN_READER = /^(?:cat|head|tail|tac|nl|od|paste|fold|cut|uniq|base64|cp)$/;

// The words Guard's first shell check split a reader's text into: a quoted run, or a run up to blank space.
// In Bash, a `*` or `?` right after a closing quote is part of the quoted word, so `"READ ME"*` is the files
// starting `READ ME`, not a glob of its own that matches every file in the folder. It's joined only when the
// quoted part starts the word and holds plain letters: no glob or brace character, `\`, `~` or leading `-`,
// which read differently unquoted, no `$` or backtick, which Bash expands inside double quotes, no `!`, which
// Guard's glob reads as a negation, and none of `:<>|`, which Git Bash keeps as other letters in a name. Nor
// may it name only `.` or `..` in its folder, which Bash matches too, start at the root, where Git Bash's `/`
// and /tmp are its own folders, not the ones Node finds there, or hold a `..` part, which Bash takes from
// where a link before it leads and Node folds away by its text. So the joined glob matches every file Bash's
// word does. Only `*`: Bash's `?` is one byte in the C locale and one letter in others, so `"q"??` can match
// `qé` or not. `expand`, given for such a reader (see FIRST_JOIN_READER_CALL), lists what the joined glob
// matches, for words before `until`, where the command's first call ends: Bash expands a later call's words
// after the ones before it have run. When it's one path, and that path starts with the quoted part letter for
// letter, the path stands in for the bare `*`, as Bash hands it to the command, so a copy's last path falls
// where it does in Bash. The quoted part stays a word of its own, judged by its name as it was before the
// join, so `"server.key"*` is still stopped. Guard matches without regard to case, so Bash finds no path
// Guard doesn't, and the one Guard found, whatever Bash's glob options. With two or more, Bash's order (its
// locale's) says which is the pattern or the target; with none, Bash's options say whether the word is kept.
// So then the words stay split, as they do when Guard can't list them or the path wouldn't read back as one
// plain word, or ends in `.lnk`: Git Bash shows a link it made as such a file by its name without `.lnk`, and
// opens what it leads to.
// A quoted word whose letters a `*` after it may join (see firstReadingWords), and a prefix that may not.
const JOINABLE_QUOTE = /^(["'])(?!-)([^*?[\]\\$`{}~!:<>|\0-\x1f]*)\1$/;
const UNJOINABLE_PREFIX = /^\/|(?:^|\/)\.+$|(?:^|\/)\.\.(?:\/|$)/;

function firstReadingWords(text, expand, joined, until = 0) {
  const words = [];
  // The text starts right after the reader's name, so a word at its very start is glued to that.
  let end = 0;
  let lastStartsWord = false;
  for (const { 0: word, index } of text.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    const last = words[words.length - 1];
    const glued = index === end;
    const joinable = expand && glued && lastStartsWord && index + word.length <= until && /^\*+$/.test(word);
    const quoted = joinable ? JOINABLE_QUOTE.exec(last) : null;
    const prefix = quoted ? quoted[2] : null;
    const glob = prefix !== null && !UNJOINABLE_PREFIX.test(prefix) ? prefix + word : null;
    const paths = glob === null ? null : expand(glob);
    const only = paths?.length === 1 ? paths[0] : null;
    const fits =
      only !== null &&
      !/^-|["'\\*?[]|\.lnk$/i.test(only) &&
      path.posix.basename(only).startsWith(prefix.slice(prefix.lastIndexOf("/") + 1));
    if (fits) {
      words.push(only);
      joined.push(glob);
      lastStartsWord = false;
    } else {
      // After a word ending in `\`, the blank space between is escaped into one word. Bash splits words only
      // at a space or tab, not at the other blank space `\s` holds, such as a no-break space.
      lastStartsWord = !glued && /[ \t]/.test(text[index - 1] ?? "") && !(last || "").endsWith("\\");
      words.push(word);
    }
    end = index + word.length;
  }
  return words;
}

// The first secret file a shell command's readers, redirections or embedded file opens could read, or null,
// as Guard's first shell check read them: in the command as written and as each shell that could run it
// spells it (see shellSpellings). The checks share one budget, so a path or folder already checked isn't
// checked again. `bash` and `copyLast`: see secretInFirstShellReading.
function secretInShellReads(command, cwd, shellGlobs, bash = false, copyLast = false) {
  for (const spelling of shellSpellings(command, shellGlobs.kind)) {
    const location = secretInFirstShellReading(spelling, cwd, shellGlobs, bash, copyLast);
    if (location) return location;
  }
  return null;
}

// The first secret file a shell command reads as Guard's first shell check read it. Every command is checked
// this way too, so no command that check stopped goes through however the shell's own reading splits it.
// `bash`: the command is Claude's Bash tool's. `copyLast`: cp's last word is read as files it copies too
// where copyLastIsSource says so; otherwise it's where cp copies to, as the first check read it.
function secretInFirstShellReading(command, cwd, shellGlobs, bash = false, copyLast = false) {
  const { budget } = shellGlobs;
  const joined = [];
  const before = budget.byName;
  const found = firstReadingPass(command, cwd, shellGlobs, bash, joined, copyLast);
  if (found || !joined.length) return found;
  // A joined glob's paths are only as good as the look Guard took at them. Where any path in the command was
  // judged by its name instead (a walk cut short, a folder it couldn't list, a path on another computer), or
  // the walk or its lookups ran out, the bare `*` of the split words could still have stopped the command,
  // where `x*` or `xdata` names no secret file. Then the command is read again with the words split as
  // before.
  const spent = budget.byName !== before || budgetSpent(budget) || lookupsSpent(budget);
  return spent ? firstReadingPass(command, cwd, shellGlobs, false, [], copyLast) : null;
}

// Bash lists a glob's paths in the folder it's in when it reaches the word, with the glob options set by
// then, after every command before it has run. Guard lists them before any of it runs, in the folder the
// command starts in. They agree only for a command that is one call of a POSIX reader and nothing else: no
// other command before or after it (`;`, `&`, `|`, a line break), no group, redirection, here-document, `$`,
// backtick or `\`, and the reader's own name first, with no wrapper or variable before it. Then no earlier
// command can add a match, change the folder or set an option, and no nested shell can start with its own.
const JOIN_READER_CALL = String.raw`^[ \t]*(?:cat|head|tail|tac|nl|od|paste|fold|cut|uniq|base64|cp)[ \t][^;&|<>(){}\x60$\\\r\n]*`;
const SOLE_JOIN_READER_CALL = new RegExp(`${JOIN_READER_CALL}$`);
// The same reader call as the command's first, with others after it: Bash expands its words before any of
// them runs. Only after `;`, `&&`, `||` or a line break, which wait for it: a `|` or `&` starts the next
// command beside it, which may have changed the folder by the time it expands them.
const FIRST_JOIN_READER_CALL = new RegExp(String.raw`${JOIN_READER_CALL}(?=$|;|&&|\|\||\r?\n)`);

// Whether the one path a joined glob found is what Bash opens by that name: a folder, or a file with no other
// name (a hard link's other name could be a secret file's) that isn't a link Git Bash or Cygwin wrote as a
// file of its own (`!<symlink>`, Interix's `IntxLNK`), which Node takes for a plain file and Bash follows.
// Such a file holds one path, so a bigger file isn't one, and isn't opened: opening a file that's only in the
// cloud downloads it.
const JOIN_LINK_FILE_MOST = 70000;
function plainJoinTarget(found, cwd, budget) {
  if (budget) {
    if (lookupsSpent(budget)) return false;
    budget.lookups -= 1;
  }
  const full = path.resolve(cwd, found);
  let fd = null;
  try {
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) return true;
    if (!stat.isFile() || stat.nlink !== 1) return false;
    if (stat.size > JOIN_LINK_FILE_MOST) return true;
    fd = fs.openSync(full, "r");
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return !/^(?:!<symlink>|IntxLNK|XSym\n)/.test(head.toString("latin1", 0, read));
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function firstReadingPass(command, cwd, shellGlobs, bash, joined, copyLast) {
  const lastIsSource = copyLast ? (last) => copyLastIsSource(last, cwd, shellGlobs) : () => false;
  // Where the command's first call ends, when it's a reader whose words Guard can join.
  const firstCall = bash ? FIRST_JOIN_READER_CALL.exec(command) : null;
  // Folders a joined glob was listed in: the walk is charged for each once, so joins don't spend what later
  // paths need.
  const listedFolders = new Set();
  const { budget } = shellGlobs;
  function expandJoin(glob) {
    const entries = budget?.entries;
    const paths = expandShellGlob(glob, cwd, shellGlobs);
    const folder = glob.slice(0, glob.lastIndexOf("/") + 1);
    if (budget && listedFolders.has(folder)) budget.entries = entries;
    listedFolders.add(folder);
    return paths?.length === 1 && !plainJoinTarget(paths[0], cwd, budget) ? null : paths;
  }
  const pass = { command, cwd, shellGlobs, firstCall, expandJoin, joined, lastIsSource, pastEnd: 0 };
  for (const match of command.matchAll(SHELL_FIRST_READERS)) {
    const location = secretInFirstReader(pass, match);
    if (location) return location;
  }
  return secretInRedirectsOrOpens(command, cwd, shellGlobs);
}

// One reader of the first reading and its words (see firstReadingPass): a secret file it names or reads
// under a folder, or null.
function secretInFirstReader(pass, match) {
  const { command, cwd, shellGlobs, firstCall, expandJoin, joined } = pass;
  // Only for a POSIX tool: a Windows program such as findstr expands a glob Bash left alone on its own,
  // against short names too, so `"e"*` can match .env (ENV~1) there. Only the command's first call (see
  // FIRST_JOIN_READER_CALL).
  const joins = firstCall && match.index === 0 && SHELL_FIRST_JOIN_READER.test(match[1]);
  const expand = joins ? expandJoin : null;
  // The reader's words start where its text does, so the first call ends this far into them.
  const until = expand ? firstCall[0].length - (match[0].length - match[2].length) : 0;
  const asRead = firstReadingWords(match[2], expand, joined, until);
  // The words as the shell joins them, also read where a quote sits inside one (`"$HOME"/kj`, see
  // joinedWords).
  const shellJoined = joinedWords(match[2]);
  // The words past a reader's redirection (see wordsPastRedirections) are read as well as its words as
  // Guard always read them, never instead, since a quote opened before the redirection and closed after it
  // joins words the shell keeps apart. A reader found among them (`2>&cat`, a stream sent to a file named
  // cat) is one of their words, already read with them, so they're taken once however many follow. A call
  // with a redirection is never joined (see FIRST_JOIN_READER_CALL), so these words are split as they
  // always were.
  const end = match.index + match[0].length;
  const past = match.index < pass.pastEnd ? "" : wordsPastRedirections(command, end);
  if (match.index >= pass.pastEnd) pass.pastEnd = end + past.length;
  const args = past ? firstReadingWords(match[2] + past, null, []) : asRead;
  const operands = firstReadingOperands(pass, match, { asRead, args, past, shellJoined });
  // Each operand is read as written and as each path it opens (see opensAs).
  for (const arg of new Set(operands)) {
    if (secretOperandOpened(arg, cwd, shellGlobs)) return arg;
  }
  const targets = firstReadingTargets(pass, match, { asRead, args, shellJoined });
  return secretInReaderTargets(targets, match[1], cwd, shellGlobs);
}

// The words a reader of the first reading opens as files.
function firstReadingOperands(pass, match, { asRead, args, past, shellJoined }) {
  const { cwd, shellGlobs, lastIsSource } = pass;
  // A copy reads its sources, not the destination it writes, the last of its words that isn't a
  // redirection. A copy the command may rename first is read as any reader is (see COPY_RENAMED).
  const copy = /^(?:cp|copy)$/i.test(match[1]) && !copyMayBeRenamed(match[1], shellGlobs);
  const cp = /^cp$/i.test(match[1]);
  const copyOptions = cp ? { shortValues: "tS" } : {};
  // Copy-Item written in full, a copy no shell runs and a search's pattern are read as the shell's reading
  // reads them (see secretInReaderWords), from the words on the reader's line.
  const line = match[2].split(/[\r\n\u2028\u2029]/)[0].match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const fullCopyItem = copy && !cp && /^-item$/i.test(line[0] || "") && !match[2].includes("+");
  const copyLine = wordsOfList(fullCopyItem ? line.slice(1) : line);
  const copyReading = { fullCopyItem, shellGlobs, copyOptions, lastIsSource: cp && lastIsSource };
  const sources = (list) => copiedSources(list, copyReading);
  const unsearched = (list) => withoutSearchPattern(list, match[1], line, cwd, shellGlobs);
  // A copy of an example env file to the real one reads only the example (see templateCopySource), unless
  // the command may make the copy another command first (see COPY_REDEFINED).
  const exampleCopy = copy && shellGlobs.kind !== "bash" && !shellGlobs.copyRedefined;
  const template = exampleCopy ? templateCopySource(copyLine, false) : null;
  let operands;
  if (template) operands = [template];
  else if (copy && !cp && !shellGlobs.copyRedefined && copyCannotRun(copyLine)) operands = [copyLine[0].value];
  else if (copy) {
    operands = sources(asRead).concat(
      past ? sources(withoutRedirections(args)) : [],
      shellJoined ? sources(shellJoined) : [],
    );
  } else {
    operands = unsearched(asRead)
      .concat(past ? unsearched(args) : [], shellJoined || [])
      .filter((arg) => !arg.startsWith("-"));
  }
  return operands;
}

// The folders a recursive reader of the first reading reads under.
function firstReadingTargets(pass, match, { asRead, args, shellJoined }) {
  const { command, lastIsSource } = pass;
  // `grep -r`, `rg`, `findstr /s`, `diff -r` and `cp -r` read every file under a folder they're given.
  // Their words are read as Guard always read them, up to the first `&` or `|`, and again with the words
  // past a redirection (see wordsPastRedirections) but without what looks like a redirection (see
  // withoutRedirections), so `grep -r x 2>/dev/null` has the working folder walked. For rg an input
  // redirection names what it reads instead of a folder, so it stays a word; piped into (`x | rg`, `x |&
  // rg`), rg has only the first reading. Each reading is walked, never one in place of another; the full
  // one goes first, so a folder named after a redirection (`grep -r x &>log sub`) is the one reported.
  const rg = /^rg$/i.test(match[1]);
  const before = command[match.index - 1];
  const piped = match[0][0] === "|" ? before !== "|" : match[0][0] === "&" && before === "|";
  const unredirected = withoutRedirections(args, { input: !rg });
  const fullTargets = rg && piped ? [] : recursiveReadTargets(match[1], unredirected, lastIsSource);
  const targets = fullTargets.concat(
    recursiveReadTargets(match[1], asRead, lastIsSource),
    shellJoined ? recursiveReadTargets(match[1], shellJoined, lastIsSource) : [],
  );
  return targets;
}

// Words as the first reading wrote them, quoted or not, as the shell's reading's word objects.
function wordsOfList(list) {
  return list.map((word) => ({ value: word.replace(/^(["'])([^]*)\1$/, "$2"), quoted: /^["']/.test(word) }));
}

// What a copy in the first reading reads: Copy-Item's sources when it's written in full and read through,
// else cp's or copy's (see copySources).
function copiedSources(list, { fullCopyItem, shellGlobs, copyOptions, lastIsSource }) {
  const inFull =
    fullCopyItem &&
    !shellGlobs.copyRedefined &&
    /^-item$/i.test(list[0] || "") &&
    copyItemArgs(wordsOfList(list.slice(1)), { full: true, splat: shellGlobs.splat });
  if (inFull && !inFull.unsure) return inFull.sources;
  return copySources(parseShellArgs(list, copyOptions), lastIsSource);
}

// The words without a search's pattern, when the pattern is a word on the reader's line.
function withoutSearchPattern(list, reader, line, cwd, shellGlobs) {
  const mayBeFile = (value, rg) => patternMayBeFile(value, cwd, shellGlobs, rg);
  const at = searchPatternAt(reader, wordsOfList(list), mayBeFile, shellGlobs.kind !== "powershell");
  const onLine = at >= 0 && at < line.length && list.slice(0, at + 1).every((word, index) => word === line[index]);
  return onLine ? list.filter((_, index) => index !== at) : list;
}

module.exports = {
  nextStops,
  secretInParsedShell,
  secretInRedirectsOrOpens,
  SHELL_FIRST_READERS,
  SHELL_FIRST_JOIN_READER,
  firstReadingWords,
  secretInShellReads,
  secretInFirstShellReading,
  SOLE_JOIN_READER_CALL,
  FIRST_JOIN_READER_CALL,
  JOIN_LINK_FILE_MOST,
  plainJoinTarget,
  firstReadingPass,
};

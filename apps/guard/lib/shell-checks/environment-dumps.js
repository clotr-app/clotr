"use strict";
/* global require, module */

const { ShellCheckTooLong } = require("../check-budget.js");
const { SHELL_INVOKERS, SHELL_NEST_MAX, takesValue } = require("../shell-reading/nested-commands.js");
const {
  SHELL_PARSE_STEPS_PER_CHAR,
  SHELL_PARSE_MIN_STEPS,
  parseShellCommands,
} = require("../shell-reading/command-line-parser.js");
const {
  commandName,
  commandStart,
  nestedShellTexts,
  shellRedirection,
  leadInRuns,
  pastOptions,
} = require("../shell-reading/nested-commands.js");
const { argumentsAfter, beforeRedirection } = require("./xargs-find-and-copies.js");
const { shellsThatParse } = require("./secret-in-command.js");
const { nextStops } = require("./command-line-readings.js");

// ---------- The shell check's entry ----------

// What a shell command prints of the environment (see environmentDumpIn), or "failed" when reading it hit an
// error. The parse may take steps in proportion to the command's length, so a long command is read in full
// here. One whose reading runs out of those steps, or nests shells deeper than the secret-file check reads,
// gets no answer here, and that check, which follows, stops it.
function dumpsEnvironment(tool, event, command) {
  // .NET hands PowerShell the whole environment from inside any expression, not only at a command start.
  if (/\[(?:System\.)?Environment\]::GetEnvironmentVariables\b/i.test(command)) return "all";
  const dialects = tool === "cursor" ? ["bash", "powershell"] : [claudeDialect(event)];
  const work = { left: SHELL_PARSE_MIN_STEPS + SHELL_PARSE_STEPS_PER_CHAR * command.length };
  try {
    // PowerShell ends a line at a lone CR, so it ends one here on every host.
    return environmentDumpIn(command.replace(/\r(?!\n)/g, "\n"), dialects, work);
  } catch (error) {
    return error instanceof ShellCheckTooLong ? null : "failed";
  }
}

// The shell Claude Code says runs the command.
function claudeDialect(event) {
  return event.tool_name === "PowerShell" ? "powershell" : "bash";
}
// ---------- Environment dump check ----------

const DRIVE_LISTERS = /^(?:Get-ChildItem|gci|ls|dir|Get-Item|gi)$/i;
// PowerShell's readers of a drive path's content, which print a variable's value from the env: drive.
const DRIVE_READERS = /^(?:Get-Content|gc|cat|type)$/i;
// PowerShell's commands that move into a folder. Moved onto the env: drive, a later listing prints every
// variable.
const LOCATION_SETTERS = /^(?:Set-Location|sl|cd|chdir|Push-Location|pushd)$/i;

function isOption(word) {
  return !word.quoted && /^[-+]/.test(word.value);
}

function isEnv(word) {
  return commandName(word.value).toLowerCase() === "env";
}

// A path on PowerShell's env: drive, and the one plain variable name it may be: `Env:PATH`, `env:\PATH`,
// `Env:ProgramFiles(x86)`.
const DRIVE_PATH = /^env:[\\/]?(.*)$/is;
const PLAIN_VARIABLE = /^\w+(?:\(\w+\))?$/;
// A guess from the name alone at a variable that holds a secret: one of these words in any case, `SK` as a
// whole part between underscores (`STRIPE_SK`, not `TASK_ID`), or a name ending in `_PWD` or `_PAT`. `PWD`
// and `OLDPWD` are the working folder, so they pass. KEY counts in a longer word too (`DEPLOY_KEYPAIR`,
// `JWT_KEYSET`), since a key's value is often named that way. A keyboard, a key's id and a vault's name hold
// no key, so those words pass when the word ends there, at an `_`, the name's end or a plural `S`, and a word
// that runs on (`KEYIDX`) still counts. A key file passes only at the name's end, because whatever follows it
// says what the file holds, often the key itself (`SSH_KEYFILE_DATA`). Its place (`KEYFILE_PATH`) passes as a
// place name.
const SECRET_NAME_WORDS = [
  "TOKEN",
  "SECRET",
  "KEY(?!(?:BOARD|ID|VAULT)S?(?:_|$)|FILES?$)",
  "PASS",
  "CREDENTIAL",
  "AUTH(?!OR(?!I[SZ]))",
  "PRIVATE",
  "DSN",
  "CONNECTION_STRING",
  "DATABASE_URL",
];
const SECRET_NAME = new RegExp(`${SECRET_NAME_WORDS.join("|")}|(?:^|_)SK(?:_|$)|_(?:PWD|PAT)$`, "i");
// A name that ends in a place holds where something is, not the thing: `SSH_AUTH_SOCK`, `PASSWORD_STORE_DIR`.
const PLACE_NAME = /_(?:SOCK|SOCKET|DIR|DIRS|PATH|FILE|HOME)$/i;

// What reading these variables by name prints: "unread" when a name isn't written out (`"$name"`, `${!x}`),
// "secret" when one looks like a secret's, or null.
function variableRisk(names) {
  if (names.some((name) => /[$`…]/.test(name))) return "unread";
  return names.some((name) => SECRET_NAME.test(name) && !PLACE_NAME.test(name)) ? "secret" : null;
}

// What a PowerShell listing given these words prints of the env: drive: "all" for any path on it that isn't
// one plain name (`Env:`, `Env:?*`, `Env:.`, `env:\..\`), else what reading the names it gives prints, or
// null for no path on it. A word with a group in it is read as written: `Env:ProgramFiles(x86)`.
function driveRead(args, text) {
  const names = [];
  for (const word of args) {
    const value = word.value.includes("…") ? text.slice(word.start, word.end) : word.value;
    for (const part of value.split(",")) {
      const onDrive = DRIVE_PATH.exec(part.trim());
      if (!onDrive) continue;
      if (!PLAIN_VARIABLE.test(onDrive[1]) && !onDrive[1].includes("$")) return "all";
      names.push(onDrive[1]);
    }
  }
  return names.length ? variableRisk(names) : null;
}

// What `export`, `declare` or `typeset` prints. `export` lists every variable bare or with `-p` alone, and
// `declare` and `typeset` bare or with `-p` or `-x`; `-f` makes them list functions. Given names, `-p` prints
// those.
function builtinPrints(name, options, names) {
  function has(letters) {
    return options.some((word) => new RegExp(`^-[A-Za-z]*[${letters}]`).test(word.value));
  }
  if (name === "export") {
    if (!options.every((word) => /^-p+$/.test(word.value))) return null;
  } else if (has("fF")) return null;
  if (!names.length) return name === "export" || options.length === 0 || has("px") ? "all" : null;
  return has("p") ? variableRisk(names.map((word) => word.value)) : null;
}

// Whether PowerShell's call operator `&` comes right before a word, so the quoted name is run. Without it, a
// quoted word that starts a statement is a string: `'env' >> .gitignore`.
function afterCallOperator(word, text) {
  let at = word.start - 1;
  while (at >= 0 && (text[at] === " " || text[at] === "\t")) at -= 1;
  return text[at] === "&" && text[at - 1] !== "&";
}

// The words with each PowerShell variable set earlier to a plain string (`$d = 'env:'`) read as that string.
function withVariables(args, vars) {
  return args.map((word) => {
    const value = !word.quoted && /^\$\w+$/.test(word.value) && vars.get(word.value.toLowerCase());
    return value === undefined || value === false ? word : { ...word, value };
  });
}

// What one parsed command prints of the environment: "all" of it, "secret" or "unread" for named variables
// (see variableRisk), or null. Wrappers, variables set first and redirections are passed over as commandStart
// does, and the lead-ins leadInRuns knows too, so the command they run is read. Since `env` is one of those
// wrappers, an `env` with no command after it is the dump. `env` is found under any case, as on macOS and in
// Git Bash. In PowerShell a quoted word that starts the command is a string unless `&` runs it.
// `context.vars`: PowerShell variables set to a string; `context.readText(text, dialect)`: what a line a
// lead-in hands a shell prints.
function environmentPrinted(words, dialect, text, context) {
  const quotedString = dialect === "powershell" && words.length && words[0].quoted;
  if (quotedString && !afterCallOperator(words[0], text)) return null;
  const nameAt = commandStart(words, dialect);
  if (nameAt >= words.length) {
    return words.some((word, at) => at < nameAt && isEnv(word) && !shellRedirection(word)) ? "all" : null;
  }
  const head = beforeRedirection(words[nameAt]);
  const name = commandName(head.value)
    .toLowerCase()
    .replace(dialect === "cmd" ? /^@+/ : /^$/, "");
  if (name === "env") return envPrints(words, nameAt + 1, dialect, text, context);
  if (nameAt > 0 && isEnv(words[nameAt - 1]) && isOption(words[nameAt])) {
    return envPrints(words, nameAt, dialect, text, context);
  }
  const inner = leadInRuns(words, nameAt, name, dialect);
  if (inner?.text !== undefined) return context.readText(inner.text, inner.dialect);
  if (inner) return environmentPrinted(words.slice(inner.from, inner.to), dialect, text, context);
  const args = argumentsAfter(words, nameAt);
  const names = args.filter((word) => !isOption(word));
  if (codePrintsEnvironment(name, args)) return "all";
  if (name === "ps" && psShowsEnvironment(args, dialect)) return "all";
  if (name === "printenv") return names.length ? variableRisk(names.map((word) => word.value)) : "all";
  if (DRIVE_LISTERS.test(name) || (dialect === "powershell" && DRIVE_READERS.test(name))) {
    return driveRead(withVariables(args, context.vars), text);
  }
  if (dialect === "powershell" && LOCATION_SETTERS.test(name)) {
    return withVariables(args, context.vars).some((word) => /^env:/i.test(word.value)) ? "all" : null;
  }
  // `export`, `set`, `declare` and `typeset` are builtins, which have no folder, so `./export` is a program
  // of its own.
  if (/[\\/]/.test(head.value)) return null;
  if (name === "set") {
    if (dialect === "cmd") return cmdSetPrints(args, text);
    return args.length === 0 ? "all" : null;
  }
  if (name === "export" || name === "declare" || name === "typeset") {
    return builtinPrints(name, args.filter(isOption), names);
  }
  return null;
}

// What `env` prints given its words from `at`: every variable when it has no command to run and none of `-i`,
// `-`, `--help` or `--version`, else what the command it runs prints. `-u`, `-C` and `-S` take a value, and
// `-S` runs it.
function envPrints(words, at, dialect, text, context) {
  const options = { short: "uCS", long: ["--unset", "--chdir", "--split-string"] };
  const end = pastOptions(words, at, options);
  const given = words.slice(at, end).filter((word) => !word.quoted);
  if (given.some((word) => /^(?:-i|--ignore-environment|-|--help|--version)$/.test(word.value))) return null;
  const split = given.findIndex((word) => /^(?:-S|--split-string)$/.test(word.value));
  if (split >= 0 && words[at + split + 1]) return context.readText(words[at + split + 1].value, "bash");
  let from = end;
  while (from < words.length && (shellRedirection(words[from]) || /^\w+=/.test(words[from].value))) {
    from += shellRedirection(words[from]) === "word" ? 2 : 1;
  }
  if (from >= words.length) return "all";
  return environmentPrinted(words.slice(from), dialect, text, context);
}

// Windows' own variable names, some set system-wide and some only on 64-bit Windows. `set` with one of them
// written whole passes, though it prints every name that starts with it, so `set OS` still prints a variable
// of yours like `OS_PASSWORD`.
const CMD_PLAIN_PREFIXES = new RegExp(
  `^(?:${[
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "WINDIR",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMPUTERNAME",
    "LOGONSERVER",
    "OS",
    "USERNAME",
    "USERPROFILE",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PROGRAMDATA",
    "PROGRAMFILES(?:\\(X86\\))?",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES(?:\\(X86\\))?",
    "COMMONPROGRAMW6432",
    "PSMODULEPATH",
    "DRIVERDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
  ].join("|")})$`,
  "i",
);

// What cmd's `set` given these words prints: every variable bare, and every one whose name starts with the
// word given (`set G`). A prefix counts as "all" unless it's one of Windows' own plain names written whole,
// since a short one or one like `GITHUB` can start a secret's name. `set x=1` sets one, and `/a` and `/p`
// work out or ask for a value. cmd splits words at `=`, so the text as written is read.
function cmdSetPrints(args, text) {
  if (args.length === 0) return "all";
  const written = text.slice(args[0].start, args[args.length - 1].end);
  if (written.startsWith("/") || written.includes("=")) return null;
  return CMD_PLAIN_PREFIXES.test(written) ? null : "all";
}

// What shell text prints of the environment, as each of `dialects` splits it (see environmentPrinted): at any
// command start, in a group or a substitution, in what a here-document's `$(…)` runs, in a shell the command
// runs on one line and in one line a shell is fed. Text on its own lines is read by DUMP_LINE alone (see
// textDumpIn).
function environmentDumpIn(text, dialects, work, depth = 0) {
  function readText(inner, innerDialect) {
    // Shells nested deeper than the secret-file check reads are stopped by it, so this check stops reading
    // too.
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    return environmentDumpIn(inner, [innerDialect], work, depth + 1);
  }
  for (const dialect of shellsThatParse(text, dialects)) {
    const { commands, unclosed, stray, textOnly } = parseShellCommands(text, dialect, work);
    if (dialect === "powershell" && dialects.length > 1 && (unclosed || stray)) continue;
    const context = { vars: new Map(), readText };
    const written = new Map();
    for (let i = 0; i < commands.length; i += 1) {
      const found =
        environmentDumpInCommand(commands[i], text, dialect, work, depth, context) ||
        fedLinesPrint(commands, i, dialect, written, readText);
      if (found) return found;
      noteWrites(commands[i].words, dialect, context.vars, written);
    }
    if (textDumpIn(commands.concat(textOnly), text)) return "all";
  }
  return null;
}

function environmentDumpInCommand(command, text, dialect, work, depth, context) {
  const found = environmentPrinted(command.words, dialect, text, context);
  if (found) return found;
  for (const lines of command.expands.filter((each) => /\$\(|`/.test(each))) {
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    for (const inner of parseShellCommands(lines, dialect, work, { body: true }).commands) {
      const innerFound = environmentPrinted(inner.words, dialect, lines, context);
      if (innerFound) return innerFound;
    }
  }
  const nameAt = commandStart(command.words, dialect);
  for (let at = 0; at <= nameAt && at < command.words.length; at += 1) {
    // A shell's text on its own lines, a here-document or a quoted word over several lines, is left to
    // textDumpIn.
    const texts = nestedShellTexts(command.words, at, dialect, []).filter(([inner]) => !inner.includes("\n"));
    for (const [inner, innerDialect] of texts) {
      const innerFound = context.readText(inner, innerDialect);
      if (innerFound) return innerFound;
    }
  }
  return null;
}

// The one line `echo`, `printf` or a PowerShell string writes, or null for another command: `echo env`,
// `printf 'env\n'`, `'gci env:'`.
function lineWritten(words, dialect) {
  const nameAt = commandStart(words, dialect);
  if (dialect === "powershell" && words.length === 1 && words[0].quoted) return words[0].value;
  if (nameAt >= words.length) return null;
  const name = commandName(words[nameAt].value).toLowerCase();
  const args = argumentsAfter(words, nameAt);
  if (name === "echo" || (dialect === "powershell" && name === "write-output")) {
    const from = dialect === "bash" ? args.findIndex((word) => !/^-[neE]+$/.test(word.value)) : 0;
    if (from < 0) return "";
    return args
      .slice(from)
      .map((word) => word.value)
      .join(" ");
  }
  if (name !== "printf" || dialect !== "bash" || !args.length) return null;
  const fills = args.slice(1).map((word) => word.value);
  return args[0].value
    .replace(/%s/g, () => fills.shift() ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

// A shell that reads its commands from its input or from a file: `bash`, `sh -s`, `pwsh -`, `iex`, `source
// f`, `. f` or a script run by its path. Gives the shell's dialect and the file, or no file for its input.
function shellFed(words, dialect) {
  const nameAt = commandStart(words, dialect);
  if (nameAt >= words.length) return null;
  const head = words[nameAt];
  const name = commandName(head.value);
  const args = argumentsAfter(words, nameAt);
  if (dialect === "bash" && (name === "source" || name === ".")) {
    return args.length ? { dialect, file: args[0] } : null;
  }
  if (/[\\/]/.test(head.value) && /^\.{0,2}[\\/]/.test(head.value)) return { dialect, file: head };
  const invoker = SHELL_INVOKERS.find((entry) => entry.name.test(name) && entry.dialect && entry.dialect !== "cmd");
  if (!invoker) return null;
  if (invoker.run && args.some((word) => !word.quoted && invoker.run.test(word.value))) return null;
  const operands = args.filter((word) => !isOption(word) && word.value !== "-");
  return { dialect: invoker.dialect, file: operands[0] || null };
}

// What a one-line text a shell is fed prints: a line piped in or given as a here-string (`echo env | bash`,
// `bash <<< env`), or a script written on one line earlier in the command and then run (`echo env > e.sh; sh
// e.sh`). Text on its own lines is left to textDumpIn.
function fedLinesPrint(commands, i, dialect, written, readText) {
  const fed = shellFed(commands[i].words, dialect);
  if (!fed) return null;
  const lines = [];
  if (fed.file) lines.push(written.get(fed.file.value.replace(/^\.[\\/]/, "")));
  else {
    if (commands[i].piped && i > 0) lines.push(lineWritten(commands[i - 1].words, dialect));
    lines.push(...commands[i].hereStrings.map((word) => word.value));
  }
  for (const line of lines) {
    if (typeof line !== "string" || !line.trim() || line.trim().includes("\n")) continue;
    const found = readText(line, fed.dialect);
    if (found) return found;
  }
  return null;
}

// Notes what a command leaves for later ones: a PowerShell variable set to a string, and a file `echo` or
// `printf` writes one line to.
function noteWrites(words, dialect, vars, written) {
  const setsString = words.length === 3 && /^\$\w+$/.test(words[0].value) && words[1].value === "=";
  if (dialect === "powershell" && setsString) vars.set(words[0].value.toLowerCase(), words[2].value);
  const line = lineWritten(words, dialect);
  if (line === null) return;
  for (let at = 0; at < words.length; at += 1) {
    if (words[at].quoted) continue;
    const file = fileWrittenAt(words, at);
    if (file) written.set(file.replace(/^\.[\\/]/, ""), line);
  }
}

// The file an output redirection at `at` writes to, glued on (`>e.sh`) or the next word; null for none.
function fileWrittenAt(words, at) {
  const glued = /^1?>>?(.+)$/.exec(words[at].value);
  if (glued) return glued[1];
  return /^1?>>?$/.test(words[at].value) ? words[at + 1]?.value : null;
}

// A line, or a part after `;`, `&` or `|`, that starts with a dump: a bare `env`, `export` or `set`, any
// `printenv`, `declare -p` and the like, or an `Env:` listing. It's the whole test for text on its own lines.
const DUMP_LINE = new RegExp(
  String.raw`(?:^|[;&|\n])[^\S\r\n\u2028\u2029]*(?:` +
    [
      String.raw`export(?=\s*(?:[;&|\n]|$))`,
      String.raw`(?:declare|typeset|export)\s+-p\b`,
      String.raw`env(?:\s+-0)?(?=\s*(?:[;&|\n]|$))`,
      String.raw`printenv(?:\s+[^;&|\n]+)?`,
      String.raw`set(?=\s*(?:[;&|\n]|$))`,
      String.raw`(?:Get-ChildItem|Get-Item|gci|ls|dir)\s+(?:-(?:Literal)?Path\s+)?Env:`,
    ].join("|") +
    ")",
  "im",
);

// Whether text on its own lines in parsed commands, a here-document, a here-string or a quoted word written
// over more than one line, has a line DUMP_LINE stops, as written with its quotes. Where the text goes isn't
// asked: a note with a bare `env` line is stopped, and a script with `sudo env` that a shell runs isn't.
function textDumpIn(commands, text) {
  let stops = null;
  function dumpLine(word) {
    if (!(word.end > word.start)) return false;
    if (stops === null) stops = nextStops(text, "\n");
    return stops[word.start] < word.end && DUMP_LINE.test(text.slice(word.start, word.end));
  }
  function commandHasDumpLine(command) {
    if (command.heredocs.some((value) => DUMP_LINE.test(value))) return true;
    if (command.hereStrings.some(dumpLine)) return true;
    return command.words.some((word) => word.partQuoted && dumpLine(word));
  }
  return commands.some(commandHasDumpLine);
}

// ---------- Environment printers ----------

// Node's and Python's whole environment, not one name of it.
const NODE_WHOLE_ENV = /\bprocess\.env\b(?!\s*(?:\??\.|\[))/;
const PYTHON_WHOLE_ENV = /\benviron\b(?!\s*(?:\[|\.(?:get|setdefault|pop)\b))/;

// Code in another language, given on the command line, that prints every variable: Node's `process.env`,
// Python's `os.environ`, Perl's `%ENV`, jq's `env` or `$ENV`, awk's `ENVIRON`, each whole rather than one
// name of it.
const WHOLE_ENVIRONMENT_CODE = [
  { name: /^(?:node|nodejs)$/, code: /^(?:-e|--eval|-p|--print|-pe|-ep)$/, all: NODE_WHOLE_ENV },
  { name: /^(?:python[\d.]*|py)$/, code: /^-[A-Za-z]*c$/, all: PYTHON_WHOLE_ENV },
  { name: /^perl$/, code: /^-[A-Za-z]*[eE]$/, all: /%ENV\b/ },
  { name: /^(?:jq|gojq)$/, all: /(?:^|[^.\w$"])env\b(?!\s*[.["])|\$ENV\b(?!\s*[.[])/ },
  { name: /^(?:awk|gawk|mawk|nawk)$/, all: /\bENVIRON\b(?!\s*\[)/ },
];
const JQ_OPTIONS = { short: "L", long: ["--indent", "--arg", "--argjson", "--slurpfile", "--rawfile"] };
const AWK_OPTIONS = { short: "Fv", long: ["--field-separator", "--assign"] };

// Whether a program's one-line code prints the whole environment. `args` are its words past its name.
function codePrintsEnvironment(name, args) {
  const entry = WHOLE_ENVIRONMENT_CODE.find((each) => each.name.test(name));
  if (!entry) return false;
  if (entry.code) {
    const printsAll = (word, at) => entry.code.test(word.value) && entry.all.test(args[at + 1]?.value || "");
    return args.some((word, at) => !word.quoted && printsAll(word, at));
  }
  // jq's filter and awk's program are the first word that isn't an option, unless a file gives them (`-f`).
  if (args.some((word) => !word.quoted && /^(?:-f|--from-file|--file)$/.test(word.value))) return false;
  const options = name.endsWith("awk") ? AWK_OPTIONS : JQ_OPTIONS;
  let at = 0;
  while (at < args.length && !args[at].quoted && /^-./.test(args[at].value)) {
    at += optionWordCount(args[at].value, options);
  }
  return at < args.length && entry.all.test(args[at].value);
}

// How many words a jq or awk option takes up: jq's named arguments take two values.
function optionWordCount(value, options) {
  if (/^--(?:arg|argjson|slurpfile|rawfile)$/.test(value)) return 3;
  return takesValue(value, options) ? 2 : 1;
}

// Whether `ps` is given BSD's `e`, which adds each process's environment: `ps e`, `ps eww`, `ps auxe`. Only
// letters that go with `e` count, so `ps user` isn't it. PowerShell's `ps` is Get-Process, which takes a
// process's name.
function psShowsEnvironment(args, dialect) {
  if (dialect === "powershell" || args.length === 0 || args[0].quoted) return false;
  return /^[acfhjlmnrSTuvwxZ]*e[acefhjlmnrSTuvwxZ]*$/.test(args[0].value);
}

module.exports = {
  dumpsEnvironment,
  claudeDialect,
  DRIVE_LISTERS,
  DRIVE_READERS,
  LOCATION_SETTERS,
  isOption,
  isEnv,
  DRIVE_PATH,
  PLAIN_VARIABLE,
  SECRET_NAME_WORDS,
  SECRET_NAME,
  PLACE_NAME,
  variableRisk,
  driveRead,
  builtinPrints,
  afterCallOperator,
  withVariables,
  environmentPrinted,
  envPrints,
  cmdSetPrints,
  environmentDumpIn,
  environmentDumpInCommand,
  lineWritten,
  shellFed,
  fedLinesPrint,
  noteWrites,
  DUMP_LINE,
  textDumpIn,
  codePrintsEnvironment,
  psShowsEnvironment,
};

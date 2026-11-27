"use strict";
/* global require, module, Buffer */

const path = require("path");

// ---------- Command names and words ----------

// Words before a command that run it as it is: `sudo cat`, `time cat`, `{ cat`, `if cat`.
const SHELL_WRAPPER_WORD = /^(?:sudo|command|exec|nohup|time|env|builtin|\{|!|if|then|else|elif|do|while|until)$/i;
// A word that's an output redirection (PowerShell's `*>` too), or `<&`, with its target in the next word
// (`2>`, `&>`), or with it joined on (`2>/dev/null`, `2>&1`, `>|log`).
const SHELL_REDIRECTION_WORD = /^(?:\d*|\*|\{\w+\})(?:&>>?|>>?|>&|>\||<&)$/;
const SHELL_REDIRECTION_AT = /^(?:\d*|\*|\{\w+\})(?:&>>?|>>?|>&|>\||<&)./;
const SHELL_REDIRECTION_HEAD = /^(?:\d*|\*|\{\w+\})(?:&>>?|>>?|>&|>\||<&)/;

// A command's name without its folder or .exe: `/usr/bin/cat` and `cat.exe` are cat.
function commandName(value) {
  const base = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  return base.replace(/\.exe$/i, "");
}

// Where a command's own name is, past the words that only run it (`sudo`, `env`, `cmd /c`), variables it sets
// and redirections before it (`2>/dev/null cat`). A wrapper word may be quoted or escaped, as in `"sudo" cat`
// or `\time cat`: the shell takes its quotes off before it looks the word up. A quoted `x=1` is a command's
// name, not a variable.
function commandStart(words, dialect, from = 0) {
  let index = from;
  while (index < words.length) {
    const { value, quoted } = words[index];
    const hasNext = index + 1 < words.length;
    if (SHELL_WRAPPER_WORD.test(value)) index += 1;
    else if (!quoted && SHELL_REDIRECTION_WORD.test(value) && hasNext) index += 2;
    else if (!quoted && SHELL_REDIRECTION_AT.test(value)) index += 1;
    else if (quoted && !/^cmd$/i.test(commandName(value))) break;
    else if (dialect === "bash" && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(value)) index += 1;
    // `function f { cat .env; }`: the body's first command comes after the name.
    else if (dialect === "bash" && !quoted && value === "function" && hasNext) index += 2;
    else if (dialect === "powershell" && /^\$[^=]*[-+*/%?]?=$/.test(value)) index += 1;
    else if (
      dialect === "powershell" &&
      /^\$\S+$/.test(value) &&
      hasNext &&
      /^[-+*/%?]?=$/.test(words[index + 1].value)
    ) {
      index += 2;
    } else if (/^cmd$/i.test(commandName(value)) && hasNext && CMD_SWITCHES.test(words[index + 1].value)) {
      const past = pastCmdSwitches(words, index);
      if (past < 0) break;
      index = past;
    } else break;
  }
  return index;
}

// Whether the shell takes a parsed word as a redirection: "word" for one with its target in the next word,
// "at" for one with its target joined on, or null. Its operator can't be quoted or escaped (`2\>x`, `"2>x"`),
// but its target can (`2>"/dev/null"`). A word that isn't the parser's own, a PowerShell group's value, is no
// redirection.
function shellRedirection(word) {
  if (word.quoted || word.quotedAt === undefined) return null;
  if (SHELL_REDIRECTION_WORD.test(word.value)) return word.quotedAt === -1 ? "word" : null;
  const head = SHELL_REDIRECTION_HEAD.exec(word.value);
  if (!head || (word.quotedAt !== -1 && word.quotedAt < head[0].length)) return null;
  return "at";
}

// A command's words with each PowerShell group's words right after the word it's in, so a group that's a
// copy's last word stays its destination.
function withGroupValues(words) {
  return words.flatMap((word) => (word.values ? [word, ...word.values] : [word]));
}

// ---------- Shells inside shells ----------

// PowerShell's -Command, as short as it takes it: -c, -co, ... -command.
const POWERSHELL_COMMAND_SWITCH = /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i;
// Shells that run the text they're given: the switch that names that text, and the quote rules it's read
// with.
const SHELL_INVOKERS = [
  { name: /^(?:ba|z|da|k|mk|a|fi)?sh$/i, dialect: "bash", run: /^-[A-Za-z]*c[A-Za-z]*$/ },
  { name: /^(?:pwsh|powershell)$/i, dialect: "powershell", run: POWERSHELL_COMMAND_SWITCH },
  { name: /^cmd$/i, dialect: "cmd", run: /^\/\/?[ckr]$/i },
  { name: /^wsl$/i, dialect: "bash", run: /^(?:-e|--exec|--)$/ },
  { name: /^eval$/i, dialect: null, run: null },
  { name: /^(?:iex|Invoke-Expression)$/i, dialect: "powershell", run: null },
];
// PowerShell's -EncodedCommand and its short forms, whose text is Base64 of UTF-16.
const POWERSHELL_ENCODED =
  /^[-/](?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)$/i;
// cmd's /c, /k or /r with other switches or its text glued on: `/d/c`, `/v:on/c`, `/ctype`, and Git Bash's
// `//ctype` (see CMD_SWITCHES). Anchored, and each repeat is one switch with any value up to the next `/`, so
// it can't backtrack more than the word is long.
const CMD_GLUED_RUN = /^(?:\/+[a-z](?::[^/\s]*)?)*?\/+[ckr]/i;
// A word of cmd switches alone, `/d`, `/d/c`, `/v:on/c`, and the ones ending in /c, /k or /r. Git Bash turns
// a leading `//c` into `/c` for a Windows program, and cmd reads `///c` as `/c` too, so any run of slashes
// counts.
const CMD_SWITCHES = /^(?:\/+[a-z](?::[^/\s]*)?)+$/i;
const CMD_RUN_LAST = /\/[ckr]$/i;
// How deep shells inside shells (`bash -c "pwsh -c '…'"`) are read.
const SHELL_NEST_MAX = 4;

// `cmd /d /s /c type .env`, `cmd /d/c type .env`: past the switches up to /c or /k, where the command it runs
// starts; -1 when no /c or /k ends them.
function pastCmdSwitches(words, cmdAt) {
  let at = cmdAt + 1;
  while (at < words.length && CMD_SWITCHES.test(words[at].value) && !CMD_RUN_LAST.test(words[at].value)) {
    at += 1;
  }
  if (at >= words.length || !CMD_SWITCHES.test(words[at].value) || !CMD_RUN_LAST.test(words[at].value)) return -1;
  return at + 1;
}

// The texts a shell inside the command will run, with the rules it reads them by: `bash -c '…'`, `pwsh
// -Command …`, `cmd /c …`, `eval …`, a shell given a here-document.
function nestedShellTexts(words, nameAt, dialect, heredocs) {
  const name = commandName(words[nameAt].value);
  const invoker = SHELL_INVOKERS.find((entry) => entry.name.test(name));
  if (!invoker) return [];
  const inner = invoker.dialect || dialect;
  const rest = words.slice(nameAt + 1);
  const texts = [];
  const at = invoker.run ? rest.findIndex((word) => !word.quoted && invoker.run.test(word.value)) : -1;
  texts.push(
    rest
      .slice(at + 1)
      .map((word) => word.value)
      .join(" "),
  );
  // cmd also finds /c or /k glued to the text it runs or to the switches before it: `cmd /c"type .env"`,
  // `cmd /ctype .env`, `cmd /d/c type .env`.
  if (invoker.dialect === "cmd") {
    const glued = rest.findIndex((word) => CMD_GLUED_RUN.test(word.value) && !invoker.run.test(word.value));
    if (glued >= 0 && (at < 0 || glued < at)) {
      const { value } = rest[glued];
      const after = value.slice(CMD_GLUED_RUN.exec(value)[0].length);
      const following = rest.slice(glued + 1);
      texts.push([after, ...following.map((word) => word.value)].join(" "));
      // In a cmd terminal, `cmd /ctype "a&b" .env` keeps its quotes, so the `&` inside them ends nothing.
      // Read both ways: from Bash, a quoted `&` with no blank space reaches cmd bare and does end a command.
      if (following.some((word) => word.quoted)) {
        texts.push([after, ...following.map((word) => (word.quoted ? `"${word.value}"` : word.value))].join(" "));
      }
    }
  }
  if (at < 0) {
    for (const word of rest) if (/[\s;&|<>()`]/.test(word.value)) texts.push(word.value);
  }
  if (inner === "powershell") {
    const encoded = rest.findIndex((word) => POWERSHELL_ENCODED.test(word.value));
    if (encoded >= 0 && encoded + 1 < rest.length) {
      texts.push(Buffer.from(rest[encoded + 1].value, "base64").toString("utf16le"));
    }
  }
  texts.push(...heredocs);
  return texts.map((text) => [text, inner]);
}

// ---------- Lead-ins ----------

// Options of a lead-in that take the next word as their value, unless it's glued on (`-uroot`,
// `--user=root`). `short` holds the letters, `long` the names. `all`: every option takes a value but the
// flags listed.
function takesValue(value, { short = "", long = [], all = false }) {
  if (value.startsWith("--")) return !value.includes("=") && (all ? !long.includes(value) : long.includes(value));
  if (all) return [...value.slice(1)].some((letter) => !short.includes(letter));
  return value.length === 2 && short.includes(value[1]);
}

// The index of the first word past a lead-in's options, from `at`. A `--` ends them.
function pastOptions(words, from, options) {
  let at = from;
  while (at < words.length && !words[at].quoted && /^-./.test(words[at].value)) {
    if (words[at].value === "--") return at + 1;
    at += takesValue(words[at].value, options) ? 2 : 1;
  }
  return at;
}

const SUDO_OPTIONS = {
  short: "ugCprtUDRTh",
  long: ["--user", "--group", "--close-from", "--prompt", "--role", "--type", "--other-user", "--chdir", "--host"],
};
const DOCKER_GLOBAL = { short: "cHl", long: ["--context", "--host", "--log-level", "--config"] };
const COMPOSE_GLOBAL = {
  short: "fp",
  long: ["--file", "--project-name", "--profile", "--env-file", "--project-directory"],
};
const DOCKER_EXEC = { short: "euw", long: ["--env", "--env-file", "--user", "--workdir", "--detach-keys", "--index"] };
// `docker run` and `compose run` have many options with values, so all but these flags take one.
const DOCKER_RUN = {
  all: true,
  short: "dirtPT",
  long: ["--rm", "--init", "--privileged", "--read-only", "--detach", "--interactive", "--tty", "--publish-all"].concat(
    ["--no-deps", "--service-ports", "--use-aliases", "--no-TTY", "--build", "--remove-orphans"],
  ),
};
const SSH_OPTIONS = { short: "bcDEeFIiJLlmOopQRSWwB" };

// What a lead-in runs: `{ from, to }`, the words of the command it runs as given, or `{ text, dialect }`, a
// line a shell runs, or null. `nameAt` is where the lead-in's name is, as commandStart finds it, and `name`
// its name in lower case. A `sudo` that commandStart passed over leaves `nameAt` at its first option.
function leadInRuns(words, nameAt, name, dialect) {
  const afterSudo = nameAt > 0 && /^(?:sudo|doas)$/i.test(commandName(words[nameAt - 1].value));
  if (afterSudo && /^-./.test(words[nameAt].value)) {
    return { from: pastOptions(words, nameAt, SUDO_OPTIONS), to: words.length };
  }
  function from(at) {
    return { from: at, to: words.length };
  }
  if (name === "nice") return from(pastOptions(words, nameAt + 1, { short: "n", long: ["--adjustment"] }));
  if (name === "timeout") {
    // The time limit comes after the options, then the command.
    return from(pastOptions(words, nameAt + 1, { short: "sk", long: ["--signal", "--kill-after"] }) + 1);
  }
  if (name === "xargs") {
    const long = ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars"];
    return from(pastOptions(words, nameAt + 1, { short: "adEILnPs", long }));
  }
  if (name === "call" && dialect === "cmd") return from(nameAt + 1);
  if (name === "find") return findExecRuns(words, nameAt);
  if (name === "watch") {
    const at = pastOptions(words, nameAt + 1, { short: "nq", long: ["--interval", "--equexit"] });
    return lineOf(words.slice(at));
  }
  if (name === "ssh") return lineOf(words.slice(pastOptions(words, nameAt + 1, SSH_OPTIONS) + 1));
  if (name === "kubectl" && words[nameAt + 1]?.value === "exec") {
    const dashes = words.findIndex((word, at) => at > nameAt && !word.quoted && word.value === "--");
    return dashes > 0 ? from(dashes + 1) : null;
  }
  const container = name === "docker" || name === "podman" || name === "docker-compose";
  if (container) return containerRuns(words, nameAt, name);
  return null;
}

// find's tests that run a command on what it finds.
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;

// The words `find -exec` and the like run, up to the `;` or `+` that ends them.
function findExecRuns(words, nameAt) {
  const execAt = (word, index) => index > nameAt && !word.quoted && FIND_EXEC.test(word.value);
  const at = words.findIndex(execAt);
  if (at < 0) return null;
  let to = at + 1;
  while (to < words.length && !/^(?:;|\+)$/.test(words[to].value)) to += 1;
  return { from: at + 1, to };
}

// A line a shell runs, from words a program joins with spaces (`ssh host env`, `watch env`), or null for
// none. Text on its own lines is left to the line test, as for `bash -c`.
function lineOf(words) {
  const line = words.map((word) => word.value).join(" ");
  return line.trim() && !line.includes("\n") ? { text: line, dialect: "bash" } : null;
}

// The words `docker exec`, `docker run`, `docker compose exec` or `run` start in the container, past the
// container, image or service name.
function containerRuns(words, nameAt, name) {
  let at = name === "docker-compose" ? nameAt + 1 : pastOptions(words, nameAt + 1, DOCKER_GLOBAL);
  if (name !== "docker-compose" && words[at]?.value === "compose") at = pastOptions(words, at + 1, COMPOSE_GLOBAL);
  else if (name === "docker-compose") at = pastOptions(words, at, COMPOSE_GLOBAL);
  const sub = words[at]?.value;
  if (sub !== "exec" && sub !== "run") return null;
  const target = pastOptions(words, at + 1, sub === "exec" ? DOCKER_EXEC : DOCKER_RUN);
  return target + 1 < words.length ? { from: target + 1, to: words.length } : null;
}

// ---------- Start-Process ----------

// Start-Process and its aliases, its parameters that take a value, and those that don't. Some names stand for
// another one (`-Args` is `-ArgumentList`). PowerShell takes any start of a name that only one name has.
const START_PROCESS = /^(?:start-process|saps|start)$/i;
const START_SAME = { pspath: "filepath", path: "filepath", args: "argumentlist", rsi: "redirectstandardinput" };
const START_VALUES = [
  ...["filepath", "pspath", "path", "argumentlist", "args", "credential", "workingdirectory", "verb", "windowstyle"],
  ...["redirectstandarderror", "rse", "redirectstandardinput", "rsi", "redirectstandardoutput", "rso", "environment"],
  ...["erroraction", "ea", "warningaction", "wa", "informationaction", "infa", "progressaction", "proga"],
  ...["errorvariable", "ev", "warningvariable", "wv", "informationvariable", "iv", "outvariable", "ov"],
  ...["outbuffer", "ob", "pipelinevariable", "pv"],
];
const START_SWITCHES = [
  ...["loaduserprofile", "lup", "nonewwindow", "nnw", "passthru", "wait", "usenewenvironment"],
  ...["whatif", "wi", "confirm", "cf", "verbose", "vb", "debug", "db"],
];

// A Start-Process parameter word, as { name } for one that takes a value (its full name, or "other" when the
// start given fits more than one), with `glued` for a value after a colon (`-FilePath:cat`), or { name: null }
// for a switch or a name Start-Process doesn't have. Not a parameter at all: null.
function startParameter(value) {
  const match = /^[-–—]([A-Za-z]+)(?::([\s\S]*))?$/.exec(value);
  if (!match) return null;
  const given = match[1].toLowerCase();
  const all = START_VALUES.concat(START_SWITCHES);
  const fits = all.includes(given) ? [given] : all.filter((name) => name.startsWith(given));
  if (!fits.length || fits.some((name) => START_SWITCHES.includes(name))) return { name: null };
  const names = new Set(fits.map((name) => START_SAME[name] || name));
  return { name: names.size === 1 ? [...names][0] : "other", glued: match[2] };
}

// What a Start-Process command runs, as the text of its program and arguments, and the file it gives the
// program as input (`-RedirectStandardInput`), or null when the words aren't one. Without names, the first
// value is the program and the next its arguments. An argument list may be a comma list, `'-c','cat .env'`:
// each word but the last is marked `listed` by the parser.
function startedProcess(words, nameAt) {
  if (words[nameAt].quoted || !START_PROCESS.test(words[nameAt].value)) return null;
  const given = { filepath: [], argumentlist: [], redirectstandardinput: [] };
  const loose = [];
  for (let at = nameAt + 1; at < words.length;) {
    const parameter = words[at].quoted ? null : startParameter(words[at].value);
    if (parameter && !parameter.name) {
      at += 1;
      continue;
    }
    let values;
    if (parameter && parameter.glued) {
      values = [parameter.glued];
      at += 1;
    } else {
      let end = parameter ? at + 1 : at;
      while (end < words.length - 1 && words[end].listed) end += 1;
      values = words.slice(parameter ? at + 1 : at, end + 1).map((word) => word.value);
      at = end + 1;
    }
    if (!parameter) loose.push(values);
    else if (given[parameter.name]) given[parameter.name].push(...values);
  }
  if (!given.filepath.length && loose.length) given.filepath.push(...loose.shift());
  for (const values of loose) given.argumentlist.push(...values);
  const program = given.filepath[0];
  if (!program) return null;
  const shown = /\s/.test(program) ? `'${program.replace(/'/g, "''")}'` : program;
  return { text: [shown, ...given.argumentlist].join(" "), input: given.redirectstandardinput[0] || null };
}

// ---------- Inline code ----------

// A name in quotes inside inline code, its quotes escaped or not: `'.env'`, `".env"`, `` `.env` ``, `\".env\"`.
// A long run of backslashes is read once, not once for each backslash in it: the name ends in something other
// than a backslash or is one backslash, and a match starts only where a run of backslashes does.
const CODE_STRING = String.raw`(?<!\\)\\*(['"${"`"}])([^'"${"`"}]*?[^'"${"`"}\\]|\\)\\*\1`;
const CODE_OPENS = String.raw`\b(?:open|readFileSync|readFile|createReadStream)\s*\(\s*`;
const CODE_OPEN_STRING = new RegExp(CODE_OPENS + CODE_STRING, "gi");
// pathlib: `Path(".env").read_text()`, `pathlib.Path('.env').read_bytes()`, `Path('.env').open()`.
const CODE_PATH_READ = new RegExp(
  String.raw`\bPath\s*\(\s*${CODE_STRING}\s*\)\s*\.\s*(?:read_text|read_bytes|open)\s*\(`,
  "g",
);
// A path joined in the call: `open(os.path.join('.', '.env'))`, or node's readFileSync of `__dirname` and `'.env'`
// joined by path.join.
const CODE_OPEN_JOIN = new RegExp(String.raw`${CODE_OPENS}(?:os\.)?path\.join\s*\(([^()]*)\)`, "gi");
// A variable given to the call, `readFileSync(p)`, and where the code sets it to a name, `const p='.env'`.
const CODE_OPEN_NAME = new RegExp(String.raw`${CODE_OPENS}([A-Za-z_$][\w$]*)\s*[,)]`, "gi");
// A name set to a quoted string in inline code, `p = '.env'`, where the name isn't part of a longer name or a
// property (`a.p`). Same case as written.
const CODE_SET_NAME = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*/g;
const CODE_SET_STRING = new RegExp(CODE_STRING, "y");

// The file names inline code in a command opens: `python -c "print(open(\".env\").read())"`, pathlib, a
// joined path, node's `fs.readFileSync(".env")` or one given through a variable. A joined path keeps only its
// quoted parts, so `__dirname` joined with `'.env'` is `.env`, as `__dirname` is the working folder for `node -e`.
function embeddedReaders(command) {
  const names = [];
  for (const match of command.matchAll(CODE_OPEN_STRING)) names.push(match[2]);
  for (const match of command.matchAll(CODE_PATH_READ)) names.push(match[2]);
  for (const match of command.matchAll(CODE_OPEN_JOIN)) {
    const parts = [...match[1].matchAll(new RegExp(CODE_STRING, "g"))].map((part) => part[2]);
    if (parts.length) names.push(path.posix.join(...parts));
  }
  let values = null;
  for (const match of command.matchAll(CODE_OPEN_NAME)) {
    values = values || codeAssignments(command);
    if (values.has(match[1])) names.push(values.get(match[1]));
  }
  return names;
}

// Each name inline code sets to a quoted string, and the string it's set to first, read in one pass over the
// code.
function codeAssignments(command) {
  const values = new Map();
  for (const match of command.matchAll(CODE_SET_NAME)) {
    if (values.has(match[1])) continue;
    CODE_SET_STRING.lastIndex = match.index + match[0].length;
    const set = CODE_SET_STRING.exec(command);
    if (set) values.set(match[1], set[2]);
  }
  return values;
}

module.exports = {
  SHELL_WRAPPER_WORD,
  SHELL_INVOKERS,
  POWERSHELL_ENCODED,
  CMD_GLUED_RUN,
  CMD_SWITCHES,
  CMD_RUN_LAST,
  SHELL_NEST_MAX,
  SHELL_REDIRECTION_WORD,
  SHELL_REDIRECTION_AT,
  SHELL_REDIRECTION_HEAD,
  commandName,
  commandStart,
  nestedShellTexts,
  shellRedirection,
  withGroupValues,
  takesValue,
  pastOptions,
  leadInRuns,
  startedProcess,
  embeddedReaders,
};

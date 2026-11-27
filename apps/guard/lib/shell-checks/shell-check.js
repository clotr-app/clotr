"use strict";
/* global require, module, process */

const { parseClotrIgnore } = require("../clotrignore.js");
const {
  SHELL_UNFINISHED_OUTCOME,
  SHELL_FAILED_OUTCOME,
  HOOK_CHECK_MAX_MS,
  ENVIRONMENT_LOCATIONS,
} = require("../limits-and-messages.js");
const { shellWalkBudget, ShellCheckTooLong } = require("../check-budget.js");
const { repositoryIgnore } = require("../git-repository.js");
const { withoutCommitMessages } = require("../shell-reading/commit-message-words.js");
const { searchTextWords } = require("../shell-reading/search-pattern-words.js");
const { emptiedCommand } = require("../shell-reading/empty-variable-spellings.js");
const { inspectText } = require("../text-checks/check-text.js");
const { splatLiteral, COPY_REDEFINED, COPY_RENAMED } = require("../shell-reading/copy-commands.js");
const { cmdReadsDifferently } = require("./opened-file-check.js");
const { secretInParsedShell, secretInShellReads, SOLE_JOIN_READER_CALL } = require("./command-line-readings.js");
const { dumpsEnvironment, claudeDialect } = require("./environment-dumps.js");

// ---------- The shell check's entry ----------

// A command run as another user, which can read a folder this account can't.
const ELEVATED_COMMAND = /(?:^|[;&|(`\s])(?:sudo|doas|gsudo|runas|pkexec|su)(?=\s|$)|-Verb\s+RunAs\b/im;
// A command that changes its working folder, so a glob may be read from another one.
const CHANGES_FOLDER = /(?:^|[;&|(`\s])(?:cd|pushd|chdir|Set-Location|Push-Location|sl)(?=\s|$)/im;

function inspectShell(tool, event, options = {}) {
  const claudeShell = tool === "claude" && ["Bash", "PowerShell"].includes(event?.tool_name);
  if ((tool !== "claude" && tool !== "cursor") || (tool === "claude" && !claudeShell)) {
    return { action: "allow" };
  }
  const command = tool === "cursor" ? event?.command : event?.tool_input?.command;
  if (typeof command !== "string") return { action: "allow", internalError: true };
  const fallbackCwd = options.cwd || process.cwd();
  const cwd = tool === "cursor" ? event.cwd || fallbackCwd : event?.tool_input?.cwd || fallbackCwd;
  const dump = dumpsEnvironment(tool, event, command);
  if (dump === "failed") return { ...SHELL_FAILED_OUTCOME };
  if (dump) return { action: "block", secretFile: true, boundary: "shell", location: ENVIRONMENT_LOCATIONS[dump] };

  // A reader can also start a subshell, `$(cat .env)` or a backtick, so those openers count as command starts
  // and their closers end the arguments. The blank space before a reader, and after a wrapper word such as
  // `time`, stops at a line break, where `^` starts over: spaces or line breaks that more than one start
  // could take made a long run cost seconds per check. The hook's whole check, counted from when the hook
  // started (`startedAt`, a Date.now() time), has one deadline: the path check stops by it as well as by its
  // own, and the content check gets what's left.
  const deadline = (options.startedAt ?? Date.now()) + (options.hookCheckMaxMs ?? HOOK_CHECK_MAX_MS);
  const { budget, repositoryIgnoreFile } = shellCheckBudget(options, cwd, command, deadline);
  const shellGlobs = shellGlobsFor(tool, event, command, budget);
  addSearchTextWords(budget, command, shellGlobs.kind);
  // Claude says which of its shells runs the command. Cursor runs the user's terminal: Bash's rules or
  // PowerShell's, and cmd's when the command has its escape. Where cmd would split inside a single quote,
  // each reader's words are also read as Guard first read them, which splits there too but keeps a quote that
  // starts a word whole, so a switch's quoted value (--include='*.js') and a quoted pattern stay one word
  // each.
  const cmd = tool === "claude" ? { caret: false, midWord: false } : cmdReadsDifferently(command);
  const dialects = tool === "claude" ? [claudeDialect(event)] : ["bash", "powershell", ...(cmd.caret ? ["cmd"] : [])];
  const bash = tool === "claude" && event.tool_name === "Bash";
  // Both read the command with a git commit message's quoted text taken out, as git stores it and runs none
  // of it.
  const read = withoutCommitMessages(command, dialects, budget, tool !== "claude");
  const readings = shellReadings(read, { cwd, shellGlobs, dialects, cmd, bash }, options.shellReading);
  const readOutcome = shellReadingsOutcome(readings, deadline);
  if (readOutcome) return readOutcome;
  const textOptions = { ...options, cwd, key: "tool", repeat: false, deadline, repositoryIgnoreFile };
  return contentOutcome(tool, command, textOptions);
}

// The shell check's budget, with the content check's .clotrignore. The .clotrignore is found first, since
// finding Git looks in each PATH folder: those lookups come out of the path check's, so a long PATH can't take
// the check past its lookups.
function shellCheckBudget(options, cwd, command, deadline) {
  const gitLookups = { count: 0 };
  const repositoryIgnoreFile = repositoryIgnore(cwd, gitLookups) ?? { root: null, config: parseClotrIgnore("") };
  const budget = shellWalkBudget(options);
  budget.lookups -= gitLookups.count;
  budget.checkDeadline = Math.min(budget.checkDeadline, deadline);
  budget.walkDeadline = Math.min(budget.walkDeadline, budget.checkDeadline);
  // A command run as another user can read a folder this account can't, so the walk can't pass such a folder
  // over.
  budget.elevated = ELEVATED_COMMAND.test(command);
  return { budget, repositoryIgnoreFile };
}

// The words a search reads as text, which start no drive listing (see searchTextWords). Reading them walks
// the whole command, and only a drive wildcard Guard can't place asks for them, so they're found the first
// time one does.
function addSearchTextWords(budget, command, kind) {
  let searchText = null;
  Object.defineProperty(budget, "searchText", {
    get: () => {
      if (searchText === null) searchText = searchTextWords(command, kind);
      return searchText;
    },
    configurable: true,
  });
}

// Runs the readings in turn: the first secret file one finds stops the command, as does a reading that ran out
// of its steps. One that fails doesn't keep the others from running, but the command is then the failed
// check's. Null when every reading ran and found nothing.
function shellReadingsOutcome(readings, deadline) {
  let failed = false;
  for (const reading of readings) {
    let found;
    try {
      found = reading();
    } catch (error) {
      if (!(error instanceof ShellCheckTooLong)) {
        failed = true;
        continue;
      }
      if (Date.now() >= deadline) return { ...SHELL_UNFINISHED_OUTCOME };
      return { action: "block", secretFile: true, boundary: "shell", location: error.location };
    }
    // A name the first reading took whole from a quote, `'.env'`, is shown without its quotes, as the shell
    // opens it.
    const shown = typeof found === "string" && /^(['"])[^'"]+\1$/.test(found) ? found.slice(1, -1) : found;
    if (found) return { action: "block", secretFile: true, boundary: "shell", location: shown };
  }
  if (failed) return { ...SHELL_FAILED_OUTCOME };
  return null;
}

// What the shell's rules mean for its globs and readings, for the command as the tool runs it.
function shellGlobsFor(tool, event, command, budget) {
  const claudeBash = tool === "claude" && event.tool_name === "Bash";
  return {
    // Bash's `*` skips dotfiles unless the command turns that off; Cursor's shell may be PowerShell, whose
    // `*` doesn't.
    posix: claudeBash && !/dotglob|globdots|GLOBIGNORE/i.test(command),
    staysInFolder: !CHANGES_FOLDER.test(command),
    // Claude Code's Bash tool runs Git Bash on Windows, which opens `/c/Users/...` as `C:\Users\...` (see
    // pathReadings).
    gitBash: claudeBash,
    // The shells that could run the command, for their escapes and quoting (see shellSpellings).
    kind: shellKindOf(tool, event),
    // Bash's own paths for a glob are the ones Guard lists (see SOLE_JOIN_READER_CALL).
    joinable: claudeBash && SOLE_JOIN_READER_CALL.test(command),
    // What lets a search's pattern word be told from a file it reads (see patternMayBeFile): the command is
    // one call, so nothing run first makes a file, and for rg no config file is named, in the hook's
    // environment or the command.
    oneCall: !/[;&|`(\r\n\u2028\u2029]/.test(command),
    rgConfig: Boolean(process.env.RIPGREP_CONFIG_PATH) || /RIPGREP_CONFIG_PATH/i.test(command),
    // The parameters a splat into Copy-Item names, when the command writes them just before (see
    // splatLiteral).
    splat: splatLiteral(command),
    // Whether Copy-Item or copy may be another command there (see COPY_REDEFINED).
    copyRedefined: COPY_REDEFINED.test(command),
    // Whether it may make a copy print what it's given, its destination too (see COPY_RENAMED).
    copyRenamed: COPY_RENAMED.test(command),
    budget,
  };
}

function shellKindOf(tool, event) {
  if (tool === "cursor") return "any";
  return event.tool_name === "Bash" ? "bash" : "powershell";
}

// The command is read as the shell splits it, and also as Guard's first shell check read it, and either
// finding a secret file stops it: a reading that splits differently can't let through what the first one
// stopped. One that fails doesn't keep the other from running. The first reading runs first, on the whole
// walk budget as it always had, so the shell's reading can't spend what it needs to walk the folders it
// names; the shell's reading gets what's left. Once one finds a file the others don't run, so a path the
// shell's reading spells another way (a device path's `\\` read as Bash's escape) isn't looked up after the
// first reading stopped the command unlooked-up. The first reading takes cp's last word as where it copies
// to, as it always did; it's read once more with that word's glob as files cp copies too (see
// copyLastIsSource) after the others, so walking it can't spend what they need. `only` "new" or "first" runs
// only one, for tests.
function shellReadings(read, { cwd, shellGlobs, dialects, cmd, bash }, only) {
  const firstReading = () => secretInShellReads(read, cwd, shellGlobs, bash);
  // The new reading also reads the command with a variable inside a word taken out, as it runs when that's
  // empty.
  const emptied = emptiedCommand(read, shellGlobs.kind);
  function newReading() {
    const found = secretInParsedShell(read, cwd, shellGlobs, dialects, cmd.midWord);
    if (found || emptied === read) return found || null;
    return secretInParsedShell(emptied, cwd, shellGlobs, dialects, cmd.midWord);
  }
  function copyLastReading() {
    return /\bcp\b/i.test(read) ? secretInShellReads(read, cwd, shellGlobs, bash, true) : null;
  }
  if (only === "new") return [newReading];
  if (only === "first") return [firstReading, copyLastReading];
  return [firstReading, newReading, copyLastReading];
}

// The content check's answer for the command's text, once no reading found a secret file.
function contentOutcome(tool, command, options) {
  let outcome;
  try {
    outcome = inspectText(tool, command, options);
  } catch {
    return { ...SHELL_FAILED_OUTCOME };
  }
  if (outcome.unfinished) return { ...SHELL_UNFINISHED_OUTCOME };
  return outcome.internalError ? { ...SHELL_FAILED_OUTCOME } : outcome;
}

module.exports = {
  inspectShell,
};

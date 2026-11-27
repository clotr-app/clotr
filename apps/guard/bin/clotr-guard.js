#!/usr/bin/env node
/* global require, module, process, console, __dirname, performance, setTimeout */
"use strict";

const {
  VERSION,
  TOOL_NAMES,
  IMPLEMENTED_TOOL_NAMES,
  MAX_STDIN_BYTES,
  MAX_READ_STDIN_BYTES,
  HOOK_CHECK_MAX_MS,
  SHELL_UNFINISHED_OUTCOME,
  SHELL_FAILED_OUTCOME,
  NPX_SETUP_MESSAGE,
  CHOOSE_TOOL,
} = require("../lib/limits-and-messages.js");
const { assertNoSymlinkComponents } = require("../lib/safe-file-writes.js");
const { onMountedVolume } = require("../lib/path-forms/windows-paths.js");
const { gitRoot, clotrIgnoreFor, gitWasLate } = require("../lib/git-repository.js");
const {
  minSeverity,
  engineVersion,
  dataDirectory,
  inspectPrompt,
  promptSession,
} = require("../lib/text-checks/check-text.js");
const {
  withGitLateNote,
  hookOutput,
  readHookOutput,
  boundaryOutput,
  hookInputFailureOutput,
  validHookEvent,
} = require("../lib/hooks/hook-output.js");
const { printHelp, unknownOption } = require("../lib/commands/command-help.js");
const { printable, parseInput } = require("../lib/commands/piped-input.js");
const { shellCheckReply, hookCwdOf, shellHookOutput } = require("../lib/hooks/shell-check-process.js");

// ---------- Loaded on first use ----------

// A hook is a new process every time, and each file Node opens costs it time, so the checks, the commands
// and setup load the first time one of their functions is called. Each name is that function in the file.
function onFirstUse(file, names) {
  const functions = {};
  for (const name of names) functions[name] = (...args) => require(file)[name](...args);
  return functions;
}

const { decodeText } = onFirstUse("../lib/text-checks/text-decode.js", ["decodeText"]);
const { parseShellCommands } = onFirstUse("../lib/shell-reading/command-line-parser.js", ["parseShellCommands"]);
const { isSecretPath } = onFirstUse("../lib/secret-paths/secret-path-check.js", ["isSecretPath"]);
const { pathReadings } = onFirstUse("../lib/path-forms/path-readings.js", ["pathReadings"]);
const { wslAnswers, inspectRead, inspectTool } = onFirstUse("../lib/hooks/file-read-check.js", [
  "wslAnswers",
  "inspectRead",
  "inspectTool",
]);
const { inspectShell } = onFirstUse("../lib/shell-checks/shell-check.js", ["inspectShell"]);
const { checkStaged, commitCheck, formatCommitIssue, unavailableCommitCheck } = onFirstUse(
  "../lib/commands/commit-check.js",
  ["checkStaged", "commitCheck", "formatCommitIssue", "unavailableCommitCheck"],
);
const { managedHooks, previewManagedHooks } = onFirstUse("../lib/setup/installed-hooks.js", [
  "managedHooks",
  "previewManagedHooks",
]);
const { mergeHook, updateSettings } = onFirstUse("../lib/setup/assistant-settings.js", ["mergeHook", "updateSettings"]);
const { clineHookSource, updateClineHooks } = onFirstUse("../lib/setup/cline-hooks.js", [
  "clineHookSource",
  "updateClineHooks",
]);
const { gitHookScript, setupGit } = onFirstUse("../lib/setup/git-hook-setup.js", ["gitHookScript", "setupGit"]);
const { parseHookCommand } = onFirstUse("../lib/setup/hook-command-reader.js", ["parseHookCommand"]);
const { nodeCommand, hookCommand, isNpxCachePath } = onFirstUse("../lib/setup/hook-command-writer.js", [
  "nodeCommand",
  "hookCommand",
  "isNpxCachePath",
]);
const { userHome, toolSettingsPath } = onFirstUse("../lib/setup/assistant-settings-paths.js", [
  "userHome",
  "toolSettingsPath",
]);
const { checkIgnore, checkText, checkFiles, readCheckFile } = onFirstUse("../lib/commands/check-command.js", [
  "checkIgnore",
  "checkText",
  "checkFiles",
  "readCheckFile",
]);
const { addIgnoredValue, ignoreValue } = onFirstUse("../lib/commands/ignore-value-command.js", [
  "addIgnoredValue",
  "ignoreValue",
]);

// ---------- The command line ----------

async function main(
  args,
  {
    scriptPath = __dirname,
    cwd = process.cwd(),
    home = userHome(),
    platform = process.platform,
    startedAt = Date.now(),
    lastResort = false,
  } = {},
) {
  const [action, ...rest] = args;
  const minimumIndex = rest.indexOf("--min-severity");
  const minimum = minSeverity(minimumIndex >= 0 ? rest[minimumIndex + 1] : "medium");
  if (action === "--version" || action === "-v") {
    console.log(`clotr-guard ${VERSION}, engine ${engineVersion()}`);
    return 0;
  }
  if (action === "--help" || action === "-h" || !action) {
    printHelp();
    return 0;
  }
  const unknown = unknownOption(action, rest);
  if (unknown) {
    console.error(`Unknown option ${printable(unknown)}. Run clotr-guard --help.`);
    return 2;
  }
  // `npx clotr-guard` runs the command named after the package, so MCP clients that start servers that way
  // reach the server through this subcommand. It's the same server as the clotr-mcp command.
  if (action === "mcp") {
    const mcp = require("./clotr-mcp.js");
    if (rest[0] === "--print-config") return mcp.printConfig(rest[1]);
    mcp.serve();
    return undefined;
  }
  if (action === "ignore-value") return runIgnoreValue(rest, cwd);
  if (action === "check") return runCheck(rest, { cwd, minimum });
  if (action === "commit-check") return runCommitCheck(rest, cwd);
  const isHookCommand = action === "hook" || action === "read" || action === "shell" || action === "tool";
  if (isHookCommand) return runHookCommand(action, rest, { cwd, minimum, startedAt, lastResort });
  if (action === "setup" || action === "remove") {
    return runSetup(action, rest, { cwd, home, platform, minimum, scriptPath });
  }
  printHelp();
  return 2;
}

// ---------- The commands ----------

// `ignore-value [--kind <kind>]`: the value on stdin goes into .clotrignore as a fingerprint.
async function runIgnoreValue(rest, cwd) {
  const kind = rest.length === 2 && rest[0] === "--kind" ? rest[1] : undefined;
  if (rest.length && (!kind || rest.length !== 2 || rest[0] !== "--kind")) {
    console.error("Use clotr-guard ignore-value [--kind <kind>] with the value on stdin.");
    return 2;
  }
  try {
    return await ignoreValue(cwd, kind);
  } catch (error) {
    console.error(ignoreValueError(error));
    return 2;
  }
}

function ignoreValueError(error) {
  if (error.message === "raw-value") return "Use clotr-guard ignore-value.";
  if (error.message === "guessable-value") {
    return "That value is too easy to guess from its fingerprint. Keep it out of .clotrignore; remove it from the source.";
  }
  return "Clotr couldn't update .clotrignore.";
}

// `check [file...] [--json]`: a text from stdin, or files.
async function runCheck(rest, { cwd, minimum }) {
  const json = rest.includes("--json");
  const files = rest.filter(
    (arg, index) => arg !== "--json" && arg !== "--min-severity" && rest[index - 1] !== "--min-severity",
  );
  if (files.length > 1) return checkFiles(files, { cwd, minimum, json });
  try {
    const ignore = checkIgnore(cwd);
    const read = files.length ? readCheckFile(files[0]) : { text: await parseInput(), notText: false };
    return checkText(read, { ignore, minimum, json });
  } catch {
    console.error("Clotr couldn't check this text.");
    return 2;
  }
}

// `commit-check`: the staged changes, as Git's pre-commit hook runs it.
function runCommitCheck(rest, cwd) {
  // Only an unavailable check lets the commit through; a file-level failure is reported by checkStaged.
  try {
    return commitCheck({ cwd, includePersonalDetails: rest.includes("--personal-details") });
  } catch (error) {
    // Git runs this check itself, so a Git that doesn't answer is late, not missing: the commit stops.
    if (error.code === "ETIMEDOUT") {
      console.error(
        "Clotr Guard stopped this commit because Git didn't answer in time, so the staged changes weren't checked.",
      );
      return 1;
    }
    const reason = unavailableCommitCheck(error);
    if (reason) {
      console.error(`Clotr Guard couldn't check the staged changes because ${reason}, so this commit wasn't checked.`);
      return 0;
    }
    console.error("Clotr Guard couldn't complete the staged check, so this commit was stopped.");
    return 1;
  }
}

// `hook`, `read`, `shell` and `tool <tool>`: an assistant's hook, its event on stdin.
async function runHookCommand(action, rest, { cwd, minimum, startedAt, lastResort }) {
  const tool = rest[0];
  if (!IMPLEMENTED_TOOL_NAMES.includes(tool)) {
    console.error("Clotr couldn't identify this hook, so it was stopped. Check it by hand, then try again.");
    return 2;
  }
  function outputFor(outcome) {
    if (action === "read") return readHookOutput(tool, outcome);
    if (action === "shell") return boundaryOutput(tool, outcome, "shell");
    if (action === "tool") return boundaryOutput(tool, outcome, "tool");
    return hookOutput(tool, outcome);
  }
  // One answer a hook: whatever comes first is printed, and anything after it is left out.
  let answered;
  function answer(output) {
    if (answered) return answered.code;
    answered = output;
    if (output.stdout) console.log(output.stdout);
    if (output.stderr) console.error(output.stderr);
    return output.code;
  }
  if (lastResort) answerOnCrash(action, outputFor, answer, () => answered.code);
  if (action === "shell") {
    const output = await shellHookOutput(tool, outputFor, {
      startedAt,
      cwd,
      minimum,
      includePersonalDetails: rest.includes("--personal-details"),
    });
    // Nothing should hold the hook open once it has answered; if something does, it ends anyway.
    if (lastResort) setTimeout(() => process.exit(), 1000).unref();
    return answer(output);
  }
  let event;
  try {
    event = JSON.parse(
      await parseInput(action === "read" ? MAX_READ_STDIN_BYTES : MAX_STDIN_BYTES, startedAt + HOOK_CHECK_MAX_MS),
    );
  } catch (error) {
    // Input still open at the hook's deadline gets the answer a check that ran out of time gets.
    if (error?.message === "stdin-late") return answer(outputFor({ action: "block", unfinished: true }));
    return answer(hookInputFailureOutput(tool, action, { tooLarge: error?.message === "stdin-too-large" }));
  }
  if (!validHookEvent(action, tool, event)) return answer(hookInputFailureOutput(tool, action));
  return answerCheckedHook(action, tool, event, { outputFor, answer }, { rest, cwd, minimum, startedAt });
}

// The assistants read a hook's answer only when it exits 0 (or 2); a hook that crashes exits 1, which they
// take as a hook that failed, and they go ahead. So an error nothing else catches, even one after the answer,
// ends the hook with the answer it gave, or, before it gave one, with the answer a check that failed gives:
// the shell and prompt hooks stop, and the read and tool hooks ask where the assistant can and stop where it
// can't. Only in the hook's own process, where nothing else is running.
function answerOnCrash(action, outputFor, answer, answeredCode) {
  function crashed() {
    const failed = action === "shell" ? SHELL_FAILED_OUTCOME : { action: "block", failed: true };
    answer(outputFor(failed));
    process.exitCode = answeredCode();
  }
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
}

// Answers the prompt, read or tool hook's event with its check.
function answerCheckedHook(action, tool, event, { outputFor, answer }, { rest, cwd, minimum, startedAt }) {
  try {
    const hookCwd = hookCwdOf(event, cwd);
    const checkOptions = {
      startedAt,
      cwd: hookCwd,
      minimum,
      includePersonalDetails: rest.includes("--personal-details"),
    };
    let outcome;
    if (action === "read") outcome = inspectRead(tool, event, checkOptions);
    else if (action === "tool") outcome = inspectTool(tool, event, checkOptions);
    else {
      const promptOptions = { ...checkOptions, session: promptSession(tool, event) };
      outcome = inspectPrompt(tool, promptTextOf(tool, event), promptOptions);
    }
    const ignore = action === "read" ? clotrIgnoreFor(hookCwd, cwd) : clotrIgnoreFor(hookCwd);
    if (ignore.config.reason === "raw-value") console.error("Use clotr-guard ignore-value.");
    return answer(withGitLateNote(tool, outputFor(outcome)));
  } catch {
    // A check that failed stops the prompt, and asks about or stops the read or tool call.
    return answer(outputFor({ action: "block", failed: true }));
  }
}

// The prompt in a prompt hook's event, where each assistant puts it.
function promptTextOf(tool, event) {
  if (tool === "windsurf") return event?.tool_info?.user_prompt;
  if (tool === "cline") return event?.userPromptSubmit?.prompt;
  return event?.prompt;
}

// `setup` and `remove <tool|git>`: an assistant's settings, or the Git hook.
function runSetup(action, rest, { cwd, home, platform, minimum, scriptPath }) {
  if (action === "setup" && isNpxCachePath(scriptPath)) {
    console.error(NPX_SETUP_MESSAGE);
    return 2;
  }
  const tool = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--min-severity");
  if (tool === "git") return runGitSetup(action, rest, cwd);
  const refused = setupToolRefused(tool, rest);
  if (refused !== null) return refused;
  try {
    const result = updateSettings(tool, {
      project: rest.includes("--project"),
      dryRun: rest.includes("--dry-run"),
      remove: action === "remove",
      cwd,
      home,
      platform,
      minimum,
      includePersonalDetails: rest.includes("--personal-details"),
      windsurfJetBrains: rest.includes("--windsurf-jetbrains"),
    });
    if (tool === "gemini" && action === "setup" && !result.dryRun) {
      console.log(
        "Gemini CLI loads .env files by default. Turn this off with advanced.ignoreLocalEnv in settings.json.",
      );
    }
    printSetupResult(tool, action, result, cwd);
    return 0;
  } catch (error) {
    return settingsSetupError(error);
  }
}

// `setup git` and `remove git`: the repository's pre-commit hook.
function runGitSetup(action, rest, cwd) {
  try {
    const result = setupGit({ cwd, remove: action === "remove", dryRun: rest.includes("--dry-run") });
    if (result.kept) {
      console.log(`Clotr left the pre-commit hook at ${result.hook} as it was, since Clotr didn't write it.`);
      return 0;
    }
    console.log(
      `${action === "remove" ? "Removed" : "Set up"} Git pre-commit hook at ${result.hook}${result.changed ? "." : " (no change)."}`,
    );
    return 0;
  } catch (error) {
    console.error(gitSetupError(error));
    return 1;
  }
}

// The exit code for a tool setup can't take, with its line printed, or null for one it can.
function setupToolRefused(tool, rest) {
  if (tool === undefined) {
    console.error(CHOOSE_TOOL);
    return 2;
  }
  if (!IMPLEMENTED_TOOL_NAMES.includes(tool)) {
    console.error(`Unknown tool '${printable(tool)}'. ${CHOOSE_TOOL}`);
    return 2;
  }
  if (rest.includes("--windsurf-jetbrains") && tool !== "windsurf") {
    console.error("--windsurf-jetbrains is only for Windsurf.");
    return 2;
  }
  return null;
}

// What setup did, and with a dry run, the hooks it would write.
function printSetupResult(tool, action, result, cwd) {
  const done = action === "remove" ? "Removed" : "Set up";
  const dryRun = result.dryRun ? " (dry run)" : "";
  console.log(`${done} ${tool} hook at ${result.file}${dryRun}${result.changed ? "." : " (no change)."}`);
  if (result.keptBackup && !result.dryRun) {
    console.log(`Clotr kept the earlier backup of this file at ${result.keptBackup}.`);
  }
  if (!result.dryRun) return;
  const preview =
    tool === "cline"
      ? { file: result.file, hooks: result.remove ? [] : result.hooks }
      : {
          file: result.file,
          ...(result.settings.version === undefined ? {} : { version: result.settings.version }),
          hooks: previewManagedHooks(result.settings, tool, cwd),
        };
  console.log(JSON.stringify(preview, null, 2));
}

// The exit code for a settings update that failed, with its line printed.
function settingsSetupError(error) {
  if (error.message === "cline-hooks-unsupported-on-windows") {
    console.error("Cline hooks are supported on macOS and Linux only.");
    return 2;
  }
  if (error.message === "cline-hook-backup-exists") {
    console.error(
      "An older Clotr backup sits beside a Cline hook. Move the .clotr-guard.bak file away, then run setup again.",
    );
    return 1;
  }
  if (error.code === "settings-jsonc") {
    console.error(
      `Clotr Guard didn't change ${error.file}: it isn't plain JSON (a comment or a trailing comma), so edit it by hand or remove them first.`,
    );
  } else if (error.code === "settings-empty") {
    console.error(
      `Clotr Guard didn't change ${error.file}: it's empty. Put {} in it or delete it, then run setup again.`,
    );
  } else if (error.code === "settings-hooks-shape") {
    console.error(
      `Clotr Guard didn't change ${error.file}: its "hooks" entry isn't laid out the way Clotr Guard can read. Fix or remove that entry, then run setup again.`,
    );
  } else console.error("Clotr couldn't update that settings file.");
  return 1;
}

function gitSetupError(error) {
  if (error.message === "custom-hooks-path") return "Clotr left the configured core.hooksPath unchanged.";
  if (error.message === "hook-backup-exists") {
    return "An older Clotr backup sits beside the pre-commit hook. Move pre-commit.clotr-guard.bak away, then run setup again.";
  }
  return "Clotr couldn't update this repository's Git hook.";
}

module.exports = {
  wslAnswers,
  TOOL_NAMES,
  IMPLEMENTED_TOOL_NAMES,
  gitRoot,
  dataDirectory,
  inspectPrompt,
  inspectRead,
  inspectShell,
  shellCheckReply,
  inspectTool,
  isSecretPath,
  onMountedVolume,
  pathReadings,
  addIgnoredValue,
  hookOutput,
  readHookOutput,
  boundaryOutput,
  SHELL_UNFINISHED_OUTCOME,
  SHELL_FAILED_OUTCOME,
  toolSettingsPath,
  mergeHook,
  updateSettings,
  updateClineHooks,
  clineHookSource,
  assertNoSymlinkComponents,
  checkStaged,
  commitCheck,
  formatCommitIssue,
  setupGit,
  gitHookScript,
  managedHooks,
  isNpxCachePath,
  nodeCommand,
  hookCommand,
  parseHookCommand,
  // For tests: Guard's shell reader, and how it reads a file's bytes as text.
  parseShellCommands,
  decodeText,
  gitWasLate,
  main,
};

// After the exports, so the MCP server this starts can read them. A hook's deadline counts from the process's
// own start, so starting up and reading the event count against it.
if (require.main === module) {
  main(process.argv.slice(2), { startedAt: performance.timeOrigin, lastResort: true }).then(
    (code) => (process.exitCode = code),
  );
}

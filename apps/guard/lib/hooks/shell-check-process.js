"use strict";
/* global require, module, process, console, Buffer, setTimeout, clearTimeout */

const { spawn } = require("child_process");
const {
  MAX_STDIN_BYTES,
  HOOK_CHECK_MAX_MS,
  SHELL_UNFINISHED_OUTCOME,
  SHELL_FAILED_OUTCOME,
  GUARD_SCRIPT,
} = require("../limits-and-messages.js");
const { clotrIgnoreFor, gitWasLate } = require("../git-repository.js");
const { withGitLateNote, hookInputFailureOutput, validHookEvent } = require("./hook-output.js");
const { parseInput } = require("../commands/piped-input.js");

// ---------- The shell hook's process ----------

// The shell check's own process (see shellHookOutput). It loads Guard while the hook reads its event, then
// reads the request on stdin and writes its reply on stdout.
const SHELL_CHECK_SOURCE = `"use strict";
const guard = require(process.argv[1]);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(guard.shellCheckReply(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
});`;
const SHELL_CHECK_MAX_REPLY_BYTES = 64 * 1024 * 1024;

// What the shell check's process answers: the outcome, less the engine's result, which the hook's answer
// doesn't use, whether the repository's .clotrignore holds a raw value, and whether a Git call ran out of
// time, which the hook mentions.
function shellCheckReply({ tool, event, options }) {
  // Loaded here, in the check's own process: the hook that starts it doesn't need the shell check.
  const { inspectShell } = require("../shell-checks/shell-check.js");
  const outcome = { ...inspectShell(tool, event, options) };
  delete outcome.result;
  const rawValue = clotrIgnoreFor(options.cwd).config.reason === "raw-value";
  return { outcome, rawValue, gitLate: gitWasLate() };
}

// The hook's own Node options, as fork() passes them on, less a debugger's, which would take the same port or
// wait for one, and a test runner's or watcher's, with any value given as the next argument (execArgv holds
// only options and their values, so an argument after one of those that isn't an option is its value).
function shellCheckFlags(execArgv = process.execArgv) {
  const flags = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const flag = execArgv[index];
    if (!/^--(?:inspect|debug|test|watch)/.test(flag)) flags.push(flag);
    else if (!flag.includes("=") && index + 1 < execArgv.length && !execArgv[index + 1].startsWith("-")) index += 1;
  }
  return flags;
}

// Starts the shell check's process. result() sends it the request and gives its reply, or null when it
// couldn't start, crashed, or didn't answer with a reply; stop() ends it if it's still running.
function startShellCheck() {
  const failed = { result: async () => null, stop() {} };
  let child;
  try {
    // --input-type: NODE_OPTIONS can say code given with -e is a module, where `require` isn't defined.
    child = spawn(
      process.execPath,
      [...shellCheckFlags(), "--input-type=commonjs", "-e", SHELL_CHECK_SOURCE, GUARD_SCRIPT],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
  } catch {
    return failed;
  }
  // Out of file handles, Node gives back a process without its pipes.
  if (!child.stdin || !child.stdout) {
    child.on("error", () => {});
    try {
      child.kill("SIGKILL");
    } catch {
      // It never started.
    }
    return failed;
  }
  const reply = shellCheckReplyOf(child);
  // A process that ends before it has read the request is seen when it closes.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  return {
    result(request) {
      try {
        child.stdin.end(JSON.stringify(request));
      } catch {
        return Promise.resolve(null);
      }
      return reply;
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
    },
  };
}

// The shell check process's reply, parsed, or null when it ends badly or replies past
// SHELL_CHECK_MAX_REPLY_BYTES.
function shellCheckReplyOf(child) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    child.on("error", () => resolve(null));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= SHELL_CHECK_MAX_REPLY_BYTES) chunks.push(chunk);
    });
    child.on("close", (code, signal) => {
      let parsed = null;
      if (code === 0 && !signal && size <= SHELL_CHECK_MAX_REPLY_BYTES) {
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = null;
        }
      }
      resolve(parsed);
    });
  });
}

// The folder a hook's event says it runs in.
function hookCwdOf(event, cwd) {
  const workspaceRoot = Array.isArray(event?.workspaceRoots)
    ? event.workspaceRoots.find((root) => typeof root === "string")
    : undefined;
  if (event?.cwd) return event.cwd;
  if (event?.tool_input?.cwd) return event.tool_input.cwd;
  return workspaceRoot || cwd;
}

// The shell hook's answer, given by its deadline whatever happens. The check runs in a process of its own,
// started before the event is read so that its start-up overlaps the read; one still running at the deadline,
// or a read of the event still waiting then, is stopped there, and so is the command. (A worker thread can't
// promise that: the hook can't exit while one is stuck in a call to the system, such as a lookup on a drive
// that doesn't answer.) A check that can't start, crashes or doesn't answer as it should stops the command as
// a check that hit an internal error.
async function shellHookOutput(tool, outputFor, { startedAt, cwd, minimum, includePersonalDetails }) {
  let checker;
  try {
    checker = startShellCheck();
  } catch {
    checker = { result: async () => null, stop() {} };
  }
  let timer;
  const timeUp = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(outputFor(SHELL_UNFINISHED_OUTCOME)),
      Math.max(0, startedAt + HOOK_CHECK_MAX_MS - Date.now()),
    );
  });
  const checked = (async () => {
    let event;
    try {
      event = JSON.parse(await parseInput(MAX_STDIN_BYTES));
    } catch (error) {
      return hookInputFailureOutput(tool, "shell", { tooLarge: error?.message === "stdin-too-large" });
    }
    if (!validHookEvent("shell", tool, event)) return hookInputFailureOutput(tool, "shell");
    const options = { startedAt, cwd: hookCwdOf(event, cwd), minimum, includePersonalDetails };
    const reply = await checker.result({ tool, event, options });
    const outcome = reply?.outcome;
    if (!outcome || typeof outcome !== "object" || (outcome.action !== "allow" && outcome.action !== "block")) {
      return outputFor(SHELL_FAILED_OUTCOME);
    }
    if (reply.rawValue) console.error("Use clotr-guard ignore-value.");
    return withGitLateNote(tool, outputFor(outcome), reply.gitLate === true);
  })().catch(() => outputFor(SHELL_FAILED_OUTCOME));
  try {
    return await Promise.race([checked, timeUp]);
  } finally {
    clearTimeout(timer);
    checker.stop();
    process.stdin.destroy();
  }
}

module.exports = {
  shellCheckReply,
  hookCwdOf,
  shellHookOutput,
};

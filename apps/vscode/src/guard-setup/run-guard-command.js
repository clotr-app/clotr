"use strict";

const { spawn } = require("child_process");

const GUARD_COMMAND_TIMEOUT_MS = 15_000;

// ---------- Running Guard ----------

// Runs a program with a time limit and collects what it prints. Resolves with { status, stdout, stderr }.
// Rejects when it can't start, or with code ETIMEDOUT once it runs past the limit.
function runGuardCommand(command, args, options, timeoutMs = GUARD_COMMAND_TIMEOUT_MS, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Only the first of close, error and the time limit counts.
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    }
    function stopAtTimeLimit() {
      const error = new Error("Clotr Guard timed out.");
      error.code = "ETIMEDOUT";
      try {
        child.kill();
      } catch (_error) {
        // The process may already have exited.
      }
      finish(reject, error);
    }
    const timer = setTimeout(stopAtTimeLimit, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (status) => finish(resolve, { status: status ?? 1, stdout, stderr }));
  });
}

// Guard's command line for one tool. Git's hook has no options; an assistant's hooks carry the lowest
// level they stop at and whether they check personal details.
function guardArgs(cli, tool, { remove = false, dryRun = false, minimum = "medium", personalDetails = false } = {}) {
  return [
    cli,
    remove ? "remove" : "setup",
    tool,
    ...(tool === "git" ? ["--project"] : []),
    ...(dryRun ? ["--dry-run"] : []),
    ...(tool !== "git" && minimum !== "medium" ? ["--min-severity", minimum] : []),
    ...(tool !== "git" && personalDetails ? ["--personal-details"] : []),
  ];
}

function runGuard(node, args, cwd, home) {
  return runGuardCommand(node, args, { cwd, env: { ...process.env, USERPROFILE: home, HOME: home } });
}

module.exports = { runGuardCommand, guardArgs, runGuard };

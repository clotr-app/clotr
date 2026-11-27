"use strict";
/* global require, module */

const path = require("path");
const {
  GIT_LATE_NOTE,
  SHELL_TOO_MANY_PATHS,
  SHELL_FOLDER_TOO_BIG,
  SHELL_CHECK_UNFINISHED,
  SHELL_CHECK_FAILED,
  SHELL_FAILED_OUTCOME,
  SHELL_SECRET_VARIABLE,
  SHELL_UNREAD_VARIABLE,
  SEARCH_WALK_LIMIT_NOTE,
  PARTIAL_READ_MESSAGE,
} = require("../limits-and-messages.js");
const { gitWasLate } = require("../git-repository.js");
const { formatFindings } = require("../text-checks/check-text.js");

// A hook's answer with the line about a late Git added, when a Git call in this process ran out of time.
function withGitLateNote(tool, output, late = gitWasLate()) {
  return late ? addVisibleLine(tool, output, GIT_LATE_NOTE) : output;
}

function blockMessage(findings) {
  return `Clotr found ${formatFindings(findings)} in this prompt. To send anyway, press Enter again within 2 minutes.`;
}

// A check that didn't finish, by the hook's deadline or the engine's own time limit, in words: what was found before
// it stopped, if anything, and that the rest wasn't checked. `what` is "this prompt", "these tool arguments" or a file;
// `so` says what happens next.
function unfinishedMessage(findings, what, so = "so it was stopped") {
  return findings?.length
    ? `Clotr found ${formatFindings(findings)} in ${what} and ran out of time before checking the rest, ${so}.`
    : `Clotr ran out of time before checking all of ${what}, ${so}.`;
}

function blockReadMessage(findings, location = "the requested file") {
  return `Clotr found ${formatFindings(findings)} in ${JSON.stringify(location)}, so it wasn't read. Tell the person what you were trying to read and let them decide; don't try to read it another way.`;
}

function secretFileMessage(location, boundary) {
  if (boundary === "search") {
    const filename =
      typeof location === "string" && location ? path.posix.basename(location.replace(/\\/g, "/")) : "it";
    const where = typeof location === "string" && location ? ` ${JSON.stringify(location)}` : "";
    return `Clotr stopped this search because it could return the secret file${where}. Use a file glob that leaves ${JSON.stringify(filename)} out, for example '*.js'.`;
  }
  if (boundary === "shell") {
    if (location === "the environment") {
      return "Clotr stopped this shell command because it would print secret environment values. Read only the specific variable you need.";
    }
    if (location === SHELL_SECRET_VARIABLE) {
      return "Clotr stopped this shell command because it would print an environment variable whose name looks like a secret. Read only variables that hold no secret.";
    }
    if (location === SHELL_UNREAD_VARIABLE) {
      return "Clotr stopped this shell command because it would print an environment variable whose name isn't written out. Name the variable you need.";
    }
    if (location === SHELL_TOO_MANY_PATHS) {
      return "Clotr stopped this shell command because it names more paths than it can check in time. Split it into smaller commands.";
    }
    if (location === SHELL_FOLDER_TOO_BIG) {
      return "Clotr stopped this shell command because it reads a folder it couldn't check in full for secret files in time. Search a smaller folder, or name the files to read.";
    }
    if (location === SHELL_CHECK_UNFINISHED) {
      return "Clotr stopped this shell command because its check didn't finish in time. Split it into smaller commands, or try again when the computer is less busy.";
    }
    if (location === SHELL_CHECK_FAILED) {
      return "Clotr stopped this shell command because its check hit an internal error, so it couldn't tell whether the command reads a secret. Tell the person, who can check it by hand and run it themselves.";
    }
    const where = typeof location === "string" && location ? ` at ${JSON.stringify(location)}` : "";
    return `Clotr stopped this shell command because it could read a secret file${where}. Work from the variable names or the example file instead.`;
  }
  const where = typeof location === "string" && location ? ` at ${JSON.stringify(location)}` : "";
  return `Clotr stopped the read${where} because it can expose a secret file. Work from the variable names or the example file instead, and don't try another way to read it.`;
}

function askReadMessage(findings, location = "the requested file") {
  return `Clotr found ${formatFindings(findings)} in ${JSON.stringify(location)}. Allow the read only if you want the assistant to see it.`;
}

// The line shown when something was found that doesn't stop the prompt or read.
function passNote(outcome, ending) {
  const lines = [];
  if (outcome.reported?.length) lines.push(`Clotr found ${formatFindings(outcome.reported)}; ${ending}.`);
  if (outcome.belowMinimumOnly) lines.push(`Clotr found details below the stop level; ${ending}.`);
  return lines.join("\n");
}

// A passing answer with its note where the person sees it, and on stderr for the tools that read it there.
function withPassNote(tool, output, note) {
  if (!note) return output;
  const shown = addVisibleLine(tool, output, note);
  return tool === "windsurf" ? shown : { ...shown, stderr: note };
}

// A stopped prompt with only a message, in each tool's shape.
function promptStopOutput(tool, message) {
  if (tool === "windsurf") return { stderr: message, code: 2 };
  if (tool === "cline") return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), code: 0 };
  if (tool === "cursor") return { stdout: JSON.stringify({ continue: false, user_message: message }), code: 0 };
  if (tool === "gemini") return { stdout: JSON.stringify({ decision: "deny", reason: message }), code: 0 };
  if (tool === "claude") {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason: message,
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
      }),
      code: 0,
    };
  }
  return { stdout: JSON.stringify({ decision: "block", reason: message }), code: 0 };
}

// Guard's own failure (a `failed` outcome) stops the prompt. The way out is to try again, or set the hook up again.
function failedPromptMessage(tool) {
  return `Clotr hit an error and couldn't check this prompt, so it was stopped. Try again. If it keeps happening, run clotr-guard setup ${tool} again.`;
}

function hookOutput(tool, outcome) {
  if (outcome.failed) return promptStopOutput(tool, failedPromptMessage(tool));
  if (outcome.internalError) {
    const boundary = outcome.boundary || "prompt";
    const message = `Clotr couldn't check this ${boundary}, so it went through.`;
    if (tool === "claude") return { stdout: JSON.stringify({ systemMessage: message }), code: 0 };
    if (tool === "cursor") {
      const response = outcome.boundary
        ? { permission: "allow", user_message: message }
        : { continue: true, user_message: message };
      return { stdout: JSON.stringify(response), code: 0 };
    }
    if (tool === "gemini") return { stdout: JSON.stringify({ systemMessage: message }), code: 0 };
    if (tool === "windsurf") return { stderr: message, code: 0 };
    if (tool === "cline") return { stdout: JSON.stringify({ cancel: false, contextModification: message }), code: 0 };
    return { stdout: JSON.stringify({ systemMessage: message }), code: 0 };
  }
  if (outcome.action !== "block") {
    const stdout =
      tool === "cursor"
        ? JSON.stringify({ continue: true })
        : tool === "cline"
          ? JSON.stringify({ cancel: false })
          : tool === "gemini" || tool === "codex"
            ? "{}"
            : "";
    return withPassNote(tool, { stdout, code: 0 }, passNote(outcome, "this prompt will pass"));
  }

  const message = outcome.unfinished
    ? `${unfinishedMessage(outcome.findings, "this prompt")} Shorten it or send it in smaller parts, or try again when the computer is less busy.`
    : blockMessage(outcome.findings);
  const belowMinimumNote = outcome.belowMinimumPresent
    ? "Clotr found details below the stop level; they will not stop this prompt."
    : "";
  if (tool === "claude") {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason: [message, belowMinimumNote].filter(Boolean).join("\n"),
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
      }),
      code: 0,
    };
  }
  const stderr = belowMinimumNote ? `${belowMinimumNote}\n` : "";
  if (tool === "windsurf") return { stderr: `${stderr}${message}`, code: 2 };
  if (tool === "cline") return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), code: 0 };
  if (tool === "cursor") return { stdout: JSON.stringify({ continue: false, user_message: message }), stderr, code: 0 };
  if (tool === "gemini") return { stdout: JSON.stringify({ decision: "deny", reason: message }), stderr, code: 0 };
  return { stdout: JSON.stringify({ decision: "block", reason: message }), stderr, code: 0 };
}

function readHookOutputBase(tool, outcome) {
  if (outcome.internalError && !outcome.failed) {
    return hookOutput(tool, { ...outcome, boundary: outcome.boundary || "read" });
  }
  if (outcome.secretFile) {
    const message = secretFileMessage(outcome.location, outcome.boundary);
    if (tool === "windsurf") return { stderr: message, code: 2 };
    if (tool === "cline") return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), code: 0 };
    if (tool === "cursor") return { stdout: JSON.stringify({ permission: "deny", user_message: message }), code: 0 };
    if (tool === "gemini") return { stdout: JSON.stringify({ decision: "deny", reason: message }), code: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      }),
      code: 0,
    };
  }
  const allowed =
    tool === "cursor"
      ? JSON.stringify({ permission: "allow" })
      : tool === "cline"
        ? JSON.stringify({ cancel: false })
        : "{}";
  if (outcome.searchLimited) return withPassNote(tool, { stdout: allowed, code: 0 }, SEARCH_WALK_LIMIT_NOTE);
  if (outcome.action !== "block") {
    return withPassNote(tool, { stdout: allowed, code: 0 }, passNote(outcome, "this file will be read"));
  }
  const where = JSON.stringify(outcome.location || "the requested file");
  // Guard's own failure is stopped or asked about as a check that ran out of time is.
  const failedWhere = outcome.location ? where : "the requested file";
  const message = outcome.failed
    ? `Clotr hit an error and couldn't check ${failedWhere}, so it wasn't read. Tell the person what you were trying to read and let them decide; don't try to read it another way.`
    : outcome.unfinished
      ? `${unfinishedMessage(outcome.findings, where, "so it wasn't read")} Tell the person what you were trying to read and let them decide; don't try to read it another way.`
      : blockReadMessage(outcome.findings, outcome.location);
  const askMessage = outcome.failed
    ? `Clotr hit an error and couldn't check ${failedWhere}, so it's asking first. Allow the read only if you want the assistant to see it.`
    : outcome.unfinished
      ? `${unfinishedMessage(outcome.findings, where, "so Clotr is asking first")} Allow the read only if you want the assistant to see it.`
      : askReadMessage(outcome.findings, outcome.location);
  const stderr = outcome.belowMinimumPresent
    ? "Clotr found details below the stop level; they will not stop this read.\n"
    : "";
  if (tool === "cursor") {
    return { stdout: JSON.stringify({ permission: "deny", user_message: message }), stderr, code: 0 };
  }
  if (tool === "windsurf") return { stderr: `${stderr}${message}`, code: 2 };
  if (tool === "cline") return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), code: 0 };
  if (tool === "gemini") return { stdout: JSON.stringify({ decision: "deny", reason: message }), stderr, code: 0 };
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        // Claude Code asks the person; other answers would go only to the assistant.
        permissionDecision: tool === "claude" ? "ask" : "deny",
        permissionDecisionReason: tool === "claude" ? askMessage : message,
      },
    }),
    stderr,
    code: 0,
  };
}

function appendLine(value, line) {
  return value ? `${value}\n${line}` : line;
}

// Adds a line where each tool shows it to the person: Windsurf's stderr, Cursor's user_message, Cline's
// contextModification (errorMessage on a stop) and everyone else's systemMessage. Claude Code, Codex and Cursor don't
// show stderr from a hook that lets the action through.
function addVisibleLine(tool, output, line) {
  if (tool === "windsurf") return { ...output, stderr: appendLine(output.stderr, line) };
  try {
    const response = JSON.parse(output.stdout || "{}");
    if (tool === "cursor") response.user_message = appendLine(response.user_message, line);
    else if (tool === "cline") {
      const field = response.cancel || response.errorMessage ? "errorMessage" : "contextModification";
      response[field] = appendLine(response[field], line);
    } else response.systemMessage = appendLine(response.systemMessage, line);
    return { ...output, stdout: JSON.stringify(response) };
  } catch {
    return { ...output, stderr: appendLine(output.stderr, line) };
  }
}

function readHookOutput(tool, outcome) {
  const output = readHookOutputBase(tool, outcome);
  return outcome.partial ? addVisibleLine(tool, output, PARTIAL_READ_MESSAGE) : output;
}

function boundaryOutput(tool, outcome, boundary) {
  // The shell hook stops a command whose check failed, with the words of a shell check that hit an error.
  if (outcome.failed && boundary === "shell") return readHookOutput(tool, { ...SHELL_FAILED_OUTCOME });
  if (outcome.internalError && !outcome.failed) return hookOutput(tool, { ...outcome, boundary });
  if (outcome.action !== "block") {
    return tool === "cursor" ? { stdout: JSON.stringify({ permission: "allow" }), code: 0 } : { stdout: "{}", code: 0 };
  }
  if (outcome.secretFile) return readHookOutput(tool, { ...outcome, boundary });
  const message = outcome.failed
    ? `Clotr hit an error and couldn't check these ${boundary} arguments, so it's asking first.`
    : outcome.unfinished
      ? unfinishedMessage(outcome.findings, `these ${boundary} arguments`, "so Clotr is asking first")
      : `Clotr found ${formatFindings(outcome.findings)} in these ${boundary} arguments.`;
  if (tool === "claude") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `${message} Allow the call only if you want the assistant to send it.`,
        },
      }),
      code: 0,
    };
  }
  return { stdout: JSON.stringify({ permission: "ask", user_message: message }), code: 0 };
}

function hookInputFailureOutput(tool, action, { tooLarge = false } = {}) {
  const boundary = action === "hook" ? "prompt" : action === "read" ? "read" : action;
  const limit = action === "read" ? "64 MiB" : "1 MiB";
  const message = tooLarge
    ? `This ${boundary} exceeded Clotr Guard's ${limit} hook-input limit, so it was stopped. Shorten it or check it by hand, then try again.`
    : `Clotr couldn't check this ${boundary}, so it was stopped. Check it by hand, then try again.`;
  if (boundary === "prompt") return promptStopOutput(tool, message);
  if (tool === "windsurf") return { stderr: message, code: 2 };
  if (tool === "cline") return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), code: 0 };
  if (tool === "cursor") return { stdout: JSON.stringify({ permission: "deny", user_message: message }), code: 0 };
  if (tool === "gemini") return { stdout: JSON.stringify({ decision: "deny", reason: message }), code: 0 };
  if (tool === "claude") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      }),
      code: 0,
    };
  }
  return { stdout: JSON.stringify({ decision: "block", reason: message }), code: 0 };
}

function validHookEvent(action, tool, event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (event.cwd !== undefined && typeof event.cwd !== "string") return false;
  const toolInput = event.tool_input;
  if (toolInput?.cwd !== undefined && typeof toolInput.cwd !== "string") return false;
  if (action === "hook") {
    const prompt =
      tool === "windsurf"
        ? event.tool_info?.user_prompt
        : tool === "cline"
          ? event.userPromptSubmit?.prompt
          : event.prompt;
    return typeof prompt === "string";
  }
  if (action === "read") {
    if (tool === "cursor") {
      return typeof event.file_path === "string" && Boolean(event.file_path) && typeof event.content === "string";
    }
    if (tool === "windsurf") {
      return typeof event.tool_info?.file_path === "string" && Boolean(event.tool_info.file_path);
    }
    // Loaded here, so the shell hook, which never reads a file event, doesn't load the read check.
    const invocation = require("./file-read-check.js").readInvocation(tool, event);
    if (!invocation.args) return false;
    if (tool === "cline") return Boolean(invocation.name);
    const name = String(invocation.name || "")
      .toLowerCase()
      .split("__")
      .pop();
    const handled = new Set([
      "read",
      "read_file",
      "read_files",
      "read_text_file",
      "read_media_file",
      "read_multiple_files",
      "read_resource",
      "grep",
      "search_files",
      "search_file_content",
      "grep_search",
      "read_many_files",
    ]);
    if (handled.has(name)) return true;
    return Boolean(invocation.args.file_path || invocation.args.absolute_path || invocation.args.path);
  }
  if (action === "shell") {
    const command = tool === "cursor" ? event.command : toolInput?.command;
    return (
      typeof command === "string" &&
      (tool === "cursor" || (tool === "claude" && ["Bash", "PowerShell"].includes(event.tool_name)))
    );
  }
  if (action === "tool") {
    if (typeof event.tool_name !== "string") return false;
    let args = toolInput;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return false;
      }
    }
    return Boolean(args && typeof args === "object" && !Array.isArray(args));
  }
  return false;
}

module.exports = {
  withGitLateNote,
  blockMessage,
  unfinishedMessage,
  blockReadMessage,
  secretFileMessage,
  askReadMessage,
  passNote,
  withPassNote,
  hookOutput,
  readHookOutputBase,
  appendLine,
  addVisibleLine,
  readHookOutput,
  boundaryOutput,
  hookInputFailureOutput,
  validHookEvent,
};

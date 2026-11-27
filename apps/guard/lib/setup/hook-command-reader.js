"use strict";
/* global require, module, process */

const path = require("path");
const { SEVERITIES, HOOK_TIMEOUT_SECONDS, GUARD_ROOT, GUARD_SCRIPT } = require("../limits-and-messages.js");
const { pathInside } = require("../safe-file-writes.js");
const { shellQuote, hookAction } = require("./hook-command-writer.js");

// ---------- Recognising a hook ----------

function parseHookCommand(source, { straightOnly = false } = {}) {
  if (typeof source !== "string" || source.length > 16 * 1024) return null;
  let index = 0;
  const words = [];
  function whitespace() {
    while (/\s/.test(source[index] || "")) index += 1;
  }
  whitespace();
  // Only the PowerShell form starts with `&`. In it, two of PowerShell's quote marks in a row stand for the
  // second. With straightOnly, only two straight marks do, the way Guard 0.1.3 wrote its hooks.
  const powershell = source[index] === "&";
  if (powershell) {
    index += 1;
    whitespace();
  }
  const curly = powershell && !straightOnly;
  const isQuote = (character) => character === "'" || (curly && character >= "\u2018" && character <= "\u201b");
  while (index < source.length) {
    let value = "";
    const quote = source[index];
    if (quote === "'" || quote === '"') {
      const quoted = readQuotedWord(source, index, isQuote);
      if (!quoted) return null;
      value = quoted.value;
      index = quoted.index;
    } else {
      while (index < source.length && !/\s/.test(source[index])) {
        if (/[;&|$`()<>\\]/.test(source[index])) return null;
        value += source[index++];
      }
    }
    if (!value) return null;
    words.push(value);
    if (index < source.length && !/\s/.test(source[index])) return null;
    whitespace();
  }
  return words;
}

// A quoted word of a hook command from its opening quote at `start`: its value and where reading goes on, or
// null when it isn't closed. In a single quote, two quote marks in a row are one, as PowerShell writes
// it, and so is `'\''`, as the POSIX form writes it.
function readQuotedWord(source, start, isQuote) {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    if (quote === "'" && isQuote(character) && isQuote(source[index + 1])) {
      value += source[index + 1];
      index += 2;
    } else if (character === quote) {
      index += 1;
      if (quote === "'" && source.slice(index, index + 3) === "\\''") {
        value += "'";
        index += 3;
        while (index < source.length && source[index] !== "'") value += source[index++];
        if (source[index] !== "'") return null;
        index += 1;
      }
      return { value, index };
    } else value += source[index++];
  }
  return null;
}

function isGuardScriptPath(script, cwd = process.cwd()) {
  if (typeof script !== "string" || !path.isAbsolute(script)) return false;
  const resolved = path.resolve(script);
  if (resolved === GUARD_SCRIPT) return true;
  if (resolved === path.resolve(GUARD_ROOT, "../vscode/guard/bin/clotr-guard.js")) return true;
  if (pathInside(cwd, resolved)) return false;
  const parts = resolved
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  return parts.some(
    (part, index) =>
      (part === "node_modules" &&
        parts[index + 1] === "clotr-guard" &&
        parts[index + 2] === "bin" &&
        parts[index + 3] === "clotr-guard.js" &&
        index + 4 === parts.length) ||
      (part === "apps" &&
        parts[index + 1] === "vscode" &&
        parts[index + 2] === "guard" &&
        parts[index + 3] === "bin" &&
        parts[index + 4] === "clotr-guard.js" &&
        index + 5 === parts.length) ||
      (part.startsWith("clotr-app.clotr-") &&
        parts[index + 1] === "guard" &&
        parts[index + 2] === "bin" &&
        parts[index + 3] === "clotr-guard.js" &&
        index + 4 === parts.length),
  );
}

// The words of a hook command, if they name node and Guard's script.
function guardWords(words, cwd) {
  // 0.1.0 named a bare `node` when one was on PATH; that hook is still Clotr's to replace or remove.
  if (!words || words.length < 6 || (words[0] !== "node" && !path.isAbsolute(words[0]))) return null;
  if (!/^node(?:\.exe)?$/i.test(path.basename(words[0]))) return null;
  return isGuardScriptPath(words[1], cwd) ? words : null;
}

// Guard 0.1.3 doubled only the straight mark in its PowerShell form, so its hook for a folder like a’'b or
// a’’b reads differently now. Read that form the way 0.1.3 did, and take it only if 0.1.3 wrote exactly it,
// and wrote exactly the hook's other command too when it has one.
function guardWords013(sources, cwd) {
  const commands = sources.filter((source) => typeof source === "string");
  if (!commands.some((source) => /[\u2018-\u201b]/.test(source))) return null;
  for (const source of commands) {
    const words = parseHookCommand(source, { straightOnly: true });
    if (!words || source !== `& ${words.map((word) => `'${word.replace(/'/g, "''")}'`).join(" ")}`) continue;
    const posix = words.map(shellQuote).join(" ");
    return commands.every((other) => other === source || other === posix) ? guardWords(words, cwd) : null;
  }
  return null;
}

function hookCommandWords(entry, cwd, tool) {
  const keys = Object.keys(entry || {}).sort();
  let words = null;
  let sources = [];
  if (
    tool === "claude" &&
    entry?.type === "command" &&
    typeof entry.command === "string" &&
    Array.isArray(entry.args) &&
    keys.join(",") === ["args", "command", "timeout", "type"].sort().join(",") &&
    entry.timeout === HOOK_TIMEOUT_SECONDS
  ) {
    words = [entry.command, ...entry.args];
  } else {
    // Guard 0.1.0 wrote every hook, Claude Code's too, as one command string: `"node" "<script>" hook <tool>
    // ...`.
    const shapes =
      {
        claude: [["command", "timeout", "type"]],
        cursor: [["command"]],
        gemini: [["command", "timeout", "type"]],
        windsurf: [
          ["command", "show_output"],
          ["command", "powershell", "show_output"],
        ],
        codex: [
          ["command", "timeout", "type"],
          ["command", "commandWindows", "timeout", "type"],
        ],
      }[tool] || [];
    if (!shapes.some((shape) => keys.join(",") === [...shape].sort().join(","))) return null;
    if (tool === "gemini" && (entry.type !== "command" || entry.timeout !== HOOK_TIMEOUT_SECONDS * 1000)) return null;
    if (
      (tool === "codex" || tool === "claude") &&
      (entry.type !== "command" || entry.timeout !== HOOK_TIMEOUT_SECONDS)
    ) {
      return null;
    }
    if (tool === "windsurf" && entry.show_output !== true) return null;
    const commandKeys =
      process.platform === "win32"
        ? ["powershell", "commandWindows", "command"]
        : ["command", "powershell", "commandWindows"];
    sources = commandKeys.map((key) => entry?.[key]);
    for (const source of sources) {
      words = parseHookCommand(source);
      if (words) break;
    }
  }
  return guardWords(words, cwd) || guardWords013(sources, cwd);
}

// Match only the command Clotr wrote, with no wrapper or trailing user command that remove might erase.
function hasManagedHook(entry, tool, mode = "prompt", cwd = process.cwd()) {
  const words = hookCommandWords(entry, cwd, tool);
  if (!words || (tool !== "cursor" && tool !== "windsurf" && entry?.type !== "command")) return false;
  const action = hookAction(mode);
  const args = words.slice(2);
  return (
    (words.length === 6 || words.length === 7) &&
    args[0] === action &&
    args[1] === tool &&
    args[2] === "--min-severity" &&
    SEVERITIES.includes(args[3]) &&
    (args.length === 4 || (args.length === 5 && args[4] === "--personal-details"))
  );
}

module.exports = {
  parseHookCommand,
  isGuardScriptPath,
  hookCommandWords,
  hasManagedHook,
};

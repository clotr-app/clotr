"use strict";
/* global require, module, process, __dirname */

// ---------- The package ----------

// The package's own version: a packed copy has nothing outside its folder, so the extension's manifest is out of
// reach there, and a test keeps the two in step.
const VERSION = require("../package.json").version;
// The folder Guard is installed in and its command, worked out here once so setup names the same file wherever the
// code that writes a hook sits.
const GUARD_ROOT = require("path").resolve(__dirname, "..");
const GUARD_SCRIPT = require("path").join(GUARD_ROOT, "bin", "clotr-guard.js");

// ---------- Tools and severities ----------

// The editor plugins use TOOL_NAMES for their setup picker. The CLI also supports Cline's extensionless hooks.
const TOOL_NAMES = ["claude", "cursor", "gemini", "codex", "windsurf"];
const IMPLEMENTED_TOOL_NAMES = [...TOOL_NAMES, "cline"];
const SEVERITIES = ["low", "medium", "high"];
const READ_TOOLS = new Set(["claude", "cursor", "gemini", "codex", "windsurf", "cline"]);

// ---------- Size limits ----------

const MAX_READ_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_GIT_DIFF_BUFFER = 16 * 1024 * 1024;
// Cursor sends the whole file with a read, so its event gets more room, enough to check the first 256 KiB of a big one.
const MAX_READ_STDIN_BYTES = 64 * 1024 * 1024;
const MAX_CHECK_BYTES = 1024 * 1024;
// The longest path the system opens: Windows' 32,767 characters, and Linux's 4,096 bytes (macOS's is shorter).
const OPENABLE_PATH_LENGTH = process.platform === "win32" ? 32767 : 4096;
// A text this long or longer is checked in a worker thread the hook can stop at its deadline (see checkBy).
const CHECK_WORKER_MIN_CHARS = 64 * 1024;

// ---------- Hook and Git time limits ----------

// The timeout setup writes into each hook. A slow laptop can take several seconds over a full 256 KiB
// read, and an assistant that gives up on the hook reads the file unchecked, so it's generous; a quick
// check never waits for it.
const HOOK_TIMEOUT_SECONDS = 15;
// How long one Git call may take. A hook makes up to two of its own. A read hook's search asks Git about the secret
// files it finds as well: each ask gets at least 250 ms, and a slow Git is waited on past that, or past the walk's own
// time, only until the search's asks have taken this long in all, however many ignored secret files it finds. All of
// it stays inside the hook's 10-second check time (HOOK_CHECK_MAX_MS), so a Git that never answers (a network drive,
// a huge repository, a credential window that never shows) still leaves the hook inside its 15 seconds.
const GIT_TIMEOUT_MS = 2000;
const GIT_LATE_NOTE = "Git didn't answer in time, so Clotr checked this without the folder's .clotrignore.";

// ---------- Search limits ----------

const SEARCH_WALK_MAX_ENTRIES = 2048;
const SEARCH_WALK_MAX_MS = 250;
const SEARCH_REACHABILITY_TIMEOUT_MS = 250;
// A search's file filters, all together. Each is matched against every file the walk finds, and 100,000 of them check
// in about 2 seconds, so a list that names a secret file is still denied for it. Past either cap the search gets the
// answer a check that ran out of time gets. The length is the other hooks' whole input (MAX_STDIN_BYTES).
const SEARCH_FILTER_MAX_LENGTH = 1024 * 1024;
const SEARCH_FILTER_MAX_COUNT = 100000;
const SEARCH_WALK_LIMIT_NOTE =
  "Clotr couldn't finish checking this search for secret-file paths within its limits, so the search went through.";

// ---------- Shell check limits and answers ----------

// Every folder one shell command's check reads for its globs, together: well inside the hook's timeout.
const SHELL_WALK_MAX_ENTRIES = 8192;
const SHELL_WALK_MAX_MS = 1000;
// Every folder one shell command's recursive readers read, together, apart from the above. A folder that can't be read
// in full within it stops the command, so it's room for the root of a real project: Node lists about 100,000 entries a
// second, a third of that on a busy computer, so the walk has the path check's whole time (SHELL_CHECK_MAX_MS). The
// walk's time is given back to the lookups after it.
const SHELL_TREE_WALK_MAX_ENTRIES = 131072;
// A ripgrep listing a shell check asks for, to tell which secret files rg leaves out, can be this big.
const SHELL_RIPGREP_MAX_BUFFER = 64 * 1024 * 1024;
// The key a search's rg listings are kept under once rg turns out not to be on PATH.
const RIPGREP_MISSING = "\0no rg on PATH";
// Ignore files rg reads and Git doesn't.
const RIPGREP_IGNORE_FILES = [".ignore", ".rgignore"];
// A shell rg's walk asks Git which folders it ignores once it has read this many entries, or has fewer than this left:
// a small tree is walked before asking would pay off.
const SHELL_RG_IGNORED_ASK_AT = 4096;
// The operands and folders one shell command's check looks up on disk, together; past them each is judged by its name.
// A path that isn't there costs one quick lookup, so a megabyte of made-up names is looked up in full on an idle machine.
const SHELL_OPERAND_MAX_LOOKUPS = 250000;
const SHELL_OPERAND_MAX_MS = 2000;
// The part of those an operand's other drive paths (a share's, or a tidied one's) may use: a command padded with them
// stops by then, so its content check still has time before the hook answers.
const SHELL_DRIVE_PATH_MAX_MS = 1000;
// A shell check still running after this stops the command: a hook that times out would let it through.
const SHELL_CHECK_MAX_MS = 5000;
const SHELL_TOO_MANY_PATHS = "too many paths to check";
// A recursive reader's folder, or a glob's folders, that the walk couldn't read in full stops the command.
const SHELL_FOLDER_TOO_BIG = "a folder too big to check";
// The whole shell hook, the path check and the content check together, counted from the hook's start: one still
// running after this stops the command, well before the hook's own timeout would let it through.
const HOOK_CHECK_MAX_MS = 10000;
const SHELL_CHECK_UNFINISHED = "a check that didn't finish";
const SHELL_UNFINISHED_OUTCOME = Object.freeze({
  action: "block",
  secretFile: true,
  boundary: "shell",
  location: SHELL_CHECK_UNFINISHED,
});
// The shell hook fails closed: an internal error its check catches stops the command, as a crash does, and says so.
const SHELL_CHECK_FAILED = "a check that hit an internal error";
const SHELL_FAILED_OUTCOME = Object.freeze({
  action: "block",
  secretFile: true,
  boundary: "shell",
  location: SHELL_CHECK_FAILED,
});

// ---------- What a command prints of the environment ----------

// What the shell check found the command prints of the environment: all of it, or one variable whose name looks like a
// secret or isn't written out (see variableRisk).
const SHELL_SECRET_VARIABLE = "a variable whose name looks like a secret";
const SHELL_UNREAD_VARIABLE = "a variable whose name isn't written out";
const ENVIRONMENT_LOCATIONS = { all: "the environment", secret: SHELL_SECRET_VARIABLE, unread: SHELL_UNREAD_VARIABLE };

// ---------- Messages ----------

const NPX_SETUP_MESSAGE = "Install Clotr Guard with npm install -g clotr-guard before setting up hooks.";
const CHOOSE_TOOL = `Choose ${IMPLEMENTED_TOOL_NAMES.slice(0, -1).join(", ")} or ${IMPLEMENTED_TOOL_NAMES[IMPLEMENTED_TOOL_NAMES.length - 1]}.`;
const PARTIAL_READ_MESSAGE = "Clotr checked the first 256 KiB; the rest of the file wasn't checked.";

// ---------- Small helpers ----------

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  VERSION,
  GUARD_ROOT,
  GUARD_SCRIPT,
  TOOL_NAMES,
  IMPLEMENTED_TOOL_NAMES,
  SEVERITIES,
  READ_TOOLS,
  MAX_READ_BYTES,
  MAX_STDIN_BYTES,
  MAX_SETTINGS_BYTES,
  MAX_GIT_DIFF_BUFFER,
  MAX_READ_STDIN_BYTES,
  MAX_CHECK_BYTES,
  OPENABLE_PATH_LENGTH,
  HOOK_TIMEOUT_SECONDS,
  GIT_TIMEOUT_MS,
  GIT_LATE_NOTE,
  SEARCH_WALK_MAX_ENTRIES,
  SEARCH_WALK_MAX_MS,
  SEARCH_REACHABILITY_TIMEOUT_MS,
  SEARCH_FILTER_MAX_LENGTH,
  SEARCH_FILTER_MAX_COUNT,
  SHELL_WALK_MAX_ENTRIES,
  SHELL_WALK_MAX_MS,
  SHELL_TREE_WALK_MAX_ENTRIES,
  SHELL_RIPGREP_MAX_BUFFER,
  RIPGREP_MISSING,
  RIPGREP_IGNORE_FILES,
  SHELL_RG_IGNORED_ASK_AT,
  SHELL_OPERAND_MAX_LOOKUPS,
  SHELL_OPERAND_MAX_MS,
  SHELL_DRIVE_PATH_MAX_MS,
  SHELL_CHECK_MAX_MS,
  SHELL_TOO_MANY_PATHS,
  SHELL_FOLDER_TOO_BIG,
  HOOK_CHECK_MAX_MS,
  SHELL_CHECK_UNFINISHED,
  SHELL_UNFINISHED_OUTCOME,
  SHELL_CHECK_FAILED,
  SHELL_FAILED_OUTCOME,
  SHELL_SECRET_VARIABLE,
  SHELL_UNREAD_VARIABLE,
  ENVIRONMENT_LOCATIONS,
  CHECK_WORKER_MIN_CHARS,
  SEARCH_WALK_LIMIT_NOTE,
  NPX_SETUP_MESSAGE,
  CHOOSE_TOOL,
  hasOwn,
  cloneJson,
  PARTIAL_READ_MESSAGE,
};

#!/usr/bin/env node
/* global require, module, process, console, __dirname, Buffer, performance, setTimeout, clearTimeout */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn, spawnSync } = require("child_process");
const { TextDecoder } = require("util");
const { check, isPersonalKind, ENGINE_PATH } = require("../lib/engine.js");
const { isSecretFile } = require("../lib/secret-files.js");
const {
  MAX_BYTES,
  parseClotrIgnore,
  pathIgnored,
  readClotrIgnore,
  valueFingerprint,
} = require("../lib/clotrignore.js");

// The package's own version: a packed copy has nothing outside its folder, so the extension's manifest is out of
// reach there, and a test keeps the two in step.
const VERSION = require("../package.json").version;
// The editor plugins use TOOL_NAMES for their setup picker. The CLI also supports Cline's extensionless hooks.
const TOOL_NAMES = ["claude", "cursor", "gemini", "codex", "windsurf"];
const IMPLEMENTED_TOOL_NAMES = [...TOOL_NAMES, "cline"];
const SEVERITIES = ["low", "medium", "high"];
const READ_TOOLS = new Set(["claude", "cursor", "gemini", "codex", "windsurf", "cline"]);
const MAX_READ_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_GIT_DIFF_BUFFER = 16 * 1024 * 1024;
// Cursor sends the whole file with a read, so its event gets more room, enough to check the first 256 KiB of a big one.
const MAX_READ_STDIN_BYTES = 64 * 1024 * 1024;
const MAX_CHECK_BYTES = 1024 * 1024;
// The longest path the system opens: Windows' 32,767 characters, and Linux's 4,096 bytes (macOS's is shorter).
const OPENABLE_PATH_LENGTH = process.platform === "win32" ? 32767 : 4096;
const HOOK_TIMEOUT_SECONDS = 15;
const SEARCH_WALK_MAX_ENTRIES = 2048;
const SEARCH_WALK_MAX_MS = 250;
const SEARCH_REACHABILITY_TIMEOUT_MS = 250;
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
// A text this long or longer is checked in a worker thread the hook can stop at its deadline (see checkBy).
const CHECK_WORKER_MIN_CHARS = 64 * 1024;
const SEARCH_WALK_LIMIT_NOTE =
  "Clotr couldn't finish checking this search for secret-file paths within its limits, so the search went through.";
const NPX_SETUP_MESSAGE = "Install Clotr Guard with npm install -g clotr-guard before setting up hooks.";
const CHOOSE_TOOL = `Choose ${IMPLEMENTED_TOOL_NAMES.slice(0, -1).join(", ")} or ${IMPLEMENTED_TOOL_NAMES[IMPLEMENTED_TOOL_NAMES.length - 1]}.`;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function removeFile(file, force = false) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!force || error.code !== "ENOENT") throw error;
  }
}
// The options each command a person types takes, and whether one is followed by a value. Hook commands aren't listed:
// an assistant runs those, and a stray option there must never stop a prompt.
const COMMAND_OPTIONS = {
  check: { "--json": false, "--min-severity": true },
  "commit-check": { "--personal-details": false },
  "ignore-value": { "--kind": true },
  setup: {
    "--project": false,
    "--dry-run": false,
    "--min-severity": true,
    "--personal-details": false,
    "--windsurf-jetbrains": false,
  },
  remove: {
    "--project": false,
    "--dry-run": false,
    "--min-severity": true,
    "--personal-details": false,
    "--windsurf-jetbrains": false,
  },
  mcp: { "--print-config": true },
};
const PARTIAL_READ_MESSAGE = "Clotr checked the first 256 KiB; the rest of the file wasn't checked.";

function minSeverity(value = "medium") {
  return SEVERITIES.includes(value) ? value : "medium";
}

function engineVersion() {
  try {
    const header = fs.readFileSync(ENGINE_PATH, "utf8").split(/\r?\n/, 1)[0];
    const match = /^\/\/ Clotr engine (\d+(?:\.\d+){2,3}):/.exec(header);
    return match ? match[1].split(".").slice(0, 3).join(".") : "unknown";
  } catch {
    return "unknown";
  }
}

function atLeastSeverity(findings, minimum = "medium") {
  return findings.filter((finding) => SEVERITIES.indexOf(finding.severity) >= SEVERITIES.indexOf(minSeverity(minimum)));
}

function dataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.CLOTR_GUARD_DATA_DIR) return env.CLOTR_GUARD_DATA_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Clotr", "guard");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Clotr", "guard");
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "clotr", "guard");
}

function promptHash(salt, prompt) {
  return crypto.createHash("sha256").update(salt).update("\0").update(prompt).digest("hex");
}

function loadRepeat(file) {
  try {
    const state = JSON.parse(readConfigFile(file, 16 * 1024).content);
    if (
      /^[0-9a-f]{64}$/.test(state.salt) &&
      Array.isArray(state.fingerprints) &&
      state.fingerprints.length > 0 &&
      state.fingerprints.every((fingerprint) => /^[0-9a-f]{64}$/.test(fingerprint)) &&
      Number.isFinite(state.at)
    ) {
      return state;
    }
  } catch {
    // A damaged repeat record can't authorize a resend.
  }
  return null;
}

function formatFindings(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.label, (counts.get(finding.label) || 0) + 1);
  return [...counts].map(([label, count]) => `${label}${count > 1 ? ` ×${count}` : ""}`).join(", ");
}

function findingFingerprints(salt, text, findings) {
  const fingerprints = [];
  for (const finding of findings) {
    if (
      !Number.isInteger(finding.start) ||
      !Number.isInteger(finding.end) ||
      finding.start < 0 ||
      finding.end > text.length
    ) {
      return null;
    }
    fingerprints.push(promptHash(salt, text.slice(finding.start, finding.end)));
  }
  return fingerprints.sort();
}

function sameFingerprints(left, right) {
  return left.length === right.length && left.every((fingerprint, index) => fingerprint === right[index]);
}

// An internal address is everyday talk with a coding assistant ("the server at 10.0.0.5 returns a 500"), so it waits
// behind the personal-details option and, even with that on, is only reported and never stops anything.
function isInternalAddress(kind) {
  return kind === "internal_ip" || kind === "internal_host";
}

function isPersonalDetail(kind) {
  return isInternalAddress(kind) || isPersonalKind(kind);
}

function inspectText(
  tool,
  text,
  {
    dataDir = dataDirectory(),
    now = Date.now(),
    minimum = "medium",
    key = "prompt",
    repeat = true,
    includePersonalDetails = false,
    cwd = process.cwd(),
    ignoreFingerprints = [],
    deadline,
    // The repository's ignore file, when the caller has already looked it up (see clotrIgnoreFor).
    repositoryIgnoreFile,
  } = {},
) {
  const file = path.join(dataDir, `${key}-repeat.json`);
  const state = loadRepeat(file);
  if (typeof text !== "string") return { action: "allow", internalError: true };
  let result;
  try {
    const config = (repositoryIgnoreFile ?? clotrIgnoreFor(cwd)).config;
    const checkOptions = {
      site: tool,
      ignoreSalt: config.valid ? config.salt : null,
      ignoreFingerprints: config.valid ? [...config.fingerprints, ...ignoreFingerprints] : ignoreFingerprints,
    };
    result = deadline === undefined ? check(text, checkOptions) : checkBy(text, checkOptions, deadline);
  } catch (error) {
    if (error instanceof CheckUnfinished) return { action: "block", unfinished: true };
    return { action: "allow", internalError: true };
  }
  const considered = result.findings.filter((finding) => includePersonalDetails || !isPersonalDetail(finding.kind));
  const findings = atLeastSeverity(considered, minimum);
  const belowMinimumPresent = considered.some(
    (finding) => SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(minSeverity(minimum)),
  );
  // The engine's time limit cut the scan short, so the rest of the text wasn't checked: it's stopped, as a check that
  // didn't finish is, with what was found so far, and sending it again doesn't let it through.
  if (result.truncated) {
    return {
      action: "block",
      unfinished: true,
      findings: findings.filter((finding) => !isInternalAddress(finding.kind)),
      belowMinimumPresent,
    };
  }
  if (!findings.some((finding) => !isInternalAddress(finding.kind))) {
    return {
      action: "allow",
      result,
      belowMinimumOnly: belowMinimumPresent,
      ...(findings.length ? { reported: findings } : {}),
    };
  }
  const blockingFindings = findings.filter((finding) => !isInternalAddress(finding.kind));
  if (repeat && state && now - state.at >= 0 && now - state.at < 120_000) {
    const fingerprints = findingFingerprints(state.salt, text, blockingFindings);
    if (fingerprints && sameFingerprints(fingerprints, state.fingerprints)) {
      return { action: "allow", repeated: true };
    }
  }
  if (!repeat) return { action: "block", findings, belowMinimumPresent };

  try {
    const salt = crypto.randomBytes(32).toString("hex");
    const fingerprints = findingFingerprints(salt, text, blockingFindings);
    if (!fingerprints) return { action: "block", findings, belowMinimumPresent };
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe-repeat-directory");
    try {
      const existing = fs.lstatSync(file);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("unsafe-repeat-file");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    atomicWriteFile(file, `${JSON.stringify({ salt, fingerprints, at: now })}\n`, { mode: 0o600 });
  } catch {
    // A prompt already known to contain a secret stays stopped if its repeat record can't be stored safely.
    return { action: "block", findings, belowMinimumPresent };
  }
  return { action: "block", findings, belowMinimumPresent };
}

class CheckUnfinished extends Error {}

const CHECK_WORKER_SOURCE = `"use strict";
const { workerData } = require("worker_threads");
const { engine, text, options, port, done } = workerData;
try {
  let reply;
  try {
    reply = { result: require(engine).check(text, options) };
  } catch {
    reply = { failed: true };
  }
  port.postMessage(reply);
} finally {
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
}`;

// check(), finished by `deadline` (a Date.now() time) or CheckUnfinished. The engine's own time limit is fixed, ten
// seconds a scan, and detect() takes no options, so a run on this thread can't be cut short; a long text is checked
// in a worker thread instead, waited for until the deadline and then stopped. A short one is checked here: it takes
// well under a second, less than a worker costs to start. If a worker can't start, the text is checked here too.
function checkBy(text, options, deadline) {
  if (Date.now() >= deadline) throw new CheckUnfinished();
  if (text.length < CHECK_WORKER_MIN_CHARS) return check(text, options);
  let worker;
  let port;
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");
  try {
    const channel = new MessageChannel();
    port = channel.port1;
    worker = new Worker(CHECK_WORKER_SOURCE, {
      eval: true,
      workerData: { engine: path.join(__dirname, "..", "lib", "engine.js"), text, options, port: channel.port2, done },
      transferList: [channel.port2],
    });
  } catch {
    port?.close();
    return check(text, options);
  }
  // A worker's error (out of memory, or a throw before it answers) reaches this thread only after the wait, once the
  // hook has its answer: without an answer that's a check that didn't finish, which stops the command. Unheard, Node
  // would rethrow it here and crash the hook after it answered, and a hook that exits 1 lets the command through.
  const unheard = () => {};
  worker.on("error", unheard);
  worker.on("messageerror", unheard);
  try {
    Atomics.wait(done, 0, 0, Math.max(0, deadline - Date.now()));
    let reply;
    try {
      reply = receiveMessageOnPort(port)?.message;
    } catch {
      throw new CheckUnfinished();
    }
    if (!reply) throw new CheckUnfinished();
    if (!reply.result) throw new Error("check-failed");
    return reply.result;
  } finally {
    port.close();
    worker.unref();
    worker.terminate().catch(() => {});
  }
}

// The deadline of a hook run from the command line, which passes when it started (`startedAt`, a Date.now() time):
// a check still running then is stopped as one that didn't finish, well before the assistant's own hook timeout,
// which would let the prompt, read or tool call through unchecked. Called from code, with no start, there is none.
function hookDeadline(options) {
  if (options.deadline !== undefined) return options.deadline;
  if (options.startedAt === undefined) return undefined;
  return options.startedAt + (options.hookCheckMaxMs ?? HOOK_CHECK_MAX_MS);
}

function inspectPrompt(tool, prompt, options = {}) {
  return inspectText(tool, prompt, { ...options, key: "prompt", deadline: hookDeadline(options) });
}

// Control characters that plain text doesn't hold; tab, the line breaks and ESC (for colored logs) are left out.
const NOT_TEXT = /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\ufffe\uffff]/;

// The file's text, or undefined when its bytes aren't text. Windows tools write UTF-16, some without a byte order
// mark, and older ones a single-byte code page; a UTF-16 .env holds the same keys, so all of those are read as text.
function decodeText(bytes, partial) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2), partial);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(Buffer.from(bytes.subarray(2)), partial, true);
  if (bytes.includes(0)) return looksLikeUtf16(bytes) ? decodeUtf16(bytes, partial) : undefined;
  for (let trim = 0; trim <= (partial ? 3 : 0); trim += 1) {
    try {
      // A partial UTF-8 character at the end of the checked prefix can be left for the next read.
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim));
    } catch {
      // Not UTF-8, or not with this many bytes trimmed.
    }
  }
  // Anything left is a single-byte code page, where every byte is a character, unless it carries control bytes.
  const text = bytes.toString("latin1");
  return NOT_TEXT.test(text) ? undefined : text;
}

// UTF-16LE without a byte order mark is mostly ASCII, so most code units have a zero high byte and a nonzero low one.
function looksLikeUtf16(bytes) {
  let ascii = 0;
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    if (bytes[index] !== 0 && bytes[index + 1] === 0) ascii += 1;
  }
  return ascii >= 0.75 * Math.floor(bytes.length / 2) && ascii > 0;
}

function decodeUtf16(bytes, partial, bigEndian = false) {
  let usable = bytes;
  if (bytes.length % 2) {
    if (!partial) return undefined;
    usable = usable.subarray(0, usable.length - 1);
  }
  if (bigEndian) usable.swap16();
  // The first half of a surrogate pair cut at the cap is left for the next read.
  if (partial && usable.length >= 2 && (usable.readUInt16LE(usable.length - 2) & 0xfc00) === 0xd800) {
    usable = usable.subarray(0, usable.length - 2);
  }
  try {
    const text = new TextDecoder("utf-16le", { fatal: true }).decode(usable);
    return NOT_TEXT.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

function parseToolInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readInvocation(tool, event) {
  if (tool === "cursor") return { name: "read_file", args: { file_path: event?.file_path } };
  if (tool === "windsurf") return { name: "read_file", args: { file_path: event?.tool_info?.file_path } };
  if (tool === "cline") {
    const args = parseToolInput(event?.preToolUse?.parameters);
    return {
      name: event?.preToolUse?.toolName || (args?.path || args?.file_path || args?.absolute_path ? "read_file" : ""),
      args,
    };
  }
  return { name: event?.tool_name, args: parseToolInput(event?.tool_input) };
}

// A path on another computer or a Windows device path: `\\host\share`, `//host/share`, `\\?\`, `\\.\`, `\??\`, or a
// `file:` URL. To look one up, Windows connects to the host, and the connection can hand that host the user's sign-in
// hash. So Guard judges these paths by name alone, and never looks them up, lists them, or runs Git or ripgrep in one.
// `/net/<host>/...` is the same on macOS, and on Linux with autofs: looking one up mounts that host's shares.
const NETWORK_PATH = /^\s*['"]?(?:[\\/]{2}|[\\/]\?\?[\\/]|file:)/i;
const AUTOMOUNT_PATH = /^\s*['"]?\/net(?:\/|$)/i;
// Where macOS mounts other disks and file shares, which another computer often serves (see onMountedVolume).
const VOLUME_PATH = /^\s*['"]?\/volumes(?:\/|$)/i;

// Whether a path starting with `/` sits under the root `pattern` names, as written or tidied: `/tmp/../net/host` and
// `/./net/host` reach /net/host too. (The letter case is ignored, as macOS's own disks ignore it.)
function underRoot(pattern, value) {
  if (typeof value !== "string") return false;
  if (pattern.test(value)) return true;
  const written = value.replace(/^\s*['"]?/, "");
  return written.startsWith("/") && pattern.test(path.posix.normalize(written));
}

function isRemotePath(value) {
  return typeof value === "string" && (NETWORK_PATH.test(value) || underRoot(AUTOMOUNT_PATH, value));
}

// `text` without the characters in `chars` at its end. Done without a `$`-anchored expression, which is tried from
// every place in the text and made a long run of blank space in a command take seconds.
function trimEndOf(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

// One part of a path without a stream name: "ENV~1::$DATA" (any "name:stream") opens "ENV~1", and "a:hidden" opens a
// stream of "a". A drive (`C:`, `C:.`) is left as it is, and so is an IPv6 address, a share's host
// (`\\?\UNC\::1\C$`, `[::1]`): a file name written that way, with no `$` type, opens nothing.
function withoutStream(part) {
  const colon = part.indexOf(":");
  if (
    colon < 0 ||
    /^[A-Za-z]:[. ]*$/.test(part) ||
    /^\[?(?:[0-9A-Fa-f.]*:){2,}[0-9A-Fa-f.]*(?:%[^\]]*)?\]?$/.test(part)
  ) {
    return part;
  }
  return part.slice(0, colon);
}

// The start of a Windows device path, `\\?\`, `\\.\` or `\??\`, either slash, and doubled as a string in a script
// writes them (`\\\\.\\C:`).
const DEVICE_PATH_START = /^\s*['"]?(?:[\\/]{2,}[?.]|[\\/]+\?\?)[\\/]+/;

// The drive paths a Windows device path to a file on a drive could open, or null for any other path: `C:\proj\.env`
// for `\\?\C:\proj\.env`, `\\.\C:\proj\.env` or `\??\C:\proj\.env`, and for `\\.\GLOBALROOT\??\C:\...` or
// `\\?\Global\C:\...`, other names for the device root. `\\?\` opens each part as written, and `\\.\` as Windows
// tidies it (a part's one last dot dropped, as in `C:.` or `k.`, and the last part's dots and spaces), so both readings
// are given, and a path is a secret file when either is. `.` and `..` are resolved, even past the drive, so
// `\\.\C:\..\UNC\host\share` is no drive path. isRemotePath still holds for the device path itself; the secret-file
// checks (isSecretPath, isSecretOperand) judge these drive paths in its place, so a short name or a link behind it is
// seen.
function localDevicePaths(value) {
  const drives = [];
  for (const [first = "", ...rest] of devicePathReadings(value) || []) {
    const drive = `${first}\\${rest.join("\\")}`;
    if (/^[A-Za-z]:$/.test(first) && !drives.includes(drive)) drives.push(drive);
  }
  return drives.length ? drives : null;
}

// The parts below the device root a Windows device path opens, as written and as Windows tidies them, with `.` and
// `..` resolved and the device root's other names dropped (see localDevicePaths); null for any other path.
// With `literal`, `.` and `..` are kept as parts, as `\\?\` and `\??\` pass them on.
function devicePathReadings(value, { literal = false } = {}) {
  if (typeof value !== "string") return null;
  const start = DEVICE_PATH_START.exec(value);
  if (!start) return null;
  let text = value.slice(start[0].length);
  if (/['"]$/.test(text)) text = text.slice(0, -1);
  const parts = text.split(/[\\/]/);
  const readings = windowsReadings(parts, { literal }).map(belowDeviceRoot);
  // The root as the system looks it up: `\\?\` and `\??\` open it as written, so `\\?\C:.\` (or `HarddiskVolume3.`,
  // `Global.`, `UNC.`) is a name a program could define pointing anywhere, not the drive; `\\.\` tidies it, dropping
  // only a part's one last dot, so `\\.\C:.\` is the drive but `\\.\C: \`, `\\.\C:. \` and `\\.\C:..\` are names too.
  // A stream name on it (`HarddiskVolume3:x`, `UNC:x`) is part of the name, either way. Where that root is no name
  // Guard knows, only that reading is given, so the path is judged as one through a name Guard can't place (see
  // opensUnknownDevice), and no other name is looked up in its place.
  const exact = EXACT_DEVICE_PATH_START.test(value);
  const opened = belowDeviceRoot(windowsReadings(parts, { literal, streams: true })[exact ? 0 : 1]);
  if (!knownDeviceRoot(opened)) return [opened];
  return readings;
}

// The start of a device path whose root Windows opens as written, `\\?\` or `\??\` (see DEVICE_PATH_START).
const EXACT_DEVICE_PATH_START = /^\s*['"]?(?:[\\/]{2,}\?|[\\/]+\?\?)[\\/]/;

// A device path's parts without the device root's other names (see localDevicePaths).
function belowDeviceRoot(resolved) {
  // Counted, not cut off one at a time, so a path padded with thousands of them still takes one pass.
  let root = 0;
  for (;;) {
    const first = resolved[root] || "";
    if (/^global$/i.test(first)) root += 1;
    else if (/^globalroot$/i.test(first) && /^(?:\?\?|global\?\?|dosdevices)$/i.test(resolved[root + 1] || "")) {
      root += 2;
    } else if (
      // A logon session's own DOS devices (`GLOBALROOT\Sessions\0\DosDevices\00000000-0001f3a9`), which hold its
      // mapped drives and a `Global` link to the rest, are the same names.
      /^globalroot\\sessions\\\d+\\dosdevices\\[0-9a-f]+-[0-9a-f]+$/i.test(resolved.slice(root, root + 5).join("\\"))
    ) {
      root += 5;
    } else break;
  }
  return root ? resolved.slice(root) : resolved;
}

// Path parts, `.` and `..` resolved, read as written and as Windows tidies them: a stream name dropped, a part's one
// last dot, and the last part's dots and spaces (see localDevicePaths). Empty parts are left out. With `literal`, `.`
// and `..` are kept as they are; with `streams`, stream names are too.
function windowsReadings(parts, { literal = false, streams = false } = {}) {
  const strip = streams ? (part) => part : withoutStream;
  const resolved = [];
  const dots = (part) => part === "." || part === "..";
  for (const part of parts) {
    if (!part || (part === "." && !literal)) continue;
    if (part === ".." && !literal) resolved.pop();
    else resolved.push(part);
  }
  const asWritten = resolved.map(strip);
  const tidied = resolved.map((part, index) => {
    if (dots(part)) return part;
    const opened = strip(part);
    if (index === resolved.length - 1) return trimEndOf(opened, ". ");
    return opened.endsWith(".") && !opened.endsWith("..") ? opened.slice(0, -1) : opened;
  });
  return [asWritten.filter(Boolean), tidied.filter(Boolean)];
}

// The drive paths a path on a drive opens once Windows tidies it, when that isn't the path itself: a part ending in a
// dot, a space or a stream name (`kubelink.\config`, `ENV~1.`) opens as it does behind `\\.\` (see localDevicePaths),
// but Node's own lookups ask for the name as written. Null for any other path, which costs no lookup more.
function windowsTidiedPaths(value, cwd) {
  // Only Windows resolves a path to a drive.
  if (process.platform !== "win32" || typeof value !== "string" || typeof cwd !== "string") return null;
  const text = value.replace(/^['"]|['"]$/g, "");
  // A relative path in a share's folder (`\\host\share\proj`) resolves to the share, not a drive.
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(cwd) && !/^(?:[A-Za-z]:|[\\/])/.test(text)) return null;
  const absolutePath = path.resolve(cwd, text);
  if (!/^[A-Za-z]:[\\/]/.test(absolutePath) || !/[. ](?:[\\/]|$)|:/.test(absolutePath.slice(2))) return null;
  if (remoteLocation(value, cwd)) return null;
  // Only the last part tidied (`notes.`, `ENV~1 `), as most are: its last dots and spaces dropped, as below.
  const last = absolutePath.lastIndexOf("\\");
  const name = trimEndOf(absolutePath.slice(last + 1), ". ");
  if (name && !/['"]/.test(name) && !/[. ][\\/]|:/.test(absolutePath.slice(2, last + 1))) {
    const drivePath = absolutePath.slice(0, last + 1) + name;
    return drivePath === absolutePath ? null : [drivePath];
  }
  const tidied = (localDevicePaths(`\\\\.\\${absolutePath}`) || []).filter((drivePath) => drivePath !== absolutePath);
  return tidied.length ? tidied : null;
}

// A drive's own share on a computer, `\\localhost\C$\proj\.env`, `//host/c$/...`, `\\?\UNC\host\C$\...`,
// `\\.\UNC\host\C$\...` or `\\.\GLOBALROOT\Device\Mup\host\C$\...`, or a relative path in a folder on one: each drive
// path it names on that computer (`C:\proj\.env`), with whether the computer is this one (see isLoopbackHost). Null for
// any other path. Any computer's share is mapped, so a name hidden by the share's form is still seen; only this
// computer's is looked up, and only on its own drive: the share itself never is (see isRemotePath). A local volume's
// device path by any of the system's names for it (`\\?\Volume{...}\proj\.env`, `\\.\HarddiskVolume3\...`, see
// localVolumeStart) gives the drive path the system resolves it to, with `lookups` (see volumeDrivePath), as this
// computer's.
function driveSharePaths(value, cwd, { lookups = true, budget } = {}) {
  if (typeof value !== "string") return null;
  let text = value.replace(/^\s*['"]?/, "").replace(/['"]$/, "");
  // A path on a drive is no share, whatever folder it's named from.
  if (/^[A-Za-z]:[\\/]/.test(text)) return null;
  if (!NETWORK_PATH.test(text) && typeof cwd === "string" && NETWORK_PATH.test(cwd)) {
    // A device path folder (`\??\UNC\host\C$\proj`) is joined as it is: Node would read it as a folder on this drive.
    const folder = cwd.replace(/^\s*['"]?/, "").replace(/['"]$/, "");
    if (!DEVICE_PATH_START.test(folder)) text = path.win32.resolve(folder, text);
    else if (!path.win32.isAbsolute(text)) text = `${folder}\\${text}`;
  }
  // Both forms start with a slash: anything else is no share, without the tests below.
  if (!/^[\\/]/.test(text)) return null;
  const device = devicePathReadings(text);
  const found = [];
  let readings;
  // Where `.` and `..` could take the path to another root (see dotsMayLeaveRoot), this computer's drive path is still
  // looked up for a link or a short name, as the system or a program may resolve them, but one that passes them on
  // could open another computer's file there, so the item is `dotted`: a read isn't checked from the drive.
  const literalDots = dotsMayLeaveRoot(text);
  if (device) {
    // A local volume by one of the system's names for it (see localVolumeStart); else `UNC\host\share`, or the same
    // root by a device name (see shareParts).
    const lookedUp = new Set();
    readings = device.flatMap((parts) => {
      const volumeStart = localVolumeStart(parts);
      if (volumeStart > 0) {
        // The same path read two ways is looked up once. A volume with no drive letter gives the path it resolves to,
        // judged by its name, as the volume isn't looked up again.
        const key = parts.join("\\");
        if (lookups && !lookedUp.has(key)) {
          lookedUp.add(key);
          const drive = volumeDrivePath(parts, volumeStart, budget);
          const loopback = Boolean(drive) && /^[A-Za-z]:\\/.test(drive);
          if (drive) found.push({ drive, loopback, ...(literalDots && loopback ? { dotted: true } : {}) });
        }
        return [];
      }
      const share = shareParts(parts);
      return share ? [share] : [];
    });
  } else if (/^[\\/]{2,}[^\\/?]/.test(text)) {
    // `..` stops at the share, as Windows reads a share path; it's also read going past the share, to be safe. A path
    // written into a script's string doubles its backslashes (`\\\\localhost\\C$\\...`), so separators are read as one.
    const [host, share, ...rest] = text.replace(/^[\\/]+/, "").split(/[\\/]+/);
    readings = windowsReadings([share, ...rest]);
    if (rest.includes("..")) readings.push(...windowsReadings(rest).map((parts) => [share, ...parts]));
    readings = readings.map((parts) => [host, ...parts]);
  } else return null;
  for (const [host = "", share = "", ...rest] of readings) {
    const letter = /^([A-Za-z])\$$/.exec(trimEndOf(withoutStream(share), ". "));
    if (!host || !letter) continue;
    const drive = `${letter[1]}:\\${rest.join("\\")}`;
    const loopback = isLoopbackHost(host);
    const dotted = literalDots && loopback;
    if (!found.some((item) => item.drive === drive && item.loopback === loopback)) {
      found.push({ drive, loopback, ...(dotted ? { dotted } : {}) });
    }
  }
  return found.length ? found : null;
}

// A device path's `host\share\rest` parts below `UNC`, or the same root by a device name, `GLOBALROOT\Device\Mup` or
// `...\LanmanRedirector`, with any `;provider` parts after it; null for any other root.
function shareParts(parts) {
  let start = -1;
  if (/^unc$/i.test(parts[0] || "")) start = 1;
  else if (/^globalroot\\device\\(?:mup|lanmanredirector)$/i.test(parts.slice(0, 3).join("\\"))) start = 3;
  if (start < 0) return null;
  while ((parts[start] || "").startsWith(";")) start += 1;
  return parts.slice(start);
}

// How many of a device path reading's first parts name the root below which it opens a path: a drive (`C:`), a local
// volume (see localVolumeStart), or a share's host and share (see shareParts); 0 for any other root.
function deviceRootLength(parts) {
  if (/^[A-Za-z]:[. ]*$/.test(parts[0] || "")) return 1;
  const volume = localVolumeStart(parts);
  if (volume > 0) return volume;
  const share = shareParts(parts);
  return share && share.length >= 2 ? parts.length - share.length + 2 : 0;
}

// Whether a `\\?\` or `\??\` path's `.` and `..`, which those can pass on as names, could take it to another root
// (another computer's share, from `\\?\UNC\host\share\..\..\..\C:\...`) than the one Guard reads with them resolved.
// Not when each reading with them kept (see devicePathReadings) starts at the resolved one's root, and its path below
// that root, `..` stopping at the root, is the resolved one's: then the path opens that file or nothing, however a
// program treats the dots.
function dotsMayLeaveRoot(value) {
  if (typeof value !== "string") return false;
  const text = value.replace(/^\s*['"]?/, "").replace(/['"]$/, "");
  if (!/^(?:[\\/]{2,}\?|[\\/]+\?\?)[\\/]/.test(text)) return false;
  if (!/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(text.replace(DEVICE_PATH_START, ""))) return false;
  const literal = devicePathReadings(text, { literal: true }) || [];
  const resolved = devicePathReadings(text) || [];
  if (!literal.length || literal.length !== resolved.length) return true;
  const same = (left, right) => left.join("\\").toLowerCase() === right.join("\\").toLowerCase();
  return !literal.every((parts, index) => {
    const opened = resolved[index];
    const rootLength = deviceRootLength(opened);
    if (!rootLength || deviceRootLength(parts) !== rootLength) return false;
    const root = parts.slice(0, rootLength);
    if (root.some((part) => part === "." || part === "..") || !same(root, opened.slice(0, rootLength))) return false;
    const below = [];
    for (const part of parts.slice(rootLength)) {
      if (part === "..") below.pop();
      else if (part !== ".") below.push(part);
    }
    return same(below, opened.slice(rootLength));
  });
}

// The system's names for a local disk volume: at the top of its namespace, and under `GLOBALROOT\Device`.
const VOLUME_NAME =
  /^(?:volume\{[0-9a-f-]+\}|harddiskvolume(?:shadowcopy)?\d+|harddisk\d+partition\d+|bootpartition|systempartition|cdrom\d+)$/i;
const VOLUME_DEVICE_NAME =
  /^(?:volume\{[0-9a-f-]+\}|harddiskvolume(?:shadowcopy)?\d+|bootdevice|bootpartition|systempartition|cdrom\d+)$/i;

// Where the path below a local volume's device name starts in a device path's `parts`, or -1 for any other name. Only
// the system's own names for a disk volume are listed (`Volume{...}`, `HarddiskVolume3`, `Harddisk0Partition3`,
// `GLOBALROOT\Device\Harddisk0\Partition3`, `...\BootDevice`, `GLOBALROOT\ArcName\...`, `GLOBALROOT\SystemRoot`, ...):
// any other device name could be a redirector that reaches another computer, so it's never looked up.
function localVolumeStart(parts) {
  const [first = "", second = "", third = "", fourth = ""] = parts;
  if (VOLUME_NAME.test(first)) return 1;
  if (!/^globalroot$/i.test(first)) return -1;
  if (/^systemroot$/i.test(second)) return 2;
  // A whole ARC name, `multi(0)disk(0)rdisk(0)partition(3)`: one cut short is no volume's.
  if (/^arcname$/i.test(second) && /^(?:[a-z]+\([0-9a-f]*\))+$/i.test(third)) return 3;
  if (!/^device$/i.test(second)) return -1;
  if (VOLUME_DEVICE_NAME.test(third)) return 3;
  if (/^harddisk\d+$/i.test(third) && /^partition\d+$/i.test(fourth)) return 4;
  return -1;
}

// The drive path the system gives for a local volume's device path (`Volume{...}\rest`,
// `GLOBALROOT\Device\HarddiskVolume3\rest` or another name in localVolumeStart, its parts up to `rest` at `start`),
// with links and short names resolved, or the device path it resolves to on a volume with no drive letter; null when
// nothing is there. One lookup on this computer, counted in `budget`: a check past its lookups stops rather than guess.
function volumeDrivePath(parts, start, budget) {
  if (budget) {
    checkShellDeadline(budget);
    if (lookupsSpent(budget)) throw new ShellCheckTooLong();
    budget.lookups -= 1;
  }
  try {
    const resolved = fs.realpathSync.native(
      `\\\\?\\${parts.slice(0, start).join("\\")}\\${parts.slice(start).join("\\")}`,
    );
    return resolved || null;
  } catch {
    return null;
  }
}

// This computer's names and addresses, worked out on first use: no lookup leaves the computer.
let ownHosts = null;

// Whether a share path's host is this computer: `localhost` (and any name under it), any 127.x address however it's
// written (`127.1`, `0x7f.1`), `::1` (also `[::1]` and `0--1.ipv6-literal.net`), an unspecified address, this
// computer's own name (alone, or with its sign-in domain), or one of its own addresses. Only a whole name counts:
// `<this computer>.example.com` could be another computer's.
function isLoopbackHost(host) {
  if (loopbackHosts.has(host)) return loopbackHosts.get(host);
  const loopback = hostIsThisComputer(host);
  if (loopbackHosts.size < 1024) loopbackHosts.set(host, loopback);
  return loopback;
}

// isLoopbackHost's answers so far: a long command names the same few hosts many times.
const loopbackHosts = new Map();

function hostIsThisComputer(host) {
  const name = trimEndOf(host.toLowerCase(), ".");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const address = hostAddress(name);
  if (address && (address === "4:0" || address.startsWith("4:127.") || /^6:(?:0:){7}[01]$/.test(address))) return true;
  if (!ownHosts) {
    ownHosts = new Set();
    const domain = (process.env.USERDNSDOMAIN || "").toLowerCase();
    for (const own of [os.hostname(), process.env.COMPUTERNAME]) {
      if (typeof own !== "string" || !own) continue;
      ownHosts.add(own.toLowerCase());
      if (domain && !own.includes(".")) ownHosts.add(`${own.toLowerCase()}.${domain}`);
    }
    try {
      for (const items of Object.values(os.networkInterfaces())) {
        for (const item of items || []) ownHosts.add(hostAddress(item.address.toLowerCase()) || item.address);
      }
    } catch {
      // No address list: the names above still count.
    }
  }
  return ownHosts.has(name) || (address !== null && ownHosts.has(address));
}

// An IP address in one written form, `4:<a.b.c.d>` or `6:<eight groups>`, with an IPv4 address inside an IPv6 one
// (`::ffff:127.0.0.1`) given as IPv4; null for a name. IPv4 takes every form Windows reads: one to four parts, each
// decimal, octal (`0177`) or hexadecimal (`0x7f`).
function hostAddress(name) {
  if (name.length > 64) return null;
  const v4 = ipv4Value(name);
  if (v4 !== null) return `4:${v4 === 0 ? 0 : [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".")}`;
  let text = name.replace(/^\[|\]$/g, "");
  if (text.endsWith(".ipv6-literal.net")) text = text.slice(0, -17).replace(/-/g, ":").replace(/s/g, "%");
  text = text.replace(/%.*$/, "");
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const sides = halves.map((half) => (half ? half.split(":") : []));
  const last = sides[sides.length - 1];
  if (last.length && last[last.length - 1].includes(".")) {
    const inner = ipv4Value(last.pop());
    if (inner === null) return null;
    last.push((inner >>> 16).toString(16), (inner & 0xffff).toString(16));
  }
  const missing = 8 - sides.reduce((sum, side) => sum + side.length, 0);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...sides[0], ...Array(halves.length === 2 ? missing : 0).fill("0"), ...(sides[1] || [])];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const numbers = groups.map((group) => parseInt(group, 16));
  if (numbers.slice(0, 5).every((group) => group === 0) && (numbers[5] === 0xffff || numbers[5] === 0)) {
    const inner = numbers[6] * 65536 + numbers[7];
    if (numbers[5] === 0xffff || inner > 1) {
      return hostAddress(`${inner >>> 24}.${(inner >>> 16) & 255}.${(inner >>> 8) & 255}.${inner & 255}`);
    }
  }
  return `6:${numbers.join(":")}`;
}

function ipv4Value(text) {
  const parts = text.split(".");
  if (parts.length > 4 || !parts.every((part) => /^(?:0x[0-9a-f]*|0[0-7]*|[1-9]\d*)$/.test(part))) return null;
  const values = parts.map((part) =>
    /^0x/.test(part) ? parseInt(part.slice(2) || "0", 16) : /^0/.test(part) ? parseInt(part, 8) : Number(part),
  );
  const last = values.pop();
  if (values.some((value) => value > 255) || last >= 2 ** (8 * (4 - values.length))) return null;
  return values.reduce((sum, value, index) => sum + value * 2 ** (8 * (3 - index)), 0) + last;
}

// Whether a path written as one Guard never looks up (see isRemotePath) has a part that could be a Windows short name
// (`ENV~1`, `CREDEN~1.JSO`, also with a stream or last dots or spaces): only a lookup on the disk tells which file one
// opens, so there it could be any secret file. That holds in a WSL folder too, which can link to a Windows drive. A
// relative path in such a folder isn't counted, so `HEAD~1` in a WSL folder still passes.
function hasShortNamePart(value) {
  if (!isRemotePath(value)) return false;
  const text = /['"]$/.test(value) ? value.slice(0, -1) : value;
  return text
    .split(/[\\/]/)
    .some((part) => /^[^\s.~]{1,7}~\d{1,6}(?:\.[^\s.]{1,3})?$/.test(trimEndOf(withoutStream(part), ". ")));
}

// Whether a Windows device path goes through a name Guard can't place without a lookup it mustn't make: anything but a
// drive (`\\?\C:\`), another computer's share (`UNC`, `GLOBALROOT\Device\Mup` and the other redirectors), a local
// volume by one of the system's own names for it (see localVolumeStart), or a device that's no file (`pipe`, `NUL`). A
// volume's interface name (`STORAGE#Volume#...`), a link a program made among the session's objects, a DOS device a
// program defined or another driver's device can each open any folder on this computer, so a path through one could
// be any secret file; and some reach another computer, so none is looked up.
function opensUnknownDevice(value) {
  // devicePathReadings gives only the reading the system opens when its root is no name Guard knows, and the tidied
  // reading, whose root is the one the system opens, last.
  const readings = devicePathReadings(value);
  return Boolean(readings) && !knownDeviceRoot(readings[readings.length - 1]);
}

// The other roots opensUnknownDevice knows, at the top or under `GLOBALROOT\Device`, by what may follow them: a share's
// root names the computer below it, a device that's no file has nothing below it (a folder below `COM97` means a
// program defined that name), and a pipe or mailslot is named below its root.
const SHARE_ROOT_NAME = /^unc$/i;
const SHARE_DEVICE_NAME = /^(?:mup|lanmanredirector|webdavredirector|rdpdr|p9rdr)$/i;
const NO_FILE_NAME = /^(?:nul|con|conin\$|conout\$|prn|aux|com\d+|lpt\d+|physicaldrive\d+|tape\d+|display\d+)$/i;
const NO_FILE_DEVICE_NAME = /^null$/i;
const PIPE_NAME = /^(?:pipe|mailslot)$/i;
const PIPE_DEVICE_NAME = /^(?:namedpipe|mailslot)$/i;

// The root is judged as the system opens it (see devicePathReadings): `C:.`, `C: ` and `HarddiskVolume3:x` are no
// names Guard knows.
function knownDeviceRoot([first = "", ...below]) {
  if (/^[A-Za-z]:$/.test(first) || localVolumeStart([first, ...below]) > 0) return true;
  const device = /^globalroot$/i.test(first) && /^device$/i.test(below[0] || "");
  const name = device ? below[1] || "" : first;
  const rest = device ? below.slice(2) : below;
  if ((device ? SHARE_DEVICE_NAME : SHARE_ROOT_NAME).test(name)) return rest.length > 0;
  if ((device ? NO_FILE_DEVICE_NAME : NO_FILE_NAME).test(name)) return rest.length === 0;
  return (device ? PIPE_DEVICE_NAME : PIPE_NAME).test(name);
}

// Whether a path, or the folder a relative one sits in, passes `test`.
function locationIs(test, value, cwd) {
  if (test(value)) return true;
  if (typeof value !== "string" || typeof cwd !== "string") return false;
  return (!path.isAbsolute(value) && test(cwd)) || test(path.resolve(cwd, value));
}

// Whether a path, or the folder a relative one sits in, is one Guard must not touch (see isRemotePath).
function remoteLocation(value, cwd = process.cwd()) {
  // A path on a Windows drive is on this computer, whatever folder it's named from (elsewhere it's a relative path).
  if (process.platform === "win32" && typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value)) return false;
  return locationIs(isRemotePath, value, cwd);
}

// Whether a Windows drive-relative path (`C:Users\me\.kube\config`) is named from a folder on another computer: it
// opens below that drive's own working folder, which Guard can't see from there, so it could be any file on the
// drive, and it's judged as one through a name Guard can't place (see opensUnknownDevice). `C:` alone is that folder.
// A shell word with a part holding more colons than a path's stream and type (`s:a:b:`, where
// `kubelink:$I30:$INDEX_ALLOCATION` is a folder's), or one part with a space after the colon (`a: b`), names no path.
function driveRelativeFromRemote(value, cwd = process.cwd()) {
  if (process.platform !== "win32" || typeof value !== "string" || typeof cwd !== "string") return false;
  const match = /^[A-Za-z]:([\s\S]*)$/.exec(value.replace(/^\s*['"]/, "").replace(/['"]\s*$/, ""));
  if (!match || /^[\\/]/.test(match[1])) return false;
  const rest = match[1];
  if (/^\s/.test(rest) && !/[\\/]/.test(rest)) return false;
  const pathPart = /^[^:]*(?::[^:]*)?(?::\$[A-Za-z_]+)?$/;
  if (!rest.split(/[\\/]+/).every((part) => pathPart.test(part))) return false;
  return isRemotePath(cwd);
}

// Whether a path is under /Volumes. is_secret_file promises no network calls, so it judges these by name; the read
// hook still opens one to check its text, as Guard does on any disk the computer already has mounted.
function onMountedVolume(value, cwd = process.cwd()) {
  return locationIs((location) => underRoot(VOLUME_PATH, location), value, cwd);
}

function isDirectoryTarget(value, cwd) {
  if (typeof value !== "string" || !value || remoteLocation(value, cwd)) return false;
  try {
    const stats = fs.statSync(path.isAbsolute(value) ? value : path.resolve(cwd, value), { throwIfNoEntry: false });
    return Boolean(stats?.isDirectory());
  } catch {
    return false;
  }
}

// Glob matching without a regular expression. A glob compiled to a backtracking expression let every star try every
// part of a name, so a dozen stars against one long file name took minutes, and a hook that times out lets the command
// through. A glob is turned into tokens once; a name is matched by walking both together and, on a mismatch, going
// back only to the latest star, or, once `**` is in the glob, by keeping every place in the glob the name could have
// reached. Either way the work grows with the name's length times the glob's, never faster. The rules are the ones the
// expression had: `*` and `?` stop at a slash, `**` doesn't, `**/` is nothing or anything ending in a slash, a glob
// without a slash is matched against the last part of the path, and letters match either case, on every platform.
const GLOB_ANY = 0;
const GLOB_STAR = 1;
const GLOB_GLOBSTAR = 2;
const GLOB_GLOBSTAR_SLASH = 3;
// What brace alternatives can add up to (`{a,b}` is two globs), and the longest glob whose tokens are kept for reuse.
const GLOB_MAX_LEAVES_LENGTH = 1024 * 1024;
const GLOB_CACHE_MAX_LENGTH = 4096;
// The longest `[...]` class read as written; past it a class matches any letter but a slash.
const GLOB_CLASS_MAX_LENGTH = 256;
const globCache = new Map();

// A letter's case, folded the way a case-insensitive JavaScript expression folds it, so the rules don't change.
function foldGlobChar(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : ch;
  const upper = ch.toUpperCase();
  return upper.length !== 1 || upper.charCodeAt(0) < 128 ? ch : upper;
}

function foldGlobText(text) {
  if (!/[\u0080-￿]/.test(text)) return text.toUpperCase();
  let folded = "";
  for (let index = 0; index < text.length; index += 1) folded += foldGlobChar(text[index]);
  return folded;
}

// A `[...]` class (`[abc]`, `[a-z]`, `[!a]`, `[^a]`, `[[:digit:]]`) starting at `start`, or null when it isn't closed.
function parseGlobClass(text, start) {
  const named = {
    alpha: (ch) => /\p{L}/u.test(ch),
    digit: (ch) => /[0-9]/.test(ch),
    alnum: (ch) => /[\p{L}0-9]/u.test(ch),
    upper: (ch) => /\p{L}/u.test(ch),
    lower: (ch) => /\p{L}/u.test(ch),
    space: (ch) => /\s/.test(ch),
    blank: (ch) => /[ \t]/.test(ch),
    punct: (ch) => /[!-/:-@[-`{-~]/.test(ch),
    xdigit: (ch) => /[0-9a-f]/i.test(ch),
    word: (ch) => /[\p{L}0-9_]/u.test(ch),
  };
  // The `**` markers stand for the stars they replaced.
  const at = (index) => ({ "\u0000": "*", "\u0001": "*" })[text[index]] || text[index];
  const namedClass = /\[:([a-z]+):\]/y;
  let index = start + 1;
  const negate = at(index) === "!" || at(index) === "^";
  if (negate) index += 1;
  const singles = [];
  const ranges = [];
  const tests = [];
  let first = true;
  while (index < text.length && (first || at(index) !== "]")) {
    first = false;
    namedClass.lastIndex = index;
    const className = at(index) === "[" && at(index + 1) === ":" ? namedClass.exec(text) : null;
    if (className && named[className[1]]) {
      tests.push(named[className[1]]);
      index += className[0].length;
    } else if (at(index + 1) === "-" && index + 2 < text.length && at(index + 2) !== "]") {
      ranges.push([at(index), at(index + 2)]);
      index += 3;
    } else {
      singles.push(at(index));
      index += 1;
    }
  }
  if (index >= text.length) return null;
  // Only a reading that's safer matching more reads classes at all, so a class too long to be one anyone writes
  // matches any letter but a slash, as `?` does.
  if (index - start > GLOB_CLASS_MAX_LENGTH) return { end: index, token: GLOB_ANY };
  const set = new Set(singles);
  const hit = (ch) =>
    set.has(ch) || ranges.some(([low, high]) => ch >= low && ch <= high) || tests.some((test) => test(ch));
  // Each letter is looked up in the class once: a name's letters are tried against it again and again.
  const known = new Map();
  return {
    end: index,
    token: {
      test: (ch) => {
        let answer = known.get(ch);
        if (answer === undefined) {
          answer = ch !== "/" && negate !== (hit(ch) || hit(ch.toLowerCase()));
          known.set(ch, answer);
        }
        return answer;
      },
    },
  };
}

// A run of stars side by side matches what one of them does, or, past two kinds, what `**` does.
function simplifyGlobTokens(tokens) {
  const simplified = [];
  let run = [];
  const flush = () => {
    const kinds = run.filter((token, index) => index === 0 || token !== run[index - 1]);
    if (kinds.includes(GLOB_GLOBSTAR) || kinds.length >= 3) simplified.push(GLOB_GLOBSTAR);
    else simplified.push(...kinds);
    run = [];
  };
  for (const token of tokens) {
    if (token === GLOB_STAR || token === GLOB_GLOBSTAR || token === GLOB_GLOBSTAR_SLASH) run.push(token);
    else {
      flush();
      simplified.push(token);
    }
  }
  flush();
  return simplified;
}

// One glob, braces already expanded, as tokens: a folded letter, a class, or a wildcard number. With `classes`, a glob
// holding `[` is tried both ways, as a class and as the bracket itself, so either reading of it is matched.
function compileGlobLeaf(leaf, classes = false) {
  const marked = leaf.replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001");
  const build = (withClasses) => {
    const tokens = [];
    // A `[` left open reads to the end of the glob, so after one, every later `[` is the bracket itself: otherwise a
    // glob of brackets would be read once per bracket.
    let open = withClasses;
    for (let index = 0; index < marked.length; index += 1) {
      const ch = marked[index];
      if (ch === "\u0000") tokens.push(GLOB_GLOBSTAR_SLASH);
      else if (ch === "\u0001") tokens.push(GLOB_GLOBSTAR);
      else if (ch === "*") tokens.push(GLOB_STAR);
      else if (ch === "?") tokens.push(GLOB_ANY);
      else {
        const parsed = open && ch === "[" ? parseGlobClass(marked, index) : null;
        if (parsed) {
          tokens.push(parsed.token);
          index = parsed.end;
        } else {
          if (ch === "[") open = false;
          tokens.push(foldGlobChar(ch));
        }
      }
    }
    const simplified = simplifyGlobTokens(tokens);
    const wildcards = [GLOB_STAR, GLOB_GLOBSTAR, GLOB_GLOBSTAR_SLASH];
    // The letters a glob starts and ends with are where any name it matches starts and ends: a quick first look.
    const letters = (from, step) => {
      const run = [];
      for (let at = from; typeof simplified[at] === "string"; at += step) run.push(simplified[at]);
      return (step > 0 ? run : run.reverse()).join("");
    };
    return {
      prefix: letters(0, 1),
      suffix: letters(simplified.length - 1, -1),
      tokens: simplified,
      whole: leaf.includes("/"),
      minLength: simplified.filter((token) => !wildcards.includes(token)).length,
      globstar: simplified.some((token) => token === GLOB_GLOBSTAR || token === GLOB_GLOBSTAR_SLASH),
    };
  };
  return classes && marked.includes("[") ? [build(false), build(true)] : [build(false)];
}

function globTokenTakes(token, ch) {
  if (typeof token === "string") return token === ch;
  if (token === GLOB_ANY) return ch !== "/";
  return token.test(ch);
}

// Without `**`, a star never crosses a slash, so going back to the latest star is enough, and a star that would have
// to take a slash means no match at all.
function globStarsMatch(tokens, text) {
  let at = 0;
  let index = 0;
  let star = -1;
  let mark = 0;
  while (index < text.length) {
    if (tokens[at] === GLOB_STAR) {
      star = at;
      at += 1;
      mark = index;
    } else if (at < tokens.length && globTokenTakes(tokens[at], text[index])) {
      at += 1;
      index += 1;
    } else if (star >= 0 && text[mark] !== "/") {
      at = star + 1;
      mark += 1;
      index = mark;
    } else return false;
  }
  while (tokens[at] === GLOB_STAR) at += 1;
  return at === tokens.length;
}

// With `**`, every place in the glob the name could have reached is kept, one step per letter of the name. `**/` takes
// two places: before it (where it may also match nothing) and inside it, after at least one letter.
function globAllMatch(tokens, text) {
  const steps = [];
  for (const token of tokens) {
    if (token === GLOB_GLOBSTAR_SLASH) steps.push({ kind: "slashStart" }, { kind: "slashInside" });
    else if (token === GLOB_STAR || token === GLOB_GLOBSTAR) steps.push({ kind: token });
    else steps.push({ kind: "take", token });
  }
  const close = (active) => {
    for (let at = 0; at < steps.length; at += 1) {
      if (!active[at]) continue;
      const { kind } = steps[at];
      if (kind === GLOB_STAR || kind === GLOB_GLOBSTAR) active[at + 1] = 1;
      else if (kind === "slashStart") active[at + 2] = 1;
    }
  };
  let current = new Uint8Array(steps.length + 1);
  let next = new Uint8Array(steps.length + 1);
  current[0] = 1;
  close(current);
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    next.fill(0);
    let alive = false;
    for (let at = 0; at < steps.length; at += 1) {
      if (!current[at]) continue;
      const { kind, token } = steps[at];
      if (kind === "take") {
        if (globTokenTakes(token, ch)) next[at + 1] = alive = 1;
      } else if (kind === GLOB_STAR) {
        if (ch !== "/") next[at] = alive = 1;
      } else if (kind === GLOB_GLOBSTAR) {
        next[at] = alive = 1;
      } else if (kind === "slashStart") {
        next[at + 1] = alive = 1;
        if (ch === "/") next[at + 2] = 1;
      } else {
        next[at] = alive = 1;
        if (ch === "/") next[at + 1] = 1;
      }
    }
    if (!alive) return false;
    close(next);
    [current, next] = [next, current];
  }
  return current[steps.length] === 1;
}

function globLeafMatches(leaf, folded) {
  if (folded.length < leaf.minLength || !folded.startsWith(leaf.prefix) || !folded.endsWith(leaf.suffix)) return false;
  return leaf.globstar ? globAllMatch(leaf.tokens, folded) : globStarsMatch(leaf.tokens, folded);
}

// Braces are expanded as they always were here: up to four groups deep and sixteen alternatives a group; past that a
// brace is itself, and the glob is marked `unexpanded`, as a search expands them all. Null when the alternatives would
// add up to more than Guard compiles for one glob. A caller walking many files gives its own `cache`, which keeps a
// glob of any length.
function compileGlob(pattern, classes = false, cache = null) {
  const key = `${classes ? 1 : 0}${pattern}`;
  if (cache?.has(key)) return cache.get(key);
  if (globCache.has(key)) {
    cache?.set(key, globCache.get(key));
    return globCache.get(key);
  }
  const leaves = [];
  let length = 0;
  let unexpanded = false;
  const visit = (value, depth) => {
    let normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.startsWith("!")) normalized = normalized.slice(1);
    const braces = normalized.match(/\{([^{}]+)\}/);
    if (braces) {
      const alternatives = braces[1].split(",");
      if (depth < 4 && alternatives.length <= 16) {
        return alternatives.every((alternative) => visit(normalized.replace(braces[0], alternative), depth + 1));
      }
      unexpanded = true;
    }
    length += normalized.length;
    if (length > GLOB_MAX_LEAVES_LENGTH) return false;
    leaves.push(...compileGlobLeaf(normalized, classes));
    return true;
  };
  const compiled = visit(pattern, 0) ? leaves : null;
  if (compiled && unexpanded) compiled.unexpanded = true;
  if (cache) cache.set(key, compiled);
  else if (pattern.length <= GLOB_CACHE_MAX_LENGTH) {
    if (globCache.size >= 512) globCache.clear();
    globCache.set(key, compiled);
  }
  return compiled;
}

function compiledGlobMatches(compiled, relativePath) {
  const relative = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Each folded once, on first use, spelled out since VS Code 1.57's extension host runs this file on Node 14.
  let whole;
  let base;
  return compiled.some((leaf) => {
    if (leaf.whole) {
      if (whole === undefined) whole = foldGlobText(relative);
      return globLeafMatches(leaf, whole);
    }
    if (base === undefined) base = foldGlobText(path.posix.basename(relative));
    return globLeafMatches(leaf, base);
  });
}

// `classes` also reads `[...]` as a class, for a caller that's safer matching more; `unsure` is the answer for a glob
// whose brace alternatives are too many to compile or to expand. `cache`: see compileGlob.
function globMatchesPath(pattern, relativePath, { classes = false, unsure = false, cache = null } = {}) {
  if (typeof pattern !== "string" || !pattern) return false;
  const compiled = compileGlob(pattern, classes, cache);
  if (!compiled || (compiled.unexpanded && unsure)) return unsure;
  return compiledGlobMatches(compiled, relativePath);
}

function patternNamesSecret(value, cwd) {
  if (typeof value !== "string" || !value) return false;
  const normalized = value
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^!/, "");
  if (/[*?]/.test(path.posix.basename(normalized))) return false;
  return isSecretOperand(normalized, cwd);
}

function namedSecretForPattern(pattern) {
  const normalized = pattern
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^!/, "");
  if (!/[*?[]/.test(normalized)) return normalized;
  const known = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.test",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
    "secrets.json",
    "private.pem",
    "private.key",
  ];
  const match = known.find(
    (candidate) => isSecretFile(candidate) && globMatchesPath(normalized, candidate, { classes: true }),
  );
  return match || path.posix.basename(normalized) || "the matched secret file";
}

function searchFileFilters(tool, toolName, args) {
  let include = [];
  const exclude = [];
  // Claude Code splits Grep's glob on blank space, then each piece without a `{...}` on commas, and passes each to
  // ripgrep as a glob of its own (`*.md,.env` reads `.env`). A glob given more than once is checked once.
  if (tool === "claude" && toolName === "grep" && typeof args.glob === "string") {
    const braced = (piece) => {
      const open = piece.indexOf("{");
      return open >= 0 && piece.indexOf("}", open) > open;
    };
    include = [
      ...new Set(
        args.glob
          .split(/\s+/)
          .filter(Boolean)
          .flatMap((piece) => (braced(piece) ? [piece] : piece.split(","))),
      ),
    ];
  }
  if (tool === "gemini" && ["search_file_content", "grep_search"].includes(toolName)) {
    if (typeof args.include_pattern === "string") include = [args.include_pattern];
  }
  if (tool === "cline" && toolName === "search_files" && typeof args.file_pattern === "string") {
    include = [args.file_pattern];
  }
  if (tool === "gemini" && toolName === "read_many_files") {
    include = Array.isArray(args.include) ? args.include : typeof args.include === "string" ? [args.include] : [];
    exclude.push(...(Array.isArray(args.exclude) ? args.exclude : []));
    if (args.useDefaultExcludes !== false) {
      exclude.push(
        "**/bower_components/**",
        "**/.svn/**",
        "**/.hg/**",
        "**/.vscode/**",
        "**/.idea/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/__pycache__/**",
        "**/*.bin",
        "**/*.exe",
        "**/*.dll",
        "**/*.so",
        "**/*.dylib",
        "**/*.class",
        "**/*.jar",
        "**/*.war",
        "**/*.zip",
        "**/*.tar",
        "**/*.gz",
        "**/*.bz2",
        "**/*.rar",
        "**/*.7z",
        "**/*.pak",
        "**/*.rpa",
        "**/*.doc",
        "**/*.docx",
        "**/*.xls",
        "**/*.xlsx",
        "**/*.ppt",
        "**/*.pptx",
        "**/*.odt",
        "**/*.ods",
        "**/*.odp",
        "**/*.pyc",
        "**/*.pyo",
        "**/.DS_Store",
        "**/.env",
      );
    }
  }
  include = [...new Set(include.filter((pattern) => typeof pattern === "string" && pattern))];
  for (let index = exclude.length - 1; index >= 0; index -= 1) {
    if (typeof exclude[index] !== "string" || !exclude[index]) exclude.splice(index, 1);
  }
  for (let index = include.length - 1; index >= 0; index -= 1) {
    if (include[index].startsWith("!")) exclude.push(include.splice(index, 1)[0]);
  }
  return { include: withUnescapedGlobs(include), exclude };
}

// ripgrep and grep, outside Windows, read a backslash in a glob as an escape (`.e\nv` is `.env`), where Guard's globs
// read it as a separator. An include is read both ways, as it then matches more; an exclude is kept as written, so it
// leaves out less.
function withUnescapedGlobs(globs) {
  const all = [];
  for (const glob of globs) {
    all.push(glob);
    if (glob.includes("\\")) all.push(glob.replace(/\\(.)/g, "$1"));
  }
  return [...new Set(all)];
}

// An include glob is read in the way that matches more (a `[...]` class or the brackets themselves, and every file when
// it's too big to compile), an exclude glob in the way that leaves out less, so a file is never skipped by a misreading.
function filePassesSearchFilters(file, filters, root, absoluteFile) {
  const cache = searchFilterCache(filters);
  const matches = (pattern, include) => {
    const unprefixed = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    const options = { classes: include, unsure: include, cache };
    if (!path.isAbsolute(unprefixed)) return globMatchesPath(pattern, file, options);
    // ripgrep reads one leading slash (`/.env*`) as the folder searched, so an include is read that way too.
    if (include && /^\/(?!\/)/.test(unprefixed) && globMatchesPath(unprefixed.slice(1), file, options)) return true;
    return globMatchesPath(pattern, absoluteFile || path.resolve(root, file), options);
  };
  const included = !filters.include.length || filters.include.some((pattern) => matches(pattern, true));
  if (!included) return false;
  return !filters.exclude.some((pattern) => matches(pattern, false));
}

// One search's filters, compiled once for its whole walk: a glob too long for compileGlob's own cache would otherwise
// be compiled again for each file, and run the walk out of time.
const searchFilterCaches = new WeakMap();
function searchFilterCache(filters) {
  let cache = searchFilterCaches.get(filters);
  if (!cache) {
    cache = new Map();
    searchFilterCaches.set(filters, cache);
  }
  return cache;
}

// Compiles a search's filters before its walk's clock starts, false if `late()` says the hook's time is up first.
function compileSearchFilters(filters, late) {
  const cache = searchFilterCache(filters);
  for (const [patterns, include] of [
    [filters.include, true],
    [filters.exclude, false],
  ]) {
    for (const pattern of patterns) {
      if (late()) return false;
      compileGlob(pattern, include, cache);
      const unprefixed = pattern.startsWith("!") ? pattern.slice(1) : pattern;
      if (include && /^\/(?!\/)/.test(unprefixed)) compileGlob(unprefixed.slice(1), include, cache);
    }
  }
  return true;
}

// What `rg --files` would list, worked out without ripgrep: hidden paths only when the tool searches them, never
// `.git` or `node_modules`, a `.geminiignore` read with the gitignore-style rules Guard already uses for
// `.clotrignore`, and Git's own answer for `.gitignore`. ripgrep applies ignore rules only to what it finds inside the
// folder it's asked to search, never to that folder, but Git calls a file ignored when any folder above it is: so
// Git's answer counts only when the search's own folder isn't ignored. When it is, Git can't tell whether the file is
// also ignored on its own, and the file is taken to be listed.
function ripgrepRulesCanList(root, relativePath, { hidden, geminiIgnore, respectGitIgnore, deadline, listing }) {
  // A walk that found many secret files has Git asked about them all at once (see gitIgnoreAnswers).
  const gitIgnore = listing?.gitIgnore || ((wanted) => gitGrepCanList(root, wanted, deadline));
  const wanted = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = wanted.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules")) return { reachable: false };
  if (!hidden && parts.some((part) => part.startsWith("."))) return { reachable: false };
  if (geminiIgnore) {
    try {
      const file = path.join(root, ".geminiignore");
      if (fs.statSync(file).size <= MAX_BYTES && pathIgnored(parseClotrIgnore(fs.readFileSync(file, "utf8")), wanted)) {
        return { reachable: false };
      }
    } catch {
      // No .geminiignore, or one that can't be read: nothing it leaves out.
    }
  }
  if (respectGitIgnore) {
    const ignored = gitIgnore(wanted);
    if (ignored.limited) return ignored;
    if (!ignored.unavailable && !ignored.reachable) {
      // Asked from inside the folder, so a folder at the top of its repository is outside it, and not ignored.
      const folder = path.basename(path.resolve(root));
      const folderIgnored = folder ? gitIgnore(`../${folder}`) : { reachable: true };
      if (folderIgnored.limited) return folderIgnored;
      if (folderIgnored.reachable) return { reachable: false };
    }
  }
  return { reachable: true };
}

// `listing` carries what rg has listed so far in this search, so each folder is listed once, and charges what it
// lists to the search's budget: rg reads every folder below to list it, as the walk does.
function ripgrepCanList(
  root,
  relativePath,
  {
    hidden = false,
    geminiIgnore = false,
    respectGitIgnore = true,
    deadline = Date.now() + SEARCH_REACHABILITY_TIMEOUT_MS,
    listing,
  } = {},
) {
  // A path Node couldn't spell (U+FFFD in it) isn't spelled the way rg or Git spell it, so neither can say it's left out.
  if (relativePath.includes("\uFFFD")) return { reachable: true };
  const rules = { hidden, geminiIgnore, respectGitIgnore, deadline, listing };
  const listed = ripgrepListing(root, rules);
  // Most machines have no ripgrep on PATH (assistants that use it carry their own copy), so answer the same question
  // from ripgrep's own rules instead of letting every search through.
  // The same when rg lists more than the read hook keeps of its output (`tooBig`): a big repository is still searched.
  if (listed.missing || listed.tooBig) return ripgrepRulesCanList(root, relativePath, rules);
  if (listed.limited) return listed;
  return { reachable: listed.files.has(relativePath.replace(/\\/g, "/").replace(/^\.\//, "")) };
}

// What rg itself lists in `root` under these rules: `files`, each relative to it with `/` between its parts; `missing`
// when there's no rg on PATH; `tooBig` when the read hook's listing is past its buffer; `limited` when it couldn't
// list it all in time.
function ripgrepListing(root, { hidden, geminiIgnore, respectGitIgnore, deadline, listing }) {
  // The search check's own budget (250 ms unless a caller sets another) bounds every probe it starts.
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { limited: true };
  const args = ["--files", "--null", "--no-config"];
  if (hidden) args.push("--hidden");
  if (!respectGitIgnore) args.push("--no-ignore-vcs");
  if (geminiIgnore) args.push("--no-ignore-dot", "--no-ignore-parent");
  args.push("--glob", "!**/.git/**", "--glob", "!**/node_modules/**");
  if (geminiIgnore && fs.existsSync(path.join(root, ".geminiignore"))) {
    args.push("--ignore-file", ".geminiignore");
  }
  args.push("--", ".");
  const key = `${path.resolve(root)}\0${args.join("\0")}`;
  const listed = listing?.cache.get(key);
  if (listed) return { files: listed };
  // No rg on PATH is found out once a search, not once a file.
  if (listing?.cache.get(RIPGREP_MISSING)) return { missing: true };
  const tooBigKey = `${key}\0too big`;
  if (listing?.cache.get(tooBigKey)) return { tooBig: true };
  const result = spawnSync("rg", args, {
    cwd: root,
    encoding: "buffer",
    timeout,
    maxBuffer: listing?.maxBuffer || 512 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") {
    listing?.cache.set(RIPGREP_MISSING, true);
    return { missing: true };
  }
  // The read hook keeps half a megabyte of the listing; a repository listing more is answered from ripgrep's rules
  // (see ripgrepCanList). A shell check sets its own, larger buffer, and a listing past that is still `limited`.
  if (result.error?.code === "ENOBUFS" && !listing?.maxBuffer) {
    listing?.cache.set(tooBigKey, true);
    return { tooBig: true };
  }
  // rg exits 2 when it couldn't open a folder, and lists the rest. A shell check's own reader, run as this account,
  // can't open that folder either (`listing.partial`), so the rest is what it reads.
  const partial = result.status === 2 && Boolean(listing?.partial);
  if (result.error || (result.status !== 0 && result.status !== 1 && !partial)) return { limited: true };
  const files = new Set(
    (result.stdout || Buffer.alloc(0))
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")),
  );
  if (listing) {
    listing.cache.set(key, files);
    listing.charge(files.size);
  }
  return { files };
}

function gitGrepCanList(root, relativePath, deadline = Date.now() + SEARCH_REACHABILITY_TIMEOUT_MS, noIndex = false) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { limited: true };
  const args = ["check-ignore", "-q"];
  if (noIndex) args.push("--no-index");
  args.push("--", relativePath);
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") return { limited: true };
  if (result.error) return { unavailable: true };
  if (result.status === 0) return { reachable: false };
  // Outside a Git worktree, Gemini's grep fallback can read ignored-looking files.
  return { reachable: true };
}

// gitGrepCanList's answer for each of a walk's secret `files` (relative to `root`), with Git asked about them all in
// one process, the first time one is wanted. Any other path, the folder's own (`../name`) among them, is asked on its
// own, once; so is every file when Git can't answer the batch.
function gitIgnoreAnswers(root, files, deadline) {
  const wanted = new Set(files);
  const asked = new Map();
  let batch;
  return (relativePath) => {
    if (wanted.has(relativePath)) {
      if (batch === undefined) batch = gitIgnoredBatch(root, [...wanted], deadline);
      if (batch?.limited || batch?.unavailable) return batch;
      if (batch) return { reachable: !batch.ignored.has(relativePath) };
    }
    if (!asked.has(relativePath)) asked.set(relativePath, gitGrepCanList(root, relativePath, deadline));
    return asked.get(relativePath);
  };
}

function gitIgnoredBatch(root, files, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { limited: true };
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: root,
    input: files.map((file) => `${file}\0`).join(""),
    encoding: "utf8",
    timeout,
    maxBuffer: SHELL_RIPGREP_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") return { limited: true };
  if (result.error?.code === "ENOENT") return { unavailable: true };
  // 0: some are ignored, 1: none are. Anything else (outside a repository, say) is asked a file at a time instead.
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  return { ignored: new Set(result.stdout.split("\0").filter(Boolean)) };
}

// The folders below `root` that Git ignores whole (`target/`, or one holding nothing but ignored files), relative to
// it, for a walk to leave out; null when Git can't say, or when `root` is ignored itself, which rg reads all the same.
function gitIgnoredFolders(root, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return null;
  const result = spawnSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: SHELL_RIPGREP_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const folders = new Set();
  for (const entry of result.stdout.split("\0")) {
    if (!entry.endsWith("/")) continue;
    const folder = entry.slice(0, -1).replace(/^\.\//, "");
    if (folder === "." || folder === "" || folder.startsWith("../")) return null;
    folders.add(folder);
  }
  return folders;
}

// Whether rg reads an `.ignore` or `.rgignore` file in `folder` or a folder above it: one can take back a folder Git
// ignores (`!target/`), which Git wouldn't know.
function ripgrepIgnoreFileAbove(folder) {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    if (RIPGREP_IGNORE_FILES.some((name) => fs.existsSync(path.join(current, name)))) return true;
    if (path.dirname(current) === current) return false;
  }
}

function searchFileIsReachable(tool, toolName, args, root, relativePath, deadline, listing) {
  const usesRipgrep = (tool === "claude" && toolName === "grep") || (tool === "cline" && toolName === "search_files");
  if (usesRipgrep) {
    // The walk only asks about a file that passes the caller's globs, and a ripgrep --glob that matches a file
    // overrides every ignore and hidden-file rule, so a git-ignored .env under `--glob '*'` is searched all the same.
    if (searchFileFilters(tool, toolName, args).include.length) return { reachable: true };
    const hidden = tool === "claude";
    if (tool === "cline" && !hidden && relativePath.split("/").some((part) => part.startsWith("."))) {
      return { reachable: false };
    }
    return ripgrepCanList(root, relativePath, { hidden, deadline, listing });
  }
  if (tool === "gemini" && ["search_file_content", "grep_search"].includes(toolName)) {
    if (args.no_ignore === true) return { reachable: true };
    const ignored = gitGrepCanList(root, relativePath, deadline);
    if (ignored.limited) return ignored;
    if (ignored.unavailable) return { reachable: true };
    if (!ignored.reachable) return ignored;
    return { reachable: true };
  }
  if (tool === "gemini" && toolName === "read_many_files") {
    const filtering = args.file_filtering_options || {};
    if (filtering.respect_git_ignore !== false) {
      const ignored = gitGrepCanList(root, relativePath, deadline, true);
      if (ignored.limited) return ignored;
      // An ignored file is one Gemini leaves out, so the walk goes on to the next; without Git there's no answer.
      if (!ignored.unavailable && !ignored.reachable) return { reachable: false };
    }
    if (filtering.respect_gemini_ignore !== false) {
      return ripgrepCanList(root, relativePath, {
        hidden: true,
        geminiIgnore: true,
        respectGitIgnore: false,
        deadline,
        listing,
      });
    }
    return { reachable: true };
  }
  // A shell `rg` skips hidden and ignored files unless its flags or a --glob that matches say otherwise.
  if (tool === "shell" && toolName === "rg") {
    if (args.globbed) return { reachable: true };
    if (!args.hidden && relativePath.split("/").some((part) => part.startsWith("."))) return { reachable: false };
    if (args.noIgnore) return { reachable: true };
    return ripgrepCanList(root, relativePath, { hidden: args.hidden, deadline, listing });
  }
  return { reachable: true };
}

function findSecretInSearchTree(root, filters, tool, toolName, args, options = {}) {
  if (isRemotePath(root)) return { limited: true };
  if (
    path
      .resolve(root)
      .split(path.sep)
      .some((part) => [".git", "node_modules"].includes(part.toLowerCase()))
  ) {
    return {};
  }
  // A shared budget (see shellWalkBudget) bounds every walk one shell command starts, together.
  const budget = options.budget;
  // The read hook's own deadline (see hookDeadline) bounds what comes before the walk, and the walk's checks of whether
  // the search reads a secret file it found. When those run out, the search is one whose check didn't finish: a secret
  // file passes its filters. A shell command's walks answer to its budget instead.
  const hookLate = () => options.deadline !== undefined && Date.now() >= options.deadline;
  const filtersLate = budget ? () => walkSpent(budget) || Date.now() >= budget.checkDeadline : hookLate;
  if (!compileSearchFilters(filters, filtersLate)) return budget ? { limited: true } : { unfinished: true };
  // Under it a folder is walked once, its secret files kept for the next reader of it (findstr's file names, each
  // looked for in every folder below), and judged against each one's own filters.
  // A shell rg leaves out hidden folders below its own, and searchFileIsReachable takes a file under one as out of its
  // reach anyway, so the walk skips them too and keeps its budget for the rest.
  const skipHidden = Boolean(budget) && tool === "shell" && toolName === "rg" && !args.globbed && !args.hidden;
  // It leaves out the folders its ignore rules leave out below its own too (a Rust `target`, say), and
  // searchFileIsReachable judges a file under one by the same rules, so the walk skips them as well once rg's own
  // listing, or without rg Git, has said which they are.
  const skipIgnored = Boolean(budget) && tool === "shell" && toolName === "rg" && !args.globbed && !args.noIgnore;
  const treeKey = budget && `${path.resolve(root)}\u0000${skipHidden ? "rg" : ""}${skipIgnored ? "-ignored" : ""}`;
  let entries = 0;
  // A shell check's rg listing isn't charged to the walk on top of the walk itself: the deadline bounds its time and
  // maxBuffer its size, big enough for a real project, since a listing cut short stops the command.
  const listing = budget
    ? { cache: budget.listings, charge() {}, maxBuffer: SHELL_RIPGREP_MAX_BUFFER, partial: !budget.elevated }
    : {
        cache: new Map(),
        charge(count) {
          entries += count;
        },
      };
  const deadline = budget ? budget.walkDeadline : Date.now() + (options.searchWalkMaxMs || SEARCH_WALK_MAX_MS);
  // A shell rg's secret files are judged once the walk is done, so Git is asked about them all at once (see
  // gitIgnoreAnswers): asked one at a time, a folder of ignored ones ran the walk out of time.
  const deferred = Boolean(budget) && tool === "shell" && toolName === "rg";
  // Read before each file's filters and reachability are judged too: a slow filter costs a second a file.
  const late = () => Date.now() >= deadline || (Boolean(budget) && Date.now() >= budget.checkDeadline);
  const firstReachable = (files) => {
    if (deferred && files.length) {
      listing.gitIgnore = gitIgnoreAnswers(
        root,
        files.map((file) => file.relativePath),
        deadline,
      );
    }
    for (const { relativePath } of files) {
      if (late()) return { limited: true };
      const reachable = searchFileIsReachable(tool, toolName, args, root, relativePath, deadline, listing);
      if (reachable.limited) return { limited: true };
      if (reachable.reachable) return { file: relativePath };
    }
    return {};
  };
  const known = budget?.trees.get(treeKey);
  if (known) {
    const matching = [];
    for (const file of known) {
      if (late()) return { limited: true };
      if (filePassesSearchFilters(file.relativePath, filters, root, file.absolutePath)) matching.push(file);
    }
    return firstReachable(matching);
  }
  const secretFiles = [];
  const matching = [];
  // Each walk costs one entry at least, the folder it starts from, so a command can't start more than the budget.
  if (budget) budget.walkEntries -= 1;
  const maxEntries = budget ? Infinity : options.searchWalkMaxEntries || SEARCH_WALK_MAX_ENTRIES;
  const spent = () =>
    entries >= maxEntries ||
    Date.now() >= deadline ||
    (budget && (budget.walkEntries <= 0 || Date.now() >= budget.checkDeadline));
  // Each folder with its path from the root, so a file's is one join, not a path.relative call. The secret-file rules
  // that name a folder (see SECRET_PATHS) name one at most, so the root's own is all a file needs from above it.
  // A folder's third part says an `.ignore` or `.rgignore` file in it or above it (in the walk) could take back a
  // folder Git ignores, so nothing below it is skipped for Git.
  let pending = [[root, "", false]];
  // Which folders the walk leaves out for rg: undefined until asked (see SHELL_RG_IGNORED_ASK_AT), null when none are.
  let skipFolder = skipIgnored ? undefined : null;
  const askSkipFolder = () => {
    // With rg on PATH, its own listing says: a folder holding none of the files it lists has none rg reads, and
    // searchFileIsReachable asks the same listing (the same rules, so the same cache entry) about each file.
    const listed = ripgrepListing(root, {
      hidden: args.hidden,
      geminiIgnore: false,
      respectGitIgnore: true,
      deadline,
      listing,
    });
    if (listed.files) {
      const reached = new Set();
      for (const file of listed.files) {
        for (let end = file.lastIndexOf("/"); end > 0; end = file.lastIndexOf("/", end - 1)) {
          const folder = file.slice(0, end);
          if (reached.has(folder)) break;
          reached.add(folder);
        }
      }
      return (relativePath) => !reached.has(relativePath);
    }
    if (!listed.missing) return null;
    // Without it, ripgrepRulesCanList takes Git's word for a file under a folder Git ignores, so the walk does too,
    // unless an `.ignore` or `.rgignore` file could take the folder back.
    const ignored = ripgrepIgnoreFileAbove(root) ? null : gitIgnoredFolders(root, deadline);
    if (!ignored) return null;
    return (relativePath, takesBack) => {
      if (takesBack) return false;
      for (let end = relativePath.length; end > 0; end = relativePath.lastIndexOf("/", end - 1)) {
        if (ignored.has(relativePath.slice(0, end))) return true;
      }
      return false;
    };
  };
  // The root's name as given and as it is on disk, so a junction to `.kube`, or its short name `KUBE~1`, counts.
  const rootNames = [path.basename(path.resolve(root))];
  try {
    const real = path.basename(fs.realpathSync.native(root));
    if (!rootNames.includes(real)) rootNames.push(real);
  } catch {
    // A root that can't be resolved is walked under the name it was given; the walk reports what it can't read.
  }
  const secretName = (relativeDirectory, relativePath) =>
    relativeDirectory
      ? isSecretFile(relativePath)
      : rootNames.some((rootName) => isSecretFile(rootName ? `${rootName}/${relativePath}` : relativePath));
  while (pending.length) {
    if (spent()) return { limited: true };
    const [directory, relativeDirectory, parentTakesBack] = pending.pop();
    // A shell check reads each folder in one call: a real project has thousands of small folders, and opening each to
    // read it a few entries at a time took the walk more than twice as long. One call can't be stopped partway, but
    // a folder of 200,000 files is listed in about a tenth of a second.
    let folderEntries = null;
    let handle;
    try {
      if (budget) folderEntries = fs.readdirSync(directory, { withFileTypes: true });
      else handle = fs.opendirSync(directory);
    } catch (error) {
      // A search of one file has no tree to walk; its own name was checked before the walk, and a folder removed since
      // it was listed has nothing left to read. Under a shell check, a folder whose name Node couldn't spell (it reads
      // back with U+FFFD in it) can't be passed over: the reader can open it.
      const misspelled = Boolean(budget) && relativeDirectory.includes("\uFFFD");
      if ((error.code === "ENOENT" || error.code === "ENOTDIR") && !misspelled) continue;
      // A folder this account isn't allowed to open, a reader it runs can't open either, so the walk goes on past it;
      // not when the command runs as another user.
      if (budget && !budget.elevated && (error.code === "EACCES" || error.code === "EPERM")) continue;
      return { limited: true };
    }
    const takesBack =
      skipIgnored &&
      (parentTakesBack || folderEntries.some((folderEntry) => RIPGREP_IGNORE_FILES.includes(folderEntry.name)));
    try {
      let entry;
      let index = 0;
      while ((entry = folderEntries ? (folderEntries[index++] ?? null) : handle.readSync()) !== null) {
        entries += 1;
        if (budget) budget.walkEntries -= 1;
        // Asked once, and what's waiting to be read that rg leaves out is dropped.
        if (
          skipFolder === undefined &&
          (entries >= SHELL_RG_IGNORED_ASK_AT || budget.walkEntries < SHELL_RG_IGNORED_ASK_AT)
        ) {
          skipFolder = askSkipFolder();
          if (skipFolder) {
            pending = pending.filter(
              ([, waiting, waitingTakesBack]) => waiting.includes("\uFFFD") || !skipFolder(waiting, waitingTakesBack),
            );
          }
        }
        if (spent()) return { limited: true };
        const name = entry.name;
        if (name === "." || name === "..") continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (entry.isDirectory()) {
          if (
            name !== ".git" &&
            name !== "node_modules" &&
            !(skipHidden && name.startsWith(".")) &&
            // A name Node couldn't spell (U+FFFD in it) isn't spelled the way rg or Git spell it, so neither's answer
            // leaves it out.
            !(skipFolder && !relativePath.includes("\uFFFD") && skipFolder(relativePath, takesBack))
          ) {
            pending.push([path.join(directory, name), relativePath, takesBack]);
          }
          continue;
        }
        // A file right in the root is named with the root's own folder too, so `.kube/config` is found when `.kube` is
        // the folder read; a deeper one has its folder in its own path.
        if (!entry.isFile() || !secretName(relativeDirectory, relativePath)) continue;
        const file = { relativePath, absolutePath: path.join(directory, name) };
        if (budget) secretFiles.push(file);
        if (!filePassesSearchFilters(relativePath, filters, root, file.absolutePath)) continue;
        if (deferred) {
          matching.push(file);
          continue;
        }
        // A probe started near the walk's end still gets its own time, within the hook's.
        const probeDeadline = budget
          ? deadline
          : Math.min(options.deadline ?? Infinity, Math.max(deadline, Date.now() + SEARCH_REACHABILITY_TIMEOUT_MS));
        const reachable = searchFileIsReachable(tool, toolName, args, root, relativePath, probeDeadline, listing);
        if (reachable.limited) return budget ? { limited: true } : { unfinished: true };
        if (reachable.reachable) return { file: relativePath };
      }
    } catch {
      return { limited: true };
    } finally {
      handle?.closeSync();
    }
  }
  if (budget) budget.trees.set(treeKey, secretFiles);
  return firstReachable(matching);
}

function secretSearchFile(tool, name, args, cwd, options = {}) {
  const toolName = String(name || "")
    .toLowerCase()
    .split("__")
    .pop();
  // The first folder given as text (see inspectReadInvocation).
  const pathValue = [args.path, args.dir_path, args.directory, args.root, args.file_path, args.absolute_path].find(
    (value) => typeof value === "string" && value,
  );
  const filters = searchFileFilters(tool, toolName, args);
  const location = typeof pathValue === "string" && pathValue ? pathValue : cwd;
  const root = path.isAbsolute(location) ? location : path.resolve(cwd, location);
  if (
    typeof pathValue === "string" &&
    pathValue &&
    !isDirectoryTarget(pathValue, cwd) &&
    patternNamesSecret(pathValue, cwd) &&
    filePassesSearchFilters(
      path.relative(cwd, path.resolve(cwd, pathValue)).replace(/\\/g, "/"),
      filters,
      root,
      path.resolve(cwd, pathValue),
    )
  ) {
    return { file: pathValue };
  }
  // The hook's deadline holds across the filters, each of which may be looked up: a search given more than can be
  // checked in time is stopped as one that didn't finish.
  const deadline = options.deadline;
  const late = () => deadline !== undefined && Date.now() >= deadline;
  for (const pattern of filters.include) {
    if (late()) return { unfinished: true };
    if (patternNamesSecret(pattern, cwd)) {
      const namedFile = namedSecretForPattern(pattern);
      const absoluteFile = path.isAbsolute(namedFile) ? namedFile : path.resolve(root, namedFile);
      const relativeFile = path.relative(root, absoluteFile).replace(/\\/g, "/") || path.basename(absoluteFile);
      if (filePassesSearchFilters(relativeFile, filters, root, absoluteFile)) return { file: namedFile };
    }
  }
  // A folder on another computer isn't walked (see isRemotePath), but a device path to a drive (see localDevicePaths)
  // and a drive's share on this computer (see driveSharePaths) are walked as the folder on the drive, and a folder
  // Windows tidies as the one it opens (see windowsTidiedPaths).
  let roots = [root];
  // A share path whose dots a search may pass on to another computer (see driveSharePaths) is walked on this
  // computer's drive, and still noted as a search that may read past what was checked.
  let limited = false;
  if (remoteLocation(location, cwd)) {
    const shares = (driveSharePaths(location, cwd) || []).filter((item) => item.loopback);
    roots = [...(localDevicePaths(location) || []), ...shares.map((item) => item.drive)];
    limited = shares.some((item) => item.dotted) || dotsMayLeaveRoot(location);
    // A folder through a device name Guard can't place could hold any secret file (see opensUnknownDevice), and so
    // could a drive-relative one named from another computer's folder (see driveRelativeFromRemote); a credentials
    // folder holds one by its name (see secretFolderByName), searched or named by the search's filter, and a filter
    // can single out a secret file by its name (see filterNamesSecret).
    if (!roots.length) {
      if (opensUnknownDevice(location) || driveRelativeFromRemote(location, cwd) || secretFolderByName(location, cwd)) {
        return { file: location };
      }
      for (const pattern of filters.include) {
        if (late()) return { unfinished: true };
        if (globNamesSecretFolder(pattern, { whole: true }) || filterNamesSecret(pattern)) return { file: location };
      }
      return { limited: true };
    }
  }
  roots = roots.flatMap((item) => [item, ...(windowsTidiedPaths(item, cwd) || [])]);
  for (const walked of roots) {
    const found = findSecretInSearchTree(walked, filters, tool, toolName, args, options);
    if (found.file || found.unfinished) return found;
    if (late()) return { unfinished: true };
    limited = limited || Boolean(found.limited);
  }
  return limited ? { limited: true } : null;
}

// What several reads checked for one tool call come to: the first outcome, with any later one's notes added.
function mergedReadOutcomes(outcomes) {
  if (!outcomes.length) return { action: "allow" };
  const merged = { ...outcomes[0] };
  for (const outcome of outcomes.slice(1)) {
    for (const flag of ["partial", "internalError", "belowMinimumOnly", "skipped", "searchLimited"]) {
      if (outcome[flag]) merged[flag] = true;
    }
    if (outcome.reported) merged.reported = [...(merged.reported || []), ...outcome.reported];
  }
  return merged;
}

function inspectRead(tool, event, options = {}) {
  if (!READ_TOOLS.has(tool)) return { action: "allow", unsupported: true };
  return inspectReadInvocation(tool, event, readInvocation(tool, event), options);
}

function inspectReadInvocation(tool, event, invocation, options) {
  const cwd = options.cwd || process.cwd();
  if (!invocation.args) {
    return tool === "cline" && !invocation.name
      ? { action: "allow", unsupported: true }
      : { action: "allow", internalError: true };
  }
  const toolName = String(invocation.name || "")
    .toLowerCase()
    .split("__")
    .pop();
  // The filesystem MCP server's read_multiple_files reads each of its `paths`: each is checked as a read of its own.
  if (toolName === "read_multiple_files") {
    const paths = Array.isArray(invocation.args.paths) ? invocation.args.paths : [];
    const outcomes = [];
    for (const item of paths) {
      if (typeof item !== "string" || !item) continue;
      const outcome = inspectReadInvocation(tool, event, { name: "read_file", args: { path: item } }, options);
      if (outcome.action !== "allow") return outcome;
      outcomes.push(outcome);
    }
    return mergedReadOutcomes(outcomes);
  }
  const readNames = new Set(["read", "read_file", "read_files", "read_text_file", "read_media_file", "read_resource"]);
  const searchNames = new Set([
    "grep",
    "search_files",
    "search_file_content",
    "grep_search",
    "read_many_files",
    "read_files",
  ]);
  if (!readNames.has(toolName) && !searchNames.has(toolName)) return { action: "allow", unsupported: true };

  // A tool may take its path under any of these keys, and which one it reads when given more than one differs between
  // tools and versions (an MCP server reads `path`, Claude's Read `file_path`), so each path given is checked; a path
  // under the home folder (`~/...`) as the file a tool that expands `~` opens (see pathReadings), and as written only
  // when the working folder has a `~` of its own. Each is checked as a read or search of that path alone.
  if (!invocation.single) {
    const keys = searchNames.has(toolName)
      ? ["path", "dir_path", "directory", "root", "file_path", "absolute_path"]
      : ["file_path", "absolute_path", "path"];
    const given = keys.map((key) => invocation.args[key]).filter((value) => typeof value === "string" && value);
    const readings = [];
    for (const value of given) {
      const expanded = pathReadings(value, { homeOnly: true });
      // A working folder on another computer is never looked up (see isRemotePath): its `~` is kept, judged by name.
      let literal = !expanded.length || remoteLocation(path.join(cwd, "~"), cwd);
      if (!literal) {
        try {
          literal = fs.existsSync(path.resolve(cwd, "~"));
        } catch {
          literal = true;
        }
      }
      for (const reading of literal ? [value, ...expanded] : expanded) {
        if (!readings.includes(reading)) readings.push(reading);
      }
    }
    if (readings.length > 1 || (readings.length === 1 && readings[0] !== given[0])) {
      const outcomes = [];
      for (const reading of readings) {
        const args = { ...invocation.args };
        for (const key of keys) delete args[key];
        args[keys[0]] = reading;
        const outcome = inspectReadInvocation(tool, event, { ...invocation, args, single: true }, options);
        if (outcome.action !== "allow") return outcome;
        outcomes.push(outcome);
      }
      return mergedReadOutcomes(outcomes);
    }
  }

  // The first path given as text: a number or object under an earlier key opens nothing, and mustn't hide the path.
  const requestedPath = [invocation.args.file_path, invocation.args.absolute_path, invocation.args.path].find(
    (value) => typeof value === "string" && value,
  );
  if (searchNames.has(toolName)) {
    const contentSearch =
      !(tool === "claude" && toolName === "grep" && invocation.args.output_mode !== "content") &&
      !(
        tool === "gemini" &&
        ["search_file_content", "grep_search"].includes(toolName) &&
        invocation.args.names_only === true
      );
    if (!contentSearch) return { action: "allow" };
    if (
      tool === "gemini" &&
      toolName === "read_many_files" &&
      !(Array.isArray(invocation.args.include)
        ? invocation.args.include.some((pattern) => typeof pattern === "string" && pattern)
        : typeof invocation.args.include === "string" && invocation.args.include)
    ) {
      return { action: "allow" };
    }
    const secret = secretSearchFile(tool, invocation.name, invocation.args, cwd, {
      ...options,
      deadline: hookDeadline(options),
    });
    if (secret?.file) return { action: "block", secretFile: true, boundary: "search", location: secret.file };
    if (secret?.unfinished) {
      return { action: "block", unfinished: true, boundary: "search", location: requestedPath || cwd };
    }
    if (secret?.limited) return { action: "allow", searchLimited: true };
    return { action: "allow" };
  }
  if (typeof requestedPath !== "string" || !requestedPath) {
    return { action: "allow" };
  }
  // The path checks share the hook's deadline: one still running at it holds the read as one that didn't finish.
  const deadline = hookDeadline(options);
  const budget =
    deadline === undefined
      ? undefined
      : { ...shellWalkBudget(options), lookupDeadline: deadline, drivePathDeadline: deadline, checkDeadline: deadline };
  const secret = { action: "block", secretFile: true, location: requestedPath };
  // A path too long for the system to open, as written and resolved, opens nothing, so it's judged by its name alone.
  const tooLong =
    requestedPath.length > OPENABLE_PATH_LENGTH && path.resolve(cwd, requestedPath).length > OPENABLE_PATH_LENGTH;
  // A file on another computer is judged by its name, and Guard doesn't open it (see isRemotePath); a drive's share
  // on this computer is read from its drive (see driveSharePaths).
  let remote = tooLong || remoteLocation(requestedPath, cwd);
  const filePath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath);
  // The paths that can open the file, each read (see below): a path Windows tidies may open only as what it opens.
  let opened;
  try {
    if (tooLong ? secretByName(requestedPath, cwd, budget) : isSecretOperand(requestedPath, cwd, undefined, budget)) {
      return secret;
    }
    // A device path to a drive (see localDevicePaths) is read from the drive as well.
    // Not where its dots could take it to another computer (see dotsMayLeaveRoot): its name was judged above.
    const devices = remote && !tooLong && !dotsMayLeaveRoot(requestedPath) ? localDevicePaths(requestedPath) || [] : [];
    const shares = remote && !tooLong && !devices.length ? driveSharePaths(requestedPath, cwd, { budget }) || [] : [];
    // Those drive paths are named without a stream, as a secret file's name is judged, but the read opens the stream
    // its last part names (`notes.txt:hidden`), as written or as Windows tidies it (`notes.txt:hidden.`).
    const stream = streamOf(requestedPath.replace(/['"]$/, ""));
    const streams = [...new Set([stream, trimEndOf(stream, ". ")])].filter((item) => item === "" || item.length > 1);
    opened = [...devices, ...shares.filter((item) => item.loopback && !item.dotted).map((item) => item.drive)].flatMap(
      (drive) => (stream ? streams.map((item) => `${drive}${item}`) : [drive]),
    );
    if (opened.length) remote = false;
    else {
      if (remote && tool !== "cursor") return { action: "allow", internalError: true };
      if (!remote && isSecretOperand(filePath, cwd, undefined, budget)) return secret;
      opened = remote ? [] : [filePath, ...(windowsTidiedPaths(filePath, cwd) || [])];
    }
    if (budget) checkShellDeadline(budget);
  } catch (error) {
    if (error instanceof ShellCheckTooLong) return { action: "block", unfinished: true, location: requestedPath };
    throw error;
  }
  // What the read gets: Cursor's hook hands over the text itself. Elsewhere, each path that can open the file is read,
  // as programs differ in which one they open (`\\.\...\keys.txt.` opens `keys.txt`, Node's `C:\...\keys.txt.` opens
  // the name as written): when more than one opens a file, each is checked, so a file planted under the other name
  // can't stand in for the one read. Two paths to the same file are read once.
  const reads = [];
  try {
    if (tool === "cursor") {
      if (typeof event.content !== "string" || event.content.includes("\0")) return { action: "allow", skipped: true };
      const content = Buffer.from(event.content, "utf8");
      reads.push({
        filePath: opened.length ? opened[0] : filePath,
        partial: content.length > MAX_READ_BYTES,
        bytes: content.subarray(0, Math.min(content.length, MAX_READ_BYTES)),
      });
    } else {
      const seen = [];
      let notFile = false;
      let failure;
      for (const candidate of opened) {
        let descriptor;
        try {
          descriptor = fs.openSync(candidate, "r");
        } catch (error) {
          failure = error;
          continue;
        }
        try {
          const stats = fs.fstatSync(descriptor, { bigint: true });
          if (!stats.isFile()) {
            notFile = true;
            continue;
          }
          // A file's streams share its number, so the stream read is part of what makes two reads the same.
          const same = (item) =>
            item.dev === stats.dev && item.ino === stats.ino && item.stream === streamOf(candidate);
          if (stats.ino && seen.some(same)) continue;
          seen.push({ dev: stats.dev, ino: stats.ino, stream: streamOf(candidate) });
          reads.push({ filePath: candidate, ...readUpToCap(descriptor) });
        } finally {
          fs.closeSync(descriptor);
        }
      }
      if (!reads.length) {
        if (notFile) return { action: "allow", skipped: true };
        throw failure || new Error("nothing to read");
      }
    }
  } catch {
    return { action: "allow", internalError: true };
  }
  const texts = reads
    .map((item) => ({ ...item, text: decodeText(item.bytes, item.partial) }))
    .filter((item) => item.text !== undefined);
  if (!texts.length) return { action: "allow", skipped: true };
  try {
    for (const item of texts) {
      if (remote ? isSecretFile(requestedPath, item.text) : isSecretPath(item.filePath, item.text, cwd, { budget })) {
        return secret;
      }
    }
  } catch (error) {
    if (error instanceof ShellCheckTooLong) return { action: "block", unfinished: true, location: requestedPath };
    throw error;
  }
  const outcomes = texts.map((item) => {
    const ignore = clotrIgnoreFor(remote ? null : path.dirname(item.filePath), options.cwd || process.cwd());
    const outcome = inspectText(tool, item.text, {
      ...options,
      cwd: ignore.root || options.cwd || process.cwd(),
      key: "read",
      repeatValue: item.filePath,
      // The assistant, not the person, would make a second read, so a read never passes by repeating it.
      repeat: false,
      includePersonalDetails: options.includePersonalDetails === true,
      deadline,
    });
    return { ...outcome, location: requestedPath, ...(item.partial ? { partial: true } : {}) };
  });
  const stopped = outcomes.find((outcome) => outcome.action !== "allow");
  if (stopped) return stopped;
  // Every read goes through, with what any of them has to say: a part past the cap, a check that hit an error, or
  // what was found below the stop level.
  const merged = { ...outcomes[0] };
  for (const outcome of outcomes.slice(1)) {
    if (outcome.partial) merged.partial = true;
    if (outcome.internalError) merged.internalError = true;
    if (outcome.belowMinimumOnly) merged.belowMinimumOnly = true;
    if (outcome.reported) merged.reported = [...(merged.reported || []), ...outcome.reported];
  }
  return merged;
}

// The stream named on the last part a path opens, `.` and `..` resolved: `:hidden` in `notes.txt:hidden`, also in
// `notes.txt:hidden\.` (or `::$DATA`), in a relative `notes.txt:hidden`, and where `..` climbs to the share's or the
// drive's top (`\\localhost\C$\x\..\..\notes.txt:hidden`); "" for none. A drive at the start (`C:notes.txt`) is no
// stream.
function streamOf(value) {
  const parts = [];
  value.split(/[\\/]/).forEach((written, index) => {
    const part = index === 0 ? written.replace(/^[A-Za-z]:/, "") : written;
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  });
  const last = parts.length ? parts[parts.length - 1] : "";
  return last.slice(withoutStream(last).length);
}

// Up to MAX_READ_BYTES of an open file, and whether there was more. Read up to the cap or the end, never by the
// reported size: a process's environment file under /proc is a regular file that reports no size at all, and would
// otherwise be checked one byte long.
function readUpToCap(descriptor) {
  const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (count === 0) break;
    bytesRead += count;
  }
  return {
    partial: bytesRead > MAX_READ_BYTES,
    bytes: buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES)),
  };
}

// `byName: true` judges the path by its name alone, without the disk. Under a `budget` (see shellWalkBudget), its
// deadline is looked at before each lookup on disk.
function isSecretPath(filePath, content = "", cwd = process.cwd(), { byName = false, budget } = {}) {
  if (isSecretFile(filePath, content)) return true;
  // A file named with a trailing separator (`.kube\config\`) is opened as the file by some programs, so it's judged as
  // the file too, and so is one with a last part Windows drops after it (`.kube\config\ `, `.kube\config\.`), though
  // not `..`.
  if (typeof filePath === "string") {
    // From the end, each character looked at once.
    const separator = (at) => filePath[at] === "/" || filePath[at] === "\\";
    let end = filePath.length;
    for (;;) {
      let at = end;
      while (at > 0 && separator(at - 1)) at -= 1;
      let start = at;
      while (start > 0 && (filePath[start - 1] === "." || filePath[start - 1] === " ")) start -= 1;
      end = at;
      if (start === at || start === 0 || !separator(start - 1) || /^\.\. *$/.test(filePath.slice(start, at))) break;
      end = start;
    }
    const trimmed = filePath.slice(0, end);
    if (trimmed && trimmed !== filePath && !trimmed.endsWith(":")) {
      if (isSecretPath(trimmed, content, cwd, { byName, budget })) return true;
    }
  }
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (isSecretFile(absolutePath, content)) return true;
  // A device path to a drive, `\\?\C:\proj\ENV~1`, is judged as the drive paths it could open.
  const drivePaths = localDevicePaths(filePath);
  if (drivePaths !== null) {
    return drivePaths.some((drivePath) => isSecretPath(drivePath, content, cwd, { byName, budget }));
  }
  // A drive's share is judged as the drive path it opens: looked up on this computer's drive only for this computer's
  // share, and by name for another's (see driveSharePaths). A path Windows tidies is judged as what it opens as well.
  const shares = driveSharePaths(filePath, cwd, { lookups: !byName, budget }) || [];
  const judged = (item) => isSecretPath(item.drive, content, cwd, { byName: byName || !item.loopback, budget });
  if (shares.some(judged)) return true;
  const tidied = windowsTidiedPaths(filePath, cwd) || [];
  if (tidied.some((drive) => judged({ drive, loopback: true }))) return true;
  if (byName) return false;
  if (remoteLocation(filePath, cwd)) {
    // Never looked up, so its `.` and `..` are resolved by name, as the system resolves them.
    return (
      isSecretFile(path.normalize(absolutePath), content) ||
      hasShortNamePart(filePath) ||
      opensUnknownDevice(filePath) ||
      driveRelativeFromRemote(filePath, cwd)
    );
  }
  if (budget) checkShellDeadline(budget);
  // A path with nothing at it has no real path either, and asking for one costs many times what a missing entry does.
  try {
    if (fs.lstatSync(absolutePath, { throwIfNoEntry: false }) === undefined) return false;
  } catch {
    // Anything else wrong with the path is left to the real-path lookups below.
  }
  // Each lookup is tried even when the other throws: Node's own throws for some paths the system's resolves.
  if (budget) checkShellDeadline(budget);
  try {
    if (isSecretFile(fs.realpathSync(absolutePath), content)) return true;
  } catch {
    // Left to the system's lookup below.
  }
  // Only the system's own lookup expands a Windows short name, so `ENV~1` is seen as the `.env` it opens.
  if (budget) checkShellDeadline(budget);
  try {
    return isSecretFile(fs.realpathSync.native(absolutePath), content);
  } catch {
    return false;
  }
}

// The names below that count as secret files, worked out on first use.
let secretGlobCandidates = null;

// A shell check's `budget` (see shellWalkBudget) is checked between names: one glob of a megabyte is one operand.
function globCouldMatchSecret(filePath, budget) {
  const normalized = filePath.replace(/\\/g, "/");
  if (!/[*?[]/.test(normalized)) return false;
  const basenamePattern = normalized.split("/").pop();
  // Compiled once per glob, not once per name it's tried against: a command can hold thousands of globs. A `[...]` is
  // read both as a class and as brackets, so the glob is stopped if either reading could name a secret file.
  const compile = (pattern) => {
    const leaves = compileGlobLeaf(pattern, true);
    return { test: (folded) => leaves.some((leaf) => globLeafMatches(leaf, folded)) };
  };
  const whole = compile(normalized);
  if (budget) checkShellDeadline(budget);
  const lastPart = basenamePattern === normalized ? whole : compile(basenamePattern);
  if (!secretGlobCandidates) secretGlobCandidates = secretNameCandidates();
  return secretGlobCandidates.some(({ candidate, name }) => {
    if (budget) checkShellDeadline(budget);
    return whole.test(candidate) || whole.test(name) || lastPart.test(name);
  });
}

// The secret names a glob is tried against, each with its last part, case-folded once.
function secretNameCandidates() {
  const candidates = [
    ".env",
    ".env.local",
    ".env.production",
    ".envrc",
    ".npmrc",
    ".netrc",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_xmss",
    "id_rsa_sk",
    "id_ed25519_sk",
    "id_ecdsa_sk",
    "credentials",
    ".aws/credentials",
    "credentials.json",
    "secrets.json",
    "private.pem",
    "private.key",
    "private.p12",
    "private.pfx",
    "private.ppk",
    "private.ovpn",
    "private.tfvars",
    ".pypirc",
    ".yarnrc",
    ".yarnrc.yml",
    "_netrc",
    ".pgpass",
    ".my.cnf",
    ".git-credentials",
    ".dockercfg",
    ".htpasswd",
    ".s3cfg",
    ".boto",
    ".vault-token",
    ".terraformrc",
    "terraform.rc",
    ".databrickscfg",
    "winscp.ini",
    "credentials.toml",
    "credentials.tfrc.json",
    "rclone.conf",
    ".credentials.json",
    "secrets.yaml",
    "secrets.yml",
    "secrets.toml",
    "secrets.ts",
    ".secrets",
    "wp-config.php",
    ".bash_history",
    ".zsh_history",
    "consolehost_history.txt",
    ".kube/config",
    ".docker/config.json",
    "gh/hosts.yml",
    "github cli/hosts.yml",
    ".codex/auth.json",
    ".gemini/oauth_creds.json",
    "gcloud/credentials.db",
    "gcloud/access_tokens.db",
    "gcloud/application_default_credentials.json",
    ".m2/settings.xml",
    ".gradle/gradle.properties",
    ".azure/msal_token_cache.json",
    "private.keystore",
    "private.jks",
    "private.tfstate",
    "private.tfstate.backup",
  ];
  return candidates
    .filter((candidate) => isSecretFile(candidate))
    .map((candidate) => ({ candidate: foldGlobText(candidate), name: foldGlobText(path.posix.basename(candidate)) }));
}

// A process's environment under /proc holds every variable that process was started with, keys included. It's
// judged loosely, as written and with `//`, `.` and `..` folded: any path from the root whose first folder could be
// `proc`, or `dev` (`/dev/fd/..` is a process's folder), and whose last part could be `environ`, whatever lies
// between (`self`, `$$`, `1/task/1`), and wherever it's reached from (`/c/../proc` in Git Bash). A path is from the
// root when it starts with `/`, or with `~`, `$`, a backtick or a brace list, which can stand for one, or climbs with
// `..`; any other path is read on from the working folder, as Git Bash writes it (`C:\proj` is `/c/proj`). So
// `dev/*` or `../dev/*` in a project is no process's folder. A part with a glob counts as one that could match, and
// one with `$`, a backtick or a brace list too, but then the last part has to be written out letter for letter, or
// every `"$dir"/*` would count.
function procEnviron(filePath, cwd) {
  let written = filePath.replace(/\\/g, "/").replace(/["']/g, "");
  // Most paths end in a part that can't be `environ`: they're let go before the working folder is looked at.
  const end = written.slice(written.lastIndexOf("/") + 1);
  if (!/^\.{0,2}$/.test(end) && !looseWordCouldBe(end, "environ")) return false;
  const fromRoot = /^[/~$`{]/.test(written);
  const folder = gitBashFolder(cwd);
  if (!fromRoot && typeof folder === "string" && folder.startsWith("/")) written = `${folder}/${written}`;
  const rooted = fromRoot || written.startsWith("/") || /(?:^|\/)\.\.(?:\/|$)/.test(written);
  if (!rooted) return false;
  const parts = written.split("/");
  return environUnder(parts) || environUnder(foldDotParts(parts));
}

// A working folder as Git Bash writes it: `C:\proj` is `/c/proj`, and the temp folder is its /tmp. A POSIX one as is.
function gitBashFolder(cwd) {
  if (typeof cwd !== "string") return cwd;
  const drive = /^([A-Za-z]):[\\/]/.exec(cwd);
  if (!drive) return cwd;
  const folder = cwd.replace(/\\/g, "/");
  const temp = os.tmpdir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" && folder.toLowerCase().startsWith(temp.toLowerCase())) {
    const under = folder.slice(temp.length);
    if (under === "" || under.startsWith("/")) return `/tmp${under}`;
  }
  return `/${drive[1].toLowerCase()}/${folder.slice(3)}`;
}

function environUnder(parts) {
  const last = parts.length - 1;
  if (last < 1 || !looseWordCouldBe(parts[last], "environ")) return false;
  let first = 0;
  while (first < last && (parts[first] === "" || parts[first] === "." || parts[first] === "..")) first += 1;
  if (first === last) return false;
  const lead = parts[first];
  if (!looseWordCouldBe(lead, "proc") && !looseWordCouldBe(lead, "dev")) return false;
  return !/[$`{]/.test(lead) || !/[*?[$`{]/.test(parts[last]);
}

// A path's parts with `.`, empty parts and each `..` with the part before it left out, in one pass: Node's
// path.posix.normalize takes time that grows with the square of a run of `../`.
function foldDotParts(parts) {
  const kept = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
    else kept.push(part);
  }
  return kept;
}

// Whether a shell word could expand to `literal`, letter case aside: a `*` matches any run, a `?` or `[…]` class any
// one character, and a word with `$`, a backtick or a brace list in it could be anything. Linear in the word's length.
function looseWordCouldBe(word, literal) {
  const units = looseGlobUnits(word, literal.length);
  return units !== null && looseUnitsMatch(units, literal);
}

// A word's units for looseWordCouldBe, or null when it holds more than `max` characters that each match one, so it
// can't expand to a word that short. "" stands for a run (`*`, `$…`, an extglob pattern list such as `@(…)`), "?"
// for any one character.
function looseGlobUnits(word, max) {
  if (/[$`{]|[@+?!*]\(/.test(word)) return [""];
  const units = [];
  let fixed = 0;
  let closes = true;
  const unclosed = new Set();
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === "*") {
      if (units[units.length - 1] !== "") units.push("");
      continue;
    }
    fixed += 1;
    if (fixed > max) return null;
    if (c === "[" && closes) {
      const close = globClassEnd(word, i, unclosed);
      if (close >= 0) {
        units.push("?");
        i = close;
        continue;
      }
      closes = false;
    }
    units.push(c === "?" ? "?" : c.toLowerCase());
  }
  return units;
}

// Where the `[…]` class starting at `start` ends, or -1 when it doesn't. A `]` right after `[` or `[!` is a member
// of the class, not its end, and so is one inside a `[:alpha:]`, `[=e=]` or `[.e.]` in it. `unclosed` keeps the
// kinds of those found to have no end, so a word full of them is read once.
function globClassEnd(word, start, unclosed) {
  let i = start + 1;
  if (word[i] === "!" || word[i] === "^") i += 1;
  if (word[i] === "]") i += 1;
  for (; i < word.length; i += 1) {
    if (word[i] === "]") return i;
    const kind = word[i] === "[" ? word[i + 1] : "";
    if (kind !== ":" && kind !== "=" && kind !== ".") continue;
    const end = unclosed.has(kind) ? -1 : word.indexOf(`${kind}]`, i + 2);
    if (end < 0) unclosed.add(kind);
    else i = end + 1;
  }
  return -1;
}

function looseUnitsMatch(units, literal) {
  const target = literal.toLowerCase();
  let row = target.split("").map(() => false);
  row.unshift(true);
  for (const unit of units) {
    const next = row.map(() => false);
    let any = false;
    for (let j = 0; j <= target.length; j += 1) {
      if (unit === "") {
        any = any || row[j];
        next[j] = any;
      } else if (j > 0) next[j] = row[j - 1] && (unit === "?" || unit === target[j - 1]);
    }
    row = next;
  }
  return row[target.length];
}

// `budget` is a shell check's (see shellWalkBudget), given with `shell` or, for a path a command opens without the
// shell expanding it, alone. Under one, verdicts are kept for the check's length, since a command can name the same
// operand thousands of times, and an operand past the check's lookups on disk is judged as secretPastLookups says.
function isSecretOperand(value, cwd, shell, budget = shell?.budget) {
  const filePath = value.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  if (procEnviron(filePath, cwd)) return true;
  // A device path to a drive, `\\?\C:\proj\ENV~1`, is judged as the drive paths it could open (see localDevicePaths).
  const drivePaths = localDevicePaths(filePath);
  if (drivePaths !== null) return drivePaths.some((drivePath) => isSecretOperand(drivePath, cwd, shell, budget));
  const key = `${shell ? "shell" : "path"}\u0000${filePath}`;
  if (budget?.verdicts.has(key)) return budget.verdicts.get(key);
  let verdict;
  if (budget) checkShellDeadline(budget);
  // A drive's share, and a path Windows tidies, are judged as the drive paths they open (see isSecretPath).
  const { shares, tidied } = drivePathsOf(filePath, cwd, budget);
  // Those drive paths take lookups of their own, more than the path as written: once the check's lookups, or the part
  // of them these may use, are spent, a path that still needs them stops the command unless its name already does, as
  // one past them does (see secretPastLookups), so padding a command with them can't hold the hook.
  if (
    budget &&
    (tidied.length || shares.some((item) => item.loopback)) &&
    (lookupsSpent(budget) || Date.now() >= budget.drivePathDeadline)
  ) {
    if (!secretByName(filePath, cwd, budget)) throw new ShellCheckTooLong();
    budget.verdicts.set(key, true);
    return true;
  }
  // A path judged by its name alone counts in `byName` (see secretInFirstShellReading).
  if (budget && shares.some((item) => !item.loopback)) budget.byName += 1;
  if (
    shares.some((item) =>
      item.loopback ? isSecretOperand(item.drive, cwd, shell, budget) : secretByName(item.drive, cwd, budget),
    ) ||
    tidied.some((drivePath) => isSecretOperand(drivePath, cwd, shell, budget))
  ) {
    verdict = true;
  } else if (remoteLocation(filePath, cwd)) {
    if (budget) budget.byName += 1;
    verdict = secretByName(filePath, cwd, budget);
  } else if (budget && lookupsSpent(budget)) verdict = secretPastLookups(filePath, cwd, shell, budget);
  else {
    if (budget) budget.lookups -= 1;
    const known = budget && !/[*?[]/.test(filePath) ? literalOperandVerdict(filePath, cwd, budget) : undefined;
    verdict =
      known ??
      (isSecretPath(filePath, "", cwd, { budget }) ||
        (shell ? shellGlobReadsSecret(filePath, cwd, shell) : globSecretByName(filePath, budget)));
  }
  budget?.verdicts.set(key, verdict);
  return verdict;
}

// The drive paths a path opens, its drive's share mapped (see driveSharePaths) and as Windows tidies it (see
// windowsTidiedPaths), worked out once in a shell check: an operand's own check and a recursive reader's walk both ask.
function drivePathsOf(filePath, cwd, budget) {
  // Kept by folder, then path: one long key per path took as long to build and look up as what it saved.
  let inFolder = budget?.drivePaths.get(cwd);
  if (budget && !inFolder) budget.drivePaths.set(cwd, (inFolder = new Map()));
  const known = inFolder?.get(filePath);
  if (known) return known;
  const found = {
    shares: driveSharePaths(filePath, cwd, { budget }) || [],
    tidied: windowsTidiedPaths(filePath, cwd) || [],
  };
  inFolder?.set(filePath, found);
  return found;
}

// A path without a wildcard is looked up once, and what's found is kept for a recursive reader's own look at it: a
// path with nothing at it is judged by its name, as isSecretPath would judge it, and is no folder to walk. Undefined
// when the lookup can't say, so the full check runs.
function literalOperandVerdict(filePath, cwd, budget) {
  const absolutePath = path.resolve(cwd, filePath);
  let stats;
  checkShellDeadline(budget);
  try {
    // A name its folder's listing can answer for (see listedInFolder), `0.` or `notes.txt `, costs no lookup of its own.
    stats =
      listedInFolder(absolutePath, budget) === false
        ? undefined
        : fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  } catch (error) {
    if (error instanceof ShellCheckTooLong) throw error;
    return undefined;
  }
  if (stats === undefined) {
    budget.directories.set(absolutePath, false);
    // A drive path's own name, as a tidied one is (see windowsTidiedPaths), is the same path: judged once.
    return isSecretFile(filePath) || (filePath.replace(/\//g, "\\") !== absolutePath && isSecretFile(absolutePath));
  }
  if (!stats.isSymbolicLink()) budget.directories.set(absolutePath, stats.isDirectory());
  return undefined;
}

// An operand left once a shell check's lookups are spent (see lookupsSpent). Its name alone can't tell a link, a
// junction or a Windows short name from the secret file it opens, so padding a command until the lookups run out
// mustn't let one through by its name: it stops the command unless its name already does. A path with nothing at it
// opens nothing, so it is judged by its name, as literalOperandVerdict judges one, after the same one quick lookup. A
// glob the shell expands could match anything in its folder, so it stops the command too.
function secretPastLookups(filePath, cwd, shell, budget) {
  if (secretByName(filePath, cwd, budget)) return true;
  if (shell && /[*?[]/.test(filePath)) throw new ShellCheckTooLong();
  const absolutePath = path.resolve(cwd, filePath);
  let found = listedInFolder(absolutePath, budget);
  if (found === undefined) {
    try {
      found = fs.lstatSync(absolutePath, { throwIfNoEntry: false }) !== undefined;
    } catch {
      found = true;
    }
  }
  if (found) throw new ShellCheckTooLong();
  budget.directories.set(absolutePath, false);
  return false;
}

// The most names a folder listing kept for one shell check may hold (see listedInFolder).
const FOLDER_LISTING_MAX_NAMES = 4096;

// Whether anything is at a path, told from its folder's listing, read once for the check and kept, so many operands in
// a few folders cost a few reads, not one lookup each: a folder that isn't there, as its own folder's listing tells,
// isn't read at all. Undefined when only a lookup can tell: a name that could be a short name (any 8.3 name, `0` or
// `CONFIG.TXT`, since one can be given to any file, and not only `ENV~1`), a stream, a device or other than plain ASCII
// (which the system may match in ways a listing doesn't), or a folder too big or unreadable. A name ending in a dot or
// a space (`0.`), which no short name does, is answered. Letter case is ignored on every system, so a name differing
// only in case is looked up.
function listedInFolder(absolutePath, budget, depth = 0) {
  const folder = path.dirname(absolutePath);
  const name = path.basename(absolutePath);
  if (folder === absolutePath || !/^[\x20-\x7e]+$/.test(name) || /[~:*?"<>|\\]/.test(name)) return undefined;
  if (/^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:[. ]|$)/i.test(name)) return undefined;
  if (/^[\w!#$%&'()@^`{}-]{1,8}(?:\.[\w!#$%&'()@^`{}-]{1,3})?$/.test(name)) return undefined;
  const fold = (text) => text.toLowerCase();
  if (!budget.folderNames.has(folder)) {
    let names;
    if (depth < 64 && listedInFolder(folder, budget, depth + 1) === false) names = null;
    else {
      checkShellDeadline(budget);
      try {
        const listed = fs.readdirSync(folder);
        names = listed.length > FOLDER_LISTING_MAX_NAMES ? undefined : new Set(listed.map(fold));
      } catch (error) {
        names = error?.code === "ENOENT" ? null : undefined;
      }
    }
    budget.folderNames.set(folder, names);
  }
  const names = budget.folderNames.get(folder);
  if (names === undefined) return undefined;
  return names !== null && names.has(fold(name));
}

// A path judged without the disk: its own name, where it resolves to, for a glob, the secret names it could match, and
// on a path Guard never looks up, a part that could be a Windows short name (see hasShortNamePart) or a device name
// Guard can't place (see opensUnknownDevice).
function secretByName(filePath, cwd, budget) {
  const key = `name\u0000${filePath}`;
  if (budget?.verdicts.has(key)) return budget.verdicts.get(key);
  const verdict =
    isSecretFile(filePath) ||
    isSecretFile(path.resolve(cwd, filePath)) ||
    globSecretByName(filePath, budget) ||
    hasShortNamePart(filePath) ||
    opensUnknownDevice(filePath) ||
    driveRelativeFromRemote(filePath, cwd);
  budget?.verdicts.set(key, verdict);
  return verdict;
}

// The names of the credential stores known by their folder (`.kube/config`, see SECRET_PATHS in secret-files.js),
// none a secret file by its name alone.
const SECRET_FOLDER_FILES = [
  "config",
  "config.json",
  "hosts.yml",
  "auth.json",
  "oauth_creds.json",
  "credentials.db",
  "access_tokens.db",
  "application_default_credentials.json",
  "settings.xml",
  "gradle.properties",
  "msal_token_cache.json",
];

// Whether a folder's name alone says a recursive read of it reads a secret file: a folder holding a credential store
// known by its folder (`.kube`, `.config/gcloud`), `.ssh` or `.aws`. A folder Guard doesn't walk, on another computer,
// is judged this way, as its files can't be: as written, and with `.` and `..` resolved from the working folder (`.`
// in `\\host\home\.kube`, or `.kube\x\..`), as the system resolves them.
function secretFolderByName(folder, cwd) {
  if (typeof folder !== "string") return false;
  const text = folder.replace(/^\s*['"]|['"]\s*$/g, "");
  const forms = [text];
  if (typeof cwd === "string" && cwd) {
    try {
      forms.push(path.isAbsolute(text) ? path.normalize(text) : path.join(cwd, text || "."));
    } catch {
      // A path Node can't join is judged as written.
    }
  }
  return forms.some((form) => {
    const parts = resolvedParts(form);
    if (!parts.length) return false;
    const normalized = parts.join("/");
    const last = trimEndOf(withoutStream(parts[parts.length - 1]), ". ").toLowerCase();
    if (last === ".ssh" || last === ".aws") return true;
    return SECRET_FOLDER_FILES.some((name) => isSecretFile(`${normalized}/${name}`));
  });
}

// A path's parts with `.` and `..` resolved by name. A part of only dots and spaces is `..` or `.`, as Windows drops a
// part's last dots and spaces (`.kube\...` and `.kube\ ` are `.kube`).
function resolvedParts(value) {
  const resolved = [];
  for (const written of value.replace(/\\/g, "/").split("/")) {
    const part = /^[. ]+$/.test(written) ? (/^\.\. *$/.test(written) ? ".." : ".") : written;
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  return resolved;
}

// The names of the folders secretFolderByName knows. `gh`, `GitHub CLI` and `gcloud` are common words, so a glob counts
// them only below `.config` or `AppData\Roaming`, where they hold credentials.
const SECRET_FOLDER_NAMES = [".kube", ".docker", ".codex", ".gemini", ".m2", ".gradle", ".azure", ".ssh", ".aws"];
const SECRET_CONFIG_FOLDER_NAMES = ["gh", "github cli", "gcloud"];
const ORDINARY_NAME = "zz-clotr-sample";
// Common folder names: a wildcard that matches any of them is a project's, not one for a credentials folder (`*s` for
// `docs` as well as `.ssh`), and a filter that matches a secret name in a folder counts unless it matches the name in
// every one of these (`*/config`, but not `*e/config`).
const ORDINARY_FOLDER_NAMES = [
  ORDINARY_NAME,
  "src",
  "docs",
  "tests",
  "lib",
  "utils",
  "server",
  "users",
  "app",
  "build",
  "data",
  "q1",
  "x.y",
];

// Whether one part of a glob, below `parent`, singles out a credentials folder (see SECRET_FOLDER_NAMES): written out,
// or a wildcard that matches one and no ordinary name. A shell's wildcard doesn't match a leading dot, but a search
// filter's does (`?ssh`, `[.]ssh` and `*ssh` match `.ssh` in ripgrep and Gemini CLI): `dotWildcards`.
function partNamesSecretFolder(part, parent = "", { dotWildcards = false } = {}) {
  const folded = trimEndOf(withoutStream(part), ". ").toLowerCase();
  if (!/[*?[]/.test(part)) return SECRET_FOLDER_NAMES.includes(folded) || SECRET_CONFIG_FOLDER_NAMES.includes(folded);
  const matches = (name) => globMatchesPath(part, name, { classes: true });
  if (ORDINARY_FOLDER_NAMES.some(matches)) return false;
  if ((dotWildcards || part.startsWith(".")) && SECRET_FOLDER_NAMES.some(matches)) return true;
  const configParent = /[*?[]/.test(parent || "")
    ? [".config", "roaming"].some((name) => globMatchesPath(parent, name, { classes: true })) &&
      !ORDINARY_FOLDER_NAMES.some((name) => globMatchesPath(parent, name, { classes: true }))
    : /^(?:\.config|roaming)$/i.test(parent || "");
  return configParent && SECRET_CONFIG_FOLDER_NAMES.some(matches);
}

// Whether a glob singles out a credentials folder (see secretFolderByName): a folder a recursive reader reads once the
// shell expands it, its `.` and `..` resolved (`.ku*`, `*/.kube`, `.ku*/.`), or a search's filter with such a folder
// above the files it matches (`.kube/*`, `Users/*/.ssh/id_e*`, `/.kube/config`). `*/*` and `**/*.json` don't.
function globNamesSecretFolder(glob, { whole = false } = {}) {
  if (typeof glob !== "string" || (!whole && !/[*?[]/.test(glob))) return false;
  const parts = resolvedParts(glob.replace(/^\s*['"]|['"]\s*$/g, ""));
  if (!parts.length) return false;
  if (whole) {
    return parts
      .slice(0, -1)
      .some((part, index) => partNamesSecretFolder(part, parts[index - 1], { dotWildcards: true }));
  }
  const last = parts[parts.length - 1];
  if (!/[*?[]/.test(last)) return secretFolderByName(parts.join("/"));
  return partNamesSecretFolder(last, parts[parts.length - 2]);
}

// Whether a search's filter singles out a secret file by its name: it matches one (`**/id_e*`, `*.pem`, `.env*`), also
// below a folder it names (`proj/.env*`), and not an ordinary name (`*.json` matches `credentials.json`, but also any
// project's JSON file, and `**/*` any file). A secret name that holds only in its folder (`.kube/config`) counts only
// when the filter doesn't match that name in an ordinary folder too (`**/config`).
const ORDINARY_EXTENSIONS = ["", ".txt", ".md", ".json", ".js", ".ts", ".py", ".php", ".yml", ".xml", ".properties"];
function filterNamesSecret(pattern) {
  if (typeof pattern !== "string" || !pattern) return false;
  const glob = pattern
    .replace(/^\s*['"]|['"]\s*$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "");
  if (isSecretFile(glob)) return true;
  if (!/[*?[]/.test(glob)) return false;
  if (!secretGlobCandidates) secretGlobCandidates = secretNameCandidates();
  const last = glob.replace(/\/+$/, "").split("/").pop();
  return [...new Set([glob, last])].some((reading) => {
    if (!reading) return false;
    const matches = (name) =>
      globMatchesPath(reading, name, { classes: true }) || globMatchesPath(reading, `home/${name}`, { classes: true });
    const ordinary = (extension) => {
      const name = `${ORDINARY_NAME}${extension}`;
      return (
        !isSecretFile(name) && (matches(name) || ORDINARY_FOLDER_NAMES.some((folder) => matches(`${folder}/${name}`)))
      );
    };
    if (ORDINARY_EXTENSIONS.some(ordinary)) return false;
    return secretGlobCandidates.some(({ candidate, name }) =>
      candidate.includes("/")
        ? matches(candidate) && !ORDINARY_FOLDER_NAMES.every((folder) => matches(`${folder}/${name}`))
        : matches(candidate) && !ordinary(path.posix.extname(name)),
    );
  });
}

// globCouldMatchSecret, asked once per glob in a shell check: an operand and the folders under it ask about the same one.
function globSecretByName(glob, budget) {
  const normalized = glob.replace(/\\/g, "/");
  if (!budget) return globCouldMatchSecret(normalized);
  const key = `glob\u0000${normalized}`;
  if (!budget.verdicts.has(key)) budget.verdicts.set(key, globCouldMatchSecret(normalized, budget));
  return budget.verdicts.get(key);
}

// One budget for all the disk reading a shell command's check does, so a command that names many folders or operands
// can't run the hook past its own timeout: the folder entries that glob expansions and recursive walks read, the
// operands and folders looked up one by one, and a deadline past which the check stops the command.
function shellWalkBudget(options = {}) {
  const now = Date.now();
  return {
    deadline: now + (options.searchWalkMaxMs || SHELL_WALK_MAX_MS),
    entries: options.searchWalkMaxEntries || SHELL_WALK_MAX_ENTRIES,
    // The recursive readers' own (see SHELL_TREE_WALK_MAX_ENTRIES); a test's limit sets both.
    walkDeadline: now + (options.searchWalkMaxMs ?? options.shellCheckMaxMs ?? SHELL_CHECK_MAX_MS),
    walkEntries: options.searchWalkMaxEntries || SHELL_TREE_WALK_MAX_ENTRIES,
    lookups: options.shellOperandMaxLookups ?? SHELL_OPERAND_MAX_LOOKUPS,
    lookupDeadline: now + (options.shellOperandMaxMs ?? SHELL_OPERAND_MAX_MS),
    // Within the operands' own time, which a caller giving that time (a test, for one) gives these too.
    drivePathDeadline:
      now +
      Math.min(
        options.shellOperandMaxMs ?? SHELL_OPERAND_MAX_MS,
        options.shellDrivePathMaxMs ?? options.shellOperandMaxMs ?? SHELL_DRIVE_PATH_MAX_MS,
      ),
    checkDeadline: now + (options.shellCheckMaxMs ?? SHELL_CHECK_MAX_MS),
    folders: new Map(),
    directories: new Map(),
    targets: new Set(),
    verdicts: new Map(),
    listings: new Map(),
    trees: new Map(),
    folderNames: new Map(),
    drivePaths: new Map(),
    // How many times a path was judged by its name where Guard couldn't look (see secretInFirstShellReading).
    byName: 0,
  };
}

function budgetSpent(budget) {
  return Boolean(budget) && (budget.entries <= 0 || Date.now() >= budget.deadline);
}

function walkSpent(budget) {
  return budget.walkEntries <= 0 || Date.now() >= budget.walkDeadline;
}

function lookupsSpent(budget) {
  return budget.lookups <= 0 || Date.now() >= budget.lookupDeadline;
}

// Stops a shell check that ran out of time or budget; `location` says why (see secretFileMessage).
class ShellCheckTooLong extends Error {
  constructor(location = SHELL_TOO_MANY_PATHS) {
    super(location);
    this.location = location;
  }
}

function checkShellDeadline(budget) {
  if (Date.now() >= budget.checkDeadline) throw new ShellCheckTooLong();
}

// A recursive reader's folders can't be left unread once the walk's entries or time, or the lookups, are spent: a
// secret file could be past that point. So the command is stopped.
function stopIfSpent(budget) {
  checkShellDeadline(budget);
  if (lookupsSpent(budget)) throw new ShellCheckTooLong(SHELL_TOO_MANY_PATHS);
  if (walkSpent(budget)) throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
}

// A broad shell glob (`*`, `src/*`, `*.txt`) is expanded against its folder, the way the shell will, so it's stopped
// only when that folder holds a secret file it matches; Bash's `*` leaves dotfiles out, PowerShell's doesn't. Any
// other glob (`cert/server.p?m`, `.e[n]v`, `*/x*`) is first judged by the secret names it could match, as it always
// was, then expanded too, its folders one level at a time. A folder Guard can't read as plain text, a command that
// changes folder, or a glob left once the budget is spent is judged by the secret names alone.
function shellGlobReadsSecret(pattern, cwd, shell) {
  if (!/[*?[]/.test(pattern)) return false;
  const broad = broadShellGlob(pattern);
  if (!broad && globSecretByName(pattern, shell.budget)) return true;
  const matches = expandShellGlob(pattern, cwd, shell) ?? (shell.budget ? expandFolderGlob(pattern, cwd, shell) : null);
  if (!matches) {
    if (shell.budget) shell.budget.byName += 1;
    return broad && globSecretByName(pattern, shell.budget);
  }
  if (shell.budget) shell.budget.lookups -= matches.length;
  return matches.some((match) => isSecretPath(match, "", cwd) || procEnviron(match, cwd));
}

// A glob whose last part starts with a wildcard, in a folder without one: the only kind Guard once expanded, and the
// only kind it doesn't also judge by the secret names it could match (Bash's `*` matching `.env` reads nothing).
function broadShellGlob(pattern) {
  const slash = pattern.lastIndexOf("/");
  return /^[*?]/.test(pattern.slice(slash + 1)) && !/[*?[\]{}$~`]/.test(slash < 0 ? "" : pattern.slice(0, slash));
}

// Whether a glob's folder of `count` entries can be matched, and if so it's charged to the budget. An operand's glob
// past SEARCH_WALK_MAX_ENTRIES is judged by name instead; a recursive reader's (`walk`) is charged to the walk's own
// budget, and past what's left of it the command is stopped, since the folders it matches couldn't all be walked.
function chargeGlobListing(budget, count, walk) {
  if (walk) {
    if (count > Math.max(budget.walkEntries, 0)) throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
    budget.walkEntries -= count;
    return true;
  }
  if (count > SEARCH_WALK_MAX_ENTRIES) return false;
  if (budget) budget.entries -= count;
  return true;
}

// The paths a shell glob expands to, or null when Guard can't tell (see shellGlobReadsSecret). With `walk`, for a
// recursive reader's glob, a budget spent before it's matched stops the command instead (see chargeGlobListing).
function expandShellGlob(pattern, cwd, { posix, staysInFolder, budget }, walk = false) {
  const slash = pattern.lastIndexOf("/");
  const folder = slash < 0 ? "." : pattern.slice(0, slash) || "/";
  const name = pattern.slice(slash + 1);
  if (!staysInFolder || !/[*?[]/.test(name) || /[*?[\]{}$~`]/.test(folder)) return null;
  if (remoteLocation(folder, cwd)) return null;
  if (walk) stopIfSpent(budget);
  else if (budgetSpent(budget)) return null;
  const directory = path.resolve(cwd, folder);
  let listing = budget?.folders.get(directory);
  if (!listing) {
    try {
      listing = { entries: fs.readdirSync(directory) };
    } catch (error) {
      // A missing folder relative to the working one leaves the shell nothing to expand, so nothing is read.
      const missing =
        ["ENOENT", "ENOTDIR"].includes(error.code) && !path.isAbsolute(folder) && !/^[A-Za-z]:/.test(folder);
      listing = { entries: missing ? [] : null };
    }
    budget?.folders.set(directory, listing);
  }
  const { entries } = listing;
  if (!entries) return null;
  // The shell reads `[...]` as a class; trying the brackets too only adds names to check.
  const glob = shellNameGlob(name);
  if (!glob || !chargeGlobListing(budget, entries.length, walk)) return null;
  const matches = [];
  for (const entry of entries) {
    if (walk) {
      if (Date.now() >= budget.walkDeadline) throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
    } else if (budget && Date.now() >= budget.deadline) return null;
    if (budget) checkShellDeadline(budget);
    // Bash's wildcards leave dotfiles out unless the name itself starts with the dot.
    if (posix && entry.startsWith(".") && !name.startsWith(".")) continue;
    if (glob.matches(entry)) matches.push(path.posix.join(folder, entry));
  }
  return matches;
}

// One part of a shell glob, compiled. compileGlob drops a leading `!` as a negation, as ignore files do; to Bash and
// PowerShell it's a letter, and cmd with delayed expansion drops it. So such a glob matches the names either reads.
function shellNameGlob(name) {
  const compiled = compileGlob(name, true);
  if (!compiled) return null;
  if (!name.startsWith("!")) return { matches: (entry) => compiledGlobMatches(compiled, entry) };
  const lettered = compileGlob(`?${name.slice(1)}`, true);
  return {
    matches: (entry) =>
      compiledGlobMatches(compiled, entry) ||
      (Boolean(lettered) && entry.startsWith("!") && compiledGlobMatches(lettered, entry)),
  };
}

// The paths a recursive reader's glob names, one folder level at a time, for the globs expandShellGlob leaves alone:
// `ke*`, `*/`, `n*/in*`. Folders are what such a reader walks; files it names were checked as its operands. Null when
// Guard can't tell within the walk's budget; with `walk`, a budget spent before it's done stops the command instead.
function expandFolderGlob(pattern, cwd, { posix, staysInFolder, budget }, walk = false) {
  if (!staysInFolder || !budget || /[{}$~`]/.test(pattern) || /^(?:\/|[A-Za-z]:)/.test(pattern)) return null;
  if (remoteLocation(pattern, cwd)) return null;
  const segments = pattern.split("/").filter(Boolean);
  if (segments.some((segment) => segment.includes("**"))) return null;
  let found = ["."];
  // A run of plain folders is joined on in one go: joined one at a time, a long path is read again for each.
  let plain = [];
  for (const [index, segment] of segments.entries()) {
    if (!/[*?[]/.test(segment)) {
      plain.push(segment);
      continue;
    }
    if (plain.length) {
      const run = plain.join("/");
      found = found.map((base) => path.posix.join(base, run));
      plain = [];
    }
    // Only folders lead on; the last level keeps every match, since the walk checks which are folders.
    const foldersOnly = index < segments.length - 1 || pattern.endsWith("/");
    const glob = shellNameGlob(segment);
    if (!glob) return null;
    const next = [];
    for (const base of found) {
      if (walk) stopIfSpent(budget);
      else if (budgetSpent(budget) || lookupsSpent(budget)) return null;
      checkShellDeadline(budget);
      const directory = path.resolve(cwd, base);
      const key = `types\u0000${directory}`;
      let entries = budget.folders.get(key);
      if (entries === undefined) {
        budget.lookups -= 1;
        try {
          entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
          // A folder that isn't there, or a file, has nothing in it for the shell to expand.
          if (!["ENOENT", "ENOTDIR"].includes(error.code)) return null;
          entries = [];
        }
        budget.folders.set(key, entries);
      }
      if (!chargeGlobListing(budget, entries.length, walk)) return null;
      for (const entry of entries) {
        if (posix && entry.name.startsWith(".") && !segment.startsWith(".")) continue;
        // A link may lead to a folder; the walk looks.
        if (foldersOnly && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (glob.matches(entry.name)) next.push(path.posix.join(base, entry.name));
      }
      // A recursive reader's matches are bounded by the entries charged for them.
      if (!walk && next.length > SEARCH_WALK_MAX_ENTRIES) return null;
    }
    found = next;
  }
  if (plain.length) found = found.map((base) => path.posix.join(base, plain.join("/")));
  return found;
}

const EMPTY_FILTERS = Object.freeze({ include: Object.freeze([]), exclude: Object.freeze([]) });

// GNU grep's long options, so one shortened to a prefix of only one of them is read as grep reads it (`--rec`).
const GREP_LONG_OPTIONS = [
  "after-context",
  "basic-regexp",
  "before-context",
  "binary",
  "binary-files",
  "byte-offset",
  "color",
  "colour",
  "context",
  "count",
  "dereference-recursive",
  "devices",
  "directories",
  "exclude",
  "exclude-dir",
  "exclude-from",
  "extended-regexp",
  "file",
  "files-with-matches",
  "files-without-match",
  "fixed-strings",
  "group-separator",
  "help",
  "ignore-case",
  "include",
  "initial-tab",
  "invert-match",
  "label",
  "line-buffered",
  "line-number",
  "line-regexp",
  "max-count",
  "no-filename",
  "no-group-separator",
  "no-ignore-case",
  "no-messages",
  "null",
  "null-data",
  "only-matching",
  "perl-regexp",
  "quiet",
  "recursive",
  "regexp",
  "silent",
  "text",
  "unix-byte-offsets",
  "version",
  "with-filename",
  "word-regexp",
];

// Splits a reader's arguments into options and operands, the way getopt does: `-abc` is three flags until one that
// takes a value, which takes the rest of the word or the next word; `--name=value` or `--name value`; `--` ends options.
// With `longNames`, a reader's whole list of long options, a long option shortened to a prefix of only one of them
// (`--rec`, `--inc`) is read as that one, as getopt_long reads it.
function parseShellArgs(args, { shortValues = "", longValues = [], longNames = null } = {}) {
  const unquote = (value) => value.replace(/^['"]|['"]$/g, "");
  const options = [];
  const operands = [];
  let onlyOperands = false;
  const fullName = (name) => {
    if (!longNames || !name || longNames.includes(name)) return name;
    const matches = longNames.filter((candidate) => candidate.startsWith(name));
    return matches.length === 1 ? matches[0] : name;
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = unquote(args[index]);
    if (onlyOperands || value === "-" || !value.startsWith("-")) {
      operands.push(value);
    } else if (value === "--") {
      onlyOperands = true;
    } else if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = fullName(value.slice(2, equals < 0 ? undefined : equals));
      // A value quoted after the `=` (`--glob='.env*'`) is the value without its quotes.
      if (equals >= 0) options.push([name, unquote(value.slice(equals + 1))]);
      else if (longValues.includes(name) && index + 1 < args.length) options.push([name, unquote(args[++index])]);
      else options.push([name, true]);
    } else {
      for (let at = 1; at < value.length; at += 1) {
        if (!shortValues.includes(value[at])) {
          options.push([value[at], true]);
          continue;
        }
        const rest = unquote(value.slice(at + 1).replace(/^=/, ""));
        if (rest) options.push([value[at], rest]);
        else if (index + 1 < args.length) options.push([value[at], unquote(args[++index])]);
        break;
      }
    }
  }
  const has = (...names) => options.some(([name]) => names.includes(name));
  const values = (...names) =>
    options.filter(([name, given]) => names.includes(name) && given !== true).map((o) => o[1]);
  return { options, operands, has, values };
}

// How grep's arguments are read: the options that take a value.
const GREP_PARSE = {
  shortValues: "efmABCdD",
  longValues: [
    "regexp",
    "file",
    "max-count",
    "after-context",
    "before-context",
    "context",
    "directories",
    "devices",
    "include",
    "exclude",
    "exclude-dir",
    "exclude-from",
    "label",
    "binary-files",
    "group-separator",
  ],
  // GNU grep takes any unambiguous start of a long option (`--rec`, `--inc=.env`).
  longNames: GREP_LONG_OPTIONS,
};

// Whether a command's input redirected from this path is a file to ripgrep, which reads its input in place of the
// working folder only when that's a file or a pipe. Only a path Guard finds a file, FIFO or socket at is one: not a
// device however it's written (`/dev/null`, `/usr/../dev/null`, `NUL`, `NUL:`, `CON`), a folder, a path the shell
// rewrites first (a variable, a glob, `~`), one Guard can't look up in time, or one with nothing at it yet, which an
// earlier command may make a folder (`mkdir d; rg x < d`). An empty name is an input copied from another stream or
// closed (`<&3`, `<&-`).
function stdinIsFile(from, cwd, budget) {
  if (!from || /[$`\u2026*?[\]{}~]/.test(from)) return false;
  if (/^\/(?:dev|proc)(?:\/|$)/i.test(path.posix.normalize(from.replace(/\\/g, "/")))) return false;
  if (/(?:^|[\\/])(?:nul|con|aux|prn|com\d|lpt\d|conin|conout)(?:\.[^\\/]*)?:?$/i.test(from)) return false;
  if (!budget || lookupsSpent(budget)) return false;
  budget.lookups -= 1;
  let stats;
  // Joined, not resolved: `..` after a link to a folder goes up from where the link points, as the shell opens it.
  const target = path.isAbsolute(from) ? from : `${path.resolve(cwd)}${path.sep}${from}`;
  try {
    stats = fs.statSync(target, { throwIfNoEntry: false });
  } catch {
    return false;
  }
  return stats !== undefined && (stats.isFile() || stats.isFIFO() || stats.isSocket());
}

// The folders a recursive reader reads every file under, each with the reader's own filters. `glob` is what a target
// is judged by when its folders can't all be walked: the broad glob it came from, by the secret names it could match.
// grep's --exclude-dir leaves no folder out of the walk: each shell splits, joins, expands and redirects grep's words
// its own way, so the word Guard reads as --exclude-dir may reach grep as something else, or not at all.
// `lastIsSource` says whether cp's last word is copied too (see copySources).
// `stdin`: the reader's input is redirected from a file or text, so rg given no folder reads that, not the working
// folder (see stdinIsFile). `pattern`: the words are the shell's own, so grep or rg given none, with no `-e` or `-f`
// either, only prints its usage (`grep -rn #TODO`, a comment after `grep -rn`).
function recursiveReadTargets(reader, args, lastIsSource = () => true, { stdin = false, pattern = false } = {}) {
  const name = reader.toLowerCase();
  if (name === "grep") {
    const parsed = parseShellArgs(args, GREP_PARSE);
    // grep takes a value shortened to a prefix of only one it knows (`-d rec`; `re` could be `read`).
    const recursive =
      parsed.has("r", "R", "recursive", "dereference-recursive") ||
      parsed.values("d", "directories").some((value) => value.length >= 3 && "recurse".startsWith(value));
    if (!recursive) return [];
    const filters = { include: withUnescapedGlobs(parsed.values("include")), exclude: parsed.values("exclude") };
    const given = parsed.has("e", "regexp", "f", "file");
    if (pattern && !given && !parsed.operands.length) return [];
    const operands = given ? parsed.operands : parsed.operands.slice(1);
    // With only a pattern, `grep -r` reads the working folder.
    return (operands.length ? operands : ["."]).map((operand) => ({ path: operand, filters }));
  }
  if (name === "rg") {
    const parsed = parseShellArgs(args, {
      shortValues: "efgtTmABCdjMrE",
      longValues: [
        "regexp",
        "file",
        "glob",
        "iglob",
        "type",
        "type-not",
        "max-count",
        "after-context",
        "before-context",
        "context",
        "max-depth",
        "maxdepth",
        "threads",
        "max-columns",
        "replace",
        "encoding",
        "pre",
        "pre-glob",
        "sort",
        "sortr",
        "color",
        "colors",
        "type-add",
        "type-clear",
        "ignore-file",
        "max-filesize",
        "path-separator",
        "context-separator",
        "engine",
        "dfa-size-limit",
        "regex-size-limit",
        "field-context-separator",
        "field-match-separator",
        "hyperlink-format",
        "hostname-bin",
      ],
    });
    // `--files` lists names without reading them; a depth of 0, the last one given, reads only the files named.
    const depths = parsed.values("d", "max-depth", "maxdepth");
    if (parsed.has("files", "type-list") || /^0+$/.test(depths[depths.length - 1] || "")) return [];
    const filters = { include: [], exclude: [] };
    for (const glob of parsed.values("g", "glob", "iglob")) {
      if (glob.startsWith("!")) filters.exclude.push(glob.slice(1));
      else filters.include.push(glob);
    }
    // A file type the command adds globs to (`--type-add 'k:id_*' -tk`) searches the files they match, so on a folder
    // judged by name they count like its own filters. They don't narrow a walk: the type may be one of rg's own, with
    // more globs than the command shows.
    const types = parsed.values("t", "type");
    filters.typeGlobs = parsed
      .values("type-add")
      .map((definition) => [
        definition.slice(0, definition.indexOf(":")),
        definition.slice(definition.indexOf(":") + 1),
      ])
      .filter(([type, glob]) => type && types.includes(type) && !/^include:/.test(glob))
      .map(([, glob]) => glob);
    filters.include = withUnescapedGlobs(filters.include);
    filters.typeGlobs = withUnescapedGlobs(filters.typeGlobs);
    // `-u` and `--unrestricted` count alike, each time given; any no-ignore flag, even one that turns off only some of
    // the ignore files, is taken as turning them all off.
    const unrestricted = parsed.options.filter(([option]) => option === "u" || option === "unrestricted").length;
    const reachability = {
      globbed: filters.include.length > 0,
      hidden: parsed.has("hidden", ".") || unrestricted >= 2,
      noIgnore:
        parsed.has(
          "no-ignore",
          "no-ignore-vcs",
          "no-ignore-dot",
          "no-ignore-parent",
          "no-ignore-files",
          "no-ignore-global",
          "no-ignore-exclude",
        ) || unrestricted >= 1,
    };
    const given = parsed.has("e", "regexp", "f", "file");
    if (pattern && !given && !parsed.operands.length) return [];
    const operands = given ? parsed.operands : parsed.operands.slice(1);
    // With no folder, rg reads its input when that's a pipe or redirected from a file or text (`stdin`), unless `-f -`
    // takes that input for the patterns; the working folder otherwise.
    if (!operands.length && stdin && !parsed.values("f", "file").includes("-")) return [];
    return (operands.length ? operands : ["."]).map((operand) => ({ path: operand, filters, reachability }));
  }
  if (name === "findstr") {
    // findstr's switches start with `/` (or `-`): flags can share one switch (`/si`), and `/c:`, `/g:`, `/f:`, `/d:`
    // and `/a:` carry a value. Switches can also be joined (`/s/i`, `/s/c:text`), a value switch last, taking the rest.
    // With /s each file name, wildcards and all, is looked for in every folder below.
    const flags = [];
    const values = {};
    const operands = [];
    for (const arg of args) {
      const value = arg.replace(/^['"]|['"]$/g, "");
      const found = { flags: [], values: [] };
      const switchAt = /[/-](?:([cgfda]):([^]*)|(offline|[belrsixvnmop]+)(?=\/|$))/iy;
      let at = 0;
      while (at < value.length) {
        switchAt.lastIndex = at;
        const option = switchAt.exec(value);
        if (!option) break;
        if (option[1]) found.values.push([option[1].toLowerCase(), option[2]]);
        else found.flags.push(option[3].toLowerCase());
        at = switchAt.lastIndex;
      }
      if (at === value.length && value) {
        flags.push(...found.flags);
        for (const [switchName, given] of found.values) values[switchName] = given;
      } else operands.push(value);
    }
    if (!flags.some((flag) => flag !== "offline" && flag.includes("s"))) return [];
    const files = values.c !== undefined || values.g !== undefined ? operands : operands.slice(1);
    // findstr reads `/d:"C:\proj"` as its own arguments are read, without the quotes, in each folder of a list too.
    const folders = values.d ? values.d.replace(/"/g, "").split(/[;,]/).filter(Boolean) : null;
    return files.flatMap((file) => {
      const spec = file.replace(/\\/g, "/");
      const slash = spec.lastIndexOf("/");
      const fileName = spec.slice(slash + 1);
      const filters = { include: [fileName], exclude: [] };
      const glob = /[*?]/.test(fileName) ? file : null;
      const roots = folders || [slash < 0 ? "." : spec.slice(0, slash) || "/"];
      return roots.map((folder) => ({ path: folder, filters, glob, literal: true }));
    });
  }
  if (name === "diff") {
    const parsed = parseShellArgs(args, {
      shortValues: "xXISFLCUWD",
      longValues: [
        "exclude",
        "exclude-from",
        "ignore-matching-lines",
        "starting-file",
        "show-function-line",
        "label",
        "context",
        "unified",
        "width",
        "ifdef",
        "from-file",
        "to-file",
      ],
    });
    if (!parsed.has("r", "recursive")) return [];
    const filters = { include: [], exclude: parsed.values("x", "exclude") };
    const operands = [...parsed.operands, ...parsed.values("from-file", "to-file")];
    return operands.map((operand) => ({ path: operand, filters }));
  }
  if (name === "cp") {
    const parsed = parseShellArgs(args, { shortValues: "tS", longValues: ["target-directory", "suffix"] });
    if (!parsed.has("r", "R", "a", "recursive", "archive")) return [];
    return copySources(parsed, lastIsSource).map((operand) => ({ path: operand, filters: EMPTY_FILTERS }));
  }
  return [];
}

// The home folders `~` and a home variable can name: USERPROFILE (PowerShell's and cmd's), HOME (Git Bash's, which may
// be written as a Git Bash drive path, `/c/Users/me`) and the account's own. Only absolute ones count.
function homeFolders() {
  const found = [];
  let own = "";
  try {
    own = os.homedir();
  } catch {
    // No home folder for this account: the variables are all there is.
  }
  for (const value of [process.env.USERPROFILE, process.env.HOME, own]) {
    if (typeof value !== "string" || !value) continue;
    const folder = gitBashDrivePath(value) ?? value;
    if (path.isAbsolute(folder) && !found.includes(folder)) found.push(folder);
  }
  return found;
}

// A Git Bash path as Git Bash tidies it before opening it: its `.` and `..` parts resolved (`/./c`, `/tmp/../c` and
// `/usr/../c` are `/c`) and `/proc/cygdrive` read as `/cygdrive`. Null for a path that doesn't start with one slash:
// `//host` is a share, and a relative path isn't a Git Bash one.
function gitBashTidied(value) {
  const text = value.replace(/\\/g, "/");
  if (!text.startsWith("/") || /^\/\/(?!\/)/.test(text)) return null;
  return path.posix.normalize(text).replace(/^\/proc(?=\/cygdrive(?:\/|$))/i, "");
}

// Whether a Git Bash path names a whole drive (`/c`, `/d/`, `/cygdrive/c`, `/./c`), which a recursive reader reads every
// file of. Only on Windows, where Git Bash maps those to drives.
function gitBashDriveRoot(value) {
  if (process.platform !== "win32" || typeof value !== "string") return false;
  const tidied = gitBashTidied(value.replace(/^\s*(['"])([^]*)\1\s*$/, "$2"));
  return Boolean(tidied && /^\/(?:cygdrive\/)?[a-z]\/?$/i.test(tidied));
}

// A Git Bash path on Windows as the drive path it opens: `/c/rest` and `/cygdrive/c/rest` are `C:/rest`, and `/tmp` is
// the account's temporary folder, after Git Bash tidies it (see gitBashTidied). Null for any other path, and elsewhere
// than Windows. `//host` is a share, not a drive.
function gitBashDrivePath(value) {
  if (process.platform !== "win32") return null;
  const text = gitBashTidied(value);
  if (!text) return null;
  const drive = /^\/(?:cygdrive\/)?([a-z])(?=\/|$)/i.exec(text);
  if (drive) return `${drive[1].toUpperCase()}:${text.slice(drive[0].length) || "/"}`;
  if (/^\/tmp(?=\/|$)/i.test(text)) return `${os.tmpdir().replace(/\\/g, "/")}${text.slice(4)}`;
  return null;
}

// The other paths a shell or a tool may open for a path as written: with a leading `~`, or a home variable (`$HOME`,
// `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%`, `$USERPROFILE`), as each home folder (see homeFolders), and a Git
// Bash drive path, in a Git Bash command (`gitBash`), as the drive path (see gitBashDrivePath): only one with a folder
// below the letter (`/c/Users`), as a bare `/s` is a switch to findstr, sort or more, and looking up `S:\` could reach
// the computer a mapped drive names. Quotes around the path are kept off. Other variables aren't known, so a path
// through one is judged by its name (see secretInRecursiveRead). `homeOnly` reads only a leading `~`, as a file tool
// that expands one does.
function pathReadings(value, { homeOnly = false, gitBash = false } = {}) {
  if (typeof value !== "string" || !value) return [];
  const text = value.replace(/^\s*(['"])([^]*)\1\s*$/, "$2").replace(/^['"]|['"]$/g, "");
  const readings = [];
  // A shell's other names for its working folder: Bash's `~+`, and `~0`, `~+0` and `~-0` from its folder stack, and a
  // process's `/proc/.../cwd`, also through `//`, `/./` or `/proc/self/root`, which Guard's own process would open as
  // its own working folder, not the command's.
  if (!homeOnly) {
    const tidied = text
      .replace(/\\/g, "/")
      .replace(/\/(?:\.?\/)+/g, "/")
      .replace(/^(?:\/proc\/(?:self|thread-self|\d+)\/root(?=\/))+/, "");
    const here = /^(?:~(?:\+|[+-]?0)|\/proc\/(?:self|thread-self|\d+)\/cwd)(?=\/|$)/.exec(tidied);
    if (here) return [`.${tidied.slice(here[0].length)}`];
  }
  const home = homeOnly
    ? /^~(?=[\\/]|$)/.exec(text)
    : /^(?:~|\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME)|\$\{env:(?:USERPROFILE|HOME)\}|%(?:USERPROFILE|HOME)%|\$USERPROFILE|\$\{USERPROFILE\})(?=[\\/]|$)/i.exec(
        text,
      );
  if (home) {
    for (const folder of homeFolders()) readings.push(folder.replace(/[\\/]+$/, "") + text.slice(home[0].length));
  } else if (gitBash && /^\/(?:(?:cygdrive\/)?[a-z]\/|tmp(?:\/|$))/i.test(gitBashTidied(text) || "")) {
    const drivePath = gitBashDrivePath(text);
    if (drivePath) readings.push(drivePath);
  }
  return [...new Set(readings)].filter((reading) => reading !== value);
}

// The paths in a PowerShell list (`notes.txt,.env`), which a cmdlet reads each of and PowerShell hands a program as
// words of their own; commas inside quotes or braces (`*.{js,ts}`) don't part it. Empty when there's no list.
function listedPaths(value) {
  if (typeof value !== "string" || !value.includes(",")) return [];
  const pieces = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      pieces.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (!pieces.length) return [];
  pieces.push(value.slice(start));
  return pieces.filter(Boolean);
}

// A word as the shell joins it, quoted parts and all (`"$HOME"/kj`, `'.e'nv`), without its quotes; null when no quote
// sits inside it. Guard's own reading splits a word at its quotes (see secretInShellReads), so this is read as well.
function joinedWords(text) {
  const words = text.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) || [];
  if (!words.some((word) => /["']/.test(word) && !/^(?:"[^"]*"|'[^']*')$/.test(word))) return null;
  return words.map((word) => word.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single));
}

// Whether a path starts with something the shell replaces that Guard can't read: a variable (`$X`, `%X%`), a command
// (`` `cmd` ``), or `~` (`~user`), and on Windows a leading single slash, which Git Bash, maybe Cursor's shell, opens as
// a path of its own (`/c/...`, `/tmp/../c/...`) that Guard doesn't read everywhere. What it opens isn't known, so a
// credentials folder named through it is judged by name.
function shellReplacesPart(value) {
  const text = String(value);
  return /[$%`]|^\s*['"]?~/.test(text) || (process.platform === "win32" && /^\s*['"]?\/(?!\/)/.test(text));
}

// A character a shell's escape makes literal (`\.`, `` `. ``, `^.`), written so Guard's reading of words keeps it so:
// as itself where no shell gives it a meaning to Guard (a backslash is a path's separator to it), else quoted. A
// character that ends a command (`;`, `&`, `|`, a bracket, a redirection or a backtick) ends Guard's reading of a
// reader's words even quoted, so it's written as `_`: no secret file's name has one.
function literalCharacter(char) {
  if (/[\w.\-/\\,:+@=]/.test(char)) return char;
  if (/[;&|()<>`]/.test(char)) return "_";
  return char === "'" ? `"'"` : `'${char}'`;
}

// Bash's ANSI-C quoting (`$'.e\x6ev'`) decoded from just past its `$'`: the text and the index of its closing quote.
function ansiCQuoted(command, start) {
  const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  let decoded = "";
  let at = start;
  while (at < command.length && command[at] !== "'") {
    if (command[at] !== "\\" || at + 1 >= command.length) {
      decoded += command[at];
      at += 1;
      continue;
    }
    const rest = command.slice(at + 1, at + 10);
    const code =
      /^x([0-9a-f]{1,2})/i.exec(rest) ||
      /^U([0-9a-f]{1,8})/.exec(rest) ||
      /^u([0-9a-f]{1,4})/.exec(rest) ||
      /^([0-7]{1,3})/.exec(rest);
    if (code) {
      const value = parseInt(code[1], /^[0-7]+$/.test(code[0]) ? 8 : 16);
      decoded += value <= 0x10ffff ? String.fromCodePoint(value) : "";
      at += 1 + code[0].length;
    } else if (rest[0] === "c" && rest.length > 1 && rest[1] !== "'") {
      decoded += String.fromCharCode(rest.charCodeAt(1) & 31);
      at += 3;
    } else {
      decoded += simple[rest[0]] ?? rest[0];
      at += 2;
    }
  }
  return { text: decoded, end: at };
}

// The escapes, quoting, comments and here-documents each shell reads: Bash's backslash (literal in single quotes, and in
// double quotes only before `$`, a backtick, `"`, `\` or a line break), its `$'...'` and `$"..."`, `#` comments and
// `<<WORD` here-docs; PowerShell's backtick (literal in single quotes), its `` `u{...} `` escape, `#` and `<# ... #>`
// comments and `@'...'@` here-strings; cmd's caret (literal in double quotes, and cmd has no single quotes). A `#`
// starts a comment after one of `wordEnds` (Bash's blanks and operators: a `\r`, `\v` or no-break space isn't one; any
// blank, bracket or separator in PowerShell, which also ends a word at a closing quote), up to one of `commentEnds`
// (Bash's comment runs past a `\r`). In a double quote, `nests` opens a command or variable (`"$(...)"`, Bash's
// `"${...}"`) whose own quotes pair inside it. Bash's `backticks` hold a command read on its own, and PowerShell's
// `bracedVariables` (`${...}`) a name. PowerShell can't parse a `<` starting a word outside a string or comment
// (`reservedLess`: it's reserved, though `--%` passes the rest of its line on as written), so it runs nothing of such
// a command (a Bash here-doc's `cat <<'EOF'`). PowerShell's `heldQuotes`: see unescapedCommand.
const SHELL_ESCAPES = {
  bash: {
    escape: "\\",
    singleQuotes: true,
    doubleEscapes: /[$`"\\\n\r]/,
    dollarQuotes: true,
    comments: true,
    hereDocs: true,
    wordEnds: /[ \t\n;&|()<>`]/,
    commentEnds: /\n/,
    nests: /^\$[({]/,
    backticks: true,
  },
  powershell: {
    escape: "`",
    singleQuotes: true,
    doubleEscapes: /[^]/,
    unicodeEscapes: true,
    comments: true,
    blockComments: true,
    hereStrings: true,
    wordEnds: /[\s;&|(){},=]/,
    commentEnds: /[\r\n]/,
    quotesEndWords: true,
    nests: /^\$\(/,
    bracedVariables: true,
    reservedLess: true,
    heldQuotes: true,
  },
  cmd: { escape: "^", singleQuotes: false, doubleEscapes: null },
};

// A Bash here-doc's delimiter word, read from just past its `<<` or `<<-` and the blanks after it, as Bash reads it: up
// to a blank or an operator, with its quotes and backslashes taken off (`E\OF`, `E"O"F`, `'EOF'x`) and `$'...'`
// decoded. A `$` or a backtick in it is kept as written, as Bash doesn't expand them there. The word and where it ends.
function hereDocWord(command, start) {
  let word = "";
  let at = start;
  while (at < command.length && !/[ \t\n;&|()<>]/.test(command[at])) {
    const char = command[at];
    if (char === "\\") {
      word += command[at + 1] === "\n" ? "" : (command[at + 1] ?? "");
      at += 2;
    } else if (char === "'") {
      const close = command.indexOf("'", at + 1);
      const end = close < 0 ? command.length : close;
      word += command.slice(at + 1, end);
      at = end + 1;
    } else if (char === "$" && command[at + 1] === "'") {
      const { text, end } = ansiCQuoted(command, at + 2);
      word += text;
      at = end + 1;
    } else if (char === '"' || (char === "$" && command[at + 1] === '"')) {
      at += char === "$" ? 2 : 1;
      while (at < command.length && command[at] !== '"') {
        if (command[at] === "\\" && /[$`"\\\n]/.test(command[at + 1] ?? "")) at += 1;
        word += command[at] === "\n" && command[at - 1] === "\\" ? "" : command[at];
        at += 1;
      }
      at += 1;
    } else if (char === "`") {
      const close = command.indexOf("`", at + 1);
      const end = close < 0 ? command.length : close + 1;
      word += command.slice(at, end);
      at = end;
    } else {
      word += char;
      at += 1;
    }
  }
  return { word, end: Math.min(at, command.length) };
}

// The command a Bash backtick holds, from just past it, and where it ends: at the next backtick an escape doesn't take,
// whatever quotes are in it. Bash takes a backslash off before `$`, a backtick or `\` (and `"`, in a double quote),
// also in a quote there, so `` `cat .e\\nv` `` opens `.env`, and a backtick left that way starts a command inside it
// (`` `a \`b\`` ``).
function backtickCommand(command, start, inDouble) {
  let text = "";
  let at = start;
  while (at < command.length && command[at] !== "`") {
    const next = command[at + 1];
    if (command[at] === "\\" && next !== undefined) {
      text += /[$`\\]/.test(next) || (inDouble && next === '"') ? next : `\\${next}`;
      at += 2;
    } else {
      text += command[at];
      at += 1;
    }
  }
  return { text, end: at };
}

// Where a PowerShell `${...}` name that starts at `start` ends: at the first `}` its backtick doesn't take, or -1.
function bracedVariableEnd(command, start) {
  for (let at = start; at < command.length; at += 1) {
    if (command[at] === "`") at += 1;
    else if (command[at] === "}") return at;
  }
  return -1;
}

// Where each of a command's lines last starts, by its text without a trailing `\r`, and (after a NUL) without its
// leading tabs too, so a here-doc's delimiter line is found without reading the command again.
function lineStarts(command) {
  const starts = new Map();
  for (let at = 0; ;) {
    const found = command.indexOf("\n", at);
    const line = command.slice(at, found < 0 ? command.length : found).replace(/\r$/, "");
    starts.set(line, at);
    starts.set(`\0${line.replace(/^\t+/, "")}`, at);
    if (found < 0) return starts;
    at = found + 1;
  }
}

// Where a here-doc's body ends: past the line that is its delimiter, for each here-doc started on the line before
// `start`, in turn (`<<-` lets the line start with tabs). A line's `\r` is left out on both sides, so a body is never
// taken to run on past a line Bash may end it at. -1 if one never ends: then no body is skipped, as a here-doc Guard
// misread could otherwise hide the rest of the command.
function hereDocsEnd(command, start, hereDocs, starts) {
  let at = start;
  for (const { word, tabs } of hereDocs) {
    const delimiter = word.replace(/\r$/, "");
    if (!(starts.get(tabs ? `\0${delimiter}` : delimiter) >= at)) return -1;
    for (;;) {
      if (at >= command.length) return command.length;
      const found = command.indexOf("\n", at);
      const end = found < 0 ? command.length : found;
      let line = command.slice(at, end).replace(/\r$/, "");
      if (tabs) line = line.replace(/^\t+/, "");
      at = end + 1;
      if (line === delimiter) break;
    }
  }
  return Math.min(at, command.length);
}

// A command with one shell's escapes and quoting read (see SHELL_ESCAPES), so `cat .e\nv`, `` gc `.env ``,
// `type .e^nv` and `cat $'.env'` name `.env`. An escape before a line break joins the lines. With the shell's
// `comments`, a comment starts with a `#` at a word's start outside `${...}`; it's kept as it is written, with no quotes
// or escapes read in it, so the command before it keeps its words. PowerShell's `<# ... #>`, at a word's start, is left
// out, as is a here-doc's body (`hereDocs`, not after a third `<`, in `${...}` or where `<<` is a shift) or a
// here-string's (`hereStrings`, at a word's start): they hold text, not commands. A here-doc's body isn't skipped in a
// backtick's command or when its delimiter line never comes. With `lineReset`, a quote still open at a line break is
// ended there, as a quote the shell doesn't pair would otherwise put every later line inside it, and an escaped line
// break in a quote or after a `#` that may start a comment ends the line; with `heldQuotes` too, a quote ended so that
// closes later (a multi-line message, a here-string) keeps its text as written up to there, quotes and escapes, so a
// Markdown code span in it isn't read as escapes. With `reservedLess`, null if a `<` starting a word is read outside a
// string or comment (other than one starting `<#`, or after `--%` on its line): the shell won't run the command.
// Linear in the command's length.
function unescapedCommand(command, options) {
  const { escape, singleQuotes, doubleEscapes, dollarQuotes, unicodeEscapes, lineReset } = options;
  const wordEnds = options.wordEnds || /[\s;&|(]/;
  let out = "";
  let quote = "";
  let comment = "";
  let wordStart = true;
  let braces = 0;
  let shifts = 0;
  let opener = "";
  let shiftBraces = 0;
  let maybeComment = false;
  let commentText = false;
  let maybeBlock = false;
  // With `heldQuotes`, where a quote `lineReset` ended at a line break would close if it ran on: up to there, its text
  // is kept as written, as the reading without `lineReset` keeps it in the quote.
  let quoteAt = -1;
  let heldEnd = -1;
  const heldFails = { "'": Infinity, '"': Infinity };
  // After PowerShell's `--%`, the rest of the line (to a `|`) is passed on as written, `<` and all.
  let stopParsing = false;
  let starts = null;
  let hereDocs = [];
  // The commands and variables open in a double quote (and those open in them), innermost last, each with its closer,
  // how deep its own brackets are, the quote it returns to and the reading's state outside it. Bash ends a `${...}` at
  // its first `}` that isn't another `${...}`'s.
  const nested = [];
  let arithmeticNests = 0;
  let bracedFails = Infinity;
  // Where the next character is, past any escaped line breaks Bash takes out before it reads a word.
  const past = (at) => {
    let next = at;
    while (escape === "\\" && command[next] === "\\") {
      if (command[next + 1] === "\n") next += 2;
      else if (command[next + 1] === "\r" && command[next + 2] === "\n") next += 3;
      else break;
    }
    return next;
  };
  // A word's first six characters, past escaped line breaks, to tell a keyword (`ca\` then `se` is `case`).
  const wordAt = (at) => {
    let word = "";
    for (let next = past(at); next < command.length && word.length < 6; next = past(next + 1)) {
      if (/[\s;&|()<>]/.test(command[next])) break;
      word += command[next];
    }
    return word;
  };
  const arrayWord = /\(\(|\[|[A-Za-z_]\w*(?:\[|\+?=\()/y;
  const arrayStart = (at) => {
    arrayWord.lastIndex = at;
    return arrayWord.exec(command);
  };
  // Where the quote opened at `quoteAt` closes from `start` on (a here-string's at its `'@` line), or -1. A search
  // that finds none is remembered, so this stays linear.
  const quoteEnd = (mark, start) => {
    if (start >= heldFails[mark]) return -1;
    let end = -1;
    if (command[quoteAt - 1] === "@" && !/\S/.test(command.slice(quoteAt + 1, start - 1))) {
      const closing = new RegExp(`\\n[^\\S\\r\\n]*${mark}@`, "g");
      closing.lastIndex = start - 1;
      const found = closing.exec(command);
      end = found ? closing.lastIndex - 2 : -1;
    } else if (mark === "'") end = command.indexOf("'", start);
    else {
      for (let next = start; next < command.length && end < 0; next += 1) {
        if (command[next] === escape) next += 1;
        else if (command[next] === mark) end = next;
      }
    }
    if (end < 0) heldFails[mark] = start;
    return end;
  };
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at];
    const lineBreak = char === "\n" || char === "\r";
    if (lineBreak) maybeComment = commentText = stopParsing = false;
    if (heldEnd >= 0 && at >= heldEnd) {
      const closing = at === heldEnd;
      heldEnd = -1;
      if (closing) {
        out += char;
        wordStart = Boolean(options.quotesEndWords);
        continue;
      }
    }
    if (maybeBlock && char === ">" && command[at - 1] === "#") maybeBlock = false;
    if (comment === "line" && (options.commentEnds || /[\r\n]/).test(char)) comment = "";
    if (comment === "line") {
      out += char;
      continue;
    }
    if (comment) {
      if (char === ">" && command[at - 1] === "#") {
        comment = "";
        wordStart = true;
      }
      continue;
    }
    if (lineReset && quote && lineBreak) {
      if (options.heldQuotes && !nested.length) heldEnd = quoteEnd(quote, at + 1);
      out += quote;
      quote = "";
    }
    if (char === "\n" && !quote && hereDocs.length) {
      if (!starts) starts = lineStarts(command);
      const end = hereDocsEnd(command, at + 1, hereDocs, starts);
      hereDocs = [];
      if (end >= 0) {
        out += "\n";
        at = end - 1;
        wordStart = true;
        continue;
      }
    }
    if (quote === "'") {
      out += char;
      if (char === "'") {
        quote = "";
        wordStart = Boolean(options.quotesEndWords);
      }
      continue;
    }
    if (char === escape && at + 1 < command.length && (!quote || doubleEscapes?.test(command[at + 1]))) {
      at += 1;
      const next = command[at];
      if (next === "\r" && command[at + 1] === "\n") at += 1;
      if (next === "\r" || next === "\n") {
        // With `lineReset`, an escaped line break in a quote, or after a `#` that may start a comment, where the
        // escape would be the comment's own text, ends the line too, so a quote or comment Guard misreads can't take in
        // the next line.
        if (lineReset && (quote || maybeComment)) {
          out += `${quote}\n`;
          quote = "";
          maybeComment = false;
          wordStart = true;
        }
        commentText = false;
        continue;
      }
      // After a `#` (not in `${...}`) or `<#` that may start a comment, up to the line's end or `#>`, an escape is kept
      // as written, as the reading with comments read keeps a comment's text, so a Markdown code span there
      // (`` # see `.env.example` docs ``) isn't read as escapes.
      if (!quote && (commentText || maybeBlock || heldEnd >= 0)) {
        out += escape + next;
        wordStart = false;
        continue;
      }
      const code = unicodeEscapes && next === "u" && /^\{([0-9a-f]{1,6})\}/i.exec(command.slice(at + 1, at + 9));
      const value = code ? parseInt(code[1], 16) : -1;
      const text = code ? (value <= 0x10ffff ? String.fromCodePoint(value) : "") : next;
      if (code) at += code[0].length;
      // In double quotes the text is kept as it is; a quote there is left out, as Guard's reading of words can't hold
      // one inside another.
      if (quote) out += text.replace(/"/g, "");
      else out += [...text].map(literalCharacter).join("");
      wordStart = false;
      continue;
    }
    // Bash's backtick runs to the next backtick an escape doesn't take, whatever quotes are in it (see backtickCommand),
    // and what it holds is read as a command of its own.
    if (options.backticks && char === "`") {
      const { text, end } = backtickCommand(command, at + 1, quote === '"');
      const inner = /[\\'"`$#({<]/.test(text)
        ? unescapedCommand(text, { ...options, hereDocs: false, closeQuotes: true })
        : text;
      out += `\`${inner}\``;
      at = end;
      wordStart = !quote;
      continue;
    }
    // PowerShell's `${...}` is a variable's name, whatever is in it up to a `}` its backtick doesn't take (`${'}`).
    if (options.bracedVariables && char === "$" && command[at + 1] === "{" && at + 2 < bracedFails) {
      const close = bracedVariableEnd(command, at + 2);
      if (close < 0) bracedFails = at + 2;
      else {
        out += `\${${command.slice(at + 2, close).replace(/[^\w:\\/.~-]/g, "_")}}`;
        at = close;
        wordStart = false;
        continue;
      }
    }
    const nest = nested[nested.length - 1];
    // Bash takes out an escaped line break before it reads `$(` or `${` (`$\` then `(` on the next line).
    const second = char === "$" ? past(at + 1) : at;
    // In a command or variable a double quote holds, a `$` with one of Bash's special names (`$$(`) is read as outside
    // any quote (below), not as one that opens a command.
    const special = !quote && nest && char === "$" && /[$#?!@*0-9-]/.test(command[second] ?? "");
    if (!quote && nest && char === nest.closer && !nest.depth && nest.cases[nest.cases.length - 1] !== "pattern") {
      nested.pop();
      ({ braces, shifts, opener, shiftBraces, hereDocs } = nest.saved);
      if (nest.arithmetic) arithmeticNests -= 1;
      quote = nest.back;
      out += char;
      wordStart = !quote && wordEnds.test(char);
      continue;
    }
    const opening =
      !special && char === "$" && (quote === '"' || (!quote && nest)) && options.nests?.exec(`$${command[second]}`);
    if (opening) {
      const closer = command[second] === "(" ? ")" : "}";
      const saved = { braces, shifts, opener, shiftBraces, hereDocs };
      const arithmetic = closer === ")" && command[past(second + 1)] === "(";
      nested.push({ closer, back: quote, depth: 0, saved, arithmetic, cases: [], command: true, patternStart: false });
      if (arithmetic) arithmeticNests += 1;
      braces = closer === "}" ? braces + 1 : 0;
      shifts = 0;
      hereDocs = [];
      quote = "";
      out += opening[0];
      at = second;
      wordStart = closer === ")";
      continue;
    }
    if (quote) {
      out += char;
      if (char === '"') {
        quote = "";
        wordStart = Boolean(options.quotesEndWords);
      }
      continue;
    }
    // With `cases`, a `case` in a command a double quote holds is read as Bash parses it, its patterns' `)` (`a)`)
    // not ending the command: shellSpellings adds this reading, as Guard can't always tell `case` is a keyword. Bash
    // takes `case` as a keyword where a command starts, `in` as the word after its subject, and `esac` where a pattern
    // or a command starts.
    if (options.cases && nest?.closer === ")") {
      const { cases } = nest;
      const state = cases[cases.length - 1];
      if (wordStart && !/[\s;&|()<>]/.test(char)) {
        const word = wordAt(at);
        if (state === "subject") cases[cases.length - 1] = "in";
        else if (state === "in" && word === "in") {
          cases[cases.length - 1] = "pattern";
          nest.patternStart = true;
        } else if (state === "pattern" && nest.patternStart && word === "esac") cases.pop();
        else if (state === "pattern") nest.patternStart = false;
        else if (nest.command && word === "case") cases.push("subject");
        else if (nest.command && state === "body" && word === "esac") cases.pop();
        nest.command = nest.command && /^(?:if|then|else|elif|do|while|until|time|!|\{)$/.test(word);
      } else if (
        state === "pattern" &&
        !nest.depth &&
        (char === ")" || (char === "(" && !/[@!?*+]/.test(command[at - 1])))
      ) {
        // A pattern's `)`, or the `(` it may start with (`(a)`); an extglob's `@(...)` is counted.
        if (char === ")") {
          cases[cases.length - 1] = "body";
          nest.command = true;
        }
        nest.patternStart = false;
        out += char;
        wordStart = true;
        continue;
      } else if (/[;&|\n(]/.test(char)) {
        nest.command = true;
        if (state === "body" && char === ";" && /[;&]/.test(command[at + 1] ?? "")) {
          cases[cases.length - 1] = "pattern";
          nest.patternStart = true;
        }
      }
    }
    if (nest?.closer === ")" && char === ")") nest.depth -= 1;
    else if (nest?.closer === ")" && char === "(") nest.depth += 1;
    // Where Bash reads `<<` as a shift, not a here-doc: `$((...))`, `((...))` (also after `if` or `for`), `$[...]`, an
    // array's subscript (`a[1<<2]=3`) and a list assigned to one (`a=([1<<2]=3)`). Each runs to its closing bracket,
    // not counting one in a `${...}` it holds.
    const shift =
      options.hereDocs &&
      !shifts &&
      (/^\$\(\(|^\$\[|^\(\(/.exec(command.slice(at, at + 3)) || (wordStart && arrayStart(at)));
    if (shift) {
      opener = shift[0].slice(-1);
      shifts = opener === "(" && /\(\($/.test(shift[0]) ? 2 : 1;
      shiftBraces = braces;
      out += shift[0];
      at += shift[0].length - 1;
      wordStart = opener === "(";
      continue;
    }
    if (shifts && braces === shiftBraces && char === opener) shifts += 1;
    else if (shifts && braces === shiftBraces && char === (opener === "(" ? ")" : "]")) shifts -= 1;
    // A `$` with one of Bash's special names (`$$`, `$#`) isn't a `${` or a comment's `#`.
    if (char === "$" && /[$#?!@*0-9-]/.test(command[at + 1] ?? "")) {
      out += char + command[at + 1];
      at += 1;
      wordStart = false;
      continue;
    }
    if (options.comments && char === "#" && wordStart && !braces) {
      comment = "line";
      out += char;
      continue;
    }
    if (options.blockComments && char === "<" && command[at + 1] === "#" && wordStart) {
      comment = "block";
      out += " ";
      at += 1;
      continue;
    }
    if (options.hereDocs && !shifts && !braces && !arithmeticNests && char === "<" && command[at + 1] === "<") {
      // `<<<` is a here-string, its word on the same line.
      if (command[at + 2] === "<") {
        out += "<<<";
        at += 2;
        wordStart = true;
        continue;
      }
      let start = at + 2;
      const tabs = command[start] === "-";
      if (tabs) start += 1;
      while (command[start] === " " || command[start] === "\t") start += 1;
      if (start < command.length && !/[\n;&|()<>]/.test(command[start])) {
        const { word, end } = hereDocWord(command, start);
        hereDocs.push({ word, tabs });
        out += `<<${tabs ? "-" : ""}${[...word.replace(/\s/g, "_")].map(literalCharacter).join("")}`;
        at = end - 1;
        wordStart = false;
        continue;
      }
    }
    if (
      options.hereStrings &&
      char === "@" &&
      wordStart &&
      /^['"][^\S\r\n]*\r?\n/.test(command.slice(at + 1, at + 80))
    ) {
      const closing = new RegExp(`\\n[^\\S\\r\\n]*${command[at + 1]}@`, "g");
      closing.lastIndex = at + 2;
      const found = closing.exec(command);
      out += command[at + 1].repeat(2);
      at = found ? closing.lastIndex - 1 : command.length;
      wordStart = false;
      continue;
    }
    if (dollarQuotes && char === "$" && command[at + 1] === "'") {
      const { text, end } = ansiCQuoted(command, at + 2);
      out += `'${text.split("'").join(`'"'"'`)}'`;
      at = end;
      wordStart = false;
      continue;
    }
    if (dollarQuotes && char === "$" && command[at + 1] === '"') continue;
    // Where both shells surely start a token, so a `#` there starts a comment and PowerShell's `<` is an error: not
    // after `=` or `,`, the `)` of `$(...)` or a backtick, where it's part of a word (`a=#x`, `$(echo a)#x`, `a<b`).
    const tokenStart = at === 0 || /[\s;&|({]/.test(command[at - 1]);
    if (char === "<" && command[at + 1] === "#" && wordStart && tokenStart && escape === "`") maybeBlock = true;
    if (options.reservedLess && wordStart && char === "-" && /^--%(?![^\s|])/.test(command.slice(at, at + 4))) {
      stopParsing = true;
    } else if (char === "|") stopParsing = false;
    if (options.reservedLess && char === "<" && command[at + 1] !== "#" && tokenStart && !stopParsing && heldEnd < 0) {
      return null;
    }
    if (char === "$" && command[at + 1] === "{") braces += 1;
    else if (char === "}" && braces) braces -= 1;
    // A quote after a `#` or `<#` that may start a comment, or in a held quote's text, is kept as text, and opens
    // nothing.
    if ((char === '"' || (singleQuotes && char === "'")) && !commentText && !maybeBlock && heldEnd < 0) {
      quote = char;
      quoteAt = at;
    }
    if (char === "#" && wordStart && options.commentEnds) maybeComment = true;
    if (char === "#" && wordStart && tokenStart && !braces && options.commentEnds) commentText = true;
    out += char;
    wordStart = wordEnds.test(char);
  }
  // With `closeQuotes` (a backtick's command), a quote or a command still open at the end is closed, so the command
  // around it keeps its words.
  if (options.closeQuotes) {
    out += quote;
    for (let index = nested.length - 1; index >= 0; index -= 1) out += nested[index].back;
  }
  return out;
}

// A command's words as they run: a variable inside a word (`.e${X}nv`, `.e%X:~0,0%nv`) read as empty, as one that's
// unset or cut to nothing is, or with `defaults`, a Bash variable's default or alternative value put in its place
// wherever it is (`${X:-n}`, `${X:=n}`, `${X:+n}`), and a command's own name without its quotes (`'cat' .env`,
// `c''at`, PowerShell's `& 'gc' .env`), so the reader is found. A variable that is a whole word, or starts a path, is
// otherwise kept: what it holds isn't known (see shellReplacesPart). Each match is bounded, so this is linear.
function wordsAsRun(command, defaults = false) {
  const variables = defaults
    ? command.replace(/\$\{[A-Za-z_]\w{0,63}:?[-=+]([^{}$\s]{0,256})\}/g, "$1")
    : command.replace(
        /(?<=[^\s"'/\\;&|<>()`=$%{}])(?:\$\{[^{}$\s]{0,256}\}|\$[A-Za-z_]\w*(?::[A-Za-z_]\w*)?|%[^%\s]{1,256}%)(?=[^\s/;&|<>()`])/g,
        "",
      );
  return variables.replace(
    /(^|[;&|(`\r\n\u2028\u2029])([^\S\r\n]*)(?:[&.][^\S\r\n]+)?((?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"';&|()`<>])+)/g,
    (whole, start, space, word) => (/["']/.test(word) ? start + space + word.replace(/["']/g, "") : whole),
  );
}

// The other ways a command may be spelled for the shells that could run it (`kind`: Claude Code's Bash tool is
// "bash", its PowerShell tool "powershell", and Cursor's shell, which may be either, "any"): with Bash's escapes and
// quoting read, with PowerShell's, and with cmd's, which any of them can start, each also with quotes ended at line
// breaks, and Bash's and PowerShell's each also with their comments, here-docs and here-strings read (see
// unescapedCommand). PowerShell's reading also takes its curly quotes and dashes for plain ones, splits a parameter's
// value written after a colon (`-Path:.env`) into a word of its own and drops a provider's name before a path
// (`FileSystem::C:\...`). cmd's reading takes off the quotes `cmd /c "..."` drops before it reads carets. Each spelling
// is also read with its words as they run (see wordsAsRun). Each is checked as well as the command as written, never
// instead.
function shellSpellings(command, kind) {
  const spellings = [command];
  const add = (spelling) => {
    if (!spellings.includes(spelling)) spellings.push(spelling);
  };
  const lines = /[\r\n]/.test(command);
  // Each shell's escapes are read plainly, and where the command may have a comment, a here-doc or a here-string, also
  // with those read, so a misreading of one can't hide what the plain reading sees. Where a Bash command a double quote
  // holds may have a `case`, each is also read with its patterns' `)` (see unescapedCommand).
  const spell = (text, escapes, after = (each) => each) => {
    const plain = { ...escapes, comments: false, blockComments: false, hereDocs: false, hereStrings: false };
    const readings = escapes.comments && /#|<<|@['"]/.test(text) ? [plain, escapes] : [plain];
    const joined = escapes === SHELL_ESCAPES.bash && text.replace(/\\\r?\n/g, "");
    if (joined && /case/.test(joined) && /\$\(/.test(joined)) {
      readings.push(...readings.map((options) => ({ ...options, cases: true })));
    }
    for (const options of lines ? readings.flatMap((each) => [each, { ...each, lineReset: true }]) : readings) {
      const spelling = unescapedCommand(text, options);
      if (spelling !== null) add(after(spelling));
    }
  };
  if (kind !== "powershell" && /[\\$#]/.test(command)) spell(command, SHELL_ESCAPES.bash);
  if (kind !== "bash" && /[`:#\u2013-\u2015\u2018-\u201e]/.test(command)) {
    const plain = command
      .replace(/[\u2018-\u201b]/g, "'")
      .replace(/[\u201c-\u201e]/g, '"')
      .replace(/[\u2013-\u2015]/g, "-");
    spell(plain, SHELL_ESCAPES.powershell, (each) =>
      each
        .replace(/(^|[\s;(|&])(-[A-Za-z][\w-]*):(?=[^\s:])/g, "$1$2 ")
        .replace(/(^|[\s,;(|&'"=:])(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/gi, "$1"),
    );
  }
  if (command.includes("^")) {
    spell(
      command.replace(/(\bcmd(?:\.exe)?["']?[^\S\r\n]+\/[ckr][^\S\r\n]+)"([^\r\n]*)"/gi, "$1$2"),
      SHELL_ESCAPES.cmd,
    );
  }
  for (const spelling of [...spellings]) {
    add(wordsAsRun(spelling));
    if (/\$\{[A-Za-z_]\w*:?[-=+]/.test(spelling)) add(wordsAsRun(spelling, true));
  }
  return spellings;
}

// A recursive read's target, then the same target at each drive path it opens: a device path to a drive (see
// localDevicePaths), a drive's share (judged by name unless it's this computer's, see driveSharePaths) and a folder
// Windows tidies (see windowsTidiedPaths).
function drivePathTargets(target, cwd, budget) {
  // The path as an operand's check names it (see isSecretOperand), so what that check worked out is used again.
  const written = target.path.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  const devices = localDevicePaths(written) || [];
  const { shares, tidied } = devices.length ? { shares: [], tidied: [] } : drivePathsOf(written, cwd, budget);
  if (!devices.length && !shares.length && !tidied.length) return [target];
  return [
    target,
    ...devices.map((drivePath) => ({ ...target, path: drivePath })),
    ...shares.map((item) => ({ ...target, path: item.drive, nameOnly: !item.loopback })),
    ...tidied.map((drivePath) => ({ ...target, path: drivePath })),
  ];
}

// What a copy reads: every operand but the last, the destination, unless -t names the destination instead. For cp,
// `lastIsSource(last)` says the last word is read too (see copyLastIsSource). cmd's copy, given false, reads a wildcard
// there as a pattern for the new names.
function copySources(parsed, lastIsSource = false) {
  if (parsed.has("t", "target-directory") || parsed.operands.length < 2) return parsed.operands;
  const last = parsed.operands[parsed.operands.length - 1];
  return lastIsSource && lastIsSource(last) ? parsed.operands : parsed.operands.slice(0, -1);
}

// cp's last word is a glob the shell expands first, so `cp -r src qqdata/*` copies every folder it matches but the
// last into that one. It's read as files copied too unless Guard can list what it matches, as Bash will (see
// SOLE_JOIN_READER_CALL), and finds one path or none: then Bash hands cp one destination, the path or the glob itself.
// Only for a glob of `*` and plain letters, which Guard matches the way Bash does, and so finds every path Bash can
// (without regard to case, so more if anything): not a `?`, which is one byte in the C locale, a class or brace list,
// a `!`, one of `:<>|`, which Git Bash keeps as other letters in a name, or a name starting with `.`, which Bash also
// matches to `.` and `..`. Nor for a path from the root: Git Bash's `/` and /tmp are its own folders, not the ones
// Node finds there, or one with a `..` part, which Bash takes from where a link before it leads, or when a path it
// finds ends in `.lnk`, which may be a link Git Bash made (see firstReadingWords). The first reading keeps a quoted
// word's quotes, and `'id*'` is no glob.
function copyLastIsSource(last, cwd, shellGlobs) {
  if (/^(["']).*\1$/s.test(last) || !/[*?[]/.test(last)) return false;
  if (!shellGlobs?.joinable || /^\/|[?[\]{}!:<>|~$`\\\0-\x1f]|(?:^|\/)\.(?:[^/]*$|\.\/)/.test(last)) return true;
  const matches = expandShellGlob(last, cwd, shellGlobs);
  return matches === null || matches.length > 1 || matches.some((match) => /\.lnk$/i.test(match));
}

// The folder a reader opens for an absolute path on Windows, which tidies it as localDevicePaths says: a part's one
// last dot dropped (`secrets.` opens `secrets`), and the last part's dots and spaces. Node looks a path up as written,
// so `secrets.` would be no folder to it. Elsewhere the path is opened as it is.
function windowsOpenedPath(absolutePath) {
  if (process.platform !== "win32") return absolutePath;
  const { root } = path.parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(path.sep);
  const tidied = parts.map((part, index) => {
    if (index === parts.length - 1) return trimEndOf(part, ". ") || part;
    return part.endsWith(".") && !part.endsWith("..") ? part.slice(0, -1) : part;
  });
  return root + tidied.join(path.sep);
}

// The folders a recursive reader could open for an absolute path: as written, which Git Bash's grep, cp and diff open,
// and on Windows as Windows tidies it (see windowsOpenedPath), which findstr and rg.exe open. Both are walked.
function openedFolders(absolutePath) {
  const tidied = windowsOpenedPath(absolutePath);
  return tidied === absolutePath ? [absolutePath] : [absolutePath, tidied];
}

// What makes one recursive read the same as another: the same reader, path and filters walk the same files.
const recursiveTargetKeys = new WeakMap();
function recursiveTargetKey(reader, target) {
  const describe = (value) => {
    if (!value || typeof value !== "object") return "";
    if (!recursiveTargetKeys.has(value)) recursiveTargetKeys.set(value, JSON.stringify(value));
    return recursiveTargetKeys.get(value);
  };
  return [
    reader,
    target.path,
    target.glob || "",
    target.literal ? 1 : 0,
    target.nameOnly ? 1 : 0,
    describe(target.filters),
  ]
    .concat(describe(target.reachability))
    .join("\u0000");
}

// Walks each folder a recursive reader reads all of (see recursiveReadTargets), dotfiles included unless the reader
// skips them. A broad glob is expanded first, the way the shell will, and each folder it matches is walked; a glob
// Guard can't expand (after a `cd`, say) is judged by the secret names it could match. A target named again is checked
// once, and a folder walked once (see findSecretInSearchTree). A folder, or a glob's folders, that the walk's budget
// can't read in full stops the command unless its name already does: a big tree, or one padded on purpose, mustn't let
// a secret file deeper down through. Past the check's lookups a folder is still walked.
function secretInRecursiveRead(targets, reader, cwd, shell) {
  const { budget } = shell;
  const name = reader.toLowerCase();
  for (const target of targets.flatMap((item) => drivePathTargets(item, cwd, budget))) {
    const filePath = target.path.replace(/\\/g, "/");
    const expands = !target.literal && /[*?[]/.test(filePath);
    // A path already found to hold nothing, or no folder, has nothing below it to read, unless it's named as a
    // credentials folder (see secretFolderByName) through a part the shell replaces (see shellReplacesPart): the shell
    // opens that by another path (`$SOMEWHERE/.kube`). Named outright (`grep -r x gh`), it opens nothing.
    if (
      !expands &&
      openedFolders(path.resolve(cwd, filePath)).every((each) => budget.directories.get(each) === false)
    ) {
      if (shellReplacesPart(filePath) && secretFolderByName(filePath, cwd)) return filePath;
      continue;
    }
    const key = recursiveTargetKey(name, target);
    if (budget.targets.has(key)) continue;
    budget.targets.add(key);
    checkShellDeadline(budget);
    const glob = target.glob || (expands ? target.path : null);
    const byName = (folder) => {
      budget.byName += 1;
      if (glob) return globSecretByName(glob, budget) || globNamesSecretFolder(glob) ? glob : null;
      // A credentials folder (`.kube`) is read for what it holds, which its own name doesn't say.
      if (secretFolderByName(folder, cwd)) return folder;
      // An operand the reader's own check already cleared needs no second look at its name.
      if (budget.verdicts.get(`shell\u0000${folder}`) === false) return null;
      return secretByName(folder, cwd, budget) ? folder : null;
    };
    // A folder on another computer is judged by its name too (see isRemotePath).
    if (target.nameOnly || walkSpent(budget) || remoteLocation(filePath, cwd)) {
      const found = byName(filePath);
      if (found) return found;
      // So is the reader's own filter that names a credentials folder below it (`rg -g '.kube/*'`) or a secret file
      // (`--glob=.env`, `--include=*.pem`), or a file type it adds those globs to (`--type-add 'k:.env*' -tk`).
      const filter = [...(target.filters?.include || []), ...(target.filters?.typeGlobs || [])].find(
        (pattern) => globNamesSecretFolder(pattern, { whole: true }) || filterNamesSecret(pattern),
      );
      if (filter) return path.posix.join(filePath, filter);
      // Only a folder on another computer is left unwalked; past the walk's budget the command is stopped.
      if (!remoteLocation(filePath, cwd)) stopIfSpent(budget);
      continue;
    }
    // A glob judged only by its name before, `ke*` or `*/`, still is; its folders are walked as well.
    if (expands && !broadShellGlob(filePath) && glob && globSecretByName(glob, budget)) return glob;
    const folders = expands
      ? (expandShellGlob(filePath, cwd, shell, true) ?? expandFolderGlob(filePath, cwd, shell, true))
      : [filePath];
    // A glob through a part the shell replaces matches nothing here, so its name is all there is (`$SOMEWHERE/.kub?`).
    if (expands && !folders?.length && shellReplacesPart(filePath) && globNamesSecretFolder(filePath)) {
      return filePath;
    }
    if (!folders) {
      budget.byName += 1;
      if (glob && globSecretByName(glob, budget)) return glob;
      continue;
    }
    for (const folder of folders) {
      // Past the lookups a folder still costs one, as an operand does (see secretPastLookups), and is still walked: the
      // walk's own budget and the check's deadline bound what's left.
      checkShellDeadline(budget);
      const opened = openedFolders(path.resolve(cwd, folder));
      for (const directory of opened) {
        if (!budget.directories.has(directory)) {
          budget.lookups -= 1;
          budget.directories.set(directory, isDirectoryTarget(directory, cwd));
        }
      }
      // As above, a credentials folder named but not there is judged by its name.
      if (
        !expands &&
        opened.every((each) => !budget.directories.get(each)) &&
        shellReplacesPart(folder) &&
        secretFolderByName(folder, cwd)
      ) {
        return folder;
      }
      for (const directory of opened) {
        if (!budget.directories.get(directory)) continue;
        const started = Date.now();
        const found = findSecretInSearchTree(directory, target.filters, "shell", name, target.reachability || {}, {
          budget,
        });
        // The walk's time is given back to the lookups after it (all inside the check's own deadline), so a path named
        // after a big folder is still looked up rather than stopping the command.
        budget.lookupDeadline += Date.now() - started;
        if (found.file) return path.posix.join(folder, found.file);
        if (found.limited) {
          if (glob && globSecretByName(glob, budget)) return glob;
          // The walk has the path check's whole time, so one cut short by that deadline says so too.
          throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
        }
      }
    }
  }
  return null;
}

function inspectShell(tool, event, options = {}) {
  const claudeShell = tool === "claude" && ["Bash", "PowerShell"].includes(event?.tool_name);
  if ((tool !== "claude" && tool !== "cursor") || (tool === "claude" && !claudeShell)) {
    return { action: "allow" };
  }
  const command = tool === "cursor" ? event?.command : event?.tool_input?.command;
  if (typeof command !== "string") return { action: "allow", internalError: true };
  const fallbackCwd = options.cwd || process.cwd();
  const cwd = tool === "cursor" ? event.cwd || fallbackCwd : event?.tool_input?.cwd || fallbackCwd;
  const environmentDumps =
    /(?:^|[;&|\n])[^\S\r\n\u2028\u2029]*(?:export(?=\s*(?:[;&|\n]|$))|(?:declare|typeset|export)\s+-p\b|env(?:\s+-0)?(?=\s*(?:[;&|\n]|$))|printenv(?:\s+[^;&|\n]+)?|set(?=\s*(?:[;&|\n]|$))|(?:Get-ChildItem|Get-Item|gci|ls|dir)\s+(?:-(?:Literal)?Path\s+)?Env:)/im;
  // .NET hands PowerShell the whole environment from inside any expression, not only at a command start.
  if (environmentDumps.test(command) || /\[(?:System\.)?Environment\]::GetEnvironmentVariables\b/i.test(command)) {
    return { action: "block", secretFile: true, boundary: "shell", location: "the environment" };
  }

  // A reader can also start a subshell, `$(cat .env)` or a backtick, so those openers count as command starts and
  // their closers end the arguments. The blank space before a reader, and after a wrapper word such as `time`, stops at
  // a line break, where `^` starts over: spaces or line breaks that more than one start could take made a long run
  // cost seconds per check.
  // The hook's whole check, counted from when the hook started (`startedAt`, a Date.now() time), has one deadline: the
  // path check stops by it as well as by its own, and the content check gets what's left.
  const deadline = (options.startedAt ?? Date.now()) + (options.hookCheckMaxMs ?? HOOK_CHECK_MAX_MS);
  // The content check's .clotrignore is found first, since finding Git looks in each PATH folder: those lookups come
  // out of the path check's, so a long PATH can't take the check past its lookups.
  const gitLookups = { count: 0 };
  const repositoryIgnoreFile = repositoryIgnore(cwd, gitLookups) ?? { root: null, config: parseClotrIgnore("") };
  const budget = shellWalkBudget(options);
  budget.lookups -= gitLookups.count;
  budget.checkDeadline = Math.min(budget.checkDeadline, deadline);
  budget.walkDeadline = Math.min(budget.walkDeadline, budget.checkDeadline);
  // A command run as another user can read a folder this account can't, so the walk can't pass such a folder over.
  budget.elevated = /(?:^|[;&|(`\s])(?:sudo|doas|gsudo|runas|pkexec|su)(?=\s|$)|-Verb\s+RunAs\b/im.test(command);
  const shellGlobs = {
    // Bash's `*` skips dotfiles unless the command turns that off; Cursor's shell may be PowerShell, whose `*` doesn't.
    posix: tool === "claude" && event.tool_name === "Bash" && !/dotglob|globdots|GLOBIGNORE/i.test(command),
    staysInFolder: !/(?:^|[;&|(`\s])(?:cd|pushd|chdir|Set-Location|Push-Location|sl)(?=\s|$)/im.test(command),
    // Claude Code's Bash tool runs Git Bash on Windows, which opens `/c/Users/...` as `C:\Users\...` (see pathReadings).
    gitBash: tool === "claude" && event.tool_name === "Bash",
    // The shells that could run the command, for their escapes and quoting (see shellSpellings).
    kind: tool === "cursor" ? "any" : event.tool_name === "Bash" ? "bash" : "powershell",
    // Bash's own paths for a glob are the ones Guard lists (see SOLE_JOIN_READER_CALL).
    joinable: tool === "claude" && event.tool_name === "Bash" && SOLE_JOIN_READER_CALL.test(command),
    budget,
  };
  // Claude says which of its shells runs the command. Cursor runs the user's terminal: Bash's rules or PowerShell's,
  // and cmd's when the command has its escape. Where cmd would split inside a single quote, each reader's words are
  // also read as Guard first read them, which splits there too but keeps a quote that starts a word whole, so a
  // switch's quoted value (--include='*.js') and a quoted pattern stay one word each.
  const cmd = tool === "claude" ? { caret: false, midWord: false } : cmdReadsDifferently(command);
  const dialects =
    tool === "claude"
      ? [event.tool_name === "PowerShell" ? "powershell" : "bash"]
      : ["bash", "powershell", ...(cmd.caret ? ["cmd"] : [])];
  // The command is read as the shell splits it, and also as Guard's first shell check read it, and either finding a
  // secret file stops it: a reading that splits differently can't let through what the first one stopped. One that
  // fails doesn't keep the other from running. The first reading runs first, on the whole walk budget as it always
  // had, so the shell's reading can't spend what it needs to walk the folders it names; the shell's reading gets what's
  // left. Once one finds a file the others don't run, so a path the shell's reading spells another way (a device path's
  // `\\` read as Bash's escape) isn't looked up after the first reading stopped the command unlooked-up. The first reading
  // takes cp's last word as where it copies to, as it always did; it's read once more with that word's glob as files
  // cp copies too (see copyLastIsSource) after the others, so walking it can't spend what they need.
  // `options.shellReading` "new" or "first" runs only one, for tests.
  const bash = tool === "claude" && event.tool_name === "Bash";
  const firstReading = () => secretInShellReads(command, cwd, shellGlobs, bash);
  const newReading = () => secretInParsedShell(command, cwd, shellGlobs, dialects, cmd.midWord);
  const copyLastReading = () =>
    /\bcp\b/i.test(command) ? secretInShellReads(command, cwd, shellGlobs, bash, true) : null;
  const readings =
    options.shellReading === "new"
      ? [newReading]
      : options.shellReading === "first"
        ? [firstReading, copyLastReading]
        : [firstReading, newReading, copyLastReading];
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
    // A name the first reading took whole from a quote, `'.env'`, is shown without its quotes, as the shell opens it.
    const shown = typeof found === "string" && /^(['"])[^'"]+\1$/.test(found) ? found.slice(1, -1) : found;
    if (found) return { action: "block", secretFile: true, boundary: "shell", location: shown };
  }
  if (failed) return { ...SHELL_FAILED_OUTCOME };
  let outcome;
  try {
    outcome = inspectText(tool, command, {
      ...options,
      cwd,
      key: "tool",
      repeat: false,
      deadline,
      repositoryIgnoreFile,
    });
  } catch {
    return { ...SHELL_FAILED_OUTCOME };
  }
  if (outcome.unfinished) return { ...SHELL_UNFINISHED_OUTCOME };
  return outcome.internalError ? { ...SHELL_FAILED_OUTCOME } : outcome;
}

// A reader's words without anything that looks like a redirection (`2>/dev/null`, `> out.txt`, `2>&1`, `&>log`,
// PowerShell's `2>$null` and `*>&1`), and a target in a word of its own after one; with `input` false, an input
// redirection (`< f`, `0<f`, `<<<`) is kept. This is a second reading of a reader's words, walked as well as the words
// as Guard always read them, never instead: what looks like a redirection reaches the reader as a word, or part of
// one, in some shell or wrapper (PowerShell's `0>` and `1<`, a quote, `eval`).
function withoutRedirections(args, { input = true } = {}) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const found = /^(?:\d+|\*|&)?(?:>>?|<)[&|]?/.exec(args[index]);
    if (!found || (!input && found[0].includes("<"))) kept.push(args[index]);
    else if (found[0] === args[index]) index += 1;
  }
  return kept;
}

// The words after a reader's words as Guard always read them (see firstReadingPass) when those end at a redirection
// of one stream to another or to a file (`2>&1`, `>&2`, `<&0`, `&>log`, `>|log`) rather than at the end of the command,
// up to the end of the line or the next `;`, `&`, `|`, `(`, `)` or backtick. They're only ever read as well as the
// reader's words, so the commands after them are still found as before.
function wordsPastRedirections(command, end) {
  let at = end;
  for (;;) {
    const unescaped = !/[\\^]/.test(command[at - 2] || "");
    const redirection =
      (command[at] === "&" && /[<>]/.test(command[at - 1] || "") && unescaped) ||
      (command[at] === "&" && command[at + 1] === ">") ||
      (command[at] === "|" && command[at - 1] === ">" && unescaped);
    if (!redirection) return command.slice(end, at);
    at += 1;
    while (at < command.length && !/[;&|()`\r\n\u2028\u2029]/.test(command[at])) at += 1;
  }
}

// The paths of a PowerShell list a word may name (see listedPaths): none in Git Bash, where a comma is part of a name.
function shellListedPaths(word, shellGlobs) {
  return shellGlobs.gitBash ? [] : listedPaths(word);
}

// Every path a word may open: as written, each path of a PowerShell list (see shellListedPaths), and each of those as
// the shell opens it (see pathReadings): `~/kj/config`.
function opensAs(word, shellGlobs) {
  const options = { gitBash: Boolean(shellGlobs.gitBash) };
  const each = [word, ...shellListedPaths(word, shellGlobs)];
  return [...new Set(each.flatMap((item) => [item, ...pathReadings(item, options)]))];
}

// Whether a reader's operand, as written or as any path it opens (see opensAs), is a secret file.
function secretOperandOpened(word, cwd, shellGlobs) {
  return opensAs(word, shellGlobs).some((reading) => isSecretOperand(reading, cwd, shellGlobs));
}

// The first secret file under the folders a recursive reader is given (see recursiveReadTargets), or null. A whole
// drive in Git Bash (`grep -r x /c`) is stopped by its name: walking it can't finish in time, and the letter may be a
// drive mapped to another computer, which Guard doesn't look up. A target named again (`rg x a a a ...`) is read once.
// Each folder of a PowerShell list is walked, and a folder under the home folder, or a Git Bash drive path, where the
// shell opens it (see opensAs).
function secretInReaderTargets(targets, reader, cwd, shellGlobs) {
  const driveRoot = shellGlobs.gitBash && targets.find((target) => gitBashDriveRoot(target.path));
  if (driveRoot) return driveRoot.path;
  const name = reader.toLowerCase();
  const unique = [...new Map(targets.map((target) => [recursiveTargetKey(name, target), target])).values()];
  const readingOptions = { gitBash: Boolean(shellGlobs.gitBash) };
  const withReadings = unique.flatMap((target) =>
    [target.path, ...shellListedPaths(target.path, shellGlobs)].flatMap((each, at) => {
      const base = at ? { ...target, path: each } : target;
      return [
        base,
        ...pathReadings(each, readingOptions).map((reading, index) => ({
          ...base,
          path: reading,
          glob: base.glob && (pathReadings(base.glob, readingOptions)[index] ?? base.glob),
        })),
      ];
    }),
  );
  return secretInRecursiveRead(withReadings, reader, cwd, shellGlobs);
}

// Where cmd could split a command that Bash and PowerShell don't. `caret`: a `^`, cmd's escape, outside quotes (inside
// them, as in grep '^import', it's a pattern's anchor). `midWord`: a single quote that opens mid-word, as in
// `type x' .env '`, whose blank space cmd splits at, since a single quote is a letter to cmd. One right after another
// quote, as in Bash's `'\''`, doesn't count. Each alternative starts with a different character, so the pattern can't
// backtrack. A handle copy with more after its digit (`<&1.env`, `>&2.env`), which cmd splits after the digit, counts
// as a `caret` too.
function cmdReadsDifferently(command) {
  let midWord = false;
  const bare = command.replace(/\\[^]|'[^']*'|"(?:[^"\\]|\\[^])*"/g, (quoted, at) => {
    if (quoted[0] === "'" && at > 0 && !/[\s;&|('"]/.test(command[at - 1])) midWord = true;
    return quoted[0] === "\\" ? quoted : " ";
  });
  return { caret: bare.includes("^") || /[<>]&\d[^\s;&|<>()]/.test(bare), midWord };
}

// The commands that read the files they're given, as the shell check knows them.
const SHELL_READER_NAMES =
  "cat|type|Get-Content|less|more|head|tail|grep|sed|awk|base64|xxd|strings|gc|cp|copy|source|tac|nl|od|hexdump|rev|paste|fold|cut|sort|uniq|diff|bat|Select-String|sls|findstr|rg";
const SHELL_READER_NAME = new RegExp(`^(?:${SHELL_READER_NAMES})$`, "i");
// A reader's name found anywhere a command could start, even inside quotes, where it may be the text of a nested shell
// such as `ssh host "x; cat .env"`; see secretInParsedShell for how its arguments are read. The match ends at the name,
// so the next search starts there and finds a reader inside this one's words too.
const SHELL_READER_AT = new RegExp(
  '(?:^|[;&|(`])[^\\S\\r\\n\\u2028\\u2029]*(?:(?:sudo|command|exec|nohup|time|env|cmd(?:\\.exe)?[^\\S\\r\\n\\u2028\\u2029]+\\/c)[^\\S\\r\\n\\u2028\\u2029]+"?)*(' +
    SHELL_READER_NAMES +
    ")\\b",
  "gim",
);
// Where Guard's first shell check ended a reader's words: at any of these, quoted or not.
const SHELL_OLD_STOPS = ";&|)`";
// Words before a command that run it as it is: `sudo cat`, `time cat`, `{ cat`, `if cat`.
const SHELL_WRAPPER_WORD = /^(?:sudo|command|exec|nohup|time|env|builtin|\{|!|if|then|else|elif|do|while|until)$/i;
// Shells that run the text they're given: the switch that names that text, and the quote rules it's read with.
const SHELL_INVOKERS = [
  { name: /^(?:ba|z|da|k|mk|a|fi)?sh$/i, dialect: "bash", run: /^-[A-Za-z]*c[A-Za-z]*$/ },
  { name: /^(?:pwsh|powershell)$/i, dialect: "powershell", run: /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i },
  { name: /^cmd$/i, dialect: "cmd", run: /^\/\/?[ckr]$/i },
  { name: /^wsl$/i, dialect: "bash", run: /^(?:-e|--exec|--)$/ },
  { name: /^eval$/i, dialect: null, run: null },
  { name: /^(?:iex|Invoke-Expression)$/i, dialect: "powershell", run: null },
];
// PowerShell's -EncodedCommand and its short forms, whose text is Base64 of UTF-16.
const POWERSHELL_ENCODED =
  /^[-/](?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)$/i;
// cmd's /c, /k or /r with other switches or its text glued on: `/d/c`, `/v:on/c`, `/ctype`, and Git Bash's `//ctype`
// (see CMD_SWITCHES). Anchored, and each repeat is one switch with any value up to the next `/`, so it can't backtrack
// more than the word is long.
const CMD_GLUED_RUN = /^(?:\/+[a-z](?::[^/\s]*)?)*?\/+[ckr]/i;
// A word of cmd switches alone, `/d`, `/d/c`, `/v:on/c`, and the ones ending in /c, /k or /r. Git Bash turns a leading
// `//c` into `/c` for a Windows program, and cmd reads `///c` as `/c` too, so any run of slashes counts.
const CMD_SWITCHES = /^(?:\/+[a-z](?::[^/\s]*)?)+$/i;
const CMD_RUN_LAST = /\/[ckr]$/i;
// How deep shells inside shells (`bash -c "pwsh -c '\u2026'"`) are read.
const SHELL_NEST_MAX = 4;
// cmd's `type` and `copy` glued to what they're given: `type.env`, `copy/b a b`.
const CMD_GLUED_READER = /^(type|copy)([^A-Za-z0-9].*)$/i;
// How many PowerShell groups inside groups, `gc (('.env'))`, pass their words up as the files a reader is given.
const SHELL_GROUP_DEPTH = 3;
// PowerShell commands whose words are a filter or a script, not paths: `(gci | ? Name -ne x)`.
const SHELL_FILTER_WORD = /^(?:\?|%|where|Where-Object|foreach|ForEach-Object|select|Select-Object)$/i;
// A filter's switches that hand it values: -InputObject, as short as PowerShell takes it, and -In.
const SHELL_FILTER_INPUT = /^-in(?:p(?:u(?:t(?:o(?:b(?:j(?:e(?:c(?:t)?)?)?)?)?)?)?)?)?$/i;
// Characters of parsing a shell check may do per character of the command, past a floor; a command that needs more
// stops, like one with too many paths.
const SHELL_PARSE_STEPS_PER_CHAR = 64;
const SHELL_PARSE_MIN_STEPS = 1 << 20;

const BLANK = /[^\S\n]/;
const PS_SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b";
const PS_DOUBLE_QUOTES = '"\u201c\u201d\u201e';
// PowerShell 7's `e (escape) is a plain e to Windows PowerShell 5.1, which reads ".`env" as .env.
const PS_ESCAPES = { 0: "\0", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const ANSI_C_ESCAPES = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};
// Runs of characters with no meaning to the parser, read in one step. Each is one character class, so it can't
// backtrack.
const PLAIN_RUN = {
  bash: /[^\s;&|()<`'"\\$]+/y,
  powershell: /[^\s;&|(){},`'"\u2018\u2019\u201a\u201b\u201c\u201d\u201e$@#<]+/y,
  cmd: /[^\s,;=^"&|()<]+/y,
};
const DOUBLE_RUN = { bash: /[^"\\$`]+/y, powershell: /[^"\u201c\u201d\u201e`$]+/y };
const PS_SINGLE_RUN = /[^'\u2018\u2019\u201a\u201b]+/y;
const PROSE_LETTER = /[\p{L}\p{N}]/u;
// A PowerShell variable with members or an index (`$x.Name`, `$a[0]`), and a value an expression may end a token
// with: such a variable, a number, or an assignment of one (`$x=1`). Each part ends where the next can't start, so they
// can't backtrack; read from a word's start, where each match ends is kept on the word (see psTokenStarts).
// An index is read only so far, so a line of unclosed ones (`$a[# $a[# …`) can't take time on each.
const PS_MEMBER_VALUE = /\$[\w:?^]+(?:\.\w+|\[[^\]\n]{0,100}\])+/y;
const PS_EXPRESSION_VALUE =
  /(?:(?:\$[\w:?^]+(?:\.\w+|\[[^\]\n]{0,100}\])*|[-+]?\d[\w.]*)[-+*/%]?=)*(?:\$[\w:?^]+(?:\.\w+|\[[^\]\n]{0,100}\])*|[-+]?\d[\w.]*)/y;
const PARAM_RUN = /[^}\\'"$`]+/y;
// The start of a `${…}`: a name, a number or a special parameter, a short subscript, then the operator, if any. A name
// holds no `$`, so the names of two `${` never overlap and reading them all is linear; a subscript, which could hold
// another `${`, is read up to 256 characters.
const PARAM_OPERATOR = /[#!]?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:\[[^\]'"]{0,256}\])?(:?[-=+?]|[#%/^,:@])?/y;

// Splits shell text into its simple commands, each with its words as the shell will pass them, using one shell's
// quote rules: Bash's quotes, backslash and $'\u2026'; PowerShell's quotes (typographic ones too), backtick and here-strings;
// cmd's double quotes and ^. Only a separator outside quotes ends a command, so `cat "a|b" .env` is one command of two
// words. `$(\u2026)`, backticks, `(\u2026)` and PowerShell's `{\u2026}` are commands of their own; the word they sit in keeps a mark
// for them. One pass, each character read once, and `work` counts the characters read for the whole shell check.
// `start` and `firstOnly` read just the one command that starts at `start`. `body` reads the text of a here-document
// or here-string whose `$(…)` and backticks run, as double-quoted text whose quotes are letters, and gives only the
// commands inside it. A command's `heredocs` are the bodies it's given, and `expands` those whose commands run.
const FUNCTION_LEAD_WORDS = new Set([
  "{",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "function",
  "time",
  "-p",
]);

function parseShellCommands(
  text,
  dialect,
  work,
  { start = 0, firstOnly = false, body = false, quote = null, watch = null, prose = false } = {},
) {
  const n = text.length;
  // `prose`: the text is read from a reader's name the shell doesn't run there (inside a quote or a here-document),
  // most often a message's words, so a single quote between two letters is an apostrophe (`doesn't`), not a quote that
  // would pair with the next one and hide a `)` or `|` that ends the reader's words.
  const apostrophe = (i) => i > 0 && PROSE_LETTER.test(text[i - 1]) && PROSE_LETTER.test(text[i + 1] || "");
  // PowerShell: `quote` is the quote the text read from `start` sits in, as the whole command is read: "literal" for a
  // single quote or a `@'…'@`, "double" for a double quote or `@"…"@`. There a backtick outside a quote of the text's
  // own ends the command, as in Guard's first reading: the shell has kept it as a letter or taken it as an escape, and
  // in a message it's most often a Markdown code span's end (`` `cat .env.example` ``). In a single quote it's kept
  // as a letter inside a double quote of the text's own. `watch`: sorted places whose quote, as above, is put in
  // `watch.quotes`.
  // `stepQuote`: the quote the step being read is in, set by the steps that read one whole. `stray`: PowerShell's
  // text has a `)` or `}` with nothing open, which it can't parse.
  let stepQuote;
  let stray = false;
  let watched = 0;
  // PowerShell: where a `(…)`, `$(…)`, `@(…)`, `{…}` or `@{…}` that starts a word ends, which ends a token there.
  let tokenEnd = -1;
  const commands = [];
  const pending = [];
  let first = null;
  let done = false;
  // Where Bash's last backslash-escaped character outside quotes is.
  let escapedAt = -1;
  // `stdinFrom`: what the command's input, stream 0, is redirected from, in order: a file's name as written, or null
  // for a here-document's or here-string's text, or an empty name for a stream copied or closed (`<&3`, `<&-`).
  // `piped`: the command is piped into, so a reader's input is what the command before it writes.
  // `bodies`: here-documents whose end Guard may place otherwise than the shell, read as commands too. In cmd, `start`:
  // the index of the word where a command may start (after `if`'s condition, `do` or `else`), where a `(` opens a
  // block; `ifPhase`: what of an `if`'s condition is still to come; `forState`: "for" past a `for` that starts a
  // command, "set" past its `in`, "done" past its set; `setOpen`, `setFrom`: the set's `(` is open, and the index of
  // its first word; `forLines`: the `for` is a `for /f`; `sets`: each `for /f` set's words, `{ from, to, lines }`.
  const newCommand = () => ({
    dialect,
    words: [],
    inputs: [],
    heredocs: [],
    expands: [],
    bodies: [],
    stdinFrom: [],
    piped: false,
    start: 0,
    ifPhase: null,
    forState: null,
    setOpen: false,
    setFrom: 0,
    forLines: false,
    sets: [],
  });
  const root = { type: "code", closer: "", arith: false, command: newCommand(), word: null, input: false, outer: null };
  const frames = body ? [root, { type: "doc" }] : [root];
  let code = root;

  // A word's `quoted` says whether it starts quoted or escaped; `partQuoted`, whether any of it is; `quotedAt`, where
  // in its value the first quoted or escaped character is (-1 for none). `start` and `end` are where it's written:
  // `text.slice(word.start, word.end)` is the word as written, with its quotes, escapes and groups. `touched`: the
  // word the step being read adds to, which ends where that step does.
  let touched = null;
  const startWord = (at, quoted = false) => {
    if (code.word === null) {
      code.word = { value: "", start: at, end: at, quoted, partQuoted: quoted, quotedAt: quoted ? 0 : -1 };
    } else if (quoted && !code.word.partQuoted) {
      code.word.partQuoted = true;
      code.word.quotedAt = code.word.value.length;
    }
    touched = code.word;
    return code.word;
  };
  const add = (value, at, quoted = false) => {
    startWord(at, quoted).value += value;
  };
  const endWord = () => {
    const word = code.word;
    if (word === null) return;
    code.word = null;
    if (code.input) {
      if (code.input !== "text") code.command.inputs.push(word.value);
      if (code.stdinNext) code.command.stdinFrom.push(word.value);
      code.input = false;
      code.stdinNext = false;
    } else {
      // Bash: after a subshell or `((…))`, a word starts what follows (`(true) then cat .env`, a case pattern's
      // `(x) cat .env`), as a reserved word does after a `]]` or `}` closing a `[[` or `{` that starts the command
      // (`[[ -f x ]] then cat .env`). Among a reader's words they're plain words: `cat 'a;b' } do .env`.
      if (dialect === "bash" && !word.partQuoted) {
        const { words } = code.command;
        const before = words[words.length - 1];
        const afterGroup = before && before.compound && before.value === "\u2026" && !/^(?:\d*|&)[<>]/.test(word.value);
        const plain = (at) => at < words.length && !words[at].partQuoted;
        const opens = (at) => plain(at) && (words[at].value === "[[" || words[at].value === "{");
        const lead = plain(0) && /^(?:if|elif|while|until|!)$/.test(words[0].value) ? 1 : 0;
        const closes =
          before &&
          !before.partQuoted &&
          ((before.value === "}" && words.length === 1) ||
            (before.value === "]]" && opens(lead) && words[lead].value === "[["));
        const afterClose = closes && /^(?:then|do|else|elif)$/.test(word.value);
        if (afterGroup || afterClose) endCommand();
      }
      code.command.words.push(word);
      if (dialect === "cmd") cmdKeyword(word);
    }
  };
  // cmd's keywords, found only where a command starts: `for` and its `/f`, `in` and set; `if` and its condition
  // (`if /i not a==b`, `if exist x`, `if a equ b`); a `for`'s `do`; `else` after a block.
  const cmdKeyword = (word) => {
    const command = code.command;
    const at = command.words.length - 1;
    if (command.setOpen) return;
    // A quoted word is no keyword, but may be a part of an `if`'s condition.
    const bare = word.partQuoted ? "" : word.value.replace(/^@+/, "");
    if (command.ifPhase === "cond") {
      if (/^(?:\/i|not)$/i.test(bare)) return;
      command.ifPhase = /^(?:exist|defined|errorlevel|cmdextversion)$/i.test(bare) ? "operand" : "op";
    } else if (command.ifPhase === "op") {
      command.ifPhase = /^(?:equ|neq|lss|leq|gtr|geq)$/i.test(bare) ? "operand" : null;
      if (!command.ifPhase) command.start = at + 1;
    } else if (command.ifPhase === "operand") {
      command.ifPhase = null;
      command.start = at + 1;
    } else if (at === command.start && /^if$/i.test(bare)) command.ifPhase = "cond";
    else if (at === command.start && /^for$/i.test(bare)) {
      command.forState = "for";
      command.forLines = false;
    } else if (command.forState === "for" && /^\/f/i.test(bare)) command.forLines = true;
    else if (command.forState === "for" && /^in$/i.test(bare)) command.forState = "set";
    else if (command.forState === "done" && /^do$/i.test(bare)) {
      command.forState = null;
      command.start = at + 1;
    } else if (/^else$/i.test(bare) && at > 0 && command.words[at - 1].value === "\u2026") command.start = at + 1;
  };
  const endCommand = () => {
    endWord();
    code.input = false;
    code.stdinNext = false;
    const command = code.command;
    // A `for` set left open is read as far as it goes.
    if (command.setOpen) {
      command.sets.push({ from: command.setFrom, to: command.words.length, lines: command.forLines });
    }
    code.command = newCommand();
    if (code.group && command.words.length) code.group.push(command);
    if (code.arith || (body && code === root)) return;
    if (command.words.length || command.inputs.length) commands.push(command);
    if (code === root) {
      if (first === null) first = command;
      if (firstOnly) done = true;
    }
  };
  const pushCode = (closer, at, arith = false, nested = true) => {
    startWord(at);
    const frame = { type: "code", closer, arith, command: newCommand(), word: null, input: false, outer: code, at };
    // How deep the frame is: a here-document's lines start at a line break as deep as its marker, or less deep. A
    // subshell's `(` isn't deeper: Bash starts them at a line break inside it.
    frame.level = (code.level || 0) + (nested ? 1 : 0);
    // A PowerShell `(\u2026)`, `$(\u2026)` or `@(\u2026)` given as an argument may be the files read: `gc ('a', '.env')`.
    frame.group = dialect === "powershell" && closer === ")" ? [] : null;
    frames.push(frame);
    code = frame;
  };
  // Ends the innermost command frame and any quotes left open inside it. The word it sat in gets a mark, not its text,
  // so frames nested deep can't make the words that hold them long. A PowerShell group's words, past a filter's
  // (`? Name -ne x`), are kept on that word as its `values`, so they stand where the group does. They're passed up at
  // most SHELL_GROUP_DEPTH groups, so each word is copied a bounded number of times. A word that leaves any out past
  // that is marked `deep`, and so is every word it's passed up into, so a reader given it is stopped unless a file it
  // names is a secret one (see secretInReaderWords).
  const closeCode = () => {
    while (frames[frames.length - 1] !== code) frames.pop();
    endCommand();
    frames.pop();
    const inner = code;
    code = code.outer;
    add("\u2026", 0);
    code.word.grouped = true;
    if (inner.compound) code.word.compound = true;
    for (const command of inner.group || []) {
      const head = command.words[0];
      const filter = !head.quoted && SHELL_FILTER_WORD.test(head.value);
      let given = false;
      for (const word of command.words) {
        // A filter's own words aren't files, but what it's handed is: the words after -InputObject or -In, and a group
        // of its own, such as foreach's `($f in '.env')`. A quoted word, as in `('select', '.env')`, is a value.
        if (filter && !word.quoted && word.value.startsWith("-")) given = SHELL_FILTER_INPUT.test(word.value);
        const values =
          !filter || given || /^-in/i.test(word.value) ? [word, ...(word.values || [])] : word.values || [];
        if (word.deep) code.word.deep = true;
        for (const value of values) {
          const depth = (value.depth || 0) + 1;
          if (depth > SHELL_GROUP_DEPTH) {
            code.word.deep = true;
            continue;
          }
          if (!code.word.values) code.word.values = [];
          code.word.values.push({
            value: value.value,
            start: value.start,
            end: value.end,
            quoted: value.quoted,
            depth,
            deep: value.deep,
          });
        }
      }
    }
  };
  const closeParen = (i) => {
    if (code.closer === "))") {
      closeCode();
      return text[i + 1] === ")" ? i + 2 : i + 1;
    }
    if (code.closer === ")") {
      closeCode();
      // A cmd block's mark is a word of its own: `(echo a)else(type b)`.
      if (dialect === "cmd") endWord();
      return i + 1;
    }
    // A `)` with nothing open is text to cmd; to Bash and PowerShell it can only end something.
    if (dialect === "cmd") add(")", i);
    else endCommand();
    return i + 1;
  };
  // Read from a reader's name with nothing open, a backtick may close one opened before the name: it ends the command.
  const backtick = (i) => {
    if (firstOnly && code === root) endCommand();
    else if (code.closer === "`") closeCode();
    else pushCode("`", i);
    return i + 1;
  };
  // `2>&1`, `>&2` and, but in cmd, `&>` redirect; any other `&` ends a command.
  // A `|` that isn't half of `||` pipes the command it ends into the next.
  const pipe = (i) => {
    endCommand();
    if (text[i - 1] !== "|" && text[i + 1] !== "|") code.command.piped = true;
    return i + 1;
  };
  const ampersand = (i) => {
    // Bash's `|&` pipes, as `|` does.
    if (dialect === "bash" && text[i - 1] === "|" && text[i - 2] !== "|" && escapedAt !== i - 1) return i + 1;
    if (text[i - 1] === ">" || text[i - 1] === "<" || (text[i + 1] === ">" && dialect !== "cmd")) {
      add("&", i);
      // cmd takes one digit after `>&` as the handle, and the rest as an argument of its own: `type >&2.env`.
      if (dialect === "cmd" && text[i - 1] === ">" && /\d/.test(text[i + 1] || "")) {
        add(text[i + 1], i + 1);
        endWord();
        return i + 2;
      }
    } else {
      endCommand();
      // PowerShell's `&` calls the command after it.
      if (dialect === "powershell") code.command.called = true;
    }
    return i + 1;
  };
  const lessThan = (i) => {
    const next = text[i + 1];
    // The stream it redirects: the digits right before it (`2<file`), a new one for `{fd}<file`, or else the input.
    const before = code.word !== null && !code.word.partQuoted ? code.word.value : "";
    const toInput = /^\d+$/.test(before) ? Number(before) === 0 : !/^\{\w+\}$/.test(before);
    // The digits or `{fd}` are no word of the command's.
    const stream = /^(?:\d+|\{\w+\})$/.test(before);
    if (dialect === "bash" && next === "<") {
      if (stream) code.word = null;
      else endWord();
      if (toInput) code.command.stdinFrom.push(null);
      if (text[i + 2] !== "<") return heredoc(i + 2);
      // A here-string's word is text the command reads, not a file and not its name.
      code.input = "text";
      return i + 3;
    }
    if (next === "(") {
      add("<", i);
      return i + 1;
    }
    // `0<file`: digits just before are the stream it opens, and in Bash `{fd}` names a new one.
    if (stream && (dialect === "bash" || /^\d+$/.test(before))) code.word = null;
    else endWord();
    if (next === "&") {
      // `<&3`, `0<&3`, `<&-`: a stream copied or closed. What follows is no file and no word of the command's, and an
      // input taken from it is none rg reads in place of the working folder (see stdinIsFile).
      if (toInput) code.command.stdinFrom.push("");
      // cmd takes one digit as the handle, and the rest as an argument of its own: `type <&1.env`.
      if (dialect === "cmd") return /\d/.test(text[i + 2] || "") ? i + 3 : i + 2;
      code.input = "text";
      return i + 2;
    }
    code.input = true;
    code.stdinNext = toInput;
    return next === ">" ? i + 2 : i + 1;
  };
  const heredoc = (from) => {
    let j = from;
    let strip = false;
    if (text[j] === "-") {
      strip = true;
      j += 1;
    }
    while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
    const markerStart = j;
    let delimiter = "";
    // A delimiter with any quoting keeps the body as it's written; otherwise its `$(…)` and backticks run.
    let quoted = false;
    while (j < n && !/[ \t\n;&|()<>]/.test(text[j]) && !(text[j] === "\r" && text[j + 1] === "\n")) {
      const c = text[j];
      // `$'…'` and `$"…"` are quotes; `$(…)` is part of the marker as it's written.
      if (c === "$" && (text[j + 1] === "'" || text[j + 1] === '"')) {
        j += 1;
        continue;
      }
      if (c === "$" && text[j + 1] === "(") {
        let m = j + 1;
        let open = 0;
        const lineEnd = text.indexOf("\n", m);
        const stop = lineEnd < 0 ? n : lineEnd;
        for (; m < stop; m += 1) {
          if (text[m] === "'" || text[m] === '"') {
            const close = text.indexOf(text[m], m + 1);
            if (close < 0 || close >= stop) {
              m = stop;
              break;
            }
            m = close;
          } else if (text[m] === "(") open += 1;
          else if (text[m] === ")" && --open === 0) break;
        }
        delimiter += text.slice(j, Math.min(m + 1, n));
        j = m + 1;
        continue;
      }
      if (c === "'" || c === '"' || c === "\\") quoted = true;
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, j + 1);
        const stop = end < 0 ? n : end;
        delimiter += text.slice(j + 1, stop);
        j = stop + 1;
      } else if (c === "\\") {
        delimiter += text[j + 1] || "";
        j += 2;
      } else {
        delimiter += c;
        j += 1;
      }
    }
    // A marker with a `$` or backtick, a space Bash doesn't split on (`\u00a0`, `\f`, `\r`), or an escape inside double
    // quotes, Guard may read otherwise than the shell.
    const marker = text.slice(markerStart, j);
    const odd = /[$`]|[^\S \t]/.test(marker) || (marker.includes('"') && marker.includes("\\"));
    if (delimiter) pending.push({ delimiter, strip, quoted, odd, level: code.level || 0, command: code.command });
    return j;
  };
  // A here-document's lines are its command's input, not commands; they're kept for a shell that runs them.
  // A line break inside a `$(` or backtick starts only the here-documents marked inside it: `<<EOF $(` ⏎ `cat x` ⏎ `)`.
  const readHeredocs = (at) => {
    let i = at;
    const level = code.level || 0;
    let ready = pending.length;
    while (ready > 0 && pending[ready - 1].level >= level) ready -= 1;
    for (const doc of pending.splice(ready)) {
      const bodyStart = i;
      let bodyEnd = n;
      while (i < n) {
        const lineStart = i;
        const lineEnd = text.indexOf("\n", i);
        const stop = lineEnd < 0 ? n : lineEnd;
        let from = i;
        if (doc.strip) while (from < stop && text[from] === "\t") from += 1;
        const to = stop > from && text[stop - 1] === "\r" ? stop - 1 : stop;
        i = lineEnd < 0 ? n : lineEnd + 1;
        if (to - from === doc.delimiter.length && text.startsWith(doc.delimiter, from)) {
          bodyEnd = lineStart;
          break;
        }
      }
      const lines = text.slice(bodyStart, bodyEnd);
      doc.command.heredocs.push(lines);
      if (!doc.quoted) doc.command.expands.push(lines);
      // One whose marker Guard may misread, or never finds, may end sooner for the shell: its lines may be commands.
      if (doc.odd || bodyEnd === n) doc.command.bodies.push(lines);
    }
    return i;
  };
  const singleQuoted = (i) => {
    if (prose && apostrophe(i)) {
      add(text[i], i);
      return i + 1;
    }
    const end = text.indexOf("'", i + 1);
    const stop = end < 0 ? n : end;
    add(text.slice(i + 1, stop), i, true);
    return stop + 1;
  };
  const ansiC = (i) => {
    let value = "";
    let j = i + 2;
    while (j < n && text[j] !== "'") {
      const c = text[j];
      if (c !== "\\" || j + 1 >= n) {
        value += c;
        j += 1;
        continue;
      }
      const e = text[j + 1];
      const digits = (pattern, from, most) => {
        let end = from;
        while (end < n && end - from < most && pattern.test(text[end])) end += 1;
        return end;
      };
      if (hasOwn(ANSI_C_ESCAPES, e)) {
        value += ANSI_C_ESCAPES[e];
        j += 2;
      } else if (e === "x" || e === "u" || e === "U") {
        const end = digits(/[0-9a-f]/i, j + 2, e === "x" ? 2 : e === "u" ? 4 : 8);
        const point = parseInt(text.slice(j + 2, end), 16);
        value += end > j + 2 && point <= 0x10ffff ? String.fromCodePoint(point) : `\\${e}`;
        j = end;
      } else if (/[0-7]/.test(e)) {
        const end = digits(/[0-7]/, j + 1, 3);
        value += String.fromCharCode(parseInt(text.slice(j + 1, end), 8) & 0xff);
        j = end;
      } else if (e === "c" && j + 2 < n && text[j + 2] !== "'") {
        // Bash ends $'…' at a quote after \c: `$'\c'` doesn't take the quote as its letter. A backslash after \c
        // takes the character after it too, quote or not: `$'\c\''` is one letter.
        value += String.fromCharCode(text.charCodeAt(j + 2) & 0x1f);
        j += text[j + 2] === "\\" ? 4 : 3;
      } else {
        value += `\\${e}`;
        j += 2;
      }
    }
    add(value, i, true);
    return j + 1;
  };
  const dollar = (i) => {
    const next = text[i + 1];
    if (next === "(") {
      add("$", i);
      if (dialect === "bash" && text[i + 2] === "(") {
        pushCode("))", i + 1, true);
        return i + 3;
      }
      pushCode(")", i + 1);
      return i + 2;
    }
    if (next === "{" && dialect === "bash") {
      add("${", i);
      // Inside "${x:-…}" (and after =, + or ?) a single quote is kept in the value, and a `$(…)` after one still runs
      // (see bashParam). After #, % or /, as in "${x#'…'}", it's a quote.
      const outer = frames[frames.length - 1];
      const quoted = outer.type === "dq" || outer.type === "doc" || (outer.type === "param" && outer.quoted);
      PARAM_OPERATOR.lastIndex = i + 2;
      const operator = PARAM_OPERATOR.exec(text);
      const letters = quoted && operator !== null && /^:?[-=+?]$/.test(operator[1] || "");
      frames.push({ type: "param", quoted, letters });
      return i + 2;
    }
    add("$", i);
    return i + 1;
  };
  const plain = (pattern, i) => {
    pattern.lastIndex = i;
    const run = pattern.exec(text);
    const value = run ? run[0] : text[i];
    add(value, i);
    return i + value.length;
  };

  const definesFunction = () => {
    if (code.input) return false;
    const { words } = code.command;
    const name = code.word ?? words[words.length - 1];
    const before = code.word === null ? words.length - 1 : words.length;
    // A word with a group in it is no name, which also keeps `(a)(a)(a)…` from reading its growing word at each `(`.
    if (!name || name.quoted || name.grouped || !/^[^\s"'`$\\<>|&;()]+$/.test(name.value)) return false;
    // Only reserved words can come before the name in a definition: `{ f() …`, `then f() …`, `function f() …`.
    for (let k = 0; k < before; k += 1) {
      if (words[k].quoted || !FUNCTION_LEAD_WORDS.has(words[k].value)) return false;
    }
    return true;
  };
  const bashCode = (i) => {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      endCommand();
      return pending.length ? readHeredocs(i + 1) : i + 1;
    }
    if (BLANK.test(c)) {
      endWord();
      return i + 1;
    }
    if (c === "#" && code.word === null && !code.arith) {
      const end = text.indexOf("\n", i);
      return end < 0 ? n : end;
    }
    if (c === "\\") {
      if (next === "\n") return i + 2;
      // `\`` inside backticks is one nested inside them.
      if (next === "`" && firstOnly && code === root) {
        endCommand();
        return i + 2;
      }
      add(next === undefined ? "\\" : next, i, true);
      escapedAt = i + 1;
      return i + 2;
    }
    if (c === "'") return singleQuoted(i);
    if (c === '"') {
      startWord(i, true);
      frames.push({ type: "dq" });
      return i + 1;
    }
    if (c === "$") {
      if (next === "'") return ansiC(i);
      if (next === '"') {
        startWord(i, true);
        frames.push({ type: "dq" });
        return i + 2;
      }
      return dollar(i);
    }
    if (c === "`") return backtick(i);
    if (c === "(") {
      if (next === "(" && code.word === null) {
        pushCode("))", i, true);
        code.compound = true;
        return i + 2;
      }
      // `f() { cat .env; }` and `f () …`: a function's name, so its body is a command of its own. Only a plain name
      // that starts the command (after `function`, if that's there): in `cat <() .env` or extglob's `cat @() .env`, the
      // `()` is part of a word, and the words after it are still the command's.
      if (!code.arith && definesFunction()) {
        let j = i + 1;
        while (j < n && BLANK.test(text[j])) j += 1;
        if (text[j] === ")") {
          endCommand();
          return j + 1;
        }
      }
      // A subshell, where a command starts, is a compound command.
      const subshell = code.word === null && !code.arith;
      pushCode(")", i, code.arith, !subshell);
      if (subshell) code.compound = true;
      return i + 1;
    }
    if (c === ")") return closeParen(i);
    if (code.arith) {
      add(c, i);
      return i + 1;
    }
    // `>|` writes over a file even with noclobber on; it doesn't end the command. An escaped `\>` is a letter, and the
    // `|` after it does.
    if (c === "|" && text[i - 1] === ">" && code.word !== null && escapedAt !== i - 1) {
      add(c, i);
      return i + 1;
    }
    if (c === "|") return pipe(i);
    if (c === ";") {
      endCommand();
      return i + 1;
    }
    if (c === "&") return ampersand(i);
    if (c === "<") return lessThan(i);
    return plain(PLAIN_RUN.bash, i);
  };
  const bashDouble = (i) => {
    const c = text[i];
    if (c === '"') {
      frames.pop();
      // The closing quote is the word's, as written.
      touched = code.word;
      return i + 1;
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (next === "\n") return i + 2;
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        add(next, i);
        return i + 2;
      }
      add("\\", i);
      return i + 1;
    }
    if (c === "$") return dollar(i);
    if (c === "`") return backtick(i);
    return plain(DOUBLE_RUN.bash, i);
  };
  const bashParam = (i, frame) => {
    const c = text[i];
    if (c === "}") {
      frames.pop();
      add("}", i);
      return i + 1;
    }
    if (c === "\\") {
      add(text[i + 1] || "", i);
      return i + 2;
    }
    // There a single quote still pairs with the next one, as Bash finds where the `}` is, but the text between them is
    // read as double-quoted text: its `$(…)`, backticks and `${…}` run. That text has no single quote in it, so reading
    // it on its own goes no deeper.
    if (c === "'" && frame.letters) {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      const inner = parseShellCommands(text.slice(i + 1, stop), "bash", work, { body: true });
      for (const command of inner.commands) commands.push(command);
      add(text.slice(i, stop + 1), i);
      return stop + 1;
    }
    if (c === "'") return singleQuoted(i);
    if (c === '"') {
      frames.push({ type: "dq" });
      return i + 1;
    }
    if (c === "$") return dollar(i);
    if (c === "`") return backtick(i);
    return plain(PARAM_RUN, i);
  };

  // PowerShell ends an argument that starts with a quoted string where the string ends: `"a b"*` is two arguments.
  const psSingle = (i) => {
    if (prose && apostrophe(i)) {
      add(text[i], i);
      return i + 1;
    }
    stepQuote = "literal";
    const fresh = code.word === null;
    let value = "";
    let j = i + 1;
    let closed = false;
    while (j < n) {
      PS_SINGLE_RUN.lastIndex = j;
      const run = PS_SINGLE_RUN.exec(text);
      if (run) {
        value += run[0];
        j += run[0].length;
        if (j >= n) break;
      }
      if (j + 1 < n && PS_SINGLE_QUOTES.includes(text[j + 1])) {
        value += text[j + 1];
        j += 2;
        continue;
      }
      j += 1;
      closed = true;
      break;
    }
    add(value, i, true);
    if (fresh) endWord();
    // Past the end, as an unclosed quote is.
    return closed ? j : n + 1;
  };
  // `${any name}`: a variable whose name may hold quotes, up to the first `}` a backtick doesn't escape.
  const psBraced = (i) => {
    let j = i + 2;
    while (j < n && text[j] !== "}") j += text[j] === "`" ? 2 : 1;
    add(text.slice(i, Math.min(j + 1, n)), i);
    return j < n ? j + 1 : n + 1;
  };
  const hereString = (i, j) => {
    const quotes = PS_SINGLE_QUOTES.includes(text[i + 1]) ? PS_SINGLE_QUOTES : PS_DOUBLE_QUOTES;
    stepQuote = quotes === PS_SINGLE_QUOTES ? "literal" : "double";
    let line = j;
    while (line >= 0 && !(quotes.includes(text[line + 1] || "\n") && text[line + 2] === "@")) {
      line = text.indexOf("\n", line + 1);
    }
    const lines = text.slice(j + 1, line < 0 ? n : line);
    add(lines, i, true);
    // `@"…"@` runs its `$(…)`; `@'…'@` doesn't.
    if (quotes === PS_DOUBLE_QUOTES) code.command.expands.push(lines);
    endWord();
    return line < 0 ? n : line + 3;
  };
  // A here-document or here-string body: double-quoted text whose quotes are letters.
  const docText = (i) => {
    const c = text[i];
    if (dialect === "powershell") {
      if (c === "`") {
        const next = text[i + 1];
        add(next === undefined ? "" : hasOwn(PS_ESCAPES, next) ? PS_ESCAPES[next] : next, i);
        return i + 2;
      }
      if (c === "$" && text[i + 1] === "{") return psBraced(i);
      if (c === "$") return dollar(i);
      return plain(DOUBLE_RUN.powershell, i);
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (next === "\n") return i + 2;
      if (next === "$" || next === "`" || next === "\\") {
        add(next, i);
        return i + 2;
      }
      add("\\", i);
      return i + 1;
    }
    if (c === "$") return dollar(i);
    if (c === "`") return backtick(i);
    return plain(DOUBLE_RUN.bash, i);
  };
  const psCode = (i) => {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      endCommand();
      return i + 1;
    }
    if (BLANK.test(c)) {
      endWord();
      return i + 1;
    }
    if (c === "#" && psTokenStarts(i)) {
      const end = text.indexOf("\n", i);
      return end < 0 ? n : end;
    }
    if (c === "<" && next === "#" && psTokenStarts(i)) {
      const end = text.indexOf("#>", i + 2);
      return end < 0 ? n : end + 2;
    }
    if (c === "`" && quote) {
      endCommand();
      return i + 1;
    }
    if ((c === "-" || c === "`") && code.word === null) {
      const end = psStopsParsing(i);
      if (end >= 0) return stopParsing(end);
    }
    if (c === "`") {
      if (next === "\n") return i + 2;
      if (next === "\r" && text[i + 2] === "\n") return i + 3;
      // A backtick that ends the text is a letter.
      if (next === undefined) {
        add("`", i);
        return i + 1;
      }
      add(next, i, true);
      return i + 2;
    }
    if (c === "$" && next === "{") return psBraced(i);
    if (PS_SINGLE_QUOTES.includes(c)) return psSingle(i);
    if (PS_DOUBLE_QUOTES.includes(c)) {
      frames.push({ type: "dq", fresh: code.word === null });
      startWord(i, true);
      return i + 1;
    }
    if (c === "@" && code.word === null && next !== undefined && (PS_SINGLE_QUOTES + PS_DOUBLE_QUOTES).includes(next)) {
      let j = i + 2;
      while (j < n && text[j] !== "\n" && BLANK.test(text[j])) j += 1;
      if (j < n && text[j] === "\n") return hereString(i, j);
    }
    if ((c === "$" || c === "@") && next === "(") {
      add(c, i);
      pushCode(")", i + 1);
      return i + 2;
    }
    if (c === "@" && next === "{") {
      add(c, i);
      pushCode("}", i + 1);
      return i + 2;
    }
    if (c === "(") {
      pushCode(")", i);
      return i + 1;
    }
    if (c === "{") {
      pushCode("}", i);
      return i + 1;
    }
    if (c === ")" || c === "}") {
      if (code === root && !firstOnly) stray = true;
    }
    if (code.closer === c) {
      const { at } = code;
      const end = c === ")" ? closeParen(i) : (closeCode(), i + 1);
      const { word } = code;
      if (word && (word.start === at || (word.start === at - 1 && "$@".includes(text[word.start])))) tokenEnd = end;
      return end;
    }
    if (c === ")") return closeParen(i);
    if (c === "}") {
      endCommand();
      return i + 1;
    }
    if (c === "|") return pipe(i);
    if (c === ";") {
      endCommand();
      return i + 1;
    }
    if (c === "&") return ampersand(i);
    if (c === ",") {
      endWord();
      // The word goes on a list with the next one (see copyItemArgs).
      const { words } = code.command;
      if (words.length) words[words.length - 1].listed = true;
      return pastListBreak(i + 1);
    }
    return plain(PLAIN_RUN.powershell, i);
  };
  // Whether a PowerShell token starts at `i`, where a `#` starts a comment: at a word's start, where a group that
  // starts a word ends (`(Get-Date)# note`), and, in an expression, past a value (`$x = 1# note`, `$x.Name# note`).
  // Glued to an argument's other text it's a letter (`a#b`, `$x#y`).
  const psTokenStarts = (i) => {
    const { word } = code;
    if (word === null || i === tokenEnd) return true;
    const ends = (pattern) => {
      pattern.lastIndex = word.start;
      const match = pattern.exec(text);
      return match ? word.start + match[0].length : -1;
    };
    if (word.memberEnd === undefined) word.memberEnd = ends(PS_MEMBER_VALUE);
    if (word.memberEnd === i) return true;
    // An expression is a command that starts with a value, up to a command's name (`$x = gc a, $y#b`, where `$y#b` is
    // an argument), and not one `&` calls.
    const { command } = code;
    const { words } = command;
    if (command.called || !/[$\d]/.test(text[words.length ? words[0].start : word.start])) return false;
    // Each word is looked at once (`named`: one is a command's name).
    if (!command.namesSeen) command.namesSeen = 0;
    for (; command.namesSeen < words.length; command.namesSeen += 1) {
      if (/^[\p{L}_.\\]/u.test(words[command.namesSeen].value)) command.named = true;
    }
    if (command.named) return false;
    if (word.valueEnd === undefined) word.valueEnd = ends(PS_EXPRESSION_VALUE);
    return word.valueEnd === i;
  };
  // Where the `--%` that starts at `i` ends, as PowerShell reads it with its backticks (`` `--% ``), or -1.
  const psStopsParsing = (i) => {
    let j = i;
    let token = "";
    while (token.length < 3 && j < n) {
      if (text[j] === "`" && j + 1 < n && !/[\r\n]/.test(text[j + 1])) {
        token += text[j + 1];
        j += 2;
      } else {
        token += text[j];
        j += 1;
      }
    }
    return token === "--%" && (j >= n || /[\s|]/.test(text[j])) ? j : -1;
  };
  // A list goes on past the end of a line after a comma, and past a comment there.
  const pastListBreak = (from) => {
    let j = from;
    while (j < n) {
      if (/\s/.test(text[j])) j += 1;
      else if (text[j] === "#" || (text[j] === "<" && text[j + 1] === "#")) {
        const end = text[j] === "#" ? text.indexOf("\n", j) : text.indexOf("#>", j + 2);
        if (end < 0) return n;
        j = text[j] === "#" ? end : end + 2;
      } else break;
    }
    return j;
  };
  // After --%, PowerShell passes the rest of the line up to a `|` to the program as it's written: `#`, `;` and single
  // quotes are letters there. The program splits it at blank space outside double quotes.
  const stopParsing = (from) => {
    let j = from;
    let quoted = false;
    while (j < n && text[j] !== "\n" && (quoted || text[j] !== "|")) {
      const c = text[j];
      if (c === '"') {
        quoted = !quoted;
        startWord(j, true);
      } else if (!quoted && BLANK.test(c)) endWord();
      else add(c, j);
      if (code.word !== null) code.word.end = j + 1;
      j += 1;
    }
    endWord();
    // Its words' ends are set above, as the step reads more than one.
    touched = null;
    return j;
  };
  const psDouble = (i) => {
    const c = text[i];
    if (PS_DOUBLE_QUOTES.includes(c)) {
      if (i + 1 < n && PS_DOUBLE_QUOTES.includes(text[i + 1])) {
        add(text[i + 1], i);
        return i + 2;
      }
      touched = code.word;
      if (frames.pop().fresh) endWord();
      return i + 1;
    }
    if (c === "`" && quote === "literal") {
      add(c, i);
      return i + 1;
    }
    if (c === "`") {
      const next = text[i + 1];
      if (next === undefined) return i + 1;
      if (next === "u" && text[i + 2] === "{") {
        const end = text.indexOf("}", i + 3);
        const hex = end < 0 ? "" : text.slice(i + 3, end);
        if (/^[0-9a-f]{1,6}$/i.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
          add(String.fromCodePoint(parseInt(hex, 16)), i);
          return end + 1;
        }
      }
      add(hasOwn(PS_ESCAPES, next) ? PS_ESCAPES[next] : next, i);
      return i + 2;
    }
    if (c === "$" && text[i + 1] === "{") return psBraced(i);
    if (c === "$") return dollar(i);
    return plain(DOUBLE_RUN.powershell, i);
  };

  const cmdCode = (i) => {
    const c = text[i];
    if (c === "\n") {
      endCommand();
      return i + 1;
    }
    if (BLANK.test(c) || c === "," || c === ";" || c === "=") {
      endWord();
      return i + 1;
    }
    if (c === "^") {
      const next = text[i + 1];
      if (next === "\n") return i + 2;
      // A blank, `,`, `;` or `=` after it still splits the words: cmd hands the line on with the `^` taken off.
      if (next !== undefined && (BLANK.test(next) || next === "," || next === ";" || next === "=")) {
        endWord();
        return i + 2;
      }
      add(next === undefined ? "" : next, i, true);
      return i + 2;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? n : end;
      add(text.slice(i + 1, stop), i, true);
      return stop + 1;
    }
    // `in(`, `do(` and `else(`: the word before the `(` is a word of its own.
    const { command } = code;
    const word = code.word;
    if (
      c === "(" &&
      word !== null &&
      !word.partQuoted &&
      word.value.length <= 4 &&
      /^(?:in|do|else)$/i.test(word.value)
    ) {
      endWord();
    }
    // A `for`'s set is text up to its first `)`, which ends the word: `for /f %i in (.env)do`.
    if (c === "(" && command.forState === "set" && !command.setOpen) {
      command.setOpen = true;
      command.setFrom = command.words.length;
      add("(", i);
      return i + 1;
    }
    if (c === "(" && command.setOpen) {
      add("(", i);
      return i + 1;
    }
    if (c === ")" && command.setOpen) {
      add(")", i);
      endWord();
      command.setOpen = false;
      command.forState = "done";
      command.sets.push({ from: command.setFrom, to: command.words.length, lines: command.forLines });
      return i + 1;
    }
    // A `(` opens a block where a command starts (and anywhere after an `if` glued to its condition, `if(1)==(1)`);
    // among the arguments it's text: `type a ( .env )`.
    if (c === "(" && code.word === null) {
      const { words } = command;
      if (words.length === command.start || /^@*if\(/i.test(words.length ? words[0].value : "")) pushCode(")", i);
      else add("(", i);
      return i + 1;
    }
    if (c === ")") return closeParen(i);
    if (c === "|") return pipe(i);
    if (c === "&") return ampersand(i);
    if (c === "<") return lessThan(i);
    return plain(PLAIN_RUN.cmd, i);
  };

  const step = dialect === "bash" ? bashCode : dialect === "powershell" ? psCode : cmdCode;
  const double = dialect === "powershell" ? psDouble : bashDouble;
  let i = start;
  let sinceDeadline = 0;
  while (i < n && !done) {
    const before = i;
    const top = frames[frames.length - 1];
    stepQuote = null;
    i =
      top.type === "dq"
        ? double(i)
        : top.type === "param"
          ? bashParam(i, top)
          : top.type === "doc"
            ? docText(i)
            : step(i);
    if (touched !== null) {
      touched.end = Math.min(i, n);
      touched = null;
    }
    if (watch) {
      // A quote's opening character isn't inside it.
      const inside = top.type === "dq" || top.type === "doc" ? "double" : stepQuote;
      while (watched < watch.at.length && watch.at[watched] < i) {
        watch.quotes[watched] = watch.at[watched] > before || top.type !== "code" ? inside : null;
        watched += 1;
      }
    }
    work.left -= i - before;
    sinceDeadline += i - before;
    if (work.left < 0) throw new ShellCheckTooLong();
    if (sinceDeadline >= 65536 && work.budget) {
      sinceDeadline = 0;
      checkShellDeadline(work.budget);
    }
  }
  // Text that ends inside a quote or a `(…)` is one the shell won't run as read here.
  const unclosed = frames.length > 1 || i > n;
  if (!done) {
    // A group left open goes on to the text's end, and so do the words it sits in.
    while (code !== root) {
      if (code.word !== null) code.word.end = n;
      closeCode();
      code.word.end = n;
    }
    frames.length = 1;
    endCommand();
  }
  return { commands, first, unclosed, stray };
}

// A command's name without its folder or .exe: `/usr/bin/cat` and `cat.exe` are cat.
function commandName(value) {
  const base = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  return base.replace(/\.exe$/i, "");
}

// Where a command's own name is, past the words that only run it (`sudo`, `env`, `cmd /c`), variables it sets and
// redirections before it (`2>/dev/null cat`). A wrapper word may be quoted or escaped, as in `"sudo" cat` or `\time cat`:
// the shell takes its quotes off before it looks the word up. A quoted `x=1` is a command's name, not a variable.
function commandStart(words, dialect, from = 0) {
  let k = from;
  while (k < words.length) {
    const { value, quoted } = words[k];
    if (SHELL_WRAPPER_WORD.test(value)) k += 1;
    else if (!quoted && SHELL_REDIRECTION_WORD.test(value) && k + 1 < words.length) k += 2;
    else if (!quoted && SHELL_REDIRECTION_AT.test(value)) k += 1;
    else if (quoted && !/^cmd$/i.test(commandName(value))) break;
    else if (dialect === "bash" && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(value)) k += 1;
    // `function f { cat .env; }`: the body's first command comes after the name.
    else if (dialect === "bash" && !quoted && value === "function" && k + 1 < words.length) k += 2;
    else if (dialect === "powershell" && /^\$[^=]*[-+*/%?]?=$/.test(value)) k += 1;
    else if (
      dialect === "powershell" &&
      /^\$\S+$/.test(value) &&
      k + 1 < words.length &&
      /^[-+*/%?]?=$/.test(words[k + 1].value)
    ) {
      k += 2;
    } else if (/^cmd$/i.test(commandName(value)) && k + 1 < words.length && CMD_SWITCHES.test(words[k + 1].value)) {
      // `cmd /d /s /c type .env`, `cmd /d/c type .env`: the switches up to /c or /k, then the command it runs.
      let at = k + 1;
      while (at < words.length && CMD_SWITCHES.test(words[at].value) && !CMD_RUN_LAST.test(words[at].value)) {
        at += 1;
      }
      if (at >= words.length || !CMD_SWITCHES.test(words[at].value) || !CMD_RUN_LAST.test(words[at].value)) break;
      k = at + 1;
    } else break;
  }
  return k;
}

// The texts a shell inside the command will run, with the rules it reads them by: `bash -c '\u2026'`, `pwsh -Command \u2026`,
// `cmd /c \u2026`, `eval \u2026`, a shell given a here-document.
function nestedShellTexts(words, k, dialect, heredocs) {
  const name = commandName(words[k].value);
  const invoker = SHELL_INVOKERS.find((entry) => entry.name.test(name));
  if (!invoker) return [];
  const inner = invoker.dialect || dialect;
  const rest = words.slice(k + 1);
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
      // In a cmd terminal, `cmd /ctype "a&b" .env` keeps its quotes, so the `&` inside them ends nothing. Read both
      // ways: from Bash, a quoted `&` with no blank space reaches cmd bare and does end a command.
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

// A word that's an output redirection (PowerShell's `*>` too), or `<&`, with its target in the next word (`2>`,
// `&>`), or with it joined on (`2>/dev/null`, `2>&1`, `>|log`).
const SHELL_REDIRECTION_WORD = /^(?:\d*|\*|\{\w+\})(?:&>>?|>>?|>&|>\||<&)$/;
const SHELL_REDIRECTION_AT = /^(?:\d*|\*|\{\w+\})(?:&>>?|>>?|>&|>\||<&)./;
const SHELL_REDIRECTION_HEAD = /^(?:\d*|\*|\{\w+\})(?:&>>?|>>?|>&|>\||<&)/;

// Whether the shell takes a parsed word as a redirection: "word" for one with its target in the next word, "at" for one
// with its target joined on, or null. Its operator can't be quoted or escaped (`2\>x`, `"2>x"`), but its target can
// (`2>"/dev/null"`). A word that isn't the parser's own, a PowerShell group's value, is no redirection.
function shellRedirection(word) {
  if (word.quoted || word.quotedAt === undefined) return null;
  if (SHELL_REDIRECTION_WORD.test(word.value)) return word.quotedAt === -1 ? "word" : null;
  const head = SHELL_REDIRECTION_HEAD.exec(word.value);
  if (!head || (word.quotedAt !== -1 && word.quotedAt < head[0].length)) return null;
  return "at";
}

// A command's words with each PowerShell group's words right after the word it's in, so a group that's a copy's last
// word stays its destination.
function withGroupValues(words) {
  return words.flatMap((word) => (word.values ? [word, ...word.values] : [word]));
}

// The first secret file a reader given these words reads, or null. `recursive` off leaves out the folders a search
// reads under, for words that may be cut short. `command` is the parsed command the words are from, if any: its input
// redirections say whether rg reads its input in place of the working folder, when `inputKnown`: nothing run before it
// could change what that input names (see secretInCommand). `work` is the parse's, marked `deep` when
// the words hold a PowerShell group nested too deep for all its words to be kept (see closeCode).
// Copy-Item's parameters, and the common ones every PowerShell command takes, by their full names and aliases: those
// that take no value, and the ones whose value is a path it copies or one it writes.
const COPY_ITEM_SWITCHES = [
  "container",
  "force",
  "recurse",
  "passthru",
  "whatif",
  "wi",
  "confirm",
  "cf",
  "verbose",
  "vb",
  "debug",
  "db",
];
const COPY_ITEM_VALUES = [
  "path",
  "literalpath",
  "pspath",
  "lp",
  "destination",
  "filter",
  "include",
  "exclude",
  "credential",
  "fromsession",
  "tosession",
  "erroraction",
  "ea",
  "warningaction",
  "wa",
  "informationaction",
  "infa",
  "progressaction",
  "proga",
  "errorvariable",
  "ev",
  "warningvariable",
  "wv",
  "informationvariable",
  "iv",
  "outvariable",
  "ov",
  "outbuffer",
  "ob",
  "pipelinevariable",
  "pv",
];
const COPY_ITEM_SOURCES = new Set(["path", "literalpath", "pspath", "lp"]);

// What PowerShell's Copy-Item (`cp`, `copy`) copies, given its words: `-Path` and `-LiteralPath` values and the
// arguments given by place, but the destination: `-Destination`'s value, or else the first argument by place when the
// paths are named, or the last one when they aren't. An argument is a word, or a list of them (`a, b`, or a group's
// values, see withGroupValues). A parameter is named by its name, an alias or a prefix of one name only, with its
// value after it or a colon; one Guard doesn't know is taken as a switch, so the argument after it counts as given by
// place. So is one written as cp's short options would be (`-pv`, `-iv`): in Cursor's terminal, a Bash `cp -pv a b`
// read as PowerShell's. `recurse`: -Recurse is given.
function copyItemArgs(words) {
  const args = [];
  // Whether the next word goes on the argument before it: past a comma, after a group's values too (`("a"), b`).
  let joined = false;
  for (const word of words) {
    if (args.length && (joined || word.depth)) args[args.length - 1].push(word);
    else args.push([word]);
    if (!word.depth) joined = Boolean(word.listed);
  }
  const named = (arg) => {
    const match = !arg[0].quoted && /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(arg[0].value);
    // A list's first word is a parameter only with its value after a colon: `-Path:a, b`.
    if (!match || (arg.length > 1 && match[2] === undefined)) return null;
    const given = match[1].toLowerCase();
    const known = [...COPY_ITEM_SWITCHES, ...COPY_ITEM_VALUES];
    const exact = known.find((name) => name === given);
    const prefixed = known.filter((name) => name.startsWith(given));
    const name = exact || (prefixed.length === 1 ? prefixed[0] : null);
    if (name && COPY_ITEM_VALUES.includes(name) && [...match[1]].every((letter) => CP_SHORT_OPTIONS.includes(letter))) {
      return { name: null };
    }
    return { name, value: match[2] };
  };
  const sources = [];
  const placed = [];
  let destination = false;
  let recurse = false;
  for (let k = 0; k < args.length; k += 1) {
    const parameter = named(args[k]);
    const values = (arg) => arg.map((word) => word.value);
    if (!parameter) {
      placed.push(values(args[k]));
      continue;
    }
    const { name } = parameter;
    if (name === "recurse") recurse = true;
    if (!name || COPY_ITEM_SWITCHES.includes(name)) continue;
    let value = [];
    if (parameter.value !== undefined) value = [parameter.value, ...values(args[k].slice(1))];
    else if (k + 1 < args.length) {
      k += 1;
      value = values(args[k]);
    }
    if (COPY_ITEM_SOURCES.has(name)) sources.push(...value);
    else if (name === "destination") destination = true;
  }
  // With the paths named, the first argument by place is the destination.
  if (destination) sources.push(...placed.flat());
  else if (sources.length) sources.push(...placed.slice(1).flat());
  else sources.push(...(placed.length < 2 ? placed : placed.slice(0, -1)).flat());
  return { sources, recurse };
}

// The short options GNU's, BSD's or uutils' cp knows; `t` and `S` take a value, the rest of the word or the next word.
const CP_SHORT_OPTIONS = "abcdfgiHlLnPpRrsSTtuvxXZ";
// GNU cp's long options that must have a value, given after `=` or as the next word, as a prefix may name them.
const CP_LONG_VALUES = ["--no-preserve", "--sparse", "--suffix", "--target-directory"];

// Whether cp, given these words with their quotes taken off, stops at a short option it doesn't know, before `--`.
function cpRefuses(args) {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k];
    if (arg === "--") return false;
    // `--suffix -old`: the word after is the option's value.
    if (arg.length > 2 && !arg.includes("=") && CP_LONG_VALUES.some((option) => option.startsWith(arg))) {
      k += 1;
      continue;
    }
    // A word with a substitution or variable in it could be any option.
    if (!/^-[^-]/.test(arg) || /[…$`]/.test(arg)) continue;
    for (let j = 1; j < arg.length; j += 1) {
      if (!CP_SHORT_OPTIONS.includes(arg[j])) return true;
      if (arg[j] === "t" || arg[j] === "S") {
        if (j === arg.length - 1) k += 1;
        break;
      }
    }
  }
  return false;
}

function secretInReaderWords(
  reader,
  words,
  cwd,
  shellGlobs,
  recursive = true,
  command = null,
  work = null,
  inputKnown = false,
) {
  const args = words.map((word) => word.value);
  // The words without their redirections (see shellRedirection), and a redirection's target when apart from it.
  const plainWords = [];
  for (let k = 0; k < words.length; k += 1) {
    const redirection = shellRedirection(words[k]);
    if (redirection === "word") k += 1;
    else if (!redirection) plainWords.push(words[k]);
  }
  const plain = plainWords.map((word) => word.value);
  // In PowerShell, cp and copy are Copy-Item, whose parameters are PowerShell's (see copyItemArgs).
  const copyItem =
    command && command.dialect === "powershell" && /^(?:cp|copy)$/i.test(reader) ? copyItemArgs(plainWords) : null;
  // GNU's and BSD's cp copy nothing when given a short option they don't know: in Cursor's terminal, a PowerShell
  // `cp a b -WhatIf` read as Bash's.
  if (command && command.dialect === "bash" && /^cp$/i.test(reader) && cpRefuses(plain)) return null;
  let operands;
  // A copy reads its sources, not the destination it writes, which stays its last word with an output redirection
  // after it (`cp a .env &>/dev/null`): a redirection, and its target when apart from it, aren't copy words. `2\>x` and
  // `"2>x"` are words cp copies.
  if (copyItem) operands = copyItem.sources;
  else if (/^(?:cp|copy)$/i.test(reader)) {
    const cp = /^cp$/i.test(reader);
    const lastIsSource = cp && ((last) => copyLastIsSource(last, cwd, shellGlobs));
    operands = copySources(parseShellArgs(plain, cp ? { shortValues: "tS" } : {}), lastIsSource);
    // cmd's copy joins files given with `+`, and takes a switch glued on: `copy a.txt+.env/b out.txt`.
    if (!cp) {
      const parts = (operand) => operand.split("+").flatMap((part) => [part, part.split("/")[0]]);
      operands = [...new Set(operands.flatMap((operand) => [operand, ...parts(operand)]))];
    }
  } else {
    operands = [];
    let onlyOperands = false;
    for (const word of words) {
      const { value } = word;
      if (onlyOperands || word.quoted || !value.startsWith("-")) operands.push(value);
      else if (value === "--") onlyOperands = true;
      else {
        // PowerShell's `-Path:.env`.
        const named = /^-[A-Za-z]+:(.+)$/.exec(value);
        if (named) operands.push(named[1]);
      }
    }
  }
  for (const operand of operands) {
    if (operand && secretOperandOpened(operand, cwd, shellGlobs)) return operand;
    // A command substitution that prints nothing, as in `.e$()nv`, leaves the rest of the name as it is.
    const bare = operand.includes("…") ? operand.replace(/[$@]?…/g, "") : "";
    if (bare && secretOperandOpened(bare, cwd, shellGlobs)) return bare;
  }
  if (work && words.some((word) => word.deep)) work.deep = true;
  if (!recursive) return null;
  // rg reads its input in place of the working folder when that's a pipe, or a file its redirections give it, and
  // stream 0 isn't closed or sent elsewhere after them (`0>&-`, `0>/dev/null`). A redirection of its input after the
  // pipe wins over the pipe.
  const rg = /^rg$/i.test(reader);
  const kept = rg && !command?.words.some((word) => /^0+>/.test(word.value) && shellRedirection(word));
  const stdin =
    kept &&
    Boolean(command) &&
    (command.stdinFrom.length
      ? inputKnown && command.stdinFrom.every((from) => from === null || stdinIsFile(from, cwd, shellGlobs.budget))
      : command.piped);
  // `grep -r`, `rg`, `findstr /s`, `diff -r` and `cp -r` read every file under a folder they're given.
  const lastIsSource = (last) => copyLastIsSource(last, cwd, shellGlobs);
  const pattern = command !== null;
  if (copyItem) {
    const copied = copyItem.recurse ? copyItem.sources : [];
    return secretInReaderTargets(
      copied.map((operand) => ({ path: operand, filters: EMPTY_FILTERS })),
      reader,
      cwd,
      shellGlobs,
    );
  }
  const targets = recursiveReadTargets(reader, args, lastIsSource, { stdin, pattern });
  // Read without its redirections too, as the first reading reads them (see withoutRedirections).
  if (plain.length !== args.length) {
    const seen = new Set(targets.map((target) => JSON.stringify(target)));
    for (const target of recursiveReadTargets(reader, plain, lastIsSource, { stdin, pattern })) {
      if (!seen.has(JSON.stringify(target))) targets.push(target);
    }
  }
  return secretInReaderTargets(targets, reader, cwd, shellGlobs);
}

// The shells in `dialects` that can parse the text: PowerShell runs nothing of one with a `<` starting a word outside a
// string or comment (see unescapedCommand's `reservedLess`), read with its quotes ended at line breaks or not, so a
// Bash here-doc's Markdown (`cat > README.md <<'EOF'`) isn't read as PowerShell's commands. Linear in the text.
function shellsThatParse(text, dialects) {
  if (!dialects.includes("powershell") || !text.includes("<")) return dialects;
  const plain = text.replace(/[‘-‛]/g, "'").replace(/[“-„]/g, '"').replace(/[–-―]/g, "-");
  const parses = [false, true].some(
    (lineReset) => unescapedCommand(plain, { ...SHELL_ESCAPES.powershell, lineReset }) !== null,
  );
  return parses ? dialects : dialects.filter((dialect) => dialect !== "powershell");
}

// The first secret file the commands in shell text read, as each of the shells in `dialects` would split it. At the
// top level, `top.handled` gets where each reader's name starts, and `top.unclosed` whether a shell's reading ended
// inside a quote or a `(…)`.
function secretInShellText(text, dialects, cwd, shellGlobs, work, depth = 0, top = null) {
  for (const dialect of shellsThatParse(text, dialects)) {
    const watch = top && top.watch && dialect === "powershell" ? top.watch : null;
    const { commands, unclosed, stray } = parseShellCommands(text, dialect, work, { watch });
    // PowerShell parses all of a script before it runs any of it, so it runs nothing of one left open or with a
    // closing bracket that closes nothing: in Cursor's terminal, a Bash command such as `grep -rn {{ src`. Text only
    // PowerShell runs is still read, as Guard may misjudge where PowerShell's tokens end.
    if (dialect === "powershell" && dialects.length > 1 && (unclosed || stray)) {
      if (top) top.powershellFails = true;
      continue;
    }
    if (top && unclosed) top.unclosed = true;
    for (const command of commands) {
      const location = secretInCommand(command, dialect, cwd, shellGlobs, work, depth, top);
      if (location) return location;
    }
  }
  return null;
}

// What may come before the command's first command, or an echo piped into it (see secretInCommand).
const STDIN_FIRST_PREFIX = /^\s*(?:(?:echo|printf)\b[^;&|<>()`$\\\n\r]*\|\s*)?$/;

// The first secret file one parsed command reads: through an input redirection, as a reader, or in a shell it runs.
function secretInCommand(command, dialect, cwd, shellGlobs, work, depth, top) {
  for (const input of command.inputs) {
    if (input && secretOperandOpened(input, cwd, shellGlobs)) return input;
  }
  // The commands a here-document's or here-string's `$(…)` and backticks run, however they start.
  for (const lines of command.expands) {
    if (!/\$\(|`/.test(lines)) continue;
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    const { commands } = parseShellCommands(lines, dialect, work, { body: true });
    for (const inner of commands) {
      const location = secretInCommand(inner, dialect, cwd, shellGlobs, work, depth + 1, null);
      if (location) return location;
    }
  }
  for (const lines of command.bodies) {
    if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    for (const inner of parseShellCommands(lines, dialect, work).commands) {
      const location = secretInCommand(inner, dialect, cwd, shellGlobs, work, depth + 1, null);
      if (location) return location;
    }
  }
  const { words } = command;
  let k = commandStart(words, dialect);
  if (k >= words.length) return null;
  // `lead`: words read before the ones after the reader's name.
  const read = (at, reader, lead = []) => {
    const head = words[at];
    if (top) top.handled.add(head.start);
    // rg's input is taken as the file it names only in the command's first command, or one an echo pipes into: one
    // before it could change the working folder or make that file a folder, and a shell the command runs may run later.
    const first = top !== null && head.start < 4096 && STDIN_FIRST_PREFIX.test(top.text.slice(0, head.start));
    // Bash: a `}` in the words of a reader after a `{` is taken as that group's end, as it's plainly meant
    // (`{ cp .env.example .env } else { ... }`, a PowerShell line read as Bash's), though Bash runs it as a word unless
    // a `;` comes before it, and the group then needs a later `}` to close it.
    let after = words.slice(at + 1);
    const plain = (word, value) => !word.partQuoted && word.value === value;
    if (dialect === "bash" && words.slice(0, at).some((word) => plain(word, "{"))) {
      const close = after.findIndex((word) => plain(word, "}"));
      if (close >= 0) after = after.slice(0, close);
    }
    // A pipe is rg's input only when rg starts the command piped into, not inside a group or compound command
    // (`x | { rg y; } </dev/null`), whose redirection wins over the pipe.
    return secretInReaderWords(
      reader,
      withGroupValues(lead.concat(after)),
      cwd,
      shellGlobs,
      true,
      at === 0 ? command : { ...command, piped: false },
      work,
      first,
    );
  };
  // The reader a word names, past cmd's `@`, or in PowerShell one a group gives: `& ('cat') .env`.
  const readerOf = (word) => {
    const runs = commandName(dialect === "cmd" ? word.value.replace(/^@+/, "") : word.value);
    if (SHELL_READER_NAME.test(runs)) return runs;
    if (dialect !== "powershell" || !word.values) return null;
    const given = word.values.find((value) => SHELL_READER_NAME.test(commandName(value.value)));
    return given ? commandName(given.value) : null;
  };
  const head = words[k];
  // A name PowerShell calls from a group too deep to keep stops it, as one in a reader's words does: `& ((((...))))`.
  const called = k === 0 ? command.called : !words[k - 1].quoted && words[k - 1].value === ".";
  if (head.deep && called && work) work.deep = true;
  const name = commandName(head.value);
  const reader = readerOf(head) || (name === "." && !head.quoted ? "source" : null);
  if (reader) {
    const location = read(k, reader);
    if (location) return location;
  }
  // Bash: a name made only by a substitution may be empty, so a word after it may be the command: `$(true) cat .env`.
  if (dialect === "bash" && !reader) {
    let at = k;
    const lone = (word) => !word.partQuoted && !word.compound && /^\$?\u2026$/.test(word.value);
    while (at < words.length && lone(words[at])) at += 1;
    const runs = at > k && at < words.length ? readerOf(words[at]) : null;
    const location = runs ? read(at, runs) : null;
    if (location) return location;
  }
  // cmd runs an internal command glued to what follows its name: `type.env` is `type` given `.env`.
  const glued = dialect === "cmd" && !reader && !head.quoted && CMD_GLUED_READER.exec(head.value.replace(/^@+/, ""));
  if (glued) {
    const rest = {
      value: glued[2],
      start: head.start,
      end: head.end,
      quoted: false,
      partQuoted: head.partQuoted,
      quotedAt: 0,
    };
    const location = read(k, glued[1].toLowerCase(), [rest]);
    if (location) return location;
  }
  // cmd's `for /f` reads the files in its set, or runs the command text there: `in (.env)`, `in ('type .env')`. Its
  // `for` may start any command in the words: `if 1==1 for /f …`, `for %a in (x) do for /f …`.
  if (dialect === "cmd" && !command.scanned) {
    for (const set of command.sets || []) {
      if (!set.lines) continue;
      const values = words.slice(set.from, set.to).map((word) => word.value);
      for (const value of values) {
        const file = value.replace(/^\(+|\)+$/g, "").replace(/['"`]/g, "");
        if (file && secretOperandOpened(file, cwd, shellGlobs)) return file;
      }
      const run = /^(['`])([\s\S]*)\1$/.exec(
        values
          .join(" ")
          .replace(/^\(([\s\S]*)\)$/, "$1")
          .trim(),
      );
      if (!run) continue;
      if (depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
      const location = secretInShellText(run[2], ["cmd"], cwd, shellGlobs, work, depth + 1);
      if (location) return location;
    }
  }
  // cmd's `if` and `for` run a command after their condition or `do`: it's read from the first word naming a reader
  // or a shell (`if 1==1 type .env`, `if(1)==(1) type .env`, `for %i in (x) do @type .env`), once: not again for an
  // `if` in that command. An `if` is passed over as a wrapper to find the command's name, so it may be before it.
  const opener =
    dialect === "cmd" && !command.scanned
      ? words.findIndex((word, at) => at <= k && !word.quoted && /^@*(?:if|for)(?![A-Za-z0-9_])/i.test(word.value))
      : -1;
  if (opener >= 0) {
    for (let at = opener + 1; at < words.length; at += 1) {
      const bare = words[at].value.replace(/^@+/, "");
      const runs = commandName(bare);
      const glues = !words[at].quoted && CMD_GLUED_READER.test(bare);
      if (!readerOf(words[at]) && !glues && !SHELL_INVOKERS.some((entry) => entry.name.test(runs))) continue;
      const rest = words
        .slice(at)
        .map((word, w) => (w === 0 ? { ...word, value: word.value.replace(/^@+/, "") } : word));
      const after = { ...command, words: rest, inputs: [], expands: [], bodies: [], piped: false, scanned: true };
      const location = secretInCommand(after, dialect, cwd, shellGlobs, work, depth, top);
      if (location) return location;
      break;
    }
  }
  // PowerShell's `.` runs the command after it, as `&` does, as well as a script it names: `. rg x`.
  if (dialect === "powershell" && name === "." && !head.quoted) {
    let at = commandStart(words, dialect, k + 1);
    while (at < words.length && words[at].value === "." && !words[at].quoted) at = commandStart(words, dialect, at + 1);
    if (at < words.length) {
      k = at;
      const runs = readerOf(words[at]);
      const location = runs ? read(at, runs) : null;
      if (location) return location;
    }
  }
  // `cmd /c "type .env"` is passed over as a wrapper to find the command's name, and run as a shell too.
  for (let at = 0; at <= k; at += 1) {
    const texts = nestedShellTexts(words, at, dialect, command.heredocs);
    // Shells nested deeper than Guard reads stop the command, as one with too many paths does.
    if (texts.length && depth >= SHELL_NEST_MAX) throw new ShellCheckTooLong();
    for (const [inner, innerDialect] of texts) {
      const location = secretInShellText(inner, [innerDialect], cwd, shellGlobs, work, depth + 1);
      if (location) return location;
    }
  }
  return null;
}

// For each place in `text`, where the next of `characters` is at or after it (the text's length if none is).
function nextStops(text, characters) {
  const stops = new Int32Array(text.length + 1);
  let next = text.length;
  stops[text.length] = next;
  for (let j = text.length - 1; j >= 0; j -= 1) {
    if (characters.includes(text[j])) next = j;
    stops[j] = next;
  }
  return stops;
}

// The first secret file a shell command's readers, redirections or embedded file opens could read, or null.
// `dialects` are the shells that could run it: "bash", "powershell", "cmd". `oldWords` also reads every reader's words
// as Guard first read them, for a shell that splits inside a single quote.
function secretInParsedShell(command, cwd, shellGlobs, dialects = ["bash", "powershell"], oldWords = false) {
  const work = { left: SHELL_PARSE_MIN_STEPS + SHELL_PARSE_STEPS_PER_CHAR * command.length, budget: shellGlobs.budget };
  // Each command as the shell splits it: a separator inside quotes, `cat "a|b" .env`, doesn't end the reader's words.
  const readers = [...command.matchAll(SHELL_READER_AT)];
  // The quote PowerShell reads each reader's name in, at its last letter (see parseShellCommands).
  const watch = { at: readers.map((match) => match.index + match[0].length - 1), quotes: [] };
  const top = { handled: new Set(), unclosed: false, text: command, watch };
  const found = secretInShellText(command, dialects, cwd, shellGlobs, work, 0, top);
  if (found) return found;
  // A reader the shell wouldn't run as a command here, inside quotes or a here-document, may still be run by a shell
  // nested in the command, and a here-document or here-string runs the `$(…)` in it. Its words are read from where its
  // name ends, with fresh quote rules, up to the first separator outside them, and a command inside them is checked
  // too. Each reader's name is found on its own, so one inside another's words is read as well. A command that ends
  // inside a quote or a `(…)` won't run as read, so its readers are also read as Guard read them before: up to the next
  // separator, quoted or not, or the next reader, in words split at blank space.
  // Each reader's words are read only up to where the next reader's match starts, so no text is read twice.
  // In PowerShell, the text is read in the quote the name sits in, where a backtick ends the command (a Markdown code
  // span in a commit message), as it does in Guard's first reading.
  const parsing = readers.length
    ? shellsThatParse(command, dialects).filter((dialect) => dialect !== "powershell" || !top.powershellFails)
    : [];
  let stops = null;
  for (let r = 0; r < readers.length; r += 1) {
    const match = readers[r];
    const reader = match[1];
    const nameEnd = match.index + match[0].length;
    const limit = r + 1 < readers.length ? readers[r + 1].index : command.length;
    const handled = top.handled.has(nameEnd - reader.length);
    if (!handled) {
      // The text up to the limit is a slice that shares the command's memory, and every scan in it stops at its end.
      const text = command.slice(0, limit);
      for (const dialect of parsing) {
        const quote = dialect === "powershell" ? watch.quotes[r] || null : null;
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
          const innerLocation =
            inner === first ? null : secretInCommand(inner, dialect, cwd, shellGlobs, work, 0, null);
          if (innerLocation) return innerLocation;
        }
      }
    }
    if (top.unclosed || !handled || oldWords) {
      // As Guard first read them. Where the shell's reading stands (this reader's command has none here), only the
      // files named, not a folder a cut-short search would be taken to read.
      if (stops === null) stops = nextStops(command, SHELL_OLD_STOPS);
      const end = Math.min(stops[nameEnd], limit);
      work.left -= end - nameEnd;
      if (work.left < 0) throw new ShellCheckTooLong();
      const words = (command.slice(nameEnd, end).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((value) => ({
        value: value.replace(/^['"]|['"]$/g, ""),
        quoted: /^['"]/.test(value),
      }));
      const location = secretInReaderWords(reader, words, cwd, shellGlobs, top.unclosed);
      if (location) return location;
    }
  }
  // A reader given a group nested too deep for all its words to be kept may read a secret file among those left out.
  const location = secretInRedirectsOrOpens(command, cwd, shellGlobs);
  if (location || !work.deep) return location;
  throw new ShellCheckTooLong();
}

// The first secret file read through an input redirection or a file open written into the command, or null.
function secretInRedirectsOrOpens(command, cwd, shellGlobs) {
  // Input redirection reads the file whatever the command is: `tr a b < .env`, `cat<.env`, `<>.env`, a `while read`
  // loop. Its target is the whole word, quoted parts joined as the shell joins them (`< "$HOME"/kj/config`, `< '.e'nv`),
  // and also a run up to a blank or an operator, its quotes kept, as a quote needn't close for cmd (`sort <".env`).
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
  const embeddedReaders = /\b(?:open|readFileSync|readFile|createReadStream)\s*\(\s*(['"])([^'"]+)\1/gi;
  const readingOptions = { gitBash: Boolean(shellGlobs.gitBash) };
  for (const match of command.matchAll(embeddedReaders)) {
    for (const reading of [match[2], ...pathReadings(match[2], readingOptions)]) {
      if (isSecretOperand(reading, cwd, undefined, shellGlobs.budget)) return match[2];
    }
  }
  return null;
}

// A reader and its words as Guard's first shell check read them: up to the next separator, quoted or not.
const SHELL_FIRST_READERS = new RegExp(`${SHELL_READER_AT.source}([^;&|)\`]*)`, "gim");
// Readers that are POSIX tools on every system Bash runs on, Git Bash's included, never expand a glob themselves, and
// read only the files they're given as words: no switch or script of theirs names one (`grep -f`, `diff
// --from-file`, sed's `r`, `awk -f`, `less -k`, `source -p`), which the bare `*` of the split words could have caught.
const SHELL_FIRST_JOIN_READER = /^(?:cat|head|tail|tac|nl|od|paste|fold|cut|uniq|base64|cp)$/;

// The words Guard's first shell check split a reader's text into: a quoted run, or a run up to blank space. In Bash, a
// `*` or `?` right after a closing quote is part of the quoted word, so `"READ ME"*` is the files starting `READ ME`,
// not a glob of its own that matches every file in the folder. It's joined only when the quoted part starts the word
// and holds plain letters: no glob or brace character, `\`, `~` or leading `-`, which read differently unquoted, no
// `$` or backtick, which Bash expands inside double quotes, no `!`, which Guard's glob reads as a negation, and none of
// `:<>|`, which Git Bash keeps as other letters in a name. Nor may it name only `.` or `..` in its folder, which Bash
// matches too, start at the root, where Git Bash's `/` and /tmp are its own folders, not the ones Node finds there,
// or hold a `..` part, which Bash takes from where a link before it leads and Node folds away by its text. So the
// joined glob matches every file Bash's word does. Only `*`: Bash's `?` is one byte in the C locale and one letter in
// others, so `"q"??` can match `qé` or not.
// `expand`, given for such a reader (see FIRST_JOIN_READER_CALL), lists what the joined glob matches, for words
// before `until`, where the command's first call ends: Bash expands a later call's words after the ones before it
// have run. When it's one path, and that path starts with the quoted part letter for letter, the path stands in for
// the bare `*`, as Bash hands it to the command, so a copy's last path falls where it does in Bash. The quoted part
// stays a word of its own, judged by its name as it was before the join, so `"server.key"*` is still stopped. Guard
// matches without regard to case, so Bash finds no path Guard doesn't, and the one Guard found, whatever Bash's glob
// options. With two or more, Bash's order (its locale's) says which is the pattern or the target; with none, Bash's
// options say whether the word is kept. So then the words stay split, as they do when Guard can't list them or the
// path wouldn't read back as one plain word, or ends in `.lnk`: Git Bash shows a link it made as such a file by its
// name without `.lnk`, and opens what it leads to.
function firstReadingWords(text, expand, joined, until = 0) {
  const words = [];
  // The text starts right after the reader's name, so a word at its very start is glued to that.
  let end = 0;
  let lastStartsWord = false;
  for (const { 0: word, index } of text.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    const last = words[words.length - 1];
    const glued = index === end;
    const quoted =
      expand && glued && lastStartsWord && index + word.length <= until && /^\*+$/.test(word)
        ? /^(["'])(?!-)([^*?[\]\\$`{}~!:<>|\0-\x1f]*)\1$/.exec(last)
        : null;
    const prefix = quoted ? quoted[2] : null;
    const glob = prefix !== null && !/^\/|(?:^|\/)\.+$|(?:^|\/)\.\.(?:\/|$)/.test(prefix) ? prefix + word : null;
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
      // After a word ending in `\`, the blank space between is escaped into one word. Bash splits words only at a space
      // or tab, not at the other blank space `\s` holds, such as a no-break space.
      lastStartsWord = !glued && /[ \t]/.test(text[index - 1] ?? "") && !(last || "").endsWith("\\");
      words.push(word);
    }
    end = index + word.length;
  }
  return words;
}

// The first secret file a shell command's readers, redirections or embedded file opens could read, or null, as Guard's
// first shell check read them: in the command as written and as each shell that could run it spells it (see
// shellSpellings). The checks share one budget, so a path or folder already checked isn't checked again. `bash` and
// `copyLast`: see secretInFirstShellReading.
function secretInShellReads(command, cwd, shellGlobs, bash = false, copyLast = false) {
  for (const spelling of shellSpellings(command, shellGlobs.kind)) {
    const location = secretInFirstShellReading(spelling, cwd, shellGlobs, bash, copyLast);
    if (location) return location;
  }
  return null;
}

// The first secret file a shell command reads as Guard's first shell check read it. Every command is checked this way
// too, so no command that check stopped goes through however the shell's own reading splits it. `bash`: the command
// is Claude's Bash tool's. `copyLast`: cp's last word is read as files it copies too where copyLastIsSource says so;
// otherwise it's where cp copies to, as the first check read it.
function secretInFirstShellReading(command, cwd, shellGlobs, bash = false, copyLast = false) {
  const { budget } = shellGlobs;
  const joined = [];
  const before = budget.byName;
  const found = firstReadingPass(command, cwd, shellGlobs, bash, joined, copyLast);
  if (found || !joined.length) return found;
  // A joined glob's paths are only as good as the look Guard took at them. Where any path in the command was judged by
  // its name instead (a walk cut short, a folder it couldn't list, a path on another computer), or the walk or its
  // lookups ran out, the bare `*` of the split words could still have stopped the command, where `x*` or `xdata` names
  // no secret file. Then the command is read again with the words split as before.
  const spent = budget.byName !== before || budgetSpent(budget) || lookupsSpent(budget);
  return spent ? firstReadingPass(command, cwd, shellGlobs, false, [], copyLast) : null;
}

// Bash lists a glob's paths in the folder it's in when it reaches the word, with the glob options set by then, after
// every command before it has run. Guard lists them before any of it runs, in the folder the command starts in. They
// agree only for a command that is one call of a POSIX reader and nothing else: no other command before or after it
// (`;`, `&`, `|`, a line break), no group, redirection, here-document, `$`, backtick or `\`, and the reader's own name
// first, with no wrapper or variable before it. Then no earlier command can add a match, change the folder or set an
// option, and no nested shell can start with its own.
const SOLE_JOIN_READER_CALL =
  /^[ \t]*(?:cat|head|tail|tac|nl|od|paste|fold|cut|uniq|base64|cp)[ \t][^;&|<>(){}`$\\\r\n]*$/;
// The same reader call as the command's first, with others after it: Bash expands its words before any of them runs.
// Only after `;`, `&&`, `||` or a line break, which wait for it: a `|` or `&` starts the next command beside it, which
// may have changed the folder by the time it expands them.
const FIRST_JOIN_READER_CALL =
  /^[ \t]*(?:cat|head|tail|tac|nl|od|paste|fold|cut|uniq|base64|cp)[ \t][^;&|<>(){}`$\\\r\n]*(?=$|;|&&|\|\||\r?\n)/;

// Whether the one path a joined glob found is what Bash opens by that name: a folder, or a file with no other name
// (a hard link's other name could be a secret file's) that isn't a link Git Bash or Cygwin wrote as a file of its own
// (`!<symlink>`, Interix's `IntxLNK`), which Node takes for a plain file and Bash follows. Such a file holds one path,
// so a bigger file isn't one, and isn't opened: opening a file that's only in the cloud downloads it.
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
  // Folders a joined glob was listed in: the walk is charged for each once, so joins don't spend what later paths need.
  const listedFolders = new Set();
  const { budget } = shellGlobs;
  let pastEnd = 0;
  for (const match of command.matchAll(SHELL_FIRST_READERS)) {
    // Only for a POSIX tool: a Windows program such as findstr expands a glob Bash left alone on its own, against short
    // names too, so `"e"*` can match .env (ENV~1) there. Only the command's first call (see FIRST_JOIN_READER_CALL).
    const expand =
      firstCall && match.index === 0 && SHELL_FIRST_JOIN_READER.test(match[1])
        ? (glob) => {
            const entries = budget?.entries;
            const paths = expandShellGlob(glob, cwd, shellGlobs);
            const folder = glob.slice(0, glob.lastIndexOf("/") + 1);
            if (budget && listedFolders.has(folder)) budget.entries = entries;
            listedFolders.add(folder);
            return paths?.length === 1 && !plainJoinTarget(paths[0], cwd, budget) ? null : paths;
          }
        : null;
    // The reader's words start where its text does, so the first call ends this far into them.
    const until = expand ? firstCall[0].length - (match[0].length - match[2].length) : 0;
    const asRead = firstReadingWords(match[2], expand, joined, until);
    // The words as the shell joins them, also read where a quote sits inside one (`"$HOME"/kj`, see joinedWords).
    const shellJoined = joinedWords(match[2]);
    // The words past a reader's redirection (see wordsPastRedirections) are read as well as its words as Guard always
    // read them, never instead, since a quote opened before the redirection and closed after it joins words the shell
    // keeps apart. A reader found among them (`2>&cat`, a stream sent to a file named cat) is one of their words,
    // already read with them, so they're taken once however many follow. A call with a redirection is never joined
    // (see FIRST_JOIN_READER_CALL), so these words are split as they always were.
    const end = match.index + match[0].length;
    const past = match.index < pastEnd ? "" : wordsPastRedirections(command, end);
    if (match.index >= pastEnd) pastEnd = end + past.length;
    const args = past ? firstReadingWords(match[2] + past, null, []) : asRead;
    // A copy reads its sources, not the destination it writes, the last of its words that isn't a redirection.
    const copy = /^(?:cp|copy)$/i.test(match[1]);
    const cp = /^cp$/i.test(match[1]);
    const copyOptions = cp ? { shortValues: "tS" } : {};
    const operands = copy
      ? copySources(parseShellArgs(asRead, copyOptions), cp && lastIsSource).concat(
          past ? copySources(parseShellArgs(withoutRedirections(args), copyOptions), cp && lastIsSource) : [],
          shellJoined ? copySources(parseShellArgs(shellJoined, copyOptions), cp && lastIsSource) : [],
        )
      : asRead.concat(past ? args : [], shellJoined || []).filter((arg) => !arg.startsWith("-"));
    // Each operand is read as written and as each path it opens (see opensAs).
    for (const arg of new Set(operands)) {
      if (secretOperandOpened(arg, cwd, shellGlobs)) return arg;
    }
    // `grep -r`, `rg`, `findstr /s`, `diff -r` and `cp -r` read every file under a folder they're given. Their words
    // are read as Guard always read them, up to the first `&` or `|`, and again with the words past a redirection
    // (see wordsPastRedirections) but without what looks like a redirection (see withoutRedirections), so
    // `grep -r x 2>/dev/null` has the working folder walked. For rg an input redirection names what it reads instead
    // of a folder, so it stays a word; piped into (`x | rg`, `x |& rg`), rg has only the first reading. Each reading
    // is walked, never one in place of another; the full one goes first, so a folder named after a redirection
    // (`grep -r x &>log sub`) is the one reported.
    const rg = /^rg$/i.test(match[1]);
    const before = command[match.index - 1];
    const piped = match[0][0] === "|" ? before !== "|" : match[0][0] === "&" && before === "|";
    const targets = (
      rg && piped ? [] : recursiveReadTargets(match[1], withoutRedirections(args, { input: !rg }), lastIsSource)
    ).concat(
      recursiveReadTargets(match[1], asRead, lastIsSource),
      shellJoined ? recursiveReadTargets(match[1], shellJoined, lastIsSource) : [],
    );
    const location = secretInReaderTargets(targets, match[1], cwd, shellGlobs);
    if (location) return location;
  }
  return secretInRedirectsOrOpens(command, cwd, shellGlobs);
}

function inspectTool(tool, event, options = {}) {
  if (tool !== "claude" && tool !== "cursor") return { action: "allow", unsupported: true };
  const toolName = event?.tool_name;
  if (typeof toolName !== "string" || (tool === "claude" && !toolName.startsWith("mcp__"))) return { action: "allow" };
  let args = event?.tool_input;
  // Any assistant may send the arguments as a JSON string; it's checked like an object, never let through unread.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { action: "allow", internalError: true };
    }
  }
  if (args == null || typeof args !== "object") return { action: "allow", internalError: true };
  // Claude Code sends a filesystem MCP server's file reads here, not to the read hook, so the files they name are
  // checked as a read (see inspectRead) as well as their arguments as text.
  let read;
  if (tool === "claude" && MCP_FILE_READS.has(toolName.toLowerCase().split("__").pop())) {
    try {
      read = inspectRead("claude", { ...event, tool_input: args }, options);
    } catch {
      read = { action: "allow", internalError: true };
    }
    if (read.action !== "allow") return read;
  }
  const withRead = (outcome) => {
    if (!read || outcome.action !== "allow") return outcome;
    const merged = { ...outcome };
    for (const flag of ["partial", "internalError", "skipped"]) if (read[flag]) merged[flag] = true;
    if (read.reported) merged.reported = [...(merged.reported || []), ...read.reported];
    return merged;
  };
  try {
    const checkOptions = {
      ...options,
      cwd: event.cwd || event.tool_input?.cwd || options.cwd || process.cwd(),
      key: "tool",
      repeat: false,
      // One deadline for both passes below.
      deadline: hookDeadline(options),
    };
    // Each string is checked as written: serialized, `password: "..."` becomes `password: \"...\"`, which no longer
    // reads as a credential. The serialized form still goes through, for keys that only make sense beside their value.
    const leaves = [];
    const pending = [args];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") leaves.push(item);
      else if (item && typeof item === "object") {
        for (const [key, child] of Object.entries(item).reverse()) {
          pending.push(child);
          if (!Array.isArray(item)) pending.push(key);
        }
      }
    }
    const asWritten = inspectText(tool, leaves.join("\n"), checkOptions);
    if (asWritten.action !== "allow" || asWritten.internalError) return withRead(asWritten);
    return withRead(inspectText(tool, JSON.stringify(args), checkOptions));
  } catch {
    return { action: "allow", internalError: true };
  }
}

const MCP_FILE_READS = new Set(["read_file", "read_text_file", "read_media_file", "read_multiple_files"]);

// `lookups`, when given, is an object whose `count` goes up by one for each disk lookup made: one or more for each PATH
// folder until the executable is found, so a long PATH costs more.
function executableOnPath(name, cwd, env = process.env, platform = process.platform, lookups = undefined) {
  const suffixes = platform === "win32" ? [".exe"] : [""];
  const look = () => {
    if (lookups) lookups.count += 1;
  };
  for (const item of (env.PATH || "").split(path.delimiter)) {
    const directory = item.trim().replace(/^"(.*)"$/, "$1");
    if (!directory || !path.isAbsolute(directory)) continue;
    let realDirectory;
    try {
      look();
      realDirectory = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (pathInside(cwd, realDirectory)) continue;
    for (const suffix of suffixes) {
      try {
        look();
        const executable = fs.realpathSync(path.join(realDirectory, `${name}${suffix}`));
        look();
        if (!fs.statSync(executable).isFile() || pathInside(cwd, executable)) continue;
        if (platform !== "win32") {
          look();
          fs.accessSync(executable, fs.constants.X_OK);
        }
        return executable;
      } catch {
        // Skip missing, inaccessible, or non-executable candidates.
      }
    }
  }
  const error = new Error(`${name} wasn't found on an absolute PATH entry`);
  error.code = "ENOENT";
  error.path = `${name}${platform === "win32" ? ".exe" : ""}`;
  throw error;
}

function runGit(args, cwd = process.cwd(), options = {}) {
  return execFileSync(executableOnPath("git", cwd, process.env, process.platform, options.lookups), args, {
    cwd,
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer ?? MAX_GIT_DIFF_BUFFER,
    // A failed repository probe (such as MCP started outside a Git project) should stay quiet.
    stdio: options.stdio || "pipe",
  });
}

function gitRoot(cwd = process.cwd(), lookups = undefined) {
  return runGit(["rev-parse", "--show-toplevel"], cwd, { lookups }).trim();
}

function clotrIgnoreFor(...directories) {
  for (const directory of directories) {
    const found = repositoryIgnore(directory);
    if (found) return found;
  }
  return { root: null, config: parseClotrIgnore("") };
}

// The .clotrignore of the repository `directory` is in, or null outside one. `lookups` (see executableOnPath) counts
// the lookups made finding Git.
function repositoryIgnore(directory, lookups) {
  // Git isn't started in a folder on another computer (see isRemotePath).
  if (!directory || isRemotePath(directory)) return null;
  try {
    const root = gitRoot(directory, lookups);
    return { root, config: readClotrIgnore(root) };
  } catch {
    // A hook outside a repository has no repository ignore file.
    return null;
  }
}

function atomicWriteFile(file, contents, options = {}) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, contents, { ...options, flag: "wx" });
    if (options.mode !== undefined) fs.chmodSync(temporary, options.mode & 0o777);
    fs.renameSync(temporary, file);
  } catch (error) {
    removeFile(temporary, true);
    throw error;
  }
}

function readConfigFile(file, maxBytes = MAX_SETTINGS_BYTES) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("unsafe-settings-file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes || (before.ino && opened.ino && before.ino !== opened.ino)) {
      throw new Error("unsafe-settings-file");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > maxBytes) throw new Error("unsafe-settings-file");
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)), stat: opened };
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendIgnoredValue(root, value) {
  const file = path.join(root, ".clotrignore");
  const config = readClotrIgnore(root);
  if (!config.valid) throw new Error(config.reason || "invalid-ignore-file");
  const salt = config.salt || crypto.randomBytes(32).toString("hex");
  const fingerprint = valueFingerprint(salt, value);
  if (!fingerprint) throw new Error("invalid-value");
  if (config.fingerprints.has(fingerprint)) return false;
  let content = config.content;
  if (!config.salt) content = `salt: ${salt}\n${content}`;
  content += `${content && !content.endsWith("\n") ? "\n" : ""}fingerprint: ${fingerprint}\n`;
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) throw new Error("ignore-file-too-large");
  let mode = 0o644;
  try {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("unsafe-ignore-file");
    mode = existing.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  atomicWriteFile(file, content, { mode });
  return true;
}

function checkStaged({ cwd = process.cwd(), includePersonalDetails = false } = {}) {
  const root = gitRoot(cwd);
  const ignore = readClotrIgnore(root);
  const names = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"], root, { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const issues = [];
  const notes = [];
  for (const file of names) {
    if (isSecretPath(file, "", root)) {
      // A staged secret file is on its way into history whatever the ignore rules say: a git-ignored one only gets
      // here through a forced add or an old tracked copy. Its contents are not scanned; the name alone stops the
      // commit.
      const ignored = spawnSync(executableOnPath("git", root), ["check-ignore", "--no-index", "-q", "--", file], {
        cwd: root,
      });
      const masked =
        ignored.status === 0 ? "[secret file is staged although git-ignored]" : "[secret file is not git-ignored]";
      issues.push({ file, line: 0, kind: "secret_file", masked });
      continue;
    }
    let diff;
    let partial = false;
    try {
      diff = runGit(
        ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=0", "--", file],
        root,
      );
    } catch (error) {
      if (error.code === "ENOBUFS" && error.stdout != null) {
        diff = Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf8") : String(error.stdout);
        partial = true;
      } else {
        issues.push({
          file,
          line: 0,
          kind: "staged_diff_unreadable",
          masked: "[the staged diff couldn't be read; this commit was stopped]",
        });
        continue;
      }
    }
    // Git calls a UTF-16 text file binary, so a file it won't show as text is read from the index instead.
    const binary = /^(?:Binary files |GIT binary patch)/m.test(diff);
    if (binary && partial) {
      issues.push({
        file,
        line: 0,
        kind: "staged_diff_partial",
        masked:
          "[the staged diff is over 16 MiB, so it wasn't checked and this commit was stopped; split the change or keep large generated files out of the repository]",
      });
      continue;
    }
    let added = [];
    if (binary) ({ added, partial } = newLinesOfStagedText(root, file));
    let lineNumber = 0;
    // The `+++ b/file` header comes before a file's first hunk; inside a hunk, an added line that reads `++ x` shows as
    // `+++ x` and is content like any other. A type change has two file sections, each with its own header.
    let inHunk = false;
    for (const line of binary ? [] : diff.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        lineNumber = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk || !line.startsWith("+")) continue;
      added.push({ line: lineNumber, text: line.slice(1) });
      lineNumber += 1;
    }
    if (partial) {
      const checked = [];
      let bytes = 0;
      for (const entry of added) {
        const remaining = MAX_READ_BYTES - bytes;
        if (remaining <= 0) break;
        const textBytes = Buffer.byteLength(entry.text, "utf8");
        if (textBytes <= remaining) {
          checked.push(entry);
          bytes += textBytes + 1;
        } else {
          checked.push({ ...entry, text: Buffer.from(entry.text, "utf8").subarray(0, remaining).toString("utf8") });
          break;
        }
      }
      issues.push({
        file,
        line: 0,
        kind: "staged_diff_partial",
        masked:
          "[checked the first 256 KiB; the rest wasn't checked, so this commit was stopped; split the change or keep large generated files out of the repository]",
      });
      added = checked;
    }
    if (!added.length) continue;
    // One engine run per file, over the added lines as they sit in the file, with each finding mapped back to its
    // line by offset. A run per line cost about six milliseconds each, minutes on a large file.
    const starts = [];
    let offset = 0;
    for (const entry of added) {
      starts.push(offset);
      offset += entry.text.length + 1;
    }
    const result = check(added.map((entry) => entry.text).join("\n"), {
      ignoreSalt: ignore.valid ? ignore.salt : null,
      ignoreFingerprints: ignore.valid ? [...ignore.fingerprints] : [],
    });
    // The engine's time limit cut the scan short: the rest of the file's added lines weren't checked, so the commit
    // stops, as it does for a diff too large to check.
    if (result.truncated) {
      issues.push({
        file,
        line: 0,
        kind: "staged_check_unfinished",
        masked:
          "[Clotr ran out of time before checking all of this file's added lines, so this commit was stopped; split the change or keep large generated files out of the repository]",
      });
    }
    for (const finding of result.findings) {
      if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf("medium")) continue;
      if (!includePersonalDetails && isPersonalDetail(finding.kind)) continue;
      const issue = { file, line: lineAt(added, starts, finding.start), kind: finding.kind, masked: finding.masked };
      (isInternalAddress(finding.kind) ? notes : issues).push(issue);
    }
  }
  return { root, issues, notes, ignoreWarning: ignore.reason === "raw-value" };
}

// Git calls a UTF-16 file binary, so its diff has no lines to check, and a .env that Windows PowerShell 5.1 wrote
// with ">" is UTF-16. A staged file that decodes as text is read from the index instead, and the lines the last
// commit didn't have are checked like any other added lines. Anything that isn't text still passes unread.
// The whole file is read, as a text diff that size is, and one past Git's buffer is read up to it and marked partial,
// so the caller checks its start and stops the commit.
function newLinesOfStagedText(root, file) {
  const read = (spec) => {
    try {
      const bytes = runGit(["cat-file", "blob", spec], root, {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { text: decodeText(bytes, false), partial: false };
    } catch (error) {
      if (error.code === "ENOBUFS" && Buffer.isBuffer(error.stdout)) {
        return { text: decodeText(error.stdout, true), partial: true };
      }
      return { text: undefined, partial: false }; // not in the last commit
    }
  };
  const staged = read(`:${file}`);
  if (staged.text === undefined) return { added: [], partial: false };
  const before = new Map();
  for (const line of (read(`HEAD:${file}`).text || "").split(/\r?\n/)) before.set(line, (before.get(line) || 0) + 1);
  const added = [];
  staged.text.split(/\r?\n/).forEach((line, index) => {
    if (before.get(line)) before.set(line, before.get(line) - 1);
    else added.push({ line: index + 1, text: line });
  });
  return { added, partial: staged.partial };
}

function lineAt(added, starts, position) {
  if (position < 0) return 0;
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1] <= position) index += 1;
  return added[index].line;
}

function commitCheck(options = {}) {
  const { issues, notes, ignoreWarning } = checkStaged(options);
  if (ignoreWarning) console.error("Use clotr-guard ignore-value.");
  for (const note of notes) console.error(`${formatCommitIssue(note)}, which won't stop this commit`);
  for (const issue of issues) console.error(formatCommitIssue(issue));
  return issues.length ? 1 : 0;
}

function formatCommitIssue(issue) {
  return `${JSON.stringify(issue.file)}:${issue.line} ${issue.kind} (${issue.masked})`;
}

function unavailableCommitCheck(error) {
  if (error.code === "ENOENT" && /^(?:git|git\.exe)$/i.test(error.path || "")) return "git wasn't found";
  if (error.code === "ENOENT" && error.path) {
    const guardRoot = path.resolve(__dirname, "..");
    const missing = path.resolve(error.path);
    if (missing === guardRoot || missing.startsWith(`${guardRoot}${path.sep}`)) return "Guard's own files are missing";
  }
  const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr || "");
  if (error.status === 128 && /not a git repository/i.test(stderr)) return "this isn't a Git repository";
  return null;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// The Guard script a pre-commit hook written by setup runs, or null for any other hook.
function gitHookScript(text) {
  const match = /'((?:[^']|'\\'')*clotr-guard\.js)' commit-check/.exec(text);
  return match ? match[1].replace(/'\\''/g, "'") : null;
}

function isClotrGitHook(text) {
  return gitHookScript(text) !== null || text.includes("clotr-guard commit-check");
}

function gitHookBody(backup, cli = path.resolve(__dirname, "clotr-guard.js")) {
  // A Guard that is gone, say an editor's copy an update replaced, lets the commit through with a line rather than
  // refusing every commit until someone finds the hook.
  const missing = "Clotr Guard wasn't found, so this commit wasn't checked. Set up Clotr's Git check again to fix it.";
  const noNode = "Clotr Guard couldn't run because node isn't on PATH, so this commit wasn't checked.";
  // The shell answers 127 when it can't find node. That skips only Clotr's check, so the hook that was there before
  // still runs.
  return `#!/bin/sh\nif [ -f ${shellQuote(cli)} ]; then\n  ${shellQuote(nodeCommand())} ${shellQuote(cli)} commit-check\n  status=$?\n  if [ "$status" -eq 127 ]; then\n    echo ${shellQuote(noNode)} >&2\n  elif [ "$status" -ne 0 ]; then\n    exit "$status"\n  fi\nelse\n  echo ${shellQuote(missing)} >&2\nfi\nif [ -x ${shellQuote(backup)} ]; then exec ${shellQuote(backup)} "$@"; fi\nexit 0\n`;
}

function gitHookPaths(cwd = process.cwd()) {
  const root = gitRoot(cwd);
  const configuredHooksPath = spawnSync(executableOnPath("git", cwd), ["config", "--path", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
  });
  const commonDirValue = runGit(["rev-parse", "--git-common-dir"], root).trim();
  const commonDir = path.isAbsolute(commonDirValue) ? commonDirValue : path.resolve(root, commonDirValue);
  const standardHooks = path.resolve(commonDir, "hooks");
  if (configuredHooksPath.status === 0) {
    const configured = path.isAbsolute(configuredHooksPath.stdout.trim())
      ? path.resolve(configuredHooksPath.stdout.trim())
      : path.resolve(root, configuredHooksPath.stdout.trim());
    if (configured !== standardHooks) throw new Error("custom-hooks-path");
  }
  const hook = path.join(standardHooks, "pre-commit");
  return { root, commonDir, hook, backup: `${hook}.clotr-guard.bak` };
}

function setupGit({ cwd = process.cwd(), remove = false, dryRun = false } = {}) {
  const { commonDir, hook, backup } = gitHookPaths(cwd);
  const commonStat = fs.lstatSync(commonDir);
  if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) throw new Error("unsafe-git-hooks-path");
  assertNoSymlinkComponents(commonDir, hook);
  assertNoSymlinkComponents(commonDir, backup);
  let existingFile = null;
  let backupFile = null;
  try {
    existingFile = readConfigFile(hook);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    backupFile = readConfigFile(backup);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const existing = existingFile?.content ?? null;
  if (remove) {
    // Only Clotr's own hook comes out. A hook the person wrote around the command, or one another tool put there
    // after setup, stays, and so does the backup beside it.
    const script = existing === null ? null : gitHookScript(existing);
    if (existing !== null && (script === null || existing !== gitHookBody(backup, script))) {
      return { hook, changed: false, remove: true, kept: true };
    }
    // A preview reports what remove would do and leaves the hook and its backup where they are.
    if (existing !== null && dryRun) return { hook, changed: true, remove: true, dryRun };
    if (existing !== null && backupFile) {
      removeFile(hook, true);
      fs.renameSync(backup, hook);
      return { hook, changed: true, remove: true };
    }
    if (existing !== null) {
      removeFile(hook);
      return { hook, changed: true, remove: true };
    }
    return { hook, changed: false, remove: true };
  }
  const body = gitHookBody(backup);
  const existingScript = existing === null ? null : gitHookScript(existing);
  const exactClotrHook = existingScript !== null && existing === gitHookBody(backup, existingScript);
  if (existing !== null && isClotrGitHook(existing)) {
    // Rewrite an exact hook from an older install path. Other hooks, including one that merely calls Guard or has
    // been edited since setup, keep their text and their backup.
    if (!exactClotrHook || existing === body) return { hook, changed: false, remove: false };
    if (!dryRun) {
      atomicWriteFile(hook, body, { mode: 0o755 });
      fs.chmodSync(hook, 0o755);
    }
    return { hook, changed: true, remove: false, dryRun };
  }
  if (!exactClotrHook && backupFile) {
    // A same-named backup is user-owned unless the hook beside it is an exact Clotr hook. Never consume one just
    // because it happens to contain the same bytes as the current hook.
    throw new Error("hook-backup-exists");
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    assertNoSymlinkComponents(commonDir, hook);
    assertNoSymlinkComponents(commonDir, backup);
    if (existingFile && !backupFile) {
      atomicWriteFile(backup, existingFile.content, { mode: existingFile.stat.mode & 0o777 });
    }
    atomicWriteFile(hook, body, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
  }
  return { hook, changed: true, remove: false, dryRun };
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

function hookOutput(tool, outcome) {
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
    const stderr = passNote(outcome, "this prompt will pass");
    if (stderr) {
      if (tool === "cursor") return { stdout: JSON.stringify({ continue: true }), stderr, code: 0 };
      if (tool === "gemini") return { stdout: JSON.stringify({ systemMessage: stderr }), stderr, code: 0 };
      if (tool === "windsurf") return { stderr, code: 0 };
      if (tool === "cline") {
        return { stdout: JSON.stringify({ cancel: false, contextModification: stderr }), stderr, code: 0 };
      }
      if (tool === "codex") return { stdout: "{}", stderr, code: 0 };
      return { stderr, code: 0 };
    }
    if (tool === "cursor") return { stdout: JSON.stringify({ continue: true }), code: 0 };
    if (tool === "gemini") return { stdout: "{}", code: 0 };
    if (tool === "windsurf") return { stdout: "", code: 0 };
    if (tool === "cline") return { stdout: JSON.stringify({ cancel: false }), code: 0 };
    if (tool === "codex") return { stdout: "{}", code: 0 };
    return { stdout: "", code: 0 };
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
  if (outcome.internalError) return hookOutput(tool, { ...outcome, boundary: outcome.boundary || "read" });
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
  if (outcome.searchLimited) {
    const stdout =
      tool === "cursor"
        ? JSON.stringify({ permission: "allow" })
        : tool === "cline"
          ? JSON.stringify({ cancel: false })
          : "{}";
    return { stdout, stderr: SEARCH_WALK_LIMIT_NOTE, code: 0 };
  }
  if (outcome.action !== "block") {
    const stderr = passNote(outcome, "this file will be read");
    if (stderr) {
      if (tool === "cursor") return { stdout: JSON.stringify({ permission: "allow" }), stderr, code: 0 };
      return { stdout: "{}", stderr, code: 0 };
    }
    if (tool === "cursor") return { stdout: JSON.stringify({ permission: "allow" }), code: 0 };
    if (tool === "cline") return { stdout: JSON.stringify({ cancel: false }), code: 0 };
    return { stdout: "{}", code: 0 };
  }
  const where = JSON.stringify(outcome.location || "the requested file");
  const message = outcome.unfinished
    ? `${unfinishedMessage(outcome.findings, where, "so it wasn't read")} Tell the person what you were trying to read and let them decide; don't try to read it another way.`
    : blockReadMessage(outcome.findings, outcome.location);
  const askMessage = outcome.unfinished
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

function addPartialReadMessage(tool, output) {
  if (tool === "windsurf") return { ...output, stderr: appendLine(output.stderr, PARTIAL_READ_MESSAGE) };
  try {
    const response = JSON.parse(output.stdout || "{}");
    if (tool === "cursor") response.user_message = appendLine(response.user_message, PARTIAL_READ_MESSAGE);
    else if (tool === "cline") {
      const field = response.cancel || response.errorMessage ? "errorMessage" : "contextModification";
      response[field] = appendLine(response[field], PARTIAL_READ_MESSAGE);
    } else response.systemMessage = appendLine(response.systemMessage, PARTIAL_READ_MESSAGE);
    return { ...output, stdout: JSON.stringify(response) };
  } catch {
    return { ...output, stderr: appendLine(output.stderr, PARTIAL_READ_MESSAGE) };
  }
}

function readHookOutput(tool, outcome) {
  const output = readHookOutputBase(tool, outcome);
  return outcome.partial ? addPartialReadMessage(tool, output) : output;
}

function boundaryOutput(tool, outcome, boundary) {
  if (outcome.internalError) return hookOutput(tool, { ...outcome, boundary });
  if (outcome.action !== "block") {
    return tool === "cursor" ? { stdout: JSON.stringify({ permission: "allow" }), code: 0 } : { stdout: "{}", code: 0 };
  }
  if (outcome.secretFile) return readHookOutput(tool, { ...outcome, boundary });
  const message = outcome.unfinished
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
  if (boundary === "prompt") {
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
    const invocation = readInvocation(tool, event);
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

function userHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function toolSettingsPath(
  tool,
  { project = false, cwd = process.cwd(), home = userHome(), windsurfJetBrains = false } = {},
) {
  if (!IMPLEMENTED_TOOL_NAMES.includes(tool)) throw new Error("unknown-tool");
  const root = project ? cwd : home;
  if (tool === "claude") return path.join(root, project ? ".claude" : ".claude", "settings.json");
  if (tool === "cursor") return path.join(root, ".cursor", "hooks.json");
  if (tool === "gemini") return path.join(root, ".gemini", "settings.json");
  if (tool === "windsurf") {
    if (!project) {
      return path.join(root, ".codeium", ...(windsurfJetBrains ? [] : ["windsurf"]), "hooks.json");
    }
    // Devin's current Cascade docs prefer .devin. Keep using the documented .windsurf fallback when it
    // already exists and no .devin settings file would take precedence over it.
    const current = path.join(root, ".devin", "hooks.json");
    const legacy = path.join(root, ".windsurf", "hooks.json");
    let currentHasHooks = false;
    try {
      assertNoSymlinkComponents(root, current);
      const existing = readConfigFile(current);
      let settings;
      try {
        settings = JSON.parse(existing.content);
      } catch {
        // Let normal settings validation report a malformed current file instead of writing beside it.
        currentHasHooks = true;
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) currentHasHooks = true;
      else currentHasHooks = Boolean(settings.hooks && Object.keys(settings.hooks).length);
    } catch (error) {
      if (error.code !== "ENOENT") currentHasHooks = true;
    }
    return currentHasHooks || !fs.existsSync(legacy) ? current : legacy;
  }
  if (tool === "cline") {
    return path.join(root, project ? ".clinerules" : "Documents", "Cline", "Hooks");
  }
  return path.join(root, ".codex", "hooks.json");
}

function assertNoSymlinkComponents(root, target) {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("settings-path-outside-root");
  }
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("settings-symbolic-link");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// The Node that the hook commands name. Inside an Electron host (VS Code's extension host runs setup with the
// editor's own binary as process.execPath) that binary would open a window instead of running a script, so the
// command falls back to the node on PATH.
function pathInside(root, candidate) {
  if (!root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Return the actual executable instead of leaving `node` for a hook's later PATH lookup. The workspace is excluded
// because a repository can put its own node.exe or node binary on PATH.
function nodeOnPath(env = process.env, platform = process.platform, cwd = process.cwd()) {
  const extensions = platform === "win32" ? [".exe"] : [""];
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    if (!entry.trim()) continue;
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(directory)) continue;
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (pathInside(cwd, realDirectory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(realDirectory, `node${extension}`);
      try {
        const real = fs.realpathSync(candidate);
        if (!fs.statSync(real).isFile()) continue;
        if (platform !== "win32") fs.accessSync(real, fs.constants.X_OK);
        return real;
      } catch {
        // Keep looking through the absolute PATH entries.
      }
    }
  }
  return null;
}

function nodeCommand({
  env = process.env,
  platform = process.platform,
  electron = process.versions.electron,
  execPath = process.execPath,
  cwd = process.cwd(),
} = {}) {
  if (electron) return nodeOnPath(env, platform, cwd);
  return path.resolve(execPath);
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function hookCommand(tool, mode = "prompt", minimum = "medium", includePersonalDetails = false, options = {}) {
  const platform = options.platform || process.platform;
  const node = options.node || nodeCommand(options);
  if (!node) throw new Error("node-not-found");
  const cli = path.resolve(options.script || path.join(__dirname, "clotr-guard.js"));
  const args = [
    cli,
    mode === "read" ? "read" : mode === "shell" ? "shell" : mode === "tool" ? "tool" : "hook",
    tool,
    "--min-severity",
    minSeverity(minimum),
    ...(includePersonalDetails ? ["--personal-details"] : []),
  ];
  const posixCommand = [node, ...args].map(shellQuote).join(" ");
  const powershellCommand = `& ${[node, ...args].map(powershellQuote).join(" ")}`;
  if (tool === "claude") return { type: "command", command: node, args, timeout: HOOK_TIMEOUT_SECONDS };
  if (tool === "cursor") return { command: platform === "win32" ? powershellCommand : posixCommand };
  if (tool === "gemini") {
    return {
      type: "command",
      command: platform === "win32" ? powershellCommand : posixCommand,
      timeout: HOOK_TIMEOUT_SECONDS * 1000,
    };
  }
  if (tool === "windsurf") {
    return {
      command: posixCommand,
      ...(platform === "win32" ? { powershell: powershellCommand } : {}),
      show_output: true,
    };
  }
  if (tool === "codex") {
    return {
      type: "command",
      command: posixCommand,
      ...(platform === "win32" ? { commandWindows: powershellCommand } : {}),
      timeout: HOOK_TIMEOUT_SECONDS,
    };
  }
  return { type: "command", command: posixCommand, timeout: HOOK_TIMEOUT_SECONDS };
}

function managedHook(tool, mode = "prompt", minimum = "medium", includePersonalDetails = false) {
  const command = hookCommand(tool, mode, minimum, includePersonalDetails);
  // A slow laptop can take several seconds over a full 256 KiB read, and an assistant that gives up on the hook reads
  // the file unchecked, so the limit is generous; a quick check never waits for it.
  return command;
}

function parseHookCommand(source) {
  if (typeof source !== "string" || source.length > 16 * 1024) return null;
  let index = 0;
  const words = [];
  const whitespace = () => {
    while (/\s/.test(source[index] || "")) index += 1;
  };
  whitespace();
  if (source[index] === "&") {
    index += 1;
    whitespace();
  }
  while (index < source.length) {
    let value = "";
    const quote = source[index];
    if (quote === "'" || quote === '"') {
      index += 1;
      let closed = false;
      while (index < source.length) {
        const character = source[index];
        if (quote === "'" && character === "'" && source[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (character === quote) {
          index += 1;
          closed = true;
          if (quote === "'" && source.slice(index, index + 3) === "\\''") {
            value += "'";
            index += 3;
            while (index < source.length && source[index] !== "'") value += source[index++];
            if (source[index] !== "'") return null;
            index += 1;
          }
          break;
        } else value += source[index++];
      }
      if (!closed) return null;
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

function isGuardScriptPath(script, cwd = process.cwd()) {
  if (typeof script !== "string" || !path.isAbsolute(script)) return false;
  const resolved = path.resolve(script);
  if (resolved === path.resolve(__dirname, "clotr-guard.js")) return true;
  if (resolved === path.resolve(__dirname, "../../vscode/guard/bin/clotr-guard.js")) return true;
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

function hookCommandWords(entry, cwd, tool) {
  const keys = Object.keys(entry || {}).sort();
  let words = null;
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
    // Guard 0.1.0 wrote every hook, Claude Code's too, as one command string: `"node" "<script>" hook <tool> ...`.
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
    for (const key of commandKeys) {
      words = parseHookCommand(entry?.[key]);
      if (words) break;
    }
  }
  // 0.1.0 named a bare `node` when one was on PATH; that hook is still Clotr's to replace or remove.
  if (!words || words.length < 6 || (words[0] !== "node" && !path.isAbsolute(words[0]))) return null;
  if (!/^node(?:\.exe)?$/i.test(path.basename(words[0]))) return null;
  return isGuardScriptPath(words[1], cwd) ? words : null;
}

// Match only the command Clotr wrote, with no wrapper or trailing user command that remove might erase.
function hasManagedHook(entry, tool, mode = "prompt", cwd = process.cwd()) {
  const words = hookCommandWords(entry, cwd, tool);
  if (!words || (tool !== "cursor" && tool !== "windsurf" && entry?.type !== "command")) return false;
  const action = mode === "read" ? "read" : mode === "shell" ? "shell" : mode === "tool" ? "tool" : "hook";
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

function mergeHookMode(
  settings,
  tool,
  mode,
  minimum = "medium",
  remove = false,
  includePersonalDetails = false,
  cwd = process.cwd(),
) {
  const out = cloneJson(settings);
  out.hooks = out.hooks || {};
  const event =
    mode === "read" || mode === "shell" || mode === "tool"
      ? {
          claude: "PreToolUse",
          cursor: mode === "tool" ? "beforeMCPExecution" : mode === "shell" ? "beforeShellExecution" : "beforeReadFile",
          gemini: "BeforeTool",
          codex: "PreToolUse",
          windsurf: "pre_read_code",
        }[tool]
      : {
          claude: "UserPromptSubmit",
          cursor: "beforeSubmitPrompt",
          gemini: "BeforeAgent",
          codex: "UserPromptSubmit",
          windsurf: "pre_user_prompt",
        }[tool];
  if (!event) return out;
  if (tool === "cursor" || tool === "windsurf") {
    const hooks = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = hooks.filter((hook) => !hasManagedHook(hook, tool, mode, cwd));
    if (!remove) kept.push(managedHook(tool, mode, minimum, includePersonalDetails));
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  } else {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = groups.map((group) => {
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => !hasManagedHook(hook, tool, mode, cwd))
        : [];
      return { ...group, hooks: handlers };
    });
    if (!remove && (tool === "claude" || tool === "gemini" || tool === "codex" || tool === "windsurf")) {
      const matcher =
        mode === "shell"
          ? "^(?:Bash|PowerShell)$"
          : mode === "read"
            ? {
                claude: "^(?:Read|Grep)$",
                gemini: "^(?:read_file|read_many_files|search_file_content|grep_search)$",
                codex: ".*[Rr]ead.*",
              }[tool]
            : mode === "tool"
              ? "^mcp__"
              : undefined;
      kept.push({ ...(matcher ? { matcher } : {}), hooks: [managedHook(tool, mode, minimum, includePersonalDetails)] });
    }
    const nonempty = kept.filter((group) => group.hooks.length);
    if (nonempty.length) out.hooks[event] = nonempty;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function mergeHook(
  settings,
  tool,
  remove = false,
  minimum = "medium",
  includePersonalDetails = false,
  cwd = process.cwd(),
) {
  // Cursor reads hooks.json only when it carries a version field, so a file Guard starts gets one.
  const base = tool === "cursor" && !remove && !hasOwn(settings, "version") ? { version: 1, ...settings } : settings;
  let next = mergeHookMode(base, tool, "prompt", minimum, remove, includePersonalDetails, cwd);
  // No real Codex read event has confirmed this matcher.
  if (READ_TOOLS.has(tool) && tool !== "codex") {
    next = mergeHookMode(next, tool, "read", minimum, remove, includePersonalDetails, cwd);
  }
  if (tool === "claude") next = mergeHookMode(next, tool, "shell", minimum, remove, includePersonalDetails, cwd);
  if (tool === "claude" || tool === "cursor") {
    next = mergeHookMode(next, tool, "tool", minimum, remove, includePersonalDetails, cwd);
    if (tool === "cursor") next = mergeHookMode(next, tool, "shell", minimum, remove, includePersonalDetails, cwd);
  }
  return next;
}

function validateSettingsShape(settings, tool) {
  if (settings.hooks === undefined) return;
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error("invalid-settings");
  }
  const events = new Set(
    [
      {
        claude: "UserPromptSubmit",
        cursor: "beforeSubmitPrompt",
        gemini: "BeforeAgent",
        codex: "UserPromptSubmit",
        windsurf: "pre_user_prompt",
      }[tool],
      ...(READ_TOOLS.has(tool) && tool !== "codex"
        ? [{ claude: "PreToolUse", cursor: "beforeReadFile", gemini: "BeforeTool", windsurf: "pre_read_code" }[tool]]
        : []),
      ...(tool === "claude" ? ["PreToolUse"] : []),
      ...(tool === "cursor" ? ["beforeShellExecution", "beforeMCPExecution"] : []),
    ].filter(Boolean),
  );
  const flat = tool === "cursor" || tool === "windsurf";
  for (const event of events) {
    if (!hasOwn(settings.hooks, event)) continue;
    const hooks = settings.hooks[event];
    if (!Array.isArray(hooks)) throw new Error("invalid-settings");
    if (flat) {
      if (hooks.some((hook) => !hook || typeof hook !== "object" || Array.isArray(hook))) {
        throw new Error("invalid-settings");
      }
    } else if (
      hooks.some((group) => !group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks))
    ) {
      throw new Error("invalid-settings");
    }
  }
}

function isJsonc(raw) {
  let plain = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      plain += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      plain += char;
    } else if (char === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) {
      const block = raw[i + 1] === "*";
      i += 1;
      while (i + 1 < raw.length && (block ? !(raw[i] === "*" && raw[i + 1] === "/") : raw[i] !== "\n")) {
        if (raw[i] === "\n" || raw[i] === "\r") plain += raw[i];
        else plain += " ";
        i += 1;
      }
      if (block && i + 1 < raw.length) i += 1;
      else if (block) return false;
      plain += " ";
    } else plain += char;
  }

  let withoutTrailingCommas = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < plain.length; i++) {
    const char = plain[i];
    if (quoted) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      withoutTrailingCommas += char;
    } else if (char === ",") {
      let next = i + 1;
      while (/\s/.test(plain[next] || "")) next += 1;
      withoutTrailingCommas += plain[next] === "]" || plain[next] === "}" ? " " : char;
    } else withoutTrailingCommas += char;
  }
  try {
    JSON.parse(withoutTrailingCommas);
    return true;
  } catch {
    return false;
  }
}

function updateSettings(
  tool,
  {
    project = false,
    dryRun = false,
    remove = false,
    cwd,
    home = userHome(),
    minimum = "medium",
    includePersonalDetails = false,
    platform = process.platform,
    windsurfJetBrains = false,
  } = {},
) {
  if (tool === "cline") {
    return updateClineHooks({ project, cwd, home, dryRun, remove, minimum, includePersonalDetails, platform });
  }
  const file = toolSettingsPath(tool, { project, cwd, home, windsurfJetBrains });
  const root = path.resolve(project ? cwd : home);
  assertNoSymlinkComponents(root, file);
  let settings = {};
  let indent = 2;
  let finalNewline = true;
  let fileMode = 0o600;
  let originalContent = null;
  try {
    const existingFile = readConfigFile(file);
    originalContent = existingFile.content;
    fileMode = existingFile.stat.mode & 0o777;
    const raw = existingFile.content;
    try {
      settings = JSON.parse(raw);
    } catch (error) {
      if (isJsonc(raw)) {
        error.code = "settings-jsonc";
        error.file = file;
      }
      throw error;
    }
    if (!settings || Array.isArray(settings) || typeof settings !== "object") throw new Error("invalid-settings");
    // The file keeps the indentation and final newline it came with, so removal leaves it as it was.
    const indented = /^([ \t]+)"/m.exec(raw);
    indent = indented ? indented[1] : raw.trim().length > 2 && !raw.trim().includes("\n") ? 0 : 2;
    finalNewline = raw.endsWith("\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  validateSettingsShape(settings, tool);
  const settingsCwd = cwd || process.cwd();
  const next = mergeHook(settings, tool, remove, minimum, includePersonalDetails, settingsCwd);
  const changed = JSON.stringify(settings) !== JSON.stringify(next);
  const backup = `${file}.clotr-guard.bak`;
  assertNoSymlinkComponents(root, backup);
  let previousBackup = null;
  try {
    previousBackup = readConfigFile(backup);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const guardAlreadyPresent =
    JSON.stringify(mergeHook(settings, tool, true, minimum, includePersonalDetails, settingsCwd)) !==
    JSON.stringify(settings);
  if (!remove && changed && previousBackup && !guardAlreadyPresent) throw new Error("settings-backup-exists");
  if (!dryRun && changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertNoSymlinkComponents(root, file);
    assertNoSymlinkComponents(root, backup);
    let restoreOriginal;
    if (remove && previousBackup) {
      try {
        const originalSettings = JSON.parse(previousBackup.content);
        const restoredSettings = cloneJson(next);
        // Cursor requires a version field, so Guard adds version: 1 to a file that had none. Remove that field with
        // Guard's hooks when restoring the saved original, but keep a version the person already had.
        if (tool === "cursor" && originalSettings.version === undefined && restoredSettings.version === 1) {
          delete restoredSettings.version;
        }
        if (JSON.stringify(originalSettings) === JSON.stringify(restoredSettings)) restoreOriginal = previousBackup;
      } catch {
        // A backup that isn't plain JSON can't be restored as settings.
      }
    }
    if (restoreOriginal) {
      atomicWriteFile(file, restoreOriginal.content, { mode: restoreOriginal.stat.mode & 0o777 });
      removeFile(backup, true);
    } else {
      // Keep the first backup; create one only when Guard adds its first hook to this file.
      if (!remove && originalContent !== null && !guardAlreadyPresent && !previousBackup) {
        atomicWriteFile(backup, originalContent, { mode: fileMode });
      }
      atomicWriteFile(file, `${JSON.stringify(next, null, indent)}${finalNewline ? "\n" : ""}`, { mode: fileMode });
    }
  }
  const event = {
    claude: "UserPromptSubmit",
    cursor: "beforeSubmitPrompt",
    gemini: "BeforeAgent",
    codex: "UserPromptSubmit",
    windsurf: "pre_user_prompt",
  }[tool];
  return {
    file,
    changed,
    settings: next,
    dryRun,
    remove,
    event,
    minimum: minSeverity(minimum),
    ...(tool === "gemini"
      ? {
          notice:
            "Gemini CLI loads .env files by default. Turn this off with advanced.ignoreLocalEnv in settings.json.",
        }
      : {}),
  };
}

function clineHookSource(
  { name, backup, script, node, minimum, includePersonalDetails, chain },
  includeLimitMessage = true,
) {
  const action = name === "UserPromptSubmit" ? "hook" : "read";
  const maxBytes = action === "read" ? MAX_READ_STDIN_BYTES : MAX_STDIN_BYTES;
  const boundary = action === "hook" ? "prompt" : "read";
  const failure = JSON.stringify({
    cancel: true,
    errorMessage: `Clotr couldn't check this ${boundary}, so it was stopped. Check it by hand, then try again.`,
  });
  const tooLarge = JSON.stringify({
    cancel: true,
    errorMessage: `This ${boundary} exceeded Clotr Guard's ${action === "read" ? "64 MiB" : "1 MiB"} hook-input limit, so it was stopped. Shorten it or check it by hand, then try again.`,
  });
  const metadata = {
    version: 1,
    name,
    backup: path.resolve(backup),
    script: path.resolve(script),
    node: path.resolve(node),
    minimum: minSeverity(minimum),
    includePersonalDetails: Boolean(includePersonalDetails),
    chain: Boolean(chain),
  };
  const encodedMetadata = Buffer.from(JSON.stringify(metadata)).toString("base64");
  const args = [
    metadata.script,
    action,
    "cline",
    "--min-severity",
    metadata.minimum,
    ...(metadata.includePersonalDetails ? ["--personal-details"] : []),
  ];
  const previousHook = metadata.chain
    ? `const first=spawnSync(${JSON.stringify(metadata.backup)},{input,encoding:"utf8",timeout:${HOOK_TIMEOUT_SECONDS * 1000},maxBuffer:65536});if(first.error||first.status===null){process.stdout.write(bad);proceed=false}else if(first.status!==0){process.exitCode=first.status;proceed=false}else{try{if(JSON.parse(first.stdout||"{}").cancel){if(first.stdout)process.stdout.write(first.stdout);proceed=false}}catch{}}`
    : "";
  const limitBinding = includeLimitMessage ? `,limit=${JSON.stringify(tooLarge)}` : "";
  const limitOutput = includeLimitMessage ? "limit" : "bad";
  const source = `const fs=require("node:fs"),{spawnSync}=require("node:child_process"),bad=${JSON.stringify(failure)}${limitBinding};const chunks=[];const buffer=Buffer.alloc(65536);let size=0,tooLarge=false;for(;;){const length=Math.min(buffer.length,${maxBytes + 1}-size);if(length<=0){tooLarge=true;break}const count=fs.readSync(0,buffer,0,length,null);if(!count)break;size+=count;chunks.push(Buffer.from(buffer.subarray(0,count)));if(size>${maxBytes}){tooLarge=true;break}}if(tooLarge)process.stdout.write(${limitOutput});else{const input=Buffer.concat(chunks,size).toString("utf8");let proceed=true;${previousHook}if(proceed){const out=spawnSync(${JSON.stringify(metadata.node)},${JSON.stringify(args)},{input,encoding:"utf8",timeout:${HOOK_TIMEOUT_SECONDS * 1000},maxBuffer:65536});if(out.error||out.status!==0)process.stdout.write(bad);else{if(out.stdout)process.stdout.write(out.stdout);if(out.stderr)process.stderr.write(out.stderr)}}}`;
  return `#!/bin/sh\n# clotr-guard-hook:v1:${encodedMetadata}\nexec ${shellQuote(metadata.node)} -e ${shellQuote(source)}\n`;
}

function clineLegacyHookInfo(source, name, backup, cwd) {
  const start =
    '#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const input=require("node:fs").readFileSync(0,"utf8");';
  const outputStart = source.indexOf("const out=spawnSync(", start.length);
  if (outputStart < start.length) return null;
  const chain = source.slice(start.length, outputStart);
  const legacyChain = `const first=spawnSync(${JSON.stringify(backup)},{input,encoding:"utf8"});if(first.status!==0)process.exit(first.status||0);try{if(JSON.parse(first.stdout||"{}").cancel){process.stdout.write(first.stdout);process.exit(0)}}catch{}`;
  if (chain !== "" && chain !== legacyChain) return null;
  const match =
    /^const out=spawnSync\(("(?:[^"\\]|\\.)*"),(\[.*\]),\{input,encoding:"utf8"\}\);if\(out\.stdout\)process\.stdout\.write\(out\.stdout\);if\(out\.stderr\)process\.stderr\.write\(out\.stderr\);process\.exit\(out\.status\|\|0\);\n$/.exec(
      source.slice(outputStart),
    );
  if (!match) return null;
  let executable;
  let args;
  try {
    executable = JSON.parse(match[1]);
    args = JSON.parse(match[2]);
  } catch {
    return null;
  }
  const action = name === "UserPromptSubmit" ? "hook" : "read";
  if (
    typeof executable !== "string" ||
    !(path.isAbsolute(executable) || executable === "node") ||
    (executable !== "node" && !/^node(?:\.exe)?$/i.test(path.basename(executable))) ||
    !Array.isArray(args) ||
    args.length < 5 ||
    args.length > 6 ||
    !isGuardScriptPath(args[0], cwd) ||
    args[1] !== action ||
    args[2] !== "cline" ||
    args[3] !== "--min-severity" ||
    !SEVERITIES.includes(args[4]) ||
    (args.length === 6 && args[5] !== "--personal-details")
  ) {
    return null;
  }
  return { script: args[0], minimum: args[4], includePersonalDetails: args.length === 6, legacy: true };
}

function clineHookInfo(source, name, backup, cwd = process.cwd()) {
  if (typeof source !== "string" || source.length > MAX_SETTINGS_BYTES) return null;
  const marker = /^#!\/bin\/sh\n# clotr-guard-hook:v1:([A-Za-z0-9+/=]+)\n/.exec(source);
  if (!marker) return clineLegacyHookInfo(source, name, backup, cwd);
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
  const expectedKeys = ["backup", "chain", "includePersonalDetails", "minimum", "name", "node", "script", "version"];
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !== expectedKeys.join(",") ||
    metadata.version !== 1 ||
    metadata.name !== name ||
    metadata.backup !== path.resolve(backup) ||
    typeof metadata.chain !== "boolean" ||
    typeof metadata.includePersonalDetails !== "boolean" ||
    !SEVERITIES.includes(metadata.minimum) ||
    !path.isAbsolute(metadata.node) ||
    !/^node(?:\.exe)?$/i.test(path.basename(metadata.node)) ||
    !isGuardScriptPath(metadata.script, cwd)
  ) {
    return null;
  }
  if (source !== clineHookSource(metadata) && source !== clineHookSource(metadata, false)) return null;
  return {
    script: metadata.script,
    minimum: metadata.minimum,
    includePersonalDetails: metadata.includePersonalDetails,
  };
}

function isManagedClineHook(source, name, backup, cwd = process.cwd()) {
  return Boolean(clineHookInfo(source, name, backup, cwd));
}

function updateClineHooks({
  project = false,
  cwd = process.cwd(),
  home = userHome(),
  dryRun = false,
  remove = false,
  minimum = "medium",
  includePersonalDetails = false,
  platform = process.platform,
} = {}) {
  if (!remove && platform === "win32") throw new Error("cline-hooks-unsupported-on-windows");
  const directory = project ? path.join(cwd, ".clinerules", "hooks") : path.join(home, "Documents", "Cline", "Hooks");
  const root = path.resolve(project ? cwd : home);
  assertNoSymlinkComponents(root, directory);
  const cli = path.resolve(__dirname, "clotr-guard.js");
  const node = nodeCommand();
  if (!node) throw new Error("node-not-found");
  const options = includePersonalDetails ? " --personal-details" : "";
  const definitions = {
    UserPromptSubmit: `hook cline --min-severity ${minSeverity(minimum)}${options}`,
    PreToolUse: `read cline --min-severity ${minSeverity(minimum)}${options}`,
  };
  const changed = [];
  if (!remove && !dryRun) {
    fs.mkdirSync(directory, { recursive: true });
    assertNoSymlinkComponents(root, directory);
  }
  for (const name of Object.keys(definitions)) {
    const file = path.join(directory, name);
    const backup = `${file}.clotr-guard.bak`;
    assertNoSymlinkComponents(root, file);
    assertNoSymlinkComponents(root, backup);
    let current = null;
    let previousBackup = null;
    try {
      current = readConfigFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      previousBackup = readConfigFile(backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const own = current && isManagedClineHook(current.content, name, backup, cwd);
    if (remove) {
      if (!own) continue;
      if (!dryRun) {
        removeFile(file);
        if (previousBackup) fs.renameSync(backup, file);
      }
      changed.push(name);
      continue;
    }
    // Clotr's own hook is written again when its Guard path or options change, and keeps chaining to the backup.
    const fileExists = Boolean(current);
    const existing = current?.content || "";
    if (previousBackup && !own) throw new Error("cline-hook-backup-exists");
    const prior = Boolean(previousBackup) || (fileExists && !own);
    const source = clineHookSource({
      name,
      backup,
      script: cli,
      node,
      minimum,
      includePersonalDetails,
      chain: prior,
    });
    if (existing === source) {
      if (!dryRun && process.platform !== "win32" && (current.stat.mode & 0o777) !== 0o755) {
        fs.chmodSync(file, 0o755);
      }
      continue;
    }
    if (!dryRun && fileExists && !own) atomicWriteFile(backup, existing, { mode: current.stat.mode & 0o777 });
    if (!dryRun) {
      assertNoSymlinkComponents(root, file);
      atomicWriteFile(file, source, { mode: 0o755 });
      if (process.platform !== "win32") fs.chmodSync(file, 0o755);
    }
    changed.push(name);
  }
  return {
    file: directory,
    changed: changed.length > 0,
    dryRun,
    remove,
    event: "UserPromptSubmit, PreToolUse",
    hooks: Object.entries(definitions).map(([event, args]) => ({
      event,
      command: `${[node, cli, ...args.split(" ")].map(shellQuote).join(" ")}`,
    })),
    minimum: minSeverity(minimum),
  };
}

// The Guard scripts that Clotr's hooks for one tool run, each with the options it was set up with. An editor that
// carries its own copy of Guard reads this to set the hooks up again when an update moves that copy.
function managedHooks(tool, { project = false, cwd = process.cwd(), home = userHome() } = {}) {
  const found = new Map();
  const add = (script, minimum = "medium", includePersonalDetails = false) => {
    const entry = { script, minimum: minSeverity(minimum), includePersonalDetails };
    found.set(JSON.stringify(entry), entry);
  };
  try {
    if (tool === "git") {
      const { commonDir, hook } = gitHookPaths(cwd);
      assertNoSymlinkComponents(commonDir, hook);
      try {
        const current = readConfigFile(hook);
        const script = gitHookScript(current.content);
        if (script) add(script);
      } catch {
        // A missing or unsafe Git hook isn't a managed hook to repair from the IDE.
      }
    } else if (tool === "cline") {
      const directory = project
        ? path.join(cwd, ".clinerules", "hooks")
        : path.join(home, "Documents", "Cline", "Hooks");
      for (const name of ["UserPromptSubmit", "PreToolUse"]) {
        const file = path.join(directory, name);
        const backup = `${file}.clotr-guard.bak`;
        let current;
        try {
          current = readConfigFile(file);
        } catch {
          continue;
        }
        const info = clineHookInfo(current.content, name, backup, cwd);
        if (info) add(info.script, info.minimum, info.includePersonalDetails);
      }
    } else {
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        for (const mode of ["prompt", "read", "shell", "tool"]) {
          if (!hasManagedHook(value, tool, mode, cwd)) continue;
          const words = hookCommandWords(value, cwd, tool);
          add(words[1], words[5], words.length === 7);
          return;
        }
        Object.values(value).forEach(visit);
      };
      const file = toolSettingsPath(tool, { project, cwd, home });
      if (fs.existsSync(file)) visit(JSON.parse(readConfigFile(file).content).hooks);
    }
  } catch {
    // A settings file that isn't JSON, or a folder that isn't a repository, has no Clotr hooks to list.
  }
  return [...found.values()];
}

function printHelp() {
  console.log(
    `Clotr checks prompts before they reach an AI coding assistant.\n\nUsage\n  clotr-guard check [file] [--json] [--min-severity low|medium|high]\n  clotr-guard hook <tool> [--min-severity low|medium|high]\n  clotr-guard read <tool> [--min-severity low|medium|high]\n  clotr-guard setup <tool> [--project] [--dry-run] [--min-severity low|medium|high]\n  clotr-guard remove <tool> [--project]\n  clotr-guard commit-check [--personal-details]\n  clotr-guard ignore-value [--kind <kind>]\n  clotr-guard setup git [--project] [--dry-run]\n  clotr-guard remove git\n  clotr-guard mcp [--print-config <host>]\n  clotr-guard --version\n  clotr-guard --help\n\nTools: ${IMPLEMENTED_TOOL_NAMES.join(", ")}`,
  );
}

function previewManagedHooks(settings, tool, cwd = process.cwd()) {
  const preview = {};
  for (const [event, entries] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    if (tool === "cursor" || tool === "windsurf") {
      const hooks = entries.filter((entry) =>
        ["prompt", "read", "shell", "tool"].some((mode) => hasManagedHook(entry, tool, mode, cwd)),
      );
      if (hooks.length) preview[event] = hooks;
      continue;
    }
    const groups = entries
      .map((group) => {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return null;
        const hooks = group.hooks.filter((hook) =>
          ["prompt", "read", "shell", "tool"].some((mode) => hasManagedHook(hook, tool, mode, cwd)),
        );
        return hooks.length ? { ...group, hooks } : null;
      })
      .filter(Boolean);
    if (groups.length) preview[event] = groups;
  }
  return preview;
}

// The first option a typed command doesn't take, or null. A value after an option that takes one is skipped.
function unknownOption(action, args) {
  const known = COMMAND_OPTIONS[action];
  if (!known) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!hasOwn(known, arg)) return arg;
    if (known[arg]) index += 1;
  }
  return null;
}

// A name from the command line, shown back without anything that could steer the terminal.
function printable(value) {
  return String(value).replace(/[^\x20-\x7e]/g, "?");
}

// Windows PowerShell pipes text with a byte order mark: UTF-8, or UTF-16 when its output encoding is Unicode.
// Without decoding by the mark, JSON.parse fails and the prompt goes through unchecked.
function decodeInput(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return swapped.swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

function parseInput(maxBytes = MAX_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    process.stdin.on("data", (chunk) => {
      if (tooLarge) return;
      if (size + chunk.length > maxBytes) {
        chunks.length = 0;
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    process.stdin.on("end", () =>
      tooLarge ? reject(new Error("stdin-too-large")) : resolve(decodeInput(Buffer.concat(chunks))),
    );
    process.stdin.on("error", reject);
  });
}

function readCheckFile(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CHECK_BYTES) throw new Error("file-too-large");
    const buffer = Buffer.alloc(MAX_CHECK_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CHECK_BYTES) throw new Error("file-too-large");
    // Read like a file an assistant opens: Windows PowerShell 5.1's `>` writes UTF-16, which as UTF-8 is a NUL between
    // every character and nothing to find. Bytes that aren't text can't be checked, and say so.
    const text = decodeText(buffer.subarray(0, bytesRead), false);
    if (text === undefined) throw new Error("not-text");
    return text;
  } finally {
    fs.closeSync(descriptor);
  }
}

// The shell check's own process (see shellHookOutput). It loads Guard while the hook reads its event, then reads the
// request on stdin and writes its reply on stdout.
const SHELL_CHECK_SOURCE = `"use strict";
const guard = require(process.argv[1]);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(guard.shellCheckReply(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
});`;
const SHELL_CHECK_MAX_REPLY_BYTES = 64 * 1024 * 1024;

// What the shell check's process answers: the outcome, less the engine's result, which the hook's answer doesn't use,
// and whether the repository's .clotrignore holds a raw value, which the hook mentions.
function shellCheckReply({ tool, event, options }) {
  const outcome = { ...inspectShell(tool, event, options) };
  delete outcome.result;
  return { outcome, rawValue: clotrIgnoreFor(options.cwd).config.reason === "raw-value" };
}

// The hook's own Node options, as fork() passes them on, less a debugger's, which would take the same port or wait for
// one, and a test runner's or watcher's, with any value given as the next argument (execArgv holds only options and
// their values, so an argument after one of those that isn't an option is its value).
function shellCheckFlags(execArgv = process.execArgv) {
  const flags = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const flag = execArgv[index];
    if (!/^--(?:inspect|debug|test|watch)/.test(flag)) flags.push(flag);
    else if (!flag.includes("=") && index + 1 < execArgv.length && !execArgv[index + 1].startsWith("-")) index += 1;
  }
  return flags;
}

// Starts the shell check's process. result() sends it the request and gives its reply, or null when it couldn't start,
// crashed, or didn't answer with a reply; stop() ends it if it's still running.
function startShellCheck() {
  const failed = { result: async () => null, stop() {} };
  let child;
  try {
    // --input-type: NODE_OPTIONS can say code given with -e is a module, where `require` isn't defined.
    child = spawn(
      process.execPath,
      [...shellCheckFlags(), "--input-type=commonjs", "-e", SHELL_CHECK_SOURCE, path.join(__dirname, "clotr-guard.js")],
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
  const reply = new Promise((resolve) => {
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

// The folder a hook's event says it runs in.
function hookCwdOf(event, cwd) {
  const workspaceRoot = Array.isArray(event?.workspaceRoots)
    ? event.workspaceRoots.find((root) => typeof root === "string")
    : undefined;
  return event?.cwd || event?.tool_input?.cwd || workspaceRoot || cwd;
}

// The shell hook's answer, given by its deadline whatever happens. The check runs in a process of its own, started
// before the event is read so that its start-up overlaps the read; one still running at the deadline, or a read of the
// event still waiting then, is stopped there, and so is the command. (A worker thread can't promise that: the hook
// can't exit while one is stuck in a call to the system, such as a lookup on a drive that doesn't answer.) A check that
// can't start, crashes or doesn't answer as it should stops the command as a check that hit an internal error.
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
    return outputFor(outcome);
  })().catch(() => outputFor(SHELL_FAILED_OUTCOME));
  try {
    return await Promise.race([checked, timeUp]);
  } finally {
    clearTimeout(timer);
    checker.stop();
    process.stdin.destroy();
  }
}

function isNpxCachePath(scriptPath = __dirname) {
  return path
    .resolve(scriptPath)
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase() === "_npx");
}

function isGuessableIgnoreKind(kind) {
  return (
    typeof kind === "string" &&
    (isPersonalDetail(kind) ||
      /password|passphrase|passcode|pin|card|bank|medical|backup|recovery|tax|security.?answer/i.test(kind))
  );
}

function repeatsShortPattern(value) {
  for (let size = 1; size <= Math.min(12, Math.floor(value.length / 2)); size += 1) {
    let repeats = true;
    for (let index = size; index < value.length; index += 1) {
      if (value[index] !== value[index % size]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

// The salt is committed beside each fingerprint, so people can try likely values offline. Only long, varied tokens
// are safe to fingerprint; natural language, personal details and values labeled as passwords stay out.
function guessableValue(value, kind) {
  const kinds = check(value, { site: "clotr-guard" }).findings.map((finding) => finding.kind);
  if (isGuessableIgnoreKind(kind) || kinds.some(isGuessableIgnoreKind)) return true;
  if (/\s/.test(value) || repeatsShortPattern(value)) return true;
  const characters =
    (/[0-9]/.test(value) ? 10 : 0) +
    (/[a-z]/.test(value) ? 26 : 0) +
    (/[A-Z]/.test(value) ? 26 : 0) +
    (/[^0-9a-zA-Z]/.test(value) ? 33 : 0);
  if (characters < 2 || value.length * Math.log2(characters) < 64 || new Set(value).size < 10) return true;
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits * value.length < 64;
}

// The one way a value's fingerprint gets into .clotrignore, for the CLI and the editor plugins alike.
function addIgnoredValue(root, value, kind) {
  if (!value) throw new Error("empty-value");
  if (guessableValue(value, kind)) throw new Error("guessable-value");
  return appendIgnoredValue(root, value);
}

async function ignoreValue(cwd, kind) {
  const value = (await parseInput()).replace(/\r?\n$/, "");
  addIgnoredValue(gitRoot(cwd), value, kind);
  return 0;
}

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
  // `npx clotr-guard` runs the command named after the package, so MCP clients that start servers that way reach the
  // server through this subcommand. It's the same server as the clotr-mcp command.
  if (action === "mcp") {
    const mcp = require("./clotr-mcp.js");
    if (rest[0] === "--print-config") return mcp.printConfig(rest[1]);
    mcp.serve();
    return undefined;
  }
  if (action === "ignore-value") {
    const kind = rest.length === 2 && rest[0] === "--kind" ? rest[1] : undefined;
    if (rest.length && (!kind || rest.length !== 2 || rest[0] !== "--kind")) {
      console.error("Use clotr-guard ignore-value [--kind <kind>] with the value on stdin.");
      return 2;
    }
    try {
      return await ignoreValue(cwd, kind);
    } catch (error) {
      console.error(
        error.message === "raw-value"
          ? "Use clotr-guard ignore-value."
          : error.message === "guessable-value"
            ? "That value is too easy to guess from its fingerprint. Keep it out of .clotrignore; remove it from the source."
            : "Clotr couldn't update .clotrignore.",
      );
      return 2;
    }
  }
  if (action === "check") {
    const json = rest.includes("--json");
    const file = rest.find(
      (arg, index) => arg !== "--json" && arg !== "--min-severity" && rest[index - 1] !== "--min-severity",
    );
    let input;
    try {
      const ignore = clotrIgnoreFor(cwd);
      if (ignore.config.reason === "raw-value") console.error("Use clotr-guard ignore-value.");
      input = file ? readCheckFile(file) : await parseInput();
      const result = check(input, {
        ignoreSalt: ignore.config.valid ? ignore.config.salt : null,
        ignoreFingerprints: ignore.config.valid ? [...ignore.config.fingerprints] : [],
      });
      const belowMinimum =
        minimum !== "low" &&
        result.findings.some((finding) => SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(minimum));
      result.findings = atLeastSeverity(result.findings, minimum);
      // A text not checked to the end isn't called clean: it returns 1, as a finding does.
      result.decision = result.findings.length || result.truncated ? "block" : "allow";
      if (json) console.log(JSON.stringify(result));
      else for (const finding of result.findings) console.log(`${finding.kind}: ${finding.masked}`);
      if (result.truncated) console.error("Clotr ran out of time, so part of this text wasn't checked.");
      if (belowMinimum) console.error("Clotr found details below the stop level; this text will pass.");
      // Someone at a terminal can't tell silence from a check that never ran; a script reading the output gets none.
      else if (!json && !result.findings.length && !result.truncated && process.stdout.isTTY) {
        console.log("Nothing found.");
      }
      return result.decision === "block" ? 1 : 0;
    } catch {
      console.error("Clotr couldn't check this text.");
      return 2;
    }
  }
  if (action === "commit-check") {
    // Only an unavailable check lets the commit through; a file-level failure is reported by checkStaged.
    try {
      return commitCheck({ cwd, includePersonalDetails: rest.includes("--personal-details") });
    } catch (error) {
      const reason = unavailableCommitCheck(error);
      if (reason) {
        console.error(
          `Clotr Guard couldn't check the staged changes because ${reason}, so this commit wasn't checked.`,
        );
        return 0;
      }
      console.error("Clotr Guard couldn't complete the staged check, so this commit was stopped.");
      return 1;
    }
  }
  if (action === "hook" || action === "read" || action === "shell" || action === "tool") {
    const tool = rest[0];
    if (!IMPLEMENTED_TOOL_NAMES.includes(tool)) {
      console.error("Clotr couldn't identify this hook, so it was stopped. Check it by hand, then try again.");
      return 2;
    }
    const outputFor = (outcome) =>
      action === "read"
        ? readHookOutput(tool, outcome)
        : action === "shell"
          ? boundaryOutput(tool, outcome, "shell")
          : action === "tool"
            ? boundaryOutput(tool, outcome, "tool")
            : hookOutput(tool, outcome);
    // One answer a hook: whatever comes first is printed, and anything after it is left out.
    let answered;
    const answer = (output) => {
      if (answered) return answered.code;
      answered = output;
      if (output.stdout) console.log(output.stdout);
      if (output.stderr) console.error(output.stderr);
      return output.code;
    };
    // The assistants read a hook's answer only when it exits 0 (or 2); a hook that crashes exits 1, which they take
    // as a hook that failed, and they go ahead. So an error nothing else catches, even one after the answer, ends the
    // hook with the answer it gave, or, before it gave one, with the answer a check that fails gives: the shell hook
    // stops the command, as for a check that didn't finish, and the others say they couldn't check and let it through,
    // as their own failed checks do (an error the shell check catches stops the command too, see SHELL_FAILED_OUTCOME).
    // Only in the hook's own process, where nothing else is running.
    if (lastResort) {
      const crashed = () => {
        answer(
          action === "shell"
            ? outputFor(SHELL_UNFINISHED_OUTCOME)
            : outputFor({ action: "allow", internalError: true }),
        );
        process.exitCode = answered.code;
      };
      process.on("uncaughtException", crashed);
      process.on("unhandledRejection", crashed);
    }
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
      event = JSON.parse(await parseInput(action === "read" ? MAX_READ_STDIN_BYTES : MAX_STDIN_BYTES));
    } catch (error) {
      return answer(hookInputFailureOutput(tool, action, { tooLarge: error?.message === "stdin-too-large" }));
    }
    if (!validHookEvent(action, tool, event)) return answer(hookInputFailureOutput(tool, action));
    try {
      const hookCwd = hookCwdOf(event, cwd);
      const outcome =
        action === "read"
          ? inspectRead(tool, event, {
              startedAt,
              cwd: hookCwd,
              minimum,
              includePersonalDetails: rest.includes("--personal-details"),
            })
          : action === "tool"
            ? inspectTool(tool, event, {
                startedAt,
                cwd: hookCwd,
                minimum,
                includePersonalDetails: rest.includes("--personal-details"),
              })
            : inspectPrompt(
                tool,
                tool === "windsurf"
                  ? event?.tool_info?.user_prompt
                  : tool === "cline"
                    ? event?.userPromptSubmit?.prompt
                    : event?.prompt,
                { startedAt, cwd: hookCwd, minimum, includePersonalDetails: rest.includes("--personal-details") },
              );
      const ignore = action === "read" ? clotrIgnoreFor(hookCwd, cwd) : clotrIgnoreFor(hookCwd);
      if (ignore.config.reason === "raw-value") console.error("Use clotr-guard ignore-value.");
      return answer(outputFor(outcome));
    } catch {
      // A failed check lets the prompt, read or tool call through with a note (the shell hook's stops the command).
      return answer(outputFor({ action: "allow", internalError: true }));
    }
  }
  if (action === "setup" || action === "remove") {
    if (action === "setup" && isNpxCachePath(scriptPath)) {
      console.error(NPX_SETUP_MESSAGE);
      return 2;
    }
    const tool = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--min-severity");
    if (tool === "git") {
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
        console.error(
          error.message === "custom-hooks-path"
            ? "Clotr left the configured core.hooksPath unchanged."
            : error.message === "hook-backup-exists"
              ? "An older Clotr backup sits beside the pre-commit hook. Move pre-commit.clotr-guard.bak away, then run setup again."
              : "Clotr couldn't update this repository's Git hook.",
        );
        return 1;
      }
    }
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
      console.log(
        `${action === "remove" ? "Removed" : "Set up"} ${tool} hook at ${result.file}${result.dryRun ? " (dry run)" : ""}${result.changed ? "." : " (no change)."}`,
      );
      if (result.dryRun) {
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
      return 0;
    } catch (error) {
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
      } else console.error("Clotr couldn't update that settings file.");
      return 1;
    }
  }
  printHelp();
  return 2;
}

module.exports = {
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
  // For tests: Guard's shell reader.
  parseShellCommands,
  main,
};

// After the exports, so the MCP server this starts can read them.
// A hook's deadline counts from the process's own start, so starting up and reading the event count against it.
if (require.main === module) {
  main(process.argv.slice(2), { startedAt: performance.timeOrigin, lastResort: true }).then(
    (code) => (process.exitCode = code),
  );
}

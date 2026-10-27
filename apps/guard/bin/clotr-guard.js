#!/usr/bin/env node
/* global require, module, process, console, __dirname, Buffer */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { TextDecoder } = require("util");
const { check, ENGINE_PATH } = require("../lib/engine.js");
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
const HOOK_TIMEOUT_SECONDS = 15;
const SEARCH_WALK_MAX_ENTRIES = 2048;
const SEARCH_WALK_MAX_MS = 250;
const SEARCH_REACHABILITY_TIMEOUT_MS = 250;
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
  if (isInternalAddress(kind)) return true;
  return /email|phone|person|name|address|ssn|social|passport|license.?plate|national.?id|account.?id|student.?id|birth|dob|vin|ip.?address/i.test(
    kind,
  );
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
  } = {},
) {
  const file = path.join(dataDir, `${key}-repeat.json`);
  const state = loadRepeat(file);
  if (typeof text !== "string") return { action: "allow", internalError: true };
  let result;
  try {
    const config = clotrIgnoreFor(cwd).config;
    result = check(text, {
      site: tool,
      ignoreSalt: config.valid ? config.salt : null,
      ignoreFingerprints: config.valid ? [...config.fingerprints, ...ignoreFingerprints] : ignoreFingerprints,
    });
  } catch {
    return { action: "allow", internalError: true };
  }
  const considered = result.findings.filter((finding) => includePersonalDetails || !isPersonalDetail(finding.kind));
  const findings = atLeastSeverity(considered, minimum);
  const belowMinimumPresent = considered.some(
    (finding) => SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(minSeverity(minimum)),
  );
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

function inspectPrompt(tool, prompt, options = {}) {
  return inspectText(tool, prompt, { ...options, key: "prompt" });
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

function isDirectoryTarget(value, cwd) {
  if (typeof value !== "string" || !value) return false;
  try {
    return fs.statSync(path.isAbsolute(value) ? value : path.resolve(cwd, value)).isDirectory();
  } catch {
    return false;
  }
}

function globMatchesPath(pattern, relativePath, depth = 0) {
  if (typeof pattern !== "string" || !pattern) return false;
  let normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("!")) normalized = normalized.slice(1);
  const braces = normalized.match(/\{([^{}]+)\}/);
  if (braces && depth < 4) {
    const alternatives = braces[1].split(",");
    if (alternatives.length <= 16) {
      return alternatives.some((alternative) =>
        globMatchesPath(normalized.replace(braces[0], alternative), relativePath, depth + 1),
      );
    }
  }
  const relative = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = normalized.includes("/") ? [relative] : [path.posix.basename(relative)];
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  try {
    const regex = new RegExp(`^${escaped}$`, "i");
    return candidates.some((candidate) => regex.test(candidate));
  } catch {
    return false;
  }
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
  if (!/[*?]/.test(normalized)) return normalized;
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
  const match = known.find((candidate) => isSecretFile(candidate) && globMatchesPath(normalized, candidate));
  return match || path.posix.basename(normalized) || "the matched secret file";
}

function searchFileFilters(tool, toolName, args) {
  let include = [];
  const exclude = [];
  if (tool === "claude" && toolName === "grep" && typeof args.glob === "string") include = [args.glob];
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
  include = include.filter((pattern) => typeof pattern === "string" && pattern);
  for (let index = exclude.length - 1; index >= 0; index -= 1) {
    if (typeof exclude[index] !== "string" || !exclude[index]) exclude.splice(index, 1);
  }
  for (let index = include.length - 1; index >= 0; index -= 1) {
    if (include[index].startsWith("!")) exclude.push(include.splice(index, 1)[0]);
  }
  return { include, exclude };
}

function filePassesSearchFilters(file, filters, root, absoluteFile) {
  const matches = (pattern) => {
    const unprefixed = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    return path.isAbsolute(unprefixed)
      ? globMatchesPath(pattern, absoluteFile || path.resolve(root, file))
      : globMatchesPath(pattern, file);
  };
  const included = !filters.include.length || filters.include.some(matches);
  if (!included) return false;
  return !filters.exclude.some(matches);
}

// What `rg --files` would list, worked out without ripgrep: hidden paths only when the tool searches them, never
// `.git` or `node_modules`, a `.geminiignore` read with the gitignore-style rules Guard already uses for
// `.clotrignore`, and Git's own answer for `.gitignore`.
function ripgrepRulesCanList(root, relativePath, { hidden, geminiIgnore, respectGitIgnore, deadline }) {
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
    const ignored = gitGrepCanList(root, wanted, deadline);
    if (ignored.limited) return ignored;
    if (!ignored.unavailable && !ignored.reachable) return { reachable: false };
  }
  return { reachable: true };
}

function ripgrepCanList(
  root,
  relativePath,
  {
    hidden = false,
    geminiIgnore = false,
    respectGitIgnore = true,
    deadline = Date.now() + SEARCH_REACHABILITY_TIMEOUT_MS,
  } = {},
) {
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
  const result = spawnSync("rg", args, {
    cwd: root,
    encoding: "buffer",
    timeout,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  // Most machines have no ripgrep on PATH (assistants that use it carry their own copy), so answer the same question
  // from ripgrep's own rules instead of letting every search through.
  if (result.error?.code === "ENOENT") {
    return ripgrepRulesCanList(root, relativePath, { hidden, geminiIgnore, respectGitIgnore, deadline });
  }
  if (result.error || (result.status !== 0 && result.status !== 1)) return { limited: true };
  const wanted = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const files = (result.stdout || Buffer.alloc(0))
    .toString("utf8")
    .split("\0")
    .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""));
  return { reachable: files.includes(wanted) };
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

function searchFileIsReachable(tool, toolName, args, root, relativePath, deadline) {
  const usesRipgrep = (tool === "claude" && toolName === "grep") || (tool === "cline" && toolName === "search_files");
  if (usesRipgrep) {
    const hidden = tool === "claude";
    if (tool === "cline" && !hidden && relativePath.split("/").some((part) => part.startsWith("."))) {
      return { reachable: false };
    }
    return ripgrepCanList(root, relativePath, { hidden, deadline });
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
      if (ignored.limited || ignored.unavailable || !ignored.reachable) return { limited: true };
    }
    if (filtering.respect_gemini_ignore !== false) {
      return ripgrepCanList(root, relativePath, {
        hidden: true,
        geminiIgnore: true,
        respectGitIgnore: false,
        deadline,
      });
    }
    return { reachable: true };
  }
  return { reachable: true };
}

function findSecretInSearchTree(root, filters, tool, toolName, args, options = {}) {
  if (
    path
      .resolve(root)
      .split(path.sep)
      .some((part) => [".git", "node_modules"].includes(part.toLowerCase()))
  ) {
    return {};
  }
  const started = Date.now();
  const maxEntries = options.searchWalkMaxEntries || SEARCH_WALK_MAX_ENTRIES;
  const maxMs = options.searchWalkMaxMs || SEARCH_WALK_MAX_MS;
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    if (entries >= maxEntries || Date.now() - started >= maxMs) return { limited: true };
    const directory = pending.pop();
    let handle;
    try {
      handle = fs.opendirSync(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return { limited: true };
    }
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entries += 1;
        if (entries >= maxEntries || Date.now() - started >= maxMs) return { limited: true };
        if (entry.name === "." || entry.name === "..") continue;
        if (entry.isDirectory()) {
          if (entry.name !== ".git" && entry.name !== "node_modules") {
            pending.push(path.join(directory, entry.name));
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
        if (filePassesSearchFilters(relativePath, filters, root, absolutePath) && isSecretFile(relativePath)) {
          const reachable = searchFileIsReachable(tool, toolName, args, root, relativePath, started + maxMs);
          if (reachable.limited) return { limited: true };
          if (reachable.reachable) return { file: relativePath };
        }
      }
    } catch {
      return { limited: true };
    } finally {
      handle.closeSync();
    }
  }
  return {};
}

function secretSearchFile(tool, name, args, cwd, options = {}) {
  const toolName = String(name || "")
    .toLowerCase()
    .split("__")
    .pop();
  const pathValue = args.path || args.dir_path || args.directory || args.root || args.file_path || args.absolute_path;
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
  for (const pattern of filters.include) {
    if (patternNamesSecret(pattern, cwd)) {
      const namedFile = namedSecretForPattern(pattern);
      const absoluteFile = path.isAbsolute(namedFile) ? namedFile : path.resolve(root, namedFile);
      const relativeFile = path.relative(root, absoluteFile).replace(/\\/g, "/") || path.basename(absoluteFile);
      if (filePassesSearchFilters(relativeFile, filters, root, absoluteFile)) return { file: namedFile };
    }
  }
  const found = findSecretInSearchTree(root, filters, tool, toolName, args, options);
  return found.file ? found : found.limited ? { limited: true } : null;
}

function inspectRead(tool, event, options = {}) {
  if (!READ_TOOLS.has(tool)) return { action: "allow", unsupported: true };
  const cwd = options.cwd || process.cwd();
  const invocation = readInvocation(tool, event);
  if (!invocation.args) {
    return tool === "cline" && !invocation.name
      ? { action: "allow", unsupported: true }
      : { action: "allow", internalError: true };
  }
  const toolName = String(invocation.name || "")
    .toLowerCase()
    .split("__")
    .pop();
  const readNames = new Set(["read", "read_file", "read_files", "read_text_file", "read_resource"]);
  const searchNames = new Set([
    "grep",
    "search_files",
    "search_file_content",
    "grep_search",
    "read_many_files",
    "read_files",
  ]);
  if (!readNames.has(toolName) && !searchNames.has(toolName)) return { action: "allow", unsupported: true };

  const requestedPath = invocation.args.file_path || invocation.args.absolute_path || invocation.args.path;
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
    const secret = secretSearchFile(tool, invocation.name, invocation.args, cwd, options);
    if (secret?.file) return { action: "block", secretFile: true, boundary: "search", location: secret.file };
    if (secret?.limited) return { action: "allow", searchLimited: true };
    return { action: "allow" };
  }
  if (typeof requestedPath !== "string" || !requestedPath) {
    return { action: "allow" };
  }
  if (isSecretOperand(requestedPath, cwd)) return { action: "block", secretFile: true, location: requestedPath };
  const filePath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath);
  if (isSecretOperand(filePath, cwd)) return { action: "block", secretFile: true, location: requestedPath };
  const ignore = clotrIgnoreFor(path.dirname(filePath), options.cwd || process.cwd());
  let bytes;
  let partial;
  try {
    if (tool === "cursor") {
      if (typeof event.content !== "string" || event.content.includes("\0")) return { action: "allow", skipped: true };
      const content = Buffer.from(event.content, "utf8");
      partial = content.length > MAX_READ_BYTES;
      bytes = content.subarray(0, Math.min(content.length, MAX_READ_BYTES));
    } else {
      const descriptor = fs.openSync(filePath, "r");
      try {
        if (!fs.fstatSync(descriptor).isFile()) return { action: "allow", skipped: true };
        // Read up to the cap or the end, never by the reported size: a process's environment file under /proc is a
        // regular file that reports no size at all, and would otherwise be checked one byte long.
        const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (count === 0) break;
          bytesRead += count;
        }
        partial = bytesRead > MAX_READ_BYTES;
        bytes = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } catch {
    return { action: "allow", internalError: true };
  }
  const text = decodeText(bytes, partial);
  if (text === undefined) return { action: "allow", skipped: true };
  if (isSecretPath(filePath, text)) return { action: "block", secretFile: true, location: requestedPath };
  const outcome = inspectText(tool, text, {
    ...options,
    cwd: ignore.root || options.cwd || process.cwd(),
    key: "read",
    repeatValue: filePath,
    // The assistant, not the person, would make a second read, so a read never passes by repeating it.
    repeat: false,
    includePersonalDetails: options.includePersonalDetails === true,
  });
  return { ...outcome, location: requestedPath, ...(partial ? { partial: true } : {}) };
}

function isSecretPath(filePath, content = "", cwd = process.cwd()) {
  if (isSecretFile(filePath, content)) return true;
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (isSecretFile(absolutePath, content)) return true;
  try {
    return isSecretFile(fs.realpathSync(absolutePath), content);
  } catch {
    return false;
  }
}

function globCouldMatchSecret(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (!/[*?]/.test(normalized)) return false;
  const basenamePattern = normalized.split("/").pop();
  const matches = (pattern, candidate) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, "\u0001")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, "(?:.*/)?")
      .replace(/\u0001/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(candidate);
  };
  const candidates = [
    ".env",
    ".env.local",
    ".env.production",
    ".envrc",
    ".npmrc",
    ".netrc",
    "id_rsa",
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
  return candidates.some((candidate) => {
    if (!isSecretFile(candidate)) return false;
    const name = path.posix.basename(candidate);
    return matches(normalized, candidate) || matches(normalized, name) || matches(basenamePattern, name);
  });
}

function isSecretOperand(value, cwd) {
  const filePath = value.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  // A process's environment under /proc holds every variable that process was started with, keys included.
  if (/^\/proc\/(?:self|thread-self|\d+)\/environ$/.test(filePath)) return true;
  return isSecretPath(filePath, "", cwd) || globCouldMatchSecret(filePath);
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
    /(?:^|[;&|\n]\s*)(?:export(?=\s*(?:[;&|\n]|$))|declare\s+-p\b|env(?:\s+-0)?(?=\s*(?:[;&|\n]|$))|printenv(?:\s+[^;&|\n]+)?|set(?=\s*(?:[;&|\n]|$))|(?:Get-ChildItem|Get-Item|gci|ls|dir)\s+Env:)/im;
  if (environmentDumps.test(command)) {
    return { action: "block", secretFile: true, boundary: "shell", location: "the environment" };
  }

  // A reader can also start a subshell, `$(cat .env)` or a backtick, so those openers count as command starts and
  // their closers end the arguments.
  const readers =
    /(?:^|[;&|(`]\s*)\s*(cat|type|Get-Content|less|more|head|tail|grep|sed|awk|base64|xxd|strings|gc|cp|copy|source|tac|nl|od|hexdump|rev|paste|fold|cut|sort|uniq|diff|bat)\b([^;&|)`]*)/gim;
  for (const match of command.matchAll(readers)) {
    const args = match[2].match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const copySourceOnly = /^(?:cp|copy)$/i.test(match[1]);
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      if (isSecretOperand(arg, cwd)) return { action: "block", secretFile: true, boundary: "shell", location: arg };
      if (copySourceOnly) break;
    }
  }
  // Input redirection reads the file whatever the command is: `tr a b < .env`, `cat<.env`, a `while read` loop.
  for (const match of command.matchAll(/<\s*("[^"]*"|'[^']*'|[^\s<>;&|()`]+)/g)) {
    if (isSecretOperand(match[1], cwd)) {
      return { action: "block", secretFile: true, boundary: "shell", location: match[1] };
    }
  }
  const embeddedReaders = /\b(?:open|readFileSync|readFile|createReadStream)\s*\(\s*(['"])([^'"]+)\1/gi;
  for (const match of command.matchAll(embeddedReaders)) {
    if (isSecretOperand(match[2], cwd)) {
      return { action: "block", secretFile: true, boundary: "shell", location: match[2] };
    }
  }
  return inspectText(tool, command, { ...options, cwd, key: "tool", repeat: false });
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
  try {
    return inspectText(tool, JSON.stringify(args), {
      ...options,
      cwd: event.cwd || event.tool_input?.cwd || options.cwd || process.cwd(),
      key: "tool",
      repeat: false,
    });
  } catch {
    return { action: "allow", internalError: true };
  }
}

function executableOnPath(name, cwd, env = process.env, platform = process.platform) {
  const suffixes = platform === "win32" ? [".exe"] : [""];
  for (const item of (env.PATH || "").split(path.delimiter)) {
    const directory = item.trim().replace(/^"(.*)"$/, "$1");
    if (!directory || !path.isAbsolute(directory)) continue;
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (pathInside(cwd, realDirectory)) continue;
    for (const suffix of suffixes) {
      try {
        const executable = fs.realpathSync(path.join(realDirectory, `${name}${suffix}`));
        if (!fs.statSync(executable).isFile() || pathInside(cwd, executable)) continue;
        if (platform !== "win32") fs.accessSync(executable, fs.constants.X_OK);
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
  return execFileSync(executableOnPath("git", cwd), args, {
    cwd,
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer ?? MAX_GIT_DIFF_BUFFER,
    // A failed repository probe (such as MCP started outside a Git project) should stay quiet.
    stdio: options.stdio || "pipe",
  });
}

function gitRoot(cwd = process.cwd()) {
  return runGit(["rev-parse", "--show-toplevel"], cwd).trim();
}

function clotrIgnoreFor(...directories) {
  for (const directory of directories) {
    if (!directory) continue;
    try {
      const root = gitRoot(directory);
      return { root, config: readClotrIgnore(root) };
    } catch {
      // A hook outside a repository has no repository ignore file.
    }
  }
  return { root: null, config: parseClotrIgnore("") };
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
  const names = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root, { encoding: "buffer" })
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
    for (const line of binary ? [] : diff.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        lineNumber = Number(hunk[1]);
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++ ")) continue;
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

  const message = blockMessage(outcome.findings);
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
  const message = blockReadMessage(outcome.findings, outcome.location);
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
        permissionDecisionReason: tool === "claude" ? askReadMessage(outcome.findings, outcome.location) : message,
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
  const message = `Clotr found ${formatFindings(outcome.findings)} in these ${boundary} arguments.`;
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
  const limitOutput = includeLimitMessage ? "JSON.stringify(limit)" : "bad";
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
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
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
  { scriptPath = __dirname, cwd = process.cwd(), home = userHome(), platform = process.platform } = {},
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
      result.decision = result.findings.length ? "block" : "allow";
      if (json) console.log(JSON.stringify(result));
      else for (const finding of result.findings) console.log(`${finding.kind}: ${finding.masked}`);
      if (belowMinimum) console.error("Clotr found details below the stop level; this text will pass.");
      // Someone at a terminal can't tell silence from a check that never ran; a script reading the output gets none.
      else if (!json && !result.findings.length && process.stdout.isTTY) console.log("Nothing found.");
      return result.findings.length ? 1 : 0;
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
    let event;
    try {
      event = JSON.parse(await parseInput(action === "read" ? MAX_READ_STDIN_BYTES : MAX_STDIN_BYTES));
    } catch (error) {
      const output = hookInputFailureOutput(tool, action, { tooLarge: error?.message === "stdin-too-large" });
      if (output.stdout) console.log(output.stdout);
      if (output.stderr) console.error(output.stderr);
      return output.code;
    }
    if (!validHookEvent(action, tool, event)) {
      const output = hookInputFailureOutput(tool, action);
      if (output.stdout) console.log(output.stdout);
      if (output.stderr) console.error(output.stderr);
      return output.code;
    }
    try {
      const workspaceRoot = Array.isArray(event?.workspaceRoots)
        ? event.workspaceRoots.find((root) => typeof root === "string")
        : undefined;
      const hookCwd = event?.cwd || event?.tool_input?.cwd || workspaceRoot || cwd;
      const outcome =
        action === "read"
          ? inspectRead(tool, event, {
              cwd: hookCwd,
              minimum,
              includePersonalDetails: rest.includes("--personal-details"),
            })
          : action === "shell"
            ? inspectShell(tool, event, {
                cwd: hookCwd,
                minimum,
                includePersonalDetails: rest.includes("--personal-details"),
              })
            : action === "tool"
              ? inspectTool(tool, event, {
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
                  { cwd: hookCwd, minimum, includePersonalDetails: rest.includes("--personal-details") },
                );
      const ignore = action === "read" ? clotrIgnoreFor(hookCwd, cwd) : clotrIgnoreFor(hookCwd);
      if (ignore.config.reason === "raw-value") console.error("Use clotr-guard ignore-value.");
      const output =
        action === "read"
          ? readHookOutput(tool, outcome)
          : action === "shell"
            ? boundaryOutput(tool, outcome, "shell")
            : action === "tool"
              ? boundaryOutput(tool, outcome, "tool")
              : hookOutput(tool, outcome);
      if (output.stdout) console.log(output.stdout);
      if (output.stderr) console.error(output.stderr);
      return output.code;
    } catch {
      const outcome = { action: "allow", internalError: true };
      const output =
        action === "read"
          ? readHookOutput(tool, outcome)
          : action === "shell"
            ? boundaryOutput(tool, outcome, "shell")
            : action === "tool"
              ? boundaryOutput(tool, outcome, "tool")
              : hookOutput(tool, outcome);
      if (output.stdout) console.log(output.stdout);
      if (output.stderr) console.error(output.stderr);
      return output.code;
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
  inspectTool,
  addIgnoredValue,
  hookOutput,
  readHookOutput,
  boundaryOutput,
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
  main,
};

// After the exports, so the MCP server this starts can read them.
if (require.main === module) main(process.argv.slice(2)).then((code) => (process.exitCode = code));

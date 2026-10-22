#!/usr/bin/env node
/* global require, module, process, console, __dirname, structuredClone, Buffer */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const { check, ENGINE_PATH } = require("../lib/engine.js");
const { isSecretFile } = require("../lib/secret-files.js");
const {
  parseClotrIgnore,
  readClotrIgnore,
  valueFingerprint,
  pathIgnored,
  pathIgnoredForFile,
} = require("../lib/clotrignore.js");

// The package's own version: a packed copy has nothing outside its folder, so the extension's manifest is out of
// reach there, and a test keeps the two in step.
const VERSION = require("../package.json").version;
const TOOL_NAMES = ["claude", "cursor", "gemini", "codex", "windsurf"];
const IMPLEMENTED_TOOL_NAMES = [...TOOL_NAMES, "cline"];
const SEVERITIES = ["low", "medium", "high"];
const READ_TOOLS = new Set(["claude", "cursor", "gemini", "codex", "windsurf", "cline"]);
const MAX_READ_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_GIT_DIFF_BUFFER = 16 * 1024 * 1024;
// Cursor sends the whole file with a read, so its event gets more room, enough to check the first 256 KiB of a big one.
const MAX_READ_STDIN_BYTES = 64 * 1024 * 1024;
const MAX_CHECK_BYTES = 1024 * 1024;
const HOOK_TIMEOUT_SECONDS = 15;
const NPX_SETUP_MESSAGE = "Install Clotr Guard with npm install -g clotr-guard before setting up hooks.";
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
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (/^[0-9a-f]{64}$/.test(state.hash) && /^[0-9a-f]{64}$/.test(state.salt) && Number.isFinite(state.at)) {
      return state;
    }
  } catch {
    // A damaged repeat record can't authorize a resend.
  }
  return null;
}

function formatFindings(findings) {
  return findings.map((f) => `${f.label} (${f.masked})`).join(", ");
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
    repeatValue = text,
    repeat = true,
    includePersonalDetails = false,
    cwd = process.cwd(),
    ignoreFingerprints = [],
  } = {},
) {
  const file = path.join(dataDir, `${key}-repeat.json`);
  const state = loadRepeat(file);
  if (typeof text !== "string") return { action: "allow", internalError: true };
  if (
    repeat &&
    state &&
    now - state.at >= 0 &&
    now - state.at < 120_000 &&
    promptHash(state.salt, repeatValue) === state.hash
  ) {
    return { action: "allow", repeated: true };
  }

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
  if (!repeat) return { action: "block", findings, belowMinimumPresent };

  try {
    const salt = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ salt, hash: promptHash(salt, repeatValue), at: now })}\n`, {
      mode: 0o600,
    });
  } catch {
    return { action: "allow", internalError: true };
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

function inspectRead(tool, event, options = {}) {
  if (!READ_TOOLS.has(tool)) return { action: "allow", unsupported: true };
  const filePath =
    tool === "cursor"
      ? event?.file_path
      : tool === "windsurf"
        ? event?.tool_info?.file_path
        : tool === "cline"
          ? event?.preToolUse?.parameters?.path || event?.preToolUse?.parameters?.file_path
          : event?.tool_input?.file_path || event?.tool_input?.absolute_path || event?.tool_input?.path;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return { action: "allow" };
  if (isSecretPath(filePath)) return { action: "block", secretFile: true };
  const ignore = clotrIgnoreFor(path.dirname(filePath), options.cwd || process.cwd());
  if (ignore.root && pathIgnoredForFile(ignore.config, ignore.root, filePath)) {
    return { action: "allow", skipped: true };
  }
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
  if (isSecretPath(filePath, text)) return { action: "block", secretFile: true };
  const outcome = inspectText(tool, text, {
    ...options,
    cwd: ignore.root || options.cwd || process.cwd(),
    key: "read",
    repeatValue: filePath,
    // The assistant, not the person, would make a second read, so a read never passes by repeating it.
    repeat: false,
    includePersonalDetails: options.includePersonalDetails === true,
  });
  return partial ? { ...outcome, partial: true } : outcome;
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
  const pattern = filePath.replace(/\\/g, "/").split("/").at(-1);
  if (!/[*?]/.test(pattern)) return false;
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
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
  ];
  return candidates.some((candidate) => isSecretFile(candidate) && regex.test(path.posix.basename(candidate)));
}

function isSecretOperand(value, cwd) {
  const filePath = value.replace(/^['"]|['"]$/g, "");
  // A process's environment under /proc holds every variable that process was started with, keys included.
  if (/^\/proc\/(?:self|thread-self|\d+)\/environ$/.test(filePath)) return true;
  return isSecretPath(filePath, "", cwd) || globCouldMatchSecret(filePath);
}

function inspectShell(tool, event, options = {}) {
  if ((tool !== "claude" && tool !== "cursor") || (tool === "claude" && event?.tool_name !== "Bash")) {
    return { action: "allow" };
  }
  const command = tool === "cursor" ? event?.command : event?.tool_input?.command;
  if (typeof command !== "string") return { action: "allow", internalError: true };
  const fallbackCwd = options.cwd || process.cwd();
  const cwd = tool === "cursor" ? event.cwd || fallbackCwd : event?.tool_input?.cwd || fallbackCwd;
  const environmentDumps =
    /(?:^|[;&|\n]\s*)(?:export(?=\s*(?:[;&|\n]|$))|declare\s+-p\b|env(?:\s+-0)?(?=\s*(?:[;&|\n]|$))|printenv(?:\s+[^;&|\n]+)?|set(?=\s*(?:[;&|\n]|$))|(?:Get-ChildItem|Get-Item|gci|ls|dir)\s+Env:)/im;
  if (environmentDumps.test(command)) return { action: "block", secretFile: true };

  // A reader can also start a subshell, `$(cat .env)` or a backtick, so those openers count as command starts and
  // their closers end the arguments.
  const readers =
    /(?:^|[;&|(`]\s*)\s*(cat|type|Get-Content|less|more|head|tail|grep|sed|awk|base64|xxd|strings|gc|cp|copy|source|tac|nl|od|hexdump|rev|paste|fold|cut|sort|uniq|diff|bat)\b([^;&|)`]*)/gim;
  for (const match of command.matchAll(readers)) {
    const args = match[2].match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const copySourceOnly = /^(?:cp|copy)$/i.test(match[1]);
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      if (isSecretOperand(arg, cwd)) return { action: "block", secretFile: true };
      if (copySourceOnly) break;
    }
  }
  // Input redirection reads the file whatever the command is: `tr a b < .env`, `cat<.env`, a `while read` loop.
  for (const match of command.matchAll(/<\s*("[^"]*"|'[^']*'|[^\s<>;&|()`]+)/g)) {
    if (isSecretOperand(match[1], cwd)) return { action: "block", secretFile: true };
  }
  const embeddedReaders = /\b(?:open|readFileSync|readFile|createReadStream)\s*\(\s*(['"])([^'"]+)\1/gi;
  for (const match of command.matchAll(embeddedReaders)) {
    if (isSecretOperand(match[2], cwd)) return { action: "block", secretFile: true };
  }
  return inspectText(tool, command, { ...options, cwd, key: "tool", repeat: false });
}

function inspectTool(tool, event, options = {}) {
  if (tool !== "claude" && tool !== "cursor") return { action: "allow", unsupported: true };
  const toolName = event?.tool_name;
  if (typeof toolName !== "string" || (tool === "claude" && !toolName.startsWith("mcp__"))) return { action: "allow" };
  let args = event?.tool_input;
  if (tool === "cursor" && typeof args === "string") {
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

function runGit(args, cwd = process.cwd(), options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer ?? MAX_GIT_DIFF_BUFFER,
    stdio: options.stdio,
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
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
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
      const ignored = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", file], { cwd: root });
      const masked =
        ignored.status === 0 ? "[secret file is staged although git-ignored]" : "[secret file is not git-ignored]";
      issues.push({ file, line: 0, kind: "secret_file", masked });
      continue;
    }
    if (pathIgnored(ignore, file)) continue;
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
          "[the staged diff is over 16 MiB, so it wasn't checked and this commit was stopped; if the file belongs in the repository, add its path to .clotrignore]",
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
          "[checked the first 256 KiB; the rest wasn't checked, so this commit was stopped; if the file belongs in the repository, add its path to .clotrignore]",
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
  const configuredHooksPath = spawnSync("git", ["config", "--path", "--get", "core.hooksPath"], {
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
  return { root, hook, backup: `${hook}.clotr-guard.bak` };
}

function setupGit({ cwd = process.cwd(), remove = false, dryRun = false } = {}) {
  const { hook, backup } = gitHookPaths(cwd);
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : null;
  if (remove) {
    // Only Clotr's own hook comes out. A hook the person wrote around the command, or one another tool put there
    // after setup, stays, and so does the backup beside it.
    const script = existing === null ? null : gitHookScript(existing);
    if (existing !== null && (script === null || existing !== gitHookBody(backup, script))) {
      return { hook, changed: false, remove: true, kept: true };
    }
    if (fs.existsSync(backup)) {
      fs.rmSync(hook, { force: true });
      fs.renameSync(backup, hook);
      return { hook, changed: true, remove: true };
    }
    if (existing !== null) {
      fs.rmSync(hook);
      return { hook, changed: true, remove: true };
    }
    return { hook, changed: false, remove: true };
  }
  const body = gitHookBody(backup);
  if (existing !== null && isClotrGitHook(existing)) {
    // Rewrite an exact hook from an older install path. Other hooks, including one that merely calls Guard or has
    // been edited since setup, keep their text and their backup.
    const script = gitHookScript(existing);
    const exactClotrHook = script !== null && existing === gitHookBody(backup, script);
    if (!exactClotrHook || existing === body) return { hook, changed: false, remove: false };
    if (!dryRun) {
      atomicWriteFile(hook, body, { mode: 0o755 });
      fs.chmodSync(hook, 0o755);
    }
    return { hook, changed: true, remove: false, dryRun };
  }
  if (existing !== null && fs.existsSync(backup) && !fs.readFileSync(hook).equals(fs.readFileSync(backup))) {
    // Writing now would keep the older backup over the hook that is there, and removal would bring the wrong one
    // back.
    throw new Error("hook-backup-exists");
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    if (existing !== null && !fs.existsSync(backup)) {
      atomicWriteFile(backup, fs.readFileSync(hook), { mode: fs.statSync(hook).mode });
    }
    atomicWriteFile(hook, body, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
  }
  return { hook, changed: true, remove: false, dryRun };
}

function blockMessage(findings) {
  return `Clotr found ${formatFindings(findings)}. Send this same prompt again within 2 minutes to send it anyway.`;
}

function blockReadMessage(findings) {
  return `Clotr found ${formatFindings(findings)} in this file, so it wasn't read. Tell the person what you were trying to read and let them decide; don't try to read it another way.`;
}

function secretFileMessage() {
  return "This file holds secrets. Work from the variable names or the example file instead, and don't try another way to read it.";
}

function askReadMessage(findings) {
  return `Clotr found ${formatFindings(findings)} in this file. Allow the read only if you want the assistant to see it.`;
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
  const stderr = outcome.belowMinimumPresent
    ? "Clotr found details below the stop level; they will not stop this prompt.\n"
    : "";
  if (tool === "claude" || tool === "windsurf") return { stderr: `${stderr}${message}`, code: 2 };
  if (tool === "cline") return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), code: 0 };
  if (tool === "cursor") return { stdout: JSON.stringify({ continue: false, user_message: message }), stderr, code: 0 };
  if (tool === "gemini") return { stdout: JSON.stringify({ decision: "deny", reason: message }), stderr, code: 0 };
  return { stdout: JSON.stringify({ decision: "block", reason: message }), stderr, code: 0 };
}

function readHookOutputBase(tool, outcome) {
  if (outcome.internalError) return hookOutput(tool, { ...outcome, boundary: outcome.boundary || "read" });
  if (outcome.secretFile) {
    const message = secretFileMessage();
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
  const message = blockReadMessage(outcome.findings);
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
        permissionDecisionReason: tool === "claude" ? askReadMessage(outcome.findings) : message,
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
  if (outcome.secretFile) return readHookOutput(tool, outcome);
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

function userHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function toolSettingsPath(tool, { project = false, cwd = process.cwd(), home = userHome() } = {}) {
  if (!IMPLEMENTED_TOOL_NAMES.includes(tool)) throw new Error("unknown-tool");
  const root = project ? cwd : home;
  if (tool === "claude") return path.join(root, project ? ".claude" : ".claude", "settings.json");
  if (tool === "cursor") return path.join(root, ".cursor", "hooks.json");
  if (tool === "gemini") return path.join(root, ".gemini", "settings.json");
  if (tool === "windsurf") {
    return project ? path.join(root, ".windsurf", "hooks.json") : path.join(root, ".codeium", "windsurf", "hooks.json");
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
function nodeOnPath(env = process.env, platform = process.platform) {
  const extensions = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  return (env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => extensions.some((extension) => fs.existsSync(path.join(directory, `node${extension}`))));
}

function nodeCommand() {
  return process.versions.electron || nodeOnPath() ? "node" : process.execPath;
}

function commandFor() {
  return `"${nodeCommand()}" "${path.resolve(__dirname, "clotr-guard.js")}"`;
}

function managedHook(tool, mode = "prompt", minimum = "medium", includePersonalDetails = false) {
  const personalDetails = includePersonalDetails ? " --personal-details" : "";
  const command = `${commandFor()} ${mode === "read" ? "read" : mode === "shell" ? "shell" : mode === "tool" ? "tool" : "hook"} ${tool} --min-severity ${minSeverity(minimum)}${personalDetails}`;
  // A slow laptop can take several seconds over a full 256 KiB read, and an assistant that gives up on the hook reads
  // the file unchecked, so the limit is generous; a quick check never waits for it.
  if (tool === "windsurf") return { command, show_output: true };
  if (tool === "claude") return { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };
  if (tool === "cursor") return { command };
  if (tool === "gemini") return { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS * 1000 };
  return { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };
}

// A hook is Clotr's by its script name and arguments, not by the Node path in front of them: that path changes
// with every Node upgrade and would otherwise leave a stale hook that removal can't see.
function hasManagedHook(entry, tool, mode = "prompt") {
  const actual = entry?.command || "";
  const action = mode === "read" ? "read" : mode === "shell" ? "shell" : mode === "tool" ? "tool" : "hook";
  const managed = new RegExp(`clotr-guard\\.js"? ${action} ${tool} --min-severity `).test(actual);
  return tool === "cursor" || tool === "windsurf" ? managed : entry?.type === "command" && managed;
}

function mergeHookMode(settings, tool, mode, minimum = "medium", remove = false, includePersonalDetails = false) {
  const out = structuredClone(settings);
  out.hooks ||= {};
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
    const kept = hooks.filter((hook) => !hasManagedHook(hook, tool, mode));
    if (!remove) kept.push(managedHook(tool, mode, minimum, includePersonalDetails));
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  } else {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = groups.map((group) => {
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => !hasManagedHook(hook, tool, mode))
        : [];
      return { ...group, hooks: handlers };
    });
    if (!remove && (tool === "claude" || tool === "gemini" || tool === "codex" || tool === "windsurf")) {
      const matcher =
        mode === "shell"
          ? "Bash"
          : mode === "read"
            ? { claude: "Read", gemini: "^read_file$", codex: ".*[Rr]ead.*" }[tool]
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

function mergeHook(settings, tool, remove = false, minimum = "medium", includePersonalDetails = false) {
  // Cursor reads hooks.json only when it carries a version field, so a file Guard starts gets one.
  const base =
    tool === "cursor" && !remove && !Object.hasOwn(settings, "version") ? { version: 1, ...settings } : settings;
  let next = mergeHookMode(base, tool, "prompt", minimum, remove, includePersonalDetails);
  // No real Codex read event has confirmed this matcher.
  if (READ_TOOLS.has(tool) && tool !== "codex") {
    next = mergeHookMode(next, tool, "read", minimum, remove, includePersonalDetails);
  }
  if (tool === "claude") next = mergeHookMode(next, tool, "shell", minimum, remove, includePersonalDetails);
  if (tool === "claude" || tool === "cursor") {
    next = mergeHookMode(next, tool, "tool", minimum, remove, includePersonalDetails);
    if (tool === "cursor") next = mergeHookMode(next, tool, "shell", minimum, remove, includePersonalDetails);
  }
  return next;
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
  } = {},
) {
  if (tool === "cline") {
    return updateClineHooks({ project, cwd, home, dryRun, remove, minimum, includePersonalDetails });
  }
  const file = toolSettingsPath(tool, { project, cwd, home });
  const root = path.resolve(project ? cwd : home);
  assertNoSymlinkComponents(root, file);
  let settings = {};
  let indent = 2;
  let finalNewline = true;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
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
  }
  const next = mergeHook(settings, tool, remove, minimum, includePersonalDetails);
  const changed = JSON.stringify(settings) !== JSON.stringify(next);
  // A name only Guard writes, so a .bak the person keeps beside their settings is never Guard's to replace or delete.
  const backup = `${file}.clotr-guard.bak`;
  if (!dryRun && changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertNoSymlinkComponents(root, file);
    assertNoSymlinkComponents(root, backup);
    const previousBackup = fs.existsSync(backup) ? fs.readFileSync(backup) : null;
    let restoreOriginal;
    if (remove && previousBackup) {
      try {
        if (JSON.stringify(JSON.parse(previousBackup)) === JSON.stringify(next)) restoreOriginal = previousBackup;
      } catch {
        // A backup that isn't plain JSON can't be restored as settings.
      }
    }
    if (restoreOriginal) {
      atomicWriteFile(file, restoreOriginal, { mode: 0o600 });
      fs.rmSync(backup, { force: true });
    } else {
      // Keep the first backup so another installed copy can restore the same original bytes.
      if (fs.existsSync(file) && (!previousBackup || remove)) {
        atomicWriteFile(backup, fs.readFileSync(file), { mode: 0o600 });
      }
      atomicWriteFile(file, `${JSON.stringify(next, null, indent)}${finalNewline ? "\n" : ""}`, { mode: 0o600 });
      if (remove) fs.rmSync(backup, { force: true });
    }
  }
  if (remove && !dryRun && !changed) fs.rmSync(backup, { force: true });
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
  if (platform === "win32") throw new Error("cline-hooks-unsupported-on-windows");
  const directory = project ? path.join(cwd, ".clinerules", "hooks") : path.join(home, "Documents", "Cline", "Hooks");
  const root = path.resolve(project ? cwd : home);
  assertNoSymlinkComponents(root, directory);
  const cli = path.resolve(__dirname, "clotr-guard.js");
  const options = includePersonalDetails ? " --personal-details" : "";
  const definitions = {
    UserPromptSubmit: `hook cline --min-severity ${minSeverity(minimum)}${options}`,
    PreToolUse: `read cline --min-severity ${minSeverity(minimum)}${options}`,
  };
  const changed = [];
  if (!dryRun) {
    fs.mkdirSync(directory, { recursive: true });
    assertNoSymlinkComponents(root, directory);
  }
  for (const [name, args] of Object.entries(definitions)) {
    const file = path.join(directory, name);
    const backup = `${file}.clotr-guard.bak`;
    assertNoSymlinkComponents(root, file);
    assertNoSymlinkComponents(root, backup);
    if (remove) {
      if (fs.existsSync(backup)) {
        fs.rmSync(file, { force: true });
        fs.renameSync(backup, file);
        changed.push(name);
      } else if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("clotr-guard.js")) {
        fs.rmSync(file);
        changed.push(name);
      }
      continue;
    }
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    // Clotr's own hook is written again when its Guard path or options change, and keeps chaining to the backup.
    const own = existing.includes("clotr-guard.js");
    const prior = own ? fs.existsSync(backup) : Boolean(existing);
    const chain = prior
      ? `const first=spawnSync(${JSON.stringify(file + ".clotr-guard.bak")},{input,encoding:"utf8"});if(first.status!==0)process.exit(first.status||0);try{if(JSON.parse(first.stdout||"{}").cancel){process.stdout.write(first.stdout);process.exit(0)}}catch{}`
      : "";
    const cliArgs = [cli, ...args.split(" ")];
    const source = `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const input=require("node:fs").readFileSync(0,"utf8");${chain}const out=spawnSync(${JSON.stringify(nodeCommand())},${JSON.stringify(cliArgs)},{input,encoding:"utf8"});if(out.stdout)process.stdout.write(out.stdout);if(out.stderr)process.stderr.write(out.stderr);process.exit(out.status||0);\n`;
    if (existing === source) continue;
    if (!dryRun && existing && !own) atomicWriteFile(backup, fs.readFileSync(file), { mode: fs.statSync(file).mode });
    if (!dryRun) {
      assertNoSymlinkComponents(root, file);
      atomicWriteFile(file, source, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    changed.push(name);
  }
  return {
    file: directory,
    changed: changed.length > 0,
    dryRun,
    remove,
    event: "UserPromptSubmit, PreToolUse",
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
      const { hook } = gitHookPaths(cwd);
      const script = fs.existsSync(hook) ? gitHookScript(fs.readFileSync(hook, "utf8")) : null;
      if (script) add(script);
    } else if (tool === "cline") {
      const directory = project
        ? path.join(cwd, ".clinerules", "hooks")
        : path.join(home, "Documents", "Cline", "Hooks");
      for (const name of ["UserPromptSubmit", "PreToolUse"]) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file)) continue;
        const match =
          /\[("(?:[^"\\]|\\.)*clotr-guard\.js"),"(?:hook|read)","cline","--min-severity","(\w+)"(,"--personal-details")?\]/.exec(
            fs.readFileSync(file, "utf8"),
          );
        if (match) add(JSON.parse(match[1]), match[2], Boolean(match[3]));
      }
    } else {
      const file = toolSettingsPath(tool, { project, cwd, home });
      const pattern = new RegExp(
        `"([^"]*clotr-guard\\.js)" (?:hook|read|shell|tool) ${tool} --min-severity (\\w+)( --personal-details)?`,
      );
      const visit = (value) => {
        if (typeof value === "string") {
          const match = pattern.exec(value);
          if (match) add(match[1], match[2], Boolean(match[3]));
        } else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      if (fs.existsSync(file)) visit(JSON.parse(fs.readFileSync(file, "utf8")).hooks);
    }
  } catch {
    // A settings file that isn't JSON, or a folder that isn't a repository, has no Clotr hooks to list.
  }
  return [...found.values()];
}

function printHelp() {
  console.log(
    `Clotr checks prompts before they reach an AI coding assistant.\n\nUsage\n  clotr-guard check [file] [--json] [--min-severity low|medium|high]\n  clotr-guard hook <tool> [--min-severity low|medium|high]\n  clotr-guard read <tool> [--min-severity low|medium|high]\n  clotr-guard setup <tool> [--project] [--dry-run] [--min-severity low|medium|high]\n  clotr-guard remove <tool> [--project]\n  clotr-guard commit-check [--personal-details]\n  clotr-guard ignore-value\n  clotr-guard setup git [--project] [--dry-run]\n  clotr-guard remove git\n  clotr-guard --version\n  clotr-guard --help\n\nTools: ${TOOL_NAMES.join(", ")}`,
  );
}

function parseInput(maxBytes = MAX_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    let input = "";
    let tooLarge = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (tooLarge) return;
      if (Buffer.byteLength(input, "utf8") + Buffer.byteLength(chunk, "utf8") > maxBytes) {
        input = "";
        tooLarge = true;
        return;
      }
      input += chunk;
    });
    process.stdin.on("end", () => (tooLarge ? reject(new Error("stdin-too-large")) : resolve(input)));
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

// The salt is committed with the fingerprints, so a fingerprint keeps a value only as safe as it is hard to guess.
// A personal detail, a password or a card or bank number can be found by trying every likely one, and so can any
// value whose length and characters give fewer than 64 bits to try.
function guessableValue(value) {
  const kinds = check(value, { site: "clotr-guard" }).findings.map((finding) => finding.kind);
  if (kinds.some((kind) => isPersonalDetail(kind) || /password|card|bank|medical|backup/i.test(kind))) return true;
  const characters =
    (/[0-9]/.test(value) ? 10 : 0) +
    (/[a-z]/.test(value) ? 26 : 0) +
    (/[A-Z]/.test(value) ? 26 : 0) +
    (/[^0-9a-zA-Z]/.test(value) ? 33 : 0);
  return value.length * Math.log2(characters) < 64;
}

async function ignoreValue(cwd) {
  const value = (await parseInput()).replace(/\r?\n$/, "");
  if (!value) throw new Error("empty-value");
  if (guessableValue(value)) throw new Error("guessable-value");
  const root = gitRoot(cwd);
  appendIgnoredValue(root, value);
  return 0;
}

async function main(args, { scriptPath = __dirname, cwd = process.cwd() } = {}) {
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
  if (action === "ignore-value") {
    if (rest.length) {
      console.error("Use clotr-guard ignore-value with the value on stdin.");
      return 2;
    }
    try {
      return await ignoreValue(cwd);
    } catch (error) {
      console.error(
        error.message === "raw-value"
          ? "Use clotr-guard ignore-value."
          : error.message === "guessable-value"
            ? "That value is too easy to guess back from its fingerprint, so Clotr won't add it. Add the file's path to .clotrignore instead."
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
      if (file && ignore.root && pathIgnoredForFile(ignore.config, ignore.root, path.resolve(cwd, file))) return 0;
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
    if (!TOOL_NAMES.includes(tool)) {
      console.log("{}");
      return 0;
    }
    try {
      const event = JSON.parse(await parseInput(action === "read" ? MAX_READ_STDIN_BYTES : MAX_STDIN_BYTES));
      const hookCwd = event?.cwd || event?.tool_input?.cwd || cwd;
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
    const tool = rest.find((arg) => !arg.startsWith("--"));
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
    if (tool === "cline") {
      console.error("Cline is not available in this release.");
      return 2;
    }
    if (!TOOL_NAMES.includes(tool)) {
      console.error("Choose claude, cursor, gemini, codex or windsurf.");
      return 2;
    }
    try {
      const result = updateSettings(tool, {
        project: rest.includes("--project"),
        dryRun: rest.includes("--dry-run"),
        remove: action === "remove",
        cwd,
        minimum,
        includePersonalDetails: rest.includes("--personal-details"),
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
        const preview = { event: result.event, hook: result.remove ? null : managedHook(tool) };
        console.log(JSON.stringify(preview, null, 2));
      }
      return 0;
    } catch (error) {
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

if (require.main === module) main(process.argv.slice(2)).then((code) => (process.exitCode = code));

module.exports = {
  TOOL_NAMES,
  gitRoot,
  dataDirectory,
  inspectPrompt,
  inspectRead,
  inspectShell,
  inspectTool,
  hookOutput,
  readHookOutput,
  boundaryOutput,
  toolSettingsPath,
  mergeHook,
  updateSettings,
  updateClineHooks,
  assertNoSymlinkComponents,
  checkStaged,
  commitCheck,
  formatCommitIssue,
  setupGit,
  gitHookScript,
  managedHooks,
  isNpxCachePath,
  nodeCommand,
  main,
};

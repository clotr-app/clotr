"use strict";
/* global require, module, process, Buffer */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { isSecretFile } = require("../secret-files.js");
const { HOOK_CHECK_MAX_MS, READ_TOOLS, OPENABLE_PATH_LENGTH, MAX_READ_BYTES } = require("../limits-and-messages.js");
const { pathReadings } = require("../path-forms/path-readings.js");
const {
  remoteLocation,
  dotsMayLeaveRoot,
  localDevicePaths,
  driveSharePaths,
  trimEndOf,
  windowsTidiedPaths,
  withoutStream,
} = require("../path-forms/windows-paths.js");
const { secretSearchFile } = require("../search-checks/search-check.js");
const { networkMountPointOf, networkPathAnswers } = require("../path-forms/network-mounts.js");
const { hookDeadline, inspectText } = require("../text-checks/check-text.js");
const { shellWalkBudget, checkShellDeadline, ShellCheckTooLong } = require("../check-budget.js");
const { secretByName, isSecretOperand, isSecretPath } = require("../secret-paths/secret-path-check.js");
const { decodeText } = require("../text-checks/text-decode.js");
const { clotrIgnoreFor } = require("../git-repository.js");
const {
  TOOL_ARGS_MAX_DEPTH,
  ADDON_FILE_READS,
  CLAUDE_OPENED_READS,
  CURSOR_DISK_READ,
  addOnFileRead,
} = require("./file-read-tools.js");

// ---------- Reading the hook's event ----------

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
    const namesFile = args?.path || args?.file_path || args?.absolute_path;
    return { name: event?.preToolUse?.toolName || (namesFile ? "read_file" : ""), args };
  }
  return { name: event?.tool_name, args: parseToolInput(event?.tool_input) };
}

// ---------- WSL and network paths ----------

// WSL's share for a Linux distribution's files, `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`,
// either slash, any case. Windows serves it from this computer, so the read hook opens a file there. Only the
// whole host name counts: `\\wsl.localhost.example\` and `\\wsl$x\` are other computers. The rest of Guard
// still leaves it alone.
const WSL_PATH = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/](?!\.\.?(?:[\\/]|$))[^\\/:*?"<>|]+[\\/]/i;

// The WSL path a read opens, a relative one joined to a WSL working folder, tidied as Windows tidies it (`..`
// stops at the distribution's folder); null for any other path.
function wslReadPath(value, cwd) {
  if (typeof value !== "string") return null;
  let full = value;
  if (!/^(?:[A-Za-z]:|[\\/])/.test(value)) {
    if (typeof cwd !== "string" || !WSL_PATH.test(`${cwd}\\`)) return null;
    full = path.win32.join(cwd, value);
  }
  if (!WSL_PATH.test(full)) return null;
  const tidied = path.win32.normalize(full);
  return WSL_PATH.test(tidied) ? tidied : null;
}

// Whether a WSL file opens before `deadline`. A distribution that isn't running starts on the first open,
// which can take a while, and an open can't be stopped once it begins, so it's tried in a child process that
// can be.
function wslAnswers(filePath, deadline) {
  const left = Math.min(deadline ?? Infinity, Date.now() + HOOK_CHECK_MAX_MS) - Date.now();
  if (left <= 0) return false;
  // Half the time left, so the check itself still has time after a slow start.
  const probe = spawnSync(
    process.execPath,
    ["-e", 'const fs=require("fs");fs.closeSync(fs.openSync(process.argv[1],"r"))', filePath],
    { timeout: Math.max(1, Math.floor(left / 2)), stdio: "ignore", windowsHide: true },
  );
  return !probe.error && probe.status === 0;
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

// Whether the hook's deadline (see hookDeadline) has passed, for a loop over what a read names.
function deadlineCheck(options) {
  const deadline = hookDeadline(options);
  return () => deadline !== undefined && Date.now() >= deadline;
}

// The network mount a file is on, as { point, type }, or null (see networkMountPointOf).
// `options.mountTypeOf` stands in for the mount table, for tests, and makes each path its own mount.
function networkMountFor(filePath, options) {
  if (!options.mountTypeOf) return networkMountPointOf(filePath);
  const type = options.mountTypeOf(filePath);
  return type ? { point: filePath, type } : null;
}

// ---------- The read check ----------

// The tool names that read one file, and those that search or read many.
const READ_NAMES = new Set(["read", "read_file", "read_files", "read_text_file", "read_media_file", "read_resource"]);
const SEARCH_NAMES = new Set([
  "grep",
  "search_files",
  "search_file_content",
  "grep_search",
  "read_many_files",
  "read_files",
]);

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
  // A file read through an add-on server's tool is checked as the read it is (see FILE_READ_TABLE). One this
  // computer can't open is judged by its name alone and passes quietly, as a GitHub server's read of a remote
  // repo's file does; the reads Claude Code's tool hook always opened keep their note.
  const addOn = invocation.addOn ? null : addOnFileRead(tool, invocation.name);
  if (addOn) {
    const name = ADDON_FILE_READS.get(addOn) === "paths" ? "read_multiple_files" : "read_file";
    const byName = !(tool === "claude" && CLAUDE_OPENED_READS.has(addOn));
    return inspectReadInvocation(tool, event, { ...invocation, name, addOn: true, byName }, options);
  }
  const toolName = String(invocation.name || "")
    .toLowerCase()
    .split("__")
    .pop();
  if (toolName === "read_multiple_files") return inspectEachListedPath(tool, event, invocation, options, cwd);
  if (!READ_NAMES.has(toolName) && !SEARCH_NAMES.has(toolName)) return { action: "allow", unsupported: true };
  if (!invocation.single) {
    const eachReading = inspectEachReading(tool, event, invocation, options, cwd, toolName);
    if (eachReading) return eachReading;
  }

  // The first path given as text: a number or object under an earlier key opens nothing, and mustn't hide the
  // path.
  const requestedPath = [invocation.args.file_path, invocation.args.absolute_path, invocation.args.path].find(
    (value) => typeof value === "string" && value,
  );
  if (SEARCH_NAMES.has(toolName)) return inspectSearchRead(tool, invocation, options, cwd, toolName, requestedPath);
  if (typeof requestedPath !== "string" || !requestedPath) {
    return { action: "allow" };
  }
  return inspectFileRead(tool, event, invocation, options, cwd, requestedPath);
}

// The filesystem MCP server's read_multiple_files reads each of its `paths`: each is checked as a read of its
// own.
function inspectEachListedPath(tool, event, invocation, options, cwd) {
  const paths = Array.isArray(invocation.args.paths) ? invocation.args.paths : [];
  const outcomes = [];
  const late = deadlineCheck(options);
  // A network mount that answered once is taken as answering for the rest of the call (see
  // networkMountFor).
  const each = { ...options, mountsAnswered: options.mountsAnswered || new Set() };
  for (const item of paths) {
    if (late()) return { action: "block", unfinished: true, location: cwd };
    if (typeof item !== "string" || !item) continue;
    const outcome = inspectReadInvocation(
      tool,
      event,
      { ...invocation, name: "read_file", args: { path: item } },
      each,
    );
    if (outcome.action !== "allow") return outcome;
    outcomes.push(outcome);
  }
  return mergedReadOutcomes(outcomes);
}

// A tool may take its path under any of these keys, and which one it reads when given more than one differs
// between tools and versions (an MCP server reads `path`, Claude's Read `file_path`), so each path given is
// checked; a path under the home folder (`~/...`) as the file a tool that expands `~` opens (see
// pathReadings), and as written only when the working folder has a `~` of its own. Each is checked as a
// read or search of that path alone. Null when there's one path, as given, to check below.
function inspectEachReading(tool, event, invocation, options, cwd, toolName) {
  const keys = SEARCH_NAMES.has(toolName)
    ? ["path", "dir_path", "directory", "root", "file_path", "absolute_path"]
    : ["file_path", "absolute_path", "path"];
  const given = keys.map((key) => invocation.args[key]).filter((value) => typeof value === "string" && value);
  const readings = homeReadings(given, cwd);
  if (!(readings.length > 1 || (readings.length === 1 && readings[0] !== given[0]))) return null;
  const outcomes = [];
  const late = deadlineCheck(options);
  for (const reading of readings) {
    if (late()) return { action: "block", unfinished: true, location: given[0] };
    const args = { ...invocation.args };
    for (const key of keys) delete args[key];
    args[keys[0]] = reading;
    const outcome = inspectReadInvocation(tool, event, { ...invocation, args, single: true }, options);
    if (outcome.action !== "allow") return outcome;
    outcomes.push(outcome);
  }
  return mergedReadOutcomes(outcomes);
}

// A search tool's read: the secret file it could reach, if any (see secretSearchFile).
function inspectSearchRead(tool, invocation, options, cwd, toolName, requestedPath) {
  if (!readsContent(tool, toolName, invocation.args)) return { action: "allow" };
  const geminiReadMany = tool === "gemini" && toolName === "read_many_files";
  if (geminiReadMany && !hasIncludePattern(invocation.args.include)) return { action: "allow" };
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

// One file's read: its name, the paths that can open it, what they hold, and that text's check.
function inspectFileRead(tool, event, invocation, options, cwd, requestedPath) {
  // The path checks share the hook's deadline: one still running at it holds the read as one that didn't
  // finish.
  const deadline = hookDeadline(options);
  let budget;
  if (deadline !== undefined) {
    const deadlines = { lookupDeadline: deadline, drivePathDeadline: deadline, checkDeadline: deadline };
    budget = { ...shellWalkBudget(options), ...deadlines };
  }
  const secret = { action: "block", secretFile: true, location: requestedPath };
  // Cursor's read hook hands over what the read gets; a read from its tool hook is read from the file here.
  const givenContent = tool === "cursor" && !invocation.onDisk;
  // Its tool hook only glances at the start of each file for a secret file's shape (see CURSOR_DISK_READ).
  const glance = tool === "cursor" && invocation.onDisk;
  const read = { tool, event, invocation, options, cwd, requestedPath, deadline, budget, secret };
  Object.assign(read, { givenContent, glance });
  const located = locateRead(read);
  if (located.outcome) return located.outcome;
  const taken = takeReads(read, located);
  if (taken.outcome) return taken.outcome;
  return checkReadTexts(read, located, taken.reads);
}

// Where a read opens: `opened`, the paths that can open the file, with `remote`, `wsl` and `filePath`; or an
// `outcome` when its name already answers.
function locateRead({ invocation, options, cwd, requestedPath, deadline, budget, secret, givenContent }) {
  // A path too long for the system to open, as written and resolved, opens nothing, so it's judged by its
  // name alone.
  const tooLong =
    requestedPath.length > OPENABLE_PATH_LENGTH && path.resolve(cwd, requestedPath).length > OPENABLE_PATH_LENGTH;
  // A file on another computer is judged by its name, and Guard doesn't open it (see isRemotePath); a drive's
  // share on this computer is read from its drive (see driveSharePaths), and a WSL file is opened where it is
  // (see WSL_PATH).
  const wsl = tooLong ? null : wslReadPath(requestedPath, cwd);
  let remote = !wsl && (tooLong || remoteLocation(requestedPath, cwd));
  const filePath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath);
  // A file on a network share is looked up and read below, so it's looked at first where the look can be
  // ended (see networkPathAnswers), once per mount in a call that reads many files.
  const mount = !remote && !wsl && networkMountFor(filePath, options);
  if (mount && !options.mountsAnswered?.has(mount.point)) {
    if (!networkPathAnswers(filePath, deadline)) {
      return { outcome: { action: "block", unfinished: true, location: requestedPath } };
    }
    options.mountsAnswered?.add(mount.point);
  }
  // The paths that can open the file, each read (see below): a path Windows tidies may open only as what it
  // opens.
  let opened;
  try {
    const named = tooLong
      ? secretByName(requestedPath, cwd, budget)
      : isSecretOperand(requestedPath, cwd, undefined, budget);
    if (named) return { outcome: secret };
    opened = remoteDrivePaths(requestedPath, cwd, budget, remote && !tooLong);
    if (opened.length) remote = false;
    else {
      if (remote && !givenContent) {
        return { outcome: invocation.byName ? { action: "allow" } : { action: "allow", internalError: true } };
      }
      if (wsl) opened = [wsl];
      else if (!remote && isSecretOperand(filePath, cwd, undefined, budget)) return { outcome: secret };
      else opened = remote ? [] : [filePath, ...(windowsTidiedPaths(filePath, cwd) || [])];
    }
    if (budget) checkShellDeadline(budget);
  } catch (error) {
    if (error instanceof ShellCheckTooLong) {
      return { outcome: { action: "block", unfinished: true, location: requestedPath } };
    }
    throw error;
  }
  return { opened, remote, wsl, filePath };
}

// The drive paths a remote path opens on this computer, with the stream it names: a device path to a drive (see
// localDevicePaths), not where its dots could take it to another computer (see dotsMayLeaveRoot), and this
// computer's own shares. None for a path that isn't `remoteDrive`.
function remoteDrivePaths(requestedPath, cwd, budget, remoteDrive) {
  const devices = remoteDrive && !dotsMayLeaveRoot(requestedPath) ? localDevicePaths(requestedPath) || [] : [];
  const shares = remoteDrive && !devices.length ? driveSharePaths(requestedPath, cwd, { budget }) || [] : [];
  // Those drive paths are named without a stream, as a secret file's name is judged, but the read opens the
  // stream its last part names (`notes.txt:hidden`), as written or as Windows tidies it
  // (`notes.txt:hidden.`).
  const stream = streamOf(requestedPath.replace(/['"]$/, ""));
  const streams = [...new Set([stream, trimEndOf(stream, ". ")])].filter((item) => item === "" || item.length > 1);
  const ownShares = shares.filter((item) => item.loopback && !item.dotted).map((item) => item.drive);
  return [...devices, ...ownShares].flatMap((drive) => (stream ? streams.map((item) => `${drive}${item}`) : [drive]));
}

// What the read gets: Cursor's hook hands over the text itself. Elsewhere, each path that can open the file
// is read, as programs differ in which one they open (`\\.\...\keys.txt.` opens `keys.txt`, Node's
// `C:\...\keys.txt.` opens the name as written): when more than one opens a file, each is checked, so a
// file planted under the other name can't stand in for the one read. Two paths to the same file are read
// once. Gives `reads`, or an `outcome`.
function takeReads({ event, invocation, options, deadline, givenContent, glance }, { opened, wsl, filePath }) {
  try {
    if (givenContent) {
      if (typeof event.content !== "string" || event.content.includes("\0")) {
        return { outcome: { action: "allow", skipped: true } };
      }
      const content = Buffer.from(event.content, "utf8");
      const given = {
        filePath: opened.length ? opened[0] : filePath,
        partial: content.length > MAX_READ_BYTES,
        bytes: content.subarray(0, Math.min(content.length, MAX_READ_BYTES)),
      };
      return { reads: [given] };
    }
    // On Windows, a WSL file is first opened where the open can be stopped in time (see wslAnswers).
    // `options.wslAnswers` stands in for the probe, for tests.
    if (wsl && process.platform === "win32" && !(options.wslAnswers || wslAnswers)(wsl, deadline)) {
      return { outcome: { action: "allow", internalError: true } };
    }
    // A file past the glance's time was judged by its name above.
    if (glance && Date.now() >= invocation.diskUntil) return { outcome: { action: "allow" } };
    const { reads, notFile, failure } = readOpenedPaths(opened, glance);
    if (!reads.length) {
      if (notFile) return { outcome: { action: "allow", skipped: true } };
      if (invocation.byName) return { outcome: { action: "allow" } };
      throw failure || new Error("nothing to read");
    }
    return { reads };
  } catch {
    return { outcome: { action: "allow", internalError: true } };
  }
}

// Reads each path that can open the file, once per file and stream: `reads`, with `notFile` when one was a
// folder or a device, and the last `failure`.
function readOpenedPaths(opened, glance) {
  const reads = [];
  const seen = [];
  let notFile = false;
  let failure;
  for (const candidate of opened) {
    // A path that isn't a plain file is looked at, not opened (see notPlainFile).
    const looked = lookAt(candidate);
    if (looked && !looked.isFile()) {
      if (notPlainFile(looked)) failure = new Error("not a plain file");
      else notFile = true;
      continue;
    }
    let descriptor;
    try {
      descriptor = fs.openSync(candidate, OPEN_FOR_READ);
    } catch (error) {
      failure = error;
      continue;
    }
    try {
      const stats = fs.fstatSync(descriptor, { bigint: true });
      if (!stats.isFile()) {
        if (notPlainFile(stats)) failure = new Error("not a plain file");
        else notFile = true;
        continue;
      }
      // A file's streams share its number, so the stream read is part of what makes two reads the same.
      const same = (item) => item.dev === stats.dev && item.ino === stats.ino && item.stream === streamOf(candidate);
      if (stats.ino && seen.some(same)) continue;
      seen.push({ dev: stats.dev, ino: stats.ino, stream: streamOf(candidate) });
      reads.push({ filePath: candidate, ...readUpToCap(descriptor, glance ? CURSOR_DISK_READ.bytes : undefined) });
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return { reads, notFile, failure };
}

// The read's text, checked: a secret file by its content, then the content check (see inspectText).
function checkReadTexts(read, { remote, wsl }, reads) {
  const { tool, options, cwd, requestedPath, deadline, budget, secret, glance } = read;
  const texts = reads
    .map((item) => ({ ...item, text: decodeText(item.bytes, item.partial) }))
    .filter((item) => item.text !== undefined);
  if (!texts.length) return glance ? { action: "allow" } : { action: "allow", skipped: true };
  try {
    for (const item of texts) {
      const textIsSecret =
        remote || wsl
          ? isSecretFile(requestedPath, item.text)
          : isSecretPath(item.filePath, item.text, cwd, { budget });
      if (textIsSecret) return secret;
    }
  } catch (error) {
    if (error instanceof ShellCheckTooLong) return { action: "block", unfinished: true, location: requestedPath };
    throw error;
  }
  if (glance) return { action: "allow" };
  const outcomes = texts.map((item) => {
    const ignoreFolder = remote || wsl ? null : path.dirname(item.filePath);
    const ignore = clotrIgnoreFor(ignoreFolder, options.cwd || process.cwd());
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
  return mergedTextOutcomes(outcomes);
}

// Every read goes through, with what any of them has to say: a part past the cap, a check that hit an
// error, or what was found below the stop level.
function mergedTextOutcomes(outcomes) {
  const merged = { ...outcomes[0] };
  for (const outcome of outcomes.slice(1)) {
    if (outcome.partial) merged.partial = true;
    if (outcome.internalError) merged.internalError = true;
    if (outcome.belowMinimumOnly) merged.belowMinimumOnly = true;
    if (outcome.reported) merged.reported = [...(merged.reported || []), ...outcome.reported];
  }
  return merged;
}

// Each path given, and a path under the home folder (`~/...`) as the file a tool that expands `~` opens (see
// pathReadings), as written only when the working folder has a `~` of its own.
function homeReadings(given, cwd) {
  const readings = [];
  for (const value of given) {
    const expanded = pathReadings(value, { homeOnly: true });
    // A working folder on another computer is never looked up (see isRemotePath): its `~` is kept, judged by
    // name.
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
  return readings;
}

// Whether a search reads files' content: not Claude's Grep listing names only, nor Gemini's search with
// `names_only`.
function readsContent(tool, toolName, args) {
  if (tool === "claude" && toolName === "grep" && args.output_mode !== "content") return false;
  const geminiSearch = tool === "gemini" && ["search_file_content", "grep_search"].includes(toolName);
  return !(geminiSearch && args.names_only === true);
}

// Whether read_many_files' `include` gives a pattern: a string, or a list with one.
function hasIncludePattern(include) {
  if (Array.isArray(include)) return include.some((pattern) => typeof pattern === "string" && pattern);
  return typeof include === "string" && include;
}

// The stream named on the last part a path opens, `.` and `..` resolved: `:hidden` in `notes.txt:hidden`,
// also in `notes.txt:hidden\.` (or `::$DATA`), in a relative `notes.txt:hidden`, and where `..` climbs to the
// share's or the drive's top (`\\localhost\C$\x\..\..\notes.txt:hidden`); "" for none. A drive at the start
// (`C:notes.txt`) is no stream.
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

// Opening a named pipe waits until something writes to it, so it's opened without waiting where the system
// allows it.
const OPEN_FOR_READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

// What a path is before it's opened, or null when the look fails and the open decides.
function lookAt(candidate) {
  try {
    return fs.statSync(candidate);
  } catch {
    return null;
  }
}

// A pipe or a socket counts as a file that couldn't be opened: its open waits for the other end, or fails. A
// folder or a device is passed over, as it was when opened.
function notPlainFile(stats) {
  return stats.isFIFO() || stats.isSocket();
}

// Up to `cap` bytes of an open file (MAX_READ_BYTES unless given), and whether there was more. Read up to the
// cap or the end, never by the reported size: a process's environment file under /proc is a regular file that
// reports no size at all, and would otherwise be checked one byte long.
function readUpToCap(descriptor, cap = MAX_READ_BYTES) {
  const buffer = Buffer.alloc(cap + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (count === 0) break;
    bytesRead += count;
  }
  return {
    partial: bytesRead > cap,
    bytes: buffer.subarray(0, Math.min(bytesRead, cap)),
  };
}

// ---------- Add-on tool calls ----------

function inspectTool(tool, event, options = {}) {
  if (tool !== "claude" && tool !== "cursor") return { action: "allow", unsupported: true };
  const toolName = event?.tool_name;
  if (typeof toolName !== "string" || (tool === "claude" && !toolName.startsWith("mcp__"))) return { action: "allow" };
  let args = event?.tool_input;
  // Any assistant may send the arguments as a JSON string; it's checked like an object, never let through
  // unread.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { action: "block", failed: true };
    }
  }
  if (args == null || typeof args !== "object") return { action: "block", failed: true };
  // Claude Code and Cursor send an add-on server's file reads here, not to the read hook, so the files they
  // name are checked as a read (see FILE_READ_TABLE) as well as their arguments as text.
  let read;
  if (addOnFileRead(tool, toolName)) {
    try {
      const invocation = { name: toolName, args: parseToolInput(args), onDisk: true };
      if (tool === "cursor") invocation.diskUntil = Date.now() + CURSOR_DISK_READ.ms;
      read = invocation.args
        ? inspectReadInvocation(tool, { ...event, tool_input: args }, invocation, options)
        : { action: "block", failed: true };
    } catch {
      read = { action: "block", failed: true };
    }
    if (read.action !== "allow") return read;
  }
  function withRead(outcome) {
    if (!read || outcome.action !== "allow") return outcome;
    const merged = { ...outcome };
    for (const flag of ["partial", "internalError", "skipped"]) if (read[flag]) merged[flag] = true;
    if (read.reported) merged.reported = [...(merged.reported || []), ...read.reported];
    return merged;
  }
  try {
    const checkOptions = {
      ...options,
      cwd: event.cwd || event.tool_input?.cwd || options.cwd || process.cwd(),
      key: "tool",
      repeat: false,
      // One deadline for both passes below.
      deadline: hookDeadline(options),
    };
    // Each string is checked as written: serialized, `password: "..."` becomes `password: \"...\"`, which no
    // longer reads as a credential. The serialized form still goes through, for keys that only make sense
    // beside their value. Arguments nested past TOOL_ARGS_MAX_DEPTH get the answer a check that ran out of
    // time gets.
    const leaves = stringLeaves(args);
    if (leaves === null) return { action: "block", unfinished: true };
    const asWritten = inspectText(tool, leaves.join("\n"), checkOptions);
    if (asWritten.action !== "allow" || asWritten.internalError) return withRead(asWritten);
    return withRead(inspectText(tool, JSON.stringify(args), checkOptions));
  } catch {
    return { action: "block", failed: true };
  }
}

// Every string in a tool call's arguments, keys included, in order; null when they nest past
// TOOL_ARGS_MAX_DEPTH.
function stringLeaves(args) {
  const leaves = [];
  const pending = [[args, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (typeof item === "string") leaves.push(item);
    else if (item && typeof item === "object") {
      if (depth >= TOOL_ARGS_MAX_DEPTH) return null;
      for (const [key, child] of Object.entries(item).reverse()) {
        pending.push([child, depth + 1]);
        if (!Array.isArray(item)) pending.push([key, depth + 1]);
      }
    }
  }
  return leaves;
}

module.exports = {
  parseToolInput,
  readInvocation,
  WSL_PATH,
  wslReadPath,
  wslAnswers,
  mergedReadOutcomes,
  inspectRead,
  inspectReadInvocation,
  streamOf,
  readUpToCap,
  inspectTool,
};

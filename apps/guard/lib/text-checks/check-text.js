"use strict";
/* global require, module, process, __dirname */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { check, isPersonalKind, ENGINE_PATH } = require("./engine-loader.js");
const { SEVERITIES, HOOK_CHECK_MAX_MS, CHECK_WORKER_MIN_CHARS } = require("../limits-and-messages.js");
const { atomicWriteFile, readConfigFile } = require("../safe-file-writes.js");
const { clotrIgnoreFor } = require("../git-repository.js");

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

const MAX_REPEAT_BYTES = 16 * 1024;

function validRepeatEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    /^[0-9a-f]{64}$/.test(entry.salt) &&
    /^[0-9a-f]{64}$/.test(entry.session) &&
    Array.isArray(entry.fingerprints) &&
    entry.fingerprints.length > 0 &&
    entry.fingerprints.every((fingerprint) => /^[0-9a-f]{64}$/.test(fingerprint)) &&
    Number.isFinite(entry.at)
  );
}

// The resend records, one for each assistant session that showed a warning. A file from Guard 0.1.3 held one record
// for every session; it can't say which session it came from, so it's read as having none.
function loadRepeat(file) {
  try {
    const state = JSON.parse(readConfigFile(file, MAX_REPEAT_BYTES).content);
    if (Array.isArray(state?.entries)) return state.entries.filter(validRepeatEntry);
  } catch {
    // A damaged repeat record can't authorize a resend.
  }
  return [];
}

// The session id each assistant's prompt hook sends, so a resend only counts in the window that showed the warning.
// An assistant that sends none shares one record per assistant, as every prompt did before. Cline's hook events
// carry sessionId; taskId is the fallback for an event without it. Each field's key starts with its own name and a NUL,
// so the two fields never share a record.
function promptSession(tool, event) {
  const usable = (field) => typeof field === "string" && field !== "";
  if (tool === "cline") {
    if (usable(event?.sessionId)) return `sessionId\0${event.sessionId}`;
    return usable(event?.taskId) ? `taskId\0${event.taskId}` : "";
  }
  const field =
    tool === "cursor" ? event?.conversation_id : tool === "windsurf" ? event?.trajectory_id : event?.session_id;
  return usable(field) ? field : "";
}

// Which session a record belongs to, hashed with the record's own salt so the file holds no session id.
function sessionHash(salt, tool, session) {
  return promptHash(salt, `${tool}\0${session}`);
}

function sameSession(entry, tool, session) {
  return entry.session === sessionHash(entry.salt, tool, session);
}

function findRepeat(entries, tool, session) {
  return entries.find((entry) => sameSession(entry, tool, session));
}

// The records kept after a new one: those still inside their two minutes, from other sessions, newest first, as many
// as fit the file's size limit.
function keptRepeats(entries, entry, tool, session, now) {
  const kept = [entry];
  const others = entries
    .filter((old) => !sameSession(old, tool, session) && now - old.at >= 0 && now - old.at < 120_000)
    .sort((left, right) => right.at - left.at);
  for (const old of others) {
    if (JSON.stringify({ entries: [...kept, old] }).length + 1 > MAX_REPEAT_BYTES) break;
    kept.push(old);
  }
  return kept;
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
    // The assistant session the text was sent in (see promptSession); a resend only counts in the same one.
    session = "",
  } = {},
) {
  const file = path.join(dataDir, `${key}-repeat.json`);
  const entries = loadRepeat(file);
  const state = findRepeat(entries, tool, session);
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
    // The engine couldn't load or threw: Guard's own failure stops the text. internalError stays on it for the shell
    // check, which stops the command on that flag.
    return { action: "block", failed: true, internalError: true };
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
    const entry = { session: sessionHash(salt, tool, session), salt, fingerprints, at: now };
    const kept = keptRepeats(entries, entry, tool, session, now);
    atomicWriteFile(file, `${JSON.stringify({ entries: kept })}\n`, { mode: 0o600 });
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
      workerData: { engine: path.join(__dirname, "engine-loader.js"), text, options, port: channel.port2, done },
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

module.exports = {
  minSeverity,
  engineVersion,
  atLeastSeverity,
  dataDirectory,
  promptHash,
  loadRepeat,
  promptSession,
  formatFindings,
  findingFingerprints,
  sameFingerprints,
  isInternalAddress,
  isPersonalDetail,
  inspectText,
  CheckUnfinished,
  CHECK_WORKER_SOURCE,
  checkBy,
  hookDeadline,
  inspectPrompt,
};

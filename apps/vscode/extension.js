"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const vscode = require("vscode");
const guard = require("./guard/bin/clotr-guard.js");
const { isSecretFile } = require("./guard/lib/secret-files.js");
const DEMO_AWS_KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");
const {
  MAX_PATTERN_LENGTH,
  globMatchesAt,
  globSteps,
  parseClotrIgnore,
  readClotrIgnore,
  valueFingerprint,
} = require("./guard/lib/clotrignore.js");
const { pruneIgnoredOnce } = require("./ignore-once.js");
const english = require("./package.nls.json");
const spanish = require("./package.nls.es.json");
const manifest = require("./package.json");

const MAX_BYTES = 1024 * 1024;
const SOURCE = "Clotr";
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const BUNDLED_CLI = path.join(__dirname, "guard", "bin", "clotr-guard.js");
const GUARD_COMMAND_TIMEOUT_MS = 15_000;
// The names people know each assistant by, for the picker; Guard's CLI still gets the short tool name.
const TOOL_LABELS = {
  claude: "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  codex: "Codex CLI",
  windsurf: "Windsurf",
  cline: "Cline",
  git: "Git",
};

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
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      const error = new Error("Clotr Guard timed out.");
      error.code = "ETIMEDOUT";
      try {
        child.kill();
      } catch (_error) {
        // The process may already have exited.
      }
      finish(reject, error);
    }, timeoutMs);
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

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

function gitIgnoreStat(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe-gitignore-file");
  return info;
}

function assertOpenedGitIgnore(descriptor, before) {
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile() || (before?.ino && opened.ino && before.ino !== opened.ino)) {
    throw new Error("unsafe-gitignore-file");
  }
}

function readGitIgnore(file) {
  const before = gitIgnoreStat(file);
  if (!before) return "";
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    assertOpenedGitIgnore(descriptor, before);
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendGitIgnore(file, content) {
  const before = gitIgnoreStat(file);
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = before
    ? fs.openSync(file, flags)
    : fs.openSync(file, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
  try {
    assertOpenedGitIgnore(descriptor, before);
    fs.writeSync(descriptor, content, null, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function gitIgnoreLine(file) {
  if (!file || /[\u0000-\u001f\u007f-\u009f]/.test(file)) return null;
  if (file.startsWith("/") || /^\p{L}:/u.test(file)) return null;
  if (file.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  let escaped = "";
  for (let index = 0; index < file.length; index += 1) {
    const character = file[index];
    const trailingSpace = character === " " && /^ *$/.test(file.slice(index));
    if ("\\*?[]".includes(character) || (index === 0 && "#!".includes(character)) || trailingSpace) escaped += "\\";
    escaped += character;
  }
  return escaped.length <= MAX_PATTERN_LENGTH ? escaped : null;
}

function normalizeGitIgnoreLine(line) {
  let normalized = line.trimStart();
  while (normalized.endsWith(" ") && !normalized.endsWith("\\ ")) normalized = normalized.slice(0, -1);
  return normalized;
}

// An executable from an absolute PATH folder, looked up here rather than by the system, so the open workspace can't
// supply one. npm is a batch file on Windows, unless a version manager put an .exe there.
function isInside(root, candidate) {
  if (!root) return false;
  let realRoot = path.resolve(root);
  let realCandidate = path.resolve(candidate);
  try {
    realRoot = fs.realpathSync(realRoot);
  } catch {
    // A workspace or PATH entry may disappear during executable lookup.
  }
  try {
    realCandidate = fs.realpathSync(realCandidate);
  } catch {
    // A workspace or PATH entry may disappear during executable lookup.
  }
  const relative = path.relative(realRoot, realCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function executable(name, env = process.env, platform = process.platform, excludedWorkspace = null) {
  const names = platform !== "win32" ? [name] : name === "npm" ? ["npm.exe", "npm.cmd"] : [`${name}.exe`];
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder || !path.isAbsolute(folder)) continue;
    let realFolder;
    try {
      realFolder = fs.realpathSync(folder);
    } catch {
      continue;
    }
    if (isInside(excludedWorkspace, realFolder)) continue;
    for (const candidate of names.map((item) => path.join(realFolder, item))) {
      try {
        if (isFile(candidate)) {
          const realCandidate = fs.realpathSync(candidate);
          if (isInside(excludedWorkspace, realCandidate)) continue;
          if (platform !== "win32") fs.accessSync(realCandidate, fs.constants.X_OK);
          return realCandidate;
        }
      } catch (_error) {
        // Not executable here; keep looking.
      }
    }
  }
  return null;
}

function commandOnPath(name, env = process.env, platform = process.platform, excludedWorkspace = null) {
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder || !path.isAbsolute(folder)) continue;
    let realFolder;
    try {
      realFolder = fs.realpathSync(folder);
    } catch {
      continue;
    }
    if (isInside(excludedWorkspace, realFolder)) continue;
    for (const candidate of names.map((item) => path.join(realFolder, item))) {
      try {
        if (!isFile(candidate)) continue;
        if (isInside(excludedWorkspace, fs.realpathSync(candidate))) continue;
        return true;
      } catch {
        // A PATH entry may change while the picker is open.
      }
    }
  }
  return false;
}

// Guard installed with npm install -g, found through npm root -g the way the JetBrains plugin finds it. Hooks that
// name a global Guard keep working when an update replaces this extension's folder, so the copy inside it is only
// the fallback.
async function globalGuardCli(node, excludedWorkspace = null) {
  const npm = executable("npm", process.env, process.platform, excludedWorkspace);
  if (!npm || !node) return null;
  // Node starts a .cmd file only through a shell, so the npm script beside it runs on Node directly instead.
  const script = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  const [command, args] = /\.cmd$/i.test(npm) ? [node, [script, "root", "-g"]] : [npm, ["root", "-g"]];
  if (command === node && !isFile(script)) return null;
  // From the home folder, so no project's own npm settings take part.
  let result;
  try {
    result = await runGuardCommand(command, args, { cwd: os.homedir() });
  } catch (_error) {
    return null;
  }
  if (result.status !== 0) return null;
  const roots = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const root = roots[roots.length - 1];
  if (!root || !path.isAbsolute(root)) return null;
  const cli = path.join(root, "clotr-guard", "bin", "clotr-guard.js");
  return isFile(cli) ? cli : null;
}

function editorName(appName, uriScheme) {
  const known = [appName, uriScheme].map((value) =>
    String(value || "")
      .trim()
      .toLowerCase(),
  );
  const names = [
    ["cursor", "Cursor"],
    ["windsurf", "Windsurf"],
    ["vscodium", "VSCodium"],
    ["kiro", "Kiro"],
    ["trae", "Trae"],
    ["code-server", "code-server"],
    ["codeserver", "code-server"],
    ["visual studio code", "VS Code"],
    ["vscode", "VS Code"],
  ];
  for (const [fragment, label] of names) {
    if (known.some((value) => value.includes(fragment))) return label;
  }
  const application = String(appName || "").trim();
  return application && application.toLowerCase() !== "code" ? application : "VS Code";
}

// Whether a hook's Guard sits in another version's folder of this extension. In this editor's extensions folder any
// other version counts, since the editor removes it after an update; elsewhere, such as another editor that shares
// the settings files, only a copy that's already gone does.
function inOldExtensionFolder(script) {
  const folder = path.dirname(path.dirname(path.dirname(script)));
  const name = path.basename(folder).toLowerCase();
  if (!name.startsWith(`${EXTENSION_ID}-`) || name === path.basename(__dirname).toLowerCase()) return false;
  return path.relative(path.dirname(__dirname), path.dirname(folder)) === "" || !isFile(script);
}

function activate(context) {
  const isSpanish = /^es(?:-|$)/i.test(vscode.env.language);
  const editor = editorName(vscode.env.appName, vscode.env.uriScheme);
  const words = isSpanish ? spanish : english;
  const t = (key) => words[key] || english[key] || key;
  const findingName = (entry) => words[`finding_${entry.type}`] || (isSpanish ? t("sensitiveFinding") : entry.name);
  const hostPlatform = context.clotrPlatform || process.platform;
  const diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  const diagnosticData = new Map();
  const ignoredOnce = new Map();
  const clotrIgnoreCache = new Map();
  const checkedDocuments = new Set();
  const unchecked = new Set();
  const workspaceSecretScanned = new Set();
  const state = context.workspaceState;
  let host;
  let vmContext;
  let timer;
  let refreshing = false;
  const pendingDocuments = new Map();
  let rawIgnoreWarningShown = false;
  const disabled = new Set(state.get("disabledFiles", []));
  let workspaceSecretNoteShown = state.get("workspaceSecretNoteShown", false);
  let salt = state.get("salt");
  if (!salt) {
    salt = crypto.randomBytes(16).toString("hex");
    void state.update("salt", salt);
  }
  try {
    const bundle = fs.readFileSync(path.join(__dirname, "guard", "dist", "clotr-engine.js"), "utf8");
    vmContext = vm.createContext({});
    new vm.Script(bundle).runInContext(vmContext);
    host = vmContext.ClotrHost;
    host.init({ salt, locale: vscode.env.language });
  } catch (_error) {
    vscode.window.showWarningMessage(t("startError"));
    return { dispose() {} };
  }

  function config() {
    return vscode.workspace.getConfiguration("clotr");
  }
  function uriKey(uri) {
    return uri.toString();
  }
  function cachedClotrIgnore(root) {
    const key = path.resolve(root);
    if (!clotrIgnoreCache.has(key)) clotrIgnoreCache.set(key, readClotrIgnore(key));
    return clotrIgnoreCache.get(key);
  }
  function boundedDocumentText(document) {
    try {
      if (document.offsetAt(document.positionAt(MAX_BYTES + 1)) > MAX_BYTES) return { kind: "large" };
      const text = document.getText();
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { kind: "large" };
      if (text.includes("\0")) return { kind: "binary" };
      return { kind: "text", text };
    } catch (_error) {
      return { kind: "failed" };
    }
  }
  function fileSkipped(document) {
    const uri = document.uri;
    const untitled = uri.scheme === "untitled" || document.isUntitled;
    if (uri.scheme !== "file" && !untitled) return true;
    if (!untitled && isSecretFile(uri.fsPath)) return true;
    if (untitled) return false;
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    return (config().get("skipList", []) || []).some((pattern) => matchGlob(pattern, rel));
  }
  function clotrIgnoreForDocument(document) {
    const filePath = path.resolve(document.uri.fsPath);
    const workspace = vscode.workspace.workspaceFolders?.find((folder) => {
      const relative = path.relative(path.resolve(folder.uri.fsPath), filePath);
      return (
        relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    });
    // Stop at the opened workspace so an unrelated .git above it can't redirect a secret into a shared folder.
    let directory = path.dirname(filePath);
    const workspaceRoot = workspace ? path.resolve(workspace.uri.fsPath) : null;
    let root = workspaceRoot;
    while (true) {
      if (!workspaceRoot) break;
      const relative = path.relative(workspaceRoot, directory);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) break;
      if (fs.existsSync(path.join(directory, ".git"))) {
        root = directory;
        break;
      }
      if (!relative) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return { root, config: root ? cachedClotrIgnore(root) : parseClotrIgnore("") };
  }
  function clotrIgnoreForWorkspace() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return { root, config: root ? cachedClotrIgnore(root) : parseClotrIgnore("") };
  }
  function matchGlob(pattern, value) {
    const escaped = pattern
      .split("**/")
      .map((part) =>
        part
          .split("**")
          .map((section) =>
            section
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]"),
          )
          .join(".*"),
      )
      .join("(?:.*/)?");
    return new RegExp(`^${escaped}$`, "i").test(value);
  }
  function addDiagnostic(document, entry, start, end, activeIgnored) {
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    const message = `${findingName(entry)}: ${t("findingDetected")}\n${t("whyOpenFiles").replace("{0}", editor)}`;
    const severity =
      {
        high: vscode.DiagnosticSeverity.Error,
        medium: vscode.DiagnosticSeverity.Warning,
        low: vscode.DiagnosticSeverity.Information,
      }[entry.severity] ?? vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = SOURCE;
    diagnostic.code = entry.type;
    const key = uriKey(document.uri);
    const occurrence = diagnosticKey(diagnostic);
    activeIgnored.set(occurrence, entry.fp);
    if (ignoredOnce.get(key)?.get(occurrence) === entry.fp) return null;
    const byRange = diagnosticData.get(key) || new Map();
    byRange.set(occurrence, { fingerprint: entry.fp, kind: entry.type, range });
    diagnosticData.set(key, byRange);
    return diagnostic;
  }
  function diagnosticKey(diagnostic) {
    const { start, end } = diagnostic.range;
    return `${diagnostic.code}:${start.line}:${start.character}:${end.line}:${end.character}`;
  }
  function markUnchecked(document, message) {
    const key = uriKey(document.uri);
    ignoredOnce.delete(key);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(0), document.positionAt(0)),
      message,
      vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = SOURCE;
    diagnostic.code = "check_unavailable";
    diagnostics.set(document.uri, [diagnostic]);
    diagnosticData.delete(key);
    checkedDocuments.delete(key);
    unchecked.add(key);
  }
  function findingDiagnostics(document) {
    const byRange = diagnosticData.get(uriKey(document.uri));
    return (diagnostics.get(document.uri) || []).filter((diagnostic) => byRange?.has(diagnosticKey(diagnostic)));
  }
  function analyze(document) {
    const key = uriKey(document.uri);
    const untitled = document.uri.scheme === "untitled" || document.isUntitled;
    if (!config().get("enabled", true) || disabled.has(key) || (document.uri.scheme !== "file" && !untitled)) {
      ignoredOnce.delete(key);
      diagnostics.delete(document.uri);
      diagnosticData.delete(key);
      checkedDocuments.delete(key);
      unchecked.delete(key);
      return [];
    }
    if (fileSkipped(document)) {
      ignoredOnce.delete(key);
      diagnostics.delete(document.uri);
      diagnosticData.delete(key);
      checkedDocuments.delete(key);
      unchecked.delete(key);
      return [];
    }
    const bounded = boundedDocumentText(document);
    if (bounded.kind !== "text") {
      ignoredOnce.delete(key);
      const message =
        bounded.kind === "large"
          ? t("notCheckedLarge")
          : bounded.kind === "binary"
            ? t("notCheckedBinary")
            : t("fileCheckFailed");
      markUnchecked(document, message);
      return diagnostics.get(document.uri);
    }
    const text = bounded.text;
    if (!untitled && isSecretFile(document.uri.fsPath, text)) {
      ignoredOnce.delete(key);
      diagnostics.delete(document.uri);
      diagnosticData.delete(key);
      checkedDocuments.delete(key);
      unchecked.delete(key);
      return [];
    }
    const ignore = document.uri.scheme === "file" ? clotrIgnoreForDocument(document) : null;
    if (ignore?.config.reason === "raw-value" && !rawIgnoreWarningShown) {
      rawIgnoreWarningShown = true;
      void vscode.window.showWarningMessage(t("rawIgnoreValue"));
    }
    unchecked.delete(key);
    checkedDocuments.add(key);
    const minimum = config().get("minSeverity", "medium");
    const allowed = new Set(["high", "medium", "low"].slice(0, ["high", "medium", "low"].indexOf(minimum) + 1));
    const personalDetails = config().get("personalDetailsInFiles", false);
    const { checked, groups } = checkWithDetection(text, { app: "vscode", source: "typed" });
    const found = checked.findings.filter((entry) => personalDetails || !isPersonalDetail(entry.type));
    const ignoreConfig = ignore?.config || parseClotrIgnore("");
    const ranges = findRanges(text, found, groups, ignoreConfig);
    const next = [];
    const activeIgnored = new Map();
    diagnosticData.set(key, new Map());
    for (const entry of found) {
      if (!allowed.has(entry.severity)) continue;
      const positions = ranges.get(entry.fp);
      let range = positions?.shift();
      while (range) {
        const diagnostic = addDiagnostic(document, entry, range.start, range.end, activeIgnored);
        if (diagnostic) next.push(diagnostic);
        range = positions?.shift();
      }
    }
    pruneIgnoredOnce(ignoredOnce.get(key), activeIgnored);
    if (!ignoredOnce.get(key)?.size) ignoredOnce.delete(key);
    diagnostics.set(document.uri, next);
    return next;
  }
  function checkWithDetection(text, options) {
    // host.check already detects this text, so reuse those groups to map its diagnostic ranges.
    const detect = vmContext.Clotr.detect;
    let groups;
    vmContext.Clotr.detect = (value) => {
      const detected = detect(value);
      if (value === text) groups = detected;
      return detected;
    };
    try {
      return { checked: host.check(text, options), groups };
    } finally {
      vmContext.Clotr.detect = detect;
    }
  }
  function isPersonalDetail(kind) {
    return /email|phone|person|name|address|ssn|social|passport|license.?plate|national.?id|account.?id|student.?id|birth|dob|vin|ip.?address/i.test(
      kind,
    );
  }

  function gitIgnoreMatches(pattern, candidate) {
    if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return false;
    let steps;
    try {
      steps = globSteps(pattern);
    } catch {
      return false;
    }
    // A Git ignore rule also covers descendants of a matched directory. Check every path prefix in one pass with
    // Guard's state-set glob walker; compiling a regex here let star-heavy rules backtrack for an unbounded time.
    const ends = [];
    for (let end = candidate.indexOf("/"); end >= 0; end = candidate.indexOf("/", end + 1)) {
      if (end > 0) ends.push(end);
    }
    ends.push(candidate.length);
    return globMatchesAt(steps, candidate, ends).some(Boolean);
  }
  async function secretIgnored(uri) {
    try {
      const git = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI(1);
      const repo = git?.repositories?.find((item) => {
        const root = item.rootUri.fsPath.replace(/[\\/]$/, "");
        return uri.fsPath.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
      });
      // The Git extension's checkIgnore takes a list of paths and answers with the set of those it ignores.
      if (repo?.checkIgnore) return (await repo.checkIgnore([uri.fsPath])).has(uri.fsPath);
    } catch (_error) {
      // A missing or unavailable Git extension falls back to local ignore files.
    }
    const folder = vscode.workspace.workspaceFolders?.find((item) =>
      uri.fsPath.toLowerCase().startsWith(`${item.uri.fsPath.replace(/[\\/]$/, "").toLowerCase()}${path.sep}`),
    );
    if (!folder) return false;
    const root = folder.uri.fsPath;
    const directories = [];
    let directory = path.dirname(uri.fsPath);
    while (directory.toLowerCase().startsWith(root.toLowerCase())) {
      directories.unshift(directory);
      if (directory.toLowerCase() === root.toLowerCase()) break;
      directory = path.dirname(directory);
    }
    let ignoredBy = false;
    for (const current of directories) {
      const gitignore = path.join(current, ".gitignore");
      let contents;
      try {
        contents = readGitIgnore(gitignore);
      } catch (_error) {
        continue;
      }
      if (contents) {
        const prefix = path.relative(current, uri.fsPath).replace(/\\/g, "/");
        for (const raw of contents.split(/\r\n|\n|\r/)) {
          const rule = normalizeGitIgnoreLine(raw);
          if (!rule || rule.startsWith("#")) continue;
          const negate = rule.startsWith("!");
          const pattern = (negate ? rule.slice(1) : rule).replace(/^\//, "");
          const candidate = pattern.includes("/") ? prefix : path.posix.basename(prefix);
          if (gitIgnoreMatches(pattern, candidate)) ignoredBy = !negate;
        }
      }
    }
    return ignoredBy;
  }

  async function checkWorkspaceSecrets(documents = vscode.workspace.textDocuments) {
    if (workspaceSecretNoteShown || !vscode.workspace.workspaceFolders?.length) return;
    const workspaceFiles = documents.filter((doc) =>
      vscode.workspace.workspaceFolders.some((folder) => doc.uri.fsPath.startsWith(folder.uri.fsPath)),
    );
    const unignored = [];
    for (const doc of workspaceFiles) {
      const key = uriKey(doc.uri);
      if (workspaceSecretScanned.has(key)) continue;
      workspaceSecretScanned.add(key);
      let secret = isSecretFile(doc.uri.fsPath);
      if (!secret) {
        const bounded = boundedDocumentText(doc);
        secret = bounded.kind === "text" && isSecretFile(doc.uri.fsPath, bounded.text);
      }
      if (secret) {
        const folder = vscode.workspace.workspaceFolders.find((item) =>
          doc.uri.fsPath.toLowerCase().startsWith(`${item.uri.fsPath.replace(/[\\/]$/, "").toLowerCase()}${path.sep}`),
        );
        const relativePath = folder ? path.relative(folder.uri.fsPath, doc.uri.fsPath).replace(/\\/g, "/") : null;
        if (relativePath && !(await secretIgnored(doc.uri))) unignored.push({ root: folder.uri.fsPath, relativePath });
      }
    }
    if (!unignored.length) return;
    await state.update("workspaceSecretNoteShown", true);
    workspaceSecretNoteShown = true;
    const action = await vscode.window.showInformationMessage(t("unignoredSecretNote"), t("addToGitignore"));
    if (action !== t("addToGitignore")) return;
    try {
      const safePaths = unignored.map((item) => {
        const line = gitIgnoreLine(item.relativePath);
        if (line === null) throw new Error("unsafe-gitignore-path");
        return { ...item, line };
      });
      for (const root of new Set(unignored.map((item) => item.root))) {
        const ignoreFile = path.join(root, ".gitignore");
        const existing = readGitIgnore(ignoreFile);
        const lines = new Set(existing.split(/\r\n|\n|\r/).map(normalizeGitIgnoreLine));
        const additions = [...new Set(safePaths.filter((item) => item.root === root).map((item) => item.line))].filter(
          (file) => !lines.has(file),
        );
        if (additions.length) {
          appendGitIgnore(ignoreFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`);
        }
      }
    } catch {
      await vscode.window.showWarningMessage(t("gitIgnoreWriteError"));
    }
  }
  function findRanges(text, findings, groups, ignore) {
    const ranges = new Map();
    const cursor = new Map();
    // Detection supplies only transient match strings; the host's salted fingerprint maps each range to its safe finding.
    for (const group of groups || []) {
      for (const value of group.matches) {
        const cursorKey = `${group.id}\0${value}`;
        let start = text.indexOf(value, cursor.get(cursorKey) || 0);
        while (start >= 0) {
          const end = start + value.length;
          cursor.set(cursorKey, end);
          const ignoredValue = valueFingerprint(ignore?.salt, value);
          if (!ignoredValue || !ignore?.fingerprints.has(ignoredValue)) {
            const fp = host.fingerprintFor(group.id, value);
            if (findings.some((item) => item.fp === fp)) ranges.set(fp, [...(ranges.get(fp) || []), { start, end }]);
          }
          start = text.indexOf(value, end);
        }
      }
    }
    return ranges;
  }
  function refreshAll() {
    clearTimeout(timer);
    timer = undefined;
    pendingDocuments.clear();
    refreshing = true;
    try {
      for (const doc of vscode.workspace.textDocuments) {
        // One document that fails to check keeps its last findings rather than stopping every later check.
        try {
          analyze(doc);
        } catch (_error) {
          try {
            markUnchecked(doc, t("fileCheckFailed"));
          } catch (_markError) {
            // A failed status update must not interfere with the editor.
          }
        }
      }
    } finally {
      refreshing = false;
    }
    findingEmitter.fire();
    updateStatus();
    void checkWorkspaceSecrets();
  }
  function refreshDirty() {
    timer = undefined;
    const documents = [...pendingDocuments.values()];
    pendingDocuments.clear();
    if (!documents.length) return;
    refreshing = true;
    try {
      for (const doc of documents) {
        try {
          analyze(doc);
        } catch (_error) {
          try {
            markUnchecked(doc, t("fileCheckFailed"));
          } catch (_markError) {
            // A failed status update must not interfere with the editor.
          }
        }
      }
    } finally {
      refreshing = false;
    }
    findingEmitter.fire();
    updateStatus();
    void checkWorkspaceSecrets(documents);
  }
  function schedule(document) {
    if (refreshing) return;
    if (document) pendingDocuments.set(uriKey(document.uri), document);
    clearTimeout(timer);
    timer = setTimeout(refreshDirty, 250);
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "clotr.focusView";
  status.tooltip = t("statusProtected").replace("{0}", "0").replace("{1}", "0");
  const findingEmitter = new vscode.EventEmitter();
  const treeProvider = {
    onDidChangeTreeData: findingEmitter.event,
    getChildren(element) {
      if (element?.document) {
        return element.findings
          .filter((finding) => diagnosticData.get(uriKey(element.document.uri))?.has(diagnosticKey(finding)))
          .map((finding) => ({ document: element.document, finding }));
      }
      return vscode.workspace.textDocuments
        .map((document) => ({ document, findings: findingDiagnostics(document) }))
        .filter((entry) => entry.findings.length);
    },
    getTreeItem(element) {
      if (!element.finding) {
        return new vscode.TreeItem(
          path.basename(element.document.uri.fsPath),
          vscode.TreeItemCollapsibleState.Expanded,
        );
      }
      const item = new vscode.TreeItem(element.finding.message.split(/\r?\n/, 1)[0]);
      item.command = {
        command: "vscode.open",
        title: t("openFinding"),
        arguments: [element.document.uri, { selection: element.finding.range }],
      };
      return item;
    },
  };
  const findingView = vscode.window.createTreeView("clotr.findings", { treeDataProvider: treeProvider });
  function updateStatus() {
    const count = vscode.workspace.textDocuments.reduce((sum, doc) => sum + findingDiagnostics(doc).length, 0);
    const files = checkedDocuments.size;
    const findingWord = t(count === 1 ? "statusFinding" : "statusFindings");
    const fileWord = t(files === 1 ? "statusFile" : "statusFiles");
    status.text = `$(shield) Clotr · ${files} ${fileWord}${count ? ` · ${count} ${findingWord}` : ""}`;
    if (unchecked.size) {
      status.text += ` ! ${t("statusNotChecked").replace("{0}", String(unchecked.size))}`;
      status.tooltip = t("statusUnchecked").replace("{0}", String(unchecked.size));
    } else {
      status.tooltip = t("statusProtected").replace("{0}", String(files)).replace("{1}", String(count));
    }
    status.show();
  }
  const actions = {
    provideCodeActions(document, _range, ctx) {
      return ctx.diagnostics
        .filter((d) => d.source === SOURCE && diagnosticData.get(uriKey(document.uri))?.has(diagnosticKey(d)))
        .flatMap((diag) => {
          const detail = diagnosticData.get(uriKey(document.uri)).get(diagnosticKey(diag));
          const ignore = new vscode.CodeAction(t("ignoreOne"), vscode.CodeActionKind.QuickFix);
          ignore.diagnostics = [diag];
          ignore.command = {
            command: "clotr.ignore",
            title: ignore.title,
            arguments: [document.uri, diagnosticKey(diag), detail.fingerprint],
          };
          const off = new vscode.CodeAction(t("turnOffFile"), vscode.CodeActionKind.QuickFix);
          off.command = { command: "clotr.turnOffFile", title: off.title, arguments: [document.uri] };
          const result = [ignore];
          const ignoreTarget = clotrIgnoreForDocument(document);
          if (ignoreTarget.root && ignoreTarget.config.valid) {
            const addToIgnore = new vscode.CodeAction(t("addFingerprintToIgnore"), vscode.CodeActionKind.QuickFix);
            addToIgnore.diagnostics = [diag];
            addToIgnore.command = {
              command: "clotr.addToClotrIgnore",
              title: addToIgnore.title,
              arguments: [document.uri, diagnosticKey(diag)],
            };
            result.push(addToIgnore);
          }
          if (canMoveToEnv(document, diag, detail)) {
            const move = new vscode.CodeAction(t("moveToEnv"), vscode.CodeActionKind.QuickFix);
            move.diagnostics = [diag];
            move.command = {
              command: "clotr.moveToEnv",
              title: move.title,
              arguments: [document.uri, diagnosticKey(diag)],
            };
            result.push(move);
          }
          return [...result, off];
        });
    },
  };
  function documentFor(uri) {
    return vscode.workspace.textDocuments.find((document) => uriKey(document.uri) === uriKey(uri));
  }
  function findingForAction(document, occurrence) {
    const detail = diagnosticData.get(uriKey(document.uri))?.get(occurrence);
    if (!detail) return null;
    const value = document.getText(detail.range);
    if (!value || host.fingerprintFor(detail.kind, value) !== detail.fingerprint) return null;
    return { ...detail, value };
  }
  function safeEnvValue(value) {
    return /^[A-Za-z0-9._/:+=-]+$/.test(value);
  }
  function canMoveToEnv(document, diagnostic, detail) {
    if (!/^(javascript|javascriptreact|typescript|typescriptreact)$/.test(document.languageId || "")) return false;
    const start = document.offsetAt(diagnostic.range.start);
    const end = document.offsetAt(diagnostic.range.end);
    const text = document.getText();
    const quote = text[start - 1];
    const value = document.getText(diagnostic.range);
    const root = clotrIgnoreForDocument(document).root;
    const envText = root ? safeExistingEnv(path.join(root, ".env")) : null;
    return (
      ["'", '"'].includes(quote) &&
      text[end] === quote &&
      safeEnvValue(value) &&
      host.fingerprintFor(detail.kind, value) === detail.fingerprint &&
      envText !== null
    );
  }
  function appendPosition(text) {
    let line = 0;
    let lastBreak = -1;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        line += 1;
        lastBreak = index;
      }
    }
    return new vscode.Position(line, text.length - lastBreak - 1);
  }
  function safeExistingEnv(file) {
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_BYTES) return null;
      return text;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      return null;
    }
  }
  async function addToClotrIgnore(uri, occurrence) {
    const document = documentFor(uri);
    const finding = document && findingForAction(document, occurrence);
    const root = document && clotrIgnoreForDocument(document).root;
    if (!finding || !root) return;
    // Guard's writer: the salt sits in the committed file, so it refuses values that are easy to guess.
    try {
      if (!guard.addIgnoredValue(root, finding.value, finding.kind)) return;
    } catch (error) {
      await vscode.window.showWarningMessage(
        t(error.message === "guessable-value" ? "clotrIgnoreGuessable" : "clotrIgnoreWriteError"),
      );
      return;
    }
    clotrIgnoreCache.delete(path.resolve(root));
    refreshAll();
  }
  async function moveToEnv(uri, occurrence) {
    const document = documentFor(uri);
    const finding = document && findingForAction(document, occurrence);
    const detail = document && diagnosticData.get(uriKey(document.uri))?.get(occurrence);
    const root = document && clotrIgnoreForDocument(document).root;
    if (!document || !finding || !detail || !root || !safeEnvValue(finding.value)) return;
    const start = document.offsetAt(detail.range.start);
    const end = document.offsetAt(detail.range.end);
    const source = document.getText();
    const quote = source[start - 1];
    if (!["'", '"'].includes(quote) || source[end] !== quote) return;
    const envFile = path.join(root, ".env");
    const envText = safeExistingEnv(envFile);
    if (envText === null) {
      await vscode.window.showWarningMessage(t("moveToEnvError"));
      return;
    }
    const base = `CLOTR_${detail.kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    let variable = base;
    let suffix = 2;
    while (new RegExp(`^${variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`, "m").test(envText || "")) {
      variable = `${base}_${suffix++}`;
    }
    const newline = envText?.includes("\r\n") ? "\r\n" : "\n";
    const insertion = `${envText && !/[\r\n]$/.test(envText) ? newline : ""}${variable}=${finding.value}${newline}`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(start - 1), document.positionAt(end + 1)),
      `process.env.${variable}`,
    );
    const envUri = vscode.Uri.file(envFile);
    if (envText === undefined) edit.createFile(envUri);
    edit.insert(envUri, appendPosition(envText || ""), insertion);
    try {
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("edit failed");
      analyze(document);
      findingEmitter.fire();
      updateStatus();
    } catch (_error) {
      await vscode.window.showWarningMessage(t("moveToEnvError"));
    }
  }
  context.subscriptions.push(
    diagnostics,
    status,
    findingView,
    findingEmitter,
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, actions, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("clotr.ignore", async (uri, occurrence, fingerprint) => {
      const key = uriKey(uri);
      const byOccurrence = ignoredOnce.get(key) || new Map();
      byOccurrence.set(occurrence, fingerprint);
      ignoredOnce.set(key, byOccurrence);
      const doc = documentFor(uri);
      if (doc) analyze(doc);
      findingEmitter.fire();
      updateStatus();
    }),
  );
  context.subscriptions.push(vscode.commands.registerCommand("clotr.addToClotrIgnore", addToClotrIgnore));
  context.subscriptions.push(vscode.commands.registerCommand("clotr.moveToEnv", moveToEnv));
  context.subscriptions.push(
    vscode.commands.registerCommand("clotr.turnOffFile", async (uri) => {
      disabled.add(uriKey(uri));
      await state.update("disabledFiles", [...disabled]);
      diagnostics.delete(uri);
      const key = uriKey(uri);
      diagnosticData.delete(key);
      ignoredOnce.delete(key);
      checkedDocuments.delete(key);
      unchecked.delete(key);
      findingEmitter.fire();
      updateStatus();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("clotr.focusView", () => vscode.commands.executeCommand("workbench.view.explorer")),
  );
  const ignoreWatcher = vscode.workspace.createFileSystemWatcher("**/.clotrignore");
  const invalidateIgnore = (uri) => clotrIgnoreCache.delete(path.resolve(path.dirname(uri.fsPath)));
  context.subscriptions.push(
    ignoreWatcher,
    ignoreWatcher.onDidCreate(invalidateIgnore),
    ignoreWatcher.onDidChange(invalidateIgnore),
    ignoreWatcher.onDidDelete(invalidateIgnore),
  );
  context.subscriptions.push(vscode.commands.registerCommand("clotr.setupGuard", () => configureGuard()));
  context.subscriptions.push(vscode.commands.registerCommand("clotr.tryIt", tryIt));
  context.subscriptions.push(vscode.commands.registerCommand("clotr.checkClipboard", checkClipboard));
  context.subscriptions.push(vscode.commands.registerCommand("clotr.checkSelection", checkSelection));
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => schedule(document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      workspaceSecretScanned.delete(uriKey(event.document.uri));
      schedule(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((event) => {
      diagnostics.delete(event.document.uri);
      const key = uriKey(event.document.uri);
      pendingDocuments.delete(key);
      diagnosticData.delete(key);
      ignoredOnce.delete(key);
      checkedDocuments.delete(key);
      unchecked.delete(key);
      workspaceSecretScanned.delete(key);
      findingEmitter.fire();
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clotr")) refreshAll();
    }),
  );
  refreshAll();
  void showWelcome().catch(() => {});

  async function tryIt() {
    try {
      const document = await vscode.workspace.openTextDocument({
        language: "javascript",
        content: `const AWS_ACCESS_KEY_ID = "${DEMO_AWS_KEY}";\n`,
      });
      await vscode.window.showTextDocument(document);
      analyze(document);
      findingEmitter.fire();
      updateStatus();
    } catch (_error) {
      await vscode.window.showWarningMessage(t("tryItError"));
    }
  }

  async function showWelcome() {
    if (context.globalState.get("welcomeShown", false)) return;
    await context.globalState.update("welcomeShown", true);
    const choice = await vscode.window.showInformationMessage(
      t("welcomeMessage").replace("{0}", editor),
      t("tryItButton"),
    );
    if (choice === t("tryItButton")) await vscode.commands.executeCommand("clotr.tryIt");
  }

  async function showChecked(text) {
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      await vscode.window.showInformationMessage(t("notCheckedLarge"));
      return;
    }
    const rank = { high: 3, medium: 2, low: 1 };
    const minimum = config().get("minSeverity", "medium");
    const checked = host.check(text, { app: "vscode", source: "copied" }).findings;
    const document = vscode.window.activeTextEditor?.document;
    const ignore = document ? clotrIgnoreForDocument(document).config : clotrIgnoreForWorkspace().config;
    const byValue = new Map();
    const byId = new Map();
    for (const finding of checked) {
      byId.set(finding.id, finding);
      const key = `${finding.type}\0${finding.fp}`;
      byValue.set(key, [...(byValue.get(key) || []), finding]);
    }
    const matches = [];
    const groups = vmContext.Clotr.detect(text);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      for (let matchIndex = 0; matchIndex < group.matches.length; matchIndex += 1) {
        const value = group.matches[matchIndex];
        const fingerprint = host.fingerprintFor(group.id, value);
        const key = `${group.id}\0${fingerprint}`;
        const finding = fingerprint ? byValue.get(key)?.shift() : byId.get(`${groupIndex}.${matchIndex}`);
        if (finding) matches.push({ finding, value });
      }
    }
    const findings = matches.filter(({ finding, value }) => {
      const fingerprint = valueFingerprint(ignore?.salt, value);
      return rank[finding.severity] >= rank[minimum] && (!fingerprint || !ignore?.fingerprints.has(fingerprint));
    });
    if (!findings.length) {
      await vscode.window.showInformationMessage(t("nothingFound"));
      return;
    }
    const details = findings.map(({ finding }) => `${findingName(finding)}: ${t("findingDetected")}`).join("\n");
    const choice = await vscode.window.showWarningMessage(`${t("foundDetails")}\n${details}`, t("copyClean"));
    if (choice) {
      const cleaned = host.redact(
        text,
        findings.map(({ finding }) => finding.id),
      );
      await vscode.env.clipboard.writeText(cleaned);
      await vscode.window.showInformationMessage(t("cleanCopied"));
    }
  }
  async function checkClipboard() {
    try {
      await showChecked(await vscode.env.clipboard.readText());
    } catch (_error) {
      await vscode.window.showErrorMessage(t("checkFailed"));
    }
  }
  async function checkSelection() {
    try {
      const selectionEditor = vscode.window.activeTextEditor;
      if (!selectionEditor || selectionEditor.selection.isEmpty) {
        await vscode.window.showInformationMessage(t("selectText"));
        return;
      }
      await showChecked(selectionEditor.document.getText(selectionEditor.selection));
    } catch (_error) {
      await vscode.window.showErrorMessage(t("checkFailed"));
    }
  }
  // The extension host's own process.execPath is the editor's binary, not Node, so the CLI runs on the node from
  // PATH, the same one the written hooks will use.
  async function nodeCommand(workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) {
    const node = context.clotrNodeCommand || executable("node", process.env, process.platform, workspace);
    if (!node) return null;
    try {
      const result = await runGuardCommand(node, ["--version"], {}, 5000);
      const version = /^v?(\d+)\.\d+\.\d+/.exec(result.stdout.trim());
      return result.status === 0 && version && Number(version[1]) >= 20 ? node : null;
    } catch (error) {
      if (error?.code === "ETIMEDOUT") throw error;
      return null;
    }
  }
  function assistantFound(tool, home, workspace) {
    const settingsFolder = path.dirname(guard.toolSettingsPath(tool, { home }));
    const editorTool = { Cursor: "cursor", Windsurf: "windsurf" }[editor];
    if (tool === editorTool || fs.existsSync(settingsFolder)) return true;
    const command = { claude: "claude", codex: "codex", gemini: "gemini" }[tool];
    if (command && commandOnPath(command, context.clotrEnv || process.env, hostPlatform, workspace)) return true;
    return tool === "cline" && Boolean(vscode.extensions?.getExtension?.("saoudrizwan.claude-dev"));
  }
  function localizedGuardPreview(tool, output, remove) {
    const firstLine = output.split(/\r?\n/, 1)[0];
    if (tool !== "git") {
      const jsonStart = output.indexOf("\n{");
      return jsonStart < 0 ? t("guardAssistantPreview") : `${firstLine}\n${output.slice(jsonStart + 1).trim()}`;
    }
    const kept = /^Clotr left the pre-commit hook at (.+?) as it was/.exec(firstLine);
    if (kept) return t("guardGitKept").replace("{0}", kept[1]);
    const hook = /^(?:Set up|Removed) Git pre-commit hook at (.+?)(?: \(no change\))?\.$/.exec(firstLine);
    if (!hook) return t("guardPreviewError");
    const key = firstLine.includes("(no change)")
      ? "guardGitNoChange"
      : remove
        ? "guardGitWillRemove"
        : "guardGitWillAdd";
    return t(key).replace("{0}", hook[1]);
  }
  let repairPromptShown = false;
  // An update removes the old extension folder, leaving hooks that name a script that's gone.
  async function repairGuardHooks() {
    if (repairPromptShown || context.globalState.get("extensionVersion") === manifest.version) return;
    const home = context.clotrGuardHome || os.homedir();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const targets = [];
    for (const tool of guard.IMPLEMENTED_TOOL_NAMES) {
      if (tool === "cline" && hostPlatform === "win32") continue;
      const stale = guard.managedHooks(tool, { home }).find((entry) => inOldExtensionFolder(entry.script));
      if (!stale) continue;
      targets.push(tool);
    }
    // The open workspace's Git hook too, read from its file, so nothing runs in a workspace that isn't trusted.
    if (workspace && vscode.workspace.isTrusted) {
      const hook = path.join(workspace, ".git", "hooks", "pre-commit");
      const script = isFile(hook) ? guard.gitHookScript(fs.readFileSync(hook, "utf8")) : null;
      if (script && inOldExtensionFolder(script)) targets.push("git");
    }
    if (!targets.length) {
      await context.globalState.update("extensionVersion", manifest.version);
      return;
    }
    repairPromptShown = true;
    await context.globalState.update("extensionVersion", manifest.version);
    const action = t("guardMovedAction");
    if ((await vscode.window.showInformationMessage(t("guardMoved"), action)) === action) await configureGuard();
  }
  const repairTimer = setTimeout(() => void repairGuardHooks().catch(() => {}), 0);
  async function configureGuard() {
    // Setup runs the Guard CLI in the workspace and writes hooks into its repository, which an untrusted one gets
    // only once the person trusts it.
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showInformationMessage(t("guardNeedsTrust"));
      return;
    }
    const home = context.clotrGuardHome || os.homedir();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      await vscode.window.showInformationMessage(t("guardWorkspaceRequired"));
      return;
    }
    let node;
    try {
      node = await nodeCommand(workspace);
    } catch (error) {
      if (error?.code === "ETIMEDOUT") {
        await vscode.window.showErrorMessage(t("guardTimeout"));
        return;
      }
    }
    if (!node) {
      await vscode.window.showInformationMessage(t("nodeRequired"));
      return;
    }
    const operation = await vscode.window.showQuickPick(
      [
        { label: t("guardSetUpChoice"), remove: false },
        { label: t("guardRemoveChoice"), remove: true },
      ],
      { placeHolder: t("chooseGuardAction") },
    );
    if (!operation) return;
    const remove = operation.remove;
    // Cline hooks don't run on Windows, so there it's offered only for removing hooks set up elsewhere.
    const toolList = guard.IMPLEMENTED_TOOL_NAMES.filter(
      (tool) => tool !== "cline" || hostPlatform !== "win32" || remove,
    ).map((tool) => {
      const detected = assistantFound(tool, home, workspace);
      const configured = remove && guard.managedHooks(tool, { home }).length > 0;
      return {
        label: TOOL_LABELS[tool] || tool,
        tool,
        description: t(
          remove
            ? configured
              ? "guardHooksFound"
              : "guardHooksNotFound"
            : detected
              ? "assistantDetected"
              : "assistantNotFound",
        ),
        picked: remove ? configured : detected,
      };
    });
    toolList.push({
      label: TOOL_LABELS.git,
      tool: "git",
      description: t(remove ? "gitRemoveAvailable" : "gitAvailable"),
      picked: false,
    });
    const selected = await vscode.window.showQuickPick(toolList, {
      canPickMany: true,
      placeHolder: t("chooseAssistants"),
    });
    if (!selected?.length) return;
    const cli = (await globalGuardCli(node, workspace)) || BUNDLED_CLI;
    const argsFor = (tool, dryRun) => [
      cli,
      remove ? "remove" : "setup",
      tool,
      ...(tool === "git" ? ["--project"] : []),
      ...(dryRun ? ["--dry-run"] : []),
      ...(tool !== "git" && config().get("minSeverity", "medium") !== "medium"
        ? ["--min-severity", config().get("minSeverity", "medium")]
        : []),
      ...(tool !== "git" && config().get("personalDetailsInFiles", false) ? ["--personal-details"] : []),
    ];
    const previews = [];
    for (const { label, tool } of selected) {
      let result;
      try {
        result = await runGuardCommand(node, argsFor(tool, true), {
          cwd: workspace,
          env: { ...process.env, USERPROFILE: home, HOME: home },
        });
      } catch (error) {
        await vscode.window.showErrorMessage(t(error?.code === "ETIMEDOUT" ? "guardTimeout" : "guardPreviewError"));
        return;
      }
      if (result.status !== 0) {
        await vscode.window.showErrorMessage(t("guardPreviewError"));
        return;
      }
      previews.push(`${label}:\n${localizedGuardPreview(tool, result.stdout.trim(), remove)}`);
    }
    const action = t("applyGuardChange");
    const confirm = await vscode.window.showWarningMessage(
      `${t(remove ? "guardRemovePreview" : "guardSetupPreview")}\n${previews.join("\n\n")}`,
      { modal: true },
      action,
    );
    if (confirm !== action) return;
    for (const { tool } of selected) {
      let result;
      try {
        result = await runGuardCommand(node, argsFor(tool, false), {
          cwd: workspace,
          env: { ...process.env, USERPROFILE: home, HOME: home },
        });
      } catch (error) {
        await vscode.window.showErrorMessage(t(error?.code === "ETIMEDOUT" ? "guardTimeout" : "guardApplyError"));
        return;
      }
      if (result.status !== 0) {
        await vscode.window.showErrorMessage(t("guardApplyError"));
        return;
      }
    }
    await vscode.window.showInformationMessage(t(remove ? "guardRemoved" : "guardUpdated"));
  }
  return {
    dispose() {
      clearTimeout(timer);
      clearTimeout(repairTimer);
      diagnostics.dispose();
      status.dispose();
      findingView.dispose();
      findingEmitter.dispose();
    },
  };
}

module.exports = { activate, executable, globalGuardCli, runGuardCommand };

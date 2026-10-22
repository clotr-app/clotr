"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const vscode = require("vscode");
const guard = require("./guard/bin/clotr-guard.js");
const { isSecretFile } = require("./guard/lib/secret-files.js");
const {
  parseClotrIgnore,
  readClotrIgnore,
  valueFingerprint,
  pathIgnoredForFile,
} = require("./guard/lib/clotrignore.js");
const english = require("./package.nls.json");
const spanish = require("./package.nls.es.json");
const manifest = require("./package.json");

const MAX_BYTES = 1024 * 1024;
const SOURCE = "Clotr";
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const BUNDLED_CLI = path.join(__dirname, "guard", "bin", "clotr-guard.js");

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

// An executable from an absolute PATH folder, looked up here rather than by the system, so the open workspace can't
// supply one. npm is a batch file on Windows, unless a version manager put an .exe there.
function executable(name, env = process.env, platform = process.platform) {
  const names = platform !== "win32" ? [name] : name === "npm" ? ["npm.exe", "npm.cmd"] : [`${name}.exe`];
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder || !path.isAbsolute(folder)) continue;
    for (const candidate of names.map((item) => path.join(folder, item))) {
      try {
        if (isFile(candidate)) {
          if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch (_error) {
        // Not executable here; keep looking.
      }
    }
  }
  return null;
}

// Guard installed with npm install -g, found through npm root -g the way the JetBrains plugin finds it. Hooks that
// name a global Guard keep working when an update replaces this extension's folder, so the copy inside it is only
// the fallback.
function globalGuardCli(node) {
  const npm = executable("npm");
  if (!npm || !node) return null;
  // Node starts a .cmd file only through a shell, so the npm script beside it runs on Node directly instead.
  const script = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  const [command, args] = /\.cmd$/i.test(npm) ? [node, [script, "root", "-g"]] : [npm, ["root", "-g"]];
  if (command === node && !isFile(script)) return null;
  // From the home folder, so no project's own npm settings take part.
  const result = spawnSync(command, args, { cwd: os.homedir(), encoding: "utf8", timeout: 15000, windowsHide: true });
  if (result.status !== 0) return null;
  const root = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!root || !path.isAbsolute(root)) return null;
  const cli = path.join(root, "clotr-guard", "bin", "clotr-guard.js");
  return isFile(cli) ? cli : null;
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
  const words = /^es(?:-|$)/i.test(vscode.env.language) ? spanish : english;
  const t = (key) => words[key] || english[key] || key;
  const diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  const state = context.workspaceState;
  let host;
  let vmContext;
  let timer;
  let refreshing = false;
  let rawIgnoreWarningShown = false;
  const disabled = new Set(state.get("disabledFiles", []));
  const ignored = new Set(state.get("ignored", []));
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
  function fileSkipped(document) {
    const uri = document.uri;
    if (uri.scheme !== "file" || document.isUntitled) return true;
    if (isSecretFile(uri.fsPath, document.getText())) return true;
    if (document.getText().includes("\0") || Buffer.byteLength(document.getText(), "utf8") > MAX_BYTES) return true;
    const ignore = clotrIgnoreForDocument(document);
    if (ignore.config.reason === "raw-value" && !rawIgnoreWarningShown) {
      rawIgnoreWarningShown = true;
      void vscode.window.showWarningMessage("Use clotr-guard ignore-value.");
    }
    if (ignore.root && pathIgnoredForFile(ignore.config, ignore.root, uri.fsPath)) return true;
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
    let directory = path.dirname(filePath);
    let root = workspace?.uri.fsPath || null;
    while (true) {
      if (fs.existsSync(path.join(directory, ".git"))) {
        root = directory;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return { root, config: root ? readClotrIgnore(root) : parseClotrIgnore("") };
  }
  function clotrIgnoreForWorkspace() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return { root, config: root ? readClotrIgnore(root) : parseClotrIgnore("") };
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
  function addDiagnostic(document, entry, start, end) {
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    const message = `${entry.name}: ${entry.preview}\n${t("whyOpenFiles")}`;
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = SOURCE;
    diagnostic.code = entry.type;
    diagnostic.data = { fingerprint: entry.fp, kind: entry.type, masked: entry.preview };
    return diagnostic;
  }
  function analyze(document) {
    const key = uriKey(document.uri);
    if (!config().get("enabled", true) || disabled.has(key) || fileSkipped(document)) {
      diagnostics.delete(document.uri);
      return [];
    }
    const text = document.getText();
    if (isSecretFile(document.uri.fsPath, text)) {
      diagnostics.delete(document.uri);
      return [];
    }
    const minimum = config().get("minSeverity", "medium");
    const allowed = new Set(["high", "medium", "low"].slice(0, ["high", "medium", "low"].indexOf(minimum) + 1));
    const personalDetails = config().get("personalDetailsInFiles", false);
    const { checked, groups } = checkWithDetection(text, { app: "vscode", source: "typed" });
    const found = checked.findings.filter((entry) => personalDetails || !isPersonalDetail(entry.type));
    const ranges = findRanges(text, found, groups, clotrIgnoreForDocument(document).config);
    const next = [];
    for (const entry of found) {
      if (!allowed.has(entry.severity) || ignored.has(entry.fp)) continue;
      const positions = ranges.get(entry.fp);
      const range = positions?.shift();
      if (range) next.push(addDiagnostic(document, entry, range.start, range.end));
    }
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

  function globRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000");
    return new RegExp(
      `^${escaped
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*")}(?:/.*)?$`,
    );
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
      if (fs.existsSync(gitignore)) {
        const prefix = path.relative(current, uri.fsPath).replace(/\\/g, "/");
        for (const raw of fs.readFileSync(gitignore, "utf8").split(/\r?\n/)) {
          const rule = raw.trim();
          if (!rule || rule.startsWith("#")) continue;
          const negate = rule.startsWith("!");
          const pattern = (negate ? rule.slice(1) : rule).replace(/^\//, "");
          const candidate = pattern.includes("/") ? prefix : path.posix.basename(prefix);
          if (globRegex(pattern).test(candidate)) ignoredBy = !negate;
        }
      }
    }
    return ignoredBy;
  }

  async function checkWorkspaceSecrets() {
    if (workspaceSecretNoteShown || !vscode.workspace.workspaceFolders?.length) return;
    const workspaceFiles = vscode.workspace.textDocuments.filter((doc) =>
      vscode.workspace.workspaceFolders.some((folder) => doc.uri.fsPath.startsWith(folder.uri.fsPath)),
    );
    const unignored = [];
    for (const doc of workspaceFiles) {
      if (isSecretFile(doc.uri.fsPath, doc.getText())) {
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
    for (const root of new Set(unignored.map((item) => item.root))) {
      const ignoreFile = path.join(root, ".gitignore");
      let existing = "";
      try {
        existing = fs.readFileSync(ignoreFile, "utf8");
      } catch (_error) {
        // The action creates the workspace ignore file when it isn't there yet.
      }
      const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
      const additions = [
        ...new Set(unignored.filter((item) => item.root === root).map((item) => item.relativePath)),
      ].filter((file) => !lines.has(file));
      if (additions.length) {
        fs.appendFileSync(ignoreFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`);
      }
    }
  }
  function findRanges(text, findings, groups, ignore) {
    const ranges = new Map();
    const cursor = new Map();
    // Detection supplies only transient match strings; the host's salted fingerprint maps each range to its safe finding.
    for (const group of groups || []) {
      for (const value of group.matches) {
        const start = text.indexOf(value, cursor.get(group.id) || 0);
        if (start < 0) continue;
        const end = start + value.length;
        cursor.set(group.id, end);
        const ignoredValue = valueFingerprint(ignore?.salt, value);
        if (ignoredValue && ignore?.fingerprints.has(ignoredValue)) continue;
        const fp = host.fingerprintFor(group.id, value);
        if (findings.some((item) => item.fp === fp)) ranges.set(fp, [...(ranges.get(fp) || []), { start, end }]);
      }
    }
    return ranges;
  }
  function refreshAll() {
    refreshing = true;
    try {
      for (const doc of vscode.workspace.textDocuments) {
        // One document that fails to check keeps its last findings rather than stopping every later check.
        try {
          analyze(doc);
        } catch (_error) {
          // Its next edit checks it again.
        }
      }
    } finally {
      refreshing = false;
    }
    findingEmitter.fire();
    updateStatus();
    void checkWorkspaceSecrets();
  }
  function schedule() {
    if (refreshing) return;
    clearTimeout(timer);
    timer = setTimeout(refreshAll, 250);
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "clotr.focusView";
  status.tooltip = t("openFindings");
  const findingEmitter = new vscode.EventEmitter();
  const treeProvider = {
    onDidChangeTreeData: findingEmitter.event,
    getChildren(element) {
      if (element?.document) return element.findings.map((finding) => ({ document: element.document, finding }));
      return vscode.workspace.textDocuments
        .map((document) => ({ document, findings: diagnostics.get(document.uri) || [] }))
        .filter((entry) => entry.findings.length);
    },
    getTreeItem(element) {
      if (!element.finding) {
        return new vscode.TreeItem(
          path.basename(element.document.uri.fsPath),
          vscode.TreeItemCollapsibleState.Expanded,
        );
      }
      const item = new vscode.TreeItem(
        `${element.finding.data?.kind || "private_detail"}: ${element.finding.data?.masked || ""}`,
      );
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
    const count = vscode.workspace.textDocuments.reduce((sum, doc) => sum + (diagnostics.get(doc.uri) || []).length, 0);
    status.text = `$(shield) Clotr${count ? ` ${count}` : ""}`;
    status.show();
  }
  const actions = {
    provideCodeActions(document, _range, ctx) {
      return ctx.diagnostics
        .filter((d) => d.source === SOURCE && d.data?.fingerprint)
        .flatMap((diag) => {
          const ignore = new vscode.CodeAction(t("ignoreOne"), vscode.CodeActionKind.QuickFix);
          ignore.diagnostics = [diag];
          ignore.command = {
            command: "clotr.ignore",
            title: ignore.title,
            arguments: [document.uri, diag.data.fingerprint],
          };
          const off = new vscode.CodeAction(t("turnOffFile"), vscode.CodeActionKind.QuickFix);
          off.command = { command: "clotr.turnOffFile", title: off.title, arguments: [document.uri] };
          return [ignore, off];
        });
    },
  };
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
    vscode.commands.registerCommand("clotr.ignore", async (uri, fp) => {
      ignored.add(fp);
      await state.update("ignored", [...ignored]);
      const doc = vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(uri));
      if (doc) analyze(doc);
      findingEmitter.fire();
      updateStatus();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("clotr.turnOffFile", async (uri) => {
      disabled.add(uriKey(uri));
      await state.update("disabledFiles", [...disabled]);
      diagnostics.delete(uri);
      findingEmitter.fire();
      updateStatus();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("clotr.focusView", () => vscode.commands.executeCommand("workbench.view.explorer")),
  );
  context.subscriptions.push(vscode.commands.registerCommand("clotr.setupGuard", () => configureGuard()));
  context.subscriptions.push(vscode.commands.registerCommand("clotr.checkClipboard", checkClipboard));
  context.subscriptions.push(vscode.commands.registerCommand("clotr.checkSelection", checkSelection));
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((event) => {
      diagnostics.delete(event.document.uri);
      findingEmitter.fire();
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clotr")) refreshAll();
    }),
  );
  refreshAll();

  async function showChecked(text) {
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
    const details = findings.map(({ finding }) => `${finding.name}: ${finding.preview}`).join("\n");
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
    await showChecked(await vscode.env.clipboard.readText());
  }
  async function checkSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      await vscode.window.showInformationMessage(t("selectText"));
      return;
    }
    await showChecked(editor.document.getText(editor.selection));
  }
  // The extension host's own process.execPath is the editor's binary, not Node, so the CLI runs on the node from
  // PATH, the same one the written hooks will use.
  function nodeCommand() {
    const node = context.clotrNodeCommand || executable("node");
    if (!node) return null;
    return spawnSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).status === 0 ? node : null;
  }
  let repairPromptShown = false;
  // An update removes the old extension folder, leaving hooks that name a script that's gone.
  async function repairGuardHooks() {
    if (repairPromptShown || context.globalState.get("extensionVersion") === manifest.version) return;
    const home = context.clotrGuardHome || os.homedir();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const targets = [];
    for (const tool of guard.TOOL_NAMES) {
      if (tool === "cline" && process.platform === "win32") continue;
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
    const node = nodeCommand();
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
    const toolList = guard.TOOL_NAMES.filter((tool) => tool !== "cline").map((tool) => {
      const folder = path.dirname(guard.toolSettingsPath(tool, { home }));
      const installed = fs.existsSync(folder);
      return { label: tool, description: t(installed ? "assistantInstalled" : "assistantNotFound"), picked: installed };
    });
    if (!remove) toolList.push({ label: "git", description: t("gitAvailable"), picked: false });
    const selected = await vscode.window.showQuickPick(toolList, {
      canPickMany: true,
      placeHolder: t("chooseAssistants"),
    });
    if (!selected?.length) return;
    if (selected.every(({ label }) => label === "cline" && process.platform === "win32")) {
      await vscode.window.showInformationMessage(t("clineWindowsLimit"));
      return;
    }
    const cli = globalGuardCli(node) || BUNDLED_CLI;
    const argsFor = (label, dryRun) => [
      cli,
      remove ? "remove" : "setup",
      label,
      ...(label === "git" ? ["--project"] : []),
      ...(dryRun ? ["--dry-run"] : []),
      ...(label !== "git" && config().get("minSeverity", "medium") !== "medium"
        ? ["--min-severity", config().get("minSeverity", "medium")]
        : []),
      ...(label !== "git" && config().get("personalDetailsInFiles", false) ? ["--personal-details"] : []),
    ];
    const previews = [];
    for (const { label } of selected) {
      if (label === "cline" && process.platform === "win32") {
        previews.push(`${label}: ${t("clineWindowsLimit")}`);
        continue;
      }
      const result = spawnSync(node, argsFor(label, true), {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      if (result.status !== 0) {
        await vscode.window.showErrorMessage(result.stderr?.trim() || t("guardPreviewError"));
        return;
      }
      previews.push(`${label}:\n${result.stdout.trim()}`);
    }
    const action = t("applyGuardChange");
    const confirm = await vscode.window.showWarningMessage(
      `${t(remove ? "guardRemovePreview" : "guardSetupPreview")}\n${previews.join("\n\n")}`,
      { modal: true },
      action,
    );
    if (confirm !== action) return;
    for (const { label } of selected) {
      if (label === "cline" && process.platform === "win32") continue;
      const result = spawnSync(node, argsFor(label, false), {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      if (result.status !== 0) {
        await vscode.window.showErrorMessage(result.stderr?.trim() || t("guardApplyError"));
        return;
      }
    }
    await vscode.window.showInformationMessage(t("guardUpdated"));
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

module.exports = { activate };

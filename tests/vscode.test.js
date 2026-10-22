"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { build } = require("../tools/engine-bundle.js");
const { isSecretFile } = require("../apps/guard/lib/secret-files.js");
const { valueFingerprint } = require("../apps/guard/lib/clotrignore.js");
const guard = require("../apps/guard/bin/clotr-guard.js");
const { build: buildVscode } = require("../apps/vscode/build.js");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "apps", "vscode");
const BUNDLE = path.join(APP, "guard", "dist", "clotr-engine.js");
const KEY = "AKIA4HPQ7XZ2R6TWLJ3N";
const currentBundle = build().text;
buildVscode();
assert.equal(fs.readFileSync(BUNDLE, "utf8"), currentBundle, "VS Code's engine bundle is stale");
// Guard setup asks npm where global packages live. An empty prefix of the tests' own keeps a Guard installed on this
// computer out of them, and a test that wants a global Guard puts one there.
const NPM_PREFIX = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-npm-"));
const GLOBAL_MODULES =
  process.platform === "win32" ? path.join(NPM_PREFIX, "node_modules") : path.join(NPM_PREFIX, "lib", "node_modules");
process.env.npm_config_prefix = NPM_PREFIX;
test.after(() => {
  fs.rmSync(path.join(APP, "guard"), { recursive: true, force: true });
  fs.rmSync(path.join(APP, "LICENSE"), { force: true });
  fs.rmSync(NPM_PREFIX, { recursive: true, force: true });
});

async function waitFor(condition, what) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 30_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("VS Code uses the current engine bundle", () => {
  assert.equal(fs.readFileSync(BUNDLE, "utf8"), currentBundle);
});

// The engine build changes with every batch and the bundle is made from the manifest when the package is built, so a
// build number typed into the README would go stale.
test("VS Code shows its release version and leaves the engine build to the package", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(APP, "README.md"), "utf8");
  assert.equal(editor.version, "0.1.0");
  assert.equal(readme.match(/^Version (\d+\.\d+\.\d+)\.$/m)?.[1], editor.version);
  assert.doesNotMatch(readme, /engine \d+\.\d+\.\d+/i);
});

test("the VS Code package copies the repository license into its folder", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-license-"));
  try {
    buildVscode({ outDir: packageRoot, repoRoot: ROOT });
    buildVscode({ outDir: packageRoot, repoRoot: path.join(packageRoot, "missing-source") });
    assert.equal(
      fs.readFileSync(path.join(packageRoot, "LICENSE"), "utf8"),
      fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"),
    );
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("the VSIX package lists its Guard runtime without the MCP binary", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-packed-files-"));
  try {
    buildVscode({ outDir: packageRoot, repoRoot: ROOT });
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else files.push(path.relative(packageRoot, file).replace(/\\/g, "/"));
      }
    };
    visit(packageRoot);
    assert.deepEqual(files.sort(), [
      "LICENSE",
      "guard/bin/clotr-guard.js",
      "guard/dist/clotr-engine.js",
      "guard/lib/clotrignore.js",
      "guard/lib/engine.js",
      "guard/lib/secret-files.js",
      "guard/package.json",
    ]);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

function fakeVscode(documents, stateValues = {}, configValues = {}, workspaceRoot = null) {
  const commands = new Map();
  const entries = new Map();
  const config = { enabled: true, minSeverity: "medium", skipList: [], ...configValues };
  const treeViews = new Map();
  const statusItems = [];
  let picks = [];
  const quickPicks = [];
  let textChangeListener;
  let informationChoice;
  let informationChoiceSet = false;
  const clipboard = {
    value: "",
    async readText() {
      return this.value;
    },
    async writeText(value) {
      this.value = value;
    },
  };
  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }
  class Diagnostic {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  }
  class CodeAction {
    constructor(title, kind) {
      Object.assign(this, { title, kind });
    }
  }
  class TreeItem {
    constructor(label, collapsibleState) {
      Object.assign(this, { label, collapsibleState });
    }
  }
  class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  }
  const uri = (file) => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });
  const vscode = {
    Range,
    Diagnostic,
    DiagnosticSeverity: { Warning: 1 },
    CodeAction,
    CodeActionKind: { QuickFix: 1 },
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    EventEmitter,
    StatusBarAlignment: { Left: 1 },
    env: { language: "en", clipboard },
    window: {
      activeTextEditor: null,
      messages: [],
      messageCalls: [],
      showWarningMessage: async function (message, ...choices) {
        this.messages.push(message);
        this.messageCalls.push({ message, choices });
        return choices.at(-1);
      },
      showInformationMessage: async function (message, ...choices) {
        this.messages.push(message);
        this.messageCalls.push({ message, choices });
        return informationChoiceSet ? informationChoice : choices.at(-1);
      },
      createStatusBarItem() {
        const item = { show() {}, dispose() {} };
        statusItems.push(item);
        return item;
      },
      createTreeView(id, options) {
        const view = { ...options, dispose() {} };
        treeViews.set(id, view);
        return view;
      },
      async showQuickPick(items, options) {
        quickPicks.push({ items, options });
        if (picks.length) return picks.shift()(items, options);
        return options.canPickMany ? items.filter((item) => item.picked) : items[0];
      },
    },
    workspace: {
      textDocuments: documents,
      asRelativePath: (u) =>
        workspaceRoot ? path.relative(workspaceRoot, u.fsPath).replace(/\\/g, "/") : path.basename(u.fsPath),
      workspaceFolders: workspaceRoot ? [{ uri: { fsPath: workspaceRoot } }] : undefined,
      isTrusted: true,
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }),
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidChangeTextDocument: (listener) => {
        textChangeListener = listener;
        return { dispose() {} };
      },
      onDidCloseTextDocument: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    languages: {
      createDiagnosticCollection() {
        return {
          set: (u, value) => entries.set(u.toString(), value),
          get: (u) => entries.get(u.toString()),
          delete: (u) => entries.delete(u.toString()),
          dispose() {},
        };
      },
      registerCodeActionsProvider: () => ({ dispose() {} }),
    },
    extensions: {},
    commands: {
      registerCommand: (name, fn) => {
        commands.set(name, fn);
        return { dispose() {} };
      },
      executeCommand: async () => {},
    },
  };
  const mkDocument = (file, content) => {
    let text = content;
    return {
      uri: uri(file),
      isUntitled: false,
      getText: () => text,
      setText(value) {
        text = value;
      },
      positionAt(offset) {
        return {
          line: text.slice(0, offset).split("\n").length - 1,
          character: offset - (text.lastIndexOf("\n", offset - 1) + 1),
        };
      },
    };
  };
  const globalValues = {};
  const context = {
    subscriptions: [],
    clotrGuardHome: path.join(os.tmpdir(), `clotr-vscode-home-${process.pid}-${Math.random()}`),
    workspaceState: {
      get: (key, fallback) => stateValues[key] ?? fallback,
      async update(key, value) {
        stateValues[key] = value;
      },
    },
    globalState: {
      get: (key, fallback) => globalValues[key] ?? fallback,
      async update(key, value) {
        globalValues[key] = value;
      },
    },
  };
  return {
    vscode,
    context,
    commands,
    entries,
    clipboard,
    mkDocument,
    stateValues,
    globalValues,
    treeViews,
    statusItems,
    quickPicks,
    config,
    setPicks(value) {
      picks = value;
    },
    setInformationChoice(value) {
      informationChoice = value;
      informationChoiceSet = true;
    },
    fireTextChange(document) {
      textChangeListener?.({ document });
    },
  };
}

async function activateExtension(fake) {
  const extFile = path.join(APP, "extension.js");
  const extModule = new Module(extFile, module);
  extModule.filename = extFile;
  extModule.paths = Module._nodeModulePaths(APP);
  extModule.require = (name) =>
    name === "vscode" ? fake.vscode : name.startsWith(".") ? require(path.resolve(APP, name)) : require(name);
  const createContext = vm.createContext;
  vm.createContext = (...args) => {
    fake.engineContext = createContext(...args);
    return fake.engineContext;
  };
  try {
    extModule._compile(fs.readFileSync(extFile, "utf8"), extFile);
    return await extModule.exports.activate(fake.context);
  } finally {
    vm.createContext = createContext;
  }
}

async function activateContainedExtension(root, fake) {
  const extFile = path.join(root, "extension.js");
  const extModule = new Module(extFile, module);
  extModule.filename = extFile;
  extModule.paths = Module._nodeModulePaths(root);
  const originalLoad = Module._load;
  const inside = (target) => {
    const relative = path.relative(root, target);
    return (
      relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fake.vscode;
    if (Module.isBuiltin(request)) return originalLoad.call(this, request, parent, isMain);
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (inside(parent?.filename || "") && !inside(resolved)) {
      throw new Error(`Extension dependency escaped its folder: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    extModule._compile(fs.readFileSync(extFile, "utf8"), extFile);
    return await extModule.exports.activate(fake.context);
  } finally {
    Module._load = originalLoad;
  }
}

test("the packaged VS Code extension loads with every dependency inside its folder", async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-package-"));
  try {
    for (const file of [
      "extension.js",
      "package.json",
      "package.nls.json",
      "package.nls.es.json",
      "README.md",
      "build.js",
      ".vscodeignore",
    ]) {
      fs.copyFileSync(path.join(APP, file), path.join(packageRoot, file));
    }
    buildVscode({ outDir: packageRoot, repoRoot: ROOT });
    const fake = fakeVscode([]);
    await activateContainedExtension(packageRoot, fake);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("open file findings show one masked diagnostic on its range", async () => {
  const fake = fakeVscode([]);
  fake.vscode.workspace.textDocuments.push(fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`));
  await activateExtension(fake);
  const diagnostics = [...fake.entries.values()][0];
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /AKIA…3N/);
  assert.doesNotMatch(diagnostics[0].message, new RegExp(KEY));
  assert.equal(diagnostics[0].range.start.character, 15);
  assert.deepEqual(Object.keys(fake.stateValues).sort(), ["salt"]);
});

test("repeated findings use separate source ranges", async () => {
  const fake = fakeVscode([]);
  const content = `${KEY}\nAKIA3HPQ7XZ2R6TWLJ3N`;
  fake.vscode.workspace.textDocuments.push(fake.mkDocument("C:/project/app.js", content));
  await activateExtension(fake);
  const diagnostics = [...fake.entries.values()][0];
  assert.equal(diagnostics.length, 2);
  assert.notEqual(diagnostics[0].range.start.line, diagnostics[1].range.start.line);
});

test("Ignore this one saves only its salted fingerprint and hides the finding", async () => {
  const fake = fakeVscode([]);
  const doc = fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  await activateExtension(fake);
  const finding = [...fake.entries.values()][0][0];
  await fake.commands.get("clotr.ignore")(doc.uri, finding.data.fingerprint);
  assert.equal(fake.entries.get(doc.uri.toString()).length, 0);
  assert.deepEqual(fake.stateValues.ignored, [finding.data.fingerprint]);
  assert.equal(JSON.stringify(fake.stateValues).includes(KEY), false);
});

test("VS Code applies .clotrignore paths and value fingerprints", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-clotrignore-"));
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  fs.writeFileSync(
    path.join(root, ".clotrignore"),
    `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, KEY)}\nfixtures/\n`,
  );
  try {
    const fake = fakeVscode([], {}, {}, root);
    const pathIgnored = fake.mkDocument(path.join(root, "fixtures", "sample.js"), `const key = "${KEY}";`);
    const valueIgnored = fake.mkDocument(path.join(root, "value.js"), `const key = "${KEY}";`);
    const stillFound = fake.mkDocument(path.join(root, "other.js"), 'const key = "AKIA3HPQ7XZ2R6TWLJ3N";');
    fake.vscode.workspace.textDocuments.push(pathIgnored, valueIgnored, stillFound);
    await activateExtension(fake);
    assert.equal(fake.entries.get(pathIgnored.uri.toString())?.length || 0, 0);
    assert.equal(fake.entries.get(valueIgnored.uri.toString())?.length || 0, 0);
    assert.equal(fake.entries.get(stillFound.uri.toString()).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VS Code checks the clipboard with repository value fingerprints", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-clipboard-ignore-"));
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  fs.writeFileSync(path.join(root, ".clotrignore"), `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, KEY)}\n`);
  try {
    const fake = fakeVscode([], {}, {}, root);
    fake.clipboard.value = `Use ${KEY}`;
    await activateExtension(fake);
    await fake.commands.get("clotr.checkClipboard")();
    assert.equal(fake.vscode.window.messages.length, 1);
    assert.doesNotMatch(fake.vscode.window.messages[0], /AKIA/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VS Code keeps each split ID with its own ignore fingerprint and file range", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-split-id-ignore-"));
  const ignoreSalt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const valueSalt = "0123456789abcdef0123456789abcdef";
  const mine = "EMP-48213";
  const other = "EMP-11111";
  fs.writeFileSync(
    path.join(root, ".clotrignore"),
    `salt: ${ignoreSalt}\nfingerprint: ${valueFingerprint(ignoreSalt, other)}\n`,
  );
  try {
    const text = `employee number ${other}\nemployee number ${mine}`;
    const document = fakeVscode([], {}, {}, root).mkDocument(path.join(root, "ids.txt"), text);
    const fake = fakeVscode([document], {}, {}, root);
    await activateExtension(fake);
    const value = {
      kind: "value",
      type: "my_id",
      fp: fake.engineContext.Clotr.fingerprint(valueSalt, "my_id", mine),
      mode: "protect",
      added: 1,
    };
    const shape = { kind: "shape", type: "my_id", shape: "EMP-#####", near: ["employee number"], added: 1 };
    fake.engineContext.ClotrHost.init({ salt: valueSalt, vault: [value, shape] });
    fake.fireTextChange(document);
    await waitFor(() => fake.entries.get(document.uri.toString())?.length === 1, "the unignored ID range");
    const [diagnostic] = fake.entries.get(document.uri.toString());
    assert.equal(diagnostic.code, "my_id");
    assert.deepEqual([diagnostic.range.start.line, diagnostic.range.start.character], [1, 16]);
    assert.deepEqual([diagnostic.range.end.line, diagnostic.range.end.character], [1, 25]);

    fake.clipboard.value = text;
    await fake.commands.get("clotr.checkClipboard")();
    assert.match(fake.vscode.window.messages[0], /Your Account\/ID Number: EMP-…13/);
    assert.doesNotMatch(fake.vscode.window.messages[0], /Account\/ID Number: EMP-…11/);
    assert.doesNotMatch(fake.clipboard.value, new RegExp(mine));
    assert.match(fake.clipboard.value, new RegExp(other));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VS Code refuses raw value lines and shows one command message", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-raw-ignore-"));
  fs.writeFileSync(path.join(root, ".clotrignore"), `value: ${KEY}\n`);
  try {
    const fake = fakeVscode([], {}, {}, root);
    fake.vscode.workspace.textDocuments.push(
      fake.mkDocument(path.join(root, "one.js"), `const key = "${KEY}";`),
      fake.mkDocument(path.join(root, "two.js"), `const key = "${KEY}";`),
    );
    await activateExtension(fake);
    assert.deepEqual(fake.vscode.window.messages, ["Use clotr-guard ignore-value."]);
    assert.equal([...fake.entries.values()].flat().length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VS Code .clotrignore does not quiet the secret-file workspace note", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-secret-clotrignore-"));
  fs.writeFileSync(path.join(root, ".clotrignore"), "**\n");
  try {
    const fake = fakeVscode([], {}, {}, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env"), `API_KEY=${KEY}`));
    await activateExtension(fake);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.vscode.window.messages, ["A secret file in this workspace isn't ignored by Git."]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("turning a file off clears its findings and remembers only its file URI", async () => {
  const fake = fakeVscode([]);
  const doc = fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  await activateExtension(fake);
  await fake.commands.get("clotr.turnOffFile")(doc.uri);
  assert.equal(fake.entries.has(doc.uri.toString()), false);
  assert.deepEqual(fake.stateValues.disabledFiles, [doc.uri.toString()]);
});

test("clipboard check shows masked details and copies the engine-cleaned text", async () => {
  const fake = fakeVscode([]);
  fake.clipboard.value = `Paste ${KEY} here`;
  await activateExtension(fake);
  await fake.commands.get("clotr.checkClipboard")();
  assert.match(fake.vscode.window.messages[0], /AKIA…3N/);
  assert.doesNotMatch(fake.vscode.window.messages[0], new RegExp(KEY));
  assert.match(fake.clipboard.value, /\[REDACTED AWS ACCESS KEY\]/);
  assert.doesNotMatch(fake.clipboard.value, new RegExp(KEY));
});

test("VS Code checks files through 1 MiB and skips larger or binary files", async () => {
  const fake = fakeVscode([]);
  const exactlyOneMiB = `${" ".repeat(1024 * 1024 - KEY.length)}${KEY}`;
  assert.equal(Buffer.byteLength(exactlyOneMiB), 1024 * 1024);
  fake.vscode.workspace.textDocuments.push(
    fake.mkDocument("C:/project/at-cap.txt", exactlyOneMiB),
    fake.mkDocument("C:/project/over-cap.txt", `${exactlyOneMiB}\n`),
    fake.mkDocument("C:/project/image.bin", `\0${KEY}`),
  );
  await activateExtension(fake);
  assert.equal(fake.entries.get("file://C:/project/at-cap.txt")?.length, 1);
  assert.equal(fake.entries.has("file://C:/project/over-cap.txt"), false);
  assert.equal(fake.entries.has("file://C:/project/image.bin"), false);
});

test("VS Code detects once for each changed document", async () => {
  const fake = fakeVscode([]);
  const document = fake.mkDocument("C:/project/edited.txt", "No private details here.");
  fake.vscode.workspace.textDocuments.push(document);
  await activateExtension(fake);
  let calls = 0;
  const detect = fake.engineContext.Clotr.detect;
  fake.engineContext.Clotr.detect = (...args) => {
    calls++;
    return detect(...args);
  };
  document.setText(`const token = "${KEY}";`);
  fake.fireTextChange(document);
  await waitFor(() => fake.entries.get(document.uri.toString())?.length === 1, "the changed document finding");
  assert.equal(calls, 1);
});

test("secret files stay silent in VS Code, including a real key in .env", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-secret-"));
  const fake = fakeVscode([], {}, {}, root);
  fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env"), `STRIPE_KEY=${KEY}\nOTHER=value`));
  await activateExtension(fake);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.entries.size, 0);
  assert.deepEqual(fake.vscode.window.messages, ["A secret file in this workspace isn't ignored by Git."]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an ignored secret file is silent without a workspace note", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-ignored-"));
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  const fake = fakeVscode([], {}, {}, root);
  fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env"), `API_KEY=${KEY}`));
  await activateExtension(fake);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.entries.size, 0);
  assert.equal(fake.vscode.window.messages.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the shared secret-file list covers formats and leaves environment examples alone", () => {
  for (const file of [
    ".env",
    ".env.production",
    ".envrc",
    "key.pem",
    "server.key",
    "user.p12",
    "user.pfx",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa_sk",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".aws/credentials",
    "infra.tfvars",
    "secrets.yaml",
    "prod.secrets.json",
    ".git-credentials",
  ]) {
    assert.equal(isSecretFile(file), true, file);
  }
  for (const file of [".env.example", ".env.sample", ".env.template", ".env.dist", "README.md"]) {
    assert.equal(isSecretFile(file), false, file);
  }
  assert.equal(isSecretFile("account.json", '{"type":"service_account"}'), true);
});

test("environment references and placeholders do not show findings", async () => {
  const fake = fakeVscode([]);
  fake.vscode.workspace.textDocuments.push(
    fake.mkDocument(
      "C:/project/app.js",
      ["process.env.STRIPE_KEY", 'os.environ["X"]', "${X}", "<your-key>", "xxxx"].join("\n"),
    ),
  );
  await activateExtension(fake);
  assert.equal([...fake.entries.values()].flat().length, 0);
});

test("English and Spanish package words have matching keys", () => {
  const en = require("../apps/vscode/package.nls.json");
  const es = require("../apps/vscode/package.nls.es.json");
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
});

test("the Explorer tree lists open findings and clicking a child opens its finding", async () => {
  const fake = fakeVscode([]);
  const doc = fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  await activateExtension(fake);
  const tree = fake.treeViews.get("clotr.findings").treeDataProvider;
  const [file] = tree.getChildren();
  const [finding] = tree.getChildren(file);
  const item = tree.getTreeItem(finding);
  assert.match(item.label, /aws_access_key: AKIA.*3N/);
  assert.equal(item.command.command, "vscode.open");
  assert.equal(item.command.arguments[0], doc.uri);
  assert.equal(fake.statusItems[0].command, "clotr.focusView");
});

test("default medium severity lets low email findings through and low setting shows them", async () => {
  const fake = fakeVscode([]);
  fake.vscode.workspace.textDocuments.push(fake.mkDocument("C:/project/contact.txt", "hello@example.com"));
  await activateExtension(fake);
  assert.equal([...fake.entries.values()][0]?.length || 0, 0);
  const low = fakeVscode([], {}, { minSeverity: "low", personalDetailsInFiles: true });
  low.vscode.workspace.textDocuments.push(low.mkDocument("C:/project/contact.txt", "hello@example.com"));
  await activateExtension(low);
  assert.equal([...low.entries.values()][0].length, 1);
});

test("personal details in ordinary files are off unless enabled", async () => {
  const content = "My address is 123 Main Street, Springfield, IL 62704";
  const quiet = fakeVscode([]);
  quiet.vscode.workspace.textDocuments.push(quiet.mkDocument("C:/project/contact.txt", content));
  await activateExtension(quiet);
  assert.equal([...quiet.entries.values()].flat().length, 0);
  const enabled = fakeVscode([], {}, { personalDetailsInFiles: true });
  enabled.vscode.workspace.textDocuments.push(enabled.mkDocument("C:/project/contact.txt", content));
  await activateExtension(enabled);
  assert.equal([...enabled.entries.values()].flat().length, 1);
});

test("clipboard result explains that findings below the selected severity pass", async () => {
  const fake = fakeVscode([]);
  fake.clipboard.value = "Email hello@example.com";
  await activateExtension(fake);
  await fake.commands.get("clotr.checkClipboard")();
  assert.match(fake.vscode.window.messages[0], /at or above your minimum severity/);
});

test("Guard command offers every tool and Git, then previews and applies through the Guard CLI", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-guard-"));
  assert.equal(require("node:child_process").spawnSync("git", ["init"], { cwd: workspace }).status, 0);
  const fake = fakeVscode([], {}, {}, workspace);
  fs.mkdirSync(path.join(fake.context.clotrGuardHome, ".codex"), { recursive: true });
  const selection = (labels) => [
    (items) => items.find((item) => item.remove === false),
    (items) => {
      assert.deepEqual(
        items.filter((item) => item.label !== "git").map((item) => item.label),
        guard.TOOL_NAMES.filter((tool) => tool !== "cline"),
      );
      assert.ok(items.some((item) => item.label === "git"));
      return items.filter((item) => labels.includes(item.label));
    },
  ];
  await activateExtension(fake);
  fake.setPicks(selection(["codex", "git"]));
  await fake.commands.get("clotr.setupGuard")();
  const settingsFile = path.join(fake.context.clotrGuardHome, ".codex", "hooks.json");
  const hookFile = path.join(workspace, ".git", "hooks", "pre-commit");
  const preview = fake.vscode.window.messages.find((message) => message.includes("Clotr will make these changes"));
  assert.ok(preview.includes("UserPromptSubmit"));
  assert.ok(preview.includes("pre-commit"));
  assert.ok(fs.existsSync(settingsFile));
  assert.ok(fs.existsSync(hookFile));
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(fake.context.clotrGuardHome, { recursive: true, force: true });
});

test("the VS Code Guard picker hides Cline while Guard keeps its implementation", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-cline-"));
  const fake = fakeVscode([], {}, {}, workspace);
  let labels;
  await activateExtension(fake);
  fake.setPicks([
    (items) => items.find((item) => item.remove === false),
    (items) => {
      labels = items.map((item) => item.label);
      return [];
    },
  ]);
  await fake.commands.get("clotr.setupGuard")();
  // Guard keeps the Cline code (its setup function still exists) but leaves it out of the names it offers.
  assert.equal(typeof guard.updateClineHooks, "function");
  assert.equal(guard.TOOL_NAMES.includes("cline"), false);
  assert.equal(labels.includes("cline"), false);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(fake.context.clotrGuardHome, { recursive: true, force: true });
});

test("the workspace secret note asks VS Code's Git API with a path list and reads its answer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitapi-"));
  const envFile = path.join(root, ".env");
  const asked = [];
  let answer = new Set();
  const gitApi = {
    repositories: [
      {
        rootUri: { fsPath: root },
        async checkIgnore(paths) {
          if (!Array.isArray(paths)) throw new TypeError("checkIgnore takes a list of paths");
          asked.push(paths);
          return answer;
        },
      },
    ],
  };
  const fake = fakeVscode([], {}, {}, root);
  fake.vscode.extensions = {
    getExtension: (id) => (id === "vscode.git" ? { exports: { getAPI: () => gitApi } } : null),
  };
  fake.vscode.workspace.textDocuments.push(fake.mkDocument(envFile, `API_KEY=${KEY}`));
  await activateExtension(fake);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, [[envFile]]);
  assert.deepEqual(fake.vscode.window.messages, ["A secret file in this workspace isn't ignored by Git."]);

  const ignored = fakeVscode([], {}, {}, root);
  ignored.vscode.extensions = fake.vscode.extensions;
  ignored.vscode.workspace.textDocuments.push(ignored.mkDocument(envFile, `API_KEY=${KEY}`));
  answer = new Set([envFile]);
  await activateExtension(ignored);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ignored.vscode.window.messages, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Guard setup waits for workspace trust and says when Node.js is missing", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-trust-"));
  const untrusted = fakeVscode([], {}, {}, workspace);
  untrusted.vscode.workspace.isTrusted = false;
  await activateExtension(untrusted);
  await untrusted.commands.get("clotr.setupGuard")();
  assert.deepEqual(untrusted.vscode.window.messages, ["Trust this workspace before setting up Clotr Guard."]);
  assert.equal(untrusted.quickPicks.length, 0);

  const noNode = fakeVscode([], {}, {}, workspace);
  noNode.context.clotrNodeCommand = "clotr-no-such-node-command";
  await activateExtension(noNode);
  noNode.setPicks([
    (items) => items.find((item) => item.remove === false),
    (items) => items.filter((item) => item.label === "codex"),
  ]);
  await noNode.commands.get("clotr.setupGuard")();
  assert.deepEqual(noNode.vscode.window.messages, ["Node.js is required for Clotr Guard. Install it from nodejs.org."]);
  assert.equal(fs.existsSync(path.join(noNode.context.clotrGuardHome, ".codex")), false);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(noNode.context.clotrGuardHome, { recursive: true, force: true });
});

function packageFolder(extensions, version) {
  const root = path.join(extensions, `clotr-app.clotr-${version}`);
  fs.mkdirSync(root, { recursive: true });
  for (const file of ["extension.js", "package.json", "package.nls.json", "package.nls.es.json", "README.md"]) {
    fs.copyFileSync(path.join(APP, file), path.join(root, file));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...manifest, version }));
  buildVscode({ outDir: root, repoRoot: ROOT });
  return root;
}

test("Guard setup uses a global Guard first and the copy inside the extension only when there's none", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-global-"));
  const globalGuard = path.join(GLOBAL_MODULES, "clotr-guard");
  const fake = fakeVscode([], {}, {}, workspace);
  const settingsFile = path.join(fake.context.clotrGuardHome, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const setUpCodex = async () => {
    fake.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => items.filter((item) => item.label === "codex"),
    ]);
    await fake.commands.get("clotr.setupGuard")();
    return guard.managedHooks("codex", { home: fake.context.clotrGuardHome }).map((entry) => entry.script);
  };
  try {
    await activateExtension(fake);
    assert.deepEqual(await setUpCodex(), [path.join(APP, "guard", "bin", "clotr-guard.js")]);

    for (const name of ["bin", "lib", "dist"]) {
      fs.cpSync(path.join(APP, "guard", name), path.join(globalGuard, name), { recursive: true });
    }
    fs.copyFileSync(path.join(APP, "guard", "package.json"), path.join(globalGuard, "package.json"));
    assert.deepEqual(await setUpCodex(), [path.join(globalGuard, "bin", "clotr-guard.js")]);
    const prompt = spawnSync(process.execPath, [path.join(globalGuard, "bin", "clotr-guard.js"), "hook", "codex"], {
      input: JSON.stringify({ prompt: `Use ${KEY}` }),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: workspace },
    });
    assert.equal(JSON.parse(prompt.stdout).decision, "block");
  } finally {
    fs.rmSync(globalGuard, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fake.context.clotrGuardHome, { recursive: true, force: true });
  }
});

test("VS Code asks before setting Guard up again and its button runs the setup flow", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-update-"));
  const extensions = path.join(scratch, "extensions");
  const home = path.join(scratch, "home");
  const workspace = path.join(scratch, "project with space");
  try {
    const before = packageFolder(extensions, "0.0.1");
    const after = packageFolder(extensions, "0.0.2");
    fs.mkdirSync(workspace, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: workspace }).status, 0);
    const first = fakeVscode([], {}, {}, workspace);
    first.context.clotrGuardHome = home;
    await activateContainedExtension(before, first);
    assert.deepEqual(first.vscode.window.messages, []);
    first.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => items.filter((item) => ["claude", "codex"].includes(item.label)),
    ]);
    await first.commands.get("clotr.setupGuard")();
    const oldScript = path.join(before, "guard", "bin", "clotr-guard.js");
    const newScript = path.join(after, "guard", "bin", "clotr-guard.js");
    assert.deepEqual(guard.managedHooks("claude", { home }), [
      { script: oldScript, minimum: "medium", includePersonalDetails: false },
    ]);
    assert.deepEqual(guard.managedHooks("codex", { home }), [
      { script: oldScript, minimum: "medium", includePersonalDetails: false },
    ]);

    const settingsFiles = [path.join(home, ".claude", "settings.json"), path.join(home, ".codex", "hooks.json")];
    const beforePrompt = settingsFiles.map((file) => fs.readFileSync(file));
    const second = fakeVscode([], {}, {}, workspace);
    second.context.clotrGuardHome = home;
    second.globalValues.extensionVersion = "0.0.1";
    second.setInformationChoice(undefined);
    await activateContainedExtension(after, second);
    await waitFor(() => second.vscode.window.messages.length > 0, "the Guard repair prompt");
    assert.deepEqual(second.vscode.window.messages, ["Clotr Guard moved since the last update. Set it up again?"]);
    assert.deepEqual(second.vscode.window.messageCalls[0].choices, ["Set it up again"]);
    assert.deepEqual(
      settingsFiles.map((file) => fs.readFileSync(file)),
      beforePrompt,
    );

    const clicked = fakeVscode([], {}, {}, workspace);
    clicked.context.clotrGuardHome = home;
    clicked.globalValues.extensionVersion = "0.0.1";
    clicked.setInformationChoice("Set it up again");
    clicked.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => items.filter((item) => ["claude", "codex"].includes(item.label)),
    ]);
    await activateContainedExtension(after, clicked);
    await waitFor(() => clicked.vscode.window.messages.includes("Clotr's guard settings were updated."), "Guard setup");
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [newScript],
    );
    assert.deepEqual(
      guard.managedHooks("codex", { home }).map((entry) => entry.script),
      [newScript],
    );
    assert.equal(clicked.quickPicks.length, 2);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the VS Code manifest declares limited support for untrusted workspaces", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const trust = manifest.capabilities?.untrustedWorkspaces;
  assert.equal(trust?.supported, "limited");
  for (const key of ["clotr.enabled", "clotr.skipList", "clotr.minSeverity", "clotr.personalDetailsInFiles"]) {
    assert.ok(trust.restrictedConfigurations.includes(key), key);
  }
  assert.equal(manifest.license, "AGPL-3.0-or-later");
});

test("one document that fails to check doesn't stop later checks", async () => {
  const fake = fakeVscode([]);
  const document = fake.mkDocument("C:/project/edited.txt", "No private details here.");
  fake.vscode.workspace.textDocuments.push(document);
  await activateExtension(fake);
  const detect = fake.engineContext.Clotr.detect;
  let failed = false;
  fake.engineContext.Clotr.detect = (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("engine failure");
    }
    return detect(...args);
  };
  fake.fireTextChange(document);
  await waitFor(() => failed, "the failed check");
  document.setText(`const token = "${KEY}";`);
  fake.fireTextChange(document);
  await waitFor(() => fake.entries.get(document.uri.toString())?.length === 1, "the next check's finding");
});

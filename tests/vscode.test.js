"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { inflateRawSync } = require("node:zlib");
const { EventEmitter: NodeEventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { build } = require("../tools/engine-bundle.js");
const { isSecretFile } = require("../apps/guard/lib/secret-files.js");
const { MAX_PATTERN_LENGTH, valueFingerprint } = require("../apps/guard/lib/clotrignore.js");
const guard = require("../apps/guard/bin/clotr-guard.js");
const { build: buildVscode } = require("../apps/vscode/build.js");
const { makeSecrets } = require("./fixtures/secrets.js");
const { PHONE_LIST_FALSE_ALARM } = require("./fixtures/engine-corpus.js");
const {
  codeFiles,
  codeSource,
  copyShippedFiles,
  loadVscodeExtension,
  requireCalls,
  reachedFiles,
} = require("./load-vscode-extension.js");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "apps", "vscode");
const BUNDLE = path.join(APP, "guard", "dist", "clotr-engine.js");
const VSIX = path.join(APP, `clotr-${require("../apps/vscode/package.json").version}.vsix`);
const KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");
const currentBundle = build().text;
buildVscode();
assert.equal(fs.readFileSync(BUNDLE, "utf8"), currentBundle, "VS Code's engine bundle is stale");

// Guard's lib files from its package.json `files` list, which is what the build copies, as paths in the built copy.
function guardLibFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "guard", "package.json"), "utf8"));
  // The build skips lib/mcp-server/, which the extension never runs, so it isn't in the built copy.
  return pkg.files
    .filter((file) => file.startsWith("lib/") && !file.startsWith("lib/mcp-server/"))
    .sort()
    .map((file) => `guard/${file}`);
}

test("VS Code runtime and its bundled Guard have no network calls", () => {
  const files = [
    ...codeFiles().map((file) => path.join(APP, file)),
    path.join(APP, "guard", "bin", "clotr-guard.js"),
    ...guardLibFiles().map((file) => path.join(APP, file)),
  ];
  const network = /\b(?:fetch|XMLHttpRequest|WebSocket)\b|node:https?|https?\.request|net\.connect|axios|got\s*\(/i;
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), network, path.relative(ROOT, file));
});
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

async function waitFor(condition, what, timeoutMs = 30_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeChildProcess({ status = 0, stdout = "", stderr = "", error } = {}) {
  const child = new NodeEventEmitter();
  child.stdout = new NodeEventEmitter();
  child.stderr = new NodeEventEmitter();
  child.kill = () => true;
  process.nextTick(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", status, null);
  });
  return child;
}

function readZipEntry(file, wantedName) {
  const archive = fs.readFileSync(file);
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  assert.notEqual(end, -1, `${path.basename(file)} has a ZIP directory`);
  const entryCount = archive.readUInt16LE(end + 10);
  let central = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(central), 0x02014b50, "ZIP central entry signature");
    const method = archive.readUInt16LE(central + 10);
    const compressedSize = archive.readUInt32LE(central + 20);
    const nameLength = archive.readUInt16LE(central + 28);
    const extraLength = archive.readUInt16LE(central + 30);
    const commentLength = archive.readUInt16LE(central + 32);
    const localOffset = archive.readUInt32LE(central + 42);
    const name = archive.subarray(central + 46, central + 46 + nameLength).toString("utf8");
    if (name === wantedName) {
      assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, "ZIP local entry signature");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) return compressed.toString("utf8");
      assert.equal(method, 8, `ZIP compression method for ${name}`);
      return inflateRawSync(compressed).toString("utf8");
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wantedName} is in ${path.basename(file)}`);
}

test("VS Code uses the current engine bundle", () => {
  assert.equal(fs.readFileSync(BUNDLE, "utf8"), currentBundle);
});

test("the Node 14-compatible VS Code engine still finds a credential", () => {
  const context = vm.createContext({});
  vm.runInContext(currentBundle, context, { filename: "vs-code-engine-floor.js" });
  context.ClotrHost.init({ salt: "a".repeat(32), locale: "en" });
  const result = context.ClotrHost.check(`const key = "${KEY}";`);
  assert.equal(result.findings.length, 1);
});

test("the VSIX engine matches the extension engine across the shared fixture corpus", () => {
  assert.equal(
    build().version,
    JSON.parse(fs.readFileSync(path.join(ROOT, "apps/engine/package.json"), "utf8")).version,
  );
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-engine-parity-"));
  try {
    buildVscode({ outDir: packageRoot, repoRoot: ROOT });
    const sourceContext = vm.createContext({});
    const packageContext = vm.createContext({});
    vm.runInContext(currentBundle, sourceContext, { filename: "source-engine.js" });
    const bundledPath = path.join(packageRoot, "guard", "dist", "clotr-engine.js");
    vm.runInContext(fs.readFileSync(bundledPath, "utf8"), packageContext, { filename: "vsix-engine.js" });
    const normalize = (context, text) =>
      JSON.parse(
        JSON.stringify(context.Clotr.detect(text).map(({ id, severity, matches }) => ({ id, severity, matches }))),
      );
    const corpus = makeSecrets(20261019).flatMap(({ kind, shapes }) =>
      shapes.map(({ name, text }) => ({ name: `${kind}:${name}`, text })),
    );
    for (const fixture of corpus) {
      assert.deepEqual(normalize(packageContext, fixture.text), normalize(sourceContext, fixture.text), fixture.name);
    }
    for (const provider of ["openvsx", "rubygems", "jetbrainsMarketplace"]) {
      const fixture = corpus.find(({ name }) => name === `service_token:${provider}Bare`);
      assert.ok(fixture, `the shared fixture corpus includes a ${provider} registry token`);
      assert.ok(
        normalize(packageContext, fixture.text).some((finding) => finding.id === "service_token"),
        provider,
      );
    }
    assert.deepEqual(normalize(sourceContext, PHONE_LIST_FALSE_ALARM), []);
    assert.deepEqual(normalize(packageContext, PHONE_LIST_FALSE_ALARM), []);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test(
  "the packaged VSIX engine matches the extension engine across the shared fixture corpus",
  { skip: !fs.existsSync(VSIX) },
  () => {
    const manifest = JSON.parse(readZipEntry(VSIX, "extension/package.json"));
    assert.equal(manifest.version, "0.3.2");
    assert.equal(manifest.engines.vscode, "^1.57.0");
    assert.deepEqual(manifest.extensionKind, ["workspace"]);
    assert.equal(manifest.icon, "icon.png");
    assert.equal(manifest.contributes.walkthroughs[0].steps[0].completionEvents, undefined);
    const sourceContext = vm.createContext({});
    const packageContext = vm.createContext({});
    vm.runInContext(currentBundle, sourceContext, { filename: "source-engine.js" });
    const packagedEngine = readZipEntry(VSIX, "extension/guard/dist/clotr-engine.js");
    assert.equal(packagedEngine, currentBundle, "the VSIX carries the exact engine bundle built from this source");
    vm.runInContext(packagedEngine, packageContext, { filename: "vsix-engine.js" });
    const normalize = (context, text) =>
      JSON.parse(
        JSON.stringify(context.Clotr.detect(text).map(({ id, severity, matches }) => ({ id, severity, matches }))),
      );
    const corpus = makeSecrets(20261019).flatMap(({ kind, shapes }) =>
      shapes.map(({ name, text }) => ({ name: `${kind}:${name}`, text })),
    );
    for (const fixture of corpus) {
      assert.deepEqual(normalize(packageContext, fixture.text), normalize(sourceContext, fixture.text), fixture.name);
    }
    for (const provider of ["openvsx", "rubygems", "jetbrainsMarketplace"]) {
      const fixture = corpus.find(({ name }) => name === `service_token:${provider}Bare`);
      assert.ok(fixture, `the shared fixture corpus includes a ${provider} registry token`);
      assert.ok(
        normalize(packageContext, fixture.text).some((finding) => finding.id === "service_token"),
        provider,
      );
    }
    assert.deepEqual(normalize(sourceContext, PHONE_LIST_FALSE_ALARM), []);
    assert.deepEqual(normalize(packageContext, PHONE_LIST_FALSE_ALARM), []);
  },
);

// Open VSX shows the version beside the README, and the engine build changes with every batch, so neither
// number is typed into the README, where it would go stale.
test("VS Code is 0.3.2 and its README leaves version numbers to the extension listing", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(APP, "README.md"), "utf8");
  assert.equal(editor.version, "0.3.2");
  assert.doesNotMatch(readme, /^Version \d/m);
  assert.doesNotMatch(readme, /engine \d+\.\d+\.\d+/i);
});

test("the VS Code README reads as a store page in the owner's voice and keeps build steps behind a link", () => {
  const readme = fs.readFileSync(path.join(APP, "README.md"), "utf8");
  const expectedOpening = [
    "# Clotr for VS Code-compatible editors",
    "",
    "I built Clotr for people who code with AI assistants in VS Code, Cursor, Windsurf and VSCodium. It underlines API keys, tokens and passwords in the files you have open, so you know they're there before they end up in a prompt. It names the kind of credential and never shows the value.",
    "",
    "Clotr Guard, which you can set up from the extension, goes further: it checks your prompts before they're sent and stops supported assistants from reading secret files such as `.env`.",
    "",
    "![Clotr warning on an unsaved sample in Cursor](https://github.com/clotr-app/clotr/raw/HEAD/apps/vscode/images/open-file-warning.png)",
  ].join("\n");
  assert.ok(readme.startsWith(`${expectedOpening}\n\n## Install\n`), "README opening and screenshot match exactly");
  // The packager points a relative link at the repository's root, which this folder isn't, so the listing would get a
  // dead link. Every link here is a full one.
  assert.doesNotMatch(readme, /\]\((?!https?:|#|mailto:)/);
  assert.match(readme, /no network calls/);
  assert.match(readme, /without showing its value/);
  assert.match(readme, /\.clotrignore/);
  assert.match(readme, /salted fingerprint/);
  assert.match(readme, /Move to \.env/);
  assert.match(readme, /These steps work in VS Code-compatible editors/);
  assert.match(readme, /Path patterns in `\.clotrignore` do not skip files/);
  assert.match(readme, /Files over 1 MiB and binary files show a warning/);
  assert.match(readme, /Workspace state stores a random salt/);
  assert.match(readme, /not registered for Settings Sync/);
  assert.match(readme, /Clotr Guard/);
  assert.match(
    readme,
    /ignore clears when the occurrence changes or disappears, the file closes, or the extension reloads/i,
  );
  assert.match(readme, /rate Clotr on Open VSX/i);
  assert.match(readme, /report a problem/i);
  assert.doesNotMatch(readme, /\*\*Clotr:/);
  assert.doesNotMatch(readme, /shows a masked preview|masked findings/);
  assert.doesNotMatch(readme, /Stable and preview|Guard setup is a preview/);
  assert.doesNotMatch(readme, /vsce|Extension Development Host|build\.js/);
  const ownFolder = "https://github.com/clotr-app/clotr/raw/HEAD/apps/vscode/";
  for (const [, link] of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    assert.ok(link.startsWith(ownFolder), `README image ${link} comes from this folder`);
    assert.ok(fs.existsSync(path.resolve(APP, link.slice(ownFolder.length))), `README image ${link} exists`);
  }
  const screenshot = fs.readFileSync(path.join(APP, "images", "open-file-warning.png"));
  assert.equal(screenshot.subarray(1, 4).toString("latin1"), "PNG");
  assert.ok(screenshot.length > 10_000, "the Open VSX picture is a rendered screenshot");
  const building = /^## Building it\n\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme)?.[1].trim();
  assert.ok(building, "the README keeps a Building it section");
  assert.equal(building.split("\n").length, 1, "Building it is one line");
  assert.match(building, /\]\(https:\/\/github\.com\/clotr-app\/clotr[^)]*\)/);
  // The export moves public/CONTRIBUTING.md to the public repo's root.
  const guide = ["public", "."].map((folder) => path.join(ROOT, folder, "CONTRIBUTING.md")).find(fs.existsSync);
  const contributing = fs.readFileSync(guide, "utf8");
  assert.match(contributing, /node apps\/vscode\/build\.js/);
  assert.match(contributing, /npx --yes @vscode\/vsce package --no-dependencies/);
});

test("Guard's Node.js minimum is stated consistently in English and Spanish", () => {
  const readme = fs.readFileSync(path.join(APP, "README.md"), "utf8");
  const english = JSON.parse(fs.readFileSync(path.join(APP, "package.nls.json"), "utf8"));
  const spanish = JSON.parse(fs.readFileSync(path.join(APP, "package.nls.es.json"), "utf8"));
  assert.match(readme, /Node\.js 20 or newer/);
  assert.match(english.nodeRequired, /Node\.js 20 or newer/);
  assert.match(english.walkthroughGuardDescription, /Node\.js 20 or newer/);
  assert.match(spanish.nodeRequired, /Node\.js 20 o posterior/);
  assert.match(spanish.walkthroughGuardDescription, /Node\.js 20 o posterior/);
});

test("VS Code stores detection state in workspace storage and never asks Settings Sync to copy it", () => {
  const source = codeSource();
  assert.match(source, /const state = context\.workspaceState/);
  assert.doesNotMatch(source, /setKeysForSync|globalState\.(?:get|update)\(["'](?:salt|ignored|disabledFiles)["']/);
  for (const language of [require("../apps/vscode/package.nls.json"), require("../apps/vscode/package.nls.es.json")]) {
    assert.match(language.minSeverity, /Guard.*level selected when set up|Guard.*nivel elegido al configurarlos/i);
    assert.doesNotMatch(language.minSeverity, /hooks? use the same level|hooks? usan el mismo nivel/i);
  }
});

test("the Open VSX listing has its install metadata, icon, banner, and repository links", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  assert.equal(editor.publisher, "clotr-app");
  assert.equal(editor.name, "clotr");
  assert.equal(editor.engines.vscode, "^1.57.0");
  assert.deepEqual(editor.extensionKind, ["workspace"]);
  assert.equal(editor.icon, "icon.png");
  const icon = fs.readFileSync(path.join(APP, editor.icon));
  assert.equal(icon.subarray(1, 4).toString("latin1"), "PNG");
  const dimensions = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.ok(dimensions.every((size) => size >= 128));
  assert.equal(dimensions[0], dimensions[1]);
  const packageIgnore = fs.readFileSync(path.join(APP, ".vscodeignore"), "utf8");
  assert.match(packageIgnore, /^!icon\.png$/m);
  assert.match(packageIgnore, /^!src\/\*\*$/m);
  assert.match(packageIgnore, /^!images\/\*\*$/m);

  assert.deepEqual(editor.categories, ["AI", "Linters", "Other"]);
  assert.deepEqual(editor.galleryBanner, { color: "#1A1221", theme: "dark" });
  assert.deepEqual(editor.keywords, [
    "secrets",
    "credentials",
    "api key",
    "api keys",
    "passwords",
    "tokens",
    "privacy",
    "pii",
    "ai",
    "ai coding assistants",
    "claude code",
    "copilot",
    "cursor",
    "windsurf",
    "vscodium",
    "kiro",
    "trae",
    "code-server",
    "gitpod",
    "gemini cli",
    "codex",
    "cline",
    "leak",
  ]);
  assert.equal(editor.qna, "https://github.com/clotr-app/clotr/discussions");
  assert.deepEqual(editor.bugs, { url: "https://github.com/clotr-app/clotr/issues" });
  assert.equal(editor.repository.url, "https://github.com/clotr-app/clotr");
  assert.equal(editor.homepage, "https://clotr.app/developers.html");
  assert.ok(editor.keywords.length <= 30);
  assert.deepEqual(
    editor.categories.filter(
      (category) =>
        ![
          // 0.2.0 and 0.2.1 were accepted by both stores with AI; it is the Marketplace shelf AI-editor users browse.
          "Programming Languages",
          "Snippets",
          "AI",
          "Chat",
          "Linters",
          "Themes",
          "Debuggers",
          "Formatters",
          "Keymaps",
          "SCM Providers",
          "Other",
          "Extension Packs",
          "Language Packs",
          "Data Science",
          "Machine Learning",
          "Visualization",
          "Notebooks",
          "Education",
          "Testing",
        ].includes(category),
    ),
    [],
  );
  assert.ok(editor.activationEvents.includes("onStartupFinished"));
  assert.ok(!editor.activationEvents.includes("*"));
  const en = require("../apps/vscode/package.nls.json");
  const es = require("../apps/vscode/package.nls.es.json");
  assert.equal(en.displayName, "Clotr for VS Code-compatible editors");
  assert.equal(es.displayName, "Clotr para editores compatibles con VS Code");
  assert.match(en.description, /secrets.*API keys.*credentials.*AI coding assistant/i);
  assert.match(es.description, /secretos.*claves API.*credenciales.*un asistente de programación con IA/i);
});

test("Open VSX hosts use the workspace host and the VS Code 1.57 API floor", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  assert.equal(editor.engines.vscode, "^1.57.0");
  assert.deepEqual(editor.extensionKind, ["workspace"]);
  for (const file of [...codeFiles(), "guard/bin/clotr-guard.js", ...guardLibFiles()]) {
    const source = fs.readFileSync(path.join(APP, file), "utf8");
    assert.doesNotMatch(source, /\.at\(/, `${file} runs on the VS Code 1.57 Node host`);
    assert.doesNotMatch(source, /Object\.hasOwn|structuredClone|fs\.rmSync/, `${file} runs on Node 12`);
  }
  const source = codeSource();
  assert.match(source, /vscode\.env\.appName/);
  assert.match(source, /vscode\.env\.uriScheme/);
  assert.doesNotMatch(source, /diagnostic\.data/, "Diagnostic.data is newer than the supported VS Code API floor");
  assert.doesNotMatch(source, /vscode\.proposed|enableProposedApi/);
});

test("finding: VS Code 1.57's Node 14 host can load the extension", () => {
  for (const file of [...codeFiles(), "guard/bin/clotr-guard.js", ...guardLibFiles(), "guard/dist/clotr-engine.js"]) {
    const source = fs.readFileSync(path.join(APP, file), "utf8");
    const imports = source.match(/^const .* = require\(["']node:/gm) || [];
    assert.deepEqual(imports, [], `${file} uses the Node 14.18-only module prefix`);
    assert.doesNotMatch(
      source,
      /\|\|=|\?\?=|&&=|\.at\(|Object\.hasOwn|\.replaceAll\(|\.toSorted\(|\.findLast(?:Index)?\(/,
      `${file} uses syntax or an API newer than the extension host`,
    );
  }
});

test("the extension's code files name their own folder only through bundled-guard.js", () => {
  // __dirname is the folder of the file it's written in, so a line that moves into src/ would silently change it.
  for (const file of codeFiles().filter((name) => name.startsWith("src/") && name !== "src/bundled-guard.js")) {
    assert.doesNotMatch(fs.readFileSync(path.join(APP, file), "utf8"), /\b__dirname\b/, file);
  }
});

test("the extension's code files require only at their top level", () => {
  for (const file of codeFiles()) {
    const late = requireCalls(APP, file).filter((call) => call.inFunction);
    assert.deepEqual(
      late.map((call) => `${file}:${call.line}`),
      [],
      "a require inside a function would miss the tests' stand-ins",
    );
  }
});

test("every code file of the extension is reached from extension.js", () => {
  assert.deepEqual(reachedFiles(), codeFiles());
});

test("only extension.js registers commands", () => {
  for (const file of codeFiles().filter((name) => name !== "extension.js")) {
    assert.doesNotMatch(fs.readFileSync(path.join(APP, file), "utf8"), /registerCommand/, file);
  }
});

test("open-file warnings name the editor hosting Clotr", async () => {
  for (const [appName, uriScheme, expected] of [
    ["Cursor", "vscode", "Cursor"],
    ["Windsurf", "vscode", "Windsurf"],
    ["VSCodium", "vscode", "VSCodium"],
    ["Kiro", "vscode", "Kiro"],
    ["Trae", "vscode", "Trae"],
    ["code-server", "vscode", "code-server"],
    ["", "windsurf", "Windsurf"],
  ]) {
    const fake = fakeVscode([]);
    fake.vscode.env.appName = appName;
    fake.vscode.env.uriScheme = uriScheme;
    const document = fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`);
    fake.vscode.workspace.textDocuments.push(document);
    await activateExtension(fake);
    const [diagnostic] = fake.entries.get(document.uri.toString());
    assert.ok(diagnostic.message.includes(expected), `${appName || uriScheme} is named`);
    if (expected !== "VS Code") assert.ok(!diagnostic.message.includes("VS Code"));
  }
});

test("a first-run welcome offers one dismissible Try it action, once per install, in both languages", async () => {
  const globalState = { welcomeShown: false };
  const fake = fakeVscode([], {}, {}, null, globalState);
  fake.vscode.env.appName = "Cursor";
  fake.setInformationChoice(undefined);
  await activateExtension(fake);
  await waitFor(() => globalState.welcomeShown === true && fake.vscode.window.messageCalls.length > 0, "first welcome");
  assert.equal(fake.vscode.window.messageCalls.length, 1);
  assert.match(fake.vscode.window.messageCalls[0].message, /Cursor/);
  assert.ok(!fake.vscode.window.messageCalls[0].message.includes("VS Code"));
  assert.deepEqual(fake.vscode.window.messageCalls[0].choices, ["Try it"]);
  const again = fakeVscode([], {}, {}, null, globalState);
  await activateExtension(again);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(again.vscode.window.messageCalls.length, 0, "dismissing the welcome does not show it again");

  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const en = require("../apps/vscode/package.nls.json");
  const es = require("../apps/vscode/package.nls.es.json");
  const command = editor.contributes.commands.find((item) => item.command === "clotr.tryIt");
  assert.equal(command.title, "%tryItCommand%");
  assert.ok(en.tryItCommand && es.tryItCommand);
});

test("the welcome Try it button opens the same checked sample", async () => {
  const fake = fakeVscode([], {}, {}, null, { welcomeShown: false });
  fake.setInformationChoice("Try it");
  await activateExtension(fake);
  await waitFor(() => fake.vscode.window.activeTextEditor?.document, "Try it sample");
  const document = fake.vscode.window.activeTextEditor.document;
  assert.equal(document.uri.scheme, "untitled");
  assert.equal(fake.entries.get(document.uri.toString())[0].code, "aws_access_key");
});

test("Try it opens an untitled fake-key sample and diagnoses it", async () => {
  const fake = fakeVscode([], {}, {}, null, { welcomeShown: true });
  fake.vscode.env.appName = "Cursor";
  await activateExtension(fake);
  await fake.commands.get("clotr.tryIt")();
  const document = fake.vscode.window.activeTextEditor.document;
  const [diagnostic] = fake.entries.get(document.uri.toString());
  assert.equal(document.uri.scheme, "untitled");
  assert.equal(document.isUntitled, true);
  assert.equal(document.getText(), `const AWS_ACCESS_KEY_ID = "${KEY}";\n`);
  assert.match(document.getText(), new RegExp(KEY));
  assert.equal(diagnostic.code, "aws_access_key");
  assert.ok(!diagnostic.message.includes(KEY));
});

test("a first-run walkthrough says what Clotr checks, how to try it, and how to set up Guard, in both languages", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const en = require("../apps/vscode/package.nls.json");
  const es = require("../apps/vscode/package.nls.es.json");
  const [walkthrough, ...others] = editor.contributes.walkthroughs;
  assert.equal(others.length, 0);
  assert.equal(walkthrough.steps.length, 3);
  const words = (value) => /^%(.+)%$/.exec(value)?.[1];
  assert.deepEqual(
    walkthrough.steps.map((step) => step.media.image),
    ["icon.png", "images/open-file-warning.png", "images/guard-setup-preview.png"],
  );
  const altKeys = walkthrough.steps.map((step) => words(step.media.altText));
  assert.equal(new Set(altKeys).size, 3, "each walkthrough picture has its own alt text");
  for (const language of [en, es]) {
    assert.equal(new Set(altKeys.map((key) => language[key])).size, 3, "each picture's alt text is distinct");
  }
  for (const value of [walkthrough.title, walkthrough.description]) {
    assert.ok(en[words(value)] && es[words(value)], `${value} is in both languages`);
  }
  for (const step of walkthrough.steps) {
    for (const value of [step.title, step.description, step.media.altText]) {
      assert.ok(en[words(value)] && es[words(value)], `${value} is in both languages`);
    }
    assert.ok(fs.existsSync(path.join(APP, step.media.image)), `${step.id}'s picture ships`);
  }
  const [what, tryIt, guardStep] = walkthrough.steps.map((step) => words(step.description));
  for (const [language, keyPhrase] of [
    [en, "made-up AWS key that starts with AKIA"],
    [es, "clave de AWS inventada que empieza por AKIA"],
  ]) {
    assert.match(language[what], /\b(AI|IA)\b/);
    assert.ok(
      language[tryIt].includes(keyPhrase),
      "the try-it step identifies the made-up key without spelling it out",
    );
    assert.ok(!language[tryIt].includes(KEY), "the try-it step never ships the whole key");
    assert.ok(language[tryIt].includes("(command:clotr.tryIt)"));
    assert.ok(language[guardStep].includes("(command:clotr.setupGuard)"));
  }
  assert.deepEqual(walkthrough.steps[1].completionEvents, ["onCommand:clotr.tryIt"]);
  assert.deepEqual(walkthrough.steps[2].completionEvents, ["onCommand:clotr.setupGuard"]);
  assert.equal(walkthrough.steps[0].completionEvents, undefined);
  assert.match(en[guardStep], /open-vsx\.org\/extension\/clotr-app\/clotr\/reviews/i);
  assert.match(en[guardStep], /github\.com\/clotr-app\/clotr\/issues/i);
  assert.match(
    en[guardStep],
    /Did Clotr catch something\? Tell us\]\(https:\/\/github\.com\/clotr-app\/clotr\/discussions\)/,
  );
  assert.match(es[guardStep], /open-vsx\.org\/extension\/clotr-app\/clotr\/reviews/i);
  assert.match(es[guardStep], /github\.com\/clotr-app\/clotr\/issues/i);
  assert.match(
    es[guardStep],
    /¿Clotr detectó algo\? Cuéntanos\]\(https:\/\/github\.com\/clotr-app\/clotr\/discussions\)/,
  );
});

test("the Guard command's title says it sets Guard up", () => {
  assert.equal(
    require("../apps/vscode/package.nls.json").setupGuard,
    "Clotr: Set up Clotr Guard for AI coding assistants",
  );
  assert.match(require("../apps/vscode/package.nls.es.json").setupGuard, /^Clotr: Configurar Clotr Guard/);
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

test("a prebuilt VS Code folder missing a listed Guard lib file fails the build", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-prebuilt-"));
  try {
    buildVscode({ outDir: packageRoot, repoRoot: ROOT });
    fs.rmSync(path.join(packageRoot, "guard", "lib", "text-checks", "engine-loader.js"));
    assert.throws(
      () => buildVscode({ outDir: packageRoot, repoRoot: path.join(packageRoot, "missing-source") }),
      /missing Guard's bundled runtime/,
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
      ...guardLibFiles(),
      "guard/package.json",
    ]);
    const packageInputs = [...codeFiles(), "package.json", "package.nls.json", "package.nls.es.json"].map((file) => [
      file,
      fs.readFileSync(path.join(APP, file), "utf8"),
    ]);
    const builtFiles = files.map((file) => [file, fs.readFileSync(path.join(packageRoot, ...file.split("/")), "utf8")]);
    for (const [file, text] of [...packageInputs, ...builtFiles, ["generated engine bundle", currentBundle]]) {
      assert.ok(!text.includes(KEY), `${file} contains the whole demo AWS key`);
    }
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

function fakeVscode(
  documents,
  stateValues = {},
  configValues = {},
  workspaceRoot = null,
  globalStateValues = { welcomeShown: true },
) {
  const commands = new Map();
  const entries = new Map();
  const config = { enabled: true, minSeverity: "medium", skipList: [], ...configValues };
  const treeViews = new Map();
  const statusItems = [];
  const codeActionProviders = [];
  let picks = [];
  const quickPicks = [];
  let textChangeListener;
  let closeDocumentListener;
  let openDocumentListener;
  const fileSystemWatchers = [];
  let informationChoice;
  let informationChoiceSet = false;
  let warningChoice;
  let warningChoiceSet = false;
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
  class Position {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  class WorkspaceEdit {
    constructor() {
      this.operations = [];
    }
    replace(uri, range, value) {
      this.operations.push({ type: "replace", uri, range, value });
    }
    insert(uri, position, value) {
      this.operations.push({ type: "insert", uri, position, value });
    }
    createFile(uri) {
      this.operations.push({ type: "createFile", uri });
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
    Position,
    WorkspaceEdit,
    Uri: { file: (file) => uri(file) },
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeAction,
    CodeActionKind: { QuickFix: 1 },
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    EventEmitter,
    StatusBarAlignment: { Left: 1 },
    env: { language: "en", appName: "Visual Studio Code", uriScheme: "vscode", clipboard },
    window: {
      activeTextEditor: null,
      messages: [],
      messageCalls: [],
      showWarningMessage: async function (message, ...choices) {
        this.messages.push(message);
        this.messageCalls.push({ message, choices });
        return warningChoiceSet ? warningChoice : choices.at(-1);
      },
      showInformationMessage: async function (message, ...choices) {
        this.messages.push(message);
        this.messageCalls.push({ message, choices });
        return informationChoiceSet ? informationChoice : choices.at(-1);
      },
      showErrorMessage: async function (message, ...choices) {
        this.messages.push(message);
        this.messageCalls.push({ message, choices });
        return choices.at(-1);
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
      async showTextDocument(document) {
        this.activeTextEditor = { document };
        return this.activeTextEditor;
      },
    },
    workspace: {
      textDocuments: documents,
      asRelativePath: (u) =>
        workspaceRoot ? path.relative(workspaceRoot, u.fsPath).replace(/\\/g, "/") : path.basename(u.fsPath),
      workspaceFolders: workspaceRoot ? [{ uri: { fsPath: workspaceRoot } }] : undefined,
      isTrusted: true,
      async openTextDocument(options) {
        if (options?.scheme === "file" && options.fsPath) {
          const existing = documents.find(
            (document) => path.resolve(document.uri.fsPath) === path.resolve(options.fsPath),
          );
          if (existing) return existing;
          const document = mkDocument(options.fsPath, fs.readFileSync(options.fsPath, "utf8"));
          documents.push(document);
          return document;
        }
        const document = mkDocument(`Untitled-${documents.length + 1}`, options.content || "");
        document.uri.scheme = "untitled";
        document.isUntitled = true;
        document.languageId = options.language || "plaintext";
        documents.push(document);
        return document;
      },
      async applyEdit(edit) {
        const offsetFor = (text, position) => {
          if (!position.line) return Math.min(position.character, text.length);
          let line = 0;
          let offset = 0;
          while (line < position.line && offset < text.length) {
            const next = text.indexOf("\n", offset);
            if (next < 0) return text.length;
            offset = next + 1;
            line += 1;
          }
          return Math.min(offset + position.character, text.length);
        };
        for (const operation of edit.operations) {
          if (operation.type === "createFile") {
            fs.writeFileSync(operation.uri.fsPath, "", { flag: "wx" });
            continue;
          }
          const document = documents.find(
            (item) => path.resolve(item.uri.fsPath) === path.resolve(operation.uri.fsPath),
          );
          let content = document ? document.getText() : fs.readFileSync(operation.uri.fsPath, "utf8");
          if (operation.type === "insert") {
            const offset = offsetFor(content, operation.position);
            content = `${content.slice(0, offset)}${operation.value}${content.slice(offset)}`;
          } else {
            const start = document.offsetAt(operation.range.start);
            const end = document.offsetAt(operation.range.end);
            content = `${content.slice(0, start)}${operation.value}${content.slice(end)}`;
          }
          if (document) document.setText(content);
          else fs.writeFileSync(operation.uri.fsPath, content, "utf8");
        }
        return true;
      },
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }),
      onDidOpenTextDocument: (listener) => {
        openDocumentListener = listener;
        return { dispose() {} };
      },
      onDidChangeTextDocument: (listener) => {
        textChangeListener = listener;
        return { dispose() {} };
      },
      onDidCloseTextDocument: (listener) => {
        closeDocumentListener = listener;
        return { dispose() {} };
      },
      onDidChangeConfiguration: () => ({ dispose() {} }),
      createFileSystemWatcher(pattern) {
        const listeners = {};
        const watcher = {
          pattern,
          onDidCreate(listener) {
            listeners.create = listener;
            return { dispose() {} };
          },
          onDidChange(listener) {
            listeners.change = listener;
            return { dispose() {} };
          },
          onDidDelete(listener) {
            listeners.delete = listener;
            return { dispose() {} };
          },
          dispose() {},
        };
        fileSystemWatchers.push(listeners);
        return watcher;
      },
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
      registerCodeActionsProvider: (selector, provider, options) => {
        codeActionProviders.push({ selector, provider, options });
        return { dispose() {} };
      },
    },
    extensions: {},
    commands: {
      registerCommand: (name, fn) => {
        commands.set(name, fn);
        return { dispose() {} };
      },
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    },
  };
  const mkDocument = (file, content) => {
    let text = content;
    let getTextCalls = 0;
    let lineStarts = [0];
    const indexLines = () => {
      lineStarts = [0];
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
      }
    };
    indexLines();
    return {
      uri: uri(file),
      isUntitled: false,
      languageId: "plaintext",
      get getTextCalls() {
        return getTextCalls;
      },
      getText(range) {
        getTextCalls += 1;
        if (!range) return text;
        return text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
      },
      setText(value) {
        text = value;
        indexLines();
      },
      positionAt(offset) {
        const bounded = Math.max(0, Math.min(offset, text.length));
        let low = 0;
        let high = lineStarts.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (lineStarts[middle] <= bounded) low = middle + 1;
          else high = middle;
        }
        const line = Math.max(0, low - 1);
        return {
          line,
          character: bounded - lineStarts[line],
        };
      },
      offsetAt(position) {
        const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
        const nextLine = lineStarts[line + 1];
        const lineEnd = nextLine === undefined ? text.length : nextLine - 1;
        return Math.min(lineStarts[line] + position.character, lineEnd);
      },
    };
  };
  const globalValues = globalStateValues;
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
      get: (key, fallback) => globalStateValues[key] ?? fallback,
      async update(key, value) {
        globalStateValues[key] = value;
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
    codeActionProviders,
    quickPicks,
    config,
    setPicks(value) {
      picks = value;
    },
    setInformationChoice(value) {
      informationChoice = value;
      informationChoiceSet = true;
    },
    setWarningChoice(value) {
      warningChoice = value;
      warningChoiceSet = true;
    },
    fireTextChange(document) {
      textChangeListener?.({ document });
    },
    // VS Code's close event is the document itself; { wrapped: true } sends a { document } wrapper instead.
    fireClose(document, { wrapped = false } = {}) {
      const index = documents.indexOf(document);
      if (index >= 0) documents.splice(index, 1);
      closeDocumentListener?.(wrapped ? { document } : document);
    },
    fireOpen(document) {
      if (!documents.includes(document)) documents.push(document);
      openDocumentListener?.(document);
    },
    fireFileSystemEvent(kind, file) {
      for (const listeners of fileSystemWatchers) listeners[kind]?.(uri(file));
    },
  };
}

function allowGitIgnoreApiToAnswer(fake, root) {
  fake.vscode.extensions = {
    getExtension: (id) =>
      id === "vscode.git"
        ? {
            exports: {
              getAPI: () => ({
                repositories: [
                  {
                    rootUri: { fsPath: root },
                    async checkIgnore() {
                      return new Set();
                    },
                  },
                ],
              }),
            },
          }
        : undefined,
  };
}

async function activateExtension(fake, { spawnSync: spawnSyncMock, spawn: spawnMock } = {}) {
  const childProcess = {
    ...require("child_process"),
    ...(spawnSyncMock ? { spawnSync: spawnSyncMock } : {}),
    ...(spawnMock ? { spawn: spawnMock } : {}),
  };
  const createContext = vm.createContext;
  vm.createContext = (...args) => {
    fake.engineContext = createContext(...args);
    return fake.engineContext;
  };
  try {
    fake.extensionApi = loadVscodeExtension({ vscode: fake.vscode, childProcess });
    return await fake.extensionApi.activate(fake.context);
  } finally {
    vm.createContext = createContext;
  }
}

test("VS Code never takes Node or npm from the opened workspace PATH", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-path-"));
  const projectBin = path.join(workspace, "node_modules", ".bin");
  const externalBin = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-external-bin-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  fs.mkdirSync(projectBin, { recursive: true });
  for (const folder of [projectBin, externalBin]) {
    fs.writeFileSync(path.join(folder, `node${suffix}`), "fixture");
    fs.writeFileSync(path.join(folder, `npm${suffix}`), "fixture");
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(folder, `node${suffix}`), 0o755);
      fs.chmodSync(path.join(folder, `npm${suffix}`), 0o755);
    }
  }
  try {
    const fake = fakeVscode([], {}, {}, workspace);
    await activateExtension(fake);
    const env = { PATH: [projectBin, externalBin].join(path.delimiter) };
    const executable = fake.extensionApi.executable;
    assert.equal(
      executable("node", env, process.platform, workspace),
      fs.realpathSync(path.join(externalBin, `node${suffix}`)),
    );
    assert.equal(
      executable("npm", env, process.platform, workspace),
      fs.realpathSync(path.join(externalBin, `npm${suffix}`)),
    );
    assert.equal(executable("node", { PATH: projectBin }, process.platform, workspace), null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(externalBin, { recursive: true, force: true });
  }
});

async function activateContainedExtension(root, fake) {
  const api = loadVscodeExtension({ root, vscode: fake.vscode, contained: true });
  return await api.activate(fake.context);
}

test("the packaged VS Code extension loads with every dependency inside its folder", async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-package-"));
  try {
    copyShippedFiles(packageRoot);
    // The build's own files too, as in the source folder.
    for (const file of ["build.js", ".vscodeignore"]) {
      fs.copyFileSync(path.join(APP, file), path.join(packageRoot, file));
    }
    buildVscode({ outDir: packageRoot, repoRoot: ROOT });
    const fake = fakeVscode([]);
    await activateContainedExtension(packageRoot, fake);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("open file findings name the kind on its range without showing any part of the value", async () => {
  const fake = fakeVscode([]);
  fake.vscode.workspace.textDocuments.push(fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`));
  await activateExtension(fake);
  const diagnostics = [...fake.entries.values()][0];
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /AWS Access Key: Sensitive information found/);
  assert.doesNotMatch(diagnostics[0].message, /AKIA|3N/);
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

test("Ignore this one lasts until the file closes and suppresses only that occurrence", async () => {
  const fake = fakeVscode([]);
  const doc = fake.mkDocument("C:/project/app.js", `const first = "${KEY}";\nconst second = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  await activateExtension(fake);
  const finding = [...fake.entries.values()][0][0];
  assert.equal(fake.entries.get(doc.uri.toString()).length, 2);
  assert.equal(Object.hasOwn(finding, "data"), false);
  const actions = fake.codeActionProviders[0].provider.provideCodeActions(doc, finding.range, {
    diagnostics: [finding],
  });
  assert.equal(
    actions.some((action) => action.title === "Add fingerprint to .clotrignore"),
    false,
  );
  const [ignore] = actions;
  const [uri, occurrence, fingerprint] = ignore.command.arguments;
  await fake.commands.get("clotr.ignore")(uri, occurrence, fingerprint);
  assert.equal(fake.entries.get(doc.uri.toString()).length, 1);
  assert.equal(fake.entries.get(doc.uri.toString())[0].range.start.line, 1);
  assert.equal(fake.stateValues.ignored, undefined);
  assert.equal(JSON.stringify(fake.stateValues).includes(KEY), false);
  fake.fireClose(doc);
  fake.fireOpen(doc);
  await waitFor(() => fake.entries.get(doc.uri.toString())?.length === 2, "findings after the file reopens");
  assert.equal(fake.entries.get(doc.uri.toString()).length, 2);
});

for (const wrapped of [false, true]) {
  const shape = wrapped ? "a { document } wrapper" : "the document itself";
  test(`VS Code drops a closed document's diagnostics when the close event carries ${shape}`, async () => {
    const fake = fakeVscode([]);
    const doc = fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`);
    fake.vscode.workspace.textDocuments.push(doc);
    await activateExtension(fake);
    const tree = fake.treeViews.get("clotr.findings").treeDataProvider;
    assert.equal(fake.entries.get(doc.uri.toString()).length, 1, "the open document showed its finding");
    assert.equal(fake.statusItems[0].text, "$(shield) Clotr · 1 file · 1 finding");
    fake.fireClose(doc, { wrapped });
    assert.equal(fake.entries.has(doc.uri.toString()), false, "closing it took its diagnostics away");
    assert.deepEqual(tree.getChildren(), []);
    assert.equal(fake.statusItems[0].text, "$(shield) Clotr · 0 files");
  });
}

test("Guard child processes yield to the editor and time out without blocking", async () => {
  const fake = fakeVscode([]);
  await activateExtension(fake);
  assert.equal(typeof fake.extensionApi.runGuardCommand, "function");
  const runningChild = new NodeEventEmitter();
  runningChild.stdout = new NodeEventEmitter();
  runningChild.stderr = new NodeEventEmitter();
  let editorYielded = false;
  const completed = await fake.extensionApi.runGuardCommand(process.execPath, [], {}, 100, () => {
    setTimeout(() => {
      editorYielded = true;
      runningChild.emit("close", 0, null);
    }, 10);
    return runningChild;
  });
  assert.equal(completed.status, 0);
  assert.equal(editorYielded, true);

  const child = new NodeEventEmitter();
  child.stdout = new NodeEventEmitter();
  child.stderr = new NodeEventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  await assert.rejects(
    fake.extensionApi.runGuardCommand(process.execPath, [], {}, 10, () => child),
    (error) => error.code === "ETIMEDOUT",
  );
  assert.equal(killed, true);
});

test("Guard times out and kills a real hung child while the editor host can run", async (t) => {
  const fake = fakeVscode([]);
  await activateExtension(fake);
  const pidFile = path.join(os.tmpdir(), `clotr-vscode-hung-child-${process.pid}.txt`);
  t.after(() => fs.rmSync(pidFile, { force: true }));
  const source = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  // Leave enough time for Windows to start the child under load before the timeout kills it.
  const timeoutMs = 1000;
  const pending = fake.extensionApi.runGuardCommand(process.execPath, ["-e", source], {}, timeoutMs);
  let editorYielded = false;
  await new Promise((resolve) =>
    setTimeout(() => {
      editorYielded = true;
      resolve();
    }, 10),
  );
  await assert.rejects(pending, (error) => error.code === "ETIMEDOUT");
  assert.equal(editorYielded, true);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  let exited = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      if (error.code === "ESRCH") exited = true;
      else throw error;
      break;
    }
  }
  assert.equal(exited, true, "the timed-out Guard child should not remain running");
});

test("the .clotrignore quick fix writes only a salted fingerprint and quiets that value", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-add-ignore-"));
  const vscodeGuard = require(path.join(APP, "guard", "bin", "clotr-guard.js"));
  const originalAddIgnoredValue = vscodeGuard.addIgnoredValue;
  const calls = [];
  vscodeGuard.addIgnoredValue = (...args) => {
    calls.push(args);
    return originalAddIgnoredValue(...args);
  };
  try {
    const fake = fakeVscode([], {}, {}, root);
    const doc = fake.mkDocument(path.join(root, "app.js"), `const token = "${KEY}";`);
    fake.vscode.workspace.textDocuments.push(doc);
    await activateExtension(fake);
    const diagnostic = fake.entries.get(doc.uri.toString())[0];
    const actions = fake.codeActionProviders[0].provider.provideCodeActions(doc, diagnostic.range, {
      diagnostics: [diagnostic],
    });
    const addIgnore = actions.find((action) => action.title === "Add fingerprint to .clotrignore");
    assert.ok(addIgnore);
    await fake.commands.get(addIgnore.command.command)(...addIgnore.command.arguments);
    const saved = fs.readFileSync(path.join(root, ".clotrignore"), "utf8");
    const parsed = require("../apps/guard/lib/clotrignore.js").parseClotrIgnore(saved);
    assert.equal(calls[0]?.[2], "aws_access_key", "Guard receives the finding kind for its guessability check");
    assert.equal(parsed.valid, true);
    assert.ok(parsed.fingerprints.has(valueFingerprint(parsed.salt, KEY)));
    assert.doesNotMatch(saved, new RegExp(KEY));
    assert.equal(fake.entries.get(doc.uri.toString()).length, 0);
  } finally {
    vscodeGuard.addIgnoredValue = originalAddIgnoredValue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// It reads only VS Code's own file, so it lives with VS Code's tests and moves when that file does.
test("the VS Code quick fix writes .clotrignore through Guard's shared writer", () => {
  const source = fs.readFileSync(path.join(APP, "src", "findings-and-quick-fixes", "quick-fixes.js"), "utf8");
  const body = source.slice(
    source.indexOf("async function addToClotrIgnore"),
    source.indexOf("async function moveToEnv"),
  );
  assert.match(body, /guard\.addIgnoredValue\(/);
  assert.match(body, /guard\.addIgnoredValue\(root, finding\.value, finding\.kind\)/);
  assert.doesNotMatch(body, /writeSync|openSync|valueFingerprint/, "no second writer for the same file");
});

test("Move to .env replaces a quoted JavaScript value and writes the local environment entry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-move-env-"));
  try {
    const fake = fakeVscode([], {}, {}, root);
    const doc = fake.mkDocument(path.join(root, "app.js"), `const token = "${KEY}";`);
    doc.languageId = "javascript";
    fake.vscode.workspace.textDocuments.push(doc);
    await activateExtension(fake);
    const diagnostic = fake.entries.get(doc.uri.toString())[0];
    const actions = fake.codeActionProviders[0].provider.provideCodeActions(doc, diagnostic.range, {
      diagnostics: [diagnostic],
    });
    const move = actions.find((action) => action.title === "Move to .env");
    assert.ok(move);
    await fake.commands.get(move.command.command)(...move.command.arguments);
    assert.equal(doc.getText(), "const token = process.env.CLOTR_AWS_ACCESS_KEY;");
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), `CLOTR_AWS_ACCESS_KEY=${KEY}\n`);
    assert.equal(JSON.stringify(fake.vscode.window.messages).includes(KEY), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finding: Move to .env stays inside a nested workspace when a shared ancestor has .git", async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-move-env-boundary-"));
  const workspace = path.join(shared, "projects", "nested");
  fs.mkdirSync(path.join(shared, ".git"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const sample = makeSecrets(20261026).find((entry) => entry.kind === "aws_access_key").value;
  try {
    const fake = fakeVscode([], {}, {}, workspace);
    const doc = fake.mkDocument(path.join(workspace, "app.js"), `const token = "${sample}";`);
    doc.languageId = "javascript";
    fake.vscode.workspace.textDocuments.push(doc);
    await activateExtension(fake);
    const diagnostic = fake.entries.get(doc.uri.toString())[0];
    const actions = fake.codeActionProviders[0].provider.provideCodeActions(doc, diagnostic.range, {
      diagnostics: [diagnostic],
    });
    const move = actions.find((action) => action.title === "Move to .env");
    assert.ok(move);
    await fake.commands.get(move.command.command)(...move.command.arguments);
    assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), `CLOTR_AWS_ACCESS_KEY=${sample}\n`);
    assert.equal(fs.existsSync(path.join(shared, ".env")), false, "the shared ancestor never receives the value");
  } finally {
    fs.rmSync(shared, { recursive: true, force: true });
  }
});

test("VS Code honors value fingerprints but keeps checking files named by project path rules", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-clotrignore-"));
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  fs.writeFileSync(
    path.join(root, ".clotrignore"),
    `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, KEY)}\nfixtures/\n`,
  );
  try {
    const fake = fakeVscode([], {}, {}, root);
    const pathIgnored = fake.mkDocument(
      path.join(root, "fixtures", "sample.js"),
      'const key = "AKIAZ7Q3M9WX2KD5HB8R";',
    );
    const valueIgnored = fake.mkDocument(path.join(root, "value.js"), `const key = "${KEY}";`);
    const stillFound = fake.mkDocument(path.join(root, "other.js"), 'const key = "AKIAZ7Q3M9WX2KD5HB8R";');
    fake.vscode.workspace.textDocuments.push(pathIgnored, valueIgnored, stillFound);
    await activateExtension(fake);
    assert.equal(fake.entries.get(pathIgnored.uri.toString())?.length, 1);
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
    // A saved ID is a personal detail, so it's marked in a file only with the setting on.
    const fake = fakeVscode([document], {}, { personalDetailsInFiles: true }, root);
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
    assert.match(fake.vscode.window.messages[0], /Your Account\/ID Number: Sensitive information found/);
    assert.doesNotMatch(fake.vscode.window.messages[0], new RegExp(`${mine}|${other}`));
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
    assert.deepEqual(fake.vscode.window.messages, [
      "Your .clotrignore has a secret written out in full. Replace it with the output of clotr-guard ignore-value.",
    ]);
    assert.equal([...fake.entries.values()].flat().length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the shared-ignore refusal does not name a VS Code-only action", () => {
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "vscode", "package.nls.json"), "utf8"));
  assert.match(messages.clotrIgnoreGuessable, /shared ignore file/);
  assert.doesNotMatch(messages.clotrIgnoreGuessable, /Ignore this occurrence/);
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

test("clipboard check names findings without showing values and copies the cleaned text", async () => {
  const fake = fakeVscode([]);
  fake.clipboard.value = `Paste ${KEY} here`;
  await activateExtension(fake);
  await fake.commands.get("clotr.checkClipboard")();
  assert.match(fake.vscode.window.messages[0], /AWS Access Key: Sensitive information found/);
  assert.doesNotMatch(fake.vscode.window.messages[0], /AKIA|3N/);
  assert.doesNotMatch(fake.vscode.window.messages[0], new RegExp(KEY));
  assert.match(fake.clipboard.value, /\[REDACTED AWS ACCESS KEY\]/);
  assert.doesNotMatch(fake.clipboard.value, new RegExp(KEY));
});

test("VS Code checks files through 1 MiB and visibly marks larger or binary files unchecked", async () => {
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
  const tooLarge = fake.entries.get("file://C:/project/over-cap.txt");
  assert.equal(tooLarge?.length, 1);
  assert.equal(tooLarge[0].code, "check_unavailable");
  assert.match(tooLarge[0].message, /too large.*did not check/i);
  assert.doesNotMatch(tooLarge[0].message, new RegExp(KEY));
  const binary = fake.entries.get("file://C:/project/image.bin");
  assert.equal(binary?.length, 1);
  assert.equal(binary[0].code, "check_unavailable");
  assert.match(binary[0].message, /binary file/i);
  assert.match(fake.statusItems[0].text, /!/);
  assert.match(fake.statusItems[0].tooltip, /could not check/i);
});

test("VS Code refuses a very large clipboard without showing or copying its contents", async () => {
  const fake = fakeVscode([]);
  fake.clipboard.value = `password: ${KEY}\n${"x".repeat(1024 * 1024)}`;
  await activateExtension(fake);
  await fake.commands.get("clotr.checkClipboard")();
  assert.equal(fake.vscode.window.messages.length, 1);
  assert.match(fake.vscode.window.messages[0], /too large.*did not check/i);
  assert.doesNotMatch(fake.vscode.window.messages[0], new RegExp(KEY));
  assert.equal(fake.clipboard.value.includes(KEY), true);
});

test("VS Code shows a value-free message when a clipboard check fails", async () => {
  const fake = fakeVscode([]);
  fake.clipboard.value = `password: ${KEY}`;
  await activateExtension(fake);
  fake.engineContext.Clotr.detect = () => {
    throw new Error(KEY);
  };
  await fake.commands.get("clotr.checkClipboard")();
  assert.equal(fake.vscode.window.messages.length, 1);
  assert.match(fake.vscode.window.messages[0], /could not complete the check/i);
  assert.doesNotMatch(fake.vscode.window.messages[0], new RegExp(KEY));
  assert.equal(fake.clipboard.value, `password: ${KEY}`);
});

test("VS Code marks a file unchecked with a fixed message when its detection fails", async () => {
  const fake = fakeVscode([]);
  const document = fake.mkDocument("C:/project/unstable.js", "clean text");
  fake.vscode.workspace.textDocuments.push(document);
  await activateExtension(fake);
  fake.engineContext.Clotr.detect = () => {
    throw new Error(KEY);
  };
  document.setText(`password: ${KEY}`);
  fake.fireTextChange(document);
  await waitFor(
    () => fake.entries.get(document.uri.toString())?.[0]?.code === "check_unavailable",
    "the failed document's unchecked warning",
    3000,
  );
  const [diagnostic] = fake.entries.get(document.uri.toString());
  assert.match(diagnostic.message, /could not check this file/i);
  assert.doesNotMatch(diagnostic.message, new RegExp(KEY));
  assert.match(fake.statusItems[0].tooltip, /could not check/i);
});

test("a 5 MiB open file is rejected by its bounded length before its text is read", async () => {
  const fake = fakeVscode([], {}, {}, "C:/project");
  const doc = fake.mkDocument("C:/project/large.js", `${KEY}${"x".repeat(5 * 1024 * 1024)}`);
  const checked = fake.mkDocument("C:/project/checked.js", "const answer = 42;");
  fake.vscode.workspace.textDocuments.push(doc, checked);
  await activateExtension(fake);
  assert.equal(doc.getTextCalls, 0);
  assert.equal(fake.entries.get(doc.uri.toString())?.[0].code, "check_unavailable");
  assert.match(fake.statusItems[0].text, /1 file/);
  assert.match(fake.statusItems[0].text, /1 unchecked/);
  assert.match(fake.statusItems[0].tooltip, /could not check/i);
});

test("finding: reuse the workspace .clotrignore parse across open files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-ignore-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ignoreFile = path.join(root, ".clotrignore");
  fs.writeFileSync(
    ignoreFile,
    Array.from({ length: 8192 }, (_, index) => `x${index.toString(36).padStart(4, "0")}`).join("\n"),
  );
  const fake = fakeVscode([], {}, {}, root);
  fake.vscode.workspace.textDocuments.push(
    ...Array.from({ length: 32 }, (_, index) => fake.mkDocument(path.join(root, `open-${index}.txt`), "Harmless.")),
  );
  const openSync = fs.openSync;
  let ignoreReads = 0;
  fs.openSync = function (file, ...args) {
    if (path.resolve(String(file)) === ignoreFile) ignoreReads += 1;
    return openSync.call(this, file, ...args);
  };
  const started = Date.now();
  let activationMs;
  let readsAfterOpen;
  let readsAfterEdit;
  try {
    await activateExtension(fake);
    activationMs = Date.now() - started;
    readsAfterOpen = ignoreReads;
    let checks = 0;
    const detect = fake.engineContext.Clotr.detect;
    fake.engineContext.Clotr.detect = (...args) => {
      checks += 1;
      return detect(...args);
    };
    const editStarted = Date.now();
    fake.vscode.workspace.textDocuments[0].setText("One harmless edit.");
    fake.fireTextChange(fake.vscode.workspace.textDocuments[0]);
    await waitFor(() => checks > 0, "the changed document check");
    readsAfterEdit = ignoreReads - readsAfterOpen;
    t.diagnostic(
      `One edit: ${readsAfterEdit} more .clotrignore read(s) (${readsAfterEdit * fs.statSync(ignoreFile).size} bytes), ${Date.now() - editStarted} ms.`,
    );
  } finally {
    fs.openSync = openSync;
  }
  const fileBytes = fs.statSync(ignoreFile).size;
  t.diagnostic(
    `32 open files: ${readsAfterOpen} .clotrignore reads (${readsAfterOpen * fileBytes} bytes); ` +
      `after one edit: ${ignoreReads} total reads (${ignoreReads * fileBytes} bytes), ${activationMs} ms activation.`,
  );
  assert.equal(ignoreReads, 1, `one shared workspace config should be read once; it was read ${ignoreReads} times`);
});

test("the .clotrignore cache invalidates on create, change, and delete", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-ignore-invalidate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ignoreFile = path.join(root, ".clotrignore");
  const fake = fakeVscode([], {}, {}, root);
  const doc = fake.mkDocument(path.join(root, "open.js"), `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  const openSync = fs.openSync;
  let reads = 0;
  fs.openSync = function (file, ...args) {
    if (path.resolve(String(file)) === ignoreFile) reads += 1;
    return openSync.call(this, file, ...args);
  };
  try {
    await activateExtension(fake);
    const salt = "a".repeat(64);
    const fingerprint = valueFingerprint(salt, KEY);
    let previousTextReads = doc.getTextCalls;

    fs.writeFileSync(ignoreFile, `salt: ${salt}\nfingerprint: ${fingerprint}\n`);
    fake.fireFileSystemEvent("create", ignoreFile);
    doc.setText(`const token = "${KEY}"; // created`);
    fake.fireTextChange(doc);
    await waitFor(() => doc.getTextCalls > previousTextReads, "the create invalidation scan");
    await waitFor(() => reads >= 1, "the created ignore file read");
    assert.equal(fake.entries.get(doc.uri.toString()).length, 0);
    previousTextReads = doc.getTextCalls;

    fs.writeFileSync(ignoreFile, `salt: ${salt}\n`);
    fake.fireFileSystemEvent("change", ignoreFile);
    doc.setText(`const token = "${KEY}"; // changed`);
    fake.fireTextChange(doc);
    await waitFor(() => doc.getTextCalls > previousTextReads, "the change invalidation scan");
    await waitFor(() => reads >= 2, "the changed ignore file read");
    assert.equal(fake.entries.get(doc.uri.toString()).length, 1);
    previousTextReads = doc.getTextCalls;

    fs.writeFileSync(ignoreFile, `salt: ${salt}\nfingerprint: ${fingerprint}\n`);
    fake.fireFileSystemEvent("change", ignoreFile);
    doc.setText(`const token = "${KEY}"; // restored`);
    fake.fireTextChange(doc);
    await waitFor(() => doc.getTextCalls > previousTextReads, "the restored cache scan");
    await waitFor(() => reads >= 3, "the restored ignore file read");
    assert.equal(fake.entries.get(doc.uri.toString()).length, 0);
    previousTextReads = doc.getTextCalls;

    fs.unlinkSync(ignoreFile);
    fake.fireFileSystemEvent("delete", ignoreFile);
    doc.setText(`const token = "${KEY}"; // deleted`);
    fake.fireTextChange(doc);
    await waitFor(() => doc.getTextCalls > previousTextReads, "the delete invalidation scan");
    await waitFor(() => fake.entries.get(doc.uri.toString())?.length === 1, "the finding after delete");
    assert.equal(reads, 3);
  } finally {
    fs.openSync = openSync;
  }
  t.diagnostic(`Create/change/delete invalidation kept the cache current across ${reads} file reads.`);
});

test("stale ignored occurrence entries are removed while active ignores remain", (t) => {
  const { pruneIgnoredOnce } = require("../apps/vscode/src/open-files/ignore-once.js");
  const staleCount = 10_000;
  const ignored = new Map(Array.from({ length: staleCount }, (_, index) => [`stale-${index}`, `fp-${index}`]));
  ignored.set("active-one", "fp-one");
  ignored.set("active-two", "fp-two");
  const active = new Map([
    ["active-one", "fp-one"],
    ["active-two", "fp-two"],
  ]);
  const removed = pruneIgnoredOnce(ignored, active);
  assert.equal(removed, staleCount);
  assert.deepEqual(
    [...ignored],
    [
      ["active-one", "fp-one"],
      ["active-two", "fp-two"],
    ],
  );
  t.diagnostic(`Pruned ${removed} stale occurrence entries and retained ${ignored.size} active ignores.`);
});

test("VS Code resets the 250 ms debounce and detects a burst once", async () => {
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
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 250) return realSetTimeout(callback, delay, ...args);
    const timer = { callback: () => callback(...args), delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timers.includes(timer)) timer.cancelled = true;
    else realClearTimeout(timer);
  };
  try {
    document.setText("A harmless edit");
    fake.fireTextChange(document);
    document.setText(`const token = "${KEY}";`);
    fake.fireTextChange(document);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  const active = timers.filter((timer) => !timer.cancelled);
  assert.equal(active.length, 1, "the second edit must replace the first timer");
  assert.equal(active[0].delay, 250);
  assert.equal(calls, 0, "no engine check should run before the scheduled callback");
  active[0].callback();
  await waitFor(() => fake.entries.get(document.uri.toString())?.length === 1, "the changed document finding");
  assert.equal(calls, 1);
});

test("finding: one edit rescans every open document", async (t) => {
  const fake = fakeVscode([]);
  const documents = Array.from({ length: 32 }, (_, index) =>
    fake.mkDocument(`C:/project/open-${index}.txt`, `Harmless file ${index}.`),
  );
  fake.vscode.workspace.textDocuments.push(...documents);
  await activateExtension(fake);
  const readsBeforeEdit = documents.map((document) => document.getTextCalls);
  let engineChecks = 0;
  const detect = fake.engineContext.Clotr.detect;
  fake.engineContext.Clotr.detect = (...args) => {
    engineChecks++;
    return detect(...args);
  };
  documents[0].setText("Changed file with no secret.");
  fake.fireTextChange(documents[0]);
  await waitFor(() => engineChecks > 0, "the changed document's debounced check");
  const documentsReread = documents.filter((document, index) => document.getTextCalls > readsBeforeEdit[index]).length;
  t.diagnostic(`One edit re-read ${documentsReread}/32 documents and ran ${engineChecks} engine checks.`);
  assert.equal(documentsReread, 1, `only the changed file should be read; ${documentsReread} were read`);
  assert.equal(engineChecks, 1, `only the changed file should be checked; ${engineChecks} were checked`);
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

test("finding: an overlong .gitignore glob cannot suppress the secret-file workspace note", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-long-gitignore-"));
  fs.writeFileSync(path.join(root, ".gitignore"), `${"*".repeat(MAX_PATTERN_LENGTH + 1)}\n`);
  const sample = makeSecrets(20261026).find((entry) => entry.kind === "aws_access_key").value;
  try {
    const fake = fakeVscode([], {}, {}, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env"), `API_KEY=${sample}`));
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fake.vscode.window.messages, ["A secret file in this workspace isn't ignored by Git."]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finding: Add to .gitignore refuses a symbolic link", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-link-"));
  const root = path.join(scratch, "workspace");
  const target = path.join(scratch, "outside.txt");
  const targetDirectory = path.join(scratch, "outside-directory");
  const link = path.join(root, ".gitignore");
  fs.mkdirSync(root);
  fs.writeFileSync(target, "leave this file alone\n");
  try {
    try {
      fs.symlinkSync(target, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        fs.mkdirSync(targetDirectory);
        fs.writeFileSync(path.join(targetDirectory, "keep.txt"), "leave this file alone\n");
        try {
          fs.symlinkSync(targetDirectory, link, "junction");
        } catch {
          t.skip(`symbolic links are unavailable here (${error.code})`);
          return;
        }
      } else {
        throw error;
      }
    }
    const sample = makeSecrets(20261026).find((entry) => entry.kind === "aws_access_key").value;
    const fake = fakeVscode([], {}, {}, root);
    allowGitIgnoreApiToAnswer(fake, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env"), `API_KEY=${sample}`));
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fake.vscode.window.messages.includes("Clotr couldn't update .gitignore safely."));
    assert.equal(fs.readFileSync(target, "utf8"), "leave this file alone\n");
    if (fs.existsSync(path.join(targetDirectory, "keep.txt"))) {
      assert.equal(fs.readFileSync(path.join(targetDirectory, "keep.txt"), "utf8"), "leave this file alone\n");
    }
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("finding: Add to .gitignore refuses a non-regular file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-directory-"));
  fs.mkdirSync(path.join(root, ".gitignore"));
  const sample = makeSecrets(20261026).find((entry) => entry.kind === "aws_access_key").value;
  try {
    const fake = fakeVscode([], {}, {}, root);
    allowGitIgnoreApiToAnswer(fake, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env"), `API_KEY=${sample}`));
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fake.vscode.window.messages.includes("Clotr couldn't update .gitignore safely."));
    assert.deepEqual(fs.readdirSync(path.join(root, ".gitignore")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finding: Add to .gitignore refuses unsafe paths before writing any candidate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-lines-"));
  const ignoreFile = path.join(root, ".gitignore");
  const original = "keep this rule\n";
  fs.writeFileSync(ignoreFile, original);
  try {
    const fake = fakeVscode([], {}, {}, root);
    allowGitIgnoreApiToAnswer(fake, root);
    fake.vscode.workspace.textDocuments.push(
      fake.mkDocument(path.join(root, "safe", ".env"), ""),
      fake.mkDocument(path.join(root, "line\nbreak", ".env"), ""),
      fake.mkDocument(path.join(root, "control\u0085name", ".env"), ""),
      fake.mkDocument(path.join(root, "x".repeat(MAX_PATTERN_LENGTH + 1), ".npmrc"), ""),
    );
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fake.vscode.window.messages.includes("Clotr couldn't update .gitignore safely."));
    assert.equal(fs.readFileSync(ignoreFile, "utf8"), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finding: Add to .gitignore escapes leading comment, negation, and glob characters", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-escape-"));
  try {
    const fake = fakeVscode([], {}, {}, root);
    allowGitIgnoreApiToAnswer(fake, root);
    for (const name of ["#hash", "!bang", "wild*?[name]"]) {
      fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, name, ".env"), ""));
    }
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      fs.readFileSync(path.join(root, ".gitignore"), "utf8"),
      "\\#hash/.env\n\\!bang/.env\nwild\\*\\?\\[name\\]/.env\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finding: Add to .gitignore escapes trailing spaces", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-space-"));
  try {
    const fake = fakeVscode([], {}, {}, root);
    allowGitIgnoreApiToAnswer(fake, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env "), ""));
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".env\\ \n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finding: Add to .gitignore recognizes an existing escaped trailing-space line", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-existing-"));
  const ignoreFile = path.join(root, ".gitignore");
  const original = ".env\\ \n";
  fs.writeFileSync(ignoreFile, original);
  try {
    const fake = fakeVscode([], {}, {}, root);
    allowGitIgnoreApiToAnswer(fake, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ".env "), ""));
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fake.vscode.window.messages.includes("A secret file in this workspace isn't ignored by Git."));
    assert.ok(!fake.vscode.window.messages.includes("Clotr couldn't update .gitignore safely."));
    assert.equal(fs.readFileSync(ignoreFile, "utf8"), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("English and Spanish include a label for every detection type", () => {
  const ids = new Set(
    [
      ...require("./load-engine.js")
        .source("rules")
        .matchAll(/\bid:\s*"([^"]+)"/g),
    ].map(([, id]) => id),
  );
  const englishWords = require("../apps/vscode/package.nls.json");
  const spanishWords = require("../apps/vscode/package.nls.es.json");
  for (const id of ids) {
    assert.ok(englishWords[`finding_${id}`], `English finding label: ${id}`);
    assert.ok(spanishWords[`finding_${id}`], `Spanish finding label: ${id}`);
  }
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
  assert.match(item.label, /AWS Access Key: Sensitive information found/i);
  assert.doesNotMatch(item.label, /aws_access_key/);
  assert.equal(item.command.command, "vscode.open");
  assert.equal(item.command.arguments[0], doc.uri);
  assert.equal(fake.statusItems[0].command, "clotr.focusView");
  assert.equal(fake.statusItems[0].text, "$(shield) Clotr · 1 file · 1 finding");
  assert.equal(
    fake.statusItems[0].tooltip,
    "Clotr checks open files in this window. Open files checked: 1; findings: 1.",
  );
});

test("VS Code maps detection severity to Error, Warning, and Information diagnostics", async () => {
  const fake = fakeVscode([], {}, { minSeverity: "low", personalDetailsInFiles: true });
  const key = fake.mkDocument("C:/project/secret.js", `const token = "${KEY}";`);
  const phone = fake.mkDocument("C:/project/phone.txt", "Call me at 555-555-0123");
  const email = fake.mkDocument("C:/project/contact.txt", "Write to person@example.test");
  fake.vscode.workspace.textDocuments.push(key, phone, email);
  await activateExtension(fake);
  const severityFor = (document) => fake.entries.get(document.uri.toString())[0].severity;
  assert.equal(severityFor(key), fake.vscode.DiagnosticSeverity.Error);
  assert.equal(severityFor(phone), fake.vscode.DiagnosticSeverity.Warning);
  assert.equal(severityFor(email), fake.vscode.DiagnosticSeverity.Information);
});

test("Spanish diagnostics translate finding names as well as their explanation", async () => {
  const fake = fakeVscode([], {}, {}, "C:/project");
  fake.vscode.env.language = "es";
  const document = fake.mkDocument("C:/project/secret.js", `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(document);
  await activateExtension(fake);
  const diagnostic = fake.entries.get(document.uri.toString())[0];
  assert.match(diagnostic.message, /^Clave de acceso de AWS:/);
  assert.match(diagnostic.message, /Los asistentes/);
  assert.doesNotMatch(diagnostic.message, /AWS Access Key/);
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

// The kinds the extension held back before it read the engine's personal group. They stay quiet with the setting off.
const OLD_PERSONAL_WORDS =
  /email|phone|person|name|address|ssn|social|passport|license.?plate|national.?id|account.?id|student.?id|birth|dob|vin|ip.?address/i;
// Card, gift-card and bank numbers sit in the personal group, but they're money, so they're checked like a credential.
const MONEY_KINDS = new Set(["credit_card", "card_code", "gift_card", "bank_account"]);

// Opens one file per engine kind, with the engine's detect stubbed so each file finds exactly its own kind once, and returns
// the kinds that got a mark. Stubbing lets the walk cover every kind, including ones that need a vault or a picture.
async function markedKinds(settings) {
  const fake = fakeVscode([], {}, { minSeverity: "low", ...settings });
  await activateExtension(fake);
  const context = fake.engineContext;
  // Copied out of the engine's realm so deepEqual compares plain arrays.
  const patterns = [...context.Clotr.PATTERNS];
  const kinds = patterns.map((pattern) => pattern.id);
  const sample = (kind) => `sample-${kind.replace(/_/g, "-")}-0001`;
  // The same shape the engine's detect returns, at high severity so the severity setting never hides one.
  context.Clotr.detect = (text) =>
    patterns
      .filter((pattern) => text.includes(sample(pattern.id)))
      .map(({ id, group, secret, name }) => ({ id, group, secret, name, severity: "high", matches: [sample(id)] }));
  const documents = kinds.map((kind) => fake.mkDocument(`C:/project/${kind}.txt`, `value = "${sample(kind)}";`));
  for (const document of documents) fake.fireOpen(document);
  await waitFor(
    () => documents.every((document) => fake.entries.has(document.uri.toString())),
    "every kind's file checked",
  );
  const marked = new Set();
  for (const [index, document] of documents.entries()) {
    for (const diagnostic of fake.entries.get(document.uri.toString())) {
      assert.equal(diagnostic.code, kinds[index]);
      marked.add(diagnostic.code);
    }
  }
  return { kinds, marked, patterns };
}

test("with personal details off, no kind in the engine's personal group is marked, except money", async () => {
  const { patterns, marked } = await markedKinds({});
  const personal = patterns.filter((pattern) => pattern.group === "personal").map((pattern) => pattern.id);
  assert.ok(personal.length >= 26, "the engine still has its personal group");
  const loud = personal.filter((kind) => !MONEY_KINDS.has(kind) && marked.has(kind));
  assert.deepEqual(loud, []);
  for (const kind of MONEY_KINDS) assert.ok(marked.has(kind), `${kind} is still marked`);
});

test("with personal details off, kinds outside the personal group are marked and the old words stay quiet", async () => {
  const { patterns, marked } = await markedKinds({});
  for (const { id, group } of patterns) {
    const held = (group === "personal" && !MONEY_KINDS.has(id)) || OLD_PERSONAL_WORDS.test(id);
    assert.equal(marked.has(id), !held, id);
  }
});

test("with personal details on, every engine kind is marked", async () => {
  const { kinds, marked } = await markedKinds({ personalDetailsInFiles: true });
  assert.deepEqual(
    kinds.filter((kind) => !marked.has(kind)),
    [],
  );
});

test("an insurance member ID, a driver's licence and a medical record wait for the personal details setting", async () => {
  const content = "insurance member id W123456789\ndriver license D1234567\nmedical record number MRN 12345678\n";
  const quiet = fakeVscode([]);
  quiet.vscode.workspace.textDocuments.push(quiet.mkDocument("C:/project/ids.js", content));
  await activateExtension(quiet);
  assert.deepEqual(
    [...quiet.entries.values()].flat().map((diagnostic) => diagnostic.code),
    [],
  );
  const enabled = fakeVscode([], {}, { personalDetailsInFiles: true });
  enabled.vscode.workspace.textDocuments.push(enabled.mkDocument("C:/project/ids.js", content));
  await activateExtension(enabled);
  assert.deepEqual([...new Set([...enabled.entries.values()].flat().map((diagnostic) => diagnostic.code))].sort(), [
    "drivers_license",
    "insurance_id",
    "medical_record",
  ]);
});

test("clipboard result explains that findings below the selected severity pass", async () => {
  const fake = fakeVscode([]);
  fake.clipboard.value = "Email hello@example.com";
  await activateExtension(fake);
  await fake.commands.get("clotr.checkClipboard")();
  assert.match(fake.vscode.window.messages[0], /at your selected level or higher/);
});

test("Guard command offers every supported tool and Git, then previews and applies through the Guard CLI", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-guard-"));
  assert.equal(require("node:child_process").spawnSync("git", ["init"], { cwd: workspace }).status, 0);
  const fake = fakeVscode([], {}, {}, workspace);
  const hostPlatform = process.platform;
  fake.context.clotrPlatform = hostPlatform;
  fs.mkdirSync(path.join(fake.context.clotrGuardHome, ".codex"), { recursive: true });
  const selection = (labels) => [
    (items) => items.find((item) => item.remove === false),
    (items) => {
      const expectedTools = ["claude", "cursor", "gemini", "codex", "windsurf"];
      const expectedLabels = ["Claude Code", "Cursor", "Gemini CLI", "Codex CLI", "Windsurf"];
      if (hostPlatform !== "win32") {
        expectedTools.push("cline");
        expectedLabels.push("Cline");
      }
      assert.deepEqual(
        items.filter((item) => item.tool !== "git").map((item) => item.tool),
        expectedTools,
      );
      // People see each assistant's own name; the Guard CLI still gets its short tool name.
      assert.deepEqual(
        items.map((item) => item.label),
        [...expectedLabels, "Git"],
      );
      assert.ok(items.some((item) => item.tool === "git"));
      return items.filter((item) => labels.includes(item.tool));
    },
  ];
  await activateExtension(fake);
  fake.setPicks(selection(["codex", "git"]));
  await fake.commands.get("clotr.setupGuard")();
  const settingsFile = path.join(fake.context.clotrGuardHome, ".codex", "hooks.json");
  const hookFile = path.join(workspace, ".git", "hooks", "pre-commit");
  const preview = fake.vscode.window.messages.find((message) => message.includes("Review what Clotr will add"));
  assert.ok(preview.includes("UserPromptSubmit"));
  assert.ok(preview.includes("pre-commit"));
  assert.ok(fs.existsSync(settingsFile));
  assert.ok(fs.existsSync(hookFile));
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(fake.context.clotrGuardHome, { recursive: true, force: true });
});

test("Guard setup selects the host assistant and tools found in PATH, settings, or the editor", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-detected-assistants-"));
  try {
    const home = path.join(scratch, "home");
    const workspace = path.join(scratch, "workspace");
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const command of ["claude", "gemini"]) fs.writeFileSync(path.join(bin, command), "");

    const cursor = fakeVscode([], {}, {}, workspace);
    cursor.context.clotrGuardHome = home;
    cursor.context.clotrEnv = { ...process.env, PATH: bin };
    cursor.context.clotrPlatform = "linux";
    cursor.context.clotrNodeCommand = process.execPath;
    cursor.vscode.env.appName = "Cursor";
    cursor.vscode.env.uriScheme = "cursor";
    cursor.vscode.extensions.getExtension = (id) => (id === "saoudrizwan.claude-dev" ? {} : undefined);
    let found;
    cursor.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => {
        found = items.filter((item) => item.picked).map((item) => item.tool);
        return [];
      },
    ]);
    await activateExtension(cursor);
    await cursor.commands.get("clotr.setupGuard")();
    assert.deepEqual(found, ["claude", "cursor", "gemini", "codex", "cline"]);

    const windsurf = fakeVscode([], {}, {}, workspace);
    windsurf.context.clotrGuardHome = home;
    windsurf.context.clotrEnv = { ...process.env, PATH: path.join(scratch, "empty-bin") };
    windsurf.context.clotrPlatform = "linux";
    windsurf.context.clotrNodeCommand = process.execPath;
    windsurf.vscode.env.appName = "Windsurf";
    windsurf.vscode.env.uriScheme = "vscode";
    let windsurfFound;
    windsurf.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => {
        windsurfFound = items.filter((item) => item.picked).map((item) => item.tool);
        return [];
      },
    ]);
    await activateExtension(windsurf);
    await windsurf.commands.get("clotr.setupGuard")();
    assert.deepEqual(windsurfFound, ["codex", "windsurf"]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("Guard removal still recognizes a Claude hook with the earlier Read matcher", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-old-guard-matcher-"));
  try {
    const home = path.join(scratch, "home");
    const workspace = path.join(scratch, "workspace");
    const settings = path.join(home, ".claude", "settings.json");
    const guardScript = path.join(scratch, "node_modules", "clotr-guard", "bin", "clotr-guard.js");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.mkdirSync(path.dirname(guardScript), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(guardScript, "");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [
                {
                  type: "command",
                  command: `"node" "${guardScript}" read claude --min-severity medium`,
                  timeout: 15,
                },
              ],
            },
          ],
        },
      }),
    );
    const fake = fakeVscode([], {}, {}, workspace);
    fake.context.clotrGuardHome = home;
    fake.context.clotrEnv = { ...process.env, PATH: "" };
    fake.context.clotrPlatform = "linux";
    fake.context.clotrNodeCommand = process.execPath;
    let found = [];
    fake.setPicks([
      (items) => items.find((item) => item.remove === true),
      (items) => {
        found = items.filter((item) => item.picked).map((item) => item.tool);
        return [];
      },
    ]);
    await activateExtension(fake);
    await fake.commands.get("clotr.setupGuard")();
    assert.ok(found.includes("claude"), "the old Read matcher remains available for removal");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("Guard previews its target file and every hook before it can write them", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-guard-preview-"));
  const workspace = path.join(scratch, "workspace");
  const home = path.join(scratch, "home");
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const fake = fakeVscode([], {}, {}, workspace);
    fake.context.clotrGuardHome = home;
    fake.context.clotrNodeCommand = process.execPath;
    const settingsFile = path.join(home, ".claude", "settings.json");
    const originalSettings = '{\n  "customSetting": "PRIVATE_PREVIEW_MARKER"\n}\n';
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, originalSettings);
    fake.setWarningChoice(undefined);
    fake.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => [items.find((item) => item.tool === "claude")],
    ]);
    await activateExtension(fake);
    await fake.commands.get("clotr.setupGuard")();
    const preview = fake.vscode.window.messages.find((message) => message.includes("Review what Clotr will add"));
    assert.ok(preview.includes(path.join(home, ".claude", "settings.json")));
    assert.ok(preview.includes("UserPromptSubmit"));
    assert.ok(preview.includes("PreToolUse"));
    assert.ok(preview.includes("clotr-guard.js"));
    assert.doesNotMatch(preview, /PRIVATE_PREVIEW_MARKER/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), originalSettings);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the VS Code Guard picker hides Cline on Windows while Guard keeps its implementation", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-cline-"));
  const fake = fakeVscode([], {}, {}, workspace);
  fake.context.clotrPlatform = "win32";
  let labels;
  await activateExtension(fake);
  fake.setPicks([
    (items) => items.find((item) => item.remove === false),
    (items) => {
      labels = items.map((item) => item.tool);
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

test("Guard setup shows a localized error instead of raw CLI output", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-guard-error-"));
  try {
    const fake = fakeVscode([], {}, {}, workspace);
    fake.vscode.env.language = "es";
    fake.context.clotrNodeCommand = process.execPath;
    fake.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => [items.find((item) => item.tool === "claude")],
    ]);
    await activateExtension(fake, {
      spawn: (_command, args) =>
        args[0] === "--version"
          ? fakeChildProcess({ stdout: "v24.0.0" })
          : fakeChildProcess({ status: 1, stderr: "unlocalized internal CLI details" }),
    });
    await fake.commands.get("clotr.setupGuard")();
    assert.deepEqual(fake.vscode.window.messages, [require("../apps/vscode/package.nls.es.json").guardPreviewError]);
    assert.doesNotMatch(fake.vscode.window.messages[0], /internal CLI details/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Guard setup reports a localized timeout without exposing process errors", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-guard-timeout-"));
  try {
    const fake = fakeVscode([], {}, {}, workspace);
    fake.vscode.env.language = "es";
    fake.context.clotrNodeCommand = process.execPath;
    fake.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => [items.find((item) => item.tool === "claude")],
    ]);
    await activateExtension(fake, {
      spawn: (_command, args) => {
        if (args[0] === "--version") return fakeChildProcess({ stdout: "v24.0.0" });
        const error = new Error("private process detail");
        error.code = "ETIMEDOUT";
        return fakeChildProcess({ error });
      },
    });
    await fake.commands.get("clotr.setupGuard")();
    assert.deepEqual(fake.vscode.window.messages, [require("../apps/vscode/package.nls.es.json").guardTimeout]);
    assert.doesNotMatch(fake.vscode.window.messages[0], /private process detail/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Guard removal offers Git and removes its pre-commit check", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-guard-git-remove-"));
  const fake = fakeVscode([], {}, {}, workspace);
  const hook = path.join(workspace, ".git", "hooks", "pre-commit");
  try {
    assert.equal(require("node:child_process").spawnSync("git", ["init"], { cwd: workspace }).status, 0);
    await activateExtension(fake);
    fake.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => [items.find((item) => item.tool === "git")],
    ]);
    await fake.commands.get("clotr.setupGuard")();
    assert.ok(fs.existsSync(hook));

    let removeLabels;
    fake.setPicks([
      (items) => items.find((item) => item.remove === true),
      (items) => {
        removeLabels = items.map((item) => item.tool);
        return [items.find((item) => item.tool === "git")];
      },
    ]);
    await fake.commands.get("clotr.setupGuard")();
    assert.ok(removeLabels.includes("git"));
    assert.equal(fs.existsSync(hook), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fake.context.clotrGuardHome, { recursive: true, force: true });
  }
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
    (items) => items.filter((item) => item.tool === "codex"),
  ]);
  await noNode.commands.get("clotr.setupGuard")();
  assert.deepEqual(noNode.vscode.window.messages, [
    "Node.js 20 or newer is required for Clotr Guard. Install it from nodejs.org.",
  ]);
  assert.equal(fs.existsSync(path.join(noNode.context.clotrGuardHome, ".codex")), false);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(noNode.context.clotrGuardHome, { recursive: true, force: true });
});

test("Guard setup rejects Node versions below 20 and accepts Node 20", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-node-floor-"));
  try {
    for (const [language, expected] of [
      ["en", require("../apps/vscode/package.nls.json").nodeRequired],
      ["es", require("../apps/vscode/package.nls.es.json").nodeRequired],
    ]) {
      const oldNode = fakeVscode([], {}, {}, workspace);
      oldNode.vscode.env.language = language;
      oldNode.context.clotrNodeCommand = process.execPath;
      await activateExtension(oldNode, {
        spawn: (_command, args) => fakeChildProcess({ stdout: args[0] === "--version" ? "v18.20.8" : "" }),
      });
      await oldNode.commands.get("clotr.setupGuard")();
      assert.deepEqual(oldNode.vscode.window.messages, [expected]);
      assert.equal(oldNode.quickPicks.length, 0);
      fs.rmSync(oldNode.context.clotrGuardHome, { recursive: true, force: true });
    }

    const supportedNode = fakeVscode([], {}, {}, workspace);
    supportedNode.context.clotrNodeCommand = process.execPath;
    supportedNode.setPicks([() => undefined]);
    await activateExtension(supportedNode, {
      spawn: (_command, args) => fakeChildProcess({ stdout: args[0] === "--version" ? "v20.0.0" : "" }),
    });
    await supportedNode.commands.get("clotr.setupGuard")();
    assert.equal(supportedNode.vscode.window.messages.length, 0);
    assert.equal(supportedNode.quickPicks.length, 1, "Node 20 reaches the setup choices");
    fs.rmSync(supportedNode.context.clotrGuardHome, { recursive: true, force: true });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function packageFolder(extensions, version) {
  const root = path.join(extensions, `clotr-app.clotr-${version}`);
  fs.mkdirSync(root, { recursive: true });
  copyShippedFiles(root);
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
      (items) => items.filter((item) => item.tool === "codex"),
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

// Two versions of the extension side by side, and Guard set up from the older one's copy in a scratch home.
function guardUpdateFixture(prefix) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const extensions = path.join(scratch, "extensions");
  const before = packageFolder(extensions, "0.0.1");
  const after = packageFolder(extensions, "0.0.2");
  const home = path.join(scratch, "home");
  const oldScript = path.join(before, "guard", "bin", "clotr-guard.js");
  const newScript = path.join(after, "guard", "bin", "clotr-guard.js");
  const setUpOld = (args, cwd = scratch) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const result = spawnSync(process.execPath, [oldScript, ...args], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const repo = (name) => {
    const folder = path.join(scratch, name);
    fs.mkdirSync(folder, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: folder }).status, 0);
    return folder;
  };
  // A window of the new version starting, with the version the last one recorded.
  const start = async (workspace, globalValues, setUp = () => {}) => {
    const fake = fakeVscode([], {}, {}, workspace, globalValues);
    fake.context.clotrGuardHome = home;
    fake.setInformationChoice(undefined);
    setUp(fake);
    await activateContainedExtension(after, fake);
    return fake;
  };
  return { scratch, home, before, after, oldScript, newScript, setUpOld, repo, start };
}

const GUARD_MOVED = "Clotr Guard moved since the last update. Set it up again?";

// Waits as waitFor does, but a message in any of these windows, such as the question after a quiet update fails, ends
// the wait at once with its words. Nothing answers it here, so waiting would only run out the 30 s.
async function waitUnlessAsked(windows, condition, what) {
  const asked = () => windows.flatMap((window) => window.vscode.window.messages);
  await waitFor(() => condition() || asked().length > 0, what);
  if (!condition()) throw new Error(`Asked "${asked().join('" and "')}" while waiting for ${what}`);
}

test("after an update Clotr points its own hooks at the new Guard without asking and leaves the rest as it was", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-");
  const { home, oldScript, newScript } = fixture;
  try {
    const workspace = fixture.repo("project with space");
    const first = fakeVscode([], {}, {}, workspace);
    first.context.clotrGuardHome = home;
    first.setPicks([
      (items) => items.find((item) => item.remove === false),
      (items) => items.filter((item) => ["claude", "codex"].includes(item.tool)),
    ]);
    await activateContainedExtension(fixture.before, first);
    await first.commands.get("clotr.setupGuard")();
    assert.deepEqual(guard.managedHooks("claude", { home }), [
      { script: oldScript, minimum: "medium", includePersonalDetails: false },
    ]);

    // The person's own setting, another tool's hook ahead of Clotr's and a Clotr hook edited by hand.
    const claudeFile = path.join(home, ".claude", "settings.json");
    const claude = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
    claude.model = "opus";
    claude.hooks.UserPromptSubmit.unshift(
      { hooks: [{ type: "command", command: "echo another tool" }] },
      { hooks: [{ type: "command", command: `node "${oldScript}" hook claude --min-severity low; echo mine` }] },
    );
    fs.writeFileSync(claudeFile, `${JSON.stringify(claude, null, 2)}\n`);
    const settingsFiles = [claudeFile, path.join(home, ".codex", "hooks.json")];
    const beforeUpdate = settingsFiles.map((file) => fs.readFileSync(file, "utf8"));
    // Clotr's hooks name Guard as an argument in Claude Code's settings and inside a quoted command in Codex's. Both
    // files are JSON, so a Windows path shows there with its backslashes doubled.
    const named = (script) => [`${JSON.stringify(script)},`, JSON.stringify(`'${script}'`).slice(1, -1)];
    assert.ok(beforeUpdate.every((text) => named(oldScript).some((name) => text.includes(name))));
    const expected = beforeUpdate.map((text) =>
      named(oldScript).reduce((result, name, index) => result.split(name).join(named(newScript)[index]), text),
    );

    // Two windows of the new version start together.
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const windows = await Promise.all([fixture.start(workspace, globalValues), fixture.start(workspace, globalValues)]);
    await waitUnlessAsked(windows, () => globalValues.extensionVersion === "0.0.2", "the update marked done");
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const window of windows) {
      assert.deepEqual(window.vscode.window.messages, []);
      assert.equal(window.quickPicks.length, 0);
    }
    assert.deepEqual(
      settingsFiles.map((file) => fs.readFileSync(file, "utf8")),
      expected,
    );
    for (const tool of ["claude", "codex"]) {
      assert.deepEqual(guard.managedHooks(tool, { home }), [
        { script: newScript, minimum: "medium", includePersonalDetails: false },
      ]);
    }
    assert.equal(fs.existsSync(path.join(home, ".gemini")), false, "an assistant with no Clotr hooks gets none");
    assert.equal(fs.existsSync(path.join(home, ".cursor")), false, "an assistant with no Clotr hooks gets none");

    // The next start finds nothing to do.
    const next = await fixture.start(workspace, globalValues);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(next.vscode.window.messages, []);
    assert.deepEqual(
      settingsFiles.map((file) => fs.readFileSync(file, "utf8")),
      expected,
    );
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("hooks rewritten after an update keep their own options, not the settings of the moment", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-options-");
  const { home, newScript } = fixture;
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fixture.setUpOld(["setup", "claude", "--min-severity", "high", "--personal-details"]);
    fixture.setUpOld(["setup", "codex", "--min-severity", "low"]);
    if (process.platform !== "win32") fixture.setUpOld(["setup", "cline", "--personal-details"]);
    const clineBefore = guard.managedHooks("cline", { home });
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const fake = await fixture.start(null, globalValues, (window) => {
      window.config.minSeverity = "medium";
      window.config.personalDetailsInFiles = true;
    });
    await waitFor(() => globalValues.extensionVersion === "0.0.2", "the update marked done");
    assert.deepEqual(fake.vscode.window.messages, []);
    assert.deepEqual(guard.managedHooks("claude", { home }), [
      { script: newScript, minimum: "high", includePersonalDetails: true },
    ]);
    assert.deepEqual(guard.managedHooks("codex", { home }), [
      { script: newScript, minimum: "low", includePersonalDetails: false },
    ]);
    if (process.platform !== "win32") {
      assert.equal(clineBefore.length, 1);
      assert.deepEqual(guard.managedHooks("cline", { home }), [{ ...clineBefore[0], script: newScript }]);
    }
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("each workspace's Git hook is rewritten in every window, and never in an untrusted one", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-git-");
  const { home, oldScript, newScript } = fixture;
  try {
    const repoA = fixture.repo("repo-a");
    const repoB = fixture.repo("repo-b");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fixture.setUpOld(["setup", "claude"], repoA);
    fixture.setUpOld(["setup", "git", "--project"], repoA);
    fixture.setUpOld(["setup", "git", "--project"], repoB);
    const hookOf = (repo) => fs.readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8");
    const hookB = hookOf(repoB);
    assert.equal(guard.gitHookScript(hookB), oldScript);

    // An untrusted window: the assistant's hook in the home folder moves, the workspace's Git hook isn't touched.
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const untrusted = await fixture.start(repoB, globalValues, (window) => {
      window.vscode.workspace.isTrusted = false;
    });
    await waitUnlessAsked([untrusted], () => globalValues.extensionVersion === "0.0.2", "the update marked done");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(untrusted.vscode.window.messages, []);
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [newScript],
    );
    assert.equal(hookOf(repoB), hookB);

    // Later windows, after the update is marked done, still rewrite their own repository's hook.
    for (const repo of [repoA, repoB]) {
      const window = await fixture.start(repo, globalValues);
      await waitUnlessAsked([window], () => guard.gitHookScript(hookOf(repo)) === newScript, "the Git hook rewritten");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(window.vscode.window.messages, []);
    }
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// Windows refuses to replace a file while another process has it open, such as a second window's Guard reading the
// same settings. The new Guard copy here refuses the first replaces of each file that has a marker beside it, the same
// way: once, or as many times as given (Infinity refuses them all). The marker holds the refusals left.
function refuseFirstReplace(fixture, files, times = 1) {
  const cli = path.join(fixture.after, "guard", "bin", "clotr-guard.js");
  const lines = fs.readFileSync(cli, "utf8").split("\n");
  const refuse = `{
  const fs = require("fs");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const marker = \`\${to}.refuse\`;
    let left;
    try {
      left = Number(fs.readFileSync(marker, "utf8"));
    } catch {
      return rename(from, to);
    }
    if (left > 1) fs.writeFileSync(marker, String(left - 1));
    else fs.unlinkSync(marker);
    throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  };
}`;
  lines.splice(3, 0, refuse);
  fs.writeFileSync(cli, lines.join("\n"));
  for (const file of files) fs.writeFileSync(`${file}.refuse`, String(times));
  return () => files.filter((file) => fs.existsSync(`${file}.refuse`));
}

test("a Guard run the system refuses once is tried again, so the update still finishes without asking", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-refused-");
  const { home, newScript } = fixture;
  try {
    const repo = fixture.repo("repo");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fixture.setUpOld(["setup", "claude"], repo);
    fixture.setUpOld(["setup", "git", "--project"], repo);
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    const unused = refuseFirstReplace(fixture, [path.join(home, ".claude", "settings.json"), hook]);

    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const window = await fixture.start(repo, globalValues);
    const rewritten = () => guard.gitHookScript(fs.readFileSync(hook, "utf8")) === newScript;
    await waitUnlessAsked([window], rewritten, "the hooks rewritten");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unused(), [], "each file was refused once");
    assert.deepEqual(window.vscode.window.messages, []);
    assert.equal(globalValues.extensionVersion, "0.0.2");
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [newScript],
    );
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a question while an update test waits ends the wait at once with its words", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-asked-");
  const { home } = fixture;
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fixture.setUpOld(["setup", "claude"]);
    // Every replace is refused, however many times the extension tries, so the window asks.
    refuseFirstReplace(fixture, [path.join(home, ".claude", "settings.json")], Infinity);
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const window = await fixture.start(null, globalValues);
    await assert.rejects(
      waitUnlessAsked([window], () => globalValues.extensionVersion === "0.0.2", "the update marked done"),
      { message: `Asked "${GUARD_MOVED}" while waiting for the update marked done` },
    );
    assert.equal(globalValues.extensionVersion, "0.0.1");
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("when Node.js is missing or Guard fails, the question shows and comes back until the hooks are set up", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-fail-");
  const { home, oldScript } = fixture;
  const failingGuard = path.join(GLOBAL_MODULES, "clotr-guard", "bin", "clotr-guard.js");
  try {
    const workspace = fixture.repo("repo");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fixture.setUpOld(["setup", "claude"]);
    const claudeFile = path.join(home, ".claude", "settings.json");
    const before = fs.readFileSync(claudeFile, "utf8");
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };

    const noNode = await fixture.start(workspace, globalValues, (window) => {
      window.context.clotrNodeCommand = "clotr-no-such-node-command";
    });
    await waitFor(() => noNode.vscode.window.messages.length > 0, "the question");
    assert.deepEqual(noNode.vscode.window.messages, [GUARD_MOVED]);
    assert.equal(globalValues.extensionVersion, "0.0.1", "a closed question isn't counted as answered");
    assert.equal(fs.readFileSync(claudeFile, "utf8"), before);

    fs.mkdirSync(path.dirname(failingGuard), { recursive: true });
    fs.writeFileSync(failingGuard, "process.exit(3);\n");
    const failing = await fixture.start(workspace, globalValues, (window) => {
      window.setInformationChoice("Set it up again");
      window.setPicks([
        (items) => items.find((item) => item.remove === false),
        (items) => items.filter((item) => item.tool === "claude"),
      ]);
    });
    await waitFor(() => failing.vscode.window.messages.length > 1, "the question and the error");
    assert.deepEqual(failing.vscode.window.messages, [GUARD_MOVED, "Clotr couldn't preview that change."]);
    assert.equal(globalValues.extensionVersion, "0.0.1");
    assert.equal(fs.readFileSync(claudeFile, "utf8"), before);
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [oldScript],
    );
  } finally {
    fs.rmSync(path.join(GLOBAL_MODULES, "clotr-guard"), { recursive: true, force: true });
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("hooks with two sets of options are left for the question, and Escape anywhere in it leaves the update open", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-mixed-");
  const { home, oldScript, newScript } = fixture;
  try {
    const workspace = fixture.repo("repo");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fixture.setUpOld(["setup", "claude", "--min-severity", "high"]);
    fixture.setUpOld(["setup", "codex"]);
    const claudeFile = path.join(home, ".claude", "settings.json");
    const claude = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
    claude.hooks.PreToolUse[0].hooks[0].args[4] = "low";
    fs.writeFileSync(claudeFile, `${JSON.stringify(claude, null, 2)}\n`);
    const before = fs.readFileSync(claudeFile, "utf8");
    assert.equal(guard.managedHooks("claude", { home }).length, 2);
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const setUpAgain =
      (...picks) =>
      (window) => {
        window.setInformationChoice("Set it up again");
        window.setPicks(picks);
        window.setWarningChoice(undefined);
      };
    const setUp = (items) => items.find((item) => item.remove === false);
    const claudeOnly = (items) => items.filter((item) => item.tool === "claude");
    for (const answer of [
      (window) => window.setInformationChoice(undefined),
      setUpAgain(() => undefined),
      setUpAgain(setUp, () => undefined),
      setUpAgain(setUp, claudeOnly),
    ]) {
      const window = await fixture.start(workspace, globalValues, answer);
      await waitFor(() => window.vscode.window.messages.includes(GUARD_MOVED), "the question");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(globalValues.extensionVersion, "0.0.1");
      assert.equal(fs.readFileSync(claudeFile, "utf8"), before);
    }
    assert.deepEqual(
      guard.managedHooks("codex", { home }).map((entry) => entry.script),
      [newScript],
      "the assistant with one set of options moves without the question",
    );
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [oldScript, oldScript],
    );

    const yes = await fixture.start(workspace, globalValues, (window) => {
      setUpAgain(setUp, claudeOnly)(window);
      window.setWarningChoice("Apply changes");
    });
    await waitFor(() => globalValues.extensionVersion === "0.0.2", "the update marked done");
    assert.ok(yes.vscode.window.messages.includes("Clotr Guard is set up."));
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [newScript],
    );
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// Waits until a window either asks or marks the update done, then a little longer for anything after it.
async function settled(window, globalValues) {
  await waitFor(
    () => window.vscode.window.messages.length > 0 || globalValues.extensionVersion === "0.0.2",
    "the question or the update marked done",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// A small shell script standing in for a program, for the cases that watch what runs and from where.
function shellStub(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const posixOnly = process.platform === "win32" ? "shell stand-ins need a POSIX shell" : false;

test(
  "a Guard run that fails partway leaves the update open and asks, whatever the files say after",
  { skip: posixOnly },
  async (t) => {
    // Guard writes Cline's first hook file, then fails on the second, so a read afterwards finds nothing stale.
    const cases = [
      {
        name: "the second hook file is a link to a file kept elsewhere",
        skip: false,
        break: (fixture, file) => {
          const kept = path.join(fixture.scratch, "dotfiles", "PreToolUse");
          fs.mkdirSync(path.dirname(kept), { recursive: true });
          fs.renameSync(file, kept);
          fs.symlinkSync(kept, file);
        },
        fix: (file) => fs.renameSync(fs.readlinkSync(file), file),
      },
      {
        name: "the second hook file can't be read",
        skip:
          process.getuid?.() === 0 ? "root reads a file with no permissions, so this runs only as another user" : false,
        break: (_fixture, file) => fs.chmodSync(file, 0o000),
        fix: (file) => fs.chmodSync(file, 0o644),
      },
    ];
    for (const entry of cases) {
      await t.test(entry.name, { skip: entry.skip }, async () => {
        const fixture = guardUpdateFixture("clotr-vscode-update-partway-");
        const { home } = fixture;
        try {
          const workspace = fixture.repo("repo");
          fixture.setUpOld(["setup", "cline"]);
          const second = path.join(home, "Documents", "Cline", "Hooks", "PreToolUse");
          assert.ok(fs.existsSync(second));
          fs.rmSync(fixture.before, { recursive: true, force: true });
          entry.break(fixture, second);
          const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
          for (let start = 0; start < 2; start++) {
            const window = await fixture.start(workspace, globalValues);
            await settled(window, globalValues);
            assert.deepEqual(window.vscode.window.messages, [GUARD_MOVED]);
            assert.equal(globalValues.extensionVersion, "0.0.1", "a half-done rewrite isn't counted as done");
          }

          // Once the file is fixed, a yes to the question sets Cline up again and the update is done.
          entry.fix(second);
          const yes = await fixture.start(workspace, globalValues, (window) => {
            window.setInformationChoice("Set it up again");
            window.setPicks([
              (items) => items.find((item) => item.remove === false),
              (items) => items.filter((item) => item.tool === "cline"),
            ]);
            window.setWarningChoice("Apply changes");
          });
          await waitFor(() => globalValues.extensionVersion === "0.0.2", "the update marked done");
          assert.ok(yes.vscode.window.messages.includes("Clotr Guard is set up."));
          assert.equal(globalValues.guardRewriteFailed, undefined);
          assert.deepEqual(
            guard.managedHooks("cline", { home }).map((hook) => hook.script),
            [fixture.newScript],
          );
        } finally {
          fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
      });
    }
  },
);

test("a Guard that won't start leaves the update open and asks", { skip: posixOnly }, async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-nostart-");
  const { home, oldScript } = fixture;
  try {
    const workspace = fixture.repo("repo");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fixture.setUpOld(["setup", "claude"]);
    // A node that answers its version once and is gone when Guard is started with it.
    const node = shellStub(
      path.join(fixture.scratch, "vanishing", "node"),
      `rm -f "$0"\nexec "${process.execPath}" "$@"`,
    );
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const window = await fixture.start(workspace, globalValues, (fake) => {
      fake.context.clotrNodeCommand = node;
    });
    await settled(window, globalValues);
    assert.deepEqual(window.vscode.window.messages, [GUARD_MOVED]);
    assert.equal(globalValues.extensionVersion, "0.0.1");
    assert.deepEqual(
      guard.managedHooks("claude", { home }).map((entry) => entry.script),
      [oldScript],
    );
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test(
  "in an untrusted workspace no node or npm from it runs, and no Guard it names goes into a hook",
  { skip: posixOnly },
  async () => {
    const fixture = guardUpdateFixture("clotr-vscode-update-untrusted-node-");
    const { home, newScript } = fixture;
    const originalPath = process.env.PATH;
    try {
      const workspace = fixture.repo("untrusted");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fixture.setUpOld(["setup", "claude"]);
      const log = path.join(fixture.scratch, "ran.log");
      // The workspace's own node first on PATH, as a tool like direnv puts it, and a Guard it would name as global.
      const inside = path.join(workspace, "tools", "bin");
      const evilRoot = path.join(workspace, "evil-root");
      shellStub(path.join(inside, "node"), `echo "workspace node" >> "${log}"\necho "${evilRoot}"`);
      shellStub(path.join(inside, "npm"), `echo "workspace npm" >> "${log}"\necho "${evilRoot}"`);
      const evilGuard = path.join(evilRoot, "clotr-guard", "bin", "clotr-guard.js");
      fs.mkdirSync(path.dirname(evilGuard), { recursive: true });
      fs.writeFileSync(evilGuard, `require("node:fs").appendFileSync(${JSON.stringify(log)}, "workspace guard\\n");\n`);
      // Outside the workspace, the real node and an npm that starts through "env node", as npm-cli.js does.
      const outside = path.join(fixture.scratch, "outside-bin");
      fs.mkdirSync(outside);
      fs.symlinkSync(process.execPath, path.join(outside, "node"));
      fs.writeFileSync(
        path.join(outside, "npm"),
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(NPM_PREFIX)});\n`,
        {
          mode: 0o755,
        },
      );
      process.env.PATH = [inside, outside, originalPath].join(path.delimiter);
      const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
      const window = await fixture.start(workspace, globalValues, (fake) => {
        fake.vscode.workspace.isTrusted = false;
      });
      await settled(window, globalValues);
      assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "");
      assert.deepEqual(window.vscode.window.messages, []);
      assert.deepEqual(
        guard.managedHooks("claude", { home }).map((entry) => entry.script),
        [newScript],
      );
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);

test(
  "Node and Guard run from the extension's own folder, not the workspace or the editor's",
  { skip: posixOnly },
  async () => {
    const fixture = guardUpdateFixture("clotr-vscode-update-cwd-");
    const { home, newScript } = fixture;
    try {
      const workspace = fixture.repo("repo");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fixture.setUpOld(["setup", "claude"]);
      const log = path.join(fixture.scratch, "node-cwd.log");
      const node = shellStub(
        path.join(fixture.scratch, "logging", "node"),
        `echo "$(pwd -P) $1" >> "${log}"\nexec "${process.execPath}" "$@"`,
      );
      const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
      const window = await fixture.start(workspace, globalValues, (fake) => {
        fake.context.clotrNodeCommand = node;
      });
      await settled(window, globalValues);
      assert.deepEqual(window.vscode.window.messages, []);
      assert.deepEqual(
        guard.managedHooks("claude", { home }).map((entry) => entry.script),
        [newScript],
      );
      const runs = fs.readFileSync(log, "utf8").trim().split("\n");
      const folder = fs.realpathSync(fixture.after);
      assert.deepEqual(
        runs.map((line) => line.split(" ")),
        [
          [folder, "--version"],
          [folder, newScript],
        ],
      );
    } finally {
      fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);

test("an untrusted workspace that holds several folders, the extension or the home folder gets the question", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-untrusted-skip-");
  const { home, oldScript } = fixture;
  // os.homedir() reads HOME on Linux and macOS and USERPROFILE on Windows, so the home folder moves through both.
  const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const moveHome = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fixture.setUpOld(["setup", "claude"]);
    const holdsHome = fixture.repo("holds-home");
    const me = path.join(holdsHome, "me");
    fs.mkdirSync(me);
    const cases = [
      [fixture.repo("first"), (fake) => fake.vscode.workspace.workspaceFolders.push({ uri: { fsPath: home } })],
      [fixture.scratch, () => {}],
      [holdsHome, () => moveHome({ HOME: me, USERPROFILE: me })],
    ];
    for (const [workspace, setUp] of cases) {
      const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
      const window = await fixture.start(workspace, globalValues, (fake) => {
        fake.vscode.workspace.isTrusted = false;
        setUp(fake);
      });
      await settled(window, globalValues);
      moveHome(originalHome);
      assert.deepEqual(window.vscode.window.messages, [GUARD_MOVED], workspace);
      assert.equal(globalValues.extensionVersion, "0.0.1");
      assert.deepEqual(
        guard.managedHooks("claude", { home }).map((entry) => entry.script),
        [oldScript],
      );
    }
  } finally {
    moveHome(originalHome);
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("Cline's hooks are left alone after an update on Windows, where they don't run", async () => {
  const fixture = guardUpdateFixture("clotr-vscode-update-cline-windows-");
  const { home, oldScript } = fixture;
  try {
    // Guard's setup won't write Cline's hooks on Windows, so the old Guard writes them as it does on Linux and macOS.
    require(oldScript).updateClineHooks({ home, cwd: fixture.scratch, platform: "linux" });
    const globalValues = { welcomeShown: true, extensionVersion: "0.0.1" };
    const window = await fixture.start(null, globalValues, (fake) => {
      fake.context.clotrPlatform = "win32";
    });
    await settled(window, globalValues);
    assert.deepEqual(window.vscode.window.messages, []);
    assert.deepEqual(
      guard.managedHooks("cline", { home }).map((entry) => entry.script),
      [oldScript],
    );
  } finally {
    fs.rmSync(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("the VS Code manifest declares limited support for untrusted workspaces", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const trust = manifest.capabilities?.untrustedWorkspaces;
  assert.equal(trust?.supported, "limited");
  for (const key of ["clotr.enabled", "clotr.skipList", "clotr.minSeverity", "clotr.personalDetailsInFiles"]) {
    assert.ok(trust.restrictedConfigurations.includes(key), key);
    assert.equal(manifest.contributes.configuration.properties[key].scope, "machine", key);
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

test("a clipboard check the engine cut short says part wasn't checked and offers no cleaned copy", async () => {
  const fake = fakeVscode([]);
  const copied = `Paste ${KEY} here`;
  fake.clipboard.value = copied;
  await activateExtension(fake);
  const detect = fake.engineContext.Clotr.detect;
  let scans = 0;
  fake.engineContext.Clotr.detect = (value) => {
    const found = detect(value);
    if (value === copied) {
      scans += 1;
      found.truncated = true;
    }
    return found;
  };
  await fake.commands.get("clotr.checkClipboard")();
  assert.equal(scans, 1, "the text is scanned once");
  const call = fake.vscode.window.messageCalls[0];
  assert.match(call.message, /AWS Access Key/);
  assert.match(call.message, /ran out of time.*did not check part of this text/i);
  assert.deepEqual(call.choices, [], "no cleaned copy is offered for text that wasn't fully checked");
  assert.equal(fake.clipboard.value, copied);

  fake.clipboard.value = "Nothing to see here";
  fake.engineContext.Clotr.detect = (value) => Object.assign(detect(value), { truncated: true });
  fake.vscode.window.messages.length = 0;
  await fake.commands.get("clotr.checkClipboard")();
  assert.equal(fake.vscode.window.messages.length, 1);
  assert.match(fake.vscode.window.messages[0], /did not check part of this text/i);
  assert.doesNotMatch(fake.vscode.window.messages[0], /found nothing/i);
});

test("Move to .env counts unsaved .env lines, so two moves of one kind get two variables", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-move-env-dirty-"));
  const second = `${KEY.slice(0, -1)}P`;
  try {
    const fake = fakeVscode([], {}, {}, root);
    const doc = fake.mkDocument(path.join(root, "app.js"), `const a = "${KEY}";\nconst b = "${second}";`);
    doc.languageId = "javascript";
    // The .env is open in the editor, so the moved lines stay in its unsaved text and not on disk.
    fs.writeFileSync(path.join(root, ".env"), "");
    const env = fake.mkDocument(path.join(root, ".env"), "");
    fake.vscode.workspace.textDocuments.push(doc, env);
    await activateExtension(fake);
    for (let move = 0; move < 2; move += 1) {
      const diagnostic = fake.entries.get(doc.uri.toString())[0];
      const actions = fake.codeActionProviders[0].provider.provideCodeActions(doc, diagnostic.range, {
        diagnostics: [diagnostic],
      });
      const action = actions.find((item) => item.title === "Move to .env");
      assert.ok(action, `Move to .env is offered for move ${move + 1}`);
      await fake.commands.get(action.command.command)(...action.command.arguments);
    }
    assert.equal(
      doc.getText(),
      "const a = process.env.CLOTR_AWS_ACCESS_KEY;\nconst b = process.env.CLOTR_AWS_ACCESS_KEY_2;",
    );
    assert.equal(env.getText(), `CLOTR_AWS_ACCESS_KEY=${KEY}\nCLOTR_AWS_ACCESS_KEY_2=${second}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file turned off can be turned back on, and the status says while checking is off", async () => {
  const manifest = require("../apps/vscode/package.json");
  assert.ok(manifest.contributes.commands.some((item) => item.command === "clotr.turnOnFile"));
  assert.ok(manifest.activationEvents.includes("onCommand:clotr.turnOnFile"));
  const fake = fakeVscode([]);
  const doc = fake.mkDocument("C:/project/app.js", `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  await activateExtension(fake);
  await fake.commands.get("clotr.turnOffFile")(doc.uri);
  assert.equal(fake.entries.has(doc.uri.toString()), false);
  assert.match(fake.statusItems[0].tooltip, /checking is off for 1 open file/i);
  // From the Command Palette the command takes the file in the active editor.
  fake.vscode.window.activeTextEditor = { document: doc };
  await fake.commands.get("clotr.turnOnFile")();
  assert.deepEqual(fake.stateValues.disabledFiles, []);
  assert.equal(fake.entries.get(doc.uri.toString())?.length, 1);
  assert.doesNotMatch(fake.statusItems[0].tooltip, /checking is off/i);
});

test("Move to .env offers to add .env to .gitignore when Git doesn't ignore it yet", async () => {
  for (const ignored of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-move-env-ignore-"));
    try {
      if (ignored) fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.env\n");
      else fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
      // The one-time workspace note was already shown, so only the move itself can say so.
      const fake = fakeVscode([], { workspaceSecretNoteShown: true }, {}, root);
      const doc = fake.mkDocument(path.join(root, "app.js"), `const token = "${KEY}";`);
      doc.languageId = "javascript";
      fake.vscode.workspace.textDocuments.push(doc);
      await activateExtension(fake);
      const diagnostic = fake.entries.get(doc.uri.toString())[0];
      const actions = fake.codeActionProviders[0].provider.provideCodeActions(doc, diagnostic.range, {
        diagnostics: [diagnostic],
      });
      const move = actions.find((action) => action.title === "Move to .env");
      await fake.commands.get(move.command.command)(...move.command.arguments);
      assert.equal(doc.getText(), "const token = process.env.CLOTR_AWS_ACCESS_KEY;");
      const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
      if (ignored) {
        assert.deepEqual(fake.vscode.window.messages, []);
        assert.equal(gitignore, "node_modules/\n.env\n");
      } else {
        assert.equal(fake.vscode.window.messageCalls.length, 1);
        assert.match(fake.vscode.window.messageCalls[0].message, /\.env.*Git doesn't ignore/);
        assert.deepEqual(fake.vscode.window.messageCalls[0].choices, ["Add it to .gitignore"]);
        assert.equal(gitignore, "node_modules/\n.env\n");
      }
      assert.equal(JSON.stringify(fake.vscode.window.messages).includes(KEY), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Add to .gitignore writes into the nested repository that holds the secret file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-nested-"));
  try {
    fs.mkdirSync(path.join(root, "svc", ".git"), { recursive: true });
    const fake = fakeVscode([], {}, {}, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, "svc", ".env"), ""));
    fake.setInformationChoice("Add it to .gitignore");
    await activateExtension(fake);
    await waitFor(() => fs.existsSync(path.join(root, "svc", ".gitignore")), "the nested .gitignore", 5000);
    assert.equal(fs.readFileSync(path.join(root, "svc", ".gitignore"), "utf8"), ".env\n");
    assert.equal(fs.existsSync(path.join(root, ".gitignore")), false, "the outer folder's .gitignore isn't read there");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file that only mentions the service-account shape keeps its findings and gets no secret-file note", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-service-account-"));
  try {
    const fake = fakeVscode([], {}, {}, root);
    const line = `AWS_KEY = "${KEY}"`;
    const shape = '{"type": "service_account"}';
    const files = {
      "plain.py": line,
      "commented.py": `${line}\n# example shape: ${shape}`,
      "README.md": `Key files look like ${shape}.\n\n${line}\n`,
    };
    for (const [name, text] of Object.entries(files)) {
      fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, name), text));
    }
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const name of Object.keys(files)) {
      const found = fake.entries.get(`file://${path.join(root, name)}`) || [];
      assert.deepEqual(
        found.map((item) => item.code),
        ["aws_access_key"],
        `${name} keeps its finding`,
      );
    }
    assert.ok(!fake.vscode.window.messages.some((message) => /isn't ignored by Git/.test(message)));

    // A real service-account key file is still a secret file: silent, with the workspace note.
    const keyFile = fake.mkDocument(
      path.join(root, "project-key.json"),
      JSON.stringify({ type: "service_account", private_key_id: KEY }, null, 2),
    );
    fake.fireOpen(keyFile);
    fake.fireTextChange(keyFile);
    await waitFor(() => fake.vscode.window.messages.some((message) => /isn't ignored by Git/.test(message)), "note");
    assert.equal((fake.entries.get(keyFile.uri.toString()) || []).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a .clotrignore change checks open files again without an edit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-ignore-recheck-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ignoreFile = path.join(root, ".clotrignore");
  const salt = "b".repeat(64);
  fs.writeFileSync(ignoreFile, `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, KEY)}\n`);
  const fake = fakeVscode([], {}, {}, root);
  const doc = fake.mkDocument(path.join(root, "open.js"), `const token = "${KEY}";`);
  fake.vscode.workspace.textDocuments.push(doc);
  await activateExtension(fake);
  assert.equal(fake.entries.get(doc.uri.toString()).length, 0);
  fs.unlinkSync(ignoreFile);
  fake.fireFileSystemEvent("delete", ignoreFile);
  await waitFor(() => fake.entries.get(doc.uri.toString())?.length === 1, "the finding after delete", 5000);
  fs.writeFileSync(ignoreFile, `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, KEY)}\n`);
  fake.fireFileSystemEvent("create", ignoreFile);
  await waitFor(() => fake.entries.get(doc.uri.toString())?.length === 0, "the finding quieted again", 5000);
});

test("without the Git extension, .gitignore anchors and folder rules decide the secret-file note as Git would", async () => {
  const cases = [
    { rules: "/.env\n", file: "sub/.env", note: true },
    { rules: "/.env\n", file: ".env", note: false },
    { rules: "secrets/\n", file: "secrets/.env", note: false },
    { rules: "secrets/\n", file: "a/secrets/.env", note: false },
    { rules: ".env\n", file: "sub/.env", note: false },
    { rules: "secrets/*\n!secrets/.env\n", file: "secrets/.env", note: true },
  ];
  for (const { rules, file, note } of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-fallback-"));
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), rules);
      const fake = fakeVscode([], {}, {}, root);
      fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ...file.split("/")), ""));
      fake.setInformationChoice(undefined);
      await activateExtension(fake);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        fake.vscode.window.messages.includes("A secret file in this workspace isn't ignored by Git."),
        note,
        `${JSON.stringify(rules)} with ${file}`,
      );
      assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), rules);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Check selection checks every selection when there are several cursors", async () => {
  const fake = fakeVscode([]);
  const doc = fake.mkDocument("C:/project/notes.txt", `hello world\nkey = ${KEY}\n`);
  await activateExtension(fake);
  const selection = (line, start, end) => ({
    start: { line, character: start },
    end: { line, character: end },
    isEmpty: start === end,
  });
  const harmless = selection(0, 0, 5);
  const key = selection(1, 6, 6 + KEY.length);
  fake.vscode.window.activeTextEditor = { document: doc, selection: harmless, selections: [harmless, key] };
  await fake.commands.get("clotr.checkSelection")();
  assert.match(fake.vscode.window.messages[0], /AWS Access Key: Sensitive information found/);
  assert.doesNotMatch(fake.vscode.window.messages[0], new RegExp(KEY));
});

test("a clipboard too large to check is called text, not a file, in both languages", async () => {
  for (const [language, pattern] of [
    ["en", /^This text is too large \(>1 MiB\), so Clotr did not check it\.$/],
    ["es", /^Este texto es demasiado grande \(>1 MiB\), así que Clotr no lo revisó\.$/],
  ]) {
    const fake = fakeVscode([]);
    fake.vscode.env.language = language;
    fake.clipboard.value = "x".repeat(1024 * 1024 + 1);
    await activateExtension(fake);
    await fake.commands.get("clotr.checkClipboard")();
    assert.equal(fake.vscode.window.messages.length, 1);
    assert.match(fake.vscode.window.messages[0], pattern);
  }
});

async function gitIgnoreFallbackNote(files, file) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-vscode-gitignore-fallback-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, ...name.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (text === null) fs.mkdirSync(target, { recursive: true });
      else fs.writeFileSync(target, text);
    }
    const fake = fakeVscode([], {}, {}, root);
    fake.vscode.workspace.textDocuments.push(fake.mkDocument(path.join(root, ...file.split("/")), ""));
    fake.setInformationChoice(undefined);
    await activateExtension(fake);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [name, text] of Object.entries(files)) {
      if (text !== null) assert.equal(fs.readFileSync(path.join(root, ...name.split("/")), "utf8"), text);
    }
    return fake.vscode.window.messages.includes("A secret file in this workspace isn't ignored by Git.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("without the Git extension, a negation naming only a folder above a secret file doesn't bring it back", async () => {
  const cases = [
    { files: { ".gitignore": "*\n!*/\n" }, file: "config/.env", note: false },
    { files: { ".gitignore": ".env\n!sub/\n" }, file: "sub/.env", note: false },
    { files: { ".gitignore": ".env\n!sub\n" }, file: "sub/.env", note: false },
    { files: { ".gitignore": "*\n!sub\n" }, file: "sub/.env", note: false },
    { files: { ".gitignore": "*\n!*/\n!.env\n" }, file: "config/.env", note: true },
    { files: { ".gitignore": "sub/**\n!sub/.env\n" }, file: "sub/.env", note: true },
    { files: { ".gitignore": ".env\n", "sub/.gitignore": "!.env\n" }, file: "sub/.env", note: true },
    { files: { ".gitignore": "sub/\n", "sub/.gitignore": "!.env\n" }, file: "sub/.env", note: false },
  ];
  for (const { files, file, note } of cases) {
    assert.equal(await gitIgnoreFallbackNote(files, file), note, `${JSON.stringify(files)} with ${file}`);
  }
});

test("without the Git extension, a nested repository's secret file isn't hidden by a .gitignore above that repository", async () => {
  const outer = { ".gitignore": ".env\n", "nested/.git": null };
  assert.equal(await gitIgnoreFallbackNote(outer, "nested/.env"), true);
  assert.equal(await gitIgnoreFallbackNote({ ...outer, "nested/.gitignore": ".env\n" }, "nested/.env"), false);
  assert.equal(await gitIgnoreFallbackNote({ ".gitignore": ".env\n", "nested/keep": "" }, "nested/.env"), false);
});

// The skip list's regex before it moved to Guard's glob walker, kept here so every answer can be compared with it.
function previousSkipListMatch(pattern, value) {
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

const DEFAULT_SKIP_LIST =
  require("../apps/vscode/package.json").contributes.configuration.properties["clotr.skipList"].default;
// A star-heavy pattern of the kind that held a check for over 30 seconds, and a long path it doesn't match.
const STAR_HEAVY_SKIP = `${"*a".repeat(16)}*b`;
const LONG_A_PATH = `${"a".repeat(60)}/${"a".repeat(60)}.js`;

async function skipListAnswer(pattern, relativePath) {
  const root = path.join(os.tmpdir(), "clotr-vscode-skip-list");
  const fake = fakeVscode([], {}, { skipList: [pattern] }, root);
  fake.vscode.workspace.textDocuments.push(
    fake.mkDocument(path.join(root, ...relativePath.split("/")), `const token = "${KEY}";`),
  );
  const started = performance.now();
  await activateExtension(fake);
  const elapsed = performance.now() - started;
  return { skipped: (fake.entries.get([...fake.entries.keys()][0]) || []).length === 0, elapsed };
}

// The extension's own skip-list matcher, loaded once through a stand-in VS Code.
let loadedSkipListMatcher;
async function skipListMatcher() {
  if (!loadedSkipListMatcher) {
    const fake = fakeVscode([]);
    await activateExtension(fake);
    loadedSkipListMatcher = fake.extensionApi.skipListMatches;
  }
  return loadedSkipListMatcher;
}

async function timedSkipListMatch(pattern, relativePath) {
  const skipListMatches = await skipListMatcher();
  const started = performance.now();
  const matched = skipListMatches(pattern, relativePath);
  return { matched, elapsed: performance.now() - started };
}

test("a star-heavy skipList pattern lets the file be checked without a stall", async () => {
  const { skipped } = await skipListAnswer(STAR_HEAVY_SKIP, LONG_A_PATH);
  assert.equal(skipped, false);
  const { matched, elapsed } = await timedSkipListMatch(STAR_HEAVY_SKIP, LONG_A_PATH);
  assert.equal(matched, false);
  assert.ok(elapsed < 500, `the pattern took ${Math.round(elapsed)} ms`);
});

// One star-heavy pattern per form people write in settings, each with the answer the old regex gave.
const STAR_HEAVY_FORMS = [
  { form: "**", pattern: `**/${"*a".repeat(16)}*b/**`, value: `src/${"a".repeat(60)}/x.js` },
  { form: "*", pattern: `${"*a".repeat(16)}*.js`, value: `${"a".repeat(60)}.ts` },
  { form: "?", pattern: `${"*a?".repeat(12)}*b`, value: "a".repeat(80) },
  { form: "braces", pattern: `${"*a".repeat(16)}*.{js,ts}`, value: `${"a".repeat(60)}.js` },
  { form: "character classes", pattern: `${"*a".repeat(16)}*[bc]`, value: `${"a".repeat(60)}b` },
];

for (const { form, pattern, value } of STAR_HEAVY_FORMS) {
  test(`a star-heavy skipList pattern with ${form} answers as before without a stall`, async () => {
    const { matched, elapsed } = await timedSkipListMatch(pattern, value);
    assert.equal(matched, false);
    assert.ok(elapsed < 500, `the pattern took ${Math.round(elapsed)} ms`);
  });
}

// Paths each default pattern should and shouldn't match, in the cases and depths people have.
function skipListPaths() {
  const names = DEFAULT_SKIP_LIST.flatMap((pattern) => {
    const name = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
    const filled = name.replace(/\*/g, "pkg");
    return [filled, filled.toUpperCase(), `x${filled}`, `${filled}x`, filled.slice(1)];
  });
  const paths = new Set(["", "a", "app.js", "src/app.js", ".env", ".env.local", "src/.env", "a\nb/x.js", "a/b\n/c"]);
  for (const name of names) {
    for (const shape of [name, `${name}/a.js`, `src/${name}`, `src/${name}/deep/a.js`, `src\n/${name}/a`]) {
      paths.add(shape);
    }
  }
  return [...paths];
}

test("every default skipList pattern answers as the old regex did for every test path", async () => {
  const skipListMatches = await skipListMatcher();
  assert.equal(DEFAULT_SKIP_LIST.length, 46);
  const paths = skipListPaths();
  for (const pattern of DEFAULT_SKIP_LIST) {
    for (const value of paths) {
      assert.equal(skipListMatches(pattern, value), previousSkipListMatch(pattern, value), `${pattern} on ${value}`);
    }
  }
  assert.equal(skipListMatches("**/node_modules/**", "web/node_modules/left-pad/index.js"), true);
  assert.equal(skipListMatches("**/DerivedData/**", "ios/deriveddata/Build/a.swift"), true);
  assert.equal(skipListMatches("**/*.min.js", "public/app.min.js"), true);
  assert.equal(skipListMatches("**/*.min.js", "public/app.js"), false);
});

test("skipList patterns of every form answer as the old regex did", async () => {
  const skipListMatches = await skipListMatcher();
  const forms = [
    "**",
    "*",
    "?",
    "**/",
    "/**",
    "***",
    "***/x",
    "a/***",
    "a**b",
    "**a**",
    "*/**/*",
    "a?c",
    "?/?",
    "{a,b}.js",
    "*.{js,ts}",
    "[ab].js",
    "[!a]*",
    "[a-z]",
    "\\*.js",
    "a\\b",
    "a.b",
    "a+b",
    "(a|b)",
    "^a$",
    "x/**/y",
    "**/x/**/y/**",
    "Ab",
    "µ",
    "ſ",
    "K",
    "ß",
    "İ",
    "ı",
    "Σ",
    "ς",
    "??",
    "\u{1f600}",
  ];
  const values = [
    "",
    "a",
    "b",
    "x",
    "x/y",
    "x/a/b/y",
    "a/b",
    "ab",
    "aXb",
    "a/b/c",
    "a.js",
    "b.js",
    "{a,b}.js",
    "x.js",
    "x.ts",
    "[ab].js",
    "[!a]",
    "z",
    "*.js",
    "\\*.js",
    "a\\b",
    "a.b",
    "axb",
    "a+b",
    "(a|b)",
    "^a$",
    "AB",
    "aB",
    "μ",
    "Μ",
    "µ",
    "s",
    "S",
    "k",
    "K",
    "ẞ",
    "SS",
    "i",
    "I",
    "σ",
    "ς",
    "Σ",
    "a\nb",
    "x\n/y",
    " ",
    "a/ /y",
    "\ud800",
    "\u{1f600}",
  ];
  for (const pattern of forms) {
    for (const value of values) {
      assert.equal(skipListMatches(pattern, value), previousSkipListMatch(pattern, value), `${pattern} on ${value}`);
    }
  }
});

test("random skipList patterns answer as the old regex did", async () => {
  const skipListMatches = await skipListMatcher();
  let seed = 20261113;
  const random = (limit) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  const patternParts = ["*", "**", "**/", "?", "/", "a", "A", "b", ".", "[", "]", "{", "}", ",", "\\", "!", "-", "\n"];
  const valueParts = ["a", "A", "b", "/", ".", "[", "]", "{", "}", ",", "\\", "!", "-", "\n", "ab", "a/b"];
  const draw = (parts, length) => Array.from({ length }, () => parts[random(parts.length)]).join("");
  for (let round = 0; round < 3000; round += 1) {
    const pattern = draw(patternParts, 1 + random(6));
    const value = draw(valueParts, random(7));
    assert.equal(skipListMatches(pattern, value), previousSkipListMatch(pattern, value), `${pattern} on ${value}`);
  }
});

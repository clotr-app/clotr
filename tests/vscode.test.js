"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
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

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "apps", "vscode");
const BUNDLE = path.join(APP, "guard", "dist", "clotr-engine.js");
const VSIX = path.join(APP, `clotr-${require("../apps/vscode/package.json").version}.vsix`);
const KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");
const currentBundle = build().text;
buildVscode();
assert.equal(fs.readFileSync(BUNDLE, "utf8"), currentBundle, "VS Code's engine bundle is stale");

test("VS Code runtime and its bundled Guard have no network calls", () => {
  const files = [
    path.join(APP, "extension.js"),
    path.join(APP, "guard", "bin", "clotr-guard.js"),
    path.join(APP, "guard", "lib", "engine.js"),
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
    JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8")).version,
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
    assert.equal(manifest.version, "0.2.0.1");
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
test("VS Code is 0.2.0.1 and its README leaves version numbers to the extension listing", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(APP, "README.md"), "utf8");
  assert.equal(editor.version, "0.2.0.1");
  assert.doesNotMatch(readme, /^Version \d/m);
  assert.doesNotMatch(readme, /engine \d+\.\d+\.\d+/i);
});

test("the VS Code README reads as a store page in the owner's voice and keeps build steps behind a link", () => {
  const readme = fs.readFileSync(path.join(APP, "README.md"), "utf8");
  assert.match(readme, /^# Clotr for VS Code-compatible editors/m);
  assert.match(readme, /^Local warnings for credentials in open files that AI coding assistants can read\./m);
  assert.match(readme, /I built Clotr/);
  assert.match(readme, /no network calls/);
  assert.match(readme, /doesn't show credential values/);
  assert.match(readme, /\.clotrignore/);
  assert.match(readme, /salted fingerprint/);
  assert.match(readme, /Move to \.env/);
  assert.match(readme, /Cursor/);
  assert.match(readme, /Windsurf/);
  assert.match(readme, /VSCodium/);
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
  for (const [, imagePath] of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    assert.ok(!/^https?:/i.test(imagePath), `README image ${imagePath} is local`);
    assert.ok(fs.existsSync(path.resolve(APP, imagePath)), `README image ${imagePath} exists`);
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
  const source = fs.readFileSync(path.join(APP, "extension.js"), "utf8");
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
  assert.match(packageIgnore, /^!ignore-once\.js$/m);
  assert.match(packageIgnore, /^!images\/\*\*$/m);

  assert.deepEqual(editor.categories, ["AI", "Linters", "Other"]);
  assert.deepEqual(editor.galleryBanner, { color: "#1A1221", theme: "dark" });
  assert.deepEqual(editor.keywords, [
    "secrets",
    "credentials",
    "api key",
    "privacy",
    "pii",
    "ai",
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
  assert.ok(editor.activationEvents.includes("onStartupFinished"));
  assert.ok(!editor.activationEvents.includes("*"));
  const en = require("../apps/vscode/package.nls.json");
  const es = require("../apps/vscode/package.nls.es.json");
  assert.equal(en.displayName, "Clotr for VS Code-compatible editors");
  assert.equal(es.displayName, "Clotr para editores compatibles con VS Code");
  assert.match(en.description, /credentials/);
  assert.match(es.description, /credenciales/);
});

test("Open VSX hosts use the workspace host and the VS Code 1.57 API floor", () => {
  const editor = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  assert.equal(editor.engines.vscode, "^1.57.0");
  assert.deepEqual(editor.extensionKind, ["workspace"]);
  for (const file of ["extension.js", "guard/bin/clotr-guard.js"]) {
    const source = fs.readFileSync(path.join(APP, file), "utf8");
    assert.doesNotMatch(source, /\.at\(/, `${file} runs on the VS Code 1.57 Node host`);
    assert.doesNotMatch(source, /Object\.hasOwn|structuredClone|fs\.rmSync/, `${file} runs on Node 12`);
  }
  const source = fs.readFileSync(path.join(APP, "extension.js"), "utf8");
  assert.match(source, /vscode\.env\.appName/);
  assert.match(source, /vscode\.env\.uriScheme/);
  assert.doesNotMatch(source, /diagnostic\.data/, "Diagnostic.data is newer than the supported VS Code API floor");
  assert.doesNotMatch(source, /vscode\.proposed|enableProposedApi/);
});

test("finding: VS Code 1.57's Node 14 host can load the extension", () => {
  for (const file of [
    "extension.js",
    "guard/bin/clotr-guard.js",
    "guard/lib/clotrignore.js",
    "guard/lib/engine.js",
    "guard/lib/secret-files.js",
    "guard/dist/clotr-engine.js",
  ]) {
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
  assert.match(es[guardStep], /open-vsx\.org\/extension\/clotr-app\/clotr\/reviews/i);
  assert.match(es[guardStep], /github\.com\/clotr-app\/clotr\/issues/i);
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
    const packageInputs = ["extension.js", "package.json", "package.nls.json", "package.nls.es.json"].map((file) => [
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
    fireClose(document) {
      const index = documents.indexOf(document);
      if (index >= 0) documents.splice(index, 1);
      closeDocumentListener?.({ document });
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
  const extFile = path.join(APP, "extension.js");
  const extModule = new Module(extFile, module);
  extModule.filename = extFile;
  extModule.paths = Module._nodeModulePaths(APP);
  extModule.require = (name) => {
    if (name === "vscode") return fake.vscode;
    if (name === "node:child_process" || name === "child_process") {
      return {
        ...require("child_process"),
        ...(spawnSyncMock ? { spawnSync: spawnSyncMock } : {}),
        ...(spawnMock ? { spawn: spawnMock } : {}),
      };
    }
    return name.startsWith(".") ? require(path.resolve(APP, name)) : require(name);
  };
  const createContext = vm.createContext;
  vm.createContext = (...args) => {
    fake.engineContext = createContext(...args);
    return fake.engineContext;
  };
  try {
    extModule._compile(fs.readFileSync(extFile, "utf8"), extFile);
    fake.extensionApi = extModule.exports;
    return await extModule.exports.activate(fake.context);
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
      "ignore-once.js",
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
  const { pruneIgnoredOnce } = require("../apps/vscode/ignore-once.js");
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
    [...fs.readFileSync(path.join(ROOT, "extension", "patterns.js"), "utf8").matchAll(/\bid:\s*"([^"]+)"/g)].map(
      ([, id]) => id,
    ),
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
  for (const file of [
    "extension.js",
    "ignore-once.js",
    "package.json",
    "package.nls.json",
    "package.nls.es.json",
    "README.md",
  ]) {
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
      (items) => items.filter((item) => ["claude", "codex"].includes(item.tool)),
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
      (items) => items.filter((item) => ["claude", "codex"].includes(item.tool)),
    ]);
    await activateContainedExtension(after, clicked);
    await waitFor(
      () => clicked.vscode.window.messages.includes(require("../apps/vscode/package.nls.json").guardUpdated),
      "Guard setup",
    );
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

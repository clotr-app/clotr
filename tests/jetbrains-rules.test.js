"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "apps", "jetbrains");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

// ---------- Finding the plugin's code ----------

// Code is found by what it declares, not by its file's path, so a file can move or split without this test following
// it. A lookup that finds nothing, or finds two files, fails, so a check can never pass on a file that isn't there.
function mainSources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(kt|java)$/.test(entry.name)) found.push({ file, text: fs.readFileSync(file, "utf8") });
    }
  };
  walk(path.join(ROOT, "src", "main"));
  return found;
}

// The one source file that declares `declaration`, such as "class GuardSetupDialog" or "fun showGuardSetup".
function declaring(declaration) {
  const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[ \\t]*(?:[\\w@]+[ \\t]+)*${escaped}\\b`, "m");
  const found = mainSources().filter(({ text }) => pattern.test(text));
  const names = found.map(({ file }) => path.relative(ROOT, file)).join(", ") || "none";
  assert.equal(found.length, 1, `exactly one file declares ${declaration} (found ${names})`);
  return found[0].text;
}

// The files that declare these, each once, as one text: the code of one feature, however it's split into files.
function feature(...declarations) {
  return [...new Set(declarations.map(declaring))].join("\n");
}

// The build makes the engine bundle from the manifest each time (clotrEngineBundle), so a build number typed into the
// README would go stale with the next batch.
test("JetBrains shows its release version and leaves the engine build to the package", () => {
  const build = read("build.gradle.kts");
  const pluginVersion = build.match(/^version = "([^"]+)"/m)?.[1];
  const readme = read("README.md");
  assert.equal(pluginVersion, "0.1.3");
  assert.equal(readme.match(/^Version (\d+\.\d+\.\d+)\.$/m)?.[1], pluginVersion);
  assert.doesNotMatch(readme, /engine \d+\.\d+\.\d+/i);
  assert.match(build, /commandLine\("node", "tools\/engine-bundle\.js", "--out"/);
  assert.match(build, /processResources \{\s*dependsOn\("clotrEngineBundle"/);
});

test("JetBrains app has no network clients or AI runtime dependencies", () => {
  const sourceRoot = path.join(ROOT, "src", "main");
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(kt|kts|java)$/.test(entry.name)) sources.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(sourceRoot);
  assert.doesNotMatch(sources.join("\n"), /java\.net|javax\.net|HttpClient|URLConnection|Socket\s*\(/);
  const dependencies = read("build.gradle.kts").toLowerCase();
  assert.doesNotMatch(dependencies, /tensorflow|onnxruntime|llama|openai|anthropic|huggingface/);
  assert.match(dependencies, /js-community/);
  assert.match(declaring("class EngineBridge"), /allowIO\(IOAccess\.NONE\)/);
  assert.match(declaring("class EngineBridge"), /HostAccess\.NONE/);
});

test("project path rules cannot silence JetBrains inspection findings", () => {
  const inspection = declaring("class ClotrInspection");
  assert.doesNotMatch(inspection, /pathIgnoredForFile\s*\(/);
  assert.match(inspection, /ClotrIgnore\.valueFingerprint\(ignore\.config\.salt, range\.value\)/);
  assert.match(feature("class ClotrProjectService", "object ClipboardChecker"), /fun clotrIgnoreFor\(/);
});

test("JetBrains shows an unchecked file state when inspection cannot check it", () => {
  const inspection = declaring("class ClotrInspection");
  const service = feature("class ClotrProjectService", "object ClipboardChecker");
  const widget = declaring("class ClotrStatusWidget");
  assert.match(inspection, /markUnchecked\(path\)/);
  assert.match(inspection, /inspection\.tooLarge/);
  assert.match(inspection, /inspection\.checkFailed/);
  assert.match(service, /fun uncheckedCount\(\)/);
  assert.match(widget, /uncheckedCount\(\)/);
});

test("JetBrains hands text, salt and settings to the engine as arguments, never inside its source", () => {
  const engine = declaring("class EngineBridge");
  const sources = [...engine.matchAll(/context\.eval\("js",\s*("""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/g)].map((m) => m[1]);
  assert.ok(sources.length >= 5, "the engine's functions are found");
  for (const source of sources) {
    assert.doesNotMatch(source, /\$/, "a Kotlin template would splice a value into JavaScript");
  }
  assert.doesNotMatch(engine, /putMember/);
});

test("JetBrains keeps the salt and fingerprints on this computer, out of the project and out of settings sync", () => {
  const service = feature("class ClotrProjectService", "object ClipboardChecker");
  const local = declaring("class ClotrLocalState");
  const readme = read("README.md");
  assert.doesNotMatch(service, /\.set(Value|List)\(/);
  assert.match(local, /roamingType = RoamingType\.DISABLED/);
  assert.doesNotMatch(local, /StoragePathMacros|WORKSPACE_FILE/);
  assert.match(readme, /not encrypted, and JetBrains\s+Settings Sync leaves it out/);
  assert.match(readme, /Fingerprints in `\.clotrignore` use a separate repository salt/);
  assert.match(readme, /Path patterns in that\s+file do not skip files/);
});

test("JetBrains finds Guard only where the person put it, and sets it up only in a trusted project", () => {
  const guard = feature("object GuardSetup", "class GuardSetupDialog", "fun showGuardSetup");
  // Never a walk from the project or the IDE's working folder, where a project could plant its own script.
  assert.doesNotMatch(guard, /user\.dir|apps\/guard\/bin|walk|basePath\s*\)\s*\.parent/);
  assert.match(guard, /clotr-guard\/bin\/clotr-guard\.js/);
  assert.match(guard, /"root", "-g"/);
  assert.match(guard, /fun showGuardSetup[\s\S]*?GuardSetup\.trusted\(project\)[\s\S]*?Messages\.showDialog\(/);
  assert.match(guard, /TrustedProjects\.isProjectTrusted/);
  // The dialog only lays out choices: Guard and npm run after the person clicks. The dry run sits in its own helper,
  // previewOne, so a call to that before doOKAction would start Guard too.
  const dialogFile = declaring("class GuardSetupDialog");
  const start = dialogFile.indexOf("class GuardSetupDialog");
  const end = dialogFile.indexOf("override fun doOKAction", start);
  assert.ok(start >= 0 && end > start, "the dialog runs from its class line to doOKAction");
  const dialog = dialogFile.slice(start, end);
  assert.doesNotMatch(dialog, /GuardSetup\.(run|exec|globalCli|npmGlobalRoot|findCli)\(|previewOne\(|ProcessBuilder/);
  assert.match(
    dialogFile,
    /fun previewOne\([^)]*\)[^{]*\{[^}]*GuardSetup\.run\(/,
    "the dry run stays in previewOne, which the check above looks for",
  );
  assert.match(guard, /fun exec\([^)]*\)[^{]*\{\s*checkOffUiThread\(/);
  const everything = mainSources()
    .map(({ text }) => text)
    .join("\n");
  assert.equal((everything.match(/ProcessBuilder\(/g) || []).length, 1, "every process starts in exec()");
});

test("JetBrains tells people how to install Guard when it cannot find it", () => {
  const words = read("src/main/resources/messages/ClotrBundle.properties");
  assert.match(
    words,
    /^guard\.cliMissing=Clotr Guard was not found\. Install it with npm install -g clotr-guard, or select its clotr-guard\.js file\.$/m,
  );
});

test("JetBrains status widget only uses its tooltip to report unchecked files", () => {
  const widget = declaring("class ClotrStatusWidget");
  const words = read("src/main/resources/messages/ClotrBundle.properties");
  assert.match(widget, /uncheckedCount\(\)/);
  assert.match(widget, /ClotrBundle(?:\.INSTANCE)?\.message\("status\.unchecked"/);
  assert.doesNotMatch(words, /^status\.tooltip=.*settings/im);
});

// The repo's own workflows, and in the fuller checkout this test came from, the public repo's copies beside them too.
const workflowFiles = () =>
  [".github", path.join("public", ".github")]
    .map((dir) => path.join(__dirname, "..", dir, "workflows"))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir).map((name) => path.join(dir, name)))
    .filter((file) => /\.ya?ml$/.test(file));

// Every workflow that runs the plugin's Gradle wrapper: the JetBrains build, and CodeQL's build of its Kotlin.
test("each CI job that builds the plugin checks the committed Gradle wrapper before Gradle runs", () => {
  const workflows = workflowFiles().filter((file) =>
    /working-directory: apps\/jetbrains/.test(fs.readFileSync(file, "utf8")),
  );
  assert.ok(
    workflows.some((file) => path.basename(file) === "jetbrains.yml"),
    "no JetBrains workflow",
  );
  for (const file of workflows) {
    const workflow = fs.readFileSync(file, "utf8");
    const validation = workflow.search(/uses: gradle\/actions\/wrapper-validation@[0-9a-f]{40}/);
    assert.ok(validation > 0, `${file}: wrapper validation is pinned to a commit`);
    assert.ok(validation < workflow.indexOf("gradle/actions/setup-gradle@"), `${file}: validation before setup-gradle`);
    assert.ok(validation < workflow.indexOf("./gradlew"), `${file}: validation comes before the wrapper runs`);
    assert.match(workflow, /persist-credentials: false/);
  }
});

// CodeQL reads Kotlin only while it compiles. Its default setup scanned the plugin without a build and found none of
// it, so the public repo's CodeQL workflow compiles the main and test sources itself, with nothing cached.
test("CodeQL compiles the plugin's Kotlin itself instead of scanning it without a build", () => {
  const workflows = workflowFiles().filter((file) => path.basename(file) === "codeql.yml");
  assert.ok(workflows.length > 0, "no CodeQL workflow");
  for (const file of workflows) {
    const workflow = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const language of ["actions", "javascript-typescript", "java-kotlin"]) {
      assert.match(workflow, new RegExp(`- language: ${language}\\n`), `${file}: ${language} isn't analyzed`);
    }
    assert.match(workflow, /- language: java-kotlin\n\s+build-mode: manual\n/, `${file}: Kotlin needs a manual build`);
    const build = workflow.match(/working-directory: apps\/jetbrains\n[\s\S]*?\n\s+run: >-\n((?: {10}.*\n)+)/);
    assert.ok(build, `${file}: no build of apps/jetbrains`);
    const command = build[1].replace(/\s+/g, " ").trim();
    for (const part of [
      "--no-daemon",
      "--no-configuration-cache",
      "--no-build-cache",
      "compileKotlin",
      "compileTestKotlin",
    ]) {
      assert.ok(command.split(" ").includes(part), `${file}: the Kotlin build is missing ${part}`);
    }
    const init = workflow.indexOf("github/codeql-action/init@");
    assert.ok(init > 0 && init < workflow.indexOf("./gradlew"), `${file}: Gradle runs before CodeQL is watching`);
    assert.ok(workflow.indexOf("./gradlew") < workflow.indexOf("github/codeql-action/analyze@"), `${file}: order`);
  }
});

test("JetBrains inspection reports only masked previews and local fingerprints", () => {
  const engine = declaring("class EngineBridge");
  const inspection = declaring("class ClotrInspection");
  assert.match(engine, /item\.getMember\("preview"\)/);
  assert.match(engine, /item\.getMember\("fp"\)/);
  assert.match(engine, /item\.getMember\("value"\)/);
  assert.match(inspection, /range\.value/);
  assert.match(inspection, /ClotrIgnore\.valueFingerprint/);
  assert.match(inspection, /1024 \* 1024/);
  assert.match(inspection, /isSecretFile/);
});

test("JetBrains ignore values stay as hashes in project state", () => {
  const ignore = declaring("object ClotrIgnore");
  const service = feature("class ClotrProjectService", "object ClipboardChecker");
  const local = declaring("class ClotrLocalState");
  assert.match(ignore, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(ignore, /Files\.isSymbolicLink\(file\)/);
  assert.match(ignore, /LinkOption\.NOFOLLOW_LINKS/);
  assert.match(service, /ClotrIgnore\.valueFingerprint/);
  assert.doesNotMatch(local, /ignore\.value|valueFingerprint/);
});

test("JetBrains skips shared secret files and sends one dismissible project note for unignored files", () => {
  const inspection = declaring("class ClotrInspection");
  const service = feature("class ClotrProjectService", "object ClipboardChecker");
  const words = read("src/main/resources/messages/ClotrBundle.properties");
  assert.match(inspection, /SecretFiles\.isSecretFile/);
  assert.match(service, /checkSecretFile/);
  assert.match(service, /secretNoteShown/);
  assert.match(words, /secret\.addToGitignore=Add it to \.gitignore/);
  assert.match(service, /\.gitignore/);
  assert.match(service, /NotificationType\.INFORMATION/);
});

test("JetBrains checks credentials by default and keeps personal details opt-in", () => {
  const inspection = declaring("class ClotrInspection");
  const preferences = declaring("class ClotrPreferences");
  assert.match(inspection, /personalDetailsInFiles/);
  assert.match(preferences, /var personalDetailsInFiles = false/);
  // Card and bank numbers are in the engine's personal group but stay on, so the setting and the README say so.
  assert.match(inspection, /MONEY_KINDS = setOf\("credit_card", "card_code", "gift_card", "bank_account"\)/);
  assert.match(
    read("src/main/resources/messages/ClotrBundle.properties"),
    /^settings\.personalDetails=Check personal details in open files \(card and bank numbers are checked with credentials\)$/m,
  );
  assert.match(read("README.md").replace(/\s+/g, " "), /card, card security code, gift card and bank numbers/);
});

test("JetBrains secret-file JSON matches the shared secret-file rules", () => {
  const check = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "sync-secret-files.js"), "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test("JetBrains uses the same default skip patterns as VS Code", () => {
  const vscode = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "apps", "vscode", "package.json"), "utf8"));
  const patterns = vscode.contributes.configuration.properties["clotr.skipList"].default;
  const kotlin = declaring("class ClotrPreferences");
  const block = kotlin.match(/DEFAULT_SKIP_PATTERNS = listOf\(([\s\S]*?)\n\s*\)/);
  assert.ok(block, "the JetBrains default skip list is present");
  assert.deepEqual(
    [...block[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
    patterns,
  );
});

// The IDE only reads <add-to-group> inside the <action> it adds. Standing on its own under <actions> it's skipped
// with a parser error, and the action exists but shows in no menu.
test("each JetBrains menu entry sits inside the action it adds, so the menus show it", () => {
  const xml = read("src/main/resources/META-INF/plugin.xml");
  const actions = xml.match(/<actions>([\s\S]*?)<\/actions>/)[1];
  const outside = actions.replace(/<action\b[^>]*?(?:\/>|>[\s\S]*?<\/action>)/g, "");
  assert.doesNotMatch(outside, /<add-to-group/);
  const groupOf = (id) => {
    const start = actions.indexOf(`<action id="${id}"`);
    const entry = start < 0 ? "" : actions.slice(start, actions.indexOf("</action>", start));
    return entry.match(/<add-to-group group-id="([^"]+)"/)?.[1];
  };
  assert.equal(groupOf("app.clotr.CheckSelection"), "EditorPopupMenu");
  assert.equal(groupOf("app.clotr.CheckClipboard"), "ToolsMenu");
  assert.equal(groupOf("app.clotr.GuardSetup"), "ToolsMenu");
});

// An action's menu label comes from the plugin's bundle under action.<id>.text; the IDE doesn't read a %key% in its
// text attribute, and would show the key itself.
test("each JetBrains action has its menu label in both languages", () => {
  const xml = read("src/main/resources/META-INF/plugin.xml");
  const ids = [...xml.matchAll(/<action id="([^"]+)"([^>]*)>/g)];
  assert.ok(ids.length >= 3);
  for (const [, id, attributes] of ids) {
    assert.doesNotMatch(attributes, /text="%/, `${id} names a bundle key in its text`);
    for (const bundle of ["ClotrBundle.properties", "ClotrBundle_es.properties"]) {
      const words = read(`src/main/resources/messages/${bundle}`);
      const key = `action.${id}.text=`;
      const label = words.split("\n").find((line) => line.startsWith(key));
      assert.ok(label && label.length > key.length, `${bundle} has no menu label for ${id}`);
    }
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "apps", "jetbrains");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

// The build makes the engine bundle from the manifest each time (clotrEngineBundle), so a build number typed into the
// README would go stale with the next batch.
test("JetBrains shows its release version and leaves the engine build to the package", () => {
  const build = read("build.gradle.kts");
  const pluginVersion = build.match(/^version = "([^"]+)"/m)?.[1];
  const readme = read("README.md");
  assert.equal(pluginVersion, "0.1.0");
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
      else if (/\.(kt|kts)$/.test(entry.name)) sources.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(sourceRoot);
  assert.doesNotMatch(sources.join("\n"), /java\.net|javax\.net|HttpClient|URLConnection|Socket\s*\(/);
  const dependencies = read("build.gradle.kts").toLowerCase();
  assert.doesNotMatch(dependencies, /tensorflow|onnxruntime|llama|openai|anthropic|huggingface/);
  assert.match(dependencies, /js-community/);
  assert.match(read("src/main/kotlin/app/clotr/jetbrains/ClotrEngine.kt"), /allowIO\(false\)/);
  assert.match(read("src/main/kotlin/app/clotr/jetbrains/ClotrEngine.kt"), /HostAccess\.NONE/);
});

test("JetBrains hands text, salt and settings to the engine as arguments, never inside its source", () => {
  const engine = read("src/main/kotlin/app/clotr/jetbrains/ClotrEngine.kt");
  const sources = [...engine.matchAll(/context\.eval\("js",\s*("""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/g)].map((m) => m[1]);
  assert.ok(sources.length >= 5, "the engine's functions are found");
  for (const source of sources) {
    assert.doesNotMatch(source, /\$/, "a Kotlin template would splice a value into JavaScript");
  }
  assert.doesNotMatch(engine, /putMember/);
});

test("JetBrains keeps the salt and fingerprints on this computer, out of the project and out of settings sync", () => {
  const service = read("src/main/kotlin/app/clotr/jetbrains/ClotrProjectService.kt");
  const local = read("src/main/kotlin/app/clotr/jetbrains/ClotrLocalState.kt");
  assert.doesNotMatch(service, /\.set(Value|List)\(/);
  assert.match(local, /roamingType = RoamingType\.DISABLED/);
  assert.doesNotMatch(local, /StoragePathMacros|WORKSPACE_FILE/);
});

test("JetBrains finds Guard only where the person put it, and sets it up only in a trusted project", () => {
  const guard = read("src/main/kotlin/app/clotr/jetbrains/GuardSetup.kt");
  // Never a walk from the project or the IDE's working folder, where a project could plant its own script.
  assert.doesNotMatch(guard, /user\.dir|apps\/guard\/bin|walk|basePath\s*\)\s*\.parent/);
  assert.match(guard, /clotr-guard\/bin\/clotr-guard\.js/);
  assert.match(guard, /"root", "-g"/);
  assert.match(guard, /fun showGuardSetup[\s\S]*?GuardSetup\.trusted\(project\)[\s\S]*?showChooseDialog/);
  assert.match(guard, /TrustedProjects\.isProjectTrusted/);
  // The dialog only lays out choices: Guard and npm run after the person clicks.
  const dialog = guard.slice(guard.indexOf("class GuardSetupDialog"), guard.indexOf("override fun doOKAction"));
  assert.doesNotMatch(dialog, /GuardSetup\.(run|exec|globalCli|npmGlobalRoot|findCli)\(|ProcessBuilder/);
  assert.match(guard, /fun exec\([^)]*\)[^{]*\{\s*checkOffUiThread\(/);
  assert.equal((guard.match(/ProcessBuilder\(/g) || []).length, 1, "every process starts in exec()");
});

test("JetBrains tells people how to install Guard when it cannot find it", () => {
  const words = read("src/main/resources/messages/ClotrBundle.properties");
  assert.match(
    words,
    /^guard\.cliMissing=Install Clotr Guard with npm install -g clotr-guard, or point the setting at it\.$/m,
  );
});

test("JetBrains status widget has no tooltip that promises to open settings", () => {
  const widget = read("src/main/kotlin/app/clotr/jetbrains/ClotrStatusWidget.kt");
  const words = read("src/main/resources/messages/ClotrBundle.properties");
  assert.match(widget, /override fun getTooltipText\(\) = ""/);
  assert.doesNotMatch(words, /^status\.tooltip=/m);
});

// The repo's own workflow, and in the fuller checkout this test came from, the public repo's copy beside it too.
test("each JetBrains CI job checks the committed Gradle wrapper before Gradle runs", () => {
  const workflows = [".github", path.join("public", ".github")]
    .map((dir) => path.join(__dirname, "..", dir, "workflows", "jetbrains.yml"))
    .filter((file) => fs.existsSync(file));
  assert.ok(workflows.length > 0, "no JetBrains workflow");
  for (const file of workflows) {
    const workflow = fs.readFileSync(file, "utf8");
    const validation = workflow.search(/uses: gradle\/actions\/wrapper-validation@[0-9a-f]{40}/);
    assert.ok(validation > 0, `${file}: wrapper validation is pinned to a commit`);
    assert.ok(validation < workflow.indexOf("gradle/actions/setup-gradle@"), `${file}: validation before setup-gradle`);
    assert.ok(validation < workflow.indexOf("./gradlew"), `${file}: validation comes before the wrapper runs`);
    assert.match(workflow, /persist-credentials: false/);
  }
});

test("JetBrains inspection reports only masked previews and local fingerprints", () => {
  const engine = read("src/main/kotlin/app/clotr/jetbrains/ClotrEngine.kt");
  const inspection = read("src/main/kotlin/app/clotr/jetbrains/ClotrInspection.kt");
  assert.match(engine, /item\.getMember\("preview"\)/);
  assert.match(engine, /item\.getMember\("fp"\)/);
  assert.match(engine, /item\.getMember\("value"\)/);
  assert.match(inspection, /range\.value/);
  assert.match(inspection, /ClotrIgnore\.valueFingerprint/);
  assert.match(inspection, /1024 \* 1024/);
  assert.match(inspection, /isSecretFile/);
});

test("JetBrains ignore values stay as hashes in project state", () => {
  const ignore = read("src/main/kotlin/app/clotr/jetbrains/ClotrIgnore.kt");
  const service = read("src/main/kotlin/app/clotr/jetbrains/ClotrProjectService.kt");
  const local = read("src/main/kotlin/app/clotr/jetbrains/ClotrLocalState.kt");
  assert.match(ignore, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(ignore, /Files\.isSymbolicLink\(file\)/);
  assert.match(ignore, /LinkOption\.NOFOLLOW_LINKS/);
  assert.match(service, /ClotrIgnore\.valueFingerprint/);
  assert.doesNotMatch(local, /ignore\.value|valueFingerprint/);
});

test("JetBrains skips shared secret files and sends one dismissible project note for unignored files", () => {
  const inspection = read("src/main/kotlin/app/clotr/jetbrains/ClotrInspection.kt");
  const service = read("src/main/kotlin/app/clotr/jetbrains/ClotrProjectService.kt");
  const words = read("src/main/resources/messages/ClotrBundle.properties");
  assert.match(inspection, /SecretFiles\.isSecretFile/);
  assert.match(service, /checkSecretFile/);
  assert.match(service, /secretNoteShown/);
  assert.match(words, /secret\.addToGitignore=Add it to \.gitignore/);
  assert.match(service, /\.gitignore/);
  assert.match(service, /NotificationType\.INFORMATION/);
});

test("JetBrains checks credentials by default and keeps personal details opt-in", () => {
  const inspection = read("src/main/kotlin/app/clotr/jetbrains/ClotrInspection.kt");
  const preferences = read("src/main/kotlin/app/clotr/jetbrains/ClotrPreferences.kt");
  assert.match(inspection, /personalDetailsInFiles/);
  assert.match(preferences, /var personalDetailsInFiles = false/);
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
  const kotlin = read("src/main/kotlin/app/clotr/jetbrains/ClotrPreferences.kt");
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

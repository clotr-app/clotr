// Regressions from the 26 Oct review of Guard and the VS Code extension. Sample values are assembled at run time, so
// this file holds no whole made-up credential.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Guard loads the engine from its own bundle, which npm's prepack builds; build it here when it's missing.
const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.strictEqual(built.status, 0, built.stderr);
}
const guard = require("../apps/guard/bin/clotr-guard.js");
// Guard's search check gives up after 250 ms and lets the search through. On a busy test machine that limit, not the
// rule a test is about, would decide, so tests that aren't about the limit give it time to finish.
const inspectRead = (tool, event, options) => guard.inspectRead(tool, event, { searchWalkMaxMs: 10000, ...options });

const SCRIPT = path.join(__dirname, "..", "apps", "guard", "bin", "clotr-guard.js");
const SAMPLE_KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initGit(root) {
  const result = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("tool arguments that arrive as a JSON string are checked, never let through unread", (t) => {
  const dir = tempDir(t);
  for (const tool of ["claude", "cursor"]) {
    const event = { tool_name: "mcp__mail__send", tool_input: JSON.stringify({ body: `key ${SAMPLE_KEY}` }) };
    const outcome = guard.inspectTool(tool, event, { cwd: dir, dataDir: dir });
    assert.notStrictEqual(outcome.action, "allow", `${tool}: a key in string arguments must not go through`);
    assert.ok(!outcome.internalError, `${tool}: string arguments are read, not treated as an internal error`);
  }
});

test("the shared ignore writer refuses values that are easy to guess and keeps strong ones", (t) => {
  const root = tempDir(t);
  for (const value of ["hunter22", ["4111", "1111", "1111", "1111"].join(" "), "short"]) {
    assert.throws(
      () => guard.addIgnoredValue(root, value),
      /guessable-value/,
      `refuses ${value.length}-character value`,
    );
  }
  assert.ok(!fs.existsSync(path.join(root, ".clotrignore")), "nothing is written for a refused value");
  assert.strictEqual(guard.addIgnoredValue(root, SAMPLE_KEY), true);
  assert.match(fs.readFileSync(path.join(root, ".clotrignore"), "utf8"), /^salt: [0-9a-f]+\nfingerprint: /);
  assert.strictEqual(guard.addIgnoredValue(root, SAMPLE_KEY), false, "the same value isn't added twice");
});

test("the shared ignore writer also refuses values by the finding kind supplied by its caller", (t) => {
  const root = tempDir(t);
  const longValue = crypto.randomBytes(32).toString("base64url");
  assert.throws(() => guard.addIgnoredValue(root, longValue, "password"), /guessable-value/);
  assert.throws(() => guard.addIgnoredValue(root, longValue, "email_address"), /guessable-value/);
  assert.throws(() => guard.addIgnoredValue(root, "aB3!z9_".repeat(12)), /guessable-value/);
  assert.throws(() => guard.addIgnoredValue(root, "correct horse battery staple"), /guessable-value/);
  assert.equal(fs.existsSync(path.join(root, ".clotrignore")), false);
});

test("ignore-value accepts a finding kind from the CLI before writing a fingerprint", (t) => {
  const root = tempDir(t);
  initGit(root);
  const longValue = crypto.randomBytes(32).toString("base64url");
  const result = spawnSync(process.execPath, [SCRIPT, "ignore-value", "--kind", "password"], {
    cwd: root,
    input: `${longValue}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /too easy to guess/);
  assert.doesNotMatch(result.stderr, /Ignore this occurrence/);
  assert.equal(fs.existsSync(path.join(root, ".clotrignore")), false);
});

test("the VS Code quick fix writes .clotrignore through Guard's shared writer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "apps", "vscode", "extension.js"), "utf8");
  const body = source.slice(
    source.indexOf("async function addToClotrIgnore"),
    source.indexOf("async function moveToEnv"),
  );
  assert.match(body, /guard\.addIgnoredValue\(/);
  assert.match(body, /guard\.addIgnoredValue\(root, finding\.value, finding\.kind\)/);
  assert.doesNotMatch(body, /writeSync|openSync|valueFingerprint/, "no second writer for the same file");
});

test("read hooks stop proc environment files before opening them", (t) => {
  const root = tempDir(t);
  for (const file of ["/proc/self/environ", "/proc/123/environ", "/proc/thread-self/environ"]) {
    const outcome = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root });
    assert.equal(outcome.action, "block", file);
    assert.equal(outcome.secretFile, true, file);
  }
});

test("content searches in a repository without secret files pass in every supported search mode", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "app.js"), "const answer = 42;\n");
  const cases = [
    [
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "answer", path: root, output_mode: "content", glob: "**/*" } },
    ],
    ["gemini", { tool_name: "search_file_content", tool_input: { pattern: "answer", dir_path: root } }],
    ["gemini", { tool_name: "grep_search", tool_input: { pattern: "answer", dir_path: root } }],
    ["gemini", { tool_name: "read_many_files", tool_input: { include: ["**/*"] } }],
    ["gemini", { tool_name: "read_many_files", tool_input: { include: ["**/*"], useDefaultExcludes: false } }],
    ["cline", { preToolUse: { toolName: "search_files", parameters: { path: root, regex: "answer" } } }],
  ];
  for (const [tool, event] of cases) {
    assert.equal(inspectRead(tool, event, { cwd: root }).action, "allow", tool);
  }
});

test("searches stop only when their output can include a reachable secret file", (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=not-used-in-the-output\n");
  const claude = (output_mode, extra = {}) => ({
    tool_name: "Grep",
    tool_input: { pattern: "TOKEN", path: root, output_mode, ...extra },
  });
  for (const mode of ["files_with_matches", "count"]) {
    assert.equal(inspectRead("claude", claude(mode), { cwd: root }).action, "allow", mode);
  }
  const claudeContent = inspectRead("claude", claude("content"), { cwd: root });
  assert.equal(claudeContent.action, "block");
  assert.equal(claudeContent.secretFile, true);
  assert.equal(claudeContent.location, ".env");
  assert.equal(inspectRead("claude", claude("content", { glob: "**/*.js" }), { cwd: root }).action, "allow");

  const geminiSearch = (name, extra = {}) =>
    inspectRead(
      "gemini",
      { tool_name: name, tool_input: { pattern: "TOKEN", dir_path: root, ...extra } },
      { cwd: root },
    );
  assert.equal(geminiSearch("search_file_content").action, "block");
  assert.equal(geminiSearch("grep_search").action, "block");
  assert.equal(geminiSearch("grep_search", { names_only: true }).action, "allow");
  assert.equal(geminiSearch("grep_search", { include_pattern: "*.js" }).action, "allow");
  const rootGeminiReadMany = (extra = {}) =>
    inspectRead(
      "gemini",
      {
        tool_name: "read_many_files",
        tool_input: {
          include: ["**/*"],
          file_filtering_options: { respect_git_ignore: false, respect_gemini_ignore: false },
          ...extra,
        },
      },
      { cwd: root },
    );
  assert.equal(rootGeminiReadMany().action, "allow", "Gemini's default read exclusions omit .env");
  assert.equal(
    rootGeminiReadMany({ include: [".env"] }).action,
    "allow",
    "the default .env exclusion still applies to an explicit include",
  );
  assert.equal(
    rootGeminiReadMany({ useDefaultExcludes: false }).action,
    "block",
    "disabling Gemini's default excludes makes .env reachable",
  );

  const defaultExcludedSecret = tempDir(t);
  fs.mkdirSync(path.join(defaultExcludedSecret, "dist"));
  fs.writeFileSync(path.join(defaultExcludedSecret, "dist", "credentials.json"), "token: not-used-in-the-output\n");
  const geminiReadMany = (extra = {}) =>
    inspectRead(
      "gemini",
      {
        tool_name: "read_many_files",
        tool_input: {
          include: ["**/*"],
          file_filtering_options: { respect_git_ignore: false, respect_gemini_ignore: false },
          ...extra,
        },
      },
      { cwd: defaultExcludedSecret },
    );
  assert.equal(geminiReadMany().action, "allow", "Gemini's default directory exclusions apply to secret files");
  assert.equal(geminiReadMany({ useDefaultExcludes: false }).action, "block");
  assert.equal(
    inspectRead(
      "gemini",
      {
        tool_name: "read_many_files",
        tool_input: {
          include: ["**/*"],
          useDefaultExcludes: false,
          exclude: ["**/.env"],
          file_filtering_options: { respect_git_ignore: false, respect_gemini_ignore: false },
        },
      },
      { cwd: root },
    ).action,
    "allow",
  );

  const cline = (extra = {}) =>
    inspectRead(
      "cline",
      {
        preToolUse: {
          toolName: "search_files",
          parameters: JSON.stringify({ path: root, regex: "TOKEN", ...extra }),
        },
      },
      { cwd: root },
    );
  assert.equal(cline().action, "allow", "Cline's ripgrep search skips hidden files by default");
  assert.equal(cline({ file_pattern: "*.js" }).action, "allow");
  assert.equal(cline({ file_pattern: "**/.env" }).action, "block", "an explicit secret-file glob is stopped");
  const clineVisibleSecret = tempDir(t);
  fs.writeFileSync(path.join(clineVisibleSecret, "credentials.json"), "token: not-used-in-the-output\n");
  assert.equal(
    inspectRead(
      "cline",
      {
        preToolUse: {
          toolName: "search_files",
          parameters: JSON.stringify({ path: clineVisibleSecret, regex: "token" }),
        },
      },
      { cwd: clineVisibleSecret },
    ).action,
    "block",
    "Cline can reach a visible secret file with its normal ripgrep filters",
  );

  const message = JSON.parse(guard.readHookOutput("claude", claudeContent).stdout).hookSpecificOutput
    .permissionDecisionReason;
  assert.match(message, /secret file.*\.env/i);
  assert.match(message, /file glob that leaves ".env" out/i);
  assert.match(message, /\*\.js/);
  assert.doesNotMatch(message, /TOKEN=not-used/);

  for (const directory of [".git", "node_modules"]) {
    const skippedRoot = path.join(root, "skip-check", directory);
    fs.mkdirSync(skippedRoot, { recursive: true });
    fs.writeFileSync(path.join(skippedRoot, ".env"), "");
    assert.equal(
      inspectRead(
        "gemini",
        { tool_name: "search_file_content", tool_input: { dir_path: path.dirname(skippedRoot) } },
        { cwd: root },
      ).action,
      "allow",
      `${directory} is outside the bounded search walk`,
    );
    assert.equal(
      inspectRead("gemini", { tool_name: "search_file_content", tool_input: { dir_path: skippedRoot } }, { cwd: root })
        .action,
      "allow",
      `${directory} as the search root is skipped too`,
    );
  }

  const claudeMatcher = guard.mergeHook({}, "claude").hooks.PreToolUse.find((group) => group.matcher)?.matcher;
  assert.match(claudeMatcher, /Grep/);
  const geminiMatcher = guard.mergeHook({}, "gemini").hooks.BeforeTool.find((group) => group.matcher)?.matcher;
  assert.match(geminiMatcher, /read_many_files/);
  assert.match(geminiMatcher, /search_file_content/);
});

test("search reachability follows Git and Gemini ignore filters", (t) => {
  const root = tempDir(t);
  initGit(root);
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=not-used-in-the-output\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  const geminiSearch = (name, extra = {}) =>
    inspectRead(
      "gemini",
      { tool_name: name, tool_input: { pattern: "TOKEN", dir_path: root, ...extra } },
      { cwd: root },
    );
  assert.equal(geminiSearch("search_file_content").action, "allow", "git grep omits an ignored untracked file");
  assert.equal(geminiSearch("grep_search", { no_ignore: true }).action, "block");

  const readMany = (options = {}) =>
    inspectRead(
      "gemini",
      {
        tool_name: "read_many_files",
        tool_input: { include: ["**/*"], useDefaultExcludes: false, ...options },
      },
      { cwd: root },
    );
  assert.equal(readMany().action, "allow", "read_many_files respects .gitignore by default");
  assert.equal(readMany({ file_filtering_options: { respect_git_ignore: false } }).action, "block");

  fs.writeFileSync(path.join(root, ".gitignore"), "");
  fs.writeFileSync(path.join(root, ".geminiignore"), ".env\n");
  assert.equal(readMany().action, "allow", "read_many_files respects .geminiignore by default");
  assert.equal(readMany({ file_filtering_options: { respect_gemini_ignore: false } }).action, "block");
});

test("a search walk that reaches its entry limit passes the search with a note", (t) => {
  const root = tempDir(t);
  const many = path.join(root, "files");
  fs.mkdirSync(many);
  for (let index = 0; index < 2_500; index += 1) fs.writeFileSync(path.join(many, `file-${index}.js`), "");
  const event = { tool_name: "Grep", tool_input: { pattern: "value", path: many, output_mode: "content" } };
  const outcome = inspectRead("claude", event, { cwd: root });
  assert.equal(outcome.action, "allow");
  assert.equal(outcome.searchLimited, true);
  const output = guard.readHookOutput("claude", outcome);
  assert.match(output.stderr, /search.*limit|limit.*search/i);
  assert.doesNotMatch(output.stdout, /"decision"\s*:\s*"deny"/);

  const shortDeadline = inspectRead("claude", event, { cwd: root, searchWalkMaxMs: 1 });
  assert.equal(shortDeadline.action, "allow");
  assert.equal(shortDeadline.searchLimited, true);
});

test("blocked messages name the finding and location without showing any part of its value", (t) => {
  const root = tempDir(t);
  const file = path.join(root, "ordinary.txt");
  fs.writeFileSync(file, `Use this key ${SAMPLE_KEY}`);
  const read = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root });
  const readMessage = JSON.stringify(guard.readHookOutput("claude", read));
  assert.match(readMessage, /AWS Access Key/);
  assert.match(readMessage, /ordinary\.txt/);
  assert.doesNotMatch(readMessage, new RegExp(SAMPLE_KEY));
  assert.doesNotMatch(readMessage, new RegExp(SAMPLE_KEY.slice(0, 8)));

  const prompt = guard.inspectPrompt("claude", `Use this key ${SAMPLE_KEY}`, { dataDir: path.join(root, "state") });
  const promptMessage = JSON.stringify(guard.hookOutput("claude", prompt));
  assert.match(promptMessage, /AWS Access Key/);
  assert.match(promptMessage, /prompt/);
  assert.doesNotMatch(promptMessage, new RegExp(SAMPLE_KEY));
  assert.doesNotMatch(promptMessage, new RegExp(SAMPLE_KEY.slice(0, 8)));

  const secretFile = path.join(root, ".env");
  fs.writeFileSync(secretFile, `TOKEN=${SAMPLE_KEY}`);
  const secretRead = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: secretFile } }, { cwd: root });
  const secretReadMessage = JSON.stringify(guard.readHookOutput("claude", secretRead));
  assert.match(secretReadMessage, /secret file/);
  assert.match(secretReadMessage, /\.env/);
  assert.doesNotMatch(secretReadMessage, new RegExp(SAMPLE_KEY));
  assert.doesNotMatch(secretReadMessage, new RegExp(SAMPLE_KEY.slice(0, 8)));

  const shell = guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command: `cat "${secretFile}"` } });
  const shellMessage = JSON.stringify(guard.boundaryOutput("claude", shell, "shell"));
  assert.match(shellMessage, /shell command/i);
  assert.match(shellMessage, /\.env/);
  assert.doesNotMatch(shellMessage, new RegExp(SAMPLE_KEY));
});

test("setup upgrades the old Claude Read matcher and remove recognizes either matcher", (t) => {
  const home = tempDir(t);
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const legacy = (action) => ({
    type: "command",
    command: `"node" "${SCRIPT}" ${action} claude --min-severity medium`,
    timeout: 15,
  });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [legacy("hook")] }],
        PreToolUse: [{ matcher: "Read", hooks: [legacy("read")] }],
      },
    }),
  );
  const guardHooks = () =>
    JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks || {}).split("clotr-guard.js").length - 1;
  const before = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(before.hooks.PreToolUse[0].matcher, "Read");
  guard.updateSettings("claude", { home, cwd: home });
  const afterSetup = JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks;
  assert.strictEqual(
    JSON.stringify(afterSetup.UserPromptSubmit).split("clotr-guard.js").length - 1,
    1,
    "setup replaces the 0.1.0 prompt hook instead of adding a second",
  );
  assert.ok(!JSON.stringify(afterSetup).includes('\\"node\\"'), "no 0.1.0 hook is left behind");
  assert.deepEqual(
    afterSetup.PreToolUse.filter((group) => group.matcher?.includes("Grep")).map((group) => group.matcher),
    ["^(?:Read|Grep)$"],
    "setup replaces the old matcher without adding a duplicate",
  );
  guard.updateSettings("claude", { home, cwd: home, remove: true });
  assert.strictEqual(guardHooks(), 0, "remove takes out every Clotr hook");

  for (const matcher of ["Read", "^(?:Read|Grep)$"]) {
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [legacy("read")] }] } }));
    guard.updateSettings("claude", { home, cwd: home, remove: true });
    assert.equal(guardHooks(), 0, `remove recognizes matcher ${matcher}`);
  }
});

test("a stray --windsurf-jetbrains never stops a prompt, and setup refuses it for other assistants", (t) => {
  const home = tempDir(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const hook = spawnSync(process.execPath, [SCRIPT, "hook", "claude", "--windsurf-jetbrains"], {
    input: JSON.stringify({ prompt: "A clean prompt", cwd: home }),
    encoding: "utf8",
    env,
    cwd: home,
  });
  assert.strictEqual(hook.status, 0, hook.stderr);
  assert.doesNotMatch(hook.stdout, /"decision"\s*:\s*"block"/);
  const setup = spawnSync(process.execPath, [SCRIPT, "setup", "claude", "--windsurf-jetbrains", "--dry-run"], {
    encoding: "utf8",
    env,
    cwd: home,
  });
  assert.strictEqual(setup.status, 2);
  assert.match(setup.stderr, /only for Windsurf/);
});

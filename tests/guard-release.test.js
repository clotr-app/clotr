"use strict";
/* global require, process, __dirname, console */

// Guard 0.1.1: the `mcp` subcommand that `npx clotr-guard` needs, plain errors for a mistyped tool or option, a clean
// check that says so in a terminal, and the package, registry and plugin files that list Guard in more places.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { build } = require("../tools/engine-bundle.js");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(ROOT, "apps", "guard");
const CLI = path.join(GUARD, "bin", "clotr-guard.js");
const ENGINE_PATH = path.join(GUARD, "dist", "clotr-engine.js");
const bundle = build().text;
if (!fs.existsSync(ENGINE_PATH) || fs.readFileSync(ENGINE_PATH, "utf8") !== bundle) {
  fs.mkdirSync(path.dirname(ENGINE_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_PATH, bundle);
}
const guardPackage = () => JSON.parse(fs.readFileSync(path.join(GUARD, "package.json"), "utf8"));

// A home folder of the test's own, so nothing here can touch the real assistants' settings.
function run(args, input = "") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-release-"));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      input,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLOTR_GUARD_DATA_DIR: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function rpc(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
}

test("clotr-guard mcp runs the MCP server on stdio, the same one clotr-mcp starts", () => {
  const input = `${[
    rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }, 1),
    rpc("notifications/initialized", {}),
    rpc("tools/list", {}, 2),
  ].join("\n")}\n`;
  const viaGuard = run(["mcp"], input);
  assert.equal(viaGuard.status, 0, viaGuard.stderr);
  assert.equal(viaGuard.stderr, "");
  const replies = viaGuard.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0].result.serverInfo, { name: "clotr", version: guardPackage().version });
  assert.deepEqual(
    replies[1].result.tools.map((tool) => tool.name),
    ["check_text", "clean_text", "is_secret_file"],
  );
  const viaMcp = spawnSync(process.execPath, [path.join(GUARD, "bin", "clotr-mcp.js")], { input, encoding: "utf8" });
  assert.equal(viaGuard.stdout, viaMcp.stdout);

  const config = run(["mcp", "--print-config", "claude"]);
  assert.equal(config.status, 0, config.stderr);
  assert.deepEqual(JSON.parse(config.stdout).mcpServers.clotr.args, [path.join(GUARD, "bin", "clotr-mcp.js")]);
});

test("a tool Guard doesn't know exits 2 and names the ones it does", () => {
  for (const action of ["setup", "remove"]) {
    const result = run([action, "copilot"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unknown tool 'copilot'. Choose claude, cursor, gemini, codex, windsurf or cline.\n");
  }
  const missing = run(["setup"]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr, "Choose claude, cursor, gemini, codex, windsurf or cline.\n");
  const cline = run(["setup", "cline"]);
  if (process.platform === "win32") {
    assert.equal(cline.status, 2);
    assert.equal(cline.stderr, "Cline hooks are supported on macOS and Linux only.\n");
  } else {
    assert.equal(cline.status, 0, cline.stderr);
    assert.match(cline.stdout, /Set up cline hook at .*Documents[\\/]Cline[\\/]Hooks/);
  }
});

test("a mistyped option exits 2 and points at --help instead of sounding like an engine failure", () => {
  const check = run(["check", "--min-severty", "low"], "A clean prompt");
  assert.equal(check.status, 2);
  assert.equal(check.stdout, "");
  assert.equal(check.stderr, "Unknown option --min-severty. Run clotr-guard --help.\n");

  const setup = run(["setup", "claude", "--dryrun"]);
  assert.equal(setup.status, 2);
  assert.equal(setup.stderr, "Unknown option --dryrun. Run clotr-guard --help.\n");

  const commit = run(["commit-check", "--personal"]);
  assert.equal(commit.status, 2);
  assert.equal(commit.stderr, "Unknown option --personal. Run clotr-guard --help.\n");

  // The options Guard does know still work, and a hook never stops a prompt over an option.
  assert.equal(run(["check", "--min-severity", "low", "--json"], "A clean prompt").status, 0);
  const hook = run(["hook", "codex", "--min-severity", "medium", "--made-up"], JSON.stringify({ prompt: "hi" }));
  assert.equal(hook.status, 0);
});

async function checkIn(isTTY, args, input) {
  const { main } = require(CLI);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-tty-"));
  const file = path.join(dir, "prompt.txt");
  fs.writeFileSync(file, input);
  const lines = [];
  const log = console.log;
  const own = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    const code = await main([...args, file], { cwd: dir });
    return { code, lines };
  } finally {
    console.log = log;
    if (own) Object.defineProperty(process.stdout, "isTTY", own);
    else delete process.stdout.isTTY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a clean check says Nothing found. in a terminal and stays silent when piped", async () => {
  assert.deepEqual(await checkIn(true, ["check"], "Write a small sorting function."), {
    code: 0,
    lines: ["Nothing found."],
  });
  assert.deepEqual(await checkIn(false, ["check"], "Write a small sorting function."), { code: 0, lines: [] });
  const json = await checkIn(true, ["check", "--json"], "Write a small sorting function.");
  assert.equal(json.lines.length, 1);
  assert.equal(JSON.parse(json.lines[0]).decision, "allow");
  const found = await checkIn(true, ["check"], "key AKIA4HPQ7XZ2R6TWLJ3N");
  assert.equal(found.code, 1);
  assert.equal(found.lines.includes("Nothing found."), false);
  assert.equal(run(["check"], "A clean prompt").stdout, "");
});

test("Guard 0.1.1 and the engine carry keywords, Guard's own folder and homepage, and the MCP registry name", () => {
  const guard = guardPackage();
  assert.equal(guard.version, "0.1.1");
  assert.deepEqual(guard.keywords, [
    "secrets",
    "credentials",
    "pii",
    "ai",
    "claude-code",
    "cursor",
    "gemini-cli",
    "codex-cli",
    "windsurf",
    "cline",
    "mcp",
    "pre-commit",
    "privacy",
  ]);
  assert.deepEqual(guard.repository, {
    type: "git",
    url: "https://github.com/clotr-app/clotr",
    directory: "apps/guard",
  });
  assert.equal(guard.homepage, "https://github.com/clotr-app/clotr/tree/main/apps/guard#readme");
  assert.equal(guard.mcpName, "io.github.clotr-app/clotr-guard");
  assert.deepEqual(guard.bin, {
    "clotr-guard": "bin/clotr-guard.js",
    "clotr-mcp": "bin/clotr-mcp.js",
  });
  // The registry and the plugin have their own channels, so neither file goes into the npm tarball.
  assert.equal(guard.files.includes("plugin"), false);
  assert.equal(guard.files.includes("server.json"), false);

  const engine = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "engine", "package.json"), "utf8"));
  assert.deepEqual(engine.keywords, ["pii", "secrets", "detection", "redaction", "privacy"]);
  const readme = fs.readFileSync(path.join(ROOT, "apps", "engine", "README.md"), "utf8");
  assert.match(readme, /npm install clotr-engine/);
  assert.match(readme, /index\.d\.ts/);
  assert.match(readme, /AGPL-3\.0-or-later/);
  assert.match(readme, /https:\/\/github\.com\/clotr-app\/clotr/);
});

test("Guard's README gives a working pre-commit config, the npx forms and every print-config host", () => {
  const readme = fs.readFileSync(path.join(GUARD, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\.pre-commit-hooks\.yaml/);
  assert.match(readme, /`\.pre-commit-config\.yaml`/);
  assert.match(
    readme,
    /repos:\n {2}- repo: local\n {4}hooks:\n {6}- id: clotr-guard\n {8}name: Check staged changes with Clotr Guard\n {8}entry: clotr-guard commit-check\n {8}language: system\n {8}pass_filenames: false\n {8}always_run: true\n/,
  );
  assert.ok(readme.includes("`--json` prints the result object, including its decision and masked findings."));
  assert.ok(
    readme.includes(
      "Hook setup and `clotr-mcp --print-config` stop when run through npx, and tell you to install Guard globally first.",
    ),
  );
  assert.match(readme, /npx -y clotr-guard mcp/);
  assert.match(readme, /clotr-guard mcp\b/);
  assert.match(readme, /clotr-mcp --print-config cline/);
  assert.match(readme, /clotr-guard setup cline/);
  assert.match(readme, /Enable Hooks/);
  assert.match(readme, /Cline hooks are supported on macOS and Linux only/);
  assert.equal(run(["mcp", "--print-config", "cline"]).status, 0);
});

test("server.json is ready for the MCP registry and matches the package", () => {
  const guard = guardPackage();
  const server = JSON.parse(fs.readFileSync(path.join(GUARD, "server.json"), "utf8"));
  assert.equal(server.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(server.name, guard.mcpName);
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(server.name.length >= 3 && server.name.length <= 200);
  assert.equal(server.version, guard.version);
  assert.ok(
    server.description.length > 0 && server.description.length <= 100,
    "the registry caps a description at 100 characters",
  );
  assert.ok(server.title.length > 0 && server.title.length <= 100);
  assert.deepEqual(server.repository, {
    url: "https://github.com/clotr-app/clotr",
    source: "github",
    subfolder: "apps/guard",
  });
  assert.equal(server.packages.length, 1);
  const [npm] = server.packages;
  assert.equal(npm.registryType, "npm");
  assert.equal(npm.identifier, guard.name);
  assert.equal(npm.version, guard.version);
  assert.notEqual(npm.version, "latest");
  assert.match(npm.registryBaseUrl, /^https:\/\//);
  assert.equal(npm.runtimeHint, "npx");
  assert.deepEqual(npm.transport, { type: "stdio" });
  assert.deepEqual(npm.packageArguments, [{ type: "positional", value: "mcp" }]);
  assert.equal(server.repository.subfolder.startsWith("/"), false);
  assert.equal(server.repository.subfolder.includes(".."), false);
});

test("the Claude Code plugin registers the same prompt hook setup writes, through npx", () => {
  const guard = guardPackage();
  const plugin = JSON.parse(fs.readFileSync(path.join(GUARD, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "clotr-guard");
  assert.equal(plugin.version, guard.version);
  assert.equal(plugin.license, guard.license);
  assert.equal(plugin.repository, guard.repository.url);
  assert.ok(plugin.description && plugin.author?.name);

  const hooks = JSON.parse(fs.readFileSync(path.join(GUARD, "plugin", "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), ["UserPromptSubmit"]);
  const { mergeHook } = require(CLI);
  const written = mergeHook({}, "claude").hooks.UserPromptSubmit;
  const [handler] = hooks.hooks.UserPromptSubmit[0].hooks;
  assert.equal(handler.type, written[0].hooks[0].type);
  assert.equal(handler.timeout, written[0].hooks[0].timeout);
  // The plugin uses npx because it doesn't have a stable local script path; its action and options match setup's
  // direct command and args form.
  const [command] = written[0].hooks;
  assert.equal(handler.command, `npx -y clotr-guard@${guard.version} ${command.args.slice(1).join(" ")}`);
  assert.deepEqual(command.args.slice(1), ["hook", "claude", "--min-severity", "medium"]);
  const readme = fs.readFileSync(path.join(GUARD, "plugin", "README.md"), "utf8");
  assert.ok(readme.includes(`npx -y clotr-guard@${guard.version} --version`), "the README warms the same version");
});

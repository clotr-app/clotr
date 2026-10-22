"use strict";
/* global require, process, __dirname */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");
const { retrySlow } = require("./timing.js");
const { build } = require("../tools/engine-bundle.js");
const ENGINE_PATH = path.join(__dirname, "../apps/guard/dist/clotr-engine.js");
const BUNDLE = build().text;
if (fs.existsSync(ENGINE_PATH)) {
  assert.equal(fs.readFileSync(ENGINE_PATH, "utf8"), BUNDLE, "guard engine bundle is stale");
} else {
  fs.mkdirSync(path.dirname(ENGINE_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_PATH, BUNDLE);
}
const { check, findingsFromDetections } = require("../apps/guard/lib/engine.js");
const {
  parseClotrIgnore,
  readClotrIgnore,
  valueFingerprint,
  pathIgnored,
  pathIgnoredForFile,
} = require("../apps/guard/lib/clotrignore.js");
const {
  inspectPrompt,
  inspectRead,
  hookOutput,
  readHookOutput,
  boundaryOutput,
  inspectShell,
  inspectTool,
  updateSettings,
  updateClineHooks,
  toolSettingsPath,
  checkStaged,
  setupGit,
  main,
  mergeHook,
  isNpxCachePath,
  formatCommitIssue,
  managedHooks,
  TOOL_NAMES,
} = require("../apps/guard/bin/clotr-guard.js");

const AWS_KEY = "AKIA4HPQ7XZ2R6TWLJ3N";
const CARD_NUMBER = "4111 1111 1111 1111";
const PROMPT = `Use this key ${AWS_KEY} and card ${CARD_NUMBER}`;
const TOOLS = ["claude", "cursor", "gemini", "codex"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-"));
}

function npmRun(args, cwd, tempRoot) {
  if (process.platform !== "win32") return spawnSync("npm", args, { cwd, encoding: "utf8" });
  const batch = path.join(tempRoot, "npm-command.cmd");
  const quote = (value) => (/\s/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  fs.writeFileSync(batch, `@echo off\r\nnpm ${args.map(quote).join(" ")}\r\nexit /b %ERRORLEVEL%\r\n`);
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", batch], { cwd, encoding: "utf8" });
}

function packGuard(tempRoot) {
  const packageRoot = path.resolve(__dirname, "../apps/guard");
  const result = npmRun(["pack", "--pack-destination", tempRoot], packageRoot, tempRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const tarball = path.join(tempRoot, "clotr-guard-0.1.0.tgz");
  assert.equal(fs.existsSync(tarball), true, `${result.stdout}\n${result.stderr}`);
  return tarball;
}

function installGuard(prefix, tarball) {
  fs.mkdirSync(prefix, { recursive: true });
  const result = npmRun(
    ["install", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, tarball],
    path.dirname(prefix),
    path.dirname(prefix),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return path.join(prefix, "node_modules", "clotr-guard", "bin", "clotr-guard.js");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function initGit(cwd) {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Guard Test"]);
  git(cwd, ["config", "user.email", "guard-test@example.invalid"]);
}

test("guard engine bundle is current and check returns only masked findings", () => {
  assert.equal(fs.readFileSync(ENGINE_PATH, "utf8"), BUNDLE);
  assert.deepEqual(check("Write a small sorting function."), { findings: [], decision: "allow" });
  const result = check(PROMPT);
  assert.equal(result.decision, "block");
  assert.ok(result.findings.some((finding) => finding.kind === "aws_access_key"));
  assert.ok(result.findings.some((finding) => finding.kind === "credit_card"));
  for (const finding of result.findings) {
    assert.ok(finding.masked);
    assert.ok(Number.isInteger(finding.start) && finding.start >= 0);
    assert.ok(finding.end > finding.start);
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(AWS_KEY), false);
  assert.equal(serialized.includes(CARD_NUMBER), false);
});

test("check command prints masked findings only and uses the requested exit codes", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const clean = spawnSync(process.execPath, [script, "check"], { input: "A clean prompt", encoding: "utf8" });
  assert.equal(clean.status, 0);
  const found = spawnSync(process.execPath, [script, "check"], { input: PROMPT, encoding: "utf8" });
  assert.equal(found.status, 1);
  assert.match(found.stdout, /aws_access_key:/);
  assert.match(found.stdout, /credit_card:/);
  assert.equal(found.stdout.includes(AWS_KEY), false);
  assert.equal(found.stdout.includes(CARD_NUMBER), false);
  const json = spawnSync(process.execPath, [script, "check", "--json"], { input: PROMPT, encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout).decision, "block");
  assert.equal(json.stdout.includes(AWS_KEY), false);
  const lowDefault = spawnSync(process.execPath, [script, "check"], {
    input: "Email hello@example.com",
    encoding: "utf8",
  });
  assert.equal(lowDefault.status, 0);
  assert.match(lowDefault.stderr, /details below the stop level/);
  const lowEnabled = spawnSync(process.execPath, [script, "check", "--min-severity", "low"], {
    input: "Email hello@example.com",
    encoding: "utf8",
  });
  assert.equal(lowEnabled.status, 1);
  assert.match(lowEnabled.stdout, /email:/);
});

test("installed Guard copies handle spaced paths and share one removable hook", () => {
  const root = tempDir();
  const home = path.join(root, "installed Guard copy");
  const sharedHome = path.join(root, "shared settings");
  const file = path.join(sharedHome, ".claude", "settings.json");
  const original = '{\n    "theme": "fixture",\n    "allowedTools": ["Read", "Write"]\n}\n';
  try {
    const tarball = packGuard(root);
    const copies = [installGuard(home, tarball), installGuard(path.join(root, "second installed Guard"), tarball)];
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const setup = spawnSync(process.execPath, [copies[0], "setup", "claude"], {
      cwd: home,
      encoding: "utf8",
      env,
    });
    assert.equal(setup.status, 0, setup.stderr);
    const smokeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    const command = smokeSettings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.includes(home));
    const batch = path.join(root, "run-hook.cmd");
    if (process.platform === "win32") {
      fs.writeFileSync(batch, `@echo off\r\n${command}\r\nexit /b %ERRORLEVEL%\r\n`);
    }
    const shell =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", batch], {
            input: JSON.stringify({ prompt: PROMPT }),
            encoding: "utf8",
            env: { ...env, CLOTR_GUARD_DATA_DIR: path.join(root, "data") },
          })
        : spawnSync("sh", ["-c", command], {
            input: JSON.stringify({ prompt: PROMPT }),
            encoding: "utf8",
            env: { ...env, CLOTR_GUARD_DATA_DIR: path.join(root, "data") },
          });
    assert.equal(shell.status, 2, `${shell.stdout}\n${shell.stderr}`);
    assert.match(shell.stderr, /within 2 minutes/);
    assert.equal(`${shell.stdout}${shell.stderr}`.includes(AWS_KEY), false);

    const sharedEnv = { ...process.env, USERPROFILE: sharedHome, HOME: sharedHome };
    for (const removeCopy of copies) {
      fs.rmSync(sharedHome, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
      for (const script of copies) {
        const added = spawnSync(process.execPath, [script, "setup", "claude"], {
          cwd: sharedHome,
          encoding: "utf8",
          env: sharedEnv,
        });
        assert.equal(added.status, 0, added.stderr);
      }
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      const handlers = settings.hooks.UserPromptSubmit.flatMap((group) => group.hooks || []);
      assert.equal(
        handlers.filter((hook) => hook.command?.includes("clotr-guard.js") && hook.command.includes("hook claude"))
          .length,
        1,
      );
      const removed = spawnSync(process.execPath, [removeCopy, "remove", "claude"], {
        cwd: sharedHome,
        encoding: "utf8",
        env: sharedEnv,
      });
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      assert.equal(fs.existsSync(`${file}.clotr-guard.bak`), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings setup and removal round-trip known file shapes", () => {
  const fixtures = [
    { name: "compact", raw: '{"theme":"fixture","allowedTools":["Read","Write"]}' },
    {
      name: "four-space with inline arrays",
      raw: '{\n    "theme": "fixture",\n    "allowedTools": ["Read", "Write"]\n}\n',
    },
    { name: "no file", expected: "{}\n" },
  ];
  for (const fixture of fixtures) {
    const home = tempDir();
    try {
      const file = toolSettingsPath("claude", { home });
      if (fixture.raw !== undefined) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, fixture.raw);
      }
      updateSettings("claude", { home });
      updateSettings("claude", { home, remove: true });
      assert.equal(fs.readFileSync(file, "utf8"), fixture.expected ?? fixture.raw, fixture.name);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("random and oversized hook input use the fail-open message", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const random = spawnSync(process.execPath, [script, "hook", "claude"], {
    input: crypto.randomBytes(4 * 1024),
    encoding: "utf8",
    maxBuffer: 4096,
  });
  assert.equal(random.status, 0, random.stderr);
  assert.match(`${random.stdout}${random.stderr}`, /couldn't check this prompt/);

  const prompt = JSON.stringify({ prompt: "x".repeat(10 * 1024 * 1024) });
  retrySlow(() => {
    const started = process.hrtime.bigint();
    const large = spawnSync(process.execPath, [script, "hook", "claude"], {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 4096,
    });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(large.status, 0, large.stderr);
    assert.match(`${large.stdout}${large.stderr}`, /couldn't check this prompt/);
    assert.ok(Buffer.byteLength(large.stdout) < 4096);
    assert.ok(Buffer.byteLength(large.stderr) < 4096);
    return elapsed < 5000 ? undefined : `the 10 MB prompt took ${elapsed.toFixed(1)} ms`;
  });
});

test("each tool's stdin hook has its documented block and clean output", () => {
  const expected = {
    claude: (output) => output.code === 2 && output.stderr.includes("within 2 minutes"),
    cursor: (output) => JSON.parse(output.stdout).continue === false,
    gemini: (output) => JSON.parse(output.stdout).decision === "deny",
    codex: (output) => JSON.parse(output.stdout).decision === "block",
  };
  const dir = tempDir();
  try {
    for (const tool of TOOLS) {
      const result = inspectPrompt(tool, PROMPT, { dataDir: path.join(dir, tool), now: 50_000 });
      assert.equal(result.action, "block", tool);
      assert.equal(expected[tool](hookOutput(tool, result)), true, tool);
      const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
      const sample = spawnSync(process.execPath, [script, "hook", tool], {
        input: JSON.stringify({ prompt: PROMPT }),
        encoding: "utf8",
        env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, `stdin-${tool}`) },
      });
      assert.equal(sample.status, tool === "claude" ? 2 : 0, tool);
      assert.equal(expected[tool]({ code: sample.status, stdout: sample.stdout, stderr: sample.stderr }), true, tool);
      const clean = hookOutput(
        tool,
        inspectPrompt(tool, "Write a function", { dataDir: path.join(dir, `clean-${tool}`) }),
      );
      if (tool === "claude") assert.equal(clean.code, 0);
      else if (tool === "cursor") assert.equal(JSON.parse(clean.stdout).continue, true);
      else assert.deepEqual(JSON.parse(clean.stdout), {});
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same prompt can pass during two minutes, then expires, with no prompt in its state file", () => {
  const dir = tempDir();
  const stateFile = path.join(dir, "prompt-repeat.json");
  try {
    assert.equal(inspectPrompt("claude", PROMPT, { dataDir: dir, now: 10_000 }).action, "block");
    const saved = fs.readFileSync(stateFile, "utf8");
    assert.equal(saved.includes(PROMPT), false);
    assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ["at", "hash", "salt"]);
    assert.equal(inspectPrompt("claude", PROMPT, { dataDir: dir, now: 129_999 }).action, "allow");
    assert.equal(inspectPrompt("claude", PROMPT, { dataDir: dir, now: 130_000 }).action, "block");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("medium is the default stop threshold and low findings pass with a brief note", () => {
  const dir = tempDir();
  try {
    const low = "Email me at hello@example.com";
    const result = inspectPrompt("claude", low, { dataDir: dir, now: 70_000, includePersonalDetails: true });
    assert.equal(result.action, "allow");
    assert.equal(result.belowMinimumOnly, true);
    assert.match(hookOutput("claude", result).stderr, /details below the stop level/);
    assert.equal(JSON.parse(hookOutput("cursor", result).stdout).continue, true);
    assert.equal(JSON.parse(readHookOutput("cursor", result).stdout).permission, "allow");
    const stopped = inspectPrompt("claude", `Use ${AWS_KEY} and email hello@example.com`, {
      dataDir: dir,
      now: 71_000,
      includePersonalDetails: true,
    });
    assert.equal(stopped.action, "block");
    assert.ok(stopped.findings.every((finding) => finding.severity !== "low"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The assistant would make the second read, not the person, so Claude Code asks the person and a repeat never passes.
test("read hooks inspect bounded text, ask the person with masked findings, and never pass on a repeat", () => {
  const dir = tempDir();
  const file = path.join(dir, "private.txt");
  try {
    fs.writeFileSync(file, `Use this key ${AWS_KEY}`);
    const event = { tool_name: "Read", tool_input: { file_path: file } };
    const blocked = inspectRead("claude", event, { dataDir: dir, now: 50_000 });
    assert.equal(blocked.action, "block");
    assert.doesNotMatch(JSON.stringify(readHookOutput("claude", blocked)), new RegExp(AWS_KEY));
    assert.match(readHookOutput("claude", blocked).stdout, /Allow the read only if/);
    assert.equal(JSON.parse(readHookOutput("gemini", blocked).stdout).decision, "deny");
    assert.doesNotMatch(readHookOutput("gemini", blocked).stdout, /again/);
    const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
    const hooked = spawnSync(process.execPath, [script, "read", "claude"], {
      input: JSON.stringify(event),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "read-cli") },
    });
    assert.equal(hooked.status, 0);
    assert.equal(JSON.parse(hooked.stdout).hookSpecificOutput.permissionDecision, "ask");
    assert.equal(inspectRead("claude", event, { dataDir: dir, now: 51_000 }).action, "block");
    assert.equal(inspectRead("claude", event, { dataDir: dir, now: 170_000 }).action, "block");
    fs.writeFileSync(file, `Use this key ${AWS_KEY}\0`);
    assert.equal(inspectRead("claude", event, { dataDir: dir }).skipped, true);
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.equal(inspectRead("claude", event, { dataDir: dir }).skipped, true);
    fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    const large = inspectRead("claude", event, { dataDir: dir });
    assert.equal(large.action, "allow");
    assert.equal(large.partial, true);
    assert.match(readHookOutput("claude", large).stdout, /rest of the file wasn't checked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("large reads check the first 256 KiB and name the unchecked remainder once", () => {
  const dir = tempDir();
  const file = path.join(dir, "large.txt");
  const content = `Use ${AWS_KEY}\n${"x".repeat(256 * 1024)}`;
  try {
    fs.writeFileSync(file, content);
    const blocked = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { dataDir: dir });
    assert.equal(blocked.action, "block");
    assert.equal(blocked.partial, true);
    const blockOutput = JSON.stringify(readHookOutput("claude", blocked));
    assert.match(blockOutput, /Clotr checked the first 256 KiB; the rest of the file wasn't checked\./);
    assert.equal((blockOutput.match(/rest of the file wasn't checked/g) || []).length, 1);

    const cleanFile = path.join(dir, "clean-large.txt");
    fs.writeFileSync(cleanFile, "x".repeat(256 * 1024 + 1));
    const clean = inspectRead(
      "cursor",
      { file_path: cleanFile, content: "x".repeat(256 * 1024 + 1) },
      { dataDir: dir },
    );
    assert.equal(clean.action, "allow");
    assert.equal(clean.partial, true);
    const cleanOutput = JSON.stringify(readHookOutput("cursor", clean));
    assert.match(cleanOutput, /user_message.*rest of the file wasn't checked/);
    assert.equal((cleanOutput.match(/rest of the file wasn't checked/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check refuses a file over 1 MiB with its usual safe error", async () => {
  const dir = tempDir();
  const file = path.join(dir, "large.txt");
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    const result = spawnSync(process.execPath, [script, "check", file], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Clotr couldn't check this text.\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read hooks deny a normal-looking symlink to a secret file", (t) => {
  const dir = tempDir();
  const secret = path.join(dir, ".env");
  const alias = path.join(dir, "settings.txt");
  try {
    fs.writeFileSync(secret, "A made-up secret value");
    try {
      fs.symlinkSync(secret, alias);
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("file symlinks are unavailable here");
        return;
      }
      throw error;
    }
    const result = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: alias } });
    assert.equal(result.secretFile, true);
    assert.match(readHookOutput("claude", result).stdout, /permissionDecision":"deny"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read hooks classify the resolved path when a normal-looking name resolves to a secret", () => {
  const dir = tempDir();
  const alias = path.join(dir, "settings.txt");
  const resolvedSecret = path.join(dir, ".env");
  fs.writeFileSync(alias, "made-up harmless fixture");
  const realpath = fs.realpathSync;
  fs.realpathSync = (candidate, ...args) =>
    candidate === alias ? resolvedSecret : realpath.call(fs, candidate, ...args);
  let result;
  try {
    result = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: alias } });
  } finally {
    fs.realpathSync = realpath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(result.secretFile, true);
});

test("assistant setup refuses symlinked settings targets and parent folders", (t) => {
  const dir = tempDir();
  try {
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, '{"theme":"keep"}\n');
    const cursorDir = path.join(dir, ".cursor");
    fs.mkdirSync(cursorDir);
    try {
      fs.symlinkSync(outside, path.join(cursorDir, "hooks.json"));
      assert.throws(() => updateSettings("cursor", { home: dir }), /symbolic-link/);
      assert.equal(fs.readFileSync(outside, "utf8"), '{"theme":"keep"}\n');
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      t.diagnostic("file symlinks are unavailable here; checking a linked settings directory instead");
    }

    fs.rmSync(path.join(cursorDir, "hooks.json"), { force: true });
    fs.writeFileSync(path.join(cursorDir, "hooks.json"), '{"theme":"keep"}\n');
    try {
      fs.symlinkSync(outside, path.join(cursorDir, "hooks.json.clotr-guard.bak"));
      assert.throws(() => updateSettings("cursor", { home: dir }), /symbolic-link/);
      assert.equal(fs.readFileSync(outside, "utf8"), '{"theme":"keep"}\n');
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      t.diagnostic("file symlinks are unavailable here; backup symlink check is skipped");
    }

    const alternate = path.join(dir, "alternate");
    fs.mkdirSync(alternate);
    const gemini = path.join(alternate, "settings.json");
    fs.writeFileSync(gemini, "{}\n");
    fs.rmSync(path.join(dir, ".gemini"), { recursive: true, force: true });
    try {
      fs.symlinkSync(alternate, path.join(dir, ".gemini"), "junction");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("directory junctions are unavailable here");
        return;
      }
      throw error;
    }
    assert.throws(() => updateSettings("gemini", { home: dir }), /symbolic-link/);
    assert.equal(fs.readFileSync(gemini, "utf8"), "{}\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cursor, Gemini and Codex read hooks use documented tool inputs", () => {
  const dir = tempDir();
  const file = path.join(dir, "private.txt");
  try {
    fs.writeFileSync(file, `Use this key ${AWS_KEY}`);
    const cursor = inspectRead(
      "cursor",
      { file_path: file, content: `Use this key ${AWS_KEY}` },
      { dataDir: path.join(dir, "cursor") },
    );
    assert.equal(JSON.parse(readHookOutput("cursor", cursor).stdout).permission, "deny");
    const gemini = inspectRead(
      "gemini",
      { tool_name: "read_file", tool_input: { absolute_path: file } },
      { dataDir: path.join(dir, "gemini") },
    );
    assert.equal(JSON.parse(readHookOutput("gemini", gemini).stdout).decision, "deny");
    const codex = inspectRead(
      "codex",
      { tool_name: "mcp__filesystem__read_file", tool_input: { path: file } },
      { dataDir: path.join(dir, "codex") },
    );
    assert.equal(JSON.parse(readHookOutput("codex", codex).stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windsurf and Cline hooks stop prompts and file reads using their documented payloads", () => {
  const dir = tempDir();
  const file = path.join(dir, "ordinary.txt");
  try {
    fs.writeFileSync(file, `Use this key ${AWS_KEY}`);
    for (const tool of ["windsurf", "cline"]) {
      const prompt =
        tool === "windsurf" ? { tool_info: { user_prompt: PROMPT } } : { userPromptSubmit: { prompt: PROMPT } };
      const input =
        tool === "windsurf"
          ? spawnSync(process.execPath, [path.join(__dirname, "../apps/guard/bin/clotr-guard.js"), "hook", tool], {
              input: JSON.stringify(prompt),
              encoding: "utf8",
              env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, tool) },
            })
          : hookOutput(
              tool,
              inspectPrompt(tool, prompt.userPromptSubmit.prompt, { dataDir: path.join(dir, tool), now: 50_000 }),
            );
      if (tool === "windsurf") {
        assert.equal(input.status, 2);
        assert.match(input.stderr, /within 2 minutes/);
      } else {
        assert.equal(JSON.parse(input.stdout).cancel, true);
        assert.match(input.stdout, /within 2 minutes/);
      }
      const readEvent =
        tool === "windsurf"
          ? { agent_action_name: "pre_read_code", tool_info: { file_path: file } }
          : { preToolUse: { toolName: "read_file", parameters: { path: file } } };
      const read = inspectRead(tool, readEvent, { dataDir: path.join(dir, `${tool}-read`) });
      assert.equal(read.action, "block", tool);
      const readOutput = readHookOutput(tool, read);
      assert.doesNotMatch(JSON.stringify(readOutput), new RegExp(AWS_KEY));
      if (tool === "windsurf") assert.equal(readOutput.code, 2);
      else assert.equal(JSON.parse(readOutput.stdout).cancel, true);
      const secret = inspectRead(
        tool,
        tool === "windsurf"
          ? { agent_action_name: "pre_read_code", tool_info: { file_path: path.join(dir, ".env") } }
          : { preToolUse: { parameters: { path: path.join(dir, ".env") } } },
      );
      assert.equal(secret.secretFile, true, tool);
      const secretOutput = readHookOutput(tool, secret);
      assert.match(JSON.stringify(secretOutput), /variable names or the example file/);
      if (tool === "windsurf") assert.equal(secretOutput.code, 2);
      else assert.equal(JSON.parse(secretOutput.stdout).cancel, true);
      const repeatDir = path.join(dir, `${tool}-repeat`);
      assert.equal(inspectPrompt(tool, PROMPT, { dataDir: repeatDir, now: 50_000 }).action, "block");
      assert.equal(inspectPrompt(tool, PROMPT, { dataDir: repeatDir, now: 51_000 }).action, "allow");
      const allowed = inspectPrompt(tool, "A clean prompt", { dataDir: path.join(dir, `${tool}-clean`) });
      assert.equal(allowed.action, "allow", tool);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windsurf settings and Cline hook files can be set up and removed", () => {
  const dir = tempDir();
  const original = { hooks: { pre_user_prompt: [{ command: "keep this" }] }, theme: "dark" };
  try {
    const windsurf = toolSettingsPath("windsurf", { home: dir });
    fs.mkdirSync(path.dirname(windsurf), { recursive: true });
    fs.writeFileSync(windsurf, JSON.stringify(original));
    const added = updateSettings("windsurf", { home: dir });
    assert.equal(added.changed, true);
    assert.equal(added.settings.hooks.pre_user_prompt[0].command, "keep this");
    assert.equal(added.settings.hooks.pre_user_prompt.length, 2);
    assert.ok(added.settings.hooks.pre_read_code);
    assert.ok(fs.existsSync(`${windsurf}.clotr-guard.bak`));
    updateSettings("windsurf", { home: dir, remove: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(windsurf, "utf8")).hooks, original.hooks);

    const clineDir = path.join(dir, "Documents", "Cline", "Hooks");
    const cline = updateClineHooks({ home: dir, platform: "linux" });
    assert.equal(cline.changed, true);
    assert.ok(fs.existsSync(path.join(clineDir, "UserPromptSubmit")));
    assert.ok(fs.existsSync(path.join(clineDir, "PreToolUse")));
    assert.match(fs.readFileSync(path.join(clineDir, "PreToolUse"), "utf8"), /read.*cline/);
    updateClineHooks({ home: dir, platform: "linux", remove: true });
    assert.equal(fs.existsSync(path.join(clineDir, "UserPromptSubmit")), false);
    assert.equal(fs.existsSync(path.join(clineDir, "PreToolUse")), false);
    assert.throws(() => updateClineHooks({ home: dir, platform: "win32" }), /unsupported-on-windows/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cline hook setup is unavailable in this release and leaves its settings alone", async () => {
  const home = tempDir();
  const oldProfile = process.env.USERPROFILE;
  const oldHome = process.env.HOME;
  const errors = [];
  const error = console.error;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    assert.equal(TOOL_NAMES.includes("cline"), false);
    assert.equal(await main(["setup", "cline"], { cwd: home }), 2);
    assert.deepEqual(errors, ["Cline is not available in this release."]);
    assert.deepEqual(fs.readdirSync(home), []);
    const help = spawnSync(process.execPath, [path.join(__dirname, "../apps/guard/bin/clotr-guard.js"), "--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stdout, /\bcline\b/i);
  } finally {
    console.error = error;
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("staged checks read a UTF-16 file Git calls binary, and only its new lines", () => {
  const dir = tempDir();
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  try {
    initGit(dir);
    // What Windows PowerShell 5.1's ">" writes: UTF-16LE with a byte order mark and CRLF lines.
    fs.writeFileSync(path.join(dir, "env-dump.txt"), utf16(`PATH=C:\\Windows\r\nKEY=${AWS_KEY}\r\n`));
    git(dir, ["add", "env-dump.txt"]);
    const added = checkStaged({ cwd: dir }).issues;
    assert.deepEqual(
      added.map((issue) => [issue.file, issue.line, issue.kind]),
      [["env-dump.txt", 2, "aws_access_key"]],
    );
    assert.doesNotMatch(JSON.stringify(added), new RegExp(AWS_KEY));
    // Without a byte order mark too.
    git(dir, ["reset", "-q"]);
    fs.writeFileSync(path.join(dir, "env-dump.txt"), Buffer.from(`KEY=${AWS_KEY}\r\n`, "utf16le"));
    git(dir, ["add", "env-dump.txt"]);
    assert.equal(checkStaged({ cwd: dir }).issues[0]?.kind, "aws_access_key");
    // A key already committed isn't reported again when another line changes.
    git(dir, ["commit", "-qm", "dump", "--no-verify"]);
    fs.writeFileSync(path.join(dir, "env-dump.txt"), Buffer.from(`KEY=${AWS_KEY}\r\nTEMP=C:\\Temp\r\n`, "utf16le"));
    git(dir, ["add", "env-dump.txt"]);
    assert.deepEqual(checkStaged({ cwd: dir }).issues, []);
    // A real binary file still passes without a read.
    fs.writeFileSync(
      path.join(dir, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0xff, 0x00, 0x13]),
    );
    git(dir, ["add", "logo.png"]);
    assert.deepEqual(checkStaged({ cwd: dir }).issues, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A UTF-16 file was read only up to 256 KiB, and not at all past Git's 16 MiB buffer, and neither stopped the commit,
// while a UTF-8 file that size is checked whole or stops it.
test("staged checks read a large UTF-16 file whole, and stop one too big to read", () => {
  const dir = tempDir();
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  try {
    initGit(dir);
    fs.writeFileSync(path.join(dir, "env-dump.txt"), utf16(`${"X=1\r\n".repeat(32_000)}KEY=${AWS_KEY}\r\n`));
    git(dir, ["add", "env-dump.txt"]);
    assert.deepEqual(
      checkStaged({ cwd: dir }).issues.map((issue) => [issue.line, issue.kind]),
      [[32_001, "aws_access_key"]],
    );
    git(dir, ["reset", "-q"]);
    fs.writeFileSync(path.join(dir, "env-dump.txt"), utf16(`KEY=${AWS_KEY}\r\n${"X=1\r\n".repeat(1_700_000)}`));
    git(dir, ["add", "env-dump.txt"]);
    const kinds = checkStaged({ cwd: dir }).issues.map((issue) => issue.kind);
    assert.deepEqual(kinds.sort(), ["aws_access_key", "staged_diff_partial"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("staged checks stop secret files, allow environment references, and mask credential additions", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(dir, ".env"), `KEY=${AWS_KEY}\n`);
    git(dir, ["add", ".gitignore"]);
    git(dir, ["add", "-f", ".env"]);
    const forced = checkStaged({ cwd: dir }).issues;
    assert.deepEqual(
      forced.map((issue) => [issue.file, issue.line, issue.kind]),
      [[".env", 0, "secret_file"]],
    );
    assert.doesNotMatch(JSON.stringify(forced), new RegExp(AWS_KEY));
    git(dir, ["reset", "-q"]);
    fs.writeFileSync(path.join(dir, ".gitignore"), "");
    fs.writeFileSync(path.join(dir, ".env"), `KEY=${AWS_KEY}\n`);
    git(dir, ["add", ".env"]);
    const exposed = checkStaged({ cwd: dir });
    assert.equal(exposed.issues[0].kind, "secret_file");
    assert.equal(exposed.issues[0].line, 0);
    git(dir, ["reset", "-q"]);
    fs.rmSync(path.join(dir, ".env"));
    fs.writeFileSync(path.join(dir, "key.js"), `const key = "${AWS_KEY}";\n`);
    git(dir, ["add", "key.js"]);
    const credential = checkStaged({ cwd: dir });
    assert.ok(credential.issues.some((issue) => issue.file === "key.js" && issue.line === 1));
    assert.doesNotMatch(JSON.stringify(credential), new RegExp(AWS_KEY));
    fs.writeFileSync(path.join(dir, "key.js"), "const key = process.env.KEY;\n");
    git(dir, ["add", "key.js"]);
    assert.deepEqual(checkStaged({ cwd: dir }).issues, []);
    fs.writeFileSync(
      path.join(dir, "details.js"),
      'const note = "My address is 123 Main Street, Springfield, IL 62704";\n',
    );
    git(dir, ["add", "details.js"]);
    assert.deepEqual(checkStaged({ cwd: dir }).issues, []);
    assert.ok(
      checkStaged({ cwd: dir, includePersonalDetails: true }).issues.some((issue) => issue.file === "details.js"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a staged diff over the Git buffer limit does not skip the other staged files", () => {
  const dir = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    initGit(dir);
    const filler = `const filler = "${"x".repeat(1000)}";\n`;
    fs.writeFileSync(path.join(dir, "large.js"), filler.repeat(18000));
    fs.writeFileSync(path.join(dir, "credential.js"), `const key = "${AWS_KEY}";\n`);
    git(dir, ["add", "large.js", "credential.js"]);

    const result = spawnSync(process.execPath, [script, "commit-check"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /"large\.js".*first 256 KiB.*rest.*wasn't checked/i);
    assert.match(result.stderr, /"large\.js".*add its path to \.clotrignore/);
    assert.match(result.stderr, /"credential\.js":1.*AKIA/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Git setup chains an existing pre-commit hook and restores it on removal", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const marker = path.join(dir, "existing-hook-ran");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf yes > '${marker.replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
    const installed = setupGit({ cwd: dir });
    assert.equal(installed.changed, true);
    assert.ok(fs.existsSync(`${hook}.clotr-guard.bak`));
    fs.writeFileSync(path.join(dir, "credential.js"), `const key = "${AWS_KEY}";\n`);
    git(dir, ["add", "credential.js"]);
    const blocked = spawnSync("git", ["commit", "-m", "A made-up credential"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /"credential\.js":1/);
    assert.match(blocked.stderr, /AKIA…3N/);
    assert.equal(fs.existsSync(marker), false);
    git(dir, ["reset", "-q"]);
    fs.rmSync(path.join(dir, "credential.js"));
    fs.writeFileSync(path.join(dir, "README.md"), "clean staged content\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "A clean staged change"]);
    assert.equal(fs.readFileSync(marker, "utf8"), "yes");
    setupGit({ cwd: dir, remove: true });
    assert.match(fs.readFileSync(hook, "utf8"), /existing-hook-ran/);
    assert.equal(fs.existsSync(`${hook}.clotr-guard.bak`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Git pre-commit hook lets a commit through when Node is missing from PATH", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    setupGit({ cwd: dir });
    fs.writeFileSync(path.join(dir, "credential.js"), `const key = "${AWS_KEY}";\n`);
    git(dir, ["add", "credential.js"]);
    const gitPath = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .find((entry) => entry.trim())
      .trim();
    const gitDirs = [path.dirname(gitPath)];
    if (process.platform === "win32") {
      // The hook is a shell script, so git needs sh.exe even with Node gone. `where git` can answer with
      // mingw64\bin\git.exe under Git Bash, two levels below Git's root, so walk up until usr\bin\sh.exe appears.
      let gitRoot = path.dirname(gitPath);
      for (let i = 0; i < 4 && !fs.existsSync(path.join(gitRoot, "usr", "bin", "sh.exe")); i++) {
        gitRoot = path.resolve(gitRoot, "..");
      }
      gitDirs.push(path.join(gitRoot, "bin"), path.join(gitRoot, "usr", "bin"));
      if (process.env.SystemRoot) gitDirs.push(path.join(process.env.SystemRoot, "System32"));
    }
    const result = spawnSync(gitPath, ["commit", "-m", "A made-up credential"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: gitDirs.join(path.delimiter) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr.includes("Clotr Guard couldn't run because node isn't on PATH, so this commit wasn't checked."),
      true,
      result.stderr,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("secret-file reads are denied in every tool with an assistant-facing instruction", () => {
  const dir = tempDir();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `STRIPE_KEY=${AWS_KEY}`);
  try {
    for (const tool of TOOLS) {
      const event =
        tool === "cursor"
          ? { file_path: file, content: `STRIPE_KEY=${AWS_KEY}` }
          : { tool_name: "Read", tool_input: { file_path: file } };
      const outcome = inspectRead(tool, event);
      assert.equal(outcome.secretFile, true, tool);
      const output = readHookOutput(tool, outcome);
      assert.match(output.stdout, /deny/);
      assert.match(output.stdout, /variable names or the example file/);
      assert.equal(output.stdout.includes(AWS_KEY), false);
    }
    const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
    const sample = spawnSync(process.execPath, [script, "read", "claude"], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "hook") },
    });
    assert.equal(sample.status, 0);
    assert.equal(JSON.parse(sample.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(sample.stdout, /variable names or the example file/);
    assert.equal(sample.stdout.includes(AWS_KEY), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("service-account JSON is treated as a secret file by its content", () => {
  const dir = tempDir();
  const file = path.join(dir, "account.json");
  fs.writeFileSync(file, '{"type":"service_account","project_id":"made-up"}');
  try {
    const result = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } });
    assert.equal(result.secretFile, true);
    assert.equal(JSON.parse(readHookOutput("claude", result).stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary-file reads keep Claude's ask and stop in other tools; personal details are optional", () => {
  const dir = tempDir();
  const file = path.join(dir, "ordinary.txt");
  try {
    fs.writeFileSync(file, `Use this key ${AWS_KEY}`);
    const claude = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { dataDir: dir });
    assert.equal(JSON.parse(readHookOutput("claude", claude).stdout).hookSpecificOutput.permissionDecision, "ask");
    const other = inspectRead("cursor", { file_path: file, content: `Use this key ${AWS_KEY}` }, { dataDir: dir });
    assert.equal(JSON.parse(readHookOutput("cursor", other).stdout).permission, "deny");
    fs.writeFileSync(file, "My address is 123 Main Street, Springfield, IL 62704");
    assert.equal(
      inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { dataDir: dir }).action,
      "allow",
    );
    assert.equal(
      inspectRead(
        "claude",
        { tool_name: "Read", tool_input: { file_path: file } },
        { dataDir: dir, includePersonalDetails: true },
      ).action,
      "block",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt and tool hooks leave personal details out unless the same option is enabled", () => {
  const address = "My address is 123 Main Street, Springfield, IL 62704";
  const defaultPrompt = inspectPrompt("claude", address, { dataDir: tempDir() });
  assert.equal(defaultPrompt.action, "allow");
  assert.equal(inspectPrompt("claude", address, { dataDir: tempDir(), includePersonalDetails: true }).action, "block");

  const event = { tool_name: "mcp__mail__send", tool_input: { body: address } };
  assert.equal(inspectTool("claude", event, { dataDir: tempDir() }).action, "allow");
  assert.equal(inspectTool("claude", event, { dataDir: tempDir(), includePersonalDetails: true }).action, "block");

  const command = mergeHook({}, "claude").hooks.UserPromptSubmit[0].hooks[0].command;
  assert.equal(command.includes("--personal-details"), false);
  const optedIn = mergeHook({}, "claude", false, "medium", true).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(optedIn.endsWith("--personal-details"));
});

test("prompt hooks include personal details only when the setup option is present", () => {
  const dir = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const input = JSON.stringify({ prompt: "My address is 123 Main Street, Springfield, IL 62704" });
  try {
    const defaults = spawnSync(process.execPath, [script, "hook", "claude"], {
      input,
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "default") },
    });
    assert.equal(defaults.status, 0);
    assert.equal(defaults.stdout, "");
    assert.equal(defaults.stderr, "");

    const optedIn = spawnSync(process.execPath, [script, "hook", "claude", "--personal-details"], {
      input,
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "opted-in") },
    });
    assert.equal(optedIn.status, 2);
    assert.match(optedIn.stderr, /within 2 minutes/);
    assert.doesNotMatch(optedIn.stderr, /123 Main Street, Springfield, IL 62704/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup recognizes an npx cache path and gives the stable install command", async () => {
  assert.equal(isNpxCachePath(path.join(os.tmpdir(), "_npx", "fixture", "node_modules", "clotr-guard", "bin")), true);
  assert.equal(isNpxCachePath(path.join(os.tmpdir(), "global", "node_modules", "clotr-guard", "bin")), false);

  const dir = tempDir();
  initGit(dir);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    const status = await main(["setup", "git"], {
      scriptPath: path.join(dir, "_npx", "fixture", "node_modules", "clotr-guard", "bin"),
      cwd: dir,
    });
    assert.equal(status, 2);
    assert.equal(fs.existsSync(path.join(dir, ".git", "hooks", "pre-commit")), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /npm install -g clotr-guard/);
  } finally {
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks use the node command when Node is on PATH", () => {
  const command = mergeHook({}, "claude").hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(command.startsWith('"node" '), command);
});

test("reads decode UTF-16 and single-byte text, while binary files and folders pass silently", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.txt");
  const text = `NAME=José\r\nAPI_KEY=${AWS_KEY}\r\n`;
  const event = { tool_name: "Read", tool_input: { file_path: file } };
  const read = () => inspectRead("claude", event, { dataDir: dir });
  const swapped = (buffer) => Buffer.from(buffer).swap16();
  try {
    const texts = {
      "UTF-16LE with a byte order mark": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
      "UTF-16BE with a byte order mark": Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        swapped(Buffer.from(text, "utf16le")),
      ]),
      "UTF-16LE without a byte order mark": Buffer.from(text, "utf16le"),
      "Windows-1252": Buffer.from(text, "latin1"),
    };
    for (const [name, bytes] of Object.entries(texts)) {
      fs.writeFileSync(file, bytes);
      const outcome = read();
      assert.equal(outcome.action, "block", name);
      assert.ok(
        outcome.findings.some((finding) => finding.kind === "aws_access_key"),
        name,
      );
      assert.equal(readHookOutput("claude", outcome).stdout.includes(AWS_KEY), false, name);
    }
    // A UTF-16 file cut at the cap is checked up to the cut.
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`KEY=${AWS_KEY}\n${"x".repeat(200 * 1024)}`, "utf16le")]),
    );
    const cut = read();
    assert.equal(cut.action, "block");
    assert.equal(cut.partial, true);

    const binaries = {
      "an image with a key in its metadata": Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
        Buffer.from(`tEXtComment\0${AWS_KEY}`, "latin1"),
        Buffer.alloc(64),
      ]),
      "compiled code without a single zero byte": Buffer.from(
        Array.from({ length: 4096 }, (_, index) => ((index * 37 + 11) % 255) + 1),
      ),
      "a byte order mark and a stray byte": Buffer.from([0xff, 0xfe, 0xfd]),
      "UTF-8 text with a zero byte": Buffer.from(`Use this key ${AWS_KEY}\0`),
    };
    for (const [name, bytes] of Object.entries(binaries)) {
      fs.writeFileSync(file, bytes);
      const outcome = read();
      assert.deepEqual(outcome, { action: "allow", skipped: true }, name);
      assert.deepEqual(readHookOutput("claude", outcome), { stdout: "{}", code: 0 }, name);
    }
    const folder = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: dir } }, { dataDir: dir });
    assert.deepEqual(folder, { action: "allow", skipped: true });
    assert.deepEqual(readHookOutput("claude", folder), { stdout: "{}", code: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks give the check 15 seconds before an assistant gives up on it", () => {
  const timeouts = (settings) =>
    Object.values(settings.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.timeout)),
    );
  // Claude Code and Codex count in seconds, Gemini CLI in milliseconds.
  assert.deepEqual([...new Set(timeouts(mergeHook({}, "claude")))], [15]);
  assert.deepEqual([...new Set(timeouts(mergeHook({}, "codex")))], [15]);
  assert.deepEqual([...new Set(timeouts(mergeHook({}, "gemini")))], [15000]);
});

test("an internal address never stops anything and is reported only when personal details are on", () => {
  const prompt = "The staging server at 192.168.1.20 returns a 500 error.";
  const quiet = inspectPrompt("claude", prompt, { dataDir: tempDir() });
  assert.equal(quiet.action, "allow");
  assert.deepEqual(hookOutput("claude", quiet), { stdout: "", code: 0 });

  const reported = inspectPrompt("claude", prompt, { dataDir: tempDir(), includePersonalDetails: true });
  assert.equal(reported.action, "allow");
  for (const tool of ["claude", "cursor", "gemini", "codex", "windsurf", "cline"]) {
    const output = hookOutput(tool, reported);
    assert.equal(output.code, 0, tool);
    const shown = `${output.stdout || ""}\n${output.stderr || ""}`;
    assert.match(shown, /Internal IP Address \(192\.…20\)/, tool);
    assert.equal(shown.includes("192.168.1.20"), false, tool);
    assert.doesNotMatch(shown, /"continue":false|"decision":"(?:block|deny)"|"cancel":true/, tool);
  }
  const hostname = inspectPrompt("claude", "Connect to db01.corp.internal on port 5432", {
    dataDir: tempDir(),
    includePersonalDetails: true,
  });
  assert.equal(hostname.action, "allow");

  // Beside a credential the prompt stops for the credential, and the address is listed with it.
  const both = inspectPrompt("claude", `${prompt} The key is ${AWS_KEY}.`, {
    dataDir: tempDir(),
    includePersonalDetails: true,
  });
  assert.equal(both.action, "block");
  assert.deepEqual(both.findings.map((finding) => finding.kind).sort(), ["aws_access_key", "internal_ip"]);

  const dir = tempDir();
  try {
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, prompt);
    const event = { tool_name: "Read", tool_input: { file_path: file } };
    assert.equal(inspectRead("claude", event, { dataDir: dir, includePersonalDetails: true }).action, "allow");
    const tool = { tool_name: "mcp__issues__create", tool_input: { body: prompt } };
    assert.equal(inspectTool("claude", tool, { dataDir: dir, includePersonalDetails: true }).action, "allow");

    initGit(dir);
    fs.writeFileSync(path.join(dir, "config.js"), 'const host = "192.168.1.20";\n');
    git(dir, ["add", "config.js"]);
    assert.deepEqual(checkStaged({ cwd: dir }).issues, []);
    const optedIn = checkStaged({ cwd: dir, includePersonalDetails: true });
    assert.deepEqual(optedIn.issues, []);
    assert.deepEqual(
      optedIn.notes.map((note) => [note.file, note.line, note.kind]),
      [["config.js", 1, "internal_ip"]],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup can add the personal-details option to read hooks", () => {
  const result = updateSettings("claude", { home: tempDir(), dryRun: true, includePersonalDetails: true });
  const commands = result.settings.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.ok(
    commands
      .filter((command) => command.includes(" read claude "))
      .every((command) => command.endsWith("--personal-details")),
  );
});

test("Codex setup installs its prompt hook without a read matcher", () => {
  const home = tempDir();
  try {
    const preview = updateSettings("codex", { home, dryRun: true }).settings;
    assert.ok(preview.hooks.UserPromptSubmit);
    assert.equal(preview.hooks.PreToolUse, undefined);
    updateSettings("codex", { home });
    const written = JSON.parse(fs.readFileSync(toolSettingsPath("codex", { home }), "utf8"));
    assert.ok(written.hooks.UserPromptSubmit);
    assert.equal(written.hooks.PreToolUse, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Claude Bash stops plain secret-file reads and environment dumps, while ordinary reads pass", () => {
  const env = inspectShell("claude", { tool_name: "Bash", tool_input: { command: "cat .env" } });
  assert.equal(env.secretFile, true);
  const output = readHookOutput("claude", env);
  assert.equal(JSON.parse(output.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.stdout, /don't try another way to read it/);
  assert.equal(inspectShell("claude", { tool_name: "Bash", tool_input: { command: "cat README.md" } }).action, "allow");
  assert.equal(
    inspectShell("claude", { tool_name: "Bash", tool_input: { command: "Get-Content .env.example" } }).action,
    "allow",
  );
  assert.equal(inspectShell("claude", { tool_name: "Bash", tool_input: { command: "printenv" } }).secretFile, true);
});

test("Bash blocks common secret-file readers and environment listings with the shared file rules", () => {
  const commands = [
    "export",
    "declare -p",
    "env -0",
    "printenv NAME",
    "Get-ChildItem Env:",
    "ls env:",
    "sed -n p .env",
    "awk 1 .env",
    "base64 .env",
    "xxd .env",
    "strings .env",
    "gc .env",
    `python -c "print(open('.env').read())"`,
    `node -e "console.log(require('fs').readFileSync('.env'))"`,
    "cp .env /tmp/a && cat /tmp/a",
    "cat .en*",
    "source .env && echo $KEY",
    "cat ~/.aws/credentials",
  ];
  for (const command of commands) {
    const result = inspectShell("claude", { tool_name: "Bash", tool_input: { command } });
    assert.equal(result.secretFile, true, command);
  }
  assert.equal(inspectShell("claude", { tool_name: "Bash", tool_input: { command: "echo .env" } }).action, "allow");
  assert.equal(
    inspectShell("claude", { tool_name: "Bash", tool_input: { command: "Get-Content .env.example" } }).action,
    "allow",
  );
});

test("Claude and Cursor MCP hooks check outgoing arguments and fail open visibly", () => {
  const key = `send ${AWS_KEY}`;
  for (const tool of ["claude", "cursor"]) {
    const event =
      tool === "claude"
        ? { tool_name: "mcp__mail__send", tool_input: { body: key } }
        : { tool_name: "send", tool_input: JSON.stringify({ body: key }), mcp_server_name: "mail" };
    const outcome = inspectTool(tool, event, { dataDir: tempDir() });
    assert.equal(outcome.action, "block", tool);
    const output = boundaryOutput(tool, outcome, "tool");
    const payload = JSON.parse(output.stdout);
    if (tool === "claude") assert.equal(payload.hookSpecificOutput.permissionDecision, "ask");
    else assert.equal(payload.permission, "ask");
    assert.equal(output.stdout.includes(AWS_KEY), false);
    assert.equal(inspectTool(tool, { ...event, tool_input: { body: "A clean message" } }).action, "allow");
    assert.equal(
      inspectTool(
        tool,
        {
          ...event,
          tool_input:
            tool === "cursor"
              ? JSON.stringify({ body: "My address is 123 Main Street, Springfield, IL 62704" })
              : { body: "My address is 123 Main Street, Springfield, IL 62704" },
        },
        { includePersonalDetails: true },
      ).action,
      "block",
      `${tool} medium detail`,
    );
  }
  for (const tool of ["claude", "cursor", "gemini"]) {
    const output = hookOutput(tool, { action: "allow", internalError: true, boundary: "tool" });
    const payload = JSON.parse(output.stdout);
    const message = tool === "cursor" ? payload.user_message : payload.systemMessage;
    assert.match(message, /couldn't check this (?:tool|shell), so it went through/);
  }
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  for (const tool of ["claude", "cursor"]) {
    const event =
      tool === "claude"
        ? { tool_name: "mcp__mail__send", tool_input: { body: key } }
        : { tool_name: "send", tool_input: JSON.stringify({ body: key }) };
    const result = spawnSync(process.execPath, [script, "tool", tool], {
      input: JSON.stringify(event),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(tempDir(), tool) },
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, new RegExp(AWS_KEY));
    const payload = JSON.parse(result.stdout);
    if (tool === "claude") assert.equal(payload.hookSpecificOutput.permissionDecision, "ask");
    else assert.equal(payload.permission, "ask");
  }
});

test("Cursor shell hook checks credentials and secret-file printing without scanning ordinary command text", () => {
  const dir = tempDir();
  const secret = path.join(dir, ".env");
  fs.writeFileSync(secret, `TOKEN=${AWS_KEY}`);
  const secretRead = inspectShell("cursor", { command: `cat "${secret}"`, cwd: dir });
  assert.equal(secretRead.secretFile, true);
  assert.equal(JSON.parse(readHookOutput("cursor", secretRead).stdout).permission, "deny");
  assert.equal(inspectShell("cursor", { command: `echo ${AWS_KEY}`, cwd: dir }).action, "block");
  assert.equal(inspectShell("cursor", { command: "echo address" }).action, "allow");
  assert.equal(inspectShell("cursor", { command: "cat README.md" }).action, "allow");
  for (const tool of ["claude", "cursor", "gemini"]) {
    const output = hookOutput(tool, { action: "allow", internalError: true, boundary: "shell" });
    const payload = JSON.parse(output.stdout);
    const message = tool === "cursor" ? payload.user_message : payload.systemMessage;
    assert.match(message, /couldn't check this (?:tool|shell), so it went through/);
  }
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const cursorHook = spawnSync(process.execPath, [script, "shell", "cursor"], {
    input: JSON.stringify({ command: `cat "${secret}"`, cwd: dir }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(cursorHook.stdout).permission, "deny");
  assert.doesNotMatch(cursorHook.stdout, new RegExp(AWS_KEY));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failed prompt checks show the fail-open message through each tool's hook output", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  for (const tool of ["claude", "cursor", "gemini"]) {
    const result = spawnSync(process.execPath, [script, "hook", tool], { input: "{", encoding: "utf8" });
    assert.equal(result.status, 0, tool);
    const payload = JSON.parse(result.stdout);
    const message = tool === "cursor" ? payload.user_message : payload.systemMessage;
    assert.equal(message, "Clotr couldn't check this prompt, so it went through.", tool);
    assert.equal(result.stderr, "", tool);
  }
});

test("setup registers Claude MCP and Cursor shell and MCP boundary hooks", () => {
  const home = tempDir();
  const claude = updateSettings("claude", { home, dryRun: true }).settings;
  const preTool = claude.hooks.PreToolUse;
  assert.ok(preTool.some((group) => group.matcher === "^mcp__" && group.hooks[0].command.includes(" tool claude ")));
  const cursor = updateSettings("cursor", { home, dryRun: true }).settings;
  for (const event of ["beforeShellExecution", "beforeMCPExecution"]) {
    assert.ok(
      cursor.hooks[event].some((hook) =>
        hook.command.includes(` ${event === "beforeShellExecution" ? "shell" : "tool"} cursor `),
      ),
    );
  }
  const gemini = updateSettings("gemini", { home, dryRun: true });
  assert.match(gemini.notice, /loads.*\.env/);
  assert.match(gemini.notice, /advanced\.ignoreLocalEnv/);
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const setupHome = path.join(home, "gemini-home");
  const output = spawnSync(process.execPath, [script, "setup", "gemini"], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: setupHome, HOME: setupHome },
  });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /Gemini CLI loads \.env files by default/);
  const written = JSON.parse(fs.readFileSync(path.join(setupHome, ".gemini", "settings.json"), "utf8"));
  assert.equal(written.advanced, undefined);
});

test("settings setup and removal preserve other keys and are idempotent", () => {
  const dir = tempDir();
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const original = {
    allowedTools: ["Read", "Write"],
    theme: { current: "dark", keep: [1, "two"] },
    hooks: { ExistingEvent: [{ hooks: [{ type: "command", command: "keep this" }] }] },
  };
  try {
    for (const tool of TOOLS) {
      const project = tool === "claude" || tool === "gemini" || tool === "codex";
      const target = toolSettingsPath(tool, { project, cwd, home });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(original, null, 2)}\n`);
      const first = updateSettings(tool, { project, cwd, home });
      assert.equal(first.changed, true, tool);
      assert.deepEqual(first.settings.allowedTools, original.allowedTools, tool);
      assert.deepEqual(first.settings.theme, original.theme, tool);
      assert.deepEqual(first.settings.hooks.ExistingEvent, original.hooks.ExistingEvent, tool);
      assert.equal(JSON.stringify(first.settings.allowedTools), JSON.stringify(original.allowedTools), tool);
      assert.equal(JSON.stringify(first.settings.theme), JSON.stringify(original.theme), tool);
      assert.ok(fs.existsSync(`${target}.clotr-guard.bak`), tool);
      assert.ok(
        first.settings.hooks.UserPromptSubmit ||
          first.settings.hooks.beforeSubmitPrompt ||
          first.settings.hooks.BeforeAgent,
      );
      if (tool === "codex") assert.equal(first.settings.hooks.PreToolUse, undefined);
      else {
        assert.ok(
          first.settings.hooks.PreToolUse || first.settings.hooks.beforeReadFile || first.settings.hooks.BeforeTool,
        );
      }
      if (tool === "claude") assert.ok(first.settings.hooks.PreToolUse.some((group) => group.matcher === "Bash"));
      const written = fs.readFileSync(target, "utf8");
      assert.equal(updateSettings(tool, { project, cwd, home }).changed, false, tool);
      assert.equal(fs.readFileSync(target, "utf8"), written, tool);
      assert.equal(updateSettings(tool, { project, cwd, home, remove: true }).changed, true, tool);
      const removed = JSON.parse(fs.readFileSync(target, "utf8"));
      assert.deepEqual(removed.allowedTools, original.allowedTools, tool);
      assert.deepEqual(removed.theme, original.theme, tool);
      assert.deepEqual(removed.hooks, original.hooks, tool);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings writes keep the original file intact if the atomic rename fails", () => {
  const home = tempDir();
  const target = toolSettingsPath("cursor", { home });
  const original = { theme: "dark", hooks: { Existing: [{ command: "keep" }] } };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(original)}\n`);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === target) throw new Error("simulated-rename-failure");
    return rename(from, to);
  };
  try {
    assert.throws(() => updateSettings("cursor", { home }), /simulated-rename-failure/);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), original);
    assert.equal(
      fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.renameSync = rename;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("JSONC settings name the file and stay untouched", async () => {
  const cwd = tempDir();
  const target = toolSettingsPath("claude", { project: true, cwd });
  const original = '{\n  // Keep this made-up setting.\n  "hooks": { "Existing": [], },\n}\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, original);
  const errors = [];
  const error = console.error;
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    assert.equal(await main(["setup", "claude", "--project"], { cwd }), 1);
    assert.deepEqual(errors, [
      `Clotr Guard didn't change ${target}: it isn't plain JSON (a comment or a trailing comma), so edit it by hand or remove them first.`,
    ]);
    assert.equal(fs.readFileSync(target, "utf8"), original);
  } finally {
    console.error = error;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("removing Guard settings removes the backup after its hooks are removed", () => {
  const home = tempDir();
  const target = toolSettingsPath("claude", { home });
  const backup = `${target}.clotr-guard.bak`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"theme":"dark"}\n');
  try {
    updateSettings("claude", { home });
    assert.equal(fs.existsSync(backup), true);
    updateSettings("claude", { home, remove: true });
    assert.equal(fs.existsSync(backup), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { theme: "dark" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("commit issue filenames escape terminal control characters", () => {
  assert.equal(
    formatCommitIssue({ file: "key\u001b[2J.txt", line: 4, kind: "aws_access_key", masked: "AKIA…3N" }),
    '"key\\u001b[2J.txt":4 aws_access_key (AKIA…3N)',
  );
});

test("dry-run previews settings without writing and internal errors fail open", () => {
  const dir = tempDir();
  try {
    const target = toolSettingsPath("cursor", { home: dir });
    const dry = updateSettings("cursor", { home: dir, dryRun: true });
    assert.equal(dry.changed, true);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(inspectPrompt("claude", null, { dataDir: dir }), { action: "allow", internalError: true });
    for (const tool of TOOLS) {
      const output = hookOutput(tool, { action: "allow", internalError: true });
      if (tool === "claude") {
        assert.equal(JSON.parse(output.stdout).systemMessage, "Clotr couldn't check this prompt, so it went through.");
      } else if (tool === "cursor") {
        assert.equal(JSON.parse(output.stdout).user_message, "Clotr couldn't check this prompt, so it went through.");
      } else {
        assert.equal(JSON.parse(output.stdout).systemMessage, "Clotr couldn't check this prompt, so it went through.");
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("staged checks run the engine once per file, so a large added file commits in seconds", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const lines = Array.from({ length: 2000 }, (_, i) => `const value${i} = "setting number ${i} for the module";`);
    lines[1499] = `const key = "${AWS_KEY}";`;
    fs.writeFileSync(path.join(dir, "big.js"), `${lines.join("\n")}\n`);
    git(dir, ["add", "big.js"]);
    let issues;
    retrySlow(() => {
      const started = process.hrtime.bigint();
      issues = checkStaged({ cwd: dir }).issues;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      return seconds < 5 ? undefined : `the staged check took ${seconds.toFixed(1)} s`;
    });
    assert.deepEqual(
      issues.map((issue) => [issue.file, issue.line, issue.kind]),
      [["big.js", 1500, "aws_access_key"]],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Git setup knows its own hook: a second setup changes nothing and removal takes it out", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    assert.equal(setupGit({ cwd: dir }).changed, true);
    const written = fs.readFileSync(hook, "utf8");
    assert.equal(setupGit({ cwd: dir }).changed, false);
    assert.equal(fs.readFileSync(hook, "utf8"), written);
    assert.equal(fs.existsSync(`${hook}.clotr-guard.bak`), false);
    assert.equal(setupGit({ cwd: dir, remove: true }).changed, true);
    assert.equal(fs.existsSync(hook), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Git hook whose Guard is gone lets commits through with a line, and setup points it at Guard again", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const marker = path.join(dir, "existing-hook-ran");
    const original = `#!/bin/sh\nprintf yes > '${marker.replace(/'/g, "'\\''")}'\n`;
    fs.writeFileSync(hook, original, { mode: 0o755 });
    setupGit({ cwd: dir });
    // An editor update removes the folder the hook was written from.
    const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
    const gone = path.join(dir, "extensions", "clotr-app.clotr-0.1.0", "guard", "bin", "clotr-guard.js");
    fs.writeFileSync(hook, fs.readFileSync(hook, "utf8").replaceAll(script, gone), { mode: 0o755 });
    assert.deepEqual(
      managedHooks("git", { cwd: dir }).map((entry) => entry.script),
      [gone],
    );
    fs.writeFileSync(path.join(dir, "credential.js"), `const key = "${AWS_KEY}";\n`);
    git(dir, ["add", "credential.js"]);
    const unchecked = spawnSync("git", ["commit", "-m", "Committed while Guard was missing"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(unchecked.status, 0, unchecked.stderr);
    assert.match(unchecked.stderr, /Clotr Guard wasn't found, so this commit wasn't checked/);
    assert.equal(fs.readFileSync(marker, "utf8"), "yes");

    assert.equal(setupGit({ cwd: dir }).changed, true);
    assert.deepEqual(
      managedHooks("git", { cwd: dir }).map((entry) => entry.script),
      [script],
    );
    assert.equal(fs.readFileSync(`${hook}.clotr-guard.bak`, "utf8"), original);
    fs.writeFileSync(path.join(dir, "credential.js"), `const key = "${AWS_KEY}"; // again\n`);
    git(dir, ["add", "credential.js"]);
    const checked = spawnSync("git", ["commit", "-m", "A made-up credential"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /aws_access_key/);
    setupGit({ cwd: dir, remove: true });
    assert.equal(fs.readFileSync(hook, "utf8"), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Guard lists the script each of its hooks runs, with the options it was set up with", () => {
  const home = tempDir();
  try {
    const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
    updateSettings("claude", { home, minimum: "high", includePersonalDetails: true });
    updateSettings("codex", { home });
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.writeFileSync(
      path.join(home, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: "another-tool check" }] } }),
    );
    assert.deepEqual(managedHooks("claude", { home }), [{ script, minimum: "high", includePersonalDetails: true }]);
    assert.deepEqual(managedHooks("codex", { home }), [{ script, minimum: "medium", includePersonalDetails: false }]);
    assert.deepEqual(managedHooks("cursor", { home }), []);
    assert.deepEqual(managedHooks("gemini", { home }), []);

    updateClineHooks({ home, platform: "linux", minimum: "low" });
    assert.deepEqual(managedHooks("cline", { home }), [{ script, minimum: "low", includePersonalDetails: false }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline setup rewrites its own hook when the Guard path or options change, keeping a chained hook", () => {
  const home = tempDir();
  try {
    const directory = path.join(home, "Documents", "Cline", "Hooks");
    fs.mkdirSync(directory, { recursive: true });
    const prompt = path.join(directory, "UserPromptSubmit");
    fs.writeFileSync(prompt, "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    updateClineHooks({ home, platform: "linux" });
    const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
    const gone = path.join(home, "old", "clotr-guard.js");
    fs.writeFileSync(prompt, fs.readFileSync(prompt, "utf8").replaceAll(JSON.stringify(script), JSON.stringify(gone)));
    const repaired = updateClineHooks({ home, platform: "linux", minimum: "high" });
    assert.equal(repaired.changed, true);
    const source = fs.readFileSync(prompt, "utf8");
    assert.ok(source.includes(JSON.stringify(script)));
    assert.equal(source.includes(JSON.stringify(gone)), false);
    assert.match(source, /"--min-severity","high"/);
    assert.ok(source.includes(JSON.stringify(`${prompt}.clotr-guard.bak`)));
    assert.equal(fs.readFileSync(`${prompt}.clotr-guard.bak`, "utf8"), "#!/bin/sh\necho '{}'\n");
    assert.equal(updateClineHooks({ home, platform: "linux", minimum: "high" }).changed, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Git setup refuses to replace a hook while an older Clotr backup sits beside it", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const backup = `${hook}.clotr-guard.bak`;
    fs.writeFileSync(backup, "#!/bin/sh\necho older backup\n", { mode: 0o755 });
    fs.writeFileSync(hook, "#!/bin/sh\necho current hook\n", { mode: 0o755 });
    assert.throws(() => setupGit({ cwd: dir }), /hook-backup-exists/);
    assert.match(fs.readFileSync(hook, "utf8"), /current hook/);
    assert.match(fs.readFileSync(backup, "utf8"), /older backup/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks written with another Node path are still Clotr's, so removal and setup stay idempotent", () => {
  const settings = mergeHook({}, "claude");
  const original = process.execPath;
  process.execPath = path.join(path.dirname(original), "another-version", path.basename(original));
  try {
    assert.equal(mergeHook(settings, "claude", true).hooks, undefined);
    assert.equal(mergeHook(settings, "claude").hooks.UserPromptSubmit[0].hooks.length, 1);
  } finally {
    process.execPath = original;
  }
});

test("setup run inside an Electron host writes a Node command, not the host's own binary", () => {
  process.versions.electron = "38.0.0";
  try {
    const command = mergeHook({}, "claude").hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.startsWith('"node" '), command);
    assert.ok(!command.includes(process.execPath), command);
  } finally {
    delete process.versions.electron;
  }
});

test("the Guard package reads nothing from outside its own folder, so a packed copy runs", () => {
  const root = path.join(__dirname, "../apps/guard");
  const outside = [];
  const note = (target) => {
    if (!target.startsWith(root + path.sep)) outside.push(path.relative(root, target));
  };
  for (const file of ["bin/clotr-guard.js", "bin/clotr-mcp.js", "lib/engine.js", "lib/secret-files.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const dir = path.dirname(path.join(root, file));
    for (const [, target] of source.matchAll(/require\("(\.[^"]+)"\)/g)) note(path.resolve(dir, target));
    for (const [, args] of source.matchAll(/path\.join\(__dirname,\s*([^)]+)\)/g)) {
      note(path.resolve(dir, ...[...args.matchAll(/"([^"]+)"/g)].map((match) => match[1])));
    }
  }
  assert.deepEqual(outside, []);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.bin["clotr-mcp"], "bin/clotr-mcp.js");
  assert.ok(pkg.files?.includes("dist"), "the engine bundle must ship in the package");
});

test("Guard prints its package version beside the engine version from the bundle header", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const header = /^\/\/ Clotr engine (\d+(?:\.\d+){2,3}):/m.exec(BUNDLE);
  assert.ok(header, "the engine bundle has a version header");
  const engineVersion = header[1].split(".").slice(0, 3).join(".");
  const version = spawnSync(process.execPath, [script, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `clotr-guard 0.1.0, engine ${engineVersion}`);
});

test("the Guard npm package declares its public pages and includes the license", () => {
  const root = path.join(__dirname, "../apps/guard");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.repository, { type: "git", url: "https://github.com/clotr-app/clotr" });
  assert.equal(pkg.homepage, "https://github.com/clotr-app/clotr");
  assert.deepEqual(pkg.bugs, { url: "https://github.com/clotr-app/clotr/issues" });
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --dry-run --json"] : ["pack", "--dry-run", "--json"];
  const packed = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const json = /(?:^|\r?\n)(\[[\s\S]*\])\s*$/.exec(packed.stdout);
  assert.ok(json, packed.stdout);
  const details = JSON.parse(json[1]);
  assert.ok(details[0].files.some((file) => file.path === "LICENSE"));
  assert.ok(details[0].files.some((file) => file.path === "skills/clotr/SKILL.md"));
});

// The skill is what an assistant reads about Guard, so each fact in it is checked against the code it describes.
test("the assistant skill ships in the Guard package and says what the code does", () => {
  const root = path.join(__dirname, "../apps/guard");
  const skill = fs.readFileSync(path.join(root, "skills", "clotr", "SKILL.md"), "utf8");
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  assert.ok(front, "the skill opens with its name and description");
  assert.match(front[1], /^name: clotr$/m);
  assert.match(front[1], /^description: Use when Clotr Guard stops .{20,}$/m);

  const mcp = require("../apps/guard/bin/clotr-mcp.js");
  mcp.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  const tools = mcp.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }).result.tools;
  for (const tool of tools) {
    assert.ok(skill.includes(`\`${tool.name}\``), `the skill names ${tool.name}`);
    for (const field of Object.keys(tool.inputSchema.properties)) {
      assert.ok(skill.includes(`\`${field}\``), `the skill names ${tool.name}'s ${field}`);
    }
  }
  assert.ok(skill.includes(`${mcp.MAX_TEXT_BYTES / 1024} KiB`), "the skill gives the MCP text cap");
  const guardSource = fs.readFileSync(path.join(root, "bin", "clotr-guard.js"), "utf8");
  assert.match(guardSource, /now - state\.at < 120_000/);
  assert.match(skill, /within two minutes/);
  assert.match(guardSource, /Clotr checked the first 256 KiB/);
  assert.match(skill, /"Clotr checked the first 256 KiB"/);
  assert.match(guardSource, /`Clotr couldn't check this \$\{boundary\}, so it went through\.`/);
  assert.match(skill, /"Clotr couldn't check this"/);
  assert.match(guardSource, /Work from the variable names or the example file/);
  assert.match(skill, /work from the variable names or an example file/);
  assert.match(skill, /--no-verify/);
  assert.doesNotMatch(skill, /AKIA[0-9A-Z]{16}/, "the skill carries no key, not even a made-up one");

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("skills"), "the skill ships in the npm package");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(
    readme,
    /\(https:\/\/github\.com\/clotr-app\/clotr\/blob\/main\/apps\/guard\/skills\/clotr\/SKILL\.md\)/,
    "the README links the skill",
  );
});

// A status is only worth reading if the tests behind it are real, so every row has to link a test file that exists.
test("each developer tool's README marks every feature stable or preview and links tests that exist", () => {
  const repo = path.join(__dirname, "..");
  const base = "https://github.com/clotr-app/clotr/blob/main/";
  for (const app of ["guard", "vscode", "jetbrains"]) {
    const readme = fs.readFileSync(path.join(repo, "apps", app, "README.md"), "utf8");
    const section = /^## Stable and preview\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme)?.[1];
    assert.ok(section, `${app}'s README has a Stable and preview section`);
    const targets = new Map([...section.matchAll(/^\[([\w-]+)\]: (\S+)$/gm)].map((m) => [m[1], m[2]]));
    const rows = section.split("\n").filter((line) => line.startsWith("| ") && !/^\| (Feature|---) /.test(line));
    assert.ok(rows.length >= 5, `${app} lists its features`);
    for (const row of rows) {
      const [feature, status, tests] = row.split(" | ").map((cell) => cell.replace(/^\| | \|$/g, ""));
      assert.ok(["Stable", "Preview"].includes(status), `${app}: "${feature}" is ${status}`);
      const links = [...tests.matchAll(/\[([^\]]+)\]\[([\w-]+)\]/g)];
      assert.ok(links.length, `${app}: "${feature}" links its tests`);
      for (const [, text, id] of links) {
        const url = targets.get(id);
        assert.ok(url?.startsWith(base), `${app}: [${id}] points into the public repo`);
        const file = url.slice(base.length);
        assert.ok(/^tests\/|\/src\/test\//.test(file), `${app}: ${file} is a test`);
        assert.ok(fs.existsSync(path.join(repo, file)), `${app}: ${file} exists`);
        assert.equal(text, path.basename(file));
      }
    }
    if (rows.some((row) => row.includes("| Preview |"))) {
      const after = section.slice(section.lastIndexOf("\n|") + 1);
      assert.match(after, /\bpreview\b/, `${app} says why its preview features are previews`);
    }
  }
});

// Only the public repository publishes, since npm signs provenance only for a public repository: its workflow lives
// in public/.github/workflows here and in .github/workflows there. It must never start by itself, it publishes only
// from one of Guard's own tags, so a release tag can't start it and its tags can't start the extension's release, and
// it waits for the npm environment's approval.
test("the npm publish workflow runs only by hand, from a Guard tag, and publishes Guard and clotr-engine with provenance", () => {
  const repo = path.join(__dirname, "..");
  const overlay = path.join(repo, "public", ".github", "workflows");
  const privateCheckout = fs.existsSync(overlay);
  const wfDir = privateCheckout ? overlay : path.join(repo, ".github", "workflows");
  const wf = fs.readFileSync(path.join(wfDir, "publish-guard.yml"), "utf8");
  const triggers = /^on:\n((?:[ ]+.*\n)+)/m.exec(wf)?.[1];
  assert.equal(triggers, "  workflow_dispatch:\n");
  assert.match(wf, /^permissions:\s*\n\s+contents: read/m);
  for (const [, use] of wf.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(use, /@[0-9a-f]{40}$/);
  assert.match(wf, /persist-credentials: false/);
  const idTokens = [...wf.matchAll(/^(\s*)id-token: write/gm)];
  assert.equal(idTokens.length, 1);
  assert.ok(idTokens[0][1].length >= 6, "only the publish job gets an ID token");
  assert.match(wf, /refs\/tags\/guard-v\*\)/);
  assert.doesNotMatch(wf, /refs\/tags\/v\*/);
  assert.match(wf, /guard="guard-v\$\(node -p "require\('\.\/apps\/guard\/package\.json'\)\.version"\)"/);
  assert.match(wf, /^\s+environment:\n\s+name: npm\n/m);
  // Guard's package stays private in the source; only this run takes the flag off, after the tests and the tag check.
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "apps", "guard", "package.json"), "utf8")).private, true);
  const order = ["run: npm test", 'guard="guard-v', "run: npm pkg delete private", "run: npm publish"].map((step) =>
    wf.indexOf(step),
  );
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    `steps out of order: ${order}`,
  );
  assert.match(wf, /working-directory: apps\/guard\n(?:.*\n)*?\s+run: npm publish --provenance --access public\n/);
  // clotr-engine goes out in the same run, after Guard: built and tested while its source still says private, then
  // published from this run's copy without running those scripts again.
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "apps", "engine", "package.json"), "utf8")).private, true);
  const engineAt = wf.indexOf("working-directory: apps/engine");
  assert.ok(engineAt > wf.indexOf("run: npm publish --provenance --access public\n"), "the engine comes after Guard");
  const engine = wf.slice(engineAt);
  assert.doesNotMatch(engine, /working-directory: apps\/guard/);
  const engineOrder = [
    "run: npm pack --dry-run",
    "run: npm pkg delete private",
    "npm publish --provenance --access public --ignore-scripts",
  ].map((step) => engine.indexOf(step));
  assert.ok(
    engineOrder.every((at, i) => at >= 0 && (i === 0 || at > engineOrder[i - 1])),
    `engine steps out of order: ${engineOrder}`,
  );
  // The extension's Release workflow builds on v* tags, which never match a guard-v tag.
  const release = path.join(repo, ".github", "workflows", "release.yml");
  if (fs.existsSync(release)) assert.match(fs.readFileSync(release, "utf8"), /tags: \["v\*"\]/);
  // The private repository never publishes, so no workflow of its own may run npm publish, and the public one only
  // from this workflow.
  const workflows = path.join(repo, ".github", "workflows");
  for (const file of fs.readdirSync(workflows)) {
    if (!privateCheckout && file === "publish-guard.yml") continue;
    assert.doesNotMatch(fs.readFileSync(path.join(workflows, file), "utf8"), /npm publish/, file);
  }
});

test("a fresh Cursor hooks file carries the version field Cursor requires", () => {
  const fresh = mergeHook({}, "cursor");
  assert.equal(fresh.version, 1);
  assert.equal(Object.keys(fresh)[0], "version");
  assert.equal(mergeHook({ version: 1, hooks: {} }, "cursor").version, 1);
  assert.equal("version" in mergeHook({}, "claude"), false);
  assert.equal("version" in mergeHook({ hooks: {} }, "cursor", true), false);
  const home = tempDir();
  try {
    updateSettings("cursor", { home });
    const written = JSON.parse(fs.readFileSync(toolSettingsPath("cursor", { home }), "utf8"));
    assert.equal(written.version, 1);
    assert.ok(written.hooks.beforeSubmitPrompt);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("read hooks check a file whose stat reports no size, as process environment files do", () => {
  const dir = tempDir();
  const file = path.join(dir, "environ");
  fs.writeFileSync(file, `PATH=/usr/bin\nSECRET=${AWS_KEY}\n`);
  const realFstat = fs.fstatSync;
  fs.fstatSync = (descriptor) => {
    const stat = realFstat(descriptor);
    return { ...stat, size: 0, isFile: () => true };
  };
  try {
    const outcome = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { dataDir: dir });
    assert.equal(outcome.action, "block");
    assert.equal(outcome.partial, undefined);
    assert.equal(JSON.stringify(outcome).includes(AWS_KEY), false);
  } finally {
    fs.fstatSync = realFstat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credential stores are secret files where they live, while project files with the same names aren't", () => {
  const { isSecretFile } = require("../apps/guard/lib/secret-files.js");
  const home = process.platform === "win32" ? "C:\\Users\\fixture" : "/home/fixture";
  const at = (...parts) => path.join(home, ...parts);
  const roaming = (...parts) => at("AppData", "Roaming", ...parts);
  for (const file of [
    at(".kube", "config"),
    at(".docker", "config.json"),
    at(".config", "gh", "hosts.yml"),
    roaming("GitHub CLI", "hosts.yml"),
    at(".codex", "auth.json"),
    at(".gemini", "oauth_creds.json"),
    at(".config", "gcloud", "credentials.db"),
    at(".config", "gcloud", "access_tokens.db"),
    at(".config", "gcloud", "application_default_credentials.json"),
    roaming("gcloud", "application_default_credentials.json"),
    at(".m2", "settings.xml"),
    at(".gradle", "gradle.properties"),
    at(".azure", "msal_token_cache.json"),
    at(".bash_history"),
    at(".zsh_history"),
    roaming("Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
    at(".local", "share", "powershell", "PSReadLine", "ConsoleHost_history.txt"),
    "infra/terraform.tfstate",
    "infra/terraform.tfstate.backup",
    "android/app/release.keystore",
    "server/truststore.jks",
    ".kube/config",
    "~/.kube/config",
  ]) {
    assert.equal(isSecretFile(file), true, file);
  }
  for (const file of [
    "config",
    "src/config",
    "kube/config",
    "app/config.json",
    "docker/config.json",
    "settings.xml",
    "m2/settings.xml",
    "gradle.properties",
    "android/gradle.properties",
    "auth.json",
    "hosts.yml",
    "credentials.db",
    "history.txt",
    "main.tf",
  ]) {
    assert.equal(isSecretFile(file), false, file);
  }
  const shell = (command) => inspectShell("claude", { tool_name: "Bash", tool_input: { command } });
  assert.equal(shell("cat ~/.kube/config").secretFile, true);
  assert.equal(shell("cat ~/.bash_history").secretFile, true);
  assert.equal(shell("cat config").secretFile, undefined);
});

test("Bash stops subshell, redirection and further reader forms of a secret file, while ordinary commands pass", () => {
  const stopped = [
    "echo $(cat .env)",
    "echo `cat .env`",
    "(cat .env)",
    "pwsh -c (gc .env)",
    "tr a a < .env",
    "while read l; do echo $l; done < .env",
    "cat<.env",
    "tac .env",
    "nl .env",
    "od -c .env",
    "hexdump -C .env",
    "rev .env",
    "cut -c1- .env",
    "sort .env",
    "diff .env /dev/null",
    "bat .env",
    "gci env:",
    "dir env:",
    "Get-Item env:*",
    "cat /proc/self/environ",
    "cat /proc/1/environ",
    `python -c "print(open('/proc/self/environ').read())"`,
  ];
  for (const command of stopped) {
    assert.equal(inspectShell("claude", { tool_name: "Bash", tool_input: { command } }).secretFile, true, command);
  }
  const passing = [
    "echo .env",
    "printf '%s' .env",
    "echo $(date)",
    "(ls -la)",
    "sort names.txt",
    "dir env",
    "ls env",
    "cat /proc/cpuinfo",
    "tr a b < names.txt",
  ];
  for (const command of passing) {
    assert.equal(inspectShell("claude", { tool_name: "Bash", tool_input: { command } }).action, "allow", command);
  }
});

test("settings keep their own indentation and final newline, so removal leaves the file as it was", () => {
  const home = tempDir();
  try {
    const claude = toolSettingsPath("claude", { home });
    const original = JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls:*)"] } }, null, 4);
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, original);
    updateSettings("claude", { home });
    const hooked = fs.readFileSync(claude, "utf8");
    assert.match(hooked, /\n {4}"hooks": \{\n {8}"/);
    assert.equal(hooked.endsWith("\n"), false);
    updateSettings("claude", { home, remove: true });
    assert.equal(fs.readFileSync(claude, "utf8"), original);

    const cursor = toolSettingsPath("cursor", { home });
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, `{\n\t"version": 1,\n\t"hooks": {}\n}\n`);
    updateSettings("cursor", { home });
    assert.match(fs.readFileSync(cursor, "utf8"), /\n\t"hooks": \{\n\t\t"beforeSubmitPrompt"/);

    const windsurf = toolSettingsPath("windsurf", { home });
    const compact = '{"hooks":{"pre_user_prompt":[{"command":"mine","show_output":false}]}}\n';
    fs.mkdirSync(path.dirname(windsurf), { recursive: true });
    fs.writeFileSync(windsurf, compact);
    updateSettings("windsurf", { home });
    assert.equal(fs.readFileSync(windsurf, "utf8").split("\n").length, 2);
    updateSettings("windsurf", { home, remove: true });
    assert.equal(fs.readFileSync(windsurf, "utf8"), compact);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(".clotrignore matches Git-style paths and salted value fingerprints", () => {
  const root = tempDir();
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const file = path.join(root, ".clotrignore");
  fs.writeFileSync(
    file,
    `# local fixture rules\nsalt: ${salt}\nfingerprint: ${valueFingerprint(salt, AWS_KEY)}\nfixtures/\n*.log\n!keep.log\n**/*.snap\n`,
  );
  try {
    const config = readClotrIgnore(root);
    assert.equal(config.valid, true);
    assert.equal(pathIgnored(config, "fixtures/key.js"), true);
    assert.equal(pathIgnored(config, "fixtures/nested/sample.txt"), true);
    assert.equal(pathIgnored(config, "keep.log"), false);
    assert.equal(pathIgnored(config, "logs/today.log"), true);
    assert.equal(pathIgnored(config, "nested/view.snap"), true);
    assert.equal(pathIgnored(config, "../outside/key.js"), false);
    assert.equal(config.fingerprints.has(valueFingerprint(salt, AWS_KEY)), true);
    assert.equal(config.fingerprints.has(valueFingerprint(salt, CARD_NUMBER)), false);
    assert.equal(JSON.stringify(config).includes(AWS_KEY), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the JavaScript and Kotlin .clotrignore parsers use the same vectors", () => {
  const vectorPath = path.join(__dirname, "clotrignore-vectors.txt");
  for (const line of fs
    .readFileSync(vectorPath, "utf8")
    .split(/\r?\n/)
    .filter((row) => row && !row.startsWith("#"))) {
    const [first, second, third, fourth] = line.split("|");
    if (first === "fingerprint") {
      assert.equal(valueFingerprint(second, third), fourth);
      continue;
    }
    const parsed = parseClotrIgnore(first.replaceAll("\\n", "\n"));
    assert.equal(pathIgnored(parsed, second), third === "true", line);
  }
});

// A .clotrignore comes with the repository, so a rule full of stars once made a commit or an editor hang on one path.
test("a .clotrignore rule full of stars matches a long path quickly", () => {
  const script = [
    `const { parseClotrIgnore, pathIgnored } = require(${JSON.stringify(require.resolve("../apps/guard/lib/clotrignore.js"))});`,
    `const config = parseClotrIgnore("*a*a*a*a*a*a*a*a*a*a*b\\n**/*a*a*a*a*a*a*a*a*a*a*b/x\\n");`,
    `const long = "x" + "a".repeat(60);`,
    `console.log([pathIgnored(config, long), pathIgnored(config, long + "b"), pathIgnored(config, "d/" + long + "/x/y")].join());`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.signal, null, "the match took longer than ten seconds");
  assert.equal(result.stdout.trim(), "false,true,false");
});

// Each rule was matched against every folder prefix of a path again from its start, so a deep path cost its depth
// times its length times the rule, and a .clotrignore of long "**/" chains held one path for seconds.
test("a .clotrignore of long rules matches a deep path in one walk per rule", () => {
  const config = parseClotrIgnore(Array.from({ length: 62 }, (_, i) => `${"**/".repeat(340)}x${i}`).join("\n"));
  const deep = `${Array.from({ length: 60 }, (_, i) => `pkg${String(i).padStart(4, "0")}`).join("/")}/index.js`;
  retrySlow(() => {
    const started = process.hrtime.bigint();
    const ignored = pathIgnored(config, deep);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(ignored, false);
    return elapsed < 1000 ? undefined : `a ${deep.length}-character path took ${elapsed.toFixed(1)} ms`;
  });
  assert.equal(pathIgnored(config, `${deep.split("/").slice(0, 10).join("/")}/x7/index.js`), true);
});

test(".clotrignore refuses raw values, oversized files, and symlinks", () => {
  const root = tempDir();
  const outside = path.join(root, "outside");
  const configPath = path.join(root, ".clotrignore");
  try {
    fs.writeFileSync(configPath, `value: ${AWS_KEY}\n**\n`);
    assert.equal(readClotrIgnore(root).reason, "raw-value");
    fs.writeFileSync(configPath, "**\n".repeat(40_000));
    assert.equal(readClotrIgnore(root).reason, "too-large");
    fs.writeFileSync(outside, "**\n");
    fs.rmSync(configPath);
    fs.writeFileSync(configPath, "**\n");
    const originalLstat = fs.lstatSync;
    fs.lstatSync = function (file, ...args) {
      const stat = originalLstat.call(fs, file, ...args);
      if (path.resolve(file) !== path.resolve(configPath)) return stat;
      return new Proxy(stat, {
        get(target, property) {
          return property === "isSymbolicLink" ? () => true : Reflect.get(target, property, target);
        },
      });
    };
    let symlinked;
    try {
      symlinked = readClotrIgnore(root);
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.equal(symlinked.valid, false);
    assert.equal(pathIgnored(symlinked, "anything.js"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a broad .clotrignore stays inside the repository", () => {
  const root = tempDir();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.js`);
  try {
    const config = parseClotrIgnore("**\n");
    assert.equal(pathIgnored(config, "fixtures/key.js"), true);
    assert.equal(pathIgnored(config, "../outside/key.js"), false);
    assert.equal(pathIgnoredForFile(config, root, outside), false);
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Guard hooks and staged checks use .clotrignore without quieting secret files", () => {
  const root = tempDir();
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  try {
    initGit(root);
    fs.writeFileSync(
      path.join(root, ".clotrignore"),
      `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, AWS_KEY)}\nfixtures/\n**\n`,
    );
    const ignoredPrompt = inspectPrompt("claude", `Use ${AWS_KEY}`, { cwd: root, dataDir: path.join(root, "state") });
    assert.equal(ignoredPrompt.action, "allow");

    const fixturePath = path.join(root, "fixtures", "ordinary.js");
    fs.mkdirSync(path.dirname(fixturePath));
    fs.writeFileSync(fixturePath, `key=${AWS_KEY}`);
    const fixtureRead = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: fixturePath } });
    assert.equal(fixtureRead.action, "allow");
    assert.equal(fixtureRead.skipped, true);

    fs.writeFileSync(path.join(root, ".env"), `KEY=${AWS_KEY}`);
    const secretRead = inspectRead(
      "claude",
      {
        tool_name: "Read",
        tool_input: { file_path: path.join(root, ".env") },
      },
      { cwd: root },
    );
    assert.equal(secretRead.action, "block");
    assert.equal(secretRead.secretFile, true);
    git(root, ["add", ".clotrignore", "fixtures/ordinary.js", ".env"]);
    const staged = checkStaged({ cwd: root });
    assert.deepEqual(
      staged.issues.map(({ file, kind }) => ({ file, kind })),
      [{ file: ".env", kind: "secret_file" }],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Guard prompt, read, shell, and tool checks use the same value fingerprints", () => {
  const root = tempDir();
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  try {
    initGit(root);
    fs.writeFileSync(
      path.join(root, ".clotrignore"),
      `salt: ${salt}\nfingerprint: ${valueFingerprint(salt, AWS_KEY)}\n`,
    );
    const dataDir = path.join(root, "state");
    assert.equal(inspectPrompt("claude", `Use ${AWS_KEY}`, { cwd: root, dataDir }).action, "allow");
    const file = path.join(root, "ordinary.js");
    fs.writeFileSync(file, `const key = "${AWS_KEY}";`);
    assert.equal(
      inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root }).action,
      "allow",
    );
    assert.equal(
      inspectShell("claude", { tool_name: "Bash", tool_input: { command: `echo ${AWS_KEY}` } }, { cwd: root }).action,
      "allow",
    );
    assert.equal(
      inspectTool("claude", { tool_name: "mcp__fixture", tool_input: { content: AWS_KEY } }, { cwd: root, dataDir })
        .action,
      "allow",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Guard reports one short command hint for a raw value line", () => {
  const root = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    initGit(root);
    fs.writeFileSync(path.join(root, ".clotrignore"), `value: ${AWS_KEY}\n`);
    const result = spawnSync(process.execPath, [script, "hook", "claude"], {
      cwd: root,
      input: JSON.stringify({ prompt: `Use ${AWS_KEY}` }),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(root, "state") },
    });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.equal((result.stderr.match(/Use clotr-guard ignore-value\./g) || []).length, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(AWS_KEY));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignore-value reads stdin and writes only a salted fingerprint", () => {
  const root = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    initGit(root);
    const added = spawnSync(process.execPath, [script, "ignore-value"], {
      cwd: root,
      input: `${AWS_KEY}\n`,
      encoding: "utf8",
    });
    assert.equal(added.status, 0, added.stderr);
    const contents = fs.readFileSync(path.join(root, ".clotrignore"), "utf8");
    assert.match(contents, /^salt: [0-9a-f]{64}$/m);
    assert.match(contents, /^fingerprint: [0-9a-f]{64}$/m);
    assert.doesNotMatch(contents, new RegExp(AWS_KEY));
    assert.equal(readClotrIgnore(root).fingerprints.size, 1);
    const argument = spawnSync(process.execPath, [script, "ignore-value", AWS_KEY], { cwd: root, encoding: "utf8" });
    assert.equal(argument.status, 2);
    assert.doesNotMatch(fs.readFileSync(path.join(root, ".clotrignore"), "utf8"), new RegExp(AWS_KEY));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The salt sits in the committed .clotrignore beside each fingerprint, so anyone who reads the repository can try
// every phone number or card number against it. Only a value too long to guess that way gets a fingerprint.
test("ignore-value refuses a value that could be guessed back from its fingerprint", () => {
  const root = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    initGit(root);
    for (const value of [
      "jordan.lee@fastmail.com",
      "(415) 867-5309",
      "536-22-8714",
      "4111 1111 1111 1111",
      "DE89370400440532013000",
      "4821",
    ]) {
      const result = spawnSync(process.execPath, [script, "ignore-value"], {
        cwd: root,
        input: `${value}\n`,
        encoding: "utf8",
      });
      assert.equal(result.status, 2, value);
      assert.match(result.stderr, /too easy to guess/, value);
      assert.equal(fs.existsSync(path.join(root, ".clotrignore")), false, value);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A PATH with git and sh but no Node, so a hook runs the way it would from a GUI client that doesn't see nvm.
function pathWithoutNode() {
  const gitPath = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], { encoding: "utf8" })
    .split(/\r?\n/)
    .find((entry) => entry.trim())
    .trim();
  const gitDirs = [path.dirname(gitPath)];
  if (process.platform === "win32") {
    let gitRoot = path.dirname(gitPath);
    for (let i = 0; i < 4 && !fs.existsSync(path.join(gitRoot, "usr", "bin", "sh.exe")); i++) {
      gitRoot = path.resolve(gitRoot, "..");
    }
    gitDirs.push(path.join(gitRoot, "bin"), path.join(gitRoot, "usr", "bin"));
    if (process.env.SystemRoot) gitDirs.push(path.join(process.env.SystemRoot, "System32"));
  }
  return { gitPath, PATH: gitDirs.join(path.delimiter) };
}

test("removing Guard's Git check leaves a hook the person wrote around the command", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const own = "#!/bin/sh\nnpm run lint || exit 1\nclotr-guard commit-check\n";
    fs.writeFileSync(hook, own, { mode: 0o755 });
    assert.equal(setupGit({ cwd: dir }).changed, false);
    assert.equal(setupGit({ cwd: dir, remove: true }).changed, false);
    assert.equal(fs.readFileSync(hook, "utf8"), own);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removing Guard's Git check keeps a hand-written hook that calls its full path", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    const cli = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
    const own = `#!/bin/sh\n'${cli}' commit-check\nprintf keep-my-hook\n`;
    fs.writeFileSync(hook, own, { mode: 0o755 });
    const result = setupGit({ cwd: dir, remove: true });
    assert.equal(result.changed, false);
    assert.equal(result.kept, true);
    assert.equal(fs.readFileSync(hook, "utf8"), own);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removing Guard's Git check keeps its hook if someone added a line", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    setupGit({ cwd: dir });
    const edited = `${fs.readFileSync(hook, "utf8")}# added after setup\n`;
    fs.writeFileSync(hook, edited, { mode: 0o755 });
    const result = setupGit({ cwd: dir, remove: true });
    assert.equal(result.changed, false);
    assert.equal(result.kept, true);
    assert.equal(fs.readFileSync(hook, "utf8"), edited);
    assert.equal(fs.existsSync(`${hook}.clotr-guard.bak`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removing an exact hook from an earlier Guard install restores its backup", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    const original = "#!/bin/sh\necho original hook\n";
    fs.writeFileSync(hook, original, { mode: 0o755 });
    setupGit({ cwd: dir });
    const cli = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
    const earlierCli = path.join(dir, "older editor install", "bin", "clotr-guard.js");
    fs.writeFileSync(hook, fs.readFileSync(hook, "utf8").replaceAll(cli, earlierCli), { mode: 0o755 });
    assert.equal(setupGit({ cwd: dir, remove: true }).changed, true);
    assert.equal(fs.readFileSync(hook, "utf8"), original);
    assert.equal(fs.existsSync(`${hook}.clotr-guard.bak`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Guard findings keep their own values after splitOwnIds changes the order", () => {
  const context = vm.createContext({});
  vm.runInContext(BUNDLE, context);
  const valueSalt = "0123456789abcdef0123456789abcdef";
  const ignoreSalt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const mine = "EMP-48213";
  const other = "EMP-11111";
  const value = {
    kind: "value",
    type: "my_id",
    fp: context.Clotr.fingerprint(valueSalt, "my_id", mine),
    mode: "protect",
    added: 1,
  };
  const shape = { kind: "shape", type: "my_id", shape: "EMP-#####", near: ["employee number"], added: 1 };
  context.ClotrHost.init({ salt: valueSalt, vault: [value, shape] });
  const text = `employee number ${other}\nemployee number ${mine}`;
  const state = { salt: valueSalt, vault: [value], cache: new Map() };
  const detections = context.Clotr.splitOwnIds(context.Clotr.detect(text), state);
  assert.deepEqual(
    JSON.parse(JSON.stringify(detections.map(({ name, severity, matches }) => ({ name, severity, matches })))),
    [
      { name: "Your Account/ID Number", severity: "high", matches: [mine] },
      { name: "Account/ID Number", severity: "medium", matches: [other] },
    ],
  );
  const findings = findingsFromDetections(context, text, detections, {
    ignoreSalt,
    ignoreFingerprints: [valueFingerprint(ignoreSalt, other)],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].label, "Your Account/ID Number");
  assert.equal(findings[0].severity, "high");
  assert.equal(text.slice(findings[0].start, findings[0].end), mine);
  assert.equal(text.slice(0, findings[0].start).split("\n").length, 2);
});

test("removing Guard's Git check keeps a hook another tool wrote after setup, and its backup", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const backup = `${hook}.clotr-guard.bak`;
    const first = "#!/bin/sh\necho first hook\n";
    fs.writeFileSync(hook, first, { mode: 0o755 });
    setupGit({ cwd: dir });
    const replaced = "#!/bin/sh\necho installed by another tool\n";
    fs.writeFileSync(hook, replaced, { mode: 0o755 });
    assert.equal(setupGit({ cwd: dir, remove: true }).changed, false);
    assert.equal(fs.readFileSync(hook, "utf8"), replaced);
    assert.equal(fs.readFileSync(backup, "utf8"), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a settings backup the person made stays through Guard's setup and removal", () => {
  const home = tempDir();
  try {
    for (const tool of TOOLS) {
      const target = toolSettingsPath(tool, { home });
      const theirs = `${target}.bak`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"theme":"dark"}\n');
      fs.writeFileSync(theirs, '{"theme":"light"}\n');
      updateSettings(tool, { home });
      assert.equal(fs.readFileSync(`${target}.clotr-guard.bak`, "utf8"), '{"theme":"dark"}\n', tool);
      updateSettings(tool, { home, remove: true });
      assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).theme, "dark", tool);
      assert.equal(fs.existsSync(`${target}.clotr-guard.bak`), false, tool);
      // A removal where Guard was never set up changes nothing either.
      updateSettings(tool, { home, remove: true });
      assert.equal(fs.readFileSync(theirs, "utf8"), '{"theme":"light"}\n', tool);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a commit check that can't run lets the commit through with a line", () => {
  const dir = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const result = spawnSync(process.execPath, [script, "commit-check"], { cwd: dir, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Clotr Guard couldn't check the staged changes because this isn't a Git repository/);
    assert.match(result.stderr, /this commit wasn't checked\./);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the person's own pre-commit hook still runs when Node is missing from PATH", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const marker = path.join(dir, "existing-hook-ran");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf yes > '${marker.replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
    setupGit({ cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "clean staged content\n");
    git(dir, ["add", "README.md"]);
    const { gitPath, PATH } = pathWithoutNode();
    const result = spawnSync(gitPath, ["commit", "-m", "A clean change"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "yes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Cursor read over 1 MiB still checks its first 256 KiB", () => {
  const dir = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    const event = { file_path: path.join(dir, "big.log"), content: `Use ${AWS_KEY}\n${"x".repeat(2 * 1024 * 1024)}` };
    const result = spawnSync(process.execPath, [script, "read", "cursor"], {
      input: JSON.stringify(event),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(JSON.parse(result.stdout).permission, "allow", result.stdout);
    assert.match(result.stdout, /rest of the file wasn't checked/);
    assert.doesNotMatch(result.stdout, new RegExp(AWS_KEY));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shell hook uses the stop level setup gave it", () => {
  const dir = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  try {
    const result = spawnSync(
      process.execPath,
      [script, "shell", "claude", "--min-severity", "low", "--personal-details"],
      {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hello@example.com", cwd: dir } }),
        encoding: "utf8",
        env: { ...process.env, CLOTR_GUARD_DATA_DIR: dir },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, "ask", result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each finding's range covers its own value whatever order the engine finds them in", () => {
  const text = `card ${CARD_NUMBER}\nthen ${AWS_KEY}`;
  const { findings } = check(text);
  const card = findings.find((finding) => finding.kind === "credit_card");
  const key = findings.find((finding) => finding.kind === "aws_access_key");
  assert.equal(text.slice(card.start, card.end), CARD_NUMBER);
  assert.equal(text.slice(key.start, key.end), AWS_KEY);
});

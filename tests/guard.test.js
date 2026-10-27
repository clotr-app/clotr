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
const { bestOfPair, grewMoreThan } = require("./timing.js");
const { build } = require("../tools/engine-bundle.js");
const { makeSecrets } = require("./fixtures/secrets.js");
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
  clineHookSource,
  toolSettingsPath,
  checkStaged,
  setupGit,
  main,
  mergeHook,
  isNpxCachePath,
  formatCommitIssue,
  managedHooks,
  IMPLEMENTED_TOOL_NAMES,
  nodeCommand,
  hookCommand,
  parseHookCommand,
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
  const tarball = path.join(tempRoot, "clotr-guard-0.1.1.tgz");
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

function commandText(hook) {
  if (Array.isArray(hook?.args)) return [hook.command, ...hook.args].join(" ");
  const source = hook?.command || hook?.commandWindows || hook?.powershell || "";
  return parseHookCommand(source)?.join(" ") || source;
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

test("Guard's engine agrees with a small public fixture and registry-token cases for the current extension version", () => {
  const source = fs.readFileSync(ENGINE_PATH, "utf8");
  const version = /^\/\/ Clotr engine (\d+(?:\.\d+){2,3}):/m.exec(source)?.[1];
  assert.equal(
    version,
    JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8")).version,
  );

  const serviceTokens = makeSecrets()
    .find((sample) => sample.kind === "service_token")
    .shapes.filter((shape) => /^(openvsx|rubygems|jetbrainsMarketplace)/.test(shape.name))
    .map((shape) => ({ id: shape.name, text: shape.text }));
  assert.ok(serviceTokens.some((item) => item.id === "openvsxBare"));
  assert.ok(serviceTokens.some((item) => item.id === "rubygemsBare"));
  assert.ok(serviceTokens.some((item) => item.id === "jetbrainsMarketplaceBare"));
  const cases = [
    { id: "clean-prompt", text: "Write a small sorting function." },
    {
      id: "rsa-ciphertext",
      text: "1972 824 1992 3031 2549 1730 2211 1992 615 2041 3086 1992 1211 3031 1188 1730 1387 1992 2100",
    },
    ...serviceTokens,
  ];
  const guardContext = vm.createContext({});
  vm.runInContext(source, guardContext, { filename: "clotr-engine.js" });
  const extensionContext = vm.createContext({});
  for (const file of ["patterns.js", "detector.js"]) {
    const script = fs.readFileSync(path.join(__dirname, "../extension", file), "utf8");
    vm.runInContext(script, extensionContext, { filename: file });
  }

  const findings = (context, text) => {
    const rows = [];
    for (const detection of context.Clotr.detect(text)) {
      for (const value of detection.matches) {
        const reason = detection.reasonOf ? detection.reasonOf.get(value) : undefined;
        let start = value ? text.indexOf(value) : -1;
        if (start < 0) rows.push({ kind: detection.id, severity: detection.severity, value, reason });
        for (; start >= 0; start = text.indexOf(value, start + 1)) {
          rows.push({
            kind: detection.id,
            severity: detection.severity,
            start,
            end: start + value.length,
            value,
            reason,
          });
        }
      }
      if (detection.asks) rows.push({ kind: detection.id, asks: detection.asks });
    }
    return rows;
  };
  for (const item of cases) {
    assert.equal(
      JSON.stringify(findings(guardContext, item.text)),
      JSON.stringify(findings(extensionContext, item.text)),
      `${item.id} differs from the extension engine`,
    );
  }
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
    const hook = smokeSettings.hooks.UserPromptSubmit[0].hooks[0];
    assert.ok(commandText(hook).includes(home));
    const shell = spawnSync(hook.command, hook.args, {
      input: JSON.stringify({ prompt: PROMPT }),
      encoding: "utf8",
      env: { ...env, CLOTR_GUARD_DATA_DIR: path.join(root, "data") },
    });
    assert.equal(shell.status, 0, `${shell.stdout}\n${shell.stderr}`);
    assert.match(JSON.parse(shell.stdout).reason, /within 2 minutes/);
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
        handlers.filter(
          (item) => commandText(item).includes("clotr-guard.js") && commandText(item).includes("hook claude"),
        ).length,
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

test("random and oversized hook input stop for review without echoing the payload", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const random = spawnSync(process.execPath, [script, "hook", "claude"], {
    input: crypto.randomBytes(4 * 1024),
    encoding: "utf8",
    maxBuffer: 4096,
  });
  assert.equal(random.status, 0, random.stderr);
  assert.equal(JSON.parse(random.stdout).decision, "block");
  assert.match(`${random.stdout}${random.stderr}`, /couldn't check this prompt.*stopped/i);

  const prompt = JSON.stringify({ prompt: "x".repeat(10 * 1024 * 1024) });
  const large = spawnSync(process.execPath, [script, "hook", "claude"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 4096,
  });
  assert.equal(large.status, 0, large.stderr);
  assert.equal(JSON.parse(large.stdout).decision, "block");
  assert.match(`${large.stdout}${large.stderr}`, /1 MiB/i);
  assert.doesNotMatch(`${large.stdout}${large.stderr}`, /x{100}/);
  assert.ok(Buffer.byteLength(large.stdout) < 4096);
  assert.ok(Buffer.byteLength(large.stderr) < 4096);
});

test("hook input with a byte order mark or CRLF is still checked", () => {
  // Windows PowerShell pipes text with a UTF-8 byte order mark and a CRLF, or as UTF-16 with its own mark.
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const encodings = {
    "UTF-8 with BOM and CRLF": (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${text}\r\n`)]),
    "UTF-16LE with BOM": (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${text}\r\n`, "utf16le")]),
    "UTF-16BE with BOM": (text) =>
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${text}\r\n`, "utf16le").swap16()]),
  };
  for (const [name, encode] of Object.entries(encodings)) {
    // A fresh state folder each time, so the second send of the same prompt isn't let through.
    const state = tempDir();
    const env = { ...process.env, HOME: state, USERPROFILE: state, LOCALAPPDATA: state, XDG_STATE_HOME: state };
    try {
      const blocked = spawnSync(process.execPath, [script, "hook", "claude"], {
        input: encode(JSON.stringify({ prompt: PROMPT, hook_event_name: "UserPromptSubmit" })),
        encoding: "utf8",
        env,
      });
      assert.equal(blocked.status, 0, `${name}: ${blocked.stdout}${blocked.stderr}`);
      assert.match(JSON.parse(blocked.stdout).reason, /AWS Access Key/, name);
      assert.doesNotMatch(JSON.parse(blocked.stdout).reason, /AKIA|3N/, name);

      const clean = spawnSync(process.execPath, [script, "hook", "claude"], {
        input: encode(JSON.stringify({ prompt: "A clean prompt", hook_event_name: "UserPromptSubmit" })),
        encoding: "utf8",
        env,
      });
      assert.equal(clean.status, 0, `${name}: ${clean.stdout}${clean.stderr}`);
      assert.doesNotMatch(`${clean.stdout}${clean.stderr}`, /couldn't check/, name);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  }
});

test("each tool's stdin hook has its documented block and clean output", () => {
  const expected = {
    claude: (output) => {
      const response = JSON.parse(output.stdout);
      return output.code === 0 && response.decision === "block" && response.reason.includes("within 2 minutes");
    },
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
      assert.equal(sample.status, 0, tool);
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

test("the same findings can pass after a small edit, but a new secret blocks and resets the two-minute window", () => {
  const dir = tempDir();
  const stateFile = path.join(dir, "prompt-repeat.json");
  try {
    const blocked = inspectPrompt("claude", PROMPT, { dataDir: dir, now: 10_000 });
    assert.equal(blocked.action, "block");
    const saved = fs.readFileSync(stateFile, "utf8");
    assert.equal(saved.includes(PROMPT), false);
    assert.equal(saved.includes(AWS_KEY), false);
    assert.equal(saved.includes(CARD_NUMBER), false);
    const state = JSON.parse(saved);
    assert.deepEqual(Object.keys(state).sort(), ["at", "fingerprints", "salt"]);
    assert.equal(state.fingerprints.length, blocked.findings.length);
    assert.ok(state.fingerprints.every((fingerprint) => /^[0-9a-f]{64}$/.test(fingerprint)));

    assert.equal(inspectPrompt("claude", PROMPT, { dataDir: dir, now: 10_001 }).action, "allow");
    const edited = `${PROMPT}\n\nPlease explain what happened.`;
    assert.equal(inspectPrompt("claude", edited, { dataDir: dir, now: 10_002 }).action, "allow");

    const addedSecret = `${edited}\npassword: NewSecret7x`;
    assert.equal(inspectPrompt("claude", addedSecret, { dataDir: dir, now: 10_003 }).action, "block");
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(updatedState.fingerprints.length, state.fingerprints.length + 1);
    assert.equal(fs.readFileSync(stateFile, "utf8").includes("NewSecret7x"), false);
    assert.equal(
      inspectPrompt("claude", `${addedSecret}\nPlease summarize the failure.`, { dataDir: dir, now: 10_004 }).action,
      "allow",
    );
    assert.equal(inspectPrompt("claude", addedSecret, { dataDir: dir, now: 130_002 }).action, "allow");
    assert.equal(inspectPrompt("claude", addedSecret, { dataDir: dir, now: 130_003 }).action, "block");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeat state is private, atomic, and cannot authorize through a symlink", () => {
  const root = tempDir();
  const dataDir = path.join(root, "state");
  const outside = path.join(root, "outside.json");
  const stateFile = path.join(dataDir, "prompt-repeat.json");
  const sentinel = "leave this file unchanged\n";
  try {
    if (process.platform === "win32") {
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "sentinel"), sentinel);
      fs.symlinkSync(outside, dataDir, "junction");
      assert.equal(inspectPrompt("claude", PROMPT, { dataDir, now: 10_000 }).action, "block");
      assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), sentinel);
      assert.equal(fs.existsSync(path.join(outside, "prompt-repeat.json")), false);
      fs.rmSync(dataDir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(dataDir);
      fs.writeFileSync(outside, sentinel);
      fs.symlinkSync(outside, stateFile);
      assert.equal(inspectPrompt("claude", PROMPT, { dataDir, now: 10_000 }).action, "block");
      assert.equal(fs.lstatSync(stateFile).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(outside, "utf8"), sentinel);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    assert.equal(inspectPrompt("claude", PROMPT, { dataDir, now: 10_001 }).action, "block");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude's block reason names the findings without showing their values", () => {
  const dir = tempDir();
  const prompt = Array.from({ length: 7 }, (_, index) => `password: TestSecret${index}42`).join("\n");
  try {
    const outcome = inspectPrompt("claude", prompt, { dataDir: dir, now: 10_000 });
    const output = hookOutput("claude", outcome);
    assert.equal(output.code, 0);
    const response = JSON.parse(output.stdout);
    assert.equal(response.decision, "block");
    assert.deepEqual(response.hookSpecificOutput, {
      hookEventName: "UserPromptSubmit",
      suppressOriginalPrompt: true,
    });
    const lines = response.reason.split("\n");
    assert.match(lines[0], /Password or Secret/);
    assert.match(lines[0], /this prompt/);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(response.reason, /TestSecret/);
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

test("Gemini CLI and Cline read hooks resolve workspace-relative paths", () => {
  const dir = tempDir();
  const project = path.join(dir, "project");
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "notes.txt"), "A clean project note.");
  fs.writeFileSync(path.join(project, "credentials.txt"), `Use this key ${AWS_KEY}`);
  const events = {
    gemini: (file) => ({
      cwd: project,
      session_id: "session-1",
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
      tool_input: { absolute_path: file },
    }),
    cline: (file) => ({
      workspaceRoots: [project],
      hookName: "PreToolUse",
      sessionId: "session-1",
      preToolUse: { toolName: "read_file", parameters: { path: file } },
    }),
  };
  try {
    for (const tool of Object.keys(events)) {
      const run = (file) =>
        spawnSync(process.execPath, [script, "read", tool], {
          cwd: dir,
          input: JSON.stringify(events[tool](file)),
          encoding: "utf8",
          env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, `${tool}-state`) },
        });
      const clean = run("notes.txt");
      assert.equal(clean.status, 0, clean.stderr);
      const cleanOutput = JSON.parse(clean.stdout);
      assert.notEqual(cleanOutput.decision, "deny", `${tool} clean relative read`);
      assert.notEqual(cleanOutput.cancel, true, `${tool} clean relative read`);

      const secret = run("credentials.txt");
      assert.equal(secret.status, 0, secret.stderr);
      const secretOutput = JSON.parse(secret.stdout);
      if (tool === "gemini") assert.equal(secretOutput.decision, "deny");
      else assert.equal(secretOutput.cancel, true);
      assert.doesNotMatch(secret.stdout, new RegExp(AWS_KEY));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("newer Gemini hook payloads with extra fields remain checked", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  const dir = tempDir();
  const run = (prompt) =>
    spawnSync(process.execPath, [script, "hook", "gemini"], {
      input: JSON.stringify({
        prompt,
        cwd: process.cwd(),
        session_id: "session-1",
        hook_event_name: "BeforeAgent",
        transcript_path: path.join(os.tmpdir(), "transcript.jsonl"),
        extension_payload: { version: 2, optional: true },
      }),
      encoding: "utf8",
      env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(dir, "state") },
    });
  try {
    const clean = run("A safe prompt");
    assert.equal(clean.status, 0, clean.stderr);
    assert.notEqual(JSON.parse(clean.stdout).decision, "deny");
    const secret = run(`Use this key ${AWS_KEY}`);
    assert.equal(secret.status, 0, secret.stderr);
    assert.equal(JSON.parse(secret.stdout).decision, "deny");
    assert.doesNotMatch(secret.stdout, new RegExp(AWS_KEY));
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

test("Windsurf settings can be set up and removed", () => {
  const dir = tempDir();
  const cwd = path.join(dir, "project");
  const original = { hooks: { pre_user_prompt: [{ command: "keep this" }] }, theme: "dark" };
  fs.mkdirSync(cwd, { recursive: true });
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

    const currentProject = path.join(cwd, ".devin", "hooks.json");
    assert.equal(toolSettingsPath("windsurf", { project: true, cwd, home: dir }), currentProject);
    const project = updateSettings("windsurf", { project: true, cwd, home: dir });
    assert.ok(project.settings.hooks.pre_user_prompt.some((hook) => commandText(hook).includes("clotr-guard.js")));
    assert.ok(fs.existsSync(currentProject));
    updateSettings("windsurf", { project: true, cwd, home: dir, remove: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(currentProject, "utf8")), {});

    const legacyProject = path.join(cwd, ".windsurf", "hooks.json");
    fs.mkdirSync(path.dirname(legacyProject), { recursive: true });
    fs.writeFileSync(legacyProject, JSON.stringify(original));
    assert.equal(toolSettingsPath("windsurf", { project: true, cwd, home: dir }), legacyProject);
    updateSettings("windsurf", { project: true, cwd, home: dir });
    assert.ok(JSON.parse(fs.readFileSync(legacyProject, "utf8")).hooks.pre_read_code);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cline setup writes the documented hook files, previews without writing, and removes them", () => {
  const home = tempDir();
  const cwd = path.join(home, "project");
  const global = path.join(home, "Documents", "Cline", "Hooks");
  const project = path.join(cwd, ".clinerules", "hooks");
  const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    assert.ok(IMPLEMENTED_TOOL_NAMES.includes("cline"));
    const dry = updateClineHooks({ home, cwd, platform: "linux", dryRun: true });
    assert.equal(dry.changed, true);
    assert.equal(dry.file, global);
    assert.equal(fs.existsSync(global), false);

    const first = updateClineHooks({ home, cwd, platform: "linux" });
    assert.equal(first.changed, true);
    assert.equal(first.event, "UserPromptSubmit, PreToolUse");
    for (const [directory, promptArgs, readArgs] of [
      [
        global,
        [script, "hook", "cline", "--min-severity", "medium"],
        [script, "read", "cline", "--min-severity", "medium"],
      ],
      [
        project,
        [script, "hook", "cline", "--min-severity", "medium"],
        [script, "read", "cline", "--min-severity", "medium"],
      ],
    ]) {
      if (directory === project) {
        const added = updateClineHooks({ home, cwd, platform: "linux", project: true });
        assert.equal(added.changed, true);
      }
      for (const [name, args] of [
        ["UserPromptSubmit", promptArgs],
        ["PreToolUse", readArgs],
      ]) {
        const file = path.join(directory, name);
        assert.equal(path.extname(file), "", "Cline hook names have no extension");
        const source = fs.readFileSync(file, "utf8");
        assert.ok(source.startsWith("#!/bin/sh\n"));
        assert.ok(source.includes(JSON.stringify(args)));
        if (name === "UserPromptSubmit") assert.match(source, /1 MiB/i);
        if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o755);
      }
    }
    const prompt = path.join(global, "UserPromptSubmit");
    const written = fs.readFileSync(prompt, "utf8");
    assert.equal(updateClineHooks({ home, cwd, platform: "linux" }).changed, false);
    assert.equal(fs.readFileSync(prompt, "utf8"), written);
    if (process.platform !== "win32") {
      const clineCall = spawnSync(prompt, [], {
        input: JSON.stringify({ userPromptSubmit: { prompt: PROMPT } }),
        encoding: "utf8",
        env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(home, "state") },
      });
      assert.equal(clineCall.status, 0, clineCall.stderr);
      assert.equal(JSON.parse(clineCall.stdout).cancel, true);
      assert.doesNotMatch(clineCall.stdout, new RegExp(AWS_KEY));

      const oversizedPrompt = spawnSync(prompt, [], {
        input: JSON.stringify({ userPromptSubmit: { prompt: "x".repeat(1024 * 1024) } }),
        encoding: "utf8",
        env: { ...process.env, CLOTR_GUARD_DATA_DIR: path.join(home, "large-state") },
      });
      assert.equal(oversizedPrompt.status, 0, oversizedPrompt.stderr);
      assert.equal(JSON.parse(oversizedPrompt.stdout).cancel, true);
      assert.match(oversizedPrompt.stdout, /1 MiB/i);
    }
    const removeDry = updateClineHooks({ home, cwd, platform: "linux", remove: true, dryRun: true });
    assert.equal(removeDry.changed, true);
    assert.equal(fs.existsSync(prompt), true);
    assert.equal(updateClineHooks({ home, cwd, platform: "linux", remove: true }).changed, true);
    assert.equal(fs.existsSync(prompt), false);
    assert.equal(fs.existsSync(path.join(global, "PreToolUse")), false);
    assert.equal(fs.existsSync(path.join(project, "UserPromptSubmit")), true);
    updateClineHooks({ home, cwd, platform: "linux", project: true, remove: true });
    assert.equal(fs.existsSync(path.join(project, "UserPromptSubmit")), false);
    assert.equal(updateClineHooks({ home, cwd, platform: "linux", remove: true }).changed, false);
    assert.throws(() => updateClineHooks({ home, cwd, platform: "win32" }), /unsupported-on-windows/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline setup upgrades its previous exact v1 hook without chaining a duplicate", () => {
  const home = tempDir();
  const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
  const node = nodeCommand();
  try {
    updateClineHooks({ home, platform: "linux" });
    const hook = path.join(home, "Documents", "Cline", "Hooks", "UserPromptSubmit");
    const backup = `${hook}.clotr-guard.bak`;
    const previous = clineHookSource(
      {
        name: "UserPromptSubmit",
        backup,
        script,
        node,
        minimum: "medium",
        includePersonalDetails: false,
        chain: false,
      },
      false,
    );
    assert.doesNotMatch(previous, /1 MiB/i);
    fs.writeFileSync(hook, previous, { mode: 0o755 });

    const upgraded = updateClineHooks({ home, platform: "linux" });
    assert.equal(upgraded.changed, true);
    assert.match(fs.readFileSync(hook, "utf8"), /1 MiB/i);
    assert.equal(fs.existsSync(backup), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(
  "Cline's installed hook never selects Node from the workspace PATH",
  { skip: process.platform === "win32" },
  () => {
    const home = tempDir();
    const cwd = path.join(home, "project");
    const fakeBin = path.join(home, "fake bin");
    const marker = path.join(home, "fake-node-ran");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeNode = path.join(fakeBin, "node");
    fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf yes > '${marker}'\nexec '${process.execPath}' "$@"\n`, {
      mode: 0o755,
    });
    const hookFile = path.join(home, "Documents", "Cline", "Hooks", "UserPromptSubmit");
    try {
      updateClineHooks({ home, cwd, platform: "linux" });
      const run = spawnSync(hookFile, [], {
        cwd,
        input: JSON.stringify({ userPromptSubmit: { prompt: PROMPT } }),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          CLOTR_GUARD_DATA_DIR: path.join(home, "state"),
        },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.existsSync(marker), false, "the project PATH supplied a replacement Node");
      assert.equal(JSON.parse(run.stdout).cancel, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test("Cline hook scripts invoke the pinned Node directly instead of env searching PATH", () => {
  const home = tempDir();
  try {
    const result = updateClineHooks({ home, platform: "linux" });
    const source = fs.readFileSync(path.join(result.file, "UserPromptSubmit"), "utf8");
    assert.match(source, /^#!\/bin\/sh\n/);
    assert.doesNotMatch(source, /^#!\/usr\/bin\/env node\n/);
    assert.ok(source.includes(process.execPath));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline setup recognizes and removes an exact hook from the previous Guard wrapper format", () => {
  const home = tempDir();
  const directory = path.join(home, "Documents", "Cline", "Hooks");
  const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "UserPromptSubmit");
  const args = [script, "hook", "cline", "--min-severity", "medium"];
  const legacy = `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const input=require("node:fs").readFileSync(0,"utf8");const out=spawnSync(${JSON.stringify(process.execPath)},${JSON.stringify(args)},{input,encoding:"utf8"});if(out.stdout)process.stdout.write(out.stdout);if(out.stderr)process.stderr.write(out.stderr);process.exit(out.status||0);\n`;
  fs.writeFileSync(file, legacy, { mode: 0o755 });
  try {
    assert.equal(updateClineHooks({ home, platform: "linux", minimum: "high" }).changed, true);
    assert.match(fs.readFileSync(file, "utf8"), /^#!\/bin\/sh\n/);
    assert.equal(updateClineHooks({ home, platform: "linux", remove: true }).changed, true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline hook setup reports the Windows limit and removal stays available", async () => {
  const home = tempDir();
  const errors = [];
  const error = console.error;
  try {
    assert.throws(() => updateClineHooks({ home, platform: "win32" }), /unsupported-on-windows/);
    console.error = (...parts) => errors.push(parts.join(" "));
    assert.equal(await main(["setup", "cline"], { cwd: home, home, platform: "win32" }), 2);
    assert.deepEqual(errors, ["Cline hooks are supported on macOS and Linux only."]);
    assert.deepEqual(fs.readdirSync(home), []);
    console.error = error;
    const result = updateClineHooks({ home, platform: "linux" });
    assert.equal(result.changed, true);
    const prompt = path.join(result.file, "UserPromptSubmit");
    assert.equal(updateClineHooks({ home, platform: "win32", remove: true }).changed, true);
    assert.equal(fs.existsSync(prompt), false);
  } finally {
    console.error = error;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("assistant hook files use the current documented event and command shapes", () => {
  const claude = mergeHook({}, "claude").hooks;
  assert.ok(commandText(claude.UserPromptSubmit[0].hooks[0]).includes("hook claude"));
  assert.ok(commandText(claude.PreToolUse[0].hooks[0]).includes("read claude"));

  const cursor = mergeHook({}, "cursor");
  assert.equal(cursor.version, 1);
  assert.ok(commandText(cursor.hooks.beforeSubmitPrompt[0]).includes("hook cursor"));
  assert.ok(commandText(cursor.hooks.beforeReadFile[0]).includes("read cursor"));

  const gemini = mergeHook({}, "gemini").hooks;
  assert.ok(commandText(gemini.BeforeAgent[0].hooks[0]).includes("hook gemini"));
  assert.ok(commandText(gemini.BeforeTool[0].hooks[0]).includes("read gemini"));

  const codex = mergeHook({}, "codex").hooks;
  assert.ok(commandText(codex.UserPromptSubmit[0].hooks[0]).includes("hook codex"));
  assert.equal(codex.PreToolUse, undefined);

  const windsurf = mergeHook({}, "windsurf").hooks;
  assert.equal(windsurf.pre_user_prompt[0].show_output, true);
  assert.ok(commandText(windsurf.pre_user_prompt[0]).includes("hook windsurf"));
  assert.ok(commandText(windsurf.pre_read_code[0]).includes("read windsurf"));

  const dir = tempDir();
  try {
    const cline = updateClineHooks({ home: dir, platform: "linux" });
    assert.deepEqual(
      cline.hooks.map(({ event }) => event),
      ["UserPromptSubmit", "PreToolUse"],
    );
    for (const name of ["UserPromptSubmit", "PreToolUse"]) {
      assert.ok(fs.readFileSync(path.join(cline.file, name), "utf8").startsWith("#!/bin/sh\n"));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows assistant settings use the documented user paths", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path behavior runs on Windows");
    return;
  }
  const home = "C:\\Users\\fixture";
  for (const [tool, expected] of [
    ["claude", path.win32.join(home, ".claude", "settings.json")],
    ["cursor", path.win32.join(home, ".cursor", "hooks.json")],
    ["gemini", path.win32.join(home, ".gemini", "settings.json")],
    ["codex", path.win32.join(home, ".codex", "hooks.json")],
    ["windsurf", path.win32.join(home, ".codeium", "windsurf", "hooks.json")],
    ["cline", path.win32.join(home, "Documents", "Cline", "Hooks")],
  ]) {
    assert.equal(toolSettingsPath(tool, { home }), expected, tool);
  }
});

test("Windsurf JetBrains setup and removal use its separate user hooks file", async () => {
  const root = tempDir();
  const home = path.join(root, "home");
  const jetBrainsFile = path.join(home, ".codeium", "hooks.json");
  const desktopFile = path.join(home, ".codeium", "windsurf", "hooks.json");
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(toolSettingsPath("windsurf", { home, windsurfJetBrains: true }), jetBrainsFile);
    assert.equal(await main(["setup", "windsurf", "--windsurf-jetbrains"], { home, cwd: root }), 0);
    assert.ok(fs.existsSync(jetBrainsFile));
    assert.equal(fs.existsSync(desktopFile), false);
    assert.equal(await main(["remove", "windsurf", "--windsurf-jetbrains"], { home, cwd: root }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(jetBrainsFile, "utf8")), {});
    assert.equal(fs.existsSync(desktopFile), false);
  } finally {
    console.log = log;
    console.error = error;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cline leaves older backups and hooks it does not own untouched", () => {
  const home = tempDir();
  try {
    const directory = path.join(home, "Documents", "Cline", "Hooks");
    fs.mkdirSync(directory, { recursive: true });
    const prompt = path.join(directory, "UserPromptSubmit");
    const backup = `${prompt}.clotr-guard.bak`;
    fs.writeFileSync(prompt, "#!/usr/bin/env node\nconsole.log('{}');\n", { mode: 0o755 });
    fs.writeFileSync(backup, "older backup\n");
    assert.throws(() => updateClineHooks({ home, platform: "linux" }), /cline-hook-backup-exists/);
    assert.equal(updateClineHooks({ home, platform: "linux", remove: true }).changed, false);
    assert.equal(fs.readFileSync(prompt, "utf8"), "#!/usr/bin/env node\nconsole.log('{}');\n");
    assert.equal(fs.readFileSync(backup, "utf8"), "older backup\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("each assistant setup can preview without writing", () => {
  const dir = tempDir();
  const cwd = path.join(dir, "project");
  const home = path.join(dir, "home");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    for (const tool of IMPLEMENTED_TOOL_NAMES) {
      const result = updateSettings(tool, { cwd, home, project: true, dryRun: true, platform: "linux" });
      assert.equal(result.changed, true, tool);
      if (tool === "cline") {
        assert.equal(result.hooks.length, 2);
        assert.deepEqual(
          result.hooks.map(({ event }) => event),
          ["UserPromptSubmit", "PreToolUse"],
        );
        assert.equal(fs.existsSync(result.file), false);
      } else {
        assert.equal(fs.existsSync(result.file), false, tool);
        assert.ok(result.settings.hooks, tool);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the setup and remove commands are dry-run safe and idempotent for every assistant", async () => {
  const root = tempDir();
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  const log = console.log;
  const error = console.error;
  const output = [];
  console.log = (...parts) => output.push(parts.join(" "));
  console.error = (...parts) => output.push(parts.join(" "));
  const run = async (args) => {
    output.length = 0;
    const code = await main(args, { cwd, home, platform: "linux" });
    return { code, output: [...output] };
  };
  try {
    for (const tool of IMPLEMENTED_TOOL_NAMES) {
      const file = toolSettingsPath(tool, { project: true, cwd, home });
      const dry = await run(["setup", tool, "--project", "--dry-run"]);
      assert.equal(dry.code, 0, tool);
      assert.ok(
        dry.output.some((line) => line.includes("dry run")),
        tool,
      );
      const previewOutput = dry.output.find((line) => line.startsWith("{"));
      assert.ok(previewOutput, `${tool}: the dry run shows the exact hook content`);
      const preview = JSON.parse(previewOutput);
      assert.ok(preview.file, `${tool}: the dry run names the file it will write`);
      if (tool === "cline") {
        assert.deepEqual(
          preview.hooks.map(({ event }) => event),
          ["UserPromptSubmit", "PreToolUse"],
        );
      } else {
        assert.deepEqual(preview.file, file, tool);
        assert.ok(Object.keys(preview.hooks).length > 0, `${tool}: the dry run shows Guard's hook entries`);
      }
      assert.equal(fs.existsSync(file), false, tool);

      const first = await run(["setup", tool, "--project"]);
      assert.equal(first.code, 0, `${tool}: ${first.output}`);
      assert.equal(managedHooks(tool, { project: true, cwd, home }).length > 0, true, tool);
      const repeated = await run(["setup", tool, "--project"]);
      assert.equal(repeated.code, 0, tool);
      assert.ok(
        repeated.output.some((line) => line.includes("no change")),
        tool,
      );

      const removed = await run(["remove", tool, "--project"]);
      assert.equal(removed.code, 0, `${tool}: ${removed.output}`);
      assert.deepEqual(managedHooks(tool, { project: true, cwd, home }), [], tool);
      const removedAgain = await run(["remove", tool, "--project"]);
      assert.equal(removedAgain.code, 0, tool);
      assert.ok(
        removedAgain.output.some((line) => line.includes("no change")),
        tool,
      );
    }
  } finally {
    console.log = log;
    console.error = error;
    fs.rmSync(root, { recursive: true, force: true });
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
    assert.match(result.stderr, /"large\.js".*split the change or keep large generated files out of the repository/i);
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

test("a Git pre-commit hook uses its pinned Node even when PATH has no Node", () => {
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
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /aws_access_key/);
    assert.doesNotMatch(result.stderr, /node isn't on PATH/);
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

  const command = mergeHook({}, "claude").hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(command.args.includes("--personal-details"), false);
  const optedIn = mergeHook({}, "claude", false, "medium", true).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(optedIn.args.at(-1), "--personal-details");
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
    assert.equal(optedIn.status, 0);
    const response = JSON.parse(optedIn.stdout);
    assert.equal(response.decision, "block");
    assert.match(response.reason, /within 2 minutes/);
    assert.doesNotMatch(response.reason, /123 Main Street, Springfield, IL 62704/);
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
  assert.equal(command, path.resolve(process.execPath));
  assert.equal(path.isAbsolute(command), true);
});

test("generated shell hooks quote executable and script paths across PowerShell and POSIX shells", () => {
  const cases = [
    {
      platform: "win32",
      node: "C:\\Program Files\\Node & $100%\\node.exe",
      script: "C:\\Program Files\\Clotr's $App\\clotr-guard.js",
    },
    {
      platform: "linux",
      node: "/opt/Node & $100%/node",
      script: "/opt/Clotr's $App/clotr-guard.js",
    },
  ];
  for (const item of cases) {
    const hook = hookCommand("cursor", "prompt", "medium", false, item);
    assert.deepEqual(
      parseHookCommand(hook.command),
      [item.node, path.resolve(item.script), "hook", "cursor", "--min-severity", "medium"],
      item.platform,
    );
    assert.equal(parseHookCommand(`${hook.command}; echo unsafe`), null, item.platform);
  }
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
    assert.match(shown, /Internal IP Address/, tool);
    assert.equal(shown.includes("192.168.1.20"), false, tool);
    assert.doesNotMatch(shown, /192\.168|1\.20/, tool);
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
  const bothOutput = hookOutput("claude", both).stdout;
  assert.match(bothOutput, /AWS Access Key/);
  assert.match(bothOutput, /Internal IP Address/);
  assert.doesNotMatch(bothOutput, /192\.168|1\.20|AKIA|3N/);

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
  const commands = result.settings.hooks.PreToolUse.flatMap((group) => group.hooks.map(commandText));
  assert.ok(
    commands
      .filter((command) => command.includes(" read claude "))
      .every((command) => command.endsWith("--personal-details")),
  );
});

// The full corpus and parity helper stay in private source checkouts; the public export
// keeps the small synthetic fixture above and does not ship the oracle corpus.
const ENGINE_PARITY_PATH = path.join(__dirname, "../tools/engine-parity.js");
if (fs.existsSync(ENGINE_PARITY_PATH)) {
  const { corpora, withAnswers, differences, pageScripts } = require(ENGINE_PARITY_PATH);
  test("Guard's engine agrees with the shared fixture corpus and registry-token cases for the current extension version", () => {
    const source = fs.readFileSync(ENGINE_PATH, "utf8");
    const version = /^\/\/ Clotr engine (\d+(?:\.\d+){2,3}):/m.exec(source)?.[1];
    assert.equal(
      version,
      JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8")).version,
    );

    const serviceTokens = makeSecrets()
      .find((sample) => sample.kind === "service_token")
      .shapes.filter((shape) => /^(openvsx|rubygems|jetbrainsMarketplace)/.test(shape.name))
      .map((shape) => ({ id: shape.name, text: shape.text }));
    const sets = [
      ...corpora({ size: 400 }),
      {
        id: "engine-fixes",
        files: [],
        check: "detect",
        items: [
          {
            id: "840e39e7 RSA ciphertext",
            text: "1972 824 1992 3031 2549 1730 2211 1992 615 2041 3086 1992 1211 3031 1188 1730 1387 1992 2100",
          },
          ...serviceTokens,
        ],
      },
    ];
    const context = vm.createContext({});
    vm.runInContext(source, context, { filename: "clotr-engine.js" });
    for (const script of pageScripts().slice(1)) vm.runInContext(script, context);
    const guardFindings = vm.runInContext("globalThis.__clotrFind", context);

    for (const set of withAnswers(sets)) {
      const got = set.items.map((item) => JSON.stringify(guardFindings(set.check, item)));
      assert.deepEqual(
        differences(
          set.items.map((item) => `${set.id} ${item.id}`),
          set.expected,
          got,
        ),
        [],
        `${set.id} differs from the extension engine`,
      );
    }
  });
}

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
  assert.match(output.stdout, /shell command.*secret file.*\.env/i);
  assert.match(output.stdout, /variable names or the example file/i);
  assert.equal(inspectShell("claude", { tool_name: "Bash", tool_input: { command: "cat README.md" } }).action, "allow");
  assert.equal(
    inspectShell("claude", { tool_name: "Bash", tool_input: { command: "Get-Content .env.example" } }).action,
    "allow",
  );
  const environment = inspectShell("claude", { tool_name: "Bash", tool_input: { command: "printenv" } });
  assert.equal(environment.secretFile, true);
  assert.match(JSON.stringify(readHookOutput("claude", environment)), /shell command.*environment/i);
});

test("Claude PowerShell hooks check secret-file readers and allow ordinary reads", () => {
  const dir = tempDir();
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  fs.writeFileSync(path.join(dir, ".env"), `TOKEN=${AWS_KEY}`);
  try {
    const run = (command) =>
      spawnSync(process.execPath, [script, "shell", "claude"], {
        input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command, cwd: dir } }),
        encoding: "utf8",
      });
    const ordinary = run("Get-Content README.md");
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.notEqual(JSON.parse(ordinary.stdout).hookSpecificOutput?.permissionDecision, "deny");

    const secret = run("Get-Content .env");
    assert.equal(secret.status, 0, secret.stderr);
    const output = JSON.parse(secret.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /secret file.*\.env/i);
    assert.doesNotMatch(secret.stdout, new RegExp(AWS_KEY));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("malformed hook input is stopped for review through each tool's hook output", () => {
  const script = path.join(__dirname, "../apps/guard/bin/clotr-guard.js");
  for (const tool of IMPLEMENTED_TOOL_NAMES) {
    const result = spawnSync(process.execPath, [script, "hook", tool], { input: "{", encoding: "utf8" });
    assert.equal(result.status, tool === "windsurf" ? 2 : 0, tool);
    if (tool === "windsurf") {
      assert.match(result.stderr, /couldn't check this prompt.*stopped/i);
      continue;
    }
    const payload = JSON.parse(result.stdout);
    if (tool === "cursor") assert.equal(payload.continue, false, tool);
    else if (tool === "cline") assert.equal(payload.cancel, true, tool);
    else assert.ok(payload.decision === "block" || payload.decision === "deny", tool);
    assert.doesNotMatch(result.stdout, new RegExp(AWS_KEY), tool);
    assert.equal(result.stderr, "", tool);
  }
  const oversized = spawnSync(process.execPath, [script, "hook", "claude"], {
    input: `${AWS_KEY}${"x".repeat(1024 * 1024)}`,
    encoding: "utf8",
  });
  assert.equal(oversized.status, 0);
  assert.equal(JSON.parse(oversized.stdout).decision, "block");
  assert.doesNotMatch(oversized.stdout, new RegExp(AWS_KEY));
});

test("setup registers Claude MCP and Cursor shell and MCP boundary hooks", () => {
  const home = tempDir();
  const claude = updateSettings("claude", { home, dryRun: true }).settings;
  const preTool = claude.hooks.PreToolUse;
  assert.ok(
    preTool.some((group) => group.matcher === "^mcp__" && commandText(group.hooks[0]).includes(" tool claude ")),
  );
  const cursor = updateSettings("cursor", { home, dryRun: true }).settings;
  for (const event of ["beforeShellExecution", "beforeMCPExecution"]) {
    assert.ok(
      cursor.hooks[event].some((hook) =>
        commandText(hook).includes(` ${event === "beforeShellExecution" ? "shell" : "tool"} cursor `),
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
      if (tool === "claude") {
        assert.ok(first.settings.hooks.PreToolUse.some((group) => group.matcher === "^(?:Bash|PowerShell)$"));
      }
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

test("settings setup and removal preserve commands that only contain Guard-like text", () => {
  const home = tempDir();
  const file = toolSettingsPath("claude", { project: false, home });
  const custom = {
    type: "command",
    command: `echo before; node /opt/clotr-guard.js hook claude --min-severity medium; echo after`,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [custom] }] } }));
  try {
    updateSettings("claude", { home });
    let settings = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(
      settings.hooks.UserPromptSubmit.some((group) =>
        group.hooks.some((hook) => JSON.stringify(hook) === JSON.stringify(custom)),
      ),
    );
    updateSettings("claude", { home, remove: true });
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [custom] }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("settings setup refuses malformed hook sections without changing them", () => {
  const home = tempDir();
  const file = toolSettingsPath("claude", { home });
  const original = JSON.stringify({ hooks: { UserPromptSubmit: { keep: "this" } } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, original);
  try {
    assert.throws(() => updateSettings("claude", { home }), /invalid-settings/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(
  "settings setup refuses symlinks and oversized existing files without following or truncating them",
  { skip: process.platform === "win32" },
  () => {
    const home = tempDir();
    const outside = path.join(home, "outside.json");
    const linked = toolSettingsPath("claude", { home });
    const oversized = toolSettingsPath("cursor", { home });
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.mkdirSync(path.dirname(oversized), { recursive: true });
    fs.writeFileSync(outside, '{"theme":"leave alone"}\n');
    fs.symlinkSync(outside, linked, "file");
    const tooLarge = " ".repeat(1024 * 1024 + 1);
    fs.writeFileSync(oversized, tooLarge);
    try {
      assert.throws(() => updateSettings("claude", { home }), /settings-symbolic-link/);
      assert.throws(() => updateSettings("cursor", { home }), /unsafe-settings-file/);
      assert.equal(fs.readFileSync(outside, "utf8"), '{"theme":"leave alone"}\n');
      assert.equal(fs.readFileSync(oversized, "utf8"), tooLarge);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test("settings setup refuses a junction in the resolved settings path", () => {
  const home = tempDir();
  const outside = path.join(home, "outside");
  const linkedDirectory = path.join(home, ".claude");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "settings.json"), '{"theme":"keep"}\n');
  fs.symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(() => updateSettings("claude", { home }), /settings-symbolic-link/);
    assert.equal(fs.readFileSync(path.join(outside, "settings.json"), "utf8"), '{"theme":"keep"}\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("remove keeps a same-named backup when no Guard hook is installed", () => {
  const home = tempDir();
  const file = toolSettingsPath("claude", { home });
  const backup = `${file}.clotr-guard.bak`;
  const original = "user-owned backup contents\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme: "dark" }));
  fs.writeFileSync(backup, original);
  try {
    const result = updateSettings("claude", { home, remove: true });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(
  "settings setup and removal preserve an existing file's permissions",
  { skip: process.platform === "win32" },
  () => {
    const home = tempDir();
    const file = toolSettingsPath("cursor", { home });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme: "dark" }), { mode: 0o640 });
    try {
      updateSettings("cursor", { home });
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
      updateSettings("cursor", { home, remove: true });
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

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

test("staged check growth follows the size of one added file", () => {
  const smallDir = tempDir();
  const bigDir = tempDir();
  try {
    for (const [dir, count] of [
      [smallDir, 500],
      [bigDir, 2000],
    ]) {
      initGit(dir);
      const lines = Array.from({ length: count }, (_, i) => `const value${i} = "setting number ${i} for the module";`);
      lines[Math.floor(count * 0.75)] = `const key = "${AWS_KEY}";`;
      fs.writeFileSync(path.join(dir, "big.js"), `${lines.join("\n")}\n`);
      git(dir, ["add", "big.js"]);
    }
    const [small, big] = bestOfPair(
      () => checkStaged({ cwd: smallDir }),
      () => checkStaged({ cwd: bigDir }),
      4,
    );
    const issues = checkStaged({ cwd: bigDir }).issues;
    assert.ok(!grewMoreThan(small, big, 16), "staged checks grew too fast for 4× the file");
    assert.deepEqual(
      issues.map((issue) => [issue.file, issue.line, issue.kind]),
      [["big.js", 1501, "aws_access_key"]],
    );
  } finally {
    fs.rmSync(smallDir, { recursive: true, force: true });
    fs.rmSync(bigDir, { recursive: true, force: true });
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

test("Git removal leaves an unowned backup alone, and setup refuses a symlinked hooks directory", () => {
  const dir = tempDir();
  const outside = path.join(dir, "outside");
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    const backup = path.join(hooks, "pre-commit.clotr-guard.bak");
    fs.writeFileSync(backup, "user-owned backup\n");
    assert.equal(setupGit({ cwd: dir, remove: true }).changed, false);
    assert.equal(fs.readFileSync(backup, "utf8"), "user-owned backup\n");

    fs.mkdirSync(outside);
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.symlinkSync(outside, hooks, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => setupGit({ cwd: dir }), /settings-symbolic-link/);
    assert.equal(fs.existsSync(path.join(outside, "pre-commit")), false);
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

test("Cline setup refuses a modified hook instead of replacing an unverified wrapper", () => {
  const home = tempDir();
  try {
    const directory = path.join(home, "Documents", "Cline", "Hooks");
    fs.mkdirSync(directory, { recursive: true });
    const prompt = path.join(directory, "UserPromptSubmit");
    fs.writeFileSync(prompt, "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    updateClineHooks({ home, platform: "linux" });
    const script = path.resolve(__dirname, "../apps/guard/bin/clotr-guard.js");
    const gone = path.join(home, "old", "clotr-guard.js");
    const changed = fs.readFileSync(prompt, "utf8").replaceAll(JSON.stringify(script), JSON.stringify(gone));
    fs.writeFileSync(prompt, changed);
    assert.throws(() => updateClineHooks({ home, platform: "linux", minimum: "high" }), /cline-hook-backup-exists/);
    assert.equal(fs.readFileSync(prompt, "utf8"), changed);
    assert.ok(changed.includes(JSON.stringify(`${prompt}.clotr-guard.bak`)));
    assert.equal(fs.readFileSync(`${prompt}.clotr-guard.bak`, "utf8"), "#!/bin/sh\necho '{}'\n");
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

test("Git setup leaves a same-content backup alone instead of claiming it", () => {
  const dir = tempDir();
  try {
    initGit(dir);
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    const backup = `${hook}.clotr-guard.bak`;
    const original = "#!/bin/sh\necho user hook\n";
    fs.writeFileSync(hook, original, { mode: 0o755 });
    fs.writeFileSync(backup, original, { mode: 0o755 });

    assert.equal(setupGit({ cwd: dir, remove: true }).changed, false);
    assert.throws(() => setupGit({ cwd: dir }), /hook-backup-exists/);
    assert.equal(fs.readFileSync(hook, "utf8"), original);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
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

test("Electron setup chooses an absolute Node outside the workspace from PATH", () => {
  const home = tempDir();
  const workspace = path.join(home, "repo");
  const bin = path.join(home, "Node tools & $100%'");
  const fakeNode = path.join(bin, process.platform === "win32" ? "node.exe" : "node");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(fakeNode, "fixture");
  if (process.platform !== "win32") fs.chmodSync(fakeNode, 0o755);
  const env = { PATH: `${path.join(workspace, "node_modules", ".bin")}${path.delimiter}${bin}` };
  try {
    const node = nodeCommand({ env, platform: process.platform, electron: "38.0.0", cwd: workspace });
    assert.equal(node, fs.realpathSync(fakeNode));
    const hook = hookCommand("claude", "prompt", "medium", false, {
      env,
      platform: process.platform,
      electron: "38.0.0",
      cwd: workspace,
      script: path.join(home, "Clotr's Guard & checks", "clotr-guard.js"),
    });
    assert.equal(hook.command, node);
    assert.equal(hook.args[0], path.join(home, "Clotr's Guard & checks", "clotr-guard.js"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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
  assert.equal(pkg.version, "0.1.1");
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
  assert.equal(version.stdout.trim(), `clotr-guard 0.1.1, engine ${engineVersion}`);
});

test("the Guard npm package declares its public pages and includes the license", () => {
  const root = path.join(__dirname, "../apps/guard");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "https://github.com/clotr-app/clotr",
    directory: "apps/guard",
  });
  assert.equal(pkg.homepage, "https://github.com/clotr-app/clotr/tree/main/apps/guard#readme");
  assert.deepEqual(pkg.bugs, { url: "https://github.com/clotr-app/clotr/issues" });
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --dry-run --json"] : ["pack", "--dry-run", "--json"];
  const packed = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const json = /(?:^|\r?\n)(\[[\s\S]*\])\s*$/.exec(packed.stdout);
  assert.ok(json, packed.stdout);
  const details = JSON.parse(json[1]);
  assert.deepEqual(
    details[0].files.map((file) => file.path).sort(),
    [
      "LICENSE",
      "README.md",
      "bin/clotr-guard.js",
      "bin/clotr-mcp.js",
      "dist/clotr-engine.js",
      "lib/clotrignore.js",
      "lib/engine.js",
      "lib/secret-files.js",
      "package.json",
      "skills/clotr/SKILL.md",
    ].sort(),
  );
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
  assert.match(skill, /names the kind of thing it found and where it was found, without showing any part of the value/);
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
// The VS Code page is an Open VSX store listing and its feature claims are checked in tests/vscode.test.js.
test("Guard and JetBrains READMEs mark each feature stable or preview and link tests that exist", () => {
  const repo = path.join(__dirname, "..");
  const base = "https://github.com/clotr-app/clotr/blob/main/";
  for (const app of ["guard", "jetbrains"]) {
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
test("a .clotrignore rule full of stars grows with the path", () => {
  const config = parseClotrIgnore("*a*a*a*a*a*a*a*a*a*a*b\n**/*a*a*a*a*a*a*a*a*a*a*b/x\n");
  const pathOf = (n) => "x" + "a".repeat(n);
  const [small, big] = bestOfPair(
    () => pathIgnored(config, pathOf(15)),
    () => pathIgnored(config, pathOf(60)),
    4,
  );
  assert.ok(!grewMoreThan(small, big, 16), "wildcard matching grew too fast for 4× the path");
  assert.deepEqual(
    [
      pathIgnored(config, pathOf(60)),
      pathIgnored(config, pathOf(60) + "b"),
      pathIgnored(config, `d/${pathOf(60)}/x/y`),
    ],
    [false, true, false],
  );
});

// Each rule was matched against every folder prefix of a path again from its start, so a deep path cost its depth
// times its length times the rule, and a .clotrignore of long "**/" chains held one path for seconds.
test("a .clotrignore of long rules matches a deep path in one walk per rule", () => {
  const config = parseClotrIgnore(Array.from({ length: 62 }, (_, i) => `${"**/".repeat(340)}x${i}`).join("\n"));
  const deep = `${Array.from({ length: 60 }, (_, i) => `pkg${String(i).padStart(4, "0")}`).join("/")}/index.js`;
  const shorter = `${Array.from({ length: 15 }, (_, i) => `pkg${String(i).padStart(4, "0")}`).join("/")}/index.js`;
  const [small, big] = bestOfPair(
    () => pathIgnored(config, shorter),
    () => pathIgnored(config, deep),
    4,
  );
  assert.equal(pathIgnored(config, deep), false);
  assert.ok(!grewMoreThan(small, big, 16), "long rules grew too fast for 4× the path depth");
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

test("Guard does not let project path patterns silence reads or staged files", () => {
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

    const otherKey = "AKIAZ7Q3M9WX2KD5HB8R";
    const fixturePath = path.join(root, "fixtures", "ordinary.js");
    fs.mkdirSync(path.dirname(fixturePath));
    fs.writeFileSync(fixturePath, `key=${otherKey}`);
    const fixtureRead = inspectRead("claude", { tool_name: "Read", tool_input: { file_path: fixturePath } });
    assert.equal(fixtureRead.action, "block");
    assert.equal(fixtureRead.skipped, undefined);
    assert.equal(fixtureRead.findings[0].masked, "AKIA…8R");

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
      staged.issues.map(({ file, kind }) => ({ file, kind })).sort((a, b) => a.file.localeCompare(b.file)),
      [
        { file: ".env", kind: "secret_file" },
        { file: "fixtures/ordinary.js", kind: "aws_access_key" },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Guard documents exact fingerprints and local repeat state without promising path skips", () => {
  const readme = fs.readFileSync(path.join(__dirname, "../apps/guard/README.md"), "utf8");
  assert.match(readme, /Only exact value fingerprints in `\.clotrignore` suppress Guard findings/);
  assert.match(readme, /Path patterns are ignored and cannot turn\s+checks off for a file/);
  assert.match(readme, /local plain state readable by the same computer account/);
  assert.doesNotMatch(readme, /A path line is the way to quiet those|add its path to `\.clotrignore`/i);

  const publicContributing = ["../public/CONTRIBUTING.md", "../CONTRIBUTING.md"]
    .map((file) => path.join(__dirname, file))
    .find((file) => fs.existsSync(file));
  assert.ok(publicContributing, "the public CONTRIBUTING.md is missing");
  const contributing = fs.readFileSync(publicContributing, "utf8");
  for (const [file, text] of [
    ["apps/guard/README.md", readme],
    ["public/CONTRIBUTING.md", contributing],
  ]) {
    assert.match(text, /Clotr hits an internal error while checking readable input/i, file);
    assert.match(text, /lets\s+(?:the|an)\s+action through with a visible note/i, file);
    assert.match(text, /stops input\s+it can't read.*malformed hook input.*size limit/is, file);
    assert.doesNotMatch(
      text,
      /if it fails, the message still goes through|a check error lets the action through/i,
      file,
    );
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
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
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

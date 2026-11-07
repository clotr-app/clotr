"use strict";
/* global require, process, __dirname */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");

const SERVER = path.join(__dirname, "..", "apps", "guard", "bin", "clotr-mcp.js");
const ENGINE_PATH = path.join(__dirname, "..", "apps", "guard", "dist", "clotr-engine.js");
const { build } = require("../tools/engine-bundle.js");
const engineBundle = build().text;
if (fs.existsSync(ENGINE_PATH)) {
  assert.equal(fs.readFileSync(ENGINE_PATH, "utf8"), engineBundle, "guard engine bundle is stale");
} else {
  fs.mkdirSync(path.dirname(ENGINE_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_PATH, engineBundle);
}
const { checkResult, cleanResult, callTool } = require("../apps/guard/bin/clotr-mcp.js");
const guardPackage = require("../apps/guard/package.json");
const KEY = "AKIA4HPQ7XZ2R6TWLJ3N";
const EMAIL = "madeup.person@example.com";

test("MCP never applies repository ignores or accepts undeclared suppression inputs", () => {
  const readme = fs.readFileSync(path.join(__dirname, "../apps/mcp/README.md"), "utf8");
  assert.match(readme, /does not read `\.clotrignore` and has no ignore option/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-mcp-no-files-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".clotrignore"), `**\n`);
    const checked = checkResult(`Use ${KEY}`, false, { cwd: root });
    assert.ok(checked.findings.some((finding) => finding.kind === "aws_access_key"));
    assert.equal(callTool("check_text", { text: `Use ${KEY}`, ignoreFingerprints: [] }).isError, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  assert.ok(found, "npm's CLI is available for the local package install");
  return path.resolve(found);
}

function runNpm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCliPath(), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function liveMcp(child, label) {
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  let failure;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        failure = error;
        for (const { reject } of pending.values()) reject(error);
        pending.clear();
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (error) => {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  return {
    async request(id, method, params = {}) {
      if (failure) throw failure;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${label}: timed out waiting for ${method}; stderr: ${stderr}`));
        }, 20_000);
        pending.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      child.stdin.write(`${rpcRequest(method, params, id)}\n`);
      return response;
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    get stderr() {
      return stderr;
    },
  };
}

function rpcRequest(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function request(method, params = {}, id = 1) {
  return rpcRequest(method, params, id);
}

function modernRequest(method, params = {}, id = 1) {
  return request(method, { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }, id);
}

function runStdio(lines) {
  const child = spawnSync(process.execPath, [SERVER], {
    input: `${lines.join("\n")}\n`,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  return child.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toolResult(response) {
  return JSON.parse(response.result.content[0].text);
}

test("the packed npx command and clotr-mcp binary complete a live MCP exchange", { timeout: 90_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-mcp-live-"));
  const packageRoot = path.join(__dirname, "..", "apps", "guard");
  const project = path.join(temp, "project");
  const cache = path.join(temp, "npm-cache");
  fs.mkdirSync(project, { recursive: true });
  const children = [];
  const npmCli = npmCliPath();
  const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
  assert.equal(fs.existsSync(npxCli), true, "npm's npx command is available");

  async function exercise(label, args) {
    const child = spawn(process.execPath, args, {
      cwd: project,
      env: {
        ...process.env,
        npm_config_cache: cache,
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    child.closePromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const client = liveMcp(child, label);
    const initialized = await client.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "clotr-guard-test", version: "1" },
    });
    assert.deepEqual(initialized.result.serverInfo, { name: "clotr", version: guardPackage.version }, label);
    assert.deepEqual(initialized.result.capabilities, { tools: {} }, label);
    client.notify("notifications/initialized");

    const listed = await client.request(2, "tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["check_text", "clean_text", "is_secret_file"],
      label,
    );
    const called = await client.request(3, "tools/call", {
      name: "check_text",
      arguments: { text: `Use ${KEY}` },
    });
    const result = toolResult(called);
    assert.equal(called.result.isError, false, label);
    assert.ok(
      result.findings.some((finding) => finding.kind === "aws_access_key"),
      label,
    );
    assert.ok(
      result.findings.every((finding) => Object.keys(finding).sort().join(",") === "kind,masked"),
      label,
    );
    assert.doesNotMatch(called.result.content[0].text, new RegExp(KEY), label);

    child.stdin.end();
    const code = await child.closePromise;
    assert.equal(code, 0, `${label}: ${client.stderr}`);
    assert.equal(client.stderr, "", label);
  }

  try {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    runNpm(["pack", "--pack-destination", temp], packageRoot);
    const tarball = path.join(temp, `${guardPackage.name}-${guardPackage.version}.tgz`);
    assert.equal(fs.existsSync(tarball), true, "npm pack produced the local Guard package");
    runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", project, tarball], temp);

    await exercise("npx -y clotr-guard mcp", [npxCli, "-y", "--offline", "clotr-guard", "mcp"]);
    await exercise("clotr-mcp", [npxCli, "-y", "--offline", "--package", "clotr-guard", "clotr-mcp"]);
  } finally {
    await Promise.all(
      children.map((child) => {
        if (child.exitCode === null) child.kill();
        return Promise.race([child.closePromise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
      }),
    );
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // The test runner owns a temporary root and removes any file npm still has open after a child exits.
    }
  }
});

test("MCP stdio initializes with the legacy handshake and lists its three tools", () => {
  const replies = runStdio([
    request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    request("tools/list", {}, 2),
  ]);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.deepEqual(
    replies[1].result.tools.map((tool) => tool.name),
    ["check_text", "clean_text", "is_secret_file"],
  );
  assert.match(replies[1].result.tools[0].description, /before it leaves this computer or goes to another tool/i);
  // The server only answers; the assistant decides what to do, and the description has to say so.
  assert.match(replies[1].result.tools[0].description, /blocks nothing/i);
  assert.match(replies[1].result.tools[1].description, /replaced by a placeholder/i);
  assert.match(replies[1].result.tools[2].description, /before reading a local file/i);
  assert.equal(replies[1].result.tools[1].inputSchema.properties.include_personal_details.type, "boolean");
  assert.equal(replies[1].result.tools[0].inputSchema.additionalProperties, false);
});

// What the assistant reads before it calls anything: when to call each tool, and what comes back.
test("initialize and server/discover give the same short instructions, naming each tool", () => {
  const [legacy] = runStdio([request("initialize", { protocolVersion: "2024-11-05", capabilities: {} })]);
  const [modern] = runStdio([modernRequest("server/discover", {}, 1)]);
  const instructions = legacy.result.instructions;
  assert.equal(typeof instructions, "string");
  assert.equal(modern.result.instructions, instructions);
  for (const name of ["check_text", "clean_text", "is_secret_file"]) assert.match(instructions, new RegExp(name));
  assert.match(instructions, /on this computer/);
  assert.match(instructions, /masked/);
  assert.match(instructions, /never the full value/);
  assert.ok(instructions.length <= 400, `the instructions are ${instructions.length} characters`);
  // No promise the server can't keep: it checks only when called, and it stops nothing on its own.
  assert.doesNotMatch(instructions, /\b(always|guarantee|protects?|blocks?|prevents?|all secrets)\b/i);
});

test("every tool input says what it is", () => {
  const [, listed] = runStdio([
    request("initialize", { protocolVersion: "2025-11-25", capabilities: {} }),
    request("tools/list", {}, 2),
  ]);
  for (const tool of listed.result.tools) {
    for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
      assert.equal(typeof property.description, "string", `${tool.name}.${name} has no description`);
      assert.ok(property.description.length >= 10, `${tool.name}.${name}'s description is too short`);
    }
  }
  const byName = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));
  assert.match(byName.check_text.inputSchema.properties.text.description, /64 KiB/);
  assert.match(byName.clean_text.inputSchema.properties.text.description, /64 KiB/);
  assert.match(byName.is_secret_file.inputSchema.properties.path.description, /isn't read/);
  // clean_text finds what check_text finds, and its description says so.
  assert.match(byName.clean_text.description, /check_text/);
});

// Each tool only reads what it's given and calls nothing outside this computer, and the annotations say so. MCP added
// annotations in its second version and a tool's own title in its third, so an older client gets only what it knows.
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
test("tools carry a title and read-only annotations in each protocol version that has them", () => {
  const listFor = (protocolVersion) =>
    runStdio([request("initialize", { protocolVersion, capabilities: {} }), request("tools/list", {}, 2)])[1].result
      .tools;
  for (const tool of listFor("2024-11-05")) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"], tool.name);
  }
  for (const tool of listFor("2025-03-26")) {
    assert.equal(tool.title, undefined, tool.name);
    const { title, ...hints } = tool.annotations;
    assert.equal(typeof title, "string", tool.name);
    assert.deepEqual(hints, ANNOTATIONS, tool.name);
  }
  const current = runStdio([modernRequest("tools/list", {}, 1)])[0].result.tools;
  for (const tools of [listFor("2025-06-18"), listFor("2025-11-25"), current]) {
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string", tool.name);
      assert.deepEqual(tool.annotations, ANNOTATIONS, tool.name);
    }
  }
  assert.deepEqual(
    current.map((tool) => tool.title),
    ["Check text", "Clean text", "Check a file path"],
  );
});

// An assistant is sent the whole tool list with every request, so its size is paid in tokens each time. Trimmed, it
// came to 952 characters. Input descriptions, titles and annotations brought it to 1,679, about 420
// tokens at four characters a token, and the budget is that plus 10%.
const TOOL_LIST_BUDGET = 1847;

test("the MCP tool list stays within its token budget", () => {
  const [, listed] = runStdio([
    request("initialize", { protocolVersion: "2025-11-25", capabilities: {} }),
    request("tools/list", {}, 2),
  ]);
  const size = JSON.stringify(listed.result.tools).length;
  assert.ok(size <= TOOL_LIST_BUDGET, `the tool list is ${size} characters, over its budget of ${TOOL_LIST_BUDGET}`);
});

test("current MCP discovery and tools calls work without a session", () => {
  const replies = runStdio([modernRequest("server/discover", {}, 1), modernRequest("tools/list", {}, 2)]);
  assert.deepEqual(replies[0].result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.equal(replies[0].result.resultType, "complete");
  assert.equal(replies[0].result.cacheScope, "private");
  assert.deepEqual(replies[0].result._meta["io.modelcontextprotocol/serverInfo"], {
    name: "clotr",
    version: guardPackage.version,
  });
  assert.deepEqual(
    replies[1].result.tools.map((tool) => tool.name),
    ["check_text", "clean_text", "is_secret_file"],
  );
  assert.equal(replies[1].result.ttlMs, 0);
});

test("unsupported protocol errors don't echo caller-controlled values", () => {
  const secret = KEY;
  const parsedRequest = JSON.parse(modernRequest("server/discover", {}, 1));
  parsedRequest.params._meta["io.modelcontextprotocol/protocolVersion"] = secret;
  const response = runStdio([JSON.stringify(parsedRequest)])[0];
  assert.equal(response.error.code, -32022);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(secret));
});

test("check_text returns kinds and masked forms without raw values", () => {
  const response = runStdio([
    modernRequest("tools/call", {
      name: "check_text",
      arguments: { text: `Use ${KEY} and contact ${EMAIL}`, include_personal_details: true },
    }),
  ])[0];
  const result = toolResult(response);
  assert.match(result.verdict, /review/i);
  assert.ok(result.findings.some((finding) => finding.kind === "aws_access_key"));
  assert.ok(result.findings.some((finding) => finding.kind === "email"));
  assert.ok(result.findings.every((finding) => Object.keys(finding).sort().join(",") === "kind,masked"));
  assert.doesNotMatch(JSON.stringify(response), new RegExp(KEY));
  assert.doesNotMatch(JSON.stringify(response), new RegExp(EMAIL));
});

test("check_text leaves personal details out by default", () => {
  const response = runStdio([
    modernRequest("tools/call", { name: "check_text", arguments: { text: `Contact ${EMAIL}` } }),
  ])[0];
  const result = toolResult(response);
  assert.deepEqual(result.findings, []);
  assert.equal(result.verdict, "No findings.");
  assert.doesNotMatch(JSON.stringify(response), new RegExp(EMAIL));
});

test("clean_text leaves personal details in place unless the same option is enabled", () => {
  const text = "My address is 123 Main Street, Springfield, IL 62704";
  assert.equal(cleanResult(text).text, text);
  assert.notEqual(cleanResult(text, true).text, text);
  const credential = checkResult(`Use ${KEY}`);
  assert.ok(credential.findings.some((finding) => finding.kind === "aws_access_key"));
});

test("MCP reports a JWT once when two engine findings share its range", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaWN0aXRpb3VzLXVzZXIifQ.c2VhbGVkLWZpeHR1cmU";
  const result = checkResult(`token=${token}`, true);
  assert.ok(result.findings.some((finding) => finding.kind === "jwt"));
  assert.equal(result.findings.length, 1);
});

test("the Guard package and MCP command use version 0.1.3", () => {
  assert.equal(guardPackage.private, true);
  assert.equal(guardPackage.bin["clotr-mcp"], "bin/clotr-mcp.js");
  assert.equal(guardPackage.version, "0.1.3");
  assert.ok(guardPackage.files.includes("bin"));
  assert.ok(guardPackage.files.includes("lib"));
  assert.ok(guardPackage.files.includes("dist"));
});

test("clean_text uses engine placeholders and returns only masked replacement details", () => {
  const response = runStdio([
    modernRequest("tools/call", {
      name: "clean_text",
      arguments: { text: `Key ${KEY}; email ${EMAIL}`, include_personal_details: true },
    }),
  ])[0];
  const result = toolResult(response);
  assert.match(result.text, /\[REDACTED AWS ACCESS KEY\]/i);
  assert.match(result.text, /\[REDACTED EMAIL ADDRESS\]/i);
  assert.ok(result.replaced.some((finding) => finding.kind === "aws_access_key"));
  assert.ok(result.replaced.some((finding) => finding.kind === "email"));
  assert.ok(result.replaced.every((finding) => Object.keys(finding).sort().join(",") === "kind,masked"));
  assert.doesNotMatch(JSON.stringify(response), new RegExp(KEY));
  assert.doesNotMatch(JSON.stringify(response), new RegExp(EMAIL));
});

test("clean_text hides a short value's URL-encoded copy in a link next to its plain copy", () => {
  const cleaned = cleanResult("SSN 219-09-9999. https://forms.example.com/a?note=ssn%20219-09-9999", true);
  assert.equal(
    cleaned.text,
    "SSN [REDACTED US SOCIAL SECURITY NUMBER]. https://forms.example.com/a?note=ssn%20[REDACTED US SOCIAL SECURITY NUMBER]",
  );
});

test("MCP ignores project suppression files and always cleans findings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-mcp-ignore-"));
  try {
    fs.writeFileSync(path.join(root, ".clotrignore"), `**\n`);
    const text = `Use ${KEY} and card 4111 1111 1111 1111`;
    const checked = checkResult(text, false, { cwd: root });
    assert.ok(checked.findings.some((finding) => finding.kind === "aws_access_key"));
    assert.ok(checked.findings.some((finding) => finding.kind === "credit_card"));
    const cleaned = cleanResult(text, false, { cwd: root });
    assert.equal(cleaned.text.includes(KEY), false);
    assert.equal(cleaned.text.includes("4111 1111 1111 1111"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("is_secret_file uses Guard's path rules without reading a file", () => {
  const replies = runStdio([
    modernRequest("tools/call", { name: "is_secret_file", arguments: { path: "C:\\fixture\\.env" } }),
    modernRequest("tools/call", { name: "is_secret_file", arguments: { path: "C:\\fixture\\.env.sample" } }, 2),
  ]);
  assert.deepEqual(toolResult(replies[0]), { is_secret_file: true });
  assert.deepEqual(toolResult(replies[1]), { is_secret_file: false });
});

test("malformed JSON-RPC requests receive protocol errors without logging input", () => {
  const replies = runStdio([JSON.stringify({ jsonrpc: "1.0", id: 7, method: "tools/list" })]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].error.code, -32600);
  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].error.message, "Invalid Request");
});

test("oversized text is capped with a safe tool error", () => {
  const oversized = "x".repeat(64 * 1024 + 1);
  const response = runStdio([modernRequest("tools/call", { name: "check_text", arguments: { text: oversized } })])[0];
  assert.equal(response.result.isError, true);
  assert.equal(toolResult(response).isError, true);
  assert.equal(toolResult(response).content[0].text, "Text is too large to check.");
  assert.equal(response.result.content[0].text.includes(oversized), false);
});

test("MCP discards the entire oversized line and can parse the next bounded request", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.write("x".repeat(300 * 1024));
  child.stdin.write(`tail\n${modernRequest("server/discover", {}, 2)}\n`);
  child.stdin.end();
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(status, 0, stderr);
  const replies = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].id, 2);
  assert.deepEqual(replies[1].result.supportedVersions, ["2026-07-28"]);
  assert.doesNotMatch(`${stdout}${stderr}`, /x{100}/);
});

test("print-config emits each host's local stdio shape", () => {
  const names = ["claude", "cursor", "gemini", "windsurf", "cline", "vscode", "codex"];
  for (const name of names) {
    const child = spawnSync(process.execPath, [SERVER, "--print-config", name], { encoding: "utf8" });
    assert.equal(child.status, 0, `${name}: ${child.stderr}`);
    if (name === "codex") {
      assert.match(child.stdout, /^\[mcp_servers\.clotr\]/);
      assert.match(child.stdout, /command = /);
      continue;
    }
    const config = JSON.parse(child.stdout);
    const collection = name === "vscode" ? config.servers : config.mcpServers;
    assert.equal(collection.clotr.command, path.resolve(process.execPath));
    assert.deepEqual(collection.clotr.args, [SERVER]);
    if (name === "vscode") assert.equal(collection.clotr.type, "stdio");
  }

  const wrapper = path.join(__dirname, "..", "apps", "mcp", "bin", "clotr-mcp.js");
  const compatibility = spawnSync(process.execPath, [wrapper, "--print-config", "claude"], { encoding: "utf8" });
  assert.equal(compatibility.status, 0, compatibility.stderr);
  const config = JSON.parse(compatibility.stdout);
  assert.equal(config.mcpServers.clotr.command, path.resolve(process.execPath));
  assert.deepEqual(config.mcpServers.clotr.args, [SERVER]);
});

test("print-config refuses an npx cache path and names the global install, as hook setup does", () => {
  const { printConfig } = require("../apps/guard/bin/clotr-mcp.js");
  const streams = () => {
    const lines = [];
    return { lines, write: (text) => lines.push(text) };
  };
  const cached = { stdout: streams(), stderr: streams() };
  const code = printConfig("claude", {
    scriptPath: path.join(os.tmpdir(), "_npx", "fixture", "node_modules", "clotr-guard", "bin"),
    stdout: cached.stdout,
    stderr: cached.stderr,
  });
  assert.equal(code, 2);
  assert.deepEqual(cached.stdout.lines, []);
  assert.match(cached.stderr.lines.join(""), /npm install -g clotr-guard/);
  assert.doesNotMatch(cached.stderr.lines.join(""), /_npx/);

  const installed = { stdout: streams(), stderr: streams() };
  const scriptPath = path.join(os.tmpdir(), "lib", "node_modules", "clotr-guard", "bin");
  assert.equal(printConfig("claude", { scriptPath, stdout: installed.stdout, stderr: installed.stderr }), 0);
  assert.deepEqual(installed.stderr.lines, []);
  const config = JSON.parse(installed.stdout.lines.join(""));
  assert.deepEqual(config.mcpServers.clotr.args, [path.join(scriptPath, "clotr-mcp.js")]);
});

test("check_text and clean_text say when the engine ran out of time on part of the text", () => {
  assert.equal(callTool("check_text", { text: "nothing to see here" }).truncated, undefined);
  // A pattern that pretends to take longer than the engine's whole time limit, on a fake clock in Guard's engine.
  const realm = require("node:vm").runInContext("globalThis", require("../apps/guard/lib/engine.js").engineContext());
  const { Clotr, Date: RealmDate } = realm;
  const realNow = RealmDate.now;
  let now = realNow();
  RealmDate.now = () => now;
  const slow = {
    id: "test_stalled",
    severity: "low",
    name: "stalled",
    find: () => ((now += Clotr.DETECT_BACKSTOP_MS + 200), []),
  };
  Clotr.PATTERNS.push(slow);
  let checked;
  let cleaned;
  try {
    checked = callTool("check_text", { text: "a message the engine runs out of time on" });
    cleaned = callTool("clean_text", { text: "another message the engine runs out of time on" });
  } finally {
    RealmDate.now = realNow;
    Clotr.PATTERNS.splice(Clotr.PATTERNS.indexOf(slow), 1);
  }
  assert.equal(checked.truncated, true);
  assert.match(checked.verdict, /part of this text wasn't checked/i);
  assert.equal(cleaned.truncated, true);
});

// Two scans the time limit cuts short can stop at different points. The first one here stops after every rule has
// run and the next stops before any, so clean_text must hide what its own list names from that one scan, not from
// a second one that found less.
test("clean_text hides every value it lists as replaced when the scan is cut short at a different point each time", () => {
  const realm = require("node:vm").runInContext("globalThis", require("../apps/guard/lib/engine.js").engineContext());
  const { Clotr, Date: RealmDate } = realm;
  const realNow = RealmDate.now;
  let now = realNow();
  RealmDate.now = () => now;
  let scans = 0;
  const stall = () => (now += Clotr.DETECT_BACKSTOP_MS + 200);
  const head = { id: "test_stall_head", severity: "low", name: "stall", find: () => (++scans > 1 && stall(), []) };
  const tail = { id: "test_stall_tail", severity: "low", name: "stall", find: () => (scans === 1 && stall(), []) };
  Clotr.PATTERNS.unshift(head);
  Clotr.PATTERNS.push(tail);
  let cleaned;
  try {
    cleaned = callTool("clean_text", { text: `deploy with ${KEY} today` });
  } finally {
    RealmDate.now = realNow;
    Clotr.PATTERNS.splice(Clotr.PATTERNS.indexOf(head), 1);
    Clotr.PATTERNS.splice(Clotr.PATTERNS.indexOf(tail), 1);
  }
  assert.equal(cleaned.truncated, true);
  assert.ok(
    cleaned.replaced.some((item) => item.kind === "aws_access_key"),
    JSON.stringify(cleaned.replaced),
  );
  assert.ok(!cleaned.text.includes(KEY), "a value listed as replaced is still in the cleaned text");
});

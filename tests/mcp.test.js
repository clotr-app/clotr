"use strict";
/* global require, process, __dirname */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { execFileSync } = require("node:child_process");
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
const { checkResult, cleanResult } = require("../apps/guard/bin/clotr-mcp.js");
const { valueFingerprint } = require("../apps/guard/lib/clotrignore.js");
const guardPackage = require("../apps/guard/package.json");
const KEY = "AKIA4HPQ7XZ2R6TWLJ3N";
const EMAIL = "madeup.person@example.com";

function request(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
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
  // A repository's .clotrignore is applied by itself, so the schema leaves ignoreFingerprints out to stay within the
  // token budget; the server still accepts it from a caller that passes it (tested with .clotrignore below).
  assert.equal(replies[1].result.tools[0].inputSchema.properties.ignoreFingerprints, undefined);
});

// An assistant is sent the whole tool list with every request, so its size is paid in tokens each time. Trimmed, it
// came to 952 characters, about 240 tokens at four characters a token, and the budget is that plus 10%.
const TOOL_LIST_BUDGET = 1048;

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

test("the Guard package and MCP command use version 0.1.0", () => {
  assert.equal(guardPackage.private, true);
  assert.equal(guardPackage.bin["clotr-mcp"], "bin/clotr-mcp.js");
  assert.equal(guardPackage.version, "0.1.0");
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

test("MCP applies .clotrignore and ignoreFingerprints to checks and cleaned text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-mcp-ignore-"));
  const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const fingerprint = valueFingerprint(salt, KEY);
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".clotrignore"), `salt: ${salt}\n`);
    const text = `Use ${KEY} and card 4111 1111 1111 1111`;
    const checked = checkResult(text, false, { cwd: root, ignoreFingerprints: [fingerprint] });
    assert.equal(
      checked.findings.some((finding) => finding.kind === "aws_access_key"),
      false,
    );
    assert.equal(
      checked.findings.some((finding) => finding.kind === "credit_card"),
      true,
    );
    const cleaned = cleanResult(text, false, { cwd: root, ignoreFingerprints: [fingerprint] });
    assert.equal(cleaned.text.includes(KEY), true);
    assert.equal(cleaned.text.includes("4111 1111 1111 1111"), false);

    fs.writeFileSync(path.join(root, ".clotrignore"), `salt: ${salt}\nfingerprint: ${fingerprint}\n**\n`);
    const autoIgnored = checkResult(`Use ${KEY}`, false, { cwd: root });
    assert.deepEqual(autoIgnored.findings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP refuses raw value lines in .clotrignore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-mcp-raw-ignore-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".clotrignore"), `value: ${KEY}\n`);
    const result = checkResult(`Use ${KEY}`, false, { cwd: root });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Use clotr-guard ignore-value.");
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
    assert.equal(collection.clotr.command, "node");
    assert.deepEqual(collection.clotr.args, [SERVER]);
    if (name === "vscode") assert.equal(collection.clotr.type, "stdio");
  }

  const wrapper = path.join(__dirname, "..", "apps", "mcp", "bin", "clotr-mcp.js");
  const compatibility = spawnSync(process.execPath, [wrapper, "--print-config", "claude"], { encoding: "utf8" });
  assert.equal(compatibility.status, 0, compatibility.stderr);
  const config = JSON.parse(compatibility.stdout);
  assert.equal(config.mcpServers.clotr.command, "node");
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

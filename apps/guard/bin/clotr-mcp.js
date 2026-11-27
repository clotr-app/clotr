#!/usr/bin/env node
/* global require, module, process, __dirname */
"use strict";

const path = require("node:path");
const { isNpxCachePath } = require("./clotr-guard.js");
const { MAX_TEXT_BYTES, checkResult, cleanResult, callTool } = require("../lib/mcp-server/mcp-tools.js");
const { handleRequest } = require("../lib/mcp-server/mcp-requests.js");
const { serve } = require("../lib/mcp-server/mcp-line-reader.js");

// ---------- The server and its tools ----------

const NPX_CONFIG_MESSAGE =
  "Install Clotr Guard with npm install -g clotr-guard, then print the configuration from that install.";

// ---------- Client config ----------

function configFor(tool, scriptPath = __dirname) {
  const script = path.resolve(scriptPath, "clotr-mcp.js");
  const command = path.resolve(process.execPath);
  const args = [script];
  const server = { command, args };
  if (tool === "codex") {
    return `[mcp_servers.clotr]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(script)}]\n`;
  }
  const root = tool === "vscode" ? "servers" : "mcpServers";
  const config = { [root]: { clotr: tool === "vscode" ? { type: "stdio", ...server } : server } };
  return JSON.stringify(config, null, 2);
}

function printConfig(tool, { scriptPath = __dirname, stdout = process.stdout, stderr = process.stderr } = {}) {
  const supported = new Set(["claude", "cursor", "gemini", "windsurf", "cline", "vscode", "codex"]);
  if (!supported.has(tool)) {
    stderr.write("Choose claude, cursor, gemini, windsurf, cline, vscode, or codex.\n");
    return 2;
  }
  // The printed path is what the assistant starts on every session, and npm clears its npx cache, so a path
  // in there would soon point at nothing.
  if (isNpxCachePath(scriptPath)) {
    stderr.write(`${NPX_CONFIG_MESSAGE}\n`);
    return 2;
  }
  stdout.write(`${configFor(tool, scriptPath)}\n`);
  return 0;
}

// ---------- Stdio framing ----------

if (require.main === module) {
  if (process.argv[2] === "--print-config") process.exitCode = printConfig(process.argv[3]);
  else serve();
}

module.exports = { MAX_TEXT_BYTES, checkResult, cleanResult, callTool, handleRequest, configFor, printConfig, serve };

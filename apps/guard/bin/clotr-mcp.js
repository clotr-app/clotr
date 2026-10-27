#!/usr/bin/env node
/* global require, module, process, __dirname, Buffer */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { check, ENGINE_PATH } = require("../lib/engine.js");
const { isSecretFile } = require("../lib/secret-files.js");
const { isNpxCachePath } = require("./clotr-guard.js");

const SERVER_NAME = "clotr";
const NPX_CONFIG_MESSAGE =
  "Install Clotr Guard with npm install -g clotr-guard, then print the configuration from that install.";
const SERVER_VERSION = require("../package.json").version;
const CURRENT_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const PERSONAL_KIND =
  /email|phone|person|name|address|ssn|social|passport|license.?plate|national.?id|account.?id|student.?id|birth|dob|vin|ip.?address/i;

// The assistant is sent this list with every request, so each word in it costs the developer tokens, and a test holds
// it to a budget. A description says when to call the tool and what comes back; the README carries the rest.
const PERSONAL_DETAILS_OPTION = {
  type: "boolean",
  description: "Also check personal details like emails. Default false.",
};
const TOOLS = [
  {
    name: "check_text",
    description:
      "Check text for credentials before it leaves this computer or goes to another tool. Returns kinds and masked forms, and blocks nothing.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        include_personal_details: PERSONAL_DETAILS_OPTION,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "clean_text",
    description: "Returns text with each finding replaced by a placeholder.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        include_personal_details: PERSONAL_DETAILS_OPTION,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "is_secret_file",
    description:
      "Call before reading a local file. True means Clotr treats the path as a secret file, so don't read it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", maxLength: 4096 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

let engineContext;

function getEngineContext() {
  if (!engineContext) {
    engineContext = vm.createContext({ console: Object.freeze({ info() {} }) });
    vm.runInContext(fs.readFileSync(ENGINE_PATH, "utf8"), engineContext, { filename: "clotr-engine.js" });
  }
  return engineContext;
}

function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function checkedText(text, includePersonalDetails) {
  if (typeof text !== "string") return { error: "text must be a string" };
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { error: "Text is too large to check." };
  const result = check(text, { site: "clotr-mcp" });
  const selected = result.findings.filter((finding) => includePersonalDetails || !PERSONAL_KIND.test(finding.kind));
  const jwtMasks = new Set(selected.filter((finding) => finding.kind === "jwt").map((finding) => finding.masked));
  const findings = selected.filter((finding) => !(finding.kind === "password" && jwtMasks.has(finding.masked)));
  return { findings };
}

function checkResult(text, includePersonalDetails) {
  const result = checkedText(text, includePersonalDetails);
  if (result.error) return fail(result.error);
  const findings = result.findings.map(({ kind, masked }) => ({ kind, masked }));
  const verdict = findings.length ? "Review these findings before sending." : "No findings.";
  return { findings, verdict };
}

function cleanResult(text, includePersonalDetails = false) {
  const result = checkedText(text, includePersonalDetails);
  if (result.error) return fail(result.error);
  const engine = getEngineContext().Clotr;
  const detections = engine
    .detect(text)
    .map((detection) => ({
      ...detection,
      matches: detection.matches,
    }))
    .filter((detection) => detection.matches.length);
  const allowedKinds = new Set(result.findings.map((finding) => finding.kind));
  const selected = detections.filter((detection) => allowedKinds.has(detection.id));
  const cleaned = engine.redact(text, selected);
  const replaced = result.findings.map(({ kind, masked }) => ({ kind, masked }));
  return { text: cleaned, replaced };
}

function callTool(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("Tool arguments must be an object.");
  if (name === "check_text") {
    if (Object.keys(args).some((key) => !["text", "include_personal_details"].includes(key))) {
      return fail("Unexpected tool argument.");
    }
    if (args.include_personal_details !== undefined && typeof args.include_personal_details !== "boolean") {
      return fail("include_personal_details must be a boolean.");
    }
    return checkResult(args.text, args.include_personal_details === true);
  }
  if (name === "clean_text") {
    if (Object.keys(args).some((key) => !["text", "include_personal_details"].includes(key))) {
      return fail("Unexpected tool argument.");
    }
    if (args.include_personal_details !== undefined && typeof args.include_personal_details !== "boolean") {
      return fail("include_personal_details must be a boolean.");
    }
    return cleanResult(args.text, args.include_personal_details === true);
  }
  if (name === "is_secret_file") {
    if (Object.keys(args).some((key) => key !== "path")) return fail("Unexpected tool argument.");
    if (typeof args.path !== "string" || args.path.length > 4096) {
      return fail("path must be a string of at most 4096 characters.");
    }
    return { is_secret_file: isSecretFile(args.path) };
  }
  return null;
}

function toolResponse(result, modern) {
  const encoded = JSON.stringify(result);
  return {
    content: [{ type: "text", text: encoded }],
    isError: Boolean(result.isError),
    ...(modern ? { resultType: "complete" } : {}),
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

let protocolMode = null;

function rpcResult(request, result, { cacheable = false, modern = false } = {}) {
  if (!modern) return { jsonrpc: "2.0", id: request.id, result };
  const value = {
    ...result,
    resultType: "complete",
    _meta: { [SERVER_INFO_META]: { name: SERVER_NAME, version: SERVER_VERSION } },
    ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
  };
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: value,
  };
}

function handleRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0") {
    return rpcError(request?.id, -32600, "Invalid Request");
  }
  const notification = !Object.hasOwn(request, "id");
  const method = request.method;
  const params =
    request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params : {};
  const requestMeta = params._meta && typeof params._meta === "object" ? params._meta : {};
  const requestedProtocol = requestMeta[PROTOCOL_META];
  const modern = method === "server/discover" || protocolMode === "modern" || requestedProtocol === CURRENT_PROTOCOL;

  if (modern && requestedProtocol !== undefined && requestedProtocol !== CURRENT_PROTOCOL) {
    return {
      ...rpcError(request.id, -32022, "Unsupported protocol version"),
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [CURRENT_PROTOCOL] },
      },
    };
  }
  if (modern && requestedProtocol === undefined) {
    return {
      ...rpcError(request.id, -32022, "Protocol version is required"),
      error: {
        code: -32022,
        message: "Protocol version is required",
        data: { supported: [CURRENT_PROTOCOL], requested: "" },
      },
    };
  }
  if (protocolMode === null && method !== "initialize" && method !== "server/discover" && !modern) {
    return rpcError(request.id, -32002, "Server is not initialized");
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "initialize") {
    const requested = params.protocolVersion;
    const protocolVersion = LEGACY_PROTOCOLS.has(requested) ? requested : "2025-11-25";
    protocolMode = "legacy";
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === "server/discover") {
    protocolMode = "modern";
    return rpcResult(
      request,
      { supportedVersions: [CURRENT_PROTOCOL], capabilities: { tools: {} } },
      { cacheable: true, modern: true },
    );
  }
  if (notification) return null;
  if (method === "ping") return rpcResult(request, {}, { modern });
  if (method === "tools/list") return rpcResult(request, { tools: TOOLS }, { cacheable: true, modern });
  if (method === "tools/call") {
    if (typeof params.name !== "string") return rpcError(request.id, -32602, "Tool name is required");
    const result = callTool(params.name, params.arguments);
    if (!result) return rpcError(request.id, -32602, "Unknown tool");
    return rpcResult(request, toolResponse(result, modern), { modern });
  }
  return rpcError(request.id, -32601, "Method not found");
}

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
  // The printed path is what the assistant starts on every session, and npm clears its npx cache, so a path in
  // there would soon point at nothing.
  if (isNpxCachePath(scriptPath)) {
    stderr.write(`${NPX_CONFIG_MESSAGE}\n`);
    return 2;
  }
  stdout.write(`${configFor(tool, scriptPath)}\n`);
  return 0;
}

function send(value) {
  if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
}

function serve() {
  let pending = Buffer.alloc(0);
  let discardingOversizedLine = false;
  process.stdin.on("data", (chunk) => {
    let incoming = chunk;
    if (discardingOversizedLine) {
      const newline = incoming.indexOf(0x0a);
      if (newline < 0) return;
      incoming = incoming.subarray(newline + 1);
      discardingOversizedLine = false;
    }
    pending = Buffer.concat([pending, incoming]);
    let newline;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length > MAX_LINE_BYTES) {
        send(rpcError(null, -32700, "Request is too large"));
        continue;
      }
      let request;
      try {
        request = JSON.parse(line.toString("utf8"));
      } catch {
        send(rpcError(null, -32700, "Parse error"));
        continue;
      }
      try {
        send(handleRequest(request));
      } catch {
        if (request && Object.hasOwn(request, "id")) send(rpcError(request.id, -32603, "Internal error"));
      }
    }
    if (pending.length > MAX_LINE_BYTES) {
      pending = Buffer.alloc(0);
      discardingOversizedLine = true;
      send(rpcError(null, -32700, "Request is too large"));
    }
  });
  process.stdin.on("end", () => {
    if (discardingOversizedLine) return;
    if (!pending.length) return;
    try {
      send(handleRequest(JSON.parse(pending.toString("utf8"))));
    } catch {
      send(rpcError(null, -32700, "Parse error"));
    }
  });
}

if (require.main === module) {
  if (process.argv[2] === "--print-config") process.exitCode = printConfig(process.argv[3]);
  else serve();
}

module.exports = { MAX_TEXT_BYTES, checkResult, cleanResult, callTool, handleRequest, configFor, printConfig, serve };
